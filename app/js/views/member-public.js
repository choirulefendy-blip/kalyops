// Halaman member Kaly Loop (white-label) — cek poin, daftar, misi, voucher. Data dari fungsi publik database.
import { esc, ic, rp, num, toast, formData, fmtDate, logo } from '../lib.js';
import * as C from '../cloud.js';
import { rerender } from '../app.js';

const KEY = 'kaly.memberPhone';
const getP = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
const setP = (p) => { try { p ? localStorage.setItem(KEY, p) : localStorage.removeItem(KEY); } catch {} };
const norm = (p) => { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('62')) d = '0' + d.slice(2); return d; };
let regPhone = '', data = null, loadedFor = null, busy = false;

async function load(phone) {
  busy = true;
  try { data = await C.rpc('public_loop', { p_phone: phone || null }); loadedFor = phone || ''; }
  catch (e) { toast(e.message, 'err'); }
  finally { busy = false; rerender(); }
}

export default {
  render() {
    if (!C.configured) return `<div class="load-pane"><p>Halaman ini belum tersambung ke database.</p></div>`;
    const phone = getP();
    if (!data || (loadedFor !== phone && !busy)) { if (!busy) load(phone); return `<div class="load-pane">${logo('olive')}<p>Memuat…</p></div>`; }
    const b = data.brand || {}, tiers = data.tiers || [], m = data.member;
    const head = `<header class="shop-h terrace"><div class="shop-brand">${logo('light')}<small>Kaly Loop member</small></div>${m ? `<button class="btn btn-sm btn-ghost-light" data-a="out">Keluar</button>` : ''}</header>`;
    if (!m) {
      return `<div class="shop" style="--brand:${esc(b.color)};--accent:${esc(b.accent)}">${head}<main class="member-in">
        ${regPhone ? `<form class="card" data-submit="reg"><h2>Daftar member</h2><p class="muted">Nomor ${esc(regPhone)} belum terdaftar. Lengkapi data di bawah, gratis dan langsung dapat ${num(b.welcome_points)} poin.</p>
          <label class="fld"><span>Nama</span><input name="n" autocomplete="name" autofocus></label><label class="fld"><span>Tanggal lahir</span><input name="b" type="date"></label><input type="hidden" name="p" value="${esc(regPhone)}">
          <button class="btn btn-brand btn-block btn-lg">Daftar sekarang</button><button type="button" class="btn btn-block btn-ghost" data-a="back">Ganti nomor</button></form>`
        : `<form class="card" data-submit="look"><h2>Cek poin & promo</h2><p class="muted">Masukkan nomor WhatsApp yang kamu pakai saat pesan.</p><label class="fld"><span>No. WhatsApp</span><input name="p" inputmode="tel" autocomplete="tel" placeholder="08xx" autofocus></label><button class="btn btn-brand btn-block btn-lg">Lanjut</button></form>`}
        <section class="perks">${tiers.map((t) => `<div><b>${esc(t.name)}</b><small>${Number(t.min) ? 'Belanja ' + rp(t.min) : 'Saat daftar'}</small><p>${esc(t.perks || '')}</p></div>`).join('')}</section></main></div>`;
    }
    const spend = Number(m.spend) || 0;
    const sorted = [...tiers].sort((x, y) => Number(x.min) - Number(y.min));
    const t = [...sorted].reverse().find((x) => spend >= Number(x.min)) || sorted[0] || { name: '', perks: '' };
    const nt = sorted.find((x) => Number(x.min) > spend);
    return `<div class="shop" style="--brand:${esc(b.color)};--accent:${esc(b.accent)}">${head}<main class="member">
      <section class="mcard terrace"><small>Member ${esc(t.name)}</small><h2>${esc(m.name)}</h2><b class="mpts">${num(m.points)} <span>poin</span></b><span>setara ${rp(m.points * (Number(b.point_value) || 0))}</span>
        ${nt ? `<div class="prog light"><i style="width:${Math.min(100, (spend / Number(nt.min)) * 100)}%"></i></div><small>${rp(Number(nt.min) - spend)} lagi menuju ${esc(nt.name)}</small>` : '<small>Kamu di tier tertinggi. Terima kasih sudah setia!</small>'}</section>
      <p class="muted">${esc(t.perks || '')}</p>
      <h3 class="sec-t">Misi bulan ini</h3>
      <ul class="mlist">${(m.missions || []).map((x) => `<li><div><b>${esc(x.name)}</b><small>${esc(x.desc || '')}. Hadiah ${num(x.reward)} poin.</small><div class="prog"><i style="width:${Math.min(100, (Number(x.progress) / Number(x.target)) * 100)}%"></i></div></div><span class="badge ${x.done ? 'b-ok' : 'b-mute'}">${x.done ? 'Selesai' : `${Math.min(Number(x.progress), Number(x.target))}/${num(x.target)}`}</span></li>`).join('') || '<li class="muted">Belum ada misi bulan ini.</li>'}</ul>
      <h3 class="sec-t">Voucher kamu</h3>
      <ul class="mlist">${(m.vouchers || []).map((v) => `<li><div><b>${esc(v.name)}</b><small>Kode <b>${esc(v.code)}</b>${Number(v.min) ? `, min. belanja ${rp(v.min)}` : ''}${v.until ? `, sampai ${fmtDate(Date.parse(v.until))}` : ''}</small></div>${v.birthday ? ic('cake', 20) : ic('ticket', 20)}</li>`).join('') || '<li class="muted">Belum ada voucher aktif.</li>'}</ul>
      ${m.birthday ? `<p class="muted sm">${ic('cake', 15)} Ulang tahun ${esc(m.birthday.split('-').reverse().join('/'))}: birthday treat dikirim lewat WhatsApp di bulan ulang tahunmu.</p>` : ''}
      <h3 class="sec-t">Kunjungan terakhir</h3>
      <ul class="mlist">${(m.recent || []).map((o) => `<li><div><b>${fmtDate(Date.parse(o.at))}</b></div><span>+${num(o.earned || 0)} poin</span></li>`).join('') || '<li class="muted">Belum ada kunjungan tercatat.</li>'}</ul>
      <div class="row"><a class="btn btn-brand" href="#/book">Reservasi meja</a></div><p class="muted sm">Mau pesan? Scan QR di meja saat kamu sudah duduk di Kaly.</p>
    </main></div>`;
  },
  actions: {
    async look(form) {
      const p = norm(formData(form).p);
      if (p.length < 9) return toast('Nomor HP belum valid', 'warn');
      const r = await C.rpc('public_loop', { p_phone: p });
      data = r;
      if (r.member) { setP(p); regPhone = ''; loadedFor = p; } else { regPhone = p; loadedFor = getP(); }
      rerender();
    },
    async reg(form) {
      const f = formData(form);
      if (!f.n.trim()) return toast('Isi nama kamu', 'warn');
      const r = await C.rpc('public_register_member', { p: { name: f.n.trim(), phone: f.p, birthday: f.b || '' } });
      const p = norm(f.p);
      setP(p); regPhone = '';
      toast(r.created ? `Selamat datang! Bonus ${num(data?.brand?.welcome_points || 0)} poin sudah masuk.` : 'Nomor ini sudah terdaftar. Selamat datang kembali!');
      await load(p);
    },
    back() { regPhone = ''; rerender(); },
    out() { setP(''); regPhone = ''; data = null; rerender(); },
  },
};
