// 2.22 · Invoice (Kaly Backoffice, Owner & Kasir): dokumen tagihan yang bisa diberikan ke tamu.
// Tiga sumbernya: bill pending yang perlu ditagih, reservasi ber-DP yang menyisakan pelunasan,
// dan tagihan manual untuk tamu korporat atau acara.
//
// Invoice adalah lapisan dokumen di atas pembukuan, bukan penggantinya. Uang tetap dicatat lewat
// kasir atau pelunasan piutang; invoice dari bill bahkan menolak ditandai lunas selama piutangnya
// masih terbuka, dan ikut lunas sendiri begitu piutang itu dilunasi lewat jalur resmi.
import * as C from '../cloud.js';
import * as API from '../api.js';
import * as D from '../domain.js';
import { esc, ic, rp, num, toast, fmtDate, dayKey, openModal, formData, confirmBox, copyText, askReason, DAY } from '../lib.js';
import { rerender } from '../app.js';

const ui = { tab: 'open', q: '' };
// Outlet penjualan yang datanya ikut termuat (gudang tidak menerbitkan invoice).
const locIds = (db) => db.locations.filter((l) => l.type !== 'gudang').map((l) => l.id);

const STATUS = {
  terbit: ['Belum lunas', 'b-warn'],
  lunas: ['Lunas', 'b-ok'],
  batal: ['Batal', 'b-mute'],
};
const KIND = { order: 'Dari bill', reservation: 'Dari reservasi', manual: 'Manual' };

const sisa = (v) => Math.max(0, v.total - v.paid);
const overdue = (v) => v.status === 'terbit' && v.dueOn && v.dueOn < dayKey();
export const invoiceUrl = (v) => `${location.origin}${location.pathname}#/tagihan?t=${v.token}`;

function rows(db) {
  const locs = locIds(db);
  let list = (db.invoices || []).filter((v) => locs.includes(v.loc));
  if (ui.tab === 'open') list = list.filter((v) => v.status === 'terbit');
  else if (ui.tab === 'over') list = list.filter(overdue);
  else if (ui.tab === 'paid') list = list.filter((v) => v.status === 'lunas');
  else if (ui.tab === 'void') list = list.filter((v) => v.status === 'batal');
  const q = ui.q.trim().toLowerCase();
  if (q) list = list.filter((v) => [v.no, v.billTo.name, v.billTo.company, v.note].join(' ').toLowerCase().includes(q));
  return list;
}

// ---------- Tampilan ----------
export default {
  title: () => 'Invoice',
  // 2.23 · Dibuka dari tombol "Buat invoice" di Kaly POS › Transaksi: langsung tampilkan pilihan sumber
  after(root, ctx, first) { if (first && ctx.q?.new) { history.replaceState(null, '', '#/invoice'); setTimeout(() => pickSource(ctx)); } },
  render(ctx) {
    const db = ctx.db;
    const locs = locIds(db);
    const all = (db.invoices || []).filter((v) => locs.includes(v.loc));
    const open = all.filter((v) => v.status === 'terbit');
    const late = all.filter(overdue);
    const mStart = dayKey(Date.now() - 30 * DAY);
    const paid30 = all.filter((v) => v.status === 'lunas' && v.paidOn >= mStart);
    const list = rows(db);

    const kpis = `<div class="kpis">
      <div class="kpi"><small>Belum dibayar</small><b>${rp(open.reduce((a, v) => a + sisa(v), 0))}</b><small>${num(open.length)} invoice</small></div>
      <div class="kpi"><small>Lewat jatuh tempo</small><b class="${late.length ? 'neg' : ''}">${rp(late.reduce((a, v) => a + sisa(v), 0))}</b><small>${num(late.length)} invoice</small></div>
      <div class="kpi"><small>Lunas 30 hari</small><b>${rp(paid30.reduce((a, v) => a + v.total, 0))}</b><small>${num(paid30.length)} invoice</small></div>
      <div class="kpi"><small>Diterbitkan 30 hari</small><b>${num(all.filter((v) => v.issuedOn >= mStart).length)}</b><small>semua status</small></div></div>`;

    const row = (v) => {
      const to = v.billTo.company || v.billTo.name || '(tanpa nama)';
      const sub = v.billTo.company && v.billTo.name ? v.billTo.name : '';
      const [sl, sc] = STATUS[v.status] || ['?', 'b-mute'];
      return `<tr>
        <td><b>${esc(v.no)}</b><br><small class="muted">${esc(KIND[v.kind] || v.kind)}</small></td>
        <td>${esc(fmtDate(v.issuedOn))}</td>
        <td>${v.dueOn ? `${esc(fmtDate(v.dueOn))}${overdue(v) ? '<br><small class="neg">lewat tempo</small>' : ''}` : '<span class="muted">–</span>'}</td>
        <td><b>${esc(to)}</b>${sub ? `<br><small class="muted">${esc(sub)}</small>` : ''}</td>
        <td class="r">${rp(v.total)}</td>
        <td class="r">${v.status === 'terbit' ? `<b>${rp(sisa(v))}</b>${v.paid ? `<br><small class="muted">dibayar ${rp(v.paid)}</small>` : ''}` : '<span class="muted">–</span>'}</td>
        <td><span class="badge ${sc}">${sl}</span>${v.status === 'lunas' && v.paidOn ? `<br><small class="muted">${esc(fmtDate(v.paidOn))}</small>` : ''}</td>
        <td class="r nowrap">
          <button class="btn-icon sm" data-a="invOpen" data-id="${v.id}" title="Lihat & cetak" aria-label="Lihat invoice ${esc(v.no)}">${ic('eye', 15)}</button>
          <button class="btn-icon sm" data-a="invLink" data-id="${v.id}" title="Salin tautan untuk tamu" aria-label="Salin tautan">${ic('link', 15)}</button>
          ${v.status === 'terbit' ? `<button class="btn-icon sm" data-a="invEdit" data-id="${v.id}" title="Ubah" aria-label="Ubah">${ic('pencil', 15)}</button>
            <button class="btn-icon sm" data-a="invPaid" data-id="${v.id}" title="Tandai lunas" aria-label="Tandai lunas">${ic('check', 15)}</button>
            <button class="btn-icon sm" data-a="invVoid" data-id="${v.id}" title="Batalkan" aria-label="Batalkan">${ic('x', 15)}</button>` : ''}</td></tr>`;
    };

    return `<div class="inv">
      <div class="banner info sm">${ic('file-text', 17)}<span>Invoice adalah dokumen untuk tamu. Uangnya tetap dicatat lewat kasir atau pelunasan piutang — invoice dari bill ikut lunas sendiri begitu piutangnya dilunasi di Laporan keuangan › Piutang.</span></div>
      ${kpis}
      <div class="card">
        <div class="card-h"><h3>Daftar invoice</h3><div class="row" style="gap:8px"><button class="btn" data-a="invSet">${ic('settings', 16)} Identitas & rekening</button><button class="btn btn-pri" data-a="invNew">${ic('plus', 16)} Invoice baru</button></div></div>
        <div class="row sb wrap" style="gap:10px;margin-bottom:10px">
          <div class="chips">${[['open', 'Belum lunas'], ['over', 'Lewat tempo'], ['paid', 'Lunas'], ['void', 'Batal'], ['all', 'Semua']].map(([k, l]) => `<button class="chip ${ui.tab === k ? 'on' : ''}" data-a="invTab" data-v="${k}">${l}</button>`).join('')}</div>
          <input class="inp inp-sm" data-in="invQ" value="${esc(ui.q)}" placeholder="Cari nomor, nama, perusahaan…" aria-label="Cari invoice">
        </div>
        <div class="tbl-wrap"><table class="tbl hover"><thead><tr><th>Nomor</th><th>Tanggal</th><th>Jatuh tempo</th><th>Ditagihkan ke</th><th class="r">Total</th><th class="r">Sisa</th><th>Status</th><th></th></tr></thead>
          <tbody>${list.map(row).join('') || `<tr><td colspan="8" class="empty">${ui.q ? 'Tidak ada invoice yang cocok.' : 'Belum ada invoice. Tekan “Invoice baru” untuk membuat yang pertama.'}</td></tr>`}</tbody></table></div>
      </div></div>`;
  },
  input(k, el) { if (k === 'invQ') { ui.q = el.value; rerender(); } },
  actions: {
    invTab(el) { ui.tab = el.dataset.v; rerender(); },
    invOpen(el, e, ctx) {
      const v = ctx.db.invoices.find((x) => x.id === el.dataset.id);
      if (v) window.open(invoiceUrl(v), '_blank', 'noopener');
    },
    invLink(el, e, ctx) {
      const v = ctx.db.invoices.find((x) => x.id === el.dataset.id);
      if (v) copyText(invoiceUrl(v));
    },
    invNew(el, e, ctx) { pickSource(ctx); },
    invEdit(el, e, ctx) {
      const v = ctx.db.invoices.find((x) => x.id === el.dataset.id);
      if (v) editor(ctx, v.kind, { inv: v });
    },
    async invPaid(el, e, ctx) {
      const v = ctx.db.invoices.find((x) => x.id === el.dataset.id);
      if (!v) return;
      openModal({ title: `Tandai lunas ${v.no}`, size: 'sm',
        body: `<p class="muted sm">Ditagihkan ke <b>${esc(v.billTo.company || v.billTo.name || '-')}</b>, sisa <b>${rp(sisa(v))}</b>.</p>
          <label class="fld"><span>Tanggal pelunasan</span><input type="date" name="on" max="${dayKey()}" value="${dayKey()}"></label>
          <p class="hint">Ini hanya mengubah status dokumennya. Uang masuknya dicatat lewat kasir atau pelunasan piutang, supaya jurnalnya tidak dobel.</p>`,
        footer: '<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Tandai lunas</button>',
        onMount(m, api) {
          m.querySelector('[data-ok]').addEventListener('click', async () => {
            const f = formData(m); api.close();
            try { await API.invoiceMarkPaid(v.id, f.on || dayKey()); await C.refresh('invoices'); toast(`${v.no} ditandai lunas`); }
            catch (err) { toast(err.message, 'err', 7000); }
            rerender();
          });
        } });
    },
    async invVoid(el, e, ctx) {
      const v = ctx.db.invoices.find((x) => x.id === el.dataset.id);
      if (!v) return;
      const why = await askReason(`Batalkan ${v.no}?`, 'Contoh: acara dibatalkan tamu');
      if (!why) return;
      try { await API.invoiceVoid(v.id, why); await C.refresh('invoices'); toast(`${v.no} dibatalkan`); }
      catch (err) { toast(err.message, 'err', 7000); }
      rerender();
    },
    invPick(el, e, ctx) { editor(ctx, el.dataset.k, { src: el.dataset.id }); },
    invSet(el, e, ctx) { settingsDialog(ctx); },
  },
};

// ---------- Identitas penerbit & rekening tujuan ----------
function settingsDialog(ctx) {
  const cfg = { ...C.INVOICE_DEFAULT, ...(ctx.db.settings.invoice || {}) };
  let bank = cfg.bank.length ? cfg.bank.map((b) => ({ ...b })) : [{ bank: '', no: '', an: '' }];
  const bankRows = () => bank.map((b, i) => `<div class="bom-row inv-bank">
      <input data-bb="${i}" value="${esc(b.bank)}" placeholder="Nama bank" aria-label="Bank ${i + 1}">
      <input data-bn="${i}" value="${esc(b.no)}" placeholder="Nomor rekening" aria-label="Nomor rekening ${i + 1}">
      <input data-ba="${i}" value="${esc(b.an)}" placeholder="Atas nama" aria-label="Atas nama ${i + 1}">
      <button class="btn-icon sm" data-bx="${i}" aria-label="Hapus rekening">${ic('x', 15)}</button></div>`).join('');

  openModal({ title: 'Identitas di invoice', size: 'md',
    body: `<p class="muted sm">Yang dikosongkan akan memakai data nota dan nama usaha yang sudah diatur di Pengaturan.</p>
      <label class="fld"><span>Nama penerbit</span><input name="name" value="${esc(cfg.name)}" placeholder="Nama badan usaha, misal PT Kalibrantas Sejahtera"></label>
      <label class="fld"><span>Alamat</span><input name="address" value="${esc(cfg.address)}" placeholder="Alamat lengkap"></label>
      <div class="grid2">
        <label class="fld"><span>Telepon</span><input name="phone" value="${esc(cfg.phone)}"></label>
        <label class="fld"><span>Email</span><input name="email" type="email" value="${esc(cfg.email)}"></label>
      </div>
      <div class="grid2">
        <label class="fld"><span>NPWP</span><input name="npwp" value="${esc(cfg.npwp)}"></label>
        <label class="fld"><span>Jatuh tempo bawaan</span><input name="dueDays" type="number" min="0" max="180" value="${cfg.dueDays}"><small class="muted">hari sejak invoice terbit</small></label>
      </div>
      <div class="card-h"><h4>Rekening tujuan transfer</h4><button class="btn btn-sm" data-badd>${ic('plus', 15)} Tambah</button></div>
      <div class="bom-rows" id="inv-bank">${bankRows()}</div>
      <label class="fld"><span>Syarat pembayaran (opsional)</span><input name="terms" value="${esc(cfg.terms)}" placeholder="Contoh: pembayaran paling lambat 14 hari sejak invoice diterbitkan"></label>
      <label class="fld"><span>Kalimat penutup</span><input name="footer" value="${esc(cfg.footer)}" placeholder="Terima kasih atas kepercayaan Anda."></label>`,
    footer: '<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Simpan</button>',
    onMount(m, api) {
      const repaint = () => { m.querySelector('#inv-bank').innerHTML = bankRows(); };
      m.addEventListener('input', (ev) => {
        const t = ev.target;
        if (t.dataset.bb !== undefined) bank[+t.dataset.bb].bank = t.value;
        else if (t.dataset.bn !== undefined) bank[+t.dataset.bn].no = t.value;
        else if (t.dataset.ba !== undefined) bank[+t.dataset.ba].an = t.value;
      });
      m.addEventListener('click', (ev) => {
        const x = ev.target.closest('[data-bx]'), add = ev.target.closest('[data-badd]');
        if (x) { bank.splice(+x.dataset.bx, 1); if (!bank.length) bank.push({ bank: '', no: '', an: '' }); repaint(); }
        if (add && bank.length < 4) { bank.push({ bank: '', no: '', an: '' }); repaint(); }
      });
      m.querySelector('[data-ok]').addEventListener('click', async () => {
        const f = formData(m); api.close();
        const patch = { invoice: { name: f.name.trim(), address: f.address.trim(), phone: f.phone.trim(), email: f.email.trim(),
          npwp: f.npwp.trim(), dueDays: Number(f.dueDays) || 0, terms: f.terms.trim(), footer: f.footer.trim(),
          bank: bank.filter((b) => b.no.trim()) } };
        try { await API.saveSettings(patch); await C.refresh('settings'); toast('Identitas invoice tersimpan'); }
        catch (err) { toast(err.message, 'err', 7000); }
        rerender();
      });
    } });
}

// ---------- Pilih sumber invoice ----------
function pickSource(ctx) {
  const db = ctx.db;
  const used = new Set(db.invoices.filter((v) => v.status !== 'batal').map((v) => v.order).filter(Boolean));
  const locs = locIds(db);
  const bills = (db.receivables || []).filter((r) => r.status === 'open' && locs.includes(r.loc) && !used.has(r.order))
    .sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
  const usedRes = new Set(db.invoices.filter((v) => v.status !== 'batal').map((v) => v.res).filter(Boolean));
  const res = (db.reservations || []).filter((r) => Number(r.dp) > 0 && !['batal', 'no-show'].includes(r.status) && !usedRes.has(r.id))
    .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30);
  const ordNo = (id) => D.order(db, id)?.no || id;

  openModal({ title: 'Invoice baru', size: 'md',
    body: `<p class="muted sm">Pilih sumbernya. Invoice yang dibuat dari bill atau reservasi mengambil angkanya langsung dari sana, jadi tidak bisa menyimpang dari pembukuan.</p>
      <div class="card-h"><h4>Dari bill pending</h4></div>
      ${bills.length ? `<div class="pick-list">${bills.map((r) => `<button class="pick" data-a="invPick" data-k="order" data-id="${r.order}">
          <span><b>${esc(ordNo(r.order))}</b> · ${esc(r.debtor || 'tanpa nama')}<small>${r.due ? `jatuh tempo ${esc(fmtDate(r.due))}` : 'tanpa jatuh tempo'}</small></span><b>${rp(r.a)}</b></button>`).join('')}</div>`
        : '<p class="empty sm">Tidak ada bill pending yang belum dibuatkan invoice.</p>'}
      <div class="card-h"><h4>Dari reservasi ber-DP</h4></div>
      ${res.length ? `<div class="pick-list">${res.map((r) => `<button class="pick" data-a="invPick" data-k="reservation" data-id="${r.id}">
          <span><b>${esc(r.name)}</b> · ${esc(fmtDate(r.date))} ${esc(r.time)}<small>${num(r.pax)} orang · DP ${rp(r.dp)}</small></span><b>${esc(r.code)}</b></button>`).join('')}</div>`
        : '<p class="empty sm">Tidak ada reservasi ber-DP yang belum dibuatkan invoice.</p>'}
      <div class="card-h"><h4>Tagihan manual</h4></div>
      <button class="pick" data-a="invPick" data-k="manual" data-id=""><span><b>Buat dari nol</b><small>Untuk tamu korporat atau acara yang belum ada bill-nya</small></span>${ic('arrow-right', 16)}</button>`,
    footer: '<button class="btn" data-close>Tutup</button>' });
}

// ---------- Penyunting invoice ----------
// 2.23 · Dipanggil dari Kaly POS › Transaksi: bill lama yang tidak ada di data harian dikirim langsung
export function invoiceFromOrder(ctx, order) { editor(ctx, 'order', { src: order.id, order }); }

function editor(ctx, kind, { inv = null, src = '', order = null } = {}) {
  const db = ctx.db;
  const fromBill = kind === 'order';
  const o = fromBill ? (order || D.order(db, inv ? inv.order : src)) : null;
  const r = kind === 'reservation' ? (db.reservations || []).find((x) => x.id === (inv ? inv.res : src)) : null;
  const dueDays = Number(db.settings.invoice?.dueDays) || 14;
  const b = inv?.billTo || {};
  // 2.23 · Nama & telepon terisi otomatis dari reservasi atau dari bill (nama tamu yang dicatat kasir)
  const oRes = o?.res ? (db.reservations || []).find((x) => x.id === o.res) : null;
  const defName = b.name || r?.name || oRes?.name || (fromBill ? (db.receivables.find((x) => x.order === o?.id)?.debtor || o?.cust?.name || '') : '');
  const defPhone = b.phone || r?.phone || oRes?.phone || o?.cust?.phone || '';

  // Baris awal untuk invoice manual / reservasi
  let lines = inv && !fromBill ? inv.lines.map((l) => ({ n: l.n, q: l.q, p: l.p }))
    // 2.23 · Reservasi dengan menu pesanan: rincian menu jadi baris tagihan (harga saat dipesan)
    : r && (r.items || []).length ? r.items.map((it) => ({ n: (db.menus.find((m) => m.id === it.m)?.name || it.m) + (it.note ? ` (${it.note})` : ''), q: it.q, p: it.p }))
    : r ? [{ n: `Reservasi ${r.code} · ${fmtDate(r.date)} ${r.time} · ${r.pax} orang`, q: 1, p: 0 }]
      : [{ n: '', q: 1, p: 0 }];

  const lineRows = () => lines.map((l, i) => `<div class="bom-row inv-row">
      <input data-ln="${i}" value="${esc(l.n)}" placeholder="Keterangan" aria-label="Keterangan baris ${i + 1}">
      <input type="number" step="0.01" data-lq="${i}" value="${l.q}" aria-label="Jumlah">
      <input type="number" step="100" data-lp="${i}" value="${l.p}" aria-label="Harga satuan">
      <span class="muted sm nowrap">${rp(Math.round(l.q * l.p))}</span>
      <button class="btn-icon sm" data-lx="${i}" aria-label="Hapus baris">${ic('x', 15)}</button></div>`).join('');

  const totals = (m) => {
    const sub = fromBill ? Number(o?.bill?.sub || 0) : lines.reduce((a, l) => a + Math.round(l.q * l.p), 0);
    const disc = fromBill ? Number(o?.bill?.disc || 0) : Math.min(Math.max(0, Number(m.querySelector('[name=disc]')?.value) || 0), sub);
    const svcOn = fromBill ? true : !!m.querySelector('[name=svcOn]')?.checked;
    const taxOn = fromBill ? true : !!m.querySelector('[name=taxOn]')?.checked;
    const svc = fromBill ? Number(o?.bill?.svc || 0) : svcOn ? Math.round((sub - disc) * db.settings.serviceRate) : 0;
    const tax = fromBill ? Number(o?.bill?.tax || 0) : taxOn ? Math.round((sub - disc + svc) * db.settings.taxRate) : 0;
    const round = fromBill ? Number(o?.bill?.round || 0) : 0;
    const paid = fromBill ? Number(inv?.paid || 0) : r ? Number(r.dp || 0) : Math.max(0, Number(m.querySelector('[name=paid]')?.value) || 0);
    const total = sub - disc + svc + tax - round;
    return { sub, disc, svc, tax, round, total, paid, due: total - paid };
  };

  const sumHtml = (t) => `<dl class="sum">
    <dt>Subtotal</dt><dd>${rp(t.sub)}</dd>
    ${t.disc ? `<dt class="disc">Diskon</dt><dd class="disc">-${rp(t.disc)}</dd>` : ''}
    ${t.svc ? `<dt>Service ${Math.round(db.settings.serviceRate * 100)}%</dt><dd>${rp(t.svc)}</dd>` : ''}
    ${t.tax ? `<dt>PB1 ${Math.round(db.settings.taxRate * 100)}%</dt><dd>${rp(t.tax)}</dd>` : ''}
    ${t.round ? `<dt>Pembulatan</dt><dd>${t.round > 0 ? '-' : '+'}${rp(Math.abs(t.round))}</dd>` : ''}
    <dt class="big">Total</dt><dd class="big">${rp(t.total)}</dd>
    ${t.paid ? `<dt>Sudah dibayar</dt><dd>-${rp(t.paid)}</dd><dt class="big">Sisa tagihan</dt><dd class="big">${rp(t.due)}</dd>` : ''}</dl>`;

  openModal({ title: inv ? `Ubah ${inv.no}` : fromBill ? `Invoice dari bill ${o?.no || ''}` : r ? `Invoice reservasi ${r.code}` : 'Invoice manual', size: 'lg',
    body: `<div class="inv-ed">
      <div class="grid2">
        <label class="fld"><span>Nama penerima tagihan</span><input name="name" value="${esc(defName)}" placeholder="Nama orang yang dihubungi"></label>
        <label class="fld"><span>Perusahaan / instansi</span><input name="company" value="${esc(b.company || '')}" placeholder="PT Sumber Rejeki"></label>
      </div>
      <label class="fld"><span>Alamat</span><input name="address" value="${esc(b.address || '')}" placeholder="Alamat penagihan"></label>
      <div class="grid2">
        <label class="fld"><span>No. HP / telepon</span><input name="phone" value="${esc(defPhone)}"></label>
        <label class="fld"><span>Email</span><input name="email" type="email" value="${esc(b.email || '')}"></label>
      </div>
      <div class="grid2">
        <label class="fld"><span>NPWP (opsional)</span><input name="npwp" value="${esc(b.npwp || '')}" placeholder="Kosongkan bila tidak perlu"></label>
        <label class="fld"><span>Jatuh tempo</span><input name="dueOn" type="date" value="${esc(inv?.dueOn || dayKey(Date.now() + dueDays * DAY))}"></label>
      </div>
      ${fromBill ? `<div class="banner info sm">${ic('lock', 16)}<span>Rincian dan angkanya diambil dari bill <b>${esc(o?.no || '')}</b> dan tidak bisa diubah di sini. Kalau ada yang keliru, perbaiki bill-nya dulu.</span></div>
          <div class="tbl-wrap"><table class="tbl sm"><thead><tr><th>Item</th><th class="r">Jml</th><th class="r">Harga</th><th class="r">Jumlah</th></tr></thead><tbody>
          ${(o?.lines || []).filter((l) => !l.par && l.s !== 'void').map((l) => `<tr><td>${esc(l.n)}</td><td class="r">${num(l.q)}</td><td class="r">${rp(l.p)}</td><td class="r">${rp(l.q * l.p)}</td></tr>`).join('')}
          </tbody></table></div>`
        : `<div class="card-h"><h4>Rincian tagihan</h4><button class="btn btn-sm" data-add>${ic('plus', 15)} Tambah baris</button></div>
          <div class="bom-rows" id="inv-lines">${lineRows()}</div>
          <div class="grid2">
            <label class="fld"><span>Diskon (Rp)</span><input name="disc" type="number" step="1000" min="0" value="${inv?.disc || 0}"></label>
            <label class="fld"><span>Sudah dibayar / DP (Rp)</span><input name="paid" type="number" step="1000" min="0" value="${r ? Number(r.dp || 0) : inv?.paid || 0}" ${r ? 'readonly' : ''}></label>
          </div>
          <label class="switch"><input type="checkbox" name="svcOn" ${inv ? (inv.svc ? 'checked' : '') : ''}><span>Kenakan service charge ${Math.round(db.settings.serviceRate * 100)}%</span></label>
          <label class="switch"><input type="checkbox" name="taxOn" ${inv ? (inv.tax ? 'checked' : '') : 'checked'}><span>Kenakan PB1 ${Math.round(db.settings.taxRate * 100)}%</span></label>`}
      <label class="fld"><span>Catatan di invoice (opsional)</span><input name="note" value="${esc(inv?.note || '')}" placeholder="Contoh: acara gathering 20 Des"></label>
      <div id="inv-sum"></div></div>`,
    footer: '<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Simpan invoice</button>',
    onMount(m, api) {
      const paint = () => { m.querySelector('#inv-sum').innerHTML = sumHtml(totals(m)); };
      const repaintLines = () => { const w = m.querySelector('#inv-lines'); if (w) w.innerHTML = lineRows(); paint(); };
      m.addEventListener('input', (ev) => {
        const t = ev.target;
        if (t.dataset.ln !== undefined) lines[+t.dataset.ln].n = t.value;
        else if (t.dataset.lq !== undefined) lines[+t.dataset.lq].q = Number(t.value) || 0;
        else if (t.dataset.lp !== undefined) lines[+t.dataset.lp].p = Number(t.value) || 0;
        paint();
      });
      m.addEventListener('change', paint);
      m.addEventListener('click', (ev) => {
        const x = ev.target.closest('[data-lx]'), add = ev.target.closest('[data-add]');
        if (x) { lines.splice(+x.dataset.lx, 1); if (!lines.length) lines.push({ n: '', q: 1, p: 0 }); repaintLines(); }
        if (add) { lines.push({ n: '', q: 1, p: 0 }); repaintLines(); }
      });
      paint();

      m.querySelector('[data-ok]').addEventListener('click', async () => {
        const f = formData(m);
        if (!fromBill && !lines.some((l) => l.n.trim() && l.q > 0)) return toast('Isi minimal satu baris tagihan', 'warn');
        if (!f.name.trim() && !f.company.trim()) return toast('Isi nama atau perusahaan penerima tagihan', 'warn');
        const p = { kind, loc: o?.loc || r?.loc || locIds(db)[0],
          billTo: { name: f.name.trim(), company: f.company.trim(), address: f.address.trim(), phone: f.phone.trim(), email: f.email.trim(), npwp: f.npwp.trim() },
          dueOn: f.dueOn || null, note: f.note.trim() };
        if (inv) p.id = inv.id;
        if (fromBill) p.order = o?.id;
        else {
          if (r) p.reservation = r.id;
          p.lines = lines.filter((l) => l.n.trim()).map((l) => ({ name: l.n.trim(), qty: l.q, price: l.p }));
          p.disc = Number(f.disc) || 0; p.svcOn = !!f.svcOn; p.taxOn = !!f.taxOn;
          if (!r) p.paid = Number(f.paid) || 0;
        }
        api.close();
        try {
          const saved = await API.invoiceSave(p);
          await C.refresh('invoices');
          toast(`Invoice ${saved?.no || ''} tersimpan`);
        } catch (err) { toast(err.message, 'err', 7000); }
        rerender();
      });
    } });
}
