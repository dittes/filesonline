// General export utilities for downloading processed results

import { downloadBlob } from './utils.js';
import { showToast } from './ui.js';

// ─── zip.js loader ────────────────────────────────────────────────────────────

let _zipLib = null;

async function getZipLib() {
  if (_zipLib) return _zipLib;
  try {
    _zipLib = await import('https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.7.52/dist/zip.min.js');
    return _zipLib;
  } catch {
    throw new Error('zip.js could not be loaded. Check your internet connection.');
  }
}

// ─── CSV generation ───────────────────────────────────────────────────────────

/**
 * Generate an RFC 4180 compliant CSV string.
 * Fields containing commas, quotes, or newlines are quoted.
 * Quotes within field values are escaped by doubling them.
 * Includes a UTF-8 BOM for Excel compatibility.
 *
 * @param {string[]} headers
 * @param {(string|number|boolean|null|undefined)[][]} rows
 * @returns {string}  CSV string (without BOM — BOM is added by exportAsCSV)
 */
export function generateCSV(headers, rows) {
  function quoteField(value) {
    const str = value === null || value === undefined ? '' : String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  const lines = [
    headers.map(quoteField).join(','),
    ...rows.map(row => row.map(quoteField).join(',')),
  ];

  return lines.join('\r\n');
}

// ─── Download link helper ─────────────────────────────────────────────────────

/**
 * Create a temporary <a> element pointing to a Blob download.
 * The element is not appended to the DOM; caller is responsible for triggering.
 * @param {Blob} blob
 * @param {string} filename
 * @returns {HTMLAnchorElement}
 */
export function generateDownloadLink(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.style.display = 'none';
  // Revoke after a short delay to allow the download to begin
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return a;
}

// ─── File Picker / download fallback ──────────────────────────────────────────

/**
 * Offer a Blob for saving. Uses the File System Access API showSaveFilePicker
 * if available; falls back to a programmatic download link.
 *
 * @param {Blob} blob
 * @param {string} suggestedName
 * @param {string} mimeType   e.g. "application/zip"
 * @returns {Promise<boolean>}  true if saved via picker, false if used download fallback
 */
export async function saveWithFilePicker(blob, suggestedName, mimeType) {
  if (typeof window.showSaveFilePicker === 'function') {
    const ext = suggestedName.includes('.') ? '.' + suggestedName.split('.').pop() : '';
    const description = ext
      ? `${ext.slice(1).toUpperCase()} file`
      : 'File';
    const accept = mimeType
      ? { [mimeType]: ext ? [ext] : [] }
      : { 'application/octet-stream': [] };

    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description, accept }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (err) {
      // AbortError = user dismissed — fall through to download
      if (err.name !== 'AbortError') {
        console.warn('showSaveFilePicker error, falling back:', err);
      }
    }
  }

  // Fallback
  downloadBlob(blob, suggestedName);
  return false;
}

// ─── CSV export ───────────────────────────────────────────────────────────────

/**
 * Generate a CSV and trigger a download.
 * @param {string[]} headers
 * @param {(string|number|boolean|null|undefined)[][]} rows
 * @param {string} filename
 */
export function exportAsCSV(headers, rows, filename) {
  const csv  = generateCSV(headers, rows);
  // Prepend BOM for Excel compatibility
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, filename.endsWith('.csv') ? filename : filename + '.csv');
}

// ─── JSON export ──────────────────────────────────────────────────────────────

/**
 * Serialize data to JSON and trigger a download.
 * @param {*} data
 * @param {string} filename
 */
export function exportAsJSON(data, filename) {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8;' });
  downloadBlob(blob, filename.endsWith('.json') ? filename : filename + '.json');
}

// ─── Clipboard ────────────────────────────────────────────────────────────────

/**
 * Copy text to the clipboard using the Clipboard API.
 * Falls back to execCommand for older browsers.
 * @param {string} text
 * @returns {Promise<boolean>}  true on success
 */
export async function copyToClipboard(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to execCommand
    }
  }

  // Legacy execCommand fallback
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity  = '0';
    textarea.style.top      = '0';
    textarea.style.left     = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

// ─── ZIP export of FileEntry array ───────────────────────────────────────────

/**
 * Bundle an array of FileEntry objects into a ZIP and trigger a download.
 * Shows progress toasts. Returns a Promise that resolves once the download is triggered.
 *
 * @param {import('./state.js').FileEntry[]} fileEntries
 * @param {string} zipName   desired filename for the ZIP, e.g. "my-files.zip"
 * @returns {Promise<void>}
 */
export async function exportFilesAsZip(fileEntries, zipName) {
  if (!fileEntries || fileEntries.length === 0) {
    showToast('No files to export.', 'warning');
    return;
  }

  const name = zipName
    ? (zipName.endsWith('.zip') ? zipName : zipName + '.zip')
    : 'export.zip';

  showToast(`Creating ZIP with ${fileEntries.length} file${fileEntries.length !== 1 ? 's' : ''}…`, 'info');

  const { BlobWriter, BlobReader, ZipWriter } = await getZipLib();

  const blobWriter = new BlobWriter('application/zip');
  const zipWriter  = new ZipWriter(blobWriter);

  for (const entry of fileEntries) {
    const path = entry.relativePath || entry.name;
    await zipWriter.add(path, new BlobReader(entry.file));
  }

  await zipWriter.close();
  const blob = await blobWriter.getData();

  downloadBlob(blob, name);
  showToast(`ZIP downloaded: ${name}`, 'success');
}
