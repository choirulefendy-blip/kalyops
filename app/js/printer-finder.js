// 2.11 · Cari printer otomatis: USB yang tercolok, LAN/Wi-Fi di jaringan toko, Bluetooth di sekitar.
// Tanpa mengetik IP / alamat Bluetooth / vendor:produk. Butuh aplikasi Android Kaly Ops 1.4.
import { getDb, currentUser } from './store.js';
import { esc, ic, toast, openModal } from './lib.js';
import { listDevices, scanLan, scanBt, pairBt, MODELS, checkPrinter, onNativeEvent, isApp, canScan } from './escpos.js';
import { go, getOutlet } from './app.js';

const KIND = {
  usb: { title: 'USB ke tablet', icon: 'link', empty: 'Tidak ada printer USB yang tercolok. Colok printer dengan kabel USB/OTG, lalu Cari lagi.' },
  lan: { title: 'LAN / Wi-Fi', icon: 'layers', empty: 'Tidak ada printer di jaringan ini. Pastikan tablet & printer tersambung ke Wi-Fi/LAN yang sama.' },
  bt: { title: 'Bluetooth', icon: 'smartphone', empty: 'Tidak ada printer Bluetooth di sekitar. Nyalakan printer & dekatkan ke tablet.' },
};
const keyOf = (k, d) => (k === 'lan' ? d.ip : k === 'bt' ? d.addr : d.id);
const sameAs = (k, d) => getDb().printers.find((p) => (k === 'lan' ? p.ip === d.ip && (p.conn || 'lan') === 'lan' : k === 'bt' ? (p.bt || '').toUpperCase() === (d.addr || '').toUpperCase() : (p.usb || '').toLowerCase() === (d.id || '').toLowerCase()));

export function openFinder(ctx, L) {
  const st = { usb: null, lan: null, bt: null }, err = {};
  let api0 = null, alive = true;
  const row = (k, d, i) => {
    const p = sameAs(k, d), M = MODELS[d.model] && d.model !== 'umum' ? MODELS[d.model] : null;
    return `<div class="pf-row"><span class="pf-n"><b>${esc(d.name)}</b><small>${esc(keyOf(k, d))}${M ? ` · <span class="badge b-info">${esc(M.label)}</span>` : ''}${k === 'bt' && d.bonded === false ? ' · belum dipasangkan' : ''}</small></span>
      ${p ? `<span class="pf-r"><span class="badge b-ok">Terdaftar: ${esc(p.name)}</span></span>` : `<button class="btn btn-sm btn-pri" data-add="${k}" data-i="${i}">${k === 'bt' && d.bonded === false ? 'Pasangkan & tambah' : 'Tambah'}</button>`}</div>`;
  };
  // Bluetooth: HP/headset disembunyikan supaya tidak salah dipasangkan; bisa ditampilkan bila printer tidak dikenali
  let showOther = false;
  const listHtml = (k, list) => {
    const rows = list.map((d, i) => ({ d, i }));
    if (k !== 'bt') return rows.map(({ d, i }) => row(k, d, i)).join('');
    const pr = rows.filter((x) => x.d.printer || sameAs('bt', x.d)), oth = rows.filter((x) => !pr.includes(x));
    return (pr.map(({ d, i }) => row(k, d, i)).join('') || `<p class="muted sm">${KIND.bt.empty}</p>`)
      + (oth.length ? (showOther ? oth.map(({ d, i }) => row(k, d, i)).join('') : `<button class="lnk sm" data-other>Tampilkan ${oth.length} perangkat Bluetooth lain</button>`) : '');
  };
  const section = (k) => {
    const K = KIND[k], list = st[k];
    const body = err[k] ? `<p class="neg sm">${esc(err[k])}</p>` : list === null ? `<p class="muted sm pf-wait">${ic('refresh-cw', 14)} ${k === 'bt' ? 'Mencari di sekitar (±12 detik)…' : k === 'lan' ? 'Memindai jaringan…' : 'Memeriksa…'}</p>`
      : list.length ? listHtml(k, list) : `<p class="muted sm">${K.empty}</p>`;
    return `<section class="pf-sec" data-sec="${k}"><h4>${ic(K.icon, 16)} ${K.title}${list ? ` <span class="muted">${list.length}</span>` : ''}</h4>${body}</section>`;
  };
  const draw = () => `<p class="muted sm">Printer yang ditemukan tablet ini. Ketuk <b>Tambah</b>, lalu pilih lembar yang dicetak (Nota, Salinan, Bar, Dapur). Model Epson TM-T82X & Rongta RPP02N dikenali otomatis dari namanya.</p>
    <div class="pf-grid">${['usb', 'lan', 'bt'].map(section).join('')}</div>`;
  const paint = () => { if (alive && api0) api0.set(draw()); };
  const run = (k, fn) => { st[k] = null; delete err[k]; paint(); fn().then((x) => { st[k] = x || []; }, (e) => { err[k] = e.message; st[k] = []; }).finally(paint); };
  const all = () => { run('usb', () => listDevices('usb')); run('lan', scanLan); run('bt', scanBt); };
  openModal({
    title: 'Cari printer', size: 'md', body: draw(),
    footer: `<button class="btn" data-again>${ic('refresh-cw', 15)} Cari lagi</button><button class="btn btn-pri" data-close>Selesai</button>`,
    onClose: () => { alive = false; },
    onMount(m, api) {
      api0 = api;
      m.querySelector('[data-again]').onclick = all;
      m.addEventListener('click', async (e) => {
        if (e.target.closest('[data-other]')) { showOther = true; return paint(); }
        const b = e.target.closest('[data-add]'); if (!b) return;
        const k = b.dataset.add, d = st[k]?.[Number(b.dataset.i)]; if (!d) return;
        if (k === 'bt' && d.bonded === false) {
          b.disabled = true; b.textContent = 'Memasangkan…';
          try { await pairBt(d.addr); d.bonded = true; toast(`${d.name} terpasang ke tablet ini`); }
          catch (er) { b.disabled = false; b.textContent = 'Pasangkan & tambah'; return toast(er.message, 'err', 7000); }
        }
        api.close();
        addFound(ctx, L, k, d);
      });
      all();
    },
  });
}

// Buka formulir printer yang sudah terisi dari hasil pencarian
export async function addFound(ctx, L, k, d) {
  const M = MODELS[d.model] || MODELS.umum;
  const pre = { name: (d.model && d.model !== 'umum' ? M.label : d.name || 'Printer').slice(0, 40), loc: L, conn: k, model: d.model || 'umum', paper: M.paper,
    ...(k === 'lan' ? { ip: d.ip, port: d.port || 9100 } : k === 'bt' ? { bt: d.addr } : { usb: d.id }) };
  const mod = await import('./views/settings.js');
  mod.printerForm(getDb(), null, L, pre);
}

// Printer USB baru dicolok ke tablet (aplikasi 1.4 memberi tahu): siapkan izin, atau tawarkan untuk ditambahkan
let hooked = false;
export function hookUsb() {
  if (hooked || !isApp()) return;
  hooked = true;
  onNativeEvent((kind, d) => {
    if (kind !== 'usb' || !d?.id) return;
    const u = currentUser(); if (!u) return;
    const p = sameAs('usb', d);
    if (p) {
      toast(`${p.name} (USB) tersambung dan siap dipakai`, 'ok', 4000);
      checkPrinter(p).catch(() => {});   // minta izin USB sekarang, bukan saat mencetak pertama kali
      return;
    }
    if (u.role !== 'owner') return toast(`Printer USB baru terdeteksi: ${d.name}. Minta Manajer menambahkannya lewat Pengaturan › Printer di tablet ini.`, 'info', 7000);
    openModal({
      title: 'Printer USB tersambung', size: 'sm',
      body: `<p><b>${esc(d.name)}</b><br><span class="muted sm">${esc(d.id)}${d.model && d.model !== 'umum' ? ' · ' + esc(MODELS[d.model].label) : ''}</span></p><p class="muted sm">Tambahkan sebagai printer di tablet ini? Setelah itu pilih lembar yang dicetak.</p>`,
      footer: `<button class="btn" data-close>Nanti</button><button class="btn btn-pri" data-ok>Tambah printer ini</button>`,
      onMount(m, api) {
        m.querySelector('[data-ok]').onclick = () => {
          api.close();
          if (!location.hash.startsWith('#/settings')) go('settings');
          setTimeout(() => addFound({}, getOutlet(), 'usb', d), 400);
        };
      },
    });
  });
}
export { canScan };
