// intake.js
// Ways files get in: the pickers, drag and drop (folders included) and paste.
// Everything returns a plain list of { file, dir }.

const SKIP = /^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i;
const MAX_FILES = 20000;

export const canPickFolder = 'showDirectoryPicker' in window || 'webkitdirectory' in document.createElement('input');

function inputPick({ folder = false } = {}) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.hidden = true;
    if (folder) input.webkitdirectory = true;
    input.addEventListener('change', () => {
      resolve([...input.files].map(file => {
        const rel = file.webkitRelativePath || '';
        return { file, dir: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '' };
      }));
      input.remove();
    });
    input.addEventListener('cancel', () => { resolve([]); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

export function pickFiles() {
  return inputPick();
}

async function walkHandle(handle, dir, out) {
  for await (const entry of handle.values()) {
    if (out.length >= MAX_FILES) return;
    if (entry.kind === 'file') {
      if (SKIP.test(entry.name)) continue;
      try { out.push({ file: await entry.getFile(), dir }); } catch { /* unreadable, skip */ }
    } else {
      await walkHandle(entry, dir ? `${dir}/${entry.name}` : entry.name, out);
    }
  }
}

export async function pickFolder() {
  if ('showDirectoryPicker' in window) {
    let handle;
    try { handle = await window.showDirectoryPicker(); } catch { return []; }
    const out = [];
    await walkHandle(handle, handle.name, out);
    return out;
  }
  return inputPick({ folder: true });
}

function readEntries(reader) {
  return new Promise(resolve => reader.readEntries(resolve, () => resolve([])));
}

async function walkEntry(entry, dir, out) {
  if (out.length >= MAX_FILES) return;
  if (entry.isFile) {
    if (SKIP.test(entry.name)) return;
    const file = await new Promise(resolve => entry.file(resolve, () => resolve(null)));
    if (file) out.push({ file, dir });
    return;
  }
  const reader = entry.createReader();
  const path = dir ? `${dir}/${entry.name}` : entry.name;
  for (;;) {
    const batch = await readEntries(reader);
    if (!batch.length) break;
    for (const child of batch) await walkEntry(child, path, out);
  }
}

/** Files and whole folders from a drop. */
export async function fromDrop(dataTransfer) {
  const out = [];
  const entries = [...(dataTransfer.items || [])]
    .filter(item => item.kind === 'file')
    .map(item => item.webkitGetAsEntry?.() || item.getAsFile());
  if (!entries.length) return [...(dataTransfer.files || [])].map(file => ({ file, dir: '' }));
  for (const entry of entries) {
    if (!entry) continue;
    if (entry instanceof File) out.push({ file: entry, dir: '' });
    else await walkEntry(entry, '', out);
  }
  return out;
}

export function fromPaste(clipboardData) {
  if (!clipboardData) return [];
  if (clipboardData.files?.length) {
    return [...clipboardData.files].map(file => {
      // Screenshots arrive as "image.png"; give them a name that tells them apart
      if (/^image\.\w+$/.test(file.name)) {
        const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
        return { file: new File([file], `pasted-${stamp}.${file.name.split('.').pop()}`, { type: file.type, lastModified: Date.now() }), dir: '' };
      }
      return { file, dir: '' };
    });
  }
  return [];
}
