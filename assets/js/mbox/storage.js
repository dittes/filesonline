// storage.js
// Optional IndexedDB persistence for parsed archives. Nothing is written
// until the user explicitly opts in ("Save archive locally").

const DB_NAME = 'fo-mbox-viewer';
const DB_VERSION = 1;
const PREFS_KEY = 'fo-mbox-prefs';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('archives')) {
        db.createObjectStore('archives', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('messages')) {
        const store = db.createObjectStore('messages', { keyPath: 'id' });
        store.createIndex('byArchive', 'sourceArchiveId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB unavailable'));
  });
  return dbPromise;
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const result = fn(s);
    t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted (storage quota?)'));
  });
}

/** Strip runtime-only fields before persisting a message. */
function serializable(msg) {
  const { _blob, ...rest } = msg;
  return rest;
}

/**
 * Persist an archive and all of its messages.
 * @param {{id:string,name:string,fileSize:number,messageCount:number,savedAt:number}} meta
 * @param {import('./mime-parser.js').MboxMessage[]} messages
 */
export async function saveArchive(meta, messages) {
  const db = await openDb();
  await tx(db, 'archives', 'readwrite', s => s.put(meta));
  // Chunked writes so a huge archive doesn't build one giant transaction
  const CHUNK = 500;
  for (let i = 0; i < messages.length; i += CHUNK) {
    const slice = messages.slice(i, i + CHUNK);
    await tx(db, 'messages', 'readwrite', s => { slice.forEach(m => s.put(serializable(m))); });
  }
}

/** Persist state changes (flags/labels/notes/edits) for a subset of messages. */
export async function updateMessages(messages) {
  const db = await openDb();
  await tx(db, 'messages', 'readwrite', s => { messages.forEach(m => s.put(serializable(m))); });
}

/** @returns {Promise<Array>} archive metadata records */
export async function listArchives() {
  const db = await openDb();
  return tx(db, 'archives', 'readonly', s => s.getAll());
}

/** Load all messages of a saved archive. */
export async function loadArchiveMessages(archiveId) {
  const db = await openDb();
  return tx(db, 'messages', 'readonly', s => s.index('byArchive').getAll(archiveId));
}

export async function renameArchive(archiveId, newName) {
  const db = await openDb();
  const meta = await tx(db, 'archives', 'readonly', s => s.get(archiveId));
  if (meta) {
    meta.name = newName;
    await tx(db, 'archives', 'readwrite', s => s.put(meta));
  }
}

export async function deleteArchive(archiveId) {
  const db = await openDb();
  await tx(db, 'archives', 'readwrite', s => s.delete(archiveId));
  const db2 = await openDb();
  await new Promise((resolve, reject) => {
    const t = db2.transaction('messages', 'readwrite');
    const idx = t.objectStore('messages').index('byArchive');
    const req = idx.openCursor(IDBKeyRange.only(archiveId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
    };
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

export async function clearAllData() {
  const db = await openDb();
  await tx(db, 'archives', 'readwrite', s => s.clear());
  await tx(db, 'messages', 'readwrite', s => s.clear());
  try { localStorage.removeItem(PREFS_KEY); } catch { /* ignore */ }
}

/** @returns {Promise<{usage:number, quota:number}|null>} */
export async function estimateUsage() {
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const { usage, quota } = await navigator.storage.estimate();
      return { usage: usage || 0, quota: quota || 0 };
    } catch { /* fall through */ }
  }
  return null;
}

/** UI preferences (density, sort, theme handled elsewhere). */
export function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch { return {}; }
}

export function savePrefs(prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
}
