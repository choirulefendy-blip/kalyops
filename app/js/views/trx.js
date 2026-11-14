// 2.13 · Aktivitas transaksi & riwayat shift
// Kasir: tab "Transaksi" di Kaly POS (7 hari terakhir), lihat detail & cetak ulang nota.
// Owner/Manajer: Kaly Backoffice › Transaksi & shift — semua tanggal, refund, riwayat shift semua terminal.
// Data dibaca langsung dari server (trx_list, shift_reports) supaya transaksi lama tetap lengkap.
import { getDb, getTerminal } from '../store.js';
import * as API from '../api.js';
import * as C from '../cloud.js';
import * as D from '../domain.js';
import { esc, ic, rp, num, toast, openModal, fmtTime, fmtDate, fmtDT, dayKey, startOfDay, DAY, downloadCSV } from '../lib.js';
import { rerender } from '../app.js';
import { sendPrints, doPrint } from '../printing.js';

const ST = { paid: ['Lunas', 'b-ok'], refund: ['Refund', 'b-err'], void: ['Batal', 'b-mute'] };
const PAGE = 60;
const S = { range: 'today', from: '', to: '', shift: null, shiftLabel: '', q: '', status: '', method: '', rows: [], sum: null, more: false, loading: false, key: '', err: '', min: null };
const H = { days: 7, list: null, err: '', key: '', open: null, loading: false, items: {} };
// H.items[shiftId] = { data: null|array, loading: bool, err: string }
const V = { tab: 'trx' };

const isOwner = (ctx) => ctx.user.role === 'owner';
const payText = (p) => `${D.PAY[p.m]?.label || p.m}${p.card ? ' ' + p.card : ''}`;
const whereText = (r) => (r.table ? 'Meja ' + [r.table, ...(r.merged || [])].join('+') : D.TYPE_LABEL[r.type] || '');

// ---------- Daftar transaksi ----------
function ranges(ctx) {
  const sh = !isOwner(ctx) && D.activeShift(ctx.db, ctx.terminal);
  return [...(sh ? [['shift', 'Shift ini']] : []), ['today', 'Hari ini'], ['yday', 'Kemarin'], ['7d', '7 hari'], ...(isOwner(ctx) ? [['30d', '30 hari'], ['custom', 'Tanggal']] : [])];
}
function bounds(ctx) {
  const today = dayKey(), back = (n) => dayKey(startOfDay() - n * DAY + 12 * 3600000);
  if (S.range === 'custom') return [S.from || today, S.to || today];
  return { today: [today, today], yday: [back(1), back(1)], '7d': [back(6), today], '30d': [back(29), today] }[S.range] || [today, today];
}
function filterOf(ctx) {
  let shift = S.shift;
  if (!shift && S.range === 'shift') shift = D.activeShift(ctx.db, ctx.terminal)?.id || null;
  const [from, to] = bounds(ctx);
  return { loc: ctx.outlet, from, to, shift, q: S.q.trim(), status: S.status, method: S.method };
}
async function load(ctx, more = false) {
  const f = filterOf(ctx), key = JSON.stringify(f);
  S.key = key; S.loading = true; S.err = '';
  if (!more) rerender();
  try {
    const r = await API.trxList({ ...f, limit: PAGE, before: more && S.rows.length ? S.rows[S.rows.length - 1].t : null });
    if (S.key !== key) return;
    S.rows = more ? S.rows.concat(r.rows || []) : r.rows || [];
    S.sum = more ? S.sum : r.sum; S.more = !!r.more; S.min = r.min;
  } catch (e) {
    S.err = /trx_list|schema cache|function/i.test(e.message || '') ? 'Daftar transaksi belum aktif: jalankan update database 2.13 di Supabase.' : e.message;
    if (!more) { S.rows = []; S.sum = null; }
  } finally { S.loading = false; rerender(); }
}
export function reloadTrx(ctx) { S.key = ''; load(ctx); }
// Dari riwayat shift: tampilkan transaksi shift itu saja
export function showShift(id, label) { S.shift = id; S.shiftLabel = label || ''; S.key = ''; V.tab = 'trx'; }

function sumStrip(ctx) {
  const s = S.sum; if (!s) return '';
  const by = Object.entries(s.by || {});
  return `<div class="tx-sum">
    <div><small>Transaksi lunas</small><b>${num(s.paid)}</b></div><div><small>Penjualan</small><b>${rp(s.paid_total)}</b></div>
    ${s.refund ? `<div class="neg"><small>Refund</small><b>${num(s.refund)} · ${rp(s.refund_total)}</b></div>` : ''}${s.void ? `<div><small>Bill batal</small><b>${num(s.void)}</b></div>` : ''}
    ${by.map(([m, a]) => `<div class="mt"><small>${esc(D.PAY[m]?.label || m)}</small><b>${rp(a)}</b></div>`).join('')}</div>`;
}
function rowHtml(r) {
  const [sl, sc] = ST[r.status] || [r.status, 'b-mute'];
  const t = Date.parse(r.t);
  return `<tr class="tx-r st-${r.status}" data-a="txOpen" data-id="${esc(r.id)}" tabindex="0">
    <td class="nowrap"><b>${fmtTime(t)}</b><br><small class="muted">${fmtDate(t)}</small></td>
    <td><b>${esc(r.no)}</b><br><small class="muted">${esc(whereText(r))}</small></td>
    <td>${esc(r.cashier || '—')}<br><small class="muted">${esc(r.terminal || D.CH_LABEL?.[r.channel] || '')}</small></td>
    <td class="tx-pm">${r.status === 'void' ? `<small class="muted">${esc(r.void_reason || '')}</small>` : (r.pays || []).map((p) => `<span class="pm-chip">${ic(D.PAY[p.m]?.icon || 'wallet', 13)}${esc(D.PAY[p.m]?.label || p.m)}</span>`).join('')}</td>
    <td class="r"><b class="${r.status === 'refund' ? 'strike' : ''}">${rp(r.total)}</b><br><small class="muted">${num(r.items)} item</small></td>
    <td><span class="badge ${sc}">${sl}</span>${r.prints > 1 ? `<br><small class="muted">dicetak ${r.prints}×</small>` : ''}</td></tr>`;
}
// ---------- Cetak laporan transaksi (kasir & owner) ----------
function txRangeLabel(f) {
  if (f.shift) return S.shiftLabel ? `Shift ${S.shiftLabel}` : 'Shift ini';
  if (f.from === f.to) return fmtDate(Date.parse(f.from));
  return `${fmtDate(Date.parse(f.from))} s/d ${fmtDate(Date.parse(f.to))}`;
}
function printTrxBillsHtml(bills, f, locName) {
  const rangeLabel = txRangeLabel(f);
  const paid = bills.filter((b) => b.status === 'paid');
  const refunds = bills.filter((b) => b.status === 'refund');
  const voids = bills.filter((b) => b.status === 'void');
  const paidTotal = paid.reduce((s, b) => s + Number(b.total || 0), 0);
  const refundTotal = refunds.reduce((s, b) => s + Number(b.total || 0), 0);
  const byMethod = {};
  for (const b of paid) for (const p of b.pays || []) byMethod[p.m] = (byMethod[p.m] || 0) + Number(p.a || 0);
  const rows = bills.map((b) => {
    const payLabel = (b.pays || []).map((p) => D.PAY[p.m]?.label || p.m).join(', ');
    const loc2 = b.table ? `Meja ${b.table}` : D.TYPE_LABEL?.[b.type] || '';
    return `<tr><td>${esc(b.no || '')}</td><td>${b.paid_at ? fmtTime(Date.parse(b.paid_at)) : ''}</td><td>${esc(loc2)}</td><td>${esc(b.cashier || '')}</td><td>${esc(payLabel)}</td><td class="r">${b.status === 'void' ? '—' : rp(b.total)}</td><td>${({ paid: 'OK', refund: 'REF', void: 'BTL' })[b.status] || b.status}</td></tr>`;
  }).join('');
  const methodRows = Object.entries(byMethod).map(([m, a]) => `<tr><td>${esc(D.PAY[m]?.label || m)}</td><td class="r">${rp(a)}</td></tr>`).join('');
  const now = new Date();
  const css = `*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Courier New',monospace;font-size:11px;width:72mm;padding:4mm;color:#000}h1{font-size:13px;text-align:center;font-weight:700;margin-bottom:2px}.sub{text-align:center;font-size:10px;margin-bottom:3px;color:#333}hr{border:none;border-top:1px dashed #000;margin:4px 0}table{width:100%;border-collapse:collapse}th{font-size:9.5px;text-align:left;padding:1px 2px;border-bottom:1px solid #000}td{padding:1px 2px;font-size:10px;vertical-align:top;word-break:break-word}.r{text-align:right;white-space:nowrap}.tot td{font-weight:700;border-top:1px solid #000;padding-top:3px}.foot{text-align:center;font-size:9px;margin-top:6px;color:#555}@media print{body{padding:0}}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Transaksi ${rangeLabel}</title><style>${css}</style></head><body>
<h1>${esc(locName || 'Kaly')}</h1>
<div class="sub">Daftar Transaksi</div>
<div class="sub">${esc(rangeLabel)}</div>
<div class="sub">Dicetak: ${fmtDate(now)} ${fmtTime(now)}</div>
<hr>
<table><thead><tr><th>Nota</th><th>Jam</th><th>Meja</th><th>Kasir</th><th>Bayar</th><th class="r">Total</th><th>Sts</th></tr></thead>
<tbody>${rows}</tbody></table>
<hr>
<table><tbody>
<tr class="tot"><td colspan="5">Lunas ${num(paid.length)} nota</td><td class="r">${rp(paidTotal)}</td><td></td></tr>
${refunds.length ? `<tr><td colspan="5">Refund (${num(refunds.length)})</td><td class="r">-${rp(refundTotal)}</td><td></td></tr>` : ''}
${voids.length ? `<tr><td colspan="6">Dibatalkan: ${num(voids.length)} nota</td><td></td></tr>` : ''}
</tbody></table>
${Object.keys(byMethod).length ? `<hr><div class="sub" style="text-align:left;font-weight:600">Metode pembayaran</div><table><tbody>${methodRows}</tbody></table>` : ''}
<div class="foot">— Kaly POS —</div>
<script>window.onload=()=>setTimeout(()=>window.print(),200);</script>
</body></html>`;
}
function printTrxItemsHtml(items, f, locName) {
  const rangeLabel = txRangeLabel(f);
  const valid = items.filter((x) => x.status !== 'void' && x.line_status !== 'void');
  const catMap = new Map();
  for (const x of valid) {
    const cat = x.category || '(Tanpa kategori)';
    if (!catMap.has(cat)) catMap.set(cat, new Map());
    const key = `${x.menu}|||${x.price}`;
    const m = catMap.get(cat);
    if (!m.has(key)) m.set(key, { name: x.menu, price: x.price, qty: 0, amount: 0 });
    const e2 = m.get(key); e2.qty += Number(x.qty) || 0; e2.amount += Number(x.amount) || 0;
  }
  let grandQty = 0, grandAmt = 0, rows = '';
  for (const [cat, menuMap] of catMap.entries()) {
    rows += `<tr class="cat"><td colspan="3">${esc(cat)}</td></tr>`;
    for (const item of menuMap.values()) {
      grandQty += item.qty; grandAmt += item.amount;
      rows += `<tr><td>${esc(item.name)}</td><td class="r">${num(item.qty)}</td><td class="r">${rp(item.amount)}</td></tr>`;
    }
  }
  const now = new Date();
  const css = `*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Courier New',monospace;font-size:11px;width:72mm;padding:4mm;color:#000}h1{font-size:13px;text-align:center;font-weight:700;margin-bottom:2px}.sub{text-align:center;font-size:10px;margin-bottom:3px;color:#333}hr{border:none;border-top:1px dashed #000;margin:4px 0}table{width:100%;border-collapse:collapse}th{font-size:9.5px;text-align:left;padding:1px 2px;border-bottom:1px solid #000}td{padding:1px 2px;font-size:10px;vertical-align:top}.r{text-align:right;white-space:nowrap}.cat td{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding-top:6px;padding-bottom:1px;color:#555}tfoot td{font-weight:700;border-top:1px solid #000;padding-top:3px}.foot{text-align:center;font-size:9px;margin-top:6px;color:#555}@media print{body{padding:0}}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Rekap Item ${rangeLabel}</title><style>${css}</style></head><body>
<h1>${esc(locName || 'Kaly')}</h1>
<div class="sub">Rekap Penjualan per Item</div>
<div class="sub">${esc(rangeLabel)}</div>
<div class="sub">Dicetak: ${fmtDate(now)} ${fmtTime(now)}</div>
<hr>
<table><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Total</th></tr></thead>
<tbody>${rows}</tbody>
<tfoot><tr><td>TOTAL</td><td class="r">${num(grandQty)}</td><td class="r">${rp(grandAmt)}</td></tr></tfoot>
</table>
<div class="foot">— Kaly POS —</div>
<script>window.onload=()=>setTimeout(()=>window.print(),200);</script>
</body></html>`;
}
export function trxPanel(ctx) {
  const f = filterOf(ctx);
  if (S.key !== JSON.stringify(f) && !S.loading) setTimeout(() => load(ctxFresh(ctx)));
  const owner = isOwner(ctx);
  return `<div class="tx">
    <div class="tx-f">
      ${S.shift ? `<span class="chip on tx-shift">${ic('clock', 14)} Shift ${esc(S.shiftLabel || '')}<button class="lnk" data-a="txShiftX" title="Tampilkan semua">${ic('trash-2', 13)}</button></span>` : `<div class="chips">${ranges(ctx).map(([k, l]) => `<button class="chip ${S.range === k ? 'on' : ''}" data-a="txRange" data-v="${k}">${l}</button>`).join('')}
        ${S.range === 'custom' ? `<input type="date" class="inp inp-sm" data-a-change="txFrom" value="${esc(S.from || dayKey())}" aria-label="Dari tanggal"><span class="muted sm">s/d</span><input type="date" class="inp inp-sm" data-a-change="txTo" value="${esc(S.to || dayKey())}" aria-label="Sampai tanggal">` : ''}</div>`}
      <div class="tx-fr">
        <div class="search">${ic('search', 16)}<input id="tx-q" data-in="txQ" value="${esc(S.q)}" placeholder="No. nota, meja, nama tamu/member" autocomplete="off"></div>
        <select class="inp inp-sm" data-a-change="txStatus" aria-label="Status">${[['', 'Semua status'], ['paid', 'Lunas'], ['refund', 'Refund'], ['void', 'Batal']].map(([k, l]) => `<option value="${k}" ${S.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select class="inp inp-sm" data-a-change="txMethod" aria-label="Metode bayar"><option value="">Semua metode</option>${Object.entries(D.PAY).map(([k, p]) => `<option value="${k}" ${S.method === k ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>
        <button class="btn btn-sm btn-ghost" data-a="txReload" title="Muat ulang">${ic('refresh-cw', 15)}</button>
        <button class="btn btn-sm btn-ghost" data-a="txPrintBills" title="Cetak ringkasan semua transaksi">${ic('printer', 15)} Struk</button>
        <button class="btn btn-sm btn-ghost" data-a="txPrintItems" title="Cetak rekap penjualan per item">${ic('printer', 15)} Rekap item</button>
        ${owner ? `<button class="btn btn-sm" data-a="txCsv" title="Unduh laporan per transaksi (CSV)">${ic('download', 15)} Unduh laporan</button>` : ''}
      </div></div>
    ${!owner ? `<p class="muted sm tx-help">Ketuk transaksi untuk melihat rincian & struk, atau mencetak ulang nota. Gunakan ${ic('printer', 13)} <b>Struk</b> untuk mencetak daftar transaksi, atau <b>Rekap item</b> untuk rekap penjualan per menu. Refund hanya bisa dilakukan Owner/Manajer di Kaly Backoffice.</p>`
      : `<p class="muted sm tx-help">${ic('download', 14)} <b>Unduh laporan</b> mengambil <i>semua</i> transaksi sesuai filter di atas (bukan hanya yang tampil), dalam dua file CSV: ringkasan per nota dan rincian item per nota. Keduanya bisa langsung dibuka di Excel.</p>`}
    ${S.err ? `<p class="banner warn sm">${esc(S.err)}</p>` : ''}
    ${sumStrip(ctx)}
    <div class="tbl-wrap"><table class="tbl hover tx-t"><thead><tr><th>Jam</th><th>Nota</th><th>Petugas</th><th>Bayar</th><th class="r">Total</th><th>Status</th></tr></thead>
      <tbody>${S.rows.map(rowHtml).join('') || `<tr><td colspan="6" class="empty">${S.loading ? 'Memuat…' : 'Belum ada transaksi untuk filter ini.'}</td></tr>`}</tbody></table></div>
    ${S.more ? `<div class="row tx-more"><button class="btn" data-a="txMore" ${S.loading ? 'disabled' : ''}>Muat lebih banyak</button></div>` : ''}
  </div>`;
}
const ctxFresh = (ctx) => ({ ...ctx, db: getDb(), terminal: getTerminal() });

// ---------- Rincian transaksi ----------
// pos.js mengimpor modul ini, jadi receiptHtml dimuat saat dibutuhkan (hindari impor melingkar)
let receiptHtml = null;
const rc = async () => { if (!receiptHtml) receiptHtml = (await import('./pos.js')).receiptHtml; };
async function fetchOrder(id) {
  const { data, error } = await C.sb.from('orders').select('*, order_lines(*), order_payments(method, amount, card_id), order_refunds(*)').eq('id', id).maybeSingle();
  if (error) throw new Error(C.errMsg(error));
  if (!data) throw new Error('Transaksi tidak ditemukan');
  return C.mapOrder(data);
}
function refundStamp(o) {
  return o.status === 'refund' ? '<p class="rc-stamp">*** REFUND ***</p>' : o.status === 'void' ? '<p class="rc-stamp">*** DIBATALKAN ***</p>' : '';
}
function detailBody(db, o, r) {
  const shiftName = (id) => { const s = db.shifts.find((x) => x.id === id); return s ? `${s.term} · ${D.shiftName(db, s)}` : ''; };
  const pays = o.pays.map((p) => `<dt>${esc(payText(p))}</dt><dd>${rp(p.a + (p.m === 'cash' ? o.change || 0 : 0))}</dd>`).join('');
  const refund = o.status === 'refund' ? `<div class="tx-refund"><h4>${ic('rotate-ccw', 16)} Refund</h4><dl class="kv">
      <dt>Waktu</dt><dd>${fmtDate(o.refundAt)} ${fmtTime(o.refundAt)}</dd><dt>Oleh</dt><dd>${esc(r?.refund_by || D.userName(db, o.refundBy))}</dd>
      <dt>Alasan</dt><dd>${esc(o.refundReason)}</dd>
      ${(o.refundPays || []).map((p) => `<dt>Dikembalikan · ${esc(payText(p))}</dt><dd>${rp(p.a)}${p.m === 'cash' ? `<br><small class="muted">${o.refundShift ? 'dari laci ' + esc(shiftName(o.refundShift) || 'kasir') : 'dari kas outlet (di luar laci kasir)'}</small>` : p.m === 'deposit' ? '<br><small class="muted">saldo kartu dikembalikan</small>' : '<br><small class="muted">dari rekening bank</small>'}</dd>`).join('')}</dl></div>` : '';
  const vd = o.status === 'void' ? `<div class="tx-refund"><h4>Dibatalkan</h4><dl class="kv"><dt>Oleh</dt><dd>${esc(r?.void_by || D.userName(db, o.voidBy))}</dd><dt>Alasan</dt><dd>${esc(o.voidReason || '')}</dd></dl></div>` : '';
  const m = o.mem && (D.member(db, o.mem)?.name || r?.member);
  return `<div class="tx-d"><div class="tx-dl">
      <dl class="kv">
        <dt>No. nota</dt><dd><b>${esc(o.no)}</b> <span class="badge ${(ST[o.status] || [])[1] || 'b-mute'}">${(ST[o.status] || [o.status])[0]}</span></dd>
        <dt>${o.table ? 'Meja' : 'Jenis'}</dt><dd>${esc(o.table ? [o.table, ...(o.merged || [])].join(' + ') : D.TYPE_LABEL[o.type])}${o.cust?.name ? ' · ' + esc(o.cust.name) : ''}</dd>
        <dt>Dibuat</dt><dd>${fmtDate(o.created)} ${fmtTime(o.created)}</dd>
        ${o.paidAt ? `<dt>Dibayar</dt><dd>${fmtDate(o.paidAt)} <b>${fmtTime(o.paidAt)}</b></dd>` : ''}
        <dt>Petugas kasir</dt><dd>${esc(o.cashier || D.cashierName(db, o))}${o.term ? ` <small class="muted">· ${esc(o.term)}</small>` : ''}</dd>
        ${m ? `<dt>Member</dt><dd>${esc(m)}${o.earned ? ` <small class="muted">· +${o.earned} poin</small>` : ''}</dd>` : ''}
        ${o.status !== 'void' ? `<dt>Total</dt><dd><b>${rp(o.bill?.total ?? o.total)}</b></dd>${pays}${o.change ? `<dt>Kembalian</dt><dd>${rp(o.change)}</dd>` : ''}` : ''}
        ${o.prints ? `<dt>Nota dicetak</dt><dd>${o.prints}×</dd>` : ''}
      </dl>${refund}${partialRefund(db, o)}${vd}</div>
    <div class="tx-rc">${refundStamp(o)}${receiptHtml(db, o)}</div></div>`;
}
export async function openTrx(ctx, id) {
  let o;
  try { await rc(); o = await fetchOrder(id); } catch (e) { return toast(e.message, 'err'); }
  const r = S.rows.find((x) => x.id === id);
  if (r?.cashier) o.cashier = r.cashier;
  const db = getDb(), owner = isOwner(ctx);
  const canPrint = o.status !== 'void';
  openModal({
    title: `Transaksi ${o.no}`, size: 'lg',
    body: detailBody(db, o, r),
    footer: `${owner && o.status === 'paid' ? `${(o.refunds || []).length ? '' : `<button class="btn btn-danger-ghost" data-refund>${ic('rotate-ccw', 16)} Refund</button>`}<button class="btn btn-danger-ghost" data-refund-item>${ic('rotate-ccw', 16)} Refund per item</button>` : ''}<span class="grow"></span>
      ${canPrint && owner ? `<button class="btn btn-ghost" data-here title="Cetak lewat jendela cetak perangkat ini">${ic('printer', 16)} Cetak di perangkat ini</button>` : ''}
      ${canPrint ? `<button class="btn btn-pri" data-print>${ic('printer', 16)} Cetak ulang nota</button>` : ''}<button class="btn" data-close>Tutup</button>`,
    onMount(m, api) {
      const pr = async (local, btn) => {
        btn.disabled = true;
        try {
          let n = 2;
          try { n = await API.printCount(o.id); } catch {}
          const html = `<div class="slip">${refundStamp(o)}${receiptHtml(getDb(), o)}<p style="text-align:center"><b>CETAK ULANG${n > 1 ? ' ' + n + '×' : ''}</b></p></div>`;
          await sendPrints(o, [{ kind: 'cust', label: `Nota pelanggan · No. ${o.no} · cetak ulang`, html }], { forceLocal: local });
          o.prints = n; const row = S.rows.find((x) => x.id === o.id); if (row) row.prints = n;
          rerender();
        } catch (e) { toast(e.message || 'Gagal mencetak', 'err', 5000); } finally { btn.disabled = false; }
      };
      m.querySelector('[data-print]')?.addEventListener('click', (e) => pr(false, e.currentTarget));
      m.querySelector('[data-here]')?.addEventListener('click', (e) => pr(true, e.currentTarget));
      m.querySelector('[data-refund]')?.addEventListener('click', () => { api.close(); refundDialog(ctx, o); });
      m.querySelector('[data-refund-item]')?.addEventListener('click', () => { api.close(); refundItemDialog(ctx, o); });
    },
  });
}

// ---------- Refund (khusus Owner/Manajer) ----------
async function refundDialog(ctx, o) {
  try { await C.refresh('shifts'); } catch {}
  const db = getDb();
  const total = o.bill?.total ?? o.total;
  const cash = o.pays.filter((p) => p.m === 'cash').reduce((a, p) => a + p.a, 0);
  const open = db.shifts.filter((s) => !s.closeAt && s.loc === o.loc).sort((a, b) => a.term.localeCompare(b.term));
  const how = (p) => p.m === 'cash' ? 'Diberikan tunai ke tamu' : p.m === 'deposit' ? `Saldo kartu ${esc(p.card || '')} dikembalikan otomatis` : 'Dikembalikan lewat transfer / QRIS ke tamu (dari rekening bank)';
  openModal({
    title: `Refund ${o.no}`, size: 'md',
    body: `<p class="banner warn sm">${ic('triangle-alert', 17)}<span>Refund penuh <b>${rp(total)}</b>. Bill ini tidak lagi dihitung sebagai penjualan, jurnal penjualan dibalik, poin member & voucher dikembalikan, dan item yang belum selesai di dapur dihentikan. Stok bahan tidak dikembalikan. Refund tidak bisa dibatalkan.</span></p>
      <div class="rf-list">${o.pays.map((p) => `<div class="rf-p"><span>${ic(D.PAY[p.m]?.icon || 'wallet', 16)}<b>${esc(payText(p))}</b><small>${how(p)}</small></span><b>${rp(p.a)}</b></div>`).join('')}</div>
      ${cash > 0 ? `<label class="fld"><span>Uang tunai ${rp(cash)} diambil dari</span><select name="shift">
          ${open.map((s, i) => `<option value="${s.id}" ${i === 0 ? 'selected' : ''}>Laci ${esc(s.term)} · ${esc(D.shiftName(db, s))} (shift aktif sejak ${fmtTime(s.openAt)})</option>`).join('')}
          <option value="">Kas outlet, di luar laci kasir</option></select></label>
        <p class="hint">Bila diambil dari laci kasir, kas seharusnya di shift itu berkurang ${rp(cash)} saat tutup shift.</p>` : ''}
      <label class="fld"><span>Alasan refund</span><textarea name="reason" rows="2" maxlength="300" placeholder="Contoh: tamu komplain, salah input, bayar dobel" required></textarea></label>`,
    footer: `<button class="btn" data-close>Batal</button><button class="btn btn-danger" data-ok>${ic('rotate-ccw', 16)} Refund ${rp(total)}</button>`,
    onMount(m, api) {
      m.querySelector('[data-ok]').onclick = async (e) => {
        const reason = m.querySelector('[name=reason]').value.trim();
        if (!reason) return toast('Tulis alasan refund', 'warn');
        const shift = m.querySelector('[name=shift]')?.value || null;
        e.currentTarget.disabled = true;
        try {
          const res = await API.orderRefund(o.id, reason, shift);
          api.close();
          toast(`Bill ${res.no} di-refund ${rp(res.total)}${res.cash ? ` · tunai ${rp(res.cash)} ${res.shift ? 'dari laci ' + (res.terminal || 'kasir') : 'dari kas outlet'}` : ''}`, 'ok', 6000);
          C.refreshOrder(o.id).catch(() => {});
          C.refresh('shifts').catch(() => {});
          H.key = ''; reloadTrx(ctx);
          openTrx(ctx, o.id);
        } catch (err) { toast(err.message, 'err', 6000); e.currentTarget.disabled = false; }
      };
    },
  });
}

// ---------- Riwayat shift ----------
function loadShiftItems(shiftId) {
  const s = H.items[shiftId] ||= { data: null, loading: false, err: '' };
  if (s.loading || s.data) return;
  s.loading = true;
  API.shiftItemReport(shiftId).then((rows) => {
    s.data = rows || []; s.err = '';
  }).catch((e) => { s.err = e.message; s.data = s.data || []; }).finally(() => { s.loading = false; rerender(); });
}

// ---------- 2.22 · Cetak rekap closing ----------
function printShiftHtml(r, items, db, locId) {
  const loc = D.loc(db, locId || r.loc || r.location_id)?.name || '';
  const cfg = db.settings?.receipt || {};
  const name = cfg.name || loc || 'Kaly';
  const by = Object.entries(r.by || {});
  const v = r.variance == null ? null : Number(r.variance);
  const tol = db.settings?.cashVarTol ?? 0;
  const bad = v != null && Math.abs(v) > tol;
  // Group items by category
  const cats = new Map();
  for (const x of items) { const k = x.category || ''; if (!cats.has(k)) cats.set(k, []); cats.get(k).push(x); }
  const itemRows = [...cats.entries()].map(([cat, xs]) => {
    const catHead = cat ? `<tr class="cat"><td colspan="4">${esc(cat)}</td></tr>` : '';
    const rows = xs.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.item_name)}</td><td class="r">${num(x.qty)}</td><td class="r">${rp(x.amount)}</td></tr>`).join('');
    return catHead + rows;
  }).join('');
  const grandTotal = items.reduce((a, x) => a + Number(x.amount || 0), 0);
  return `<!doctype html><html lang="id"><head><meta charset="utf-8">
<title>Closing Shift · ${esc(r.terminal || '')}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:monospace;font-size:12px;width:72mm;padding:4mm 3mm;color:#000}
  h1{font-size:14px;font-weight:bold;text-align:center;margin-bottom:2px}
  .sub{text-align:center;font-size:11px;margin-bottom:6px}
  hr{border:none;border-top:1px dashed #000;margin:5px 0}
  table{width:100%;border-collapse:collapse}
  td{padding:1px 2px;vertical-align:top}
  td.r{text-align:right;white-space:nowrap}
  .cat td{font-weight:bold;padding-top:5px;font-size:11px;text-transform:uppercase}
  .kv td:first-child{width:50%;color:#444}
  .kv td:last-child{text-align:right;font-weight:bold}
  .total td{font-weight:bold;border-top:1px solid #000;padding-top:3px}
  .warn{color:#c00;font-weight:bold}
  .footer{text-align:center;font-size:10px;margin-top:6px}
  @media print{@page{margin:0}}
</style></head><body>
<h1>${esc(name)}</h1>
<div class="sub">Closing Shift · ${esc(r.terminal || '')}</div>
<div class="sub">${esc(r.crew || '—')}</div>
<hr>
<table class="kv"><tbody>
  <tr><td>Dibuka</td><td>${fmtDate(r.openAt)} ${fmtTime(r.openAt)}</td></tr>
  ${r.closeAt ? `<tr><td>Ditutup</td><td>${fmtDate(r.closeAt)} ${fmtTime(r.closeAt)}</td></tr>` : '<tr><td>Status</td><td>Shift aktif</td></tr>'}
  <tr><td>Modal awal</td><td>${rp(r.open_cash)}</td></tr>
  <tr><td>Transaksi</td><td>${num(r.count)}</td></tr>
  ${Number(r.disc) ? `<tr><td>Diskon</td><td>${rp(r.disc)}</td></tr>` : ''}
</tbody></table>
<hr>
<table class="kv"><caption style="text-align:left;font-weight:bold;padding-bottom:2px">Pembayaran Masuk</caption><tbody>
  ${by.map(([m, a]) => `<tr><td>${esc(D.PAY[m]?.label || m)}</td><td>${rp(a)}</td></tr>`).join('') || '<tr><td colspan="2">—</td></tr>'}
  ${Number(r.refund_bill_cash) ? `<tr><td>Refund tunai keluar</td><td>-${rp(r.refund_bill_cash)}</td></tr>` : ''}
</tbody></table>
<hr>
${items.length ? `<table><caption style="text-align:left;font-weight:bold;padding-bottom:2px">Rekap Item Terjual</caption>
  <thead><tr><th style="width:16px">#</th><th>Menu</th><th class="r">Qty</th><th class="r">Total</th></tr></thead>
  <tbody>${itemRows}</tbody>
  <tfoot><tr class="total"><td></td><td>TOTAL</td><td class="r">${items.reduce((a, x) => a + Number(x.qty || 0), 0)}</td><td class="r">${rp(grandTotal)}</td></tr></tfoot>
</table><hr>` : ''}
<table class="kv"><tbody>
  <tr><td>Kas seharusnya</td><td>${rp(r.expected)}</td></tr>
  ${r.closeAt ? `<tr><td>Kas dihitung</td><td>${rp(r.counted)}</td></tr>
  <tr class="${bad ? 'warn' : ''}"><td>Selisih</td><td>${rp(v || 0)}</td></tr>` : ''}
</tbody></table>
<div class="footer">${fmtDT(Date.now())}</div>
<script>window.onload=()=>setTimeout(()=>{window.print();setTimeout(()=>window.close(),500)},200)</script>
</body></html>`;
}

function loadShifts(ctx, force) {
  const key = ctx.outlet + '|' + H.days;
  if (!force && (H.key === key || H.loading)) return;
  H.key = key; H.loading = true;
  API.shiftReports(ctx.outlet, H.days).then((r) => {
    if (H.key !== key) return;
    H.list = (r || []).map((x) => ({ ...x, openAt: Date.parse(x.open_at), closeAt: x.close_at ? Date.parse(x.close_at) : 0 })); H.err = '';
  }).catch((e) => { H.err = e.message; H.list = H.list || []; }).finally(() => { H.loading = false; rerender(); });
}
export function shiftHistoryPanel(ctx) {
  loadShifts(ctx);
  const db = ctx.db, tol = db.settings.cashVarTol;
  const list = H.list;
  const days = new Map();
  for (const r of list || []) { const k = fmtDate(r.openAt, true); if (!days.has(k)) days.set(k, []); days.get(k).push(r); }
  const row = (r) => {
    const open = H.open === r.id;
    const v = r.variance == null ? null : Number(r.variance);
    const bad = v != null && Math.abs(v) > tol;
    const by = Object.entries(r.by || {});
    return `<div class="rep ${open ? 'open' : ''}"><button class="rep-h" data-a="shTg" data-id="${r.id}" aria-expanded="${open}">
        <span><b>${esc(r.crew || '—')}</b><small>${esc(r.terminal)} · ${fmtTime(r.openAt)}–${r.closeAt ? fmtTime(r.closeAt) : 'sekarang'}</small></span>
        <span class="rep-r"><b>${rp(r.total)}</b><small>${num(r.count)} transaksi${r.refunds ? ` · ${r.refunds} refund` : ''}</small></span>
        ${r.closeAt ? `<span class="badge ${bad ? 'b-err' : 'b-mute'}">Selisih ${rp(v || 0)}</span>` : '<span class="badge b-ok">Aktif</span>'}${ic(open ? 'chevron-up' : 'chevron-down', 16)}</button>
      ${open ? `<div class="rep-b"><dl class="kv rep-d"><dt>Dibuka</dt><dd>${fmtDate(r.openAt)} ${fmtTime(r.openAt)}</dd>${r.closeAt ? `<dt>Ditutup</dt><dd>${fmtDate(r.closeAt)} ${fmtTime(r.closeAt)}</dd>` : ''}
        <dt>Modal awal</dt><dd>${rp(r.open_cash)}</dd>
        ${by.map(([m, a]) => `<dt>${esc(D.PAY[m]?.label || m)}</dt><dd>${rp(a)}</dd>`).join('') || '<dt>Pembayaran</dt><dd>—</dd>'}
        ${Number(r.disc) ? `<dt>Diskon</dt><dd>${rp(r.disc)}</dd>` : ''}${Number(r.top_cash) ? `<dt>Top-up deposit tunai</dt><dd>${rp(r.top_cash)}</dd>` : ''}${Number(r.refund_cash) ? `<dt>Refund saldo deposit</dt><dd>-${rp(r.refund_cash)}</dd>` : ''}
        ${r.refunds ? `<dt>Refund bill (${r.refunds})</dt><dd>${rp(r.refund_total)}${Number(r.refund_bill_cash) ? `<br><small class="muted">tunai dari laci -${rp(r.refund_bill_cash)}</small>` : ''}</dd>` : ''}
        ${r.refunded_later ? `<dt>Bill shift ini yang di-refund</dt><dd>${r.refunded_later} · ${rp(r.refunded_later_total)}</dd>` : ''}
        ${r.voids ? `<dt>Bill batal</dt><dd>${r.voids}</dd>` : ''}${r.no_sale ? `<dt>Buka laci tanpa transaksi</dt><dd>${r.no_sale}×</dd>` : ''}
        <dt>Kas seharusnya</dt><dd><b>${rp(r.expected)}</b></dd>
        ${r.closeAt ? `<dt>Kas dihitung</dt><dd>${rp(r.counted)}</dd><dt>Selisih</dt><dd class="${bad ? 'neg' : ''}"><b>${rp(v || 0)}</b></dd>` : ''}</dl>
        <div class="row sb" style="margin-top:8px;flex-wrap:wrap;gap:6px">
          <button class="btn btn-sm" data-a="shTrx" data-id="${r.id}" data-label="${esc(`${r.terminal} · ${r.crew || ''} · ${fmtDate(r.openAt)}`)}">${ic('list', 15)} Lihat transaksi</button>
          <button class="btn btn-sm" data-a="shItem" data-id="${r.id}">${ic('package', 15)} ${H.items[r.id]?.data ? 'Tutup rekap item' : 'Rekap item'}</button>
          <button class="btn btn-sm btn-ghost" data-a="shPrint" data-id="${r.id}">${ic('printer', 15)} Cetak closing</button>
        </div>
        ${(() => { const si = H.items[r.id]; if (!si) return ''; if (si.loading) return '<p class="muted sm" style="margin-top:8px">Memuat rekap item…</p>'; if (si.err) return `<p class="banner warn sm" style="margin-top:8px">${esc(si.err)}</p>`; if (!si.data) return ''; if (!si.data.length) return '<p class="muted sm" style="margin-top:8px">Belum ada item terjual.</p>'; const cats = new Map(); for (const x of si.data) { const k = x.category || ''; if (!cats.has(k)) cats.set(k, []); cats.get(k).push(x); } return `<div class="sh-items" style="margin-top:8px"><table class="sh-item-tbl"><thead><tr><th>Menu</th><th class="r">Qty</th><th class="r">Total</th></tr></thead><tbody>${[...cats.entries()].map(([cat, xs]) => (cat ? `<tr class="sh-cat"><td colspan="3">${esc(cat)}</td></tr>` : '') + xs.map((x) => `<tr><td>${esc(x.item_name)}</td><td class="r">${num(x.qty)}</td><td class="r">${rp(x.amount)}</td></tr>`).join('')).join('')}</tbody><tfoot><tr><td><b>Total</b></td><td class="r"><b>${si.data.reduce((a, x) => a + Number(x.qty || 0), 0)}</b></td><td class="r"><b>${rp(si.data.reduce((a, x) => a + Number(x.amount || 0), 0))}</b></td></tr></tfoot></table></div>`; })()}
        </div>` : ''}</div>`;
  };
  return `<div class="sh-hist">
    <div class="row sb"><div class="chips">${[7, 14, 30, 45].map((d) => `<button class="chip ${H.days === d ? 'on' : ''}" data-a="shDays" data-v="${d}">${d} hari</button>`).join('')}</div>
      <button class="btn btn-sm btn-ghost" data-a="shReload" title="Muat ulang">${ic('refresh-cw', 15)}</button></div>
    ${H.err ? `<p class="banner warn sm">${esc(H.err)}</p>` : ''}
    ${!list ? '<p class="muted sm">Memuat riwayat shift…</p>' : list.length ? [...days.entries()].map(([d, rs]) => `<div class="rep-day"><div class="rep-dh"><b>${esc(d)}</b><span>${rs.length} shift · ${rs.reduce((a, r) => a + Number(r.count || 0), 0)} transaksi · <b>${rp(rs.reduce((a, r) => a + Number(r.total || 0), 0))}</b></span></div>${rs.map(row).join('')}</div>`).join('') : `<p class="empty sm">Belum ada shift dalam ${H.days} hari terakhir.</p>`}
  </div>`;
}

// Aksi bersama (dipakai di Kaly POS dan halaman Transaksi & shift)
export const actions = {
  txRange(el, e, ctx) { S.range = el.dataset.v; if (S.range === 'custom' && !S.from) { S.from = dayKey(); S.to = dayKey(); } load(ctx); },
  txFrom(el, e, ctx) { S.from = el.value; load(ctx); },
  txTo(el, e, ctx) { S.to = el.value; load(ctx); },
  txStatus(el, e, ctx) { S.status = el.value; load(ctx); },
  txMethod(el, e, ctx) { S.method = el.value; load(ctx); },
  // 2.19 · Unduh laporan per transaksi. Dua file CSV terpisah (nota & rincian item): tiap file
  // diunduh dengan tombolnya sendiri supaya tidak diblokir browser sebagai "unduhan berganda",
  // plus pilihan .zip bila ingin sekali klik.
  async txCsv(el, e, ctx) {
    const f = filterOf(ctx);
    const t0 = el.innerHTML; el.disabled = true; el.innerHTML = 'Menyiapkan…';
    let r;
    try { r = await API.trxExport(f); } catch (err) {
      return toast(/trx_export|schema cache|function/i.test(err.message || '') ? 'Unduhan laporan belum aktif: jalankan update database 2.19 di Supabase.' : err.message, 'err', 8000);
    } finally { el.disabled = false; el.innerHTML = t0; }
    const bills = r.bills || [], items = r.items || [];
    if (!bills.length) return toast('Tidak ada transaksi untuk filter ini', 'warn');
    const loc = ctx.db.locations.find((l) => l.id === f.loc)?.name || f.loc;
    const tag = f.from === f.to ? f.from : `${f.from}_sd_${f.to}`;
    const dt = (x) => (x ? fmtDT(Date.parse(x)) : '');
    const stLabel = (x) => ({ paid: 'Lunas', refund: 'Refund', void: 'Batal' }[x] || x);
    const billRows = [
      ['No nota', 'Hari transaksi', 'Dibuka', 'Waktu bayar', 'Status', 'Outlet', 'Channel', 'Tipe', 'Meja', 'Terminal', 'Petugas', 'Shift',
        'Nama tamu', 'Member', 'HP member', 'Jumlah item', 'Subtotal', 'Diskon', 'Rincian diskon', 'Service', 'PB1', 'Ongkir', 'Total',
        'Pembayaran', 'Kembalian', 'Poin didapat', 'Jumlah cetak', 'Refund pada', 'Refund oleh', 'Alasan refund', 'Alasan batal', 'Dibatalkan oleh'],
      ...bills.map((b) => [b.no, b.day, dt(b.opened_at), dt(b.paid_at), stLabel(b.status),
        loc, D.CH_LABEL?.[b.channel] || b.channel, D.TYPE_LABEL?.[b.type] || b.type, b.table || '', b.terminal || '', b.cashier || '', b.shift || '',
        b.customer || '', b.member || '', b.member_phone || '', b.items, b.sub, b.disc, b.disc_labels || '', b.svc, b.tax, b.deliv, b.total,
        b.pays || '', b.change, b.points, b.prints, dt(b.refund_at), b.refund_by || '', b.refund_reason || '', b.void_reason || '', b.void_by || '']),
    ];
    const itemRows = [
      ['No nota', 'Hari transaksi', 'Waktu bayar', 'Status nota', 'Meja', 'Menu', 'Kategori', 'Stasiun', 'Jumlah', 'Harga satuan', 'Jumlah harga', 'Catatan', 'Status item', 'Alasan batal item'],
      ...items.map((x) => [x.no, x.day, dt(x.paid_at), stLabel(x.status), x.table || '',
        x.menu, x.category || '', x.station || '', x.qty, x.price, x.amount, x.note || '', x.line_status || '', x.void_reason || '']),
    ];
    const fn1 = `transaksi-nota-${tag}.csv`, fn2 = `transaksi-rincian-item-${tag}.csv`;
    openModal({ title: 'Laporan siap diunduh', size: 'sm',
      body: `<p class="muted sm">${esc(loc)} · ${f.from === f.to ? fmtDate(Date.parse(f.from)) : `${fmtDate(Date.parse(f.from))} s/d ${fmtDate(Date.parse(f.to))}`}${f.status ? ` · ${stLabel(f.status)}` : ''}${f.q ? ` · cari "${esc(f.q)}"` : ''}</p>
        <div class="dl-list">
          <div class="dl-row"><span><b>Ringkasan per nota</b><small>${num(bills.length)} nota · ${num(billRows[0].length)} kolom</small></span><button class="btn btn-pri btn-sm" data-dl="1">${ic('download', 15)} CSV</button></div>
          <div class="dl-row"><span><b>Rincian item per nota</b><small>${num(items.length)} baris item</small></span><button class="btn btn-pri btn-sm" data-dl="2">${ic('download', 15)} CSV</button></div>
        </div>
        ${r.capped ? `<p class="banner warn sm">${ic('triangle-alert', 16)}<span>Hanya ${num(r.cap)} nota terbaru yang ikut. Persempit rentang tanggalnya supaya lengkap.</span></p>` : ''}
        <p class="hint">Keduanya langsung terbuka di Excel. Nomor nota di file rincian item bisa dipakai untuk VLOOKUP ke file ringkasan.</p>`,
      footer: `<button class="btn" data-close>Tutup</button><button class="btn" data-zip>${ic('download', 15)} Kedua file (.zip)</button>`,
      onMount(m) {
        m.querySelector('[data-dl="1"]').onclick = () => { downloadCSV(fn1, billRows); toast(`${num(bills.length)} nota diunduh`); };
        m.querySelector('[data-dl="2"]').onclick = () => { downloadCSV(fn2, itemRows); toast(`${num(items.length)} baris item diunduh`); };
        m.querySelector('[data-zip]').onclick = async () => {
          const { writeZip } = await import('../xlsx.js');
          const { downloadBlob, csvText } = await import('../lib.js');
          downloadBlob(`laporan-transaksi-${tag}.zip`, writeZip([[fn1, '\ufeff' + csvText(billRows)], [fn2, '\ufeff' + csvText(itemRows)]]));
          toast('Dua file CSV diunduh dalam satu .zip');
        };
      } });
  },
  async txPrintBills(el, e, ctx) {
    const t0 = el.innerHTML; el.disabled = true; el.innerHTML = 'Menyiapkan…';
    try {
      const f = filterOf(ctx);
      const r = await API.trxExport(f);
      const bills = r.bills || [];
      if (!bills.length) return toast('Tidak ada transaksi untuk filter ini', 'warn');
      const locName = D.loc(ctx.db, ctx.outlet)?.name || '';
      const html = printTrxBillsHtml(bills, f, locName);
      const w = window.open('', '_blank', 'width=420,height=700');
      if (w) { w.document.write(html); w.document.close(); }
      else toast('Pop-up diblokir browser. Izinkan pop-up untuk halaman ini.', 'warn', 6000);
    } catch (err) { toast(err.message, 'err', 5000); }
    finally { el.disabled = false; el.innerHTML = t0; }
  },
  async txPrintItems(el, e, ctx) {
    const t0 = el.innerHTML; el.disabled = true; el.innerHTML = 'Menyiapkan…';
    try {
      const f = filterOf(ctx);
      const r = await API.trxExport(f);
      const items = r.items || [];
      if (!items.length) return toast('Tidak ada item untuk filter ini', 'warn');
      const locName = D.loc(ctx.db, ctx.outlet)?.name || '';
      const html = printTrxItemsHtml(items, f, locName);
      const w = window.open('', '_blank', 'width=420,height=700');
      if (w) { w.document.write(html); w.document.close(); }
      else toast('Pop-up diblokir browser. Izinkan pop-up untuk halaman ini.', 'warn', 6000);
    } catch (err) { toast(err.message, 'err', 5000); }
    finally { el.disabled = false; el.innerHTML = t0; }
  },
  txReload(el, e, ctx) { load(ctx); },
  txMore(el, e, ctx) { load(ctx, true); },
  txShiftX(el, e, ctx) { S.shift = null; S.shiftLabel = ''; load(ctx); },
  txOpen(el, e, ctx) { openTrx(ctx, el.dataset.id); },
  shTg(el) {
    const id = el.dataset.id;
    H.open = H.open === id ? null : id;
    // Auto-load items when expanding a closed shift
    if (H.open === id) loadShiftItems(id);
    rerender();
  },
  shDays(el) { H.days = Number(el.dataset.v); H.open = null; rerender(); },
  shReload(el, e, ctx) { loadShifts(ctx, true); },
  shTrx(el) { showShift(el.dataset.id, el.dataset.label); rerender(); },
  shItem(el) {
    const id = el.dataset.id;
    const si = H.items[id];
    if (si?.data) { delete H.items[id]; rerender(); } else { loadShiftItems(id); rerender(); }
  },
  shPrint(el, e, ctx) {
    const id = el.dataset.id;
    const r = (H.list || []).find((x) => x.id === id);
    if (!r) return toast('Data shift tidak ditemukan', 'warn');
    const db = ctx.db;
    const si = H.items[id];
    const doOpen = (items) => {
      const html = printShiftHtml(r, items, db, ctx.outlet);
      const w = window.open('', '_blank', 'width=400,height=600');
      if (w) { w.document.write(html); w.document.close(); }
      else { toast('Pop-up diblokir browser. Izinkan pop-up untuk halaman ini.', 'warn', 6000); }
    };
    if (si?.data) { doOpen(si.data); return; }
    // Load items then print
    el.disabled = true;
    API.shiftItemReport(id).then((rows) => {
      H.items[id] = { data: rows || [], loading: false, err: '' };
      doOpen(rows || []);
    }).catch((e) => toast(e.message, 'err', 5000)).finally(() => { el.disabled = false; });
  },
};
export function input(k, el, ctx) {
  if (k !== 'txQ') return false;
  S.q = el.value;
  clearTimeout(S.qt); S.qt = setTimeout(() => load(ctxFresh(ctx)), 350);
  return true;
}

// ---------- Halaman Kaly Backoffice: Transaksi & shift ----------
export default {
  title: () => 'Transaksi & shift',
  render(ctx) {
    const L = D.loc(ctx.db, ctx.outlet)?.name || '';
    return `<div class="tx-page">
      <div class="tabs" role="tablist">${[['trx', 'Transaksi', 'receipt'], ['shift', 'Riwayat shift', 'clock']].map(([k, l, i]) => `<button class="tab ${V.tab === k ? 'on' : ''}" role="tab" aria-selected="${V.tab === k}" data-a="txTab" data-v="${k}">${ic(i, 16)} ${l}</button>`).join('')}<span class="muted sm tx-loc">${ic('map-pin', 14)} ${esc(L)}</span></div>
      <section class="card">${V.tab === 'trx' ? trxPanel(ctx) : shiftHistoryPanel(ctx)}</section></div>`;
  },
  input(k, el, e, ctx) { input(k, el, ctx); },
  actions: { ...actions, txTab(el) { V.tab = el.dataset.v; rerender(); } },
};

// ---------- 2.21 · Refund per item dalam satu nota (khusus Owner) ----------
// Sisa item yang bisa di-refund = qty pesanan dikurangi yang sudah di-refund pada item itu
const refundedQty = (o, lineId) => (o.refunds || []).filter((x) => x.line === lineId).reduce((a, x) => a + x.qty, 0);
function partialRefund(db, o) {
  const rs = o.refunds || [];
  if (!rs.length) return '';
  const byB = {};
  rs.forEach((x) => { (byB[x.batch] ||= []).push(x); });
  return `<div class="tx-refund"><h4>${ic('rotate-ccw', 16)} Refund per item</h4>${Object.values(byB).map((g) => `<dl class="kv">
    <dt>${fmtDate(g[0].at)} ${fmtTime(g[0].at)} · ${esc(D.userName(db, g[0].by))}</dt>
    <dd>${esc(g.map((x) => `${x.qty}× ${x.name}`).join(', '))} · <b>${rp(g.reduce((a, x) => a + x.amt, 0))}</b><br>
    <small class="muted">${esc(D.PAY[g[0].m]?.label || g[0].m)}${g[0].m === 'cash' && g[0].shift ? ' dari laci kasir' : ''} · ${esc(g[0].reason)}</small></dd></dl>`).join('')}</div>`;
}
async function refundItemDialog(ctx, o) {
  try { await C.refresh('shifts'); } catch {}
  const db = getDb();
  const left = o.lines.filter((l) => !l.par && l.s !== 'void').map((l) => ({ l, left: l.q - refundedQty(o, l.id) })).filter((x) => x.left > 0);
  if (!left.length) return toast('Semua item di bill ini sudah di-refund', 'warn');
  const open = db.shifts.filter((s) => !s.closeAt && s.loc === o.loc).sort((a, b) => a.term.localeCompare(b.term));
  const cards = o.pays.filter((p) => p.m === 'deposit' && p.card);
  const methods = [...new Set(['cash', 'qris', 'card', 'transfer', ...(cards.length ? ['deposit'] : [])])];
  openModal({
    title: `Refund per item · ${o.no}`, size: 'md',
    body: `<p class="banner warn sm">${ic('triangle-alert', 17)}<span>Bill tetap lunas dengan total bersih. Jumlah yang dikembalikan dihitung dari harga item setelah diskon dan pajak, dan jurnal penjualan dibalik sebagian. Refund tidak bisa dibatalkan.</span></p>
      <div class="rf-list">${left.map(({ l, left: n }) => `<div class="rf-p"><span><b>${esc(l.n)}</b><small>sisa ${n}× · ${rp(l.p)}</small></span><input type="number" class="inp inp-sm" min="0" max="${n}" step="1" value="0" data-rq="${l.id}" aria-label="Jumlah refund ${esc(l.n)}" style="width:80px"></div>`).join('')}</div>
      <label class="fld"><span>Dikembalikan lewat</span><select name="method">${methods.map((m) => `<option value="${m}">${esc(D.PAY[m]?.label || m)}</option>`).join('')}</select></label>
      <label class="fld" data-wrap="deposit" hidden><span>Kartu deposit</span><select name="card">${cards.map((p) => `<option value="${esc(p.card)}">${esc(p.card)}</option>`).join('')}</select></label>
      <label class="fld" data-wrap="cash"><span>Uang tunai diambil dari</span><select name="shift">
          ${open.map((s, i) => `<option value="${s.id}" ${i === 0 ? 'selected' : ''}>Laci ${esc(s.term)} · ${esc(D.shiftName(db, s))}</option>`).join('')}
          <option value="">Kas outlet, di luar laci kasir</option></select></label>
      <label class="fld"><span>Alasan refund</span><textarea name="reason" rows="2" maxlength="300" placeholder="Contoh: porsi kurang, salah pesan, barang rusak" required></textarea></label>`,
    footer: `<button class="btn" data-close>Batal</button><button class="btn btn-danger" data-ok>${ic('rotate-ccw', 16)} Refund item terpilih</button>`,
    onMount(m, api) {
      const sync = () => {
        const method = m.querySelector('[name=method]').value;
        m.querySelectorAll('[data-wrap]').forEach((w) => { w.hidden = w.dataset.wrap !== method; });
      };
      m.querySelector('[name=method]').addEventListener('change', sync); sync();
      m.querySelector('[data-ok]').onclick = async (e) => {
        const items = [];
        for (const { l, left: n } of left) {
          const q = Number(m.querySelector(`[data-rq="${l.id}"]`).value) || 0;
          if (q < 0 || q > n || !Number.isInteger(q)) return toast(`Jumlah refund ${l.n} harus bilangan bulat 0 sampai ${n}`, 'warn');
          if (q > 0) items.push({ line: l.id, qty: q });
        }
        if (!items.length) return toast('Pilih minimal satu item dan jumlahnya', 'warn');
        const reason = m.querySelector('[name=reason]').value.trim();
        if (!reason) return toast('Tulis alasan refund', 'warn');
        const method = m.querySelector('[name=method]').value;
        const card = method === 'deposit' ? m.querySelector('[name=card]').value : null;
        const shift = method === 'cash' ? (m.querySelector('[name=shift]').value || null) : null;
        e.currentTarget.disabled = true;
        try {
          const res = await API.orderRefundItems(o.id, items, reason, method, card, shift);
          api.close();
          toast(`Refund ${rp(res.amount)} dicatat untuk ${res.no}${res.cash ? (res.shift ? ' · tunai dari laci ' + (res.terminal || 'kasir') : ' · tunai dari kas outlet') : ''}`, 'ok', 6000);
          C.refreshOrder(o.id).catch(() => {});
          C.refresh('shifts').catch(() => {});
          H.key = ''; reloadTrx(ctx);
          openTrx(ctx, o.id);
        } catch (err) { toast(err.message, 'err', 6000); e.currentTarget.disabled = false; }
      };
    },
  });
}
