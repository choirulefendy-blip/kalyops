// Editor tampilan nota: atur isi nota pelanggan (dan lebar/ukuran huruf slip Bar & Dapur) dengan pratinjau langsung
import { getDb, currentUser } from '../store.js';
import * as API from '../api.js';
import * as C from '../cloud.js';
import { esc, ic, toast, openModal, sum, confirmBox } from '../lib.js';
import * as D from '../domain.js';
import { qrisUrl } from '../media.js';
import { rerender } from '../app.js';
import { receiptHtml, kitchenSlipHtml, doPrint } from './pos.js';

// Nota contoh: transaksi lunas terakhir di outlet ini, atau pesanan contoh dari 3 menu pertama
function sample(db, L, paid) {
  const last = db.orders.filter((o) => o.status === 'paid' && o.loc === L && o.lines.some((l) => !l.par && l.s !== 'void')).sort((a, b) => (b.paidAt || 0) - (a.paidAt || 0))[0];
  const me = currentUser()?.id;
  let o;
  if (last) o = { ...last };
  else {
    const ms = db.menus.filter((m) => m.active && !m.pkg && m.price > 0);
    const pick = [ms.find((m) => m.station === 'dapur'), ms.find((m) => m.station === 'bar'), ms.find((m) => m.station === 'dapur' && m !== ms.find((x) => x.station === 'dapur'))].filter(Boolean);
    const lines = pick.map((m, i) => ({ id: 'contoh' + i, m: m.id, n: m.name, q: i ? 1 : 2, p: m.price, s: 'served', st: m.station, ts: Date.now() }));
    const sub0 = sum(lines, (l) => l.q * l.p), tax = Math.round(sub0 * db.settings.taxRate);
    o = { id: 'contoh', no: 'A001', loc: L, table: db.tables.find((t) => t.loc === L)?.id || null, merged: [], type: 'dine', ch: 'pos', by: me, paidBy: me, status: 'paid', paidAt: Date.now(),
      lines, pays: [{ m: 'cash', a: Math.ceil((sub0 + tax) / 1000) * 1000 }], change: Math.ceil((sub0 + tax) / 1000) * 1000 - (sub0 + tax), bill: { sub: sub0, discs: [], svc: 0, tax, total: sub0 + tax, base: sub0 } };
  }
  return paid ? o : { ...o, status: 'open', paidAt: null, pays: [], change: 0 };
}

export function openReceiptEditor(ctx) {
  const db0 = getDb();
  let R = { ...(db0.settings.receipt || C.receiptCfg({})) }, view = 'paid';
  const hasQris = !!qrisUrl(db0.settings);
  const sw = (k, label) => `<label class="switch"><input type="checkbox" data-rk="${k}" ${R[k] ? 'checked' : ''}><span>${label}</span></label>`;
  const body = `<div class="rce">
    <div class="rce-form">
      ${sw('logo', 'Tampilkan logo kaly')}
      <label class="fld"><span>Nama usaha</span><input class="inp" data-rk="name" value="${esc(R.name)}" placeholder="${esc(db0.settings.brand.name)}" maxlength="60"></label>
      ${sw('outlet', 'Tampilkan nama outlet')}
      <label class="fld"><span>Baris di bawah nama (alamat, WhatsApp, Instagram, NPWP)</span><textarea class="inp" data-rk="header" rows="3" maxlength="300" placeholder="Jl. Raya Kalibrantas, Malang&#10;WA 0812-0000-0000 · IG @kaly.eatery">${esc(R.header)}</textarea></label>
      ${sw('cashier', 'Tampilkan nama kasir')}
      ${sw('member', 'Tampilkan nama member & poin')}
      ${sw('qris', `Tagihan sementara memuat gambar QRIS toko${hasQris ? '' : ' (unggah QRIS dulu di Kaly Order › Pengaturan)'}`)}
      <label class="fld"><span>Pesan di bagian bawah</span><textarea class="inp" data-rk="footer" rows="3" maxlength="300" placeholder="Terima kasih sudah mampir.">${esc(R.footer)}</textarea></label>
      <div class="grid2"><label class="fld"><span>Lebar kertas printer</span><select class="inp" data-rk="paper"><option value="58" ${R.paper === 58 ? 'selected' : ''}>58 mm</option><option value="80" ${R.paper === 80 ? 'selected' : ''}>80 mm</option></select></label>
        <div class="fld"><span>Ukuran huruf</span><div class="seg" role="group" aria-label="Ukuran huruf">${[['kecil', 'Kecil'], ['normal', 'Normal'], ['besar', 'Besar']].map(([k, l]) => `<button type="button" data-font="${k}" class="${R.font === k ? 'on' : ''}">${l}</button>`).join('')}</div></div></div>
      <p class="hint">Lebar kertas dan ukuran huruf juga dipakai slip Bar & Dapur. Isi nota (menu, harga, total) selalu tampil.</p>
    </div>
    <div class="rce-prev"><div class="seg seg-sm" role="group" aria-label="Contoh nota"><button type="button" data-view="paid" class="on">Nota lunas</button><button type="button" data-view="open">Tagihan sementara</button><button type="button" data-view="slip">Slip Dapur</button></div>
      <div class="rc-paper" id="rce-out"></div></div></div>`;
  openModal({ title: 'Tampilan nota', size: 'lg', body,
    footer: `<button class="btn btn-ghost" data-reset>Kembalikan bawaan</button><button class="btn" data-test>${ic('printer', 16)} Cetak contoh</button><button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Simpan tampilan</button>`,
    onMount(m, api) {
      const out = m.querySelector('#rce-out');
      const html = () => {
        const db = getDb();
        if (view === 'slip') { const o = sample(db, ctx.outlet, false); const ls = o.lines.filter((l) => !l.par && l.st === 'dapur'); return kitchenSlipHtml(db, o, 'dapur', ls.length ? ls : o.lines.slice(0, 1), { cfg: R }); }
        return receiptHtml(db, sample(db, ctx.outlet, view === 'paid'), R);
      };
      const draw = () => { out.innerHTML = html(); };
      const fill = () => { m.querySelectorAll('[data-rk]').forEach((el) => { const k = el.dataset.rk; if (el.type === 'checkbox') el.checked = !!R[k]; else el.value = String(R[k]); }); m.querySelectorAll('[data-font]').forEach((b) => b.classList.toggle('on', b.dataset.font === R.font)); };
      draw();
      m.addEventListener('input', (e) => { const k = e.target.dataset.rk; if (!k) return; R[k] = e.target.type === 'checkbox' ? e.target.checked : k === 'paper' ? Number(e.target.value) : e.target.value; draw(); });
      m.addEventListener('change', (e) => { const k = e.target.dataset.rk; if (!k) return; R[k] = e.target.type === 'checkbox' ? e.target.checked : k === 'paper' ? Number(e.target.value) : e.target.value; draw(); });
      m.addEventListener('click', async (e) => {
        const f = e.target.closest('[data-font]'); if (f) { R.font = f.dataset.font; m.querySelectorAll('[data-font]').forEach((b) => b.classList.toggle('on', b === f)); draw(); return; }
        const v = e.target.closest('[data-view]'); if (v) { view = v.dataset.view; m.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b === v)); draw(); return; }
        if (e.target.closest('[data-test]')) { doPrint(`<div class="slip">${html()}</div>`); return; }
        if (e.target.closest('[data-reset]')) { if (await confirmBox('Kembalikan tampilan bawaan?', 'Isian di jendela ini diganti tampilan bawaan. Tekan Simpan tampilan untuk memakainya.', 'Kembalikan')) { R = { ...C.RECEIPT_DEFAULT }; fill(); draw(); } }
      });
      m.querySelector('[data-ok]').onclick = async () => {
        const btn = m.querySelector('[data-ok]'); btn.disabled = true;
        try { await API.saveSettings({ receipt: C.receiptCfg({ ...R, name: R.name.trim(), header: R.header.trim(), footer: R.footer.trim() }) }); await C.refresh('settings'); }
        catch (err) { btn.disabled = false; return toast(err.message, 'err', 6000); }
        api.close(); toast('Tampilan nota disimpan. Berlaku untuk cetakan berikutnya di semua kasir.'); rerender();
      };
    } });
}
