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
import { sendPrints } from '../printing.js';

const ST = { paid: ['Lunas', 'b-ok'], refund: ['Refund', 'b-err'], void: ['Batal', 'b-mute'] };
const PAGE = 60;
const S = { range: 'today', from: '', to: '', shift: null, shiftLabel: '', q: '', status: '', method: '', rows: [], sum: null, more: false, loading: false, key: '', err: '', min: null };
const H = { days: 7, list: null, err: '', key: '', open: null, loading: false };
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
        ${owner ? `<button class="btn btn-sm" data-a="txCsv" title="Unduh laporan per transaksi (CSV)">${ic('download', 15)} Unduh laporan</button>` : ''}
      </div></div>
    ${!owner ? `<p class="muted sm tx-help">Ketuk transaksi untuk melihat rincian & struk, atau mencetak ulang nota. Refund hanya bisa dilakukan Owner/Manajer di Kaly Backoffice.</p>`
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
        <button class="btn btn-sm" data-a="shTrx" data-id="${r.id}" data-label="${esc(`${r.terminal} · ${r.crew || ''} · ${fmtDate(r.openAt)}`)}">${ic('list', 15)} Lihat transaksi shift ini</button></div>` : ''}</div>`;
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
  txReload(el, e, ctx) { load(ctx); },
  txMore(el, e, ctx) { load(ctx, true); },
  txShiftX(el, e, ctx) { S.shift = null; S.shiftLabel = ''; load(ctx); },
  txOpen(el, e, ctx) { openTrx(ctx, el.dataset.id); },
  shTg(el) { H.open = H.open === el.dataset.id ? null : el.dataset.id; rerender(); },
  shDays(el) { H.days = Number(el.dataset.v); H.open = null; rerender(); },
  shReload(el, e, ctx) { loadShifts(ctx, true); },
  shTrx(el) { showShift(el.dataset.id, el.dataset.label); rerender(); },
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
