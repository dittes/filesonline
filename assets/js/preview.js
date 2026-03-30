// preview.js
// Complete file preview panel for Files Online.
// Renders previews in the right pane (.pane-right).
// Handles: text, JSON, CSV, XLSX, images, audio, video, PDF (PDF.js), DOCX (Mammoth.js), binary hex dump.

import { on, state } from './state.js';
import {
  formatBytes,
  getFileTypeIcon,
  truncateMiddle,
  escapeHtml,
  readFileAsText,
  readFileAsArrayBuffer,
  downloadBlob,
} from './utils.js';

// ─── Module-level state ───────────────────────────────────────────────────────

/** @type {HTMLElement|null} */
let _container = null;

/** @type {string|null} Object URL to revoke on next preview */
let _currentObjectUrl = null;

/** Current PDF document (pdfjs) */
let _pdfDoc = null;
/** Current PDF page number */
let _pdfPage = 1;
/** Total PDF pages */
let _pdfTotal = 0;

// ─── Library loaders ─────────────────────────────────────────────────────────

let _pdfjsLib = null;
let _xlsxLib = null;
let _mammothLib = null;

/**
 * Dynamically import PDF.js via ESM.
 * @returns {Promise<any>}
 */
async function loadPDFjs() {
  if (_pdfjsLib) return _pdfjsLib;
  const mod = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.mjs');
  _pdfjsLib = mod;
  _pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs';
  return _pdfjsLib;
}

/**
 * Dynamically load SheetJS via script tag.
 * @returns {Promise<any>}
 */
function loadSheetJS() {
  if (_xlsxLib) return Promise.resolve(_xlsxLib);
  if (window.XLSX) {
    _xlsxLib = window.XLSX;
    return Promise.resolve(_xlsxLib);
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    script.onload = () => {
      _xlsxLib = window.XLSX;
      resolve(_xlsxLib);
    };
    script.onerror = () => reject(new Error('Failed to load SheetJS'));
    document.head.appendChild(script);
  });
}

/**
 * Dynamically load Mammoth.js via script tag.
 * @returns {Promise<any>}
 */
function loadMammoth() {
  if (_mammothLib) return Promise.resolve(_mammothLib);
  if (window.mammoth) {
    _mammothLib = window.mammoth;
    return Promise.resolve(_mammothLib);
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js';
    script.onload = () => {
      _mammothLib = window.mammoth;
      resolve(_mammothLib);
    };
    script.onerror = () => reject(new Error('Failed to load Mammoth.js'));
    document.head.appendChild(script);
  });
}

// ─── CSV parser ───────────────────────────────────────────────────────────────

/**
 * Simple CSV parser that handles quoted fields and escaped quotes.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCSV(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    if (line.trim() === '') continue;
    const row = [];
    let field = '';
    let inQuotes = false;
    let i = 0;

    while (i < line.length) {
      const ch = line[i];

      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            inQuotes = false;
            i++;
          }
        } else {
          field += ch;
          i++;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
          i++;
        } else if (ch === ',') {
          row.push(field);
          field = '';
          i++;
        } else {
          field += ch;
          i++;
        }
      }
    }
    row.push(field);
    rows.push(row);
  }

  return rows;
}

// ─── Hex dump ─────────────────────────────────────────────────────────────────

/**
 * Build an HTML hex dump table from the first N bytes of an ArrayBuffer.
 * @param {ArrayBuffer} buffer
 * @param {number} [maxBytes=256]
 * @returns {string} HTML string
 */
function buildHexDump(buffer, maxBytes = 256) {
  const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, maxBytes));
  const bytesPerRow = 16;
  let html = '<div class="hex-dump"><table class="hex-table"><thead><tr>';
  html += '<th>Offset</th>';
  for (let i = 0; i < bytesPerRow; i++) {
    html += `<th>${i.toString(16).toUpperCase().padStart(2, '0')}</th>`;
  }
  html += '<th class="hex-ascii">ASCII</th></tr></thead><tbody>';

  for (let row = 0; row < bytes.length; row += bytesPerRow) {
    const offset = row.toString(16).toUpperCase().padStart(8, '0');
    html += `<tr><td class="hex-offset">${offset}</td>`;
    let ascii = '';
    for (let col = 0; col < bytesPerRow; col++) {
      const idx = row + col;
      if (idx < bytes.length) {
        const b = bytes[idx];
        html += `<td>${b.toString(16).toUpperCase().padStart(2, '0')}</td>`;
        ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
      } else {
        html += '<td></td>';
      }
    }
    html += `<td class="hex-ascii">${escapeHtml(ascii)}</td></tr>`;
  }

  html += '</tbody></table></div>';
  return html;
}

// ─── Panel HTML builders ──────────────────────────────────────────────────────

/**
 * Build the header HTML for the preview panel.
 * @param {import('./state.js').FileEntry} fileEntry
 * @returns {string}
 */
function buildPanelHeader(fileEntry) {
  const icon = getFileTypeIcon(fileEntry.ext);
  const displayName = truncateMiddle(fileEntry.name, 40);
  const size = formatBytes(fileEntry.size);

  return `
    <div class="preview-header">
      <div class="preview-header-icon">${icon}</div>
      <div class="preview-header-info">
        <span class="preview-filename" title="${escapeHtml(fileEntry.name)}">${escapeHtml(displayName)}</span>
        <span class="preview-filesize">${escapeHtml(size)}</span>
      </div>
      <div class="preview-header-actions">
        <button class="btn btn-sm btn-ghost preview-download-btn" title="Download file">
          <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14">
            <path d="M8 2v8M5 7l3 3 3-3M3 13h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          Download
        </button>
        <button class="btn btn-sm btn-ghost preview-close-btn" title="Close preview" aria-label="Close preview">
          <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
    </div>
  `;
}

/**
 * Render the loading state in the preview body.
 * @param {string} [message='Loading preview…']
 */
function setBodyLoading(message = 'Loading preview\u2026') {
  const body = _container && _container.querySelector('.preview-body');
  if (!body) return;
  body.innerHTML = `
    <div class="preview-loading">
      <div class="spinner"></div>
      <span>${escapeHtml(message)}</span>
    </div>
  `;
}

/**
 * Render an error state in the preview body.
 * @param {string} message
 */
function setBodyError(message) {
  const body = _container && _container.querySelector('.preview-body');
  if (!body) return;
  body.innerHTML = `
    <div class="preview-error">
      <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="32" height="32">
        <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/>
        <path d="M8 5v4M8 11v1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

// ─── Preview renderers ────────────────────────────────────────────────────────

/**
 * Render a text / code / JSON preview.
 * @param {import('./state.js').FileEntry} fileEntry
 * @param {HTMLElement} body
 * @param {HTMLElement} footer
 */
async function renderText(fileEntry, body, footer) {
  const MAX_BYTES = 500 * 1024; // 500 KB
  let text;

  if (fileEntry.size > MAX_BYTES) {
    const slice = fileEntry.file.slice(0, MAX_BYTES);
    text = await readFileAsText(slice);
    footer.innerHTML = `<span class="preview-notice">Showing first ${formatBytes(MAX_BYTES)} of ${formatBytes(fileEntry.size)} — file truncated for preview.</span>`;
  } else {
    text = await readFileAsText(fileEntry.file);
  }

  // Pretty-print JSON
  if (fileEntry.ext === 'json' || fileEntry.type === 'application/json') {
    try {
      const parsed = JSON.parse(text);
      text = JSON.stringify(parsed, null, 2);
    } catch (_) {
      // Not valid JSON — show as-is with a notice
      footer.innerHTML += `<span class="preview-notice">JSON parse error — showing raw text.</span>`;
    }
  }

  const lines = text.split('\n');
  const lineNumbers = lines.map((_, i) => `<span class="ln">${i + 1}</span>`).join('\n');
  const codeContent = lines.map(l => `<span class="lc">${escapeHtml(l)}</span>`).join('\n');
  const langHint = fileEntry.ext || 'txt';

  body.innerHTML = `
    <div class="code-preview" data-lang="${escapeHtml(langHint)}">
      <div class="code-gutter" aria-hidden="true">${lineNumbers}</div>
      <pre class="code-content"><code>${codeContent}</code></pre>
    </div>
  `;

  // Sync scroll between gutter and code
  const gutter = body.querySelector('.code-gutter');
  const pre = body.querySelector('.code-content');
  if (pre && gutter) {
    pre.addEventListener('scroll', () => { gutter.scrollTop = pre.scrollTop; });
  }
}

/**
 * Render an image preview with dimensions and lightbox zoom.
 * @param {import('./state.js').FileEntry} fileEntry
 * @param {HTMLElement} body
 * @param {HTMLElement} footer
 */
async function renderImage(fileEntry, body, footer) {
  _revokeCurrentObjectUrl();
  const url = URL.createObjectURL(fileEntry.file);
  _currentObjectUrl = url;

  body.innerHTML = `
    <div class="image-preview">
      <img src="${escapeHtml(url)}" alt="${escapeHtml(fileEntry.name)}" class="preview-img" />
    </div>
  `;

  const img = body.querySelector('.preview-img');
  img.addEventListener('load', () => {
    footer.innerHTML = `<span class="preview-info">${img.naturalWidth} &times; ${img.naturalHeight} px</span>`;
  });

  // Lightbox zoom on click
  img.addEventListener('click', () => {
    _openLightbox(url, fileEntry.name);
  });
}

/**
 * Render an audio player.
 * @param {import('./state.js').FileEntry} fileEntry
 * @param {HTMLElement} body
 */
async function renderAudio(fileEntry, body) {
  _revokeCurrentObjectUrl();
  const url = URL.createObjectURL(fileEntry.file);
  _currentObjectUrl = url;

  body.innerHTML = `
    <div class="audio-preview">
      <div class="audio-icon">${getFileTypeIcon(fileEntry.ext)}</div>
      <p class="audio-name">${escapeHtml(fileEntry.name)}</p>
      <audio controls class="preview-audio">
        <source src="${escapeHtml(url)}" type="${escapeHtml(fileEntry.type)}">
        Your browser does not support the audio element.
      </audio>
    </div>
  `;
}

/**
 * Render a video player.
 * @param {import('./state.js').FileEntry} fileEntry
 * @param {HTMLElement} body
 */
async function renderVideo(fileEntry, body) {
  _revokeCurrentObjectUrl();
  const url = URL.createObjectURL(fileEntry.file);
  _currentObjectUrl = url;

  body.innerHTML = `
    <div class="video-preview">
      <video controls class="preview-video" style="max-height:300px;max-width:100%;">
        <source src="${escapeHtml(url)}" type="${escapeHtml(fileEntry.type)}">
        Your browser does not support the video element.
      </video>
    </div>
  `;
}

/**
 * Render a CSV table preview (first 100 rows).
 * @param {import('./state.js').FileEntry} fileEntry
 * @param {HTMLElement} body
 * @param {HTMLElement} footer
 */
async function renderCSV(fileEntry, body, footer) {
  const text = await readFileAsText(fileEntry.file);
  const rows = parseCSV(text);
  const totalRows = rows.length;
  const displayRows = rows.slice(0, 101); // header + 100 data rows
  const hasHeader = displayRows.length > 0;

  let html = '<div class="csv-preview"><table class="csv-table">';

  if (hasHeader) {
    const headerRow = displayRows[0];
    html += '<thead><tr>' + headerRow.map(cell => `<th>${escapeHtml(cell)}</th>`).join('') + '</tr></thead>';
    html += '<tbody>';
    for (let i = 1; i < displayRows.length; i++) {
      html += '<tr>' + displayRows[i].map(cell => `<td>${escapeHtml(cell)}</td>`).join('') + '</tr>';
    }
    html += '</tbody>';
  }

  html += '</table></div>';
  body.innerHTML = html;

  const shownRows = Math.max(0, displayRows.length - 1);
  const dataRows = Math.max(0, totalRows - 1);
  let footerText = `${dataRows.toLocaleString()} row${dataRows !== 1 ? 's' : ''}`;
  if (dataRows > 100) {
    footerText += ` &mdash; showing first 100`;
  }
  footer.innerHTML = `<span class="preview-info">${footerText}</span>`;
}

/**
 * Render an XLSX spreadsheet using SheetJS.
 * @param {import('./state.js').FileEntry} fileEntry
 * @param {HTMLElement} body
 * @param {HTMLElement} footer
 */
async function renderXLSX(fileEntry, body, footer) {
  const XLSX = await loadSheetJS();
  const buffer = await readFileAsArrayBuffer(fileEntry.file);
  const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const html = XLSX.utils.sheet_to_html(sheet, { editable: false });

  body.innerHTML = `<div class="xlsx-preview">${html}</div>`;

  const sheetCount = workbook.SheetNames.length;
  footer.innerHTML = `<span class="preview-info">Sheet: <strong>${escapeHtml(sheetName)}</strong>${sheetCount > 1 ? ` (1 of ${sheetCount} sheets)` : ''}</span>`;
}

/**
 * Render a PDF using PDF.js — first renders page 1 and sets up navigation.
 * @param {import('./state.js').FileEntry} fileEntry
 * @param {HTMLElement} body
 * @param {HTMLElement} footer
 */
async function renderPDF(fileEntry, body, footer) {
  const pdfjsLib = await loadPDFjs();
  const buffer = await readFileAsArrayBuffer(fileEntry.file);

  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
  const pdf = await loadingTask.promise;

  _pdfDoc = pdf;
  _pdfTotal = pdf.numPages;
  _pdfPage = 1;

  // Build body with canvas container
  body.innerHTML = `
    <div class="pdf-preview">
      <div class="pdf-canvas-wrap">
        <canvas class="pdf-canvas"></canvas>
      </div>
    </div>
  `;

  await _renderPDFPage(_pdfPage, body);

  // Build footer navigation
  _buildPDFFooter(footer);
}

/**
 * Render a specific PDF page onto the canvas.
 * @param {number} pageNum
 * @param {HTMLElement} body
 */
async function _renderPDFPage(pageNum, body) {
  const canvas = body.querySelector('.pdf-canvas');
  if (!canvas || !_pdfDoc) return;

  const page = await _pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1.5 });
  canvas.height = viewport.height;
  canvas.width = viewport.width;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
}

/**
 * Build PDF page navigation in the footer.
 * @param {HTMLElement} footer
 */
function _buildPDFFooter(footer) {
  footer.innerHTML = `
    <div class="pdf-nav">
      <button class="btn btn-sm btn-ghost pdf-prev" ${_pdfPage <= 1 ? 'disabled' : ''}>&#8592; Prev</button>
      <span class="pdf-page-info">Page <strong class="pdf-page-num">${_pdfPage}</strong> of ${_pdfTotal}</span>
      <button class="btn btn-sm btn-ghost pdf-next" ${_pdfPage >= _pdfTotal ? 'disabled' : ''}>Next &#8594;</button>
    </div>
  `;

  const body = _container && _container.querySelector('.preview-body');

  footer.querySelector('.pdf-prev').addEventListener('click', async () => {
    if (_pdfPage > 1) {
      _pdfPage--;
      await _renderPDFPage(_pdfPage, body);
      _buildPDFFooter(footer);
    }
  });

  footer.querySelector('.pdf-next').addEventListener('click', async () => {
    if (_pdfPage < _pdfTotal) {
      _pdfPage++;
      await _renderPDFPage(_pdfPage, body);
      _buildPDFFooter(footer);
    }
  });
}

/**
 * Render a DOCX file using Mammoth.js.
 * @param {import('./state.js').FileEntry} fileEntry
 * @param {HTMLElement} body
 */
async function renderDOCX(fileEntry, body) {
  const mammoth = await loadMammoth();
  const buffer = await readFileAsArrayBuffer(fileEntry.file);
  const result = await mammoth.convertToHtml({ arrayBuffer: buffer });

  body.innerHTML = `<div class="docx-preview">${result.value}</div>`;
}

/**
 * Render a binary hex dump for unknown/unsupported files.
 * @param {import('./state.js').FileEntry} fileEntry
 * @param {HTMLElement} body
 * @param {HTMLElement} footer
 */
async function renderBinary(fileEntry, body, footer) {
  const MAX_HEX_BYTES = 256;
  const buffer = await readFileAsArrayBuffer(fileEntry.file.slice(0, MAX_HEX_BYTES));
  const hexHtml = buildHexDump(buffer, MAX_HEX_BYTES);

  body.innerHTML = `
    <div class="binary-preview">
      <div class="binary-info">
        <div class="binary-icon">${getFileTypeIcon(fileEntry.ext)}</div>
        <div class="binary-meta">
          <strong>${escapeHtml(fileEntry.name)}</strong>
          <span>${escapeHtml(fileEntry.type || 'application/octet-stream')}</span>
          <span>${formatBytes(fileEntry.size)}</span>
        </div>
      </div>
      <p class="hex-dump-label">Hex dump (first ${MAX_HEX_BYTES} bytes)</p>
      ${hexHtml}
    </div>
  `;

  footer.innerHTML = `<span class="preview-notice">Binary file &mdash; download to open with a native application.</span>`;
}

// ─── Lightbox ─────────────────────────────────────────────────────────────────

/**
 * Open a full-screen lightbox for an image.
 * @param {string} src  Object URL
 * @param {string} alt  Alt text
 */
function _openLightbox(src, alt) {
  const existing = document.getElementById('preview-lightbox');
  if (existing) existing.remove();

  const lb = document.createElement('div');
  lb.id = 'preview-lightbox';
  lb.className = 'lightbox';
  lb.setAttribute('role', 'dialog');
  lb.setAttribute('aria-modal', 'true');
  lb.setAttribute('aria-label', `Image preview: ${alt}`);
  lb.innerHTML = `
    <div class="lightbox-backdrop"></div>
    <div class="lightbox-content">
      <button class="lightbox-close btn btn-ghost" aria-label="Close lightbox">
        <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="20" height="20">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </button>
      <img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" class="lightbox-img" />
    </div>
  `;

  document.body.appendChild(lb);

  // Force reflow then animate in
  requestAnimationFrame(() => lb.classList.add('lightbox-visible'));

  const close = () => {
    lb.classList.remove('lightbox-visible');
    lb.addEventListener('transitionend', () => lb.remove(), { once: true });
  };

  lb.querySelector('.lightbox-close').addEventListener('click', close);
  lb.querySelector('.lightbox-backdrop').addEventListener('click', close);
  lb.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  lb.setAttribute('tabindex', '-1');
  lb.focus();
}

// ─── Object URL management ────────────────────────────────────────────────────

function _revokeCurrentObjectUrl() {
  if (_currentObjectUrl) {
    URL.revokeObjectURL(_currentObjectUrl);
    _currentObjectUrl = null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialise the preview panel inside the given container element.
 * @param {HTMLElement} containerEl
 */
export function initPreviewPanel(containerEl) {
  _container = containerEl;
  _renderEmptyState();

  // Listen to state events
  on('preview:open', ({ fileId }) => {
    const fileEntry = state.files.get(fileId);
    if (fileEntry) {
      previewFile(fileEntry);
    }
  });

  on('preview:close', () => {
    clearPreview();
  });
}

/**
 * Render the empty/idle state for the preview panel.
 */
function _renderEmptyState() {
  if (!_container) return;
  _container.innerHTML = `
    <div class="preview-empty">
      <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" width="48" height="48" aria-hidden="true">
        <rect x="8" y="6" width="28" height="36" rx="2" stroke="currentColor" stroke-width="2"/>
        <path d="M16 18h16M16 24h16M16 30h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M32 6v10h8" stroke="currentColor" stroke-width="2"/>
      </svg>
      <p>Select a file to preview</p>
    </div>
  `;
}

/**
 * Clear the preview panel back to empty state.
 */
export function clearPreview() {
  _revokeCurrentObjectUrl();
  _pdfDoc = null;
  _pdfPage = 1;
  _pdfTotal = 0;
  _renderEmptyState();
}

/**
 * Preview a file entry in the right panel.
 * @param {import('./state.js').FileEntry} fileEntry
 * @returns {Promise<void>}
 */
export async function previewFile(fileEntry) {
  if (!_container) return;

  // Revoke previous object URL
  _revokeCurrentObjectUrl();
  _pdfDoc = null;

  // Render shell
  _container.innerHTML = `
    ${buildPanelHeader(fileEntry)}
    <div class="preview-body"></div>
    <div class="preview-footer"></div>
  `;

  const body = _container.querySelector('.preview-body');
  const footer = _container.querySelector('.preview-footer');

  // Wire up download button
  const downloadBtn = _container.querySelector('.preview-download-btn');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => {
      downloadBlob(fileEntry.file, fileEntry.name);
    });
  }

  // Wire up close button
  const closeBtn = _container.querySelector('.preview-close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      import('./state.js').then(({ closePreview }) => closePreview());
    });
  }

  const ext = fileEntry.ext.toLowerCase();
  const mime = (fileEntry.type || '').toLowerCase();
  const category = fileEntry.category;

  try {
    // ── Image ──────────────────────────────────────────────────────────────
    if (category === 'image' || mime.startsWith('image/')) {
      await renderImage(fileEntry, body, footer);
      return;
    }

    // ── Audio ──────────────────────────────────────────────────────────────
    if (category === 'audio' || mime.startsWith('audio/')) {
      await renderAudio(fileEntry, body);
      return;
    }

    // ── Video ──────────────────────────────────────────────────────────────
    if (category === 'video' || mime.startsWith('video/')) {
      await renderVideo(fileEntry, body);
      return;
    }

    // ── PDF ────────────────────────────────────────────────────────────────
    if (ext === 'pdf' || mime === 'application/pdf') {
      setBodyLoading('Loading PDF\u2026');
      await renderPDF(fileEntry, body, footer);
      return;
    }

    // ── DOCX ───────────────────────────────────────────────────────────────
    if (
      ext === 'docx' ||
      mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      setBodyLoading('Converting DOCX\u2026');
      await renderDOCX(fileEntry, body);
      return;
    }

    // ── XLSX / XLS ─────────────────────────────────────────────────────────
    if (
      ext === 'xlsx' ||
      ext === 'xls' ||
      ext === 'ods' ||
      mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mime === 'application/vnd.ms-excel'
    ) {
      setBodyLoading('Loading spreadsheet\u2026');
      await renderXLSX(fileEntry, body, footer);
      return;
    }

    // ── CSV ────────────────────────────────────────────────────────────────
    if (ext === 'csv' || mime === 'text/csv') {
      await renderCSV(fileEntry, body, footer);
      return;
    }

    // ── Text / code / JSON ─────────────────────────────────────────────────
    const textCategories = ['text', 'code'];
    const textMimes = [
      'text/plain', 'text/html', 'text/css', 'text/javascript',
      'application/json', 'application/xml', 'application/javascript',
    ];
    const textExts = [
      'txt', 'md', 'markdown', 'log', 'json', 'xml', 'yaml', 'yml',
      'toml', 'ini', 'cfg', 'conf', 'js', 'ts', 'jsx', 'tsx', 'mjs',
      'html', 'htm', 'css', 'scss', 'less', 'sass', 'svg',
      'py', 'rb', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'php',
      'sh', 'bash', 'zsh', 'fish', 'sql', 'lua', 'swift', 'kt',
      'vue', 'svelte', 'nfo', 'readme',
    ];

    if (
      textCategories.includes(category) ||
      textMimes.some(m => mime.startsWith(m)) ||
      textExts.includes(ext) ||
      mime.startsWith('text/')
    ) {
      await renderText(fileEntry, body, footer);
      return;
    }

    // ── Binary fallback ────────────────────────────────────────────────────
    await renderBinary(fileEntry, body, footer);

  } catch (err) {
    console.error('preview: render error', err);
    setBodyError(`Could not preview this file: ${err.message || 'Unknown error'}`);
  }
}
