// Kaly Loop — loyalty: dashboard promo, member, smart campaign, misi & tier, birthday treats, halaman white-label
import { getDb } from '../store.js';
import * as API from '../api.js';
import * as C from '../cloud.js';
import { esc, ic, rp, num, pct, toast, openModal, formData, hbars, sum, fmtDate, fmtShort, fmtDT, DAY, copyText, uid, startOfDay, dayKey } from '../lib.js';
import * as D from '../domain.js';
import { rerender } from '../app.js';

const ui = { tab: 'dash', q: '', tier: 'all' };
const SEG = { all: 'Semua member', tier: 'Tier tertentu', inactive: 'Tidak datang N hari', birthday: 'Ulang tahun bulan ini', cat: 'Penggemar kategori', new: 'Member baru 30 hari' };
const month = () => String(new Date().getMonth() + 1).padStart(2, '0');

function catCounts(db) {
  const since = Date.now() - 90 * DAY, m = {};
  for (const o of db.orders) { if (!o.mem || o.status !== 'paid' || o.created < since) continue; for (const l of o.lines) if (!l.pkg && l.s !== 'void') { const c = D.menu(db, l.m)?.cat; const k = o.mem + '|' + c; m[k] = (m[k] || 0) + l.q; } }
  return m;
}
export function segment(db, seg) {
  const now = Date.now();
  if (seg.kind === 'tier') return db.members.filter((m) => D.tierOf(db, m).id === seg.tier);
  if (seg.kind === 'inactive') return db.members.filter((m) => now - (m.last || m.joined) > seg.days * DAY);
  if (seg.kind === 'birthday') return db.members.filter((m) => m.bday?.startsWith(month()));
  if (seg.kind === 'new') return db.members.filter((m) => now - m.joined < 30 * DAY);
  if (seg.kind === 'cat') { const cc = catCounts(db); return db.members.filter((m) => (cc[m.id + '|' + seg.cat] || 0) >= seg.min); }
  return db.members.slice();
}
const segLabel = (db, s) => s.kind === 'tier' ? `Tier ${db.tiers.find((t) => t.id === s.tier)?.name}` : s.kind === 'inactive' ? `Tidak datang ${s.days} hari` : s.kind === 'cat' ? `Beli ${db.cats.find((c) => c.id === s.cat)?.name} minimal ${s.min}× (90 hari)` : SEG[s.kind];
const fillMsg = (db, tpl, m, v) => tpl.replace(/\{nama\}/g, m.name.split(' ')[0]).replace(/\{kode\}/g, v?.code || '').replace(/\{sampai\}/g, v?.until ? fmtDate(v.until) : '').replace(/\{brand\}/g, db.settings.brand.name);
const waLink = (db, m, msg) => `https://wa.me/${D.waPhone(m.phone)}?text=${encodeURIComponent(msg)}`;

function dash(ctx) {
  const db = ctx.db, now = Date.now(), since = now - 30 * DAY;
  const paid = db.orders.filter((o) => o.status === 'paid' && o.created >= since);
  const withMem = paid.filter((o) => o.mem);
  const active = new Set(withMem.map((o) => o.mem)).size;
  const newM = db.members.filter((m) => now - m.joined < 30 * DAY).length;
  const pts = sum(db.members, (m) => m.points);
  const byTier = db.tiers.map((t) => ({ label: t.name, value: db.members.filter((m) => D.tierOf(db, m).id === t.id).length }));
  const promoUse = {};
  paid.forEach((o) => (o.bill.discs || []).filter((d) => d.kind === 'promo').forEach((d) => { const x = (promoUse[d.id] ||= { n: 0, a: 0, rev: 0 }); x.n++; x.a += d.amt; x.rev += o.bill.total; }));
  const memRev = D.sumTotals(withMem), nonRev = D.sumTotals(paid.filter((o) => !o.mem));
  return `<div class="kpis">
      <div class="kpi"><span class="kpi-l">Total member</span><b class="kpi-v">${num(db.members.length)}</b><span class="kpi-d">${newM} baru 30 hari terakhir</span></div>
      <div class="kpi"><span class="kpi-l">Member aktif 30 hari</span><b class="kpi-v">${num(active)}</b><span class="kpi-d">${pct(active / Math.max(1, db.members.length))} dari total</span></div>
      <div class="kpi"><span class="kpi-l">Transaksi oleh member</span><b class="kpi-v">${pct(withMem.length / Math.max(1, paid.length))}</b><span class="kpi-d">rata-rata ${rp(memRev / Math.max(1, withMem.length))} vs ${rp(nonRev / Math.max(1, paid.length - withMem.length))} non-member</span></div>
      <div class="kpi"><span class="kpi-l">Poin beredar</span><b class="kpi-v">${num(pts)}</b><span class="kpi-d">setara ${rp(pts * db.settings.pointValue)}</span></div>
    </div>
    <div class="grid-side"><div>
      <div class="card"><div class="card-h"><h3>Dashboard voucher & campaign</h3></div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Kode</th><th>Nama</th><th class="r">Dipakai</th><th class="r">Penukaran</th><th class="r">Omzet</th><th class="r">Biaya diskon</th><th class="r">ROI</th><th>Status</th></tr></thead><tbody>
        ${db.vouchers.map((v) => { const reach = v.members?.length || v.quota || 0; return `<tr><td><b>${esc(v.code)}</b></td><td>${esc(v.name)}${v.campaign ? ' <span class="badge b-info">campaign</span>' : ''}</td><td class="r">${num(v.used || 0)}${v.quota ? '/' + num(v.quota) : ''}</td><td class="r">${reach ? pct((v.used || 0) / reach) : '—'}</td><td class="r">${rp(v.rev || 0)}</td><td class="r">${rp(v.cost || 0)}</td><td class="r">${v.cost ? num((v.rev || 0) / v.cost, 1) + '×' : '—'}</td><td><button class="badge ${v.active ? 'b-ok' : 'b-mute'}" data-a="vToggle" data-v="${esc(v.code)}" title="Klik untuk ubah">${v.active ? 'Aktif' : 'Nonaktif'}</button></td></tr>`; }).join('')}
      </tbody></table></div><p class="hint">ROI = omzet transaksi yang memakai voucher dibagi biaya diskonnya.</p></div>
      <div class="card"><div class="card-h"><h3>Promo otomatis</h3><span class="muted sm">30 hari terakhir</span></div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Promo</th><th>Aturan</th><th class="r">Transaksi</th><th class="r">Total diskon</th><th>Status</th></tr></thead><tbody>
        ${db.promos.map((p) => { const u = promoUse[p.id] || { n: 0, a: 0 }; return `<tr><td><b>${esc(p.name)}</b></td><td class="muted">${p.type === 'pct-cat' ? `${Math.round(p.pct * 100)}% ${esc(db.cats.find((c) => c.id === p.cat)?.name)}, ${p.from}–${p.to}${p.days?.length === 5 ? ', Senin–Jumat' : ''}` : `Beli ${p.buy} gratis ${p.free} ${esc(D.menu(db, p.menu)?.name)}`}</td><td class="r">${num(u.n)}</td><td class="r">${rp(u.a)}</td><td><button class="badge ${p.active ? 'b-ok' : 'b-mute'}" data-a="pToggle" data-id="${p.id}">${p.active ? (D.promoActive(p) ? 'Berlaku sekarang' : 'Aktif') : 'Nonaktif'}</button></td></tr>`; }).join('')}
      </tbody></table></div></div></div>
      <aside><div class="card"><div class="card-h"><h3>Member per tier</h3></div>${hbars(byTier, { fmt: (v) => num(v) + ' orang' })}</div>
        <div class="card"><div class="card-h"><h3>Asal pendaftaran</h3></div>${hbars(Object.entries(db.members.reduce((m, x) => { m[x.src] = (m[x.src] || 0) + 1; return m; }, {})).map(([k, v]) => ({ label: { kasir: 'Kasir', qr: 'QR meja', web: 'Pesan online', instagram: 'Instagram', member: 'Halaman member', book: 'Reservasi' }[k] || k, value: v })).sort((a, b) => b.value - a.value), { fmt: (v) => num(v) })}</div></aside></div>`;
}

function members(ctx) {
  const db = ctx.db, q = ui.q.toLowerCase();
  const ms = db.members.filter((m) => (!q || m.name.toLowerCase().includes(q) || m.phone.includes(q)) && (ui.tier === 'all' || D.tierOf(db, m).id === ui.tier)).sort((a, b) => b.spend - a.spend);
  return `<div class="row sb wrap"><div class="row"><div class="search">${ic('search', 17)}<input id="lp-q" data-in="q" placeholder="Cari nama atau HP" value="${esc(ui.q)}"></div>
    <div class="chips">${[['all', 'Semua tier'], ...db.tiers.map((t) => [t.id, t.name])].map(([k, l]) => `<button class="chip ${ui.tier === k ? 'on' : ''}" data-a="tierF" data-v="${k}">${esc(l)}</button>`).join('')}</div></div>
    <button class="btn btn-pri" data-a="memNew">${ic('plus', 16)} Member baru</button></div>
    <div class="card"><div class="tbl-wrap"><table class="tbl hover"><thead><tr><th>Nama</th><th>No. HP</th><th>Tier</th><th class="r">Poin</th><th class="r">Total belanja</th><th class="r">Kunjungan</th><th>Terakhir datang</th><th>Ulang tahun</th></tr></thead><tbody>
    ${ms.slice(0, 120).map((m) => `<tr data-a="memView" data-id="${m.id}"><td><b>${esc(m.name)}</b></td><td>${esc(m.phone)}</td><td><span class="badge b-gold">${esc(D.tierOf(db, m).name)}</span></td><td class="r">${num(m.points)}</td><td class="r">${rp(m.spend)}</td><td class="r">${num(m.visits)}</td><td>${m.last ? fmtShort(m.last) : '—'}</td><td>${m.bday ? esc(m.bday.split('-').reverse().join('/')) : '—'}</td></tr>`).join('')}
    </tbody></table></div><p class="hint">${ms.length} member. Pelanggan yang mengisi nama dan nomor WhatsApp di halaman pesan, reservasi, atau kasir otomatis jadi member.</p></div>`;
}

function campaigns(ctx) {
  const db = ctx.db;
  return `<div class="row sb wrap"><p class="muted">Smart campaign mengirim voucher hanya ke segmen yang relevan. Voucher otomatis dibatasi untuk member di segmen itu, lalu hasilnya terlihat di dashboard.</p><button class="btn btn-pri" data-a="campNew">${ic('megaphone', 16)} Campaign baru</button></div>
    <div class="camp-list">${db.campaigns.slice().reverse().map((c) => { const v = db.vouchers.find((x) => x.code === c.voucher); return `<article class="card camp"><div class="card-h"><h3>${esc(c.name)}</h3><span class="badge ${v?.active ? 'b-ok' : 'b-mute'}">${v?.active ? 'Aktif' : 'Selesai'}</span></div>
      <p class="muted">${esc(segLabel(db, c.seg))}. Voucher <b>${esc(c.voucher)}</b>, dibuat ${fmtDate(c.created)}.</p>
      <div class="camp-stats"><div><small>Jangkauan</small><b>${num(c.reach.length)}</b></div><div><small>Dipakai</small><b>${num(v?.used || 0)}</b></div><div><small>Penukaran</small><b>${pct((v?.used || 0) / Math.max(1, c.reach.length))}</b></div><div><small>Omzet</small><b>${rp(v?.rev || 0)}</b></div></div>
      <button class="btn btn-sm" data-a="campView" data-id="${c.id}">${ic('send', 15)} Kirim via WhatsApp</button></article>`; }).join('') || '<p class="empty">Belum ada campaign.</p>'}</div>`;
}

function tiers(ctx) {
  const db = ctx.db;
  return `<div class="grid2"><div class="card"><div class="card-h"><h3>Tier membership</h3><span class="muted sm">naik otomatis berdasarkan total belanja</span></div>
      <form data-submit="saveTiers"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Tier</th><th>Min. belanja</th><th>Diskon</th><th>Pengali poin</th></tr></thead><tbody>${db.tiers.map((t, i) => `<tr><td><b>${esc(t.name)}</b></td><td><input class="inp inp-num" name="min${i}" type="number" step="100000" value="${t.min}" ${i === 0 ? 'readonly' : ''}></td><td><input class="inp inp-xs" name="disc${i}" type="number" step="1" value="${Math.round(t.disc * 100)}">%</td><td><input class="inp inp-xs" name="mult${i}" type="number" step="0.05" value="${t.mult}">×</td></tr><tr><td></td><td colspan="3"><input class="inp" name="perks${i}" value="${esc(t.perks)}" aria-label="Keuntungan ${esc(t.name)}"></td></tr>`).join('')}</tbody></table></div><button class="btn btn-pri">Simpan tier</button></form></div>
    <div class="card"><div class="card-h"><h3>Misi bulanan</h3><button class="btn btn-sm" data-a="misNew">${ic('plus', 14)} Misi baru</button></div>
      <ul class="missions">${db.missions.map((m) => { const done = db.members.filter((x) => x.missions?.[m.id]?.done).length; return `<li><div><b>${esc(m.name)}</b><small>${esc(m.desc)}. Hadiah ${m.reward} poin. ${done} member selesai bulan ini.</small></div><button class="badge ${m.active ? 'b-ok' : 'b-mute'}" data-a="misToggle" data-id="${m.id}">${m.active ? 'Aktif' : 'Nonaktif'}</button></li>`; }).join('')}</ul>
      <p class="hint">Progres misi dihitung otomatis dari setiap transaksi member dan direset tiap awal bulan.</p></div></div>`;
}

function birthday(ctx) {
  const db = ctx.db, y = new Date().getFullYear();
  const ms = db.members.filter((m) => m.bday?.startsWith(month())).sort((a, b) => a.bday.localeCompare(b.bday));
  const vOf = (m) => db.vouchers.find((v) => v.code === `ULTAH${y % 100}-${m.id.toUpperCase()}`);
  return `<div class="row sb wrap"><p class="muted">${ms.length} member berulang tahun bulan ini. Birthday treat: voucher personal ${Math.round(db.settings.birthdayPct * 100)}% (maks. Rp50.000) berlaku 30 hari.</p><button class="btn btn-pri" data-a="bdayGen">${ic('cake', 16)} Buat voucher untuk semua</button></div>
    <div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Nama</th><th>Tanggal</th><th>Tier</th><th>Voucher</th><th></th></tr></thead><tbody>${ms.map((m) => { const v = vOf(m); return `<tr><td><b>${esc(m.name)}</b><br><small class="muted">${esc(m.phone)}</small></td><td>${esc(m.bday.split('-').reverse().join('/'))}</td><td>${esc(D.tierOf(db, m).name)}</td><td>${v ? `<b>${esc(v.code)}</b> ${v.used ? '<span class="badge b-ok">dipakai</span>' : ''}` : '<span class="muted">belum dibuat</span>'}</td><td>${v ? `<a class="btn btn-sm" target="_blank" rel="noopener" href="${waLink(db, m, fillMsg(db, 'Selamat ulang tahun, {nama}! Ada hadiah dari {brand}: diskon ulang tahun pakai kode {kode}, berlaku sampai {sampai}. Kambing-kambing di sawah juga titip salam.', m, v))}">${ic('send', 14)} WhatsApp</a>` : ''}</td></tr>`; }).join('') || '<tr><td colspan="5" class="empty">Tidak ada member yang berulang tahun bulan ini.</td></tr>'}</tbody></table></div></div>`;
}

function whitelabel(ctx) {
  const b = ctx.db.settings.brand, base = location.href.split('#')[0];
  return `<div class="grid2"><form class="card" data-submit="saveBrand"><div class="card-h"><h3>Tampilan halaman pelanggan</h3></div>
      <p class="muted">Dipakai di halaman member, pesan online, reservasi, Lounge, dan layar pelanggan.</p>
      <label class="fld"><span>Nama brand</span><input name="name" value="${esc(b.name)}"></label><label class="fld"><span>Tagline</span><input name="tagline" value="${esc(b.tagline)}"></label>
      <div class="grid2"><label class="fld"><span>Warna utama</span><input name="color" type="color" value="${esc(b.color)}"></label><label class="fld"><span>Warna aksen</span><input name="accent" type="color" value="${esc(b.accent)}"></label></div>
      <button class="btn btn-pri">Simpan tampilan</button></form>
    <div class="card"><div class="card-h"><h3>Bagikan halaman member</h3></div>
      <p>Pasang link ini di bio Instagram, struk, atau balasan WhatsApp. Pelanggan cukup isi nomor HP untuk cek poin atau daftar.</p>
      <div class="row"><input class="inp" readonly value="${esc(base)}#/member"><button class="btn" data-a="copyM">${ic('copy', 16)} Salin</button><a class="btn" href="#/member" target="_blank" rel="noopener">${ic('external-link', 16)} Buka</a></div>
      <p class="hint">Di versi produksi, halaman ini bisa dipasang di domain sendiri, misalnya member.kalyeatery.id.</p></div></div>`;
}

const V = {
  render(ctx) {
    const tabs = [['dash', 'Dashboard promo'], ['mem', 'Member'], ['camp', 'Smart campaign'], ['tier', 'Tier & misi'], ['bday', 'Birthday treats'], ['wl', 'Halaman member']];
    const body = { dash, mem: members, camp: campaigns, tier: tiers, bday: birthday, wl: whitelabel }[ui.tab](ctx);
    return `<div class="tabs scroll">${tabs.map(([k, l]) => `<button class="tab ${ui.tab === k ? 'on' : ''}" data-a="tab" data-v="${k}">${l}</button>`).join('')}</div><div class="tabbody">${body}</div>`;
  },
  input(k, el) { if (k === 'q') { ui.q = el.value; rerender(); } },
  actions: {
    tab(el) { ui.tab = el.dataset.v; rerender(); },
    tierF(el) { ui.tier = el.dataset.v; rerender(); },
    async vToggle(el) { const v = getDb().vouchers.find((x) => x.code === el.dataset.v); await API.tableUpdate('vouchers', { code: v.code }, { active: !v.active }); await C.refresh('loyalty'); rerender(); },
    async pToggle(el) { const p = getDb().promos.find((x) => x.id === el.dataset.id); await API.tableUpdate('promos', { id: p.id }, { active: !p.active }); await C.refresh('loyalty'); rerender(); },
    async misToggle(el) { const m = getDb().missions.find((x) => x.id === el.dataset.id); await API.tableUpdate('missions', { id: m.id }, { active: !m.active }); await C.refresh('loyalty'); rerender(); },
    memView(el, e, ctx) {
      const db = ctx.db, m = D.member(db, el.dataset.id), t = D.tierOf(db, m), nt = D.nextTier(db, m);
      const hist = db.orders.filter((o) => o.mem === m.id && o.status === 'paid').slice(-8).reverse();
      const vs = db.vouchers.filter((v) => v.active && v.members?.includes(m.id));
      openModal({ title: m.name, size: 'lg', body: `<div class="grid2"><div>
          <dl class="kv"><dt>No. HP</dt><dd><a class="lnk" href="https://wa.me/${D.waPhone(m.phone)}" target="_blank" rel="noopener">${esc(m.phone)}</a></dd><dt>Tier</dt><dd><span class="badge b-gold">${esc(t.name)}</span></dd><dt>Poin</dt><dd>${num(m.points)}</dd><dt>Total belanja</dt><dd>${rp(m.spend)}</dd><dt>Kunjungan</dt><dd>${m.visits}</dd><dt>Bergabung</dt><dd>${fmtDate(m.joined)}</dd></dl>
          ${nt ? `<p class="muted sm">${rp(nt.min - m.spend)} lagi untuk naik ke ${esc(nt.name)}</p><div class="prog"><i style="width:${Math.min(100, (m.spend / nt.min) * 100)}%"></i></div>` : '<p class="muted sm">Sudah di tier tertinggi</p>'}
          <h4 class="sec-t">Misi bulan ini</h4><ul class="list">${db.missions.filter((x) => x.active).map((x) => { const s = m.missions?.[x.id]; const p = s?.month === dayKey().slice(0, 7) ? s.p : 0; return `<li><span>${esc(x.name)}<small>${esc(x.desc)}</small></span><span>${s?.done ? '<span class="badge b-ok">Selesai</span>' : `${Math.min(p, x.target)}/${x.target}`}</span></li>`; }).join('')}</ul>
          ${vs.length ? `<h4 class="sec-t">Voucher khusus</h4><ul class="list">${vs.map((v) => `<li><span><b>${esc(v.code)}</b><small>${esc(v.name)}</small></span></li>`).join('')}</ul>` : ''}</div>
        <div><h4 class="sec-t">Transaksi terakhir</h4><ul class="list">${hist.map((o) => `<li><span>${fmtDT(o.created)}<small>${o.lines.filter((l) => !l.par).map((l) => esc(l.n)).slice(0, 3).join(', ')}</small></span><b>${rp(o.bill.total)}</b></li>`).join('') || '<li class="empty sm">Belum ada transaksi tercatat.</li>'}</ul>
          <h4 class="sec-t">Sesuaikan poin</h4><div class="row"><input class="inp inp-num" type="number" name="adj" placeholder="+50 / -20"><input class="inp" name="why" placeholder="Alasan"><button class="btn btn-sm" data-adj>Simpan</button></div></div></div>`,
        onMount(mm, api) {
          const adj = mm.querySelector('[data-adj]');
          if (ctx.user.role !== 'owner') { adj.closest('.row').outerHTML = '<p class="hint">Penyesuaian poin manual hanya bisa dilakukan Owner.</p>'; return; }
          adj.onclick = async () => { const a = Math.round(Number(mm.querySelector('[name=adj]').value)); const w = mm.querySelector('[name=why]').value.trim(); if (!a || !w) return toast('Isi jumlah poin dan alasan', 'warn'); try { await API.adjustPoints(m.id, a, w); await C.refresh('members', 'flags'); } catch (e) { return toast(e.message, 'err'); } api.close(); toast('Poin disesuaikan'); rerender(); };
        } });
    },
    memNew(el, e, ctx) {
      openModal({ title: 'Member baru', size: 'sm', body: `<label class="fld"><span>Nama</span><input name="n" autofocus></label><label class="fld"><span>No. WhatsApp</span><input name="p" inputmode="tel"></label><label class="fld"><span>Tanggal lahir</span><input name="b" type="date"></label>`,
        footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Simpan</button>`,
        onMount(m, api) { m.querySelector('[data-ok]').onclick = async () => { const f = formData(m); if (!f.n.trim() || D.normPhone(f.p).length < 9) return toast('Isi nama dan nomor HP yang valid', 'warn'); let r; try { r = (await API.upsertMember({ name: f.n.trim(), phone: f.p, bday: f.b ? f.b.slice(5) : '', src: 'kasir' })).created; await C.refresh('members'); } catch (e) { return toast(e.message, 'err'); } api.close(); toast(r ? 'Member baru terdaftar' : 'Nomor sudah terdaftar'); rerender(); }; } });
    },
    campNew(el, e, ctx) {
      const db = getDb();
      let seg = { kind: 'inactive', days: 30, tier: 'tunas', cat: 'coffee', min: 3 };
      const draw = () => {
        const list = segment(db, seg);
        return `<div class="grid2"><label class="fld"><span>Nama campaign</span><input name="name" value="Weekend di sawah"></label><label class="fld"><span>Segmen</span><select data-seg="kind">${Object.entries(SEG).map(([k, l]) => `<option value="${k}" ${seg.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          ${seg.kind === 'tier' ? `<label class="fld"><span>Tier</span><select data-seg="tier">${db.tiers.map((t) => `<option value="${t.id}" ${seg.tier === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>` : ''}
          ${seg.kind === 'inactive' ? `<label class="fld"><span>Tidak datang selama (hari)</span><input type="number" data-seg="days" value="${seg.days}"></label>` : ''}
          ${seg.kind === 'cat' ? `<label class="fld"><span>Kategori</span><select data-seg="cat">${db.cats.map((c) => `<option value="${c.id}" ${seg.cat === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label><label class="fld"><span>Minimal beli (90 hari)</span><input type="number" data-seg="min" value="${seg.min}"></label>` : ''}</div>
          <p class="seg-count">${ic('users', 18)} <b>${list.length}</b> member masuk segmen ini</p>
          <div class="grid3"><label class="fld"><span>Jenis diskon</span><select name="type"><option value="pct">Persen</option><option value="amt">Nominal</option></select></label><label class="fld"><span>Nilai (% atau Rp)</span><input name="value" type="number" value="20"></label><label class="fld"><span>Maks. potongan</span><input name="max" type="number" value="30000"></label>
          <label class="fld"><span>Min. belanja</span><input name="min" type="number" value="75000"></label><label class="fld"><span>Berlaku (hari)</span><input name="days" type="number" value="14"></label><label class="fld"><span>Kode voucher</span><input name="code" placeholder="otomatis"></label></div>
          <label class="fld"><span>Pesan WhatsApp</span><textarea name="msg" rows="3">Halo {nama}, ada promo spesial dari {brand}. Pakai kode {kode} untuk diskon, berlaku sampai {sampai}. Sampai jumpa di sawah!</textarea></label><p class="hint">Gunakan {nama}, {kode}, {sampai}, {brand}.</p>`;
      };
      openModal({ title: 'Smart campaign baru', size: 'lg', body: draw(), footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Buat campaign</button>`,
        onMount(m, api) {
          const keep = () => { const f = {}; m.querySelectorAll('[name]').forEach((x) => (f[x.name] = x.value)); return f; };
          m.addEventListener('change', (ev) => { const k = ev.target.dataset.seg; if (!k) return; const f = keep(); seg[k] = ['days', 'min'].includes(k) ? Number(ev.target.value) : ev.target.value; api.set(draw()); m.querySelectorAll('[name]').forEach((x) => { if (f[x.name] !== undefined) x.value = f[x.name]; }); });
          m.querySelector('[data-ok]').onclick = async () => {
            const f = keep();
            const list = segment(getDb(), seg);
            if (!list.length) return toast('Segmen kosong. Ubah kriteria.', 'warn');
            const code = (f.code || f.name.replace(/[^a-z]/gi, '').slice(0, 8) + Math.floor(Math.random() * 90 + 10)).toUpperCase();
            if (getDb().vouchers.some((v) => v.code === code)) return toast('Kode voucher sudah dipakai', 'err');
            const s = { kind: seg.kind, ...(seg.kind === 'tier' ? { tier: seg.tier } : seg.kind === 'inactive' ? { days: seg.days } : seg.kind === 'cat' ? { cat: seg.cat, min: seg.min } : {}) };
            const id = uid('c');
            const until = new Date(Date.now() + (Number(f.days) || 14) * DAY).toISOString();
            try {
              await API.tableInsert('campaigns', { id, name: f.name, segment: s, voucher_code: code, message: f.msg, reach: list.map((x) => x.id), sent: 0, status: 'aktif' });
              await API.tableInsert('vouchers', { code, name: f.name, type: f.type, value: f.type === 'pct' ? Number(f.value) / 100 : Number(f.value), max_disc: Number(f.max) || 0, min_spend: Number(f.min) || 0,
                quota: list.length, active: true, until, campaign_id: id, member_ids: list.map((x) => x.id) });
              await C.refresh('loyalty');
            } catch (e) { return toast(e.message, 'err', 6000); }
            api.close(); toast(`Campaign dibuat untuk ${list.length} member`); rerender();
            setTimeout(() => V.actions.campView({ dataset: { id } }, null, { db: getDb() }), 100);
          };
        } });
    },
    campView(el, e, ctx) {
      const db = getDb(), c = db.campaigns.find((x) => x.id === el.dataset.id), v = db.vouchers.find((x) => x.code === c.voucher);
      const ms = c.reach.map((id) => D.member(db, id)).filter(Boolean);
      openModal({ title: `Kirim ${c.name}`, size: 'lg', body: `<p class="muted">Klik tombol WhatsApp di tiap baris untuk membuka chat dengan pesan yang sudah terisi. Pengiriman massal otomatis perlu WhatsApp Business API.</p>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Member</th><th>Pesan</th><th></th></tr></thead><tbody>${ms.slice(0, 80).map((m) => { const msg = fillMsg(db, c.msg, m, v); return `<tr><td><b>${esc(m.name)}</b><br><small class="muted">${esc(m.phone)}</small></td><td class="muted sm">${esc(msg)}</td><td><a class="btn btn-sm" href="${waLink(db, m, msg)}" target="_blank" rel="noopener">${ic('send', 14)} WhatsApp</a></td></tr>`; }).join('')}</tbody></table></div>${ms.length > 80 ? `<p class="hint">Menampilkan 80 dari ${ms.length} member.</p>` : ''}` });
    },
    async saveTiers(form) {
      const f = Object.fromEntries(new FormData(form));
      await Promise.all(getDb().tiers.map((t, i) => API.tableUpdate('tiers', { id: t.id }, { min_spend: i > 0 ? Number(f['min' + i]) || t.min : t.min, discount: (Number(f['disc' + i]) || 0) / 100, multiplier: Number(f['mult' + i]) || 1, perks: f['perks' + i] || '' })));
      await C.refresh('loyalty');
      toast('Tier disimpan'); rerender();
    },
    misNew(el, e, ctx) {
      const db = getDb();
      openModal({ title: 'Misi baru', size: 'md', body: `<div class="grid2"><label class="fld"><span>Nama misi</span><input name="name" value="Pencinta rawon"></label><label class="fld"><span>Jenis</span><select name="kind"><option value="menu">Beli menu tertentu</option><option value="cat">Beli kategori</option><option value="visits">Jumlah kunjungan</option></select></label>
        <label class="fld"><span>Menu</span><select name="menu">${db.menus.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></label><label class="fld"><span>Kategori</span><select name="cat">${db.cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
        <label class="fld"><span>Target</span><input name="target" type="number" value="3"></label><label class="fld"><span>Hadiah poin</span><input name="reward" type="number" value="30"></label></div><label class="fld"><span>Deskripsi untuk pelanggan</span><input name="desc" value="Pesan 3 Rawon Daging bulan ini"></label>`,
        footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Simpan</button>`,
        onMount(m, api) { m.querySelector('[data-ok]').onclick = async () => { const f = formData(m); try { await API.tableInsert('missions', { id: uid('ms'), name: f.name, description: f.desc, kind: f.kind, menu_id: f.kind === 'menu' ? f.menu : null, category_id: f.kind === 'cat' ? f.cat : null, target: Number(f.target) || 1, reward: Number(f.reward) || 0, active: true }); await C.refresh('loyalty'); } catch (e) { return toast(e.message, 'err'); } api.close(); toast('Misi ditambahkan'); rerender(); }; } });
    },
    async bdayGen(el, e, ctx) {
      const n = await API.birthdayVouchers();
      await C.refresh('loyalty');
      toast(n ? `${n} voucher ulang tahun dibuat` : 'Semua member sudah punya voucher ulang tahun tahun ini', n ? 'ok' : 'info'); rerender();
    },
    async saveBrand(form) { const f = Object.fromEntries(new FormData(form)); const b = getDb().settings.brand; await API.saveSettings({ brand: { name: f.name || b.name, tagline: f.tagline, color: f.color, accent: f.accent } }); await C.refresh('settings'); toast('Tampilan disimpan'); rerender(); },
    copyM() { copyText(location.href.split('#')[0] + '#/member'); },
  },
};
export default V;
