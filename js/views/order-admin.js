// Kaly Order (admin) — pesanan QR meja & pre-order reservasi, QR meja, rekomendasi menu, pengaturan
import { getDb } from '../store.js';
import * as API from '../api.js';
import * as C from '../cloud.js';
import { confirmBox } from '../lib.js';
import { esc, ic, rp, num, pct, toast, qrSvg, copyText, startOfDay, fmtTime, fmtDT, DAY, sum, formData } from '../lib.js';
import * as D from '../domain.js';
import { rerender } from '../app.js';
import { doPrint } from './pos.js';
import { pickImage, saveQrisImage, removeMenuImage, qrisUrl } from '../media.js';

const ui = { tab: 'orders', f: 'all' };
const base = () => location.href.split('#')[0];

function orders(ctx) {
  const db = ctx.db, t0 = startOfDay();
  let os = db.orders.filter((o) => o.ch !== 'pos' && o.status !== 'void' && (o.created >= t0 || (o.sched && o.sched >= t0)));
  if (ui.f === 'qr') os = os.filter((o) => o.ch === 'qr');
  if (ui.f === 'pre') os = os.filter((o) => o.ch === 'web');
  os.sort((a, b) => (b.sched || b.created) - (a.sched || a.created));
  const ks = { none: '—', new: 'Antre', cook: 'Dimasak', ready: 'Siap', served: 'Selesai' };
  return `<div class="chips">${[['all', 'Semua'], ['qr', 'QR meja'], ['pre', 'Pre-order reservasi']].map(([k, l]) => `<button class="chip ${ui.f === k ? 'on' : ''}" data-a="of" data-v="${k}">${l}</button>`).join('')}</div>
    <div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>No.</th><th>Masuk</th><th>Channel</th><th>Untuk</th><th>Pelanggan</th><th class="r">Total</th><th>Bayar</th><th>Dapur</th><th></th></tr></thead><tbody>
    ${os.map((o) => { const b = D.bill(db, o); const k = o.released === false ? 'sched' : D.kitchenState(o); return `<tr><td><b>${esc(o.no)}</b></td><td>${fmtTime(o.created)}</td><td>${D.CH_LABEL[o.ch]}</td>
      <td>${o.table ? 'Meja ' + esc(o.table) : esc(D.TYPE_LABEL[o.type])}${o.sched ? `<br><span class="badge b-gold">${fmtDT(o.sched)}</span>` : ''}</td>
      <td>${esc(o.cust?.name || '—')}${o.cust?.phone ? `<br><a class="lnk sm" href="https://wa.me/${D.waPhone(o.cust.phone)}" target="_blank" rel="noopener">${esc(o.cust.phone)}</a>` : ''}</td><td class="r">${rp(b.total)}</td>
      <td>${o.status === 'paid' ? '<span class="badge b-ok">Lunas online</span>' : o.payPending ? `<span class="badge b-warn">Menunggu bayar online</span>${['owner', 'kasir'].includes(ctx.user.role) ? `<br><button class="lnk sm" data-a="confirmPay" data-id="${o.id}">Sudah dibayar?</button>` : ''}` : '<span class="badge b-warn">Di kasir</span>'}</td>
      <td>${k === 'sched' ? `<span class="badge b-gold">Masuk ${fmtTime(o.sched - db.settings.scheduleLead * 60000)}</span>` : `<span class="badge ${k === 'ready' ? 'b-ok' : k === 'cook' ? 'b-warn' : 'b-mute'}">${ks[k]}</span>`}</td>
      <td>${o.released === false ? `<button class="btn btn-sm" data-a="release" data-id="${o.id}">Kirim ke dapur</button>` : ''}</td></tr>`; }).join('') || '<tr><td colspan="9" class="empty">Belum ada pesanan QR meja atau pre-order hari ini.</td></tr>'}
    </tbody></table></div></div>
    <p class="hint">Pelanggan hanya bisa memesan dari HP lewat QR di meja atau pre-order reservasi (takeaway dan delivery tidak dipakai). Pre-order reservasi menunggu pembayaran online sebelum masuk dapur. Setelah mengecek mutasi QRIS atau transfer, tekan <b>Sudah dibayar?</b> untuk melunasi dan mengirimnya ke dapur. Untuk status bayar otomatis, sambungkan payment gateway (Midtrans atau Xendit).</p>`;
}
function qrs(ctx) {
  const db = ctx.db;
  const links = [['Reservasi meja', '#/book'], ['Kartu member', '#/member']];
  return `<div class="row sb wrap"><p class="muted">Tempel QR di tiap meja. Pelanggan scan, pilih menu, lalu pesanan langsung masuk ke dapur dan tagihan meja di kasir.</p><button class="btn btn-pri" data-a="printQr">${ic('printer', 16)} Cetak semua QR meja</button></div>
    <div class="qr-grid">${db.tables.map((t) => `<div class="qr-card">${qrSvg(base() + '#/order?meja=' + t.id, 3)}<b>Meja ${esc(t.id)}</b><small>${esc(t.area)}</small><div class="row-xs"><a class="lnk sm" href="#/order?meja=${t.id}" target="_blank" rel="noopener">Buka</a><button class="lnk sm" data-a="copyLink" data-v="#/order?meja=${t.id}">Salin link</button></div></div>`).join('')}</div>
    <h3 class="sec-t">Link untuk Instagram, WhatsApp, dan Google Maps</h3>
    <div class="qr-grid">${links.map(([l, h]) => `<div class="qr-card wide">${qrSvg(base() + h, 3)}<b>${esc(l)}</b><div class="row-xs"><a class="lnk sm" href="${h}" target="_blank" rel="noopener">Buka</a><button class="lnk sm" data-a="copyLink" data-v="${h}">Salin link</button></div></div>`).join('')}</div>`;
}
function reco(ctx) {
  const db = ctx.db, since = Date.now() - 30 * DAY;
  const os = db.orders.filter((o) => o.status === 'paid' && o.created >= since);
  const sets = os.map((o) => new Set(o.lines.filter((l) => !l.par && l.s !== 'void').map((l) => l.m)));
  const N = sets.length;
  const supp = {}; sets.forEach((s) => s.forEach((m) => { supp[m] = (supp[m] || 0) + 1; }));
  const pairs = {};
  sets.forEach((s) => { const a = [...s]; for (let i = 0; i < a.length; i++) for (let j = 0; j < a.length; j++) if (i !== j) { const k = a[i] + '>' + a[j]; pairs[k] = (pairs[k] || 0) + 1; } });
  const rules = Object.entries(pairs).map(([k, c]) => { const [a, b] = k.split('>'); return { a, b, c, conf: c / supp[a], lift: (c / supp[a]) / (supp[b] / N) }; })
    .filter((r) => r.c >= 15 && r.lift > 1.15 && !D.menu(db, r.a)?.pkg && !D.menu(db, r.b)?.pkg).sort((x, y) => y.lift - x.lift).slice(0, 10);
  const parts = [['Pagi', 9, 11], ['Siang', 11, 14], ['Sore', 14, 17], ['Malam', 17, 21]];
  const daypart = parts.map(([n, a, b]) => { const c = {}; os.filter((o) => { const h = new Date(o.created).getHours(); return h >= a && h < b; }).forEach((o) => o.lines.filter((l) => !l.par && l.s !== 'void' && !D.menu(db, l.m)?.pkg).forEach((l) => { c[l.m] = (c[l.m] || 0) + l.q; })); return [n, Object.entries(c).sort((x, y) => y[1] - x[1]).slice(0, 4)]; });
  const name = (id) => esc(D.menu(db, id)?.name || id);
  return `<p class="muted">Rekomendasi di halaman pesan dan kasir dihitung dari ${num(N)} transaksi 30 hari terakhir: menu yang sering dibeli bersamaan, dan menu terlaris di jam yang sama. Semakin banyak transaksi, semakin tajam sarannya.</p>
    <div class="grid-side"><div class="card"><div class="card-h"><h3>Pasangan menu terkuat</h3><span class="muted sm">kandidat upsell & paket baru</span></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Jika pesan</th><th>Sering tambah</th><th class="r">Transaksi</th><th class="r">Peluang</th><th class="r">Lift</th></tr></thead><tbody>${rules.map((r) => `<tr><td>${name(r.a)}</td><td><b>${name(r.b)}</b></td><td class="r">${r.c}</td><td class="r">${pct(r.conf)}</td><td class="r">${num(r.lift, 2)}×</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Data belum cukup.</td></tr>'}</tbody></table></div>
      <p class="hint">Lift di atas 1 berarti kombinasi ini lebih sering terjadi dibanding kebetulan. Pasangan dengan lift tinggi cocok dijadikan paket atau saran "sering dipesan bersama".</p></div>
    <aside><div class="card"><div class="card-h"><h3>Terlaris per waktu</h3></div>${daypart.map(([n, xs]) => `<h4 class="sec-t">${n}</h4><ul class="list">${xs.map(([m, q]) => `<li><span>${name(m)}</span><span class="muted">${num(q)} porsi</span></li>`).join('')}</ul>`).join('')}</div></aside></div>`;
}
function settings(ctx) {
  const s = ctx.db.settings;
  return `<form class="card form-narrow" data-submit="saveSet">
    <label class="switch"><input type="checkbox" name="qrAutoSend" ${s.qrAutoSend ? 'checked' : ''}><span>Pesanan QR meja langsung masuk ke dapur</span></label>
    <label class="fld"><span>Pre-order reservasi masuk dapur (menit sebelum jam reservasi)</span><input name="scheduleLead" type="number" value="${s.scheduleLead}"></label>
    <button class="btn btn-pri">Simpan pengaturan</button></form>
    <div class="card form-narrow"><div class="card-h"><h3>QRIS toko</h3></div>
      <p class="muted sm">Unggah gambar QRIS statis dari bank atau penyedia e-wallet Anda. Gambar ini tampil di jendela bayar kasir, layar pelanggan, dan halaman lacak pesanan online, supaya pelanggan bisa scan dan membayar.</p>
      ${qrisUrl(s) ? `<img class="qris-prev" src="${qrisUrl(s)}" alt="QRIS toko">` : '<p class="empty">Belum ada gambar QRIS.</p>'}
      ${ctx.user.role === 'owner' ? `<div class="row"><button class="btn" data-a="qrisUp">${ic('upload', 16)} ${s.qrisImage ? 'Ganti gambar' : 'Unggah gambar QRIS'}</button>${s.qrisImage ? `<button class="btn btn-ghost" data-a="qrisDel">Hapus</button>` : ''}</div>` : '<p class="hint">Hanya Owner yang bisa mengganti gambar QRIS.</p>'}
      <p class="hint">QRIS statis tidak mengirim status bayar otomatis. Kasir tetap mengecek notifikasi dana masuk sebelum menekan Bayar atau <b>Sudah dibayar?</b>.</p></div>`;
}

export default {
  render(ctx) {
    const tabs = [['orders', 'Pesanan QR & pre-order'], ['qr', 'QR meja & link'], ['reco', 'Rekomendasi menu'], ['set', 'Pengaturan']];
    const body = ui.tab === 'orders' ? orders(ctx) : ui.tab === 'qr' ? qrs(ctx) : ui.tab === 'reco' ? reco(ctx) : settings(ctx);
    return `<div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${ui.tab === k ? 'on' : ''}" data-a="tab" data-v="${k}">${l}</button>`).join('')}</div><div class="tabbody">${body}</div>`;
  },
  actions: {
    tab(el) { ui.tab = el.dataset.v; rerender(); },
    of(el) { ui.f = el.dataset.v; rerender(); },
    async release(el) { const id = el.dataset.id; await API.orderOp(id, () => API.releaseOrder(id)); await C.refreshOrder(id); toast('Pesanan dikirim ke dapur'); rerender(); },
    async confirmPay(el) {
      const o = D.order(getDb(), el.dataset.id); if (!o) return;
      const total = D.bill(getDb(), o).total;
      if (!(await confirmBox('Konfirmasi pembayaran online', `Pastikan dana <b>${rp(total)}</b> untuk pesanan ${esc(o.no)} atas nama ${esc(o.cust?.name || '')} sudah masuk di mutasi QRIS atau rekening.`, 'Sudah masuk, lunaskan'))) return;
      const r = await API.orderOp(o.id, () => C.rpc('confirm_online_payment', { p_order: o.id, p_amount: total }));
      if (r && r.ok === false) return toast(r.msg, 'err');
      await Promise.all([C.refreshOrder(o.id), C.refresh('members', 'stock', 'loyalty')]);
      toast(`${o.no} lunas dan dikirim ke dapur`); rerender();
    },
    async qrisUp(el, e, ctx) {
      const file = await pickImage(); if (!file) return;
      el.disabled = true;
      try {
        const old = ctx.db.settings.qrisImage;
        const path = await saveQrisImage(file);
        await API.saveSettings({ qrisImage: path }); await C.refresh('settings');
        if (old) removeMenuImage(old);
        toast('Gambar QRIS disimpan'); rerender();
      } catch (err) { toast(err.message, 'err', 6000); el.disabled = false; }
    },
    async qrisDel(el, e, ctx) {
      if (!(await confirmBox('Hapus gambar QRIS', 'Jendela bayar dan halaman pesan online tidak akan menampilkan QRIS lagi.', 'Hapus'))) return;
      const old = ctx.db.settings.qrisImage;
      await API.saveSettings({ qrisImage: '' }); await C.refresh('settings');
      removeMenuImage(old); toast('Gambar QRIS dihapus'); rerender();
    },
    copyLink(el) { copyText(base() + el.dataset.v); },
    printQr(el, e, ctx) { doPrint(`<div class="qr-print">${ctx.db.tables.map((t) => `<div class="qp">${qrSvg(base() + '#/order?meja=' + t.id, 4)}<b>Meja ${esc(t.id)}</b><span>Scan untuk pesan & bayar</span><img class="qp-logo" src="assets/kaly-logo-olive.svg" alt="kaly"></div>`).join('')}</div>`); },
    async saveSet(form) {
      const f = formData(form);
      const patch = { qrAutoSend: !!f.qrAutoSend, scheduleLead: Number(f.scheduleLead) || 0 };
      await API.saveSettings(patch); await C.refresh('settings');
      toast('Pengaturan Kaly Order disimpan');
    },
  },
};
