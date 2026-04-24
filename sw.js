// VLTRVIEW Service Worker v1.0
// Handles offline caching, background sync, and push notifications

const APP_VERSION = 'vltrview-v1.0.0';
const STATIC_CACHE = `${APP_VERSION}-static`;
const MAP_CACHE = `${APP_VERSION}-map-tiles`;
const DATA_CACHE = `${APP_VERSION}-data`;

// Files to cache immediately on install
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  // Google Fonts
  'https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap',
];

// ── INSTALL: pre-cache all static assets ──
self.addEventListener('install', event => {
  console.log('[VLTRVIEW SW] Installing v1.0.0...');
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => {
        console.log('[VLTRVIEW SW] Caching static assets');
        return cache.addAll(STATIC_ASSETS).catch(err => {
          console.warn('[VLTRVIEW SW] Some assets failed to cache (likely fonts):', err);
        });
      })
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: clean up old caches ──
self.addEventListener('activate', event => {
  console.log('[VLTRVIEW SW] Activating...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name.startsWith('vltrview-') && name !== STATIC_CACHE && name !== MAP_CACHE && name !== DATA_CACHE)
          .map(name => {
            console.log('[VLTRVIEW SW] Deleting old cache:', name);
            return caches.delete(name);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// ── FETCH: smart caching strategy ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Skip chrome-extension and other non-http requests
  if (!url.protocol.startsWith('http')) return;

  // STRATEGY 1: Map tiles (Nominatim geocoder) — network first, fall back to cache
  if (url.hostname.includes('nominatim') || url.hostname.includes('tile.openstreetmap')) {
    event.respondWith(networkFirstWithCache(event.request, MAP_CACHE, 60 * 60 * 24)); // 24hr cache
    return;
  }

  // STRATEGY 2: Google Fonts — cache first (they rarely change)
  if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(cacheFirstWithNetwork(event.request, STATIC_CACHE));
    return;
  }

  // STRATEGY 3: App shell (index.html, manifest) — cache first, background update
  if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/manifest.json') {
    event.respondWith(staleWhileRevalidate(event.request, STATIC_CACHE));
    return;
  }

  // STRATEGY 4: Icons and local assets — cache first
  if (url.pathname.startsWith('/icons/')) {
    event.respondWith(cacheFirstWithNetwork(event.request, STATIC_CACHE));
    return;
  }

  // STRATEGY 5: Everything else — network first with cache fallback
  event.respondWith(networkFirstWithCache(event.request, DATA_CACHE, 60 * 5)); // 5min cache
});

// ── CACHE STRATEGIES ──

async function cacheFirstWithNetwork(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return new Response('Offline — resource not cached', { status: 503 });
  }
}

async function networkFirstWithCache(request, cacheName, maxAge = 300) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cloned = response.clone();
      cache.put(request, cloned);
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) {
      console.log('[VLTRVIEW SW] Serving from cache (offline):', request.url);
      return cached;
    }
    // Return offline fallback page for navigation requests
    if (request.mode === 'navigate') {
      const fallback = await cache.match('/index.html');
      if (fallback) return fallback;
    }
    return new Response(JSON.stringify({ error: 'offline', cached: false }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  // Fetch fresh in background regardless
  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  // Return cached immediately if available, otherwise wait for network
  return cached || fetchPromise;
}

// ── BACKGROUND SYNC: queue work orders when offline ──
self.addEventListener('sync', event => {
  if (event.tag === 'sync-work-orders') {
    event.waitUntil(syncWorkOrders());
  }
  if (event.tag === 'sync-damage-reports') {
    event.waitUntil(syncDamageReports());
  }
  if (event.tag === 'sync-photos') {
    event.waitUntil(syncPhotos());
  }
});

async function syncWorkOrders() {
  console.log('[VLTRVIEW SW] Syncing work orders...');
  // In production: read from IndexedDB queue, POST to API
  // For now just notify the app
  const clients = await self.clients.matchAll();
  clients.forEach(client => client.postMessage({ type: 'SYNC_COMPLETE', feature: 'work-orders' }));
}

async function syncDamageReports() {
  console.log('[VLTRVIEW SW] Syncing damage reports...');
  const clients = await self.clients.matchAll();
  clients.forEach(client => client.postMessage({ type: 'SYNC_COMPLETE', feature: 'damage-reports' }));
}

async function syncPhotos() {
  console.log('[VLTRVIEW SW] Syncing field photos...');
  const clients = await self.clients.matchAll();
  clients.forEach(client => client.postMessage({ type: 'SYNC_COMPLETE', feature: 'photos' }));
}

// ── PUSH NOTIFICATIONS ──
self.addEventListener('push', event => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: 'VLTRVIEW Alert', body: event.data.text() };
  }

  const options = {
    body: data.body || 'You have a new notification',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-96.png',
    tag: data.tag || 'vltrview-notif',
    renotify: true,
    vibrate: [200, 100, 200],
    data: {
      url: data.url || '/index.html',
      assetId: data.assetId,
      woId: data.woId,
    },
    actions: data.actions || [
      { action: 'view', title: 'View', icon: '/icons/icon-96.png' },
      { action: 'dismiss', title: 'Dismiss' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'VLTRVIEW', options)
  );
});

// ── NOTIFICATION CLICK ──
self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const targetUrl = event.notification.data?.url || '/index.html';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        // Focus existing window if open
        for (const client of clients) {
          if (client.url.includes('/index.html') && 'focus' in client) {
            return client.focus();
          }
        }
        // Otherwise open new window
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
      })
  );
});

// ── MESSAGE HANDLER: communicate with app ──
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data === 'GET_VERSION') {
    event.ports[0].postMessage({ version: APP_VERSION });
  }
  if (event.data?.type === 'CACHE_TILES') {
    // Pre-cache a set of map tiles for offline use
    cacheTiles(event.data.tiles);
  }
});

async function cacheTiles(tiles = []) {
  const cache = await caches.open(MAP_CACHE);
  let cached = 0;
  for (const url of tiles) {
    try {
      const response = await fetch(url);
      if (response.ok) { await cache.put(url, response); cached++; }
    } catch { /* skip failed tiles */ }
  }
  const clients = await self.clients.matchAll();
  clients.forEach(c => c.postMessage({ type: 'TILES_CACHED', count: cached, total: tiles.length }));
}
