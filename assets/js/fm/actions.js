// actions.js
// Everything you can do with files: the built-in operations, and the hand-over
// to the other tools of this site (PDF tools, inspector, Markdown and MBOX viewer).

import { el, btn, dialog, prompt, confirm, task, toast, download, UserError, pause } from './dom.js';
import { t, fmtBytes, fmtNum, collator } from './i18n.js';
import { S, emit, addFiles, expand, remove, renameItem, renameFolder, createFolder, navigate, isFolderKey, joinPath, parentOf, leafOf, uniqueName, cleanDir } from './store.js';
import { splitName, isPdf, isArchive } from './kinds.js';
import { pickFiles, pickFolder } from './intake.js';
import * as dialogs from './dialogs.js';
import { sendTo } from '../handoff.js';

let routes = {};
let pages = {};
export function configure(r, p) { routes = r || {}; pages = p || {}; }

const pathOf = item => joinPath(item.dir, item.name);
const stemOf = name => splitName(name)[0];
const isPdfImage = item => /^(jpg|jpeg|png|webp|gif|bmp|avif|heic|heif|tif|tiff)$/.test(item.ext);
const isConvertible = item => /^(jpg|jpeg|png|webp|gif|bmp|avif|svg|ico)$/.test(item.ext);
const allOf = (files, test) => files.length > 0 && files.every(test);
const bytesOf = async file => new Uint8Array(await file.arrayBuffer());
const allFiles = () => [...S.items.values()];

/** The files an action applies to: the selection, with folders opened up. */
export const targets = () => expand(S.selection);

// ─── Adding ───────────────────────────────────────────────────────────────────

/** Add opened files to the current folder. */
export function intake(list, { made = false, into = S.cwd } = {}) {
  if (!list.length) return [];
  return addFiles(list.map(e => ({ file: e.file, name: e.name, dir: joinPath(into, cleanDir(e.dir)) })), { made });
}

export async function addFromPicker() { intake(await pickFiles()); }
export async function addFolderFromPicker() {
  const list = await task(t('Reading the folder…'), () => pickFolder());
  if (list) intake(list);
}

/** Put results into the workspace, select them and say so. */
export function addResults(list) {
  const added = addFiles(list, { made: true });
  if (!added.length) return added;
  S.query = ''; S.kind = null;
  if (added.every(it => it.dir !== S.cwd)) S.cwd = added[0].dir;
  S.selection = new Set(added.filter(it => it.dir === S.cwd).map(it => it.id));
  emit('nav', 'selection');
  toast(added.length === 1 ? t('Added to the workspace: {name}', { name: added[0].name }) : t('Files added to the workspace: {n}', { n: fmtNum(added.length) }),
    { kind: 'success', action: added.length === 1 ? t('Download') : null, onAction: () => download(added[0].file, added[0].name) });
  return added;
}

export async function newFolder() {
  const name = await prompt({ title: t('New folder'), label: t('Folder name'), value: t('New folder'), action: t('Create') });
  if (!name) return;
  const path = createFolder(S.cwd, name);
  S.selection = new Set([`dir:${path}`]);
  emit('selection');
}

// ─── Rename, remove ───────────────────────────────────────────────────────────

export async function rename() {
  const keys = [...S.selection];
  if (!keys.length) return;
  if (keys.length === 1 && isFolderKey(keys[0])) {
    const path = keys[0].slice(4);
    const name = await prompt({ title: t('Rename folder'), label: t('Folder name'), value: leafOf(path), action: t('Rename') });
    if (name && name !== leafOf(path)) renameFolder(path, name);
    return;
  }
  if (keys.length === 1) {
    const item = S.items.get(keys[0]);
    const name = await prompt({ title: t('Rename file'), label: t('File name'), value: item.name, action: t('Rename'), selectStem: true });
    if (name && name !== item.name) renameItem(item.id, name);
    return;
  }
  dialogs.renameDialog(targets());
}

export function renameAll() {
  const list = S.cwd ? allFiles().filter(it => it.dir === S.cwd || it.dir.startsWith(`${S.cwd}/`)) : allFiles();
  if (list.length) dialogs.renameDialog(list);
}

export function removeSelection() {
  const keys = [...S.selection];
  if (!keys.length) return;
  const files = expand(keys);
  const folders = [...S.folders];
  const cwd = S.cwd;
  remove(keys);
  toast(t('Removed from the workspace: {n}', { n: fmtNum(Math.max(files.length, keys.length)) }), {
    action: t('Undo'), ms: 7000,
    onAction: () => {
      folders.forEach(f => S.folders.add(f));
      files.forEach(it => S.items.set(it.id, it));
      S.cwd = cwd;
      emit('items', 'nav');
    },
  });
}

export async function clearWorkspace(onCleared) {
  if (!S.items.size && !S.folders.size) return onCleared();
  const ok = await confirm({ title: t('Close the workspace?'), message: t('The file list is cleared. Results you have not downloaded are lost. Your files on disk stay as they are.'), action: t('Close workspace'), danger: true });
  if (ok) onCleared();
}

// ─── Download, ZIP, save ──────────────────────────────────────────────────────

/** Folder that all paths are made relative to, so a ZIP keeps the structure you see. */
function baseFor(files) {
  if (files.every(it => it.dir === S.cwd || it.dir.startsWith(`${S.cwd}/`) || !S.cwd)) return S.cwd;
  let base = files[0].dir.split('/');
  for (const it of files) {
    const parts = it.dir.split('/');
    let i = 0;
    while (i < base.length && base[i] === parts[i]) i++;
    base = base.slice(0, i);
  }
  return base.join('/');
}
const relative = (path, base) => (base ? path.slice(base.length + 1) : path);

function zipName(keys, files) {
  if (keys.length === 1 && isFolderKey(keys[0])) return leafOf(keys[0].slice(4));
  if (files.length === 1) return stemOf(files[0].name);
  if (S.cwd) return leafOf(S.cwd);
  const tops = new Set([...S.folders].filter(f => !f.includes('/')));
  if (tops.size === 1 && files.every(it => it.dir)) return [...tops][0];
  return 'files-online';
}

export async function zip(keys = [...S.selection]) {
  const everything = !keys.length;
  const files = everything ? allFiles().filter(it => !S.cwd || it.dir === S.cwd || it.dir.startsWith(`${S.cwd}/`)) : expand(keys);
  const emptyFolders = everything ? [...S.folders] : keys.filter(isFolderKey).flatMap(k => [...S.folders].filter(f => f === k.slice(4) || f.startsWith(`${k.slice(4)}/`)));
  if (!files.length && !emptyFolders.length) return;

  const name = el('input.fm-input', { type: 'text', value: `${zipName(keys, files)}.zip`, spellcheck: false });
  const level = el('select.fm-input', [[6, t('Normal')], [1, t('Fast, larger file')], [9, t('Smallest file, slower')], [0, t('No compression')]].map(([v, label]) => el('option', { value: v }, label)));
  const total = files.reduce((sum, it) => sum + it.size, 0);
  const d = dialog({
    title: t('Create ZIP'), size: 's',
    body: el('div.fm-form',
      el('p.fm-dialog__text', t('Files: {n} · {size}', { n: fmtNum(files.length), size: fmtBytes(total) })),
      el('label.fm-field', el('span.fm-field__label', t('File name')), name),
      el('label.fm-field', el('span.fm-field__label', t('Compression')), level),
      total > 1.5e9 ? el('p.fm-field__hint', t('This is a lot of data. The ZIP is built in memory, so it may be too much for this browser.')) : null),
    footer: [btn(t('Cancel'), () => d.close(false)), btn(t('Create and download'), () => d.close(true), { variant: 'primary' })],
  });
  name.addEventListener('keydown', e => { if (e.key === 'Enter') d.close(true); });
  name.focus();
  name.setSelectionRange(0, name.value.length - 4);
  if (!await d.closed) return;

  const base = baseFor(files.length ? files : [{ dir: S.cwd }]);
  const fileName = (name.value.trim() || 'files-online.zip').replace(/(\.zip)?$/i, '.zip');
  const blob = await task(t('Creating ZIP…'), async (progress, signal) => {
    const { makeZip } = await import('./archive.js');
    return makeZip(files.map(it => ({ path: relative(pathOf(it), base), file: it.file, modified: it.modified })), {
      level: +level.value, onProgress: progress, signal,
      folders: emptyFolders.map(f => relative(f, base)).filter(Boolean),
    });
  });
  if (!blob) return;
  download(blob, fileName);
  toast(t('ZIP created: {name} · {size}', { name: fileName, size: fmtBytes(blob.size) }), { kind: 'success' });
}

export function downloadSelection() {
  const keys = [...S.selection];
  if (!keys.length) return;
  const files = expand(keys);
  if (!files.length) return;
  if (keys.every(k => !isFolderKey(k)) && files.length <= 3) {
    files.forEach((it, i) => setTimeout(() => download(it.file, it.name), i * 250));
    return;
  }
  zip(keys);
}

export const canSaveToFolder = 'showDirectoryPicker' in window;

export async function saveToFolder() {
  const keys = [...S.selection];
  const files = keys.length ? expand(keys) : allFiles();
  if (!files.length) return;
  let root;
  try { root = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch { return; }
  const base = baseFor(files);
  const ok = await confirm({
    title: t('Save to “{name}”?', { name: root.name }),
    message: t('Files to write: {n} · {size}. Files with the same name in that folder are replaced.', { n: fmtNum(files.length), size: fmtBytes(files.reduce((s, it) => s + it.size, 0)) }),
    action: t('Save'),
  });
  if (!ok) return;
  const done = await task(t('Saving files…'), async (progress, signal) => {
    const dirs = new Map([['', root]]);
    const dirFor = async path => {
      if (dirs.has(path)) return dirs.get(path);
      const handle = await (await dirFor(parentOf(path))).getDirectoryHandle(leafOf(path), { create: true });
      dirs.set(path, handle);
      return handle;
    };
    for (let i = 0; i < files.length; i++) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const it = files[i];
      const dir = await dirFor(relative(it.dir, base) || '');
      const handle = await dir.getFileHandle(it.name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(it.file);
      await writable.close();
      progress((i + 1) / files.length);
    }
    return true;
  });
  if (done) toast(t('Files saved to “{name}”: {n}', { name: root.name, n: fmtNum(files.length) }), { kind: 'success' });
}

// ─── Archives ─────────────────────────────────────────────────────────────────

export async function extractArchives(items = targets().filter(isArchive)) {
  if (!items.length) return;
  const added = await task(t('Extracting…'), async (progress) => {
    const { extract } = await import('./archive.js');
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      progress(i / items.length, t('Extracting {name}…', { name: it.name }));
      const entries = await extract(it.file, { onProgress: f => progress((i + f) / items.length) });
      if (!entries.length) throw new UserError(t('This archive is empty.'));
      const siblings = new Set([...S.folders].filter(f => parentOf(f) === it.dir).map(f => leafOf(f).toLowerCase()));
      const folder = joinPath(it.dir, uniqueName(stemOf(it.name).replace(/\.tar$/i, '') || 'archive', siblings));
      S.folders.add(folder);
      for (const e of entries) {
        const path = cleanDir(e.path);
        if (!path) continue;
        out.push({ file: new File([e.blob], leafOf(path), { lastModified: e.modified || it.modified }), dir: joinPath(folder, parentOf(path)), folder });
      }
      await pause();
    }
    return out;
  });
  if (!added?.length) return;
  const made = addFiles(added, { made: true });
  toast(t('Files extracted: {n}', { n: fmtNum(made.length) }), { kind: 'success' });
  if (items.length === 1) navigate(added[0].folder);
}

// ─── PDF work done right here ─────────────────────────────────────────────────

const pdfFile = (bytes, name) => new File([bytes], name, { type: 'application/pdf', lastModified: Date.now() });
const pdfTrouble = () => new UserError(t('One of these PDFs is password protected or damaged. Open it in the PDF tool instead.'));

export async function mergePdfs(items) {
  const sorted = [...items].sort((a, b) => collator.compare(pathOf(a), pathOf(b)));
  const bytes = await task(t('Merging PDFs…'), async progress => {
    const ops = await import('../pdf/ops.js');
    const parts = [];
    for (const it of sorted) parts.push({ bytes: await bytesOf(it.file) });
    try { return await ops.assemble(parts, { onProgress: progress }); } catch { throw pdfTrouble(); }
  });
  if (bytes) addResults([{ file: pdfFile(bytes, `${stemOf(sorted[0].name)}-merged.pdf`), dir: sorted[0].dir }]);
}

export async function compressPdfs(items) {
  let saved = 0;
  const results = await task(t('Compressing…'), async (progress, signal) => {
    const ops = await import('../pdf/ops.js');
    const out = [];
    for (let i = 0; i < items.length; i++) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const it = items[i];
      const input = await bytesOf(it.file);
      let bytes;
      try { bytes = await ops.compress(input, { level: 'medium', onProgress: f => progress((i + f) / items.length) }); } catch { throw pdfTrouble(); }
      if (bytes.length < input.length) {
        saved += input.length - bytes.length;
        out.push({ file: pdfFile(bytes, `${stemOf(it.name)}-compressed.pdf`), dir: it.dir });
      }
    }
    return out;
  });
  if (!results) return;
  if (!results.length) return toast(t('Already as small as it gets. Nothing was changed.'));
  addResults(results);
  toast(t('Saved {size} by compressing.', { size: fmtBytes(saved) }), { kind: 'success' });
}

export async function imagesToPdf(items) {
  const sorted = [...items].sort((a, b) => collator.compare(pathOf(a), pathOf(b)));
  const bytes = await task(t('Building the PDF…'), async progress => {
    const ops = await import('../pdf/ops.js');
    const images = [];
    for (const it of sorted) {
      try { images.push(await ops.normalizeImage(it.file)); } catch { throw new UserError(t('“{name}” could not be read as an image.', { name: it.name })); }
    }
    return ops.imagesToPdf(images, { size: 'fit', orientation: 'auto', margin: 0 }, progress);
  });
  if (bytes) addResults([{ file: pdfFile(bytes, `${stemOf(sorted[0].name)}.pdf`), dir: sorted[0].dir }]);
}

export async function pdfToText(items) {
  const results = await task(t('Reading the text…'), async progress => {
    const ops = await import('../pdf/ops.js');
    const out = [];
    for (let i = 0; i < items.length; i++) {
      let text;
      try { text = await ops.pdfToText(await bytesOf(items[i].file), f => progress((i + f) / items.length)); } catch { throw pdfTrouble(); }
      out.push({ file: new File([text], `${stemOf(items[i].name)}.txt`, { type: 'text/plain', lastModified: Date.now() }), dir: items[i].dir });
    }
    return out;
  });
  if (results) addResults(results);
}

// ─── Other tools of this site ─────────────────────────────────────────────────

/** Open another tool in a new tab and hand it the files. */
export function openWith(url, items) {
  const total = items.reduce((sum, it) => sum + it.size, 0);
  if (total > 1.2e9) return toast(t('These files are too large to hand over. Open the tool and choose them there.'), { kind: 'error' });
  sendTo(url, items.map(it => ({ name: it.name, blob: it.file })))
    .catch(() => toast(t('The files could not be handed over. Open the tool and choose them there.'), { kind: 'error' }));
}

const toolEntry = (id, items, extra = {}) => (routes[id]
  ? { label: routes[id].name, ico: 'pdf', external: true, run: () => openWith(routes[id].url, items), ...extra }
  : null);
const pageEntry = (key, items, extra = {}) => (pages[key]
  ? { label: pages[key].name, external: true, run: () => openWith(pages[key].url, items), ...extra }
  : null);

/**
 * What fits the given files.
 * `here` runs inside the workspace and adds its result to it; `tools` open another tool with the files.
 */
export function suggestions(items) {
  const here = [];
  const tools = [];
  const n = items.length;
  if (!n) return { here, tools };

  if (allOf(items, isPdf)) {
    if (n >= 2) here.push({ label: t('Merge into one PDF'), ico: 'layers', run: () => mergePdfs(items) });
    here.push({ label: t('Compress'), ico: 'shrink', run: () => compressPdfs(items) });
    here.push({ label: t('Extract the text'), ico: 'files', run: () => pdfToText(items) });
    const ids = n === 1
      ? ['edit', 'sign', 'split', 'organize', 'ocr', 'pdf-to-word', 'pdf-to-jpg', 'protect']
      : n === 2 ? ['compare', 'merge', 'organize', 'alternate'] : ['merge', 'organize'];
    ids.forEach(id => tools.push(toolEntry(id, id === 'merge' || id === 'organize' || id === 'compare' || id === 'alternate' ? items : items.slice(0, 1))));
  }

  if (allOf(items, isPdfImage)) {
    here.push({ label: n > 1 ? t('Combine into one PDF') : t('Turn into a PDF'), ico: 'layers', run: () => imagesToPdf(items) });
    tools.push(toolEntry(items.every(it => it.ext === 'png') ? 'png-to-pdf' : 'jpg-to-pdf', items));
  }
  if (allOf(items, isConvertible)) here.push({ label: t('Convert or resize'), ico: 'image', run: () => dialogs.convertDialog(items, addResults) });

  if (allOf(items, isArchive)) here.push({ label: t('Extract here'), ico: 'unzip', run: () => extractArchives(items) });

  if (n === 1 && /^(md|markdown)$/.test(items[0].ext)) tools.push(pageEntry('md', items, { ico: 'md' }));
  if (n === 1 && items[0].ext === 'mbox') tools.push(pageEntry('mbox', items, { ico: 'mail' }));
  if (n <= 30) tools.push(pageEntry('inspector', items, { ico: 'inspect', hint: t('Metadata, text, hidden data') }));

  return { here: here.filter(Boolean), tools: tools.filter(Boolean) };
}

/** Every PDF tool, for the palette. Files are handed over when they fit the tool. */
export function allToolCommands(items) {
  const pdfs = items.filter(isPdf);
  const images = items.filter(isPdfImage);
  const out = [];
  for (const [id, route] of Object.entries(routes)) {
    const wantsImages = /^(jpg|png)-to-pdf$/.test(id);
    const fitting = wantsImages ? images : pdfs;
    const multi = wantsImages || /^(merge|organize|compare|alternate)$/.test(id);
    const send = fitting.length && fitting.length === items.length ? (multi ? fitting : fitting.slice(0, 1)) : [];
    out.push({
      label: route.name, group: t('PDF tools'), ico: 'pdf', external: true,
      hint: send.length ? (send.length === 1 ? send[0].name : t('Files: {n}', { n: send.length })) : '',
      run: () => (send.length ? openWith(route.url, send) : window.open(route.url, '_blank')),
    });
  }
  for (const key of ['inspector', 'md', 'mbox', 'pdfTools']) {
    if (pages[key]) out.push({ label: pages[key].name, group: t('More tools'), ico: key === 'inspector' ? 'inspect' : key === 'md' ? 'md' : key === 'mbox' ? 'mail' : 'pdf', external: true, run: () => window.open(pages[key].url, '_blank') });
  }
  return out;
}

export function openToolPalette() {
  dialogs.palette(allToolCommands(targets()), { placeholder: t('Search all tools'), title: t('All tools') });
}

// ─── Workspace-wide helpers ───────────────────────────────────────────────────

const scope = () => {
  const selected = targets();
  return selected.length > 1 ? selected : allFiles();
};

export const findDuplicates = () => {
  const list = scope();
  if (list.length < 2) return toast(t('Add at least two files to compare.'));
  dialogs.duplicatesDialog(list);
};
export const checksums = () => {
  const list = targets();
  if (!list.length) return toast(t('Select the files you want checksums for.'));
  if (list.length > 500) return toast(t('Select at most 500 files for checksums.'));
  dialogs.checksumDialog(list);
};
export const exportList = () => {
  const selected = targets();
  const list = selected.length ? selected : allFiles();
  if (list.length) dialogs.exportListDialog(list);
};
export const convertImages = () => {
  const selected = targets();
  const list = (selected.length ? selected : allFiles().filter(it => it.dir === S.cwd)).filter(isConvertible);
  if (!list.length) return toast(t('There are no images here to convert.'));
  dialogs.convertDialog(list, addResults);
};
