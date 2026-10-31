// i18n.js
// Translation for the file inspector, keyed by English source string.

let dict = {};
export const lang = document.documentElement.lang || 'en';

export async function loadStrings() {
  if (lang === 'en' || Object.keys(dict).length) return;
  dict = (await import(`/assets/i18n/inspect.${lang}.js`)).default;
}

export function t(source, params) {
  let out = dict[source] ?? source;
  if (params) for (const [k, v] of Object.entries(params)) out = out.replaceAll(`{${k}}`, v);
  return out;
}
