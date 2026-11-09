// 2.19 · Pemberitahuan pembaruan aplikasi Android (APK)
// Daftar versi terbaru ada di android/versions.json, ikut ter-deploy bersama web.
//   code  = versionCode APK terbaru yang tersedia
//   min   = versionCode paling tua yang masih boleh dipakai; di bawah ini layar dikunci
//           sampai APK baru dipasang ("wajib perbarui")
// Perangkat tanpa aplikasi Android (browser biasa) tidak pernah diganggu.
import { isApp, appInfo } from './escpos.js';
import * as CFG from './config.js';
import { esc, ic } from './lib.js';
import * as DN from './devnotify.js';

const URL_JSON = 'android/versions.json';
const CHECK_MS = 6 * 3600 * 1000;   // periksa ulang tiap 6 jam
const SEEN = 'kaly.apkSeen';        // versi yang pemberitahuannya sudah dilihat di perangkat ini
const HIDE = 'kaly.apkHide';        // banner ditutup untuk versi ini

let state = { st: 'ok', latest: null, at: 0 };
const ls = (k, v) => { try { return v === undefined ? localStorage.getItem(k) : (localStorage.setItem(k, v), v); } catch { return null; } };

export const flavor = () => (CFG.APP_MODE === 'backoffice' ? 'backoffice' : 'ops');
export const apkFile = () => `android/kaly-${flavor() === 'backoffice' ? 'backoffice' : 'ops'}.apk`;
const appName = () => (flavor() === 'backoffice' ? 'Kaly Backoffice' : 'Kaly Ops');

// versionCode aplikasi yang sedang dipakai; 0 = tidak diketahui (aplikasi lama tanpa code)
function myCode() {
  const i = appInfo();
  const c = Number(i.code);
  return Number.isFinite(c) && c > 0 ? c : 0;
}
export const myVersion = () => String(appInfo().app || '').trim();

export async function check(force = false) {
  if (!isApp()) return (state = { st: 'ok', latest: null, at: Date.now() });
  if (!force && state.at && Date.now() - state.at < CHECK_MS) return state;
  let v = null;
  try {
    const r = await fetch(`${URL_JSON}?t=${Math.floor(Date.now() / 60000)}`, { cache: 'no-store' });
    if (r.ok) v = (await r.json())[flavor()];
  } catch { /* offline atau file belum ada: jangan ganggu */ }
  state = { st: 'ok', latest: v, at: Date.now() };
  if (!v) return state;
  const mine = myCode(), code = Number(v.code) || 0, min = Number(v.min) || 0;
  // aplikasi tanpa versionCode (1.0) dianggap paling tua
  if (code && (mine === 0 || mine < code)) state.st = mine < min || (mine === 0 && min > 0) ? 'required' : 'update';
  return state;
}

export const status = () => state;

// Banner di layar (bisa ditutup) + satu notifikasi Android per versi baru
export function bannerHtml() {
  const s = state;
  if (s.st !== 'update' || !s.latest) return '';
  if (ls(HIDE) === String(s.latest.code)) return '';
  return `<div class="banner info apk-up" data-apk-banner>${ic('download', 18)}
    <span><b>${esc(appName())} ${esc(s.latest.version || '')}</b> tersedia${s.latest.notes ? `: ${esc(s.latest.notes)}` : ''}. Pasang di atas aplikasi ini; login, printer, dan pengaturan tetap.</span>
    <a class="btn btn-sm btn-pri" href="${apkFile()}" download>Unduh &amp; pasang</a>
    <button class="btn-icon sm" data-a="apkLater" aria-label="Ingatkan nanti" title="Tutup, ingatkan nanti">${ic('x', 16)}</button></div>`;
}

export function hideBanner() { if (state.latest) ls(HIDE, String(state.latest.code)); }

// Layar terkunci: versi ini sudah tidak boleh dipakai
export function gateHtml() {
  const s = state;
  if (s.st !== 'required' || !s.latest) return '';
  return `<div class="apk-gate" role="alertdialog" aria-modal="true" aria-labelledby="apk-gt">
    <div class="apk-card">${ic('download', 40)}
      <h2 id="apk-gt">Perbarui ${esc(appName())} dulu</h2>
      <p>Versi ${esc(myVersion() || 'lama')} di tablet ini sudah tidak dipakai lagi. Pasang <b>versi ${esc(s.latest.version || '')}</b> untuk melanjutkan.</p>
      ${s.latest.notes ? `<p class="muted sm">${esc(s.latest.notes)}</p>` : ''}
      <a class="btn btn-pri btn-block" href="${apkFile()}" download>${ic('download', 18)} Unduh &amp; pasang sekarang</a>
      <p class="hint">Setelah file terunduh, ketuk berkasnya lalu pilih <b>Pasang</b>. Login, printer, dan pengaturan tablet ini tetap tersimpan.
        Butuh melayani tamu sekarang? Buka Kaly Ops di browser tablet, atau pakai tablet lain yang sudah diperbarui.</p>
      <button class="btn btn-ghost btn-block" data-a="apkRecheck">Sudah dipasang, periksa lagi</button></div></div>`;
}

// Notifikasi Android sekali per versi, supaya terlihat meski aplikasi di latar
export async function notifyOnce() {
  const s = state;
  if (!s.latest || (s.st !== 'update' && s.st !== 'required')) return false;
  const tag = `apk-${flavor()}-${s.latest.code}`;
  if (ls(SEEN) === tag) return false;
  ls(SEEN, tag);
  const title = `${appName()} ${s.latest.version || ''} tersedia`;
  const body = s.st === 'required' ? 'Wajib diperbarui supaya tablet ini bisa dipakai lagi.' : (s.latest.notes || 'Buka Kaly Ops untuk memasangnya.');
  // Pemberitahuan aplikasi: lewat jembatan Android langsung, tidak ikut pengaturan notifikasi staf
  const n = window.KalyAndroid;
  if (typeof n?.notify === 'function') { try { n.notify(title, body, tag, '#/print'); return true; } catch { /* lanjut ke jalur biasa */ } }
  return DN.show(tag, title, body, '#/print');
}
