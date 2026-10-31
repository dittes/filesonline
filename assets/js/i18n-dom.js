// i18n-dom.js
// Translates the UI of the file manager, MD viewer and MBOX viewer. Those apps render
// English strings from many modules, so instead of threading a t() through them this
// translates what reaches the DOM, using window.__FO_DICT from assets/i18n/app.<lang>.js.
//
// Runs on the MutationObserver microtask, before the browser paints, so English never
// flashes. User content is off limits: see SKIP.

(function () {
  const dict = window.__FO_DICT;
  if (!dict) return;

  // Anything the user owns: file names and contents, emails, documents being edited.
  // A file called "Delete" must keep its name.
  const SKIP = [
    'script', 'style', 'code', 'pre', 'textarea', 'iframe', '[contenteditable]', '[data-no-i18n]',
    '.s-header', '.s-footer', '.s-section', '.s-toolhead', '.s-crumbs', '.fi',
    'td.col-name', 'td.col-path', 'td.col-ext', 'td.col-size', 'td.col-modified', '.file-grid-name', '.file-grid-meta', '.breadcrumb',
    '.tree-item:not(.tree-item--all) .tree-item__label', '.preview-filename', '.preview-header-name', '.preview-content', '.preview-body',
    '.result-table td', '.rename-preview td', '.tools-file-name', '.tools-dup-item', '.archive-file-name', '.archive-entry-name',
    '.command-palette-file',
    '#mdv-preview', '#mdv-toc-list', '#mdv-filename', '#mdv-html-output',
    '.mbx-list-inner', '.mbx-viewer-subject', '.mbx-viewer-meta', '.mbx-archive-name', '#mbx-sidebar-senders', '#mbx-sidebar-labels', '#mbx-sidebar-archives',
    '.mbx-att-name', '.mbx-attachment-name',
  ].join(',');

  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'data-tooltip'];

  const exact = new Map();
  const patterns = [];
  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  for (const [key, value] of Object.entries(dict)) {
    if (!/\{[a-z]\}|\(s\)/.test(key)) { exact.set(key, value); continue; }
    const names = [];
    const source = key
      .split(/(\{[a-z]\}|\(s\))/)
      .map(part => {
        if (part === '(s)') return 's?';
        const m = part.match(/^\{([a-z])\}$/);
        if (!m) return escapeRe(part);
        names.push(m[1]);
        return 'nm'.includes(m[1]) ? '([\\d.,\\s\\u00a0]+?)' : '(.+?)';
      })
      .join('');
    patterns.push({ re: new RegExp(`^${source}$`), names, value, specificity: key.replace(/\{[a-z]\}|\(s\)/g, '').length });
  }
  // Longer literal parts first, so "{n} messages selected." beats "{x} · {n} messages"
  patterns.sort((a, b) => b.specificity - a.specificity);

  const memo = new Map();
  const translated = new Set(Object.values(dict));

  function translate(raw) {
    const key = raw.replace(/\s+/g, ' ').trim();
    if (!key || !/\p{L}/u.test(key)) return null;
    if (exact.has(key)) return exact.get(key);
    if (memo.has(key)) return memo.get(key);
    let out = null;
    for (const p of patterns) {
      const m = key.match(p.re);
      if (m) {
        out = p.value;
        p.names.forEach((name, i) => { out = out.replaceAll(`{${name}}`, m[i + 1]); });
        break;
      }
    }
    if (memo.size > 2000) memo.clear();
    memo.set(key, out);
    if (out === null && window.__FO_MISSING && !translated.has(key)) window.__FO_MISSING.add(key);
    return out;
  }

  function translateText(node) {
    const parent = node.parentElement;
    if (!parent || parent.closest(SKIP)) return;
    const hit = translate(node.nodeValue);
    if (hit !== null && hit !== node.nodeValue) {
      const lead = node.nodeValue.match(/^\s*/)[0];
      const trail = node.nodeValue.match(/\s*$/)[0];
      const next = lead + hit + trail;
      if (next !== node.nodeValue) node.nodeValue = next;
    }
  }

  function translateAttrs(el) {
    for (const attr of ATTRS) {
      if (!el.hasAttribute(attr)) continue;
      const hit = translate(el.getAttribute(attr));
      if (hit !== null && hit !== el.getAttribute(attr)) el.setAttribute(attr, hit);
    }
  }

  function walk(root) {
    if (root.nodeType === Node.TEXT_NODE) { translateText(root); return; }
    if (root.nodeType !== Node.ELEMENT_NODE || root.closest(SKIP)) return;
    translateAttrs(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: n => (n.nodeType === Node.ELEMENT_NODE && n.matches(SKIP)
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) translateText(n);
      else translateAttrs(n);
    }
  }

  const observer = new MutationObserver(records => {
    for (const r of records) {
      if (r.type === 'childList') r.addedNodes.forEach(walk);
      else if (r.type === 'characterData') translateText(r.target);
      else if (r.type === 'attributes' && !r.target.closest(SKIP)) translateAttrs(r.target);
    }
  });

  function start() {
    walk(document.body);
    observer.observe(document.body, {
      childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS,
    });
  }

  // Native dialogs bypass the DOM
  for (const name of ['confirm', 'alert', 'prompt']) {
    const original = window[name].bind(window);
    window[name] = (message, ...rest) => original(translate(String(message ?? '')) ?? message, ...rest);
  }

  // QA aid: ?i18n-debug collects strings that reached the DOM without a translation
  if (new URLSearchParams(location.search).has('i18n-debug')) window.__FO_MISSING = new Set();

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
