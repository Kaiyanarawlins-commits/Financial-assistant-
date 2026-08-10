/*
 * Offline support for CashCompass.
 *
 * The app is a static bundle with no backend, so "works offline" only needs the
 * shell and its assets cached. Two strategies, matched to what the requests are:
 *
 *   navigations — network first, falling back to the cached shell. A user with
 *     signal gets the newest deploy; a user on the subway still gets the app.
 *   everything else — cache first. Vite fingerprints asset filenames, so a
 *     cached hit is immutable by construction and can never be stale.
 *
 * PRECACHE and VERSION are rewritten by `scripts/precache.mjs` after each build.
 * Precaching the real asset list at install is load-bearing rather than an
 * optimisation: the very first page load happens *before* this worker controls
 * the page, so its JS and CSS never pass through the fetch handler. Caching only
 * the HTML would produce a shell that boots offline and then fails to find its
 * own bundle — an app that looks installed and is broken.
 */

const VERSION = '__BUILD_VERSION__';
const PRECACHE = __PRECACHE_MANIFEST__;
const CACHE = `cashcompass-${VERSION}`;

// Resolve against the worker's own location so this behaves identically at a
// domain root and under a project subpath (GitHub Pages).
const SHELL = new URL('./', self.location).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        // Individually, not addAll: one 404 in the list would reject the whole
        // batch and leave the app with no offline support at all.
        Promise.all(
          [SHELL, ...PRECACHE].map((path) =>
            cache.add(new Request(new URL(path, self.location).href, { cache: 'reload' })).catch(() => undefined),
          ),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(SHELL, copy));
          return response;
        })
        .catch(() => caches.match(SHELL).then((hit) => hit ?? new Response('Offline', { status: 503 }))),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request)
          .then((response) => {
            if (response.ok && response.type === 'basic') {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => new Response('', { status: 504 })),
    ),
  );
});
