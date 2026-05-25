// sw.js — Service Worker SIABSEN Offline
const CACHE_NAME = 'siabsen-v1';
const OFFLINE_QUEUE_KEY = 'siabsen_offline_queue';

// File yang di-cache agar bisa dibuka saat offline
const CACHE_URLS = [
  '/scan',
  '/scan.html',
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js'
];

// ── INSTALL: cache semua aset penting ──────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return Promise.allSettled(
        CACHE_URLS.map(url => cache.add(url).catch(() => {}))
      );
    }).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: hapus cache lama ─────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── FETCH: intercept request ───────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Jangan intercept request API scan (biarkan langsung ke server)
  // Kita handle offline di sisi halaman, bukan di sini
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(
          JSON.stringify({ success: false, offline: true, message: 'Tidak ada koneksi internet' }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  // Untuk halaman & aset: Network first, fallback ke cache
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Simpan ke cache jika berhasil
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// ── BACKGROUND SYNC: kirim antrian saat online ─────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-absensi') {
    event.waitUntil(syncOfflineQueue());
  }
});

// ── MESSAGE: terima perintah dari halaman ──────────────────────
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SYNC_NOW') {
    syncOfflineQueue().then(() => {
      self.clients.matchAll().then(clients => {
        clients.forEach(client => client.postMessage({ type: 'SYNC_DONE' }));
      });
    });
  }
});

async function syncOfflineQueue() {
  // Ambil semua client untuk akses IndexedDB via message
  const clients = await self.clients.matchAll();
  if (clients.length === 0) return;

  // Kirim perintah sync ke halaman aktif
  clients.forEach(client => client.postMessage({ type: 'DO_SYNC' }));
}
