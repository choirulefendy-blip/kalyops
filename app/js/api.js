// Semua perubahan data Kaly Ops dikirim ke database Supabase lewat modul ini.
// Setiap fungsi melempar Error dengan pesan berbahasa Indonesia bila gagal.
import * as C from './cloud.js';

const sb = () => C.sb;
const { rpc, run } = C;

// ---------- Antrean per pesanan ----------
// Perubahan pada satu bill dijalankan berurutan (buat bill → tambah item → kirim → bayar), dan bill itu tidak ditimpa sinkron
// sampai antreannya selesai. Setelah selesai, bill dimuat ulang dari server.
const chains = new Map();
export function orderOp(id, fn) {
  C.markBusy(id, 1);
  const prev = chains.get(id) || Promise.resolve();
  const p = prev.then(async () => { try { return await fn(); } finally { C.markBusy(id, -1); } });
  const tail = p.catch(() => {}).then(() => { if (!C.isBusy(id)) { if (chains.get(id) === tail) chains.delete(id); return C.refreshOrder(id).catch(() => {}); } });
  chains.set(id, tail);
  return p;
}
export const orderSettled = (id) => chains.get(id) || Promise.resolve();

// ---------- Pesanan & kasir ----------
export async function createOrder(o) {
  await run(sb().from('orders').insert({ id: o.id, location_id: o.loc, type: o.type, table_id: o.table || null, merged_tables: o.merged || [], terminal: o.term || '',
    customer_name: o.cust?.name || '', customer_phone: o.cust?.phone || '', member_id: o.mem || null, reservation_id: o.res || null }));
  if (o.res) await run(sb().from('reservations').update({ status: 'datang', order_id: o.id }).eq('id', o.res));
}
export const insertLine = (orderId, ln) => run(sb().from('order_lines').insert({ id: ln.id, order_id: orderId, menu_id: ln.m, qty: ln.q, note: ln.note || '' }));
export const setLineQty = (lineId, q) => (q > 0 ? run(sb().from('order_lines').update({ qty: q }).eq('id', lineId)) : run(sb().from('order_lines').delete().eq('id', lineId)));
export const setLineNote = (lineId, note) => run(sb().from('order_lines').update({ note }).eq('id', lineId));
const ORDER_COLS = { type: 'type', table: 'table_id', merged: 'merged_tables', custName: 'customer_name', custPhone: 'customer_phone', dlv: 'delivery_status' };
export function updateOrder(id, patch) {
  const row = {};
  for (const [k, v] of Object.entries(patch)) if (ORDER_COLS[k]) row[ORDER_COLS[k]] = v;
  return run(sb().from('orders').update(row).eq('id', id));
}
export const setMember = (orderId, memberId) => rpc('order_set_member', { p_order: orderId, p_member: memberId || null });
export const setVoucher = (orderId, code) => rpc('order_set_discount', { p_order: orderId, p_voucher: code || '' });
export const setPoints = (orderId, pts) => rpc('order_set_discount', { p_order: orderId, p_points: Math.max(0, Math.floor(pts || 0)) });
export const removeDiscount = (orderId, kind) => rpc('remove_discount', { p_order: orderId, p_kind: kind });
export const manualDiscount = (orderId, type, value, reason, pin) => rpc('apply_manual_discount', { p_order: orderId, p_type: type, p_value: value, p_reason: reason, p_pin: pin || null });
export const sendToKitchen = (orderId) => rpc('pos_send', { p_order: orderId });
export const voidLine = (lineId, reason) => rpc('void_line', { p_line: lineId, p_reason: reason });
export const voidOrder = (orderId, reason, pin) => rpc('void_order', { p_order: orderId, p_reason: reason, p_pin: pin || null });
export const mergeOrders = (target, source) => rpc('merge_orders', { p_target: target, p_source: source });
export const splitOrder = (orderId, sel) => rpc('split_order', { p_order: orderId, p_sel: sel });
export const pay = (orderId, pays, shiftId, tendered) => rpc('pay_order', { p_order: orderId, p_pays: pays, p_shift: shiftId, p_tendered: tendered || 0 });
export const printCount = (orderId) => rpc('order_print', { p_order: orderId });
export const printSlips = (orderId, reprint = false) => rpc('print_slips', { p_order: orderId, p_reprint: reprint });
export const releaseOrder = (orderId) => rpc('order_release', { p_order: orderId });
export const releaseDue = () => rpc('release_due_orders');
export const tableClear = (table, loc) => rpc('table_clear', { p_table: table || null, p_loc: loc || 'L1' });
export const moveGuests = (from, to, loc, unmerge = false) => rpc('table_move', { p_from: from, p_to: to, p_loc: loc || 'L1', p_unmerge: !!unmerge });
export const verifyPin = (pin) => rpc('verify_manager_pin', { p_pin: pin });

// ---------- Dapur & pramusaji ----------
export const tapLine = (lineId) => rpc('kitchen_tap_line', { p_line: lineId });
export const kitchenLine = (lineId, to) => rpc('kitchen_line', { p_line: lineId, p_to: to });
export const bump = (orderId, station) => rpc('kitchen_bump', { p_order: orderId, p_station: station || null });
export const recall = (orderId) => rpc('kitchen_recall', { p_order: orderId });
// 2.12 · Produksi gabungan: banyak item dari beberapa nota sekaligus (database lama: satu per satu)
export const kitchenBatch = (lineIds, to) => rpc('kitchen_batch', { p_lines: lineIds, p_to: to })
  .catch(async (e) => { if (!/kitchen_batch|function|schema cache/i.test(e.message)) throw e; let n = 0; for (const id of lineIds) { try { await kitchenLine(id, to); n++; } catch {} } return n; });
export const markServed = (orderId) => rpc('mark_served', { p_order: orderId });
export const serveReady = (orderId) => rpc('serve_ready', { p_order: orderId });
export const serveLine = (lineId) => rpc('serve_line', { p_line: lineId });

// ---------- Shift & deposit ----------
export const shiftOpen = (terminal, loc, cash, crew) => (crew ? rpc('shift_open', { p_terminal: terminal, p_location: loc, p_cash: cash, p_crew: crew }) : rpc('shift_open', { p_terminal: terminal, p_location: loc, p_cash: cash }));
// 2.9 · Anggota shift & laporan per shift
export const shiftCrew = (shiftId, crew) => rpc('shift_crew', { p_shift: shiftId, p_crew: crew });
export const shiftReports = (loc, days = 7) => rpc('shift_reports', { p_location: loc, p_days: days });
export const crewSave = (row) => run(sb().from('crew').upsert(row, { onConflict: 'id' }));
export const shiftClose = (shiftId, counted) => rpc('shift_close', { p_shift: shiftId, p_counted: counted });
export const noSale = (shiftId, reason) => rpc('pos_no_sale', { p_shift: shiftId, p_reason: reason });
export const depositNew = (holder, phone, topup, method, shiftId) => rpc('deposit_card_new', { p_holder: holder, p_phone: phone || '', p_topup: topup || 0, p_method: method || 'cash', p_shift: shiftId || null });
export const depositTopup = (card, amount, method, shiftId) => rpc('deposit_topup', { p_card: card, p_amount: amount, p_method: method, p_shift: shiftId });
export const depositRefund = (card, shiftId) => rpc('deposit_refund', { p_card: card, p_shift: shiftId });

// ---------- Member ----------
// Daftarkan member baru (atau pakai yang sudah ada dengan nomor sama). Hasil: { m, created }
export async function upsertMember({ name, phone, bday = '', email = '', src = 'kasir' }) {
  const p = String(phone || '').replace(/\D/g, '').replace(/^62/, '0');
  if (p.length < 9) throw new Error('Isi nomor HP yang valid');
  const ex = await run(sb().from('members').select('*').eq('phone', p).maybeSingle());
  if (ex) return { m: ex, created: false };
  const row = await run(sb().from('members').insert({ name: name || 'Pelanggan', phone: p, birthday: bday || '', email: email || '', source: src }).select().single());
  return { m: row, created: true };
}
export const adjustPoints = (memberId, delta, reason) => rpc('member_adjust_points', { p_member: memberId, p_delta: delta, p_reason: reason });
export const birthdayVouchers = () => rpc('birthday_vouchers');
export const updateMemberRow = (id, row) => run(sb().from('members').update(row).eq('id', id));

// ---------- Reservasi ----------
export const reservationCreate = (p) => rpc('reservation_create', { p });
export const reservationStatus = (id, status) => run(sb().from('reservations').update({ status }).eq('id', id));

// ---------- Meja ----------
export const tableSave = (row) => run(sb().from('dining_tables').upsert(row, { onConflict: 'id' }));
export const tableMove = (id, x, y) => run(sb().from('dining_tables').update({ x, y }).eq('id', id));
export const tableDelete = (id) => run(sb().from('dining_tables').update({ active: false }).eq('id', id));
export const areaEnsure = (name, sort) => run(sb().from('areas').upsert({ name, sort }, { onConflict: 'name', ignoreDuplicates: true }));

// ---------- Menu, kategori, bahan, stok ----------
export const menuSave = (p) => rpc('menu_save', { p });
export const catalogSave = (p) => rpc('catalog_save', { p });
export const itemSave = (p) => rpc('item_save', { p });
export const stockSetMin = (loc, item, min) => rpc('stock_set_min', { p_loc: loc, p_item: item, p_min: min });
export const produce = (loc, item, batches) => rpc('produce_manual', { p_loc: loc, p_item: item, p_batches: batches });
export const transferSend = (from, to, lines) => rpc('transfer_send', { p_from: from, p_to: to, p_lines: lines });
export const transferReceive = (id, received) => rpc('transfer_receive', { p_id: id, p_received: received || {} });
export const opnamePost = (loc, counts) => rpc('opname_post', { p_loc: loc, p_counts: counts });
export const b2bCreate = (from, to, lines) => rpc('b2b_create', { p_from: from, p_to: to, p_lines: lines });
export const b2bPay = (id) => rpc('b2b_pay', { p_id: id });
export const expensePost = (entity, account, amount, source, memo, date) => rpc('expense_post', { p_entity: entity, p_account: account, p_amount: amount, p_source: source, p_memo: memo || null, p_date: date || null });

// Foto menu → Supabase Storage (bucket menu-images)
export async function uploadMenuImage(menuId, blob) {
  const ext = blob.type === 'image/webp' ? 'webp' : blob.type === 'image/png' ? 'png' : 'jpg';
  const path = `${menuId}/${Date.now()}.${ext}`;
  const { error } = await sb().storage.from('menu-images').upload(path, await blob.arrayBuffer(), { contentType: blob.type || 'image/jpeg', upsert: true, cacheControl: '31536000' });
  if (error) throw new Error(/row-level security|Unauthorized|not allowed/i.test(error.message) ? 'Hanya Owner yang bisa mengunggah foto menu' : C.errMsg(error));
  return path;
}
export async function removeStorageImage(path) {
  if (!path) return;
  await sb().storage.from('menu-images').remove([path]).catch(() => {});
}

// ---------- Kaly Goods ----------
export const poCreate = (sup, loc, lines, submit = true) => rpc('po_create', { p_supplier: sup, p_location: loc, p_lines: lines, p_submit: submit });
export const poSubmit = (id) => rpc('po_submit', { p_id: id });
export const poApprove = (id, ok = true) => rpc('po_approve', { p_id: id, p_approve: ok });
export const poReceive = (id, received, invoice) => rpc('po_receive', { p_id: id, p_received: received || {}, p_invoice: invoice });
export const poPay = (id) => rpc('po_pay', { p_id: id });
export const poAuto = (loc) => rpc('po_auto', { p_location: loc });
export const poDelete = (id) => run(sb().from('purchase_orders').delete().eq('id', id).eq('status', 'draft'));
export const supplierSave = (row) => run(sb().from('suppliers').upsert(row, { onConflict: 'id' }));
export const itemSupplierSave = (item, primary, backup) => run(sb().from('item_suppliers').upsert({ item_id: item, primary_supplier_id: primary || null, backup_supplier_id: backup || null }, { onConflict: 'item_id' }));
export const supplierPriceSave = (sup, item, price) => run(sb().from('supplier_prices').upsert({ supplier_id: sup, item_id: item, price, updated_at: new Date().toISOString() }, { onConflict: 'supplier_id,item_id' }));

// ---------- Kaly Loop & pengaturan ----------
export const tableUpdate = (table, match, row) => { let q = sb().from(table).update(row); for (const [k, v] of Object.entries(match)) q = q.eq(k, v); return run(q); };
export const tableInsert = (table, row) => run(sb().from(table).insert(row));
export const tableUpsert = (table, row, onConflict) => run(sb().from(table).upsert(row, onConflict ? { onConflict } : {}));
export const tableDeleteWhere = (table, match) => { let q = sb().from(table).delete(); for (const [k, v] of Object.entries(match)) q = q.eq(k, v); return run(q); };
export const saveSettings = (patch) => run(sb().from('settings').update(C.settingsRow(patch)).eq('id', 1));
export const setManagerPin = (pin) => rpc('set_manager_pin', { p_new: pin });
export const flagChecked = (id, staffId) => run(sb().from('fraud_flags').update({ status: 'ok', checked_by: staffId, checked_at: new Date().toISOString() }).eq('id', id));

// ---------- Staf ----------
export const staffSave = (row) => run(sb().from('staff').upsert(row, { onConflict: 'id' }));

// ---------- Laporan operasional 1.4 (dihitung di database, periode bebas) ----------
const isoT = (t) => new Date(t).toISOString();
export const reportReceipts = (from, to, locs, limit = 3000) => C.rpc('report_receipts', { p_from: isoT(from), p_to: isoT(to), p_locs: locs || null, p_limit: limit });
export const reportCategories = (from, to, locs) => C.rpc('report_categories', { p_from: isoT(from), p_to: isoT(to), p_locs: locs || null });
export const reportTables = (from, to, loc, log = 400) => C.rpc('report_tables', { p_from: isoT(from), p_to: isoT(to), p_loc: loc || 'L1', p_log: log });

// ---------- 2.1 · Printer & stasiun cetak ----------
export const printStationSave = (id, name, loc, active = true, lan = {}) => rpc('print_station_save', { p_id: id || null, p_name: name, p_loc: loc, p_active: active,
  p_ip: lan.ip || null, p_port: Number(lan.port) || 9100, p_paper: lan.paper ? Number(lan.paper) : null, p_mode: lan.mode || 'raster',
  p_conn: lan.conn || (lan.ip ? 'lan' : 'pc'), p_bt: lan.bt || null, p_usb: lan.usb || null });
export const printRouteSave = (loc, route) => tableUpdate('locations', { id: loc }, { print_route: route });
export const printEnqueue = (jobs) => rpc('print_enqueue', { p_jobs: jobs });
export const printClaim = (station) => rpc('print_claim', { p_station: station });
export const printDone = (ids, ok = true, error = '') => rpc('print_done', { p_ids: ids, p_ok: ok, p_error: error });
export const printRetry = (id) => rpc('print_retry', { p_id: id });
export const printCancel = (ids) => rpc('print_cancel', { p_ids: ids });

// ---------- 2.4 · Notifikasi di perangkat (Web Push) ----------
export const pushInfo = () => rpc('push_info', {});
export const pushSetup = (url) => rpc('push_setup', { p_url: url || null });
export const pushSubscribe = (endpoint, p256dh, auth, kinds, label) => rpc('push_subscribe', { p_endpoint: endpoint, p_p256dh: p256dh, p_auth: auth, p_kinds: kinds, p_label: label || '' });
export const pushKinds = (endpoint, kinds) => rpc('push_kinds', { p_endpoint: endpoint, p_kinds: kinds });
export const pushUnsubscribe = (endpoint) => rpc('push_unsubscribe', { p_endpoint: endpoint });
export const pushTest = () => rpc('push_test', {});
export const printStationModel = (id, model) => rpc('print_station_model', { p_id: id, p_model: model || 'umum' });
