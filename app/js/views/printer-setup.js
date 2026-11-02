// 2.15 · Printer & tujuan cetak. Diatur lengkap dari AKUN KASIR (Kaly POS › Printer): tambah/cari/pairing printer
// LAN, Bluetooth, USB, cetak tes, pembagian lembar (nota pelanggan, salinan, slip Bar, slip Dapur), jumlah lembar,
// dan tampilan nota. Kaly Backoffice (Owner/Manajer) hanya memantau: printerCard(ctx, { ro: true }).
import { currentUser } from '../store.js';
import { esc, ic, toast, formData, openModal, confirmBox } from '../lib.js';
import * as D from '../domain.js';
import * as C from '../cloud.js';
import * as API from '../api.js';
import { rerender, ctxNow } from '../app.js';
import { KINDS, KIND_LABEL, stationOnline, seenText, printersAt, testSlipHtml, paperOf } from '../printing.js';
import { isApp, printDirect, checkPrinter, isDirect, connOf, connText, CONN_LABEL, listDevices, appFeatures, MODELS, modelOf, scanLan, scanBt, pairBt } from '../escpos.js';

// ---------- Printer & tujuan cetak (2.1; LAN 2.2; Bluetooth & USB 2.3 untuk aplikasi Android) ----------
const prStatus = (p, now) => (isDirect(p) ? `${connText(p)}${p.paper ? ` · ${p.paper} mm` : ''}${p.mode === 'escstar' ? ' · ESC *' : ''}${p.seen ? ' · stasiun ' + seenText(p, now).toLowerCase() : ''}` : `PC / stasiun cetak · ${seenText(p, now)}`);
const pui = { loc: null };
let prT = null;  // status printer diperbarui setiap 30 detik selama layar printer terbuka
// 2.6: pengaturan per printer. Setiap printer punya panel sendiri: sambungan, kertas, dan lembar yang dicetaknya.
const SLIP_HINT = { cust: 'dengan harga & total', copy: 'bertanda SALINAN KASIR', bar: 'minuman, tanpa harga', dapur: 'makanan, tanpa harga' };
function slipChips(R, id, L, copies, ro) {
  if (ro) { const mine = KINDS.filter((k) => R[k] === id); return `<p class="pr-ro">${mine.length ? mine.map((k) => `<span class="badge b-ok">${KIND_LABEL[k]}${copies?.[k] !== undefined ? ` · ${copies[k]} lembar` : ''}</span>`).join(' ') : '<span class="muted sm">Belum ada lembar</span>'}</p>`; }
  return `<div class="pr-slips" role="group" aria-label="Lembar yang dicetak">${KINDS.map((k) => {
    const on = R[k] === id;
    return `<button type="button" class="pr-slip ${on ? 'on' : ''}" data-a="prSlip" data-k="${k}" data-p="${id}" data-loc="${L}" aria-pressed="${on}" title="${on ? 'Ketuk: kembalikan ke perangkat kasir' : 'Ketuk: cetak di printer ini'}">
      ${ic(on ? 'check' : 'plus', 14)}<span><b>${KIND_LABEL[k]}</b><small>${SLIP_HINT[k]}${on && copies?.[k] !== undefined ? ` · ${copies[k]} lembar` : ''}</small></span></button>`;
  }).join('')}</div>`;
}
function printerPanel(p, i, R, L, now, copies, ro) {
  const mine = KINDS.filter((k) => R[k] === p.id);
  const online = stationOnline(p, now) || (isDirect(p) && isApp());
  const addr = { lan: p.ip ? `${p.ip}:${p.port || 9100}` : '', bt: p.bt || '', usb: p.usb || '' }[connOf(p)] || '';
  return `<section class="pr-panel ${mine.length ? '' : 'idle'}" data-pr="${p.id}">
    <header class="pr-ph"><span class="pr-no">${i + 1}</span><span class="pr-pn"><b>${esc(p.name)}</b><small><span class="dot ${online ? 'on' : ''}"></span>${esc(prStatus(p, now))}</small></span>
      ${ro ? `<span class="badge ${online ? 'b-ok' : 'b-mute'}">${online ? 'Aktif' : isDirect(p) ? 'Dari tablet' : 'Tidak aktif'}</span>` : `<span class="row-xs">${isDirect(p) && isApp() ? `<button class="btn btn-sm btn-ghost" data-a="prPing" data-id="${p.id}">Cek</button>` : ''}<button class="btn btn-sm btn-ghost" data-a="prTest" data-id="${p.id}">Cetak tes</button><button class="btn btn-sm" data-a="prEdit" data-id="${p.id}">${ic('settings', 14)} Atur</button></span>`}</header>
    <dl class="pr-spec">${modelOf(p) !== 'umum' ? `<div><dt>Model</dt><dd>${esc(MODELS[modelOf(p)].label)}</dd></div>` : ''}<div><dt>Sambungan</dt><dd>${esc(CONN_LABEL[connOf(p)] || connOf(p))}</dd></div>${addr ? `<div><dt>${connOf(p) === 'lan' ? 'Alamat IP' : connOf(p) === 'bt' ? 'Bluetooth' : 'USB'}</dt><dd>${esc(addr)}</dd></div>` : ''}
      <div><dt>Kertas</dt><dd>${p.paper ? p.paper + ' mm' : 'ikut Tampilan nota'}${MODELS[modelOf(p)].cut === false ? ' · disobek manual' : ''}</dd></div>${isDirect(p) ? `<div><dt>Cara kirim</dt><dd>${p.mode === 'escstar' ? 'Printer lama (ESC *)' : 'Standar'}</dd></div>` : ''}</dl>
    <p class="pr-lbl">Lembar yang dicetak di printer ini</p>
    ${slipChips(R, p.id, L, copies, ro)}
    ${mine.length || ro ? '' : '<p class="hint">Belum ada lembar. Ketuk lembar di atas untuk mengarahkannya ke printer ini.</p>'}
  </section>`;
}
const locOf = (ctx, ro) => (ro && ctx.db.locations.some((l) => l.type === 'outlet' && l.id === pui.loc) ? pui.loc : ctx.outlet);
// ro = Kaly Backoffice: hanya memantau (status, sambungan, pembagian lembar). Kasir mengatur semuanya dari Kaly POS › Printer.
export function printerCard(ctx, { ro = false } = {}) {
  const db = ctx.db, outs = db.locations.filter((l) => l.type === 'outlet');
  const L = locOf(ctx, ro);
  const ps = printersAt(db, L), R = db.locations.find((l) => l.id === L)?.route || {}, now = Date.now(), copies = D.copiesFor(db, L);
  const local = KINDS.filter((k) => !ps.some((p) => p.id === R[k]));
  return `<div class="card" id="pr-card"><div class="card-h"><h3>${ic('printer', 17)} Printer & tujuan cetak${ro ? ' <span class="badge b-mute">pantau</span>' : ''}</h3>${ro ? '' : `<span class="row-xs">${isApp() && appFeatures().includes('scan') ? `<button class="btn btn-sm btn-pri" data-a="prFind">${ic('search', 15)} Cari printer</button>` : ''}<button class="btn btn-sm" data-a="prNew">${ic('plus', 15)} Tambah printer</button></span>`}</div>
    ${!ro && isApp() && !appFeatures().includes('recover') ? `<div class="banner info sm">${ic('download', 16)}<span>Aplikasi Android Kaly Ops <b>1.6</b> tersedia: tidak tertutup sendiri saat memori tablet penuh dan lebih ringan. Pasang di atas aplikasi ini; login dan printer tetap.</span><a class="btn btn-sm" href="android/kaly-ops.apk" download>Unduh</a></div>` : ''}
    ${ro ? `<p class="banner info sm">${ic('info', 16)}<span>Printer, pairing Bluetooth/USB, pembagian nota, jumlah lembar, dan tampilan nota diatur dari <b>akun kasir</b> di tablet: <b>Kaly POS › Printer</b>. Halaman ini hanya untuk memantau.</span></p>` : ''}
    <p class="muted sm">Setiap printer diatur sendiri: sambungan, lebar kertas, dan lembar yang dicetaknya. Satu lembar hanya keluar di satu printer; memilihnya di printer lain otomatis memindahkannya. Contoh: <b>Printer 1</b> nota pelanggan & salinan, <b>Printer 2</b> slip Bar, <b>Printer 3</b> slip Dapur.</p>
    ${ro || (isApp() && appFeatures().includes('scan')) ? '' : `<p class="hint">${ic('search', 14)} <b>Cari printer otomatis</b> (USB, LAN/Wi-Fi, Bluetooth tanpa mengetik alamat) tersedia di tablet dengan aplikasi Android Kaly Ops 1.4 ke atas. ${isApp() ? '<a href="android/kaly-ops.apk" download>Unduh versi 1.6</a>.' : ''}</p>`}
    ${ro && outs.length > 1 ? `<div class="chips">${outs.map((l) => `<button class="chip ${l.id === L ? 'on' : ''}" data-a="prLoc" data-v="${l.id}">${esc(l.name)}</button>`).join('')}</div>` : ''}
    <div class="pr-list pr-panels">${ps.length ? ps.map((p, i) => printerPanel(p, i, R, L, now, copies, ro)).join('') : '<p class="empty sm">Belum ada printer di outlet ini. ' + (ro ? 'Kasir menambahkannya dari Kaly POS › Printer.' : 'Tekan <b>Tambah printer</b> untuk setiap printer di lapangan (mis. 3 printer: Kasir, Bar, Dapur).') + '</p>'}</div>
    ${ps.length ? `<section class="pr-panel pr-local"><header class="pr-ph"><span class="pr-no">${ic('smartphone', 15)}</span><span class="pr-pn"><b>Perangkat kasir</b><small>Lembar tanpa printer tujuan dicetak oleh perangkat yang menekan Cetak</small></span></header>
      <p class="pr-lbl">${local.length ? local.map((k) => KIND_LABEL[k]).join(', ') : 'Semua lembar sudah punya printer.'}</p></section>` : ''}
    <p class="hint">Printer <b>LAN/Wi-Fi</b>, <b>Bluetooth</b>, dan <b>USB</b> dicetak langsung oleh tablet dengan <b>aplikasi Android Kaly Ops</b>; printer <b>PC / stasiun cetak</b> lewat halaman <a href="#/print">Stasiun cetak</a> di PC yang tersambung. Jumlah lembar per jenis diatur di <b>Jumlah lembar sekali cetak</b>. Bila printer tujuan mati, kasir ditawari mencetak di perangkatnya sendiri.</p></div>`;
}

// Jumlah lembar sekali cetak per outlet & tampilan nota
export function copiesCard(ctx, { ro = false } = {}) {
  const db = ctx.db, L = locOf(ctx, ro), pc = D.copiesFor(db, L);
  const rows = [['cust', 'Nota pelanggan', 'Lengkap dengan harga dan total'], ['copy', 'Salinan kasir', 'Sama dengan nota pelanggan, bertanda SALINAN KASIR'], ['bar', 'Slip Bar', D.stationCats(db, 'bar') || 'Kategori berstasiun Bar'], ['dapur', 'Slip Dapur', D.stationCats(db, 'dapur') || 'Kategori berstasiun Dapur']];
  return `<${ro ? 'div' : 'form'} class="card pc-card" ${ro ? '' : 'data-submit="savePrint"'} data-loc="${esc(L)}"><div class="card-h"><h3>${ic('printer', 17)} Jumlah lembar sekali cetak</h3><span class="muted sm">${esc(D.loc(db, L)?.name || '')}</span></div>
    <p class="muted sm">Sekali tekan <b>Cetak</b> di Kaly POS mencetak semua lembar di bawah, berurutan, ke printer tujuannya masing-masing. Isi 0 untuk lembar yang tidak perlu.</p>
    <div class="pc-grid">${rows.map(([k, l, h]) => `<label class="pc-row"><span><b>${l}</b><small>${esc(h)}</small></span>${ro ? `<b>${pc[k] ?? 1}</b>` : `<input class="inp" name="pc_${k}" type="number" min="0" max="5" step="1" value="${pc[k] ?? 1}" aria-label="Jumlah lembar ${l}">`}<span class="muted sm">lembar</span></label>`).join('')}</div>
    <p class="hint">Slip Bar dan Dapur hanya berisi item yang sudah dikirim ke dapur dan belum pernah tercetak, tanpa harga, jadi item yang sama tidak dibuat dua kali. Pembagiannya mengikuti stasiun kategori di Kaly Core › Kelola kategori. Bila kertas macet, pakai <b>Cetak ulang slip Bar & Dapur</b> di menu aksi bill.</p>
    ${ro ? `<p class="hint">Diubah oleh kasir di Kaly POS › Printer.</p>` : `<div class="row wrap"><button class="btn">Simpan jumlah lembar</button><button type="button" class="btn" data-a="receiptEdit">${ic('receipt', 16)} Atur tampilan nota</button></div>`}</${ro ? 'div' : 'form'}>`;
}
// Status printer diperbarui tiap 30 detik tanpa menggambar ulang layar
export function startStatus(ro = false) {
  clearInterval(prT);
  const upd = async () => { try { await C.loadQuiet('printers'); const el = document.querySelector('#pr-card .pr-list'), c = ctxNow(); if (el && c) { const tmp = document.createElement('div'); tmp.innerHTML = printerCard(c, { ro }); el.replaceWith(tmp.querySelector('.pr-list')); } else if (!el) stopStatus(); } catch {} };
  prT = setInterval(upd, 30000); upd();
}
export function stopStatus() { clearInterval(prT); prT = null; }
export const statusOn = () => !!prT;

export function printerForm(db, p, L, pre = null) {
  const v = p || pre;   // 2.11: isian awal dari Cari printer otomatis
  const me = currentUser();
  const outs = db.locations.filter((l) => l.type === 'outlet' && (!me?.outlets?.length || me.outlets.includes(l.id)));
  const conn0 = v ? connOf(v) : isApp() ? 'lan' : 'pc', app = isApp(), feat = appFeatures();
  const opt = (k, t) => `<option value="${k}" ${conn0 === k ? 'selected' : ''}>${t}</option>`;
  const scan = feat.includes('scan');
  const finder = (k) => (k === 'scanlan' ? (app && scan ? `<button type="button" class="btn btn-sm" data-find="scanlan">${ic('search', 14)} Cari di jaringan</button>` : '')
    : app && feat.includes(k) ? `<button type="button" class="btn btn-sm" data-find="${k}">${ic('search', 14)} ${k === 'bt' && scan ? 'Cari & pasangkan' : 'Cari di tablet ini'}</button>` : '');
  openModal({ title: p ? `Ubah ${p.name}` : 'Tambah printer', size: 'sm',
    body: `<label class="fld"><span>Model printer</span><select name="model" data-model>${Object.entries(MODELS).map(([k, m]) => `<option value="${k}" ${modelOf(v) === k ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select></label>
      <p class="hint pr-mhint" data-mhint></p>
      <label class="fld"><span>Nama printer</span><input name="name" maxlength="40" value="${esc(v?.name || '')}" placeholder="mis. Printer Bar" autofocus></label>
      <div class="grid2"><label class="fld"><span>Outlet</span><select name="loc">${outs.map((l) => `<option value="${l.id}" ${l.id === (v?.loc || L) ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
        <label class="fld"><span>Sambungan</span><select name="conn" data-conn>${opt('lan', 'LAN / Wi-Fi')}${opt('bt', 'Bluetooth')}${opt('usb', 'USB ke tablet')}${opt('pc', 'PC / stasiun cetak')}</select></label></div>
      <div class="pr-lan" data-for="lan"><div class="grid2"><label class="fld"><span>Alamat IP printer</span><input name="ip" value="${esc(v?.ip || '')}" placeholder="mis. 192.168.1.31" inputmode="decimal" autocomplete="off"></label>
        <label class="fld"><span>Port</span><input name="port" type="number" min="1" max="65535" value="${v?.port || 9100}"></label></div>
        ${finder('scanlan') ? `<div class="pr-find">${finder('scanlan')}</div><div class="pr-devs" data-devs="scanlan"></div>` : ''}
        <p class="hint">${app && feat.includes('scan') ? 'Tekan <b>Cari di jaringan</b> untuk menemukan printer di Wi-Fi/LAN toko, atau ' : ''}IP printer tercetak di lembar <i>self-test</i> (tahan FEED saat printer dinyalakan). Port hampir selalu 9100.</p></div>
      <div class="pr-lan" data-for="bt"><div class="pr-find"><label class="fld"><span>Alamat Bluetooth printer</span><input name="bt" value="${esc(v?.bt || '')}" placeholder="mis. 66:22:B3:44:55:66" autocomplete="off"></label>${finder('bt')}</div>
        <div class="pr-devs" data-devs="bt"></div>
        <p class="hint">${app && scan ? 'Nyalakan printer di dekat tablet, lalu tekan <b>Cari & pasangkan</b>: printer di sekitar muncul dan langsung dipasangkan (PIN 0000/1234 diisi otomatis).' : `Pasangkan (pair) printer dulu di <b>Pengaturan › Bluetooth</b> tablet${app ? ', lalu tekan <b>Cari di tablet ini</b>' : ''}. PIN printer biasanya 0000 atau 1234.`} Satu printer Bluetooth sebaiknya hanya dipakai satu tablet.</p></div>
      <div class="pr-lan" data-for="usb"><div class="pr-find"><label class="fld"><span>Printer USB (vendor:produk)</span><input name="usb" value="${esc(v?.usb || '')}" placeholder="mis. 0416:5011" autocomplete="off"></label>${finder('usb')}</div>
        <div class="pr-devs" data-devs="usb"></div>
        <p class="hint">Colok printer ke tablet kasir dengan kabel USB/OTG${app ? ', lalu tekan <b>Cari di tablet ini</b>. Android akan meminta izin memakai printer USB; centang <i>selalu</i>' : ', lalu buka Pengaturan ini dari aplikasi Android di tablet itu untuk memilihnya'}.</p></div>
      <div class="pr-lan" data-for="pc"><p class="hint">Printer yang tersambung ke PC atau laptop (USB, LAN, Wi-Fi yang terpasang di Windows). Lembarnya dicetak oleh PC itu lewat halaman <b>Stasiun cetak</b>.</p></div>
      <div class="grid2" data-for="lan bt usb"><label class="fld"><span>Lebar kertas</span><select name="paper"><option value="">Ikuti Tampilan nota</option><option value="58" ${v?.paper === 58 ? 'selected' : ''}>58 mm</option><option value="80" ${v?.paper === 80 ? 'selected' : ''}>80 mm</option></select></label>
        <label class="fld"><span>Cara kirim gambar</span><select name="mode"><option value="raster">Standar (GS v 0)</option><option value="escstar" ${v?.mode === 'escstar' ? 'selected' : ''}>Printer lama (ESC *)</option></select></label></div>
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
          if (k === 'bt' && scan) box.innerHTML = '<p class="muted sm">Mencari printer Bluetooth di sekitar (±12 detik). Pastikan printer menyala…</p>';
          if (k === 'scanlan') box.innerHTML = '<p class="muted sm">Memindai jaringan Wi-Fi/LAN toko…</p>';
          try {
            const list = k === 'scanlan' ? await scanLan() : k === 'bt' && scan ? await scanBt() : await listDevices(k);
            const fk = k === 'scanlan' ? 'ip' : k, val = (d) => (k === 'scanlan' ? d.ip : k === 'bt' ? d.addr : d.id);
            box.innerHTML = list.length ? list.map((d) => `<button type="button" class="pr-dev" data-pick="${fk}" data-v="${esc(val(d))}" data-model="${esc(d.model || '')}" ${k === 'bt' && d.bonded === false ? 'data-pair="1"' : ''}><b>${esc(d.name)}</b><small>${esc(val(d))}${d.printer ? ' · printer' : ''}${k === 'bt' && d.bonded === false ? ' · belum dipasangkan' : ''}</small></button>`).join('')
              : `<p class="muted sm">${k === 'scanlan' ? 'Tidak ada printer di jaringan ini. Pastikan tablet & printer di Wi-Fi/LAN yang sama, lalu cari lagi.' : k === 'bt' ? (scan ? 'Tidak ada printer Bluetooth di sekitar. Nyalakan printer & dekatkan ke tablet.' : 'Belum ada perangkat Bluetooth yang dipasangkan di tablet ini.') : 'Tidak ada printer USB yang tersambung ke tablet ini.'}</p>`;
          } catch (err) { box.innerHTML = `<p class="neg sm">${esc(err.message)}</p>`; }
          b.disabled = false; return;
        }
        const pk = e.target.closest('[data-pick]');
        if (pk && pk.dataset.pair) {   // 2.11: printer Bluetooth belum dipasangkan → pasangkan dari Kaly Ops
          pk.disabled = true; const sm = pk.querySelector('small'), t0 = sm.textContent; sm.textContent = 'Memasangkan… (PIN 0000/1234)';
          try { await pairBt(pk.dataset.v); delete pk.dataset.pair; sm.textContent = pk.dataset.v + ' · terpasang'; toast('Printer Bluetooth terpasang'); }
          catch (err) { sm.textContent = t0; pk.disabled = false; return toast(err.message, 'err', 6000); }
          pk.disabled = false;
        }
        if (pk) {
          if (pk.dataset.model && MODELS[pk.dataset.model] && pk.dataset.model !== 'umum' && msel.value === 'umum') { msel.value = pk.dataset.model; paintModel(true); }
          m.querySelector(`[name=${pk.dataset.pick}]`).value = pk.dataset.v; m.querySelectorAll(`[data-pick="${pk.dataset.pick}"]`).forEach((x) => x.classList.toggle('on', x === pk)); if (!m.querySelector('[name=name]').value.trim()) m.querySelector('[name=name]').value = pk.querySelector('b').textContent.slice(0, 40); }
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


export const actions = {
    prLoc(el) { pui.loc = el.dataset.v; rerender(); },
    prNew(el, e, ctx) { printerForm(ctx.db, null, ctx.outlet); },
    prFind(el, e, ctx) { import('../printer-finder.js').then((mod) => mod.openFinder(ctx, ctx.outlet)); },
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
    async savePrint(form, e, ctx) {
      const f = formData(form);
      const printCopies = Object.fromEntries(['cust', 'copy', 'bar', 'dapur'].map((k) => [k, Math.max(0, Math.min(5, Math.round(Number(f['pc_' + k]) || 0)))]));
      await API.printCopiesSave(form.dataset.loc || ctx.outlet, printCopies); await C.refresh('org');
      const total = printCopies.cust + printCopies.copy + printCopies.bar + printCopies.dapur;
      toast(`Cetak nota disimpan: sampai ${total} lembar sekali cetak`); rerender();
    },
    receiptEdit(el, e, ctx) { import('./receipt-editor.js').then((mod) => mod.openReceiptEditor(ctx)); },
};
