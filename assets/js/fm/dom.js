// dom.js
// DOM helpers and the small shared widgets: icons, toasts, dialogs, menus, progress.

import { t } from './i18n.js';

/** el('div.a.b', {onclick, dataset, ...}, ...children) */
export function el(spec, props, ...children) {
  const [tag, ...classes] = spec.split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');
  if (props instanceof Node || typeof props === 'string' || typeof props === 'number' || Array.isArray(props)) {
    children.unshift(props);
    props = null;
  }
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'html') node.innerHTML = value;
    else if (key in node && key !== 'list' && key !== 'form') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(3)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/** replaceChildren that skips null and false, and flattens lists. */
export function fill(node, ...children) {
  node.replaceChildren(...children.flat(3).filter(c => c !== null && c !== undefined && c !== false));
  return node;
}

export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const PATHS = {
  plus: 'M12 5v14M5 12h14',
  files: 'M8 3h7l4 4v10H8zM15 3v4h4M5 7v14h10',
  folder: 'M3 6.500h6l2 2.500h10V19H3z',
  folderPlus: 'M3 6.500h6l2 2.500h10V19H3zM12 12v4M10 14h4',
  download: 'M12 4v11m0 0l-4-4m4 4l4-4M5 19h14',
  zip: 'M6 3h8l4 4v14H6zM14 3v4h4M11 9h2M11 12h2M11 15h2v3h-2z',
  unzip: 'M6 3h8l4 4v14H6zM14 3v4h4M12 18v-6m0 0l-2.500 2.500M12 12l2.500 2.500',
  rename: 'M4 20h4L19 9l-4-4L4 16zM13.500 6.500l4 4',
  move: 'M3 6.500h6l2 2.500h10V19H3zM9 14h6m0 0l-2-2m2 2l-2 2',
  trash: 'M4 7h16M10 7V4h4v3M6.500 7l1 13h9l1-13M10 11v5M14 11v5',
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM16 16l4.500 4.500',
  list: 'M4 6h16M4 12h16M4 18h16',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  panel: 'M3 5h18v14H3zM15 5v14',
  sidebar: 'M3 5h18v14H3zM9 5v14',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.500l4.500 4.500L19 7.500',
  external: 'M14 5h5v5M19 5l-8 8M11 6H5v13h13v-6',
  eye: 'M2.500 12s3.500-6.500 9.500-6.500 9.500 6.500 9.500 6.500-3.500 6.500-9.500 6.500S2.500 12 2.500 12zM12 9.500a2.500 2.500 0 1 1 0 5 2.500 2.500 0 0 1 0-5z',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  hash: 'M9 4L7 20M17 4l-2 16M4.500 9h16M3.500 15h16',
  wand: 'M5 19L16 8M14 6l4 4M18 3v3M16.500 4.500h3M6 5v2M5 6h2M19 14v2M18 15h2',
  chevron: 'M9 6l6 6-6 6',
  down: 'M6 9l6 6 6-6',
  up: 'M12 19V6m0 0l-5 5m5-5l5 5',
  home: 'M4 11l8-7 8 7v9H4zM10 20v-6h4v6',
  info: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 11v5.500M12 7.700v.100',
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  image: 'M3 4h18v16H3zM3 17l5-4.500 3.500 3 4-4.500 5.500 6M8.500 7.500a1.500 1.500 0 1 1 0 3 1.500 1.500 0 0 1 0-3z',
  shrink: 'M6 3h8l4 4v14H6zM14 3v4h4M12 9v3.500m0 0l-2-2m2 2l2-2M12 19v-3.500m0 0l-2 2m2-2l2 2',
  duplicate: 'M8 8h12v12H8zM4 16V4h12M11 14h6M14 11v6',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
  table: 'M3 5h18v14H3zM3 10h18M3 14.500h18M9 5v14',
  inspect: 'M6 3h8l4 4v14H6zM14 3v4h4M11 11.500a2.500 2.500 0 1 1 0 5 2.500 2.500 0 0 1 0-5zM13 16l2.500 2.500',
  command: 'M9 9h6v6H9zM9 9V6.500A2.500 2.500 0 1 0 6.500 9H9zM15 9V6.500A2.500 2.500 0 1 1 17.500 9H15zM9 15v2.500A2.500 2.500 0 1 1 6.500 15H9zM15 15v2.500a2.500 2.500 0 1 0 2.500-2.500H15z',
  back: 'M15 6l-6 6 6 6',
  sort: 'M7 4v16m0 0l-3-3m3 3l3-3M17 20V4m0 0l-3 3m3-3l3 3',
  shield: 'M12 3l8 3v6c0 4.500-3.300 8-8 9-4.700-1-8-4.500-8-9V6zM8.500 12l2.500 2.500 4.500-5',
  select: 'M4 4h16v16H4zM8 12.500l3 3 5-6',
  pdf: 'M6 3h8l4 4v14H6zM14 3v4h4M9 17v-5h1.500a1.500 1.500 0 0 1 0 3H9',
  mail: 'M3 5h18v14H3zM3.500 6l8.500 7 8.500-7',
  md: 'M2.500 5.500h19v13h-19zM6 15V9l2.500 3L11 9v6M15.500 9v6m0 0l-2-2m2 2l2-2',
};

export function icon(name, cls = 'fm-i') {
  const span = document.createElement('span');
  span.className = cls;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${PATHS[name] || PATHS.files}"/></svg>`;
  return span;
}

export function btn(label, onclick, { variant = 'ghost', ico, title, kbd, ...props } = {}) {
  return el(`button.fm-btn.fm-btn--${variant}`, { type: 'button', onclick, title: title || (kbd ? `${label} (${kbd})` : undefined), ...props },
    ico ? icon(ico) : null, label ? el('span.fm-btn__label', label) : null);
}

export function iconBtn(ico, label, onclick, props = {}) {
  return el('button.fm-iconbtn', { type: 'button', onclick, title: label, 'aria-label': label, ...props }, icon(ico));
}

// ─── Toasts ───────────────────────────────────────────────────────────────────

let toastHost;
export function toast(message, { kind = 'info', action, onAction, ms = 4200 } = {}) {
  if (!toastHost) {
    toastHost = el('div.fm-toasts', { role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const node = el(`div.fm-toast.fm-toast--${kind}`,
    el('span', message),
    action ? el('button.fm-toast__action', { type: 'button', onclick: () => { onAction(); close(); } }, action) : null);
  const close = () => { node.classList.remove('is-in'); setTimeout(() => node.remove(), 200); };
  toastHost.append(node);
  requestAnimationFrame(() => node.classList.add('is-in'));
  setTimeout(close, ms);
  return close;
}

// ─── Dialogs ──────────────────────────────────────────────────────────────────

/**
 * A modal dialog. Returns { node, body, close, closed } where `closed` resolves
 * with whatever close() was given.
 */
export function dialog({ title, body, footer, size = 'm', className = '' }) {
  let resolve;
  const closed = new Promise(r => { resolve = r; });
  const node = el(`dialog.fm-dialog.fm-dialog--${size}${className ? `.${className}` : ''}`, { 'aria-label': title });
  const bodyEl = el('div.fm-dialog__body', body);
  const footEl = footer ? el('div.fm-dialog__foot', footer) : null;
  let result;
  const close = value => { result = value; node.close(); };
  node.append(
    el('header.fm-dialog__head', el('h2', title), iconBtn('x', t('Close'), () => close())),
    bodyEl);
  if (footEl) node.append(footEl);
  node.addEventListener('close', () => { node.remove(); resolve(result); });
  node.addEventListener('mousedown', e => { if (e.target === node) close(); });
  document.body.append(node);
  node.showModal();
  return { node, body: bodyEl, foot: footEl, close, closed };
}

/** Ask for one line of text. Resolves with the string, or null when cancelled. */
export function prompt({ title, label, value = '', action = t('Save'), selectStem = false, type = 'text' }) {
  const input = el('input.fm-input', { type, value, autocomplete: 'off', spellcheck: false });
  const d = dialog({
    title, size: 's',
    body: el('label.fm-field', el('span.fm-field__label', label), input),
    footer: [btn(t('Cancel'), () => d.close(null)), btn(action, () => submit(), { variant: 'primary' })],
  });
  const submit = () => { const v = type === 'password' ? input.value : input.value.trim(); if (v) d.close(v); };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  input.focus();
  const dot = value.lastIndexOf('.');
  if (selectStem && dot > 0) input.setSelectionRange(0, dot); else input.select();
  return d.closed.then(v => v ?? null);
}

export function confirm({ title, message, action, danger = false }) {
  const d = dialog({
    title, size: 's',
    body: el('p.fm-dialog__text', message),
    footer: [btn(t('Cancel'), () => d.close(false)), btn(action, () => d.close(true), { variant: danger ? 'danger' : 'primary', autofocus: true })],
  });
  return d.closed.then(Boolean);
}

// ─── Menus ────────────────────────────────────────────────────────────────────

let openMenu = null;
export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}

/**
 * Show a menu at a point or below an element.
 * @param {({label, ico, run, kbd, danger, disabled, hint}|'-'|{heading:string})[]} entries
 * @param {{x?:number, y?:number, anchor?:HTMLElement, align?:'left'|'right'}} at
 */
export function menu(entries, at) {
  closeMenu();
  const list = entries.filter(Boolean);
  if (!list.length) return;
  const node = el('div.fm-menu', { role: 'menu', tabIndex: -1 }, list.map(entry => {
    if (entry === '-') return el('div.fm-menu__sep', { role: 'separator' });
    if (entry.heading) return el('div.fm-menu__heading', entry.heading);
    return el(`button.fm-menu__item${entry.danger ? '.is-danger' : ''}`, {
      type: 'button', role: 'menuitem', disabled: entry.disabled,
      onclick: () => { closeMenu(); entry.run(); },
    }, icon(entry.ico || 'files'), el('span.fm-menu__label', entry.label),
    entry.hint ? el('span.fm-menu__hint', entry.hint) : null,
    entry.external ? icon('external', 'fm-i fm-menu__ext') : null,
    entry.kbd ? el('kbd', entry.kbd) : null);
  }));
  document.body.append(node);
  openMenu = node;

  const { innerWidth: vw, innerHeight: vh } = window;
  const rect = node.getBoundingClientRect();
  let x, y;
  if (at.anchor) {
    const a = at.anchor.getBoundingClientRect();
    x = at.align === 'right' ? a.right - rect.width : a.left;
    y = a.bottom + 4;
    if (y + rect.height > vh - 8) y = Math.max(8, a.top - rect.height - 4);
  } else { x = at.x; y = at.y; }
  node.style.left = `${Math.max(8, Math.min(x, vw - rect.width - 8))}px`;
  node.style.top = `${Math.max(8, Math.min(y, vh - rect.height - 8))}px`;

  const items = [...node.querySelectorAll('.fm-menu__item:not(:disabled)')];
  node.addEventListener('keydown', e => {
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeMenu(); at.anchor?.focus(); }
    e.stopPropagation();
  });
  (at.keyboard ? items[0] : node)?.focus();
}

document.addEventListener('mousedown', e => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }, true);
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);

// ─── Long tasks ───────────────────────────────────────────────────────────────

/**
 * Run work behind a small progress card. `fn` receives (fraction, label) => void
 * and an AbortSignal that fires when the person cancels.
 */
export async function task(label, fn) {
  const bar = el('div.fm-task__bar');
  const text = el('span.fm-task__label', label);
  const pct = el('span.fm-task__pct');
  const controller = new AbortController();
  const node = el('div.fm-task', { role: 'status', 'aria-live': 'polite' },
    el('div.fm-task__head', text, pct, iconBtn('x', t('Cancel'), () => controller.abort())),
    el('div.fm-task__track', bar));
  bar.classList.add('is-indeterminate');
  document.body.append(node);
  let last = 0;
  const progress = (fraction, nextLabel) => {
    if (nextLabel) text.textContent = nextLabel;
    if (typeof fraction !== 'number') return;
    const now = performance.now();
    if (fraction < 1 && now - last < 60) return;
    last = now;
    const v = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
    bar.classList.remove('is-indeterminate');
    bar.style.width = `${v}%`;
    pct.textContent = `${v}%`;
  };
  try {
    return await fn(progress, controller.signal);
  } catch (err) {
    if (err?.name === 'AbortError' || controller.signal.aborted) { toast(t('Cancelled.')); return undefined; }
    console.error(err);
    toast(err?.userMessage || t('That did not work. The file may be damaged or too large for this browser.'), { kind: 'error', ms: 7000 });
    return undefined;
  } finally {
    node.remove();
  }
}

export class UserError extends Error {
  constructor(message) { super(message); this.userMessage = message; }
}

export const pause = () => new Promise(r => setTimeout(r));

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast(t('Copied.')); } catch { toast(t('Copying is blocked in this browser.'), { kind: 'error' }); }
}
