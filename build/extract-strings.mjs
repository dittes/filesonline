// extract-strings.mjs
// Lists the English source strings of the PDF tool UI and of the file manager, and
// reports what each language is missing. `npm run check:strings` prints only the gaps.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SETS = {
  'pdf-ui': ['tools', 'main', 'ui', 'pages'].map(f => `assets/js/pdf/${f}.js`),
  fm: readdirSync(join(ROOT, 'assets/js/fm')).filter(f => f.endsWith('.js') && f !== 'i18n.js').map(f => `assets/js/fm/${f}`),
};

function collect(files) {
  const strings = new Set();
  for (const file of files) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) strings.add(m[1].replace(/\\'/g, "'"));
    // Labels kept in a table and translated where they are shown
    const table = src.match(/export const KIND_LABEL = \{([^}]*)\}/);
    if (table) for (const m of table[1].matchAll(/: '([^']+)'/g)) strings.add(m[1]);
  }
  return strings;
}

const only = process.argv.find(a => SETS[a]);

if (process.argv.includes('--missing')) {
  let missing = 0;
  for (const [name, files] of Object.entries(SETS)) {
    const strings = collect(files);
    for (const lang of ['de', 'pl', 'cs']) {
      const file = join(ROOT, `assets/i18n/${name}.${lang}.js`);
      const dict = existsSync(file) ? (await import(file)).default : {};
      const gaps = [...strings].filter(s => dict[s] === undefined);
      missing += gaps.length;
      console.log(`${name} ${lang}: ${strings.size - gaps.length}/${strings.size}`);
      gaps.forEach(s => console.log(`  ${s}`));
    }
  }
  process.exit(missing ? 1 : 0);
}
console.log(JSON.stringify([...collect(SETS[only || 'pdf-ui'])], null, 0));
