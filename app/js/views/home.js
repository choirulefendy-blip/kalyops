import { esc, ic, rp, num, startOfDay, fmtDate, qrSvg } from '../lib.js';
import * as D from '../domain.js';
import { navFor } from '../app.js';
import { stationId } from '../print-station.js';
import * as DN from '../devnotify.js';
import { deviceAction } from '../notify.js';
import { rerender, BO_LABEL, BO_ORDER } from '../app.js';

// 2.4: ajakan menyalakan notifikasi di perangkat untuk Owner/Manajer & gudang (bisa disembunyikan)
const HIDE = 'kaly.dnhint.v1';
function dnHint(u) {
  if (!['owner', 'gudang'].includes(u.role) || !DN.support().ok || DN.isOn(u.role) || DN.permission() === 'denied') return '';
  try { if (localStorage.getItem(HIDE) === u.id) return ''; } catch {}
  return `<div class="banner info dn-hint">${ic('bell', 18)}<span><b>Terima ${u.role === 'owner' ? 'laporan shift, ringkasan penjualan, fraud, dan stok' : 'kabar PO, barang masuk, dan stok'} di perangkat ini.</b> Muncul di bilah notifikasi seperti aplikasi lain${DN.support().closed ? ', juga saat Kaly Ops ditutup' : ''}.</span>
    <button class="btn btn-sm btn-pri" data-a="dnOn">Aktifkan</button><button class="btn-icon sm" data-a="dnHide" aria-label="Sembunyikan ajakan notifikasi">${ic('x', 15)}</button></div>`;
}

function alerts(db, L) {
  const out = [];
  const bl = D.stockBlockedMenus(db, L);
  if (bl.length) out.push(`<div class="banner warn">${ic('package', 18)}<span><b>${bl.length} menu habis karena bahan:</b> ${bl.slice(0, 5).map((m) => esc(m.name)).join(', ')}${bl.length > 5 ? ', …' : ''}</span><a class="btn btn-sm" href="#/goods">Buat PO</a></div>`);
  return out.join('');
}

function status(db, r, L, role) {
  if (r === 'pos' && role === 'owner') { const n = db.menus.filter((m) => m.active && (!m.outlets || m.outlets.includes(L))).length; return [`${n} menu aktif`, 'Kelola menu & tampilan nota']; }
  const t0 = startOfDay();
  const today = db.orders.filter((o) => o.created >= t0);
  switch (r) {
    case 'pos': { const open = db.orders.filter((o) => o.loc === L && o.status === 'open'); const tb = new Set(open.filter((o) => o.table).map((o) => o.table)); return [`${tb.size} meja terisi`, `${open.length} bill terbuka`]; }
    case 'denah': { const open = db.orders.filter((o) => o.loc === 'L1' && o.status === 'open' && o.table); const tb = new Set(open.flatMap((o) => [o.table, ...(o.merged || [])])); const rd = open.filter((o) => D.kitchenLines(o).some((l) => l.s === 'ready')).length; return [`${tb.size} dari ${db.tables.filter((t) => t.loc === 'L1').length} meja terisi`, `${rd} meja menunggu diantar`]; }
    case 'kitchen': { const k = today.filter((o) => o.loc === L && ['new', 'cook'].includes(D.kitchenState(o))); return [`${k.length} pesanan di dapur`, `${today.filter((o) => D.kitchenState(o) === 'ready').length} siap diantar`]; }
    case 'core': { const paid = today.filter((o) => o.status === 'paid'); const low = db.locations.reduce((s, l) => s + D.lowStock(db, l.id).length, 0); return [`${rp(D.sumTotals(paid))} hari ini`, `${low} bahan di bawah stok minimum`]; }
    case 'order-admin': { const on = today.filter((o) => o.ch !== 'pos'); return [`${on.length} pesanan QR & online`, `${db.orders.filter((o) => o.sched && !o.released && o.status !== 'void').length} terjadwal`]; }
    case 'loop': { const mo = String(new Date().getMonth() + 1).padStart(2, '0'); return [`${num(db.members.length)} member`, `${db.members.filter((m) => m.bday?.startsWith(mo)).length} ulang tahun bulan ini`]; }
    case 'book-admin': { const k = new Date(); const key = `${k.getFullYear()}-${String(k.getMonth() + 1).padStart(2, '0')}-${String(k.getDate()).padStart(2, '0')}`; const rs = db.reservations.filter((x) => x.date === key && D.RES_ACTIVE.includes(x.status)); return [`${rs.length} reservasi hari ini`, `${db.reservations.filter((x) => x.status === 'menunggu').length} menunggu konfirmasi`]; }
    case 'goods': return [`${db.pos.filter((p) => p.status === 'diajukan').length} PO menunggu persetujuan`, `${db.pos.filter((p) => p.status === 'diterima').length} tagihan supplier belum dibayar`];
    case 'print': { const ps = (db.printers || []).filter((p) => p.active && p.loc === L), on = ps.filter((p) => p.seen && Date.now() - p.seen < 90000).length; const me = ps.find((p) => p.id === stationId());
      return [ps.length ? `${on}/${ps.length} printer aktif` : 'Belum ada printer', me ? `Perangkat ini: ${me.name}` : 'Perangkat ini bukan stasiun']; }
    default: return ['', ''];
  }
}

// Daftar persiapan untuk Owner sebelum transaksi pertama
function setup(db) {
  const unlinked = db.users.filter((x) => x.active && !x.linked).length;
  const items = [
    [db.users.length > 1 && !unlinked, 'Akun staf', unlinked ? `${unlinked} staf belum punya akun login. Buat di Supabase (Authentication → Users) dengan email yang sama.` : 'Tambahkan staf dan perannya di Pengaturan.', '#/settings'],
    [false, 'PIN manajer', 'Ganti PIN bawaan 1234 di Pengaturan.', '#/settings'],
    [db.opnames.length > 0, 'Stok awal', 'Stok awal masih contoh. Lakukan stock opname pertama di Kaly Core supaya sesuai stok fisik.', '#/core'],
    [db.suppliers.length > 0, 'Supplier', 'Tambahkan supplier dan harga acuannya di Kaly Goods.', '#/goods'],
    [!!db.settings.qrisImage, 'QRIS toko', 'Unggah gambar QRIS dari bank di Kaly Order, tab Pengaturan, supaya tampil di jendela bayar dan halaman pesan online.', '#/order-admin'],
  ];
  return `<section class="card"><div class="card-h"><h3>Persiapan sebelum buka</h3><span class="muted sm">Hilang otomatis setelah transaksi pertama</span></div>
    <ul class="rules">${items.map(([done, t, d, href]) => `<li><b>${done ? ic('circle-check', 16) + ' ' : ''}<a href="${href}">${esc(t)}</a></b><small>${esc(d)}</small></li>`).join('')}</ul></section>`;
}

export default {
  render(ctx) {
    const db = ctx.db, u = ctx.user, L = ctx.outlet;
    const t0 = startOfDay();
    const paid = db.orders.filter((o) => o.status === 'paid' && o.created >= t0);
    const flags = db.flags.filter((f) => f.status === 'open').length;
    let mods = navFor(u.role).filter((n) => n.r && n.r !== 'settings');
    if (u.role === 'owner') mods = mods.map((n) => ({ ...n, label: BO_LABEL[n.r] || n.label })).sort((a, b) => BO_ORDER.indexOf(a.r) - BO_ORDER.indexOf(b.r));   // Kaly Backoffice
    const base = location.href.split('#')[0];
    const h = new Date().getHours();
    const greet = h < 11 ? 'Selamat pagi' : h < 15 ? 'Selamat siang' : h < 18 ? 'Selamat sore' : 'Selamat malam';
    return `<div class="home">
      <section class="hello">
        <div><h2>${greet}, ${esc(u.name)}</h2><p class="muted">${fmtDate(Date.now(), true)}. ${esc(D.loc(db, L).name)}.</p></div>
        ${u.role === 'owner' ? `<div class="hello-stats"><div><small>Penjualan hari ini</small><b>${rp(D.sumTotals(paid))}</b></div><div><small>Transaksi</small><b>${paid.length}</b></div><div><small>Flag fraud terbuka</small><b class="${flags ? 'neg' : ''}">${flags}</b></div></div>` : ''}
      </section>
      ${dnHint(u)}
      ${u.role === 'owner' || u.role === 'gudang' ? alerts(db, L) : ''}
      <section class="mods">${mods.map((n) => { const [a, b] = status(db, n.r, L, u.role); return `<a class="mod" href="#/${n.r}"><span class="mod-i">${ic(n.icon, 24)}</span><span class="mod-t"><b>${esc(n.label)}</b><small>${esc(n.r === 'pos' && u.role === 'owner' ? 'Kelola menu, impor Excel, tampilan nota' : n.desc)}</small></span><span class="mod-s"><span>${esc(a)}</span><span class="muted">${esc(b)}</span></span></a>`; }).join('')}</section>
      ${u.role === 'owner' && !db.orders.some((o) => o.status === 'paid') ? setup(db) : ''}
      <section class="card layar">
        <div class="card-h"><h3>${ic('tv', 18)} Layar & halaman pelanggan</h3><span class="muted sm">Dibuka di tab baru, cocok untuk TV, monitor kedua, atau tablet</span></div>
        <div class="screens">
          <a href="#/lounge?loc=${L}" target="_blank" rel="noopener">${ic('tv', 18)}<span><b>Kaly Lounge</b><small>Layar antrean dengan notifikasi suara</small></span></a>
          <a href="#/display?t=${encodeURIComponent(ctx.terminal)}" target="_blank" rel="noopener">${ic('monitor', 18)}<span><b>Layar pelanggan</b><small>Menampilkan isi keranjang ${esc(ctx.terminal)}</small></span></a>
          <a href="#/order?meja=G1" target="_blank" rel="noopener">${ic('smartphone', 18)}<span><b>Pesan dari meja</b><small>Contoh QR meja G1</small></span></a>
          <a href="#/book" target="_blank" rel="noopener">${ic('calendar-check', 18)}<span><b>Reservasi</b><small>Halaman booking untuk Instagram & WhatsApp</small></span></a>
          <a href="#/member" target="_blank" rel="noopener">${ic('award', 18)}<span><b>Kartu member</b><small>Halaman Kaly Loop berlabel brand</small></span></a>
        </div>
      </section>
      <div class="grid2">
        <section class="card">
          <div class="card-h"><h3>Alur satu pesanan</h3></div>
          <ol class="steps">
            <li><b>Catat pesanan.</b> Buka Kaly POS, pilih meja kosong, ketuk beberapa menu, lalu Kirim ke dapur.</li>
            <li><b>Masak.</b> Kaly Kitchen di layar dapur menampilkan tiketnya. Ketuk item untuk mulai masak, lalu tandai siap atau scan barcode tiket.</li>
            <li><b>Panggil pelanggan.</b> Layar Lounge berbunyi, dan bagian Lounge di Kaly POS memindahkan nomornya ke <i>Siap diambil</i>.</li>
            <li><b>Bayar.</b> Selesaikan pembayaran. Stok bahan terpotong sesuai resep dan jurnal tercatat di Kaly Core.</li>
          </ol>
        </section>
        <section class="card">
          <div class="card-h"><h3>Coba pesan dari HP</h3></div>
          <div class="qr-mini">${qrSvg(base + '#/order?meja=G1', 3)}<p class="muted sm">Scan dengan HP untuk mencoba pesan dari meja G1. Pesanan langsung masuk ke kasir dan dapur.</p></div>
        </section>
      </div>
    </div>`;
  },
  actions: {
    dnOn(el) { el.disabled = true; deviceAction('on', () => rerender()); },
    dnHide(el, e, ctx) { try { localStorage.setItem(HIDE, ctx.user.id); } catch {} rerender(); },
  },
};
