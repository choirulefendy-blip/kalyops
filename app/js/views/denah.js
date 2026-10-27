// Denah meja live — untuk service/pramusaji: status tiap meja di denah Kaly Eatery,
// pesanan yang siap diantar, reservasi yang segera datang, dan mode atur meja (owner).
import { local, getDb } from '../store.js';
import * as API from '../api.js';
import * as C from '../cloud.js';
import { $, esc, ic, rp, toast, openModal, formData, confirmBox, clamp, fmtTime, dayKey, num, sum } from '../lib.js';
import * as D from '../domain.js';
import { rerender, go, can } from '../app.js';
import { openFromDenah } from './pos.js';
import { moveDialog, clearTable, bookNowDialog } from './table-actions.js';

const IMG = { src: 'assets/denah.png', w: 2174, h: 1710 };
const AR = IMG.w / IMG.h;
const MAXW = 4200;
const ui = { sel: null, edit: false, w: null, sx: null, sy: null, filter: 'all', area: 'all' };
try { const v = JSON.parse(localStorage.getItem('kaly.denah') || 'null'); if (v) Object.assign(ui, { w: v.w, sx: v.sx, sy: v.sy }); } catch {}
const saveView = () => { try { localStorage.setItem('kaly.denah', JSON.stringify({ w: ui.w, sx: ui.sx, sy: ui.sy })); } catch {} };

const LABEL = { free: 'Kosong', busy: 'Terisi', ready: 'Siap diantar', paid: 'Sudah bayar', res: 'Reservasi' };
const LINE_ST = { new: ['Antre', 'b-info'], cook: ['Dimasak', 'b-warn'], ready: ['Siap antar', 'b-gold'], served: ['Diantar', 'b-mute'] };

// ---------- Status meja ----------
// Meja terisi = bill terbuka, atau pesanan yang sudah dibayar di muka (QR/online) tapi makanannya belum selesai diantar.
function tableOrders(db, L) {
  const t0 = new Date().setHours(0, 0, 0, 0);
  return db.orders.filter((o) => o.loc === L && o.table && o.released !== false && (o.status === 'open' || (o.status === 'paid' && o.created >= t0 && ['new', 'cook', 'ready'].includes(D.kitchenState(o)))));
}
function upcomingRes(db, tableId, now) {
  return db.reservations.find((r) => D.resTables(r).includes(tableId) && D.RES_ACTIVE.includes(r.status) && D.resStart(r) - now < 120 * 60000 && D.resStart(r) - now > -(r.status === 'datang' ? 180 : 45) * 60000);
}
function states(db, L) {
  const now = Date.now();
  const os = tableOrders(db, L);
  const map = {};
  for (const t of db.tables.filter((x) => x.loc === L)) {
    const o = os.find((x) => x.table === t.id || x.merged?.includes(t.id));
    if (o) {
      const K = D.kitchenLines(o);
      const ready = K.filter((l) => l.s === 'ready');
      map[t.id] = { k: ready.length ? 'ready' : 'busy', o, ready, total: o.bill?.total ?? D.bill(db, o).total, paid: o.status === 'paid' };
    } else if (t.hold) {
      // Bill sudah dibayar, tapi meja belum dikosongkan service (tamu mungkin masih duduk / meja belum dibersihkan)
      map[t.id] = { k: 'paid', hold: t.hold, ho: D.order(db, t.hold.order) };
    } else {
      const r = upcomingRes(db, t.id, now);
      map[t.id] = r ? { k: 'res', r } : { k: 'free' };
    }
  }
  return map;
}

// ---------- Tampilan ----------
function pin(t, s) {
  const sub = s.o ? `<small data-since="${s.o.created}" data-fmt="min"></small>` : s.k === 'paid' ? `<small>lunas</small>` : s.k === 'res' ? `<small>${s.r.status === 'datang' ? 'datang' : esc(s.r.time)}</small>` : `<small>${t.seats} kursi</small>`;
  const dim = ui.filter !== 'all' && ui.filter !== s.k;
  const what = s.o ? `${LABEL[s.k]}, ${s.o.no}` : s.k === 'paid' ? 'sudah dibayar, belum dikosongkan' : s.k === 'res' ? `reservasi ${s.r.name} pukul ${s.r.time}` : 'kosong';
  return `<button class="dn-pin st-${s.k}${t.gazebo ? ' gz' : ''}${ui.sel === t.id ? ' sel' : ''}${dim ? ' dim' : ''}" style="left:${t.x ?? 50}%;top:${t.y ?? 50}%" data-a="pick" data-id="${esc(t.id)}" aria-label="Meja ${esc(t.id)}${t.gazebo ? ' (gazebo)' : ''}, ${esc(what)}"><b>${esc(t.id)}</b>${sub}${s.k === 'ready' ? `<i class="dn-dot">${s.ready.length}</i>` : ''}</button>`;
}
function stats(db, S) {
  const c = { free: 0, busy: 0, ready: 0, paid: 0, res: 0 };
  Object.values(S).forEach((s) => c[s.k]++);
  return `${[['all', 'Semua', db.tables.filter((t) => t.loc === 'L1').length], ['free', 'Kosong', c.free], ['busy', 'Terisi', c.busy], ['ready', 'Siap diantar', c.ready], ['paid', 'Sudah bayar', c.paid], ['res', 'Reservasi ≤ 2 jam', c.res]]
    .map(([k, l, n]) => `<button class="dn-stat ${k !== 'all' ? 'st-' + k : ''} ${ui.filter === k ? 'on' : ''}" data-a="filter" data-v="${k}"><i></i>${l}<b>${n}</b></button>`).join('')}`;
}
function lineRows(o) {
  const ls = o.lines.filter((l) => l.s !== 'void' && l.s !== 'draft' && !l.par);
  if (!ls.length) return `<p class="muted sm">Belum ada item yang dikirim ke dapur.</p>`;
  return `<ul class="dn-lines">${ls.map((l) => {
    const comps = o.lines.filter((c) => c.par === l.id && c.s !== 'void');
    const s = comps.length ? (comps.every((c) => c.s === 'served') ? 'served' : comps.some((c) => c.s === 'ready') ? 'ready' : comps.some((c) => c.s === 'cook') ? 'cook' : 'new') : l.st === 'none' ? 'served' : l.s;
    const [lab, cls] = LINE_ST[s] || ['', 'b-mute'];
    return `<li class="${s === 'ready' ? 'hl' : ''}"><span><span><b>${l.q}×</b> ${esc(l.n)}</span>${l.note ? `<small>${esc(l.note)}</small>` : ''}</span><span class="badge ${cls}">${lab}</span></li>`;
  }).join('')}</ul>`;
}
function detail(db, t, s, ctx) {
  const pos = can('pos') && ctx.user.role !== 'owner';  // POS Manajer/Owner hanya untuk kelola menu
  const owner = ctx.user.role === 'owner';
  const head = `<div class="dn-dh"><div><h3>Meja ${esc(t.id)} ${t.gazebo ? '<span class="badge b-gold">Gazebo</span>' : ''}</h3><small class="muted">${esc(t.area)} · ${t.seats} kursi</small></div><button class="btn-icon" data-a="unpick" aria-label="Tutup detail">${ic('x')}</button></div>`;
  let body = '';
  if (s.o) {
    const o = s.o;
    const mem = o.mem && db.members.find((m) => m.id === o.mem);
    body = `<div class="dn-o"><div class="row sb"><b class="dn-no">${esc(o.no)}</b><span class="badge ${s.k === 'ready' ? 'b-gold' : 'b-ok'}">${LABEL[s.k]}</span></div>
      <dl class="kv sm"><dt>Tamu</dt><dd>${esc(mem?.name || o.cust?.name || 'Walk-in')}${mem ? ' <span class="badge b-ok">Member</span>' : ''}</dd>
      <dt>Duduk</dt><dd>${fmtTime(o.created)} · <span data-since="${o.created}" data-fmt="min"></span></dd>
      ${o.merged?.length ? `<dt>Gabung</dt><dd>${esc([o.table, ...o.merged].join(' + '))}</dd>` : ''}
      <dt>Total</dt><dd><b>${rp(s.total)}</b> ${s.paid ? '<span class="badge b-ok">Lunas</span>' : ''}</dd>
      <dt>Lewat</dt><dd>${o.ch === 'qr' ? 'QR meja' : o.ch === 'web' ? 'Online' : 'Kasir'}</dd></dl>
      ${lineRows(o)}</div>
      ${s.ready.length ? `<h4 class="sec-t">${ic('hand-platter', 16)} Siap diantar</h4><ul class="dn-ready-items">${s.ready.map((l) => `<li><span>${num(l.q)}× ${esc(l.n)}${l.note ? ` <small class="muted">${esc(l.note)}</small>` : ''}</span><button class="btn btn-sm btn-pri" data-a="serveLine" data-o="${o.id}" data-l="${l.id}">${ic('check', 15)} Diantar</button></li>`).join('')}</ul>` : ''}
      <div class="dn-act">${s.ready.length > 1 ? `<button class="btn btn-block" data-a="serve" data-o="${o.id}">${ic('hand-platter', 18)} Semua ${s.ready.length} item sudah diantar</button>` : ''}
      ${pos && o.status === 'open' ? `<button class="btn btn-block" data-a="openPos" data-o="${o.id}">${ic('store', 18)} Buka bill di POS</button>` : ''}
      <button class="btn btn-block btn-move" data-a="moveTable" data-id="${esc(t.id)}">${ic('arrow-left-right', 18)} Pindah ke meja lain</button></div>`;
  } else if (s.k === 'paid') {
    const o = s.ho;
    body = `<div class="dn-o"><div class="row sb"><b class="dn-no">${esc(o?.no || 'Bill')}</b><span class="badge b-ok">Sudah bayar</span></div>
      <dl class="kv sm"><dt>Dibayar</dt><dd>${fmtTime(s.hold.at)} · <span data-since="${s.hold.at}" data-fmt="min"></span> lalu</dd>${o ? `<dt>Total</dt><dd><b>${rp(o.total ?? o.bill?.total ?? 0)}</b></dd><dt>Tamu</dt><dd>${esc(o.cust?.name || 'Walk-in')}</dd>` : ''}</dl>
      <p class="muted sm">Tamu mungkin masih duduk. Tekan <b>Kosongkan meja</b> setelah tamu pergi dan meja sudah dibersihkan.</p></div>
      <div class="dn-act"><button class="btn btn-pri btn-block" data-a="clearTable" data-id="${esc(t.id)}">${ic('check', 18)} Kosongkan meja</button>
      <button class="btn btn-block btn-move" data-a="moveTable" data-id="${esc(t.id)}">${ic('arrow-left-right', 18)} Pindah ke meja lain</button>
      ${pos ? `<button class="btn btn-block" data-a="openPos" data-t="${esc(t.id)}">${ic('plus', 18)} Tamu pesan lagi: buka bill baru</button>` : ''}</div>`;
  } else if (s.k === 'res') {
    const r = s.r;
    body = `<div class="dn-o"><div class="row sb"><b class="dn-no">${esc(r.time)}</b><span class="badge b-info">${r.status === 'datang' ? 'Tamu datang' : esc(r.status)}</span></div>
      <dl class="kv sm"><dt>Nama</dt><dd>${esc(r.name)}</dd><dt>Tamu</dt><dd>${r.pax} orang</dd><dt>Meja</dt><dd>${esc(D.resTableLabel(r))}</dd><dt>No. HP</dt><dd>${esc(r.phone)}</dd>${r.note ? `<dt>Catatan</dt><dd>${esc(r.note)}</dd>` : ''}<dt>Kode</dt><dd>${esc(r.code)}</dd></dl></div>
      <div class="dn-act">${pos ? `<button class="btn btn-pri btn-block" data-a="checkin" data-r="${r.id}" data-pos="1">${ic('concierge-bell', 18)} Check-in & buka bill</button>` : ''}
      ${r.status !== 'datang' ? `<button class="btn btn-block" data-a="checkin" data-r="${r.id}">${ic('check', 18)} Tandai tamu datang</button>` : ''}</div>
      ${r.status === 'datang' && !pos ? `<p class="hint">${ic('concierge-bell', 14)} Tamu sudah duduk. Kasir sudah dikabari dan membuka bill meja ini di Kaly POS.</p>` : r.status !== 'datang' && !pos ? `<p class="hint">Setelah ditandai datang, kasir langsung dikabari untuk membuat bill.</p>` : ''}`;
  } else {
    const later = db.reservations.filter((r) => D.resTables(r).includes(t.id) && D.RES_ACTIVE.includes(r.status) && r.date === dayKey() && D.resStart(r) > Date.now()).sort((a, b) => D.resStart(a) - D.resStart(b)).slice(0, 3);
    body = `<p class="muted">Meja kosong dan siap dipakai.</p>${later.length ? `<p class="sm">Reservasi nanti: ${later.map((r) => `${esc(r.time)} ${esc(r.name)}`).join(', ')}</p>` : ''}
      <div class="dn-act">${pos ? `<button class="btn btn-pri btn-block" data-a="openPos" data-t="${esc(t.id)}">${ic('plus', 18)} Buka bill di meja ini</button>` : ctx.user.role === 'service' ? `<button class="btn btn-pri btn-block" data-a="bookNow" data-t="${esc(t.id)}">${ic('concierge-bell', 18)} Book meja ini (tamu datang)</button><p class="hint">Kasir langsung dikabari untuk membuat bill.</p>` : ''}</div>`;
  }
  return head + body + (owner ? `<button class="btn btn-ghost btn-sm dn-edit-one" data-a="editTable" data-id="${esc(t.id)}">${ic('square-pen', 15)} Atur meja ini</button>` : '');
}
function overview(db, S) {
  const ready = Object.entries(S).filter(([, s]) => s.k === 'ready').sort((a, b) => Math.min(...a[1].ready.map((l) => l.tr || 0)) - Math.min(...b[1].ready.map((l) => l.tr || 0)));
  const now = Date.now();
  const res = db.reservations.filter((r) => D.RES_ACTIVE.includes(r.status) && r.status !== 'datang' && D.resStart(r) - now < 120 * 60000 && D.resStart(r) - now > -45 * 60000).sort((a, b) => D.resStart(a) - D.resStart(b));
  const long = Object.entries(S).filter(([, s]) => s.o).sort((a, b) => a[1].o.created - b[1].o.created).slice(0, 5);
  const paid = Object.entries(S).filter(([, s]) => s.k === 'paid').sort((a, b) => a[1].hold.at - b[1].hold.at);
  const sec = (title, n, inner, empty) => `<h4 class="sec-t">${title} ${n ? `<span class="muted">${n}</span>` : ''}</h4>${n ? inner : `<p class="empty sm">${empty}</p>`}`;
  return `<div class="dn-dh"><div><h3>Perlu perhatian</h3><small class="muted">Ketuk meja di denah untuk lihat detail</small></div></div>
    ${sec('Siap diantar', sum(ready, ([, s]) => s.ready.length), `<div class="olist">${ready.map(([id, s]) => `<div class="ol static ready-row ri"><button class="dn-link" data-a="pick" data-id="${esc(id)}"><b>Meja ${esc(id)}</b><small>${esc(s.o.no)} · siap <span data-since="${Math.min(...s.ready.map((l) => l.tr || now))}" data-fmt="min"></span></small></button>
      <ul class="ri-list">${s.ready.map((l) => `<li><span>${num(l.q)}× ${esc(l.n)}</span><button class="btn btn-sm btn-pri" data-a="serveLine" data-o="${s.o.id}" data-l="${l.id}" aria-label="${esc(l.n)} sudah diantar">${ic('check', 15)} Diantar</button></li>`).join('')}</ul></div>`).join('')}</div>`, 'Belum ada item yang siap. Meja berwarna oranye begitu satu item selesai di dapur.')}
    ${sec('Sudah bayar, belum dikosongkan', paid.length, `<div class="olist">${paid.map(([id, s]) => `<div class="ol static paid-row"><button class="dn-link" data-a="pick" data-id="${esc(id)}"><b>Meja ${esc(id)}</b><small>${esc(s.ho?.no || '')} · dibayar <span data-since="${s.hold.at}" data-fmt="min"></span> lalu</small></button><button class="btn btn-sm" data-a="clearTable" data-id="${esc(id)}">${ic('check', 16)} Kosongkan</button></div>`).join('')}</div>`, 'Meja yang sudah dibayar tetap ditandai di sini sampai dikosongkan.')}
    ${sec('Reservasi 2 jam ke depan', res.length, `<div class="olist">${res.map((r) => `<button class="ol" data-a="pick" data-id="${esc(r.table || '')}"><span><b>${esc(r.time)} · ${esc(D.resTableLabel(r))}</b><small>${esc(r.name)}, ${r.pax} orang${r.note ? ' · ' + esc(r.note) : ''}</small></span><span class="badge b-info">${esc(r.status)}</span></button>`).join('')}</div>`, 'Tidak ada reservasi dalam 2 jam ke depan.')}
    ${sec('Duduk paling lama', long.length, `<div class="olist">${long.map(([id, s]) => `<button class="ol" data-a="pick" data-id="${esc(id)}"><span><b>Meja ${esc(id)}</b><small>${esc(s.o.no)} · ${rp(s.total)}</small></span><span class="muted sm" data-since="${s.o.created}" data-fmt="min"></span></button>`).join('')}</div>`, 'Belum ada meja terisi.')}`;
}
function side(db, S, ctx) {
  const t = ui.sel && db.tables.find((x) => x.id === ui.sel);
  if (!t) ui.sel = null;
  return t ? detail(db, t, S[t.id] || { k: 'free' }, ctx) : overview(db, S);
}
function editBar() {
  return `<div class="dn-editbar">${ic('move', 18)}<span><b>Mode atur meja.</b> Seret meja untuk memindahkan posisinya di denah. Ketuk meja untuk ubah kapasitas, area, atau gazebo.</span>
    <button class="btn btn-sm" data-a="addTable">${ic('plus', 16)} Tambah meja</button><button class="btn btn-sm btn-pri" data-a="editMode">${ic('check', 16)} Selesai</button></div>`;
}

// ---------- Ukuran & posisi peta ----------
const wrapEl = (root) => $('#dn-wrap', root || document);
const fitW = (wrap) => Math.min(wrap.clientWidth, wrap.clientHeight * AR);
function setW(root, w) {
  const wrap = wrapEl(root); if (!wrap) return;
  ui.w = clamp(Math.round(w), Math.floor(fitW(wrap)), MAXW);
  $('.dn-map', wrap).style.width = ui.w + 'px';
}
function zoomAt(root, factor, cx, cy) {
  const wrap = wrapEl(root); if (!wrap) return;
  const r = wrap.getBoundingClientRect();
  const px = cx ?? r.width / 2, py = cy ?? r.height / 2;
  const old = ui.w, rx = (wrap.scrollLeft + px) / old, ry = (wrap.scrollTop + py) / (old / AR);
  setW(root, old * factor);
  wrap.scrollLeft = rx * ui.w - px; wrap.scrollTop = ry * (ui.w / AR) - py;
  remember(wrap);
}
function focusBox(root, x0, x1, y0, y1) {
  const wrap = wrapEl(root); if (!wrap) return;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  const bw = Math.max(8, x1 - x0) / 100, bh = Math.max(8, y1 - y0) / 100;
  setW(root, Math.min(W / bw, (H * AR) / bh));
  wrap.scrollLeft = ((x0 + x1) / 200) * ui.w - W / 2;
  wrap.scrollTop = ((y0 + y1) / 200) * (ui.w / AR) - H / 2;
  remember(wrap);
}
function focusArea(root, db, area) {
  const ts = db.tables.filter((t) => t.loc === 'L1' && (area === 'all' || t.area === area));
  if (!ts.length || area === 'all') { setW(root, 0); const w = wrapEl(root); w.scrollLeft = 0; w.scrollTop = 0; remember(w); return; }
  const xs = ts.map((t) => t.x ?? 50), ys = ts.map((t) => t.y ?? 50);
  focusBox(root, Math.min(...xs) - 5, Math.max(...xs) + 5, Math.min(...ys) - 6, Math.max(...ys) + 6);
}
let saveT;
function remember(wrap) { ui.sx = wrap.scrollLeft; ui.sy = wrap.scrollTop; clearTimeout(saveT); saveT = setTimeout(saveView, 250); }

// ---------- Mode atur meja ----------
function viewCenter() {
  const w = wrapEl();
  if (!w || !ui.w) return { x: 50, y: 50 };
  return { x: clamp(((w.scrollLeft + w.clientWidth / 2) / ui.w) * 100, 2, 98), y: clamp(((w.scrollTop + w.clientHeight / 2) / (ui.w / AR)) * 100, 2, 98) };
}
function tableForm(db, t, near) {
  const areas = db.areas;
  const pickA = t?.area || near;
  return `<div class="grid2">
    <label class="fld"><span>Kode meja</span><input name="id" value="${esc(t?.id || '')}" ${t ? 'readonly' : 'autofocus'} maxlength="6" placeholder="mis. PR7" style="text-transform:uppercase"></label>
    <label class="fld"><span>Kapasitas</span><div class="row"><input name="seats" type="number" min="1" max="40" value="${t?.seats || 4}" class="inp"><span class="muted sm">kursi</span></div></label>
    <label class="fld"><span>Area</span><select name="area">${areas.map((a) => `<option ${pickA === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}<option value="__new">+ Area baru…</option></select></label>
    <label class="fld" data-newarea hidden><span>Nama area baru</span><input name="newArea" placeholder="mis. Rooftop"></label>
  </div>
  <label class="switch"><input type="checkbox" name="gazebo" ${t?.gazebo ? 'checked' : ''}> Meja gazebo (ditandai bulat di denah)</label>
  ${t ? '' : '<p class="hint">Meja baru muncul di tengah layar denah. Seret ke posisinya setelah disimpan.</p>'}`;
}
function openTableEditor(ctx, id) {
  const db = getDb();
  const t = id && db.tables.find((x) => x.id === id);
  const busy = t && (tableOrders(db, 'L1').some((o) => o.table === t.id || o.merged?.includes(t.id)) || db.reservations.some((r) => D.resTables(r).includes(t.id) && D.RES_ACTIVE.includes(r.status)));
  const c = viewCenter();
  const near = !t && db.tables.filter((x) => x.x != null).sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y))[0]?.area;
  openModal({
    title: t ? `Atur meja ${t.id}` : 'Tambah meja', size: 'sm', body: tableForm(db, t, near),
    footer: `${t ? `<button class="btn btn-danger-ghost" data-del ${busy ? 'disabled title="Masih ada pesanan atau reservasi aktif di meja ini"' : ''}>${ic('trash-2', 16)} Hapus</button>` : ''}<button class="btn push" data-close>Batal</button><button class="btn btn-pri" data-ok>Simpan</button>`,
    onMount(m, api) {
      const sel = $('[name=area]', m);
      sel.onchange = () => { $('[data-newarea]', m).hidden = sel.value !== '__new'; };
      $('[data-ok]', m).onclick = async () => {
        const f = formData(m);
        const code = (f.id || '').trim().toUpperCase().replace(/\s+/g, '');
        const area = f.area === '__new' ? (f.newArea || '').trim() : f.area;
        const seats = clamp(Math.round(Number(f.seats) || 0), 1, 40);
        if (!t && !/^[A-Z0-9-]{1,6}$/.test(code)) return toast('Isi kode meja, maksimal 6 huruf/angka', 'warn');
        if (!t && getDb().tables.some((x) => x.id === code)) return toast(`Kode ${code} sudah dipakai`, 'warn');
        if (!area) return toast('Isi nama area', 'warn');
        const center = viewCenter();
        try {
          const db0 = getDb();
          if (!db0.areas.includes(area)) await API.areaEnsure(area, db0.areas.length + 1);
          if (t) await API.tableSave({ id: t.id, location_id: t.loc || 'L1', area, seats, x: t.x, y: t.y, is_gazebo: !!f.gazebo, active: true, sort: t.sort || 0 });
          else await API.tableSave({ id: code, location_id: 'L1', area, seats, x: +center.x.toFixed(2), y: +center.y.toFixed(2), is_gazebo: !!f.gazebo, active: true, sort: db0.tables.length + 1 });
          await C.refresh('tables');
        } catch (e) { return toast(e.message, 'err'); }
        api.close(); toast(t ? `Meja ${t.id} diperbarui` : `Meja ${code} ditambahkan. Seret ke posisinya.`);
        if (!t) ui.sel = code;
        rerender();
      };
      const del = $('[data-del]', m);
      if (del) del.onclick = async () => {
        if (!(await confirmBox(`Hapus meja ${t.id}?`, 'Meja hilang dari denah, POS, QR meja, dan pilihan reservasi. Riwayat transaksi lama tetap tersimpan.', 'Hapus meja', true))) return;
        try { await API.tableDelete(t.id); await C.refresh('tables'); } catch (e) { return toast(e.message, 'err'); }
        api.close(); ui.sel = null; toast(`Meja ${t.id} dihapus`); rerender();
      };
    },
  });
}

// Seret meja (mode atur) dan geser peta dengan mouse
function bindPointer(root) {
  const wrap = wrapEl(root);
  if (!wrap || wrap.dataset.bound) return;
  wrap.dataset.bound = '1';
  let drag = null;
  wrap.addEventListener('pointerdown', (e) => {
    const p = e.target.closest('.dn-pin');
    if (ui.edit && p) {
      e.preventDefault();
      drag = { kind: 'pin', el: p, id: p.dataset.id, x0: e.clientX, y0: e.clientY, moved: false };
      p.setPointerCapture(e.pointerId);
    } else if (!p && e.pointerType === 'mouse' && e.button === 0) {
      drag = { kind: 'pan', x0: e.clientX, y0: e.clientY, sl: wrap.scrollLeft, st: wrap.scrollTop, moved: false };
      wrap.classList.add('panning');
    }
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (drag.kind === 'pan') { wrap.scrollLeft = drag.sl - dx; wrap.scrollTop = drag.st - dy; return; }
    if (!drag.moved) return;
    const r = $('.dn-map', wrap).getBoundingClientRect();
    drag.x = clamp(((e.clientX - r.left) / r.width) * 100, 1, 99);
    drag.y = clamp(((e.clientY - r.top) / r.height) * 100, 1, 99);
    drag.el.style.left = drag.x + '%'; drag.el.style.top = drag.y + '%';
    drag.el.classList.add('dragging');
  });
  const end = () => {
    if (!drag) return;
    const d0 = drag; drag = null;
    wrap.classList.remove('panning');
    if (d0.kind === 'pan') { remember(wrap); return; }
    d0.el.classList.remove('dragging');
    if (d0.moved && d0.x != null) {
      const x = +d0.x.toFixed(2), y = +d0.y.toFixed(2);
      local((d) => { const t = d.tables.find((z) => z.id === d0.id); if (t) { t.x = x; t.y = y; } });
      API.tableMove(d0.id, x, y).then(() => toast(`Posisi meja ${d0.id} disimpan`)).catch((e) => { toast(e.message, 'err'); C.refresh('tables'); });
    } else openTableEditor(null, d0.id);
  };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', end);
  wrap.addEventListener('click', (e) => { if (ui.edit && e.target.closest('.dn-pin')) { e.stopPropagation(); e.preventDefault(); } }, true);
  wrap.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const r = wrap.getBoundingClientRect();
    zoomAt(root, e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  wrap.addEventListener('scroll', () => remember(wrap), { passive: true });
}

export default {
  title: () => 'Denah Meja',
  render(ctx) {
    const db = ctx.db, L = 'L1';
    // Dibuka dari notifikasi atau tautan: #/denah?t=G1 memilih meja itu
    if (ctx.q.t) { ui.sel = ctx.q.t; ui.filter = 'all'; delete ctx.q.t; try { history.replaceState(null, '', '#/denah'); } catch {} }
    const S = states(db, L);
    const ts = db.tables.filter((t) => t.loc === L);
    const owner = ctx.user.role === 'owner';
    return `<div class="dn ${ui.edit ? 'editing' : ''}">
      ${ctx.outlet !== 'L1' ? `<div class="banner">${ic('info', 18)} Denah ini milik Resto Kaly Eatery. Play Corner tidak memakai meja.</div>` : ''}
      <div class="dn-bar">
        <div class="dn-stats" role="group" aria-label="Filter status meja">${stats(db, S)}</div>
        <div class="dn-tools">
          <label class="dn-area">${ic('map-pin', 16)}<select data-a-change="area" aria-label="Lompat ke area"><option value="all">Semua area</option>${db.areas.filter((a) => ts.some((t) => t.area === a)).map((a) => `<option ${ui.area === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
          <div class="seg dn-zoom" role="group" aria-label="Perbesar denah"><button data-a="zoom" data-v="out" aria-label="Perkecil" title="Perkecil">${ic('zoom-out', 17)}</button><button data-a="zoom" data-v="fit" aria-label="Lihat seluruh denah" title="Lihat seluruh denah">${ic('maximize', 16)}</button><button data-a="zoom" data-v="in" aria-label="Perbesar" title="Perbesar">${ic('zoom-in', 17)}</button></div>
          ${owner && !ui.edit ? `<button class="btn btn-sm" data-a="editMode">${ic('move', 16)} Atur meja</button>` : ''}
        </div>
      </div>
      ${ui.edit ? editBar() : ''}
      <div class="dn-body">
        <div class="dn-stage">
          <div class="dn-wrap" id="dn-wrap"><div class="dn-map" style="width:${ui.w || 1200}px"><img src="${IMG.src}" alt="Denah Kaly Eatery" draggable="false" width="${IMG.w}" height="${IMG.h}"><div class="dn-pins">${ts.map((t) => pin(t, S[t.id])).join('')}</div></div></div>
          <div class="dn-legend"><span><i class="lg st-free"></i>Kosong</span><span><i class="lg st-busy"></i>Terisi</span><span><i class="lg st-ready"></i>Siap diantar</span><span><i class="lg st-paid"></i>Sudah bayar</span><span><i class="lg st-res"></i>Reservasi ≤ 2 jam</span><span><i class="lg gz"></i>Gazebo</span><span class="muted">Angka di bawah kode = menit sejak tamu duduk. Ctrl + scroll untuk zoom.</span></div>
        </div>
        <aside class="card dn-side" data-keep-scroll="dn-side">${side(db, S, ctx)}</aside>
      </div>
    </div>`;
  },
  refresh(root, ctx) {
    const db = ctx.db, S = states(db, 'L1');
    const pins = $('.dn-pins', root), sd = $('.dn-side', root), st = $('.dn-stats', root);
    if (!pins || !sd) return;
    pins.innerHTML = db.tables.filter((t) => t.loc === 'L1').map((t) => pin(t, S[t.id])).join('');
    const top = sd.scrollTop; sd.innerHTML = side(db, S, ctx); sd.scrollTop = top;
    st.innerHTML = stats(db, S);
  },
  after(root, ctx, first) {
    const wrap = wrapEl(root);
    if (!wrap) return;
    bindPointer(root);
    if (!ui.w) {
      // Pertama kali: perbesar ke kumpulan meja Joglo & Pelataran (paling padat), sisanya bisa digeser
      setW(root, Math.max(fitW(wrap), 1800));
      wrap.scrollLeft = 0.8 * ui.w - wrap.clientWidth / 2; wrap.scrollTop = 0.22 * (ui.w / AR) - wrap.clientHeight / 2;
      remember(wrap);
    } else {
      setW(root, ui.w);
      wrap.scrollLeft = ui.sx || 0; wrap.scrollTop = ui.sy || 0;
    }
    if (first && ui.sel) {
      const t = ctx.db.tables.find((x) => x.id === ui.sel);
      if (t) { const px = (t.x / 100) * ui.w, py = (t.y / 100) * (ui.w / AR); if (px < wrap.scrollLeft || px > wrap.scrollLeft + wrap.clientWidth || py < wrap.scrollTop || py > wrap.scrollTop + wrap.clientHeight) { wrap.scrollLeft = px - wrap.clientWidth / 2; wrap.scrollTop = py - wrap.clientHeight / 2; } }
    }
  },
  unmount() { ui._q = false; ui.edit = false; },
  actions: {
    pick(el) {
      const id = el.dataset.id;
      if (!id) return;
      ui.sel = ui.sel === id && el.classList.contains('dn-pin') ? null : id;
      rerender();
      if (ui.sel && !el.classList.contains('dn-pin')) {
        const t = getDb().tables.find((x) => x.id === id), wrap = wrapEl();
        if (t && wrap) { wrap.scrollLeft = (t.x / 100) * ui.w - wrap.clientWidth / 2; wrap.scrollTop = (t.y / 100) * (ui.w / AR) - wrap.clientHeight / 2; remember(wrap); }
      }
    },
    unpick() { ui.sel = null; rerender(); },
    filter(el) { ui.filter = el.dataset.v; rerender(); },
    area(el) { ui.area = el.value; focusArea(document, getDb(), ui.area); },
    zoom(el) {
      const v = el.dataset.v;
      if (v === 'fit') { ui.area = 'all'; focusArea(document, getDb(), 'all'); const s = $('.dn-area select'); if (s) s.value = 'all'; }
      else zoomAt(document, v === 'in' ? 1.3 : 1 / 1.3);
    },
    async serveLine(el) {
      const oid = el.dataset.o, lid = el.dataset.l;
      const o = D.order(getDb(), oid), l = o?.lines.find((x) => x.id === lid);
      local((d) => D.serveLine(d, D.order(d, oid), lid));
      try { await API.orderOp(oid, () => API.serveLine(lid)); } catch (e) { return toast(e.message, 'err'); }
      if (l) toast(`${num(l.q)}× ${l.n} sudah diantar${o.table ? ' ke meja ' + o.table : ''}`);
    },
    async serve(el) {
      const id = el.dataset.o;
      const n = local((d) => D.serveReady(d, D.order(d, id)));
      try { await API.orderOp(id, () => API.serveReady(id)); await C.refresh('notices'); } catch (e) { return toast(e.message, 'err'); }
      toast(`${n} item ditandai sudah diantar`);
    },
    checkin(el, e, ctx) {
      const db = getDb(), r = db.reservations.find((x) => x.id === el.dataset.r);
      if (!r) return;
      local((d) => { const rr = d.reservations.find((x) => x.id === r.id); if (rr) rr.status = 'datang'; });
      API.reservationStatus(r.id, 'datang').catch((e) => toast(e.message, 'err'));
      if (el.dataset.pos) {
        openFromDenah({ table: r.table, merged: (r.join || []).filter((x) => x !== r.table), res: r.id, cust: { name: r.name, phone: r.phone }, mem: r.mem || (D.findMemberByPhone(db, r.phone)?.id ?? null) });
        go('pos');
      } else toast(`${r.name} sudah datang. Antar ke meja ${D.resTableLabel(r)}. Kasir sudah dikabari untuk membuat bill.`, 'ok', 5000);
    },
    async clearTable(el) {
      const id = el.dataset.id;
      el.disabled = true;
      if (ui.sel === id) ui.sel = null;
      await clearTable(id, 'L1');
    },
    moveTable(el, e, ctx) {
      const id = el.dataset.id;
      moveDialog({ ...ctx, outlet: 'L1' }, id, { done: (to) => { if (ui.sel === id) ui.sel = to; rerender(); } });
    },
    bookNow(el, e, ctx) { bookNowDialog(ctx, el.dataset.t, { done: () => rerender() }); },
    openPos(el) {
      if (el.dataset.o) openFromDenah({ orderId: el.dataset.o });
      else openFromDenah({ table: el.dataset.t });
      go('pos');
    },
    editMode() { ui.edit = !ui.edit; rerender(); if (ui.edit) toast('Seret meja untuk memindahkan. Ketuk meja untuk ubah detailnya.', 'info', 4000); },
    addTable(el, e, ctx) { openTableEditor(ctx, null); },
    editTable(el, e, ctx) { openTableEditor(ctx, el.dataset.id); },
  },
};
