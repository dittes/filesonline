// route.js
// Decides which tool opens what the visitor brought: a mailbox goes to the MBOX
// viewer, a file (or a few) to the file inspector, a folder or a larger batch to
// the file manager. The files travel through handoff.js and stay on the device.

import { sendTo } from './handoff.js';

const MANY = 12;
export const LIMIT = 1.2e9;

/**
 * @param {{file:File, dir?:string}[]} list
 * @param {{inspector:string, manager:string, mbox?:string}} urls
 * @returns {string|null} Target URL, or null when there is too much to hand over
 */
export function targetFor(list, urls, { folder = false } = {}) {
  const total = list.reduce((sum, e) => sum + e.file.size, 0);
  if (total > LIMIT) return null;
  if (folder || list.some(e => e.dir) || list.length > MANY) return `${urls.manager}?src=open`;
  if (urls.mbox && list.length === 1 && /\.mbox$/i.test(list[0].file.name)) return urls.mbox;
  return urls.inspector;
}

export function open(list, url) {
  return sendTo(url, list.map(e => ({ name: e.file.name, blob: e.file, dir: e.dir })), { newTab: false });
}
