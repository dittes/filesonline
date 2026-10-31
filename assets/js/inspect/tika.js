// tika.js
// Standard field names and output formats modelled on Apache Tika, so results from here
// can feed the same pipelines: recursive JSON (-J), XHTML (-x), plain text (-t).

import U from './util.js';

const FIELD_MAP = {
  'Document|Title': 'dc:title', 'Document|Author': 'dc:creator', 'Document|Subject': 'dc:subject', 'Document|Keywords': 'meta:keyword',
  'Document|Description': 'dc:description', 'Document|Created': 'dcterms:created', 'Document|Modified': 'dcterms:modified',
  'Document|Last modified by': 'meta:last-author', 'Document|Last printed': 'meta:print-date', 'Document|Revision': 'cp:revision',
  'Document|Category': 'cp:category', 'Document|Language': 'dc:language', 'Document|Template': 'extended-properties:Template',
  'Document|Pages': 'xmpTPg:NPages', 'Document|PDF version': 'pdf:PDFVersion', 'Document|PDF/A conformance': 'pdfaid:conformance',
  'Application|Application': 'extended-properties:Application', 'Application|Version': 'extended-properties:AppVersion',
  'Application|Company': 'extended-properties:Company', 'Application|Manager': 'extended-properties:Manager', 'Application|Pages': 'meta:page-count',
  'Application|Slides': 'meta:slide-count', 'Application|Words (reported)': 'meta:word-count', 'Application|Characters': 'meta:character-count',
  'Application|Total editing time (min)': 'extended-properties:TotalTime', 'Application|Creator': 'xmp:CreatorTool', 'Application|Producer': 'pdf:Producer',
  'Security|Encrypted': 'pdf:encrypted', 'Security|JavaScript': 'pdf:containsDamagedFont', 'Security|Digital signature': 'pdf:hasSignature',
  'Structure|Form fields': 'pdf:hasAcroFormFields', 'Structure|XFA form': 'pdf:hasXFA', 'Structure|Tagged (accessible)': 'pdf:hasMarkedContent',
  'Image|Width': 'tiff:ImageWidth', 'Image|Height': 'tiff:ImageLength', 'Image|Bit depth': 'tiff:BitsPerSample',
  'Camera & EXIF|Camera make': 'tiff:Make', 'Camera & EXIF|Camera model': 'tiff:Model', 'Camera & EXIF|Software': 'tiff:Software',
  'Camera & EXIF|Orientation': 'tiff:Orientation', 'Camera & EXIF|Taken': 'exif:DateTimeOriginal', 'Camera & EXIF|Exposure': 'exif:ExposureTime',
  'Camera & EXIF|Aperture': 'exif:FNumber', 'Camera & EXIF|ISO': 'exif:IsoSpeedRatings', 'Camera & EXIF|Focal length': 'exif:FocalLength',
  'Camera & EXIF|Flash fired': 'exif:Flash', 'Camera & EXIF|Artist': 'dc:creator', 'Camera & EXIF|Copyright': 'dc:rights', 'Camera & EXIF|Lens': 'exif:LensModel',
  'Location|Latitude': 'geo:lat', 'Location|Longitude': 'geo:long', 'Location|Altitude': 'geo:alt',
  'Tags|Title': 'dc:title', 'Tags|Artist': 'xmpDM:artist', 'Tags|Album': 'xmpDM:album', 'Tags|Album artist': 'xmpDM:albumArtist', 'Tags|Year': 'xmpDM:releaseDate',
  'Tags|Genre': 'xmpDM:genre', 'Tags|Track': 'xmpDM:trackNumber', 'Tags|Disc': 'xmpDM:discNumber', 'Tags|Composer': 'xmpDM:composer', 'Tags|Comment': 'xmpDM:logComment',
  'Audio|Duration': 'xmpDM:duration', 'Audio|Sample rate': 'xmpDM:audioSampleRate', 'Audio|Channels': 'xmpDM:audioChannelType', 'Audio|Bit depth': 'xmpDM:audioSampleType',
  'Video|Duration': 'xmpDM:duration', 'Email|From': 'Message-From', 'Email|To': 'Message-To', 'Email|Cc': 'Message-Cc', 'Email|Subject': 'dc:subject',
  'Email|Date': 'dcterms:created', 'Email|Message-Id': 'Message:Raw-Header:Message-ID', 'Email|X-Mailer': 'Message:Raw-Header:X-Mailer',
  'Book|Title': 'dc:title', 'Book|Author': 'dc:creator', 'Book|Language': 'dc:language', 'Book|Publisher': 'dc:publisher', 'Book|Published': 'dcterms:created',
  'Book|Identifier': 'dc:identifier', 'Book|Subjects': 'dc:subject', 'Book|Description': 'dc:description', 'Book|Rights': 'dc:rights',
  'Text|Encoding': 'Content-Encoding', 'Font|Family': 'fontFamilyName', 'Font|Full name': 'fontName', 'Font|Subfamily': 'fontSubFamilyName', 'Font|Version': 'fontVersion',
  'Font|PostScript name': 'psName', 'Font|Copyright': 'copyright', 'Font|Designer': 'dc:creator', 'Font|Created': 'dcterms:created', 'Font|Modified': 'dcterms:modified',
  'Executable|Format': 'executable:format', 'Executable|Architecture': 'machine:architectureBits',
};

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Machine-readable value: dates as ISO 8601, sizes and rates without display units. */
function plainValue(name, value) {
  if (value instanceof Date) return U.iso(value);
  const text = String(value);
  if (name === 'exif:DateTimeOriginal') return text.replace(/^(\d{4}):(\d\d):(\d\d) /, '$1-$2-$3T');
  if (/^(tiff:Image|xmpDM:audioSampleRate)/.test(name)) return text.replace(/\s*(px|Hz)$/, '');
  return text;
}

/** Metadata under standard field names. Fields without a standard name keep a readable namespaced one. */
export function tikaFields(item) {
  const r = item.result;
  const out = {
    'Content-Type': r.mime,
    'Content-Length': String(item.file.size),
    resourceName: item.file.name,
    'X-TIKA:Parsed-By': ['files-online', r.parser].filter(Boolean),
  };
  if (item.file.lastModified) out['File:Last-Modified'] = U.iso(new Date(item.file.lastModified));
  if (item.digests) {
    out['X-TIKA:digest:MD5'] = item.digests.md5;
    out['X-TIKA:digest:SHA1'] = item.digests.sha1;
    out['X-TIKA:digest:SHA256'] = item.digests.sha256;
    out['X-TIKA:digest:SHA512'] = item.digests.sha512;
  }
  const lang = item.summary && item.summary.language;
  if (lang && lang.iso) out.language = lang.iso;
  if (item.depth) {
    out['X-TIKA:embedded_depth'] = String(item.depth);
    out['X-TIKA:embedded_resource_path'] = `/${item.path}`;
  }
  for (const [group, fields] of Object.entries(r.meta)) {
    for (const [key, value] of Object.entries(fields)) {
      const name = group === 'XMP' ? key : FIELD_MAP[`${group}|${key}`] || `${slug(group)}:${slug(key)}`;
      const plain = plainValue(name, value);
      if (out[name] === undefined) out[name] = plain;
      else if (Array.isArray(out[name])) { if (!out[name].includes(plain)) out[name].push(plain); }
      else if (out[name] !== plain) out[name] = [out[name], plain];
    }
  }
  return out;
}

/** Tika's --jsonRecursive shape: one object per document, container first. */
export function toJson(items, { content = true } = {}) {
  const list = items.filter((i) => i.result).map((item) => {
    const o = tikaFields(item);
    if (content && item.result.text) o['X-TIKA:content'] = item.result.text;
    return o;
  });
  return JSON.stringify(list, null, 2);
}

const xmlEscape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

/** Tika's --xml output: metadata in the head, paragraphs in the body. */
export function toXhtml(item) {
  const fields = tikaFields(item);
  const metas = Object.entries(fields).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `<meta name="${xmlEscape(k)}" content="${xmlEscape(x)}"/>`));
  const title = item.result.title || item.file.name;
  const body = (item.result.text || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${xmlEscape(p)}</p>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml">\n<head>\n${metas.join('\n')}\n<title>${xmlEscape(title)}</title>\n</head>\n<body>\n${body.join('\n')}\n</body>\n</html>\n`;
}

const csvCell = (v) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per file, one column per field that any file has. */
export function toCsv(items) {
  const rows = items.filter((i) => i.result).map(tikaFields);
  const keys = [];
  rows.forEach((row) => Object.keys(row).forEach((k) => { if (!keys.includes(k)) keys.push(k); }));
  const lines = [keys.map(csvCell).join(',')];
  rows.forEach((row) => lines.push(keys.map((k) => csvCell(Array.isArray(row[k]) ? row[k].join(' | ') : row[k])).join(',')));
  return `${lines.join('\r\n')}\r\n`;
}
