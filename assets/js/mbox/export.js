// export.js
// Export helpers: .eml, .mbox, CSV, JSON, ZIP of .eml, HTML archive.
// Unedited messages are exported byte-for-byte from their raw source; edited
// messages are reconstructed (which invalidates DKIM/S-MIME/PGP signatures —
// the UI warns about this).

import { serializeMbox } from './mbox-parser.js';
import { downloadBlob, sanitizeFilename, escapeHtml, formatBytes } from '../utils.js';

const ZIP_CDN = 'https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.7.52/dist/zip-full.min.js';
let zipLoaded = null;

/** Lazy-load zip.js behind a wrapper. */
async function ensureZip() {
  if (window.zip) return window.zip;
  if (!zipLoaded) {
    zipLoaded = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = ZIP_CDN;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load the ZIP library from the CDN.'));
      document.head.appendChild(s);
    });
  }
  await zipLoaded;
  return window.zip;
}

/**
 * Current raw source of a message: original raw, or a reconstruction when the
 * message has local edits.
 * @param {import('./mime-parser.js').MboxMessage} msg
 * @returns {string}
 */
export function currentRawSource(msg) {
  if (!msg.edited) return msg.raw;
  return reconstructMessage(msg);
}

/** Format an address list back to a header value. */
function formatAddresses(list) {
  return (list || [])
    .map(a => (a.name ? `${/[,;"<>]/.test(a.name) ? JSON.stringify(a.name) : a.name} <${a.address}>` : a.address))
    .filter(Boolean)
    .join(', ');
}

/**
 * Rebuild an RFC 2822 source for an edited message. Plain reconstruction:
 * edited values replace the original headers; the edited body replaces the
 * original MIME structure with a simple text/plain or text/html message.
 * Attachments from the original are not re-attached (the original raw source
 * remains available for lossless export).
 * @param {import('./mime-parser.js').MboxMessage} msg
 */
export function reconstructMessage(msg) {
  const e = msg.edited || {};
  const headers = [];
  const skip = new Set(['from', 'to', 'cc', 'bcc', 'subject', 'date', 'content-type', 'content-transfer-encoding', 'mime-version', 'reply-to']);
  headers.push(`From: ${formatAddresses(e.from ?? msg.from)}`);
  if ((e.to ?? msg.to).length) headers.push(`To: ${formatAddresses(e.to ?? msg.to)}`);
  if ((e.cc ?? msg.cc).length) headers.push(`Cc: ${formatAddresses(e.cc ?? msg.cc)}`);
  if ((e.replyTo ?? msg.replyTo).length) headers.push(`Reply-To: ${formatAddresses(e.replyTo ?? msg.replyTo)}`);
  headers.push(`Subject: ${e.subject ?? msg.subject}`);
  const date = e.date ?? msg.date;
  if (date) headers.push(`Date: ${new Date(date).toUTCString().replace('GMT', '+0000')}`);
  // Preserve remaining original headers (Message-ID, References, custom, …)
  for (const h of msg.headers) {
    if (!skip.has(h.name.toLowerCase())) headers.push(`${h.name}: ${h.value}`);
  }
  // Extra headers edited by the user
  for (const h of e.extraHeaders || []) {
    if (h.name && h.value) headers.push(`${h.name}: ${h.value}`);
  }
  headers.push('MIME-Version: 1.0');
  const useHtml = e.htmlBody != null && e.htmlBody !== '';
  const body = useHtml ? e.htmlBody : (e.textBody ?? msg.textBody ?? '');
  headers.push(`Content-Type: ${useHtml ? 'text/html' : 'text/plain'}; charset=utf-8`);
  headers.push('Content-Transfer-Encoding: 8bit');
  headers.push('X-FO-Edited: true');
  return headers.join('\n') + '\n\n' + body;
}

// ─── Single message exports ─────────────────────────────────────────────────

export function exportEml(msg) {
  const raw = currentRawSource(msg);
  downloadBlob(new Blob([raw.replace(/\r?\n/g, '\r\n')], { type: 'message/rfc822' }), emlName(msg));
}

export function exportRaw(msg) {
  downloadBlob(new Blob([msg.raw], { type: 'text/plain' }), emlName(msg).replace(/\.eml$/, '.txt'));
}

export function exportText(msg) {
  const eff = msg.edited || msg;
  const head = [
    `Subject: ${eff.subject ?? msg.subject}`,
    `From: ${formatAddresses(eff.from ?? msg.from)}`,
    `To: ${formatAddresses(eff.to ?? msg.to)}`,
    `Date: ${msg.date ? new Date(msg.date).toString() : '(unknown)'}`,
  ].join('\n');
  const body = (eff.textBody ?? msg.textBody) || '(no plain-text body)';
  downloadBlob(new Blob([head + '\n\n' + body], { type: 'text/plain' }), emlName(msg).replace(/\.eml$/, '.txt'));
}

export function exportJson(msg) {
  downloadBlob(new Blob([JSON.stringify(messageJson(msg), null, 2)], { type: 'application/json' }),
    emlName(msg).replace(/\.eml$/, '.json'));
}

/**
 * Export a sanitized HTML rendering of one message.
 * @param {import('./mime-parser.js').MboxMessage} msg
 * @param {string} sanitizedBodyHtml  Already-sanitized body markup
 */
export function exportHtml(msg, sanitizedBodyHtml) {
  const html = htmlDocument(`${escapeHtml(msg.subject || '(no subject)')}`, messageHtmlBlock(msg, sanitizedBodyHtml));
  downloadBlob(new Blob([html], { type: 'text/html' }), emlName(msg).replace(/\.eml$/, '.html'));
}

// ─── Multi-message exports ──────────────────────────────────────────────────

export function exportMbox(messages, filename = 'export.mbox', eol = '\n') {
  const text = serializeMbox(messages.map(m => ({ separatorLine: m.separatorLine, raw: currentRawSource(m), from: m.from, date: m.date })), eol);
  downloadBlob(new Blob([text], { type: 'application/mbox' }), sanitizeFilename(filename));
}

export async function exportZipOfEml(messages, filename = 'messages.zip', onProgress) {
  const zip = await ensureZip();
  const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'));
  const used = new Set();
  let i = 0;
  for (const msg of messages) {
    let name = emlName(msg);
    while (used.has(name)) name = name.replace(/\.eml$/, `-${msg.sourceIndex}.eml`);
    used.add(name);
    await writer.add(name, new zip.TextReader(currentRawSource(msg).replace(/\r?\n/g, '\r\n')));
    if (onProgress) onProgress(++i, messages.length);
  }
  downloadBlob(await writer.close(), sanitizeFilename(filename));
}

export function exportCsv(messages, filename = 'messages.csv', archiveNames = {}) {
  const cols = ['Date', 'From', 'To', 'Cc', 'Subject', 'Message-ID', 'Attachment count', 'Attachment filenames', 'Read', 'Starred', 'Labels', 'Source archive'];
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = [cols.join(',')];
  for (const m of messages) {
    const eff = m.edited || m;
    rows.push([
      m.date ? new Date(m.date).toISOString() : '',
      formatAddresses(eff.from ?? m.from),
      formatAddresses(eff.to ?? m.to),
      formatAddresses(m.cc),
      eff.subject ?? m.subject,
      m.messageId || '',
      m.attachments.length,
      m.attachments.map(a => a.filename).join('; '),
      m.flags.read ? 'read' : 'unread',
      m.flags.starred ? 'starred' : '',
      m.labels.join('; '),
      archiveNames[m.sourceArchiveId] || m.sourceArchiveId || '',
    ].map(esc).join(','));
  }
  downloadBlob(new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' }), sanitizeFilename(filename));
}

export function exportJsonArchive(messages, filename = 'messages.json') {
  downloadBlob(new Blob([JSON.stringify(messages.map(messageJson), null, 2)], { type: 'application/json' }), sanitizeFilename(filename));
}

/**
 * Static HTML archive of selected messages (plain-text bodies for safety).
 */
export function exportHtmlArchive(messages, filename = 'archive.html') {
  const blocks = messages.map(m => messageHtmlBlock(m, null)).join('\n<hr>\n');
  downloadBlob(new Blob([htmlDocument('Email archive export', blocks)], { type: 'text/html' }), sanitizeFilename(filename));
}

export async function exportAttachmentsZip(entries, filename = 'attachments.zip') {
  // entries: [{ name, bytes: Uint8Array }]
  const zip = await ensureZip();
  const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'));
  const used = new Set();
  for (const { name, bytes } of entries) {
    let n = sanitizeFilename(name || 'attachment.bin'), i = 1;
    while (used.has(n)) n = n.replace(/(\.[^.]*)?$/, `-${i++}$1`);
    used.add(n);
    await writer.add(n, new zip.Uint8ArrayReader(bytes));
  }
  downloadBlob(await writer.close(), sanitizeFilename(filename));
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

function emlName(msg) {
  const eff = msg.edited || msg;
  const date = msg.date ? new Date(msg.date).toISOString().slice(0, 10) : 'undated';
  const subj = sanitizeFilename((eff.subject ?? msg.subject) || 'no-subject').slice(0, 60) || 'message';
  return `${date}-${subj}.eml`;
}

function messageJson(msg) {
  const { raw, rawHeaders, _blob, attachments, ...rest } = msg;
  return {
    ...rest,
    date: msg.date ? new Date(msg.date).toISOString() : null,
    attachments: attachments.map(({ rawContent, ...a }) => a),
  };
}

function messageHtmlBlock(msg, sanitizedBodyHtml) {
  const eff = msg.edited || msg;
  const body = sanitizedBodyHtml != null
    ? sanitizedBodyHtml
    : `<pre style="white-space:pre-wrap;font-family:inherit;">${escapeHtml((eff.textBody ?? msg.textBody) || '(no text body)')}</pre>`;
  const atts = msg.attachments.length
    ? `<p><strong>Attachments:</strong> ${msg.attachments.map(a => `${escapeHtml(a.filename)} (${formatBytes(a.size)})`).join(', ')}</p>`
    : '';
  return `<article style="max-width:760px;margin:0 auto 2rem;">
  <h2 style="margin-bottom:.25rem;">${escapeHtml(eff.subject ?? msg.subject) || '(no subject)'}</h2>
  <p style="color:#666;margin:.25rem 0;">From: ${escapeHtml(formatAddresses(eff.from ?? msg.from))}<br>
  To: ${escapeHtml(formatAddresses(eff.to ?? msg.to))}<br>
  Date: ${msg.date ? new Date(msg.date).toString() : '(unknown)'}</p>
  ${msg.edited ? '<p style="color:#b45309;">⚠ This message was edited locally; signatures are not preserved.</p>' : ''}
  ${atts}
  <div>${body}</div>
</article>`;
}

function htmlDocument(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;line-height:1.6;padding:2rem 1rem;color:#1c1c1a;}hr{margin:2rem 0;border:none;border-top:1px solid #ddd;}</style>
</head>
<body>
${body}
<p style="text-align:center;color:#999;font-size:.8rem;">Exported with MBOX Viewer — files-online.com</p>
</body>
</html>`;
}
