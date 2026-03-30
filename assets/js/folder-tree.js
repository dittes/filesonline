// folder-tree.js
// Renders and manages the folder tree in the left pane (.pane-left).
// Shows folder structure derived from FileEntry.relativePath values in state.

import { state, on, setFilter, getFilteredFiles } from './state.js';
import { openFiles } from './file-access.js';
import { escapeHtml } from './utils.js';

// ---------------------------------------------------------------------------
// Types / data structures (JSDoc only — no TS)
// ---------------------------------------------------------------------------
//
// TreeNode: {
//   name:       string,          // display name
//   path:       string,          // full folder path, e.g. "images/avatars/"
//   count:      number,          // total file count (including descendants)
//   children:   Map<string, TreeNode>,
//   isExpanded: boolean,
// }

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialise the folder tree inside `containerEl`.
 * Attaches event listeners and renders the initial state.
 *
 * @param {HTMLElement} containerEl
 */
export function initFolderTree(containerEl) {
  _render(containerEl);

  // Re-render whenever files change
  on('files:added',   () => _render(containerEl));
  on('files:cleared', () => _render(containerEl));

  // Event delegation — all clicks inside the container
  containerEl.addEventListener('click', (e) => _handleClick(e, containerEl));
}

/**
 * Full re-render of the tree into `containerEl`.
 *
 * @param {HTMLElement} containerEl
 */
export function renderTree(containerEl) {
  _render(containerEl);
}

/**
 * Convert a flat FileEntry array into a nested tree structure.
 * Returns a root TreeNode whose children represent top-level folders
 * (and a synthetic "All Files" sentinel).
 *
 * @param {Array<import('./state.js').FileEntry>} files
 * @returns {{ root: TreeNode, totalCount: number }}
 */
export function buildTreeData(files) {
  const root = _makeNode('__root__', '');

  for (const entry of files) {
    const rel = entry.relativePath || ''; // e.g. "images/avatars/"
    if (!rel) {
      // File lives at the root level — count it on root but don't create a node
      root.count++;
      continue;
    }

    // Split the path into segments, ignoring empty strings
    const segments = rel.replace(/\/$/, '').split('/').filter(Boolean);
    let node = root;
    let builtPath = '';

    for (const segment of segments) {
      builtPath = builtPath ? builtPath + segment + '/' : segment + '/';
      if (!node.children.has(segment)) {
        node.children.set(segment, _makeNode(segment, builtPath));
      }
      node = node.children.get(segment);
      node.count++;
    }

    root.count++;
  }

  return { root, totalCount: root.count };
}

// ---------------------------------------------------------------------------
// Private — rendering
// ---------------------------------------------------------------------------

/** @type {string} Currently active path filter ('') = All Files */
let _activePath = '';

/**
 * Build and inject HTML for the complete tree panel.
 *
 * @param {HTMLElement} containerEl
 */
function _render(containerEl) {
  const allFiles     = Array.from(state.files.values());
  const { root, totalCount } = buildTreeData(allFiles);

  containerEl.innerHTML = _buildPanelHTML(root, totalCount);
}

/**
 * Build the full panel HTML string.
 *
 * @param {TreeNode} root
 * @param {number}   totalCount
 * @returns {string}
 */
function _buildPanelHTML(root, totalCount) {
  const childrenHTML = _buildChildrenHTML(root.children, 0);

  return `
    <div class="tree-panel">
      <div class="tree-section-header">Sources</div>

      <ul class="tree-list" role="tree">
        <li class="tree-item tree-item--all${_activePath === '' ? ' active' : ''}"
            data-path=""
            data-type="all"
            role="treeitem"
            tabindex="0"
            aria-selected="${_activePath === ''}">
          <span class="tree-item__icon">
            ${_iconFiles()}
          </span>
          <span class="tree-item__label">All Files</span>
          <span class="tree-item__count">${totalCount}</span>
        </li>

        ${childrenHTML}
      </ul>

      <div class="tree-footer">
        <button class="tree-add-btn" data-action="add-files" type="button">
          ${_iconPlus()}
          Add files
        </button>
      </div>
    </div>
  `;
}

/**
 * Recursively build HTML for a Map of child TreeNodes.
 *
 * @param {Map<string, TreeNode>} children
 * @param {number}                depth
 * @returns {string}
 */
function _buildChildrenHTML(children, depth) {
  if (!children.size) return '';

  let html = '';

  for (const [, node] of children) {
    const isActive   = _activePath === node.path;
    const isExpanded = node.isExpanded;
    const hasChildren = node.children.size > 0;
    const indent = depth * 16; // px per depth level

    const childrenHTML = hasChildren
      ? _buildChildrenHTML(node.children, depth + 1)
      : '';

    html += `
      <li class="tree-item${isActive ? ' active' : ''}${hasChildren ? ' tree-item--folder' : ''}"
          data-path="${escapeHtml(node.path)}"
          data-type="folder"
          data-expanded="${isExpanded}"
          role="treeitem"
          aria-expanded="${isExpanded}"
          aria-selected="${isActive}"
          tabindex="0"
          style="--indent: ${indent}px">

        <span class="tree-item__toggle" data-action="toggle" aria-label="Toggle folder">
          ${hasChildren ? _iconChevron(isExpanded) : '<span class="tree-item__toggle-placeholder"></span>'}
        </span>

        <span class="tree-item__icon">
          ${_iconFolder(isExpanded)}
        </span>

        <span class="tree-item__label" title="${escapeHtml(node.name)}">${escapeHtml(node.name)}</span>
        <span class="tree-item__count">${node.count}</span>

        ${hasChildren ? `
          <ul class="tree-children${isExpanded ? ' tree-children--open' : ''}" role="group">
            ${childrenHTML}
          </ul>
        ` : ''}
      </li>
    `;
  }

  return html;
}

// ---------------------------------------------------------------------------
// Private — event handling
// ---------------------------------------------------------------------------

/**
 * Delegated click handler for the whole container.
 *
 * @param {MouseEvent}  e
 * @param {HTMLElement} containerEl
 */
function _handleClick(e, containerEl) {
  const toggleBtn = e.target.closest('[data-action="toggle"]');
  if (toggleBtn) {
    e.stopPropagation();
    const item = toggleBtn.closest('.tree-item');
    if (item) _toggleExpand(item, containerEl);
    return;
  }

  const addBtn = e.target.closest('[data-action="add-files"]');
  if (addBtn) {
    openFiles().catch((err) => console.error('folder-tree: openFiles error', err));
    return;
  }

  const treeItem = e.target.closest('.tree-item');
  if (!treeItem) return;

  const path = treeItem.dataset.path ?? '';
  _setActivePath(path, containerEl);
  setFilter('path', path);
}

/**
 * Toggle expand/collapse of a folder tree item.
 *
 * @param {HTMLElement} item
 * @param {HTMLElement} containerEl
 */
function _toggleExpand(item, containerEl) {
  const isExpanded = item.dataset.expanded === 'true';
  const newExpanded = !isExpanded;

  item.dataset.expanded = String(newExpanded);
  item.setAttribute('aria-expanded', String(newExpanded));

  const chevron  = item.querySelector('.tree-chevron');
  if (chevron) chevron.classList.toggle('tree-chevron--open', newExpanded);

  const children = item.querySelector('.tree-children');
  if (children) {
    if (newExpanded) {
      // Measure natural height then animate to it
      children.classList.add('tree-children--open');
      children.style.height = '0px';
      // Force reflow
      children.getBoundingClientRect();
      const targetHeight = children.scrollHeight;
      children.style.height = targetHeight + 'px';
      children.addEventListener('transitionend', function onEnd() {
        children.removeEventListener('transitionend', onEnd);
        children.style.height = ''; // let it be auto
      }, { once: true });
    } else {
      // Collapse: set explicit height, then transition to 0
      children.style.height = children.scrollHeight + 'px';
      children.getBoundingClientRect();
      children.style.height = '0px';
      children.addEventListener('transitionend', function onEnd() {
        children.removeEventListener('transitionend', onEnd);
        children.classList.remove('tree-children--open');
        children.style.height = '';
      }, { once: true });
    }
  }

  // Update chevron icon inside the toggle button
  const toggleBtn = item.querySelector('[data-action="toggle"]');
  if (toggleBtn) {
    toggleBtn.innerHTML = _iconChevron(newExpanded);
  }
}

/**
 * Update the active path and refresh active class on tree items.
 *
 * @param {string}      path
 * @param {HTMLElement} containerEl
 */
function _setActivePath(path, containerEl) {
  _activePath = path;

  const items = containerEl.querySelectorAll('.tree-item');
  items.forEach((item) => {
    const isActive = item.dataset.path === path;
    item.classList.toggle('active', isActive);
    item.setAttribute('aria-selected', String(isActive));
  });
}

// ---------------------------------------------------------------------------
// Private — SVG icons (inline, no external dependency)
// ---------------------------------------------------------------------------

function _iconChevron(open) {
  return `<svg class="tree-chevron${open ? ' tree-chevron--open' : ''}"
               width="16" height="16" viewBox="0 0 16 16"
               fill="none" aria-hidden="true">
    <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5"
          stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function _iconFolder(open) {
  if (open) {
    return `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1 4a1 1 0 011-1h4.586a1 1 0 01.707.293L8 4h6a1 1 0 011 1v7a1 1 0 01-1 1H2a1 1 0 01-1-1V4z"
            fill="currentColor" opacity="0.85"/>
    </svg>`;
  }
  return `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M1 4a1 1 0 011-1h4.586a1 1 0 01.707.293L8 4h6a1 1 0 011 1v7a1 1 0 01-1 1H2a1 1 0 01-1-1V4z"
          fill="currentColor" opacity="0.55"/>
  </svg>`;
}

function _iconFiles() {
  return `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <rect x="2" y="1" width="9" height="12" rx="1" fill="currentColor" opacity="0.5"/>
    <rect x="5" y="3" width="9" height="12" rx="1" fill="currentColor" opacity="0.85"/>
  </svg>`;
}

function _iconPlus() {
  return `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="M6 1v10M1 6h10" stroke="currentColor" stroke-width="1.5"
          stroke-linecap="round"/>
  </svg>`;
}

// ---------------------------------------------------------------------------
// Private — node factory
// ---------------------------------------------------------------------------

/**
 * Create a fresh TreeNode.
 *
 * @param {string} name
 * @param {string} path
 * @returns {TreeNode}
 */
function _makeNode(name, path) {
  return {
    name,
    path,
    count:      0,
    children:   new Map(),
    isExpanded: true, // start expanded; user can collapse
  };
}
