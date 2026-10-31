// tools.js
// One entry per PDF tool: what it accepts, which tools to suggest afterwards,
// and open(ctx), which builds its panel and calls ctx.process() to do the work.

import * as ops from './ops.js';
import { PageGrid, PageEditor } from './pages.js';
import { openPdfjs } from './lib.js';
import {
  t, el, lang, formatBytes, field, textInput, numberInput, select, checkbox, choice, button,
  notice, pickFiles,
} from './ui.js';

const PDF = { accept: '.pdf,application/pdf', kind: 'pdf' };
const IMAGES = { accept: 'image/*', kind: 'image', multiple: true };

const stem = ops.fileStem;
const pdfName = (name, suffix) => `${stem(name)}${suffix ? `-${suffix}` : ''}.pdf`;

function rangesHint() {
  return t('Example: 1-3, 5, 8- (the last one means “page 8 to the end”).');
}

function readRanges(input, pageCount) {
  try {
    return ops.parseRanges(input.value, pageCount);
  } catch (err) {
    if (err instanceof RangeError) {
      throw new UserError(t('Check the page numbers. This document has {n} pages.', { n: pageCount }));
    }
    throw err;
  }
}

export class UserError extends Error {}

function gridToolbar(grid, labels = {}) {
  return el('div.pt-gridbar',
    button(labels.all || t('Select all'), () => grid.setAllSelected(true), 'ghost'),
    button(labels.none || t('Clear selection'), () => grid.setAllSelected(false), 'ghost'));
}

/** Live preview of the first page with an operation applied. */
function firstPagePreview(bytes, apply) {
  const canvas = el('canvas.pt-preview__canvas');
  const wrap = el('figure.pt-preview', canvas, el('figcaption', t('Preview of the first page')));
  let firstPage = null;
  let timer = 0;
  let token = 0;
  const draw = async () => {
    const mine = ++token;
    firstPage ||= await ops.assemble([{ bytes, pages: [0] }]);
    let out;
    try { out = await apply(firstPage); } catch { return; }
    if (mine !== token) return;
    const pdf = await openPdfjs(out);
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (Math.min(wrap.clientWidth || 480, 560) * 1.5) / base.width });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport, background: '#ffffff' }).promise;
    pdf.destroy();
  };
  wrap.refresh = () => { clearTimeout(timer); timer = setTimeout(draw, 160); };
  wrap.refresh();
  return wrap;
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export const TOOLS = {
  merge: {
    ...PDF, multiple: true, next: ['compress', 'page-numbers', 'sign'],
    open(ctx) {
      const list = el('ol.pt-files');
      const render = () => {
        list.replaceChildren(...ctx.files.map((file, i) => el('li.pt-files__item', { draggable: true,
          ondragstart: e => { e.dataTransfer.setData('text/plain', String(i)); },
          ondragover: e => e.preventDefault(),
          ondrop: e => {
            e.preventDefault();
            const from = +e.dataTransfer.getData('text/plain');
            const [moved] = ctx.files.splice(from, 1);
            ctx.files.splice(i, 0, moved);
            render();
          },
        },
        el('span.pt-files__index', String(i + 1)),
        el('span.pt-files__name', file.name),
        el('span.pt-files__size', formatBytes(file.bytes.length)),
        el('span.pt-files__actions',
          button('↑', () => { ctx.files.splice(i - 1, 0, ctx.files.splice(i, 1)[0]); render(); }, 'icon', { disabled: i === 0, 'aria-label': t('Move earlier') }),
          button('↓', () => { ctx.files.splice(i + 1, 0, ctx.files.splice(i, 1)[0]); render(); }, 'icon', { disabled: i === ctx.files.length - 1, 'aria-label': t('Move later') }),
          button('×', () => { ctx.files.splice(i, 1); render(); }, 'icon', { disabled: ctx.files.length < 2, 'aria-label': t('Remove') })))));
      };
      render();
      ctx.panel({
        main: el('div', list, button(t('Add more PDFs'), () => ctx.addFiles(render), 'secondary')),
        side: [el('p.pt-hint', t('Drag the files into the order you want. Pages keep their original size and orientation.'))],
        action: t('Merge PDF'),
        run: () => {
          if (ctx.files.length < 2) throw new UserError(t('Add at least two PDFs to merge.'));
          return ctx.process(t('Merging…'), async progress => {
            const bytes = await ops.assemble(ctx.files.map(f => ({ bytes: f.bytes })), { onProgress: progress });
            return { files: [{ name: 'merged.pdf', bytes }] };
          });
        },
      });
    },
  },

  split: {
    ...PDF, next: ['merge', 'compress'],
    async open(ctx) {
      const file = ctx.files[0];
      const grid = new PageGrid();
      ctx.onClose(() => grid.destroy());
      const count = await grid.addDocument(file.bytes, file.name);
      const ranges = textInput(`1-${Math.ceil(count / 2)}, ${Math.ceil(count / 2) + 1}-${count}`);
      const every = numberInput(1, { min: 1, max: count });
      const rangesField = field(t('Page ranges, one file per range'), ranges, rangesHint());
      const everyField = field(t('Pages per file'), every);
      const sync = v => { rangesField.hidden = v !== 'ranges'; everyField.hidden = v !== 'every'; };
      const mode = choice([
        { value: 'each', label: t('Every page as its own file') },
        { value: 'ranges', label: t('By page ranges') },
        { value: 'every', label: t('Every N pages') },
      ], 'each', sync);
      sync('each');
      ctx.panel({
        main: grid.root,
        side: [ctx.pageCountLine(count), mode, rangesField, everyField],
        action: t('Split PDF'),
        run: () => {
          let groups;
          if (mode.value === 'each') groups = Array.from({ length: count }, (_, i) => [i]);
          else if (mode.value === 'every') {
            const n = Math.max(1, +every.value || 1);
            groups = [];
            for (let i = 0; i < count; i += n) groups.push(Array.from({ length: Math.min(n, count - i) }, (_, k) => i + k));
          } else {
            try { groups = ops.parseRangeGroups(ranges.value, count); }
            catch { throw new UserError(t('Check the page numbers. This document has {n} pages.', { n: count })); }
          }
          return ctx.process(t('Splitting…'), async () => ({
            files: await ops.splitGroups(file.bytes, groups, stem(file.name)),
            zipName: `${stem(file.name)}-split.zip`,
          }));
        },
      });
    },
  },

  extract: {
    ...PDF, next: ['merge', 'compress'],
    async open(ctx) {
      const file = ctx.files[0];
      const counter = el('p.pt-count');
      const grid = new PageGrid({
        selectable: true,
        onChange: () => { counter.textContent = t('Pages selected: {n}', { n: grid.selection.length }); },
      });
      ctx.onClose(() => grid.destroy());
      await grid.addDocument(file.bytes, file.name);
      grid.changed();
      const separate = checkbox(t('Save each page as a separate file'));
      ctx.panel({
        main: el('div', gridToolbar(grid), grid.root),
        side: [counter, separate],
        action: t('Extract pages'),
        run: () => {
          const pages = grid.selection.map(e => e.page);
          if (!pages.length) throw new UserError(t('Select at least one page.'));
          return ctx.process(t('Extracting…'), async progress => {
            if (separate.input.checked) {
              return { files: await ops.splitGroups(file.bytes, pages.map(p => [p]), stem(file.name)), zipName: `${stem(file.name)}-pages.zip` };
            }
            const bytes = await ops.assemble([{ bytes: file.bytes, pages }], { onProgress: progress });
            return { files: [{ name: pdfName(file.name, 'extract'), bytes }] };
          });
        },
      });
    },
  },

  delete: {
    ...PDF, next: ['compress', 'organize', 'merge'],
    async open(ctx) {
      const file = ctx.files[0];
      const counter = el('p.pt-count');
      const grid = new PageGrid({
        selectable: true,
        onChange: () => { counter.textContent = t('Pages to remove: {n}', { n: grid.selection.length }); },
      });
      grid.root.classList.add('pg--danger');
      ctx.onClose(() => grid.destroy());
      const count = await grid.addDocument(file.bytes, file.name);
      grid.changed();
      ctx.panel({
        main: el('div', gridToolbar(grid), grid.root),
        side: [counter, el('p.pt-hint', t('Click the pages you want to remove. Their content is removed from the new file, not just hidden.'))],
        action: t('Delete pages'),
        run: () => {
          const pages = grid.selection.map(e => e.page);
          if (!pages.length) throw new UserError(t('Select at least one page.'));
          if (pages.length >= count) throw new UserError(t('A PDF needs at least one page. Leave one unselected.'));
          return ctx.process(t('Removing pages…'), async () => ({
            files: [{ name: pdfName(file.name, 'edited'), bytes: await ops.deletePages(file.bytes, pages) }],
          }));
        },
      });
    },
  },

  organize: {
    ...PDF, multiple: true, next: ['compress', 'page-numbers', 'sign'],
    async open(ctx) {
      const grid = new PageGrid({ reorderable: true, rotatable: true, removable: true });
      ctx.onClose(() => grid.destroy());
      for (const f of ctx.files) await grid.addDocument(f.bytes, f.name);
      ctx.panel({
        main: el('div',
          el('div.pt-gridbar',
            button(t('Add blank page'), () => { grid.entries.push({ blank: true, rotate: 0 }); grid.render(); }, 'ghost'),
            button(t('Add another PDF'), () => ctx.addFiles(async added => {
              for (const f of added) await grid.addDocument(f.bytes, f.name);
            }), 'ghost')),
          grid.root),
        side: [el('p.pt-hint', t('Drag pages to reorder them, or use the arrows on each page. Hover or tap a page to rotate or remove it.'))],
        action: t('Save PDF'),
        run: () => {
          if (!grid.entries.length) throw new UserError(t('Keep at least one page.'));
          return ctx.process(t('Building your PDF…'), async () => {
            const bytes = await ops.organize(ctx.files.map(f => f.bytes), grid.entries);
            return { files: [{ name: pdfName(ctx.files[0].name, 'organized'), bytes }] };
          });
        },
      });
    },
  },

  rotate: {
    ...PDF, next: ['compress', 'merge', 'organize'],
    async open(ctx) {
      const file = ctx.files[0];
      const grid = new PageGrid({ selectable: true, rotatable: true });
      ctx.onClose(() => grid.destroy());
      await grid.addDocument(file.bytes, file.name);
      ctx.panel({
        main: grid.root,
        side: [
          el('p.pt-hint', t('Rotate single pages on the page itself. These buttons rotate the selected pages, or all pages if none are selected.')),
          el('div.pt-btnrow',
            button(t('↺ Left'), () => grid.rotateAll(-90), 'secondary'),
            button(t('↻ Right'), () => grid.rotateAll(90), 'secondary'),
            button('180°', () => grid.rotateAll(180), 'secondary')),
        ],
        action: t('Save rotated PDF'),
        run: () => {
          const rotations = {};
          grid.entries.forEach(e => { if (e.rotate) rotations[e.page] = e.rotate; });
          if (!Object.keys(rotations).length) throw new UserError(t('Rotate at least one page first.'));
          return ctx.process(t('Rotating…'), async () => ({
            files: [{ name: pdfName(file.name, 'rotated'), bytes: await ops.rotatePages(file.bytes, rotations) }],
          }));
        },
      });
    },
  },

  crop: {
    ...PDF, next: ['compress', 'page-numbers'],
    async open(ctx) {
      const file = ctx.files[0];
      const editor = new PageEditor(file.bytes, { mode: 'box:crop', single: true });
      ctx.onClose(() => editor.destroy());
      await editor.load();
      editor.setMode('box:crop');
      const allPages = checkbox(t('Use the same crop on all pages'), true);
      ctx.panel({
        main: editor.root,
        wide: true,
        side: [el('p.pt-hint', t('Drag on a page to draw the area you want to keep, then adjust it with the corner handles.')), allPages],
        action: t('Crop PDF'),
        run: () => {
          if (!editor.items.length) throw new UserError(t('Draw a crop area on a page first.'));
          const rects = {};
          const pick = i => ({ x: i.x, y: i.y, w: i.w, h: i.h });
          if (allPages.input.checked) {
            for (let n = 0; n < editor.pages.length; n++) rects[n] = pick(editor.items[0]);
          } else {
            editor.items.forEach(i => { rects[i.page] = pick(i); });
          }
          return ctx.process(t('Cropping…'), async () => ({
            files: [{ name: pdfName(file.name, 'cropped'), bytes: await ops.cropPages(file.bytes, rects) }],
          }));
        },
      });
    },
  },

  compress: {
    ...PDF, next: ['merge', 'split', 'protect'],
    open(ctx) {
      const file = ctx.files[0];
      const level = choice([
        { value: 'low', label: t('Light'), hint: t('Removes wasted space. Images stay untouched.') },
        { value: 'medium', label: t('Balanced'), hint: t('Images at 150 dpi. Best for email and sharing.') },
        { value: 'high', label: t('Strong'), hint: t('Images at 96 dpi. Smallest file, for on-screen reading.') },
      ], 'medium');
      ctx.panel({
        main: ctx.fileCard(file),
        side: [el('h3.pt-sidehead', t('Compression level')), level],
        action: t('Compress PDF'),
        run: () => ctx.process(t('Compressing…'), async progress => {
          const bytes = await ops.compress(file.bytes, { level: level.value, onProgress: progress });
          const saved = 1 - bytes.length / file.bytes.length;
          const unchanged = bytes.length >= file.bytes.length;
          return {
            files: [{ name: pdfName(file.name, 'compressed'), bytes }],
            stat: unchanged ? null : t('{before} → {after}, {percent}% smaller', {
              before: formatBytes(file.bytes.length),
              after: formatBytes(bytes.length),
              percent: Math.round(saved * 100),
            }),
            note: unchanged ? t('This PDF is already well optimized. A stronger level may still help if it contains images.') : null,
          };
        }),
      });
    },
  },

  'pdf-to-jpg': imageExport('image/jpeg', 'jpg'),
  'pdf-to-png': imageExport('image/png', 'png'),

  'pdf-to-word': {
    ...PDF, next: [],
    async open(ctx) {
      const file = ctx.files[0];
      const mode = choice([
        { value: 'text', label: t('Editable text'), hint: t('Text, headings and bold or italic styling become normal Word paragraphs. Images and complex layouts are not carried over.') },
        { value: 'layout', label: t('Exact look'), hint: t('Each page becomes a picture in Word. It looks identical but the text cannot be edited.') },
      ], 'text');
      const scanNote = await ctx.scanWarning(file);
      ctx.panel({
        main: ctx.fileCard(file),
        side: [scanNote, el('h3.pt-sidehead', t('Conversion type')), mode],
        action: t('Convert to Word'),
        run: () => ctx.process(t('Converting to Word…'), async progress => ({
          files: [{
            name: `${stem(file.name)}.docx`,
            bytes: await ops.pdfToDocx(file.bytes, { mode: mode.value, onProgress: progress }),
            mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          }],
        })),
      });
    },
  },

  'pdf-to-excel': {
    ...PDF, next: [],
    async open(ctx) {
      const file = ctx.files[0];
      const scanNote = await ctx.scanWarning(file);
      ctx.panel({
        main: ctx.fileCard(file),
        side: [scanNote, el('p.pt-hint', t('Each page becomes one sheet. Columns are detected from the position of the text, and numbers become real numbers you can calculate with.'))],
        action: t('Convert to Excel'),
        run: () => ctx.process(t('Converting to Excel…'), async progress => ({
          files: [{
            name: `${stem(file.name)}.xlsx`,
            bytes: await ops.pdfToXlsx(file.bytes, { onProgress: progress }),
            mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          }],
        })),
      });
    },
  },

  'pdf-to-text': {
    ...PDF, next: [],
    async open(ctx) {
      const file = ctx.files[0];
      const scanNote = await ctx.scanWarning(file);
      ctx.panel({
        main: ctx.fileCard(file),
        side: [scanNote, el('p.pt-hint', t('You get a plain .txt file (UTF-8) with the paragraphs put back together.'))],
        action: t('Extract text'),
        run: () => ctx.process(t('Reading text…'), async progress => {
          const text = await ops.pdfToText(file.bytes, progress);
          return { files: [{ name: `${stem(file.name)}.txt`, blob: new Blob([text], { type: 'text/plain;charset=utf-8' }) }] };
        }),
      });
    },
  },

  'jpg-to-pdf': imagesToPdfTool(),
  'png-to-pdf': imagesToPdfTool(),

  edit: {
    ...PDF, next: ['compress', 'sign', 'flatten'],
    async open(ctx) {
      const file = ctx.files[0];
      const editor = new PageEditor(file.bytes, {
        onSelect: item => refreshProps(item),
        onCreated: () => setMode('select'),
      });
      ctx.onClose(() => editor.destroy());
      await editor.load();

      const color = el('input.pt-color', { type: 'color', value: '#000000' });
      const size = numberInput(14, { min: 6, max: 96 });
      const bold = checkbox(t('Bold'));
      const colorField = field(t('Color'), color);
      const sizeField = field(t('Font size'), size);
      editor.defaults = {
        text: { text: '', size: 14, color: '#000000', bold: false },
        highlight: { color: '#ffe600' },
        rect: { color: '#d4351c' },
        draw: { color: '#1b4fd8', width: 2 },
      };
      const applyProp = () => {
        const item = editor.selected;
        const patch = { color: color.value };
        if (!item || item.type === 'text') { patch.size = +size.value || 14; patch.bold = bold.input.checked; }
        if (item) editor.updateItem(item, patch);
        for (const type of Object.keys(editor.defaults)) {
          if (mode === `box:${type}` || mode === `click:${type}` || mode === type) Object.assign(editor.defaults[type], patch);
        }
      };
      [color, size, bold.input].forEach(c => c.addEventListener('input', applyProp));
      function refreshProps(item) {
        if (!item) return;
        if (item.color) color.value = item.color;
        if (item.type === 'text') { size.value = item.size; bold.input.checked = !!item.bold; }
      }

      let mode = 'select';
      const buttons = {};
      const setMode = next => {
        mode = next;
        editor.setMode(next);
        Object.entries(buttons).forEach(([key, b]) => b.classList.toggle('is-active', key === next));
      };
      const tool = (key, label) => (buttons[key] = button(label, () => setMode(key), 'tool'));
      const addImage = button(t('Image'), async () => {
        const [img] = await pickFiles({ accept: 'image/*' });
        if (!img) return;
        const norm = await ops.normalizeImage(img);
        const bitmap = await createImageBitmap(new Blob([norm.bytes], { type: norm.mime }));
        const ratio = bitmap.height / bitmap.width;
        bitmap.close();
        const page = editor.pages[0];
        const w = 0.3;
        editor.add({ page: 0, type: 'image', x: 0.1, y: 0.1, w, h: w * ratio * (page.widthPt / page.heightPt), keepRatio: true, ...norm });
      }, 'tool');
      const toolbar = el('div.pt-toolbar', { role: 'toolbar' },
        tool('select', t('Select')),
        tool('click:text', t('Text')),
        tool('box:highlight', t('Highlight')),
        tool('box:rect', t('Rectangle')),
        tool('box:whiteout', t('White-out')),
        tool('draw', t('Draw')),
        addImage);
      setMode('click:text');

      ctx.panel({
        main: el('div', toolbar, editor.root),
        wide: true,
        side: [
          el('p.pt-hint', t('Choose a tool, then click or drag on a page. Select an item to move, resize or remove it.')),
          colorField, sizeField, bold,
          el('p.pt-hint', t('White-out covers what is underneath but does not delete it. To remove sensitive content for good, use Redact PDF.')),
        ],
        action: t('Save PDF'),
        run: () => {
          const items = editor.items.filter(i => i.type !== 'text' || i.text?.trim());
          if (!items.length) throw new UserError(t('Add something to the page first.'));
          return ctx.process(t('Saving your edits…'), async () => ({
            files: [{ name: pdfName(file.name, 'edited'), bytes: await ops.applyEdits(file.bytes, items) }],
          }));
        },
      });
    },
  },

  sign: {
    ...PDF, next: ['flatten', 'protect', 'compress'],
    async open(ctx) {
      const file = ctx.files[0];
      let signature = null;
      const editor = new PageEditor(file.bytes, {
        mode: 'place',
        stamp: () => signature && { bytes: signature.bytes, mime: 'image/png', ratio: signature.ratio, w: 0.28 },
      });
      ctx.onClose(() => editor.destroy());
      await editor.load();
      editor.setMode('place');

      const status = el('p.pt-count', t('Create your signature, then click on the page where it belongs.'));
      const use = sig => {
        signature = sig;
        status.textContent = sig ? t('Signature ready. Click on any page to place it.') : t('Create your signature, then click on the page where it belongs.');
      };
      const pad = signaturePad(use);
      ctx.panel({
        main: editor.root,
        wide: true,
        side: [pad, status, el('p.pt-hint', t('This adds a visible signature, which is enough for most everyday documents. It is not a qualified electronic signature.'))],
        action: t('Finish and save'),
        run: () => {
          if (!editor.items.length) throw new UserError(t('Place your signature on a page first.'));
          return ctx.process(t('Saving…'), async () => ({
            files: [{ name: pdfName(file.name, 'signed'), bytes: await ops.applyEdits(file.bytes, editor.items) }],
          }));
        },
      });
    },
  },

  watermark: {
    ...PDF, next: ['protect', 'compress'],
    open(ctx) {
      const file = ctx.files[0];
      const text = textInput(t('CONFIDENTIAL'));
      const size = numberInput(52, { min: 8, max: 200 });
      const opacity = el('input', { type: 'range', min: 5, max: 100, value: 25 });
      const angle = select([['0', '0°'], ['30', '30°'], ['45', '45°'], ['90', '90°']], '45');
      const color = el('input.pt-color', { type: 'color', value: '#c8102e' });
      const layout = select([['single', t('Once on each page')], ['tile', t('Tiled across the page')]], 'single');
      const position = select(positionOptions(), 'center');
      const read = () => ({
        text: text.value || ' ', size: +size.value || 48, opacity: +opacity.value / 100,
        angle: +angle.value, color: color.value, layout: layout.value, position: position.value, bold: true,
      });
      const preview = firstPagePreview(file.bytes, b => ops.watermark(b, read()));
      [text, size, opacity, angle, color, layout, position].forEach(c => c.addEventListener('input', preview.refresh));
      ctx.panel({
        main: preview,
        side: [
          field(t('Watermark text'), text), field(t('Font size'), size), field(t('Opacity'), opacity),
          field(t('Angle'), angle), field(t('Color'), color), field(t('Layout'), layout), field(t('Position'), position),
        ],
        action: t('Add watermark'),
        run: () => {
          if (!text.value.trim()) throw new UserError(t('Enter the watermark text.'));
          return ctx.process(t('Adding watermark…'), async () => ({
            files: [{ name: pdfName(file.name, 'watermark'), bytes: await ops.watermark(file.bytes, read()) }],
          }));
        },
      });
    },
  },

  'page-numbers': {
    ...PDF, next: ['compress', 'sign'],
    open(ctx) {
      const file = ctx.files[0];
      const position = select(positionOptions(true), 'bottom-center');
      const format = select([
        ['{n}', '1, 2, 3'],
        ['{n} / {total}', '1 / 10'],
        [t('Page {n}', { n: '{n}' }), t('Page {n}', { n: 1 })],
        [t('Page {n} of {total}', { n: '{n}', total: '{total}' }), t('Page {n} of {total}', { n: 1, total: 10 })],
      ], '{n}');
      const start = numberInput(1, { min: 0 });
      const from = numberInput(1, { min: 1 });
      const size = numberInput(11, { min: 6, max: 48 });
      const read = () => ({ position: position.value, format: format.value, startAt: +start.value || 0, size: +size.value || 11 });
      const preview = firstPagePreview(file.bytes, b => ops.pageNumbers(b, read()));
      [position, format, start, size].forEach(c => c.addEventListener('input', preview.refresh));
      ctx.panel({
        main: preview,
        side: [
          field(t('Position'), position), field(t('Format'), format), field(t('First number'), start),
          field(t('Start numbering on page'), from), field(t('Font size'), size),
        ],
        action: t('Add page numbers'),
        run: () => ctx.process(t('Adding page numbers…'), async () => ({
          files: [{ name: pdfName(file.name, 'numbered'), bytes: await ops.pageNumbers(file.bytes, { ...read(), from: Math.max(1, +from.value || 1) }) }],
        })),
      });
    },
  },

  'form-filler': {
    ...PDF, next: ['flatten', 'sign', 'protect'],
    async open(ctx) {
      const file = ctx.files[0];
      const fields = await ops.readFormFields(file.bytes);
      if (!fields.length) {
        ctx.panel({
          main: ctx.fileCard(file),
          side: [notice(t('This PDF has no fillable fields. Use Edit PDF to type on it directly.')), ctx.toolLink('edit')],
        });
        return;
      }
      const controls = fields.map(f => {
        let input;
        if (f.kind === 'check') input = checkbox(f.name, f.value);
        else if (f.kind === 'text') input = f.multiline ? el('textarea.pt-input', { rows: 3, value: f.value }) : textInput(f.value);
        else input = select([['', '—'], ...f.options.map(o => [o, o])], f.value);
        return { f, input, node: f.kind === 'check' ? input : field(f.name, input) };
      });
      const flatten = checkbox(t('Lock the answers so they can no longer be changed'));
      ctx.panel({
        main: el('div.pt-formfields', controls.map(c => c.node)),
        side: [el('p.pt-count', t('Fields found: {n}', { n: fields.length })), flatten],
        action: t('Save filled PDF'),
        run: () => ctx.process(t('Saving…'), async () => {
          const values = {};
          controls.forEach(({ f, input }) => { values[f.name] = f.kind === 'check' ? input.input.checked : input.value; });
          return { files: [{ name: pdfName(file.name, 'filled'), bytes: await ops.fillForm(file.bytes, values, { flatten: flatten.input.checked }) }] };
        }),
      });
    },
  },

  protect: {
    ...PDF, next: [],
    open(ctx) {
      const file = ctx.files[0];
      const pw = textInput('', { type: 'password', autocomplete: 'new-password' });
      const again = textInput('', { type: 'password', autocomplete: 'new-password' });
      const print = checkbox(t('Allow printing'), true);
      const copy = checkbox(t('Allow copying text'), true);
      const modify = checkbox(t('Allow changes'), true);
      ctx.panel({
        main: ctx.fileCard(file),
        side: [
          field(t('Password'), pw), field(t('Repeat password'), again),
          print, copy, modify,
          el('p.pt-hint', t('Encrypted with AES-256. Keep the password safe: nobody can recover it for you, and we never see it.')),
        ],
        action: t('Protect PDF'),
        run: () => {
          if (pw.value.length < 1) throw new UserError(t('Enter a password.'));
          if (pw.value !== again.value) throw new UserError(t('The passwords do not match.'));
          const anyRestriction = !(print.input.checked && copy.input.checked && modify.input.checked);
          return ctx.process(t('Encrypting…'), async () => ({
            files: [{
              name: pdfName(file.name, 'protected'),
              bytes: await ops.protect(file.bytes, {
                userPassword: pw.value,
                // Restrictions only mean something with a separate owner password
                ownerPassword: anyRestriction ? `${pw.value}\u0001${crypto.randomUUID()}` : pw.value,
                allowPrint: print.input.checked, allowCopy: copy.input.checked, allowModify: modify.input.checked,
              }),
            }],
          }));
        },
      });
    },
  },

  unlock: {
    ...PDF, rawInput: true, next: ['compress', 'edit', 'merge'],
    async open(ctx) {
      const file = ctx.files[0];
      const encrypted = await ops.isEncrypted(file.bytes);
      if (!encrypted) {
        ctx.panel({ main: ctx.fileCard(file), side: [notice(t('This PDF is not password protected, so there is nothing to unlock.'))] });
        return;
      }
      const pw = textInput('', { type: 'password', autocomplete: 'off' });
      ctx.panel({
        main: ctx.fileCard(file),
        side: [
          field(t('Password'), pw, t('Leave empty if the PDF opens without a password and is only restricted from printing or editing.')),
          el('p.pt-hint', t('Only unlock files you are allowed to open. A forgotten password cannot be recovered here.')),
        ],
        action: t('Unlock PDF'),
        run: () => ctx.process(t('Unlocking…'), async () => {
          try {
            return { files: [{ name: pdfName(file.name, 'unlocked'), bytes: await ops.unlock(file.bytes, pw.value) }] };
          } catch (err) {
            if (/password/i.test(err.qpdf || err.message)) throw new UserError(t('That password is not correct.'));
            throw err;
          }
        }),
      });
    },
  },

  redact: {
    ...PDF, next: ['compress'],
    async open(ctx) {
      const file = ctx.files[0];
      const counter = el('p.pt-count', t('Areas marked: {n}', { n: 0 }));
      const editor = new PageEditor(file.bytes, {
        mode: 'box:redact',
        onChange: items => { counter.textContent = t('Areas marked: {n}', { n: items.length }); },
      });
      ctx.onClose(() => editor.destroy());
      await editor.load();
      editor.setMode('box:redact');
      ctx.panel({
        main: editor.root,
        wide: true,
        side: [
          el('p.pt-hint', t('Drag over anything you want to black out.')),
          counter,
          notice(t('Pages you mark become images, so the hidden text is gone for good and the rest of that page can no longer be selected. Document properties and bookmarks are removed too.')),
        ],
        action: t('Redact permanently'),
        run: () => {
          if (!editor.items.length) throw new UserError(t('Mark at least one area first.'));
          const boxes = {};
          editor.items.forEach(({ page, x, y, w, h }) => { (boxes[page] ||= []).push({ x, y, w, h }); });
          return ctx.process(t('Redacting…'), async progress => ({
            files: [{ name: pdfName(file.name, 'redacted'), bytes: await ops.redact(file.bytes, boxes, { onProgress: progress }) }],
          }));
        },
      });
    },
  },

  metadata: {
    ...PDF, next: ['compress', 'protect'],
    async open(ctx) {
      const file = ctx.files[0];
      const meta = await ops.readMetadata(file.bytes);
      const inputs = {
        title: textInput(meta.title), author: textInput(meta.author), subject: textInput(meta.subject),
        keywords: textInput(meta.keywords), creator: textInput(meta.creator), producer: textInput(meta.producer),
      };
      const labels = {
        title: t('Title'), author: t('Author'), subject: t('Subject'),
        keywords: t('Keywords, separated by commas'), creator: t('Created with'), producer: t('PDF producer'),
      };
      const save = clearAll => ctx.process(t('Saving…'), async () => ({
        files: [{
          name: pdfName(file.name, clearAll ? 'clean' : 'metadata'),
          bytes: await ops.writeMetadata(file.bytes, Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value])), { clearAll }),
        }],
      }));
      ctx.panel({
        main: el('div.pt-formfields', Object.entries(inputs).map(([k, input]) => field(labels[k], input))),
        side: [
          el('p.pt-hint', t('Remove all deletes every property, including the hidden XMP data, in one click.')),
          button(t('Remove all metadata'), () => ctx.guard(() => save(true)), 'secondary'),
        ],
        action: t('Save metadata'),
        run: () => save(false),
      });
    },
  },

  flatten: {
    ...PDF, next: ['compress', 'protect'],
    open(ctx) {
      const file = ctx.files[0];
      const annots = checkbox(t('Also remove comments and link areas'), true);
      ctx.panel({
        main: ctx.fileCard(file),
        side: [el('p.pt-hint', t('Form answers become fixed page content that looks the same everywhere and can no longer be edited.')), annots],
        action: t('Flatten PDF'),
        run: () => ctx.process(t('Flattening…'), async () => ({
          files: [{ name: pdfName(file.name, 'flat'), bytes: await ops.flatten(file.bytes, { removeAnnotations: annots.input.checked }) }],
        })),
      });
    },
  },

  ocr: {
    ...PDF, next: ['compress', 'pdf-to-word', 'pdf-to-text'],
    open(ctx) {
      const file = ctx.files[0];
      const pageLang = { en: 'eng', de: 'deu', pl: 'pol', cs: 'ces' }[lang] || 'eng';
      const languages = [['eng', 'English'], ['deu', 'Deutsch'], ['pol', 'Polski'], ['ces', 'Čeština']];
      const boxes = languages.map(([code, label]) => {
        const box = checkbox(label, code === pageLang || code === 'eng');
        box.code = code;
        return box;
      });
      const quality = select([['150', t('Fast')], ['220', t('Balanced')], ['300', t('Most accurate')]], '220');
      ctx.panel({
        main: ctx.fileCard(file),
        side: [
          el('h3.pt-sidehead', t('Languages in the document')), el('div.pt-checks', boxes),
          field(t('Quality'), quality),
          el('p.pt-hint', t('Text recognition runs on your device, so it can take a while on long documents. The page images stay as they are.')),
        ],
        action: t('Make searchable'),
        run: () => {
          const chosen = boxes.filter(b => b.input.checked).map(b => b.code);
          if (!chosen.length) throw new UserError(t('Choose at least one language.'));
          return ctx.process(t('Recognizing text…'), async progress => {
            const { pdf } = await ops.ocrPdf(file.bytes, { lang: chosen.join('+'), dpi: +quality.value, onProgress: progress });
            return { files: [{ name: pdfName(file.name, 'ocr'), bytes: pdf }] };
          });
        },
      });
    },
  },
};

// ─── Tool factories ───────────────────────────────────────────────────────────

function positionOptions(edgesOnly) {
  const all = [
    ['top-left', t('Top left')], ['top-center', t('Top center')], ['top-right', t('Top right')],
    ['center', t('Center')],
    ['bottom-left', t('Bottom left')], ['bottom-center', t('Bottom center')], ['bottom-right', t('Bottom right')],
  ];
  return edgesOnly ? all.filter(([v]) => v !== 'center') : all;
}

function imageExport(mime, ext) {
  return {
    ...PDF, next: [],
    async open(ctx) {
      const file = ctx.files[0];
      const count = await ops.pageCountOf(file.bytes);
      const dpi = select([['72', t('Low (72 dpi)')], ['150', t('Standard (150 dpi)')], ['300', t('High (300 dpi)')]], '150');
      const range = textInput(`1-${count}`);
      const quality = el('input', { type: 'range', min: 40, max: 100, value: 88 });
      ctx.panel({
        main: ctx.fileCard(file),
        side: [
          ctx.pageCountLine(count),
          field(t('Image quality'), dpi),
          mime === 'image/jpeg' ? field(t('JPG compression'), quality, t('Lower values give smaller files.')) : null,
          field(t('Pages'), range, rangesHint()),
        ],
        action: t('Convert to {format}', { format: ext.toUpperCase() }),
        run: () => {
          const pages = readRanges(range, count);
          return ctx.process(t('Converting pages…'), async progress => {
            const images = await ops.renderPages(file.bytes, {
              pages, dpi: +dpi.value, mime, quality: +quality.value / 100, onPage: progress,
            });
            return {
              files: images.map(img => ({ name: `${stem(file.name)}-${img.index + 1}.${ext}`, bytes: img.bytes, mime })),
              zipName: `${stem(file.name)}-${ext}.zip`,
            };
          });
        },
      });
    },
  };
}

function imagesToPdfTool() {
  return {
    ...IMAGES, next: ['compress', 'merge', 'ocr'],
    open(ctx) {
      const list = el('div.pt-imgs');
      const urls = new Map();
      ctx.onClose(() => urls.forEach(u => URL.revokeObjectURL(u)));
      const render = () => {
        list.replaceChildren(...ctx.files.map((file, i) => {
          if (!urls.has(file)) urls.set(file, URL.createObjectURL(file.file));
          return el('figure.pt-imgs__item', { draggable: true,
            ondragstart: e => e.dataTransfer.setData('text/plain', String(i)),
            ondragover: e => e.preventDefault(),
            ondrop: e => {
              e.preventDefault();
              const [moved] = ctx.files.splice(+e.dataTransfer.getData('text/plain'), 1);
              ctx.files.splice(i, 0, moved);
              render();
            },
          },
          el('img', { src: urls.get(file), alt: file.name, loading: 'lazy' }),
          el('figcaption', file.name),
          el('div.pg__actions',
            el('button.pg__btn', { type: 'button', 'aria-label': t('Move earlier'), disabled: i === 0, onclick: () => { ctx.files.splice(i - 1, 0, ctx.files.splice(i, 1)[0]); render(); } }, '←'),
            el('button.pg__btn', { type: 'button', 'aria-label': t('Move later'), disabled: i === ctx.files.length - 1, onclick: () => { ctx.files.splice(i + 1, 0, ctx.files.splice(i, 1)[0]); render(); } }, '→'),
            el('button.pg__btn', { type: 'button', 'aria-label': t('Remove'), disabled: ctx.files.length < 2, onclick: () => { ctx.files.splice(i, 1); render(); } }, '×')));
        }));
      };
      render();
      const size = select([['a4', 'A4'], ['letter', 'US Letter'], ['fit', t('Same as the image')]], lang === 'en' ? 'fit' : 'a4');
      const orientation = select([['auto', t('Automatic')], ['portrait', t('Portrait')], ['landscape', t('Landscape')]], 'auto');
      const margin = select([['0', t('None')], ['20', t('Small')], ['40', t('Large')]], '0');
      ctx.panel({
        main: el('div', list, button(t('Add more images'), () => ctx.addFiles(render), 'secondary')),
        side: [field(t('Page size'), size), field(t('Orientation'), orientation), field(t('Margin'), margin)],
        action: t('Convert to PDF'),
        run: () => ctx.process(t('Creating your PDF…'), async progress => {
          const images = [];
          for (const f of ctx.files) images.push(await ops.normalizeImage(f.file));
          const bytes = await ops.imagesToPdf(images, { size: size.value, orientation: orientation.value, margin: +margin.value }, progress);
          return { files: [{ name: `${stem(ctx.files[0].name)}.pdf`, bytes }] };
        }),
      });
    },
  };
}

// ─── Signature pad ────────────────────────────────────────────────────────────

function trimmedPng(canvas) {
  const c = canvas.getContext('2d');
  const { width, height } = canvas;
  const { data } = c.getImageData(0, 0, width, height);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return Promise.resolve(null);
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  out.getContext('2d').drawImage(canvas, minX, minY, w, h, 0, 0, w, h);
  return new Promise(res => out.toBlob(async blob => {
    res({ bytes: new Uint8Array(await blob.arrayBuffer()), ratio: h / w });
  }, 'image/png'));
}

function signaturePad(onReady) {
  const inkColor = '#14213d';
  const canvas = el('canvas.pt-sig__canvas', { width: 800, height: 280 });
  const c = canvas.getContext('2d');
  const typed = textInput('', { placeholder: t('Your name') });
  const fonts = '"Snell Roundhand","Segoe Script","Bradley Hand","Brush Script MT",cursive';

  const clear = () => { c.clearRect(0, 0, canvas.width, canvas.height); onReady(null); };
  const publish = async () => onReady(await trimmedPng(canvas));

  // Drawing
  let drawing = false;
  const pos = e => {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height];
  };
  canvas.addEventListener('pointerdown', e => {
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    c.beginPath();
    c.moveTo(...pos(e));
    c.lineWidth = 4; c.lineCap = 'round'; c.lineJoin = 'round'; c.strokeStyle = inkColor;
  });
  canvas.addEventListener('pointermove', e => { if (drawing) { c.lineTo(...pos(e)); c.stroke(); } });
  canvas.addEventListener('pointerup', () => { drawing = false; publish(); });

  // Typing
  typed.addEventListener('input', () => {
    c.clearRect(0, 0, canvas.width, canvas.height);
    if (!typed.value.trim()) { onReady(null); return; }
    let size = 110;
    do { c.font = `${size}px ${fonts}`; size -= 4; } while (c.measureText(typed.value).width > canvas.width - 40 && size > 24);
    c.fillStyle = inkColor;
    c.textBaseline = 'middle';
    c.fillText(typed.value, 20, canvas.height / 2);
    publish();
  });

  // Upload
  const upload = button(t('Upload an image'), async () => {
    const [file] = await pickFiles({ accept: 'image/*' });
    if (!file) return;
    const bitmap = await createImageBitmap(file);
    c.clearRect(0, 0, canvas.width, canvas.height);
    const s = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
    c.drawImage(bitmap, 0, 0, bitmap.width * s, bitmap.height * s);
    bitmap.close();
    publish();
  }, 'ghost');

  return el('div.pt-sig',
    el('h3.pt-sidehead', t('Your signature')),
    canvas,
    el('p.pt-hint', t('Draw above, or type your name:')),
    typed,
    el('div.pt-btnrow', upload, button(t('Clear'), () => { typed.value = ''; clear(); }, 'ghost')));
}
