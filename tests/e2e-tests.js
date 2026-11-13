// e2e-tests.js
// Drives every PDF tool page through its real UI inside an iframe: drops a file,
// performs the interaction a person would, clicks run, and validates the download.
// ?lang=de runs the localized pages; ?only=sign,crop narrows the run.

import { pdfLib, openPdfjs } from '/assets/js/pdf/lib.js';
import routesEn from '/assets/i18n/routes.en.js';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') || 'en';
const only = params.get('only')?.split(',');
const routes = lang === 'en' ? routesEn : (await import(`/assets/i18n/routes.${lang}.js`)).default;

const log = document.getElementById('log');
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function until(fn, ms = 30000, what = 'condition') {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = fn();
    if (v) return v;
    await sleep(40);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const { PDFDocument, StandardFonts } = await pdfLib();

async function makePdf(pages = 3, { form = false, label = 'Sample page' } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`${label} ${i + 1}`, { x: 60, y: 760, size: 20, font });
    page.drawText('Quarterly report with enough text to count as a real document.', { x: 60, y: 730, size: 11, font });
  }
  if (form) {
    const f = doc.getForm();
    f.createTextField('fullname').addToPage(doc.getPage(0), { x: 60, y: 600, width: 300, height: 24 });
    f.createCheckBox('agree').addToPage(doc.getPage(0), { x: 60, y: 560, width: 18, height: 18 });
  }
  return new File([await doc.save()], 'fixture.pdf', { type: 'application/pdf' });
}

async function makeImage(type = 'image/jpeg') {
  const canvas = new OffscreenCanvas(640, 480);
  const c = canvas.getContext('2d');
  c.fillStyle = '#3366cc'; c.fillRect(0, 0, 640, 480);
  c.fillStyle = '#fff'; c.font = '40px sans-serif'; c.fillText('Fixture', 200, 240);
  const ext = type === 'image/png' ? 'png' : 'jpg';
  return new File([await canvas.convertToBlob({ type, quality: 0.8 })], `photo.${ext}`, { type });
}

// ─── Page driver ──────────────────────────────────────────────────────────────

function loadTool(id, query = '') {
  return new Promise((resolve, reject) => {
    const frame = document.getElementById('frame');
    frame.onload = async () => {
      const w = frame.contentWindow;
      try {
        await until(() => w.document.querySelector('.pt-drop'), 5000, 'dropzone');
        resolve(w);
      } catch (e) { reject(e); }
    };
    frame.src = routes[id].url + query;
  });
}

async function drop(w, files) {
  const dt = new w.DataTransfer();
  for (const f of files) dt.items.add(new w.File([f], f.name, { type: f.type }));
  w.document.querySelector('.pt-drop').dispatchEvent(new w.DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  await until(() => w.document.querySelector('.pt-panel') || w.document.querySelector('.pt-password')
    || !w.document.querySelector('.pt-drop__error').hidden, 15000, 'panel');
  const err = w.document.querySelector('.pt-drop__error');
  if (!err.hidden && err.textContent) throw new Error(`drop rejected: ${err.textContent}`);
}

function pointer(w, target, type, x, y) {
  target.dispatchEvent(new w.PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0 }));
}

/** Drag on the first page of a PageEditor from (u0,v0) to (u1,v1), in page fractions. */
function dragOnPage(w, u0, v0, u1, v1, pageIndex = 0) {
  const layer = w.document.querySelectorAll('.pe__layer')[pageIndex];
  layer.setPointerCapture = () => {};
  const r = layer.getBoundingClientRect();
  const x = u => r.left + u * r.width;
  const y = v => r.top + v * r.height;
  pointer(w, layer, 'pointerdown', x(u0), y(v0));
  pointer(w, layer, 'pointermove', x(u1), y(v1));
  pointer(w, layer, 'pointerup', x(u1), y(v1));
}

function clickPage(w, u, v, pageIndex = 0) {
  dragOnPage(w, u, v, u, v, pageIndex);
}

async function run(w) {
  const before = w.document.querySelector('[data-run]');
  if (!before) throw new Error('no run button');
  before.click();
  await until(() => {
    const error = w.document.querySelector('.pt-panel__error');
    return w.document.querySelector('.pt-result') || (error && !error.hidden);
  }, 60000, 'result');
  if (!w.document.querySelector('.pt-result')) {
    throw new Error(`tool reported: ${w.document.querySelector('.pt-panel__error').textContent}`);
  }
}

/** Capture the file that Download hands to the browser. */
async function captureDownload(w) {
  const original = w.URL.createObjectURL.bind(w.URL);
  let captured = null;
  w.URL.createObjectURL = blob => { captured = blob; return original(blob); };
  w.HTMLAnchorElement.prototype.click = function () {};
  w.document.querySelector('.pt-result__actions .s-btn--primary').click();
  await until(() => captured, 5000, 'download');
  w.URL.createObjectURL = original;
  return new Uint8Array(await captured.arrayBuffer());
}

async function pdfText(bytes, password) {
  const pdf = await openPdfjs(bytes, password);
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    out.push((await (await pdf.getPage(i)).getTextContent()).items.map(x => x.str).join(' '));
  }
  await pdf.destroy();
  return out;
}

const isZip = b => b[0] === 0x50 && b[1] === 0x4b;
const isPdf = b => String.fromCharCode(...b.subarray(0, 5)) === '%PDF-';
const check = (cond, msg) => { if (!cond) throw new Error(msg); };

// ─── Scenarios ────────────────────────────────────────────────────────────────

const scenarios = {
  async merge(w) {
    await drop(w, [await makePdf(2, { label: 'First' }), await makePdf(1, { label: 'Second' })]);
    check(w.document.querySelectorAll('.pt-files__item').length === 2, 'file list');
    await run(w);
    const text = await pdfText(await captureDownload(w));
    check(text.length === 3 && text[2].includes('Second'), 'merged order');
  },
  async split(w) {
    await drop(w, [await makePdf(3)]);
    await until(() => w.document.querySelector('.pg__item'));
    await run(w);
    check(isZip(await captureDownload(w)), 'zip expected');
    check(w.document.querySelectorAll('.pt-result__files li').length === 3, 'three files');
  },
  async extract(w) {
    await drop(w, [await makePdf(3)]);
    w.document.querySelectorAll('.pg__select')[1].click();
    await run(w);
    const text = await pdfText(await captureDownload(w));
    check(text.length === 1 && text[0].includes('page 2'), 'extracted page');
  },
  async delete(w) {
    await drop(w, [await makePdf(3)]);
    w.document.querySelectorAll('.pg__select')[0].click();
    await run(w);
    const text = await pdfText(await captureDownload(w));
    check(text.length === 2 && text[0].includes('page 2'), 'deleted first page');
  },
  async organize(w) {
    await drop(w, [await makePdf(3)]);
    const later = w.document.querySelectorAll('.pg__item')[0].querySelectorAll('.pg__btn');
    later[2].click(); // move page 1 later
    await sleep(50);
    await run(w);
    const text = await pdfText(await captureDownload(w));
    check(text[0].includes('page 2') && text[1].includes('page 1'), 'order changed');
  },
  async rotate(w) {
    await drop(w, [await makePdf(2)]);
    w.document.querySelector('.pg__item .pg__btn').click();
    await sleep(50);
    await run(w);
    const pdf = await openPdfjs(await captureDownload(w));
    check((await pdf.getPage(1)).rotate === 90, 'rotation saved');
    await pdf.destroy();
  },
  async crop(w) {
    await drop(w, [await makePdf(2)]);
    await until(() => w.document.querySelector('.pe__layer'));
    dragOnPage(w, 0.1, 0.1, 0.6, 0.6);
    check(w.document.querySelector('.pe__item'), 'crop box created');
    await run(w);
    const pdf = await openPdfjs(await captureDownload(w));
    const v = (await pdf.getPage(2)).getViewport({ scale: 1 });
    check(Math.abs(v.width - 595 * 0.5) < 3 && Math.abs(v.height - 842 * 0.5) < 3, `crop size ${v.width}x${v.height}`);
    await pdf.destroy();
  },
  async compress(w) {
    await drop(w, [await makePdf(2)]);
    await run(w);
    check(isPdf(await captureDownload(w)), 'pdf output');
  },
  async ocr(w) {
    // Rasterized page, so the only way to get text back is real recognition
    const canvas = new OffscreenCanvas(1240, 1754);
    const c = canvas.getContext('2d');
    c.fillStyle = '#fff'; c.fillRect(0, 0, 1240, 1754);
    c.fillStyle = '#000'; c.font = '64px Georgia, serif';
    c.fillText('Searchable invoice number', 100, 300);
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const img = await doc.embedJpg(new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer()));
    page.drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
    await drop(w, [new File([await doc.save()], 'scan.pdf', { type: 'application/pdf' })]);
    await run(w);
    const text = await pdfText(await captureDownload(w));
    check(/invoice/i.test(text[0]), `OCR text: ${text[0]}`);
  },
  async flatten(w) {
    await drop(w, [await makePdf(1, { form: true })]);
    await run(w);
    const out = await captureDownload(w);
    check((await PDFDocument.load(out)).getForm().getFields().length === 0, 'fields remain');
  },
  async 'pdf-to-word'(w) {
    await drop(w, [await makePdf(2)]);
    await run(w);
    check(isZip(await captureDownload(w)), 'docx is a zip');
  },
  async 'pdf-to-excel'(w) {
    await drop(w, [await makePdf(2)]);
    await run(w);
    check(isZip(await captureDownload(w)), 'xlsx is a zip');
  },
  async 'pdf-to-jpg'(w) {
    await drop(w, [await makePdf(2)]);
    await run(w);
    check(isZip(await captureDownload(w)), 'zip of images');
  },
  async 'pdf-to-png'(w) {
    await drop(w, [await makePdf(1)]);
    await run(w);
    const out = await captureDownload(w);
    check(out[0] === 0x89, 'single PNG');
  },
  async 'pdf-to-text'(w) {
    await drop(w, [await makePdf(2)]);
    await run(w);
    const text = new TextDecoder().decode(await captureDownload(w));
    check(text.includes('Sample page 2'), 'text extracted');
  },
  async 'jpg-to-pdf'(w) {
    await drop(w, [await makeImage(), await makeImage()]);
    await run(w);
    check((await pdfText(await captureDownload(w))).length === 2, 'two pages');
  },
  async 'png-to-pdf'(w) {
    await drop(w, [await makeImage('image/png')]);
    await run(w);
    check((await pdfText(await captureDownload(w))).length === 1, 'one page');
  },
  async edit(w) {
    await drop(w, [await makePdf(1)]);
    await until(() => w.document.querySelector('.pe__layer'));
    clickPage(w, 0.2, 0.5);
    const box = await until(() => w.document.querySelector('.pe__text'));
    box.textContent = 'Added žluť';
    box.dispatchEvent(new w.Event('input', { bubbles: true }));
    await sleep(50);
    await run(w);
    const text = await pdfText(await captureDownload(w));
    check(text[0].includes('Added') && text[0].includes('ž'), `edit text: ${text[0]}`);
  },
  async sign(w) {
    await drop(w, [await makePdf(1)]);
    await until(() => w.document.querySelector('.pe__layer'));
    const typed = w.document.querySelector('.pt-sig input[type="text"]');
    typed.value = 'Ada Lovelace';
    typed.dispatchEvent(new w.Event('input', { bubbles: true }));
    // The signature image is produced asynchronously; clicking before it exists places nothing
    await until(() => {
      clickPage(w, 0.5, 0.7);
      return w.document.querySelector('.pe__item[data-type="image"]');
    }, 8000, 'placed signature');
    await run(w);
    const doc = await PDFDocument.load(await captureDownload(w));
    check(doc.getPageCount() === 1, 'signed');
  },
  async 'form-filler'(w) {
    await drop(w, [await makePdf(1, { form: true })]);
    const input = w.document.querySelector('.pt-formfields input[type="text"]');
    input.value = 'Łukasz Dvořák';
    await run(w);
    const doc = await PDFDocument.load(await captureDownload(w));
    check(doc.getForm().getTextField('fullname').getText() === 'Łukasz Dvořák', 'value saved');
  },
  async watermark(w) {
    await drop(w, [await makePdf(1)]);
    await sleep(300);
    await run(w);
    const text = await pdfText(await captureDownload(w));
    check(text[0].length > 40, 'watermark text added');
  },
  async 'page-numbers'(w) {
    await drop(w, [await makePdf(3)]);
    await sleep(200);
    await run(w);
    const text = await pdfText(await captureDownload(w));
    check(/\b3\b/.test(text[2].replace('Sample page 3', '')), `number on page 3: ${text[2]}`);
  },
  async protect(w) {
    await drop(w, [await makePdf(1)]);
    const [a, b] = w.document.querySelectorAll('input[type="password"]');
    a.value = b.value = 'tajné-heslo';
    await run(w);
    const out = await captureDownload(w);
    check((await pdfText(out, 'tajné-heslo'))[0].includes('Sample'), 'opens with password');
    let refused = false;
    try { await pdfText(out); } catch { refused = true; }
    check(refused, 'opened without password');
  },
  async unlock(w) {
    const { protect } = await import('/assets/js/pdf/ops.js');
    const locked = await protect(new Uint8Array(await (await makePdf(1)).arrayBuffer()), { userPassword: 'open-sesame' });
    await drop(w, [new File([locked], 'locked.pdf', { type: 'application/pdf' })]);
    w.document.querySelector('input[type="password"]').value = 'wrong';
    await run(w).then(() => { throw new Error('wrong password accepted'); }, e => {
      if (!/tool reported/.test(e.message)) throw e;
    });
    w.document.querySelector('input[type="password"]').value = 'open-sesame';
    await run(w);
    check((await pdfText(await captureDownload(w)))[0].includes('Sample'), 'unlocked');
  },
  async redact(w) {
    await drop(w, [await makePdf(2, { label: 'TOPSECRET' })]);
    await until(() => w.document.querySelector('.pe__layer'));
    dragOnPage(w, 0, 0, 1, 0.3);
    await run(w);
    const text = await pdfText(await captureDownload(w));
    check(!text[0].includes('TOPSECRET'), 'secret still present');
    check(text[1].includes('TOPSECRET'), 'unmarked page should keep its text');
  },
  async metadata(w) {
    await drop(w, [await makePdf(1)]);
    const title = w.document.querySelector('.pt-formfields input');
    title.value = 'New title';
    await run(w);
    check((await PDFDocument.load(await captureDownload(w), { updateMetadata: false })).getTitle() === 'New title', 'title saved');
  },
};

// Encrypted input is asked for its password before any other tool opens
scenarios.compare = async w => {
  const older = await PDFDocument.create();
  const newer = await PDFDocument.create();
  const font = await older.embedFont(StandardFonts.Helvetica);
  const font2 = await newer.embedFont(StandardFonts.Helvetica);
  older.addPage([595, 842]).drawText('The rent is 900 euros per month, due on the first day.', { x: 60, y: 760, size: 14, font });
  newer.addPage([595, 842]).drawText('The rent is 950 euros per month, due on the third day.', { x: 60, y: 760, size: 14, font: font2 });
  await drop(w, [
    new File([await older.save()], 'old.pdf', { type: 'application/pdf' }),
    new File([await newer.save()], 'new.pdf', { type: 'application/pdf' }),
  ]);
  await until(() => w.document.querySelector('.pt-diff'), 15000, 'diff list');
  const ins = [...w.document.querySelectorAll('.pt-diff ins')].map(x => x.textContent);
  const del = [...w.document.querySelectorAll('.pt-diff del')].map(x => x.textContent);
  check(ins.includes('950') && ins.includes('third'), `added words ${ins}`);
  check(del.includes('900') && del.includes('first'), `removed words ${del}`);
  await run(w);
  check(isZip(await captureDownload(w)), 'zip expected');
  check(w.document.querySelectorAll('.pt-result__files li').length === 2, 'two marked files');
};

scenarios['extract-images'] = async w => {
  const doc = await PDFDocument.create();
  const jpg = await doc.embedJpg(await (await makeImage('image/jpeg')).arrayBuffer());
  const png = await doc.embedPng(await (await makeImage('image/png')).arrayBuffer());
  doc.addPage([595, 842]).drawImage(jpg, { x: 50, y: 400, width: 320, height: 240 });
  doc.addPage([595, 842]).drawImage(png, { x: 50, y: 400, width: 320, height: 240 });
  await drop(w, [new File([await doc.save()], 'photos.pdf', { type: 'application/pdf' })]);
  check(w.document.querySelectorAll('.pt-imgs__item').length === 2, 'two images found');
  await run(w);
  const zip = await captureDownload(w);
  check(isZip(zip), 'zip expected');
  const names = [...w.document.querySelectorAll('.pt-result__name')].map(x => x.textContent);
  check(names.includes('photos-page1-1.jpg') && names.includes('photos-page2-1.png'), `names ${names}`);
};

scenarios['remove-blank'] = async w => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of ['Chapter one', null, 'Chapter two', null]) {
    const page = doc.addPage([595, 842]);
    if (text) {
      page.drawText(text, { x: 60, y: 760, size: 20, font });
      for (let i = 0; i < 20; i++) page.drawText('A line of body text that fills the page with ink.', { x: 60, y: 700 - i * 22, size: 12, font });
    }
  }
  await drop(w, [new File([await doc.save()], 'scan.pdf', { type: 'application/pdf' })]);
  const selected = [...w.document.querySelectorAll('.pg__select')].map(b => b.checked);
  check(selected.join() === 'false,true,false,true', `blank pages marked ${selected}`);
  await run(w);
  const text = await pdfText(await captureDownload(w));
  check(text.length === 2 && text[1].includes('Chapter two'), 'blank pages removed');
};

scenarios.alternate = async w => {
  await drop(w, [await makePdf(3, { label: 'Front' }), await makePdf(3, { label: 'Back' })]);
  check(w.document.querySelectorAll('.pg__item').length === 6, 'preview of six pages');
  await run(w);
  const text = await pdfText(await captureDownload(w));
  const order = text.map(x => x.match(/(Front|Back) \d/)[0]).join(', ');
  check(order === 'Front 1, Back 3, Front 2, Back 2, Front 3, Back 1', `order ${order}`);
};

scenarios['password-gate'] = async () => {
  const { protect } = await import('/assets/js/pdf/ops.js');
  const locked = await protect(new Uint8Array(await (await makePdf(2)).arrayBuffer()), { userPassword: 'gate-pass' });
  const w = await loadTool('compress');
  await drop(w, [new File([locked], 'locked.pdf', { type: 'application/pdf' })]);
  const input = w.document.querySelector('.pt-password input');
  check(input, 'password prompt shown');
  input.value = 'gate-pass';
  w.document.querySelector('.pt-password .s-btn--primary').click();
  await until(() => w.document.querySelector('.pt-panel'), 5000, 'panel after password');
};

scenarios['handoff'] = async () => {
  const w = await loadTool('compress');
  await drop(w, [await makePdf(2)]);
  await run(w);
  await new Promise(resolve => {
    document.getElementById('frame').onload = resolve;
    w.document.querySelector('.pt-next__link').click();
  });
  const w2 = document.getElementById('frame').contentWindow;
  await until(() => w2.document.querySelector('.pt-panel'), 8000, 'tool opened with the handed-off file');
};

scenarios['wrong-file-type'] = async () => {
  const w = await loadTool('compress');
  const dt = new w.DataTransfer();
  dt.items.add(new w.File(['not a pdf'], 'notes.pdf', { type: 'application/pdf' }));
  w.document.querySelector('.pt-drop').dispatchEvent(new w.DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  await until(() => !w.document.querySelector('.pt-drop__error').hidden, 5000, 'error message');
};

// ─── Runner ───────────────────────────────────────────────────────────────────

for (const [name, fn] of Object.entries(scenarios)) {
  if (only && !only.includes(name)) continue;
  const started = performance.now();
  let line;
  try {
    const needsPage = fn.length > 0;
    const w = needsPage ? await loadTool(name) : null;
    const errors = [];
    if (w) w.addEventListener('securitypolicyviolation', e => errors.push(`CSP blocked ${e.blockedURI} (${e.violatedDirective})`));
    await fn(w);
    if (errors.length) throw new Error(errors.join('; '));
    results.push({ name, ok: true });
    line = `PASS  ${name}`;
  } catch (err) {
    results.push({ name, ok: false, error: String(err.message || err) });
    line = `FAIL  ${name}: ${err.message || err}`;
  }
  log.textContent += `${line}  (${Math.round(performance.now() - started)} ms)\n`;
  window.scrollTo(0, 0);
}

const failed = results.filter(r => !r.ok);
log.textContent += `\n${results.length - failed.length}/${results.length} passed (${lang})\n`;
document.title = failed.length ? `FAILED ${failed.length}/${results.length}` : `PASSED ${results.length}`;
window.__results = results;
