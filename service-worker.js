// Files Online — Service Worker
// Cache-first for app shell, network-first for CDN resources.

const CACHE_VERSION = 'v4';
const SHELL_CACHE = `files-online-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `files-online-runtime-${CACHE_VERSION}`;

const SHELL_FILES = [
  '/',
  '/index.html',
  '/imprint.html',
  '/privacy.html',
  '/assets/css/styles.css',
  '/assets/js/app.js',
  '/assets/js/state.js',
  '/assets/js/utils.js',
  '/assets/js/ui.js',
  '/assets/js/storage.js',
  '/assets/js/browser-support.js',
  '/assets/js/file-access.js',
  '/assets/js/folder-tree.js',
  '/assets/js/preview.js',
  '/assets/js/archives.js',
  '/assets/js/rename.js',
  '/assets/js/metadata.js',
  '/assets/js/recipes.js',
  '/assets/js/export.js',
  '/assets/js/theme.js',
  '/assets/js/tools.js',
  '/assets/js/command-palette.js',
  '/open-md-file/',
  '/open-md-file/index.html',
  '/assets/css/md-viewer.css',
  '/assets/js/md-viewer.js',
  '/manifest.webmanifest',
  '/assets/icons/icon.svg',
];

// Install: pre-cache app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_FILES.map(url => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
      .catch(err => {
        console.warn('[SW] Shell cache install partially failed:', err);
        return self.skipWaiting();
      })
  );
});

// Activate: clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// Fetch: route requests to appropriate strategy
self.addEventListener('fetch', event => {
  const { request } = event;

  // Only handle GET
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // CDN resources (vendor libraries): network-first, cache as fallback
  if (url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'cdnjs.cloudflare.com') {
    event.respondWith(networkFirstWithCache(request, RUNTIME_CACHE));
    return;
  }

  // Same-origin: cache-first
  if (url.origin === self.location.origin) {
    // For navigation requests always try network first so the latest HTML is served
    if (request.mode === 'navigate') {
      event.respondWith(networkFirstWithCache(request, SHELL_CACHE));
    } else {
      event.respondWith(cacheFirstWithNetwork(request, SHELL_CACHE));
    }
    return;
  }
});

async function cacheFirstWithNetwork(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Offline: for navigation return cached index.html
    if (request.mode === 'navigate') {
      const fallback = await caches.match('/index.html');
      if (fallback) return fallback;
    }
    throw err;
  }
}

async function networkFirstWithCache(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    // For navigation offline fallback
    if (request.mode === 'navigate') {
      const fallback = await caches.match('/index.html');
      if (fallback) return fallback;
    }
    throw err;
  }
}
