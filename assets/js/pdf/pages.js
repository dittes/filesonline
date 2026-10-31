// pages.js
// Page-level UI shared by the tools: the thumbnail grid (select, reorder, rotate)
// and the overlay editor (place, move and resize boxes on rendered pages).

import { openPdfjs } from './lib.js';
import { el, t } from './ui.js';

// ─── Lazy rendering queue ─────────────────────────────────────────────────────

class RenderQueue {
  constructor() { this.jobs = []; this.running = false; }
  add(job) { this.jobs.push(job); this.pump(); }
  async pump() {
    if (this.running) return;
    this.running = true;
    while (this.jobs.length) {
      const job = this.jobs.shift();
      try { await job(); } catch { /* a page that fails to render keeps its placeholder */ }
    }
    this.running = false;
  }
  clear() { this.jobs.length = 0; }
}

async function renderInto(canvas, page, cssWidth, rotation = 0) {
  const base = page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: (cssWidth * dpr) / base.width, rotation: (page.rotate + rotation) % 360 });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport, background: '#ffffff' }).promise;
}

// ─── Thumbnail grid ───────────────────────────────────────────────────────────

/**
 * A grid of page thumbnails drawn from one or more documents.
 * Each entry: {file, page, rotate, selected, blank}.
 *
 * Options: selectable, reorderable, rotatable, removable, selectedLabel,
 * onChange(entries).
 */
export class PageGrid {
  constructor(opts = {}) {
    this.opts = opts;
    this.docs = [];
    this.entries = [];
    this.queue = new RenderQueue();
    this.root = el('div.pg', { role: 'list' });
    this.io = new IntersectionObserver(items => {
      for (const it of items) {
        if (!it.isIntersecting) continue;
        this.io.unobserve(it.target);
        it.target._render?.();
      }
    }, { rootMargin: '300px' });
    this.dragFrom = null;
  }

  /** Add a document and one entry per page. */
  async addDocument(bytes, label) {
    const doc = await openPdfjs(bytes);
    const file = this.docs.push({ doc, label }) - 1;
    for (let page = 0; page < doc.numPages; page++) {
      this.entries.push({ file, page, rotate: 0, selected: !!this.opts.selectedByDefault });
    }
    this.render();
    return doc.numPages;
  }

  destroy() {
    this.queue.clear();
    this.io.disconnect();
    this.docs.forEach(d => d.doc.destroy());
  }

  get selection() {
    return this.entries.filter(e => e.selected);
  }

  changed() {
    this.opts.onChange?.(this.entries);
  }

  setAllSelected(value) {
    this.entries.forEach(e => { e.selected = value; });
    this.render();
    this.changed();
  }

  /** Pick pages by zero-based index in document order (single-document grids). */
  setSelectedIndexes(indexes) {
    const set = new Set(indexes);
    this.entries.forEach(e => { e.selected = set.has(e.page); });
    this.render();
    this.changed();
  }

  rotateAll(delta) {
    const targets = this.selection.length ? this.selection : this.entries;
    targets.forEach(e => { e.rotate = (e.rotate + delta + 360) % 360; });
    this.render();
    this.changed();
  }

  move(from, to) {
    if (to < 0 || to >= this.entries.length || from === to) return;
    const [entry] = this.entries.splice(from, 1);
    this.entries.splice(to, 0, entry);
    this.render();
    this.changed();
  }

  render() {
    const { selectable, reorderable, rotatable, removable } = this.opts;
    this.root.replaceChildren(...this.entries.map((entry, index) => {
      const canvas = el('canvas.pg__canvas', { width: 10, height: 14 });
      const thumb = el('div.pg__thumb', canvas);
      const label = this.docs.length > 1 && !entry.blank
        ? `${this.docs[entry.file].label} · ${entry.page + 1}`
        : (entry.blank ? t('Blank page') : `${entry.page + 1}`);

      const item = el('div.pg__item', { role: 'listitem', draggable: !!reorderable },
        thumb,
        el('div.pg__meta', el('span.pg__label', label)));
      if (entry.selected) item.classList.add('is-selected');
      if (selectable) {
        const box = el('input.pg__select', {
          type: 'checkbox', checked: entry.selected,
          'aria-label': t('Select page {n}', { n: entry.page + 1 }),
          onchange: e => {
            entry.selected = e.target.checked;
            item.classList.toggle('is-selected', entry.selected);
            this.changed();
          },
        });
        thumb.append(box);
        thumb.addEventListener('click', e => {
          if (e.target === box || e.target.closest('button')) return;
          box.checked = !box.checked;
          box.dispatchEvent(new Event('change'));
        });
      }
      const actions = el('div.pg__actions');
      if (rotatable) {
        actions.append(el('button.pg__btn', {
          type: 'button', title: t('Rotate 90° clockwise'), 'aria-label': t('Rotate 90° clockwise'),
          onclick: () => { entry.rotate = (entry.rotate + 90) % 360; this.render(); this.changed(); },
        }, '↻'));
      }
      if (reorderable) {
        actions.append(
          el('button.pg__btn', { type: 'button', title: t('Move earlier'), 'aria-label': t('Move earlier'), disabled: index === 0, onclick: () => this.move(index, index - 1) }, '←'),
          el('button.pg__btn', { type: 'button', title: t('Move later'), 'aria-label': t('Move later'), disabled: index === this.entries.length - 1, onclick: () => this.move(index, index + 1) }, '→'),
        );
      }
      if (removable) {
        actions.append(el('button.pg__btn', {
          type: 'button', title: t('Remove page'), 'aria-label': t('Remove page'),
          onclick: () => { this.entries.splice(index, 1); this.render(); this.changed(); },
        }, '×'));
      }
      if (actions.childElementCount) thumb.append(actions);

      if (reorderable) {
        item.addEventListener('dragstart', e => {
          this.dragFrom = index;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(index));
          item.classList.add('is-dragging');
        });
        item.addEventListener('dragend', () => item.classList.remove('is-dragging'));
        item.addEventListener('dragover', e => { e.preventDefault(); item.classList.add('is-over'); });
        item.addEventListener('dragleave', () => item.classList.remove('is-over'));
        item.addEventListener('drop', e => {
          e.preventDefault();
          item.classList.remove('is-over');
          if (this.dragFrom !== null) this.move(this.dragFrom, index);
          this.dragFrom = null;
        });
      }

      if (!entry.blank) {
        item._render = () => this.queue.add(async () => {
          const page = await this.docs[entry.file].doc.getPage(entry.page + 1);
          await renderInto(canvas, page, 150, entry.rotate);
        });
        this.io.observe(item);
      } else {
        thumb.classList.add('is-blank');
      }
      return item;
    }));
  }
}

// ─── Overlay editor ───────────────────────────────────────────────────────────

let itemId = 0;

/**
 * Renders every page in a scrollable column with an overlay for boxes.
 * Coordinates are fractions of the visible page, so they map directly to ops.frame().
 *
 * opts.mode: current tool; set via setMode(). Modes:
 *   'select'              move/resize only
 *   'box:<type>'          drag on a page to create a box of that type
 *   'click:<type>'        click to create an item (text)
 *   'draw'                freehand stroke
 *   'place'               click to drop opts.stamp (image) at that point
 * opts.onChange(items), opts.single: at most one item per page (crop)
 */
export class PageEditor {
  constructor(bytes, opts = {}) {
    this.bytes = bytes;
    this.opts = opts;
    this.items = [];
    this.mode = opts.mode || 'select';
    this.queue = new RenderQueue();
    this.pages = [];
    this.root = el('div.pe');
    this.selected = null;
    this.defaults = {};
    this.io = new IntersectionObserver(entries => {
      for (const it of entries) {
        if (it.isIntersecting && !it.target._done) { it.target._done = true; it.target._render(); }
      }
    }, { rootMargin: '500px' });
    this.onKey = e => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected && !this.selected.el.querySelector('[contenteditable]:focus')) {
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        e.preventDefault();
        this.remove(this.selected);
      }
    };
    document.addEventListener('keydown', this.onKey);
  }

  async load() {
    this.doc = await openPdfjs(this.bytes);
    for (let n = 1; n <= this.doc.numPages; n++) {
      const page = await this.doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      this.addPage(page, vp, n - 1);
    }
    return this.doc.numPages;
  }

  destroy() {
    document.removeEventListener('keydown', this.onKey);
    this.io.disconnect();
    this.ro?.disconnect();
    this.queue.clear();
    this.doc?.destroy();
  }

  addPage(page, vp, index) {
    const canvas = el('canvas.pe__canvas');
    const layer = el('div.pe__layer');
    const sheet = el('div.pe__page', { style: `aspect-ratio:${vp.width}/${vp.height}` }, canvas, layer);
    const wrap = el('div.pe__wrap', sheet, el('div.pe__num', t('Page {n} of {total}', { n: index + 1, total: this.doc.numPages })));
    const state = { index, sheet, layer, widthPt: vp.width, heightPt: vp.height };
    this.pages.push(state);
    wrap._render = () => this.queue.add(async () => {
      const cssWidth = sheet.clientWidth || 700;
      await renderInto(canvas, page, cssWidth);
    });
    this.io.observe(wrap);
    this.ro ||= new ResizeObserver(() => this.updateScale());
    this.ro.observe(sheet);
    this.wirePage(state);
    this.root.append(wrap);
  }

  updateScale() {
    for (const p of this.pages) {
      const w = p.sheet.clientWidth;
      if (w) p.sheet.style.setProperty('--pe-scale', w / p.widthPt);
    }
  }

  setMode(mode) {
    this.mode = mode;
    this.root.dataset.mode = mode.split(':')[0];
    this.select(null);
  }

  // ─── Creating items ─────────────────────────────────────────────────────────

  wirePage(p) {
    const fraction = e => {
      const r = p.layer.getBoundingClientRect();
      return {
        u: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
        v: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
      };
    };

    p.layer.addEventListener('pointerdown', e => {
      if (e.target !== p.layer) return;
      this.select(null);
      const [kind, type] = this.mode.split(':');
      if (kind === 'select') return;
      e.preventDefault();
      const start = fraction(e);

      if (kind === 'click') {
        const item = this.add({ page: p.index, type, x: start.u, y: start.v, w: 0.2, h: 0.03, ...this.defaults[type] });
        this.opts.onCreated?.(item);
        return;
      }
      if (kind === 'place') {
        const stamp = this.opts.stamp?.();
        if (!stamp) return;
        const w = Math.min(stamp.w, 1 - start.u);
        const h = w * stamp.ratio * (p.widthPt / p.heightPt);
        this.add({ page: p.index, type: 'image', x: start.u, y: start.v, w, h, keepRatio: true, ...stamp });
        this.opts.onCreated?.();
        return;
      }
      if (kind === 'draw') {
        const points = [[start.u, start.v]];
        const svg = this.strokePreview(p);
        const path = svg.querySelector('polyline');
        const move = ev => {
          const f = fraction(ev);
          points.push([f.u, f.v]);
          path.setAttribute('points', points.map(([u, v]) => `${u * 1000},${v * 1000}`).join(' '));
        };
        const up = () => {
          p.layer.removeEventListener('pointermove', move);
          p.layer.removeEventListener('pointerup', up);
          svg.remove();
          if (points.length > 1) this.add({ page: p.index, type: 'draw', points, ...this.defaults.draw });
        };
        p.layer.setPointerCapture(e.pointerId);
        p.layer.addEventListener('pointermove', move);
        p.layer.addEventListener('pointerup', up);
        return;
      }

      // box:<type>: drag out a rectangle
      const ghost = el('div.pe__ghost', { dataset: { type } });
      p.layer.append(ghost);
      const rect = ev => {
        const f = fraction(ev);
        return { x: Math.min(start.u, f.u), y: Math.min(start.v, f.v), w: Math.abs(f.u - start.u), h: Math.abs(f.v - start.v) };
      };
      const move = ev => {
        const r = rect(ev);
        Object.assign(ghost.style, { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });
      };
      const up = ev => {
        p.layer.removeEventListener('pointermove', move);
        p.layer.removeEventListener('pointerup', up);
        ghost.remove();
        const r = rect(ev);
        if (r.w > 0.005 && r.h > 0.005) {
          if (this.opts.single) this.items.filter(i => i.page === p.index).forEach(i => this.remove(i, true));
          this.add({ page: p.index, type, ...r, ...this.defaults[type] });
        }
      };
      p.layer.setPointerCapture(e.pointerId);
      p.layer.addEventListener('pointermove', move);
      p.layer.addEventListener('pointerup', up);
    });
  }

  strokePreview(p) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 1000 1000');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'pe__stroke');
    const line = document.createElementNS(ns, 'polyline');
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', this.defaults.draw?.color || '#000');
    line.setAttribute('stroke-width', '3');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(line);
    p.layer.append(svg);
    return svg;
  }

  add(data) {
    const item = { id: ++itemId, x: 0, y: 0, w: 1, h: 1, ...data };
    this.items.push(item);
    this.mount(item);
    this.select(item);
    this.changed();
    return item;
  }

  remove(item, silent) {
    this.items = this.items.filter(i => i !== item);
    item.el?.remove();
    if (this.selected === item) this.selected = null;
    if (!silent) this.changed();
  }

  clear() {
    [...this.items].forEach(i => this.remove(i, true));
    this.changed();
  }

  changed() { this.opts.onChange?.(this.items); }

  select(item) {
    this.selected?.el?.classList.remove('is-selected');
    this.selected = item;
    item?.el?.classList.add('is-selected');
    this.opts.onSelect?.(item);
  }

  // ─── Item DOM ───────────────────────────────────────────────────────────────

  mount(item) {
    const p = this.pages[item.page];
    const node = el('div.pe__item', { dataset: { type: item.type } });
    item.el = node;
    this.place(item);

    if (item.type === 'draw') {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', '0 0 1000 1000');
      svg.setAttribute('preserveAspectRatio', 'none');
      const line = document.createElementNS(ns, 'polyline');
      line.setAttribute('points', item.points.map(([u, v]) => `${u * 1000},${v * 1000}`).join(' '));
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', item.color || '#000');
      line.setAttribute('stroke-width', '3');
      line.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.append(line);
      node.append(svg);
    } else if (item.type === 'text') {
      const editable = el('div.pe__text', { contentEditable: 'plaintext-only', spellcheck: false, role: 'textbox', 'aria-label': t('Text') });
      editable.textContent = item.text || '';
      editable.addEventListener('input', () => { item.text = editable.innerText.replace(/\n$/, ''); this.measureText(item); this.changed(); });
      node.append(editable);
      this.styleText(item);
      requestAnimationFrame(() => { editable.focus(); this.measureText(item); });
    } else if (item.type === 'image') {
      node.append(el('img.pe__img', { src: URL.createObjectURL(new Blob([item.bytes], { type: item.mime })), alt: '', draggable: false }));
    } else if (item.color) {
      node.style.setProperty('--item-color', item.color);
    }

    if (item.type !== 'draw') {
      for (const corner of (item.type === 'text' ? [] : ['nw', 'ne', 'sw', 'se'])) {
        node.append(el(`span.pe__handle.pe__handle--${corner}`, { dataset: { corner } }));
      }
    }
    node.append(el('button.pe__remove', {
      type: 'button', 'aria-label': t('Remove'), title: t('Remove'),
      onpointerdown: e => e.stopPropagation(),
      onclick: e => { e.stopPropagation(); this.remove(item); },
    }, '×'));

    this.wireItem(item, p);
    p.layer.append(node);
  }

  place(item) {
    Object.assign(item.el.style, {
      left: `${item.x * 100}%`, top: `${item.y * 100}%`,
      width: item.type === 'text' ? 'auto' : `${item.w * 100}%`,
      height: item.type === 'text' ? 'auto' : `${item.h * 100}%`,
    });
  }

  styleText(item) {
    item.el.style.setProperty('--pt', item.size || 14);
    item.el.style.setProperty('--item-color', item.color || '#000');
    item.el.style.fontWeight = item.bold ? '700' : '400';
  }

  measureText(item) {
    const p = this.pages[item.page];
    const r = item.el.getBoundingClientRect();
    const s = p.sheet.getBoundingClientRect();
    if (s.width) { item.w = r.width / s.width; item.h = r.height / s.height; }
  }

  updateItem(item, patch) {
    Object.assign(item, patch);
    if (item.type === 'text') { this.styleText(item); this.measureText(item); }
    else if (item.color) item.el.style.setProperty('--item-color', item.color);
    this.changed();
  }

  wireItem(item, p) {
    item.el.addEventListener('pointerdown', e => {
      if (e.target.classList.contains('pe__text') && this.selected === item) return;
      e.stopPropagation();
      this.select(item);
      if (e.target.classList.contains('pe__text')) return;
      e.preventDefault();
      const rect = p.layer.getBoundingClientRect();
      const corner = e.target.dataset.corner;
      const start = { cx: e.clientX, cy: e.clientY, x: item.x, y: item.y, w: item.w, h: item.h };
      const ratio = item.h / item.w;

      const move = ev => {
        const du = (ev.clientX - start.cx) / rect.width;
        const dv = (ev.clientY - start.cy) / rect.height;
        if (!corner) {
          item.x = Math.min(1 - item.w, Math.max(0, start.x + du));
          item.y = Math.min(1 - item.h, Math.max(0, start.y + dv));
        } else {
          let { x, y, w, h } = start;
          if (corner.includes('e')) w = start.w + du;
          if (corner.includes('w')) { w = start.w - du; x = start.x + du; }
          if (corner.includes('s')) h = start.h + dv;
          if (corner.includes('n')) { h = start.h - dv; y = start.y + dv; }
          if (item.keepRatio) {
            h = w * ratio;
            if (corner.includes('n')) y = start.y + start.h - h;
          }
          if (w > 0.01 && h > 0.005 && x >= 0 && y >= 0 && x + w <= 1.001 && y + h <= 1.001) {
            Object.assign(item, { x, y, w, h });
          }
        }
        this.place(item);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        this.changed();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }
}
