/* ── Crafty Planner Service Worker ── */
const CACHE_NAME = 'crafty-planner-v3';
const STATIC_ASSETS = [
  './manifest.json',
  './android-icon-192.png',
  './android-icon-512.png',
  './apple-icon-180.png',
  'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=DM+Sans:wght@400;500;600;700&display=swap'
];

/* ── Install: cache static assets (not index.html) ── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

/* ── Activate: clear old caches immediately ── */
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

/* ── Fetch strategy ── */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and chrome-extension requests
  if (request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  // Skip Firebase requests — always go to network
  if (url.hostname.includes('firebase') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('gstatic.com') && !url.hostname.includes('fonts')) {
    return;
  }

  // Google Fonts — cache first (they never change)
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

  // index.html — NETWORK FIRST so updates deploy immediately
  if (url.origin === self.location.origin &&
      (url.pathname.endsWith('/') ||
       url.pathname.endsWith('index.html') ||
       url.pathname === '/Crafty-Planner/' ||
       url.pathname === '/Crafty-Planner/index.html')) {
    event.respondWith(
      fetch(request)
        .then(response => {
          // Cache the fresh version
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          // Offline fallback — serve cached version
          return caches.match(request);
        })
    );
    return;
  }

  // Other local assets (icons etc) — cache first, network fallback
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Everything else — network only
  event.respondWith(fetch(request).catch(() => caches.match('./index.html')));
});

/* ── Background Sync placeholder ── */
self.addEventListener('sync', event => {
  if (event.tag === 'sync-orders') {
    console.log('[SW] Background sync: orders');
  }
});

/* ── Push Notifications placeholder ── */
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
