/* 計測端末・本部画面で共通の部品
   - 端末内の記録台帳（IndexedDB）：読んだ瞬間に1件ずつ保存し、ブラウザを閉じても残す
   - Firebase：通信できるときだけ使う。記録の正本はまず端末、本部に届いたら「受領済み」
   - 受付スタッフの端末は「参加コード」で登録（Googleアカウント不要）。本部は Google ログイン
   - CSV：圏外でも作れる */
import * as FB from './vendor/firebase.js';

export const BUILD = window.__BUILD || { text: '開発版', commit: 'dev' };
export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAfuBxAeCQOhvdOurFOxpRysamQpz8lUJk',
  authDomain: 'trails-race.firebaseapp.com',
  projectId: 'trails-race',
  storageBucket: 'trails-race.firebasestorage.app',
  messagingSenderId: '279271996958',
  appId: '1:279271996958:web:d65042d081763ddeb6380f',
};
export const DEFAULT_EVENT = 'test-kq50';
export let EVENT_ID = DEFAULT_EVENT;
export function setEventId(id) { EVENT_ID = id; }

export const $ = s => document.querySelector(s);
export const $$ = s => [...document.querySelectorAll(s)];
export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const pad = (n, w = 2) => String(n).padStart(w, '0');
export const hms = iso => { if (!iso) return '—'; const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
export const hm = iso => { if (!iso) return '—'; const d = new Date(iso); return `${d.getHours()}:${pad(d.getMinutes())}`; };
export const ymdhms = iso => { if (!iso) return ''; const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; };
/** 経過時間（ミリ秒）→ 7:12:33 */
export const dur = ms => { if (ms == null || isNaN(ms)) return '—'; if (ms < 0) return 'スタート前'; const neg = false; ms = Math.abs(Math.floor(ms / 1000)); return (neg ? '-' : '') + `${Math.floor(ms / 3600)}:${pad(Math.floor(ms / 60) % 60)}:${pad(ms % 60)}`; };

/* ---------- 大会の設定 ---------- */
export async function loadEvent(id) { const r = await fetch('events/' + id + '.json'); if (!r.ok) throw new Error('大会の設定を読めません'); return r.json(); }
export async function loadEventList() { const r = await fetch('events/index.json'); return r.ok ? r.json() : []; }
export const isPacer = bib => /^P-/.test(String(bib));
export const PACER_CAT = { k: 'P', label: 'ペーサー' };
export const catOf = (ev, bib) => isPacer(bib) ? PACER_CAT : (ev && ev.cats.find(c => +bib >= c.from && +bib <= c.to) || null);
/** 読み取った文字から番号を取り出す：ペーサーは P-23 / P-17-1、選手は数字 */
export function bibOf(raw) {
  const s = String(raw).normalize('NFKC').toUpperCase().replace(/\s/g, '');
  // 「P23」「P-17-1」だけの文字、または文中の「P-23」（直前が英字でない）をペーサーとみなす
  // 手入力では「P17.1」も P-17-1 とみなす（数字キーボードに - がないため）
  const p = s.match(/^P-?(\d{1,4}(?:[-.]\d{1,2})?)$/) || s.match(/(?:^|[^A-Z])P-(\d{1,4}(?:-\d{1,2})?)(?!\d)/); if (p) return 'P-' + p[1].replace('.', '-').replace(/^0+(?=\d)/, '');
  const m = s.match(/\d{1,5}/); return m ? String(+m[0]) : null;
}
export const knownBib = (ev, bib) => !ev ? true : isPacer(bib) ? (ev.pacers || []).includes(bib) : ev.bibs.includes(+bib);
/** 人ごとの状態（取り消されていない記録から）：受付・コース上・フィニッシュ・リタイア */
export function peopleState(live) {
  const st = {}; const g = b => st[b] || (st[b] = { bib: b, ck: null, out: false, lastOut: null, lastIn: null, outs: 0, gf: null, dn: null, g1: null });
  [...live].sort((a, b) => Date.parse(a.t) - Date.parse(b.t)).forEach(r => {
    const x = g(r.bib);
    if (r.pt === 'CK') { if (!x.ck) x.ck = r; }
    else if (r.pt === 'PO') { x.out = true; x.lastOut = r; x.outs++; }
    else if (r.pt === 'PI') { x.out = false; x.lastIn = r; }
    else if (r.pt === 'GF') { if (!x.gf) x.gf = r; }
    else if (r.pt === 'DN') { if (!x.dn) x.dn = r; }
    else if (r.pt === 'G1') { if (!x.g1) x.g1 = r; }
  });
  return st;
}
/** 部門のスタート時刻：本部が直した時刻があればそれ、なければ予定時刻 */
export const startOf = (ev, starts, catK) => { const s = starts && starts[catK]; if (s && s.actual) return s.actual; const c = ev && ev.cats.find(x => x.k === catK); return c ? c.start : null; };

/* ---------- 端末内の記録台帳 ---------- */
let _db = null;
function idb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((ok, ng) => {
    const r = indexedDB.open('7trails-timing', 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('recs', { keyPath: 'id' }); d.createObjectStore('meta'); };
    r.onsuccess = () => { _db = r.result; ok(_db); };
    r.onerror = () => ng(r.error);
  });
}
const done = tx => new Promise((ok, ng) => { tx.oncomplete = () => ok(); tx.onerror = () => ng(tx.error); tx.onabort = () => ng(tx.error || new Error('保存が中断されました')); });
const req = r => new Promise((ok, ng) => { r.onsuccess = () => ok(r.result); r.onerror = () => ng(r.error); });

export async function metaGet(k, d = null) { const t = (await idb()).transaction('meta'); const v = await req(t.objectStore('meta').get(k)); return v === undefined ? d : v; }
export async function metaSet(k, v) { const t = (await idb()).transaction('meta', 'readwrite'); t.objectStore('meta').put(v, k); await done(t); }

/** この端末の名前（4文字）。初回に作って以後変えない */
export async function deviceId() {
  let d = await metaGet('dev');
  if (!d) { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; d = Array.from(crypto.getRandomValues(new Uint8Array(4)), x => a[x % a.length]).join(''); await metaSet('dev', d); }
  return d;
}

/** 記録を1件、通し番号つきで保存する。保存が完了してから返る（画面に「保存済み」と出すのはその後） */
export async function addRecord(r) {
  const dev = await deviceId();
  const t = (await idb()).transaction(['recs', 'meta'], 'readwrite');
  const meta = t.objectStore('meta');
  const seq = ((await req(meta.get('seq'))) || 0) + 1;
  meta.put(seq, 'seq');
  const rec = { ...r, id: `${EVENT_ID}-${dev}-${pad(seq, 5)}`, dev, seq, ev: EVENT_ID, status: 'saved', savedAt: new Date().toISOString() };
  t.objectStore('recs').put(rec);
  await done(t);
  return rec;
}
export async function allRecords() { const t = (await idb()).transaction('recs'); const a = await req(t.objectStore('recs').getAll()); return a.filter(x => x.ev === EVENT_ID).sort((x, y) => x.seq - y.seq); }
export async function updateRecord(id, patch) {
  const t = (await idb()).transaction('recs', 'readwrite'); const s = t.objectStore('recs');
  const cur = await req(s.get(id)); if (!cur) return null; const nx = { ...cur, ...patch }; s.put(nx); await done(t); return nx;
}
/** 取り消された記録のIDの集合（取消の記録 pt=VOID が target を指す） */
export const voidedIds = recs => new Set(recs.filter(r => r.pt === 'VOID' && r.target).map(r => r.target));

/* ---------- CSV ---------- */
export const CSV_COLS = [
  ['id', '記録ID'], ['bib', 'ゼッケン'], ['pt', '地点コード'], ['ptLabel', '地点'], ['t', '読んだ時刻'], ['dev', '端末'], ['label', '端末の名前'],
  ['how', '読み方'], ['raw', '読み取った文字'], ['warn', '警告'], ['target', '取り消した記録ID'], ['status', '状態'], ['receivedAt', '本部受領時刻'],
];
const q = v => { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export function toCSV(rows, ptLabel) {
  const head = CSV_COLS.map(c => c[1]).join(',');
  const body = rows.map(r => CSV_COLS.map(([k]) => {
    if (k === 'ptLabel') return q(ptLabel(r.pt));
    if (k === 't' || k === 'receivedAt') return q(ymdhms(r[k]));
    if (k === 'status') return q(r.status === 'received' ? '本部に受領済み' : '端末に保存済み');
    if (k === 'warn') return q((r.warn || []).join(' / '));
    return q(r[k]);
  }).join(',')).join('\r\n');
  return '﻿' + head + '\r\n' + body + '\r\n';
}
export function parseCSV(text) {
  const rows = []; let row = [], f = '', i = 0, inq = false; text = text.replace(/^﻿/, '');
  while (i < text.length) {
    const c = text[i];
    if (inq) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else inq = false; } else f += c; }
    else if (c === '"') inq = true; else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
    i++;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x !== ''));
}
/** 計測端末のCSVを記録に戻す（本部での取り込み用） */
export function csvToRecords(text) {
  const rows = parseCSV(text); if (!rows.length) return [];
  const h = rows[0]; const ix = Object.fromEntries(CSV_COLS.map(([k, l]) => [k, h.indexOf(l)]));
  if (ix.id < 0 || ix.bib < 0 || ix.pt < 0 || ix.t < 0) throw new Error('計測端末のCSVではありません（記録ID・ゼッケン・地点コード・読んだ時刻の列が必要です）');
  const g = (r, k) => ix[k] >= 0 ? r[ix[k]] : '';
  return rows.slice(1).map(r => {
    const d = new Date(r[ix.t].replace(' ', 'T'));
    return { id: r[ix.id], bib: r[ix.bib], pt: r[ix.pt], t: isNaN(d) ? null : d.toISOString(), dev: g(r, 'dev'), label: g(r, 'label'), how: g(r, 'how') || 'CSV', raw: g(r, 'raw'), target: g(r, 'target'), warn: g(r, 'warn') ? g(r, 'warn').split(' / ') : [] };
  }).filter(r => r.id && r.bib && r.pt && r.t && r.id.startsWith(EVENT_ID + '-'));
}
export async function saveFile(name, text) {
  const blob = new Blob([text], { type: 'text/csv' });
  const file = new File([blob], name, { type: 'text/csv' });
  // iPhone：共有メニューから「ファイルに保存」できる（圏外でも可）
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return 'share'; } catch (e) { if (e && e.name === 'AbortError') return 'cancel'; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); return 'download';
}

/* ---------- Firebase ---------- */
let fb = null;
export function firebase() {
  if (fb) return fb;
  // 本部画面は別の名前で初期化し、同じブラウザの計測端末（参加コードの登録）とログイン状態を分ける
  const app = FB.initializeApp(FIREBASE_CONFIG, window.__APPNAME || '[DEFAULT]');
  const auth = FB.getAuth(app);
  const db = FB.initializeFirestore(app, { localCache: FB.memoryLocalCache() });
  fb = { app, auth, db };
  return fb;
}
const evPath = p => `events/${EVENT_ID}/${p}`;
export function onUser(cb) { return FB.onAuthStateChanged(firebase().auth, cb); }
export async function login() { const p = new FB.GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' }); return FB.signInWithPopup(firebase().auth, p); }
export async function logout() { return FB.signOut(firebase().auth); }
export const recPath = id => evPath('records/' + id);
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, ng) => setTimeout(() => ng(new Error(msg)), ms))]);

/** スタッフの端末を参加コードで登録する（Googleアカウント不要）。登録済みなら何もしない
    role：'timer'（計測担当：参加コード）／'ck'（受付：受付用リンクのコード） */
export async function joinWithCode(code, label, role = 'timer') {
  const { auth, db } = firebase();
  if (!auth.currentUser) await withTimeout(FB.signInAnonymously(auth), 15000, '通信できないため登録できません');
  const uid = auth.currentUser.uid, ref = FB.doc(db, evPath('devices/' + uid));
  const cur = await withTimeout(FB.getDocFromServer(ref), 15000, '通信できないため登録できません').catch(e => { if (e.code === 'permission-denied') return null; throw e; });
  if (cur && cur.exists()) { if (cur.get('active') === false) throw new Error('この端末は本部で停止されています'); return { uid, already: true, role: cur.get('role') || 'timer', label: cur.get('label') }; }
  try { await withTimeout(FB.setDoc(ref, { code: String(code).trim(), role, label: label || '', dev: await deviceId(), active: true, at: FB.serverTimestamp() }), 15000, '通信できないため登録できません'); }
  catch (e) { if (e.code === 'permission-denied') throw new Error(role === 'ck' ? '受付用リンクが古いか違います（本部に新しいリンクをもらってください）' : '参加コードが違います'); throw e; }
  return { uid, already: false, role, label };
}
/** この端末が登録済みか（通信できるときだけ確かめる） */
export async function myDevice() {
  const { auth, db } = firebase(); const u = auth.currentUser; if (!u) return null;
  try { const s = await withTimeout(FB.getDocFromServer(FB.doc(db, evPath('devices/' + u.uid))), 10000, 'timeout'); return s.exists() ? s.data() : null; } catch (e) { return undefined; }
}

/** 1件を本部に送る。同じIDがすでに本部にあれば、新しく作らず「受領済み」として扱う。戻り値：{ receivedAt, already, clk } */
export async function sendRecord(r, extra = {}) {
  const { db, auth } = firebase();
  const u = auth.currentUser; if (!u) throw new Error('登録していません（参加コードを入れてください）');
  const ref = FB.doc(db, recPath(r.id));
  const data = { id: r.id, bib: String(r.bib), pt: r.pt, t: r.t, tMs: Date.parse(r.t), dev: r.dev, label: r.label || '', seq: r.seq || 0, how: r.how || '', raw: r.raw || '', warn: r.warn || [],
    target: r.target || '', by: u.uid, byEmail: u.email || '', receivedAt: FB.serverTimestamp(), via: r.via || 'terminal', clk: extra.clk == null ? null : extra.clk };
  const t0 = Date.now();
  const already = await withTimeout(FB.runTransaction(db, async tx => {
    const s = await tx.get(ref);
    if (s.exists()) return true;
    tx.set(ref, data); return false;
  }), 20000, '本部に接続できませんでした（時間切れ）');
  const snap = await withTimeout(FB.getDocFromServer(ref), 15000, '受領の確認ができませんでした（時間切れ）');
  const t1 = Date.now(), ra = snap.get('receivedAt');
  const receivedAt = ra ? ra.toDate().toISOString() : new Date().toISOString();
  // 端末の時計と本部の時計の差（ミリ秒、＋なら端末が遅れている）。新しく作れたときだけ測る
  const clk = already || !ra ? null : Math.round(ra.toMillis() - (t0 + t1) / 2);
  return { receivedAt, already, clk };
}
const recOut = d => { const x = d.data(); return { ...x, receivedAt: x.receivedAt ? x.receivedAt.toDate().toISOString() : null }; };
export function watchRecords(cb, err) {
  const { db } = firebase();
  return FB.onSnapshot(FB.query(FB.collection(db, evPath('records')), FB.orderBy('tMs')), { includeMetadataChanges: true },
    s => cb(s.docs.map(recOut), s.metadata), err);
}
export function watchStarts(cb, err) {
  const { db } = firebase();
  return FB.onSnapshot(FB.collection(db, evPath('starts')), s => { const o = {}; s.docs.forEach(d => o[d.id] = d.data()); cb(o); }, err);
}
export function watchDevices(cb, err) {
  const { db } = firebase();
  return FB.onSnapshot(FB.collection(db, evPath('devices')), s => cb(s.docs.map(d => ({ uid: d.id, ...d.data(), at: d.get('at') ? d.get('at').toDate().toISOString() : null }))), err);
}
/** 本部：実際のスタート時刻を直す（履歴を残す） */
export async function setStart(catK, actualIso, reason, prev) {
  const { db, auth } = firebase(); const u = auth.currentUser;
  const hist = [...((prev && prev.history) || []), { at: new Date().toISOString(), by: u.email || u.uid, from: (prev && prev.actual) || null, to: actualIso, reason: reason || '' }];
  await FB.setDoc(FB.doc(db, evPath('starts/' + catK)), { actual: actualIso, history: hist });
}
export async function getJoinCodes() { const { db } = firebase(); const s = await FB.getDoc(FB.doc(db, evPath('private/join'))); return s.exists() ? { code: s.get('code') || '', ckCode: s.get('ckCode') || '' } : { code: '', ckCode: '' }; }
/** k：'code'（計測担当の参加コード）／'ckCode'（受付用リンクのコード） */
export async function setJoinCode(k, v) { const { db } = firebase(); await FB.setDoc(FB.doc(db, evPath('private/join')), { [k]: String(v) }, { merge: true }); }
export const ckLink = (ckCode) => new URL(`./?ev=${encodeURIComponent(EVENT_ID)}&ck=${encodeURIComponent(ckCode)}`, location.href).href;
export async function setDeviceActive(uid, active) { const { db } = firebase(); await FB.updateDoc(FB.doc(db, evPath('devices/' + uid)), { active }); }

export function errText(e) {
  const c = e && e.code;
  if (c === 'permission-denied') return '権限がありません（参加コードで登録するか、本部のアカウントでログインしてください）';
  if (c === 'unavailable') return '通信できません';
  if (c === 'auth/popup-blocked') return 'ログイン画面が開けませんでした。もう一度押してください';
  if (c === 'auth/popup-closed-by-user' || c === 'auth/cancelled-popup-request') return 'ログインを中止しました';
  if (c === 'auth/network-request-failed') return '通信できないためログインできません';
  if (c === 'auth/admin-restricted-operation' || c === 'auth/operation-not-allowed') return 'Firebaseで「匿名」ログインが有効になっていません';
  if (c === 'auth/unauthorized-domain') return 'このページのドメインがFirebaseで許可されていません（承認済みドメインを確認）';
  return (e && e.message) || String(e);
}
