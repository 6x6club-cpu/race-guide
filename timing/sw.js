/* 計測端末：一度保存すれば、圏外・機内モードでもページを開き直せる。
   版ごとに保存し直す（版が変わっても、計測中に勝手には切り替えない：画面の「更新する」で切り替え） */
const CACHE = 'timing-02754a1';
const FILES = ['./', 'index.html', 'term.js', 'common.js', 'hq.html', 'hq.js', 'manifest.json', 'icon-192.png', 'icon-512.png',
  'vendor/firebase.js', 'vendor/jsqr.js', 'vendor/qrcode.js', 'events/index.json', 'events/test-kq50.json', 'events/kq50-2026.json'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))));
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('timing-') && k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url); if (url.origin !== location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    let hit = await c.match(req, { ignoreSearch: true });
    if (!hit && req.mode === 'navigate') hit = await c.match(url.pathname.endsWith('hq.html') ? 'hq.html' : 'index.html');
    if (hit) return hit;
    try { return await fetch(req); } catch (err) { return new Response('圏外のため読み込めません', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }); }
  })());
});
