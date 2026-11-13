// i18n.js
// English source strings are the keys; assets/i18n/fm.<lang>.js holds the translations.

export const lang = document.documentElement.lang || 'en';
let dict = {};

export async function loadStrings() {
  if (lang === 'en') return;
  try { dict = (await import(`/assets/i18n/fm.${lang}.js`)).default; } catch { dict = {}; }
}

export function t(source, params) {
  let out = dict[source] ?? source;
  if (params) for (const [k, v] of Object.entries(params)) out = out.replaceAll(`{${k}}`, v);
  return out;
}

const num = new Intl.NumberFormat(lang, { maximumFractionDigits: 1 });
export const fmtNum = n => new Intl.NumberFormat(lang).format(n);

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${num.format(n)} B`;
  if (n < 1048576) return `${num.format(n / 1024)} KB`;
  if (n < 1073741824) return `${num.format(n / 1048576)} MB`;
  return `${num.format(n / 1073741824)} GB`;
}

const dateFmt = new Intl.DateTimeFormat(lang, { dateStyle: 'medium' });
const dateTimeFmt = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' });
export const fmtDate = ms => (ms ? dateFmt.format(ms) : '');
export const fmtDateTime = ms => (ms ? dateTimeFmt.format(ms) : '');

export const collator = new Intl.Collator(lang, { numeric: true, sensitivity: 'base' });
