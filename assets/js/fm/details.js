// details.js
// The pane on the right: a preview and facts for one file, a summary for several,
// and for every selection the things you can do with it, here or in another tool.

import { el, btn, icon, iconBtn, download, fill } from './dom.js';
import { t, fmtBytes, fmtDateTime, fmtNum } from './i18n.js';
import { S, expand, isFolderKey, leafOf, navigate, isSearching } from './store.js';
import { KINDS, KIND_LABEL, KIND_COLOR, iconHtml, isArchive } from './kinds.js';
import { renderPreview, analysis, inspectLabel, ANALYZE_LIMIT } from './preview.js';
import * as A from './actions.js';
import * as dialogs from './dialogs.js';

const facts = pairs => el('dl.fm-facts', pairs.filter(p => p && p[1]).flatMap(([k, v]) => [el('dt', k), el('dd', v)]));
const section = (title, ...children) => el('section.fm-dsec', title ? el('h3.fm-dsec__title', title) : null, children);

function actionList(entries) {
  return el('div.fm-actions', entries.filter(Boolean).map(a => el(`button.fm-action${a.danger ? '.is-danger' : ''}`, { type: 'button', onclick: a.run },
    icon(a.ico || 'files'), el('span.fm-action__label', a.label), a.hint ? el('span.fm-action__hint', a.hint) : null,
    a.external ? icon('external', 'fm-i fm-action__ext') : null)));
}

function breakdown(files) {
  const by = new Map();
  for (const it of files) {
    const s = by.get(it.kind) || by.set(it.kind, { count: 0, size: 0 }).get(it.kind);
    s.count++; s.size += it.size;
  }
  const total = files.reduce((sum, it) => sum + it.size, 0) || 1;
  const kinds = KINDS.filter(k => by.has(k)).sort((a, b) => by.get(b).size - by.get(a).size);
  if (!kinds.length) return null;
  return el('div.fm-breakdown',
    el('div.fm-meter', { 'aria-hidden': 'true' }, kinds.map(k => el('span', { style: { width: `${Math.max(1.5, by.get(k).size / total * 100)}%`, background: KIND_COLOR[k] } }))),
    el('ul', kinds.map(k => el('li', el('span.fm-kind__dot', { style: { background: KIND_COLOR[k] } }), el('span', t(KIND_LABEL[k])),
      el('span.fm-breakdown__n', fmtNum(by.get(k).count)), el('span.fm-breakdown__size', fmtBytes(by.get(k).size))))));
}

function suggestionSections(files) {
  const { here, tools } = A.suggestions(files);
  return [
    here.length ? section(t('Do it right here'), actionList(here), el('p.fm-dsec__hint', t('The result is added to this folder.'))) : null,
    tools.length ? section(t('Open with'), actionList(tools),
      el('button.fm-linkbtn', { type: 'button', onclick: A.openToolPalette }, t('All tools…')),
      el('p.fm-dsec__hint', t('Opens in a new tab with the file already loaded. Nothing is uploaded.'))) : null,
  ];
}

export function createDetails(host, { reveal, openQuickLook, close }) {
  let signature = '';
  let version = 0;

  const head = (title, sub) => el('header.fm-dhead',
    el('div.fm-dhead__text', el('h2', { title }, title), sub ? el('p', sub) : null),
    iconBtn('x', t('Close details'), close, { className: 'fm-iconbtn fm-dhead__close' }));

  function folderView(stats) {
    const searching = isSearching();
    const files = searching ? [] : [...S.items.values()].filter(it => !S.cwd || it.dir === S.cwd || it.dir.startsWith(`${S.cwd}/`));
    const s = stats.get(S.cwd) || { count: 0, size: 0 };
    const largest = [...files].sort((a, b) => b.size - a.size).slice(0, 5);
    return [
      head(S.cwd ? leafOf(S.cwd) : t('Workspace'), t('Files: {n} · {size}', { n: fmtNum(s.count), size: fmtBytes(s.size) })),
      el('div.fm-dbody',
        files.length ? section(t('What is in here'), breakdown(files)) : null,
        largest.length > 1 ? section(t('Largest files'), el('ul.fm-toplist', largest.map(it => el('li', el('button', { type: 'button', onclick: () => reveal(it) },
          el('span', { html: iconHtml(it) }), el('span.fm-toplist__name', it.name), el('span.fm-toplist__size', fmtBytes(it.size))))))) : null,
        files.length ? section(t('Workspace tools'), actionList([
          { label: t('Download everything as ZIP'), ico: 'zip', run: () => A.zip([]) },
          A.canSaveToFolder && { label: t('Save to a folder on this device'), ico: 'save', run: A.saveToFolder },
          { label: t('Find duplicates'), ico: 'duplicate', run: A.findDuplicates },
          { label: t('Rename many files'), ico: 'rename', run: A.renameAll },
          { label: t('Export file list'), ico: 'table', run: A.exportList },
          { label: t('All PDF and file tools'), ico: 'wand', run: A.openToolPalette },
        ])) : null,
        el('p.fm-dnote', icon('info'), el('span', t('Select a file to preview it and see which tools fit.')))),
    ];
  }

  function fileView(item) {
    const preview = el('div.fm-preview');
    const dims = el('dd');
    const insight = el('div.fm-insight');
    const factList = facts([
      [t('Type'), item.ext && item.ext.toUpperCase() !== t(KIND_LABEL[item.kind]) ? `${item.ext.toUpperCase()} · ${t(KIND_LABEL[item.kind])}` : t(KIND_LABEL[item.kind])],
      [t('Size'), `${fmtBytes(item.size)} (${fmtNum(item.size)} B)`],
      [t('Changed'), fmtDateTime(item.modified)],
      [t('Folder'), item.dir || t('Workspace')],
    ]);
    renderPreview(item, preview, { onExtract: () => A.extractArchives([item]) });
    preview.addEventListener('fm:meta', () => {
      if (preview.dataset.dims && !dims.isConnected) { dims.textContent = preview.dataset.dims; factList.append(el('dt', t('Dimensions')), dims); }
    });
    preview.addEventListener('dblclick', () => openQuickLook(item.id));

    // What the inspector finds, for files small enough to read in one go
    if (item.size <= Math.min(ANALYZE_LIMIT, 24e6)) {
      const mine = ++version;
      setTimeout(async () => {
        if (mine !== version) return;
        const result = await analysis(item);
        if (mine !== version || !result || !insight.isConnected) return;
        const rows = (result.facts || []).slice(0, 8).map(([k, v]) => [inspectLabel(k), String(v).slice(0, 160)]);
        const warnings = (result.warnings || []).slice(0, 3);
        if (!rows.length && !warnings.length && !result.kind) return;
        fill(insight, section(t('What the inspector found'),
          warnings.map(w => el('p.fm-warn', icon('info'), el('span', w))),
          facts([[t('Detected as'), inspectLabel(result.kind || '')], ...rows])));
      }, 350);
    } else version++;

    return [
      head(item.name, null),
      el('div.fm-dbody',
        preview,
        el('div.fm-dquick',
          btn(t('Quick Look'), () => openQuickLook(item.id), { ico: 'eye', variant: 'secondary', kbd: 'Space' }),
          btn(t('Download'), () => download(item.file, item.name), { ico: 'download', variant: 'secondary' })),
        section(null, factList),
        ...suggestionSections([item]),
        insight,
        section(t('File'), actionList([
          { label: t('Rename'), ico: 'rename', run: A.rename },
          { label: t('Move to folder'), ico: 'move', run: () => dialogs.moveDialog(new Set(S.selection)) },
          { label: t('Checksums'), ico: 'hash', run: A.checksums },
          { label: t('Remove from the workspace'), ico: 'trash', run: A.removeSelection, danger: true },
        ]))),
    ];
  }

  function folderSelected(path, stats) {
    const s = stats.get(path) || { count: 0, size: 0 };
    const files = expand([`dir:${path}`]);
    return [
      head(leafOf(path), t('Folder')),
      el('div.fm-dbody',
        el('div.fm-dicon', { html: iconHtml({ isFolder: true }) }),
        section(null, facts([[t('Files'), fmtNum(s.count)], [t('Size'), fmtBytes(s.size)], [t('Changed'), fmtDateTime(s.modified)]])),
        files.length ? section(t('What is in here'), breakdown(files)) : null,
        section(t('Folder'), actionList([
          { label: t('Open'), ico: 'folder', run: () => navigate(path) },
          { label: t('Download as ZIP'), ico: 'zip', run: () => A.zip() },
          { label: t('Rename'), ico: 'rename', run: A.rename },
          { label: t('Move to folder'), ico: 'move', run: () => dialogs.moveDialog(new Set(S.selection)) },
          { label: t('Remove from the workspace'), ico: 'trash', run: A.removeSelection, danger: true },
        ]))),
    ];
  }

  function multiView() {
    const files = A.targets();
    const onlyFiles = [...S.selection].every(k => !isFolderKey(k));
    const total = files.reduce((sum, it) => sum + it.size, 0);
    return [
      head(t('Selected: {n}', { n: fmtNum(S.selection.size) }), t('Files: {n} · {size}', { n: fmtNum(files.length), size: fmtBytes(total) })),
      el('div.fm-dbody',
        files.length ? section(t('What is selected'), breakdown(files)) : null,
        ...(onlyFiles ? suggestionSections(files) : []),
        section(t('Selection'), actionList([
          { label: t('Download as ZIP'), ico: 'zip', run: () => A.zip() },
          files.length && files.every(isArchive) ? { label: t('Extract here'), ico: 'unzip', run: () => A.extractArchives() } : null,
          { label: t('Rename with a pattern'), ico: 'rename', run: A.rename },
          { label: t('Move to folder'), ico: 'move', run: () => dialogs.moveDialog(new Set(S.selection)) },
          { label: t('Find duplicates among them'), ico: 'duplicate', run: A.findDuplicates },
          onlyFiles ? { label: t('Checksums'), ico: 'hash', run: A.checksums } : null,
          { label: t('Remove from the workspace'), ico: 'trash', run: A.removeSelection, danger: true },
        ]))),
    ];
  }

  let itemsVersion = 0;
  return {
    render(topics, stats) {
      if (topics.has('items')) itemsVersion++;
      host.hidden = !S.details;
      if (!S.details) { signature = ''; return; }
      const next = `${[...S.selection].join(',')}|${S.cwd}|${S.query}|${S.kind}|${itemsVersion}`;
      if (next === signature) return;
      signature = next;
      const keys = [...S.selection];
      let view;
      if (!keys.length) { version++; view = folderView(stats); }
      else if (keys.length === 1 && isFolderKey(keys[0])) { version++; view = folderSelected(keys[0].slice(4), stats); }
      else if (keys.length === 1 && S.items.has(keys[0])) view = fileView(S.items.get(keys[0]));
      else { version++; view = multiView(); }
      const scroll = host.querySelector('.fm-dbody')?.scrollTop || 0;
      fill(host, ...view.flat().filter(Boolean));
      if (keys.length !== 1) host.querySelector('.fm-dbody').scrollTop = scroll;
    },
  };
}
