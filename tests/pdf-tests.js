// pdf-tests.js
// Browser tests for assets/js/pdf/ops.js. Fixtures are generated on the spot,
// and every output is reopened with pdf.js, an independent parser from pdf-lib.

import * as ops from '/assets/js/pdf/ops.js';
import { pdfLib, openPdfjs, fflate } from '/assets/js/pdf/lib.js';

const results = [];
const log = document.getElementById('log');

async function test(name, fn) {
  const started = performance.now();
  try {
    const note = await fn();
    results.push({ name, ok: true, note, ms: Math.round(performance.now() - started) });
  } catch (err) {
    results.push({ name, ok: false, note: String(err?.stack || err), ms: Math.round(performance.now() - started) });
  }
  const r = results[results.length - 1];
  log.textContent += `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.ms} ms)${r.note ? `  ${r.note}` : ''}\n`;
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(a, b, msg) { assert(a === b, `${msg || 'values differ'}: got ${a}, expected ${b}`); }

async function textOf(bytes, password) {
  const pdf = await openPdfjs(bytes, password);
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const c = await (await pdf.getPage(i)).getTextContent();
    pages.push(c.items.map(it => it.str).join(' '));
  }
  await pdf.destroy();
  return pages;
}

async function sizesOf(bytes) {
  const pdf = await openPdfjs(bytes);
  const sizes = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const v = (await pdf.getPage(i)).getViewport({ scale: 1 });
    sizes.push([Math.round(v.width), Math.round(v.height)]);
  }
  await pdf.destroy();
  return sizes;
}

/** Decompress every Flate stream and search raw + inflated bytes for a string. */
async function fileContains(bytes, needle) {
  const { unzlibSync } = await fflate();
  const raw = new TextDecoder('latin1').decode(bytes);
  if (raw.includes(needle)) return true;
  const hex = [...new TextEncoder().encode(needle)].map(b => b.toString(16).padStart(2, '0')).join('');
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    try {
      const inflated = new TextDecoder('latin1').decode(unzlibSync(bytes.subarray(start, end)));
      if (inflated.includes(needle) || inflated.toLowerCase().includes(hex)) return true;
    } catch { /* not flate */ }
  }
  return false;
}

async function textPdf(labels, opts = {}) {
  const { PDFDocument, StandardFonts, degrees } = await pdfLib();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  labels.forEach((label, i) => {
    const page = doc.addPage([595, 842]);
    page.drawText(label, { x: 60, y: 760, size: 20, font });
    if (opts.rotate?.[i]) page.setRotation(degrees(opts.rotate[i]));
  });
  if (opts.title) doc.setTitle(opts.title);
  return doc.save({ useObjectStreams: false });
}

function noisyCanvas(w, h) {
  const canvas = new OffscreenCanvas(w, h);
  const c = canvas.getContext('2d');
  const g = c.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#d33'); g.addColorStop(1, '#36d');
  c.fillStyle = g; c.fillRect(0, 0, w, h);
  const img = c.getImageData(0, 0, w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 40;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  c.putImageData(img, 0, 0);
  return canvas;
}

async function canvasBytes(canvas, type, quality) {
  const blob = await canvas.convertToBlob({ type, quality });
  return new Uint8Array(await blob.arrayBuffer());
}

async function imagePdf() {
  const { PDFDocument, StandardFonts } = await pdfLib();
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const jpg = await doc.embedJpg(await canvasBytes(noisyCanvas(2400, 1800), 'image/jpeg', 0.95));
  const png = await doc.embedPng(await canvasBytes(noisyCanvas(1200, 900), 'image/png'));
  page.drawImage(jpg, { x: 40, y: 450, width: 500, height: 375 });
  page.drawImage(png, { x: 40, y: 60, width: 500, height: 375 });
  page.drawText('Keep this text selectable', { x: 40, y: 20, size: 14, font });
  return doc.save({ useObjectStreams: false });
}

async function formPdf() {
  const { PDFDocument } = await pdfLib();
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const form = doc.getForm();
  const name = form.createTextField('name');
  name.addToPage(page, { x: 50, y: 700, width: 300, height: 24 });
  const agree = form.createCheckBox('agree');
  agree.addToPage(page, { x: 50, y: 650, width: 18, height: 18 });
  const choice = form.createDropdown('choice');
  choice.addOptions(['one', 'two']);
  choice.addToPage(page, { x: 50, y: 600, width: 200, height: 24 });
  return doc.save({ useObjectStreams: false });
}

async function run() {
  const threePages = await textPdf(['Alpha page', 'Beta page', 'Gamma page'], { title: 'Secret title' });

  await test('parseRanges handles lists, open ranges and rejects bad input', () => {
    assertEq(JSON.stringify(ops.parseRanges('1-2, 4', 5)), '[0,1,3]');
    assertEq(JSON.stringify(ops.parseRanges('4-', 5)), '[3,4]');
    assertEq(JSON.stringify(ops.parseRangeGroups('1-2,3', 3)), '[[0,1],[2]]');
    for (const bad of ['0', '9', '3-1', 'abc', '']) {
      let threw = false;
      try { ops.parseRanges(bad, 5); } catch { threw = true; }
      assert(threw, `should reject "${bad}"`);
    }
  });

  await test('merge concatenates pages in order', async () => {
    const out = await ops.assemble([{ bytes: threePages }, { bytes: await textPdf(['Delta page']) }]);
    const text = await textOf(out);
    assertEq(text.length, 4);
    assert(text[0].includes('Alpha') && text[3].includes('Delta'));
  });

  await test('split produces one file per group', async () => {
    const out = await ops.splitGroups(threePages, [[0, 1], [2]], 'doc');
    assertEq(out.length, 2);
    assertEq(out[0].name, 'doc-1-2.pdf');
    assertEq(out[1].name, 'doc-3.pdf');
    assertEq((await textOf(out[0].bytes)).length, 2);
    assert((await textOf(out[1].bytes))[0].includes('Gamma'));
  });

  await test('delete removes page content from the file itself', async () => {
    const out = await ops.deletePages(threePages, [1]);
    const text = await textOf(out);
    assertEq(text.length, 2);
    assert(!text.join().includes('Beta'));
    assert(!(await fileContains(out, 'Beta page')), 'deleted text still inside the file');
  });

  await test('organize reorders, rotates and inserts blanks', async () => {
    const out = await ops.organize([threePages], [
      { file: 0, page: 2 }, { blank: true }, { file: 0, page: 0, rotate: 90 },
    ]);
    const text = await textOf(out);
    assertEq(text.length, 3);
    assert(text[0].includes('Gamma') && text[2].includes('Alpha'));
    const sizes = await sizesOf(out);
    assertEq(sizes[2][0], 842, 'rotated width');
  });

  await test('rotate keeps page count and swaps visible size', async () => {
    const out = await ops.rotatePages(threePages, { 0: 90, 2: 270 });
    const sizes = await sizesOf(out);
    assertEq(sizes[0][0], 842);
    assertEq(sizes[1][0], 595);
    assertEq(sizes[2][0], 842);
  });

  await test('crop changes the visible size, including on rotated pages', async () => {
    const rotated = await textPdf(['Rotated'], { rotate: [90] });
    const out = await ops.cropPages(rotated, { 0: { x: 0.25, y: 0.1, w: 0.5, h: 0.8 } });
    const [[w, h]] = await sizesOf(out);
    assertEq(w, 421, 'width');
    assertEq(h, 476, 'height');
  });

  await test('compress shrinks images and keeps text', async () => {
    const input = await imagePdf();
    const out = await ops.compress(input, { level: 'medium' });
    assert(out.length < input.length * 0.6, `only ${input.length} → ${out.length}`);
    assert((await textOf(out))[0].includes('Keep this text selectable'));
    await (await openPdfjs(out)).getPage(1).then(p => p.getOperatorList());
    return `${(input.length / 1e6).toFixed(2)} MB → ${(out.length / 1e6).toFixed(2)} MB`;
  });

  await test('compress strong is smaller than balanced, light never grows', async () => {
    const input = await imagePdf();
    const medium = await ops.compress(input, { level: 'medium' });
    const high = await ops.compress(input, { level: 'high' });
    const low = await ops.compress(input, { level: 'low' });
    assert(high.length < medium.length);
    assert(low.length <= input.length);
    return `light ${(low.length / 1e6).toFixed(2)}, balanced ${(medium.length / 1e6).toFixed(2)}, strong ${(high.length / 1e6).toFixed(2)} MB`;
  });

  await test('watermark adds text, including Polish and Czech characters', async () => {
    const out = await ops.watermark(threePages, { text: 'Poufne žluťoučký ł', size: 40, opacity: 0.3, angle: 45, position: 'center', color: '#cc0000' });
    const text = await textOf(out);
    assert(text[1].includes('Poufne'), 'Latin part missing');
    assert(text[1].includes('ł') && text[1].includes('ž'), 'diacritics missing');
  });

  await test('page numbers respect format, start and range', async () => {
    const out = await ops.pageNumbers(threePages, { format: '{n} / {total}', startAt: 1, position: 'bottom-center' });
    const text = await textOf(out);
    assert(text[0].includes('1 / 3'));
    assert(text[2].includes('3 / 3'));
    const partial = await ops.pageNumbers(threePages, { format: '{n}', startAt: 10, from: 2, to: 3, position: 'top-right' });
    const t2 = await textOf(partial);
    assert(!/\b10\b/.test(t2[0]) && t2[1].includes('10') && t2[2].includes('11'));
  });

  await test('edits place text at the expected spot on normal and rotated pages', async () => {
    for (const angle of [0, 90, 180, 270]) {
      const base = await textPdf(['Base'], { rotate: [angle] });
      const out = await ops.applyEdits(base, [
        { page: 0, type: 'text', x: 0.1, y: 0.1, w: 0.5, h: 0.05, text: 'Added', size: 18, color: '#000000' },
        { page: 0, type: 'whiteout', x: 0.5, y: 0.5, w: 0.1, h: 0.1 },
        { page: 0, type: 'highlight', x: 0.1, y: 0.7, w: 0.3, h: 0.05, color: '#ffe600' },
        { page: 0, type: 'draw', x: 0, y: 0, w: 1, h: 1, points: [[0.1, 0.9], [0.5, 0.95]], color: '#0000ff', width: 2 },
      ]);
      const pdf = await openPdfjs(out);
      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const added = content.items.find(it => it.str === 'Added');
      assert(added, `text missing at ${angle}°`);
      const [vx, vy] = viewport.convertToViewportPoint(added.transform[4], added.transform[5]);
      assert(Math.abs(vx / viewport.width - 0.1) < 0.01, `x off at ${angle}°: ${vx / viewport.width}`);
      assert(Math.abs(vy / viewport.height - 0.1) < 0.04, `y off at ${angle}°: ${vy / viewport.height}`);
      await pdf.destroy();
    }
  });

  await test('forms are read, filled with diacritics, and flattened', async () => {
    const input = await formPdf();
    const fields = await ops.readFormFields(input);
    assertEq(fields.length, 3);
    const filled = await ops.fillForm(input, { name: 'Łukasz Dvořák', agree: true, choice: 'two' });
    const back = await ops.readFormFields(filled);
    assertEq(back.find(f => f.name === 'name').value, 'Łukasz Dvořák');
    assertEq(back.find(f => f.name === 'agree').value, true);
    const flat = await ops.fillForm(input, { name: 'Anna' }, { flatten: true });
    assertEq((await ops.readFormFields(flat)).length, 0);
    assert((await textOf(flat))[0].includes('Anna'));
  });

  await test('metadata is written and fully cleared', async () => {
    const written = await ops.writeMetadata(threePages, { title: 'New', author: 'Me', keywords: 'a, b' });
    const meta = await ops.readMetadata(written);
    assertEq(meta.title, 'New');
    assertEq(meta.author, 'Me');
    const cleared = await ops.writeMetadata(threePages, {}, { clearAll: true });
    assertEq((await ops.readMetadata(cleared)).title, '');
    assert(!(await fileContains(cleared, 'Secret title')), 'title still in file');
  });

  await test('flatten turns form values into page content', async () => {
    const filled = await ops.fillForm(await formPdf(), { name: 'Flat Value' });
    const out = await ops.flatten(filled);
    assertEq((await ops.readFormFields(out)).length, 0);
    assert((await textOf(out))[0].includes('Flat Value'));
  });

  await test('redaction removes the text from the file, not just from view', async () => {
    const input = await textPdf(['TOPSECRET-1234', 'Public page', 'TOPSECRET-5678'], { title: 'Meta TOPSECRET' });
    const out = await ops.redact(input, { 0: [{ x: 0, y: 0, w: 1, h: 0.3 }], 2: [{ x: 0, y: 0, w: 1, h: 0.3 }] });
    const text = await textOf(out);
    assertEq(text.length, 3);
    assert(text[1].includes('Public page'), 'unredacted page lost its text');
    assert(!text.join().includes('TOPSECRET'), 'secret still extractable');
    assert(!(await fileContains(out, 'TOPSECRET')), 'secret still inside the file bytes');
  });

  await test('redaction keeps page size on rotated pages', async () => {
    const input = await textPdf(['Rotated secret'], { rotate: [90] });
    const out = await ops.redact(input, { 0: [{ x: 0, y: 0, w: 0.2, h: 0.2 }] });
    assertEq(JSON.stringify(await sizesOf(out)), JSON.stringify([[842, 595]]));
  });

  await test('protect requires the password, unlock restores access', async () => {
    const locked = await ops.protect(threePages, { userPassword: 'pässwörd-1', allowPrint: false });
    assert(await ops.isEncrypted(locked), 'not encrypted');
    let refused = false;
    try { await textOf(locked); } catch (e) { refused = e.name === 'PasswordException'; }
    assert(refused, 'opened without password');
    assert((await textOf(locked, 'pässwörd-1'))[0].includes('Alpha'));
    const open = await ops.unlock(locked, 'pässwörd-1');
    assert(!(await ops.isEncrypted(open)));
    assert((await textOf(open))[0].includes('Alpha'));
    let wrong = false;
    try { await ops.unlock(locked, 'nope'); } catch { wrong = true; }
    assert(wrong, 'wrong password accepted');
  });

  await test('pages render to JPG and PNG at the requested resolution', async () => {
    const jpg = await ops.renderPages(threePages, { dpi: 144, mime: 'image/jpeg' });
    assertEq(jpg.length, 3);
    assertEq(jpg[0].width, 1190);
    assertEq(jpg[0].bytes[0], 0xff);
    const png = await ops.renderPages(threePages, { dpi: 72, mime: 'image/png', pages: [1] });
    assertEq(png.length, 1);
    assertEq(png[0].bytes[0], 0x89);
  });

  await test('images become pages: fit, A4, and EXIF-free JPEG/PNG input', async () => {
    const jpg = await canvasBytes(noisyCanvas(800, 600), 'image/jpeg', 0.8);
    const png = await canvasBytes(noisyCanvas(300, 500), 'image/png');
    const a4 = await ops.imagesToPdf([{ bytes: jpg, mime: 'image/jpeg' }, { bytes: png, mime: 'image/png' }], { size: 'a4', margin: 20 });
    assertEq(JSON.stringify(await sizesOf(a4)), JSON.stringify([[842, 595], [595, 842]]));
    const fit = await ops.imagesToPdf([{ bytes: jpg, mime: 'image/jpeg' }], { size: 'fit' });
    assertEq(JSON.stringify(await sizesOf(fit)), JSON.stringify([[600, 450]]));
  });

  await test('webp input is normalised through the canvas', async () => {
    const webp = new File([await canvasBytes(noisyCanvas(64, 64), 'image/webp')], 'a.webp', { type: 'image/webp' });
    const norm = await ops.normalizeImage(webp);
    const out = await ops.imagesToPdf([norm], { size: 'fit' });
    assertEq((await sizesOf(out)).length, 1);
  });

  await test('text extraction returns paragraphs', async () => {
    const out = await ops.pdfToText(threePages);
    assert(out.includes('Alpha page') && out.includes('Gamma page'));
  });

  await test('scanned detection distinguishes text from image pages', async () => {
    assert(!(await ops.looksScanned(await textPdf(['This page carries a full sentence of real text.']))));
    const jpg = await canvasBytes(noisyCanvas(300, 300), 'image/jpeg', 0.8);
    assert(await ops.looksScanned(await ops.imagesToPdf([{ bytes: jpg, mime: 'image/jpeg' }], { size: 'fit' })));
  });

  await test('DOCX export is a valid package holding the text', async () => {
    const { unzipSync, strFromU8 } = await fflate();
    const docx = await ops.pdfToDocx(threePages, { mode: 'text' });
    const files = unzipSync(docx);
    const xml = strFromU8(files['word/document.xml']);
    assert(xml.includes('Alpha page'));
    assert(xml.includes('w:pageBreakBefore'));
    assert(!new DOMParser().parseFromString(xml, 'application/xml').querySelector('parsererror'), 'document.xml not well-formed');
    const layout = unzipSync(await ops.pdfToDocx(threePages, { mode: 'layout' }));
    assert(layout['word/media/image2.jpeg'], 'page image missing');
    assert(!new DOMParser().parseFromString(strFromU8(layout['word/document.xml']), 'application/xml').querySelector('parsererror'));
  });

  await test('XLSX export finds columns and numeric cells', async () => {
    const { PDFDocument, StandardFonts } = await pdfLib();
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const rows = [['Item', 'Qty', 'Price'], ['Apples', '3', '1,50'], ['Pears', '12', '2,25']];
    rows.forEach((row, r) => row.forEach((cell, c) => {
      page.drawText(cell, { x: 60 + c * 150, y: 700 - r * 24, size: 12, font });
    }));
    const { unzipSync, strFromU8 } = await fflate();
    const files = unzipSync(await ops.pdfToXlsx(await doc.save()));
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']);
    assert(sheet.includes('<c r="A1" t="inlineStr">'), 'header cell');
    assert(sheet.includes('<c r="B2"><v>3</v></c>'), `numeric cell: ${sheet.slice(0, 500)}`);
    assert(sheet.includes('<c r="C3"><v>2.25</v></c>'), 'decimal comma');
  });

  await test('OCR adds a searchable invisible layer to a scanned page', async () => {
    const canvas = new OffscreenCanvas(1240, 1754);
    const c = canvas.getContext('2d');
    c.fillStyle = '#fff'; c.fillRect(0, 0, 1240, 1754);
    c.fillStyle = '#000'; c.font = '64px Georgia, serif';
    c.fillText('The quick brown fox jumps', 100, 300);
    c.fillText('over the lazy dog', 100, 400);
    const jpg = await canvasBytes(canvas, 'image/jpeg', 0.92);
    const scan = await ops.imagesToPdf([{ bytes: jpg, mime: 'image/jpeg' }], { size: 'a4' });
    assert(await ops.looksScanned(scan));
    const { pdf } = await ops.ocrPdf(scan, { lang: 'eng', dpi: 150 });
    const text = (await textOf(pdf))[0];
    assert(/quick/i.test(text) && /lazy/i.test(text), `OCR text: ${text}`);
    return text.slice(0, 60);
  });

  const failed = results.filter(r => !r.ok);
  document.title = failed.length ? `FAILED ${failed.length}/${results.length}` : `PASSED ${results.length}`;
  window.__results = results;
  log.textContent += `\n${results.length - failed.length}/${results.length} passed\n`;
}

run();
