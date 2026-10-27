// Cetak langsung ke printer thermal dari aplikasi Android Kaly Ops: LAN/Wi-Fi (2.2), Bluetooth & USB (2.3, aplikasi 1.1).
// Lembar yang sama dengan cetak browser (HTML .slip) digambar ke kanvas selebar kertas, diubah hitam-putih,
// lalu dikirim sebagai perintah ESC/POS lewat jembatan aplikasi (window.KalyAndroid).

export const native = () => (typeof window !== 'undefined' && window.KalyAndroid) || null;
export const isApp = () => !!native();
export function appInfo() { try { return JSON.parse(native()?.info() || '{}'); } catch { return {}; } }
// Aplikasi 1.0 hanya bisa LAN; 1.1 menambah Bluetooth & USB
export const appFeatures = () => (isApp() ? appInfo().features || ['lan'] : []);

// ---------- Jenis sambungan printer ----------
export const CONN_LABEL = { pc: 'PC / stasiun cetak', lan: 'LAN / Wi-Fi', bt: 'Bluetooth', usb: 'USB ke tablet' };
export const connOf = (p) => p?.conn || (p?.ip ? 'lan' : 'pc');
// Printer yang dicetak langsung oleh aplikasi Android (bukan lewat jendela cetak / stasiun PC)
export const isDirect = (p) => { const c = connOf(p); return (c === 'lan' && !!p.ip) || (c === 'bt' && !!p.bt) || (c === 'usb' && !!p.usb); };
export function connText(p) {
  const c = connOf(p);
  if (c === 'lan' && p.ip) return `LAN ${p.ip}${p.port && p.port !== 9100 ? ':' + p.port : ''}`;
  if (c === 'bt' && p.bt) return `Bluetooth ${p.bt}`;
  if (c === 'usb' && p.usb) return `USB ${p.usb}`;
  return '';
}
const target = (p) => ({ lan: p.ip, bt: p.bt, usb: p.usb })[connOf(p)];

export const DOTS = { 58: 384, 80: 576 };          // lebar cetak printer 203 dpi: 48 mm dan 72 mm
const PX_PER_DOT = 96 / 25.4 / 8;                    // 1 titik printer = 1/8 mm

// ---------- Jembatan ke aplikasi Android ----------
const pend = new Map();
let seq = 0;
if (typeof window !== 'undefined') {
  window.KalyNative = window.KalyNative || {};
  window.KalyNative._done = (id, err, data) => { const p = pend.get(id); if (!p) return; pend.delete(id); clearTimeout(p.t); if (err) p.rej(new Error(err)); else p.res(data); };
}
function call(method, args, ms = 25000) {
  return new Promise((res, rej) => {
    const n = native();
    if (!n || typeof n[method] !== 'function') return rej(new Error('Fitur ini hanya ada di aplikasi Android Kaly Ops'));
    const id = 'k' + (++seq);
    const t = setTimeout(() => { if (pend.delete(id)) rej(new Error('Printer tidak menjawab')); }, ms);
    pend.set(id, { res, rej, t });
    try { n[method](...args, id); } catch (e) { pend.delete(id); clearTimeout(t); rej(e); }
  });
}

// ---------- HTML → gambar ----------
let h2c = null;
function loadH2C() {
  if (window.html2canvas) return Promise.resolve(window.html2canvas);
  return (h2c ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'vendor/html2canvas.min.js';
    s.onload = () => res(window.html2canvas);
    s.onerror = () => { h2c = null; rej(new Error('Gagal memuat pengolah gambar cetak')); };
    document.head.appendChild(s);
  }));
}
function waitImages(el) {
  const imgs = [...el.querySelectorAll('img')].filter((i) => !i.complete);
  if (!imgs.length) return Promise.resolve();
  return Promise.race([new Promise((r) => setTimeout(r, 3000)),
    Promise.all(imgs.map((i) => new Promise((r) => { i.addEventListener('load', r); i.addEventListener('error', r); })))]);
}
// Gambar SVG (logo) diubah dulu ke PNG seukuran tampilannya; html2canvas salah memotong SVG tanpa ukuran bawaan
async function rasterSvg(el, scale) {
  for (const img of el.querySelectorAll('img')) {
    if (!/\.svg(\?|$)/i.test(img.getAttribute('src') || '') && !/^data:image\/svg/i.test(img.src)) continue;
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height || !img.complete) continue;
    const c = document.createElement('canvas'); c.width = Math.round(r.width * scale); c.height = Math.round(r.height * scale);
    try { c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); } catch { continue; }
    img.style.width = r.width + 'px'; img.style.height = r.height + 'px';
    img.src = c.toDataURL('image/png');
    await new Promise((ok) => { if (img.complete) ok(); else { img.onload = ok; img.onerror = ok; } });
  }
}
// Setiap .slip menjadi satu kanvas selebar kertas (satu potongan kertas)
export async function renderSlips(html, paper = 58) {
  const H = await loadH2C();
  const dots = DOTS[paper] || DOTS[58];
  const wpx = +(dots * PX_PER_DOT).toFixed(2);
  const tmp = document.createElement('div'); tmp.innerHTML = html;
  let slips = [...tmp.querySelectorAll('.slip')];
  if (!slips.length) { const d = document.createElement('div'); d.className = 'slip'; d.innerHTML = html; slips = [d]; }
  const stage = document.createElement('div');
  stage.className = 'escpos-stage';
  stage.style.cssText = `position:absolute;left:-30000px;top:0;width:${wpx}px;background:#fff;`;
  document.body.appendChild(stage);
  const out = [];
  try {
    for (const s of slips) {
      stage.innerHTML = '';
      const el = s.cloneNode(true); el.style.width = wpx + 'px';
      stage.appendChild(el);
      await waitImages(el);
      await rasterSvg(el, 1 / PX_PER_DOT);
      const c = await H(el, { scale: 1 / PX_PER_DOT, backgroundColor: '#ffffff', useCORS: true, logging: false });
      out.push(c);
    }
  } finally { stage.remove(); }
  return out.map((c) => ({ canvas: c, dots }));
}

// ---------- Gambar → hitam-putih ----------
export function toMono(canvas, dots, threshold = 165) {
  const h = Math.max(1, Math.round(canvas.height * dots / canvas.width));
  const c = document.createElement('canvas'); c.width = dots; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, dots, h); ctx.drawImage(canvas, 0, 0, dots, h);
  const d = ctx.getImageData(0, 0, dots, h).data;
  const bpr = dots >> 3;
  let last = 0;
  const bits = new Uint8Array(bpr * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < dots; x++) {
      const i = (y * dots + x) * 4, a = d[i + 3] / 255;
      const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * a + 255 * (1 - a);
      if (lum < threshold) { bits[y * bpr + (x >> 3)] |= 0x80 >> (x & 7); last = y; }
    }
  }
  const rows = Math.min(h, last + 8);                // buang kertas kosong di bawah
  return { w: dots, h: rows, bpr, bits: bits.subarray(0, rows * bpr) };
}

// ---------- ESC/POS ----------
function gsv0(img) {                                  // GS v 0: raster, per pita 128 baris
  const parts = [];
  for (let y0 = 0; y0 < img.h; y0 += 128) {
    const rows = Math.min(128, img.h - y0);
    parts.push(Uint8Array.of(0x1d, 0x76, 0x30, 0x00, img.bpr & 0xff, img.bpr >> 8, rows & 0xff, rows >> 8));
    parts.push(img.bits.subarray(y0 * img.bpr, (y0 + rows) * img.bpr));
  }
  return parts;
}
function escStar(img) {                               // ESC * 33: 24 titik per baris, untuk printer lama
  const parts = [Uint8Array.of(0x1b, 0x33, 24)];
  const bit = (x, y) => (y < img.h ? (img.bits[y * img.bpr + (x >> 3)] >> (7 - (x & 7))) & 1 : 0);
  for (let y0 = 0; y0 < img.h; y0 += 24) {
    const row = new Uint8Array(5 + img.w * 3 + 1);
    row.set([0x1b, 0x2a, 33, img.w & 0xff, img.w >> 8]);
    for (let x = 0; x < img.w; x++) {
      for (let k = 0; k < 3; k++) {
        let b = 0;
        for (let j = 0; j < 8; j++) b |= bit(x, y0 + k * 8 + j) << (7 - j);
        row[5 + x * 3 + k] = b;
      }
    }
    row[row.length - 1] = 0x0a;
    parts.push(row);
  }
  parts.push(Uint8Array.of(0x1b, 0x32));
  return parts;
}
// Satu pekerjaan cetak: inisialisasi, setiap lembar diikuti 4 baris kosong dan potong kertas
export function escposJob(images, mode = 'raster') {
  const parts = [Uint8Array.of(0x1b, 0x40)];
  for (const img of images) {
    parts.push(...(mode === 'escstar' ? escStar(img) : gsv0(img)));
    parts.push(Uint8Array.of(0x1b, 0x64, 0x04, 0x1d, 0x56, 0x42, 0x00));
  }
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export function toBase64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------- Untuk dipakai modul cetak ----------
function needApp(p) {
  const c = connOf(p);
  if (!isDirect(p)) throw new Error(c === 'lan' ? 'Printer ini belum punya alamat IP' : c === 'bt' ? 'Printer ini belum punya alamat Bluetooth' : c === 'usb' ? 'Printer USB ini belum dipilih' : 'Printer ini dicetak lewat PC / stasiun cetak');
  if (c !== 'lan' && !appFeatures().includes(c)) throw new Error(`Perbarui aplikasi Android Kaly Ops ke versi 1.1 untuk printer ${CONN_LABEL[c]}`);
  return c;
}
// Cetak HTML (satu atau beberapa .slip) langsung ke printer LAN/Bluetooth/USB. Hasil: jumlah lembar.
export async function printDirect(printer, html, paperDefault = 58) {
  const c = needApp(printer);
  const paper = printer.paper || paperDefault || 58;
  const imgs = (await renderSlips(html, paper)).map(({ canvas, dots }) => toMono(canvas, dots));
  const b64 = toBase64(escposJob(imgs, printer.mode));
  if (c === 'lan' && typeof native()?.send !== 'function') await call('printRaw', [printer.ip, printer.port || 9100, b64]);   // aplikasi 1.0
  else await call('send', [c, target(printer), printer.port || 9100, b64], c === 'bt' ? 90000 : 30000);
  return imgs.length;
}
export const printLan = printDirect;
export function checkPrinter(p) {
  const c = needApp(p);
  if (c === 'lan' && typeof native()?.check !== 'function') return call('ping', [p.ip, p.port || 9100], 8000);
  return call('check', [c, target(p), p.port || 9100], c === 'bt' ? 30000 : 12000);
}
export const pingPrinter = checkPrinter;
// Printer di tablet ini: kind = bt (sudah dipasangkan) | usb (tersambung kabel)
export async function listDevices(kind) {
  if (!appFeatures().includes(kind)) throw new Error('Perbarui aplikasi Android Kaly Ops ke versi 1.1');
  const d = await call('list', [kind], 30000);
  try { return JSON.parse(d || '[]'); } catch { return []; }
}
export function systemPrint(html, name = 'Kaly Ops') {
  const n = native(); if (!n?.systemPrint) return false;
  const base = location.href.split('#')[0].replace(/[^/]*$/, '');
  n.systemPrint(`<!doctype html><html><head><meta charset="utf-8"><base href="${base}"><link rel="stylesheet" href="style.css"></head><body><div id="print-area" style="display:block">${html}</div></body></html>`, name);
  return true;
}
export async function saveFile(name, blob) {
  const n = native(); if (!n?.saveFile) return false;
  const b = new Uint8Array(await blob.arrayBuffer());
  n.saveFile(name, blob.type || 'application/octet-stream', toBase64(b));
  return true;
}
