// editor.js
// A small text editor for plain text files kept in the workspace.

import { el, btn, dialog, confirm, download } from './dom.js';
import { t, fmtNum } from './i18n.js';
import { isTextLike } from './kinds.js';

const MAX_SIZE = 2 * 1024 * 1024;

export const canEdit = item => isTextLike(item) && item.size <= MAX_SIZE && item.ext !== 'rtf' && item.ext !== 'eml';

export async function editDialog(item, onSave) {
  const buffer = new Uint8Array(await item.file.arrayBuffer());
  const bom = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  let original = new TextDecoder('utf-8').decode(buffer.subarray(bom ? 3 : 0));
  const crlf = /\r\n/.test(original);
  original = original.replace(/\r\n/g, '\n');

  const area = el('textarea.fm-editor__area', { value: original, spellcheck: false, wrap: 'off', 'aria-label': item.name });
  const status = el('span.fm-editor__status');
  const error = el('p.fm-error', { hidden: true, role: 'alert' });
  const isJson = item.ext === 'json';

  const dirty = () => area.value !== original;
  // Back to the original line endings and BOM when saving.
  const output = () => (bom ? '﻿' : '') + (crlf ? area.value.replace(/\n/g, '\r\n') : area.value);

  function update() {
    const text = area.value;
    const lines = text ? text.split('\n').length : 0;
    status.textContent = t('Lines: {lines}, characters: {chars}', { lines: fmtNum(lines), chars: fmtNum(text.length) });
    status.append(dirty() ? el('span.fm-tag.fm-tag--warn', t('Changed')) : '');
  }

  async function leave() {
    if (!dirty() || await confirm({ title: t('Discard changes?'), message: t('Your changes to this file have not been saved.'), action: t('Discard'), danger: true })) d.close();
  }

  const save = () => {
    onSave(new File([output()], item.name, { type: item.file.type || 'text/plain', lastModified: Date.now() }));
    d.close();
  };

  const format = () => {
    try {
      area.value = `${JSON.stringify(JSON.parse(area.value), null, 2)}\n`;
      error.hidden = true;
      update();
    } catch (e) {
      error.textContent = t('This is not valid JSON: {message}', { message: e.message });
      error.hidden = false;
    }
  };

  const d = dialog({
    title: t('Edit {name}', { name: item.name }), size: 'l', className: 'fm-editor',
    body: [area, error, status],
    footer: [
      isJson ? btn(t('Format'), format) : null,
      btn(t('Download'), () => download(new Blob([output()], { type: item.file.type || 'text/plain' }), item.name)),
      btn(t('Cancel'), leave),
      btn(t('Save in workspace'), save, { variant: 'primary' }),
    ].filter(Boolean),
  });

  // Esc, the X button and a click on the backdrop all ask first when there is something to lose.
  d.node.addEventListener('cancel', e => { e.preventDefault(); leave(); });
  d.node.querySelector('.fm-dialog__head button')?.addEventListener('click', e => { e.stopImmediatePropagation(); leave(); }, true);
  d.node.addEventListener('mousedown', e => { if (e.target === d.node) e.stopImmediatePropagation(); }, true);

  area.addEventListener('input', () => { error.hidden = true; update(); });
  area.addEventListener('keydown', e => {
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
      update();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    }
  });
  d.node.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  });
  update();
  area.focus();
  area.setSelectionRange(0, 0);
}
