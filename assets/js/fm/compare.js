// compare.js
// Compare two folders of the workspace: what is only on one side, what differs.

import { el, btn, dialog, task, toast, download, fill } from './dom.js';
import { t, fmtBytes, fmtNum, collator } from './i18n.js';
import { S, addFiles, joinPath, parentOf, leafOf } from './store.js';
import { iconHtml } from './kinds.js';
import { hashFile, toCsv } from './dialogs.js';

const label = path => (path ? path : t('Workspace'));
const inside = (path, folder) => !folder || path === folder || path.startsWith(`${folder}/`);

// Files below a folder, keyed by their path relative to it.
function filesOf(folder) {
  const map = new Map();
  for (const it of S.items.values()) {
    if (!inside(it.dir, folder)) continue;
    const rest = folder ? it.dir.slice(folder.length + 1) : it.dir;
    map.set(joinPath(rest, it.name), it);
  }
  return map;
}

export function compareFoldersDialog({ reveal, preselect = [] } = {}) {
  const folders = ['', ...[...S.folders].sort(collator.compare)];
  const options = (value) => folders.map(f => el('option', { value: f, selected: f === value }, label(f)));
  const pick = (value, fallback) => (folders.includes(value) ? value : fallback);
  const selA = el('select.fm-input', options(pick(preselect[0], folders[0])));
  const selB = el('select.fm-input', options(pick(preselect[1], folders[1] ?? folders[0])));
  const deep = el('input', { type: 'checkbox' });
  const error = el('p.fm-error', { hidden: true, role: 'alert' });
  const out = el('div.fm-compare__out');
  const field = (text, control) => el('label.fm-field', el('span.fm-field__label', text), control);
  let result = null;

  const copyBtn = btn(t('Copy missing files to B'), copyMissing, { ico: 'copy' });
  const csvBtn = btn(t('Export report (CSV)'), exportCsv, { ico: 'table' });
  copyBtn.hidden = csvBtn.hidden = true;

  const d = dialog({
    title: t('Compare folders'), size: 'l',
    body: el('div.fm-compare',
      el('div.fm-form',
        el('div.fm-form__row', field(t('Folder A'), selA), field(t('Folder B'), selB)),
        el('label.fm-opt', deep, el('span', t('Compare file contents (slower, exact)'))),
        error),
      out),
    footer: [csvBtn, copyBtn, btn(t('Compare'), run, { variant: 'primary' }), btn(t('Close'), () => d.close())],
  });

  function invalidate() { result = null; copyBtn.hidden = csvBtn.hidden = true; fill(out); }
  d.body.addEventListener('change', invalidate);

  async function run() {
    const a = selA.value;
    const b = selB.value;
    error.hidden = true;
    invalidate();
    if (a === b) return fail(t('Pick two different folders.'));
    if (inside(a, b) || inside(b, a)) return fail(t('One folder contains the other. Pick two separate folders.'));

    const mapA = filesOf(a);
    const mapB = filesOf(b);
    const exact = deep.checked;
    const res = await task(t('Comparing folders…'), async (progress, signal) => {
      const onlyA = [];
      const onlyB = [];
      const diff = [];
      let same = 0;
      const pairs = [];
      for (const [rel, x] of mapA) {
        const y = mapB.get(rel);
        if (!y) onlyA.push({ rel, a: x });
        else if (x.size !== y.size) diff.push({ rel, a: x, b: y });
        else if (exact && x.size > 0) pairs.push({ rel, a: x, b: y });
        else same++;
      }
      for (const [rel, y] of mapB) if (!mapA.has(rel)) onlyB.push({ rel, b: y });
      let done = 0;
      for (const p of pairs) {
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        const [ha, hb] = await Promise.all([hashFile(p.a.file), hashFile(p.b.file)]);
        if (ha === hb) same++; else diff.push(p);
        progress(++done / pairs.length);
      }
      const byRel = (x, y) => collator.compare(x.rel, y.rel);
      return { onlyA: onlyA.sort(byRel), onlyB: onlyB.sort(byRel), diff: diff.sort(byRel), same };
    });
    if (!res) return;
    result = { ...res, a, b };
    show();
  }

  function fail(message) { error.textContent = message; error.hidden = false; }

  const row = (rel, item, extra) => el('li', el('button.fm-compare__row', {
    type: 'button',
    onclick: () => { d.close(); reveal?.(item); },
  }, el('span', { html: iconHtml(item) }), el('span.fm-compare__path', rel), extra));

  const section = (title, rows, build) => el('details.fm-compare__list', { open: rows.length > 0 && rows.length <= 50 },
    el('summary', el('span', title), el('span.fm-tag', fmtNum(rows.length))),
    rows.length
      ? el('ul', rows.slice(0, 500).map(build), rows.length > 500 ? el('li.fm-compare__more', t('Showing the first {n}. The CSV report has all of them.', { n: fmtNum(500) })) : null)
      : el('p.fm-compare__empty', t('Nothing here.')));

  function show() {
    const { onlyA, onlyB, diff, same } = result;
    const stat = (n, text) => el('div', el('strong', fmtNum(n)), el('span', text));
    fill(out,
      el('div.fm-statrow.fm-compare__stats',
        stat(onlyA.length, t('Only in A')), stat(onlyB.length, t('Only in B')),
        stat(diff.length, t('Different')), stat(same, t('Identical'))),
      section(t('Only in A'), onlyA, r => row(r.rel, r.a, el('span.fm-compare__size', fmtBytes(r.a.size)))),
      section(t('Only in B'), onlyB, r => row(r.rel, r.b, el('span.fm-compare__size', fmtBytes(r.b.size)))),
      section(t('Different'), diff, r => {
        const aNewer = r.a.modified >= r.b.modified;
        return row(r.rel, r.a, [
          el('span.fm-compare__size', `A ${fmtBytes(r.a.size)} / B ${fmtBytes(r.b.size)}`),
          el('span.fm-tag.fm-tag--new', aNewer ? t('A is newer') : t('B is newer')),
        ]);
      }));
    csvBtn.hidden = false;
    copyBtn.hidden = !onlyA.length;
  }

  function exportCsv() {
    if (!result) return;
    const iso = ms => (ms ? new Date(ms).toISOString() : '');
    const rows = [['status', 'path', 'bytes_a', 'bytes_b', 'modified_a', 'modified_b']];
    const add = (status, r) => rows.push([status, r.rel, r.a ? r.a.size : '', r.b ? r.b.size : '', iso(r.a?.modified), iso(r.b?.modified)]);
    result.onlyA.forEach(r => add('only_a', r));
    result.onlyB.forEach(r => add('only_b', r));
    result.diff.forEach(r => add('different', r));
    download(new Blob([toCsv(rows)], { type: 'text/csv' }), 'folder-comparison.csv');
  }

  function copyMissing() {
    if (!result?.onlyA.length) return;
    const list = result.onlyA.map(r => ({ file: r.a.file, name: leafOf(r.rel), dir: joinPath(result.b, parentOf(r.rel)) }));
    const added = addFiles(list, { made: true });
    toast(t('Copied to B: {n}', { n: fmtNum(added.length) }), { kind: 'success' });
    d.close();
  }
}
