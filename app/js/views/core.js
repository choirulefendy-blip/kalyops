// Kaly Core — ERP: dashboard real-time, resep, produksi, stok, mutasi, opname, keuangan, B2B, fraud
import * as API from '../api.js';
import * as C from '../cloud.js';
import { esc, ic, rp, num, pct, toast, barChart, hbars, startOfDay, DAY, sum, fmtTime, fmtDT, fmtShort, hariNama } from '../lib.js';
import * as D from '../domain.js';
import { rerender } from '../app.js';
import * as Stock from './core-stock.js';
import * as Fin from './core-fin.js';

const ui = { tab: null, dashLoc: 'all', flagSev: 'all', flagSt: 'open' };
const TABS = [
  ['dash', 'Dashboard', ['owner']], ['resep', 'Menu & resep', ['owner', 'gudang']], ['produksi', 'Produksi', ['owner', 'gudang']], ['stok', 'Stok', ['owner', 'gudang']],
  ['mutasi', 'Mutasi', ['owner', 'gudang']], ['opname', 'Stock opname', ['owner', 'gudang']], ['keuangan', 'Laporan', ['owner']], ['b2b', 'B2B antar entitas', ['owner']], ['fraud', 'Deteksi fraud', ['owner']],
];

function dashboard(ctx) {
  const db = ctx.db, now = Date.now(), t0 = startOfDay();
  const inLoc = (o) => ui.dashLoc === 'all' || o.loc === ui.dashLoc;
  const paid = db.orders.filter((o) => o.status === 'paid' && inLoc(o));
  const today = paid.filter((o) => o.created >= t0);
  const lastWk = paid.filter((o) => o.created >= t0 - 7 * DAY && o.created <= now - 7 * DAY);
  const sales = D.sumTotals(today), salesLw = D.sumTotals(lastWk);
  const delta = salesLw ? sales / salesLw - 1 : 0;
  const avg = today.length ? sales / today.length : 0;
  const avgLw = lastWk.length ? salesLw / lastWk.length : 0;
  const L1tables = db.tables.filter((t) => t.loc === 'L1');
  const busy = new Set(db.orders.filter((o) => o.status === 'open' && o.loc === 'L1' && o.table).flatMap((o) => [o.table, ...(o.merged || [])]));
  const inK = db.orders.filter((o) => inLoc(o) && o.status !== 'void' && o.created >= t0 && ['new', 'cook'].includes(D.kitchenState(o)));
  const servedToday = today.flatMap((o) => o.lines.filter((l) => l.ts && l.tr && l.st !== 'none'));
  const avgServe = servedToday.length ? sum(servedToday, (l) => (l.tr - l.ts) / 60000) / servedToday.length : 0;
  const cogs = sum(today, (o) => sum(o.lines.filter((l) => !l.pkg && l.s !== 'void'), (l) => l.q * D.menuHpp(db, l.m)));
  const net = sum(today, (o) => o.bill.base);
  const fc = net ? cogs / net : 0;
  const h = new Date().getHours();
  const hrs = Array.from({ length: 12 }, (_, i) => 9 + i);
  const byHour = hrs.map((x) => ({ label: String(x), value: D.sumTotals(today.filter((o) => new Date(o.created).getHours() === x)), tip: `Jam ${x}.00` }));
  const days = Array.from({ length: 28 }, (_, i) => t0 - (27 - i) * DAY);
  const byDay = days.map((d) => ({ label: fmtShort(d).split(' ')[0], value: D.sumTotals(paid.filter((o) => o.created >= d && o.created < d + DAY)), tip: `${hariNama(d)} ${fmtShort(d)}` }));
  const qty = {};
  today.forEach((o) => o.lines.filter((l) => !l.par && l.s !== 'void').forEach((l) => { qty[l.n] = (qty[l.n] || 0) + l.q; }));
  const top = Object.entries(qty).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([label, value]) => ({ label, value }));
  const byCh = Object.entries(D.CH_LABEL).map(([k, label]) => ({ label, value: D.sumTotals(today.filter((o) => o.ch === k)) }));
  const byPay = {};
  today.forEach((o) => o.pays.forEach((p) => { byPay[p.m] = (byPay[p.m] || 0) + p.a; }));
  const byLoc = db.locations.filter((l) => l.type === 'outlet').map((l) => ({ label: l.name, value: D.sumTotals(paid.filter((o) => o.loc === l.id && o.created >= t0)) }));
  const lows = db.locations.flatMap((l) => D.lowStock(db, l.id).map((x) => ({ ...x, loc: l })));
  const flags = db.flags.filter((f) => f.status === 'open').slice(0, 5);
  const feed = db.orders.filter((o) => inLoc(o) && o.created >= t0 && o.status !== 'void').map((o) => ({ o, t: Math.max(o.paidAt || 0, o.readyAt || 0, o.created) })).sort((a, b) => b.t - a.t).slice(0, 8);
  const dl = (v, inv) => `<span class="kpi-d ${v >= 0 !== !!inv ? 'pos' : 'neg'}">${v >= 0 ? '+' : ''}${pct(v)} vs ${hariNama(now)} lalu</span>`;
  return `<div class="row sb wrap"><div class="chips">${[['all', 'Semua outlet'], ...db.locations.filter((l) => l.type === 'outlet').map((l) => [l.id, l.name])].map(([k, l]) => `<button class="chip ${ui.dashLoc === k ? 'on' : ''}" data-a="dashLoc" data-v="${k}">${esc(l)}</button>`).join('')}</div>
      <span class="live"><i></i>Diperbarui otomatis, terakhir ${fmtTime(now)}</span></div>
    <div class="kpis">
      <div class="kpi"><span class="kpi-l">Penjualan hari ini</span><b class="kpi-v">${rp(sales)}</b>${dl(delta)}</div>
      <div class="kpi"><span class="kpi-l">Transaksi</span><b class="kpi-v">${today.length}</b><span class="kpi-d">rata-rata ${rp(avg)}${avgLw ? `, minggu lalu ${rp(avgLw)}` : ''}</span></div>
      <div class="kpi"><span class="kpi-l">Meja terisi</span><b class="kpi-v">${busy.size}<small>/${L1tables.length}</small></b><span class="kpi-d">${db.orders.filter((o) => o.status === 'open').length} bill terbuka</span></div>
      <div class="kpi"><span class="kpi-l">Di dapur sekarang</span><b class="kpi-v">${inK.length}</b><span class="kpi-d">serving time rata-rata ${num(avgServe, 1)} mnt</span></div>
      <div class="kpi"><span class="kpi-l">Food cost teoritis</span><b class="kpi-v ${fc > 0.38 ? 'neg' : ''}">${pct(fc, 1)}</b><span class="kpi-d">HPP resep ${rp(cogs)}</span></div>
    </div>
    <div class="grid2">
      <div class="card"><div class="card-h"><h3>Penjualan per jam, hari ini</h3></div>${barChart(byHour, { height: 180, highlight: h - 9 })}</div>
      <div class="card"><div class="card-h"><h3>Penjualan 28 hari</h3><span class="muted sm">tanggal</span></div>${barChart(byDay, { height: 180, labelEvery: 3, highlight: 27 })}</div>
    </div>
    <div class="grid3">
      <div class="card"><div class="card-h"><h3>Menu terlaris hari ini</h3></div>${hbars(top, { fmt: (v) => num(v) + ' porsi' })}</div>
      <div class="card"><div class="card-h"><h3>Per channel</h3></div>${hbars(byCh)}<div class="card-h mt"><h3>Per outlet</h3></div>${hbars(byLoc)}</div>
      <div class="card"><div class="card-h"><h3>Metode pembayaran</h3></div>${hbars(Object.entries(byPay).map(([k, v]) => ({ label: D.PAY[k].label, value: v })).sort((a, b) => b.value - a.value))}</div>
    </div>
    <div class="grid3">
      <div class="card"><div class="card-h"><h3>Stok di bawah minimum</h3><a class="lnk" href="#/goods">Buat PO</a></div>
        ${lows.length ? `<ul class="list">${lows.slice(0, 8).map((x) => `<li><span>${esc(x.item.name)}<small>${esc(x.loc.name)}</small></span><span class="neg">${num(x.q, 2)} / ${num(x.min, 2)} ${esc(x.item.unit)}</span></li>`).join('')}</ul>` : '<p class="empty sm">Semua stok aman.</p>'}</div>
      <div class="card"><div class="card-h"><h3>Flag fraud terbuka</h3><button class="lnk" data-a="tab" data-v="fraud">Lihat semua</button></div>
        ${flags.length ? `<ul class="list">${flags.map((f) => `<li><span>${esc(f.type)}<small>${esc(f.msg)}</small></span><span class="badge ${f.sev === 'tinggi' ? 'b-err' : f.sev === 'sedang' ? 'b-warn' : 'b-mute'}">${esc(f.sev)}</span></li>`).join('')}</ul>` : '<p class="empty sm">Tidak ada flag terbuka.</p>'}</div>
      <div class="card"><div class="card-h"><h3>Aktivitas terbaru</h3></div>
        <ul class="list feed">${feed.map(({ o, t }) => `<li><span><b>${esc(o.no)}</b> ${o.table ? 'meja ' + esc(o.table) : esc(D.TYPE_LABEL[o.type])} <small>${o.status === 'paid' ? 'dibayar ' + rp(o.bill.total) : D.kitchenState(o) === 'ready' ? 'siap diantar' : 'pesanan masuk'}</small></span><span class="muted sm">${fmtTime(t)}</span></li>`).join('')}</ul></div>
    </div>`;
}

function fraud(ctx) {
  const db = ctx.db;
  const fs = db.flags.filter((f) => (ui.flagSev === 'all' || f.sev === ui.flagSev) && (ui.flagSt === 'all' || f.status === ui.flagSt));
  const byUser = {};
  db.flags.filter((f) => Date.now() - f.at < 30 * DAY).forEach((f) => { const u = (byUser[f.user] ||= { t: 0, s: 0, r: 0 }); if (f.sev === 'tinggi') u.t++; else if (f.sev === 'sedang') u.s++; else u.r++; });
  const rules = [
    ['Void item setelah dikirim ke dapur', 'Wajib alasan, nilai bahan dicatat sebagai waste'],
    ['Void bill yang sudah diproses dapur', 'Wajib PIN manajer, severity tinggi'],
    ['Pola void berulang', '3 pembatalan atau lebih oleh kasir yang sama dalam 8 jam'],
    [`Diskon manual di atas ${Math.round(db.settings.discApproval * 100)}%`, 'Wajib PIN manajer dan alasan'],
    [`Selisih kas tutup shift di atas ${rp(db.settings.cashVarTol)}`, 'Hitung fisik tanpa melihat angka sistem'],
    ['Buka laci tanpa transaksi', 'Wajib alasan, dihitung per shift'],
    ['Cetak ulang struk', 'Struk cetak ulang diberi tanda CETAK ULANG'],
    ['Pembayaran tanpa shift aktif', 'Diblokir, kasir harus buka shift'],
    [`PO di atas harga acuan lebih dari ${Math.round(db.settings.poPriceTol * 100)}%`, 'Ditandai di Kaly Goods, approval oleh orang berbeda'],
    ['Penerimaan barang tidak sesuai PO', 'Selisih ditandai, pembayaran hanya sejumlah barang diterima'],
  ];
  return `<div class="grid-side">
    <div>
      <div class="row wrap"><div class="chips">${[['all', 'Semua'], ['tinggi', 'Tinggi'], ['sedang', 'Sedang'], ['rendah', 'Rendah']].map(([k, l]) => `<button class="chip ${ui.flagSev === k ? 'on' : ''}" data-a="flagSev" data-v="${k}">${l}</button>`).join('')}</div>
        <div class="chips">${[['open', 'Belum dicek'], ['ok', 'Sudah dicek'], ['all', 'Semua status']].map(([k, l]) => `<button class="chip ${ui.flagSt === k ? 'on' : ''}" data-a="flagSt" data-v="${k}">${l}</button>`).join('')}</div></div>
      <div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Waktu</th><th>Jenis</th><th>Detail</th><th>Oleh</th><th>Tingkat</th><th></th></tr></thead><tbody>
        ${fs.map((f) => `<tr><td class="nowrap">${fmtDT(f.at)}</td><td>${esc(f.type)}</td><td>${esc(f.msg)}</td><td>${esc(D.userName(db, f.user))}</td><td><span class="badge ${f.sev === 'tinggi' ? 'b-err' : f.sev === 'sedang' ? 'b-warn' : 'b-mute'}">${esc(f.sev)}</span></td><td>${f.status === 'open' ? `<button class="btn btn-sm" data-a="flagOk" data-id="${f.id}">Sudah dicek</button>` : '<span class="muted sm">Dicek</span>'}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Tidak ada flag untuk filter ini.</td></tr>'}
      </tbody></table></div></div>
    </div>
    <aside>
      <div class="card"><div class="card-h"><h3>Per staf, 30 hari</h3></div><ul class="list">${Object.entries(byUser).sort((a, b) => b[1].t * 3 + b[1].s - (a[1].t * 3 + a[1].s)).map(([u, x]) => `<li><span>${esc(D.userName(db, u))}</span><span><span class="badge b-err">${x.t}</span> <span class="badge b-warn">${x.s}</span> <span class="badge b-mute">${x.r}</span></span></li>`).join('')}</ul><p class="hint">Jumlah flag tinggi, sedang, rendah.</p></div>
      <div class="card"><div class="card-h"><h3>Aturan yang aktif</h3></div><ul class="rules">${rules.map(([a, b]) => `<li><b>${esc(a)}</b><small>${esc(b)}</small></li>`).join('')}</ul></div>
    </aside></div>`;
}

export default {
  render(ctx) {
    const tabs = TABS.filter((t) => t[2].includes(ctx.user.role));
    // Tautan #/core?tab=… (mis. dari notifikasi) membuka tab itu, juga bila Kaly Core sudah terbuka di tab lain
    if (ctx.q.tab && ctx.q !== ui.q && tabs.find((t) => t[0] === ctx.q.tab)) ui.tab = ctx.q.tab;
    ui.q = ctx.q;
    if (!ui.tab || !tabs.find((t) => t[0] === ui.tab)) ui.tab = tabs[0][0];
    let body;
    if (ui.tab === 'dash') body = dashboard(ctx);
    else if (ui.tab === 'fraud') body = fraud(ctx);
    else if (['keuangan', 'b2b'].includes(ui.tab)) body = Fin.render(ui.tab, ctx);
    else body = Stock.render(ui.tab, ctx);
    return `<div class="tabs scroll">${tabs.map(([k, l]) => `<button class="tab ${ui.tab === k ? 'on' : ''}" data-a="tab" data-v="${k}">${l}</button>`).join('')}</div><div class="tabbody">${body}</div>`;
  },
  input(k, el, e, ctx) { Stock.input?.(k, el, e, ctx); Fin.input?.(k, el, e, ctx); },
  actions: {
    tab(el) { ui.tab = el.dataset.v; rerender(); },
    dashLoc(el) { ui.dashLoc = el.dataset.v; rerender(); },
    flagSev(el) { ui.flagSev = el.dataset.v; rerender(); },
    flagSt(el) { ui.flagSt = el.dataset.v; rerender(); },
    async flagOk(el, e, ctx) { await API.flagChecked(el.dataset.id, ctx.user.id); await C.refresh('flags'); toast('Flag ditandai sudah dicek'); rerender(); },
    ...Stock.actions,
    ...Fin.actions,
  },
};
