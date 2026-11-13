// archive.js
// Create ZIP files and unpack archives. ZIP, TAR and GZ are handled with the
// self-hosted fflate; RAR and 7Z need libarchive, fetched when first used.

import { fflate } from '../pdf/lib.js';
import { UserError, pause } from './dom.js';
import { t } from './i18n.js';

const STORED = /^(zip|rar|7z|gz|tgz|bz2|xz|zst|jpg|jpeg|png|gif|webp|avif|heic|mp3|m4a|aac|ogg|opus|flac|mp4|mov|mkv|webm|avi|m4v|docx|xlsx|pptx|odt|ods|odp|epub|jar|woff|woff2|pdf)$/;
const ZIP_MIN_DATE = Date.UTC(1980, 0, 2);

/**
 * @param {{path:string, file:Blob, modified?:number}[]} entries
 * @param {{level?:number, folders?:string[], onProgress?:Function, signal?:AbortSignal}} opt
 * @returns {Promise<Blob>}
 */
export async function makeZip(entries, { level = 6, folders = [], onProgress, signal } = {}) {
  const { Zip, ZipDeflate, ZipPassThrough } = await fflate();
  const chunks = [];
  let failure = null;
  const zip = new Zip((err, chunk) => { if (err) failure = err; else chunks.push(chunk); });
  const total = entries.reduce((sum, e) => sum + e.file.size, 0) || 1;
  let done = 0;

  const withFiles = new Set(entries.map(e => e.path.slice(0, e.path.lastIndexOf('/'))));
  for (const folder of folders) {
    if ([...withFiles].some(dir => dir === folder || dir.startsWith(`${folder}/`))) continue;
    const part = new ZipPassThrough(`${folder}/`);
    zip.add(part);
    part.push(new Uint8Array(0), true);
  }

  for (const entry of entries) {
    const ext = entry.path.slice(entry.path.lastIndexOf('.') + 1).toLowerCase();
    const part = level === 0 || STORED.test(ext) ? new ZipPassThrough(entry.path) : new ZipDeflate(entry.path, { level });
    part.mtime = new Date(Math.max(ZIP_MIN_DATE, entry.modified || Date.now()));
    zip.add(part);
    const reader = entry.file.stream().getReader();
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (finished) break;
      part.push(value, false);
      done += value.length;
      onProgress?.(done / total);
      if (failure) throw failure;
    }
    part.push(new Uint8Array(0), true);
    await pause();
  }
  zip.end();
  if (failure) throw failure;
  return new Blob(chunks, { type: 'application/zip' });
}

// ─── Reading ──────────────────────────────────────────────────────────────────

const lower = name => name.toLowerCase();
export function archiveType(name, head) {
  const n = lower(name);
  if (head) {
    if (head[0] === 0x50 && head[1] === 0x4b) return 'zip';
    if (head[0] === 0x1f && head[1] === 0x8b) return /\.(tar\.gz|tgz)$/.test(n) ? 'tgz' : 'gz';
    if (head[0] === 0x52 && head[1] === 0x61 && head[2] === 0x72) return 'rar';
    if (head[0] === 0x37 && head[1] === 0x7a) return '7z';
  }
  if (/\.(zip|cbz|jar|war|epub|docx|xlsx|pptx|odt|ods|odp)$/.test(n)) return 'zip';
  if (/\.(tar\.gz|tgz)$/.test(n)) return 'tgz';
  if (/\.tar$/.test(n)) return 'tar';
  if (/\.gz$/.test(n)) return 'gz';
  if (/\.rar$/.test(n)) return 'rar';
  if (/\.7z$/.test(n)) return '7z';
  if (/\.(tar\.bz2|tar\.xz|tbz2|txz|bz2|xz)$/.test(n)) return 'other';
  return null;
}

async function gunzip(blob) {
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const octal = (u8, at, len) => parseInt(new TextDecoder().decode(u8.subarray(at, at + len)).replace(/\0.*$/, '').trim() || '0', 8) || 0;
const cstr = (u8, at, len) => {
  let end = at;
  while (end < at + len && u8[end]) end++;
  return new TextDecoder().decode(u8.subarray(at, end));
};

function readTar(u8, withData) {
  const out = [];
  let pos = 0, longName = '';
  while (pos + 512 <= u8.length) {
    if (!u8[pos]) break;
    const size = octal(u8, pos + 124, 12);
    const type = String.fromCharCode(u8[pos + 156] || 48);
    const prefix = cstr(u8, pos + 345, 155);
    let name = longName || (prefix ? `${prefix}/` : '') + cstr(u8, pos, 100);
    longName = '';
    const dataStart = pos + 512;
    if (type === 'L') longName = cstr(u8, dataStart, size);
    else if (type === 'x') {
      const pax = new TextDecoder().decode(u8.subarray(dataStart, dataStart + size));
      const m = pax.match(/\d+ path=([^\n]+)\n/);
      if (m) longName = m[1];
    } else if (type === '0' || type === '7') {
      name = name.replace(/^\.\//, '');
      if (name) out.push({ path: name, size, modified: octal(u8, pos + 136, 12) * 1000, bytes: withData ? u8.subarray(dataStart, dataStart + size) : null });
    }
    pos = dataStart + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** Names and sizes inside an archive, without unpacking where the format allows it. */
export async function listArchive(file) {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const type = archiveType(file.name, head);
  if (type === 'zip') {
    const { unzipSync } = await fflate();
    const list = [];
    unzipSync(new Uint8Array(await file.arrayBuffer()), {
      filter: f => { if (!f.name.endsWith('/')) list.push({ path: f.name, size: f.originalSize }); return false; },
    });
    return list;
  }
  if (type === 'tar') return readTar(new Uint8Array(await file.arrayBuffer()), false);
  if (type === 'tgz') return readTar(await gunzip(file), false);
  return null;
}

let libarchive = null;
function loadLibarchive() {
  libarchive ||= (async () => {
    const base = 'https://cdn.jsdelivr.net/npm/libarchive.js@1.3.0';
    const { Archive } = await import(`${base}/main.js`);
    // A worker has to come from this origin, so a local one loads the remote script.
    // Its WebAssembly file is addressed relative to the script, so point that at the CDN too.
    const dist = `${base}/dist/`;
    const source = `const dist = ${JSON.stringify(dist)}; const realFetch = self.fetch.bind(self);
self.fetch = (url, opt) => realFetch(typeof url === 'string' && !/^[a-z][a-z0-9+.-]*:/i.test(url) ? dist + url : url, typeof url === 'string' ? undefined : opt);
importScripts(dist + 'worker-bundle.js');`;
    Archive.init({ workerUrl: URL.createObjectURL(new Blob([source], { type: 'text/javascript' })) });
    return Archive;
  })().catch(err => { libarchive = null; throw err; });
  return libarchive;
}

async function withLibarchive(file) {
  let Archive;
  try { Archive = await loadLibarchive(); } catch {
    throw new UserError(t('This archive format needs an extra library that could not be loaded. Check your connection and try again.'));
  }
  const slow = new Promise((_, reject) => setTimeout(() => reject(new UserError(t('This archive could not be unpacked. It may be damaged, encrypted or too large for this browser.'))), 90000));
  const tree = await Promise.race([Archive.open(file).then(archive => archive.extractFiles()), slow]);
  const out = [];
  (function walk(node, prefix) {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}/${key}` : key;
      if (value instanceof File) out.push({ path, blob: value, modified: value.lastModified });
      else if (value && typeof value === 'object') walk(value, path);
    }
  })(tree, '');
  return out;
}

/**
 * Unpack an archive.
 * @returns {Promise<{path:string, blob:Blob, modified?:number}[]>}
 */
export async function extract(file, { onProgress } = {}) {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const type = archiveType(file.name, head);
  if (!type) throw new UserError(t('This file is not an archive that can be unpacked here.'));

  if (type === 'zip') {
    const lib = await fflate();
    const buffer = new Uint8Array(await file.arrayBuffer());
    onProgress?.(0.15);
    const files = await new Promise((resolve, reject) => {
      lib.unzip(buffer, { filter: f => !f.name.endsWith('/') }, (err, data) => (err ? reject(err) : resolve(data)));
    }).catch(err => {
      if (/encrypt|password|unknown compression/i.test(String(err?.message))) {
        throw new UserError(t('This ZIP is password protected or uses a compression this browser cannot read.'));
      }
      throw err;
    });
    return Object.entries(files).map(([path, bytes]) => ({ path, blob: new Blob([bytes]) }));
  }

  if (type === 'tar' || type === 'tgz') {
    const u8 = type === 'tar' ? new Uint8Array(await file.arrayBuffer()) : await gunzip(file);
    return readTar(u8, true).map(e => ({ path: e.path, blob: new Blob([e.bytes.slice()]), modified: e.modified || undefined }));
  }

  if (type === 'gz') {
    const bytes = await gunzip(file);
    return [{ path: file.name.replace(/\.gz$/i, '') || 'file', blob: new Blob([bytes]) }];
  }

  return withLibarchive(file);
}
