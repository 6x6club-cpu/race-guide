/* 本部：計測の受領確認・受付状況・スタート時刻・参加コードと端末の管理。
   計測端末のCSVを取り込み、本部に届いていない記録だけを登録できる（圏外時の復旧手段）。 */
import * as C from './common.js';
const { $, $$, esc, hms, hm, dur, ymdhms } = C;

const S = { sv: [], svIn: null, svMsg: '', notices: [], ev: null, evList: [], user: null, known: false, recs: [], meta: null, starts: {}, devices: [], code: null, err: '', imp: null, impMsg: '', tab: 'ck', editStart: null };
let unsubs = [];
const ptLabel = k => k === 'VOID' ? '取消' : ((S.ev && S.ev.points.find(p => p.k === k)) || { label: k }).label;
const isAdmin = () => S.user && !S.user.isAnonymous;

function derived() {
  const vo = C.voidedIds(S.recs); const live = S.recs.filter(r => r.pt !== 'VOID' && !vo.has(r.id));
  const key = r => r.bib + '|' + r.pt; const cnt = {}; live.forEach(r => cnt[key(r)] = (cnt[key(r)] || 0) + 1);
  return { vo, live, cnt, key };
}
function render() {
  const keep = ['stTime', 'stWhy', 'rsId', 'ntText', 'svText'].map(id => [id, $('#' + id) && $('#' + id).value]);
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
  const tabs = [['notice', 'お知らせ'], ['ck', '受付'], ['course', 'コース上の人'], ['start', 'スタート時刻'], ['rec', '記録・ゴールタイム'], ['dev', '参加コード・端末'], ['staff', 'スタッフ担当'], ['csv', 'CSV']];
  const hqApp = '<a class="sub" href="https://claude.ai/artifact/H3Yeu1q4Z4CeWKWm1wsA59" target="_blank" rel="noopener">本部統括（名簿・担当・地図）を開く ↗</a>';
  m.innerHTML = `
  <div class="card"><div class="row" style="justify-content:space-between">
    <div class="row"><select id="evSel">${S.evList.map(e => `<option value="${esc(e.id)}" ${e.id === C.EVENT_ID ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>
      <span class="tag ${fromCache ? 'w' : 'ok'}">${fromCache ? '本部に接続中…' : '接続中・自動更新'}</span></div>
    <div class="row">${hqApp}<span class="sub">${esc(S.user.email)}</span><button class="btn sec" id="out">ログアウト</button></div></div>
    ${S.err ? `<div class="err">${esc(S.err)}</div>` : ''}
    <div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${S.tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div></div>
  <div id="body"></div>`;
  $('#body').innerHTML = ({ notice: noticeHTML, ck: ckHTML, course: courseHTML, start: startHTML, rec: recHTML, dev: devHTML, staff: staffHTML, csv: csvHTML }[S.tab])(live, vo, cnt, key);
  $('#out').onclick = () => C.logout();
  $('#evSel').onchange = e => useEvent(e.target.value);
  $$('[data-tab]').forEach(b => b.onclick = () => { S.tab = b.dataset.tab; render(); });
  bind();
}
/* ---- 選手向けのお知らせ ---- */
const GUIDE_URL = { 'kq50-2026': 'https://race.ishikawahiromi.jp/kusenbu50/', 'test-kq50': 'https://race.ishikawahiromi.jp/kusenbu50/?ev=test-kq50' };
function noticeHTML() {
  const url = GUIDE_URL[C.EVENT_ID] || '';
  return `<div class="card"><h3>選手向けのお知らせを出す</h3>
    <p class="sub" style="margin-top:0">ここで「公開」すると、選手向け大会案内${url ? `（<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>）` : ''}の上部に、1分以内に表示されます。本部のアカウントならどなたでも出せます。${C.EVENT_ID === 'test-kq50' ? '<br><b>テスト大会のお知らせは、上のURL（?ev=test-kq50 付き）でだけ表示されます。</b>' : ''}</p>
    <textarea id="ntText" rows="4" placeholder="例：濃霧のため、スタートを30分遅らせます。受付は予定どおり5:00からです。" style="width:100%;font:inherit;padding:8px;border:2px solid var(--line);border-radius:8px"></textarea>
    <div class="row" style="margin-top:6px"><label><input type="checkbox" id="ntImp"> 重要なお知らせ（赤で目立たせる）</label><button class="btn" id="ntGo">公開する</button></div>
    <div class="sub" id="ntMsg"></div></div>
  <div class="card"><h3>出したお知らせ（${S.notices.length}件）</h3>
    ${S.notices.map(n => `<div style="border-top:1px solid var(--line);padding:8px 0;${n.hidden ? 'opacity:.5' : ''}"><div class="sub">${ymdhms(n.at).slice(5, 16)}　${esc(n.by || '')}　${n.important ? '<span class="tag bad">重要</span>' : ''}${n.hidden ? '<span class="tag">非表示</span>' : '<span class="tag ok">表示中</span>'}</div>
      <div style="white-space:pre-wrap;margin:4px 0">${esc(n.text)}</div>
      <button class="btn sec" data-nhide="${esc(n.id)}" data-v="${n.hidden ? 0 : 1}">${n.hidden ? 'もう一度表示する' : '非表示にする'}</button></div>`).join('') || '<div class="sub">まだありません</div>'}</div>`;
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
      <div class="sub" style="margin-top:8px"><span class="chip ok" style="min-width:0">緑</span>＝受付済み（下に受付時刻）　<span class="chip" style="min-width:0">赤</span>＝未受付${c.k === 'P' ? '' : '（スタート時点で未受付ならDNS候補）'}</div>
      <div class="chips">${all.map(b => { const r = ck.get(String(b)); return r ? `<span class="chip ok" title="${esc(r.label || r.dev)} ${hms(r.t)}">${b}<small>${hm(r.t)}</small></span>` : `<span class="chip">${b}</span>`; }).join('')}</div></div>`;
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
  const runnerOf = b => b.replace(/^P-/, '').split('-')[0];
  // ペーサーは伴走する選手と一緒に動く。選手がフィニッシュかリタイアしていれば、ペーサーの「戻り」が未記録でも赤くしない
  const rDone = b => { const r = st[runnerOf(b)] || {}; return r.gf || r.dn; };
  const pac = (S.ev.pacers || []).map(b => ({ b, x: st[b] || {} }));
  const pOutAll = pac.filter(p => p.x.out);
  const pOut = pOutAll.filter(p => !rDone(p.b));                     // 本当にコース上の可能性が高い
  const pGuess = pOutAll.filter(p => rDone(p.b));                    // 選手は戻っている（ペーサーの戻りは未記録）
  const pDone = pac.filter(p => !p.x.out && p.x.lastIn);             // 終了（戻りを記録）
  const pNoEnd = pac.filter(p => p.x.ck && !p.x.out && !p.x.lastIn);  // 受付済み・出発も終了も未記録
  const pNo = pac.filter(p => !p.x.ck && !p.x.out && !p.x.lastIn);
  const chip = (b, cls, sub) => `<span class="chip ${cls}">${esc(b)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>`;
  return `<div class="card"><div class="kpi">
      <div><b style="color:${onCourse.length + pOut.length ? 'var(--wait)' : 'var(--ok)'}">${onCourse.length + pOut.length}</b>いまコース上（選手${onCourse.length}・ペーサー${pOut.length}）</div>${pNoEnd.length ? `<div><b style="color:var(--wait)">${pNoEnd.length}</b>終了の記録がないペーサー</div>` : ''}
      <div><b>${fin.length}</b>フィニッシュ</div><div><b>${dn.length}</b>リタイア</div><div><b>${dns.length}</b>未受付（DNS候補）</div></div>
    ${late && onCourse.length + pOut.length ? `<div class="err" style="margin-top:8px;font-weight:800">最終関門（${hm(S.ev.cutoff)}）を過ぎています。コース上に残っている人を確認してください。</div>` : ''}
    <p class="sub">コース上の選手＝受付済みで、スタート後、フィニッシュもリタイアもしていない人。コース上のペーサー＝最後の記録が「ペーサー出発」で、伴走する選手がまだ戻っていない人。</p></div>
  <div class="card"><h3>コース上のペーサー（${pOut.length}人）</h3><div class="chips">${pOut.map(p => chip(p.b, late ? 'bad' : 'w', `No.${runnerOf(p.b)}と ${hm(p.x.lastOut.t)}〜`)).join('') || '<span class="sub">いません</span>'}</div>
    ${pGuess.length ? `<div class="sub" style="margin-top:8px"><b>選手は戻っている（ペーサーの戻りは未記録）</b></div><div class="chips">${pGuess.map(p => { const r = st[runnerOf(p.b)]; return chip(p.b, 'w', `No.${runnerOf(p.b)} ${r.gf ? 'ゴール' : 'リタイア'} ${hm((r.gf || r.dn).t)}`); }).join('')}</div>` : ''}
    <div class="sub" style="margin-top:8px"><b>受付済みで、終了の記録がないペーサー</b>（伴走を終えたら「ペーサー戻り」を記録。大会の最後に確認）</div>
    <div class="chips">${pNoEnd.map(p => chip(p.b, late ? 'bad' : '', `受付 ${hm(p.x.ck.t)}`)).join('') || '<span class="sub">なし</span>'}</div>
    <p class="sub">終了：${pDone.map(p => `${esc(p.b)}（${hm(p.x.lastIn.t)}）`).join('、') || 'なし'}　／　未受付：${pNo.map(p => esc(p.b)).join('、') || 'なし'}</p></div>
  ${overdueHTML(onCourse)}
  <div class="card"><h3>コース上の選手（${onCourse.length}人）</h3>${sectionsHTML(onCourse, late, chip)}
    ${waiting.length ? `<p class="sub">受付済み・スタート前：${waiting.map(r => esc(r.b)).join('、')}</p>` : ''}
    <p class="sub">リタイア：${dn.map(r => `${esc(r.b)}（${hm(r.x.dn.t)}）`).join('、') || 'なし'}</p></div>`;
}
/* 区間ごと（最後に通過した地点）に並べる */
function sectionsHTML(onCourse, late, chip) {
  if (!onCourse.length) return '<div class="chips"><span class="sub">いません</span></div>';
  const course = (S.ev.course || []).filter(k => k !== 'GF'); const lab = k => (S.ev.points.find(p => p.k === k) || { label: k }).label;
  const groups = [{ key: '', title: 'スタート〜' + (course[0] ? lab(course[0]) : 'フィニッシュ'), list: [] }, ...course.map((k, i) => ({ key: k, title: lab(k) + '〜' + (course[i + 1] ? lab(course[i + 1]) : 'フィニッシュ'), list: [] }))];
  onCourse.forEach(r => { const lp = C.lastPassed(S.ev, r.x); const g = groups.find(x => x.key === (lp && lp.k !== 'GF' ? lp.k : '')) || groups[0]; g.list.push({ r, lp }); });
  return groups.filter(g => g.list.length).map(g => `<div class="sub" style="margin-top:6px"><b>${esc(g.title)}</b>（${g.list.length}人）</div><div class="chips">${g.list.map(({ r, lp }) => chip(r.b, late ? 'bad' : 'w', lp ? `${lp.k} ${hm(lp.r.t)}` : '')).join('')}</div>`).join('');
}
/* CPの関門時刻を過ぎても、その地点を通過していない選手 */
function overdueHTML(onCourse) {
  const now = Date.now(); const cps = S.ev.points.filter(p => p.cutoff && (S.ev.course || []).includes(p.k) && now > Date.parse(p.cutoff));
  if (!cps.length) return '';
  const rows = cps.map(p => ({ p, list: onCourse.filter(r => !(r.x.pass && r.x.pass[p.k])) })).filter(x => x.list.length);
  if (!rows.length) return '';
  return `<div class="card" style="border:2px solid var(--bad)"><h3 style="color:var(--bad)">関門超過の可能性</h3>${rows.map(({ p, list }) => `<div class="sub" style="margin-top:6px"><b>${esc(p.label)}</b>（関門 ${hm(p.cutoff)}）を通過していない：${list.length}人</div><div class="chips">${list.map(r => `<span class="chip bad">${esc(r.b)}</span>`).join('')}</div>`).join('')}
    <p class="sub">記録の抜け（読み漏れ）の可能性もあります。CPのスタッフ・スイーパーに確認してください。</p></div>`;
}
/* 通過一覧・区間タイム（コースの順番で、時刻とスタートからの経過） */
function splitRows(live) {
  const st = C.peopleState(live); const course = S.ev.course || [];
  return Object.values(st).filter(x => !C.isPacer(x.bib) && course.some(k => x.pass[k])).map(x => {
    const c = C.catOf(S.ev, x.bib); const s0 = c && C.startOf(S.ev, S.starts, c.k);
    return { bib: x.bib, cat: c ? c.label : '', start: s0, cells: course.map(k => { const r = x.pass[k]; return r ? { t: r.t, el: s0 ? Date.parse(r.t) - Date.parse(s0) : null } : null; }), dn: x.dn };
  }).sort((a, b) => (+a.bib || 0) - (+b.bib || 0));
}
function splitHTML(live) {
  const course = S.ev.course || []; if (!course.length) return '';
  const rows = splitRows(live); const lab = k => (S.ev.points.find(p => p.k === k) || { label: k }).label;
  return `<div class="card"><h3>通過一覧・区間タイム（${rows.length}人）</h3>
    <p class="sub" style="margin-top:0">上の段：通過時刻、下の段：スタートからの経過時間。区間タイムはCSVにも入ります。</p>
    <div style="max-height:50vh;overflow:auto"><table><tr><th>No.</th><th>部門</th>${course.map(k => `<th>${esc(lab(k))}</th>`).join('')}<th></th></tr>
    ${rows.map(r => `<tr><td><b>${esc(r.bib)}</b></td><td>${esc(r.cat)}</td>${r.cells.map(c => `<td>${c ? `${hms(c.t)}<br><span class="sub">${dur(c.el)}</span>` : '—'}</td>`).join('')}<td>${r.dn ? '<span class="tag bad">リタイア</span>' : ''}</td></tr>`).join('') || `<tr><td colspan="${course.length + 3}" class="sub">まだありません</td></tr>`}</table></div>
    <div class="row" style="margin-top:8px"><button class="btn sec" id="expSplit" ${rows.length ? '' : 'disabled'}>通過一覧・区間タイムをCSVで書き出す</button></div></div>`;
}
function splitCSV(live) {
  const course = S.ev.course || [], lab = k => (S.ev.points.find(p => p.k === k) || { label: k }).label, q = v => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  const head = ['ゼッケン', '部門', 'スタート', ...course.flatMap((k, i) => [lab(k) + ' 通過時刻', lab(k) + ' 経過', ...(i ? [lab(course[i - 1]) + '→' + lab(k) + ' 区間'] : [])]), 'リタイア'];
  const body = splitRows(live).map(r => [r.bib, r.cat, r.start ? hms(r.start) : '', ...r.cells.flatMap((c, i) => { const prev = i ? r.cells[i - 1] : null; return [c ? hms(c.t) : '', c ? dur(c.el) : '', ...(i ? [c && prev ? dur(Date.parse(c.t) - Date.parse(prev.t)) : ''] : [])]; }), r.dn ? hms(r.dn.t) : ''].map(q).join(','));
  return '\ufeff' + [head.map(q).join(','), ...body].join('\r\n') + '\r\n';
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
  ${splitHTML(live)}
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
const ROLE_HELP = {
  ck: 'このリンクかQRを開くだけで、その端末が<b>受付専用</b>になります（入力やログインは不要）。記録できるのは「受付」「ペーサー出発」「ペーサー戻り」だけです。スタッフのLINEに流すか、QRを印刷して受付テントに貼ってください。',
  sweep: 'スイーパーに送ってください。開くだけで、その端末が<b>スイーパー</b>になります。記録できるのは「リタイア（下山確認）」だけです。山の中で圏外でも端末に保存され、電波が入ると本部に届きます。',
};
function linkCard(role) {
  const L = C.LINK_ROLES[role], ld = S.code == null, code = S.code && S.code[L.codeKey], link = code ? C.roleLink(role, code) : '';
  return `<div class="card"><h3>${L.name}</h3><p class="sub" style="margin-top:0">${ROLE_HELP[role]}</p>
    ${ld ? '読み込み中…' : code ? `<div class="row" style="align-items:flex-start"><div class="qrbox">${qrSVG(link)}</div><div style="flex:1;min-width:240px"><div class="sub">リンク</div><div class="link">${esc(link)}</div>
      <div class="row" style="margin-top:8px"><button class="btn" data-copy="${role}">リンクをコピー</button><button class="btn sec" data-print="${role}">QRを印刷</button><button class="btn sec" data-new="${role}">リンクを作り直す</button></div>
      <p class="sub">作り直すと古いリンクでは新しく登録できなくなります（登録済みの端末はそのまま使えます）。</p></div></div>`
      : `<button class="btn" data-new="${role}">${L.name}を作る</button>`}</div>`;
}
/* CP担当用リンク：大会のCPごとに1つ（コードは共通。リンクで担当のCPが決まる） */
function cpCard() {
  const cps = S.ev.points.filter(p => p.cp); if (!cps.length) return '';
  const ld = S.code == null, code = S.code && S.code.cpCode;
  return `<div class="card"><h3>CP担当用リンク（CPごと）</h3><p class="sub" style="margin-top:0">各CPのスタッフに、そのCPのリンクを送ってください。開くだけで、その端末は<b>担当のCPの通過とリタイアだけ</b>を記録できるようになります。山の中で圏外でも端末に保存され、電波が入ると本部に届きます。</p>
    ${ld ? '読み込み中…' : !code ? '<button class="btn" data-new="cp">CP担当用リンクを作る</button>' : cps.map(p => { const link = C.roleLink('cp', code, p.k); return `<div class="row" style="align-items:flex-start;border-top:1px solid var(--line);padding-top:8px;margin-top:8px"><div class="qrbox" style="width:130px">${qrSVG(link)}</div><div style="flex:1;min-width:240px"><b>${esc(p.label)}</b>${p.cutoff ? `　<span class="sub">関門 ${hm(p.cutoff)}</span>` : ''}<div class="link">${esc(link)}</div>
      <div class="row" style="margin-top:6px"><button class="btn" data-copycp="${esc(p.k)}">リンクをコピー</button><button class="btn sec" data-printcp="${esc(p.k)}">QRを印刷</button></div></div></div>`; }).join('') + '<p class="sub">「リンクを作り直す」で、すべてのCPのリンクがまとめて新しくなります（登録済みの端末はそのまま）。</p><button class="btn sec" data-new="cp">リンクを作り直す</button>'}</div>`;
}
/* ---- スタッフ担当（スタッフ用「今日の担当」へ反映） ---- */
function staffHTML() {
  const b = S.svIn, cur = S.sv, curT = new Set(cur.map(c => c.tok));
  const nT = b ? Object.keys(b.views) : [];
  const add = nT.filter(t => !curT.has(t)).length, upd = nT.length - add, del = b ? cur.filter(c => !b.views[c.tok]).length : 0;
  return `<div class="card"><h3>スタッフ用「今日の担当」に反映する</h3>
    <p class="sub" style="margin-top:0">本部統括の「本部：スタッフ用リンク」で「スタッフ用ページへ送る内容をコピー」し、下に貼り付けて「反映」します。予定や時刻を直したときも同じ手順です。スタッフの画面は、通信できるときに最新版を取り直します。</p>
    <textarea id="svText" rows="3" placeholder="ここに貼り付け" style="width:100%;font:inherit;padding:8px;border:2px solid var(--line);border-radius:8px"></textarea>
    <div class="row" style="margin-top:6px"><button class="btn sec" id="svRead">読み取って確認</button>
    ${b ? `<span>反映すると：<b>${nT.length}人分</b>（新しく ${add}・更新 ${upd}）${del ? `、<b class="err">${del}人分のリンクを止める</b>` : ''}　作成 ${esc((b.made || '').replace('T', ' ').slice(5, 16))}</span><button class="btn" id="svGo">反映</button>` : ''}</div>
    ${b && b.skipped && b.skipped.length ? `<div class="sub">リンク未発行・停止中：${b.skipped.map(esc).join('、')}</div>` : ''}
    ${b && !b.msgr && Object.values(b.views).some(v => v.o && v.o.report) ? '<div class="err">報告先のMessengerのリンクが未設定です（本部統括の「本部：スタッフ用リンク」で設定）</div>' : ''}
    <div class="sub" id="svMsg">${esc(S.svMsg)}</div></div>
  <div class="card"><h3>いま開けるリンク（${cur.length}人）</h3>
    <table><tr><th>氏名</th><th>反映</th><th>受付・計測・報告</th><th></th></tr>
    ${cur.map(c => { let v = {}; try { v = JSON.parse(c.j); } catch (e) {} const L = v.links || {};
      return `<tr><td>${esc(c.name)}</td><td class="sub">${c.pub && c.pub.toDate ? hm(c.pub.toDate().toISOString()) : '…'}</td>
      <td class="sub">${[L.ck ? '受付' : '', L.timer ? '計測' : '', v.report ? '報告（' + esc(v.report.team) + '）' : ''].filter(Boolean).join('・') || '—'}</td>
      <td><a class="btn sec" href="${esc(C.STAFF_PAGE + '#k=' + c.tok + (C.EVENT_ID !== 'kq50-2026' ? '&ev=' + C.EVENT_ID : ''))}" target="_blank" rel="noopener">開く</a> <button class="btn sec" data-svstop="${esc(c.tok)}">すぐ止める</button></td></tr>`; }).join('') || '<tr><td colspan="4" class="sub">まだありません</td></tr>'}
    </table><div class="sub">「すぐ止める」を押すと、その人のリンクはすぐ開けなくなります（本部統括側でも「止める」か「再発行」をしておいてください）。</div></div>`;
}
function devHTML() {
  const ld = S.code == null;
  return linkCard('ck') + linkCard('sweep') + cpCard() + `
  <div class="card"><h3>計測担当の参加コード</h3><p class="sub" style="margin-top:0">「1周目終了」「フィニッシュ」を記録する計測担当は、このコードを入れて端末を登録します（Googleアカウント不要）。受付スタッフには教えないでください。</p>
    <div class="row">いまのコード：<b style="font-size:24px;letter-spacing:.1em">${ld ? '…' : esc(S.code.code) || '（未設定）'}</b>
    <button class="btn sec" id="newCode">${S.code && S.code.code ? 'コードを変える' : 'コードを作る'}</button></div></div>
  <div class="card"><h3>登録された端末（${S.devices.length}台）</h3><table><tr><th>端末の名前</th><th>役割</th><th>端末</th><th>登録</th><th>記録</th><th>状態</th><th></th></tr>
    ${S.devices.map(d => { const n = S.recs.filter(r => r.by === d.uid).length;
      return `<tr><td><b>${esc(d.label)}</b></td><td>${C.roleLabel(d.role, d.pt)}</td><td>${esc(d.dev || '')}</td><td>${d.at ? ymdhms(d.at).slice(5, 16) : ''}</td><td>${n}件</td><td>${d.active === false ? '<span class="tag bad">停止中</span>' : '<span class="tag ok">使用中</span>'}</td>
      <td><button class="btn sec" data-dev="${esc(d.uid)}" data-act="${d.active === false ? 1 : 0}">${d.active === false ? '再開' : '停止'}</button></td></tr>`; }).join('') || '<tr><td colspan="7" class="sub">まだ登録された端末はありません</td></tr>'}</table>
    <p class="sub">紛失した端末や、心当たりのない端末は「停止」すると、その端末からは本部に送れなくなります（端末に残った記録はCSVで回収できます）。</p></div>
  <div class="card" style="border:2px solid var(--bad)"><h3>本番前リセット（テストの記録を片付ける）</h3>
    <p class="sub" style="margin-top:0">大会前のテストが終わったら押してください。<b>本部の記録（${S.recs.length}件）とスタート時刻の修正を消し</b>、各端末には次に通信したときに「リセットより前の記録を片付ける」合図が届きます（端末の記録は消さずに別に取っておきます）。<br>
    <b>残るもの</b>：登録した端末・受付用リンク・スイーパー用リンク・参加コード（配ったリンクやQRはそのまま本番で使えます）。<br>
    リセットのあとに届いた、リセット前に読んだ記録は受け付けません。<b>大会が始まってからは押さないでください。</b></p>
    ${S.resetAt ? `<p class="sub">前回のリセット：${ymdhms(new Date(S.resetAt).toISOString()).slice(0, 16)}</p>` : ''}
    <div class="row">確認のため大会のID「<b>${esc(C.EVENT_ID)}</b>」を入力：<input id="rsId" placeholder="${esc(C.EVENT_ID)}" autocomplete="off"><button class="btn" id="rsGo" style="background:var(--bad)">本番前リセットを実行</button></div>
    <div id="rsMsg" class="sub"></div></div>`;
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
function bindStaff() {
  const r = $('#svRead'); if (!r) return;
  r.onclick = () => { try { const b = JSON.parse($('#svText').value.trim()); if (b.kind !== '7trails-staff-bundle' || !b.views) throw new Error(); if (b.ev && b.ev !== C.EVENT_ID) { S.svMsg = `貼り付けた内容は ${b.ev} 用です。上で大会を切り替えてください`; S.svIn = null; } else { S.svIn = b; S.svMsg = ''; } } catch (e) { S.svIn = null; S.svMsg = '読み取れませんでした。本部統括でコピーした内容を、そのまま貼り付けてください'; } render(); };
  const g = $('#svGo'); if (g) g.onclick = async () => {
    const b = S.svIn; const del = S.sv.filter(c => !b.views[c.tok]).length;
    if (del && !confirm(`${del}人分のリンクが開けなくなります。よろしいですか？`)) return;
    g.disabled = true; S.svMsg = '反映中…'; render();
    try { const codes = S.code || await C.getJoinCodes(); const x = await C.publishStaffBundle(b, S.sv, codes); S.svIn = null; S.svMsg = `反映しました（${x.set}人分${x.del ? `、${x.del}人分を停止` : ''}）。${new Date().toLocaleTimeString('ja-JP')}`; }
    catch (e) { S.svMsg = '反映できませんでした：' + C.errText(e); }
    render();
  };
  $$('[data-svstop]').forEach(b => b.onclick = async () => { if (!confirm('このリンクをすぐ止めます。よろしいですか？')) return; try { await C.stopStaffView(b.dataset.svstop); } catch (e) { alert(C.errText(e)); } });
}
function bind() {
  bindStaff();
  const ng = $('#ntGo'); if (ng) ng.onclick = async () => {
    const t = $('#ntText').value.trim(), imp = $('#ntImp').checked; if (!t) { $('#ntMsg').textContent = 'お知らせの文を入れてください'; return; }
    if (!confirm(`次のお知らせを選手向けに公開します。よろしいですか？\n\n${imp ? '【重要】' : ''}${t}`)) return;
    ng.disabled = true;
    try { await C.addNotice(t, imp); $('#ntText').value = ''; S.ntMsg = '公開しました。大会案内に1分以内に表示されます。'; } catch (e) { S.ntMsg = '公開できませんでした：' + C.errText(e); }
    ng.disabled = false; render(); const m = $('#ntMsg'); if (m) m.textContent = S.ntMsg;
  };
  $$('[data-nhide]').forEach(b => b.onclick = async () => { try { await C.updateNotice(b.dataset.nhide, { hidden: b.dataset.v === '1' }); } catch (e) { alert(C.errText(e)); } });
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
  $$('[data-new]').forEach(b => b.onclick = async () => {
    const role = b.dataset.new, L = C.LINK_ROLES[role];
    if (S.code[L.codeKey] && !confirm(`${L.name}を作り直します。古いリンクでは新しく登録できなくなります。よろしいですか？`)) return;
    const v = rnd(10);
    try { await C.setJoinCode(L.codeKey, v); S.code[L.codeKey] = v; } catch (e) { alert(C.errText(e)); } render();
  });
  $$('[data-copy]').forEach(b => b.onclick = async () => { const l = C.roleLink(b.dataset.copy, S.code[C.LINK_ROLES[b.dataset.copy].codeKey]); try { await navigator.clipboard.writeText(l); b.textContent = 'コピーしました'; } catch (e) { prompt('このリンクをコピーしてください', l); } });
  $$('[data-copycp]').forEach(b => b.onclick = async () => { const l = C.roleLink('cp', S.code.cpCode, b.dataset.copycp); try { await navigator.clipboard.writeText(l); b.textContent = 'コピーしました'; } catch (e) { prompt('このリンクをコピーしてください', l); } });
  $$('[data-printcp]').forEach(b => b.onclick = () => {
    const p = S.ev.points.find(x => x.k === b.dataset.printcp), link = C.roleLink('cp', S.code.cpCode, p.k); const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><meta charset="utf-8"><title>${esc(p.label)} 用QR</title><body style="font-family:sans-serif;text-align:center;padding:40px"><h1 style="font-size:40px;margin:0">${esc(p.label)}　担当用</h1><p style="font-size:22px">${esc(S.ev.name)}</p><div style="width:420px;margin:20px auto">${qrSVG(link)}</div><p style="font-size:20px">スマホのカメラで読み取り、開いたページで通過を記録してください</p><p style="font-size:12px;color:#666;word-break:break-all">${esc(link)}</p><script>setTimeout(()=>print(),300)<\/script></body>`);
    w.document.close();
  });
  $$('[data-print]').forEach(b => b.onclick = () => {
    const role = b.dataset.print, L = C.LINK_ROLES[role], link = C.roleLink(role, S.code[L.codeKey]); const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><meta charset="utf-8"><title>${L.short}用QR</title><body style="font-family:sans-serif;text-align:center;padding:40px"><h1 style="font-size:40px;margin:0">${L.short}スタッフ用</h1><p style="font-size:22px">${esc(S.ev.name)}</p><div style="width:420px;margin:20px auto">${qrSVG(link)}</div><p style="font-size:20px">スマホのカメラで読み取り、開いたページで記録してください</p><p style="font-size:12px;color:#666;word-break:break-all">${esc(link)}</p><script>setTimeout(()=>print(),300)<\/script></body>`);
    w.document.close();
  });
  const rg = $('#rsGo'); if (rg) rg.onclick = async () => {
    if ($('#rsId').value.trim() !== C.EVENT_ID) { $('#rsMsg').textContent = `大会のID「${C.EVENT_ID}」を正しく入力してください`; return; }
    if (!confirm(`「${S.ev.name}」の本部の記録 ${S.recs.length} 件とスタート時刻の修正を消します。元に戻せません。よろしいですか？`)) return;
    rg.disabled = true; $('#rsMsg').textContent = 'リセットしています…';
    try { const r = await C.resetEvent(); S.resetAt = r.epoch; S.resetMsg = `リセットしました（記録 ${r.n} 件を消しました）。各端末は次に通信したときにテストの記録を片付けます。`; }
    catch (e) { S.resetMsg = 'リセットできませんでした：' + C.errText(e); }
    render(); const m = $('#rsMsg'); if (m) m.textContent = S.resetMsg || '';
  };
  $$('[data-dev]').forEach(b => b.onclick = async () => { const act = b.dataset.act === '1'; if (!act && !confirm('この端末を停止しますか？')) return; try { await C.setDeviceActive(b.dataset.dev, act); } catch (e) { alert(C.errText(e)); } });
  const f = $('#csv'); if (f) f.onchange = e => readCSV(e.target.files[0]);
  const es = $('#expSplit'); if (es) es.onclick = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); C.saveFile(`通過一覧_${C.EVENT_ID}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.csv`, splitCSV(derived().live)); };
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
  S.ev = await C.loadEvent(id); S.recs = []; S.starts = {}; S.devices = []; S.code = null; S.notices = []; S.sv = []; S.svIn = null; S.svMsg = ''; S.resetAt = null; S.resetMsg = ''; S.imp = null; S.impMsg = ''; S.err = '';
  unsubs.forEach(f => f()); unsubs = [];
  if (isAdmin()) {
    const er = e => { S.err = '読めません：' + C.errText(e); render(); };
    unsubs.push(C.watchRecords((rs, meta) => { S.recs = rs; S.meta = meta; render(); }, er));
    unsubs.push(C.watchStarts(st => { S.starts = st; render(); }, er));
    unsubs.push(C.watchDevices(ds => { S.devices = ds; render(); }, er));
    unsubs.push(C.watchReset(ep => { S.resetAt = ep; render(); }, () => {}));
    unsubs.push(C.watchNotices(ns => { S.notices = ns; render(); }, er));
    unsubs.push(C.watchStaffViews(v => { S.sv = v.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ja')); render(); }, er));
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
