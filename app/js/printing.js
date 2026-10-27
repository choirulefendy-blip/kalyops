// Cetak dari Kaly Ops: di perangkat ini (jendela cetak browser), dikirim ke printer lain lewat stasiun cetak (2.1),
// atau langsung ke printer LAN/Wi-Fi lewat aplikasi Android Kaly Ops (2.2, ESC/POS ke ip:port).
// Tujuan tiap jenis lembar diatur Owner per outlet di Pengaturan › Printer & tujuan cetak (locations.print_route).
import { getDb } from './store.js';
import * as API from './api.js';
import * as C from './cloud.js';
import * as D from './domain.js';
import { toast, openModal, esc, fmtTime, fmtDT } from './lib.js';
import { isApp, printDirect, systemPrint, isDirect, connText, connOf } from './escpos.js';

export const KINDS = ['cust', 'copy', 'bar', 'dapur'];
export const KIND_LABEL = { cust: 'Nota pelanggan', copy: 'Salinan kasir', bar: 'Slip Bar', dapur: 'Slip Dapur', test: 'Cetak tes' };
export const ONLINE_MS = 90000;  // stasiun dianggap aktif bila melapor dalam 90 detik terakhir

// ---------- Cetak di perangkat ini ----------
// Satu cetakan sekali jalan (perangkat kasir bisa sekaligus menjadi stasiun cetak). Menunggu gambar (logo, QRIS) termuat.
let chain = Promise.resolve();
export function printHtml(html) {
  // Aplikasi Android: WebView tidak punya jendela cetak browser, pakai layanan cetak Android
  if (isApp()) { const p = chain.then(() => { if (!systemPrint(html)) throw new Error('Cetak tidak tersedia di aplikasi ini'); }); chain = p.catch(() => {}); return p; }
  const p = chain.then(() => new Promise((res, rej) => {
    let el = document.getElementById('print-area');
    if (!el) { el = document.createElement('div'); el.id = 'print-area'; document.body.appendChild(el); }
    el.innerHTML = html;
    let fired = false;
    const go = () => {
      if (fired) return; fired = true;
      setTimeout(() => { try { window.print(); res(); } catch (e) { rej(e); } }, 50);
    };
    const imgs = [...el.querySelectorAll('img')].filter((i) => !i.complete);
    if (!imgs.length) return go();
    let left = imgs.length;
    setTimeout(go, 3000);
    imgs.forEach((i) => { i.addEventListener('load', () => { if (--left <= 0) go(); }); i.addEventListener('error', () => { if (--left <= 0) go(); }); });
  }));
  chain = p.catch(() => {});
  return p;
}
export function doPrint(html) { printHtml(html).catch((e) => toast(e.message, 'err')); }

// ---------- Printer & tujuan cetak ----------
export const paperOf = (db) => db.settings?.receipt?.paper || 58;
export const lanText = connText;  // nama lama (2.2)
export const stationOnline = (p, now = Date.now()) => !!p?.seen && now - p.seen < ONLINE_MS;
// Printer perangkat ini (aplikasi Android): tujuan lembar "Perangkat kasir"
const DEV_KEY = 'kaly.devicePrinter';
export function devicePrinterId() { try { return localStorage.getItem(DEV_KEY) || null; } catch { return null; } }
export function setDevicePrinter(id) { try { if (id) localStorage.setItem(DEV_KEY, id); else localStorage.removeItem(DEV_KEY); } catch {} }
export const devicePrinter = (db) => (db.printers || []).find((p) => p.id === devicePrinterId() && p.active && isDirect(p)) || null;
// Cetak HTML ke satu printer dari perangkat ini: LAN langsung (aplikasi Android) atau jendela cetak
export function printTo(p, html) { return isApp() && p && isDirect(p) ? printDirect(p, html, paperOf(getDb())) : printHtml(html); }
export const printersAt = (db, L) => (db.printers || []).filter((p) => p.active && p.loc === L);
export function seenText(p, now = Date.now()) {
  if (!p?.seen) return 'Belum pernah dinyalakan';
  if (now - p.seen < ONLINE_MS) return 'Aktif';
  const m = Math.round((now - p.seen) / 60000);
  return m < 60 ? `Terakhir aktif ${m} menit lalu` : `Terakhir aktif ${fmtTime(p.seen)}`;
}
// Lembar uji untuk memastikan stasiun mencetak ke printer yang benar
export function testSlipHtml(db, p, who = '') {
  const R = db.settings.receipt || C.receiptCfg({});
  return `<div class="slip"><div class="receipt kslip rc-${R.font}" style="--paper:${R.paper}mm"><h3>CETAK TES</h3><p class="ks-where">${esc(p.name)}</p>
    <p>${esc(D.loc(db, p.loc)?.name || '')}<br>${fmtDT(Date.now())}${who ? ' · ' + esc(who) : ''}</p><hr><p>Lembar ini keluar di printer yang benar? Stasiun cetak siap dipakai.</p></div></div>`;
}
// Tujuan tiap jenis lembar di outlet L: objek printer, atau null = perangkat yang menekan Cetak
export function routeOf(db, L) {
  const r = D.loc(db, L)?.route || {};
  return Object.fromEntries(KINDS.map((k) => [k, printersAt(db, L).find((p) => p.id === r[k]) || null]));
}

function askLanFail(p, pieces, msg) {
  return new Promise((res) => {
    let done = false;
    const fin = (v) => { done = true; res(v); };
    openModal({ title: `${p.name} tidak bisa dihubungi`, size: 'sm',
      body: `<p>${pieces.map((x) => `<b>${esc(x.label || KIND_LABEL[x.kind])}</b>`).join('<br>')}<br>belum tercetak.</p>
        <p class="muted sm">${esc(msg)} (${esc(connText(p))}). ${{ bt: 'Pastikan printer menyala, kertasnya ada, Bluetooth tablet aktif, dan printer sudah dipasangkan serta tidak tersambung ke HP lain.', usb: 'Pastikan printer menyala, kertasnya ada, dan kabel USB/OTG tersambung ke tablet ini.' }[connOf(p)] || 'Pastikan printer menyala, kertasnya ada, dan tablet tersambung ke jaringan yang sama dengan printer.'}</p>`,
      footer: `<button class="btn btn-ghost" data-close>Lewati</button><button class="btn" data-sys>Cetak lewat Android</button><button class="btn btn-pri" data-retry>Coba lagi</button>`,
      onClose: () => { if (!done) res('skip'); },
      onMount(m, api) { m.querySelector('[data-retry]').onclick = () => { fin('retry'); api.close(); }; m.querySelector('[data-sys]').onclick = () => { fin('system'); api.close(); }; } });
  });
}

function askOffline(list) {
  const names = [...new Set(list.map((x) => x.name))];
  const when = (s) => (s ? `terakhir aktif ${fmtTime(Date.parse(s))}` : 'belum pernah dinyalakan');
  return new Promise((res) => {
    let done = false;
    openModal({ title: `${names.join(' & ')} belum aktif`, size: 'sm',
      body: `<p>${list.map((x) => `<b>${esc(x.label || KIND_LABEL[x.kind])}</b> ke ${esc(x.name)} (${when(x.seen)})`).join('<br>')}.</p>
        <p class="muted sm">Lembar sudah masuk antrean dan otomatis tercetak begitu perangkat stasiun printer itu menyala. Bila perlu sekarang, cetak di perangkat ini saja.</p>`,
      footer: `<button class="btn" data-close>Biarkan di antrean</button><button class="btn btn-pri" data-here>Cetak di perangkat ini</button>`,
      onClose: () => { if (!done) res('queue'); },
      onMount(m, api) { m.querySelector('[data-here]').onclick = () => { done = true; api.close(); res('here'); }; } });
  });
}

// Kirim lembar-lembar satu pesanan sesuai tujuan cetak outlet. pieces = [{ kind, html (semua rangkap), label }]
// Hasil: { here: [jenis yang dicetak di perangkat ini], sent: [{ kind, name }] }
export async function sendPrints(order, pieces, { forceLocal = false } = {}) {
  const db = getDb(), R = routeOf(db, order.loc);
  const here = [], remote = [], lan = new Map();
  for (const pc of pieces) {
    const st = forceLocal ? null : R[pc.kind];
    // Aplikasi Android: printer ber-IP dicetak langsung; "Perangkat kasir" = printer perangkat ini
    const tgt = isApp() ? (st ? (isDirect(st) ? st : null) : devicePrinter(db)) : null;
    if (tgt) { if (!lan.has(tgt.id)) lan.set(tgt.id, { p: tgt, pieces: [] }); lan.get(tgt.id).pieces.push(pc); continue; }
    if (st) remote.push({ ...pc, st }); else here.push(pc);
  }
  const sent = [];
  if (lan.size) {
    const groups = [...lan.values()];
    const first = await Promise.all(groups.map((g) => printDirect(g.p, g.pieces.map((x) => x.html).join(''), paperOf(db)).then(() => null, (e) => e)));
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]; let e = first[i];
      while (e) {
        const a = await askLanFail(g.p, g.pieces, e.message);
        if (a === 'retry') e = await printDirect(g.p, g.pieces.map((x) => x.html).join(''), paperOf(db)).then(() => null, (x) => x);
        else { if (a === 'system') here.push(...g.pieces); break; }
      }
      if (!e) for (const x of g.pieces) sent.push({ kind: x.kind, name: g.p.name });
    }
  }
  if (remote.length) {
    try {
      const res = await API.printEnqueue(remote.map((p) => ({ station: p.st.id, kind: p.kind, order: order.id, label: p.label, html: p.html })));
      const rows = res.map((r, i) => ({ ...r, kind: remote[i].kind, label: remote[i].label, piece: remote[i] }));
      const now = Date.now();
      const off = rows.filter((r) => !r.seen || now - Date.parse(r.seen) > ONLINE_MS);
      let moved = new Set();
      if (off.length && (await askOffline(off)) === 'here') {
        const ids = await API.printCancel(off.map((r) => r.id)).catch(() => []);
        moved = new Set((ids || []).map(Number));
        for (const r of off) if (moved.has(Number(r.id))) here.push(r.piece);
        if (moved.size < off.length) toast('Sebagian lembar sudah diambil printer tujuan, jadi tidak dicetak dua kali di sini.', 'info', 6000);
      }
      for (const r of rows) if (!moved.has(Number(r.id))) sent.push({ kind: r.kind, name: r.name });
      C.refresh('printJobs').catch(() => {});
    } catch (e) {
      toast(`Printer tujuan tidak bisa dihubungi (${e.message}). Lembarnya dicetak di perangkat ini.`, 'warn', 7000);
      here.push(...remote);
    }
  }
  if (here.length) await printHtml(here.map((p) => p.html).join(''));
  const by = {};
  for (const s of sent) (by[s.name] ||= []).push(KIND_LABEL[s.kind].toLowerCase());
  const parts = [here.length ? `${isApp() ? 'Dicetak lewat Android' : 'Dicetak di sini'}: ${here.map((p) => KIND_LABEL[p.kind].toLowerCase()).join(', ')}` : '', ...Object.entries(by).map(([n, ks]) => `${ks.join(', ')} → ${n}`)].filter(Boolean);
  if (parts.length) toast(parts.join(' · '), 'ok', 5000);
  return { here: here.map((p) => p.kind), sent };
}
