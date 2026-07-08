/* Browser Copilot AI — service worker for offline use.
   Network-first for the app shell (so updates arrive immediately),
   cache fallback when offline. No requests are made beyond the app's
   own files; user-configured external AI calls are never intercepted. */
const CACHE = 'browser-copilot-v2';
const ASSETS = ['./', './index.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // Only handle same-origin GETs (never intercept user-configured external AI calls).
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then((resp) => {
      const copy = resp.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return resp;
    }).catch(() =>
      caches.match(e.request).then((hit) => hit || caches.match('./index.html'))
    )
  );
});
