// session.js
// Remembers the last folder you opened, so the next visit can reopen it with one
// click. Only the browser's handle to the folder is stored, on this device; the
// browser asks for permission again before anything is read.

const DB = 'fo-fm-session';

function withStore(mode, work) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('handles');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('handles', mode);
      let result;
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
      work(tx.objectStore('handles'), value => { result = value; });
    };
  });
}

export const supported = 'showDirectoryPicker' in window && 'indexedDB' in window;

export async function remember(handle) {
  if (!supported || !handle) return;
  try { await withStore('readwrite', store => store.put({ handle, name: handle.name, at: Date.now() }, 'last')); } catch { /* storage may be blocked */ }
}

/** @returns {Promise<{handle:FileSystemDirectoryHandle, name:string}|null>} */
export async function last() {
  if (!supported) return null;
  try {
    return await withStore('readonly', (store, done) => {
      const r = store.get('last');
      r.onsuccess = () => done(r.result || null);
    });
  } catch { return null; }
}

export async function forget() {
  try { await withStore('readwrite', store => store.delete('last')); } catch { /* nothing stored */ }
}
