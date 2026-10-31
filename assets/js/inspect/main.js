// main.js
// Entry point of the file inspector page. The dropzone is static HTML from the build.

import { createInspector, filesFromDrop } from './app.js';
import { lang } from './i18n.js';

const page = document.getElementById('file-inspector');
const drop = page.querySelector('.pt-drop');
const mount = page.querySelector('.fi-mount');

const routes = (await import(`/assets/i18n/routes.${lang}.js`)).default;

function showDrop(show) {
  drop.hidden = !show;
  mount.hidden = show;
  document.body.classList.toggle('fi-active', !show);
}

const inspector = await createInspector(mount, { routes, onEmpty: () => showDrop(true) });
window.FilesOnlineInspector = inspector;

function add(files) {
  if (!files.length) return;
  showDrop(false);
  inspector.addFiles(files);
}

const picker = document.createElement('input');
picker.type = 'file';
picker.multiple = true;
picker.hidden = true;
page.append(picker);
picker.addEventListener('change', () => { add([...picker.files]); picker.value = ''; });

drop.addEventListener('click', () => picker.click());
drop.querySelector('.pt-drop__btn').addEventListener('click', (e) => { e.stopPropagation(); picker.click(); });

window.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  drop.classList.add('is-over');
});
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('is-over'); });
window.addEventListener('drop', async (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  drop.classList.remove('is-over');
  add(await filesFromDrop(e.dataTransfer));
});

// Paste files, screenshots or plain text
document.addEventListener('paste', (e) => {
  const target = e.target;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
  const data = e.clipboardData;
  if (!data) return;
  if (data.files?.length) { e.preventDefault(); add([...data.files]); return; }
  const text = data.getData('text/plain');
  if (text && text.trim().length > 1) {
    e.preventDefault();
    add([new File([text], 'pasted-text.txt', { type: 'text/plain', lastModified: Date.now() })]);
  }
});
