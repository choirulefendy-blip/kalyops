// Kaly Ops 2.4 · service worker khusus notifikasi di perangkat.
// Tidak menyimpan halaman di cache: Kaly Ops tetap selalu memuat versi terbaru dari Netlify.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const ua = self.navigator.userAgent || '';
// Safari (iPhone/iPad/Mac) mewajibkan setiap Web Push menampilkan notifikasi
const strict = /AppleWebKit/.test(ua) && !/Chrome\/|Chromium\/|CriOS|Edg\//.test(ua);

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Kaly Ops', body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Kaly Ops sedang terbuka di layar perangkat ini: kartu notifikasi di aplikasi sudah tampil
    if (!strict && d.kind !== 'push_test' && wins.some((w) => w.visibilityState === 'visible' && w.focused)) return;
    await self.registration.showNotification(d.title || 'Kaly Ops', {
      body: d.body || '', tag: d.tag || 'kaly', data: { url: d.url || '#/' }, lang: 'id',
      icon: 'assets/icon-192.png', badge: 'assets/notify-badge.png', timestamp: Date.now(),
      requireInteraction: d.kind === 'fraud',
    });
  })());
});

// Ketuk notifikasi: buka halaman terkait di jendela Kaly Ops yang sudah ada, atau buka jendela baru
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const hash = String(e.notification.data?.url || '#/');
  const target = new URL('./' + (hash.startsWith('#') ? hash : '#/'), self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const w = wins.find((c) => c.url.startsWith(self.registration.scope));
    if (w) {
      try { await w.focus(); } catch {}
      w.postMessage({ type: 'kaly-open', hash });
      return;
    }
    await self.clients.openWindow(target);
  })());
});
