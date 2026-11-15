/* KUSENBU QUEST 50 大会案内：保存した案内を圏外でも開けるようにする */
const CACHE='kq50-guide-v1';
self.addEventListener('install',e=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{
  const req=e.request;if(req.method!=='GET')return;
  const url=new URL(req.url);if(url.origin!==location.origin)return;
  const path=url.pathname.slice(url.pathname.lastIndexOf('/kusenbu50/')+'/kusenbu50/'.length)||'./';
  const key=req.mode==='navigate'?'index.html':path;
  if(path.startsWith('data/')){
    // 案内データ：通信できれば最新、だめなら保存した版
    e.respondWith(fetch(req).catch(async()=>{const r=await (await caches.open(CACHE)).match(key);if(!r)return Response.error();const h=new Headers(r.headers);h.set('X-Saved-Copy','1');return new Response(await r.blob(),{status:200,headers:h})}));
    return;
  }
  // ページと案内図：通信できれば最新、圏外は保存した版
  e.respondWith(fetch(req).catch(()=>caches.open(CACHE).then(c=>c.match(key)).then(r=>r||caches.open(CACHE).then(c=>c.match('./')))).then(r=>r||Response.error()));
});
