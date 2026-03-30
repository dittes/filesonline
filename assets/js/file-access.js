// file-access.js
// Handles all file/folder opening operations.
// Uses File System Access API where available, falls back to <input type="file">.

import { generateId, getExtension, getMimeCategory } from './utils.js';
import { addFiles, state } from './state.js';

// ---------------------------------------------------------------------------
// createFileEntry
// ---------------------------------------------------------------------------

/**
 * Build a normalised FileEntry object from a native File and an optional
 * relative path string (e.g. "images/avatars/").
 *
 * @param {File}   file
 * @param {string} [relativePath='']
 * @returns {import('./state.js').FileEntry}
 */
export function createFileEntry(file, relativePath = '') {
  const name = file.name;
  const ext  = getExtension(name);

  // Normalise the relative path: always ends with '/' when non-empty
  let normalised = relativePath
    ? relativePath.replace(/\\/g, '/').replace(/\/?$/, '/')
    : '';

  // Some browsers embed the filename inside webkitRelativePath; strip it
  if (normalised.endsWith(name + '/')) {
    normalised = normalised.slice(0, -(name.length + 1));
  }

  return {
    id:           generateId(),
    file,
    name,
    ext,
    size:         file.size,
    type:         file.type || `application/octet-stream`,
    category:     getMimeCategory(file.type),
    modified:     new Date(file.lastModified),
    path:         normalised + name,
    relativePath: normalised,
  };
}

// ---------------------------------------------------------------------------
// openFiles  –  open file picker, return FileEntry[]
// ---------------------------------------------------------------------------

/**
 * Open a file picker (multiple) and return FileEntry[].
 * Adds the entries to global state automatically.
 *
 * @returns {Promise<import('./state.js').FileEntry[]>}
 */
export async function openFiles() {
  let files = [];

  if (typeof window.showOpenFilePicker === 'function') {
    // File System Access API
    let handles;
    try {
      handles = await window.showOpenFilePicker({ multiple: true });
    } catch (err) {
      // User cancelled – not an error
      if (err.name === 'AbortError') return [];
      throw err;
    }

    for (const handle of handles) {
      try {
        const file = await handle.getFile();
        files.push(createFileEntry(file, ''));
      } catch (e) {
        console.warn('file-access: could not read file handle', e);
      }
    }
  } else {
    // Fallback: hidden <input>
    files = await _inputFilePicker({ multiple: true, directory: false });
  }

  if (files.length) addFiles(files);
  return files;
}

// ---------------------------------------------------------------------------
// openFolder  –  open folder picker, return FileEntry[]
// ---------------------------------------------------------------------------

/**
 * Open a directory picker and return FileEntry[] for every file inside.
 * Adds the entries to global state automatically.
 *
 * @returns {Promise<import('./state.js').FileEntry[]>}
 */
export async function openFolder() {
  let files = [];

  if (typeof window.showDirectoryPicker === 'function') {
    let dirHandle;
    try {
      dirHandle = await window.showDirectoryPicker();
    } catch (err) {
      if (err.name === 'AbortError') return [];
      throw err;
    }

    files = await _walkDirectoryHandle(dirHandle, '');
  } else {
    // Fallback: webkitdirectory
    const rawFiles = await _inputFilePicker({ multiple: true, directory: true });
    files = rawFiles; // relativePath already set from webkitRelativePath
  }

  if (files.length) addFiles(files);
  return files;
}

// ---------------------------------------------------------------------------
// openArchive  –  open a single archive file
// ---------------------------------------------------------------------------

/**
 * Open a picker for a single archive file.
 *
 * @returns {Promise<import('./state.js').FileEntry|null>}
 */
export async function openArchive() {
  const archiveTypes = [
    'application/zip',
    'application/x-zip-compressed',
    'application/x-tar',
    'application/gzip',
    'application/x-7z-compressed',
    'application/x-rar-compressed',
    'application/vnd.rar',
  ];

  let entries = [];

  if (typeof window.showOpenFilePicker === 'function') {
    let handles;
    try {
      handles = await window.showOpenFilePicker({
        multiple: false,
        types: [
          {
            description: 'Archive files',
            accept: {
              'application/zip':          ['.zip'],
              'application/x-tar':        ['.tar'],
              'application/gzip':         ['.gz', '.tgz'],
              'application/x-7z-compressed': ['.7z'],
              'application/x-rar-compressed': ['.rar'],
            },
          },
        ],
      });
    } catch (err) {
      if (err.name === 'AbortError') return null;
      throw err;
    }

    for (const handle of handles) {
      try {
        const file = await handle.getFile();
        entries.push(createFileEntry(file, ''));
      } catch (e) {
        console.warn('file-access: could not read archive handle', e);
      }
    }
  } else {
    const accept = '.zip,.tar,.gz,.tgz,.7z,.rar';
    entries = await _inputFilePicker({ multiple: false, directory: false, accept });
  }

  return entries[0] ?? null;
}

// ---------------------------------------------------------------------------
// processDroppedItems  –  handle drag-and-drop DataTransfer
// ---------------------------------------------------------------------------

/**
 * Process a DataTransfer object from a drop event.
 * Handles both flat files and directory entries via webkitGetAsEntry().
 *
 * @param {DataTransfer} dataTransfer
 * @returns {Promise<import('./state.js').FileEntry[]>}
 */
export async function processDroppedItems(dataTransfer) {
  const entries = [];
  const items   = dataTransfer.items;

  if (items && items.length) {
    const promises = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // Prefer File System Access API handle when available
      if (typeof item.getAsFileSystemHandle === 'function') {
        promises.push(
          item.getAsFileSystemHandle().then(async (handle) => {
            if (!handle) return [];
            if (handle.kind === 'file') {
              try {
                const file = await handle.getFile();
                return [createFileEntry(file, '')];
              } catch (e) {
                console.warn('file-access: drop handle error', e);
                return [];
              }
            } else if (handle.kind === 'directory') {
              return _walkDirectoryHandle(handle, '');
            }
            return [];
          }).catch(() => [])
        );
      } else if (typeof item.webkitGetAsEntry === 'function') {
        const fsEntry = item.webkitGetAsEntry();
        if (fsEntry) {
          promises.push(_walkFileSystemEntry(fsEntry, ''));
        }
      } else if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) entries.push(createFileEntry(file, ''));
      }
    }

    const results = await Promise.all(promises);
    for (const batch of results) entries.push(...batch);
  } else if (dataTransfer.files && dataTransfer.files.length) {
    // Fallback: plain FileList
    for (const file of dataTransfer.files) {
      entries.push(createFileEntry(file, ''));
    }
  }

  if (entries.length) addFiles(entries);
  return entries;
}

// ---------------------------------------------------------------------------
// setupDropZone  –  attach drag-and-drop listeners to an element
// ---------------------------------------------------------------------------

/**
 * Attach drag-and-drop handlers to `el`.
 * Returns a cleanup function that removes all listeners.
 *
 * @param {HTMLElement} el
 * @param {(entries: import('./state.js').FileEntry[]) => void} onDrop
 * @returns {() => void} cleanup
 */
export function setupDropZone(el, onDrop) {
  let dragDepth = 0;

  function onDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }

  function onDragEnter(e) {
    e.preventDefault();
    e.stopPropagation();
    dragDepth++;
    el.classList.add('drag-over');
  }

  function onDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    dragDepth--;
    if (dragDepth <= 0) {
      dragDepth = 0;
      el.classList.remove('drag-over');
    }
  }

  function onDropEvent(e) {
    e.preventDefault();
    e.stopPropagation();
    dragDepth = 0;
    el.classList.remove('drag-over');

    processDroppedItems(e.dataTransfer)
      .then((fileEntries) => {
        if (fileEntries.length) onDrop(fileEntries);
      })
      .catch((err) => console.error('file-access: drop processing error', err));
  }

  el.addEventListener('dragover',  onDragOver);
  el.addEventListener('dragenter', onDragEnter);
  el.addEventListener('dragleave', onDragLeave);
  el.addEventListener('drop',      onDropEvent);

  return function cleanup() {
    el.removeEventListener('dragover',  onDragOver);
    el.removeEventListener('dragenter', onDragEnter);
    el.removeEventListener('dragleave', onDragLeave);
    el.removeEventListener('drop',      onDropEvent);
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Show a hidden <input type="file"> and resolve with FileEntry[] when the
 * user finishes selecting.
 *
 * @param {{ multiple: boolean, directory: boolean, accept?: string }} opts
 * @returns {Promise<import('./state.js').FileEntry[]>}
 */
function _inputFilePicker({ multiple = true, directory = false, accept = '' }) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type  = 'file';

    if (multiple)   input.multiple            = true;
    if (directory)  input.webkitdirectory     = true;
    if (accept)     input.accept              = accept;

    // Keep input alive until the user makes a choice
    input.style.display  = 'none';
    document.body.appendChild(input);

    let resolved = false;

    input.addEventListener('change', () => {
      if (resolved) return;
      resolved = true;

      const entries = [];
      for (const file of input.files) {
        const rel = directory && file.webkitRelativePath
          ? _dirFromWebkitRelativePath(file.webkitRelativePath)
          : '';
        entries.push(createFileEntry(file, rel));
      }

      document.body.removeChild(input);
      resolve(entries);
    });

    // If the user cancels, the focus returns to window; use that to resolve empty
    window.addEventListener('focus', function onFocus() {
      window.removeEventListener('focus', onFocus);
      // Give change event a chance to fire first
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          if (document.body.contains(input)) document.body.removeChild(input);
          resolve([]);
        }
      }, 500);
    }, { once: true });

    input.click();
  });
}

/**
 * Extract the directory part from a webkitRelativePath string.
 * e.g. "images/avatars/photo.jpg" -> "images/avatars/"
 *
 * @param {string} webkitRelativePath
 * @returns {string}
 */
function _dirFromWebkitRelativePath(webkitRelativePath) {
  const parts = webkitRelativePath.split('/');
  if (parts.length <= 1) return '';
  parts.pop(); // remove filename
  return parts.join('/') + '/';
}

/**
 * Recursively walk a FileSystemDirectoryHandle and collect FileEntry objects.
 *
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string} currentPath - path prefix accumulated during recursion
 * @returns {Promise<import('./state.js').FileEntry[]>}
 */
async function _walkDirectoryHandle(dirHandle, currentPath) {
  const entries  = [];
  const basePath = currentPath ? currentPath + dirHandle.name + '/' : dirHandle.name + '/';

  try {
    for await (const [, handle] of dirHandle) {
      if (handle.kind === 'file') {
        try {
          const file = await handle.getFile();
          entries.push(createFileEntry(file, basePath));
        } catch (e) {
          console.warn(`file-access: skipping file "${handle.name}" —`, e.message);
        }
      } else if (handle.kind === 'directory') {
        try {
          const children = await _walkDirectoryHandle(handle, basePath);
          entries.push(...children);
        } catch (e) {
          console.warn(`file-access: skipping directory "${handle.name}" —`, e.message);
        }
      }
    }
  } catch (e) {
    console.warn(`file-access: permission error on "${dirHandle.name}" —`, e.message);
  }

  return entries;
}

/**
 * Recursively walk a FileSystemEntry (from webkitGetAsEntry) and collect
 * FileEntry objects.
 *
 * @param {FileSystemEntry} fsEntry
 * @param {string} currentPath
 * @returns {Promise<import('./state.js').FileEntry[]>}
 */
function _walkFileSystemEntry(fsEntry, currentPath) {
  if (fsEntry.isFile) {
    return new Promise((resolve) => {
      fsEntry.file(
        (file) => resolve([createFileEntry(file, currentPath)]),
        (err)  => {
          console.warn('file-access: FileSystemFileEntry error', err);
          resolve([]);
        }
      );
    });
  }

  if (fsEntry.isDirectory) {
    const dirPath = currentPath + fsEntry.name + '/';
    return new Promise((resolve) => {
      const reader = fsEntry.createReader();
      const allEntries = [];

      function readBatch() {
        reader.readEntries(async (batch) => {
          if (!batch.length) {
            // All batches read — recurse into each
            const promises = allEntries.map((child) =>
              _walkFileSystemEntry(child, dirPath)
            );
            const results = await Promise.all(promises);
            resolve(results.flat());
            return;
          }
          allEntries.push(...batch);
          readBatch(); // readEntries may return partial results — keep reading
        }, (err) => {
          console.warn('file-access: readEntries error', err);
          resolve([]);
        });
      }

      readBatch();
    });
  }

  return Promise.resolve([]);
}
