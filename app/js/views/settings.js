// Pengaturan umum, staf & akses, akun saya, dan info database
import { APP_VERSION } from '../store.js';
import { esc, ic, toast, formData, openModal, uid, confirmBox } from '../lib.js';
import * as D from '../domain.js';
import * as C from '../cloud.js';
import * as API from '../api.js';
import { rerender, ctxNow } from '../app.js';
import * as DN from '../devnotify.js';
import { deviceStatus, openPrefs } from '../notify.js';
import { printerCard, copiesCard } from './printer-setup.js';
import * as PS from './printer-setup.js';

// ---------- Notifikasi di perangkat (2.4) ----------
function pushCard() {
  const info = DN.infoNow(), ready = DN.serverReady(), dev = deviceStatus();
  const host = (() => { try { return new URL(info.url).host; } catch { return ''; } })();
  const srv = !info ? 'Memeriksa…' : ready ? `Tersambung · ${host} · ${info.devices || 0} perangkat Anda terdaftar` : info.url ? 'Alamat tersimpan, tapi kunci belum dibuat. Tekan Sambungkan lagi.' : 'Belum disambungkan. Notifikasi hanya muncul selama Kaly Ops terbuka.';
  return `<div class="card" id="pn-card"><div class="card-h"><h3>${ic('bell', 17)} Notifikasi di perangkat</h3></div>
    <p class="muted sm">Laporan tutup shift, ringkasan penjualan harian, pembayaran supplier, temuan fraud, barang PO diterima, stok menipis, stock opname, pesanan, dan lainnya bisa muncul di bilah notifikasi HP atau laptop masing-masing, <b>juga saat Kaly Ops ditutup</b>. Setiap staf mengaktifkannya sendiri di perangkatnya lewat tombol ${ic('volume-2', 14)} <b>Notifikasi</b> di bilah atas, dan memilih jenis notifikasinya.</p>
    <div class="ps-row pn-row"><span class="dot ${dev.on ? 'on' : ''}"></span><span><b>Perangkat ini</b><small>${esc(dev.text)}</small></span><span class="row-xs"><button class="btn btn-sm btn-ghost" data-a="pnPrefs">Atur</button></span></div>
    <div class="ps-row pn-row"><span class="dot ${ready ? 'on' : ''}"></span><span><b>Server notifikasi (${DN.onVercel() ? 'API Vercel /api/push' : 'Edge Function ' + DN.FN_NAME})</b><small>${esc(srv)}</small></span>
      <span class="row-xs">${ready ? '<button class="btn btn-sm btn-ghost" data-a="pnConnect">Sambungkan ulang</button><button class="btn btn-sm btn-ghost" data-a="pnDisconnect">Putuskan</button>' : '<button class="btn btn-sm btn-pri" data-a="pnConnect">Sambungkan</button>'}</span></div>
    <details class="pn-steps" ${info && !ready ? 'open' : ''}><summary>Cara menyiapkan server notifikasi (sekali saja, oleh Owner)</summary><ol>
      <li>Jalankan paket SQL Kaly Ops 2.4 di <b>Supabase › SQL Editor</b> (sudah menyalakan ekstensi <b>pg_net</b>).</li>
      <li><b>Supabase › Edge Functions › Deploy a new function › Via Editor</b>. Nama fungsi: <code>${DN.FN_NAME}</code>. Hapus contoh kodenya, tempel isi file <code>functions/kaly-push/index.ts</code> dari paket database, lalu <b>Deploy</b>.</li>
      <li>Buka fungsi ${DN.FN_NAME} › <b>Details</b>: matikan <b>Verify JWT</b> (Enforce JWT verification), lalu simpan. Database memanggil fungsi ini tanpa login.</li>
      <li>Kembali ke sini dan tekan <b>Sambungkan</b>. Lalu di setiap HP/laptop: tombol ${ic('volume-2', 14)} › <b>Aktifkan notifikasi di perangkat ini</b> › <b>Kirim tes</b>.</li></ol>
      <p class="hint">Tidak perlu Firebase atau kunci tambahan: kunci pengiriman (VAPID) dibuat otomatis dan disimpan di database. Android: Chrome, Edge, Samsung Internet, Firefox. Laptop: Chrome, Edge, Firefox, Safari. iPhone/iPad (iOS 16.4+): buka Kaly Ops di Safari › Bagikan › <b>Tambah ke Layar Utama</b>, lalu aktifkan dari ikon Kaly Ops di layar utama. Aplikasi Android Kaly Ops (APK) di tablet kasir menampilkan notifikasi selama aplikasinya berjalan.</p></details></div>`;
}
const repaintPush = () => { const el = document.getElementById('pn-card'); if (el) { const t = document.createElement('div'); t.innerHTML = pushCard(); el.replaceWith(t.firstElementChild); } };

const ROLE_OPTS = Object.entries(D.ROLES);

function staffForm(db, u) {
  const outs = db.locations.filter((l) => l.type === 'outlet');
  const all = !u?.outlets?.length;
  return `<div class="grid2"><label class="fld"><span>Nama</span><input name="name" value="${esc(u?.name || '')}" autofocus></label>
      <label class="fld"><span>Email login</span><input name="email" type="email" value="${esc(u?.email || '')}" ${u ? 'readonly' : ''} placeholder="nama@email.com"></label>
      <label class="fld"><span>Peran</span><select name="role">${ROLE_OPTS.map(([k, v]) => `<option value="${k}" ${u?.role === k ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></label>
      <div class="fld"><span>Outlet yang boleh diakses</span><label class="switch sm"><input type="checkbox" name="all" ${all ? 'checked' : ''}><span>Semua outlet</span></label>
        ${outs.map((l) => `<label class="switch sm"><input type="checkbox" name="out_${l.id}" ${!all && u.outlets.includes(l.id) ? 'checked' : ''}><span>${esc(l.name)}</span></label>`).join('')}</div></div>
    ${u ? `<label class="switch"><input type="checkbox" name="active" ${u.active !== false ? 'checked' : ''}><span>Aktif (bisa masuk ke Kaly Ops)</span></label>` : ''}
    <p class="hint">${u ? (u.linked ? 'Akun login sudah tersambung.' : 'Belum punya akun login.') + ' ' : ''}Akun login dibuat di Supabase: <b>Authentication → Users → Add user</b>, isi email yang sama persis, buat kata sandi, centang <b>Auto Confirm User</b>. Email tidak bisa diubah setelah disimpan; buat staf baru bila emailnya berganti.</p>`;
}

export default {
  render(ctx) {
    const db = ctx.db, s = db.settings;
    const n = (name, label, val, step = 1, suffix = '') => `<label class="fld"><span>${label}</span><div class="row"><input name="${name}" type="number" step="${step}" value="${val}" class="inp">${suffix ? `<span class="muted sm">${suffix}</span>` : ''}</div></label>`;
    const st = C.syncStatus();
    return `${printerCard(ctx, { ro: true })}<div class="grid-side"><form class="card" data-submit="save">
        <div class="card-h"><h3>Aturan operasional</h3></div>
        <div class="grid2">${n('taxRate', 'Pajak restoran (PB1)', Math.round(s.taxRate * 100), 1, '%')}${n('serviceRate', 'Service charge', Math.round(s.serviceRate * 100), 1, '%')}
          ${n('pointsPer', 'Belanja per 1 poin', s.pointsPer, 1000, 'Rp')}${n('pointValue', 'Nilai 1 poin saat ditukar', s.pointValue, 10, 'Rp')}
          ${n('welcomePoints', 'Bonus poin member baru', s.welcomePoints)}${n('slaMin', 'Target serving time dapur', s.slaMin, 1, 'menit')}</div>
        <label class="switch"><input type="checkbox" name="stockGuard" ${s.stockGuard !== false ? 'checked' : ''}><span>Menu otomatis habis saat bahan resepnya tidak cukup untuk satu porsi (outlet yang terhubung Kaly Core)</span></label>
        <div class="card-h"><h3>Kontrol anti-fraud</h3></div>
        <div class="grid2"><label class="fld"><span>Ganti PIN manajer</span><input name="managerPin" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password" placeholder="Kosongkan bila tidak diganti"></label>
          ${n('discApproval', 'Diskon manual tanpa PIN maksimal', Math.round(s.discApproval * 100), 1, '%')}${n('cashVarTol', 'Toleransi selisih kas', s.cashVarTol, 1000, 'Rp')}
          ${n('poPriceTol', 'Toleransi harga PO di atas acuan', Math.round(s.poPriceTol * 100), 1, '%')}${n('poApproval', 'Batas nilai PO (deteksi PO dipecah)', s.poApproval, 100000, 'Rp')}
          ${n('transferFee', 'Biaya flat per pembayaran supplier', s.transferFee, 500, 'Rp')}${n('b2bMarkup', 'Markup harga B2B Central Kitchen', Math.round(s.b2bMarkup * 100), 1, '%')}</div>
        <p class="hint">PIN manajer 4 sampai 6 angka, disimpan terenkripsi di database. PIN bawaan dari paket database adalah 1234, ganti sebelum dipakai.</p>
        <button class="btn btn-pri" id="set-save">Simpan pengaturan</button></form>
      <aside>
        <div class="card"><div class="card-h"><h3>${ic('link', 17)} Integrasi Kaly Core</h3></div>
          <p class="muted sm">Atur per outlet apakah penjualan memakai stok <b>Bahan & Bumbu</b> di Kaly Core.</p>
          ${db.locations.filter((l) => l.type === 'outlet').map((l) => `<label class="switch"><input type="checkbox" data-a-change="coreTg" data-loc="${esc(l.id)}" ${l.core !== false ? 'checked' : ''}><span><b>${esc(l.name)}</b> ${l.core !== false ? 'terhubung' : '<span class="muted">tidak terhubung</span>'}</span></label>`).join('')}
          <p class="hint"><b>Terhubung:</b> setiap item yang dikirim ke dapur memotong stok sesuai resep, HPP tercatat, bumbu diproduksi otomatis, dan menu habis sendiri bila bahannya kurang. <b>Tidak terhubung:</b> kasir dan dapur jalan tanpa stok. Penjualan tidak memotong stok, tidak ada HPP penjualan di laba rugi, dan peringatan bahan di dapur disembunyikan. Stok, resep, dan PO di Kaly Core tetap bisa dipakai. Perubahan berlaku untuk item yang dikirim ke dapur setelahnya.</p></div>
        ${copiesCard(ctx, { ro: true })}
        ${pushCard()}
        ${crewCard(ctx)}
        <div class="card"><div class="card-h"><h3>Staf & akses</h3><button class="btn btn-sm" data-a="staffNew">${ic('plus', 15)} Tambah staf</button></div>
          <div>${db.users.map((u) => `<div class="staff-row"><span><b>${esc(u.name)}</b>${u.active === false ? ' <span class="badge b-mute">nonaktif</span>' : ''}<small>${esc(u.email)}${u.outlets?.length ? ' · ' + u.outlets.map((l) => esc(D.loc(db, l)?.name || l)).join(', ') : ''}</small>${u.linked ? '' : '<small class="neg">Belum punya akun login</small>'}</span>
            <span class="row-xs"><span class="badge b-mute">${esc(D.ROLES[u.role]?.label || u.role)}</span><button class="btn btn-sm btn-ghost" data-a="staffEdit" data-id="${u.id}">Ubah</button></span></div>`).join('')}</div>
          <p class="hint">Staf masuk dengan email dan kata sandi dari Supabase Authentication. Peran menentukan modul yang bisa dibuka.</p></div>
        <form class="card" data-submit="pass"><div class="card-h"><h3>Akun saya</h3></div>
          <p class="muted sm">${esc(ctx.user.name)} · ${esc(ctx.user.email)}</p>
          <label class="fld"><span>Kata sandi baru</span><input name="p1" type="password" autocomplete="new-password" minlength="6"></label>
          <label class="fld"><span>Ulangi kata sandi baru</span><input name="p2" type="password" autocomplete="new-password" minlength="6"></label>
          <button class="btn">Ganti kata sandi</button></form>
        <div class="card"><div class="card-h"><h3>Database</h3><span class="sync ${st === 'ok' ? '' : 'off'}"><i></i>${st === 'ok' ? 'Tersambung' : 'Terputus'}</span></div>
          <p class="muted sm">Semua data tersimpan di Supabase (${esc(C.projectHost)}) dan tersinkron ke semua perangkat. Cadangan database tersedia di dashboard Supabase (Database → Backups).</p></div>
        <div class="card"><div class="card-h"><h3>Langkah berikutnya</h3></div><ul class="rules"><li><b>Payment gateway</b><small>Midtrans atau Xendit untuk QRIS dinamis dan status bayar otomatis. Fungsi konfirmasi pembayaran sudah tersedia di database.</small></li><li><b>WhatsApp Business API</b><small>Kirim campaign dan konfirmasi reservasi otomatis.</small></li></ul></div>
        <p class="muted sm app-ver">Kaly Ops versi ${APP_VERSION}</p>
      </aside></div>`;
  },
  after(root, ctx, first) {
    if (!first) return;
    PS.startStatus(true);   // pantau status printer tanpa menggambar ulang formulir pengaturan
    DN.refreshInfo().then(repaintPush);
  },
  unmount() { PS.stopStatus(); },
  actions: {
    async save(form) {
      const f = formData(form);
      if (f.managerPin && !/^\d{4,6}$/.test(f.managerPin)) return toast('PIN manajer harus 4 sampai 6 angka', 'warn');
      const patch = { taxRate: (Number(f.taxRate) || 0) / 100, serviceRate: (Number(f.serviceRate) || 0) / 100, discApproval: (Number(f.discApproval) || 0) / 100,
        poPriceTol: (Number(f.poPriceTol) || 0) / 100, b2bMarkup: (Number(f.b2bMarkup) || 0) / 100, stockGuard: !!f.stockGuard };
      ['pointsPer', 'pointValue', 'welcomePoints', 'slaMin', 'cashVarTol', 'poApproval', 'transferFee'].forEach((k) => (patch[k] = Number(f[k]) || 0));
      const btn = form.querySelector('#set-save'); btn.disabled = true;
      try {
        await API.saveSettings(patch);
        if (f.managerPin) await API.setManagerPin(f.managerPin);
        await C.refresh('settings');
        toast(f.managerPin ? 'Pengaturan dan PIN manajer disimpan' : 'Pengaturan disimpan');
        rerender();
      } finally { btn.disabled = false; }
    },
    prLoc: PS.actions.prLoc,
    pnPrefs() { openPrefs(); },
    async pnConnect(el) {
      el.disabled = true;
      try {
        await DN.connectServer(); await DN.resume(); await DN.refreshInfo();
        toast(`Server notifikasi tersambung. ${DN.isOn() && DN.endpoint() ? 'Perangkat ini sudah terdaftar; tekan Atur › Kirim tes untuk mencoba.' : 'Sekarang aktifkan notifikasi di setiap HP/laptop lewat tombol Notifikasi di bilah atas.'}`, 'ok', 7000);
      }
      catch (e) { toast(e.message, 'err', 9000); }
      repaintPush();
    },
    async pnDisconnect() {
      if (!(await confirmBox('Putuskan server notifikasi?', 'Notifikasi tidak lagi dikirim saat Kaly Ops ditutup. Notifikasi selama aplikasi terbuka tetap berjalan.', 'Putuskan', true))) return;
      try { await DN.disconnectServer(); toast('Server notifikasi diputuskan'); } catch (e) { toast(e.message, 'err'); }
      repaintPush();
    },
    async pass(form) {
      const f = formData(form);
      if ((f.p1 || '').length < 6) return toast('Kata sandi minimal 6 karakter', 'warn');
      if (f.p1 !== f.p2) return toast('Kedua kata sandi tidak sama', 'warn');
      await C.changePassword(f.p1);
      form.reset(); toast('Kata sandi diganti');
    },
    async coreTg(el, e, ctx) {
      const L = el.dataset.loc, on = el.checked, name = D.loc(ctx.db, L)?.name || L;
      el.disabled = true;
      try { await API.tableUpdate('locations', { id: L }, { core_stock: on }); await C.refresh('org'); }
      catch (err) { el.checked = !on; el.disabled = false; return toast(err.message, 'err', 6000); }
      toast(on ? `${name} terhubung ke stok Kaly Core` : `${name} tidak lagi memotong stok Kaly Core`, on ? 'ok' : 'info', 5000);
      rerender();
    },
    staffNew(el, e, ctx) { staffModal(ctx, null); },
    crewNew(el, e, ctx) { crewModal(ctx, null, el.dataset.role); },
    crewEdit(el, e, ctx) { crewModal(ctx, (ctx.db.crew || []).find((c) => c.id === el.dataset.id)); },
    staffEdit(el, e, ctx) { staffModal(ctx, ctx.db.users.find((u) => u.id === el.dataset.id)); },
  },
};

// ---------- 2.9 · Anggota shift (nama petugas kasir, service, kitchen) — hanya di Kaly Backoffice ----------
const CREW_ROLES = [['kasir', 'Kasir', 'Dipilih saat buka shift; laporan shift & nota memakai nama ini'], ['service', 'Service', 'Nama petugas di perangkat service'], ['dapur', 'Kitchen / Bar', 'Nama petugas di layar dapur']];
function crewCard(ctx) {
  const db = ctx.db, list = db.crew || [];
  if (db.crewReady === false) return `<div class="card"><div class="card-h"><h3>${ic('users', 17)} Anggota shift</h3></div><p class="hint">Jalankan update database 2.9 (kaly-ops-update-2.9.sql) di Supabase › SQL Editor untuk mengaktifkan anggota shift.</p></div>`;
  return `<div class="card crew-card"><div class="card-h"><h3>${ic('users', 17)} Anggota shift</h3></div>
    <p class="muted sm">Nama petugas yang bergantian memakai akun kasir, service, dan dapur. Petugas tidak perlu email sendiri: nama dipilih di perangkat, dan kasir bisa mengganti nama petugas shift tanpa ganti email login. Hanya Owner/Manajer yang bisa menambah atau mengubah daftar ini.</p>
    ${CREW_ROLES.map(([r, l, h]) => { const xs = list.filter((c) => c.role === r); return `<div class="crew-grp"><div class="row sb"><span><b>${l}</b> <span class="muted sm">${xs.filter((c) => c.active).length} aktif</span><small class="muted">${esc(h)}</small></span><button class="btn btn-sm" data-a="crewNew" data-role="${r}">${ic('plus', 15)} Tambah</button></div>
      ${xs.length ? `<div class="crew-list">${xs.map((c) => `<button class="crew-tag ${c.active ? '' : 'off'}" data-a="crewEdit" data-id="${c.id}" title="Ubah ${esc(c.name)}">${esc(c.name)}${c.loc ? `<small>${esc(D.loc(db, c.loc)?.name || c.loc)}</small>` : ''}${c.active ? '' : '<small>nonaktif</small>'}</button>`).join('')}</div>` : '<p class="muted sm">Belum ada.</p>'}</div>`; }).join('')}
  </div>`;
}
function crewModal(ctx, c, role) {
  const outs = ctx.db.locations.filter((l) => l.type === 'outlet');
  openModal({ title: c ? `Ubah ${c.name}` : 'Tambah anggota shift', size: 'sm',
    body: `<label class="fld"><span>Nama petugas</span><input name="name" maxlength="40" value="${esc(c?.name || '')}" autofocus placeholder="Contoh: Rani"></label>
      <label class="fld"><span>Bagian</span><select name="role">${CREW_ROLES.map(([k, l]) => `<option value="${k}" ${(c?.role || role) === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="fld"><span>Outlet</span><select name="loc"><option value="">Semua outlet</option>${outs.map((l) => `<option value="${l.id}" ${c?.loc === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
      ${c ? `<label class="switch"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}><span>Aktif (bisa dipilih di perangkat)</span></label>` : ''}`,
    footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Simpan</button>`,
    onMount(m, api) {
      m.querySelector('[data-ok]').onclick = async () => {
        const f = formData(m), name = (f.name || '').trim().replace(/\s+/g, ' ');
        if (!name) return toast('Isi nama petugas', 'warn');
        if ((ctx.db.crew || []).some((x) => x.id !== c?.id && x.role === f.role && x.name.toLowerCase() === name.toLowerCase())) return toast('Nama ini sudah ada di bagian yang sama', 'warn');
        const row = { id: c?.id || uid('cr'), name, role: f.role, location_id: f.loc || null, active: c ? !!f.active : true };
        try { await API.crewSave(row); await C.refresh('crew'); } catch (err) { return toast(err.message, 'err', 6000); }
        api.close(); toast(c ? 'Anggota shift disimpan' : `${name} ditambahkan`); rerender();
      };
    } });
}

function staffModal(ctx, u) {
  openModal({ title: u ? `Ubah ${u.name}` : 'Tambah staf', size: 'md', body: staffForm(ctx.db, u),
    footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Simpan</button>`,
    onMount(m, api) {
      m.querySelector('[data-ok]').onclick = async () => {
        const f = formData(m);
        const name = (f.name || '').trim(), email = (f.email || '').trim().toLowerCase();
        if (!name) return toast('Isi nama staf', 'warn');
        if (!u && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast('Isi email yang valid', 'warn');
        if (!u && ctx.db.users.some((x) => x.email === email)) return toast('Email ini sudah terdaftar sebagai staf', 'warn');
        const outs = f.all ? null : ctx.db.locations.filter((l) => f['out_' + l.id]).map((l) => l.id);
        if (outs && !outs.length) return toast('Pilih minimal satu outlet, atau centang Semua outlet', 'warn');
        const row = u ? { id: u.id, email: u.email, name, role: f.role, outlets: outs, active: !!f.active } : { id: uid('u'), email, name, role: f.role, outlets: outs, active: true };
        try { await API.staffSave(row); await C.refresh('staff'); } catch (err) { return toast(err.message, 'err', 6000); }
        api.close(); toast(u ? 'Data staf disimpan' : 'Staf ditambahkan. Buat akun loginnya di Supabase dengan email yang sama.', u ? 'ok' : 'info', 6000); rerender();
      };
    } });
}
