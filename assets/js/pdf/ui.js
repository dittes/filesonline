// ui.js
// Building blocks for the PDF tool pages: translation, small DOM helpers, form
// controls, progress, results and the hand-off between tools.

import { fflate } from './lib.js';

// ─── i18n ─────────────────────────────────────────────────────────────────────

let dict = {};
export let lang = document.documentElement.lang || 'en';

export async function loadStrings() {
  if (lang === 'en') return;
  dict = (await import(`/assets/i18n/pdf-ui.${lang}.js`)).default;
}

/** Translate by English source string; {name} placeholders are filled from params. */
export function t(source, params) {
  let out = dict[source] ?? source;
  if (params) for (const [k, v] of Object.entries(params)) out = out.replaceAll(`{${k}}`, v);
  return out;
}

// ─── DOM ──────────────────────────────────────────────────────────────────────

/** el('div.a.b', {onclick, dataset, ...}, ...children) */
export function el(spec, props, ...children) {
  const [tag, ...classes] = spec.split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');
  if (props instanceof Node || typeof props === 'string' || Array.isArray(props)) {
    children.unshift(props);
    props = null;
  }
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key in node && key !== 'list' && key !== 'form') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

export function formatBytes(n) {
  const fmt = new Intl.NumberFormat(lang, { maximumFractionDigits: 1 });
  if (n < 1024) return `${fmt.format(n)} B`;
  if (n < 1048576) return `${fmt.format(n / 1024)} KB`;
  return `${fmt.format(n / 1048576)} MB`;
}

export const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r)));

// ─── Form controls ────────────────────────────────────────────────────────────

let uid = 0;

/** A labelled control. Returns the wrapper; the input is at `.input`. */
export function field(label, input, hint) {
  const id = input.id || (input.id = `pt-f${++uid}`);
  const wrap = el('div.pt-field',
    el('label.pt-label', { htmlFor: id }, label),
    input,
    hint ? el('p.pt-hint', hint) : null);
  wrap.input = input;
  return wrap;
}

export function textInput(value = '', props = {}) {
  return el('input.pt-input', { type: 'text', value, ...props });
}

export function numberInput(value, props = {}) {
  return el('input.pt-input', { type: 'number', value, inputMode: 'numeric', ...props });
}

export function select(options, value, props = {}) {
  return el('select.pt-input', props, options.map(([v, label]) => el('option', { value: v, selected: v === value }, label)));
}

export function checkbox(label, checked = false, props = {}) {
  const input = el('input', { type: 'checkbox', checked, ...props });
  const wrap = el('label.pt-check', input, el('span', label));
  wrap.input = input;
  return wrap;
}

/** Radio cards: options [{value, label, hint}]. Returns element with .value. */
export function choice(options, value, onChange) {
  const name = `pt-c${++uid}`;
  const wrap = el('div.pt-choice', { role: 'radiogroup' });
  wrap.value = value;
  for (const opt of options) {
    wrap.append(el('label.pt-choice__item',
      el('input', {
        type: 'radio', name, value: opt.value, checked: opt.value === value,
        onchange: () => { wrap.value = opt.value; onChange?.(opt.value); },
      }),
      el('span.pt-choice__body', el('strong', opt.label), opt.hint ? el('small', opt.hint) : null)));
  }
  return wrap;
}

export function button(label, onclick, variant = 'secondary', props = {}) {
  return el(`button.s-btn.s-btn--${variant}`, { type: 'button', onclick, ...props }, label);
}

export function notice(text, kind = 'info') {
  return el(`div.pt-notice.pt-notice--${kind}`, { role: kind === 'error' ? 'alert' : 'status' }, text);
}

// ─── Files ────────────────────────────────────────────────────────────────────

export function pickFiles({ accept, multiple }) {
  return new Promise(resolve => {
    const input = el('input', { type: 'file', accept, multiple, hidden: true });
    input.addEventListener('change', () => { resolve([...input.files]); input.remove(); });
    input.addEventListener('cancel', () => { resolve([]); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

export function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ─── Hand-off between tools (stays on this device, in IndexedDB) ──────────────

const HANDOFF_DB = 'fo-pdf-handoff';

function handoffStore(mode) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(HANDOFF_DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('files');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('files', mode);
      tx.oncomplete = () => open.result.close();
      resolve(tx.objectStore('files'));
    };
  });
}

export async function saveHandoff(name, blob) {
  const store = await handoffStore('readwrite');
  await new Promise((res, rej) => {
    const r = store.put({ name, blob, at: Date.now() }, 'current');
    r.onsuccess = res;
    r.onerror = () => rej(r.error);
  });
}

export async function takeHandoff() {
  const store = await handoffStore('readwrite');
  return new Promise(resolve => {
    const r = store.get('current');
    r.onsuccess = () => {
      store.delete('current');
      const v = r.result;
      resolve(v && Date.now() - v.at < 3600000 ? new File([v.blob], v.name, { type: 'application/pdf' }) : null);
    };
    r.onerror = () => resolve(null);
  });
}

// ─── Stage: progress and results ──────────────────────────────────────────────

/** Replace the stage contents with a progress view; returns (fraction, label) => void. */
export function showProgress(stage, label) {
  const bar = el('div.pt-progress__bar');
  const text = el('p.pt-progress__label', label);
  const pct = el('span.pt-progress__pct', '');
  stage.replaceChildren(el('div.pt-progress', { role: 'status', 'aria-live': 'polite' },
    el('div.pt-progress__head', text, pct),
    el('div.pt-progress__track', bar),
    el('p.pt-hint', t('Everything runs on your device, so big files take a moment. You can keep using other tabs.'))));
  bar.classList.add('is-indeterminate');
  return (fraction, nextLabel) => {
    if (nextLabel) text.textContent = nextLabel;
    if (typeof fraction === 'number') {
      bar.classList.remove('is-indeterminate');
      const v = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
      bar.style.width = `${v}%`;
      pct.textContent = `${v}%`;
    }
  };
}

/**
 * Result screen.
 * @param {HTMLElement} stage
 * @param {{name:string, bytes?:Uint8Array, blob?:Blob, mime?:string}[]} files
 * @param {{stat?:string, note?:string, nextTools?:string[], routes:Object, onRestart:Function}} opt
 */
export async function showResult(stage, files, opt) {
  const normalized = files.map(f => ({
    name: f.name,
    blob: f.blob || new Blob([f.bytes], { type: f.mime || 'application/pdf' }),
  }));
  const total = normalized.reduce((sum, f) => sum + f.blob.size, 0);

  const downloadAll = async () => {
    if (normalized.length === 1) return triggerDownload(normalized[0].blob, normalized[0].name);
    const { zipSync } = await fflate();
    const entries = {};
    for (const f of normalized) entries[f.name] = [new Uint8Array(await f.blob.arrayBuffer()), { level: 0 }];
    triggerDownload(new Blob([zipSync(entries)], { type: 'application/zip' }), opt.zipName || 'files-online.zip');
  };

  const list = normalized.length > 1
    ? el('ul.pt-result__files', normalized.map(f => el('li',
      el('span.pt-result__name', f.name),
      el('span.pt-result__size', formatBytes(f.blob.size)),
      button(t('Download'), () => triggerDownload(f.blob, f.name), 'ghost'))))
    : null;

  const single = normalized.length === 1 ? normalized[0] : null;
  const canContinue = single && single.blob.type === 'application/pdf';
  const next = canContinue
    ? (opt.nextTools || []).map(id => opt.routes[id]).filter(Boolean)
    : [];

  stage.replaceChildren(el('div.pt-result',
    el('div.pt-result__mark', { 'aria-hidden': 'true' }, '✓'),
    el('h2.pt-result__title', opt.title || t('Your file is ready')),
    opt.stat ? el('p.pt-result__stat', opt.stat) : null,
    opt.note ? notice(opt.note) : null,
    single ? el('p.pt-result__filename', `${single.name} · ${formatBytes(total)}`) : null,
    el('div.pt-result__actions',
      button(normalized.length > 1 ? t('Download all as ZIP') : t('Download'), downloadAll, 'primary'),
      button(t('Start over'), opt.onRestart, 'ghost')),
    list,
    next.length ? el('div.pt-next',
      el('h3.pt-next__title', t('Continue with this file')),
      el('div.pt-next__list', next.map(route => el('a.pt-next__link', {
        href: `${route.url}?handoff=1`,
        onclick: async ev => {
          ev.preventDefault();
          await saveHandoff(single.name, single.blob);
          location.href = `${route.url}?handoff=1`;
        },
      }, route.name)))) : null,
    el('p.pt-result__privacy', t('This file was made on your device and has not been sent anywhere.'))));
  stage.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
