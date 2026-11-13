// icons.mjs
// Inline SVG paths on a 24×24 grid, drawn as sheets of paper so the set reads as one family.

const SHEET = 'M6 3h8l4 4v14H6z M14 3v4h4';

export const ICONS = {
  file: `<path d="${SHEET}"/>`,
  merge: '<path d="M3 4h7v9H3z M14 11h7v9h-7z"/><path d="M10 8h4l-1.8-1.8M14 8l-1.8 1.8"/><path d="M10 16h4l-1.8-1.8M10 16l1.8 1.8" opacity="0"/><path d="M6.5 16v3.5H11"/>',
  split: '<path d="M4 3h16v7H4z M4 14h16v7H4z"/><path d="M2 12h3M9 12h2M14 12h2M19 12h3" stroke-dasharray="0"/>',
  extract: `<path d="${SHEET}"/><path d="M10 11h4v5h-4z"/><path d="M12 19v2"/>`,
  delete: `<path d="${SHEET}"/><path d="M9.5 12.5l5 5M14.5 12.5l-5 5"/>`,
  organize: '<path d="M3 3h7v8H3z M14 3h7v8h-7z M3 15h7v6H3z M14 15h7v6h-7z"/>',
  rotate: '<path d="M8 8h9v12H8z"/><path d="M4 12a8 8 0 0 1 8-9l3 0"/><path d="M12.5 .8L15 3l-2.5 2.2"/>',
  crop: '<path d="M6 2v16h16"/><path d="M2 6h16v16"/>',
  compress: `<path d="${SHEET}"/><path d="M12 9v3.5m0 0l-2-2m2 2l2-2M12 19v-3.5m0 0l-2 2m2-2l2 2"/>`,
  ocr: '<path d="M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5"/><path d="M8.5 16l3-8.5 3 8.5M9.6 13.2h3.8"/>',
  flatten: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/><path d="M3 18h18"/>',
  toWord: `<path d="${SHEET}"/><path d="M9 11l1.3 6 1.7-4.5 1.7 4.5 1.3-6"/>`,
  toExcel: `<path d="${SHEET}"/><path d="M9.5 11.5l5 6M14.5 11.5l-5 6"/>`,
  toImage: `<path d="${SHEET}"/><circle cx="10" cy="11.5" r="1.3"/><path d="M6 18l3.5-3 2.5 2 2.5-3 3.5 4"/>`,
  toText: `<path d="${SHEET}"/><path d="M9 11h6M9 14h6M9 17h4"/>`,
  fromImage: '<path d="M3 4h18v16H3z"/><circle cx="8.5" cy="9" r="1.6"/><path d="M3 17l5-4.5 3.5 3 4-4.5 5.5 6"/>',
  edit: `<path d="${SHEET}"/><path d="M9 18l.6-2.6 5-5 2 2-5 5z"/>`,
  sign: '<path d="M3 17c3-1 4-9 6-9s0 8 2 8 2-3 3.5-3 .5 2.5 2 2.5 2-1 3.5-1.5"/><path d="M3 21h18"/>',
  form: `<path d="${SHEET}"/><path d="M9 11h6v2.5H9z M9 16h6v2.5H9z"/>`,
  watermark: `<path d="${SHEET}"/><path d="M8.5 18l6-8"/><path d="M12 18l3.5-5" opacity=".5"/>`,
  numbers: `<path d="${SHEET}"/><path d="M10.5 14l1.5-1v5.5M10.5 18.5h3"/>`,
  protect: '<path d="M6 11h12v10H6z"/><path d="M8.5 11V7a3.5 3.5 0 0 1 7 0v4"/><path d="M12 15v2.5"/>',
  unlock: '<path d="M6 11h12v10H6z"/><path d="M8.5 11V7a3.5 3.5 0 0 1 6.8-1.2"/><path d="M12 15v2.5"/>',
  redact: `<path d="${SHEET}"/><path d="M8.5 11h7v2.6h-7z" fill="currentColor"/><path d="M8.5 16h7v2.6h-7z" fill="currentColor"/>`,
  metadata: '<path d="M4 4h8.5L20 11.5 12 20l-8-8z"/><circle cx="8.5" cy="8.5" r="1.3"/>',
  compare: '<path d="M3 4h7v16H3z M14 4h7v16h-7z"/><path d="M5.5 9h2M5.5 12.5h2M16.5 9h2M16.5 12.5h2" /><path d="M12 2v20" stroke-dasharray="2 2"/>',
  images: '<path d="M3 3h13v13H3z"/><circle cx="7.5" cy="7.5" r="1.4"/><path d="M3 13l4-3.5 3 2.5 3-3 3 3"/><path d="M13 20.5h8m0 0l-2.5-2.5M21 20.5L18.5 23"/>',
  blank: `<path d="${SHEET}"/><path d="M8.5 12h7M8.5 15.5h7M8.5 19h4" stroke-dasharray="1.2 2.2"/>`,
  alternate: '<path d="M3 3h8v11H3z M13 10h8v11h-8z"/><path d="M6 17.5v3h4M18 6.5v-3h-4"/>',
  fileManager: '<path d="M3 6h6l2 2.5h10V20H3z"/><path d="M3 12h18"/>',
  md: `<path d="M2.5 5.5h19v13h-19z"/><path d="M6 15V9l2.5 3L11 9v6M15.5 9v6m0 0L13.5 13m2 2l2-2"/>`,
  inspector: `<path d="${SHEET}"/><circle cx="11" cy="14" r="2.6"/><path d="M13 16l2.4 2.4"/>`,
  mbox: '<path d="M3 5h18v14H3z"/><path d="M3.5 6l8.5 7 8.5-7"/>',
};

// Blue and white only: a white page with a folded corner on a blue tile
export const LOGO_MARK = '<rect width="32" height="32" rx="7" fill="#1B4FD8"/><path d="M10 6.5h8.200l5 5v13A1.500 1.500 0 0 1 21.700 26H10a1.500 1.500 0 0 1-1.500-1.500V8A1.500 1.500 0 0 1 10 6.500z" fill="#fff"/><path d="M18.200 6.500V10a1.500 1.500 0 0 0 1.500 1.500h3.500" fill="none" stroke="#1B4FD8" stroke-width="1.100" stroke-linejoin="round"/><rect x="11.300" y="15" width="9" height="1.700" rx=".85" fill="#1B4FD8"/><rect x="11.300" y="18.400" width="9" height="1.700" rx=".85" fill="#1B4FD8"/><rect x="11.300" y="21.800" width="5.500" height="1.700" rx=".85" fill="#1B4FD8"/>';
export const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">${LOGO_MARK}</svg>`;
