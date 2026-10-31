// extract-strings.mjs
// Lists the English source strings of the PDF tool UI and reports what each
// language is missing. `npm run check:strings` prints only the gaps.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['tools', 'main', 'ui', 'pages'].map(f => `assets/js/pdf/${f}.js`);

const strings = new Set();
for (const file of FILES) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  for (const m of src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) strings.add(m[1].replace(/\\'/g, "'"));
}

if (process.argv.includes('--missing')) {
  let missing = 0;
  for (const lang of ['de', 'pl', 'cs']) {
    const file = join(ROOT, `assets/i18n/pdf-ui.${lang}.js`);
    const dict = existsSync(file) ? (await import(file)).default : {};
    const gaps = [...strings].filter(s => dict[s] === undefined);
    missing += gaps.length;
    console.log(`${lang}: ${strings.size - gaps.length}/${strings.size}`);
    gaps.forEach(s => console.log(`  ${s}`));
  }
  process.exit(missing ? 1 : 0);
}
console.log(JSON.stringify([...strings], null, 0));
