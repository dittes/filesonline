// forensics.js
// What the bytes themselves say, independent of the format: entropy and hidden trailing data.
// Also lists what a file gives away about its author, for the privacy card.

import { t } from './i18n.js';

/** Bytes after a format's logical end, a common way to hide data in a file. */
export function trailingData(u8, type) {
  const n = u8.length;
  let end = -1;
  if (type === 'jpeg') {
    for (let i = n - 2; i > Math.max(0, n - 4 * 1024 * 1024); i--) if (u8[i] === 0xff && u8[i + 1] === 0xd9) { end = i + 2; break; }
  } else if (type === 'png') {
    for (let i = n - 8; i > Math.max(0, n - 4 * 1024 * 1024); i--) {
      if (u8[i] === 0x49 && u8[i + 1] === 0x45 && u8[i + 2] === 0x4e && u8[i + 3] === 0x44) { end = i + 8; break; }
    }
  } else if (type === 'pdf') {
    for (let i = n - 5; i > Math.max(0, n - 1024 * 1024); i--) {
      if (u8[i] === 0x25 && u8[i + 1] === 0x25 && u8[i + 2] === 0x45 && u8[i + 3] === 0x4f && u8[i + 4] === 0x46) { end = i + 5; break; }
    }
    // Line endings after %%EOF are normal
    while (end > 0 && end < n && (u8[end] === 10 || u8[end] === 13 || u8[end] === 32)) end++;
  } else if (type === 'gif') {
    if (u8[n - 1] === 0x3b) end = n;
  }
  return end > 0 && end < n ? n - end : 0;
}

/** Plain-language reading of entropy, in bits per byte. */
export function entropyLabel(e) {
  if (e < 1) return t('Very repetitive');
  if (e < 5) return t('Typical for text');
  if (e < 7) return t('Structured binary data');
  if (e < 7.9) return t('Compressed or media data');
  return t('Compressed or encrypted');
}

/** Details that travel with the file, each with why it matters and how to deal with it. */
export function findings(item) {
  const r = item.result;
  const m = r.meta;
  const list = [];
  const get = (g, k) => (m[g] || {})[k];
  const person = get('Document', 'Author') || get('Book', 'Author') || get('Camera & EXIF', 'Artist') || (m.XMP && m.XMP['dc:creator']);
  if (person) list.push({ label: t('Author name'), value: person });
  const last = get('Document', 'Last modified by');
  if (last && last !== person) list.push({ label: t('Last edited by'), value: last });
  const company = get('Application', 'Company');
  if (company) list.push({ label: t('Company'), value: company });
  if (r.gps) list.push({ label: t('GPS location'), value: `${r.gps[0].toFixed(5)}, ${r.gps[1].toFixed(5)}`, level: 'high' });
  const camera = get('All EXIF tags', 'Body serial');
  if (camera) list.push({ label: t('Camera serial number'), value: camera, level: 'high' });
  const software = get('Application', 'Creator') || get('Application', 'Application') || get('Camera & EXIF', 'Software');
  if (software) list.push({ label: t('Software used'), value: software });
  const ins = get('Structure', 'Tracked insertions'), del = get('Structure', 'Tracked deletions');
  if (ins || del) list.push({ label: t('Tracked changes'), value: `+${ins || 0} / -${del || 0}`, level: 'high' });
  const comments = get('Structure', 'Comments');
  if (comments) list.push({ label: t('Comments'), value: comments, level: 'high' });
  const hidden = get('Workbook', 'Hidden sheets');
  if (hidden) list.push({ label: t('Hidden sheets'), value: hidden, level: 'high' });
  if (get('Structure', 'Hidden text runs')) list.push({ label: t('Hidden text'), value: get('Structure', 'Hidden text runs'), level: 'high' });
  if (get('Security', 'Macros')) list.push({ label: t('Macros'), value: t('Yes'), level: 'high' });
  if (get('Security', 'JavaScript')) list.push({ label: t('JavaScript'), value: t('Yes'), level: 'high' });
  if (item.trailing) list.push({ label: t('Data after the end of the file'), value: `${item.trailing} B`, level: 'high' });
  if (r.detection && r.detection.mismatch) list.push({ label: t('Wrong file extension'), value: `.${r.detection.ext}`, level: 'high' });
  return list;
}

/** The right tool to clean this file, here or on Remove Online. */
export function cleanupLink(item, routes, lang) {
  const type = item.result.type;
  if (type === 'pdf' && routes.metadata) return { href: routes.metadata.url, label: routes.metadata.name };
  const remove = (path) => `https://remove-online.com/${lang}/tools/${path}/`;
  if (['jpeg', 'png', 'webp', 'tiff', 'heic'].includes(type)) return { href: remove('image-metadata-remover'), label: t('Remove photo metadata'), external: true };
  if (['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'ole'].includes(type)) return { href: remove('office-metadata-remover'), label: t('Remove Office metadata'), external: true };
  return null;
}
