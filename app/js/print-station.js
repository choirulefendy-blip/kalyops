// Stasiun cetak (2.1): perangkat yang tersambung ke printer (Bar, Dapur, Kasir) mengambil antrean printer itu.
// 2.17: satu perangkat bisa melayani beberapa printer sekaligus (mis. satu tablet/PC untuk Kasir, Bar, dan Dapur)
// dan mencetaknya otomatis, di halaman apa pun yang sedang terbuka. Pilihan stasiun diingat per perangkat/profil browser.
import * as API from './api.js';
import * as C from './cloud.js';
import { subscribe, emit } from './bus.js';
import { printTo } from './printing.js';

const KEY = 'kaly.printStation';     // sampai 2.16: satu printer per perangkat
const KEY2 = 'kaly.printStations';   // 2.17: satu perangkat bisa menjadi stasiun beberapa printer sekaligus
// state = ringkasan semua printer perangkat ini; per[id] = status tiap printer
export const state = { id: null, ids: [], name: '', status: 'off', checked: 0, error: '', printed: 0, lastPrint: 0, per: {} };
let running = false, busy = false, again = false, timer = null, unhook = null, sig = '';
const halted = new Set();   // printer yang dihapus / bukan outlet staf ini: dilewati sampai dipilih ulang
// Kabari tampilan hanya bila status berubah (bukan setiap denyut)
function changed() {
  const k = state.ids.map((id) => { const x = state.per[id] || {}; return `${id}:${x.status}:${x.error}:${x.printed}:${x.name}`; }).join('|') + `|${state.status}`;
  if (k !== sig) { sig = k; emit('station'); }
}

export function stationIds() {
  try {
    const v = localStorage.getItem(KEY2);
    if (v) return [...new Set(JSON.parse(v))].filter((x) => typeof x === 'string' && x);
    const old = localStorage.getItem(KEY);
    return old ? [old] : [];
  } catch { return []; }
}
export const stationId = () => stationIds()[0] || null;   // kompatibel: printer pertama
export const isStation = (id) => stationIds().includes(id);
export function setStations(ids) {
  ids = [...new Set((ids || []).filter(Boolean))];
  try {
    if (ids.length) localStorage.setItem(KEY2, JSON.stringify(ids)); else localStorage.removeItem(KEY2);
    localStorage.removeItem(KEY);
  } catch {}
  for (const id of Object.keys(state.per)) if (!ids.includes(id)) delete state.per[id];
  for (const id of ids) halted.delete(id);
  state.error = ''; state.name = '';
  stopStation(); sync();
  emit('station');
}
export const setStation = (id) => setStations(id ? [id] : []);
export function toggleStation(id, on) { const s = new Set(stationIds()); if (on) s.add(id); else s.delete(id); setStations([...s]); }

// Isi cetakan dari database dibersihkan dulu: tanpa skrip, frame, atau atribut on*
export function sanitize(html) {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
  doc.querySelectorAll('script, iframe, object, embed, link, meta, base, form, input, button, textarea, select, style, frame, frameset').forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase(), v = a.value.replace(/\s+/g, '').toLowerCase();
      if (n.startsWith('on') || n === 'srcdoc' || (['src', 'href', 'xlink:href', 'action'].includes(n) && (v.startsWith('javascript:') || v.startsWith('vbscript:')))) el.removeAttribute(a.name);
    }
  });
  return doc.body.innerHTML;
}

function startStation() {
  stopStation();
  state.ids = stationIds(); state.id = state.ids[0] || null;
  if (!state.ids.length) { state.status = 'off'; return; }
  running = true; state.status = 'idle';
  unhook = C.onTables((t) => { if (t.includes('print_jobs') || t.includes('print_stations')) tick(); });
  tick();
}
export function stopStation() {
  running = false; clearTimeout(timer); timer = null;
  if (unhook) unhook(); unhook = null;
  state.status = stationIds().length ? 'idle' : 'off';
}
export const kick = () => tick();

// Ambil & cetak antrean satu printer. Hasil: true bila ada lembar (cek lagi)
async function serve(id) {
  const st = (state.per[id] ||= { name: '', status: 'idle', error: '', printed: 0, checked: 0, lastPrint: 0 });
  try {
    const r = await API.printClaim(id);
    st.name = r.name || st.name; st.checked = Date.now(); st.error = '';
    const jobs = r.jobs || [];
    if (!jobs.length) { st.status = 'idle'; return false; }
    st.status = 'printing'; changed();
    const ids = jobs.map((j) => Number(j.id));
    try {
      // Aplikasi Android + printer LAN/Bluetooth/USB: langsung ke printer; selain itu jendela cetak perangkat ini
      await printTo(C.db.printers.find((p) => p.id === id), jobs.map((j) => sanitize(j.html)).join(''));
      await API.printDone(ids, true);
      st.printed += ids.length; st.lastPrint = Date.now(); st.status = 'idle';
    } catch (e) {
      await API.printDone(ids, false, e.message || 'Gagal mencetak').catch(() => {});
      st.error = e.message || 'Gagal mencetak'; st.status = 'error';
    }
    return true;
  } catch (e) {
    st.status = 'error'; st.error = e.message; st.checked = Date.now();
    if (/dihapus|Akses ditolak/.test(e.message)) halted.add(id);
    return false;
  }
}
function summarize() {
  const xs = state.ids.map((id) => state.per[id]).filter(Boolean);
  state.status = !state.ids.length ? 'off' : xs.some((x) => x.status === 'printing') ? 'printing' : xs.some((x) => x.status === 'error') ? 'error' : 'idle';
  state.error = xs.find((x) => x.status === 'error')?.error || '';
  state.printed = xs.reduce((a, x) => a + (x.printed || 0), 0);
  state.lastPrint = Math.max(0, ...xs.map((x) => x.lastPrint || 0));
  state.checked = Math.max(0, ...xs.map((x) => x.checked || 0));
  state.name = xs.map((x) => x.name).filter(Boolean).join(', ');
}

async function tick() {
  if (!running) return;
  if (busy) { again = true; return; }
  busy = true; clearTimeout(timer);
  try {
    do {
      again = false;
      // Printer berbeda dicetak bersamaan; lembar untuk printer yang sama tetap berurutan
      const res = await Promise.all(state.ids.filter((id) => !halted.has(id)).map(serve));
      if (res.some(Boolean)) { again = true; C.refresh('printJobs').catch(() => {}); }
      summarize(); changed();
    } while (again && running);
    if (state.ids.length && state.ids.every((id) => halted.has(id))) running = false;
  } finally {
    busy = false;
    if (running) timer = setTimeout(tick, document.hidden ? 15000 : 8000);
  }
}

// Menyala otomatis setelah login bila perangkat ini dipilih sebagai stasiun; berhenti saat keluar
function sync() {
  const ids = stationIds();
  const want = !!(C.me && C.isReady() && ids.length) && ids.some((id) => !halted.has(id));
  if (want && (!running || state.ids.join() !== ids.join())) startStation();
  else if (!want && running) stopStation();
  if (!C.me) halted.clear();
}
subscribe((src) => { if (src !== 'station') sync(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && running) tick(); });
