// main.js
// The file manager: shell, folder tree, file list and grid, selection, keyboard and
// drag and drop. Operations live in actions.js, the details pane in details.js.

import { el, btn, icon, iconBtn, menu, closeMenu, toast, task, download, fill } from './dom.js';
import { t, lang, loadStrings, fmtBytes, fmtDate, fmtNum, collator } from './i18n.js';
import { S, subscribe, emit, visibleRows, folderStats, kindStats, navigate, move, isFolderKey, folderKey, parentOf, leafOf, isSearching, clearAll, expand } from './store.js';
import { KINDS, KIND_LABEL, KIND_COLOR, iconHtml, isArchive } from './kinds.js';
import { fromDrop, fromPaste, canPickFolder } from './intake.js';
import { thumb, hasThumb, forgetThumbs } from './preview.js';
import * as A from './actions.js';
import * as dialogs from './dialogs.js';
import { createDetails } from './details.js';
import { handoffIdFromUrl, takeHandoff } from '../handoff.js';

const landing = document.getElementById('fm-landing');
const app = document.getElementById('fm-app');
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl';
const CHUNK = 300;
const PREFS = 'fo-fm-prefs';

let rows = [];          // what the list currently shows
let stats = new Map();
let rendered = 0;
let cursor = null;      // key of the row the keyboard is on
let refs = {};
let details;

// ─── Preferences ──────────────────────────────────────────────────────────────

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) || '{}');
    if (p.view === 'grid' || p.view === 'list') S.view = p.view;
    if (typeof p.details === 'boolean') S.details = p.details;
    if (p.sort?.key) S.sort = { key: p.sort.key, dir: p.sort.dir === -1 ? -1 : 1 };
  } catch { /* defaults */ }
}
function savePrefs() {
  try { localStorage.setItem(PREFS, JSON.stringify({ view: S.view, details: S.details, sort: S.sort })); } catch { /* private mode */ }
}

// ─── Shell ────────────────────────────────────────────────────────────────────

function buildShell() {
  refs.crumbs = el('nav.fm-crumbs', { 'aria-label': t('Folder path') });
  refs.search = el('input.fm-search__input', { type: 'search', placeholder: t('Search all files'), 'aria-label': t('Search all files'), autocomplete: 'off', spellcheck: false });
  refs.search.addEventListener('input', () => { S.query = refs.search.value; S.selection.clear(); emit('nav', 'selection'); });
  refs.tree = el('div.fm-tree', { role: 'tree', 'aria-label': t('Folders') });
  refs.kinds = el('div.fm-kinds');
  refs.bar = el('div.fm-bar', { role: 'toolbar', 'aria-label': t('Actions') });
  refs.list = el('div.fm-list', { tabIndex: 0, 'aria-label': t('Files') });
  refs.listwrap = el('div.fm-listwrap', refs.list, el('div.fm-dropveil', { 'aria-hidden': 'true' }, el('div', icon('download'), el('strong', t('Drop to add to this folder')))));
  refs.status = el('footer.fm-status');
  refs.details = el('aside.fm-details', { 'aria-label': t('Details') });
  refs.side = el('aside.fm-side', { 'aria-label': t('Folders') },
    el('div.fm-side__add',
      btn(t('Add files'), A.addFromPicker, { variant: 'primary', ico: 'plus' }),
      canPickFolder ? btn(t('Add folder'), A.addFolderFromPicker, { variant: 'secondary', ico: 'folder' }) : null),
    el('div.fm-side__scroll',
      el('h2.fm-side__title', t('Folders')), refs.tree,
      el('h2.fm-side__title', t('File types')), refs.kinds),
    el('p.fm-side__note', icon('shield'), el('span', t('Nothing is uploaded. Your files stay on this device.'))));

  const top = el('header.fm-top',
    iconBtn('sidebar', t('Folders'), () => app.classList.toggle('is-side-open'), { className: 'fm-iconbtn fm-top__menu' }),
    el('button.fm-top__home', { type: 'button', title: t('Close the workspace'), onclick: () => A.clearWorkspace(closeApp) },
      icon('back'), el('span.fm-top__logo', { html: document.querySelector('.s-logo svg')?.outerHTML || '' }), el('span.fm-top__brand', 'Files Online')),
    refs.crumbs,
    el('label.fm-search', icon('search'), refs.search, el('kbd', '/')),
    el('div.fm-top__actions',
      el('button.fm-cmdk', { type: 'button', title: t('Commands'), onclick: openPalette }, icon('command'), el('span', t('Commands')), el('kbd', `${MOD} K`)),
      iconBtn('keyboard', t('Keyboard shortcuts'), () => dialogs.shortcutsDialog(MOD), { className: 'fm-iconbtn fm-hide-s' }),
      el('button.fm-iconbtn.fm-theme', { type: 'button', title: t('Light or dark'), 'aria-label': t('Light or dark'), onclick: toggleTheme },
        el('span', { html: '<svg class="fm-theme__moon" viewBox="0 0 16 16" fill="none" width="16" height="16"><path d="M13.500 9.500A5.500 5.500 0 016.500 2.500a5.500 5.500 0 107 7z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg><svg class="fm-theme__sun" viewBox="0 0 16 16" fill="none" width="16" height="16"><circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.500v2M8 12.500v2M1.500 8h2M12.500 8h2M3.400 3.400l1.400 1.400M11.200 11.200l1.400 1.400M12.600 3.400l-1.400 1.400M4.800 11.200l-1.400 1.400" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' }))));

  app.append(top,
    el('div.fm-body', refs.side, el('main.fm-main', refs.bar, refs.listwrap), refs.details),
    refs.status,
    el('div.fm-scrim', { onclick: () => app.classList.remove('is-side-open', 'is-details-open') }));

  details = createDetails(refs.details, { reveal, openQuickLook, close: () => { if (window.innerWidth >= 1100) S.details = false; app.classList.remove('is-details-open'); savePrefs(); emit('view'); } });
}

function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('fo-theme', next); } catch { /* private mode */ }
}

function openApp() {
  if (!app.hidden) return;
  landing.hidden = true;
  app.hidden = false;
  document.body.classList.add('fm-open');
  window.scrollTo(0, 0);
  refs.list.focus({ preventScroll: true });
}

function closeApp() {
  clearAll();
  forgetThumbs();
  refs.search.value = '';
  app.hidden = true;
  landing.hidden = false;
  document.body.classList.remove('fm-open');
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

const openFolders = new Set(['']);

function renderTree() {
  const children = new Map();
  for (const f of S.folders) {
    const p = parentOf(f);
    (children.get(p) || children.set(p, []).get(p)).push(f);
  }
  children.forEach(list => list.sort((a, b) => collator.compare(leafOf(a), leafOf(b))));
  // Keep the path to the current folder open
  for (let p = S.cwd; p; p = parentOf(p)) openFolders.add(parentOf(p));

  const node = (path, depth) => {
    const kids = children.get(path) || [];
    const open = openFolders.has(path);
    const active = !isSearching() && S.cwd === path;
    const row = el(`div.fm-tree__row${active ? '.is-active' : ''}`, {
      role: 'treeitem', 'aria-expanded': kids.length ? String(open) : undefined, 'aria-selected': String(active),
      dataset: { drop: path }, style: { paddingLeft: `${8 + depth * 14}px` },
    },
    el(`button.fm-tree__twist${kids.length ? '' : '.is-leaf'}${open ? '.is-open' : ''}`, {
      type: 'button', tabIndex: -1, 'aria-label': t('Show or hide subfolders'),
      onclick: e => { e.stopPropagation(); if (open) openFolders.delete(path); else openFolders.add(path); renderTree(); },
    }, icon('chevron')),
    el('button.fm-tree__label', { type: 'button', onclick: () => { navigate(path); refs.search.value = ''; app.classList.remove('is-side-open'); } },
      el('span', { html: path ? iconHtml({ isFolder: true }) : '' }, path ? null : icon('home')),
      el('span.fm-tree__name', path ? leafOf(path) : t('Workspace')),
      el('span.fm-tree__count', fmtNum(stats.get(path)?.count || 0))));
    return [row, open ? kids.flatMap(k => node(k, depth + 1)) : []];
  };
  fill(refs.tree, ...node('', 0).flat(Infinity));
}

function renderKinds() {
  const ks = kindStats();
  const total = [...ks.values()].reduce((sum, s) => sum + s.size, 0) || 1;
  const present = KINDS.filter(k => ks.has(k));
  fill(refs.kinds,
    present.length ? el('div.fm-meter', { 'aria-hidden': 'true' }, present.map(k => el('span', { style: { width: `${Math.max(1.5, ks.get(k).size / total * 100)}%`, background: KIND_COLOR[k] } }))) : null,
    ...present.map(k => el(`button.fm-kind${S.kind === k ? '.is-active' : ''}`, {
      type: 'button', 'aria-pressed': String(S.kind === k),
      onclick: () => { S.kind = S.kind === k ? null : k; S.selection.clear(); emit('nav', 'selection'); app.classList.remove('is-side-open'); },
    }, el('span.fm-kind__dot', { style: { background: KIND_COLOR[k] } }), el('span.fm-kind__name', t(KIND_LABEL[k])),
    el('span.fm-kind__size', fmtBytes(ks.get(k).size)), el('span.fm-kind__count', fmtNum(ks.get(k).count)))),
    present.length ? null : el('p.fm-side__empty', t('No files yet.')));
}

function renderCrumbs() {
  const parts = S.cwd ? S.cwd.split('/') : [];
  const crumb = (label, path, last) => el(`button.fm-crumb${last ? '.is-current' : ''}`, {
    type: 'button', dataset: { drop: path }, 'aria-current': last ? 'page' : undefined,
    onclick: () => { navigate(path); refs.search.value = ''; },
  }, label);
  const nodes = [crumb(t('Workspace'), '', !parts.length && !isSearching())];
  parts.forEach((p, i) => nodes.push(icon('chevron', 'fm-i fm-crumbs__sep'), crumb(p, parts.slice(0, i + 1).join('/'), i === parts.length - 1 && !isSearching())));
  if (isSearching()) {
    nodes.length = 1;
    nodes.push(icon('chevron', 'fm-i fm-crumbs__sep'), el('span.fm-crumb.is-current', S.kind && !S.query.trim() ? t(KIND_LABEL[S.kind]) : t('Search results')));
  }
  fill(refs.crumbs, ...nodes);
  refs.crumbs.scrollLeft = refs.crumbs.scrollWidth;
}

// ─── Toolbar ──────────────────────────────────────────────────────────────────

function renderBar() {
  const count = S.selection.size;
  const files = A.targets();
  const has = count > 0;
  const archives = has && files.length > 0 && files.every(isArchive);
  const { here, tools } = has && [...S.selection].every(k => !isFolderKey(k)) ? A.suggestions(files) : { here: [], tools: [] };

  const addMenu = e => menu([
    { label: t('Add files'), ico: 'files', run: A.addFromPicker },
    canPickFolder && { label: t('Add folder'), ico: 'folder', run: A.addFolderFromPicker },
    '-',
    { label: t('New folder'), ico: 'folderPlus', run: A.newFolder },
  ], { anchor: e.currentTarget });

  const toolsMenu = e => menu([
    ...(here.length || tools.length ? [{ heading: t('For the selection') }, ...here, ...tools.slice(0, 5), '-'] : []),
    { heading: t('Workspace') },
    { label: t('Find duplicates'), ico: 'duplicate', run: A.findDuplicates },
    { label: t('Rename many files'), ico: 'rename', run: () => (S.selection.size > 1 ? A.rename() : A.renameAll()) },
    { label: t('Convert images'), ico: 'image', run: A.convertImages },
    { label: t('Checksums'), ico: 'hash', run: A.checksums, disabled: !has },
    { label: t('Export file list'), ico: 'table', run: A.exportList },
    A.canSaveToFolder && { label: t('Save to a folder on this device'), ico: 'save', run: A.saveToFolder },
    '-',
    { label: t('All PDF and file tools'), ico: 'wand', run: A.openToolPalette, kbd: `${MOD} K` },
  ], { anchor: e.currentTarget });

  const sortMenu = e => menu([
    ...[['name', t('Name')], ['kind', t('Type')], ['size', t('Size')], ['modified', t('Changed')]].map(([key, label]) => ({
      label, ico: S.sort.key === key ? 'check' : 'sort', run: () => setSort(key),
    })),
  ], { anchor: e.currentTarget, align: 'right' });

  const compact = { className: 'fm-btn fm-btn--ghost fm-btn--compact' };
  fill(refs.bar,
    el('div.fm-bar__scroll',
      el('div.fm-bar__group',
        btn(t('Add'), addMenu, { ico: 'plus', variant: 'secondary', 'aria-haspopup': 'menu' })),
      el('div.fm-bar__group.fm-bar__sel',
        btn(t('Download'), A.downloadSelection, { ico: 'download', disabled: !has }),
        btn(t('ZIP'), () => A.zip(), { ico: 'zip', title: has ? t('Create a ZIP from the selection') : t('Create a ZIP from everything here') }),
        archives ? btn(t('Extract'), () => A.extractArchives(), { ico: 'unzip' }) : null,
        btn(t('Rename'), A.rename, { ico: 'rename', disabled: !has, kbd: 'F2', ...compact }),
        btn(t('Move'), () => dialogs.moveDialog(new Set(S.selection)), { ico: 'move', disabled: !has, title: t('Move to folder'), ...compact }),
        btn(t('Remove'), A.removeSelection, { ico: 'trash', disabled: !has, kbd: 'Del', ...compact })),
      el('div.fm-bar__group',
        btn(t('Tools'), toolsMenu, { ico: 'wand', variant: has && (here.length || tools.length) ? 'accent' : 'ghost', 'aria-haspopup': 'menu' }))),
    el('div.fm-bar__group.fm-bar__view',
      iconBtn('sort', t('Sort'), sortMenu, { className: 'fm-iconbtn fm-hide-s' }),
      el('div.fm-seg', { role: 'group', 'aria-label': t('View') },
        iconBtn('list', t('List'), () => setView('list'), { 'aria-pressed': String(S.view === 'list') }),
        iconBtn('grid', t('Grid'), () => setView('grid'), { 'aria-pressed': String(S.view === 'grid') })),
      iconBtn('panel', t('Details'), toggleDetails, { 'aria-pressed': String(window.innerWidth < 1100 ? app.classList.contains('is-details-open') : S.details) })));
}

function setView(view) { S.view = view; savePrefs(); emit('view'); }
function setSort(key) {
  S.sort = S.sort.key === key ? { key, dir: -S.sort.dir } : { key, dir: key === 'size' || key === 'modified' ? -1 : 1 };
  savePrefs(); emit('view');
}
function toggleDetails() {
  if (window.innerWidth < 1100) { app.classList.toggle('is-details-open'); S.details = true; }
  else S.details = !S.details;
  savePrefs(); emit('view');
}

// ─── List and grid ────────────────────────────────────────────────────────────

const thumbObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    thumbObserver.unobserve(entry.target);
    const item = S.items.get(entry.target.dataset.key);
    if (!item) continue;
    thumb(item).then(url => {
      const slot = entry.target.querySelector('.fm-tile__thumb');
      if (url && slot?.isConnected) fill(slot, el('img', { src: url, alt: '', loading: 'lazy', draggable: false }));
    });
  }
}, { rootMargin: '300px' });

const moreObserver = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) appendRows(); });

const subline = row => (row.isFolder ? t('Files: {n}', { n: fmtNum(row.count) }) : fmtBytes(row.size));

function rowNode(row) {
  const selected = S.selection.has(row.id);
  const common = { dataset: row.isFolder ? { key: row.id, drop: row.path } : { key: row.id }, draggable: true, 'aria-selected': String(selected) };
  const tag = row.made ? el('span.fm-tag.fm-tag--new', t('New')) : null;
  if (S.view === 'grid') {
    const node = el(`div.fm-tile${selected ? '.is-selected' : ''}`, { ...common, role: 'option' },
      el('span.fm-check', { role: 'checkbox', 'aria-checked': String(selected), 'aria-label': t('Select') }, icon('check')),
      el('div.fm-tile__thumb', { html: iconHtml(row) }),
      el('div.fm-tile__name', { title: row.name }, row.name),
      el('div.fm-tile__meta', subline(row), tag));
    if (!row.isFolder && hasThumb(row)) thumbObserver.observe(node);
    return node;
  }
  return el(`div.fm-row${selected ? '.is-selected' : ''}`, { ...common, role: 'row' },
    el('span.fm-check', { role: 'checkbox', 'aria-checked': String(selected), 'aria-label': t('Select') }, icon('check')),
    el('span.fm-row__icon', { html: iconHtml(row) }),
    el('span.fm-row__name', el('span.fm-row__title', { title: row.name }, row.name), tag,
      isSearching() && row.dir ? el('span.fm-row__path', row.dir) : null),
    el('span.fm-row__kind', row.isFolder ? t('Folder') : (row.ext ? row.ext.toUpperCase() : t(KIND_LABEL[row.kind]))),
    el('span.fm-row__size', row.isFolder ? t('Files: {n}', { n: fmtNum(row.count) }) : fmtBytes(row.size)),
    el('span.fm-row__date', fmtDate(row.modified)));
}

function appendRows() {
  const host = refs.list.querySelector('.fm-rows');
  if (!host || rendered >= rows.length) return;
  const sentinel = host.querySelector('.fm-more');
  sentinel?.remove();
  const next = rows.slice(rendered, rendered + CHUNK).map(rowNode);
  rendered += next.length;
  host.append(...next);
  if (rendered < rows.length) {
    const more = el('div.fm-more');
    host.append(more);
    moreObserver.observe(more);
  }
}

function emptyState() {
  if (isSearching()) {
    return el('div.fm-blank', icon('search', 'fm-i fm-blank__icon'), el('h2', t('Nothing matches')),
      el('p', t('No file in the workspace fits this search.')),
      btn(t('Clear the search'), () => { refs.search.value = ''; navigate(S.cwd); }, { variant: 'secondary' }));
  }
  return el('div.fm-blank.fm-blank--drop', icon('download', 'fm-i fm-blank__icon'),
    el('h2', S.items.size ? t('This folder is empty') : t('Drop files or folders here')),
    el('p', t('Or add them with the buttons. Pasting works too.')),
    el('div.fm-blank__actions',
      btn(t('Add files'), A.addFromPicker, { variant: 'primary', ico: 'plus' }),
      canPickFolder ? btn(t('Add folder'), A.addFolderFromPicker, { variant: 'secondary', ico: 'folder' }) : null));
}

function renderList() {
  stats = folderStats();
  rows = visibleRows(stats);
  rendered = 0;
  thumbObserver.disconnect();
  moreObserver.disconnect();
  refs.list.dataset.view = S.view;
  refs.list.classList.toggle('is-search', isSearching());
  if (!rows.length) { fill(refs.list, emptyState()); return; }

  const sortBtn = (key, label, cls) => el(`button.fm-th.${cls}${S.sort.key === key ? '.is-sorted' : ''}`, {
    type: 'button', onclick: () => setSort(key), 'aria-sort': S.sort.key === key ? (S.sort.dir > 0 ? 'ascending' : 'descending') : undefined,
  }, label, S.sort.key === key ? icon(S.sort.dir > 0 ? 'up' : 'down', 'fm-i fm-th__arrow') : null);
  const allSelected = rows.length > 0 && rows.every(r => S.selection.has(r.id));
  const head = S.view === 'list' ? el('div.fm-head', { role: 'row' },
    el(`span.fm-check.fm-check--all${allSelected ? '.is-on' : ''}`, { role: 'checkbox', tabIndex: 0, 'aria-checked': String(allSelected), 'aria-label': t('Select everything'), onclick: toggleAll }, icon('check')),
    el('span'),
    sortBtn('name', t('Name'), 'fm-th--name'), sortBtn('kind', t('Type'), 'fm-th--kind'),
    sortBtn('size', t('Size'), 'fm-th--size'), sortBtn('modified', t('Changed'), 'fm-th--date')) : null;

  fill(refs.list, head, el(`div.fm-rows.fm-rows--${S.view}`, { role: S.view === 'list' ? 'rowgroup' : 'listbox' }));
  appendRows();
}

function syncSelection() {
  refs.list.querySelectorAll('[data-key]').forEach(node => {
    const on = S.selection.has(node.dataset.key);
    node.classList.toggle('is-selected', on);
    node.setAttribute('aria-selected', on);
    node.querySelector('.fm-check')?.setAttribute('aria-checked', on);
    node.classList.toggle('is-cursor', node.dataset.key === cursor);
  });
  const all = refs.list.querySelector('.fm-check--all');
  if (all) {
    const on = rows.length > 0 && rows.every(r => S.selection.has(r.id));
    all.classList.toggle('is-on', on);
    all.setAttribute('aria-checked', on);
  }
}

function renderStatus() {
  const selected = S.selection.size;
  const files = selected ? expand(S.selection) : null;
  const total = stats.get('') || { count: 0, size: 0 };
  fill(refs.status,
    el('span.fm-status__main', selected
      ? t('Selected: {n} · {size}', { n: fmtNum(selected), size: fmtBytes(files.reduce((sum, it) => sum + it.size, 0)) })
      : isSearching() ? t('Found: {n}', { n: fmtNum(rows.length) })
        : t('Files: {n} · {size}', { n: fmtNum(total.count), size: fmtBytes(total.size) })),
    el('span.fm-status__note', icon('shield'), t('Changes stay in this workspace. Files on disk are only written when you download or save.')),
    el('button.fm-status__keys', { type: 'button', onclick: () => dialogs.shortcutsDialog(MOD) }, el('kbd', 'Space'), t('Quick Look'), el('kbd', `${MOD} K`), t('Commands')));
}

// ─── Selection ────────────────────────────────────────────────────────────────

const keyAt = index => rows[index]?.id;
const indexOf = key => rows.findIndex(r => r.id === key);

function selectOnly(key) { S.selection = new Set(key ? [key] : []); S.anchor = key; cursor = key; emit('selection'); }
function toggle(key) {
  if (S.selection.has(key)) S.selection.delete(key); else S.selection.add(key);
  S.anchor = key; cursor = key; emit('selection');
}
function selectRange(key) {
  const a = Math.max(0, indexOf(S.anchor)), b = indexOf(key);
  if (b < 0) return;
  S.selection = new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map(r => r.id));
  cursor = key; emit('selection');
}
function toggleAll() {
  const all = rows.length > 0 && rows.every(r => S.selection.has(r.id));
  S.selection = new Set(all ? [] : rows.map(r => r.id));
  emit('selection');
}

function open(key) {
  if (isFolderKey(key)) { navigate(key.slice(4)); refs.search.value = ''; return; }
  openQuickLook(key);
}

function openQuickLook(key) {
  const files = rows.filter(r => !r.isFolder);
  const index = Math.max(0, files.findIndex(r => r.id === key));
  if (!files.length) return;
  dialogs.quickLook(files, index, {
    actions: (item, close) => [
      btn(t('Download'), () => download(item.file, item.name), { ico: 'download' }),
      btn(t('Show in list'), () => { close(); reveal(item); }, { ico: 'eye', className: 'fm-btn fm-btn--ghost fm-hide-s' }),
    ],
  });
}

/** Go to a file's folder and select it. */
function reveal(item) {
  S.cwd = item.dir; S.query = ''; S.kind = null; refs.search.value = '';
  S.selection = new Set([item.id]); S.anchor = cursor = item.id;
  emit('nav', 'selection');
  requestAnimationFrame(() => {
    while (rendered < rows.length && !refs.list.querySelector(`[data-key="${item.id}"]`)) appendRows();
    refs.list.querySelector(`[data-key="${item.id}"]`)?.scrollIntoView({ block: 'center' });
  });
}

function contextMenu(e, key) {
  e.preventDefault();
  if (key && !S.selection.has(key)) selectOnly(key);
  if (!key) {
    return menu([
      { label: t('Add files'), ico: 'files', run: A.addFromPicker },
      canPickFolder && { label: t('Add folder'), ico: 'folder', run: A.addFolderFromPicker },
      { label: t('New folder'), ico: 'folderPlus', run: A.newFolder },
      '-',
      { label: t('Select everything'), ico: 'select', run: toggleAll, kbd: `${MOD} A` },
      { label: t('Create a ZIP from everything here'), ico: 'zip', run: () => A.zip([]) },
    ], { x: e.clientX, y: e.clientY });
  }
  const files = A.targets();
  const onlyFiles = [...S.selection].every(k => !isFolderKey(k));
  const single = S.selection.size === 1;
  const { here, tools } = onlyFiles ? A.suggestions(files) : { here: [], tools: [] };
  menu([
    single && { label: isFolderKey(key) ? t('Open') : t('Quick Look'), ico: isFolderKey(key) ? 'folder' : 'eye', run: () => open(key), kbd: isFolderKey(key) ? 'Enter' : 'Space' },
    { label: t('Download'), ico: 'download', run: A.downloadSelection },
    { label: t('Create ZIP'), ico: 'zip', run: () => A.zip() },
    ...(here.length ? ['-', ...here] : []),
    ...(tools.length ? [{ heading: t('Open with') }, ...tools.slice(0, 5), { label: t('All tools…'), ico: 'wand', run: A.openToolPalette }] : []),
    '-',
    { label: t('Rename'), ico: 'rename', run: A.rename, kbd: 'F2' },
    { label: t('Move to folder'), ico: 'move', run: () => dialogs.moveDialog(new Set(S.selection)) },
    onlyFiles && { label: t('Checksums'), ico: 'hash', run: A.checksums },
    '-',
    { label: t('Remove from the workspace'), ico: 'trash', run: A.removeSelection, danger: true, kbd: 'Del' },
  ], { x: e.clientX, y: e.clientY });
}

function bindList() {
  const list = refs.list;
  let lastTouch = false;
  list.addEventListener('pointerdown', e => { lastTouch = e.pointerType === 'touch'; });

  list.addEventListener('click', e => {
    const node = e.target.closest('[data-key]');
    if (!node) { if (!e.target.closest('.fm-head, button, .fm-blank')) selectOnly(null); return; }
    const key = node.dataset.key;
    if (e.target.closest('.fm-check')) return toggle(key);
    if (e.shiftKey) return selectRange(key);
    if (e.metaKey || e.ctrlKey) return toggle(key);
    if (lastTouch && isFolderKey(key)) return open(key);
    selectOnly(key);

  });
  list.addEventListener('dblclick', e => {
    const node = e.target.closest('[data-key]');
    if (node && !e.target.closest('.fm-check')) open(node.dataset.key);
  });
  list.addEventListener('contextmenu', e => contextMenu(e, e.target.closest('[data-key]')?.dataset.key));

  // Dragging rows onto folders
  list.addEventListener('dragstart', e => {
    const node = e.target.closest('[data-key]');
    if (!node) return;
    if (!S.selection.has(node.dataset.key)) selectOnly(node.dataset.key);
    e.dataTransfer.setData('application/x-fm-move', '1');
    e.dataTransfer.effectAllowed = 'move';
    app.classList.add('is-moving');
  });
  list.addEventListener('dragend', () => { app.classList.remove('is-moving'); clearDropMarks(); });
}

// ─── Drag and drop ────────────────────────────────────────────────────────────

const isExternal = e => e.dataTransfer?.types.includes('Files') && !e.dataTransfer.types.includes('application/x-fm-move');
const isInternal = e => e.dataTransfer?.types.includes('application/x-fm-move');
const clearDropMarks = () => app.querySelectorAll('.is-droptarget').forEach(n => n.classList.remove('is-droptarget'));

async function takeDrop(dataTransfer, into) {
  const list = await task(t('Reading files…'), () => fromDrop(dataTransfer));
  if (!list?.length) return;
  openApp();
  const added = A.intake(list, { into });
  if (added.length && into === S.cwd) toast(t('Added: {n}', { n: fmtNum(added.length) }));
}

function bindDrops() {
  let depth = 0;
  window.addEventListener('dragenter', e => { if (isExternal(e)) { depth++; document.body.classList.add('fm-dragging'); } });
  window.addEventListener('dragleave', e => { if (isExternal(e) && --depth <= 0) { depth = 0; document.body.classList.remove('fm-dragging'); } });
  window.addEventListener('dragover', e => {
    if (!isExternal(e) && !isInternal(e)) return;
    const target = e.target.closest?.('[data-drop]');
    if (isInternal(e) && !target) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = isInternal(e) ? 'move' : 'copy';
    clearDropMarks();
    target?.classList.add('is-droptarget');
  });
  window.addEventListener('drop', e => {
    const target = e.target.closest?.('[data-drop]');
    depth = 0;
    document.body.classList.remove('fm-dragging');
    clearDropMarks();
    if (isInternal(e)) {
      if (!target) return;
      e.preventDefault();
      const n = move(new Set(S.selection), target.dataset.drop);
      if (n) toast(t('Moved: {n}', { n: fmtNum(n) }));
      return;
    }
    if (!isExternal(e)) return;
    e.preventDefault();
    takeDrop(e.dataTransfer, target && !app.hidden ? target.dataset.drop : S.cwd);
  });
  document.addEventListener('paste', e => {
    if (e.target.closest?.('input, textarea, [contenteditable]')) return;
    const list = fromPaste(e.clipboardData);
    if (!list.length) return;
    e.preventDefault();
    openApp();
    A.addResults(list.map(x => ({ file: x.file, dir: S.cwd })));
  });
}

// ─── Keyboard ─────────────────────────────────────────────────────────────────

function columns() {
  if (S.view !== 'grid') return 1;
  const tiles = [...refs.list.querySelectorAll('.fm-tile')];
  if (!tiles.length) return 1;
  const top = tiles[0].offsetTop;
  const n = tiles.findIndex(tile => tile.offsetTop !== top);
  return n < 0 ? tiles.length : n;
}

function moveCursor(delta, extend) {
  if (!rows.length) return;
  const from = indexOf(cursor);
  const to = Math.max(0, Math.min(rows.length - 1, (from < 0 ? (delta > 0 ? -1 : rows.length) : from) + delta));
  while (rendered <= to) appendRows();
  const key = keyAt(to);
  if (extend) selectRange(key); else selectOnly(key);
  refs.list.querySelector(`[data-key="${key}"]`)?.scrollIntoView({ block: 'nearest' });
}

function openPalette() {
  const files = A.targets();
  const has = S.selection.size > 0;
  const { here, tools } = [...S.selection].every(k => !isFolderKey(k)) ? A.suggestions(files) : { here: [], tools: [] };
  const g = { sel: t('For the selection'), ws: t('Workspace'), view: t('View'), go: t('Go to folder') };
  const commands = [
    ...here.map(c => ({ ...c, group: g.sel })),
    ...tools.map(c => ({ ...c, group: g.sel })),
    ...(has ? [
      { label: t('Download'), ico: 'download', run: A.downloadSelection, group: g.sel },
      { label: t('Create ZIP'), ico: 'zip', run: () => A.zip(), group: g.sel },
      { label: t('Rename'), ico: 'rename', run: A.rename, kbd: 'F2', group: g.sel },
      { label: t('Move to folder'), ico: 'move', run: () => dialogs.moveDialog(new Set(S.selection)), group: g.sel },
      { label: t('Checksums'), ico: 'hash', run: A.checksums, group: g.sel },
      { label: t('Remove from the workspace'), ico: 'trash', run: A.removeSelection, kbd: 'Del', group: g.sel },
    ] : []),
    { label: t('Add files'), ico: 'files', run: A.addFromPicker, group: g.ws },
    canPickFolder && { label: t('Add folder'), ico: 'folder', run: A.addFolderFromPicker, group: g.ws },
    { label: t('New folder'), ico: 'folderPlus', run: A.newFolder, group: g.ws },
    { label: t('Create a ZIP from everything here'), ico: 'zip', run: () => A.zip([]), group: g.ws },
    { label: t('Find duplicates'), ico: 'duplicate', run: A.findDuplicates, group: g.ws },
    { label: t('Rename many files'), ico: 'rename', run: A.renameAll, group: g.ws },
    { label: t('Convert images'), ico: 'image', run: A.convertImages, group: g.ws },
    { label: t('Export file list'), ico: 'table', run: A.exportList, group: g.ws },
    A.canSaveToFolder && { label: t('Save to a folder on this device'), ico: 'save', run: A.saveToFolder, group: g.ws },
    { label: t('Close the workspace'), ico: 'x', run: () => A.clearWorkspace(closeApp), group: g.ws },
    { label: S.view === 'list' ? t('Show as grid') : t('Show as list'), ico: S.view === 'list' ? 'grid' : 'list', run: () => setView(S.view === 'list' ? 'grid' : 'list'), group: g.view },
    { label: t('Show or hide details'), ico: 'panel', run: toggleDetails, group: g.view },
    { label: t('Light or dark'), ico: 'eye', run: toggleTheme, group: g.view },
    { label: t('Keyboard shortcuts'), ico: 'keyboard', run: () => dialogs.shortcutsDialog(MOD), group: g.view },
    ...A.allToolCommands(files),
    ...[...S.folders].sort(collator.compare).slice(0, 300).map(f => ({ label: f, ico: 'folder', run: () => navigate(f), group: g.go })),
    ...[...S.items.values()].slice(0, 2000).map(it => ({ label: it.name, hint: it.dir, ico: 'files', run: () => reveal(it), group: t('Files') })),
  ].filter(Boolean);
  // A tool suggested for the selection is also in the full list; keep the first
  const seen = new Set();
  dialogs.palette(commands.filter(c => { const key = `${c.label}|${c.hint || ''}|${c.external ? 1 : 0}`; const tool = c.external ? c.label : key; if (seen.has(tool)) return false; seen.add(tool); return true; }));
}

function bindKeys() {
  document.addEventListener('keydown', e => {
    if (app.hidden) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); if (!document.querySelector('dialog[open]')) openPalette(); return; }
    if (document.querySelector('dialog[open]') || e.target.closest('input, textarea, select, .fm-menu')) {
      if (e.key === 'Escape' && e.target === refs.search) { refs.search.value = ''; S.query = ''; emit('nav'); refs.list.focus(); }
      return;
    }
    const cols = columns();
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); moveCursor(cols, e.shiftKey); break;
      case 'ArrowUp': e.preventDefault(); moveCursor(-cols, e.shiftKey); break;
      case 'ArrowRight': if (S.view === 'grid') { e.preventDefault(); moveCursor(1, e.shiftKey); } break;
      case 'ArrowLeft': if (S.view === 'grid') { e.preventDefault(); moveCursor(-1, e.shiftKey); } break;
      case 'Home': e.preventDefault(); moveCursor(-rows.length, e.shiftKey); break;
      case 'End': e.preventDefault(); moveCursor(rows.length, e.shiftKey); break;
      case 'Enter': if (S.selection.size === 1 && !e.target.closest('button, a')) { e.preventDefault(); open([...S.selection][0]); } break;
      case ' ': if (!e.target.closest('button, a') && S.selection.size) { e.preventDefault(); const k = [...S.selection].find(x => !isFolderKey(x)); if (k) openQuickLook(cursor && S.selection.has(cursor) && !isFolderKey(cursor) ? cursor : k); } break;
      case 'Backspace': if (S.cwd && !isSearching()) { e.preventDefault(); const from = folderKey(S.cwd); navigate(parentOf(S.cwd)); cursor = from; S.selection = new Set([from]); emit('selection'); } break;
      case 'Delete': if (S.selection.size) { e.preventDefault(); A.removeSelection(); } break;
      case 'F2': if (S.selection.size) { e.preventDefault(); A.rename(); } break;
      case 'Escape': closeMenu(); if (S.selection.size) selectOnly(null); app.classList.remove('is-side-open', 'is-details-open'); break;
      case '/': e.preventDefault(); refs.search.focus(); refs.search.select(); break;
      case 'a': case 'A': if (mod) { e.preventDefault(); S.selection = new Set(rows.map(r => r.id)); emit('selection'); } break;
      default:
    }
  });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

function render(topics) {
  const structural = topics.has('items') || topics.has('nav') || topics.has('view');
  if (topics.has('items')) {
    for (const key of [...S.selection]) {
      if (isFolderKey(key) ? !S.folders.has(key.slice(4)) : !S.items.has(key)) S.selection.delete(key);
    }
    if (S.cwd && !S.folders.has(S.cwd)) S.cwd = '';
  }
  if (structural) {
    app.classList.toggle('has-details', S.details);
    renderList();
    renderTree();
    renderKinds();
    renderCrumbs();
  } else syncSelection();
  renderBar();
  renderStatus();
  details.render(topics, stats);
  if (structural) syncSelection();
}

async function boot() {
  await loadStrings();
  let routes = {}, pages = {};
  try {
    const mod = await import(`/assets/i18n/routes.${lang}.js`);
    routes = mod.default; pages = mod.pages || {};
  } catch { /* tools stay unlinked */ }
  A.configure(routes, pages);
  loadPrefs();
  buildShell();
  bindList();
  bindDrops();
  bindKeys();
  subscribe(render);
  render(new Set(['items', 'nav', 'selection', 'view']));

  const start = async fn => { const before = S.items.size; await fn(); if (S.items.size > before) openApp(); };
  landing.querySelectorAll('[data-fm="open-files"]').forEach(b => b.addEventListener('click', () => start(A.addFromPicker)));
  landing.querySelectorAll('[data-fm="open-folder"]').forEach(b => {
    if (!canPickFolder) { b.hidden = true; return; }
    b.addEventListener('click', () => start(A.addFolderFromPicker));
  });
  landing.querySelectorAll('[data-fm="demo"]').forEach(b => b.addEventListener('click', async () => {
    const { demoFiles } = await import('./demo.js');
    A.intake(await demoFiles());
    openApp();
  }));

  const id = handoffIdFromUrl();
  if (id) {
    const files = await takeHandoff(id);
    if (files.length) { openApp(); A.addResults(files.map(file => ({ file, dir: file.handoffDir || '' }))); }
  }
  window.FilesOnlineManager = { S, A, openApp, closeApp, emit };
}

boot();
