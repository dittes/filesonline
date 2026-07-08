// md-viewer.js
// MD Viewer Online — open, view, edit, save, import, export and convert
// Markdown files. Everything runs locally in the browser; nothing is uploaded.
//
// Libraries (marked, DOMPurify, Turndown, highlight.js, html2pdf) are loaded
// lazily from CDN only when a feature needs them.

import { initTheme } from './theme.js';
import { showToast } from './ui.js';
import { downloadBlob, debounce, readFileAsText } from './utils.js';

// ─── CDN library registry ─────────────────────────────────────────────────────

const CDN = {
  marked: 'https://cdn.jsdelivr.net/npm/marked@4.3.0/marked.min.js',
  purify: 'https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js',
  turndown: 'https://cdn.jsdelivr.net/npm/turndown@7.1.2/dist/turndown.js',
  hljs: 'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.9.0/highlight.min.js',
  hljsCssLight: 'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.9.0/styles/github.min.css',
  hljsCssDark: 'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.9.0/styles/github-dark.min.css',
  html2canvas: 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
  jspdf: 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js',
};

const _loaded = new Map(); // src -> Promise

function loadScript(src) {
  if (_loaded.has(src)) return _loaded.get(src);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
  _loaded.set(src, p);
  return p;
}

function loadCss(href, id) {
  if (document.getElementById(id)) return document.getElementById(id);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.id = id;
  document.head.appendChild(link);
  return link;
}

/** Load marked + DOMPurify (needed for any rendering). */
async function ensureRenderer() {
  await Promise.all([loadScript(CDN.marked), loadScript(CDN.purify)]);
  if (!ensureRenderer._configured) {
    window.marked.setOptions({
      gfm: true,
      breaks: false,
      headerIds: true,
      headerPrefix: 'md-',
      mangle: false,
    });
    // Open rendered links in a new tab, safely
    window.DOMPurify.addHook('afterSanitizeAttributes', node => {
      if (node.tagName === 'A' && node.getAttribute('href')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
    ensureRenderer._configured = true;
  }
}

async function ensureTurndown() {
  await loadScript(CDN.turndown);
  if (!ensureTurndown._service) {
    ensureTurndown._service = new window.TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
    });
  }
  return ensureTurndown._service;
}

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  fileName: 'untitled.md',
  /** @type {FileSystemFileHandle|null} */
  fileHandle: null,
  dirty: false,
  view: 'split',
  lastHtml: '',
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const $ = sel => document.querySelector(sel);

const editor = $('#mdv-editor');
const preview = $('#mdv-preview');
const rawCode = $('#mdv-raw-code');
const panes = $('#mdv-panes');
const tocBox = $('#mdv-toc');
const tocList = $('#mdv-toc-list');
const fileNameEl = $('#mdv-filename');
const dirtyEl = $('#mdv-dirty');
const fileInput = $('#mdv-file-input');
const htmlInput = $('#mdv-html-input');
const pasteModal = $('#mdv-paste-modal');
const pasteTextarea = $('#mdv-paste-textarea');

// ─── Rendering ────────────────────────────────────────────────────────────────

const EMPTY_STATE_HTML = `
  <div class="mdv-empty">
    <p>Nothing to preview yet.</p>
    <p>Open a <code>.md</code> file, paste Markdown, or try the sample.</p>
  </div>`;

async function render() {
  const md = editor.value;

  if (!md.trim()) {
    state.lastHtml = '';
    preview.innerHTML = EMPTY_STATE_HTML;
    rawCode.textContent = '';
    tocBox.hidden = true;
    updateStats();
    return;
  }

  try {
    await ensureRenderer();
  } catch (err) {
    preview.innerHTML = `<div class="mdv-empty"><p>Could not load the Markdown renderer. Please check your connection and reload.</p></div>`;
    return;
  }

  const rawHtml = window.marked.parse(md);
  const clean = window.DOMPurify.sanitize(rawHtml);
  state.lastHtml = clean;
  preview.innerHTML = clean;
  rawCode.textContent = clean;

  buildTOC();
  highlightCode();
  updateStats();
}

const renderDebounced = debounce(render, 200);

/** Build the table of contents from H2/H3 headings in the preview. */
function buildTOC() {
  const headings = preview.querySelectorAll('h2[id], h3[id]');
  if (headings.length < 2) {
    tocBox.hidden = true;
    tocList.innerHTML = '';
    return;
  }
  tocList.innerHTML = '';
  headings.forEach(h => {
    const a = document.createElement('a');
    a.textContent = h.textContent;
    a.href = '#' + h.id;
    a.dataset.level = h.tagName === 'H3' ? '3' : '2';
    a.addEventListener('click', e => {
      e.preventDefault();
      h.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    tocList.appendChild(a);
  });
  tocBox.hidden = false;
}

/** Syntax-highlight fenced code blocks (loads highlight.js on first use). */
async function highlightCode() {
  const blocks = preview.querySelectorAll('pre code');
  if (!blocks.length) return;
  try {
    await loadScript(CDN.hljs);
    _syncHljsTheme();
    blocks.forEach(block => window.hljs.highlightElement(block));
  } catch { /* highlighting is optional */ }
}

/** Keep the highlight.js color theme in sync with the app theme. */
function _syncHljsTheme() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const light = loadCss(CDN.hljsCssLight, 'hljs-css-light');
  const darkCss = loadCss(CDN.hljsCssDark, 'hljs-css-dark');
  light.disabled = dark;
  darkCss.disabled = !dark;
}

new MutationObserver(() => {
  if (document.getElementById('hljs-css-light')) _syncHljsTheme();
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// ─── Stats / dirty state ──────────────────────────────────────────────────────

function updateStats() {
  const text = editor.value;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const lines = text ? text.split('\n').length : 0;
  $('#mdv-stat-words').textContent = `${words.toLocaleString()} word${words !== 1 ? 's' : ''}`;
  $('#mdv-stat-chars').textContent = `${text.length.toLocaleString()} characters`;
  $('#mdv-stat-lines').textContent = `${lines.toLocaleString()} line${lines !== 1 ? 's' : ''}`;
  fileNameEl.textContent = state.fileName;
  dirtyEl.hidden = !state.dirty;
}

function setDirty(dirty) {
  state.dirty = dirty;
  dirtyEl.hidden = !dirty;
}

function baseName() {
  return state.fileName.replace(/\.(md|markdown|txt|text|html?)$/i, '') || 'untitled';
}

// ─── Content loading ──────────────────────────────────────────────────────────

/**
 * Put Markdown content into the editor.
 * @param {string} md
 * @param {string} name
 * @param {FileSystemFileHandle|null} [handle]
 */
function setContent(md, name, handle = null) {
  editor.value = md;
  state.fileName = name;
  state.fileHandle = handle;
  setDirty(false);
  render();
  document.getElementById('editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * Load a File object (from picker, drop, or input).
 * HTML files are converted to Markdown; everything else is treated as Markdown.
 * @param {File} file
 * @param {FileSystemFileHandle|null} [handle]
 */
async function loadFile(file, handle = null) {
  const name = file.name || 'untitled.md';
  const isHtml = /\.html?$/i.test(name) || file.type === 'text/html';
  try {
    const text = await readFileAsText(file);
    if (isHtml) {
      const md = await htmlToMarkdown(text);
      setContent(md, name.replace(/\.html?$/i, '.md'), null);
      showToast('HTML converted to Markdown.', 'success');
    } else {
      setContent(text, name, handle);
      showToast(`Opened ${name}`, 'success');
    }
  } catch (err) {
    console.error('md-viewer: failed to read file', err);
    showToast('Could not read that file.', 'error');
  }
}

async function htmlToMarkdown(html) {
  const turndown = await ensureTurndown();
  await ensureRenderer(); // for DOMPurify
  // Sanitize first so no scripts/styles from imported HTML survive
  const clean = window.DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'script'] });
  return turndown.turndown(clean);
}

// ─── Open / save (File System Access API with fallbacks) ─────────────────────

const MD_PICKER_TYPES = [{
  description: 'Markdown / text',
  accept: { 'text/markdown': ['.md', '.markdown'], 'text/plain': ['.txt'] },
}];

async function openViaPicker() {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({ types: MD_PICKER_TYPES, multiple: false });
      const file = await handle.getFile();
      await loadFile(file, handle);
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return; // user cancelled
      // fall through to input fallback on any other failure
    }
  }
  fileInput.click();
}

async function saveFile() {
  if (!editor.value.trim()) {
    showToast('Nothing to save yet.', 'info');
    return;
  }
  if (state.fileHandle) {
    try {
      const writable = await state.fileHandle.createWritable();
      await writable.write(editor.value);
      await writable.close();
      setDirty(false);
      showToast(`Saved ${state.fileName}`, 'success');
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      console.warn('md-viewer: direct save failed, falling back', err);
    }
  }
  await saveFileAs();
}

async function saveFileAs() {
  if (!editor.value.trim()) {
    showToast('Nothing to save yet.', 'info');
    return;
  }
  const suggested = /\.(md|markdown)$/i.test(state.fileName) ? state.fileName : baseName() + '.md';
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: suggested, types: MD_PICKER_TYPES });
      const writable = await handle.createWritable();
      await writable.write(editor.value);
      await writable.close();
      state.fileHandle = handle;
      state.fileName = handle.name || suggested;
      setDirty(false);
      updateStats();
      showToast(`Saved ${state.fileName}`, 'success');
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      console.warn('md-viewer: save picker failed, falling back', err);
    }
  }
  downloadBlob(new Blob([editor.value], { type: 'text/markdown' }), suggested);
  setDirty(false);
  showToast(`Downloaded ${suggested}`, 'success');
}

// ─── Exports ──────────────────────────────────────────────────────────────────

/** Minimal, readable inline CSS for standalone HTML / PDF / print exports. */
const STANDALONE_CSS = `
  body { margin: 0 auto; max-width: 760px; padding: 40px 24px; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 16px; line-height: 1.7; color: #1c1c1a; background: #fff; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.4em 0 .5em; }
  h1 { font-size: 1.8em; border-bottom: 1px solid #e4e4e2; padding-bottom: .3em; }
  h2 { font-size: 1.4em; border-bottom: 1px solid #e4e4e2; padding-bottom: .3em; }
  a { color: #1b4fd8; }
  code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: .88em; background: #f4f4f3; border-radius: 3px; padding: .15em .4em; }
  pre { background: #f4f4f3; border: 1px solid #e4e4e2; border-radius: 6px; padding: 14px 16px; overflow-x: auto; }
  pre code { background: none; padding: 0; display: block; }
  blockquote { border-left: 3px solid #ccccca; margin: 0 0 1em; padding: .4em 1em; color: #5a5956; background: #f9f9f8; }
  table { border-collapse: collapse; margin-bottom: 1em; }
  th, td { border: 1px solid #e4e4e2; padding: 6px 12px; text-align: left; }
  th { background: #f4f4f3; }
  img { max-width: 100%; }
  hr { border: none; border-top: 1px solid #e4e4e2; margin: 1.6em 0; }
  input[type=checkbox] { margin-right: .5em; }
`;

async function getRenderedHtml() {
  if (!editor.value.trim()) return '';
  await ensureRenderer();
  return window.DOMPurify.sanitize(window.marked.parse(editor.value));
}

function buildHtmlDocument(bodyHtml, { standalone }) {
  const title = baseName();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title.replace(/</g, '&lt;')}</title>
${standalone ? `<style>${STANDALONE_CSS}</style>` : ''}
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

async function exportHtml(standalone) {
  const html = await getRenderedHtml();
  if (!html) { showToast('Nothing to export yet.', 'info'); return; }
  const doc = buildHtmlDocument(html, { standalone });
  downloadBlob(new Blob([doc], { type: 'text/html' }), `${baseName()}.html`);
  showToast(standalone ? 'Standalone HTML exported.' : 'HTML exported.', 'success');
}

async function exportPlainText() {
  const html = await getRenderedHtml();
  if (!html) { showToast('Nothing to export yet.', 'info'); return; }
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  downloadBlob(new Blob([tmp.textContent || ''], { type: 'text/plain' }), `${baseName()}.txt`);
  showToast('Plain text exported.', 'success');
}

async function exportPdf() {
  const html = await getRenderedHtml();
  if (!html) { showToast('Nothing to export yet.', 'info'); return; }

  let clip = null;
  try {
    await Promise.all([loadScript(CDN.html2canvas), loadScript(CDN.jspdf)]);

    // Render in a light-themed wrapper so the PDF is always black-on-white
    // regardless of the app theme (tokens resolve locally on the wrapper).
    // The wrapper stays in normal document flow inside a zero-height clipping
    // parent — html2canvas renders absolutely-positioned or off-screen
    // elements as blank.
    clip = document.createElement('div');
    clip.style.cssText = 'height:0;overflow:hidden;';
    const wrap = document.createElement('div');
    wrap.className = 'md-preview';
    wrap.style.cssText = [
      'width:730px', 'background:#fff', 'color:#1c1c1a', 'padding:24px',
      '--bg:#F9F9F8', '--surface:#FFFFFF', '--surface-hover:#F4F4F3',
      '--surface-active:#EEEEED', '--border:#E4E4E2', '--border-strong:#CCCCCA',
      '--text:#1C1C1A', '--text-2:#5A5956', '--text-3:#9A9896', '--accent:#1B4FD8',
    ].join(';');
    wrap.innerHTML = html;
    clip.appendChild(wrap);
    document.body.appendChild(clip);
    await new Promise(r => requestAnimationFrame(r));

    const canvas = await window.html2canvas(wrap, {
      scale: 2,
      backgroundColor: '#ffffff',
      useCORS: true,
      logging: false,
    });
    clip.remove();
    clip = null;
    if (!canvas.width || !canvas.height) throw new Error('Rendering produced an empty canvas');

    // Slice the tall canvas into A4 pages
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const margin = 10;
    const pageWmm = 210 - margin * 2;
    const pageHmm = 297 - margin * 2;
    const pxPerMm = canvas.width / pageWmm;
    const pageHpx = Math.floor(pageHmm * pxPerMm);

    const slice = document.createElement('canvas');
    slice.width = canvas.width;
    const sctx = slice.getContext('2d');

    let y = 0;
    let first = true;
    while (y < canvas.height) {
      const h = Math.min(pageHpx, canvas.height - y);
      slice.height = h;
      sctx.fillStyle = '#ffffff';
      sctx.fillRect(0, 0, slice.width, h);
      sctx.drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
      if (!first) pdf.addPage();
      pdf.addImage(slice.toDataURL('image/jpeg', 0.92), 'JPEG', margin, margin, pageWmm, h / pxPerMm);
      first = false;
      y += h;
    }

    const blob = pdf.output('blob');
    // A structurally empty PDF is ~1 KB — treat that as failure
    if (!blob || blob.size < 2000) {
      throw new Error(`PDF generation produced an empty document (${blob ? blob.size : 0} bytes)`);
    }
    window.__mdvLastPdfSize = blob.size; // debug/testing hook

    downloadBlob(blob, `${baseName()}.pdf`);
    showToast('PDF exported.', 'success');
  } catch (err) {
    if (clip) clip.remove();
    console.warn('md-viewer: PDF generation failed, using print fallback', err);
    printFallback(html);
  }
}

/** Open a print-friendly window and trigger the browser print dialog. */
function printFallback(html) {
  const doc = buildHtmlDocument(html, { standalone: true });
  const win = window.open('', '_blank');
  if (!win) {
    showToast('Please allow pop-ups to use the print fallback.', 'warning');
    return;
  }
  win.document.write(doc);
  win.document.close();
  win.addEventListener('load', () => win.print());
  showToast('Use your browser dialog to save as PDF.', 'info', 6000);
}

async function copyToClipboard(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`${label} copied to clipboard.`, 'success');
  } catch {
    showToast('Clipboard access was blocked by the browser.', 'error');
  }
}

// ─── Sample document ──────────────────────────────────────────────────────────

const SAMPLE_MD = `# Welcome to MD Viewer Online

Open, view, **edit**, and convert \`.md\` Markdown files — right in your browser.

## Why this sample?

It shows everything the viewer can render:

- GitHub-flavored Markdown
- *Italics*, **bold**, ~~strikethrough~~ and [links](https://files-online.com)
- Inline \`code\` and fenced blocks

### Task list

- [x] Open a Markdown file
- [x] View the live preview
- [ ] Export it as PDF

### Table

| Feature | Works offline | Private |
| ------- | :-----------: | :-----: |
| Viewer  | ✅            | ✅      |
| Editor  | ✅            | ✅      |
| PDF export | ✅         | ✅      |

### Code

\`\`\`js
function greet(name) {
  // Everything runs locally — nothing is uploaded
  return \`Hello, \${name}!\`;
}
\`\`\`

> **Tip:** Press \`Ctrl+S\` (or \`⌘S\`) to save your edits back to a .md file.

---

Made with Markdown. Edit me!
`;

// ─── Paste / import modal ─────────────────────────────────────────────────────

function openPasteModal() {
  pasteModal.hidden = false;
  pasteTextarea.focus();
}

function closePasteModal() {
  pasteModal.hidden = true;
  pasteTextarea.value = '';
  $('#mdv-url-input').value = '';
}

// ─── Drag & drop ──────────────────────────────────────────────────────────────

function setupDragDrop() {
  const dropzone = $('#mdv-dropzone');

  ['dragenter', 'dragover'].forEach(evt => {
    document.addEventListener(evt, e => {
      if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      dropzone.classList.add('drag-over');
    });
  });

  ['dragleave', 'drop'].forEach(evt => {
    document.addEventListener(evt, e => {
      if (evt === 'dragleave' && e.relatedTarget) return;
      dropzone.classList.remove('drag-over');
    });
  });

  document.addEventListener('drop', async e => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    const item = e.dataTransfer.items && e.dataTransfer.items[0];
    const file = e.dataTransfer.files[0];

    // Try to keep a writable handle so Ctrl+S saves back to the same file
    let handle = null;
    if (item && typeof item.getAsFileSystemHandle === 'function' && /\.(md|markdown|txt)$/i.test(file.name)) {
      try {
        const h = await item.getAsFileSystemHandle();
        if (h && h.kind === 'file') handle = h;
      } catch { /* permission denied — plain read still works */ }
    }
    await loadFile(file, handle);
  });
}

// ─── View modes ───────────────────────────────────────────────────────────────

function setView(view) {
  state.view = view;
  panes.dataset.view = view;
  document.querySelectorAll('[data-mdv-view]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mdvView === view);
  });
  if (view === 'raw') rawCode.textContent = state.lastHtml;
}

// ─── Wiring ───────────────────────────────────────────────────────────────────

function bindEvents() {
  // Editor input
  editor.addEventListener('input', () => {
    setDirty(true);
    renderDebounced();
  });

  // Open buttons (hero, header, toolbar, dropzone)
  ['#mdv-choose-btn', '#mdv-hero-open-2', '#mdv-open-btn'].forEach(sel => {
    const el = $(sel);
    if (el) el.addEventListener('click', e => { e.stopPropagation(); openViaPicker(); });
  });
  const dropzone = $('#mdv-dropzone');
  dropzone.addEventListener('click', () => openViaPicker());
  dropzone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openViaPicker(); }
  });

  // Fallback file inputs
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) loadFile(fileInput.files[0]);
    fileInput.value = '';
  });
  htmlInput.addEventListener('change', () => {
    if (htmlInput.files.length) loadFile(htmlInput.files[0]);
    htmlInput.value = '';
  });

  // Toolbar
  $('#mdv-save-btn').addEventListener('click', saveFile);
  $('#mdv-saveas-btn').addEventListener('click', saveFileAs);
  $('#mdv-import-html-btn').addEventListener('click', () => htmlInput.click());
  $('#mdv-export-pdf-btn').addEventListener('click', exportPdf);
  $('#mdv-export-html-btn').addEventListener('click', () => exportHtml(false));
  $('#mdv-export-standalone-btn').addEventListener('click', () => exportHtml(true));
  $('#mdv-export-txt-btn').addEventListener('click', exportPlainText);
  $('#mdv-copy-md-btn').addEventListener('click', () => {
    if (!editor.value.trim()) { showToast('Nothing to copy yet.', 'info'); return; }
    copyToClipboard(editor.value, 'Markdown');
  });
  $('#mdv-copy-html-btn').addEventListener('click', async () => {
    const html = await getRenderedHtml();
    if (!html) { showToast('Nothing to copy yet.', 'info'); return; }
    copyToClipboard(html, 'HTML');
  });
  $('#mdv-clear-btn').addEventListener('click', () => {
    if (editor.value && !confirm('Clear the editor? Unsaved changes will be lost.')) return;
    setContent('', 'untitled.md');
  });

  // View toggles
  document.querySelectorAll('[data-mdv-view]').forEach(btn => {
    btn.addEventListener('click', () => setView(btn.dataset.mdvView));
  });

  // Paste modal
  $('#mdv-paste-btn').addEventListener('click', e => { e.stopPropagation(); openPasteModal(); });
  $('#mdv-paste-md-btn').addEventListener('click', () => {
    const text = pasteTextarea.value;
    if (!text.trim()) { showToast('Paste some content first.', 'info'); return; }
    setContent(text, 'pasted.md');
    closePasteModal();
    showToast('Markdown loaded.', 'success');
  });
  $('#mdv-paste-html-btn').addEventListener('click', async () => {
    const text = pasteTextarea.value;
    if (!text.trim()) { showToast('Paste some HTML first.', 'info'); return; }
    try {
      const md = await htmlToMarkdown(text);
      setContent(md, 'converted.md');
      closePasteModal();
      showToast('HTML converted to Markdown.', 'success');
    } catch (err) {
      console.error('md-viewer: HTML conversion failed', err);
      showToast('Could not convert that HTML.', 'error');
    }
  });
  $('#mdv-url-fetch-btn').addEventListener('click', async () => {
    const url = $('#mdv-url-input').value.trim();
    if (!url) { showToast('Enter a URL first.', 'info'); return; }
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const type = (res.headers.get('content-type') || '').toLowerCase();
      const text = await res.text();
      if (type.includes('html') || /^\s*</.test(text)) {
        const md = await htmlToMarkdown(text);
        setContent(md, 'imported.md');
      } else {
        setContent(text, url.split('/').pop() || 'imported.md');
      }
      closePasteModal();
      showToast('Imported from URL.', 'success');
    } catch (err) {
      console.warn('md-viewer: URL import failed', err);
      showToast('URL import failed — the source may not allow browser CORS.', 'error', 6000);
    }
  });

  // Modal close (buttons + overlay click)
  pasteModal.addEventListener('click', e => {
    if (e.target === pasteModal || e.target.closest('.modal-close')) closePasteModal();
  });

  // Sample
  $('#mdv-sample-btn').addEventListener('click', e => {
    e.stopPropagation();
    setContent(SAMPLE_MD, 'sample.md');
    showToast('Sample loaded — edit away!', 'success');
  });

  // Converter cards
  document.querySelectorAll('[data-mdv-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.mdvAction;
      if (action === 'pdf') {
        if (!editor.value.trim()) {
          document.getElementById('open').scrollIntoView({ behavior: 'smooth' });
          showToast('Open a Markdown file first, then export as PDF.', 'info');
        } else exportPdf();
      } else if (action === 'html') {
        if (!editor.value.trim()) {
          document.getElementById('open').scrollIntoView({ behavior: 'smooth' });
          showToast('Open a Markdown file first, then export as HTML.', 'info');
        } else exportHtml(false);
      } else if (action === 'html2md') {
        openPasteModal();
      }
    });
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) {
      if (e.key === 'Escape' && !pasteModal.hidden) closePasteModal();
      return;
    }
    const key = e.key.toLowerCase();
    if (key === 'o') { e.preventDefault(); openViaPicker(); }
    else if (key === 's') { e.preventDefault(); saveFile(); }
    else if (key === 'e') { e.preventDefault(); exportHtml(false); }
    else if (key === 'p') { e.preventDefault(); exportPdf(); }
  });

  // Warn about unsaved changes
  window.addEventListener('beforeunload', e => {
    if (state.dirty && editor.value.trim()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  initTheme();
  bindEvents();
  setupDragDrop();
  setView('split');
  updateStats();
  console.info('MD Viewer Online: ready');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
