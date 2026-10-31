// extractors.js
// Format detection and one extractor per format. Ported from the Distil prototype.
// Further parsers register themselves from formats.js.

import U from './util.js';
import { t } from './i18n.js';
import { openPdfjs, pdfjs } from '../pdf/lib.js';
import { findXmpPacket, parseXmp, parseIptc, parseIcc } from './xmp.js';

const E = {};
export default E;

const KIND = {
  pdf: 'PDF document', docx: 'Word document', xlsx: 'Excel workbook', pptx: 'PowerPoint presentation',
  ooxml: 'Office Open XML', odt: 'OpenDocument text', ods: 'OpenDocument spreadsheet', odp: 'OpenDocument presentation',
  odg: 'OpenDocument graphics', epub: 'E-book (EPUB)', zip: 'ZIP archive', gzip: 'GZip file', tar: 'TAR archive',
  rar: 'RAR archive', '7z': '7-Zip archive', rtf: 'Rich Text document', ole: 'Legacy Office document', eml: 'Email message',
  html: 'Web page (HTML)', xml: 'XML document', svg: 'SVG image', json: 'JSON data', jsonl: 'JSON Lines data',
  csv: 'Delimited data', markdown: 'Markdown document', code: 'Source code', text: 'Plain text',
  png: 'PNG image', jpeg: 'JPEG image', gif: 'GIF image', webp: 'WebP image', bmp: 'Bitmap image', tiff: 'TIFF image',
  heic: 'HEIC image', avif: 'AVIF image', ico: 'Icon',
  mp3: 'MP3 audio', flac: 'FLAC audio', ogg: 'Ogg audio', wav: 'WAV audio', m4a: 'AAC / M4A audio',
  mp4: 'MP4 video', mov: 'QuickTime video', webm: 'WebM video', mkv: 'Matroska video',
  exe: 'Windows executable', elf: 'ELF executable', macho: 'Mach-O executable', sqlite: 'SQLite database', binary: 'Binary file',
};
const MIME = {
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation', epub: 'application/epub+zip', zip: 'application/zip',
  gzip: 'application/gzip', tar: 'application/x-tar', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  rtf: 'application/rtf', ole: 'application/x-ole-storage', eml: 'message/rfc822', html: 'text/html', xml: 'application/xml',
  svg: 'image/svg+xml', json: 'application/json', jsonl: 'application/x-ndjson', csv: 'text/csv', markdown: 'text/markdown',
  code: 'text/plain', text: 'text/plain', png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', tiff: 'image/tiff', heic: 'image/heic', avif: 'image/avif', ico: 'image/x-icon', mp3: 'audio/mpeg', flac: 'audio/flac',
  ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mkv: 'video/x-matroska', exe: 'application/vnd.microsoft.portable-executable', elf: 'application/x-elf',
  macho: 'application/x-mach-binary', sqlite: 'application/vnd.sqlite3', binary: 'application/octet-stream',
};
const CODE_EXT = {
  js: 'JavaScript', mjs: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript (JSX)', jsx: 'JavaScript (JSX)', py: 'Python',
  java: 'Java', kt: 'Kotlin', c: 'C', h: 'C header', cpp: 'C++', cc: 'C++', hpp: 'C++ header', cs: 'C#', go: 'Go', rs: 'Rust',
  rb: 'Ruby', php: 'PHP', swift: 'Swift', sh: 'Shell', bash: 'Shell', zsh: 'Shell', ps1: 'PowerShell', sql: 'SQL',
  css: 'CSS', scss: 'SCSS', less: 'Less', lua: 'Lua', r: 'R', pl: 'Perl', scala: 'Scala', dart: 'Dart', vue: 'Vue',
  yaml: 'YAML', yml: 'YAML', toml: 'TOML', ini: 'INI', cfg: 'Config', conf: 'Config', tex: 'LaTeX', bat: 'Batch',
  dockerfile: 'Dockerfile', gradle: 'Gradle', m: 'Objective-C', hs: 'Haskell', ml: 'OCaml', ex: 'Elixir', exs: 'Elixir', erl: 'Erlang', clj: 'Clojure', jl: 'Julia', nim: 'Nim', zig: 'Zig', sol: 'Solidity', proto: 'Protocol Buffers', graphql: 'GraphQL', tf: 'Terraform', fs: 'F#', vb: 'Visual Basic', f90: 'Fortran', asm: 'Assembly', cmake: 'CMake', makefile: 'Makefile', env: 'Environment file',
};

/* ---------- result helpers ---------- */
const newResult = () => ({ text: '', summaryText: null, meta: {}, facts: [], sections: [], tables: [], warnings: [], preview: null });
const put = (r, group, key, val) => {
  if (val === undefined || val === null || val === '' || (typeof val === 'number' && isNaN(val))) return;
  (r.meta[group] = r.meta[group] || {})[key] = val;
};
const fact = (r, label, val) => {
  if (val !== undefined && val !== null && val !== '' && val !== 0 && val !== '0') r.facts.push([label, String(val)]);
};
const isoish = (v) => {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d) ? v : U.metaDate(d);
};
// join blocks: paragraphs get a blank line between them, table rows stay tight
const joinBlocks = (arr) => arr.reduce((acc, b, i) => acc + (i ? (b.tight && arr[i - 1].tight ? '\n' : '\n\n') : '') + b.t, '').replace(/\n{3,}/g, '\n\n').trim();
const countWords = (t) => (t.match(/[\p{L}\p{N}]+/gu) || []).length;

/* ---------- detection ---------- */
const detectors = [];
E.xmlFlavors = Object.create(null);
E.jsonFlavors = [];
async function detect(name, mime, u8) {
  const ext = U.extOf(name);
  const a = (o, l) => U.ascii(u8, o, l);
  const h4 = a(0, 4);
  if (h4 === '%PDF') return { key: 'pdf' };
  if (u8.length > 8) {
    for (const fn of detectors) {
      let key = null;
      try { key = fn(u8, name, ext); } catch (e) { /* too short for this format */ }
      if (key) return { key };
    }
  }
  if (u8[0] === 0x50 && u8[1] === 0x4b && (u8[2] === 3 || u8[2] === 5 || u8[2] === 7)) {
    let zip;
    try { zip = await U.zipOpen(u8); } catch (e) { return { key: 'zip', zipError: e.message }; }
    if (zip.has('mimetype')) {
      const mt = ((await zip.text('mimetype')) || '').trim();
      const map = { 'application/epub+zip': 'epub', 'application/vnd.oasis.opendocument.text': 'odt', 'application/vnd.oasis.opendocument.text-template': 'odt', 'application/vnd.oasis.opendocument.spreadsheet-template': 'ods', 'application/vnd.oasis.opendocument.presentation-template': 'odp',
        'application/vnd.oasis.opendocument.spreadsheet': 'ods', 'application/vnd.oasis.opendocument.presentation': 'odp',
        'application/vnd.oasis.opendocument.graphics': 'odg' };
      if (map[mt]) return { key: map[mt], zip };
    }
    if (zip.has('[Content_Types].xml')) {
      const n = zip.entries.map((e) => e.name);
      if (n.some((x) => x.startsWith('word/'))) return { key: 'docx', zip };
      if (n.some((x) => x.startsWith('xl/'))) return { key: 'xlsx', zip };
      if (n.some((x) => x.startsWith('ppt/'))) return { key: 'pptx', zip };
    }
    return { key: 'zip', zip };
  }
  if (u8[0] === 0x89 && h4.slice(1) === 'PNG') return { key: 'png' };
  if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return { key: 'jpeg' };
  if (h4 === 'GIF8') return { key: 'gif' };
  if (h4 === 'RIFF') {
    const t = a(8, 4);
    if (t === 'WEBP') return { key: 'webp' };
    if (t === 'WAVE') return { key: 'wav' };
  }
  if (h4 === 'II*\0' || h4 === 'MM\0*' || h4 === 'II+\0' || h4 === 'MM\0+') return { key: 'tiff' };
  if (a(0, 2) === 'BM' && (ext === 'bmp' || new DataView(u8.buffer, u8.byteOffset).getUint32(14, true) <= 124)) return { key: 'bmp' };
  if (u8[0] === 0 && u8[1] === 0 && u8[2] === 1 && u8[3] === 0 && ext === 'ico') return { key: 'ico' };
  if (a(0, 3) === 'ID3') return { key: 'mp3' };
  if (u8[0] === 0xff && (u8[1] & 0xe0) === 0xe0 && (ext === 'mp3' || ext === 'mp2')) return { key: 'mp3' };
  if (h4 === 'fLaC') return { key: 'flac' };
  if (h4 === 'OggS') return { key: 'ogg' };
  if (a(4, 4) === 'ftyp') {
    const b = a(8, 4);
    if (/^(avif|avis)/.test(b)) return { key: 'avif' };
    if (/^(heic|heix|hevc|mif1|msf1|heim|heis)/.test(b)) return { key: 'heic' };
    if (b === 'M4A ' || b === 'M4B ') return { key: 'm4a' };
    if (b === 'qt  ') return { key: 'mov' };
    return { key: ext === 'm4a' ? 'm4a' : 'mp4' };
  }
  if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) return { key: ext === 'webm' ? 'webm' : 'mkv' };
  if (a(0, 5) === '{\\rtf') return { key: 'rtf' };
  if (u8[0] === 0xd0 && u8[1] === 0xcf && u8[2] === 0x11 && u8[3] === 0xe0) return { key: 'ole' };
  if (u8[0] === 0x1f && u8[1] === 0x8b) return { key: 'gzip' };
  if (h4 === 'Rar!') return { key: 'rar' };
  if (u8[0] === 0x37 && u8[1] === 0x7a && u8[2] === 0xbc && u8[3] === 0xaf) return { key: '7z' };
  if (a(257, 5) === 'ustar') return { key: 'tar' };
  if (a(0, 15) === 'SQLite format 3') return { key: 'sqlite' };
  if (u8[0] === 0x7f && a(1, 3) === 'ELF') return { key: 'elf' };
  if (u8[0] === 0x4d && u8[1] === 0x5a) return { key: 'exe' };
  if ((u8[0] === 0xcf && u8[1] === 0xfa && u8[2] === 0xed && u8[3] === 0xfe) || (u8[0] === 0xca && u8[1] === 0xfe && u8[2] === 0xba && u8[3] === 0xbe)) return { key: 'macho' };

  if (!U.looksLikeText(u8)) return { key: 'binary' };

  // text-like: decide by extension, then by content
  const head = U.decodeText(u8.subarray(0, 4096)).text.trimStart();
  if (ext === 'svg' || /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)?(<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return { key: 'svg' };
  if (['html', 'htm', 'xhtml', 'shtml'].includes(ext) || /^(<!doctype html|<html[\s>])/i.test(head)) return { key: 'html' };
  if (['xml', 'rss', 'atom', 'xsd', 'xsl', 'xslt', 'plist', 'kml', 'gpx', 'opf'].includes(ext) || /^<\?xml/i.test(head)) return { key: 'xml' };
  if (ext === 'json' || ext === 'geojson' || ext === 'webmanifest') return { key: 'json' };
  if (ext === 'jsonl' || ext === 'ndjson') return { key: 'jsonl' };
  if (['csv', 'tsv', 'tab'].includes(ext)) return { key: 'csv' };
  if (['md', 'markdown', 'mdx'].includes(ext)) return { key: 'markdown' };
  if (ext === 'eml' || ext === 'mbox' || mime === 'message/rfc822' || /^(received|return-path|from|mime-version|delivered-to|date|message-id):/i.test(head)) {
    if (/^[A-Za-z-]+:\s/.test(head) && /\n(from|subject|to|date):/i.test('\n' + head)) return { key: 'eml' };
  }
  if (CODE_EXT[ext]) return { key: 'code' };
  if (/^(dockerfile|makefile|gemfile|rakefile|vagrantfile|procfile|cmakelists\.txt)$/i.test(name.split('/').pop())) return { key: 'code' };
  if (/^#!\s*\S*\b(ba|z|k|da)?sh\b|^#!\s*\S*\/env\s+\w+|^#!\s*\S*\/(python|perl|ruby|node|php|lua)/.test(head)) return { key: 'code' };
  if (/^[\[{]/.test(head)) {
    try { JSON.parse(U.decodeText(u8).text); return { key: 'json' }; } catch (e) { /* not json */ }
  }
  return { key: 'text' };
}

/* ---------- plain-ish text ---------- */
function textStats(r, text, group) {
  const lines = text ? text.split(/\r\n|\r|\n/).length : 0;
  put(r, group || 'Text', 'Lines', U.fmtNum(lines));
  put(r, group || 'Text', 'Characters', U.fmtNum(text.length));
  const crlf = (text.match(/\r\n/g) || []).length, lf = (text.match(/(?<!\r)\n/g) || []).length;
  put(r, group || 'Text', 'Line endings', crlf && !lf ? 'CRLF (Windows)' : crlf && lf ? 'Mixed' : lf ? 'LF (Unix)' : '');
  return lines;
}

async function handleText(u8, name, det) {
  const r = newResult();
  const { text, encoding } = U.decodeText(u8);
  r.text = text;
  put(r, 'Text', 'Encoding', encoding);
  const lines = textStats(r, text);
  const ext = U.extOf(name);
  if (det.key === 'code') {
    const firstLine = text.split('\n', 1)[0];
    const shebang = /^#!.*?(?:\/env\s+)?(?:.*\/)?(\w+)\s*$/.exec(firstLine);
    const lang = CODE_EXT[ext] || name.split('/').pop().replace(/\..*$/, '') && (shebang ? { sh: 'Shell', bash: 'Shell', zsh: 'Shell', python: 'Python', python3: 'Python', perl: 'Perl', ruby: 'Ruby', node: 'JavaScript', php: 'PHP', lua: 'Lua' }[shebang[1]] || shebang[1] : CODE_EXT[name.split('/').pop().toLowerCase()] || name.split('/').pop());
    r.kind = 'Source code'; put(r, 'Code', 'File type', lang);
    put(r, 'Code', 'Language', lang);
    const fns = (text.match(/\b(function|def|func|fn|class|interface|struct|enum|impl)\s+[A-Za-z_$]/g) || []).length;
    const comments = (text.match(/^\s*(\/\/|#|--|\/\*|\*)/gm) || []).length;
    put(r, 'Code', 'Declarations', fns);
    put(r, 'Code', 'Comment lines', comments);
    fact(r, 'Language', lang); fact(r, 'Lines', U.fmtNum(lines)); fact(r, 'Declarations', fns);
    const lead = /^\s*(?:\/\*+([\s\S]*?)\*\/|((?:\s*(?:\/\/|#)[^\n]*\n?)+))/.exec(text);
    r.summaryText = lead ? (lead[1] || lead[2]).replace(/^\s*(\*|\/\/|#)+ ?/gm, '').trim() : '';
    r.codeSummary = t('{lang} file with {lines} lines and about {fns} declarations (functions, classes, types).', { lang, lines: U.fmtNum(lines), fns });
  } else if (det.key === 'markdown') {
    const heads = [];
    text.replace(/^(#{1,6})\s+(.+?)\s*#*\s*$/gm, (m, h, t) => { heads.push({ level: h.length, title: t }); return m; });
    if (heads.length) r.sections.push({ title: t('Outline'), list: heads.map((h) => ' '.repeat(h.level - 1) + h.title) });
    r.headings = heads;
    r.summaryText = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^#{1,6}\s+.*$/gm, '').replace(/^\s*>\s?/gm, '').replace(/[*_~]{1,3}/g, '')
      .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '');
    fact(r, 'Headings', heads.length);
    if (heads[0]) r.title = heads[0].title;
  } else {
    fact(r, 'Lines', U.fmtNum(lines));
  }
  fact(r, 'Encoding', encoding);
  return r;
}

/* ---------- CSV ---------- */
function sniffDelimiter(text) {
  const sample = text.split(/\r?\n/).slice(0, 8).filter(Boolean);
  let best = ',', bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    const counts = sample.map((l) => l.split(d).length - 1);
    const min = Math.min(...counts);
    const score = min > 0 ? min * 10 + (counts.every((c) => c === counts[0]) ? 5 : 0) : 0;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}
function parseCsv(text, delim, maxRows) {
  const rows = [];
  let row = [], field = '', q = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c;
    } else if (c === '"' && field === '') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
      if (rows.length >= maxRows) return rows;
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
E.parseCsv = parseCsv;

async function handleCsv(u8, name) {
  const r = newResult();
  const { text, encoding } = U.decodeText(u8);
  r.text = text;
  const delim = sniffDelimiter(text);
  const rows = parseCsv(text, delim, 50000).filter((x) => x.length > 1 || (x[0] && x[0].trim() !== ''));
  const cols = rows.reduce((m, x) => Math.max(m, x.length), 0);
  put(r, 'Table', 'Delimiter', { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' }[delim]);
  put(r, 'Table', 'Rows', U.fmtNum(rows.length) + (rows.length >= 50000 ? '+' : ''));
  put(r, 'Table', 'Columns', cols);
  put(r, 'Text', 'Encoding', encoding);
  textStats(r, text);
  fact(r, 'Rows', U.fmtNum(rows.length)); fact(r, 'Columns', cols); fact(r, 'Delimiter', { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' }[delim]);
  r.tables.push({ name: name, rows });
  r.sections.push({ title: t('Preview · {rows} rows × {cols} columns', { rows: U.fmtNum(rows.length), cols }), table: { rows: rows.slice(0, 50) }, open: true });
  r.summaryText = '';
  return r;
}

/* ---------- JSON ---------- */
function describeJson(v, depth = 0) {
  if (Array.isArray(v)) {
    const kinds = new Set(v.slice(0, 200).map((x) => (x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x)));
    return `array · ${U.fmtNum(v.length)} items` + (v.length ? ` (${[...kinds].join(', ')})` : '');
  }
  if (v && typeof v === 'object') return `object · ${Object.keys(v).length} keys`;
  if (typeof v === 'string') return 'string' + (v.length > 60 ? ` · ${U.fmtNum(v.length)} chars` : `: “${v}”`);
  return `${v === null ? 'null' : typeof v}: ${v}`;
}
function jsonStats(v) {
  let nodes = 0, maxDepth = 0;
  (function walk(x, d) {
    nodes++; if (d > maxDepth) maxDepth = d;
    if (nodes > 2e6) return;
    if (Array.isArray(x)) x.forEach((c) => walk(c, d + 1));
    else if (x && typeof x === 'object') Object.values(x).forEach((c) => walk(c, d + 1));
  })(v, 0);
  return { nodes, maxDepth };
}
function jsonTable(arr) {
  if (!Array.isArray(arr) || !arr.length || !arr.slice(0, 50).every((x) => x && typeof x === 'object' && !Array.isArray(x))) return null;
  const keys = [];
  arr.slice(0, 200).forEach((o) => Object.keys(o).forEach((k) => { if (!keys.includes(k)) keys.push(k); }));
  if (keys.length > 60) return null;
  const cell = (x) => (x === null || x === undefined ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x));
  return [keys, ...arr.slice(0, 20000).map((o) => keys.map((k) => cell(o[k])))];
}
async function handleJson(u8, name, det) {
  const r = newResult();
  const { text, encoding } = U.decodeText(u8);
  let value;
  try {
    if (det.key === 'jsonl') value = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
    else value = JSON.parse(text);
  } catch (e) {
    r.warnings.push(t('Not valid JSON. Showing raw text.'));
    r.text = text; r.kind = 'Plain text';
    return r;
  }
  r.text = text.length > 3e6 ? text : det.key === 'json' ? JSON.stringify(value, null, 2) : text;
  put(r, 'Text', 'Encoding', encoding);
  const st = jsonStats(value);
  put(r, 'JSON', 'Root', describeJson(value));
  put(r, 'JSON', 'Values', U.fmtNum(st.nodes));
  put(r, 'JSON', 'Max depth', st.maxDepth);
  fact(r, 'Root', describeJson(value).split(' · ')[0]); fact(r, 'Values', U.fmtNum(st.nodes)); fact(r, 'Depth', st.maxDepth);
  const lines = [];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    Object.keys(value).slice(0, 60).forEach((k) => lines.push(`${k} — ${describeJson(value[k])}`));
    r.sections.push({ title: t('Top-level keys'), list: lines, open: true });
  }
  const tbl = jsonTable(Array.isArray(value) ? value : null) ||
    (value && typeof value === 'object' ? (() => { const k = Object.keys(value).find((x) => jsonTable(value[x])); return k ? jsonTable(value[k]) : null; })() : null);
  if (tbl) {
    r.tables.push({ name, rows: tbl });
    r.sections.push({ title: t('Records · {rows} × {cols} fields', { rows: U.fmtNum(tbl.length - 1), cols: tbl[0].length }), table: { rows: tbl.slice(0, 50) }, open: true });
  }
  if (value && typeof value === 'object') E.jsonFlavors.forEach((fn) => { try { fn(r, value, name); } catch (e) { /* generic JSON result still stands */ } });
  if (value && value.nbformat && Array.isArray(value.cells)) {
    r.kind = 'Jupyter notebook';
    const ks = value.metadata && (value.metadata.kernelspec || {});
    put(r, 'Notebook', 'Cells', value.cells.length); put(r, 'Notebook', 'Code cells', value.cells.filter((c) => c.cell_type === 'code').length);
    put(r, 'Notebook', 'Markdown cells', value.cells.filter((c) => c.cell_type === 'markdown').length);
    put(r, 'Notebook', 'Kernel', ks.display_name || ks.name); put(r, 'Notebook', 'Format version', `${value.nbformat}.${value.nbformat_minor || 0}`);
    r.text = value.cells.map((c) => [].concat(c.source || []).join('')).join('\n\n');
    r.structured = false;
    fact(r, 'Cells', value.cells.length);
    return r;
  }
  if (value && (value.type === 'FeatureCollection' || value.type === 'Topology')) {
    r.kind = value.type === 'Topology' ? 'TopoJSON map' : 'GeoJSON map';
    if (Array.isArray(value.features)) { put(r, 'Map', 'Features', value.features.length); fact(r, 'Features', value.features.length); put(r, 'Map', 'Geometry types', [...new Set(value.features.map((f) => f.geometry && f.geometry.type).filter(Boolean))].join(', ')); }
    if (value.objects) put(r, 'Map', 'Layers', Object.keys(value.objects).join(', '));
  }
  r.structured = true;
  r.codeSummary = t('JSON data with {nodes} values, nested up to {depth} levels.', { nodes: U.fmtNum(st.nodes), depth: st.maxDepth }) +
    (lines.length ? ` ${Object.keys(value).slice(0, 8).join(', ')}${Object.keys(value).length > 8 ? '…' : ''}` : '');
  return r;
}

/* ---------- XML / SVG / HTML ---------- */
async function handleXml(u8, name, det) {
  const r = newResult();
  const { text, encoding } = U.decodeText(u8);
  put(r, 'Text', 'Encoding', encoding);
  let doc;
  try { doc = U.xml(text); } catch (e) {
    r.warnings.push(t('The XML is not well-formed; showing raw text.'));
    r.text = text; return r;
  }
  const root = doc.documentElement;
  const counts = new Map();
  let total = 0, depth = 0;
  (function walk(n, d) {
    total++; if (d > depth) depth = d;
    counts.set(n.localName, (counts.get(n.localName) || 0) + 1);
    for (const c of n.children) walk(c, d + 1);
  })(root, 1);
  put(r, 'XML', 'Root element', root.localName);
  put(r, 'XML', 'Namespace', root.namespaceURI);
  put(r, 'XML', 'Elements', U.fmtNum(total));
  put(r, 'XML', 'Max depth', depth);
  fact(r, 'Root', root.localName); fact(r, 'Elements', U.fmtNum(total)); fact(r, 'Depth', depth);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  r.sections.push({ title: t('Most common elements'), list: top.map(([k, v]) => `<${k}> × ${U.fmtNum(v)}`), open: true });

  // collect leaf text
  const parts = [];
  (function leaf(n) {
    if (!n.children.length) { const t = n.textContent.trim(); if (t) parts.push(t); } else for (const c of n.children) leaf(c);
  })(root);
  r.text = parts.join('\n');

  if (det.key === 'svg') {
    r.kind = 'SVG image';
    put(r, 'Image', 'viewBox', root.getAttribute('viewBox'));
    put(r, 'Image', 'Width', root.getAttribute('width'));
    put(r, 'Image', 'Height', root.getAttribute('height'));
    put(r, 'Document', 'Title', U.firstText(root, 'title'));
    put(r, 'Document', 'Description', U.firstText(root, 'desc'));
    r.title = U.firstText(root, 'title');
    fact(r, 'Shapes', ['path', 'rect', 'circle', 'ellipse', 'line', 'polygon', 'polyline', 'text'].reduce((s, k) => s + (counts.get(k) || 0), 0));
    r.preview = { type: 'image', url: URL.createObjectURL(new Blob([u8], { type: 'image/svg+xml' })) };
  }
  const xmlFlavor = E.xmlFlavors[root.localName];
  if (xmlFlavor) { try { xmlFlavor(r, root, doc, name); } catch (e) { /* generic XML result still stands */ } }
  if (root.localName === 'FictionBook') {
    r.kind = 'E-book (FB2)';
    const info = U.first(root, 'title-info');
    const g = (n) => (info ? U.firstText(info, n) : '');
    put(r, 'Book', 'Title', g('book-title')); put(r, 'Book', 'Language', g('lang')); put(r, 'Book', 'Subjects', g('genre'));
    const author = info && U.first(info, 'author');
    if (author) put(r, 'Book', 'Author', [U.firstText(author, 'first-name'), U.firstText(author, 'last-name')].filter(Boolean).join(' '));
    r.title = g('book-title');
    const bodyEl = U.first(root, 'body');
    if (bodyEl) r.text = U.tags(bodyEl, 'p').map((x) => x.textContent.trim()).filter(Boolean).join('\n\n');
    return r;
  }
  if (['rss', 'feed', 'RDF'].includes(root.localName)) {
    const items = U.tags(doc, root.localName === 'feed' ? 'entry' : 'item');
    r.kind = root.localName === 'feed' ? 'Atom feed' : 'RSS feed';
    put(r, 'Feed', 'Title', U.firstText(root, 'title'));
    put(r, 'Feed', 'Items', items.length);
    r.title = U.firstText(root, 'title');
    fact(r, 'Items', items.length);
    r.sections.unshift({ title: t('Items'), list: items.slice(0, 50).map((i) => U.firstText(i, 'title')), open: true });
  }
  r.codeSummary = t('XML document with root <{root}> and {n} elements.', { root: root.localName, n: U.fmtNum(total) });
  if (det.key !== 'svg' && !['rss', 'feed', 'RDF'].includes(root.localName)) r.structured = true;
  return r;
}

/** Main article text, the job of Tika's boilerpipe handler: drop navigation and link lists. */
function mainContent(doc) {
  const blocks = [];
  const clone = doc.body ? doc.body.cloneNode(true) : null;
  if (!clone) return '';
  clone.querySelectorAll('nav,header,footer,aside,form,button,menu').forEach((e) => e.remove());
  clone.querySelectorAll('p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,dd,figcaption').forEach((el) => {
    if (el.querySelector('p,li,table,blockquote')) return;
    const text = el.textContent.replace(/\s+/g, ' ').trim();
    if (!text) return;
    const linked = [...el.querySelectorAll('a')].reduce((n, a) => n + a.textContent.length, 0);
    const isHeading = /^H\d$/.test(el.tagName);
    if ((text.length >= 25 || isHeading) && linked / text.length < 0.4) blocks.push(text);
  });
  return blocks.join('\n\n');
}

async function handleHtml(u8) {
  const r = newResult();
  const { text, encoding } = U.decodeText(u8);
  const d = new DOMParser().parseFromString(text, 'text/html');
  const m = (sel) => { const e = d.querySelector(sel); return e ? (e.getAttribute('content') || e.getAttribute('href') || '').trim() : ''; };
  put(r, 'Document', 'Title', (d.title || '').trim());
  put(r, 'Document', 'Description', m('meta[name=description]') || m('meta[property="og:description"]'));
  put(r, 'Document', 'Author', m('meta[name=author]'));
  put(r, 'Document', 'Keywords', m('meta[name=keywords]'));
  put(r, 'Document', 'Language', d.documentElement.getAttribute('lang'));
  put(r, 'Document', 'Generator', m('meta[name=generator]'));
  put(r, 'Document', 'Canonical URL', m('link[rel=canonical]'));
  put(r, 'Document', 'Open Graph title', m('meta[property="og:title"]'));
  put(r, 'Document', 'Published', m('meta[property="article:published_time"]'));
  put(r, 'Text', 'Encoding', encoding);
  d.querySelectorAll('meta[name],meta[property]').forEach((el) => {
    const key = el.getAttribute('name') || el.getAttribute('property');
    const value = el.getAttribute('content');
    if (key && value) put(r, 'HTML meta tags', key, value.slice(0, 1000));
  });
  const ld = [...d.querySelectorAll('script[type="application/ld+json"]')].flatMap((s) => {
    try { const j = JSON.parse(s.textContent); return (Array.isArray(j) ? j : [j]).map((x) => x['@type']).filter(Boolean); } catch (e) { return []; }
  });
  put(r, 'Structure', 'Structured data', ld.flat().join(', '));
  const anchors = [...d.querySelectorAll('a[href]')];
  const links = anchors.length, imgs = d.querySelectorAll('img').length, tables = d.querySelectorAll('table').length;
  put(r, 'Structure', 'Links', links); put(r, 'Structure', 'Images', imgs); put(r, 'Structure', 'Tables', tables);
  put(r, 'Structure', 'Scripts', d.querySelectorAll('script').length); put(r, 'Structure', 'Stylesheets', d.querySelectorAll('link[rel=stylesheet],style').length);
  put(r, 'Structure', 'Forms', d.querySelectorAll('form').length);
  const heads = Array.from(d.querySelectorAll('h1,h2,h3,h4')).map((h) => ({ level: +h.tagName[1], title: h.textContent.trim().replace(/\s+/g, ' ') })).filter((h) => h.title);
  if (heads.length) r.sections.push({ title: t('Outline'), list: heads.slice(0, 120).map((h) => ' '.repeat(h.level - 1) + h.title), open: true });
  r.headings = heads;
  const external = [...new Set(anchors.map((a) => a.getAttribute('href')).filter((h) => /^https?:/i.test(h)))];
  if (external.length) r.sections.push({ title: t('Links'), list: external.slice(0, 300) });
  d.querySelectorAll('script,style,noscript,template,svg,iframe').forEach((e) => e.remove());
  r.mainText = mainContent(d);
  const body = d.querySelector('article') && d.querySelector('article').textContent.length > 600 ? d.querySelector('article') : d.querySelector('main') && d.querySelector('main').textContent.length > 600 ? d.querySelector('main') : d.body;
  r.text = U.collapse(U.domText(d.body || d.documentElement));
  r.summaryText = r.mainText.length > 200 ? r.mainText : U.collapse(U.domText(body || d.documentElement));
  r.title = (d.title || '').trim() || (heads[0] && heads[0].title) || '';
  fact(r, 'Links', links); fact(r, 'Images', imgs); fact(r, 'Headings', heads.length);
  return r;
}

/* ---------- RTF ---------- */
function rtfToText(s) {
  const out = [];
  const stack = [];
  let ignore = false, uc = 1, i = 0;
  const n = s.length;
  const IGN = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'object', 'themedata',
    'colorschememapping', 'latentstyles', 'datastore', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl', 'fldinst', 'bkmkstart', 'bkmkend']);
  const SYM = { emdash: '—', endash: '–', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', bullet: '•', emspace: ' ', enspace: ' ' };
  const word = /\\([a-zA-Z]+)(-?\d+)? ?/y;
  const dec = new TextDecoder('windows-1252');
  while (i < n) {
    const c = s[i];
    if (c === '{') { stack.push([ignore, uc]); i++; }
    else if (c === '}') { const t = stack.pop(); if (t) { ignore = t[0]; uc = t[1]; } i++; }
    else if (c === '\\') {
      const d = s[i + 1];
      if (d === "'") { if (!ignore) out.push(dec.decode(new Uint8Array([parseInt(s.substr(i + 2, 2), 16) || 63]))); i += 4; }
      else if (d === '\\' || d === '{' || d === '}') { if (!ignore) out.push(d); i += 2; }
      else if (d === '*') { ignore = true; i += 2; }
      else if (d === '~') { if (!ignore) out.push(' '); i += 2; }
      else if (/[a-zA-Z]/.test(d)) {
        word.lastIndex = i;
        const m = word.exec(s);
        if (!m) { i += 2; continue; }
        i += m[0].length;
        const w = m[1], p = m[2] === undefined ? null : parseInt(m[2], 10);
        if (w === 'par' || w === 'line' || w === 'row' || w === 'sect' || w === 'page') { if (!ignore) out.push('\n'); }
        else if (w === 'tab' || w === 'cell') { if (!ignore) out.push('\t'); }
        else if (w === 'u' && p !== null) {
          if (!ignore) out.push(String.fromCharCode(p < 0 ? p + 65536 : p));
          for (let k = 0; k < uc; k++) { if (s[i] === '\\' && s[i + 1] === "'") i += 4; else i++; }
        } else if (w === 'uc' && p !== null) uc = p;
        else if (SYM[w]) { if (!ignore) out.push(SYM[w]); }
        else if (IGN.has(w)) ignore = true;
      } else i += 2;
    } else { if (c !== '\r' && c !== '\n' && !ignore) out.push(c); i++; }
  }
  return out.join('');
}
async function handleRtf(u8) {
  const r = newResult();
  const raw = U.decodeAs(u8, 'windows-1252');
  r.text = U.collapse(rtfToText(raw));
  const info = (k) => { const m = new RegExp('\\{\\\\' + k + '\\s+([^}]*)\\}').exec(raw); return m ? m[1].trim() : ''; };
  put(r, 'Document', 'Title', info('title')); put(r, 'Document', 'Author', info('author'));
  put(r, 'Document', 'Subject', info('subject')); put(r, 'Document', 'Company', info('company'));
  put(r, 'Document', 'Words', U.fmtNum(countWords(r.text)));
  r.title = info('title');
  fact(r, 'Words', U.fmtNum(countWords(r.text)));
  return r;
}

/* ---------- Email ---------- */
function decodeWords(s) {
  return s.replace(/(\?=)\s+(=\?)/g, '$1$2').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (m, cs, enc, t) => {
    try {
      let bytes;
      if (enc.toLowerCase() === 'b') bytes = Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
      else bytes = Uint8Array.from(t.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (x, h) => String.fromCharCode(parseInt(h, 16))), (c) => c.charCodeAt(0));
      return U.decodeAs(bytes, cs);
    } catch (e) { return m; }
  });
}
function parseHeaders(head) {
  const h = {};
  head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).forEach((line) => {
    const i = line.indexOf(':');
    if (i < 1) return;
    const k = line.slice(0, i).trim().toLowerCase();
    (h[k] = h[k] || []).push(line.slice(i + 1).trim());
  });
  return h;
}
function params(v) {
  const o = {};
  (v || '').replace(/(\w+)\*?=(?:"([^"]*)"|([^;\s]+))/g, (m, k, a, b) => { o[k.toLowerCase()] = a !== undefined ? a : b; return m; });
  return o;
}
function mimeBody(body, h) {
  const cte = ((h['content-transfer-encoding'] || [''])[0] || '').toLowerCase();
  const cs = params((h['content-type'] || [''])[0]).charset || 'utf-8';
  if (cte === 'base64') {
    try { return U.decodeAs(Uint8Array.from(atob(body.replace(/\s+/g, '')), (c) => c.charCodeAt(0)), cs); } catch (e) { return body; }
  }
  if (cte === 'quoted-printable') {
    const bytes = [];
    const s = body.replace(/=\r?\n/g, '');
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) { bytes.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; } else bytes.push(s.charCodeAt(i) & 255);
    }
    return U.decodeAs(new Uint8Array(bytes), cs);
  }
  return body;
}
function mimeBytes(body, cte) {
  if (cte === 'base64') {
    try { return Uint8Array.from(atob(body.replace(/\s+/g, '')), (c) => c.charCodeAt(0)); } catch (e) { /* fall through to raw */ }
  }
  if (cte === 'quoted-printable') {
    const s = body.replace(/=\r?\n/g, '');
    const bytes = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) { bytes.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; } else bytes.push(s.charCodeAt(i) & 255);
    }
    return new Uint8Array(bytes);
  }
  return Uint8Array.from(body, (c) => c.charCodeAt(0) & 255);
}
function walkMime(raw, out, depth) {
  const m = /\r?\n\r?\n/.exec(raw);
  const head = m ? raw.slice(0, m.index) : raw;
  const body = m ? raw.slice(m.index + m[0].length) : '';
  const h = parseHeaders(head);
  if (depth === 0) out.headers = h;
  const ct = (h['content-type'] || ['text/plain'])[0];
  const type = ct.split(';')[0].trim().toLowerCase();
  const p = params(ct);
  const disp = (h['content-disposition'] || [''])[0];
  const fname = params(disp).filename || p.name;
  if (type.startsWith('multipart/') && p.boundary && depth < 8) {
    const parts = body.split('--' + p.boundary);
    parts.slice(1).forEach((part) => { if (!part.startsWith('--')) walkMime(part.replace(/^\r?\n/, ''), out, depth + 1); });
  } else if (fname || /^attachment/i.test(disp)) {
    const cte = ((h['content-transfer-encoding'] || [''])[0] || '').toLowerCase();
    out.attachments.push({ name: decodeWords(fname || '(unnamed)'), type, size: Math.round(body.length * (cte === 'base64' ? 0.75 : 1)), read: async () => mimeBytes(body, cte) });
  } else if (type === 'text/plain') out.plain.push(mimeBody(body, h));
  else if (type === 'text/html') out.html.push(mimeBody(body, h));
  else if (type === 'message/rfc822') walkMime(body, out, depth + 1);
}
async function handleEml(u8) {
  const r = newResult();
  const { text } = U.decodeText(u8);
  const o = { plain: [], html: [], attachments: [] };
  walkMime(text, o, 0);
  const h = o.headers || {};
  const g = (k) => decodeWords((h[k] || [''])[0] || '');
  ['from', 'to', 'cc', 'reply-to', 'subject', 'date', 'message-id', 'x-mailer', 'user-agent', 'in-reply-to'].forEach((k) => put(r, 'Email', k.replace(/(^|-)\w/g, (c) => c.toUpperCase()), g(k)));
  put(r, 'Email', 'Hops (Received)', (h.received || []).length || '');
  put(r, 'Email', 'Attachments', o.attachments.length || '');
  ['list-id', 'list-unsubscribe', 'dkim-signature', 'authentication-results', 'content-language', 'importance', 'x-priority', 'organization'].forEach((k) => put(r, 'Email headers', k, g(k).slice(0, 500)));
  const all = Object.entries(h).map(([k, v]) => `${k}: ${decodeWords(v.join(' | '))}`);
  if (all.length) r.sections.push({ title: t('All headers'), list: all.slice(0, 200) });
  r.embedded = o.attachments;
  const body = o.plain.length ? o.plain.join('\n\n') : o.html.map(U.stripHtml).join('\n\n');
  r.summaryText = body;
  r.text = `Subject: ${g('subject')}\nFrom: ${g('from')}\nTo: ${g('to')}\nDate: ${g('date')}\n\n${U.collapse(body)}`;
  r.title = g('subject');
  fact(r, 'From', g('from').replace(/<.*>/, '').trim() || g('from')); fact(r, 'Date', isoish(g('date'))); fact(r, 'Attachments', o.attachments.length);
  if (o.attachments.length) r.sections.push({ title: t('Attachments'), list: o.attachments.map((a) => `${a.name} · ${a.type} · ~${U.fmtBytes(a.size)}`), open: true });
  return r;
}

/* ---------- Office Open XML ---------- */
async function ooxmlCore(r, zip) {
  try {
    const core = await zip.text('docProps/core.xml');
    if (core) {
      const d = U.xml(core);
      const g = (n) => U.firstText(d.documentElement, n);
      put(r, 'Document', 'Title', g('title')); put(r, 'Document', 'Subject', g('subject'));
      put(r, 'Document', 'Author', g('creator')); put(r, 'Document', 'Last modified by', g('lastModifiedBy'));
      put(r, 'Document', 'Keywords', g('keywords')); put(r, 'Document', 'Description', g('description'));
      put(r, 'Document', 'Category', g('category'));
      put(r, 'Document', 'Created', isoish(g('created'))); put(r, 'Document', 'Modified', isoish(g('modified')));
      put(r, 'Document', 'Revision', g('revision'));
      r.title = g('title');
    }
    const app = await zip.text('docProps/app.xml');
    if (app) {
      const d = U.xml(app);
      const g = (n) => U.firstText(d.documentElement, n);
      put(r, 'Application', 'Application', g('Application')); put(r, 'Application', 'Version', g('AppVersion'));
      put(r, 'Application', 'Company', g('Company'));
      r.appStats = { pages: g('Pages'), words: g('Words'), slides: g('Slides'), notes: g('Notes') };
      put(r, 'Application', 'Pages', g('Pages')); put(r, 'Application', 'Words (reported)', g('Words'));
      put(r, 'Application', 'Characters', g('Characters')); put(r, 'Application', 'Total editing time (min)', g('TotalTime'));
    }
    if (zip.has('docProps/custom.xml')) {
      const d = U.xml(await zip.text('docProps/custom.xml'));
      U.tags(d, 'property').forEach((p) => put(r, 'Custom properties', p.getAttribute('name'), p.textContent.trim()));
    }
    const rels = zip.entries.filter((e) => e.name.endsWith('.rels'));
    const external = new Set();
    for (const e of rels.slice(0, 400)) {
      const x = await zip.text(e.name);
      for (const m of (x || '').matchAll(/<Relationship\b[^>]*>/g)) {
        if (/TargetMode="External"/.test(m[0])) { const tg = /Target="([^"]+)"/.exec(m[0]); if (tg) external.add(tg[1].replace(/&amp;/g, '&')); }
      }
    }
    if (external.size) {
      put(r, 'Structure', 'External links', external.size);
      r.sections.push({ title: t('External links'), list: [...external].slice(0, 300) });
    }
    if (zip.entries.some((e) => /vbaProject\.bin$/i.test(e.name))) {
      put(r, 'Security', 'Macros', 'Yes');
      r.warnings.push(t('This document contains macros. Only open it if you trust where it came from.'));
    }
    const fontsPart = zip.entries.find((e) => /fontTable\.xml$/.test(e.name));
    if (fontsPart) {
      const fonts = U.tags(U.xml(await zip.text(fontsPart.name)), 'font').map((f) => f.getAttribute('w:name')).filter(Boolean);
      if (fonts.length) put(r, 'Structure', 'Fonts', fonts.join(', '));
    }
  } catch (e) { r.warnings.push(t('Could not read document properties.')); }
}

const HEAD_RE = /^(heading|title|subtitle|überschrift|berschrift|titre|titolo|titulo|rubrik|kop)\s*(\d)?/i;
async function handleDocx(u8, name, det) {
  const r = newResult();
  const zip = det.zip;
  const doc = U.xml(await zip.text('word/document.xml'));
  const body = U.first(doc, 'body');
  const out = [], heads = [];
  let tables = 0;
  const paraText = (p) => {
    let t = '';
    for (const n of p.getElementsByTagNameNS('*', '*')) {
      const l = n.localName;
      if (l === 't') t += n.textContent;
      else if (l === 'tab') t += '\t';
      else if (l === 'br' || l === 'cr') t += '\n';
      else if (l === 'noBreakHyphen') t += '-';
    }
    return t;
  };
  const blocks = (el) => {
    for (const c of el.children) {
      const l = c.localName;
      if (l === 'p') {
        const t = paraText(c);
        const style = (U.first(c, 'pStyle') || { getAttribute: () => '' }).getAttribute('w:val') || (U.first(c, 'pStyle') && U.first(c, 'pStyle').getAttributeNS('*', 'val')) || '';
        const hm = HEAD_RE.exec(style);
        if (hm && t.trim()) {
          const lvl = /title/i.test(hm[1]) ? 1 : parseInt(hm[2] || '1', 10);
          heads.push({ level: lvl, title: t.trim() });
        }
        out.push({ t });
      } else if (l === 'tbl') {
        tables++;
        for (const tr of c.children) {
          if (tr.localName !== 'tr') continue;
          const cells = [];
          for (const tc of tr.children) if (tc.localName === 'tc') cells.push(U.tags(tc, 'p').map(paraText).join(' ').trim());
          out.push({ t: cells.join(' | '), tight: true });
        }
      } else if (l === 'sdt' || l === 'sdtContent' || l === 'ins' || l === 'customXml' || l === 'smartTag') blocks(c);
    }
  };
  blocks(body);
  r.text = joinBlocks(out);
  r.headings = heads;
  if (heads.length) r.sections.push({ title: t('Outline'), list: heads.slice(0, 200).map((h) => ' '.repeat(Math.min(h.level, 6) - 1) + h.title), open: true });
  const media = zip.entries.filter((e) => e.name.startsWith('word/media/')).length;
  await ooxmlCore(r, zip);
  const words = countWords(r.text);
  put(r, 'Structure', 'Words (counted)', U.fmtNum(words)); put(r, 'Structure', 'Tables', tables || ''); put(r, 'Structure', 'Embedded images', media || '');
  put(r, 'Structure', 'Headings', heads.length || '');
  fact(r, 'Words', U.fmtNum(words)); if (r.appStats && r.appStats.pages) fact(r, 'Pages', r.appStats.pages);
  fact(r, 'Headings', heads.length); fact(r, 'Tables', tables); fact(r, 'Images', media);
  if (!r.title && heads[0]) r.title = heads[0].title;
  const ins = U.tags(body, 'ins').length, del = U.tags(body, 'del').length;
  if (ins || del) {
    put(r, 'Structure', 'Tracked insertions', ins || ''); put(r, 'Structure', 'Tracked deletions', del || '');
    r.warnings.push(t('This document contains tracked changes, which anyone receiving it can read.'));
  }
  const hiddenRuns = U.tags(body, 'vanish').length;
  if (hiddenRuns) put(r, 'Structure', 'Hidden text runs', hiddenRuns);
  const parts = [];
  for (const e of zip.entries) {
    if (/^word\/(footnotes|endnotes)\.xml$/.test(e.name) || /^word\/(header|footer)\d*\.xml$/.test(e.name)) {
      const x = U.xml(await zip.text(e.name));
      const notes = U.tags(x, 'p').map(paraText).map((v) => v.trim()).filter(Boolean);
      if (notes.length) parts.push(...notes);
    }
  }
  if (parts.length) {
    const unique = [...new Set(parts)];
    r.text += `\n\n${unique.join('\n')}`;
    r.sections.push({ title: t('Headers, footers and notes'), list: unique.slice(0, 200) });
  }
  if (zip.has('word/comments.xml')) {
    try {
      const c = U.xml(await zip.text('word/comments.xml'));
      const cs = U.tags(c, 'comment');
      put(r, 'Structure', 'Comments', cs.length || '');
      if (cs.length) r.sections.push({ title: t('Comments ({n})', { n: cs.length }), list: cs.slice(0, 100).map((x) => `${x.getAttribute('w:author') || ''}: ${U.tags(x, 't').map((t) => t.textContent).join('')}`) });
    } catch (e) { /* ignore */ }
  }
  return r;
}

const colIndex = (ref) => {
  const m = /^([A-Z]+)/i.exec(ref);
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
};
const excelDate = (v) => {
  const ms = Math.round((v - 25569) * 864e5);
  const d = new Date(ms);
  if (isNaN(d)) return String(v);
  const s = d.toISOString();
  return v % 1 === 0 ? s.slice(0, 10) : s.slice(0, 16).replace('T', ' ');
};
async function handleXlsx(u8, name, det) {
  const r = newResult();
  const zip = det.zip;
  const wb = U.xml(await zip.text('xl/workbook.xml'));
  const relsDoc = zip.has('xl/_rels/workbook.xml.rels') ? U.xml(await zip.text('xl/_rels/workbook.xml.rels')) : null;
  const rel = {};
  if (relsDoc) U.tags(relsDoc, 'Relationship').forEach((x) => { rel[x.getAttribute('Id')] = x.getAttribute('Target'); });
  const sheets = U.tags(wb, 'sheet').map((s, i) => {
    const rid = s.getAttribute('r:id') || s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    let t = rel[rid] || `worksheets/sheet${i + 1}.xml`;
    t = t.startsWith('/') ? t.slice(1) : 'xl/' + t;
    return { name: s.getAttribute('name'), hidden: s.getAttribute('state') && s.getAttribute('state') !== 'visible', path: t };
  });
  let sst = [];
  if (zip.has('xl/sharedStrings.xml')) {
    const d = U.xml(await zip.text('xl/sharedStrings.xml'));
    sst = U.tags(d, 'si').map((si) => Array.from(si.children).filter((c) => c.localName !== 'rPh' && c.localName !== 'phoneticPr')
      .map((c) => (c.localName === 't' ? c.textContent : U.tags(c, 't').map((t) => t.textContent).join(''))).join(''));
  }
  const dateXf = [];
  if (zip.has('xl/styles.xml')) {
    const st = U.xml(await zip.text('xl/styles.xml'));
    const custom = {};
    U.tags(st, 'numFmt').forEach((n) => { custom[n.getAttribute('numFmtId')] = n.getAttribute('formatCode') || ''; });
    const xfs = U.first(st, 'cellXfs');
    if (xfs) Array.from(xfs.children).forEach((xf, i) => {
      const id = parseInt(xf.getAttribute('numFmtId') || '0', 10);
      let isDate = (id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58);
      if (custom[id]) isDate = /[dmyhs]/i.test(custom[id].replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')) && !/^general$/i.test(custom[id]);
      dateXf[i] = isDate;
    });
  }
  const textParts = [];
  let totalRows = 0, formulas = 0, totalCells = 0;
  for (const sh of sheets) {
    const xmlStr = await zip.text(sh.path);
    if (!xmlStr) continue;
    await U.yield();
    const d = U.xml(xmlStr);
    const rows = [];
    let maxCol = 0;
    for (const row of U.tags(d, 'row')) {
      const ri = parseInt(row.getAttribute('r'), 10) - 1;
      if (!(ri >= 0) || ri > 100000) continue;
      const arr = (rows[ri] = rows[ri] || []);
      for (const c of row.children) {
        if (c.localName !== 'c') continue;
        const ci = colIndex(c.getAttribute('r') || 'A');
        if (ci > 300) continue;
        const t = c.getAttribute('t');
        const vEl = U.first(c, 'v');
        let v = vEl ? vEl.textContent : '';
        if (U.first(c, 'f')) formulas++;
        if (t === 's') v = sst[parseInt(v, 10)] || '';
        else if (t === 'inlineStr') v = U.tags(c, 't').map((x) => x.textContent).join('');
        else if (t === 'b') v = v === '1' ? 'TRUE' : 'FALSE';
        else if (t === 'n' || !t) {
          if (v !== '' && !isNaN(v)) {
            const s = parseInt(c.getAttribute('s') || '0', 10);
            v = dateXf[s] ? excelDate(parseFloat(v)) : String(parseFloat(v));
          }
        }
        if (v !== '') totalCells++;
        arr[ci] = v;
        if (ci + 1 > maxCol) maxCol = ci + 1;
      }
    }
    let grid = [];
    for (let i = 0; i < rows.length; i++) {
      const src = rows[i] || [];
      grid.push(Array.from({ length: maxCol }, (_, k) => (src[k] === undefined ? '' : src[k])));
    }
    while (grid.length && grid[grid.length - 1].every((x) => x === '')) grid.pop();
    grid = grid.filter((row) => row.some((x) => x !== ''));
    totalRows += grid.length;
    sh.rows = grid.length; sh.cols = maxCol;
    if (grid.length) r.tables.push({ name: sh.name, rows: grid.slice(0, 20000) });
    textParts.push(`# ${sh.name}\n` + grid.slice(0, 20000).map((x) => x.join('\t').replace(/\s+$/, '')).join('\n'));
    r.sections.push({ title: `${sh.name} · ${U.fmtNum(grid.length)} rows × ${maxCol} cols${sh.hidden ? ` · ${t('hidden')}` : ''}`, table: { rows: grid.slice(0, 40) }, open: r.sections.length === 0 });
  }
  r.text = textParts.join('\n\n');
  r.sheets = sheets;
  await ooxmlCore(r, zip);
  put(r, 'Workbook', 'Sheets', sheets.length); put(r, 'Workbook', 'Rows (all sheets)', U.fmtNum(totalRows));
  put(r, 'Workbook', 'Cells with data', U.fmtNum(totalCells)); put(r, 'Workbook', 'Formulas', formulas || ''); put(r, 'Workbook', 'Hidden sheets', sheets.filter((x) => x.hidden).length || '');
  put(r, 'Workbook', 'Sheet names', sheets.map((s) => s.name).join(', '));
  fact(r, 'Sheets', sheets.length); fact(r, 'Rows', U.fmtNum(totalRows)); fact(r, 'Cells', U.fmtNum(totalCells)); if (formulas) fact(r, 'Formulas', U.fmtNum(formulas));
  return r;
}

async function handlePptx(u8, name, det) {
  const r = newResult();
  const zip = det.zip;
  let order = [];
  try {
    const pres = U.xml(await zip.text('ppt/presentation.xml'));
    const rels = U.xml(await zip.text('ppt/_rels/presentation.xml.rels'));
    const map = {};
    U.tags(rels, 'Relationship').forEach((x) => { map[x.getAttribute('Id')] = x.getAttribute('Target'); });
    order = U.tags(pres, 'sldId').map((s) => map[s.getAttribute('r:id')]).filter(Boolean).map((t) => (t.startsWith('/') ? t.slice(1) : 'ppt/' + t));
  } catch (e) { /* fall back to file order */ }
  if (!order.length) order = zip.entries.map((e) => e.name).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
  const SKIP = new Set(['sldNum', 'dt', 'ftr', 'hdr']);
  const slideText = (doc) => {
    const lines = []; let title = '';
    for (const p of U.tags(doc, 'p')) {
      let skip = false, isTitle = false;
      for (let a = p.parentNode; a && a.nodeType === 1; a = a.parentNode) {
        if (a.localName === 'sp') {
          const ph = U.first(a, 'ph');
          if (ph) { const t = ph.getAttribute('type'); if (SKIP.has(t)) skip = true; if (t === 'title' || t === 'ctrTitle') isTitle = true; }
          break;
        }
      }
      if (skip) continue;
      let t = '';
      for (const n of p.getElementsByTagNameNS('*', '*')) { if (n.localName === 't') t += n.textContent; else if (n.localName === 'br') t += '\n'; }
      t = t.trim();
      if (!t) continue;
      if (isTitle && !title) title = t;
      lines.push(t);
    }
    return { title, lines };
  };
  const slides = [];
  for (let i = 0; i < order.length; i++) {
    const x = await zip.text(order[i]);
    if (!x) continue;
    const s = slideText(U.xml(x));
    const nPath = order[i].replace('ppt/slides/', 'ppt/notesSlides/').replace('slide', 'notesSlide');
    let notes = '';
    if (zip.has(nPath)) notes = slideText(U.xml(await zip.text(nPath))).lines.filter((l) => !/^\d+$/.test(l)).join('\n');
    slides.push({ n: i + 1, ...s, notes });
  }
  r.text = slides.map((s) => `— Slide ${s.n}${s.title ? ': ' + s.title : ''} —\n${s.lines.join('\n')}${s.notes ? '\nNotes: ' + s.notes : ''}`).join('\n\n');
  r.summaryText = slides.map((s) => s.lines.filter((l) => l !== s.title).map((l) => (/[.!?]$/.test(l) ? l : l + '.')).join(' ')).join('\n\n');
  r.headings = slides.filter((s) => s.title).map((s) => ({ level: 1, title: s.title }));
  r.sections.push({ title: t('Slides'), list: slides.map((s) => `${s.n}. ${s.title || s.lines[0] || '(no text)'}`), open: true });
  await ooxmlCore(r, zip);
  const media = zip.entries.filter((e) => e.name.startsWith('ppt/media/')).length;
  put(r, 'Presentation', 'Slides', slides.length); put(r, 'Presentation', 'Slides with notes', slides.filter((s) => s.notes).length || '');
  put(r, 'Presentation', 'Embedded media', media || '');
  fact(r, 'Slides', slides.length); fact(r, 'Words', U.fmtNum(countWords(r.text)));
  if (slides[0] && !r.title) r.title = slides[0].title;
  return r;
}

/* ---------- OpenDocument ---------- */
async function odfMeta(r, zip) {
  try {
    const m = zip.has('meta.xml') && U.xml(await zip.text('meta.xml'));
    if (!m) return;
    const g = (n) => U.firstText(m.documentElement, n);
    put(r, 'Document', 'Title', g('title')); put(r, 'Document', 'Subject', g('subject')); put(r, 'Document', 'Description', g('description'));
    put(r, 'Document', 'Author', g('initial-creator')); put(r, 'Document', 'Last modified by', g('creator'));
    put(r, 'Document', 'Keywords', U.tags(m.documentElement, 'keyword').map((k) => k.textContent).join(', '));
    put(r, 'Document', 'Created', isoish(g('creation-date'))); put(r, 'Document', 'Modified', isoish(g('date')));
    put(r, 'Application', 'Generator', g('generator'));
    const st = U.first(m.documentElement, 'document-statistic');
    if (st) Array.from(st.attributes).forEach((a) => put(r, 'Statistics', a.localName.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), a.value));
    r.title = g('title');
  } catch (e) { /* ignore */ }
}
function odfNodeText(n) {
  let t = '';
  for (const c of n.childNodes) {
    if (c.nodeType === 3) t += c.nodeValue;
    else if (c.nodeType === 1) {
      const l = c.localName;
      if (l === 's') t += ' '.repeat(parseInt(c.getAttribute('text:c') || '1', 10));
      else if (l === 'tab') t += '\t';
      else if (l === 'line-break') t += '\n';
      else if (l === 'annotation' || l === 'note-citation') continue;
      else t += odfNodeText(c);
    }
  }
  return t;
}
async function handleOdf(u8, name, det) {
  const r = newResult();
  const zip = det.zip;
  const doc = U.xml(await zip.text('content.xml'));
  const heads = [];
  if (det.key === 'ods') {
    const sheets = [];
    for (const tb of U.tags(doc, 'table')) {
      if (tb.localName !== 'table' || tb.parentNode.localName === 'table-cell') continue;
      const rows = [];
      for (const tr of U.tags(tb, 'table-row')) {
        const rep = Math.min(parseInt(tr.getAttribute('table:number-rows-repeated') || '1', 10), 50);
        const cells = [];
        for (const tc of tr.children) {
          if (tc.localName !== 'table-cell' && tc.localName !== 'covered-table-cell') continue;
          const crep = Math.min(parseInt(tc.getAttribute('table:number-columns-repeated') || '1', 10), 100);
          let v = U.tags(tc, 'p').map(odfNodeText).join('\n');
          if (!v) v = tc.getAttribute('office:date-value') || tc.getAttribute('office:value') || '';
          for (let k = 0; k < crep; k++) cells.push(v);
        }
        while (cells.length && cells[cells.length - 1] === '') cells.pop();
        for (let k = 0; k < rep; k++) { rows.push(cells.slice()); if (rows.length > 20000) break; }
        if (rows.length > 20000) break;
      }
      while (rows.length && !rows[rows.length - 1].length) rows.pop();
      const cols = rows.reduce((m, x) => Math.max(m, x.length), 0);
      const grid = rows.map((x) => Array.from({ length: cols }, (_, i) => (x[i] === undefined ? '' : x[i]))).filter((x) => x.some((c) => c !== ''));
      sheets.push({ name: tb.getAttribute('table:name'), rows: grid.length, cols });
      if (grid.length) r.tables.push({ name: tb.getAttribute('table:name'), rows: grid });
      r.sections.push({ title: `${tb.getAttribute('table:name')} · ${U.fmtNum(grid.length)} rows × ${cols} cols`, table: { rows: grid.slice(0, 40) }, open: r.sections.length === 0 });
      r.text += `# ${tb.getAttribute('table:name')}\n` + grid.map((x) => x.join('\t')).join('\n') + '\n\n';
    }
    r.sheets = sheets;
    fact(r, 'Sheets', sheets.length); fact(r, 'Rows', U.fmtNum(sheets.reduce((s, x) => s + x.rows, 0)));
  } else {
    const out = [];
    const body = U.first(doc, 'body');
    (function walk(n) {
      for (const c of n.children) {
        const l = c.localName;
        if (l === 'h') { const t = odfNodeText(c).trim(); if (t) { heads.push({ level: parseInt(c.getAttribute('text:outline-level') || '1', 10), title: t }); out.push({ t }); } }
        else if (l === 'p') out.push({ t: odfNodeText(c) });
        else if (l === 'page' && det.key === 'odp') { out.push({ t: `— Slide: ${c.getAttribute('draw:name') || ''} —` }); walk(c); }
        else if (l === 'table-row') out.push({ t: U.children(c).map((x) => U.tags(x, 'p').map(odfNodeText).join(' ')).join(' | '), tight: true });
        else if (['list', 'list-item', 'section', 'table', 'table-cell', 'frame', 'text-box', 'body', 'text', 'presentation', 'table-header-rows', 'table-rows', 'shape', 'custom-shape'].includes(l) || l === 'rows') walk(c);
      }
    })(body);
    r.text = joinBlocks(out);
    r.headings = heads;
    if (heads.length) r.sections.push({ title: t('Outline'), list: heads.slice(0, 200).map((h) => ' '.repeat(Math.min(h.level, 6) - 1) + h.title), open: true });
    fact(r, 'Words', U.fmtNum(countWords(r.text))); fact(r, 'Headings', heads.length);
  }
  await odfMeta(r, zip);
  if (!r.title && heads[0]) r.title = heads[0].title;
  return r;
}

/* ---------- EPUB ---------- */
async function handleEpub(u8, name, det) {
  const r = newResult();
  const zip = det.zip;
  const cont = U.xml(await zip.text('META-INF/container.xml'));
  const opfPath = U.first(cont, 'rootfile').getAttribute('full-path');
  const opf = U.xml(await zip.text(opfPath));
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const md = U.first(opf, 'metadata');
  const dc = (n) => U.tags(md, n).map((e) => e.textContent.trim()).filter(Boolean);
  put(r, 'Book', 'Title', dc('title')[0]); put(r, 'Book', 'Author', dc('creator').join(', ')); put(r, 'Book', 'Language', dc('language')[0]);
  put(r, 'Book', 'Publisher', dc('publisher')[0]); put(r, 'Book', 'Published', isoish(dc('date')[0])); put(r, 'Book', 'Identifier', dc('identifier')[0]);
  put(r, 'Book', 'Subjects', dc('subject').join(', ')); put(r, 'Book', 'Description', U.stripHtml(dc('description')[0] || ''));
  put(r, 'Book', 'Rights', dc('rights')[0]);
  r.title = dc('title')[0] || '';
  const manifest = {};
  U.tags(opf, 'item').forEach((i) => { manifest[i.getAttribute('id')] = i.getAttribute('href'); });
  const spine = U.tags(opf, 'itemref').map((i) => manifest[i.getAttribute('idref')]).filter(Boolean);
  const resolve = (h) => { const parts = (dir + decodeURIComponent(h)).split('/'); const o = []; parts.forEach((p) => { if (p === '..') o.pop(); else if (p && p !== '.') o.push(p); }); return o.join('/'); };
  const chapters = [];
  for (const h of spine.slice(0, 400)) {
    const x = await zip.text(resolve(h));
    if (!x) continue;
    const d = new DOMParser().parseFromString(x, 'text/html');
    const hd = d.querySelector('h1,h2,h3');
    d.querySelectorAll('script,style').forEach((e) => e.remove());
    const t = U.collapse(U.domText(d.body || d.documentElement));
    if (t) chapters.push({ title: hd ? hd.textContent.trim().replace(/\s+/g, ' ') : '', text: t });
    if (chapters.length % 20 === 0) await U.yield();
  }
  r.text = chapters.map((c) => c.text).join('\n\n');
  r.headings = chapters.filter((c) => c.title).map((c) => ({ level: 1, title: c.title }));
  r.sections.push({ title: t('Chapters ({n})', { n: chapters.length }), list: chapters.map((c, i) => `${i + 1}. ${c.title || c.text.slice(0, 60) + '…'} · ${U.fmtNum(countWords(c.text))} words`), open: true });
  put(r, 'Book', 'Chapters / sections', chapters.length);
  fact(r, 'Chapters', chapters.length); fact(r, 'Words', U.fmtNum(countWords(r.text))); fact(r, 'Author', dc('creator')[0]);
  const cover = zip.entries.find((e) => /cover.*\.(jpe?g|png)$/i.test(e.name));
  if (cover) { try { const b = await zip.bytes(cover.name); r.preview = { type: 'image', url: URL.createObjectURL(new Blob([b], { type: /png$/i.test(cover.name) ? 'image/png' : 'image/jpeg' })) }; } catch (e) { /* ignore */ } }
  return r;
}

/* ---------- PDF (via pdf.js) ---------- */
const pdfDate = (s) => {
  const m = /^D:(\d{4})(\d\d)?(\d\d)?(\d\d)?(\d\d)?(\d\d)?/.exec(s || '');
  return m ? U.metaDate(new Date(+m[1], (+m[2] || 1) - 1, +m[3] || 1, +m[4] || 0, +m[5] || 0, +m[6] || 0)) : s || '';
};
const PDF_PERMISSIONS = { 4: 'Print', 8: 'Modify', 16: 'Copy', 32: 'Annotate', 256: 'Fill forms', 512: 'Copy for accessibility', 1024: 'Assemble', 2048: 'Print in high quality' };
async function handlePdf(u8, name, det, mime, progress) {
  const r = newResult();
  let pdf;
  try {
    pdf = await openPdfjs(u8);
  } catch (e) {
    if (e && e.name === 'PasswordException') { r.warnings.push(t('This PDF is password-protected, so its text cannot be read.')); put(r, 'Security', 'Encrypted', 'Yes'); r.encryptedPdf = true; return r; }
    throw e;
  }
  const md = await pdf.getMetadata().catch(() => ({ info: {} }));
  const info = md.info || {};
  put(r, 'Document', 'Title', info.Title); put(r, 'Document', 'Author', info.Author); put(r, 'Document', 'Subject', info.Subject);
  put(r, 'Document', 'Keywords', info.Keywords); put(r, 'Document', 'Created', pdfDate(info.CreationDate)); put(r, 'Document', 'Modified', pdfDate(info.ModDate));
  put(r, 'Document', 'Language', info.Language);
  put(r, 'Application', 'Creator', info.Creator); put(r, 'Application', 'Producer', info.Producer);
  put(r, 'Document', 'PDF version', info.PDFFormatVersion);
  put(r, 'Structure', 'Form fields', info.IsAcroFormPresent ? 'Yes' : ''); put(r, 'Structure', 'XFA form', info.IsXFAPresent ? 'Yes' : '');
  put(r, 'Security', 'Digital signature', info.IsSignaturesPresent ? 'Yes' : ''); put(r, 'Structure', 'Optimized for web', info.IsLinearized ? 'Yes' : '');
  put(r, 'Structure', 'PDF collection', info.IsCollectionPresent ? 'Yes' : '');
  if (info.Custom) Object.entries(info.Custom).forEach(([k, v]) => put(r, 'Custom properties', k, String(v)));
  if (md.metadata && md.metadata.getRaw) r.xmpRaw = md.metadata.getRaw();
  r.title = (info.Title || '').trim();

  const permissions = await pdf.getPermissions().catch(() => null);
  if (info.EncryptFilterName || permissions) {
    put(r, 'Security', 'Encrypted', 'Yes');
    put(r, 'Security', 'Encryption filter', info.EncryptFilterName);
  }
  if (permissions) {
    const denied = Object.entries(PDF_PERMISSIONS).filter(([bit]) => !permissions.includes(+bit)).map(([, v]) => v);
    put(r, 'Security', 'Restricted actions', denied.join(', '));
  }
  const js = await pdf.getJSActions().catch(() => null);
  if (js && Object.keys(js).length) { put(r, 'Security', 'JavaScript', 'Yes'); r.warnings.push(t('This PDF contains JavaScript that some readers run when it opens.')); }
  const markInfo = await pdf.getMarkInfo().catch(() => null);
  put(r, 'Structure', 'Tagged (accessible)', markInfo && markInfo.Marked ? 'Yes' : '');
  put(r, 'Structure', 'Page layout', await pdf.getPageLayout().catch(() => ''));
  put(r, 'Structure', 'Page mode', await pdf.getPageMode().catch(() => ''));

  const attachments = await pdf.getAttachments().catch(() => null);
  if (attachments) {
    r.embedded = Object.values(attachments).map((a) => ({ name: a.filename, size: a.content.length, read: async () => a.content }));
    put(r, 'Structure', 'Attachments', r.embedded.length);
  }
  const fields = await pdf.getFieldObjects().catch(() => null);
  if (fields) {
    const names = Object.keys(fields);
    put(r, 'Structure', 'Form field count', names.length);
    r.sections.push({ title: t('Form fields'), list: names.slice(0, 300).map((n) => {
      const f = fields[n][0];
      return f.value ? `${n} (${f.type}): ${String(f.value).slice(0, 120)}` : `${n} (${f.type})`;
    }) });
  }

  const n = pdf.numPages;
  put(r, 'Document', 'Pages', n);
  const cap = Math.min(n, 500);
  const pages = [];
  const sizes = new Map();
  const annotations = new Map();
  const fonts = new Map();
  let images = 0;
  const { OPS } = await pdfjs();
  for (let i = 1; i <= cap; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const size = `${Math.round(vp.width / 72 * 25.4)} × ${Math.round(vp.height / 72 * 25.4)} mm`;
    sizes.set(size, (sizes.get(size) || 0) + 1);
    const tc = await page.getTextContent();
    let text = '', lastY = null;
    for (const it of tc.items) {
      if (it.str === undefined) continue;
      const y = it.transform ? it.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && !text.endsWith('\n')) text += '\n';
      text += it.str;
      if (it.hasEOL) text += '\n';
      if (y !== null) lastY = y;
    }
    pages.push(U.collapse(text));
    try {
      (await page.getAnnotations()).forEach((a) => annotations.set(a.subtype, (annotations.get(a.subtype) || 0) + 1));
    } catch (e) { /* annotations are optional */ }
    // Operator lists are slow on long documents; the first pages give a fair picture
    if (i <= 20) {
      try {
        const ops = await page.getOperatorList();
        ops.fnArray.forEach((fn, k) => {
          if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) images++;
          if (fn === OPS.setFont) {
            const id = ops.argsArray[k][0];
            if (!fonts.has(id) && page.commonObjs.has(id)) {
              const f = page.commonObjs.get(id);
              fonts.set(id, { name: f.name || id, embedded: !f.missingFile, type: f.type });
            }
          }
        });
      } catch (e) { /* page stays uncounted */ }
    }
    if (progress) progress(i / cap);
    if (i % 10 === 0) await U.yield();
    page.cleanup();
  }
  r.text = pages.map((x, i) => (cap > 1 ? `[Page ${i + 1}]\n` : '') + x).join('\n\n');
  r.summaryText = pages.join('\n\n');
  r.pageTexts = pages;
  if (n > cap) r.warnings.push(t('Only the first {cap} of {n} pages were read.', { cap, n }));
  const withText = pages.filter((x) => x.length > 20).length;
  put(r, 'Structure', 'Pages with text', `${withText} / ${cap}`);
  if (!withText) { r.warnings.push(t('No text layer found: this PDF is probably a scan or image-only. Use OCR to read it.')); r.canOcr = true; }
  else if (withText < cap) r.canOcr = true;
  put(r, 'Document', 'Page size', [...sizes.keys()].slice(0, 6).join(', '));
  put(r, 'Structure', 'Images (first 20 pages)', images);
  if (annotations.size) put(r, 'Structure', 'Annotations', [...annotations.entries()].map(([k, v]) => `${k} × ${v}`).join(', '));
  if (fonts.size) {
    const list = [...fonts.values()].map((f) => `${f.name}${f.type ? ` · ${f.type}` : ''}${f.embedded ? '' : ` · ${t('not embedded')}`}`);
    put(r, 'Structure', 'Fonts (first 20 pages)', fonts.size);
    r.sections.push({ title: t('Fonts'), list });
  }
  r.sections.push({ title: t('Pages ({n})', { n }), pages: pages.slice(0, 120).map((x, i) => ({ n: i + 1, text: x.slice(0, 700) })), open: false });
  try {
    const ol = await pdf.getOutline();
    if (ol && ol.length) {
      const flat = [];
      (function w(items, d) { items.forEach((i) => { flat.push(' '.repeat(d) + i.title); if (i.items && d < 3) w(i.items, d + 1); }); })(ol, 0);
      r.sections.unshift({ title: t('Bookmarks'), list: flat.slice(0, 200), open: true });
      r.headings = ol.map((o) => ({ level: 1, title: o.title }));
    }
  } catch (e) { /* no outline */ }
  fact(r, 'Pages', n); fact(r, 'Words', U.fmtNum(countWords(r.summaryText)));
  if (info.Author) fact(r, 'Author', info.Author);
  if (attachments) fact(r, 'Attachments', r.embedded.length);
  r.pdfBytes = u8;
  await pdf.destroy();
  return r;
}

/* ---------- Images ---------- */
const EXIF0 = { 0x010e: 'Description', 0x010f: 'Camera make', 0x0110: 'Camera model', 0x0112: 'Orientation', 0x011a: 'X resolution', 0x011b: 'Y resolution',
  0x0131: 'Software', 0x0132: 'Modified', 0x013b: 'Artist', 0x8298: 'Copyright', 0x0100: 'Image width', 0x0101: 'Image height', 0x0102: 'Bits per sample', 0x0103: 'Compression', 0x0106: 'Photometric', 0x0128: 'Resolution unit', 0x0213: 'YCbCr positioning' };
const EXIF1 = { 0x829a: 'Exposure time', 0x829d: 'Aperture', 0x8827: 'ISO', 0x9003: 'Taken', 0x9004: 'Digitized', 0x9201: 'Shutter speed (APEX)', 0x9204: 'Exposure bias',
  0x9207: 'Metering mode', 0x9209: 'Flash', 0x920a: 'Focal length', 0xa002: 'Pixel width', 0xa003: 'Pixel height', 0xa405: 'Focal length (35mm)', 0xa433: 'Lens make', 0xa434: 'Lens model',
  0xa431: 'Body serial', 0x9286: 'User comment', 0x8822: 'Exposure program', 0x9000: 'EXIF version', 0x9201: 'Shutter speed (APEX)', 0x9202: 'Aperture (APEX)', 0x9203: 'Brightness (APEX)', 0x9205: 'Max aperture (APEX)', 0x9206: 'Subject distance', 0x9208: 'Light source', 0x9290: 'Subsecond', 0x9291: 'Subsecond original', 0xa001: 'Color space', 0xa217: 'Sensing method', 0xa402: 'Exposure mode', 0xa403: 'White balance', 0xa404: 'Digital zoom', 0xa406: 'Scene capture type', 0xa408: 'Contrast', 0xa409: 'Saturation', 0xa40a: 'Sharpness', 0xa420: 'Unique image ID', 0xa430: 'Camera owner', 0xa432: 'Lens specification', 0xa435: 'Lens serial' };
const ORIENT = { 1: 'Normal', 2: 'Mirrored', 3: 'Rotated 180°', 4: 'Mirrored vertically', 5: 'Mirrored, rotated 90° CCW', 6: 'Rotated 90° CW', 7: 'Mirrored, rotated 90° CW', 8: 'Rotated 90° CCW' };
const TSIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
function readTiff(u8, base) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const le = u8[base] === 0x49;
  const u16 = (o) => dv.getUint16(base + o, le), u32 = (o) => dv.getUint32(base + o, le);
  const out = { ifd0: {}, exif: {}, gps: {} };
  const ifd = (off, names, dest, follow) => {
    if (!off || base + off + 2 > u8.length) return;
    const n = u16(off);
    for (let i = 0; i < n && i < 400; i++) {
      const e = off + 2 + i * 12;
      if (base + e + 12 > u8.length) break;
      const tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
      const sz = (TSIZE[type] || 1) * cnt;
      const vo = sz <= 4 ? e + 8 : u32(e + 8);
      if (base + vo + sz > u8.length) continue;
      let val;
      try {
        if (type === 2) val = U.ascii(u8, base + vo, cnt).replace(/\0.*$/s, '').trim();
        else if (type === 3) val = cnt === 1 ? u16(vo) : Array.from({ length: Math.min(cnt, 8) }, (_, k) => u16(vo + k * 2));
        else if (type === 4) val = cnt === 1 ? u32(vo) : Array.from({ length: Math.min(cnt, 8) }, (_, k) => u32(vo + k * 4));
        else if (type === 8) val = cnt === 1 ? dv.getInt16(base + vo, le) : undefined;
        else if (type === 9) val = cnt === 1 ? dv.getInt32(base + vo, le) : undefined;
        else if (type === 11) val = cnt === 1 ? dv.getFloat32(base + vo, le) : undefined;
        else if (type === 12) val = cnt === 1 ? dv.getFloat64(base + vo, le) : undefined;
        else if (type === 5 || type === 10) {
          val = Array.from({ length: Math.min(cnt, 8) }, (_, k) => {
            const a = type === 5 ? u32(vo + k * 8) : dv.getInt32(base + vo + k * 8, le), b = type === 5 ? u32(vo + k * 8 + 4) : dv.getInt32(base + vo + k * 8 + 4, le);
            return b ? a / b : 0;
          });
          if (val.length === 1) val = val[0];
        } else if (type === 7 && tag === 0x9286) val = U.ascii(u8, base + vo + 8, Math.max(0, cnt - 8)).replace(/\0/g, '').trim();
        else continue;
      } catch (err) { continue; }
      if (val === undefined) continue;
      if (names && names[tag]) dest[names[tag]] = val;
      else if (dest === out.gps) dest[tag] = val;
      if (follow && tag === 0x8769) ifd(u32(vo) && (sz <= 4 ? u32(e + 8) : u32(vo)), EXIF1, out.exif, false);
      if (follow && tag === 0x8825) ifd(sz <= 4 ? u32(e + 8) : u32(vo), null, out.gps, false);
    }
  };
  ifd(u32(4), EXIF0, out.ifd0, true);
  return out;
}
E.cameraName = (make, model) => (make && model && model.toLowerCase().startsWith(make.toLowerCase()) ? model : [make, model].filter(Boolean).join(' '));
function exifToMeta(r, ex) {
  const G = 'Camera & EXIF';
  const f = ex.ifd0, x = ex.exif;
  const num = (v) => (Array.isArray(v) ? v[0] : v);
  put(r, G, 'Camera make', f['Camera make']); put(r, G, 'Camera model', f['Camera model']); put(r, G, 'Lens', x['Lens model']);
  put(r, G, 'Taken', x.Taken || f.Modified); put(r, G, 'Software', f.Software); put(r, G, 'Artist', f.Artist); put(r, G, 'Copyright', f.Copyright);
  put(r, G, 'Description', f.Description); put(r, G, 'Orientation', ORIENT[num(f.Orientation)] || '');
  if (x['Exposure time']) { const e = num(x['Exposure time']); put(r, G, 'Exposure', e < 1 ? `1/${Math.round(1 / e)} s` : `${e} s`); }
  if (x.Aperture) put(r, G, 'Aperture', 'f/' + (+num(x.Aperture)).toFixed(1));
  put(r, G, 'ISO', num(x.ISO)); if (x['Focal length']) put(r, G, 'Focal length', (+num(x['Focal length'])).toFixed(1) + ' mm');
  put(r, G, 'Focal length (35mm)', x['Focal length (35mm)'] ? x['Focal length (35mm)'] + ' mm' : '');
  put(r, G, 'Flash fired', x.Flash !== undefined ? (num(x.Flash) & 1 ? 'Yes' : 'No') : '');
  const seen = new Set(['Camera make', 'Camera model', 'Lens model', 'Taken', 'Modified', 'Software', 'Artist', 'Copyright', 'Description', 'Orientation', 'Exposure time', 'Aperture', 'ISO', 'Focal length', 'Focal length (35mm)', 'Flash']);
  [f, x].forEach((src) => Object.entries(src).forEach(([k, v]) => {
    if (seen.has(k)) return;
    const value = Array.isArray(v) ? v.map((n) => (typeof n === 'number' ? +n.toFixed(3) : n)).join(', ') : typeof v === 'number' ? +v.toFixed(4) : v;
    put(r, 'All EXIF tags', k, String(value).slice(0, 300));
  }));
  const g = ex.gps;
  if (g[2] && g[4]) {
    const dms = (v) => v[0] + v[1] / 60 + v[2] / 3600;
    let lat = dms(g[2]), lon = dms(g[4]);
    if (g[1] === 'S') lat = -lat; if (g[3] === 'W') lon = -lon;
    put(r, 'Location', 'Latitude', lat.toFixed(6)); put(r, 'Location', 'Longitude', lon.toFixed(6));
    if (g[6] !== undefined) put(r, 'Location', 'Altitude', (+num(g[6])).toFixed(0) + ' m');
    r.gps = [lat, lon];
    fact(r, 'GPS', `${lat.toFixed(4)}, ${lon.toFixed(4)}`);
  }
  if (f['Camera model']) fact(r, 'Camera', E.cameraName(f['Camera make'], f['Camera model']));
  if (x.Taken || f.Modified) fact(r, 'Taken', x.Taken ? x.Taken.replace(/^(\d{4}):(\d\d):(\d\d)/, '$1-$2-$3') : f.Modified);
}
function jpegInfo(u8) {
  let p = 2, ex = null;
  const o = {};
  while (p + 4 < u8.length) {
    if (u8[p] !== 0xff) { p++; continue; }
    const m = u8[p + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { p += m === 0xff ? 1 : 2; continue; }
    if (m === 0xda || m === 0xd9) break;
    const len = (u8[p + 2] << 8) | u8[p + 3];
    if (m === 0xe1 && U.ascii(u8, p + 4, 6) === 'Exif\0\0') { try { ex = readTiff(u8, p + 10); } catch (e) { /* ignore */ } }
    if (m === 0xe1 && U.ascii(u8, p + 4, 28).startsWith('http://ns.adobe.com/xap')) o.xmp = true;
    if (m === 0xe0 && U.ascii(u8, p + 4, 4) === 'JFIF') o.jfif = true;
    if (m === 0xfe) o.comment = U.ascii(u8, p + 4, len - 2).trim();
    if (m === 0xed && U.ascii(u8, p + 4, 13) === 'Photoshop 3.0') { try { o.iptc = parseIptc(u8.subarray(p + 18, p + 2 + len)); } catch (e) { /* ignore */ } }
    if (m === 0xe2 && U.ascii(u8, p + 4, 11) === 'ICC_PROFILE' && !o.icc) { try { o.icc = parseIcc(u8.slice(p + 18, p + 2 + len)); } catch (e) { /* ignore */ } }
    if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb)) {
      o.height = (u8[p + 5] << 8) | u8[p + 6]; o.width = (u8[p + 7] << 8) | u8[p + 8]; o.bits = u8[p + 4];
      o.components = u8[p + 9]; o.progressive = m === 0xc2;
    }
    p += 2 + len;
  }
  o.exif = ex;
  return o;
}
function pngInfo(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const o = { text: {} };
  let p = 8, n = 0;
  while (p + 8 <= u8.length && n++ < 5000) {
    const len = dv.getUint32(p), type = U.ascii(u8, p + 4, 4), d = p + 8;
    if (type === 'IHDR') { o.width = dv.getUint32(d); o.height = dv.getUint32(d + 4); o.bits = u8[d + 8]; o.colorType = u8[d + 9]; o.interlaced = u8[d + 12] === 1; }
    else if (type === 'tEXt') { const s = U.ascii(u8, d, len), i = s.indexOf('\0'); if (i > 0) o.text[s.slice(0, i)] = s.slice(i + 1); }
    else if (type === 'iTXt') {
      const s = u8.subarray(d, d + len); const i = s.indexOf(0);
      if (i > 0 && s[i + 1] === 0) { const rest = s.subarray(i + 3); const a = rest.indexOf(0); const b = rest.indexOf(0, a + 1); o.text[U.ascii(s, 0, i)] = new TextDecoder().decode(rest.subarray(b + 1)); }
    }
    else if (type === 'pHYs') { o.ppu = dv.getUint32(d); o.unit = u8[d + 8]; }
    else if (type === 'eXIf') { try { o.exif = readTiff(u8, d); } catch (e) { /* ignore */ } }
    else if (type === 'acTL') o.frames = dv.getUint32(d);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  return o;
}
const dataViewLen = (u8, o) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(o);
function loadImage(url) {
  return new Promise((res) => {
    const im = new Image();
    const t = setTimeout(() => res(null), 6000);
    im.onload = () => { clearTimeout(t); res(im); };
    im.onerror = () => { clearTimeout(t); res(null); };
    im.src = url;
  });
}
const CT = ['Grayscale', 'Unknown', 'RGB', 'Indexed', 'Grayscale + alpha', 'Unknown', 'RGB + alpha'];
async function handleImage(u8, name, det) {
  const r = newResult();
  const url = URL.createObjectURL(new Blob([u8], { type: MIME[det.key] }));
  r.preview = { type: 'image', url };
  let w = 0, h = 0, ex = null;
  if (det.key === 'jpeg') {
    const j = jpegInfo(u8); w = j.width; h = j.height; ex = j.exif;
    put(r, 'Image', 'Color components', j.components); put(r, 'Image', 'Bit depth', j.bits); put(r, 'Image', 'Progressive', j.progressive ? 'Yes' : '');
    put(r, 'Image', 'Embedded XMP', j.xmp ? 'Yes' : ''); put(r, 'Image', 'Comment', j.comment);
    if (j.iptc) Object.entries(j.iptc).forEach(([k, v]) => put(r, 'IPTC', k, v));
    if (j.icc) Object.entries(j.icc).forEach(([k, v]) => put(r, 'ICC color profile', k, v));
  } else if (det.key === 'png') {
    const p = pngInfo(u8); w = p.width; h = p.height; ex = p.exif;
    put(r, 'Image', 'Color type', CT[p.colorType]); put(r, 'Image', 'Bit depth', p.bits); put(r, 'Image', 'Interlaced', p.interlaced ? 'Yes' : '');
    put(r, 'Image', 'Animation frames', p.frames);
    if (p.ppu && p.unit === 1) put(r, 'Image', 'Resolution', Math.round(p.ppu * 0.0254) + ' DPI');
    Object.entries(p.text).slice(0, 40).forEach(([k, v]) => put(r, 'Embedded text', k, String(v).slice(0, 2000)));
  } else if (det.key === 'gif') {
    w = u8[6] | (u8[7] << 8); h = u8[8] | (u8[9] << 8);
    let frames = 0; for (let i = 0; i < u8.length - 3 && frames < 5000; i++) if (u8[i] === 0x21 && u8[i + 1] === 0xf9 && u8[i + 2] === 4) frames++;
    put(r, 'Image', 'Frames', frames > 1 ? frames : '');
  } else if (det.key === 'tiff') {
    try { ex = readTiff(u8, 0); w = ex.ifd0['Image width'] || 0; h = ex.ifd0['Image height'] || 0; } catch (e) { /* ignore */ }
  } else if (det.key === 'webp') {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const chunks = [];
    for (let q = 12; q + 8 <= u8.length && chunks.length < 200;) {
      const id = U.ascii(u8, q, 4), sz = dv.getUint32(q + 4, true);
      chunks.push(id.trim());
      if (id === 'VP8X') { w = (u8[q + 12] | (u8[q + 13] << 8) | (u8[q + 14] << 16)) + 1; h = (u8[q + 15] | (u8[q + 16] << 8) | (u8[q + 17] << 16)) + 1; put(r, 'Image', 'Animated', u8[q + 8] & 2 ? 'Yes' : ''); put(r, 'Image', 'Has alpha', u8[q + 8] & 16 ? 'Yes' : ''); }
      if (id === 'EXIF') { try { const base = U.ascii(u8, q + 8, 4) === 'Exif' ? q + 14 : q + 8; ex = readTiff(u8, base); } catch (e) { /* ignore */ } }
      if (id === 'ICCP') { try { const icc = parseIcc(u8.slice(q + 8, q + 8 + sz)); if (icc) Object.entries(icc).forEach(([k, v]) => put(r, 'ICC color profile', k, v)); } catch (e) { /* ignore */ } }
      q += 8 + sz + (sz & 1);
    }
    put(r, 'Image', 'WebP chunks', [...new Set(chunks)].join(', '));
    put(r, 'Image', 'Compression', chunks.includes('VP8L') ? 'Lossless' : chunks.includes('VP8') ? 'Lossy' : '');
  } else if (det.key === 'bmp') {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    w = Math.abs(dv.getInt32(18, true)); h = Math.abs(dv.getInt32(22, true));
    put(r, 'Image', 'Bit depth', dv.getUint16(28, true)); put(r, 'Image', 'Header size', dv.getUint32(14, true));
  } else if (det.key === 'ico') {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const count = dv.getUint16(4, true);
    const sizes = [];
    for (let i = 0; i < count && i < 64; i++) sizes.push(`${u8[6 + i * 16] || 256} × ${u8[7 + i * 16] || 256}`);
    put(r, 'Image', 'Icon sizes', sizes.join(', '));
    w = u8[6] || 256; h = u8[7] || 256;
  }
  if (det.key === 'heic' || det.key === 'avif') {
    const hay = U.ascii(u8, 0, Math.min(u8.length, 256 * 1024));
    let best = 0;
    for (let i = hay.indexOf('ispe'); i >= 0; i = hay.indexOf('ispe', i + 4)) {
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      const iw = dv.getUint32(i + 8), ih = dv.getUint32(i + 12);
      if (iw * ih > best) { best = iw * ih; w = iw; h = ih; }
    }
    const brands = U.ascii(u8, 8, Math.min(dataViewLen(u8, 0) - 8, 40)).replace(/\0/g, ' ').trim();
    put(r, 'Image', 'Container brands', brands);
  }
  const im = await loadImage(url);
  if (im) { w = w || im.naturalWidth; h = h || im.naturalHeight; }
  else if (det.key === 'heic' || det.key === 'tiff') r.warnings.push(t('This browser cannot display a preview of this image format.'));
  if (w && h) {
    put(r, 'Image', 'Width', w + ' px'); put(r, 'Image', 'Height', h + ' px'); put(r, 'Image', 'Megapixels', (w * h / 1e6).toFixed(1) + ' MP');
    const g = (a, b) => (b ? g(b, a % b) : a); const d = g(w, h);
    put(r, 'Image', 'Aspect ratio', `${w / d}:${h / d}`);
    fact(r, 'Dimensions', `${w} × ${h} px`); fact(r, 'Megapixels', (w * h / 1e6).toFixed(1));
  }
  if (ex) exifToMeta(r, ex);
  r.imageDims = w && h ? [w, h] : null;
  r.noText = true;
  r.canOcr = !!im;
  r.imageUrl = url;
  return r;
}

/* ---------- Audio / video ---------- */
function mediaInfo(u8, mime, video) {
  return new Promise((res) => {
    const el = document.createElement(video ? 'video' : 'audio');
    const url = URL.createObjectURL(new Blob([u8], { type: mime }));
    el.preload = 'metadata';
    const done = (ok) => { clearTimeout(t); res({ ok, url, duration: ok ? el.duration : 0, w: el.videoWidth || 0, h: el.videoHeight || 0 }); };
    const t = setTimeout(() => done(false), 6000);
    el.onloadedmetadata = () => done(true);
    el.onerror = () => done(false);
    el.src = url;
  });
}
const synchsafe = (u8, o) => ((u8[o] & 0x7f) << 21) | ((u8[o + 1] & 0x7f) << 14) | ((u8[o + 2] & 0x7f) << 7) | (u8[o + 3] & 0x7f);
function id3Text(d) {
  const enc = d[0], rest = d.subarray(1);
  let s;
  if (enc === 0) s = new TextDecoder('windows-1252').decode(rest);
  else if (enc === 1) s = (rest[0] === 0xfe && rest[1] === 0xff) ? new TextDecoder('utf-16be').decode(rest.subarray(2)) : new TextDecoder('utf-16le').decode(rest[0] === 0xff ? rest.subarray(2) : rest);
  else if (enc === 2) s = new TextDecoder('utf-16be').decode(rest);
  else s = new TextDecoder('utf-8').decode(rest);
  return s.replace(/\0+$/, '').replace(/\0/g, ' / ').trim();
}
const ID3 = { TIT2: 'Title', TT2: 'Title', TPE1: 'Artist', TP1: 'Artist', TALB: 'Album', TAL: 'Album', TPE2: 'Album artist', TP2: 'Album artist',
  TYER: 'Year', TYE: 'Year', TDRC: 'Year', TCON: 'Genre', TCO: 'Genre', TRCK: 'Track', TRK: 'Track', TPOS: 'Disc', TCOM: 'Composer', TPUB: 'Publisher',
  TBPM: 'BPM', TSSE: 'Encoder', TENC: 'Encoded by', TCOP: 'Copyright', TLAN: 'Language', TKEY: 'Key' };
function readId3(u8) {
  const o = { tags: {}, size: 0 };
  if (U.ascii(u8, 0, 3) === 'ID3') {
    const ver = u8[3], flags = u8[5];
    const size = synchsafe(u8, 6);
    o.size = size + 10;
    let p = 10;
    if (flags & 0x40 && ver >= 3) p += ver === 4 ? synchsafe(u8, p) : ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) + 4;
    const end = Math.min(u8.length, 10 + size);
    const hdr = ver === 2 ? 6 : 10;
    while (p + hdr <= end) {
      const id = U.ascii(u8, p, ver === 2 ? 3 : 4);
      if (!/^[A-Z0-9]+$/.test(id)) break;
      const fs = ver === 2 ? (u8[p + 3] << 16) | (u8[p + 4] << 8) | u8[p + 5] : ver === 4 ? synchsafe(u8, p + 4) : (u8[p + 4] << 24 | u8[p + 5] << 16 | u8[p + 6] << 8 | u8[p + 7]) >>> 0;
      const d = u8.subarray(p + hdr, p + hdr + fs);
      p += hdr + fs;
      if (ID3[id] && d.length > 1) { let v = id3Text(d); if (id.startsWith('TCO')) v = v.replace(/^\((\d+)\)/, '').trim(); if (v) o.tags[ID3[id]] = v; }
      else if ((id === 'COMM' || id === 'COM' || id === 'USLT') && d.length > 5) {
        const enc = d[0]; let i = 4; const wide = enc === 1 || enc === 2;
        while (i < d.length && !(d[i] === 0 && (!wide || d[i + 1] === 0))) i += wide ? 2 : 1;
        i += wide ? 2 : 1;
        const t = id3Text(new Uint8Array([enc, ...d.subarray(i)]));
        if (t) o.tags[id === 'USLT' ? 'Lyrics' : 'Comment'] = t;
      } else if ((id === 'APIC' || id === 'PIC') && d.length > 20 && !o.cover) {
        let i = 1; while (i < d.length && d[i] !== 0) i++;
        const mimeS = id === 'PIC' ? 'image/' + U.ascii(d, 1, 3).toLowerCase() : U.ascii(d, 1, i - 1);
        i += id === 'PIC' ? 0 : 1; i += 1;
        const wide = d[0] === 1 || d[0] === 2;
        while (i < d.length && !(d[i] === 0 && (!wide || d[i + 1] === 0))) i += wide ? 2 : 1;
        i += wide ? 2 : 1;
        o.cover = { type: mimeS.startsWith('image/') ? mimeS : 'image/jpeg', data: d.slice(i) };
      }
    }
  }
  if (U.ascii(u8, u8.length - 128, 3) === 'TAG') {
    const t = (o2, l) => U.ascii(u8, u8.length - 128 + o2, l).replace(/\0.*$/s, '').trim();
    const v1 = { Title: t(3, 30), Artist: t(33, 30), Album: t(63, 30), Year: t(93, 4), Comment: t(97, 30) };
    Object.entries(v1).forEach(([k, v]) => { if (v && !o.tags[k]) o.tags[k] = v; });
  }
  return o;
}
function mp3Frame(u8, start) {
  for (let i = start; i < Math.min(u8.length - 4, start + 4096); i++) {
    if (u8[i] === 0xff && (u8[i + 1] & 0xe0) === 0xe0) {
      const ver = (u8[i + 1] >> 3) & 3, layer = (u8[i + 1] >> 1) & 3, br = u8[i + 2] >> 4, sr = (u8[i + 2] >> 2) & 3;
      if (ver === 3 && layer === 1 && br > 0 && br < 15 && sr < 3) {
        return { bitrate: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320][br], rate: [44100, 48000, 32000][sr], channels: (u8[i + 3] >> 6) === 3 ? 'Mono' : 'Stereo' };
      }
    }
  }
  return null;
}
function vorbisComments(u8, p) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = {};
  try {
    const vl = dv.getUint32(p, true); p += 4; const vendor = U.ascii(u8, p, vl); p += vl;
    const n = dv.getUint32(p, true); p += 4;
    for (let i = 0; i < n && i < 500; i++) {
      const l = dv.getUint32(p, true); p += 4;
      const s = new TextDecoder().decode(u8.subarray(p, p + l)); p += l;
      const eq = s.indexOf('=');
      if (eq > 0) { const k = s.slice(0, eq).toUpperCase(); if (!out[k]) out[k] = s.slice(eq + 1); }
    }
    out._vendor = vendor;
  } catch (e) { /* ignore */ }
  return out;
}
const VORBIS_MAP = { TITLE: 'Title', ARTIST: 'Artist', ALBUM: 'Album', ALBUMARTIST: 'Album artist', DATE: 'Year', GENRE: 'Genre', TRACKNUMBER: 'Track', DISCNUMBER: 'Disc',
  COMPOSER: 'Composer', COMMENT: 'Comment', DESCRIPTION: 'Comment', COPYRIGHT: 'Copyright', ORGANIZATION: 'Label', LYRICS: 'Lyrics', ENCODER: 'Encoder' };
function mp4Tags(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const o = { tags: {}, dur: 0 };
  const MAP = { '©nam': 'Title', '©ART': 'Artist', '©alb': 'Album', aART: 'Album artist', '©day': 'Year', '©gen': 'Genre', '©too': 'Encoder',
    '©cmt': 'Comment', '©wrt': 'Composer', desc: 'Description', cprt: 'Copyright', '©grp': 'Grouping' };
  const walk = (s, e, ilst) => {
    let p = s;
    while (p + 8 <= e) {
      let size = dv.getUint32(p), type = U.ascii(u8, p + 4, 4), hdr = 8;
      if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; } else if (size === 0) size = e - p;
      if (size < hdr) break;
      const bs = p + hdr, be = Math.min(e, p + size);
      if (ilst) {
        const dp = (() => { let q = bs; while (q + 16 <= be) { const sz = dv.getUint32(q); if (U.ascii(u8, q + 4, 4) === 'data') return q; if (sz < 8) break; q += sz; } return -1; })();
        if (dp > 0) {
          const flags = dv.getUint32(dp + 8) & 0xffffff, ds = dp + 16, de = dp + dv.getUint32(dp);
          if (type === 'covr') o.cover = { type: flags === 14 ? 'image/png' : 'image/jpeg', data: u8.slice(ds, de) };
          else if (type === 'trkn') o.tags.Track = dv.getUint16(ds + 2) + (dv.getUint16(ds + 4) ? '/' + dv.getUint16(ds + 4) : '');
          else if (MAP[type] && flags === 1) o.tags[MAP[type]] = new TextDecoder().decode(u8.subarray(ds, de));
        }
      } else if (['moov', 'udta', 'trak', 'mdia'].includes(type)) walk(bs, be, false);
      else if (type === 'meta') walk(bs + 4, be, false);
      else if (type === 'ilst') walk(bs, be, true);
      else if (type === 'mvhd') {
        const ver = u8[bs];
        const ts = ver === 1 ? dv.getUint32(bs + 20) : dv.getUint32(bs + 12);
        const du = ver === 1 ? Number(dv.getBigUint64(bs + 24)) : dv.getUint32(bs + 16);
        if (ts) o.dur = du / ts;
      } else if (type === 'ftyp') o.brand = U.ascii(u8, bs, 4).trim();
      p += size;
    }
  };
  try { walk(0, u8.length, false); } catch (e) { /* ignore */ }
  return o;
}
async function handleMedia(u8, name, det) {
  const r = newResult();
  const isVideo = ['mp4', 'mov', 'webm', 'mkv'].includes(det.key);
  const G = isVideo ? 'Video' : 'Audio';
  let tags = {}, cover = null, dur = 0;
  if (det.key === 'mp3') {
    const id = readId3(u8); tags = id.tags; cover = id.cover;
    const f = mp3Frame(u8, id.size);
    if (f) { put(r, G, 'Bitrate', f.bitrate + ' kbps'); put(r, G, 'Sample rate', f.rate + ' Hz'); put(r, G, 'Channels', f.channels); fact(r, 'Bitrate', f.bitrate + ' kbps'); }
    put(r, 'Tags', 'ID3 tag version', u8[0] === 0x49 ? '2.' + u8[3] : 'v1');
  } else if (det.key === 'flac') {
    let p = 4;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    for (let n = 0; n < 50 && p + 4 <= u8.length; n++) {
      const last = u8[p] & 0x80, type = u8[p] & 0x7f, len = (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3];
      const d = p + 4;
      if (type === 0 && len >= 18) {
        const rate = (u8[d + 10] << 12) | (u8[d + 11] << 4) | (u8[d + 12] >> 4);
        const ch = ((u8[d + 12] >> 1) & 7) + 1, bps = (((u8[d + 12] & 1) << 4) | (u8[d + 13] >> 4)) + 1;
        const total = (u8[d + 13] & 15) * 4294967296 + dv.getUint32(d + 14);
        put(r, G, 'Sample rate', rate + ' Hz'); put(r, G, 'Channels', ch); put(r, G, 'Bit depth', bps + ' bit');
        if (rate) dur = total / rate;
      } else if (type === 4) {
        const v = vorbisComments(u8, d);
        Object.entries(v).forEach(([k, val]) => { if (VORBIS_MAP[k]) tags[VORBIS_MAP[k]] = val; });
        put(r, 'Tags', 'Vendor', v._vendor);
      } else if (type === 6 && !cover) {
        try {
          let q = d + 4; const ml = dv.getUint32(q); q += 4; const mt = U.ascii(u8, q, ml); q += ml;
          const dl = dv.getUint32(q); q += 4 + dl + 16; const il = dv.getUint32(q); q += 4;
          cover = { type: mt || 'image/jpeg', data: u8.slice(q, q + il) };
        } catch (e) { /* ignore */ }
      }
      p = d + len;
      if (last) break;
    }
  } else if (det.key === 'ogg') {
    const hay = U.ascii(u8, 0, Math.min(u8.length, 262144));
    let i = hay.indexOf('\x03vorbis'), off = 7;
    if (i < 0) { i = hay.indexOf('OpusTags'); off = 8; put(r, G, 'Codec', 'Opus'); } else put(r, G, 'Codec', 'Vorbis');
    if (i >= 0) { const v = vorbisComments(u8, i + off); Object.entries(v).forEach(([k, val]) => { if (VORBIS_MAP[k]) tags[VORBIS_MAP[k]] = val; }); put(r, 'Tags', 'Vendor', v._vendor); }
  } else if (det.key === 'wav') {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let p = 12, byteRate = 0, dataSize = 0;
    while (p + 8 <= u8.length) {
      const id = U.ascii(u8, p, 4), sz = dv.getUint32(p + 4, true);
      if (id === 'fmt ') {
        put(r, G, 'Format', { 1: 'PCM', 3: 'IEEE float', 6: 'A-law', 7: 'µ-law', 0xfffe: 'Extensible' }[dv.getUint16(p + 8, true)] || 'Compressed');
        put(r, G, 'Channels', dv.getUint16(p + 10, true)); put(r, G, 'Sample rate', dv.getUint32(p + 12, true) + ' Hz');
        byteRate = dv.getUint32(p + 16, true); put(r, G, 'Bit depth', dv.getUint16(p + 22, true) + ' bit');
      } else if (id === 'data') dataSize = sz;
      else if (id === 'LIST' && U.ascii(u8, p + 8, 4) === 'INFO') {
        let q = p + 12; const e = Math.min(u8.length, p + 8 + sz);
        const M = { INAM: 'Title', IART: 'Artist', IPRD: 'Album', ICRD: 'Year', ICMT: 'Comment', IGNR: 'Genre', ISFT: 'Encoder' };
        while (q + 8 <= e) { const k = U.ascii(u8, q, 4), l = dv.getUint32(q + 4, true); if (M[k]) tags[M[k]] = U.ascii(u8, q + 8, l).replace(/\0.*$/s, '').trim(); q += 8 + l + (l & 1); }
      }
      p += 8 + sz + (sz & 1);
    }
    if (byteRate && dataSize) dur = dataSize / byteRate;
  } else if (['m4a', 'mp4', 'mov'].includes(det.key)) {
    const m = mp4Tags(u8); tags = m.tags; cover = m.cover; dur = m.dur;
    put(r, G, 'Container brand', m.brand);
  }
  const info = await mediaInfo(u8, MIME[det.key], isVideo);
  if (info.ok && info.duration && isFinite(info.duration)) dur = info.duration;
  if (dur) { put(r, G, 'Duration', U.fmtDuration(dur)); fact(r, 'Duration', U.fmtDuration(dur)); }
  if (info.w && info.h) { put(r, 'Video', 'Resolution', `${info.w} × ${info.h}`); fact(r, 'Resolution', `${info.w} × ${info.h}`); }
  Object.entries(tags).forEach(([k, v]) => put(r, 'Tags', k, String(v).slice(0, 4000)));
  if (tags.Title) { r.title = tags.Title; }
  if (tags.Artist) fact(r, 'Artist', tags.Artist); if (tags.Album) fact(r, 'Album', tags.Album); if (tags.Year) fact(r, 'Year', tags.Year);
  if (tags.Lyrics) r.text = tags.Lyrics;
  r.noText = !tags.Lyrics;
  if (info.ok) r.preview = { type: isVideo ? 'video' : 'audio', url: info.url, cover: cover ? URL.createObjectURL(new Blob([cover.data], { type: cover.type })) : null };
  else {
    URL.revokeObjectURL(info.url);
    if (cover) r.preview = { type: 'image', url: URL.createObjectURL(new Blob([cover.data], { type: cover.type })) };
    r.warnings.push(t('This browser could not decode the media stream; showing tag data only.'));
  }
  return r;
}

/* ---------- Archives ---------- */
function archiveSummary(r, rows, groupName) {
  const byExt = new Map();
  let total = 0, packed = 0, files = 0, dirs = 0;
  rows.forEach((x) => {
    if (x.dir) { dirs++; return; }
    files++; total += x.size; packed += x.csize || 0;
    const e = U.extOf(x.name) || '(none)';
    const c = byExt.get(e) || { n: 0, size: 0 }; c.n++; c.size += x.size; byExt.set(e, c);
  });
  put(r, groupName, 'Files', U.fmtNum(files)); put(r, groupName, 'Folders', dirs || '');
  put(r, groupName, 'Uncompressed size', U.fmtBytes(total));
  if (packed) put(r, groupName, 'Compressed size', U.fmtBytes(packed));
  fact(r, 'Files', U.fmtNum(files)); fact(r, 'Folders', dirs); fact(r, 'Unpacked', U.fmtBytes(total));
  const types = [...byExt.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12);
  const biggest = rows.filter((x) => !x.dir).sort((a, b) => b.size - a.size).slice(0, 5);
  r.sections.push({ title: t('Contents'), table: { head: ['Name', 'Size', 'Modified'], rows: [['Name', 'Size', 'Modified'], ...rows.slice(0, 500).map((x) => [x.name, x.dir ? '' : U.fmtBytes(x.size), x.date ? U.fmtDate(x.date) : ''])] }, open: true });
  r.sections.push({ title: t('By file type'), list: types.map(([e, c]) => `.${e} — ${c.n} file${c.n > 1 ? 's' : ''}, ${U.fmtBytes(c.size)}`) });
  r.text = rows.map((x) => x.name).join('\n');
  r.archive = { files, dirs, total, types: types.map(([e, c]) => ({ ext: e, n: c.n })), biggest: biggest.map((b) => `${b.name} (${U.fmtBytes(b.size)})`) };
  r.noText = true;
}
async function handleZip(u8, name, det) {
  const r = newResult();
  if (!det.zip) { r.warnings.push(det.zipError || 'Could not read ZIP directory.'); return r; }
  archiveSummary(r, det.zip.entries, 'Archive');
  if (det.zip.zip64) put(r, 'Archive', 'ZIP64', 'Yes');
  r.embedded = det.zip.entries.filter((e) => !e.dir && !e.encrypted).map((e) => ({ name: e.name, size: e.size, date: e.date, read: () => det.zip.read(e) }));
  const enc = det.zip.entries.filter((e) => e.encrypted).length;
  if (enc) { put(r, 'Archive', 'Encrypted entries', enc); r.warnings.push(t('Password-protected entries: {n}', { n: enc })); }
  const zipKinds = { cbz: 'Comic book archive', kmz: 'Google Earth file', npz: 'NumPy archive', jar: 'Java archive', war: 'Java web archive', apk: 'Android app', xpi: 'Browser extension', crx: 'Browser extension', whl: 'Python wheel', nupkg: 'NuGet package', ipa: 'iOS app', sketch: 'Sketch document' };
  const zipExt = U.extOf(name);
  if (zipKinds[zipExt]) r.kind = zipKinds[zipExt];
  if (det.zip.has('AndroidManifest.xml')) r.kind = 'Android app';
  const jar = det.zip.has('META-INF/MANIFEST.MF');
  if (jar) { r.kind = r.kind || 'Java archive'; const mf = await det.zip.text('META-INF/MANIFEST.MF'); mf.split(/\r?\n/).filter(Boolean).slice(0, 12).forEach((l) => { const i = l.indexOf(':'); if (i > 0) put(r, 'Manifest', l.slice(0, i), l.slice(i + 1).trim()); }); }
  return r;
}
async function handleTar(u8, name) {
  const r = newResult();
  const rows = [];
  let p = 0, longName = '';
  while (p + 512 <= u8.length && rows.length < 20000) {
    if (u8[p] === 0) break;
    let nm = U.ascii(u8, p, 100).replace(/\0.*$/s, '');
    const prefix = U.ascii(u8, p + 345, 155).replace(/\0.*$/s, '');
    if (prefix) nm = prefix + '/' + nm;
    const size = parseInt(U.ascii(u8, p + 124, 12).replace(/\0.*$/s, '').trim() || '0', 8) || 0;
    const mtime = parseInt(U.ascii(u8, p + 136, 12).replace(/\0.*$/s, '').trim() || '0', 8);
    const type = String.fromCharCode(u8[p + 156] || 48);
    if (type === 'x' || type === 'g' || type === 'K') { p += 512 + Math.ceil(size / 512) * 512; continue; }
    if (type === 'L') { longName = U.ascii(u8, p + 512, size).replace(/\0.*$/s, ''); p += 512 + Math.ceil(size / 512) * 512; continue; }
    if (longName) { nm = longName; longName = ''; }
    const dataOff = p + 512;
    rows.push({ name: nm, size, dir: type === '5', date: mtime ? new Date(mtime * 1000) : null, read: async () => u8.subarray(dataOff, dataOff + size) });
    p += 512 + Math.ceil(size / 512) * 512;
  }
  archiveSummary(r, rows, 'Archive');
  r.embedded = rows.filter((x) => !x.dir);
  return r;
}
async function handleGzip(u8, name) {
  const r0 = newResult();
  const flags = u8[3], mtime = u8[4] | (u8[5] << 8) | (u8[6] << 16) | (u8[7] << 24);
  let origName = '';
  if (flags & 8) { let p = 10; if (flags & 4) p += 2 + (u8[10] | (u8[11] << 8)); let e = p; while (u8[e]) e++; origName = U.ascii(u8, p, e - p); }
  const inner = await U.inflate(u8, 'gzip');
  let innerName = origName || name.replace(/\.(gz|gzip)$/i, '').replace(/\.tgz$/i, '.tar');
  const r = await E.analyzeBytes(inner, innerName, '');
  put(r, 'Compression', 'Container', 'gzip'); put(r, 'Compression', 'Original name', origName);
  put(r, 'Compression', 'Compressed size', U.fmtBytes(u8.length)); put(r, 'Compression', 'Unpacked size', U.fmtBytes(inner.length));
  if (mtime) put(r, 'Compression', 'Stored timestamp', U.metaDate(new Date(mtime * 1000)));
  r.gzipped = true;
  r.facts.unshift(['Compressed', U.fmtBytes(u8.length)]);
  return r;
}

/* ---------- legacy OLE & generic binary ---------- */
function extractStrings(u8, minLen, cap) {
  const out = [];
  let cur = '';
  for (let i = 0; i < u8.length && out.length < cap; i++) {
    const b = u8[i];
    if ((b >= 32 && b < 127) || b === 9 || b === 10 || b === 13) cur += String.fromCharCode(b);
    else { if (cur.length >= minLen) out.push(cur.trim()); cur = ''; }
  }
  if (cur.length >= minLen) out.push(cur.trim());
  return out;
}
function extractUtf16(u8, minLen, cap) {
  const out = [];
  let cur = '';
  for (let i = 0; i + 1 < u8.length && out.length < cap; i += 2) {
    const c = u8[i] | (u8[i + 1] << 8);
    if ((c >= 32 && c < 0xd800) || c === 9 || c === 10 || c === 13) cur += String.fromCharCode(c);
    else { if (cur.length >= minLen) out.push(cur.trim()); cur = ''; }
  }
  if (cur.length >= minLen) out.push(cur.trim());
  return out;
}
const hexdump = (u8, n) => {
  const lines = [];
  for (let i = 0; i < Math.min(n, u8.length); i += 16) {
    const row = Array.from(u8.subarray(i, i + 16));
    lines.push(i.toString(16).padStart(8, '0') + '  ' + row.map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47) + '  ' + row.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join(''));
  }
  return lines.join('\n');
};
async function handleBinary(u8, name, det) {
  const r = newResult();
  const strs = extractStrings(u8.subarray(0, Math.min(u8.length, 8e6)), 8, 600);
  r.text = strs.join('\n');
  put(r, 'Binary', 'Size', U.fmtBytes(u8.length));
  put(r, 'Binary', 'First bytes', Array.from(u8.subarray(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join(' '));
  r.sections.push({ title: t('Hex dump (first 512 bytes)'), hex: hexdump(u8, 512) });
  r.warnings.push(det.key === 'binary' ? t('Unrecognized binary format. Showing printable strings and a hex preview.') : t('Only basic information is available for this format.'));
  fact(r, 'Printable strings', U.fmtNum(strs.length));
  r.noSummary = true;
  return r;
}

const HANDLERS = {
  pdf: handlePdf, docx: handleDocx, xlsx: handleXlsx, pptx: handlePptx, odt: handleOdf, ods: handleOdf, odp: handleOdf, odg: handleOdf,
  epub: handleEpub, zip: handleZip, gzip: handleGzip, tar: handleTar, rtf: handleRtf, eml: handleEml, html: handleHtml,
  xml: handleXml, svg: handleXml, json: handleJson, jsonl: handleJson, csv: handleCsv, markdown: handleText, code: handleText, text: handleText,
  avif: handleImage, png: handleImage, jpeg: handleImage, gif: handleImage, webp: handleImage, bmp: handleImage, tiff: handleImage, heic: handleImage, ico: handleImage,
  mp3: handleMedia, flac: handleMedia, ogg: handleMedia, wav: handleMedia, m4a: handleMedia, mp4: handleMedia, mov: handleMedia, webm: handleMedia, mkv: handleMedia,
};

const EXPECTED_EXT = {
  pdf: ['pdf', 'ai'], docx: ['docx', 'docm', 'dotx', 'dotm'], xlsx: ['xlsx', 'xlsm', 'xltx', 'xltm', 'xlam'], pptx: ['pptx', 'pptm', 'potx', 'ppsx'],
  png: ['png', 'apng'], jpeg: ['jpg', 'jpeg', 'jpe', 'jfif', 'jif'], gif: ['gif'], webp: ['webp'], bmp: ['bmp', 'dib'], tiff: ['tif', 'tiff'], rawphoto: ['cr2', 'nef', 'nrw', 'arw', 'sr2', 'srf', 'dng', 'orf', 'rw2', 'pef', 'srw', 'kdc', 'dcr', 'mos', '3fr', 'erf', 'iiq'],
  mp3: ['mp3', 'mp2'],  flac: ['flac'], wav: ['wav', 'wave'], exe: ['exe', 'dll', 'sys', 'scr', 'ocx', 'com', 'cpl', 'drv', 'efi', 'pyd', 'mui'],
  elf: ['so', 'o', 'elf', 'bin', 'out', 'ko', 'axf', 'prx'], ole: ['doc', 'dot', 'xls', 'xlt', 'ppt', 'pps', 'msg', 'vsd', 'msi', 'pub', 'mpp'], rar: ['rar', 'cbr'], '7z': ['7z', 'cb7'],
  html: ['html', 'htm', 'xhtml', 'shtml', 'php', 'asp', 'aspx', 'jsp', 'hbs', 'vue', 'cfm'], gzip: ['gz', 'gzip', 'tgz', 'svgz'], sqlite: ['sqlite', 'sqlite3', 'db', 'db3'],
};
// Extensions too generic to promise anything about the content
const NOT_CLAIMED = new Set(['html', 'elf', 'ole', 'sqlite']);
const PARSERS = { pdf: 'PDF (pdf.js)', docx: 'OOXML/Word', xlsx: 'OOXML/SpreadsheetML', pptx: 'OOXML/PresentationML', odt: 'OpenDocument', ods: 'OpenDocument', odp: 'OpenDocument', odg: 'OpenDocument', epub: 'EPUB', zip: 'ZIP', gzip: 'GZip', tar: 'TAR', rtf: 'RTF', eml: 'RFC 822 mail', html: 'HTML', xml: 'XML', svg: 'SVG', json: 'JSON', jsonl: 'JSON Lines', csv: 'Delimited text', markdown: 'Markdown', code: 'Source code', text: 'Plain text', binary: 'Strings + hex' };

E.register = (key, fn, kind, mime, parser) => {
  HANDLERS[key] = fn;
  if (kind) KIND[key] = kind;
  if (mime) MIME[key] = mime;
  if (parser) PARSERS[key] = parser;
};
E.addDetector = (fn) => detectors.push(fn);
E.supportedTypes = () => Object.keys(HANDLERS).map((key) => ({ key, kind: KIND[key] || key, mime: MIME[key] || '', parser: PARSERS[key] || '' }));

E.analyzeBytes = async function (u8, name, mime, progress) {
  const det = await detect(name, mime, u8);
  const fn = HANDLERS[det.key] || handleBinary;
  const r = await fn(u8, name, det, mime, progress);
  r.type = r.type || det.key;
  r.kind = r.kind || KIND[det.key] || det.key;
  r.mime = r.mime || MIME[det.key] || mime || 'application/octet-stream';
  r.parser = r.parser || PARSERS[det.key] || det.key.toUpperCase();

  // Files inside Office, OpenDocument and EPUB containers
  if (det.zip && !r.embedded) {
    const wanted = { docx: /^word\/(media|embeddings)\//, xlsx: /^xl\/(media|embeddings)\//, pptx: /^ppt\/(media|embeddings)\//, odt: /^(Pictures|Object)/, ods: /^(Pictures|Object)/, odp: /^(Pictures|Object)/, odg: /^(Pictures|Object)/, epub: /\.(jpe?g|png|gif|svg|webp)$/i }[det.key];
    if (wanted) r.embedded = det.zip.entries.filter((e) => !e.dir && !e.encrypted && wanted.test(e.name)).map((e) => ({ name: e.name, size: e.size, date: e.date, read: () => det.zip.read(e) }));
  }

  // XMP lives uncompressed in most formats, so a byte scan finds it regardless of container
  try {
    const xmp = parseXmp(r.xmpRaw || findXmpPacket(u8));
    delete r.xmpRaw;
    Object.entries(xmp).forEach(([k, v]) => put(r, 'XMP', k, v.slice(0, 2000)));
    if (!r.title && xmp['dc:title']) r.title = xmp['dc:title'];
    if (xmp['pdfaid:part']) put(r, 'Document', 'PDF/A conformance', `PDF/A-${xmp['pdfaid:part']}${(xmp['pdfaid:conformance'] || '').toLowerCase()}`);
    if (xmp['pdfuaid:part']) put(r, 'Document', 'PDF/UA', xmp['pdfuaid:part']);
  } catch (e) { /* XMP is a bonus */ }

  // Type by content against what the name and the browser claim
  const ext = U.extOf(name);
  const expected = EXPECTED_EXT[det.key];
  r.detection = { ext, browser: mime || '', byContent: r.mime };
  // The other direction too: a name that promises a format the content is not
  const claimed = Object.keys(EXPECTED_EXT).find((k) => !NOT_CLAIMED.has(k) && EXPECTED_EXT[k].includes(ext));
  const officeSealed = det.key === 'ole' && /^(docx|xlsx|pptx)$/.test(ext);
  if (ext && !officeSealed && ((expected && !expected.includes(ext)) || (!expected && claimed) || (claimed && claimed !== det.key))) {
    r.detection.mismatch = true;
    r.warnings.unshift(t('The name says .{ext}, but the content is actually {kind}.', { ext, kind: t(r.kind) }));
  }
  return r;
};
E.analyze = async (file, progress) => E.analyzeBytes(new Uint8Array(await file.arrayBuffer()), file.name, file.type, progress);
E.helpers = { newResult, put, fact, hexdump, countWords, extractStrings, archiveSummary, decodeWords, ooxmlCore };
E.handler = (key) => HANDLERS[key];
E.badge = (type, name) => {
  const ext = U.extOf(name);
  const short = { markdown: 'MD', jsonl: 'JSON', binary: ext || 'BIN', ole: ext || 'OLE', text: ext || 'TXT', code: ext || 'CODE', jpeg: 'JPG', tiff: 'TIF', ooxml: 'XML' };
  return (short[type] || type).toUpperCase().slice(0, 4);
};
