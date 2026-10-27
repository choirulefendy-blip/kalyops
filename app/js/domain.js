// Logika bisnis bersama: resep, stok, order, pembayaran, jurnal, loyalty, fraud
import { uid, sum, DAY, dayKey, pad, rp, startOfDay } from './lib.js';

export const ROLES = {
  owner: { label: 'Owner / Manajer', short: 'Manajer' },
  kasir: { label: 'Kasir', short: 'Kasir' },
  dapur: { label: 'Dapur', short: 'Dapur' },
  gudang: { label: 'Gudang', short: 'Gudang' },
  service: { label: 'Service / Pramusaji', short: 'Service' },
};
export const PAY = {
  cash: { label: 'Tunai', acc: '1101', icon: 'banknote' },
  qris: { label: 'QRIS / e-wallet', acc: '1102', icon: 'qr-code' },
  card: { label: 'Kartu debit/kredit', acc: '1102', icon: 'credit-card' },
  transfer: { label: 'Transfer bank', acc: '1102', icon: 'building-2' },
  deposit: { label: 'Kartu deposit', acc: '2103', icon: 'wallet' },
};
export const TYPE_LABEL = { dine: 'Dine-in', take: 'Langsung', deliv: 'Delivery' };
// Nama kategori yang masuk ke stasiun tertentu (untuk slip Bar / Dapur)
export const stationCats = (db, st) => db.cats.filter((c) => c.station === st).map((c) => c.name).join(', ');
// Outlet yang punya denah meja (Resto) wajib memakai meja; outlet tanpa meja (Play Corner) menjual langsung
export const hasTables = (db, L) => db.tables.some((t) => t.loc === L);
export const CH_LABEL = { pos: 'Kasir', qr: 'QR meja', web: 'Online' };
export const STATION_LABEL = { dapur: 'Dapur', bar: 'Bar', none: 'Langsung' };
// Warna kategori menu: membedakan kelompok menu di POS, halaman pesan, dan Kaly Core
export const CAT_COLORS = { orange: 'Oranye', kunyit: 'Kunyit', plum: 'Ungu', kopi: 'Cokelat kopi', kolam: 'Biru kolam', olive: 'Hijau zaitun', cabai: 'Merah cabai', slate: 'Abu-abu' };
const CC_KEYS = Object.keys(CAT_COLORS);
export const catColor = (db, catId) => { const i = db.cats.findIndex((c) => c.id === catId); const c = i >= 0 ? db.cats.at(i) : null; return c?.color && CAT_COLORS[c.color] ? c.color : i >= 0 ? CC_KEYS.at(i % CC_KEYS.length) : 'slate'; };
export const nextCatColor = (db) => CC_KEYS.find((k) => !db.cats.some((c) => c.color === k)) || CC_KEYS.at(db.cats.length % CC_KEYS.length);

const r4 = (x) => Math.round(x * 10000) / 10000;

// ---------- Lookup ----------
export const item = (db, id) => db.items.find((i) => i.id === id);
export const menu = (db, id) => db.menus.find((m) => m.id === id);
export const loc = (db, id) => db.locations.find((l) => l.id === id);
export const entity = (db, id) => db.entities.find((e) => e.id === id);
export const entityOf = (db, locId) => loc(db, locId)?.entity;
export const user = (db, id) => db.users.find((u) => u.id === id);
export const member = (db, id) => db.members.find((m) => m.id === id);
export const supplier = (db, id) => db.suppliers.find((s) => s.id === id);
export const order = (db, id) => db.orders.find((o) => o.id === id);
export const userName = (db, id) => user(db, id)?.name || '—';
export const menuAvail = (db, id, locId) => { const m = menu(db, id); return m && m.active && (!locId || !m.outlets || m.outlets.includes(locId)); };
// Bisa dipesan: aktif di outlet itu, tidak ditandai habis, sudah punya harga, dan (kalau penjaga stok aktif) bahannya cukup
export const menuOrderable = (db, id, locId) => { const m = menu(db, id); return !!m && menuAvail(db, id, locId) && !m.soldOut && m.price > 0 && !(locId && stockOut(db, id, locId)); };

// ---------- Penjaga stok: berapa porsi yang masih bisa dibuat dari stok outlet ----------
// Bahan setengah jadi dihitung dari stoknya sendiri + batch utuh yang masih bisa diproduksi dari bahan bakunya.
function availItem(db, L, itemId, depth = 0) {
  const it = item(db, itemId);
  const have = Math.max(0, db.stock[L]?.[itemId]?.q || 0);
  if (it?.type === 'semi' && it.bom?.length && db.settings.autoProduce && depth < 4) {
    let batches = Infinity;
    for (const b of it.bom) batches = Math.min(batches, Math.floor(availItem(db, L, b.i, depth + 1) / b.q + 1e-9));
    return have + (Number.isFinite(batches) ? batches * (it.yield || 1) : 0);
  }
  return have;
}
// Outlet terhubung ke stok Kaly Core (Pengaturan > Integrasi Kaly Core)? Tidak terhubung = tanpa potong stok, HPP, & menu habis karena bahan
export const coreOn = (db, L) => db.locations.find((l) => l.id === L)?.core !== false;
// Hasil: { n: porsi (Infinity kalau menu tanpa resep atau outlet tidak terhubung Kaly Core), limit: id bahan yang paling membatasi }
export function menuPortions(db, id, L) {
  const m = typeof id === 'string' ? menu(db, id) : id;
  if (!m) return { n: 0, limit: null };
  if (L && !coreOn(db, L)) return { n: Infinity, limit: null };
  if (m.pkg) {
    let best = { n: Infinity, limit: null };
    for (const p of m.pkg) { const r = menuPortions(db, p.m, L); const n = Math.floor(r.n / (p.q || 1) + 1e-9); if (n < best.n) best = { n, limit: r.limit }; }
    return best;
  }
  let best = { n: Infinity, limit: null };
  for (const b of m.bom || []) {
    if (!(b.q > 0)) continue;
    const n = Math.floor(availItem(db, L, b.i) / b.q + 1e-9);
    if (n < best.n) best = { n, limit: b.i };
  }
  return best;
}
export const stockGuardOn = (db) => db.settings.stockGuard !== false;
export const stockOut = (db, id, L) => stockGuardOn(db) && menuPortions(db, id, L).n < 1;
// Alasan menu tidak bisa dipesan, untuk label di POS & halaman pesan: null | 'habis' | 'harga' | 'bahan'
export function menuBlock(db, id, L) {
  const m = menu(db, id);
  if (!m) return 'habis';
  if (m.soldOut) return 'habis';
  if (!(m.price > 0)) return 'harga';
  if (L && stockOut(db, id, L)) return 'bahan';
  return null;
}
// Menu yang sedang tidak bisa dijual karena bahan, per outlet
export function stockBlockedMenus(db, L) {
  if (!stockGuardOn(db)) return [];
  return db.menus.filter((m) => menuAvail(db, m.id, L) && !m.soldOut && m.price > 0 && stockOut(db, m.id, L));
}

export const sumTotals = (os) => sum(os, (o) => o.bill?.total || 0);
export const lineName = (l) => l.n;

// ---------- Resep & HPP ----------
export function stdCost(db, id, seen = {}) {
  const it = item(db, id);
  if (!it) return 0;
  if (it.type !== 'semi' || !it.bom?.length) return it.cost || 0;
  if (seen[id]) return 0;
  seen[id] = 1;
  const c = sum(it.bom, (b) => b.q * stdCost(db, b.i, seen)) / (it.yield || 1);
  delete seen[id];
  return c;
}
export function menuHpp(db, m) {
  m = typeof m === 'string' ? menu(db, m) : m;
  if (!m) return 0;
  if (m.pkg) return sum(m.pkg, (p) => p.q * menuHpp(db, p.m));
  return sum(m.bom || [], (b) => b.q * stdCost(db, b.i));
}
export function bomTree(db, comps, mult = 1, depth = 0) {
  return (comps || []).map((b) => {
    const it = item(db, b.i);
    const q = b.q * mult;
    const node = { i: b.i, name: it?.name || b.i, unit: it?.unit || '', type: it?.type, q, cost: q * stdCost(db, b.i), depth, children: [] };
    if (it?.type === 'semi' && depth < 4) node.children = bomTree(db, it.bom, q / (it.yield || 1), depth + 1);
    return node;
  });
}

// ---------- Stok ----------
export function slot(db, locId, itemId) {
  const L = (db.stock[locId] ||= {});
  return (L[itemId] ||= { q: 0, c: stdCost(db, itemId), min: 0 });
}
function logMove(db, m) {
  db.moves.push({ t: Date.now(), ...m });
  if (db.moves.length > 4000) db.moves.splice(0, db.moves.length - 4000);
}
export function consume(db, locId, itemId, qty, type, ref = '', by = '') {
  if (!qty) return 0;
  const it = item(db, itemId);
  if (!it) return 0;
  const s = slot(db, locId, itemId);
  if (it.type === 'semi' && it.bom?.length && db.settings.autoProduce && s.q < qty - 1e-9 && !['b2b-out', 'tf-out', 'opname'].includes(type)) {
    const need = qty - Math.max(0, s.q);
    const batch = it.yield || 1;
    produce(db, locId, itemId, Math.ceil(need / batch - 1e-9) * batch, { auto: true, ref, by });
  }
  const c = s.c > 0 ? s.c : stdCost(db, itemId);
  const before = s.q;
  s.q = r4(s.q - qty);
  logMove(db, { loc: locId, i: itemId, q: -qty, c, type, ref });
  // Stok tercatat lebih kecil dari nol: tandai sekali per bahan per hari supaya dicek fisik
  if (s.q < -1e-9 && before >= -1e-9 && db.flags) {
    const key = `minus:${locId}:${itemId}:${dayKey()}`;
    if (!db.flags.some((f) => f.ref === key)) flag(db, { type: 'Stok minus', sev: 'sedang', msg: `${it.name} di ${loc(db, locId)?.name || locId} tercatat minus ${Math.abs(s.q).toLocaleString('id-ID')} ${it.unit} setelah ${ref || type}. Cek stok fisik atau catat penerimaan barang yang belum diinput.`, user: by || '', ref: key, loc: locId });
  }
  return qty * c;
}
export function addStock(db, locId, itemId, qty, unitCost, type, ref = '') {
  const s = slot(db, locId, itemId);
  if (s.q <= 0 || !s.c) s.c = unitCost;
  else s.c = (s.q * s.c + qty * unitCost) / (s.q + qty);
  s.q = r4(s.q + qty);
  logMove(db, { loc: locId, i: itemId, q: qty, c: unitCost, type, ref });
}
export function produce(db, locId, semiId, qty, { auto = false, ref = '', by = '' } = {}) {
  const it = item(db, semiId);
  const f = qty / (it.yield || 1);
  const no = 'PRD-' + uid().slice(-5).toUpperCase();
  let cost = 0;
  for (const b of it.bom || []) cost += consume(db, locId, b.i, b.q * f, 'prod-out', no, by);
  addStock(db, locId, semiId, qty, qty ? cost / qty : 0, 'prod-in', no);
  db.productions.unshift({ id: no, at: Date.now(), loc: locId, i: semiId, q: qty, cost: Math.round(cost), auto, by, ref });
  if (db.productions.length > 300) db.productions.length = 300;
  return cost;
}
// Nilai persediaan ikut menghitung stok minus, supaya sama dengan saldo akun Persediaan di buku besar
export const stockValue = (db, locIds) => sum(locIds, (L) => sum(Object.values(db.stock[L] || {}), (s) => s.q * (s.c || 0)));
export function lowStock(db, locId) {
  const out = [];
  for (const [i, s] of Object.entries(db.stock[locId] || {})) if (s.min > 0 && s.q < s.min) out.push({ i, ...s, item: item(db, i) });
  return out;
}

// ---------- Jurnal ----------
export function post(db, { e, d = Date.now(), memo, ref = '', cf = '', l, tag }) {
  const lines = l.map(([a, dr = 0, cr = 0]) => [a, Math.round(dr), Math.round(cr)]).filter((x) => x[1] || x[2]);
  if (!lines.length) return null;
  const diff = sum(lines, (x) => x[1]) - sum(lines, (x) => x[2]);
  if (diff !== 0 && Math.abs(diff) < 50) {
    if (diff > 0) { const t = lines.filter((x) => x[2] > 0).sort((a, b) => b[2] - a[2])[0]; if (t) t[2] += diff; }
    else { const t = lines.filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1])[0]; if (t) t[1] -= diff; }
  }
  const j = { id: uid('j'), d, e, memo, ref, cf, l: lines };
  if (tag) j.tag = tag;
  db.journals.push(j);
  return j;
}

// ---------- Fraud ----------
export function flag(db, { type, sev = 'sedang', msg, user: u, ref = '', loc: L = '' }) {
  db.flags.unshift({ id: uid('f'), at: Date.now(), type, sev, msg, user: u, ref, loc: L, status: 'open' });
  if (db.flags.length > 600) db.flags.length = 600;
}

// ---------- Member & loyalty ----------
export const normPhone = (p) => { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('62')) d = '0' + d.slice(2); return d; };
export const waPhone = (p) => { const d = normPhone(p); return d.startsWith('0') ? '62' + d.slice(1) : d; };
export function tierOf(db, m) {
  const ts = [...db.tiers].sort((a, b) => b.min - a.min);
  return ts.find((t) => (m?.spend || 0) >= t.min) || db.tiers[0];
}
export function nextTier(db, m) {
  const ts = [...db.tiers].sort((a, b) => a.min - b.min);
  return ts.find((t) => t.min > (m?.spend || 0)) || null;
}
export function findMemberByPhone(db, phone) { const p = normPhone(phone); return p ? db.members.find((m) => m.phone === p) : null; }
export function upsertMember(db, { name, phone, bday = '', email = '', src = 'kasir' }) {
  const p = normPhone(phone);
  if (p.length < 9) return { m: null, created: false };
  let m = db.members.find((x) => x.phone === p);
  if (m) { if (name && !m.name) m.name = name; if (bday && !m.bday) m.bday = bday; return { m, created: false }; }
  m = { id: uid('m'), name: name || 'Pelanggan', phone: p, email, bday, points: db.settings.welcomePoints, spend: 0, visits: 0, joined: Date.now(), last: 0, src, missions: {} };
  db.members.push(m);
  return { m, created: true };
}
function updateMissions(db, mem, o) {
  const month = dayKey().slice(0, 7);
  const done = [];
  for (const ms of db.missions.filter((x) => x.active)) {
    const st = (mem.missions[ms.id] ||= { p: 0, done: false, month });
    if (st.month !== month) { st.p = 0; st.done = false; st.month = month; }
    if (st.done) continue;
    let inc = 0;
    const L = o.lines.filter((l) => l.s !== 'void' && !l.pkg);
    if (ms.kind === 'visits') inc = 1;
    else if (ms.kind === 'menu') inc = sum(L.filter((l) => l.m === ms.menu), (l) => l.q);
    else if (ms.kind === 'cat') inc = sum(L.filter((l) => menu(db, l.m)?.cat === ms.cat), (l) => l.q);
    else if (ms.kind === 'spend') inc = o.bill?.total || 0;
    st.p += inc;
    if (st.p >= ms.target) { st.done = true; mem.points += ms.reward; done.push(ms); }
  }
  return done;
}

// ---------- Promo & voucher ----------
export function promoActive(p, ts = Date.now()) {
  if (!p.active) return false;
  const d = new Date(ts);
  if (p.days?.length && !p.days.includes(d.getDay())) return false;
  if (p.from && p.to) {
    const hm = d.getHours() * 60 + d.getMinutes();
    const [fh, fm] = p.from.split(':').map(Number), [th, tm] = p.to.split(':').map(Number);
    if (hm < fh * 60 + fm || hm >= th * 60 + tm) return false;
  }
  if (p.until && ts > p.until) return false;
  return true;
}
export function voucherCheck(db, code, sub, memId, ts = Date.now()) {
  const v = db.vouchers.find((x) => x.code.toUpperCase() === String(code || '').trim().toUpperCase());
  if (!v) return { ok: false, msg: 'Kode voucher tidak ditemukan' };
  if (!v.active) return { ok: false, msg: 'Voucher tidak aktif' };
  if (v.until && ts > v.until) return { ok: false, msg: 'Voucher sudah kedaluwarsa' };
  if (v.quota && v.used >= v.quota) return { ok: false, msg: 'Kuota voucher sudah habis' };
  if (v.min && sub < v.min) return { ok: false, msg: `Minimal belanja ${rp(v.min)}` };
  if (v.members?.length && !v.members.includes(memId)) return { ok: false, msg: 'Voucher ini khusus member tertentu. Hubungkan member dulu.' };
  if (v.newOnly && memId) { const m = member(db, memId); if (m && m.visits > 0) return { ok: false, msg: 'Voucher khusus kunjungan pertama' }; }
  return { ok: true, v };
}

// ---------- Hitung tagihan ----------
export function bill(db, o, ts) {
  if (o.status === 'paid' && o.bill) return o.bill;
  ts = ts || o.created || Date.now();
  const L = o.lines.filter((l) => l.s !== 'void' && !l.par);
  const sub = sum(L, (l) => l.q * l.p);
  const discs = [];
  for (const p of db.promos) {
    if (!promoActive(p, ts)) continue;
    if (p.outlets && !p.outlets.includes(o.loc)) continue;
    if (p.type === 'pct-cat') {
      const base = sum(L.filter((l) => !l.pkg && menu(db, l.m)?.cat === p.cat), (l) => l.q * l.p);
      if (base > 0) discs.push({ label: p.name, amt: Math.round(base * p.pct), kind: 'promo', id: p.id });
    } else if (p.type === 'bxgy') {
      const q = sum(L.filter((l) => l.m === p.menu), (l) => l.q);
      const free = Math.floor(q / (p.buy + p.free)) * p.free;
      if (free > 0) discs.push({ label: p.name, amt: free * (menu(db, p.menu)?.price || 0), kind: 'promo', id: p.id });
    }
  }
  let run = Math.max(0, sub - sum(discs, (d) => d.amt));
  if (o.mem) {
    const m = member(db, o.mem), t = m && tierOf(db, m);
    if (t && t.disc > 0 && run > 0) { const a = Math.round(run * t.disc); discs.push({ label: `Diskon member ${t.name} ${Math.round(t.disc * 100)}%`, amt: a, kind: 'member' }); run -= a; }
  }
  if (o.disc?.voucher) {
    const r = voucherCheck(db, o.disc.voucher, sub, o.mem, ts);
    if (r.ok) {
      const v = r.v;
      let a = v.type === 'pct' ? run * v.value : v.value;
      if (v.max) a = Math.min(a, v.max);
      a = Math.min(Math.round(a), run);
      discs.push({ label: `Voucher ${v.code}`, amt: a, kind: 'voucher', code: v.code });
      run -= a;
    }
  }
  if (o.disc?.points) {
    const a = Math.min(o.disc.points * db.settings.pointValue, run);
    discs.push({ label: `Tukar ${o.disc.points} poin`, amt: a, kind: 'points' });
    run -= a;
  }
  if (o.disc?.manual) {
    const md = o.disc.manual;
    let a = md.type === 'pct' ? run * md.value : md.value;
    a = Math.min(Math.round(a), run);
    if (a > 0) { discs.push({ label: `Diskon manual${md.type === 'pct' ? ' ' + Math.round(md.value * 100) + '%' : ''}`, amt: a, kind: 'manual' }); run -= a; }
  }
  const disc = sub - run;
  const svc = Math.round(run * db.settings.serviceRate);
  const tax = Math.round((run + svc) * db.settings.taxRate);
  const deliv = o.delivFee || 0;
  return { sub, discs, disc, base: run, svc, tax, deliv, total: run + svc + tax + deliv };
}

// ---------- Order ----------
export function nextNo(db, locId, prefix) {
  const today = dayKey();
  for (const k of Object.keys(db.counters)) if (!k.includes(today)) delete db.counters[k];
  const k = `${locId}-${today}-${prefix}`;
  db.counters[k] = (db.counters[k] || 0) + 1;
  return prefix + pad(db.counters[k], 3);
}
export function newOrder(db, { loc: L, ch = 'pos', type = 'dine', table = null, by = '', term = '', cust = {}, mem = null, sched = null }) {
  const prefix = ch === 'qr' ? 'Q' : ch === 'web' ? 'W' : L === 'L2' ? 'P' : 'A';
  const o = { id: uid('o'), no: nextNo(db, L, prefix), loc: L, ch, type, table, by, term, cust, mem, status: 'open', created: Date.now(), sched, released: !sched, lines: [], disc: {}, pays: [] };
  db.orders.push(o);
  return o;
}
export function addLine(db, o, menuId, qty = 1, note = '') {
  const m = menu(db, menuId);
  if (!m || m.soldOut || !(m.price > 0)) return null;
  if (o.loc && stockGuardOn(db)) {
    const inDraft = sum(o.lines.filter((l) => l.m === menuId && l.s === 'draft' && !l.par), (l) => l.q);
    if (menuPortions(db, m, o.loc).n < inDraft + qty) return null;
  }
  if (!m.pkg) {
    const ex = o.lines.find((l) => l.m === menuId && l.s === 'draft' && (l.note || '') === (note || '') && !l.par && !l.pkg);
    if (ex) { ex.q += qty; return ex; }
  }
  const ln = { id: uid('l'), m: m.id, n: m.name, q: qty, p: m.price, s: 'draft', st: m.pkg ? 'none' : m.station, note };
  o.lines.push(ln);
  if (m.pkg) {
    ln.pkg = true;
    for (const c of m.pkg) {
      const cm = menu(db, c.m);
      o.lines.push({ id: uid('l'), m: cm.id, n: cm.name, q: c.q * qty, bq: c.q, p: 0, s: 'draft', st: cm.station, par: ln.id, note: '' });
    }
  }
  return ln;
}
export function setDraftQty(o, lineId, q, db = null) {
  const ln = o.lines.find((l) => l.id === lineId);
  if (!ln || ln.s !== 'draft') return false;
  if (q <= 0) { o.lines = o.lines.filter((l) => l.id !== lineId && l.par !== lineId); return true; }
  if (db && q > ln.q && o.loc && stockGuardOn(db)) {
    const other = sum(o.lines.filter((l) => l.m === ln.m && l.s === 'draft' && !l.par && l.id !== ln.id), (l) => l.q);
    if (menuPortions(db, ln.m, o.loc).n < other + q) return false;
  }
  ln.q = q;
  if (ln.pkg) o.lines.filter((l) => l.par === lineId).forEach((c) => (c.q = c.bq * q));
  return true;
}
export function deductLines(db, o, lines, by = '') {
  let total = 0;
  if (!coreOn(db, o.loc)) { for (const ln of lines) if (!ln.sd && ln.s !== 'void') { ln.sd = true; ln.cg = null; } return 0; }
  for (const ln of lines) {
    if (ln.sd || ln.s === 'void') continue;
    const m = menu(db, ln.m);
    ln.sd = true;
    if (!m || ln.pkg) { ln.cg = 0; continue; }
    let c = 0;
    for (const b of m.bom || []) c += consume(db, o.loc, b.i, b.q * ln.q, 'sale', o.no, by);
    ln.cg = Math.round(c);
    total += c;
  }
  if (total > 0) post(db, { e: entityOf(db, o.loc), memo: `HPP ${o.no}`, ref: o.id, l: [['5101', total, 0], ['1201', 0, total]] });
  return total;
}
export function sendLines(db, o, by = '') {
  const now = Date.now();
  let n = 0;
  for (const l of o.lines) {
    if (l.s !== 'draft') continue;
    l.ts = now;
    if (l.pkg || l.st === 'none') l.s = 'served';
    else { l.s = 'new'; n++; }
  }
  if (n) o.readyAt = null;
  o.released = true;
  deductLines(db, o, o.lines.filter((l) => l.s !== 'draft' && !l.sd), by);
  return n;
}
export const kitchenLines = (o) => o.lines.filter((l) => l.st && l.st !== 'none' && !l.pkg && l.s !== 'void' && l.s !== 'draft');
export function kitchenState(o) {
  const K = kitchenLines(o);
  if (!K.length) return 'none';
  if (K.every((l) => l.s === 'served')) return 'served';
  if (K.every((l) => l.s === 'ready' || l.s === 'served')) return 'ready';
  if (K.some((l) => l.s === 'cook' || l.s === 'ready' || l.s === 'served')) return 'cook';
  return 'new';
}
export function setLineStatus(db, o, lineId, s) {
  const l = o.lines.find((x) => x.id === lineId);
  if (!l) return;
  const now = Date.now();
  l.s = s;
  if (s === 'cook') l.tc = now;
  if (s === 'ready') { l.tr = now; l.tc ||= now; }
  if (s === 'served') { l.tv = now; l.tr ||= now; }
  checkReady(db, o);
}
// Semua item siap: catat waktunya (Lounge). Notifikasi siap diantar dikirim server per item.
export function checkReady(db, o) {
  if (kitchenState(o) === 'ready' && !o.readyAt) o.readyAt = Date.now();
}
export function markServed(db, o) {
  const now = Date.now();
  for (const l of kitchenLines(o)) if (l.s !== 'served') { l.s = 'served'; l.tv = now; l.tr ||= now; }
  o.pickedAt = now;
  db.notices.filter((n) => n.order === o.id).forEach((n) => (n.seen = true));
}
// Service mengantar item yang sudah siap (sebagian atau semua). Item yang masih dimasak tidak ikut.
export function serveReady(db, o) {
  if (!o) return 0;
  const now = Date.now();
  let n = 0;
  for (const l of kitchenLines(o)) if (l.s === 'ready') { l.s = 'served'; l.tv = now; n += 1; }
  if (kitchenState(o) === 'served') o.pickedAt = now;
  db.notices.filter((x) => x.order === o.id).forEach((x) => (x.seen = true));
  return n;
}
// Antar satu item (checker per item). Item yang belum ditandai siap dapur juga boleh diantar oleh checker.
export function serveLine(db, o, lineId) {
  const l = o?.lines.find((x) => x.id === lineId);
  if (!l || !['new', 'cook', 'ready'].includes(l.s)) return 0;
  const now = Date.now();
  l.s = 'served'; l.tv = now; l.tr ||= now; l.tc ||= now;
  if (kitchenState(o) === 'served') o.pickedAt = now;
  db.notices.filter((x) => x.line === lineId).forEach((x) => (x.seen = true));
  return 1;
}
// Item siap diantar di satu outlet, urut dari yang paling lama menunggu
export function readyItems(db, L, t0 = 0) {
  const out = [];
  for (const o of db.orders) {
    if (o.loc !== L || o.status === 'void' || o.created < t0) continue;
    for (const l of kitchenLines(o)) if (l.s === 'ready') out.push({ o, l });
  }
  return out.sort((a, b) => (a.l.tr || 0) - (b.l.tr || 0));
}
export function voidLine(db, o, lineId, reason, u) {
  const ln = o.lines.find((l) => l.id === lineId);
  if (!ln) return;
  const group = [ln, ...o.lines.filter((l) => l.par === lineId)];
  const sent = group.some((l) => l.s !== 'draft');
  if (!sent) { o.lines = o.lines.filter((l) => !group.includes(l)); return; }
  let waste = 0;
  for (const l of group) { if (l.sd) waste += l.cg || 0; l.s = 'void'; l.vr = reason; l.vby = u.id; l.vat = Date.now(); }
  if (waste) post(db, { e: entityOf(db, o.loc), memo: `Waste void ${o.no}`, ref: o.id, l: [['6105', waste, 0], ['5101', 0, waste]] });
  flag(db, { type: 'Void item setelah ke dapur', sev: 'sedang', msg: `${ln.q}× ${ln.n} di ${o.no} dibatalkan. Alasan: ${reason}`, user: u.id, ref: o.id, loc: o.loc });
  voidPattern(db, u, o.loc);
  checkReady(db, o);
}
function voidPattern(db, u, L) {
  const since = Date.now() - 8 * 3600000;
  const n = db.flags.filter((f) => f.user === u.id && f.at > since && f.type.startsWith('Void')).length;
  if (n === 3) flag(db, { type: 'Pola void berulang', sev: 'tinggi', msg: `${u.name} melakukan ${n} pembatalan dalam 8 jam terakhir.`, user: u.id, loc: L });
}
export function voidOrder(db, o, reason, u) {
  const sent = o.lines.some((l) => l.s !== 'draft' && l.s !== 'void');
  let waste = 0;
  for (const l of o.lines) { if (l.sd && l.s !== 'void') waste += l.cg || 0; if (l.s !== 'void') { l.s = 'void'; l.vr = reason; l.vby = u.id; l.vat = Date.now(); } }
  o.status = 'void'; o.voidReason = reason; o.voidBy = u.id; o.voidAt = Date.now();
  if (waste) post(db, { e: entityOf(db, o.loc), memo: `Waste void ${o.no}`, ref: o.id, l: [['6105', waste, 0], ['5101', 0, waste]] });
  if (sent) {
    flag(db, { type: 'Void bill', sev: 'tinggi', msg: `Bill ${o.no}${o.table ? ' (meja ' + o.table + ')' : ''} dibatalkan setelah pesanan diproses. Alasan: ${reason}`, user: u.id, ref: o.id, loc: o.loc });
    voidPattern(db, u, o.loc);
  }
}

// ---------- Shift kasir ----------
export const activeShift = (db, terminal) => db.shifts.find((s) => s.term === terminal && !s.closeAt);
// 2.9 · Nama petugas shift (anggota shift), bukan nama akun login
export const shiftName = (db, sh) => (sh && (sh.crewName || userName(db, sh.user))) || '—';
export const crewFor = (db, role, L) => (db.crew || []).filter((c) => c.active && c.role === role && (!c.loc || !L || c.loc === L));
// Nama kasir di nota: petugas shift tempat nota dibayar / terminal pembuatnya, lalu nama akun
export function cashierName(db, o, byPaid = true) {
  const sh = (byPaid && o.shift && db.shifts.find((s) => s.id === o.shift)) || (o.term && db.shifts.find((s) => s.term === o.term && s.loc === o.loc && s.openAt <= (o.created || Date.now()) && (!s.closeAt || s.closeAt >= (o.created || 0))));
  return sh?.crewName || userName(db, byPaid ? o.paidBy || o.by : o.by);
}
export function openShift(db, u, terminal, L, cash) {
  const s = { id: uid('sh'), user: u.id, term: terminal, loc: L, openAt: Date.now(), openCash: cash };
  db.shifts.unshift(s);
  return s;
}
export function shiftSummary(db, sh) {
  const os = db.orders.filter((o) => o.shift === sh.id && o.status === 'paid');
  const by = {};
  for (const o of os) for (const p of o.pays) by[p.m] = (by[p.m] || 0) + p.a;
  const dt = db.depositTx.filter((t) => t.shift === sh.id);
  const topCash = sum(dt.filter((t) => t.type === 'topup' && t.m === 'cash'), (t) => t.a);
  const refCash = sum(dt.filter((t) => t.type === 'refund'), (t) => t.a);
  const noSale = sh.noSale || 0;
  const expected = sh.openCash + (by.cash || 0) + topCash - refCash;
  const voids = db.orders.filter((o) => o.status === 'void' && o.voidAt >= sh.openAt && o.voidBy === sh.user && (!sh.closeAt || o.voidAt <= sh.closeAt)).length;
  return { count: os.length, total: sum(os, (o) => o.bill.total), disc: sum(os, (o) => o.bill.disc), by, topCash, refCash, expected, voids, noSale };
}
export function closeShift(db, sh, counted, u) {
  const s = shiftSummary(db, sh);
  sh.closeAt = Date.now(); sh.counted = counted; sh.expected = s.expected; sh.var = counted - s.expected; sh.closedBy = u.id;
  if (Math.abs(sh.var) > db.settings.cashVarTol) flag(db, { type: 'Selisih kas tutup shift', sev: 'tinggi', msg: `Shift ${user(db, sh.user)?.name} di ${sh.term}: selisih ${rp(sh.var)} (seharusnya ${rp(s.expected)}, dihitung ${rp(counted)}).`, user: sh.user, ref: sh.id, loc: sh.loc });
  return sh;
}

// ---------- Pembayaran ----------
export function settle(db, o, pays, u, { shift = null, send = true, tendered = 0 } = {}) {
  const b = bill(db, o, o.created);
  const nonCash = sum(pays.filter((p) => p.m !== 'cash'), (p) => p.a);
  if (nonCash > b.total) return { ok: false, msg: 'Pembayaran non-tunai melebihi total tagihan' };
  const cashGiven = sum(pays.filter((p) => p.m === 'cash'), (p) => p.a);
  if (nonCash + cashGiven < b.total) return { ok: false, msg: `Pembayaran kurang ${rp(b.total - nonCash - cashGiven)}` };
  for (const p of pays.filter((p) => p.m === 'deposit')) {
    const c = db.deposits.find((d) => d.id === p.card);
    if (!c || !c.active) return { ok: false, msg: 'Kartu deposit tidak ditemukan atau nonaktif' };
    if (c.balance < p.a) return { ok: false, msg: `Saldo kartu ${c.id} kurang (${rp(c.balance)})` };
  }
  const norm = pays.filter((p) => p.m !== 'cash' && p.a > 0).map((p) => ({ ...p }));
  const cashNet = b.total - nonCash;
  if (cashNet > 0) norm.push({ m: 'cash', a: cashNet });
  o.bill = b; o.pays = norm; o.status = 'paid'; o.paidAt = Date.now(); o.paidBy = u?.id || 'online'; o.shift = shift;
  o.change = Math.max(0, cashGiven - cashNet); o.tendered = tendered || cashGiven;
  if (send) sendLines(db, o, u?.id);
  const e = entityOf(db, o.loc);
  const dr = {};
  for (const p of norm) dr[PAY[p.m].acc] = (dr[PAY[p.m].acc] || 0) + p.a;
  const l = Object.entries(dr).map(([a, v]) => [a, v, 0]);
  if (b.disc) l.push(['4201', b.disc, 0]);
  l.push(['4101', 0, b.sub]);
  if (b.tax) l.push(['2104', 0, b.tax]);
  if (b.svc + b.deliv) l.push(['4103', 0, b.svc + b.deliv]);
  post(db, { e, memo: `Penjualan ${o.no}`, ref: o.id, cf: 'Penerimaan dari pelanggan', l });
  for (const p of norm.filter((p) => p.m === 'deposit')) {
    const c = db.deposits.find((d) => d.id === p.card);
    c.balance -= p.a;
    db.depositTx.unshift({ id: uid('dt'), t: Date.now(), card: c.id, a: p.a, type: 'pay', ref: o.no, by: u?.id, shift });
  }
  const vd = b.discs.find((d) => d.kind === 'voucher');
  if (vd) { const v = db.vouchers.find((x) => x.code === vd.code); if (v) { v.used = (v.used || 0) + 1; v.rev = (v.rev || 0) + b.total; v.cost = (v.cost || 0) + vd.amt; } }
  let missions = [], earned = 0;
  if (o.mem) {
    const m = member(db, o.mem);
    if (m) {
      const t = tierOf(db, m);
      if (o.disc?.points) m.points = Math.max(0, m.points - o.disc.points);
      earned = Math.floor((b.base / db.settings.pointsPer) * (t.mult || 1));
      m.points += earned; m.spend += b.total; m.visits += 1; m.last = Date.now();
      missions = updateMissions(db, m, o);
      o.earned = earned;
    }
  }
  return { ok: true, bill: b, change: o.change, earned, missions };
}

// ---------- Deposit (food court) ----------
export function newCard(db, { holder, phone, mem }) {
  const n = db.deposits.length + 1;
  const c = { id: 'KD-' + pad(n, 4), holder, phone: normPhone(phone), mem: mem || null, balance: 0, active: true, created: Date.now() };
  db.deposits.push(c);
  return c;
}
export function topup(db, card, amt, m, u, shift, L = 'L1') {
  card.balance += amt;
  db.depositTx.unshift({ id: uid('dt'), t: Date.now(), card: card.id, a: amt, type: 'topup', m, by: u.id, shift });
  post(db, { e: entityOf(db, L), memo: `Top-up ${card.id}`, ref: card.id, cf: 'Top-up deposit pelanggan', l: [[PAY[m].acc, amt, 0], ['2103', 0, amt]] });
}
export function refundCard(db, card, u, shift, L = 'L1') {
  const amt = card.balance;
  if (amt <= 0) return 0;
  card.balance = 0;
  db.depositTx.unshift({ id: uid('dt'), t: Date.now(), card: card.id, a: amt, type: 'refund', m: 'cash', by: u.id, shift });
  post(db, { e: entityOf(db, L), memo: `Refund saldo ${card.id}`, ref: card.id, cf: 'Refund deposit pelanggan', l: [['2103', amt, 0], ['1101', 0, amt]] });
  flag(db, { type: 'Refund saldo deposit', sev: 'rendah', msg: `Refund tunai ${rp(amt)} dari kartu ${card.id} (${card.holder}).`, user: u.id, ref: card.id, loc: L });
  return amt;
}

// ---------- Rekomendasi menu (berbasis data penjualan) ----------
let recoCache = { rev: -1, map: new Map() };
function memo(db, key, fn) {
  if (recoCache.rev !== db.rev) recoCache = { rev: db.rev, map: new Map() };
  if (!recoCache.map.has(key)) recoCache.map.set(key, fn());
  return recoCache.map.get(key);
}
export function coBought(db, ids, n = 3, locId) {
  const key = 'co|' + [...ids].sort().join(',') + '|' + n + '|' + locId;
  return memo(db, key, () => {
    const set = new Set(ids);
    const cnt = {};
    let base = 0;
    const since = Date.now() - 30 * DAY;
    for (const o of db.orders) {
      if (o.status !== 'paid' || o.created < since) continue;
      const ms = new Set(o.lines.filter((l) => !l.par && l.s !== 'void').map((l) => l.m));
      let hit = false;
      for (const i of set) if (ms.has(i)) { hit = true; break; }
      if (!hit) continue;
      base++;
      for (const m of ms) if (!set.has(m)) cnt[m] = (cnt[m] || 0) + 1;
    }
    return Object.entries(cnt).filter(([m]) => menuOrderable(db, m, locId)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([m, c]) => ({ m, conf: c / base }));
  });
}
export function topNow(db, hour, n = 4, locId) {
  return memo(db, 'top|' + hour + '|' + n + '|' + locId, () => {
    const cnt = {};
    const since = Date.now() - 28 * DAY;
    for (const o of db.orders) {
      if (o.status !== 'paid' || o.created < since) continue;
      const h = new Date(o.created).getHours();
      if (Math.abs(h - hour) > 1) continue;
      for (const l of o.lines) if (!l.par && l.s !== 'void') cnt[l.m] = (cnt[l.m] || 0) + l.q;
    }
    return Object.entries(cnt).filter(([m]) => menuOrderable(db, m, locId) && !menu(db, m).pkg).sort((a, b) => b[1] - a[1]).slice(0, n).map(([m, q]) => ({ m, q }));
  });
}
// Menu terlaris N hari terakhir (untuk promo Lounge & layar pelanggan)
export function topSellers(db, days = 7, n = 3, locId = 'L1', cat = null) {
  return memo(db, `ts|${days}|${n}|${locId}|${cat}`, () => {
    const cnt = {};
    const since = Date.now() - days * DAY;
    for (const o of db.orders) {
      if (o.status !== 'paid' || o.created < since || (locId && o.loc !== locId)) continue;
      for (const l of o.lines) if (!l.par && l.s !== 'void') cnt[l.m] = (cnt[l.m] || 0) + l.q;
    }
    return Object.entries(cnt).filter(([m]) => menuOrderable(db, m, locId) && menu(db, m).station !== 'none' && (!cat || menu(db, m).cat === cat)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([m, q]) => ({ m, q }));
  });
}

// ---------- Penjadwal: rilis scheduled order ke dapur ----------
export function dueScheduled(db) {
  const now = Date.now(), lead = db.settings.scheduleLead * 60000;
  return db.orders.filter((o) => o.sched && !o.released && o.status !== 'void' && now >= o.sched - lead);
}
export function releaseDue(db) {
  const due = dueScheduled(db);
  for (const o of due) sendLines(db, o, 'auto');
  return due.length;
}

// ---------- Reservasi ----------
export const RES_ACTIVE = ['menunggu', 'dikonfirmasi', 'datang'];
export function resStart(r) { const [h, m] = r.time.split(':').map(Number); const d = new Date(r.date + 'T00:00:00'); d.setHours(h, m, 0, 0); return d.getTime(); }
export const resTables = (r) => [r.table, ...(r.join || [])].filter(Boolean);
export const resTableLabel = (r) => resTables(r).join(' + ') || '—';
export function tableFree(db, tableId, start, durMin, ignoreId) {
  const end = start + durMin * 60000;
  return !db.reservations.some((r) => r.id !== ignoreId && resTables(r).includes(tableId) && RES_ACTIVE.includes(r.status) && resStart(r) < end && resStart(r) + durMin * 60000 > start);
}
// Jarak antar meja di denah (x,y dalam persen; lebar denah 1,27× tingginya)
const tDist = (a, b) => Math.hypot(((a.x ?? 0) - (b.x ?? 0)) * 1.27, (a.y ?? 0) - (b.y ?? 0));
// Cari meja untuk reservasi. Kalau tidak ada satu meja yang cukup, gabungkan meja terdekat di area yang sama.
// Hasil: { ...meja utama, join: [kode meja tambahan], seats: total kursi } atau null.
export function suggestTable(db, { date, time, pax, area }, ignoreId) {
  const start = resStart({ date, time });
  const dur = db.settings.resDuration;
  const free = db.tables.filter((t) => (!area || t.area === area) && tableFree(db, t.id, start, dur, ignoreId));
  const one = free.filter((t) => t.seats >= pax).sort((a, b) => a.seats - b.seats)[0];
  if (one) return { ...one, join: [] };
  let best = null;
  for (const a of [...new Set(free.map((t) => t.area))]) {
    const inA = free.filter((t) => t.area === a);
    for (const t of inA) {
      const g = [t];
      let seats = t.seats;
      for (const x of inA.filter((y) => y !== t).sort((p, q) => tDist(t, p) - tDist(t, q))) { if (seats >= pax) break; g.push(x); seats += x.seats; }
      if (seats < pax) continue;
      const spread = sum(g, (y) => tDist(t, y));
      if (!best || g.length < best.g.length || (g.length === best.g.length && spread < best.s)) best = { g, s: spread };
    }
  }
  return best ? { ...best.g[0], join: best.g.slice(1).map((t) => t.id), seats: sum(best.g, (t) => t.seats) } : null;
}

// ---------- Laporan keuangan ----------
export function balances(db, ents, from = 0, to = Infinity) {
  const b = {};
  for (const j of db.journals) {
    if (!ents.includes(j.e) || j.d < from || j.d > to) continue;
    for (const [a, dr, cr] of j.l) b[a] = (b[a] || 0) + dr - cr;
  }
  if (ents.length > 1) {
    const ic = -(b['4102'] || 0);
    if (ic) { b['4102'] = 0; b['5101'] = (b['5101'] || 0) - ic; b.__elimRev = ic; }
    const ar = b['1104'] || 0, ap = -(b['2102'] || 0);
    const m = Math.min(ar, ap);
    if (m > 0) { b['1104'] = ar - m; b['2102'] = -(ap - m); b.__elimAR = m; }
  }
  return b;
}
export function cashflow(db, ents, from, to) {
  const cashAcc = db.accounts.filter((a) => a.cash).map((a) => a.code);
  let open = 0, close = 0;
  const groups = {};
  for (const j of db.journals) {
    if (!ents.includes(j.e) || j.d > to) continue;
    const delta = sum(j.l.filter((x) => cashAcc.includes(x[0])), (x) => x[1] - x[2]);
    if (!delta) continue;
    if (j.d < from) { open += delta; continue; }
    const k = j.cf || 'Lainnya';
    groups[k] = (groups[k] || 0) + delta;
  }
  close = open + sum(Object.values(groups));
  return { open, close, groups };
}
export const CF_SECTION = {
  'Penerimaan dari pelanggan': 'ops', 'Top-up deposit pelanggan': 'ops', 'Refund deposit pelanggan': 'ops', 'Pembayaran ke supplier': 'ops',
  'Beban operasional': 'ops', 'Pembayaran antar perusahaan': 'ops', 'Pembelian aset tetap': 'inv', 'Setoran modal': 'fin', 'Saldo awal': 'fin',
};

export function periodRange(key, custom = {}) {
  const now = Date.now(), t0 = startOfDay();
  switch (key) {
    case 'today': return [t0, now];
    case 'yesterday': return [t0 - DAY, t0 - 1];
    case '7d': return [t0 - 6 * DAY, now];
    case 'month': { const d = new Date(); return [new Date(d.getFullYear(), d.getMonth(), 1).getTime(), now]; }
    case 'custom': return [custom.from ? startOfDay(new Date(custom.from + 'T00:00:00').getTime()) : t0 - 29 * DAY, custom.to ? startOfDay(new Date(custom.to + 'T00:00:00').getTime()) + DAY - 1 : now];
    default: return [t0 - 29 * DAY, now];
  }
}
export const PERIODS = [['today', 'Hari ini'], ['yesterday', 'Kemarin'], ['7d', '7 hari'], ['month', 'Bulan ini'], ['30d', '30 hari'], ['custom', 'Pilih tanggal']];
