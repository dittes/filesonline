// mime-parser.js
// RFC 2822 / MIME parsing for the MBOX viewer. Pure functions, no DOM access,
// usable from both the main thread and the parsing worker.

/**
 * @typedef {Object} MboxAttachment
 * @property {string} filename
 * @property {string} mimeType
 * @property {number} size          Approximate decoded size in bytes
 * @property {string|null} contentId
 * @property {boolean} inline
 * @property {string} encoding      Content-Transfer-Encoding of the part
 * @property {string} charset
 * @property {string} rawContent    Undecoded part body (decoded lazily)
 */

/**
 * @typedef {Object} MboxMessage  Normalized message model
 * @property {string} id
 * @property {string} sourceArchiveId
 * @property {number} sourceIndex
 * @property {string} separatorLine
 * @property {string} raw
 * @property {string} rawHeaders
 * @property {Array<{name:string,value:string}>} headers
 * @property {{name:string,address:string}[]} from
 * @property {{name:string,address:string}[]} to
 * @property {{name:string,address:string}[]} cc
 * @property {{name:string,address:string}[]} bcc
 * @property {{name:string,address:string}[]} replyTo
 * @property {string} subject
 * @property {number|null} date     Epoch ms (serializable across the worker boundary)
 * @property {string|null} messageId
 * @property {string|null} inReplyTo
 * @property {string[]} references
 * @property {string} textBody
 * @property {string} htmlBody
 * @property {MboxAttachment[]} attachments
 * @property {string[]} labels
 * @property {{read:boolean,starred:boolean,deleted:boolean,draft:boolean,answered:boolean}} flags
 * @property {string|null} threadId
 * @property {string} localNote
 * @property {Object|null} edited   Working copy when locally edited
 * @property {string|null} originalHash
 * @property {string[]} warnings
 */

// ─── Low-level decoders ──────────────────────────────────────────────────────

/**
 * Decode quoted-printable content.
 * @param {string} str
 * @param {boolean} [isHeaderWord]  RFC 2047 Q-encoding: "_" means space
 * @returns {Uint8Array}
 */
export function decodeQuotedPrintableBytes(str, isHeaderWord = false) {
  if (isHeaderWord) str = str.replace(/_/g, ' ');
  // Soft line breaks
  str = str.replace(/=\r?\n/g, '');
  const out = new Uint8Array(str.length);
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '=' && i + 2 < str.length && /^[0-9A-Fa-f]{2}$/.test(str.substr(i + 1, 2))) {
      out[n++] = parseInt(str.substr(i + 1, 2), 16);
      i += 2;
    } else {
      out[n++] = str.charCodeAt(i) & 0xff;
    }
  }
  return out.subarray(0, n);
}

/**
 * Decode base64 content, tolerating whitespace and padding issues.
 * @param {string} str
 * @returns {Uint8Array}
 */
export function decodeBase64Bytes(str) {
  const clean = str.replace(/[^A-Za-z0-9+/=]/g, '').replace(/=+$/, '');
  let bin;
  try {
    bin = atob(clean + '=='.slice(0, (4 - (clean.length % 4)) % 4));
  } catch {
    // Truncate to the last full quantum and retry
    try { bin = atob(clean.slice(0, clean.length - (clean.length % 4))); }
    catch { return new Uint8Array(0); }
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Normalize charset aliases TextDecoder does not accept. */
const CHARSET_ALIASES = {
  'utf8': 'utf-8', 'us-ascii': 'ascii', 'ansi_x3.4-1968': 'ascii',
  'cp1252': 'windows-1252', 'latin1': 'iso-8859-1', 'latin-1': 'iso-8859-1',
  'iso8859-1': 'iso-8859-1', 'iso-8859-8-i': 'iso-8859-8', 'unicode-1-1-utf-7': 'utf-8',
  'ks_c_5601-1987': 'euc-kr', 'gb2312': 'gbk',
};

/**
 * Decode bytes with a MIME charset, falling back to windows-1252 then utf-8.
 * @param {Uint8Array} bytes
 * @param {string} [charset]
 * @returns {{text:string, unknownCharset:boolean}}
 */
export function decodeCharset(bytes, charset = 'utf-8') {
  let cs = (charset || 'utf-8').toLowerCase().trim().replace(/^["']|["']$/g, '');
  cs = CHARSET_ALIASES[cs] || cs;
  try {
    return { text: new TextDecoder(cs).decode(bytes), unknownCharset: false };
  } catch {
    try {
      return { text: new TextDecoder('windows-1252').decode(bytes), unknownCharset: true };
    } catch {
      return { text: new TextDecoder('utf-8', { fatal: false }).decode(bytes), unknownCharset: true };
    }
  }
}

/**
 * Decode RFC 2047 encoded-words in a header value.
 * @param {string} str
 * @returns {string}
 */
export function decodeRfc2047(str) {
  if (!str || str.indexOf('=?') === -1) return str;
  // Remove whitespace between adjacent encoded words (RFC 2047 §6.2)
  str = str.replace(/(\?=)\s+(=\?)/g, '$1$2');
  return str.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (m, charset, enc, data) => {
    try {
      const bytes = enc.toLowerCase() === 'b'
        ? decodeBase64Bytes(data)
        : decodeQuotedPrintableBytes(data, true);
      return decodeCharset(bytes, charset).text;
    } catch {
      return m;
    }
  });
}

// ─── Header parsing ──────────────────────────────────────────────────────────

/**
 * Parse a raw header block (folded and repeated headers supported).
 * @param {string} text  Header block without the trailing blank line
 * @returns {{order:Array<{name:string,value:string}>, map:Map<string,string[]>}}
 */
export function parseHeaderBlock(text) {
  const order = [];
  const map = new Map();
  const lines = text.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && current) {
      // Folded continuation
      current.value += ' ' + line.trim();
    } else if (line.includes(':')) {
      const idx = line.indexOf(':');
      current = { name: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
      order.push(current);
    } else if (line.trim() === '') {
      current = null;
    }
    // Lines without ":" that are not continuations are tolerated and skipped
  }
  for (const h of order) {
    const key = h.name.toLowerCase();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(h.value);
  }
  return { order, map };
}

/**
 * Parse a Content-Type (or Content-Disposition) header value with parameters.
 * @param {string} value
 * @returns {{value:string, params:Object<string,string>}}
 */
export function parseParamHeader(value) {
  const result = { value: '', params: {} };
  if (!value) return result;
  const parts = value.split(';');
  result.value = parts.shift().trim().toLowerCase();
  // RFC 2231 continuation params (filename*0=, filename*1=) collected first
  const continuations = {};
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    let name = part.slice(0, eq).trim().toLowerCase();
    let val = part.slice(eq + 1).trim().replace(/^"(.*)"$/s, '$1');
    const contMatch = name.match(/^(.+?)\*(\d+)\*?$/);
    if (contMatch) {
      const base = contMatch[1];
      (continuations[base] = continuations[base] || [])[+contMatch[2]] = val;
      continue;
    }
    if (name.endsWith('*')) {
      // RFC 2231 extended value: charset'lang'percent-encoded
      name = name.slice(0, -1);
      const m = val.match(/^([^']*)'[^']*'(.*)$/s);
      if (m) {
        try { val = decodeURIComponent(m[2]); } catch { val = m[2]; }
      }
    }
    result.params[name] = val;
  }
  for (const [base, chunks] of Object.entries(continuations)) {
    let joined = chunks.join('');
    const m = joined.match(/^([^']*)'[^']*'(.*)$/s);
    if (m) { try { joined = decodeURIComponent(m[2]); } catch { joined = m[2]; } }
    result.params[base] = joined;
  }
  return result;
}

/**
 * Parse an address-list header into structured mailboxes.
 * Best-effort; handles `Name <a@b>`, bare addresses, quoted names, groups.
 * @param {string} value
 * @returns {{name:string,address:string}[]}
 */
export function parseAddressList(value) {
  if (!value) return [];
  const decoded = decodeRfc2047(value);
  const out = [];
  // Split on commas not inside quotes or angle brackets
  let depth = 0, inQuote = false, cur = '';
  const chunks = [];
  for (const ch of decoded) {
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && ch === '<') depth++;
    else if (!inQuote && ch === '>') depth = Math.max(0, depth - 1);
    if (ch === ',' && !inQuote && depth === 0) { chunks.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) chunks.push(cur);
  for (let chunk of chunks) {
    chunk = chunk.trim().replace(/^[^:]{0,40}:/, '').replace(/;$/, '').trim(); // strip group syntax
    if (!chunk) continue;
    const angled = chunk.match(/^(.*?)<([^>]*)>/s);
    if (angled) {
      const name = angled[1].trim().replace(/^"(.*)"$/s, '$1').trim();
      out.push({ name, address: angled[2].trim() });
    } else {
      const mail = chunk.match(/[\w.+%-]+@[\w.-]+/);
      out.push({ name: mail ? chunk.replace(mail[0], '').replace(/["<>()]/g, '').trim() : chunk, address: mail ? mail[0] : '' });
    }
  }
  return out;
}

/**
 * Parse an RFC 2822 date header. Returns epoch ms or null.
 * @param {string} value
 * @returns {number|null}
 */
export function parseDateHeader(value) {
  if (!value) return null;
  // Strip comments and obsolete zone names JS may reject
  const cleaned = value.replace(/\(.*?\)/g, '').trim();
  let t = Date.parse(cleaned);
  if (Number.isNaN(t)) {
    // Common malformed variant: missing day-of-week comma or double spaces
    t = Date.parse(cleaned.replace(/\s+/g, ' ').replace(/^[A-Za-z]{3,9},?\s*/, ''));
  }
  return Number.isNaN(t) ? null : t;
}

/** Extract Message-IDs (`<...>`) from a header value. */
export function parseMessageIds(value) {
  if (!value) return [];
  const ids = value.match(/<[^<>]+>/g);
  return ids ? ids.map(s => s.trim()) : [];
}

// ─── MIME body parsing ───────────────────────────────────────────────────────

/**
 * Decode a leaf part's content to text according to its transfer encoding + charset.
 * @param {string} content
 * @param {string} encoding
 * @param {string} charset
 * @returns {{text:string, unknownCharset:boolean}}
 */
export function decodePartText(content, encoding, charset) {
  const enc = (encoding || '').toLowerCase();
  if (enc === 'base64') return decodeCharset(decodeBase64Bytes(content), charset);
  if (enc === 'quoted-printable') return decodeCharset(decodeQuotedPrintableBytes(content), charset);
  // 7bit / 8bit / binary — content already text; re-decode bytes for non-utf8 charsets
  if (charset && !/utf-?8|ascii/i.test(charset)) {
    const bytes = new Uint8Array(content.length);
    for (let i = 0; i < content.length; i++) bytes[i] = content.charCodeAt(i) & 0xff;
    return decodeCharset(bytes, charset);
  }
  return { text: content, unknownCharset: false };
}

/**
 * Decode an attachment's raw content to bytes.
 * @param {MboxAttachment} att
 * @returns {Uint8Array}
 */
export function decodeAttachmentBytes(att) {
  const enc = (att.encoding || '').toLowerCase();
  if (enc === 'base64') return decodeBase64Bytes(att.rawContent);
  if (enc === 'quoted-printable') return decodeQuotedPrintableBytes(att.rawContent);
  const bytes = new Uint8Array(att.rawContent.length);
  for (let i = 0; i < att.rawContent.length; i++) bytes[i] = att.rawContent.charCodeAt(i) & 0xff;
  return bytes;
}

/**
 * Recursively walk a MIME entity, filling result.
 * @param {string} headerText
 * @param {string} bodyText
 * @param {{textBody:string, htmlBody:string, attachments:MboxAttachment[], warnings:string[]}} result
 * @param {number} depth
 */
function walkMimeEntity(headerText, bodyText, result, depth) {
  if (depth > 12) { result.warnings.push('MIME nesting too deep; remainder skipped'); return; }
  const { map } = parseHeaderBlock(headerText);
  const ct = parseParamHeader((map.get('content-type') || [''])[0]);
  const disposition = parseParamHeader((map.get('content-disposition') || [''])[0]);
  const encoding = ((map.get('content-transfer-encoding') || [''])[0] || '').trim();
  const type = ct.value || 'text/plain';
  const charset = ct.params.charset || 'utf-8';

  if (type.startsWith('multipart/')) {
    const boundary = ct.params.boundary;
    if (!boundary) {
      result.warnings.push('multipart entity without boundary');
      result.textBody = result.textBody || bodyText;
      return;
    }
    const parts = splitMultipart(bodyText, boundary);
    if (parts.length === 0) {
      result.warnings.push(`No parts found for boundary "${boundary}"`);
      return;
    }
    if (type === 'multipart/alternative') {
      // Parse every alternative; prefer having both text and html available
      for (const p of parts) walkMimeEntity(p.header, p.body, result, depth + 1);
    } else {
      for (const p of parts) walkMimeEntity(p.header, p.body, result, depth + 1);
    }
    return;
  }

  if (type === 'message/rfc822') {
    // Embedded message: treat as attachment, keep raw
    result.attachments.push(makeAttachment('embedded-message.eml', 'message/rfc822', bodyText, encoding, null, false, charset));
    return;
  }

  const contentIdRaw = (map.get('content-id') || [null])[0];
  const contentId = contentIdRaw ? contentIdRaw.replace(/[<>]/g, '').trim() : null;
  const filename = decodeRfc2047(disposition.params.filename || ct.params.name || '');
  const isAttachmentDisposition = disposition.value === 'attachment';
  const isInline = disposition.value === 'inline' || (!!contentId && !isAttachmentDisposition);

  if (!isAttachmentDisposition && !filename && type === 'text/plain') {
    const { text, unknownCharset } = decodePartText(bodyText, encoding, charset);
    if (unknownCharset) result.warnings.push(`Unknown charset "${charset}"; decoded with fallback`);
    result.textBody = result.textBody ? result.textBody + '\n' + text : text;
    return;
  }
  if (!isAttachmentDisposition && !filename && type === 'text/html') {
    const { text, unknownCharset } = decodePartText(bodyText, encoding, charset);
    if (unknownCharset) result.warnings.push(`Unknown charset "${charset}"; decoded with fallback`);
    result.htmlBody = result.htmlBody ? result.htmlBody + text : text;
    return;
  }

  // Everything else is an attachment (lazy-decoded)
  result.attachments.push(makeAttachment(
    filename || (contentId ? `inline-${contentId}` : `part.${(type.split('/')[1] || 'bin').slice(0, 8)}`),
    type, bodyText, encoding, contentId, isInline, charset
  ));
}

/** @returns {MboxAttachment} */
function makeAttachment(filename, mimeType, rawContent, encoding, contentId, inline, charset) {
  const enc = (encoding || '').toLowerCase();
  // Approximate decoded size without decoding
  let size = rawContent.length;
  if (enc === 'base64') size = Math.floor(rawContent.replace(/\s/g, '').length * 0.75);
  return { filename, mimeType, size, contentId, inline, encoding: enc, charset: charset || 'utf-8', rawContent };
}

/**
 * Split a multipart body on its boundary.
 * @param {string} body
 * @param {string} boundary
 * @returns {Array<{header:string, body:string}>}
 */
export function splitMultipart(body, boundary) {
  const marker = '--' + boundary;
  const lines = body.split(/\r?\n/);
  const parts = [];
  let cur = null;
  for (const line of lines) {
    if (line === marker || line === marker + '--' || line.trimEnd() === marker || line.trimEnd() === marker + '--') {
      if (cur) parts.push(cur.join('\n'));
      if (line.trimEnd().endsWith('--')) { cur = null; break; }
      cur = [];
    } else if (cur) {
      cur.push(line);
    }
  }
  if (cur && cur.length) parts.push(cur.join('\n'));
  return parts.map(p => {
    const sep = p.search(/\r?\n\r?\n/);
    if (sep === -1) return { header: p, body: '' };
    const headerEnd = sep;
    const bodyStart = p.slice(sep).match(/^\r?\n\r?\n/)[0].length + sep;
    return { header: p.slice(0, headerEnd), body: p.slice(bodyStart) };
  });
}

// ─── Full message parsing ────────────────────────────────────────────────────

/**
 * Parse one raw RFC 2822 message into the normalized model.
 * @param {string} raw            Raw message source (headers + body)
 * @param {Object} meta           { id, sourceArchiveId, sourceIndex, separatorLine }
 * @returns {MboxMessage}
 */
export function parseMessage(raw, meta = {}) {
  const warnings = [];
  const sepMatch = raw.search(/\r?\n\r?\n/);
  let rawHeaders, body;
  if (sepMatch === -1) {
    rawHeaders = raw;
    body = '';
    if (raw.trim()) warnings.push('No blank line between headers and body');
  } else {
    rawHeaders = raw.slice(0, sepMatch);
    body = raw.slice(sepMatch + raw.slice(sepMatch).match(/^\r?\n\r?\n/)[0].length);
  }

  const { order, map } = parseHeaderBlock(rawHeaders);
  const get = (name) => (map.get(name) || [null])[0];

  const result = { textBody: '', htmlBody: '', attachments: [], warnings };
  try {
    walkMimeEntity(rawHeaders, body, result, 0);
  } catch (err) {
    warnings.push('MIME parsing failed: ' + (err && err.message ? err.message : 'unknown error'));
    result.textBody = result.textBody || body;
  }

  const dateVal = parseDateHeader(get('date'));
  if (get('date') && dateVal === null) warnings.push('Invalid Date header');
  if (!get('from')) warnings.push('Missing From header');

  const status = ((get('status') || '') + (get('x-status') || '')).toUpperCase();
  const xMozilla = get('x-mozilla-status');
  const labels = [];
  for (const h of ['x-gmail-labels', 'x-label', 'keywords']) {
    const v = get(h);
    if (v) labels.push(...decodeRfc2047(v).split(',').map(s => s.trim()).filter(Boolean));
  }

  return {
    id: meta.id || `${meta.sourceArchiveId || 'a'}:${meta.sourceIndex ?? 0}`,
    sourceArchiveId: meta.sourceArchiveId || null,
    sourceIndex: meta.sourceIndex ?? 0,
    separatorLine: meta.separatorLine || '',
    raw,
    rawHeaders,
    headers: order,
    from: parseAddressList(get('from')),
    to: parseAddressList(get('to')),
    cc: parseAddressList(get('cc')),
    bcc: parseAddressList(get('bcc')),
    replyTo: parseAddressList(get('reply-to')),
    subject: decodeRfc2047(get('subject') || ''),
    date: dateVal,
    messageId: parseMessageIds(get('message-id'))[0] || null,
    inReplyTo: parseMessageIds(get('in-reply-to'))[0] || null,
    references: parseMessageIds(get('references')),
    textBody: result.textBody,
    htmlBody: result.htmlBody,
    attachments: result.attachments,
    labels,
    flags: {
      read: status.includes('R') || status.includes('O') || (xMozilla ? (parseInt(xMozilla, 16) & 1) === 1 : false),
      starred: status.includes('F'),
      deleted: status.includes('D'),
      draft: /draft/i.test(get('x-gmail-labels') || '') || !!get('x-mozilla-draft-info'),
      answered: status.includes('A'),
    },
    threadId: null,
    localNote: '',
    edited: null,
    originalHash: null,
    warnings,
  };
}
