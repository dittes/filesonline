// zipcrypt.js
// Password-protected ZIP: WinZip AES (AE-2) writing, AES/ZipCrypto reading.
// Self-contained: WebCrypto for PBKDF2 and HMAC, fflate for deflate/inflate,
// and a small AES block cipher below for the CTR keystream.

let t = s => s;
export function setT(fn) { t = fn; }

// Injectable so node tests can load the vendor file directly.
let loadFflate = async () => (await import('../pdf/lib.js')).fflate();
export function setFflateLoader(fn) { loadFflate = fn; }

class UserError extends Error {
  constructor(message) { super(message); this.name = 'UserError'; this.userMessage = message; }
}

const LIMIT = 0xFFFFFFFF;
const enc = new TextEncoder();

function abortCheck(signal) {
  if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
}

// ---- CRC-32 -------------------------------------------------------------

const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c >>> 0;
}

function crc32(data) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) c = CRC[(c ^ data[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---- AES block cipher (encrypt only) ------------------------------------
// Why not WebCrypto: its AES-CTR counter is big-endian, WinZip's is
// little-endian, and raw ECB is not exposed. Looping AES-CBC over single
// blocks is far too slow, so the keystream comes from this T-table AES
// (tens of MB per second, plenty for in-browser files).

const SBOX = new Uint8Array(256);
const TE = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
{
  let p = 1, q = 1;
  do {
    p = (p ^ (p << 1) ^ (p & 0x80 ? 0x11B : 0)) & 255;
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 255;
    if (q & 0x80) q ^= 0x09;
    const rot = (v, n) => ((v << n) | (v >> (8 - n))) & 255;
    SBOX[p] = (q ^ rot(q, 1) ^ rot(q, 2) ^ rot(q, 3) ^ rot(q, 4) ^ 0x63) & 255;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) {
    const s = SBOX[i];
    const s2 = (s << 1) ^ (s & 0x80 ? 0x11B : 0);
    const s3 = s2 ^ s;
    const w = ((s2 << 24) | (s << 16) | (s << 8) | s3) >>> 0;
    TE[0][i] = w;
    TE[1][i] = ((w >>> 8) | (w << 24)) >>> 0;
    TE[2][i] = ((w >>> 16) | (w << 16)) >>> 0;
    TE[3][i] = ((w >>> 24) | (w << 8)) >>> 0;
  }
}

function expandKey(key) {
  const nk = key.length / 4;
  const nr = nk + 6;
  const w = new Uint32Array(4 * (nr + 1));
  for (let i = 0; i < nk; i++) {
    w[i] = ((key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3]) >>> 0;
  }
  const sub = x => ((SBOX[x >>> 24] << 24) | (SBOX[(x >>> 16) & 255] << 16) | (SBOX[(x >>> 8) & 255] << 8) | SBOX[x & 255]) >>> 0;
  let rcon = 1;
  for (let i = nk; i < w.length; i++) {
    let tmp = w[i - 1];
    if (i % nk === 0) {
      tmp = (sub(((tmp << 8) | (tmp >>> 24)) >>> 0) ^ (rcon << 24)) >>> 0;
      rcon = (rcon << 1) ^ (rcon & 0x80 ? 0x11B : 0);
    } else if (nk > 6 && i % nk === 4) {
      tmp = sub(tmp);
    }
    w[i] = (w[i - nk] ^ tmp) >>> 0;
  }
  return { w, nr };
}

// Encrypts one block given as four big-endian words; result in out[0..3].
function encryptBlock(ks, a0, a1, a2, a3, out) {
  const { w, nr } = ks;
  const [T0, T1, T2, T3] = TE;
  let s0 = a0 ^ w[0], s1 = a1 ^ w[1], s2 = a2 ^ w[2], s3 = a3 ^ w[3];
  let k = 4;
  for (let r = 1; r < nr; r++) {
    const t0 = T0[s0 >>> 24] ^ T1[(s1 >>> 16) & 255] ^ T2[(s2 >>> 8) & 255] ^ T3[s3 & 255] ^ w[k];
    const t1 = T0[s1 >>> 24] ^ T1[(s2 >>> 16) & 255] ^ T2[(s3 >>> 8) & 255] ^ T3[s0 & 255] ^ w[k + 1];
    const t2 = T0[s2 >>> 24] ^ T1[(s3 >>> 16) & 255] ^ T2[(s0 >>> 8) & 255] ^ T3[s1 & 255] ^ w[k + 2];
    const t3 = T0[s3 >>> 24] ^ T1[(s0 >>> 16) & 255] ^ T2[(s1 >>> 8) & 255] ^ T3[s2 & 255] ^ w[k + 3];
    s0 = t0; s1 = t1; s2 = t2; s3 = t3;
    k += 4;
  }
  out[0] = ((SBOX[s0 >>> 24] << 24) | (SBOX[(s1 >>> 16) & 255] << 16) | (SBOX[(s2 >>> 8) & 255] << 8) | SBOX[s3 & 255]) ^ w[k];
  out[1] = ((SBOX[s1 >>> 24] << 24) | (SBOX[(s2 >>> 16) & 255] << 16) | (SBOX[(s3 >>> 8) & 255] << 8) | SBOX[s0 & 255]) ^ w[k + 1];
  out[2] = ((SBOX[s2 >>> 24] << 24) | (SBOX[(s3 >>> 16) & 255] << 16) | (SBOX[(s0 >>> 8) & 255] << 8) | SBOX[s1 & 255]) ^ w[k + 2];
  out[3] = ((SBOX[s3 >>> 24] << 24) | (SBOX[(s0 >>> 16) & 255] << 16) | (SBOX[(s1 >>> 8) & 255] << 8) | SBOX[s2 & 255]) ^ w[k + 3];
}

// WinZip CTR: 16-byte block, little-endian counter from 1. In place; the
// same function encrypts and decrypts. Counter < 2^32 (files are < 4 GB).
function ctrXor(key, data) {
  const ks = expandKey(key);
  const out = new Uint32Array(4);
  let ctr = 1;
  for (let i = 0; i < data.length; i += 16) {
    // Little-endian counter bytes read as a big-endian word is a byte swap.
    const c = ((ctr & 255) << 24) | (((ctr >>> 8) & 255) << 16) | (((ctr >>> 16) & 255) << 8) | (ctr >>> 24);
    encryptBlock(ks, c, 0, 0, 0, out);
    ctr++;
    const n = Math.min(16, data.length - i);
    for (let j = 0; j < n; j++) data[i + j] ^= (out[j >> 2] >>> (24 - 8 * (j & 3))) & 255;
  }
}

// ---- WebCrypto helpers ---------------------------------------------------

async function deriveKeys(password, salt, keyLen) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-1', salt, iterations: 1000 }, base, (2 * keyLen + 2) * 8);
  const b = new Uint8Array(bits);
  return { aes: b.slice(0, keyLen), mac: b.slice(keyLen, 2 * keyLen), ver: b.slice(2 * keyLen) };
}

async function hmac10(macKey, data) {
  const k = await crypto.subtle.importKey('raw', macKey, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data)).subarray(0, 10);
}

// ---- Writing -------------------------------------------------------------

function dosTime(ms) {
  const d = new Date(ms || Date.now());
  const y = Math.max(1980, d.getFullYear());
  return [
    (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  ];
}

export async function makeEncryptedZip(entries, password, { level = 6, onProgress, signal } = {}) {
  if (entries.length > 65535) throw new UserError(t('This archive would have too many files. Please split it into smaller archives.'));
  const ff = level > 0 ? await loadFflate() : null;
  const parts = [];
  const central = [];
  let offset = 0;
  let total = 0;
  for (const e of entries) total += e.file.size;
  let done = 0;

  for (let i = 0; i < entries.length; i++) {
    abortCheck(signal);
    const { path, file, modified } = entries[i];
    if (file.size >= LIMIT) throw new UserError(t('A file is larger than 4 GB. This archive format cannot hold it.'));
    const raw = new Uint8Array(await file.arrayBuffer());
    let body = raw;
    let method = 0;
    if (ff && raw.length > 0) {
      const packed = ff.deflateSync(raw, { level });
      if (packed.length < raw.length) { body = packed; method = 8; }
    }
    abortCheck(signal);
    const data = body === raw ? raw.slice() : body; // encrypted in place
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const keys = await deriveKeys(password, salt, 32);
    ctrXor(keys.aes, data);
    const mac = await hmac10(keys.mac, data);
    const csize = 16 + 2 + data.length + 10;
    if (csize >= LIMIT || offset + csize + 1024 >= LIMIT) {
      throw new UserError(t('This archive would be larger than 4 GB. Please split it into smaller archives.'));
    }

    const name = enc.encode(path);
    const [time, date] = dosTime(modified);
    const extra = new Uint8Array([0x01, 0x99, 7, 0, 2, 0, 0x41, 0x45, 3, method, 0]);
    const head = new Uint8Array(30 + name.length + extra.length);
    const hv = new DataView(head.buffer);
    hv.setUint32(0, 0x04034B50, true);
    hv.setUint16(4, 51, true);
    hv.setUint16(6, 0x0801, true);
    hv.setUint16(8, 99, true);
    hv.setUint16(10, time, true);
    hv.setUint16(12, date, true);
    hv.setUint32(14, 0, true); // CRC is 0 for AE-2
    hv.setUint32(18, csize, true);
    hv.setUint32(22, raw.length, true);
    hv.setUint16(26, name.length, true);
    hv.setUint16(28, extra.length, true);
    head.set(name, 30);
    head.set(extra, 30 + name.length);

    central.push({ name, extra, time, date, csize, usize: raw.length, offset });
    parts.push(head, salt, keys.ver, data, mac);
    offset += head.length + csize;
    done += file.size;
    if (onProgress) onProgress(total ? done / total : (i + 1) / entries.length);
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    const rec = new Uint8Array(46 + c.name.length + c.extra.length);
    const v = new DataView(rec.buffer);
    v.setUint32(0, 0x02014B50, true);
    v.setUint16(4, 0x0033, true);
    v.setUint16(6, 51, true);
    v.setUint16(8, 0x0801, true);
    v.setUint16(10, 99, true);
    v.setUint16(12, c.time, true);
    v.setUint16(14, c.date, true);
    v.setUint32(16, 0, true);
    v.setUint32(20, c.csize, true);
    v.setUint32(24, c.usize, true);
    v.setUint16(28, c.name.length, true);
    v.setUint16(30, c.extra.length, true);
    v.setUint32(42, c.offset, true);
    rec.set(c.name, 46);
    rec.set(c.extra, 46 + c.name.length);
    parts.push(rec);
    cdSize += rec.length;
  }
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054B50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);
  parts.push(eocd);
  if (cdStart + cdSize >= LIMIT) throw new UserError(t('This archive would be larger than 4 GB. Please split it into smaller archives.'));
  return new Blob(parts, { type: 'application/zip' });
}

// ---- Reading -------------------------------------------------------------

async function readCentral(file) {
  const size = file.size;
  const tailLen = Math.min(size, 22 + 65535);
  const tail = new Uint8Array(await file.slice(size - tailLen, size).arrayBuffer());
  const tv = new DataView(tail.buffer);
  let p = tail.length - 22;
  while (p >= 0 && tv.getUint32(p, true) !== 0x06054B50) p--;
  if (p < 0) return null;
  const count = tv.getUint16(p + 10, true);
  const cdSize = tv.getUint32(p + 12, true);
  const cdOff = tv.getUint32(p + 16, true);
  if (count === 0xFFFF || cdSize === LIMIT || cdOff === LIMIT) {
    throw new UserError(t('This archive uses a format that is not supported here.'));
  }
  const cd = new Uint8Array(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const v = new DataView(cd.buffer);
  const out = [];
  const dec = new TextDecoder();
  let q = 0;
  for (let i = 0; i < count; i++) {
    if (q + 46 > cd.length || v.getUint32(q, true) !== 0x02014B50) break;
    const nlen = v.getUint16(q + 28, true), elen = v.getUint16(q + 30, true), clen = v.getUint16(q + 32, true);
    out.push({
      flags: v.getUint16(q + 8, true),
      method: v.getUint16(q + 10, true),
      time: v.getUint16(q + 12, true),
      date: v.getUint16(q + 14, true),
      crc: v.getUint32(q + 16, true),
      csize: v.getUint32(q + 20, true),
      usize: v.getUint32(q + 24, true),
      offset: v.getUint32(q + 42, true),
      path: dec.decode(cd.subarray(q + 46, q + 46 + nlen)),
      extra: cd.subarray(q + 46 + nlen, q + 46 + nlen + elen)
    });
    q += 46 + nlen + elen + clen;
  }
  return out;
}

export async function isEncryptedZip(file) {
  try {
    const list = await readCentral(file);
    return !!list && list.some(e => e.flags & 1);
  } catch { return false; }
}

function aesExtra(extra) {
  const v = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  for (let p = 0; p + 4 <= extra.length;) {
    const id = v.getUint16(p, true), len = v.getUint16(p + 2, true);
    if (id === 0x9901 && len >= 7) {
      return { version: v.getUint16(p + 4, true), strength: extra[p + 8], method: v.getUint16(p + 9, true) };
    }
    p += 4 + len;
  }
  return null;
}

function wrongPassword() {
  const err = new Error('Wrong password');
  err.code = 'PASSWORD';
  return err;
}

function zipCryptoDecrypt(data, password, e) {
  if (data.length < 12) throw new UserError(t('This archive is damaged.'));
  let k0 = 305419896, k1 = 591751049, k2 = 878082192;
  const upd = c => {
    k0 = (CRC[(k0 ^ c) & 255] ^ (k0 >>> 8)) >>> 0;
    k1 = (Math.imul((k1 + (k0 & 255)) >>> 0, 134775813) + 1) >>> 0;
    k2 = (CRC[(k2 ^ (k1 >>> 24)) & 255] ^ (k2 >>> 8)) >>> 0;
  };
  for (const c of enc.encode(password)) upd(c);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const tmp = (k2 | 2) & 0xFFFF;
    const c = data[i] ^ (((tmp * (tmp ^ 1)) >>> 8) & 255);
    out[i] = c;
    upd(c);
  }
  const check = out[11];
  const okCrc = check === e.crc >>> 24;
  const okTime = (e.flags & 8) && check === (e.time >>> 8);
  if (!okCrc && !okTime) throw wrongPassword();
  return out.subarray(12);
}

export async function extractEncryptedZip(file, password, { onProgress } = {}) {
  const list = await readCentral(file);
  if (!list) throw new UserError(t('This file is not a valid ZIP archive.'));
  const ff = await loadFflate();
  const result = [];
  let total = 0, done = 0;
  for (const e of list) total += e.csize;

  for (const e of list) {
    if (e.path.endsWith('/')) continue;
    if (e.csize === LIMIT || e.usize === LIMIT || e.offset === LIMIT) {
      throw new UserError(t('This archive uses a format that is not supported here.'));
    }
    const lh = new DataView(await file.slice(e.offset, e.offset + 30).arrayBuffer());
    if (lh.getUint32(0, true) !== 0x04034B50) throw new UserError(t('This archive is damaged.'));
    const start = e.offset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    let data = new Uint8Array(await file.slice(start, start + e.csize).arrayBuffer());
    let method = e.method;
    let crcCheck = true;

    if (e.method === 99) {
      const ax = aesExtra(e.extra);
      if (!ax || ax.strength < 1 || ax.strength > 3) throw new UserError(t('This archive uses an encryption type that is not supported.'));
      const keyLen = [16, 24, 32][ax.strength - 1];
      const saltLen = keyLen / 2;
      if (data.length < saltLen + 12) throw new UserError(t('This archive is damaged.'));
      const salt = data.subarray(0, saltLen);
      const ver = data.subarray(saltLen, saltLen + 2);
      const body = data.slice(saltLen + 2, data.length - 10);
      const mac = data.subarray(data.length - 10);
      const keys = await deriveKeys(password, salt, keyLen);
      if (keys.ver[0] !== ver[0] || keys.ver[1] !== ver[1]) throw wrongPassword();
      const calc = await hmac10(keys.mac, body);
      for (let i = 0; i < 10; i++) {
        if (calc[i] !== mac[i]) {
          const err = new Error('Corrupt data');
          err.code = 'CORRUPT';
          throw err;
        }
      }
      ctrXor(keys.aes, body);
      data = body;
      method = ax.method;
      crcCheck = ax.version === 1;
    } else if (e.flags & 1) {
      data = zipCryptoDecrypt(data, password, e);
    }

    let blob;
    if (method === 0) blob = data;
    else if (method === 8) blob = ff.inflateSync(data);
    else throw new UserError(t('This archive uses a compression type that is not supported.'));
    if (crcCheck && crc32(blob) !== e.crc) {
      // For ZipCrypto a CRC mismatch almost always means a wrong password.
      if (e.method !== 99 && (e.flags & 1)) throw wrongPassword();
      const err = new Error('Corrupt data');
      err.code = 'CORRUPT';
      throw err;
    }

    const day = e.date & 31, mon = ((e.date >> 5) & 15) - 1, yr = (e.date >> 9) + 1980;
    const modified = new Date(yr, Math.max(0, mon), day || 1, e.time >> 11, (e.time >> 5) & 63, (e.time & 31) * 2).getTime();
    result.push({ path: e.path, blob: new Blob([blob]), modified });
    done += e.csize;
    if (onProgress) onProgress(total ? done / total : 1);
  }
  return result;
}
