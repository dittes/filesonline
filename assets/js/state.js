// Central application state with pub/sub event system

import { getExtension, getMimeCategory, generateId } from './utils.js';

/**
 * @typedef {Object} FileEntry
 * @property {string}  id
 * @property {File}    file
 * @property {string}  name
 * @property {string}  ext
 * @property {number}  size
 * @property {string}  type           MIME type
 * @property {string}  category       getMimeCategory result
 * @property {Date}    modified
 * @property {string}  path           full relative path string
 * @property {string}  relativePath   same as path (kept for clarity)
 */

/**
 * @typedef {Object} Filters
 * @property {string} search
 * @property {string} category
 * @property {string} sort     'name' | 'size' | 'modified' | 'type' | 'ext'
 * @property {string} order    'asc' | 'desc'
 */

/** @type {EventTarget} */
export const bus = new EventTarget();

/**
 * Dispatch a named custom event on the bus.
 * @param {string} eventName
 * @param {*} detail
 */
export function emit(eventName, detail) {
  bus.dispatchEvent(new CustomEvent(eventName, { detail }));
}

/**
 * Listen for a named event on the bus.
 * @param {string} eventName
 * @param {function} handler  receives (detail)
 */
export function on(eventName, handler) {
  bus.addEventListener(eventName, e => handler(e.detail));
}

/**
 * Remove a listener from the bus.
 * The handler reference must be the same wrapper used in on().
 * Because on() wraps the handler, callers who need to remove listeners
 * should use bus.addEventListener / bus.removeEventListener directly,
 * or use the returned unsubscribe function from on2() below.
 * This off() accepts the original handler and removes any wrapper created for it.
 * @param {string} eventName
 * @param {function} handler
 */
const _handlers = new Map(); // handler -> wrapper

export function on2(eventName, handler) {
  const wrapper = e => handler(e.detail);
  _handlers.set(handler, wrapper);
  bus.addEventListener(eventName, wrapper);
  return () => off(eventName, handler);
}

export function off(eventName, handler) {
  const wrapper = _handlers.get(handler);
  if (wrapper) {
    bus.removeEventListener(eventName, wrapper);
    _handlers.delete(handler);
  }
}

// Override on() to track wrappers so off() works.
// Re-export on with tracking:
const _on = on;
// Replace the exported on() with a version that stores wrappers.
// We use a separate internal map keyed by handler function reference.
const _eventWrappers = new WeakMap();

/**
 * The main AppState object.
 * Mutate properties directly; use the helper functions to trigger events.
 */
export const state = {
  /** @type {Map<string, FileEntry>} */
  files: new Map(),

  /** @type {Set<string>} */
  selectedIds: new Set(),

  /** @type {'browser'|'archive'|'rename'|'metadata'|'tools'|'recipes'} */
  activeModule: 'browser',

  /** @type {string|null} */
  previewFileId: null,

  /** @type {FileSystemDirectoryHandle|null} */
  rootHandle: null,

  /** @type {Filters} */
  filters: {
    search: '',
    category: '',
    sort: 'name',
    order: 'asc',
  },

  /** @type {Array} */
  recipes: [],

  /** @type {Object} */
  browserSupport: {},

  workspaceOpen: false,
};

// ─── File management ──────────────────────────────────────────────────────────

/**
 * Build a FileEntry object from a raw File (or a plain object with file-like props).
 * @param {File|Object} file
 * @param {string} [relativePath]
 * @returns {FileEntry}
 */
function buildFileEntry(file, relativePath) {
  const name = file.name || 'unknown';
  const ext = getExtension(name);
  const type = file.type || '';
  const size = file.size || 0;
  const modified = file.lastModified ? new Date(file.lastModified) : new Date();
  const rp = relativePath || file.webkitRelativePath || name;
  const category = getMimeCategory(type, ext);

  return {
    id: generateId(),
    file,
    name,
    ext,
    size,
    type,
    category,
    modified,
    path: rp,
    relativePath: rp,
  };
}

/**
 * Add FileEntry objects (or raw Files) to state.files.
 * @param {Array<FileEntry|File>} fileEntries
 */
export function addFiles(fileEntries) {
  const added = [];
  for (const item of fileEntries) {
    let entry;
    if (item && item.id && item.file) {
      // Already a FileEntry
      entry = item;
    } else if (item instanceof File) {
      entry = buildFileEntry(item);
    } else if (item && item.file) {
      entry = buildFileEntry(item.file, item.relativePath || item.path);
      // merge any extra props
      entry = Object.assign(entry, item, { id: entry.id });
    } else {
      continue;
    }
    state.files.set(entry.id, entry);
    added.push(entry);
  }
  if (added.length > 0) {
    emit('files:added', added);
  }
}

/**
 * Remove specific files from state by ID and emit events.
 * Emits 'files:removed' with the removed entries, plus 'files:cleared'
 * when the workspace ends up empty.
 * @param {Iterable<string>} ids
 */
export function removeFiles(ids) {
  const removed = [];
  for (const id of ids) {
    const entry = state.files.get(id);
    if (!entry) continue;
    state.files.delete(id);
    state.selectedIds.delete(id);
    removed.push(entry);
  }
  if (!removed.length) return;
  if (state.previewFileId && removed.some(e => e.id === state.previewFileId)) {
    closePreview();
  }
  emit('files:removed', removed);
  emit('selection:change', { selectedIds: state.selectedIds });
  if (state.files.size === 0) emit('files:cleared', null);
}

/**
 * Clear all files from state and emit event.
 */
export function clearFiles() {
  state.files.clear();
  state.selectedIds.clear();
  state.previewFileId = null;
  emit('files:cleared', null);
}

// ─── Selection management ─────────────────────────────────────────────────────

/**
 * Replace current selection with a new set of IDs.
 * @param {Iterable<string>} ids
 */
export function setSelectedIds(ids) {
  state.selectedIds = new Set(ids);
  emit('selection:change', { selectedIds: state.selectedIds });
}

/**
 * Toggle selection of a single file ID.
 * @param {string} id
 */
export function toggleSelected(id) {
  if (state.selectedIds.has(id)) {
    state.selectedIds.delete(id);
  } else {
    state.selectedIds.add(id);
  }
  emit('selection:change', { selectedIds: state.selectedIds });
}

/**
 * Select all files currently in state.files.
 */
export function selectAll() {
  state.selectedIds = new Set(state.files.keys());
  emit('selection:change', { selectedIds: state.selectedIds });
}

/**
 * Deselect all files.
 */
export function selectNone() {
  state.selectedIds.clear();
  emit('selection:change', { selectedIds: state.selectedIds });
}

// ─── Module routing ───────────────────────────────────────────────────────────

/**
 * Switch the active module.
 * @param {'browser'|'archive'|'rename'|'metadata'|'tools'|'recipes'} name
 */
export function setActiveModule(name) {
  state.activeModule = name;
  emit('module:change', { activeModule: name });
}

// ─── Preview ──────────────────────────────────────────────────────────────────

/**
 * Open the file preview panel for a given file ID.
 * @param {string} fileId
 */
export function openPreview(fileId) {
  state.previewFileId = fileId;
  emit('preview:open', { fileId });
}

/**
 * Close the file preview panel.
 */
export function closePreview() {
  state.previewFileId = null;
  emit('preview:close', null);
}

// ─── Filters ──────────────────────────────────────────────────────────────────

/**
 * Update a single filter key and emit.
 * @param {keyof Filters} key
 * @param {string} value
 */
export function setFilter(key, value) {
  state.filters[key] = value;
  emit('filters:change', { filters: state.filters });
}

/**
 * Return a sorted and filtered array of FileEntry objects.
 * @returns {FileEntry[]}
 */
export function getFilteredFiles() {
  const { search, category, sort, order } = state.filters;
  const searchLower = search.trim().toLowerCase();

  let entries = Array.from(state.files.values());

  if (searchLower) {
    entries = entries.filter(f =>
      f.name.toLowerCase().includes(searchLower) ||
      f.relativePath.toLowerCase().includes(searchLower)
    );
  }

  if (category) {
    entries = entries.filter(f => f.category === category);
  }

  entries.sort((a, b) => {
    let valA, valB;
    switch (sort) {
      case 'size':
        valA = a.size;
        valB = b.size;
        break;
      case 'modified':
        valA = a.modified.getTime();
        valB = b.modified.getTime();
        break;
      case 'type':
        valA = a.type.toLowerCase();
        valB = b.type.toLowerCase();
        break;
      case 'ext':
        valA = a.ext.toLowerCase();
        valB = b.ext.toLowerCase();
        break;
      case 'name':
      default:
        valA = a.name.toLowerCase();
        valB = b.name.toLowerCase();
        break;
    }

    if (valA < valB) return order === 'asc' ? -1 : 1;
    if (valA > valB) return order === 'asc' ? 1 : -1;
    return 0;
  });

  return entries;
}

// ─── Workspace ────────────────────────────────────────────────────────────────

/**
 * Mark the workspace as open.
 */
export function openWorkspace() {
  state.workspaceOpen = true;
  emit('workspace:open', null);
}

/**
 * Mark the workspace as closed.
 */
export function closeWorkspace() {
  state.workspaceOpen = false;
  emit('workspace:close', null);
}
