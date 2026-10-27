import { $, esc, ic, toast, formData, logo } from '../lib.js';
import * as C from '../cloud.js';
import { HOME } from '../app.js';

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
    <p>Kaly Ops belum tersambung ke database Supabase. Lakukan sekali sebelum diunggah ke Netlify:</p>
    <ol>
      <li>Buka project Supabase Anda, lalu <b>Project Settings → API Keys</b> (atau tombol <b>Connect</b>).</li>
      <li>Salin <b>Project URL</b> dan <b>anon / publishable key</b>.</li>
      <li>Buka file <code>js/config.js</code> di folder Kaly Ops dengan Notepad, tempel keduanya di antara tanda kutip, lalu simpan.</li>
      <li>Unggah ulang folder Kaly Ops ke Netlify.</li>
    </ol>
    <p class="hint">Jangan memakai service_role / secret key. Langkah lengkapnya ada di README paket database.</p>
  </div>`;
}

export default {
  render(ctx) {
    const brand = ctx.db.settings.brand;
    return `<div class="login">
      <section class="login-art terrace">
        <div class="login-brand">${logo('light')}<div><h1>Kaly Ops</h1><p>Sistem operasional terintegrasi ${esc(brand.name)}. ${esc(brand.tagline)}</p></div></div>
        <ul class="login-mods">${MODS.map(([i, t, d]) => `<li>${ic(i, 20)}<span><b>${t}</b><small>${d}</small></span></li>`).join('')}</ul>
        <p class="login-note">${ic('refresh-cw', 16)} Semua kasir, dapur, layar antrean, dan HP pelanggan memakai data yang sama dan tersinkron otomatis.</p>
      </section>
      <section class="login-side">
        ${C.configured ? `<form data-submit="login" class="card login-card">
          <h2>Masuk ke Kaly Ops</h2>
          <label class="fld"><span>Email</span><input name="email" id="lg-email" type="email" autocomplete="username" required placeholder="nama@email.com"></label>
          <label class="fld"><span>Kata sandi</span><input name="pass" id="lg-pass" type="password" autocomplete="current-password" required></label>
          <button class="btn btn-pri btn-block btn-lg" type="submit" id="lg-btn">Masuk</button>
          <p class="hint">Akun dibuat Owner di Supabase (Authentication → Users) dengan email yang sama seperti di daftar staf. Lupa kata sandi? Minta Owner menggantinya di sana.</p>
        </form>` : setupCard()}
        <div class="pub-links">
          <h3>Halaman untuk pelanggan</h3>
          <a href="#/order?meja=G1" target="_blank" rel="noopener">${ic('smartphone', 16)} Pesan dari meja G1</a>
          <a href="#/book" target="_blank" rel="noopener">${ic('calendar-check', 16)} Reservasi meja</a>
          <a href="#/member" target="_blank" rel="noopener">${ic('award', 16)} Kartu member Kaly Loop</a>
          <a href="#/lounge" target="_blank" rel="noopener">${ic('tv', 16)} Layar antrean</a>
        </div>
      </section>
    </div>`;
  },
  actions: {
    async login(form, e, ctx) {
      const f = formData(form);
      const btn = $('#lg-btn');
      btn.disabled = true; btn.textContent = 'Memeriksa…';
      try {
        const u = await C.signIn(f.email, f.pass);
        toast(`Selamat datang, ${u.name}`);
        const next = ctx.q.next;
        location.hash = '#/' + (next && next !== 'login' ? next : HOME[u.role] ?? '');
      } catch (err) {
        toast(err.message, 'err', 6000);
        btn.disabled = false; btn.textContent = 'Masuk';
      }
    },
  },
};
