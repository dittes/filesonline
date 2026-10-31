// ocr.js
// Text recognition for images and scanned PDFs with the same self-hosted Tesseract the PDF tools use.

import { createOcrWorker, openPdfjs } from '../pdf/lib.js';

export async function ocrImage(url, lang, onProgress) {
  const worker = await createOcrWorker(lang, (m) => { if (m.status === 'recognizing text') onProgress?.(m.progress || 0); });
  const { data } = await worker.recognize(url);
  await worker.terminate();
  return data.text || '';
}

export async function ocrPdf(bytes, lang, onProgress, maxPages = 100) {
  const pdf = await openPdfjs(bytes);
  const total = Math.min(pdf.numPages, maxPages);
  let page = 0;
  const worker = await createOcrWorker(lang, (m) => { if (m.status === 'recognizing text') onProgress?.((page + (m.progress || 0)) / total); });
  const parts = [];
  for (page = 0; page < total; page++) {
    const p = await pdf.getPage(page + 1);
    const viewport = p.getViewport({ scale: 200 / 72 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await p.render({ canvasContext: canvas.getContext('2d'), viewport, intent: 'print', background: '#ffffff' }).promise;
    const { data } = await worker.recognize(canvas);
    parts.push(`[Page ${page + 1}]\n${data.text || ''}`);
    canvas.width = canvas.height = 0;
  }
  await worker.terminate();
  await pdf.destroy();
  return parts.join('\n\n');
}
