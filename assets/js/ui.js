// UI component helpers and DOM utilities

import { formatBytes, formatDate, escapeHtml, getFileTypeIcon } from './utils.js';

// ─── DOM query helpers ────────────────────────────────────────────────────────

/**
 * querySelector shorthand, defaults to document.
 * @param {string} selector
 * @param {ParentNode} [root=document]
 * @returns {HTMLElement|null}
 */
export function $(selector, root = document) {
  return root.querySelector(selector);
}

/**
 * querySelectorAll shorthand — returns a real Array.
 * @param {string} selector
 * @param {ParentNode} [root=document]
 * @returns {HTMLElement[]}
 */
export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

// ─── Element creation ─────────────────────────────────────────────────────────

/**
 * Create an HTMLElement with optional attributes and children.
 * attrs: plain object; class -> className, for -> htmlFor, data-* -> dataset.
 * children: strings become textNodes, HTMLElements are appended directly.
 * @param {string} tag
 * @param {Object} [attrs]
 * @param {...(string|HTMLElement|null|undefined)} children
 * @returns {HTMLElement}
 */
export function createElement(tag, attrs, ...children) {
  const el = document.createElement(tag);

  if (attrs) {
    for (const [key, val] of Object.entries(attrs)) {
      if (val === null || val === undefined) continue;
      if (key === 'class' || key === 'className') {
        el.className = val;
      } else if (key === 'for' || key === 'htmlFor') {
        el.htmlFor = val;
      } else if (key === 'innerHTML') {
        el.innerHTML = val;
      } else if (key.startsWith('data-')) {
        el.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = val;
      } else if (key.startsWith('on') && typeof val === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), val);
      } else if (key in el) {
        el[key] = val;
      } else {
        el.setAttribute(key, val);
      }
    }
  }

  for (const child of children) {
    if (child === null || child === undefined) continue;
    if (typeof child === 'string') {
      el.appendChild(document.createTextNode(child));
    } else if (child instanceof Node) {
      el.appendChild(child);
    }
  }

  return el;
}

// ─── Modal ────────────────────────────────────────────────────────────────────

/** @type {HTMLElement|null} */
let _activeModal = null;
/** @type {Function|null} */
let _activeModalClose = null;

/**
 * Open a modal overlay.
 * @param {HTMLElement|string} contentOrId  Element to place in body, or id of existing modal
 * @returns {Function}  close function
 */
export function showModal(contentOrId) {
  // If there's already an active modal, close it first
  if (_activeModal) closeModal();

  let overlay = document.getElementById('modal-overlay');
  if (!overlay) {
    overlay = createElement('div', { id: 'modal-overlay', class: 'modal-overlay', role: 'dialog', 'aria-modal': 'true' });
    document.body.appendChild(overlay);
  }

  overlay.innerHTML = '';

  const dialog = createElement('div', { class: 'modal-dialog' });
  const header = createElement('div', { class: 'modal-header' });
  const titleEl = createElement('h2', { class: 'modal-title' });
  const closeBtn = createElement('button', {
    class: 'modal-close-btn',
    'aria-label': 'Close modal',
    type: 'button',
  }, '×');

  header.appendChild(titleEl);
  header.appendChild(closeBtn);

  const body = createElement('div', { class: 'modal-body' });
  const footer = createElement('div', { class: 'modal-footer' });

  dialog.appendChild(header);
  dialog.appendChild(body);
  dialog.appendChild(footer);
  overlay.appendChild(dialog);

  if (typeof contentOrId === 'string') {
    const existing = document.getElementById(contentOrId);
    if (existing) {
      const clone = existing.cloneNode(true);
      clone.style.display = '';
      body.appendChild(clone);
      // Copy title if data-title
      if (existing.dataset.title) titleEl.textContent = existing.dataset.title;
    } else {
      body.textContent = contentOrId;
    }
  } else if (contentOrId instanceof HTMLElement) {
    body.appendChild(contentOrId);
  }

  overlay.classList.add('is-open');
  overlay.style.display = 'flex';
  _activeModal = overlay;

  const close = () => closeModal();
  _activeModalClose = close;

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => {
    if (e.target === overlay) close();
  });

  const keyHandler = (e) => {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', keyHandler);
    }
  };
  document.addEventListener('keydown', keyHandler);

  // Focus trap: focus first focusable element
  const focusable = dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (focusable.length > 0) {
    setTimeout(() => focusable[0].focus(), 50);
  }

  return close;
}

/**
 * Close the active modal.
 */
export function closeModal() {
  if (_activeModal) {
    _activeModal.classList.remove('is-open');
    _activeModal.style.display = 'none';
    _activeModal.innerHTML = '';
    _activeModal = null;
    _activeModalClose = null;
  }
}

// ─── Toast notifications ──────────────────────────────────────────────────────

let _toastContainer = null;

function getToastContainer() {
  if (_toastContainer && document.body.contains(_toastContainer)) return _toastContainer;
  _toastContainer = document.getElementById('toast-container');
  if (!_toastContainer) {
    _toastContainer = createElement('div', { id: 'toast-container', class: 'toast-container', 'aria-live': 'polite' });
    document.body.appendChild(_toastContainer);
  }
  return _toastContainer;
}

/**
 * Show a toast notification.
 * @param {string} message
 * @param {'info'|'success'|'warning'|'error'} [type='info']
 * @param {number} [duration=4000]
 * @returns {HTMLElement} the toast element
 */
export function showToast(message, type = 'info', duration = 4000) {
  const container = getToastContainer();

  const icons = {
    info: '<svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M8 7v5M8 5v1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    success: '<svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M5 8l2 2 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warning: '<svg viewBox="0 0 16 16" fill="none"><path d="M8 2L1 14h14L8 2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6v4M8 11v1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    error: '<svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M5 5l6 6M11 5l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  };

  const toast = createElement('div', { class: `toast toast-${type}`, role: 'alert' });
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || icons.info}</span>
    <span class="toast-message">${escapeHtml(message)}</span>
    <button class="toast-dismiss" type="button" aria-label="Dismiss">×</button>
  `;

  const dismiss = toast.querySelector('.toast-dismiss');
  const remove = () => hideToast(toast);
  dismiss.addEventListener('click', remove);

  container.appendChild(toast);

  // Trigger animation
  requestAnimationFrame(() => toast.classList.add('toast-visible'));

  if (duration > 0) {
    setTimeout(remove, duration);
  }

  return toast;
}

/**
 * Dismiss and remove a toast element.
 * @param {HTMLElement} toastEl
 */
export function hideToast(toastEl) {
  if (!toastEl) return;
  toastEl.classList.remove('toast-visible');
  toastEl.classList.add('toast-hiding');
  setTimeout(() => {
    if (toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
  }, 300);
}

// ─── Confirm dialog ───────────────────────────────────────────────────────────

/**
 * Show a confirmation dialog.
 * @param {string} message
 * @param {string} [confirmText='Confirm']
 * @param {boolean} [dangerMode=false]
 * @returns {Promise<boolean>}
 */
export function showConfirm(message, confirmText = 'Confirm', dangerMode = false) {
  return new Promise(resolve => {
    const content = createElement('div', { class: 'confirm-content' });

    const msgEl = createElement('p', { class: 'confirm-message' });
    msgEl.textContent = message;

    const actions = createElement('div', { class: 'confirm-actions' });

    const cancelBtn = createElement('button', { type: 'button', class: 'btn btn-secondary' }, 'Cancel');
    const confirmBtn = createElement('button', {
      type: 'button',
      class: `btn ${dangerMode ? 'btn-danger' : 'btn-primary'}`,
    }, confirmText);

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    content.appendChild(msgEl);
    content.appendChild(actions);

    const closeFunc = showModal(content);

    // Set modal title
    const titleEl = document.querySelector('#modal-overlay .modal-title');
    if (titleEl) titleEl.textContent = dangerMode ? 'Are you sure?' : 'Confirm';

    const finish = (result) => {
      closeFunc();
      resolve(result);
    };

    cancelBtn.addEventListener('click', () => finish(false));
    confirmBtn.addEventListener('click', () => finish(true));

    // Override the modal overlay's close (X button and backdrop) to resolve false
    const overlay = document.getElementById('modal-overlay');
    if (overlay) {
      const xBtn = overlay.querySelector('.modal-close-btn');
      if (xBtn) {
        // Remove existing and add new
        const newX = xBtn.cloneNode(true);
        xBtn.parentNode.replaceChild(newX, xBtn);
        newX.addEventListener('click', () => finish(false));
      }
      const handleBackdrop = (e) => {
        if (e.target === overlay) {
          overlay.removeEventListener('click', handleBackdrop);
          finish(false);
        }
      };
      overlay.addEventListener('click', handleBackdrop);
    }
  });
}

// ─── Button loading state ─────────────────────────────────────────────────────

/**
 * Set a button into a loading/not-loading state.
 * @param {HTMLButtonElement} buttonEl
 * @param {boolean} [loading=true]
 */
export function setLoading(buttonEl, loading = true) {
  if (!buttonEl) return;
  if (loading) {
    buttonEl.disabled = true;
    if (!buttonEl.dataset.originalText) {
      buttonEl.dataset.originalText = buttonEl.innerHTML;
    }
    buttonEl.classList.add('is-loading');
    buttonEl.innerHTML = `
      <span class="spinner" aria-hidden="true"></span>
      <span class="sr-only">Loading…</span>
    `;
  } else {
    buttonEl.disabled = false;
    buttonEl.classList.remove('is-loading');
    if (buttonEl.dataset.originalText) {
      buttonEl.innerHTML = buttonEl.dataset.originalText;
      delete buttonEl.dataset.originalText;
    }
  }
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

/**
 * Render or update a progress bar inside containerEl.
 * @param {HTMLElement} containerEl
 * @param {number} percent  0-100
 * @param {string} [label='']
 */
export function renderProgress(containerEl, percent, label = '') {
  if (!containerEl) return;
  const clamped = Math.min(100, Math.max(0, percent));

  let bar = containerEl.querySelector('.progress-bar-fill');
  let labelEl = containerEl.querySelector('.progress-label');
  let wrapper = containerEl.querySelector('.progress-wrapper');

  if (!wrapper) {
    wrapper = createElement('div', { class: 'progress-wrapper' });
    const track = createElement('div', { class: 'progress-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' });
    bar = createElement('div', { class: 'progress-bar-fill' });
    labelEl = createElement('div', { class: 'progress-label' });
    track.appendChild(bar);
    wrapper.appendChild(track);
    wrapper.appendChild(labelEl);
    containerEl.appendChild(wrapper);
  }

  bar.style.width = `${clamped}%`;
  const track = wrapper.querySelector('.progress-track');
  if (track) track.setAttribute('aria-valuenow', String(clamped));

  if (label) {
    labelEl.textContent = label;
    labelEl.style.display = '';
  } else {
    labelEl.style.display = 'none';
  }
}

// ─── Overlay loading ──────────────────────────────────────────────────────────

/**
 * Show a loading overlay over a container element.
 * @param {HTMLElement} containerEl
 * @param {string} [message='']
 */
export function showOverlayLoading(containerEl, message = '') {
  if (!containerEl) return;
  hideOverlayLoading(containerEl); // remove any existing

  const overlay = createElement('div', { class: 'overlay-loading' });
  const spinner = createElement('div', { class: 'overlay-spinner', 'aria-hidden': 'true' });
  const msg = createElement('p', { class: 'overlay-message' });
  msg.textContent = message || 'Loading…';

  overlay.appendChild(spinner);
  overlay.appendChild(msg);

  // Make container position relative if needed
  const pos = window.getComputedStyle(containerEl).position;
  if (pos === 'static') containerEl.style.position = 'relative';

  containerEl.appendChild(overlay);
  containerEl.setAttribute('aria-busy', 'true');
}

/**
 * Remove the loading overlay from a container.
 * @param {HTMLElement} containerEl
 */
export function hideOverlayLoading(containerEl) {
  if (!containerEl) return;
  const existing = containerEl.querySelector('.overlay-loading');
  if (existing) existing.remove();
  containerEl.removeAttribute('aria-busy');
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

/**
 * Initialize tab switching within a container element.
 * Expects: [data-tab="name"] tab buttons and [data-panel="name"] panel elements.
 * @param {HTMLElement} containerEl
 */
export function initTabs(containerEl) {
  if (!containerEl) return;

  const tabs = Array.from(containerEl.querySelectorAll('[data-tab]'));
  const panels = Array.from(containerEl.querySelectorAll('[data-panel]'));

  function activateTab(name) {
    tabs.forEach(t => {
      const active = t.dataset.tab === name;
      t.classList.toggle('tab-active', active);
      t.setAttribute('aria-selected', String(active));
      t.setAttribute('tabindex', active ? '0' : '-1');
    });
    panels.forEach(p => {
      const active = p.dataset.panel === name;
      p.classList.toggle('panel-active', active);
      p.hidden = !active;
    });
  }

  // Activate first tab or first marked active
  const firstActive = tabs.find(t => t.classList.contains('tab-active'));
  const initial = firstActive ? firstActive.dataset.tab : (tabs[0] ? tabs[0].dataset.tab : null);
  if (initial) activateTab(initial);

  containerEl.addEventListener('click', e => {
    const tab = e.target.closest('[data-tab]');
    if (tab && containerEl.contains(tab)) {
      activateTab(tab.dataset.tab);
    }
  });

  containerEl.addEventListener('keydown', e => {
    const tab = e.target.closest('[data-tab]');
    if (!tab) return;
    const idx = tabs.indexOf(tab);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      const next = tabs[(idx + 1) % tabs.length];
      if (next) { next.focus(); activateTab(next.dataset.tab); }
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      const prev = tabs[(idx - 1 + tabs.length) % tabs.length];
      if (prev) { prev.focus(); activateTab(prev.dataset.tab); }
    }
  });
}

// ─── Accordion ────────────────────────────────────────────────────────────────

/**
 * Initialize FAQ-style accordion within a container.
 * Expects items with [data-accordion-item], headers with [data-accordion-header], bodies with [data-accordion-body].
 * @param {HTMLElement} containerEl
 */
export function initAccordion(containerEl) {
  if (!containerEl) return;

  const items = Array.from(containerEl.querySelectorAll('[data-accordion-item]'));

  items.forEach(item => {
    const header = item.querySelector('[data-accordion-header]');
    const body = item.querySelector('[data-accordion-body]');
    if (!header || !body) return;

    const isOpen = item.classList.contains('accordion-open');
    body.hidden = !isOpen;
    header.setAttribute('aria-expanded', String(isOpen));

    header.addEventListener('click', () => {
      const open = !item.classList.contains('accordion-open');
      item.classList.toggle('accordion-open', open);
      body.hidden = !open;
      header.setAttribute('aria-expanded', String(open));
    });

    header.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        header.click();
      }
    });
  });
}

// ─── Reveal animations ────────────────────────────────────────────────────────

/**
 * Set up IntersectionObserver to add .revealed class when .reveal elements enter viewport.
 */
export function initRevealAnimations() {
  if (!('IntersectionObserver' in window)) {
    // Fallback: just reveal all immediately
    document.querySelectorAll('.reveal').forEach(el => el.classList.add('revealed'));
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('revealed');
        observer.unobserve(entry.target);
      }
    });
  }, {
    threshold: 0.1,
    rootMargin: '0px 0px -40px 0px',
  });

  document.querySelectorAll('.reveal').forEach(el => observer.observe(el));
}

// ─── Status bar ───────────────────────────────────────────────────────────────

/**
 * Update the file count status bar text.
 * @param {number} count         total visible files
 * @param {number} selectedCount currently selected
 */
export function updateFileCountStatus(count, selectedCount) {
  const statusEl = document.getElementById('file-count-status');
  if (!statusEl) return;

  if (selectedCount > 0) {
    statusEl.textContent = `${selectedCount} of ${count} file${count !== 1 ? 's' : ''} selected`;
  } else {
    statusEl.textContent = `${count} file${count !== 1 ? 's' : ''}`;
  }
}

// ─── Context menu ─────────────────────────────────────────────────────────────

let _contextMenu = null;

function removeContextMenu() {
  if (_contextMenu && _contextMenu.parentNode) {
    _contextMenu.parentNode.removeChild(_contextMenu);
  }
  _contextMenu = null;
}

/**
 * Attach a right-click context menu to an element.
 * @param {HTMLElement} triggerEl
 * @param {Array<{label: string, action: Function, danger?: boolean, divider?: boolean}>} items
 */
export function initContextMenu(triggerEl, items) {
  if (!triggerEl) return;

  triggerEl.addEventListener('contextmenu', e => {
    e.preventDefault();
    removeContextMenu();

    const menu = createElement('div', { class: 'context-menu', role: 'menu' });

    for (const item of items) {
      if (item.divider) {
        menu.appendChild(createElement('div', { class: 'context-menu-divider', role: 'separator' }));
        continue;
      }
      const menuItem = createElement('button', {
        type: 'button',
        class: `context-menu-item${item.danger ? ' context-menu-item-danger' : ''}`,
        role: 'menuitem',
      }, item.label);

      menuItem.addEventListener('click', () => {
        removeContextMenu();
        if (typeof item.action === 'function') item.action();
      });

      menu.appendChild(menuItem);
    }

    document.body.appendChild(menu);
    _contextMenu = menu;

    // Position near cursor
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = e.clientX + window.scrollX;
    let y = e.clientY + window.scrollY;

    menu.style.visibility = 'hidden';
    menu.style.position = 'absolute';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      if (rect.right > vw) x = Math.max(0, e.clientX - rect.width + window.scrollX);
      if (rect.bottom > vh) y = Math.max(0, e.clientY - rect.height + window.scrollY);
      menu.style.left = `${x}px`;
      menu.style.top = `${y}px`;
      menu.style.visibility = '';
    });

    // Dismiss on outside click or scroll
    setTimeout(() => {
      document.addEventListener('click', removeContextMenu, { once: true });
      document.addEventListener('scroll', removeContextMenu, { once: true, passive: true });
    }, 0);
  });
}

// ─── File table row ───────────────────────────────────────────────────────────

/**
 * Create a <tr> element for a FileEntry.
 * Uses data attributes for event delegation; no direct row listeners attached.
 * @param {import('./state.js').FileEntry} fileEntry
 * @returns {HTMLTableRowElement}
 */
export function formatFileTableRow(fileEntry) {
  const { id, name, ext, size, modified, relativePath, category } = fileEntry;

  const tr = createElement('tr', {
    class: 'file-row',
    'data-file-id': id,
    'data-category': category,
  });

  // Checkbox cell
  const checkTd = createElement('td', { class: 'file-col-check' });
  const checkbox = createElement('input', {
    type: 'checkbox',
    class: 'file-checkbox',
    'aria-label': `Select ${escapeHtml(name)}`,
    'data-file-id': id,
  });
  checkTd.appendChild(checkbox);
  tr.appendChild(checkTd);

  // Icon + name cell
  const nameTd = createElement('td', { class: 'file-col-name' });
  const iconWrapper = createElement('span', { class: 'file-icon', 'aria-hidden': 'true' });
  iconWrapper.innerHTML = getFileTypeIcon(ext);
  const nameSpan = createElement('span', { class: 'file-name-text' }, name);
  nameTd.appendChild(iconWrapper);
  nameTd.appendChild(nameSpan);
  tr.appendChild(nameTd);

  // Extension badge cell
  const extTd = createElement('td', { class: 'file-col-ext' });
  if (ext) {
    const badge = createElement('span', { class: `ext-badge ext-${escapeHtml(ext)}` }, ext.toUpperCase());
    extTd.appendChild(badge);
  }
  tr.appendChild(extTd);

  // Size cell
  const sizeTd = createElement('td', { class: 'file-col-size' });
  sizeTd.textContent = formatBytes(size);
  tr.appendChild(sizeTd);

  // Modified date cell
  const modTd = createElement('td', { class: 'file-col-modified' });
  modTd.textContent = formatDate(modified);
  tr.appendChild(modTd);

  // Path cell
  const pathTd = createElement('td', { class: 'file-col-path' });
  const pathSpan = createElement('span', { class: 'file-path-text', title: relativePath });
  pathSpan.textContent = relativePath;
  pathTd.appendChild(pathSpan);
  tr.appendChild(pathTd);

  return tr;
}

// ─── Module tab highlighting ──────────────────────────────────────────────────

/**
 * Update the active module tab highlight in the workspace header.
 * Expects elements with [data-module="name"] in the workspace nav.
 * @param {string} name  module name
 */
export function setActiveModule(name) {
  const tabs = document.querySelectorAll('[data-module]');
  tabs.forEach(tab => {
    const isActive = tab.dataset.module === name;
    tab.classList.toggle('module-tab-active', isActive);
    tab.setAttribute('aria-current', isActive ? 'page' : 'false');
  });
}
