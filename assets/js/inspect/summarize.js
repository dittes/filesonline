// summarize.js
// Language detection, extractive summary (TextRank + MMR), keywords, entities and table
// profiling, all on the device. Ported from the Distil prototype.

import U from './util.js';
import E from './extractors.js';
import { t } from './i18n.js';

const S = {};
export default S;

const W = (s) => new Set(s.split(/\s+/));
const STOP = {
  en: W('the of and to a in is that it for on as with was be by this are at from or an have not but they which you had we her his were their can has been one all would there what so up out if about who get will do more when no she he him them its into than then also other some these such only over any may our your how my me those after most just very should could i am did does each because between both before through during while where being under again further once here why own same too off few nor now'),
  de: W('der die das und ist in den von zu mit sich des auf für nicht ein eine als auch es an werden aus er hat dass sie nach wird bei einer um am sind noch wie einem über einen so zum war haben nur oder aber vor zur bis mehr durch man dann soll kann wenn ich wir ihr uns dem im ab sein seine ihre diese dieser dieses wurde wurden worden sowie kein keine einer eines hier dort schon sehr immer wieder können müssen muss will wollen sollen unter zwischen gegen ohne bereits jedoch sondern weil'),
  fr: W('le la les de des du un une et est en que qui dans pour pas sur au aux avec ce ces se son sa ses il elle ils elles nous vous je tu on ne plus par mais ou où donc car comme être avoir fait cette été sont était sera leur leurs aussi très tout tous toute toutes entre sans sous bien encore même autre autres peut dont ainsi alors lors depuis'),
  es: W('el la los las de del un una unos unas y es en que por con para como su sus al lo se no más pero sus le ya o este esta estos estas ese esa entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mí antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros'),
  it: W('il lo la i gli le di del della dei degli delle un una uno e è in che per con su da al alla ai alle non si come più ma anche o se ha sono era essere stato loro suo sua suoi sue questo questa questi queste quello quella tra fra molto dopo prima senza sotto sopra già ancora tutto tutti ogni nel nella nei nelle sul sulla dal dalla'),
  nl: W('de het een en van in is dat op te zijn voor met niet aan er maar om ook als bij of uit nog naar door over ze zich deze dit die wat wordt worden werd hebben heeft had kan meer tot dan hij zij wij je ik u ons hun haar zo nu al alle andere veel wel geen onder tussen na tegen zonder'),
  pl: W('i w na z do że się nie to jest o a od po za przez dla jak co tak ale lub oraz który która które były był była jego jej ich tym tej ten ta te być ma mają może można przy tego także czy są ze we ponieważ jednak więc gdy tylko bardzo przed pod nad między'),
  cs: W('a v na se je že s z do o k i by to si ale jak po pro za při od být jsou byl byla bylo jeho její jejich který která které tak tím také nebo ani když aby už jen více před pod nad mezi již ještě však proto ve ze ku této tento tato'),
  sv: W('och i att det som en på är av för med den till har inte om ett de jag var men från vi kan han hon sig så vid eller när nu efter under'),
  ru: W('и в не на я что он с как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну ли если уже или ни быть был него до вас'),
  tr: W('ve bir bu için ile de da olarak daha en çok ne gibi kadar olan ama veya her sonra ancak ise'),
  pt: W('o a os as de do da dos das um uma uns umas e é em que por com para como seu sua seus suas ao aos se não mais mas ou foi são ser tem ter já também muito entre sobre até quando só pelo pela pelos pelas isso este esta estes estas esse essa eles elas ele ela nós você há nos me lhe depois sem mesmo aos ter seus quem nas tinha foram'),
};
const ALL_STOP = new Set(Object.values(STOP).flatMap((s) => [...s]));
const MONTHS = 'jan(?:uary|uar)?|feb(?:ruary|ruar)?|mar(?:ch)?|märz|apr(?:il)?|may|mai|jun(?:e|i)?|jul(?:y|i)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|okt(?:ober)?|nov(?:ember)?|dec(?:ember)?|dez(?:ember)?';
const LANG_NAME = { en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', nl: 'Dutch', pt: 'Portuguese', pl: 'Polish', cs: 'Czech', sv: 'Swedish', ru: 'Russian', tr: 'Turkish' };
const ISO_LANG = { en: 'en', de: 'de', fr: 'fr', es: 'es', it: 'it', nl: 'nl', pt: 'pt', pl: 'pl', cs: 'cs', sv: 'sv', ru: 'ru', tr: 'tr' };

const tokenize = (s) => (s.toLowerCase().match(/[\p{L}][\p{L}\p{N}'’-]*|\p{N}+/gu) || []);

/** Stop-word hit rate per language, with letters unique to a language as a tie-breaker. */
function detectLanguage(text) {
  const sample = text.slice(0, 30000);
  const letters = sample.replace(/[^\p{L}]/gu, '');
  if (!letters.length) return { code: '', name: '', confidence: 0, candidates: [] };
  const share = (re) => (letters.match(re) || []).length / letters.length;
  if (share(/[぀-ヿ㐀-鿿가-힯]/g) > 0.3) return { code: 'cjk', name: 'Chinese / Japanese / Korean', confidence: 0.9, candidates: [] };
  if (share(/[؀-ۿ]/g) > 0.5) return { code: 'ara', name: 'Arabic script', confidence: 0.9, candidates: [] };
  const toks = tokenize(sample).slice(0, 4000);
  if (toks.length < 8) return { code: '', name: '', confidence: 0, candidates: [] };
  const BOOST = { pl: /[ąęłńśźż]/gi, cs: /[ěřůťďň]/gi, de: /[äöüß]/gi, fr: /[çœêèà]/gi, es: /[ñ¿¡]/gi, pt: /[ãõ]/gi, sv: /[åäö]/gi, tr: /[ğış]/gi };
  const scored = Object.entries(STOP).map(([code, set]) => {
    let hits = 0;
    for (const tok of toks) if (set.has(tok)) hits++;
    const boost = BOOST[code] ? share(BOOST[code]) * 4 : 0;
    return { code, name: LANG_NAME[code], score: hits / toks.length + boost };
  }).sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (best.score <= 0.1) return { code: '', name: '', confidence: 0, candidates: [] };
  const confidence = Math.min(0.99, 0.5 + (best.score - (second ? second.score : 0)) * 2);
  return { code: best.code, iso: ISO_LANG[best.code], name: best.name, confidence, candidates: scored.slice(0, 3).filter((c) => c.score > 0.05) };
}

const ABBR = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|St|vs|etc|Inc|Ltd|Co|Nr|ca|Abb|Fig|No|Jr|Sr|bzw|usw|ggf|inkl|evtl|Hr|Fr|Str)|\b(?:e\.g|i\.e|z\.B|d\.h|u\.a|z\.T|v\.a|p\.m|a\.m))\.$/i;
function splitSentences(text) {
  const out = [];
  const paras = text.split(/\n\s*\n|\r\n\s*\r\n/);
  paras.forEach((para) => {
    const lines = para.split(/\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    // heading-like single short line without terminal punctuation: not a sentence
    if (lines.length === 1 && lines[0].length < 90 && !/[.!?…。]["')\]]?$/.test(lines[0])) { out.push({ text: lines[0], heading: true }); return; }
    const flat = lines.join(' ').replace(/\s+/g, ' ');
    const parts = flat.split(/(?<=[.!?…。！？])["')\]”»]*\s+(?=[\p{Lu}\p{N}"“„«(\[])/u);
    const merged = [];
    parts.forEach((p) => {
      if (merged.length && ABBR.test(merged[merged.length - 1])) merged[merged.length - 1] += ' ' + p;
      else merged.push(p);
    });
    merged.forEach((p) => out.push({ text: p.trim() }));
  });
  return out;
}

const shortStr = (s, n) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s);

function rank(cands, stop) {
  const sets = cands.map((c) => new Set(tokenize(c.text).filter((w) => !stop.has(w) && w.length > 2)));
  const n = cands.length;
  const sim = Array.from({ length: n }, () => new Float32Array(n));
  const rowSum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = sets[i], b = sets[j];
      if (!a.size || !b.size) continue;
      const [small, big] = a.size < b.size ? [a, b] : [b, a];
      let common = 0;
      for (const w of small) if (big.has(w)) common++;
      if (!common) continue;
      const v = common / (Math.log(a.size + 1) + Math.log(b.size + 1));
      sim[i][j] = sim[j][i] = v;
      rowSum[i] += v; rowSum[j] += v;
    }
  }
  let score = new Float32Array(n).fill(1 / n);
  const d = 0.85;
  for (let it = 0; it < 30; it++) {
    const next = new Float32Array(n).fill((1 - d) / n);
    for (let i = 0; i < n; i++) {
      if (!rowSum[i]) continue;
      const share = (d * score[i]) / rowSum[i];
      for (let j = 0; j < n; j++) if (sim[i][j]) next[j] += share * sim[i][j];
    }
    score = next;
  }
  const max = Math.max(...score) || 1;
  return { sets, score: Array.from(score, (s, i) => {
    let v = s / max;
    if (i < 3) v *= 1.25 - i * 0.08;               // lead bias
    const len = cands[i].text.length;
    if (len > 260) v *= 0.85;
    return v;
  }) };
}

function selectMMR(cands, scores, sets, k) {
  const chosen = [];
  const pool = cands.map((_, i) => i);
  const jac = (a, b) => { if (!a.size || !b.size) return 0; let c = 0; for (const w of a) if (b.has(w)) c++; return c / (a.size + b.size - c); };
  while (chosen.length < k && pool.length) {
    let bi = -1, bv = -Infinity;
    for (const i of pool) {
      let red = 0;
      for (const j of chosen) red = Math.max(red, jac(sets[i], sets[j]));
      const v = scores[i] - 0.8 * red;
      if (v > bv) { bv = v; bi = i; }
    }
    chosen.push(bi);
    pool.splice(pool.indexOf(bi), 1);
  }
  return chosen;
}

function keywords(text, stop, lang) {
  const sents = text.slice(0, 400000).split(/[.!?\n。]+/);
  const uni = new Map(), bi = new Map();
  const caps = new Map();
  let total = 0;
  for (const s of sents) {
    const raw = s.match(/[\p{L}][\p{L}\p{N}'’-]*/gu) || [];
    let prev = null;
    for (let i = 0; i < raw.length; i++) {
      const w = raw[i], lw = w.toLowerCase();
      if (stop.has(lw) || lw.length < 3 || /^\d+$/.test(lw)) { prev = null; continue; }
      total++;
      uni.set(lw, (uni.get(lw) || 0) + 1);
      const c = caps.get(lw) || [0, 0];
      c[0]++; if (/^\p{Lu}/u.test(w) && i > 0) c[1]++;
      caps.set(lw, c);
      if (prev) { const k = prev + ' ' + lw; bi.set(k, (bi.get(k) || 0) + 1); }
      prev = lw;
    }
  }
  const minC = total > 400 ? 3 : 2;
  const pretty = (t) => t.split(' ').map((w) => { const c = caps.get(w); return c && c[1] / c[0] > 0.6 ? w[0].toUpperCase() + w.slice(1) : w; }).join(' ');
  const picked = [];
  [...bi.entries()].filter(([, c]) => c >= Math.max(2, minC - 1)).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .forEach(([t, c]) => picked.push({ term: pretty(t), count: c, parts: t.split(' ') }));
  const unis = [...uni.entries()].filter(([, c]) => c >= (total < 60 ? 1 : minC)).sort((a, b) => b[1] - a[1]);
  for (const [t, c] of unis) {
    if (picked.length >= 14) break;
    if (picked.some((p) => p.parts.length > 1 && p.parts.includes(t) && p.count >= c * 0.5)) continue;
    picked.push({ term: pretty(t), count: c, parts: [t] });
  }
  return picked.slice(0, 14).sort((a, b) => b.count - a.count).map(({ term, count }) => ({ term, count }));
}

const uniq = (arr, n) => [...new Set(arr.map((x) => x.trim()))].slice(0, n);
function entities(text, lang) {
  const body = text.slice(0, 500000);
  const e = {};
  e.Emails = uniq(body.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || [], 8);
  e.Links = uniq((body.match(/https?:\/\/[^\s<>"')\]]+/g) || []).map((u) => u.replace(/[.,;:]+$/, '')), 8);
  const dateRe = new RegExp(`\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}[./]\\d{1,2}[./]\\d{2,4}\\b|\\b\\d{1,2}\\.?\\s(?:${MONTHS})\\.?,?\\s\\d{4}\\b|\\b(?:${MONTHS})\\.?\\s\\d{1,2}(?:st|nd|rd|th)?,?\\s\\d{4}\\b`, 'gi');
  e.Dates = uniq(body.match(dateRe) || [], 8);
  e.Amounts = uniq(body.match(/(?:[$€£]\s?\d[\d.,]*(?:\s?(?:k|m|bn|million|billion))?|\b\d[\d.,]*\s?(?:€|EUR|USD|\$|£|GBP|CHF)(?![\p{L}]))/gu) || [], 8);
  e.Phones = uniq((body.match(/(?:\+\d{1,3}[\s./-]?)?(?:\(?\d{2,5}\)?[\s./-]?){2,5}\d{2,}/g) || []).filter((x) => x.replace(/\D/g, '').length >= 9 && x.replace(/\D/g, '').length <= 15 && /[+\s/-]/.test(x)), 8);
  e.IBANs = uniq(body.match(/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,3})?\b/g) || [], 8);
  e['IP addresses'] = uniq(body.match(/\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g) || [], 8);
  if (lang !== 'de') {
    const cnt = new Map();
    (body.match(/\b\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+){1,3}\b/gu) || []).forEach((n) => {
      const first = n.split(/\s+/)[0].toLowerCase();
      if (ALL_STOP.has(first) || first.length < 3) return;
      cnt.set(n, (cnt.get(n) || 0) + 1);
    });
    e['Names and organizations'] = [...cnt.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, c]) => `${n} (${c})`);
  }
  Object.keys(e).forEach((k) => { if (!e[k].length) delete e[k]; });
  return e;
}

/* ---------- tables ---------- */
const toNum = (v) => {
  let s = String(v).trim().replace(/[\s$€£%]/g, '');
  if (!s || !/^-?[\d.,]+$/.test(s)) return NaN;
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
  return Number(s);
};
const fmt = (n) => (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString(document.documentElement.lang || 'en') : String(+n.toFixed(2)));
function profileTable(rows, name) {
  if (!rows || rows.length < 1) return null;
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  if (!cols) return null;
  const first = rows[0];
  const header = rows.length > 1 && first.every((c) => String(c).trim() !== '') && first.every((c) => isNaN(toNum(c))) &&
    new Set(first.map((c) => String(c).trim().toLowerCase())).size === first.length;
  const names = Array.from({ length: cols }, (_, i) => (header ? String(first[i] || '').trim() : '') || t('Column {n}', { n: i + 1 }));
  const data = rows.slice(header ? 1 : 0);
  const out = [];
  for (let i = 0; i < cols; i++) {
    const vals = [];
    for (const r of data) { const v = r[i]; if (v !== undefined && String(v).trim() !== '') vals.push(String(v).trim()); }
    if (!vals.length) { out.push({ name: names[i], type: 'empty', filled: 0 }); continue; }
    const nums = vals.map(toNum);
    const numeric = nums.filter((x) => !isNaN(x)).length / vals.length >= 0.85;
    const dateLike = vals.filter((v) => /^\d{4}-\d{2}-\d{2}/.test(v) || /^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/.test(v)).length / vals.length >= 0.85;
    const col = { name: names[i], filled: vals.length, unique: new Set(vals.slice(0, 20000)).size };
    if (dateLike) {
      col.type = 'date';
      const sorted = vals.slice().sort();
      col.min = sorted[0]; col.max = sorted[sorted.length - 1];
    } else if (numeric) {
      col.type = 'number';
      const ns = nums.filter((x) => !isNaN(x));
      let min = Infinity, max = -Infinity, sum = 0;
      for (const x of ns) { if (x < min) min = x; if (x > max) max = x; sum += x; }
      col.min = min; col.max = max; col.sum = sum; col.mean = sum / ns.length;
    } else {
      col.type = col.unique <= Math.max(12, vals.length * 0.05) ? 'category' : 'text';
      const cnt = new Map();
      vals.forEach((v) => cnt.set(v, (cnt.get(v) || 0) + 1));
      col.top = [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([v, c]) => [v, c]);
    }
    out.push(col);
  }
  return { name, header, records: data.length, columns: out };
}
function tableBlurb(p) {
  const cols = p.columns.filter((c) => c.type !== 'empty');
  let s = t('Records: {records}, fields: {fields}', { records: U.fmtNum(p.records), fields: cols.length });
  if (p.header) s += ` (${cols.slice(0, 6).map((c) => c.name).join(', ')}${cols.length > 6 ? '…' : ''})`;
  return `${s}.`;
}
function tablePoints(p) {
  const pts = [];
  p.columns.forEach((c) => {
    if (c.type === 'number' && pts.length < 6) pts.push(t('{name}: {min} to {max}, average {mean}, total {sum}', { name: c.name, min: fmt(c.min), max: fmt(c.max), mean: fmt(c.mean), sum: fmt(c.sum) }));
    else if (c.type === 'date' && pts.length < 6) pts.push(`${c.name}: ${c.min} → ${c.max}`);
    else if (c.type === 'category' && c.top && pts.length < 6) pts.push(t('{name}: mostly “{top}” ({percent}%), {unique} distinct values', { name: c.name, top: shortStr(c.top[0][0], 40), percent: Math.round((c.top[0][1] / c.filled) * 100), unique: c.unique }));
  });
  return pts;
}

/* ---------- descriptors for non-prose files ---------- */
function describe(r, file) {
  const m = r.meta, g = (grp, k) => (m[grp] || {})[k];
  const kind = t(r.kind);
  if (['png', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'heic', 'avif', 'ico'].includes(r.type)) {
    const dim = g('Image', 'Width') && g('Image', 'Height') ? `${g('Image', 'Width').replace(' px', '')} × ${g('Image', 'Height').replace(' px', '')} px` : '';
    let s = `${kind}${dim ? `, ${dim}` : ''}`;
    const cam = E.cameraName(g('Camera & EXIF', 'Camera make'), g('Camera & EXIF', 'Camera model'));
    if (cam) s += `, ${cam}`;
    const lens = [g('Camera & EXIF', 'Focal length'), g('Camera & EXIF', 'Aperture'), g('Camera & EXIF', 'Exposure'), g('Camera & EXIF', 'ISO') ? `ISO ${g('Camera & EXIF', 'ISO')}` : ''].filter(Boolean).join(', ');
    if (lens) s += ` (${lens})`;
    if (g('Camera & EXIF', 'Taken')) s += `, ${String(g('Camera & EXIF', 'Taken')).replace(/^(\d{4}):(\d\d):(\d\d)/, '$1-$2-$3')}`;
    if (r.gps) s += `, GPS ${r.gps[0].toFixed(3)}, ${r.gps[1].toFixed(3)}`;
    return `${s}.`;
  }
  if (['mp3', 'flac', 'ogg', 'wav', 'm4a', 'mp4', 'mov', 'webm', 'mkv'].includes(r.type)) {
    const tags = m.Tags || {};
    let s = tags.Title ? `“${tags.Title}”` : kind;
    if (tags.Artist) s += ` · ${tags.Artist}`;
    if (tags.Album) s += ` · ${tags.Album}${tags.Year ? ` (${tags.Year})` : ''}`;
    const dur = g('Audio', 'Duration') || g('Video', 'Duration');
    if (dur) s += ` · ${dur}`;
    if (g('Video', 'Resolution')) s += ` · ${g('Video', 'Resolution')} px`;
    if (g('Audio', 'Bitrate')) s += ` · ${g('Audio', 'Bitrate')}`;
    return `${s}.`;
  }
  if (r.archive) {
    const a = r.archive;
    let s = t('{kind}. Files: {files}, folders: {dirs}, unpacked: {total}.', { kind, files: U.fmtNum(a.files), dirs: a.dirs, total: U.fmtBytes(a.total) });
    if (a.types.length) s += ` ${a.types.slice(0, 3).map((x) => `.${x.ext} (${x.n})`).join(', ')}.`;
    if (a.biggest.length) s += ` ${t('Largest:')} ${a.biggest[0]}.`;
    return s;
  }
  if (r.type === 'svg') return `${kind}${g('Image', 'viewBox') ? ` · viewBox ${g('Image', 'viewBox')}` : ''}${r.title ? ` · “${r.title}”` : ''}.`;
  return `${kind}${file ? `, ${U.fmtBytes(file.size)}` : ''}.`;
}

/* ---------- main ---------- */
S.run = function (r, file) {
  const out = { blurb: describe(r, file), points: [], keywords: [], entities: {}, stats: {}, profiles: [], mode: 'meta', paragraph: '', headline: r.title || '' };
  const text = (r.summaryText != null && r.summaryText !== '' ? r.summaryText : r.text) || '';
  const clean = text.replace(/\[Page \d+\]\n/g, '').trim();

  // tabular data
  if (r.tables && r.tables.length) {
    out.mode = 'data';
    out.profiles = r.tables.slice(0, 8).map((t) => profileTable(t.rows, t.name)).filter(Boolean);
    if (out.profiles.length) {
      const bits = out.profiles.map((p) => (out.profiles.length > 1 ? `“${p.name}”: ` : '') + tableBlurb(p));
      out.paragraph = (r.sheets ? `${t('Sheets: {n}', { n: r.sheets.length })}. ` : '') + bits.join(' ');
      out.points = out.profiles.slice(0, 3).flatMap((p) => tablePoints(p).map((x) => (out.profiles.length > 1 ? `${p.name} · ` : '') + x)).slice(0, 8);
    }
    if (r.codeSummary && !out.paragraph) out.paragraph = r.codeSummary;
    out.stats = { cells: r.tables.reduce((s, t) => s + t.rows.length, 0) };
    out.statsMode = 'table';
    out.entities = text.length < 400000 && r.type !== 'xlsx' && r.type !== 'ods' ? entities(text.slice(0, 200000), '') : {};
    return out;
  }

  if (r.codeSummary) {
    out.mode = 'structure';
    out.paragraph = r.codeSummary + (r.summaryText ? ' ' + shortStr(r.summaryText.replace(/\s+/g, ' '), 300) : '');
    out.entities = entities(r.text.slice(0, 200000), '');
    out.stats = textStats(r.text, 0, '');
    return out;
  }

  if (r.noText) { out.paragraph = out.blurb; return out; }
  if (r.noSummary || clean.length < 20) { out.paragraph = out.blurb; out.stats = textStats(clean, 0, ''); return out; }

  // prose
  out.mode = 'prose';
  const lang = detectLanguage(clean);
  const stop = STOP[lang.code] || ALL_STOP;
  const sents = splitSentences(clean.slice(0, 600000));
  const words = (clean.match(/[\p{L}\p{N}]+/gu) || []).length;
  out.language = lang;
  out.stats = textStats(clean, sents.filter((s) => !s.heading).length, lang.name, words);
  if (!out.headline) {
    const h = (r.headings && r.headings[0] && r.headings[0].title) || (sents[0] && sents[0].heading ? sents[0].text : '');
    out.headline = shortStr(h || '', 120);
  }

  let cands = sents.map((s, i) => ({ text: s.text, i, heading: s.heading })).filter((c) => !c.heading && c.text.length >= 35 && c.text.length <= 420 &&
    (c.text.match(/[\p{L}]+/gu) || []).length >= 6 && (c.text.match(/\d/g) || []).length < c.text.length * 0.3 && (c.text.match(/https?:\/\//g) || []).length < 2);
  if (cands.length < 3) {
    cands = clean.split(/\n/).map((t, i) => ({ text: t.trim(), i })).filter((c) => c.text.length >= 30 && c.text.length <= 420);
  }
  if (words < 60 || cands.length < 3) {
    out.paragraph = shortStr(clean.replace(/\s+/g, ' '), 420);
    out.keywords = words >= 25 ? keywords(clean, stop, lang.code) : [];
    out.entities = entities(clean, lang.code);
    return out;
  }
  if (cands.length > 1500) { const step = Math.ceil(cands.length / 1500); cands = cands.filter((_, i) => i % step === 0); }

  if (lang.code === 'cjk' || lang.code === 'cyr' || lang.code === 'ara') {
    out.paragraph = cands.slice(0, 3).map((c) => c.text).join(' ');
    out.points = cands.slice(3, 7).map((c) => c.text);
    return out;
  }
  const { sets, score } = rank(cands, stop);
  const n = cands.length;
  const k = Math.min(8, Math.max(3, Math.round(Math.sqrt(n) / 2.2) + 2));
  const chosen = selectMMR(cands, score, sets, Math.min(k, n));
  const lead = chosen.slice(0, 3).sort((a, b) => cands[a].i - cands[b].i);
  const rest = chosen.slice(3).sort((a, b) => cands[a].i - cands[b].i);
  out.paragraph = lead.map((i) => cands[i].text).join(' ');
  out.points = rest.map((i) => cands[i].text);
  out.keywords = keywords(clean, stop, lang.code);
  out.entities = entities(clean, lang.code);
  return out;
};

function textStats(text, sentences, language, words) {
  words = words !== undefined ? words : (text.match(/[\p{L}\p{N}]+/gu) || []).length;
  const toks = tokenize(text.slice(0, 300000));
  const uniq = new Set(toks).size;
  return {
    words, chars: text.length, sentences,
    paragraphs: text ? text.split(/\n\s*\n/).filter((p) => p.trim()).length : 0,
    readMin: words / 225, avgSentence: sentences ? words / sentences : 0,
    unique: uniq, language,
  };
}
S.profileTable = profileTable;
S.detectLanguage = detectLanguage;
