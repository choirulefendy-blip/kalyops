// Kaly POS — kasir, meja, split bill, promo, voucher, member, deposit, shift, deteksi fraud
import { local, getDb, currentUser, pushDisplay, readDisplay, setTerminal, getTerminal } from '../store.js';
import * as API from '../api.js';
import * as C from '../cloud.js';
import { $, $$, esc, ic, rp, num, toast, openModal, askReason, askPin, confirmBox, fmtTime, fmtDT, fmtDate, sum, qrSvg, uid, formData, startOfDay } from '../lib.js';
import * as D from '../domain.js';
import { stockSnap, stockAlert } from '../stock-alert.js';
import { menuPic, qrisUrl } from '../media.js';
import { ackOrder } from '../notify.js';
import { rerender, ctxNow } from '../app.js';
import { moveDialog, heldDialog, heldListDialog, heldTables, clearTable } from './table-actions.js';
import { doPrint, sendPrints, KIND_LABEL } from '../printing.js';

const ui = { tab: 'meja', area: 'all', cat: 'all', q: '', orderId: null, pending: null, depQ: '' };
const ST = { draft: ['Belum dikirim', 'b-mute'], new: ['Antre', 'b-info'], cook: ['Dimasak', 'b-warn'], ready: ['Siap', 'b-ok'], served: ['Diantar', 'b-mute'], void: ['Batal', 'b-err'] };
export const TERMINALS = ['Kasir 1', 'Kasir 2', 'Kasir 3', 'Play Corner'];

const curOrder = (db) => { const o = ui.orderId && D.order(db, ui.orderId); return o && o.status === 'open' ? o : null; };
const failToast = (e) => toast(e?.message || 'Gagal menyimpan ke server', 'err', 5000);
// Jalankan perubahan bill di server (berurutan per bill), tampilkan error tanpa menghentikan layar
const op = (id, fn) => API.orderOp(id, fn);
const openOrders = (db, L) => db.orders.filter((o) => o.loc === L && o.status === 'open' && o.released !== false && !o.payPending);
const tableOrder = (db, L, t) => openOrders(db, L).find((o) => o.table === t || o.merged?.includes(t));

// Dipanggil dari Denah meja: pilih bill atau meja sebelum pindah ke POS
export function openFromDenah({ orderId, table, merged, res, cust, mem }) {
  ui.tab = 'meja';
  ui.orderId = orderId || null;
  ui.pending = orderId ? null : { table, ...(merged?.length ? { merged } : {}), ...(res ? { res, cust, mem } : {}) };
}

function upcomingRes(db, tableId) {
  const now = Date.now();
  return db.reservations.find((r) => D.resTables(r).includes(tableId) && ['menunggu', 'dikonfirmasi', 'datang'].includes(r.status) && D.resStart(r) - now < 120 * 60000 && D.resStart(r) - now > -(r.status === 'datang' ? 180 : 45) * 60000);
}

function ensureOrder(d, ctx) {
  let o = ui.orderId && D.order(d, ui.orderId);
  if (o && o.status === 'open') return o;
  const p = ui.pending || {};
  // Resto (outlet berdenah) selalu memakai meja; tanpa meja hanya untuk outlet seperti Play Corner
  if (!p.table && D.hasTables(d, ctx.outlet)) return null;
  o = D.newOrder(d, { loc: ctx.outlet, ch: 'pos', type: p.table ? 'dine' : 'take', table: p.table || null, by: ctx.user.id, term: ctx.terminal, cust: p.cust || {}, mem: p.mem || null });
  if (p.merged?.length) o.merged = [...p.merged];
  o.no = 'Bill baru';
  if (p.res) { o.res = p.res; const r = d.reservations.find((x) => x.id === p.res); if (r) { r.status = 'datang'; r.order = o.id; } }
  ui.orderId = o.id; ui.pending = null;
  o.isNew = true;
  return o;
}

// ---------- Panel kiri ----------
function leftPanel(ctx) {
  const db = ctx.db, L = ctx.outlet;
  const hasTables = db.tables.some((t) => t.loc === L);
  const tabs = [hasTables && ['meja', 'Meja'], ['order', 'Bill'], ['siap', 'Checker'], ['deposit', 'Deposit'], ['shift', 'Shift']].filter(Boolean);
  if (!hasTables && ui.tab === 'meja') ui.tab = 'order';
  const readyN = D.readyItems(db, L, startOfDay() - 6 * 3600000).length;  // item siap, menunggu diantar
  let body = '';
  if (ui.tab === 'meja') body = tablesPanel(ctx);
  else if (ui.tab === 'order') body = ordersPanel(ctx);
  else if (ui.tab === 'siap') body = readyPanel(ctx);
  else if (ui.tab === 'deposit') body = depositPanel(ctx);
  else body = shiftPanel(ctx);
  return `<div class="tabs tabs-sm">${tabs.map(([k, l]) => `<button class="tab ${ui.tab === k ? 'on' : ''}" data-a="tab" data-v="${k}">${l}${k === 'siap' && readyN ? ` <b class="cnt">${readyN}</b>` : ''}</button>`).join('')}</div><div class="pos-left-b" data-keep-scroll="left">${body}</div>`;
}
function tablesPanel(ctx) {
  const db = ctx.db, L = ctx.outlet;
  const tables = db.tables.filter((t) => t.loc === L && (ui.area === 'all' || t.area === ui.area));
  const areas = [...new Set(db.tables.filter((t) => t.loc === L).map((t) => t.area))];
  const busy = db.tables.filter((t) => t.loc === L && (tableOrder(db, L, t.id) || t.hold)).length;
  const held = heldTables(db, L).length;
  return `<div class="chips">${['all', ...areas].map((a) => `<button class="chip ${ui.area === a ? 'on' : ''}" data-a="area" data-v="${esc(a)}">${a === 'all' ? 'Semua' : esc(a)}</button>`).join('')}</div>
    <div class="row sb tb-head"><p class="muted sm">${busy} dari ${db.tables.filter((t) => t.loc === L).length} meja terisi</p><span class="row-xs">${held ? `<button class="btn btn-sm btn-paid" data-a="heldList" title="Meja sudah dibayar, belum dikosongkan">${ic('armchair', 15)} ${held} lunas</button>` : ''}<a class="btn btn-sm" href="#/denah">${ic('map', 15)} Denah</a></span></div>
    <div class="tables">${tables.map((t) => {
      const o = tableOrder(db, L, t.id);
      const r = !o && upcomingRes(db, t.id);
      const ks = o && (D.kitchenLines(o).some((l) => l.s === 'ready') ? 'ready' : D.kitchenState(o));
      const held = !o && t.hold;
      const cls = o ? (ks === 'ready' ? 'ready' : 'busy') : held ? 'paid' : r ? 'res' : 'free';
      const sel = (o && o.id === ui.orderId) || ui.pending?.table === t.id;
      const tot = o ? D.bill(db, o).total : 0;
      return `<button class="tb ${cls} ${sel ? 'sel' : ''}" data-a="table" data-id="${t.id}" aria-label="Meja ${t.id}${held ? ', sudah dibayar, belum dikosongkan' : ''}">
        <span class="tb-n">${t.id}</span><span class="tb-s">${t.seats} kursi</span>
        ${o ? `<span class="tb-o">${esc(o.no)}${o.merged?.length ? ' +' + o.merged.join('+') : ''}</span><span class="tb-t" data-since="${o.created}" data-fmt="min"></span><span class="tb-v">${rp(tot)}</span>${ks === 'ready' ? `<span class="tb-flag">Siap antar</span>` : ''}`
          : held ? `<span class="tb-o" title="Sudah dibayar, meja belum dikosongkan service">Lunas</span><span class="tb-t" data-since="${t.hold.at}" data-fmt="min"></span><span class="tb-v">Kosongkan</span>`
          : r ? `<span class="tb-o">Reservasi ${esc(r.time)}</span><span class="tb-v">${esc(r.name)}, ${r.pax} org</span>` : `<span class="tb-o muted">Kosong</span>`}
      </button>`;
    }).join('')}</div>`;
}
function ordersPanel(ctx) {
  const db = ctx.db, L = ctx.outlet;
  const os = openOrders(db, L).sort((a, b) => b.created - a.created);
  const t0 = new Date().setHours(0, 0, 0, 0);
  const proc = db.orders.filter((o) => o.loc === L && o.status === 'paid' && o.created >= t0 && ['new', 'cook'].includes(D.kitchenState(o)));
  const sched = db.orders.filter((o) => o.loc === L && o.sched && !o.released && o.status !== 'void');
  const row = (o, extra = '') => `<button class="ol ${o.id === ui.orderId ? 'sel' : ''}" data-a="selOrder" data-id="${o.id}"><span><b>${esc(o.no)}</b> ${o.table ? 'Meja ' + esc(o.table) : esc(D.TYPE_LABEL[o.type])}${o.ch !== 'pos' ? ` <span class="badge b-info">${D.CH_LABEL[o.ch]}</span>` : ''}<small>${esc(o.cust?.name || '')} ${extra}</small></span><span class="ol-r"><b>${rp(D.bill(db, o).total)}</b><small data-since="${o.created}" data-fmt="min"></small></span></button>`;
  const tbl = D.hasTables(db, L);
  return `${tbl ? '' : `<button class="btn btn-pri btn-block" data-a="newTake">${ic('plus')} Pesanan baru</button>`}
    <h4 class="sec-t">Bill terbuka <span class="muted">${os.length}</span></h4>
    ${os.length ? `<div class="olist">${os.map((o) => row(o)).join('')}</div>` : `<p class="empty sm">Belum ada bill terbuka. ${tbl ? 'Pilih meja di tab Meja untuk membuka bill.' : 'Ketuk Pesanan baru atau langsung pilih menu.'}</p>`}
    ${proc.length ? `<h4 class="sec-t">Sudah dibayar, sedang dibuat <span class="muted">${proc.length}</span></h4><div class="olist">${proc.map((o) => `<div class="ol static"><span><b>${esc(o.no)}</b> ${esc(D.TYPE_LABEL[o.type])} <small>${esc(o.cust?.name || '')}</small></span><span class="badge ${D.kitchenState(o) === 'cook' ? 'b-warn' : 'b-info'}">${D.kitchenState(o) === 'cook' ? 'Dimasak' : 'Antre'}</span></div>`).join('')}</div>` : ''}
    ${sched.length ? `<h4 class="sec-t">Terjadwal</h4><div class="olist">${sched.map((o) => `<div class="ol static"><span><b>${esc(o.no)}</b> ${esc(D.TYPE_LABEL[o.type])}<small>${esc(o.cust?.name || '')}, masuk dapur ${fmtTime(o.sched - db.settings.scheduleLead * 60000)}</small></span><span class="badge b-gold">${fmtTime(o.sched)}</span></div>`).join('')}</div>` : ''}`;
}
// Checker: setiap nota yang masih punya item belum diantar, dengan status tiap menu dan tombol Antar per item
const CK = { new: ['Antre', 'b-info'], cook: ['Dimasak', 'b-warn'], ready: ['Siap', 'b-ok'], served: ['Diantar', 'b-mute'] };
export function checkerOrders(db, L) {
  const t0 = startOfDay() - 6 * 3600000;
  const first = (o) => Math.min(...D.kitchenLines(o).map((l) => l.ts || o.created));
  return db.orders.filter((o) => o.loc === L && o.status !== 'void' && o.released !== false && o.created >= t0 && D.kitchenLines(o).some((l) => l.s !== 'served'))
    .sort((a, b) => (D.kitchenLines(b).some((l) => l.s === 'ready') - D.kitchenLines(a).some((l) => l.s === 'ready')) || first(a) - first(b));
}
function readyPanel(ctx) {
  const db = ctx.db, L = ctx.outlet;
  const os = checkerOrders(db, L);
  if (!os.length) return `<p class="empty sm">Semua item sudah diantar. Nota yang dikirim ke dapur muncul di sini dengan status tiap menunya.</p>`;
  return `<p class="muted sm">Antar per item tanpa menunggu satu nota selesai. Item <b>Siap</b> sudah ditandai dapur; item lain tetap bisa diantar bila sudah keluar dari dapur.</p>
    <div class="ck-list">${os.map((o) => {
      const ls = D.kitchenLines(o), rd = ls.filter((l) => l.s === 'ready');
      return `<section class="ck${rd.length ? ' has-ready' : ''}"><header class="ck-h"><button class="dn-link" data-a="selOrder" data-id="${o.id}" ${o.status === 'open' ? '' : 'disabled'}><b>${o.table ? 'Meja ' + esc([o.table, ...(o.merged || [])].join('+')) : esc(o.cust?.name || D.TYPE_LABEL[o.type])}</b><small>${esc(o.no)}${o.status === 'paid' ? ' · lunas' : ''} · <span data-since="${Math.min(...ls.map((l) => l.ts || o.created))}" data-fmt="min"></span></small></button><span class="ck-prog">${ls.filter((l) => l.s === 'served').length}/${ls.length} diantar</span></header>
        <ul class="ck-l">${ls.map((l) => { const [lab, cls] = CK[l.s] || ['', 'b-mute']; return `<li class="s-${l.s}"><span class="ck-n"><b>${num(l.q)}×</b> ${esc(l.n)}${l.note ? `<small>${esc(l.note)}</small>` : ''}</span><span class="badge ${cls}">${lab}</span>${l.s === 'served' ? `<span class="ck-t">${fmtTime(l.tv || Date.now())}</span>` : `<button class="btn btn-xs ${l.s === 'ready' ? 'btn-pri' : ''}" data-a="serveLine" data-o="${o.id}" data-l="${l.id}" aria-label="Antar ${esc(l.n)}">${ic('check', 13)} Antar</button>`}</li>`; }).join('')}</ul>
        ${rd.length > 1 ? `<button class="btn btn-sm btn-block" data-a="serveAll" data-id="${o.id}">${ic('hand-platter', 15)} Antar ${rd.length} item yang siap</button>` : ''}</section>`;
    }).join('')}</div>`;
}
function depositPanel(ctx) {
  const db = ctx.db;
  const q = ui.depQ.trim().toLowerCase();
  const list = q ? db.deposits.filter((c) => c.id.toLowerCase().includes(q) || c.holder.toLowerCase().includes(q) || c.phone.includes(q)).slice(0, 12) : db.deposits.slice().sort((a, b) => b.balance - a.balance).slice(0, 8);
  return `<p class="muted sm">Kartu deposit dipakai di Resto dan Play Corner seperti kartu food court. Saldo tercatat sebagai kewajiban di laporan keuangan.</p>
    <div class="row"><input class="inp" id="dep-q" data-in="depQ" placeholder="Cari no. kartu, nama, HP" value="${esc(ui.depQ)}"><button class="btn" data-a="depNew">${ic('plus', 16)} Kartu baru</button></div>
    <div class="olist">${list.map((c) => `<div class="ol static"><span><b>${esc(c.id)}</b> ${esc(c.holder)}<small>${esc(c.phone)}</small></span><span class="ol-r"><b>${rp(c.balance)}</b><span class="row-xs"><button class="btn btn-sm" data-a="depTopup" data-id="${c.id}">Top-up</button><button class="btn btn-sm btn-ghost" data-a="depRefund" data-id="${c.id}" title="Refund saldo tunai">Refund</button></span></span></div>`).join('') || '<p class="empty sm">Kartu tidak ditemukan</p>'}</div>`;
}
function shiftPanel(ctx) {
  const db = ctx.db;
  const sh = D.activeShift(db, ctx.terminal);
  const others = db.shifts.filter((s) => !s.closeAt && s.term !== ctx.terminal);
  const s = sh && D.shiftSummary(db, sh);
  return `<label class="fld"><span>Terminal ini</span><select data-a-change="terminal">${TERMINALS.map((t) => `<option ${t === ctx.terminal ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    ${sh ? `<div class="card sub"><div class="row sb"><b>Shift ${esc(D.userName(db, sh.user))}</b><span class="badge b-ok">Aktif</span></div>
      <dl class="kv"><dt>Dibuka</dt><dd>${fmtTime(sh.openAt)}</dd><dt>Modal awal</dt><dd>${rp(sh.openCash)}</dd><dt>Transaksi</dt><dd>${s.count}</dd><dt>Penjualan</dt><dd>${rp(s.total)}</dd>
      ${Object.entries(s.by).map(([m, a]) => `<dt>${D.PAY[m].label}</dt><dd>${rp(a)}</dd>`).join('')}<dt>Top-up deposit tunai</dt><dd>${rp(s.topCash)}</dd><dt>Kas seharusnya</dt><dd><b>${rp(s.expected)}</b></dd></dl>
      <div class="row"><button class="btn" data-a="noSale">${ic('banknote', 16)} Buka laci</button><button class="btn btn-pri" data-a="shiftClose">Tutup shift</button></div></div>`
      : `<div class="card sub"><p>Belum ada shift aktif di <b>${esc(ctx.terminal)}</b>. Pembayaran hanya bisa diproses setelah shift dibuka.</p><button class="btn btn-pri btn-block" data-a="shiftOpen">Buka shift</button></div>`}
    ${others.length ? `<h4 class="sec-t">Kasir aktif lain</h4><div class="olist">${others.map((o) => `<div class="ol static"><span><b>${esc(o.term)}</b> ${esc(D.userName(db, o.user))}<small>sejak ${fmtTime(o.openAt)}</small></span><span class="badge b-ok">Aktif</span></div>`).join('')}</div>` : ''}
    <h4 class="sec-t">Riwayat shift</h4><div class="olist">${db.shifts.filter((x) => x.closeAt).slice(0, 6).map((x) => `<div class="ol static"><span><b>${esc(x.term)}</b> ${esc(D.userName(db, x.user))}<small>${fmtDT(x.openAt)} sampai ${fmtTime(x.closeAt)}</small></span><span class="badge ${Math.abs(x.var || 0) > db.settings.cashVarTol ? 'b-err' : 'b-mute'}">Selisih ${rp(x.var || 0)}</span></div>`).join('')}</div>`;
}

// ---------- Menu ----------
function menuGrid(ctx) {
  const db = ctx.db, L = ctx.outlet, q = ui.q.trim().toLowerCase();
  const ms = db.menus.filter((m) => D.menuAvail(db, m.id, L) && (ui.cat === 'all' || m.cat === ui.cat) && (!q || m.name.toLowerCase().includes(q)));
  const promoMenus = new Set();
  for (const p of db.promos) if (D.promoActive(p) && (!p.outlets || p.outlets.includes(L))) db.menus.forEach((m) => { if ((p.type === 'pct-cat' && m.cat === p.cat) || (p.type === 'bxgy' && m.id === p.menu)) promoMenus.add(m.id); });
  if (!ms.length) return `<p class="empty">Menu tidak ditemukan.</p>`;
  const tile = (m) => {
    const why = D.menuBlock(db, m.id, L);
    const off = !!why;
    const por = !off && D.stockGuardOn(db) ? D.menuPortions(db, m, L) : null;
    const lim = why === 'bahan' ? D.item(db, D.menuPortions(db, m, L).limit)?.name : '';
    const title = why === 'bahan' ? `Bahan tidak cukup${lim ? ': ' + lim : ''}` : why ? 'Menu sedang habis' : '';
    return `<button class="mi cc-${D.catColor(db, m.cat)} ${off ? 'off' : ''}" data-a="add" data-id="${m.id}" ${off ? `disabled title="${esc(title)}"` : ''}>${menuPic(m, 'sm', 'mi-pic')}<span class="mi-n">${esc(m.name)}</span><span class="mi-p">${off ? '' : rp(m.price)}</span>
      <span class="mi-tags">${promoMenus.has(m.id) ? '<span class="badge b-gold">Promo</span>' : ''}${m.tags?.includes('new') ? '<span class="badge b-info">Baru</span>' : ''}${m.tags?.includes('best') ? '<span class="badge b-ok">Terlaris</span>' : ''}${m.pkg ? '<span class="badge b-mute">Paket</span>' : ''}${why === 'bahan' ? '<span class="badge b-err">Bahan habis</span>' : off ? '<span class="badge b-err">Habis</span>' : por && por.n <= 5 ? `<span class="badge b-warn">Sisa ${por.n}</span>` : ''}</span></button>`;
  };
  if (ui.cat !== 'all' || q) return ms.map(tile).join('');
  // Semua: dikelompokkan per kategori supaya tidak tercampur
  const known = new Set(db.cats.map((c) => c.id));
  const grp = (c, list) => list.length ? `<div class="mg-h cc-${c.id === '__none' ? 'slate' : D.catColor(db, c.id)}"><i class="cdot"></i><b>${esc(c.name)}</b><small>${list.length}</small></div>${list.map(tile).join('')}` : '';
  return db.cats.map((c) => grp(c, ms.filter((m) => m.cat === c.id))).join('') + grp({ id: '__none', name: 'Lainnya' }, ms.filter((m) => !known.has(m.cat)));
}
function recoStrip(ctx) {
  const db = ctx.db, o = curOrder(db);
  const ids = o ? [...new Set(o.lines.filter((l) => !l.par && l.s !== 'void').map((l) => l.m))] : [];
  const rec = ids.length ? D.coBought(db, ids, 3, ctx.outlet) : D.topNow(db, new Date().getHours(), 3, ctx.outlet);
  if (!rec.length) return '';
  return `<div class="reco">${ic('sprout', 16)}<span>${ids.length ? 'Sering dipesan bersama' : 'Laris di jam segini'}</span>${rec.map((r) => { const m = D.menu(db, r.m); return `<button class="chip chip-add" data-a="add" data-id="${m.id}">${ic('plus', 14)} ${esc(m.name)}${r.conf ? ` <small>${Math.round(r.conf * 100)}%</small>` : ''}</button>`; }).join('')}</div>`;
}

// ---------- Bill ----------
// Layar "Terima kasih" di layar pelanggan dibiarkan tampil 10 detik sebelum kembali ke layar promo
function pushIdle(ctx) {
  const d = readDisplay();
  if (d?.status === 'thanks' && d.term === ctx.terminal && Date.now() - d.at < 10000) return;
  pushDisplay({ term: ctx.terminal, status: 'idle', loc: ctx.outlet });
}
function billPanel(ctx) {
  const db = ctx.db, o = curOrder(db), p = ui.pending;
  if (!o && !p) {
    pushIdle(ctx);
    return `<div class="bill-empty">${ic('receipt', 36)}<p>${D.hasTables(db, ctx.outlet) ? 'Pilih meja untuk mulai. Setiap pesanan di Resto memakai meja.' : 'Ketuk menu untuk mulai pesanan baru.'}</p></div>`;
  }
  if (!o) {
    pushIdle(ctx);
    const r = p.res && db.reservations.find((x) => x.id === p.res);
    return `<div class="bill-h"><div><b class="bill-no">${p.table ? 'Meja ' + esc([p.table, ...(p.merged || [])].join(' + ')) : 'Pesanan baru'}</b><small>${r ? `Reservasi ${esc(r.name)}, ${r.pax} orang` : 'Belum ada item'}</small></div><button class="btn-icon" data-a="clearSel" aria-label="Tutup">${ic('x')}</button></div>
      <div class="bill-empty sm"><p>Ketuk menu di tengah untuk menambahkan item.</p></div>`;
  }
  const b = D.bill(db, o);
  const m = o.mem && D.member(db, o.mem);
  const t = m && D.tierOf(db, m);
  const draftN = o.lines.filter((l) => l.s === 'draft' && !l.pkg && !l.par).length + o.lines.filter((l) => l.s === 'draft' && l.pkg).length;
  const top = o.lines.filter((l) => !l.par);
  const res = o.res && db.reservations.find((x) => x.id === o.res);
  if (ui.paying !== o.id) pushDisplay({ term: ctx.terminal, status: 'cart', loc: ctx.outlet, no: o.no, lines: top.filter((l) => l.s !== 'void').map((l) => ({ m: l.m, n: l.n, q: l.q, a: l.q * l.p })), bill: b, member: m ? { name: m.name, tier: t.name, points: m.points } : null });
  return `<div class="bill-h"><div><b class="bill-no">${esc(o.no)} ${o.table ? `<span class="muted">Meja ${esc(o.table)}${o.merged?.length ? ' + ' + o.merged.join(' + ') : ''}</span>` : ''}</b>
      <small>${o.table ? '' : `<span class="badge b-mute">${esc(D.TYPE_LABEL[o.type] || '')}</span> `}${o.ch !== 'pos' ? `<span class="badge b-info">${D.CH_LABEL[o.ch]}</span>` : ''}</small></div>
      <div class="row-xs">${o.table ? `<button class="btn-icon" data-a="moveTbl" aria-label="Pindah meja" title="Pindah ke meja lain">${ic('arrow-left-right')}</button>` : ''}<button class="btn-icon" data-a="more" aria-label="Aksi lain" title="Pindah, gabung, split, batal">${ic('menu')}</button><button class="btn-icon" data-a="clearSel" aria-label="Tutup bill">${ic('x')}</button></div></div>
    <div class="bill-cust">
      <input class="inp inp-sm" id="pos-cust" data-a-change="cust" placeholder="Nama pelanggan" value="${esc(o.cust?.name || '')}">
      ${m ? `<button class="mem-chip" data-a="member">${ic('award', 15)} ${esc(m.name)} <span class="badge b-gold">${esc(t.name)}</span> ${num(m.points)} poin</button><button class="btn-icon sm" data-a="unlinkMember" aria-label="Lepas member">${ic('x', 15)}</button>` : `<button class="btn btn-sm" data-a="member">${ic('award', 15)} Member</button>`}
    </div>
    ${res ? `<p class="res-note">${ic('calendar-check', 15)} Reservasi ${esc(res.code)}: ${esc(res.name)}, ${res.pax} orang${res.note ? '. ' + esc(res.note) : ''}</p>` : ''}
    <div class="bill-lines" data-keep-scroll="bill">${top.map((l) => {
      const comps = o.lines.filter((c) => c.par === l.id);
      const [sl, sc] = ST[l.s];
      return `<div class="bl ${l.s === 'void' ? 'void' : ''}">
        <div class="bl-main"><span class="bl-n">${esc(l.n)}${l.note ? `<small class="note">${esc(l.note)}</small>` : ''}${comps.length ? `<small>${comps.map((c) => `${c.q}× ${esc(c.n)} <i class="dot ${c.s}"></i>`).join(', ')}</small>` : ''}</span>
          <span class="bl-a">${rp(l.q * l.p)}</span></div>
        <div class="bl-ctl">${l.s === 'draft' ? `<span class="qty"><button data-a="qty" data-id="${l.id}" data-d="-1" aria-label="Kurangi">${ic('minus', 14)}</button><b>${l.q}</b><button data-a="qty" data-id="${l.id}" data-d="1" aria-label="Tambah">${ic('plus', 14)}</button></span><button class="lnk" data-a="note" data-id="${l.id}">Catatan</button>`
          : `<span class="qty-ro">${l.q}×</span>`}
          <span class="badge ${comps.length ? (comps.every((c) => c.s === 'served' || c.s === 'ready') ? 'b-ok' : 'b-info') : sc}">${comps.length && l.s !== 'draft' && l.s !== 'void' ? 'Paket' : sl}</span>
          ${!comps.length && l.st && l.st !== 'none' && ['new', 'cook', 'ready'].includes(l.s) ? `<button class="btn btn-xs ${l.s === 'ready' ? 'btn-pri' : ''}" data-a="serveLine" data-o="${o.id}" data-l="${l.id}" title="Item ini sudah diantar ke tamu">${ic('check', 13)} Antar</button>` : ''}
          ${l.s === 'void' ? '' : l.s === 'draft' ? `<button class="btn-icon sm" data-a="rmLine" data-id="${l.id}" aria-label="Hapus">${ic('trash-2', 15)}</button>` : `<button class="btn-icon sm" data-a="voidLine" data-id="${l.id}" aria-label="Batalkan item" title="Batalkan item (perlu alasan)">${ic('rotate-ccw', 15)}</button>`}
        </div></div>`;
    }).join('') || '<p class="empty sm">Belum ada item.</p>'}</div>
    <div class="bill-disc">
      <div class="row"><input class="inp inp-sm" id="pos-voucher" placeholder="Kode voucher" value="${esc(o.disc?.voucher || '')}"><button class="btn btn-sm" data-a="voucher">Pakai</button>
      ${m ? `<button class="btn btn-sm" data-a="points" ${m.points < 10 ? 'disabled' : ''}>Tukar poin</button>` : ''}<button class="btn btn-sm" data-a="manualDisc">${ic('percent', 14)} Diskon</button></div>
    </div>
    <dl class="bill-tot"><dt>Subtotal</dt><dd>${rp(b.sub)}</dd>
      ${b.discs.map((d) => `<dt class="disc">${esc(d.label)} ${['voucher', 'points', 'manual'].includes(d.kind) ? `<button class="lnk" data-a="rmDisc" data-k="${d.kind}">hapus</button>` : ''}</dt><dd class="disc">-${rp(d.amt)}</dd>`).join('')}
      ${b.svc ? `<dt>Service</dt><dd>${rp(b.svc)}</dd>` : ''}<dt>PB1 ${Math.round(db.settings.taxRate * 100)}%</dt><dd>${rp(b.tax)}</dd>${b.deliv ? `<dt>Ongkir</dt><dd>${rp(b.deliv)}</dd>` : ''}
      <dt class="grand">Total</dt><dd class="grand">${rp(b.total)}</dd></dl>
    <div class="bill-act">
      <button class="btn btn-lg" data-a="send" ${draftN ? '' : 'disabled'}>${ic('send', 18)} Kirim ke dapur${draftN ? ` (${draftN})` : ''}</button>
      <button class="btn btn-lg" data-a="printSet" ${top.some((l) => l.s !== 'void') ? '' : 'disabled'} title="Cetak nota pelanggan, salinan, slip Bar & slip Dapur${draftN ? ' (item baru dikirim ke dapur dulu)' : ''}">${ic('printer', 18)} ${draftN ? 'Kirim & cetak' : 'Cetak'}</button>
      <button class="btn btn-lg btn-pri" data-a="pay" ${b.total > 0 ? '' : 'disabled'}>${ic('wallet', 18)} Bayar ${rp(b.total)}</button>
    </div>`;
}

// ---------- Lounge di kasir: hanya "Sedang disiapkan" & "Siap diambil" (pengganti layar Kaly Kitchen untuk kasir) ----------
const LKEY = 'kaly.posLounge';
let loungeOn = (() => { try { return localStorage.getItem(LKEY) !== 'off'; } catch { return true; } })();
export function loungeLists(db, L) {
  const t0 = startOfDay() - 6 * 3600000;
  const os = db.orders.filter((o) => o.loc === L && o.status !== 'void' && o.released !== false && o.created >= t0);
  const prep = os.filter((o) => ['new', 'cook'].includes(D.kitchenState(o))).sort((a, b) => a.created - b.created);
  const ready = os.filter((o) => D.kitchenState(o) === 'ready').sort((a, b) => (a.readyAt || a.created) - (b.readyAt || b.created));
  return { prep, ready };
}
const whoOf = (o) => (o.table ? `Meja ${[o.table, ...(o.merged || [])].join('+')}` : o.cust?.name || D.TYPE_LABEL[o.type]);
const isTableServe = (o) => o.type === 'dine' && !!o.table;
function loungeStrip(ctx) {
  const { prep, ready } = loungeLists(ctx.db, ctx.outlet);
  if (!loungeOn) return `<div class="pos-lounge-off"><button class="btn btn-sm" data-a="loungeTg">${ic('tv', 15)} Tampilkan Lounge · <b>${prep.length}</b> disiapkan · <b>${ready.length}</b> siap diambil</button></div>`;
  const pChip = (o) => {
    const open = o.status === 'open';
    return `<button class="lqc" ${open ? `data-a="selOrder" data-id="${o.id}" title="Buka bill ${esc(o.no)}"` : `disabled title="Sudah dibayar, menunggu dapur"`}><b>${esc(o.no)}</b><small>${esc(whoOf(o))}</small><span data-since="${o.created}" data-fmt="min" data-sla></span></button>`;
  };
  const rChip = (o) => `<div class="lqc rd"><b>${esc(o.no)}</b><small>${esc(whoOf(o))}</small><span class="lqc-t">siap <i data-since="${o.readyAt || o.created}" data-fmt="min"></i></span>
    <button class="btn btn-xs btn-pri" data-a="loungeServed" data-id="${o.id}">${ic('check', 13)} ${isTableServe(o) ? 'Diantar' : 'Diambil'}</button></div>`;
  return `<section class="pos-lounge card" aria-label="Lounge antrean">
    <div class="pl-col"><h4>${ic('flame', 16)} Sedang disiapkan <span class="pl-n">${prep.length}</span></h4><div class="pl-row" data-keep-scroll="lq-prep">${prep.map(pChip).join('') || '<p class="pl-empty">Belum ada pesanan di dapur</p>'}</div></div>
    <div class="pl-col rd"><h4>${ic('concierge-bell', 16)} Siap diambil <span class="pl-n">${ready.length}</span></h4><div class="pl-row" data-keep-scroll="lq-ready">${ready.map(rChip).join('') || '<p class="pl-empty">Nomor yang siap muncul di sini</p>'}</div></div>
    <div class="pl-tools"><a class="btn-icon sm" href="#/lounge?loc=${esc(ctx.outlet)}" target="_blank" rel="noopener" title="Buka layar Lounge untuk TV pelanggan" aria-label="Buka layar Lounge">${ic('tv', 17)}</a>
      <button class="btn-icon sm" data-a="loungeTg" title="Sembunyikan Lounge" aria-label="Sembunyikan Lounge">${ic('chevron-up', 17)}</button></div>
  </section>`;
}
async function serveOrder(id) {
  const o = D.order(getDb(), id); if (!o) return;
  const table = isTableServe(o);
  if (table) local((d) => D.serveReady(d, D.order(d, id)));
  rerender();
  await op(id, () => (table ? API.serveReady(id) : API.markServed(id)));
  await C.refresh('notices');
  toast(`${o.no} ${table ? 'sudah diantar ke meja' : 'sudah diambil'}`);
  rerender();
}

async function sendOrder(ctx, oid) {
  const before = stockSnap(ctx.db, ctx.outlet);
  const r = await op(oid, () => API.sendToKitchen(oid));
  toast(r?.kitchen_items ? `${r.kitchen_items} item dikirim ke layar dapur` : 'Item tanpa proses dapur sudah dicatat');
  await Promise.all([C.refreshOrder(oid), C.refresh('stock')]);
  stockAlert(before, ctx.outlet);
}

// ---------- Manajer/Owner: Kaly POS hanya untuk mengelola menu, impor/unduh Excel, dan tampilan nota ----------
const mui = { cat: 'all', q: '', off: false };
const isOwner = (ctx) => ctx.user.role === 'owner';
function ownerTile(db, m, L) {
  const off = !m.active || (m.outlets && !m.outlets.includes(L));
  const tags = [!m.active ? '<span class="badge b-mute">Nonaktif</span>' : m.outlets && !m.outlets.includes(L) ? '<span class="badge b-mute">Outlet lain</span>' : '',
    m.soldOut ? '<span class="badge b-err">Habis</span>' : '', m.pkg ? '<span class="badge b-mute">Paket</span>' : '',
    m.tags?.includes('new') ? '<span class="badge b-info">Baru</span>' : '', m.tags?.includes('best') ? '<span class="badge b-ok">Terlaris</span>' : '',
    !m.pkg && !(m.bom || []).length ? '<span class="badge b-warn">Resep kosong</span>' : ''].join('');
  return `<button class="mi cc-${D.catColor(db, m.cat)} ${off ? 'dim' : ''}" data-a="mEdit" data-id="${m.id}" title="Ubah ${esc(m.name)}">${menuPic(m, 'sm', 'mi-pic')}<span class="mi-n">${esc(m.name)}</span><span class="mi-p">${m.price ? rp(m.price) : '<span class="neg">Harga kosong</span>'}</span><span class="mi-tags">${tags}</span><span class="mi-edit">${ic('square-pen', 14)} Ubah</span></button>`;
}
function ownerGrid(ctx) {
  const db = ctx.db, L = ctx.outlet, q = mui.q.trim().toLowerCase();
  const ms = db.menus.filter((m) => (mui.off || (m.active && (!m.outlets || m.outlets.includes(L)))) && (mui.cat === 'all' || m.cat === mui.cat) && (!q || m.name.toLowerCase().includes(q)));
  if (!ms.length) return `<p class="empty">Menu tidak ditemukan.</p>`;
  const known = new Set(db.cats.map((c) => c.id));
  const grp = (c, list) => (list.length || (c.id !== '__none' && mui.cat === c.id) ? `<div class="mg-h cc-${c.id === '__none' ? 'slate' : D.catColor(db, c.id)}"><i class="cdot"></i><b>${esc(c.name)}</b><small>${list.length}</small>${c.id !== '__none' ? `<button class="btn btn-xs" data-a="mNew" data-cat="${c.id}">${ic('plus', 13)} Tambah</button>` : ''}</div>${list.map((m) => ownerTile(db, m, L)).join('')}` : '');
  return db.cats.filter((c) => mui.cat === 'all' || c.id === mui.cat).map((c) => grp(c, ms.filter((m) => m.cat === c.id))).join('') + (mui.cat === 'all' ? grp({ id: '__none', name: 'Lainnya' }, ms.filter((m) => !known.has(m.cat))) : '');
}
function ownerView(ctx) {
  const db = ctx.db, L = ctx.outlet;
  const act = db.menus.filter((m) => m.active && (!m.outlets || m.outlets.includes(L))), off = db.menus.filter((m) => !m.active).length;
  const noRec = act.filter((m) => !m.pkg && !(m.bom || []).length).length;
  return `<div class="pos-owner">
    <div class="banner info">${ic('info', 18)}<span>Akses Manajer/Owner: Kaly POS dipakai untuk <b>mengelola menu</b>. Transaksi, meja, dan pembayaran dilakukan dari akun kasir. Ketuk menu untuk mengubah harga, kategori, stasiun, gambar, atau resepnya.</span></div>
    <section class="card pos-om">
      <div class="pom-h"><div><h3>Menu ${esc(D.loc(db, L)?.name || '')}</h3><small class="muted">${act.length} menu aktif${off ? ` · ${off} nonaktif` : ''}${noRec ? ` · ${noRec} belum punya resep` : ''}</small></div>
        <div class="row wrap pom-act"><button class="btn btn-pri" data-a="mNew">${ic('plus', 16)} Menu baru</button><button class="btn" data-a="mImport">${ic('upload', 16)} Impor dari Excel</button><button class="btn" data-a="mExport">${ic('download', 16)} Unduh Excel</button><button class="btn" data-a="mCats">${ic('palette', 16)} Kelola kategori</button><button class="btn" data-a="mReceipt">${ic('receipt', 16)} Tampilan nota</button></div></div>
      <div class="pos-menu-h"><div class="search">${ic('search', 17)}<input id="pom-q" data-in="mq" placeholder="Cari menu" value="${esc(mui.q)}" autocomplete="off"></div>
        ${off ? `<label class="switch sm"><input type="checkbox" data-a-change="mOff" ${mui.off ? 'checked' : ''}><span>Tampilkan menu nonaktif & outlet lain</span></label>` : ''}</div>
      <div class="chips">${[['all', 'Semua'], ...db.cats.map((c) => [c.id, c.name])].map(([k, l]) => `<button class="chip ${mui.cat === k ? 'on' : ''}" data-a="mCat" data-v="${k}">${k === 'all' ? '' : `<i class="cdot cc-${D.catColor(db, k)}"></i>`}${esc(l)}</button>`).join('')}</div>
      <div class="menu-grid pom-grid" id="pom-grid" data-keep-scroll="pom">${ownerGrid(ctx)}</div>
    </section></div>`;
}
const core = () => import('./core-stock.js');

function shiftBanner(ctx) {
  const db = ctx.db, sh = D.activeShift(db, ctx.terminal);
  if (ctx.user.role === 'service') return '';
  if (!sh) return `<div class="banner warn">${ic('triangle-alert', 18)}<span>Shift belum dibuka di <b>${esc(ctx.terminal)}</b>. Kamu bisa mencatat pesanan, tapi pembayaran perlu shift aktif.</span><button class="btn btn-sm btn-pri" data-a="shiftOpen">Buka shift</button></div>`;
  if (sh.user !== ctx.user.id && ctx.user.role !== 'owner') return `<div class="banner warn">${ic('lock', 18)}<span>Shift di ${esc(ctx.terminal)} milik <b>${esc(D.userName(db, sh.user))}</b>. Pindah ke terminal lain di tab Shift atau minta ${esc(D.userName(db, sh.user))} menutup shift.</span></div>`;
  return '';
}

export default {
  title: (ctx) => 'Kaly POS',
  render(ctx) {
    const db = ctx.db;
    if (isOwner(ctx)) return ownerView(ctx);
    // Dibuka dari notifikasi: #/pos?order=… (buka bill itu) atau #/pos?tab=siap
    if (ctx.q.order || ctx.q.tab) {
      const o = ctx.q.order && D.order(db, ctx.q.order);
      if (o && o.status === 'open' && o.loc === ctx.outlet) { ui.orderId = o.id; ui.pending = null; ui.tab = o.table && db.tables.some((t) => t.loc === ctx.outlet) ? 'meja' : 'order'; }
      else if (ctx.q.order) toast(o && o.status !== 'open' ? 'Bill itu sudah ditutup' : 'Bill tidak ditemukan di outlet ini', 'warn');
      if (ctx.q.tab) ui.tab = ctx.q.tab;
      delete ctx.q.order; delete ctx.q.tab;
      try { history.replaceState(null, '', '#/pos'); } catch {}
    }
    if (ui.orderId) ackOrder(ui.orderId);
    const cats = db.cats.filter((c) => db.menus.some((m) => m.cat === c.id && D.menuAvail(db, m.id, ctx.outlet)));
    if (ui.orderId && !curOrder(db)) ui.orderId = null;
    return `<div class="pos-page">${shiftBanner(ctx)}${loungeStrip(ctx)}<div class="pos">
      <section class="pos-left card">${leftPanel(ctx)}</section>
      <section class="pos-menu card">
        <div class="pos-menu-h"><div class="search">${ic('search', 17)}<input id="pos-q" data-in="q" placeholder="Cari menu" value="${esc(ui.q)}" autocomplete="off"></div>
          <span class="muted sm nowrap">${esc(ctx.terminal)}</span>${ctx.user.role === 'owner' ? `<button class="btn btn-sm" data-a="newMenu" title="Tambah menu baru">${ic('plus', 15)} Menu</button>` : ''}</div>
        <div class="chips">${[['all', 'Semua'], ...cats.map((c) => [c.id, c.name])].map(([k, l]) => `<button class="chip ${ui.cat === k ? 'on' : ''}" data-a="cat" data-v="${k}">${k === 'all' ? '' : `<i class="cdot cc-${D.catColor(db, k)}"></i>`}${esc(l)}</button>`).join('')}</div>
        <div id="pos-reco">${recoStrip(ctx)}</div>
        <div class="menu-grid" id="pos-menu-grid" data-keep-scroll="menu">${menuGrid(ctx)}</div>
      </section>
      <section class="pos-bill card">${billPanel(ctx)}</section>
    </div></div>`;
  },
  input(k, el, e, ctx) {
    if (k === 'mq') { mui.q = el.value; $('#pom-grid').innerHTML = ownerGrid(ctxNow()); return; }
    if (k === 'q') { ui.q = el.value; $('#pos-menu-grid').innerHTML = menuGrid(ctxNow()); }
    if (k === 'depQ') { ui.depQ = el.value; const b = $('.pos-left-b'); const pos = el.selectionStart; b.innerHTML = depositPanel(ctxNow()); const i = $('#dep-q'); i.focus(); i.setSelectionRange(pos, pos); }
  },
  actions: {
    tab(el) { ui.tab = el.dataset.v; rerender(); },
    area(el) { ui.area = el.dataset.v; rerender(); },
    cat(el) { ui.cat = el.dataset.v; rerender(); },
    clearSel() { ui.orderId = null; ui.pending = null; rerender(); },
    table(el, e, ctx) {
      const db = ctx.db, id = el.dataset.id;
      const o = tableOrder(db, ctx.outlet, id);
      if (o) { ui.orderId = o.id; ui.pending = null; return rerender(); }
      const tb = db.tables.find((x) => x.id === id);
      if (tb?.hold) return heldDialog(ctx, id, { newBill: () => { ui.orderId = null; ui.pending = { table: id }; rerender(); }, done: () => rerender() });
      const r = upcomingRes(db, id);
      if (r) {
        return openModal({
          title: `Meja ${id} sudah direservasi`, size: 'sm',
          body: `<p><b>${esc(r.name)}</b>, ${r.pax} orang, pukul ${esc(r.time)}${r.note ? `<br><span class="muted">${esc(r.note)}</span>` : ''}</p>`,
          footer: `<button class="btn" data-m="walk">Pakai untuk walk-in</button><button class="btn btn-pri" data-m="in">Check-in tamu reservasi</button>`,
          onMount(m, api) {
            m.addEventListener('click', (ev) => {
              const b = ev.target.closest('[data-m]'); if (!b) return;
              ui.orderId = null;
              ui.pending = b.dataset.m === 'in' ? { table: r.table || id, merged: (r.join || []).filter((x) => x !== (r.table || id)), res: r.id, cust: { name: r.name, phone: r.phone }, mem: r.mem || (D.findMemberByPhone(db, r.phone)?.id ?? null) } : { table: id };
              if (b.dataset.m === 'in') { local((d) => { const rr = d.reservations.find((x) => x.id === r.id); if (rr) rr.status = 'datang'; }); API.reservationStatus(r.id, 'datang').catch(failToast); }
              api.close(); rerender();
            });
          },
        });
      }
      ui.orderId = null; ui.pending = { table: id }; rerender();
    },
    selOrder(el) { ui.orderId = el.dataset.id; ui.pending = null; rerender(); },
    async serveAll(el) {
      const oid = el.dataset.id, o = D.order(getDb(), oid);
      const ids = D.kitchenLines(o).filter((l) => l.s === 'ready').map((l) => l.id);
      local((d) => { const oo = D.order(d, oid); ids.forEach((id) => D.serveLine(d, oo, id)); }); rerender();
      try { await op(oid, () => API.serveReady(oid)); } catch (e) { return failToast(e); }
      toast(`${ids.length} item ${o.table ? 'meja ' + o.table : o.no} sudah diantar`); rerender();
    },
    async serveLine(el) {
      const oid = el.dataset.o, lid = el.dataset.l;
      const o = D.order(getDb(), oid), l = o?.lines.find((x) => x.id === lid);
      local((d) => D.serveLine(d, D.order(d, oid), lid)); rerender();
      try { await op(oid, () => API.serveLine(lid)); } catch (e) { return failToast(e); }
      if (l) toast(`${num(l.q)}× ${l.n} sudah ${isTableServe(o) ? 'diantar' + (o.table ? ' ke meja ' + o.table : '') : 'diambil'}`);
      rerender();
    },
    heldList(el, e, ctx) { heldListDialog(ctx, { done: () => rerender() }); },
    moveTbl(el, e, ctx) { moveTable(ctx); },
    mEdit(el) { core().then((mod) => mod.actions.menuEdit(el)); },
    mNew(el) { core().then((mod) => mod.openMenuForm({ cat: el?.dataset?.cat || (mui.cat !== 'all' ? mui.cat : undefined) })); },
    mImport() { core().then((mod) => mod.actions.menuImport()); },
    mExport() { core().then((mod) => mod.exportMenusXlsx()); },
    mCats() { core().then((mod) => mod.actions.catManage()); },
    mReceipt(el, e, ctx) { import('./receipt-editor.js').then((mod) => mod.openReceiptEditor(ctx)); },
    mCat(el) { mui.cat = el.dataset.v; rerender(); },
    mOff(el) { mui.off = el.checked; rerender(); },
    newMenu() { import('./core-stock.js').then((mod) => mod.openMenuForm({ cat: ui.cat !== 'all' ? ui.cat : undefined })); },
    newTake() { ui.orderId = null; ui.pending = { type: 'take' }; rerender(); },
    add(el, e, ctx) {
      const m = D.menu(ctx.db, el.dataset.id);
      if (D.menuBlock(ctx.db, el.dataset.id, ctx.outlet)) return toast(`${m?.name || 'Menu'} sedang tidak bisa dipesan`, 'warn');
      if (!curOrder(ctx.db) && !ui.pending?.table && D.hasTables(ctx.db, ctx.outlet)) { ui.tab = 'meja'; toast('Pilih meja dulu. Setiap pesanan di Resto memakai meja.', 'warn'); return rerender(); }
      const r = local((d) => {
        const o = ensureOrder(d, ctx);
        if (!o) return { o: null };
        const isNew = !!o.isNew; delete o.isNew;
        const had = new Set(o.lines.map((l) => l.id));
        const ln = D.addLine(d, o, el.dataset.id, 1);
        return { o, ln, isNew, merged: ln && had.has(ln.id) };
      });
      if (!r.o) return rerender();
      if (r.isNew) op(r.o.id, () => API.createOrder(r.o)).catch(failToast);
      if (!r.ln) { toast(`Bahan ${m.name} hanya cukup untuk ${D.menuPortions(ctx.db, m, ctx.outlet).n} porsi`, 'warn'); return rerender(); }
      const ln = r.ln, oid = r.o.id;
      op(oid, () => (r.merged ? API.setLineQty(ln.id, ln.q) : API.insertLine(oid, ln))).catch(failToast);
      rerender();
    },
    qty(el, e, ctx) {
      const oid = ui.orderId;
      const res = local((d) => { const o = D.order(d, oid); const l = o?.lines.find((x) => x.id === el.dataset.id); if (!l) return null; const q = l.q + Number(el.dataset.d); return D.setDraftQty(o, l.id, q, d) ? { id: l.id, q } : false; });
      if (res === false) { const o = curOrder(getDb()); const l = o?.lines.find((x) => x.id === el.dataset.id); if (l) toast(`Bahan ${l.n} hanya cukup untuk ${D.menuPortions(getDb(), l.m, ctx.outlet).n} porsi`, 'warn'); }
      if (res) op(oid, () => API.setLineQty(res.id, res.q)).catch(failToast);
      rerender();
    },
    rmLine(el) { const oid = ui.orderId, lid = el.dataset.id; local((d) => { D.setDraftQty(D.order(d, oid), lid, 0); }); op(oid, () => API.setLineQty(lid, 0)).catch(failToast); rerender(); },
    async note(el) {
      const o = curOrder(getDb()); const l = o.lines.find((x) => x.id === el.dataset.id);
      openModal({ title: `Catatan untuk ${l.n}`, size: 'sm', body: `<label class="fld"><span>Catatan ke dapur</span><input name="n" value="${esc(l.note || '')}" placeholder="Contoh: tidak pedas, tanpa bawang" autofocus></label><div class="chips">${['Tidak pedas', 'Pedas', 'Tanpa es', 'Es sedikit', 'Dibungkus'].map((t) => `<button class="chip" data-t="${t}">${t}</button>`).join('')}</div>`,
        footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Simpan</button>`,
        onMount(m, api) {
          m.addEventListener('click', (ev) => { const c = ev.target.closest('[data-t]'); if (c) { const i = m.querySelector('input'); i.value = i.value ? i.value + ', ' + c.dataset.t : c.dataset.t; } });
          m.querySelector('[data-ok]').onclick = () => { const v = m.querySelector('input').value.trim(); local((d) => { const ll = D.order(d, o.id)?.lines.find((x) => x.id === l.id); if (ll) ll.note = v; }); op(o.id, () => API.setLineNote(l.id, v)).catch(failToast); api.close(); rerender(); };
        } });
    },
    async voidLine(el, e, ctx) {
      const o = curOrder(ctx.db); const l = o.lines.find((x) => x.id === el.dataset.id);
      const reason = await askReason(`Batalkan ${l.q}× ${l.n}?`, 'Item sudah dikirim ke dapur. Alasan pembatalan dicatat dan masuk laporan fraud.');
      if (!reason) return;
      await op(o.id, () => API.voidLine(l.id, reason));
      toast(l.s === 'draft' ? 'Item dihapus' : 'Item dibatalkan dan dicatat di laporan fraud', 'warn'); rerender();
    },
    cust(el) { const oid = ui.orderId, v = el.value.trim(); local((d) => { const o = D.order(d, oid); o.cust = { ...(o.cust || {}), name: v }; }); op(oid, () => API.updateOrder(oid, { custName: v })).catch(failToast); },
    async send(el, e, ctx) {
      el.disabled = true;
      try { await sendOrder(ctx, ui.orderId); } finally { el.disabled = false; rerender(); }
    },
    async printSet(el, e, ctx) {
      const oid = ui.orderId, o = curOrder(ctx.db); if (!o) return;
      el.disabled = true;
      try {
        if (o.lines.some((l) => l.s === 'draft')) await sendOrder(ctx, oid);
        await printSet(oid);
      } catch (err) { failToast(err); } finally { el.disabled = false; rerender(); }
    },
    member(el, e, ctx) { memberModal(ctx); },
    async unlinkMember() { const oid = ui.orderId; await op(oid, () => API.setMember(oid, null)); await C.refreshOrder(oid); rerender(); },
    async voucher(el, e, ctx) {
      const code = $('#pos-voucher').value.trim().toUpperCase();
      if (!code) return toast('Masukkan kode voucher', 'warn');
      const o = curOrder(ctx.db); const b = D.bill(ctx.db, o);
      const r = D.voucherCheck(ctx.db, code, b.sub, o.mem);
      if (!r.ok) return toast(r.msg, 'err');
      await op(o.id, () => API.setVoucher(o.id, r.v.code)); await C.refreshOrder(o.id); toast(`Voucher ${r.v.code} dipakai`); rerender();
    },
    async rmDisc(el) { const oid = ui.orderId; const k = el.dataset.k === 'manual' ? 'manual' : el.dataset.k === 'points' ? 'points' : 'voucher'; await op(oid, () => API.removeDiscount(oid, k)); await C.refreshOrder(oid); rerender(); },
    points(el, e, ctx) {
      const o = curOrder(ctx.db), m = D.member(ctx.db, o.mem), b = D.bill(ctx.db, o);
      const pv = ctx.db.settings.pointValue;
      const max = Math.min(m.points, Math.floor((b.base + (D.bill(ctx.db, o).discs.find((x) => x.kind === 'points')?.amt || 0)) / pv));
      openModal({ title: 'Tukar poin', size: 'sm', body: `<p>${esc(m.name)} punya <b>${num(m.points)} poin</b>. 1 poin = ${rp(pv)}.</p><label class="fld"><span>Jumlah poin (maks. ${num(max)})</span><input name="p" type="number" min="1" max="${max}" value="${max}" autofocus></label>`,
        footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Tukar</button>`,
        onMount(mm, api) { mm.querySelector('[data-ok]').onclick = async () => { const v = Math.min(max, Math.max(0, Math.floor(Number(mm.querySelector('input').value)))); api.close(); try { await op(o.id, () => API.setPoints(o.id, v)); await C.refreshOrder(o.id); } catch (e) { failToast(e); } rerender(); }; } });
    },
    manualDisc(el, e, ctx) {
      const o = curOrder(ctx.db);
      openModal({ title: 'Diskon manual', size: 'sm', body: `<div class="seg" role="radiogroup"><label><input type="radio" name="t" value="pct" checked> Persen</label><label><input type="radio" name="t" value="amt"> Nominal</label></div>
        <label class="fld"><span>Nilai</span><input name="v" type="number" min="0" placeholder="10" autofocus></label><label class="fld"><span>Alasan</span><input name="r" placeholder="Contoh: kompensasi pesanan terlambat"></label>
        <p class="hint">Diskon di atas ${Math.round(ctx.db.settings.discApproval * 100)}% perlu PIN manajer dan tercatat di laporan fraud.</p>`,
        footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Terapkan</button>`,
        onMount(mm, api) {
          mm.querySelector('[data-ok]').onclick = async () => {
            const f = formData(mm);
            const val = Number(f.v);
            if (!val || val <= 0) return toast('Isi nilai diskon', 'warn');
            if (!f.r.trim()) return toast('Alasan wajib diisi', 'warn');
            const b = D.bill(ctx.db, o);
            const ratio = f.t === 'pct' ? val / 100 : val / Math.max(1, b.sub);
            api.close();
            let pin = null;
            if (ratio > ctx.db.settings.discApproval) { pin = await askPin(`Diskon ${f.t === 'pct' ? val + '%' : rp(val)} melebihi batas ${Math.round(ctx.db.settings.discApproval * 100)}%.`); if (!pin) return toast('Diskon dibatalkan', 'warn'); }
            try { await op(o.id, () => API.manualDiscount(o.id, f.t, val, f.r.trim(), pin)); await C.refreshOrder(o.id); toast('Diskon diterapkan'); } catch (e) { failToast(e); }
            rerender();
          };
        } });
    },
    more(el, e, ctx) {
      const o = curOrder(ctx.db);
      openModal({ title: `Aksi untuk ${o.no}`, size: 'sm', body: `<div class="act-list">
        ${o.table ? `<button class="btn btn-block" data-m="move">${ic('arrow-left-right', 18)} Pindah meja</button><button class="btn btn-block" data-m="merge">${ic('merge', 18)} Gabung dengan meja lain</button>` : ''}
        <button class="btn btn-block" data-m="split">${ic('split', 18)} Split bill per item</button>
        <button class="btn btn-block" data-m="print">${ic('printer', 18)} Cetak tagihan sementara (pelanggan saja)</button>
        <button class="btn btn-block" data-m="reslip">${ic('printer', 18)} Cetak ulang slip Bar & Dapur</button>
        <button class="btn btn-block btn-danger-ghost" data-m="void">${ic('trash-2', 18)} Batalkan bill</button></div>`,
        onMount(m, api) { m.addEventListener('click', (ev) => { const b = ev.target.closest('[data-m]'); if (!b) return; api.close(); ({ move: moveTable, merge: mergeTable, split: splitBill, print: printBill, reslip: (c) => printSet(curOrder(c.db).id, { reprint: true }).catch(failToast), void: voidBill })[b.dataset.m](ctxNow()); }); } });
    },
    pay(el, e, ctx) { payModal(ctx); },
    async served(el) { el.disabled = true; await serveOrder(el.dataset.id); },
    async loungeServed(el) { el.disabled = true; await serveOrder(el.dataset.id); },
    loungeTg() { loungeOn = !loungeOn; try { localStorage.setItem(LKEY, loungeOn ? 'on' : 'off'); } catch {} rerender(); },
    terminal(el) { setTerminal(el.value); toast(`Terminal diganti ke ${el.value}`); rerender(); },
    shiftOpen(el, e, ctx) {
      openModal({ title: `Buka shift di ${ctx.terminal}`, size: 'sm', body: `<p>Kasir: <b>${esc(ctx.user.name)}</b></p><label class="fld"><span>Modal kas awal</span><input name="c" type="number" min="0" step="1000" value="500000" autofocus></label>`,
        footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Buka shift</button>`,
        onMount(m, api) { m.querySelector('[data-ok]').onclick = async () => { const c = Number(m.querySelector('input').value) || 0; try { await API.shiftOpen(ctx.terminal, ctx.outlet, c); await C.refresh('shifts'); api.close(); toast('Shift dibuka'); rerender(); } catch (e) { failToast(e); } }; } });
    },
    shiftClose(el, e, ctx) {
      const sh = D.activeShift(ctx.db, ctx.terminal); const s = D.shiftSummary(ctx.db, sh);
      openModal({ title: 'Tutup shift', size: 'sm', body: `<dl class="kv"><dt>Transaksi</dt><dd>${s.count}</dd><dt>Penjualan</dt><dd>${rp(s.total)}</dd><dt>Tunai masuk</dt><dd>${rp(s.by.cash || 0)}</dd><dt>Top-up deposit tunai</dt><dd>${rp(s.topCash)}</dd><dt>Refund tunai</dt><dd>-${rp(s.refCash)}</dd></dl>
        <label class="fld"><span>Uang tunai di laci (hitung fisik)</span><input name="c" type="number" min="0" step="500" autofocus></label><p class="hint">Sistem tidak menampilkan angka kas seharusnya supaya hitungan fisik jujur. Selisih di atas ${rp(ctx.db.settings.cashVarTol)} otomatis tercatat di laporan fraud.</p>`,
        footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Tutup shift</button>`,
        onMount(m, api) { m.querySelector('[data-ok]').onclick = async () => {
          const v = m.querySelector('input').value; if (v === '') return toast('Isi jumlah uang di laci', 'warn');
          let r;
          try { const x = await API.shiftClose(sh.id, Number(v)); r = { expected: Number(x.expected), counted: Number(x.counted), var: Number(x.variance) }; await C.refresh('shifts'); } catch (e) { return failToast(e); }
          api.close();
          openModal({ title: 'Shift ditutup', size: 'sm', body: `<dl class="kv"><dt>Kas seharusnya</dt><dd>${rp(r.expected)}</dd><dt>Dihitung</dt><dd>${rp(r.counted)}</dd><dt>Selisih</dt><dd class="${Math.abs(r.var) > ctx.db.settings.cashVarTol ? 'neg' : ''}"><b>${rp(r.var)}</b></dd></dl>${Math.abs(r.var) > ctx.db.settings.cashVarTol ? '<p class="banner err sm">Selisih melewati batas dan sudah dilaporkan ke manajer.</p>' : ''}`, footer: `<button class="btn btn-pri" data-close>Selesai</button>` });
          rerender();
        }; } });
    },
    async noSale(el, e, ctx) {
      const r = await askReason('Buka laci tanpa transaksi', 'Contoh: tukar uang kecil');
      if (!r) return;
      const sh = D.activeShift(getDb(), ctx.terminal);
      if (!sh) return toast('Buka shift dulu', 'warn');
      await API.noSale(sh.id, r); await C.refresh('shifts');
      toast('Laci dibuka dan tercatat', 'info');
    },
    depNew(el, e, ctx) {
      openModal({ title: 'Kartu deposit baru', size: 'sm', body: `<label class="fld"><span>Nama pemegang</span><input name="h" autofocus></label><label class="fld"><span>No. HP</span><input name="p" inputmode="tel"></label><label class="fld"><span>Top-up awal</span><input name="a" type="number" step="10000" value="100000"></label><label class="fld"><span>Metode</span><select name="m"><option value="cash">Tunai</option><option value="qris">QRIS</option><option value="card">Kartu</option></select></label>`,
        footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Buat kartu</button>`,
        onMount(m, api) { m.querySelector('[data-ok]').onclick = async () => {
          const f = formData(m); if (!f.h.trim()) return toast('Isi nama pemegang', 'warn');
          const sh = D.activeShift(getDb(), ctx.terminal); if (Number(f.a) > 0 && !sh) return toast('Buka shift dulu untuk menerima top-up', 'warn');
          try { const id = await API.depositNew(f.h.trim(), f.p, Number(f.a) || 0, f.m, sh?.id); await C.refresh('deposits', 'shifts'); api.close(); toast(`Kartu ${id} dibuat`); ui.depQ = id; rerender(); } catch (e) { failToast(e); }
        }; } });
    },
    depTopup(el, e, ctx) {
      const c = ctx.db.deposits.find((x) => x.id === el.dataset.id);
      const sh = D.activeShift(ctx.db, ctx.terminal); if (!sh) return toast('Buka shift dulu untuk menerima top-up', 'warn');
      openModal({ title: `Top-up ${c.id}`, size: 'sm', body: `<p>${esc(c.holder)}. Saldo sekarang <b>${rp(c.balance)}</b></p><div class="chips">${[50000, 100000, 200000, 500000].map((v) => `<button class="chip" data-v="${v}">${rp(v)}</button>`).join('')}</div><label class="fld"><span>Nominal</span><input name="a" type="number" step="10000" autofocus></label><label class="fld"><span>Metode</span><select name="m"><option value="cash">Tunai</option><option value="qris">QRIS</option><option value="card">Kartu</option></select></label>`,
        footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Top-up</button>`,
        onMount(m, api) {
          m.addEventListener('click', (ev) => { const b = ev.target.closest('[data-v]'); if (b) m.querySelector('[name=a]').value = b.dataset.v; });
          m.querySelector('[data-ok]').onclick = async () => { const f = formData(m); const a = Number(f.a); if (!a || a < 1000) return toast('Isi nominal top-up', 'warn'); try { await API.depositTopup(c.id, a, f.m, sh.id); await C.refresh('deposits'); api.close(); toast(`Saldo ${c.id} bertambah ${rp(a)}`); rerender(); } catch (e) { failToast(e); } };
        } });
    },
    async depRefund(el, e, ctx) {
      const c = ctx.db.deposits.find((x) => x.id === el.dataset.id);
      if (c.balance <= 0) return toast('Saldo kartu kosong', 'warn');
      const sh = D.activeShift(ctx.db, ctx.terminal); if (!sh) return toast('Buka shift dulu', 'warn');
      if (!(await confirmBox('Refund saldo deposit', `Kembalikan <b>${rp(c.balance)}</b> tunai ke ${esc(c.holder)} dan kosongkan kartu ${esc(c.id)}?`, 'Refund tunai'))) return;
      await API.depositRefund(c.id, sh.id); await C.refresh('deposits');
      toast('Saldo dikembalikan'); rerender();
    },
  },
};

// ---------- Modal member ----------
function memberModal(ctx) {
  const o = curOrder(getDb()) ;
  if (!o) return;
  let q = '';
  const list = () => {
    const db = getDb();
    const s = q.trim().toLowerCase();
    const ms = s ? db.members.filter((m) => m.phone.includes(s.replace(/\D/g, '') || '@@') || m.name.toLowerCase().includes(s)).slice(0, 8) : [];
    return ms.map((m) => { const t = D.tierOf(db, m); return `<button class="ol" data-pick="${m.id}"><span><b>${esc(m.name)}</b> <span class="badge b-gold">${esc(t.name)}</span><small>${esc(m.phone)}</small></span><span class="ol-r"><b>${num(m.points)} poin</b></span></button>`; }).join('') || (s ? '<p class="empty sm">Belum terdaftar. Daftarkan di bawah.</p>' : '');
  };
  openModal({ title: 'Hubungkan member Kaly Loop', body: `<div class="search">${ic('search', 17)}<input id="mem-q" placeholder="No. HP atau nama" autofocus></div><div class="olist" id="mem-list"></div>
    <details class="reg"><summary>Daftarkan member baru</summary><div class="grid2"><label class="fld"><span>Nama</span><input name="n"></label><label class="fld"><span>No. HP (WhatsApp)</span><input name="p" inputmode="tel"></label><label class="fld"><span>Tanggal lahir</span><input name="b" type="date"></label></div><button class="btn btn-pri" data-reg>Daftar & hubungkan</button></details>`,
    onMount(m, api) {
      m.querySelector('#mem-q').addEventListener('input', (e) => { q = e.target.value; m.querySelector('#mem-list').innerHTML = list(); });
      m.addEventListener('click', (e) => {
        const p = e.target.closest('[data-pick]');
        if (p) { const mid = p.dataset.pick; api.close(); op(o.id, () => API.setMember(o.id, mid)).then(() => C.refreshOrder(o.id)).then(() => { toast('Member terhubung'); rerender(); }).catch(failToast); }
        if (e.target.closest('[data-reg]')) {
          const n = m.querySelector('[name=n]').value.trim(), ph = m.querySelector('[name=p]').value, bd = m.querySelector('[name=b]').value;
          if (!n || D.normPhone(ph).length < 9) return toast('Isi nama dan nomor HP yang valid', 'warn');
          api.close();
          (async () => {
            const res = await API.upsertMember({ name: n, phone: ph, bday: bd ? bd.slice(5) : '', src: 'kasir' });
            await op(o.id, () => API.setMember(o.id, res.m.id));
            await Promise.all([C.refreshOrder(o.id), C.refresh('members')]);
            toast(res.created ? `Member baru terdaftar, bonus ${getDb().settings.welcomePoints} poin` : 'Nomor sudah terdaftar, member dihubungkan'); rerender();
          })().catch(failToast);
        }
      });
    } });
}

// ---------- Meja: pindah, gabung, split ----------
function pickTable(ctx, title, filter, cb) {
  const db = ctx.db;
  const ts = db.tables.filter((t) => t.loc === ctx.outlet && filter(t));
  openModal({ title, body: ts.length ? `<div class="tables sm">${ts.map((t) => { const o = tableOrder(db, ctx.outlet, t.id); return `<button class="tb ${o ? 'busy' : 'free'}" data-t="${t.id}"><span class="tb-n">${t.id}</span><span class="tb-s">${esc(t.area)}</span>${o ? `<span class="tb-v">${esc(o.no)} ${rp(D.bill(db, o).total)}</span>` : ''}</button>`; }).join('')}</div>` : '<p class="empty">Tidak ada meja yang cocok.</p>',
    onMount(m, api) { m.addEventListener('click', (e) => { const b = e.target.closest('[data-t]'); if (b) { api.close(); cb(b.dataset.t); } }); } });
}
function moveTable(ctx) {
  const o = curOrder(ctx.db);
  if (!o?.table) return;
  moveDialog(ctx, o.table, { order: o.id, done: () => rerender() });
}
function mergeTable(ctx) {
  const o = curOrder(ctx.db);
  pickTable(ctx, `Gabungkan meja lain ke ${o.no}`, (t) => { const x = tableOrder(ctx.db, ctx.outlet, t.id); return x && x.id !== o.id; }, (t) => {
    const b = tableOrder(getDb(), ctx.outlet, t);
    (async () => {
      await API.orderSettled(b.id);
      await op(o.id, () => API.mergeOrders(o.id, b.id));
      await Promise.all([C.refreshOrder(o.id), C.refreshOrder(b.id)]);
      toast(`Meja ${t} digabung ke ${o.no}`); rerender();
    })().catch(failToast);
  });
}
function splitBill(ctx) {
  const db = ctx.db, o = curOrder(db);
  const top = o.lines.filter((l) => !l.par && l.s !== 'void');
  if (top.length < 1) return toast('Belum ada item untuk dipisah', 'warn');
  const sel = Object.fromEntries(top.map((l) => [l.id, 0]));
  const draw = () => {
    const amt = sum(top, (l) => sel[l.id] * l.p);
    return `<p class="muted">Pilih item yang dipindahkan ke bill baru. Untuk bagi rata, gunakan tombol <b>Bagi rata</b> di layar pembayaran.</p>
      <div class="olist">${top.map((l) => `<div class="ol static"><span><b>${esc(l.n)}</b><small>${l.q}× ${rp(l.p)}</small></span><span class="qty"><button data-s="${l.id}" data-d="-1">${ic('minus', 14)}</button><b>${sel[l.id]}</b><button data-s="${l.id}" data-d="1">${ic('plus', 14)}</button></span></div>`).join('')}</div>
      <p class="row sb"><span>Nilai bill baru (sebelum diskon & pajak)</span><b>${rp(amt)}</b></p>`;
  };
  openModal({ title: `Split bill ${o.no}`, body: draw(), footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Pisahkan</button>`,
    onMount(m, api) {
      m.addEventListener('click', (e) => { const b = e.target.closest('[data-s]'); if (!b) return; const l = top.find((x) => x.id === b.dataset.s); sel[l.id] = Math.max(0, Math.min(l.pkg ? (sel[l.id] ? 0 : l.q) : l.q, sel[l.id] + Number(b.dataset.d))); if (l.pkg) sel[l.id] = Number(b.dataset.d) > 0 ? l.q : 0; api.set(draw()); });
      m.querySelector('[data-ok]').onclick = () => {
        if (!Object.values(sel).some((v) => v > 0)) return toast('Pilih minimal satu item', 'warn');
        if (top.every((l) => sel[l.id] >= l.q)) return toast('Sisakan minimal satu item di bill asal', 'warn');
        api.close();
        (async () => {
          const pick = Object.fromEntries(Object.entries(sel).filter(([, v]) => v > 0));
          const nid = await op(o.id, () => API.splitOrder(o.id, pick));
          await Promise.all([C.refreshOrder(o.id), C.refreshOrder(nid)]);
          ui.orderId = nid; toast('Bill dipisah. Bill baru sedang dibuka.'); rerender();
        })().catch(failToast);
      };
    } });
}
async function voidBill(ctx) {
  const o = curOrder(ctx.db);
  const sent = o.lines.some((l) => l.s !== 'draft' && l.s !== 'void');
  const reason = await askReason(`Batalkan bill ${o.no}?`, sent ? 'Ada item yang sudah diproses dapur. Pembatalan perlu PIN manajer.' : 'Alasan pembatalan');
  if (!reason) return;
  let pin = null;
  if (sent && ctx.user.role !== 'owner') { pin = await askPin('Bill berisi item yang sudah diproses dapur.'); if (!pin) return toast('Pembatalan dibatalkan', 'warn'); }
  try { await op(o.id, () => API.voidOrder(o.id, reason, pin)); } catch (e) { return failToast(e); }
  await C.refreshOrder(o.id);
  ui.orderId = null; toast('Bill dibatalkan', 'warn'); rerender();
}

// ---------- Pembayaran ----------
function payModal(ctx) {
  const db = getDb(), o = curOrder(db);
  if (!o) return;
  const sh = D.activeShift(db, ctx.terminal);
  if (!sh) { ui.tab = 'shift'; rerender(); return toast('Buka shift dulu sebelum menerima pembayaran', 'warn'); }
  if (sh.user !== ctx.user.id && ctx.user.role !== 'owner') return toast(`Shift di ${ctx.terminal} milik ${D.userName(db, sh.user)}`, 'err');
  const b = D.bill(db, o);
  let rows = [{ m: 'cash', a: b.total, card: '' }];
  let tendered = '';
  const draw = () => {
    const paid = sum(rows, (r) => Number(r.a) || 0);
    const single = rows.length === 1 && rows[0].m === 'cash';
    const cashGiven = single && tendered ? Number(tendered) : paid;
    const change = single ? Math.max(0, cashGiven - b.total) : Math.max(0, paid - b.total);
    const short = Math.max(0, b.total - (single ? cashGiven : paid));
    return `<div class="pay-total"><small>Total tagihan ${esc(o.no)}</small><b>${rp(b.total)}</b></div>
      <div class="pay-methods">${Object.entries(D.PAY).map(([k, v]) => `<button class="pm ${rows.length === 1 && rows[0].m === k ? 'on' : ''}" data-pm="${k}">${ic(v.icon, 20)}<span>${v.label}</span></button>`).join('')}</div>
      <div class="pay-rows">${rows.map((r, i) => `<div class="pay-row"><span class="badge b-mute">${D.PAY[r.m].label}</span><input class="inp" type="number" data-ra="${i}" value="${r.a}" aria-label="Jumlah ${D.PAY[r.m].label}">${r.m === 'deposit' ? `<input class="inp" data-rc="${i}" placeholder="No. kartu KD-0001" value="${esc(r.card)}">` : ''}${rows.length > 1 ? `<button class="btn-icon sm" data-rx="${i}" aria-label="Hapus">${ic('x', 15)}</button>` : ''}</div>`).join('')}</div>
      <div class="row wrap"><button class="btn btn-sm" data-add-row>${ic('plus', 14)} Tambah metode</button><span class="split-eq"><button class="btn btn-sm" data-equal>${ic('split', 14)} Bagi rata untuk</button><input class="inp inp-xs" type="number" id="split-n" min="2" max="20" value="${rows.length > 1 ? rows.length : 2}" aria-label="Jumlah orang"><span class="muted sm">orang</span></span></div>
      ${rows.some((r) => r.m === 'qris') ? `<div class="qris-box">${qrisUrl(db.settings) ? `<img class="qris-img" src="${qrisUrl(db.settings)}" alt="QRIS toko">` : ''}<p>${qrisUrl(db.settings) ? 'Minta pelanggan scan QRIS ini (juga tampil di layar pelanggan) dan membayar' : 'Minta pelanggan scan QRIS di meja kasir dan membayar'} <b>${rp(rows.find((r) => r.m === 'qris').a)}</b>. Tekan Bayar setelah notifikasi dana masuk terlihat.${qrisUrl(db.settings) ? '' : ' Gambar QRIS bisa diunggah di Kaly Order, tab Pengaturan.'}</p></div>` : ''}
      ${single ? `<label class="fld"><span>Uang diterima</span><input class="inp" type="number" id="tendered" value="${esc(tendered)}" placeholder="${b.total}"></label><div class="chips">${[b.total, ...[50000, 100000, 150000, 200000, 500000].filter((v) => v > b.total)].slice(0, 5).map((v, i) => `<button class="chip" data-tend="${v}">${i === 0 ? 'Uang pas' : rp(v)}</button>`).join('')}</div>` : ''}
      <div class="pay-sum ${short ? 'short' : ''}">${short ? `Kurang <b>${rp(short)}</b>` : `Kembalian <b>${rp(change)}</b>`}</div>`;
  };
  ui.paying = o.id;
  pushDisplay({ term: ctx.terminal, status: 'pay', loc: ctx.outlet, no: o.no, lines: o.lines.filter((l) => !l.par && l.s !== 'void').map((l) => ({ n: l.n, q: l.q, a: l.q * l.p })), bill: b, qris: qrisUrl(db.settings) || '' });
  openModal({ title: 'Pembayaran', size: 'md', body: draw(), footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri btn-lg" data-ok>${ic('check', 18)} Selesaikan pembayaran</button>`,
    onClose: () => { ui.paying = null; rerender(); },
    onMount(m, api) {
      const redraw = () => { const f = document.activeElement; const key = f?.dataset?.ra ?? f?.id; api.set(draw()); if (key !== undefined) { const el = key === 'tendered' ? m.querySelector('#tendered') : m.querySelector(`[data-ra="${key}"]`); if (el) { el.focus(); const v = el.value; el.value = ''; el.value = v; } } };
      m.addEventListener('click', (e) => {
        const pm = e.target.closest('[data-pm]');
        if (pm) { if (rows.length === 1) rows = [{ m: pm.dataset.pm, a: b.total, card: '' }]; else rows[rows.length - 1].m = pm.dataset.pm; tendered = ''; return redraw(); }
        if (e.target.closest('[data-add-row]')) { const rest = Math.max(0, b.total - sum(rows, (r) => Number(r.a) || 0)); rows.push({ m: 'qris', a: rest, card: '' }); return redraw(); }
        if (e.target.closest('[data-equal]')) { const n = Math.min(20, Math.max(2, Number(m.querySelector('#split-n').value) || 2)); const each = Math.floor(b.total / n / 100) * 100; rows = Array.from({ length: n }, (_, i) => ({ m: 'cash', a: i === n - 1 ? b.total - each * (n - 1) : each, card: '' })); return redraw(); }
        const rx = e.target.closest('[data-rx]'); if (rx) { rows.splice(Number(rx.dataset.rx), 1); return redraw(); }
        const td = e.target.closest('[data-tend]'); if (td) { tendered = td.dataset.tend; return redraw(); }
      });
      m.addEventListener('input', (e) => {
        if (e.target.dataset.ra !== undefined) { rows[Number(e.target.dataset.ra)].a = e.target.value; m.querySelector('.pay-sum').outerHTML = draw().match(/<div class="pay-sum[\s\S]*<\/div>$/)[0]; }
        if (e.target.dataset.rc !== undefined) rows[Number(e.target.dataset.rc)].card = e.target.value.trim().toUpperCase();
        if (e.target.id === 'tendered') { tendered = e.target.value; m.querySelector('.pay-sum').outerHTML = draw().match(/<div class="pay-sum[\s\S]*<\/div>$/)[0]; }
      });
      m.querySelector('[data-ok]').onclick = async (ev) => {
        const btn = ev.currentTarget;
        const single = rows.length === 1 && rows[0].m === 'cash';
        const pays = rows.map((r) => ({ m: r.m, a: Number(r.a) || 0, ...(r.m === 'deposit' ? { card: r.card } : {}) }));
        if (single && tendered) pays[0].a = Number(tendered);
        const tend = pays.filter((p) => p.m === 'cash').reduce((s, p) => s + p.a, 0);
        const before = stockSnap(getDb(), ctx.outlet);
        btn.disabled = true;
        let res;
        try { res = await op(o.id, () => API.pay(o.id, pays, sh.id, tend)); } catch (e) { btn.disabled = false; return failToast(e); }
        if (!res?.ok) { btn.disabled = false; return toast(res?.msg || 'Pembayaran gagal', 'err'); }
        res.change = Number(res.change) || 0; res.earned = Number(res.earned) || 0;
        await Promise.all([C.refreshOrder(o.id), C.refresh('members', 'stock', 'loyalty', 'deposits', 'notices')]).catch(() => {});
        stockAlert(before, ctx.outlet);
        api.close();
        ui.orderId = null;
        const done = D.order(getDb(), o.id);
        pushDisplay({ term: ctx.terminal, status: 'thanks', loc: ctx.outlet, no: done.no, bill: done.bill, change: res.change, earned: res.earned });
        receiptModal(done, res);
        rerender();
      };
    } });
}

const rcLines = (t) => String(t || '').split('\n').map((x) => x.trim()).filter(Boolean).map(esc).join('<br>');
const rcAttr = (R) => `class="receipt rc-${R.font}" style="--paper:${R.paper}mm"`;
export function receiptHtml(db, o, cfg) {
  const R = cfg || db.settings.receipt || C.receiptCfg({});
  const b = o.bill || D.bill(db, o);
  const m = o.mem && D.member(db, o.mem);
  const t = o.paidAt || Date.now();
  const qr = R.qris && o.status !== 'paid' ? qrisUrl(db.settings) : null;
  return `<div ${rcAttr(R)}>
    ${R.logo ? '<img class="logo" src="assets/kaly-logo-dark.svg" alt="kaly">' : ''}<p class="rc-name">${esc(R.name || db.settings.brand.name)}</p>${R.outlet ? `<p>${esc(D.loc(db, o.loc)?.name || '')}</p>` : ''}${R.header ? `<p class="rc-head">${rcLines(R.header)}</p>` : ''}
    <p>${fmtDate(t)} ${fmtTime(t)}</p>
    <p>No. ${esc(o.no)} ${o.table ? 'Meja ' + esc([o.table, ...(o.merged || [])].join('+')) : esc(D.TYPE_LABEL[o.type])}${R.cashier ? `<br>Kasir: ${esc(D.userName(db, o.paidBy || o.by))}` : ''}</p><hr>
    ${o.lines.filter((l) => !l.par && l.s !== 'void').map((l) => `<div class="rl"><span>${l.q}× ${esc(l.n)}</span><span>${rp(l.q * l.p)}</span></div>`).join('')}<hr>
    <div class="rl"><span>Subtotal</span><span>${rp(b.sub)}</span></div>${b.discs.map((d) => `<div class="rl"><span>${esc(d.label)}</span><span>-${rp(d.amt)}</span></div>`).join('')}
    <div class="rl"><span>PB1</span><span>${rp(b.tax)}</span></div>${b.deliv ? `<div class="rl"><span>Ongkir</span><span>${rp(b.deliv)}</span></div>` : ''}<div class="rl big"><span>Total</span><span>${rp(b.total)}</span></div>
    ${o.status === 'paid' ? o.pays.map((p) => `<div class="rl"><span>${D.PAY[p.m].label}${p.card ? ' ' + p.card : ''}</span><span>${rp(p.a + (p.m === 'cash' ? o.change || 0 : 0))}</span></div>`).join('') + (o.change ? `<div class="rl"><span>Kembalian</span><span>${rp(o.change)}</span></div>` : '') : '<p><b>TAGIHAN SEMENTARA</b></p>' + (qr ? `<img class="rc-qris" src="${qr}" alt="QRIS"><p>Scan QRIS untuk membayar</p>` : '')}
    ${R.member && m ? `<hr><p>Member ${esc(m.name)}${o.earned ? `<br>+${o.earned} poin, total ${num(m.points)} poin` : ''}</p>` : ''}
    ${R.footer ? `<hr><p>${rcLines(R.footer)}</p>` : ''}</div>`;
}
function receiptModal(o, res) {
  const db = getDb();
  openModal({ title: 'Pembayaran berhasil', size: 'sm', body: `<div class="paid-ok">${ic('circle-check', 40)}<b>${rp(o.bill.total)}</b>${o.change ? `<span>Kembalian <b>${rp(o.change)}</b></span>` : ''}${res.earned ? `<span>Member dapat ${res.earned} poin</span>` : ''}${res.missions?.length ? `<span>Misi selesai: ${res.missions.map((x) => esc(x.name)).join(', ')}</span>` : ''}</div>${receiptHtml(db, o)}`,
    footer: `${o.type === 'dine' && o.table ? `<button class="btn btn-ghost" data-clear title="Tamu langsung pergi">${ic('check', 16)} Kosongkan meja ${esc(o.table)}</button>` : ''}<button class="btn" data-print>${ic('printer', 16)} Cetak nota</button><button class="btn btn-pri" data-close>Pesanan baru</button>`,
    onMount(m, api) {
      m.querySelector('[data-print]').onclick = () => printSet(o.id).catch(failToast);
      const c = m.querySelector('[data-clear]');
      if (c) c.onclick = async () => { c.disabled = true; await clearTable(o.table, o.loc); c.innerHTML = `${ic('check', 16)} Meja ${esc(o.table)} kosong`; rerender(); };
    } });
}
export async function printReceipt(id) {
  let n = 1;
  try { n = await API.printCount(id); } catch (e) { return toast(e.message, 'err'); }
  doPrint(receiptHtml(getDb(), D.order(getDb(), id)) + (n > 1 ? '<p style="text-align:center">CETAK ULANG</p>' : ''));
}
function printBill(ctx) { const o = curOrder(ctx.db); if (!o) return; sendPrints(o, [{ kind: 'cust', label: `Tagihan sementara · ${o.table ? 'Meja ' + o.table : 'No. ' + o.no}`, html: `<div class="slip">${receiptHtml(ctx.db, o)}</div>` }]).catch(failToast); }

// ---------- Cetak nota rangkap: pelanggan, salinan kasir, slip Bar, slip Dapur ----------
const SLIP = { bar: 'BAR', dapur: 'DAPUR' };
const catsOf = (db, st) => db.cats.filter((c) => c.station === st).map((c) => c.name).join(', ');
export function kitchenSlipHtml(db, o, st, lines, { reprint = false, cfg } = {}) {
  const R = cfg || db.settings.receipt || C.receiptCfg({});
  const t = Math.max(...lines.map((l) => l.ts || 0)) || Date.now();
  const par = (l) => (l.par ? o.lines.find((x) => x.id === l.par)?.n : '');
  return `<div class="receipt kslip rc-${R.font}" style="--paper:${R.paper}mm">
    <h3>${SLIP[st]}</h3><p class="ks-cat">${esc(catsOf(db, st))}</p>
    <p class="ks-where">${o.table ? 'Meja ' + esc([o.table, ...(o.merged || [])].join('+')) : esc(o.cust?.name || D.TYPE_LABEL[o.type])}</p>
    <p>No. ${esc(o.no)} · ${fmtTime(t)}<br>Kasir: ${esc(D.userName(db, o.by))}${o.ch !== 'pos' ? ' · ' + D.CH_LABEL[o.ch] : ''}</p><hr>
    ${lines.map((l) => `<div class="ks-l"><b>${num(l.q)}×</b><span>${esc(l.n)}${par(l) ? `<small>paket ${esc(par(l))}</small>` : ''}${l.note ? `<small class="ks-note">${esc(l.note)}</small>` : ''}</span></div>`).join('')}
    <hr><p>${lines.length} item${reprint ? '<br><b>CETAK ULANG</b>' : ''}</p></div>`;
}
// Sekali tekan Cetak: nota pelanggan, salinan, slip Bar (minuman & dessert) dan slip Dapur (main dish & snack) untuk item yang belum pernah tercetak
export async function printSet(oid, { reprint = false } = {}) {
  let o = D.order(getDb(), oid); if (!o) return;
  const pc = getDb().settings.printCopies || { cust: 1, copy: 1, bar: 1, dapur: 1 };
  const r = await op(oid, () => API.printSlips(oid, reprint));
  const ids = new Set(r?.lines || []);
  if (!reprint && ids.size) local((d) => { const now = Date.now(); for (const l of D.order(d, oid)?.lines || []) if (ids.has(l.id)) l.slip = now; });
  let n = 0;
  if (!reprint && o.status === 'paid' && pc.cust + pc.copy > 0) { try { n = await API.printCount(oid); } catch {} }
  const db = getDb(); o = D.order(db, oid);
  const rep = (k, html) => Array.from({ length: pc[k] || 0 }, () => `<div class="slip">${html}</div>`).join('');
  const again = n > 1 ? '<p style="text-align:center"><b>CETAK ULANG</b></p>' : '';
  const kl = (st) => D.kitchenLines(o).filter((l) => l.st === st && ids.has(l.id));
  const bar = kl('bar'), dap = kl('dapur');
  const where = o.table ? 'Meja ' + [o.table, ...(o.merged || [])].join('+') : 'No. ' + o.no;
  const lab = (k, extra = '') => `${KIND_LABEL[k]} · ${where}${extra}${reprint ? ' · cetak ulang' : ''}`;
  const pieces = [];
  if (!reprint) {
    pieces.push({ kind: 'cust', label: lab('cust'), html: rep('cust', receiptHtml(db, o) + again) });
    pieces.push({ kind: 'copy', label: lab('copy'), html: rep('copy', `<p class="slip-tag">SALINAN KASIR</p>` + receiptHtml(db, o) + again) });
  }
  if (bar.length) pieces.push({ kind: 'bar', label: lab('bar', ` · ${bar.length} item`), html: rep('bar', kitchenSlipHtml(db, o, 'bar', bar, { reprint })) });
  if (dap.length) pieces.push({ kind: 'dapur', label: lab('dapur', ` · ${dap.length} item`), html: rep('dapur', kitchenSlipHtml(db, o, 'dapur', dap, { reprint })) });
  const todo = pieces.filter((x) => x.html);
  if (!todo.length) return toast(reprint ? 'Belum ada item yang pernah dicetak di slip Bar/Dapur' : 'Tidak ada yang dicetak. Atur jumlah lembar di Pengaturan › Cetak nota.', 'warn', 5000);
  await sendPrints(o, todo);
}
export { doPrint };

// ---------- Notifikasi dapur → kasir ----------
export function showNotices(ctx) {
  const db = getDb();
  const ns = db.notices.filter((n) => !n.seen && n.loc === ctx.outlet);
  openModal({ title: 'Pesanan siap dari dapur', size: 'sm', body: ns.length ? `<div class="olist">${ns.map((n) => `<div class="ol static"><span><b>${esc(n.no)}</b> ${n.table ? 'Meja ' + esc(n.table) : 'Ambil di kasir'}<small>siap ${fmtTime(n.at)}</small></span><button class="btn btn-sm btn-pri" data-srv="${n.order}">Diantar</button></div>`).join('')}</div>` : '<p class="empty">Tidak ada notifikasi baru.</p>',
    onMount(m, api) { m.addEventListener('click', (e) => { const b = e.target.closest('[data-srv]'); if (!b) return; const id = b.dataset.srv; b.closest('.ol').remove(); op(id, () => API.markServed(id)).then(() => C.refresh('notices')).then(() => rerender()).catch(failToast); }); } });
}
