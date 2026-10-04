/* Service Worker – cho app chạy offline hoàn toàn sau lần mở đầu.
 * Đổi VER mỗi khi sửa file giao diện để máy tải bản mới.
 * Dữ liệu (data/data.json) nằm ở cache riêng "vgp-data"; app tự kiểm tra phiên bản mới khi có mạng. */
const VER = '1.2.0';
const SHELL = 'vgp-shell-' + VER;
const DATA = 'vgp-data';
const FILES = ['./', 'index.html', 'app.js', 'map.js', 'solver.js', 'solver.worker.js', 'manifest.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
const abs = p => new URL(p, self.registration.scope).href;
const DATA_URL = () => abs('data/data.json');

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await c.addAll(FILES.map(abs));
    // Cài/cập nhật dữ liệu cùng lúc với giao diện
    try {
      const r = await fetch(DATA_URL(), {cache: 'no-store'});
      if (r.ok) await (await caches.open(DATA)).put(DATA_URL(), r);
    } catch (err) { /* offline – giữ dữ liệu cũ */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('vgp-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // Kiểm tra phiên bản dữ liệu: luôn đi mạng
  if (url.searchParams.has('check')) return;
  if (url.href.split('?')[0] === DATA_URL()) {
    e.respondWith((async () => {
      const c = await caches.open(DATA);
      const hit = await c.match(DATA_URL());
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok) c.put(DATA_URL(), r.clone());
      return r;
    })());
    return;
  }
  e.respondWith((async () => {
    const c = await caches.open(SHELL);
    const key = req.mode === 'navigate' ? abs('index.html') : req;
    const hit = await c.match(key, {ignoreSearch: true});
    if (hit) return hit;
    try {
      const r = await fetch(req);
      if (r.ok && url.href.startsWith(self.registration.scope)) c.put(req, r.clone());
      return r;
    } catch (err) {
      return (await c.match(abs('index.html'))) || Response.error();
    }
  })());
});
