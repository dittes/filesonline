// threads.js
// Best-effort conversation grouping using Message-ID / In-Reply-To /
// References, with normalized subject as a fallback. MBOX archives often have
// incomplete metadata, so this is heuristic by design.

/**
 * Normalize a subject for fallback grouping: strip Re:/Fwd:/Aw: prefixes.
 * @param {string} subject
 * @returns {string}
 */
export function normalizeSubject(subject) {
  return (subject || '')
    .replace(/^(\s*(re|fwd?|aw|wg|sv|antw)\s*(\[\d+\])?\s*:\s*)+/i, '')
    .trim()
    .toLowerCase();
}

/**
 * Assign msg.threadId to every message in place and return thread groups.
 * @param {import('./mime-parser.js').MboxMessage[]} messages
 * @returns {Map<string, import('./mime-parser.js').MboxMessage[]>} threadId → messages (sorted by date)
 */
export function buildThreads(messages) {
  // Union-find over message ids + referenced ids
  const parent = new Map();
  const find = (x) => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    let cur = x;
    while (parent.get(cur) !== root) { const next = parent.get(cur); parent.set(cur, root); cur = next; }
    return root;
  };
  const union = (a, b) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  const keyOf = (msg) => msg.messageId || `~idx:${msg.id}`;

  for (const msg of messages) {
    const key = keyOf(msg);
    if (!parent.has(key)) parent.set(key, key);
    const related = [...msg.references];
    if (msg.inReplyTo) related.push(msg.inReplyTo);
    for (const ref of related) union(key, ref);
  }

  // Subject fallback: messages with no references at all join a subject bucket
  // only when the subject looks like a reply (had a Re:/Fwd: prefix) or an
  // existing thread already uses that normalized subject.
  const subjectRoots = new Map();
  for (const msg of messages) {
    const hasRefs = msg.references.length > 0 || msg.inReplyTo;
    const norm = normalizeSubject(msg.subject);
    if (!norm) continue;
    const key = keyOf(msg);
    if (hasRefs) {
      if (!subjectRoots.has(norm)) subjectRoots.set(norm, key);
    }
  }
  for (const msg of messages) {
    const hasRefs = msg.references.length > 0 || msg.inReplyTo;
    if (hasRefs) continue;
    const norm = normalizeSubject(msg.subject);
    const isReply = norm && norm !== (msg.subject || '').trim().toLowerCase();
    const root = norm ? subjectRoots.get(norm) : null;
    if (root && isReply) union(root, keyOf(msg));
  }

  const threads = new Map();
  for (const msg of messages) {
    const tid = 't:' + find(keyOf(msg));
    msg.threadId = tid;
    if (!threads.has(tid)) threads.set(tid, []);
    threads.get(tid).push(msg);
  }
  for (const list of threads.values()) {
    list.sort((a, b) => (a.date ?? 0) - (b.date ?? 0));
  }
  return threads;
}
