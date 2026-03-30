// Batch rename module with rule-based renaming and live preview
// All renaming is virtual — produces new names; "apply" means downloadable renamed files

import { debounce, escapeHtml, generateId, formatBytes, downloadBlob, pluralize } from './utils.js';
import { state, on } from './state.js';
import { $, $$, showToast, showConfirm } from './ui.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const RULE_TYPES = [
  { type: 'find-replace',  label: 'Find & Replace',     icon: '⇄' },
  { type: 'prefix',        label: 'Add Prefix',          icon: '←' },
  { type: 'suffix',        label: 'Add Suffix',          icon: '→' },
  { type: 'numbering',     label: 'Auto Numbering',      icon: '#' },
  { type: 'case',          label: 'Change Case',         icon: 'Aa' },
  { type: 'remove-chars',  label: 'Remove Characters',   icon: '✕' },
  { type: 'trim',          label: 'Trim Whitespace',     icon: '⇔' },
];

// ─── Rule application ─────────────────────────────────────────────────────────

/**
 * Apply a single rule to a name string (no extension).
 * @param {string} name
 * @param {Object} rule
 * @param {number} index  position of this file in the file list (for numbering)
 * @returns {string}
 */
export function applyRuleToName(name, rule, index = 0) {
  switch (rule.type) {
    case 'find-replace': {
      const { find = '', replace = '', caseSensitive = false, useRegex = false } = rule;
      if (!find) return name;
      try {
        const flags = caseSensitive ? 'g' : 'gi';
        const pattern = useRegex ? new RegExp(find, flags) : new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
        return name.replace(pattern, replace);
      } catch {
        return name;
      }
    }
    case 'prefix':
      return (rule.value || '') + name;
    case 'suffix':
      return name + (rule.value || '');
    case 'numbering': {
      const start = Number(rule.start ?? 1);
      const step  = Number(rule.step  ?? 1);
      const pad   = Number(rule.padding ?? 3);
      const sep   = rule.separator !== undefined ? rule.separator : '_';
      const pos   = rule.position || 'prefix';
      const num   = String(start + index * step).padStart(pad, '0');
      return pos === 'prefix' ? num + sep + name : name + sep + num;
    }
    case 'case': {
      switch (rule.transform) {
        case 'upper': return name.toUpperCase();
        case 'lower': return name.toLowerCase();
        case 'title': return name.replace(/\b\w/g, c => c.toUpperCase());
        case 'camel': {
          const words = name.split(/[\s_\-]+/);
          return words.map((w, i) => i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
        }
        default: return name;
      }
    }
    case 'remove-chars': {
      const chars = rule.chars || '';
      if (!chars) return name;
      const escaped = chars.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
      return name.replace(new RegExp(`[${escaped}]`, 'g'), '');
    }
    case 'trim':
      return name.trim();
    default:
      return name;
  }
}

/**
 * Apply all rules to a filename.
 * @param {string} filename     full filename including extension
 * @param {Object[]} rules
 * @param {{ preserveExt: boolean }} options
 * @param {number} index        position in file list (for numbering)
 * @returns {string}            new full filename
 */
export function applyRules(filename, rules, options = {}, index = 0) {
  const { preserveExt = true } = options;
  const dotIdx = filename.lastIndexOf('.');
  const hasExt = dotIdx > 0;
  let base = hasExt ? filename.slice(0, dotIdx) : filename;
  const ext  = hasExt ? filename.slice(dotIdx) : '';

  if (preserveExt) {
    for (const rule of rules) {
      base = applyRuleToName(base, rule, index);
    }
    return base + ext;
  } else {
    let full = filename;
    for (const rule of rules) {
      full = applyRuleToName(full, rule, index);
    }
    return full;
  }
}

/**
 * Generate a preview array for a set of files.
 * @param {import('./state.js').FileEntry[]} files
 * @param {Object[]} rules
 * @param {{ preserveExt: boolean }} options
 * @returns {{ original: string, newName: string, changed: boolean }[]}
 */
export function generatePreview(files, rules, options = {}) {
  return files.map((entry, index) => {
    const original = entry.name;
    const newName  = applyRules(original, rules, options, index);
    return { original, newName, changed: newName !== original };
  });
}

// ─── ZIP bundling ─────────────────────────────────────────────────────────────

/**
 * Bundle renamed files as a ZIP.
 * @param {import('./state.js').FileEntry[]} files
 * @param {{ original: string, newName: string }[]} renames
 * @returns {Promise<Blob>}
 */
export async function bundleRenamedFiles(files, renames) {
  let zipModule = null;
  try {
    zipModule = await import('https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.7.52/dist/zip.min.js');
  } catch {
    zipModule = null;
  }

  if (zipModule) {
    const { BlobWriter, BlobReader, ZipWriter } = zipModule;
    const blobWriter = new BlobWriter('application/zip');
    const zipWriter  = new ZipWriter(blobWriter);
    for (let i = 0; i < files.length; i++) {
      const entry   = files[i];
      const newName = renames[i] ? renames[i].newName : entry.name;
      await zipWriter.add(newName, new BlobReader(entry.file));
    }
    await zipWriter.close();
    return blobWriter.getData();
  }

  // Fallback: return null to signal individual downloads
  return null;
}

// ─── Module initialisation ───────────────────────────────────────────────────

/**
 * Render the complete rename UI into containerEl.
 * @param {HTMLElement} containerEl
 */
export function initRenameModule(containerEl) {
  // Module state
  let rules             = [];
  let scope             = 'selected';   // 'selected' | 'all'
  let preserveExt       = true;
  let lastAppliedMapping = null;        // { files, renames }

  // ── Render shell ──────────────────────────────────────────────────────────
  containerEl.innerHTML = `
    <div class="rename-module">
      <div class="rename-toolbar">
        <div class="rename-scope">
          <label class="rename-radio">
            <input type="radio" name="rename-scope" value="selected" checked> Apply to selected files
          </label>
          <label class="rename-radio">
            <input type="radio" name="rename-scope" value="all"> Apply to all files
          </label>
        </div>
        <label class="rename-ext-option">
          <input type="checkbox" id="rename-preserve-ext" checked>
          Preserve extension
        </label>
      </div>

      <div class="rename-rules-section">
        <div class="rename-rules-header">
          <span class="rename-rules-title">Rename Rules</span>
          <div class="rename-add-rule-wrap">
            <button class="btn btn-sm btn-secondary" id="rename-add-rule-btn">+ Add Rule</button>
            <div class="rename-rule-dropdown" id="rename-rule-dropdown" hidden>
              ${RULE_TYPES.map(rt => `<button class="rename-rule-option" data-type="${rt.type}">${rt.icon} ${rt.label}</button>`).join('')}
            </div>
          </div>
        </div>
        <div class="rename-rules-list" id="rename-rules-list">
          <p class="rename-no-rules">No rules yet. Add a rule to get started.</p>
        </div>
      </div>

      <div class="rename-preview-section">
        <div class="rename-preview-header">
          <span class="rename-preview-title">Live Preview</span>
          <span class="rename-preview-count" id="rename-preview-count"></span>
        </div>
        <div class="rename-preview-table-wrap">
          <table class="rename-preview-table" id="rename-preview-table">
            <thead>
              <tr>
                <th>Original</th>
                <th>New Name</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody id="rename-preview-tbody">
              <tr><td colspan="3" class="rename-empty-preview">No files loaded.</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="rename-actions">
        <button class="btn btn-primary" id="rename-apply-btn">Apply &amp; Download</button>
        <button class="btn btn-secondary" id="rename-export-csv-btn">Export Rename Plan</button>
        <button class="btn btn-ghost" id="rename-undo-btn" disabled>Undo Last Apply</button>
      </div>
    </div>
  `;

  // ── Element refs ──────────────────────────────────────────────────────────
  const rulesList     = containerEl.querySelector('#rename-rules-list');
  const addRuleBtn    = containerEl.querySelector('#rename-add-rule-btn');
  const dropdown      = containerEl.querySelector('#rename-rule-dropdown');
  const previewTbody  = containerEl.querySelector('#rename-preview-tbody');
  const previewCount  = containerEl.querySelector('#rename-preview-count');
  const applyBtn      = containerEl.querySelector('#rename-apply-btn');
  const exportBtn     = containerEl.querySelector('#rename-export-csv-btn');
  const undoBtn       = containerEl.querySelector('#rename-undo-btn');
  const extCheck      = containerEl.querySelector('#rename-preserve-ext');

  // ── Scope + ext change ────────────────────────────────────────────────────
  containerEl.querySelectorAll('input[name="rename-scope"]').forEach(radio => {
    radio.addEventListener('change', () => { scope = radio.value; schedulePreview(); });
  });
  extCheck.addEventListener('change', () => { preserveExt = extCheck.checked; schedulePreview(); });

  // ── Add rule dropdown ─────────────────────────────────────────────────────
  addRuleBtn.addEventListener('click', e => {
    e.stopPropagation();
    dropdown.hidden = !dropdown.hidden;
  });
  document.addEventListener('click', () => { dropdown.hidden = true; });

  dropdown.addEventListener('click', e => {
    const btn = e.target.closest('.rename-rule-option');
    if (!btn) return;
    dropdown.hidden = true;
    addRule(btn.dataset.type);
  });

  // ── Rule management ───────────────────────────────────────────────────────
  function addRule(type) {
    const defaults = {
      'find-replace':  { type: 'find-replace',  find: '', replace: '', caseSensitive: false, useRegex: false },
      'prefix':        { type: 'prefix',         value: '' },
      'suffix':        { type: 'suffix',         value: '' },
      'numbering':     { type: 'numbering',      start: 1, step: 1, padding: 3, position: 'prefix', separator: '_' },
      'case':          { type: 'case',           transform: 'lower' },
      'remove-chars':  { type: 'remove-chars',   chars: '' },
      'trim':          { type: 'trim' },
    };
    const rule = { ...defaults[type], id: generateId() };
    rules.push(rule);
    renderRules();
    schedulePreview();
  }

  function removeRule(id) {
    rules = rules.filter(r => r.id !== id);
    renderRules();
    schedulePreview();
  }

  function renderRules() {
    if (rules.length === 0) {
      rulesList.innerHTML = '<p class="rename-no-rules">No rules yet. Add a rule to get started.</p>';
      return;
    }
    rulesList.innerHTML = rules.map((rule, idx) => buildRuleHTML(rule, idx)).join('');
    attachRuleEvents();
    attachDragDrop();
  }

  function buildRuleHTML(rule, idx) {
    const meta = RULE_TYPES.find(rt => rt.type === rule.type) || { icon: '?', label: rule.type };
    let fields = '';

    switch (rule.type) {
      case 'find-replace':
        fields = `
          <label>Find <input class="rule-field" data-field="find" type="text" value="${escapeHtml(rule.find)}" placeholder="Text to find"></label>
          <label>Replace <input class="rule-field" data-field="replace" type="text" value="${escapeHtml(rule.replace)}" placeholder="Replace with"></label>
          <label class="rule-check"><input type="checkbox" class="rule-field" data-field="caseSensitive" ${rule.caseSensitive ? 'checked' : ''}> Case sensitive</label>
          <label class="rule-check"><input type="checkbox" class="rule-field" data-field="useRegex" ${rule.useRegex ? 'checked' : ''}> Use regex</label>`;
        break;
      case 'prefix':
        fields = `<label>Prefix <input class="rule-field" data-field="value" type="text" value="${escapeHtml(rule.value)}" placeholder="Text to prepend"></label>`;
        break;
      case 'suffix':
        fields = `<label>Suffix <input class="rule-field" data-field="value" type="text" value="${escapeHtml(rule.value)}" placeholder="Text to append"></label>`;
        break;
      case 'numbering':
        fields = `
          <label>Start <input class="rule-field" data-field="start" type="number" value="${rule.start}" min="0" style="width:5rem"></label>
          <label>Step <input class="rule-field" data-field="step" type="number" value="${rule.step}" min="1" style="width:5rem"></label>
          <label>Padding <input class="rule-field" data-field="padding" type="number" value="${rule.padding}" min="1" max="10" style="width:5rem"></label>
          <label>Separator <input class="rule-field" data-field="separator" type="text" value="${escapeHtml(rule.separator)}" style="width:4rem"></label>
          <label>Position
            <select class="rule-field" data-field="position">
              <option value="prefix" ${rule.position === 'prefix' ? 'selected' : ''}>Prefix</option>
              <option value="suffix" ${rule.position === 'suffix' ? 'selected' : ''}>Suffix</option>
            </select>
          </label>`;
        break;
      case 'case':
        fields = `
          <label>Transform
            <select class="rule-field" data-field="transform">
              <option value="lower" ${rule.transform === 'lower' ? 'selected' : ''}>lowercase</option>
              <option value="upper" ${rule.transform === 'upper' ? 'selected' : ''}>UPPERCASE</option>
              <option value="title" ${rule.transform === 'title' ? 'selected' : ''}>Title Case</option>
              <option value="camel" ${rule.transform === 'camel' ? 'selected' : ''}>camelCase</option>
            </select>
          </label>`;
        break;
      case 'remove-chars':
        fields = `<label>Characters to remove <input class="rule-field" data-field="chars" type="text" value="${escapeHtml(rule.chars)}" placeholder="e.g. _-()"></label>`;
        break;
      case 'trim':
        fields = `<span class="rule-trim-note">Trims leading and trailing whitespace from filename.</span>`;
        break;
    }

    return `
      <div class="rename-rule-item" data-rule-id="${rule.id}" data-index="${idx}" draggable="true">
        <span class="rename-rule-drag-handle" title="Drag to reorder">⠿</span>
        <span class="rename-rule-icon">${meta.icon}</span>
        <span class="rename-rule-label">${meta.label}</span>
        <div class="rename-rule-fields">${fields}</div>
        <button class="rename-rule-remove btn btn-ghost btn-sm" data-rule-id="${rule.id}" title="Remove rule">✕</button>
      </div>`;
  }

  function attachRuleEvents() {
    rulesList.querySelectorAll('.rename-rule-remove').forEach(btn => {
      btn.addEventListener('click', () => removeRule(btn.dataset.ruleId));
    });
    rulesList.querySelectorAll('.rule-field').forEach(field => {
      field.addEventListener('input', () => syncFieldToRule(field));
      field.addEventListener('change', () => syncFieldToRule(field));
    });
  }

  function syncFieldToRule(field) {
    const ruleEl = field.closest('.rename-rule-item');
    if (!ruleEl) return;
    const ruleId = ruleEl.dataset.ruleId;
    const rule = rules.find(r => r.id === ruleId);
    if (!rule) return;
    const key = field.dataset.field;
    if (field.type === 'checkbox') {
      rule[key] = field.checked;
    } else if (field.type === 'number') {
      rule[key] = Number(field.value);
    } else {
      rule[key] = field.value;
    }
    schedulePreview();
  }

  // ── Drag-to-reorder ───────────────────────────────────────────────────────
  let dragSrcIdx = null;

  function attachDragDrop() {
    const items = rulesList.querySelectorAll('.rename-rule-item');
    items.forEach(item => {
      item.addEventListener('dragstart', e => {
        dragSrcIdx = Number(item.dataset.index);
        e.dataTransfer.effectAllowed = 'move';
        item.classList.add('dragging');
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        rulesList.querySelectorAll('.rename-rule-item').forEach(i => i.classList.remove('drag-over'));
      });
      item.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        rulesList.querySelectorAll('.rename-rule-item').forEach(i => i.classList.remove('drag-over'));
        item.classList.add('drag-over');
      });
      item.addEventListener('drop', e => {
        e.preventDefault();
        const targetIdx = Number(item.dataset.index);
        if (dragSrcIdx === null || dragSrcIdx === targetIdx) return;
        const moved = rules.splice(dragSrcIdx, 1)[0];
        rules.splice(targetIdx, 0, moved);
        dragSrcIdx = null;
        renderRules();
        schedulePreview();
      });
    });
  }

  // ── Preview ───────────────────────────────────────────────────────────────
  function getActiveFiles() {
    if (scope === 'selected' && state.selectedIds.size > 0) {
      return state.files.filter(f => state.selectedIds.has(f.id));
    }
    return state.files;
  }

  function refreshPreview() {
    const files   = getActiveFiles();
    const preview = generatePreview(files, rules, { preserveExt });
    const changed  = preview.filter(p => p.changed).length;

    previewCount.textContent = files.length > 0
      ? `${files.length} file${files.length !== 1 ? 's' : ''} — ${changed} will be renamed`
      : '';

    if (files.length === 0) {
      previewTbody.innerHTML = '<tr><td colspan="3" class="rename-empty-preview">No files loaded.</td></tr>';
      return;
    }

    previewTbody.innerHTML = preview.map(row => `
      <tr class="${row.changed ? 'preview-changed' : ''}">
        <td class="preview-original">${escapeHtml(row.original)}</td>
        <td class="preview-new">${escapeHtml(row.newName)}</td>
        <td class="preview-status">${row.changed ? '<span class="badge-changed">Changed</span>' : '<span class="badge-unchanged">—</span>'}</td>
      </tr>`).join('');
  }

  const schedulePreview = debounce(refreshPreview, 200);

  // Refresh on file list changes
  on('files:changed',   schedulePreview);
  on('selection:changed', schedulePreview);

  // ── Apply & Download ──────────────────────────────────────────────────────
  applyBtn.addEventListener('click', async () => {
    const files   = getActiveFiles();
    if (files.length === 0) { showToast('No files to rename.', 'warning'); return; }

    const preview = generatePreview(files, rules, { preserveExt });
    const renames = preview.map(p => ({ original: p.original, newName: p.newName }));

    // Store for undo
    lastAppliedMapping = { files: [...files], renames: [...renames] };
    undoBtn.disabled = false;

    applyBtn.disabled = true;
    applyBtn.textContent = 'Preparing…';

    try {
      const blob = await bundleRenamedFiles(files, renames);

      if (blob) {
        downloadBlob(blob, 'renamed-files.zip');
        showToast(`Downloaded ${pluralize(files.length, 'file')} as ZIP.`, 'success');
      } else {
        // Individual downloads with delay
        let count = 0;
        for (let i = 0; i < files.length; i++) {
          const entry   = files[i];
          const newName = renames[i].newName;
          const fileBlob = entry.file.slice(0, entry.file.size, entry.file.type);
          downloadBlob(fileBlob, newName);
          count++;
          if (i < files.length - 1) await new Promise(r => setTimeout(r, 100));
        }
        showToast(`Downloaded ${pluralize(count, 'file')} individually.`, 'success');
      }
    } catch (err) {
      showToast(`Download failed: ${err.message}`, 'error');
    } finally {
      applyBtn.disabled = false;
      applyBtn.textContent = 'Apply & Download';
    }
  });

  // ── Export CSV ────────────────────────────────────────────────────────────
  exportBtn.addEventListener('click', () => {
    const files   = getActiveFiles();
    if (files.length === 0) { showToast('No files to export.', 'warning'); return; }

    const preview = generatePreview(files, rules, { preserveExt });
    const lines   = ['Original,New Name'];
    preview.forEach(row => {
      const orig    = `"${row.original.replace(/"/g, '""')}"`;
      const newName = `"${row.newName.replace(/"/g, '""')}"`;
      lines.push(`${orig},${newName}`);
    });
    const csv  = '\uFEFF' + lines.join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    downloadBlob(blob, 'rename-plan.csv');
    showToast('Rename plan exported.', 'success');
  });

  // ── Undo ──────────────────────────────────────────────────────────────────
  undoBtn.addEventListener('click', () => {
    if (!lastAppliedMapping) return;
    const { files, renames } = lastAppliedMapping;
    const lines = ['Original,New Name'];
    renames.forEach(r => {
      lines.push(`"${r.original.replace(/"/g, '""')}","${r.newName.replace(/"/g, '""')}"`);
    });
    showToast(`Undo info: last mapping had ${pluralize(renames.length, 'file')}. No destructive action was taken — files were only downloaded.`, 'info');
    lastAppliedMapping = null;
    undoBtn.disabled = true;
  });

  // Initial render
  refreshPreview();
}
