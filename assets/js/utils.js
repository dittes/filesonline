// Utility functions used across all modules

/**
 * Format a byte count into a human-readable string.
 * @param {number} bytes
 * @param {number} decimals
 * @returns {string} e.g. "1.20 MB"
 */
export function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 B';
  if (bytes < 0) return '—';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const index = Math.min(i, sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, index)).toFixed(dm)) + ' ' + sizes[index];
}

/**
 * Format a Date (or timestamp) into a locale string.
 * @param {Date|number|string} date
 * @returns {string} e.g. "Mar 30, 2026, 14:23"
 */
export function formatDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Extract the lowercase extension from a filename, without the leading dot.
 * @param {string} filename
 * @returns {string} e.g. "pdf"
 */
export function getExtension(filename) {
  if (!filename || typeof filename !== 'string') return '';
  const parts = filename.split('.');
  if (parts.length < 2) return '';
  return parts[parts.length - 1].toLowerCase().trim();
}

/**
 * Map a MIME type and/or extension to a broad category string.
 * @param {string} mimeType
 * @param {string} ext
 * @returns {string}
 */
export function getMimeCategory(mimeType, ext) {
  const mime = (mimeType || '').toLowerCase();
  const e = (ext || '').toLowerCase();

  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  if (
    mime === 'text/csv' ||
    e === 'csv' ||
    mime === 'application/vnd.ms-excel' ||
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    ['xls', 'xlsx', 'ods', 'numbers'].includes(e)
  ) return 'spreadsheet';
  if (
    mime === 'application/msword' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mime === 'application/vnd.oasis.opendocument.text' ||
    ['doc', 'docx', 'odt', 'rtf', 'pages'].includes(e)
  ) return 'document';
  if (
    mime === 'application/zip' ||
    mime === 'application/x-rar-compressed' ||
    mime === 'application/x-7z-compressed' ||
    mime === 'application/x-tar' ||
    mime === 'application/gzip' ||
    mime === 'application/x-bzip2' ||
    ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz'].includes(e)
  ) return 'archive';
  if (
    mime.startsWith('text/') ||
    ['txt', 'md', 'log', 'ini', 'cfg', 'conf', 'yaml', 'yml', 'toml'].includes(e)
  ) {
    const codeExts = ['js', 'ts', 'jsx', 'tsx', 'html', 'htm', 'css', 'scss', 'less',
      'py', 'rb', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'php',
      'sh', 'bash', 'zsh', 'fish', 'sql', 'json', 'xml', 'svg'];
    if (codeExts.includes(e) || mime === 'application/json' || mime === 'text/html' || mime === 'text/javascript') {
      return 'code';
    }
    return 'text';
  }
  if (
    mime === 'application/json' ||
    ['js', 'ts', 'jsx', 'tsx', 'html', 'htm', 'css', 'scss', 'less',
      'py', 'rb', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'php',
      'sh', 'bash', 'zsh', 'sql', 'xml', 'svg', 'json'].includes(e)
  ) return 'code';

  return 'binary';
}

/**
 * Generate a random 8-character hex string.
 * @returns {string}
 */
export function generateId() {
  const arr = new Uint8Array(4);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Debounce a function call.
 * @param {Function} fn
 * @param {number} ms
 * @returns {Function}
 */
export function debounce(fn, ms) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

/**
 * Escape HTML special characters.
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sanitize a filename to only allow safe characters.
 * @param {string} name
 * @returns {string}
 */
export function sanitizeFilename(name) {
  if (typeof name !== 'string') return '';
  return name
    .trim()
    .replace(/[^a-zA-Z0-9.\-_ ]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/\.{2,}/g, '.')
    .substring(0, 255);
}

/**
 * Convert an ArrayBuffer to a lowercase hex string (for SHA-256 digests).
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
export function bytesToHashHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Trigger a browser file download from a Blob.
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

/**
 * Read a File as a UTF-8 text string.
 * @param {File} file
 * @returns {Promise<string>}
 */
export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('Failed to read file as text'));
    reader.readAsText(file);
  });
}

/**
 * Read a File as an ArrayBuffer.
 * @param {File} file
 * @returns {Promise<ArrayBuffer>}
 */
export function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('Failed to read file as ArrayBuffer'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Read a File as a data URL string.
 * @param {File} file
 * @returns {Promise<string>}
 */
export function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('Failed to read file as data URL'));
    reader.readAsDataURL(file);
  });
}

/**
 * Return a Promise that resolves after a given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Clamp a number between min and max.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Truncate a string in the middle, preserving the start and extension.
 * e.g. "very-long-filename.pdf" -> "very-long...pdf" when maxLen is small.
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
export function truncateMiddle(str, maxLen) {
  if (typeof str !== 'string') return '';
  if (str.length <= maxLen) return str;
  const dotIndex = str.lastIndexOf('.');
  const ext = dotIndex > 0 ? str.slice(dotIndex) : '';
  const base = dotIndex > 0 ? str.slice(0, dotIndex) : str;
  const ellipsis = '...';
  const available = maxLen - ellipsis.length - ext.length;
  if (available <= 0) return str.slice(0, maxLen - ellipsis.length) + ellipsis;
  const keepStart = Math.ceil(available * 0.6);
  const keepEnd = Math.floor(available * 0.4);
  if (keepEnd <= 0) {
    return base.slice(0, keepStart) + ellipsis + ext;
  }
  return base.slice(0, keepStart) + ellipsis + base.slice(base.length - keepEnd) + ext;
}

/**
 * Return a pluralized string based on count.
 * @param {number} count
 * @param {string} singular
 * @param {string} [plural]
 * @returns {string} e.g. "1 file" or "5 files"
 */
export function pluralize(count, singular, plural) {
  const word = count === 1 ? singular : (plural !== undefined ? plural : singular + 's');
  return `${count} ${word}`;
}

/**
 * Return an inline SVG string for a given file extension.
 * @param {string} ext  lowercase extension without dot, or 'folder'
 * @returns {string}    SVG markup string
 */
export function getFileTypeIcon(ext) {
  const e = (ext || '').toLowerCase().trim();

  const icons = {
    folder: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 4a1 1 0 011-1h4l1 1h5a1 1 0 011 1v7a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" fill="currentColor"/></svg>`,

    image: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="2" width="12" height="12" rx="1" stroke="currentColor" stroke-width="1.5"/><circle cx="5.5" cy="5.5" r="1" fill="currentColor"/><path d="M2 10l3-3 2 2 3-4 4 5H2z" fill="currentColor" opacity=".7"/></svg>`,

    video: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="3" width="9" height="10" rx="1" stroke="currentColor" stroke-width="1.5"/><path d="M11 6l3-2v8l-3-2V6z" fill="currentColor"/></svg>`,

    audio: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>`,

    pdf: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 2H4a1 1 0 00-1 1v10a1 1 0 001 1h8a1 1 0 001-1V6L9 2z" stroke="currentColor" stroke-width="1.5"/><path d="M9 2v4h4" stroke="currentColor" stroke-width="1.5"/><path d="M5 9h6M5 11h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`,

    spreadsheet: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="2" width="12" height="12" rx="1" stroke="currentColor" stroke-width="1.5"/><path d="M2 6h12M2 10h12M7 2v12" stroke="currentColor" stroke-width="1.2"/></svg>`,

    document: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 2H4a1 1 0 00-1 1v10a1 1 0 001 1h8a1 1 0 001-1V6L9 2z" stroke="currentColor" stroke-width="1.5"/><path d="M9 2v4h4" stroke="currentColor" stroke-width="1.5"/><path d="M5 8h6M5 10h6M5 12h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`,

    code: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 4L1 8l4 4M11 4l4 4-4 4M9 3l-2 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,

    archive: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="5" width="12" height="9" rx="1" stroke="currentColor" stroke-width="1.5"/><path d="M1 5h14" stroke="currentColor" stroke-width="1.5"/><rect x="1" y="2" width="14" height="3" rx=".5" stroke="currentColor" stroke-width="1.5"/><path d="M6 8h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,

    text: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 4h10M3 7h10M3 10h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,

    binary: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 4h2v8H4zM10 4h2v8h-2zM6 7h4M7 4h2M7 12h2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  };

  // Images
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'ico', 'tiff', 'tif', 'avif', 'heic', 'svg'].includes(e)) return icons.image;
  // Video
  if (['mp4', 'webm', 'ogg', 'ogv', 'mov', 'avi', 'mkv', 'flv', 'wmv', 'm4v'].includes(e)) return icons.video;
  // Audio
  if (['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'oga', 'opus', 'wma', 'aiff'].includes(e)) return icons.audio;
  // PDF
  if (e === 'pdf') return icons.pdf;
  // Spreadsheets
  if (['xls', 'xlsx', 'ods', 'numbers', 'csv'].includes(e)) return icons.spreadsheet;
  // Documents
  if (['doc', 'docx', 'odt', 'rtf', 'pages'].includes(e)) return icons.document;
  // Archives
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'tar.gz', 'tar.bz2'].includes(e)) return icons.archive;
  // Code / markup
  if (['js', 'ts', 'jsx', 'tsx', 'html', 'htm', 'css', 'scss', 'less', 'sass',
       'py', 'rb', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'php',
       'sh', 'bash', 'zsh', 'fish', 'sql', 'xml', 'json', 'yaml', 'yml',
       'toml', 'ini', 'cfg', 'conf', 'lua', 'swift', 'kt', 'vue', 'svelte'].includes(e)) return icons.code;
  // Plain text
  if (['txt', 'md', 'markdown', 'log', 'nfo', 'readme'].includes(e)) return icons.text;
  // Folder (explicit)
  if (e === 'folder') return icons.folder;

  return icons.binary;
}
