// Kaly Kitchen — layar dapur per nota dengan checker per item (setiap item bisa langsung diantar begitu siap) & analisa serving time
import { local, getDb } from '../store.js';
import * as API from '../api.js';
import { esc, ic, toast, barChart, startOfDay, DAY, sum, num, pct } from '../lib.js';
import { play, enabled, kdsStation, setKdsStation } from '../notify.js';
import * as D from '../domain.js';
import { stockBanner } from '../stock-alert.js';
import { rerender } from '../app.js';

const ui = { station: kdsStation(), tab: 'live', range: 'today' };
let seen = null;

const fail = (e) => toast(e?.message || 'Gagal menyimpan ke server', 'err', 5000);
const t0 = () => startOfDay() - 6 * 3600000;
const inSt = (l) => ui.station === 'all' || l.st === ui.station;
const kLines = (o) => D.kitchenLines(o).filter(inSt);
const firstTs = (o) => Math.min(...kLines(o).map((l) => l.ts || o.created));
const live0 = (o, L) => o.loc === L && o.status !== 'void' && o.created >= t0() && o.released !== false;
// Nota yang masih punya item antre / dimasak, urut dari yang paling lama masuk
function activeTickets(db, L) {
  return db.orders.filter((o) => live0(o, L) && kLines(o).some((l) => l.s === 'new' || l.s === 'cook')).sort((a, b) => firstTs(a) - firstTs(b));
}
// Nota yang semua itemnya sudah siap/diantar: masih ada yang menunggu diantar, atau selesai 30 menit terakhir
function doneRecent(db, L) {
  const since = Date.now() - 30 * 60000;
  const last = (o) => Math.max(...kLines(o).map((l) => l.tv || l.tr || 0));
  return db.orders.filter((o) => live0(o, L) && kLines(o).length && kLines(o).every((l) => l.s === 'ready' || l.s === 'served') && (kLines(o).some((l) => l.s === 'ready') || last(o) > since))
    .sort((a, b) => last(b) - last(a)).slice(0, 12);
}
function where(o) { return o.table ? `Meja ${esc([o.table, ...(o.merged || [])].join('+'))}` : esc(o.cust?.name || D.TYPE_LABEL[o.type] || ''); }
const parentName = (o, l) => (l.par ? o.lines.find((x) => x.id === l.par)?.n : '');
const ST = { new: 'Antre', cook: 'Dimasak', ready: 'Siap, tunggu diantar', served: 'Sudah diantar' };

function row(o, l) {
  const pn = parentName(o, l), wait = l.s === 'new' || l.s === 'cook';
  const body = `<span class="tkl-q">${num(l.q)}×</span><span class="tkl-n">${esc(l.n)}${l.note ? `<small>${esc(l.note)}</small>` : ''}${pn ? `<small class="muted">paket ${esc(pn)}</small>` : ''}<em class="tkr-st">${ST[l.s] || ''}</em></span>`;
  return `<li class="tkr s-${l.s}">
    ${wait ? `<button class="tkr-m" data-a="cookTg" data-o="${o.id}" data-l="${l.id}" title="${l.s === 'new' ? 'Ketuk: mulai dimasak' : 'Ketuk: kembali ke antre'}">${body}</button>` : `<div class="tkr-m">${body}</div>`}
    <span class="tkr-a">${wait ? `<button class="btn btn-sm btn-pri" data-a="ready" data-o="${o.id}" data-l="${l.id}">${ic('check', 15)} Siap</button>`
      : l.s === 'ready' ? `<button class="btn-icon sm" data-a="back" data-o="${o.id}" data-l="${l.id}" title="Batal siap, kembalikan ke antrean" aria-label="Batal siap ${esc(l.n)}">${ic('rotate-ccw', 15)}</button>`
      : ic('check', 17)}</span></li>`;
}
// Item yang dibatalkan kasir setelah masuk dapur tetap tampil dicoret 30 menit, supaya dapur tahu harus berhenti
const voidLines = (o) => o.lines.filter((l) => l.s === 'void' && l.ts && l.vat && Date.now() - l.vat < 30 * 60000 && l.st && l.st !== 'none' && !l.pkg && inSt(l));
const voidRow = (l) => `<li class="tkr s-void"><div class="tkr-m"><span class="tkl-q">${num(l.q)}×</span><span class="tkl-n"><s>${esc(l.n)}</s><small>Dibatalkan kasir${l.vr ? ': ' + esc(l.vr) : ''}</small></span></div><span class="tkr-a"><span class="badge b-err">BATAL</span></span></li>`;
function ticket(o) {
  const ls = kLines(o);
  const done = ls.filter((l) => l.s === 'ready' || l.s === 'served').length;
  return `<article class="tk">
    <header class="tk-h"><b class="tk-no">${esc(o.no)}</b><span class="tk-w">${where(o)}${o.ch !== 'pos' ? ` <span class="badge b-info">${D.CH_LABEL[o.ch]}</span>` : ''}</span><span class="tk-time" data-since="${firstTs(o)}" data-sla></span></header>
    ${o.cust?.name && o.table ? `<p class="tk-c">${esc(o.cust.name)}</p>` : ''}
    <ul class="tk-l">${ls.map((l) => row(o, l)).join('')}${voidLines(o).map(voidRow).join('')}</ul>
    <footer class="tk-f"><span class="tk-prog">${done}/${ls.length} item siap</span><button class="btn btn-sm" data-a="bump" data-o="${o.id}">${ic('check-check', 15)} Siap semua</button></footer>
  </article>`;
}

function live(ctx) {
  const db = ctx.db, L = ctx.outlet;
  const ts = activeTickets(db, L), done = doneRecent(db, L);
  const waitN = sum(ts.map((o) => kLines(o).filter((l) => l.s === 'new' || l.s === 'cook').length));
  const readyN = D.readyItems(db, L, t0()).filter((x) => inSt(x.l)).length;
  const sched = db.orders.filter((o) => o.loc === L && o.sched && !o.released && o.status !== 'void');
  return `<div class="kds-bar">
      <div class="chips">${[['all', 'Semua'], ['dapur', 'Dapur'], ['bar', 'Bar']].map(([k, l]) => `<button class="chip ${ui.station === k ? 'on' : ''}" data-a="station" data-v="${k}">${l}</button>`).join('')}</div>
    </div>
    ${stockBanner(db, L)}
    <p class="kds-info">${ts.length} nota aktif, ${waitN} item belum siap, ${readyN} item menunggu diantar. Ketuk nama item untuk menandai <b>Dimasak</b>. Tekan <b>Siap</b> per item: pramusaji & kasir langsung diberi tahu untuk mengantar item itu, tanpa menunggu item lain di nota yang sama.${sched.length ? ` ${sched.length} pre-order reservasi masuk otomatis ${db.settings.scheduleLead} menit sebelum jamnya.` : ''}</p>
    <div class="kds">${ts.map(ticket).join('') || `<div class="kds-empty">${ic('chef-hat', 40)}<p>Tidak ada pesanan yang menunggu. Pesanan baru dari kasir dan QR meja muncul di sini otomatis.</p></div>`}</div>
    ${done.length ? `<h3 class="kds-sub">Semua item sudah siap</h3><div class="kds-done">${done.map((o) => { const w = kLines(o).filter((l) => l.s === 'ready').length; return `<div class="kd"><b>${esc(o.no)}</b><span>${where(o)}</span><span class="badge ${w ? 'b-ok' : 'b-mute'}">${w ? `${w} item menunggu diantar` : 'Sudah diantar'}</span><button class="btn btn-sm btn-ghost" data-a="recall" data-o="${o.id}" title="Kembalikan semua item nota ini ke antrean">Kembalikan</button></div>`; }).join('')}</div>` : ''}`;
}

function analysis(ctx) {
  const db = ctx.db, L = ctx.outlet, sla = db.settings.slaMin;
  const from = ui.range === 'today' ? startOfDay() : ui.range === '7d' ? startOfDay() - 6 * DAY : startOfDay() - 27 * DAY;
  const rows = [];
  for (const o of db.orders) {
    if (o.loc !== L || o.created < from) continue;
    for (const l of o.lines) if (l.ts && l.tr && l.st !== 'none' && l.s !== 'void' && (ui.station === 'all' || l.st === ui.station)) rows.push({ m: l.m, n: l.n, st: l.st, h: new Date(l.ts).getHours(), t: (l.tr - l.ts) / 60000, q: l.q });
  }
  if (!rows.length) return `<p class="empty">Belum ada data serving time di periode ini.</p>`;
  const avg = sum(rows, (r) => r.t) / rows.length;
  const sorted = rows.map((r) => r.t).sort((a, b) => a - b);
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  const ok = rows.filter((r) => r.t <= sla).length / rows.length;
  const byH = {};
  rows.forEach((r) => { (byH[r.h] ||= []).push(r.t); });
  const hours = Array.from({ length: 13 }, (_, i) => 9 + i).filter((h) => h < 22);
  const hData = hours.map((h) => ({ label: String(h), value: byH[h] ? sum(byH[h]) / byH[h].length : 0, tip: `Jam ${h}.00, ${byH[h]?.length || 0} item` }));
  const byM = {};
  rows.forEach((r) => { const x = (byM[r.m] ||= { n: r.n, st: r.st, c: 0, t: 0, late: 0, max: 0 }); x.c++; x.t += r.t; x.max = Math.max(x.max, r.t); if (r.t > sla) x.late++; });
  const ms = Object.values(byM).sort((a, b) => b.t / b.c - a.t / a.c);
  const fmtM = (v) => num(v, 1) + ' mnt';
  return `<div class="chips">${[['today', 'Hari ini'], ['7d', '7 hari'], ['28d', '28 hari']].map(([k, l]) => `<button class="chip ${ui.range === k ? 'on' : ''}" data-a="range" data-v="${k}">${l}</button>`).join('')}
      ${[['all', 'Semua stasiun'], ['dapur', 'Dapur'], ['bar', 'Bar']].map(([k, l]) => `<button class="chip ${ui.station === k ? 'on' : ''}" data-a="station" data-v="${k}">${l}</button>`).join('')}</div>
    <div class="kpis">
      <div class="kpi"><span class="kpi-l">Rata-rata serving time</span><b class="kpi-v">${fmtM(avg)}</b><span class="kpi-d">target ${sla} menit</span></div>
      <div class="kpi"><span class="kpi-l">Tepat waktu</span><b class="kpi-v ${ok < 0.85 ? 'neg' : 'pos'}">${pct(ok)}</b><span class="kpi-d">item selesai ≤ ${sla} menit</span></div>
      <div class="kpi"><span class="kpi-l">90% item selesai dalam</span><b class="kpi-v">${fmtM(p90)}</b><span class="kpi-d">persentil ke-90</span></div>
      <div class="kpi"><span class="kpi-l">Item diproses</span><b class="kpi-v">${num(rows.length)}</b><span class="kpi-d">${num(rows.filter((r) => r.t > sla).length)} terlambat</span></div>
    </div>
    <div class="card"><div class="card-h"><h3>Rata-rata serving time per jam</h3><span class="muted sm">menit, dari tiket masuk sampai siap</span></div>${barChart(hData, { fmt: fmtM, height: 170 })}</div>
    <div class="card"><div class="card-h"><h3>Per menu</h3><span class="muted sm">diurutkan dari yang paling lama</span></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Menu</th><th>Stasiun</th><th class="r">Item</th><th class="r">Rata-rata</th><th class="r">Terlama</th><th class="r">Terlambat</th></tr></thead>
      <tbody>${ms.map((x) => `<tr><td>${esc(x.n)}</td><td>${D.STATION_LABEL[x.st]}</td><td class="r">${x.c}</td><td class="r ${x.t / x.c > sla ? 'neg' : ''}">${fmtM(x.t / x.c)}</td><td class="r">${fmtM(x.max)}</td><td class="r">${pct(x.late / x.c)}</td></tr>`).join('')}</tbody></table></div></div>`;
}

export default {
  render(ctx) {
    const db = ctx.db;
    if (ui.tab === 'live') {
      const ids = activeTickets(db, ctx.outlet).flatMap((o) => kLines(o).filter((l) => l.s === 'new').map((l) => l.id));
      // Bunyi pendek hanya bila notifikasi "pesanan baru/tambahan dari kasir" dimatikan (supaya tidak dobel)
      if (seen && ctx.src === 'remote' && ids.some((id) => !seen.has(id)) && !enabled('k_new') && !enabled('k_add')) play('ticket', {}, { voice: false });
      seen = new Set(ids);
    }
    return `<div class="kitchen"><div class="tabs">${[['live', 'Layar dapur'], ['analisa', 'Analisa serving time']].map(([k, l]) => `<button class="tab ${ui.tab === k ? 'on' : ''}" data-a="tab" data-v="${k}">${l}</button>`).join('')}</div>
      ${ui.tab === 'live' ? live(ctx) : analysis(ctx)}</div>`;
  },
  unmount() { seen = null; },
  actions: {
    tab(el) { ui.tab = el.dataset.v; rerender(); },
    station(el) { ui.station = el.dataset.v; setKdsStation(ui.station); rerender(); },
    range(el) { ui.range = el.dataset.v; rerender(); },
    cookTg(el) {
      const o = D.order(getDb(), el.dataset.o), l = o?.lines.find((x) => x.id === el.dataset.l);
      if (l) step(o.id, l.id, l.s === 'new' ? 'cook' : 'uncook');
    },
    ready(el) {
      const o = D.order(getDb(), el.dataset.o), l = o?.lines.find((x) => x.id === el.dataset.l);
      step(el.dataset.o, el.dataset.l, 'ready');
      if (l) toast(`${num(l.q)}× ${l.n} siap. Pramusaji & kasir diberi tahu untuk mengantar${o.table ? ' ke meja ' + o.table : ''}.`);
    },
    back(el) { step(el.dataset.o, el.dataset.l, 'back'); },
    bump(el) {
      const o = D.order(getDb(), el.dataset.o); if (!o) return;
      const n = kLines(o).filter((l) => l.s === 'new' || l.s === 'cook').length;
      local((d) => { const oo = D.order(d, o.id); for (const l of kLines(oo)) if (l.s === 'new' || l.s === 'cook') D.setLineStatus(d, oo, l.id, 'ready'); });
      API.orderOp(o.id, () => API.bump(o.id, ui.station === 'all' ? null : ui.station)).catch(fail);
      toast(`${n} item ${o.no} siap. Pramusaji & kasir diberi tahu.`); rerender();
    },
    recall(el) {
      const oid = el.dataset.o;
      local((d) => { const o = D.order(d, oid); for (const l of kLines(o)) if (l.s === 'ready' || l.s === 'served') l.s = 'cook'; o.readyAt = null; o.pickedAt = null; d.notices.filter((n) => n.order === oid).forEach((n) => (n.seen = true)); });
      API.orderOp(oid, () => API.recall(oid)).catch(fail);
      rerender();
    },
  },
};

function step(oid, lid, to) {
  local((d) => {
    const o = D.order(d, oid); const l = o?.lines.find((x) => x.id === lid); if (!l) return;
    if (to === 'back') { l.s = 'cook'; l.tr = null; o.readyAt = null; d.notices.filter((n) => n.line === lid).forEach((n) => (n.seen = true)); }
    else if (to === 'uncook') { l.s = 'new'; l.tc = null; }
    else D.setLineStatus(d, o, lid, to);
  });
  API.orderOp(oid, () => API.kitchenLine(lid, to)).catch(fail);
  rerender();
}
