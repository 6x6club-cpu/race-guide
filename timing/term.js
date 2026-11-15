/* 計測端末：読んだら必ず端末に保存 → 通信できるときに本部（Firebase）へ送る
   地点：受付 / 1周目終了 / フィニッシュ。スタート時刻は大会の予定時刻（遅れたときは本部が直す） */
import * as C from './common.js';
const { $, $$, esc, hms, dur, BUILD } = C;

const S = { ev: null, evList: [], pt: 'G1', recs: [], remote: [], starts: {}, user: null, userKnown: false, device: null, dev: '', label: '',
  ckPending: null, cam: null, last: null, sending: false, sendErr: '', swReady: false, swUpdate: null, msg: '', clk: null, unsubs: [] };
const ptLabel = k => k === 'VOID' ? '取消' : ((S.ev && S.ev.points.find(p => p.k === k)) || { label: k }).label;
const isAdmin = () => !!(S.user && !S.user.isAnonymous);
const canSend = () => !!(S.user && (isAdmin() || (S.device && S.device.active !== false)));
/** 受付専用の端末（受付用リンクで登録）：記録できるのは受付だけ */
const isCkOnly = () => !isAdmin() && ((S.device && S.device.role === 'ck') || (!S.device && !!S.ckPending));
const points = () => (S.ev ? S.ev.points : []).filter(p => !isCkOnly() || p.k === 'CK');

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
/** この端末と本部（ほかの端末）の記録を合わせた、取り消されていない記録 */
function liveAll() {
  const byId = new Map(); [...S.remote, ...S.recs].forEach(r => byId.set(r.id, r));
  const all = [...byId.values()]; const vo = C.voidedIds(all);
  return all.filter(r => r.pt !== 'VOID' && !vo.has(r.id));
}
async function record(raw, how) {
  if (isCkOnly()) S.pt = 'CK';
  const bib = bibOf(raw);
  if (!bib) { S.msg = `番号を読み取れませんでした（${esc(String(raw).slice(0, 40))}）`; beep(false); render(); return; }
  const warn = [];
  if (S.ev && !S.ev.bibs.includes(+bib)) warn.push('名簿にない番号');
  const prev = liveAll().filter(r => r.bib === bib && r.pt === S.pt);
  if (prev.length) warn.push(`${S.pt === 'CK' ? '受付済み' : 'この地点で記録済み'}（${prev.map(r => hms(r.t) + (r.dev !== S.dev ? ' ' + (r.label || r.dev) : '')).join('、')}）`);
  await save({ bib, pt: S.pt, t: new Date().toISOString(), how, raw: String(raw).slice(0, 200), warn, label: S.label });
}
async function save(r) {
  let rec;
  try { rec = await C.addRecord(r); }
  catch (e) { S.msg = '端末に保存できませんでした：' + C.errText(e) + '。番号と時刻を紙に控えてください'; beep(false); render(); return; }
  S.recs.push(rec); if (r.pt !== 'VOID') S.last = rec.id; S.msg = '';
  beep(!(r.warn || []).length); render(); sync();
}
async function voidRec(id) {
  const r = S.recs.find(x => x.id === id); if (!r) return;
  if (!confirm(`No.${r.bib}（${ptLabel(r.pt)} ${hms(r.t)}）の記録を取り消しますか？\n取り消しも記録として本部に送られます。`)) return;
  await save({ bib: r.bib, pt: 'VOID', target: r.id, t: new Date().toISOString(), how: '取消', raw: '', warn: [], label: S.label });
}

/* ---------- 本部へ送る ---------- */
async function sync() {
  if (S.sending || !navigator.onLine || !canSend()) return;
  const todo = S.recs.filter(r => r.status !== 'received' && r.status !== 'rejected');
  if (!todo.length) { S.sendErr = ''; return; }
  S.sending = true; renderCounts();
  try {
    for (const r of todo) {
      let res;
      try { res = await C.sendRecord(r, { clk: S.clk }); }
      catch (e) {
        // 権限で断られた記録は、送り直しても通らない。印を付けて次へ進む（CSVには残る）
        if (e && e.code === 'permission-denied' && canSend()) { Object.assign(r, await C.updateRecord(r.id, { status: 'rejected', rejectedWhy: C.errText(e) })); continue; }
        throw e;
      }
      if (res.clk != null) { S.clk = res.clk; C.metaSet('clk', res.clk); }
      const nx = await C.updateRecord(r.id, { status: 'received', receivedAt: res.receivedAt, already: res.already });
      Object.assign(r, nx); S.sendErr = ''; renderList(); renderLast(); renderCounts();
    }
  } catch (e) { S.sendErr = C.errText(e); }
  S.sending = false; render();
}
/** 通信できるあいだ、ほかの端末の記録とスタート時刻を受け取る（受付の重複の警告と、ゴールタイムに使う） */
function watchRemote() {
  S.unsubs.forEach(f => f()); S.unsubs = [];
  if (!canSend() || !navigator.onLine) return;
  S.unsubs.push(C.watchRecords(rs => { S.remote = rs; }, () => {}));
  S.unsubs.push(C.watchStarts(st => { S.starts = st; C.metaSet('starts:' + C.EVENT_ID, st); renderLast(); renderList(); }, () => {}));
}

/* ---------- カメラ ---------- */
async function camOn() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    const det = ('BarcodeDetector' in window) ? new BarcodeDetector({ formats: ['qr_code'] }) : null;
    S.cam = { stream, det, last: '', lastT: 0 }; render();
    const c = document.createElement('canvas'), g = c.getContext('2d', { willReadFrequently: true });
    S.cam.timer = setInterval(async () => {
      const v = $('#cv'); if (!v || !v.videoWidth || !S.cam) return; let raw = null;
      try {
        if (det) { const r = await det.detect(v); raw = r[0] && r[0].rawValue; }
        else { const w = 640, h = Math.round(v.videoHeight * w / v.videoWidth); c.width = w; c.height = h; g.drawImage(v, 0, 0, w, h); const r = jsQR(g.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' }); raw = r && r.data; }
      } catch (e) {}
      // 同じQRが写り続けているあいだ（5秒）は記録しない
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
  } catch (e) { if (m) m.innerHTML = `<span class="err">${esc(C.errText(e))}</span>`; return; }
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

/* ---------- 大会の切り替えと登録 ---------- */
async function useEvent(id) {
  C.setEventId(id); await C.metaSet('ev', id);
  S.ev = await C.loadEvent(id).catch(() => null); S.recs = await C.allRecords(); S.remote = [];
  S.starts = await C.metaGet('starts:' + id, {});
  const last = S.recs.filter(r => r.pt !== 'VOID').pop(); S.last = last && last.id;
  if (S.ev && !S.ev.points.find(p => p.k === S.pt)) S.pt = S.ev.points[0].k;
  S.device = await C.metaGet('device:' + id, null); S.ckPending = await C.metaGet('ckjoin:' + id, null);
  if (S.user && S.user.isAnonymous && navigator.onLine) { const d = await C.myDevice(); if (d !== undefined) { S.device = d && { label: d.label, active: d.active, role: d.role || 'timer' }; await C.metaSet('device:' + id, S.device); } }
  if (isCkOnly()) S.pt = 'CK';
  watchRemote(); render();
  await autoJoin(); sync();
}
/** 受付用リンクで開いたとき：通信できれば自動で受付端末として登録する */
async function autoJoin() {
  if (!S.ckPending || S.device || isAdmin() || !navigator.onLine || S.joining) return;
  S.joining = true;
  try {
    const label = S.label || ('受付-' + S.dev);
    const r = await C.joinWithCode(S.ckPending, label, 'ck');
    S.label = r.label || label; await C.metaSet('label', S.label);
    S.device = { label: S.label, active: true, role: r.role || 'ck' }; await C.metaSet('device:' + C.EVENT_ID, S.device);
    await C.metaSet('ckjoin:' + C.EVENT_ID, null); S.ckPending = null; S.msg = '';
    watchRemote();
  } catch (e) { S.msg = '受付端末として登録できませんでした：' + esc(C.errText(e)); }
  S.joining = false; render();
}
async function join() {
  const m = $('#joinMsg'); const code = $('#jcode').value.trim(); const label = $('#jlabel').value.trim();
  if (!label) { m.textContent = '端末の名前（例：受付A）を入れてください'; return; }
  if (!code) { m.textContent = '参加コードを入れてください'; return; }
  m.textContent = '登録しています…';
  try { const r = await C.joinWithCode(code, label, 'timer'); S.label = r.label || label; await C.metaSet('label', S.label); S.device = { label: S.label, active: true, role: r.role || 'timer' }; await C.metaSet('device:' + C.EVENT_ID, S.device); m.textContent = ''; watchRemote(); render(); sync(); }
  catch (e) { m.textContent = C.errText(e); }
}

/* ---------- 画面 ---------- */
function goalOf(r) {
  if (r.pt !== 'GF') return null; const c = C.catOf(S.ev, r.bib); if (!c) return null;
  const st = C.startOf(S.ev, S.starts, c.k); return st ? Date.parse(r.t) - Date.parse(st) : null;
}
function whoText() {
  if (!S.userKnown) return ['mid', '確認中'];
  if (isAdmin()) return ['on', '本部：' + (S.user.email || '')];
  if (S.device && S.device.active !== false) return ['on', (S.device.role === 'ck' ? '受付：' : '計測：') + (S.label || S.device.label || '')];
  if (S.ckPending) return ['mid', '受付端末（登録待ち・記録は端末に保存）'];
  if (S.device && S.device.active === false) return ['off', '本部で停止中'];
  return ['mid', '未登録（記録は端末に保存）'];
}
function render() {
  const unsent = S.recs.filter(r => r.status !== 'received').length;
  const reg = canSend();
  $('#ev').textContent = S.ev ? `${S.ev.name}　${S.label ? S.label + '（' + S.dev + '）' : '端末 ' + S.dev}` : '大会の設定を読めません';
  $('#net').className = 'pill ' + (navigator.onLine ? 'on' : 'off'); $('#net').textContent = navigator.onLine ? '通信あり' : '圏外';
  const [wc, wt] = whoText(); $('#who').className = 'pill ' + wc; $('#who').textContent = wt;
  $('#off').className = 'pill ' + (S.swReady ? 'on' : 'mid'); $('#off').textContent = S.swReady ? '圏外で起動できます' : '圏外の準備がまだ';
  const prep = !S.swReady || !reg;
  $('#main').innerHTML = `
  ${S.swUpdate ? `<div class="card"><b>新しい版があります。</b><div class="sub">計測の合間に、通信できる場所で更新してください。記録は消えません。</div><button class="btn wide" id="doUpd" style="margin-top:8px">更新する</button></div>` : ''}
  <details class="card" ${prep ? 'open' : ''}><summary>準備（通信できるときに）${prep ? '' : '　✓ 完了'}</summary>
    <div style="margin-top:8px"><b>1. 圏外で起動できるようにする</b>
      <div class="sub" id="swMsg">${S.swReady ? `この端末に保存済みです（${esc(BUILD.text)}）。機内モードでもこのページを開き直せます。` : '通信できる場所で押してください。'}</div>
      <button class="btn ${S.swReady ? 'sec' : ''} wide" id="doSW" style="margin-top:6px">${S.swReady ? 'もう一度保存する' : '圏外で使えるように保存'}</button></div>
    <div style="margin-top:14px"><b>2. 大会と参加コード</b>
      <div class="row"><select id="evSel">${S.evList.map(e => `<option value="${esc(e.id)}" ${e.id === C.EVENT_ID ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></div>
      ${reg ? `<div class="sub" style="margin-top:6px">${isAdmin() ? `本部のアカウント（${esc(S.user.email)}）で送ります。` : `この端末は「${esc(S.label || S.device.label || '')}」（${S.device.role === 'ck' ? '受付専用' : '計測担当'}）として登録済みです。圏外で開き直しても登録は保たれます。`}</div>`
      : S.ckPending ? `<div class="sub" style="margin-top:6px">受付用リンクで開きました。通信できると自動で受付端末として登録されます。登録前に受付した記録も、この端末に保存され、登録後に送られます。</div>`
      : `<div class="sub" style="margin-top:6px">計測担当の方は、本部から聞いた参加コードを入れて登録します（Googleアカウントは不要）。受付の方は、本部の「受付用リンク」かQRを開くだけで使えます。記録は、登録していなくても端末に保存されます。</div>
        <div class="row"><input id="jlabel" placeholder="端末の名前（例：受付A）" value="${esc(S.label)}" class="sm"></div>
        <div class="row"><input id="jcode" inputmode="numeric" placeholder="参加コード" autocomplete="off" class="sm"><button class="btn" id="doJoin" ${navigator.onLine ? '' : 'disabled'}>登録</button></div>`}
      <div class="err" id="joinMsg"></div>
      <details style="margin-top:10px"><summary class="sub">本部の方（Googleでログイン）</summary>
        ${isAdmin() ? `<button class="btn sec wide" id="doOut" style="margin-top:6px">ログアウト</button>` : `<button class="btn sec wide" id="doIn" style="margin-top:6px" ${navigator.onLine ? '' : 'disabled'}>Googleでログイン</button>`}
        <div class="err" id="inMsg"></div></details></div>
  </details>
  <div class="card">${isCkOnly() ? '<h3>受付（受付済みにする）</h3><div class="sub">選手のスマホの番号画面のQR、または番号を入力してください。</div>' : '<h3>いま記録する地点</h3>'}<div class="pts" ${isCkOnly() ? 'style="display:none"' : ''}>${points().map(p => `<button class="pt ${S.pt === p.k ? 'sel' : ''}" data-pt="${p.k}">${esc(p.label)}<small>${esc(p.sub || '')}</small></button>`).join('')}</div>
    <div class="cam ${S.cam ? 'show' : ''}"><video id="cv" playsinline muted></video><div class="lbl">${esc(ptLabel(S.pt))}</div></div>
    <div class="row"><button class="btn ${S.cam ? 'sec' : ''}" id="doCam">${S.cam ? 'カメラを止める' : 'QRを読む'}</button>
      <input id="bib" inputmode="numeric" pattern="[0-9]*" placeholder="番号" autocomplete="off"><button class="btn" id="doRec">記録</button></div>
    ${S.msg ? `<div class="warn">${S.msg}</div>` : ''}</div>
  <div id="lastBox"></div>
  <div class="card"><div class="counts" id="counts"></div>
    <div class="row"><button class="btn wide" id="doSend" ${navigator.onLine && reg && unsent && !S.sending ? '' : 'disabled'}>${S.sending ? '送信中…' : '本部に送る'}</button></div>
    <div class="sub" id="sendMsg" style="margin-top:6px"></div>
    <div class="row"><button class="btn sec wide" id="doCSV" ${S.recs.length ? '' : 'disabled'}>CSVを書き出す（圏外でも可）</button></div></div>
  <div class="card"><h3>この端末の記録（新しい順）</h3><div id="list"></div></div>`;
  renderLast(); renderCounts(); renderList();
  $$('[data-pt]').forEach(b => b.onclick = async () => { S.pt = b.dataset.pt; await C.metaSet('pt', S.pt); render(); });
  $('#doCam').onclick = () => S.cam ? camOff() : camOn();
  const go = async () => { const v = $('#bib').value.trim(); if (v) { $('#bib').value = ''; await record(v, '手入力'); const i = $('#bib'); if (i) i.focus(); } };
  $('#doRec').onclick = go; $('#bib').onkeydown = e => { if (e.key === 'Enter') go(); };
  $('#doSend').onclick = () => sync();
  $('#doCSV').onclick = exportCSV;
  $('#doSW').onclick = swInstall;
  $('#evSel').onchange = e => useEvent(e.target.value);
  const dj = $('#doJoin'); if (dj) dj.onclick = join;
  const di = $('#doIn'); if (di) di.onclick = async () => { try { await C.login(); } catch (e) { $('#inMsg').textContent = C.errText(e); } };
  const dout = $('#doOut'); if (dout) dout.onclick = () => { if (confirm('ログアウトしますか？（端末の記録は消えません）')) C.logout(); };
  const du = $('#doUpd'); if (du) du.onclick = () => { S.swUpdate.postMessage('skipWaiting'); };
  if (S.cam) { const v = $('#cv'); v.srcObject = S.cam.stream; v.play().catch(() => {}); }
}
function stHTML(r) { if (r.status === 'rejected') return '<span class="st void">本部が受け付けませんでした（CSVで本部に渡してください）</span>'; return r.status === 'received' ? `<span class="st received">本部に受領済み ${hms(r.receivedAt)}</span>` : '<span class="st saved">端末に保存済み・未送信</span>'; }
function renderLast() {
  const el = $('#lastBox'); if (!el) return;
  const r = S.recs.find(x => x.id === S.last); if (!r) { el.innerHTML = ''; return; }
  const voided = C.voidedIds(S.recs).has(r.id), c = C.catOf(S.ev, r.bib), g = goalOf(r);
  const head = r.pt === 'CK' ? ((r.warn || []).length ? '受付：要確認' : '受付OK') : ptLabel(r.pt);
  el.innerHTML = `<div class="card last ${voided ? 'voided' : r.status}"><div class="sub">直前の記録　${esc(r.id)}</div>
    <div class="bib">No.${esc(r.bib)}</div><div class="pl">${esc(head)}${c ? `　<span class="cat">${esc(c.label)}</span>` : ''}</div>
    <div class="tm">${hms(r.t)}${g != null ? `　<b>ゴールタイム ${dur(g)}</b>` : ''}</div>
    <div style="margin-top:6px">${voided ? '<span class="st void">取り消し済み</span>' : stHTML(r)}</div>
    ${(r.warn || []).map(w => `<div class="warn">⚠ ${esc(w)}</div>`).join('')}
    ${voided ? '' : `<button class="btn sec" id="doVoid" style="margin-top:8px">この記録を取り消す</button>`}</div>`;
  const dv = $('#doVoid'); if (dv) dv.onclick = () => voidRec(r.id);
}
function renderCounts() {
  const el = $('#counts'); if (!el) return;
  const rec = S.recs.filter(r => r.status === 'received' || r.status === 'rejected').length;
  el.innerHTML = `<div><b>${S.recs.length}</b>端末に保存</div><div><b>${rec}</b>本部に受領</div><div><b style="color:${S.recs.length - rec ? 'var(--wait)' : 'var(--ok)'}">${S.recs.length - rec}</b>未送信</div>`;
  const m = $('#sendMsg'); if (!m) return;
  m.innerHTML = S.sendErr ? `<span class="err">送れませんでした：${esc(S.sendErr)}</span>` : !navigator.onLine ? '圏外です。記録は端末に保存されます。通信が戻ると自動で送ります'
    : !canSend() ? '参加コードで登録すると本部に送れます' : S.sending ? '送信中…' : (S.recs.length - rec ? '自動で送ります（15秒ごと）' : 'すべて本部に届いています');
}
function renderList() {
  const el = $('#list'); if (!el) return;
  const vo = C.voidedIds(S.recs); const rs = [...S.recs].reverse();
  el.innerHTML = rs.length ? `<table><tr><th>時刻</th><th>No.</th><th>地点</th><th>状態</th></tr>${rs.map(r => { const g = goalOf(r);
    return `<tr class="${vo.has(r.id) ? 'cx' : ''}"><td>${hms(r.t)}</td><td><b>${esc(r.bib)}</b>${(r.warn || []).length ? ' ⚠' : ''}</td><td>${esc(ptLabel(r.pt))}${g != null ? `<br><span class="sub">${dur(g)}</span>` : ''}${vo.has(r.id) ? '<br><span class="sub">取消済み</span>' : ''}</td><td>${r.status === 'received' ? `<span class="st received">受領 ${hms(r.receivedAt)}</span>` : '<span class="st saved">未送信</span>'}</td></tr>`; }).join('')}</table>` : '<div class="sub">まだ記録はありません</div>';
}
async function exportCSV() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const name = `計測_${C.EVENT_ID}_${S.label || ''}端末${S.dev}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.csv`;
  await C.saveFile(name, C.toCSV(S.recs, ptLabel));
}

/* ---------- 起動 ---------- */
async function boot() {
  S.dev = await C.deviceId(); S.pt = await C.metaGet('pt', 'G1'); S.label = await C.metaGet('label', ''); S.clk = await C.metaGet('clk', null);
  S.evList = await C.loadEventList().catch(() => []);
  const qs = new URLSearchParams(location.search);
  const evId = qs.get('ev') || await C.metaGet('ev', C.DEFAULT_EVENT);
  // 受付用リンク（?ev=…&ck=コード）：コードを端末に控えてURLから消す
  if (qs.get('ck')) { await C.metaSet('ckjoin:' + evId, qs.get('ck')); history.replaceState(null, '', location.pathname); }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
    const reg = await navigator.serviceWorker.getRegistration(); if (reg) { watchUpdate(reg); if (navigator.onLine) reg.update().catch(() => {}); }
  }
  await swCheck();
  // 通信できるうちに、自動で圏外用に保存しておく（受付用リンクから来た人が押し忘れても大丈夫なように）
  if (!S.swReady && navigator.onLine && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(swCheck).then(render).catch(() => {});
  await useEvent(evId);
  try { C.onUser(async u => { S.user = u; S.userKnown = true; await useEvent(C.EVENT_ID); }); } catch (e) { S.userKnown = true; render(); }
  addEventListener('online', () => useEvent(C.EVENT_ID)); addEventListener('offline', () => { watchRemote(); render(); });
  setInterval(sync, 15000);
}
boot();
