// Stasiun cetak (2.1): jadikan perangkat ini pencetak untuk satu printer, lihat antreannya, dan cara memasang di PC.
import * as API from '../api.js';
import * as C from '../cloud.js';
import * as D from '../domain.js';
import { esc, ic, toast, fmtTime, fmtDT, copyText } from '../lib.js';
import { rerender, can } from '../app.js';
import * as PS from '../print-station.js';
import { KINDS, KIND_LABEL, stationOnline, seenText, routeOf, printersAt, testSlipHtml, paperOf, devicePrinterId, setDevicePrinter } from '../printing.js';
import { isApp, appInfo, printDirect, checkPrinter, isDirect, connText } from '../escpos.js';

const JOB_ST = { queued: ['Antre', 'b-warn'], printing: ['Mencetak', 'b-info'], printed: ['Tercetak', 'b-ok'], failed: ['Gagal', 'b-err'], cancelled: ['Dibatalkan', 'b-mute'], expired: ['Kedaluwarsa', 'b-mute'] };
const ST_TXT = { idle: 'Siap. Antrean printer ini dicek otomatis setiap beberapa detik.', printing: 'Sedang mencetak…', error: 'Gagal menghubungi database', off: '' };
let refreshT = null, clockT = null;

const outlets = (ctx) => ctx.db.locations.filter((l) => l.type === 'outlet' && (!ctx.user.outlets?.length || ctx.user.outlets.includes(l.id)));
const base = () => location.href.split('#')[0];
const slug = (s) => s.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') || 'Printer';

function stationCard(ctx) {
  const db = ctx.db, id = PS.stationId(), mine = db.printers.find((p) => p.id === id);
  const all = outlets(ctx).map((l) => [l, printersAt(db, l.id)]).filter(([, ps]) => ps.length);
  if (!all.length) return `<section class="card"><div class="card-h"><h3>${ic('printer', 18)} Perangkat ini</h3></div>
    <p class="empty">Belum ada printer. ${can('settings') ? '<a href="#/settings">Tambahkan printer di Pengaturan › Printer & tujuan cetak</a>.' : 'Minta Owner menambahkannya di Pengaturan › Printer & tujuan cetak.'}</p></section>`;
  const s = PS.state;
  const sel = `<label class="fld"><span>Perangkat ini mencetak untuk</span><select class="inp" data-a-change="psSet" id="ps-sel"><option value="">Bukan stasiun cetak</option>
    ${all.map(([l, ps]) => `<optgroup label="${esc(l.name)}">${ps.map((p) => `<option value="${p.id}" ${p.id === id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</optgroup>`).join('')}</select></label>`;
  let body;
  if (id && !mine) body = `<div class="banner warn">${ic('triangle-alert', 18)}<span>Printer yang dipilih di perangkat ini sudah dihapus. Pilih printer lain.</span></div>`;
  else if (mine) body = `<div class="ps-now ${s.status}"><span class="ps-ic">${ic('printer', 26)}</span><div><b>${esc(mine.name)}</b><small>${esc(D.loc(db, mine.loc)?.name || '')}</small>
      <p class="${s.status === 'error' ? 'neg' : ''}">${esc(s.status === 'error' ? s.error || ST_TXT.error : ST_TXT[s.status] || '')}</p>
      <small class="muted"><span id="ps-checked">${s.checked ? `Terakhir cek ${fmtTime(s.checked)}` : 'Menyambung…'}</span>${s.printed ? ` · ${s.printed} lembar dicetak sejak halaman dibuka` : ''}</small></div></div>
    <div class="row wrap"><button class="btn btn-pri" data-a="psTest">${ic('printer', 16)} Cetak tes</button><button class="btn btn-ghost" data-a="psOff">Berhenti jadi stasiun</button></div>`;
  else body = `<p class="muted sm">Pilih printer bila perangkat ini tersambung ke printer itu (kabel USB, LAN, atau Wi-Fi yang sudah terpasang di perangkat ini). Lembar yang dikirim kasir ke printer tersebut akan dicetak otomatis dari perangkat ini, di halaman apa pun yang sedang terbuka.</p>`;
  return `<section class="card"><div class="card-h"><h3>${ic('printer', 18)} Perangkat ini</h3></div>${sel}${body}</section>`;
}

function jobsCard(ctx) {
  const db = ctx.db, id = PS.stationId(), mine = db.printers.find((p) => p.id === id);
  if (!mine) return '';
  const jobs = db.printJobs.filter((j) => j.station === id).slice(0, 40);
  return `<section class="card"><div class="card-h"><h3>Antrean & riwayat ${esc(mine.name)}</h3><small class="muted">12 jam terakhir</small></div>
    ${jobs.length ? `<div class="olist ps-jobs">${jobs.map((j) => { const [l, c] = JOB_ST[j.status] || [j.status, 'b-mute'];
      return `<div class="ol static"><span><b>${esc(j.label || KIND_LABEL[j.kind] || j.kind)}</b><small>${fmtTime(j.at)}${j.by ? ' · ' + esc(D.userName(db, j.by)) : ''}${j.printedAt ? ` · tercetak ${fmtTime(j.printedAt)}` : ''}${j.error ? ` · ${esc(j.error)}` : ''}</small></span>
        <span class="row-xs"><span class="badge ${c}">${l}</span>${j.status !== 'queued' ? `<button class="btn btn-sm btn-ghost" data-a="psRetry" data-id="${j.id}">Cetak lagi</button>` : ''}</span></div>`; }).join('')}</div>`
    : '<p class="empty sm">Belum ada lembar untuk printer ini.</p>'}</section>`;
}

function allCard(ctx) {
  const db = ctx.db, now = Date.now();
  const rows = outlets(ctx).map((l) => {
    const ps = printersAt(db, l.id); if (!ps.length) return '';
    const R = routeOf(db, l.id);
    return `<div class="ps-loc"><h4 class="sec-t">${esc(l.name)}</h4>${ps.map((p) => { const q = db.printJobs.filter((j) => j.station === p.id && j.status === 'queued').length;
      const st = isDirect(p) ? `${connText(p)} · ${isApp() ? 'dicetak langsung dari tablet ini' : 'dicetak dari aplikasi Android'}${p.seen ? ' · stasiun ' + seenText(p, now).toLowerCase() : ''}` : seenText(p, now);
      return `<div class="ps-row"><span class="dot ${stationOnline(p, now) || (isDirect(p) && isApp()) ? 'on' : ''}"></span><span><b>${esc(p.name)}</b><small>${esc(st)}${q ? ` · ${q} lembar antre` : ''}</small></span>
        <small class="muted">${KINDS.filter((k) => R[k]?.id === p.id).map((k) => KIND_LABEL[k]).join(', ') || 'Belum dipakai'}</small></div>`; }).join('')}
      <p class="hint">Dicetak di perangkat kasir: ${KINDS.filter((k) => !R[k]).map((k) => KIND_LABEL[k].toLowerCase()).join(', ') || 'tidak ada'}.</p></div>`;
  }).join('');
  if (!rows) return '';
  return `<section class="card"><div class="card-h"><h3>Semua printer</h3>${can('settings') ? `<a class="btn btn-sm" href="#/settings">${ic('settings', 15)} Atur tujuan cetak</a>` : ''}</div>${rows}</section>`;
}

// Aplikasi Android: printer untuk lembar "Perangkat kasir" dari tablet ini
function deviceCard(ctx) {
  if (!isApp()) return '';
  const db = ctx.db, id = devicePrinterId(), lan = (db.printers || []).filter((p) => p.active && isDirect(p)), mine = lan.find((p) => p.id === id);
  const info = appInfo();
  const old = !(info.features || []).includes('notify');
  return `<section class="card"><div class="card-h"><h3>${ic('smartphone', 18)} Printer tablet ini</h3><small class="muted">Aplikasi Android ${esc(info.app || '')}</small></div>
    ${old ? `<div class="banner info sm">${ic('download', 16)}<span>Aplikasi Android Kaly Ops versi 1.2 tersedia: notifikasi Android saat kasir membuka aplikasi lain. Pasang di atas aplikasi ini, login tetap tersimpan.</span><a class="btn btn-sm" href="android/kaly-ops.apk" download>Unduh</a></div>` : ''}
    ${lan.length ? `<label class="fld"><span>Lembar "Perangkat kasir" dari tablet ini dicetak ke</span><select class="inp" data-a-change="devSet" id="dev-sel"><option value="">Jendela cetak Android</option>
      ${lan.map((p) => `<option value="${p.id}" ${p.id === id ? 'selected' : ''}>${esc(p.name)} · ${esc(connText(p))}</option>`).join('')}</select></label>
      ${mine ? `<div class="row wrap"><button class="btn" data-a="devPing">Cek koneksi</button><button class="btn btn-pri" data-a="devTest">${ic('printer', 16)} Cetak tes</button></div>` : ''}
      <p class="hint">Printer LAN/Wi-Fi, Bluetooth, dan USB yang dipilih di <b>Pengaturan › Printer & tujuan cetak</b> (mis. slip Bar ke Printer Bar) selalu dicetak langsung dari tablet ini, tanpa stasiun cetak.</p>`
    : `<p class="empty sm">Belum ada printer LAN/Wi-Fi, Bluetooth, atau USB. ${can('settings') ? 'Tambahkan di <a href="#/settings">Pengaturan › Printer & tujuan cetak</a>.' : 'Minta Owner menambahkannya di Pengaturan › Printer & tujuan cetak.'}</p>`}</section>`;
}
function apkCard() {
  if (isApp()) return '';
  return `<section class="card"><div class="card-h"><h3>${ic('smartphone', 18)} Tablet Android</h3></div>
    <p class="muted sm">Kasir memakai tablet Android? Pasang <b>aplikasi Android Kaly Ops</b>: tablet langsung mencetak ke printer LAN/Wi-Fi, Bluetooth, atau USB tanpa PC dan tanpa jendela cetak, dan menampilkan notifikasi Android saat kasir membuka aplikasi lain.</p>
    <div class="row wrap"><a class="btn btn-pri" href="android/kaly-ops.apk" download>${ic('download', 16)} Unduh aplikasi Android (APK)</a></div>
    <p class="hint">Buka tautan ini dari tablet, izinkan pemasangan dari browser, lalu masuk dengan akun staf seperti biasa.</p></section>`;
}
function howCard(ctx) {
  if (isApp()) return '';
  const db = ctx.db, id = PS.stationId(), p = db.printers.find((x) => x.id === id) || printersAt(db, ctx.outlet)[0];
  const chrome = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"';
  const dir = `--user-data-dir="C:\\KalyPrint\\${p ? slug(p.name) : 'Printer-Bar'}"`;
  const url = `"${base()}#/print${p ? '?st=' + p.id : ''}"`;
  const setup = `${chrome} ${dir} ${url}`, daily = `${chrome} --kiosk-printing ${dir} ${url}`;
  const code = (t) => `<div class="ps-code"><code>${esc(t)}</code><button class="btn btn-sm" data-a="psCopy" data-t="${esc(t)}">${ic('copy', 14)} Salin</button></div>`;
  return `<section class="card ps-how"><div class="card-h"><h3>Cara memasang di PC/laptop Windows</h3></div>
    <ol class="steps-sm">
      <li>Pasang driver printer di Windows (USB, LAN, atau Wi-Fi), atur ukuran kertas 58 atau 80 mm sesuai <b>Tampilan nota</b>, lalu coba <i>Print test page</i>.</li>
      <li>Buat shortcut di desktop (klik kanan › New › Shortcut) dengan isi di bawah${p ? ` untuk <b>${esc(p.name)}</b>` : ''}. Folder <code>KalyPrint</code> yang berbeda membuat setiap printer punya jendela Chrome sendiri, jadi satu PC bisa melayani beberapa printer sekaligus.${code(setup)}</li>
      <li>Buka shortcut itu, masuk dengan akun staf, tekan <b>Cetak tes</b>, lalu di jendela cetak pilih printer yang benar dan tekan Print. Chrome mengingat printer ini untuk jendela tersebut.</li>
      <li>Ubah isi shortcut menjadi versi di bawah (ada <code>--kiosk-printing</code>) supaya berikutnya langsung tercetak tanpa jendela cetak. Tutup Chrome itu lalu buka lagi lewat shortcut.${code(daily)}</li>
      <li>Biarkan jendela stasiun terbuka selama operasional (boleh berada di belakang jendela lain). Tanda printer di kanan atas menunjukkan perangkat ini sedang menjadi stasiun.</li>
    </ol>
    <p class="hint">Tablet Android: buka halaman ini di Chrome dan pilih printernya. Setiap lembar menampilkan jendela cetak Android (perlu aplikasi/print service dari merek printer), jadi untuk Bar dan Dapur lebih praktis memakai PC atau laptop.</p></section>`;
}

export default {
  title: () => 'Stasiun cetak',
  render(ctx) {
    if (ctx.q.st) {
      const p = ctx.db.printers.find((x) => x.id === ctx.q.st && x.active);
      if (p) { if (PS.stationId() !== p.id) { PS.setStation(p.id); toast(`Perangkat ini menjadi stasiun ${p.name}`); } }
      else toast('Printer di tautan ini tidak ditemukan atau sudah dihapus', 'warn', 6000);
      delete ctx.q.st; try { history.replaceState(null, '', '#/print'); } catch {}
    }
    return `<div class="ps-page"><div class="ps-col">${deviceCard(ctx)}${stationCard(ctx)}${jobsCard(ctx)}</div><div class="ps-col">${allCard(ctx)}${apkCard()}${howCard(ctx)}</div></div>`;
  },
  after(root, ctx, first) {
    if (first) {
      clearInterval(refreshT); clearInterval(clockT);
      refreshT = setInterval(async () => { await C.loadQuiet('printers').catch(() => {}); if (document.activeElement?.id !== 'ps-sel') rerender(); }, 30000); C.refresh('printers', 'printJobs').catch(() => {});
      clockT = setInterval(() => { const el = document.getElementById('ps-checked'); if (el && PS.state.checked) el.textContent = `Terakhir cek ${new Date(PS.state.checked).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`; }, 1000);
    }
  },
  unmount() { clearInterval(refreshT); clearInterval(clockT); refreshT = clockT = null; },
  actions: {
    psSet(el) { const id = el.value || null; PS.setStation(id); const p = C.db.printers.find((x) => x.id === id); toast(p ? `Perangkat ini menjadi stasiun ${p.name}` : 'Perangkat ini bukan stasiun cetak lagi', p ? 'ok' : 'info'); rerender(); },
    devSet(el) { setDevicePrinter(el.value || null); const p = C.db.printers.find((x) => x.id === el.value); toast(p ? `Lembar "Perangkat kasir" dari tablet ini dicetak ke ${p.name}` : 'Lembar "Perangkat kasir" memakai jendela cetak Android'); rerender(); },
    async devPing(el, e, ctx) { const p = ctx.db.printers.find((x) => x.id === devicePrinterId()); if (!p) return; el.disabled = true; try { await checkPrinter(p); toast(`${p.name} tersambung`); } catch (err) { toast(`${p.name}: ${err.message}`, 'err', 7000); } finally { el.disabled = false; } },
    async devTest(el, e, ctx) { const p = ctx.db.printers.find((x) => x.id === devicePrinterId()); if (!p) return; el.disabled = true; try { await printDirect(p, testSlipHtml(ctx.db, p, ctx.user.name), paperOf(ctx.db)); toast(`Cetak tes dikirim ke ${p.name}`); } catch (err) { toast(`${p.name}: ${err.message}`, 'err', 7000); } finally { el.disabled = false; } },
    psOff() { PS.setStation(null); toast('Perangkat ini bukan stasiun cetak lagi', 'info'); rerender(); },
    async psTest(el, e, ctx) {
      const p = ctx.db.printers.find((x) => x.id === PS.stationId()); if (!p) return;
      el.disabled = true;
      try { await API.printEnqueue([{ station: p.id, kind: 'test', label: 'Cetak tes', html: testSlipHtml(ctx.db, p, ctx.user.name) }]); toast(`Cetak tes masuk antrean ${p.name}`); PS.kick(); await C.refresh('printJobs'); }
      catch (err) { toast(err.message, 'err', 6000); } finally { el.disabled = false; }
    },
    async psRetry(el) {
      el.disabled = true;
      try { await API.printRetry(Number(el.dataset.id)); toast('Lembar masuk antrean lagi'); PS.kick(); await C.refresh('printJobs'); }
      catch (err) { el.disabled = false; toast(err.message, 'err', 6000); }
    },
    async psCopy(el) { await copyText(el.dataset.t); toast('Disalin. Tempel di kolom lokasi shortcut.'); },
  },
};
