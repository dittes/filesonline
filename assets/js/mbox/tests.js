// tests.js — lightweight browser test runner for the MBOX viewer modules.
// Open /open-mbox-file/tests.html to run.

import { splitMbox, escapeFromLines, unescapeFromLines, serializeMbox, isFromSeparator } from './mbox-parser.js';
import {
  parseMessage, parseHeaderBlock, decodeRfc2047, decodeBase64Bytes,
  decodeQuotedPrintableBytes, decodeCharset, splitMultipart, parseAddressList,
  parseDateHeader, decodeAttachmentBytes,
} from './mime-parser.js';
import { parseQuery, searchMessages } from './search.js';
import { buildThreads, normalizeSubject } from './threads.js';
import { generateDemoMbox } from './demo.js';

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
  }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }
function assertEq(actual, expected, msg = '') {
  if (actual !== expected) throw new Error(`${msg} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ─── MBOX separator detection ───────────────────────────────────────────────

test('separator: From line recognized', () => {
  assert(isFromSeparator('From alice@example.com Mon Jan  5 09:15:00 2026'));
  assert(!isFromSeparator('>From my point of view'));
  assert(!isFromSeparator('From: alice@example.com'));
});

test('splitMbox: splits two messages', () => {
  const mbox = 'From a@x Mon Jan 1 00:00:00 2026\nSubject: One\n\nbody one\n\nFrom b@x Mon Jan 1 00:00:01 2026\nSubject: Two\n\nbody two\n';
  const msgs = splitMbox(mbox);
  assertEq(msgs.length, 2, 'message count:');
  assert(msgs[0].raw.includes('Subject: One'));
  assert(msgs[1].raw.includes('body two'));
});

test('splitMbox: does not split on body "From " without preceding blank line', () => {
  const mbox = 'From a@x Mon Jan 1 00:00:00 2026\nSubject: One\n\nline one\nFrom here it continues\nlast line\n';
  const msgs = splitMbox(mbox);
  assertEq(msgs.length, 1, 'message count:');
  assert(msgs[0].raw.includes('From here it continues'));
});

test('escaped >From lines survive round trip', () => {
  const body = 'hello\nFrom the start\n>From quoted';
  const escaped = escapeFromLines(body);
  assertEq(escaped, 'hello\n>From the start\n>>From quoted');
  assertEq(unescapeFromLines(escaped), body);
});

// ─── Headers ────────────────────────────────────────────────────────────────

test('folded headers are unfolded', () => {
  const { map } = parseHeaderBlock('Subject: hello\n world\nX-A: 1');
  assertEq(map.get('subject')[0], 'hello world');
});

test('repeated headers preserved', () => {
  const { map } = parseHeaderBlock('Received: one\nReceived: two');
  assertEq(map.get('received').length, 2);
});

test('RFC 2047 decoding (B and Q)', () => {
  assertEq(decodeRfc2047('=?utf-8?B?SMOkbGxv?='), 'Hällo');
  assertEq(decodeRfc2047('=?iso-8859-1?Q?Gr=FC=DFe?='), 'Grüße');
});

test('address list parsing', () => {
  const list = parseAddressList('Alice <a@x.com>, "Bob, Jr." <b@x.com>, c@x.com');
  assertEq(list.length, 3);
  assertEq(list[0].name, 'Alice');
  assertEq(list[1].address, 'b@x.com');
  assertEq(list[2].address, 'c@x.com');
});

test('date parsing: valid and invalid', () => {
  assert(parseDateHeader('Mon, 5 Jan 2026 09:15:00 +0100') !== null);
  assertEq(parseDateHeader('not a date at all'), null);
});

// ─── Encodings ──────────────────────────────────────────────────────────────

test('base64 decoding', () => {
  const bytes = decodeBase64Bytes('SGVsbG8=');
  assertEq(new TextDecoder().decode(bytes), 'Hello');
});

test('base64 with whitespace and broken padding', () => {
  const bytes = decodeBase64Bytes('SGVs\nbG8');
  assertEq(new TextDecoder().decode(bytes), 'Hello');
});

test('quoted-printable decoding with soft breaks', () => {
  const bytes = decodeQuotedPrintableBytes('Gr=FC=DFe co=\nntinued');
  assertEq(decodeCharset(bytes, 'iso-8859-1').text, 'Grüße continued');
});

test('charset conversion fallback for unknown charset', () => {
  const r = decodeCharset(new TextEncoder().encode('hi'), 'x-no-such-charset');
  assertEq(r.text, 'hi');
  assert(r.unknownCharset, 'should flag unknown charset');
});

// ─── MIME ───────────────────────────────────────────────────────────────────

test('multipart boundaries split correctly', () => {
  const body = 'preamble\n--b1\nContent-Type: text/plain\n\nAAA\n--b1\nContent-Type: text/html\n\n<p>B</p>\n--b1--\nepilogue';
  const parts = splitMultipart(body, 'b1');
  assertEq(parts.length, 2);
  assert(parts[0].body.includes('AAA'));
  assert(parts[1].header.includes('text/html'));
});

test('multipart/alternative keeps both text and html', () => {
  const raw = 'Content-Type: multipart/alternative; boundary="q"\n\n--q\nContent-Type: text/plain\n\nplain\n--q\nContent-Type: text/html\n\n<b>html</b>\n--q--';
  const msg = parseMessage(raw, {});
  assert(msg.textBody.includes('plain'));
  assert(msg.htmlBody.includes('html'));
});

test('attachment extraction with base64 decode', () => {
  const raw = 'Content-Type: multipart/mixed; boundary="m"\n\n--m\nContent-Type: text/plain\n\nsee attachment\n--m\nContent-Type: application/octet-stream; name="a.bin"\nContent-Transfer-Encoding: base64\nContent-Disposition: attachment; filename="a.bin"\n\nSGVsbG8=\n--m--';
  const msg = parseMessage(raw, {});
  assertEq(msg.attachments.length, 1);
  assertEq(msg.attachments[0].filename, 'a.bin');
  assertEq(new TextDecoder().decode(decodeAttachmentBytes(msg.attachments[0])), 'Hello');
});

test('malformed message preserved with warning', () => {
  const msg = parseMessage('Content-Type: multipart/mixed; boundary="missing"\n\nno parts here', {});
  assert(msg.warnings.length > 0, 'should have warnings');
  assert(msg.raw.includes('no parts here'), 'raw preserved');
});

test('invalid MIME boundary produces warning, keeps raw', () => {
  const msg = parseMessage('Content-Type: multipart/mixed\n\nbody without boundary param', {});
  assert(msg.warnings.some(w => w.includes('boundary')), 'boundary warning');
});

// ─── Demo archive end-to-end ────────────────────────────────────────────────

const demoMsgs = splitMbox(generateDemoMbox()).map((m, i) =>
  parseMessage(m.raw.replace(/^>(>*From )/gm, '$1'), { id: 'demo:' + i, sourceIndex: i, separatorLine: m.separatorLine }));

test('demo archive: all messages found', () => {
  assertEq(demoMsgs.length, 11, 'demo message count:');
});

test('demo archive: escaped From line decoded', () => {
  const m = demoMsgs.find(x => x.subject.includes('body line starting'));
  assert(m, 'message found');
  assert(m.textBody.includes('\nFrom my point of view'), 'unescaped From line present');
});

test('demo archive: folded + encoded subject', () => {
  const m = demoMsgs.find(x => x.messageId === '<demo-005@example.com>');
  assert(m.subject.includes('Ümläute'), 'decoded subject: ' + m.subject);
  assertEq(m.from[0].address, 'frank@example.com');
});

test('demo archive: quoted-printable body', () => {
  const m = demoMsgs.find(x => x.messageId === '<demo-006@example.com>');
  assert(m.textBody.includes('Grüße aus München'), 'QP decoded');
  assert(m.textBody.includes('continues on the next physical line'), 'soft break joined');
});

test('demo archive: base64 body', () => {
  const m = demoMsgs.find(x => x.messageId === '<demo-007@example.com>');
  assert(m.textBody.includes('base64 decoding works correctly'));
});

// ─── Threads ────────────────────────────────────────────────────────────────

test('subject normalization', () => {
  assertEq(normalizeSubject('Re: Re: Fwd: Hello'), 'hello');
  assertEq(normalizeSubject('AW: Meeting'), 'meeting');
});

test('thread grouping via References', () => {
  const threads = buildThreads(demoMsgs);
  const kickoff = demoMsgs.find(m => m.messageId === '<demo-thread-1@example.com>');
  const group = threads.get(kickoff.threadId);
  assertEq(group.length, 3, 'thread size:');
});

// ─── Export / re-import consistency ─────────────────────────────────────────

test('mbox export → re-import round trip', () => {
  const out = serializeMbox(demoMsgs.slice(0, 3).map(m => ({ separatorLine: m.separatorLine, raw: m.raw, from: m.from, date: m.date })));
  const again = splitMbox(out);
  assertEq(again.length, 3, 'round-trip count:');
  const reparsed = parseMessage(again[0].raw, {});
  assertEq(reparsed.subject, demoMsgs[0].subject, 'subject stable:');
});

test('export escapes From lines in bodies', () => {
  const fake = { separatorLine: '', raw: 'Subject: t\n\nFrom here on\ntext', from: [], date: null };
  const out = serializeMbox([fake]);
  assert(out.includes('\n>From here on'), 'body From escaped');
});

// ─── Search ─────────────────────────────────────────────────────────────────

test('query parser: fields, phrases, negation', () => {
  const q = parseQuery('from:alice subject:"project update" -label:archive has:attachment');
  assertEq(q.terms.length, 4);
  assertEq(q.terms[0].field, 'from');
  assertEq(q.terms[1].value, 'project update');
  assert(q.terms[2].negated);
  assertEq(q.terms[3].field, 'has');
});

test('search filters work on demo archive', () => {
  assertEq(searchMessages(demoMsgs, 'from:alice@example.com').length, 2);
  assertEq(searchMessages(demoMsgs, 'has:attachment').length, 1);
  assertEq(searchMessages(demoMsgs, 'subject:"Project kickoff"').length, 3);
  // after: is inclusive from midnight UTC — Jan 10 12:00+0100, Jan 11, Jan 12
  assertEq(searchMessages(demoMsgs, 'after:2026-01-10 before:2026-01-13').length, 3);
  assert(searchMessages(demoMsgs, 'kickoff -from:dave').length < searchMessages(demoMsgs, 'kickoff').length);
});

test('empty file / no messages handled by splitter', () => {
  assertEq(splitMbox('').length, 0);
  assertEq(splitMbox('\n\n\n').length, 0);
});

// ─── Report ─────────────────────────────────────────────────────────────────

const mount = document.getElementById('results');
const passed = results.filter(r => r.ok).length;
document.getElementById('summary').innerHTML =
  `<strong style="color:${passed === results.length ? 'var(--success)' : 'var(--error)'}">${passed} / ${results.length} tests passed</strong>`;
mount.innerHTML = results.map(r => `
  <div class="test-row" style="padding:6px 10px;border-bottom:1px solid var(--border);font-size:13px;">
    <span style="color:${r.ok ? 'var(--success)' : 'var(--error)'};font-weight:600;">${r.ok ? 'PASS' : 'FAIL'}</span>
    ${r.name}
    ${r.error ? `<div style="color:var(--error);font-family:var(--font-mono);font-size:12px;margin-top:2px;">${r.error.replace(/</g, '&lt;')}</div>` : ''}
  </div>`).join('');
