// Layar pelanggan (customer display) — mengikuti keranjang di kasir
import { readDisplay } from '../store.js';
import { esc, ic, rp, num, qrSvg, logo } from '../lib.js';
import * as D from '../domain.js';
import { imgUrl, menuPic } from '../media.js';
import * as C from '../cloud.js';
import { rerender } from '../app.js';

let asked = false;
// Layar pelanggan memakai data publik (merek, foto menu, menu terlaris)
function pdb() {
  if (!C.pub.db || !C.pub.db.top) { if (!asked) { asked = true; C.loadPublic('L1', { lounge: true }).then(() => rerender()).catch(() => { asked = false; }); } return C.pub.db || C.db; }
  return C.pub.db;
}

let t = null, slide = 0;

export default {
  render(ctx) {
    const db = pdb(), term = ctx.q.t;
    let s = readDisplay();
    if (!s || (term && s.term !== term) || Date.now() - s.at > 30 * 60000) s = { status: 'idle' };
    const brand = db.settings.brand;
    if (s.status === 'idle') {
      const promos = [...db.menus.filter((m) => m.active && (m.tags?.includes('new') || m.pkg)).map((m) => ({ t: m.name, d: m.desc, p: rp(m.price), img: imgUrl(m) })), ...(db.top || []).slice(0, 4).map((m) => { const x = D.menu(db, m); if (!x) return null; return { t: x.name, d: x.desc || 'Favorit minggu ini', p: rp(x.price), img: imgUrl(x) }; }), ...db.promos.filter((p) => D.promoActive(p)).map((p) => ({ t: p.name, d: 'Berlaku sekarang', p: '' }))].filter(Boolean);
      const x = promos[slide % Math.max(1, promos.length)] || { t: brand.tagline, d: '', p: '' };
      return `<div class="cd idle terrace"><div class="cd-brand">${logo('light')}<p>${esc(brand.tagline)}</p></div>
        <div class="cd-promo ${x.img ? 'has-img' : ''}">${x.img ? `<img src="${x.img}" alt="">` : ''}<div><small>Coba juga</small><h2>${esc(x.t)}</h2>${x.d ? `<p>${esc(x.d)}</p>` : ''}${x.p ? `<b>${x.p}</b>` : ''}</div></div>
        <p class="cd-foot">Selamat datang. Kasir akan menampilkan pesanan Anda di sini.</p></div>`;
    }
    if (s.status === 'thanks') {
      return `<div class="cd thanks terrace"><div>${ic('circle-check', 64)}<h1>Terima kasih!</h1><p>Pesanan ${esc(s.no)} sudah dibayar: <b>${rp(s.bill?.total)}</b></p>${s.change ? `<p class="cd-big">Kembalian ${rp(s.change)}</p>` : ''}${s.earned ? `<p>Anda dapat <b>${num(s.earned)} poin</b> Kaly Loop</p>` : ''}<p class="muted">Selamat menikmati makanan dan suasana sawahnya.</p></div></div>`;
    }
    const b = s.bill || { sub: 0, discs: [], tax: 0, total: 0 };
    return `<div class="cd cart">
      <section class="cd-list"><header>${logo('olive')}<span class="muted">Pesanan ${esc(s.no || '')}</span></header>
        <div class="cd-lines">${(s.lines || []).map((l) => `<div class="cd-l">${menuPic(D.menu(db, l.m), 'sm', 'cd-pic')}<span>${l.q}×</span><span>${esc(l.n)}</span><b>${rp(l.a)}</b></div>`).join('')}</div>
        ${s.member ? `<div class="cd-mem">${ic('award', 20)} ${esc(s.member.name)}, member ${esc(s.member.tier)}. ${num(s.member.points)} poin</div>` : `<div class="cd-mem muted">${ic('award', 20)} Belum member? Sebutkan nomor HP ke kasir untuk dapat poin.</div>`}
      </section>
      <section class="cd-tot">
        <dl><dt>Subtotal</dt><dd>${rp(b.sub)}</dd>${b.discs.map((d) => `<dt>${esc(d.label)}</dt><dd>-${rp(d.amt)}</dd>`).join('')}<dt>PB1</dt><dd>${rp(b.tax)}</dd>${b.deliv ? `<dt>Ongkir</dt><dd>${rp(b.deliv)}</dd>` : ''}</dl>
        <div class="cd-grand"><small>Total</small><b>${rp(b.total)}</b></div>
        ${s.status === 'pay' && s.qris && /^https?:/.test(s.qris) ? `<div class="cd-qr"><img src="${esc(s.qris)}" alt="QRIS"><p>Scan QRIS untuk membayar</p></div>` : ''}
      </section></div>`;
  },
  after(root, ctx) {
    clearInterval(t);
    t = setInterval(() => { slide++; const s = readDisplay(); if (!s || s.status === 'idle') root.innerHTML = this.render(ctx); }, 7000);
  },
  unmount() { clearInterval(t); },
};
