// xmp.js
// Embedded metadata blocks that many formats share: XMP packets, IPTC records and
// ICC colour profiles. Each reader returns plain values and never throws on bad input.

const NS_XMP_NAMES = {
  'http://purl.org/dc/elements/1.1/': 'dc',
  'http://ns.adobe.com/xap/1.0/': 'xmp',
  'http://ns.adobe.com/xap/1.0/mm/': 'xmpMM',
  'http://ns.adobe.com/xap/1.0/rights/': 'xmpRights',
  'http://ns.adobe.com/pdf/1.3/': 'pdf',
  'http://ns.adobe.com/photoshop/1.0/': 'photoshop',
  'http://ns.adobe.com/exif/1.0/': 'exif',
  'http://ns.adobe.com/tiff/1.0/': 'tiff',
  'http://www.aiim.org/pdfa/ns/id/': 'pdfaid',
  'http://www.aiim.org/pdfua/ns/id/': 'pdfuaid',
  'http://ns.adobe.com/lightroom/1.0/': 'lr',
  'http://ns.adobe.com/camera-raw-settings/1.0/': 'crs',
  'http://ns.adobe.com/xmp/1.0/DynamicMedia/': 'xmpDM',
  'http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/': 'Iptc4xmpCore',
};

const decoder = new TextDecoder('utf-8');

/** Find an XMP packet by scanning raw bytes, which works for every format that stores one uncompressed. */
export function findXmpPacket(u8) {
  const open = [0x3c, 0x78, 0x3a, 0x78, 0x6d, 0x70, 0x6d, 0x65, 0x74, 0x61]; // <x:xmpmeta
  const limit = Math.min(u8.length, 64 * 1024 * 1024);
  for (let i = u8.indexOf(0x3c); i >= 0 && i < limit - 32; i = u8.indexOf(0x3c, i + 1)) {
    let hit = true;
    for (let k = 1; k < open.length; k++) if (u8[i + k] !== open[k]) { hit = false; break; }
    if (!hit) continue;
    const text = decoder.decode(u8.subarray(i, Math.min(i + 2 * 1024 * 1024, u8.length)));
    const end = text.indexOf('</x:xmpmeta>');
    return end > 0 ? text.slice(0, end + 12) : null;
  }
  return null;
}

/** Flatten an XMP packet into { 'dc:title': 'value' }. */
export function parseXmp(xml) {
  const out = {};
  if (!xml) return out;
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return out;
  const name = (n) => {
    const prefix = NS_XMP_NAMES[n.namespaceURI] || n.prefix;
    return prefix ? `${prefix}:${n.localName}` : n.localName;
  };
  const add = (key, value) => {
    const v = String(value).trim();
    if (!v) return;
    out[key] = out[key] && !out[key].split(' | ').includes(v) ? `${out[key]} | ${v}` : (out[key] || v);
  };
  const read = (el, key) => {
    // rdf:Alt, rdf:Seq and rdf:Bag hold lists of rdf:li
    const items = el.getElementsByTagNameNS('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'li');
    if (items.length) { for (const li of items) if (!li.children.length) add(key, li.textContent); return; }
    const kids = [...el.children];
    if (!kids.length) { add(key, el.textContent); return; }
    for (const kid of kids) {
      if (kid.localName === 'Description') {
        for (const a of kid.attributes) if (!/^(rdf|xmlns|xml):?/.test(a.name)) add(`${key}.${a.localName}`, a.value);
        for (const sub of kid.children) read(sub, `${key}.${sub.localName}`);
      } else read(kid, `${key}.${kid.localName}`);
    }
  };
  for (const desc of doc.getElementsByTagNameNS('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'Description')) {
    if (desc.parentNode.localName !== 'RDF') continue;
    for (const a of desc.attributes) {
      if (a.name.startsWith('xmlns') || a.prefix === 'rdf' || a.prefix === 'xml') continue;
      add(name(a), a.value);
    }
    for (const el of desc.children) read(el, name(el));
  }
  return out;
}

const IPTC_FIELDS = {
  5: 'Object name', 15: 'Category', 25: 'Keywords', 40: 'Special instructions', 55: 'Date created', 60: 'Time created',
  80: 'By-line', 85: 'By-line title', 90: 'City', 92: 'Sublocation', 95: 'Province/State', 101: 'Country',
  103: 'Transmission reference', 105: 'Headline', 110: 'Credit', 115: 'Source', 116: 'Copyright notice', 120: 'Caption',
  122: 'Caption writer',
};

/** IPTC-IIM records inside a Photoshop 8BIM block (JPEG APP13). */
export function parseIptc(u8) {
  const out = {};
  let p = 0;
  while (p + 12 < u8.length) {
    if (u8[p] !== 0x38 || u8[p + 1] !== 0x42 || u8[p + 2] !== 0x49 || u8[p + 3] !== 0x4d) { p++; continue; } // 8BIM
    const id = (u8[p + 4] << 8) | u8[p + 5];
    let q = p + 6;
    const nameLen = u8[q];
    q += 1 + nameLen + ((nameLen + 1) % 2);
    const size = (u8[q] << 24) | (u8[q + 1] << 16) | (u8[q + 2] << 8) | u8[q + 3];
    q += 4;
    if (id === 0x0404) {
      const end = Math.min(u8.length, q + size);
      let r = q;
      while (r + 5 <= end && u8[r] === 0x1c) {
        const dataset = u8[r + 2], len = (u8[r + 3] << 8) | u8[r + 4];
        const label = u8[r + 1] === 2 ? IPTC_FIELDS[dataset] : null;
        if (label) {
          const v = decoder.decode(u8.subarray(r + 5, r + 5 + len)).trim();
          if (v) out[label] = out[label] ? `${out[label]}, ${v}` : v;
        }
        r += 5 + len;
      }
    }
    p = q + size + (size % 2);
  }
  return out;
}

/** Name and basic fields of an ICC colour profile. */
export function parseIcc(u8) {
  if (u8.length < 132 || String.fromCharCode(u8[36], u8[37], u8[38], u8[39]) !== 'acsp') return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag4 = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]).trim();
  const out = { 'Color space': tag4(16), 'Connection space': tag4(20), 'Profile class': tag4(12), 'Version': `${u8[8]}.${u8[9] >> 4}` };
  const count = dv.getUint32(128);
  for (let i = 0; i < count && i < 100; i++) {
    const e = 132 + i * 12;
    if (e + 12 > u8.length || tag4(e) !== 'desc') continue;
    const off = dv.getUint32(e + 4), type = tag4(off);
    if (type === 'desc') {
      const len = dv.getUint32(off + 8);
      out.Description = String.fromCharCode(...u8.subarray(off + 12, off + 12 + Math.min(len, 200))).replace(/\0.*$/s, '').trim();
    } else if (type === 'mluc') {
      const recOff = dv.getUint32(off + 20 + 4), recLen = dv.getUint32(off + 20);
      out.Description = new TextDecoder('utf-16be').decode(u8.subarray(off + recOff, off + recOff + recLen)).replace(/\0.*$/s, '').trim();
    }
    break;
  }
  return out;
}
