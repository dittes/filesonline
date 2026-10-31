// app.js
// The file inspector UI. createInspector() mounts it into any element, so the same code
// runs on its own page and inside the file manager. Evolved from the Distil prototype.

import U from './util.js';
import E from './extractors.js';
import S from './summarize.js';
import './formats.js';
import './formats-more.js';
import { t, lang, loadStrings } from './i18n.js';
import { tikaFields, toJson, toXhtml, toCsv } from './tika.js';
import { trailingData, entropyLabel, findings, cleanupLink } from './forensics.js';

const MAX_BYTES = 1024 * 1024 * 1024;
const TEXT_LIMIT = 400000;
const RECURSE_MAX_DEPTH = 4;
const RECURSE_MAX_FILES = 200;
const RECURSE_MAX_FILE = 64 * 1024 * 1024;
const HEX_PAGE = 512;

const esc = U.esc;
const ICON = {
  copy: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg>',
  down: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  warn: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17.5v.01"/></svg>',
};

function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type: type || 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.hidden = true;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { return false; }
}

async function computeDigests(u8) {
  const hash = async (algo) => {
    if (!crypto.subtle) return '';
    const out = new Uint8Array(await crypto.subtle.digest(algo, u8));
    return Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('');
  };
  return { md5: U.md5(u8), sha1: await hash('SHA-1'), sha256: await hash('SHA-256'), sha512: await hash('SHA-512'), crc32: U.crc32(u8) };
}

const baseName = (n) => n.replace(/\.[^.]+$/, '') || n;
const leaf = (n) => n.split('/').filter(Boolean).pop() || n;
const metaLabel = (k) => t(k);
const metaValue = (v) => (v === 'Yes' || v === 'No' ? t(v) : String(v));

export async function createInspector(root, { onEmpty, routes = {} } = {}) {
  await loadStrings();
  const items = [];
  let selectedId = null, activeTab = 'overview', uid = 0, textQuery = '', view = 'file', pumping = false, textMode = 'all', metaMode = 'readable';

  root.classList.add('fi');
  root.innerHTML = `
    <aside class="fi-side" aria-label="${esc(t('Files'))}">
      <div class="fi-side__head">
        <h2>${esc(t('Files'))}</h2>
        <button class="s-btn s-btn--link" type="button" data-act="clear">${esc(t('Clear all'))}</button>
      </div>
      <button class="fi-batchbtn" type="button" data-act="batch" hidden></button>
      <ul class="fi-list"></ul>
      <button class="s-btn s-btn--ghost fi-side__add" type="button" data-act="add">+ ${esc(t('Add files'))}</button>
    </aside>
    <article class="fi-detail" aria-live="polite"></article>
    <input type="file" multiple hidden class="fi-picker">
    <div class="fi-toast" role="status" aria-live="polite"></div>`;
  const $ = (s) => root.querySelector(s);
  const detail = $('.fi-detail');
  const picker = $('.fi-picker');
  const current = () => items.find((i) => i.id === selectedId);

  let toastTimer;
  const toast = (msg) => {
    const el = $('.fi-toast');
    el.textContent = msg; el.classList.add('is-shown');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('is-shown'), 1900);
  };

  /* ---------- intake and processing ---------- */
  function addFiles(files, { select = true, parent = null, path = '' } = {}) {
    const list = Array.from(files).filter((f) => f && !/^\.DS_Store$|^Thumbs\.db$/i.test(f.name));
    if (!list.length) return [];
    const added = [];
    list.forEach((file) => {
      const it = { id: ++uid, file, status: 'queued', result: null, summary: null, error: '', parent, depth: parent ? parent.depth + 1 : 0, path: path || file.name };
      if (file.size > MAX_BYTES) { it.status = 'error'; it.error = t('This file is {size}. The limit for analysis in a browser is {max}.', { size: U.fmtBytes(file.size), max: U.fmtBytes(MAX_BYTES) }); }
      if (parent) items.splice(items.indexOf(parent) + 1, 0, it); else items.push(it);
      added.push(it);
    });
    if (select) { selectedId = added[0].id; view = 'file'; }
    renderList(); renderDetail();
    pump();
    return added;
  }

  async function analyze(it) {
    it.status = 'working';
    renderList();
    const t0 = performance.now();
    try {
      const u8 = new Uint8Array(await it.file.arrayBuffer());
      it.result = await E.analyzeBytes(u8, it.file.name, it.file.type);
      it.summary = S.run(it.result, it.file);
      it.ms = performance.now() - t0;
      it.digests = await computeDigests(u8);
      it.stats = U.byteStats(u8);
      it.trailing = trailingData(u8, it.result.type);
      it.head = u8.subarray(0, 64).slice();
      if (it.trailing) it.result.warnings.push(t('There are {n} extra bytes after the logical end of this file, which can be a sign of hidden data.', { n: U.fmtNum(it.trailing) }));
      it.status = 'done';
    } catch (e) {
      console.error(e);
      it.status = 'error';
      it.error = t('This file could not be read. It may be damaged or use a feature that is not supported yet.');
    }
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    for (;;) {
      const it = items.find((i) => i.status === 'queued');
      if (!it) break;
      await analyze(it);
      renderList();
      if (view === 'batch' || it.id === selectedId) renderDetail();
      await U.yield();
    }
    pumping = false;
  }

  /** Open a file from inside another one as its own entry. */
  async function openEmbedded(parent, index, { select = true } = {}) {
    const entry = parent.result.embedded[index];
    if (entry.opened) { if (select) { selectedId = entry.opened.id; view = 'file'; activeTab = 'overview'; renderList(); renderDetail(); } return entry.opened; }
    const bytes = await entry.read();
    const file = new File([bytes], leaf(entry.name), { lastModified: entry.date ? entry.date.getTime() : Date.now() });
    const [child] = addFiles([file], { select, parent, path: `${parent.path}/${entry.name}` });
    entry.opened = child;
    return child;
  }

  /** Recursive export, with limits so an archive bomb cannot take the tab down. */
  async function collectRecursive(startItems) {
    const out = [];
    let budget = RECURSE_MAX_FILES;
    const visit = async (it) => {
      while (it.status === 'queued' || it.status === 'working') await new Promise((res) => setTimeout(res, 40));
      out.push(it);
      const entries = it.result?.embedded || [];
      if (it.depth >= RECURSE_MAX_DEPTH) return;
      for (let i = 0; i < entries.length && budget > 0; i++) {
        if ((entries[i].size || 0) > RECURSE_MAX_FILE) continue;
        budget--;
        try { await visit(await openEmbedded(it, i, { select: false })); } catch (e) { /* unreadable entry stays out */ }
      }
    };
    for (const it of startItems) await visit(it);
    return out;
  }

  function removeItem(id) {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    const doomed = new Set([id]);
    let grew = true;
    while (grew) { grew = false; items.forEach((x) => { if (x.parent && doomed.has(x.parent.id) && !doomed.has(x.id)) { doomed.add(x.id); grew = true; } }); }
    for (let i = items.length - 1; i >= 0; i--) {
      if (doomed.has(items[i].id)) { revoke(items[i]); if (items[i].parent?.result?.embedded) items[i].parent.result.embedded.forEach((e) => { if (e.opened === items[i]) e.opened = null; }); items.splice(i, 1); }
    }
    if (!items.length) return reset();
    if (doomed.has(selectedId)) selectedId = items[0].id;
    renderList(); renderDetail();
  }
  function revoke(it) {
    const p = it.result && it.result.preview;
    if (p) [p.url, p.cover].forEach((u) => u && URL.revokeObjectURL(u));
  }
  function reset() {
    items.splice(0).forEach(revoke);
    selectedId = null; view = 'file';
    renderList(); detail.innerHTML = '';
    onEmpty?.();
  }

  /* ---------- sidebar ---------- */
  function renderList() {
    const top = items.filter((i) => !i.parent);
    const batch = $('.fi-batchbtn');
    batch.hidden = items.length < 2;
    batch.textContent = t('Compare all files ({n})', { n: items.length });
    batch.classList.toggle('is-active', view === 'batch');
    void top;
    $('.fi-list').innerHTML = items.map((it) => {
      const r = it.result;
      const badge = r ? E.badge(r.type, it.file.name) : U.extOf(it.file.name).toUpperCase().slice(0, 4) || '…';
      const sub = it.status === 'error' ? t('Could not read') : r ? `${t(r.kind)} · ${U.fmtBytes(it.file.size)}` : `${U.fmtBytes(it.file.size)} · ${it.status === 'working' ? t('analyzing…') : t('waiting')}`;
      const state = it.status === 'working' ? '<span class="fi-spinner"></span>' : '';
      return `<li style="--depth:${it.depth}"><button class="fi-item${it.id === selectedId && view === 'file' ? ' is-active' : ''}" type="button" data-id="${it.id}" title="${esc(it.file.name)}">
        <span class="fi-badge">${esc(badge)}</span>
        <span class="fi-item__text"><span class="fi-item__name" data-no-i18n>${esc(it.file.name)}</span><span class="fi-item__sub">${esc(sub)}</span></span>${state}</button>
        <button class="fi-remove" type="button" data-remove="${it.id}" aria-label="${esc(t('Remove'))}">${ICON.x}</button></li>`;
    }).join('');
  }

  /* ---------- detail frame ---------- */
  function fullMeta(it) {
    const r = it.result;
    const file = {
      Name: it.file.name,
      Size: `${U.fmtBytes(it.file.size)} (${U.fmtNum(it.file.size)} B)`,
      'Detected type': t(r.kind),
      'MIME type': r.mime,
      'Parsed by': r.parser,
      'Last modified': it.file.lastModified ? U.fmtDate(new Date(it.file.lastModified)) : '',
      'Inside': it.parent ? it.parent.file.name : '',
      'Analyzed in': it.ms ? `${Math.round(it.ms)} ms` : '',
    };
    Object.keys(file).forEach((k) => { if (!file[k]) delete file[k]; });
    const digests = it.digests ? { MD5: it.digests.md5, 'SHA-1': it.digests.sha1, 'SHA-256': it.digests.sha256, 'SHA-512': it.digests.sha512, CRC32: it.digests.crc32 } : {};
    const lang2 = it.summary?.language;
    const langGroup = lang2 && lang2.name ? { Language: t(lang2.name), Confidence: `${Math.round(lang2.confidence * 100)}%` } : {};
    return { File: file, Checksums: digests, 'Language detection': langGroup, ...r.meta };
  }

  const tab = (id, label, n) => `<button class="fi-tab" type="button" role="tab" data-tab="${id}" aria-selected="${activeTab === id}">${esc(t(label))}${n ? `<span class="fi-count">${n}</span>` : ''}</button>`;

  function renderDetail() {
    if (view === 'batch') { renderBatch(); return; }
    const it = current();
    if (!it) { detail.innerHTML = ''; return; }
    const r = it.result;
    const badge = r ? E.badge(r.type, it.file.name) : U.extOf(it.file.name).toUpperCase().slice(0, 4) || '…';
    const sub = r ? `${esc(t(r.kind))} · ${U.fmtBytes(it.file.size)}${it.file.lastModified ? ` · ${esc(U.fmtDate(new Date(it.file.lastModified)))}` : ''}` : U.fmtBytes(it.file.size);
    const ready = it.status === 'done';
    const sections = r ? r.sections.length : 0;
    const embedded = r?.embedded?.length || 0;
    const metaCount = r ? Object.values(fullMeta(it)).reduce((n, g) => n + Object.keys(g).length, 0) : 0;
    if ((activeTab === 'structure' && !sections) || (activeTab === 'embedded' && !embedded)) activeTab = 'overview';
    detail.innerHTML = `
      <div class="fi-head">
        <span class="fi-badge fi-badge--lg">${esc(badge)}</span>
        <div class="fi-head__title">
          ${it.parent ? `<p class="fi-crumb" data-no-i18n>${esc(it.path.split('/').slice(0, -1).join(' › '))}</p>` : ''}
          <h2 data-no-i18n>${esc(it.file.name)}</h2>
          <p>${sub}</p>
        </div>
        ${ready ? `<div class="fi-head__actions">
          <button class="s-btn s-btn--ghost" type="button" data-act="copy-text">${ICON.copy} ${esc(t('Copy text'))}</button>
          <details class="fi-export">
            <summary class="s-btn s-btn--secondary">${ICON.down} ${esc(t('Export'))}</summary>
            <div class="fi-export__menu">
              <button type="button" data-act="dl-txt"><b>${esc(t('Text'))}</b> .txt</button>
              <button type="button" data-act="dl-json"><b>${esc(t('Metadata and text'))}</b> .json</button>
              ${embedded ? `<button type="button" data-act="dl-json-rec"><b>${esc(t('Including embedded files'))}</b> .json</button>` : ''}
              <button type="button" data-act="dl-xhtml"><b>${esc(t('Structured document'))}</b> .xhtml</button>
              <button type="button" data-act="dl-csv"><b>${esc(t('Metadata table'))}</b> .csv</button>
            </div>
          </details>
        </div>` : ''}
      </div>
      ${ready ? `<div class="fi-tabs" role="tablist">
        ${tab('overview', 'Overview')}${tab('text', 'Text')}${tab('metadata', 'Metadata', metaCount)}${embedded ? tab('embedded', 'Embedded', embedded) : ''}${sections ? tab('structure', 'Structure', sections) : ''}${tab('bytes', 'Bytes')}
      </div>` : ''}
      <div class="fi-panel" role="tabpanel"></div>`;
    renderPanel();
  }

  function renderPanel() {
    const it = current(), p = $('.fi-panel');
    if (!it || !p) return;
    if (it.status === 'queued' || it.status === 'working') {
      p.innerHTML = `<div class="fi-card fi-empty"><span class="fi-spinner fi-spinner--lg"></span>${esc(t('Analyzing…'))}</div>`;
      return;
    }
    if (it.status === 'error') {
      p.innerHTML = `<div class="fi-banner fi-banner--error">${ICON.warn}<div>${esc(it.error)}</div></div>`;
      return;
    }
    ({ overview, text: textTab, metadata: metaTab, embedded: embeddedTab, structure: structTab, bytes: bytesTab }[activeTab])(it, p);
  }

  const banners = (r) => r.warnings.map((w) => `<div class="fi-banner">${ICON.warn}<div>${esc(w)}</div></div>`).join('');

  /* ---------- overview ---------- */
  const PRIORITY = ['Title', 'Name', 'Author', 'Artist', 'Album', 'Camera model', 'Taken', 'Created', 'Modified', 'Last modified by', 'Application', 'Producer', 'Creator', 'Language', 'Publisher', 'Subject', 'Family', 'Architecture', 'From', 'To', 'Target', 'Video codec', 'Audio codec'];
  function highlights(it) {
    const out = [], seen = new Set();
    const m = it.result.meta;
    for (const k of PRIORITY) {
      for (const g of Object.keys(m)) {
        if (g !== 'XMP' && m[g][k] && !seen.has(k)) { seen.add(k); out.push([k === 'Camera model' ? 'Camera' : k, String(m[g][k])]); }
      }
      if (out.length >= 10) break;
    }
    const enc = (m.Text || {}).Encoding;
    if (enc) out.push(['Encoding', enc]);
    return out;
  }

  function overview(it, p) {
    const r = it.result, s = it.summary;
    const prose = s.mode === 'prose';
    const headline = s.headline && s.headline.toLowerCase() !== it.file.name.toLowerCase() ? s.headline : '';
    const summaryCard = `
      <section class="fi-card fi-summary">
        <h3 class="fi-label">${esc(t(prose ? 'Summary' : s.mode === 'data' ? 'Data overview' : 'Overview'))}</h3>
        ${headline ? `<div class="fi-headline">${esc(headline)}</div>` : ''}
        <p class="fi-lead">${esc(s.paragraph || s.blurb)}</p>
        ${s.points.length ? `<ul class="fi-points">${s.points.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${prose && s.points.length ? `<p class="fi-note">${esc(t('Key sentences are picked automatically from the text. Nothing is rewritten or sent anywhere.'))}</p>` : ''}
        <div class="fi-card__actions"><button class="s-btn s-btn--ghost" type="button" data-act="copy-summary">${ICON.copy} ${esc(t('Copy summary'))}</button>${r.canOcr && !r.ocrDone ? ocrButton() : ''}</div>
      </section>`;
    let previewCard = '';
    if (r.preview) {
      const pv = r.preview;
      const inner = pv.type === 'image' ? `<img src="${pv.url}" alt="">`
        : pv.type === 'video' ? `<video src="${pv.url}" controls preload="metadata"></video>`
          : `${pv.cover ? `<img src="${pv.cover}" alt="">` : ''}<audio src="${pv.url}" controls preload="metadata"></audio>`;
      previewCard = `<section class="fi-card fi-previewcard"><h3 class="fi-label">${esc(t('Preview'))}</h3><div class="fi-preview">${inner}</div></section>`;
    }
    const tiles = prose && s.stats.words
      ? [[U.fmtNum(s.stats.words), 'words'], [`${Math.max(1, Math.round(s.stats.readMin))} min`, 'reading time'], [U.fmtNum(s.stats.sentences), 'sentences'],
        [U.fmtNum(s.stats.unique), 'unique words'], [s.stats.language ? t(s.stats.language) : '—', 'language'], [s.stats.avgSentence ? s.stats.avgSentence.toFixed(1) : '—', 'words per sentence']]
      : r.facts.slice(0, 6).map(([k, v]) => [v, k]);
    const tilesHtml = tiles.length ? `<div class="fi-tiles">${tiles.map(([b, l]) => `<div class="fi-tile${String(b).length > 9 ? ' is-long' : ''}"><b title="${esc(b)}">${esc(b)}</b><span>${esc(t(l))}</span></div>`).join('')}</div>` : '';

    const hi = highlights(it);
    const detailsCard = hi.length ? `<section class="fi-card"><h3 class="fi-label">${esc(t('Details'))}</h3><dl class="fi-kv">${hi.map(([k, v]) => `<dt>${esc(metaLabel(k))}</dt><dd>${esc(v.length > 160 ? `${v.slice(0, 160)}…` : metaValue(v))}</dd>`).join('')}</dl></section>` : '';
    const kwCard = s.keywords.length ? `<section class="fi-card"><h3 class="fi-label">${esc(t('Key topics'))}</h3><div class="fi-chips">${s.keywords.map((k, i) => `<span class="fi-chip${i < 4 ? ' is-hot' : ''}">${esc(k.term)} <small>${k.count}</small></span>`).join('')}</div></section>` : '';

    const reveals = findings(it);
    const fix = reveals.length ? cleanupLink(it, routes, lang) : null;
    const revealCard = reveals.length ? `<section class="fi-card fi-reveal">
      <h3 class="fi-label">${esc(t('What this file reveals'))}</h3>
      <dl class="fi-kv">${reveals.map((x) => `<dt class="${x.level === 'high' ? 'is-high' : ''}">${esc(x.label)}</dt><dd>${esc(String(x.value).slice(0, 160))}</dd>`).join('')}</dl>
      ${fix ? `<p class="fi-card__actions"><a class="s-btn s-btn--secondary" href="${fix.href}"${fix.external ? ' rel="noopener"' : ''}>${esc(fix.label)}${fix.external ? ' ↗' : ''}</a></p>` : ''}
    </section>` : '';

    const fmtN = (n) => (Math.abs(n) >= 1000 ? U.fmtNum(Math.round(n)) : String(+Number(n).toFixed(2)));
    const profileCards = (s.profiles || []).map((pr) => `
      <section class="fi-card"><h3 class="fi-label">${esc(t('Fields'))}${s.profiles.length > 1 ? ` · ${esc(pr.name)}` : ''} · ${U.fmtNum(pr.records)}</h3>
      <div class="fi-tablewrap"><table class="fi-table"><thead><tr><th>${esc(t('Field'))}</th><th>${esc(t('Type'))}</th><th>${esc(t('Filled'))}</th><th>${esc(t('Distinct'))}</th><th>${esc(t('Range or most common'))}</th></tr></thead><tbody>
      ${pr.columns.slice(0, 60).map((c) => `<tr><td><b>${esc(c.name)}</b></td><td>${esc(t(c.type))}</td><td class="is-num">${U.fmtNum(c.filled)}</td><td class="is-num">${c.unique !== undefined ? U.fmtNum(c.unique) : ''}</td>
        <td>${c.type === 'number' ? `${fmtN(c.min)} → ${fmtN(c.max)} · ⌀ ${fmtN(c.mean)}` : c.type === 'date' ? `${esc(c.min)} → ${esc(c.max)}` : c.top ? esc(c.top.map(([v, n]) => `${String(v).slice(0, 30)} (${n})`).join(', ')) : ''}</td></tr>`).join('')}
      </tbody></table></div></section>`).join('');

    const groups = Object.entries(s.entities || {});
    const entCard = groups.length ? `<section class="fi-card"><h3 class="fi-label">${esc(t('Found in the content'))}</h3><div class="fi-entities">${groups.map(([k, v]) => `<div><h4>${esc(t(k))}</h4><div class="fi-chips">${v.map((x) => `<span class="fi-chip">${esc(x)}</span>`).join('')}</div></div>`).join('')}</div></section>` : '';

    p.innerHTML = banners(r)
      + `<div class="fi-herorow${previewCard ? ' has-preview' : ''}">${summaryCard}${previewCard}</div>`
      + tilesHtml
      + (kwCard || detailsCard ? `<div class="fi-two">${kwCard}${detailsCard}</div>` : '')
      + revealCard + profileCards + entCard;
  }

  /* ---------- OCR ---------- */
  function ocrButton() {
    return `<span class="fi-ocr"><select class="pt-input" data-ocr-lang aria-label="${esc(t('Language of the text'))}">
      ${[['eng', 'English'], ['deu', 'Deutsch'], ['pol', 'Polski'], ['ces', 'Čeština']].map(([v, l]) => `<option value="${v}"${{ en: 'eng', de: 'deu', pl: 'pol', cs: 'ces' }[lang] === v ? ' selected' : ''}>${l}</option>`).join('')}
    </select><button class="s-btn s-btn--primary" type="button" data-act="ocr">${esc(t('Read text with OCR'))}</button></span>`;
  }

  async function runOcr(it) {
    const select = root.querySelector('[data-ocr-lang]');
    const code = select ? select.value : 'eng';
    const button = root.querySelector('[data-act="ocr"]');
    const setLabel = (f) => { if (button) button.textContent = `${t('Reading…')} ${Math.round(f * 100)}%`; };
    if (button) button.disabled = true;
    setLabel(0);
    try {
      const { ocrImage, ocrPdf } = await import('./ocr.js');
      const text = it.result.pdfBytes ? await ocrPdf(it.result.pdfBytes, code, setLabel) : await ocrImage(it.result.imageUrl, code, setLabel);
      it.result.text = text;
      it.result.summaryText = text;
      it.result.noText = false;
      it.result.ocrDone = true;
      it.result.parser = `${it.result.parser} + OCR (Tesseract)`;
      E.helpers.put(it.result, 'Text', 'OCR language', code);
      it.summary = S.run(it.result, it.file);
      renderDetail();
      toast(t('Text recognized'));
    } catch (e) {
      console.error(e);
      toast(t('Text recognition failed'));
      renderDetail();
    }
  }

  /* ---------- text ---------- */
  function textTab(it, p) {
    const r = it.result;
    if (!r.text) {
      p.innerHTML = `${banners(r)}<div class="fi-card fi-empty">${esc(t('No text could be extracted from this file.'))}${r.canOcr && !r.ocrDone ? `<div class="fi-card__actions">${ocrButton()}</div>` : ''}</div>`;
      return;
    }
    const code = ['code', 'json', 'jsonl', 'xml', 'csv', 'svg'].includes(r.type);
    const source = textMode === 'main' && r.mainText ? r.mainText : r.text;
    p.innerHTML = `${banners(r)}<section class="fi-card">
      <div class="fi-toolbar">
        <input class="pt-input fi-search" type="search" placeholder="${esc(t('Search in text…'))}" value="${esc(textQuery)}" autocomplete="off" aria-label="${esc(t('Search in text…'))}">
        <span class="fi-matches"></span>
        <button class="s-btn s-btn--icon" type="button" data-step="-1" aria-label="${esc(t('Previous match'))}">↑</button>
        <button class="s-btn s-btn--icon" type="button" data-step="1" aria-label="${esc(t('Next match'))}">↓</button>
        ${r.mainText ? `<select class="pt-input fi-mode" aria-label="${esc(t('Text to show'))}"><option value="all"${textMode === 'all' ? ' selected' : ''}>${esc(t('All text'))}</option><option value="main"${textMode === 'main' ? ' selected' : ''}>${esc(t('Main content only'))}</option></select>` : ''}
      </div>
      <pre class="fi-text${code ? ' is-code' : ''}" tabindex="0" data-no-i18n></pre>
      <p class="fi-note fi-textnote"></p></section>`;
    const tv = $('.fi-text'), q = $('.fi-search'), mc = $('.fi-matches');
    const shown = source.length > TEXT_LIMIT ? source.slice(0, TEXT_LIMIT) : source;
    if (source.length > TEXT_LIMIT) $('.fi-textnote').textContent = t('Showing the first {shown} of {total} characters. Copy and export include everything.', { shown: U.fmtNum(TEXT_LIMIT), total: U.fmtNum(source.length) });
    let marks = [], cur = 0;
    const focusMark = () => {
      marks.forEach((m) => m.classList.remove('is-current'));
      if (!marks.length) { mc.textContent = q.value ? t('No matches') : ''; return; }
      const m = marks[cur];
      m.classList.add('is-current');
      mc.textContent = `${cur + 1} / ${marks.length}${marks.length >= 3000 ? '+' : ''}`;
      tv.scrollTop = m.offsetTop - tv.clientHeight / 2 - tv.offsetTop;
    };
    const paint = () => {
      const query = q.value;
      textQuery = query;
      if (!query) { tv.textContent = shown; marks = []; mc.textContent = ''; return; }
      const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      let html = '', last = 0, n = 0, m;
      while ((m = re.exec(shown)) && n < 3000) {
        if (!m[0]) { re.lastIndex++; continue; }
        html += `${esc(shown.slice(last, m.index))}<mark>${esc(m[0])}</mark>`;
        last = m.index + m[0].length; n++;
      }
      tv.innerHTML = html + esc(shown.slice(last));
      marks = Array.from(tv.querySelectorAll('mark'));
      cur = 0; focusMark();
    };
    const step = (d) => { if (marks.length) { cur = (cur + d + marks.length) % marks.length; focusMark(); } };
    q.addEventListener('input', paint);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); } });
    p.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => step(+b.dataset.step)));
    p.querySelector('.fi-mode')?.addEventListener('change', (e) => { textMode = e.target.value; renderPanel(); });
    paint();
  }

  /* ---------- metadata ---------- */
  function metaTab(it, p) {
    p.innerHTML = `${banners(it.result)}<section class="fi-card">
      <div class="fi-toolbar">
        <input class="pt-input fi-search" type="search" placeholder="${esc(t('Filter metadata…'))}" autocomplete="off" aria-label="${esc(t('Filter metadata…'))}">
        <div class="fi-seg" role="group" aria-label="${esc(t('Field names'))}">
          <button type="button" data-meta="readable" aria-pressed="${metaMode === 'readable'}">${esc(t('Readable'))}</button>
          <button type="button" data-meta="tika" aria-pressed="${metaMode === 'tika'}">${esc(t('Standard fields'))}</button>
        </div>
        <button class="s-btn s-btn--ghost" type="button" data-act="copy-meta">${ICON.copy} JSON</button>
      </div>
      <div class="fi-groups"></div></section>`;
    const isHash = (v) => /^[0-9a-f]{8,128}$/.test(v);
    const draw = () => {
      const f = p.querySelector('.fi-search').value.trim().toLowerCase();
      let html = '';
      const groups = metaMode === 'tika'
        ? { '': Object.fromEntries(Object.entries(tikaFields(it)).map(([k, v]) => [k, Array.isArray(v) ? v.join(' | ') : v])) }
        : fullMeta(it);
      for (const [g, kv] of Object.entries(groups)) {
        const rows = Object.entries(kv).filter(([k, v]) => !f || `${k} ${metaLabel(k)} ${v}`.toLowerCase().includes(f));
        if (!rows.length) continue;
        html += `<div class="fi-group">${g ? `<h4>${esc(t(g))}</h4>` : ''}<dl class="fi-kv">${rows.map(([k, v]) => `<dt>${esc(metaMode === 'tika' || g === 'XMP' ? k : metaLabel(k))}</dt><dd${isHash(String(v)) ? ' class="is-mono"' : ''}>${esc(metaValue(v))}</dd>`).join('')}</dl></div>`;
      }
      p.querySelector('.fi-groups').innerHTML = html || `<p class="fi-empty">${esc(t('Nothing matches your filter.'))}</p>`;
    };
    p.querySelector('.fi-search').addEventListener('input', draw);
    p.querySelectorAll('[data-meta]').forEach((b) => b.addEventListener('click', () => { metaMode = b.dataset.meta; renderPanel(); }));
    draw();
  }

  /* ---------- embedded ---------- */
  function embeddedTab(it, p) {
    const entries = it.result.embedded;
    const shown = entries.slice(0, 1000);
    p.innerHTML = `${banners(it.result)}<section class="fi-card">
      <div class="fi-toolbar">
        <p class="fi-note">${esc(t('Files inside this one. Inspect any of them just like a file you opened, or save it to your device.'))}</p>
        <button class="s-btn s-btn--ghost" type="button" data-act="scan-all">${esc(t('Inspect all'))}</button>
      </div>
      <div class="fi-tablewrap"><table class="fi-table"><thead><tr><th>${esc(t('Name'))}</th><th class="is-num">${esc(t('Size'))}</th><th></th></tr></thead><tbody>
      ${shown.map((e, i) => `<tr><td data-no-i18n>${esc(e.name)}</td><td class="is-num">${U.fmtBytes(e.size || 0)}</td><td class="fi-rowactions">
        <button class="s-btn s-btn--ghost" type="button" data-open="${i}">${esc(t('Inspect'))}</button>
        <button class="s-btn s-btn--icon" type="button" data-save="${i}" aria-label="${esc(t('Download'))}" title="${esc(t('Download'))}">${ICON.down}</button></td></tr>`).join('')}
      </tbody></table></div>
      ${entries.length > shown.length ? `<p class="fi-note">${esc(t('Showing the first {shown} of {total} entries.', { shown: U.fmtNum(shown.length), total: U.fmtNum(entries.length) }))}</p>` : ''}
    </section>`;
    p.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openEmbedded(it, +b.dataset.open)));
    p.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', async () => {
      const e = entries[+b.dataset.save];
      download(leaf(e.name), await e.read());
    }));
  }

  /* ---------- structure ---------- */
  function tableHtml(rows, header) {
    if (!rows || !rows.length) return `<p class="fi-empty">${esc(t('No rows'))}</p>`;
    const cols = Math.min(30, rows.reduce((m, r) => Math.max(m, r.length), 0));
    const cell = (v) => esc(String(v === undefined ? '' : v).slice(0, 300));
    const isNum = (v) => v !== '' && v !== undefined && !isNaN(Number(String(v).replace(/,/g, '')));
    const body = rows.slice(header ? 1 : 0, 61).map((r) => `<tr>${Array.from({ length: cols }, (_, i) => `<td${isNum(r[i]) ? ' class="is-num"' : ''}>${cell(r[i])}</td>`).join('')}</tr>`).join('');
    const head = header ? `<thead><tr>${Array.from({ length: cols }, (_, i) => `<th>${cell(t(String(rows[0][i] ?? '')))}</th>`).join('')}</tr></thead>` : '';
    return `<div class="fi-tablewrap"><table class="fi-table" data-no-i18n>${head}<tbody>${body}</tbody></table></div>`;
  }
  const looksHeader = (rows) => rows.length > 1 && rows[0].length > 0 && rows[0].every((c) => String(c).trim() !== '' && isNaN(Number(c)));

  function structTab(it, p) {
    const r = it.result;
    p.innerHTML = banners(r) + r.sections.map((s, i) => {
      let body = '';
      if (s.list) body = `<ul class="fi-outline" data-no-i18n>${s.list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
      else if (s.table) body = tableHtml(s.table.rows, s.table.head ? true : looksHeader(s.table.rows));
      else if (s.pages) body = s.pages.map((pg) => `<div class="fi-page"><b>${esc(t('Page {n}', { n: pg.n }))}</b><p data-no-i18n>${esc(pg.text)}</p></div>`).join('');
      else if (s.hex) body = `<pre class="fi-hex" data-no-i18n>${esc(s.hex)}</pre>`;
      else if (s.text) body = `<pre class="fi-text" data-no-i18n>${esc(s.text)}</pre>`;
      return `<details class="fi-section"${s.open || (i === 0 && r.sections.length === 1) ? ' open' : ''}><summary>${esc(s.title)}</summary><div class="fi-section__body">${body}</div></details>`;
    }).join('');
  }

  /* ---------- bytes ---------- */
  function bytesTab(it, p) {
    const { stats, file } = it;
    const buckets = new Array(64).fill(0);
    stats.hist.forEach((n, b) => { buckets[b >> 2] += n; });
    const max = Math.max(...buckets, 1);
    const bars = buckets.map((n, i) => `<rect x="${i * 10}" y="${100 - (n / max) * 100}" width="8" height="${(n / max) * 100}"></rect>`).join('');
    const d = it.result.detection || {};
    p.innerHTML = `<section class="fi-card">
      <h3 class="fi-label">${esc(t('Type detection'))}</h3>
      <dl class="fi-kv">
        <dt>${esc(t('Detected from content'))}</dt><dd>${esc(t(it.result.kind))} · <span class="is-mono">${esc(it.result.mime)}</span></dd>
        <dt>${esc(t('File extension'))}</dt><dd>${d.ext ? `.${esc(d.ext)}` : '—'}${d.mismatch ? ` · <b class="is-alert">${esc(t('Does not match'))}</b>` : ''}</dd>
        <dt>${esc(t('Browser says'))}</dt><dd class="is-mono">${esc(d.browser || '—')}</dd>
        <dt>${esc(t('First bytes'))}</dt><dd class="is-mono">${Array.from(it.head.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join(' ')}</dd>
      </dl>
    </section>
    <section class="fi-card">
      <h3 class="fi-label">${esc(t('Byte statistics'))}</h3>
      <div class="fi-tiles">
        <div class="fi-tile"><b>${stats.entropy.toFixed(2)}</b><span>${esc(t('entropy (bits per byte)'))}</span></div>
        <div class="fi-tile is-long"><b>${esc(entropyLabel(stats.entropy))}</b><span>${esc(t('what that suggests'))}</span></div>
        <div class="fi-tile"><b>${Math.round(stats.printable * 100)}%</b><span>${esc(t('printable characters'))}</span></div>
        <div class="fi-tile"><b>${U.fmtBytes(it.trailing)}</b><span>${esc(t('after the end of the file'))}</span></div>
      </div>
      <svg class="fi-histogram" viewBox="0 0 640 100" preserveAspectRatio="none" role="img" aria-label="${esc(t('Distribution of byte values'))}">${bars}</svg>
      <p class="fi-note">${esc(t('Distribution of byte values, 0 to 255.'))}</p>
    </section>
    <section class="fi-card">
      <div class="fi-toolbar">
        <h3 class="fi-label">${esc(t('Hex view'))}</h3>
        <span class="fi-matches fi-hexpos"></span>
        <button class="s-btn s-btn--icon" type="button" data-hex="-1" aria-label="${esc(t('Previous'))}">←</button>
        <button class="s-btn s-btn--icon" type="button" data-hex="1" aria-label="${esc(t('Next'))}">→</button>
      </div>
      <pre class="fi-hex" data-no-i18n></pre>
    </section>`;
    const pre = p.querySelector('.fi-hex');
    let offset = 0;
    const draw = async () => {
      const slice = new Uint8Array(await file.slice(offset, offset + HEX_PAGE).arrayBuffer());
      const lines = [];
      for (let i = 0; i < slice.length; i += 16) {
        const row = Array.from(slice.subarray(i, i + 16));
        lines.push(`${(offset + i).toString(16).padStart(8, '0')}  ${row.map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47)}  ${row.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')}`);
      }
      pre.textContent = lines.join('\n');
      p.querySelector('.fi-hexpos').textContent = `${U.fmtNum(offset)} – ${U.fmtNum(Math.min(offset + HEX_PAGE, file.size))} / ${U.fmtNum(file.size)}`;
    };
    p.querySelectorAll('[data-hex]').forEach((b) => b.addEventListener('click', () => {
      offset = Math.max(0, Math.min(offset + +b.dataset.hex * HEX_PAGE, Math.max(0, file.size - 1)));
      draw();
    }));
    draw();
  }

  /* ---------- batch ---------- */
  function renderBatch() {
    const done = items.filter((i) => i.status === 'done');
    const totalSize = items.reduce((n, i) => n + i.file.size, 0);
    const cell = (it, keys) => { for (const [g, k] of keys) { const v = (it.result.meta[g] || {})[k]; if (v) return String(v); } return ''; };
    detail.innerHTML = `<div class="fi-head">
        <span class="fi-badge fi-badge--lg">${items.length}</span>
        <div class="fi-head__title"><h2>${esc(t('All files'))}</h2><p>${U.fmtBytes(totalSize)} · ${esc(t('{done} of {total} analyzed', { done: done.length, total: items.length }))}</p></div>
        <div class="fi-head__actions">
          <button class="s-btn s-btn--ghost" type="button" data-act="batch-csv">${ICON.down} .csv</button>
          <button class="s-btn s-btn--secondary" type="button" data-act="batch-json">${ICON.down} .json</button>
        </div>
      </div>
      <section class="fi-card"><div class="fi-tablewrap"><table class="fi-table">
        <thead><tr><th>${esc(t('Name'))}</th><th>${esc(t('Type'))}</th><th class="is-num">${esc(t('Size'))}</th><th>${esc(t('Author'))}</th><th>${esc(t('Language'))}</th><th>SHA-256</th></tr></thead>
        <tbody>${items.map((it) => {
    const r = it.result;
    return `<tr><td><button class="fi-linkbtn" type="button" data-id="${it.id}" data-no-i18n>${esc(it.file.name)}</button></td><td>${r ? esc(t(r.kind)) : esc(it.status === 'error' ? t('Could not read') : t('waiting'))}</td><td class="is-num">${U.fmtBytes(it.file.size)}</td>
      <td data-no-i18n>${r ? esc(cell(it, [['Document', 'Author'], ['Tags', 'Artist'], ['Book', 'Author'], ['Camera & EXIF', 'Artist']])) : ''}</td><td>${it.summary?.language?.name ? esc(t(it.summary.language.name)) : ''}</td><td class="is-mono" title="${esc(it.digests?.sha256 || '')}">${esc((it.digests?.sha256 || '').slice(0, 12))}</td></tr>`;
  }).join('')}</tbody></table></div></section>`;
  }

  /* ---------- actions ---------- */
  const summaryText = (it) => {
    const s = it.summary;
    return [s.headline, s.paragraph || s.blurb, ...s.points.map((x) => `• ${x}`), s.keywords.length ? `\n${s.keywords.map((k) => k.term).join(', ')}` : ''].filter(Boolean).join('\n');
  };
  async function onAction(act) {
    if (act === 'add') { picker.click(); return; }
    if (act === 'clear') { reset(); return; }
    if (act === 'batch') { view = 'batch'; renderList(); renderDetail(); return; }
    if (act === 'batch-csv') { download('files-online-metadata.csv', toCsv(items), 'text/csv;charset=utf-8'); return; }
    if (act === 'batch-json') { download('files-online-metadata.json', toJson(items), 'application/json'); return; }
    const it = current();
    if (!it || !it.result) return;
    const name = baseName(it.file.name);
    root.querySelector('.fi-export')?.removeAttribute('open');
    if (act === 'copy-text') toast(await copyText(it.result.text || '') ? t('Text copied') : t('Copy failed'));
    else if (act === 'copy-summary') toast(await copyText(summaryText(it)) ? t('Summary copied') : t('Copy failed'));
    else if (act === 'copy-meta') toast(await copyText(JSON.stringify(tikaFields(it), null, 2)) ? t('Metadata copied') : t('Copy failed'));
    else if (act === 'dl-txt') download(`${name}.txt`, it.result.text || '', 'text/plain;charset=utf-8');
    else if (act === 'dl-json') download(`${name}.json`, toJson([it]), 'application/json');
    else if (act === 'dl-xhtml') download(`${name}.xhtml`, toXhtml(it), 'application/xhtml+xml');
    else if (act === 'dl-csv') download(`${name}.csv`, toCsv([it]), 'text/csv;charset=utf-8');
    else if (act === 'dl-json-rec' || act === 'scan-all') {
      toast(t('Inspecting embedded files…'));
      const all = await collectRecursive([it]);
      if (act === 'dl-json-rec') download(`${name}.json`, toJson(all), 'application/json');
      else { renderList(); renderDetail(); toast(t('Files inspected: {n}', { n: all.length - 1 })); }
    } else if (act === 'ocr') runOcr(it);
  }

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-id],[data-remove],[data-tab],[data-act]');
    if (!b) return;
    if (b.dataset.remove) { removeItem(+b.dataset.remove); return; }
    if (b.dataset.id) { selectedId = +b.dataset.id; view = 'file'; renderList(); renderDetail(); return; }
    if (b.dataset.tab) {
      activeTab = b.dataset.tab;
      root.querySelectorAll('.fi-tab').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.tab === activeTab)));
      renderPanel();
      return;
    }
    onAction(b.dataset.act);
  });
  picker.addEventListener('change', () => { addFiles(picker.files); picker.value = ''; });

  return { addFiles, items, get selected() { return current(); }, toJson: () => toJson(items), reset };
}

/** Read a dropped folder recursively. */
export async function filesFromDrop(dataTransfer, limit = 500) {
  const entries = Array.from(dataTransfer.items || []).map((i) => (i.kind === 'file' && i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
  if (!entries.some((x) => x.isDirectory)) return Array.from(dataTransfer.files);
  const files = [];
  const walk = async (en) => {
    if (files.length >= limit) return;
    if (en.isFile) {
      try { files.push(await new Promise((res, rej) => en.file(res, rej))); } catch (err) { /* unreadable file */ }
    } else if (en.isDirectory) {
      const reader = en.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej)).catch(() => []);
        for (const c of batch) await walk(c);
      } while (batch.length);
    }
  };
  for (const en of entries) await walk(en);
  return files;
}
