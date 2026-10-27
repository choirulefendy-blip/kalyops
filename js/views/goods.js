// Kaly Goods — supply chain: supplier terverifikasi, PO, approval, penerimaan, pembayaran langsung, anti-fraud, backup supplier
import { getDb } from '../store.js';
import * as API from '../api.js';
import * as C from '../cloud.js';
import { esc, ic, rp, num, pct, toast, openModal, formData, hbars, sum, fmtDT, fmtDate, DAY, dayKey, uid, confirmBox, startOfDay } from '../lib.js';
import * as D from '../domain.js';
import { rerender } from '../app.js';

const ui = { tab: 'sum', f: 'aktif', lowLoc: 'L1' };
const ST = { draft: ['Draft', 'b-mute'], diajukan: ['Menunggu persetujuan', 'b-warn'], disetujui: ['Disetujui, menunggu barang', 'b-info'], diterima: ['Diterima, belum dibayar', 'b-gold'], dibayar: ['Lunas', 'b-ok'], ditolak: ['Ditolak', 'b-err'] };
const verified = (s) => s.verified.npwp && s.verified.bank && s.verified.visit;
const vBadge = (s) => verified(s) ? `<span class="badge b-ok">${ic('badge-check', 13)} Terverifikasi</span>` : `<span class="badge b-warn">Belum lengkap</span>`;
const refPrice = (db, sup, i) => db.supplierPrices.find((p) => p.sup === sup && p.i === i)?.price || D.item(db, i)?.cost || 0;
const recvValue = (po) => sum(po.items, (l) => (l.rq || 0) * l.p);

function poFlags(db, po) {
  const fl = [];
  const s = D.supplier(db, po.sup);
  for (const l of po.items) { const ref = refPrice(db, po.sup, l.i); if (ref && l.p > ref * (1 + db.settings.poPriceTol)) fl.push(`Harga ${D.item(db, l.i).name} ${Math.round((l.p / ref - 1) * 100)}% di atas harga acuan`); }
  if (!verified(s)) fl.push(`Supplier belum terverifikasi penuh (${[!s.verified.npwp && 'NPWP', !s.verified.bank && 'rekening', !s.verified.visit && 'kunjungan lokasi'].filter(Boolean).join(', ')})`);
  if (!s.active) fl.push('Supplier sedang ditandai tidak bisa kirim');
  const t0 = startOfDay(po.at);
  const same = db.pos.filter((x) => x.id !== po.id && x.sup === po.sup && x.by === po.by && x.at >= t0 && x.at < t0 + DAY && x.status !== 'ditolak');
  const tot = sum(po.items, (l) => l.q * l.p);
  if (same.length && tot < db.settings.poApproval && tot + sum(same, (x) => x.total) > db.settings.poApproval) fl.push(`Kemungkinan PO dipecah: ${same.length + 1} PO ke supplier yang sama hari ini, total ${rp(tot + sum(same, (x) => x.total))}`);
  return fl;
}

function summary(ctx) {
  const db = ctx.db, since = Date.now() - 30 * DAY;
  const recent = db.pos.filter((p) => p.receivedAt && p.receivedAt >= since);
  const spend = sum(recent, (p) => recvValue(p));
  const pend = db.pos.filter((p) => p.status === 'diajukan');
  const unpaid = db.pos.filter((p) => p.status === 'diterima');
  const flagged = db.pos.filter((p) => p.flags?.length && !['dibayar', 'ditolak'].includes(p.status));
  const bySup = {}; recent.forEach((p) => { bySup[p.sup] = (bySup[p.sup] || 0) + recvValue(p); });
  const lows = D.lowStock(db, ui.lowLoc);
  return `<div class="kpis"><div class="kpi"><span class="kpi-l">Belanja 30 hari</span><b class="kpi-v">${rp(spend)}</b><span class="kpi-d">${recent.length} penerimaan barang</span></div>
      <div class="kpi"><span class="kpi-l">Menunggu persetujuan</span><b class="kpi-v ${pend.length ? 'neg' : ''}">${pend.length}</b><span class="kpi-d">${rp(sum(pend, (p) => p.total))}</span></div>
      <div class="kpi"><span class="kpi-l">Hutang supplier</span><b class="kpi-v">${rp(sum(unpaid, (p) => recvValue(p)))}</b><span class="kpi-d">${unpaid.length} tagihan belum dibayar</span></div>
      <div class="kpi"><span class="kpi-l">PO bertanda fraud</span><b class="kpi-v ${flagged.length ? 'neg' : ''}">${flagged.length}</b><span class="kpi-d">perlu dicek sebelum disetujui</span></div></div>
    <div class="grid-side"><div class="card"><div class="card-h"><h3>Bahan di bawah stok minimum</h3><div class="chips">${db.locations.map((l) => `<button class="chip ${ui.lowLoc === l.id ? 'on' : ''}" data-a="lowLoc" data-v="${l.id}">${esc(l.name)}</button>`).join('')}</div></div>
        ${lows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Bahan</th><th class="r">Stok</th><th class="r">Minimum</th><th>Supplier utama</th><th>Backup</th></tr></thead><tbody>${lows.map((x) => { const map = db.itemSup[x.i] || {}; const p = map.primary && D.supplier(db, map.primary), b = map.backup && D.supplier(db, map.backup); return `<tr><td><b>${esc(x.item.name)}</b></td><td class="r neg">${num(x.q, 2)} ${esc(x.item.unit)}</td><td class="r">${num(x.min, 2)}</td><td>${p ? esc(p.name) + (p.active ? '' : ' <span class="badge b-err">tidak bisa kirim</span>') : '—'}</td><td>${b ? esc(b.name) : '—'}</td></tr>`; }).join('')}</tbody></table></div>
          <button class="btn btn-pri" data-a="autoPo">${ic('truck', 16)} Buat draft PO otomatis</button><p class="hint">Dikelompokkan per supplier utama. Kalau supplier utama tidak bisa kirim, otomatis pakai backup terverifikasi.</p>` : '<p class="empty">Semua stok di lokasi ini aman.</p>'}</div>
      <aside><div class="card"><div class="card-h"><h3>Belanja per supplier</h3><span class="muted sm">30 hari</span></div>${hbars(Object.entries(bySup).map(([k, v]) => ({ label: D.supplier(db, k).name, value: v })).sort((a, b) => b.value - a.value))}</div></aside></div>`;
}

function poList(ctx) {
  const db = ctx.db;
  const ps = db.pos.filter((p) => ui.f === 'semua' || (ui.f === 'aktif' ? !['dibayar', 'ditolak'].includes(p.status) : p.status === ui.f)).sort((a, b) => b.at - a.at);
  return `<div class="row sb wrap"><div class="chips">${[['aktif', 'Berjalan'], ['diajukan', 'Menunggu persetujuan'], ['disetujui', 'Menunggu barang'], ['diterima', 'Belum dibayar'], ['dibayar', 'Lunas'], ['semua', 'Semua']].map(([k, l]) => `<button class="chip ${ui.f === k ? 'on' : ''}" data-a="f" data-v="${k}">${l}</button>`).join('')}</div><button class="btn btn-pri" data-a="poNew">${ic('plus', 16)} PO baru</button></div>
    <div class="card"><div class="tbl-wrap"><table class="tbl hover"><thead><tr><th>No. PO</th><th>Tanggal</th><th>Supplier</th><th>Untuk</th><th class="r">Nilai</th><th>Status</th><th>Cek fraud</th></tr></thead><tbody>
    ${ps.map((p) => { const s = D.supplier(db, p.sup); return `<tr data-a="poView" data-id="${p.id}"><td><b>${esc(p.no)}</b></td><td>${fmtDT(p.at)}</td><td>${esc(s.name)} ${verified(s) ? '' : '<span class="badge b-warn">belum terverifikasi</span>'}</td><td>${esc(D.loc(db, p.loc).name)}</td><td class="r">${rp(p.status === 'diterima' || p.status === 'dibayar' ? recvValue(p) : p.total)}</td><td><span class="badge ${ST[p.status][1]}">${ST[p.status][0]}</span></td><td>${p.flags?.length ? `<span class="badge b-err">${ic('shield-alert', 13)} ${p.flags.length} temuan</span>` : '<span class="muted sm">Aman</span>'}</td></tr>`; }).join('') || '<tr><td colspan="7" class="empty">Tidak ada PO untuk filter ini.</td></tr>'}
    </tbody></table></div></div>`;
}

function suppliers(ctx) {
  const db = ctx.db, since = Date.now() - 30 * DAY;
  return `<div class="row sb wrap"><p class="muted">Supplier terverifikasi sudah dicek NPWP, rekening atas nama usaha, dan dikunjungi langsung. PO ke supplier yang belum lengkap otomatis ditandai.</p><button class="btn btn-pri" data-a="supNew">${ic('plus', 16)} Supplier baru</button></div>
    <div class="sup-grid">${db.suppliers.map((s) => { const n = db.supplierPrices.filter((p) => p.sup === s.id).length; const sp = sum(db.pos.filter((p) => p.sup === s.id && p.receivedAt >= since), (p) => recvValue(p)); return `<article class="card sup ${s.active ? '' : 'off'}"><div class="card-h"><h3>${esc(s.name)}</h3>${vBadge(s)}</div>
      <p class="muted sm">${esc(s.cat)}. ${n} bahan. Rating ${num(s.rating, 1)}. Belanja 30 hari ${rp(sp)}.</p>
      <div class="ver">${[['npwp', 'NPWP'], ['bank', 'Rekening usaha'], ['visit', 'Kunjungan lokasi']].map(([k, l]) => `<button class="vchip ${s.verified[k] ? 'ok' : ''}" data-a="ver" data-id="${s.id}" data-k="${k}" ${ctx.user.role === 'owner' ? '' : 'disabled'}>${ic(s.verified[k] ? 'check' : 'x', 13)} ${l}</button>`).join('')}</div>
      <p class="sm">${ic('building-2', 14)} ${esc(s.bank)}<br>${ic('phone', 14)} <a class="lnk" href="https://wa.me/${D.waPhone(s.phone)}" target="_blank" rel="noopener">${esc(s.phone)}</a></p>
      <div class="row sb wrap"><label class="switch sm"><input type="checkbox" data-a-change="supActive" data-id="${s.id}" ${s.active ? 'checked' : ''}><span>${s.active ? 'Bisa kirim' : 'Sedang tidak bisa kirim'}</span></label><button class="btn btn-sm" data-a="supPrices" data-id="${s.id}">${ic('ticket', 14)} Harga acuan (${n})</button></div></article>`; }).join('') || '<p class="empty">Belum ada supplier. Tambahkan supplier, lalu isi harga acuan bahan yang dijualnya.</p>'}</div>`;
}

function prices(ctx) {
  const db = ctx.db;
  const items = db.items.filter((i) => i.type === 'raw');
  const lastPO = (i) => { const p = db.pos.filter((x) => x.items.some((l) => l.i === i) && x.receivedAt).sort((a, b) => b.receivedAt - a.receivedAt)[0]; return p ? p.items.find((l) => l.i === i).p : null; };
  return `<p class="muted">Atur supplier utama dan backup untuk tiap bahan. Backup dipakai otomatis saat supplier utama tidak bisa kirim.</p>
    <div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Bahan</th><th>Supplier utama</th><th class="r">Harga</th><th>Backup</th><th class="r">Harga</th><th class="r">Selisih</th><th class="r">Harga PO terakhir</th></tr></thead><tbody>
    ${items.map((it) => { const m = db.itemSup[it.id] || {}; const sups = db.supplierPrices.filter((p) => p.i === it.id); const pp = m.primary ? refPrice(db, m.primary, it.id) : 0, bp = m.backup ? refPrice(db, m.backup, it.id) : 0; const lp = lastPO(it.id);
      const opts = (sel) => `<option value="">—</option>` + db.suppliers.map((s) => { const has = sups.some((p) => p.sup === s.id); return `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)}${has ? '' : ' (belum ada harga)'}${verified(s) ? '' : ' (belum terverifikasi)'}</option>`; }).join('');
      return `<tr><td><b>${esc(it.name)}</b><small class="muted"> per ${esc(it.unit)}</small></td><td><select data-a-change="setSup" data-i="${it.id}" data-k="primary">${opts(m.primary)}</select></td><td class="r">${pp ? rp(pp) : '—'}</td><td><select data-a-change="setSup" data-i="${it.id}" data-k="backup">${opts(m.backup)}</select></td><td class="r">${bp ? rp(bp) : '—'}</td><td class="r">${pp && bp ? (bp >= pp ? '+' : '') + pct(bp / pp - 1) : ''}</td><td class="r">${lp ? rp(lp) : '—'}</td></tr>`; }).join('')}
    </tbody></table></div></div>`;
}

function poForm(db, init = {}) {
  let sup = init.sup || (db.suppliers.find((x) => x.active && verified(x)) || db.suppliers.find((x) => x.active) || db.suppliers[0])?.id, L = init.loc || 'L1';
  let rows = init.items || [];
  const draw = () => {
    const s = D.supplier(db, sup);
    const priced = db.supplierPrices.filter((p) => p.sup === sup).map((p) => D.item(db, p.i)).filter(Boolean);
    const its = [...priced, ...db.items.filter((i) => i.type === 'raw' && !priced.includes(i)).sort((a, b) => a.name.localeCompare(b.name))];
    const tot = sum(rows, (r) => r.q * r.p);
    return `<div class="grid2"><label class="fld"><span>Supplier</span><select data-sup>${db.suppliers.map((x) => `<option value="${x.id}" ${x.id === sup ? 'selected' : ''}>${esc(x.name)}${verified(x) ? '' : ' (belum terverifikasi)'}${x.active ? '' : ' (tidak bisa kirim)'}</option>`).join('')}</select></label>
      <label class="fld"><span>Dikirim ke</span><select data-loc>${db.locations.map((l) => `<option value="${l.id}" ${l.id === L ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label></div>
      <p class="row wrap">${vBadge(s)} <span class="muted sm">${esc(s.bank)}</span></p>
      <div class="bom-rows">${rows.map((r, i) => { const ref = refPrice(db, sup, r.i); const over = ref && r.p > ref * (1 + db.settings.poPriceTol); const st = db.stock[L]?.[r.i]; return `<div class="bom-row po"><select data-ri="${i}">${its.map((it) => `<option value="${it.id}" ${it.id === r.i ? 'selected' : ''}>${esc(it.name)} (${esc(it.unit)})</option>`).join('')}</select><input type="number" step="0.5" min="0" data-rq="${i}" value="${r.q}" aria-label="Jumlah"><input type="number" step="50" data-rp="${i}" value="${r.p}" class="${over ? 'warn' : ''}" aria-label="Harga"><span class="muted sm">${over ? `<b class="neg">${Math.round((r.p / ref - 1) * 100)}% di atas acuan</b>` : `acuan ${rp(ref)}`}${st ? `, stok ${num(st.q, 1)}` : ''}</span><button class="btn-icon sm" data-rx="${i}" aria-label="Hapus">${ic('x', 15)}</button></div>`; }).join('') || '<p class="empty sm">Belum ada barang.</p>'}</div>
      <div class="row wrap"><button class="btn btn-sm" data-radd>${ic('plus', 14)} Tambah barang</button><button class="btn btn-sm" data-low>${ic('sprout', 14)} Isi dari stok menipis</button><b class="push">Total ${rp(tot)}</b></div>`;
  };
  return { draw, get: () => ({ sup, L, rows }), set(k, v) { if (k === 'sup') { sup = v; rows = []; } if (k === 'loc') L = v; }, rows: () => rows, fillLow() {
    const its = db.supplierPrices.filter((p) => p.sup === sup).map((p) => p.i);
    D.lowStock(db, L).filter((x) => its.includes(x.i)).forEach((x) => { if (!rows.some((r) => r.i === x.i)) rows.push({ i: x.i, q: Math.ceil((x.min * 2 - x.q) * 2) / 2, p: refPrice(db, sup, x.i) }); });
  } };
}

export default {
  render(ctx) {
    const tabs = [['sum', 'Ringkasan'], ['po', 'Purchase order'], ['sup', 'Supplier'], ['price', 'Harga & backup']];
    const body = { sum: summary, po: poList, sup: suppliers, price: prices }[ui.tab](ctx);
    return `<div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${ui.tab === k ? 'on' : ''}" data-a="tab" data-v="${k}">${l}${k === 'po' && ctx.db.pos.filter((p) => p.status === 'diajukan').length ? ` <b class="cnt">${ctx.db.pos.filter((p) => p.status === 'diajukan').length}</b>` : ''}</button>`).join('')}</div><div class="tabbody">${body}</div>`;
  },
  actions: {
    tab(el) { ui.tab = el.dataset.v; rerender(); },
    f(el) { ui.f = el.dataset.v; rerender(); },
    lowLoc(el) { ui.lowLoc = el.dataset.v; rerender(); },
    async ver(el) { const s = D.supplier(getDb(), el.dataset.id), k = el.dataset.k; await API.tableUpdate('suppliers', { id: s.id }, { ['verified_' + k]: !s.verified[k] }); await C.refresh('suppliers'); rerender(); },
    async supActive(el) { await API.tableUpdate('suppliers', { id: el.dataset.id }, { active: el.checked }); await C.refresh('suppliers'); toast(el.checked ? 'Supplier aktif lagi' : 'Supplier ditandai tidak bisa kirim. PO otomatis memakai backup.', 'info'); rerender(); },
    async setSup(el) { const cur = getDb().itemSup[el.dataset.i] || {}; const nx = { ...cur, [el.dataset.k]: el.value || null }; await API.itemSupplierSave(el.dataset.i, nx.primary, nx.backup); await C.refresh('suppliers'); toast('Supplier disimpan'); rerender(); },
    async autoPo(el, e, ctx) {
      const n = await API.poAuto(ui.lowLoc);
      await C.refresh('pos');
      toast(n ? `${n} draft PO dibuat. Cek lalu ajukan.` : 'Tidak ada supplier aktif untuk bahan yang menipis', n ? 'ok' : 'warn');
      ui.tab = 'po'; ui.f = 'aktif'; rerender();
    },
    poNew(el, e, ctx) {
      const db = getDb();
      if (!db.suppliers.length) { ui.tab = 'sup'; rerender(); return toast('Tambahkan supplier dulu di tab Supplier', 'warn'); }
      const F = poForm(db);
      openModal({ title: 'Purchase order baru', size: 'lg', body: F.draw(), footer: `<button class="btn" data-close>Batal</button><button class="btn" data-save="draft">Simpan draft</button><button class="btn btn-pri" data-save="diajukan">Ajukan persetujuan</button>`,
        onMount(m, api) {
          const redraw = () => api.set(F.draw());
          m.addEventListener('change', (ev) => { const t = ev.target, rows = F.rows();
            if (t.matches('[data-sup]')) F.set('sup', t.value); if (t.matches('[data-loc]')) F.set('loc', t.value);
            if (t.dataset.ri !== undefined) { rows[+t.dataset.ri].i = t.value; rows[+t.dataset.ri].p = refPrice(db, F.get().sup, t.value); }
            if (t.dataset.rq !== undefined) rows[+t.dataset.rq].q = Number(t.value); if (t.dataset.rp !== undefined) rows[+t.dataset.rp].p = Number(t.value);
            redraw(); });
          m.addEventListener('click', (ev) => {
            if (ev.target.closest('[data-radd]')) { const sp = db.supplierPrices.find((p) => p.sup === F.get().sup); const it = sp ? D.item(db, sp.i) : db.items.find((i) => i.type === 'raw'); if (it) F.rows().push({ i: it.id, q: 1, p: sp ? sp.price : refPrice(db, F.get().sup, it.id) || 1000 }); redraw(); }
            if (ev.target.closest('[data-low]')) { F.fillLow(); redraw(); }
            const x = ev.target.closest('[data-rx]'); if (x) { F.rows().splice(+x.dataset.rx, 1); redraw(); }
            const sv = ev.target.closest('[data-save]');
            if (sv) {
              const { sup, L, rows } = F.get();
              const items = rows.filter((r) => r.q > 0 && r.p > 0);
              if (!items.length) return toast('Tambahkan minimal satu barang', 'warn');
              sv.disabled = true;
              (async () => {
                const id = await API.poCreate(sup, L, items.map((r) => ({ item: r.i, qty: r.q, price: r.p })), sv.dataset.save === 'diajukan');
                await C.refresh('pos', 'flags');
                const res = getDb().pos.find((x) => x.id === id) || { no: 'PO', status: sv.dataset.save, flags: [] };
                api.close(); toast(`${res.no} ${res.status === 'draft' ? 'disimpan sebagai draft' : 'diajukan'}${res.flags.length ? `, ${res.flags.length} temuan perlu dicek` : ''}`, res.flags.length ? 'warn' : 'ok'); ui.tab = 'po'; rerender();
              })().catch((err) => { sv.disabled = false; toast(err.message, 'err', 6000); });
            }
          });
        } });
    },
    poView(el, e, ctx) {
      const db = getDb(), p = db.pos.find((x) => x.id === el.dataset.id), s = D.supplier(db, p.sup), u = ctx.user;
      const own = p.by === u.id;
      const canApprove = u.role === 'owner' && !own;
      const acts = {
        draft: own || u.role === 'owner' ? `<button class="btn btn-danger-ghost" data-act="del">Hapus</button><button class="btn btn-pri" data-act="submit">Ajukan persetujuan</button>` : '',
        diajukan: u.role === 'owner' ? (own ? `<p class="hint">PO buatan sendiri tidak bisa kamu setujui. Minta manajer lain atau ubah pembuat.</p>` : `<button class="btn btn-danger-ghost" data-act="reject">Tolak</button><button class="btn btn-pri" data-act="approve">Setujui</button>`) : '<p class="hint">Menunggu persetujuan manajer.</p>',
        disetujui: ['owner', 'gudang'].includes(u.role) ? `<button class="btn btn-pri" data-act="recv">Terima barang</button>` : '',
        diterima: u.role === 'owner' ? `<button class="btn btn-pri" data-act="pay">Bayar ke supplier</button>` : '<p class="hint">Menunggu pembayaran oleh manajer.</p>',
      }[p.status] || '';
      const tl = [['Dibuat', p.at, p.by], ['Disetujui', p.approvedAt, p.approvedBy], ['Barang diterima', p.receivedAt, p.receivedBy], ['Dibayar', p.paidAt, p.paidBy]].filter((x) => x[1]);
      openModal({ title: `${p.no}`, size: 'lg', body: `<div class="row sb wrap"><span><b>${esc(s.name)}</b> ${vBadge(s)}</span><span class="badge ${ST[p.status][1]}">${ST[p.status][0]}</span></div>
        <p class="muted sm">Untuk ${esc(D.loc(db, p.loc).name)}. Rekening supplier: ${esc(s.bank)}${p.inv ? `. Invoice ${esc(p.inv)}` : ''}.</p>
        ${p.flags?.length ? `<div class="banner err sm">${ic('shield-alert', 18)}<ul>${p.flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>` : ''}
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Barang</th><th class="r">Dipesan</th><th class="r">Diterima</th><th class="r">Harga</th><th class="r">Acuan</th><th class="r">Subtotal</th></tr></thead><tbody>${p.items.map((l) => { const it = D.item(db, l.i), ref = refPrice(db, p.sup, l.i); return `<tr><td>${esc(it.name)}</td><td class="r">${num(l.q, 2)} ${esc(it.unit)}</td><td class="r ${p.receivedAt && l.rq < l.q ? 'neg' : ''}">${p.receivedAt ? num(l.rq, 2) : '—'}</td><td class="r ${l.p > ref * (1 + db.settings.poPriceTol) ? 'neg' : ''}">${rp(l.p)}</td><td class="r muted">${rp(ref)}</td><td class="r">${rp((p.receivedAt ? l.rq : l.q) * l.p)}</td></tr>`; }).join('')}</tbody></table></div>
        <p class="row sb"><span class="muted">${p.receivedAt ? 'Nilai tagihan dihitung dari barang yang diterima (3-way match).' : ''}</span><b>Total ${rp(p.receivedAt ? recvValue(p) : p.total)}</b></p>
        <ol class="tl-list">${tl.map(([l, t, by]) => `<li><b>${l}</b> ${fmtDT(t)} oleh ${esc(D.userName(db, by))}</li>`).join('')}</ol>`,
        footer: `<button class="btn" data-close>Tutup</button>${acts}`,
        onMount(m, api) { m.addEventListener('click', async (ev) => {
          const b = ev.target.closest('[data-act]'); if (!b) return;
          const a = b.dataset.act;
          try {
            if (a === 'del') { await API.poDelete(p.id); await C.refresh('pos'); api.close(); toast('Draft dihapus'); return rerender(); }
            if (a === 'submit') { await API.poSubmit(p.id); await C.refresh('pos', 'flags'); api.close(); toast('PO diajukan'); return rerender(); }
            if (a === 'approve') { if (p.flags?.length && !(await confirmBox('Setujui PO dengan temuan?', `PO ini punya ${p.flags.length} temuan anti-fraud. Pastikan sudah dicek.`, 'Tetap setujui'))) return; await API.poApprove(p.id, true); await C.refresh('pos'); api.close(); toast('PO disetujui dan siap dikirim ke supplier'); return rerender(); }
            if (a === 'reject') { await API.poApprove(p.id, false); await C.refresh('pos'); api.close(); toast('PO ditolak', 'warn'); return rerender(); }
          } catch (err) { return toast(err.message, 'err', 6000); }
          if (a === 'recv') { api.close(); recvModal(p.id, u); }
          if (a === 'pay') { api.close(); payModal(p.id, u); }
        }); } });
    },
    supPrices(el) {
      const db = getDb(), s = D.supplier(db, el.dataset.id);
      const cur = Object.fromEntries(db.supplierPrices.filter((p) => p.sup === s.id).map((p) => [p.i, p.price]));
      const raw = db.items.filter((i) => i.type === 'raw').sort((a, b) => (cur[b.id] ? 1 : 0) - (cur[a.id] ? 1 : 0) || a.name.localeCompare(b.name));
      let q = '';
      const rows = () => raw.filter((i) => !q || i.name.toLowerCase().includes(q)).map((i) => `<tr><td>${esc(i.name)}<small class="muted"> per ${esc(i.unit)}</small></td><td class="r muted">${rp(i.cost)}</td><td class="r"><input class="inp inp-num" type="number" min="0" step="50" data-pi="${i.id}" value="${cur[i.id] ?? ''}" placeholder="—"></td></tr>`).join('');
      openModal({ title: `Harga acuan ${s.name}`, size: 'lg', body: `<p class="muted">Isi harga beli yang disepakati per satuan. Harga acuan dipakai untuk PO otomatis dan untuk menandai PO yang harganya di atas acuan. Kosongkan bila supplier ini tidak menjual bahan itu.</p>
        <div class="search">${ic('search', 17)}<input id="sp-q" placeholder="Cari bahan"></div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Bahan</th><th class="r">Harga standar</th><th class="r">Harga acuan</th></tr></thead><tbody id="sp-rows">${rows()}</tbody></table></div>`,
        footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Simpan harga</button>`,
        onMount(m, api) {
          const vals = { ...cur };
          m.addEventListener('input', (ev) => { if (ev.target.id === 'sp-q') { q = ev.target.value.trim().toLowerCase(); m.querySelector('#sp-rows').innerHTML = rows(); m.querySelectorAll('[data-pi]').forEach((x) => { if (vals[x.dataset.pi] !== undefined) x.value = vals[x.dataset.pi]; }); } else if (ev.target.dataset.pi) vals[ev.target.dataset.pi] = ev.target.value === '' ? undefined : Number(ev.target.value); });
          m.querySelector('[data-ok]').onclick = async () => {
            const up = Object.entries(vals).filter(([i, v]) => v > 0 && v !== cur[i]).map(([i, v]) => ({ supplier_id: s.id, item_id: i, price: v, updated_at: new Date().toISOString() }));
            const del = Object.keys(cur).filter((i) => !(vals[i] > 0));
            try {
              if (up.length) await API.tableUpsert('supplier_prices', up, 'supplier_id,item_id');
              for (const i of del) await API.tableDeleteWhere('supplier_prices', { supplier_id: s.id, item_id: i });
              await C.refresh('suppliers');
            } catch (err) { return toast(err.message, 'err'); }
            api.close(); toast(`Harga acuan ${s.name} disimpan`); rerender();
          };
        } });
    },
    supNew(el, e, ctx) {
      openModal({ title: 'Supplier baru', size: 'md', body: `<div class="grid2"><label class="fld"><span>Nama usaha</span><input name="n" autofocus></label><label class="fld"><span>Kategori</span><input name="c" placeholder="Contoh: sayur & bumbu"></label><label class="fld"><span>No. WhatsApp</span><input name="p"></label><label class="fld"><span>Rekening</span><input name="b" placeholder="BRI 0000-..."></label></div><p class="hint">Supplier baru belum terverifikasi. Centang NPWP, rekening, dan kunjungan lokasi setelah dicek.</p>`,
        footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Simpan</button>`,
        onMount(m, api) { m.querySelector('[data-ok]').onclick = async () => { const f = formData(m); if (!f.n.trim()) return toast('Isi nama supplier', 'warn'); try { await API.tableInsert('suppliers', { id: uid('s'), name: f.n.trim(), category: f.c || '', phone: f.p || '', bank: f.b || '' }); await C.refresh('suppliers'); } catch (err) { return toast(err.message, 'err'); } api.close(); toast('Supplier ditambahkan'); rerender(); }; } });
    },
  },
};

function recvModal(id, u) {
  const db = getDb(), p = db.pos.find((x) => x.id === id);
  openModal({ title: `Terima barang ${p.no}`, size: 'md', body: `<p class="muted">Hitung barang yang datang. Kekurangan otomatis ditandai dan hanya barang yang diterima yang dibayar.</p>
    <table class="tbl"><thead><tr><th>Barang</th><th class="r">Dipesan</th><th class="r">Diterima</th></tr></thead><tbody>${p.items.map((l, i) => `<tr><td>${esc(D.item(db, l.i).name)}</td><td class="r">${num(l.q, 2)} ${esc(D.item(db, l.i).unit)}</td><td class="r"><input class="inp inp-num" type="number" step="0.5" min="0" data-rq="${i}" value="${l.q}"></td></tr>`).join('')}</tbody></table>
    <label class="fld"><span>No. invoice / surat jalan supplier</span><input name="inv" placeholder="INV/..."></label>`,
    footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Terima & tambah stok</button>`,
    onMount(m, api) { m.querySelector('[data-ok]').onclick = async () => {
      const inv = m.querySelector('[name=inv]').value.trim();
      if (!inv) return toast('Isi nomor invoice dari supplier', 'warn');
      if (getDb().pos.some((x) => x.id !== p.id && x.sup === p.sup && x.inv && x.inv.toUpperCase() === inv.toUpperCase())) return toast('Nomor invoice ini sudah pernah dipakai. Cek kemungkinan tagihan ganda.', 'err');
      const rq = [...m.querySelectorAll('[data-rq]')].map((x) => Math.max(0, Number(x.value) || 0));
      try { await API.poReceive(p.id, Object.fromEntries(p.items.map((l, i) => [l.i, rq[i]])), inv); await C.refresh('pos', 'stock', 'moves', 'items', 'journals', 'flags'); }
      catch (err) { return toast(err.message, 'err', 6000); }
      api.close(); toast('Barang diterima, stok bertambah, hutang supplier tercatat'); rerender();
    }; } });
}
function payModal(id, u) {
  const db = getDb(), p = db.pos.find((x) => x.id === id), s = D.supplier(db, p.sup);
  const val = recvValue(p), fee = db.settings.transferFee;
  openModal({ title: `Bayar ${p.no}`, size: 'sm', body: `<dl class="kv"><dt>Supplier</dt><dd>${esc(s.name)}</dd><dt>Rekening tujuan</dt><dd>${esc(s.bank)}</dd><dt>Nilai barang diterima</dt><dd>${rp(val)}</dd><dt>Biaya platform/transfer</dt><dd>${rp(fee)} flat</dd><dt>Total keluar</dt><dd><b>${rp(val + fee)}</b></dd></dl>
    <p class="hint">Pembayaran langsung ke rekening supplier yang terverifikasi, bukan lewat perantara. Tombol ini mencatat pembayaran dan jurnalnya; transfer bank tetap dilakukan dari mobile/internet banking.</p>${verified(s) ? '' : '<p class="banner warn sm">Rekening supplier ini belum terverifikasi lengkap.</p>'}`,
    footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Bayar sekarang</button>`,
    onMount(m, api) { m.querySelector('[data-ok]').onclick = async () => {
      try { await API.poPay(id); await C.refresh('pos', 'journals'); } catch (err) { return toast(err.message, 'err'); }
      api.close(); toast(`Pembayaran ${rp(val + fee)} ke ${s.name} tercatat`); rerender();
    }; } });
}
