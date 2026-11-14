// home.js
// The drop zone on the start page: see route.js for where things go.

import { pickFiles, pickFolder, fromDrop, canPickFolder } from './fm/intake.js';
import { targetFor, open } from './route.js';

const zone = document.getElementById('home-drop');
const status = zone.querySelector('.pt-drop__error');
const urls = { inspector: zone.dataset.inspector, manager: zone.dataset.manager, mbox: zone.dataset.mbox };

function say(text) {
  status.textContent = text;
  status.hidden = !text;
}

async function route(list, opt) {
  if (!list.length) return say('');
  const url = targetFor(list, urls, opt);
  if (!url) return say(zone.dataset.tooBig);
  say(zone.dataset.reading);
  zone.classList.add('is-busy');
  try {
    await open(list, url);
  } catch {
    zone.classList.remove('is-busy');
    say(zone.dataset.failed);
  }
}

zone.querySelector('[data-home="file"]').addEventListener('click', async () => route(await pickFiles()));
const folderBtn = zone.querySelector('[data-home="folder"]');
if (canPickFolder) folderBtn.addEventListener('click', async () => route(await pickFolder(), { folder: true }));
else folderBtn.hidden = true;

const hasFiles = e => e.dataTransfer?.types.includes('Files');
let depth = 0;
window.addEventListener('dragenter', e => { if (hasFiles(e)) { depth++; zone.classList.add('is-over'); } });
window.addEventListener('dragleave', e => { if (hasFiles(e) && --depth <= 0) { depth = 0; zone.classList.remove('is-over'); } });
window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', async e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  depth = 0;
  zone.classList.remove('is-over');
  route(await fromDrop(e.dataTransfer));
});

// Back from the other page: make the zone usable again
window.addEventListener('pageshow', () => { zone.classList.remove('is-busy'); say(''); });

// Offer installation where the browser supports it
const install = document.querySelector('[data-home="install"]');
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  if (!install) return;
  install.hidden = false;
  install.onclick = async () => { await e.prompt(); install.hidden = true; };
});
