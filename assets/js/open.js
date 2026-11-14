// open.js
// Landing point of the installed app when a file is opened with it from the
// operating system ("Open with"). Takes the files and passes them to the right tool.

import { targetFor, open } from './route.js';

const LANGS = ['en', 'de', 'pl', 'cs'];
function language() {
  try {
    const saved = localStorage.getItem('fo-lang');
    if (LANGS.includes(saved)) return saved;
  } catch { /* private mode */ }
  for (const tag of navigator.languages || [navigator.language || 'en']) {
    const short = String(tag).slice(0, 2).toLowerCase();
    if (LANGS.includes(short)) return short;
  }
  return 'en';
}

const lang = language();
const home = `/${lang}/`;

async function run(handles) {
  const { pages } = await import(`/assets/i18n/routes.${lang}.js`);
  const list = [];
  for (const handle of handles) {
    try { if (handle.kind === 'file') list.push({ file: await handle.getFile(), dir: '' }); } catch { /* skip unreadable */ }
  }
  const url = list.length && targetFor(list, { inspector: pages.inspector.url, manager: pages.fileManager.url, mbox: pages.mbox.url });
  if (!url) { location.replace(list.length ? pages.fileManager.url : home); return; }
  try { await open(list, url); } catch { location.replace(home); }
}

if ('launchQueue' in window) {
  let got = false;
  window.launchQueue.setConsumer(params => { got = true; run(params.files || []); });
  setTimeout(() => { if (!got) location.replace(home); }, 1500);
} else location.replace(home);
