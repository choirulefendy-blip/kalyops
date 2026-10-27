// Kaly Ops ↔ Supabase: login staf, muat data sesuai peran, sinkron antar perangkat, dan pemanggil fungsi database.
// Tampilan tetap membaca data dari `db` (bentuknya sama dengan versi 1.0), semua perubahan dikirim ke database.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { emit } from './bus.js';

const url = String(SUPABASE_URL || '').trim().replace(/\/+$/, '');
const key = String(SUPABASE_ANON_KEY || '').trim();
export const configured = /^https?:\/\/[^\s]+$/.test(url) && key.length > 20 && !/xxxx|abcdefghijklm/.test(url);
export const sb = configured && window.supabase
  ? window.supabase.createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'kaly.auth', detectSessionInUrl: false } })
  : null;
export const projectHost = configured ? url.replace(/^https?:\/\//, '') : '';
export const imageUrl = (path) => (path && configured ? `${url}/storage/v1/object/public/menu-images/${String(path).split('/').map(encodeURIComponent).join('/')}` : null);

// ---------- Pemanggil & pesan error ----------
export function errMsg(e) {
  if (!e) return 'Terjadi kesalahan';
  const m = String(e.message || e.error_description || e.msg || e);
  if (/Failed to fetch|NetworkError|Load failed|fetch failed|network request failed/i.test(m)) return 'Tidak tersambung ke server. Cek koneksi internet, lalu coba lagi.';
  if (/JWT expired|invalid JWT|refresh token/i.test(m)) return 'Sesi login habis. Silakan masuk lagi.';
  if (/row-level security|permission denied/i.test(m)) return 'Akun ini tidak punya akses untuk tindakan tersebut';
  if (/duplicate key/i.test(m)) return 'Data dengan kode yang sama sudah ada';
  if (/violates foreign key/i.test(m)) return 'Data ini masih dipakai di data lain, jadi tidak bisa dihapus atau diubah';
  if (/deadlock detected|could not serialize/i.test(m)) return 'Server sedang sibuk melayani perangkat lain. Coba sekali lagi.';
  if (e.code === 'PGRST202' || /Could not find the function/i.test(m)) return 'Database Supabase belum diperbarui ke versi aplikasi ini. Owner: jalankan ulang kaly-ops-supabase.sql terbaru di SQL Editor.';
  return m;
}
// Dua perangkat mengubah data yang sama di saat bersamaan kadang ditolak database (deadlock / serialisasi).
// Transaksinya dibatalkan utuh, jadi aman diulang otomatis beberapa kali.
const retryable = (e) => e && (e.code === '40P01' || e.code === '40001' || e.code === '55P03' || /deadlock detected|could not serialize/i.test(e.message || ''));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export async function rpc(fn, args = {}) {
  for (let i = 0; ; i++) {
    const { data, error } = await sb.rpc(fn, args);
    if (!error) return data;
    if (i < 3 && retryable(error)) { await pause(120 + Math.random() * 300 * (i + 1)); continue; }
    throw new Error(errMsg(error));
  }
}
export async function run(q) {
  for (let i = 0; ; i++) {
    const { data, error } = await q;
    if (!error) return data;
    if (i < 3 && retryable(error)) { await pause(120 + Math.random() * 300 * (i + 1)); continue; }
    throw new Error(errMsg(error));
  }
}
// Ambil semua baris (Supabase membatasi 1000 baris per permintaan)
async function all(build, page = 1000) {
  const out = [];
  for (let from = 0; ; from += page) {
    const rows = await run(build().range(from, from + page - 1));
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}

// ---------- Konversi baris database → bentuk data aplikasi ----------
const T = (s) => (s ? Date.parse(s) : null);
const N = (x) => (x == null || x === '' ? 0 : Number(x));
const NN = (x) => (x == null || x === '' ? null : Number(x));
const hm = (t) => (t ? String(t).slice(0, 5) : '');
const by = (k) => (a, b) => (a[k] ?? 0) - (b[k] ?? 0);
const group = (rows, k) => { const m = new Map(); for (const r of rows) { const v = r[k]; if (!m.has(v)) m.set(v, []); m.get(v).push(r); } return m; };

export const SETTINGS_MAP = {
  taxRate: 'tax_rate', serviceRate: 'service_rate', pointsPer: 'points_per', pointValue: 'point_value', welcomePoints: 'welcome_points',
  autoProduce: 'auto_produce', stockGuard: 'stock_guard', slaMin: 'sla_min', discApproval: 'disc_approval', cashVarTol: 'cash_var_tol',
  poPriceTol: 'po_price_tol', poApproval: 'po_approval', transferFee: 'transfer_fee', delivBase: 'deliv_base', delivPerKm: 'deliv_per_km',
  maxKm: 'max_km', sameDayCutoff: 'same_day_cutoff', scheduleLead: 'schedule_lead', resDuration: 'res_duration', autoConfirmRes: 'auto_confirm_res',
  openHour: 'open_hour', closeHour: 'close_hour', qrAutoSend: 'qr_auto_send', demoOnlinePay: 'demo_online_pay', b2bMarkup: 'b2b_markup', birthdayPct: 'birthday_pct',
};
const BOOL_SETTINGS = new Set(['autoProduce', 'stockGuard', 'autoConfirmRes', 'qrAutoSend', 'demoOnlinePay']);
export function mapSettings(r) {
  const s = { brand: { name: r.brand_name, tagline: r.brand_tagline, color: r.brand_color, accent: r.brand_accent }, timezone: r.timezone };
  for (const [k, c] of Object.entries(SETTINGS_MAP)) s[k] = BOOL_SETTINGS.has(k) ? !!r[c] : k === 'sameDayCutoff' ? hm(r[c]) : N(r[c]);
  s.qrisImage = r.qris_image || '';
  s.printCopies = printCopies(r.print_copies);
  s.receipt = receiptCfg(r.receipt);
  return s;
}
// Tampilan nota (Pengaturan › Cetak nota › Atur tampilan nota)
export const RECEIPT_DEFAULT = { logo: true, name: '', header: '', outlet: true, cashier: true, member: true, footer: 'Terima kasih sudah mampir.\nSampai jumpa di tengah sawah.', paper: 58, font: 'normal', qris: false };
export function receiptCfg(v) {
  const o = v && typeof v === 'object' ? v : {}, d = { ...RECEIPT_DEFAULT };
  for (const k of Object.keys(d)) if (o[k] !== undefined && o[k] !== null && typeof o[k] === typeof d[k]) d[k] = typeof d[k] === 'string' ? String(o[k]).slice(0, 400) : o[k];
  if (![58, 80].includes(d.paper)) d.paper = 58;
  if (!['kecil', 'normal', 'besar'].includes(d.font)) d.font = 'normal';
  return d;
}
// Jumlah lembar sekali cetak: nota pelanggan, salinan kasir, slip Bar, slip Dapur (0 = tidak dicetak)
export function printCopies(v) {
  const d = { cust: 1, copy: 1, bar: 1, dapur: 1 }, o = v && typeof v === 'object' ? v : {};
  for (const k of Object.keys(d)) { const n = Number(o[k]); if (Number.isFinite(n)) d[k] = Math.max(0, Math.min(5, Math.round(n))); }
  return d;
}
// Perubahan pengaturan (nama aplikasi) → kolom tabel settings
export function settingsRow(patch) {
  const row = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'brand') { if ('name' in v) row.brand_name = v.name; if ('tagline' in v) row.brand_tagline = v.tagline; if ('color' in v) row.brand_color = v.color; if ('accent' in v) row.brand_accent = v.accent; continue; }
    if (k === 'qrisImage') { row.qris_image = v || null; continue; }
    if (k === 'printCopies') { row.print_copies = printCopies(v); continue; }
    if (k === 'receipt') { row.receipt = receiptCfg(v); continue; }
    if (SETTINGS_MAP[k]) row[SETTINGS_MAP[k]] = v;
  }
  return row;
}
const DEFAULT_SETTINGS = mapSettings({ brand_name: 'Kaly Eatery', brand_tagline: 'Eat x Play x Nature', brand_color: '#475331', brand_accent: '#CC5E44', timezone: 'Asia/Jakarta',
  tax_rate: 0.1, service_rate: 0, points_per: 10000, point_value: 100, welcome_points: 20, auto_produce: true, stock_guard: true, sla_min: 15, disc_approval: 0.15,
  cash_var_tol: 20000, po_price_tol: 0.1, po_approval: 3000000, transfer_fee: 2500, deliv_base: 8000, deliv_per_km: 3000, max_km: 10, same_day_cutoff: '15:00',
  schedule_lead: 30, res_duration: 120, auto_confirm_res: false, open_hour: 9, close_hour: 21, qr_auto_send: true, demo_online_pay: false, b2b_markup: 0.15, birthday_pct: 0.25 });

export function mapLine(r) {
  const l = { id: r.id, m: r.menu_id, n: r.name, q: N(r.qty), p: N(r.price), s: r.status, st: r.station, note: r.note || '', sort: N(r.sort) };
  if (r.sent_at) l.ts = T(r.sent_at);
  if (r.cook_at) l.tc = T(r.cook_at);
  if (r.ready_at) l.tr = T(r.ready_at);
  if (r.served_at) l.tv = T(r.served_at);
  if (r.slip_at) l.slip = T(r.slip_at);
  if (r.parent_line_id) { l.par = r.parent_line_id; l.bq = NN(r.base_qty); }
  if (r.is_package) l.pkg = true;
  if (r.stock_deducted) l.sd = true;
  if (r.cost != null) l.cg = N(r.cost);
  if (r.void_reason) { l.vr = r.void_reason; l.vby = r.void_by; l.vat = T(r.void_at); }
  return l;
}
export function mapOrder(r) {
  const o = {
    id: r.id, no: r.no, loc: r.location_id, ch: r.channel, type: r.type, table: r.table_id, merged: r.merged_tables || [], by: r.created_by, term: r.terminal,
    cust: { name: r.customer_name || '', phone: r.customer_phone || '', addr: r.customer_addr || '', ...(r.distance_km != null ? { km: N(r.distance_km) } : {}) },
    mem: r.member_id, res: r.reservation_id, status: r.status, created: T(r.created_at), sched: T(r.scheduled_at), released: r.released,
    delivFee: N(r.delivery_fee), dlv: r.delivery_status, disc: r.discount || {}, bill: r.bill || null, total: NN(r.total),
    paidAt: T(r.paid_at), paidBy: r.paid_by, shift: r.shift_id, change: N(r.change_amount), tendered: N(r.tendered), earned: N(r.earned_points),
    readyAt: T(r.ready_at), pickedAt: T(r.picked_at), voidReason: r.void_reason, voidBy: r.void_by, voidAt: T(r.void_at),
    splitFrom: r.split_from, mergedInto: r.merged_into, token: r.public_token, payPending: !!r.payment_pending, prints: N(r.prints),
    ks: r.kitchen_state, updated: T(r.updated_at), bizDay: r.biz_day,
    lines: (r.order_lines || []).map(mapLine).sort(by('sort')),
    pays: (r.order_payments || []).map((p) => ({ m: p.method, a: N(p.amount), ...(p.card_id ? { card: p.card_id } : {}) })),
  };
  return o;
}
const mapShift = (r) => ({ id: r.id, user: r.staff_id, term: r.terminal, loc: r.location_id, openAt: T(r.open_at), openCash: N(r.open_cash), closeAt: T(r.close_at),
  counted: NN(r.counted), expected: NN(r.expected), var: NN(r.variance), closedBy: r.closed_by, noSale: N(r.no_sale) });
export const mapMember = (r) => ({ id: r.id, name: r.name, phone: r.phone, email: r.email || '', bday: r.birthday || '', points: N(r.points), spend: N(r.spend), visits: N(r.visits),
  joined: T(r.joined_at), last: T(r.last_visit_at) || 0, src: r.source, missions: {}, updated: T(r.updated_at) });
const mapRes = (r) => ({ id: r.id, code: r.code, name: r.name, phone: r.phone, date: r.date, time: hm(r.time), pax: N(r.pax), area: r.area || '', table: r.table_id,
  join: r.join_tables || [], status: r.status, src: r.source, note: r.note || '', created: T(r.created_at), mem: r.member_id, order: r.order_id });
const mapFlag = (r) => ({ id: r.id, at: T(r.at), type: r.type, sev: r.severity, msg: r.message, user: r.staff_id, ref: r.ref || '', loc: r.location_id || '', status: r.status,
  checkedBy: r.checked_by, checkedAt: T(r.checked_at) });

// ---------- Data di memori (bentuk sama dengan versi 1.0) ----------
function emptyDb() {
  return {
    version: 3, rev: 1, settings: { ...DEFAULT_SETTINGS, brand: { ...DEFAULT_SETTINGS.brand } },
    entities: [], locations: [], users: [], accounts: [], items: [], stock: {}, moves: [], menus: [], cats: [], promos: [], vouchers: [], areas: [], tables: [],
    orders: [], shifts: [], flags: [], notices: [], members: [], tiers: [], missions: [], campaigns: [], deposits: [], depositTx: [], reservations: [],
    suppliers: [], supplierPrices: [], itemSup: {}, pos: [], transfers: [], productions: [], opnames: [], b2b: [], journals: [], journalDetail: null, counters: {}, alerts: [],
    printers: [], printJobs: [],
  };
}
export const db = emptyDb();
export let me = null;
let ready = false;
export const isReady = () => ready;
const touch = () => { db.rev = (db.rev || 0) + 1; };

// Status koneksi untuk indikator di atas layar
let status = 'off';
export const syncStatus = () => status;
function setStatus(s) { if (s !== status) { status = s; emit('status'); } }

// Pesanan yang sedang punya perubahan lokal belum selesai dikirim tidak ditimpa sinkron
const busy = new Map();
export const isBusy = (id) => (busy.get(id) || 0) > 0;
export function markBusy(id, d) { const n = Math.max(0, (busy.get(id) || 0) + d); if (n) busy.set(id, n); else busy.delete(id); }

const ALL = ['owner', 'kasir', 'dapur', 'gudang', 'service'];
const can = (roles) => !!me && roles.includes(me.role);
const isoDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const DAY = 86400000;
const WINDOW = { owner: 35, kasir: 8, service: 8, dapur: 8, gudang: 3 };
let orderDays = 2, ordersSince = null, membersSince = null;
const orderMap = new Map();
const ORDER_SEL = '*, order_lines(*), order_payments(method, amount, card_id)';

function putOrders(rows, replaceAll = false) {
  if (replaceAll) orderMap.clear();
  let maxU = 0;
  for (const r of rows) {
    const u = T(r.updated_at) || 0;
    if (u > maxU) maxU = u;
    if (isBusy(r.id)) continue;
    orderMap.set(r.id, mapOrder(r));
  }
  db.orders = [...orderMap.values()].sort((a, b) => a.created - b.created);
  return maxU;
}
async function loadOrders({ full = false, days } = {}) {
  if (days) orderDays = days;
  const from = isoDay(Date.now() - (orderDays - 1) * DAY);
  if (full || !ordersSince) {
    const rows = await all(() => sb.from('orders').select(ORDER_SEL).or(`status.eq.open,biz_day.gte.${from}`).order('created_at'), 500);
    const maxU = putOrders(rows, true);
    ordersSince = new Date((maxU || Date.now()) - 30000).toISOString();
  } else {
    const rows = await all(() => sb.from('orders').select(ORDER_SEL).gte('updated_at', ordersSince).order('updated_at'), 500);
    const maxU = putOrders(rows);
    if (maxU) ordersSince = new Date(Math.max(Date.parse(ordersSince) + 30000, maxU) - 30000).toISOString();
    // buang pesanan lama yang sudah tutup dari memori
    const cut = Date.now() - orderDays * DAY - DAY;
    for (const [id, o] of orderMap) if (o.status !== 'open' && o.created < cut) orderMap.delete(id);
  }
}
export async function refreshOrder(id) {
  if (!id || isBusy(id)) return;
  const rows = await run(sb.from('orders').select(ORDER_SEL).eq('id', id));
  if (isBusy(id)) return;
  if (rows.length) { orderMap.set(id, mapOrder(rows[0])); db.orders = [...orderMap.values()].sort((a, b) => a.created - b.created); }
  touch(); emit('local');
}

const LOADERS = {
  settings: { roles: ALL, fn: async () => { const r = await run(sb.from('settings').select('*').eq('id', 1).maybeSingle()); if (r) db.settings = mapSettings(r); } },
  org: { roles: ALL, fn: async () => {
    const [e, l, a] = await Promise.all([run(sb.from('entities').select('*')), run(sb.from('locations').select('*').order('id')), run(sb.from('accounts').select('*').order('code'))]);
    db.entities = e.map((r) => ({ id: r.id, name: r.name, short: r.short }));
    db.locations = l.filter((r) => r.active !== false).map((r) => ({ id: r.id, name: r.name, entity: r.entity_id, type: r.type, core: r.core_stock !== false, route: r.print_route || {} }));
    db.accounts = a.map((r) => ({ code: r.code, name: r.name, type: r.type, ...(r.is_cash ? { cash: true } : {}) }));
  } },
  staff: { roles: ALL, fn: async () => {
    const rows = await run(sb.from('staff').select('id, user_id, email, name, role, outlets, active, created_at').order('created_at'));
    db.users = rows.map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role, outlets: r.outlets, active: r.active, linked: !!r.user_id }));
  } },
  tables: { roles: ALL, fn: async () => {
    const [a, t] = await Promise.all([run(sb.from('areas').select('*').order('sort')), run(sb.from('dining_tables').select('*').eq('active', true).order('sort'))]);
    db.areas = a.map((r) => r.name);
    db.tables = t.map((r) => ({ id: r.id, area: r.area, seats: N(r.seats), loc: r.location_id, x: NN(r.x), y: NN(r.y), ...(r.is_gazebo ? { gazebo: true } : {}), sort: N(r.sort),
      ...(r.hold_order && Date.now() - T(r.hold_at) < 12 * 3600000 ? { hold: { order: r.hold_order, at: T(r.hold_at) } } : {}) }));
  } },
  menus: { roles: ALL, fn: async () => {
    const [c, m, o, b, p] = await Promise.all([run(sb.from('menu_categories').select('*').order('sort')), all(() => sb.from('menus').select('*').order('sort')),
      all(() => sb.from('menu_outlets').select('*')), all(() => sb.from('menu_bom').select('*')), all(() => sb.from('menu_package_items').select('*'))]);
    db.cats = c.map((r) => ({ id: r.id, name: r.name, color: r.color, station: r.station }));
    const O = group(o, 'menu_id'), B = group(b, 'menu_id'), P = group(p, 'package_id');
    db.menus = m.map((r) => {
      const x = { id: r.id, name: r.name, cat: r.category_id, price: N(r.price), station: r.station, prep: N(r.prep_min), active: r.active, outlets: (O.get(r.id) || []).map((z) => z.location_id),
        desc: r.description || '', tags: r.tags || [], bom: (B.get(r.id) || []).map((z) => ({ i: z.item_id, q: N(z.qty) })), sort: N(r.sort) };
      if (r.sold_out) x.soldOut = true;
      if (r.image_path) x.img = r.image_path;
      if (r.is_package) x.pkg = (P.get(r.id) || []).map((z) => ({ m: z.menu_id, q: N(z.qty) }));
      return x;
    });
  } },
  items: { roles: ALL, fn: async () => {
    const [i, b] = await Promise.all([all(() => sb.from('items').select('*').order('id')), all(() => sb.from('item_bom').select('*'))]);
    const B = group(b, 'item_id');
    db.items = i.map((r) => {
      const x = { id: r.id, name: r.name, unit: r.unit, type: r.type, cost: N(r.std_cost), cat: r.category || '', active: r.active };
      if (r.type === 'semi') { x.yield = N(r.yield_qty) || 1; x.bom = (B.get(r.id) || []).map((z) => ({ i: z.component_id, q: N(z.qty) })); }
      return x;
    });
  } },
  stock: { roles: ALL, fn: async () => {
    const rows = await all(() => sb.from('stock').select('location_id, item_id, qty, avg_cost, min_qty'));
    const st = {};
    for (const r of rows) (st[r.location_id] ||= {})[r.item_id] = { q: N(r.qty), c: N(r.avg_cost), min: N(r.min_qty) };
    db.stock = st;
  } },
  loyalty: { roles: ALL, fn: async () => {
    const [t, ms, p, v, c] = await Promise.all([run(sb.from('tiers').select('*').order('sort')), run(sb.from('missions').select('*')), run(sb.from('promos').select('*')),
      all(() => sb.from('vouchers').select('*')), run(sb.from('campaigns').select('*').order('created_at', { ascending: false }))]);
    db.tiers = t.map((r) => ({ id: r.id, name: r.name, min: N(r.min_spend), disc: N(r.discount), mult: N(r.multiplier) || 1, perks: r.perks || '', sort: N(r.sort) }));
    db.missions = ms.map((r) => ({ id: r.id, name: r.name, desc: r.description || '', kind: r.kind, ...(r.menu_id ? { menu: r.menu_id } : {}), ...(r.category_id ? { cat: r.category_id } : {}),
      target: N(r.target), reward: N(r.reward), active: r.active }));
    db.promos = p.map((r) => ({ id: r.id, name: r.name, type: r.type, ...(r.category_id ? { cat: r.category_id } : {}), ...(r.pct != null ? { pct: N(r.pct) } : {}),
      ...(r.menu_id ? { menu: r.menu_id } : {}), ...(r.buy != null ? { buy: N(r.buy) } : {}), ...(r.free != null ? { free: N(r.free) } : {}),
      ...(r.from_time ? { from: hm(r.from_time) } : {}), ...(r.to_time ? { to: hm(r.to_time) } : {}), days: r.days || [], outlets: r.outlets?.length ? r.outlets : null,
      active: r.active, ...(r.until ? { until: T(r.until) } : {}) }));
    db.vouchers = v.map((r) => ({ code: r.code, name: r.name, type: r.type, value: N(r.value), max: N(r.max_disc), min: N(r.min_spend), quota: N(r.quota), used: N(r.used),
      rev: N(r.revenue), cost: N(r.cost), ...(r.new_only ? { newOnly: true } : {}), ...(r.member_ids?.length ? { members: r.member_ids } : {}),
      ...(r.campaign_id ? { campaign: r.campaign_id } : {}), active: r.active, ...(r.until ? { until: T(r.until) } : {}) }));
    db.campaigns = c.map((r) => ({ id: r.id, name: r.name, seg: r.segment || {}, voucher: r.voucher_code, msg: r.message || '', reach: r.reach || [], sent: N(r.sent), status: r.status, created: T(r.created_at) }));
  } },
  orders: { roles: ALL, fn: () => loadOrders() },
  // Notifikasi staf 6 jam terakhir (suara & kartu notifikasi, lihat notify.js)
  // 2.1: printer/stasiun cetak & antrean cetak (database sebelum 2.1 belum punya tabelnya: aplikasi tetap jalan, cetak di perangkat sendiri)
  printers: { roles: ALL, fn: async () => {
    // 2.2 menambah ip/port/paper/mode, 2.3 conn/bt_addr/usb_id; database lama belum punya kolomnya
    const q = (cols) => run(sb.from('print_stations').select(`id, name, location_id, active, ${cols}print_station_seen(last_seen)`).order('created_at'));
    const rows = await q('ip, port, paper, mode, conn, bt_addr, usb_id, model, ').catch(() => q('ip, port, paper, mode, conn, bt_addr, usb_id, ')).catch(() => q('ip, port, paper, mode, ')).catch(() => q('')).catch(() => []);
    db.printers = rows.map((r) => { const sn = Array.isArray(r.print_station_seen) ? r.print_station_seen[0] : r.print_station_seen;
      return { id: r.id, name: r.name, loc: r.location_id, active: r.active !== false, seen: T(sn?.last_seen), conn: r.conn || (r.ip ? 'lan' : 'pc'), ip: r.ip || null, port: r.port || 9100,
        bt: r.bt_addr || null, usb: r.usb_id || null, paper: r.paper || null, mode: r.mode || 'raster', model: r.model || 'umum' }; });
  } },
  printJobs: { roles: ALL, fn: async () => {
    const rows = await run(sb.from('print_jobs').select('id, station_id, location_id, order_id, kind, label, status, created_at, queued_at, printed_at, error, created_by')
      .gte('created_at', new Date(Date.now() - 12 * 3600000).toISOString()).order('id', { ascending: false }).limit(200)).catch(() => []);
    db.printJobs = rows.map((r) => ({ id: Number(r.id), station: r.station_id, loc: r.location_id, order: r.order_id, kind: r.kind, label: r.label, status: r.status,
      at: T(r.created_at), queuedAt: T(r.queued_at), printedAt: T(r.printed_at), error: r.error || '', by: r.created_by }));
  } },
  alerts: { roles: ALL, fn: async () => {
    // 2.5: hanya mengambil notifikasi yang lebih baru dari yang sudah ada (notifikasi dapur dari kasir menambah jumlahnya)
    const since = Date.now() - 6 * 3600000, cur = (db.alerts || []).filter((a) => a.at >= since);
    const max = cur.reduce((m, a) => Math.max(m, a.id), 0);
    let q = sb.from('staff_alerts').select('*').gte('at', new Date(since).toISOString()).order('id', { ascending: false }).limit(200);
    if (max) q = q.gt('id', max);
    const rows = await run(q);
    const fresh = rows.map((r) => ({ id: Number(r.id), at: T(r.at), kind: r.kind, loc: r.location_id || '', order: r.order_id || null, table: r.table_id || null, ref: r.ref || '', title: r.title, detail: r.detail || '' }));
    db.alerts = [...fresh, ...cur].sort((a, b) => b.id - a.id).slice(0, 400);
  } },
  notices: { roles: ALL, fn: async () => {
    const since = new Date(Date.now() - DAY).toISOString();
    // Database sebelum 1.7 belum punya kolom line_id: pakai bentuk lama supaya aplikasi tetap jalan
    const rows = await run(sb.from('order_notices').select('id, at, order_id, line_id, seen, orders(no, table_id, location_id), order_lines(name, qty)').gte('at', since).order('at', { ascending: false }).limit(300))
      .catch(() => run(sb.from('order_notices').select('id, at, order_id, seen, orders(no, table_id, location_id)').gte('at', since).order('at', { ascending: false }).limit(200)));
    db.notices = rows.map((r) => ({ id: r.id, at: T(r.at), order: r.order_id, line: r.line_id || null, item: r.order_lines ? `${N(r.order_lines.qty)}× ${r.order_lines.name}` : '', no: r.orders?.no || '', table: r.orders?.table_id || null, loc: r.orders?.location_id || '', seen: r.seen }));
  } },
  shifts: { roles: ['owner', 'kasir'], fn: async () => {
    const rows = await run(sb.from('shifts').select('*').or(`close_at.is.null,open_at.gte.${new Date(Date.now() - 45 * DAY).toISOString()}`).order('open_at', { ascending: false }).limit(400));
    db.shifts = rows.map(mapShift);
  } },
  members: { roles: ['owner', 'kasir', 'service'], fn: async () => {
    const full = !membersSince;
    const rows = await all(() => { let q = sb.from('members').select('*'); if (!full) q = q.gte('updated_at', membersSince); return q.order('updated_at'); });
    const keep = full ? new Map() : new Map(db.members.map((m) => [m.id, m]));
    let maxU = 0;
    for (const r of rows) { const m = mapMember(r); m.missions = keep.get(m.id)?.missions || {}; keep.set(m.id, m); if (m.updated > maxU) maxU = m.updated; }
    if (maxU || full) membersSince = new Date((maxU || Date.now()) - 30000).toISOString();
    db.members = [...keep.values()].sort((a, b) => a.joined - b.joined);
    if (can(['owner', 'kasir'])) await LOADERS.memberMissions.fn();
  } },
  memberMissions: { roles: ['owner', 'kasir'], fn: async () => {
    const month = isoDay(Date.now()).slice(0, 7);
    const rows = await all(() => sb.from('member_missions').select('*').eq('month', month));
    const M = new Map(db.members.map((m) => [m.id, m]));
    for (const m of db.members) m.missions = {};
    for (const r of rows) { const m = M.get(r.member_id); if (m) m.missions[r.mission_id] = { p: N(r.progress), done: r.done, month: r.month }; }
  } },
  deposits: { roles: ['owner', 'kasir'], fn: async () => {
    const [c, t] = await Promise.all([all(() => sb.from('deposit_cards').select('*').order('id')),
      all(() => sb.from('deposit_tx').select('*').gte('at', new Date(Date.now() - 45 * DAY).toISOString()).order('at', { ascending: false }))]);
    db.deposits = c.map((r) => ({ id: r.id, holder: r.holder, phone: r.phone || '', mem: r.member_id, balance: N(r.balance), active: r.active, created: T(r.created_at) }));
    db.depositTx = t.map((r) => ({ id: String(r.id), t: T(r.at), card: r.card_id, a: N(r.amount), type: r.type, ...(r.method ? { m: r.method } : {}), ref: r.ref || '', by: r.created_by, shift: r.shift_id }));
  } },
  reservations: { roles: ALL, fn: async () => {
    const rows = await all(() => sb.from('reservations').select('*').gte('date', isoDay(Date.now() - 30 * DAY)).order('date').order('time'));
    db.reservations = rows.map(mapRes);
  } },
  suppliers: { roles: ['owner', 'gudang'], fn: async () => {
    const [s, p, i] = await Promise.all([run(sb.from('suppliers').select('*').order('name')), all(() => sb.from('supplier_prices').select('*')), all(() => sb.from('item_suppliers').select('*'))]);
    db.suppliers = s.map((r) => ({ id: r.id, name: r.name, cat: r.category || '', phone: r.phone || '', bank: r.bank || '', verified: { npwp: r.verified_npwp ? 1 : 0, bank: r.verified_bank ? 1 : 0, visit: r.verified_visit ? 1 : 0 },
      rating: N(r.rating), active: r.active }));
    db.supplierPrices = p.map((r) => ({ sup: r.supplier_id, i: r.item_id, price: N(r.price), upd: T(r.updated_at) }));
    db.itemSup = Object.fromEntries(i.map((r) => [r.item_id, { primary: r.primary_supplier_id, backup: r.backup_supplier_id }]));
  } },
  pos: { roles: ['owner', 'gudang'], fn: async () => {
    const rows = await all(() => sb.from('purchase_orders').select('*, purchase_order_lines(*)').or(`status.in.(draft,diajukan,disetujui,diterima),created_at.gte.${new Date(Date.now() - 120 * DAY).toISOString()}`).order('created_at', { ascending: false }), 500);
    db.pos = rows.map((r) => ({ id: r.id, no: r.no, sup: r.supplier_id, loc: r.location_id, entity: r.entity_id, status: r.status, auto: r.is_auto, flags: r.flags || [], total: N(r.total),
      by: r.created_by, at: T(r.created_at), approvedBy: r.approved_by, approvedAt: T(r.approved_at), receivedBy: r.received_by, receivedAt: T(r.received_at), inv: r.invoice_no || '',
      paidBy: r.paid_by, paidAt: T(r.paid_at), fee: N(r.fee), items: (r.purchase_order_lines || []).map((l) => ({ i: l.item_id, q: N(l.qty), p: N(l.price), rq: N(l.received_qty) })) }));
  } },
  transfers: { roles: ['owner', 'gudang', 'kasir'], fn: async () => {
    const rows = await run(sb.from('transfers').select('*, transfer_lines(*)').or(`status.eq.dikirim,created_at.gte.${new Date(Date.now() - 90 * DAY).toISOString()}`).order('created_at', { ascending: false }).limit(300));
    db.transfers = rows.map((r) => ({ id: r.id, no: r.no, from: r.from_location, to: r.to_location, status: r.status, diff: r.has_diff, by: r.created_by, at: T(r.created_at),
      receivedBy: r.received_by, receivedAt: T(r.received_at), items: (r.transfer_lines || []).map((l) => ({ i: l.item_id, q: N(l.qty), c: N(l.unit_cost), rq: NN(l.received_qty) })) }));
  } },
  opnames: { roles: ['owner', 'gudang'], fn: async () => {
    const rows = (await run(sb.from('opnames').select('*, opname_lines(*)').order('created_at', { ascending: false }).limit(60))).reverse();
    db.opnames = rows.map((r) => ({ id: r.id, no: r.no, at: T(r.created_at), loc: r.location_id, by: r.created_by, total: N(r.total),
      lines: (r.opname_lines || []).map((l) => ({ i: l.item_id, sys: N(l.system_qty), act: N(l.actual_qty), diff: N(l.diff), val: N(l.value) })) }));
  } },
  b2b: { roles: ['owner', 'gudang'], fn: async () => {
    const rows = await run(sb.from('b2b_invoices').select('*, b2b_lines(*)').order('created_at', { ascending: false }).limit(300));
    db.b2b = rows.map((r) => ({ id: r.id, no: r.no, seller: r.seller_id, buyer: r.buyer_id, from: r.from_location, to: r.to_location, total: N(r.total), cost: N(r.cost),
      at: T(r.created_at), by: r.created_by, status: r.status, paidAt: T(r.paid_at), items: (r.b2b_lines || []).map((l) => ({ i: l.item_id, q: N(l.qty), p: N(l.price), c: N(l.unit_cost) })) }));
  } },
  productions: { roles: ['owner', 'gudang', 'dapur'], fn: async () => {
    const rows = await run(sb.from('productions').select('*').order('at', { ascending: false }).limit(300));
    db.productions = rows.map((r) => ({ id: r.id, at: T(r.at), loc: r.location_id, i: r.item_id, q: N(r.qty), cost: N(r.cost), auto: r.is_auto, by: r.created_by, ref: r.ref || '' }));
  } },
  moves: { roles: ['owner', 'gudang', 'dapur'], fn: async () => {
    const rows = await run(sb.from('stock_moves').select('*').order('at', { ascending: false }).limit(1500));
    db.moves = rows.reverse().map((r) => ({ t: T(r.at), loc: r.location_id, i: r.item_id, q: N(r.qty), c: N(r.unit_cost), type: r.type, ref: r.ref || '' }));
  } },
  flags: { roles: ['owner'], fn: async () => {
    const rows = await all(() => sb.from('fraud_flags').select('*').or(`status.eq.open,at.gte.${new Date(Date.now() - 90 * DAY).toISOString()}`).order('at', { ascending: false }));
    db.flags = rows.map(mapFlag);
  } },
  // Laporan keuangan memakai ringkasan jurnal per hari (ringan), rincian jurnal dimuat saat dibuka
  journals: { roles: ['owner'], fn: async () => {
    const rows = await all(() => sb.from('v_journal_daily').select('*').order('day'));
    const J = new Map();
    for (const r of rows) {
      const k = `${r.entity_id}|${r.day}|${r.cash_flow}`;
      if (!J.has(k)) J.set(k, { id: 'd:' + k, d: new Date(r.day + 'T00:00:00').getTime(), e: r.entity_id, memo: '', ref: '', cf: r.cash_flow || '', l: [] });
      J.get(k).l.push([r.account_code, N(r.debit), N(r.credit)]);
    }
    db.journals = [...J.values()].sort((a, b) => a.d - b.d);
    db.journalDetail = null;
  } },
};
// Tabel database → kelompok data yang dimuat ulang
const TABLES = {
  settings: 'settings', entities: 'org', locations: 'org', accounts: 'org', staff: 'staff', areas: 'tables', dining_tables: 'tables',
  menu_categories: 'menus', menus: 'menus', menu_outlets: 'menus', menu_bom: 'menus', menu_package_items: 'menus', items: 'items', item_bom: 'items',
  stock: 'stock', tiers: 'loyalty', missions: 'loyalty', promos: 'loyalty', vouchers: 'loyalty', campaigns: 'loyalty',
  orders: 'orders', order_lines: 'orders', order_payments: 'orders', order_notices: 'notices', shifts: 'shifts', members: 'members', member_missions: 'memberMissions',
  deposit_cards: 'deposits', deposit_tx: 'deposits', reservations: 'reservations', suppliers: 'suppliers', supplier_prices: 'suppliers', item_suppliers: 'suppliers',
  purchase_orders: 'pos', purchase_order_lines: 'pos', transfers: 'transfers', transfer_lines: 'transfers', opnames: 'opnames', opname_lines: 'opnames',
  b2b_invoices: 'b2b', b2b_lines: 'b2b', productions: 'productions', stock_moves: 'moves', fraud_flags: 'flags', journals: 'journals', journal_lines: 'journals',
  staff_alerts: 'alerts', print_stations: 'printers', print_jobs: 'printJobs',
};
const running = {}, again = {};
async function runLoader(k) {
  const L = LOADERS[k];
  if (!L || !can(L.roles)) return;
  if (running[k]) { again[k] = true; return running[k]; }
  running[k] = (async () => {
    try { do { again[k] = false; await L.fn(); } while (again[k]); } finally { running[k] = null; }
  })();
  return running[k];
}
// Muat ulang kelompok data tertentu lalu perbarui tampilan
export async function refresh(...keys) {
  await Promise.all([...new Set(keys.flat())].map(runLoader));
  touch(); emit('remote');
}
// Muat ulang tanpa memicu gambar ulang halaman (untuk status yang diperbarui berkala, mis. printer aktif)
export async function loadQuiet(...keys) { await Promise.all([...new Set(keys.flat())].map(runLoader)); touch(); }
export async function refreshTables(tbls) {
  const keys = new Set();
  for (const t of tbls) if (TABLES[t]) keys.add(TABLES[t]);
  if (keys.has('members')) keys.delete('memberMissions');
  if (!keys.size) return;
  await refresh([...keys]);
}

// Rincian jurnal untuk satu periode (laporan Jurnal)
export async function loadJournalDetail(from, to) {
  const rows = await all(() => sb.from('journals').select('id, entity_id, at, memo, ref, cash_flow, tag, journal_lines(account_code, debit, credit)')
    .gte('at', new Date(from).toISOString()).lte('at', new Date(to).toISOString()).order('at'), 500);
  db.journalDetail = { from, to, list: rows.map((r) => ({ id: r.id, d: T(r.at), e: r.entity_id, memo: r.memo || '', ref: r.ref || '', cf: r.cash_flow || '', ...(r.tag ? { tag: r.tag } : {}),
    l: (r.journal_lines || []).map((l) => [l.account_code, N(l.debit), N(l.credit)]) })) };
  touch(); emit('remote');
  return db.journalDetail;
}
// Kartu stok satu bahan
export async function loadItemMoves(L, itemId) {
  const rows = await run(sb.from('stock_moves').select('*').eq('location_id', L).eq('item_id', itemId).order('at', { ascending: false }).limit(200));
  return rows.reverse().map((r) => ({ t: T(r.at), loc: r.location_id, i: r.item_id, q: N(r.qty), c: N(r.unit_cost), type: r.type, ref: r.ref || '' }));
}
export async function loadPointTx(memberId) {
  const rows = await run(sb.from('point_tx').select('*').eq('member_id', memberId).order('at', { ascending: false }).limit(100));
  return rows.map((r) => ({ at: T(r.at), delta: N(r.delta), reason: r.reason, note: r.note || '', order: r.order_id }));
}

// ---------- Login & mulai ----------
export async function currentSession() {
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data?.session || null;
}
export async function boot() {
  if (!sb) return null;
  const s = await currentSession();
  if (!s) { me = null; return null; }
  try { me = await rpc('whoami'); } catch (e) { if (/habis|JWT/i.test(e.message)) { await sb.auth.signOut().catch(() => {}); me = null; return null; } throw e; }
  if (!me) { await sb.auth.signOut().catch(() => {}); return null; }
  await loadAll();
  return me;
}
export async function signIn(email, password) {
  if (!sb) throw new Error('Kaly Ops belum disambungkan ke database. Isi file config.js dulu.');
  const { error } = await sb.auth.signInWithPassword({ email: String(email).trim().toLowerCase(), password });
  if (error) {
    if (/invalid login|invalid credentials/i.test(error.message)) throw new Error('Email atau kata sandi salah');
    if (/not confirmed/i.test(error.message)) throw new Error('Email ini belum dikonfirmasi. Owner perlu mencentang Auto Confirm User saat membuat akun di Supabase.');
    throw new Error(errMsg(error));
  }
  me = await rpc('whoami');
  if (!me) { await sb.auth.signOut().catch(() => {}); throw new Error('Login berhasil, tapi email ini belum terdaftar sebagai staf aktif. Minta Owner menambahkannya di Pengaturan, bagian Staf.'); }
  await loadAll();
  return me;
}
export async function signOut() {
  stopSync();
  try { await sb?.auth.signOut(); } catch {}
  me = null; ready = false;
  Object.assign(db, emptyDb());
  orderMap.clear(); ordersSince = null; membersSince = null; orderDays = 2;
  emit('session');
}
export async function changePassword(pass) {
  const { error } = await sb.auth.updateUser({ password: pass });
  if (error) throw new Error(/should be different/i.test(error.message) ? 'Kata sandi baru harus berbeda dari yang lama' : /at least/i.test(error.message) ? 'Kata sandi minimal 6 karakter' : errMsg(error));
}

async function loadAll() {
  setStatus('loading');
  orderDays = 2; ordersSince = null; membersSince = null;
  const first = ['settings', 'org', 'staff', 'tables', 'menus', 'items', 'stock', 'loyalty', 'orders', 'notices', 'alerts', 'shifts', 'members', 'deposits', 'reservations', 'printers', 'printJobs'];
  await Promise.all(first.map(runLoader));
  ready = true; touch(); setStatus('ok'); emit('remote');
  startSync();
  // Data back office & riwayat dimuat di belakang layar
  setTimeout(async () => {
    try {
      await Promise.all(['suppliers', 'pos', 'transfers', 'opnames', 'b2b', 'productions', 'moves', 'flags', 'journals'].map(runLoader));
      touch(); emit('remote');
      const days = WINDOW[me?.role] || 2;
      if (days > orderDays) { await loadOrders({ full: true, days }); touch(); emit('remote'); }
    } catch (e) { console.warn('muat latar', e); }
  }, 300);
  // Ingat untuk sinkron berikutnya: waktu terakhir dari server
  if (me) localStorage.setItem('kaly.lastStaff', JSON.stringify({ id: me.id, name: me.name, role: me.role }));
}

// ---------- Sinkron antar perangkat ----------
let pollT = null, pollSince = null, channel = null, rtJoined = false, syncing = false, lastOk = 0;
const seen = new Map();
const pending = new Set();
let flushT = null;
function queue(tbl) { pending.add(tbl); clearTimeout(flushT); flushT = setTimeout(flush, 200); }
// Modul lain bisa ikut mendengar tabel yang berubah (mis. stasiun cetak menunggu print_jobs)
const tableHooks = new Set();
export function onTables(fn) { tableHooks.add(fn); return () => tableHooks.delete(fn); }
async function flush() {
  if (!pending.size) return;
  const t = [...pending]; pending.clear();
  tableHooks.forEach((f) => { try { f(t); } catch (e) { console.warn(e); } });
  try { await refreshTables(t); } catch (e) { console.warn('sinkron', e); }
}
async function poll() {
  clearTimeout(pollT);
  if (!me) return;
  if (!syncing) {
    syncing = true;
    try {
      const r = await rpc('sync_poll', { p_since: pollSince });
      const now = Date.parse(r.now);
      const firstPoll = !pollSince;
      pollSince = new Date(now - 30000).toISOString();
      for (const [id, tbl] of r.changes || []) if (!seen.has(id)) { seen.set(id, now); if (!firstPoll) pending.add(tbl); }
      for (const [id, t] of seen) if (now - t > 120000) seen.delete(id);
      if (pending.size) await flush();
      lastOk = Date.now(); setStatus('ok');
    } catch (e) {
      setStatus(/Sesi login habis/.test(e.message) ? 'expired' : 'offline');
      if (/Sesi login habis|belum terdaftar/.test(e.message)) { syncing = false; return; }
    } finally { syncing = false; }
  }
  const wait = document.hidden ? 15000 : rtJoined ? 12000 : 3000;
  pollT = setTimeout(poll, wait);
}
function subscribeRealtime() {
  try {
    channel = sb.channel('kaly-sync')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sync_log' }, (p) => {
        const { id, tbl } = p.new || {};
        if (id == null || seen.has(id)) return;
        seen.set(id, Date.now()); queue(tbl);
      })
      .subscribe((st) => { rtJoined = st === 'SUBSCRIBED'; });
  } catch (e) { rtJoined = false; }
}
export function startSync() {
  stopSync();
  poll();
  subscribeRealtime();
}
export function stopSync() {
  clearTimeout(pollT); pollT = null; pollSince = null; seen.clear();
  if (channel) { try { sb.removeChannel(channel); } catch {} channel = null; }
  rtJoined = false;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && me) poll(); });
window.addEventListener('online', () => { if (me) poll(); });

// ---------- Data untuk layar & halaman tanpa login ----------
// Bentuknya dibuat mirip `db` supaya tampilan Lounge, layar pelanggan, dan halaman pesan bisa memakai logika yang sama.
export const pub = { db: null, at: 0, loc: null };
export async function loadPublic(loc = 'L1', { lounge = false } = {}) {
  const [m, l] = await Promise.all([rpc('public_menu', { p_loc: loc }), lounge ? rpc('public_lounge', { p_loc: loc }) : Promise.resolve(null)]);
  const d = pub.db || emptyDb();
  const b = m.brand || {};
  Object.assign(d.settings, { brand: { name: b.name, tagline: b.tagline, color: b.color, accent: b.accent }, taxRate: N(b.tax_rate), serviceRate: N(b.service_rate),
    delivBase: N(b.deliv_base), delivPerKm: N(b.deliv_per_km), maxKm: N(b.max_km), openHour: N(b.open_hour), closeHour: N(b.close_hour), sameDayCutoff: hm(b.same_day_cutoff),
    scheduleLead: N(b.schedule_lead), welcomePoints: N(b.welcome_points), pointsPer: N(b.points_per) || 10000 });
  d.cats = (m.categories || []).map((c) => ({ id: c.id, name: c.name, color: c.color }));
  d.menus = (m.menus || []).map((x) => ({ id: x.id, name: x.name, cat: x.category_id, price: N(x.price), desc: x.description || '', tags: x.tags || [], ...(x.image_path ? { img: x.image_path } : {}),
    ...(x.is_package ? { pkg: [] } : {}), active: true, outlets: [loc], available: x.available, left: x.portions_left == null ? null : N(x.portions_left), station: 'dapur', bom: [] }));
  d.promos = (m.promos || []).map((p) => ({ id: p.id, name: p.name, type: p.type, cat: p.category_id, menu: p.menu_id, active: true, days: [], outlets: null }));
  if (l) {
    d.locations = [{ id: loc, name: l.location || '', type: 'outlet' }];
    d.orders = (l.orders || []).map((o) => ({ id: o.id, no: o.no, loc, type: o.type, table: o.table, cust: { name: o.name || '' }, status: 'open', released: true, ks: o.state,
      created: T(o.created_at), readyAt: T(o.ready_at), lines: [] }));
    d.top = l.top || [];
  }
  d.rev = (d.rev || 0) + 1;
  pub.db = d; pub.at = Date.now(); pub.loc = loc;
  return d;
}
