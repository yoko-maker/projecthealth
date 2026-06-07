// 旧キャッシュをすべて削除して自己解除するSW
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.registration.unregister())
      .then(() => clients.matchAll({ type: 'window' }))
      .then(cs => cs.forEach(c => c.navigate(c.url)))
  );
});
