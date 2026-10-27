// Aksi meja yang dipakai bersama oleh Kasir (POS) dan Service (Denah Meja):
// · Kosongkan meja yang sudah dibayar (tamu sudah pergi, meja sudah dibersihkan)
// · Pindah tamu ke meja lain — bill terbuka, pesanan QR yang sudah dibayar tapi belum selesai, dan tanda "Lunas" ikut pindah
import { local, getDb } from '../store.js';
import * as API from '../api.js';
import * as C from '../cloud.js';
import { esc, ic, rp, toast, openModal, confirmBox, fmtTime } from '../lib.js';
import * as D from '../domain.js';

// Pesanan yang menempati meja: bill terbuka, atau sudah dibayar di muka (QR/online) tapi makanannya belum selesai diantar
export function seated(db, L) {
  const t0 = new Date().setHours(0, 0, 0, 0);
  return db.orders.filter((o) => o.loc === L && o.table && o.released !== false
    && (o.status === 'open' || (o.status === 'paid' && o.created >= t0 && ['new', 'cook', 'ready'].includes(D.kitchenState(o)))));
}
export const occupants = (db, L, id) => seated(db, L).filter((o) => o.table === id || o.merged?.includes(id));
export const isFree = (db, L, t) => !t.hold && !occupants(db, L, t.id).length;
export const heldTables = (db, L) => db.tables.filter((t) => t.loc === L && t.hold);

function soonRes(db, id) {
  const now = Date.now();
  return db.reservations.find((r) => D.resTables(r).includes(id) && D.RES_ACTIVE.includes(r.status) && D.resStart(r) - now < 120 * 60000 && D.resStart(r) - now > -45 * 60000 && r.status !== 'datang');
}

// ---------- Kosongkan meja ----------
export async function clearTable(id, L = 'L1') {
  local((d) => { d.tables.filter((t) => t.loc === L && (!id || t.id === id)).forEach((t) => delete t.hold); });
  try {
    const n = await API.tableClear(id || null, L);
    toast(id ? `Meja ${id} kosong dan siap dipakai` : `${n || 0} meja dikosongkan`);
  } catch (e) { toast(e.message, 'err', 5000); }
  C.refresh('tables');
}

// ---------- Pindah meja ----------
export async function moveGuests(from, to, L = 'L1', { unmerge = false, order = null } = {}) {
  const db = getDb();
  const ids = occupants(db, L, from).map((o) => o.id);
  // Tampilan langsung berubah; server tetap menjadi acuan (dimuat ulang setelah selesai)
  local((d) => {
    for (const o of occupants(d, L, from)) {
      if (o.table === from) { o.table = to; if (unmerge && o.status === 'open') o.merged = []; } else o.merged = o.merged.map((x) => (x === from ? to : x));
    }
    const a = d.tables.find((x) => x.id === from), b = d.tables.find((x) => x.id === to);
    if (a?.hold && b) {
      const ho = D.order(d, a.hold.order);
      if (ho && ho.table === from) ho.table = to;
      b.hold = a.hold; delete a.hold;
    }
  });
  const call = () => API.moveGuests(from, to, L, unmerge);
  try {
    const r = await (order ? API.orderOp(order, call) : call());
    await Promise.all([...new Set([...(r?.ids || []), ...ids])].map((id) => C.refreshOrder(id)), C.refresh('tables', 'reservations')).catch(() => {});
    toast(`Tamu meja ${from} pindah ke meja ${to}`);
    return r;
  } catch (e) {
    toast(e.message || 'Gagal memindahkan meja', 'err', 5000);
    await Promise.all([...ids.map((id) => C.refreshOrder(id)), C.refresh('tables')]).catch(() => {});
    return null;
  }
}

// Pilih meja tujuan (hanya meja kosong), lalu pindahkan
export function moveDialog(ctx, from, { order = null, done } = {}) {
  const db = getDb(), L = ctx.outlet || 'L1';
  const occ = occupants(db, L, from);
  const src = db.tables.find((x) => x.id === from);
  if (!occ.length && !src?.hold) return toast(`Meja ${from} sedang kosong`, 'warn');
  const grp = occ.find((o) => o.status === 'open' && o.table === from && o.merged?.length);
  const free = db.tables.filter((x) => x.loc === L && x.id !== from && isFree(db, L, x));
  const areas = [...new Set(free.map((x) => x.area))];
  const nos = [...new Set([...occ.map((o) => o.no), ...(src?.hold ? [D.order(db, src.hold.order)?.no] : [])].filter(Boolean))];
  const tile = (x) => {
    const r = soonRes(db, x.id);
    return `<button class="tb ${r ? 'res' : 'free'}" data-t="${esc(x.id)}" aria-label="Meja ${esc(x.id)}, ${x.seats} kursi${r ? `, reservasi ${esc(r.time)}` : ''}"><span class="tb-n">${esc(x.id)}</span><span class="tb-s">${x.seats} kursi</span>${r ? `<span class="tb-o">Reservasi ${esc(r.time)}</span>` : ''}</button>`;
  };
  openModal({
    title: `Pindahkan tamu meja ${from}`,
    body: `<p class="muted sm">${nos.length ? `Bill ${esc(nos.join(', '))} ` : 'Semua pesanan '}ikut pindah${src?.hold ? ', termasuk tanda lunas' : ''}. Pilih meja kosong:</p>
      ${grp ? `<label class="switch sm mv-unmerge"><input type="checkbox" name="unmerge" checked><span>Lepas meja gabungan ${esc(grp.merged.join(', '))} (pindah satu rombongan ke satu meja)</span></label>` : ''}
      ${free.length ? areas.map((a) => `<h4 class="sec-t">${esc(a)}</h4><div class="tables sm">${free.filter((x) => x.area === a).map(tile).join('')}</div>`).join('') : '<p class="empty">Tidak ada meja kosong saat ini.</p>'}`,
    onMount(m, api) {
      m.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-t]'); if (!b) return;
        const to = b.dataset.t;
        const r = soonRes(getDb(), to);
        if (r && !(await confirmBox(`Meja ${to} ada reservasi`, `Reservasi <b>${esc(r.name)}</b> pukul ${esc(r.time)} memakai meja ${esc(to)}. Tetap pindahkan tamu ke sana?`, 'Tetap pindahkan'))) return;
        const unmerge = !!m.querySelector('[name=unmerge]')?.checked;
        api.close();
        const p = moveGuests(from, to, L, { unmerge, order });
        done?.(to);
        const res = await p;
        if (res) done?.(to, res);
      });
    },
  });
}

// ---------- Meja "Lunas" di kasir ----------
export function heldDialog(ctx, id, { newBill, done } = {}) {
  const db = getDb(), L = ctx.outlet || 'L1';
  const t = db.tables.find((x) => x.id === id);
  if (!t?.hold) return;
  const o = D.order(db, t.hold.order);
  openModal({
    title: `Meja ${id} sudah dibayar`, size: 'sm',
    body: `<dl class="kv sm"><dt>Bill</dt><dd><b>${esc(o?.no || '-')}</b>${o ? ` · ${rp(o.total ?? o.bill?.total ?? 0)}` : ''}</dd><dt>Tamu</dt><dd>${esc(o?.cust?.name || 'Walk-in')}</dd>
      <dt>Dibayar</dt><dd>${fmtTime(t.hold.at)} · <span data-since="${t.hold.at}" data-fmt="min"></span> lalu</dd></dl>
      <p class="muted sm">Meja tetap ditandai terisi sampai dikosongkan. Kosongkan setelah tamu pergi dan meja sudah dibersihkan.</p>
      <div class="act-list">
        <button class="btn btn-pri btn-block" data-m="clear">${ic('check', 18)} Kosongkan meja</button>
        <button class="btn btn-block" data-m="move">${ic('arrow-left-right', 18)} Pindah ke meja lain</button>
        ${newBill ? `<button class="btn btn-block" data-m="new">${ic('plus', 18)} Tamu pesan lagi: buka bill baru</button>` : ''}
      </div>`,
    onMount(m, api) {
      m.addEventListener('click', (e) => {
        const b = e.target.closest('[data-m]'); if (!b) return;
        api.close();
        if (b.dataset.m === 'clear') { clearTable(id, L); done?.(); }
        else if (b.dataset.m === 'move') moveDialog(ctx, id, { done });
        else newBill?.();
      });
    },
  });
}

// Daftar semua meja "Lunas" yang belum dikosongkan
export function heldListDialog(ctx, { done } = {}) {
  const L = ctx.outlet || 'L1';
  const paint = (m) => {
    const db = getDb();
    const list = heldTables(db, L).sort((a, b) => a.hold.at - b.hold.at);
    m.querySelector('[data-list]').innerHTML = list.length ? `<div class="olist">${list.map((t) => {
      const o = D.order(db, t.hold.order);
      const cooking = occupants(db, L, t.id).some((x) => x.status === 'paid');
      return `<div class="ol static"><span><b>Meja ${esc(t.id)}</b> ${esc(o?.no || '')}${cooking ? ' <span class="badge b-warn">Makanan belum selesai</span>' : ''}<small>dibayar ${fmtTime(t.hold.at)} · <span data-since="${t.hold.at}" data-fmt="min"></span> lalu</small></span>
        <span class="row-xs"><button class="btn btn-sm btn-ghost" data-mv="${esc(t.id)}" title="Pindah ke meja lain">${ic('arrow-left-right', 15)}</button><button class="btn btn-sm" data-clr="${esc(t.id)}">${ic('check', 15)} Kosongkan</button></span></div>`;
    }).join('')}</div>` : '<p class="empty">Semua meja yang sudah dibayar sudah dikosongkan.</p>';
    const all = m.querySelector('[data-all]'); if (all) all.hidden = list.length < 2;
  };
  openModal({
    title: 'Meja sudah dibayar, belum dikosongkan', size: 'sm',
    body: '<div data-list></div>',
    footer: `<button class="btn btn-ghost" data-all>Kosongkan semua</button><button class="btn btn-pri" data-close>Selesai</button>`,
    onMount(m, api) {
      paint(m);
      m.addEventListener('click', async (e) => {
        const c = e.target.closest('[data-clr]'), mv = e.target.closest('[data-mv]');
        if (c) { c.disabled = true; await clearTable(c.dataset.clr, L); paint(m); done?.(); }
        else if (mv) { api.close(); moveDialog(ctx, mv.dataset.mv, { done }); }
        else if (e.target.closest('[data-all]')) {
          const n = heldTables(getDb(), L).length;
          if (!(await confirmBox('Kosongkan semua meja', `Tandai <b>${n} meja</b> yang sudah dibayar sebagai kosong? Pastikan tamunya sudah pergi.`, 'Kosongkan semua'))) return;
          await clearTable(null, L); paint(m); done?.();
        }
      });
    },
  });
}
