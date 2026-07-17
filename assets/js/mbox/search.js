// search.js
// Query parsing and message matching for the MBOX viewer.
// Supported syntax: free terms, "exact phrases", -negation, and the operators
// from: to: cc: subject: label: after: before: has:attachment is:read
// is:unread is:starred

/**
 * @typedef {Object} ParsedQuery
 * @property {Array<{field:string|null, value:string, negated:boolean, phrase:boolean}>} terms
 */

/**
 * Parse a query string into structured terms.
 * @param {string} query
 * @returns {ParsedQuery}
 */
export function parseQuery(query) {
  const terms = [];
  if (!query || !query.trim()) return { terms };
  // Tokenize: field:"quoted value" | field:value | "phrase" | word — with optional leading -
  const re = /(-?)(?:([a-zA-Z]+):)?(?:"([^"]*)"|(\S+))/g;
  let m;
  while ((m = re.exec(query)) !== null) {
    const negated = m[1] === '-';
    let field = m[2] ? m[2].toLowerCase() : null;
    const phrase = m[3] !== undefined;
    let value = (phrase ? m[3] : m[4]) || '';
    if (!value) continue;
    const knownFields = ['from', 'to', 'cc', 'bcc', 'subject', 'label', 'after', 'before', 'has', 'is', 'note', 'header', 'filename'];
    if (field && !knownFields.includes(field)) {
      // Unknown operator: treat the whole token as a plain term
      value = field + ':' + value;
      field = null;
    }
    terms.push({ field, value: value.toLowerCase(), negated, phrase });
  }
  return { terms };
}

/** Lowercased address list as one string. */
function addrText(list) {
  return list.map(a => `${a.name} ${a.address}`).join(' ').toLowerCase();
}

/**
 * Lazily build and cache the full-text blob for body/header search.
 * @param {import('./mime-parser.js').MboxMessage} msg
 */
function searchBlob(msg) {
  if (!msg._blob) {
    msg._blob = [
      msg.subject, addrText(msg.from), addrText(msg.to), addrText(msg.cc), addrText(msg.bcc),
      msg.textBody || '', msg.htmlBody ? msg.htmlBody.replace(/<[^>]+>/g, ' ') : '',
      msg.rawHeaders || '',
      msg.attachments.map(a => a.filename).join(' '),
      msg.labels.join(' '), msg.localNote || '',
    ].join('\n').toLowerCase();
  }
  return msg._blob;
}

/**
 * Test one message against one term.
 * @returns {boolean} match (before negation is applied)
 */
function termMatches(msg, term) {
  const v = term.value;
  const eff = msg.edited || msg;
  switch (term.field) {
    case 'from': return addrText(eff.from || msg.from).includes(v);
    case 'to': return addrText(eff.to || msg.to).includes(v);
    case 'cc': return addrText(msg.cc).includes(v);
    case 'bcc': return addrText(msg.bcc).includes(v);
    case 'subject': return String(eff.subject ?? msg.subject).toLowerCase().includes(v);
    case 'label': return msg.labels.some(l => l.toLowerCase().includes(v));
    case 'note': return (msg.localNote || '').toLowerCase().includes(v);
    case 'filename': return msg.attachments.some(a => a.filename.toLowerCase().includes(v));
    case 'header': return (msg.rawHeaders || '').toLowerCase().includes(v);
    case 'after': {
      const t = Date.parse(v);
      return !Number.isNaN(t) && msg.date !== null && msg.date >= t;
    }
    case 'before': {
      const t = Date.parse(v);
      return !Number.isNaN(t) && msg.date !== null && msg.date < t;
    }
    case 'has':
      if (v === 'attachment' || v === 'attachments') return msg.attachments.some(a => !a.inline) || msg.attachments.length > 0;
      return false;
    case 'is':
      if (v === 'read') return !!msg.flags.read;
      if (v === 'unread') return !msg.flags.read;
      if (v === 'starred') return !!msg.flags.starred;
      if (v === 'edited') return !!msg.edited;
      return false;
    default:
      return searchBlob(msg).includes(v);
  }
}

/**
 * Test a message against a parsed query (AND semantics across terms).
 * @param {import('./mime-parser.js').MboxMessage} msg
 * @param {ParsedQuery} pq
 * @returns {boolean}
 */
export function matchMessage(msg, pq) {
  for (const term of pq.terms) {
    const hit = termMatches(msg, term);
    if (term.negated ? hit : !hit) return false;
  }
  return true;
}

/**
 * Filter a message list by query string.
 * @param {import('./mime-parser.js').MboxMessage[]} messages
 * @param {string} query
 * @returns {import('./mime-parser.js').MboxMessage[]}
 */
export function searchMessages(messages, query) {
  const pq = parseQuery(query);
  if (!pq.terms.length) return messages.slice();
  return messages.filter(m => matchMessage(m, pq));
}

/** Plain-text terms of a query (for highlight). */
export function highlightTerms(query) {
  return parseQuery(query).terms
    .filter(t => !t.negated && (t.field === null || t.field === 'subject'))
    .map(t => t.value)
    .filter(v => v.length >= 2);
}

/** Invalidate a message's cached search blob (after edits/notes/labels). */
export function invalidateSearchCache(msg) {
  delete msg._blob;
}
