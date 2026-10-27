// Kaly Book (admin) — jadwal meja, daftar reservasi, pasang di channel marketing
import { local, getDb } from '../store.js';
import * as API from '../api.js';
import * as C from '../cloud.js';
import { esc, ic, rp, num, pct, toast, openModal, formData, hbars, sum, fmtDate, fmtShort, DAY, dayKey, fromKey, qrSvg, copyText, uid } from '../lib.js';
import * as D from '../domain.js';
import { rerender, go } from '../app.js';

const ui = { tab: 'jadwal', date: null, f: 'aktif' };
export const RES_ST = { menunggu: 'b-warn', dikonfirmasi: 'b-info', datang: 'b-ok', selesai: 'b-mute', batal: 'b-err', 'no-show': 'b-err' };
const SRC = { web: 'Website', instagram: 'Instagram', whatsapp: 'WhatsApp', telepon: 'Telepon', 'walk-in': 'Walk-in', google: 'Google Maps' };
const H0 = 9, H1 = 22;

function jadwal(ctx) {
  const db = ctx.db, date = ui.date || dayKey();
  const rs = db.reservations.filter((r) => r.date === date).sort((a, b) => a.time.localeCompare(b.time));
  const act = rs.filter((r) => D.RES_ACTIVE.includes(r.status));
  const dur = db.settings.resDuration;
  const span = (H1 - H0) * 60;
  const pos = (r) => { const [h, m] = r.time.split(':').map(Number); return { l: ((h - H0) * 60 + m) / span * 100, w: dur / span * 100 }; };
  const nowPos = date === dayKey() ? ((new Date().getHours() - H0) * 60 + new Date().getMinutes()) / span * 100 : -1;
  return `<div class="row sb wrap"><div class="row daynav"><button class="btn-icon" data-a="day" data-d="-1" aria-label="Hari sebelumnya">${ic('chevron-left')}</button><input type="date" class="inp" data-a-change="date" value="${date}" aria-label="Tanggal"><button class="btn-icon" data-a="day" data-d="1" aria-label="Hari berikutnya">${ic('chevron-right')}</button><button class="btn btn-sm" data-a="today">Hari ini</button></div>
      <button class="btn btn-pri" data-a="resNew">${ic('plus', 16)} Reservasi baru</button></div>
    <div class="kpis"><div class="kpi"><span class="kpi-l">Reservasi ${date === dayKey() ? 'hari ini' : fmtShort(fromKey(date))}</span><b class="kpi-v">${act.length}</b></div><div class="kpi"><span class="kpi-l">Total tamu</span><b class="kpi-v">${sum(act, (r) => r.pax)}</b></div><div class="kpi"><span class="kpi-l">Menunggu konfirmasi</span><b class="kpi-v ${rs.filter((r) => r.status === 'menunggu').length ? 'neg' : ''}">${rs.filter((r) => r.status === 'menunggu').length}</b></div><div class="kpi"><span class="kpi-l">Meja terpakai</span><b class="kpi-v">${new Set(act.map((r) => r.table)).size}<small>/${db.tables.length}</small></b></div></div>
    <div class="card tl-card"><div class="tl" style="--cols:${H1 - H0}">
      <div class="tl-head"><span></span><div class="tl-hours">${Array.from({ length: H1 - H0 }, (_, i) => `<span>${H0 + i}</span>`).join('')}</div></div>
      ${db.areas.map((a) => `<div class="tl-area">${esc(a)}</div>${db.tables.filter((t) => t.area === a).map((t) => `<div class="tl-row"><span class="tl-t">${t.id}<small>${t.seats}</small></span><div class="tl-track">${nowPos >= 0 && nowPos <= 100 ? `<i class="tl-now" style="left:${nowPos}%"></i>` : ''}
        ${rs.filter((r) => D.resTables(r).includes(t.id) && r.status !== 'batal').map((r) => { const p = pos(r); return `<button class="tl-b st-${r.status}" style="left:${p.l}%;width:${p.w}%" data-a="resView" data-id="${r.id}" title="${esc(r.name)}, ${r.pax} orang, ${r.time}">${esc(r.time)} ${esc(r.name)} (${r.pax})</button>`; }).join('')}</div></div>`).join('')}`).join('')}
    </div></div>
    <div class="card"><div class="card-h"><h3>Daftar ${fmtDate(fromKey(date), true)}</h3></div>${resTable(db, rs)}</div>`;
}
function resTable(db, rs, showDate) {
  return `<div class="tbl-wrap"><table class="tbl hover"><thead><tr>${showDate ? '<th>Tanggal</th>' : ''}<th>Jam</th><th>Nama</th><th class="r">Tamu</th><th>Meja</th><th>Sumber</th><th>Catatan</th><th>Status</th></tr></thead><tbody>
    ${rs.map((r) => `<tr data-a="resView" data-id="${r.id}">${showDate ? `<td>${fmtShort(fromKey(r.date))}</td>` : ''}<td><b>${esc(r.time)}</b></td><td>${esc(r.name)}<br><small class="muted">${esc(r.code)}</small></td><td class="r">${r.pax}</td><td>${esc(r.table || '—')}</td><td>${SRC[r.src] || esc(r.src)}</td><td class="muted">${esc(r.note || '')}${r.order ? ' <span class="badge b-info">pre-order</span>' : ''}</td><td><span class="badge ${RES_ST[r.status]}">${esc(r.status)}</span></td></tr>`).join('') || `<tr><td colspan="${showDate ? 8 : 7}" class="empty">Belum ada reservasi.</td></tr>`}</tbody></table></div>`;
}
function daftar(ctx) {
  const db = ctx.db, today = dayKey();
  const up = db.reservations.filter((r) => r.date >= today && (ui.f === 'semua' || (ui.f === 'aktif' ? D.RES_ACTIVE.includes(r.status) : r.status === ui.f))).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const wk = db.reservations.filter((r) => r.date >= today && r.date <= dayKey(Date.now() + 6 * DAY) && D.RES_ACTIVE.includes(r.status));
  const past = db.reservations.filter((r) => r.date < today && r.date >= dayKey(Date.now() - 30 * DAY));
  const ns = past.filter((r) => r.status === 'no-show').length;
  const bySrc = Object.entries(db.reservations.reduce((m, r) => { m[r.src] = (m[r.src] || 0) + 1; return m; }, {})).map(([k, v]) => ({ label: SRC[k] || k, value: v })).sort((a, b) => b.value - a.value);
  return `<div class="kpis"><div class="kpi"><span class="kpi-l">7 hari ke depan</span><b class="kpi-v">${wk.length}</b><span class="kpi-d">${sum(wk, (r) => r.pax)} tamu</span></div><div class="kpi"><span class="kpi-l">No-show 30 hari</span><b class="kpi-v">${pct(ns / Math.max(1, past.length))}</b><span class="kpi-d">${ns} dari ${past.length} reservasi</span></div><div class="kpi"><span class="kpi-l">Pre-order menu</span><b class="kpi-v">${db.reservations.filter((r) => r.order).length}</b><span class="kpi-d">reservasi yang sudah pesan duluan</span></div></div>
    <div class="grid-side"><div><div class="chips">${[['aktif', 'Aktif'], ['menunggu', 'Menunggu'], ['dikonfirmasi', 'Dikonfirmasi'], ['batal', 'Batal'], ['semua', 'Semua']].map(([k, l]) => `<button class="chip ${ui.f === k ? 'on' : ''}" data-a="f" data-v="${k}">${l}</button>`).join('')}</div>
      <div class="card">${resTable(db, up, true)}</div></div>
      <aside><div class="card"><div class="card-h"><h3>Sumber reservasi</h3></div>${hbars(bySrc, { fmt: (v) => num(v) })}</div></aside></div>`;
}
function channel(ctx) {
  const db = ctx.db, base = location.href.split('#')[0];
  const link = (src) => `${base}#/book${src ? '?src=' + src : ''}`;
  const embed = `<iframe src="${base}#/book?embed=1" width="100%" height="760" style="border:0;border-radius:12px" title="Reservasi ${db.settings.brand.name}"></iframe>`;
  const wa = `Halo! Untuk reservasi meja di Joglo, Pelataran, Riverside, atau gazebo tepi sungai di ${db.settings.brand.name}, langsung pilih jam di sini ya: ${link('whatsapp')}`;
  return `<div class="grid2"><div class="card"><div class="card-h"><h3>Link per channel</h3></div><p class="muted">Pakai link berbeda per channel supaya sumber reservasi tercatat di dashboard.</p>
      ${[['Bio Instagram', 'instagram'], ['Balasan WhatsApp', 'whatsapp'], ['Google Maps', 'google'], ['Website', '']].map(([l, s]) => `<label class="fld"><span>${l}</span><div class="row"><input class="inp" readonly value="${esc(link(s))}"><button class="btn btn-sm" data-a="copy" data-v="${esc(link(s))}">${ic('copy', 14)}</button></div></label>`).join('')}
      <label class="fld"><span>Template balasan WhatsApp</span><textarea class="inp" rows="3" readonly>${esc(wa)}</textarea></label><button class="btn btn-sm" data-a="copy" data-v="${esc(wa)}">${ic('copy', 14)} Salin template</button></div>
    <div><div class="card"><div class="card-h"><h3>Pasang di website</h3></div><p class="muted">Tempel kode ini di halaman website untuk menampilkan form reservasi.</p><textarea class="inp code" rows="4" readonly>${esc(embed)}</textarea><button class="btn btn-sm" data-a="copy" data-v="${esc(embed)}">${ic('copy', 14)} Salin kode</button></div>
      <div class="card"><div class="card-h"><h3>QR untuk brosur & banner</h3></div><div class="qr-mini">${qrSvg(link('brosur'), 3)}<p class="muted sm">Scan untuk reservasi. Cocok untuk brosur, banner, atau standee di area parkir.</p></div></div>
      <form class="card" data-submit="saveSet"><div class="card-h"><h3>Aturan reservasi</h3></div><label class="switch"><input type="checkbox" name="auto" ${db.settings.autoConfirmRes ? 'checked' : ''}><span>Konfirmasi otomatis bila meja tersedia</span></label><label class="fld"><span>Durasi per reservasi (menit)</span><input name="dur" type="number" step="15" value="${db.settings.resDuration}"></label><button class="btn btn-pri">Simpan</button></form></div></div>`;
}

function resForm(db, r = {}) {
  const tables = db.tables.map((t) => `<option value="${t.id}" ${r.table === t.id ? 'selected' : ''}>${t.id} (${esc(t.area)}, ${t.seats} kursi)</option>`).join('');
  return `<div class="grid2"><label class="fld"><span>Nama</span><input name="name" value="${esc(r.name || '')}" autofocus></label><label class="fld"><span>No. WhatsApp</span><input name="phone" inputmode="tel" value="${esc(r.phone || '')}"></label>
    <label class="fld"><span>Tanggal</span><input name="date" type="date" value="${r.date || ui.date || dayKey()}"></label><label class="fld"><span>Jam</span><input name="time" type="time" step="1800" value="${r.time || '12:00'}"></label>
    <label class="fld"><span>Jumlah tamu</span><input name="pax" type="number" min="1" value="${r.pax || 2}"></label><label class="fld"><span>Area</span><select name="area"><option value="">Bebas</option>${db.areas.map((a) => `<option ${r.area === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
    <label class="fld"><span>Meja</span><select name="table"><option value="">Pilih otomatis</option>${tables}</select></label><label class="fld"><span>Sumber</span><select name="src">${Object.entries(SRC).map(([k, l]) => `<option value="${k}" ${r.src === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
    <label class="fld"><span>Catatan</span><input name="note" value="${esc(r.note || '')}" placeholder="Contoh: ulang tahun, kursi bayi"></label>`;
}

export default {
  render(ctx) {
    // 2.10: service mencatat & mengelola reservasi; pengaturan channel hanya Owner/kasir
    const tabs = [['jadwal', 'Jadwal meja'], ['daftar', 'Daftar reservasi'], ...(ctx.user.role === 'service' ? [] : [['channel', 'Pasang di channel']])];
    if (ctx.user.role === 'service' && ui.tab === 'channel') ui.tab = 'jadwal';
    const body = ui.tab === 'jadwal' ? jadwal(ctx) : ui.tab === 'daftar' ? daftar(ctx) : channel(ctx);
    return `<div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${ui.tab === k ? 'on' : ''}" data-a="tab" data-v="${k}">${l}</button>`).join('')}</div><div class="tabbody">${body}</div>`;
  },
  actions: {
    tab(el) { ui.tab = el.dataset.v; rerender(); },
    f(el) { ui.f = el.dataset.v; rerender(); },
    day(el) { ui.date = dayKey(fromKey(ui.date || dayKey()) + Number(el.dataset.d) * DAY + 3600000); rerender(); },
    date(el) { ui.date = el.value; rerender(); },
    today() { ui.date = dayKey(); rerender(); },
    copy(el) { copyText(el.dataset.v); },
    async saveSet(form) { const f = formData(form); await API.saveSettings({ autoConfirmRes: !!f.auto, resDuration: Number(f.dur) || 120 }); await C.refresh('settings'); toast('Aturan reservasi disimpan'); rerender(); },
    resNew(el, e, ctx) {
      openModal({ title: 'Reservasi baru', size: 'md', body: resForm(getDb(), { src: 'telepon' }), footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Simpan</button>`,
        onMount(m, api) { m.querySelector('[data-ok]').onclick = async () => {
          const f = formData(m); f.pax = Number(f.pax) || 1;
          if (!f.name.trim()) return toast('Isi nama tamu', 'warn');
          const db = getDb();
          const t = f.table ? db.tables.find((x) => x.id === f.table) : D.suggestTable(db, f) || D.suggestTable(db, { ...f, area: '' });
          if (!t) return toast('Tidak ada meja kosong untuk jam dan jumlah tamu itu', 'err');
          if (f.table && !D.tableFree(db, t.id, D.resStart(f), db.settings.resDuration)) return toast(`Meja ${t.id} sudah terisi di jam itu`, 'err');
          try { await API.reservationCreate({ name: f.name.trim(), phone: f.phone || '', date: f.date, time: f.time, pax: f.pax, area: f.area || '', table: t.id, join: t.join || [], note: f.note || '', status: 'dikonfirmasi', source: f.src }); await C.refresh('reservations'); }
          catch (err) { return toast(err.message, 'err'); }
          api.close(); toast(`Reservasi tersimpan di meja ${[t.id, ...(t.join || [])].join(' + ')}`); ui.date = f.date; rerender();
        }; } });
    },
    resView(el, e, ctx) {
      const db = getDb(), r = db.reservations.find((x) => x.id === el.dataset.id);
      const msg = `Halo ${r.name.split(' ')[0]}, reservasi kamu di ${db.settings.brand.name} sudah kami konfirmasi: ${fmtDate(fromKey(r.date), true)} pukul ${r.time}, ${r.pax} orang, meja ${D.resTableLabel(r)} (${db.tables.find((t) => t.id === r.table)?.area || ''}). Kode ${r.code}. Mau pesan menu duluan? ${location.href.split('#')[0]}#/order?res=${r.code}`;
      const btn = (s, l, cls = '') => `<button class="btn ${cls}" data-st="${s}">${l}</button>`;
      openModal({ title: `${r.name} (${r.code})`, size: 'md', body: `<dl class="kv"><dt>Tanggal</dt><dd>${fmtDate(fromKey(r.date), true)}, ${esc(r.time)}</dd><dt>Tamu</dt><dd>${r.pax} orang</dd><dt>Meja</dt><dd>${esc(D.resTableLabel(r))} ${r.area ? `(minta ${esc(r.area)})` : ''}</dd><dt>Sumber</dt><dd>${SRC[r.src] || esc(r.src)}</dd><dt>No. HP</dt><dd>${esc(r.phone)}</dd><dt>Catatan</dt><dd>${esc(r.note || '—')}</dd><dt>Status</dt><dd><span class="badge ${RES_ST[r.status]}">${esc(r.status)}</span></dd>${r.order ? `<dt>Pre-order</dt><dd>${esc(D.order(db, r.order)?.no || '')}</dd>` : ''}</dl>
        <div class="row wrap">${r.status === 'menunggu' ? btn('dikonfirmasi', 'Konfirmasi', 'btn-pri') : ''}${['menunggu', 'dikonfirmasi'].includes(r.status) ? btn('datang', 'Tamu datang') + btn('no-show', 'No-show') + btn('batal', 'Batalkan', 'btn-danger-ghost') : ''}${r.status === 'datang' ? btn('selesai', 'Selesai') : ''}
        <a class="btn" href="https://wa.me/${D.waPhone(r.phone)}?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">${ic('send', 15)} Kirim konfirmasi WA</a></div>
        ${r.status === 'datang' ? `<p class="hint">${ctx.user.role === 'kasir' ? 'Buka Kaly POS, ketuk meja ini untuk mulai mencatat pesanan.' : 'Pesanan tamu dicatat kasir di Kaly POS.'}</p>` : ''}`,
        onMount(m, api) { m.addEventListener('click', async (ev) => { const b = ev.target.closest('[data-st]'); if (!b) return; const stt = b.dataset.st; b.disabled = true; try { await API.reservationStatus(r.id, stt); await C.refresh('reservations'); } catch (err) { b.disabled = false; return toast(err.message, 'err'); } api.close(); toast(`Status reservasi: ${stt}`); if (stt === 'datang') { go(ctx.user.role === 'kasir' ? 'pos' : 'denah'); } else rerender(); }); } });
    },
  },
};
