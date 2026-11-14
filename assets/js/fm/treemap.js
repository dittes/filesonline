// treemap.js
// A squarified treemap of one folder: bigger tiles are bigger files or folders.

import { el, btn, dialog, fill } from './dom.js';
import { t, fmtBytes, fmtNum } from './i18n.js';
import { S, folderStats, parentOf, leafOf } from './store.js';
import { KIND_COLOR } from './kinds.js';

const HEIGHT = 520;
const MIN_SHARE = 0.004;

// Squarified layout (Bruls et al.). `nodes` need a `value`; returns them with x, y, w, h.
function squarify(nodes, x, y, w, h) {
  const total = nodes.reduce((s, n) => s + n.value, 0);
  if (!total || w <= 0 || h <= 0) return [];
  const scale = (w * h) / total;
  const queue = [...nodes].sort((a, b) => b.value - a.value).map(n => ({ n, area: n.value * scale }));
  const placed = [];
  let rect = { x, y, w, h };

  // Worst aspect ratio of a row laid along the short side.
  const worst = (row, side) => {
    const sum = row.reduce((s, r) => s + r.area, 0);
    const max = Math.max(...row.map(r => r.area));
    const min = Math.min(...row.map(r => r.area));
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };

  const layoutRow = row => {
    const sum = row.reduce((s, r) => s + r.area, 0);
    const horizontal = rect.w >= rect.h; // row becomes a column on the left when wide
    const side = horizontal ? rect.h : rect.w;
    const thick = sum / side;
    let offset = 0;
    for (const r of row) {
      const len = r.area / thick;
      placed.push(horizontal
        ? { ...r.n, x: rect.x, y: rect.y + offset, w: thick, h: len }
        : { ...r.n, x: rect.x + offset, y: rect.y, w: len, h: thick });
      offset += len;
    }
    rect = horizontal
      ? { x: rect.x + thick, y: rect.y, w: rect.w - thick, h: rect.h }
      : { x: rect.x, y: rect.y + thick, w: rect.w, h: rect.h - thick };
  };

  let row = [];
  while (queue.length) {
    const side = Math.min(rect.w, rect.h);
    const next = queue[0];
    if (!row.length || worst([...row, next], side) <= worst(row, side)) {
      row.push(queue.shift());
    } else {
      layoutRow(row);
      row = [];
    }
  }
  if (row.length) layoutRow(row);
  return placed;
}

export function treemapDialog({ reveal, navigate, start = '' } = {}) {
  let path = S.folders.has(start) || !start ? start : '';
  const stats = folderStats();
  const map = el('div.fm-treemap__map', { style: { height: `${HEIGHT}px` } });
  const crumbs = el('nav.fm-treemap__crumbs', { 'aria-label': t('Path') });
  const info = el('p.fm-treemap__info');
  const open = btn(t('Open this folder in the list'), () => { d.close(); navigate?.(path); }, { variant: 'primary', ico: 'folder' });

  const d = dialog({
    title: t('Disk usage map'), size: 'l',
    body: el('div.fm-treemap', crumbs, map, info),
    footer: [open, btn(t('Close'), () => d.close())],
  });

  function childrenOf(dir) {
    const nodes = [];
    for (const [p, s] of stats) {
      if (p && parentOf(p) === dir && s.size > 0) nodes.push({ type: 'folder', path: p, name: leafOf(p), value: s.size, size: s.size });
    }
    for (const it of S.items.values()) {
      if (it.dir === dir && it.size > 0) nodes.push({ type: 'file', item: it, name: it.name, value: it.size, size: it.size });
    }
    const total = nodes.reduce((s, n) => s + n.value, 0);
    const small = nodes.filter(n => n.type === 'file' && n.value / total < MIN_SHARE);
    // One grouped tile only makes sense when it replaces at least two files.
    if (small.length < 2) return nodes;
    const size = small.reduce((s, n) => s + n.value, 0);
    return [...nodes.filter(n => !small.includes(n)), { type: 'other', name: t('Other files: {n}', { n: fmtNum(small.length) }), value: size, size }];
  }

  function tile(node) {
    const label = node.name;
    const full = `${node.name} (${fmtBytes(node.size)})`;
    const style = { left: `${node.x}px`, top: `${node.y}px`, width: `${Math.max(0, node.w - 2)}px`, height: `${Math.max(0, node.h - 2)}px` };
    if (node.type === 'file') {
      const c = KIND_COLOR[node.item.kind] || KIND_COLOR.other;
      style.background = `color-mix(in srgb, ${c} 22%, var(--s-sheet))`;
      style.borderLeftColor = c;
    }
    const showName = node.w > 70 && node.h > 26;
    const showSize = node.w > 70 && node.h > 44;
    return el(`button.fm-treemap__tile.fm-treemap__tile--${node.type}`, {
      type: 'button', title: full, style,
      onclick: () => {
        if (node.type === 'folder') { path = node.path; render(); } else if (node.type === 'file') { d.close(); reveal?.(node.item); } else { d.close(); navigate?.(path); }
      },
    }, showName ? el('span.fm-treemap__name', label) : null, showSize ? el('span.fm-treemap__size', fmtBytes(node.size)) : null);
  }

  function layout() {
    const w = map.clientWidth;
    const nodes = childrenOf(path);
    fill(map, ...squarify(nodes, 0, 0, w, HEIGHT).map(tile));
    if (!nodes.length) fill(map, el('div.fm-blank', el('p', t('This folder has no files with content.'))));
  }

  function render() {
    const parts = path ? path.split('/') : [];
    const trail = [t('Workspace'), ...parts];
    fill(crumbs, ...trail.flatMap((name, i) => {
      const target = parts.slice(0, i).join('/');
      const last = i === trail.length - 1;
      return [
        i ? el('span.fm-treemap__sep', '>') : null,
        el('button.fm-treemap__crumb', { type: 'button', disabled: last, onclick: () => { path = target; render(); } }, name),
      ];
    }));
    const s = stats.get(path) || { count: 0, size: 0 };
    info.textContent = t('Total size: {size}, files: {n}', { size: fmtBytes(s.size), n: fmtNum(s.count) });
    layout();
  }

  let lastWidth = 0;
  const observer = new ResizeObserver(() => {
    if (map.clientWidth && map.clientWidth !== lastWidth) { lastWidth = map.clientWidth; layout(); }
  });
  observer.observe(map);
  d.closed.then(() => observer.disconnect());
  render();
}
