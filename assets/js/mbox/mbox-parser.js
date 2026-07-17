// mbox-parser.js
// MBOX container parsing: message boundary detection, From-line escaping.
// Pure string logic, shared by the worker and the browser test page.

/**
 * True when a line is an mbox "From " separator candidate.
 * @param {string} line
 * @returns {boolean}
 */
export function isFromSeparator(line) {
  // "From " followed by something (envelope sender + date in classic mbox).
  // Guard against ">From " (escaped body lines) — those never match here.
  return /^From .+/.test(line) || line === 'From ';
}

/**
 * Streaming MBOX splitter. Feed decoded text chunks; complete raw messages are
 * emitted through the callback as soon as their end is known.
 *
 * A "From " line starts a new message only when it is the very first line of
 * the file or is preceded by a blank line (standard mbox framing). This avoids
 * splitting on unescaped "From ..." sentences inside message bodies in most
 * real archives, while still handling strict mboxo/mboxrd files.
 */
export class MboxSplitter {
  /**
   * @param {(msg: {separatorLine:string, raw:string, offset:number}) => void} onMessage
   */
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buffer = '';
    this.pending = null;        // { separatorLine, lines: [], offset }
    this.prevLineBlank = true;  // start-of-file counts as "after blank line"
    this.lineOffset = 0;
    this.messageCount = 0;
    this.sawAnySeparator = false;
  }

  /** @param {string} chunk */
  push(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this._handleLine(line);
      this.lineOffset += nl + 1;
    }
  }

  /** Flush the tail after the final chunk. */
  finish() {
    if (this.buffer.length) {
      this._handleLine(this.buffer.replace(/\r$/, ''));
      this.buffer = '';
    }
    this._emitPending();
  }

  _handleLine(line) {
    if (isFromSeparator(line) && (this.prevLineBlank || this.pending === null)) {
      this._emitPending();
      this.pending = { separatorLine: line, lines: [], offset: this.lineOffset };
      this.sawAnySeparator = true;
    } else if (this.pending) {
      this.pending.lines.push(line);
    } else {
      // Content before any separator (not a valid mbox, or a bare .eml):
      // collect it as message 0 with an empty separator.
      this.pending = { separatorLine: '', lines: [line], offset: this.lineOffset };
    }
    this.prevLineBlank = line === '';
  }

  _emitPending() {
    if (!this.pending) return;
    // Drop the trailing blank line that belongs to mbox framing, not the body
    const lines = this.pending.lines;
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    const raw = lines.join('\n');
    if (raw.trim() !== '' || this.pending.separatorLine) {
      this.onMessage({
        separatorLine: this.pending.separatorLine,
        raw,
        offset: this.pending.offset,
      });
      this.messageCount++;
    }
    this.pending = null;
  }
}

/**
 * Split a full mbox text into raw messages (convenience for tests/demo).
 * @param {string} text
 * @returns {Array<{separatorLine:string, raw:string, offset:number}>}
 */
export function splitMbox(text) {
  const out = [];
  const splitter = new MboxSplitter(m => out.push(m));
  splitter.push(text);
  splitter.finish();
  return out;
}

/**
 * Unescape ">From " body lines after extraction.
 * mboxrd escapes every ">*From " by adding one ">"; mboxo escapes only "From ".
 * @param {string} body
 * @param {'mboxrd'|'mboxo'} [variant]
 * @returns {string}
 */
export function unescapeFromLines(body, variant = 'mboxrd') {
  if (variant === 'mboxo') {
    return body.replace(/^>From /gm, 'From ');
  }
  return body.replace(/^>(>*From )/gm, '$1');
}

/**
 * Escape body lines beginning with "From " (and already-escaped variants)
 * when writing mboxrd output.
 * @param {string} body
 * @returns {string}
 */
export function escapeFromLines(body) {
  return body.replace(/^(>*From )/gm, '>$1');
}

/**
 * Build an mbox separator line for a message being exported.
 * @param {{separatorLine?:string, from?:{address:string}[], date?:number|null}} msg
 * @returns {string}
 */
export function buildSeparatorLine(msg) {
  if (msg.separatorLine && msg.separatorLine.startsWith('From ')) return msg.separatorLine;
  const addr = (msg.from && msg.from[0] && msg.from[0].address) || 'MAILER-DAEMON';
  const d = msg.date ? new Date(msg.date) : new Date(0);
  return `From ${addr} ${d.toUTCString().replace(/,/g, '').replace('GMT', '+0000')}`;
}

/**
 * Serialize messages back into a single mbox (mboxrd escaping).
 * Unedited messages keep their original raw source byte-for-byte; edited
 * messages are reconstructed by the caller before being passed in.
 * @param {Array<{separatorLine:string, raw:string}>} messages  raw = current source
 * @param {'\n'|'\r\n'} [eol]
 * @returns {string}
 */
export function serializeMbox(messages, eol = '\n') {
  const parts = [];
  for (const msg of messages) {
    const sep = buildSeparatorLine(msg);
    // Split headers from body: only body lines get From-escaping
    const raw = msg.raw;
    const gap = raw.search(/\r?\n\r?\n/);
    let headers = raw, body = '';
    if (gap !== -1) {
      headers = raw.slice(0, gap);
      body = raw.slice(gap + raw.slice(gap).match(/^\r?\n\r?\n/)[0].length);
    }
    const safeBody = escapeFromLines(body);
    let block = sep + '\n' + headers + '\n\n' + safeBody;
    if (!block.endsWith('\n')) block += '\n';
    parts.push(block);
  }
  const text = parts.join('\n');
  return eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n');
}
