// Pengaturan umum, staf & akses, akun saya, dan info database
import { APP_VERSION } from '../store.js';
import { esc, ic, toast, formData, openModal, uid, confirmBox } from '../lib.js';
import * as D from '../domain.js';
import * as C from '../cloud.js';
import * as API from '../api.js';
import { rerender, ctxNow } from '../app.js';
import { KINDS, KIND_LABEL, stationOnline, seenText, printersAt, testSlipHtml, paperOf } from '../printing.js';
import * as DN from '../devnotify.js';
import { deviceStatus, openPrefs } from '../notify.js';
import { isApp, printDirect, checkPrinter, isDirect, connOf, connText, CONN_LABEL, listDevices, appFeatures, MODELS, modelOf } from '../escpos.js';

// ---------- Printer & tujuan cetak (2.1; LAN 2.2; Bluetooth & USB 2.3 untuk aplikasi Android) ----------
const prStatus = (p, now) => (isDirect(p) ? `${connText(p)}${p.paper ? ` · ${p.paper} mm` : ''}${p.mode === 'escstar' ? ' · ESC *' : ''}${p.seen ? ' · stasiun ' + seenText(p, now).toLowerCase() : ''}` : `PC / stasiun cetak · ${seenText(p, now)}`);
const pui = { loc: null };
let prT = null;  // status printer diperbarui setiap 30 detik selama halaman ini terbuka
// 2.6: pengaturan per printer. Setiap printer punya panel sendiri: sambungan, kertas, dan lembar yang dicetaknya.
const SLIP_HINT = { cust: 'dengan harga & total', copy: 'bertanda SALINAN KASIR', bar: 'minuman, tanpa harga', dapur: 'makanan, tanpa harga' };
function slipChips(R, id, L, copies) {
  return `<div class="pr-slips" role="group" aria-label="Lembar yang dicetak">${KINDS.map((k) => {
    const on = R[k] === id;
    return `<button type="button" class="pr-slip ${on ? 'on' : ''}" data-a="prSlip" data-k="${k}" data-p="${id}" data-loc="${L}" aria-pressed="${on}" title="${on ? 'Ketuk: kembalikan ke perangkat kasir' : 'Ketuk: cetak di printer ini'}">
      ${ic(on ? 'check' : 'plus', 14)}<span><b>${KIND_LABEL[k]}</b><small>${SLIP_HINT[k]}${on && copies?.[k] !== undefined ? ` · ${copies[k]} lembar` : ''}</small></span></button>`;
  }).join('')}</div>`;
}
function printerPanel(p, i, R, L, now, copies) {
  const mine = KINDS.filter((k) => R[k] === p.id);
  const online = stationOnline(p, now) || (isDirect(p) && isApp());
  const addr = { lan: p.ip ? `${p.ip}:${p.port || 9100}` : '', bt: p.bt || '', usb: p.usb || '' }[connOf(p)] || '';
  return `<section class="pr-panel ${mine.length ? '' : 'idle'}" data-pr="${p.id}">
    <header class="pr-ph"><span class="pr-no">${i + 1}</span><span class="pr-pn"><b>${esc(p.name)}</b><small><span class="dot ${online ? 'on' : ''}"></span>${esc(prStatus(p, now))}</small></span>
      <span class="row-xs">${isDirect(p) && isApp() ? `<button class="btn btn-sm btn-ghost" data-a="prPing" data-id="${p.id}">Cek</button>` : ''}<button class="btn btn-sm btn-ghost" data-a="prTest" data-id="${p.id}">Cetak tes</button><button class="btn btn-sm" data-a="prEdit" data-id="${p.id}">${ic('settings', 14)} Atur</button></span></header>
    <dl class="pr-spec">${modelOf(p) !== 'umum' ? `<div><dt>Model</dt><dd>${esc(MODELS[modelOf(p)].label)}</dd></div>` : ''}<div><dt>Sambungan</dt><dd>${esc(CONN_LABEL[connOf(p)] || connOf(p))}</dd></div>${addr ? `<div><dt>${connOf(p) === 'lan' ? 'Alamat IP' : connOf(p) === 'bt' ? 'Bluetooth' : 'USB'}</dt><dd>${esc(addr)}</dd></div>` : ''}
      <div><dt>Kertas</dt><dd>${p.paper ? p.paper + ' mm' : 'ikut Tampilan nota'}${MODELS[modelOf(p)].cut === false ? ' · disobek manual' : ''}</dd></div>${isDirect(p) ? `<div><dt>Cara kirim</dt><dd>${p.mode === 'escstar' ? 'Printer lama (ESC *)' : 'Standar'}</dd></div>` : ''}</dl>
    <p class="pr-lbl">Lembar yang dicetak di printer ini</p>
    ${slipChips(R, p.id, L, copies)}
    ${mine.length ? '' : '<p class="hint">Belum ada lembar. Ketuk lembar di atas untuk mengarahkannya ke printer ini.</p>'}
  </section>`;
}
function printerCard(ctx) {
  const db = ctx.db, outs = db.locations.filter((l) => l.type === 'outlet');
  const L = outs.some((l) => l.id === pui.loc) ? pui.loc : ctx.outlet;
  const ps = printersAt(db, L), R = db.locations.find((l) => l.id === L)?.route || {}, now = Date.now(), copies = db.settings.printCopies || {};
  const local = KINDS.filter((k) => !ps.some((p) => p.id === R[k]));
  return `<div class="card" id="pr-card"><div class="card-h"><h3>${ic('printer', 17)} Printer & tujuan cetak</h3><button class="btn btn-sm" data-a="prNew">${ic('plus', 15)} Tambah printer</button></div>
    <p class="muted sm">Setiap printer diatur sendiri: sambungan, lebar kertas, dan lembar yang dicetaknya. Satu lembar hanya keluar di satu printer; memilihnya di printer lain otomatis memindahkannya. Contoh: <b>Printer 1</b> nota pelanggan & salinan, <b>Printer 2</b> slip Bar, <b>Printer 3</b> slip Dapur.</p>
    ${outs.length > 1 ? `<div class="chips">${outs.map((l) => `<button class="chip ${l.id === L ? 'on' : ''}" data-a="prLoc" data-v="${l.id}">${esc(l.name)}</button>`).join('')}</div>` : ''}
    <div class="pr-list pr-panels">${ps.length ? ps.map((p, i) => printerPanel(p, i, R, L, now, copies)).join('') : '<p class="empty sm">Belum ada printer di outlet ini. Tekan <b>Tambah printer</b> untuk setiap printer di lapangan (mis. 3 printer: Kasir, Bar, Dapur).</p>'}</div>
    ${ps.length ? `<section class="pr-panel pr-local"><header class="pr-ph"><span class="pr-no">${ic('smartphone', 15)}</span><span class="pr-pn"><b>Perangkat kasir</b><small>Lembar tanpa printer tujuan dicetak oleh perangkat yang menekan Cetak</small></span></header>
      <p class="pr-lbl">${local.length ? local.map((k) => KIND_LABEL[k]).join(', ') : 'Semua lembar sudah punya printer.'}</p></section>` : ''}
    <p class="hint">Printer <b>LAN/Wi-Fi</b>, <b>Bluetooth</b>, dan <b>USB</b> dicetak langsung oleh tablet dengan <b>aplikasi Android Kaly Ops</b>; printer <b>PC / stasiun cetak</b> lewat halaman <a href="#/print">Stasiun cetak</a> di PC yang tersambung. Jumlah lembar per jenis diatur di kartu <b>Cetak nota</b>. Bila printer tujuan mati, kasir ditawari mencetak di perangkatnya sendiri.</p></div>`;
}
// ---------- Notifikasi di perangkat (2.4) ----------
function pushCard() {
  const info = DN.infoNow(), ready = DN.serverReady(), dev = deviceStatus();
  const host = (() => { try { return new URL(info.url).host; } catch { return ''; } })();
  const srv = !info ? 'Memeriksa…' : ready ? `Tersambung · ${host} · ${info.devices || 0} perangkat Anda terdaftar` : info.url ? 'Alamat tersimpan, tapi kunci belum dibuat. Tekan Sambungkan lagi.' : 'Belum disambungkan. Notifikasi hanya muncul selama Kaly Ops terbuka.';
  return `<div class="card" id="pn-card"><div class="card-h"><h3>${ic('bell', 17)} Notifikasi di perangkat</h3></div>
    <p class="muted sm">Laporan tutup shift, ringkasan penjualan harian, pembayaran supplier, temuan fraud, barang PO diterima, stok menipis, stock opname, pesanan, dan lainnya bisa muncul di bilah notifikasi HP atau laptop masing-masing, <b>juga saat Kaly Ops ditutup</b>. Setiap staf mengaktifkannya sendiri di perangkatnya lewat tombol ${ic('volume-2', 14)} <b>Notifikasi</b> di bilah atas, dan memilih jenis notifikasinya.</p>
    <div class="ps-row pn-row"><span class="dot ${dev.on ? 'on' : ''}"></span><span><b>Perangkat ini</b><small>${esc(dev.text)}</small></span><span class="row-xs"><button class="btn btn-sm btn-ghost" data-a="pnPrefs">Atur</button></span></div>
    <div class="ps-row pn-row"><span class="dot ${ready ? 'on' : ''}"></span><span><b>Server notifikasi (Edge Function ${DN.FN_NAME})</b><small>${esc(srv)}</small></span>
      <span class="row-xs">${ready ? '<button class="btn btn-sm btn-ghost" data-a="pnConnect">Sambungkan ulang</button><button class="btn btn-sm btn-ghost" data-a="pnDisconnect">Putuskan</button>' : '<button class="btn btn-sm btn-pri" data-a="pnConnect">Sambungkan</button>'}</span></div>
    <details class="pn-steps" ${info && !ready ? 'open' : ''}><summary>Cara menyiapkan server notifikasi (sekali saja, oleh Owner)</summary><ol>
      <li>Jalankan paket SQL Kaly Ops 2.4 di <b>Supabase › SQL Editor</b> (sudah menyalakan ekstensi <b>pg_net</b>).</li>
      <li><b>Supabase › Edge Functions › Deploy a new function › Via Editor</b>. Nama fungsi: <code>${DN.FN_NAME}</code>. Hapus contoh kodenya, tempel isi file <code>functions/kaly-push/index.ts</code> dari paket database, lalu <b>Deploy</b>.</li>
      <li>Buka fungsi ${DN.FN_NAME} › <b>Details</b>: matikan <b>Verify JWT</b> (Enforce JWT verification), lalu simpan. Database memanggil fungsi ini tanpa login.</li>
      <li>Kembali ke sini dan tekan <b>Sambungkan</b>. Lalu di setiap HP/laptop: tombol ${ic('volume-2', 14)} › <b>Aktifkan notifikasi di perangkat ini</b> › <b>Kirim tes</b>.</li></ol>
      <p class="hint">Tidak perlu Firebase atau kunci tambahan: kunci pengiriman (VAPID) dibuat otomatis dan disimpan di database. Android: Chrome, Edge, Samsung Internet, Firefox. Laptop: Chrome, Edge, Firefox, Safari. iPhone/iPad (iOS 16.4+): buka Kaly Ops di Safari › Bagikan › <b>Tambah ke Layar Utama</b>, lalu aktifkan dari ikon Kaly Ops di layar utama. Aplikasi Android Kaly Ops (APK) di tablet kasir menampilkan notifikasi selama aplikasinya berjalan.</p></details></div>`;
}
const repaintPush = () => { const el = document.getElementById('pn-card'); if (el) { const t = document.createElement('div'); t.innerHTML = pushCard(); el.replaceWith(t.firstElementChild); } };

function printerForm(db, p, L) {
  const outs = db.locations.filter((l) => l.type === 'outlet');
  const conn0 = p ? connOf(p) : isApp() ? 'lan' : 'pc', app = isApp(), feat = appFeatures();
  const opt = (k, t) => `<option value="${k}" ${conn0 === k ? 'selected' : ''}>${t}</option>`;
  const finder = (k) => (app && feat.includes(k) ? `<button type="button" class="btn btn-sm" data-find="${k}">${ic('search', 14)} Cari di tablet ini</button>` : '');
  openModal({ title: p ? `Ubah ${p.name}` : 'Tambah printer', size: 'sm',
    body: `<label class="fld"><span>Model printer</span><select name="model" data-model>${Object.entries(MODELS).map(([k, m]) => `<option value="${k}" ${modelOf(p) === k ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select></label>
      <p class="hint pr-mhint" data-mhint></p>
      <label class="fld"><span>Nama printer</span><input name="name" maxlength="40" value="${esc(p?.name || '')}" placeholder="mis. Printer Bar" autofocus></label>
      <div class="grid2"><label class="fld"><span>Outlet</span><select name="loc">${outs.map((l) => `<option value="${l.id}" ${l.id === (p?.loc || L) ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
        <label class="fld"><span>Sambungan</span><select name="conn" data-conn>${opt('lan', 'LAN / Wi-Fi')}${opt('bt', 'Bluetooth')}${opt('usb', 'USB ke tablet')}${opt('pc', 'PC / stasiun cetak')}</select></label></div>
      <div class="pr-lan" data-for="lan"><div class="grid2"><label class="fld"><span>Alamat IP printer</span><input name="ip" value="${esc(p?.ip || '')}" placeholder="mis. 192.168.1.31" inputmode="decimal" autocomplete="off"></label>
        <label class="fld"><span>Port</span><input name="port" type="number" min="1" max="65535" value="${p?.port || 9100}"></label></div>
        <p class="hint">IP printer tercetak di lembar <i>self-test</i> (tahan FEED saat printer dinyalakan). Port hampir selalu 9100.</p></div>
      <div class="pr-lan" data-for="bt"><div class="pr-find"><label class="fld"><span>Alamat Bluetooth printer</span><input name="bt" value="${esc(p?.bt || '')}" placeholder="mis. 66:22:B3:44:55:66" autocomplete="off"></label>${finder('bt')}</div>
        <div class="pr-devs" data-devs="bt"></div>
        <p class="hint">Pasangkan (pair) printer dulu di <b>Pengaturan › Bluetooth</b> tablet${app ? ', lalu tekan <b>Cari di tablet ini</b>' : ''}. PIN printer biasanya 0000 atau 1234. Satu printer Bluetooth sebaiknya hanya dipakai satu tablet.</p></div>
      <div class="pr-lan" data-for="usb"><div class="pr-find"><label class="fld"><span>Printer USB (vendor:produk)</span><input name="usb" value="${esc(p?.usb || '')}" placeholder="mis. 0416:5011" autocomplete="off"></label>${finder('usb')}</div>
        <div class="pr-devs" data-devs="usb"></div>
        <p class="hint">Colok printer ke tablet kasir dengan kabel USB/OTG${app ? ', lalu tekan <b>Cari di tablet ini</b>. Android akan meminta izin memakai printer USB; centang <i>selalu</i>' : ', lalu buka Pengaturan ini dari aplikasi Android di tablet itu untuk memilihnya'}.</p></div>
      <div class="pr-lan" data-for="pc"><p class="hint">Printer yang tersambung ke PC atau laptop (USB, LAN, Wi-Fi yang terpasang di Windows). Lembarnya dicetak oleh PC itu lewat halaman <b>Stasiun cetak</b>.</p></div>
      <div class="grid2" data-for="lan bt usb"><label class="fld"><span>Lebar kertas</span><select name="paper"><option value="">Ikuti Tampilan nota</option><option value="58" ${p?.paper === 58 ? 'selected' : ''}>58 mm</option><option value="80" ${p?.paper === 80 ? 'selected' : ''}>80 mm</option></select></label>
        <label class="fld"><span>Cara kirim gambar</span><select name="mode"><option value="raster">Standar (GS v 0)</option><option value="escstar" ${p?.mode === 'escstar' ? 'selected' : ''}>Printer lama (ESC *)</option></select></label></div>
      <div class="fld"><span>Lembar yang dicetak di printer ini</span><div class="pr-formslips">${KINDS.map((k) => `<label class="switch sm"><input type="checkbox" name="slip_${k}" ${p && (db.locations.find((l) => l.id === p.loc)?.route || {})[k] === p.id ? 'checked' : ''}><span>${KIND_LABEL[k]}</span></label>`).join('')}</div>
        <small class="muted">Lembar yang dicentang pindah ke printer ini dari printer lain.</small></div>
      <p class="hint" data-for="lan bt usb">Dicetak langsung oleh tablet dengan aplikasi Android Kaly Ops. Pakai <b>Printer lama (ESC *)</b> bila hasil cetak tes berupa huruf acak.${app && !feat.includes('bt') ? ' Bluetooth & USB perlu aplikasi Android versi 1.1.' : ''}</p>`,
    footer: `${p ? '<button class="btn btn-danger-ghost" data-del>Hapus printer</button>' : ''}<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Simpan</button>`,
    onMount(m, api) {
      const sel = m.querySelector('[data-conn]');
      const show = () => m.querySelectorAll('[data-for]').forEach((el) => { el.hidden = !el.dataset.for.split(' ').includes(sel.value); });
      sel.onchange = show; show();
      // Model: isi otomatis kertas & sambungan yang lazim, plus petunjuk khusus model
      const msel = m.querySelector('[data-model]'), mh = m.querySelector('[data-mhint]');
      const paintModel = (apply) => {
        const M = MODELS[msel.value] || MODELS.umum;
        mh.textContent = M.hint || 'Printer thermal ESC/POS 58 atau 80 mm. Pakai Cetak tes untuk memastikan hasilnya.'; 
        if (!apply) return;
        if (M.paper) m.querySelector('[name=paper]').value = String(M.paper);
        if (M.conn && !p) { sel.value = M.conn; show(); }
        m.querySelector('[name=mode]').value = 'raster';
        const nm = m.querySelector('[name=name]'); if (!nm.value.trim() && M.paper) nm.value = M.label;
      };
      msel.onchange = () => paintModel(true); paintModel(false);
      m.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-find]');
        if (b) {
          const k = b.dataset.find, box = m.querySelector(`[data-devs="${k}"]`);
          b.disabled = true; box.innerHTML = '<p class="muted sm">Mencari…</p>';
          try {
            const list = await listDevices(k);
            box.innerHTML = list.length ? list.map((d) => `<button type="button" class="pr-dev" data-pick="${k}" data-v="${esc(k === 'bt' ? d.addr : d.id)}"><b>${esc(d.name)}</b><small>${esc(k === 'bt' ? d.addr : d.id)}${d.printer ? ' · printer' : ''}</small></button>`).join('')
              : `<p class="muted sm">${k === 'bt' ? 'Belum ada perangkat Bluetooth yang dipasangkan di tablet ini.' : 'Tidak ada printer USB yang tersambung ke tablet ini.'}</p>`;
          } catch (err) { box.innerHTML = `<p class="neg sm">${esc(err.message)}</p>`; }
          b.disabled = false; return;
        }
        const pk = e.target.closest('[data-pick]');
        if (pk) { m.querySelector(`[name=${pk.dataset.pick}]`).value = pk.dataset.v; m.querySelectorAll(`[data-pick="${pk.dataset.pick}"]`).forEach((x) => x.classList.toggle('on', x === pk)); if (!m.querySelector('[name=name]').value.trim()) m.querySelector('[name=name]').value = pk.querySelector('b').textContent.slice(0, 40); }
      });
      const save = async (active) => {
        const f = formData(m), name = f.name.trim(), c = f.conn;
        if (!name) return toast('Isi nama printer', 'warn');
        if (active && c === 'lan' && !/^[A-Za-z0-9.:-]{1,64}$/.test(f.ip.trim())) return toast('Isi alamat IP printer, contoh 192.168.1.31', 'warn');
        if (active && c === 'bt' && !/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(f.bt.trim())) return toast('Pilih printer Bluetooth, atau isi alamatnya (contoh 66:22:B3:44:55:66)', 'warn');
        if (active && c === 'usb' && !/^[0-9A-Fa-f]{4}:[0-9A-Fa-f]{4}$/.test(f.usb.trim())) return toast('Pilih printer USB dari tablet yang tersambung', 'warn');
        try {
          const id = await API.printStationSave(p?.id, name, f.loc, active, { conn: c, ip: f.ip.trim(), port: f.port, bt: f.bt.trim(), usb: f.usb.trim(), paper: f.paper, mode: f.mode });
          if (active && id && (f.model || 'umum') !== modelOf(p)) await API.printStationModel(id, f.model).catch((e) => toast('Model printer belum tersimpan: jalankan SQL Kaly Ops 2.8 di Supabase. ' + e.message, 'warn', 8000));
          if (active && id) {   // lembar yang dicentang diarahkan ke printer ini; yang dilepas kembali ke perangkat kasir
            await C.refresh('org');
            const loc = db.locations.find((l) => l.id === f.loc), R0 = { ...(loc?.route || {}) }, R1 = { ...R0 };
            for (const k of KINDS) { if (f['slip_' + k]) R1[k] = id; else if (R1[k] === id) R1[k] = 'local'; }
            if (JSON.stringify(R0) !== JSON.stringify(R1)) await API.printRouteSave(f.loc, R1);
          }
          await C.refresh('printers', 'org');
        } catch (e) { return toast(e.message, 'err', 6000); }
        api.close(); pui.loc = f.loc;
        toast(!active ? `${name} dihapus. Lembar yang memakainya kembali dicetak di perangkat kasir.` : p ? 'Printer disimpan' : c !== 'pc' ? `${name} ditambahkan. Tekan Cetak tes dari tablet aplikasi Android.` : `${name} ditambahkan. Buka Stasiun cetak di PC yang tersambung ke printer itu.`, 'ok', 6000);
        rerender();
      };
      m.querySelector('[data-ok]').onclick = () => save(true);
      const d = m.querySelector('[data-del]');
      if (d) d.onclick = async () => { if (await confirmBox(`Hapus ${p.name}?`, 'Lembar yang dikirim ke printer ini akan dicetak di perangkat kasir. Antrean yang belum tercetak dibatalkan.', 'Hapus printer', true)) save(false); };
    } });
}

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
    return `${printerCard(ctx)}<div class="grid-side"><form class="card" data-submit="save">
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
        <form class="card" data-submit="savePrint"><div class="card-h"><h3>${ic('printer', 17)} Cetak nota</h3></div>
          <p class="muted sm">Sekali tekan <b>Cetak</b> di Kaly POS mencetak semua lembar di bawah, berurutan. Isi 0 untuk lembar yang tidak perlu.</p>
          <div class="pc-grid">${[['cust', 'Nota pelanggan', 'Lengkap dengan harga dan total'], ['copy', 'Salinan kasir', 'Sama dengan nota pelanggan, bertanda SALINAN KASIR'], ['bar', 'Slip Bar', D.stationCats(db, 'bar') || 'Kategori berstasiun Bar'], ['dapur', 'Slip Dapur', D.stationCats(db, 'dapur') || 'Kategori berstasiun Dapur']]
            .map(([k, l, h]) => `<label class="pc-row"><span><b>${l}</b><small>${esc(h)}</small></span><input class="inp" name="pc_${k}" type="number" min="0" max="5" step="1" value="${s.printCopies?.[k] ?? 1}" aria-label="Jumlah lembar ${l}"><span class="muted sm">lembar</span></label>`).join('')}</div>
          <p class="hint">Slip Bar dan Dapur hanya berisi item yang sudah dikirim ke dapur dan belum pernah tercetak, tanpa harga, jadi item yang sama tidak dibuat dua kali. Pembagiannya mengikuti stasiun kategori di Kaly Core › Kelola kategori. Bila kertas macet, pakai <b>Cetak ulang slip Bar & Dapur</b> di menu aksi bill.</p>
          <div class="row wrap"><button class="btn">Simpan jumlah lembar</button><button type="button" class="btn" data-a="receiptEdit">${ic('receipt', 16)} Atur tampilan nota</button></div></form>
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
    clearInterval(prT);
    // Perbarui status printer tanpa menggambar ulang formulir pengaturan
    const upd = async () => { try { await C.loadQuiet('printers'); const el = document.querySelector('#pr-card .pr-list'), c = ctxNow(); if (el && c) { const tmp = document.createElement('div'); tmp.innerHTML = printerCard(c); el.replaceWith(tmp.querySelector('.pr-list')); } } catch {} };
    prT = setInterval(upd, 30000); upd();
    DN.refreshInfo().then(repaintPush);
  },
  unmount() { clearInterval(prT); prT = null; },
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
    receiptEdit(el, e, ctx) { import('./receipt-editor.js').then((mod) => mod.openReceiptEditor(ctx)); },
    prLoc(el) { pui.loc = el.dataset.v; rerender(); },
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
    prNew(el, e, ctx) { printerForm(ctx.db, null, pui.loc || ctx.outlet); },
    prEdit(el, e, ctx) { const p = ctx.db.printers.find((x) => x.id === el.dataset.id); if (p) printerForm(ctx.db, p, p.loc); },
    async prSlip(el, e, ctx) {
      const L = el.dataset.loc, k = el.dataset.k, pid = el.dataset.p, loc = ctx.db.locations.find((l) => l.id === L);
      const cur = (loc?.route || {})[k], to = cur === pid ? 'local' : pid;
      const from = ctx.db.printers.find((x) => x.id === cur), dest = ctx.db.printers.find((x) => x.id === to);
      el.disabled = true;
      try { await API.printRouteSave(L, { ...(loc?.route || {}), [k]: to }); await C.refresh('org'); }
      catch (err) { el.disabled = false; return toast(err.message, 'err', 6000); }
      toast(dest ? `${KIND_LABEL[k]} dicetak di ${dest.name}${from && from.id !== dest.id ? ` (dipindah dari ${from.name})` : ''}` : `${KIND_LABEL[k]} dicetak di perangkat kasir`); rerender();
    },
    async prRoute(el, e, ctx) {
      const L = el.dataset.loc, k = el.dataset.k, loc = ctx.db.locations.find((l) => l.id === L);
      const route = { ...(loc?.route || {}), [k]: el.value };
      el.disabled = true;
      try { await API.printRouteSave(L, route); await C.refresh('org'); }
      catch (err) { el.disabled = false; return toast(err.message, 'err', 6000); }
      const p = ctx.db.printers.find((x) => x.id === el.value);
      toast(`${KIND_LABEL[k]} dicetak di ${p ? p.name : 'perangkat kasir'}`); rerender();
    },
    async prPing(el, e, ctx) {
      const p = ctx.db.printers.find((x) => x.id === el.dataset.id); if (!p) return;
      el.disabled = true;
      try { await checkPrinter(p); toast(`${p.name} tersambung (${connText(p)})`); } catch (err) { toast(`${p.name}: ${err.message}`, 'err', 7000); } finally { el.disabled = false; }
    },
    async prTest(el, e, ctx) {
      const p = ctx.db.printers.find((x) => x.id === el.dataset.id); if (!p) return;
      el.disabled = true;
      if (isApp() && isDirect(p)) {  // aplikasi Android: langsung ke printer LAN/Bluetooth/USB
        try { await printDirect(p, testSlipHtml(ctx.db, p, ctx.user.name), paperOf(ctx.db)); toast(`Cetak tes dikirim ke ${p.name}`); }
        catch (err) { toast(`${p.name}: ${err.message}`, 'err', 7000); } finally { el.disabled = false; }
        return;
      }
      try { await API.printEnqueue([{ station: p.id, kind: 'test', label: 'Cetak tes', html: testSlipHtml(ctx.db, p, ctx.user.name) }]); C.refresh('printJobs').catch(() => {});
        toast(stationOnline(p) ? `Cetak tes dikirim ke ${p.name}` : `Cetak tes masuk antrean ${p.name}. Lembar keluar setelah stasiun cetaknya dinyalakan.`, stationOnline(p) ? 'ok' : 'info', 6000); }
      catch (err) { toast(err.message, 'err', 6000); } finally { el.disabled = false; }
    },
    async savePrint(form) {
      const f = formData(form);
      const printCopies = Object.fromEntries(['cust', 'copy', 'bar', 'dapur'].map((k) => [k, Math.max(0, Math.min(5, Math.round(Number(f['pc_' + k]) || 0)))]));
      await API.saveSettings({ printCopies }); await C.refresh('settings');
      const total = printCopies.cust + printCopies.copy + printCopies.bar + printCopies.dapur;
      toast(`Cetak nota disimpan: sampai ${total} lembar sekali cetak`); rerender();
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
