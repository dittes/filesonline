// build.mjs
// Generates the static site: /en, /de, /pl and /cs with localized URLs, plus the root
// chooser, sitemap, redirects and service worker. Run with `npm run build`; the output is
// committed because GitHub Pages serves the repository as it is. No dependencies.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SITE, LANGS, LANG_NAMES, LOCALES, PAGES, CATEGORIES, TOOLS, SISTER_SITES, CONVERT_TO_PDF, PAGE_SISTERS,
  sisterUrl, pagePath, toolPath,
} from './registry.mjs';
import { ICONS, LOGO } from './icons.mjs';

const BUILD = dirname(fileURLToPath(import.meta.url));
const ROOT = join(BUILD, '..');

const content = {};
for (const lang of LANGS) content[lang] = (await import(`./content/${lang}.mjs`)).default;

// Pages for single file manager functions. Copy per language in content/features.<lang>.mjs.
const FEATURES = [
  { id: 'duplicates', icon: 'alternate' }, { id: 'rename', icon: 'edit' }, { id: 'zipPassword', icon: 'protect' },
  { id: 'extract', icon: 'extract' }, { id: 'strip', icon: 'metadata' }, { id: 'photosort', icon: 'toImage' },
  { id: 'compare', icon: 'compare' }, { id: 'search', icon: 'inspector' }, { id: 'treemap', icon: 'organize' },
  { id: 'checksum', icon: 'numbers' },
];
const featureCopy = {};
for (const lang of LANGS) {
  const file = join(BUILD, `content/features.${lang}.mjs`);
  featureCopy[lang] = existsSync(file) ? (await import(`./content/features.${lang}.mjs`)).default : {};
}
// A feature page exists once every language has its copy
const LIVE_FEATURES = FEATURES.filter(f => LANGS.every(l => featureCopy[l][f.id]?.slug));
const featurePath = (id, lang) => `/${lang}/${featureCopy[lang][id].slug}/`;
const featurePaths = id => Object.fromEntries(LANGS.map(l => [l, featurePath(id, l)]));

const appStrings = (await import('./content/app-strings.mjs')).default;
const appDict = {};
LANGS.filter(l => l !== 'en').forEach((lang, i) => {
  appDict[lang] = Object.fromEntries(appStrings.map(row => [row[0], row[i + 1]]));
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const e = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fill = (s, params) => Object.entries(params).reduce((out, [k, v]) => out.replaceAll(`{${k}}`, v), s);

function assetUrl(path) {
  const hash = createHash('sha1').update(readFileSync(join(ROOT, path))).digest('hex').slice(0, 8);
  return `/${path}?v=${hash}`;
}

function write(path, html) {
  const full = join(ROOT, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, html);
}

const THEME_BOOT = `(function(){try{var t=localStorage.getItem('fo-theme')==='dark'?'dark':'light';document.documentElement.setAttribute('data-theme',t)}catch(e){}})();`;
const inlineHash = src => `'sha256-${createHash('sha256').update(src).digest('base64')}'`;

/** Pages without CDN libraries get a policy that makes "no upload" verifiable. */
function csp(inlineScripts = [THEME_BOOT], { cdn = '' } = {}) {
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${cdn ? `blob: ${cdn} ` : ''}${inlineScripts.map(inlineHash).join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data: blob:",
    `connect-src 'self' blob: data:${cdn ? ` ${cdn}` : ''}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ');
}

const iconSvg = (name, cls = 's-card__icon') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.file}</svg>`;

const toolById = id => TOOLS.find(t => t.id === id);

// ─── Shared page parts ────────────────────────────────────────────────────────

function head({ lang, title, desc, paths, jsonLd = [], useCsp = true, cspCdn = '', extraCss = [], ogType = 'website', noindex = false }) {
  const url = `${SITE}${paths[lang]}`;
  const alternates = LANGS.map(l => `<link rel="alternate" hreflang="${l}" href="${SITE}${paths[l]}">`).join('\n  ');
  const ogAlt = LANGS.filter(l => l !== lang).map(l => `<meta property="og:locale:alternate" content="${LOCALES[l]}">`).join('\n  ');
  const scripts = jsonLd.map(data => `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`).join('\n  ');
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${useCsp ? `<meta http-equiv="Content-Security-Policy" content="${e(csp([THEME_BOOT], { cdn: cspCdn }))}">` : ''}
  <title>${e(title)}</title>
  <meta name="description" content="${e(desc)}">
  ${noindex ? '<meta name="robots" content="noindex">' : ''}
  <link rel="canonical" href="${url}">
  ${alternates}
  <link rel="alternate" hreflang="x-default" href="${SITE}${paths.en}">
  <meta name="theme-color" content="#ffffff">
  <meta property="og:type" content="${ogType}">
  <meta property="og:site_name" content="Files Online">
  <meta property="og:url" content="${url}">
  <meta property="og:title" content="${e(title)}">
  <meta property="og:description" content="${e(desc)}">
  <meta property="og:locale" content="${LOCALES[lang]}">
  ${ogAlt}
  <meta property="og:image" content="${SITE}/assets/icons/og-image.png">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="/assets/icons/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/assets/icons/icon-192.png">
  <link rel="manifest" href="/manifest.webmanifest">
  <script>${THEME_BOOT}</script>
  <link rel="preload" href="/assets/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
  ${extraCss.map(c => `<link rel="stylesheet" href="${assetUrl(c)}">`).join('\n  ')}
  <link rel="stylesheet" href="${assetUrl('assets/css/site.css')}">
  ${scripts}
</head>`;
}

function themeButton(c) {
  return `<button class="s-icon-btn" type="button" data-action="toggle-theme" aria-label="${e(c.nav.toggleTheme)}" title="${e(c.nav.toggleTheme)}">
          <svg class="icon-moon" viewBox="0 0 16 16" fill="none" aria-hidden="true" width="16" height="16"><path d="M13.5 9.5A5.5 5.5 0 016.5 2.5a5.5 5.5 0 107 7z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
          <svg class="icon-sun" viewBox="0 0 16 16" fill="none" aria-hidden="true" width="16" height="16"><circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>`;
}

function header(lang, paths, current) {
  const c = content[lang];
  const groups = CATEGORIES.map(cat => `<div>
              <h3>${e(c.cats[cat])}</h3>
              ${TOOLS.filter(t => t.cat === cat).map(t => `<a href="${toolPath(t, lang)}">${e(c.tools[t.id].name)}</a>`).join('')}
            </div>`).join('');
  const megaLink = key => `<a href="${pagePath(key, lang)}"${current === key ? ' aria-current="page"' : ''}>${e(c.nav[key])}</a>`;
  const navLink = key => `<a href="${pagePath(key, lang)}"${current === key ? ' aria-current="page"' : ''}>${e(c.nav[key])}</a>`;
  return `<a class="s-skip" href="#main">${e(c.nav.skip)}</a>
  <header class="s-header">
    <div class="s-wrap s-header__row">
      <a class="s-logo" href="/${lang}/">${LOGO}<span>Files Online</span></a>
      <nav class="s-nav" aria-label="${e(c.nav.main)}">
        <details class="s-menu">
          <summary>${e(c.nav.pdfTools)}<svg class="s-caret" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></summary>
          <div class="s-mega">
            ${groups}
            <a class="s-mega__all" href="${pagePath('pdfTools', lang)}">${e(c.nav.allPdfTools)} →</a>
          </div>
        </details>
        <details class="s-menu">
          <summary>${e(c.nav.fileTools)}<svg class="s-caret" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></summary>
          <div class="s-mega s-mega--files">
            <div>
              <h3>${e(c.nav.groupOpen)}</h3>
              ${megaLink('inspector')}${megaLink('fileManager')}${megaLink('md')}${megaLink('mbox')}
            </div>
            ${[LIVE_FEATURES.slice(0, 5), LIVE_FEATURES.slice(5)].filter(g => g.length).map((group, i) => `<div>
              <h3>${i ? '&nbsp;' : e(c.nav.groupFolders)}</h3>
              ${group.map(f => `<a href="${featurePath(f.id, lang)}"${current === f.id ? ' aria-current="page"' : ''}>${e(featureCopy[lang][f.id].name)}</a>`).join('')}
            </div>`).join('')}
          </div>
        </details>
        ${navLink('inspector')}
        ${navLink('fileManager')}
      </nav>
      <div class="s-actions">
        <details class="s-lang">
          <summary aria-label="${e(c.nav.language)}">${lang}</summary>
          <ul>
            ${LANGS.map(l => `<li><a href="${paths[l]}" hreflang="${l}" lang="${l}" data-set-lang="${l}"${l === lang ? ' aria-current="true"' : ''}>${LANG_NAMES[l]}</a></li>`).join('')}
          </ul>
        </details>
        ${themeButton(c)}
        <button class="s-icon-btn s-burger" type="button" aria-label="${e(c.nav.menu)}" aria-expanded="false"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
      </div>
    </div>
  </header>`;
}

function footer(lang, paths, { noTheme = false } = {}) {
  const c = content[lang];
  return `<footer class="s-footer">
    <div class="s-wrap s-footer__row">
      <span class="s-footer__brand">${LOGO}<span>${e(c.footer.note)}</span></span>
      <nav class="s-footer__links" aria-label="Legal">
        <a href="${pagePath('privacy', lang)}">${e(c.nav.privacy)}</a>
        <a href="${pagePath('imprint', lang)}">${e(c.nav.imprint)}</a>
      </nav>
    </div>
  </footer>
  <script src="${assetUrl('assets/js/site.js')}" defer${noTheme ? ' data-no-theme="true"' : ''}></script>`;
}

function breadcrumbs(items) {
  return `<ol class="s-crumbs">${items.map(([label, href]) => `<li>${href ? `<a href="${href}">${e(label)}</a>` : `<span aria-current="page">${e(label)}</span>`}</li>`).join('')}</ol>`;
}

function card(lang, tool) {
  const t = content[lang].tools[tool.id];
  return `<a class="s-card" data-cat="${tool.cat}" href="${toolPath(tool, lang)}">
          ${iconSvg(tool.icon)}
          <span class="s-card__title">${e(t.name)}</span>
          <span class="s-card__desc">${e(t.short)}</span>
        </a>`;
}

function fileCard(lang, key, cat = 'files') {
  const c = content[lang];
  return `<a class="s-card" data-cat="${cat}" href="${pagePath(key, lang)}">
          ${iconSvg(key)}
          <span class="s-card__title">${e(c.nav[key])}</span>
          <span class="s-card__desc">${e(c.fileCards[key])}</span>
        </a>`;
}

function toolGrid(lang, headingTag = 'h3') {
  const c = content[lang];
  return CATEGORIES.map(cat => `<div class="s-cat">
        <div class="s-cat__head"><${headingTag}>${e(c.cats[cat])}</${headingTag}></div>
        <div class="s-cards">${TOOLS.filter(t => t.cat === cat).map(t => card(lang, t)).join('')}</div>
      </div>`).join('');
}

function sisterLinks(lang, keys) {
  const c = content[lang];
  return `<div class="s-links">${keys.map(key => {
    const [site] = key.split(':');
    return `<a href="${sisterUrl(key, lang)}" rel="noopener"><strong>${e(c.sisterLabels[key])}</strong><small>${e(SISTER_SITES[site].name)} ↗</small></a>`;
  }).join('')}</div>`;
}

function sisterSection(lang, keys) {
  if (!keys?.length) return '';
  const c = content[lang];
  return `<section class="s-section">
    <div class="s-wrap">
      <h2>${e(c.toolPage.sisterTitle)}</h2>
      <p class="s-section__lede">${e(c.toolPage.sisterLede)}</p>
      ${sisterLinks(lang, keys)}
    </div>
  </section>`;
}

function faqSection(c, faqs, title) {
  return `<section class="s-section" id="faq">
    <div class="s-wrap">
      <h2>${e(title || c.toolPage.faqTitle)}</h2>
      <div class="s-faq">
        ${faqs.map(([q, a], i) => `<details${i === 0 ? ' open' : ''}><summary>${e(q)}</summary><p>${e(a)}</p></details>`).join('\n        ')}
      </div>
    </div>
  </section>`;
}

function howToSection(title, steps) {
  return `<section class="s-section s-section--tint" id="how">
    <div class="s-wrap">
      <h2>${e(title)}</h2>
      <ol class="s-steps">${steps.map(step => `<li><p>${e(step)}</p></li>`).join('')}</ol>
    </div>
  </section>`;
}

function benefitsSection(c) {
  return `<section class="s-section">
    <div class="s-wrap">
      <h2>${e(c.toolPage.benefitsTitle)}</h2>
      <div class="s-benefits">
        ${c.toolPage.benefits.map(([h, p]) => `<div><h3>${e(h)}</h3><p>${e(p)}</p></div>`).join('')}
      </div>
    </div>
  </section>`;
}

// ─── JSON-LD ──────────────────────────────────────────────────────────────────

const ldOrg = { '@context': 'https://schema.org', '@type': 'Organization', '@id': `${SITE}/#org`, name: 'Files Online', url: `${SITE}/`, logo: `${SITE}/assets/icons/icon-512.png` };

function ldApp(lang, name, desc, path, features = []) {
  return {
    '@context': 'https://schema.org', '@type': ['SoftwareApplication', 'WebApplication'],
    name, url: `${SITE}${path}`, description: desc, inLanguage: lang,
    applicationCategory: 'UtilitiesApplication', operatingSystem: 'Windows, macOS, Linux, Android, iOS',
    browserRequirements: 'Requires a modern web browser with JavaScript enabled',
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
    publisher: { '@id': `${SITE}/#org` },
    ...(features.length ? { featureList: features } : {}),
  };
}

function ldCrumbs(items) {
  return {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: items.map(([name, href], i) => ({ '@type': 'ListItem', position: i + 1, name, ...(href ? { item: `${SITE}${href}` } : {}) })),
  };
}

const ldFaq = faqs => ({
  '@context': 'https://schema.org', '@type': 'FAQPage',
  mainEntity: faqs.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
});

const ldHowTo = (name, steps) => ({
  '@context': 'https://schema.org', '@type': 'HowTo', name,
  step: steps.map((text, i) => ({ '@type': 'HowToStep', position: i + 1, text })),
});

// ─── Pages ────────────────────────────────────────────────────────────────────

const pathsFor = key => Object.fromEntries(LANGS.map(l => [l, pagePath(key, l)]));
const toolPaths = tool => Object.fromEntries(LANGS.map(l => [l, toolPath(tool, l)]));

function homePage(lang) {
  const c = content[lang];
  const h = c.home;
  const paths = pathsFor('home');
  const popular = TOOLS.filter(t => t.popular);
  return `${head({ lang, title: h.title, desc: h.desc, paths, jsonLd: [ldOrg, ldApp(lang, 'Files Online', h.desc, paths[lang]), ldFaq(h.faqs)] })}
<body class="s-page">
  ${header(lang, paths, 'home')}
  <main id="main">
    <section class="s-hero">
      <div class="s-wrap s-hero__inner">
        <h1>${h.h1Html}</h1>
        <p class="s-hero__lede">${e(h.lede)}</p>
      </div>
      <div class="s-wrap">
        <div class="pt s-home">
          <div class="pt-drop" id="home-drop" data-inspector="${pagePath('inspector', lang)}" data-manager="${pagePath('fileManager', lang)}" data-mbox="${pagePath('mbox', lang)}" data-reading="${e(h.reading)}" data-too-big="${e(h.tooBig)}" data-failed="${e(h.failed)}">
            ${iconSvg('fileManager', 'pt-drop__icon')}
            <div class="s-home__cta">
              <button class="s-btn s-btn--primary pt-drop__btn" type="button" data-home="file">${e(h.chooseFile)}</button>
              <button class="s-btn s-btn--secondary pt-drop__btn" type="button" data-home="folder">${e(h.openFolder)}</button>
            </div>
            <p class="pt-drop__or">${e(h.dropHint)}</p>
            <p class="pt-drop__error" role="status" hidden></p>
            <noscript><p class="pt-drop__error">${e(c.toolPage.noJs)}</p></noscript>
          </div>
          <div class="s-routes">
            <a href="${pagePath('inspector', lang)}">${iconSvg('inspector', 's-routes__icon')}<span><strong>${e(h.routeFile[0])}</strong><small>${e(h.routeFile[1])}</small></span></a>
            <a href="${pagePath('fileManager', lang)}">${iconSvg('fileManager', 's-routes__icon')}<span><strong>${e(h.routeFolder[0])}</strong><small>${e(h.routeFolder[1])}</small></span></a>
            <a href="${pagePath('pdfTools', lang)}">${iconSvg('edit', 's-routes__icon')}<span><strong>${e(h.routePdf[0])}</strong><small>${e(fill(h.routePdf[1], { n: TOOLS.length }))}</small></span></a>
          </div>
          <ul class="s-trust">${c.toolPage.trust.map(x => `<li>${e(x)}</li>`).join('')}</ul>
          <p class="s-home__install"><button class="s-btn s-btn--link" type="button" data-home="install" hidden>${e(h.install)}</button></p>
        </div>
      </div>
    </section>

    <section class="s-section s-section--tint">
      <div class="s-wrap">
        <h2>${e(h.filesTitle)}</h2>
        <p class="s-section__lede">${e(h.filesLede)}</p>
        <div class="s-cards">${['inspector', 'fileManager', 'md', 'mbox'].map(k => fileCard(lang, k)).join('')}${LIVE_FEATURES.map(x => featureCard(lang, x)).join('')}</div>
      </div>
    </section>

    <section class="s-section">
      <div class="s-wrap">
        <div class="s-section__head">
          <h2>${e(c.nav.allPdfTools)}</h2>
          <a href="${pagePath('pdfTools', lang)}">${e(fill(h.allTools, { n: TOOLS.length }))} →</a>
        </div>
        <nav class="s-chips s-chips--left" aria-label="${e(h.popularTitle)}">
          ${popular.map(t => `<a class="s-chip" href="${toolPath(t, lang)}">${e(c.tools[t.id].name)}</a>`).join('')}
        </nav>
        ${toolGrid(lang)}
      </div>
    </section>

    <section class="s-section">
      <div class="s-wrap">
        <h2>${e(h.privacyTitle)}</h2>
        <div class="s-benefits">
          ${c.toolPage.benefits.map(([bh, bp]) => `<div><h3>${e(bh)}</h3><p>${e(bp)}</p></div>`).join('')}
        </div>
        <p class="s-section__more"><a href="${pagePath('privacy', lang)}">${e(h.privacyLink)} →</a></p>
      </div>
    </section>

    ${faqSection(c, h.faqs)}
  </main>
  ${footer(lang, paths)}
  <script type="module" src="${assetUrl('assets/js/home.js')}"></script>
</body>
</html>
`;
}

function hubPage(lang) {
  const c = content[lang];
  const h = c.hub;
  const paths = pathsFor('pdfTools');
  const crumbs = [[c.nav.home, `/${lang}/`], [h.name]];
  return `${head({ lang, title: h.title, desc: h.desc, paths, jsonLd: [ldApp(lang, h.name, h.desc, paths[lang], TOOLS.map(t => c.tools[t.id].name)), ldCrumbs(crumbs), ldFaq(h.faqs)] })}
<body class="s-page">
  ${header(lang, paths, 'pdfTools')}
  <main id="main">
    <div class="s-wrap">
      ${breadcrumbs(crumbs)}
      <div class="s-toolhead">
        <h1>${e(h.h1)}</h1>
        <p>${e(h.lede)}</p>
      </div>
    </div>
    <section class="s-section" style="border-top:0;padding-top:0">
      <div class="s-wrap">${toolGrid(lang, 'h2')}</div>
    </section>
    <section class="s-section s-section--tint">
      <div class="s-wrap">
        <h2>${e(h.convertTitle)}</h2>
        <p class="s-section__lede">${e(h.convertLede)}</p>
        ${sisterLinks(lang, CONVERT_TO_PDF)}
      </div>
    </section>
    ${benefitsSection(c)}
    ${faqSection(c, h.faqs)}
  </main>
  ${footer(lang, paths)}
</body>
</html>
`;
}

function toolPage(lang, tool) {
  const c = content[lang];
  const t = c.tools[tool.id];
  const paths = toolPaths(tool);
  const isImage = tool.accept === 'image';
  const faqs = [...t.faqs, ...c.toolPage.sharedFaqs];
  const crumbs = [[c.nav.home, `/${lang}/`], [c.nav.pdfTools, pagePath('pdfTools', lang)], [t.name]];
  const jsonLd = [ldApp(lang, t.name, t.desc, paths[lang]), ldCrumbs(crumbs), ldHowTo(t.how, t.steps), ldFaq(faqs)];
  return `${head({ lang, title: t.title, desc: t.desc, paths, jsonLd })}
<body class="s-page">
  ${header(lang, paths)}
  <main id="main">
    <div class="s-wrap">
      ${breadcrumbs(crumbs)}
      <div class="s-toolhead">
        <h1>${e(t.h1)}</h1>
        <p>${e(t.lede)}</p>
      </div>
      <div class="pt" id="pdf-tool" data-tool="${tool.id}">
        <div class="pt-drop" data-accept="${isImage ? 'image/*' : '.pdf,application/pdf'}" data-multiple="${!!tool.multiple}">
          ${iconSvg(tool.icon, 'pt-drop__icon')}
          <button class="s-btn s-btn--primary pt-drop__btn" type="button">${e(isImage ? (tool.multiple ? c.toolPage.chooseImages : c.toolPage.chooseImage) : (tool.multiple ? c.toolPage.choosePdfs : c.toolPage.choosePdf))}</button>
          <p class="pt-drop__or">${e(c.toolPage.orDrop)}</p>
          <p class="pt-drop__error" role="alert" hidden></p>
          <noscript><p class="pt-drop__error">${e(c.toolPage.noJs)}</p></noscript>
        </div>
        <div class="pt-stage" hidden></div>
        <ul class="s-trust">${c.toolPage.trust.map(x => `<li>${e(x)}</li>`).join('')}</ul>
      </div>
    </div>

    <section class="s-section">
      <div class="s-wrap s-prose">
        <h2>${e(t.aboutTitle)}</h2>
        ${t.about.map(p => `<p>${e(p)}</p>`).join('')}
      </div>
    </section>
    ${howToSection(t.how, t.steps)}
    ${faqSection(c, faqs)}
    ${sisterSection(lang, tool.sister)}
    <section class="s-section s-section--tint">
      <div class="s-wrap">
        <h2>${e(c.toolPage.relatedTitle)}</h2>
        <div class="s-cards" style="margin-top:16px">${tool.related.map(id => card(lang, toolById(id))).join('')}</div>
      </div>
    </section>
  </main>
  ${footer(lang, paths)}
  <script type="module" src="${assetUrl('assets/js/pdf/main.js')}"></script>
</body>
</html>
`;
}

function featureCard(lang, f) {
  const t = featureCopy[lang][f.id];
  return `<a class="s-card" data-cat="files" href="${featurePath(f.id, lang)}">
          ${iconSvg(f.icon)}
          <span class="s-card__title">${e(t.name)}</span>
          <span class="s-card__desc">${e(t.short)}</span>
        </a>`;
}

/** One function of the file manager as its own page: same app, started in that tool. */
function featurePage(lang, f) {
  const c = content[lang];
  const p = featureCopy[lang][f.id];
  const m = c.fileManagerPage;
  const paths = featurePaths(f.id);
  const crumbs = [[c.nav.home, `/${lang}/`], [m.name, pagePath('fileManager', lang)], [p.name]];
  const others = LIVE_FEATURES.filter(x => x.id !== f.id);
  return `${head({ lang, title: p.title, desc: p.desc, paths, cspCdn: 'https://cdn.jsdelivr.net', extraCss: ['assets/css/fm.css'], jsonLd: [ldApp(lang, p.name, p.desc, paths[lang], p.features.map(x => x[0])), ldCrumbs(crumbs), ldHowTo(p.how, p.steps), ldFaq(p.faqs)] })}
<body class="s-page fm-page" data-fm-feature="${f.id}">
  <div id="fm-landing">
  ${header(lang, paths, f.id)}
  <main id="main">
    <div class="s-wrap">
      ${breadcrumbs(crumbs)}
      <div class="s-toolhead">
        <h1>${e(p.h1)}</h1>
        <p>${e(p.lede)}</p>
      </div>
      <div class="pt fm-hero">
        <div class="pt-drop">
          ${iconSvg(f.icon, 'pt-drop__icon')}
          <div class="fm-hero__cta">
            <button class="s-btn s-btn--primary pt-drop__btn" type="button" data-fm="open-folder">${e(m.openFolder)}</button>
            <button class="s-btn s-btn--secondary pt-drop__btn" type="button" data-fm="open-files">${e(m.openFiles)}</button>
          </div>
          <p class="pt-drop__or">${e(m.dropHint)}</p>
          <button class="s-btn s-btn--secondary fm-hero__again" type="button" data-fm="reopen" hidden></button>
          <button class="fm-hero__demo" type="button" data-fm="demo">${e(m.demo)}</button>
          <noscript><p class="pt-drop__error">${e(c.toolPage.noJs)}</p></noscript>
        </div>
        <ul class="s-trust">${c.toolPage.trust.map(x => `<li>${e(x)}</li>`).join('')}</ul>
      </div>
    </div>
    <section class="s-section">
      <div class="s-wrap">
        <div class="s-benefits">
          ${p.features.map(([h, d]) => `<div><h3>${e(h)}</h3><p>${e(d)}</p></div>`).join('')}
        </div>
      </div>
    </section>
    ${howToSection(p.how, p.steps)}
    <section class="s-section">
      <div class="s-wrap s-prose">
        <h2>${e(p.aboutTitle)}</h2>
        ${p.about.map(x => `<p>${e(x)}</p>`).join('')}
      </div>
    </section>
    ${faqSection(c, p.faqs)}
    <section class="s-section s-section--tint">
      <div class="s-wrap">
        <h2>${e(c.nav.moreFileTools)}</h2>
        <div class="s-cards" style="margin-top:18px">
          ${fileCard(lang, 'fileManager')}${fileCard(lang, 'inspector')}
          ${others.map(x => featureCard(lang, x)).join('')}
        </div>
      </div>
    </section>
  </main>
  ${footer(lang, paths)}
  </div>
  <div class="fm" id="fm-app" hidden></div>
  <script type="module" src="${assetUrl('assets/js/fm/main.js')}"></script>
</body>
</html>
`;
}

function fileManagerPage(lang) {
  const c = content[lang];
  const p = c.fileManagerPage;
  const paths = pathsFor('fileManager');
  const crumbs = [[c.nav.home, `/${lang}/`], [p.name]];
  const faqs = [...p.faqs];
  const toolLink = id => {
    const tool = toolById(id);
    return `<a href="${toolPath(tool, lang)}"><strong>${e(c.tools[id].name)}</strong><span>${e(c.tools[id].short)}</span></a>`;
  };
  const pageLink = key => `<a href="${pagePath(key, lang)}"><strong>${e(c.nav[key])}</strong><span>${e(c.fileCards[key])}</span></a>`;
  return `${head({ lang, title: p.title, desc: p.desc, paths, cspCdn: 'https://cdn.jsdelivr.net', extraCss: ['assets/css/fm.css'], jsonLd: [ldApp(lang, p.name, p.desc, paths[lang], p.features.map(f => f[0])), ldCrumbs(crumbs), ldFaq(faqs)] })}
<body class="s-page fm-page">
  <div id="fm-landing">
  ${header(lang, paths, 'fileManager')}
  <main id="main">
    <div class="s-wrap">
      ${breadcrumbs(crumbs)}
      <div class="s-toolhead">
        <h1>${e(p.h1)}</h1>
        <p>${e(p.lede)}</p>
      </div>
      <div class="pt fm-hero">
        <div class="pt-drop">
          ${iconSvg('fileManager', 'pt-drop__icon')}
          <div class="fm-hero__cta">
            <button class="s-btn s-btn--primary pt-drop__btn" type="button" data-fm="open-folder">${e(p.openFolder)}</button>
            <button class="s-btn s-btn--secondary pt-drop__btn" type="button" data-fm="open-files">${e(p.openFiles)}</button>
          </div>
          <p class="pt-drop__or">${e(p.dropHint)}</p>
          <button class="s-btn s-btn--secondary fm-hero__again" type="button" data-fm="reopen" hidden></button>
          <button class="fm-hero__demo" type="button" data-fm="demo">${e(p.demo)}</button>
          <noscript><p class="pt-drop__error">${e(c.toolPage.noJs)}</p></noscript>
        </div>
        <ul class="s-trust">${c.toolPage.trust.map(x => `<li>${e(x)}</li>`).join('')}</ul>
      </div>
    </div>
    <section class="s-section">
      <div class="s-wrap">
        <h2>${e(p.featuresTitle)}</h2>
        <div class="s-benefits" style="margin-top:18px">
          ${p.features.map(([h, d]) => `<div><h3>${e(h)}</h3><p>${e(d)}</p></div>`).join('')}
        </div>
      </div>
    </section>
    <section class="s-section s-section--tint">
      <div class="s-wrap">
        <h2>${e(p.toolsTitle)}</h2>
        <p class="s-section__lede">${e(p.toolsLede)}</p>
        <div class="fm-links">
          ${['merge', 'compress', 'edit', 'sign', 'ocr', 'pdf-to-word', 'jpg-to-pdf', 'compare'].map(toolLink).join('')}
          ${['inspector', 'md', 'mbox'].map(pageLink).join('')}
          <a href="${pagePath('pdfTools', lang)}"><strong>${e(c.nav.allPdfTools)} →</strong><span>${e(fill(p.toolsAll, { n: TOOLS.length }))}</span></a>
        </div>
      </div>
    </section>
    ${LIVE_FEATURES.length ? `<section class="s-section">
      <div class="s-wrap">
        <h2>${e(c.nav.groupFolders)}</h2>
        <div class="s-cards" style="margin-top:18px">${LIVE_FEATURES.map(x => featureCard(lang, x)).join('')}</div>
      </div>
    </section>` : ''}
    ${howToSection(p.how, p.steps)}
    ${faqSection(c, faqs)}
    ${sisterSection(lang, PAGE_SISTERS.fileManager)}
  </main>
  ${footer(lang, paths)}
  </div>
  <div class="fm" id="fm-app" hidden></div>
  <script type="module" src="${assetUrl('assets/js/fm/main.js')}"></script>
</body>
</html>
`;
}

function inspectorPage(lang) {
  const c = content[lang];
  const p = c.inspectorPage;
  const paths = pathsFor('inspector');
  const crumbs = [[c.nav.home, `/${lang}/`], [p.name]];
  const faqs = [...p.faqs, ...c.toolPage.sharedFaqs];
  return `${head({ lang, title: p.title, desc: p.desc, paths, extraCss: ['assets/css/inspect.css'], jsonLd: [ldApp(lang, p.name, p.desc, paths[lang], p.features.map(f => f[0])), ldCrumbs(crumbs), ldHowTo(p.how, p.steps), ldFaq(faqs)] })}
<body class="s-page">
  ${header(lang, paths, 'inspector')}
  <main id="main">
    <div class="s-wrap">
      ${breadcrumbs(crumbs)}
      <div class="s-toolhead">
        <h1>${e(p.h1)}</h1>
        <p>${e(p.lede)}</p>
      </div>
      <div id="file-inspector" class="pt">
        <div class="pt-drop">
          ${iconSvg('inspector', 'pt-drop__icon')}
          <button class="s-btn s-btn--primary pt-drop__btn" type="button">${e(p.choose)}</button>
          <p class="pt-drop__or">${e(p.dropHint)}</p>
          <noscript><p class="pt-drop__error">${e(c.toolPage.noJs)}</p></noscript>
        </div>
        <div class="fi-mount" hidden></div>
        <ul class="s-trust">${c.toolPage.trust.map(x => `<li>${e(x)}</li>`).join('')}</ul>
      </div>
    </div>
    <section class="s-section">
      <div class="s-wrap">
        <h2>${e(p.featuresTitle)}</h2>
        <div class="s-benefits" style="margin-top:18px">
          ${p.features.map(([h, d]) => `<div><h3>${e(h)}</h3><p>${e(d)}</p></div>`).join('')}
        </div>
      </div>
    </section>
    ${howToSection(p.how, p.steps)}
    <section class="s-section">
      <div class="s-wrap">
        <h2>${e(p.formatsTitle)}</h2>
        <p class="s-section__lede">${e(p.formatsLede)}</p>
        <div class="fi-formats">
          ${p.formats.map(([h, d]) => `<div><h3>${e(h)}</h3><p>${e(d)}</p></div>`).join('')}
        </div>
      </div>
    </section>
    ${faqSection(c, faqs)}
    ${sisterSection(lang, PAGE_SISTERS.inspector)}
  </main>
  ${footer(lang, paths)}
  <script type="module" src="${assetUrl('assets/js/inspect/main.js')}"></script>
</body>
</html>
`;
}

/** MD and MBOX viewers: legacy app markup inside the new page frame. */
function viewerPage(lang, key, { fragment, css, script, bodyClass, legacyCss = true, windowed = false }) {
  const c = content[lang];
  const p = c[`${key}Page`];
  const paths = pathsFor(key);
  const crumbs = [[c.nav.home, `/${lang}/`], [p.name]];
  const app = translateFragment(readFileSync(join(BUILD, `legacy/${fragment}`), 'utf8'), lang);
  return `${head({ lang, title: p.title, desc: p.desc, paths, useCsp: false, extraCss: [...(legacyCss ? ['assets/css/styles.css'] : []), css], jsonLd: [ldApp(lang, p.name, p.desc, paths[lang]), ldCrumbs(crumbs), ldHowTo(p.how, p.steps), ldFaq(p.faqs)] })}
<body class="s-page ${bodyClass}">
  ${header(lang, paths, key)}
  <main id="main">
  ${windowed ? `<div class="s-wrap">
      ${breadcrumbs(crumbs)}
      <div class="s-toolhead">
        <h1>${e(p.h1)}</h1>
        <p>${e(p.lede)}</p>
      </div>
      ${app}
    </div>` : app}
    <section class="s-section">
      <div class="s-wrap s-prose">
        <h2>${e(p.aboutTitle)}</h2>
        ${p.about.map(x => `<p>${e(x)}</p>`).join('')}
      </div>
    </section>
    ${howToSection(p.how, p.steps)}
    ${faqSection(c, p.faqs)}
    ${sisterSection(lang, PAGE_SISTERS[key])}
  </main>
  ${footer(lang, paths, { noTheme: true })}
  ${appDictScripts(lang)}
  <script type="module" src="${assetUrl(script)}"></script>
</body>
</html>
`;
}

function appDictScripts(lang) {
  if (lang === 'en') return '';
  return `<script src="${assetUrl(`assets/i18n/app.${lang}.js`)}" defer></script>
  <script src="${assetUrl('assets/js/i18n-dom.js')}" defer></script>`;
}

function legalPage(lang, key) {
  const c = content[lang];
  const p = c[key];
  const paths = pathsFor(key);
  return `${head({ lang, title: p.title, desc: p.desc, paths })}
<body class="s-page">
  ${header(lang, paths)}
  <main id="main">
    <div class="s-wrap s-legal">
      <h1>${e(p.h1)}</h1>
      ${p.html}
    </div>
  </main>
  ${footer(lang, paths)}
</body>
</html>
`;
}

// ─── Static translation of legacy markup ──────────────────────────────────────

/** Apply the app dictionary to text nodes and attributes so crawlers see the translation. */
function translateFragment(html, lang) {
  const dict = appDict[lang];
  if (!dict) return html;
  const lookup = raw => {
    const key = raw.replace(/\s+/g, ' ').trim();
    return key && dict[key] !== undefined ? dict[key] : null;
  };
  return html
    .replace(/>([^<>]+)</g, (m, text) => {
      const decoded = text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      const hit = lookup(decoded);
      return hit === null ? m : `>${text.match(/^\s*/)[0]}${e(hit)}${text.match(/\s*$/)[0]}<`;
    })
    .replace(/\b(title|placeholder|aria-label|alt)=(["'])([^"']*?)\2/g, (m, attr, quote, value) => {
      const hit = lookup(value.replace(/&amp;/g, '&'));
      return hit === null ? m : `${attr}=${quote}${e(hit)}${quote}`;
    });
}

// ─── Site-level files ─────────────────────────────────────────────────────────

function rootPage() {
  const paths = pathsFor('home');
  const boot = `var L=${JSON.stringify(LANGS)},l='en';try{var v=localStorage.getItem('fo-lang');if(L.indexOf(v)>-1){l=v}else{var n=navigator.languages||[navigator.language||l];for(var i=0;i<n.length;i++){var c=String(n[i]).slice(0,2).toLowerCase();if(L.indexOf(c)>-1){l=c;break}}}}catch(e){}if(location.hash!=='#choose'){location.replace('/'+l+'/'+location.search+location.hash)}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="${e(csp([THEME_BOOT, boot]))}">
  <title>Files Online – PDF &amp; file tools · PDF- &amp; Datei-Tools · Narzędzia PDF · PDF nástroje</title>
  <meta name="description" content="${e(LANGS.map(l => content[l].home.short).join(' · '))}">
  <link rel="canonical" href="${SITE}/">
  ${LANGS.map(l => `<link rel="alternate" hreflang="${l}" href="${SITE}${paths[l]}">`).join('\n  ')}
  <link rel="alternate" hreflang="x-default" href="${SITE}/">
  <link rel="icon" href="/assets/icons/icon.svg" type="image/svg+xml">
  <script>${THEME_BOOT}</script>
  <link rel="stylesheet" href="${assetUrl('assets/css/site.css')}">
  <script>${boot}</script>
</head>
<body class="s-page">
  <main class="s-chooser">
    <div class="s-chooser__box">
      ${LOGO.replace('<svg', '<svg width="52" height="52"')}
      <h1>Files Online</h1>
      <p>Choose your language · Sprache wählen · Wybierz język · Vyberte jazyk</p>
      <ul>
        ${LANGS.map(l => `<li><a href="/${l}/" hreflang="${l}" lang="${l}" data-set-lang="${l}">${LANG_NAMES[l]}<small>${e(content[l].home.short)}</small></a></li>`).join('\n        ')}
      </ul>
    </div>
  </main>
  <script src="${assetUrl('assets/js/site.js')}" defer></script>
</body>
</html>
`;
}

function notFoundPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Page not found – Files Online</title>
  <link rel="icon" href="/assets/icons/icon.svg" type="image/svg+xml">
  <script>${THEME_BOOT}</script>
  <link rel="stylesheet" href="/assets/css/site.css">
</head>
<body class="s-page">
  <main class="s-chooser">
    <div class="s-chooser__box">
      ${LOGO.replace('<svg', '<svg width="52" height="52"')}
      <h1>404</h1>
      <p>Page not found · Seite nicht gefunden · Nie znaleziono strony · Stránka nenalezena</p>
      <ul>
        ${LANGS.map(l => `<li><a href="${pagePath('pdfTools', l)}" hreflang="${l}" lang="${l}">${e(content[l].nav.pdfTools)}<small>${LANG_NAMES[l]}</small></a></li>`).join('\n        ')}
      </ul>
    </div>
  </main>
</body>
</html>
`;
}

function redirectStub(target, title) {
  const url = `${SITE}${target}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${e(title)}</title>
  <link rel="canonical" href="${url}">
  <meta name="robots" content="noindex">
  <meta http-equiv="refresh" content="0; url=${target}">
  <script>location.replace(${JSON.stringify(target)}+location.search+location.hash)</script>
</head>
<body>
  <p><a href="${target}">${e(title)}</a></p>
</body>
</html>
`;
}

function sitemap() {
  const today = new Date().toISOString().slice(0, 10);
  const groups = [
    ...Object.keys(PAGES).map(pathsFor),
    ...TOOLS.map(toolPaths),
    ...LIVE_FEATURES.map(f => featurePaths(f.id)),
  ];
  const entries = [];
  for (const paths of groups) {
    const links = LANGS.map(l => `    <xhtml:link rel="alternate" hreflang="${l}" href="${SITE}${paths[l]}"/>`).join('\n');
    const xDefault = `    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE}${paths.en}"/>`;
    for (const lang of LANGS) {
      entries.push(`  <url>\n    <loc>${SITE}${paths[lang]}</loc>\n    <lastmod>${today}</lastmod>\n${links}\n${xDefault}\n  </url>`);
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries.join('\n')}
</urlset>
`;
}

function listFiles(dir, filter) {
  const out = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFiles(rel, filter));
    else if (filter(rel)) out.push(`/${rel}`);
  }
  return out;
}

function serviceWorker() {
  const shell = [
    '/',
    '/open/',
    '/manifest.webmanifest',
    '/assets/icons/icon.svg',
    ...listFiles('assets/css', () => true),
    ...listFiles('assets/fonts', () => true),
    ...listFiles('assets/i18n', () => true),
    ...listFiles('assets/js', f => !f.endsWith('tests.js')),
  ];
  const fingerprint = createHash('sha1');
  for (const f of shell.filter(f => f.startsWith('/assets'))) fingerprint.update(readFileSync(join(ROOT, f.slice(1))));
  return readFileSync(join(BUILD, 'service-worker.template.js'), 'utf8')
    .replace('__VERSION__', fingerprint.digest('hex').slice(0, 10))
    .replace('__SHELL_FILES__', JSON.stringify(shell, null, 2));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

for (const lang of LANGS) rmSync(join(ROOT, lang), { recursive: true, force: true });

// Dictionaries for the legacy apps, applied at runtime by assets/js/i18n-dom.js
for (const lang of Object.keys(appDict)) {
  write(`assets/i18n/app.${lang}.js`, `// Generated by build/build.mjs from build/content/app-strings.mjs\nwindow.__FO_DICT = ${JSON.stringify(appDict[lang])};\n`);
}

// Inspector dictionaries, written as ES modules so the tool can import them on demand
const inspectStrings = (await import('./content/inspect-strings.mjs')).default;
LANGS.filter(l => l !== 'en').forEach((lang, i) => {
  const dict = Object.fromEntries(inspectStrings.map(row => [row[0], row[i + 1]]));
  write(`assets/i18n/inspect.${lang}.js`, `// Generated by build/build.mjs from build/content/inspect-strings.mjs\nexport default ${JSON.stringify(dict)};\n`);
});

// Runtime URL table for "continue with" links, read by the PDF tools
for (const lang of LANGS) {
  const routes = Object.fromEntries(TOOLS.map(t => [t.id, { url: toolPath(t, lang), name: content[lang].tools[t.id].name }]));
  const c = content[lang];
  const pages = {
    fileManager: { url: pagePath('fileManager', lang), name: c.fileManagerPage.name },
    inspector: { url: pagePath('inspector', lang), name: c.inspectorPage.name },
    md: { url: pagePath('md', lang), name: c.mdPage.name },
    mbox: { url: pagePath('mbox', lang), name: c.mboxPage.name },
    pdfTools: { url: pagePath('pdfTools', lang), name: c.nav.allPdfTools },
  };
  write(`assets/i18n/routes.${lang}.js`, `// Generated by build/build.mjs\nexport default ${JSON.stringify(routes)};\nexport const pages = ${JSON.stringify(pages)};\n`);
}

let pages = 0;
for (const lang of LANGS) {
  write(`${lang}/index.html`, homePage(lang));
  write(`${lang}/${PAGES.pdfTools[lang]}/index.html`, hubPage(lang));
  for (const tool of TOOLS) write(`${lang}/${tool.slugs[lang]}/index.html`, toolPage(lang, tool));
  write(`${lang}/${PAGES.inspector[lang]}/index.html`, inspectorPage(lang));
  write(`${lang}/${PAGES.fileManager[lang]}/index.html`, fileManagerPage(lang));
  for (const f of LIVE_FEATURES) write(`${lang}/${featureCopy[lang][f.id].slug}/index.html`, featurePage(lang, f));
  write(`${lang}/${PAGES.md[lang]}/index.html`, viewerPage(lang, 'md', { fragment: 'md-app.html', css: 'assets/css/md-viewer.css', script: 'assets/js/md-viewer.js', bodyClass: 'mdv-page', legacyCss: false, windowed: true }));
  write(`${lang}/${PAGES.mbox[lang]}/index.html`, viewerPage(lang, 'mbox', { fragment: 'mbox-app.html', css: 'assets/css/mbox-viewer.css', script: 'assets/js/mbox/app.js', bodyClass: 'mbx-page' }));
  write(`${lang}/${PAGES.privacy[lang]}/index.html`, legalPage(lang, 'privacy'));
  write(`${lang}/${PAGES.imprint[lang]}/index.html`, legalPage(lang, 'imprint'));
  pages += TOOLS.length + 7 + LIVE_FEATURES.length;
}

write('index.html', rootPage());
write('404.html', notFoundPage());
write('open/index.html', `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="${e(csp([THEME_BOOT]))}">
  <meta name="robots" content="noindex">
  <title>Files Online</title>
  <link rel="icon" href="/assets/icons/icon.svg" type="image/svg+xml">
  <link rel="manifest" href="/manifest.webmanifest">
  <script>${THEME_BOOT}</script>
  <link rel="stylesheet" href="${assetUrl('assets/css/site.css')}">
</head>
<body class="s-page">
  <main class="s-chooser"><div class="s-chooser__box">${LOGO.replace('<svg', '<svg width="52" height="52"')}<h1>Files Online</h1><p>…</p></div></main>
  <script type="module" src="${assetUrl('assets/js/open.js')}"></script>
</body>
</html>
`);
write('sitemap.xml', sitemap());
write('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
write('service-worker.js', serviceWorker());

// Old URLs keep working
write('open-md-file/index.html', redirectStub(pagePath('md', 'en'), 'Open MD File Online'));
write('open-mbox-file/index.html', redirectStub(pagePath('mbox', 'en'), 'Open MBOX File Online'));
write('privacy.html', redirectStub(pagePath('privacy', 'en'), 'Privacy Policy'));
write('imprint.html', redirectStub(pagePath('imprint', 'en'), 'Imprint'));

console.log(`Built ${pages} pages in ${LANGS.length} languages (${TOOLS.length} PDF tools).`);
