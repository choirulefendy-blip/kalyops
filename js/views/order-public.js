// Kaly Order (pelanggan) — scan QR meja atau pre-order reservasi, pesan, bayar; plus halaman lacak pesanan.
// Semua data dari fungsi publik database (tanpa login); harga & tagihan dihitung di server.
import { esc, ic, rp, num, toast, fmtTime, fmtDT, fmtDate, logo } from '../lib.js';
import * as D from '../domain.js';
import * as C from '../cloud.js';
import { menuPic } from '../media.js';
import { rerender } from '../app.js';

let st = null;
const LOC = 'L1';
const TYPE_LABEL = D.TYPE_LABEL;
function saved() { try { return JSON.parse(localStorage.getItem('kaly.cust')) || {}; } catch { return {}; } }
const norm = (p) => { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('62')) d = '0' + d.slice(2); return d; };
const pdb = () => C.pub.db;

// ---------- Muat data publik ----------
let loading = false, lastLoad = 0;
async function loadAll(q) {
  if (loading) return; loading = true;
  try {
    const [, ctx] = await Promise.all([C.loadPublic(LOC), C.rpc('public_order_ctx', { p_table: q.meja || null, p_res: q.res || null, p_loc: LOC })]);
    st.ctx = ctx; lastLoad = Date.now();
    if (ctx.reservation) { st.res = ctx.reservation; st.type = 'dine'; st.table = ctx.reservation.table; if (!st.form.name) st.form.name = ctx.reservation.name; if (!st.form.phone) st.form.phone = ctx.reservation.phone; st.form.when = 'res'; }
    else if (q.meja && ctx.table) { st.type = 'dine'; st.table = ctx.table.id; }
  } catch (e) { toast(e.message, 'err', 6000); st.err = e.message; lastLoad = Date.now(); }
  finally { loading = false; quoteSoon(); rerender(); }
}
function init(ctx) {
  const key = JSON.stringify(ctx.q);
  if (st && st.key === key) { if (Date.now() - lastLoad > 30000 && !loading && !st.sheet) loadAll(ctx.q); return; }
  const q = ctx.q, sv = saved();
  st = { key, cart: [], cat: 'all', sheet: false, type: 'dine', table: null, res: null, ctx: null, quote: null, qkey: null, reco: null, rkey: null,
    form: { name: sv.name || '', phone: sv.phone || '', member: true, voucher: '', pay: 'online' } };
  loadAll(q);
}
const cartQty = (m) => st.cart.filter((c) => c.m === m).reduce((s, c) => s + c.q, 0);
const menuOf = (id) => pdb()?.menus.find((m) => m.id === id);
const blocked = (m) => !m || !m.available;

// Perkiraan tagihan dari server (promo, member, voucher, pajak, ongkir)
let qT = null;
function quoteSoon() {
  clearTimeout(qT);
  qT = setTimeout(async () => {
    if (!st || !st.cart.length) return;
    const p = { mode: 'meja', items: st.cart.map((c) => ({ menu: c.m, qty: c.q })), phone: st.form.phone, voucher: st.form.voucher };
    const key = JSON.stringify(p);
    if (st.qkey === key && st.quote) return;
    try { const r = await C.rpc('public_quote', { p }); if (st && JSON.stringify(p) === key) { st.quote = r; st.qkey = key; paintSummary(); } } catch (e) { console.warn(e); }
  }, 250);
}
function paintSummary() {
  const s = document.getElementById('sum'); if (s) s.innerHTML = summaryHtml();
  const bar = document.querySelector('.cart-bar b'); if (bar && st.quote) bar.textContent = rp(Number(st.quote.bill.total));
}
function localTotal() { return st.cart.reduce((s, c) => s + c.q * (menuOf(c.m)?.price || 0), 0); }

function itemCard(m) {
  const q = cartQty(m.id);
  const off = blocked(m);
  const left = !off && m.left != null && m.left <= 5 ? `<span class="badge b-warn">Sisa ${m.left}</span>` : '';
  return `<article class="si ${off ? 'off' : ''}">${menuPic(m, 'md', 'si-pic')}<div class="si-t"><h4>${esc(m.name)}</h4>${m.desc ? `<p>${esc(m.desc)}</p>` : ''}<span class="si-tags">${m.tags?.includes('best') ? '<span class="badge b-ok">Terlaris</span>' : ''}${m.tags?.includes('new') ? '<span class="badge b-info">Baru</span>' : ''}${left}</span></div>
    <div class="si-r">${off ? '<span class="badge b-err">Habis</span>' : `<b>${rp(m.price)}</b>`}${off ? '' : q ? `<span class="qty"><button data-a="dec" data-id="${m.id}" aria-label="Kurangi">${ic('minus', 15)}</button><b>${q}</b><button data-a="inc" data-id="${m.id}" aria-label="Tambah">${ic('plus', 15)}</button></span>` : `<button class="btn btn-sm btn-brand" data-a="inc" data-id="${m.id}">${ic('plus', 15)} Tambah</button>`}</div></article>`;
}

function summaryHtml() {
  const s = pdb().settings, qd = st.quote;
  if (!qd) return `<p class="muted sm">Menghitung total…</p>`;
  const b = qd.bill, mem = qd.member;
  const vmsg = qd.voucher ? (qd.voucher.ok ? `<span class="pos sm">Voucher ${esc(qd.voucher.code)} dipakai</span>` : `<span class="neg sm">${esc(qd.voucher.msg || 'Voucher tidak bisa dipakai')}</span>`) : '';
  return `${vmsg}<dl class="bill-tot"><dt>Subtotal</dt><dd>${rp(b.sub)}</dd>${(b.discs || []).map((d) => `<dt class="disc">${esc(d.label)}</dt><dd class="disc">-${rp(d.amt)}</dd>`).join('')}${Number(b.svc) ? `<dt>Service</dt><dd>${rp(b.svc)}</dd>` : ''}<dt>PB1 ${Math.round(s.taxRate * 100)}%</dt><dd>${rp(b.tax)}</dd>${Number(b.deliv) ? `<dt>Ongkir</dt><dd>${rp(b.deliv)}</dd>` : ''}<dt class="grand">Total</dt><dd class="grand">${rp(b.total)}</dd></dl>
    ${mem ? `<p class="mem-note">${ic('award', 16)} Halo ${esc(mem.name)}, kamu member ${esc(mem.tier)} dengan ${num(mem.points)} poin. Pesanan ini menambah sekitar ${Math.floor((Number(b.base) / (s.pointsPer || 10000)) * (Number(mem.mult) || 1))} poin.</p>` : st.form.member && norm(st.form.phone).length >= 9 ? `<p class="mem-note">${ic('gift', 16)} Nomor ini akan otomatis jadi member Kaly Loop dengan bonus ${num(s.welcomePoints)} poin.</p>` : ''}`;
}

function recoList(ids) {
  const key = ids.slice().sort().join(',');
  if (!ids.length) return [];
  if (st.rkey !== key) {
    st.rkey = key; st.reco = null;
    C.rpc('public_reco', { p_menus: ids, p_loc: LOC }).then((r) => { if (st && st.rkey === key) { st.reco = r || []; if (st.sheet) rerender(); } }).catch(() => {});
  }
  return (st.reco || []).filter((r) => !ids.includes(r.m) && menuOf(r.m) && !blocked(menuOf(r.m)));
}

function sheet() {
  const db = pdb(), s = db.settings;
  const ex = st.ctx?.open_bill && st.table && !st.res;
  const ids = [...new Set(st.cart.map((c) => c.m))];
  const rec = recoList(ids);
  const f = st.form;
  const online = !!st.res;
  return `<div class="sheet-back" data-a="closeCart"></div><section class="sheet" role="dialog" aria-label="Pesanan kamu">
    <header class="sheet-h"><h2>Pesanan kamu</h2><button class="btn-icon" data-a="closeCart" aria-label="Tutup">${ic('x')}</button></header>
    <div class="sheet-b">
      ${st.cart.map((c, i) => { const m = menuOf(c.m); return `<div class="cl"><div><b>${esc(m?.name || '')}</b><input class="inp inp-sm" id="note-${i}" data-in="note" data-i="${i}" placeholder="Catatan (opsional)" value="${esc(c.note)}"></div><div class="cl-r"><span class="qty"><button data-a="dec" data-id="${c.m}" aria-label="Kurangi">${ic('minus', 15)}</button><b>${c.q}</b><button data-a="inc" data-id="${c.m}" aria-label="Tambah">${ic('plus', 15)}</button></span><b>${rp(c.q * (m?.price || 0))}</b></div></div>`; }).join('')}
      ${rec.length ? `<div class="reco-box"><h3>${ic('sprout', 16)} Sering dipesan bersama</h3><div class="hscroll">${rec.map((r) => { const m = menuOf(r.m); return `<button class="reco-card" data-a="inc" data-id="${m.id}"><b>${esc(m.name)}</b><span>${rp(m.price)}</span><small>${Math.round(Number(r.conf) * 100)}% pelanggan menambahkan ini</small></button>`; }).join('')}</div></div>` : ''}
      <h3 class="sec-t">Data pemesan</h3>
      <div class="grid2"><label class="fld"><span>Nama</span><input id="f-name" data-in="f" data-k="name" value="${esc(f.name)}" autocomplete="name"></label><label class="fld"><span>No. WhatsApp</span><input id="f-phone" data-in="f" data-k="phone" inputmode="tel" value="${esc(f.phone)}" autocomplete="tel" placeholder="08xx"></label></div>
      <label class="switch"><input type="checkbox" data-in="f" data-k="member" ${f.member ? 'checked' : ''}><span>Daftarkan saya sebagai member Kaly Loop (poin & promo ulang tahun)</span></label>
      ${st.res ? `<p class="mem-note">${ic('calendar-check', 16)} Pesanan untuk reservasi ${esc(st.res.code)}, ${fmtDate(new Date(st.res.date + 'T00:00:00').getTime())} pukul ${esc(st.res.time)}. Makanan disiapkan saat kamu datang.</p>` : ''}
      <label class="fld"><span>Kode voucher</span><input id="f-voucher" data-in="f" data-k="voucher" value="${esc(f.voucher)}" placeholder="Contoh: KALYBARU"></label>
      <h3 class="sec-t">Pembayaran</h3>
      ${online ? `<p class="muted sm">${ic('qr-code', 15)} Bayar dengan QRIS setelah pesanan dibuat. Pesanan masuk dapur setelah pembayaran dikonfirmasi.</p>` : ex ? `<p class="muted sm">Meja ini punya tagihan berjalan. Pesanan ditambahkan ke tagihan meja dan dibayar di kasir.</p>`
        : `<div class="seg"><button class="${f.pay === 'online' ? 'on' : ''}" data-a="pay" data-v="online">Bayar sekarang (QRIS)</button><button class="${f.pay === 'kasir' ? 'on' : ''}" data-a="pay" data-v="kasir">Bayar di kasir</button></div>`}
      <div id="sum">${summaryHtml()}</div>
    </div>
    <footer class="sheet-f"><button class="btn btn-brand btn-lg btn-block" data-a="submit">${(online || (f.pay === 'online' && !ex)) ? 'Pesan & bayar' : 'Kirim pesanan'}</button></footer>
  </section>`;
}

// Dibuka tanpa QR meja / kode reservasi: pesan hanya dari meja
function noTable(db) {
  const brand = db.settings.brand;
  return `<div class="shop" style="--brand:${esc(brand.color)};--accent:${esc(brand.accent)}">
    <header class="shop-h terrace"><div class="shop-brand">${logo('light')}<small>${esc(brand.tagline)}</small></div></header>
    <div class="shop-empty">${ic('qr-code', 40)}<h2>Pesan dari meja</h2><p>Pemesanan lewat HP hanya untuk tamu yang makan di tempat. Scan QR code di meja kamu, lalu pilih menu. Pesanan langsung masuk ke dapur dan diantar ke meja.</p>
      <p class="muted">Mau datang nanti? Buat reservasi, lalu pesan menu lebih dulu dari link di konfirmasi reservasi.</p>
      <div class="row center"><a class="btn btn-brand" href="#/book">${ic('calendar-check', 16)} Reservasi meja</a><a class="btn" href="#/member">${ic('award', 16)} Kartu member</a></div></div>
  </div>`;
}

function shop(ctx) {
  if (!C.configured) return `<div class="shop"><div class="shop-empty"><h2>Halaman pesan belum tersambung</h2><p>Hubungi kasir untuk memesan.</p></div></div>`;
  init(ctx);
  const db = pdb();
  if (!db || !st.ctx) return st.err ? `<div class="shop"><div class="shop-empty"><h2>Menu tidak bisa dimuat</h2><p>${esc(st.err)}</p><button class="btn btn-brand" data-a="retry">Coba lagi</button></div></div>` : `<div class="load-pane">${logo('olive')}<p>Memuat menu…</p></div>`;
  const brand = db.settings.brand;
  if (ctx.q.res && !st.res) return `<div class="shop"><div class="shop-empty"><h2>Kode reservasi tidak ditemukan</h2><p>Cek lagi kode di pesan konfirmasi, atau <a href="#/book">buat reservasi baru</a>.</p></div></div>`;
  if (ctx.q.meja && !st.table && !st.res) return `<div class="shop"><div class="shop-empty"><h2>Meja tidak ditemukan</h2><p>Scan ulang QR di meja kamu, atau tanyakan ke pramusaji.</p></div></div>`;
  if (!st.table && !st.res) return noTable(db);
  const ms = db.menus;
  const cats = db.cats.filter((c) => ms.some((m) => m.cat === c.id));
  const top = (st.ctx.top_now || []).map(menuOf).filter((m) => m && !blocked(m));
  const tb = st.table && (st.ctx.table || (st.res ? { id: st.res.table, area: st.res.area } : null));
  const items = st.cart.reduce((s, c) => s + c.q, 0);
  return `<div class="shop" style="--brand:${esc(brand.color)};--accent:${esc(brand.accent)}">
    <header class="shop-h terrace"><div class="shop-brand">${logo('light')}<small>${esc(brand.tagline)}</small></div>
      ${tb ? `<span class="shop-tag">${ic('armchair', 16)} Meja ${esc(tb.id)}${tb.area ? ', ' + esc(tb.area) : ''}</span>` : ''}${st.res ? `<span class="shop-tag">${ic('calendar-check', 16)} ${esc(st.res.code)}</span>` : ''}
    </header>
    ${top.length ? `<section class="shop-reco"><h2>Laris di jam segini</h2><div class="hscroll">${top.map((m) => `<button class="reco-card" data-a="inc" data-id="${m.id}"><b>${esc(m.name)}</b><span>${rp(m.price)}</span><small>${ic('plus', 13)} Tambah</small></button>`).join('')}</div></section>` : ''}
    <nav class="shop-cats"><div class="chips">${[['all', 'Semua'], ...cats.map((c) => [c.id, c.name])].map(([k, l]) => `<button class="chip ${st.cat === k ? 'on' : ''}" data-a="scat" data-v="${k}">${k === 'all' ? '' : `<i class="cdot cc-${D.catColor(db, k)}"></i>`}${esc(l)}</button>`).join('')}</div></nav>
    <main class="shop-list">${cats.filter((c) => st.cat === 'all' || st.cat === c.id).map((c) => `<section class="shop-grp cc-${D.catColor(db, c.id)}"><h3 class="shop-cat"><i class="cdot"></i>${esc(c.name)}<small>${ms.filter((m) => m.cat === c.id).length} menu</small></h3>${ms.filter((m) => m.cat === c.id).map(itemCard).join('')}</section>`).join('')}
      <p class="shop-foot">Harga belum termasuk PB1 ${Math.round(db.settings.taxRate * 100)}%. <a href="#/member">Cek poin member</a></p></main>
    ${items ? `<button class="cart-bar" data-a="openCart"><span>${items} item</span><b>${rp(st.quote ? Number(st.quote.bill.total) : localTotal())}</b><span>Lihat pesanan ${ic('chevron-right', 16)}</span></button>` : ''}
    ${st.sheet && items ? sheet() : ''}
  </div>`;
}

// ---------- Lacak pesanan ----------
let tr = { token: null, data: null, err: null, timer: null };
async function loadTrack(token) {
  try { tr.data = await C.rpc('public_track', { p_token: token }); tr.err = tr.data ? null : 'notfound'; }
  catch (e) { tr.err = e.message; }
  rerender();
}
function track(ctx) {
  const token = ctx.q.t;
  if (!token) return `<div class="shop"><div class="shop-empty"><h2>Pesanan tidak ditemukan</h2><p>Scan QR di meja untuk memesan.</p></div></div>`;
  if (tr.token !== token) { tr = { token, data: null, err: null, timer: tr.timer }; loadTrack(token); }
  const o = tr.data;
  if (!o) return tr.err ? `<div class="shop"><div class="shop-empty"><h2>Pesanan tidak ditemukan</h2><p>Cek lagi link pesananmu, atau scan QR di meja untuk memesan.</p></div></div>` : `<div class="load-pane">${logo('olive')}<p>Memuat pesanan…</p></div>`;
  const db = pdb(), brand = db?.settings.brand || { color: '#475331', accent: '#CC5E44' };
  const ks = o.kitchen_state;
  const done = ks === 'served' || o.delivery_status === 'selesai';
  const steps = [['Pesanan diterima', true], ['Sedang dimasak', ['cook', 'ready', 'served'].includes(ks)], ['Siap', ['ready', 'served'].includes(ks)], [o.type === 'deliv' ? 'Diantar' : o.type === 'dine' ? 'Diantar ke meja' : 'Diambil', done]];
  const sched = o.scheduled_at && Date.parse(o.scheduled_at);
  const lead = db?.settings.scheduleLead || 30;
  const msg = o.payment_pending ? 'Menunggu pembayaran. Pesanan masuk dapur setelah pembayaran dikonfirmasi kasir.'
    : o.status === 'void' ? 'Pesanan ini dibatalkan. Hubungi kasir bila ada pertanyaan.'
    : !o.released && sched ? `Dijadwalkan ${fmtDT(sched)}. Dapur mulai menyiapkan ${lead} menit sebelumnya.`
    : ks === 'ready' ? (o.type === 'dine' ? 'Pesanan siap dan sedang diantar ke meja.' : o.type === 'deliv' ? 'Pesanan siap, menunggu kurir.' : 'Pesanan siap. Tunjukkan nomor ini di kasir.')
    : done ? 'Selamat menikmati!' : ks === 'none' ? 'Pesanan sudah diterima kasir.' : 'Pesanan sedang disiapkan dapur.';
  const qris = o.qris_image ? C.imageUrl(o.qris_image) : null;
  return `<div class="shop" style="--brand:${esc(brand.color)};--accent:${esc(brand.accent)}">
    <header class="shop-h terrace"><div class="shop-brand">${logo('light')}<small>Lacak pesanan</small></div></header>
    <main class="track">
      <div class="track-no"><small>Nomor pesanan</small><b>${esc(o.no)}</b><span>${o.table ? 'Meja ' + esc(o.table) : esc(TYPE_LABEL[o.type] || '')}</span></div>
      <p class="track-msg">${esc(msg)}</p>
      ${o.payment_pending ? `<div class="card"><div class="qris-box big">${qris ? `<img src="${qris}" alt="QRIS ${esc(brand.name || 'toko')}" style="max-width:260px;width:100%">` : ''}<b>${rp(o.total)}</b><p>${qris ? 'Scan QRIS ini dengan aplikasi bank atau e-wallet, bayar sesuai total, lalu tunjukkan bukti bayar ke kasir.' : 'Bayar ke kasir atau lewat QRIS di meja kasir, lalu sebutkan nomor pesanan ini.'}</p></div></div>` : ''}
      <ol class="track-steps">${steps.map(([l, ok]) => `<li class="${ok && !o.payment_pending ? 'ok' : ''}"><i>${ok && !o.payment_pending ? ic('check', 14) : ''}</i>${esc(l)}</li>`).join('')}</ol>
      ${o.type === 'deliv' ? `<p class="muted">Status kurir: <b>${esc(o.delivery_status || 'menunggu')}</b>. Alamat: ${esc(o.addr || '')}</p>` : ''}
      <div class="card"><ul class="list">${(o.lines || []).map((l) => `<li><span>${num(l.qty)}× ${esc(l.name)}${l.note ? `<small>${esc(l.note)}</small>` : ''}</span></li>`).join('')}</ul>
        <dl class="bill-tot"><dt class="grand">Total</dt><dd class="grand">${rp(o.total)}</dd></dl><p class="muted sm">${o.status === 'paid' ? 'Sudah dibayar.' : o.payment_pending ? 'Belum dibayar.' : 'Bayar di kasir.'}</p></div>
      <p class="muted sm">Halaman ini diperbarui otomatis. Simpan link ini untuk mengecek pesanan.</p>
      ${o.table ? `<a class="btn btn-block" href="#/order?meja=${esc(o.table)}">Pesan lagi</a>` : ''}
    </main></div>`;
}

function validate() {
  const db = pdb(), s = db.settings, f = st.form;
  for (const c of st.cart) {
    const m = menuOf(c.m);
    if (blocked(m)) return `${m?.name || 'Menu'} baru saja habis. Hapus dari pesanan dulu.`;
    if (m.left != null && cartQty(c.m) > m.left) return `${m.name} tinggal ${m.left} porsi. Kurangi jumlahnya dulu.`;
  }
  if (!f.name.trim()) return 'Isi nama pemesan';
  const ph = norm(f.phone);
  if (f.member && ph.length < 9) return 'Isi nomor WhatsApp yang valid';
  return null;
}
async function place(btn) {
  const f = st.form;
  const p = {
    mode: 'meja', table: st.table, reservation: st.res?.code || '',
    items: st.cart.map((c) => ({ menu: c.m, qty: c.q, note: c.note || '' })),
    name: f.name.trim(), phone: f.phone, member: !!f.member,
    voucher: f.voucher.trim().toUpperCase(), pay: st.res ? 'online' : f.pay,
  };
  btn.disabled = true; btn.textContent = 'Mengirim…';
  let r;
  try { r = await C.rpc('public_place_order', { p }); }
  catch (e) { btn.disabled = false; btn.textContent = 'Coba kirim lagi'; return toast(e.message, 'err', 6000); }
  try { localStorage.setItem('kaly.cust', JSON.stringify({ name: f.name, phone: f.phone })); } catch {}
  st = null;
  toast(r.added_to_open_bill ? `Pesanan ditambahkan ke tagihan meja (${r.no})` : `Pesanan ${r.no} dibuat`);
  location.hash = '#/track?t=' + r.token;
}

export default {
  render(ctx) { return ctx.track ? track(ctx) : shop(ctx); },
  refresh(root, ctx) {
    if (ctx.track) { root.innerHTML = track(ctx); return; }
    if (st?.sheet) { paintSummary(); return; }
    root.innerHTML = shop(ctx);
  },
  after(root, ctx) {
    clearInterval(tr.timer);
    if (ctx.track && ctx.q.t) tr.timer = setInterval(() => { if (!document.hidden) loadTrack(ctx.q.t); }, 5000);
  },
  unmount() { clearInterval(tr.timer); tr.timer = null; },
  input(k, el) {
    if (k === 'note') { st.cart[+el.dataset.i].note = el.value; return; }
    if (k === 'f') {
      st.form[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value;
      if (['phone', 'voucher', 'member'].includes(el.dataset.k)) { if (el.dataset.k === 'member') paintSummary(); else quoteSoon(); }
    }
  },
  actions: {
    retry(el, e, ctx) { st = null; rerender(); },
    inc(el) {
      const id = el.dataset.id, m = menuOf(id);
      if (blocked(m)) return toast(`${m?.name || 'Menu'} sedang habis`, 'warn');
      if (m.left != null && cartQty(id) + 1 > m.left) return toast(`${m.name} tinggal ${m.left} porsi`, 'warn');
      const c = st.cart.find((x) => x.m === id && !x.note); if (c) c.q++; else st.cart.push({ m: id, q: 1, note: '' });
      quoteSoon(); rerender();
    },
    dec(el) { const i = st.cart.map((x) => x.m).lastIndexOf(el.dataset.id); if (i < 0) return; st.cart[i].q--; if (st.cart[i].q <= 0) st.cart.splice(i, 1); if (!st.cart.length) { st.sheet = false; st.quote = null; } quoteSoon(); rerender(); },
    scat(el) { st.cat = el.dataset.v; rerender(); },
    openCart() { st.sheet = true; quoteSoon(); rerender(); },
    closeCart() { st.sheet = false; rerender(); },
    pay(el) { st.form.pay = el.dataset.v; rerender(); },
    submit(el) {
      const err = validate();
      if (err) return toast(err, 'warn');
      place(el);
    },
  },
};
