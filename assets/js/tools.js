// tools.js
// Tools module: workspace insights, duplicate finder, image converter.
// Everything runs client-side — no upload, matching the app's privacy promise.

import { state, on, removeFiles, addFiles, openPreview, setSelectedIds, setActiveModule } from './state.js';
import {
  formatBytes,
  escapeHtml,
  downloadBlob,
  bytesToHashHex,
  pluralize,
} from './utils.js';

let _toast = (msg) => alert(msg);
let _confirm = (msg) => Promise.resolve(confirm(msg));

async function _loadUi() {
  try {
    const ui = await import('./ui.js');
    if (typeof ui.showToast === 'function') _toast = ui.showToast;
    if (typeof ui.showConfirm === 'function') _confirm = ui.showConfirm;
  } catch { /* fall back to alert/confirm */ }
}

// ─── Module panel ─────────────────────────────────────────────────────────────

/**
 * Render the Tools module and wire up interactivity.
 * @param {HTMLElement} containerEl
 */
export function initToolsModule(containerEl) {
  _loadUi();
  containerEl.innerHTML = _buildModuleHTML();

  _initInsights(containerEl);
  _initDuplicateFinder(containerEl);
  _initImageConverter(containerEl);
}

function _buildModuleHTML() {
  return `
    <div class="module-panel">
      <div class="module-header">
        <h2>Tools</h2>
        <p>Analyze your workspace, find duplicate files and convert images — all locally in your browser.</p>
      </div>

      <section class="module-section" id="tools-insights">
        <div class="module-section-header">
          <span class="module-section-title">Workspace Insights</span>
        </div>
        <div class="module-section-body" id="tools-insights-body">
        </div>
      </section>

      <section class="module-section" id="tools-duplicates">
        <div class="module-section-header">
          <span class="module-section-title">Duplicate Finder</span>
          <button class="btn btn-sm btn-secondary" id="dup-scan-btn">Scan for duplicates</button>
        </div>
        <div class="module-section-body">
          <p class="tool-hint" id="dup-hint">
            Compares files by size, then verifies matches with SHA-256 content hashes.
            Nothing is deleted from your disk — duplicates can only be removed from the workspace.
          </p>
          <div id="dup-progress" hidden style="margin-top:12px;">
            <div class="progress-label"><span id="dup-progress-text">Hashing…</span></div>
            <div class="progress-bar-wrap"><div class="progress-bar" id="dup-progress-bar" style="width:0%"></div></div>
          </div>
          <div id="dup-results" hidden>
            <div class="dup-summary" id="dup-summary"></div>
            <div class="tool-actions" style="margin-bottom:12px;">
              <button class="btn btn-sm btn-secondary" id="dup-select-btn">Select all but first in each group</button>
              <button class="btn btn-sm btn-danger" id="dup-remove-btn" disabled>Remove checked from workspace</button>
              <button class="btn btn-sm btn-ghost" id="dup-export-btn">Export report (CSV)</button>
            </div>
            <div id="dup-groups"></div>
          </div>
        </div>
      </section>

      <section class="module-section" id="tools-imgconv">
        <div class="module-section-header">
          <span class="module-section-title">Image Converter</span>
          <span class="tool-hint" id="imgconv-count"></span>
        </div>
        <div class="module-section-body">
          <p class="tool-hint" style="margin-bottom:14px;">
            Converts the selected images (or all images if none are selected) using your browser's
            canvas — files never leave your device. SVG and unsupported formats are skipped.
          </p>
          <div class="imgconv-options">
            <div class="imgconv-option">
              <label for="imgconv-format">Format</label>
              <select class="select select-sm" id="imgconv-format">
                <option value="image/jpeg">JPEG</option>
                <option value="image/png">PNG</option>
                <option value="image/webp" selected>WebP</option>
              </select>
            </div>
            <div class="imgconv-option" id="imgconv-quality-wrap">
              <label for="imgconv-quality">Quality <span class="imgconv-quality-value" id="imgconv-quality-value">85%</span></label>
              <input type="range" id="imgconv-quality" min="10" max="100" step="5" value="85" style="width:140px;">
            </div>
            <div class="imgconv-option">
              <label for="imgconv-maxdim">Max width/height (px, optional)</label>
              <input type="number" class="input input-sm" id="imgconv-maxdim" min="16" max="20000" placeholder="Keep original" style="width:150px;">
            </div>
          </div>
          <div id="imgconv-progress" hidden style="margin-bottom:12px;">
            <div class="progress-label"><span id="imgconv-progress-text">Converting…</span></div>
            <div class="progress-bar-wrap"><div class="progress-bar" id="imgconv-progress-bar" style="width:0%"></div></div>
          </div>
          <div class="tool-actions">
            <button class="btn btn-sm btn-primary" id="imgconv-download-btn">Convert &amp; Download</button>
            <button class="btn btn-sm btn-secondary" id="imgconv-add-btn">Convert &amp; Add to workspace</button>
          </div>
          <div class="imgconv-results" id="imgconv-results"></div>
        </div>
      </section>
    </div>
  `;
}

// ─── Insights ─────────────────────────────────────────────────────────────────

const CATEGORY_COLORS = {
  image: '#8b5cf6',
  video: '#ef4444',
  audio: '#f97316',
  pdf: '#dc2626',
  document: '#2563eb',
  spreadsheet: '#16a34a',
  code: '#0891b2',
  text: '#64748b',
  archive: '#d97706',
  binary: '#9a9896',
};

function _initInsights(containerEl) {
  const body = containerEl.querySelector('#tools-insights-body');
  const render = () => _renderInsights(body);

  on('files:added', render);
  on('files:removed', render);
  on('files:cleared', render);
  render();

  body.addEventListener('click', e => {
    const nameEl = e.target.closest('.tools-largest-name');
    if (!nameEl) return;
    const id = nameEl.dataset.id;
    if (!id || !state.files.has(id)) return;
    setSelectedIds([id]);
    setActiveModule('browser');
    openPreview(id);
  });
}

function _renderInsights(body) {
  const files = Array.from(state.files.values());
  if (!files.length) {
    body.innerHTML = `<p class="tool-hint">No files loaded. Open files or a folder to see a breakdown of your workspace.</p>`;
    return;
  }

  let totalSize = 0;
  const byCategory = new Map();
  const extCount = new Map();
  for (const f of files) {
    totalSize += f.size;
    const cat = byCategory.get(f.category) || { count: 0, size: 0 };
    cat.count += 1;
    cat.size += f.size;
    byCategory.set(f.category, cat);
    if (f.ext) extCount.set(f.ext, (extCount.get(f.ext) || 0) + 1);
  }

  const cats = [...byCategory.entries()].sort((a, b) => b[1].size - a[1].size);
  const maxCatSize = cats.length ? cats[0][1].size : 1;
  const largest = [...files].sort((a, b) => b.size - a.size).slice(0, 10);
  const uniqueExts = extCount.size;

  body.innerHTML = `
    <div class="tools-stats-grid">
      <div class="tools-stat"><div class="tools-stat-value">${files.length.toLocaleString()}</div><div class="tools-stat-label">Files</div></div>
      <div class="tools-stat"><div class="tools-stat-value">${escapeHtml(formatBytes(totalSize))}</div><div class="tools-stat-label">Total size</div></div>
      <div class="tools-stat"><div class="tools-stat-value">${byCategory.size}</div><div class="tools-stat-label">File types</div></div>
      <div class="tools-stat"><div class="tools-stat-value">${uniqueExts}</div><div class="tools-stat-label">Extensions</div></div>
    </div>

    <div>
      ${cats.map(([cat, v]) => `
        <div class="tools-cat-row">
          <span class="tools-cat-label">${escapeHtml(cat)}</span>
          <div class="tools-cat-bar-wrap">
            <div class="tools-cat-bar" style="width:${Math.max(1, Math.round((v.size / maxCatSize) * 100))}%;background:${CATEGORY_COLORS[cat] || 'var(--accent)'};"></div>
          </div>
          <span class="tools-cat-value">${pluralize(v.count, 'file')} · ${escapeHtml(formatBytes(v.size))}</span>
        </div>
      `).join('')}
    </div>

    <h4 style="font-size:12px;font-weight:600;color:var(--text-2);margin-top:16px;">Largest files</h4>
    <ul class="tools-largest-list">
      ${largest.map(f => `
        <li>
          <span class="tools-largest-name" data-id="${escapeHtml(f.id)}" title="${escapeHtml(f.relativePath || f.name)}">${escapeHtml(f.name)}</span>
          <span class="tools-largest-size">${escapeHtml(formatBytes(f.size))}</span>
        </li>
      `).join('')}
    </ul>
  `;
}

// ─── Duplicate finder ─────────────────────────────────────────────────────────

/**
 * Find duplicate files among the given entries.
 * Groups by size first so only potential duplicates get hashed.
 * @param {import('./state.js').FileEntry[]} entries
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<Array<{ hash: string, size: number, entries: import('./state.js').FileEntry[] }>>}
 */
export async function findDuplicates(entries, onProgress) {
  const bySize = new Map();
  for (const e of entries) {
    if (!bySize.has(e.size)) bySize.set(e.size, []);
    bySize.get(e.size).push(e);
  }

  const candidates = [...bySize.values()].filter(group => group.length > 1).flat();
  const total = candidates.length;
  let done = 0;

  const byHash = new Map();
  for (const entry of candidates) {
    try {
      const buf = await entry.file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buf);
      const hash = bytesToHashHex(digest);
      const key = `${entry.size}:${hash}`;
      if (!byHash.has(key)) byHash.set(key, { hash, size: entry.size, entries: [] });
      byHash.get(key).entries.push(entry);
    } catch (err) {
      console.warn('tools: failed to hash file', entry.name, err);
    }
    done += 1;
    if (onProgress) onProgress(done, total);
  }

  return [...byHash.values()]
    .filter(g => g.entries.length > 1)
    .sort((a, b) => (b.size * (b.entries.length - 1)) - (a.size * (a.entries.length - 1)));
}

function _initDuplicateFinder(containerEl) {
  const scanBtn = containerEl.querySelector('#dup-scan-btn');
  const progressWrap = containerEl.querySelector('#dup-progress');
  const progressBar = containerEl.querySelector('#dup-progress-bar');
  const progressText = containerEl.querySelector('#dup-progress-text');
  const results = containerEl.querySelector('#dup-results');
  const summary = containerEl.querySelector('#dup-summary');
  const groupsEl = containerEl.querySelector('#dup-groups');
  const selectBtn = containerEl.querySelector('#dup-select-btn');
  const removeBtn = containerEl.querySelector('#dup-remove-btn');
  const exportBtn = containerEl.querySelector('#dup-export-btn');

  /** @type {Array<{ hash: string, size: number, entries: import('./state.js').FileEntry[] }>} */
  let groups = [];
  let scanning = false;

  const checkedIds = () =>
    [...groupsEl.querySelectorAll('.dup-check:checked')].map(cb => cb.dataset.id);

  const updateRemoveBtn = () => {
    const n = checkedIds().length;
    removeBtn.disabled = n === 0;
    removeBtn.textContent = n === 0
      ? 'Remove checked from workspace'
      : `Remove ${pluralize(n, 'checked file')} from workspace`;
  };

  scanBtn.addEventListener('click', async () => {
    if (scanning) return;
    const files = Array.from(state.files.values());
    if (files.length < 2) {
      _toast('Load at least two files to scan for duplicates.', 'info');
      return;
    }
    scanning = true;
    scanBtn.disabled = true;
    results.hidden = true;
    progressWrap.hidden = false;
    progressBar.style.width = '0%';
    progressText.textContent = 'Comparing file sizes…';

    try {
      groups = await findDuplicates(files, (done, total) => {
        const pct = total > 0 ? Math.round((done / total) * 100) : 100;
        progressBar.style.width = pct + '%';
        progressText.textContent = `Hashing candidates… ${done} / ${total}`;
      });
    } catch (err) {
      console.error('tools: duplicate scan failed', err);
      _toast('Duplicate scan failed: ' + err.message, 'error');
      groups = [];
    }

    progressWrap.hidden = true;
    scanning = false;
    scanBtn.disabled = false;
    _renderDupResults();
  });

  function _renderDupResults() {
    results.hidden = false;

    if (!groups.length) {
      summary.innerHTML = `<span>No duplicates found — every file in the workspace is unique.</span>`;
      groupsEl.innerHTML = '';
      selectBtn.hidden = true;
      removeBtn.hidden = true;
      exportBtn.hidden = true;
      return;
    }

    selectBtn.hidden = false;
    removeBtn.hidden = false;
    exportBtn.hidden = false;

    const dupCount = groups.reduce((n, g) => n + g.entries.length - 1, 0);
    const wasted = groups.reduce((n, g) => n + g.size * (g.entries.length - 1), 0);
    summary.innerHTML = `
      <span><strong>${pluralize(groups.length, 'duplicate group')}</strong></span>
      <span><strong>${pluralize(dupCount, 'redundant copy', 'redundant copies')}</strong></span>
      <span><strong>${escapeHtml(formatBytes(wasted))}</strong> reclaimable</span>
    `;

    groupsEl.innerHTML = groups.map((g, gi) => `
      <div class="dup-group">
        <div class="dup-group-header">
          <span>${pluralize(g.entries.length, 'copy', 'copies')} × ${escapeHtml(formatBytes(g.size))}</span>
          <span class="dup-group-hash" title="SHA-256: ${escapeHtml(g.hash)}">${escapeHtml(g.hash.slice(0, 16))}…</span>
        </div>
        ${g.entries.map((e, i) => `
          <div class="dup-file-row">
            <input type="checkbox" class="checkbox dup-check" data-id="${escapeHtml(e.id)}" data-group="${gi}" aria-label="Mark ${escapeHtml(e.name)} for removal">
            <span class="dup-file-path" title="${escapeHtml(e.relativePath || e.name)}">${escapeHtml(e.relativePath || e.name)}</span>
            ${i === 0 ? '<span class="dup-file-keep">first</span>' : ''}
          </div>
        `).join('')}
      </div>
    `).join('');

    updateRemoveBtn();
  }

  groupsEl.addEventListener('change', e => {
    if (e.target.classList.contains('dup-check')) updateRemoveBtn();
  });

  selectBtn.addEventListener('click', () => {
    groupsEl.querySelectorAll('.dup-group').forEach(groupEl => {
      groupEl.querySelectorAll('.dup-check').forEach((cb, i) => {
        cb.checked = i > 0;
      });
    });
    updateRemoveBtn();
  });

  removeBtn.addEventListener('click', async () => {
    const ids = checkedIds();
    if (!ids.length) return;
    const ok = await _confirm(
      `Remove ${pluralize(ids.length, 'file')} from the workspace? Files on your disk are not affected.`,
      'Remove',
      true
    );
    if (!ok) return;
    removeFiles(ids);
    // Drop removed entries from the current result set and re-render
    const removedSet = new Set(ids);
    groups = groups
      .map(g => ({ ...g, entries: g.entries.filter(e => !removedSet.has(e.id)) }))
      .filter(g => g.entries.length > 1);
    _renderDupResults();
    _toast(`Removed ${pluralize(ids.length, 'duplicate')} from the workspace.`, 'success');
  });

  exportBtn.addEventListener('click', () => {
    if (!groups.length) return;
    const rows = [['group', 'sha256', 'size_bytes', 'name', 'path']];
    groups.forEach((g, gi) => {
      for (const e of g.entries) {
        rows.push([String(gi + 1), g.hash, String(g.size), e.name, e.relativePath || e.name]);
      }
    });
    const csv = rows
      .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\r\n');
    downloadBlob(new Blob([csv], { type: 'text/csv' }), 'duplicate-report.csv');
  });

  // Invalidate stale results when workspace contents change
  on('files:cleared', () => { groups = []; results.hidden = true; });
}

// ─── Image converter ──────────────────────────────────────────────────────────

const CONVERTIBLE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'ico', 'tiff', 'tif'];
const FORMAT_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function _getConvertibleImages() {
  const all = Array.from(state.files.values());
  const pool = state.selectedIds.size > 0
    ? all.filter(f => state.selectedIds.has(f.id))
    : all;
  return pool.filter(f => f.category === 'image' && CONVERTIBLE_EXTS.includes(f.ext));
}

/**
 * Convert one image file via canvas.
 * @param {File} file
 * @param {{ format: string, quality: number, maxDim?: number }} opts
 * @returns {Promise<{ blob: Blob, width: number, height: number }>}
 */
export async function convertImage(file, opts) {
  const { format, quality, maxDim } = opts;

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // Fallback decode path for formats createImageBitmap rejects
    bitmap = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode image')); };
      img.src = url;
    });
  }

  const srcW = bitmap.width || bitmap.naturalWidth;
  const srcH = bitmap.height || bitmap.naturalHeight;
  let w = srcW;
  let h = srcH;
  if (maxDim && (w > maxDim || h > maxDim)) {
    const scale = Math.min(maxDim / w, maxDim / h);
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (format === 'image/jpeg') {
    // JPEG has no alpha — composite on white instead of black
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      b => (b ? resolve(b) : reject(new Error('Conversion produced no output'))),
      format,
      quality / 100
    );
  });
  return { blob, width: w, height: h };
}

function _initImageConverter(containerEl) {
  const countEl = containerEl.querySelector('#imgconv-count');
  const formatSel = containerEl.querySelector('#imgconv-format');
  const qualityWrap = containerEl.querySelector('#imgconv-quality-wrap');
  const qualityInput = containerEl.querySelector('#imgconv-quality');
  const qualityValue = containerEl.querySelector('#imgconv-quality-value');
  const maxDimInput = containerEl.querySelector('#imgconv-maxdim');
  const progressWrap = containerEl.querySelector('#imgconv-progress');
  const progressBar = containerEl.querySelector('#imgconv-progress-bar');
  const progressText = containerEl.querySelector('#imgconv-progress-text');
  const downloadBtn = containerEl.querySelector('#imgconv-download-btn');
  const addBtn = containerEl.querySelector('#imgconv-add-btn');
  const resultsEl = containerEl.querySelector('#imgconv-results');

  let converting = false;

  const updateCount = () => {
    const images = _getConvertibleImages();
    const scope = state.selectedIds.size > 0 ? 'selected' : 'in workspace';
    countEl.textContent = images.length
      ? `${pluralize(images.length, 'image')} ${scope}`
      : 'No convertible images';
    downloadBtn.disabled = converting || !images.length;
    addBtn.disabled = converting || !images.length;
  };

  on('files:added', updateCount);
  on('files:removed', updateCount);
  on('files:cleared', updateCount);
  on('selection:change', updateCount);
  updateCount();

  qualityInput.addEventListener('input', () => {
    qualityValue.textContent = qualityInput.value + '%';
  });
  formatSel.addEventListener('change', () => {
    qualityWrap.style.display = formatSel.value === 'image/png' ? 'none' : '';
  });

  async function convertAll() {
    const images = _getConvertibleImages();
    const format = formatSel.value;
    const quality = parseInt(qualityInput.value, 10) || 85;
    const maxDim = parseInt(maxDimInput.value, 10) || 0;
    const ext = FORMAT_EXT[format];

    const converted = [];
    const failed = [];
    progressWrap.hidden = false;

    for (let i = 0; i < images.length; i++) {
      const entry = images[i];
      progressBar.style.width = Math.round((i / images.length) * 100) + '%';
      progressText.textContent = `Converting ${i + 1} / ${images.length} — ${entry.name}`;
      try {
        const { blob } = await convertImage(entry.file, { format, quality, maxDim });
        const base = entry.name.replace(/\.[^.]+$/, '');
        const newName = `${base}.${ext}`;
        converted.push({
          entry,
          file: new File([blob], newName, { type: format, lastModified: Date.now() }),
          savedBytes: entry.size - blob.size,
        });
      } catch (err) {
        console.warn('tools: image conversion failed', entry.name, err);
        failed.push(entry.name);
      }
    }

    progressBar.style.width = '100%';
    progressWrap.hidden = true;
    return { converted, failed };
  }

  function reportResults(converted, failed, suffix) {
    const savedTotal = converted.reduce((n, c) => n + c.savedBytes, 0);
    const parts = [];
    if (converted.length) {
      parts.push(`Converted ${pluralize(converted.length, 'image')}${suffix}.`);
      parts.push(savedTotal >= 0
        ? `Saved ${formatBytes(Math.abs(savedTotal))}.`
        : `Output is ${formatBytes(Math.abs(savedTotal))} larger.`);
    }
    if (failed.length) parts.push(`Skipped (could not decode): ${failed.join(', ')}.`);
    resultsEl.textContent = parts.join(' ');
  }

  async function run(mode) {
    if (converting) return;
    const images = _getConvertibleImages();
    if (!images.length) return;
    converting = true;
    downloadBtn.disabled = true;
    addBtn.disabled = true;

    try {
      const { converted, failed } = await convertAll();

      if (mode === 'download' && converted.length) {
        if (converted.length === 1) {
          downloadBlob(converted[0].file, converted[0].file.name);
        } else {
          progressWrap.hidden = false;
          progressText.textContent = 'Packing ZIP…';
          const archives = await import('./archives.js');
          const zipEntries = converted.map(c => ({ file: c.file, name: c.file.name, relativePath: c.file.name }));
          const blob = await archives.createZip(zipEntries, {
            onProgress: pct => { progressBar.style.width = pct + '%'; },
          });
          downloadBlob(blob, 'converted-images.zip');
          progressWrap.hidden = true;
        }
        reportResults(converted, failed, ', downloaded');
      } else if (mode === 'add' && converted.length) {
        addFiles(converted.map(c => c.file));
        reportResults(converted, failed, ', added to workspace');
        _toast(`Added ${pluralize(converted.length, 'converted image')} to the workspace.`, 'success');
      } else {
        reportResults(converted, failed, '');
      }
    } catch (err) {
      console.error('tools: image conversion run failed', err);
      _toast('Image conversion failed: ' + err.message, 'error');
      progressWrap.hidden = true;
    }

    converting = false;
    updateCount();
  }

  downloadBtn.addEventListener('click', () => run('download'));
  addBtn.addEventListener('click', () => run('add'));
}
