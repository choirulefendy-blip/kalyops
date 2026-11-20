// Kaly Core › Laporan (1.4): Transaksi per nota & jam, Penjualan per kategori & jam, Aktivitas denah meja.
// Angka dihitung di database (fungsi report_*), jadi periode berapa pun tetap lengkap.
import * as API from '../api.js';
import { esc, ic, rp, num, pct, toast, fmtDT, fmtShort, fmtTime, fromKey, hariNama, downloadCSV, dayKey } from '../lib.js';
import * as D from '../domain.js';
import { rerender } from '../app.js';
import { columns, lines, hbar, heat, legend, colorMap, compact, ONE, PAL, OTHER } from '../charts.js';

export const rui = { notaHour: null, notaQ: '', notaMetric: 'total', katMetric: 'value', mejaMetric: 'occ', logKind: 'all',
  itemMetric: 'value', itemQ: '', discOver: false };

// ---------- Data dari server (disimpan per jenis; render lama dipertahankan saat memuat ulang) ----------
const cache = {};
function remote(kind, args, fn) {
  const key = JSON.stringify(args);
  const c = (cache[kind] ||= { key: null, data: null, err: null, at: 0, busy: false });
  const stale = c.key !== key || (!c.busy && Date.now() - c.at > 120000);
  if (stale && !c.busy) {
    c.busy = true; const k = key;
    if (c.key !== key) c.err = null;
    c.key = key;
    fn().then((d) => { if (c.key === k) { c.data = d; c.err = null; c.at = Date.now(); } })
      .catch((e) => { if (c.key === k) { c.err = e.message; c.at = Date.now(); } })
      .finally(() => { c.busy = false; rerender(); });
  }
  return { data: c.key === key || c.busy ? c.data : null, loading: c.busy, err: c.err, same: c.data && c.key === key };
}
export function invalidate() { for (const k in cache) cache[k].at = 0; }
function frame(r, body) {
  if (r.err && !r.data) return `<div class="card"><p class="banner err">${ic('circle-alert', 16)} ${esc(r.err)}</p></div>`;
  if (!r.data) return `<div class="card load-pane"><p>Memuat laporan…</p></div>`;
  return `<div class="${r.loading ? 'rp-load' : ''}">${r.err ? `<p class="banner warn sm">${esc(r.err)}</p>` : ''}${body(r.data)}</div>`;
}

const HH = (h) => `${String(h).padStart(2, '0')}.00`;
const hourRange = (hs) => { if (!hs.length) return []; const a = Math.min(...hs), b = Math.max(...hs); return Array.from({ length: b - a + 1 }, (_, i) => a + i); };
const dayList = (from, to) => { const out = []; for (let t = fromKey(dayKey(from)); t <= Math.min(to, Date.now()); t += 86400000) out.push(dayKey(t)); return out.length ? out : [dayKey(from)]; };
const kpi = (l, v, d = '') => `<div class="kpi"><span class="kpi-l">${esc(l)}</span><b class="kpi-v">${v}</b>${d ? `<span class="kpi-d">${d}</span>` : ''}</div>`;
const seg = (act, cur, opts) => `<div class="seg seg-xs">${opts.map(([k, l]) => `<button class="${cur === k ? 'on' : ''}" data-a="${act}" data-v="${k}">${esc(l)}</button>`).join('')}</div>`;
const card = (title, body, { sub = '', right = '', cls = '' } = {}) => `<div class="card ${cls}"><div class="card-h"><h3>${esc(title)}</h3>${right}</div>${sub ? `<p class="rp-sub">${sub}</p>` : ''}${body}</div>`;
const mins = (v) => (v == null ? '–' : `${num(v, 0)} mnt`);
const DOW = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];
// HPP dicatat per baris nota hanya kalau outlet terhubung Kaly Core. Kalau tidak, laporan
// memakai resep yang berlaku sekarang — berguna, tapi perlu dikatakan apa adanya.
function hppNote(d, tot) {
  const est = Number(d.estLines) || 0, all = Number(d.allLines) || 0;
  if (!all || !est) return '';
  const nv = Number(tot?.noHppValue) || 0, ni = Number(tot?.noHppItems) || 0, tv = Number(tot?.value) || 0;
  const gap = nv && tv ? `<br><b>Food cost di atas masih terlalu rendah.</b> ${rp(nv)} penjualan (${pct(nv / tv, 1)}) berasal dari ${num(ni)} item yang resepnya belum diisi, jadi HPP-nya terhitung nol. Isi resepnya supaya margin yang tampil mendekati kenyataan.` : '';
  return `<p class="hint">${est === all ? 'HPP dan margin dihitung dari <b>resep yang berlaku sekarang</b>, bukan dari biaya yang tercatat saat transaksi'
    : `HPP ${num(est)} dari ${num(all)} baris dihitung dari <b>resep yang berlaku sekarang</b>`}, karena pencatatan HPP per nota baru aktif bila outlet terhubung Kaly Core. Jadi kalau harga bahan atau resep berubah, angka periode lama ikut bergerak.${gap}</p>`;
}

// =====================================================================
// 1. Transaksi per nota & jam penjualan
// =====================================================================
export function nota(db, f) {
  const r = remote('nota', [f.from, f.to, f.locs], () => API.reportReceipts(f.from, f.to, f.locs));
  return frame(r, (d) => {
    if (!d.n) return `<div class="card"><p class="empty">Belum ada nota lunas di periode ini.</p>${d.voids?.n ? `<p class="hint">${num(d.voids.n)} nota dibatalkan.</p>` : ''}</div>`;
    const M = rui.notaMetric, isRp = M === 'total';
    const val = (x) => (isRp ? x.total : x.n);
    const vfmt = isRp ? rp : (v) => `${num(v)} nota`;
    const hrs = hourRange(d.hours.map((x) => x.h));
    const byH = Object.fromEntries(d.hours.map((x) => [x.h, x]));
    const top = [...d.hours].sort((a, b) => b.total - a.total)[0];
    const days = dayList(f.from, f.to), byD = Object.fromEntries(d.days.map((x) => [x.d, x]));
    const sel = rui.notaHour;
    const perHour = columns({
      x: hrs.map(HH), series: [{ id: 'v', label: isRp ? 'Penjualan' : 'Nota', color: ONE, values: hrs.map((h) => (byH[h] ? val(byH[h]) : 0)) }],
      fmt: vfmt, axisFmt: (v) => compact(v, isRp), height: 210, act: 'notaHour', actV: (i) => hrs[i], sel: sel == null ? -1 : hrs.indexOf(sel),
      tipTitle: (i) => `Jam ${HH(hrs[i])}–${String(hrs[i]).padStart(2, '0')}.59`,
      tipNote: (i) => { const x = byH[hrs[i]]; return x ? `${num(x.n)} nota · rata-rata ${rp(x.total / x.n)} · ${num(x.items)} item` : 'Tidak ada transaksi'; },
    });
    const perDay = days.length > 1 ? card(isRp ? 'Penjualan per hari' : 'Nota per hari', columns({ x: days.map((k) => fmtShort(fromKey(k))), series: [{ id: 'v', label: isRp ? 'Penjualan' : 'Nota', color: ONE, values: days.map((k) => (byD[k] ? val(byD[k]) : 0)) }],
      fmt: vfmt, axisFmt: (v) => compact(v, isRp), height: 190, tipTitle: (i) => `${hariNama(fromKey(days[i]))}, ${fmtShort(fromKey(days[i]))}`, tipNote: (i) => { const x = byD[days[i]]; return x ? `${num(x.n)} nota · ${rp(x.total)}` : ''; } }), { cls: 'span2' }) : '';
    const dw = {}; d.dowh.forEach((x) => { dw[`${x.w}|${x.h}`] = x; });
    const wset = [...new Set(d.dowh.map((x) => x.w))].sort();
    const heatCard = days.length > 1 ? card('Hari × jam', heat({ rows: wset.map((w) => ({ label: DOW[w - 1] })), cols: hrs.map((h) => String(h).padStart(2, '0')),
      val: (ri, ci) => { const x = dw[`${wset[ri]}|${hrs[ci]}`]; return x ? val(x) : 0; }, fmt: vfmt, cell: (v) => compact(v, false),
      title: (ri, ci) => `${DOW[wset[ri] - 1]} · jam ${HH(hrs[ci])}` }), { sub: 'Jam ramai per hari dalam seminggu. Makin gelap makin ramai.', cls: 'span2' }) : '';
    const tot = d.total || 1;
    const hourTbl = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Jam</th><th class="num">Nota</th><th class="num">Item</th><th class="num">Penjualan</th><th class="num">Rata-rata/nota</th><th class="num">Porsi</th></tr></thead><tbody>
      ${hrs.filter((h) => byH[h]).map((h) => { const x = byH[h]; return `<tr class="${sel === h ? 'rp-hl' : ''}"><td><button class="lnk" data-a="notaHour" data-v="${h}">${HH(h)}–${String(h).padStart(2, '0')}.59</button></td><td class="num">${num(x.n)}</td><td class="num">${num(x.items)}</td><td class="num">${rp(x.total)}</td><td class="num">${rp(x.total / x.n)}</td><td class="num">${pct(x.total / tot, 1)}</td></tr>`; }).join('')}
      <tr class="tot"><td><b>Total</b></td><td class="num"><b>${num(d.n)}</b></td><td class="num"><b>${num(d.items)}</b></td><td class="num"><b>${rp(d.total)}</b></td><td class="num"><b>${rp(d.total / d.n)}</b></td><td class="num">100%</td></tr></tbody></table></div>`;
    // Daftar nota
    const q = rui.notaQ.trim().toLowerCase();
    const list = d.list.filter((o) => (sel == null || new Date(o.at).getHours() === sel) && (!q || [o.no, o.by, o.table, o.member].some((x) => String(x || '').toLowerCase().includes(q))));
    const shown = list.slice(0, 300);
    const multi = new Set(d.list.map((o) => o.loc)).size > 1;
    const payTxt = (o) => o.pays.map(([m, a]) => `${D.PAY[m]?.label || m}${o.pays.length > 1 ? ' ' + rp(a) : ''}`).join(' + ');
    const listCard = `<div class="card rp-card"><div class="card-h"><h3>Daftar nota ${sel != null ? `jam ${HH(sel)}` : ''}</h3>
        <div class="row">${sel != null ? `<button class="chip on" data-a="notaHour" data-v="${sel}">Jam ${HH(sel)} ${ic('x', 13)}</button>` : ''}<input class="inp inp-sm" data-in="notaQ" id="nota-q" placeholder="Cari no. nota, kasir, meja" value="${esc(rui.notaQ)}"></div></div>
      <div class="tbl-wrap rp-scroll"><table class="tbl"><thead><tr><th>No. nota</th><th>Waktu bayar</th>${multi ? '<th>Outlet</th>' : ''}<th>Channel</th><th>Meja / tipe</th><th>Kasir</th><th class="num">Item</th><th class="num">Subtotal</th><th class="num">Diskon</th><th class="num">PB1</th><th class="num">Total</th><th>Pembayaran</th></tr></thead><tbody>
      ${shown.map((o) => `<tr><td><b>${esc(o.no)}</b></td><td class="nowrap">${esc(fmtDT(new Date(o.at).getTime()))}</td>${multi ? `<td class="nowrap">${esc(D.loc(db, o.loc)?.name || o.loc)}</td>` : ''}<td>${esc(D.CH_LABEL[o.ch] || o.ch)}</td>
        <td>${o.table ? `Meja ${esc([o.table, ...(o.merged || [])].join('+'))}` : esc(D.TYPE_LABEL[o.type] || o.type)}</td><td>${esc(o.by || '–')}</td><td class="num">${num(o.items)}</td><td class="num">${rp(o.sub)}</td><td class="num">${o.disc ? '-' + rp(o.disc) : ''}</td><td class="num">${rp(o.tax)}</td><td class="num"><b>${rp(o.total)}</b></td><td class="muted sm">${esc(payTxt(o))}</td></tr>`).join('') || `<tr><td colspan="${multi ? 12 : 11}" class="empty">Tidak ada nota untuk filter ini.</td></tr>`}
      </tbody></table></div><p class="hint">${num(list.length)} nota${list.length > shown.length ? `, ditampilkan ${shown.length} terbaru. Unduh CSV untuk semuanya` : ''}${d.truncated ? '. Periode ini sangat panjang: daftar dibatasi 3.000 nota terbaru, unduh CSV untuk lengkapnya' : ''}.</p></div>`;
    return `<div class="kpis">${kpi('Jumlah nota', num(d.n))}${kpi('Penjualan (incl. pajak)', rp(d.total))}${kpi('Rata-rata per nota', rp(d.total / d.n), `${num(d.items / d.n, 1)} item per nota`)}
        ${kpi('Jam tersibuk', top ? HH(top.h) : '–', top ? `${num(top.n)} nota · ${rp(top.total)}` : '')}${kpi('Nota dibatalkan', num(d.voids.n), d.voids.n ? rp(d.voids.value) : '')}</div>
      <div class="rp-grid">${card('Penjualan per jam', perHour, { right: seg('notaMetric', M, [['total', 'Rupiah'], ['n', 'Jumlah nota']]), sub: 'Berdasarkan jam bayar. Ketuk kolom untuk melihat nota di jam itu.', cls: 'span2' })}
        ${perDay}${heatCard}
        ${card('Rekap per jam', hourTbl, { cls: 'span2' })}</div>${listCard}`;
  });
}
export function notaCsv(db, f, data) {
  const d = data || cache.nota?.data;
  if (!d) return toast('Laporan belum selesai dimuat', 'warn');
  const go = (list) => downloadCSV(`nota-per-jam-${dayKey(f.from)}-${dayKey(f.to)}.csv`, [['No nota', 'Tanggal', 'Jam', 'Waktu bayar', 'Dibuka', 'Outlet', 'Channel', 'Tipe', 'Meja', 'Kasir', 'Member', 'Item', 'Subtotal', 'Diskon', 'Service', 'PB1', 'Ongkir', 'Total', 'Pembayaran'],
    ...list.map((o) => { const t = new Date(o.at); return [o.no, dayKey(t), HH(t.getHours()), t.toLocaleString('id-ID'), new Date(o.opened).toLocaleString('id-ID'), D.loc(db, o.loc)?.name || o.loc, D.CH_LABEL[o.ch] || o.ch, D.TYPE_LABEL[o.type] || o.type,
      [o.table, ...(o.merged || [])].filter(Boolean).join('+'), o.by, o.member || '', o.items, o.sub, o.disc, o.svc, o.tax, o.deliv, o.total, o.pays.map(([m, a]) => `${D.PAY[m]?.label || m} ${a}`).join(' + ')]; })]);
  if (d.truncated) API.reportReceipts(f.from, f.to, f.locs, null).then((x) => go(x.list)).catch((e) => toast(e.message, 'err'));
  else go(d.list);
}

// =====================================================================
// 2. Penjualan per kategori & jam
// =====================================================================
export function kategori(db, f) {
  const r = remote('kat', [f.from, f.to, f.locs], () => API.reportCategories(f.from, f.to, f.locs));
  return frame(r, (d) => {
    if (!d.cats.length) return `<div class="card"><p class="empty">Belum ada item terjual di periode ini.</p></div>`;
    const ids = [...d.master.map((c) => c.id), '_'];
    const colors = colorMap(ids); colors._ = OTHER;
    const cats = d.cats;
    const name = Object.fromEntries(cats.map((c) => [c.id, c.name]));
    const M = rui.katMetric, isRp = M === 'value';
    const vfmt = isRp ? rp : (v) => `${num(v)} porsi`;
    const tot = cats.reduce((a, c) => a + Number(c.value), 0), qtot = cats.reduce((a, c) => a + Number(c.qty), 0), htot = cats.reduce((a, c) => a + Number(c.hpp), 0);
    const hrs = hourRange(d.hours.map((x) => x.h));
    const H = {}; d.hours.forEach((x) => { H[`${x.c}|${x.h}`] = x; });
    const metric = (x) => (x ? Number(isRp ? x.value : x.qty) : 0);
    const order = cats.map((c) => c.id); // urut sesuai master kategori
    const stacked = columns({ x: hrs.map(HH), series: order.map((c) => ({ id: c, label: name[c], color: colors[c], values: hrs.map((h) => metric(H[`${c}|${h}`])) })),
      fmt: vfmt, axisFmt: (v) => compact(v, isRp), height: 230, tipTitle: (i) => `Jam ${HH(hrs[i])}–${String(hrs[i]).padStart(2, '0')}.59`,
      tipNote: (i) => { const s = order.reduce((a, c) => a + metric(H[`${c}|${hrs[i]}`]), 0); return `Total ${vfmt(s)}`; } });
    const share = hbar(cats.map((c) => ({ label: c.name, value: Number(isRp ? c.value : c.qty), color: colors[c.id], tipLabel: isRp ? 'Penjualan' : 'Porsi', note: `${num(c.orders)} nota · ${num(c.menus)} menu` })),
      { fmt: vfmt, total: isRp ? tot : qtot });
    const fc = hbar(cats.map((c) => ({ label: c.name, value: c.value ? (100 * c.hpp) / c.value : 0, color: colors[c.id], tipLabel: 'Food cost', note: `HPP ${rp(c.hpp)} dari ${rp(c.value)}` })),
      { fmt: (v) => `${num(v, 1)}%`, max: 100 });
    const heatTbl = heat({ rows: order.map((c) => ({ label: name[c], color: colors[c] })), cols: hrs.map((h) => String(h).padStart(2, '0')), val: (ri, ci) => metric(H[`${order[ri]}|${hrs[ci]}`]),
      fmt: vfmt, cell: (v) => compact(v, false), title: (ri, ci) => `${name[order[ri]]} · jam ${HH(hrs[ci])}`,
      rowTotal: (ri) => Number(isRp ? cats[ri].value : cats[ri].qty), totalFmt: (v) => (isRp ? compact(v) : num(v)), colTotal: (ci) => order.reduce((a, c) => a + metric(H[`${c}|${hrs[ci]}`]), 0) });
    const days = dayList(f.from, f.to);
    const DD = {}; d.days.forEach((x) => { DD[`${x.c}|${x.d}`] = x; });
    const trend = days.length > 1 ? card('Tren harian per kategori', columns({ x: days.map((k) => fmtShort(fromKey(k))), series: order.map((c) => ({ id: c, label: name[c], color: colors[c], values: days.map((k) => metric(DD[`${c}|${k}`])) })),
      fmt: vfmt, axisFmt: (v) => compact(v, isRp), height: 210, tipTitle: (i) => `${hariNama(fromKey(days[i]))}, ${fmtShort(fromKey(days[i]))}` }), { cls: 'span2' }) : '';
    const table = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Kategori</th><th class="num">Porsi</th><th class="num">Penjualan</th><th class="num">Porsi penjualan</th><th class="num">HPP</th><th class="num">Food cost</th><th class="num">Margin kotor</th><th class="num">Nota</th><th class="num">Menu terjual</th></tr></thead><tbody>
      ${cats.map((c) => `<tr><td><span class="rp-badge"><i style="background:${colors[c.id]}"></i>${esc(c.name)}</span></td><td class="num">${num(c.qty)}</td><td class="num">${rp(c.value)}</td><td class="num">${pct(c.value / (tot || 1), 1)}</td><td class="num">${rp(c.hpp)}</td><td class="num">${pct(c.value ? c.hpp / c.value : 0, 1)}</td><td class="num">${rp(c.value - c.hpp)}</td><td class="num">${num(c.orders)}</td><td class="num">${num(c.menus)}</td></tr>`).join('')}
      <tr class="tot"><td><b>Total</b></td><td class="num"><b>${num(qtot)}</b></td><td class="num"><b>${rp(tot)}</b></td><td class="num">100%</td><td class="num"><b>${rp(htot)}</b></td><td class="num"><b>${pct(tot ? htot / tot : 0, 1)}</b></td><td class="num"><b>${rp(tot - htot)}</b></td><td class="num">${num(d.orders)}</td><td></td></tr></tbody></table></div>`;
    const menus = `<div class="rp-grid rp-menus">${order.map((c) => { const ms = d.menus.filter((m) => m.c === c).slice(0, 6); return `<div><h4 class="rp-badge"><i style="background:${colors[c]}"></i>${esc(name[c])}</h4>${hbar(ms.map((m) => ({ label: m.name, value: Number(isRp ? m.value : m.qty), color: colors[c], tipLabel: isRp ? 'Penjualan' : 'Porsi', note: `${num(m.qty)} porsi · ${rp(m.value)}` })), { fmt: vfmt })}</div>`; }).join('')}</div>`;
    const topCat = [...cats].sort((a, b) => b.value - a.value)[0];
    return `<div class="kpis">${kpi('Penjualan item', rp(tot), 'sebelum diskon tagihan & PB1')}${kpi('Porsi terjual', num(qtot))}${kpi('Kategori teratas', esc(topCat.name), `${pct(topCat.value / (tot || 1), 1)} dari penjualan`)}
        ${kpi('Food cost', pct(tot ? htot / tot : 0, 1), `HPP ${rp(htot)}`)}${kpi('Margin kotor', rp(tot - htot))}</div>
      <div class="row sb rp-ctl"><p class="muted sm">Jam = jam bayar. Nilai item sebelum diskon tagihan dan PB1.</p>${seg('katMetric', M, [['value', 'Rupiah'], ['qty', 'Porsi']])}</div>
      <div class="rp-grid">${card('Kategori per jam', stacked, { cls: 'span2' })}${card('Porsi tiap kategori', share)}${card('Food cost per kategori', fc, { sub: 'HPP dibagi penjualan item. Makin pendek makin untung.' })}
        ${card('Kategori × jam', heatTbl, { cls: 'span2', sub: 'Makin gelap makin laku. Kolom Total = jumlah per kategori.' })}
        ${trend}${card('Rekap per kategori', table + hppNote(d), { cls: 'span2' })}${card('Menu teratas per kategori', menus, { cls: 'span2' })}</div>`;
  });
}
export function katCsv(db, f) {
  const d = cache.kat?.data;
  if (!d) return toast('Laporan belum selesai dimuat', 'warn');
  const name = Object.fromEntries(d.cats.map((c) => [c.id, c.name]));
  downloadCSV(`kategori-per-jam-${dayKey(f.from)}-${dayKey(f.to)}.csv`, [['Kategori', 'Jam', 'Porsi', 'Penjualan'],
    ...[...d.hours].sort((a, b) => a.h - b.h || String(a.c).localeCompare(b.c)).map((x) => [name[x.c] || x.c, HH(x.h), x.qty, x.value]),
    [], ['Kategori', 'Porsi', 'Penjualan', 'HPP', 'Margin kotor', 'Nota', 'Menu terjual'], ...d.cats.map((c) => [c.name, c.qty, c.value, c.hpp, c.value - c.hpp, c.orders, c.menus])]);
}

// =====================================================================
// 3. Aktivitas denah meja
// =====================================================================
const KIND = { open: ['Tamu duduk', 'b-info'], paid: ['Bayar', 'b-ok'], serve: ['Diantar', 'b-gold'], move: ['Pindah meja', 'b-warn'], clear: ['Dikosongkan', 'b-mute'], void: ['Bill batal', 'b-err'] };
const DUR = ['< 30', '30–59', '60–89', '90–119', '≥ 120'];
export function meja(db, f) {
  const r = remote('meja', [f.from, f.to, f.tloc], () => API.reportTables(f.from, f.to, f.tloc));
  return frame(r, (d) => {
    const days = dayList(f.from, f.to);
    const M = rui.mejaMetric;
    const hrs = d.hours.map((x) => x.h);
    const hr = hourRange(hrs); const byH = Object.fromEntries(d.hours.map((x) => [x.h, x]));
    const occ = columns({ x: hr.map(HH), series: [{ id: 'v', label: M === 'occ' ? 'Meja terisi' : 'Tamu datang', color: ONE, values: hr.map((h) => Number(byH[h]?.[M === 'occ' ? 'occ' : 'starts'] || 0)) }],
      fmt: M === 'occ' ? (v) => `${num(v, 1)} meja` : (v) => `${num(v)} kunjungan`, axisFmt: (v) => num(v, 1), height: 210,
      tipTitle: (i) => `Jam ${HH(hr[i])}–${String(hr[i]).padStart(2, '0')}.59`,
      tipNote: (i) => { const x = byH[hr[i]]; return x ? `${num(x.occ, 1)} dari ${d.tables} meja terisi (${pct(x.occ / (d.tables || 1))}) · ${num(x.starts)} tamu datang` : ''; },
      emptyText: 'Belum ada tamu dine-in di periode ini' });
    const durC = columns({ x: DUR, series: [{ id: 'n', label: 'Kunjungan', color: ONE, values: (d.dur || []).map((x) => x.n) }], fmt: (v) => `${num(v)} kunjungan`, axisFmt: (v) => num(v), height: 180, maxLabels: 5,
      tipTitle: (i) => `Lama duduk ${DUR[i]} menit` });
    const areas = hbar((d.per_area || []).map((a) => ({ label: a.area, value: a.visits, tipLabel: 'Kunjungan', note: `${a.tables} meja · perputaran ${num(a.turn, 2)}×/meja/hari · rata-rata duduk ${mins(a.avg_dur)} · ${rp(a.sales)}` })), { fmt: (v) => `${num(v)} kunjungan` });
    const pd = Object.fromEntries((d.per_day || []).map((x) => [x.d, x]));
    const trend = days.length > 1 ? card('Kunjungan per hari', columns({ x: days.map((k) => fmtShort(fromKey(k))), series: [{ id: 'v', label: 'Kunjungan', color: ONE, values: days.map((k) => pd[k]?.visits || 0) }],
      fmt: (v) => `${num(v)} kunjungan`, axisFmt: (v) => num(v), height: 180, tipTitle: (i) => `${hariNama(fromKey(days[i]))}, ${fmtShort(fromKey(days[i]))}`,
      tipNote: (i) => { const x = pd[days[i]]; return x ? `Penjualan meja ${rp(x.sales)} · rata-rata duduk ${mins(x.avg_dur)}` : ''; } }), { cls: 'span2' }) : '';
    const staff = d.staff || [];
    const staffTbl = staff.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Staf</th><th>Peran</th><th class="num">Bill dibuka</th><th class="num">Bill dibayar</th><th class="num">Antar pesanan</th><th class="num">Item diantar</th><th class="num">Kosongkan meja</th><th class="num">Pindah meja</th></tr></thead><tbody>
      ${staff.map((s) => `<tr><td><b>${esc(s.name)}</b></td><td>${esc(D.ROLES?.[s.role]?.label || s.role)}</td><td class="num">${num(s.opens)}</td><td class="num">${num(s.paid)}</td><td class="num">${num(s.serves)}</td><td class="num">${num(s.serve_items)}</td><td class="num">${num(s.clears)}</td><td class="num">${num(s.moves)}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="empty sm">Belum ada aktivitas staf tercatat di periode ini.</p>';
    const pt = (d.per_table || []).filter((t) => t.visits || t.moves || t.clears);
    const tblTbl = `<div class="tbl-wrap rp-scroll"><table class="tbl"><thead><tr><th>Meja</th><th>Area</th><th class="num">Kursi</th><th class="num">Kunjungan</th><th class="num">Perputaran/hari</th><th class="num">Penjualan</th><th class="num">Rata-rata duduk</th><th class="num">Pindah keluar</th><th class="num">Dikosongkan</th></tr></thead><tbody>
      ${pt.map((t) => `<tr><td><b>${esc(t.id)}</b></td><td>${esc(t.area)}</td><td class="num">${num(t.seats)}</td><td class="num">${num(t.visits)}</td><td class="num">${num(t.visits / d.days, 1)}</td><td class="num">${rp(t.sales)}</td><td class="num">${mins(t.avg_dur)}</td><td class="num">${num(t.moves)}</td><td class="num">${num(t.clears)}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">Belum ada kunjungan.</td></tr>'}
      </tbody></table></div>${(d.per_table || []).length > pt.length ? `<p class="hint">${(d.per_table || []).length - pt.length} meja tanpa aktivitas tidak ditampilkan.</p>` : ''}`;
    const K = rui.logKind;
    const log = (d.log || []).filter((x) => K === 'all' || x.kind === K);
    const cnt = (k) => (d.log || []).filter((x) => x.kind === k).length;
    const logCard = `<div class="card rp-card"><div class="card-h"><h3>Log aktivitas meja</h3><button class="btn btn-sm" data-a="mejaLogCsv">${ic('download', 15)} Unduh log</button></div>
      <div class="rp-chips">${[['all', 'Semua', (d.log || []).length], ...Object.entries(KIND).map(([k, [l]]) => [k, l, cnt(k)])].map(([k, l, n]) => `<button class="chip ${K === k ? 'on' : ''}" data-a="logKind" data-v="${k}">${esc(l)} <span class="muted">${n}</span></button>`).join('')}</div>
      <div class="tbl-wrap rp-scroll"><table class="tbl rp-log"><thead><tr><th>Waktu</th><th>Meja</th><th>Aktivitas</th><th>Bill</th><th>Oleh</th><th>Keterangan</th></tr></thead><tbody>
      ${log.map((x) => { const [l, b] = KIND[x.kind] || [x.kind, 'b-mute']; return `<tr><td>${esc(fmtDT(new Date(x.at).getTime()))}</td><td><b>${esc(x.table)}</b>${x.to ? ` → <b>${esc(x.to)}</b>` : ''}</td><td><span class="badge ${b}">${esc(l)}</span></td><td>${esc(x.no || '')}</td><td>${esc(x.who || '')}</td><td class="muted sm">${esc(x.kind === 'serve' ? `${x.qty} item` : x.detail || '')}</td></tr>`; }).join('') || '<tr><td colspan="6" class="empty">Tidak ada aktivitas untuk filter ini.</td></tr>'}
      </tbody></table></div><p class="hint">${d.log_total > (d.log || []).length ? `Menampilkan ${num((d.log || []).length)} aktivitas terbaru dari ${num(d.log_total)}. ` : ''}Pindah meja, kosongkan meja, dan antar pesanan tercatat sejak Kaly Ops 1.4 dipasang.</p></div>`;
    const ev = d.ev || {};
    return `<div class="kpis">${kpi('Kunjungan meja', num(d.visits), `${rp(d.sales)} penjualan meja${d.open ? ` · ${num(d.open)} masih duduk` : ''}`)}
        ${kpi('Perputaran meja', `${num(d.visits / (d.tables || 1) / d.days, 2)}×`, 'kunjungan per meja per hari')}
        ${kpi('Rata-rata lama duduk', mins(d.avg_dur), 'duduk sampai meja dikosongkan')}
        ${kpi('Duduk setelah bayar', mins(d.avg_linger), d.cleared_n ? `dari ${num(d.cleared_n)} meja yang dikosongkan` : 'belum ada data kosongkan')}
        ${kpi('Tunggu antar', mins(d.serve_wait), d.serve_n ? `siap → diantar, ${num(d.serve_n)} item` : 'belum ada data antar')}
        ${kpi('Pindah · kosongkan', `${num(ev.move || 0)} · ${num(ev.clear || 0)}`, [ev.auto ? `+${num(ev.auto)} otomatis saat bill baru` : '', d.voids ? `${num(d.voids)} bill batal` : ''].filter(Boolean).join(' · '))}</div>
      <div class="rp-grid">${card('Keterisian per jam', occ, { right: seg('mejaMetric', M, [['occ', 'Meja terisi'], ['starts', 'Tamu datang']]), cls: 'span2',
          sub: M === 'occ' ? `Rata-rata jumlah meja terisi tiap jam${d.days > 1 ? ` selama ${d.days} hari` : ''}. Meja gabungan dihitung sesuai jumlah mejanya.` : 'Jumlah bill dine-in yang dibuka tiap jam (tamu mulai duduk).' })}
        ${card('Lama duduk', durC, { sub: 'Menit, dari bill dibuka sampai meja dikosongkan (atau dibayar bila tidak dikosongkan).' })}${card('Per area', areas, { sub: 'Kunjungan per area. Sentuh baris untuk melihat perputaran dan lama duduk.' })}
        ${trend}${card('Aktivitas staf', staffTbl, { cls: 'span2' })}${card('Per meja', tblTbl, { cls: 'span2', sub: 'Urut dari meja paling sering dipakai.' })}</div>${logCard}`;
  });
}
export function mejaCsv(db, f, which = 'tables') {
  const d = cache.meja?.data;
  if (!d) return toast('Laporan belum selesai dimuat', 'warn');
  if (which === 'log') return downloadCSV(`log-meja-${dayKey(f.from)}-${dayKey(f.to)}.csv`, [['Waktu', 'Meja', 'Ke meja', 'Aktivitas', 'Bill', 'Oleh', 'Item', 'Keterangan'],
    ...d.log.map((x) => [new Date(x.at).toLocaleString('id-ID'), x.table, x.to || '', KIND[x.kind]?.[0] || x.kind, x.no || '', x.who || '', x.qty || '', x.detail || ''])]);
  downloadCSV(`aktivitas-meja-${dayKey(f.from)}-${dayKey(f.to)}.csv`, [['Meja', 'Area', 'Kursi', 'Kunjungan', 'Penjualan', 'Rata-rata duduk (mnt)', 'Pindah keluar', 'Dikosongkan'],
    ...d.per_table.map((t) => [t.id, t.area, t.seats, t.visits, t.sales, t.avg_dur ?? '', t.moves, t.clears])]);
}

// =====================================================================
// 4. Penjualan per item & jam
// =====================================================================
// HPP tidak tersimpan di baris nota (order_lines.cost kosong), jadi margin
// dihitung dari resep yang berlaku sekarang — sama seperti tab Penjualan.
export function item(db, f) {
  const r = remote('item', [f.from, f.to, f.locs], () => API.reportItems(f.from, f.to, f.locs));
  return frame(r, (d) => {
    if (!d.items.length) return `<div class="card"><p class="empty">Belum ada item terjual di periode ini.</p></div>`;
    const M = rui.itemMetric, isRp = M === 'value';
    const vfmt = isRp ? rp : (v) => `${num(v)} porsi`;
    const metric = (x) => (x ? Number(isRp ? x.value : x.qty) : 0);
    const T = d.totals;
    const hpp = (it) => Number(it.hpp) || 0;
    const htot = Number(T.hpp) || 0;
    const hrs = hourRange(d.hourTotals.map((x) => x.h));
    const byH = Object.fromEntries(d.hourTotals.map((x) => [x.h, x]));
    const days = dayList(f.from, f.to);
    const byD = Object.fromEntries(d.dayTotals.map((x) => [x.d, x]));
    const top = d.items.slice(0, 15);
    const ids = top.map((x) => x.id);
    const colors = colorMap(ids);
    const HX = {}; d.hours.forEach((x) => { HX[`${x.id}|${x.h}`] = x; });
    const DX = {}; d.days.forEach((x) => { DX[`${x.id}|${x.d}`] = x; });
    const name = Object.fromEntries(d.items.map((x) => [x.id, x.name]));

    const perHour = card('Penjualan per jam', columns({ x: hrs.map(HH),
      series: [{ id: 'v', label: isRp ? 'Penjualan' : 'Porsi', color: ONE, values: hrs.map((h) => metric(byH[h])) }],
      fmt: vfmt, axisFmt: (v) => compact(v, isRp), height: 210,
      tipTitle: (i) => `Jam ${HH(hrs[i])}–${String(hrs[i]).padStart(2, '0')}.59`,
      tipNote: (i) => { const x = byH[hrs[i]]; return x ? `${num(x.qty)} porsi · ${rp(x.value)} · ${num(x.orders)} nota` : 'Tidak ada transaksi'; } }),
      { sub: 'Berdasarkan jam bayar, seluruh item digabung.', cls: 'span2' });

    const heatCard = card('Item × jam', heat({ rows: top.map((x) => ({ label: x.name, color: colors[x.id] })),
      cols: hrs.map((h) => String(h).padStart(2, '0')), val: (ri, ci) => metric(HX[`${ids[ri]}|${hrs[ci]}`]),
      fmt: vfmt, cell: (v) => compact(v, false), title: (ri, ci) => `${name[ids[ri]]} · jam ${HH(hrs[ci])}`,
      rowTotal: (ri) => Number(isRp ? top[ri].value : top[ri].qty), totalFmt: (v) => (isRp ? compact(v) : num(v)),
      colTotal: (ci) => ids.reduce((a, id) => a + metric(HX[`${id}|${hrs[ci]}`]), 0) }),
      { sub: '15 item teratas. Makin gelap makin laku di jam itu.', cls: 'span2' });

    const trend = days.length > 1 ? card('Tren harian', columns({ x: days.map((k) => fmtShort(fromKey(k))),
      series: [{ id: 'v', label: isRp ? 'Penjualan' : 'Porsi', color: ONE, values: days.map((k) => metric(byD[k])) }],
      fmt: vfmt, axisFmt: (v) => compact(v, isRp), height: 190,
      tipTitle: (i) => `${hariNama(fromKey(days[i]))}, ${fmtShort(fromKey(days[i]))}` }), { cls: 'span2' }) : '';

    const dayHeat = days.length > 1 ? card('Item × tanggal', heat({ rows: top.map((x) => ({ label: x.name, color: colors[x.id] })),
      cols: days.map((k) => fmtShort(fromKey(k))), val: (ri, ci) => metric(DX[`${ids[ri]}|${days[ci]}`]),
      fmt: vfmt, cell: (v) => compact(v, false), title: (ri, ci) => `${name[ids[ri]]} · ${fmtShort(fromKey(days[ci]))}`,
      rowTotal: (ri) => Number(isRp ? top[ri].value : top[ri].qty), totalFmt: (v) => (isRp ? compact(v) : num(v)),
      colTotal: (ci) => ids.reduce((a, id) => a + metric(DX[`${id}|${days[ci]}`]), 0) }),
      { sub: '15 item teratas per tanggal.', cls: 'span2' }) : '';

    const q = rui.itemQ.trim().toLowerCase();
    const rows = d.items.filter((x) => !q || x.name.toLowerCase().includes(q) || (x.catname || '').toLowerCase().includes(q));
    const tbl = `<div class="tbl-wrap rp-scroll"><table class="tbl"><thead><tr><th>Item</th><th>Kategori</th><th class="num">Porsi</th><th class="num">Penjualan</th><th class="num">Porsi penjualan</th><th class="num">HPP resep</th><th class="num">Margin</th><th class="num">Nota</th></tr></thead><tbody>
      ${rows.map((x) => { const h = hpp(x), v = Number(x.value); return `<tr><td><b>${esc(x.name)}</b></td><td class="muted sm">${esc(x.catname || '–')}</td><td class="num">${num(x.qty)}</td><td class="num">${rp(v)}</td><td class="num">${pct(v / (Number(T.value) || 1), 1)}</td><td class="num">${h ? rp(h) : '<span class="muted" title="Resep menu ini belum diisi">–</span>'}</td><td class="num">${h ? pct((v - h) / v, 1) : '<span class="muted">–</span>'}</td><td class="num">${num(x.orders)}</td></tr>`; }).join('')
        || '<tr><td colspan="8" class="empty">Tidak ada item cocok.</td></tr>'}
      <tr class="tot"><td><b>Total</b></td><td></td><td class="num"><b>${num(T.qty)}</b></td><td class="num"><b>${rp(T.value)}</b></td><td class="num">100%</td><td class="num"><b>${htot ? rp(htot) : '–'}</b></td><td class="num"><b>${htot ? pct((Number(T.value) - htot) / Number(T.value), 1) : '–'}</b></td><td class="num">${num(T.orders)}</td></tr>
    </tbody></table></div>`;

    const hpWarn = hppNote(T, T);
    const best = d.items[0];
    return `<div class="kpis">${kpi('Penjualan item', rp(T.value), 'sebelum diskon tagihan & PB1')}${kpi('Porsi terjual', num(T.qty))}
        ${kpi('Jenis item terjual', num(T.menus), `dari ${num(T.orders)} nota`)}
        ${kpi('Item terlaris', esc(best.name), `${num(best.qty)} porsi · ${rp(best.value)}`)}
        ${kpi('Rata-rata porsi per nota', num(Number(T.qty) / (Number(T.orders) || 1), 1))}</div>
      <div class="row sb rp-ctl"><p class="muted sm">Jam = jam bayar. Nilai item sebelum diskon tagihan dan PB1.</p>${seg('itemMetric', M, [['value', 'Rupiah'], ['qty', 'Porsi']])}</div>
      <div class="rp-grid">${perHour}${trend}${heatCard}${dayHeat}
        ${card('Rekap per item', `<div class="row sb rp-ctl"><span class="muted sm">${num(rows.length)} item</span><input class="inp inp-sm" data-in="itemQ" id="item-q" placeholder="Cari item atau kategori" value="${esc(rui.itemQ)}"></div>${tbl}${hpWarn}`, { cls: 'span2' })}</div>`;
  });
}
export function itemCsv(db, f) {
  const d = cache.item?.data;
  if (!d) return toast('Laporan belum selesai dimuat', 'warn');
  const H = (x) => Math.round(Number(x.hpp) || 0);
  downloadCSV(`item-per-tanggal-jam-${dayKey(f.from)}-${dayKey(f.to)}.csv`, [
    ['Tanggal', 'Jam', 'Item', 'Kategori', 'Porsi', 'Penjualan', 'HPP', 'Margin', 'Nota'],
    ...d.grid.map((x) => { const h = H(x); return [x.d, HH(x.h), x.name, x.catname, x.qty, x.value, h || '', h ? Number(x.value) - h : '', x.orders]; }),
    [], ['Rekap seluruh periode'],
    ['Item', 'Kategori', 'Porsi', 'Penjualan', 'HPP', 'Margin', 'Nota'],
    ...d.items.map((x) => { const h = H(x); return [x.name, x.catname, x.qty, x.value, h || '', h ? Number(x.value) - h : '', x.orders]; }),
    [], [Number(d.totals.estLines) ? 'Catatan: HPP dihitung dari resep yang berlaku saat laporan diunduh, bukan dari biaya yang tercatat saat transaksi.' : '']]);
}

// =====================================================================
// 5. Rekap diskon
// =====================================================================
export function diskon(db, f) {
  const r = remote('disc', [f.from, f.to, f.locs], () => API.reportDiscounts(f.from, f.to, f.locs));
  return frame(r, (d) => {
    const T = d.totals;
    if (!Number(T.amount)) return `<div class="card"><p class="empty">Tidak ada diskon diberikan di periode ini.</p><p class="hint">${num(T.allBills)} nota lunas, semuanya tanpa potongan.</p></div>`;
    const thr = Number(d.threshold) || 0;
    const days = dayList(f.from, f.to);
    const byD = Object.fromEntries(d.days.map((x) => [x.d, x]));
    const hrs = hourRange(d.hours.map((x) => x.h));
    const byH = Object.fromEntries(d.hours.map((x) => [x.h, x]));
    const gross = Number(T.gross) || 0, amt = Number(T.amount);

    const trend = days.length > 1 ? card('Diskon per hari', columns({ x: days.map((k) => fmtShort(fromKey(k))),
      series: [{ id: 'v', label: 'Diskon', color: ONE, values: days.map((k) => Number(byD[k]?.amount || 0)) }],
      fmt: rp, axisFmt: (v) => compact(v, true), height: 190,
      tipTitle: (i) => `${hariNama(fromKey(days[i]))}, ${fmtShort(fromKey(days[i]))}`,
      tipNote: (i) => { const x = byD[days[i]]; return x ? `${num(x.bills)} nota` : ''; } }), { cls: 'span2' }) : '';

    const perHour = card('Diskon per jam', columns({ x: hrs.map(HH),
      series: [{ id: 'v', label: 'Diskon', color: ONE, values: hrs.map((h) => Number(byH[h]?.amount || 0)) }],
      fmt: rp, axisFmt: (v) => compact(v, true), height: 190,
      tipTitle: (i) => `Jam ${HH(hrs[i])}–${String(hrs[i]).padStart(2, '0')}.59`,
      tipNote: (i) => { const x = byH[hrs[i]]; return x ? `${num(x.bills)} nota` : ''; } }), { cls: 'span2' });

    const kindBar = card('Diskon per jenis', hbar(d.kinds.map((k) => ({ label: k.label, value: Number(k.amount),
      tipLabel: 'Diskon', note: `${num(k.bills)} nota · rata-rata ${rp(k.avg)}` })), { fmt: rp, total: amt }));
    const staffBar = card('Diskon per kasir', hbar(d.staff.map((s) => ({ label: s.name, value: Number(s.amount),
      tipLabel: 'Diskon', note: `${num(s.bills)} nota` })), { fmt: rp, total: amt }),
      { sub: 'Siapa yang memberi potongan. Berguna untuk melihat pola yang tidak biasa.' });

    const kindTbl = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Jenis diskon</th><th>Setelan</th><th class="num">Nota</th><th class="num">Total diskon</th><th class="num">Rata-rata/nota</th><th class="num">Porsi</th></tr></thead><tbody>
      ${d.kinds.map((k) => `<tr><td><b>${esc(k.label)}</b>${k.kind === 'impor' ? ' <span class="badge b-mute">impor</span>' : ''}</td>
        <td class="muted sm">${k.cfgValue != null ? esc(k.cfgType === 'pct' ? `${num(Number(k.cfgValue) * 100, 0)}%` : rp(k.cfgValue)) : '–'}${k.needPin === true ? ' · perlu PIN' : k.needPin === false ? ' · tanpa PIN' : ''}</td>
        <td class="num">${num(k.bills)}</td><td class="num"><b>${rp(k.amount)}</b></td><td class="num">${rp(k.avg)}</td><td class="num">${pct(Number(k.amount) / amt, 1)}</td></tr>`).join('')}
      <tr class="tot"><td><b>Total</b></td><td></td><td class="num"><b>${num(T.bills)}</b></td><td class="num"><b>${rp(amt)}</b></td><td class="num"></td><td class="num">100%</td></tr></tbody></table></div>`;

    const list = rui.discOver ? d.list.filter((x) => x.ratio != null && Number(x.ratio) > thr && !x.withPin) : d.list;
    const shown = list.slice(0, 300);
    const listCard = `<div class="card rp-card span2"><div class="card-h"><h3>Nota berdiskon</h3>
        <div class="row">${seg('discOver', rui.discOver ? 'on' : 'all', [['all', 'Semua'], ['on', `Di atas ${num(thr * 100, 0)}%`]])}</div></div>
      <div class="tbl-wrap rp-scroll"><table class="tbl"><thead><tr><th>No. nota</th><th>Waktu</th><th>Jenis diskon</th><th>Oleh</th><th class="num">Subtotal</th><th class="num">Diskon</th><th class="num">Porsi</th><th>Persetujuan</th><th>Alasan</th></tr></thead><tbody>
      ${shown.map((x) => `<tr class="${x.ratio != null && Number(x.ratio) > thr && !x.withPin ? 'row-neg' : ''}"><td><b>${esc(x.no)}</b></td><td class="nowrap">${esc(fmtDT(new Date(x.at).getTime()))}</td>
        <td>${esc(x.label)}</td><td>${esc(x.staff)}</td><td class="num">${x.sub ? rp(x.sub) : '<span class="muted">–</span>'}</td><td class="num"><b>${rp(x.amount)}</b></td>
        <td class="num">${x.ratio != null ? pct(Number(x.ratio), 1) : '<span class="muted">–</span>'}</td>
        <td>${x.withPin ? '<span class="badge b-ok">PIN manajer</span>' : x.legacy ? '<span class="badge b-mute">impor</span>' : '<span class="badge b-mute">tidak perlu</span>'}</td>
        <td class="muted sm">${esc(x.reason || '')}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">Tidak ada nota untuk filter ini.</td></tr>'}
      </tbody></table></div><p class="hint">${num(list.length)} nota${list.length > shown.length ? `, ditampilkan ${shown.length} terbaru. Unduh CSV untuk semuanya` : ''}.</p></div>`;

    return `<div class="kpis">${kpi('Total diskon', rp(amt), `${pct(gross ? amt / gross : 0, 1)} dari penjualan`)}
        ${kpi('Nota berdiskon', num(T.bills), `dari ${num(T.allBills)} nota lunas`)}
        ${kpi('Rata-rata per nota', rp(amt / (Number(T.bills) || 1)))}
        ${kpi('Lewat PIN manajer', rp(T.withPinAmount), `${num(T.withPinBills)} nota`)}
        ${kpi(`Di atas ambang ${num(thr * 100, 0)}%`, rp(T.overThrAmount), `${num(T.overThrBills)} nota tanpa PIN`)}</div>
      <p class="rp-sub">Ambang persetujuan saat ini <b>${num(thr * 100, 0)}%</b>. Diskon preset yang disetel "tanpa PIN" tetap sah walau tidak melewati persetujuan — kolom Persetujuan menunjukkan apakah PIN manajer sempat diminta, bukan apakah diskonnya wajar.</p>
      <div class="rp-grid">${kindBar}${staffBar}${trend}${perHour}${card('Rekap per jenis diskon', kindTbl, { cls: 'span2' })}${listCard}</div>`;
  });
}
export function diskonCsv(db, f) {
  const d = cache.disc?.data;
  if (!d) return toast('Laporan belum selesai dimuat', 'warn');
  downloadCSV(`diskon-${dayKey(f.from)}-${dayKey(f.to)}.csv`, [
    ['No nota', 'Waktu', 'Outlet', 'Channel', 'Tipe', 'Meja', 'Jenis diskon', 'Diberikan oleh', 'Subtotal', 'Diskon', 'Porsi diskon', 'Total nota', 'Lewat PIN manajer', 'Alasan'],
    ...d.list.map((x) => [x.no, new Date(x.at).toLocaleString('id-ID'), D.loc(db, x.loc)?.name || x.loc,
      D.CH_LABEL[x.ch] || x.ch || '', D.TYPE_LABEL[x.type] || x.type || '', x.table || '', x.label, x.staff,
      x.sub || '', x.amount, x.ratio != null ? (Number(x.ratio) * 100).toFixed(1) + '%' : '', x.total,
      x.withPin ? 'Ya' : 'Tidak', x.reason || '']),
    [], ['Rekap per jenis diskon'], ['Jenis', 'Nota', 'Total diskon', 'Rata-rata per nota'],
    ...d.kinds.map((k) => [k.label, k.bills, k.amount, Math.round(Number(k.avg))]),
    [], ['Rekap per kasir'], ['Kasir', 'Nota', 'Total diskon', 'Lewat PIN manajer'],
    ...d.staff.map((s) => [s.name, s.bills, s.amount, s.withPin]),
    [], ['Rekap per hari'], ['Tanggal', 'Nota', 'Total diskon'],
    ...d.days.map((x) => [x.d, x.bills, x.amount])]);
}

export const actions = {
  notaHour(el) { const h = Number(el.dataset.v); rui.notaHour = rui.notaHour === h ? null : h; rerender(); },
  itemMetric(el) { rui.itemMetric = el.dataset.v; rerender(); },
  discOver(el) { rui.discOver = el.dataset.v === 'on'; rerender(); },
  notaMetric(el) { rui.notaMetric = el.dataset.v; rerender(); },
  katMetric(el) { rui.katMetric = el.dataset.v; rerender(); },
  mejaMetric(el) { rui.mejaMetric = el.dataset.v; rerender(); },
  logKind(el) { rui.logKind = el.dataset.v; rerender(); },
};
export function input(k, el) {
  if (k === 'notaQ') { rui.notaQ = el.value; const pos = el.selectionStart; rerender(); const i = document.getElementById('nota-q'); if (i) { i.focus(); i.setSelectionRange(pos, pos); } }
  if (k === 'itemQ') { rui.itemQ = el.value; const pos = el.selectionStart; rerender(); const i = document.getElementById('item-q'); if (i) { i.focus(); i.setSelectionRange(pos, pos); } }
}
