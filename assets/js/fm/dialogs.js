// dialogs.js
// The larger dialogs: batch rename, move, duplicates, image conversion, checksums,
// file list export, Quick Look and the command palette.

import { el, btn, icon, iconBtn, dialog, prompt, task, toast, download, copyText, pause, UserError, fill } from './dom.js';
import { t, fmtBytes, fmtNum, collator } from './i18n.js';
import { S, emit, renameMany, move, remove, joinPath, leafOf, createFolder } from './store.js';
import { splitName, iconHtml } from './kinds.js';
import { renderPreview } from './preview.js';

const field = (label, control, hint) => el('label.fm-field', el('span.fm-field__label', label), control, hint ? el('span.fm-field__hint', hint) : null);
const input = (props = {}) => el('input.fm-input', { type: 'text', autocomplete: 'off', spellcheck: false, ...props });
const select = (options, value, props = {}) => el('select.fm-input', props, options.map(([v, label]) => el('option', { value: v, selected: v === value }, label)));
const check = (label, checked = false) => {
  const box = el('input', { type: 'checkbox', checked });
  const node = el('label.fm-opt', box, el('span', label));
  Object.defineProperty(node, 'checked', { get: () => box.checked });
  return node;
};
const pathOf = item => joinPath(item.dir, item.name);

// ─── Batch rename ─────────────────────────────────────────────────────────────

const CASES = {
  keep: s => s,
  lower: s => s.toLowerCase(),
  upper: s => s.toUpperCase(),
  title: s => s.toLowerCase().replace(/(^|[\s_\-.])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()),
  kebab: s => s.trim().replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1-$2').replace(/[\s_.]+/g, '-').replace(/-+/g, '-').toLowerCase(),
  snake: s => s.trim().replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1_$2').replace(/[\s\-.]+/g, '_').replace(/_+/g, '_').toLowerCase(),
};

export function renameDialog(items) {
  const find = input({ placeholder: t('Text to find') });
  const replace = input({ placeholder: t('Replace with') });
  const regex = check(t('Regular expression'));
  const before = input();
  const after = input();
  const letterCase = select([['keep', t('Keep as it is')], ['lower', t('lowercase')], ['upper', t('UPPERCASE')], ['title', t('Title Case')], ['kebab', 'kebab-case'], ['snake', 'snake_case']], 'keep');
  const numbering = select([['none', t('No numbering')], ['prefix', t('Number first')], ['suffix', t('Number last')], ['only', t('Number replaces the name')]], 'none');
  const start = input({ type: 'number', value: 1, min: 0 });
  const digits = input({ type: 'number', value: 2, min: 1, max: 8 });
  const date = check(t('Start with the date the file was changed'));
  const extCase = select([['keep', t('Keep as it is')], ['lower', t('lowercase')], ['upper', t('UPPERCASE')]], 'keep');
  const error = el('p.fm-error', { hidden: true, role: 'alert' });
  const list = el('ol.fm-rename__list');
  const summary = el('p.fm-rename__summary');

  const sorted = [...items].sort((a, b) => collator.compare(pathOf(a), pathOf(b)));

  function compute() {
    let pattern = null;
    error.hidden = true;
    if (find.value) {
      try {
        pattern = regex.checked ? new RegExp(find.value, 'gu') : null;
      } catch {
        error.textContent = t('This regular expression is not valid.');
        error.hidden = false;
      }
    }
    return sorted.map((item, i) => {
      let [stem, ext] = splitName(item.name);
      if (find.value) stem = pattern ? stem.replace(pattern, replace.value) : stem.split(find.value).join(replace.value);
      stem = CASES[letterCase.value](stem);
      stem = before.value + stem + after.value;
      const n = String((+start.value || 0) + i).padStart(Math.min(8, Math.max(1, +digits.value || 1)), '0');
      if (numbering.value === 'prefix') stem = `${n} ${stem}`;
      else if (numbering.value === 'suffix') stem = `${stem} ${n}`;
      else if (numbering.value === 'only') stem = `${before.value}${n}${after.value}`;
      if (date.checked) stem = `${new Date(item.modified).toISOString().slice(0, 10)} ${stem}`;
      if (extCase.value !== 'keep') ext = CASES[extCase.value](ext);
      return [item, (stem.trim() || item.name) + ext];
    });
  }

  function render() {
    const pairs = compute();
    const changed = pairs.filter(([item, name]) => item.name !== name);
    summary.textContent = t('Files that get a new name: {n} of {total}', { n: fmtNum(changed.length), total: fmtNum(pairs.length) });
    fill(list, ...pairs.slice(0, 200).map(([item, name]) => el(`li${item.name === name ? '.is-same' : ''}`,
      el('span.fm-rename__old', item.name), icon('chevron'), el('span.fm-rename__new', name))));
    apply.disabled = !changed.length;
    numberRow.hidden = numbering.value === 'none';
    return changed;
  }

  const numberRow = el('div.fm-form__row', field(t('Start at'), start), field(t('Digits'), digits));
  const apply = btn(t('Rename'), () => {
    const changed = render();
    renameMany(changed.map(([item, name]) => [item.id, name]));
    d.close();
    toast(t('Renamed: {n}', { n: fmtNum(changed.length) }));
  }, { variant: 'primary' });

  const d = dialog({
    title: t('Rename files'), size: 'l',
    body: el('div.fm-rename',
      el('div.fm-form',
        el('div.fm-form__row', field(t('Find'), find), field(t('Replace with'), replace)),
        regex,
        el('div.fm-form__row', field(t('Add before the name'), before), field(t('Add after the name'), after)),
        el('div.fm-form__row', field(t('Letter case'), letterCase), field(t('Extension'), extCase)),
        field(t('Numbering'), numbering),
        numberRow,
        date,
        error),
      el('div.fm-rename__preview', summary, list)),
    footer: [btn(t('Cancel'), () => d.close()), apply],
  });
  d.body.addEventListener('input', render);
  render();
  find.focus();
}

// ─── Move ─────────────────────────────────────────────────────────────────────

export function moveDialog(keys) {
  const folders = ['', ...[...S.folders].sort(collator.compare)];
  const moving = new Set([...keys].filter(k => k.startsWith('dir:')).map(k => k.slice(4)));
  const blocked = path => [...moving].some(m => path === m || path.startsWith(`${m}/`));
  const go = target => {
    const n = move(keys, target);
    d.close();
    if (n) toast(t('Moved: {n}', { n: fmtNum(n) }));
  };
  const d = dialog({
    title: t('Move to folder'), size: 's',
    body: el('ul.fm-folderpick', folders.map(path => el('li', el('button', {
      type: 'button', disabled: blocked(path),
      style: { paddingLeft: `${12 + (path ? path.split('/').length : 0) * 16}px` },
      onclick: () => go(path),
    }, el('span', { html: iconHtml({ isFolder: true }) }), el('span', path ? leafOf(path) : t('Workspace')))))),
    footer: [
      btn(t('New folder…'), async () => {
        const name = await prompt({ title: t('New folder'), label: t('Folder name'), value: t('New folder'), action: t('Create and move') });
        if (name) go(createFolder(S.cwd, name));
      }, { ico: 'folderPlus' }),
      btn(t('Cancel'), () => d.close()),
    ],
  });
}

// ─── Duplicates ───────────────────────────────────────────────────────────────

const hex = buffer => Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');

export async function hashFile(file, algo = 'SHA-256') {
  if (algo === 'MD5') {
    const { default: U } = await import('../inspect/util.js');
    return U.md5(new Uint8Array(await file.arrayBuffer()));
  }
  return hex(await crypto.subtle.digest(algo, await file.arrayBuffer()));
}

export async function duplicatesDialog(items) {
  const groups = await task(t('Comparing files…'), async (progress, signal) => {
    const bySize = new Map();
    for (const it of items) if (it.size > 0) (bySize.get(it.size) || bySize.set(it.size, []).get(it.size)).push(it);
    const candidates = [...bySize.values()].filter(g => g.length > 1).flat();
    const byHash = new Map();
    let done = 0;
    for (const it of candidates) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const key = `${it.size}:${await hashFile(it.file)}`;
      (byHash.get(key) || byHash.set(key, []).get(key)).push(it);
      progress(++done / candidates.length);
    }
    return [...byHash.values()].filter(g => g.length > 1)
      .map(g => g.sort((a, b) => a.modified - b.modified || collator.compare(pathOf(a), pathOf(b))))
      .sort((a, b) => b[0].size * (b.length - 1) - a[0].size * (a.length - 1));
  });
  if (!groups) return;

  if (!groups.length) {
    const d = dialog({ title: t('Duplicate files'), size: 's',
      body: el('div.fm-blank', icon('check', 'fm-i fm-blank__icon'), el('p', t('No duplicates. Every file here has different content.'))),
      footer: [btn(t('Close'), () => d.close(), { variant: 'primary' })] });
    return;
  }

  const extras = groups.flatMap(g => g.slice(1));
  const wasted = extras.reduce((sum, it) => sum + it.size, 0);
  const d = dialog({
    title: t('Duplicate files'), size: 'l',
    body: [
      el('div.fm-statrow',
        el('div', el('strong', fmtNum(groups.length)), el('span', t('Groups of identical files'))),
        el('div', el('strong', fmtNum(extras.length)), el('span', t('Extra copies'))),
        el('div', el('strong', fmtBytes(wasted)), el('span', t('Space they take up')))),
      el('p.fm-dialog__text', t('Files are compared by content (SHA-256), not by name. The oldest file of each group counts as the original.')),
      el('div.fm-dupes', groups.slice(0, 100).map(g => el('section.fm-dupes__group',
        el('header', el('span', t('Copies: {n}', { n: g.length })), el('span', fmtBytes(g[0].size))),
        el('ul', g.map((it, i) => el('li', el('span', { html: iconHtml(it) }), el('span.fm-dupes__path', pathOf(it)),
          el(`span.fm-tag${i ? '.fm-tag--warn' : ''}`, i ? t('Copy') : t('Original')))))))),
    ],
    footer: [
      btn(t('Export list (CSV)'), () => {
        const rows = [['group', 'role', 'path', 'bytes']];
        groups.forEach((g, gi) => g.forEach((it, i) => rows.push([gi + 1, i ? 'copy' : 'original', pathOf(it), it.size])));
        download(new Blob([toCsv(rows)], { type: 'text/csv' }), 'duplicates.csv');
      }, { ico: 'table' }),
      btn(t('Select the copies'), () => {
        S.query = ''; S.kind = null;
        S.selection = new Set(extras.map(it => it.id));
        d.close();
        emit('nav', 'selection');
        toast(t('Selected: {n}', { n: fmtNum(extras.length) }));
      }),
      btn(t('Remove the copies from the workspace'), () => {
        remove(extras.map(it => it.id));
        d.close();
        toast(t('Removed: {n}. Your files on disk are untouched.', { n: fmtNum(extras.length) }));
      }, { variant: 'primary' }),
    ],
  });
}

// ─── Convert images ───────────────────────────────────────────────────────────

const IMAGE_TYPES = { jpg: ['image/jpeg', 'JPG'], png: ['image/png', 'PNG'], webp: ['image/webp', 'WebP'] };

async function convertOne(file, { format, quality, maxEdge }) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = maxEdge ? Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height)) : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (format === 'jpg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise(resolve => canvas.toBlob(resolve, IMAGE_TYPES[format][0], quality));
  if (!blob) throw new UserError(t('This browser cannot write that image format.'));
  return blob;
}

export function convertDialog(items, onDone) {
  const format = select(Object.entries(IMAGE_TYPES).map(([v, [, label]]) => [v, label]), 'jpg');
  const quality = el('input.fm-range', { type: 'range', min: 30, max: 100, value: 85 });
  const qualityOut = el('output', '85');
  const maxEdge = input({ type: 'number', min: 16, max: 20000, placeholder: t('Original size') });
  const qualityField = field(t('Quality'), el('div.fm-rangewrap', quality, qualityOut));
  const sync = () => { qualityOut.textContent = quality.value; qualityField.hidden = format.value === 'png'; };
  const d = dialog({
    title: t('Convert images'), size: 's',
    body: el('div.fm-form',
      el('p.fm-dialog__text', t('Images to convert: {n}', { n: fmtNum(items.length) })),
      field(t('Format'), format),
      qualityField,
      field(t('Longest side in pixels'), maxEdge, t('Leave empty to keep the size. Larger images are scaled down.')),
      el('p.fm-field__hint', t('Converted images carry no EXIF data such as location or camera.'))),
    footer: [btn(t('Cancel'), () => d.close()), btn(t('Convert'), run, { variant: 'primary' })],
  });
  d.body.addEventListener('input', sync);
  sync();

  async function run() {
    const opt = { format: format.value, quality: +quality.value / 100, maxEdge: +maxEdge.value || 0 };
    d.close();
    let failed = 0;
    const results = await task(t('Converting images…'), async (progress, signal) => {
      const out = [];
      for (let i = 0; i < items.length; i++) {
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        const it = items[i];
        try {
          const blob = await convertOne(it.file, opt);
          out.push({ file: new File([blob], `${splitName(it.name)[0]}.${opt.format}`, { type: blob.type, lastModified: Date.now() }), dir: it.dir });
        } catch (err) { if (err instanceof UserError) throw err; failed++; }
        progress((i + 1) / items.length);
        await pause();
      }
      return out;
    });
    if (!results) return;
    if (failed) toast(t('Could not be read as images: {n}', { n: fmtNum(failed) }), { kind: 'error' });
    if (results.length) onDone(results);
  }
}

// ─── Checksums ────────────────────────────────────────────────────────────────

export function checksumDialog(items) {
  const algo = select([['SHA-256', 'SHA-256'], ['SHA-1', 'SHA-1'], ['SHA-512', 'SHA-512'], ['MD5', 'MD5']], 'SHA-256');
  const expected = input({ placeholder: t('Paste a checksum to compare') });
  const list = el('ul.fm-sums');
  const verdict = el('p.fm-sums__verdict', { hidden: true });
  let sums = [];
  let run = 0;

  const mark = () => {
    const want = expected.value.trim().toLowerCase().replace(/^.*[:=]\s*/, '').split(/\s+/)[0] || '';
    let hit = false;
    list.querySelectorAll('li').forEach((li, i) => {
      const match = !!want && sums[i]?.sum === want;
      li.classList.toggle('is-match', match);
      hit ||= match;
    });
    verdict.hidden = !want || sums.length !== items.length;
    verdict.className = `fm-sums__verdict ${hit ? 'is-ok' : 'is-bad'}`;
    verdict.textContent = hit ? t('Match. The file is exactly what the checksum describes.') : t('No file here has this checksum.');
  };

  const compute = async () => {
    const mine = ++run;
    sums = [];
    fill(list, el('li.fm-sums__wait', t('Computing…')));
    for (const it of items) {
      const sum = await hashFile(it.file, algo.value);
      if (mine !== run || !list.isConnected) return;
      sums.push({ item: it, sum });
      if (sums.length === 1) fill(list);
      list.append(el('li', el('span.fm-sums__name', pathOf(it)), el('code', sum), iconBtn('copy', t('Copy'), () => copyText(sum))));
      mark();
    }
  };
  const text = () => sums.map(s => `${s.sum}  ${pathOf(s.item)}`).join('\n') + '\n';

  const d = dialog({
    title: t('Checksums'), size: 'l',
    body: [el('div.fm-form__row', field(t('Algorithm'), algo), field(t('Compare with'), expected)), verdict, list],
    footer: [
      btn(t('Copy all'), () => copyText(text()), { ico: 'copy' }),
      btn(t('Download as text file'), () => download(new Blob([text()], { type: 'text/plain' }), `checksums.${algo.value.toLowerCase().replace('-', '')}`), { ico: 'download' }),
      btn(t('Close'), () => d.close(), { variant: 'primary' }),
    ],
  });
  algo.addEventListener('change', compute);
  expected.addEventListener('input', mark);
  compute();
}

// ─── File list export ─────────────────────────────────────────────────────────

const csvCell = v => (/[",\n;]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
export const toCsv = rows => `﻿${rows.map(r => r.map(csvCell).join(',')).join('\r\n')}\r\n`;

export function exportListDialog(items) {
  const format = select([['csv', 'CSV'], ['json', 'JSON'], ['txt', t('Plain list of paths')]], 'csv');
  const withHash = check(t('Include SHA-256 checksums'));
  const d = dialog({
    title: t('Export file list'), size: 's',
    body: el('div.fm-form',
      el('p.fm-dialog__text', t('Files in the list: {n}', { n: fmtNum(items.length) })),
      field(t('Format'), format), withHash),
    footer: [btn(t('Cancel'), () => d.close()), btn(t('Export'), run, { variant: 'primary' })],
  });

  async function run() {
    const fmt = format.value, hash = withHash.checked;
    d.close();
    const sorted = [...items].sort((a, b) => collator.compare(pathOf(a), pathOf(b)));
    const rows = await task(t('Building the list…'), async (progress, signal) => {
      const out = [];
      for (let i = 0; i < sorted.length; i++) {
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        const it = sorted[i];
        const row = { path: pathOf(it), name: it.name, folder: it.dir, extension: it.ext, kind: it.kind, bytes: it.size, modified: new Date(it.modified).toISOString() };
        if (hash) { row.sha256 = await hashFile(it.file); progress((i + 1) / sorted.length); }
        out.push(row);
      }
      return out;
    });
    if (!rows) return;
    if (fmt === 'json') download(new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' }), 'file-list.json');
    else if (fmt === 'txt') download(new Blob([rows.map(r => r.path).join('\n') + '\n'], { type: 'text/plain' }), 'file-list.txt');
    else download(new Blob([toCsv([Object.keys(rows[0] || { path: '' }), ...rows.map(r => Object.values(r))])], { type: 'text/csv' }), 'file-list.csv');
  }
}

// ─── Quick Look ───────────────────────────────────────────────────────────────

export function quickLook(items, index, { actions } = {}) {
  let i = index;
  const stage = el('div.fm-ql__stage');
  const title = el('h2');
  const meta = el('span.fm-ql__meta');
  const counter = el('span.fm-ql__count');
  const tools = el('div.fm-ql__tools');
  const node = el('dialog.fm-dialog.fm-ql', { 'aria-label': t('Quick Look') },
    el('header.fm-dialog__head', el('div.fm-ql__title', title, meta), tools, counter,
      iconBtn('back', t('Previous'), () => show(i - 1), { className: 'fm-iconbtn fm-ql__prev' }),
      iconBtn('chevron', t('Next'), () => show(i + 1), { className: 'fm-iconbtn fm-ql__next' }),
      iconBtn('x', t('Close'), () => node.close())),
    stage);

  function show(next) {
    i = (next + items.length) % items.length;
    const item = items[i];
    title.textContent = item.name;
    meta.textContent = fmtBytes(item.size);
    counter.textContent = items.length > 1 ? `${i + 1} / ${items.length}` : '';
    fill(tools, ...(actions ? actions(item, () => node.close()) : []));
    renderPreview(item, stage, { full: true });
  }
  node.addEventListener('keydown', e => {
    if (e.target.closest('video, audio, input, pre')) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); show(i + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); show(i - 1); }
    else if (e.key === ' ') { e.preventDefault(); node.close(); }
  });
  node.addEventListener('close', () => { fill(stage); node.remove(); });
  node.addEventListener('mousedown', e => { if (e.target === node) node.close(); });
  document.body.append(node);
  node.showModal();
  node.classList.toggle('is-single', items.length < 2);
  show(i);
}

// ─── Command palette ──────────────────────────────────────────────────────────

/**
 * @param {{label:string, group:string, ico?:string, hint?:string, kbd?:string, external?:boolean, run:Function}[]} commands
 * @param {{placeholder?:string, title?:string}} opt
 */
export function palette(commands, { placeholder, title } = {}) {
  const search = el('input.fm-palette__input', { type: 'text', placeholder: placeholder || t('Type a command, a tool or a file name'), autocomplete: 'off', spellcheck: false, 'aria-label': title || t('Commands') });
  const list = el('div.fm-palette__list', { role: 'listbox' });
  const node = el('dialog.fm-dialog.fm-palette', { 'aria-label': title || t('Commands') },
    el('div.fm-palette__head', icon('search'), search, el('kbd', 'Esc')), list);
  let shown = [], active = 0;

  const score = (cmd, words) => {
    const hay = `${cmd.label} ${cmd.hint || ''} ${cmd.group}`.toLowerCase();
    if (!words.every(w => hay.includes(w))) return -1;
    const label = cmd.label.toLowerCase();
    return (label.startsWith(words[0] || '') ? 2 : 0) + (label.includes(words[0] || '') ? 1 : 0);
  };

  function render() {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    shown = commands.map((cmd, order) => ({ cmd, order, s: score(cmd, words) })).filter(x => x.s >= 0)
      .sort((a, b) => (words.length ? b.s - a.s : 0) || a.order - b.order).slice(0, 60).map(x => x.cmd);
    active = Math.min(active, Math.max(0, shown.length - 1));
    let group = null;
    fill(list, ...(shown.length ? shown.flatMap((cmd, n) => {
      const out = [];
      if (!words.length && cmd.group !== group) { group = cmd.group; out.push(el('div.fm-palette__group', group)); }
      out.push(el(`button.fm-palette__item${n === active ? '.is-active' : ''}`, { type: 'button', role: 'option', 'aria-selected': n === active, dataset: { n }, onclick: () => run(n), onmousemove: () => setActive(n) },
        icon(cmd.ico || 'files'), el('span.fm-palette__label', cmd.label),
        cmd.hint ? el('span.fm-palette__hint', cmd.hint) : null,
        cmd.external ? icon('external', 'fm-i fm-menu__ext') : null,
        cmd.kbd ? el('kbd', cmd.kbd) : null));
      return out;
    }) : [el('p.fm-palette__none', t('Nothing found.'))]));
  }
  function setActive(n) {
    if (n === active) return;
    active = n;
    list.querySelectorAll('.fm-palette__item').forEach(b => {
      const on = +b.dataset.n === active;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on);
      if (on) b.scrollIntoView({ block: 'nearest' });
    });
  }
  function run(n) {
    const cmd = shown[n];
    if (!cmd) return;
    node.close();
    cmd.run();
  }
  search.addEventListener('input', () => { active = 0; render(); });
  node.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((active + 1) % Math.max(1, shown.length)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((active - 1 + shown.length) % Math.max(1, shown.length)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(active); }
  });
  node.addEventListener('close', () => node.remove());
  node.addEventListener('mousedown', e => { if (e.target === node) node.close(); });
  document.body.append(node);
  node.showModal();
  render();
  search.focus();
}

// ─── Shortcuts ────────────────────────────────────────────────────────────────

export function shortcutsDialog(mod) {
  const rows = [
    [`${mod} K`, t('Open the command palette')],
    ['/', t('Search')],
    ['Space', t('Quick Look')],
    ['Enter', t('Open a folder or preview a file')],
    ['Backspace', t('Go up one folder')],
    ['↑ ↓', t('Move through the list, with Shift to select')],
    [`${mod} A`, t('Select everything')],
    ['F2', t('Rename')],
    ['Del', t('Remove from the workspace')],
    ['Esc', t('Clear the selection')],
    [`${mod} V`, t('Paste files or screenshots')],
  ];
  const d = dialog({
    title: t('Keyboard shortcuts'), size: 's',
    body: el('dl.fm-keys', rows.flatMap(([k, label]) => [el('dt', el('kbd', k)), el('dd', label)])),
    footer: [btn(t('Close'), () => d.close(), { variant: 'primary' })],
  });
}

