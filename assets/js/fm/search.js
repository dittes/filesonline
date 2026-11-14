// search.js
// "Search inside files": looks through the text of the given files and lists the hits.

import { el, fill, btn, dialog, pause } from './dom.js';
import { t, fmtNum, collator } from './i18n.js';
import { joinPath } from './store.js';
import { iconHtml, isTextLike } from './kinds.js';
import { analysis } from './preview.js';

const TEXT_LIMIT = 5e6;
const DOC_LIMIT = 48e6;
const DOC_KINDS = new Set(['pdf', 'document', 'sheet', 'slides', 'email']);
const MIN_CHARS = 2;
const CONTEXT = 60;
const MAX_SNIPPETS = 3;

// Extracted text per item id, kept so a second search is instant. null = nothing to search.
const cache = new Map();

async function textOf(item) {
  if (cache.has(item.id)) return cache.get(item.id);
  let text = null;
  try {
    if (isTextLike(item)) {
      if (item.size <= TEXT_LIMIT) text = await item.file.text();
    } else if (DOC_KINDS.has(item.kind)) {
      if (item.size <= DOC_LIMIT) text = (await analysis(item))?.text ?? null;
    }
  } catch {
    text = null;
  }
  if (typeof text !== 'string') text = null;
  cache.set(item.id, text);
  return text;
}

const canSearch = item => isTextLike(item) || DOC_KINDS.has(item.kind);

function makePattern(query, matchCase, whole) {
  const src = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(whole ? `(?<![\\p{L}\\p{N}_])${src}(?![\\p{L}\\p{N}_])` : src, matchCase ? 'gu' : 'giu');
}

function findHits(text, pattern) {
  let count = 0;
  const snippets = [];
  pattern.lastIndex = 0;
  for (let m; (m = pattern.exec(text));) {
    if (!m[0]) { pattern.lastIndex++; continue; }
    count++;
    if (snippets.length < MAX_SNIPPETS) snippets.push([m.index, m[0].length]);
  }
  return { count, snippets };
}

function snippetNode(text, [at, len]) {
  const from = Math.max(0, at - CONTEXT);
  const to = Math.min(text.length, at + len + CONTEXT);
  const clean = s => s.replace(/\s+/g, ' ');
  return el('p.fm-csearch__snippet',
    from > 0 ? '… ' : null,
    clean(text.slice(from, at)),
    el('mark', clean(text.slice(at, at + len))),
    clean(text.slice(at + len, to)),
    to < text.length ? ' …' : null);
}

export function contentSearchDialog(items, { reveal } = {}) {
  const input = el('input.fm-input', { type: 'search', autocomplete: 'off', spellcheck: false, placeholder: t('Text to look for'), 'aria-label': t('Text to look for') });
  const caseBox = el('input', { type: 'checkbox' });
  const wordBox = el('input', { type: 'checkbox' });
  const goBtn = btn(t('Search'), () => run(), { variant: 'primary', ico: 'search' });
  const stopBtn = btn(t('Stop'), () => { cancelled = true; }, { variant: 'secondary' });
  stopBtn.hidden = true;
  const status = el('p.fm-csearch__status', { role: 'status', 'aria-live': 'polite' });
  const list = el('ul.fm-csearch__list');

  let cancelled = false;
  let running = false;
  let shut = false;

  const ui = dialog({
    title: t('Search inside files'),
    size: 'l',
    className: 'fm-csearch',
    body: el('div.fm-csearch__body',
      el('div.fm-csearch__bar', input, goBtn, stopBtn),
      el('div.fm-csearch__opts',
        el('label.fm-opt', caseBox, el('span', t('Match case'))),
        el('label.fm-opt', wordBox, el('span', t('Whole words')))),
      status,
      list),
  });
  ui.closed.then(() => { shut = true; cancelled = true; });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  setTimeout(() => input.focus());

  const message = text => { status.textContent = text; status.classList.remove('fm-csearch__status--warn'); };

  function resultNode(item, text, { count, snippets }) {
    const path = joinPath(item.dir, item.name);
    const open = () => { ui.close(); reveal?.(item); };
    return el('li.fm-csearch__item',
      el('button.fm-csearch__hit', { type: 'button', onclick: open },
        el('span.fm-csearch__head',
          el('span.fm-csearch__icon', { html: iconHtml(item) }),
          el('span.fm-csearch__path', path),
          el('span.fm-tag', t('Hits: {n}', { n: fmtNum(count) }))),
        snippets.map(s => snippetNode(text, s))));
  }

  async function run() {
    if (running) return;
    const query = input.value.trim();
    if (query.length < MIN_CHARS) {
      status.textContent = t('Type at least 2 characters.');
      status.classList.add('fm-csearch__status--warn');
      input.focus();
      return;
    }
    const pattern = makePattern(query, caseBox.checked, wordBox.checked);
    const files = [...items].sort((a, b) => collator.compare(joinPath(a.dir, a.name), joinPath(b.dir, b.name)));
    running = true;
    cancelled = false;
    goBtn.disabled = true;
    stopBtn.hidden = false;
    fill(list);
    let done = 0, withHits = 0, searched = 0, skipped = 0;
    message(t('Searching: {done} of {total}', { done: 0, total: fmtNum(files.length) }));

    for (const item of files) {
      if (cancelled) break;
      if (!canSearch(item)) {
        skipped++;
      } else {
        const text = await textOf(item);
        if (cancelled) break;
        if (text === null) {
          skipped++;
        } else {
          searched++;
          const hits = findHits(text, pattern);
          if (hits.count) {
            withHits++;
            list.append(resultNode(item, text, hits));
          }
        }
      }
      done++;
      message(t('Searching: {done} of {total}', { done: fmtNum(done), total: fmtNum(files.length) }));
      await pause();
    }

    running = false;
    if (shut) return;
    goBtn.disabled = false;
    stopBtn.hidden = true;
    const stopped = cancelled;
    const summary = t('Files with hits: {hits}. Files searched: {searched}. Files skipped: {skipped}.', {
      hits: fmtNum(withHits), searched: fmtNum(searched), skipped: fmtNum(skipped + (files.length - done)),
    });
    message(stopped ? `${t('Stopped.')} ${summary}` : summary);
    if (!withHits) {
      list.append(el('li.fm-blank', el('p', stopped ? t('Nothing found before the search was stopped.') : t('Nothing found.')),
        skipped ? el('p.fm-csearch__note', t('Some files cannot be searched, for example images or very large files.')) : null));
    }
  }

  return ui;
}
