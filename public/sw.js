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

/*
 * Bill reminders.
 *
 * The push that wakes this worker carries no payload at all. That is the whole
 * point: the server is told when to wake the device and nothing else, so it
 * never holds a bill name or an amount. The text lives in IndexedDB, written
 * by the app on this device, and is read back here.
 *
 * The database is opened by hand rather than through the app's own module
 * because a worker cannot import the bundle. The schema is one store keyed by
 * id, which keeps both readers short — see src/lib/push/store.ts.
 */

const REMINDER_DB = 'cashcompass-reminders';
const REMINDER_STORE = 'reminders';

function readReminders() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    try {
      const request = indexedDB.open(REMINDER_DB, 1);
      // If the app has never written reminders the store will not exist, and
      // creating it here would be a lie. Resolve empty instead.
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(REMINDER_STORE)) {
          db.createObjectStore(REMINDER_STORE, { keyPath: 'id' });
        }
      };
      request.onerror = () => done([]);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(REMINDER_STORE)) return done([]);
        const all = db.transaction(REMINDER_STORE, 'readonly').objectStore(REMINDER_STORE).getAll();
        all.onsuccess = () => {
          done(all.result || []);
          db.close();
        };
        all.onerror = () => {
          done([]);
          db.close();
        };
      };
    } catch {
      done([]);
    }
  });
}

self.addEventListener('push', (event) => {
  event.waitUntil(
    readReminders().then((reminders) => {
      const now = Date.now();
      // The wake is scheduled for a moment, not for a record, so pick the
      // reminder that moment belongs to: the most recent one now due. A window
      // rather than an exact match, because the server's tick and the device's
      // clock will never agree to the millisecond.
      const due = reminders
        .filter((reminder) => reminder.fireAt <= now + 60_000)
        .sort((a, b) => b.fireAt - a.fireAt)[0];

      // userVisibleOnly is a promise to the browser that every push shows
      // something. Breaking it costs the subscription, so a wake with nothing
      // to say still says something true.
      const title = due ? due.title : 'CashCompass';
      const body = due ? due.body : 'Open CashCompass to see what is due.';

      return self.registration.showNotification(title, {
        body,
        tag: due ? due.id : 'cashcompass-bills',
        badge: new URL('./icon-192.png', self.location).href,
        icon: new URL('./icon-192.png', self.location).href,
        data: { url: new URL('./', self.location).href },
        renotify: false,
      });
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || SHELL;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus an open copy rather than opening a second one. Two tabs of a
      // finance app writing to the same storage is a way to lose an entry.
      for (const client of clients) {
        if (client.url.startsWith(target) && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow ? self.clients.openWindow(target) : undefined;
    }),
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
