/* ── Crafty Planner Service Worker ── */
const CACHE_NAME = 'crafty-planner-v1';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './android-icon-192.png',
  './android-icon-512.png',
  './apple-icon-180.png',
  'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=DM+Sans:wght@400;500;600;700&display=swap'
];

/* ── Install: cache all static assets ── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

/* ── Activate: clear old caches ── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

/* ── Fetch: cache-first for assets, network-first for everything else ── */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and chrome-extension requests
  if (request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  // Google Fonts — cache first, fallback to network
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          return response;
        });
      })
    );
    return;
  }

  // App shell (index.html + local assets) — cache first, network fallback
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then(cached => {
        const networkFetch = fetch(request).then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          }
          return response;
        }).catch(() => cached); // If network fails, return whatever cache has

        // Return cache immediately, update in background (stale-while-revalidate)
        return cached || networkFetch;
      })
    );
    return;
  }

  // Everything else — network only
  event.respondWith(fetch(request).catch(() => caches.match('./index.html')));
});

/* ── Background Sync placeholder (future: sync orders when back online) ── */
self.addEventListener('sync', event => {
  if (event.tag === 'sync-orders') {
    // Reserved for future cloud sync feature
    console.log('[SW] Background sync: orders');
  }
});

/* ── Push Notifications placeholder (future: due date reminders) ── */
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Crafty Planner';
  const options = {
    body: data.body || 'You have an update.',
    icon: './android-icon-192.png',
    badge: './android-icon-48.png',
    vibrate: [200, 100, 200],
    data: { url: data.url || './' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data.url || './')
  );
});
