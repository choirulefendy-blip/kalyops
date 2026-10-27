// Notifikasi suara untuk semua layar staf, dan (2.4) notifikasi di perangkat lewat devnotify.js.
// Sumber: tabel staff_alerts (pesanan QR & online, meja sudah dibayar, reservasi, PO, mutasi, stok menipis, fraud),
// order_notices (item siap diantar, per item sejak 1.7), item baru di layar dapur, dan versi aplikasi baru di Netlify.
// Pengaturan suara disimpan per perangkat & per peran (localStorage), karena tiap perangkat punya kebutuhan berbeda.
import { getDb, subscribe, currentUser } from './store.js';
import { esc, ic, openModal, toast } from './lib.js';
import * as C from './cloud.js';
import * as DN from './devnotify.js';
import { ROLES } from './domain.js';

const ALL = ['owner', 'kasir', 'service', 'dapur', 'gudang'];
const tableTxt = (t) => String(t || '').split('').join(' ');
// Pesanan QR yang dibayar online menunggu konfirmasi di Kaly Order; selain itu buka bill-nya di POS
function openBill(a, role) {
  const o = getDb().orders.find((x) => x.id === a.order);
  if (o?.payPending && role !== 'service') return { label: 'Cek pembayaran', href: '#/order-admin' };
  // Service & Manajer/Owner tidak membuka bill di POS (POS Owner hanya untuk kelola menu)
  if (role === 'service' || role === 'owner') return { label: 'Lihat meja', href: `#/denah?t=${a.table || ''}` };
  return { label: 'Buka bill', href: `#/pos?order=${a.order}` };
}
// Dapur: tombol "Lihat layar dapur" tidak perlu saat layar dapur sudah terbuka
const kitchenAct = () => (location.hash.startsWith('#/kitchen') ? null : { label: 'Lihat layar dapur', href: '#/kitchen' });
// Nama item dari judul notifikasi pembatalan, untuk diucapkan ("BATAL · 2× Nasi Goreng (pedas) · Meja G3 · A014")
const kItems = (a) => String(a.title || '').replace(/^BATAL · /, '').replace(/ · (Meja \S+|[A-Z]{1,2}\d{3,}\b).*$/, '').replace(/×/g, '').replace(/\s*\([^)]*\)/g, '');
// Stasiun layar dapur di perangkat ini (dipilih di Kaly Kitchen): all | dapur | bar
const KDS = 'kaly.kds.station';
export function kdsStation() { try { return localStorage.getItem(KDS) || 'all'; } catch { return 'all'; } }
export function setKdsStation(v) { try { localStorage.setItem(KDS, v || 'all'); } catch {} }
const stationOk = (ref) => { const st = kdsStation(); return st === 'all' || !ref || String(ref).split(',').includes(st); };
// on: peran yang menyalakan notifikasi ini secara bawaan (peran lain tetap bisa menyalakannya sendiri)
export const KINDS = {
  qr_new: { group: 'order', push: true, label: 'Pesanan QR baru dari meja', icon: 'qr-code', roles: ['owner', 'kasir', 'service'], on: ['owner', 'kasir'], sound: 'order', repeat: true, outlet: true,
    say: (a) => `Pesanan QR baru, meja ${tableTxt(a.table)}. Buka bill di kasir.`, act: (a, role) => openBill(a, role) },
  qr_add: { group: 'order', push: true, label: 'Tambahan pesanan QR di bill meja', icon: 'qr-code', roles: ['owner', 'kasir', 'service'], on: ['owner', 'kasir'], sound: 'order', repeat: true, outlet: true,
    say: (a) => `Tambahan pesanan QR, meja ${tableTxt(a.table)}.`, act: (a, role) => openBill(a, role) },
  web_new: { group: 'order', push: true, label: 'Pesanan online baru', icon: 'shopping-cart', roles: ['owner', 'kasir'], on: ['owner', 'kasir'], sound: 'order', repeat: true, outlet: true,
    say: () => 'Pesanan online baru masuk.', act: () => ({ label: 'Lihat pesanan', href: '#/order-admin' }) },
  ready: { group: 'order', label: 'Item siap diantar', icon: 'hand-platter', roles: ['owner', 'kasir', 'service'], on: ['owner', 'kasir', 'service'], sound: 'ready', outlet: true,
    say: (a) => (a.item ? `${a.item.replace(/^[\d.,]+× /, '')}, ${a.table ? 'meja ' + tableTxt(a.table) : 'pesanan ' + tableTxt(a.no)}, siap diantar.` : `Pesanan ${tableTxt(a.no)}${a.table ? ', meja ' + tableTxt(a.table) : ''}, siap diantar.`), act: (a, role) => ({ label: 'Lihat', href: role === 'kasir' ? '#/pos?tab=siap' : `#/denah?t=${a.table || ''}` }) },
  table_paid: { group: 'order', push: true, label: 'Meja sudah dibayar, perlu dikosongkan', icon: 'armchair', roles: ['owner', 'service', 'kasir'], on: ['service'], sound: 'soft', outlet: true,
    say: (a) => `Meja ${tableTxt(a.table)} sudah dibayar.`, act: (a) => ({ label: 'Buka denah', href: `#/denah?t=${a.table || ''}` }) },
  table_move: { group: 'order', push: true, label: 'Tamu pindah meja', icon: 'arrow-left-right', roles: ['owner', 'service', 'kasir'], on: ['service', 'kasir'], sound: 'soft', outlet: true, notSelf: true,
    say: (a) => String(a.title || '').replace(/meja (\S+)/gi, (m, t) => 'meja ' + tableTxt(t)) + '.', act: (a, role) => ({ label: 'Lihat meja', href: role === 'kasir' ? '#/pos?tab=meja' : `#/denah?t=${a.table || ''}` }) },
  res_seat: { group: 'order', push: true, label: 'Tamu sudah duduk (dibooking service), siap dibuatkan bill', icon: 'concierge-bell', roles: ['owner', 'kasir'], on: ['kasir'], sound: 'order', outlet: true,
    say: (a) => `Meja ${tableTxt(a.table)}, tamu sudah duduk. Silakan buka bill.`, act: (a, role) => (role === 'kasir' ? { label: 'Buka bill', href: `#/pos?seat=${encodeURIComponent(a.table || '')}` } : { label: 'Lihat meja', href: `#/denah?t=${a.table || ''}` }) },
  res_new: { group: 'order', push: true, label: 'Reservasi baru dari pelanggan', icon: 'calendar-check', roles: ['owner', 'kasir', 'service'], on: ['owner', 'kasir', 'service'], sound: 'soft', outlet: true,
    say: () => 'Ada reservasi baru.', act: () => ({ label: 'Lihat reservasi', href: '#/book-admin' }) },
  ticket: { label: 'Bunyi pendek saat item baru muncul (bila notifikasi dari kasir dimatikan)', icon: 'chef-hat', roles: ['owner', 'dapur'], on: ['owner', 'dapur'], sound: 'ticket', group: 'dapur' },
  // 2.5: notifikasi untuk layar dapur dari kasir. Stasiun (Dapur/Bar) mengikuti pilihan di layar dapur perangkat ini.
  k_new: { label: 'Pesanan baru dari kasir', icon: 'concierge-bell', roles: ['owner', 'dapur'], on: ['dapur'], sound: 'ticket', group: 'dapur', push: true, station: true, outlet: true,
    say: (a) => `Pesanan baru${a.table ? ', meja ' + tableTxt(a.table) : ''}.`, act: () => kitchenAct() },
  k_add: { label: 'Tambahan item di pesanan yang sudah di dapur', icon: 'plus', roles: ['owner', 'dapur'], on: ['dapur'], sound: 'ticket', group: 'dapur', push: true, station: true, outlet: true,
    say: (a) => `Tambahan pesanan${a.table ? ', meja ' + tableTxt(a.table) : ''}.`, act: () => kitchenAct() },
  k_void: { label: 'Item dibatalkan kasir (hentikan / jangan diantar)', icon: 'circle-alert', roles: ['owner', 'dapur'], on: ['dapur'], sound: 'alert', group: 'dapur', push: true, station: true, outlet: true, sticky: true,
    say: (a) => `Pembatalan dari kasir. ${kItems(a)}${a.table ? ', meja ' + tableTxt(a.table) : ''}.`, act: () => ({ label: 'Oke, dimengerti' }) },
  k_move: { label: 'Pindah meja, split, atau gabung bill', icon: 'arrow-left-right', roles: ['owner', 'dapur'], on: ['dapur'], sound: 'soft', group: 'dapur', push: true, station: true, outlet: true,
    say: (a) => { const m = /^Pindah meja · (\S+) → (\S+)/.exec(a.title || ''); return m ? `Pindah meja, ${tableTxt(m[1])} ke ${tableTxt(m[2])}.` : `Nota berubah${a.table ? ', meja ' + tableTxt(a.table) : ''}.`; },
    act: () => kitchenAct() },
  // 2.4: laporan shift & penjualan harian (Owner/Manajer)
  shift_open: { label: 'Shift kasir dibuka (modal kas)', icon: 'clock', roles: ['owner'], on: [], sound: 'soft', group: 'shift', push: true,
    act: () => ({ label: 'Lihat laporan', href: '#/core?tab=keuangan' }) },
  shift_close: { label: 'Laporan tutup shift kasir (penjualan, tunai, selisih kas)', icon: 'receipt', roles: ['owner'], on: ['owner'], sound: 'soft', group: 'shift', push: true,
    act: () => ({ label: 'Lihat laporan', href: '#/core?tab=keuangan' }) },
  day_close: { label: 'Ringkasan penjualan harian (semua shift outlet ditutup)', icon: 'chart-column', roles: ['owner'], on: ['owner'], sound: 'soft', group: 'shift', push: true,
    act: () => ({ label: 'Lihat laporan', href: '#/core?tab=keuangan' }) },
  po_wait: { label: 'PO menunggu persetujuan', icon: 'truck', roles: ['owner'], on: ['owner'], sound: 'soft', group: 'uang', push: true, act: () => ({ label: 'Buka Kaly Goods', href: '#/goods' }) },
  po_done: { label: 'PO disetujui atau ditolak', icon: 'truck', roles: ['owner', 'gudang'], on: ['gudang'], sound: 'soft', group: 'uang', push: true, act: () => ({ label: 'Buka Kaly Goods', href: '#/goods' }) },
  po_paid: { label: 'Pembayaran ke supplier (PO dibayar)', icon: 'hand-coins', roles: ['owner'], on: ['owner'], sound: 'soft', group: 'uang', push: true,
    act: () => ({ label: 'Lihat laporan', href: '#/core?tab=keuangan' }) },
  po_recv: { label: 'Barang PO diterima (stok bahan bertambah)', icon: 'package', roles: ['owner', 'gudang'], on: ['owner', 'gudang'], sound: 'soft', group: 'bahan', push: true,
    act: () => ({ label: 'Lihat stok', href: '#/core?tab=stok' }) },
  tf_in: { label: 'Mutasi barang masuk', icon: 'boxes', roles: ['owner', 'gudang'], on: ['gudang'], sound: 'soft', group: 'bahan', push: true, act: () => ({ label: 'Lihat mutasi', href: '#/core?tab=mutasi' }) },
  stock_low: { label: 'Stok bahan di bawah minimum', icon: 'triangle-alert', roles: ['owner', 'gudang'], on: ['owner', 'gudang'], sound: 'soft', group: 'bahan', push: true, act: () => ({ label: 'Lihat stok', href: '#/core?tab=stok' }) },
  opname: { label: 'Stock opname selesai (selisih stok)', icon: 'clipboard-check', roles: ['owner', 'gudang'], on: ['owner'], sound: 'soft', group: 'bahan', push: true,
    act: () => ({ label: 'Lihat opname', href: '#/core?tab=opname' }) },
  fraud: { label: 'Temuan fraud baru', icon: 'circle-alert', roles: ['owner'], on: ['owner'], sound: 'alert', group: 'fraud', push: true, act: () => ({ label: 'Lihat temuan', href: '#/core?tab=fraud' }) },
  app_update: { label: 'Versi aplikasi baru tersedia', icon: 'refresh-cw', roles: ALL, on: ALL, sound: 'soft', sticky: true, group: 'app', act: () => ({ label: 'Muat ulang', reload: true }) },
  // Tes notifikasi perangkat: hanya untuk akun yang menekan Tes, tidak tampil di daftar pilihan
  push_test: { label: 'Notifikasi tes', icon: 'bell', roles: ALL, on: ALL, sound: 'soft', hidden: true, selfOnly: true },
};
export const GROUPS = [
  ['order', 'Pesanan, meja & reservasi'], ['dapur', 'Dapur (dari kasir)'], ['shift', 'Laporan shift & penjualan'], ['uang', 'Keuangan & pembelian'],
  ['bahan', 'Bahan & stok'], ['fraud', 'Fraud'], ['app', 'Aplikasi'],
];

// ---------- Pengaturan per perangkat ----------
const PKEY = 'kaly.notify.v1';
const readAll = () => { try { return JSON.parse(localStorage.getItem(PKEY) || '{}') || {}; } catch { return {}; } };
export function prefs(role = currentUser()?.role) {
  const p = readAll()[role] || {};
  return { sound: p.sound !== false, voice: p.voice !== false, kinds: p.kinds || {} };
}
function savePrefs(role, p) { try { const all = readAll(); all[role] = p; localStorage.setItem(PKEY, JSON.stringify(all)); } catch {} }
export function enabled(kind, role = currentUser()?.role) {
  const k = KINDS[kind]; if (!k || !role || !k.roles.includes(role)) return false;
  if (k.hidden) return true;
  const v = prefs(role).kinds[kind];
  return v === undefined ? k.on.includes(role) : !!v;
}
// Jenis notifikasi yang ikut dikirim ke perangkat ini saat Kaly Ops tertutup (hanya yang berasal dari server)
export const pushKinds = (role = currentUser()?.role) => Object.keys(KINDS).filter((key) => KINDS[key].push && enabled(key, role));
DN.init({ kinds: () => pushKinds() });
const hrefOf = (kind, a, role) => { const act = KINDS[kind]?.act && KINDS[kind].act(a, role); return act?.href || '#/'; };

// ---------- Suara ----------
let actx = null;
function ctx() { try { actx ||= new (window.AudioContext || window.webkitAudioContext)(); } catch {} return actx; }
export const unlocked = () => !!actx && actx.state === 'running';
function unlock() { const a = ctx(); if (a && a.state !== 'running') a.resume().then(paintButton).catch(() => {}); else paintButton(); }
['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, unlock, { capture: true, passive: true }));

const PATTERN = {
  order: { type: 'triangle', notes: [[1046.5, 0], [1318.5, 0.16], [1568, 0.32], [1046.5, 0.75], [1318.5, 0.91], [1568, 1.07]], len: 0.45, vol: 0.4 },
  ready: { type: 'sine', notes: [[784, 0], [1046.5, 0.2], [784, 0.62], [1046.5, 0.82]], len: 0.6, vol: 0.38 },
  ticket: { type: 'square', notes: [[880, 0], [880, 0.22]], len: 0.16, vol: 0.12 },
  soft: { type: 'sine', notes: [[659.3, 0], [880, 0.18]], len: 0.55, vol: 0.28 },
  alert: { type: 'sawtooth', notes: [[440, 0], [659.3, 0.22], [440, 0.44]], len: 0.2, vol: 0.12 },
};
export function tone(name) {
  const a = ctx(), p = PATTERN[name] || PATTERN.soft;
  if (!a || a.state !== 'running') return false;
  const t = a.currentTime + 0.02;
  for (const [f, d] of p.notes) {
    const o = a.createOscillator(), g = a.createGain();
    o.type = p.type; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(p.vol, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d + p.len);
    o.connect(g).connect(a.destination); o.start(t + d); o.stop(t + d + p.len + 0.05);
  }
  return true;
}
function say(text) {
  try {
    if (text && window.KalyAndroid?.speak) return window.KalyAndroid.speak(String(text));  // aplikasi Android
    if (!text || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'id-ID'; u.rate = 0.95;
    const v = speechSynthesis.getVoices().find((x) => x.lang?.toLowerCase().startsWith('id'));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  } catch {}
}
// Bunyikan satu jenis notifikasi bila aktif di perangkat ini. Dipakai juga oleh layar dapur.
export function play(kind, a = {}, { voice = true } = {}) {
  const role = currentUser()?.role;
  if (!enabled(kind, role)) return;
  const p = prefs(role);
  if (!p.sound) return;
  const k = KINDS[kind];
  const played = tone(k.sound);
  if (played && voice && p.voice && k.say) setTimeout(() => say(k.say(a)), k.sound === 'order' ? 1500 : 1100);
  if (!played) paintButton(true);
}

// ---------- Kartu notifikasi ----------
const cards = new Map(); // key → { el, kind, a, at, repeats, timer }
function stack() {
  let s = document.getElementById('nt-stack');
  if (!s) { s = document.createElement('div'); s.id = 'nt-stack'; s.setAttribute('aria-live', 'polite'); document.body.appendChild(s); }
  return s;
}
function showCard(key, kind, a) {
  if (cards.has(key)) return;
  const k = KINDS[kind], role = currentUser()?.role;
  const act = k.act && k.act(a, role);
  const el = document.createElement('div');
  el.className = `nt-card nt-${k.sound}`;
  el.innerHTML = `<span class="nt-ic">${ic(k.icon, 20)}</span><div class="nt-b"><b>${esc(a.title || k.label)}</b>${a.detail ? `<small>${esc(a.detail)}</small>` : ''}</div>
    <div class="nt-act">${act ? `<button class="btn btn-sm btn-pri" data-nt="go">${esc(act.label)}</button>` : ''}<button class="btn-icon sm" data-nt="x" aria-label="Tutup notifikasi">${ic('x', 15)}</button></div>`;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-nt]'); if (!b) return;
    if (b.dataset.nt === 'go' && act) { if (act.reload) { location.reload(); return; } if (act.href) location.hash = act.href; }
    dismiss(key);
  });
  stack().prepend(el);
  const c = { el, kind, a, at: Date.now(), repeats: 0, timer: null };
  cards.set(key, c);
  if (k.repeat) c.timer = setInterval(() => remind(key), 45000);
  else if (!k.sticky) c.timer = setTimeout(() => dismiss(key), 25000);
  while (cards.size > 5) dismiss(cards.keys().next().value);
}
function dismiss(key) {
  const c = cards.get(key); if (!c) return;
  clearInterval(c.timer); clearTimeout(c.timer);
  c.el.classList.add('out'); setTimeout(() => c.el.remove(), 250);
  cards.delete(key);
}
// Pengingat untuk pesanan QR/online yang belum dibuka kasir: bunyi ulang tiap 45 detik, paling banyak 3 kali
function remind(key) {
  const c = cards.get(key); if (!c) return;
  const o = c.a.order && getDb().orders.find((x) => x.id === c.a.order);
  if (o && (o.status !== 'open' || (c.kind === 'web_new' && !o.payPending))) return dismiss(key);
  if (++c.repeats > 3) { clearInterval(c.timer); return; }
  play(c.kind, c.a, { voice: c.repeats === 1 });
  c.el.classList.remove('nt-pulse'); void c.el.offsetWidth; c.el.classList.add('nt-pulse');
}
// Kasir sudah membuka bill ini di POS: hentikan pengingatnya
export function ackOrder(orderId) { for (const [key, c] of cards) if (c.a.order === orderId && KINDS[c.kind].repeat) dismiss(key); }

// ---------- Deteksi kejadian baru ----------
let init = false, maxAlert = 0, maxNotice = 0, resumedFor = null;
const RECENT = 3 * 60000;
function check() {
  const u = currentUser();
  if (!u) { init = false; return; }
  if (!C.isReady()) return;
  const db = getDb();
  const alerts = db.alerts || [], notices = db.notices || [];
  if (!init) {
    maxAlert = Math.max(0, ...alerts.map((a) => a.id)); maxNotice = Math.max(0, ...notices.map((n) => n.id));
    init = true;
    if (resumedFor !== u.id) { resumedFor = u.id; DN.resume(); }   // daftarkan ulang notifikasi perangkat untuk akun ini
    return;
  }
  const L = outletNow();
  const now = Date.now();
  for (const a of alerts.filter((x) => x.id > maxAlert).sort((x, y) => x.id - y.id)) {
    maxAlert = Math.max(maxAlert, a.id);
    const k = KINDS[a.kind];
    if (!k || now - a.at > RECENT || !enabled(a.kind, u.role)) continue;
    if (k.outlet && a.loc && a.loc !== L) continue;
    if (k.notSelf && a.ref && a.ref === u.id) continue;
    if (k.selfOnly && a.ref !== u.id) continue;
    if (k.station && !stationOk(a.ref)) continue;
    showCard('a' + a.id, a.kind, a);
    play(a.kind, a);
    DN.show('kaly-a' + a.id, a.title || k.label, a.detail || '', hrefOf(a.kind, a, u.role));
  }
  for (const n of notices.filter((x) => x.id > maxNotice).sort((x, y) => x.id - y.id)) {
    maxNotice = Math.max(maxNotice, n.id);
    if (n.seen || now - n.at > RECENT || n.loc !== L || !enabled('ready', u.role)) continue;
    const a = n.line
      ? { order: n.order, line: n.line, no: n.no, table: n.table, item: n.item, title: `${n.table ? 'Meja ' + n.table : n.no} · ${n.item || 'item'} siap`, detail: 'Ambil di dapur/bar dan langsung antar ke tamu.' }
      : { order: n.order, no: n.no, table: n.table, title: `Pesanan ${n.no}${n.table ? ' · Meja ' + n.table : ''} siap diantar`, detail: 'Ambil di dapur/bar dan antar ke tamu.' };
    showCard('n' + n.id, 'ready', a);
    play('ready', a);
    DN.show('kaly-n' + n.id, a.title, a.detail, hrefOf('ready', a, u.role));
  }
}
let outletNow = () => 'L1';
export function start({ getOutlet }) {
  outletNow = getOutlet;
  subscribe((src) => {
    if (src === 'remote' || src === 'session') { if (src === 'session') init = false; setTimeout(check, 0); }
  });
  setInterval(checkVersion, 5 * 60000);
  setTimeout(checkVersion, 15000);
}

// ---------- Versi aplikasi baru ----------
let baseBuild = null, updateShown = false;
async function checkVersion() {
  if (updateShown || document.hidden) return;
  try {
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return;
    const v = (await r.json()).build;
    if (!v) return;
    if (!baseBuild) { baseBuild = v; return; }
    if (v !== baseBuild && currentUser()) {
      updateShown = true;
      showCard('update', 'app_update', { title: 'Versi baru Kaly Ops tersedia', detail: 'Simpan pekerjaan yang sedang berjalan, lalu tekan Muat ulang.' });
      play('app_update', {}, { voice: false });
    }
  } catch {}
}
fetch('version.json?t=' + Date.now(), { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((j) => { if (j?.build) baseBuild = j.build; }).catch(() => {});

// ---------- Tombol suara di bilah atas ----------
export function buttonHtml() {
  return `<button class="snd" id="snd" data-a="soundPrefs" aria-label="Pengaturan notifikasi" title="Notifikasi"><span class="snd-on">${ic('volume-2', 18)}</span><span class="snd-off">${ic('volume-x', 18)}</span><i class="snd-dot"></i></button>`;
}
// Hanya mengganti kelas (bukan isi tombol), supaya ketukan pada tombol tidak hilang saat suara baru diaktifkan
export function paintButton(blocked) {
  const b = document.getElementById('snd'); if (!b) return;
  const u = currentUser(); if (!u) return;
  const p = prefs(u.role);
  const locked = p.sound && !unlocked();
  b.classList.toggle('off', !p.sound);
  b.classList.toggle('locked', locked);
  b.title = !p.sound ? 'Suara notifikasi mati di perangkat ini' : locked ? 'Ketuk di mana saja untuk menyalakan suara notifikasi' : 'Suara notifikasi aktif';
  if (blocked && locked && !toastedLock) { toastedLock = true; toast('Ada notifikasi, tapi suaranya belum bisa diputar. Ketuk layar sekali untuk menyalakan suara.', 'warn', 6000); }
}
let toastedLock = false;
// ---------- Notifikasi di perangkat ini (2.4) ----------
export function deviceStatus(role = currentUser()?.role) {
  const s = DN.support(), on = DN.isOn(role), perm = DN.permission();
  if (!s.ok) return { on: false, cls: 'warn', text: s.why, can: false };
  if (perm === 'denied') return { on: false, cls: 'warn', can: true, text: s.mode === 'app'
    ? 'Notifikasi untuk aplikasi Kaly Ops dimatikan di Android. Buka Pengaturan Android › Aplikasi › Kaly Ops › Notifikasi, lalu izinkan.'
    : 'Notifikasi untuk Kaly Ops diblokir di browser ini. Ketuk ikon gembok/situs di bilah alamat › Izin › Notifikasi › Izinkan, lalu aktifkan lagi.' };
  if (!on) return { on: false, cls: '', can: true, text: 'Mati. Saat aktif, notifikasi yang dicentang di bawah muncul di bilah notifikasi perangkat ini' + (s.mode === 'app' ? ' selama aplikasi Kaly Ops berjalan, termasuk saat kasir membuka aplikasi lain.' : s.closed ? ', juga saat Kaly Ops sedang ditutup.' : '.') };
  if (s.mode === 'app') return { on: true, cls: 'ok', can: true, text: 'Aktif. Notifikasi muncul di bilah notifikasi Android selama aplikasi Kaly Ops berjalan, termasuk saat pindah ke aplikasi lain. Untuk HP pribadi Owner/Manajer, pakai Chrome agar notifikasi tetap masuk saat Kaly Ops ditutup.' };
  if (!s.closed) return { on: true, cls: 'ok', can: true, text: 'Aktif selama Kaly Ops terbuka (termasuk di tab lain). Browser ini tidak mendukung notifikasi saat Kaly Ops ditutup.' };
  if (DN.infoNow() && !DN.serverReady()) return { on: true, cls: 'ok', can: true, text: 'Aktif selama Kaly Ops terbuka (termasuk di tab lain). Agar tetap muncul saat Kaly Ops ditutup, Owner perlu menyambungkan server notifikasi di Pengaturan › Notifikasi di perangkat.' };
  if (DN.serverReady() && !DN.endpoint()) return { on: true, cls: 'warn', can: true, text: 'Aktif selama Kaly Ops terbuka, tapi pendaftaran notifikasi saat ditutup gagal' + (DN.lastError() ? ` (${DN.lastError()})` : '') + '. Tekan Aktifkan lagi.' };
  return { on: true, cls: 'ok', can: true, text: 'Aktif, juga saat Kaly Ops ditutup. Ketuk notifikasi untuk membuka halaman terkait.' };
}
function deviceBox() {
  const st = deviceStatus(), s = DN.support();
  return `<div class="dn-box ${st.cls}" data-dn><div class="dn-h">${ic(s.mode === 'app' ? 'smartphone' : 'bell', 18)}<b>Notifikasi di perangkat ini</b><span class="badge ${st.on ? 'b-ok' : 'b-mute'}">${st.on ? 'Aktif' : 'Mati'}</span></div>
    <p class="sm">${esc(st.text)}</p>
    ${st.can ? `<div class="row wrap">${st.on ? `<button type="button" class="btn btn-sm" data-dn="test">${ic('send', 14)} Kirim tes</button><button type="button" class="btn btn-sm btn-ghost" data-dn="off">Matikan</button>${st.cls === 'warn' ? '<button type="button" class="btn btn-sm btn-pri" data-dn="on">Aktifkan lagi</button>' : ''}`
      : `<button type="button" class="btn btn-sm btn-pri" data-dn="on">${ic('bell', 14)} Aktifkan notifikasi di perangkat ini</button>`}</div>` : ''}</div>`;
}
export async function deviceAction(what, after) {
  try {
    if (what === 'on') {
      const r = await DN.enable();
      if (!r.ok) toast(r.why, 'warn', 9000);
      else if (r.warn) toast(r.warn, 'warn', 8000);
      else toast(r.closed ? 'Notifikasi aktif di perangkat ini, juga saat Kaly Ops ditutup' : 'Notifikasi aktif di perangkat ini');
    } else if (what === 'off') { await DN.disable(); toast('Notifikasi di perangkat ini dimatikan'); }
    else if (what === 'test') {
      const r = await DN.test();
      if (!r.ok) toast(r.why, 'warn');
      else toast(r.via === 'server' ? `Notifikasi tes dikirim lewat server ke ${r.devices} perangkat Anda. Bila Kaly Ops sedang terbuka di layar, notifikasi tampil sebagai kartu.` : 'Notifikasi tes ditampilkan di perangkat ini', 'info', 6000);
    }
  } catch (e) { toast(e.message || String(e), 'err', 7000); }
  after && after();
}

export function openPrefs() {
  const u = currentUser(); if (!u) return;
  unlock();
  const p = prefs(u.role);
  const list = Object.entries(KINDS).filter(([, k]) => k.roles.includes(u.role) && !k.hidden);
  const groups = GROUPS.map(([g, title]) => [title, list.filter(([, k]) => k.group === g)]).filter(([, l]) => l.length);
  openModal({
    title: 'Notifikasi', size: 'md',
    body: `${deviceBox()}
      <h4 class="nt-sub">Suara</h4>
      <p class="muted sm">Pengaturan di jendela ini berlaku untuk perangkat ini saja, untuk peran ${esc(D_ROLE(u.role))}. Browser baru bisa memutar suara setelah layar diketuk sekali.</p>
      <label class="switch"><input type="checkbox" name="sound" ${p.sound ? 'checked' : ''}><span>Bunyikan notifikasi di perangkat ini</span></label>
      <label class="switch"><input type="checkbox" name="voice" ${p.voice ? 'checked' : ''}><span>Ucapkan isi notifikasi (suara bahasa Indonesia)</span></label>
      <h4 class="nt-sub">Jenis notifikasi</h4>
      <div class="nt-kinds">${groups.map(([title, l]) => `<div class="nt-grp">${esc(title)}</div>${l.map(([key, k]) => `<div class="nt-kind"><label class="switch sm"><input type="checkbox" name="k_${key}" ${enabled(key, u.role) ? 'checked' : ''}><span>${ic(k.icon, 16)} ${esc(k.label)}</span></label><button type="button" class="btn btn-sm btn-ghost" data-test="${key}" aria-label="Tes suara ${esc(k.label)}">Tes</button></div>`).join('')}`).join('')}</div>`,
    footer: `<button class="btn" data-close>Tutup</button><button class="btn btn-pri" data-ok>Simpan</button>`,
    onMount(m, api) {
      const repaint = () => { const el = m.querySelector('[data-dn].dn-box'); if (el) { const t = document.createElement('div'); t.innerHTML = deviceBox(); el.replaceWith(t.firstElementChild); } };
      DN.refreshInfo().then(repaint);
      const save = () => {
        const kinds = {};
        for (const [key] of list) kinds[key] = !!m.querySelector(`[name=k_${key}]`).checked;
        savePrefs(u.role, { sound: m.querySelector('[name=sound]').checked, voice: m.querySelector('[name=voice]').checked, kinds });
      };
      m.addEventListener('click', (e) => {
        const d = e.target.closest('button[data-dn]');
        if (d) { save(); d.disabled = true; deviceAction(d.dataset.dn, () => { repaint(); paintButton(); }); return; }
        const t = e.target.closest('[data-test]'); if (!t) return;
        unlock();
        const k = KINDS[t.dataset.test];
        const sample = { table: 'G1', no: 'A012', title: t.dataset.test === 'table_move' ? 'Meja A5 pindah ke meja G1' : k.label };
        if (!tone(k.sound)) return toast('Suara belum bisa diputar. Ketuk layar sekali lalu coba lagi, dan cek volume perangkat.', 'warn', 5000);
        if (m.querySelector('[name=voice]').checked && k.say) setTimeout(() => say(k.say(sample)), k.sound === 'order' ? 1500 : 1100);
      });
      m.querySelector('[data-ok]').onclick = () => {
        save(); DN.syncKinds();
        paintButton(); api.close(); toast('Pengaturan notifikasi disimpan untuk perangkat ini');
      };
    },
  });
}
const D_ROLE = (r) => ROLES[r]?.label || r;

// ---------- 2.5 · Lonceng di layar dapur: notifikasi dari kasir ----------
const KSEEN = 'kaly.kfeed.seen';
const kSeen = () => { try { return Number(localStorage.getItem(KSEEN)) || 0; } catch { return 0; } };
export function kitchenFeed(outlet) {
  return (getDb().alerts || []).filter((a) => KINDS[a.kind]?.station && (!a.loc || a.loc === outlet) && stationOk(a.ref)).sort((x, y) => y.id - x.id);
}
export const kitchenUnread = (outlet) => kitchenFeed(outlet).filter((a) => a.id > kSeen()).length;
export function openKitchenFeed(outlet, onSeen) {
  const list = kitchenFeed(outlet), seen = kSeen(), st = kdsStation();
  try { if (list.length) localStorage.setItem(KSEEN, String(Math.max(seen, list[0].id))); } catch {}
  const hm = (t) => new Date(t).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  openModal({
    title: 'Notifikasi dari kasir', size: 'md',
    body: `<p class="muted sm">6 jam terakhir, untuk stasiun <b>${st === 'all' ? 'Dapur & Bar' : st === 'bar' ? 'Bar' : 'Dapur'}</b> di perangkat ini${st === 'all' ? '' : ' (ubah di layar dapur: Semua / Dapur / Bar)'}. Pesanan baru, tambahan, pembatalan, dan pindah meja dari kasir.</p>
      ${list.length ? `<div class="kf-list">${list.map((a) => `<div class="kf ${a.kind === 'k_void' ? 'kf-void' : ''} ${a.id > seen ? 'kf-new' : ''}"><span class="kf-ic">${ic(KINDS[a.kind].icon, 17)}</span>
        <span class="kf-b"><b>${esc(a.title)}</b><small>${esc(a.detail || '')}</small></span><time>${hm(a.at)}</time></div>`).join('')}</div>`
      : '<p class="empty">Belum ada notifikasi dari kasir dalam 6 jam terakhir.</p>'}`,
    footer: `<button class="btn" data-close>Tutup</button>`,
  });
  onSeen && onSeen();
}
