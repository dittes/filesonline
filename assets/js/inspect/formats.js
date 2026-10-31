// formats.js
// Parsers beyond the common document types: legacy Office (OLE2), Outlook messages, fonts,
// executables, more archives and assorted binary and text formats. Each registers itself
// with the engine in extractors.js.

import U from './util.js';
import E from './extractors.js';
import { t } from './i18n.js';

const { newResult, put, fact, hexdump, countWords, extractStrings } = E.helpers;

const ascii = (u8, o, l) => U.ascii(u8, o, l);
const cstr = (u8, o, l) => ascii(u8, o, l).replace(/\0.*$/s, '').trim();
const view = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
const hexOf = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join(' ');

function basicBinary(r, u8, opts = {}) {
  r.noSummary = true;
  if (!opts.noHex) r.sections.push({ title: t('Hex dump (first 512 bytes)'), hex: hexdump(u8, 512) });
  if (opts.strings !== false) {
    const strs = extractStrings(u8.subarray(0, Math.min(u8.length, 8e6)), 8, 800);
    if (!r.text) r.text = strs.join('\n');
    if (strs.length) fact(r, 'Printable strings', U.fmtNum(strs.length));
  }
}

/* ---------- OLE2 compound files ---------- */
function openCfb(u8) {
  const dv = view(u8);
  const secSize = 1 << dv.getUint16(30, true), miniSize = 1 << dv.getUint16(32, true);
  const offset = (s) => (s + 1) * secSize;
  const FREE = 0xffffffff, END = 0xfffffffe;

  // The sector allocation table is listed in the header, continued through DIFAT sectors
  const difat = [];
  for (let i = 0; i < 109; i++) { const v = dv.getUint32(76 + i * 4, true); if (v !== FREE) difat.push(v); }
  let next = dv.getUint32(68, true), guard = 0;
  while (next !== END && next !== FREE && guard++ < 10000 && offset(next) + secSize <= u8.length) {
    const o = offset(next);
    for (let i = 0; i < secSize / 4 - 1; i++) { const v = dv.getUint32(o + i * 4, true); if (v !== FREE) difat.push(v); }
    next = dv.getUint32(o + secSize - 4, true);
  }
  const fat = [];
  for (const s of difat) {
    const o = offset(s);
    if (o + secSize > u8.length) continue;
    for (let i = 0; i < secSize / 4; i++) fat.push(dv.getUint32(o + i * 4, true));
  }
  const chain = (start, table, cap) => {
    const out = [];
    for (let s = start; s !== END && s !== FREE && s < table.length && out.length < cap; s = table[s]) out.push(s);
    return out;
  };
  const readChain = (start, size) => {
    const secs = chain(start, fat, size ? Math.ceil(size / secSize) + 1 : 1e7);
    const out = new Uint8Array(size || secs.length * secSize);
    secs.forEach((s, i) => {
      const o = offset(s);
      const part = u8.subarray(o, o + secSize);
      if (i * secSize + part.length <= out.length) out.set(part, i * secSize);
      else out.set(part.subarray(0, Math.max(0, out.length - i * secSize)), i * secSize);
    });
    return out;
  };

  const dirBytes = readChain(dv.getUint32(48, true), 0);
  const dirView = view(dirBytes);
  const entries = [];
  for (let i = 0; i + 128 <= dirBytes.length; i += 128) {
    const nameLen = dirView.getUint16(i + 64, true);
    if (!nameLen) { entries.push(null); continue; }
    entries.push({
      name: new TextDecoder('utf-16le').decode(dirBytes.subarray(i, i + Math.max(0, nameLen - 2))),
      type: dirBytes[i + 66],
      left: dirView.getUint32(i + 68, true), right: dirView.getUint32(i + 72, true), child: dirView.getUint32(i + 76, true),
      start: dirView.getUint32(i + 116, true),
      size: dirView.getUint32(i + 120, true),
    });
  }
  const root = entries[0];
  const miniFat = [];
  const miniFatBytes = readChain(dv.getUint32(60, true), dv.getUint32(64, true) * secSize);
  const miniView = view(miniFatBytes);
  for (let i = 0; i + 4 <= miniFatBytes.length; i += 4) miniFat.push(miniView.getUint32(i, true));
  const miniStream = root ? readChain(root.start, root.size) : new Uint8Array();
  const cutoff = dv.getUint32(56, true);

  const readEntry = (e) => {
    if (e.size < cutoff) {
      const out = new Uint8Array(e.size);
      chain(e.start, miniFat, Math.ceil(e.size / miniSize) + 1).forEach((s, i) => {
        const part = miniStream.subarray(s * miniSize, (s + 1) * miniSize);
        out.set(part.subarray(0, Math.max(0, Math.min(part.length, e.size - i * miniSize))), i * miniSize);
      });
      return out;
    }
    return readChain(e.start, e.size);
  };

  // Walk the red-black tree of each storage to get full paths
  const paths = new Map();
  const walk = (id, prefix, seen) => {
    if (id === FREE || id >= entries.length || seen.has(id)) return;
    seen.add(id);
    const e = entries[id];
    if (!e) return;
    const path = prefix + e.name;
    paths.set(path, e);
    walk(e.left, prefix, seen);
    walk(e.right, prefix, seen);
    if (e.type === 1) walk(e.child, `${path}/`, seen);
  };
  if (root) walk(root.child, '', new Set());
  return {
    paths,
    stream: (path) => { const e = paths.get(path); return e && e.type === 2 ? readEntry(e) : null; },
  };
}

const FILETIME_EPOCH = 11644473600000;
function readPropertySet(u8) {
  const dv = view(u8);
  const out = {};
  if (u8.length < 48 || dv.getUint16(0, true) !== 0xfffe) return out;
  const sectionOff = dv.getUint32(44, true);
  const count = dv.getUint32(sectionOff + 4, true);
  let codepage = 1252;
  const items = [];
  for (let i = 0; i < count && i < 500; i++) {
    items.push([dv.getUint32(sectionOff + 8 + i * 8, true), sectionOff + dv.getUint32(sectionOff + 12 + i * 8, true)]);
  }
  for (const [pid, off] of items) if (pid === 1 && off + 8 <= u8.length) codepage = dv.getUint16(off + 4, true);
  const textDecoder = (() => {
    try { return new TextDecoder(codepage === 65001 ? 'utf-8' : codepage === 1200 ? 'utf-16le' : `windows-${codepage}`); } catch (e) { return new TextDecoder('windows-1252'); }
  })();
  for (const [pid, off] of items) {
    if (off + 8 > u8.length) continue;
    const type = dv.getUint16(off, true);
    if (type === 2) out[pid] = dv.getInt16(off + 4, true);
    else if (type === 3) out[pid] = dv.getInt32(off + 4, true);
    else if (type === 11) out[pid] = !!dv.getUint16(off + 4, true);
    else if (type === 30) { const n = dv.getUint32(off + 4, true); out[pid] = textDecoder.decode(u8.subarray(off + 8, off + 8 + n)).replace(/\0.*$/s, ''); }
    else if (type === 31) { const n = dv.getUint32(off + 4, true); out[pid] = new TextDecoder('utf-16le').decode(u8.subarray(off + 8, off + 8 + n * 2)).replace(/\0.*$/s, ''); }
    else if (type === 64) {
      const ticks = dv.getUint32(off + 4, true) + dv.getUint32(off + 8, true) * 2 ** 32;
      out[pid] = { filetime: ticks / 10000 - FILETIME_EPOCH, ticks };
    }
  }
  return out;
}

function oleProperties(r, cfb) {
  const summary = cfb.stream('\x05SummaryInformation');
  if (summary) {
    const p = readPropertySet(summary);
    const date = (v) => (v && v.filetime > 0 ? U.metaDate(new Date(v.filetime)) : '');
    put(r, 'Document', 'Title', p[2]); put(r, 'Document', 'Subject', p[3]); put(r, 'Document', 'Author', p[4]);
    put(r, 'Document', 'Keywords', p[5]); put(r, 'Document', 'Description', p[6]); put(r, 'Document', 'Template', p[7]);
    put(r, 'Document', 'Last modified by', p[8]); put(r, 'Document', 'Revision', p[9]);
    put(r, 'Document', 'Last printed', date(p[11])); put(r, 'Document', 'Created', date(p[12])); put(r, 'Document', 'Modified', date(p[13]));
    if (p[10] && p[10].ticks) put(r, 'Application', 'Total editing time (min)', Math.round(p[10].ticks / 6e8));
    put(r, 'Application', 'Pages', p[14]); put(r, 'Application', 'Words (reported)', p[15]); put(r, 'Application', 'Characters', p[16]);
    put(r, 'Application', 'Application', p[18]);
    if (p[2]) r.title = p[2];
  }
  const doc = cfb.stream('\x05DocumentSummaryInformation');
  if (doc) {
    const p = readPropertySet(doc);
    put(r, 'Document', 'Category', p[2]); put(r, 'Application', 'Company', p[15]); put(r, 'Application', 'Manager', p[14]);
    put(r, 'Application', 'Slides', p[7]); put(r, 'Application', 'Notes', p[8]); put(r, 'Application', 'Hidden slides', p[9]);
  }
  const macros = [...cfb.paths.keys()].some((k) => /(^|\/)(VBA|_VBA_PROJECT_CUR|Macros)(\/|$)/i.test(k));
  if (macros) { put(r, 'Security', 'Macros', 'Yes'); r.warnings.push(t('This document contains macros. Only open it if you trust where it came from.')); }
}

/** Word 97+ text, reassembled from the piece table. */
function wordText(cfb) {
  const wd = cfb.stream('WordDocument');
  if (!wd) return '';
  const dv = view(wd);
  const flags = dv.getUint16(0x0a, true);
  if (flags & 0x100) return ''; // encrypted
  const table = cfb.stream(flags & 0x200 ? '1Table' : '0Table');
  if (!table) return '';
  const fc = dv.getUint32(0x01a2, true), lcb = dv.getUint32(0x01a6, true);
  if (!lcb || fc + lcb > table.length) return '';
  const tv = view(table);
  let p = fc;
  const end = fc + lcb;
  while (p < end && table[p] === 1) p += 3 + tv.getUint16(p + 1, true);
  if (table[p] !== 2) return '';
  const plc = tv.getUint32(p + 1, true);
  const pieces = (plc - 4) / 12;
  const base = p + 5;
  const cp1252 = new TextDecoder('windows-1252'), utf16 = new TextDecoder('utf-16le');
  let text = '';
  for (let i = 0; i < pieces; i++) {
    const a = tv.getUint32(base + i * 4, true), b = tv.getUint32(base + (i + 1) * 4, true);
    const fcRaw = tv.getUint32(base + (pieces + 1) * 4 + i * 8 + 2, true);
    const compressed = (fcRaw & 0x40000000) !== 0;
    const off = fcRaw & 0x3fffffff;
    const n = b - a;
    if (compressed) text += cp1252.decode(wd.subarray(off / 2, off / 2 + n));
    else text += utf16.decode(wd.subarray(off, off + n * 2));
  }
  return text
    .replace(/\x13[^\x14\x15]*\x14?/g, '').replace(/\x15/g, '') // field codes
    .replace(/\x07/g, '\t').replace(/[\r\x0b\x0c]/g, '\n')
    .replace(/[\x00-\x08\x0e-\x1f]/g, '')
    .replace(/\n{3,}/g, '\n\n').trim();
}

/** Excel 97+ workbook: sheet names, shared strings and cell values from BIFF8 records. */
function xlsTables(stream) {
  const dv = view(stream);
  const sheets = [], sst = [];
  const records = [];
  for (let p = 0; p + 4 <= stream.length;) {
    const id = dv.getUint16(p, true), len = dv.getUint16(p + 2, true);
    records.push({ id, off: p + 4, len });
    p += 4 + len;
  }
  const cellValueRk = (rk) => {
    let v;
    if (rk & 2) v = rk >> 2;
    else {
      const b = new DataView(new ArrayBuffer(8));
      b.setUint32(4, (rk & 0xfffffffc) >>> 0, true);
      v = b.getFloat64(0, true);
    }
    return rk & 1 ? v / 100 : v;
  };
  // Shared strings can spill into CONTINUE records, and each spill restates the width flag
  const readSst = (i) => {
    let rec = records[i], p = rec.off + 8, end = rec.off + rec.len, ri = i;
    const total = dv.getUint32(rec.off + 4, true);
    const advance = () => { const nx = records[ri + 1]; if (!nx || nx.id !== 0x3c) return false; ri++; p = nx.off; end = nx.off + nx.len; return true; };
    for (let s = 0; s < total && s < 500000; s++) {
      if (p + 3 > end && !advance()) break;
      const chars = dv.getUint16(p, true); p += 2;
      let flags = stream[p++];
      const rich = flags & 8 ? dv.getUint16(p, true) : 0; if (flags & 8) p += 2;
      const ext = flags & 4 ? dv.getUint32(p, true) : 0; if (flags & 4) p += 4;
      let wide = !!(flags & 1), left = chars, out = '';
      while (left > 0) {
        if (p >= end) { if (!advance()) break; flags = stream[p++]; wide = !!(flags & 1); }
        const avail = wide ? (end - p) >> 1 : end - p;
        const take = Math.min(avail, left);
        if (wide) out += new TextDecoder('utf-16le').decode(stream.subarray(p, p + take * 2));
        else out += new TextDecoder('windows-1252').decode(stream.subarray(p, p + take));
        p += wide ? take * 2 : take;
        left -= take;
        if (take === 0 && !advance()) break;
      }
      sst.push(out);
      let skip = rich * 4 + ext;
      while (skip > 0) {
        const step = Math.min(skip, end - p);
        p += step; skip -= step;
        if (skip > 0 && !advance()) break;
      }
    }
  };
  let current = null, sheetIndex = -1;
  records.forEach((rec, i) => {
    const o = rec.off;
    if (rec.id === 0x85) {
      const nameLen = stream[o + 6], wide = stream[o + 7] & 1;
      const raw = stream.subarray(o + 8, o + 8 + nameLen * (wide ? 2 : 1));
      sheets.push({ name: new TextDecoder(wide ? 'utf-16le' : 'windows-1252').decode(raw), hidden: stream[o + 4] !== 0, grid: [] });
    } else if (rec.id === 0xfc) readSst(i);
    else if (rec.id === 0x809 && dv.getUint16(o + 2, true) === 0x10) { sheetIndex++; current = sheets[sheetIndex] || null; }
    else if (current) {
      const set = (v) => {
        const row = dv.getUint16(o, true), col = dv.getUint16(o + 2, true);
        if (row > 20000 || col > 300) return;
        (current.grid[row] = current.grid[row] || [])[col] = v;
      };
      if (rec.id === 0xfd) set(sst[dv.getUint32(o + 6, true)] ?? '');
      else if (rec.id === 0x203) set(dv.getFloat64(o + 6, true));
      else if (rec.id === 0x27e) set(cellValueRk(dv.getUint32(o + 6, true)));
      else if (rec.id === 0xbd) {
        const row = dv.getUint16(o, true), first = dv.getUint16(o + 2, true), last = dv.getUint16(o + rec.len - 2, true);
        for (let c = first, q = o + 4; c <= last; c++, q += 6) {
          if (row <= 20000 && c <= 300) (current.grid[row] = current.grid[row] || [])[c] = cellValueRk(dv.getUint32(q + 2, true));
        }
      }
    }
  });
  return sheets.map((s) => {
    const cols = s.grid.reduce((m, row) => Math.max(m, row ? row.length : 0), 0);
    const rows = s.grid.filter(Boolean).map((row) => Array.from({ length: cols }, (_, c) => (row[c] === undefined ? '' : String(row[c]))));
    return { name: s.name, hidden: s.hidden, rows, cols };
  });
}

/** PowerPoint 97+ slide text from the record tree. */
function pptText(stream) {
  const dv = view(stream);
  const parts = [];
  let slides = 0;
  const walk = (start, end, depth) => {
    let p = start;
    while (p + 8 <= end) {
      const verInst = dv.getUint16(p, true), type = dv.getUint16(p + 2, true), len = dv.getUint32(p + 4, true);
      const body = p + 8;
      if (body + len > end) break;
      if (type === 0x3ee) slides++;
      if ((verInst & 0xf) === 0xf && depth < 12) walk(body, body + len, depth + 1);
      else if (type === 0xfa0) parts.push(new TextDecoder('utf-16le').decode(stream.subarray(body, body + len)));
      else if (type === 0xfa8) parts.push(new TextDecoder('windows-1252').decode(stream.subarray(body, body + len)));
      p = body + len;
    }
  };
  walk(0, stream.length, 0);
  const seen = new Set();
  const lines = parts.map((s) => s.replace(/\r/g, '\n').trim()).filter((s) => s && !seen.has(s) && seen.add(s));
  return { text: lines.join('\n\n'), slides };
}

function msgFields(r, cfb, u8) {
  const prop = (id) => {
    const wide = cfb.stream(`__substg1.0_${id}001F`);
    if (wide) return new TextDecoder('utf-16le').decode(wide).replace(/\0+$/, '');
    const narrow = cfb.stream(`__substg1.0_${id}001E`);
    return narrow ? new TextDecoder('windows-1252').decode(narrow).replace(/\0+$/, '') : '';
  };
  const subject = prop('0037'), from = prop('0C1A'), fromAddr = prop('5D01') || prop('0C1F');
  put(r, 'Email', 'Subject', subject); put(r, 'Email', 'From', fromAddr ? `${from} <${fromAddr}>` : from);
  put(r, 'Email', 'To', prop('0E04')); put(r, 'Email', 'Cc', prop('0E03')); put(r, 'Email', 'Message-Id', prop('1035'));
  const headers = prop('007D');
  if (headers) put(r, 'Email', 'Hops (Received)', (headers.match(/^Received:/gim) || []).length || '');
  const body = prop('1000') || (cfb.stream('__substg1.0_1013001F') ? U.stripHtml(prop('1013')) : '');
  r.summaryText = body;
  r.text = `Subject: ${subject}\nFrom: ${from}\nTo: ${prop('0E04')}\n\n${U.collapse(body)}`;
  r.title = subject;
  fact(r, 'From', from);

  const attachments = new Set();
  for (const key of cfb.paths.keys()) { const m = /^(__attach_version1\.0_#[0-9A-F]+)\//.exec(key); if (m) attachments.add(m[1]); }
  r.embedded = [...attachments].map((dir, i) => {
    const nameStream = cfb.stream(`${dir}/__substg1.0_3707001F`) || cfb.stream(`${dir}/__substg1.0_3704001F`);
    const name = nameStream ? new TextDecoder('utf-16le').decode(nameStream).replace(/\0+$/, '') : `attachment-${i + 1}`;
    const data = cfb.stream(`${dir}/__substg1.0_37010102`);
    return { name, size: data ? data.length : 0, read: async () => data || new Uint8Array() };
  });
  put(r, 'Email', 'Attachments', r.embedded.length || '');
  fact(r, 'Attachments', r.embedded.length);
}

async function handleOle(u8, name) {
  const r = newResult();
  let cfb;
  try { cfb = openCfb(u8); } catch (e) { cfb = null; }
  if (!cfb) {
    r.warnings.push(t('Could not read the internal structure of this file.'));
    basicBinary(r, u8);
    return r;
  }
  put(r, 'Document', 'Format', 'OLE2 compound file');
  put(r, 'Document', 'Internal streams', cfb.paths.size);
  oleProperties(r, cfb);
  r.sections.push({ title: t('Internal streams'), list: [...cfb.paths.entries()].slice(0, 300).map(([k, e]) => (e.type === 1 ? `${k}/` : `${k} · ${U.fmtBytes(e.size)}`)) });

  if (cfb.paths.has('EncryptedPackage')) {
    r.kind = 'Compound document (OLE2)';
    put(r, 'Security', 'Encrypted', 'Yes');
    r.warnings.push(t('This is a password-protected Office file. Its contents are encrypted and cannot be read.'));
    r.noSummary = true;
    return r;
  }
  if (cfb.paths.has('WordDocument')) {
    r.kind = 'Word 97–2003 document'; r.mime = 'application/msword'; r.parser = 'OLE2/Word';
    r.text = wordText(cfb);
    const words = countWords(r.text);
    put(r, 'Structure', 'Words (counted)', U.fmtNum(words)); fact(r, 'Words', U.fmtNum(words));
    if (!r.text) r.warnings.push(t('No text could be read. The document may be encrypted.'));
  } else if (cfb.paths.has('Workbook') || cfb.paths.has('Book')) {
    r.kind = 'Excel 97–2003 workbook'; r.mime = 'application/vnd.ms-excel'; r.parser = 'OLE2/BIFF8';
    const sheets = xlsTables(cfb.stream('Workbook') || cfb.stream('Book'));
    let total = 0;
    const parts = [];
    sheets.forEach((s, i) => {
      total += s.rows.length;
      if (s.rows.length) r.tables.push({ name: s.name, rows: s.rows });
      parts.push(`# ${s.name}\n${s.rows.map((x) => x.join('\t')).join('\n')}`);
      r.sections.push({ title: `${s.name} · ${U.fmtNum(s.rows.length)} × ${s.cols}${s.hidden ? ` · ${t('hidden')}` : ''}`, table: { rows: s.rows.slice(0, 40) }, open: i === 0 });
    });
    r.text = parts.join('\n\n');
    r.sheets = sheets;
    const hidden = sheets.filter((s) => s.hidden).length;
    put(r, 'Workbook', 'Sheets', sheets.length); put(r, 'Workbook', 'Rows (all sheets)', U.fmtNum(total));
    put(r, 'Workbook', 'Sheet names', sheets.map((s) => s.name).join(', ')); put(r, 'Workbook', 'Hidden sheets', hidden || '');
    fact(r, 'Sheets', sheets.length); fact(r, 'Rows', U.fmtNum(total));
  } else if (cfb.paths.has('PowerPoint Document')) {
    r.kind = 'PowerPoint 97–2003 presentation'; r.mime = 'application/vnd.ms-powerpoint'; r.parser = 'OLE2/PowerPoint';
    const ppt = pptText(cfb.stream('PowerPoint Document'));
    r.text = ppt.text;
    put(r, 'Presentation', 'Slides', ppt.slides); fact(r, 'Slides', ppt.slides); fact(r, 'Words', U.fmtNum(countWords(r.text)));
  } else if ([...cfb.paths.keys()].some((k) => k.startsWith('__substg1.0_'))) {
    r.kind = 'Outlook message'; r.mime = 'application/vnd.ms-outlook'; r.parser = 'OLE2/MSG';
    msgFields(r, cfb, u8);
  } else {
    r.kind = 'Compound document (OLE2)';
    r.noSummary = true;
    basicBinary(r, u8, { noHex: true });
  }
  return r;
}

/* ---------- Fonts ---------- */
const NAME_IDS = { 0: 'Copyright', 1: 'Family', 2: 'Subfamily', 3: 'Unique ID', 4: 'Full name', 5: 'Version', 6: 'PostScript name', 7: 'Trademark', 8: 'Manufacturer', 9: 'Designer', 10: 'Description', 11: 'Vendor URL', 12: 'Designer URL', 13: 'License', 14: 'License URL' };

function readSfnt(r, u8, tableReader) {
  const name = tableReader('name'), maxp = tableReader('maxp'), head = tableReader('head'), os2 = tableReader('OS/2');
  if (name && name.length > 6) {
    const dv = view(name);
    const count = dv.getUint16(2), strOff = dv.getUint16(4);
    const found = {};
    for (let i = 0; i < count; i++) {
      const o = 6 + i * 12;
      if (o + 12 > name.length) break;
      const platform = dv.getUint16(o), lang = dv.getUint16(o + 4), id = dv.getUint16(o + 6), len = dv.getUint16(o + 8), off = dv.getUint16(o + 10);
      if (!NAME_IDS[id]) continue;
      const bytes = name.subarray(strOff + off, strOff + off + len);
      const value = platform === 1 ? new TextDecoder('macintosh').decode(bytes) : new TextDecoder('utf-16be').decode(bytes);
      const preferred = lang === 0x409 || lang === 0;
      if (!found[id] || preferred) found[id] = value;
    }
    Object.entries(found).forEach(([id, v]) => put(r, 'Font', NAME_IDS[id], v.trim().slice(0, 1000)));
    r.title = found[4] || found[1] || '';
    if (found[1]) fact(r, 'Family', found[1]);
    if (found[2]) fact(r, 'Style', found[2]);
  }
  if (maxp && maxp.length >= 6) { const g = view(maxp).getUint16(4); put(r, 'Font', 'Glyphs', U.fmtNum(g)); fact(r, 'Glyphs', U.fmtNum(g)); }
  if (head && head.length >= 54) {
    const dv = view(head);
    put(r, 'Font', 'Units per em', dv.getUint16(18));
    const mac = (o) => Number(dv.getBigUint64(o)) * 1000 - 2082844800000;
    const created = mac(20), modified = mac(28);
    if (created > 0) put(r, 'Font', 'Created', U.metaDate(new Date(created)));
    if (modified > 0) put(r, 'Font', 'Modified', U.metaDate(new Date(modified)));
  }
  if (os2 && os2.length >= 6) put(r, 'Font', 'Weight class', view(os2).getUint16(4));
}

async function handleFont(u8, name, det) {
  const r = newResult();
  r.noText = true; r.noSummary = true;
  const dv = view(u8);
  if (det.key === 'woff2') {
    put(r, 'Font', 'Tables', dv.getUint16(12));
    put(r, 'Font', 'Compressed size', U.fmtBytes(dv.getUint32(20)));
    put(r, 'Font', 'Original size', U.fmtBytes(dv.getUint32(16)));
    r.warnings.push(t('WOFF2 is compressed with Brotli, so only its header can be read here.'));
    return r;
  }
  if (det.key === 'woff') {
    const count = dv.getUint16(12);
    const tables = new Map();
    for (let i = 0; i < count; i++) {
      const o = 44 + i * 20;
      tables.set(ascii(u8, o, 4), { off: dv.getUint32(o + 4), comp: dv.getUint32(o + 8), orig: dv.getUint32(o + 12) });
    }
    const unpacked = new Map();
    for (const tag of ['name', 'maxp', 'head', 'OS/2']) {
      const e = tables.get(tag);
      if (!e) continue;
      const raw = u8.subarray(e.off, e.off + e.comp);
      try { unpacked.set(tag, e.comp === e.orig ? raw : await U.inflate(raw, 'deflate')); } catch (err) { /* table stays unread */ }
    }
    put(r, 'Font', 'Tables', count);
    readSfnt(r, u8, (tag) => unpacked.get(tag));
    return r;
  }
  let base = 0;
  if (ascii(u8, 0, 4) === 'ttcf') { put(r, 'Font', 'Fonts in collection', dv.getUint32(8)); base = dv.getUint32(12); }
  const count = dv.getUint16(base + 4);
  const tables = new Map();
  for (let i = 0; i < count; i++) {
    const o = base + 12 + i * 16;
    if (o + 16 > u8.length) break;
    tables.set(ascii(u8, o, 4), [dv.getUint32(o + 8), dv.getUint32(o + 12)]);
  }
  put(r, 'Font', 'Tables', count);
  put(r, 'Font', 'Outline format', ascii(u8, base, 4) === 'OTTO' ? 'CFF (PostScript)' : 'TrueType');
  readSfnt(r, u8, (tag) => { const e = tables.get(tag); return e ? u8.subarray(e[0], e[0] + e[1]) : null; });
  return r;
}

/* ---------- Executables ---------- */
const PE_MACHINES = { 0x14c: 'x86', 0x8664: 'x64', 0x1c0: 'ARM', 0xaa64: 'ARM64', 0x200: 'Itanium' };
const PE_SUBSYSTEMS = { 1: 'Native', 2: 'Windows GUI', 3: 'Windows console', 9: 'Windows CE', 10: 'EFI application' };
function handlePe(r, u8) {
  const dv = view(u8);
  const pe = dv.getUint32(0x3c, true);
  if (pe + 24 > u8.length || ascii(u8, pe, 4) !== 'PE\0\0') { put(r, 'Executable', 'Format', 'MS-DOS executable'); return; }
  const machine = dv.getUint16(pe + 4, true), secCount = dv.getUint16(pe + 6, true), stamp = dv.getUint32(pe + 8, true);
  const optSize = dv.getUint16(pe + 20, true), chars = dv.getUint16(pe + 22, true), opt = pe + 24;
  const is64 = dv.getUint16(opt, true) === 0x20b;
  put(r, 'Executable', 'Format', is64 ? 'PE32+' : 'PE32');
  put(r, 'Executable', 'Architecture', PE_MACHINES[machine] || `0x${machine.toString(16)}`);
  put(r, 'Executable', 'Kind', chars & 0x2000 ? 'DLL' : 'Program');
  put(r, 'Executable', 'Subsystem', PE_SUBSYSTEMS[dv.getUint16(opt + 68, true)] || '');
  if (stamp) put(r, 'Executable', 'Build time', U.metaDate(new Date(stamp * 1000)));
  put(r, 'Executable', 'Sections', secCount);
  const dirBase = opt + (is64 ? 112 : 96);
  if (dv.getUint32(dirBase + 14 * 8, true)) put(r, 'Executable', '.NET assembly', 'Yes');
  if (dv.getUint32(dirBase + 4 * 8, true)) put(r, 'Executable', 'Digitally signed', 'Yes');
  const names = [];
  for (let i = 0; i < secCount && i < 96; i++) {
    const o = opt + optSize + i * 40;
    names.push(`${cstr(u8, o, 8)} · ${U.fmtBytes(dv.getUint32(o + 8, true))}`);
  }
  r.sections.push({ title: t('Sections'), list: names, open: true });
  fact(r, 'Architecture', PE_MACHINES[machine]);
}
const ELF_MACHINES = { 3: 'x86', 8: 'MIPS', 20: 'PowerPC', 40: 'ARM', 62: 'x86-64', 183: 'ARM64', 243: 'RISC-V' };
function handleElf(r, u8) {
  const dv = view(u8);
  const is64 = u8[4] === 2, le = u8[5] === 1;
  put(r, 'Executable', 'Format', is64 ? 'ELF 64-bit' : 'ELF 32-bit');
  put(r, 'Executable', 'Byte order', le ? 'Little endian' : 'Big endian');
  put(r, 'Executable', 'Kind', { 1: 'Relocatable object', 2: 'Program', 3: 'Shared library', 4: 'Core dump' }[dv.getUint16(16, le)] || '');
  const machine = ELF_MACHINES[dv.getUint16(18, le)];
  put(r, 'Executable', 'Architecture', machine);
  put(r, 'Executable', 'Sections', is64 ? dv.getUint16(60, le) : dv.getUint16(48, le));
  fact(r, 'Architecture', machine);
}
const MACH_CPU = { 7: 'x86', 0x1000007: 'x86-64', 12: 'ARM', 0x100000c: 'ARM64', 18: 'PowerPC' };
function handleMacho(r, u8) {
  const dv = view(u8);
  if (u8[0] === 0xca) {
    const n = dv.getUint32(4);
    if (n > 30) { r.kind = 'Java class file'; put(r, 'Executable', 'Java version', `${dv.getUint16(6) - 44}`); return; }
    const archs = [];
    for (let i = 0; i < n; i++) archs.push(MACH_CPU[dv.getUint32(8 + i * 20)] || 'other');
    put(r, 'Executable', 'Format', 'Universal binary'); put(r, 'Executable', 'Architecture', archs.join(', '));
    return;
  }
  const cpu = MACH_CPU[dv.getUint32(4, true)];
  put(r, 'Executable', 'Format', 'Mach-O 64-bit'); put(r, 'Executable', 'Architecture', cpu);
  put(r, 'Executable', 'Kind', { 1: 'Object', 2: 'Program', 6: 'Dynamic library', 8: 'Bundle' }[dv.getUint32(12, true)] || '');
  put(r, 'Executable', 'Load commands', dv.getUint32(16, true));
  fact(r, 'Architecture', cpu);
}

/* ---------- More archives ---------- */
function rarEntries(u8) {
  const dv = view(u8);
  const rows = [];
  if (u8[6] === 1) { // RAR 5
    let p = 8;
    const vint = () => { let v = 0, s = 0, b; do { b = u8[p++]; v += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80 && s < 63); return v; };
    while (p + 7 < u8.length && rows.length < 20000) {
      p += 4;
      const headerSize = vint(), start = p;
      const type = vint(), flags = vint();
      if (flags & 1) vint();
      const dataSize = flags & 2 ? vint() : 0;
      if (type === 2) {
        const fileFlags = vint(), size = vint();
        vint();
        if (fileFlags & 2) p += 4;
        if (fileFlags & 4) p += 4;
        vint(); vint();
        const len = vint();
        rows.push({ name: new TextDecoder().decode(u8.subarray(p, p + len)), size, csize: dataSize, dir: !!(fileFlags & 1) });
      } else if (type === 5) break;
      p = start + headerSize + dataSize;
    }
    return { version: 5, rows };
  }
  let p = 7; // RAR 4
  while (p + 7 < u8.length && rows.length < 20000) {
    const type = u8[p + 2], flags = dv.getUint16(p + 3, true), size = dv.getUint16(p + 5, true);
    if (size < 7) break;
    let add = flags & 0x8000 ? dv.getUint32(p + 7, true) : 0;
    if (type === 0x74) {
      const nameLen = dv.getUint16(p + 26, true);
      const raw = u8.subarray(p + 32, p + 32 + nameLen);
      const z = raw.indexOf(0);
      rows.push({ name: new TextDecoder(flags & 0x200 ? 'utf-8' : 'windows-1252').decode(z >= 0 ? raw.subarray(0, z) : raw), size: dv.getUint32(p + 11, true), csize: add, dir: (flags & 0xe0) === 0xe0 });
    } else if (type === 0x7b) break;
    p += size + add;
  }
  return { version: 4, rows };
}

function cpioEntries(u8) {
  const rows = [];
  let p = 0;
  const hex = (o, n) => parseInt(ascii(u8, o, n), 16);
  const oct = (o, n) => parseInt(ascii(u8, o, n), 8);
  if (ascii(u8, 0, 6) === '070707') { // portable ASCII format
    while (p + 76 <= u8.length && rows.length < 20000 && ascii(u8, p, 6) === '070707') {
      const mode = oct(p + 18, 6), mtime = oct(p + 48, 11), nameLen = oct(p + 59, 6), size = oct(p + 65, 11);
      const name = cstr(u8, p + 76, nameLen);
      if (name === 'TRAILER!!!') break;
      const off = p + 76 + nameLen;
      rows.push({ name, size, dir: (mode & 0xf000) === 0x4000, date: mtime ? new Date(mtime * 1000) : null, read: async () => u8.subarray(off, off + size) });
      p = off + size;
    }
    return rows;
  }
  while (p + 110 <= u8.length && rows.length < 20000) {
    if (!/^07070[12]$/.test(ascii(u8, p, 6))) break;
    const mode = hex(p + 14, 8), mtime = hex(p + 46, 8), size = hex(p + 54, 8), nameLen = hex(p + 94, 8);
    const name = cstr(u8, p + 110, nameLen);
    const dataStart = (p + 110 + nameLen + 3) & ~3;
    if (name === 'TRAILER!!!') break;
    const off = dataStart;
    rows.push({ name, size, dir: (mode & 0xf000) === 0x4000, date: mtime ? new Date(mtime * 1000) : null, read: async () => u8.subarray(off, off + size) });
    p = (dataStart + size + 3) & ~3;
  }
  return rows;
}

function arEntries(u8) {
  const rows = [];
  let p = 8, longNames = '';
  while (p + 60 <= u8.length && rows.length < 20000) {
    let name = ascii(u8, p, 16).trim();
    const mtime = parseInt(ascii(u8, p + 16, 12), 10), size = parseInt(ascii(u8, p + 48, 10), 10) || 0;
    const off = p + 60;
    if (name === '//') longNames = ascii(u8, off, size);
    else if (name !== '/' && name !== '/SYM64/') {
      if (/^\/\d+/.test(name)) name = longNames.slice(+name.slice(1)).split(/\/?\n/)[0];
      rows.push({ name: name.replace(/\/$/, ''), size, date: mtime ? new Date(mtime * 1000) : null, read: async () => u8.subarray(off, off + size) });
    }
    p = off + size + (size & 1);
  }
  return rows;
}

/* ---------- Apple property lists (binary) ---------- */
function parseBplist(u8) {
  const dv = view(u8);
  const tail = u8.length - 32;
  const offSize = u8[tail + 6], refSize = u8[tail + 7];
  const num = Number(dv.getBigUint64(tail + 8)), top = Number(dv.getBigUint64(tail + 16)), table = Number(dv.getBigUint64(tail + 24));
  const uint = (o, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + u8[o + i]; return v; };
  const offset = (i) => uint(table + i * offSize, offSize);
  const read = (i, depth) => {
    if (depth > 12 || i >= num) return null;
    const o = offset(i), m = u8[o], type = m >> 4;
    let info = m & 15, p = o + 1;
    const len = () => { if (info !== 15) return info; const sz = 1 << (u8[p] & 15); const v = uint(p + 1, sz); p += 1 + sz; return v; };
    if (type === 0) return info === 8 ? false : info === 9 ? true : null;
    if (type === 1) return uint(p, 1 << info);
    if (type === 2) return info === 3 ? dv.getFloat64(p) : dv.getFloat32(p);
    if (type === 3) return new Date((dv.getFloat64(p) + 978307200) * 1000);
    if (type === 4) return `<${U.fmtBytes(len())}>`;
    if (type === 5) { const n = len(); return ascii(u8, p, n); }
    if (type === 6) { const n = len(); return new TextDecoder('utf-16be').decode(u8.subarray(p, p + n * 2)); }
    if (type === 10 || type === 12) { const n = len(); return Array.from({ length: Math.min(n, 2000) }, (_, k) => read(uint(p + k * refSize, refSize), depth + 1)); }
    if (type === 13) {
      const n = len(), obj = {};
      for (let k = 0; k < Math.min(n, 2000); k++) obj[read(uint(p + k * refSize, refSize), depth + 1)] = read(uint(p + (n + k) * refSize, refSize), depth + 1);
      return obj;
    }
    return null;
  };
  return read(top, 0);
}

/* ---------- Registration ---------- */
const reg = E.register;

reg('ole', handleOle, 'Legacy Office document', 'application/x-ole-storage', 'OLE2');

['ttf', 'otf', 'ttc', 'woff', 'woff2'].forEach((key) => {
  const label = { ttf: 'TrueType font', otf: 'OpenType font', ttc: 'Font collection', woff: 'Web font (WOFF)', woff2: 'Web font (WOFF2)' }[key];
  const mime = { ttf: 'font/ttf', otf: 'font/otf', ttc: 'font/collection', woff: 'font/woff', woff2: 'font/woff2' }[key];
  reg(key, handleFont, label, mime, 'Font');
});

const exeHandler = (fn, parser) => async (u8) => {
  const r = newResult();
  fn(r, u8);
  r.parser = parser;
  basicBinary(r, u8);
  return r;
};
reg('exe', exeHandler(handlePe, 'PE'), 'Windows executable', 'application/vnd.microsoft.portable-executable', 'PE');
reg('elf', exeHandler(handleElf, 'ELF'), 'ELF executable', 'application/x-elf', 'ELF');
reg('macho', exeHandler(handleMacho, 'Mach-O'), 'Mach-O executable', 'application/x-mach-binary', 'Mach-O');

reg('class', async (u8) => {
  const r = newResult();
  const dv = view(u8);
  const major = dv.getUint16(6);
  put(r, 'Executable', 'Class file version', `${major}.${dv.getUint16(4)}`);
  put(r, 'Executable', 'Java version', major >= 49 ? major - 44 : `1.${major - 44}`);
  basicBinary(r, u8);
  return r;
}, 'Java class file', 'application/java-vm', 'Java');

reg('wasm', async (u8) => {
  const r = newResult();
  put(r, 'Executable', 'WebAssembly version', view(u8).getUint32(4, true));
  basicBinary(r, u8);
  return r;
}, 'WebAssembly module', 'application/wasm', 'WebAssembly');

reg('rar', async (u8) => {
  const r = newResult();
  const { version, rows } = rarEntries(u8);
  put(r, 'Archive', 'RAR version', version);
  E.helpers.archiveSummary(r, rows, 'Archive');
  r.warnings.push(t('RAR files can be listed here but not unpacked. Use the file manager to extract them.'));
  return r;
}, 'RAR archive', 'application/vnd.rar', 'RAR');

reg('7z', async (u8) => {
  const r = newResult();
  const dv = view(u8);
  put(r, 'Archive', '7z format version', `${u8[6]}.${u8[7]}`);
  put(r, 'Archive', 'Packed data', U.fmtBytes(Number(dv.getBigUint64(12, true))));
  r.noText = true; r.noSummary = true;
  r.warnings.push(t('The file list inside a 7z archive is compressed, so it cannot be read here. Use the file manager to extract it.'));
  return r;
}, '7-Zip archive', 'application/x-7z-compressed', '7-Zip');

reg('cpio', async (u8) => {
  const r = newResult();
  const rows = cpioEntries(u8);
  E.helpers.archiveSummary(r, rows, 'Archive');
  r.embedded = rows.filter((x) => !x.dir);
  return r;
}, 'CPIO archive', 'application/x-cpio', 'CPIO');

reg('ar', async (u8, name) => {
  const r = newResult();
  const rows = arEntries(u8);
  E.helpers.archiveSummary(r, rows, 'Archive');
  r.embedded = rows;
  if (/\.deb$/i.test(name)) r.kind = 'Debian package';
  return r;
}, 'Unix archive', 'application/x-archive', 'AR');

const headerOnly = (extra) => async (u8) => {
  const r = newResult();
  r.noSummary = true;
  r.noText = true;
  if (extra) extra(r, u8);
  r.sections.push({ title: t('Hex dump (first 512 bytes)'), hex: hexdump(u8, 512) });
  return r;
};
reg('bzip2', headerOnly((r, u8) => { put(r, 'Compression', 'Block size', `${(u8[3] - 48) * 100} KB`); r.warnings.push(t('This compression format cannot be unpacked here, so only its header is shown.')); }), 'BZip2 file', 'application/x-bzip2', 'BZip2');
reg('xz', headerOnly((r) => { r.warnings.push(t('This compression format cannot be unpacked here, so only its header is shown.')); }), 'XZ file', 'application/x-xz', 'XZ');
reg('zstd', headerOnly((r) => { r.warnings.push(t('This compression format cannot be unpacked here, so only its header is shown.')); }), 'Zstandard file', 'application/zstd', 'Zstandard');
reg('cab', headerOnly((r, u8) => { const dv = view(u8); put(r, 'Archive', 'Folders', dv.getUint16(26, true)); put(r, 'Archive', 'Files', dv.getUint16(28, true)); }), 'Windows cabinet', 'application/vnd.ms-cab-compressed', 'CAB');
reg('rpm', headerOnly((r, u8) => { put(r, 'Archive', 'Package', cstr(u8, 10, 66)); }), 'RPM package', 'application/x-rpm', 'RPM');
reg('iso', headerOnly((r, u8) => { put(r, 'Archive', 'Volume label', cstr(u8, 32808, 32)); put(r, 'Archive', 'Publisher', cstr(u8, 32808 + 510 - 40 + 40, 128)); }), 'ISO disk image', 'application/x-iso9660-image', 'ISO 9660');
reg('dicom', headerOnly(), 'DICOM medical image', 'application/dicom', 'DICOM');
reg('dex', headerOnly((r, u8) => { put(r, 'Executable', 'DEX version', cstr(u8, 4, 3)); }), 'Android DEX file', 'application/vnd.android.dex', 'DEX');

reg('psd', headerOnly((r, u8) => {
  const dv = view(u8);
  const h = dv.getUint32(14), w = dv.getUint32(18);
  put(r, 'Image', 'Width', `${w} px`); put(r, 'Image', 'Height', `${h} px`);
  put(r, 'Image', 'Channels', dv.getUint16(12)); put(r, 'Image', 'Bit depth', dv.getUint16(22));
  put(r, 'Image', 'Color mode', { 0: 'Bitmap', 1: 'Grayscale', 2: 'Indexed', 3: 'RGB', 4: 'CMYK', 7: 'Multichannel', 8: 'Duotone', 9: 'Lab' }[dv.getUint16(24)]);
  put(r, 'Image', 'Format version', dv.getUint16(4) === 2 ? 'PSB (large document)' : 'PSD');
  fact(r, 'Dimensions', `${w} × ${h} px`);
}), 'Photoshop document', 'image/vnd.adobe.photoshop', 'PSD');

reg('dwg', headerOnly((r, u8) => {
  const code = ascii(u8, 0, 6);
  const versions = { AC1014: 'R14', AC1015: '2000', AC1018: '2004', AC1021: '2007', AC1024: '2010', AC1027: '2013', AC1032: '2018' };
  put(r, 'Document', 'AutoCAD version', versions[code] ? `${versions[code]} (${code})` : code);
}), 'AutoCAD drawing', 'image/vnd.dwg', 'DWG');

reg('midi', async (u8) => {
  const r = newResult();
  const dv = view(u8);
  const tracks = dv.getUint16(10), division = dv.getUint16(12);
  put(r, 'Audio', 'MIDI format', dv.getUint16(8)); put(r, 'Audio', 'Tracks', tracks);
  if (!(division & 0x8000)) put(r, 'Audio', 'Ticks per beat', division);
  const texts = [];
  for (let i = 14; i < u8.length - 3 && texts.length < 300; i++) {
    if (u8[i] === 0xff && u8[i + 1] >= 1 && u8[i + 1] <= 7) {
      const len = u8[i + 2];
      if (len && len < 128 && i + 3 + len <= u8.length) texts.push(new TextDecoder().decode(u8.subarray(i + 3, i + 3 + len)).trim());
      i += 2 + len;
    }
  }
  const unique = [...new Set(texts.filter(Boolean))];
  r.text = unique.join('\n');
  r.title = unique[0] || '';
  fact(r, 'Tracks', tracks);
  r.noSummary = true;
  return r;
}, 'MIDI music', 'audio/midi', 'MIDI');

reg('aiff', async (u8) => {
  const r = newResult();
  const dv = view(u8);
  for (let p = 12; p + 8 <= u8.length;) {
    const id = ascii(u8, p, 4), size = dv.getUint32(p + 4);
    if (id === 'COMM') {
      const channels = dv.getUint16(p + 8), frames = dv.getUint32(p + 10), bits = dv.getUint16(p + 14);
      const exp = dv.getUint16(p + 16) & 0x7fff, mant = dv.getUint32(p + 18);
      const rate = mant * 2 ** (exp - 16383 - 31);
      put(r, 'Audio', 'Channels', channels); put(r, 'Audio', 'Bit depth', `${bits} bit`); put(r, 'Audio', 'Sample rate', `${Math.round(rate)} Hz`);
      if (rate) put(r, 'Audio', 'Duration', U.fmtDuration(frames / rate));
    }
    p += 8 + size + (size & 1);
  }
  r.noText = true;
  return r;
}, 'AIFF audio', 'audio/aiff', 'AIFF');

reg('avi', async (u8) => {
  const r = newResult();
  const i = U.ascii(u8, 0, Math.min(u8.length, 8192)).indexOf('avih');
  if (i > 0) {
    const dv = view(u8);
    const usPerFrame = dv.getUint32(i + 8, true), frames = dv.getUint32(i + 24, true);
    const w = dv.getUint32(i + 40, true), h = dv.getUint32(i + 44, true);
    put(r, 'Video', 'Resolution', `${w} × ${h}`); put(r, 'Video', 'Frames', U.fmtNum(frames));
    if (usPerFrame) { put(r, 'Video', 'Frame rate', `${(1e6 / usPerFrame).toFixed(2)} fps`); put(r, 'Video', 'Duration', U.fmtDuration((frames * usPerFrame) / 1e6)); }
    fact(r, 'Resolution', `${w} × ${h}`);
  }
  r.noText = true;
  return r;
}, 'AVI video', 'video/x-msvideo', 'AVI');

reg('flv', headerOnly((r, u8) => { put(r, 'Video', 'Has audio', u8[4] & 4 ? 'Yes' : 'No'); put(r, 'Video', 'Has video', u8[4] & 1 ? 'Yes' : 'No'); }), 'Flash video', 'video/x-flv', 'FLV');

reg('sqlite', async (u8) => {
  const r = newResult();
  const dv = view(u8);
  const pageSize = dv.getUint16(16) === 1 ? 65536 : dv.getUint16(16);
  put(r, 'Database', 'Page size', U.fmtBytes(pageSize)); put(r, 'Database', 'Pages', U.fmtNum(dv.getUint32(28)));
  put(r, 'Database', 'Text encoding', { 1: 'UTF-8', 2: 'UTF-16le', 3: 'UTF-16be' }[dv.getUint32(56)]);
  put(r, 'Database', 'User version', dv.getUint32(60) || ''); put(r, 'Database', 'SQLite version', dv.getUint32(96) ? `${Math.floor(dv.getUint32(96) / 1e6)}.${Math.floor(dv.getUint32(96) / 1e3) % 1000}.${dv.getUint32(96) % 1000}` : '');
  const text = U.ascii(u8, 0, Math.min(u8.length, 4e6));
  const creates = [...new Set(text.match(/CREATE (?:TABLE|VIEW|INDEX|UNIQUE INDEX|TRIGGER) [^\0]{3,4000}?\)(?=[^)]|$)/g) || [])];
  const tables = creates.filter((s) => /^CREATE TABLE/.test(s)).map((s) => s.replace(/^CREATE TABLE\s+(IF NOT EXISTS\s+)?/, '').split(/[\s(]/)[0].replace(/["'`[\]]/g, ''));
  put(r, 'Database', 'Tables', tables.length || '');
  if (tables.length) { r.sections.push({ title: t('Tables'), list: tables, open: true }); fact(r, 'Tables', tables.length); }
  if (creates.length) r.sections.push({ title: t('Schema'), text: creates.slice(0, 80).join('\n\n') });
  r.sections.push({ title: t('Hex dump (first 512 bytes)'), hex: hexdump(u8, 512) });
  r.noSummary = true;
  r.noText = true;
  return r;
}, 'SQLite database', 'application/vnd.sqlite3', 'SQLite');

reg('bplist', async (u8) => {
  const r = newResult();
  let value = null;
  try { value = parseBplist(u8); } catch (e) { /* damaged list */ }
  if (value && typeof value === 'object') {
    r.text = JSON.stringify(value, null, 2);
    if (!Array.isArray(value)) Object.entries(value).slice(0, 80).forEach(([k, v]) => { if (typeof v !== 'object' || v instanceof Date) put(r, 'Property list', k, v instanceof Date ? U.metaDate(v) : String(v)); });
    fact(r, 'Keys', Object.keys(value).length);
  }
  r.noSummary = true;
  return r;
}, 'Apple property list', 'application/x-bplist', 'Binary plist');

reg('mobi', async (u8) => {
  const r = newResult();
  const dv = view(u8);
  put(r, 'Book', 'Title', cstr(u8, 0, 32));
  r.title = cstr(u8, 0, 32);
  const rec0 = dv.getUint32(78);
  const mobiHeaderLen = dv.getUint32(rec0 + 20);
  if (ascii(u8, rec0 + 16, 4) === 'MOBI' && dv.getUint32(rec0 + 128) & 0x40) {
    let p = rec0 + 16 + mobiHeaderLen;
    if (ascii(u8, p, 4) === 'EXTH') {
      const count = dv.getUint32(p + 8);
      p += 12;
      const MAP = { 100: 'Author', 101: 'Publisher', 103: 'Description', 104: 'ISBN', 105: 'Subjects', 106: 'Published', 108: 'Contributor', 109: 'Rights', 503: 'Title' };
      for (let i = 0; i < count && i < 200; i++) {
        const type = dv.getUint32(p), len = dv.getUint32(p + 4);
        if (MAP[type]) put(r, 'Book', MAP[type], new TextDecoder().decode(u8.subarray(p + 8, p + len)).trim());
        p += len;
      }
    }
  }
  r.noText = true;
  r.noSummary = true;
  r.warnings.push(t('The book text is compressed in this format, so only its properties are shown here.'));
  return r;
}, 'E-book (MOBI)', 'application/x-mobipocket-ebook', 'MOBI');

/* ---------- Text-based formats ---------- */
const unfold = (text) => text.replace(/\r?\n[ \t]/g, '');
const icsDate = (v) => {
  const m = /^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)(Z)?)?/.exec(v || '');
  if (!m) return v || '';
  const d = m[7] ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : new Date(+m[1], +m[2] - 1, +m[3], +m[4] || 0, +m[5] || 0, +m[6] || 0);
  return U.fmtDate(d);
};
const icsValue = (v) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

reg('ics', async (u8) => {
  const r = newResult();
  const { text, encoding } = U.decodeText(u8);
  put(r, 'Text', 'Encoding', encoding);
  const lines = unfold(text).split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (/^BEGIN:VEVENT/i.test(line)) cur = {};
    else if (/^END:VEVENT/i.test(line)) { if (cur) events.push(cur); cur = null; }
    else if (cur) { const m = /^([A-Z-]+)[^:]*:(.*)$/i.exec(line); if (m) cur[m[1].toUpperCase()] = icsValue(m[2]); }
    else { const m = /^(PRODID|X-WR-CALNAME|X-WR-TIMEZONE|VERSION):(.*)$/i.exec(line); if (m) put(r, 'Calendar', { PRODID: 'Created with', 'X-WR-CALNAME': 'Calendar name', 'X-WR-TIMEZONE': 'Time zone', VERSION: 'Format version' }[m[1].toUpperCase()], icsValue(m[2])); }
  }
  put(r, 'Calendar', 'Events', events.length);
  fact(r, 'Events', events.length);
  const rows = [['Summary', 'Start', 'End', 'Location', 'Organizer'].map((x) => t(x)), ...events.slice(0, 2000).map((e) => [e.SUMMARY || '', icsDate(e.DTSTART), icsDate(e.DTEND), e.LOCATION || '', (e.ORGANIZER || '').replace(/^mailto:/i, '')])];
  if (events.length) r.sections.push({ title: t('Events'), table: { head: true, rows: rows.slice(0, 200) }, open: true });
  r.text = events.map((e) => [e.SUMMARY, icsDate(e.DTSTART), e.LOCATION, e.DESCRIPTION].filter(Boolean).join('\n')).join('\n\n');
  return r;
}, 'Calendar (iCalendar)', 'text/calendar', 'iCalendar');

reg('vcf', async (u8) => {
  const r = newResult();
  const { text, encoding } = U.decodeText(u8);
  put(r, 'Text', 'Encoding', encoding);
  const cards = unfold(text).split(/BEGIN:VCARD/i).slice(1).map((chunk) => {
    const c = {};
    chunk.split(/\r?\n/).forEach((line) => {
      const m = /^(?:item\d+\.)?([A-Z-]+)[^:]*:(.*)$/i.exec(line);
      if (m) { const k = m[1].toUpperCase(); c[k] = c[k] ? `${c[k]}, ${icsValue(m[2])}` : icsValue(m[2]); }
    });
    return c;
  });
  put(r, 'Contacts', 'Contacts', cards.length);
  fact(r, 'Contacts', cards.length);
  const rows = [['Name', 'Email', 'Phone', 'Organization'].map((x) => t(x)), ...cards.slice(0, 2000).map((c) => [c.FN || c.N || '', c.EMAIL || '', c.TEL || '', (c.ORG || '').replace(/;/g, ' ')])];
  if (cards.length) r.sections.push({ title: t('Contacts'), table: { head: true, rows: rows.slice(0, 200) }, open: true });
  r.text = rows.slice(1).map((x) => x.filter(Boolean).join(' · ')).join('\n');
  return r;
}, 'Contacts (vCard)', 'text/vcard', 'vCard');

reg('mbox', async (u8) => {
  const r = newResult();
  const { text, encoding } = U.decodeText(u8);
  put(r, 'Text', 'Encoding', encoding);
  const starts = [];
  const re = /^From .*$/gm;
  for (let m; (m = re.exec(text)) && starts.length < 200000;) starts.push(m.index);
  put(r, 'Mailbox', 'Messages', U.fmtNum(starts.length));
  fact(r, 'Messages', U.fmtNum(starts.length));
  const subjects = [];
  const senders = new Map();
  starts.forEach((s, i) => {
    const part = text.slice(s, starts[i + 1] ?? text.length);
    const head = part.slice(0, part.search(/\r?\n\r?\n/) >>> 0);
    const subj = /^Subject:\s*(.*)$/im.exec(head), from = /^From:\s*(.*)$/im.exec(head);
    if (subj && subjects.length < 200) subjects.push(E.helpers.decodeWords(subj[1]));
    if (from) { const f = E.helpers.decodeWords(from[1]); senders.set(f, (senders.get(f) || 0) + 1); }
  });
  if (subjects.length) r.sections.push({ title: t('Subjects'), list: subjects, open: true });
  const top = [...senders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  if (top.length) r.sections.push({ title: t('Top senders'), list: top.map(([k, v]) => `${k} · ${v}`) });
  r.embedded = starts.slice(0, 200).map((s, i) => {
    const data = text.slice(s, starts[i + 1] ?? text.length);
    return { name: `message-${i + 1}.eml`, size: data.length, read: async () => new TextEncoder().encode(data.replace(/^From .*\r?\n/, '')) };
  });
  r.text = text.slice(0, 400000);
  r.noSummary = true;
  return r;
}, 'Mailbox (MBOX)', 'application/mbox', 'MBOX');

reg('warc', async (u8) => {
  const r = newResult();
  const text = U.decodeText(u8.subarray(0, Math.min(u8.length, 64e6))).text;
  const urls = text.match(/^WARC-Target-URI:\s*(\S+)/gim) || [];
  const clean = [...new Set(urls.map((x) => x.split(/:\s*/).slice(1).join(':').trim()))];
  put(r, 'Web archive', 'Records', U.fmtNum((text.match(/^WARC\/\d/gm) || []).length));
  put(r, 'Web archive', 'URLs', U.fmtNum(clean.length));
  fact(r, 'URLs', U.fmtNum(clean.length));
  r.sections.push({ title: t('URLs'), list: clean.slice(0, 500), open: true });
  r.noSummary = true;
  r.noText = true;
  return r;
}, 'Web archive (WARC)', 'application/warc', 'WARC');

reg('postscript', async (u8) => {
  const r = newResult();
  const head = U.ascii(u8, 0, Math.min(u8.length, 65536));
  const field = (k) => { const m = new RegExp(`^%%${k}:\\s*(.+)$`, 'm').exec(head); return m ? m[1].trim() : ''; };
  put(r, 'Document', 'Title', field('Title')); put(r, 'Document', 'Author', field('For'));
  put(r, 'Application', 'Creator', field('Creator')); put(r, 'Document', 'Created', field('CreationDate'));
  put(r, 'Document', 'Pages', field('Pages')); put(r, 'Document', 'Bounding box', field('BoundingBox'));
  r.title = field('Title').replace(/^\((.*)\)$/, '$1');
  r.noSummary = true;
  r.noText = true;
  return r;
}, 'PostScript document', 'application/postscript', 'PostScript');

/** Minimal DER reader, enough to pull names and validity dates out of an X.509 certificate. */
function derRead(u8, p) {
  const tag = u8[p];
  let len = u8[p + 1], head = 2;
  if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = len * 256 + u8[p + 2 + i]; head += n; }
  return { tag, start: p + head, end: p + head + len };
}
function derChildren(u8, node) {
  const out = [];
  for (let p = node.start; p < node.end && out.length < 200;) { const c = derRead(u8, p); out.push(c); p = c.end; }
  return out;
}
const X509_NAMES = { '2.5.4.3': 'CN', '2.5.4.6': 'C', '2.5.4.7': 'L', '2.5.4.8': 'ST', '2.5.4.10': 'O', '2.5.4.11': 'OU', '1.2.840.113549.1.9.1': 'Email' };
function derOid(u8, n) {
  const b = u8.subarray(n.start, n.end);
  const parts = [Math.floor(b[0] / 40), b[0] % 40];
  let v = 0;
  for (let i = 1; i < b.length; i++) { v = v * 128 + (b[i] & 0x7f); if (!(b[i] & 0x80)) { parts.push(v); v = 0; } }
  return parts.join('.');
}
function x509Name(u8, node) {
  return derChildren(u8, node).flatMap((set) => derChildren(u8, set)).map((seq) => {
    const [oid, val] = derChildren(u8, seq);
    const key = X509_NAMES[derOid(u8, oid)];
    return key ? `${key}=${new TextDecoder().decode(u8.subarray(val.start, val.end))}` : null;
  }).filter(Boolean).join(', ');
}
function derTime(u8, n) {
  const s = ascii(u8, n.start, n.end - n.start);
  const full = n.tag === 0x17 ? `${+s.slice(0, 2) < 50 ? '20' : '19'}${s}` : s;
  return new Date(Date.UTC(+full.slice(0, 4), +full.slice(4, 6) - 1, +full.slice(6, 8), +full.slice(8, 10), +full.slice(10, 12), +full.slice(12, 14)));
}
function readCertificate(r, der, prefix = '') {
  try {
    const cert = derRead(der, 0);
    const [tbs] = derChildren(der, cert);
    const f = derChildren(der, tbs);
    const shift = f[0].tag === 0xa0 ? 1 : 0;
    const serial = f[shift], issuer = f[shift + 2], validity = f[shift + 3], subject = f[shift + 4];
    const [from, to] = derChildren(der, validity);
    const until = derTime(der, to);
    put(r, 'Certificate', `${prefix}Certificate holder`, x509Name(der, subject)); put(r, 'Certificate', `${prefix}Issuer`, x509Name(der, issuer));
    put(r, 'Certificate', `${prefix}Valid from`, U.metaDate(derTime(der, from))); put(r, 'Certificate', `${prefix}Valid until`, U.metaDate(until));
    put(r, 'Certificate', `${prefix}Serial number`, hexOf(der.subarray(serial.start, serial.end)).replace(/ /g, ':'));
    if (!prefix && until < new Date()) r.warnings.push(t('This certificate has expired.'));
    return true;
  } catch (e) { return false; }
}

reg('der', async (u8) => {
  const r = newResult();
  if (!readCertificate(r, u8)) r.warnings.push(t('Could not read the internal structure of this file.'));
  r.noSummary = true; r.noText = true;
  return r;
}, 'Certificate (DER)', 'application/pkix-cert', 'X.509');

reg('pem', async (u8) => {
  const r = newResult();
  const { text } = U.decodeText(u8);
  const blocks = text.match(/-----BEGIN ([A-Z0-9 ]+)-----/g) || [];
  const types = new Map();
  blocks.forEach((b) => { const k = b.replace(/-----(BEGIN )?/g, ''); types.set(k, (types.get(k) || 0) + 1); });
  put(r, 'Security', 'Blocks', blocks.length);
  types.forEach((n, k) => put(r, 'Security', k, n));
  if ([...types.keys()].some((k) => /PRIVATE KEY/.test(k))) r.warnings.push(t('This file contains a private key. Do not share it.'));
  const certs = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
  certs.slice(0, 5).forEach((c, i) => {
    try {
      const der = Uint8Array.from(atob(c.replace(/-----[A-Z ]+-----|\s+/g, '')), (x) => x.charCodeAt(0));
      readCertificate(r, der, certs.length > 1 ? `#${i + 1} ` : '');
    } catch (e) { /* damaged block */ }
  });
  r.noSummary = true;
  r.noText = true;
  return r;
}, 'Certificate or key (PEM)', 'application/x-pem-file', 'PEM');

/* ---------- Media containers without a browser decoder ---------- */
const ASF_GUIDS = { header: '3026b2758e66cf11a6d900aa0062ce6c', file: 'a1dcab8c47a9cf118ee400c00c205365', content: '3326b2758e66cf11a6d900aa0062ce6c', stream: '9107dcb7b7a9cf118ee600c00c205365' };
const guid = (u8, o) => Array.from(u8.subarray(o, o + 16), (b) => b.toString(16).padStart(2, '0')).join('');
reg('asf', async (u8, name) => {
  const r = newResult();
  const dv = view(u8);
  const utf16 = (o, n) => new TextDecoder('utf-16le').decode(u8.subarray(o, o + n)).replace(/\0+$/, '');
  const count = dv.getUint32(24, true);
  let p = 30, hasVideo = false;
  for (let i = 0; i < count && i < 200 && p + 24 <= u8.length; i++) {
    const id = guid(u8, p), size = Number(dv.getBigUint64(p + 16, true));
    if (size < 24) break;
    const b = p + 24;
    if (id === ASF_GUIDS.file) {
      const ms = Number(dv.getBigUint64(b + 24, true)) / 1e4 - FILETIME_EPOCH;
      if (ms > 0) put(r, 'Document', 'Created', U.metaDate(new Date(ms)));
      const dur = Number(dv.getBigUint64(b + 40, true)) / 1e7 - Number(dv.getBigUint64(b + 56, true)) / 1e3;
      if (dur > 0) { put(r, 'Audio', 'Duration', U.fmtDuration(dur)); fact(r, 'Duration', U.fmtDuration(dur)); }
      put(r, 'Audio', 'Max bitrate', `${Math.round(dv.getUint32(b + 76, true) / 1000)} kbps`);
    } else if (id === ASF_GUIDS.content) {
      const lens = [0, 2, 4, 6, 8].map((k) => dv.getUint16(b + k, true));
      let q = b + 10;
      const vals = lens.map((n) => { const v = utf16(q, n); q += n; return v; });
      put(r, 'Tags', 'Title', vals[0]); put(r, 'Tags', 'Artist', vals[1]); put(r, 'Tags', 'Copyright', vals[2]); put(r, 'Tags', 'Comment', vals[3]);
      if (vals[0]) r.title = vals[0];
    } else if (id === ASF_GUIDS.stream) {
      if (guid(u8, b) === 'c0ef19bc4d5bcf11a8fd00805f5c442b') hasVideo = true;
    }
    p += size;
  }
  r.kind = hasVideo || /\.wmv$/i.test(name) ? 'Windows Media video' : /\.wma$/i.test(name) ? 'Windows Media audio' : 'ASF media';
  r.mime = hasVideo ? 'video/x-ms-wmv' : 'audio/x-ms-wma';
  r.noText = true; r.noSummary = true;
  return r;
}, 'ASF media', 'video/x-ms-asf', 'ASF');

const MPEG2_TS = (u8, step) => u8[0 + (step === 192 ? 4 : 0)] === 0x47 && u8[step + (step === 192 ? 4 : 0)] === 0x47 && u8[step * 2 + (step === 192 ? 4 : 0)] === 0x47;
reg('mpegts', headerOnly((r, u8) => {
  const step = MPEG2_TS(u8, 188) ? 188 : 192;
  put(r, 'Video', 'Packet size', `${step} B`); put(r, 'Video', 'Packets', U.fmtNum(Math.floor(u8.length / step)));
}), 'MPEG transport stream', 'video/mp2t', 'MPEG-TS');
reg('mpegps', headerOnly((r, u8) => { put(r, 'Video', 'MPEG version', (u8[4] & 0xc0) === 0x40 ? 'MPEG-2' : 'MPEG-1'); }), 'MPEG video', 'video/mpeg', 'MPEG-PS');

/* ---------- Scientific and 3D data ---------- */
reg('npy', async (u8) => {
  const r = newResult();
  const dv = view(u8);
  const major = u8[6];
  const headerLen = major === 1 ? dv.getUint16(8, true) : dv.getUint32(8, true);
  const header = ascii(u8, major === 1 ? 10 : 12, headerLen);
  const shape = /'shape':\s*\(([^)]*)\)/.exec(header), dtype = /'descr':\s*'([^']+)'/.exec(header), fortran = /'fortran_order':\s*(True|False)/.exec(header);
  put(r, 'Array', 'Format version', `${major}.${u8[7]}`);
  put(r, 'Array', 'Shape', shape ? `(${shape[1].trim().replace(/,$/, '')})` : '');
  put(r, 'Array', 'Data type', dtype && dtype[1]);
  put(r, 'Array', 'Memory order', fortran ? (fortran[1] === 'True' ? 'Fortran' : 'C') : '');
  if (shape) fact(r, 'Shape', shape[1].trim().replace(/,$/, ''));
  r.noText = true; r.noSummary = true;
  return r;
}, 'NumPy array', 'application/x-npy', 'NumPy');

reg('parquet', headerOnly((r, u8) => {
  const footer = view(u8).getUint32(u8.length - 8, true);
  put(r, 'Database', 'Metadata size', U.fmtBytes(footer));
  const text = new TextDecoder('latin1').decode(u8.subarray(u8.length - 8 - footer, u8.length - 8));
  const by = /parquet-[\w.-]+ version [\w.-]+|[\w-]+ version [\d.]+/.exec(text);
  if (by) put(r, 'Application', 'Created with', by[0]);
}), 'Apache Parquet data', 'application/vnd.apache.parquet', 'Parquet');

reg('dbf', async (u8) => {
  const r = newResult();
  const dv = view(u8);
  const records = dv.getUint32(4, true), headerSize = dv.getUint16(8, true), recordSize = dv.getUint16(10, true);
  put(r, 'Database', 'Records', U.fmtNum(records));
  put(r, 'Database', 'Last updated', `${1900 + u8[1]}-${String(u8[2]).padStart(2, '0')}-${String(u8[3]).padStart(2, '0')}`);
  const fields = [];
  for (let p = 32; p + 32 <= headerSize && u8[p] !== 0x0d; p += 32) fields.push({ name: cstr(u8, p, 11), type: String.fromCharCode(u8[p + 11]), len: u8[p + 16] });
  put(r, 'Database', 'Fields', fields.length);
  fact(r, 'Records', U.fmtNum(records)); fact(r, 'Fields', fields.length);
  const dec = new TextDecoder('windows-1252');
  const rows = [fields.map((f) => f.name)];
  for (let i = 0; i < Math.min(records, 5000); i++) {
    const base = headerSize + i * recordSize;
    if (base + recordSize > u8.length) break;
    let o = base + 1;
    rows.push(fields.map((f) => { const v = dec.decode(u8.subarray(o, o + f.len)).trim(); o += f.len; return v; }));
  }
  r.tables.push({ name: 'DBF', rows });
  r.sections.push({ title: t('Preview · {rows} rows × {cols} columns', { rows: U.fmtNum(records), cols: fields.length }), table: { rows: rows.slice(0, 50) }, open: true });
  r.text = rows.map((x) => x.join('\t')).join('\n');
  return r;
}, 'dBase table', 'application/x-dbf', 'dBase');

reg('tga', headerOnly((r, u8) => {
  const dv = view(u8);
  const w = dv.getUint16(12, true), h = dv.getUint16(14, true);
  put(r, 'Image', 'Width', `${w} px`); put(r, 'Image', 'Height', `${h} px`); put(r, 'Image', 'Bit depth', u8[16]);
  put(r, 'Image', 'Compression', u8[2] >= 9 ? 'RLE' : 'None');
  fact(r, 'Dimensions', `${w} × ${h} px`);
}), 'Targa image', 'image/x-tga', 'TGA');

reg('pnm', async (u8) => {
  const r = newResult();
  const head = ascii(u8, 0, 256).replace(/#[^\n]*\n/g, ' ').split(/\s+/);
  const kinds = { P1: 'Bitmap (text)', P2: 'Grayscale (text)', P3: 'Color (text)', P4: 'Bitmap (binary)', P5: 'Grayscale (binary)', P6: 'Color (binary)' };
  put(r, 'Image', 'Width', `${head[1]} px`); put(r, 'Image', 'Height', `${head[2]} px`); put(r, 'Image', 'Color type', kinds[head[0]]);
  if (!/^P[14]$/.test(head[0])) put(r, 'Image', 'Max value', head[3]);
  fact(r, 'Dimensions', `${head[1]} × ${head[2]} px`);
  r.noText = true; r.noSummary = true;
  return r;
}, 'Netpbm image', 'image/x-portable-anymap', 'Netpbm');

reg('stl', async (u8) => {
  const r = newResult();
  const isAscii = /^solid\b/.test(ascii(u8, 0, 6)) && ascii(u8, 0, 1024).includes('facet');
  if (isAscii) {
    const text = U.decodeText(u8).text;
    put(r, '3D model', 'Encoding', 'ASCII'); put(r, '3D model', 'Triangles', U.fmtNum((text.match(/\bfacet normal\b/g) || []).length));
    put(r, '3D model', 'Name', (/^solid\s+(.*)$/m.exec(text) || [])[1]);
  } else {
    const n = view(u8).getUint32(80, true);
    put(r, '3D model', 'Encoding', 'Binary'); put(r, '3D model', 'Triangles', U.fmtNum(n)); put(r, '3D model', 'Header', cstr(u8, 0, 80));
    fact(r, 'Triangles', U.fmtNum(n));
  }
  r.noText = true; r.noSummary = true;
  return r;
}, '3D model (STL)', 'model/stl', 'STL');

reg('glb', async (u8) => {
  const r = newResult();
  const dv = view(u8);
  put(r, '3D model', 'glTF version', dv.getUint32(4, true));
  try {
    const len = dv.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(u8.subarray(20, 20 + len)));
    put(r, '3D model', 'Created with', json.asset && json.asset.generator);
    ['scenes', 'nodes', 'meshes', 'materials', 'textures', 'animations'].forEach((k) => { if (json[k]) put(r, '3D model', k[0].toUpperCase() + k.slice(1), json[k].length); });
    if (json.meshes) fact(r, 'Meshes', json.meshes.length);
  } catch (e) { /* unusual container */ }
  r.noText = true; r.noSummary = true;
  return r;
}, '3D model (glTF)', 'model/gltf-binary', 'glTF');

reg('subtitles', async (u8) => {
  const r = newResult();
  const { text, encoding } = U.decodeText(u8);
  put(r, 'Text', 'Encoding', encoding);
  const stamps = text.match(/\d\d:\d\d:\d\d[,.]\d{3}\s*-->\s*\d\d:\d\d:\d\d[,.]\d{3}/g) || [];
  put(r, 'Subtitles', 'Cues', U.fmtNum(stamps.length));
  if (stamps.length) put(r, 'Subtitles', 'Ends at', stamps[stamps.length - 1].split('-->')[1].trim());
  fact(r, 'Cues', U.fmtNum(stamps.length));
  r.text = text.replace(/^\s*\d+\s*$/gm, '').replace(/^.*-->.*$/gm, '').replace(/^WEBVTT.*$/m, '').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return r;
}, 'Subtitles', 'text/vtt', 'Subtitles');

/* ---------- Detection for everything above ---------- */
E.addDetector((u8, name, ext) => {
  const a = (o, l) => ascii(u8, o, l);
  const h4 = a(0, 4);
  if (u8[0] === 0x93 && a(1, 5) === 'NUMPY') return 'npy';
  if (guid(u8, 0) === ASF_GUIDS.header) return 'asf';
  if (u8[0] === 0 && u8[1] === 0 && u8[2] === 1 && u8[3] === 0xba) return 'mpegps';
  if (u8.length > 400 && (MPEG2_TS(u8, 188) || MPEG2_TS(u8, 192))) return 'mpegts';
  if (h4 === 'PAR1' && a(u8.length - 4, 4) === 'PAR1') return 'parquet';
  if (h4 === 'glTF') return 'glb';
  if (/^P[1-6]\s/.test(a(0, 3)) && ['pbm', 'pgm', 'ppm', 'pnm'].includes(ext)) return 'pnm';
  if (ext === 'tga') return 'tga';
  if (ext === 'dbf') return 'dbf';
  if (ext === 'stl') return 'stl';
  if (ext === 'srt' || ext === 'vtt' || a(0, 6) === 'WEBVTT') return 'subtitles';
  if ((ext === 'cer' || ext === 'der' || ext === 'crt') && u8[0] === 0x30 && u8[1] >= 0x80) return 'der';
  if (h4 === 'OTTO') return 'otf';
  if (h4 === 'ttcf') return 'ttc';
  if (h4 === 'wOFF') return 'woff';
  if (h4 === 'wOF2') return 'woff2';
  if (u8[0] === 0 && u8[1] === 1 && u8[2] === 0 && u8[3] === 0 && (ext === 'ttf' || view(u8).getUint16(4) < 64)) return 'ttf';
  if (h4 === 'true' && ext === 'ttf') return 'ttf';
  if (u8[0] === 0xca && u8[1] === 0xfe && u8[2] === 0xba && u8[3] === 0xbe && view(u8).getUint32(4) > 30) return 'class';
  if (u8[0] === 0 && a(1, 3) === 'asm') return 'wasm';
  if (a(0, 3) === 'dex') return 'dex';
  if (a(0, 3) === 'BZh') return 'bzip2';
  if (u8[0] === 0xfd && a(1, 4) === '7zXZ') return 'xz';
  if (u8[0] === 0x28 && u8[1] === 0xb5 && u8[2] === 0x2f && u8[3] === 0xfd) return 'zstd';
  if (h4 === 'MSCF') return 'cab';
  if (u8[0] === 0xed && u8[1] === 0xab && u8[2] === 0xee && u8[3] === 0xdb) return 'rpm';
  if (a(0, 8) === '!<arch>\n') return 'ar';
  if (/^07070[127]/.test(a(0, 6))) return 'cpio';
  if (u8.length > 32774 && a(32769, 5) === 'CD001') return 'iso';
  if (u8.length > 132 && a(128, 4) === 'DICM') return 'dicom';
  if (h4 === '8BPS') return 'psd';
  if (/^AC10\d\d/.test(a(0, 6))) return 'dwg';
  if (h4 === 'MThd') return 'midi';
  if (h4 === 'FORM' && /^AIF[FC]$/.test(a(8, 4))) return 'aiff';
  if (h4 === 'RIFF' && a(8, 4) === 'AVI ') return 'avi';
  if (a(0, 3) === 'FLV') return 'flv';
  if (a(0, 8) === 'bplist00') return 'bplist';
  if (a(60, 8) === 'BOOKMOBI') return 'mobi';
  if ((a(0, 2) === '%!') && !/^%!(PS-AdobeFont|FontType)/.test(a(0, 20))) return 'postscript';
  if (a(0, 5) === 'WARC/') return 'warc';
  const head = a(0, 2048);
  if (/^\s*BEGIN:VCALENDAR/i.test(head)) return 'ics';
  if (/^\s*BEGIN:VCARD/i.test(head)) return 'vcf';
  if (/^-----BEGIN (?!PGP)[A-Z0-9 ]+-----/.test(head)) return 'pem';
  if (/^From \S+.*\r?\n[A-Za-z-]+:/.test(head) || ext === 'mbox') return 'mbox';
  return null;
});
