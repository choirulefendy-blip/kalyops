// 2.4 · Notifikasi di perangkat: muncul di bilah notifikasi HP/tablet/laptop, seperti notifikasi aplikasi lain.
// Dua jalur, memakai "tag" yang sama per notifikasi sehingga tidak pernah muncul dobel:
//  1. Kaly Ops terbuka tapi di latar (pindah tab / aplikasi lain): halaman ini menampilkan notifikasi sistem sendiri.
//  2. Kaly Ops tertutup: database memanggil Edge Function kaly-push yang mengirim Web Push ke perangkat terdaftar.
// Di aplikasi Android Kaly Ops (APK 1.2+) notifikasi ditampilkan lewat Android selama aplikasi masih berjalan di latar.
// Pilihan jenis notifikasi diambil dari pengaturan notifikasi perangkat ini (notify.js).
import { SUPABASE_URL } from './config.js';
import { currentUser } from './store.js';
import * as API from './api.js';

const KEY = 'kaly.devnotify.v1';     // { roles: { [peran]: true|false }, endpoint }
const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } };
const write = (o) => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch {} };
const native = () => (window.KalyAndroid && typeof window.KalyAndroid.notify === 'function' ? window.KalyAndroid : null);
export const FN_NAME = 'kaly-push';
export const fnUrl = () => `${String(SUPABASE_URL || '').trim().replace(/\/+$/, '')}/functions/v1/${FN_NAME}`;

let kindsOf = () => [];          // diisi notify.js: jenis notifikasi yang dinyalakan di perangkat ini
let info = null;                 // { url, public_key, devices } dari server
let lastErr = '';
export function init({ kinds }) { kindsOf = kinds; }

const ua = () => navigator.userAgent || '';
const isIOS = () => /iPhone|iPad|iPod/.test(ua()) || (/Macintosh/.test(ua()) && navigator.maxTouchPoints > 1);
const standalone = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;

// Apa yang bisa dilakukan perangkat ini
export function support() {
  if (native()) return { ok: true, mode: 'app', closed: false };
  if (window.KalyAndroid) return { ok: false, why: 'Perbarui aplikasi Android Kaly Ops ke versi 1.2 (menu Stasiun cetak › Unduh aplikasi Android) untuk notifikasi Android.' };
  if (!window.isSecureContext) return { ok: false, why: 'Notifikasi perangkat hanya bisa dipakai di alamat https.' };
  if (isIOS() && !standalone()) return { ok: false, ios: true, why: 'Di iPhone/iPad (iOS 16.4 atau lebih baru): buka Kaly Ops di Safari, ketuk Bagikan › Tambah ke Layar Utama, lalu buka Kaly Ops dari ikon di layar utama dan aktifkan di sini.' };
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return { ok: false, why: 'Browser ini tidak mendukung notifikasi. Pakai Chrome, Edge, Firefox, atau Safari terbaru.' };
  return { ok: true, mode: 'web', closed: 'PushManager' in window };
}
export const permission = () => (native() ? (native().notifyPermission ? native().notifyPermission() : 'granted') : 'Notification' in window ? Notification.permission : 'denied');
export const isOn = (role = currentUser()?.role) => !!(role && read().roles?.[role]) && support().ok && permission() === 'granted';
export const serverReady = () => !!(info?.url && info?.public_key);
export const devices = () => info?.devices || 0;
export const infoNow = () => info;
export const lastError = () => lastErr;
export const endpoint = () => read().endpoint || null;

function setRole(role, on) { const o = read(); o.roles = { ...(o.roles || {}), [role]: on }; write(o); }
function setEndpoint(ep) { const o = read(); if (ep) o.endpoint = ep; else delete o.endpoint; write(o); }

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => { const t = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)); return Uint8Array.from(t, (c) => c.charCodeAt(0)); };
function label() {
  const u = ua();
  const os = /Android/.test(u) ? 'Android' : isIOS() ? 'iPhone/iPad' : /Windows/.test(u) ? 'Windows' : /Mac OS X|Macintosh/.test(u) ? 'Mac' : /Linux/.test(u) ? 'Linux' : 'Perangkat';
  const br = /Edg\//.test(u) ? 'Edge' : /SamsungBrowser/.test(u) ? 'Samsung Internet' : /Firefox\//.test(u) ? 'Firefox' : /Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) || isIOS() ? 'Safari' : 'Browser';
  return `${br} · ${os}${standalone() ? ' (aplikasi)' : ''}`;
}

let regP = null;
function registration() {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  regP ||= navigator.serviceWorker.register('sw.js', { scope: './' }).then(() => navigator.serviceWorker.ready).catch((e) => { regP = null; throw e; });
  return regP;
}

export async function refreshInfo() { try { info = await API.pushInfo(); } catch { info = info || null; } return info; }

// Daftarkan perangkat ini ke server (untuk notifikasi saat Kaly Ops tertutup). Diam bila server belum disiapkan Owner.
async function subscribePush() {
  const s = support();
  if (s.mode !== 'web' || !s.closed) return false;
  await refreshInfo();
  if (!serverReady()) return false;
  const reg = await registration();
  if (!reg) return false;
  let sub = await reg.pushManager.getSubscription();
  const key = unb64u(info.public_key);
  if (sub && sub.options?.applicationServerKey && b64u(sub.options.applicationServerKey) !== info.public_key) { await sub.unsubscribe().catch(() => {}); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const j = sub.toJSON();
  await API.pushSubscribe(j.endpoint, j.keys.p256dh, j.keys.auth, kindsOf(), label());
  setEndpoint(j.endpoint);
  info.devices = Math.max(1, info.devices || 0);
  return true;
}

// Nyalakan dari ketukan pengguna (browser hanya menampilkan permintaan izin setelah tombol ditekan)
export async function enable() {
  lastErr = '';
  const u = currentUser(); if (!u) return { ok: false, why: 'Masuk dulu.' };
  const s = support();
  if (!s.ok) return { ok: false, why: s.why };
  if (s.mode === 'app') {
    const p = await new Promise((res) => {
      const n = native();
      if (!n.requestNotify) return res('granted');
      const id = 'np' + Date.now();
      window.__kalyNotifyCb = window.__kalyNotifyCb || {};
      window.__kalyNotifyCb[id] = res;
      n.requestNotify(id);
      setTimeout(() => res(permission()), 30000);
    });
    if (p !== 'granted') return { ok: false, why: 'Izin notifikasi untuk aplikasi Kaly Ops belum diberikan. Buka Pengaturan Android › Aplikasi › Kaly Ops › Notifikasi, lalu izinkan.' };
    setRole(u.role, true);
    return { ok: true, closed: false };
  }
  let p = Notification.permission;
  if (p === 'default') p = await Notification.requestPermission();
  if (p !== 'granted') return { ok: false, why: p === 'denied'
    ? 'Notifikasi untuk Kaly Ops diblokir di browser ini. Ketuk ikon gembok/situs di bilah alamat › Izin › Notifikasi › Izinkan, lalu coba lagi.'
    : 'Izin notifikasi belum diberikan.' };
  setRole(u.role, true);
  try { await registration(); } catch (e) { lastErr = 'Service worker gagal dipasang: ' + (e?.message || e); return { ok: true, closed: false, warn: lastErr }; }
  try {
    const closed = await subscribePush();
    return { ok: true, closed, server: serverReady() };
  } catch (e) {
    lastErr = String(e?.message || e);
    return { ok: true, closed: false, server: serverReady(), warn: 'Notifikasi saat Kaly Ops tertutup belum aktif: ' + lastErr };
  }
}

export async function disable() {
  const u = currentUser();
  if (u) setRole(u.role, false);
  await dropServer();
}
// Hapus perangkat ini dari daftar penerima di server (dipakai juga saat keluar akun)
async function dropServer() {
  const ep = endpoint();
  if (!ep) return;
  try { await API.pushUnsubscribe(ep); } catch {}
  setEndpoint(null);
  if (info) info.devices = Math.max(0, (info.devices || 1) - 1);
}
export async function onLogout() { await dropServer(); }

// Saat masuk / aplikasi dibuka: daftarkan ulang bila perlu (langganan bisa kedaluwarsa atau akun berganti)
export async function resume() {
  const u = currentUser();
  if (!u) return;
  if (!isOn(u.role)) { if (endpoint()) await dropServer(); return; }
  try { await registration(); await subscribePush(); lastErr = ''; } catch (e) { lastErr = String(e?.message || e); }
}
// Pilihan jenis notifikasi berubah: kirim ke server supaya notifikasi saat tertutup ikut berubah
export async function syncKinds() {
  if (!isOn()) return;
  const ep = endpoint();
  try { if (ep) { if (!(await API.pushKinds(ep, kindsOf()))) await subscribePush(); } else await subscribePush(); } catch (e) { lastErr = String(e?.message || e); }
}

// Tampilkan notifikasi sistem untuk kejadian baru selagi Kaly Ops terbuka di latar
export async function show(tag, title, body, url) {
  if (!isOn()) return false;
  const n = native();
  if (n) { try { n.notify(String(title || 'Kaly Ops'), String(body || ''), String(tag), String(url || '')); return true; } catch { return false; } }
  if (document.visibilityState === 'visible') return false;        // kartu di layar sudah cukup
  try {
    const reg = await registration();
    await reg.showNotification(title || 'Kaly Ops', { body: body || '', tag, data: { url: url || '#/' }, icon: 'assets/icon-192.png', badge: 'assets/notify-badge.png', lang: 'id' });
    return true;
  } catch { return false; }
}

// Kirim notifikasi tes: lewat server bila sudah tersambung (membuktikan jalur saat tertutup), atau langsung di perangkat
export async function test() {
  if (!isOn()) return { ok: false, why: 'Aktifkan notifikasi di perangkat ini dulu.' };
  if (!native() && endpoint() && serverReady()) {
    try { const n = await API.pushTest(); return { ok: true, via: 'server', devices: n }; } catch (e) { lastErr = String(e?.message || e); }
  }
  const n = native();
  if (n) { n.notify('Notifikasi tes Kaly Ops', 'Notifikasi di perangkat ini sudah aktif.', 'kaly-test', ''); return { ok: true, via: 'app' }; }
  const reg = await registration();
  await reg.showNotification('Notifikasi tes Kaly Ops', { body: 'Notifikasi di perangkat ini sudah aktif.', tag: 'kaly-test', data: { url: '#/' }, icon: 'assets/icon-192.png', badge: 'assets/notify-badge.png' });
  return { ok: true, via: 'local' };
}

// Owner: sambungkan Edge Function kaly-push (membuat kunci VAPID bila belum ada), atau putuskan
export async function connectServer() {
  const url = fnUrl();
  let r;
  try { r = await fetch(url, { method: 'GET', cache: 'no-store' }); }
  catch { throw new Error(`Edge Function ${FN_NAME} tidak bisa dihubungi. Pastikan sudah di-deploy dengan nama "${FN_NAME}".`); }
  if (r.status === 401) throw new Error(`Edge Function ${FN_NAME} menolak permintaan (401). Matikan "Verify JWT" / "Enforce JWT verification" di pengaturan fungsi, lalu coba lagi.`);
  if (r.status === 404) throw new Error(`Edge Function ${FN_NAME} belum ada. Deploy dulu dengan nama persis "${FN_NAME}".`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.publicKey) throw new Error(j.error ? `Edge Function ${FN_NAME}: ${j.error}` : `Edge Function ${FN_NAME} menjawab ${r.status}. Periksa log fungsi di Supabase.`);
  await API.pushSetup(url);
  await refreshInfo();
  return info;
}
export async function disconnectServer() { await API.pushSetup(null); await refreshInfo(); }

// Jawaban izin notifikasi dari aplikasi Android
window.__kalyNotifyDone = (id, p) => { const f = window.__kalyNotifyCb?.[id]; if (f) { delete window.__kalyNotifyCb[id]; f(p); } };

// Notifikasi diketuk saat Kaly Ops sudah terbuka: pindah ke halaman terkait
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (e) => {
  const h = e.data?.type === 'kaly-open' && e.data.hash;
  if (typeof h === 'string' && /^#\/[\w\-/?=&.%]*$/.test(h)) location.hash = h;
});
