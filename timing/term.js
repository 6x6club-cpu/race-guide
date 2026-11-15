/* 計測端末：読んだら必ず端末に保存 → 通信できるときに本部（Firebase）へ送る */
import { $, $$, esc, hms, BUILD, EVENT_ID, addRecord, allRecords, updateRecord, metaGet, metaSet, deviceId,
  toCSV, saveFile, onUser, login, logout, sendRecord, errText } from './common.js';

const S = { ev: null, pt: 'G1', recs: [], user: null, userKnown: false, dev: '', cam: null, last: null, sending: false, sendErr: '', swReady: false, swUpdate: null, msg: '' };
const ptLabel = k => ((S.ev && S.ev.points.find(p => p.k === k)) || { label: k }).label;

/* ---------- 音と画面の合図（圏外でも鳴る） ---------- */
let ac = null;
function beep(ok) {
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(), g = ac.createGain(); o.connect(g); g.connect(ac.destination);
    o.frequency.value = ok ? 1760 : 440; g.gain.value = .25; o.start(); o.stop(ac.currentTime + (ok ? .12 : .5));
  } catch (e) {}
  const f = $('#flash'); f.className = ok ? 'ok' : 'w'; setTimeout(() => f.className = '', 60);
  if (navigator.vibrate) navigator.vibrate(ok ? 60 : [80, 60, 80]);
}

/* ---------- 記録 ---------- */
function bibOf(raw) { const m = String(raw).match(/\d{1,5}/); return m ? String(+m[0]) : null; }
async function record(raw, how) {
  const bib = bibOf(raw);
  if (!bib) { S.msg = `番号を読み取れませんでした（${esc(String(raw).slice(0, 40))}）`; beep(false); render(); return; }
  const warn = [];
  if (S.ev && !S.ev.bibs.includes(+bib)) warn.push('名簿にない番号');
  const prev = S.recs.filter(r => r.bib === bib && r.pt === S.pt && !r.void);
  if (prev.length) warn.push(`この地点で記録済み（${prev.map(r => hms(r.t)).join('、')}）`);
  const t = new Date().toISOString();
  let rec;
  try { rec = await addRecord({ bib, pt: S.pt, t, how, raw: String(raw).slice(0, 200), warn }); }
  catch (e) { S.msg = '端末に保存できませんでした：' + errText(e) + '。番号と時刻を紙に控えてください'; beep(false); render(); return; }
  S.recs.push(rec); S.last = rec.id; S.msg = '';
  beep(!warn.length); render(); sync();
}

/* ---------- 本部へ送る ---------- */
async function sync() {
  if (S.sending || !navigator.onLine || !S.user) return;
  const todo = S.recs.filter(r => r.status !== 'received');
  if (!todo.length) { S.sendErr = ''; return; }
  S.sending = true; renderCounts();
  try {
    for (const r of todo) {
      const res = await sendRecord(r);
      const nx = await updateRecord(r.id, { status: 'received', receivedAt: res.receivedAt, already: res.already });
      Object.assign(r, nx); S.sendErr = ''; renderList(); renderLast(); renderCounts();
    }
  } catch (e) { S.sendErr = errText(e); }
  S.sending = false; render();
}

/* ---------- カメラ ---------- */
async function camOn() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    const det = ('BarcodeDetector' in window) ? new BarcodeDetector({ formats: ['qr_code'] }) : null;
    S.cam = { stream, det, last: '', lastT: 0 }; render();
    const v = $('#cv'); v.srcObject = stream; await v.play().catch(() => {});
    const c = document.createElement('canvas'), g = c.getContext('2d', { willReadFrequently: true });
    S.cam.timer = setInterval(async () => {
      const v = $('#cv'); if (!v || !v.videoWidth || !S.cam) return; let raw = null;
      try {
        if (det) { const r = await det.detect(v); raw = r[0] && r[0].rawValue; }
        else { const w = 640, h = Math.round(v.videoHeight * w / v.videoWidth); c.width = w; c.height = h; g.drawImage(v, 0, 0, w, h); const r = jsQR(g.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' }); raw = r && r.data; }
      } catch (e) {}
      // 同じQRを続けて読んだときは5秒間は記録しない（写り続けによる二重記録を防ぐ）
      if (raw && !(raw === S.cam.last && Date.now() - S.cam.lastT < 5000)) { S.cam.last = raw; S.cam.lastT = Date.now(); record(raw, 'カメラ'); }
      else if (raw) S.cam.lastT = Date.now();
    }, 250);
  } catch (e) { S.msg = 'カメラを使えませんでした（' + esc(e.name || e) + '）。番号を入力して記録してください'; render(); }
}
function camOff() { if (!S.cam) return; clearInterval(S.cam.timer); S.cam.stream.getTracks().forEach(t => t.stop()); S.cam = null; render(); }

/* ---------- 圏外で起動できるようにする（Service Worker） ---------- */
async function swInstall() {
  const m = $('#swMsg');
  try {
    if (!('serviceWorker' in navigator)) throw new Error('このブラウザは対応していません');
    if (m) m.textContent = '保存しています…';
    const reg = await navigator.serviceWorker.register('sw.js'); await navigator.serviceWorker.ready;
    if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch (e) {} }
    await swCheck(); if (!S.swReady) throw new Error('保存を確認できませんでした。もう一度押してください');
    watchUpdate(reg);
  } catch (e) { if (m) m.innerHTML = `<span class="err">${esc(errText(e))}</span>`; return; }
  render();
}
async function swCheck() {
  try { S.swReady = !!(navigator.serviceWorker && navigator.serviceWorker.controller) && (await caches.keys()).includes(BUILD.cache || 'timing-dev'); }
  catch (e) { S.swReady = false; }
}
function watchUpdate(reg) {
  const upd = () => { if (reg.waiting && navigator.serviceWorker.controller) { S.swUpdate = reg.waiting; render(); } };
  upd(); reg.addEventListener('updatefound', () => { const w = reg.installing; if (w) w.addEventListener('statechange', () => { if (w.state === 'installed') upd(); }); });
}

/* ---------- 画面 ---------- */
function render() {
  const unsent = S.recs.filter(r => r.status !== 'received').length;
  $('#ev').textContent = S.ev ? `${S.ev.name}　端末 ${S.dev}` : '大会データを読めません';
  $('#net').className = 'pill ' + (navigator.onLine ? 'on' : 'off'); $('#net').textContent = navigator.onLine ? '通信あり' : '圏外';
  $('#who').className = 'pill ' + (S.user ? 'on' : 'mid'); $('#who').textContent = S.user ? (S.user.email || 'ログイン済み') : (S.userKnown ? '未ログイン' : 'ログイン確認中');
  $('#off').className = 'pill ' + (S.swReady ? 'on' : 'mid'); $('#off').textContent = S.swReady ? '圏外で起動できます' : '圏外の準備がまだ';
  const prep = !S.swReady || !S.user;
  $('#main').innerHTML = `
  ${S.swUpdate ? `<div class="card"><b>新しい版があります。</b><div class="sub">計測の合間に、通信できる場所で更新してください。記録は消えません。</div><button class="btn wide" id="doUpd" style="margin-top:8px">更新する</button></div>` : ''}
  <details class="card" ${prep ? 'open' : ''} data-k="prep"><summary>準備（通信できるときに）${prep ? '' : '　✓ 完了'}</summary>
    <div style="margin-top:8px"><b>1. 圏外で起動できるようにする</b>
      <div class="sub" id="swMsg">${S.swReady ? `この端末に保存済みです（${esc(BUILD.text)}）。機内モードでもこのページを開き直せます。` : '通信できる場所で押してください。ホーム画面に追加して、そこから開くとより確実です。'}</div>
      <button class="btn ${S.swReady ? 'sec' : ''} wide" id="doSW" style="margin-top:6px">${S.swReady ? 'もう一度保存する' : '圏外で使えるように保存'}</button></div>
    <div style="margin-top:12px"><b>2. Googleでログイン（本部に送るため）</b>
      <div class="sub">${S.user ? `ログイン中：${esc(S.user.email)}。圏外で開き直してもログインは保たれます。` : '記録は、ログインしていなくても端末に保存されます。送るときにログインが必要です。'}</div>
      ${S.user ? `<button class="btn sec wide" id="doOut" style="margin-top:6px">ログアウト</button>` : `<button class="btn wide" id="doIn" style="margin-top:6px" ${navigator.onLine ? '' : 'disabled'}>Googleでログイン</button>`}
      <div class="err" id="inMsg"></div></div>
  </details>
  <div class="card"><h3>いま記録する地点</h3><div class="pts">${(S.ev ? S.ev.points : []).map(p => `<button class="pt ${S.pt === p.k ? 'sel' : ''}" data-pt="${p.k}">${esc(p.label)}<small>${esc(p.sub || '')}</small></button>`).join('')}</div>
    <div class="cam ${S.cam ? 'show' : ''}"><video id="cv" playsinline muted></video><div class="lbl">${esc(ptLabel(S.pt))}</div></div>
    <div class="row"><button class="btn ${S.cam ? 'sec' : ''}" id="doCam">${S.cam ? 'カメラを止める' : 'QRを読む'}</button>
      <input id="bib" inputmode="numeric" pattern="[0-9]*" placeholder="番号" autocomplete="off"><button class="btn" id="doRec">記録</button></div>
    ${S.msg ? `<div class="warn">${S.msg}</div>` : ''}</div>
  <div id="lastBox"></div>
  <div class="card"><div class="counts" id="counts"></div>
    <div class="row"><button class="btn wide" id="doSend" ${navigator.onLine && S.user && unsent && !S.sending ? '' : 'disabled'}>${S.sending ? '送信中…' : '本部に送る'}</button></div>
    <div class="sub" id="sendMsg" style="margin-top:6px"></div>
    <div class="row"><button class="btn sec wide" id="doCSV" ${S.recs.length ? '' : 'disabled'}>CSVを書き出す（圏外でも可）</button></div></div>
  <div class="card"><h3>この端末の記録（新しい順）</h3><div id="list"></div></div>`;
  renderLast(); renderCounts(); renderList();
  $$('[data-pt]').forEach(b => b.onclick = async () => { S.pt = b.dataset.pt; await metaSet('pt', S.pt); render(); });
  $('#doCam').onclick = () => S.cam ? camOff() : camOn();
  const go = async () => { const v = $('#bib').value.trim(); if (v) { $('#bib').value = ''; await record(v, '手入力'); const i = $('#bib'); if (i) i.focus(); } };
  $('#doRec').onclick = go; $('#bib').onkeydown = e => { if (e.key === 'Enter') go(); };
  $('#doSend').onclick = () => sync();
  $('#doCSV').onclick = exportCSV;
  $('#doSW').onclick = swInstall;
  const di = $('#doIn'); if (di) di.onclick = async () => { try { await login(); } catch (e) { $('#inMsg').textContent = errText(e); } };
  const dout = $('#doOut'); if (dout) dout.onclick = () => { if (confirm('ログアウトしますか？（端末の記録は消えません）')) logout(); };
  const du = $('#doUpd'); if (du) du.onclick = () => { S.swUpdate.postMessage('skipWaiting'); };
  if (S.cam) { const v = $('#cv'); v.srcObject = S.cam.stream; v.play().catch(() => {}); }
}
function stHTML(r) { return r.status === 'received' ? `<span class="st received">本部に受領済み ${hms(r.receivedAt)}</span>` : '<span class="st saved">端末に保存済み・未送信</span>'; }
function renderLast() {
  const r = S.recs.find(x => x.id === S.last), el = $('#lastBox'); if (!el) return;
  el.innerHTML = r ? `<div class="card last ${r.status}"><div class="sub">直前の記録　${esc(r.id)}</div><div class="bib">No.${esc(r.bib)}</div>
    <div class="pl">${esc(ptLabel(r.pt))}</div><div class="tm">${hms(r.t)}</div><div style="margin-top:6px">${stHTML(r)}</div>
    ${(r.warn || []).map(w => `<div class="warn">⚠ ${esc(w)}</div>`).join('')}</div>` : '';
}
function renderCounts() {
  const el = $('#counts'); if (!el) return;
  const rec = S.recs.filter(r => r.status === 'received').length;
  el.innerHTML = `<div><b>${S.recs.length}</b>端末に保存</div><div><b>${rec}</b>本部に受領</div><div><b style="color:${S.recs.length - rec ? 'var(--wait)' : 'var(--ok)'}">${S.recs.length - rec}</b>未送信</div>`;
  const m = $('#sendMsg'); if (!m) return;
  m.innerHTML = S.sendErr ? `<span class="err">送れませんでした：${esc(S.sendErr)}</span>` : !navigator.onLine ? '圏外です。記録は端末に保存されます。通信が戻ると自動で送ります' : !S.user ? 'ログインすると本部に送れます' : S.sending ? '送信中…' : (S.recs.length - rec ? '自動で送ります（15秒ごと）' : 'すべて本部に届いています');
}
function renderList() {
  const el = $('#list'); if (!el) return;
  const rs = [...S.recs].reverse();
  el.innerHTML = rs.length ? `<table><tr><th>時刻</th><th>No.</th><th>地点</th><th>状態</th></tr>${rs.map(r => `<tr><td>${hms(r.t)}</td><td><b>${esc(r.bib)}</b>${(r.warn || []).length ? ' ⚠' : ''}</td><td>${esc(ptLabel(r.pt))}</td><td>${r.status === 'received' ? `<span class="st received">受領 ${hms(r.receivedAt)}</span>` : '<span class="st saved">未送信</span>'}</td></tr>`).join('')}</table>` : '<div class="sub">まだ記録はありません</div>';
}
async function exportCSV() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const name = `計測_${EVENT_ID}_端末${S.dev}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.csv`;
  const r = await saveFile(name, toCSV(S.recs, ptLabel));
  if (r !== 'cancel') { await metaSet('lastCSV', new Date().toISOString()); }
}

/* ---------- 起動 ---------- */
async function boot() {
  S.dev = await deviceId(); S.pt = await metaGet('pt', 'G1'); S.recs = await allRecords();
  const last = S.recs[S.recs.length - 1]; S.last = last && last.id;
  try { const r = await fetch('events/' + EVENT_ID + '.json'); S.ev = await r.json(); } catch (e) { S.ev = null; }
  if (S.ev && !S.ev.points.find(p => p.k === S.pt)) S.pt = S.ev.points[0].k;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
    const reg = await navigator.serviceWorker.getRegistration(); if (reg) { watchUpdate(reg); if (navigator.onLine) reg.update().catch(() => {}); }
  }
  await swCheck(); render();
  try { onUser(u => { S.user = u; S.userKnown = true; render(); sync(); }); } catch (e) { S.userKnown = true; render(); }
  addEventListener('online', () => { render(); sync(); }); addEventListener('offline', render);
  setInterval(sync, 15000);
}
boot();
