// photosort.js
// Sort photos into dated folders and give them dated names.

import { el, btn, icon, dialog, task, toast, fill } from './dom.js';
import { t, fmtNum, collator } from './i18n.js';
import { S, emit, renameMany, move, joinPath, cleanDir } from './store.js';
import { splitName } from './kinds.js';

const field = (label, control) => el('label.fm-field', el('span.fm-field__label', label), control);
const select = (options, value) => el('select.fm-input', options.map(([v, label]) => el('option', { value: v, selected: v === value }, label)));
const pathOf = item => joinPath(item.dir, item.name);

/** Capture time of a JPEG in ms (local time), from the first bytes of the file, or null. */
export function exifDate(bytes) {
  const n = bytes.length;
  if (n < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, n);
  let pos = 2;
  let tiff = -1;
  while (pos + 4 <= n) {
    if (bytes[pos] !== 0xff) { pos++; continue; }
    const marker = bytes[pos + 1];
    if (marker === 0xff) { pos++; continue; }
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
    const len = view.getUint16(pos + 2);
    if (marker === 0xe1 && bytes[pos + 4] === 0x45 && bytes[pos + 5] === 0x78 && bytes[pos + 6] === 0x69 && bytes[pos + 7] === 0x66) {
      tiff = pos + 10;
      break;
    }
    pos += 2 + len;
  }
  if (tiff < 0 || tiff + 8 > n) return null;
  const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  if (!little && !(bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d)) return null;
  const u16 = o => (o >= 0 && o + 2 <= n ? view.getUint16(o, little) : 0);
  const u32 = o => (o >= 0 && o + 4 <= n ? view.getUint32(o, little) : 0);
  if (u16(tiff + 2) !== 42) return null;

  // Looks up one ASCII tag, or a pointer, in the IFD at `offset`.
  const find = (offset, tag) => {
    const base = tiff + offset;
    const count = u16(base);
    for (let i = 0; i < count && i < 512; i++) {
      const entry = base + 2 + i * 12;
      if (u16(entry) !== tag) continue;
      return { type: u16(entry + 2), count: u32(entry + 4), at: entry + 8 };
    }
    return null;
  };
  const readDate = hit => {
    if (!hit || hit.type !== 2 || hit.count < 19) return null;
    const start = hit.count > 4 ? tiff + u32(hit.at) : hit.at;
    if (start < 0 || start + 19 > n) return null;
    let s = '';
    for (let i = 0; i < 19; i++) s += String.fromCharCode(bytes[start + i]);
    const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(s);
    if (!m || m[1] === '0000') return null;
    const ms = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    return Number.isFinite(ms) ? ms : null;
  };

  const ifd0 = u32(tiff + 4);
  let result = null;
  const pointer = find(ifd0, 0x8769);
  if (pointer) result = readDate(find(u32(pointer.at), 0x9003));
  return result ?? readDate(find(ifd0, 0x0132));
}

const pad = (v, w = 2) => String(v).padStart(w, '0');
const parts = ms => {
  const d = new Date(ms);
  return { y: pad(d.getFullYear(), 4), mo: pad(d.getMonth() + 1), d: pad(d.getDate()), h: pad(d.getHours()), mi: pad(d.getMinutes()), s: pad(d.getSeconds()) };
};

export async function photoSortDialog(items) {
  const dated = await task(t('Reading photo dates'), async (progress, signal) => {
    const out = [];
    for (let i = 0; i < items.length; i++) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const item = items[i];
      let ms = null;
      if (item.ext === 'jpg' || item.ext === 'jpeg') {
        try {
          ms = exifDate(new Uint8Array(await item.file.slice(0, 262144).arrayBuffer()));
        } catch { /* unreadable, fall back to the file date */ }
      }
      out.push({ item, ms: ms ?? item.modified, exif: ms !== null });
      progress((i + 1) / items.length);
    }
    return out;
  });
  if (!dated) return;
  dated.sort((a, b) => collator.compare(pathOf(a.item), pathOf(b.item)));

  const folders = select([
    ['none', t('None')],
    ['year', t('Year (2026)')],
    ['month', t('Year and month (2026/2026-11)')],
    ['day', t('Year, month and day (2026/2026-11/2026-11-14)')],
  ], 'month');
  const names = select([
    ['keep', t('Keep the names')],
    ['prefix', t('Date and time first (2026-11-14 18.30.05 name.jpg)')],
    ['only', t('Date and time only (2026-11-14 18.30.05.jpg)')],
  ], 'keep');
  const base = el('input.fm-input', { type: 'text', value: S.cwd, autocomplete: 'off', spellcheck: false });
  const list = el('ol.fm-photosort__list');
  const summary = el('p.fm-photosort__summary');

  function compute() {
    const root = cleanDir(base.value);
    return dated.map(({ item, ms, exif }) => {
      const p = parts(ms);
      const sub = { none: '', year: p.y, month: `${p.y}/${p.y}-${p.mo}`, day: `${p.y}/${p.y}-${p.mo}/${p.y}-${p.mo}-${p.d}` }[folders.value];
      const [, ext] = splitName(item.name);
      const stamp = `${p.y}-${p.mo}-${p.d} ${p.h}.${p.mi}.${p.s}`;
      const name = names.value === 'prefix' ? `${stamp} ${item.name}` : names.value === 'only' ? `${stamp}${ext}` : item.name;
      const dir = sub ? cleanDir(joinPath(root, sub)) : item.dir;
      return { item, exif, name, dir };
    });
  }

  function render() {
    const rows = compute();
    const changed = rows.filter(r => r.name !== r.item.name || r.dir !== r.item.dir);
    summary.textContent = t('Files that move or get a new name: {n} of {total}', { n: fmtNum(changed.length), total: fmtNum(rows.length) });
    fill(list, ...rows.slice(0, 200).map(r => el(`li${r.name === r.item.name && r.dir === r.item.dir ? '.is-same' : ''}`,
      el('span.fm-photosort__old', pathOf(r.item)), icon('chevron'), el('span.fm-photosort__new', joinPath(r.dir, r.name)),
      el(`span.fm-tag${r.exif ? '.fm-tag--new' : ''}`, r.exif ? t('EXIF') : t('File date')))));
    apply.disabled = !changed.length;
    return rows;
  }

  const apply = btn(t('Sort photos'), () => {
    const rows = render();
    const renames = rows.filter(r => r.name !== r.item.name).map(r => [r.item.id, r.name]);
    if (renames.length) renameMany(renames);
    const groups = new Map();
    for (const r of rows) {
      if (r.dir === r.item.dir) continue;
      if (!groups.has(r.dir)) groups.set(r.dir, []);
      groups.get(r.dir).push(r.item.id);
    }
    for (const [dir, ids] of groups) move(ids, dir);
    const count = rows.filter(r => r.name !== r.item.name || r.dir !== r.item.dir).length;
    S.selection = new Set();
    emit('items', 'selection', 'nav');
    d.close();
    toast(t('Photos sorted: {n}', { n: fmtNum(count) }), { kind: 'success' });
  }, { variant: 'primary' });

  const d = dialog({
    title: t('Sort photos by date'), size: 'l',
    body: el('div.fm-photosort',
      el('div.fm-form',
        el('div.fm-form__row', field(t('Sort into folders'), folders), field(t('Rename files'), names)),
        field(t('Inside folder'), base)),
      el('div.fm-photosort__preview', summary, list)),
    footer: [btn(t('Cancel'), () => d.close()), apply],
  });
  d.body.addEventListener('input', render);
  d.body.addEventListener('change', render);
  render();
}
