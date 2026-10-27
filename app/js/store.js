// Penyimpanan Kaly Ops versi tersambung: data dari database Supabase (lihat cloud.js).
// `local()` hanya untuk perubahan sementara di layar (optimistis) sebelum jawaban server datang.
import * as C from './cloud.js';
import { subscribe as sub, emit } from './bus.js';

export const APP_VERSION = '2.7';
const TERMINAL = 'kaly.terminal';

export const getDb = () => (C.me ? C.db : C.pub.db || C.db);
export const subscribe = sub;
export function local(fn) {
  const r = fn(C.db);
  C.db.rev = (C.db.rev || 0) + 1;
  emit('local');
  return r;
}
export function currentUser() { return C.me; }

export function getTerminal() { try { return localStorage.getItem(TERMINAL) || 'Kasir 1'; } catch { return 'Kasir 1'; } }
export function setTerminal(t) { try { localStorage.setItem(TERMINAL, t); } catch {} }

// Layar pelanggan (customer display) di perangkat yang sama dengan kasir: kanal ringan antar tab
export function pushDisplay(state) { try { localStorage.setItem('kaly.display', JSON.stringify({ ...state, at: Date.now() })); } catch {} }
export function readDisplay() { try { return JSON.parse(localStorage.getItem('kaly.display')); } catch { return null; } }

window.addEventListener('storage', (e) => {
  if (e.key === 'kaly.display') emit('display');
  if (e.key === 'kaly.auth') emit('auth');
});
