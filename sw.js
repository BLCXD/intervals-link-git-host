self.addEventListener('install', function(e) { self.skipWaiting(); });
self.addEventListener('activate', function(e) { e.waitUntil(clients.claim()); });

self.addEventListener('push', function(e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch(err) {
    data = { title: 'intervals.icu', body: e.data ? e.data.text() : '' };
  }
  e.waitUntil(self.registration.showNotification(data.title || 'intervals.icu', {
    body: data.body || '',
    tag: data.tag || 'intervals-' + Date.now(),
    icon: '/intervals-link-git-host/icon.png',
    badge: '/intervals-link-git-host/icon.png',
    vibrate: [200, 100, 200],
    requireInteraction: false,
    data: { url: 'https://intervals.icu' }
  }));
});

self.addEventListener('message', function(e) {
  if (!e.data || e.data.type !== 'NOTIFY') return;
  var d = e.data.payload;
  self.registration.showNotification(d.title, {
    body: d.body || '',
    tag: d.id || 'notif',
    data: { url: 'https://intervals.icu' }
  });
});

self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(cls) {
    if (cls.length) { cls[0].focus(); return; }
    return clients.openWindow('https://intervals.icu');
  }));
});
