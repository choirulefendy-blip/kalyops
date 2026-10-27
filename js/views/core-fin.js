// Kaly Core: Laporan — keuangan (laba rugi, neraca, arus kas, penjualan, jurnal), laporan operasional 1.4
// (nota & jam, kategori & jam, aktivitas meja) dengan grafik di setiap laporan, & B2B antar entitas
import { getDb } from '../store.js';
import * as API from '../api.js';
import * as C from '../cloud.js';
import { esc, ic, rp, num, pct, toast, openModal, formData, sum, fmtDT, fmtDate, fmtShort, uid, dayKey, fromKey, hariNama, downloadCSV, confirmBox, startOfDay, DAY } from '../lib.js';
import * as D from '../domain.js';
import { rerender } from '../app.js';
import { columns, lines, hbar, waterfall, stack100, colorMap, compact, PAL, OTHER, POS, NEG, ONE } from '../charts.js';
import * as R from './core-reports.js';

const ui = { ent: 'e1', per: 'month', from: '', to: '', sub: 'pl', loc: 'all', tloc: null };
const ents = () => (ui.ent === 'all' ? ['e1', 'e2'] : [ui.ent]);
const accName = (db, c) => db.accounts.find((a) => a.code === c)?.name || c;
const SUBS = [['pl', 'Laba rugi'], ['bs', 'Neraca'], ['cf', 'Arus kas'], ['sales', 'Penjualan'], ['nota', 'Nota & jam'], ['kat', 'Kategori & jam'], ['meja', 'Aktivitas meja'], ['jr', 'Jurnal']];
const OUTLET_SUBS = ['sales', 'nota', 'kat'];
const salesLocs = (db) => db.locations.filter((l) => ents().includes(l.entity) && l.type !== 'gudang').map((l) => l.id);
const tableLocs = (db) => db.locations.filter((l) => ents().includes(l.entity) && db.tables.some((t) => t.loc === l.id)).map((l) => l.id);
const card = (title, body, { sub = '', right = '', cls = '' } = {}) => `<div class="card ${cls}"><div class="card-h"><h3>${esc(title)}</h3>${right}</div>${sub ? `<p class="rp-sub">${sub}</p>` : ''}${body}</div>`;
const nDays = (from, to) => Math.max(1, Math.round((startOfDay(Math.min(to, Date.now())) - startOfDay(from)) / DAY) + 1);
const dayStarts = (from, to) => Array.from({ length: nDays(from, to) }, (_, i) => startOfDay(from) + i * DAY);

function controls(db) {
  const locs = OUTLET_SUBS.includes(ui.sub) ? salesLocs(db) : ui.sub === 'meja' ? tableLocs(db) : [];
  const locChips = ui.sub === 'meja'
    ? (locs.length > 1 ? `<div class="chips">${locs.map((l) => `<button class="chip ${(ui.tloc || locs[0]) === l ? 'on' : ''}" data-a="finTLoc" data-v="${l}">${esc(D.loc(db, l).name)}</button>`).join('')}</div>` : '')
    : locs.length > 1 ? `<div class="chips">${[['all', 'Semua outlet'], ...locs.map((l) => [l, D.loc(db, l).name])].map(([k, l]) => `<button class="chip ${ui.loc === k ? 'on' : ''}" data-a="finLoc" data-v="${k}">${esc(l)}</button>`).join('')}</div>` : '';
  return `<div class="fin-ctl">
    <div class="chips">${[...db.entities.map((e) => [e.id, e.short]), ['all', 'Konsolidasi grup']].map(([k, l]) => `<button class="chip ${ui.ent === k ? 'on' : ''}" data-a="finEnt" data-v="${k}">${esc(l)}</button>`).join('')}</div>
    <div class="chips">${D.PERIODS.map(([k, l]) => `<button class="chip ${ui.per === k ? 'on' : ''}" data-a="finPer" data-v="${k}">${l}</button>`).join('')}</div>
    ${ui.per === 'custom' ? `<div class="row"><input type="date" class="inp" data-a-change="finFrom" value="${ui.from}" aria-label="Dari tanggal"><span>sampai</span><input type="date" class="inp" data-a-change="finTo" value="${ui.to}" aria-label="Sampai tanggal"></div>` : ''}
    ${locChips}
  </div>`;
}
function stmt(rows) {
  return `<table class="stmt">${rows.map((r) => r.h ? `<tr class="st-h"><td colspan="3">${esc(r.h)}</td></tr>` : `<tr class="${r.cls || ''}"><td class="${r.ind ? 'ind' : ''}">${esc(r.l)}</td><td class="r ${r.v < 0 ? 'neg' : ''}">${r.v === undefined ? '' : rp(r.v)}</td><td class="r muted">${r.p === undefined ? '' : pct(r.p, 1)}</td></tr>`).join('')}</table>`;
}

// ---------- Ringkasan jurnal per hari (untuk grafik tren) ----------
function dailyBalances(db, from, to) {
  const days = dayStarts(from, to), idx = new Map(days.map((d, i) => [d, i]));
  const out = days.map(() => ({}));
  for (const j of db.journals) {
    if (!ents().includes(j.e) || j.d < from - DAY || j.d > to) continue;
    const i = idx.get(startOfDay(j.d)); if (i === undefined) continue;
    for (const [a, dr, cr] of j.l) out[i][a] = (out[i][a] || 0) + dr - cr;
  }
  if (ents().length > 1) out.forEach((b) => { const ic2 = -(b['4102'] || 0); if (ic2) { b['4102'] = 0; b['5101'] = (b['5101'] || 0) - ic2; } });
  return { days, out };
}
function plOf(db, b) {
  const a = (c) => b[c] || 0;
  const net = -a('4101') - a('4102') - a('4103') - a('4201');
  const cogs = a('5101'), te = sum(db.accounts.filter((x) => x.type === 'expense'), (x) => a(x.code));
  return { net, cogs, gross: net - cogs, te, np: net - cogs - te };
}

function pl(db, from, to) {
  const b = D.balances(db, ents(), from, to);
  const a = (c) => b[c] || 0;
  const rev = -a('4101'), icRev = -a('4102'), oth = -a('4103'), disc = a('4201');
  const net = rev + icRev + oth - disc, cogs = a('5101'), gross = net - cogs;
  const exps = db.accounts.filter((x) => x.type === 'expense').map((x) => ({ l: x.name, v: a(x.code) })).filter((x) => x.v);
  const te = sum(exps, (x) => x.v), np = gross - te;
  const P = (v) => (net ? v / net : 0);
  const wf = waterfall([{ label: 'Pendapatan bersih', value: net, kind: 'total' }, { label: 'HPP', value: cogs, kind: 'minus' }, { label: 'Laba kotor', value: gross, kind: 'total' },
    { label: 'Beban operasional', value: te, kind: 'minus' }, { label: 'Laba bersih', value: np, kind: 'total' }], { fmt: rp });
  const exPos = exps.filter((x) => x.v > 0), exNeg = exps.filter((x) => x.v < 0);
  const ex = hbar([...exPos].sort((x, y) => y.v - x.v).map((x) => ({ label: x.l, value: x.v, tipLabel: 'Beban' })), { fmt: rp, total: sum(exPos, (x) => x.v), emptyText: 'Belum ada beban tercatat di periode ini' })
    + (exNeg.length ? `<p class="hint">Mengurangi beban (tidak digambar): ${exNeg.map((x) => `${esc(x.l)} ${rp(x.v)}`).join(', ')}.</p>` : '');
  let trend = '';
  if (nDays(from, to) > 1) {
    const { days, out } = dailyBalances(db, from, to);
    const rows = out.map((x) => plOf(db, x));
    trend = card('Tren harian', lines({ x: days.map((d) => fmtShort(d)), series: [{ id: 'net', label: 'Pendapatan bersih', color: PAL[0], values: rows.map((r) => r.net) }, { id: 'np', label: 'Laba bersih', color: PAL[1], values: rows.map((r) => r.np) }],
      fmt: rp, height: 210, tipTitle: (i) => `${hariNama(days[i])}, ${fmtShort(days[i])}` }), { cls: 'span2', sub: 'Pendapatan setelah diskon dan laba bersih per hari, dari jurnal otomatis.' });
  }
  return `<div class="rp-grid">${card('Dari pendapatan ke laba', wf, { sub: `Laba bersih ${pct(P(np), 1)} dari pendapatan bersih.` })}${card('Komposisi beban operasional', ex)}${trend}</div>
    ${stmtCard(db, from, to, `${ui.ent === 'all' && b.__elimRev ? `<p class="banner info sm">${ic('info', 16)} Konsolidasi: penjualan antar perusahaan ${rp(b.__elimRev)} dieliminasi bersama HPP-nya. Laba belum terealisasi di persediaan tidak dihitung ulang (penyederhanaan).</p>` : ''}
    ${stmt([{ h: 'Pendapatan' }, { l: 'Penjualan', v: rev, ind: 1 }, ...(icRev ? [{ l: 'Penjualan antar perusahaan', v: icRev, ind: 1 }] : []), { l: 'Pendapatan lain (service & ongkir)', v: oth, ind: 1 }, { l: 'Diskon penjualan', v: -disc, ind: 1 },
      { l: 'Pendapatan bersih', v: net, p: 1, cls: 'tot' }, { l: 'Harga pokok penjualan', v: -cogs, p: P(cogs) }, { l: 'Laba kotor', v: gross, p: P(gross), cls: 'tot' },
      { h: 'Beban operasional' }, ...exps.map((x) => ({ l: x.l, v: -x.v, p: P(x.v), ind: 1 })), { l: 'Total beban', v: -te, p: P(te), cls: 'sub' }, { l: 'Laba bersih', v: np, p: P(np), cls: 'grand' }])}`)}`;
}
function bs(db, to) {
  const b = D.balances(db, ents(), 0, to);
  const a = (c) => b[c] || 0;
  const assets = db.accounts.filter((x) => x.type === 'asset').map((x) => ({ c: x.code, l: x.name, v: a(x.code) })).filter((x) => x.v);
  const liab = db.accounts.filter((x) => x.type === 'liability').map((x) => ({ c: x.code, l: x.name, v: -a(x.code) })).filter((x) => x.v);
  const eq = db.accounts.filter((x) => x.type === 'equity').map((x) => ({ c: x.code, l: x.name, v: -a(x.code) }));
  const earn = -sum(db.accounts.filter((x) => ['revenue', 'contra', 'cogs', 'expense'].includes(x.type)), (x) => a(x.code));
  const ta = sum(assets, (x) => x.v), tl = sum(liab, (x) => x.v), teq = sum(eq, (x) => x.v) + earn;
  const ok = Math.abs(ta - tl - teq) < 2;
  // Warna mengikuti urutan kode akun (tetap), maksimal 6 + Lainnya per batang
  const segs = (list) => {
    const pos = list.filter((x) => x.v > 0), cm = colorMap(pos.map((x) => x.c));
    const head = pos.slice(0, 6).map((x) => ({ label: x.l, value: x.v, color: cm[x.c] }));
    const rest = sum(pos.slice(6), (x) => x.v);
    return rest ? [...head, { label: 'Lainnya', value: rest, color: OTHER }] : head;
  };
  const le = [...liab.map((x) => ({ c: 'L' + x.c, l: x.l, v: x.v })), { c: 'Z1', l: 'Ekuitas (modal)', v: sum(eq, (x) => x.v) }, { c: 'Z2', l: 'Laba berjalan', v: earn }];
  const comp = stack100([{ label: 'Aset', total: ta, segs: segs(assets) }], { fmt: rp }) + stack100([{ label: 'Kewajiban & ekuitas', total: tl + teq, segs: segs(le) }], { fmt: rp });
  const neg = le.filter((x) => x.v < 0);
  return `<div class="rp-grid">${card('Komposisi neraca', comp, { cls: 'span2', sub: `Posisi per ${fmtDate(Math.min(to, Date.now()))}. Setiap batang = 100%. ${neg.length ? `Nilai negatif (${esc(neg.map((x) => x.l).join(', '))}) tidak digambar, tetap ada di tabel.` : ''}` })}</div>
    ${stmtCard(db, 0, to, `<p class="muted">Posisi per ${fmtDate(Math.min(to, Date.now()))}. <span class="badge ${ok ? 'b-ok' : 'b-err'}">${ok ? 'Seimbang' : 'Tidak seimbang'}</span></p>
    <div class="grid2">${stmt([{ h: 'Aset' }, ...assets.map((x) => ({ ...x, ind: 1 })), { l: 'Total aset', v: ta, cls: 'grand' }])}
    ${stmt([{ h: 'Kewajiban' }, ...liab.map((x) => ({ ...x, ind: 1 })), { l: 'Total kewajiban', v: tl, cls: 'sub' }, { h: 'Ekuitas' }, ...eq.map((x) => ({ ...x, ind: 1 })), { l: 'Laba berjalan', v: earn, ind: 1 }, { l: 'Total ekuitas', v: teq, cls: 'sub' }, { l: 'Total kewajiban & ekuitas', v: tl + teq, cls: 'grand' }])}</div>
    ${ui.ent === 'all' && b.__elimAR ? `<p class="hint">Piutang dan hutang antar perusahaan ${rp(b.__elimAR)} dieliminasi.</p>` : ''}`)}`;
}
function cf(db, from, to) {
  const r = D.cashflow(db, ents(), from, to);
  const sec = { ops: [], inv: [], fin: [], other: [] };
  for (const [k, v] of Object.entries(r.groups)) (sec[D.CF_SECTION[k]] || sec.other).push({ l: k, v, ind: 1 });
  const S = (a) => sum(a, (x) => x.v);
  // Kas masuk/keluar & saldo per hari
  const cash = db.accounts.filter((x) => x.cash).map((x) => x.code);
  const days = dayStarts(from, to), idx = new Map(days.map((d, i) => [d, i]));
  const inn = days.map(() => 0), out = days.map(() => 0);
  for (const j of db.journals) {
    if (!ents().includes(j.e) || j.d < from - DAY || j.d > to) continue;
    const i = idx.get(startOfDay(j.d)); if (i === undefined) continue;
    const dlt = sum(j.l.filter((x) => cash.includes(x[0])), (x) => x[1] - x[2]);
    if (ents().length > 1 && j.cf === 'Pembayaran antar perusahaan') continue;
    if (dlt > 0) inn[i] += dlt; else out[i] += dlt;
  }
  let bal = r.open; const close = days.map((_, i) => (bal += inn[i] + out[i]));
  const flows = columns({ x: days.map((d) => fmtShort(d)), series: [{ id: 'in', label: 'Kas masuk', color: POS, values: inn }, { id: 'out', label: 'Kas keluar', color: NEG, values: out }],
    fmt: rp, height: 210, tipTitle: (i) => `${hariNama(days[i])}, ${fmtShort(days[i])}`, tipNote: (i) => `Bersih ${rp(inn[i] + out[i])} · saldo akhir ${rp(close[i])}`, emptyText: 'Belum ada arus kas di periode ini' });
  const saldo = days.length > 1 ? card('Saldo kas & bank akhir hari', lines({ x: days.map((d) => fmtShort(d)), series: [{ id: 'bal', label: 'Saldo', color: ONE, values: close }], fmt: rp, height: 190, area: true, zero: false,
    tipTitle: (i) => `${hariNama(days[i])}, ${fmtShort(days[i])}` }), { sub: `Awal periode ${rp(r.open)}, akhir ${rp(r.close)}.` }) : '';
  const grp = hbar(Object.entries(r.groups).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])).map(([k, v]) => ({ label: k, value: Math.abs(v), color: v >= 0 ? POS : NEG, tipLabel: v >= 0 ? 'Masuk' : 'Keluar', note: v >= 0 ? 'Kas masuk' : 'Kas keluar' })),
    { fmt: rp, emptyText: 'Belum ada arus kas di periode ini' });
  return `<div class="rp-grid">${card('Kas masuk & keluar per hari', flows, { cls: 'span2' })}${card('Per kelompok arus kas', grp + `<p class="hint">Teal = kas masuk, oranye = kas keluar.</p>`)}${saldo}</div>
    ${stmtCard(db, from, to, `${stmt([{ l: 'Kas & bank awal periode', v: r.open, cls: 'sub' }, { h: 'Aktivitas operasional' }, ...sec.ops, { l: 'Arus kas bersih operasional', v: S(sec.ops), cls: 'sub' },
    { h: 'Aktivitas investasi' }, ...(sec.inv.length ? sec.inv : [{ l: 'Tidak ada', v: 0, ind: 1 }]), { h: 'Aktivitas pendanaan' }, ...(sec.fin.length ? sec.fin : [{ l: 'Tidak ada', v: 0, ind: 1 }]),
    ...(sec.other.length ? [{ h: 'Lainnya' }, ...sec.other] : []), { l: 'Kenaikan (penurunan) kas', v: r.close - r.open, cls: 'tot' }, { l: 'Kas & bank akhir periode', v: r.close, cls: 'grand' }])}
    ${ui.ent === 'all' ? '<p class="hint">Pembayaran antar perusahaan saling meniadakan di konsolidasi.</p>' : ''}`)}`;
}
function curLocs(db) { const l = salesLocs(db); return ui.loc !== 'all' && l.includes(ui.loc) ? [ui.loc] : l; }
function salesOrders(db, from, to) {
  const locs = curLocs(db);
  return db.orders.filter((o) => o.status === 'paid' && locs.includes(o.loc) && o.created >= from && o.created <= to);
}
function salesRep(db, from, to) {
  const os = salesOrders(db, from, to);
  if (!os.length) return `<div class="card"><p class="empty">Belum ada penjualan di periode ini untuk entitas ini.</p></div>`;
  const byM = {};
  os.forEach((o) => o.lines.filter((l) => !l.par && l.s !== 'void').forEach((l) => { const x = (byM[l.m] ||= { n: l.n, q: 0, v: 0, h: 0 }); x.q += l.q; x.v += l.q * l.p; x.h += l.q * D.menuHpp(db, l.m); }));
  const ms = Object.values(byM).sort((a, b) => b.v - a.v);
  const grp = (f, lab) => { const g = {}; os.forEach((o) => { const k = f(o); g[k] = (g[k] || 0) + o.bill.total; }); return Object.entries(g).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: lab(k), value: v, tipLabel: 'Penjualan' })); };
  const byPay = {}; os.forEach((o) => o.pays.forEach((p) => { byPay[p.m] = (byPay[p.m] || 0) + p.a; }));
  const tot = D.sumTotals(os);
  const nd = nDays(from, to);
  let trend;
  if (nd > 1) {
    const days = dayStarts(from, to);
    const v = days.map((d) => D.sumTotals(os.filter((o) => o.created >= d && o.created < d + DAY)));
    const n = days.map((d) => os.filter((o) => o.created >= d && o.created < d + DAY).length);
    trend = columns({ x: days.map((d) => fmtShort(d)), series: [{ id: 'v', label: 'Penjualan', color: ONE, values: v }], fmt: rp, height: 210, tipTitle: (i) => `${hariNama(days[i])}, ${fmtShort(days[i])}`, tipNote: (i) => `${num(n[i])} transaksi${n[i] ? ` · rata-rata ${rp(v[i] / n[i])}` : ''}` });
  } else {
    const hs = os.map((o) => new Date(o.created).getHours()), a = Math.min(...hs), z = Math.max(...hs);
    const hrs = Array.from({ length: z - a + 1 }, (_, i) => a + i);
    trend = columns({ x: hrs.map((h) => `${String(h).padStart(2, '0')}.00`), series: [{ id: 'v', label: 'Penjualan', color: ONE, values: hrs.map((h) => D.sumTotals(os.filter((o) => new Date(o.created).getHours() === h))) }], fmt: rp, height: 210, tipTitle: (i) => `Jam ${String(hrs[i]).padStart(2, '0')}.00` });
  }
  const wrapS = (body) => `<div class="tbl-wrap rp-scroll">${body}</div>`;
  return `<div class="kpis"><div class="kpi"><span class="kpi-l">Penjualan (incl. pajak)</span><b class="kpi-v">${rp(tot)}</b></div><div class="kpi"><span class="kpi-l">Transaksi</span><b class="kpi-v">${num(os.length)}</b></div><div class="kpi"><span class="kpi-l">Rata-rata</span><b class="kpi-v">${rp(tot / os.length)}</b></div><div class="kpi"><span class="kpi-l">Diskon diberikan</span><b class="kpi-v">${rp(sum(os, (o) => o.bill.disc))}</b></div></div>
    <div class="rp-grid">${card(nd > 1 ? 'Penjualan per hari' : 'Penjualan per jam', trend, { cls: 'span2', sub: nd > 1 ? '' : 'Berdasarkan jam bill dibuka. Untuk jam bayar & rincian per nota, buka laporan Nota & jam.' })}
      ${card('10 menu terlaris', hbar(ms.slice(0, 10).map((x) => ({ label: x.n, value: x.v, tipLabel: 'Penjualan', note: `${num(x.q)} porsi · margin ${pct(x.v ? (x.v - x.h) / x.v : 0)}` })), { fmt: rp }))}
      ${card('Per metode bayar', hbar(Object.entries(byPay).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: D.PAY[k].label, value: v, tipLabel: 'Diterima' })), { fmt: rp, total: sum(Object.values(byPay)) }))}
      ${card('Per channel', hbar(grp((o) => o.ch, (k) => D.CH_LABEL[k]), { fmt: rp, total: tot }))}
      ${card('Per tipe pesanan', hbar(grp((o) => o.type, (k) => D.TYPE_LABEL[k]), { fmt: rp, total: tot }))}
      ${card('Per kasir', hbar(grp((o) => o.paidBy || o.by, (k) => (k === 'online' || k === 'null' ? 'Bayar online' : D.userName(db, k))), { fmt: rp, total: tot }), { cls: 'span2' })}
      ${card('Per menu', wrapS(`<table class="tbl"><thead><tr><th>Menu</th><th class="r">Qty</th><th class="r">Penjualan</th><th class="r">HPP</th><th class="r">Margin</th></tr></thead><tbody>${ms.map((x) => `<tr><td>${esc(x.n)}</td><td class="r">${num(x.q)}</td><td class="r">${rp(x.v)}</td><td class="r">${rp(x.h)}</td><td class="r">${pct(x.v ? (x.v - x.h) / x.v : 0)}</td></tr>`).join('')}</tbody></table>`), { cls: 'span2' })}</div>
    <p class="hint">Data penjualan memakai pesanan yang sedang dimuat aplikasi (35 hari terakhir untuk Owner). Untuk periode lebih lama, gunakan laporan Nota & jam atau Kategori & jam.</p>`;
}
// Rincian jurnal dimuat dari database saat laporan Jurnal dibuka (ringkasan harian dipakai untuk laporan lain)
let jrKey = null;
const periodKey = () => `${ui.per}|${ui.from || ''}|${ui.to || ''}|${dayKey()}`;
function ensureDetail(db, from, to) {
  const k = periodKey();
  if (db.journalDetail && jrKey === k) return db.journalDetail.list;
  if (jrKey !== k || !db.journalDetail) { jrKey = k; db.journalDetail = null; C.loadJournalDetail(from, to).catch((e) => toast(e.message, 'err')); }
  return null;
}
function journal(db, from, to) {
  const list = ensureDetail(db, from, to);
  if (!list) return `<div class="card load-pane"><p>Memuat jurnal…</p></div>`;
  const all = list.filter((j) => ents().includes(j.e) && j.d >= from && j.d <= to);
  const js = all.slice(-150).reverse();
  const days = dayStarts(from, to), idx = new Map(days.map((d, i) => [d, i]));
  const vol = days.map(() => 0), cnt = days.map(() => 0);
  all.forEach((j) => { const i = idx.get(startOfDay(j.d)); if (i !== undefined) { vol[i] += sum(j.l, (x) => x[1]); cnt[i]++; } });
  const chart = days.length > 1 ? card('Nilai jurnal per hari', columns({ x: days.map((d) => fmtShort(d)), series: [{ id: 'd', label: 'Total debit', color: ONE, values: vol }], fmt: rp, height: 170,
    tipTitle: (i) => `${hariNama(days[i])}, ${fmtShort(days[i])}`, tipNote: (i) => `${num(cnt[i])} jurnal` }), { sub: 'Total debit semua jurnal per hari (debit = kredit di setiap jurnal).' }) : '';
  const byMemo = {}; all.forEach((j) => { const k = (j.memo || 'Lainnya').split(/[ :]/)[0]; byMemo[k] = (byMemo[k] || 0) + 1; });
  const kinds = card('Jenis transaksi', hbar(Object.entries(byMemo).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => ({ label: k, value: v, tipLabel: 'Jurnal' })), { fmt: (v) => `${num(v)} jurnal` }), { sub: 'Dikelompokkan dari kata pertama keterangan jurnal.' });
  return `<div class="rp-grid">${chart || ''}${kinds}</div>
    <div class="card"><div class="tbl-wrap"><table class="tbl jr"><thead><tr><th>Tanggal</th><th>Entitas</th><th>Keterangan</th><th>Akun</th><th class="r">Debit</th><th class="r">Kredit</th></tr></thead><tbody>
    ${js.map((j) => j.l.map((x, i) => `<tr class="${i === 0 ? 'jr-first' : ''}">${i === 0 ? `<td rowspan="${j.l.length}" class="nowrap">${fmtDT(j.d)}</td><td rowspan="${j.l.length}">${esc(D.entity(db, j.e).short)}</td><td rowspan="${j.l.length}">${esc(j.memo)}</td>` : ''}<td class="${x[2] ? 'ind' : ''}">${x[0]} ${esc(accName(db, x[0]))}</td><td class="r">${x[1] ? rp(x[1]) : ''}</td><td class="r">${x[2] ? rp(x[2]) : ''}</td></tr>`).join('')).join('') || '<tr><td colspan="6" class="empty">Belum ada jurnal di periode ini.</td></tr>'}
  </tbody></table></div><p class="hint">Menampilkan maksimal 150 jurnal terbaru. Unduh CSV untuk semua jurnal periode ini.</p></div>`;
}
function stmtCard(db, from, to, body) {
  const sub = SUBS.find((s) => s[0] === ui.sub)[1];
  return `<div class="card fin-body"><div class="card-h"><h3>${esc(sub)} ${ui.ent === 'all' ? 'konsolidasi grup' : esc(D.entity(db, ui.ent).name)}</h3><span class="muted sm">${ui.sub === 'bs' ? 'per ' + fmtDate(Math.min(to, Date.now())) : fmtDate(from) + ' sampai ' + fmtDate(Math.min(to, Date.now()))}</span></div>${body}</div>`;
}
const filt = (db, from, to) => {
  const tl = tableLocs(db);
  // Batas akhir dibulatkan ke akhir hari supaya kunci data stabil (periode "hari ini" berakhir sekarang)
  return { from, to: startOfDay(to) + DAY - 1, locs: curLocs(db), tloc: tl.includes(ui.tloc) ? ui.tloc : tl[0] || 'L1' };
};

function keuangan(ctx) {
  const db = ctx.db;
  const [from, to] = D.periodRange(ui.per, { from: ui.from, to: ui.to });
  const f = filt(db, from, to);
  const S = ui.sub;
  const body = S === 'pl' ? pl(db, from, to) : S === 'bs' ? bs(db, to) : S === 'cf' ? cf(db, from, to) : S === 'sales' ? salesRep(db, from, to)
    : S === 'nota' ? R.nota(db, f) : S === 'kat' ? R.kategori(db, f) : S === 'meja' ? (tableLocs(db).length ? R.meja(db, f) : '<div class="card"><p class="empty">Entitas ini tidak punya meja.</p></div>') : journal(db, from, to);
  const range = S === 'bs' ? 'per ' + fmtDate(Math.min(to, Date.now())) : fmtDate(from) + ' – ' + fmtDate(Math.min(to, Date.now()));
  return `${controls(db)}
    <div class="row sb wrap fin-bar"><div class="seg fin-subs">${SUBS.map(([k, l]) => `<button class="${S === k ? 'on' : ''}" data-a="finSub" data-v="${k}">${l}</button>`).join('')}</div>
      <div class="row"><span class="muted sm">${esc(range)}</span>${['pl', 'cf', 'jr'].includes(S) ? `<button class="btn" data-a="finExp">${ic('notebook-pen', 16)} Catat beban</button>` : ''}${['nota', 'kat', 'meja'].includes(S) ? `<button class="btn" data-a="finReload" title="Muat ulang dari database">${ic('refresh-cw', 16)}</button>` : ''}<button class="btn" data-a="finCsv">${ic('download', 16)} Unduh CSV</button></div></div>
    ${body}
    <p class="hint">Laporan ini otomatis dari transaksi kasir, pembelian, produksi, stock opname, dan B2B. Untuk pelaporan pajak resmi, tetap verifikasi dengan akuntan.</p>`;
}

function b2b(ctx) {
  const db = ctx.db;
  const ar = D.balances(db, ['e2'])['1104'] || 0;
  const ap = -(D.balances(db, ['e1'])['2102'] || 0);
  const [mf] = D.periodRange('month');
  const monthSales = sum(db.b2b.filter((b) => b.at >= mf), (b) => b.total);
  return `<div class="row sb wrap"><p class="muted">Central Kitchen memproduksi bumbu dasar, sambal, dan kuah rawon, lalu menjualnya ke Resto. Setiap transaksi otomatis memindahkan stok dan membuat jurnal di kedua entitas.</p><button class="btn btn-pri" data-a="b2bNew">${ic('plus', 16)} Penjualan B2B baru</button></div>
    <div class="kpis"><div class="kpi"><span class="kpi-l">Piutang Central Kitchen</span><b class="kpi-v">${rp(ar)}</b></div><div class="kpi"><span class="kpi-l">Hutang Kaly Eatery ke CK</span><b class="kpi-v">${rp(ap)}</b><span class="kpi-d ${Math.abs(ar - ap) < 2 ? 'pos' : 'neg'}">${Math.abs(ar - ap) < 2 ? 'Cocok di kedua sisi' : 'Tidak cocok, cek jurnal'}</span></div><div class="kpi"><span class="kpi-l">Penjualan B2B bulan ini</span><b class="kpi-v">${rp(monthSales)}</b></div></div>
    <div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>No.</th><th>Tanggal</th><th>Penjual</th><th>Pembeli</th><th>Barang</th><th class="r">Nilai</th><th class="r">Margin CK</th><th>Status</th><th></th></tr></thead><tbody>
    ${db.b2b.map((b) => `<tr><td><b>${esc(b.no)}</b></td><td>${fmtDT(b.at)}</td><td>${esc(D.entity(db, b.seller).short)}</td><td>${esc(D.entity(db, b.buyer).short)}</td><td class="muted">${b.items.map((x) => `${num(x.q, 1)} ${esc(D.item(db, x.i).unit)} ${esc(D.item(db, x.i).name)}`).join(', ')}</td><td class="r">${rp(b.total)}</td><td class="r">${rp(b.total - b.cost)}</td><td>${b.status === 'lunas' ? '<span class="badge b-ok">Lunas</span>' : '<span class="badge b-warn">Belum lunas</span>'}</td><td>${b.status !== 'lunas' ? `<button class="btn btn-sm" data-a="b2bPay" data-id="${b.id}">Tandai lunas</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}

export function render(tab, ctx) { return tab === 'keuangan' ? keuangan(ctx) : b2b(ctx); }
export function input(k, el, e, ctx) { R.input(k, el, e, ctx); }

export const actions = {
  ...R.actions,
  finEnt(el) { ui.ent = el.dataset.v; ui.loc = 'all'; rerender(); },
  finPer(el) { ui.per = el.dataset.v; if (ui.per === 'custom' && !ui.from) { ui.from = dayKey(Date.now() - 13 * 86400000); ui.to = dayKey(); } R.rui.notaHour = null; rerender(); },
  finFrom(el) { ui.from = el.value; rerender(); },
  finTo(el) { ui.to = el.value; rerender(); },
  finSub(el) { ui.sub = el.dataset.v; rerender(); },
  finLoc(el) { ui.loc = el.dataset.v; R.rui.notaHour = null; rerender(); },
  finTLoc(el) { ui.tloc = el.dataset.v; rerender(); },
  finReload() { R.invalidate(); rerender(); },
  mejaLogCsv(el, e, ctx) { const [from, to] = D.periodRange(ui.per, { from: ui.from, to: ui.to }); R.mejaCsv(ctx.db, filt(ctx.db, from, to), 'log'); },
  async finCsv(el, e, ctx) {
    const db = ctx.db; const [from, to] = D.periodRange(ui.per, { from: ui.from, to: ui.to });
    const f = filt(db, from, to);
    if (ui.sub === 'nota') return R.notaCsv(db, f);
    if (ui.sub === 'kat') return R.katCsv(db, f);
    if (ui.sub === 'meja') return R.mejaCsv(db, f);
    if (ui.sub === 'sales') {
      const os = salesOrders(db, from, to);
      downloadCSV(`penjualan-${ui.ent}-${dayKey(from)}-${dayKey(to)}.csv`, [['No', 'Tanggal', 'Outlet', 'Channel', 'Tipe', 'Meja', 'Subtotal', 'Diskon', 'PB1', 'Total', 'Metode', 'Kasir'], ...os.map((o) => [o.no, new Date(o.created).toLocaleString('id-ID'), D.loc(db, o.loc).name, D.CH_LABEL[o.ch], D.TYPE_LABEL[o.type], o.table || '', o.bill.sub, o.bill.disc, o.bill.tax, o.bill.total, o.pays.map((p) => D.PAY[p.m].label).join('+'), o.paidBy === 'online' ? 'Online' : D.userName(db, o.paidBy)])]);
    } else if (ui.sub === 'pl' || ui.sub === 'cf' || ui.sub === 'bs') {
      const { days, out } = dailyBalances(db, ui.sub === 'bs' ? startOfDay(Math.min(to, Date.now())) : from, to);
      const accs = db.accounts.filter((a) => out.some((b) => b[a.code]));
      downloadCSV(`ringkasan-akun-harian-${ui.ent}-${dayKey(from)}-${dayKey(to)}.csv`, [['Tanggal', ...accs.map((a) => `${a.code} ${a.name}`)], ...days.map((d, i) => [dayKey(d), ...accs.map((a) => out[i][a.code] || 0)])]);
    } else {
      const list = db.journalDetail && jrKey === periodKey() ? db.journalDetail.list : await C.loadJournalDetail(from, to).then((d) => d.list);
      const js = list.filter((j) => ents().includes(j.e) && j.d >= from && j.d <= to);
      downloadCSV(`jurnal-${ui.ent}-${dayKey(from)}-${dayKey(to)}.csv`, [['Tanggal', 'Entitas', 'Keterangan', 'Kode akun', 'Nama akun', 'Debit', 'Kredit'], ...js.flatMap((j) => j.l.map((x) => [new Date(j.d).toLocaleString('id-ID'), D.entity(db, j.e).short, j.memo, x[0], accName(db, x[0]), x[1], x[2]]))]);
    }
  },
  finExp(el, e, ctx) {
    const db = getDb();
    openModal({ title: 'Catat beban operasional', size: 'md', body: `<div class="grid2"><label class="fld"><span>Entitas</span><select name="e">${db.entities.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></label>
      <label class="fld"><span>Jenis beban</span><select name="a">${db.accounts.filter((a) => a.type === 'expense' && a.code !== '6105').map((a) => `<option value="${a.code}">${esc(a.name)}</option>`).join('')}</select></label>
      <label class="fld"><span>Jumlah</span><input name="v" type="number" step="1000" autofocus></label><label class="fld"><span>Dibayar dari</span><select name="s"><option value="1102">Bank & QRIS</option><option value="1101">Kas outlet</option></select></label>
      <label class="fld"><span>Tanggal</span><input name="d" type="date" value="${dayKey()}"></label><label class="fld"><span>Keterangan</span><input name="m" placeholder="Contoh: servis pompa kolam"></label></div>`,
      footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Simpan</button>`,
      onMount(m, api) { m.querySelector('[data-ok]').onclick = async () => { const f = formData(m); const v = Number(f.v); if (!v) return toast('Isi jumlah beban', 'warn'); try { await API.expensePost(f.e, f.a, v, f.s, f.m || accName(getDb(), f.a), f.d); await C.refresh('journals'); } catch (err) { return toast(err.message, 'err'); } api.close(); toast('Beban dicatat'); rerender(); }; } });
  },
  b2bNew(el, e, ctx) {
    const db = getDb();
    let from = 'L3', to = 'L1';
    let rows = [{ i: 's_sambal', q: 3, p: 0 }, { i: 's_rawon', q: 24, p: 0 }];
    const price = (i) => Math.round((D.slot(db, from, i).c || D.stdCost(db, i)) * (1 + db.settings.b2bMarkup) / 10) * 10;
    rows.forEach((r) => (r.p = price(r.i)));
    const draw = () => {
      const items = Object.keys(db.stock[from] || {}).map((i) => D.item(db, i)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
      const tot = sum(rows, (r) => r.q * r.p);
      return `<div class="grid2"><label class="fld"><span>Penjual (lokasi asal)</span><select data-f>${db.locations.map((l) => `<option value="${l.id}" ${l.id === from ? 'selected' : ''}>${esc(l.name)} (${esc(D.entity(db, l.entity).short)})</option>`).join('')}</select></label>
        <label class="fld"><span>Pembeli (lokasi tujuan)</span><select data-t>${db.locations.filter((l) => l.entity !== D.entityOf(db, from)).map((l) => `<option value="${l.id}" ${l.id === to ? 'selected' : ''}>${esc(l.name)} (${esc(D.entity(db, l.entity).short)})</option>`).join('')}</select></label></div>
        <div class="bom-rows">${rows.map((r, i) => { const s = db.stock[from]?.[r.i]; return `<div class="bom-row b2b"><select data-ri="${i}">${items.map((it) => `<option value="${it.id}" ${it.id === r.i ? 'selected' : ''}>${esc(it.name)}</option>`).join('')}</select><input type="number" step="0.1" data-rq="${i}" value="${r.q}" aria-label="Jumlah"><input type="number" step="10" data-rp="${i}" value="${r.p}" aria-label="Harga transfer"><span class="muted sm">stok ${s ? num(s.q, 1) : 0}, HPP ${rp(s?.c || 0)}</span><button class="btn-icon sm" data-rx="${i}">${ic('x', 15)}</button></div>`; }).join('')}</div>
        <button class="btn btn-sm" data-radd>${ic('plus', 14)} Tambah barang</button>
        <p class="row sb"><span class="muted">Harga transfer default = HPP + ${Math.round(db.settings.b2bMarkup * 100)}%</span><b>Total ${rp(tot)}</b></p>`;
    };
    openModal({ title: 'Penjualan B2B antar entitas', size: 'lg', body: draw(), footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Kirim & buat invoice</button>`,
      onMount(m, api) {
        m.addEventListener('change', (ev) => { const t = ev.target;
          if (t.matches('[data-f]')) { from = t.value; to = db.locations.find((l) => l.entity !== D.entityOf(db, from)).id; rows = []; }
          if (t.matches('[data-t]')) to = t.value;
          if (t.dataset.ri !== undefined) { rows[+t.dataset.ri].i = t.value; rows[+t.dataset.ri].p = price(t.value); }
          if (t.dataset.rq !== undefined) rows[+t.dataset.rq].q = Number(t.value);
          if (t.dataset.rp !== undefined) rows[+t.dataset.rp].p = Number(t.value);
          api.set(draw()); });
        m.addEventListener('click', (ev) => { if (ev.target.closest('[data-radd]')) { const i = Object.keys(db.stock[from] || {})[0]; rows.push({ i, q: 1, p: price(i) }); api.set(draw()); } const x = ev.target.closest('[data-rx]'); if (x) { rows.splice(+x.dataset.rx, 1); api.set(draw()); } });
        m.querySelector('[data-ok]').onclick = async () => {
          const its = rows.filter((r) => r.i && r.q > 0 && r.p > 0);
          if (!its.length) return toast('Tambahkan barang', 'warn');
          let no;
          try { no = await API.b2bCreate(from, to, its.map((r) => ({ item: r.i, qty: r.q, price: r.p }))); await C.refresh('b2b', 'stock', 'moves', 'journals'); } catch (err) { return toast(err.message, 'err'); }
          api.close(); toast(`${no} dibuat. Stok pindah dan jurnal tercatat di kedua entitas.`); rerender();
        };
      } });
  },
  async b2bPay(el, e, ctx) {
    const b = getDb().b2b.find((x) => x.id === el.dataset.id);
    if (!(await confirmBox('Tandai lunas', `Catat pembayaran ${rp(b.total)} dari ${esc(D.entity(getDb(), b.buyer).short)} ke ${esc(D.entity(getDb(), b.seller).short)} via transfer bank?`, 'Tandai lunas'))) return;
    await API.b2bPay(b.id); await C.refresh('b2b', 'journals');
    toast('Pembayaran B2B dicatat'); rerender();
  },
};
