// Service Worker — オフラインキャッシュとローカル通知（仕様書 14章）

const CACHE_NAME = 'health-note-v2';
const CACHED_URLS = ['./', './app.js'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHED_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  // API リクエストはキャッシュしない（常に最新データを取得）
  if (event.request.url.includes('/api/')) return;

  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

// ローカル通知（記録リマインド）
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || '体調ノート', {
      body: data.body || '今日の体調を記録しましょう（10秒でOKです）',
      icon: '/static/icon.svg',
      badge: '/static/icon.svg',
      tag: 'daily-remind',
      renotify: false,
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow('/'));
});
