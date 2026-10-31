// inspect-tests.js
// Runs every fixture through the inspector engine, checks expected facts per format,
// and tests digests, encoding detection and exports against known values.

import U from '/assets/js/inspect/util.js';
import E from '/assets/js/inspect/extractors.js';
import S from '/assets/js/inspect/summarize.js';
import '/assets/js/inspect/formats.js';
import '/assets/js/inspect/formats-more.js';
import { toJson, toXhtml, toCsv, tikaFields } from '/assets/js/inspect/tika.js';
import manifest from '/tests/inspect-manifest.js';

const log = document.getElementById('log');
const say = (s) => { log.textContent += `${s}\n`; };
const results = [];
function check(name, ok, note = '') {
  results.push({ name, ok, note });
  if (!ok) say(`FAIL  ${name}${note ? `  ${note}` : ''}`);
}

const enc = new TextEncoder();
const hex = async (algo, u8) => Array.from(new Uint8Array(await crypto.subtle.digest(algo, u8)), (b) => b.toString(16).padStart(2, '0')).join('');

// Known-answer tests
check('md5 of empty input', U.md5(new Uint8Array()) === 'd41d8cd98f00b204e9800998ecf8427e');
check('md5 of "abc"', U.md5(enc.encode('abc')) === '900150983cd24fb0d6963f7d28e17f72');
check('md5 across a block boundary', U.md5(enc.encode('a'.repeat(1000))) === 'cabe45dcc9ae5b66ba86600cca6b8ba8');
check('md5 at the padding edge', U.md5(enc.encode('a'.repeat(56))) === '3b0c8ac703f828b04c6c197006d17218');
check('crc32 of "123456789"', U.crc32(enc.encode('123456789')) === 'cbf43926');
check('entropy of uniform bytes is 8', Math.abs(U.byteStats(Uint8Array.from({ length: 256 * 8 }, (_, i) => i % 256)).entropy - 8) < 1e-9);
check('entropy of one repeated byte is 0', U.byteStats(new Uint8Array(100)).entropy === 0);

// Encoding detection on real text
const encodeLegacy = (text, table) => Uint8Array.from(text, (c) => (c.charCodeAt(0) < 128 ? c.charCodeAt(0) : table[c]));
const cp1250 = { ą: 0xb9, ć: 0xe6, ę: 0xea, ł: 0xb3, ń: 0xf1, ó: 0xf3, ś: 0x9c, ź: 0x9f, ż: 0xbf, ě: 0xec, š: 0x9a, č: 0xe8, ř: 0xf8, ž: 0x9e, ý: 0xfd, á: 0xe1, í: 0xed, é: 0xe9 };
const polish = encodeLegacy('Zażółć gęślą jaźń. Łódź jest miastem, a również życie płynie tu spokojnie.'.replace(/Ł/g, 'ł'), cp1250);
check('Polish Windows-1250 detected', U.decodeText(polish).encoding === 'Windows-1250', U.decodeText(polish).encoding);
check('Polish Windows-1250 decoded', U.decodeText(polish).text.includes('gęślą'));
const czech = encodeLegacy('Příliš žluťoučký kůň úpěl ďábelské ódy'.replace(/[Pť ůďú]/g, (c) => ({ P: 'p', ť: 't', ' ': ' ', ů: 'u', ď: 'd', ú: 'u' }[c])), cp1250);
check('Czech Windows-1250 decoded', U.decodeText(czech).text.includes('žlu'));
const utf8Text = U.decodeText(enc.encode('Grüße aus Berlin'));
check('UTF-8 recognized', utf8Text.encoding === 'UTF-8' && utf8Text.text === 'Grüße aus Berlin');

// Language detection
const sample = {
  pl: 'To jest przykładowy tekst w języku polskim, który ma sprawdzić, czy wykrywanie działa poprawnie oraz czy nie myli się z innymi językami. Dokument jest krótki, ale zawiera wiele typowych słów.',
  cs: 'Toto je ukázkový text v češtině, který má ověřit, zda rozpoznávání funguje správně a že se neplete s jinými jazyky. Dokument je krátký, ale obsahuje mnoho běžných slov a také několik dalších vět.',
  de: 'Dies ist ein Beispieltext in deutscher Sprache, der prüfen soll, ob die Erkennung richtig funktioniert und nicht mit anderen Sprachen verwechselt wird. Das Dokument ist kurz, aber es enthält viele Wörter.',
  en: 'This is a sample text in English that should verify whether the detection works correctly and is not confused with other languages. The document is short, but it has many of the most common words.',
};
for (const [code, text] of Object.entries(sample)) {
  const got = S.detectLanguage(text);
  check(`language ${code}`, got.code === code, `${got.code} ${got.confidence}`);
}

// Every fixture: expected type, no crash
const EXPECT = {
  'sample.pdf': 'pdf', 'sample.docx': 'docx', 'sample.xlsx': 'xlsx', 'sample.pptx': 'pptx', 'sample.odt': 'odt', 'sample.ods': 'ods', 'sample.odp': 'odp', 'sample.epub': 'epub',
  'sample.rtf': 'rtf', 'sample.html': 'html', 'sample.md': 'markdown', 'sample.csv': 'csv', 'sample.json': 'json', 'sample.xml': 'xml', 'sample.svg': 'svg', 'sample.eml': 'eml',
  'sample.png': 'png', 'sample.gif': 'gif', 'sample.webp': 'webp', 'sample.tiff': 'tiff', 'sample.bmp': 'bmp', 'sample.heic': 'heic', 'sample.avif': 'avif', 'sample.psd': 'psd',
  'sample.mp3': 'mp3', 'sample.flac': 'flac', 'sample.ogg': 'ogg', 'sample.wav': 'wav', 'sample.mp4': 'mp4', 'sample.webm': 'webm', 'sample.avi': 'avi', 'sample.flv': 'flv', 'sample.aiff': 'aiff',
  'sample.zip': 'zip', 'sample.tar': 'tar', 'sample.7z': '7z', 'sample.cpio': 'cpio', 'sample.deb': 'ar', 'sample.xz': 'xz', 'sample.ttf': 'ttf', 'sample.otf': 'otf', 'sample.ttc': 'ttc', 'sample.woff': 'woff', 'sample.woff2': 'woff2',
  'sample.ics': 'ics', 'sample.vcf': 'vcf', 'sample.sqlite': 'sqlite', 'sample.xls': 'ole', 'sample.msg': 'ole',
};
const rows = [];
const all = {};
for (const name of manifest) {
  const started = performance.now();
  try {
    const u8 = new Uint8Array(await (await fetch(`/tests/fixtures/${name}`)).arrayBuffer());
    const r = await E.analyzeBytes(u8, name, '');
    const summary = S.run(r, { size: u8.length });
    all[name] = { r, summary, u8 };
    const metaCount = Object.values(r.meta).reduce((n, g) => n + Object.keys(g).length, 0);
    rows.push(`${name.padEnd(26)} ${String(r.type).padEnd(10)} ${String(metaCount).padStart(3)}m ${String((r.text || '').length).padStart(6)}t ${String((r.embedded || []).length).padStart(3)}e ${String(Math.round(performance.now() - started)).padStart(5)}ms ${r.warnings.length ? `! ${r.warnings[0].slice(0, 50)}` : ''}`);
    if (EXPECT[name]) check(`type of ${name}`, r.type === EXPECT[name], `got ${r.type}`);
  } catch (err) {
    rows.push(`${name.padEnd(26)} CRASH ${err.message}`);
    check(`no crash on ${name}`, false, err.message);
  }
}

const get = (name) => all[name]?.r;
const meta = (name, g, k) => (get(name)?.meta[g] || {})[k];

// Second set of formats. t.* files are built byte by byte from each format's specification,
// real.* files come from real tools (see make_fixtures.py and make_fixtures.sh).
const TYPES = {
  't.qoi': 'qoi', 't.dds': 'dds', 't.exr': 'exr', 't.xcf': 'xcf', 't.pcx': 'pcx', 't.hdr': 'hdr', 't.icns': 'icns', 't.jp2': 'jp2', 't.fits': 'fits', 't.emf': 'emf', 't.dng': 'rawphoto',
  't.au': 'au', 't.ac3': 'ac3', 't.amr': 'amr', 't.caf': 'caf', 't.xm': 'xm', 't.s3m': 's3m', 't.sid': 'sid', 't.dsf': 'dsf',
  't.ivf': 'ivf', 't.y4m': 'y4m', 't.swf': 'swf', 't.tracks.mp4': 'mp4', 't.tracks.mkv': 'mkv',
  't.vhd': 'vhd', 't.qcow2': 'qcow', 't.wim': 'wim', 't.squashfs': 'squashfs', 't.lz4': 'lz4', 't.Z': 'compress', 't.pack': 'gitpack',
  't.pcap': 'pcap', 't.pcapng': 'pcapng', 't.avro': 'avro', 't.nc': 'netcdf', 't.h5': 'hdf5', 't.mat': 'mat', 't.accdb': 'access', 't.shp': 'shp', 't.las': 'las',
  't.fbx': 'fbx', 't.blend': 'blend', 't.gguf': 'gguf', 't.safetensors': 'safetensors', 't.step': 'step', 't.dxf': 'dxf',
  't.jks': 'jks', 't.kdbx': 'kdbx', 't.pub': 'sshkey', 't.asc': 'pgp', 't.lnk': 'lnk', 't.torrent': 'torrent', 't.dvi': 'dvi', 't.wad': 'wad',
  't.patch': 'diff', 't.log': 'logfile', 't.bib': 'bibtex', 't.ass': 'ass', 't.lrc': 'lrc', 't.m3u8': 'playlist', 't.ged': 'gedcom', 't.sql': 'sqldump', 'deploy': 'code',
  't.dpx': 'dpx', 't.wmf': 'wmf', 't.xbm': 'xbm', 't.xpm': 'xpm', 't.djvu': 'djvu', 't.raf': 'raf', 't.cr3': 'cr3', 't.jxl': 'jxl', 't.mod': 'mod', 't.it': 'it', 't.tta': 'tta', 't.ape': 'ape', 't.wv': 'wavpack', 't.mpc': 'mpc', 't.rm': 'rm', 't.mxf': 'mxf', 't.bpg': 'bpg',
  't.lz': 'lzip', 't.lzma': 'lzma', 't.arj': 'arj', 't.lzh': 'lzh', 't.zoo': 'zoo', 't.ace': 'ace', 't.sit': 'sit', 't.vdi': 'vdi', 't.vmdk': 'vmdk', 't.sav': 'spss', 't.orc': 'orc', 't.arrow': 'arrow', 't.cbor': 'cbor', 't.3ds': '3ds', 't.e57': 'e57', 't.tflite': 'tflite', 't.igs': 'iges', 't.obj': 'obj3d', 't.ply': 'ply',
  't.dat': 'regf', 't.evtx': 'evtx', 't.chm': 'chm', 't.one': 'onenote', 't.pst': 'pst', 't.wpd': 'wpd', 't.nes': 'nes', 't.luac': 'lua', 't.eot': 'eot', 't.pfb': 'pfb',
  'real.jp2': 'jp2', 'real.icns': 'icns', 'real.exr': 'exr', 'real.caf': 'caf', 'real.aac': 'aac', 'real.au': 'au', 'real.Z': 'compress', 'real.dmg': 'dmg', 'real.xar': 'xar', 'real.pub': 'sshkey', 'real.p12': 'pkcs12', 'real.bplist': 'bplist',
};
for (const [name, type] of Object.entries(TYPES)) check(`type of ${name}`, get(name)?.type === type, `got ${get(name)?.type}`);
const KINDS = { 't.xps': 'XPS document', 't.vsdx': 'Visio drawing', 't.pages': 'Apple Pages document', 't.whl': 'Python wheel', 't.apk': 'Android app', 't.3mf': '3D print file (3MF)', 't.gpx': 'GPS track (GPX)', 't.kml': 'Google Earth file', 't.plist': 'Apple property list', 'real.plist': 'Apple property list', 't.xlf': 'Translation file (XLIFF)', 'sitemap.xml': 'XML sitemap', 'pom.xml': 'Maven project', 't.har': 'Browser network log (HAR)', 'package.json': 'npm package manifest', 'openapi.json': 'API description (OpenAPI)' };
for (const [name, kind] of Object.entries(KINDS)) check(`kind of ${name}`, get(name)?.kind === kind, `got ${get(name)?.kind}`);
const VALUES = [
  ['t.qoi', 'Image', 'Width', '640 px'], ['t.dds', 'Image', 'Compression', 'DXT5'], ['t.exr', 'Image', 'Width', '1920 px'], ['t.xcf', 'Image', 'Height', '600 px'], ['t.pcx', 'Image', 'Width', '100 px'], ['t.hdr', 'Image', 'Width', '1280 px'],
  ['t.jp2', 'Image', 'Width', '500 px'], ['t.fits', 'Data', 'Object', 'M31'], ['t.fits', 'Data', 'Telescope', 'Hubble'], ['t.emf', 'Image', 'Width', '21.0 mm'], ['t.dng', 'Image', 'Width', '6000 px'],
  ['t.au', 'Audio', 'Sample rate', '8000 Hz'], ['t.caf', 'Audio', 'Sample rate', '44100 Hz'], ['t.caf', 'Audio', 'Channels', 2], ['t.xm', 'Tags', 'Title', 'Space Theme'], ['t.s3m', 'Tags', 'Title', 'Cave Song'], ['t.sid', 'Tags', 'Artist', 'Rob Hubbard'],
  ['t.ivf', 'Video', 'Resolution', '640 × 360'], ['t.ivf', 'Video', 'Video codec', 'AV01'], ['t.y4m', 'Video', 'Frame rate', '25 fps'], ['t.swf', 'Video', 'Frames', 120],
  ['t.tracks.mp4', 'Video', 'Video codec', 'avc1'], ['t.tracks.mp4', 'Video', 'Audio codec', 'mp4a'], ['t.tracks.mp4', 'Video', 'Resolution', '1920 × 1080'],
  ['t.tracks.mkv', 'Tags', 'Title', 'Holiday'], ['t.tracks.mkv', 'Video', 'Video codec', 'V_VP9'], ['t.tracks.mkv', 'Video', 'Audio codec', 'A_OPUS'], ['t.tracks.mkv', 'Video', 'Resolution', '1280 × 720'],
  ['t.qcow2', 'Archive', 'Format version', 3], ['t.pack', 'Archive', 'Format version', 2], ['t.pcap', 'Network capture', 'Link type', 'Ethernet'], ['t.pcap', 'Network capture', 'Packets', '3'], ['t.pcapng', 'Network capture', 'Packets', '2'],
  ['t.avro', 'Data', 'Record name', 'User'], ['t.avro', 'Compression', 'Method', 'deflate'], ['t.shp', 'Map', 'Shape type', 'Polygon'], ['t.shp', 'Map', 'Features', '2'],
  ['t.fbx', '3D model', 'Format version', 7400], ['t.blend', '3D model', 'Created with', 'Blender 4.03'], ['t.gguf', 'AI model', 'Name', 'Tiny Model'], ['t.gguf', 'AI model', 'Architecture', 'llama'], ['t.step', 'Document', 'Title', 'bracket'], ['t.dxf', 'Structure', 'Layers', 2],
  ['t.jks', 'Security', 'Entries', 3], ['t.pub', 'Security', 'Key type', 'ssh-ed25519'], ['t.asc', 'Security', 'Block type', 'PUBLIC KEY BLOCK'], ['real.pub', 'Security', 'Key type', 'ssh-ed25519'],
  ['t.lnk', 'Shortcut', 'Target', 'C:\\Windows\\notepad.exe'], ['t.lnk', 'Shortcut', 'Description', 'Notepad'], ['t.torrent', 'Torrent', 'Name', 'ubuntu'], ['t.torrent', 'Torrent', 'Files', '2'],
  ['t.patch', 'Patch', 'Files changed', 1], ['t.patch', 'Patch', 'Lines added', '2'], ['t.log', 'Log', 'ERROR', '1'], ['t.bib', 'Bibliography', 'Entries', 3], ['t.ass', 'Subtitles', 'Title', 'Episode 1'], ['t.m3u8', 'Playlist', 'Entries', 2], ['t.ged', 'Family tree', 'People', '2'], ['t.sql', 'Database', 'Tables', 2],
  ['t.dpx', 'Image', 'Width', '2048 px'], ['t.dpx', 'Application', 'Creator', 'Resolve'], ['t.dpx', 'Document', 'Created', '2026:10:30'], ['t.emf', 'Document', 'Description', 'Report Tool'], ['t.wmf', 'Image', 'Width', '25.4 mm'], ['t.xbm', 'Image', 'Width', '16 px'], ['t.xpm', 'Image', 'Colors', '4'], ['t.djvu', 'Image', 'Width', '800 px'], ['t.djvu', 'Image', 'Resolution', '300 DPI'], ['t.raf', 'Camera & EXIF', 'Camera model', 'X-T5'],
  ['t.mod', 'Tags', 'Title', 'Axel F'], ['t.it', 'Tags', 'Title', 'Deep Song'], ['t.tta', 'Audio', 'Sample rate', '44100 Hz'], ['t.tta', 'Audio', 'Duration', '1:30'], ['t.lzh', 'Compression', 'Method', '-lh5-'], ['t.vdi', 'Archive', 'Disk type', 'Dynamic'], ['t.vdi', 'Document', 'Description', 'Ubuntu'], ['t.vdi', 'Archive', 'Disk size', U.fmtBytes(2 ** 32)], ['t.vmdk', 'Archive', 'Disk size', U.fmtBytes(2 ** 30)],
  ['t.sav', 'Data', 'Records', '250'], ['t.sav', 'Data', 'Created', '30 Oct 26 10:00:00'], ['t.sav', 'Document', 'Title', 'Survey'], ['t.obj', '3D model', 'Vertices', '3'], ['t.obj', '3D model', 'Faces', '1'], ['t.ply', '3D model', 'Vertex', '8'], ['t.ply', '3D model', 'Encoding', 'ascii'], ['t.dat', 'Document', 'Name', 'SYSTEM'], ['t.dat', 'Document', 'Format version', '1.5'], ['t.evtx', 'Document', 'Format version', '3.1'], ['t.evtx', 'Document', 'Records', '42'],
  ['t.chm', 'Document', 'Language ID', '0x407'], ['t.wpd', 'Document', 'Format version', '2.1'], ['t.nes', 'Executable', 'Program size', U.fmtBytes(32768)], ['t.luac', 'Executable', 'Lua version', '5.3'], ['t.eot', 'Font', 'Family', 'Lobster'], ['t.eot', 'Font', 'Full name', 'Lobster Regular'], ['t.pfb', 'Font', 'Family', 'Utopia'], ['t.pfb', 'Font', 'Copyright', 'Copyright Adobe'],
  ['t.gpx', 'Map', 'Created with', 'Garmin'], ['t.kml', 'Map', 'Placemarks', 2], ['t.plist', 'Property list', 'CFBundleName', 'Demo'], ['real.plist', 'Property list', 'name', 'demo'], ['t.xlf', 'Translation', 'Target language', 'de'],
  ['t.xps', 'Document', 'Pages', 1], ['t.whl', 'Project', 'Name', 'demo'], ['t.3mf', '3D model', 'Vertices', '3'], ['t.har', 'Network capture', 'Requests', '2'], ['package.json', 'Project', 'Name', 'demo'], ['openapi.json', 'Project', 'Endpoints', 2],
];
for (const [name, g, k, want] of VALUES) check(`${name}: ${k}`, String(meta(name, g, k)) === String(want), `got ${meta(name, g, k)}`);
check('camera RAW: no false extension warning', !(get('t.dng')?.warnings || []).length, (get('t.dng')?.warnings || [])[0]);
check('audio-only MP4: codec under Audio, not Video', !!meta('sample.m4a', 'Audio', 'Audio codec') && !get('sample.m4a')?.meta.Video);
check('real MP4 and WebM: track list', !!meta('sample.mp4', 'Video', 'Video codec') && !!meta('sample.webm', 'Video', 'Video codec'));
check('XPS: text read', /Hello from XPS/.test(get('t.xps')?.text || ''));
check('script without extension named as code', get('deploy')?.type === 'code');
check('ASS: dialogue extracted', /Hello/.test(get('t.ass')?.text || ''));
check('real DMG, read/write: disk size read', !!meta('real.dmg', 'Archive', 'Disk size'));
check('real DMG, compressed: format read', get('real-compressed.dmg')?.type === 'dmg' && !!meta('real-compressed.dmg', 'Archive', 'Format version'), JSON.stringify(get('real-compressed.dmg')?.meta.Archive));
check('real JPEG 2000: size read', !!meta('real.jp2', 'Image', 'Width'));
check('real OpenEXR: size read', !!meta('real.exr', 'Image', 'Width'));
check('real Core Audio: codec read', !!meta('real.caf', 'Audio', 'Codec'));
check('real AAC: rate read', !!meta('real.aac', 'Audio', 'Sample rate'));
check('real ICNS: sizes read', !!meta('real.icns', 'Image', 'Icon sizes'));
check('real Sun audio: rate read', !!meta('real.au', 'Audio', 'Sample rate'));
check('real PKCS#12 warns about the private key', (get('real.p12')?.warnings || []).length > 0);

check('ASF: Windows Media recognized', get('sample.wmv')?.type === 'asf');
check('MPEG recognized', get('sample.mpg')?.type === 'mpegps' && get('sample.m2ts')?.type === 'mpegts');
check('NumPy: shape read', !!meta('sample.npy', 'Array', 'Shape'));
check('dBase: fields read', Number(meta('sample.dbf', 'Database', 'Fields')) > 0);
check('Parquet recognized', get('sample.parquet')?.type === 'parquet');
check('certificate: subject read', !!meta('sample.cer', 'Certificate', 'Certificate holder'));
check('PEM certificate: subject read', !!meta('sample.crt', 'Certificate', 'Certificate holder'));
check('TGA: size read', !!meta('sample.tga', 'Image', 'Width'));
check('Netpbm: size read', !!meta('sample.ppm', 'Image', 'Width'));
check('STL: triangles read', !!meta('sample.stl', '3D model', 'Triangles'));
check('glTF recognized', get('sample.glb')?.type === 'glb');
check('Jupyter notebook recognized', get('sample.ipynb')?.kind === 'Jupyter notebook');
check('GeoJSON recognized', get('sample.geojson')?.kind === 'GeoJSON map');
check('subtitles: cues read', Number(meta('sample.srt', 'Subtitles', 'Cues')) > 0);
check('FB2: title read', !!meta('sample.fb2', 'Book', 'Title'));
check('ODF template recognized', get('sample.ott')?.type === 'odt');
check('HEIC: size read', !!meta('sample.heic', 'Image', 'Width'));
const doc = get('sample.doc');
check('legacy Word: recognized', doc?.mime === 'application/msword', doc?.kind);
check('legacy Word: text with diacritics', /gęślą/.test(doc?.text || '') && /žluťoučký/.test(doc?.text || '') && /Grüße/.test(doc?.text || ''), (doc?.text || '').slice(0, 120));
check('legacy Excel: rows read', (get('sample.xls')?.tables || []).some((x) => x.rows.length > 0));
check('Outlook message: subject read', !!meta('sample.msg', 'Email', 'Subject'));
check('Outlook message: body read', (get('sample.msg')?.text || '').length > 40);
check('font: family read', !!meta('sample.ttf', 'Font', 'Family'));
check('WOFF: family read through deflate', !!meta('sample.woff', 'Font', 'Family'));
check('calendar: events', Number(meta('sample.ics', 'Calendar', 'Events')) > 0);
check('contacts: cards', Number(meta('sample.vcf', 'Contacts', 'Contacts')) > 0);
check('zip entries embedded', get('sample.zip')?.embedded?.length > 0);
check('tar entries embedded', get('sample.tar')?.embedded?.length > 0);
check('cpio entries embedded', get('sample.cpio')?.embedded?.length > 0);
check('deb members embedded', get('sample.deb')?.embedded?.length > 0);

const zipEntry = get('sample.zip')?.embedded?.[0];
if (zipEntry) {
  const bytes = await zipEntry.read();
  check('zip entry decompresses to its stated size', bytes.length === zipEntry.size, `${bytes.length} vs ${zipEntry.size}`);
  const inner = await E.analyzeBytes(bytes, zipEntry.name, '');
  check('zip entry can be analyzed itself', !!inner.type);
}

const fake = get('fake.docx');
check('fake.docx: a ZIP named .docx is flagged', !!fake?.detection?.mismatch && fake.warnings.length > 0);
check('sample.docx: a real one is not flagged', !get('sample.docx')?.detection?.mismatch);
check('sample.html: not flagged', !get('sample.html')?.detection?.mismatch);
check('sample.txt: not flagged', !get('sample.txt')?.detection?.mismatch);

const flagged = Object.entries(all).filter(([, v]) => v.r.detection?.mismatch).map(([k]) => k);
say(`Flagged as wrong extension: ${flagged.join(', ') || 'none'}`);

// Exports
const item = { file: new File(['x'], 'sample.pdf', { lastModified: 1000 }), result: get('sample.pdf'), summary: all['sample.pdf']?.summary, depth: 0, path: 'sample.pdf', digests: { md5: 'a', sha1: 'b', sha256: 'c', sha512: 'd' } };
const fields = tikaFields(item);
check('Tika: Content-Type', fields['Content-Type'] === 'application/pdf');
check('Tika: digest field', fields['X-TIKA:digest:SHA256'] === 'c');
check('Tika: PDF version field', !!fields['pdf:PDFVersion']);
const json = JSON.parse(toJson([item]));
check('Tika: dates are ISO 8601', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(fields['dcterms:created']), fields['dcterms:created']);
check('dates print readably for people', !/GMT/.test(String(get('sample.pdf').meta.Document.Created)));
check('JSON export is a list with content', Array.isArray(json) && json[0].resourceName === 'sample.pdf');
const xhtml = new DOMParser().parseFromString(toXhtml(item), 'application/xml');
check('XHTML export is well-formed', !xhtml.querySelector('parsererror'));
check('XHTML export carries metadata', !!xhtml.querySelector('meta[name="Content-Type"]'));
check('CSV export has a header and a row', toCsv([item]).trim().split('\r\n').length === 2);

say(rows.join('\n'));
const failed = results.filter((r) => !r.ok);
say(`\n${results.length - failed.length}/${results.length} passed`);
document.title = failed.length ? `FAILED ${failed.length}/${results.length}` : `PASSED ${results.length}`;
window.__results = results;
window.__all = all;
