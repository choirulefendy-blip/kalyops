// Peringatan stok setelah transaksi: bahan yang baru turun di bawah minimum dan menu yang baru habis karena bahan
import { getDb } from './store.js';
import { toast, esc } from './lib.js';
import * as D from './domain.js';

export function stockSnap(db, L) {
  if (!D.coreOn(db, L)) return { low: new Set(), blocked: new Set(), off: true };
  return { low: new Set(D.lowStock(db, L).map((x) => x.i)), blocked: new Set(D.stockBlockedMenus(db, L).map((m) => m.id)) };
}

export function stockAlert(before, L) {
  const db = getDb();
  if (!D.coreOn(db, L) || before?.off) return;
  const prev = before instanceof Set ? { low: before, blocked: null } : before;
  const low = D.lowStock(db, L).filter((x) => !prev.low.has(x.i));
  const blocked = prev.blocked ? D.stockBlockedMenus(db, L).filter((m) => !prev.blocked.has(m.id)) : [];
  const names = (arr) => arr.slice(0, 3).join(', ') + (arr.length > 3 ? ` dan ${arr.length - 3} lainnya` : '');
  if (blocked.length) toast(`Menu habis karena bahan: ${names(blocked.map((m) => m.name))}`, 'warn', 6000);
  if (low.length) toast(`Stok di bawah minimum: ${names(low.map((x) => x.item?.name || x.i))}. Buat PO di Kaly Goods.`, 'warn', 6000);
}

// Banner ringkas untuk layar dapur & POS
export function stockBanner(db, L, { compact = false } = {}) {
  if (!D.coreOn(db, L)) return '';
  const low = D.lowStock(db, L).sort((a, b) => a.q / (a.min || 1) - b.q / (b.min || 1));
  const blocked = D.stockBlockedMenus(db, L);
  if (!low.length && !blocked.length) return '';
  const fq = (x) => `${Number(Math.max(0, x.q).toFixed(2)).toLocaleString('id-ID')}/${Number(x.min.toFixed(2)).toLocaleString('id-ID')} ${esc(x.item?.unit || '')}`;
  const lowTxt = low.slice(0, compact ? 3 : 6).map((x) => `<span class="sb-i${x.q <= 0 ? ' out' : ''}">${esc(x.item?.name || x.i)} <small>${fq(x)}</small></span>`).join('');
  return `<div class="stock-banner">
    ${blocked.length ? `<p><b>${blocked.length} menu habis karena bahan:</b> ${blocked.slice(0, compact ? 4 : 8).map((m) => esc(m.name)).join(', ')}${blocked.length > (compact ? 4 : 8) ? ', …' : ''}</p>` : ''}
    ${low.length ? `<p><b>${low.length} bahan di bawah minimum</b> ${lowTxt}${low.length > (compact ? 3 : 6) ? '<span class="sb-i">…</span>' : ''}</p>` : ''}
  </div>`;
}
