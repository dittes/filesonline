// app.js
// Main entry point for Files Online.
// Wires together all modules, manages workspace layout, file table, keyboard shortcuts.

import {
  state,
  on,
  addFiles,
  clearFiles,
  setSelectedIds,
  toggleSelected,
  selectAll,
  selectNone,
  setActiveModule,
  openPreview,
  closePreview,
  setFilter,
  getFilteredFiles,
  removeFiles,
  openWorkspace as stateOpenWorkspace,
  closeWorkspace as stateCloseWorkspace,
} from './state.js';

import {
  formatBytes,
  formatDate,
  getFileTypeIcon,
  debounce,
  escapeHtml,
  truncateMiddle,
  downloadBlob,
} from './utils.js';

import { openFiles, openFolder, setupDropZone } from './file-access.js';
import { initPreviewPanel, previewFile, clearPreview } from './preview.js';

// ─── Lazy module imports ───────────────────────────────────────────────────────
// These modules are loaded on demand so missing files don't crash the app.

let _archivesModule = null;
let _renameModule = null;
let _metadataModule = null;
let _recipesModule = null;
let _folderTreeModule = null;
let _storageModule = null;
let _uiModule = null;
let _browserSupportModule = null;
let _toolsModule = null;
let _themeModule = null;

async function tryImport(path) {
  try {
    return await import(path);
  } catch (err) {
    console.warn(`app: optional module not found — ${path}`, err.message);
    return null;
  }
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────

/** @param {string} sel @param {HTMLElement|Document} [ctx] @returns {HTMLElement|null} */
const $ = (sel, ctx = document) => ctx.querySelector(sel);
/** @param {string} sel @param {HTMLElement|Document} [ctx] @returns {NodeList} */
const $$ = (sel, ctx = document) => ctx.querySelectorAll(sel);

// ─── Sort state ───────────────────────────────────────────────────────────────

/** @type {{ col: string, dir: 'asc'|'desc' }} */
let _sortState = { col: 'name', dir: 'asc' };

// ─── View mode (list | grid) ──────────────────────────────────────────────────

/** @type {'list'|'grid'} */
let _viewMode = 'list';
try {
  if (localStorage.getItem('fo-view') === 'grid') _viewMode = 'grid';
} catch { /* private mode */ }

/** Object URLs for grid thumbnails, keyed by file id. */
const _thumbUrls = new Map();

/** Lazily load thumbnails as cards scroll into view. */
let _thumbObserver = null;

function _releaseThumb(id) {
  const url = _thumbUrls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    _thumbUrls.delete(id);
  }
}

function _releaseAllThumbs() {
  for (const url of _thumbUrls.values()) URL.revokeObjectURL(url);
  _thumbUrls.clear();
}

// ─── Last clicked row index for shift-click range selection ───────────────────
let _lastClickedIndex = -1;

// ─── Context menu cleanup reference ──────────────────────────────────────────
let _contextMenuCleanup = null;

// ─── File table rendering ─────────────────────────────────────────────────────

/**
 * Render the complete file table with toolbar into the given container.
 * @param {HTMLElement} containerEl
 */
export function renderFileTable(containerEl) {
  containerEl.innerHTML = `
    <div class="file-table-wrap">
      <div class="file-toolbar">
        <div class="file-toolbar-left">
          <input
            type="search"
            class="input input-sm file-search"
            placeholder="Search files\u2026"
            aria-label="Search files"
          />
          <select class="select select-sm file-type-filter" aria-label="Filter by type">
            <option value="">All types</option>
            <option value="image">Images</option>
            <option value="video">Video</option>
            <option value="audio">Audio</option>
            <option value="pdf">PDF</option>
            <option value="document">Documents</option>
            <option value="spreadsheet">Spreadsheets</option>
            <option value="code">Code</option>
            <option value="text">Text</option>
            <option value="archive">Archives</option>
            <option value="binary">Binary</option>
          </select>
        </div>
        <div class="file-toolbar-right">
          <div class="view-toggle" role="group" aria-label="View mode">
            <button class="view-list-btn" title="List view" aria-label="List view">
              <svg viewBox="0 0 16 16" fill="none" width="14" height="14"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            </button>
            <button class="view-grid-btn" title="Grid view" aria-label="Grid view">
              <svg viewBox="0 0 16 16" fill="none" width="14" height="14"><rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.4"/><rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.4"/><rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.4"/><rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.4"/></svg>
            </button>
          </div>
          <button class="btn btn-sm btn-ghost toolbar-add-files" title="Add files">
            <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14">
              <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            <span class="btn-label">Add Files</span>
          </button>
          <button class="btn btn-sm btn-ghost toolbar-add-folder" title="Add folder">
            <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14">
              <path d="M2 4a1 1 0 011-1h4l1 1h5a1 1 0 011 1v7a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" fill="currentColor" opacity=".4"/>
              <path d="M8 8v4M6 10h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            <span class="btn-label">Add Folder</span>
          </button>
          <button class="btn btn-sm btn-ghost toolbar-download-zip" title="Download selected as ZIP" disabled>
            <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14">
              <path d="M8 2v8M5 7l3 3 3-3M3 13h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            <span class="btn-label">Download ZIP</span>
          </button>
          <button class="btn btn-sm btn-ghost toolbar-get-metadata" title="Get metadata for selected" disabled>
            <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14">
              <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/>
              <path d="M8 7v5M8 5v1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            <span class="btn-label">Metadata</span>
          </button>
          <button class="btn btn-sm btn-danger toolbar-clear-files" title="Clear all files">
            <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14">
              <path d="M3 5h10l-1 8H4L3 5zM6 5V3h4v2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            <span class="btn-label">Clear</span>
          </button>
        </div>
      </div>

      <nav class="file-breadcrumb" aria-label="Folder path" hidden></nav>

      <div class="file-table-container">
        <table class="file-table" role="grid" aria-label="Loaded files">
          <thead>
            <tr>
              <th class="col-check">
                <input type="checkbox" class="checkbox select-all-checkbox" aria-label="Select all files" />
              </th>
              <th class="col-name sortable" data-col="name">
                Name <span class="sort-indicator" aria-hidden="true"></span>
              </th>
              <th class="col-ext sortable" data-col="ext">
                Ext <span class="sort-indicator" aria-hidden="true"></span>
              </th>
              <th class="col-size sortable" data-col="size">
                Size <span class="sort-indicator" aria-hidden="true"></span>
              </th>
              <th class="col-modified sortable" data-col="modified">
                Modified <span class="sort-indicator" aria-hidden="true"></span>
              </th>
              <th class="col-path sortable" data-col="path">
                Path <span class="sort-indicator" aria-hidden="true"></span>
              </th>
            </tr>
          </thead>
          <tbody class="file-tbody">
          </tbody>
        </table>
        <div class="file-grid" hidden></div>
        <div class="file-empty-state" hidden>
          <div class="empty-icon">
            <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" width="64" height="64" aria-hidden="true">
              <path d="M12 8h28l12 12v36H12z" stroke="currentColor" stroke-width="2"/>
              <path d="M40 8v12h12" stroke="currentColor" stroke-width="2"/>
              <path d="M24 32h16M24 40h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </div>
          <h3>No files loaded</h3>
          <p>Drop files here or use the buttons below to get started.</p>
          <div class="empty-actions">
            <button class="btn btn-primary empty-open-folder">Open Folder</button>
            <button class="btn btn-secondary empty-open-files">Open Files</button>
          </div>
        </div>
      </div>

      <div class="file-status-bar">
        <span class="status-text">No files loaded</span>
      </div>
    </div>
  `;

  _bindFileTableEvents(containerEl);
  _refreshFileTable(containerEl);
}

/**
 * Bind all events for the file table inside containerEl.
 * @param {HTMLElement} containerEl
 */
function _bindFileTableEvents(containerEl) {
  // Search input
  const searchInput = $('.file-search', containerEl);
  if (searchInput) {
    searchInput.addEventListener('input', debounce(e => {
      setFilter('search', e.target.value);
    }, 300));
  }

  // Type filter
  const typeFilter = $('.file-type-filter', containerEl);
  if (typeFilter) {
    typeFilter.addEventListener('change', e => {
      setFilter('category', e.target.value);
    });
  }

  // Add files button
  const addFilesBtn = $('.toolbar-add-files', containerEl);
  if (addFilesBtn) {
    addFilesBtn.addEventListener('click', async () => {
      await openFiles();
    });
  }

  // Add folder button
  const addFolderBtn = $('.toolbar-add-folder', containerEl);
  if (addFolderBtn) {
    addFolderBtn.addEventListener('click', async () => {
      await openFolder();
    });
  }

  // Download ZIP button
  const dlZipBtn = $('.toolbar-download-zip', containerEl);
  if (dlZipBtn) {
    dlZipBtn.addEventListener('click', () => {
      _downloadSelectedAsZip();
    });
  }

  // Metadata button
  const metaBtn = $('.toolbar-get-metadata', containerEl);
  if (metaBtn) {
    metaBtn.addEventListener('click', () => {
      setActiveModule('metadata');
    });
  }

  // Clear files button
  const clearBtn = $('.toolbar-clear-files', containerEl);
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (state.files.size === 0) return;
      const count = state.files.size;
      if (confirm(`Remove all ${count} file${count !== 1 ? 's' : ''} from the workspace? (Files on your disk are not affected.)`)) {
        clearFiles();
        clearPreview();
      }
    });
  }

  // Select all checkbox
  const selectAllCb = $('.select-all-checkbox', containerEl);
  if (selectAllCb) {
    selectAllCb.addEventListener('change', e => {
      if (e.target.checked) {
        selectAll();
      } else {
        selectNone();
      }
    });
  }

  // Column sort headers
  $$('.sortable', containerEl).forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (!col) return;
      if (_sortState.col === col) {
        _sortState.dir = _sortState.dir === 'asc' ? 'desc' : 'asc';
      } else {
        _sortState.col = col;
        _sortState.dir = 'asc';
      }
      setFilter('sort', _sortState.col);
      setFilter('order', _sortState.dir);
      _updateSortIndicators(containerEl);
    });
  });

  // Empty state CTA buttons
  const emptyOpenFiles = $('.empty-open-files', containerEl);
  if (emptyOpenFiles) {
    emptyOpenFiles.addEventListener('click', async () => {
      await openFiles();
      openWorkspace();
    });
  }

  const emptyOpenFolder = $('.empty-open-folder', containerEl);
  if (emptyOpenFolder) {
    emptyOpenFolder.addEventListener('click', async () => {
      await openFolder();
      openWorkspace();
    });
  }

  // View mode toggle
  const listBtn = $('.view-list-btn', containerEl);
  const gridBtn = $('.view-grid-btn', containerEl);
  const setView = mode => {
    _viewMode = mode;
    try { localStorage.setItem('fo-view', mode); } catch { /* private mode */ }
    _refreshFileTable(containerEl);
  };
  if (listBtn) listBtn.addEventListener('click', () => setView('list'));
  if (gridBtn) gridBtn.addEventListener('click', () => setView('grid'));

  // Row/card interaction — bound once via delegation (rows are re-rendered,
  // their containers are not, so binding per refresh would stack listeners)
  const tbody = $('.file-tbody', containerEl);
  if (tbody) _bindRowEvents(tbody);
  const grid = $('.file-grid', containerEl);
  if (grid) _bindRowEvents(grid);
}

/**
 * Re-render the tbody and update status bar.
 * @param {HTMLElement} containerEl
 */
function _refreshFileTable(containerEl) {
  const tbody = $('.file-tbody', containerEl);
  const emptyState = $('.file-empty-state', containerEl);
  const statusText = $('.status-text', containerEl);
  const selectAllCb = $('.select-all-checkbox', containerEl);

  if (!tbody) return;

  const files = getFilteredFiles();
  const totalFiles = state.files.size;
  const selectedCount = state.selectedIds.size;

  // Empty state / view visibility
  if (emptyState) emptyState.hidden = totalFiles > 0;
  const table = $('.file-table-container > .file-table', containerEl);
  const grid = $('.file-grid', containerEl);
  const showList = totalFiles > 0 && _viewMode === 'list';
  const showGrid = totalFiles > 0 && _viewMode === 'grid';
  if (table) table.style.display = showList ? '' : 'none';
  if (grid) grid.hidden = !showGrid;

  // View toggle button states
  const listBtn = $('.view-list-btn', containerEl);
  const gridBtn = $('.view-grid-btn', containerEl);
  if (listBtn) listBtn.classList.toggle('active', _viewMode === 'list');
  if (gridBtn) gridBtn.classList.toggle('active', _viewMode === 'grid');

  // Render rows / cards
  if (showGrid) {
    tbody.innerHTML = '';
    _renderGrid(grid, files);
  } else {
    if (grid) grid.innerHTML = '';
    tbody.innerHTML = files.map((entry, index) => _buildFileRow(entry, index)).join('');
  }

  // Update select-all checkbox state
  if (selectAllCb) {
    const allSelected = totalFiles > 0 && selectedCount === totalFiles;
    const someSelected = selectedCount > 0 && selectedCount < totalFiles;
    selectAllCb.checked = allSelected;
    selectAllCb.indeterminate = someSelected;
  }

  // Update status bar
  if (statusText) {
    if (totalFiles === 0) {
      statusText.textContent = 'No files loaded';
    } else {
      let totalSize = 0;
      for (const f of state.files.values()) totalSize += f.size;
      const parts = [
        `${totalFiles.toLocaleString()} file${totalFiles !== 1 ? 's' : ''}`,
        selectedCount > 0 ? `${selectedCount} selected` : '',
        formatBytes(totalSize),
      ].filter(Boolean);
      statusText.textContent = parts.join(' \u00b7 ');
    }
  }

  // Update action button states
  const dlZipBtn = $('.toolbar-download-zip', containerEl);
  const metaBtn = $('.toolbar-get-metadata', containerEl);
  if (dlZipBtn) dlZipBtn.disabled = selectedCount === 0;
  if (metaBtn) metaBtn.disabled = selectedCount === 0;

  // Update sort indicators
  _updateSortIndicators(containerEl);

  // Update breadcrumb
  _renderBreadcrumb(containerEl);
}

/**
 * Render the folder breadcrumb below the toolbar when a path filter is active.
 * @param {HTMLElement} containerEl
 */
function _renderBreadcrumb(containerEl) {
  const bar = $('.file-breadcrumb', containerEl);
  if (!bar) return;

  const path = (state.filters.path || '').replace(/\/$/, '');
  if (!path || state.files.size === 0) {
    bar.hidden = true;
    bar.innerHTML = '';
    return;
  }

  const segments = path.split('/').filter(Boolean);
  const crumbs = [
    `<button class="crumb" data-path="">
      <svg viewBox="0 0 16 16" fill="none" width="12" height="12" aria-hidden="true"><path d="M2 7l6-5 6 5v6a1 1 0 01-1 1H3a1 1 0 01-1-1V7z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
      All Files
    </button>`,
  ];
  let prefix = '';
  segments.forEach((seg, i) => {
    prefix += seg + '/';
    const isLast = i === segments.length - 1;
    crumbs.push(`<span class="crumb-sep" aria-hidden="true">/</span>`);
    crumbs.push(isLast
      ? `<span class="crumb crumb-current" aria-current="location">${escapeHtml(seg)}</span>`
      : `<button class="crumb" data-path="${escapeHtml(prefix)}">${escapeHtml(seg)}</button>`);
  });

  bar.innerHTML = crumbs.join('');
  bar.hidden = false;

  bar.querySelectorAll('button.crumb').forEach(btn => {
    btn.addEventListener('click', () => setFilter('path', btn.dataset.path || ''));
  });
}

/**
 * Render the grid (thumbnail) view.
 * @param {HTMLElement} gridEl
 * @param {import('./state.js').FileEntry[]} files
 */
function _renderGrid(gridEl, files) {
  if (!gridEl) return;
  gridEl.innerHTML = files.map((entry, index) => {
    const selected = state.selectedIds.has(entry.id);
    const isImage = entry.category === 'image';
    return `
      <div
        class="file-card${selected ? ' selected' : ''}"
        data-id="${escapeHtml(entry.id)}"
        data-index="${index}"
        tabindex="0"
        aria-selected="${selected}"
        title="${escapeHtml(entry.relativePath || entry.name)}"
      >
        <input
          type="checkbox"
          class="checkbox row-checkbox file-card-check"
          ${selected ? 'checked' : ''}
          aria-label="Select ${escapeHtml(entry.name)}"
          data-id="${escapeHtml(entry.id)}"
        />
        <div class="file-card-thumb icon-${escapeHtml(entry.category)}"${isImage ? ` data-thumb-id="${escapeHtml(entry.id)}"` : ''}>${getFileTypeIcon(entry.ext)}</div>
        <div class="file-card-body">
          <div class="file-card-name">${escapeHtml(entry.name)}</div>
          <div class="file-card-meta">${escapeHtml(formatBytes(entry.size))}</div>
        </div>
      </div>
    `;
  }).join('');

  _observeThumbs(gridEl);
}

/** Lazily load image thumbnails when their cards scroll into view. */
function _observeThumbs(gridEl) {
  const targets = gridEl.querySelectorAll('[data-thumb-id]');
  if (!targets.length) return;

  if (!('IntersectionObserver' in window)) {
    targets.forEach(_loadThumb);
    return;
  }

  if (_thumbObserver) _thumbObserver.disconnect();
  _thumbObserver = new IntersectionObserver(entries => {
    for (const ent of entries) {
      if (ent.isIntersecting) {
        _thumbObserver.unobserve(ent.target);
        _loadThumb(ent.target);
      }
    }
  }, { root: gridEl, rootMargin: '200px' });

  targets.forEach(el => _thumbObserver.observe(el));
}

function _loadThumb(thumbEl) {
  const id = thumbEl.dataset.thumbId;
  const entry = state.files.get(id);
  if (!entry) return;

  let url = _thumbUrls.get(id);
  if (!url) {
    url = URL.createObjectURL(entry.file);
    _thumbUrls.set(id, url);
  }

  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  img.onload = () => {
    thumbEl.textContent = '';
    thumbEl.appendChild(img);
  };
  // On decode failure keep the type icon
  img.src = url;
}

/**
 * Build a single table row HTML for a FileEntry.
 * @param {import('./state.js').FileEntry} entry
 * @param {number} index
 * @returns {string}
 */
function _buildFileRow(entry, index) {
  const selected = state.selectedIds.has(entry.id);
  const icon = getFileTypeIcon(entry.ext);
  const displayName = truncateMiddle(entry.name, 48);
  const displayPath = truncateMiddle(entry.relativePath || entry.path || '', 40);

  return `
    <tr
      class="file-row${selected ? ' selected' : ''}"
      data-id="${escapeHtml(entry.id)}"
      data-index="${index}"
      role="row"
      aria-selected="${selected}"
      tabindex="0"
    >
      <td class="col-check">
        <input
          type="checkbox"
          class="checkbox row-checkbox"
          ${selected ? 'checked' : ''}
          aria-label="Select ${escapeHtml(entry.name)}"
          data-id="${escapeHtml(entry.id)}"
        />
      </td>
      <td class="col-name">
        <span class="file-icon icon-${escapeHtml(entry.category)}" aria-hidden="true">${icon}</span>
        <span class="file-name" title="${escapeHtml(entry.name)}">${escapeHtml(displayName)}</span>
      </td>
      <td class="col-ext">${escapeHtml(entry.ext || '—')}</td>
      <td class="col-size" title="${entry.size.toLocaleString()} bytes">${escapeHtml(formatBytes(entry.size))}</td>
      <td class="col-modified">${escapeHtml(formatDate(entry.modified))}</td>
      <td class="col-path" title="${escapeHtml(entry.path || '')}">${escapeHtml(displayPath || '—')}</td>
    </tr>
  `;
}

/**
 * Bind click, shift-click, right-click events on a rows/cards container.
 * Uses delegation so it is bound exactly once per container.
 * @param {HTMLElement} container  the tbody (list view) or grid element
 */
function _bindRowEvents(container) {
  container.addEventListener('click', e => {
    const row = e.target.closest('.file-row, .file-card');
    if (!row) return;

    const id = row.dataset.id;
    const index = parseInt(row.dataset.index, 10);

    // Checkbox click: just toggle selection
    if (e.target.classList.contains('row-checkbox')) {
      toggleSelected(id);
      _lastClickedIndex = index;
      return;
    }

    // Shift-click: range selection
    if (e.shiftKey && _lastClickedIndex >= 0) {
      const files = getFilteredFiles();
      const min = Math.min(_lastClickedIndex, index);
      const max = Math.max(_lastClickedIndex, index);
      const rangeIds = files.slice(min, max + 1).map(f => f.id);
      const existing = new Set(state.selectedIds);
      rangeIds.forEach(rid => existing.add(rid));
      setSelectedIds(existing);
      return;
    }

    // Ctrl/Cmd + click: multi-select
    if (e.ctrlKey || e.metaKey) {
      toggleSelected(id);
      _lastClickedIndex = index;
      return;
    }

    // Plain click: select and open preview
    setSelectedIds([id]);
    _lastClickedIndex = index;
    openPreview(id);
  });

  // Right-click context menu
  container.addEventListener('contextmenu', e => {
    const row = e.target.closest('.file-row, .file-card');
    if (!row) return;
    e.preventDefault();
    const id = row.dataset.id;
    const entry = state.files.get(id);
    if (!entry) return;

    // Ensure the row is selected
    if (!state.selectedIds.has(id)) {
      setSelectedIds([id]);
    }

    _showContextMenu(e.clientX, e.clientY, id, entry);
  });
}

/**
 * Show a context menu at x,y for the given file entry.
 * @param {number} x
 * @param {number} y
 * @param {string} id
 * @param {import('./state.js').FileEntry} entry
 */
function _showContextMenu(x, y, id, entry) {
  _dismissContextMenu();

  const menu = document.createElement('ul');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  menu.style.position = 'fixed';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const items = [
    {
      label: 'Preview',
      icon: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14"><path d="M8 3C4 3 1 8 1 8s3 5 7 5 7-5 7-5-3-5-7-5z" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.5"/></svg>`,
      action: () => openPreview(id),
    },
    {
      label: 'Download',
      icon: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14"><path d="M8 2v8M5 7l3 3 3-3M3 13h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
      action: () => downloadBlob(entry.file, entry.name),
    },
    {
      label: 'Copy Name',
      icon: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14"><rect x="5" y="5" width="8" height="9" rx="1" stroke="currentColor" stroke-width="1.5"/><path d="M3 11V3a1 1 0 011-1h7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
      action: () => _copyText(entry.name, 'Name'),
    },
    {
      label: 'Copy Path',
      icon: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14"><path d="M2 4a1 1 0 011-1h4l1 1h5a1 1 0 011 1v7a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" stroke-width="1.5"/></svg>`,
      action: () => _copyText(entry.relativePath || entry.name, 'Path'),
    },
    {
      label: 'Get Metadata',
      icon: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M8 7v5M8 5v1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
      action: () => { setSelectedIds([id]); setActiveModule('metadata'); },
    },
    {
      label: 'Add to Rename',
      icon: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14"><path d="M3 13h10M8 3l4 4-7 7H1v-4l7-7z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
      action: () => { setSelectedIds([id]); setActiveModule('rename'); },
    },
    { separator: true },
    {
      label: 'Remove from Workspace',
      icon: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14"><path d="M3 5h10l-1 8H4L3 5zM6 5V3h4v2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
      className: 'context-menu-danger',
      action: () => {
        // Remove only selected files (or just this one if only one)
        const toRemove = state.selectedIds.size > 1 ? [...state.selectedIds] : [id];
        removeFiles(toRemove);
      },
    },
  ];

  for (const item of items) {
    if (item.separator) {
      const li = document.createElement('li');
      li.className = 'context-menu-separator';
      li.setAttribute('role', 'separator');
      menu.appendChild(li);
    } else {
      const li = document.createElement('li');
      li.className = `context-menu-item${item.className ? ' ' + item.className : ''}`;
      li.setAttribute('role', 'menuitem');
      li.setAttribute('tabindex', '-1');
      li.innerHTML = `${item.icon || ''}<span>${escapeHtml(item.label)}</span>`;
      li.addEventListener('click', () => {
        item.action();
        _dismissContextMenu();
      });
      menu.appendChild(li);
    }
  }

  document.body.appendChild(menu);

  // Adjust if overflowing viewport
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${x - rect.width}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${y - rect.height}px`;
    }
  });

  // Close on outside click or Escape
  const onOutsideClick = e => {
    if (!menu.contains(e.target)) _dismissContextMenu();
  };
  const onEscape = e => {
    if (e.key === 'Escape') _dismissContextMenu();
  };

  setTimeout(() => {
    document.addEventListener('click', onOutsideClick, { once: false });
    document.addEventListener('keydown', onEscape, { once: true });
  }, 0);

  _contextMenuCleanup = () => {
    document.removeEventListener('click', onOutsideClick);
    document.removeEventListener('keydown', onEscape);
  };
}

/** Copy text to the clipboard with a toast. */
async function _copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    if (_uiModule && typeof _uiModule.showToast === 'function') {
      _uiModule.showToast(`${label} copied to clipboard.`, 'success');
    }
  } catch {
    if (_uiModule && typeof _uiModule.showToast === 'function') {
      _uiModule.showToast('Clipboard access was blocked.', 'error');
    }
  }
}

/** Remove any open context menu. */
function _dismissContextMenu() {
  const existing = document.querySelector('.context-menu');
  if (existing) existing.remove();
  if (_contextMenuCleanup) {
    _contextMenuCleanup();
    _contextMenuCleanup = null;
  }
}

/**
 * Update sort indicator arrows in column headers.
 * @param {HTMLElement} containerEl
 */
function _updateSortIndicators(containerEl) {
  $$('.sortable', containerEl).forEach(th => {
    const indicator = th.querySelector('.sort-indicator');
    if (!indicator) return;
    const col = th.dataset.col;
    if (col === _sortState.col) {
      indicator.textContent = _sortState.dir === 'asc' ? ' \u2191' : ' \u2193';
      th.setAttribute('aria-sort', _sortState.dir === 'asc' ? 'ascending' : 'descending');
    } else {
      indicator.textContent = '';
      th.removeAttribute('aria-sort');
    }
  });
}

// ─── ZIP download helper ──────────────────────────────────────────────────────

/**
 * Download selected files as a ZIP archive using JSZip (loaded on demand).
 */
async function _downloadSelectedAsZip() {
  if (state.selectedIds.size === 0) return;

  let JSZip;
  try {
    // Try ESM version first
    const mod = await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js').catch(() => null);
    if (mod && mod.default) {
      JSZip = mod.default;
    } else {
      // Script tag fallback
      await new Promise((resolve, reject) => {
        if (window.JSZip) return resolve();
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
      JSZip = window.JSZip;
    }
  } catch (err) {
    console.error('app: failed to load JSZip', err);
    alert('Could not load ZIP library. Please check your connection and try again.');
    return;
  }

  const zip = new JSZip();
  const selectedEntries = [...state.selectedIds]
    .map(id => state.files.get(id))
    .filter(Boolean);

  for (const entry of selectedEntries) {
    zip.file(entry.path || entry.name, entry.file);
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  downloadBlob(blob, 'files-online-export.zip');
}

// ─── Workspace layout ─────────────────────────────────────────────────────────

/**
 * Open the workspace view.
 */
export function openWorkspace() {
  const ws = document.getElementById('workspace');
  if (ws) ws.removeAttribute('hidden');
  document.body.classList.add('workspace-active');
  history.replaceState(null, '', '#workspace');
  stateOpenWorkspace();
}

/**
 * Close the workspace view and return to the landing page.
 */
export function closeWorkspace() {
  document.body.classList.remove('workspace-active');
  history.replaceState(null, '', '#');
  stateCloseWorkspace();
}

// ─── Module panel switching ───────────────────────────────────────────────────

/**
 * Show the correct module panel and update tab active states.
 * @param {string} moduleName
 */
function _switchModule(moduleName) {
  setActiveModule(moduleName);

  // Update tab buttons and scroll active tab into view
  $$('[data-module-tab]').forEach(btn => {
    const active = btn.dataset.moduleTab === moduleName;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
    if (active) {
      // Scroll the active tab into view within the scrollable tab bar
      requestAnimationFrame(() => {
        const tabBar = btn.closest('.workspace-tabs');
        if (tabBar) {
          const btnLeft = btn.offsetLeft;
          const btnRight = btnLeft + btn.offsetWidth;
          if (btnRight > tabBar.scrollLeft + tabBar.clientWidth) {
            tabBar.scrollLeft = btnRight - tabBar.clientWidth + 4;
          } else if (btnLeft < tabBar.scrollLeft) {
            tabBar.scrollLeft = btnLeft - 4;
          }
        }
      });
    }
  });

  // Show/hide module panels
  $$('[data-module-panel]').forEach(panel => {
    const active = panel.dataset.modulePanel === moduleName;
    panel.hidden = !active;
    panel.classList.toggle('module-panel-active', active);
  });
}

// ─── Status bar ───────────────────────────────────────────────────────────────

/**
 * Update the workspace header status bar with current file counts.
 */
function _updateStatusBar() {
  const statusEl = document.querySelector('#file-count-status, .workspace-status');
  if (!statusEl) return;

  const total = state.files.size;
  const selected = state.selectedIds.size;

  if (total === 0) {
    statusEl.textContent = 'No files loaded';
    return;
  }

  let totalSize = 0;
  for (const f of state.files.values()) totalSize += f.size;

  const parts = [
    `${total.toLocaleString()} file${total !== 1 ? 's' : ''}`,
    selected > 0 ? `${selected} selected` : null,
    formatBytes(totalSize),
  ].filter(Boolean);

  statusEl.textContent = parts.join(' \u00b7 ');
}

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────

/**
 * Register global keyboard shortcuts.
 */
function _initKeyboardShortcuts() {
  document.addEventListener('keydown', async e => {
    // Ignore when typing in an input
    const tag = document.activeElement && document.activeElement.tagName;
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    const ctrl = e.ctrlKey || e.metaKey;

    // Ctrl+O: open files
    if (ctrl && !e.shiftKey && e.key === 'o') {
      e.preventDefault();
      const entries = await openFiles();
      if (entries.length) openWorkspace();
      return;
    }

    // Ctrl+Shift+O: open folder
    if (ctrl && e.shiftKey && e.key === 'O') {
      e.preventDefault();
      const entries = await openFolder();
      if (entries.length) openWorkspace();
      return;
    }

    // Escape: close preview or context menu
    if (e.key === 'Escape') {
      if (_contextMenuCleanup) {
        _dismissContextMenu();
        return;
      }
      if (state.previewFileId) {
        closePreview();
        return;
      }
      // If in a non-browse module, return to browse
      if (state.activeModule !== 'browser') {
        _switchModule('browser');
        return;
      }
    }

    if (inInput) return;

    // "/" focuses the file search box
    if (e.key === '/' && state.workspaceOpen && !ctrl) {
      const search = document.querySelector('.file-search');
      if (search) {
        e.preventDefault();
        search.focus();
        search.select();
      }
      return;
    }

    // Arrow / Enter / Space navigation in the Browse module
    if (state.workspaceOpen && state.activeModule === 'browser' && state.files.size > 0 && !ctrl) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const files = getFilteredFiles();
        if (!files.length) return;
        let idx = _lastClickedIndex;
        if (state.selectedIds.size === 1) {
          const selId = [...state.selectedIds][0];
          const found = files.findIndex(f => f.id === selId);
          if (found >= 0) idx = found;
        }
        const next = e.key === 'ArrowDown'
          ? Math.min(idx + 1, files.length - 1)
          : Math.max(idx <= 0 ? 0 : idx - 1, 0);
        const target = files[next];
        if (!target) return;
        _lastClickedIndex = next;
        setSelectedIds([target.id]);
        openPreview(target.id);
        // Keep the focused row in view
        requestAnimationFrame(() => {
          const el = document.querySelector(`.file-row[data-id="${target.id}"], .file-card[data-id="${target.id}"]`);
          if (el) el.scrollIntoView({ block: 'nearest' });
        });
        return;
      }
      if (e.key === ' ' && _lastClickedIndex >= 0) {
        const files = getFilteredFiles();
        const target = files[_lastClickedIndex];
        if (target) {
          e.preventDefault();
          toggleSelected(target.id);
        }
        return;
      }
      if (e.key === 'Enter' && state.selectedIds.size === 1) {
        e.preventDefault();
        openPreview([...state.selectedIds][0]);
        return;
      }
    }

    // Ctrl+A: select all
    if (ctrl && e.key === 'a') {
      if (state.workspaceOpen) {
        e.preventDefault();
        selectAll();
      }
      return;
    }

    // Delete / Backspace: remove selected files from workspace
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedIds.size > 0 && state.workspaceOpen) {
      e.preventDefault();
      const count = state.selectedIds.size;
      if (confirm(`Remove ${count} selected file${count !== 1 ? 's' : ''} from the workspace?`)) {
        removeFiles([...state.selectedIds]);
      }
    }
  });
}

// ─── Landing page setup ───────────────────────────────────────────────────────

/**
 * Set up all landing page interactions.
 */
function _initLandingPage() {
  // All "Open Files" CTAs on the landing (header + hero) — exclude workspace buttons
  const landing = document.querySelector('.landing, .site-header, header');
  const openFilesBtns = document.querySelectorAll(
    '.site-header [data-action="open-files"], .hero [data-action="open-files"], .hero-open-files'
  );
  openFilesBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const entries = await openFiles();
      if (entries.length) openWorkspace();
    });
  });

  // All "Open Folder" CTAs on the landing
  const openFolderBtns = document.querySelectorAll(
    '.site-header [data-action="open-folder"], .hero [data-action="open-folder"], .hero-open-folder'
  );
  openFolderBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const entries = await openFolder();
      if (entries.length) openWorkspace();
    });
  });

  // Drop zone on hero section
  const heroSection = document.querySelector('.hero, .hero-section, [data-dropzone="hero"]');
  if (heroSection) {
    setupDropZone(heroSection, entries => {
      if (entries.length) openWorkspace();
    });
  }

  // Also set up a global drop zone fallback on the landing content
  const landingEl = document.querySelector('.landing, main, body');
  if (landingEl && landingEl !== heroSection) {
    setupDropZone(landingEl, entries => {
      if (entries.length) openWorkspace();
    });
  }
}

// ─── Workspace header setup ────────────────────────────────────────────────────

/**
 * Set up the workspace header buttons and module tabs.
 */
function _initWorkspaceHeader() {
  // Back / close workspace button
  const closeWsBtn = document.querySelector(
    '#workspace-back, .workspace-close-btn, [data-action="close-workspace"]'
  );
  if (closeWsBtn) {
    closeWsBtn.addEventListener('click', closeWorkspace);
  }

  // "Help / Browser support" button in workspace header
  const helpBtn = document.getElementById('workspace-help-btn');
  if (helpBtn) {
    helpBtn.addEventListener('click', () => _openBrowserSupportModal());
  }

  // Pane collapse toggles
  const leftToggle = document.getElementById('pane-left-toggle');
  const leftPane = document.getElementById('pane-left');
  if (leftToggle && leftPane) {
    leftToggle.addEventListener('click', () => {
      leftPane.classList.toggle('collapsed');
      leftToggle.setAttribute('aria-expanded', String(!leftPane.classList.contains('collapsed')));
    });
  }

  const rightToggle = document.getElementById('pane-right-toggle');
  const rightPane = document.getElementById('pane-right');
  if (rightToggle && rightPane) {
    rightToggle.addEventListener('click', () => {
      rightPane.classList.toggle('collapsed');
      rightToggle.setAttribute('aria-expanded', String(!rightPane.classList.contains('collapsed')));
    });
  }

  // "+ Files" and "+ Folder" buttons inside the workspace header
  const ws = document.getElementById('workspace');
  if (ws) {
    ws.querySelectorAll('[data-action="open-files"]').forEach(btn => {
      btn.addEventListener('click', async () => { await openFiles(); });
    });
    ws.querySelectorAll('[data-action="open-folder"]').forEach(btn => {
      btn.addEventListener('click', async () => { await openFolder(); });
    });
  }

  // Module tab buttons
  $$('[data-module-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const moduleName = btn.dataset.moduleTab;
      if (moduleName) _switchModule(moduleName);
    });
  });

  // Status bar "Browser support" link
  const supportLink = document.getElementById('browser-support-link');
  if (supportLink) {
    supportLink.addEventListener('click', e => {
      e.preventDefault();
      _openBrowserSupportModal();
    });
  }

  // Modal close buttons (generic — works for all modals in the page)
  document.addEventListener('click', e => {
    if (e.target.matches('.modal-close, .modal-overlay')) {
      const overlay = e.target.closest('.modal-overlay') || e.target;
      if (overlay.classList.contains('modal-overlay')) overlay.hidden = true;
    }
  });
}

function _openBrowserSupportModal() {
  const modal = document.getElementById('browser-support-modal');
  if (!modal) return;
  const content = document.getElementById('browser-support-panel-content');
  if (content && _browserSupportModule && typeof _browserSupportModule.renderSupportPanel === 'function') {
    _browserSupportModule.renderSupportPanel(content);
  }
  modal.hidden = false;
}

// ─── URL hash routing ──────────────────────────────────────────────────────────

/**
 * Check the URL hash and open workspace if needed.
 */
function _handleInitialHash() {
  if (window.location.hash === '#workspace') {
    openWorkspace();
  }
}

/**
 * Listen for popstate / hashchange events.
 */
function _initHashRouting() {
  window.addEventListener('hashchange', () => {
    if (window.location.hash === '#workspace') {
      openWorkspace();
    } else if (window.location.hash === '' || window.location.hash === '#') {
      closeWorkspace();
    }
  });
}

// ─── Reveal animations ────────────────────────────────────────────────────────

/**
 * Set up Intersection Observer-based reveal animations for elements with
 * [data-reveal] attribute.
 */
function _initRevealAnimations() {
  const targets = $$('[data-reveal]');
  if (!targets.length) return;

  if (!('IntersectionObserver' in window)) {
    targets.forEach(el => el.classList.add('revealed'));
    return;
  }

  const observer = new IntersectionObserver(
    entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('revealed');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.1, rootMargin: '0px 0px -40px 0px' }
  );

  targets.forEach(el => observer.observe(el));
}

// ─── FAQ Accordion ────────────────────────────────────────────────────────────

/**
 * Initialise accordion components found via [data-accordion] attribute.
 */
function _initAccordions() {
  $$('[data-accordion]').forEach(accordion => {
    const triggers = $$('[data-accordion-trigger]', accordion);
    triggers.forEach(trigger => {
      trigger.addEventListener('click', () => {
        const panel = document.getElementById(trigger.getAttribute('aria-controls'));
        const isOpen = trigger.getAttribute('aria-expanded') === 'true';

        // Close all siblings
        triggers.forEach(t => {
          if (t !== trigger) {
            t.setAttribute('aria-expanded', 'false');
            const p = document.getElementById(t.getAttribute('aria-controls'));
            if (p) p.hidden = true;
          }
        });

        trigger.setAttribute('aria-expanded', String(!isOpen));
        if (panel) panel.hidden = isOpen;
      });
    });
  });
}

// ─── Folder tree ──────────────────────────────────────────────────────────────

/**
 * Initialise the folder tree in the left pane.
 * @param {HTMLElement} containerEl
 */
async function _initFolderTree(containerEl) {
  if (!containerEl) return;

  _folderTreeModule = await tryImport('./folder-tree.js');

  if (_folderTreeModule && typeof _folderTreeModule.initFolderTree === 'function') {
    _folderTreeModule.initFolderTree(containerEl);
  } else {
    // Render a simple folder list from state
    containerEl.innerHTML = `<div class="folder-tree-placeholder"><p>Folder tree</p></div>`;

    on('files:added', () => _renderSimpleFolderTree(containerEl));
    on('files:cleared', () => { containerEl.innerHTML = ''; });
  }
}

/**
 * Fallback: render a simple directory list when folder-tree.js is not available.
 * @param {HTMLElement} containerEl
 */
function _renderSimpleFolderTree(containerEl) {
  const dirs = new Set();
  for (const f of state.files.values()) {
    const rel = f.relativePath || '';
    if (rel) {
      const parts = rel.replace(/\/$/, '').split('/');
      for (let i = 1; i <= parts.length; i++) {
        dirs.add(parts.slice(0, i).join('/'));
      }
    }
  }

  if (!dirs.size) {
    containerEl.innerHTML = '<p class="tree-empty">No folders</p>';
    return;
  }

  const sorted = [...dirs].sort();
  containerEl.innerHTML = `
    <ul class="folder-tree-list" role="tree">
      ${sorted.map(dir => `
        <li class="folder-tree-item" role="treeitem" data-dir="${escapeHtml(dir)}">
          <button class="folder-tree-btn" data-dir="${escapeHtml(dir)}">
            <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="12" height="12" aria-hidden="true">
              <path d="M2 4a1 1 0 011-1h4l1 1h5a1 1 0 011 1v7a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" fill="currentColor"/>
            </svg>
            ${escapeHtml(dir.split('/').pop() || dir)}
          </button>
        </li>
      `).join('')}
    </ul>
  `;

  containerEl.querySelectorAll('.folder-tree-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setFilter('search', btn.dataset.dir);
    });
  });
}

// ─── Window beforeunload warning ─────────────────────────────────────────────

function _initBeforeUnloadWarning() {
  window.addEventListener('beforeunload', e => {
    if (state.files.size > 0) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

// ─── Main init ────────────────────────────────────────────────────────────────

/**
 * Bootstrap the entire application.
 */
async function init() {
  // ── 0. Theme (light/dark) ─────────────────────────────────────────────────
  _themeModule = await tryImport('./theme.js');
  if (_themeModule && typeof _themeModule.initTheme === 'function') {
    try { _themeModule.initTheme(); } catch (e) { /* non-fatal */ }
  }

  // ── 1. Browser support detection ──────────────────────────────────────────
  _browserSupportModule = await tryImport('./browser-support.js');
  const detectFn = _browserSupportModule && (
    _browserSupportModule.detectBrowserSupport ||
    _browserSupportModule.detectCapabilities ||
    _browserSupportModule.getCapabilities
  );
  if (typeof detectFn === 'function') {
    try { state.browserSupport = detectFn(); } catch (e) { /* non-fatal */ }
  }

  // ── 2. Storage / IndexedDB init ────────────────────────────────────────────
  _storageModule = await tryImport('./storage.js');
  const initStorageFn = _storageModule && (_storageModule.initStorage || _storageModule.initDB);
  if (typeof initStorageFn === 'function') {
    try {
      await initStorageFn();
    } catch (err) {
      console.warn('app: storage init failed (non-fatal)', err.message);
    }
  }

  // ── 3. Load saved recipes ──────────────────────────────────────────────────
  _recipesModule = await tryImport('./recipes.js');
  if (_recipesModule && typeof _recipesModule.loadRecipes === 'function') {
    try {
      await _recipesModule.loadRecipes();
    } catch (err) {
      console.warn('app: recipes load failed (non-fatal)', err.message);
    }
  }

  // ── 4. UI init (reveal animations, accordions) ────────────────────────────
  _uiModule = await tryImport('./ui.js');
  if (_uiModule) {
    if (typeof _uiModule.initRevealAnimations === 'function') {
      _uiModule.initRevealAnimations();
    } else {
      _initRevealAnimations();
    }
    if (typeof _uiModule.initAccordion === 'function') {
      _uiModule.initAccordion();
    } else {
      _initAccordions();
    }
    if (typeof _uiModule.initTabs === 'function') {
      _uiModule.initTabs();
    }
  } else {
    // Fallback built-in implementations
    _initRevealAnimations();
    _initAccordions();
  }

  // ── 5. Workspace layout panes ─────────────────────────────────────────────
  const paneLeft = document.querySelector('.pane-left');
  const paneCenter = document.querySelector('.pane-center');
  const paneRight = document.querySelector('.pane-right');

  // ── 6. Folder tree (left pane) ────────────────────────────────────────────
  if (paneLeft) {
    await _initFolderTree(paneLeft);
  }

  // ── 7. File table (center pane — browse module panel) ─────────────────────
  let browsePanel = document.querySelector('[data-module-panel="browser"]');
  if (!browsePanel && paneCenter) {
    browsePanel = paneCenter;
  }
  if (browsePanel) {
    renderFileTable(browsePanel);
  }

  // ── 8. Preview panel (right pane) ─────────────────────────────────────────
  if (paneRight) {
    initPreviewPanel(paneRight);
  }

  // ── 9. Module switching ────────────────────────────────────────────────────
  _initWorkspaceHeader();
  _switchModule('browser');

  // ── 10. Archive module ────────────────────────────────────────────────────
  _archivesModule = await tryImport('./archives.js');
  const archivePanel = document.querySelector('[data-module-panel="archive"]');
  if (_archivesModule && archivePanel) {
    if (typeof _archivesModule.initArchiveModule === 'function') {
      try { _archivesModule.initArchiveModule(archivePanel); } catch (e) { console.warn('app: archive init error', e); }
    }
  }

  // ── 11. Rename module ─────────────────────────────────────────────────────
  _renameModule = await tryImport('./rename.js');
  const renamePanel = document.querySelector('[data-module-panel="rename"]');
  if (_renameModule && renamePanel) {
    if (typeof _renameModule.initRenameModule === 'function') {
      try { _renameModule.initRenameModule(renamePanel); } catch (e) { console.warn('app: rename init error', e); }
    }
  }

  // ── 12. Metadata module ───────────────────────────────────────────────────
  _metadataModule = await tryImport('./metadata.js');
  const metadataPanel = document.querySelector('[data-module-panel="metadata"]');
  if (_metadataModule && metadataPanel) {
    if (typeof _metadataModule.initMetadataModule === 'function') {
      try { _metadataModule.initMetadataModule(metadataPanel); } catch (e) { console.warn('app: metadata init error', e); }
    }
  }

  // ── 13. Recipes module ────────────────────────────────────────────────────
  const recipesPanel = document.querySelector('[data-module-panel="recipes"]');
  if (_recipesModule && recipesPanel) {
    if (typeof _recipesModule.initRecipesModule === 'function') {
      try { _recipesModule.initRecipesModule(recipesPanel); } catch (e) { console.warn('app: recipes UI init error', e); }
    }
  }

  // ── 13b. Tools module (insights, duplicates, image converter) ─────────────
  _toolsModule = await tryImport('./tools.js');
  const toolsPanel = document.querySelector('[data-module-panel="tools"]');
  if (_toolsModule && toolsPanel) {
    if (typeof _toolsModule.initToolsModule === 'function') {
      try { _toolsModule.initToolsModule(toolsPanel); } catch (e) { console.warn('app: tools init error', e); }
    }
  }

  // ── 14. Landing page buttons ──────────────────────────────────────────────
  _initLandingPage();

  // ── 15. Workspace header buttons (already done above in step 9) ────────────
  // (duplicate here only for clarity — no-op since already called)

  // ── 16. URL hash ──────────────────────────────────────────────────────────
  _handleInitialHash();
  _initHashRouting();

  // ── 17. Keyboard shortcuts ─────────────────────────────────────────────────
  _initKeyboardShortcuts();

  // ── 18. Before-unload warning ──────────────────────────────────────────────
  _initBeforeUnloadWarning();

  // ── 19. Event subscriptions for re-renders ────────────────────────────────
  on('files:added', () => {
    if (browsePanel) _refreshFileTable(browsePanel);
    _updateStatusBar();
  });

  on('files:removed', removed => {
    for (const entry of removed) _releaseThumb(entry.id);
    if (browsePanel) _refreshFileTable(browsePanel);
    _updateStatusBar();
  });

  on('files:cleared', () => {
    _releaseAllThumbs();
    if (browsePanel) _refreshFileTable(browsePanel);
    _updateStatusBar();
    clearPreview();
  });

  on('filters:change', () => {
    if (browsePanel) _refreshFileTable(browsePanel);
  });

  on('selection:change', () => {
    if (browsePanel) _refreshFileTable(browsePanel);
    _updateStatusBar();
  });

  on('module:change', ({ activeModule }) => {
    _switchModule(activeModule);
  });

  on('workspace:open', () => {
    openWorkspace();
  });

  on('workspace:close', () => {
    closeWorkspace();
  });

  // ── 20. Drop zone in workspace center pane ────────────────────────────────
  if (paneCenter) {
    setupDropZone(paneCenter, _entries => {
      if (_entries.length && !state.workspaceOpen) openWorkspace();
    });
  }

  // ── 21. Command palette (Cmd/Ctrl+K) ──────────────────────────────────────
  const paletteModule = await tryImport('./command-palette.js');
  if (paletteModule && typeof paletteModule.initCommandPalette === 'function') {
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');
    const mod = isMac ? '⌘' : 'Ctrl+';
    const goModule = name => { openWorkspace(); _switchModule(name); };
    try {
      paletteModule.initCommandPalette([
        { id: 'open-files', label: 'Open files…', hint: `${mod}O`, run: async () => { const en = await openFiles(); if (en.length) openWorkspace(); } },
        { id: 'open-folder', label: 'Open folder…', hint: isMac ? '⇧⌘O' : 'Ctrl+Shift+O', run: async () => { const en = await openFolder(); if (en.length) openWorkspace(); } },
        { id: 'go-browse', label: 'Go to Browse', run: () => goModule('browser') },
        { id: 'go-archive', label: 'Go to Archive', run: () => goModule('archive') },
        { id: 'go-rename', label: 'Go to Rename', run: () => goModule('rename') },
        { id: 'go-metadata', label: 'Go to Metadata', run: () => goModule('metadata') },
        { id: 'go-tools', label: 'Go to Tools', run: () => goModule('tools') },
        { id: 'go-recipes', label: 'Go to Recipes', run: () => goModule('recipes') },
        { id: 'toggle-theme', label: 'Toggle dark mode', run: () => { if (_themeModule) _themeModule.toggleTheme(); } },
        { id: 'view-grid', label: 'Switch to grid view', run: () => { _viewMode = 'grid'; try { localStorage.setItem('fo-view', 'grid'); } catch { } if (browsePanel) _refreshFileTable(browsePanel); goModule('browser'); } },
        { id: 'view-list', label: 'Switch to list view', run: () => { _viewMode = 'list'; try { localStorage.setItem('fo-view', 'list'); } catch { } if (browsePanel) _refreshFileTable(browsePanel); goModule('browser'); } },
        { id: 'select-all', label: 'Select all files', hint: `${mod}A`, run: selectAll },
        { id: 'select-none', label: 'Clear selection', run: selectNone },
        { id: 'download-zip', label: 'Download selected as ZIP', run: _downloadSelectedAsZip },
        { id: 'scan-duplicates', label: 'Scan for duplicate files', run: () => { goModule('tools'); const btn = document.getElementById('dup-scan-btn'); if (btn) btn.click(); } },
        { id: 'browser-support', label: 'Browser support info', run: _openBrowserSupportModal },
      ]);
    } catch (e) { console.warn('app: command palette init error', e); }
  }

  // Debug/testing hook (no private data — everything is local anyway)
  window.FilesOnline = { state, addFiles };

  console.info('Files Online: ready');
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  // DOM already ready (e.g. module loaded deferred)
  init().catch(err => {
    console.error('app: init failed', err);
  });
}
