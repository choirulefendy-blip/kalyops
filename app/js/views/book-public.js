// Kaly Book (pelanggan) — reservasi meja, bisa dipasang di Instagram, WhatsApp, website (embed)
import { esc, ic, toast, fmtDate, dayKey, fromKey, DAY, logo } from '../lib.js';
import * as C from '../cloud.js';
import { rerender } from '../app.js';

let st = null, info = null, infoLoading = false;
const slots = { key: null, list: null };
const norm = (p) => { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('62')) d = '0' + d.slice(2); return d; };
function loadInfo() {
  if (infoLoading) return; infoLoading = true;
  C.rpc('public_book_info').then((r) => { info = r; }).catch((e) => toast(e.message, 'err')).finally(() => { infoLoading = false; rerender(); });
}
function loadSlots() {
  const key = `${st.date}|${st.pax}|${st.area}`;
  if (slots.key === key) return slots.list;
  slots.key = key; slots.list = null;
  C.rpc('public_slots', { p_date: st.date, p_pax: st.pax, p_area: st.area || '' }).then((r) => { if (slots.key === key) { slots.list = r || []; rerender(); } }).catch((e) => toast(e.message, 'err'));
  return null;
}

export default {
  render(ctx) {
    const embed = ctx.q.embed === '1';
    if (!C.configured) return `<div class="load-pane"><p>Halaman ini belum tersambung ke database.</p></div>`;
    if (!info) { loadInfo(); return `<div class="load-pane">${logo('olive')}<p>Memuat…</p></div>`; }
    const b = info.brand || {};
    st ||= { date: dayKey(), time: '', pax: 2, area: '', name: '', phone: '', note: '', member: true, done: null };
    const head = embed ? '' : `<header class="shop-h terrace"><div class="shop-brand">${logo('light')}<small>Reservasi meja & gazebo</small></div></header>`;
    const wrap = (inner) => `<div class="shop ${embed ? 'embed' : ''}" style="--brand:${esc(b.color)};--accent:${esc(b.accent)}">${head}<main class="book">${inner}</main></div>`;
    if (st.done) {
      const r = st.done;
      return wrap(`<div class="book-ok">${ic('circle-check', 48)}<h2>${r.status === 'dikonfirmasi' ? 'Reservasi terkonfirmasi' : 'Reservasi diterima'}</h2>
        <p>${r.status === 'dikonfirmasi' ? 'Sampai jumpa!' : 'Tim kami akan mengonfirmasi lewat WhatsApp dalam waktu singkat.'}</p>
        <dl class="kv"><dt>Kode</dt><dd><b>${esc(r.code)}</b></dd><dt>Tanggal</dt><dd>${fmtDate(fromKey(r.date), true)}</dd><dt>Jam</dt><dd>${esc(r.time)}</dd><dt>Tamu</dt><dd>${r.pax} orang</dd><dt>Meja</dt><dd>${esc(r.tables || r.area || 'Disiapkan tim kami')}</dd></dl>
        <a class="btn btn-brand btn-block btn-lg" href="#/order?res=${esc(r.code)}">${ic('utensils', 18)} Pesan menu duluan</a>
        <p class="hint">Pesan menu sekarang, makanan disiapkan saat kamu tiba. Mau main sambil menunggu? Ada kambing dan kolam pancing.</p>
        <button class="btn btn-block btn-ghost" data-a="again">Buat reservasi lain</button></div>`);
    }
    const days = Array.from({ length: 14 }, (_, i) => dayKey(Date.now() + i * DAY));
    const list = loadSlots();
    return wrap(`<h2>Reservasi meja</h2><p class="muted">Pilih tanggal, jumlah tamu, dan jam. Kami siapkan meja terbaik yang tersedia.</p>
      <h3 class="sec-t">Tanggal</h3><div class="hscroll days">${days.map((d) => { const t = fromKey(d); return `<button class="day ${st.date === d ? 'on' : ''}" data-a="d" data-v="${d}"><small>${['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'][new Date(t).getDay()]}</small><b>${new Date(t).getDate()}</b></button>`; }).join('')}</div>
      <div class="grid2"><div><h3 class="sec-t">Jumlah tamu</h3><span class="qty lg"><button data-a="pax" data-d="-1" aria-label="Kurangi">${ic('minus', 16)}</button><b>${st.pax}</b><button data-a="pax" data-d="1" aria-label="Tambah">${ic('plus', 16)}</button></span></div>
        <div><h3 class="sec-t">Area</h3><div class="chips">${[['', 'Bebas'], ...(info.areas || []).map((a) => [a, a])].map(([k, l]) => `<button class="chip ${st.area === k ? 'on' : ''}" data-a="area" data-v="${esc(k)}">${esc(l)}</button>`).join('')}</div></div></div>
      <h3 class="sec-t">Jam</h3><div class="slots">${list ? list.map((x) => `<button class="slot ${st.time === x.time ? 'on' : ''}" data-a="t" data-v="${x.time}" ${x.available ? '' : 'disabled'}>${x.time}</button>`).join('') || '<p class="muted sm">Tidak ada jam tersisa di tanggal ini.</p>' : '<p class="muted sm">Mengecek meja kosong…</p>'}</div>
      <h3 class="sec-t">Data pemesan</h3>
      <div class="grid2"><label class="fld"><span>Nama</span><input id="b-name" data-in="b" data-k="name" value="${esc(st.name)}" autocomplete="name"></label><label class="fld"><span>No. WhatsApp</span><input id="b-phone" data-in="b" data-k="phone" inputmode="tel" value="${esc(st.phone)}" autocomplete="tel"></label></div>
      <label class="fld"><span>Catatan (opsional)</span><input id="b-note" data-in="b" data-k="note" value="${esc(st.note)}" placeholder="Contoh: ulang tahun, bawa balita, mau mancing"></label>
      <label class="switch"><input type="checkbox" data-in="b" data-k="member" ${st.member ? 'checked' : ''}><span>Daftarkan saya sebagai member Kaly Loop</span></label>
      <button class="btn btn-brand btn-block btn-lg" data-a="submit">Reservasi ${st.time ? `pukul ${st.time}` : ''}</button>`);
  },
  input(k, el) { st[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value; },
  actions: {
    d(el) { st.date = el.dataset.v; st.time = ''; rerender(); },
    t(el) { st.time = el.dataset.v; rerender(); },
    pax(el) { st.pax = Math.max(1, Math.min(20, st.pax + Number(el.dataset.d))); st.time = ''; rerender(); },
    area(el) { st.area = el.dataset.v; st.time = ''; rerender(); },
    again() { st = null; rerender(); },
    async submit(el, e, ctx) {
      if (!st.time) return toast('Pilih jam reservasi', 'warn');
      if (!st.name.trim()) return toast('Isi nama pemesan', 'warn');
      if (norm(st.phone).length < 9) return toast('Isi nomor WhatsApp yang valid', 'warn');
      el.disabled = true;
      let r;
      try { r = await C.rpc('public_book', { p: { name: st.name.trim(), phone: st.phone, date: st.date, time: st.time, pax: st.pax, area: st.area, note: st.note, member: !!st.member, source: ctx.q.src || 'web' } }); }
      catch (err) { el.disabled = false; return toast(err.message, 'err'); }
      if (!r?.ok) { el.disabled = false; slots.key = null; rerender(); return toast(r?.msg || 'Jam itu baru saja penuh. Pilih jam lain.', 'err'); }
      st.done = { code: r.code, status: r.status, tables: r.tables, date: st.date, time: st.time, pax: st.pax, area: st.area };
      slots.key = null; rerender();
    },
  },
};
