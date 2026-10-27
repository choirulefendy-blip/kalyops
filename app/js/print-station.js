// Stasiun cetak (2.1): perangkat yang tersambung ke satu printer (Bar, Dapur, Kasir) mengambil antrean printer itu
// dan mencetaknya otomatis, di halaman apa pun yang sedang terbuka. Pilihan stasiun diingat per perangkat/profil browser.
import * as API from './api.js';
import * as C from './cloud.js';
import { subscribe, emit } from './bus.js';
import { printTo } from './printing.js';

const KEY = 'kaly.printStation';
export const state = { id: null, name: '', status: 'off', checked: 0, error: '', printed: 0, lastPrint: 0 };
let running = false, busy = false, again = false, timer = null, unhook = null, sig = '', halted = null;
// Kabari tampilan hanya bila status berubah (bukan setiap denyut)
function changed() { const k = `${state.id}|${state.status}|${state.error}|${state.printed}|${state.name}`; if (k !== sig) { sig = k; emit('station'); } }

export function stationId() { try { return localStorage.getItem(KEY) || null; } catch { return null; } }
export function setStation(id) {
  try { if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY); } catch {}
  state.printed = 0; state.error = ''; state.name = ''; halted = null;
  stopStation(); sync();
  emit('station');
}

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
  state.id = stationId();
  if (!state.id) { state.status = 'off'; return; }
  running = true; state.status = 'idle';
  unhook = C.onTables((t) => { if (t.includes('print_jobs') || t.includes('print_stations')) tick(); });
  tick();
}
export function stopStation() {
  running = false; clearTimeout(timer); timer = null;
  if (unhook) unhook(); unhook = null;
  state.status = stationId() ? 'idle' : 'off';
}
export const kick = () => tick();

async function tick() {
  if (!running) return;
  if (busy) { again = true; return; }
  busy = true; clearTimeout(timer);
  try {
    do {
      again = false;
      const r = await API.printClaim(state.id);
      state.name = r.name || state.name; state.checked = Date.now(); state.error = '';
      const jobs = r.jobs || [];
      if (jobs.length) {
        state.status = 'printing'; changed();
        const ids = jobs.map((j) => Number(j.id));
        try {
          // Aplikasi Android + printer ber-IP: langsung ke printer LAN; selain itu jendela cetak perangkat ini
          await printTo(C.db.printers.find((p) => p.id === state.id), jobs.map((j) => sanitize(j.html)).join(''));
          await API.printDone(ids, true);
          state.printed += ids.length; state.lastPrint = Date.now();
        } catch (e) {
          await API.printDone(ids, false, e.message || 'Gagal mencetak').catch(() => {});
          state.error = e.message || 'Gagal mencetak';
        }
        again = true;
        C.refresh('printJobs').catch(() => {});
      }
      state.status = state.error ? 'error' : 'idle';
      changed();
    } while (again && running);
  } catch (e) {
    state.status = 'error'; state.error = e.message; state.checked = Date.now();
    if (/dihapus|Akses ditolak/.test(e.message)) { running = false; halted = state.id; }  // printer dihapus / bukan outlet staf ini: berhenti, tunggu dipilih ulang
    changed();
  } finally {
    busy = false;
    if (running) timer = setTimeout(tick, document.hidden ? 15000 : 8000);
  }
}

// Menyala otomatis setelah login bila perangkat ini dipilih sebagai stasiun; berhenti saat keluar
function sync() {
  const want = !!(C.me && C.isReady() && stationId()) && halted !== stationId();
  if (want && (!running || state.id !== stationId())) startStation();
  else if (!want && running) stopStation();
  if (!C.me) halted = null;
}
subscribe((src) => { if (src !== 'station') sync(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && running) tick(); });
