// Kabar perubahan data ke tampilan (dipakai store & cloud)
const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(src) { listeners.forEach((f) => { try { f(src); } catch (e) { console.error(e); } }); }
