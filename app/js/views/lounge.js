// Kaly Lounge — layar antrean pelanggan dengan notifikasi suara
import { esc, ic, rp, startOfDay, fmtTime, chime, speak, spellNo, logo } from '../lib.js';
import * as D from '../domain.js';
import { imgUrl } from '../media.js';
import * as C from '../cloud.js';
import { rerender } from '../app.js';

let announced = null, soundOn = false, timer = null, poll = null, slide = 0, flash = new Set(), loc0 = null;
const ksOf = (o) => o.ks ?? D.kitchenState(o);
// Layar antrean memakai data publik (tanpa login): nomor pesanan & menu terlaris
function pdb(L) {
  if (!C.pub.db || C.pub.loc !== L || !C.pub.db.top) { if (loc0 !== L) { loc0 = L; C.loadPublic(L, { lounge: true }).then(() => rerender()).catch(() => {}); } return null; }
  return C.pub.db;
}

function lists(db, L) {
  const t0 = startOfDay() - 6 * 3600000, now = Date.now();
  const os = db.orders.filter((o) => o.loc === L && o.status !== 'void' && o.created >= t0 && o.released !== false);
  const prep = os.filter((o) => ['new', 'cook'].includes(ksOf(o))).sort((a, b) => a.created - b.created);
  const ready = os.filter((o) => ksOf(o) === 'ready' && now - (o.readyAt || now) < 20 * 60000).sort((a, b) => (b.readyAt || 0) - (a.readyAt || 0));
  return { prep, ready };
}
function slides(db) {
  const out = [];
  db.menus.filter((m) => m.active && m.tags?.includes('new')).forEach((m) => out.push({ k: 'Menu baru', t: m.name, d: m.desc, p: rp(m.price), img: imgUrl(m) }));
  db.promos.filter((p) => D.promoActive(p)).forEach((p) => out.push({ k: 'Promo berlaku sekarang', t: p.name, d: p.from && p.to ? `Berlaku pukul ${p.from} sampai ${p.to}` : 'Tanyakan ke kasir', p: '' }));
  db.menus.filter((m) => m.active && m.pkg).forEach((m) => out.push({ k: 'Paket hemat', t: m.name, d: m.desc, p: rp(m.price), img: imgUrl(m) }));
  (db.top || D.topSellers(db, 7, 4, 'L1').map((x) => x.m)).slice(0, 4).forEach((m) => { const x = D.menu(db, m); if (!x) return; out.push({ k: 'Favorit minggu ini', t: x.name, d: x.desc || db.cats.find((c) => c.id === x.cat)?.name, p: rp(x.price), img: imgUrl(x) }); });
  out.push({ k: 'Kaly Loop', t: 'Daftar member, dapat poin tiap kunjungan', d: 'Tanya kasir atau scan QR di meja. Bonus poin untuk pendaftar baru.', p: '' });
  return out;
}
const num = (o) => `<div class="lq ${flash.has(o.id) ? 'flash' : ''}"><b>${esc(o.no)}</b><small>${o.table ? 'Meja ' + esc(o.table) : esc(o.cust?.name || D.TYPE_LABEL[o.type])}</small></div>`;
function cols(db, L) {
  const { prep, ready } = lists(db, L);
  return `<section class="lcol"><h2>${ic('flame', 26)} Sedang disiapkan</h2><div class="lgrid">${prep.map(num).join('') || '<p class="lempty">Belum ada pesanan</p>'}</div></section>
    <section class="lcol ready"><h2>${ic('concierge-bell', 26)} Siap diambil</h2><div class="lgrid">${ready.map(num).join('') || '<p class="lempty">Nomor yang siap muncul di sini</p>'}</div></section>`;
}
function slideHtml(db) {
  const s = slides(db);
  const x = s[slide % s.length];
  return `${x.img ? `<img class="ls-img" src="${x.img}" alt="">` : ''}<div class="ls"><span class="ls-k">${esc(x.k)}</span><h3>${esc(x.t)}</h3>${x.d ? `<p>${esc(x.d)}</p>` : ''}${x.p ? `<b class="ls-p">${x.p}</b>` : ''}<div class="ls-dots">${s.map((_, i) => `<i class="${i === slide % s.length ? 'on' : ''}"></i>`).join('')}</div></div>`;
}
function announce(db, L) {
  const { ready } = lists(db, L);
  if (!announced) { announced = new Set(ready.map((o) => o.id)); return; }
  const fresh = ready.filter((o) => !announced.has(o.id));
  fresh.forEach((o) => announced.add(o.id));
  if (!fresh.length) return;
  fresh.forEach((o) => flash.add(o.id));
  setTimeout(() => { fresh.forEach((o) => flash.delete(o.id)); }, 8000);
  if (soundOn) {
    chime();
    const call = fresh.filter((o) => !o.table);
    setTimeout(() => call.forEach((o) => speak(`Nomor antrean ${spellNo(o.no)}${o.cust?.name ? ', atas nama ' + o.cust.name : ''}. Pesanan Anda sudah siap. Silakan ambil di kasir.`)), 900);
  }
}

export default {
  render(ctx) {
    const L = ctx.q.loc || 'L1', db = pdb(L);
    if (!C.configured) return `<div class="lounge dark"><p class="lempty">Layar antrean belum tersambung ke database.</p></div>`;
    if (!db) return `<div class="lounge dark"><header class="lh"><div class="lbrand">${logo('light')}</div></header><p class="lempty">Memuat antrean…</p></div>`;
    announce(db, L);
    return `<div class="lounge dark">
      <header class="lh"><div class="lbrand">${logo('light')}<span>${esc(D.loc(db, L)?.name || '')}</span></div><span class="lclock" id="lclock">${fmtTime(Date.now())}</span></header>
      <div class="lbody"><div class="lcols" id="lounge-cols">${cols(db, L)}</div><aside class="lpromo" id="lounge-promo">${slideHtml(db)}</aside></div>
      ${soundOn ? '' : `<button class="lsound" data-a="sound">${ic('volume-2', 22)} Ketuk untuk mengaktifkan suara panggilan</button>`}
    </div>`;
  },
  refresh(root, ctx) {
    const L = ctx.q.loc || 'L1', db = pdb(L);
    if (!db) return;
    announce(db, L);
    const c = root.querySelector('#lounge-cols');
    if (c) c.innerHTML = cols(db, L); else root.innerHTML = this.render(ctx);
  },
  after(root, ctx) {
    const L = ctx.q.loc || 'L1';
    clearInterval(timer); clearInterval(poll);
    timer = setInterval(() => {
      const db = pdb(L); if (!db) return;
      slide++;
      const p = document.getElementById('lounge-promo');
      if (p) p.innerHTML = slideHtml(db);
      const c = document.getElementById('lclock'); if (c) c.textContent = fmtTime(Date.now());
      const cc = document.getElementById('lounge-cols'); if (cc && flash.size === 0) cc.innerHTML = cols(db, L);
    }, 8000);
    // Ambil antrean terbaru tiap 4 detik
    poll = setInterval(() => { C.loadPublic(L, { lounge: true }).then(() => { if (document.getElementById('lounge-cols')) this.refresh(root, ctx); else rerender(); }).catch(() => {}); }, 4000);
  },
  unmount() { clearInterval(timer); clearInterval(poll); announced = null; loc0 = null; },
  actions: {
    sound(el) { soundOn = true; chime(); speak('Suara panggilan antrean aktif'); el.remove(); },
  },
};
