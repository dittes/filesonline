// lib.js
// Lazy loaders for the self-hosted PDF libraries. Nothing here touches the network
// beyond this origin, so the Content-Security-Policy can stay at connect-src 'self'.

const V = '/assets/vendor';

function once(factory) {
  let p = null;
  return () => (p ||= factory().catch(err => { p = null; throw err; }));
}

export const pdfLib = once(() => import(`${V}/pdf-lib/pdf-lib.esm.min.js`));
export const fflate = once(() => import(`${V}/fflate/fflate.js`));

export const pdfjs = once(async () => {
  const mod = await import(`${V}/pdfjs/pdf.min.mjs`);
  mod.GlobalWorkerOptions.workerSrc = `${V}/pdfjs/pdf.worker.min.mjs`;
  return mod;
});

/**
 * Open a document with pdf.js. pdf.js transfers the buffer to its worker, so
 * it gets a private copy and the caller's bytes stay usable.
 */
export async function openPdfjs(bytes, password) {
  const mod = await pdfjs();
  return mod.getDocument({
    data: bytes.slice(0),
    password,
    isEvalSupported: false,
    cMapUrl: `${V}/pdfjs/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${V}/pdfjs/standard_fonts/`,
  }).promise;
}

function loadClassicScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}

export const fontkit = once(async () => {
  await loadClassicScript(`${V}/pdf-lib/fontkit.umd.min.js`);
  return window.fontkit;
});

const qpdfFactory = once(async () => {
  await loadClassicScript(`${V}/qpdf/qpdf.js`);
  return window.Module;
});

/**
 * Run a qpdf command line against one in-memory file.
 * @param {Uint8Array} bytes  input PDF
 * @param {(input:string, output:string)=>string[]} args  builds the argv
 * @returns {Promise<Uint8Array>} output PDF
 */
export async function runQpdf(bytes, args) {
  const factory = await qpdfFactory();
  const errors = [];
  const qpdf = await factory({
    locateFile: () => `${V}/qpdf/qpdf.wasm`,
    print: () => {},
    printErr: line => errors.push(line),
  });
  qpdf.FS.writeFile('/in.pdf', bytes);
  let code = 0;
  try {
    code = qpdf.callMain(args('/in.pdf', '/out.pdf'));
  } catch (err) {
    // Emscripten reports exit() as an exception carrying a status
    code = typeof err?.status === 'number' ? err.status : 2;
  }
  // qpdf exits 3 for "succeeded with warnings"
  if (code !== 0 && code !== 3) {
    const e = new Error(errors.join('\n') || `qpdf exited with ${code}`);
    e.qpdf = errors.join('\n');
    throw e;
  }
  return qpdf.FS.readFile('/out.pdf');
}

export async function createOcrWorker(lang, onProgress) {
  const { createWorker } = await import(`${V}/tesseract/tesseract.esm.min.js`).then(m => m.default || m);
  return createWorker(lang, 1, {
    workerPath: `${V}/tesseract/worker.min.js`,
    corePath: `${V}/tesseract/`,
    langPath: `${V}/tesseract/lang`,
    workerBlobURL: false,
    gzip: true,
    logger: m => onProgress?.(m),
  });
}

export async function fontBytes(bold = false) {
  const res = await fetch(`${V}/fonts/DejaVuSans${bold ? '-Bold' : ''}.ttf`);
  return new Uint8Array(await res.arrayBuffer());
}
