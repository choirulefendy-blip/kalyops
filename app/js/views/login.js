import { $, esc, ic, toast, formData, logo } from '../lib.js';
import * as C from '../cloud.js';
import { HOME, portal, MODE, OPS_URL, BO_URL, wrongApp } from '../app.js';

const BO_MODS = [
  ['layout-dashboard', 'Dashboard & laporan', 'Penjualan, laba rugi, laporan shift, fraud'],
  ['chart-column', 'Stok & resep', 'Bahan, resep bertingkat, opname, HPP'],
  ['truck', 'Pembelian', 'Supplier, persetujuan & pembayaran PO'],
  ['utensils', 'Menu & harga', 'Kelola menu, impor Excel, tampilan nota'],
  ['award', 'Member & promo', 'Kaly Loop, campaign, voucher'],
  ['settings', 'Pengaturan', 'Staf & akses, printer, notifikasi, PIN manajer'],
];
const MODS = [
  ['store', 'Kaly POS', 'Kasir lengkap, meja, split bill, deposit'],
  ['layout-dashboard', 'Kaly Core', 'Resep bertingkat, stok, laporan keuangan'],
  ['qr-code', 'Kaly Order', 'Scan, pesan, bayar dari meja atau rumah'],
  ['award', 'Kaly Loop', 'Member, misi, campaign tertarget'],
  ['calendar-check', 'Kaly Book', 'Reservasi meja & gazebo'],
  ['chef-hat', 'Kaly Kitchen', 'Layar dapur & analisa serving time'],
  ['tv', 'Kaly Lounge', 'Layar antrean dengan suara'],
  ['truck', 'Kaly Goods', 'Supplier terverifikasi & purchase order'],
];

function setupCard() {
  return `<div class="card login-card setup-card">
    <h2>Sambungkan ke database</h2>
    <p>Kaly Ops belum tersambung ke database Supabase. Lakukan sekali sebelum diunggah ke GitHub:</p>
    <ol>
      <li>Buka project Supabase Anda, lalu <b>Project Settings → API Keys</b> (atau tombol <b>Connect</b>).</li>
      <li>Salin <b>Project URL</b> dan <b>anon / publishable key</b>.</li>
      <li>Buka file <code>js/config.js</code> di folder Kaly Ops dengan Notepad, tempel keduanya di antara tanda kutip, lalu simpan.</li>
      <li>Unggah ulang ke repository GitHub (folder <code>app</code>); GitHub Pages memperbarui situs otomatis.</li>
    </ol>
    <p class="hint">Jangan memakai service_role / secret key. Langkah lengkapnya ada di README paket database.</p>
  </div>`;
}

// 2.16: kartu "alamat yang benar" saat akun masuk di aplikasi yang bukan untuknya
function wrongCard(bo) {
  const url = bo ? OPS_URL : BO_URL, name = bo ? 'Kaly Ops' : 'Kaly Backoffice', apk = bo ? 'kaly-ops.apk' : 'kaly-backoffice.apk';
  if (!url) return '';
  return `<div class="banner warn login-wrong">${ic('info', 18)}<span>${bo ? 'Akun kasir, dapur, gudang, dan service masuk lewat <b>Kaly Ops</b>.' : 'Akun Owner / Manajer masuk lewat <b>Kaly Backoffice</b>, aplikasi dan alamat tersendiri.'}
    <br><a class="btn btn-sm btn-pri" href="${esc(url)}/" target="_blank" rel="noopener">Buka ${name}</a><a class="btn btn-sm" href="${esc(url)}/android/${apk}" download>Unduh aplikasi Android ${name}</a><br><small class="muted">${esc(url.replace(/^https?:\/\//, ''))}</small></span></div>`;
}
const otherLink = (bo) => {
  if (MODE === 'backoffice') return OPS_URL ? `Staf operasional? <a href="${esc(OPS_URL)}/" target="_blank" rel="noopener">Masuk ke Kaly Ops</a> (${esc(OPS_URL.replace(/^https?:\/\//, ''))}).` : '';
  if (MODE === 'ops') return BO_URL ? `Owner / Manajer? <a href="${esc(BO_URL)}/" target="_blank" rel="noopener">Buka Kaly Backoffice</a> (${esc(BO_URL.replace(/^https?:\/\//, ''))}).` : '';
  return bo ? 'Staf operasional? <a href="#/login">Masuk ke Kaly Ops</a>.' : 'Owner / Manajer? <a href="#/backoffice">Masuk ke Kaly Backoffice</a>.';
};

export default {
  render(ctx) {
    const brand = ctx.db.settings.brand, bo = MODE ? MODE === 'backoffice' : (!!ctx.r?.bo || ctx.path === 'backoffice');
    const mods = bo ? BO_MODS : MODS;
    return `<div class="login ${bo ? 'login-bo' : ''}">
      <section class="login-art terrace">
        <div class="login-brand">${logo('light')}<div><h1>${bo ? 'Kaly Backoffice' : 'Kaly Ops'}</h1><p>${bo ? `Khusus Owner / Manajer ${esc(brand.name)}: laporan, keuangan, stok, pembelian, menu, dan pengaturan.` : `Sistem operasional terintegrasi ${esc(brand.name)}. ${esc(brand.tagline)}`}</p></div></div>
        <ul class="login-mods">${mods.map(([i, t, d]) => `<li>${ic(i, 20)}<span><b>${t}</b><small>${d}</small></span></li>`).join('')}</ul>
        <p class="login-note">${ic(bo ? 'lock' : 'refresh-cw', 16)} ${bo ? 'Akun kasir, dapur, gudang, dan service tidak bisa masuk ke Backoffice.' : 'Semua kasir, dapur, layar antrean, dan HP pelanggan memakai data yang sama dan tersinkron otomatis.'}</p>
      </section>
      <section class="login-side">
        ${MODE && ctx.q.wrong ? wrongCard(bo) : ''}
        ${C.configured ? `<form data-submit="login" class="card login-card">
          <h2>${bo ? 'Masuk ke Kaly Backoffice' : 'Masuk ke Kaly Ops'}</h2>
          ${bo ? '<p class="muted sm">Khusus akun Owner / Manajer.</p>' : '<p class="muted sm">Untuk kasir, dapur, gudang, dan service.</p>'}
          <label class="fld"><span>Email</span><input name="email" id="lg-email" type="email" autocomplete="username" required placeholder="nama@email.com" value="${esc(ctx.q.email || '')}"></label>
          <label class="fld"><span>Kata sandi</span><input name="pass" id="lg-pass" type="password" autocomplete="current-password" required></label>
          <button class="btn btn-pri btn-block btn-lg" type="submit" id="lg-btn">Masuk</button>
          <p class="hint">${otherLink(bo)} Akun dibuat Owner di Supabase (Authentication → Users) dengan email yang sama seperti di daftar staf.</p>
        </form>` : setupCard()}
        ${bo ? '' : `<div class="pub-links">
          <h3>Halaman untuk pelanggan</h3>
          <a href="#/order?meja=G1" target="_blank" rel="noopener">${ic('smartphone', 16)} Pesan dari meja G1</a>
          <a href="#/book" target="_blank" rel="noopener">${ic('calendar-check', 16)} Reservasi meja</a>
          <a href="#/member" target="_blank" rel="noopener">${ic('award', 16)} Kartu member Kaly Loop</a>
          <a href="#/lounge" target="_blank" rel="noopener">${ic('tv', 16)} Layar antrean</a>
        </div>`}
      </section>
    </div>`;
  },
  actions: {
    async login(form, e, ctx) {
      const f = formData(form);
      const btn = $('#lg-btn');
      btn.disabled = true; btn.textContent = 'Memeriksa…';
      try {
        const bo = MODE ? MODE === 'backoffice' : ctx.path === 'backoffice';
        const u = await C.signIn(f.email, f.pass);
        if (MODE && wrongApp(u.role)) {   // 2.16: alamat/aplikasi terpisah per peran
          await C.signOut();
          toast(MODE === 'backoffice' ? 'Kaly Backoffice khusus Owner / Manajer. Akun ini masuk lewat Kaly Ops.' : 'Akun Owner / Manajer masuk lewat Kaly Backoffice.', 'warn', 8000);
          location.hash = (bo ? '#/backoffice' : '#/login') + '?wrong=1&email=' + encodeURIComponent(f.email);
          btn.disabled = false; btn.textContent = 'Masuk'; return;
        }
        if (bo && u.role !== 'owner') {   // Backoffice hanya untuk Owner / Manajer
          await C.signOut();
          toast('Kaly Backoffice khusus Owner / Manajer. Akun ini masuk lewat Kaly Ops.', 'warn', 7000);
          location.hash = '#/login?email=' + encodeURIComponent(f.email); return;
        }
        portal(u.role === 'owner' ? 'bo' : 'ops');
        toast(u.role === 'owner' && !bo && !MODE ? `Selamat datang, ${u.name}. Akun Owner / Manajer dibuka di Kaly Backoffice.` : `Selamat datang, ${u.name}`, 'ok', 5000);
        const next = ctx.q.next;
        location.hash = '#/' + (next && next !== 'login' ? next : HOME[u.role] ?? '');
      } catch (err) {
        toast(err.message, 'err', 6000);
        btn.disabled = false; btn.textContent = 'Masuk';
      }
    },
  },
};
