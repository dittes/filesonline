// theme.js
// Light / dark theme management. The <head> boot script applies the initial
// theme before first paint; this module owns everything after that.

const STORAGE_KEY = 'fo-theme';
const META_COLORS = { light: '#1B4FD8', dark: '#101013' };

/**
 * Return the currently applied theme.
 * @returns {'light'|'dark'}
 */
export function getTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/**
 * Apply a theme and persist the explicit choice.
 * @param {'light'|'dark'} theme
 * @param {boolean} [persist]
 */
export function setTheme(theme, persist = true) {
  document.documentElement.setAttribute('data-theme', theme);
  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* private mode */ }
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', META_COLORS[theme] || META_COLORS.light);
}

/** Toggle between light and dark. */
export function toggleTheme() {
  setTheme(getTheme() === 'dark' ? 'light' : 'dark');
}

/**
 * Wire up all [data-action="toggle-theme"] buttons and follow OS preference
 * while the user has not made an explicit choice.
 */
export function initTheme() {
  // Sync meta theme-color with whatever the boot script applied
  setTheme(getTheme(), false);

  document.querySelectorAll('[data-action="toggle-theme"]').forEach(btn => {
    btn.addEventListener('click', toggleTheme);
  });

  // Follow OS changes only when no explicit preference is stored
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const followOS = e => {
    let stored = null;
    try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* ignore */ }
    if (!stored) setTheme(e.matches ? 'dark' : 'light', false);
  };
  if (mq.addEventListener) mq.addEventListener('change', followOS);
}
