// app.js — MBOX Viewer entry point.
// Wires the parsing worker, search, threads, storage and export modules to the
// three-pane UI in /open-mbox-file/index.html. Parsing logic lives in the
// worker + parser modules; this file is UI and state only.

import { initTheme } from '../theme.js';
import { showToast } from '../ui.js';
import { formatBytes, escapeHtml, debounce, downloadBlob, generateId, sanitizeFilename } from '../utils.js';
import { decodeAttachmentBytes, decodePartText } from './mime-parser.js';
import { searchMessages, highlightTerms, invalidateSearchCache } from './search.js';
import { buildThreads } from './threads.js';
import * as store from './storage.js';
import * as exporter from './export.js';
import { generateDemoFile } from './demo.js';

const DOMPURIFY_CDN = 'https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js';

// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  archives: new Map(),        // id → { id, name, fileSize, report, persisted }
  messages: [],               // all messages, source order
  visible: [],                // filtered + sorted list (or thread roots in thread view)
  threads: new Map(),         // threadId → messages
  selection: new Set(),       // message ids (multi-select)
  activeId: null,
  query: '',
  filter: { kind: 'all', value: null },  // sidebar filter
  sort: 'newest',
  density: 'comfortable',
  threadView: false,
  parsing: false,
  worker: null,
  objectUrls: [],
  editHistory: [], editFuture: [],       // undo/redo for the open editor
  prefs: store.loadPrefs(),
};

const byId = new Map(); // message id → message

// ─── DOM lookup ──────────────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const el = {};
const IDS = [
  'app', 'hero', 'dropzone', 'file-input', 'drop-overlay',
  'archive-name', 'archive-stats', 'parse-status',
  'search', 'search-chips', 'sidebar', 'sidebar-filters', 'sidebar-senders', 'sidebar-dates', 'sidebar-labels', 'sidebar-archives',
  'list', 'list-inner', 'list-empty', 'list-count', 'sort', 'density-btn', 'threadview-btn', 'select-all',
  'progress', 'progress-bar', 'progress-label', 'progress-cancel',
  'viewer', 'viewer-empty', 'viewer-content', 'viewer-subject', 'viewer-meta', 'viewer-badges',
  'tabs', 'body-rendered', 'body-frame', 'remote-banner', 'load-remote-btn', 'body-text', 'body-headers', 'body-raw', 'body-edit',
  'attachments', 'attachments-list', 'note', 'thread-info',
  'report-modal', 'report-body', 'settings-modal', 'settings-body', 'context-menu',
  'edit-subject', 'edit-from', 'edit-to', 'edit-cc', 'edit-date', 'edit-text', 'edit-html', 'edit-labels', 'edit-htmlmode',
];
function grabDom() {
  for (const id of IDS) el[id.replace(/-/g, '_')] = document.getElementById('mbx-' + id);
}

// ─── Boot ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  grabDom();
  initTheme();
  applyPrefs();
  wireToolbar();
  wireDropzone();
  wireList();
  wireViewer();
  wireKeyboard();
  wireContextMenu();
  refreshSavedArchives();
});

function applyPrefs() {
  state.density = state.prefs.density || 'comfortable';
  state.sort = state.prefs.sort || 'newest';
  if (el.sort) el.sort.value = state.sort;
  document.documentElement.style.setProperty('--mbx-font-scale', String(state.prefs.fontScale || 1));
}

function savePrefsNow() {
  store.savePrefs({ ...state.prefs, density: state.density, sort: state.sort });
}

// ─── Import pipeline ────────────────────────────────────────────────────────

function openFilePicker() { el.file_input.click(); }

async function importFiles(fileList) {
  const files = [...fileList].filter(f =>
    /\.(mbox|mbx|eml|txt)$/i.test(f.name) || !/\./.test(f.name) || f.type === 'application/mbox' || f.size > 0);
  if (!files.length) { showToast('No importable files found. Drop .mbox files (extension optional).', 'warning'); return; }
  for (const file of files) {
    await parseOneFile(file);
  }
}

function parseOneFile(file) {
  return new Promise((resolve) => {
    const archiveId = generateId();
    const archive = { id: archiveId, name: file.name || 'archive.mbox', fileSize: file.size, report: null, persisted: false };
    state.archives.set(archiveId, archive);
    state.parsing = true;
    showAppShell();
    el.progress.hidden = false;
    el.progress_label.textContent = 'Reading file…';
    el.progress_bar.style.width = '0%';
    setParseStatus('Parsing ' + archive.name + '…');

    let worker;
    try {
      worker = new Worker('/assets/js/mbox/worker.js', { type: 'module' });
    } catch (err) {
      state.archives.delete(archiveId);
      state.parsing = false;
      el.progress.hidden = true;
      setParseStatus('');
      showToast('Could not start the parsing worker. If you opened index.html from file://, please serve the folder over http (see README).', 'error', 9000);
      if (!state.messages.length) showHero();
      resolve();
      return;
    }
    state.worker = worker;
    const newMessages = [];

    const finishParse = (errorMsg) => {
      worker.terminate();
      state.worker = null;
      state.parsing = false;
      el.progress.hidden = true;
      if (errorMsg) {
        state.archives.delete(archiveId);
        setParseStatus('');
        showToast(errorMsg, errorMsg === 'Cancelled' ? 'info' : 'error', 7000);
        if (!state.messages.length) showHero();
      }
      resolve();
    };

    worker.onerror = (e) => finishParse('Parsing failed: ' + (e.message || 'worker error'));
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'phase') {
        el.progress_label.textContent = `${msg.phase}/5 · ${msg.label}`;
        setParseStatus(msg.label + '…');
      } else if (msg.type === 'progress') {
        const pct = msg.bytesTotal ? Math.round((msg.bytesRead / msg.bytesTotal) * 100) : 0;
        el.progress_bar.style.width = pct + '%';
        el.progress_label.textContent = `Reading ${formatBytes(msg.bytesRead)} of ${formatBytes(msg.bytesTotal)} · ${msg.messages.toLocaleString()} messages`;
      } else if (msg.type === 'messages') {
        newMessages.push(...msg.batch);
      } else if (msg.type === 'error') {
        finishParse(msg.message === 'Cancelled' ? 'Cancelled' : `${archive.name}: ${msg.message}`);
      } else if (msg.type === 'done') {
        archive.report = msg.report;
        integrateMessages(newMessages);
        setParseStatus('Ready');
        el.progress.hidden = true;
        state.parsing = false;
        worker.terminate();
        state.worker = null;
        if (msg.report.noSeparators) {
          showToast('No mbox separators found — imported the file as a single message.', 'warning', 8000);
        }
        showImportReport(archive);
        resolve();
      }
    };

    worker.postMessage({ type: 'parse', file, archiveId });
  });
}

function cancelParsing() {
  if (state.worker) state.worker.postMessage({ type: 'cancel' });
}

function integrateMessages(newMessages) {
  for (const m of newMessages) {
    state.messages.push(m);
    byId.set(m.id, m);
  }
  state.threads = buildThreads(state.messages);
  updateArchiveHeader();
  renderSidebar();
  applyFilters();
  showAppShell();
}

function setParseStatus(text) {
  el.parse_status.textContent = text;
  el.parse_status.hidden = !text;
}

function updateArchiveHeader() {
  const archives = [...state.archives.values()];
  el.archive_name.textContent = archives.length === 1 ? archives[0].name : `${archives.length} archives`;
  const size = archives.reduce((s, a) => s + a.fileSize, 0);
  el.archive_stats.textContent = `${formatBytes(size)} · ${state.messages.length.toLocaleString()} messages`;
}

function showAppShell() {
  el.app.hidden = false;
  el.hero.classList.add('mbx-hero-compact');
  document.body.classList.add('mbx-active');
}

function showHero() {
  el.app.hidden = true;
  el.hero.classList.remove('mbx-hero-compact');
  document.body.classList.remove('mbx-active');
}

// ─── Import report ──────────────────────────────────────────────────────────

function showImportReport(archive) {
  const r = archive.report;
  if (!r) return;
  const row = (label, value, warn) =>
    `<div class="mbx-report-row${warn && value ? ' mbx-report-warn' : ''}"><span>${label}</span><strong>${value.toLocaleString()}</strong></div>`;
  el.report_body.innerHTML = `
    <p class="mbx-report-file">${escapeHtml(r.fileName)} · ${formatBytes(r.fileSize)}</p>
    ${row('Messages imported', r.imported)}
    ${row('Messages with warnings', r.withWarnings, true)}
    ${row('Messages not fully decodable', r.undecodable, true)}
    ${row('Duplicate Message-IDs', r.duplicateMessageIds, true)}
    ${row('Unknown character sets', r.unknownCharsets, true)}
    ${row('Total attachments', r.totalAttachments)}
  `;
  openModal(el.report_modal);
}

// ─── Sidebar ────────────────────────────────────────────────────────────────

function ownerAddressGuess() {
  // Heuristic: the address most often present in To/Cc is probably the owner
  const counts = new Map();
  for (const m of state.messages) {
    for (const a of [...m.to, ...m.cc]) {
      if (a.address) counts.set(a.address.toLowerCase(), (counts.get(a.address.toLowerCase()) || 0) + 1);
    }
  }
  let best = null, bestN = 0;
  for (const [addr, n] of counts) if (n > bestN) { best = addr; bestN = n; }
  return best;
}

function sidebarCounts() {
  const owner = ownerAddressGuess();
  const c = { all: state.messages.length, unread: 0, read: 0, starred: 0, attachments: 0, sent: 0, received: 0, drafts: 0, deleted: 0, edited: 0 };
  for (const m of state.messages) {
    if (m.flags.read) c.read++; else c.unread++;
    if (m.flags.starred) c.starred++;
    if (m.attachments.length) c.attachments++;
    if (m.flags.draft) c.drafts++;
    if (m.flags.deleted) c.deleted++;
    if (m.edited) c.edited++;
    const fromOwner = owner && m.from.some(a => a.address.toLowerCase() === owner);
    if (fromOwner) c.sent++; else c.received++;
  }
  return c;
}

function renderSidebar() {
  const c = sidebarCounts();
  const item = (kind, label, count, value = null) => {
    const active = state.filter.kind === kind && state.filter.value === value;
    return `<button class="mbx-nav-item${active ? ' active' : ''}" data-filter="${kind}" ${value !== null ? `data-value="${escapeHtml(String(value))}"` : ''}>
      <span>${label}</span><span class="mbx-nav-count">${count.toLocaleString()}</span></button>`;
  };
  el.sidebar_filters.innerHTML = [
    item('all', 'All messages', c.all),
    item('unread', 'Unread', c.unread),
    item('read', 'Read', c.read),
    item('starred', 'Starred', c.starred),
    item('attachments', 'Has attachments', c.attachments),
    item('sent', 'Sent', c.sent),
    item('received', 'Received', c.received),
    c.drafts ? item('drafts', 'Drafts', c.drafts) : '',
    c.deleted ? item('deleted', 'Deleted', c.deleted) : '',
    c.edited ? item('edited', 'Edited locally', c.edited) : '',
  ].join('');

  // Date groups (by year)
  const years = new Map();
  for (const m of state.messages) {
    const y = m.date ? new Date(m.date).getFullYear() : 'Unknown';
    years.set(y, (years.get(y) || 0) + 1);
  }
  el.sidebar_dates.innerHTML = [...years.entries()]
    .sort((a, b) => String(b[0]).localeCompare(String(a[0])))
    .map(([y, n]) => item('year', String(y), n, y)).join('');

  // Top senders
  const senders = new Map();
  for (const m of state.messages) {
    const a = m.from[0];
    if (!a || !a.address) continue;
    const key = a.address.toLowerCase();
    const cur = senders.get(key) || { n: 0, name: a.name || a.address };
    cur.n++;
    senders.set(key, cur);
  }
  el.sidebar_senders.innerHTML = [...senders.entries()]
    .sort((a, b) => b[1].n - a[1].n).slice(0, 15)
    .map(([addr, { n, name }]) => item('sender', escapeHtml(name || addr), n, addr)).join('');

  // Labels
  const labels = new Map();
  for (const m of state.messages) for (const l of m.labels) labels.set(l, (labels.get(l) || 0) + 1);
  el.sidebar_labels.innerHTML = [...labels.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 30)
    .map(([l, n]) => item('label', escapeHtml(l), n, l)).join('');
  el.sidebar_labels.closest('.mbx-nav-group').hidden = labels.size === 0;

  el.sidebar.querySelectorAll('.mbx-nav-item[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.filter = { kind: btn.dataset.filter, value: btn.dataset.value ?? null };
      renderSidebar();
      applyFilters();
    });
  });
}

// ─── Filtering, sorting, list rendering ─────────────────────────────────────

function passesSidebarFilter(m) {
  const f = state.filter;
  switch (f.kind) {
    case 'all': return true;
    case 'unread': return !m.flags.read;
    case 'read': return m.flags.read;
    case 'starred': return m.flags.starred;
    case 'attachments': return m.attachments.length > 0;
    case 'drafts': return m.flags.draft;
    case 'deleted': return m.flags.deleted;
    case 'edited': return !!m.edited;
    case 'sent': {
      const owner = ownerAddressGuess();
      return owner ? m.from.some(a => a.address.toLowerCase() === owner) : false;
    }
    case 'received': {
      const owner = ownerAddressGuess();
      return owner ? !m.from.some(a => a.address.toLowerCase() === owner) : true;
    }
    case 'year': {
      const y = m.date ? String(new Date(m.date).getFullYear()) : 'Unknown';
      return y === String(f.value);
    }
    case 'sender': return m.from.some(a => a.address.toLowerCase() === String(f.value).toLowerCase());
    case 'label': return m.labels.includes(f.value);
    default: return true;
  }
}

function applyFilters() {
  let list = state.messages.filter(passesSidebarFilter);
  if (state.query.trim()) list = searchMessages(list, state.query);

  const senderName = m => ((m.edited?.from ?? m.from)[0]?.name || (m.edited?.from ?? m.from)[0]?.address || '').toLowerCase();
  const subj = m => String(m.edited?.subject ?? m.subject).toLowerCase();
  const sorters = {
    newest: (a, b) => (b.date ?? 0) - (a.date ?? 0),
    oldest: (a, b) => (a.date ?? 0) - (b.date ?? 0),
    sender: (a, b) => senderName(a).localeCompare(senderName(b)) || (b.date ?? 0) - (a.date ?? 0),
    subject: (a, b) => subj(a).localeCompare(subj(b)) || (b.date ?? 0) - (a.date ?? 0),
    attachments: (a, b) => b.attachments.length - a.attachments.length || (b.date ?? 0) - (a.date ?? 0),
  };
  list.sort(sorters[state.sort] || sorters.newest);

  if (state.threadView) {
    // Collapse to one row per thread (latest message represents the thread)
    const seen = new Set();
    const rows = [];
    for (const m of list) {
      if (seen.has(m.threadId)) continue;
      seen.add(m.threadId);
      rows.push(m);
    }
    state.visible = rows;
  } else {
    state.visible = list;
  }

  renderSearchChips();
  el.list_count.textContent = state.threadView
    ? `${state.visible.length.toLocaleString()} conversations`
    : `${state.visible.length.toLocaleString()} messages`;
  el.list_empty.hidden = state.visible.length > 0 || state.parsing;
  renderList();
}

// Virtualized list
const ROW_HEIGHTS = { compact: 44, comfortable: 64, spacious: 80 };

function rowHeight() { return ROW_HEIGHTS[state.density] || 64; }

function renderList() {
  const h = rowHeight();
  el.list_inner.style.height = state.visible.length * h + 'px';
  renderVisibleRows();
}

function renderVisibleRows() {
  const h = rowHeight();
  const scrollTop = el.list.scrollTop;
  const height = el.list.clientHeight || 600;
  const start = Math.max(0, Math.floor(scrollTop / h) - 8);
  const end = Math.min(state.visible.length, Math.ceil((scrollTop + height) / h) + 8);
  const terms = highlightTerms(state.query);
  const frag = [];
  for (let i = start; i < end; i++) frag.push(rowHtml(state.visible[i], i, h, terms));
  el.list_inner.innerHTML = frag.join('');
  el.list_inner.querySelectorAll('.mbx-row').forEach(row => {
    row.addEventListener('click', (e) => onRowClick(row.dataset.id, e));
    row.addEventListener('dblclick', () => openReadingWindow(byId.get(row.dataset.id)));
  });
}

function markHtml(text, terms) {
  let out = escapeHtml(text);
  for (const t of terms) {
    const re = new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
    out = out.replace(re, '<mark>$1</mark>');
  }
  return out;
}

function rowHtml(m, index, h, terms) {
  const eff = m.edited || m;
  const from = (eff.from ?? m.from)[0];
  const sender = from ? (from.name || from.address) : '(unknown sender)';
  const date = m.date ? formatShortDate(m.date) : '—';
  const threadCount = state.threadView ? (state.threads.get(m.threadId)?.length || 1) : 1;
  const selected = state.selection.has(m.id);
  const cls = [
    'mbx-row',
    m.flags.read ? '' : 'mbx-unread',
    m.id === state.activeId ? 'mbx-row-active' : '',
    selected ? 'mbx-row-selected' : '',
  ].filter(Boolean).join(' ');
  return `<div class="${cls}" data-id="${m.id}" role="option" aria-selected="${m.id === state.activeId}"
    style="top:${index * h}px;height:${h}px" tabindex="-1">
    <span class="mbx-row-star${m.flags.starred ? ' starred' : ''}" data-star title="Star">${m.flags.starred ? '★' : '☆'}</span>
    <div class="mbx-row-main">
      <div class="mbx-row-top">
        <span class="mbx-row-sender">${markHtml(sender, terms)}${threadCount > 1 ? ` <span class="mbx-row-threadcount">${threadCount}</span>` : ''}</span>
        <span class="mbx-row-date">${date}</span>
      </div>
      <div class="mbx-row-mid">
        <span class="mbx-row-subject">${markHtml((eff.subject ?? m.subject) || '(no subject)', terms)}</span>
        ${m.attachments.length ? '<span class="mbx-row-att" title="Has attachments">📎</span>' : ''}
        ${m.edited ? '<span class="mbx-row-edited" title="Edited locally">✎</span>' : ''}
        ${m.warnings.length ? '<span class="mbx-row-warn" title="' + escapeHtml(m.warnings.join('; ')) + '">⚠</span>' : ''}
      </div>
      ${state.density !== 'compact' ? `<div class="mbx-row-preview">${markHtml(m.preview || '', terms)}</div>` : ''}
    </div>
  </div>`;
}

function formatShortDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

function onRowClick(id, e) {
  const msg = byId.get(id);
  if (!msg) return;
  if (e.target.hasAttribute('data-star')) { toggleStar(msg); return; }
  if (e.metaKey || e.ctrlKey) {
    if (state.selection.has(id)) state.selection.delete(id); else state.selection.add(id);
    renderVisibleRows();
    return;
  }
  if (e.shiftKey && state.activeId) {
    const a = state.visible.findIndex(m => m.id === state.activeId);
    const b = state.visible.findIndex(m => m.id === id);
    if (a !== -1 && b !== -1) {
      state.selection.clear();
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) state.selection.add(state.visible[i].id);
      renderVisibleRows();
      return;
    }
  }
  state.selection.clear();
  state.selection.add(id);
  openMessage(msg);
}

// ─── Search ────────────────────────────────────────────────────────────────

function renderSearchChips() {
  const chips = state.query.trim()
    ? state.query.match(/(-?\w+:"[^"]*"|-?\w+:\S+|"[^"]*"|-?\S+)/g) || []
    : [];
  el.search_chips.innerHTML = chips.map((c, i) =>
    `<span class="mbx-chip">${escapeHtml(c)}<button data-chip="${i}" aria-label="Remove filter ${escapeHtml(c)}">×</button></span>`).join('');
  el.search_chips.hidden = chips.length === 0;
  el.search_chips.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      chips.splice(+btn.dataset.chip, 1);
      state.query = chips.join(' ');
      el.search.value = state.query;
      applyFilters();
    });
  });
}

// ─── Message viewer ─────────────────────────────────────────────────────────

let currentTab = 'rendered';

function openMessage(msg) {
  state.activeId = msg.id;
  if (!msg.flags.read) { msg.flags.read = true; persistIfSaved(msg); renderSidebar(); }
  cleanupObjectUrls();
  el.viewer_empty.hidden = true;
  el.viewer_content.hidden = false;
  renderViewer(msg);
  renderVisibleRows();
}

function activeMessage() { return byId.get(state.activeId) || null; }

function renderViewer(msg) {
  const eff = msg.edited || msg;
  el.viewer_subject.innerHTML = markHtml((eff.subject ?? msg.subject) || '(no subject)', highlightTerms(state.query));

  const addr = list => (list || []).map(a =>
    `<span class="mbx-addr" title="${escapeHtml(a.address)}">${escapeHtml(a.name || a.address)}</span>`).join(', ') || '—';
  el.viewer_meta.innerHTML = `
    <div><span class="mbx-meta-label">From</span>${addr(eff.from ?? msg.from)}</div>
    <div><span class="mbx-meta-label">To</span>${addr(eff.to ?? msg.to)}</div>
    ${msg.cc.length ? `<div><span class="mbx-meta-label">Cc</span>${addr(msg.cc)}</div>` : ''}
    <div><span class="mbx-meta-label">Date</span>${msg.date ? new Date(eff.date ?? msg.date).toLocaleString() : '(no valid date)'}</div>
    ${msg.messageId ? `<div><span class="mbx-meta-label">ID</span><code class="mbx-mid">${escapeHtml(msg.messageId)}</code></div>` : ''}
  `;

  el.viewer_badges.innerHTML = [
    msg.edited ? '<span class="badge badge-neutral mbx-badge-warn">Edited locally — signatures invalidated</span>' : '',
    msg.warnings.length ? `<span class="badge badge-neutral mbx-badge-warn" title="${escapeHtml(msg.warnings.join('; '))}">⚠ ${msg.warnings.length} parsing warning${msg.warnings.length > 1 ? 's' : ''}</span>` : '',
    ...msg.labels.map(l => `<span class="badge badge-neutral">${escapeHtml(l)}</span>`),
  ].filter(Boolean).join('');

  // Thread info
  const thread = state.threads.get(msg.threadId) || [];
  if (thread.length > 1) {
    el.thread_info.hidden = false;
    el.thread_info.innerHTML = `<span class="mbx-thread-label">Conversation · ${thread.length} messages (best-effort grouping)</span>` +
      thread.map(t => `<button class="mbx-thread-item${t.id === msg.id ? ' active' : ''}" data-id="${t.id}">
        <span>${escapeHtml((t.from[0]?.name || t.from[0]?.address || '?'))}</span>
        <span class="mbx-thread-date">${t.date ? formatShortDate(t.date) : '—'}</span></button>`).join('');
    el.thread_info.querySelectorAll('.mbx-thread-item').forEach(b =>
      b.addEventListener('click', () => openMessage(byId.get(b.dataset.id))));
  } else {
    el.thread_info.hidden = true;
  }

  renderAttachments(msg);
  renderNote(msg);
  setTab(currentTab === 'edit' ? 'rendered' : currentTab, msg);
  syncViewerActions(msg);
}

function syncViewerActions(msg) {
  const starBtn = $('#mbx-act-star');
  if (starBtn) starBtn.textContent = msg.flags.starred ? '★ Starred' : '☆ Star';
  const readBtn = $('#mbx-act-read');
  if (readBtn) readBtn.textContent = msg.flags.read ? 'Mark unread' : 'Mark read';
}

function setTab(tab, msg = activeMessage()) {
  currentTab = tab;
  el.tabs.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  el.body_rendered.hidden = tab !== 'rendered';
  el.body_text.hidden = tab !== 'text';
  el.body_headers.hidden = tab !== 'headers';
  el.body_raw.hidden = tab !== 'raw';
  el.body_edit.hidden = tab !== 'edit';
  if (!msg) return;
  if (tab === 'rendered') renderBody(msg, false);
  if (tab === 'text') renderPlainText(msg);
  if (tab === 'headers') el.body_headers.innerHTML = `<table class="mbx-headers-table">${msg.headers.map(h =>
    `<tr><th>${escapeHtml(h.name)}</th><td>${escapeHtml(h.value)}</td></tr>`).join('')}</table>`;
  if (tab === 'raw') el.body_raw.textContent = msg.raw;
  if (tab === 'edit') renderEditor(msg);
}

// ─── Rendering (sanitized, sandboxed) ───────────────────────────────────────

let purifyPromise = null;
function ensurePurify() {
  if (window.DOMPurify) return Promise.resolve();
  if (!purifyPromise) {
    purifyPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = DOMPURIFY_CDN;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Sanitizer could not be loaded'));
      document.head.appendChild(s);
    });
  }
  return purifyPromise;
}

/**
 * Sanitize an HTML body. Blocks scripts/forms; remote resources are stripped
 * into data-mbx-remote so "Load remote content" can restore them.
 * @returns {Promise<{html:string, remoteBlocked:number}>}
 */
async function sanitizeEmailHtml(html, msg, allowRemote) {
  await ensurePurify();
  const clean = window.DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS: ['script', 'form', 'input', 'button', 'select', 'textarea', 'iframe', 'object', 'embed', 'base', 'meta'],
    FORBID_ATTR: ['onerror', 'onload', 'srcset'],
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
  const doc = new DOMParser().parseFromString(clean, 'text/html');
  let remoteBlocked = 0;

  // cid: inline images → object URLs from attachments
  doc.querySelectorAll('[src]').forEach(node => {
    const src = node.getAttribute('src') || '';
    if (src.toLowerCase().startsWith('cid:')) {
      const cid = src.slice(4).replace(/[<>]/g, '');
      const att = msg.attachments.find(a => a.contentId === cid);
      if (att) {
        const url = URL.createObjectURL(new Blob([decodeAttachmentBytes(att)], { type: att.mimeType }));
        state.objectUrls.push(url);
        node.setAttribute('src', url);
      } else {
        node.removeAttribute('src');
      }
    } else if (/^https?:/i.test(src)) {
      if (!allowRemote) {
        node.setAttribute('data-mbx-remote', src);
        node.removeAttribute('src');
        remoteBlocked++;
      }
    } else if (!/^(data:|blob:)/i.test(src)) {
      node.removeAttribute('src'); // javascript:, file:, relative — drop
    }
  });
  // Remote CSS backgrounds
  doc.querySelectorAll('[style]').forEach(node => {
    const style = node.getAttribute('style') || '';
    if (/url\s*\(\s*['"]?https?:/i.test(style)) {
      if (!allowRemote) {
        node.setAttribute('data-mbx-remote-style', style);
        node.setAttribute('style', style.replace(/url\s*\(\s*['"]?https?:[^)]*\)/gi, 'none'));
        remoteBlocked++;
      }
    }
  });
  // Links: force new tab, block javascript:
  doc.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href') || '';
    if (!/^(https?:|mailto:)/i.test(href)) a.removeAttribute('href');
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  return { html: doc.documentElement.outerHTML, remoteBlocked };
}

async function renderBody(msg, allowRemote) {
  const eff = msg.edited || msg;
  const html = eff.htmlBody ?? msg.htmlBody;
  el.remote_banner.hidden = true;
  if (html) {
    try {
      const { html: safe, remoteBlocked } = await sanitizeEmailHtml(html, msg, allowRemote);
      setFrameContent(wrapEmailHtml(safe));
      if (remoteBlocked > 0) el.remote_banner.hidden = false;
      return;
    } catch (err) {
      showToast('HTML sanitizer unavailable — showing plain text instead.', 'warning');
    }
  }
  // Plain text fallback in the rendered tab
  setFrameContent(wrapEmailHtml(`<div class="mbx-plain">${plainTextToHtml((eff.textBody ?? msg.textBody) || '(This message has no displayable body.)')}</div>`));
}

function wrapEmailHtml(inner) {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:system-ui,-apple-system,sans-serif;font-size:calc(14px * var(--fs,1));line-height:1.6;margin:16px;
      color:${dark ? '#EDEDEF' : '#1C1C1A'};background:${dark ? '#18181C' : '#FFFFFF'};overflow-wrap:break-word;}
    img{max-width:100%;height:auto;}
    pre,.mbx-plain{white-space:pre-wrap;font-family:inherit;}
    blockquote{border-left:3px solid ${dark ? '#3F3F47' : '#CCCCCA'};margin:8px 0;padding:2px 12px;color:${dark ? '#A6A6AD' : '#5A5956'};}
    details.mbx-quote summary{cursor:pointer;color:${dark ? '#71717A' : '#9A9896'};font-size:12px;user-select:none;}
    a{color:${dark ? '#5B8DEF' : '#1B4FD8'};}
    mark{background:${dark ? '#4a3f10' : '#FEF3C7'};color:inherit;}
    table{max-width:100%;}
  </style></head><body>${inner}</body></html>`;
}

function setFrameContent(html) {
  // sandbox with no allow-scripts: scripts, forms, downloads, popups all blocked
  el.body_frame.srcdoc = html;
}

function renderPlainText(msg) {
  const eff = msg.edited || msg;
  const text = (eff.textBody ?? msg.textBody) || '(This message has no plain-text body.)';
  el.body_text.innerHTML = `<div class="mbx-plainwrap">${plainTextToHtml(text, highlightTerms(state.query))}</div>`;
}

/**
 * Escape + linkify plain text, collapse quoted replies and signatures.
 */
function plainTextToHtml(text, terms = []) {
  const lines = text.split('\n');
  const blocks = [];
  let i = 0;
  // Signature: everything after a "-- " line near the end
  let sigStart = -1;
  for (let k = lines.length - 1; k >= Math.max(0, lines.length - 15); k--) {
    if (lines[k].trimEnd() === '--') { sigStart = k; break; }
  }
  const renderLines = (ls) => ls.map(l => {
    let html = escapeHtml(l);
    html = html.replace(/(https?:\/\/[^\s<>"']+)/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
    for (const t of terms) {
      const re = new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?![^<]*>)', 'ig');
      html = html.replace(re, '<mark>$1</mark>');
    }
    return html;
  }).join('\n');

  while (i < lines.length) {
    if (sigStart !== -1 && i === sigStart) {
      blocks.push(`<details class="mbx-quote"><summary>— Signature (${lines.length - sigStart} lines)</summary><pre>${renderLines(lines.slice(sigStart))}</pre></details>`);
      break;
    }
    if (/^\s*>/.test(lines[i])) {
      const start = i;
      while (i < lines.length && (/^\s*>/.test(lines[i]) || lines[i].trim() === '')) i++;
      while (i > start && lines[i - 1].trim() === '') i--;
      const quoted = lines.slice(start, i);
      blocks.push(`<details class="mbx-quote"><summary>Quoted text (${quoted.length} lines)</summary><pre>${renderLines(quoted)}</pre></details>`);
    } else {
      const start = i;
      while (i < lines.length && !/^\s*>/.test(lines[i]) && !(sigStart !== -1 && i === sigStart)) i++;
      blocks.push(`<pre class="mbx-textblock">${renderLines(lines.slice(start, i))}</pre>`);
    }
  }
  return blocks.join('');
}

// ─── Attachments ────────────────────────────────────────────────────────────

const RISKY_EXT = /\.(html?|svg|js|mjs|exe|msi|bat|cmd|scr|com|pif|jar|vbs|ps1|docm|xlsm|pptm|apk|dmg)$/i;
const PREVIEWABLE = /^(image\/(png|jpe?g|gif|webp|bmp)|application\/pdf|text\/plain|audio\/|video\/)/i;

function renderAttachments(msg) {
  const atts = msg.attachments;
  el.attachments.hidden = atts.length === 0;
  if (!atts.length) return;
  el.attachments_list.innerHTML = atts.map((a, i) => `
    <div class="mbx-att" data-att="${i}">
      <span class="mbx-att-icon">${a.inline ? '🖼' : '📄'}</span>
      <span class="mbx-att-name" title="${escapeHtml(a.filename)}">${escapeHtml(a.filename)}</span>
      <span class="mbx-att-meta">${escapeHtml(a.mimeType)} · ${formatBytes(a.size)}${a.inline ? ' · inline' : ''}</span>
      ${PREVIEWABLE.test(a.mimeType) && !RISKY_EXT.test(a.filename) ? `<button class="btn btn-ghost btn-sm" data-att-preview="${i}">Preview</button>` : ''}
      <button class="btn btn-secondary btn-sm" data-att-dl="${i}">Download</button>
    </div>`).join('') +
    (atts.length > 1 ? `<button class="btn btn-ghost btn-sm" id="mbx-att-all">Download all as ZIP</button>` : '');

  el.attachments_list.querySelectorAll('[data-att-dl]').forEach(btn =>
    btn.addEventListener('click', () => downloadAttachment(msg, +btn.dataset.attDl)));
  el.attachments_list.querySelectorAll('[data-att-preview]').forEach(btn =>
    btn.addEventListener('click', () => previewAttachment(msg, +btn.dataset.attPreview)));
  const allBtn = document.getElementById('mbx-att-all');
  if (allBtn) allBtn.addEventListener('click', async () => {
    const entries = msg.attachments.map(a => ({ name: a.filename, bytes: decodeAttachmentBytes(a) }));
    await exporter.exportAttachmentsZip(entries, sanitizeFilename((msg.subject || 'message') + '-attachments.zip'));
  });
}

function downloadAttachment(msg, i) {
  const a = msg.attachments[i];
  if (RISKY_EXT.test(a.filename)) {
    if (!confirm(`"${a.filename}" is a potentially unsafe file type (${a.mimeType}). It will only be saved, never opened or executed. Download anyway?`)) return;
  }
  const bytes = decodeAttachmentBytes(a);
  downloadBlob(new Blob([bytes], { type: 'application/octet-stream' }), sanitizeFilename(a.filename));
}

function previewAttachment(msg, i) {
  const a = msg.attachments[i];
  const bytes = decodeAttachmentBytes(a);
  const url = URL.createObjectURL(new Blob([bytes], { type: a.mimeType }));
  state.objectUrls.push(url);
  const w = window.open('', '_blank', 'noopener,width=800,height=600');
  if (!w) { showToast('Popup blocked — allow popups to preview attachments.', 'warning'); return; }
  w.document.write(`<!DOCTYPE html><title>${escapeHtml(a.filename)}</title>
    <body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#222;">
    ${a.mimeType.startsWith('image/') ? `<img src="${url}" style="max-width:100%;max-height:100vh;">`
      : a.mimeType === 'application/pdf' ? `<embed src="${url}" type="application/pdf" style="width:100vw;height:100vh;">`
      : a.mimeType.startsWith('audio/') ? `<audio controls src="${url}"></audio>`
      : a.mimeType.startsWith('video/') ? `<video controls src="${url}" style="max-width:100%;max-height:100vh;"></video>`
      : `<pre style="color:#eee;padding:2rem;white-space:pre-wrap;max-width:90vw;">${escapeHtml(decodePartText(a.rawContent, a.encoding, a.charset).text.slice(0, 100000))}</pre>`}
    </body>`);
  w.document.close();
}

function cleanupObjectUrls() {
  for (const url of state.objectUrls) URL.revokeObjectURL(url);
  state.objectUrls = [];
}

// ─── Notes & labels & flags ─────────────────────────────────────────────────

function renderNote(msg) {
  el.note.value = msg.localNote || '';
}

function toggleStar(msg = activeMessage()) {
  if (!msg) return;
  msg.flags.starred = !msg.flags.starred;
  persistIfSaved(msg);
  renderSidebar();
  renderVisibleRows();
  if (msg.id === state.activeId) syncViewerActions(msg);
}

function toggleRead(msg = activeMessage(), value = null) {
  if (!msg) return;
  msg.flags.read = value === null ? !msg.flags.read : value;
  persistIfSaved(msg);
  renderSidebar();
  renderVisibleRows();
  if (msg.id === state.activeId) syncViewerActions(msg);
}

function addLabelPrompt(msgs) {
  const label = prompt('Label name:');
  if (!label || !label.trim()) return;
  for (const m of msgs) {
    if (!m.labels.includes(label.trim())) m.labels.push(label.trim());
    invalidateSearchCache(m);
    persistIfSaved(m);
  }
  renderSidebar();
  const active = activeMessage();
  if (active && msgs.includes(active)) renderViewer(active);
}

function persistIfSaved(msg) {
  const archive = state.archives.get(msg.sourceArchiveId);
  if (archive && archive.persisted) {
    store.updateMessages([msg]).catch(() => { /* quota errors surfaced on save */ });
  }
}

// ─── Editing ────────────────────────────────────────────────────────────────

function snapshotEdit(msg) {
  return JSON.stringify(msg.edited);
}

function pushHistory(msg) {
  state.editHistory.push(snapshotEdit(msg));
  if (state.editHistory.length > 100) state.editHistory.shift();
  state.editFuture = [];
}

function renderEditor(msg) {
  if (!msg.edited) {
    msg.edited = {
      subject: msg.subject,
      from: JSON.parse(JSON.stringify(msg.from)),
      to: JSON.parse(JSON.stringify(msg.to)),
      cc: JSON.parse(JSON.stringify(msg.cc)),
      date: msg.date,
      textBody: msg.textBody,
      htmlBody: msg.htmlBody,
      extraHeaders: [],
      dirty: false,
    };
  }
  const e = msg.edited;
  el.edit_subject.value = e.subject ?? '';
  el.edit_from.value = addrToText(e.from);
  el.edit_to.value = addrToText(e.to);
  el.edit_cc.value = addrToText(e.cc);
  el.edit_date.value = e.date ? new Date(e.date).toISOString().slice(0, 16) : '';
  el.edit_text.value = e.textBody ?? '';
  el.edit_html.value = e.htmlBody ?? '';
  el.edit_labels.value = msg.labels.join(', ');
  updateDirtyIndicator(msg);
}

function addrToText(list) { return (list || []).map(a => a.name ? `${a.name} <${a.address}>` : a.address).join(', '); }

function textToAddr(text) {
  return text.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const m = s.match(/^(.*?)<([^>]*)>$/);
    return m ? { name: m[1].trim().replace(/^"|"$/g, ''), address: m[2].trim() } : { name: '', address: s };
  });
}

function collectEditor(msg) {
  pushHistory(msg);
  const e = msg.edited;
  e.subject = el.edit_subject.value;
  e.from = textToAddr(el.edit_from.value);
  e.to = textToAddr(el.edit_to.value);
  e.cc = textToAddr(el.edit_cc.value);
  const d = el.edit_date.value ? Date.parse(el.edit_date.value) : msg.date;
  e.date = Number.isNaN(d) ? msg.date : d;
  e.textBody = el.edit_text.value;
  e.htmlBody = el.edit_html.value;
  e.dirty = true;
  msg.labels = el.edit_labels.value.split(',').map(s => s.trim()).filter(Boolean);
  invalidateSearchCache(msg);
  updateDirtyIndicator(msg);
}

function updateDirtyIndicator(msg) {
  const dirty = !!(msg.edited && msg.edited.dirty);
  const ind = $('#mbx-edit-dirty');
  if (ind) ind.hidden = !dirty;
}

function saveEdit(msg = activeMessage()) {
  if (!msg || !msg.edited) return;
  collectEditor(msg);
  msg.edited.dirty = false;
  updateDirtyIndicator(msg);
  persistIfSaved(msg);
  renderSidebar();
  renderVisibleRows();
  // Refresh viewer header in place without leaving the edit tab
  el.viewer_subject.textContent = (msg.edited.subject ?? msg.subject) || '(no subject)';
  if (!el.viewer_badges.querySelector('.mbx-badge-warn')) {
    el.viewer_badges.insertAdjacentHTML('afterbegin',
      '<span class="badge badge-neutral mbx-badge-warn">Edited locally — signatures invalidated</span>');
  }
  showToast('Edits saved locally. The original file is untouched; exported copies of this message will not preserve DKIM/S-MIME/PGP signatures.', 'success', 6000);
}

function revertEdit(msg = activeMessage()) {
  if (!msg) return;
  msg.edited = null;
  state.editHistory = [];
  state.editFuture = [];
  invalidateSearchCache(msg);
  persistIfSaved(msg);
  renderViewer(msg);
  renderVisibleRows();
  showToast('Reverted to the original message.', 'info');
}

function undoEdit(msg = activeMessage()) {
  if (!msg || !state.editHistory.length) return;
  state.editFuture.push(snapshotEdit(msg));
  msg.edited = JSON.parse(state.editHistory.pop());
  renderEditor(msg);
}

function redoEdit(msg = activeMessage()) {
  if (!msg || !state.editFuture.length) return;
  state.editHistory.push(snapshotEdit(msg));
  msg.edited = JSON.parse(state.editFuture.pop());
  renderEditor(msg);
}

// ─── Selection helpers ──────────────────────────────────────────────────────

function selectedMessages() {
  const list = [...state.selection].map(id => byId.get(id)).filter(Boolean);
  if (list.length) return list;
  const active = activeMessage();
  return active ? [active] : [];
}

function selectAllVisible() {
  state.selection = new Set(state.visible.map(m => m.id));
  renderVisibleRows();
  showToast(`${state.selection.size.toLocaleString()} messages selected.`, 'info');
}

// ─── Navigation ─────────────────────────────────────────────────────────────

function navigate(delta) {
  if (!state.visible.length) return;
  let idx = state.visible.findIndex(m => m.id === state.activeId);
  idx = idx === -1 ? 0 : Math.min(state.visible.length - 1, Math.max(0, idx + delta));
  const msg = state.visible[idx];
  state.selection.clear();
  state.selection.add(msg.id);
  openMessage(msg);
  const h = rowHeight();
  const top = idx * h;
  if (top < el.list.scrollTop || top + h > el.list.scrollTop + el.list.clientHeight) {
    el.list.scrollTop = top - el.list.clientHeight / 2;
  }
}

// ─── Reading window & print ─────────────────────────────────────────────────

async function openReadingWindow(msg, print = false) {
  if (!msg) return;
  const eff = msg.edited || msg;
  let bodyHtml;
  if (eff.htmlBody ?? msg.htmlBody) {
    try {
      const { html } = await sanitizeEmailHtml(eff.htmlBody ?? msg.htmlBody, msg, false);
      bodyHtml = html;
    } catch { bodyHtml = `<pre style="white-space:pre-wrap;">${escapeHtml(eff.textBody ?? msg.textBody ?? '')}</pre>`; }
  } else {
    bodyHtml = plainTextToHtml((eff.textBody ?? msg.textBody) || '');
  }
  const w = window.open('', '_blank', 'noopener,width=760,height=800');
  if (!w) { showToast('Popup blocked — allow popups for the reading window.', 'warning'); return; }
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(eff.subject ?? msg.subject) || 'Message'}</title>
    <style>body{font-family:system-ui,sans-serif;line-height:1.6;max-width:760px;margin:0 auto;padding:2rem 1rem;}
    .meta{color:#666;border-bottom:1px solid #ddd;padding-bottom:1rem;margin-bottom:1rem;}
    pre{white-space:pre-wrap;font-family:inherit;} img{max-width:100%;}
    details summary{color:#999;cursor:pointer;}</style></head><body>
    <h1 style="font-size:1.3rem;">${escapeHtml(eff.subject ?? msg.subject) || '(no subject)'}</h1>
    <div class="meta">From: ${escapeHtml(addrToText(eff.from ?? msg.from))}<br>To: ${escapeHtml(addrToText(eff.to ?? msg.to))}<br>
    Date: ${msg.date ? new Date(eff.date ?? msg.date).toLocaleString() : '(unknown)'}</div>
    ${bodyHtml}</body></html>`);
  w.document.close();
  if (print) { w.addEventListener('load', () => w.print()); setTimeout(() => { try { w.print(); } catch { } }, 400); }
}

// ─── Persistence UI (settings modal) ────────────────────────────────────────

async function refreshSavedArchives() {
  try {
    const saved = await store.listArchives();
    el.sidebar_archives.innerHTML = saved.length
      ? saved.map(a => `<button class="mbx-nav-item" data-saved="${a.id}"><span>💾 ${escapeHtml(a.name)}</span><span class="mbx-nav-count">${(a.messageCount || 0).toLocaleString()}</span></button>`).join('')
      : '';
    el.sidebar_archives.closest('.mbx-nav-group').hidden = saved.length === 0;
    el.sidebar_archives.querySelectorAll('[data-saved]').forEach(btn =>
      btn.addEventListener('click', () => reopenSavedArchive(btn.dataset.saved)));
  } catch { /* IndexedDB unavailable */ }
}

async function reopenSavedArchive(id) {
  try {
    const metas = await store.listArchives();
    const meta = metas.find(a => a.id === id);
    if (!meta) return;
    setParseStatus('Loading saved archive…');
    const messages = await store.loadArchiveMessages(id);
    if (state.archives.has(id)) {
      showToast('This archive is already open.', 'info');
      setParseStatus('Ready');
      return;
    }
    state.archives.set(id, { id, name: meta.name, fileSize: meta.fileSize || 0, report: null, persisted: true });
    integrateMessages(messages);
    setParseStatus('Ready');
    showToast(`Reopened "${meta.name}" from local storage.`, 'success');
  } catch (err) {
    setParseStatus('');
    showToast('Could not load the saved archive: ' + err.message, 'error');
  }
}

async function openSettings() {
  const usage = await store.estimateUsage();
  let saved = [];
  try { saved = await store.listArchives(); } catch { /* unavailable */ }
  const openArchives = [...state.archives.values()];
  el.settings_body.innerHTML = `
    <h4 class="mbx-settings-h">Local persistence</h4>
    <p class="tool-hint">Saving stores parsed messages, read state, stars, labels, notes and edits in this browser's IndexedDB — on this device only, never on a server. Your original .mbox file is never modified.</p>
    ${openArchives.map(a => `
      <div class="mbx-settings-row">
        <span>${escapeHtml(a.name)} · ${state.messages.filter(m => m.sourceArchiveId === a.id).length.toLocaleString()} messages</span>
        ${a.persisted
          ? '<span class="badge badge-neutral">Saved</span>'
          : `<button class="btn btn-sm btn-primary" data-save-archive="${a.id}">Save locally</button>`}
      </div>`).join('') || '<p class="tool-hint">No archive open.</p>'}
    <h4 class="mbx-settings-h">Saved archives</h4>
    ${saved.length ? saved.map(a => `
      <div class="mbx-settings-row">
        <span>${escapeHtml(a.name)} · ${(a.messageCount || 0).toLocaleString()} messages</span>
        <span>
          <button class="btn btn-sm btn-ghost" data-rename-archive="${a.id}">Rename</button>
          <button class="btn btn-sm btn-danger" data-delete-archive="${a.id}">Delete</button>
        </span>
      </div>`).join('') : '<p class="tool-hint">Nothing saved yet.</p>'}
    <div class="mbx-settings-row">
      <span>${usage ? `Storage used: ~${formatBytes(usage.usage)} of ${formatBytes(usage.quota)}` : 'Storage estimate unavailable'}</span>
      <button class="btn btn-sm btn-danger" id="mbx-clear-all">Clear all local data</button>
    </div>
    <h4 class="mbx-settings-h">Display</h4>
    <div class="mbx-settings-row"><span>Font size</span>
      <span>
        <button class="btn btn-sm btn-ghost" data-font="-">A−</button>
        <button class="btn btn-sm btn-ghost" data-font="+">A+</button>
      </span>
    </div>`;
  openModal(el.settings_modal);

  el.settings_body.querySelectorAll('[data-save-archive]').forEach(btn =>
    btn.addEventListener('click', () => saveArchiveLocally(btn.dataset.saveArchive)));
  el.settings_body.querySelectorAll('[data-rename-archive]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const name = prompt('New name for this archive:');
      if (name) { await store.renameArchive(btn.dataset.renameArchive, name); openSettings(); refreshSavedArchives(); }
    }));
  el.settings_body.querySelectorAll('[data-delete-archive]').forEach(btn =>
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this locally saved archive? Your original .mbox file on disk is not affected.')) return;
      await store.deleteArchive(btn.dataset.deleteArchive);
      const open = state.archives.get(btn.dataset.deleteArchive);
      if (open) open.persisted = false;
      openSettings(); refreshSavedArchives();
    }));
  const clearBtn = document.getElementById('mbx-clear-all');
  if (clearBtn) clearBtn.addEventListener('click', async () => {
    if (!confirm('Delete ALL locally stored archives, notes, labels and preferences from this browser?')) return;
    await store.clearAllData();
    for (const a of state.archives.values()) a.persisted = false;
    openSettings(); refreshSavedArchives();
    showToast('All local data cleared.', 'success');
  });
  el.settings_body.querySelectorAll('[data-font]').forEach(btn =>
    btn.addEventListener('click', () => {
      const cur = state.prefs.fontScale || 1;
      state.prefs.fontScale = Math.min(1.4, Math.max(0.8, cur + (btn.dataset.font === '+' ? 0.1 : -0.1)));
      document.documentElement.style.setProperty('--mbx-font-scale', String(state.prefs.fontScale));
      savePrefsNow();
      const msg = activeMessage();
      if (msg && currentTab === 'rendered') renderBody(msg, false);
    }));
}

async function saveArchiveLocally(archiveId) {
  const archive = state.archives.get(archiveId);
  if (!archive) return;
  const messages = state.messages.filter(m => m.sourceArchiveId === archiveId);
  try {
    showToast('Saving archive locally…', 'info');
    await store.saveArchive({
      id: archiveId, name: archive.name, fileSize: archive.fileSize,
      messageCount: messages.length, savedAt: Date.now(),
    }, messages);
    archive.persisted = true;
    showToast('Archive saved in this browser.', 'success');
    openSettings();
    refreshSavedArchives();
  } catch (err) {
    showToast('Could not save: ' + (err.message.includes('quota') || err.name === 'QuotaExceededError'
      ? 'browser storage quota exceeded. Try a smaller archive or clear local data.'
      : err.message), 'error', 8000);
  }
}

// ─── Export menu ────────────────────────────────────────────────────────────

async function handleExport(what) {
  const active = activeMessage();
  const sel = selectedMessages();
  const all = state.messages;
  const archiveNames = Object.fromEntries([...state.archives.values()].map(a => [a.id, a.name]));
  const anyEdited = (list) => list.some(m => m.edited);
  const warnSig = (list) => {
    if (anyEdited(list)) showToast('Selection contains edited messages — reconstructed copies do not preserve DKIM/S-MIME/PGP signatures.', 'warning', 7000);
  };
  try {
    switch (what) {
      case 'eml': if (active) { warnSig([active]); exporter.exportEml(active); } break;
      case 'txt': if (active) exporter.exportText(active); break;
      case 'raw': if (active) exporter.exportRaw(active); break;
      case 'json-one': if (active) exporter.exportJson(active); break;
      case 'html-one':
        if (active) {
          const eff = active.edited || active;
          let safe = null;
          if (eff.htmlBody ?? active.htmlBody) {
            const r = await sanitizeEmailHtml(eff.htmlBody ?? active.htmlBody, active, false);
            safe = r.html;
          }
          exporter.exportHtml(active, safe);
        }
        break;
      case 'pdf': if (active) openReadingWindow(active, true); break;
      case 'mbox-sel': warnSig(sel); exporter.exportMbox(sel, 'selection.mbox'); break;
      case 'zip-sel': warnSig(sel); await exporter.exportZipOfEml(sel, 'selection-eml.zip'); break;
      case 'csv-sel': exporter.exportCsv(sel, 'selection.csv', archiveNames); break;
      case 'json-sel': exporter.exportJsonArchive(sel, 'selection.json'); break;
      case 'html-sel': exporter.exportHtmlArchive(sel, 'selection.html'); break;
      case 'att-sel': {
        const entries = [];
        for (const m of sel) for (const a of m.attachments) entries.push({ name: a.filename, bytes: decodeAttachmentBytes(a) });
        if (!entries.length) { showToast('No attachments in the selection.', 'info'); return; }
        await exporter.exportAttachmentsZip(entries, 'attachments.zip');
        break;
      }
      case 'mbox-all': warnSig(all); exporter.exportMbox(all, 'archive-export.mbox'); break;
      case 'zip-all': warnSig(all); await exporter.exportZipOfEml(all, 'archive-eml.zip'); break;
      case 'csv-all': exporter.exportCsv(all, 'archive-index.csv', archiveNames); break;
      case 'json-all': exporter.exportJsonArchive(all, 'archive.json'); break;
    }
  } catch (err) {
    showToast('Export failed: ' + (err && err.message ? err.message : 'unknown error'), 'error', 7000);
  }
}

// ─── Wiring ─────────────────────────────────────────────────────────────────

function wireToolbar() {
  $('#mbx-open-btn').addEventListener('click', openFilePicker);
  $('#mbx-add-btn').addEventListener('click', openFilePicker);
  $('#mbx-choose-btn').addEventListener('click', openFilePicker);
  $('#mbx-demo-btn').addEventListener('click', () => importFiles([generateDemoFile()]));
  const demo2 = $('#mbx-demo-btn-2');
  if (demo2) demo2.addEventListener('click', () => importFiles([generateDemoFile()]));
  el.file_input.addEventListener('change', () => {
    importFiles(el.file_input.files);
    el.file_input.value = '';
  });
  $('#mbx-prev').addEventListener('click', () => navigate(-1));
  $('#mbx-next').addEventListener('click', () => navigate(1));
  $('#mbx-settings-btn').addEventListener('click', openSettings);
  $('#mbx-sidebar-toggle').addEventListener('click', () => {
    document.body.classList.toggle('mbx-sidebar-collapsed');
  });
  el.progress_cancel.addEventListener('click', cancelParsing);

  // Export dropdown
  const exportBtn = $('#mbx-export-btn');
  const exportMenu = $('#mbx-export-menu');
  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    exportMenu.hidden = !exportMenu.hidden;
  });
  document.addEventListener('click', () => { exportMenu.hidden = true; hideContextMenu(); });
  exportMenu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-export]');
    if (item) { exportMenu.hidden = true; handleExport(item.dataset.export); }
  });

  el.search.addEventListener('input', debounce(() => {
    state.query = el.search.value;
    applyFilters();
  }, 200));
  el.search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { el.search.value = ''; state.query = ''; applyFilters(); el.search.blur(); }
  });

  el.sort.addEventListener('change', () => { state.sort = el.sort.value; savePrefsNow(); applyFilters(); });
  el.density_btn.addEventListener('click', () => {
    const order = ['comfortable', 'compact', 'spacious'];
    state.density = order[(order.indexOf(state.density) + 1) % order.length];
    el.density_btn.title = 'Density: ' + state.density;
    savePrefsNow();
    renderList();
  });
  el.threadview_btn.addEventListener('click', () => {
    state.threadView = !state.threadView;
    el.threadview_btn.classList.toggle('active', state.threadView);
    applyFilters();
  });
  el.select_all.addEventListener('click', selectAllVisible);
}

function wireDropzone() {
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    dragDepth++;
    el.drop_overlay.hidden = false;
  });
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) el.drop_overlay.hidden = true;
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    el.drop_overlay.hidden = true;
    if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
  });
  el.dropzone.addEventListener('click', openFilePicker);
  el.dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') openFilePicker(); });
}

function wireList() {
  el.list.addEventListener('scroll', () => renderVisibleRows());
  new ResizeObserver(() => renderVisibleRows()).observe(el.list);
}

function wireViewer() {
  el.tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (btn) setTab(btn.dataset.tab);
  });
  el.load_remote_btn.addEventListener('click', () => {
    const msg = activeMessage();
    if (!msg) return;
    if (confirm('Load remote content? Images and styles will be fetched from third-party servers, which reveals your IP address and can confirm to the sender that the email was opened.')) {
      renderBody(msg, true);
      el.remote_banner.hidden = true;
    }
  });
  $('#mbx-act-star').addEventListener('click', () => toggleStar());
  $('#mbx-act-read').addEventListener('click', () => toggleRead());
  $('#mbx-act-label').addEventListener('click', () => addLabelPrompt(selectedMessages()));
  $('#mbx-act-edit').addEventListener('click', () => setTab('edit'));
  $('#mbx-act-copy').addEventListener('click', async () => {
    const msg = activeMessage();
    if (!msg) return;
    try { await navigator.clipboard.writeText(msg.raw); showToast('Raw source copied.', 'success'); }
    catch { showToast('Clipboard unavailable.', 'error'); }
  });
  $('#mbx-act-print').addEventListener('click', () => openReadingWindow(activeMessage(), true));
  $('#mbx-act-window').addEventListener('click', () => openReadingWindow(activeMessage()));

  el.note.addEventListener('change', () => {
    const msg = activeMessage();
    if (!msg) return;
    msg.localNote = el.note.value;
    invalidateSearchCache(msg);
    persistIfSaved(msg);
  });

  // Editor events
  for (const input of [el.edit_subject, el.edit_from, el.edit_to, el.edit_cc, el.edit_date, el.edit_text, el.edit_html, el.edit_labels]) {
    input.addEventListener('change', () => { const m = activeMessage(); if (m) collectEditor(m); });
  }
  el.edit_htmlmode.addEventListener('click', () => {
    document.body.classList.toggle('mbx-edit-richmode');
    const rich = $('#mbx-edit-rich');
    if (document.body.classList.contains('mbx-edit-richmode')) {
      ensurePurify().then(() => {
        rich.innerHTML = window.DOMPurify.sanitize(el.edit_html.value, { FORBID_TAGS: ['script', 'style', 'iframe', 'form'] });
        rich.contentEditable = 'true';
      });
      el.edit_htmlmode.textContent = 'Source mode';
    } else {
      const m = activeMessage();
      el.edit_html.value = rich.innerHTML;
      if (m) collectEditor(m);
      el.edit_htmlmode.textContent = 'Rich-text mode';
    }
  });
  $('#mbx-edit-rich').addEventListener('input', () => {
    el.edit_html.value = $('#mbx-edit-rich').innerHTML;
    const m = activeMessage();
    if (m && m.edited) { m.edited.htmlBody = el.edit_html.value; m.edited.dirty = true; updateDirtyIndicator(m); }
  });
  $('#mbx-edit-save').addEventListener('click', () => saveEdit());
  $('#mbx-edit-revert').addEventListener('click', () => { if (confirm('Discard all local edits and revert to the original message?')) revertEdit(); });
  $('#mbx-edit-undo').addEventListener('click', () => undoEdit());
  $('#mbx-edit-redo').addEventListener('click', () => redoEdit());
  $('#mbx-edit-preview').addEventListener('click', () => {
    const m = activeMessage();
    if (m) { collectEditor(m); setTab('rendered'); }
  });

  // Modal close buttons
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('.modal-close')) closeModal(overlay);
    });
  });
}

function wireContextMenu() {
  el.list.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.mbx-row');
    if (!row) return;
    e.preventDefault();
    if (!state.selection.has(row.dataset.id)) {
      state.selection.clear();
      state.selection.add(row.dataset.id);
      state.activeId = row.dataset.id;
      renderVisibleRows();
    }
    const menu = el.context_menu;
    menu.hidden = false;
    menu.style.left = Math.min(e.clientX, window.innerWidth - 220) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - 260) + 'px';
  });
  el.context_menu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-ctx]');
    if (!item) return;
    hideContextMenu();
    const sel = selectedMessages();
    switch (item.dataset.ctx) {
      case 'open': if (sel[0]) openMessage(sel[0]); break;
      case 'star': sel.forEach(m => { m.flags.starred = true; persistIfSaved(m); }); renderSidebar(); renderVisibleRows(); break;
      case 'unstar': sel.forEach(m => { m.flags.starred = false; persistIfSaved(m); }); renderSidebar(); renderVisibleRows(); break;
      case 'read': sel.forEach(m => toggleRead(m, true)); break;
      case 'unread': sel.forEach(m => toggleRead(m, false)); break;
      case 'label': addLabelPrompt(sel); break;
      case 'eml': sel.slice(0, 10).forEach(m => exporter.exportEml(m)); break;
      case 'mbox': handleExport('mbox-sel'); break;
    }
  });
}

function hideContextMenu() { if (el.context_menu) el.context_menu.hidden = true; }

function wireKeyboard() {
  document.addEventListener('keydown', (e) => {
    const inInput = /^(input|textarea|select)$/i.test(document.activeElement?.tagName || '') ||
      document.activeElement?.isContentEditable;
    const mod = e.metaKey || e.ctrlKey;

    if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openFilePicker(); return; }
    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); el.search.focus(); el.search.select(); return; }
    if (mod && e.key.toLowerCase() === 's' && currentTab === 'edit') { e.preventDefault(); saveEdit(); return; }
    if (mod && e.key.toLowerCase() === 'z' && currentTab === 'edit' && !inInput) {
      e.preventDefault();
      if (e.shiftKey) redoEdit(); else undoEdit();
      return;
    }
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay:not([hidden])').forEach(closeModal);
      hideContextMenu();
      return;
    }
    if (inInput) return;

    switch (e.key) {
      case 'j': navigate(1); break;
      case 'k': navigate(-1); break;
      case 'Enter': { const m = activeMessage(); if (m) openMessage(m); break; }
      case 's': toggleStar(); break;
      case 'u': toggleRead(activeMessage(), false); break;
      case 'e': { if (activeMessage()) setTab('edit'); break; }
      case '/': e.preventDefault(); el.search.focus(); break;
    }
  });
}

// ─── Modal helpers ──────────────────────────────────────────────────────────

function openModal(overlay) {
  overlay.hidden = false;
  const focusable = overlay.querySelector('button, input, [tabindex]');
  if (focusable) focusable.focus();
}

function closeModal(overlay) { overlay.hidden = true; }
