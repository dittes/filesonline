// strip.js
// Remove metadata from JPEG, PNG, WebP and PDF files without re-encoding the picture or pages.
// stripBytes is pure (no DOM) so it can be tested in node; the dialog imports the UI lazily.

const EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'pdf']);
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' };

export const canStrip = item => EXTS.has(item.ext);

const ascii = (b, at, len) => String.fromCharCode(...b.subarray(at, at + len));
const concat = chunks => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
};

export async function stripBytes(bytes, ext) {
  ext = String(ext).toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return stripJpeg(bytes);
  if (ext === 'png') return stripPng(bytes);
  if (ext === 'webp') return stripWebp(bytes);
  if (ext === 'pdf') {
    const ops = await import('../pdf/ops.js');
    const out = await ops.writeMetadata(bytes, {}, { clearAll: true });
    return { bytes: out, removed: ['Document properties'] };
  }
  throw new Error('Unsupported type');
}

// ─── JPEG ─────────────────────────────────────────────────────────────────────

/** Reads the Orientation tag (1-8) and whether a GPS block exists from a TIFF block. */
function readTiff(b, at, end) {
  const info = { orientation: 1, gps: false };
  if (end - at < 8) return info;
  const le = b[at] === 0x49;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = o => v.getUint16(o, le);
  const u32 = o => v.getUint32(o, le);
  const ifd = at + u32(at + 4);
  if (ifd + 2 > end) return info;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end) break;
    const tag = u16(e);
    if (tag === 0x0112) info.orientation = u16(e + 8) || 1;
    if (tag === 0x8825) info.gps = true;
  }
  return info;
}

/** A fresh APP1 segment holding only the Orientation tag. */
function orientationSegment(o) {
  const seg = new Uint8Array(36);
  const v = new DataView(seg.buffer);
  v.setUint16(0, 0xFFE1);
  v.setUint16(2, 34);
  seg.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4); // "Exif\0\0"
  seg.set([0x49, 0x49, 0x2A, 0], 10); // little-endian TIFF header
  v.setUint32(14, 8, true); // IFD0 offset
  v.setUint16(18, 1, true); // one entry
  v.setUint16(20, 0x0112, true);
  v.setUint16(22, 3, true); // SHORT
  v.setUint32(24, 1, true);
  v.setUint16(28, o, true);
  return seg;
}

function stripJpeg(b) {
  if (b[0] !== 0xFF || b[1] !== 0xD8) throw new Error('Not a JPEG');
  const out = [b.subarray(0, 2)];
  const removed = new Set();
  let orientation = 1;
  let insertAt = 1; // index in `out` where a new EXIF segment goes
  let pos = 2;
  let first = true;
  while (pos < b.length) {
    if (b[pos] !== 0xFF) throw new Error('Bad JPEG marker');
    let m = b[pos + 1];
    if (m === 0xFF) { pos++; continue; } // fill byte
    if (m === 0xDA) { out.push(b.subarray(pos)); pos = b.length; break; }
    if (m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { out.push(b.subarray(pos, pos + 2)); pos += 2; continue; }
    if (m === 0xD9) { out.push(b.subarray(pos)); pos = b.length; break; }
    if (pos + 4 > b.length) throw new Error('Truncated JPEG');
    const len = (b[pos + 2] << 8) | b[pos + 3];
    const end = pos + 2 + len;
    if (len < 2 || end > b.length) throw new Error('Truncated JPEG');
    const seg = b.subarray(pos, end);
    const head = ascii(b, pos + 4, 29);
    let keep = true;
    if (m === 0xFE) { keep = false; removed.add('Comment'); }
    else if (m === 0xE1) {
      keep = false;
      if (head.startsWith('Exif\0')) {
        removed.add('EXIF');
        const info = readTiff(b, pos + 10, end);
        orientation = info.orientation;
        if (info.gps) removed.add('GPS');
      } else if (head.startsWith('http://ns.adobe.com/xmp/extension/')) removed.add('XMP');
      else if (head.startsWith('http://ns.adobe.com/xap/1.0/')) removed.add('XMP');
      else removed.add('Other metadata');
    } else if (m === 0xED) { keep = false; removed.add('IPTC'); }
    else if (m === 0xE2) { if (!head.startsWith('ICC_PROFILE\0')) { keep = false; removed.add('Other metadata'); } }
    else if (m >= 0xE1 && m <= 0xEF && m !== 0xEE) { keep = false; removed.add('Other metadata'); }
    if (keep) out.push(seg);
    if (first && m === 0xE0) insertAt = out.length; // JFIF stays first
    first = false;
    pos = end;
  }
  if (orientation >= 2 && orientation <= 8) out.splice(insertAt, 0, orientationSegment(orientation));
  return { bytes: concat(out), removed: [...removed] };
}

// ─── PNG ──────────────────────────────────────────────────────────────────────

const PNG_DROP = { tEXt: 'Text', zTXt: 'Text', iTXt: 'Text', eXIf: 'EXIF', tIME: 'Modified time' };

function stripPng(b) {
  const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  if (b.length < 8 || sig.some((x, i) => b[i] !== x)) throw new Error('Not a PNG');
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = [b.subarray(0, 8)];
  const removed = new Set();
  let pos = 8;
  while (pos < b.length) {
    if (pos + 12 > b.length) throw new Error('Truncated PNG');
    const end = pos + 12 + v.getUint32(pos);
    if (end > b.length) throw new Error('Truncated PNG');
    const type = ascii(b, pos + 4, 4);
    if (PNG_DROP[type]) removed.add(PNG_DROP[type]);
    else out.push(b.subarray(pos, end));
    pos = end;
  }
  return { bytes: concat(out), removed: [...removed] };
}

// ─── WebP ─────────────────────────────────────────────────────────────────────

function stripWebp(b) {
  if (b.length < 12 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') throw new Error('Not a WebP');
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const limit = Math.min(b.length, 8 + v.getUint32(4, true));
  const out = [b.subarray(0, 12)];
  const removed = new Set();
  let pos = 12;
  while (pos + 8 <= limit) {
    const type = ascii(b, pos, 4);
    const size = v.getUint32(pos + 4, true);
    const end = pos + 8 + size + (size & 1);
    if (end > b.length + (size & 1)) throw new Error('Truncated WebP');
    const chunk = b.slice(pos, Math.min(end, b.length));
    if (type === 'EXIF') removed.add('EXIF');
    else if (type === 'XMP ') removed.add('XMP');
    else {
      if (type === 'VP8X' && size >= 1) chunk[8] &= ~0x0C;
      out.push(chunk);
    }
    pos = end;
  }
  const res = concat(out);
  new DataView(res.buffer).setUint32(4, res.length - 8, true);
  return { bytes: res, removed: [...removed] };
}

// ─── Dialog ───────────────────────────────────────────────────────────────────

export async function stripDialog(items, onDone) {
  const [{ el, btn, dialog, task, toast, UserError }, { t }, { splitName }] = await Promise.all([
    import('./dom.js'), import('./i18n.js'), import('./kinds.js'),
  ]);
  const files = items.filter(canStrip);
  if (!files.length) return;

  const mode = value => el('label.fm-opt',
    el('input', { type: 'radio', name: 'fm-strip-mode', value, checked: value === 'copy' }),
    el('span', value === 'copy' ? t('Add cleaned copies next to the originals') : t('Replace the files in the workspace')));
  const copyOpt = mode('copy');
  const replaceOpt = mode('replace');

  const d = dialog({
    title: t('Remove metadata'),
    size: 's',
    body: el('div.fm-form.fm-strip',
      el('p.fm-dialog__text', t('Files to clean: {n}', { n: files.length })),
      el('p.fm-dialog__text', t('Removed: camera, location, author, software, dates and comments.')),
      el('p.fm-dialog__text', t('Stays: the picture or pages themselves, with the quality unchanged.')),
      el('div.fm-strip__modes', copyOpt, replaceOpt)),
    footer: [btn(t('Cancel'), () => d.close(false)), btn(t('Remove metadata'), () => d.close(true), { variant: 'primary' })],
  });
  if (!await d.closed) return;
  const replace = replaceOpt.querySelector('input').checked;

  let failed = 0;
  const run = await task(t('Removing metadata'), async (progress, signal) => {
    const results = [];
    for (let i = 0; i < files.length; i++) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const item = files[i];
      progress(i / files.length, item.name);
      try {
        const { bytes } = await stripBytes(new Uint8Array(await item.file.arrayBuffer()), item.ext);
        const [stem, dotExt] = splitName(item.name);
        const name = replace ? item.name : `${stem}-clean${dotExt}`;
        results.push({ item, file: new File([bytes], name, { type: MIME[item.ext], lastModified: Date.now() }) });
      } catch {
        failed++;
      }
    }
    progress(1);
    if (!results.length) throw new UserError(t('These files could not be cleaned.'));
    return results;
  });
  if (failed && run) toast(t('Skipped files: {n}', { n: failed }), { kind: 'error' });
  if (run) onDone({ results: run, replace });
}
