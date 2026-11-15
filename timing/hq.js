/* 本部の受領確認：Firebaseに届いた計測記録をその場で一覧にする。
   計測端末のCSVを取り込み、本部に届いていない記録だけを登録できる（圏外時の復旧手段）。 */
import { $, $$, esc, hms, ymdhms, EVENT_ID, onUser, login, logout, watchRecords, sendRecord, csvToRecords, toCSV, saveFile, errText } from './common.js';

const PT = { G1: '1周目終了', GF: 'フィニッシュ' };
const S = { user: null, known: false, recs: [], meta: null, err: '', seen: new Set(), first: true, imp: null, impMsg: '' };
let unsub = null;

function render() {
  const m = $('#main');
  if (!S.known) { m.innerHTML = '<div class="card">ログインを確認しています…</div>'; return; }
  if (!S.user) {
    m.innerHTML = `<div class="card"><h3>ログインしてください</h3><p class="sub">許可されたGoogleアカウントだけが記録を見られます。</p><button class="btn" id="in">Googleでログイン</button><div class="err" id="inMsg"></div></div>`;
    $('#in').onclick = async () => { try { await login(); } catch (e) { $('#inMsg').textContent = errText(e); } }; return;
  }
  const rs = S.recs, live = rs.filter(r => !r.void);
  const key = r => r.bib + '|' + r.pt; const cnt = {}; live.forEach(r => cnt[key(r)] = (cnt[key(r)] || 0) + 1);
  const dups = Object.entries(cnt).filter(([, n]) => n > 1).length;
  const devs = {}; rs.forEach(r => devs[r.dev] = (devs[r.dev] || 0) + 1);
  const fromCache = S.meta && S.meta.fromCache;
  m.innerHTML = `
  <div class="card"><div class="row" style="justify-content:space-between"><div>ログイン中：<b>${esc(S.user.email)}</b>　<span class="tag ${fromCache ? 'w' : 'ok'}">${fromCache ? '本部に接続中…' : '本部と接続中・自動更新'}</span></div><button class="btn sec" id="out">ログアウト</button></div>
    ${S.err ? `<div class="err">${esc(S.err)}</div>` : ''}</div>
  <div class="card"><div class="kpi"><div><b>${rs.length}</b>受領した記録</div><div><b>${live.filter(r => r.pt === 'G1').length}</b>1周目終了</div><div><b>${live.filter(r => r.pt === 'GF').length}</b>フィニッシュ</div>
    <div><b style="color:${dups ? 'var(--bad)' : 'var(--ok)'}">${dups}</b>同じ選手・同じ地点が2件以上</div>
    <div><b>${Object.keys(devs).length}</b>端末（${Object.entries(devs).map(([d, n]) => `${esc(d)}:${n}件`).join('、') || '—'}）</div></div>
    <p class="sub">「同じ選手・同じ地点が2件以上」は、別々に読んだ記録が2件あるものです（同じ記録の送り直しは、記録IDが同じなので1件にしかなりません）。</p>
    <div class="row"><button class="btn sec" id="exp" ${rs.length ? '' : 'disabled'}>受領した記録をCSVで書き出す</button></div></div>
  <div class="card"><h3>計測端末のCSVを取り込む（端末から送れなかったとき）</h3>
    <p class="sub">計測端末で書き出したCSVを選ぶと、本部に届いていない記録だけを登録します。すでに届いている記録は二重に登録されません。</p>
    <input type="file" id="csv" accept=".csv,text/csv"><div id="imp">${impHTML()}</div></div>
  <div class="card"><h3>受領した記録（読んだ時刻の新しい順）</h3><div style="max-height:70vh;overflow:auto"><table>
    <tr><th>読んだ時刻</th><th>No.</th><th>地点</th><th>本部受領</th><th>端末</th><th>記録ID</th><th>注意</th></tr>
    ${[...rs].reverse().map(r => { const d = !r.void && cnt[key(r)] > 1; const lag = r.receivedAt ? (Date.parse(r.receivedAt) - Date.parse(r.t)) / 1000 : 0;
      return `<tr class="${d ? 'dup' : ''} ${!S.first && !S.seen.has(r.id) ? 'new' : ''}"><td>${ymdhms(r.t).slice(11)}</td><td><b>${esc(r.bib)}</b></td><td>${esc(PT[r.pt] || r.pt)}</td>
      <td>${hms(r.receivedAt)}${lag > 120 ? ` <span class="tag w">${Math.round(lag / 60)}分後</span>` : ''}</td><td>${esc(r.dev)}${r.via === 'csv' ? ' <span class="tag w">CSV</span>' : ''}</td><td class="sub">${esc(r.id)}</td>
      <td>${d ? '<span class="tag bad">同じ地点で複数</span> ' : ''}${(r.warn || []).map(w => `<span class="tag w">${esc(w)}</span>`).join(' ')}</td></tr>`; }).join('') || '<tr><td colspan="7" class="sub">まだ届いた記録はありません</td></tr>'}
  </table></div></div>`;
  rs.forEach(r => S.seen.add(r.id)); S.first = false;
  $('#out').onclick = () => logout();
  $('#exp').onclick = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); saveFile(`本部受領_${EVENT_ID}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.csv`, toCSV(rs.map(r => ({ ...r, status: 'received' })), k => PT[k] || k)); };
  $('#csv').onchange = e => readCSV(e.target.files[0]);
  bindImp();
}
function impHTML() {
  if (!S.imp) return S.impMsg ? `<div class="sub">${esc(S.impMsg)}</div>` : '';
  const have = new Set(S.recs.map(r => r.id)); const miss = S.imp.filter(r => !have.has(r.id));
  return `<div style="margin-top:8px">CSVの記録 <b>${S.imp.length}</b> 件のうち、本部に届いているもの <b>${S.imp.length - miss.length}</b> 件、届いていないもの <b style="color:${miss.length ? 'var(--bad)' : 'var(--ok)'}">${miss.length}</b> 件</div>
    ${miss.length ? `<table style="margin-top:6px"><tr><th>読んだ時刻</th><th>No.</th><th>地点</th><th>記録ID</th></tr>${miss.map(r => `<tr><td>${hms(r.t)}</td><td>${esc(r.bib)}</td><td>${esc(PT[r.pt] || r.pt)}</td><td class="sub">${esc(r.id)}</td></tr>`).join('')}</table>
    <button class="btn" id="impGo" style="margin-top:8px">届いていない ${miss.length} 件を登録する</button>` : '<div class="sub">すべて本部に届いています。登録するものはありません。</div>'}
    ${S.impMsg ? `<div class="sub" style="margin-top:6px">${esc(S.impMsg)}</div>` : ''}`;
}
function bindImp() {
  const b = $('#impGo'); if (!b) return;
  b.onclick = async () => {
    b.disabled = true; const have = new Set(S.recs.map(r => r.id)); const miss = S.imp.filter(r => !have.has(r.id)); let n = 0, a = 0;
    try { for (const r of miss) { const res = await sendRecord({ ...r, via: 'csv' }); res.already ? a++ : n++; } S.impMsg = `${n} 件を登録しました${a ? `（${a} 件はすでに届いていました）` : ''}`; }
    catch (e) { S.impMsg = `途中で止まりました（${n} 件まで登録）：${errText(e)}`; }
    render();
  };
}
async function readCSV(f) {
  if (!f) return; S.impMsg = '';
  try { S.imp = csvToRecords(await f.text()); if (!S.imp.length) S.impMsg = 'CSVに記録がありません'; }
  catch (e) { S.imp = null; S.impMsg = e.message; }
  render();
}
onUser(u => {
  S.user = u; S.known = true; if (unsub) { unsub(); unsub = null; }
  if (u) unsub = watchRecords((recs, meta) => { S.recs = recs; S.meta = meta; S.err = ''; render(); }, e => { S.err = '記録を読めません：' + errText(e); render(); });
  render();
});
render();
