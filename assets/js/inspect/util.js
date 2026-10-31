// util.js
// Formatting, text decoding, ZIP reading and XML helpers for the file inspector.
// Ported from the Distil prototype.

const U = {};
export default U;

const pageLang = () => (typeof document !== 'undefined' && document.documentElement.lang) || 'en';

/* ---------- formatting ---------- */
U.fmtBytes = (n) => {
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  const digits = n < 10 ? 2 : n < 100 ? 1 : 0;
  return `${n.toLocaleString(pageLang(), { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${units[i]}`;
};
U.fmtNum = (n) => Number(n).toLocaleString(pageLang());
U.fmtDuration = (s) => {
  if (!isFinite(s)) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
};
U.fmtDate = (d) => {
  if (!(d instanceof Date)) d = new Date(d);
  if (isNaN(d)) return '';
  return d.toLocaleString(pageLang(), { dateStyle: 'medium', timeStyle: 'short' });
};
/** A date that prints in the page's locale but stays a real date, so exports can use ISO 8601. */
class MetaDate extends Date {
  toString() { return U.fmtDate(new Date(this.getTime())); }
}
U.metaDate = (d) => {
  const date = d instanceof Date ? d : new Date(d);
  return isNaN(date) ? d : new MetaDate(date.getTime());
};
U.esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
U.extOf = (name) => {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
};
U.collapse = (s) =>
  s.replace(/[ \t ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
U.yield = () => new Promise((r) => setTimeout(r, 0));

/* ---------- bytes & text ---------- */
U.ascii = (u8, off, len) => {
  let s = '';
  const end = Math.min(u8.length, off + len);
  for (let i = off; i < end; i++) s += String.fromCharCode(u8[i]);
  return s;
};
U.decodeAs = (u8, enc) => {
  try { return new TextDecoder(enc).decode(u8); } catch (e) { return new TextDecoder('windows-1252').decode(u8); }
};

// Returns {text, encoding}. Honors BOMs, detects BOM-less UTF-16, falls back to Windows-1252.
U.decodeText = (u8) => {
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf)
    return { text: new TextDecoder('utf-8').decode(u8.subarray(3)), encoding: 'UTF-8 (BOM)' };
  if (u8[0] === 0xff && u8[1] === 0xfe)
    return { text: new TextDecoder('utf-16le').decode(u8.subarray(2)), encoding: 'UTF-16 LE' };
  if (u8[0] === 0xfe && u8[1] === 0xff)
    return { text: new TextDecoder('utf-16be').decode(u8.subarray(2)), encoding: 'UTF-16 BE' };
  const n = Math.min(u8.length, 4096);
  let ze = 0, zo = 0;
  for (let i = 0; i < n; i++) if (u8[i] === 0) (i % 2 ? zo++ : ze++);
  if (n > 8 && zo > n / 4 && ze < n / 50) return { text: new TextDecoder('utf-16le').decode(u8), encoding: 'UTF-16 LE' };
  if (n > 8 && ze > n / 4 && zo < n / 50) return { text: new TextDecoder('utf-16be').decode(u8), encoding: 'UTF-16 BE' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(u8), encoding: 'UTF-8' };
  } catch (e) {
    const best = U.detectCharset(u8)[0] || { enc: 'windows-1252', label: 'Windows-1252' };
    return { text: new TextDecoder(best.enc).decode(u8), encoding: best.label };
  }
};

// Heuristic: does this byte buffer look like text?
U.looksLikeText = (u8) => {
  const n = Math.min(u8.length, 8192);
  if (!n) return true;
  if ((u8[0] === 0xff && u8[1] === 0xfe) || (u8[0] === 0xfe && u8[1] === 0xff)) return true;
  let zeros = 0, ctrl = 0;
  for (let i = 0; i < n; i++) {
    const b = u8[i];
    if (b === 0) zeros++;
    else if (b < 9 || (b > 13 && b < 27) || (b > 27 && b < 32)) ctrl++;
  }
  if (zeros) {
    const t = U.decodeText(u8.subarray(0, n)).encoding;
    return t.startsWith('UTF-16');
  }
  return ctrl / n < 0.05;
};

U.stripHtml = (html) => {
  const d = new DOMParser().parseFromString(html, 'text/html');
  d.querySelectorAll('script,style,noscript,template').forEach((e) => e.remove());
  return U.collapse(U.domText(d.body || d.documentElement));
};

const BLOCK = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'BR', 'SECTION', 'ARTICLE', 'HEADER',
  'FOOTER', 'UL', 'OL', 'TABLE', 'BLOCKQUOTE', 'PRE', 'DT', 'DD', 'FIGURE', 'FIGCAPTION', 'HR', 'MAIN', 'NAV', 'ASIDE', 'FORM']);
// innerText-like extraction that works on inert (DOMParser) documents.
U.domText = (root) => {
  let out = '';
  (function walk(n) {
    if (n.nodeType === 3) { out += n.nodeValue.replace(/\s+/g, ' '); return; }
    if (n.nodeType !== 1) return;
    const tag = n.tagName.toUpperCase();
    if (tag === 'SCRIPT' || tag === 'STYLE') return;
    const block = BLOCK.has(tag);
    if (block) out += '\n';
    if (tag === 'PRE') { out += n.textContent; out += '\n'; return; }
    for (const c of n.childNodes) walk(c);
    if (tag === 'TD' || tag === 'TH') out += '\t';
    if (block) out += '\n';
  })(root);
  return out;
};

/* ---------- compression ---------- */
U.inflate = async (u8, format) => {
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream(format || 'deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

/* ---------- ZIP reader ---------- */
U.zipOpen = async (u8) => {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = u8.length - 22;
  const min = Math.max(0, u8.length - 65557);
  while (p >= min && dv.getUint32(p, true) !== 0x06054b50) p--;
  if (p < min) throw new Error('Not a valid ZIP archive');
  let count = dv.getUint16(p + 10, true);
  let off = dv.getUint32(p + 16, true);
  let zip64 = false;
  if (count === 0xffff || off === 0xffffffff) {
    const loc = p - 20;
    if (loc < 0 || dv.getUint32(loc, true) !== 0x07064b50) throw new Error('Damaged ZIP64 archive');
    const end = Number(dv.getBigUint64(loc + 8, true));
    count = Number(dv.getBigUint64(end + 32, true));
    off = Number(dv.getBigUint64(end + 48, true));
    zip64 = true;
  }
  const entries = [];
  const utf8 = new TextDecoder('utf-8');
  const latin = new TextDecoder('windows-1252');
  for (let i = 0; i < count; i++) {
    if (off + 46 > u8.length || dv.getUint32(off, true) !== 0x02014b50) break;
    const flags = dv.getUint16(off + 8, true);
    const nl = dv.getUint16(off + 28, true), el = dv.getUint16(off + 30, true), cl = dv.getUint16(off + 32, true);
    const nameBytes = u8.subarray(off + 46, off + 46 + nl);
    const name = (flags & 0x800 ? utf8 : latin).decode(nameBytes);
    const t = dv.getUint16(off + 12, true), d = dv.getUint16(off + 14, true);
    let csize = dv.getUint32(off + 20, true), size = dv.getUint32(off + 24, true), lo = dv.getUint32(off + 42, true);
    if (zip64 && (csize === 0xffffffff || size === 0xffffffff || lo === 0xffffffff)) {
      // Sizes moved to the ZIP64 extra field, in this fixed order
      let q = off + 46 + nl;
      const end = q + el;
      while (q + 4 <= end) {
        const id = dv.getUint16(q, true), len = dv.getUint16(q + 2, true);
        if (id === 1) {
          let v = q + 4;
          if (size === 0xffffffff) { size = Number(dv.getBigUint64(v, true)); v += 8; }
          if (csize === 0xffffffff) { csize = Number(dv.getBigUint64(v, true)); v += 8; }
          if (lo === 0xffffffff) lo = Number(dv.getBigUint64(v, true));
          break;
        }
        q += 4 + len;
      }
    }
    entries.push({
      name,
      method: dv.getUint16(off + 10, true),
      csize,
      size,
      lo,
      dir: name.endsWith('/'),
      encrypted: !!(flags & 1),
      date: new Date(((d >> 9) & 127) + 1980, ((d >> 5) & 15) - 1, d & 31, (t >> 11) & 31, (t >> 5) & 63, (t & 31) * 2),
    });
    off += 46 + nl + el + cl;
  }
  const byName = new Map(entries.map((e) => [e.name, e]));
  const read = async (e) => {
    if (e.encrypted) throw new Error('Encrypted entry: ' + e.name);
    const nl = dv.getUint16(e.lo + 26, true), el = dv.getUint16(e.lo + 28, true);
    const s = e.lo + 30 + nl + el;
    const data = u8.subarray(s, s + e.csize);
    if (e.method === 0) return data;
    if (e.method === 8) return U.inflate(data, 'deflate-raw');
    throw new Error('Unsupported ZIP compression method ' + e.method);
  };
  return {
    entries,
    zip64,
    read,
    has: (n) => byName.has(n),
    bytes: async (n) => (byName.has(n) ? read(byName.get(n)) : null),
    text: async (n) => {
      const d = byName.has(n) ? await read(byName.get(n)) : null;
      return d ? U.decodeText(d).text : null;
    },
  };
};

/* ---------- XML ---------- */
U.xml = (str) => {
  const d = new DOMParser().parseFromString(str, 'application/xml');
  if (d.getElementsByTagName('parsererror').length) throw new Error('Malformed XML');
  return d;
};
U.tags = (node, local) => Array.from(node.getElementsByTagNameNS('*', local));
U.first = (node, local) => node.getElementsByTagNameNS('*', local)[0] || null;
U.firstText = (node, local) => {
  const e = node && U.first(node, local);
  return e ? e.textContent.trim() : '';
};
U.children = (node, local) => Array.from(node.children).filter((c) => !local || c.localName === local);

/* ---------- downloads / clipboard ---------- */
U.download = (name, data, type) => {
  const url = URL.createObjectURL(new Blob([data], { type: type || 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};
U.copy = async (text) => {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { /* ignore */ }
    ta.remove();
    return ok;
  }
};
U.hash = async (u8, algo) => {
  if (!(window.crypto && crypto.subtle)) return '';
  const h = new Uint8Array(await crypto.subtle.digest(algo, u8));
  return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
};

/* ---------- digests and byte statistics ---------- */
// Web Crypto has no MD5 or CRC32, and Tika reports MD5 by default.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
U.crc32 = (u8) => {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 255] ^ (c >>> 8);
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
};

const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
U.md5 = (u8) => {
  const n = u8.length;
  const tail = new Uint8Array(((n % 64) < 56 ? 64 : 128));
  const rest = n % 64;
  tail.set(u8.subarray(n - rest));
  tail[rest] = 0x80;
  const tv = new DataView(tail.buffer);
  tv.setUint32(tail.length - 8, (n * 8) >>> 0, true);
  tv.setUint32(tail.length - 4, Math.floor(n / 2 ** 29), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const m = new Uint32Array(16);
  const block = (view, off) => {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(off + i * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      const round = i >> 4;
      if (round === 0) { f = (b & c) | (~b & d); g = i; }
      else if (round === 1) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (round === 2) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const x = (a + f + MD5_K[i] + m[g]) | 0;
      const s = MD5_S[round * 4 + (i % 4)];
      a = d; d = c; c = b;
      b = (b + ((x << s) | (x >>> (32 - s)))) | 0;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  };
  for (let off = 0; off + 64 <= n; off += 64) block(dv, off);
  for (let off = 0; off < tail.length; off += 64) block(tv, off);
  const out = new Uint8Array(new Uint32Array([a0, b0, c0, d0]).buffer);
  return Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('');
};

/** Shannon entropy in bits per byte, plus the histogram it came from. */
U.byteStats = (u8) => {
  const hist = new Uint32Array(256);
  for (let i = 0; i < u8.length; i++) hist[u8[i]]++;
  let entropy = 0, printable = 0;
  for (let b = 0; b < 256; b++) {
    if (hist[b]) { const p = hist[b] / u8.length; entropy -= p * Math.log2(p); }
    if ((b >= 32 && b < 127) || b === 9 || b === 10 || b === 13) printable += hist[b];
  }
  return { hist, entropy, printable: u8.length ? printable / u8.length : 0 };
};

/* ---------- encoding detection ---------- */
// BOM-less, non-UTF-8 text gets scored per candidate. Without this, Polish and Czech
// files in Windows-1250 would come out as mojibake under the Windows-1252 fallback.
const CHARSET_HINTS = [
  { enc: 'windows-1250', label: 'Windows-1250', chars: 'ąćęłńśźżĄĆĘŁŃŚŹŻěščřžýáíéůúťďňĚŠČŘŽÝÁÍÉŮÚŤĎŇ' },
  { enc: 'iso-8859-2', label: 'ISO-8859-2', chars: 'ąćęłńśźżĄĆĘŁŃŚŹŻěščřžýáíéůúťďňĚŠČŘŽÝÁÍÉŮÚŤĎŇ' },
  { enc: 'windows-1252', label: 'Windows-1252', chars: 'äöüÄÖÜßéèêàâçñóíáúëïôûùÉÈ' },
  { enc: 'windows-1251', label: 'Windows-1251', chars: 'аеиоунтсрвлкмдпяьыгзбчйхжшюцщэфъёАЕИОУНТСРВ' },
  { enc: 'koi8-r', label: 'KOI8-R', chars: 'аеиоунтсрвлкмдпяьыгзбчйхжшюцщэфъёАЕИОУНТСРВ' },
];
U.detectCharset = (u8) => {
  const sample = u8.subarray(0, 65536);
  let high = 0;
  for (let i = 0; i < sample.length; i++) if (sample[i] >= 0x80) high++;
  const results = [];
  for (const c of CHARSET_HINTS) {
    let text;
    try { text = new TextDecoder(c.enc).decode(sample); } catch (e) { continue; }
    let hits = 0, bad = 0;
    for (const ch of text) {
      const code = ch.codePointAt(0);
      if (code < 0x80) continue;
      if (c.chars.includes(ch)) hits += 2;
      else if (/\p{L}/u.test(ch)) hits += 0.1;
      else bad += 1;
    }
    results.push({ enc: c.enc, label: c.label, score: high ? (hits - bad) / high : 0 });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
};

/* ---------- ISO-style timestamps for exports ---------- */
U.iso = (d) => {
  if (!(d instanceof Date)) d = new Date(d);
  return isNaN(d) ? '' : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
};
