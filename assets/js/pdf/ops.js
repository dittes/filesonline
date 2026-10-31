// ops.js
// PDF operations with no UI. Every function takes bytes and returns bytes, so
// the same code runs behind the tool pages and in /tests/pdf.html.
//
// Coordinates from the UI are fractions (0–1) of the page as the user sees it,
// top-left origin. frame() maps them to PDF space for any /Rotate value.

import { pdfLib, fflate, fontkit, fontBytes, openPdfjs, runQpdf, createOcrWorker } from './lib.js';

// ─── Parsing helpers ──────────────────────────────────────────────────────────

/** Parse "1-3, 5, 8-" into zero-based page indexes. Throws on invalid input. */
export function parseRanges(text, pageCount) {
  return parseRangeGroups(text, pageCount).flat();
}

/** Parse "1-3, 5" into one array of zero-based indexes per comma-separated group. */
export function parseRangeGroups(text, pageCount) {
  const groups = [];
  for (const raw of String(text).split(/[,;]/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = part.match(/^(\d*)\s*[-–]\s*(\d*)$/) || part.match(/^(\d+)$/);
    if (!m) throw new RangeError(part);
    const from = m[1] ? +m[1] : 1;
    const to = m[2] !== undefined ? (m[2] ? +m[2] : pageCount) : from;
    if (from < 1 || to > pageCount || from > to) throw new RangeError(part);
    const group = [];
    for (let i = from; i <= to; i++) group.push(i - 1);
    groups.push(group);
  }
  if (!groups.length) throw new RangeError('');
  return groups;
}

const stem = name => name.replace(/\.[^.]+$/, '');
export { stem as fileStem };

export async function loadDoc(bytes) {
  const { PDFDocument } = await pdfLib();
  return PDFDocument.load(bytes, { updateMetadata: false });
}

export async function pageCountOf(bytes) {
  return (await loadDoc(bytes)).getPageCount();
}

/** True when the file needs decrypting before pdf-lib can edit it. */
export async function isEncrypted(bytes) {
  const { PDFDocument } = await pdfLib();
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  return doc.isEncrypted;
}

/**
 * Remove every indirect object no longer reachable from the trailer.
 * pdf-lib writes all objects it knows about, so without this a "deleted" page
 * would still be present in the saved file.
 */
export async function collectGarbage(doc) {
  const { PDFRef, PDFDict, PDFArray, PDFStream } = await pdfLib();
  await doc.flush();
  const ctx = doc.context;
  const seen = new Set();
  const stack = [ctx.trailerInfo.Root, ctx.trailerInfo.Info, ctx.trailerInfo.Encrypt].filter(Boolean);
  while (stack.length) {
    let o = stack.pop();
    if (o instanceof PDFRef) {
      if (seen.has(o.tag)) continue;
      seen.add(o.tag);
      o = ctx.lookup(o);
    }
    if (o instanceof PDFStream) o = o.dict;
    if (o instanceof PDFDict) {
      for (const [, value] of o.entries()) stack.push(value);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) stack.push(o.get(i));
    }
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(ref.tag)) ctx.delete(ref);
  }
}

// ─── Page geometry ────────────────────────────────────────────────────────────

/** Map user-visible fractions on a page to PDF coordinates, whatever its rotation. */
export function frame(page) {
  const box = page.getCropBox();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const W = swap ? box.height : box.width;
  const H = swap ? box.width : box.height;
  const toPdf = (u, v) => {
    switch (rot) {
      case 90: return { x: box.x + v * box.width, y: box.y + u * box.height };
      case 180: return { x: box.x + (1 - u) * box.width, y: box.y + v * box.height };
      case 270: return { x: box.x + (1 - v) * box.width, y: box.y + (1 - u) * box.height };
      default: return { x: box.x + u * box.width, y: box.y + (1 - v) * box.height };
    }
  };
  return { W, H, rot, toPdf };
}

// ─── Fonts ────────────────────────────────────────────────────────────────────

const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';

function isWinAnsi(text) {
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c === 10 || c === 13) continue;
    if (c < 32 || (c > 126 && c < 160) || c > 255) {
      if (!WIN_ANSI_EXTRA.includes(ch)) return false;
    }
  }
  return true;
}

/** Helvetica when the text fits WinAnsi, otherwise embedded DejaVu Sans (ł, ř, š, Cyrillic…). */
export async function fontFor(doc, text, { bold = false } = {}) {
  const { StandardFonts } = await pdfLib();
  if (isWinAnsi(text)) {
    return doc.embedFont(bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
  }
  doc.registerFontkit(await fontkit());
  return doc.embedFont(await fontBytes(bold), { subset: true });
}

export function hexColor(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

// ─── Organize ─────────────────────────────────────────────────────────────────

/**
 * Build a new PDF from parts.
 * @param {{bytes:Uint8Array, pages?:number[], rotate?:Object<number,number>}[]} parts
 */
export async function assemble(parts, { onProgress } = {}) {
  const { PDFDocument, degrees } = await pdfLib();
  const out = await PDFDocument.create();
  for (let p = 0; p < parts.length; p++) {
    const part = parts[p];
    const src = part.doc || await loadDoc(part.bytes);
    const indexes = part.pages || src.getPageIndices();
    const copied = await out.copyPages(src, indexes);
    copied.forEach((page, i) => {
      const extra = part.rotate?.[indexes[i]] || 0;
      if (extra) page.setRotation(degrees((page.getRotation().angle + extra) % 360));
      out.addPage(page);
    });
    onProgress?.((p + 1) / parts.length);
    await yieldToUi();
  }
  return out.save();
}

/** Organize: sequence of {file, page, rotate} or {blank:true, width, height}. */
export async function organize(sources, sequence) {
  const { PDFDocument, degrees } = await pdfLib();
  const out = await PDFDocument.create();
  const docs = await Promise.all(sources.map(loadDoc));
  for (const entry of sequence) {
    if (entry.blank) {
      out.addPage([entry.width || 595.28, entry.height || 841.89]);
      continue;
    }
    const [page] = await out.copyPages(docs[entry.file], [entry.page]);
    if (entry.rotate) page.setRotation(degrees((page.getRotation().angle + entry.rotate) % 360));
    out.addPage(page);
  }
  return out.save();
}

export async function splitGroups(bytes, groups, baseName) {
  const src = await loadDoc(bytes);
  const results = [];
  for (let i = 0; i < groups.length; i++) {
    const pdf = await assemble([{ doc: src, pages: groups[i] }]);
    const first = groups[i][0] + 1;
    const last = groups[i][groups[i].length - 1] + 1;
    results.push({ name: `${baseName}-${first === last ? first : `${first}-${last}`}.pdf`, bytes: pdf });
    await yieldToUi();
  }
  return results;
}

export async function deletePages(bytes, indexes) {
  const doc = await loadDoc(bytes);
  [...indexes].sort((a, b) => b - a).forEach(i => doc.removePage(i));
  await collectGarbage(doc);
  return doc.save();
}

/** Rotate in place, keeping forms, bookmarks and links. */
export async function rotatePages(bytes, rotations) {
  const { degrees } = await pdfLib();
  const doc = await loadDoc(bytes);
  doc.getPages().forEach((page, i) => {
    const extra = rotations[i] || 0;
    if (extra) page.setRotation(degrees((page.getRotation().angle + extra) % 360));
  });
  return doc.save();
}

/** rects: { [pageIndex]: {x,y,w,h} } in visible-page fractions. */
export async function cropPages(bytes, rects) {
  const doc = await loadDoc(bytes);
  doc.getPages().forEach((page, i) => {
    const r = rects[i];
    if (!r) return;
    const f = frame(page);
    const a = f.toPdf(r.x, r.y);
    const b = f.toPdf(r.x + r.w, r.y + r.h);
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(a.x - b.x);
    const h = Math.abs(a.y - b.y);
    page.setCropBox(x, y, w, h);
    page.setTrimBox(x, y, w, h);
    page.setBleedBox(x, y, w, h);
    page.setArtBox(x, y, w, h);
  });
  return doc.save();
}

// ─── Compress ─────────────────────────────────────────────────────────────────

const COMPRESS_LEVELS = {
  low: null,                         // structure only, images untouched
  medium: { dpi: 150, quality: 0.72 },
  high: { dpi: 96, quality: 0.5 },
};

function undoPngPredictor(data, rowBytes, bpp) {
  const rows = Math.floor(data.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowBytes + 1)];
    const inOff = r * (rowBytes + 1) + 1;
    const outOff = r * rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const raw = data[inOff + i];
      const a = i >= bpp ? out[outOff + i - bpp] : 0;
      const b = r > 0 ? out[outOff + i - rowBytes] : 0;
      const c = r > 0 && i >= bpp ? out[outOff + i - rowBytes - bpp] : 0;
      let v = raw;
      if (type === 1) v = raw + a;
      else if (type === 2) v = raw + b;
      else if (type === 3) v = raw + ((a + b) >> 1);
      else if (type === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      out[outOff + i] = v & 255;
    }
  }
  return out;
}

function jpegHasFourComponents(bytes) {
  for (let i = 2; i < bytes.length - 9;) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker >= 0xc0 && marker <= 0xc2) return bytes[i + 9] === 4;
    i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
  }
  return false;
}

/** Describe a colour space as {comps} or {comps, palette}; null when unsupported. */
function describeColorSpace(cs, lib, ctx) {
  const { PDFName, PDFArray, PDFRawStream, PDFHexString, PDFString } = lib;
  const look = o => ctx.lookup(o);
  cs = look(cs);
  if (cs instanceof PDFName) {
    const n = cs.decodeText();
    if (n === 'DeviceGray' || n === 'CalGray') return { comps: 1 };
    if (n === 'DeviceRGB' || n === 'CalRGB') return { comps: 3 };
    return null;
  }
  if (!(cs instanceof PDFArray)) return null;
  const family = look(cs.get(0))?.decodeText?.();
  if (family === 'CalGray') return { comps: 1 };
  if (family === 'CalRGB') return { comps: 3 };
  if (family === 'ICCBased') {
    const n = look(cs.get(1))?.dict?.get(PDFName.of('N'));
    const comps = n?.asNumber?.();
    return comps === 1 || comps === 3 ? { comps } : null;
  }
  if (family === 'Indexed') {
    const base = describeColorSpace(cs.get(1), lib, ctx);
    if (!base || base.palette) return null;
    const lookup = look(cs.get(3));
    let palette = null;
    if (lookup instanceof PDFRawStream) palette = lookup.getContents();
    else if (lookup instanceof PDFHexString || lookup instanceof PDFString) palette = lookup.asBytes();
    return palette ? { comps: 1, palette, baseComps: base.comps } : null;
  }
  return null;
}

async function decodeImageStream(stream, lib, ctx, zlib) {
  const { PDFName, PDFArray, PDFNumber, PDFBool, PDFDict } = lib;
  const dict = stream.dict;
  const get = key => ctx.lookup(dict.get(PDFName.of(key)));

  if (get('ImageMask') === PDFBool.True || get('Mask') instanceof PDFArray || get('Decode')) return null;
  let filter = get('Filter');
  if (filter instanceof PDFArray) {
    if (filter.size() !== 1) return null;
    filter = ctx.lookup(filter.get(0));
  }
  const name = filter?.decodeText?.();
  const raw = stream.getContents();

  if (name === 'DCTDecode') {
    if (jpegHasFourComponents(raw)) return null;
    const cs = get('ColorSpace') && describeColorSpace(get('ColorSpace'), lib, ctx);
    if (get('ColorSpace') && !cs) return null;
    return createImageBitmap(new Blob([raw], { type: 'image/jpeg' }));
  }
  if (name !== 'FlateDecode') return null;

  const width = get('Width')?.asNumber?.();
  const height = get('Height')?.asNumber?.();
  if (!width || !height || get('BitsPerComponent')?.asNumber?.() !== 8) return null;
  const cs = describeColorSpace(get('ColorSpace'), lib, ctx);
  if (!cs) return null;

  let data = zlib.unzlibSync(raw);
  let parms = get('DecodeParms');
  if (parms instanceof PDFArray) parms = ctx.lookup(parms.get(0));
  if (parms instanceof PDFDict) {
    const predictor = ctx.lookup(parms.get(PDFName.of('Predictor')));
    if (predictor instanceof PDFNumber && predictor.asNumber() >= 10) {
      data = undoPngPredictor(data, width * cs.comps, cs.comps);
    } else if (predictor instanceof PDFNumber && predictor.asNumber() > 1) {
      return null;
    }
  }
  if (data.length < width * height * cs.comps) return null;

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    if (cs.palette) {
      const idx = data[i] * cs.baseComps;
      rgba[p] = cs.palette[idx];
      rgba[p + 1] = cs.baseComps === 3 ? cs.palette[idx + 1] : cs.palette[idx];
      rgba[p + 2] = cs.baseComps === 3 ? cs.palette[idx + 2] : cs.palette[idx];
    } else if (cs.comps === 1) {
      rgba[p] = rgba[p + 1] = rgba[p + 2] = data[i];
    } else {
      rgba[p] = data[i * 3]; rgba[p + 1] = data[i * 3 + 1]; rgba[p + 2] = data[i * 3 + 2];
    }
    rgba[p + 3] = 255;
  }
  return new ImageData(rgba, width, height);
}

async function imageToJpeg(source, targetLong, quality) {
  const w = source.width, h = source.height;
  const scale = Math.min(1, targetLong / Math.max(w, h));
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));
  const canvas = new OffscreenCanvas(outW, outH);
  const c = canvas.getContext('2d');
  if (source instanceof ImageData) {
    const tmp = new OffscreenCanvas(w, h);
    tmp.getContext('2d').putImageData(source, 0, 0);
    source = tmp;
  }
  c.imageSmoothingQuality = 'high';
  c.drawImage(source, 0, 0, outW, outH);
  source.close?.();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: outW, height: outH };
}

/**
 * Shrink a PDF while keeping text selectable. Images are re-encoded in place;
 * everything else is rewritten into object streams with orphans dropped.
 */
export async function compress(bytes, { level = 'medium', onProgress } = {}) {
  const lib = await pdfLib();
  const zlib = await fflate();
  const { PDFName, PDFRawStream, PDFDict, PDFRef, PDFNumber } = lib;
  const doc = await loadDoc(bytes);
  const ctx = doc.context;
  const opts = COMPRESS_LEVELS[level];

  const longEdgePt = Math.max(...doc.getPages().map(p => Math.max(p.getWidth(), p.getHeight())));

  // Soft masks must stay greyscale, so they are never re-encoded as JPEG.
  const maskRefs = new Set();
  const objects = ctx.enumerateIndirectObjects();
  for (const [, obj] of objects) {
    if (!(obj instanceof PDFRawStream)) continue;
    for (const key of ['SMask', 'Mask']) {
      const v = obj.dict.get(PDFName.of(key));
      if (v instanceof PDFRef) maskRefs.add(v.tag);
    }
  }

  let done = 0;
  for (const [ref, obj] of objects) {
    done++;
    if (done % 20 === 0) { onProgress?.(done / objects.length); await yieldToUi(); }
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    const subtype = ctx.lookup(dict.get(PDFName.of('Subtype')));
    const isImage = subtype instanceof PDFName && subtype.decodeText() === 'Image';

    if (!isImage) {
      // Deflate streams the producer left uncompressed (content, fonts, XMP excluded)
      const type = ctx.lookup(dict.get(PDFName.of('Type')));
      if (!dict.get(PDFName.of('Filter')) && obj.getContents().length > 256
        && !(type instanceof PDFName && type.decodeText() === 'Metadata')) {
        const packed = zlib.zlibSync(obj.getContents(), { level: 9 });
        if (packed.length < obj.getContents().length) {
          dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
          ctx.assign(ref, PDFRawStream.of(dict, packed));
        }
      }
      continue;
    }
    if (!opts || maskRefs.has(ref.tag)) continue;

    let source;
    try {
      source = await decodeImageStream(obj, lib, ctx, zlib);
    } catch { continue; }
    if (!source) continue;

    const targetLong = (longEdgePt / 72) * opts.dpi;
    const jpeg = await imageToJpeg(source, targetLong, opts.quality);
    if (jpeg.bytes.length >= obj.getContents().length * 0.9) continue;

    const next = dict.clone(ctx);
    next.set(PDFName.of('Width'), PDFNumber.of(jpeg.width));
    next.set(PDFName.of('Height'), PDFNumber.of(jpeg.height));
    next.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
    next.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
    next.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
    next.delete(PDFName.of('DecodeParms'));
    ctx.assign(ref, PDFRawStream.of(next, jpeg.bytes));
  }

  await collectGarbage(doc);
  const out = await doc.save({ useObjectStreams: true });
  onProgress?.(1);
  return out.length < bytes.length ? out : bytes;
}

// ─── Stamping: watermark, page numbers ────────────────────────────────────────

export async function watermark(bytes, opt) {
  const { degrees, rgb } = await pdfLib();
  const doc = await loadDoc(bytes);
  const pages = doc.getPages();
  const targets = opt.pages || pages.map((_, i) => i);
  const image = opt.imageBytes
    ? (opt.imageType === 'image/png' ? await doc.embedPng(opt.imageBytes) : await doc.embedJpg(opt.imageBytes))
    : null;
  const font = image ? null : await fontFor(doc, opt.text, { bold: opt.bold });
  const color = hexColor(opt.color || '#000000');

  for (const i of targets) {
    const page = pages[i];
    const f = frame(page);
    const size = opt.size || 48;
    const itemW = image ? f.W * (opt.imageScale || 0.4) : font.widthOfTextAtSize(opt.text, size);
    const itemH = image ? itemW * (image.height / image.width) : font.heightAtSize(size, { descender: false });
    const angle = opt.angle || 0;
    const rad = angle * Math.PI / 180;

    const stamp = (cu, cv) => {
      // Centre of the item in visible-page points; rotation is about its lower-left corner
      const cx = cu * f.W, cy = (1 - cv) * f.H;
      const ox = cx - (itemW / 2) * Math.cos(rad) + (itemH / 2) * Math.sin(rad);
      const oy = cy - (itemW / 2) * Math.sin(rad) - (itemH / 2) * Math.cos(rad);
      const p = f.toPdf(ox / f.W, 1 - oy / f.H);
      const rotate = degrees(f.rot + angle);
      if (image) {
        page.drawImage(image, { x: p.x, y: p.y, width: itemW, height: itemH, rotate, opacity: opt.opacity });
      } else {
        page.drawText(opt.text, {
          x: p.x, y: p.y, size, font, rotate, opacity: opt.opacity,
          color: rgb(color.r, color.g, color.b),
        });
      }
    };

    if (opt.layout === 'tile') {
      const stepU = Math.max(0.2, (itemW * 1.4) / f.W);
      const stepV = Math.max(0.12, (itemH * 4) / f.H);
      for (let v = stepV / 2; v < 1; v += stepV) {
        for (let u = stepU / 2; u < 1; u += stepU) stamp(u, v);
      }
    } else {
      const [cu, cv] = POSITIONS[opt.position || 'center'];
      stamp(cu, cv);
    }
  }
  return doc.save();
}

const POSITIONS = {
  'top-left': [0.2, 0.1], 'top-center': [0.5, 0.1], 'top-right': [0.8, 0.1],
  'center': [0.5, 0.5],
  'bottom-left': [0.2, 0.9], 'bottom-center': [0.5, 0.9], 'bottom-right': [0.8, 0.9],
};

export async function pageNumbers(bytes, opt) {
  const { rgb, degrees } = await pdfLib();
  const doc = await loadDoc(bytes);
  const pages = doc.getPages();
  const first = (opt.from || 1) - 1;
  const last = opt.to ? opt.to - 1 : pages.length - 1;
  const total = opt.startAt - 1 + (last - first + 1);
  const label = n => (opt.format || '{n}').replaceAll('{n}', n).replaceAll('{total}', total);
  const font = await fontFor(doc, label(total));
  const color = hexColor(opt.color || '#000000');
  const size = opt.size || 11;
  const margin = opt.margin ?? 28;

  for (let i = first; i <= last; i++) {
    const page = pages[i];
    const f = frame(page);
    const text = label(opt.startAt + (i - first));
    const w = font.widthOfTextAtSize(text, size);
    const [hAlign, vAlign] = (opt.position || 'bottom-center').split('-').reverse();
    const x = hAlign === 'left' ? margin : hAlign === 'right' ? f.W - margin - w : (f.W - w) / 2;
    const y = vAlign === 'top' ? f.H - margin - size : margin;
    const p = f.toPdf(x / f.W, 1 - y / f.H);
    page.drawText(text, {
      x: p.x, y: p.y, size, font,
      color: rgb(color.r, color.g, color.b),
      rotate: degrees(f.rot),
    });
  }
  return doc.save();
}

// ─── Overlay editor: text, shapes, drawings, images, signatures ───────────────

/**
 * items: {page, type, x, y, w, h, ...} in visible-page fractions.
 * Types: text{text,size,color,bold} rect{color} whiteout highlight{color}
 *        draw{points,color,width} image{bytes,mime}
 */
export async function applyEdits(bytes, items) {
  const { rgb, degrees, BlendMode, LineCapStyle } = await pdfLib();
  const doc = await loadDoc(bytes);
  const pages = doc.getPages();
  const embedded = new Map();

  for (const item of items) {
    const page = pages[item.page];
    const f = frame(page);
    const bottomLeft = f.toPdf(item.x, item.y + item.h);
    const rotate = degrees(f.rot);
    const w = item.w * f.W;
    const h = item.h * f.H;
    const c = hexColor(item.color || '#000000');
    const color = rgb(c.r, c.g, c.b);

    switch (item.type) {
      case 'text': {
        const font = await fontFor(doc, item.text, { bold: item.bold });
        const lineHeight = item.size * 1.2;
        item.text.split('\n').forEach((line, n) => {
          if (!line) return;
          const v = item.y + (n * lineHeight + item.size * 0.95) / f.H;
          const p = f.toPdf(item.x, v);
          page.drawText(line, { x: p.x, y: p.y, size: item.size, font, color, rotate });
        });
        break;
      }
      case 'whiteout':
        page.drawRectangle({ ...bottomLeft, width: w, height: h, color: rgb(1, 1, 1), rotate });
        break;
      case 'rect':
        page.drawRectangle({ ...bottomLeft, width: w, height: h, borderColor: color, borderWidth: item.width || 1.5, rotate });
        break;
      case 'highlight':
        page.drawRectangle({ ...bottomLeft, width: w, height: h, color, opacity: 0.45, blendMode: BlendMode.Multiply, rotate });
        break;
      case 'draw':
        for (let i = 1; i < item.points.length; i++) {
          const a = f.toPdf(item.points[i - 1][0], item.points[i - 1][1]);
          const b = f.toPdf(item.points[i][0], item.points[i][1]);
          page.drawLine({ start: a, end: b, thickness: item.width || 2, color, lineCap: LineCapStyle.Round });
        }
        break;
      case 'image': {
        let img = embedded.get(item.bytes);
        if (!img) {
          img = item.mime === 'image/png' ? await doc.embedPng(item.bytes) : await doc.embedJpg(item.bytes);
          embedded.set(item.bytes, img);
        }
        page.drawImage(img, { ...bottomLeft, width: w, height: h, rotate });
        break;
      }
    }
  }
  return doc.save();
}

// ─── Forms, metadata, flatten ─────────────────────────────────────────────────

export async function readFormFields(bytes) {
  const lib = await pdfLib();
  const doc = await loadDoc(bytes);
  const fields = [];
  for (const field of doc.getForm().getFields()) {
    const name = field.getName();
    if (field instanceof lib.PDFTextField) fields.push({ name, kind: 'text', value: field.getText() || '', multiline: field.isMultiline() });
    else if (field instanceof lib.PDFCheckBox) fields.push({ name, kind: 'check', value: field.isChecked() });
    else if (field instanceof lib.PDFRadioGroup) fields.push({ name, kind: 'radio', value: field.getSelected() || '', options: field.getOptions() });
    else if (field instanceof lib.PDFDropdown) fields.push({ name, kind: 'select', value: field.getSelected()[0] || '', options: field.getOptions() });
    else if (field instanceof lib.PDFOptionList) fields.push({ name, kind: 'select', value: field.getSelected()[0] || '', options: field.getOptions() });
  }
  return fields;
}

export async function fillForm(bytes, values, { flatten = false } = {}) {
  const lib = await pdfLib();
  const doc = await loadDoc(bytes);
  const form = doc.getForm();
  const allText = Object.values(values).filter(v => typeof v === 'string').join('');
  const font = await fontFor(doc, allText);
  for (const field of form.getFields()) {
    const value = values[field.getName()];
    if (value === undefined) continue;
    if (field instanceof lib.PDFTextField) field.setText(value || undefined);
    else if (field instanceof lib.PDFCheckBox) value ? field.check() : field.uncheck();
    else if (field instanceof lib.PDFRadioGroup) { if (value) field.select(value); }
    else if (field instanceof lib.PDFDropdown || field instanceof lib.PDFOptionList) { if (value) field.select(value); }
  }
  form.updateFieldAppearances(font);
  if (flatten) form.flatten();
  return doc.save();
}

export async function readMetadata(bytes) {
  const doc = await loadDoc(bytes);
  return {
    title: doc.getTitle() || '',
    author: doc.getAuthor() || '',
    subject: doc.getSubject() || '',
    keywords: doc.getKeywords() || '',
    creator: doc.getCreator() || '',
    producer: doc.getProducer() || '',
    created: doc.getCreationDate() || null,
    modified: doc.getModificationDate() || null,
  };
}

export async function writeMetadata(bytes, meta, { clearAll = false } = {}) {
  const { PDFName } = await pdfLib();
  const doc = await loadDoc(bytes);
  if (clearAll) {
    doc.context.trailerInfo.Info = undefined;
    doc.catalog.delete(PDFName.of('Metadata'));
    await collectGarbage(doc);
    return doc.save({ updateFieldAppearances: false });
  }
  doc.setTitle(meta.title || '');
  doc.setAuthor(meta.author || '');
  doc.setSubject(meta.subject || '');
  doc.setKeywords((meta.keywords || '').split(',').map(s => s.trim()).filter(Boolean));
  doc.setCreator(meta.creator || '');
  doc.setProducer(meta.producer || '');
  doc.setModificationDate(new Date());
  // XMP would otherwise keep contradicting the values just written
  doc.catalog.delete(PDFName.of('Metadata'));
  await collectGarbage(doc);
  return doc.save();
}

export async function flatten(bytes, { removeAnnotations = true } = {}) {
  const { PDFName } = await pdfLib();
  const doc = await loadDoc(bytes);
  const form = doc.getForm();
  if (form.getFields().length) {
    form.updateFieldAppearances();
    form.flatten();
  }
  if (removeAnnotations) {
    doc.getPages().forEach(page => page.node.delete(PDFName.of('Annots')));
  }
  doc.catalog.delete(PDFName.of('AcroForm'));
  await collectGarbage(doc);
  return doc.save();
}

// ─── Redact ───────────────────────────────────────────────────────────────────

/**
 * Permanent redaction. Pages carrying a box are replaced by an image of the
 * page with the box burned in. The page object is reused so links pointing at
 * it stay valid, and everything that could still hold the removed text
 * (structure tree, bookmarks, metadata, form, attachments) is removed.
 * @param {Object<number,{x,y,w,h}[]>} boxes
 */
export async function redact(bytes, boxes, { dpi = 200, onProgress } = {}) {
  const { PDFName, degrees } = await pdfLib();
  const doc = await loadDoc(bytes);
  const pdf = await openPdfjs(bytes);
  const pages = doc.getPages();
  const targets = Object.keys(boxes).map(Number).filter(i => boxes[i]?.length);

  try { doc.getForm().flatten(); } catch { /* no usable form */ }

  for (let n = 0; n < targets.length; n++) {
    const i = targets[n];
    const page = pages[i];
    const pjsPage = await pdf.getPage(i + 1);
    const viewport = pjsPage.getViewport({ scale: dpi / 72 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const c = canvas.getContext('2d');
    await renderOffscreen(pjsPage, c, viewport);
    c.fillStyle = '#000';
    for (const b of boxes[i]) {
      c.fillRect(b.x * canvas.width, b.y * canvas.height, b.w * canvas.width, b.h * canvas.height);
    }
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.9));
    const img = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    canvas.width = canvas.height = 0;

    const f = frame(page);
    const node = page.node;
    for (const key of ['Contents', 'Annots', 'Resources', 'Thumb', 'PieceInfo', 'StructParents', 'Metadata', 'Group']) {
      node.delete(PDFName.of(key));
    }
    node.set(PDFName.of('Resources'), doc.context.obj({}));
    page.setRotation(degrees(0));
    page.setMediaBox(0, 0, f.W, f.H);
    page.setCropBox(0, 0, f.W, f.H);
    page.setTrimBox(0, 0, f.W, f.H);
    page.setBleedBox(0, 0, f.W, f.H);
    page.setArtBox(0, 0, f.W, f.H);
    page.contentStream = undefined;
    page.contentStreamRef = undefined;
    page.drawImage(img, { x: 0, y: 0, width: f.W, height: f.H });
    onProgress?.((n + 1) / targets.length);
    await yieldToUi();
  }
  await pdf.destroy();

  for (const key of ['Metadata', 'Outlines', 'AcroForm', 'StructTreeRoot', 'Names', 'Dests', 'MarkInfo', 'OpenAction']) {
    doc.catalog.delete(PDFName.of(key));
  }
  doc.context.trailerInfo.Info = undefined;
  await collectGarbage(doc);
  return doc.save({ useObjectStreams: true, updateFieldAppearances: false });
}

// ─── Security (qpdf) ──────────────────────────────────────────────────────────

export function protect(bytes, { userPassword, ownerPassword, allowPrint = true, allowCopy = true, allowModify = true }) {
  return runQpdf(bytes, (input, output) => [
    '--encrypt', userPassword, ownerPassword || userPassword, '256',
    `--print=${allowPrint ? 'full' : 'none'}`,
    `--modify=${allowModify ? 'all' : 'none'}`,
    `--extract=${allowCopy ? 'y' : 'n'}`,
    '--', input, output,
  ]);
}

export function unlock(bytes, password = '') {
  return runQpdf(bytes, (input, output) => [`--password=${password}`, '--decrypt', input, output]);
}

// ─── Render pages to images ───────────────────────────────────────────────────

export async function renderPages(bytes, { pages, dpi = 150, mime = 'image/jpeg', quality = 0.9, onPage } = {}) {
  const pdf = await openPdfjs(bytes);
  const indexes = pages || Array.from({ length: pdf.numPages }, (_, i) => i);
  const out = [];
  for (let n = 0; n < indexes.length; n++) {
    const page = await pdf.getPage(indexes[n] + 1);
    const viewport = page.getViewport({ scale: dpi / 72 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await renderOffscreen(page, canvas.getContext('2d'), viewport);
    const blob = await new Promise(res => canvas.toBlob(res, mime, quality));
    out.push({
      index: indexes[n],
      bytes: new Uint8Array(await blob.arrayBuffer()),
      width: canvas.width,
      height: canvas.height,
      widthPt: viewport.width * 72 / dpi,
      heightPt: viewport.height * 72 / dpi,
    });
    canvas.width = canvas.height = 0;
    page.cleanup();
    onPage?.((n + 1) / indexes.length);
    await yieldToUi();
  }
  await pdf.destroy();
  return out;
}

// ─── Images to PDF ────────────────────────────────────────────────────────────

const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };

function jpegOrientation(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  let i = 2;
  while (i < bytes.length - 10) {
    if (bytes[i] !== 0xff) return 1;
    const marker = bytes[i + 1];
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker === 0xe1 && String.fromCharCode(...bytes.subarray(i + 4, i + 8)) === 'Exif') {
      const t = i + 10;
      const le = bytes[t] === 0x49;
      const u16 = o => le ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1];
      const u32 = o => le
        ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0
        : ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
      const ifd = t + u32(t + 4);
      const count = u16(ifd);
      for (let e = 0; e < count; e++) {
        const entry = ifd + 2 + e * 12;
        if (u16(entry) === 0x0112) return u16(entry + 8);
      }
      return 1;
    }
    i += 2 + len;
  }
  return 1;
}

/** Convert anything the browser can decode to bytes pdf-lib can embed. */
export async function normalizeImage(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  if (isPng) return { bytes, mime: 'image/png' };
  if (isJpeg && jpegOrientation(bytes) === 1) return { bytes, mime: 'image/jpeg' };

  const bitmap = await createImageBitmap(new Blob([bytes], { type: file.type || undefined }), { imageOrientation: 'from-image' });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  const mime = isJpeg ? 'image/jpeg' : 'image/png';
  const blob = await canvas.convertToBlob({ type: mime, quality: 0.92 });
  bitmap.close();
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime };
}

/**
 * @param {{bytes, mime}[]} images
 * @param {{size:'fit'|'a4'|'letter', orientation:'auto'|'portrait'|'landscape', margin:number}} opt
 */
export async function imagesToPdf(images, opt = {}, onProgress) {
  const { PDFDocument } = await pdfLib();
  const doc = await PDFDocument.create();
  const margin = opt.margin || 0;
  for (let i = 0; i < images.length; i++) {
    const { bytes, mime } = images[i];
    const img = mime === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    let pw, ph;
    if (opt.size && PAGE_SIZES[opt.size]) {
      [pw, ph] = PAGE_SIZES[opt.size];
      const landscape = opt.orientation === 'landscape'
        || ((!opt.orientation || opt.orientation === 'auto') && img.width > img.height);
      if (landscape) [pw, ph] = [ph, pw];
    } else {
      // Fit: treat image pixels as 96 dpi, cap so very large photos stay within PDF limits
      const scale = Math.min(0.75, 14400 / Math.max(img.width, img.height));
      pw = img.width * scale + margin * 2;
      ph = img.height * scale + margin * 2;
    }
    const page = doc.addPage([pw, ph]);
    const s = Math.min((pw - margin * 2) / img.width, (ph - margin * 2) / img.height);
    const w = img.width * s, h = img.height * s;
    page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
    onProgress?.((i + 1) / images.length);
    await yieldToUi();
  }
  return doc.save();
}

// ─── Text extraction: shared layout analysis ──────────────────────────────────

/** Group a page's text items into lines, each with runs, position and font data. */
async function pageLines(page) {
  const content = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1 });
  await page.getOperatorList(); // populates commonObjs with font names
  const fontInfo = id => {
    try {
      const f = page.commonObjs.get(id);
      const name = `${f?.name || ''} ${f?.loadedName || ''}`;
      return { bold: !!f?.bold || /bold|black|heavy/i.test(name), italic: !!f?.italic || /italic|oblique/i.test(name) };
    } catch { return { bold: false, italic: false }; }
  };

  const items = content.items
    .filter(it => it.str !== undefined && it.str.length)
    .map(it => {
      const [x, y] = viewport.convertToViewportPoint(it.transform[4], it.transform[5]);
      const size = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
      return { str: it.str, x, y, w: it.width, size, ...fontInfo(it.fontName) };
    })
    // pdf.js bridges column gaps with wide whitespace items; spacing is rebuilt from positions
    .filter(it => it.str.trim());

  items.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of items) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - it.y) < Math.max(line.size, it.size) * 0.5) {
      line.items.push(it);
      line.size = Math.max(line.size, it.size);
    } else {
      lines.push({ y: it.y, size: it.size, items: [it] });
    }
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    line.x = line.items[0].x;
    const last = line.items[line.items.length - 1];
    line.right = last.x + last.w;
    line.runs = [];
    let prev = null;
    for (const it of line.items) {
      const gap = prev ? it.x - (prev.x + prev.w) : 0;
      const needsSpace = prev && gap > it.size * 0.18 && !/\s$/.test(prev.str) && !/^\s/.test(it.str);
      const run = line.runs[line.runs.length - 1];
      if (run && run.bold === it.bold && run.italic === it.italic && run.size === it.size) {
        run.text += (needsSpace ? ' ' : '') + it.str;
      } else {
        line.runs.push({ text: (needsSpace ? ' ' : '') + it.str, bold: it.bold, italic: it.italic, size: it.size });
      }
      prev = it;
    }
    line.text = line.runs.map(r => r.text).join('');
  }
  return { lines: lines.filter(l => l.text.trim()), width: viewport.width, height: viewport.height, items };
}

function median(values) {
  if (!values.length) return 11;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Merge lines into paragraphs using spacing, indentation and line length. */
function toParagraphs(lines, pageWidth) {
  const body = median(lines.map(l => l.size));
  const paragraphs = [];
  let cur = null;
  lines.forEach((line, i) => {
    const prev = lines[i - 1];
    const gap = prev ? line.y - prev.y : 0;
    const prevShort = prev && prev.right < pageWidth * 0.62 && /[.!?:;]\s*$/.test(prev.text);
    const indent = prev && line.x - prev.x > body * 0.8;
    const sizeChange = prev && Math.abs(line.size - prev.size) > 0.6;
    const startNew = !cur || gap > line.size * 1.55 || sizeChange || prevShort || indent;
    if (startNew) {
      cur = { runs: [], size: line.size, heading: 0 };
      if (line.size >= body * 1.7) cur.heading = 1;
      else if (line.size >= body * 1.35) cur.heading = 2;
      else if (line.size >= body * 1.15 && line.runs.every(r => r.bold)) cur.heading = 3;
      paragraphs.push(cur);
    } else {
      const last = cur.runs[cur.runs.length - 1];
      if (last.text.endsWith('-') && /^\p{Ll}/u.test(line.text)) last.text = last.text.slice(0, -1);
      else last.text += ' ';
    }
    line.runs.forEach(run => {
      const last = cur.runs[cur.runs.length - 1];
      if (last && last.bold === run.bold && last.italic === run.italic) last.text += run.text;
      else cur.runs.push({ ...run });
    });
  });
  return paragraphs;
}

export async function pdfToText(bytes, onProgress) {
  const pdf = await openPdfjs(bytes);
  const parts = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const { lines, width } = await pageLines(page);
    parts.push(toParagraphs(lines, width).map(p => p.runs.map(r => r.text).join('')).join('\n\n'));
    onProgress?.(n / pdf.numPages);
    await yieldToUi();
  }
  await pdf.destroy();
  return parts.join('\n\n\f\n\n').replace(/\f\n\n/g, '').trim() + '\n';
}

/** Share of pages with hardly any extractable text; used to suggest OCR. */
export async function looksScanned(bytes) {
  const pdf = await openPdfjs(bytes);
  const sample = Math.min(pdf.numPages, 3);
  let chars = 0;
  for (let n = 1; n <= sample; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    chars += content.items.reduce((sum, it) => sum + (it.str?.trim().length || 0), 0);
  }
  await pdf.destroy();
  return chars / sample < 20;
}

// ─── DOCX ─────────────────────────────────────────────────────────────────────

const xmlEscape = s => s.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]))
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

const DOCX_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

function docxParagraph(p, pageBreak) {
  const style = p.heading ? `<w:pStyle w:val="Heading${p.heading}"/>` : '';
  const brk = pageBreak ? '<w:pageBreakBefore/>' : '';
  const runs = p.runs.map(r => {
    const props = [
      r.bold && !p.heading ? '<w:b/>' : '',
      r.italic ? '<w:i/>' : '',
      p.heading ? '' : `<w:sz w:val="${Math.round(r.size * 2)}"/>`,
    ].join('');
    return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlEscape(r.text)}</w:t></w:r>`;
  }).join('');
  return `<w:p><w:pPr>${style}${brk}</w:pPr>${runs}</w:p>`;
}

function docxPackage(bodyXml, media = []) {
  const enc = new TextEncoder();
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${media.map((m, i) => `<Relationship Id="rIdI${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i}.jpeg"/>`).join('')}</Relationships>`;
  const headingStyle = (n, size) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${headingStyle(1, 36)}${headingStyle(2, 28)}${headingStyle(3, 24)}</w:styles>`;
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${DOCX_NS}><w:body>${bodyXml}</w:body></w:document>`;
  const files = {
    '[Content_Types].xml': enc.encode(types),
    '_rels/.rels': enc.encode(rels),
    'word/_rels/document.xml.rels': enc.encode(docRels),
    'word/styles.xml': enc.encode(styles),
    'word/document.xml': enc.encode(doc),
  };
  media.forEach((m, i) => { files[`word/media/image${i}.jpeg`] = [m, { level: 0 }]; });
  return files;
}

export async function pdfToDocx(bytes, { mode = 'text', onProgress } = {}) {
  const { zipSync } = await fflate();
  const sectPr = (w, h) => `<w:sectPr><w:pgSz w:w="${Math.round(w * 20)}" w:h="${Math.round(h * 20)}"/><w:pgMar w:top="1000" w:right="1100" w:bottom="1000" w:left="1100" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`;

  if (mode === 'layout') {
    const pages = await renderPages(bytes, { dpi: 170, onPage: onProgress });
    const body = pages.map((p, i) => {
      const cx = Math.round(p.widthPt * 12700), cy = Math.round(p.heightPt * 12700);
      const pic = `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${i + 1}" name="Page ${i + 1}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${i + 1}" name="page${i + 1}.jpeg"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdI${i}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
      const sect = i < pages.length - 1
        ? `<w:pPr><w:spacing w:after="0"/>${sectPrZero(p)}</w:pPr>`
        : '<w:pPr><w:spacing w:after="0"/></w:pPr>';
      return `<w:p>${sect}<w:r>${pic}</w:r></w:p>`;
    }).join('');
    const last = pages[pages.length - 1];
    const final = `<w:sectPr><w:pgSz w:w="${Math.round(last.widthPt * 20)}" w:h="${Math.round(last.heightPt * 20)}"/><w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`;
    return zipSync(docxPackage(body + final, pages.map(p => p.bytes)));
  }

  const pdf = await openPdfjs(bytes);
  let body = '';
  let size = { w: 595, h: 842 };
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const { lines, width, height } = await pageLines(page);
    if (n === 1) size = { w: width, h: height };
    toParagraphs(lines, width).forEach((p, i) => { body += docxParagraph(p, n > 1 && i === 0); });
    onProgress?.(n / pdf.numPages);
    await yieldToUi();
  }
  await pdf.destroy();
  return zipSync(docxPackage(body + sectPr(size.w, size.h)));
}

function sectPrZero(p) {
  return `<w:sectPr><w:pgSz w:w="${Math.round(p.widthPt * 20)}" w:h="${Math.round(p.heightPt * 20)}"/><w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`;
}

// ─── XLSX ─────────────────────────────────────────────────────────────────────

/** Turn a page's positioned text into rows and columns by clustering x positions. */
function pageToTable(lines) {
  const rows = lines.map(line => {
    const cells = [];
    for (const it of line.items) {
      const last = cells[cells.length - 1];
      const gap = last ? it.x - last.right : Infinity;
      if (last && gap < it.size * 1.1) {
        last.text += (gap > it.size * 0.18 && !/\s$/.test(last.text) ? ' ' : '') + it.str;
        last.right = it.x + it.w;
      } else {
        cells.push({ x: it.x, right: it.x + it.w, text: it.str });
      }
    }
    return cells;
  });
  const anchors = [];
  rows.flat().map(c => c.x).sort((a, b) => a - b).forEach(x => {
    const last = anchors[anchors.length - 1];
    if (last && x - last.sum / last.n < 9) { last.sum += x; last.n++; }
    else anchors.push({ sum: x, n: 1 });
  });
  const columns = anchors.map(a => a.sum / a.n);
  return rows.map(cells => {
    const row = [];
    for (const cell of cells) {
      let best = 0;
      columns.forEach((c, i) => { if (Math.abs(c - cell.x) < Math.abs(columns[best] - cell.x)) best = i; });
      row[best] = (row[best] ? `${row[best]} ` : '') + cell.text.trim();
    }
    return row;
  });
}

function columnName(i) {
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s;
  return s;
}

function parseCellNumber(text) {
  const t = text.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return Number(t.replace(/,/g, ''));
  if (/^-?\d{1,3}(\.\d{3})*,\d+$/.test(t) || /^-?\d+,\d+$/.test(t)) return Number(t.replace(/\./g, '').replace(',', '.'));
  return null;
}

export async function pdfToXlsx(bytes, { onProgress } = {}) {
  const { zipSync } = await fflate();
  const enc = new TextEncoder();
  const pdf = await openPdfjs(bytes);
  const sheets = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const { lines } = await pageLines(page);
    const rows = pageToTable(lines);
    const xmlRows = rows.map((row, r) => {
      const cells = [];
      row.forEach((text, c) => {
        if (!text) return;
        const ref = `${columnName(c)}${r + 1}`;
        const num = parseCellNumber(text);
        cells.push(num !== null && Number.isFinite(num)
          ? `<c r="${ref}"><v>${num}</v></c>`
          : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`);
      });
      return `<row r="${r + 1}">${cells.join('')}</row>`;
    }).join('');
    sheets.push(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${xmlRows}</sheetData></worksheet>`);
    onProgress?.(n / pdf.numPages);
    await yieldToUi();
  }
  await pdf.destroy();

  const files = {
    '[Content_Types].xml': enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`),
    '_rels/.rels': enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((_, i) => `<sheet name="Page ${i + 1}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`),
  };
  sheets.forEach((xml, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = enc.encode(xml); });
  return zipSync(files);
}

// ─── OCR ──────────────────────────────────────────────────────────────────────

/**
 * Add an invisible text layer so a scanned PDF becomes searchable.
 * The page images stay untouched.
 */
export async function ocrPdf(bytes, { lang = 'eng', dpi = 220, onProgress } = {}) {
  const lib = await pdfLib();
  const { PDFOperator, PDFNumber, beginText, endText, setFontAndSize, setTextMatrix, showText, pushGraphicsState, popGraphicsState } = lib;
  const doc = await loadDoc(bytes);
  const pdf = await openPdfjs(bytes);
  const pages = doc.getPages();
  const total = pages.length;
  let pageIndex = 0;
  const worker = await createOcrWorker(lang, m => {
    if (m.status === 'recognizing text') onProgress?.((pageIndex + (m.progress || 0)) / total);
  });

  doc.registerFontkit(await fontkit());
  const font = await doc.embedFont(await fontBytes(), { subset: true });
  const text = [];

  for (pageIndex = 0; pageIndex < total; pageIndex++) {
    const pjsPage = await pdf.getPage(pageIndex + 1);
    const viewport = pjsPage.getViewport({ scale: dpi / 72 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await renderOffscreen(pjsPage, canvas.getContext('2d'), viewport);
    const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
    const W = canvas.width, H = canvas.height;
    canvas.width = canvas.height = 0;
    text.push(data.text || '');

    const page = pages[pageIndex];
    const f = frame(page);
    const fontKey = page.node.newFontDictionary(font.name, font.ref);
    const ops = [pushGraphicsState(), beginText(), PDFOperator.of('Tr', [PDFNumber.of(3)])];
    const rad = f.rot * Math.PI / 180;
    for (const block of data.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          for (const word of line.words || []) {
            const str = (word.text || '').trim();
            if (!str || word.confidence < 25) continue;
            const b = word.bbox;
            const size = Math.max(2, ((b.y1 - b.y0) / H) * f.H);
            const widthPt = ((b.x1 - b.x0) / W) * f.W;
            const natural = font.widthOfTextAtSize(str, size);
            const sx = natural > 0 ? widthPt / natural : 1;
            const p = f.toPdf(b.x0 / W, b.y1 / H);
            ops.push(
              setFontAndSize(fontKey, size),
              setTextMatrix(sx * Math.cos(rad), sx * Math.sin(rad), -Math.sin(rad), Math.cos(rad), p.x, p.y),
              showText(font.encodeText(str)),
            );
          }
        }
      }
    }
    ops.push(endText(), popGraphicsState());
    page.pushOperators(...ops);
    await yieldToUi();
  }
  await worker.terminate();
  await pdf.destroy();
  onProgress?.(1);
  return { pdf: await doc.save(), text: text.join('\n\n') };
}

// ─── Misc ─────────────────────────────────────────────────────────────────────

/**
 * Render for output rather than display. The default display intent paces itself with
 * requestAnimationFrame, which stops in background tabs and would stall long jobs.
 */
function renderOffscreen(page, canvasContext, viewport) {
  return page.render({ canvasContext, viewport, intent: 'print', background: '#ffffff' }).promise;
}

export function yieldToUi() {
  return new Promise(resolve => {
    if (globalThis.scheduler?.yield) globalThis.scheduler.yield().then(resolve);
    else setTimeout(resolve, 0);
  });
}
