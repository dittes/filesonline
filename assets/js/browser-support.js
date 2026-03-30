// Detects browser capabilities and populates state.browserSupport

import { state } from './state.js';

// ─── Individual capability checks ────────────────────────────────────────────

/** @type {boolean} */
export const hasFileSystemAccessAPI = 'showOpenFilePicker' in window;

/** @type {boolean} */
export const hasDirectoryPicker = 'showDirectoryPicker' in window;

/** @type {boolean} */
export const hasSaveFilePicker = 'showSaveFilePicker' in window;

/** @type {boolean} */
export const hasOPFS = (
  'storage' in navigator &&
  typeof navigator.storage === 'object' &&
  navigator.storage !== null &&
  'getDirectory' in navigator.storage
);

/** @type {boolean} */
export const hasWorkers = typeof Worker !== 'undefined';

/** @type {boolean} */
export const hasWebAssembly = typeof WebAssembly !== 'undefined';

/** @type {boolean} */
export const hasCompressionStreams = 'CompressionStream' in window;

/** @type {boolean} */
export const hasIndexedDB = 'indexedDB' in window;

/** @type {boolean} */
export const hasClipboardRead = (
  typeof navigator !== 'undefined' &&
  !!navigator.clipboard &&
  'read' in navigator.clipboard
);

/** @type {boolean} */
export const hasSharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';

// ─── Cached result ────────────────────────────────────────────────────────────

/** @type {Object|null} */
let _cachedCapabilities = null;

// ─── Browser name detection ───────────────────────────────────────────────────

/**
 * Detect the browser name using feature detection rather than UA strings.
 * Falls back to UA string only for final disambiguation where features overlap.
 * @returns {'chrome'|'firefox'|'safari'|'edge'|'other'}
 */
export function getBrowserName() {
  // Edge: has window.chrome AND userAgentData with 'Microsoft Edge'
  if (
    typeof navigator !== 'undefined' &&
    navigator.userAgentData &&
    Array.isArray(navigator.userAgentData.brands)
  ) {
    const brands = navigator.userAgentData.brands.map(b => b.brand.toLowerCase());
    if (brands.some(b => b.includes('microsoft edge'))) return 'edge';
    if (brands.some(b => b.includes('chromium') || b.includes('chrome'))) return 'chrome';
  }

  // Firefox: has InstallTrigger or 'MozAppearance' in CSS
  if (typeof InstallTrigger !== 'undefined') return 'firefox';
  if (
    typeof document !== 'undefined' &&
    typeof document.documentElement !== 'undefined' &&
    typeof document.documentElement.style.MozAppearance !== 'undefined' // legacy
  ) return 'firefox';

  // Safari: has window.safari or ApplePaySession but NOT window.chrome
  if (
    typeof window !== 'undefined' &&
    (typeof window.safari !== 'undefined' || typeof window.ApplePaySession !== 'undefined') &&
    !('chrome' in window)
  ) return 'safari';

  // Chrome: has window.chrome
  if (typeof window !== 'undefined' && 'chrome' in window && !!window.chrome) return 'chrome';

  // Last resort UA substring (only if all feature detection fails)
  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('edg/')) return 'edge';
    if (ua.includes('firefox/')) return 'firefox';
    if (ua.includes('safari/') && !ua.includes('chrome/')) return 'safari';
    if (ua.includes('chrome/')) return 'chrome';
  }

  return 'other';
}

// ─── Support level ────────────────────────────────────────────────────────────

/**
 * Determine the overall support level for the current browser.
 * @returns {'full'|'partial'|'limited'}
 */
export function getSupportLevel() {
  if (
    hasFileSystemAccessAPI &&
    hasDirectoryPicker &&
    hasSaveFilePicker &&
    hasWebAssembly &&
    hasIndexedDB &&
    hasWorkers
  ) {
    return 'full';
  }

  if (hasWebAssembly && hasIndexedDB) {
    return 'partial';
  }

  return 'limited';
}

// ─── Main detection function ──────────────────────────────────────────────────

/**
 * Run all capability checks and return an object.
 * Also stores the result in state.browserSupport.
 * @returns {Object}
 */
export function detectCapabilities() {
  const capabilities = {
    hasFileSystemAccessAPI,
    hasDirectoryPicker,
    hasSaveFilePicker,
    hasOPFS,
    hasWorkers,
    hasWebAssembly,
    hasCompressionStreams,
    hasIndexedDB,
    hasClipboardRead,
    hasSharedArrayBuffer,
    browserName: getBrowserName(),
    supportLevel: getSupportLevel(),
  };

  _cachedCapabilities = capabilities;

  // Populate global state
  if (state && typeof state === 'object') {
    state.browserSupport = capabilities;
  }

  return capabilities;
}

/**
 * Return cached capabilities, running detection on first call.
 * @returns {Object}
 */
export function getCapabilities() {
  if (!_cachedCapabilities) {
    return detectCapabilities();
  }
  return _cachedCapabilities;
}

// ─── Support panel renderer ───────────────────────────────────────────────────

/**
 * Render a browser support table into containerEl.
 * @param {HTMLElement} containerEl
 */
export function renderSupportPanel(containerEl) {
  if (!containerEl) return;

  const caps = getCapabilities();
  const browser = caps.browserName;

  /**
   * Return a status badge HTML string.
   * @param {boolean|'partial'|'limited'|string} val
   * @param {boolean} [highlight]  true if this column is the current browser
   */
  function badge(val, highlight) {
    let cls, label;
    if (val === true) { cls = 'support-yes'; label = 'Yes'; }
    else if (val === false) { cls = 'support-no'; label = 'No'; }
    else if (val === 'partial') { cls = 'support-partial'; label = 'Partial'; }
    else if (val === 'limited') { cls = 'support-limited'; label = 'Limited (fallback)'; }
    else { cls = 'support-partial'; label = String(val); }

    const currentClass = highlight ? ' current-browser' : '';
    return `<span class="support-badge ${cls}${currentClass}">${label}</span>`;
  }

  /**
   * Produce four badge strings [chrome, firefox, safari, edge] with the
   * current browser highlighted.
   */
  function badges(chrome, firefox, safari, edge) {
    return [
      badge(chrome, browser === 'chrome'),
      badge(firefox, browser === 'firefox'),
      badge(safari, browser === 'safari'),
      badge(edge, browser === 'edge'),
    ];
  }

  const features = [
    {
      label: 'File System Access (open/save directly)',
      desc: 'Open and save files without downloading',
      values: badges(
        caps.hasFileSystemAccessAPI,
        'limited',
        'limited',
        caps.hasFileSystemAccessAPI
      ),
    },
    {
      label: 'Folder / Directory Picker',
      desc: 'Select entire folders at once',
      values: badges(
        caps.hasDirectoryPicker,
        'partial',
        'partial',
        caps.hasDirectoryPicker
      ),
    },
    {
      label: 'Save File Directly to Disk',
      desc: 'Write back to original file location',
      values: badges(
        caps.hasSaveFilePicker,
        'limited',
        'limited',
        caps.hasSaveFilePicker
      ),
    },
    {
      label: 'Archive Extraction (ZIP, RAR, 7z)',
      desc: 'Requires WebAssembly support',
      values: badges(
        caps.hasWebAssembly,
        caps.hasWebAssembly,
        caps.hasWebAssembly,
        caps.hasWebAssembly
      ),
    },
    {
      label: 'PDF Preview',
      desc: 'Via PDF.js (no native dependency)',
      values: badges(true, true, true, true),
    },
    {
      label: 'Compression Streams API',
      desc: 'Native gzip/deflate in the browser',
      values: badges(
        caps.hasCompressionStreams,
        caps.hasCompressionStreams,
        caps.hasCompressionStreams,
        caps.hasCompressionStreams
      ),
    },
    {
      label: 'Origin Private File System (OPFS)',
      desc: 'Fast local storage for large files',
      values: badges(
        caps.hasOPFS,
        caps.hasOPFS,
        caps.hasOPFS,
        caps.hasOPFS
      ),
    },
    {
      label: 'IndexedDB Persistence',
      desc: 'Save recipes and settings locally',
      values: badges(
        caps.hasIndexedDB,
        caps.hasIndexedDB,
        caps.hasIndexedDB,
        caps.hasIndexedDB
      ),
    },
    {
      label: 'Clipboard Read Access',
      desc: 'Paste files from clipboard',
      values: badges(
        caps.hasClipboardRead,
        caps.hasClipboardRead,
        caps.hasClipboardRead,
        caps.hasClipboardRead
      ),
    },
    {
      label: 'Web Workers',
      desc: 'Background processing without UI freeze',
      values: badges(
        caps.hasWorkers,
        caps.hasWorkers,
        caps.hasWorkers,
        caps.hasWorkers
      ),
    },
  ];

  const levelLabels = { full: 'Full Support', partial: 'Partial Support', limited: 'Limited Support' };
  const levelClass = { full: 'level-full', partial: 'level-partial', limited: 'level-limited' };
  const level = caps.supportLevel;

  const currentBrowserLabel = {
    chrome: 'Chrome',
    firefox: 'Firefox',
    safari: 'Safari',
    edge: 'Edge',
    other: 'Your Browser',
  }[browser] || 'Your Browser';

  const rows = features.map(f => {
    const [c, ff, s, e] = f.values;
    return `
      <tr>
        <td class="feature-label">
          <strong>${f.label}</strong>
          <small>${f.desc}</small>
        </td>
        <td class="browser-col ${browser === 'chrome' ? 'current-col' : ''}">${c}</td>
        <td class="browser-col ${browser === 'firefox' ? 'current-col' : ''}">${ff}</td>
        <td class="browser-col ${browser === 'safari' ? 'current-col' : ''}">${s}</td>
        <td class="browser-col ${browser === 'edge' ? 'current-col' : ''}">${e}</td>
      </tr>`;
  }).join('');

  containerEl.innerHTML = `
    <div class="support-panel">
      <div class="support-header">
        <h3>Browser Compatibility</h3>
        <div class="support-level-badge ${levelClass[level] || ''}">
          ${levelLabels[level] || level} — ${currentBrowserLabel}
        </div>
      </div>
      <div class="support-table-wrapper">
        <table class="support-table">
          <thead>
            <tr>
              <th>Feature</th>
              <th class="${browser === 'chrome' ? 'current-col' : ''}">Chrome</th>
              <th class="${browser === 'firefox' ? 'current-col' : ''}">Firefox</th>
              <th class="${browser === 'safari' ? 'current-col' : ''}">Safari</th>
              <th class="${browser === 'edge' ? 'current-col' : ''}">Edge</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
      <p class="support-footnote">
        Highlighted column indicates your current browser.
        Features marked <em>Limited (fallback)</em> use file input or download workarounds.
      </p>
    </div>
  `;
}
