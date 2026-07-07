// command-palette.js
// Cmd/Ctrl+K command palette: fuzzy search over app actions and loaded files.

import { state, setSelectedIds, setActiveModule, openPreview } from './state.js';
import { escapeHtml, formatBytes, getFileTypeIcon } from './utils.js';

/**
 * @typedef {Object} PaletteAction
 * @property {string} id
 * @property {string} label
 * @property {string} [hint]     right-aligned hint, e.g. a shortcut
 * @property {string} [icon]     inline SVG string
 * @property {() => void} run
 */

let _actions = [];
let _overlay = null;
let _input = null;
let _list = null;
let _activeIndex = 0;
let _visibleItems = [];

const ICON_ACTION = `<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><path d="M9 2L4 9h3l-1 5 5-7H8l1-5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`;

/**
 * Simple subsequence fuzzy match. Returns a score (higher = better) or -1.
 * @param {string} query lowercase
 * @param {string} target lowercase
 */
function fuzzyScore(query, target) {
  if (!query) return 0;
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of query) {
    const found = target.indexOf(ch, ti);
    if (found === -1) return -1;
    streak = found === ti ? streak + 1 : 1;
    score += streak * 2 + (found === 0 ? 4 : 0);
    ti = found + 1;
  }
  // Prefer shorter targets
  return score + Math.max(0, 20 - target.length / 4);
}

function _buildOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'cmdk-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="cmdk" role="dialog" aria-modal="true" aria-label="Command palette">
      <div class="cmdk-input-wrap">
        <svg viewBox="0 0 16 16" fill="none" width="16" height="16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        <input type="text" class="cmdk-input" placeholder="Type a command or search files…" aria-label="Command palette search" autocomplete="off" spellcheck="false">
      </div>
      <ul class="cmdk-list" role="listbox"></ul>
      <div class="cmdk-footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
        <span><kbd>↵</kbd> select</span>
        <span><kbd>esc</kbd> close</span>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener('mousedown', e => {
    if (e.target === overlay) closePalette();
  });

  const input = overlay.querySelector('.cmdk-input');
  const list = overlay.querySelector('.cmdk-list');

  input.addEventListener('input', () => _renderList(input.value));
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _setActive(_activeIndex + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _setActive(_activeIndex - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = _visibleItems[_activeIndex];
      if (item) _runItem(item);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePalette();
    }
  });

  list.addEventListener('click', e => {
    const li = e.target.closest('.cmdk-item');
    if (!li) return;
    const item = _visibleItems[parseInt(li.dataset.index, 10)];
    if (item) _runItem(item);
  });
  list.addEventListener('mousemove', e => {
    const li = e.target.closest('.cmdk-item');
    if (li) _setActive(parseInt(li.dataset.index, 10), false);
  });

  return { overlay, input, list };
}

function _runItem(item) {
  closePalette();
  try {
    if (item.kind === 'file') {
      const f = item.data;
      setSelectedIds([f.id]);
      setActiveModule('browser');
      openPreview(f.id);
    } else {
      item.data.run();
    }
  } catch (err) {
    console.error('command-palette: action failed', err);
  }
}

function _setActive(index, scroll = true) {
  if (!_visibleItems.length) return;
  _activeIndex = Math.max(0, Math.min(index, _visibleItems.length - 1));
  _list.querySelectorAll('.cmdk-item').forEach(li => {
    const active = parseInt(li.dataset.index, 10) === _activeIndex;
    li.classList.toggle('active', active);
    li.setAttribute('aria-selected', String(active));
    if (active && scroll) li.scrollIntoView({ block: 'nearest' });
  });
}

function _renderList(query) {
  const q = query.trim().toLowerCase();

  // Score actions
  const actions = _actions
    .map(a => ({ kind: 'action', data: a, score: fuzzyScore(q, a.label.toLowerCase()) }))
    .filter(x => x.score >= 0)
    .sort((a, b) => b.score - a.score);

  // Score files (only when searching, cap results)
  let files = [];
  if (q) {
    files = Array.from(state.files.values())
      .map(f => ({ kind: 'file', data: f, score: fuzzyScore(q, (f.relativePath || f.name).toLowerCase()) }))
      .filter(x => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);
  }

  _visibleItems = [...actions, ...files];
  _activeIndex = 0;

  if (!_visibleItems.length) {
    _list.innerHTML = `<div class="cmdk-empty">No matching commands or files</div>`;
    return;
  }

  let html = '';
  let index = 0;

  if (actions.length) {
    html += `<div class="cmdk-section-title">Commands</div>`;
    for (const { data } of actions) {
      html += `
        <li class="cmdk-item${index === 0 ? ' active' : ''}" data-index="${index}" role="option" aria-selected="${index === 0}">
          ${data.icon || ICON_ACTION}
          <span class="cmdk-item-label">${escapeHtml(data.label)}</span>
          ${data.hint ? `<span class="cmdk-item-hint">${escapeHtml(data.hint)}</span>` : ''}
        </li>`;
      index += 1;
    }
  }

  if (files.length) {
    html += `<div class="cmdk-section-title">Files</div>`;
    for (const { data } of files) {
      html += `
        <li class="cmdk-item${index === 0 ? ' active' : ''}" data-index="${index}" role="option" aria-selected="${index === 0}">
          <span class="file-icon" style="width:14px;height:14px;display:inline-flex;">${getFileTypeIcon(data.ext)}</span>
          <span class="cmdk-item-label" title="${escapeHtml(data.relativePath || data.name)}">${escapeHtml(data.relativePath || data.name)}</span>
          <span class="cmdk-item-hint">${escapeHtml(formatBytes(data.size))}</span>
        </li>`;
      index += 1;
    }
  }

  _list.innerHTML = html;
}

/** Open the palette. */
export function openPalette() {
  if (!_overlay) return;
  _overlay.hidden = false;
  _input.value = '';
  _renderList('');
  _input.focus();
}

/** Close the palette. */
export function closePalette() {
  if (!_overlay) return;
  _overlay.hidden = true;
}

/** @returns {boolean} */
export function isPaletteOpen() {
  return Boolean(_overlay && !_overlay.hidden);
}

/**
 * Initialise the palette with a set of actions and register the global shortcut.
 * @param {PaletteAction[]} actions
 */
export function initCommandPalette(actions) {
  _actions = actions;

  const parts = _buildOverlay();
  _overlay = parts.overlay;
  _input = parts.input;
  _list = parts.list;

  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (isPaletteOpen()) closePalette();
      else openPalette();
    }
  });
}
