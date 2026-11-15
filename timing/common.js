/* 計測端末・本部確認画面で共通の部品
   - 端末内の記録台帳（IndexedDB）：読んだ瞬間に1件ずつ保存し、ブラウザを閉じても残す
   - Firebase：通信できるときだけ使う。記録の正本はまず端末、本部に届いたら「受領済み」
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
export const EVENT_ID = 'test-kq50';

export const $ = s => document.querySelector(s);
export const $$ = s => [...document.querySelectorAll(s)];
export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const pad = (n, w = 2) => String(n).padStart(w, '0');
export const hms = iso => { if (!iso) return '—'; const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
export const ymdhms = iso => { if (!iso) return ''; const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; };

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

/* ---------- CSV ---------- */
export const CSV_COLS = [
  ['id', '記録ID'], ['bib', 'ゼッケン'], ['pt', '地点コード'], ['ptLabel', '地点'], ['t', '読んだ時刻'], ['dev', '端末'],
  ['how', '読み方'], ['raw', '読み取った文字'], ['warn', '警告'], ['status', '状態'], ['receivedAt', '本部受領時刻'],
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
  return rows.slice(1).map(r => {
    const tv = r[ix.t].replace(' ', 'T'); const d = new Date(tv);
    return { id: r[ix.id], bib: r[ix.bib], pt: r[ix.pt], t: isNaN(d) ? null : d.toISOString(), dev: ix.dev >= 0 ? r[ix.dev] : '', how: ix.how >= 0 ? r[ix.how] : 'CSV', raw: ix.raw >= 0 ? r[ix.raw] : '', warn: ix.warn >= 0 && r[ix.warn] ? r[ix.warn].split(' / ') : [] };
  }).filter(r => r.id && r.bib && r.pt && r.t);
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
  const app = FB.initializeApp(FIREBASE_CONFIG);
  const auth = FB.getAuth(app);
  const db = FB.initializeFirestore(app, { localCache: FB.memoryLocalCache() });
  fb = { app, auth, db };
  return fb;
}
export function onUser(cb) { return FB.onAuthStateChanged(firebase().auth, cb); }
export async function login() { const p = new FB.GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' }); return FB.signInWithPopup(firebase().auth, p); }
export async function logout() { return FB.signOut(firebase().auth); }
export const recPath = id => `events/${EVENT_ID}/records/${id}`;
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, ng) => setTimeout(() => ng(new Error(msg)), ms))]);

/** 1件を本部に送る。同じIDがすでに本部にあれば、新しく作らず「受領済み」として扱う。
    戻り値：{ receivedAt, already } */
export async function sendRecord(r) {
  const { db, auth } = firebase();
  const u = auth.currentUser; if (!u) throw new Error('ログインしていません');
  const ref = FB.doc(db, recPath(r.id));
  const data = { id: r.id, bib: String(r.bib), pt: r.pt, t: r.t, tMs: Date.parse(r.t), dev: r.dev, seq: r.seq || 0, how: r.how || '', raw: r.raw || '', warn: r.warn || [],
    by: u.uid, byEmail: u.email || '', receivedAt: FB.serverTimestamp(), via: r.via || 'terminal' };
  const already = await withTimeout(FB.runTransaction(db, async tx => {
    const s = await tx.get(ref);
    if (s.exists()) return true;
    tx.set(ref, data); return false;
  }), 20000, '本部に接続できませんでした（時間切れ）');
  const snap = await withTimeout(FB.getDocFromServer(ref), 15000, '受領の確認ができませんでした（時間切れ）');
  const ra = snap.get('receivedAt');
  return { receivedAt: ra ? ra.toDate().toISOString() : new Date().toISOString(), already };
}
export function watchRecords(cb, err) {
  const { db } = firebase();
  return FB.onSnapshot(FB.query(FB.collection(db, `events/${EVENT_ID}/records`), FB.orderBy('tMs')), { includeMetadataChanges: true },
    s => cb(s.docs.map(d => { const x = d.data(); return { ...x, receivedAt: x.receivedAt ? x.receivedAt.toDate().toISOString() : null }; }), s.metadata), err);
}
export function errText(e) {
  const c = e && e.code;
  if (c === 'permission-denied') return '書き込みの権限がありません（許可されたGoogleアカウントでログインしてください）';
  if (c === 'unavailable') return '通信できません';
  if (c === 'auth/popup-blocked') return 'ログイン画面が開けませんでした。もう一度押してください';
  if (c === 'auth/popup-closed-by-user' || c === 'auth/cancelled-popup-request') return 'ログインを中止しました';
  if (c === 'auth/network-request-failed') return '通信できないためログインできません';
  if (c === 'auth/unauthorized-domain') return 'このページのドメインがFirebaseで許可されていません（承認済みドメインを確認）';
  return (e && e.message) || String(e);
}
