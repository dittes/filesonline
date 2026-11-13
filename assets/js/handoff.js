// handoff.js
// Passes files from one tool to another without leaving the device. The sender
// stores them in IndexedDB under an id and opens the target with ?handoff=<id>;
// the target takes them out again. Records older than an hour are dropped.

const DB = 'fo-handoff';
const MAX_AGE = 3600000;

function withStore(mode, work) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('files');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('files', mode);
      let result;
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
      work(tx.objectStore('files'), value => { result = value; });
    };
  });
}

export function newHandoffId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * @param {string} id
 * @param {{name:string, blob:Blob, dir?:string}[]} files
 */
export function saveHandoff(id, files) {
  const now = Date.now();
  return withStore('readwrite', store => {
    // Clear out what earlier sessions left behind
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return;
      if (!c.value?.at || now - c.value.at > MAX_AGE) c.delete();
      c.continue();
    };
    store.put({ at: now, files: files.map(f => ({ name: f.name, blob: f.blob, dir: f.dir || '', type: f.blob.type || '', modified: f.blob.lastModified || now })) }, id);
  });
}

function read(id) {
  return withStore('readwrite', (store, done) => {
    const r = store.get(id);
    r.onsuccess = () => {
      if (!r.result) return done(null);
      store.delete(id);
      done(now() - r.result.at < MAX_AGE ? r.result : null);
    };
  });
}
const now = () => Date.now();

/**
 * Take the files out. The sender may still be writing when the target opens,
 * so this waits a little for the record to appear.
 * @returns {Promise<(File & {handoffDir?:string})[]>}
 */
export async function takeHandoff(id, { wait = 12000 } = {}) {
  const start = now();
  for (;;) {
    let record = null;
    try { record = await read(id); } catch { return []; }
    if (record) {
      return record.files.map(f => {
        const file = new File([f.blob], f.name, { type: f.type, lastModified: f.modified });
        if (f.dir) file.handoffDir = f.dir;
        return file;
      });
    }
    if (now() - start > wait) return [];
    await new Promise(r => setTimeout(r, 150));
  }
}

/** Id from ?handoff=…, removed from the address bar so a reload does not repeat it. */
export function handoffIdFromUrl() {
  const params = new URLSearchParams(location.search);
  const id = params.get('handoff');
  if (!id) return null;
  params.delete('handoff');
  const rest = params.toString();
  history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
  return id;
}

/**
 * Send files to another page of this site. Call it from a click handler:
 * the tab is opened right away so the browser does not block it.
 */
export function sendTo(url, files, { newTab = true } = {}) {
  const id = newHandoffId();
  const target = `${url}${url.includes('?') ? '&' : '?'}handoff=${id}`;
  const saving = saveHandoff(id, files);
  if (newTab) {
    const win = window.open(target, '_blank');
    if (!win) saving.then(() => { location.href = target; });
  } else {
    saving.then(() => { location.href = target; });
  }
  return saving;
}
