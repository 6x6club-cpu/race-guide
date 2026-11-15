/* 本部：計測の受領確認・受付状況・スタート時刻・参加コードと端末の管理。
   計測端末のCSVを取り込み、本部に届いていない記録だけを登録できる（圏外時の復旧手段）。 */
import * as C from './common.js';
const { $, $$, esc, hms, hm, dur, ymdhms } = C;

const S = { ev: null, evList: [], user: null, known: false, recs: [], meta: null, starts: {}, devices: [], code: null, err: '', imp: null, impMsg: '', tab: 'ck', editStart: null };
let unsubs = [];
const ptLabel = k => k === 'VOID' ? '取消' : ((S.ev && S.ev.points.find(p => p.k === k)) || { label: k }).label;
const isAdmin = () => S.user && !S.user.isAnonymous;

function derived() {
  const vo = C.voidedIds(S.recs); const live = S.recs.filter(r => r.pt !== 'VOID' && !vo.has(r.id));
  const key = r => r.bib + '|' + r.pt; const cnt = {}; live.forEach(r => cnt[key(r)] = (cnt[key(r)] || 0) + 1);
  return { vo, live, cnt, key };
}
function render() {
  const keep = ['stTime', 'stWhy'].map(id => [id, $('#' + id) && $('#' + id).value]);
  render0();
  keep.forEach(([id, v]) => { const el = $('#' + id); if (el && v != null) el.value = v; });
}
function render0() {
  const m = $('#main');
  $('#ev').textContent = S.ev ? S.ev.name : '';
  if (!S.known) { m.innerHTML = '<div class="card">ログインを確認しています…</div>'; return; }
  if (!isAdmin()) {
    m.innerHTML = `<div class="card"><h3>本部のアカウントでログインしてください</h3><p class="sub">許可されたGoogleアカウントだけが使えます。</p><button class="btn" id="in">Googleでログイン</button><div class="err" id="inMsg"></div></div>`;
    $('#in').onclick = async () => { try { await C.login(); } catch (e) { $('#inMsg').textContent = C.errText(e); } }; return;
  }
  const { vo, live, cnt, key } = derived();
  const fromCache = S.meta && S.meta.fromCache;
  const tabs = [['ck', '受付'], ['course', 'コース上の人'], ['start', 'スタート時刻'], ['rec', '記録・ゴールタイム'], ['dev', '参加コード・端末'], ['csv', 'CSV']];
  m.innerHTML = `
  <div class="card"><div class="row" style="justify-content:space-between">
    <div class="row"><select id="evSel">${S.evList.map(e => `<option value="${esc(e.id)}" ${e.id === C.EVENT_ID ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>
      <span class="tag ${fromCache ? 'w' : 'ok'}">${fromCache ? '本部に接続中…' : '接続中・自動更新'}</span></div>
    <div class="row"><span class="sub">${esc(S.user.email)}</span><button class="btn sec" id="out">ログアウト</button></div></div>
    ${S.err ? `<div class="err">${esc(S.err)}</div>` : ''}
    <div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${S.tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div></div>
  <div id="body"></div>`;
  $('#body').innerHTML = ({ ck: ckHTML, course: courseHTML, start: startHTML, rec: recHTML, dev: devHTML, csv: csvHTML }[S.tab])(live, vo, cnt, key);
  $('#out').onclick = () => C.logout();
  $('#evSel').onchange = e => useEvent(e.target.value);
  $$('[data-tab]').forEach(b => b.onclick = () => { S.tab = b.dataset.tab; render(); });
  bind();
}
/* ---- 受付 ---- */
function ckHTML(live) {
  const ck = new Map(); live.filter(r => r.pt === 'CK').forEach(r => { if (!ck.has(r.bib) || Date.parse(r.t) < Date.parse(ck.get(r.bib).t)) ck.set(r.bib, r); });
  const by = {}; live.filter(r => r.pt === 'CK').forEach(r => by[r.label || r.dev] = (by[r.label || r.dev] || 0) + 1);
  const groups = [...S.ev.cats.map(c => ({ ...c, all: S.ev.bibs.filter(b => b >= c.from && b <= c.to) })), { k: 'P', label: 'ペーサー', all: S.ev.pacers || [] }];
  return groups.map(c => {
    const all = c.all; const done = all.filter(b => ck.has(String(b))); const not = all.filter(b => !ck.has(String(b)));
    return `<div class="card"><h3>${esc(c.label)}　受付済み <b>${done.length}</b> ／ ${all.length}人　<span class="sub">未受付 ${not.length}人</span></h3>
      <div class="bar"><i style="width:${all.length ? done.length / all.length * 100 : 0}%"></i></div>
      <div class="sub" style="margin-top:8px">${c.k === 'P' ? '未受付のペーサー' : '未受付（スタート時点で未受付ならDNS候補）'}</div><div class="chips">${not.map(b => `<span class="chip">${b}</span>`).join('') || '<span class="sub">なし</span>'}</div>
      <details style="margin-top:8px"><summary class="sub">受付済み ${done.length}人</summary><div class="chips">${done.map(b => { const r = ck.get(String(b)); return `<span class="chip ok" title="${esc(r.label || r.dev)} ${hms(r.t)}">${b}<small>${hm(r.t)}</small></span>`; }).join('')}</div></details></div>`;
  }).join('') + `<div class="card sub">受付の担当ごとの件数：${Object.entries(by).map(([k, n]) => `${esc(k)} ${n}件`).join('、') || 'まだありません'}</div>`;
}
/* ---- コース上の人（安全の把握） ---- */
function courseHTML(live) {
  const st = C.peopleState(live); const now = Date.now(); const cut = S.ev.cutoff ? Date.parse(S.ev.cutoff) : null; const late = cut && now > cut;
  const started = c => { const t = C.startOf(S.ev, S.starts, c.k); return t && now >= Date.parse(t); };
  const runners = S.ev.cats.flatMap(c => S.ev.bibs.filter(b => b >= c.from && b <= c.to).map(b => ({ b: String(b), c, x: st[String(b)] || {} })));
  const onCourse = runners.filter(r => r.x.ck && !r.x.gf && !r.x.dn && started(r.c));
  const waiting = runners.filter(r => r.x.ck && !r.x.gf && !r.x.dn && !started(r.c));
  const fin = runners.filter(r => r.x.gf), dn = runners.filter(r => r.x.dn), dns = runners.filter(r => !r.x.ck);
  const pac = (S.ev.pacers || []).map(b => ({ b, x: st[b] || {} }));
  const pOut = pac.filter(p => p.x.out), pDone = pac.filter(p => p.x.ck && !p.x.out && p.x.outs), pWait = pac.filter(p => p.x.ck && !p.x.outs), pNo = pac.filter(p => !p.x.ck);
  const runnerOf = b => b.replace(/^P-/, '').split('-')[0];
  const chip = (b, cls, sub) => `<span class="chip ${cls}">${esc(b)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>`;
  return `<div class="card"><div class="kpi">
      <div><b style="color:${onCourse.length + pOut.length ? 'var(--wait)' : 'var(--ok)'}">${onCourse.length + pOut.length}</b>いまコース上（選手${onCourse.length}・ペーサー${pOut.length}）</div>
      <div><b>${fin.length}</b>フィニッシュ</div><div><b>${dn.length}</b>リタイア</div><div><b>${dns.length}</b>未受付（DNS候補）</div></div>
    ${late && onCourse.length + pOut.length ? `<div class="err" style="margin-top:8px;font-weight:800">最終関門（${hm(S.ev.cutoff)}）を過ぎています。コース上に残っている人を確認してください。</div>` : ''}
    <p class="sub">コース上の選手＝受付済みで、スタート後、フィニッシュもリタイアもしていない人。ペーサー＝最後の記録が「ペーサー出発」の人。</p></div>
  <div class="card"><h3>コース上のペーサー（${pOut.length}人）</h3><div class="chips">${pOut.map(p => chip(p.b, late ? 'bad' : 'w', `No.${runnerOf(p.b)}と ${hm(p.x.lastOut.t)}〜`)).join('') || '<span class="sub">いません</span>'}</div>
    <p class="sub">戻った（終了・交代）：${pDone.map(p => `${esc(p.b)}（${hm(p.x.lastIn.t)}）`).join('、') || 'なし'}　／　受付済み・まだ出発していない：${pWait.map(p => esc(p.b)).join('、') || 'なし'}　／　未受付：${pNo.map(p => esc(p.b)).join('、') || 'なし'}</p></div>
  <div class="card"><h3>コース上の選手（${onCourse.length}人）</h3><div class="chips">${onCourse.map(r => chip(r.b, late ? 'bad' : 'w', r.x.g1 ? '1周目済' : '')).join('') || '<span class="sub">いません</span>'}</div>
    ${waiting.length ? `<p class="sub">受付済み・スタート前：${waiting.map(r => esc(r.b)).join('、')}</p>` : ''}
    <p class="sub">リタイア：${dn.map(r => `${esc(r.b)}（${hm(r.x.dn.t)}）`).join('、') || 'なし'}</p></div>`;
}
/* ---- スタート時刻 ---- */
function startHTML() {
  return `<div class="card"><p class="sub" style="margin-top:0">スタート時刻は、大会の予定時刻がそのまま使われます。<b>スタートが遅れたときだけ</b>、実際の時刻に直してください。直すと全員のゴールタイムが計算し直されます。</p>
  <table><tr><th>部門</th><th>予定</th><th>使う時刻</th><th>修正の履歴</th><th></th></tr>${S.ev.cats.map(c => { const s = S.starts[c.k]; const use = C.startOf(S.ev, S.starts, c.k);
    return `<tr><td><b>${esc(c.label)}</b></td><td>${hms(c.start)}</td><td><b>${hms(use)}</b>${s && s.actual ? ' <span class="tag w">修正済み</span>' : ' <span class="tag ok">予定どおり</span>'}</td>
    <td class="sub">${((s && s.history) || []).map(h => `${ymdhms(h.at).slice(5, 16)} ${esc(h.by)}：${h.from ? hms(h.from) : '予定'} → ${hms(h.to)}${h.reason ? '（' + esc(h.reason) + '）' : ''}`).join('<br>') || '—'}</td>
    <td>${S.editStart === c.k ? '' : `<button class="btn sec" data-edit="${c.k}">直す</button>`}</td></tr>
    ${S.editStart === c.k ? `<tr><td colspan="5"><div class="row">実際のスタート時刻 <input id="stTime" type="time" step="1" value="${hms(use)}"> 理由 <input id="stWhy" placeholder="例：濃霧で5分遅れ" style="flex:1;min-width:160px">
      <button class="btn" id="stSave">保存</button><button class="btn sec" id="stCancel">やめる</button></div></td></tr>` : ''}`; }).join('')}</table></div>`;
}
/* ---- 記録 ---- */
function recHTML(live, vo, cnt, key) {
  const dups = Object.values(cnt).filter(n => n > 1).length; const devs = {}; S.recs.forEach(r => devs[r.label || r.dev] = (devs[r.label || r.dev] || 0) + 1);
  const clk = {}; S.recs.forEach(r => { if (r.clk != null) clk[r.label || r.dev] = r.clk; });
  const goal = r => { if (r.pt !== 'GF') return null; const c = C.catOf(S.ev, r.bib); const st = c && C.startOf(S.ev, S.starts, c.k); return st ? Date.parse(r.t) - Date.parse(st) : null; };
  const pts = S.ev.points.map(p => `<div><b>${live.filter(r => r.pt === p.k).length}</b>${esc(p.label)}</div>`).join('');
  return `<div class="card"><div class="kpi"><div><b>${S.recs.length}</b>受領した記録</div>${pts}<div><b style="color:${dups ? 'var(--bad)' : 'var(--ok)'}">${dups}</b>同じ選手・同じ地点が2件以上</div><div><b>${vo.size}</b>取消</div></div>
    <p class="sub">端末：${Object.entries(devs).map(([d, n]) => `${esc(d)} ${n}件${clk[d] != null ? `（時計のずれ ${(clk[d] / 1000).toFixed(1)}秒）` : ''}`).join('、') || '—'}</p>
    <p class="sub">「同じ選手・同じ地点が2件以上」は、別々に読んだ記録が2件あるものです。同じ記録の送り直しは記録IDが同じなので1件にしかなりません。</p></div>
  <div class="card"><div style="max-height:70vh;overflow:auto"><table>
    <tr><th>読んだ時刻</th><th>No.</th><th>部門</th><th>地点</th><th>ゴールタイム</th><th>本部受領</th><th>端末</th><th>注意</th></tr>
    ${[...S.recs].reverse().map(r => { const d = r.pt !== 'VOID' && !vo.has(r.id) && cnt[key(r)] > 1; const lag = r.receivedAt ? (Date.parse(r.receivedAt) - Date.parse(r.t)) / 1000 : 0; const c = C.catOf(S.ev, r.bib); const g = vo.has(r.id) ? null : goal(r);
      return `<tr class="${d ? 'dup' : ''} ${vo.has(r.id) ? 'cx' : ''}"><td>${ymdhms(r.t).slice(11)}</td><td><b>${esc(r.bib)}</b></td><td>${esc(c ? c.label : '')}</td><td>${esc(ptLabel(r.pt))}${r.pt === 'VOID' ? `<br><span class="sub">${esc(r.target)}</span>` : ''}</td>
      <td>${g != null ? `<b>${dur(g)}</b>` : ''}</td><td>${hms(r.receivedAt)}${lag > 120 ? ` <span class="tag w">${Math.round(lag / 60)}分後</span>` : ''}</td><td>${esc(r.label || r.dev)}${r.via === 'csv' ? ' <span class="tag w">CSV</span>' : ''}</td>
      <td>${vo.has(r.id) ? '<span class="tag">取消済み</span> ' : ''}${d ? '<span class="tag bad">同じ地点で複数</span> ' : ''}${(r.warn || []).map(w => `<span class="tag w">${esc(w)}</span>`).join(' ')}</td></tr>`; }).join('') || '<tr><td colspan="8" class="sub">まだ届いた記録はありません</td></tr>'}
  </table></div></div>`;
}
/* ---- 参加コード・端末 ---- */
function qrSVG(text) { try { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 5, margin: 2, scalable: true }); } catch (e) { return ''; } }
function devHTML() {
  const ld = S.code == null; const ck = S.code && S.code.ckCode; const link = ck ? C.ckLink(ck) : '';
  return `<div class="card"><h3>受付用リンク（受付スタッフは誰でも）</h3>
    <p class="sub" style="margin-top:0">このリンクかQRを開くだけで、その端末が<b>受付専用</b>として使えるようになります（入力やログインは不要）。受付専用の端末は「受付」しか記録できません。スタッフのLINEに流すか、QRを印刷して受付テントに貼ってください。</p>
    ${ld ? '読み込み中…' : ck ? `<div class="row" style="align-items:flex-start"><div class="qrbox">${qrSVG(link)}</div><div style="flex:1;min-width:240px"><div class="sub">リンク</div><div class="link">${esc(link)}</div>
      <div class="row" style="margin-top:8px"><button class="btn" id="copyCk">リンクをコピー</button><button class="btn sec" id="printCk">QRを印刷</button><button class="btn sec" id="newCk">リンクを作り直す</button></div>
      <p class="sub">作り直すと古いリンクでは新しく登録できなくなります（登録済みの端末はそのまま使えます）。</p></div></div>`
      : `<button class="btn" id="newCk">受付用リンクを作る</button>`}</div>
  <div class="card"><h3>計測担当の参加コード</h3><p class="sub" style="margin-top:0">「1周目終了」「フィニッシュ」を記録する計測担当は、このコードを入れて端末を登録します（Googleアカウント不要）。受付スタッフには教えないでください。</p>
    <div class="row">いまのコード：<b style="font-size:24px;letter-spacing:.1em">${ld ? '…' : esc(S.code.code) || '（未設定）'}</b>
    <button class="btn sec" id="newCode">${S.code && S.code.code ? 'コードを変える' : 'コードを作る'}</button></div></div>
  <div class="card"><h3>登録された端末（${S.devices.length}台）</h3><table><tr><th>端末の名前</th><th>役割</th><th>端末</th><th>登録</th><th>記録</th><th>状態</th><th></th></tr>
    ${S.devices.map(d => { const n = S.recs.filter(r => r.by === d.uid).length;
      return `<tr><td><b>${esc(d.label)}</b></td><td>${d.role === 'ck' ? '受付専用' : '計測担当'}</td><td>${esc(d.dev || '')}</td><td>${d.at ? ymdhms(d.at).slice(5, 16) : ''}</td><td>${n}件</td><td>${d.active === false ? '<span class="tag bad">停止中</span>' : '<span class="tag ok">使用中</span>'}</td>
      <td><button class="btn sec" data-dev="${esc(d.uid)}" data-act="${d.active === false ? 1 : 0}">${d.active === false ? '再開' : '停止'}</button></td></tr>`; }).join('') || '<tr><td colspan="7" class="sub">まだ登録された端末はありません</td></tr>'}</table>
    <p class="sub">紛失した端末や、心当たりのない端末は「停止」すると、その端末からは本部に送れなくなります（端末に残った記録はCSVで回収できます）。</p></div>`;
}
/* ---- CSV ---- */
function csvHTML() {
  return `<div class="card"><h3>計測端末のCSVを取り込む（端末から送れなかったとき）</h3>
    <p class="sub">計測端末で書き出したCSVを選ぶと、本部に届いていない記録だけを登録します。すでに届いている記録は二重に登録されません。</p>
    <input type="file" id="csv" accept=".csv,text/csv"><div id="imp">${impHTML()}</div></div>
  <div class="card"><h3>受領した記録を書き出す</h3><button class="btn sec" id="exp" ${S.recs.length ? '' : 'disabled'}>CSVで書き出す</button></div>`;
}
function impHTML() {
  if (!S.imp) return S.impMsg ? `<div class="sub">${esc(S.impMsg)}</div>` : '';
  const have = new Set(S.recs.map(r => r.id)); const miss = S.imp.filter(r => !have.has(r.id));
  return `<div style="margin-top:8px">CSVの記録 <b>${S.imp.length}</b> 件のうち、本部に届いているもの <b>${S.imp.length - miss.length}</b> 件、届いていないもの <b style="color:${miss.length ? 'var(--bad)' : 'var(--ok)'}">${miss.length}</b> 件</div>
    ${miss.length ? `<table style="margin-top:6px"><tr><th>読んだ時刻</th><th>No.</th><th>地点</th><th>記録ID</th></tr>${miss.map(r => `<tr><td>${hms(r.t)}</td><td>${esc(r.bib)}</td><td>${esc(ptLabel(r.pt))}</td><td class="sub">${esc(r.id)}</td></tr>`).join('')}</table>
    <button class="btn" id="impGo" style="margin-top:8px">届いていない ${miss.length} 件を登録する</button>` : '<div class="sub">すべて本部に届いています。登録するものはありません。</div>'}
    ${S.impMsg ? `<div class="sub" style="margin-top:6px">${esc(S.impMsg)}</div>` : ''}`;
}
function bind() {
  $$('[data-edit]').forEach(b => b.onclick = () => { S.editStart = b.dataset.edit; render(); });
  const ss = $('#stSave'); if (ss) ss.onclick = async () => {
    const c = S.ev.cats.find(x => x.k === S.editStart); const [h, mi, se] = $('#stTime').value.split(':').map(Number); const base = new Date(c.start);
    const d = new Date(base); d.setHours(h, mi, se || 0, 0);
    const why = $('#stWhy').value.trim(); if (!why) { alert('理由を入れてください'); return; }
    if (!confirm(`${c.label} のスタート時刻を ${hms(d.toISOString())} にします。全員のゴールタイムが計算し直されます。よろしいですか？`)) return;
    try { await C.setStart(c.k, d.toISOString(), why, S.starts[c.k]); S.editStart = null; } catch (e) { alert(C.errText(e)); } render();
  };
  const sc = $('#stCancel'); if (sc) sc.onclick = () => { S.editStart = null; render(); };
  const rnd = n => Array.from(crypto.getRandomValues(new Uint32Array(n)), x => x % 10).join('');
  const nc = $('#newCode'); if (nc) nc.onclick = async () => {
    const code = rnd(6);
    if (S.code.code && !confirm(`計測担当の参加コードを ${code} に変えます。これから登録する計測端末は新しいコードが必要です。よろしいですか？`)) return;
    try { await C.setJoinCode('code', code); S.code.code = code; } catch (e) { alert(C.errText(e)); } render();
  };
  const nk = $('#newCk'); if (nk) nk.onclick = async () => {
    if (S.code.ckCode && !confirm('受付用リンクを作り直します。古いリンクでは新しく登録できなくなります。よろしいですか？')) return;
    const ck = rnd(10);
    try { await C.setJoinCode('ckCode', ck); S.code.ckCode = ck; } catch (e) { alert(C.errText(e)); } render();
  };
  const cc = $('#copyCk'); if (cc) cc.onclick = async () => { try { await navigator.clipboard.writeText(C.ckLink(S.code.ckCode)); cc.textContent = 'コピーしました'; } catch (e) { prompt('このリンクをコピーしてください', C.ckLink(S.code.ckCode)); } };
  const pc = $('#printCk'); if (pc) pc.onclick = () => {
    const w = window.open('', '_blank'); const link = C.ckLink(S.code.ckCode);
    w.document.write(`<!DOCTYPE html><meta charset="utf-8"><title>受付用QR</title><body style="font-family:sans-serif;text-align:center;padding:40px"><h1 style="font-size:40px;margin:0">受付スタッフ用</h1><p style="font-size:22px">${esc(S.ev.name)}</p><div style="width:420px;margin:20px auto">${qrSVG(link)}</div><p style="font-size:20px">スマホのカメラで読み取り、開いたページで受付をしてください</p><p style="font-size:12px;color:#666;word-break:break-all">${esc(link)}</p><script>setTimeout(()=>print(),300)<\/script></body>`);
    w.document.close();
  };
  $$('[data-dev]').forEach(b => b.onclick = async () => { const act = b.dataset.act === '1'; if (!act && !confirm('この端末を停止しますか？')) return; try { await C.setDeviceActive(b.dataset.dev, act); } catch (e) { alert(C.errText(e)); } });
  const f = $('#csv'); if (f) f.onchange = e => readCSV(e.target.files[0]);
  const ex = $('#exp'); if (ex) ex.onclick = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); C.saveFile(`本部受領_${C.EVENT_ID}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.csv`, C.toCSV(S.recs.map(r => ({ ...r, status: 'received' })), ptLabel)); };
  const ig = $('#impGo'); if (ig) ig.onclick = async () => {
    ig.disabled = true; const have = new Set(S.recs.map(r => r.id)); const miss = S.imp.filter(r => !have.has(r.id)); let n = 0, a = 0;
    try { for (const r of miss) { const res = await C.sendRecord({ ...r, via: 'csv' }); res.already ? a++ : n++; } S.impMsg = `${n} 件を登録しました${a ? `（${a} 件はすでに届いていました）` : ''}`; }
    catch (e) { S.impMsg = `途中で止まりました（${n} 件まで登録）：${C.errText(e)}`; }
    render();
  };
}
async function readCSV(f) {
  if (!f) return; S.impMsg = '';
  try { S.imp = C.csvToRecords(await f.text()); if (!S.imp.length) S.impMsg = 'この大会のCSVの記録がありません（大会の選択を確認してください）'; }
  catch (e) { S.imp = null; S.impMsg = e.message; }
  render();
}
async function useEvent(id) {
  C.setEventId(id); try { localStorage.setItem('hq-ev', id); } catch (e) {}
  S.ev = await C.loadEvent(id); S.recs = []; S.starts = {}; S.devices = []; S.code = null; S.imp = null; S.impMsg = ''; S.err = '';
  unsubs.forEach(f => f()); unsubs = [];
  if (isAdmin()) {
    const er = e => { S.err = '読めません：' + C.errText(e); render(); };
    unsubs.push(C.watchRecords((rs, meta) => { S.recs = rs; S.meta = meta; render(); }, er));
    unsubs.push(C.watchStarts(st => { S.starts = st; render(); }, er));
    unsubs.push(C.watchDevices(ds => { S.devices = ds; render(); }, er));
    C.getJoinCodes().then(c => { S.code = c; render(); }).catch(er);
  }
  render();
}
setInterval(() => { if (S.tab === 'course' && !S.editStart) render(); }, 60000);
(async () => {
  S.evList = await C.loadEventList().catch(() => []);
  let id = new URLSearchParams(location.search).get('ev'); try { id = id || localStorage.getItem('hq-ev'); } catch (e) {}
  await useEvent(id || (S.evList[0] && S.evList[0].id) || C.DEFAULT_EVENT);
  C.onUser(async u => { S.user = u; S.known = true; await useEvent(C.EVENT_ID); });
})();
