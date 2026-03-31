// Archive operations: create ZIP, extract ZIP, extract RAR/7z/tar via libarchive.js

import { formatBytes, escapeHtml, generateId, downloadBlob, pluralize } from './utils.js';
import { $, $$, showToast, setLoading, renderProgress } from './ui.js';

// ─── Types ────────────────────────────────────────────────────────────────────
// ExtractedFile: { name, path, size, blob, isDirectory }

// ─── zip.js loader ────────────────────────────────────────────────────────────

let zipLib = null;

async function getZipLib() {
  if (zipLib) return zipLib;
  try {
    const mod = await import('https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.7.52/dist/zip.min.js');
    // Handle both ESM named exports and UMD/CJS default-wrapped bundles
    zipLib = mod.ZipWriter ? mod : (mod.default ?? mod);
    return zipLib;
  } catch {
    throw new Error('zip.js could not be loaded. Please check your internet connection.');
  }
}

// ─── libarchive loader ────────────────────────────────────────────────────────

let libArchiveLoaded = false;

async function loadLibArchive() {
  if (libArchiveLoaded && window.Archive) return window.Archive;
  if (typeof WebAssembly === 'undefined') {
    throw new Error('WebAssembly is not available in this browser. RAR/7z/tar extraction requires WASM support.');
  }
  return new Promise((resolve, reject) => {
    if (window.Archive) { libArchiveLoaded = true; resolve(window.Archive); return; }
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/libarchive.js@1.3.0/dist/libarchive.js';
    script.onload = () => {
      libArchiveLoaded = true;
      if (!window.Archive) { reject(new Error('libarchive.js loaded but Archive global not found.')); return; }
      resolve(window.Archive);
    };
    script.onerror = () => reject(new Error('Failed to load libarchive.js from CDN.'));
    document.head.appendChild(script);
  });
}

// ─── File type helpers ────────────────────────────────────────────────────────

/**
 * @param {File} file
 * @returns {boolean}
 */
export function isZipFile(file) {
  const name = (file.name || '').toLowerCase();
  return name.endsWith('.zip') || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
}

/**
 * @param {File} file
 * @returns {boolean}
 */
export function isArchiveFile(file) {
  const name = (file.name || '').toLowerCase();
  const archiveExts = ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.tgz', '.tar.gz', '.tar.bz2'];
  return archiveExts.some(ext => name.endsWith(ext));
}

/**
 * @param {File} file
 * @returns {boolean}
 */
export function isRarFile(file) {
  const name = (file.name || '').toLowerCase();
  return name.endsWith('.rar');
}

/**
 * @param {File} file
 * @returns {boolean}
 */
export function isNonZipArchive(file) {
  const name = (file.name || '').toLowerCase();
  const exts = ['.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.tgz', '.tar.gz', '.tar.bz2'];
  return exts.some(ext => name.endsWith(ext));
}

// ─── ZIP creation ─────────────────────────────────────────────────────────────

/**
 * Create a ZIP blob from an array of FileEntry objects.
 * @param {import('./state.js').FileEntry[]} fileEntries
 * @param {{ password?: string, onProgress?: (pct: number) => void }} options
 * @returns {Promise<Blob>}
 */
export async function createZip(fileEntries, options = {}) {
  const { BlobWriter, BlobReader, ZipWriter } = await getZipLib();
  const { password, onProgress } = options;

  const writerOptions = {};
  if (password) writerOptions.password = password;

  const blobWriter = new BlobWriter('application/zip');
  const zipWriter  = new ZipWriter(blobWriter, writerOptions);

  for (let i = 0; i < fileEntries.length; i++) {
    const entry = fileEntries[i];
    const path  = entry.relativePath || entry.name;
    await zipWriter.add(path, new BlobReader(entry.file));
    if (onProgress) onProgress(Math.round(((i + 1) / fileEntries.length) * 100));
  }

  await zipWriter.close();
  return blobWriter.getData();
}

// ─── ZIP extraction ───────────────────────────────────────────────────────────

/**
 * Extract a ZIP file.
 * @param {File} file
 * @param {{ onProgress?: (pct: number) => void }} options
 * @returns {Promise<ExtractedFile[]>}
 */
export async function extractZip(file, options = {}) {
  const { BlobReader, BlobWriter, ZipReader } = await getZipLib();
  const { onProgress } = options;

  const zipReader = new ZipReader(new BlobReader(file));
  const entries   = await zipReader.getEntries();
  const results   = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.directory) {
      results.push({ name: entry.filename.replace(/\/$/, '').split('/').pop(), path: entry.filename, size: 0, blob: null, isDirectory: true });
    } else {
      const writer = new BlobWriter();
      const blob   = await entry.getData(writer);
      const parts  = entry.filename.split('/');
      results.push({ name: parts[parts.length - 1], path: entry.filename, size: entry.uncompressedSize, blob, isDirectory: false });
    }
    if (onProgress) onProgress(Math.round(((i + 1) / entries.length) * 100));
  }

  await zipReader.close();
  return results;
}

// ─── Generic archive extraction ───────────────────────────────────────────────

/**
 * Extract any supported archive. Uses zip.js for ZIP; libarchive.js for everything else.
 * @param {File} file
 * @param {{ onProgress?: (pct: number) => void }} options
 * @returns {Promise<ExtractedFile[]>}
 */
export async function extractArchive(file, options = {}) {
  if (isZipFile(file)) return extractZip(file, options);

  const Archive = await loadLibArchive();
  Archive.init({ workerUrl: 'https://cdn.jsdelivr.net/npm/libarchive.js@1.3.0/dist/worker-bundle.js' });

  const archive = await Archive.open(file);
  const obj     = await archive.extractFiles();
  const results = [];

  function walkObj(node, prefix) {
    for (const [key, value] of Object.entries(node)) {
      if (value instanceof File) {
        const path = prefix ? `${prefix}/${key}` : key;
        results.push({ name: key, path, size: value.size, blob: value, isDirectory: false });
      } else if (typeof value === 'object' && value !== null) {
        walkObj(value, prefix ? `${prefix}/${key}` : key);
      }
    }
  }

  walkObj(obj, '');
  return results;
}

// ─── Repackage extracted files as ZIP ────────────────────────────────────────

/**
 * Create a ZIP blob from ExtractedFile array.
 * @param {ExtractedFile[]} extractedFiles
 * @returns {Promise<Blob>}
 */
export async function repackageAsZip(extractedFiles) {
  const { BlobWriter, BlobReader, ZipWriter } = await getZipLib();
  const blobWriter = new BlobWriter('application/zip');
  const zipWriter  = new ZipWriter(blobWriter);

  for (const ef of extractedFiles) {
    if (ef.isDirectory || !ef.blob) continue;
    await zipWriter.add(ef.path || ef.name, new BlobReader(ef.blob));
  }

  await zipWriter.close();
  return blobWriter.getData();
}

// ─── Module UI ────────────────────────────────────────────────────────────────

/**
 * Render the archive module UI into containerEl.
 * @param {HTMLElement} containerEl
 */
export function initArchiveModule(containerEl) {
  // ── Shell ──────────────────────────────────────────────────────────────────
  containerEl.innerHTML = `
    <div class="archive-module">
      <div class="archive-tabs">
        <button class="archive-tab active" data-tab="create">Create ZIP</button>
        <button class="archive-tab" data-tab="extract">Extract Archive</button>
        <button class="archive-tab" data-tab="convert">Convert to ZIP</button>
      </div>

      <!-- CREATE TAB -->
      <div class="archive-panel" id="archive-panel-create">
        <div class="archive-dropzone" id="create-dropzone" tabindex="0" role="button" aria-label="Drop files here or click to select">
          <div class="dropzone-inner">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40" height="40"><path d="M3 16v2a2 2 0 002 2h14a2 2 0 002-2v-2M12 3v12m-4-4l4 4 4-4"/></svg>
            <p>Drop files here or <button class="btn-link" id="create-select-btn">browse</button></p>
          </div>
        </div>
        <input type="file" id="create-file-input" multiple hidden>

        <div class="archive-file-list-wrap" id="create-file-list-wrap" hidden>
          <div class="archive-file-list-header">
            <span id="create-file-count"></span>
            <button class="btn btn-ghost btn-sm" id="create-clear-btn">Clear all</button>
          </div>
          <ul class="archive-file-list" id="create-file-list"></ul>
        </div>

        <div class="archive-create-options">
          <label class="archive-label">ZIP filename
            <input type="text" id="create-zip-name" class="archive-input" value="archive.zip" placeholder="archive.zip">
          </label>
          <label class="archive-label">
            <input type="checkbox" id="create-password-check"> Password protect
          </label>
          <div id="create-password-wrap" hidden>
            <input type="password" id="create-password-input" class="archive-input" placeholder="Enter password">
          </div>
        </div>

        <div class="archive-progress-wrap" id="create-progress-wrap" hidden>
          <div class="archive-progress-bar">
            <div class="archive-progress-fill" id="create-progress-fill" style="width:0%"></div>
          </div>
          <span id="create-progress-label">0%</span>
        </div>

        <div class="archive-actions">
          <button class="btn btn-primary" id="create-zip-btn">Create ZIP</button>
        </div>

        <div id="create-result-wrap" hidden>
          <button class="btn btn-secondary" id="create-download-btn">Download ZIP</button>
        </div>
      </div>

      <!-- EXTRACT TAB -->
      <div class="archive-panel" id="archive-panel-extract" hidden>
        <div class="archive-dropzone" id="extract-dropzone" tabindex="0" role="button" aria-label="Drop archive here or click to select">
          <div class="dropzone-inner">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40" height="40"><path d="M21 15v2a2 2 0 01-2 2H5a2 2 0 01-2-2v-2M17 8l-5-5-5 5M12 3v12"/></svg>
            <p>Drop archive here or <button class="btn-link" id="extract-select-btn">browse</button></p>
          </div>
        </div>
        <input type="file" id="extract-file-input" accept=".zip,.rar,.7z,.tar,.gz,.bz2,.xz,.tgz" hidden>

        <div id="extract-selected-info" hidden>
          <span id="extract-filename"></span>
          <span id="extract-filesize"></span>
          <button class="btn btn-ghost btn-sm" id="extract-clear-file-btn">✕</button>
        </div>

        <div id="extract-wasm-warning" class="archive-warning" hidden>
          <strong>Note:</strong> RAR/7z/tar extraction requires WebAssembly and libarchive.js. If extraction fails, your browser may not support WASM or the library could not be loaded.
        </div>

        <div class="archive-progress-wrap" id="extract-progress-wrap" hidden>
          <div class="archive-progress-bar">
            <div class="archive-progress-fill" id="extract-progress-fill" style="width:0%"></div>
          </div>
          <span id="extract-progress-label">0%</span>
        </div>

        <div class="archive-actions">
          <button class="btn btn-primary" id="extract-btn">Extract</button>
        </div>

        <div id="extract-results" hidden>
          <div class="extract-results-header">
            <span id="extract-results-count"></span>
            <span id="extract-results-size"></span>
            <button class="btn btn-secondary btn-sm" id="extract-download-all-btn">Download All as ZIP</button>
          </div>
          <ul class="extract-tree" id="extract-tree"></ul>
        </div>
      </div>

      <!-- CONVERT TAB -->
      <div class="archive-panel" id="archive-panel-convert" hidden>
        <p class="archive-convert-desc">Drop a RAR, 7z, TAR, GZ or any archive — it will be extracted and repacked as a ZIP file.</p>

        <div class="archive-dropzone" id="convert-dropzone" tabindex="0" role="button" aria-label="Drop archive here or click to select">
          <div class="dropzone-inner">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40" height="40"><path d="M8 7h12M8 12h12M8 17h12M4 7h.01M4 12h.01M4 17h.01"/></svg>
            <p>Drop RAR / 7z / TAR / ZIP here or <button class="btn-link" id="convert-select-btn">browse</button></p>
          </div>
        </div>
        <input type="file" id="convert-file-input" accept=".zip,.rar,.7z,.tar,.gz,.bz2,.xz,.tgz" hidden>

        <div id="convert-selected-info" hidden>
          <span id="convert-filename"></span>
          <span id="convert-filesize"></span>
          <button class="btn btn-ghost btn-sm" id="convert-clear-file-btn">✕</button>
        </div>

        <div id="convert-wasm-warning" class="archive-warning" hidden>
          <strong>Note:</strong> RAR/7z/tar requires WebAssembly (libarchive.js). If conversion fails, your browser may not support WASM.
        </div>

        <div class="archive-create-options">
          <label class="archive-label">Output ZIP filename
            <input type="text" id="convert-zip-name" class="archive-input" placeholder="converted.zip">
          </label>
        </div>

        <div class="archive-progress-wrap" id="convert-progress-wrap" hidden>
          <div class="archive-progress-bar">
            <div class="archive-progress-fill" id="convert-progress-fill" style="width:0%"></div>
          </div>
          <span id="convert-progress-label">0%</span>
        </div>

        <div class="archive-actions">
          <button class="btn btn-primary" id="convert-btn">Convert to ZIP</button>
        </div>

        <div id="convert-result-wrap" hidden>
          <button class="btn btn-secondary" id="convert-download-btn">Download ZIP</button>
        </div>
      </div>
    </div>
  `;

  // ── Tab switching ──────────────────────────────────────────────────────────
  const tabs = containerEl.querySelectorAll('.archive-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      containerEl.querySelector('#archive-panel-create').hidden  = (tab.dataset.tab !== 'create');
      containerEl.querySelector('#archive-panel-extract').hidden = (tab.dataset.tab !== 'extract');
      containerEl.querySelector('#archive-panel-convert').hidden = (tab.dataset.tab !== 'convert');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // CREATE ZIP
  // ═══════════════════════════════════════════════════════════════
  let createFiles = [];
  let createResultBlob = null;

  const createDropzone    = containerEl.querySelector('#create-dropzone');
  const createFileInput   = containerEl.querySelector('#create-file-input');
  const createSelectBtn   = containerEl.querySelector('#create-select-btn');
  const createFileList    = containerEl.querySelector('#create-file-list');
  const createFileListWrap = containerEl.querySelector('#create-file-list-wrap');
  const createFileCount   = containerEl.querySelector('#create-file-count');
  const createClearBtn    = containerEl.querySelector('#create-clear-btn');
  const createZipNameInput = containerEl.querySelector('#create-zip-name');
  const createPasswordCheck = containerEl.querySelector('#create-password-check');
  const createPasswordWrap  = containerEl.querySelector('#create-password-wrap');
  const createPasswordInput = containerEl.querySelector('#create-password-input');
  const createProgressWrap  = containerEl.querySelector('#create-progress-wrap');
  const createProgressFill  = containerEl.querySelector('#create-progress-fill');
  const createProgressLabel = containerEl.querySelector('#create-progress-label');
  const createZipBtn        = containerEl.querySelector('#create-zip-btn');
  const createResultWrap    = containerEl.querySelector('#create-result-wrap');
  const createDownloadBtn   = containerEl.querySelector('#create-download-btn');

  createPasswordCheck.addEventListener('change', () => {
    createPasswordWrap.hidden = !createPasswordCheck.checked;
  });

  function addFilesToCreate(files) {
    for (const f of files) {
      if (!createFiles.find(e => e.name === f.name && e.size === f.size)) {
        createFiles.push({ id: generateId(), file: f, name: f.name, relativePath: f.webkitRelativePath || f.name, size: f.size });
      }
    }
    renderCreateFileList();
  }

  function renderCreateFileList() {
    if (createFiles.length === 0) {
      createFileListWrap.hidden = true;
      createResultWrap.hidden = true;
      createResultBlob = null;
      return;
    }
    createFileListWrap.hidden = false;
    const total = createFiles.reduce((s, e) => s + e.size, 0);
    createFileCount.textContent = `${pluralize(createFiles.length, 'file')} — ${formatBytes(total)}`;
    createFileList.innerHTML = createFiles.map(e => `
      <li class="archive-file-item" data-id="${e.id}">
        <span class="archive-file-name">${escapeHtml(e.name)}</span>
        <span class="archive-file-size">${formatBytes(e.size)}</span>
        <button class="btn btn-ghost btn-xs archive-file-remove" data-id="${e.id}" title="Remove">✕</button>
      </li>`).join('');
    createFileList.querySelectorAll('.archive-file-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        createFiles = createFiles.filter(e => e.id !== btn.dataset.id);
        renderCreateFileList();
      });
    });
  }

  setupDropzone(createDropzone, files => addFilesToCreate(files));
  createSelectBtn.addEventListener('click', e => { e.preventDefault(); createFileInput.click(); });
  createFileInput.addEventListener('change', () => { addFilesToCreate(Array.from(createFileInput.files)); createFileInput.value = ''; });
  createDropzone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); createFileInput.click(); } });

  createClearBtn.addEventListener('click', () => { createFiles = []; renderCreateFileList(); });

  createZipBtn.addEventListener('click', async () => {
    if (createFiles.length === 0) { showToast('Add files to ZIP first.', 'warning'); return; }
    const zipName = (createZipNameInput.value.trim() || 'archive') + (createZipNameInput.value.trim().endsWith('.zip') ? '' : '.zip');
    const password = createPasswordCheck.checked ? createPasswordInput.value : undefined;

    createZipBtn.disabled = true;
    createResultWrap.hidden = true;
    createResultBlob = null;
    createProgressWrap.hidden = false;
    setProgress(createProgressFill, createProgressLabel, 0);

    try {
      const pseudoEntries = createFiles.map(e => ({ file: e.file, name: e.name, relativePath: e.relativePath }));
      const blob = await createZip(pseudoEntries, {
        password,
        onProgress: pct => setProgress(createProgressFill, createProgressLabel, pct),
      });
      createResultBlob = blob;
      setProgress(createProgressFill, createProgressLabel, 100);
      createResultWrap.hidden = false;
      createDownloadBtn.onclick = () => downloadBlob(createResultBlob, zipName);
      showToast(`ZIP created: ${formatBytes(blob.size)}`, 'success');
    } catch (err) {
      showToast(`ZIP creation failed: ${err.message}`, 'error');
    } finally {
      createZipBtn.disabled = false;
      setTimeout(() => { createProgressWrap.hidden = true; }, 1200);
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // EXTRACT
  // ═══════════════════════════════════════════════════════════════
  let extractFile     = null;
  let extractedFiles  = [];

  const extractDropzone     = containerEl.querySelector('#extract-dropzone');
  const extractFileInput    = containerEl.querySelector('#extract-file-input');
  const extractSelectBtn    = containerEl.querySelector('#extract-select-btn');
  const extractSelectedInfo = containerEl.querySelector('#extract-selected-info');
  const extractFilename     = containerEl.querySelector('#extract-filename');
  const extractFilesize     = containerEl.querySelector('#extract-filesize');
  const extractClearFileBtn = containerEl.querySelector('#extract-clear-file-btn');
  const extractWasmWarning  = containerEl.querySelector('#extract-wasm-warning');
  const extractProgressWrap = containerEl.querySelector('#extract-progress-wrap');
  const extractProgressFill = containerEl.querySelector('#extract-progress-fill');
  const extractProgressLabel = containerEl.querySelector('#extract-progress-label');
  const extractBtn          = containerEl.querySelector('#extract-btn');
  const extractResults      = containerEl.querySelector('#extract-results');
  const extractResultsCount = containerEl.querySelector('#extract-results-count');
  const extractResultsSize  = containerEl.querySelector('#extract-results-size');
  const extractDownloadAllBtn = containerEl.querySelector('#extract-download-all-btn');
  const extractTree         = containerEl.querySelector('#extract-tree');

  function setExtractFile(file) {
    extractFile = file;
    if (!file) {
      extractSelectedInfo.hidden = true;
      extractWasmWarning.hidden  = true;
      extractResults.hidden      = true;
      return;
    }
    extractFilename.textContent = file.name;
    extractFilesize.textContent = formatBytes(file.size);
    extractSelectedInfo.hidden = false;
    // Show warning for non-zip archives
    extractWasmWarning.hidden = isZipFile(file);
  }

  setupDropzone(extractDropzone, files => { if (files[0]) setExtractFile(files[0]); });
  extractSelectBtn.addEventListener('click', e => { e.preventDefault(); extractFileInput.click(); });
  extractFileInput.addEventListener('change', () => {
    if (extractFileInput.files[0]) { setExtractFile(extractFileInput.files[0]); extractFileInput.value = ''; }
  });
  extractDropzone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); extractFileInput.click(); } });
  extractClearFileBtn.addEventListener('click', () => { setExtractFile(null); extractedFiles = []; });

  extractBtn.addEventListener('click', async () => {
    if (!extractFile) { showToast('Select an archive file first.', 'warning'); return; }

    extractBtn.disabled = true;
    extractResults.hidden = true;
    extractProgressWrap.hidden = false;
    setProgress(extractProgressFill, extractProgressLabel, 0);

    try {
      extractedFiles = await extractArchive(extractFile, {
        onProgress: pct => setProgress(extractProgressFill, extractProgressLabel, pct),
      });
      setProgress(extractProgressFill, extractProgressLabel, 100);
      renderExtractResults(extractedFiles);
      showToast(`Extracted ${pluralize(extractedFiles.filter(f => !f.isDirectory).length, 'file')}.`, 'success');
    } catch (err) {
      showToast(`Extraction failed: ${err.message}`, 'error');
    } finally {
      extractBtn.disabled = false;
      setTimeout(() => { extractProgressWrap.hidden = true; }, 1200);
    }
  });

  function renderExtractResults(files) {
    const nonDirs = files.filter(f => !f.isDirectory);
    const total   = nonDirs.reduce((s, f) => s + (f.size || 0), 0);
    extractResultsCount.textContent = pluralize(nonDirs.length, 'file');
    extractResultsSize.textContent  = formatBytes(total);

    extractTree.innerHTML = nonDirs.map(f => `
      <li class="extract-tree-item">
        <span class="extract-file-path">${escapeHtml(f.path || f.name)}</span>
        <span class="extract-file-size">${formatBytes(f.size)}</span>
        <button class="btn btn-ghost btn-xs extract-dl-btn" data-path="${escapeHtml(f.path || f.name)}">Download</button>
      </li>`).join('');

    extractTree.querySelectorAll('.extract-dl-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const file = nonDirs.find(f => (f.path || f.name) === btn.dataset.path);
        if (!file || !file.blob) { showToast('File data not available.', 'error'); return; }
        downloadBlob(file.blob, file.name);
      });
    });

    extractResults.hidden = false;
  }

  extractDownloadAllBtn.addEventListener('click', async () => {
    const nonDirs = extractedFiles.filter(f => !f.isDirectory && f.blob);
    if (nonDirs.length === 0) { showToast('Nothing to download.', 'warning'); return; }
    extractDownloadAllBtn.disabled = true;
    extractDownloadAllBtn.textContent = 'Packing…';
    try {
      const blob = await repackageAsZip(extractedFiles);
      const baseName = (extractFile ? extractFile.name.replace(/\.[^.]+$/, '') : 'extracted');
      downloadBlob(blob, `${baseName}-extracted.zip`);
      showToast('Downloaded as ZIP.', 'success');
    } catch (err) {
      showToast(`Failed: ${err.message}`, 'error');
    } finally {
      extractDownloadAllBtn.disabled = false;
      extractDownloadAllBtn.textContent = 'Download All as ZIP';
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // CONVERT TO ZIP
  // ═══════════════════════════════════════════════════════════════
  let convertFile = null;
  let convertResultBlob = null;

  const convertDropzone      = containerEl.querySelector('#convert-dropzone');
  const convertFileInput     = containerEl.querySelector('#convert-file-input');
  const convertSelectBtn     = containerEl.querySelector('#convert-select-btn');
  const convertSelectedInfo  = containerEl.querySelector('#convert-selected-info');
  const convertFilename      = containerEl.querySelector('#convert-filename');
  const convertFilesize      = containerEl.querySelector('#convert-filesize');
  const convertClearFileBtn  = containerEl.querySelector('#convert-clear-file-btn');
  const convertWasmWarning   = containerEl.querySelector('#convert-wasm-warning');
  const convertZipNameInput  = containerEl.querySelector('#convert-zip-name');
  const convertProgressWrap  = containerEl.querySelector('#convert-progress-wrap');
  const convertProgressFill  = containerEl.querySelector('#convert-progress-fill');
  const convertProgressLabel = containerEl.querySelector('#convert-progress-label');
  const convertBtn           = containerEl.querySelector('#convert-btn');
  const convertResultWrap    = containerEl.querySelector('#convert-result-wrap');
  const convertDownloadBtn   = containerEl.querySelector('#convert-download-btn');

  function setConvertFile(file) {
    convertFile = file;
    convertResultWrap.hidden = true;
    convertResultBlob = null;
    if (!file) {
      convertSelectedInfo.hidden = true;
      convertWasmWarning.hidden  = true;
      convertZipNameInput.value  = '';
      return;
    }
    convertFilename.textContent = file.name;
    convertFilesize.textContent = formatBytes(file.size);
    convertSelectedInfo.hidden  = false;
    convertWasmWarning.hidden   = isZipFile(file);
    // Pre-fill output name
    const base = file.name.replace(/\.[^.]+$/, '');
    convertZipNameInput.value = base + '.zip';
  }

  setupDropzone(convertDropzone, files => { if (files[0]) setConvertFile(files[0]); });
  convertSelectBtn.addEventListener('click', e => { e.preventDefault(); convertFileInput.click(); });
  convertFileInput.addEventListener('change', () => {
    if (convertFileInput.files[0]) { setConvertFile(convertFileInput.files[0]); convertFileInput.value = ''; }
  });
  convertDropzone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); convertFileInput.click(); } });
  convertClearFileBtn.addEventListener('click', () => setConvertFile(null));

  convertBtn.addEventListener('click', async () => {
    if (!convertFile) { showToast('Select an archive file first.', 'warning'); return; }
    const zipName = (convertZipNameInput.value.trim() || convertFile.name.replace(/\.[^.]+$/, '')) +
                    (convertZipNameInput.value.trim().endsWith('.zip') ? '' : '.zip');

    convertBtn.disabled = true;
    convertResultWrap.hidden = true;
    convertResultBlob = null;
    convertProgressWrap.hidden = false;
    setProgress(convertProgressFill, convertProgressLabel, 0);

    try {
      // Phase 1: extract (0–60%)
      const extracted = await extractArchive(convertFile, {
        onProgress: pct => setProgress(convertProgressFill, convertProgressLabel, Math.round(pct * 0.6)),
      });
      setProgress(convertProgressFill, convertProgressLabel, 60);

      // Phase 2: repackage as ZIP (60–100%)
      const nonDirs = extracted.filter(f => !f.isDirectory && f.blob);
      if (nonDirs.length === 0) {
        showToast('Archive appears to be empty or contains only directories.', 'warning');
        return;
      }
      convertResultBlob = await repackageAsZip(extracted);
      setProgress(convertProgressFill, convertProgressLabel, 100);

      convertResultWrap.hidden = false;
      convertDownloadBtn.onclick = () => downloadBlob(convertResultBlob, zipName);
      showToast(`Converted to ZIP: ${formatBytes(convertResultBlob.size)}`, 'success');
    } catch (err) {
      showToast(`Conversion failed: ${err.message}`, 'error');
    } finally {
      convertBtn.disabled = false;
      setTimeout(() => { convertProgressWrap.hidden = true; }, 1200);
    }
  });

  // ─── Shared helpers ────────────────────────────────────────────────────────

  function setProgress(fillEl, labelEl, pct) {
    fillEl.style.width = `${pct}%`;
    labelEl.textContent = `${pct}%`;
  }

  function setupDropzone(zone, onFiles) {
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('dragover');
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) onFiles(files);
    });
  }
}
