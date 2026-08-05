// Mobile readiness (Change 002) §14.9A: installable PWA. This app is a live
// Socket.io session with no meaningful offline mode — the goal here isn't
// "works offline," just faster reloads and an app-shell fallback on a flaky
// mobile connection. Never touch /api/* or /socket.io/* (always live data);
// only static build assets and the shell get cached.
const CACHE_VERSION = 'custom-vtt-v1';
const SHELL_URLS = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;

  // Navigations: network-first, falling back to the cached shell so a
  // reload while offline/reconnecting shows the app instead of a browser
  // error page. The app's own ConnectionBanner + useSocketRefresh take it
  // from there once the socket reconnects.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/'))
    );
    return;
  }

  // Hashed Vite build assets never go stale under a new filename, so
  // cache-first is safe; anything not yet cached is fetched and stored.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
            return response;
          })
      )
    );
  }
});
