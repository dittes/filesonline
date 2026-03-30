// metadata.js
// Extracts metadata from FileEntry objects and provides CSV / JSON export.

import { state, on, getFilteredFiles } from './state.js';
import {
  formatBytes,
  formatDate,
  escapeHtml,
  downloadBlob,
  readFileAsArrayBuffer,
} from './utils.js';

// ---------------------------------------------------------------------------
// Types (JSDoc)
// ---------------------------------------------------------------------------
//
// MetadataEntry: {
//   id:           string,
//   name:         string,
//   ext:          string,
//   size:         number,
//   sizeFormatted:string,
//   type:         string,
//   category:     string,
//   modified:     Date,
//   path:         string,
//   relativePath: string,
//   hash?:        string,   // SHA-256 hex, present when hashing was requested
// }

// ---------------------------------------------------------------------------
// Core extraction
// ---------------------------------------------------------------------------

/**
 * Extract metadata from an array of FileEntry objects.
 * If `computeHashes` is true, each entry will include a `hash` field (SHA-256).
 * Progress callback receives (done, total) after each file is processed.
 *
 * @param {import('./state.js').FileEntry[]} fileEntries
 * @param {{ computeHashes?: boolean, onProgress?: (done: number, total: number) => void }} [opts]
 * @returns {Promise<MetadataEntry[]>}
 */
export async function extractMetadata(fileEntries, opts = {}) {
  const { computeHashes = false, onProgress } = opts;
  const results = [];
  const total   = fileEntries.length;

  for (let i = 0; i < total; i++) {
    const entry = fileEntries[i];

    /** @type {MetadataEntry} */
    const meta = {
      id:           entry.id,
      name:         entry.name,
      ext:          entry.ext,
      size:         entry.size,
      sizeFormatted: formatBytes(entry.size),
      type:         entry.type,
      category:     entry.category,
      modified:     entry.modified,
      path:         entry.path,
      relativePath: entry.relativePath,
    };

    if (computeHashes) {
      try {
        meta.hash = await computeFileHash(entry.file);
      } catch (e) {
        console.warn(`metadata: hash failed for "${entry.name}" —`, e.message);
        meta.hash = 'error';
      }
    }

    results.push(meta);

    if (typeof onProgress === 'function') {
      onProgress(i + 1, total);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Hash computation
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 hash of a File and return it as a lowercase hex string.
 *
 * @param {File} file
 * @returns {Promise<string>}
 */
export async function computeFileHash(file) {
  const buffer = await readFileAsArrayBuffer(file);
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray  = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Export formatters
// ---------------------------------------------------------------------------

/**
 * Serialise MetadataEntry[] as a CSV string.
 * Handles quoting and escaping per RFC 4180.
 *
 * @param {MetadataEntry[]} entries
 * @returns {string}
 */
export function exportMetadataCSV(entries) {
  const columns = [
    { key: 'name',         label: 'Name' },
    { key: 'ext',          label: 'Extension' },
    { key: 'sizeFormatted',label: 'Size' },
    { key: 'size',         label: 'Size (bytes)' },
    { key: 'type',         label: 'MIME Type' },
    { key: 'category',     label: 'Category' },
    { key: 'modified',     label: 'Modified' },
    { key: 'path',         label: 'Path' },
    { key: 'relativePath', label: 'Relative Path' },
    { key: 'hash',         label: 'SHA-256' },
  ];

  // Determine which columns to include (skip hash if none have it)
  const hasHash = entries.some((e) => 'hash' in e);
  const cols = hasHash ? columns : columns.filter((c) => c.key !== 'hash');

  const csvEscape = (val) => {
    const str = val === null || val === undefined ? '' : String(val);
    // Wrap in quotes if the value contains a comma, quote, or newline
    if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  };

  const header = cols.map((c) => csvEscape(c.label)).join(',');

  const rows = entries.map((entry) =>
    cols.map((col) => {
      const val = entry[col.key];
      if (val instanceof Date) return csvEscape(formatDate(val));
      return csvEscape(val);
    }).join(',')
  );

  return [header, ...rows].join('\r\n');
}

/**
 * Serialise MetadataEntry[] as a formatted JSON string.
 *
 * @param {MetadataEntry[]} entries
 * @returns {string}
 */
export function exportMetadataJSON(entries) {
  const serialisable = entries.map((e) => ({
    id:           e.id,
    name:         e.name,
    ext:          e.ext,
    size:         e.size,
    sizeFormatted: e.sizeFormatted,
    type:         e.type,
    category:     e.category,
    modified:     e.modified instanceof Date ? e.modified.toISOString() : e.modified,
    path:         e.path,
    relativePath: e.relativePath,
    ...(e.hash !== undefined ? { hash: e.hash } : {}),
  }));

  return JSON.stringify(serialisable, null, 2);
}

// ---------------------------------------------------------------------------
// UI module
// ---------------------------------------------------------------------------

/**
 * Render the Metadata Export module UI into `containerEl` and wire up all
 * interactivity.
 *
 * @param {HTMLElement} containerEl
 */
export function initMetadataModule(containerEl) {
  containerEl.innerHTML = _buildModuleHTML();

  // Grab all interactive elements
  const hashToggle     = containerEl.querySelector('#meta-hash-toggle');
  const extractBtn     = containerEl.querySelector('#meta-extract-btn');
  const exportCsvBtn   = containerEl.querySelector('#meta-export-csv');
  const exportJsonBtn  = containerEl.querySelector('#meta-export-json');
  const copyJsonBtn    = containerEl.querySelector('#meta-copy-json');
  const clearBtn       = containerEl.querySelector('#meta-clear-btn');
  const fileCountEl    = containerEl.querySelector('#meta-file-count');
  const progressWrap   = containerEl.querySelector('#meta-progress-wrap');
  const progressBar    = containerEl.querySelector('#meta-progress-bar');
  const progressText   = containerEl.querySelector('#meta-progress-text');
  const resultsSection = containerEl.querySelector('#meta-results-section');
  const resultsBody    = containerEl.querySelector('#meta-results-tbody');
  const resultCount    = containerEl.querySelector('#meta-result-count');

  /** @type {MetadataEntry[]} */
  let currentResults = [];
  let isExtracting   = false;

  // ---- helpers ----

  function _getTargetFiles() {
    const all = Array.from(state.files.values());
    if (state.selectedIds.size > 0) {
      return all.filter((f) => state.selectedIds.has(f.id));
    }
    return all;
  }

  function _updateFileCount() {
    const targets = _getTargetFiles();
    const n = targets.length;
    fileCountEl.textContent = n === 0
      ? 'No files loaded'
      : n === 1
        ? '1 file'
        : `${n} files`;
  }

  function _setExportEnabled(enabled) {
    exportCsvBtn.disabled  = !enabled;
    exportJsonBtn.disabled = !enabled;
    copyJsonBtn.disabled   = !enabled;
    clearBtn.disabled      = !enabled;
  }

  function _showProgress(done, total) {
    progressWrap.hidden = false;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    progressBar.style.width      = pct + '%';
    progressBar.setAttribute('aria-valuenow', String(pct));
    progressText.textContent      = `${done} / ${total}`;
  }

  function _hideProgress() {
    progressWrap.hidden = true;
    progressBar.style.width = '0%';
    progressBar.setAttribute('aria-valuenow', '0');
    progressText.textContent = '';
  }

  function _renderResultsTable(entries) {
    resultsSection.hidden = false;
    resultCount.textContent = `${entries.length} file${entries.length !== 1 ? 's' : ''}`;

    const hasHash = entries.some((e) => 'hash' in e);

    // Rebuild header if needed
    const thead = containerEl.querySelector('#meta-results-thead');
    if (thead) {
      thead.innerHTML = `<tr>
        <th scope="col">Name</th>
        <th scope="col">Size</th>
        <th scope="col">Type</th>
        <th scope="col">Modified</th>
        <th scope="col">Path</th>
        ${hasHash ? '<th scope="col">SHA-256</th>' : ''}
      </tr>`;
    }

    resultsBody.innerHTML = entries.map((e) => {
      const modStr = e.modified instanceof Date ? formatDate(e.modified) : String(e.modified);
      const hashCell = hasHash
        ? `<td class="meta-hash" title="${escapeHtml(e.hash ?? '')}">${escapeHtml(_truncateHash(e.hash))}</td>`
        : '';
      return `<tr>
        <td class="meta-name" title="${escapeHtml(e.path)}">${escapeHtml(e.name)}</td>
        <td class="meta-size">${escapeHtml(e.sizeFormatted)}</td>
        <td class="meta-type">${escapeHtml(e.type)}</td>
        <td class="meta-modified">${escapeHtml(modStr)}</td>
        <td class="meta-path">${escapeHtml(e.relativePath || '/')}</td>
        ${hashCell}
      </tr>`;
    }).join('');
  }

  // ---- event listeners ----

  // Keep file count fresh
  on('files:added',    _updateFileCount);
  on('files:cleared',  _updateFileCount);
  on('selection:change', _updateFileCount);
  _updateFileCount();

  extractBtn.addEventListener('click', async () => {
    if (isExtracting) return;

    const targets = _getTargetFiles();
    if (!targets.length) {
      _showToastFallback('No files to process. Add some files first.');
      return;
    }

    isExtracting = true;
    extractBtn.disabled = true;
    _setExportEnabled(false);
    _hideProgress();
    currentResults = [];

    try {
      currentResults = await extractMetadata(targets, {
        computeHashes: hashToggle.checked,
        onProgress: (done, total) => _showProgress(done, total),
      });
      _hideProgress();
      _renderResultsTable(currentResults);
      _setExportEnabled(true);
    } catch (err) {
      console.error('metadata: extraction error', err);
      _showToastFallback('Extraction failed: ' + err.message);
      _hideProgress();
    } finally {
      isExtracting = false;
      extractBtn.disabled = false;
    }
  });

  exportCsvBtn.addEventListener('click', () => {
    if (!currentResults.length) return;
    const csv  = exportMetadataCSV(currentResults);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    downloadBlob(blob, _exportFilename('csv'));
  });

  exportJsonBtn.addEventListener('click', () => {
    if (!currentResults.length) return;
    const json = exportMetadataJSON(currentResults);
    const blob = new Blob([json], { type: 'application/json' });
    downloadBlob(blob, _exportFilename('json'));
  });

  copyJsonBtn.addEventListener('click', async () => {
    if (!currentResults.length) return;
    const json = exportMetadataJSON(currentResults);
    try {
      await navigator.clipboard.writeText(json);
      _showToastFallback('JSON copied to clipboard.');
    } catch (err) {
      console.error('metadata: clipboard write failed', err);
      _showToastFallback('Could not write to clipboard.');
    }
  });

  clearBtn.addEventListener('click', () => {
    currentResults = [];
    resultsSection.hidden = true;
    resultsBody.innerHTML = '';
    resultCount.textContent = '';
    _setExportEnabled(false);
    _hideProgress();
  });
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Build the static HTML scaffold for the metadata module UI.
 *
 * @returns {string}
 */
function _buildModuleHTML() {
  return `
    <div class="meta-module">
      <div class="meta-header">
        <h2 class="meta-title">Metadata Export</h2>
        <p class="meta-description">
          Extract file metadata from the loaded files and export it as CSV or JSON.
          Optionally compute SHA-256 hashes (may be slow for large files).
        </p>
      </div>

      <div class="meta-controls">
        <div class="meta-hash-row">
          <label class="meta-toggle-label" for="meta-hash-toggle">
            <span class="meta-toggle-track">
              <input type="checkbox" id="meta-hash-toggle" class="meta-toggle-input" role="switch" aria-checked="false">
              <span class="meta-toggle-thumb" aria-hidden="true"></span>
            </span>
            <span class="meta-toggle-text">Compute SHA-256 hashes</span>
            <span class="meta-toggle-hint">(slower for large files)</span>
          </label>
        </div>

        <div class="meta-action-row">
          <button id="meta-extract-btn" class="btn btn--primary" type="button">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 1v10M4 7l4 4 4-4" stroke="currentColor" stroke-width="1.5"
                    stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M2 13h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            Extract Metadata
          </button>
          <span class="meta-file-count" id="meta-file-count">No files loaded</span>
        </div>
      </div>

      <div class="meta-progress-wrap" id="meta-progress-wrap" hidden>
        <div class="meta-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <div class="meta-progress-bar" id="meta-progress-bar" style="width: 0%"></div>
        </div>
        <span class="meta-progress-text" id="meta-progress-text"></span>
      </div>

      <div class="meta-results-section" id="meta-results-section" hidden>
        <div class="meta-results-header">
          <span class="meta-result-count" id="meta-result-count"></span>
          <div class="meta-export-actions">
            <button id="meta-export-csv"  class="btn btn--secondary btn--sm" type="button" disabled>
              Export CSV
            </button>
            <button id="meta-export-json" class="btn btn--secondary btn--sm" type="button" disabled>
              Export JSON
            </button>
            <button id="meta-copy-json"   class="btn btn--secondary btn--sm" type="button" disabled>
              Copy JSON
            </button>
            <button id="meta-clear-btn"   class="btn btn--ghost btn--sm"      type="button" disabled>
              Clear
            </button>
          </div>
        </div>

        <div class="meta-table-wrap">
          <table class="meta-table" aria-label="Extracted metadata">
            <thead id="meta-results-thead">
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Size</th>
                <th scope="col">Type</th>
                <th scope="col">Modified</th>
                <th scope="col">Path</th>
              </tr>
            </thead>
            <tbody id="meta-results-tbody"></tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

/**
 * Generate a timestamped export filename.
 *
 * @param {'csv'|'json'} ext
 * @returns {string}
 */
function _exportFilename(ext) {
  const now = new Date();
  const ts  = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `files-online-metadata-${ts}.${ext}`;
}

/**
 * Truncate a long hex hash for display, showing first 8 + last 4 chars.
 *
 * @param {string|undefined} hash
 * @returns {string}
 */
function _truncateHash(hash) {
  if (!hash || hash === 'error') return hash ?? '';
  if (hash.length <= 16) return hash;
  return hash.slice(0, 8) + '…' + hash.slice(-4);
}

/**
 * Very lightweight toast fallback that works without importing the full UI
 * module (avoids circular deps when ui.js itself might import state.js).
 * If the app has a showToast function available globally, use it; otherwise
 * fall back to console.info.
 *
 * @param {string} message
 */
function _showToastFallback(message) {
  if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
    window.showToast(message);
  } else {
    console.info('[metadata]', message);
  }
}
