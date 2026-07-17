// worker.js
// Module worker that parses .mbox files off the main thread.
// Protocol (postMessage):
//   in : { type:'parse', file: File, archiveId: string }
//   in : { type:'cancel' }
//   out: { type:'phase', phase: 1..5, label: string }
//   out: { type:'progress', bytesRead, bytesTotal, messages }
//   out: { type:'messages', batch: MboxMessage[] }  (raw kept, attachments lazy)
//   out: { type:'done', report: ImportReport }
//   out: { type:'error', message: string }

import { MboxSplitter, unescapeFromLines } from './mbox-parser.js';
import { parseMessage } from './mime-parser.js';

const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB
let cancelled = false;

self.onmessage = async (e) => {
  const { type } = e.data || {};
  if (type === 'cancel') { cancelled = true; return; }
  if (type === 'parse') {
    cancelled = false;
    try {
      await parseFile(e.data.file, e.data.archiveId);
    } catch (err) {
      self.postMessage({ type: 'error', message: (err && err.message) || 'Parsing failed' });
    }
  }
};

async function parseFile(file, archiveId) {
  const report = {
    archiveId,
    fileName: file.name || 'archive.mbox',
    fileSize: file.size,
    imported: 0,
    withWarnings: 0,
    undecodable: 0,
    duplicateMessageIds: 0,
    unknownCharsets: 0,
    totalAttachments: 0,
    noSeparators: false,
  };

  if (file.size === 0) {
    self.postMessage({ type: 'error', message: 'The file is empty.' });
    return;
  }

  self.postMessage({ type: 'phase', phase: 1, label: 'Reading file' });

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const seenIds = new Set();
  let batch = [];
  let index = 0;

  const flush = () => {
    if (batch.length) {
      self.postMessage({ type: 'messages', batch });
      batch = [];
    }
  };

  const splitter = new MboxSplitter(({ separatorLine, raw, offset }) => {
    const msg = parseAndNormalize(raw, separatorLine, archiveId, index++, offset, report, seenIds);
    batch.push(msg);
    if (batch.length >= 200) flush();
  });

  let bytesRead = 0;
  let phase = 1;
  while (bytesRead < file.size) {
    if (cancelled) { self.postMessage({ type: 'error', message: 'Cancelled' }); return; }
    const slice = file.slice(bytesRead, bytesRead + CHUNK_SIZE);
    const buf = await slice.arrayBuffer();
    bytesRead += buf.byteLength;
    if (phase === 1 && bytesRead > 0) {
      phase = 2;
      self.postMessage({ type: 'phase', phase: 2, label: 'Detecting messages' });
    }
    splitter.push(decoder.decode(buf, { stream: bytesRead < file.size }));
    self.postMessage({ type: 'progress', bytesRead, bytesTotal: file.size, messages: index });
    // Yield so cancel messages can be processed
    await new Promise(r => setTimeout(r, 0));
  }
  self.postMessage({ type: 'phase', phase: 3, label: 'Parsing headers' });
  splitter.finish();
  flush();

  if (index === 0) {
    self.postMessage({ type: 'error', message: 'No messages found. This does not look like an MBOX file.' });
    return;
  }
  report.noSeparators = !splitter.sawAnySeparator;
  report.imported = index;

  self.postMessage({ type: 'phase', phase: 4, label: 'Building index' });
  self.postMessage({ type: 'done', report });
  self.postMessage({ type: 'phase', phase: 5, label: 'Ready' });
}

function parseAndNormalize(raw, separatorLine, archiveId, index, offset, report, seenIds) {
  let msg;
  try {
    // Unescape ">From " lines only in the body portion
    const gap = raw.search(/\r?\n\r?\n/);
    let source = raw;
    if (gap !== -1) {
      const skip = raw.slice(gap).match(/^\r?\n\r?\n/)[0].length;
      source = raw.slice(0, gap + skip) + unescapeFromLines(raw.slice(gap + skip));
    }
    msg = parseMessage(source, {
      id: `${archiveId}:${index}`,
      sourceArchiveId: archiveId,
      sourceIndex: index,
      separatorLine,
    });
  } catch (err) {
    // Never discard: preserve raw and flag the failure
    msg = {
      id: `${archiveId}:${index}`,
      sourceArchiveId: archiveId, sourceIndex: index, separatorLine,
      raw, rawHeaders: '', headers: [],
      from: [], to: [], cc: [], bcc: [], replyTo: [],
      subject: '(unparseable message)', date: null,
      messageId: null, inReplyTo: null, references: [],
      textBody: raw, htmlBody: '', attachments: [], labels: [],
      flags: { read: false, starred: false, deleted: false, draft: false, answered: false },
      threadId: null, localNote: '', edited: null, originalHash: null,
      warnings: ['Message could not be parsed: ' + ((err && err.message) || 'unknown error')],
    };
    report.undecodable++;
  }
  if (msg.warnings.length) {
    report.withWarnings++;
    if (msg.warnings.some(w => w.includes('charset'))) report.unknownCharsets++;
  }
  if (msg.messageId) {
    if (seenIds.has(msg.messageId)) {
      report.duplicateMessageIds++;
      msg.warnings.push('Duplicate Message-ID');
    }
    seenIds.add(msg.messageId);
  }
  report.totalAttachments += msg.attachments.length;
  // Precompute list metadata so the UI never touches bodies for rendering rows
  msg.preview = (msg.textBody || stripHtml(msg.htmlBody) || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  return msg;
}

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').slice(0, 500);
}
