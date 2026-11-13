// kinds.js
// What a file is, judged by its extension: the group it belongs to, its colour and icon.

const GROUPS = {
  image: 'jpg jpeg png gif webp avif bmp svg ico tif tiff heic heif jp2 psd raw cr2 nef arw dng exr icns',
  pdf: 'pdf',
  document: 'doc docx odt rtf pages txt md markdown tex wpd epub mobi fb2 djvu',
  sheet: 'xls xlsx xlsm ods csv tsv numbers dbf',
  slides: 'ppt pptx odp key',
  archive: 'zip rar 7z tar gz tgz bz2 xz tbz2 txz zst cab iso dmg jar war cbz cbr cpio deb rpm z',
  audio: 'mp3 wav flac ogg oga m4a aac wma aiff aif opus mid midi caf au',
  video: 'mp4 mov mkv avi webm wmv flv m4v mpg mpeg 3gp ogv asf',
  code: 'js mjs cjs ts tsx jsx json html htm css scss less xml yml yaml toml ini sh bash zsh py rb php java c h cpp hpp cs go rs swift kt sql lua pl r vue svelte log conf env gitignore dockerfile makefile plist geojson',
  font: 'ttf otf woff woff2 eot',
  email: 'eml msg mbox',
};

export const KINDS = ['image', 'pdf', 'document', 'sheet', 'slides', 'archive', 'audio', 'video', 'code', 'font', 'email', 'other'];

/** English labels, translated where they are shown. */
export const KIND_LABEL = {
  image: 'Images', pdf: 'PDF', document: 'Documents', sheet: 'Spreadsheets', slides: 'Presentations', archive: 'Archives',
  audio: 'Audio', video: 'Video', code: 'Code and data', font: 'Fonts', email: 'Email', other: 'Other', folder: 'Folder',
};

export const KIND_COLOR = {
  image: 'var(--fm-c-image)', pdf: 'var(--fm-c-pdf)', document: 'var(--fm-c-doc)', sheet: 'var(--fm-c-sheet)',
  slides: 'var(--fm-c-slides)', archive: 'var(--fm-c-archive)', audio: 'var(--fm-c-audio)', video: 'var(--fm-c-video)',
  code: 'var(--fm-c-code)', font: 'var(--fm-c-font)', email: 'var(--fm-c-email)', other: 'var(--fm-c-other)',
};

const BY_EXT = new Map();
for (const [kind, list] of Object.entries(GROUPS)) for (const ext of list.split(' ')) BY_EXT.set(ext, kind);

export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function splitName(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ''];
}

export function kindOf(name, mime = '') {
  const ext = extOf(name);
  if (BY_EXT.has(ext)) return BY_EXT.get(ext);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('text/')) return 'code';
  return 'other';
}

const TEXT_EXT = new Set('txt md markdown csv tsv log json xml yml yaml toml ini conf env sh bash zsh py rb php java c h cpp hpp cs go rs swift kt sql lua pl r js mjs cjs ts tsx jsx css scss less html htm vue svelte tex gitignore dockerfile makefile plist geojson srt vtt svg rtf eml'.split(' '));
export const isTextLike = item => TEXT_EXT.has(item.ext) || /^text\//.test(item.file.type);
export const isArchive = item => /^(zip|cbz|jar|war|tar|gz|tgz|rar|7z|bz2|xz|tbz2|txz)$/.test(item.ext);
export const isBrowserImage = item => /^(jpg|jpeg|png|gif|webp|avif|bmp|svg|ico)$/.test(item.ext);
export const isPdf = item => item.ext === 'pdf';

const FOLDER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="fm-ico__back" d="M2.5 6.5a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.5.7l1.1 1.3h8.200a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2z"/><path class="fm-ico__front" d="M2.5 10.500a2 2 0 0 1 2-2h15a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2z"/></svg>';

/** A small sheet of paper carrying the extension, or a folder. */
export function iconHtml(item) {
  if (item.isFolder) return `<span class="fm-ico fm-ico--folder">${FOLDER}</span>`;
  const label = (item.ext || '').slice(0, 4).toUpperCase();
  return `<span class="fm-ico" data-kind="${item.kind}"><span class="fm-ico__ext">${label.replace(/[^A-Z0-9]/g, '')}</span></span>`;
}
