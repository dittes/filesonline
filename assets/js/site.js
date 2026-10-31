// site.js
// Small behaviours shared by all generated pages: theme toggle, menus, service worker.
// Pages that run a legacy app wire the theme toggle through theme.js instead.

const root = document.documentElement;

if (!document.currentScript?.dataset.noTheme) {
  document.querySelectorAll('[data-action="toggle-theme"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('fo-theme', next); } catch { /* private mode */ }
    });
  });
}

// Close open menus on outside click and Escape
const menus = [...document.querySelectorAll('.s-menu, .s-lang')];
document.addEventListener('click', e => {
  menus.forEach(m => { if (m.open && !m.contains(e.target)) m.open = false; });
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  menus.forEach(m => { if (m.open) { m.open = false; m.querySelector('summary').focus(); } });
});
menus.forEach(m => m.addEventListener('toggle', () => {
  if (m.open) menus.forEach(other => { if (other !== m) other.open = false; });
}));

const burger = document.querySelector('.s-burger');
const nav = document.querySelector('.s-nav');
burger?.addEventListener('click', () => {
  const open = nav.classList.toggle('is-open');
  burger.setAttribute('aria-expanded', String(open));
});

// Remember an explicit language choice for the root page
document.querySelectorAll('[data-set-lang]').forEach(a => {
  a.addEventListener('click', () => {
    try { localStorage.setItem('fo-lang', a.dataset.setLang); } catch { /* private mode */ }
  });
});

if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  });
}
