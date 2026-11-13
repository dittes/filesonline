// demo.js
// A handful of sample files made on the spot, so the file manager can be tried
// without opening anything from disk.

const text = (name, body, type = 'text/plain') => new File([body], name, { type, lastModified: Date.now() - Math.round(Math.random() * 6e9) });

function picture(name, hue, label) {
  const canvas = document.createElement('canvas');
  canvas.width = 960; canvas.height = 640;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 960, 640);
  g.addColorStop(0, `hsl(${hue} 80% 62%)`);
  g.addColorStop(1, `hsl(${(hue + 50) % 360} 75% 42%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 960, 640);
  ctx.fillStyle = 'rgba(255,255,255,.18)';
  for (let i = 0; i < 7; i++) { ctx.beginPath(); ctx.arc(140 + i * 130, 420 - (i % 3) * 110, 90 + (i % 2) * 40, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = '#fff';
  ctx.font = '600 54px system-ui, sans-serif';
  ctx.fillText(label, 56, 110);
  return new Promise(resolve => canvas.toBlob(blob => resolve(new File([blob], name, { type: blob.type, lastModified: Date.now() - 864e5 * 3 })), name.endsWith('.png') ? 'image/png' : 'image/jpeg', 0.88));
}

async function pdf(name, title, pages) {
  const { pdfLib } = await import('../pdf/lib.js');
  const { PDFDocument, StandardFonts, rgb } = await pdfLib();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595, 842]);
    page.drawRectangle({ x: 0, y: 782, width: 595, height: 60, color: rgb(0.145, 0.341, 0.839) });
    page.drawText(title, { x: 48, y: 804, size: 18, font: bold, color: rgb(1, 1, 1) });
    page.drawText(`Page ${i + 1} of ${pages}`, { x: 48, y: 730, size: 13, font: bold });
    for (let line = 0; line < 14; line++) {
      page.drawText('Sample text so that this document has something to search, convert and compress.', { x: 48, y: 700 - line * 22, size: 11, font, color: rgb(0.25, 0.27, 0.32) });
    }
  }
  return new File([await doc.save()], name, { type: 'application/pdf', lastModified: Date.now() - 864e5 * 9 });
}

export async function demoFiles() {
  const report = await pdf('quarterly-report.pdf', 'Quarterly report', 3);
  const invoice = await pdf('invoice-2041.pdf', 'Invoice 2041', 1);
  const beach = await picture('IMG_0412.jpg', 195, 'Beach');
  const hills = await picture('IMG_0413.jpg', 120, 'Hills');
  const dusk = await picture('IMG_0414.jpg', 20, 'Dusk');
  const logo = await picture('logo.png', 225, 'Logo');
  const notes = '# Trip notes\n\n- Book the ferry\n- Charge the camera\n- Print the tickets\n\n## Budget\n\n| Item | Cost |\n| --- | --- |\n| Ferry | 48 |\n| Hotel | 310 |\n';
  const csv = 'date,item,amount\n2026-09-01,Ferry,48.00\n2026-09-02,Hotel,310.00\n2026-09-03,Dinner,62.500\n2026-09-04,Museum,24.00\n';
  return [
    { file: report, dir: 'Documents' },
    { file: invoice, dir: 'Documents' },
    { file: text('budget.csv', csv, 'text/csv'), dir: 'Documents' },
    { file: text('notes.md', notes, 'text/markdown'), dir: 'Documents' },
    { file: beach, dir: 'Photos' },
    { file: hills, dir: 'Photos' },
    { file: dusk, dir: 'Photos' },
    { file: new File([beach], 'IMG_0412 copy.jpg', { type: beach.type, lastModified: beach.lastModified + 5000 }), dir: 'Photos/Backup' },
    { file: logo, dir: '' },
    { file: text('config.json', JSON.stringify({ name: 'demo', version: 3, features: ['zip', 'rename', 'preview'] }), 'application/json'), dir: '' },
    { file: text('readme.txt', 'These sample files were made in your browser. Nothing was downloaded or uploaded.\n'), dir: '' },
  ];
}
