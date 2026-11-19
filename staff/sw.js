/* スタッフ用「今日の担当」：ページ本体を保存し、圏外でも開けるようにする。
   通信できるときはいつも最新のページを取り直す（担当のデータは端末の保存版とは別に、本部から読む） */
const CACHE = 'staff-e96ab5c';
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.add(new Request('./', { cache: 'reload' }))).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('staff-') && k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url); if (url.origin !== location.origin) return;
  if (req.mode !== 'navigate') return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try { const r = await fetch(req, { cache: 'no-store' }); if (r.ok) c.put('./', r.clone()); return r; }
    catch (err) { return (await c.match('./')) || new Response('圏外のため読み込めません', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }); }
  })());
});
