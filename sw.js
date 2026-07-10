// sw.js — Service Worker SIABSEN Offline
const CACHE_NAME = 'siabsen-v3';

const CACHE_URLS = [
  '/scan.html',
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js'
];

// ── INSTALL ────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.allSettled(CACHE_URLS.map(u => cache.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ───────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── FETCH ──────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Biarkan request API & ping lewat langsung — jangan diintersep
  if (url.pathname.startsWith('/api/')) return;

  // Biarkan halaman riwayat lewat langsung — JANGAN pernah di-cache.
  // Halaman ini isinya spesifik per-token/siswa dan selalu butuh data
  // live dari server; kalau di-cache, siswa lain (atau scan berikutnya)
  // bisa melihat riwayat basi/salah saat sinyal jelek.
  if (url.pathname.startsWith('/riwayat')) return;

  // Sama alasannya dengan /riwayat di atas: halaman dashboard kepsek juga
  // selalu butuh data live (kehadiran siswa, piket, status mengajar
  // real-time) — JANGAN pernah di-cache, supaya kepsek tidak melihat
  // data basi saat sinyal jelek.
  if (url.pathname.startsWith('/monitor')) return;

  // Biarkan request non-GET lewat langsung
  if (event.request.method !== 'GET') return;

  // Biarkan request ke domain lain (Supabase, dll) lewat langsung
  if (url.origin !== self.location.origin &&
      !url.href.startsWith('https://cdn.jsdelivr.net')) return;

  // Network first, fallback ke cache, fallback ke offline response
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        // Tidak ada di cache — kembalikan response kosong yang valid
        return new Response('', { status: 503, statusText: 'Offline' });
      })
  );
});

// ── MESSAGE dari halaman ───────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SYNC_NOW') {
    self.clients.matchAll().then(clients => {
      clients.forEach(c => c.postMessage({ type: 'DO_SYNC' }));
    });
  }
});
