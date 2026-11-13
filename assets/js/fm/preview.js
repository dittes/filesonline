// preview.js
// Thumbnails for the grid, and the preview shown in the details pane and in Quick Look.

import { el, btn, fill } from './dom.js';
import { t, fmtBytes, fmtNum } from './i18n.js';
import { iconHtml, isTextLike, isBrowserImage, isPdf, isArchive } from './kinds.js';

// ─── Thumbnails ───────────────────────────────────────────────────────────────

const thumbs = new Map();   // id → Promise<string|null>
const queue = [];
let running = 0;

function pump() {
  while (running < 3 && queue.length) {
    const job = queue.shift();
    running++;
    job().finally(() => { running--; pump(); });
  }
}

async function canvasUrl(source, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d').drawImage(source, 0, 0, width, height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.8));
  return blob ? URL.createObjectURL(blob) : null;
}

async function imageThumb(item) {
  if (item.ext === 'svg' || item.size < 200000) return URL.createObjectURL(item.file);
  try {
    const bitmap = await createImageBitmap(item.file);
    const scale = Math.min(1, 360 / Math.max(bitmap.width, bitmap.height));
    const url = await canvasUrl(bitmap, Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    bitmap.close();
    return url;
  } catch { return null; }
}

async function pdfPageCanvas(doc, number, width) {
  const page = await doc.getPage(number);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return canvas;
}

async function openPdf(item) {
  const { openPdfjs } = await import('../pdf/lib.js');
  return openPdfjs(new Uint8Array(await item.file.arrayBuffer()));
}

async function pdfThumb(item) {
  if (item.size > 60e6) return null;
  let doc;
  try {
    doc = await openPdf(item);
    const canvas = await pdfPageCanvas(doc, 1, 300);
    return await canvasUrl(canvas, canvas.width, canvas.height);
  } catch { return null; } finally { doc?.destroy(); }
}

export const hasThumb = item => isBrowserImage(item) || isPdf(item);

/** Resolves with an image URL, or null when the file has no picture to show. */
export function thumb(item) {
  if (!thumbs.has(item.id)) {
    thumbs.set(item.id, new Promise(resolve => {
      queue.push(() => (isPdf(item) ? pdfThumb(item) : imageThumb(item)).then(resolve, () => resolve(null)));
      pump();
    }));
  }
  return thumbs.get(item.id);
}

export function forgetThumbs() {
  thumbs.forEach(p => p.then(url => url && URL.revokeObjectURL(url)));
  thumbs.clear();
}

// ─── What the inspector knows about a file ────────────────────────────────────

const analyses = new Map();
export const ANALYZE_LIMIT = 48e6;
let inspectT = s => s;

export function analysis(item) {
  if (item.size > ANALYZE_LIMIT) return Promise.resolve(null);
  if (!analyses.has(item.id)) {
    analyses.set(item.id, (async () => {
      const [{ default: E }, i18n] = await Promise.all([import('../inspect/extractors.js'), import('../inspect/i18n.js')]);
      await Promise.all([import('../inspect/formats.js'), import('../inspect/formats-more.js'), i18n.loadStrings()]);
      inspectT = i18n.t;
      return E.analyzeBytes(new Uint8Array(await item.file.arrayBuffer()), item.name, item.file.type || '');
    })().catch(err => { console.warn(err); return null; }));
  }
  return analyses.get(item.id);
}

/** Translate a label that came out of the inspector. */
export const inspectLabel = s => inspectT(s);

// ─── Preview ──────────────────────────────────────────────────────────────────

async function readText(item, limit) {
  const bytes = new Uint8Array(await item.file.slice(0, limit).arrayBuffer());
  let text = new TextDecoder('utf-8').decode(bytes);
  const broken = (text.match(/�/g) || []).length;
  if (broken > 8 && broken > text.length / 200) text = new TextDecoder('windows-1252').decode(bytes);
  return { text, cut: item.size > limit };
}

function parseCsv(text, delimiter) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
      if (rows.length >= 300) return rows;
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function csvTable(text, ext) {
  const firstLine = text.slice(0, text.indexOf('\n') + 1 || undefined);
  const delimiter = ext === 'tsv' ? '\t' : [';', '\t', ','].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = parseCsv(text, delimiter).filter(r => r.some(Boolean));
  if (rows.length < 2 || rows[0].length < 2) return null;
  const [head, ...body] = rows;
  return el('div.fm-pv-table', el('table',
    el('thead', el('tr', head.map(h => el('th', h)))),
    el('tbody', body.map(r => el('tr', head.map((_, i) => el('td', r[i] ?? '')))))));
}

function note(text) { return el('p.fm-pv-note', text); }

function placeholder(item, message) {
  return el('div.fm-pv-empty', el('div', { html: iconHtml(item) }), message ? el('p', message) : null);
}

async function renderPdf(item, host, full, alive) {
  let doc;
  try { doc = await openPdf(item); } catch (err) {
    fill(host, placeholder(item, err?.name === 'PasswordException' ? t('This PDF is password protected.') : t('This PDF could not be shown.')));
    return;
  }
  if (!alive()) { doc.destroy(); return; }
  const wrap = el('div.fm-pv-pages');
  fill(host, wrap);
  const limit = full ? Math.min(doc.numPages, 40) : 1;
  const width = Math.min(1400, (full ? 900 : 420) * Math.min(2, window.devicePixelRatio || 1));
  for (let n = 1; n <= limit; n++) {
    const canvas = await pdfPageCanvas(doc, n, width);
    if (!alive()) break;
    canvas.className = 'fm-pv-page';
    wrap.append(canvas);
  }
  if (alive()) {
    if (doc.numPages > limit) wrap.append(note(full
      ? t('Showing the first {shown} of {total} pages.', { shown: limit, total: fmtNum(doc.numPages) })
      : t('Pages: {n}', { n: fmtNum(doc.numPages) })));
    host.dataset.pages = doc.numPages;
  }
  doc.destroy();
}

async function renderText(item, host, full, alive) {
  const { text, cut } = await readText(item, full ? 2e6 : 120000);
  if (!alive()) return;
  let shown = text;
  if (item.ext === 'json' && !cut) { try { shown = JSON.stringify(JSON.parse(text), null, 2); } catch { /* shown as is */ } }
  const table = full && /^(csv|tsv)$/.test(item.ext) ? csvTable(text, item.ext) : null;
  fill(host,
    table || el('pre.fm-pv-text', { tabIndex: 0 }, shown),
    cut ? note(t('Showing the first {size} of this file.', { size: fmtBytes(full ? 2e6 : 120000) })) : null);
}

async function renderArchive(item, host, alive, onExtract) {
  let list = null;
  try {
    const { listArchive } = await import('./archive.js');
    if (item.size < 300e6) list = await listArchive(item.file);
  } catch { list = null; }
  if (!alive()) return;
  const extractBtn = onExtract ? btn(t('Extract here'), onExtract, { variant: 'secondary', ico: 'unzip' }) : null;
  if (!list) { fill(host, placeholder(item, t('Extract this archive to see what is inside.')), el('div.fm-pv-actions', extractBtn)); return; }
  const total = list.reduce((sum, e) => sum + (e.size || 0), 0);
  fill(host,
    el('div.fm-pv-listhead', el('strong', t('Files inside: {n}', { n: fmtNum(list.length) })), el('span', fmtBytes(total)), extractBtn),
    el('ul.fm-pv-list', list.slice(0, 250).map(e => el('li', el('span', e.path), el('small', fmtBytes(e.size || 0))))),
    list.length > 250 ? note(t('Showing the first {shown} of {total} entries.', { shown: 250, total: fmtNum(list.length) })) : null);
}

async function renderFont(item, host, alive) {
  const family = `fm-font-${item.id}`;
  try {
    const face = new FontFace(family, await item.file.arrayBuffer());
    await face.load();
    document.fonts.add(face);
  } catch { fill(host, placeholder(item, t('This font could not be loaded.'))); return; }
  if (!alive()) return;
  fill(host, el('div.fm-pv-font', { style: { fontFamily: `"${family}"` } },
    el('p.fm-pv-font__big', 'Aa Bb Cc'),
    el('p', 'The quick brown fox jumps over the lazy dog'),
    el('p', 'Zażółć gęślą jaźń · Příliš žluťoučký kůň · Größe'),
    el('p', '0123456789 !?&@#%()[]{}')));
}

async function renderExtracted(item, host, full, alive) {
  fill(host, el('div.fm-pv-loading', t('Reading…')));
  const result = await analysis(item);
  if (!alive()) return;
  const text = (result?.text || '').trim();
  if (!text) { fill(host, placeholder(item, t('No preview for this file type.'))); return; }
  const limit = full ? 400000 : 20000;
  fill(host,
    el('pre.fm-pv-text.fm-pv-text--prose', { tabIndex: 0 }, text.slice(0, limit)),
    text.length > limit ? note(t('Showing the beginning of the text.')) : null);
}

/**
 * Fill `host` with a preview of the file.
 * @param {{full?:boolean, onExtract?:Function}} opt  full = Quick Look, with more pages and text
 */
export function renderPreview(item, host, { full = false, onExtract } = {}) {
  const token = String(Math.random());
  host.dataset.token = token;
  host.dataset.kind = item.kind;
  delete host.dataset.pages;
  const alive = () => host.dataset.token === token && host.isConnected;
  fill(host, el('div.fm-pv-loading', t('Loading preview…')));

  const run = async () => {
    if (isBrowserImage(item)) {
      const img = el('img.fm-pv-img', { alt: item.name, src: URL.createObjectURL(item.file) });
      img.addEventListener('load', () => { host.dataset.dims = `${img.naturalWidth} × ${img.naturalHeight}`; host.dispatchEvent(new Event('fm:meta')); }, { once: true });
      img.addEventListener('error', () => { if (alive()) fill(host, placeholder(item, t('This image could not be shown.'))); }, { once: true });
      return fill(host, img);
    }
    if (item.kind === 'video' && /^(mp4|webm|mov|m4v|ogv)$/.test(item.ext)) {
      return fill(host, el('video.fm-pv-media', { controls: true, src: URL.createObjectURL(item.file), preload: 'metadata' }));
    }
    if (item.kind === 'audio' && /^(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/.test(item.ext)) {
      return fill(host, placeholder(item), el('audio.fm-pv-audio', { controls: true, src: URL.createObjectURL(item.file), preload: 'metadata' }));
    }
    if (isPdf(item)) return item.size > 150e6 ? fill(host, placeholder(item, t('This PDF is too large to preview.'))) : renderPdf(item, host, full, alive);
    if (item.kind === 'font') return renderFont(item, host, alive);
    if (isArchive(item)) return renderArchive(item, host, alive, onExtract);
    if (isTextLike(item) && item.ext !== 'rtf' && item.ext !== 'eml') return renderText(item, host, full, alive);
    if (item.size <= ANALYZE_LIMIT && /^(document|sheet|slides|email)$/.test(item.kind)) return renderExtracted(item, host, full, alive);
    return fill(host, placeholder(item, t('No preview for this file type.')));
  };
  run().catch(err => {
    console.warn(err);
    if (alive()) fill(host, placeholder(item, t('No preview for this file type.')));
  });
}
