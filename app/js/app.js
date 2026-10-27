// Kaly Ops — router, shell, sesi, dan event delegation
import { getDb, subscribe, currentUser, getTerminal } from './store.js';
import { $, $$, esc, ic, toast, fmtTime, dur, fmtDate, logo, kIcon } from './lib.js';
import * as D from './domain.js';
import * as C from './cloud.js';
import * as API from './api.js';
import * as N from './notify.js';
import * as DN from './devnotify.js';
import * as CR from './crew.js';
import Login from './views/login.js';
import Home from './views/home.js';
import POS from './views/pos.js';
import Kitchen from './views/kitchen.js';
import Lounge from './views/lounge.js';
import Display from './views/display.js';
import Core from './views/core.js';
import OrderAdmin from './views/order-admin.js';
import OrderPublic from './views/order-public.js';
import Loop from './views/loop.js';
import MemberPublic from './views/member-public.js';
import BookAdmin from './views/book-admin.js';
import BookPublic from './views/book-public.js';
import Goods from './views/goods.js';
import Settings from './views/settings.js';
import Denah from './views/denah.js';
import Print from './views/print.js';
import * as PS from './print-station.js';

export const NAV = [
  { r: '', label: 'Beranda', icon: 'house', roles: ['owner', 'kasir', 'dapur', 'gudang', 'service'] },
  { r: 'denah', label: 'Denah Meja', icon: 'map', roles: ['owner', 'kasir', 'service'], desc: 'Status meja live untuk service' },
  { r: 'pos', label: 'Kaly POS', icon: 'store', roles: ['owner', 'kasir', 'service'], desc: 'Kasir, meja, split bill, deposit' },
  { r: 'kitchen', label: 'Kaly Kitchen', icon: 'chef-hat', roles: ['owner', 'dapur'], desc: 'Layar dapur & serving time' },
  { r: 'core', label: 'Kaly Core', icon: 'layout-dashboard', roles: ['owner', 'gudang'], desc: 'Resep, stok, produksi, laporan' },
  { r: 'order-admin', label: 'Kaly Order', icon: 'qr-code', roles: ['owner', 'kasir'], desc: 'QR meja & pre-order reservasi' },
  { r: 'loop', label: 'Kaly Loop', icon: 'award', roles: ['owner', 'kasir'], desc: 'Member, campaign, misi' },
  { r: 'book-admin', label: 'Kaly Book', icon: 'calendar-check', roles: ['owner', 'kasir'], desc: 'Reservasi meja' },
  { r: 'goods', label: 'Kaly Goods', icon: 'truck', roles: ['owner', 'gudang'], desc: 'Supplier & purchase order' },
  { r: 'print', label: 'Stasiun cetak', icon: 'printer', roles: ['owner', 'kasir', 'service', 'dapur'], desc: 'Printer Bar, Dapur & kasir' },
  { r: 'settings', label: 'Pengaturan', icon: 'settings', roles: ['owner'] },
];
export const HOME = { owner: '', kasir: 'pos', dapur: 'kitchen', gudang: 'goods', service: 'denah' };
// 2.7 · Kaly Backoffice: akun Owner/Manajer memakai portal & menu tersendiri, terpisah dari operasional (POS, dapur, gudang, service)
export const isBO = (u = currentUser()) => u?.role === 'owner';
const BO_NAV = [
  ['Backoffice', [['', 'Dashboard', 'layout-dashboard'], ['core', 'Stok, resep & laporan', 'chart-column'], ['goods', 'Pembelian & supplier', 'truck'], ['pos', 'Menu & harga', 'utensils'],
    ['loop', 'Member & promo', 'award'], ['book-admin', 'Reservasi', 'calendar-check'], ['order-admin', 'Pesanan online & QR', 'qr-code'], ['settings', 'Pengaturan & printer', 'settings']]],
  ['Pantau operasional', [['denah', 'Denah meja', 'map'], ['kitchen', 'Layar dapur', 'chef-hat'], ['print', 'Stasiun cetak', 'printer']]],
];
// Menu tiap peran: halaman utama peran itu selalu paling atas (kasir → Kaly POS, service → Denah, dst.)
export function navFor(role) {
  const items = NAV.filter((n) => n.roles.includes(role));
  const main = HOME[role] ?? '';
  return [...items.filter((n) => n.r === main), ...items.filter((n) => n.r !== main)];
}
// Menu samping bisa disembunyikan di semua halaman (diingat per perangkat)
// Menu samping: mengikuti pilihan pengguna; bila belum pernah diatur, Kaly POS di tablet mendatar (901–1400 px) memakai layar penuh
const railHidden = (path, u) => {
  let v = null; try { v = localStorage.getItem('kaly.rail'); } catch {}
  if (v) return v === 'off';
  return path === 'pos' && ['kasir', 'service'].includes(u?.role) && innerWidth > 900 && innerWidth <= 1400;
};
const ROUTES = {
  login: { v: Login, pub: true, bare: true },
  backoffice: { v: Login, pub: true, bare: true, bo: true },
  '': { v: Home, title: 'Beranda' },
  pos: { v: POS, title: 'Kaly POS', wide: true },
  denah: { v: Denah, title: 'Denah Meja', wide: true },
  kitchen: { v: Kitchen, title: 'Kaly Kitchen', dark: true, wide: true },
  core: { v: Core, title: 'Kaly Core' },
  'order-admin': { v: OrderAdmin, title: 'Kaly Order' },
  loop: { v: Loop, title: 'Kaly Loop' },
  'book-admin': { v: BookAdmin, title: 'Kaly Book' },
  goods: { v: Goods, title: 'Kaly Goods' },
  settings: { v: Settings, title: 'Pengaturan' },
  print: { v: Print, title: 'Stasiun cetak' },
  lounge: { v: Lounge, pub: true, bare: true },
  display: { v: Display, pub: true, bare: true },
  order: { v: OrderPublic, pub: true, bare: true },
  track: { v: OrderPublic, pub: true, bare: true, track: true },
  book: { v: BookPublic, pub: true, bare: true },
  member: { v: MemberPublic, pub: true, bare: true },
};
for (const n of NAV) if (ROUTES[n.r]) ROUTES[n.r].roles = n.roles;

let cur = { name: null, view: null, ctx: null };

export function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  const q = Object.fromEntries(new URLSearchParams(qs || ''));
  return { path: path || '', q };
}
export const go = (path) => { location.hash = '#/' + path; };
// Outlet aktif per perangkat; dibatasi ke outlet yang boleh diakses staf
export const getOutlet = () => {
  let L = null; try { L = localStorage.getItem('kaly.outlet'); } catch {}
  const u = C.me, outs = getDb().locations.filter((l) => l.type === 'outlet').map((l) => l.id);
  const allowed = u?.outlets?.length ? outs.filter((x) => u.outlets.includes(x)) : outs;
  if (allowed.length && !allowed.includes(L)) L = allowed[0];
  return L || 'L1';
};
export const setOutlet = (L) => { try { localStorage.setItem('kaly.outlet', L); } catch {} rerender(); };
export const can = (route) => { const u = currentUser(); const r = ROUTES[route]; return !!u && (!r?.roles || r.roles.includes(u.role)); };

// Nama menu & urutan Backoffice (dipakai juga oleh kartu modul di Dashboard)
export const BO_LABEL = Object.fromEntries(BO_NAV.flatMap(([, l]) => l.map(([r, label]) => [r, label])));
export const BO_ORDER = BO_NAV.flatMap(([, l]) => l.map(([r]) => r));
// Portal terakhir yang dipakai perangkat ini (untuk halaman masuk setelah keluar)
export function portal(v) { try { if (v) localStorage.setItem('kaly.portal', v); return localStorage.getItem('kaly.portal') || 'ops'; } catch { return 'ops'; } }
function route() {
  const { path, q } = parseHash();
  let r = ROUTES[path];
  if (!r) { go(''); return; }
  const u = currentUser();
  if (!r.pub && !u) {
    const qs = new URLSearchParams(q).toString();
    const bo = (r.roles && r.roles.length === 1 && r.roles[0] === 'owner') || portal() === 'bo';
    location.hash = (bo ? '#/backoffice' : '#/login') + (path ? '?next=' + encodeURIComponent(path + (qs ? '?' + qs : '')) : ''); return;
  }
  if ((path === 'login' || path === 'backoffice') && u) { go(HOME[u.role] ?? ''); return; }
  if (!r.pub && r.roles && !r.roles.includes(u.role)) { toast('Akun ini tidak punya akses ke modul tersebut', 'warn'); go(''); return; }
  if (cur.view?.unmount) try { cur.view.unmount(); } catch (e) { console.error(e); }
  cur = { name: path, view: r.v, r, ctx: { q, path, track: r.track } };
  document.body.className = r.bare ? 'bare' : 'app' + (r.dark ? ' dark-view' : '') + (railHidden(path, u) ? ' rail-off' : '');
  if (u && !r.bare) document.body.dataset.role = u.role; else delete document.body.dataset.role;
  if (r.bare) document.getElementById('root').innerHTML = `<div id="view" class="bare-view"></div>`;
  else renderShell();
  draw(true);
}

function renderShell() {
  const u = currentUser();
  const db = getDb();
  const items = navFor(u.role);
  const L = getOutlet();
  const bo = isBO(u);
  document.body.classList.toggle('bo', bo);
  document.title = bo ? 'Kaly Backoffice' : 'Kaly Ops';
  const navHtml = bo
    ? BO_NAV.map(([sec, list]) => `<p class="nav-sec">${esc(sec)}</p>${list.filter(([r]) => items.some((n) => n.r === r)).map(([r, label, icon]) => `<a href="#/${r}" data-r="${r}">${ic(icon, 19)}<span>${esc(label)}</span></a>`).join('')}`).join('')
    : items.map((n) => `<a href="#/${n.r}" data-r="${n.r}">${ic(n.icon, 19)}<span>${esc(n.label)}</span></a>`).join('');
  document.getElementById('root').innerHTML = `
  <aside class="rail" aria-label="Navigasi">
    <a class="brand" href="#/" aria-label="${bo ? 'Kaly Backoffice' : 'Kaly Ops'} beranda">${logo('light')}${kIcon()}<span class="brand-t"><b>${bo ? 'Kaly Backoffice' : 'Kaly Ops'}</b><small>${bo ? 'Owner / Manajer' : 'Sistem operasional'}</small></span></a>
    <nav class="nav">${navHtml}</nav>
    <div class="rail-foot">
      <div class="who"><span class="avatar">${esc(u.name[0])}</span><span><b>${esc(u.name)}</b><small>${esc(D.ROLES[u.role].label)}</small></span></div>
      <button class="btn-icon" data-a="logout" aria-label="Keluar" title="Keluar">${ic('log-out')}</button>
    </div>
  </aside>
  <div class="main">
    <header class="top">
      <div class="top-l"><button class="btn-icon rail-tg" data-a="toggleRail" id="rail-tg" aria-label="Sembunyikan menu samping" title="Sembunyikan / tampilkan menu samping">${ic('panel-left-close', 19)}</button>
        <h1 id="top-title"></h1><span class="role-pill" title="Peran akun ini">${esc(D.ROLES[u.role].short || D.ROLES[u.role].label)}</span></div>
      <div class="top-r">
        <label class="outlet-sel" title="Outlet aktif">${ic('map-pin', 16)}<select data-a-change="outlet" aria-label="Outlet aktif">${db.locations.filter((l) => l.type === 'outlet' && (!u.outlets?.length || u.outlets.includes(l.id))).map((l) => `<option value="${l.id}" ${l.id === L ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
        <a class="pst" id="pst" href="#/print" hidden></a>
        ${CR.chipHtml()}
        <span class="sync" id="sync" title="Status koneksi ke database"></span>
        ${N.buttonHtml()}
        <button class="bell" data-a="notices" aria-label="${u.role === 'dapur' ? 'Notifikasi dari kasir' : 'Pesanan siap dari dapur'}" title="${u.role === 'dapur' ? 'Notifikasi dari kasir' : 'Pesanan siap dari dapur'}" id="bell">${ic('bell', 18)}<b id="bell-n"></b></button>
        <span class="clock" id="clock"></span>
      </div>
    </header>
    <main id="view" class="view"></main>
  </div>`;
}

export function rerender(src) { draw(false, src); }

function draw(first, src) {
  const v = cur.view;
  if (!v) return;
  const root = document.getElementById('view');
  if (!root) return;
  const ctx = { ...cur.ctx, user: currentUser(), db: getDb(), outlet: getOutlet(), terminal: getTerminal(), src };
  if (!first && v.refresh && src) { try { v.refresh(root, ctx); } catch (e) { console.error(e); } updateShell(); return; }
  const ae = document.activeElement;
  const focusId = ae && ae.id && root.contains(ae) ? ae.id : null;
  const sel = focusId && 'selectionStart' in ae ? [ae.selectionStart, ae.selectionEnd] : null;
  const scrolls = $$('[data-keep-scroll]', root).map((el) => [el.dataset.keepScroll, el.scrollTop]);
  const st = root.scrollTop;
  try { root.innerHTML = v.render(ctx); } catch (e) { console.error(e); root.innerHTML = `<div class="empty">Terjadi kesalahan saat menampilkan halaman: ${esc(e.message)}</div>`; }
  if (!first) root.scrollTop = st; else root.scrollTop = 0;
  scrolls.forEach(([k, t]) => { const el = $(`[data-keep-scroll="${k}"]`, root); if (el) el.scrollTop = t; });
  if (focusId) { const el = document.getElementById(focusId); if (el) { el.focus(); if (sel) try { el.setSelectionRange(...sel); } catch {} } }
  if (v.after) try { v.after(root, ctx, first); } catch (e) { console.error(e); }
  updateShell();
  tickSince();
}

function paintRailBtn() {
  const b = $('#rail-tg'); if (!b) return;
  const off = document.body.classList.contains('rail-off');
  b.innerHTML = ic(off ? 'panel-left-open' : 'panel-left-close', 19);
  b.setAttribute('aria-label', off ? 'Tampilkan menu samping' : 'Sembunyikan menu samping');
  b.setAttribute('aria-expanded', String(!off));
}
function updateShell() {
  if (document.body.classList.contains('bare')) return;
  paintRailBtn();
  const t = $('#top-title');
  if (t) t.textContent = (cur.view?.title && cur.view.title(cur.ctx)) || (isBO() && BO_LABEL[cur.name]) || cur.r?.title || '';
  $$('.nav a[data-r]').forEach((a) => a.classList.toggle('on', a.dataset.r === cur.name));
  const db = getDb();
  // Layar dapur: lonceng berisi notifikasi dari kasir (2.5); peran lain: pesanan siap dari dapur
  const n = currentUser()?.role === 'dapur' ? N.kitchenUnread(getOutlet()) : db.notices.filter((x) => !x.seen && x.loc === getOutlet()).length;
  const b = $('#bell-n');
  if (b) { b.textContent = n || ''; $('#bell').classList.toggle('has', n > 0); }
  syncBadge();
  paintStation();
  N.paintButton();
  CR.paintChip();
}
// Tanda di kanan atas bila perangkat ini menjadi stasiun cetak
function paintStation() {
  const el = $('#pst'); if (!el) return;
  const s = PS.state, p = getDb().printers.find((x) => x.id === PS.stationId());
  el.hidden = !(s.status !== 'off' && PS.stationId());
  if (el.hidden) return;
  el.className = 'pst ' + s.status;
  el.title = s.status === 'error' ? `Stasiun cetak: ${s.error}` : `Perangkat ini mencetak untuk ${p?.name || s.name || 'printer'}`;
  el.innerHTML = `${ic('printer', 16)}<span>${esc(p?.name || s.name || 'Stasiun cetak')}</span>`;
}
const SYNC = { ok: ['Tersinkron', ''], loading: ['Memuat data…', 'wait'], offline: ['Offline, mencoba lagi…', 'off'], expired: ['Sesi habis, masuk lagi', 'off'], off: ['', ''] };
function syncBadge() {
  const el = $('#sync');
  if (!el) return;
  const [t, c] = SYNC[C.syncStatus()] || SYNC.ok;
  el.className = 'sync ' + c;
  el.innerHTML = `<i></i>${t}`;
}

// Elemen dengan data-since menampilkan durasi berjalan (timer dapur, meja)
function tickSince() {
  const now = Date.now();
  const sla = (getDb().settings.slaMin || 15) * 60000;
  $$('[data-since]').forEach((el) => {
    const ms = now - Number(el.dataset.since);
    el.textContent = el.dataset.fmt === 'min' ? Math.floor(ms / 60000) + ' mnt' : dur(ms);
    if (el.dataset.sla !== undefined) { el.classList.toggle('t-warn', ms > sla * 0.66 && ms <= sla); el.classList.toggle('t-late', ms > sla); }
  });
  const c = $('#clock');
  if (c) c.textContent = fmtTime(now);
}

// ---------- Event delegation ----------
function findAction(name) {
  const v = cur.view;
  return (v?.actions && v.actions[name]) || GLOBAL[name];
}
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-a]');
  if (!el || el.disabled) return;
  const fn = findAction(el.dataset.a);
  if (!fn) return;
  e.preventDefault();
  run(fn, el, e);
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-a-change]');
  if (!el) return;
  const fn = findAction(el.dataset.aChange);
  fn && run(fn, el, e);
});
document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-in]');
  if (!el) return;
  cur.view?.input && cur.view.input(el.dataset.in, el, e, ctxNow());
});
document.addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-submit]');
  if (!f) return;
  e.preventDefault();
  const fn = findAction(f.dataset.submit);
  fn && run(fn, f, e);
});
// Jalankan aksi; error (termasuk error sinkron seperti penyimpanan penuh) ditampilkan sebagai pesan, tidak membuat layar macet
function run(fn, el, e) {
  const fail = (err) => { console.warn(err); toast(err?.message || 'Terjadi kesalahan', 'err', 5000); };
  try { Promise.resolve(fn(el, e, ctxNow())).catch(fail); } catch (err) { fail(err); }
}
export const ctxNow = () => ({ ...cur.ctx, user: currentUser(), db: getDb(), outlet: getOutlet(), terminal: getTerminal() });

const GLOBAL = {
  async logout() { const bo = isBO(); await DN.onLogout(); await C.signOut(); toast('Kamu sudah keluar'); location.hash = bo ? '#/backoffice' : '#/login'; },
  outlet(el) { setOutlet(el.value); },
  toggleRail() {
    const off = !document.body.classList.contains('rail-off');
    document.body.classList.toggle('rail-off', off);
    try { localStorage.setItem('kaly.rail', off ? 'off' : 'on'); } catch {}
    paintRailBtn();
  },
  go(el) { go(el.dataset.to || ''); },
  soundPrefs() { N.openPrefs(); },
  crewPick() { CR.pickDialog({ onDone: () => rerender() }); },
  notices(el, e, ctx) {
    if (ctx.user?.role === 'dapur') return N.openKitchenFeed(ctx.outlet, () => updateShell());
    import('./views/pos.js').then((m) => m.showNotices(ctx));
  },
};

// ---------- Boot ----------
subscribe((src) => {
  if (src === 'status') return syncBadge();
  if (src === 'station') { paintStation(); if (cur.name === 'print') rerender(src); return; }
  if (src === 'session') {
    const r = ROUTES[parseHash().path];
    if (r && !r.pub && !currentUser()) { location.hash = '#/login'; return; }
  }
  if (src === 'auth') {
    // Tab lain keluar / masuk dengan akun berbeda: muat ulang halaman supaya data sesuai akun
    C.currentSession().then((s) => { if ((!!s) !== (!!C.me)) location.reload(); });
    return;
  }
  if (src === 'display' && cur.name !== 'display') return;
  rerender(src);
});
window.addEventListener('hashchange', route);
setInterval(tickSince, 1000);
// Pesanan terjadwal: layar staf yang terbuka mengirimnya ke dapur saat waktunya tiba
async function releaseTick() {
  if (!currentUser() || !D.dueScheduled(getDb()).length) return;
  try { const n = await API.releaseDue(); if (n) { toast(`${n} pesanan terjadwal dikirim otomatis ke dapur`, 'info'); await C.refresh('orders'); } } catch (e) { console.warn(e); }
}
setInterval(releaseTick, 20000);

async function start() {
  const r = ROUTES[parseHash().path];
  if (C.configured && !(r?.pub && r !== ROUTES.login)) {
    try { await C.boot(); } catch (e) { toast(e.message, 'err', 6000); }
  } else if (C.configured) {
    C.boot().then(() => { if (C.me) rerender(); }).catch(() => {});
  }
  route();
  N.start({ getOutlet });
  setTimeout(releaseTick, 2000);
}
start();
