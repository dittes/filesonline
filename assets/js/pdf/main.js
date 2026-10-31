// main.js
// Entry point of the PDF tool pages. The dropzone is static HTML from the build;
// this wires it up, checks the files, and hands them to the tool from tools.js.

import { loadStrings, lang, t, el, button, notice, field, textInput, formatBytes, pickFiles, showProgress, showResult, takeHandoff } from './ui.js';

const root = document.getElementById('pdf-tool');
const stage = root.querySelector('.pt-stage');
const dropView = root.querySelector('.pt-drop');
const toolId = root.dataset.tool;

let TOOLS, UserError, ops, routes = {};
let closers = [];

function closeCurrent() {
  closers.forEach(fn => { try { fn(); } catch { /* already gone */ } });
  closers = [];
}

function restart() {
  closeCurrent();
  stage.replaceChildren();
  stage.hidden = true;
  dropView.hidden = false;
  dropError('');
  root.classList.remove('is-active', 'is-wide');
}

function dropError(message) {
  const slot = dropView.querySelector('.pt-drop__error');
  slot.textContent = message;
  slot.hidden = !message;
}

async function readInput(file) {
  return { name: file.name, file, bytes: new Uint8Array(await file.arrayBuffer()) };
}

function looksLikePdf(bytes) {
  const head = String.fromCharCode(...bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

/** Ask for the password of an encrypted input and return decrypted bytes. */
function askPassword(file) {
  return new Promise((resolve, reject) => {
    const input = textInput('', { type: 'password', autocomplete: 'off' });
    const error = el('p.pt-drop__error', { hidden: true, role: 'alert' });
    const submit = async () => {
      try {
        resolve(await ops.unlock(file.bytes, input.value));
      } catch {
        error.textContent = t('That password is not correct.');
        error.hidden = false;
        input.select();
      }
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    stage.replaceChildren(el('div.pt-password',
      el('h2.pt-sidehead', file.name),
      el('p', t('This PDF is password protected. Enter the password to continue. It stays on your device.')),
      field(t('Password'), input),
      error,
      el('div.pt-btnrow',
        button(t('Continue'), submit, 'primary'),
        button(t('Cancel'), () => reject(new UserError('')), 'ghost'))));
    input.focus();
  });
}

async function prepare(files, def) {
  const inputs = [];
  for (const file of files) {
    const input = await readInput(file);
    if (def.kind === 'pdf') {
      if (!looksLikePdf(input.bytes)) throw new UserError(t('“{name}” is not a PDF file.', { name: file.name }));
      if (!def.rawInput && await ops.isEncrypted(input.bytes)) {
        try {
          input.bytes = await ops.unlock(input.bytes, '');
        } catch {
          input.bytes = await askPassword(input);
        }
      }
    } else if (def.kind === 'image' && !file.type.startsWith('image/')) {
      throw new UserError(t('“{name}” is not an image.', { name: file.name }));
    }
    inputs.push(input);
  }
  return inputs;
}

function errorMessage(err) {
  if (err instanceof UserError) return err.message;
  console.error(err);
  if (err?.name === 'PasswordException') return t('That password is not correct.');
  return t('This file could not be processed. It may be damaged or use a feature we do not support yet.');
}

function makeContext(def, inputs) {
  let lastPanel = null;

  const ctx = {
    files: inputs,
    stage,
    onClose: fn => closers.push(fn),

    panel({ main, side = [], action, run, wide }) {
      root.classList.toggle('is-wide', !!wide);
      const error = el('div.pt-panel__error', { role: 'alert', hidden: true });
      ctx.guard = async fn => {
        error.hidden = true;
        try {
          await fn();
        } catch (err) {
          stage.replaceChildren(lastPanel);
          error.textContent = errorMessage(err);
          error.hidden = !error.textContent;
        }
      };
      const start = () => ctx.guard(run);
      lastPanel = el('div.pt-panel',
        el('div.pt-panel__main', main),
        el('aside.pt-panel__side',
          side,
          error,
          action ? el('div.pt-panel__action', button(action, start, 'primary', { dataset: { run: 'true' } })) : null,
          button(t('Choose a different file'), restart, 'link')));
      stage.replaceChildren(lastPanel);
    },

    /** Run the work behind a progress view, then show the result. */
    async process(label, fn) {
      const panel = lastPanel;
      const progress = showProgress(stage, label);
      await new Promise(r => setTimeout(r, 30)); // let the progress view paint
      let result;
      try {
        result = await fn(progress);
      } catch (err) {
        lastPanel = panel;
        throw err;
      }
      await showResult(stage, result.files, {
        ...result,
        routes,
        nextTools: def.next,
        onRestart: restart,
      });
    },

    addFiles(onAdded) {
      return pickFiles({ accept: def.accept, multiple: true }).then(async files => {
        if (!files.length) return;
        try {
          const added = await prepare(files, def);
          ctx.files.push(...added);
          await onAdded(added);
        } catch (err) {
          const box = lastPanel.querySelector('.pt-panel__error');
          box.textContent = errorMessage(err);
          box.hidden = !box.textContent;
        }
      });
    },

    fileCard: file => el('div.pt-filecard',
      el('div.pt-filecard__sheet', { 'aria-hidden': 'true' }, el('span', file.name.split('.').pop().toUpperCase().slice(0, 4))),
      el('div',
        el('p.pt-filecard__name', file.name),
        el('p.pt-filecard__size', formatBytes(file.bytes.length)))),

    pageCountLine: n => el('p.pt-count', t('Pages in this document: {n}', { n })),

    toolLink: id => (routes[id] ? el('a.s-btn.s-btn--secondary', { href: routes[id].url }, routes[id].name) : null),

    /** A notice with a link to OCR when the PDF has no text layer. */
    async scanWarning(file) {
      if (!await ops.looksScanned(file.bytes)) return null;
      return el('div',
        notice(t('This looks like a scan with no text inside. Make it searchable first, then convert it.')),
        ctx.toolLink('ocr'));
    },
  };
  return ctx;
}

async function start(files) {
  if (!files.length) return;
  const def = TOOLS[toolId];
  dropError('');
  try {
    const chosen = def.multiple ? files : files.slice(0, 1);
    dropView.hidden = true;
    stage.hidden = false;
    root.classList.add('is-active');
    showProgress(stage, t('Opening your file…'));
    const inputs = await prepare(chosen, def);
    closeCurrent();
    await def.open(makeContext(def, inputs));
  } catch (err) {
    stage.hidden = true;
    dropView.hidden = false;
    root.classList.remove('is-active');
    dropError(errorMessage(err));
  }
}

async function boot() {
  const ready = Promise.all([
    loadStrings(),
    import('./tools.js').then(m => { TOOLS = m.TOOLS; UserError = m.UserError; }),
    import('./ops.js').then(m => { ops = m; }),
    import(`/assets/i18n/routes.${lang}.js`).then(m => { routes = m.default; }),
  ]);

  const accept = dropView.dataset.accept;
  const multiple = dropView.dataset.multiple === 'true';
  const go = async files => { await ready; start(files); };

  dropView.querySelector('.pt-drop__btn').addEventListener('click', async e => {
    e.stopPropagation();
    go(await pickFiles({ accept, multiple }));
  });
  dropView.addEventListener('click', async e => {
    if (e.target.closest('a,button')) return;
    go(await pickFiles({ accept, multiple }));
  });

  const onDrag = (e, active) => { e.preventDefault(); dropView.classList.toggle('is-over', active); };
  dropView.addEventListener('dragover', e => onDrag(e, true));
  dropView.addEventListener('dragleave', e => onDrag(e, false));
  dropView.addEventListener('drop', e => { onDrag(e, false); go([...e.dataTransfer.files]); });
  // A file dropped anywhere on the page should not navigate away from it
  window.addEventListener('dragover', e => { if (dropView.hidden) e.preventDefault(); });
  window.addEventListener('drop', e => {
    e.preventDefault();
    if (!dropView.hidden && !dropView.contains(e.target)) go([...e.dataTransfer.files]);
  });

  await ready;
  if (new URLSearchParams(location.search).has('handoff')) {
    history.replaceState(null, '', location.pathname);
    const file = await takeHandoff();
    if (file) start([file]);
  }
}

boot();
