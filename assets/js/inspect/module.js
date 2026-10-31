// module.js
// The Inspect tab of the file manager. The inspector code loads the first time the tab
// opens, then shows the selected files, or offers all of them when nothing is selected.

import { state, on } from '../state.js';

let container, inspector, loading;
const seen = new Map();

function intro() {
  const count = state.files.size;
  container.innerHTML = `<div class="fi-module-intro"><h2 data-i18n-intro="title">Inspect files</h2>
    <p>Select files in the Browse tab to see their text, metadata, checksums and embedded files here.</p>
    ${count ? `<button class="s-btn s-btn--primary" type="button" data-inspect-all>Inspect all files (${count})</button>` : ''}</div>`;
  container.querySelector('[data-inspect-all]')?.addEventListener('click', () => show([...state.files.values()]));
}

async function show(entries) {
  if (!inspector) {
    loading ||= (async () => {
      const [{ createInspector }, { lang }] = await Promise.all([import('./app.js'), import('./i18n.js')]);
      const routes = (await import(`/assets/i18n/routes.${lang}.js`)).default;
      container.innerHTML = '';
      const mount = document.createElement('div');
      container.append(mount);
      inspector = await createInspector(mount, { routes, onEmpty: () => { seen.clear(); inspector = null; loading = null; intro(); } });
    })();
    await loading;
  }
  const fresh = entries.filter((e) => e.file && !seen.has(e.id));
  fresh.forEach((e) => seen.set(e.id, true));
  if (fresh.length) inspector.addFiles(fresh.map((e) => e.file));
}

function onOpen() {
  const selected = [...state.selectedIds].map((id) => state.files.get(id)).filter(Boolean);
  if (selected.length) show(selected);
  else if (!inspector) intro();
}

export function initInspectModule(panel) {
  container = panel.querySelector('.module-panel') || panel;
  on('module:change', ({ activeModule }) => { if (activeModule === 'inspect') onOpen(); });
}
