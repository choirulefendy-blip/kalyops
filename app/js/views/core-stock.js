// Kaly Core: menu & resep bertingkat, produksi, stok, mutasi, stock opname
import { local, getDb } from '../store.js';
import * as API from '../api.js';
import * as C from '../cloud.js';
import { $, esc, ic, rp, num, pct, toast, openModal, formData, sum, fmtDT, uid, confirmBox, downloadCSV, downloadBlob, dayKey } from '../lib.js';
import * as D from '../domain.js';
import { rerender, ctxNow } from '../app.js';
import { menuPic, pickImage, saveMenuImage, removeMenuImage } from '../media.js';
import { parseMenuText, applyMenuImport } from '../menu-import.js';
import { readTable, rowsToTsv, writeXlsx } from '../xlsx.js';

// ---------- Menu ↔ Excel ----------
const MENU_COLS = ['Kategori', 'Nama menu', 'Harga', 'Deskripsi', 'Stasiun', 'Outlet', 'Status'];
const outletText = (db, outs) => { const all = db.locations.filter((l) => l.type === 'outlet'); return all.length > 1 && all.every((l) => outs.includes(l.id)) ? 'Keduanya' : outs.map((id) => D.loc(db, id)?.name || id).join(' + '); };
export function resolveOutlets(db, text) {
  const all = db.locations.filter((l) => l.type === 'outlet'), t = String(text || '').toLowerCase().trim();
  if (!t) return null;
  if (/keduanya|semua|both|all/.test(t)) return all.map((l) => l.id);
  const ids = t.split(/[,/+&]| dan /).map((x) => x.trim()).filter(Boolean)
    .map((x) => all.find((l) => l.id.toLowerCase() === x || l.name.toLowerCase().includes(x) || x.includes(l.name.toLowerCase().split(' ')[0]))?.id).filter(Boolean);
  return ids.length ? [...new Set(ids)] : null;
}
// Unduh semua menu (bukan paket) sebagai file Excel: bisa diubah di Excel lalu diimpor lagi
export function exportMenusXlsx(db = getDb()) {
  const order = new Map(db.cats.map((c, i) => [c.id, i]));
  const ms = db.menus.filter((m) => !m.pkg).sort((a, b) => (order.get(a.cat) ?? 99) - (order.get(b.cat) ?? 99) || a.name.localeCompare(b.name));
  const rows = [MENU_COLS, ...ms.map((m) => [db.cats.find((c) => c.id === m.cat)?.name || '', m.name, m.price || 0, m.desc || '', D.STATION_LABEL[m.station] || 'Dapur', outletText(db, m.outlets || []), !m.active ? 'Nonaktif' : m.soldOut ? 'Habis' : 'Aktif'])];
  downloadBlob(`menu-kaly-${dayKey()}.xlsx`, writeXlsx(rows, { sheet: 'Menu', widths: [16, 34, 11, 46, 10, 18, 10] }));
  toast(`${ms.length} menu diunduh sebagai Excel. Ubah di Excel, lalu impor lagi lewat Impor daftar menu.`, 'ok', 6000);
}

// ---------- Gambar menu ----------
function imageBlock(id) {
  const m = D.menu(getDb(), id);
  const has = !!m?.img;
  return `<div class="img-blk" data-img-blk="${id}">${menuPic(m, 'lg')}
    <div class="img-blk-t"><b>Gambar menu</b><small>Tampil di POS, halaman pesan QR & online, Lounge, dan layar pelanggan. Pilih foto atau seret file ke sini. Otomatis dikecilkan.</small>
    <div class="row wrap"><button type="button" class="btn btn-sm" data-img-pick>${ic(has ? 'refresh-cw' : 'image-plus', 15)} ${has ? 'Ganti gambar' : 'Unggah gambar'}</button>${has ? `<button type="button" class="btn btn-sm btn-danger-ghost" data-img-del>${ic('trash-2', 15)} Hapus</button>` : ''}</div></div></div>`;
}
async function setMenuImage(id, file) {
  if (!file) return false;
  try {
    toast('Mengunggah gambar…', 'info', 2500);
    const old = D.menu(getDb(), id)?.img;
    const { path, kb } = await saveMenuImage(id, file);
    await API.menuSave({ id, image_path: path });
    if (old && old !== path) removeMenuImage(old);
    await C.refresh('menus');
    toast(`Gambar ${D.menu(getDb(), id)?.name || 'menu'} tersimpan (${kb} KB)`);
    return true;
  } catch (e) { toast(e.message || 'Gambar gagal disimpan', 'err'); return false; }
}
function bindImageBlock(m) {
  const swap = () => { const el = m.querySelector('[data-img-blk]'); if (el) el.outerHTML = imageBlock(el.dataset.imgBlk); };
  m.addEventListener('click', async (e) => {
    const blk = e.target.closest('[data-img-blk]'); if (!blk) return;
    const id = blk.dataset.imgBlk;
    if (e.target.closest('[data-img-pick]') || e.target.closest('.mpic')) { if (await setMenuImage(id, await pickImage())) swap(); }
    if (e.target.closest('[data-img-del]')) { const old = D.menu(getDb(), id)?.img; try { await API.menuSave({ id, image_path: '' }); await removeMenuImage(old); await C.refresh('menus'); toast('Gambar dihapus'); swap(); } catch (err) { toast(err.message, 'err'); } }
  });
  m.addEventListener('dragover', (e) => { const blk = e.target.closest('[data-img-blk]'); if (blk) { e.preventDefault(); blk.classList.add('drop'); } });
  m.addEventListener('dragleave', (e) => { const blk = e.target.closest('[data-img-blk]'); if (blk) blk.classList.remove('drop'); });
  m.addEventListener('drop', async (e) => {
    const blk = e.target.closest('[data-img-blk]'); if (!blk) return;
    e.preventDefault(); blk.classList.remove('drop');
    if (await setMenuImage(blk.dataset.imgBlk, e.dataTransfer?.files?.[0])) swap();
  });
}

const ui = { stLoc: 'L1', stQ: '', stF: 'all', prLoc: 'L1', opLoc: 'L1', op: null, rsQ: '', rsCat: 'all', rsOff: false };
const TYPE = { raw: 'Bahan baku', semi: 'Setengah jadi' };
const MOVE = { sale: 'Penjualan', 'prod-in': 'Hasil produksi', 'prod-out': 'Dipakai produksi', po: 'Terima PO', 'tf-out': 'Mutasi keluar', 'tf-in': 'Mutasi masuk', opname: 'Stock opname', 'b2b-out': 'Jual B2B', 'b2b-in': 'Beli B2B', waste: 'Waste' };
const locOpts = (db, sel, filter = () => true) => db.locations.filter(filter).map((l) => `<option value="${l.id}" ${l.id === sel ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
const fmtQ = (q, u) => `${num(q, q % 1 ? 2 : 0)} ${esc(u)}`;

// ---------- Resep ----------
function treeHtml(nodes) {
  return `<ul class="tree">${nodes.map((n) => `<li><span class="tr-row"><span>${esc(n.name)} ${n.type === 'semi' ? '<span class="badge b-info">setengah jadi</span>' : ''}</span><span class="muted">${fmtQ(n.q, n.unit)}</span><span>${rp(n.cost)}</span></span>${n.children.length ? treeHtml(n.children) : ''}</li>`).join('')}</ul>`;
}
function resep(ctx) {
  const db = ctx.db, q = ui.rsQ.trim().toLowerCase();
  const all = db.menus.filter((m) => ui.rsOff || m.active);
  const ms = all.filter((m) => !q || m.name.toLowerCase().includes(q));
  const semis = db.items.filter((i) => i.type === 'semi');
  const known = new Set(db.cats.map((c) => c.id));
  const groups = [...db.cats, ...(db.menus.some((m) => !known.has(m.cat)) ? [{ id: '__none', name: 'Tanpa kategori' }] : [])];
  const inCat = (c, list) => list.filter((m) => (c.id === '__none' ? !known.has(m.cat) : m.cat === c.id));
  const offN = db.menus.filter((m) => !m.active).length;
  const row = (m) => { const h = D.menuHpp(db, m), fc = m.price ? h / m.price : 0; return `<tr data-a="menuEdit" data-id="${m.id}"><td class="mrow"><button class="mrow-pic" data-a="menuImg" data-id="${m.id}" title="${m.img ? 'Ganti' : 'Unggah'} gambar ${esc(m.name)}" aria-label="${m.img ? 'Ganti' : 'Unggah'} gambar ${esc(m.name)}">${menuPic(m, 'xs')}<i>${ic(m.img ? 'refresh-cw' : 'camera', 12)}</i></button><span><b>${esc(m.name)}</b>${m.active ? '' : ' <span class="badge b-mute">nonaktif</span>'}${m.soldOut ? ' <span class="badge b-err">habis</span>' : (m.outlets || []).some((L) => D.stockOut(db, m.id, L)) ? ` <span class="badge b-err" title="Bahan tidak cukup: ${esc(D.item(db, D.menuPortions(db, m, (m.outlets || []).find((L) => D.stockOut(db, m.id, L))).limit)?.name || '')}">bahan habis</span>` : ''}${m.pkg ? ' <span class="badge b-mute">paket</span>' : ''}${m.desc ? `<small class="muted mrow-d">${esc(m.desc)}</small>` : ''}</span></td><td>${esc(D.STATION_LABEL[m.station] || '')}</td><td>${(m.outlets || []).map((l) => esc(D.loc(db, l).name)).join(', ')}</td><td class="r">${m.price ? rp(m.price) : '<span class="muted">belum diisi</span>'}</td><td class="r">${rp(h)}</td><td class="r ${fc > 0.4 ? 'neg' : ''}">${m.price ? pct(fc, 1) : '—'}</td><td class="r">${m.price ? rp(m.price - h) : '—'}</td><td>${ic('chevron-right', 16)}</td></tr>`; };
  const chips = [`<button class="chip ${ui.rsCat === 'all' ? 'on' : ''}" data-a="rsCat" data-v="all">Semua <small>${all.length}</small></button>`,
    ...groups.map((c) => `<button class="chip ${ui.rsCat === c.id ? 'on' : ''}" data-a="rsCat" data-v="${c.id}"><i class="cdot cc-${c.id === '__none' ? 'slate' : D.catColor(db, c.id)}"></i>${esc(c.name)} <small>${inCat(c, all).length}</small></button>`)].join('');
  const body = groups.filter((c) => ui.rsCat === 'all' || ui.rsCat === c.id).map((c) => {
    const list = inCat(c, ms);
    if (!list.length && (q || c.id === '__none')) return '';
    const col = c.id === '__none' ? 'slate' : D.catColor(db, c.id);
    return `<tbody class="grp cc-${col}"><tr class="grp-h"><td colspan="8"><div class="grp-bar"><span class="grp-t"><i class="cdot"></i><b>${esc(c.name)}</b><small>${list.length} menu${c.station ? ` · stasiun ${esc(D.STATION_LABEL[c.station])}` : ''}</small></span>${c.id !== '__none' ? `<button class="btn btn-sm" data-a="menuNew" data-cat="${c.id}">${ic('plus', 14)} Tambah menu</button>` : ''}</div></td></tr>
      ${list.length ? list.map(row).join('') : `<tr><td colspan="8" class="muted sm grp-empty">Belum ada menu di kategori ini. Tekan Tambah menu.</td></tr>`}</tbody>`;
  }).join('');
  return `<div class="row sb wrap"><div class="search">${ic('search', 17)}<input id="rs-q" data-in="rsQ" placeholder="Cari menu" value="${esc(ui.rsQ)}"></div><div class="row wrap"><button class="btn" data-a="catManage">${ic('palette', 16)} Kelola kategori</button><button class="btn" data-a="menuImport">${ic('upload', 16)} Impor daftar menu</button><button class="btn btn-pri" data-a="menuNew">${ic('plus', 16)} Menu baru</button></div></div>
    <div class="row sb wrap rs-filter"><div class="chips">${chips}</div>${offN ? `<label class="switch sm"><input type="checkbox" data-a-change="rsOff" ${ui.rsOff ? 'checked' : ''}><span>Tampilkan ${offN} menu nonaktif</span></label>` : ''}</div>
    <div class="card"><div class="card-h"><h3>Menu & HPP resep</h3><span class="muted sm">Dikelompokkan per kategori. HPP dihitung dari resep bertingkat dan harga beli terakhir</span></div>
    <div class="tbl-wrap"><table class="tbl hover tbl-grp"><thead><tr><th>Menu</th><th>Stasiun</th><th>Outlet</th><th class="r">Harga</th><th class="r">HPP</th><th class="r">Food cost</th><th class="r">Margin</th><th></th></tr></thead>
    ${body || `<tbody><tr><td colspan="8" class="empty">Menu tidak ditemukan.</td></tr></tbody>`}
    </table></div></div>
    <div class="card"><div class="card-h"><h3>Bahan setengah jadi</h3><span class="muted sm">Dipakai di resep menu, bisa berisi bahan setengah jadi lain</span></div>
    <div class="tbl-wrap"><table class="tbl hover"><thead><tr><th>Bahan</th><th>Hasil per batch</th><th>Komposisi</th><th class="r">HPP per unit</th><th></th></tr></thead><tbody>
    ${semis.map((s) => `<tr data-a="semiEdit" data-id="${s.id}"><td><b>${esc(s.name)}</b></td><td>${fmtQ(s.yield, s.unit)}</td><td class="muted">${s.bom.map((b) => esc(D.item(db, b.i)?.name)).join(', ')}</td><td class="r">${rp(D.stdCost(db, s.id))}/${esc(s.unit)}</td><td>${ic('chevron-right', 16)}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}
function bomEditor({ title, comps, extraHead, onSave, isMenu, yieldInfo }) {
  const db = getDb();
  let rows = comps.map((c) => ({ ...c }));
  const itemOpts = (sel) => db.items.map((i) => `<option value="${i.id}" ${i.id === sel ? 'selected' : ''}>${esc(i.name)} (${esc(i.unit)})${i.type === 'semi' ? ' · setengah jadi' : ''}</option>`).join('');
  const draw = () => {
    const tree = D.bomTree(db, rows.filter((r) => r.i && r.q > 0));
    const total = sum(tree, (n) => n.cost);
    return `${typeof extraHead === 'function' ? extraHead() : extraHead || ''}
      <h4 class="sec-t">Komposisi ${yieldInfo ? `<span class="muted">${yieldInfo}</span>` : 'per porsi'}</h4>
      <div class="bom-rows">${rows.map((r, i) => `<div class="bom-row"><select data-bi="${i}">${itemOpts(r.i)}</select><input type="number" step="0.001" min="0" data-bq="${i}" value="${r.q}" aria-label="Jumlah"><span class="muted sm">${esc(D.item(db, r.i)?.unit || '')}</span><button class="btn-icon sm" data-bx="${i}" aria-label="Hapus">${ic('x', 15)}</button></div>`).join('')}</div>
      <button class="btn btn-sm" data-badd>${ic('plus', 14)} Tambah bahan</button>
      <h4 class="sec-t">Rincian bertingkat <span class="muted">HPP ${rp(total)}${yieldInfo ? ' per batch' : ''}</span></h4>${treeHtml(tree)}`;
  };
  openModal({ title, size: 'lg', body: draw(), footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Simpan</button>`,
    onMount(m, api) {
      bindImageBlock(m);
      const body = () => m.querySelector('.modal-b');
      const keep = () => { const f = formData(m); return f; };
      let head = {};
      const capture = () => { m.querySelectorAll('.head [name]').forEach((el) => { head[el.name] = el.type === 'checkbox' ? el.checked : el.value; }); };
      const restore = () => { m.querySelectorAll('.head [name]').forEach((el) => { if (head[el.name] === undefined) return; if (el.type === 'checkbox') el.checked = head[el.name]; else el.value = head[el.name]; }); };
      const redraw = () => { capture(); api.set(draw()); restore(); };
      m.addEventListener('change', (e) => { if (e.target.dataset.bi !== undefined) { rows[+e.target.dataset.bi].i = e.target.value; redraw(); } if (e.target.dataset.bq !== undefined) { rows[+e.target.dataset.bq].q = Number(e.target.value); redraw(); } });
      m.addEventListener('click', (e) => {
        if (e.target.closest('[data-badd]')) { rows.push({ i: db.items[0].id, q: 0.1 }); redraw(); }
        const x = e.target.closest('[data-bx]'); if (x) { rows.splice(+x.dataset.bx, 1); redraw(); }
      });
      m.querySelector('[data-ok]').onclick = async (ev) => {
        capture();
        const btn = ev.currentTarget; btn.disabled = true;
        try { const ok = await onSave(rows.filter((r) => r.i && r.q > 0), head); if (ok !== false) { api.close(); rerender(); } }
        catch (e) { toast(e.message, 'err', 6000); }
        finally { btn.disabled = false; }
      };
    } });
}

// ---------- Produksi ----------
function produksi(ctx) {
  const db = ctx.db, L = ui.prLoc;
  const semis = db.items.filter((i) => i.type === 'semi');
  const hist = db.productions.filter((p) => p.loc === L).slice(0, 25);
  return `<div class="row sb wrap"><label class="fld inline"><span>Lokasi produksi</span><select data-a-change="prLoc">${locOpts(db, L)}</select></label>
      <label class="switch"><input type="checkbox" data-a-change="autoProd" ${db.settings.autoProduce ? 'checked' : ''}><span>Produksi otomatis saat stok setengah jadi kurang ketika menu terjual</span></label></div>
    <div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Bahan setengah jadi</th><th class="r">Stok</th><th class="r">Minimum</th><th class="r">Saran produksi</th><th class="r">HPP per batch</th><th></th></tr></thead><tbody>
    ${semis.map((s) => { const sl = db.stock[L]?.[s.id] || { q: 0, min: 0 }; const need = sl.min > 0 && sl.q < sl.min ? Math.ceil((sl.min * 1.5 - sl.q) / s.yield) : 0; return `<tr><td><b>${esc(s.name)}</b><small class="muted"> ${fmtQ(s.yield, s.unit)} per batch</small></td><td class="r ${sl.q < sl.min ? 'neg' : ''}">${fmtQ(sl.q, s.unit)}</td><td class="r">${fmtQ(sl.min, s.unit)}</td><td class="r">${need ? `<span class="badge b-warn">${need} batch</span>` : '<span class="muted">cukup</span>'}</td><td class="r">${rp(D.stdCost(db, s.id) * s.yield)}</td><td><button class="btn btn-sm ${need ? 'btn-pri' : ''}" data-a="produce" data-id="${s.id}" data-n="${need || 1}">Produksi</button></td></tr>`; }).join('')}
    </tbody></table></div></div>
    <div class="card"><div class="card-h"><h3>Riwayat produksi</h3></div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Waktu</th><th>No.</th><th>Bahan</th><th class="r">Hasil</th><th class="r">Biaya</th><th>Jenis</th><th>Referensi</th></tr></thead><tbody>
    ${hist.map((p) => { const it = D.item(db, p.i); return `<tr><td>${fmtDT(p.at)}</td><td>${esc(p.id)}</td><td>${esc(it?.name)}</td><td class="r">${fmtQ(p.q, it?.unit)}</td><td class="r">${rp(p.cost)}</td><td>${p.auto ? '<span class="badge b-info">Otomatis</span>' : '<span class="badge b-mute">Manual</span>'}</td><td class="muted">${esc(p.ref || '')}</td></tr>`; }).join('') || '<tr><td colspan="7" class="empty">Belum ada produksi di lokasi ini.</td></tr>'}
    </tbody></table></div></div>`;
}

// ---------- Stok ----------
function stok(ctx) {
  const db = ctx.db, L = ui.stLoc, q = ui.stQ.toLowerCase();
  const rows = Object.entries(db.stock[L] || {}).map(([i, s]) => ({ it: D.item(db, i), ...s })).filter((r) => r.it && (!q || r.it.name.toLowerCase().includes(q)) && (ui.stF === 'all' || (ui.stF === 'low' ? r.min > 0 && r.q < r.min : r.it.type === ui.stF)))
    .sort((a, b) => (a.q < a.min) === (b.q < b.min) ? a.it.name.localeCompare(b.it.name) : a.q < a.min ? -1 : 1);
  const total = D.stockValue(db, [L]);
  return `<div class="row sb wrap"><div class="chips">${db.locations.map((l) => `<button class="chip ${L === l.id ? 'on' : ''}" data-a="stLoc" data-v="${l.id}">${esc(l.name)}</button>`).join('')}</div>
      <div class="row"><button class="btn" data-a="stCsv">${ic('download', 16)} CSV</button><button class="btn" data-a="tfNew">${ic('arrow-left-right', 16)} Mutasi</button><a class="btn" href="#/goods">${ic('truck', 16)} Buat PO</a></div></div>
    ${D.loc(db, L)?.type === 'outlet' && !D.coreOn(db, L) ? `<div class="banner info">${ic('info', 18)}<span><b>${esc(D.loc(db, L).name)}</b> tidak terhubung ke stok Kaly Core: penjualan di outlet ini tidak memotong stok di bawah. Ubah di Pengaturan › Integrasi Kaly Core.</span></div>` : ''}
    <div class="row wrap"><div class="search">${ic('search', 17)}<input id="st-q" data-in="stQ" placeholder="Cari bahan" value="${esc(ui.stQ)}"></div>
      <div class="chips">${[['all', 'Semua'], ['raw', 'Bahan baku'], ['semi', 'Setengah jadi'], ['low', 'Di bawah minimum']].map(([k, l]) => `<button class="chip ${ui.stF === k ? 'on' : ''}" data-a="stF" data-v="${k}">${l}</button>`).join('')}</div>
      <span class="muted">Nilai persediaan <b>${rp(total)}</b></span></div>
    <div class="card"><div class="tbl-wrap"><table class="tbl hover"><thead><tr><th>Bahan</th><th>Jenis</th><th class="r">Stok</th><th class="r">Minimum</th><th class="r">HPP rata-rata</th><th class="r">Nilai</th><th>Status</th></tr></thead><tbody>
    ${rows.map((r) => `<tr data-a="stCard" data-id="${r.it.id}"><td><b>${esc(r.it.name)}</b></td><td>${TYPE[r.it.type]}</td><td class="r">${fmtQ(r.q, r.it.unit)}</td><td class="r">${fmtQ(r.min, r.it.unit)}</td><td class="r">${rp(r.c)}</td><td class="r ${r.q < 0 ? 'neg' : ''}">${rp(r.q * r.c)}</td><td>${r.q < 0 ? '<span class="badge b-err">Minus</span>' : r.min > 0 && r.q < r.min ? '<span class="badge b-warn">Perlu belanja</span>' : '<span class="badge b-ok">Aman</span>'}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">Tidak ada bahan untuk filter ini.</td></tr>'}
    </tbody></table></div></div>`;
}

// ---------- Mutasi ----------
function mutasi(ctx) {
  const db = ctx.db;
  return `<div class="row sb wrap"><p class="muted">Pindahkan stok antar lokasi dalam satu entitas. Untuk Central Kitchen ke Resto (beda entitas), gunakan tab B2B supaya tercatat sebagai penjualan antar perusahaan.</p><button class="btn btn-pri" data-a="tfNew">${ic('plus', 16)} Mutasi baru</button></div>
    <div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>No.</th><th>Tanggal</th><th>Dari</th><th>Ke</th><th>Barang</th><th>Status</th><th></th></tr></thead><tbody>
    ${db.transfers.map((t) => `<tr><td><b>${esc(t.no)}</b></td><td>${fmtDT(t.at)}</td><td>${esc(D.loc(db, t.from).name)}</td><td>${esc(D.loc(db, t.to).name)}</td><td>${t.items.map((x) => `${num(x.q, 2)} ${esc(D.item(db, x.i).unit)} ${esc(D.item(db, x.i).name)}`).join(', ')}</td><td>${t.status === 'dikirim' ? '<span class="badge b-warn">Dalam perjalanan</span>' : `<span class="badge b-ok">Diterima</span>${t.diff ? ' <span class="badge b-err">Ada selisih</span>' : ''}`}</td><td>${t.status === 'dikirim' ? `<button class="btn btn-sm btn-pri" data-a="tfRecv" data-id="${t.id}">Terima</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">Belum ada mutasi. Contoh: kirim pakan kambing dari Resto ke Play Corner.</td></tr>'}
    </tbody></table></div></div>`;
}

// ---------- Opname ----------
function opname(ctx) {
  const db = ctx.db;
  if (ui.op) {
    const L = ui.op.loc;
    const rows = Object.entries(db.stock[L] || {}).map(([i, s]) => ({ it: D.item(db, i), ...s })).filter((r) => r.it).sort((a, b) => a.it.name.localeCompare(b.it.name));
    let tot = 0, filled = 0;
    const body = rows.map((r) => {
      const v = ui.op.vals[r.it.id];
      const has = v !== undefined && v !== '';
      const diff = has ? Number(v) - r.q : 0;
      const val = diff * r.c;
      if (has) { tot += val; filled++; }
      return `<tr><td><b>${esc(r.it.name)}</b></td><td class="r">${fmtQ(r.q, r.it.unit)}</td><td class="r"><input class="inp inp-num" type="number" step="0.01" id="op-${r.it.id}" data-in="op" data-i="${r.it.id}" value="${has ? esc(v) : ''}" placeholder="—"></td><td class="r ${diff < 0 ? 'neg' : diff > 0 ? 'pos' : ''}">${has ? (diff > 0 ? '+' : '') + num(diff, 2) : ''}</td><td class="r ${val < 0 ? 'neg' : ''}" id="opv-${r.it.id}">${has ? rp(val) : ''}</td></tr>`;
    }).join('');
    return `<div class="row sb wrap"><h3>Stock opname ${esc(D.loc(db, L).name)}</h3><div class="row"><button class="btn" data-a="opCancel">Batal</button><button class="btn btn-pri" data-a="opPost">${ic('clipboard-check', 16)} Posting penyesuaian</button></div></div>
      <p class="muted">Isi jumlah fisik hasil hitung. Bahan yang dikosongkan tidak disesuaikan. <b id="op-sum">${filled} bahan dihitung, selisih ${rp(tot)}</b></p>
      <div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Bahan</th><th class="r">Sistem</th><th class="r">Fisik</th><th class="r">Selisih</th><th class="r">Nilai selisih</th></tr></thead><tbody>${body}</tbody></table></div></div>`;
  }
  return `<div class="row sb wrap"><label class="fld inline"><span>Lokasi</span><select data-a-change="opLoc">${locOpts(db, ui.opLoc)}</select></label><button class="btn btn-pri" data-a="opStart">${ic('clipboard-list', 16)} Mulai stock opname</button></div>
    <div class="card"><div class="card-h"><h3>Riwayat stock opname</h3></div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>No.</th><th>Tanggal</th><th>Lokasi</th><th>Oleh</th><th class="r">Bahan dihitung</th><th class="r">Nilai selisih</th></tr></thead><tbody>
    ${db.opnames.slice().reverse().map((o) => `<tr><td><b>${esc(o.no)}</b></td><td>${fmtDT(o.at)}</td><td>${esc(D.loc(db, o.loc).name)}</td><td>${esc(D.userName(db, o.by))}</td><td class="r">${o.lines.length}</td><td class="r ${o.total < 0 ? 'neg' : ''}">${rp(o.total)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Belum ada stock opname.</td></tr>'}
    </tbody></table></div></div>`;
}

export function render(tab, ctx) {
  return { resep, produksi, stok, mutasi, opname }[tab](ctx);
}
export function input(k, el) {
  if (k === 'rsQ' || k === 'stQ') { ui[k] = el.value; rerender(); }
  if (k === 'op') {
    ui.op.vals[el.dataset.i] = el.value;
    const db = getDb(); const s = db.stock[ui.op.loc][el.dataset.i];
    const has = el.value !== '';
    const val = has ? (Number(el.value) - s.q) * s.c : 0;
    const cell = document.getElementById('opv-' + el.dataset.i);
    if (cell) { cell.textContent = has ? rp(val) : ''; cell.className = 'r ' + (val < 0 ? 'neg' : ''); const dc = cell.previousElementSibling; const diff = has ? Number(el.value) - s.q : 0; dc.textContent = has ? (diff > 0 ? '+' : '') + num(diff, 2) : ''; dc.className = 'r ' + (diff < 0 ? 'neg' : diff > 0 ? 'pos' : ''); }
    let tot = 0, filled = 0;
    for (const [i, v] of Object.entries(ui.op.vals)) if (v !== '') { const ss = db.stock[ui.op.loc][i]; tot += (Number(v) - ss.q) * ss.c; filled++; }
    const sm = document.getElementById('op-sum'); if (sm) sm.textContent = `${filled} bahan dihitung, selisih ${rp(tot)}`;
  }
}

// Jenis perubahan satu baris impor dibanding menu yang sudah ada: add | upd | same | off | skip
function impKind(db, r) {
  const ex = db.menus.find((m) => !m.pkg && m.name.toLowerCase() === r.name.toLowerCase());
  if (r.inactive) return !ex ? 'skip' : ex.active ? 'off' : 'same';
  if (!ex) return 'add';
  const outs = (a) => [...(a || [])].sort().join();
  const same = ex.active && (!r.price || ex.price === r.price) && (r.soldOut === undefined || !!ex.soldOut === !!r.soldOut) && (!r.desc || (ex.desc || '') === r.desc)
    && (!r.stationSet || ex.station === r.station) && (!r.outlets || outs(r.outlets) === outs(ex.outlets))
    && (!r.cat || (db.cats.find((c) => c.id === ex.cat)?.name || '').toLowerCase() === String(r.cat).toLowerCase());
  return same ? 'same' : 'upd';
}

// ---------- Tambah menu & kelola kategori ----------
export function openMenuForm({ cat, onDone } = {}) {
  const db = getDb();
  const cats = db.cats.filter((c) => c.id !== 'paket');
  if (!cats.length) return toast('Buat kategori dulu di Kelola kategori', 'warn');
  const c0 = cats.find((c) => c.id === cat) || cats[0];
  const stOpts = (sel) => Object.entries(D.STATION_LABEL).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('');
  openModal({ title: cat ? `Tambah menu di ${c0.name}` : 'Menu baru', size: 'md',
    body: `<div class="grid2"><label class="fld"><span>Nama menu</span><input name="name" autofocus placeholder="mis. Nasi Goreng Kaly"></label><label class="fld"><span>Harga jual (Rp)</span><input name="price" type="number" min="0" step="500" placeholder="mis. 33000"></label>
      <label class="fld"><span>Kategori</span><div class="cat-sel"><i class="cdot cc-${D.catColor(db, c0.id)}" data-cdot></i><select name="cat">${cats.map((c) => `<option value="${c.id}" ${c.id === c0.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div></label>
      <label class="fld"><span>Stasiun</span><select name="station">${stOpts(c0.station || 'dapur')}</select></label>
      <label class="fld"><span>Outlet</span><select name="out"><option value="L1">Resto</option><option value="L2" ${c0.station === 'none' && c0.id === 'play' ? 'selected' : ''}>Play Corner</option><option value="L1,L2">Keduanya</option></select></label>
      <label class="fld"><span>Deskripsi</span><input name="desc" placeholder="Tampil di halaman pesan pelanggan"></label></div>
      <label class="fld"><span>Gambar (opsional)</span><input type="file" name="pic" accept="image/*" class="inp"></label>
      <label class="switch"><input type="checkbox" name="more"><span>Setelah disimpan, tambah menu lain di kategori yang sama</span></label>
      <p class="hint">Stasiun mengikuti kategori: Dapur dan Bar mendapat tiket di Kaly Kitchen, Langsung tidak. Resep bisa diisi nanti dengan membuka menunya.</p>`,
    footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>${ic('plus', 16)} Simpan menu</button>`,
    onMount(m, api) {
      const sel = m.querySelector('[name=cat]');
      sel.onchange = () => { const d = getDb(), c = d.cats.find((x) => x.id === sel.value); m.querySelector('[data-cdot]').className = `cdot cc-${D.catColor(d, sel.value)}`; if (c?.station) m.querySelector('[name=station]').value = c.station; };
      m.querySelector('[data-ok]').onclick = async () => {
        const f = formData(m), name = f.name.trim(), price = Number(f.price);
        if (!name || !(price > 0)) return toast('Isi nama dan harga jual', 'warn');
        if (getDb().menus.some((x) => x.active && x.name.toLowerCase() === name.toLowerCase())) return toast(`Menu ${name} sudah ada`, 'warn');
        const id = uid('m_');
        const btn = m.querySelector('[data-ok]'); btn.disabled = true;
        try {
          await API.menuSave({ id, name, category_id: f.cat, price, station: f.station, prep_min: f.station === 'bar' ? 4 : f.station === 'none' ? 0 : 10, active: true, outlets: f.out.split(','), description: f.desc.trim(), tags: ['new'], bom: [] });
          await C.refresh('menus');
        } catch (e) { btn.disabled = false; return toast(e.message, 'err'); }
        const file = m.querySelector('[name=pic]')?.files?.[0];
        api.close();
        if (file) await setMenuImage(id, file);
        toast(`${name} ditambahkan ke ${getDb().cats.find((c) => c.id === f.cat)?.name || 'menu'}`);
        rerender();
        if (f.more) openMenuForm({ cat: f.cat, onDone }); else if (onDone) onDone(id);
      };
    } });
}

function openCatManager() {
  const db0 = getDb();
  let cats = db0.cats.map((c) => ({ ...c, color: D.catColor(db0, c.id) }));
  const count = (id) => getDb().menus.filter((m) => m.cat === id).length;
  const colors = Object.entries(D.CAT_COLORS);
  const draw = () => `<p class="muted sm">Urutan di sini menjadi urutan kelompok menu di POS, halaman pesan, dan daftar menu. Warna membedakan kategori di semua layar.</p>
    <div class="catm">${cats.map((c, i) => { const n = count(c.id); return `<div class="catm-row cc-${c.color}">
      <span class="catm-ord"><button type="button" class="btn-icon sm" data-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Naikkan ${esc(c.name)}">${ic('chevron-up', 16)}</button><button type="button" class="btn-icon sm" data-down="${i}" ${i === cats.length - 1 ? 'disabled' : ''} aria-label="Turunkan ${esc(c.name)}">${ic('chevron-down', 16)}</button></span>
      <i class="cdot cdot-lg"></i>
      <input class="inp catm-name" data-name="${i}" value="${esc(c.name)}" aria-label="Nama kategori">
      <select class="inp catm-st" data-st="${i}" aria-label="Stasiun default">${Object.entries(D.STATION_LABEL).map(([k, v]) => `<option value="${k}" ${(c.station || 'dapur') === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <span class="catm-sw" role="group" aria-label="Warna">${colors.map(([k, l]) => `<button type="button" class="sw cc-${k} ${c.color === k ? 'on' : ''}" data-col="${i}" data-k="${k}" title="${l}" aria-label="${l}"></button>`).join('')}</span>
      <span class="catm-n muted sm">${n} menu</span>
      <button type="button" class="btn-icon sm" data-del="${i}" ${n ? 'disabled title="Pindahkan atau hapus menunya dulu"' : ''} aria-label="Hapus ${esc(c.name)}">${ic('trash-2', 15)}</button></div>`; }).join('')}</div>
    <div class="row catm-add"><input class="inp" id="catm-new" placeholder="Nama kategori baru, mis. Paket Hemat"><button type="button" class="btn" data-add>${ic('plus', 15)} Tambah kategori</button></div>`;
  openModal({ title: 'Kelola kategori menu', size: 'lg', body: draw(), footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Simpan kategori</button>`,
    onMount(m, api) {
      const redraw = () => api.set(draw());
      m.addEventListener('input', (e) => { const i = e.target.dataset.name; if (i !== undefined) cats[+i].name = e.target.value; });
      m.addEventListener('change', (e) => { const i = e.target.dataset.st; if (i !== undefined) cats[+i].station = e.target.value; });
      m.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b || b.disabled) return;
        if (b.dataset.up !== undefined) { const i = +b.dataset.up; [cats[i - 1], cats[i]] = [cats[i], cats[i - 1]]; redraw(); }
        else if (b.dataset.down !== undefined) { const i = +b.dataset.down; [cats[i + 1], cats[i]] = [cats[i], cats[i + 1]]; redraw(); }
        else if (b.dataset.col !== undefined) { cats[+b.dataset.col].color = b.dataset.k; redraw(); }
        else if (b.dataset.del !== undefined) { cats.splice(+b.dataset.del, 1); redraw(); }
        else if (b.dataset.add !== undefined) {
          const name = m.querySelector('#catm-new').value.trim();
          if (!name) return toast('Isi nama kategori baru', 'warn');
          if (cats.some((c) => c.name.toLowerCase() === name.toLowerCase())) return toast(`Kategori ${name} sudah ada`, 'warn');
          const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || 'kategori';
          let id = base, k = 2; while (cats.some((c) => c.id === id) || getDb().cats.some((c) => c.id === id)) id = base + k++;
          const used = new Set(cats.map((c) => c.color));
          cats.push({ id, name, color: colors.map(([c]) => c).find((c) => !used.has(c)) || 'slate', station: 'dapur' });
          redraw(); m.querySelector('#catm-new')?.focus();
        }
      });
      m.querySelector('[data-ok]').onclick = async () => {
        if (cats.some((c) => !c.name.trim())) return toast('Nama kategori tidak boleh kosong', 'warn');
        const names = cats.map((c) => c.name.trim().toLowerCase());
        if (new Set(names).size !== names.length) return toast('Ada nama kategori yang sama', 'warn');
        try { await API.catalogSave({ categories: cats.map((c) => ({ id: c.id, name: c.name.trim(), color: c.color, station: c.station || 'dapur' })) }); await C.refresh('menus'); }
        catch (e) { return toast(e.message, 'err'); }
        api.close(); toast('Kategori menu disimpan'); rerender();
      };
    } });
}

export const actions = {
  menuImport() {
    const db = getDb();
    let rows = [], mode = 'add', outlet = 'L1';
    const ST = Object.entries(D.STATION_LABEL);
    const prev = () => {
      if (!rows.length) return `<p class="empty sm">Belum ada menu terbaca. Pilih file Excel, atau tempel daftar menu di atas.</p>`;
      const d = getDb();
      const ok = rows.filter(usable);
      const cats = [...new Set(rows.map((r) => r.cat))];
      const showOut = rows.some((r) => r.outlets);
      const k = {}; ok.forEach((r) => { const t = impKind(d, r); k[t] = (k[t] || 0) + 1; });
      const parts = [k.add && `${k.add} baru`, k.upd && `${k.upd} diperbarui`, k.off && `${k.off} dinonaktifkan`, k.same && `${k.same} tidak berubah`].filter(Boolean).join(', ');
      return `<p class="sm"><b>${ok.length} menu</b> dalam ${cats.length} kategori terbaca${parts ? `: ${parts}` : ''}${rows.length > ok.length ? `, ${rows.length - ok.length} dilewati` : ''}.</p>
        <div class="tbl-wrap imp-prev"><table class="tbl"><thead><tr><th></th><th>Kategori</th><th>Nama</th><th class="r">Harga</th><th>Deskripsi</th><th>Stasiun</th>${showOut ? '<th>Outlet</th>' : ''}<th></th></tr></thead><tbody>
        ${rows.map((r, i) => { const ex = d.menus.find((m) => !m.pkg && m.name.toLowerCase() === r.name.toLowerCase()); return `<tr class="${r.on ? '' : 'off'}"><td><input type="checkbox" data-ion="${i}" ${r.on ? 'checked' : ''} aria-label="Impor ${esc(r.name)}"></td><td>${esc(r.cat)}</td><td><b>${esc(r.name)}</b>${r.tags?.includes('best') ? ' <span class="badge b-ok">Terlaris</span>' : ''}${r.tags?.includes('new') ? ' <span class="badge b-info">Baru</span>' : ''}</td><td class="r ${r.price || r.soldOut ? '' : 'neg'}">${r.price ? rp(r.price) : r.soldOut ? '' : 'tanpa harga'}${r.soldOut ? ' <span class="badge b-err">habis</span>' : ''}</td><td class="muted sm">${esc(r.desc || '')}</td>
          <td><select data-ist="${i}" class="inp-sm">${ST.map(([k, v]) => `<option value="${k}" ${r.station === k ? 'selected' : ''}>${v}</option>`).join('')}</select></td>${showOut ? `<td class="sm">${r.outlets ? esc(outletText(d, r.outlets)) : '<span class="muted">pilihan di atas</span>'}</td>` : ''}<td>${{ off: '<span class="badge b-mute">nonaktifkan</span>', skip: '<span class="badge b-mute">dilewati</span>', same: '<span class="badge b-mute">tidak berubah</span>', upd: '<span class="badge b-warn">perbarui</span>', add: '<span class="badge b-ok">baru</span>' }[impKind(d, r)]}</td></tr>`; }).join('')}</tbody></table></div>`;
    };
    const usable = (r) => r.on && r.name && (r.inactive || r.price > 0 || r.soldOut);
    const count = () => rows.filter(usable).length;
    openModal({ title: 'Impor daftar menu', size: 'lg',
      body: `<div class="imp-file"><button type="button" class="btn btn-pri" data-ifile>${ic('upload', 16)} Pilih file Excel / CSV</button><button type="button" class="btn" data-iexport>${ic('download', 16)} Unduh menu sekarang (Excel)</button><input type="file" id="imp-file" accept=".xlsx,.csv,.txt,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" hidden><span class="muted sm" id="imp-fname"></span></div>
        <p class="muted">File Excel (.xlsx) atau CSV dengan kolom <b>Kategori, Nama menu, Harga</b>, dan bila ada <b>Deskripsi, Stasiun</b> (Dapur/Bar/Langsung), <b>Outlet</b> (Resto/Play Corner/Keduanya), <b>Status</b> (Aktif/Habis/Nonaktif). Cara termudah: unduh menu sekarang, ubah di Excel, lalu pilih file itu. Bisa juga menempel daftar menu dari spreadsheet atau teks halaman menu online di kotak bawah ini.</p>
        <textarea id="imp-t" class="inp imp-t" rows="6" placeholder="Kopi&#9;Kopi Tubruk Dampit&#9;15000&#9;Robusta Dampit, diseduh tubruk&#10;Kopi&#9;Es Kopi Susu Aren&#9;24000&#9;Susu segar dan gula aren&#10;&#10;atau teks bebas:&#10;KOPI&#10;Kopi Tubruk Dampit&#10;Rp15.000"></textarea>
        <div class="row wrap imp-opt"><label class="fld inline"><span>Outlet</span><select id="imp-out">${db.locations.filter((l) => l.type === 'outlet').map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></label>
          <div class="seg" role="group" aria-label="Cara impor"><button type="button" class="on" data-imode="add">Tambah & perbarui</button><button type="button" data-imode="replace">Ganti semua menu outlet ini</button></div></div>
        <p class="hint" id="imp-hint">Menu dengan nama sama diperbarui harganya, menu lain tetap ada.</p>
        <div id="imp-prev">${prev()}</div>`,
      footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok disabled>Impor menu</button>`,
      onMount(m, api) {
        const ok = m.querySelector('[data-ok]');
        const draw = () => {
          m.querySelector('#imp-prev').innerHTML = prev();
          const d = getDb(), n = count(), ch = rows.filter(usable).filter((r) => !['same', 'skip'].includes(impKind(d, r))).length;
          ok.disabled = !n || (mode === 'add' && !ch);
          ok.textContent = !n ? 'Impor menu' : mode === 'replace' || ch === n ? `Impor ${n} menu` : ch ? `Simpan ${ch} perubahan` : 'Tidak ada perubahan';
        };
        let t;
        const take = (text) => { const d = getDb(); rows = parseMenuText(text).map((r) => { const outs = r.outletText ? resolveOutlets(d, r.outletText) : null; return { ...r, ...(outs ? { outlets: outs } : {}), on: r.inactive || r.price > 0 || !!r.soldOut }; }); draw(); };
        m.querySelector('#imp-t').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => take(e.target.value), 200); });
        const fi = m.querySelector('#imp-file');
        m.querySelector('[data-ifile]').onclick = () => fi.click();
        m.querySelector('[data-iexport]').onclick = () => exportMenusXlsx();
        fi.onchange = async () => {
          const f = fi.files[0]; if (!f) return;
          try {
            const tbl = await readTable(f);
            if (!tbl.length) return toast('File kosong', 'warn');
            const tsv = rowsToTsv(tbl);
            m.querySelector('#imp-t').value = tsv; take(tsv);
            m.querySelector('#imp-fname').textContent = `${f.name} · ${tbl.length - 1} baris`;
          } catch (e) { toast(e.message, 'err', 7000); }
          fi.value = '';
        };
        m.querySelector('#imp-out').onchange = (e) => { outlet = e.target.value; };
        m.addEventListener('change', (e) => {
          if (e.target.dataset.ion !== undefined) { rows[+e.target.dataset.ion].on = e.target.checked; draw(); }
          if (e.target.dataset.ist !== undefined) { rows[+e.target.dataset.ist].station = e.target.value; rows[+e.target.dataset.ist].stationSet = true; }
        });
        m.addEventListener('click', (e) => {
          const b = e.target.closest('[data-imode]'); if (!b) return;
          mode = b.dataset.imode;
          m.querySelectorAll('[data-imode]').forEach((x) => x.classList.toggle('on', x === b));
          m.querySelector('#imp-hint').textContent = mode === 'replace' ? 'Menu lain di outlet ini dinonaktifkan (tidak dihapus), jadi riwayat penjualan dan laporan tetap utuh. Gambar menu yang namanya sama tetap dipakai.' : 'Menu dengan nama sama diperbarui harganya, menu lain tetap ada.'; draw();
        });
        ok.onclick = async () => {
          const list = rows.filter(usable);
          if (mode === 'replace' && !(await confirmBox('Ganti semua menu?', `${list.length} menu akan aktif di ${D.loc(getDb(), outlet).name}. Menu lain di outlet ini dinonaktifkan.`, 'Ganti menu'))) return;
          // Hitung hasil impor di salinan data, lalu kirim kategori & menu yang berubah ke database sekaligus
          const d0 = getDb();
          const copy = { cats: JSON.parse(JSON.stringify(d0.cats)), menus: JSON.parse(JSON.stringify(d0.menus)) };
          const r = applyMenuImport(copy, list, { mode, outlet, uid });
          const orig = new Map(d0.menus.map((x) => [x.id, JSON.stringify(x)]));
          const changed = copy.menus.filter((x) => orig.get(x.id) !== JSON.stringify(x)).map((x) => ({ id: x.id, name: x.name, category_id: x.cat, price: x.price, station: x.station,
            prep_min: x.prep || 0, active: x.active, sold_out: !!x.soldOut, description: x.desc || '', tags: x.tags || [], outlets: x.outlets }));
          ok.disabled = true; ok.textContent = 'Menyimpan…';
          try {
            await API.catalogSave({ categories: copy.cats.map((c) => ({ id: c.id, name: c.name, color: c.color || 'slate', station: c.station || 'dapur' })), menus: changed });
            await C.refresh('menus');
          } catch (e) { ok.disabled = false; ok.textContent = 'Impor menu'; return toast(e.message, 'err', 6000); }
          api.close();
          toast(`${r.added} menu baru, ${r.updated} diperbarui${r.off ? `, ${r.off} dinonaktifkan` : ''}. Lengkapi resep & gambarnya.`, 'ok', 5000);
          rerender();
        };
      } });
  },
  async menuImg(el) {
    const file = await pickImage();
    if (file) await setMenuImage(el.dataset.id, file);
  },
  menuEdit(el) {
    const db = getDb(), m = D.menu(db, el.dataset.id);
    if (m.pkg) {
      return openModal({ title: m.name, size: 'md', body: `${imageBlock(m.id)}<p class="muted">Paket terdiri dari menu berikut. HPP paket = jumlah HPP komponennya.</p><ul class="list">${m.pkg.map((p) => `<li><span>${p.q}× ${esc(D.menu(db, p.m).name)}</span><span>${rp(p.q * D.menuHpp(db, p.m))}</span></li>`).join('')}</ul>
        <div class="grid2 head"><label class="fld"><span>Harga paket</span><input name="price" type="number" value="${m.price}"></label><label class="switch"><input type="checkbox" name="active" ${m.active ? 'checked' : ''}><span>Aktif dijual</span></label></div><label class="fld"><span>Deskripsi</span><textarea name="desc" rows="2" class="inp">${esc(m.desc || '')}</textarea></label>`,
        footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Simpan</button>`,
        onMount(mm, api) { bindImageBlock(mm); mm.querySelector('[data-ok]').onclick = async () => { const f = formData(mm); try { await API.menuSave({ id: m.id, price: Number(f.price) || m.price, active: !!f.active, description: f.desc.trim() }); await C.refresh('menus'); } catch (e) { return toast(e.message, 'err'); } api.close(); toast('Paket disimpan'); rerender(); }; } });
    }
    const head = () => `${imageBlock(m.id)}<div class="grid3 head"><label class="fld"><span>Nama menu</span><input name="name" value="${esc(m.name)}"></label><label class="fld"><span>Harga jual</span><input name="price" type="number" value="${m.price}"></label>
      <label class="fld"><span>Stasiun</span><select name="station">${Object.entries(D.STATION_LABEL).map(([k, v]) => `<option value="${k}" ${m.station === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="fld"><span>Kategori</span><select name="cat">${db.cats.map((c) => `<option value="${c.id}" ${m.cat === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label class="fld"><span>Target waktu masak (menit)</span><input name="prep" type="number" value="${m.prep || 0}"></label>
      <div class="sw-col"><label class="switch"><input type="checkbox" name="active" ${m.active ? 'checked' : ''}><span>Aktif dijual</span></label><label class="switch"><input type="checkbox" name="soldOut" ${m.soldOut ? 'checked' : ''}><span>Habis (sold out) hari ini</span></label></div>
      <label class="fld span3"><span>Deskripsi (tampil di halaman pesan pelanggan)</span><textarea name="desc" rows="2" class="inp">${esc(m.desc || '')}</textarea></label></div>`;
    bomEditor({ title: `Resep ${m.name}`, comps: m.bom, extraHead: head, isMenu: true, onSave(rows, h) {
      if (!h.soldOut && !(Number(h.price) > 0)) { toast('Isi harga jual dulu sebelum menu dibuka kembali', 'warn'); return false; }
      return API.menuSave({ id: m.id, name: h.name || m.name, price: Number(h.price) >= 0 && h.price !== '' ? Number(h.price) : m.price, station: h.station, category_id: h.cat,
        prep_min: Number(h.prep) || 0, active: !!h.active, sold_out: !!h.soldOut, ...(h.desc !== undefined ? { description: h.desc.trim() } : {}), bom: rows.map((r) => ({ item: r.i, qty: r.q })) })
        .then(() => C.refresh('menus')).then(() => toast('Resep disimpan. HPP menu diperbarui.'));
    } });
  },
  semiEdit(el) {
    const db = getDb(), s = D.item(db, el.dataset.id);
    const head = `<div class="grid2 head"><label class="fld"><span>Nama</span><input name="name" value="${esc(s.name)}"></label><label class="fld"><span>Hasil per batch (${esc(s.unit)})</span><input name="yield" type="number" step="0.1" value="${s.yield}"></label></div>`;
    bomEditor({ title: `Resep ${s.name}`, comps: s.bom, extraHead: head, yieldInfo: `per batch (${fmtQ(s.yield, s.unit)})`, onSave(rows, h) {
      if (rows.some((r) => r.i === s.id)) { toast('Bahan tidak boleh berisi dirinya sendiri', 'err'); return false; }
      return API.itemSave({ id: s.id, name: h.name || s.name, yield_qty: Number(h.yield) || s.yield, bom: rows.map((r) => ({ item: r.i, qty: r.q })) })
        .then(() => C.refresh('items')).then(() => toast('Resep bahan setengah jadi disimpan'));
    } });
  },
  menuNew(el) { openMenuForm({ cat: el?.dataset?.cat }); },
  rsCat(el) { ui.rsCat = el.dataset.v; rerender(); },
  rsOff(el) { ui.rsOff = el.checked; rerender(); },
  catManage() { openCatManager(); },
  prLoc(el) { ui.prLoc = el.value; rerender(); },
  async autoProd(el) { await API.saveSettings({ autoProduce: el.checked }); await C.refresh('settings'); toast(el.checked ? 'Produksi otomatis aktif' : 'Produksi otomatis dimatikan'); },
  produce(el, e, ctx) {
    const db = getDb(), s = D.item(db, el.dataset.id), L = ui.prLoc;
    let n = Number(el.dataset.n) || 1;
    const draw = () => {
      const f = (n * s.yield) / s.yield;
      return `<p>Hasil: <b>${fmtQ(n * s.yield, s.unit)}</b> ${esc(s.name)} di ${esc(D.loc(db, L).name)}</p>
        <label class="fld"><span>Jumlah batch</span><input type="number" min="1" id="pr-n" value="${n}"></label>
        <table class="tbl"><thead><tr><th>Bahan dipakai</th><th class="r">Butuh</th><th class="r">Tersedia</th></tr></thead><tbody>${s.bom.map((b) => { const it = D.item(db, b.i), have = db.stock[L]?.[b.i]?.q || 0, need = b.q * f; return `<tr><td>${esc(it.name)}${it.type === 'semi' ? ' <span class="badge b-info">setengah jadi</span>' : ''}</td><td class="r">${fmtQ(need, it.unit)}</td><td class="r ${have < need ? 'neg' : ''}">${fmtQ(have, it.unit)}</td></tr>`; }).join('')}</tbody></table>
        <p class="hint">Bahan setengah jadi yang kurang akan diproduksi otomatis dari bahan bakunya bila produksi otomatis aktif.</p>`;
    };
    openModal({ title: `Produksi ${s.name}`, size: 'md', body: draw(), footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Produksi sekarang</button>`,
      onMount(m, api) {
        m.addEventListener('change', (ev) => { if (ev.target.id === 'pr-n') { n = Math.max(1, Number(ev.target.value) || 1); api.set(draw()); } });
        m.querySelector('[data-ok]').onclick = async () => { try { await API.produce(L, s.id, n); await C.refresh('stock', 'productions', 'moves', 'journals'); } catch (e) { return toast(e.message, 'err'); } api.close(); toast(`${fmtQ(n * s.yield, s.unit)} ${s.name} diproduksi`); rerender(); };
      } });
  },
  stLoc(el) { ui.stLoc = el.dataset.v; rerender(); },
  stF(el) { ui.stF = el.dataset.v; rerender(); },
  stCsv(el, e, ctx) {
    const db = ctx.db, L = ui.stLoc;
    downloadCSV(`stok-${L}-${dayKey()}.csv`, [['Bahan', 'Jenis', 'Satuan', 'Stok', 'Minimum', 'HPP rata-rata', 'Nilai'], ...Object.entries(db.stock[L] || {}).map(([i, s]) => { const it = D.item(db, i); return [it.name, TYPE[it.type], it.unit, s.q, s.min, Math.round(s.c), Math.round(Math.max(0, s.q) * s.c)]; })]);
  },
  stCard(el, e, ctx) {
    const db = ctx.db, L = ui.stLoc, it = D.item(db, el.dataset.id), s = D.slot(db, L, it.id);
    const mv = [];
    openModal({ title: `Kartu stok ${it.name}`, size: 'lg', body: `<div class="row sb wrap"><span>Stok <b>${fmtQ(s.q, it.unit)}</b> di ${esc(D.loc(db, L).name)}, HPP rata-rata ${rp(s.c)}</span><label class="fld inline"><span>Stok minimum</span><input name="min" type="number" step="0.1" value="${s.min}" class="inp-num"></label></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Waktu</th><th>Jenis</th><th>Referensi</th><th class="r">Jumlah</th><th class="r">Harga/unit</th></tr></thead><tbody data-moves>${mv.map((m) => `<tr><td>${fmtDT(m.t)}</td><td>${MOVE[m.type] || m.type}</td><td>${esc(m.ref || '')}</td><td class="r ${m.q < 0 ? 'neg' : 'pos'}">${m.q > 0 ? '+' : ''}${num(m.q, 3)}</td><td class="r">${rp(m.c)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Memuat kartu stok…</td></tr>'}</tbody></table></div>`,
      footer: `<button class="btn" data-close>Tutup</button><button class="btn btn-pri" data-ok>Simpan minimum</button>`,
      onMount(m, api) {
        C.loadItemMoves(L, it.id).then((rows) => {
          const tb = m.querySelector('[data-moves]'); if (!tb) return;
          tb.innerHTML = rows.slice().reverse().map((x) => `<tr><td>${fmtDT(x.t)}</td><td>${MOVE[x.type] || x.type}</td><td>${esc(x.ref || '')}</td><td class="r ${x.q < 0 ? 'neg' : 'pos'}">${x.q > 0 ? '+' : ''}${num(x.q, 3)}</td><td class="r">${rp(x.c)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Belum ada pergerakan stok untuk bahan ini.</td></tr>';
        }).catch((e) => toast(e.message, 'err'));
        m.querySelector('[data-ok]').onclick = async () => { const v = Number(m.querySelector('[name=min]').value) || 0; try { await API.stockSetMin(L, it.id, v); await C.refresh('stock'); } catch (e) { return toast(e.message, 'err'); } api.close(); toast('Stok minimum disimpan'); rerender(); };
      } });
  },
  tfNew(el, e, ctx) {
    const db = getDb();
    let from = 'L1', to = 'L2', rows = [{ i: 'i_pkambing', q: 2 }];
    const draw = () => {
      const fe = D.entityOf(db, from), te = D.entityOf(db, to);
      const stockItems = Object.keys(db.stock[from] || {}).map((i) => D.item(db, i)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
      return `<div class="grid2"><label class="fld"><span>Dari</span><select data-f>${locOpts(db, from)}</select></label><label class="fld"><span>Ke</span><select data-t>${locOpts(db, to, (l) => l.id !== from)}</select></label></div>
        ${fe !== te ? `<p class="banner warn sm">${ic('triangle-alert', 16)} Lokasi beda entitas. Gunakan tab B2B antar entitas.</p>` : ''}
        <div class="bom-rows">${rows.map((r, i) => { const s = db.stock[from]?.[r.i]; return `<div class="bom-row"><select data-ri="${i}">${stockItems.map((it) => `<option value="${it.id}" ${it.id === r.i ? 'selected' : ''}>${esc(it.name)}</option>`).join('')}</select><input type="number" step="0.1" min="0" data-rq="${i}" value="${r.q}"><span class="muted sm">tersedia ${s ? fmtQ(s.q, D.item(db, r.i).unit) : '0'}</span><button class="btn-icon sm" data-rx="${i}">${ic('x', 15)}</button></div>`; }).join('')}</div>
        <button class="btn btn-sm" data-radd>${ic('plus', 14)} Tambah barang</button>`;
    };
    openModal({ title: 'Mutasi stok antar lokasi', size: 'md', body: draw(), footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Kirim</button>`,
      onMount(m, api) {
        m.addEventListener('change', (ev) => { const t = ev.target; if (t.matches('[data-f]')) { from = t.value; if (to === from) to = db.locations.find((l) => l.id !== from).id; rows = []; } if (t.matches('[data-t]')) to = t.value; if (t.dataset.ri !== undefined) rows[+t.dataset.ri].i = t.value; if (t.dataset.rq !== undefined) rows[+t.dataset.rq].q = Number(t.value); api.set(draw()); });
        m.addEventListener('click', (ev) => { if (ev.target.closest('[data-radd]')) { const first = Object.keys(db.stock[from] || {})[0]; rows.push({ i: first, q: 1 }); api.set(draw()); } const x = ev.target.closest('[data-rx]'); if (x) { rows.splice(+x.dataset.rx, 1); api.set(draw()); } });
        m.querySelector('[data-ok]').onclick = async () => {
          if (D.entityOf(db, from) !== D.entityOf(db, to)) return toast('Beda entitas. Gunakan B2B antar entitas.', 'warn');
          const items = rows.filter((r) => r.i && r.q > 0);
          if (!items.length) return toast('Tambahkan barang', 'warn');
          try { await API.transferSend(from, to, items.map((r) => ({ item: r.i, qty: r.q }))); await C.refresh('transfers', 'stock', 'moves'); } catch (e) { return toast(e.message, 'err'); }
          api.close(); toast('Barang dikirim. Lokasi tujuan perlu menekan Terima.'); rerender();
        };
      } });
  },
  tfRecv(el, e, ctx) {
    const db = getDb(), t = db.transfers.find((x) => x.id === el.dataset.id);
    openModal({ title: `Terima ${t.no}`, size: 'md', body: `<p class="muted">Isi jumlah yang benar-benar diterima. Selisih tercatat sebagai kehilangan dan ditandai di laporan fraud.</p><table class="tbl"><thead><tr><th>Barang</th><th class="r">Dikirim</th><th class="r">Diterima</th></tr></thead><tbody>${t.items.map((x, i) => `<tr><td>${esc(D.item(db, x.i).name)}</td><td class="r">${fmtQ(x.q, D.item(db, x.i).unit)}</td><td class="r"><input class="inp inp-num" type="number" step="0.1" data-rq="${i}" value="${x.q}"></td></tr>`).join('')}</tbody></table>`,
      footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Terima barang</button>`,
      onMount(m, api) { m.querySelector('[data-ok]').onclick = async () => {
        const rq = [...m.querySelectorAll('[data-rq]')].map((i) => Math.max(0, Number(i.value) || 0));
        const recv = Object.fromEntries(t.items.map((x, i) => [x.i, Math.min(rq[i], x.q)]));
        try { await API.transferReceive(t.id, recv); await C.refresh('transfers', 'stock', 'moves', 'flags', 'journals'); } catch (e) { return toast(e.message, 'err'); }
        api.close(); toast('Mutasi diterima'); rerender();
      }; } });
  },
  opLoc(el) { ui.opLoc = el.value; rerender(); },
  opStart() { ui.op = { loc: ui.opLoc, vals: {} }; rerender(); },
  async opCancel() { if (Object.keys(ui.op.vals).length && !(await confirmBox('Batalkan stock opname?', 'Hitungan yang sudah diisi akan hilang.', 'Batalkan', true))) return; ui.op = null; rerender(); },
  async opPost(el, e, ctx) {
    const vals = Object.entries(ui.op.vals).filter(([, v]) => v !== '');
    if (!vals.length) return toast('Isi minimal satu hitungan fisik', 'warn');
    if (!(await confirmBox('Posting stock opname?', `${vals.length} bahan akan disesuaikan dan selisihnya dijurnal ke akun Selisih & waste persediaan.`, 'Posting'))) return;
    const L = ui.op.loc;
    const res = await API.opnamePost(L, Object.fromEntries(vals.map(([i, v]) => [i, Number(v)])));
    res.total = Number(res.total) || 0;
    await C.refresh('opnames', 'stock', 'moves', 'journals', 'flags');
    ui.op = null; toast(`${res.no} diposting, selisih ${rp(res.total)}`); rerender();
  },
};
