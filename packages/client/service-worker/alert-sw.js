/*
 * Reference service worker for Cake POS phone notifications. Copy it to the root of your UI's public folder so it is
 * served from /alert-sw.js (it must sit at the root to receive notifications for the whole app).
 *
 * It does two things:
 *  - when the shop server sends a notification, show it, even if the app is closed;
 *  - when the notification is tapped, open the app (or bring it to the front) on the right screen.
 *
 * The sound is the phone's own notification sound. Browsers do not let a page choose it.
 */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Cake POS', body: event.data ? event.data.text() : '' };
  }
  const critical = data.severity === 'critical';
  event.waitUntil(
    self.registration.showNotification(data.title || 'Cake POS', {
      body: data.body || '',
      tag: data.tag || undefined,
      renotify: !!data.tag,
      requireInteraction: critical,
      vibrate: critical ? [600, 200, 600, 200, 600] : [200, 100, 200],
      data: { screen: data.screen || 'alerts', alertId: data.alertId || null },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const screen = (event.notification.data && event.notification.data.screen) || 'alerts';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if ('focus' in w) {
          w.postMessage({ type: 'open-screen', screen });
          return w.focus();
        }
      }
      return self.clients.openWindow('/?screen=' + encodeURIComponent(screen));
    }),
  );
});
