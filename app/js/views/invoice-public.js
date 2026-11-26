// 2.22 · Halaman invoice untuk tamu. Dibuka lewat tautan bertoken tanpa login, rapi saat dicetak,
// dan tombol Unduh PDF memakai dialog cetak peramban (Simpan sebagai PDF) supaya tidak perlu
// memuat pustaka PDF apa pun ke aplikasi kasir.
import * as API from '../api.js';
import { esc, rp, num, ic, fmtDate, copyText, logo } from '../lib.js';

const ui = { state: 'load', inv: null, err: '' };

const STATUS = { terbit: ['BELUM LUNAS', 'inv-p-due'], lunas: ['LUNAS', 'inv-p-paid'], batal: ['DIBATALKAN', 'inv-p-void'] };

function load() {
  const t = new URLSearchParams(location.hash.split('?')[1] || '').get('t');
  if (!t) { ui.state = 'err'; ui.err = 'Tautan tidak lengkap.'; return render(); }
  API.publicInvoice(t)
    .then((d) => { if (!d) { ui.state = 'err'; ui.err = 'Invoice tidak ditemukan. Tautannya mungkin salah atau sudah dihapus.'; } else { ui.state = 'ok'; ui.inv = d; } render(); })
    .catch(() => { ui.state = 'err'; ui.err = 'Tidak bisa memuat invoice. Periksa koneksi, lalu muat ulang halaman.'; render(); });
}

function render() {
  const root = document.getElementById('view') || document.getElementById('root');
  if (root) root.innerHTML = view();
}

function view() {
  if (ui.state === 'load') return '<div class="inv-p"><p class="empty">Memuat invoice…</p></div>';
  if (ui.state === 'err') return `<div class="inv-p"><div class="inv-p-card"><p class="empty">${esc(ui.err)}</p></div></div>`;
  const v = ui.inv, f = v.from, b = v.billTo;
  const [sl, sc] = STATUS[v.status] || ['', ''];
  const to = [b.company, b.name].filter(Boolean);
  const bank = Array.isArray(f.bank) ? f.bank : [];

  return `<div class="inv-p">
    <div class="inv-p-bar no-print">
      <button class="btn btn-pri" onclick="window.print()">${ic('printer', 16)} Unduh PDF / Cetak</button>
      <button class="btn" data-copy>${ic('link', 16)} Salin tautan</button>
    </div>
    <div class="inv-p-card ${sc}">
      <div class="inv-p-head">
        <div>${logo('olive', 'inv-p-logo')}<h1>${esc(f.name || 'Invoice')}</h1>
          ${f.address ? `<p>${esc(f.address)}</p>` : ''}
          ${[f.phone, f.email].filter(Boolean).length ? `<p>${esc([f.phone, f.email].filter(Boolean).join(' · '))}</p>` : ''}
          ${f.npwp ? `<p>NPWP ${esc(f.npwp)}</p>` : ''}</div>
        <div class="inv-p-no"><b>INVOICE</b><span>${esc(v.no)}</span><em class="${sc}">${sl}</em></div>
      </div>

      <div class="inv-p-meta">
        <div><small>Ditagihkan kepada</small>
          ${to.length ? to.map((x, i) => `<p class="${i ? '' : 'b'}">${esc(x)}</p>`).join('') : '<p class="b">–</p>'}
          ${b.address ? `<p>${esc(b.address)}</p>` : ''}
          ${[b.phone, b.email].filter(Boolean).length ? `<p>${esc([b.phone, b.email].filter(Boolean).join(' · '))}</p>` : ''}
          ${b.npwp ? `<p>NPWP ${esc(b.npwp)}</p>` : ''}</div>
        <div class="r"><small>Tanggal invoice</small><p class="b">${esc(fmtDate(v.issuedOn))}</p>
          ${v.dueOn ? `<small>Jatuh tempo</small><p class="b">${esc(fmtDate(v.dueOn))}</p>` : ''}
          ${v.paidOn ? `<small>Dibayar</small><p class="b">${esc(fmtDate(v.paidOn))}</p>` : ''}
          ${f.outlet ? `<small>Outlet</small><p>${esc(f.outlet)}</p>` : ''}</div>
      </div>

      <table class="inv-p-t"><thead><tr><th>Keterangan</th><th class="r">Jml</th><th class="r">Harga</th><th class="r">Jumlah</th></tr></thead>
        <tbody>${(v.lines || []).map((l) => `<tr><td>${esc(l.name)}</td><td class="r">${num(l.qty)}</td><td class="r">${rp(l.price)}</td><td class="r">${rp(l.amount)}</td></tr>`).join('')
          || '<tr><td colspan="4" class="empty">Tidak ada rincian.</td></tr>'}</tbody></table>

      <div class="inv-p-sum"><dl>
        <dt>Subtotal</dt><dd>${rp(v.sub)}</dd>
        ${Number(v.disc) ? `<dt>Diskon</dt><dd>-${rp(v.disc)}</dd>` : ''}
        ${Number(v.svc) ? `<dt>Service ${Math.round(v.serviceRate * 100)}%</dt><dd>${rp(v.svc)}</dd>` : ''}
        ${Number(v.tax) ? `<dt>PB1 ${Math.round(v.taxRate * 100)}%</dt><dd>${rp(v.tax)}</dd>` : ''}
        ${Number(v.round) ? `<dt>Pembulatan</dt><dd>${v.round > 0 ? '-' : '+'}${rp(Math.abs(v.round))}</dd>` : ''}
        <dt class="big">Total</dt><dd class="big">${rp(v.total)}</dd>
        ${Number(v.paid) ? `<dt>Sudah dibayar</dt><dd>-${rp(v.paid)}</dd><dt class="big">Sisa tagihan</dt><dd class="big">${rp(v.due)}</dd>` : ''}
      </dl></div>

      ${v.note ? `<p class="inv-p-note">${esc(v.note)}</p>` : ''}
      ${bank.length ? `<div class="inv-p-bank"><small>Pembayaran transfer ke</small>
        ${bank.map((x) => `<p><b>${esc(x.bank || '')}</b> ${esc(x.no || '')}${x.an ? ` · a.n. ${esc(x.an)}` : ''}</p>`).join('')}</div>` : ''}
      ${f.terms ? `<p class="inv-p-terms">${esc(f.terms)}</p>` : ''}
      <p class="inv-p-foot">${esc(f.footer || 'Terima kasih atas kepercayaan Anda.')}</p>
    </div></div>`;
}

export default {
  title: () => (ui.inv ? `Invoice ${ui.inv.no}` : 'Invoice'),
  render() { return view(); },
  after(root, ctx, first) {
    // Menandai halaman ini supaya aturan cetak mengeluarkan kertas invoice, bukan struk kasir.
    document.body.classList.add('inv-print');
    if (first) { ui.state = 'load'; ui.inv = null; load(); }
    root.querySelector('[data-copy]')?.addEventListener('click', () => copyText(location.href));
  },
  unmount() { document.body.classList.remove('inv-print'); },
};
