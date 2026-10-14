/* Keeps the till's pages on the device so the app still opens when the shop server cannot be reached.
 * Pages and scripts: the network first (so a change at the shop shows at once), the saved copy when the network fails or is slow.
 * Shop data (anything under /api/) is never saved here: the page keeps its own copy of the few things a till needs. */
const V = 'cakepos-__VERSION__';
const PRE = __PRECACHE__;
const WAIT_MS = 4000;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(V)
      .then((c) => Promise.all(PRE.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => undefined))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((ks) => Promise.all(ks.filter((k) => k.startsWith('cakepos-') && k !== V).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const r = e.request;
  const u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== self.location.origin || u.pathname.startsWith('/api/') || u.pathname === '/sw.js') return;
  e.respondWith(
    (async () => {
      const c = await caches.open(V);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), WAIT_MS);
      try {
        const res = await fetch(r, { signal: ctl.signal });
        clearTimeout(timer);
        if (res.ok && res.type === 'basic') c.put(u.pathname, res.clone());
        return res;
      } catch (err) {
        clearTimeout(timer);
        const hit = await c.match(u.pathname);
        if (hit) return hit;
        if (r.mode === 'navigate') {
          const home = await c.match('/');
          if (home) return home;
        }
        throw err;
      }
    })(),
  );
});
