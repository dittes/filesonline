// formats-more.js
// Second set of parsers: images, audio and video containers, disk images, scientific data,
// CAD and 3D, security files and specialised text formats. Most read the format's header, so
// they stay fast on large files. Formats with nothing readable beyond a signature are named only.

import U from './util.js';
import E from './extractors.js';
import { t } from './i18n.js';

const { newResult, put, fact, hexdump, extractStrings, archiveSummary } = E.helpers;
const reg = E.register;

const ascii = (u8, o, l) => U.ascii(u8, o, l);
const cstr = (u8, o, l) => ascii(u8, o, l).replace(/\0.*$/s, '').trim();
const view = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
const utf8 = (u8) => new TextDecoder().decode(u8);
const fmt = (n) => U.fmtNum(n);

/** Register a format whose useful data sits in its header. */
function header(key, kind, mime, parser, read, { hex = true, strings = false } = {}) {
  reg(key, async (u8, name) => {
    const r = newResult();
    r.noSummary = true;
    r.noText = true;
    if (read) {
      try { read(r, u8, name); } catch (e) { r.warnings.push(t('Could not read the internal structure of this file.')); }
    }
    if (strings) {
      const s = extractStrings(u8.subarray(0, Math.min(u8.length, 8e6)), 8, 800);
      if (s.length) { r.text = s.join('\n'); r.noText = false; fact(r, 'Printable strings', fmt(s.length)); }
    }
    if (hex) r.sections.push({ title: t('Hex dump (first 512 bytes)'), hex: hexdump(u8, 512) });
    return r;
  }, kind, mime, parser);
}

const dims = (r, w, h, group = 'Image') => {
  put(r, group, 'Width', `${w} px`);
  put(r, group, 'Height', `${h} px`);
  fact(r, 'Dimensions', `${w} × ${h} px`);
};

/* ---------- Images ---------- */
header('icns', 'Apple icon', 'image/icns', 'ICNS', (r, u8) => {
  const dv = view(u8);
  const SIZES = { ic07: 128, ic08: 256, ic09: 512, ic10: 1024, ic11: 32, ic12: 64, ic13: 256, ic14: 512, icp4: 16, icp5: 32, icp6: 64, is32: 16, il32: 32, it32: 128 };
  const out = [];
  for (let p = 8; p + 8 <= u8.length && out.length < 60;) {
    const type = ascii(u8, p, 4), len = dv.getUint32(p + 4);
    if (len < 8) break;
    if (SIZES[type]) out.push(`${SIZES[type]} × ${SIZES[type]}`);
    p += len;
  }
  put(r, 'Image', 'Icon sizes', [...new Set(out)].join(', '));
  fact(r, 'Icon sizes', new Set(out).size);
});

header('jp2', 'JPEG 2000 image', 'image/jp2', 'JPEG 2000', (r, u8) => {
  const dv = view(u8);
  if (u8[0] === 0xff) { // raw codestream, SIZ marker
    dims(r, dv.getUint32(8) - dv.getUint32(16), dv.getUint32(12) - dv.getUint32(20));
    put(r, 'Image', 'Color components', dv.getUint16(40));
    return;
  }
  const hay = ascii(u8, 0, Math.min(u8.length, 65536));
  const i = hay.indexOf('ihdr');
  if (i > 0) {
    dims(r, dv.getUint32(i + 8), dv.getUint32(i + 4));
    put(r, 'Image', 'Color components', dv.getUint16(i + 12));
    put(r, 'Image', 'Bit depth', (u8[i + 14] & 0x7f) + 1);
  }
  put(r, 'Image', 'Container brands', cstr(u8, 20, 4));
});

header('exr', 'OpenEXR image', 'image/x-exr', 'OpenEXR', (r, u8) => {
  const dv = view(u8);
  put(r, 'Image', 'Format version', u8[4]);
  const COMPRESSION = ['None', 'RLE', 'ZIPS', 'ZIP', 'PIZ', 'PXR24', 'B44', 'B44A', 'DWAA', 'DWAB'];
  let p = 8;
  while (p < u8.length && p < 1 << 20 && u8[p]) {
    let e = u8.indexOf(0, p);
    const name = ascii(u8, p, e - p);
    p = e + 1;
    e = u8.indexOf(0, p);
    const type = ascii(u8, p, e - p);
    p = e + 1;
    const size = dv.getInt32(p, true);
    p += 4;
    if (name === 'displayWindow' && type === 'box2i') dims(r, dv.getInt32(p + 8, true) - dv.getInt32(p, true) + 1, dv.getInt32(p + 12, true) - dv.getInt32(p + 4, true) + 1);
    else if (name === 'compression') put(r, 'Image', 'Compression', COMPRESSION[u8[p]]);
    else if (name === 'channels') {
      const list = [];
      for (let q = p; q < p + size - 1 && u8[q];) { const n = u8.indexOf(0, q); list.push(ascii(u8, q, n - q)); q = n + 17; }
      put(r, 'Image', 'Channels', list.join(', '));
    } else if (type === 'string') put(r, 'Image', name, ascii(u8, p, size));
    p += size;
  }
});

header('pcx', 'PCX image', 'image/vnd.zbrush.pcx', 'PCX', (r, u8) => {
  const dv = view(u8);
  dims(r, dv.getUint16(8, true) - dv.getUint16(4, true) + 1, dv.getUint16(10, true) - dv.getUint16(6, true) + 1);
  put(r, 'Image', 'Bit depth', u8[3] * u8[65]);
});
header('xcf', 'GIMP image', 'image/x-xcf', 'XCF', (r, u8) => {
  const dv = view(u8);
  const tag = cstr(u8, 9, 5);
  put(r, 'Image', 'Format version', tag === 'file' ? '0' : tag.replace(/^v0*/, ''));
  dims(r, dv.getUint32(14), dv.getUint32(18));
  put(r, 'Image', 'Color mode', ['RGB', 'Grayscale', 'Indexed'][dv.getUint32(22)]);
});
header('dds', 'DirectDraw texture', 'image/vnd.ms-dds', 'DDS', (r, u8) => {
  const dv = view(u8);
  dims(r, dv.getUint32(16, true), dv.getUint32(12, true));
  put(r, 'Image', 'Mipmaps', dv.getUint32(28, true));
  put(r, 'Image', 'Compression', cstr(u8, 84, 4));
});
header('qoi', 'QOI image', 'image/qoi', 'QOI', (r, u8) => {
  const dv = view(u8);
  dims(r, dv.getUint32(4), dv.getUint32(8));
  put(r, 'Image', 'Channels', u8[12]);
  put(r, 'Image', 'Color space', u8[13] ? 'Linear' : 'sRGB');
});
header('hdr', 'Radiance HDR image', 'image/vnd.radiance', 'Radiance', (r, u8) => {
  const m = /-Y\s+(\d+)\s+\+X\s+(\d+)/.exec(ascii(u8, 0, 4096));
  if (m) dims(r, +m[2], +m[1]);
});
header('dpx', 'DPX film scan', 'image/x-dpx', 'DPX', (r, u8) => {
  const le = ascii(u8, 0, 4) === 'XPDS';
  const dv = view(u8);
  dims(r, dv.getUint32(772, le), dv.getUint32(776, le));
  put(r, 'Image', 'Format version', cstr(u8, 8, 8));
  put(r, 'Document', 'Created', cstr(u8, 136, 24));
  put(r, 'Application', 'Creator', cstr(u8, 160, 100));
});
header('bpg', 'BPG image', 'image/bpg', 'BPG');
header('wmf', 'Windows metafile', 'image/wmf', 'WMF', (r, u8) => {
  const dv = view(u8);
  if (u8[0] === 0xd7) {
    const unit = dv.getUint16(14, true) || 1440;
    put(r, 'Image', 'Width', `${((dv.getInt16(10, true) - dv.getInt16(6, true)) / unit * 25.4).toFixed(1)} mm`);
    put(r, 'Image', 'Height', `${((dv.getInt16(12, true) - dv.getInt16(8, true)) / unit * 25.4).toFixed(1)} mm`);
  }
});
header('emf', 'Enhanced metafile', 'image/emf', 'EMF', (r, u8) => {
  const dv = view(u8);
  put(r, 'Image', 'Width', `${((dv.getInt32(32, true) - dv.getInt32(24, true)) / 100).toFixed(1)} mm`);
  put(r, 'Image', 'Height', `${((dv.getInt32(36, true) - dv.getInt32(28, true)) / 100).toFixed(1)} mm`);
  put(r, 'Image', 'Records', dv.getUint32(52, true));
  const n = dv.getUint32(60, true), off = dv.getUint32(64, true);
  if (n && off) put(r, 'Document', 'Description', new TextDecoder('utf-16le').decode(u8.subarray(off, off + n * 2)).replace(/\0+/g, ' ').trim());
});
header('fits', 'FITS astronomy data', 'application/fits', 'FITS', (r, u8) => {
  const KEEP = { OBJECT: 'Object', TELESCOP: 'Telescope', INSTRUME: 'Instrument', OBSERVER: 'Observer', 'DATE-OBS': 'Observed', BITPIX: 'Bit depth', NAXIS: 'Axes', NAXIS1: 'Width', NAXIS2: 'Height' };
  const cards = [];
  for (let p = 0; p + 80 <= u8.length && p < 2880 * 40; p += 80) {
    const card = ascii(u8, p, 80);
    if (card.startsWith('END')) break;
    const k = card.slice(0, 8).trim();
    const v = card.slice(10).split(' /')[0].trim().replace(/^'|'\s*$/g, '').trim();
    if (card[8] === '=') { cards.push(`${k} = ${v}`); if (KEEP[k]) put(r, 'Data', KEEP[k], v); }
  }
  r.sections.push({ title: t('Headers'), list: cards, open: true });
  fact(r, 'Headers', cards.length);
}, { hex: false });
header('djvu', 'DjVu document', 'image/vnd.djvu', 'DjVu', (r, u8) => {
  const dv = view(u8);
  const multi = ascii(u8, 12, 4) === 'DJVM';
  const hay = ascii(u8, 0, Math.min(u8.length, 8e6));
  const pages = (hay.match(/FORM.{4}DJVU/gs) || []).length;
  put(r, 'Document', 'Pages', multi ? pages : 1);
  fact(r, 'Pages', multi ? pages : 1);
  const i = hay.indexOf('INFO');
  if (i > 0) { dims(r, dv.getUint16(i + 8), dv.getUint16(i + 10)); put(r, 'Image', 'Resolution', `${dv.getUint16(i + 14, true)} DPI`); }
});
header('xbm', 'X bitmap', 'image/x-xbitmap', 'XBM', (r, u8) => {
  const s = ascii(u8, 0, 512);
  const w = /_width\s+(\d+)/.exec(s), h = /_height\s+(\d+)/.exec(s);
  if (w && h) dims(r, +w[1], +h[1]);
});
header('xpm', 'X pixmap', 'image/x-xpixmap', 'XPM', (r, u8) => {
  const m = /"\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/.exec(ascii(u8, 0, 2048));
  if (m) { dims(r, +m[1], +m[2]); put(r, 'Image', 'Colors', m[3]); }
});

// Formats browsers may decode: reuse the common image path for size and preview
reg('jxl', async (u8, name) => {
  const r = await E.handler('png')(u8, name, { key: 'jxl' });
  r.canOcr = false;
  put(r, 'Image', 'Container', u8[0] === 0xff ? 'Codestream' : 'ISO BMFF');
  return r;
}, 'JPEG XL image', 'image/jxl', 'JPEG XL');

// Camera RAW files are TIFF underneath, so EXIF, size and camera data come along
const RAW_EXT = { cr2: 'Canon', nef: 'Nikon', nrw: 'Nikon', arw: 'Sony', sr2: 'Sony', srf: 'Sony', dng: 'Adobe DNG', orf: 'Olympus', rw2: 'Panasonic', pef: 'Pentax', srw: 'Samsung', kdc: 'Kodak', dcr: 'Kodak', mos: 'Leaf', '3fr': 'Hasselblad', erf: 'Epson', iiq: 'Phase One' };
reg('rawphoto', async (u8, name) => {
  const r = await E.handler('tiff')(u8, name, { key: 'tiff' });
  r.warnings = r.warnings.filter((w) => w !== t('This browser cannot display a preview of this image format.'));
  r.canOcr = false;
  if (r.preview) { URL.revokeObjectURL(r.preview.url); r.preview = null; }
  put(r, 'Image', 'RAW format', `${RAW_EXT[U.extOf(name)] || 'TIFF-based'} (.${U.extOf(name)})`);
  return r;
}, 'Camera RAW photo', 'image/x-raw', 'TIFF/EXIF');
header('raf', 'Camera RAW photo', 'image/x-fuji-raf', 'Fujifilm RAF', (r, u8) => { put(r, 'Camera & EXIF', 'Camera make', 'Fujifilm'); put(r, 'Camera & EXIF', 'Camera model', cstr(u8, 28, 32)); });
header('cr3', 'Camera RAW photo', 'image/x-canon-cr3', 'Canon CR3', (r) => { put(r, 'Camera & EXIF', 'Camera make', 'Canon'); });

/* ---------- Audio ---------- */
const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
reg('aac', async (u8, name) => {
  const r = await E.handler('mp3')(u8, name, { key: 'aac' });
  const profile = ((u8[2] >> 6) & 3) + 1, sr = (u8[2] >> 2) & 15, ch = ((u8[2] & 1) << 2) | (u8[3] >> 6);
  put(r, 'Audio', 'Codec', ['', 'AAC Main', 'AAC-LC', 'AAC SSR', 'AAC LTP'][profile]);
  put(r, 'Audio', 'Sample rate', `${AAC_RATES[sr]} Hz`);
  put(r, 'Audio', 'Channels', ch);
  return r;
}, 'AAC audio', 'audio/aac', 'ADTS');
header('ac3', 'Dolby Digital audio', 'audio/ac3', 'AC-3', (r, u8) => {
  const rate = [48000, 44100, 32000][u8[4] >> 6];
  const BITRATES = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640];
  put(r, 'Audio', 'Sample rate', `${rate} Hz`);
  put(r, 'Audio', 'Bitrate', `${BITRATES[(u8[4] & 63) >> 1]} kbps`);
  put(r, 'Audio', 'Channels', ['2 (1+1)', '1', '2', '3', '3', '4', '4', '5'][u8[6] >> 5]);
});
header('amr', 'AMR voice recording', 'audio/amr', 'AMR', (r, u8) => { put(r, 'Audio', 'Codec', ascii(u8, 0, 8) === '#!AMR-WB' ? 'AMR-WB' : 'AMR-NB'); });
header('au', 'Sun audio', 'audio/basic', 'AU', (r, u8) => {
  const dv = view(u8);
  const off = dv.getUint32(4), size = dv.getUint32(8), enc = dv.getUint32(12), rate = dv.getUint32(16), ch = dv.getUint32(20);
  put(r, 'Audio', 'Codec', { 1: 'µ-law', 2: 'PCM 8', 3: 'PCM 16', 4: 'PCM 24', 5: 'PCM 32', 6: 'Float', 27: 'A-law' }[enc]);
  put(r, 'Audio', 'Sample rate', `${rate} Hz`);
  put(r, 'Audio', 'Channels', ch);
  const bytes = { 1: 1, 2: 1, 3: 2, 4: 3, 5: 4, 6: 4, 27: 1 }[enc];
  if (bytes && rate && ch && size !== 0xffffffff) put(r, 'Audio', 'Duration', U.fmtDuration(size / (bytes * rate * ch)));
  put(r, 'Document', 'Description', cstr(u8, 24, Math.max(0, off - 24)));
});
header('caf', 'Apple Core Audio', 'audio/x-caf', 'CAF', (r, u8) => {
  const dv = view(u8);
  for (let p = 8; p + 12 <= u8.length;) {
    const type = ascii(u8, p, 4), size = Number(dv.getBigUint64(p + 4));
    if (type === 'desc') {
      put(r, 'Audio', 'Sample rate', `${dv.getFloat64(p + 12)} Hz`);
      put(r, 'Audio', 'Codec', ascii(u8, p + 20, 4).trim());
      put(r, 'Audio', 'Channels', dv.getUint32(p + 36));
      put(r, 'Audio', 'Bit depth', dv.getUint32(p + 40) || '');
    }
    if (type === 'data' || size <= 0) break;
    p += 12 + size;
  }
});
header('ape', "Monkey's Audio", 'audio/ape', 'APE');
header('wavpack', 'WavPack audio', 'audio/x-wavpack', 'WavPack');
header('mpc', 'Musepack audio', 'audio/x-musepack', 'Musepack');
header('dsf', 'DSD audio', 'audio/dsf', 'DSF', (r, u8) => {
  const dv = view(u8);
  const i = ascii(u8, 0, 256).indexOf('fmt ');
  if (i < 0) return;
  const ch = dv.getUint32(i + 24, true), rate = dv.getUint32(i + 28, true), samples = Number(dv.getBigUint64(i + 36, true));
  put(r, 'Audio', 'Channels', ch); put(r, 'Audio', 'Sample rate', `${rate} Hz`);
  if (rate) put(r, 'Audio', 'Duration', U.fmtDuration(samples / rate));
});
header('tta', 'True Audio', 'audio/x-tta', 'TTA', (r, u8) => {
  const dv = view(u8);
  put(r, 'Audio', 'Channels', dv.getUint16(6, true)); put(r, 'Audio', 'Bit depth', `${dv.getUint16(8, true)} bit`);
  const rate = dv.getUint32(10, true);
  put(r, 'Audio', 'Sample rate', `${rate} Hz`);
  if (rate) put(r, 'Audio', 'Duration', U.fmtDuration(dv.getUint32(14, true) / rate));
});
const tracker = (titleOf) => (r, u8) => { const title = titleOf(u8); put(r, 'Tags', 'Title', title); if (title) r.title = title; };
header('mod', 'Tracker music (MOD)', 'audio/x-mod', 'MOD', tracker((u8) => cstr(u8, 0, 20)));
header('s3m', 'Tracker music (S3M)', 'audio/s3m', 'S3M', tracker((u8) => cstr(u8, 0, 28)));
header('xm', 'Tracker music (XM)', 'audio/xm', 'XM', tracker((u8) => cstr(u8, 17, 20)));
header('it', 'Tracker music (IT)', 'audio/it', 'Impulse Tracker', tracker((u8) => cstr(u8, 4, 26)));
header('sid', 'C64 music (SID)', 'audio/prs.sid', 'SID', (r, u8) => {
  put(r, 'Tags', 'Title', cstr(u8, 22, 32)); put(r, 'Tags', 'Artist', cstr(u8, 54, 32)); put(r, 'Tags', 'Year', cstr(u8, 86, 32));
  put(r, 'Audio', 'Tracks', view(u8).getUint16(14));
  r.title = cstr(u8, 22, 32);
});

/* ---------- Video: tracks inside MP4 and Matroska ---------- */
function mp4Tracks(r, u8) {
  const dv = view(u8);
  const tracks = [];
  let current = null, created = 0, modified = 0;
  const macTime = (s) => (s > 2082844800 ? new Date((s - 2082844800) * 1000) : null);
  const walk = (s, e, depth) => {
    for (let p = s; p + 8 <= e;) {
      let size = dv.getUint32(p), hdr = 8;
      const type = ascii(u8, p + 4, 4);
      if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; } else if (size === 0) size = e - p;
      if (size < hdr || p + size > e + 8) return;
      const b = p + hdr;
      if (type === 'trak') { current = {}; tracks.push(current); walk(b, p + size, depth + 1); current = null; }
      else if (['moov', 'mdia', 'minf', 'stbl'].includes(type)) walk(b, p + size, depth + 1);
      else if (type === 'mvhd') {
        const v1 = u8[b] === 1;
        created = v1 ? Number(dv.getBigUint64(b + 4)) : dv.getUint32(b + 4);
        modified = v1 ? Number(dv.getBigUint64(b + 12)) : dv.getUint32(b + 8);
      } else if (current && type === 'tkhd') {
        const base = u8[b] === 1 ? b + 88 : b + 76;
        current.w = dv.getUint32(base) >>> 16; current.h = dv.getUint32(base + 4) >>> 16;
      } else if (current && type === 'hdlr') current.handler = ascii(u8, b + 8, 4);
      else if (current && type === 'mdhd') {
        const v1 = u8[b] === 1;
        const code = dv.getUint16(v1 ? b + 32 : b + 20);
        const lang = String.fromCharCode(((code >> 10) & 31) + 96, ((code >> 5) & 31) + 96, (code & 31) + 96);
        if (/^[a-z]{3}$/.test(lang) && lang !== 'und') current.lang = lang;
      } else if (current && type === 'stsd') {
        current.codec = ascii(u8, b + 12, 4).trim();
        if (current.handler === 'soun') { current.channels = dv.getUint16(b + 32); current.rate = dv.getUint32(b + 40) >>> 16; }
      }
      p += size;
    }
  };
  walk(0, u8.length, 0);
  if (macTime(created)) put(r, 'Document', 'Created', U.metaDate(macTime(created)));
  if (macTime(modified)) put(r, 'Document', 'Modified', U.metaDate(macTime(modified)));
  const lines = tracks.filter((x) => x.handler).map((x) => {
    const label = { vide: 'Video', soun: 'Audio', text: 'Subtitles', sbtl: 'Subtitles', subt: 'Subtitles' }[x.handler] || x.handler;
    return [t(label), x.codec, x.w ? `${x.w} × ${x.h}` : '', x.rate ? `${x.rate} Hz` : '', x.channels ? `${x.channels} ch` : '', x.lang].filter(Boolean).join(' · ');
  });
  const video = tracks.find((x) => x.handler === 'vide'), audio = tracks.find((x) => x.handler === 'soun');
  const group = video ? 'Video' : 'Audio';
  if (lines.length) { r.sections.push({ title: t('Tracks'), list: lines, open: true }); put(r, group, 'Tracks', lines.length); }
  if (video?.codec) put(r, group, 'Video codec', video.codec);
  if (audio?.codec) put(r, group, 'Audio codec', audio.codec);
  if (video?.w) put(r, group, 'Resolution', `${video.w} × ${video.h}`);
}

// Matroska element IDs: Segment/Info/Tracks and the fields inside them
function ebml(r, u8) {
  const readId = (p) => { const b = u8[p]; let n = 1; for (let m = 0x80; n <= 4 && !(b & m); m >>= 1) n++; let v = 0; for (let i = 0; i < n; i++) v = v * 256 + u8[p + i]; return [v, n]; };
  const readSize = (p) => { const b = u8[p]; let n = 1, m = 0x80; while (n <= 8 && !(b & m)) { n++; m >>= 1; } let v = b & (m - 1); let unknown = v === m - 1; for (let i = 1; i < n; i++) { v = v * 256 + u8[p + i]; if (u8[p + i] !== 255) unknown = false; } return [unknown ? -1 : v, n]; };
  const dv = view(u8);
  const uint = (p, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + u8[p + i]; return v; };
  const float = (p, n) => (n === 4 ? dv.getFloat32(p) : dv.getFloat64(p));
  const CONTAINERS = new Set([0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0xe0, 0xe1]);
  const tracks = [];
  let track = null, scale = 1000000, duration = 0;
  const walk = (s, e) => {
    for (let p = s; p < e && p < u8.length;) {
      const [id, a] = readId(p);
      const [size, c] = readSize(p + a);
      const b = p + a + c;
      const end = size < 0 ? e : Math.min(b + size, u8.length);
      if (id === 0xae) { track = {}; tracks.push(track); walk(b, end); track = null; }
      else if (CONTAINERS.has(id)) walk(b, end);
      else if (id === 0x1f43b675 || id === 0x114d9b74 || id === 0x1c53bb6b) { if (id === 0x1f43b675) return; }
      else if (id === 0x2ad7b1) scale = uint(b, size);
      else if (id === 0x4489) duration = float(b, size);
      else if (id === 0x7ba9) { const v = utf8(u8.subarray(b, end)); put(r, 'Tags', 'Title', v); r.title = v; }
      else if (id === 0x4d80) put(r, 'Application', 'Muxing application', utf8(u8.subarray(b, end)));
      else if (id === 0x5741) put(r, 'Application', 'Application', utf8(u8.subarray(b, end)));
      else if (id === 0x4461) { const ns = Number(dv.getBigInt64(b)); put(r, 'Document', 'Created', U.metaDate(new Date(978307200000 + ns / 1e6))); }
      else if (track) {
        if (id === 0x83) track.type = uint(b, size);
        else if (id === 0x86) track.codec = cstr(u8, b, size);
        else if (id === 0x536e) track.name = utf8(u8.subarray(b, end));
        else if (id === 0x22b59c) track.lang = cstr(u8, b, size);
        else if (id === 0xb0) track.w = uint(b, size);
        else if (id === 0xba) track.h = uint(b, size);
        else if (id === 0xb5) track.rate = float(b, size);
        else if (id === 0x9f) track.channels = uint(b, size);
      }
      p = end;
    }
  };
  const [, a0] = readId(0);
  const [hsize, c0] = readSize(a0);
  walk(a0 + c0 + hsize, u8.length);
  if (duration) put(r, 'Video', 'Duration', U.fmtDuration((duration * scale) / 1e9));
  const lines = tracks.map((x) => [t({ 1: 'Video', 2: 'Audio', 17: 'Subtitles' }[x.type] || 'Other'), x.codec, x.w ? `${x.w} × ${x.h}` : '', x.rate ? `${Math.round(x.rate)} Hz` : '', x.channels ? `${x.channels} ch` : '', x.lang && x.lang !== 'und' ? x.lang : '', x.name].filter(Boolean).join(' · '));
  if (lines.length) { r.sections.push({ title: t('Tracks'), list: lines, open: true }); put(r, 'Video', 'Tracks', lines.length); }
  const v = tracks.find((x) => x.type === 1), au = tracks.find((x) => x.type === 2);
  if (v?.codec) put(r, 'Video', 'Video codec', v.codec);
  if (au?.codec) put(r, 'Video', 'Audio codec', au.codec);
  if (v?.w && !(r.meta.Video || {}).Resolution) put(r, 'Video', 'Resolution', `${v.w} × ${v.h}`);
}

const enhance = (key, fn) => {
  const base = E.handler(key);
  reg(key, async (...args) => {
    const r = await base(...args);
    try { fn(r, args[0], args[1]); } catch (e) { /* the base result still stands */ }
    return r;
  });
};
['mp4', 'mov', 'm4a'].forEach((k) => enhance(k, mp4Tracks));
['mkv', 'webm'].forEach((k) => enhance(k, ebml));

enhance('flv', (r, u8) => {
  const i = ascii(u8, 0, Math.min(u8.length, 8192)).indexOf('onMetaData');
  if (i < 0) return;
  const dv = view(u8);
  const WANT = { width: 'w', height: 'h', duration: 'd', framerate: 'f', videodatarate: 'vr', audiodatarate: 'ar', encoder: 'e' };
  const got = {};
  for (const name of Object.keys(WANT)) {
    const j = ascii(u8, i, 2048).indexOf(`\0${String.fromCharCode(name.length)}${name}`);
    if (j < 0) continue;
    const p = i + j + 2 + name.length;
    if (u8[p] === 0) got[name] = dv.getFloat64(p + 1);
    else if (u8[p] === 2) got[name] = ascii(u8, p + 3, dv.getUint16(p + 1));
  }
  if (got.width) { put(r, 'Video', 'Resolution', `${got.width} × ${got.height}`); fact(r, 'Resolution', `${got.width} × ${got.height}`); }
  if (got.duration) { put(r, 'Video', 'Duration', U.fmtDuration(got.duration)); fact(r, 'Duration', U.fmtDuration(got.duration)); }
  if (got.framerate) put(r, 'Video', 'Frame rate', `${+got.framerate.toFixed(2)} fps`);
  if (got.encoder) put(r, 'Application', 'Application', got.encoder);
});

header('swf', 'Flash animation', 'application/x-shockwave-flash', 'SWF', (r, u8) => {
  put(r, 'Video', 'Format version', u8[3]);
  put(r, 'Video', 'Compression', { F: 'None', C: 'zlib', Z: 'LZMA' }[String.fromCharCode(u8[0])]);
  put(r, 'Video', 'Uncompressed size', U.fmtBytes(view(u8).getUint32(4, true)));
  if (u8[0] !== 0x46) return;
  const bits = u8[8] >> 3;
  let pos = 13;
  const read = () => { let v = 0; for (let i = 0; i < bits; i++, pos++) v = (v << 1) | ((u8[8 + (pos >> 3)] >> (7 - (pos & 7))) & 1); return v << (32 - bits) >> (32 - bits); };
  pos = 5;
  const [x0, x1, y0, y1] = [read(), read(), read(), read()];
  dims(r, Math.round((x1 - x0) / 20), Math.round((y1 - y0) / 20), 'Video');
  const rect = 8 + Math.ceil((5 + bits * 4) / 8);
  put(r, 'Video', 'Frame rate', `${u8[rect + 1] + u8[rect] / 256} fps`);
  put(r, 'Video', 'Frames', view(u8).getUint16(rect + 2, true));
});
header('ivf', 'IVF video', 'video/x-ivf', 'IVF', (r, u8) => {
  const dv = view(u8);
  put(r, 'Video', 'Video codec', ascii(u8, 8, 4));
  put(r, 'Video', 'Resolution', `${dv.getUint16(12, true)} × ${dv.getUint16(14, true)}`);
  put(r, 'Video', 'Frame rate', `${+(dv.getUint32(16, true) / (dv.getUint32(20, true) || 1)).toFixed(2)} fps`);
  put(r, 'Video', 'Frames', dv.getUint32(24, true));
});
header('y4m', 'Raw video (Y4M)', 'video/x-yuv4mpeg', 'YUV4MPEG', (r, u8) => {
  const s = ascii(u8, 0, 256).split('\n')[0];
  const w = /\bW(\d+)/.exec(s), h = /\bH(\d+)/.exec(s), f = /\bF(\d+):(\d+)/.exec(s);
  if (w && h) put(r, 'Video', 'Resolution', `${w[1]} × ${h[1]}`);
  if (f) put(r, 'Video', 'Frame rate', `${+(f[1] / f[2]).toFixed(2)} fps`);
});
header('rm', 'RealMedia', 'application/vnd.rn-realmedia', 'RealMedia');
header('mxf', 'MXF broadcast video', 'application/mxf', 'MXF');

/* ---------- Archives and disk images ---------- */
const packed = (key, kind, mime, parser, read) => header(key, kind, mime, parser, (r, u8, name) => {
  if (read) read(r, u8, name);
  r.warnings.push(t('This compression format cannot be unpacked here, so only its header is shown.'));
});
packed('lz4', 'LZ4 file', 'application/x-lz4', 'LZ4');
packed('lzip', 'Lzip file', 'application/x-lzip', 'Lzip');
packed('lzma', 'LZMA file', 'application/x-lzma', 'LZMA');
packed('compress', 'Unix compress file', 'application/x-compress', 'LZW');
packed('arj', 'ARJ archive', 'application/x-arj', 'ARJ');
packed('lzh', 'LHA archive', 'application/x-lzh-compressed', 'LHA', (r, u8) => { put(r, 'Compression', 'Method', ascii(u8, 2, 5)); });
packed('zoo', 'ZOO archive', 'application/x-zoo', 'ZOO');
packed('ace', 'ACE archive', 'application/x-ace-compressed', 'ACE');
packed('sit', 'StuffIt archive', 'application/x-stuffit', 'StuffIt');
packed('xar', 'XAR archive', 'application/x-xar', 'XAR', (r, u8, name) => {
  const dv = view(u8);
  if (/\.pkg$/i.test(name)) r.kind = 'macOS installer package';
  put(r, 'Compression', 'Table of contents', U.fmtBytes(Number(dv.getBigUint64(16))));
});
packed('wim', 'Windows image', 'application/x-ms-wim', 'WIM', (r, u8) => {
  const dv = view(u8);
  put(r, 'Archive', 'Format version', dv.getUint32(12, true));
  put(r, 'Archive', 'Images', dv.getUint32(44, true));
});
header('squashfs', 'SquashFS image', 'application/x-squashfs', 'SquashFS', (r, u8) => {
  const dv = view(u8);
  put(r, 'Archive', 'Inodes', fmt(dv.getUint32(4, true)));
  put(r, 'Archive', 'Format version', `${dv.getUint16(28, true)}.${dv.getUint16(30, true)}`);
  put(r, 'Compression', 'Method', { 1: 'gzip', 2: 'LZMA', 3: 'LZO', 4: 'XZ', 5: 'LZ4', 6: 'Zstandard' }[dv.getUint16(20, true)]);
});
header('dmg', 'Apple disk image', 'application/x-apple-diskimage', 'DMG', (r, u8) => {
  const p = u8.length - 512;
  const dv = view(u8);
  if (ascii(u8, p, 4) !== 'koly') {
    put(r, 'Archive', 'Disk type', t('Raw, read/write'));
    put(r, 'Archive', 'Disk size', U.fmtBytes(u8.length));
    return;
  }
  put(r, 'Archive', 'Format version', dv.getUint32(p + 4));
  put(r, 'Archive', 'Disk size', U.fmtBytes(Number(dv.getBigUint64(p + 492)) * 512));
  put(r, 'Archive', 'Partition map', U.fmtBytes(Number(dv.getBigUint64(p + 224))));
  const xml = U.ascii(u8, Math.max(0, p - 2e6), Math.min(p, 2e6));
  const names = [...xml.matchAll(/<key>CFName<\/key>\s*<string>([^<]+)</g)].map((m) => m[1]);
  if (names.length) r.sections.push({ title: t('Partitions'), list: [...new Set(names)], open: true });
}, { hex: false });
header('vhd', 'Virtual hard disk', 'application/x-vhd', 'VHD', (r, u8) => {
  const p = ascii(u8, u8.length - 512, 8) === 'conectix' ? u8.length - 512 : 0;
  const dv = view(u8);
  put(r, 'Archive', 'Disk size', U.fmtBytes(Number(dv.getBigUint64(p + 48))));
  put(r, 'Archive', 'Disk type', t({ 2: 'Fixed', 3: 'Dynamic', 4: 'Differencing' }[dv.getUint32(p + 60)] || ''));
  put(r, 'Application', 'Creator', ascii(u8, p + 28, 4).trim());
});
header('vmdk', 'VMware disk', 'application/x-vmdk', 'VMDK', (r, u8) => {
  if (ascii(u8, 0, 4) === 'KDMV') {
    const dv = view(u8);
    put(r, 'Archive', 'Format version', dv.getUint32(4, true));
    put(r, 'Archive', 'Disk size', U.fmtBytes(Number(dv.getBigUint64(12, true)) * 512));
  }
});
header('qcow', 'QEMU disk image', 'application/x-qemu-disk', 'QCOW', (r, u8) => {
  const dv = view(u8);
  put(r, 'Archive', 'Format version', dv.getUint32(4));
  put(r, 'Archive', 'Disk size', U.fmtBytes(Number(dv.getBigUint64(24))));
});
header('vdi', 'VirtualBox disk', 'application/x-virtualbox-vdi', 'VDI', (r, u8) => {
  const dv = view(u8);
  put(r, 'Archive', 'Disk type', t({ 1: 'Dynamic', 2: 'Fixed' }[dv.getUint32(76, true)] || ''));
  put(r, 'Archive', 'Disk size', U.fmtBytes(Number(dv.getBigUint64(368, true))));
  put(r, 'Document', 'Description', cstr(u8, 84, 256));
});
header('gitpack', 'Git pack', 'application/x-git-packed-objects', 'Git', (r, u8) => {
  const dv = view(u8);
  put(r, 'Archive', 'Format version', dv.getUint32(4));
  put(r, 'Archive', 'Objects', fmt(dv.getUint32(8)));
});

/* ---------- Data and science ---------- */
header('pcap', 'Network capture', 'application/vnd.tcpdump.pcap', 'PCAP', (r, u8) => {
  const dv = view(u8);
  const le = u8[0] === 0xd4 || u8[0] === 0x4d;
  put(r, 'Network capture', 'Format version', `${dv.getUint16(4, le)}.${dv.getUint16(6, le)}`);
  const link = dv.getUint32(20, le) & 0xfffffff;
  put(r, 'Network capture', 'Link type', { 0: 'Loopback', 1: 'Ethernet', 101: 'Raw IP', 105: 'Wi-Fi', 113: 'Linux cooked', 127: 'Wi-Fi (radiotap)' }[link] ?? link);
  let packets = 0, first = 0, last = 0;
  for (let p = 24; p + 16 <= u8.length;) {
    const ts = dv.getUint32(p, le), len = dv.getUint32(p + 8, le);
    if (!first) first = ts;
    last = ts;
    packets++;
    p += 16 + len;
  }
  put(r, 'Network capture', 'Packets', fmt(packets));
  fact(r, 'Packets', fmt(packets));
  if (first) { put(r, 'Network capture', 'Started', U.metaDate(new Date(first * 1000))); put(r, 'Network capture', 'Ended', U.metaDate(new Date(last * 1000))); }
});
header('pcapng', 'Network capture', 'application/x-pcapng', 'PCAPNG', (r, u8) => {
  const dv = view(u8);
  const le = dv.getUint32(8) === 0x4d3c2b1a;
  put(r, 'Network capture', 'Format version', `${dv.getUint16(12, le)}.${dv.getUint16(14, le)}`);
  let packets = 0, interfaces = 0;
  for (let p = 0; p + 12 <= u8.length;) {
    const type = dv.getUint32(p, le), len = dv.getUint32(p + 4, le);
    if (len < 12) break;
    if (type === 1) interfaces++;
    if (type === 6 || type === 3) packets++;
    p += len;
  }
  put(r, 'Network capture', 'Packets', fmt(packets)); put(r, 'Network capture', 'Interfaces', interfaces);
  fact(r, 'Packets', fmt(packets));
});
header('hdf5', 'HDF5 data', 'application/x-hdf5', 'HDF5', (r, u8) => { put(r, 'Data', 'Superblock version', u8[8]); });
header('netcdf', 'NetCDF data', 'application/x-netcdf', 'NetCDF', (r, u8) => {
  put(r, 'Data', 'Format version', { 1: 'Classic', 2: '64-bit offset', 5: '64-bit data' }[u8[3]]);
  const dv = view(u8);
  if (u8[3] === 1 || u8[3] === 2) put(r, 'Data', 'Records', dv.getUint32(4) === 0xffffffff ? 'Streaming' : fmt(dv.getUint32(4)));
});
header('avro', 'Apache Avro data', 'application/avro', 'Avro', (r, u8) => {
  let p = 4;
  const zigzag = () => { let v = 0, s = 0, b; do { b = u8[p++]; v += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return v % 2 ? -(v + 1) / 2 : v / 2; };
  let count = zigzag();
  if (count < 0) { count = -count; zigzag(); }
  for (let i = 0; i < count && i < 100; i++) {
    const kl = zigzag(); const key = utf8(u8.subarray(p, p + kl)); p += kl;
    const vl = zigzag(); const val = utf8(u8.subarray(p, p + vl)); p += vl;
    if (key === 'avro.codec') put(r, 'Compression', 'Method', val);
    else if (key === 'avro.schema') {
      const schema = JSON.parse(val);
      put(r, 'Data', 'Record name', schema.name);
      if (schema.fields) {
        put(r, 'Data', 'Fields', schema.fields.length);
        fact(r, 'Fields', schema.fields.length);
        r.sections.push({ title: t('Fields'), list: schema.fields.map((f) => `${f.name} · ${JSON.stringify(f.type).replace(/"/g, '')}`), open: true });
      }
    }
  }
});
header('orc', 'Apache ORC data', 'application/vnd.apache.orc', 'ORC');
header('arrow', 'Apache Arrow data', 'application/vnd.apache.arrow.file', 'Arrow');
header('cbor', 'CBOR data', 'application/cbor', 'CBOR');
header('mat', 'MATLAB data', 'application/x-matlab-data', 'MATLAB', (r, u8) => {
  put(r, 'Data', 'Description', ascii(u8, 0, 116).trim());
}, { hex: false });
header('spss', 'SPSS data', 'application/x-spss-sav', 'SPSS', (r, u8) => {
  const dv = view(u8);
  put(r, 'Application', 'Creator', ascii(u8, 4, 60).trim());
  put(r, 'Data', 'Records', fmt(dv.getInt32(80, true)));
  put(r, 'Data', 'Created', `${cstr(u8, 92, 9)} ${cstr(u8, 101, 8)}`);
  put(r, 'Document', 'Title', cstr(u8, 109, 64));
});
header('access', 'Microsoft Access database', 'application/x-msaccess', 'Access', (r, u8) => {
  put(r, 'Database', 'Engine', cstr(u8, 4, 15));
  put(r, 'Database', 'Format version', { 0: 'Jet 3', 1: 'Jet 4', 2: 'ACE 12', 3: 'ACE 14', 5: 'ACE 16' }[u8[20]]);
});
header('shp', 'Esri shapefile', 'application/vnd.shp', 'Shapefile', (r, u8) => {
  const dv = view(u8);
  put(r, 'Map', 'Shape type', { 1: 'Point', 3: 'Line', 5: 'Polygon', 8: 'Multipoint', 11: 'PointZ', 13: 'LineZ', 15: 'PolygonZ', 21: 'PointM', 23: 'LineM', 25: 'PolygonM' }[dv.getInt32(32, true)]);
  put(r, 'Map', 'Bounding box', [36, 44, 52, 60].map((o) => +dv.getFloat64(o, true).toFixed(5)).join(', '));
  let count = 0;
  for (let p = 100; p + 8 <= u8.length; count++) p += 8 + dv.getInt32(p + 4) * 2;
  put(r, 'Map', 'Features', fmt(count));
  fact(r, 'Features', fmt(count));
});
header('las', 'LiDAR point cloud', 'application/vnd.las', 'LAS', (r, u8) => {
  const dv = view(u8);
  const major = u8[24], minor = u8[25];
  put(r, '3D model', 'Format version', `${major}.${minor}`);
  put(r, '3D model', 'Created with', cstr(u8, 58, 32));
  const legacy = dv.getUint32(107, true);
  const points = minor >= 4 ? Number(dv.getBigUint64(247, true)) : legacy;
  put(r, '3D model', 'Points', fmt(points));
  fact(r, 'Points', fmt(points));
});

/* ---------- CAD, 3D, AI models ---------- */
header('fbx', '3D model (FBX)', 'application/vnd.autodesk.fbx', 'FBX', (r, u8) => { put(r, '3D model', 'Format version', view(u8).getUint32(23, true)); });
header('3ds', '3D model (3DS)', 'application/x-3ds', '3DS');
header('e57', 'Point cloud (E57)', 'model/e57', 'E57');
header('blend', 'Blender file', 'application/x-blender', 'Blender', (r, u8) => {
  const code = ascii(u8, 9, 3);
  put(r, '3D model', 'Created with', `Blender ${code[0]}.${code.slice(1)}`);
  put(r, '3D model', 'Pointer size', u8[7] === 0x2d ? '64 bit' : '32 bit');
});
header('gguf', 'AI model (GGUF)', 'application/x-gguf', 'GGUF', (r, u8) => {
  const dv = view(u8);
  put(r, 'AI model', 'Format version', dv.getUint32(4, true));
  const tensors = Number(dv.getBigUint64(8, true)), kvCount = Number(dv.getBigUint64(16, true));
  put(r, 'AI model', 'Tensors', fmt(tensors));
  fact(r, 'Tensors', fmt(tensors));
  let p = 24;
  const str = () => { const n = Number(dv.getBigUint64(p, true)); p += 8; const s = utf8(u8.subarray(p, p + n)); p += n; return s; };
  const SIZE = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
  const value = (type) => {
    if (type === 8) return str();
    if (type === 9) { const it = dv.getUint32(p, true); const n = Number(dv.getBigUint64(p + 4, true)); p += 12; for (let i = 0; i < n; i++) value(it); return `[${fmt(n)}]`; }
    const size = SIZE[type];
    const out = type === 4 ? dv.getUint32(p, true) : type === 5 ? dv.getInt32(p, true) : type === 6 ? dv.getFloat32(p, true) : type === 10 ? Number(dv.getBigUint64(p, true)) : u8[p];
    p += size;
    return out;
  };
  const lines = [];
  for (let i = 0; i < kvCount && i < 400 && p < u8.length; i++) {
    const k = str(); const type = dv.getUint32(p, true); p += 4;
    const v = value(type);
    lines.push(`${k}: ${v}`);
    if (k === 'general.name') { put(r, 'AI model', 'Name', v); r.title = String(v); }
    if (k === 'general.architecture') { put(r, 'AI model', 'Architecture', v); fact(r, 'Architecture', v); }
    if (k === 'general.quantization_version') put(r, 'AI model', 'Quantization version', v);
    if (k === 'general.license') put(r, 'AI model', 'License', v);
  }
  r.sections.push({ title: t('Metadata'), list: lines, open: true });
}, { hex: false });
header('safetensors', 'AI model (safetensors)', 'application/x-safetensors', 'safetensors', (r, u8) => {
  const n = Number(view(u8).getBigUint64(0, true));
  const json = JSON.parse(utf8(u8.subarray(8, 8 + n)));
  const meta = json.__metadata__ || {};
  const names = Object.keys(json).filter((k) => k !== '__metadata__');
  put(r, 'AI model', 'Tensors', fmt(names.length));
  fact(r, 'Tensors', fmt(names.length));
  Object.entries(meta).slice(0, 30).forEach(([k, v]) => put(r, 'AI model', k, String(v).slice(0, 300)));
  r.sections.push({ title: t('Tensors'), list: names.slice(0, 300).map((k) => `${k} · ${json[k].dtype} · [${json[k].shape.join(', ')}]`) });
}, { hex: false });
header('tflite', 'AI model (TensorFlow Lite)', 'application/vnd.tflite', 'TFLite');

/* ---------- Security ---------- */
header('jks', 'Java keystore', 'application/x-java-keystore', 'JKS', (r, u8) => {
  const dv = view(u8);
  put(r, 'Security', 'Format version', dv.getUint32(4));
  put(r, 'Security', 'Entries', dv.getUint32(8));
});
header('kdbx', 'KeePass database', 'application/x-keepass2', 'KDBX', (r, u8) => {
  const dv = view(u8);
  put(r, 'Security', 'Format version', `${dv.getUint16(10, true)}.${dv.getUint16(8, true)}`);
  put(r, 'Security', 'Encrypted', 'Yes');
});
header('pkcs12', 'Certificate store (PKCS#12)', 'application/x-pkcs12', 'PKCS#12', (r) => {
  put(r, 'Security', 'Encrypted', 'Yes');
  r.warnings.push(t('This file usually contains a private key. Do not share it.'));
});
header('sshkey', 'SSH public key', 'text/plain', 'SSH', (r, u8) => {
  const [type, , comment] = U.decodeText(u8).text.trim().split(/\s+/);
  put(r, 'Security', 'Key type', type);
  put(r, 'Security', 'Comment', comment);
}, { hex: false });
header('pgp', 'PGP data', 'application/pgp-encrypted', 'OpenPGP', (r, u8) => {
  const text = U.decodeText(u8).text;
  const m = /-----BEGIN PGP ([A-Z ]+)-----/.exec(text);
  put(r, 'Security', 'Block type', m && m[1]);
  const c = /^Comment:\s*(.+)$/m.exec(text);
  put(r, 'Security', 'Comment', c && c[1]);
}, { hex: false });

/* ---------- Windows and system files ---------- */
const filetime = (dv, o) => {
  const ticks = dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 2 ** 32;
  return ticks ? new Date(ticks / 10000 - 11644473600000) : null;
};
header('lnk', 'Windows shortcut', 'application/x-ms-shortcut', 'LNK', (r, u8) => {
  const dv = view(u8);
  const flags = dv.getUint32(20, true);
  const created = filetime(dv, 28), modified = filetime(dv, 44);
  if (created) put(r, 'Document', 'Created', U.metaDate(created));
  if (modified) put(r, 'Document', 'Modified', U.metaDate(modified));
  put(r, 'Shortcut', 'Target size', U.fmtBytes(dv.getUint32(52, true)));
  let p = 76;
  if (flags & 1) p += 2 + dv.getUint16(p, true);
  if (flags & 2) {
    const size = dv.getUint32(p, true);
    const baseOff = dv.getUint32(p + 16, true);
    if (baseOff) put(r, 'Shortcut', 'Target', cstr(u8, p + baseOff, 260));
    p += size;
  }
  const wide = !!(flags & 0x80);
  const next = () => { const n = dv.getUint16(p, true); p += 2; const bytes = u8.subarray(p, p + (wide ? n * 2 : n)); p += wide ? n * 2 : n; return new TextDecoder(wide ? 'utf-16le' : 'windows-1252').decode(bytes); };
  [[4, 'Description'], [8, 'Relative path'], [0x10, 'Working directory'], [0x20, 'Arguments']].forEach(([bit, label]) => {
    if (flags & bit) put(r, 'Shortcut', label, next());
  });
});
header('regf', 'Windows registry hive', 'application/x-ms-registry', 'Registry', (r, u8) => {
  const dv = view(u8);
  put(r, 'Document', 'Modified', U.metaDate(filetime(dv, 12)));
  put(r, 'Document', 'Format version', `${dv.getUint32(20, true)}.${dv.getUint32(24, true)}`);
  put(r, 'Document', 'Name', new TextDecoder('utf-16le').decode(u8.subarray(48, 112)).replace(/\0.*$/s, ''));
});
header('evtx', 'Windows event log', 'application/x-ms-evtx', 'EVTX', (r, u8) => {
  const dv = view(u8);
  put(r, 'Document', 'Format version', `${dv.getUint16(38, true)}.${dv.getUint16(36, true)}`);
  put(r, 'Document', 'Records', fmt(Number(dv.getBigUint64(24, true))));
});
header('pst', 'Outlook data file', 'application/vnd.ms-outlook-pst', 'PST');
header('chm', 'Windows help file', 'application/vnd.ms-htmlhelp', 'CHM', (r, u8) => {
  const dv = view(u8);
  put(r, 'Document', 'Format version', dv.getUint32(4, true));
  put(r, 'Document', 'Language ID', `0x${dv.getUint32(20, true).toString(16)}`);
}, { strings: true });
header('onenote', 'OneNote notebook', 'application/onenote', 'OneNote');
header('wpd', 'WordPerfect document', 'application/vnd.wordperfect', 'WordPerfect', (r, u8) => { put(r, 'Document', 'Format version', `${u8[10]}.${u8[11]}`); }, { strings: true });
header('dvi', 'TeX output (DVI)', 'application/x-dvi', 'DVI', (r, u8) => { put(r, 'Document', 'Comment', ascii(u8, 15, u8[14])); }, { strings: true });
header('nes', 'NES game ROM', 'application/x-nes-rom', 'iNES', (r, u8) => { put(r, 'Executable', 'Program size', U.fmtBytes(u8[4] * 16384)); put(r, 'Executable', 'Graphics size', U.fmtBytes(u8[5] * 8192)); });
header('wad', 'Doom WAD', 'application/x-doom-wad', 'WAD', (r, u8) => { put(r, 'Archive', 'Entries', view(u8).getUint32(4, true)); });
header('lua', 'Compiled Lua', 'application/x-lua-bytecode', 'Lua', (r, u8) => { put(r, 'Executable', 'Lua version', `${u8[4] >> 4}.${u8[4] & 15}`); }, { strings: true });
header('eot', 'Web font (EOT)', 'application/vnd.ms-fontobject', 'EOT', (r, u8) => {
  const dv = view(u8);
  let p = 80;
  const next = () => { p += 2; const n = dv.getUint16(p, true); p += 2; const s = new TextDecoder('utf-16le').decode(u8.subarray(p, p + n)); p += n; return s; };
  const family = next(), style = next(), version = next(), full = next();
  put(r, 'Font', 'Family', family); put(r, 'Font', 'Subfamily', style); put(r, 'Font', 'Version', version); put(r, 'Font', 'Full name', full);
  r.title = full || family;
});
header('pfb', 'PostScript font', 'application/x-font-type1', 'Type 1', (r, u8) => {
  const s = ascii(u8, 0, 4096);
  const field = (k) => { const m = new RegExp(`/${k}\\s*\\(([^)]*)\\)`).exec(s) || new RegExp(`/${k}\\s*/(\\S+)`).exec(s); return m ? m[1] : ''; };
  put(r, 'Font', 'Family', field('FamilyName')); put(r, 'Font', 'Full name', field('FullName'));
  put(r, 'Font', 'PostScript name', field('FontName')); put(r, 'Font', 'Copyright', field('Notice'));
  r.title = field('FullName');
});
header('torrent', 'BitTorrent file', 'application/x-bittorrent', 'Bencode', (r, u8) => {
  let p = 0;
  const dec = (depth = 0) => {
    const c = u8[p];
    if (c === 0x69) { const e = u8.indexOf(0x65, p); const v = Number(ascii(u8, p + 1, e - p - 1)); p = e + 1; return v; }
    if (c === 0x6c) { p++; const a = []; while (u8[p] !== 0x65 && p < u8.length) a.push(dec(depth + 1)); p++; return a; }
    if (c === 0x64) { p++; const o = {}; while (u8[p] !== 0x65 && p < u8.length) { const k = utf8(dec(depth + 1)); o[k] = dec(depth + 1); } p++; return o; }
    const colon = u8.indexOf(0x3a, p); const n = Number(ascii(u8, p, colon - p)); const b = u8.subarray(colon + 1, colon + 1 + n); p = colon + 1 + n; return b;
  };
  const d = dec();
  const text = (v) => (v instanceof Uint8Array ? utf8(v) : v);
  const info = d.info || {};
  const name = text(info.name);
  put(r, 'Torrent', 'Name', name);
  r.title = name || '';
  put(r, 'Torrent', 'Tracker', text(d.announce));
  put(r, 'Torrent', 'Comment', text(d.comment));
  put(r, 'Application', 'Creator', text(d['created by']));
  if (d['creation date']) put(r, 'Document', 'Created', U.metaDate(new Date(d['creation date'] * 1000)));
  put(r, 'Torrent', 'Piece size', U.fmtBytes(info['piece length'] || 0));
  const files = info.files ? info.files.map((f) => ({ name: f.path.map(text).join('/'), size: f.length })) : [{ name, size: info.length || 0 }];
  const total = files.reduce((n, f) => n + f.size, 0);
  put(r, 'Torrent', 'Total size', U.fmtBytes(total));
  put(r, 'Torrent', 'Files', fmt(files.length));
  fact(r, 'Files', fmt(files.length));
  fact(r, 'Total size', U.fmtBytes(total));
  r.sections.push({ title: t('Files'), list: files.slice(0, 500).map((f) => `${f.name} · ${U.fmtBytes(f.size)}`), open: true });
}, { hex: false });

/* ---------- Text formats ---------- */
function textFlavor(key, kind, mime, parser, read) {
  reg(key, async (u8, name, det, ...rest) => {
    const r = await E.handler('text')(u8, name, { key: 'text' }, ...rest);
    try { read?.(r, r.text); } catch (e) { /* plain text still works */ }
    r.noSummary = true;
    return r;
  }, kind, mime, parser);
}
const lines = (text) => text.split(/\r?\n/);
textFlavor('diff', 'Patch file', 'text/x-diff', 'Unified diff', (r, text) => {
  const files = text.match(/^(?:\+\+\+|diff --git) .*$/gm) || [];
  const names = [...new Set(files.map((f) => f.replace(/^(\+\+\+ |diff --git )(a\/|b\/)?/, '').split(/\s/)[0]))];
  const added = (text.match(/^\+(?!\+\+)/gm) || []).length, removed = (text.match(/^-(?!--)/gm) || []).length;
  put(r, 'Patch', 'Files changed', names.length); put(r, 'Patch', 'Lines added', fmt(added)); put(r, 'Patch', 'Lines removed', fmt(removed));
  fact(r, 'Files changed', names.length); fact(r, 'Lines added', fmt(added)); fact(r, 'Lines removed', fmt(removed));
  if (names.length) r.sections.push({ title: t('Files'), list: names.slice(0, 300), open: true });
});
textFlavor('logfile', 'Log file', 'text/x-log', 'Log', (r, text) => {
  const levels = {};
  for (const m of text.matchAll(/\b(FATAL|ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/g)) {
    const k = m[1] === 'WARNING' ? 'WARN' : m[1];
    levels[k] = (levels[k] || 0) + 1;
  }
  Object.entries(levels).forEach(([k, v]) => put(r, 'Log', k, fmt(v)));
  if (levels.ERROR) fact(r, 'ERROR', fmt(levels.ERROR));
  const stamps = text.match(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/g);
  if (stamps) { put(r, 'Log', 'First entry', stamps[0]); put(r, 'Log', 'Last entry', stamps[stamps.length - 1]); }
});
textFlavor('bibtex', 'Bibliography (BibTeX)', 'application/x-bibtex', 'BibTeX', (r, text) => {
  const entries = text.match(/^\s*@(\w+)\s*\{/gm) || [];
  const byType = {};
  entries.forEach((e) => { const k = e.replace(/[@{\s]/g, '').toLowerCase(); byType[k] = (byType[k] || 0) + 1; });
  put(r, 'Bibliography', 'Entries', entries.length); fact(r, 'Entries', entries.length);
  Object.entries(byType).forEach(([k, v]) => put(r, 'Bibliography', k, v));
  const titles = [...text.matchAll(/\btitle\s*=\s*[{"]+([^}"]+)/gi)].map((m) => m[1]);
  if (titles.length) r.sections.push({ title: t('Titles'), list: titles.slice(0, 300), open: true });
});
textFlavor('ass', 'Subtitles (ASS)', 'text/x-ssa', 'ASS', (r, text) => {
  const m = /^Title:\s*(.+)$/m.exec(text);
  if (m) { put(r, 'Subtitles', 'Title', m[1]); r.title = m[1]; }
  const cues = (text.match(/^Dialogue:/gm) || []).length;
  put(r, 'Subtitles', 'Cues', fmt(cues)); fact(r, 'Cues', fmt(cues));
  r.text = lines(text).filter((l) => l.startsWith('Dialogue:')).map((l) => l.split(',').slice(9).join(',').replace(/\{[^}]*\}/g, '').replace(/\\N/g, '\n')).join('\n');
});
textFlavor('lrc', 'Song lyrics (LRC)', 'text/x-lrc', 'LRC', (r, text) => {
  [['ti', 'Title'], ['ar', 'Artist'], ['al', 'Album']].forEach(([k, label]) => { const m = new RegExp(`^\\[${k}:([^\\]]*)\\]`, 'm').exec(text); if (m) put(r, 'Tags', label, m[1]); });
  r.text = text.replace(/^\[[^\]]*\]/gm, '').trim();
});
textFlavor('playlist', 'Playlist', 'audio/x-mpegurl', 'M3U/PLS', (r, text) => {
  const entries = lines(text).map((l) => l.trim()).filter((l) => l && (!l.startsWith('#')) && !/^\[|^(NumberOfEntries|Version|Title\d|Length\d)=/i.test(l)).map((l) => l.replace(/^File\d+=/i, ''));
  put(r, 'Playlist', 'Entries', entries.length); fact(r, 'Entries', entries.length);
  if (/#EXT-X-/.test(text)) put(r, 'Playlist', 'Format version', 'HLS');
  if (entries.length) r.sections.push({ title: t('Entries'), list: entries.slice(0, 500), open: true });
});
textFlavor('gedcom', 'Family tree (GEDCOM)', 'application/x-gedcom', 'GEDCOM', (r, text) => {
  const count = (re) => (text.match(re) || []).length;
  put(r, 'Family tree', 'People', fmt(count(/^0 @[^@]+@ INDI/gm))); put(r, 'Family tree', 'Families', fmt(count(/^0 @[^@]+@ FAM/gm)));
  fact(r, 'People', fmt(count(/^0 @[^@]+@ INDI/gm)));
});
textFlavor('sqldump', 'SQL script', 'application/sql', 'SQL', (r, text) => {
  const tables = [...text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([\w.]+)/gi)].map((m) => m[1]);
  put(r, 'Database', 'Tables', tables.length); put(r, 'Database', 'Inserts', fmt((text.match(/\bINSERT\s+INTO\b/gi) || []).length));
  fact(r, 'Tables', tables.length);
  if (tables.length) r.sections.push({ title: t('Tables'), list: tables.slice(0, 300), open: true });
});
textFlavor('dxf', 'AutoCAD exchange file', 'image/vnd.dxf', 'DXF', (r, text) => {
  const v = /\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*(\S+)/.exec(text);
  put(r, 'Document', 'AutoCAD version', v && v[1]);
  const layers = (text.match(/^\s*0\s*\r?\n\s*LAYER\s*$/gm) || []).length;
  put(r, 'Structure', 'Layers', layers);
  fact(r, 'Layers', layers);
  r.text = '';
});
textFlavor('step', 'CAD model (STEP)', 'model/step', 'STEP', (r, text) => {
  const name = /FILE_NAME\s*\(\s*'([^']*)'\s*,\s*'([^']*)'/.exec(text);
  if (name) { put(r, 'Document', 'Title', name[1]); put(r, 'Document', 'Created', name[2]); }
  const schema = /FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'/.exec(text);
  put(r, 'Document', 'Schema', schema && schema[1]);
  const entities = (text.match(/^#\d+\s*=/gm) || []).length;
  put(r, 'Structure', 'Entities', fmt(entities));
  fact(r, 'Entities', fmt(entities));
  r.text = '';
});
textFlavor('obj3d', '3D model (OBJ)', 'model/obj', 'Wavefront OBJ', (r, text) => {
  const count = (re) => (text.match(re) || []).length;
  put(r, '3D model', 'Vertices', fmt(count(/^v\s/gm))); put(r, '3D model', 'Faces', fmt(count(/^f\s/gm))); put(r, '3D model', 'Objects', count(/^o\s/gm) || '');
  fact(r, 'Vertices', fmt(count(/^v\s/gm))); fact(r, 'Faces', fmt(count(/^f\s/gm)));
  r.text = '';
});
reg('ply', async (u8) => {
  const r = newResult();
  const head = ascii(u8, 0, Math.min(u8.length, 8192));
  const end = head.indexOf('end_header');
  const lns = head.slice(0, end > 0 ? end : undefined).split(/\r?\n/);
  const f = lns.find((l) => l.startsWith('format'));
  put(r, '3D model', 'Encoding', f && f.split(' ')[1]);
  lns.filter((l) => l.startsWith('element')).forEach((l) => { const [, name, n] = l.split(' '); put(r, '3D model', name[0].toUpperCase() + name.slice(1), fmt(+n)); fact(r, name[0].toUpperCase() + name.slice(1), fmt(+n)); });
  const c = lns.filter((l) => l.startsWith('comment')).map((l) => l.slice(8));
  if (c.length) put(r, '3D model', 'Comment', c.join(' | '));
  r.noText = true; r.noSummary = true;
  return r;
}, '3D model (PLY)', 'model/ply', 'PLY');
header('iges', 'CAD model (IGES)', 'model/iges', 'IGES');

/* ---------- XML flavors ---------- */
const XML = E.xmlFlavors;
const tagCount = (doc, n) => U.tags(doc, n).length;
XML.gpx = (r, root, doc) => {
  r.kind = 'GPS track (GPX)';
  put(r, 'Map', 'Created with', root.getAttribute('creator'));
  put(r, 'Map', 'Tracks', tagCount(doc, 'trk')); put(r, 'Map', 'Track points', fmt(tagCount(doc, 'trkpt'))); put(r, 'Map', 'Waypoints', tagCount(doc, 'wpt')); put(r, 'Map', 'Routes', tagCount(doc, 'rte'));
  const name = U.firstText(root, 'name');
  if (name) { put(r, 'Document', 'Title', name); r.title = name; }
  fact(r, 'Track points', fmt(tagCount(doc, 'trkpt')));
};
XML.kml = (r, root, doc) => {
  r.kind = 'Google Earth file';
  put(r, 'Map', 'Placemarks', tagCount(doc, 'Placemark'));
  fact(r, 'Placemarks', tagCount(doc, 'Placemark'));
  const name = U.firstText(root, 'name');
  if (name) { put(r, 'Document', 'Title', name); r.title = name; }
};
XML.plist = (r, root) => {
  r.kind = 'Apple property list';
  const dict = U.children(root, 'dict')[0];
  if (!dict) return;
  const kids = U.children(dict);
  for (let i = 0; i + 1 < kids.length && i < 200; i += 2) {
    const v = kids[i + 1];
    if (!['dict', 'array'].includes(v.localName)) put(r, 'Property list', kids[i].textContent, v.localName === 'true' || v.localName === 'false' ? v.localName : v.textContent.slice(0, 500));
  }
};
XML.opml = (r, root, doc) => { r.kind = 'Outline (OPML)'; put(r, 'Document', 'Title', U.firstText(root, 'title')); put(r, 'Structure', 'Entries', tagCount(doc, 'outline')); fact(r, 'Entries', tagCount(doc, 'outline')); };
XML.urlset = (r, root, doc) => { r.kind = 'XML sitemap'; put(r, 'Structure', 'URLs', fmt(tagCount(doc, 'url'))); fact(r, 'URLs', fmt(tagCount(doc, 'url'))); r.sections.unshift({ title: t('URLs'), list: U.tags(doc, 'loc').slice(0, 500).map((n) => n.textContent.trim()), open: true }); };
XML.sitemapindex = XML.urlset;
XML.xliff = (r, root, doc) => { r.kind = 'Translation file (XLIFF)'; put(r, 'Translation', 'Segments', fmt(tagCount(doc, 'trans-unit') || tagCount(doc, 'unit'))); const f = U.first(root, 'file'); put(r, 'Translation', 'Source language', root.getAttribute('srcLang') || f?.getAttribute('source-language')); put(r, 'Translation', 'Target language', root.getAttribute('trgLang') || f?.getAttribute('target-language')); };
XML.COLLADA = (r, root, doc) => { r.kind = '3D model (COLLADA)'; put(r, '3D model', 'Created with', U.firstText(root, 'authoring_tool')); put(r, '3D model', 'Meshes', tagCount(doc, 'geometry')); };
XML.schema = (r) => { r.kind = 'XML schema'; };
XML.stylesheet = (r, root) => { r.kind = 'XSLT stylesheet'; put(r, 'Document', 'Format version', root.getAttribute('version')); };
XML.transform = XML.stylesheet;
XML.definitions = (r, root, doc) => { if (U.tags(doc, 'portType').length || U.tags(doc, 'service').length) { r.kind = 'Web service description (WSDL)'; put(r, 'Structure', 'Operations', tagCount(doc, 'operation')); } };
XML.project = (r, root) => {
  const g = (n) => U.children(root, n)[0]?.textContent.trim();
  if (g('artifactId')) { r.kind = 'Maven project'; put(r, 'Document', 'Title', g('artifactId')); put(r, 'Project', 'Group', g('groupId')); put(r, 'Document', 'Version', g('version')); put(r, 'Project', 'Dependencies', U.tags(root, 'dependency').length); } else if (root.getAttribute('Sdk') || U.tags(root, 'PropertyGroup').length) { r.kind = '.NET project'; put(r, 'Project', 'SDK', root.getAttribute('Sdk')); put(r, 'Project', 'Target framework', U.firstText(root, 'TargetFramework')); }
};
XML.TEI = (r, root) => { r.kind = 'Scholarly text (TEI)'; put(r, 'Document', 'Title', U.firstText(root, 'title')); };

/* ---------- JSON flavors ---------- */
E.jsonFlavors.push((r, v, name) => {
  const base = name.split('/').pop().toLowerCase();
  if (v.log && Array.isArray(v.log.entries)) {
    r.kind = 'Browser network log (HAR)';
    put(r, 'Network capture', 'Requests', fmt(v.log.entries.length)); fact(r, 'Requests', fmt(v.log.entries.length));
    put(r, 'Application', 'Creator', v.log.creator && `${v.log.creator.name} ${v.log.creator.version}`);
    const hosts = {};
    v.log.entries.forEach((e) => { try { const h = new URL(e.request.url).host; hosts[h] = (hosts[h] || 0) + 1; } catch (x) { /* odd URL */ } });
    r.sections.unshift({ title: t('Hosts'), list: Object.entries(hosts).sort((a, b) => b[1] - a[1]).slice(0, 100).map(([h, n]) => `${h} · ${n}`), open: true });
    r.warnings.push(t('Network logs can contain passwords and session cookies. Check before sharing.'));
  } else if (base === 'package.json' && v.name) {
    r.kind = 'npm package manifest';
    put(r, 'Project', 'Name', v.name); put(r, 'Document', 'Version', v.version); put(r, 'Document', 'Description', v.description); put(r, 'Font', 'License', v.license);
    put(r, 'Project', 'Dependencies', Object.keys(v.dependencies || {}).length); put(r, 'Project', 'Dev dependencies', Object.keys(v.devDependencies || {}).length);
    r.title = v.name;
  } else if (v.openapi || v.swagger) {
    r.kind = 'API description (OpenAPI)';
    put(r, 'Document', 'Title', v.info?.title); put(r, 'Document', 'Version', v.info?.version); put(r, 'Project', 'Endpoints', Object.keys(v.paths || {}).length);
    r.title = v.info?.title || '';
  } else if (v.asset && (v.scenes || v.meshes)) {
    r.kind = '3D model (glTF)';
    put(r, '3D model', 'glTF version', v.asset.version); put(r, '3D model', 'Created with', v.asset.generator); put(r, '3D model', 'Meshes', (v.meshes || []).length);
  } else if (base.endsWith('.webmanifest') || base === 'manifest.json') {
    r.kind = v.manifest_version ? 'Browser extension manifest' : 'Web app manifest';
    put(r, 'Project', 'Name', v.name); put(r, 'Document', 'Version', v.version);
  }
});

/* ---------- ZIP-based containers ---------- */
const baseZip = E.handler('zip');
reg('zip', async (u8, name, det, ...rest) => {
  const r = await baseZip(u8, name, det, ...rest);
  const zip = det.zip;
  if (!zip) return r;
  const has = (n) => zip.has(n);
  const list = zip.entries.map((e) => e.name);
  const some = (re) => list.some((n) => re.test(n));
  const count = (re) => list.filter((n) => re.test(n)).length;
  const ext = U.extOf(name);
  const xmlText = async (n) => { try { return U.xml(await zip.text(n)); } catch (e) { return null; } };
  try {
    if (some(/^Index\/Document\.iwa$/) || has('index.apxl') || has('index.xml') && /^(pages|numbers|key)$/.test(ext)) {
      r.kind = { pages: 'Apple Pages document', numbers: 'Apple Numbers spreadsheet', key: 'Apple Keynote presentation' }[ext] || 'Apple iWork document';
      put(r, 'Document', 'Internal slides or sheets', count(/^Index\/(Slide|Tables?\/).*\.iwa$/));
      const preview = list.find((n) => /^(preview|QuickLook\/Thumbnail)\.(jpg|png)$/i.test(n));
      if (preview) {
        const b = await zip.bytes(preview);
        r.preview = { type: 'image', url: URL.createObjectURL(new Blob([b], { type: preview.endsWith('png') ? 'image/png' : 'image/jpeg' })) };
      }
      r.warnings.push(t('The text of this format is stored in a compressed Apple format, so only its properties and preview are shown here.'));
    } else if (has('visio/document.xml')) {
      r.kind = 'Visio drawing'; r.mime = 'application/vnd.ms-visio.drawing';
      await E.helpers.ooxmlCore(r, zip);
      put(r, 'Structure', 'Pages', count(/^visio\/pages\/page\d+\.xml$/));
      fact(r, 'Pages', count(/^visio\/pages\/page\d+\.xml$/));
    } else if (some(/^(FixedDocumentSequence\.fdseq|FixedDocSeq\.fdseq|Documents\/1\/FixedDocument\.fdoc)$/) || some(/\.fpage$/)) {
      r.kind = 'XPS document'; r.mime = 'application/vnd.ms-xpsdocument';
      await E.helpers.ooxmlCore(r, zip);
      const pages = list.filter((n) => /\.fpage$/.test(n));
      put(r, 'Document', 'Pages', pages.length); fact(r, 'Pages', pages.length);
      const parts = [];
      for (const n of pages.slice(0, 200)) {
        const d = await xmlText(n);
        if (d) parts.push(U.tags(d, 'Glyphs').map((g) => g.getAttribute('UnicodeString') || '').join(' '));
      }
      r.text = parts.join('\n\n'); r.noText = !r.text; r.summaryText = r.text;
    } else if (has('AppxManifest.xml')) {
      r.kind = 'Windows app package';
      const d = await xmlText('AppxManifest.xml');
      const id = d && U.first(d, 'Identity');
      if (id) { put(r, 'Project', 'Name', id.getAttribute('Name')); put(r, 'Document', 'Version', id.getAttribute('Version')); put(r, 'Application', 'Company', id.getAttribute('Publisher')); }
    } else if (ext === 'nupkg' || some(/\.nuspec$/)) {
      const n = list.find((x) => /\.nuspec$/.test(x));
      const d = n && await xmlText(n);
      r.kind = 'NuGet package';
      if (d) { put(r, 'Project', 'Name', U.firstText(d, 'id')); put(r, 'Document', 'Version', U.firstText(d, 'version')); put(r, 'Document', 'Author', U.firstText(d, 'authors')); put(r, 'Document', 'Description', U.firstText(d, 'description')); }
    } else if (has('manifest.json') && (ext === 'xpi' || ext === 'crx')) {
      r.kind = 'Browser extension';
      const m = JSON.parse(await zip.text('manifest.json'));
      put(r, 'Project', 'Name', m.name); put(r, 'Document', 'Version', m.version); put(r, 'Document', 'Description', m.description);
      r.title = m.name || '';
    } else if (some(/\.dist-info\/METADATA$/)) {
      r.kind = 'Python wheel';
      const meta = await zip.text(list.find((x) => /\.dist-info\/METADATA$/.test(x)));
      [['Name', 'Name'], ['Version', 'Version'], ['Summary', 'Description'], ['Author', 'Author'], ['License', 'License']].forEach(([k, label]) => { const m = new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(meta); if (m) put(r, 'Project', label, m[1]); });
    } else if (has('AndroidManifest.xml')) {
      r.kind = 'Android app';
      put(r, 'Executable', 'DEX files', count(/^classes\d*\.dex$/));
      put(r, 'Executable', 'Native libraries', count(/^lib\/.*\.so$/));
      put(r, 'Executable', 'Digitally signed', some(/^META-INF\/.*\.(RSA|DSA|EC)$/) ? 'Yes' : '');
    } else if (some(/^Payload\/[^/]+\.app\/Info\.plist$/)) {
      r.kind = 'iOS app';
    } else if (has('3D/3dmodel.model')) {
      r.kind = '3D print file (3MF)'; r.mime = 'model/3mf';
      const d = await xmlText('3D/3dmodel.model');
      if (d) { put(r, '3D model', 'Objects', tagCount(d, 'object')); put(r, '3D model', 'Vertices', fmt(tagCount(d, 'vertex'))); put(r, '3D model', 'Triangles', fmt(tagCount(d, 'triangle'))); }
    } else if (ext === 'usdz') {
      r.kind = '3D model (USDZ)';
    } else if (has('mimetype') && /image\/openraster/.test(await zip.text('mimetype'))) {
      r.kind = 'OpenRaster image';
    } else if (has('meta.json') && ext === 'sketch') {
      r.kind = 'Sketch document';
    } else if (ext === 'cbr' || ext === 'cbz') {
      put(r, 'Book', 'Pages', count(/\.(jpe?g|png|webp|gif)$/i));
      fact(r, 'Pages', count(/\.(jpe?g|png|webp|gif)$/i));
    }
  } catch (e) { /* the archive listing still stands */ }
  return r;
});

/* ---------- OLE2 subtypes, by content ---------- */
const baseOle = E.handler('ole');
const OLE_KIND = { vsd: 'Visio drawing', msi: 'Windows installer', mpp: 'Microsoft Project plan', pub: 'Publisher document', hwp: 'Hangul document', one: 'OneNote notebook', sldprt: 'SolidWorks part', sldasm: 'SolidWorks assembly', max: '3ds Max scene', thumbs: 'Windows thumbnail cache', db: 'Windows thumbnail cache' };
reg('ole', async (u8, name, ...rest) => {
  const r = await baseOle(u8, name, ...rest);
  if (r.kind === 'Compound document (OLE2)' && OLE_KIND[U.extOf(name)]) r.kind = OLE_KIND[U.extOf(name)];
  return r;
});

/* ---------- Detection ---------- */
E.addDetector((u8, name, ext) => {
  const a = (o, l) => ascii(u8, o, l);
  const h4 = a(0, 4);
  const b = (...v) => v.every((x, i) => u8[i] === x);
  // Images
  if (h4 === 'icns') return 'icns';
  if (a(4, 8) === 'jP  \r\n\x87\n' || b(0xff, 0x4f, 0xff, 0x51)) return 'jp2';
  if (a(4, 8) === 'JXL \r\n\x87\n' || (b(0xff, 0x0a) && ext === 'jxl')) return 'jxl';
  if (b(0x76, 0x2f, 0x31, 0x01)) return 'exr';
  if (b(0x0a) && u8[2] === 1 && ext === 'pcx') return 'pcx';
  if (a(0, 9) === 'gimp xcf ') return 'xcf';
  if (h4 === 'DDS ') return 'dds';
  if (h4 === 'qoif') return 'qoi';
  if (a(0, 10) === '#?RADIANCE' || a(0, 6) === '#?RGBE') return 'hdr';
  if (h4 === 'SDPX' || h4 === 'XPDS') return 'dpx';
  if (b(0x42, 0x50, 0x47, 0xfb)) return 'bpg';
  if (b(0xd7, 0xcd, 0xc6, 0x9a) || (b(1, 0, 9, 0) && ext === 'wmf')) return 'wmf';
  if (a(40, 4) === ' EMF') return 'emf';
  if (a(0, 9) === 'SIMPLE  =') return 'fits';
  if (a(0, 8) === 'AT&TFORM') return 'djvu';
  if (ext === 'xbm' && /_width/.test(a(0, 256))) return 'xbm';
  if (a(0, 9) === '/* XPM */') return 'xpm';
  if (RAW_EXT[ext] && (/^(II\*\0|MM\0\*|IIRO|IIRS|MMOR|IIU\0)$/.test(h4))) return 'rawphoto';
  if (a(0, 15) === 'FUJIFILMCCD-RAW') return 'raf';
  if (a(4, 8) === 'ftypcrx ') return 'cr3';
  // Audio
  if (b(0xff) && (u8[1] & 0xf6) === 0xf0 && (ext === 'aac' || ext === 'adts')) return 'aac';
  if (b(0x0b, 0x77)) return 'ac3';
  if (a(0, 5) === '#!AMR') return 'amr';
  if (h4 === '.snd') return 'au';
  if (h4 === 'caff') return 'caf';
  if (h4 === 'MAC ') return 'ape';
  if (h4 === 'wvpk') return 'wavpack';
  if (h4 === 'MPCK' || a(0, 3) === 'MP+') return 'mpc';
  if (h4 === 'DSD ') return 'dsf';
  if (h4 === 'TTA1') return 'tta';
  if (u8.length > 1084 && /^(M\.K\.|M!K!|FLT4|4CHN|6CHN|8CHN)$/.test(a(1080, 4))) return 'mod';
  if (u8.length > 48 && a(44, 4) === 'SCRM') return 's3m';
  if (a(0, 17) === 'Extended Module: ') return 'xm';
  if (h4 === 'IMPM') return 'it';
  if (h4 === 'PSID' || h4 === 'RSID') return 'sid';
  // Video
  if (/^[FCZ]WS$/.test(a(0, 3)) && u8[3] < 60) return 'swf';
  if (h4 === 'DKIF') return 'ivf';
  if (a(0, 9) === 'YUV4MPEG2') return 'y4m';
  if (h4 === '.RMF') return 'rm';
  if (b(0x06, 0x0e, 0x2b, 0x34)) return 'mxf';
  // Archives and disks
  if (b(0x04, 0x22, 0x4d, 0x18)) return 'lz4';
  if (h4 === 'LZIP') return 'lzip';
  if (ext === 'lzma' && u8[0] === 0x5d) return 'lzma';
  if (b(0x1f, 0x9d)) return 'compress';
  if (b(0x60, 0xea)) return 'arj';
  if (/^-l[hz][0-9a-z]-$/.test(a(2, 5))) return 'lzh';
  if (a(0, 3) === 'ZOO') return 'zoo';
  if (a(7, 7) === '**ACE**') return 'ace';
  if (h4 === 'SIT!' || a(0, 7) === 'StuffIt') return 'sit';
  if (h4 === 'xar!') return 'xar';
  if (a(0, 8) === 'MSWIM\0\0\0') return 'wim';
  if (h4 === 'hsqs') return 'squashfs';
  if (u8.length > 512 && (a(u8.length - 512, 4) === 'koly' || ext === 'dmg')) return 'dmg';
  if (u8.length > 512 && (a(u8.length - 512, 8) === 'conectix' || a(0, 8) === 'conectix')) return 'vhd';
  if (h4 === 'KDMV' || a(0, 18) === '# Disk DescriptorF') return 'vmdk';
  if (b(0x51, 0x46, 0x49, 0xfb)) return 'qcow';
  if (u8.length > 72 && b(0x3c) && view(u8).getUint32(64, true) === 0xbeda107f) return 'vdi';
  if (h4 === 'PACK' && view(u8).getUint32(4) <= 4) return 'gitpack';
  // Data and science
  if (/^\xd4\xc3\xb2\xa1|^\xa1\xb2\xc3\xd4|^\x4d\x3c\xb2\xa1|^\xa1\xb2\x3c\x4d/.test(a(0, 4))) return 'pcap';
  if (b(0x0a, 0x0d, 0x0d, 0x0a)) return 'pcapng';
  if (a(1, 7) === 'HDF\r\n\x1a\n' && u8[0] === 0x89) return 'hdf5';
  if (a(0, 3) === 'CDF' && [1, 2, 5].includes(u8[3])) return 'netcdf';
  if (h4 === 'Obj\x01') return 'avro';
  if (a(0, 3) === 'ORC') return 'orc';
  if (a(0, 6) === 'ARROW1') return 'arrow';
  if (b(0xd9, 0xd9, 0xf7)) return 'cbor';
  if (a(0, 10) === 'MATLAB 5.0') return 'mat';
  if (h4 === '$FL2' || h4 === '$FL3') return 'spss';
  if (a(4, 15) === 'Standard Jet DB' || a(4, 15) === 'Standard ACE DB') return 'access';
  if (b(0, 0, 0x27, 0x0a)) return 'shp';
  if (h4 === 'LASF') return 'las';
  // CAD, 3D, AI
  if (a(0, 18) === 'Kaydara FBX Binary') return 'fbx';
  if (b(0x4d, 0x4d) && ext === '3ds') return '3ds';
  if (a(0, 8) === 'ASTM-E57') return 'e57';
  if (a(0, 7) === 'BLENDER') return 'blend';
  if (h4 === 'GGUF') return 'gguf';
  if (u8[8] === 0x7b && u8[9] === 0x22 && view(u8).getUint32(4, true) === 0 && view(u8).getUint32(0, true) < u8.length) return 'safetensors';
  if (a(4, 4) === 'TFL3') return 'tflite';
  if (a(0, 12) === 'ISO-10303-21') return 'step';
  if (ext === 'igs' || ext === 'iges') return 'iges';
  if (a(0, 4) === 'ply\n' || a(0, 5) === 'ply\r\n') return 'ply';
  if (ext === 'obj' && /^(#|v |o |g |mtllib)/m.test(a(0, 512))) return 'obj3d';
  if (ext === 'dxf' || /^\s*0\s*\r?\n\s*SECTION/.test(a(0, 64))) return 'dxf';
  // Security and system
  if (b(0xfe, 0xed, 0xfe, 0xed)) return 'jks';
  if (b(0x03, 0xd9, 0xa2, 0x9a)) return 'kdbx';
  if ((ext === 'p12' || ext === 'pfx') && u8[0] === 0x30) return 'pkcs12';
  if (/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-\S+) AAAA/.test(a(0, 64))) return 'sshkey';
  if (a(0, 14) === '-----BEGIN PGP') return 'pgp';
  if (b(0x4c, 0, 0, 0, 1, 0x14, 2, 0)) return 'lnk';
  if (h4 === 'regf') return 'regf';
  if (a(0, 7) === 'ElfFile') return 'evtx';
  if (h4 === '!BDN') return 'pst';
  if (h4 === 'ITSF') return 'chm';
  if (b(0xe4, 0x52, 0x5c, 0x7b)) return 'onenote';
  if (b(0xff, 0x57, 0x50, 0x43)) return 'wpd';
  if (b(0xf7, 0x02)) return 'dvi';
  if (a(0, 3) === 'NES' && u8[3] === 0x1a) return 'nes';
  if (h4 === 'IWAD' || h4 === 'PWAD') return 'wad';
  if (b(0x1b, 0x4c, 0x75, 0x61)) return 'lua';
  if (ext === 'eot') return 'eot';
  if (b(0x80, 0x01) && a(6, 2) === '%!' || /^%!(PS-AdobeFont|FontType)/.test(a(0, 20))) return 'pfb';
  if (ext === 'torrent' || a(0, 11) === 'd8:announce') return 'torrent';
  // Text
  if (/^(diff --git |--- \S|Index: )/.test(a(0, 16)) && (/^\+\+\+ /m.test(a(0, 4096)) || ext === 'patch' || ext === 'diff')) return 'diff';
  if (ext === 'log') return 'logfile';
  if (ext === 'bib') return 'bibtex';
  if (ext === 'ass' || ext === 'ssa') return 'ass';
  if (ext === 'lrc') return 'lrc';
  if (ext === 'm3u' || ext === 'm3u8' || ext === 'pls' || a(0, 7) === '#EXTM3U') return 'playlist';
  if (ext === 'ged' || a(0, 6) === '0 HEAD') return 'gedcom';
  if (ext === 'sql') return 'sqldump';
  return null;
});
