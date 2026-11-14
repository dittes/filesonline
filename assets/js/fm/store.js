// store.js
// The workspace: a virtual copy of the files you opened. Renaming, moving and
// removing happen here only; nothing on disk changes until you download or save.

import { extOf, kindOf, splitName } from './kinds.js';
import { collator } from './i18n.js';

/**
 * @typedef {Object} Item
 * @property {string} id
 * @property {File|Blob} file
 * @property {string} name
 * @property {string} dir       Folder path without slashes at the ends, '' for the top level
 * @property {number} size
 * @property {number} modified
 * @property {string} ext
 * @property {string} kind
 * @property {boolean} made     Created in this session (a result), not opened from disk
 */

export const S = {
  /** @type {Map<string, Item>} */
  items: new Map(),
  /** Every folder path that exists, including empty ones. */
  folders: new Set(),
  cwd: '',
  selection: new Set(),   // ids of files, and 'dir:<path>' for folders
  anchor: null,
  query: '',
  kind: null,
  sort: { key: 'name', dir: 1 },
  view: 'list',
  details: true,
};

const listeners = new Set();
let pending = new Set();
let scheduled = false;

/** Subscribe to changes. The callback receives the set of topics that changed. */
export function subscribe(fn) { listeners.add(fn); }

/** Topics: items, nav, selection, view */
export function emit(...topics) {
  topics.forEach(x => pending.add(x));
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    const now = pending;
    pending = new Set();
    listeners.forEach(fn => fn(now));
  });
}

let uid = 0;
const nextId = () => `f${++uid}`;

export const joinPath = (dir, name) => (dir ? `${dir}/${name}` : name);
export const parentOf = path => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
export const leafOf = path => path.slice(path.lastIndexOf('/') + 1);
export const cleanDir = dir => String(dir || '').replace(/\\/g, '/').split('/').map(s => s.trim()).filter(s => s && s !== '.' && s !== '..').join('/');
export const cleanName = name => String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'file';
export const isFolderKey = key => key.startsWith('dir:');
export const folderKey = path => `dir:${path}`;

function registerFolder(path) {
  while (path && !S.folders.has(path)) {
    S.folders.add(path);
    path = parentOf(path);
  }
}

function namesIn(dir) {
  const names = new Set();
  for (const it of S.items.values()) if (it.dir === dir) names.add(it.name.toLowerCase());
  for (const f of S.folders) if (parentOf(f) === dir) names.add(leafOf(f).toLowerCase());
  return names;
}

/** "report.pdf" → "report (2).pdf" when the name is taken. */
export function uniqueName(name, taken) {
  if (!taken.has(name.toLowerCase())) return name;
  const [stem, ext] = splitName(name);
  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * @param {{file:File|Blob, name?:string, dir?:string}[]} list
 * @param {{made?:boolean}} opt
 * @returns {Item[]}
 */
export function addFiles(list, { made = false } = {}) {
  const added = [];
  const takenByDir = new Map();
  for (const entry of list) {
    const name = cleanName(entry.name || entry.file.name);
    if (/^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(name)) continue;
    const dir = cleanDir(entry.dir);
    registerFolder(dir);
    if (!takenByDir.has(dir)) takenByDir.set(dir, namesIn(dir));
    const taken = takenByDir.get(dir);
    const finalName = uniqueName(name, taken);
    taken.add(finalName.toLowerCase());
    const item = {
      id: nextId(), file: entry.file, name: finalName, dir,
      size: entry.file.size, modified: entry.file.lastModified || Date.now(),
      ext: extOf(finalName), kind: kindOf(finalName, entry.file.type), made,
    };
    S.items.set(item.id, item);
    added.push(item);
  }
  if (added.length) emit('items');
  return added;
}

export function createFolder(parent, name) {
  const path = joinPath(parent, uniqueName(cleanName(name), namesIn(parent)));
  registerFolder(path);
  emit('items');
  return path;
}

const inFolder = (dir, folder) => dir === folder || dir.startsWith(`${folder}/`);

/** Files a selection stands for, with folders expanded to everything inside. */
export function expand(keys = S.selection) {
  const out = new Map();
  for (const key of keys) {
    if (isFolderKey(key)) {
      const folder = key.slice(4);
      for (const it of S.items.values()) if (inFolder(it.dir, folder)) out.set(it.id, it);
    } else if (S.items.has(key)) out.set(key, S.items.get(key));
  }
  return [...out.values()];
}

export function remove(keys) {
  for (const key of [...keys]) {
    if (isFolderKey(key)) {
      const folder = key.slice(4);
      for (const it of [...S.items.values()]) if (inFolder(it.dir, folder)) S.items.delete(it.id);
      for (const f of [...S.folders]) if (inFolder(f, folder)) S.folders.delete(f);
      if (inFolder(S.cwd, folder)) S.cwd = parentOf(folder);
    } else S.items.delete(key);
    S.selection.delete(key);
  }
  emit('items', 'selection', 'nav');
}

export function clearAll() {
  S.items.clear(); S.folders.clear(); S.selection.clear();
  S.cwd = ''; S.query = ''; S.kind = null; S.anchor = null;
  emit('items', 'selection', 'nav');
}

export function renameItem(id, name) {
  const item = S.items.get(id);
  if (!item) return;
  const taken = namesIn(item.dir);
  taken.delete(item.name.toLowerCase());
  item.name = uniqueName(cleanName(name), taken);
  item.ext = extOf(item.name);
  item.kind = kindOf(item.name, item.file.type);
  emit('items');
}

/** Put new content behind an existing entry (after editing or cleaning it). */
export function replaceFile(id, file) {
  const item = S.items.get(id);
  if (!item) return;
  item.file = file;
  item.size = file.size;
  item.modified = file.lastModified || Date.now();
  item.made = true;
  emit('items');
}

/** Rename many files at once. Names that would collide get a number. */
export function renameMany(pairs) {
  const moving = new Set(pairs.map(([id]) => id));
  const takenByDir = new Map();
  const takenIn = dir => {
    if (!takenByDir.has(dir)) {
      const taken = new Set();
      for (const it of S.items.values()) if (it.dir === dir && !moving.has(it.id)) taken.add(it.name.toLowerCase());
      for (const f of S.folders) if (parentOf(f) === dir) taken.add(leafOf(f).toLowerCase());
      takenByDir.set(dir, taken);
    }
    return takenByDir.get(dir);
  };
  for (const [id, name] of pairs) {
    const item = S.items.get(id);
    if (!item) continue;
    const taken = takenIn(item.dir);
    item.name = uniqueName(cleanName(name), taken);
    taken.add(item.name.toLowerCase());
    item.ext = extOf(item.name);
    item.kind = kindOf(item.name, item.file.type);
  }
  emit('items');
}

function relocateFolder(from, to) {
  if (from === to) return;
  for (const it of S.items.values()) if (inFolder(it.dir, from)) it.dir = to + it.dir.slice(from.length);
  for (const f of [...S.folders]) {
    if (!inFolder(f, from)) continue;
    S.folders.delete(f);
    S.folders.add(to + f.slice(from.length));
  }
  registerFolder(to);
  if (inFolder(S.cwd, from)) S.cwd = to + S.cwd.slice(from.length);
}

export function renameFolder(path, name) {
  const parent = parentOf(path);
  const taken = namesIn(parent);
  taken.delete(leafOf(path).toLowerCase());
  const to = joinPath(parent, uniqueName(cleanName(name), taken));
  relocateFolder(path, to);
  S.selection.clear();
  S.selection.add(folderKey(to));
  emit('items', 'selection', 'nav');
  return to;
}

/** Move files and folders into a folder. Returns how many moved. */
export function move(keys, target) {
  target = cleanDir(target);
  let moved = 0;
  const taken = namesIn(target);
  const next = new Set();
  for (const key of [...keys]) {
    if (isFolderKey(key)) {
      const from = key.slice(4);
      if (parentOf(from) === target || inFolder(target, from)) { next.add(key); continue; }
      const to = joinPath(target, uniqueName(leafOf(from), taken));
      taken.add(leafOf(to).toLowerCase());
      relocateFolder(from, to);
      next.add(folderKey(to));
      moved++;
    } else {
      const item = S.items.get(key);
      if (!item) continue;
      next.add(key);
      if (item.dir === target) continue;
      item.name = uniqueName(item.name, taken);
      taken.add(item.name.toLowerCase());
      item.dir = target;
      moved++;
    }
  }
  registerFolder(target);
  S.selection = next;
  if (moved) emit('items', 'selection', 'nav');
  return moved;
}

// ─── Reading ──────────────────────────────────────────────────────────────────

/** Number of files and total bytes below every folder, '' included. */
export function folderStats() {
  const stats = new Map([['', { count: 0, size: 0, modified: 0 }]]);
  for (const f of S.folders) stats.set(f, { count: 0, size: 0, modified: 0 });
  for (const it of S.items.values()) {
    let dir = it.dir;
    for (;;) {
      const s = stats.get(dir) || stats.set(dir, { count: 0, size: 0, modified: 0 }).get(dir);
      s.count++; s.size += it.size;
      if (it.modified > s.modified) s.modified = it.modified;
      if (!dir) break;
      dir = parentOf(dir);
    }
  }
  return stats;
}

export function kindStats() {
  const stats = new Map();
  for (const it of S.items.values()) {
    const s = stats.get(it.kind) || stats.set(it.kind, { count: 0, size: 0 }).get(it.kind);
    s.count++; s.size += it.size;
  }
  return stats;
}

export const isSearching = () => !!(S.query.trim() || S.kind);

/**
 * Rows to show: the folders and files of the current folder, or, while a
 * search or kind filter is active, the matching files from every folder.
 */
export function visibleRows(stats = folderStats()) {
  const { key, dir } = S.sort;
  const cmp = {
    name: (a, b) => collator.compare(a.name, b.name),
    size: (a, b) => a.size - b.size || collator.compare(a.name, b.name),
    modified: (a, b) => a.modified - b.modified || collator.compare(a.name, b.name),
    kind: (a, b) => collator.compare(a.kind + a.ext, b.kind + b.ext) || collator.compare(a.name, b.name),
  }[key];
  const sorted = list => list.sort((a, b) => cmp(a, b) * dir);

  if (isSearching()) {
    const words = S.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const files = [];
    for (const it of S.items.values()) {
      if (S.kind && it.kind !== S.kind) continue;
      const hay = `${it.dir}/${it.name}`.toLowerCase();
      if (words.every(w => hay.includes(w))) files.push(it);
    }
    return sorted(files);
  }

  const folders = [];
  for (const f of S.folders) {
    if (parentOf(f) !== S.cwd) continue;
    const s = stats.get(f) || { count: 0, size: 0, modified: 0 };
    folders.push({ isFolder: true, id: folderKey(f), path: f, name: leafOf(f), size: s.size, count: s.count, modified: s.modified, kind: 'folder', ext: '' });
  }
  const files = [];
  for (const it of S.items.values()) if (it.dir === S.cwd) files.push(it);
  return [...sorted(folders), ...sorted(files)];
}

export const rowKey = row => row.id;

export function selectedFiles() {
  return [...S.selection].filter(k => !isFolderKey(k)).map(k => S.items.get(k)).filter(Boolean);
}

export function navigate(dir) {
  S.cwd = S.folders.has(dir) ? dir : '';
  S.query = ''; S.kind = null;
  S.selection.clear(); S.anchor = null;
  emit('nav', 'selection');
}
