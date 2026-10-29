// 2.12 · Audit log (Kaly Backoffice, khusus Owner/Manajer): semua aktivitas akun — masuk/keluar dan setiap
// tambah/ubah/hapus data. Dibaca langsung dari tabel audit_log (RLS: hanya Owner).
import * as C from '../cloud.js';
import { esc, ic, toast, fmtTime, fmtDate, dayKey, downloadBlob, startOfDay, DAY } from '../lib.js';
import * as D from '../domain.js';
import { writeXlsx } from '../xlsx.js';
import { rerender } from '../app.js';

const ENT = {
  orders: 'Bill', order_lines: 'Item bill', order_payments: 'Pembayaran', shifts: 'Shift', deposit_cards: 'Kartu deposit', deposit_tx: 'Transaksi deposit',
  reservations: 'Reservasi', members: 'Member', menus: 'Menu', menu_categories: 'Kategori menu', menu_outlets: 'Menu per outlet', menu_bom: 'Resep menu',
  menu_package_items: 'Isi paket', items: 'Bahan', item_bom: 'Resep bahan', promos: 'Promo', vouchers: 'Voucher', campaigns: 'Campaign', tiers: 'Tier member',
  missions: 'Misi', settings: 'Pengaturan', staff: 'Staf', crew: 'Anggota shift', print_stations: 'Printer', dining_tables: 'Meja', areas: 'Area', locations: 'Outlet',
  purchase_orders: 'PO', purchase_order_lines: 'Item PO', transfers: 'Mutasi', transfer_lines: 'Item mutasi', opnames: 'Opname', opname_lines: 'Item opname',
  productions: 'Produksi', b2b_invoices: 'Faktur B2B', suppliers: 'Supplier', supplier_prices: 'Harga supplier', fraud_flags: 'Temuan fraud',
};
const ACT = { login: ['Masuk', 'b-ok'], logout: ['Keluar', 'b-mute'], insert: ['Tambah', 'b-info'], update: ['Ubah', 'b-warn'], delete: ['Hapus', 'b-err'], print: ['Cetak', 'b-mute'], export: ['Unduh', 'b-mute'], open: ['Buka', 'b-mute'], view: ['Lihat', 'b-mute'] };
const GROUPS = [
  ['', 'Semua bagian'], ['session', 'Masuk / keluar'], ['kasir', 'Kasir & bill', ['orders', 'order_lines', 'order_payments', 'shifts', 'deposit_cards', 'deposit_tx']],
  ['dapur', 'Status item dapur', ['order_lines']], ['res', 'Reservasi & member', ['reservations', 'members']],
  ['menu', 'Menu, resep & promo', ['menus', 'menu_categories', 'menu_outlets', 'menu_bom', 'menu_package_items', 'promos', 'vouchers', 'campaigns', 'tiers', 'missions']],
  ['stok', 'Stok, PO & produksi', ['items', 'item_bom', 'purchase_orders', 'purchase_order_lines', 'transfers', 'transfer_lines', 'opnames', 'opname_lines', 'productions', 'b2b_invoices', 'suppliers', 'supplier_prices']],
  ['akses', 'Staf, pengaturan & printer', ['staff', 'crew', 'settings', 'print_stations', 'dining_tables', 'areas', 'locations', 'fraud_flags']],
];
const ui = { range: 'today', from: '', to: '', staff: '', act: '', grp: '', q: '', rows: [], more: false, loading: false, open: null, key: '', err: '' };
const PAGE = 100;

function filtersKey() { return JSON.stringify([ui.range, ui.from, ui.to, ui.staff, ui.act, ui.grp, ui.q]); }
function bounds() {
  if (ui.range === 'custom' && ui.from) return [new Date(ui.from + 'T00:00:00').getTime(), ui.to ? new Date(ui.to + 'T00:00:00').getTime() + DAY : Date.now() + DAY];
  const d = { today: 0, '7d': 6, '30d': 29, '90d': 89 }[ui.range] ?? 0;
  return [startOfDay() - d * DAY, Date.now() + DAY];
}
function query(before) {
  const [a, b] = bounds();
  let q = C.sb.from('audit_log').select('*').gte('at', new Date(a).toISOString()).lt('at', new Date(b).toISOString()).order('id', { ascending: false }).limit(PAGE);
  if (before) q = q.lt('id', before);
  if (ui.staff) q = q.eq('staff_id', ui.staff);
  if (ui.act) q = ui.act === 'session' ? q.in('action', ['login', 'logout']) : q.eq('action', ui.act);
  const g = GROUPS.find((x) => x[0] === ui.grp);
  if (g?.[0] === 'session') q = q.in('action', ['login', 'logout']);
  else if (g?.[2]) q = q.in('entity', g[2]);
  if (ui.grp === 'dapur') q = q.eq('action', 'update').ilike('summary', '%status%');
  const s = ui.q.trim().replace(/[%,()]/g, ' ');
  if (s) q = q.or(`summary.ilike.%${s}%,entity_id.ilike.%${s}%,crew_name.ilike.%${s}%,staff_name.ilike.%${s}%,device.ilike.%${s}%`);
  return q;
}
async function load(more = false) {
  if (!C.sb) return;
  ui.loading = true; ui.err = '';
  const key = filtersKey(); ui.key = key;
  try {
    const { data, error } = await query(more && ui.rows.length ? ui.rows[ui.rows.length - 1].id : null);
    if (error) throw error;
    if (ui.key !== key) return;
    ui.rows = more ? ui.rows.concat(data) : data;
    ui.more = data.length === PAGE;
  } catch (e) {
    ui.err = /audit_log|relation|schema cache/i.test(e.message || '') ? 'Audit log belum aktif: jalankan update database 2.12 di Supabase.' : C.errMsg(e);
    if (!more) ui.rows = [];
  } finally { ui.loading = false; rerender(); }
}

const fmtVal = (v) => (v == null ? '—' : typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : String(v).slice(0, 120));
function detail(r) {
  const d = r.data || {};
  if (r.action === 'update') return `<div class="au-diff"><div class="au-dh"><span>Kolom</span><span>Sebelum</span><span>Sesudah</span></div>${Object.entries(d).map(([k, v]) => `<div class="au-dr"><b>${esc(k)}</b><span class="au-old">${esc(fmtVal(Array.isArray(v) ? v[0] : v))}</span><span class="au-new">${esc(fmtVal(Array.isArray(v) ? v[1] : v))}</span></div>`).join('')}</div>`;
  const ks = Object.keys(d);
  if (!ks.length) return `<p class="muted sm">${esc(r.summary || '')}</p>`;
  return `<dl class="kv sm au-kv">${ks.slice(0, 30).map((k) => `<dt>${esc(k)}</dt><dd>${esc(fmtVal(d[k]))}</dd>`).join('')}</dl>`;
}
function rowHtml(r, db) {
  const [al, ac] = ACT[r.action] || [r.action, 'b-mute'];
  const what = r.action === 'login' || r.action === 'logout' || !r.entity ? esc(r.summary || '') : `<b>${esc(ENT[r.entity] || r.entity)}</b> ${esc(r.summary || r.entity_id || '')}`;
  const open = ui.open === r.id;
  return `<tr class="au-r ${open ? 'open' : ''}" data-a="auOpen" data-id="${r.id}"><td class="nowrap">${fmtTime(Date.parse(r.at))}<br><small class="muted">${fmtDate(Date.parse(r.at))}</small></td>
    <td><b>${esc(r.crew_name || r.staff_name)}</b>${r.crew_name ? `<br><small class="muted">akun ${esc(r.staff_name)}</small>` : ''}</td>
    <td><span class="badge b-mute">${esc(D.ROLES[r.role]?.short || r.role)}</span></td>
    <td><span class="badge ${ac}">${al}</span></td><td>${what}</td>
    <td class="muted sm">${esc(r.device || '')}${r.location_id ? `<br>${esc(D.loc(db, r.location_id)?.name || r.location_id)}` : ''}</td></tr>
    ${open ? `<tr class="au-d"><td colspan="6">${detail(r)}</td></tr>` : ''}`;
}

export default {
  title: () => 'Audit log',
  render(ctx) {
    const db = ctx.db;
    if (ui.key !== filtersKey() && !ui.loading) setTimeout(() => load(false));
    const staff = db.users.slice().sort((a, b) => a.name.localeCompare(b.name));
    const today = ui.rows.filter((r) => Date.parse(r.at) >= startOfDay());
    return `<div class="au">
      <div class="banner info sm">${ic('shield-alert', 17)}<span>Semua aktivitas akun tercatat otomatis: masuk/keluar dan setiap tambah, ubah, atau hapus data (bill, item, pembayaran, shift, reservasi, menu, stok, staf, pengaturan). Nama petugas shift & perangkat ikut dicatat. Catatan tidak bisa diubah atau dihapus, disimpan 1 tahun.</span></div>
      <div class="card au-f">
        <div class="chips">${[['today', 'Hari ini'], ['7d', '7 hari'], ['30d', '30 hari'], ['90d', '90 hari'], ['custom', 'Tanggal']].map(([k, l]) => `<button class="chip ${ui.range === k ? 'on' : ''}" data-a="auRange" data-v="${k}">${l}</button>`).join('')}
          ${ui.range === 'custom' ? `<input type="date" class="inp inp-sm" data-a-change="auFrom" value="${esc(ui.from || dayKey())}" aria-label="Dari tanggal"><span class="muted sm">s/d</span><input type="date" class="inp inp-sm" data-a-change="auTo" value="${esc(ui.to || dayKey())}" aria-label="Sampai tanggal">` : ''}</div>
        <div class="au-fr">
          <label class="fld"><span>Akun</span><select data-a-change="auStaff"><option value="">Semua akun</option>${staff.map((u) => `<option value="${u.id}" ${ui.staff === u.id ? 'selected' : ''}>${esc(u.name)} · ${esc(D.ROLES[u.role]?.short || u.role)}</option>`).join('')}</select></label>
          <label class="fld"><span>Aksi</span><select data-a-change="auAct"><option value="">Semua aksi</option>${[['session', 'Masuk / keluar'], ['insert', 'Tambah'], ['update', 'Ubah'], ['delete', 'Hapus']].map(([k, l]) => `<option value="${k}" ${ui.act === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="fld"><span>Bagian</span><select data-a-change="auGrp">${GROUPS.map(([k, l]) => `<option value="${k}" ${ui.grp === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="fld au-q"><span>Cari</span><input class="inp" id="au-q" data-in="auQ" value="${esc(ui.q)}" placeholder="No. bill, nama petugas, perangkat…"></label>
          <button class="btn au-x" data-a="auXlsx" ${ui.rows.length ? '' : 'disabled'}>${ic('download', 15)} Unduh Excel</button>
        </div></div>
      ${ui.err ? `<p class="banner warn sm">${esc(ui.err)}</p>` : ''}
      <div class="card"><div class="card-h"><h3>Aktivitas <span class="muted">${ui.rows.length}${ui.more ? '+' : ''}</span></h3><span class="muted sm">${ui.loading ? 'Memuat…' : today.length ? `${today.length} hari ini` : ''}</span></div>
        <div class="tbl-wrap"><table class="tbl hover au-t"><thead><tr><th>Waktu</th><th>Petugas</th><th>Peran</th><th>Aksi</th><th>Data</th><th>Perangkat</th></tr></thead>
        <tbody>${ui.rows.map((r) => rowHtml(r, db)).join('') || `<tr><td colspan="6" class="empty">${ui.loading ? 'Memuat…' : 'Belum ada aktivitas untuk filter ini.'}</td></tr>`}</tbody></table></div>
        ${ui.more ? `<div class="row" style="justify-content:center;margin-top:10px"><button class="btn" data-a="auMore" ${ui.loading ? 'disabled' : ''}>Muat lebih banyak</button></div>` : ''}</div></div>`;
  },
  input(k, el) {
    if (k !== 'auQ') return;
    ui.q = el.value;
    clearTimeout(ui.qt); ui.qt = setTimeout(() => load(false), 350);
  },
  actions: {
    auRange(el) { ui.range = el.dataset.v; if (ui.range === 'custom' && !ui.from) { ui.from = dayKey(); ui.to = dayKey(); } load(false); },
    auFrom(el) { ui.from = el.value; load(false); },
    auTo(el) { ui.to = el.value; load(false); },
    auStaff(el) { ui.staff = el.value; load(false); },
    auAct(el) { ui.act = el.value; load(false); },
    auGrp(el) { ui.grp = el.value; load(false); },
    auMore() { load(true); },
    auOpen(el) { const id = Number(el.dataset.id); ui.open = ui.open === id ? null : id; rerender(); },
    async auXlsx(el) {
      el.disabled = true;
      try {
        let all = ui.rows.slice(), more = ui.more;
        while (more && all.length < 5000) { const { data, error } = await query(all[all.length - 1].id); if (error) throw error; all = all.concat(data); more = data.length === PAGE; }
        const rows = [['Waktu', 'Akun', 'Petugas', 'Peran', 'Aksi', 'Bagian', 'ID data', 'Ringkasan', 'Perangkat', 'Outlet', 'Rincian']].concat(all.map((r) => [
          new Date(r.at).toLocaleString('id-ID'), r.staff_name, r.crew_name, D.ROLES[r.role]?.short || r.role, (ACT[r.action] || [r.action])[0], ENT[r.entity] || r.entity, r.entity_id, r.summary, r.device, r.location_id || '', JSON.stringify(r.data || {}).slice(0, 2000)]));
        downloadBlob(`audit-log-kaly-${dayKey()}.xlsx`, writeXlsx(rows, { sheet: 'Audit log', widths: [19, 16, 16, 10, 9, 16, 16, 30, 20, 8, 60] }));
        C.audit('export', `Unduh audit log (${all.length} baris)`, 'audit_log');
      } catch (e) { toast(C.errMsg(e), 'err'); } finally { el.disabled = false; }
    },
  },
};
