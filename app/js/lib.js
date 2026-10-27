// Kaly Ops — helper umum (format, DOM, modal, chart, suara)
import { ICONS } from './icons.js';

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const rp = (n) => (n < 0 ? '-Rp' : 'Rp') + Math.abs(Math.round(n || 0)).toLocaleString('id-ID');
export const num = (n, d = 0) => Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: d });
export const pct = (n, d = 0) => (Number.isFinite(n) ? (n * 100).toLocaleString('id-ID', { maximumFractionDigits: d }) : '0') + '%';
export const uid = (p = '') => p + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 6);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const sum = (arr, f = (x) => x) => arr.reduce((s, x) => s + (f(x) || 0), 0);
export const groupBy = (arr, f) => arr.reduce((m, x) => { const k = f(x); (m[k] ||= []).push(x); return m; }, {});
export const DAY = 86400000;

export const pad = (n, w = 2) => String(n).padStart(w, '0');
export const dayKey = (ts = Date.now()) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const startOfDay = (ts = Date.now()) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const fromKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
const HARI = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
export const fmtTime = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}.${pad(d.getMinutes())}`; };
export const fmtDate = (ts, withDay = false) => { const d = new Date(ts); return `${withDay ? HARI[d.getDay()] + ', ' : ''}${d.getDate()} ${BULAN[d.getMonth()]} ${d.getFullYear()}`; };
export const fmtShort = (ts) => { const d = new Date(ts); return `${d.getDate()} ${BULAN[d.getMonth()]}`; };
export const fmtDT = (ts) => `${fmtShort(ts)} ${fmtTime(ts)}`;
export const mins = (ms) => Math.max(0, Math.round(ms / 60000));
export const dur = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };
export const hariNama = (ts) => HARI[new Date(ts).getDay()];

// Logo resmi KALY (vektor dari file logo brand) & ikon huruf k
export const LOGO = { light: 'assets/kaly-logo-offwhite.svg', olive: 'assets/kaly-logo-olive.svg', dark: 'assets/kaly-logo-dark.svg' };
export const logo = (variant = 'light', cls = '') => `<img class="logo ${cls}" src="${LOGO[variant]}" alt="kaly">`;
export const kIcon = (cls = '') => `<img class="k-icon ${cls}" src="assets/k-icon.svg" alt="" aria-hidden="true">`;

export const ic = (name, size = 18, cls = '') =>
  `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

// ---------- Toast ----------
export function toast(msg, kind = 'ok', ms = 2800) {
  let wrap = $('#toasts');
  if (!wrap) { wrap = document.createElement('div'); wrap.id = 'toasts'; wrap.setAttribute('role', 'status'); document.body.appendChild(wrap); }
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.innerHTML = `${ic(kind === 'err' ? 'circle-alert' : kind === 'warn' ? 'triangle-alert' : kind === 'info' ? 'bell' : 'circle-check', 18)}<span>${esc(msg)}</span>`;
  wrap.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, ms);
}

// ---------- Modal ----------
let modalStack = [];
export function openModal({ title, body, footer = '', size = 'md', onMount, onClose, dismissable = true }) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal modal-${size}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <header class="modal-h"><h2>${esc(title)}</h2>${dismissable ? `<button class="btn-icon" data-close aria-label="Tutup">${ic('x')}</button>` : ''}</header>
    <div class="modal-b">${body}</div>${footer ? `<footer class="modal-f">${footer}</footer>` : ''}</div>`;
  document.body.appendChild(back);
  const api = {
    el: back.querySelector('.modal'),
    close(v) { back.remove(); modalStack = modalStack.filter((m) => m !== api); onClose && onClose(v); },
    set(html) { back.querySelector('.modal-b').innerHTML = html; },
  };
  modalStack.push(api);
  back.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]') || (dismissable && e.target === back)) api.close();
  });
  onMount && onMount(api.el, api);
  const f = back.querySelector('[autofocus]') || back.querySelector('input,select,textarea,button:not([data-close])');
  f && setTimeout(() => f.focus(), 30);
  return api;
}
export const topModal = () => modalStack[modalStack.length - 1];
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modalStack.length) topModal().close(); });

export function formData(root) {
  const o = {};
  $$('[name]', root).forEach((el) => {
    if (el.type === 'checkbox') o[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; }
    else o[el.name] = el.value;
  });
  return o;
}

export function askReason(title, placeholder = 'Tulis alasan') {
  return new Promise((res) => {
    let done = false;
    openModal({
      title, size: 'sm',
      body: `<label class="fld"><span>Alasan</span><textarea name="r" rows="3" placeholder="${esc(placeholder)}" autofocus></textarea></label>`,
      footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Lanjutkan</button>`,
      onClose: () => { if (!done) res(null); },
      onMount(el, api) {
        el.querySelector('[data-ok]').onclick = () => {
          const v = el.querySelector('textarea').value.trim();
          if (!v) return toast('Alasan wajib diisi', 'warn');
          done = true; api.close(); res(v);
        };
      },
    });
  });
}

// Minta PIN manajer. PIN dicek ke server; hasil: PIN yang benar (string), atau null kalau dibatalkan.
export function askPin(reason) {
  return new Promise((res) => {
    let done = false;
    openModal({
      title: 'Persetujuan manajer', size: 'sm',
      body: `<p class="muted">${esc(reason)}</p><label class="fld"><span>PIN manajer</span><input name="pin" type="password" inputmode="numeric" maxlength="6" autocomplete="off" autofocus></label>`,
      footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Setujui</button>`,
      onClose: () => { if (!done) res(null); },
      onMount(el, api) {
        const go = async () => {
          const v = el.querySelector('input').value.trim();
          if (!v) return toast('Isi PIN manajer', 'warn');
          const btn = el.querySelector('[data-ok]'); btn.disabled = true;
          try {
            const { verifyPin } = await import('./api.js');
            if (await verifyPin(v)) { done = true; api.close(); res(v); }
            else toast('PIN salah', 'err');
          } catch (e) { toast(e.message || 'PIN tidak bisa dicek', 'err'); }
          finally { btn.disabled = false; }
        };
        el.querySelector('[data-ok]').onclick = go;
        el.querySelector('input').onkeydown = (e) => e.key === 'Enter' && go();
      },
    });
  });
}

export function confirmBox(title, msg, okLabel = 'Ya, lanjutkan', danger = false) {
  return new Promise((res) => {
    let done = false;
    openModal({
      title, size: 'sm', body: `<p>${msg}</p>`,
      footer: `<button class="btn" data-close>Batal</button><button class="btn ${danger ? 'btn-danger' : 'btn-pri'}" data-ok>${esc(okLabel)}</button>`,
      onClose: () => { if (!done) res(false); },
      onMount(el, api) { el.querySelector('[data-ok]').onclick = () => { done = true; api.close(); res(true); }; },
    });
  });
}

// ---------- Charts (SVG sederhana, satu seri) ----------
// data: [{label, value, tip?}]
export function barChart(data, { height = 180, fmt = rp, color = 'var(--c-data)', labelEvery = 1, highlight = -1 } = {}) {
  if (!data.length) return `<div class="empty-chart">Belum ada data</div>`;
  const W = Math.max(data.length * 28, 280), H = height, padB = 22, padT = 10;
  const max = Math.max(...data.map((d) => d.value), 1);
  const bw = W / data.length;
  const barW = Math.max(4, Math.min(28, bw - 4));
  const ticks = niceTicks(max);
  const y = (v) => H - padB - (v / ticks.max) * (H - padB - padT);
  let g = ticks.vals.map((t) => `<line x1="0" x2="${W}" y1="${y(t)}" y2="${y(t)}" class="grid"/>`).join('');
  let bars = data.map((d, i) => {
    const x = i * bw + (bw - barW) / 2, yy = y(d.value), h = Math.max(0, H - padB - yy);
    const r = Math.min(4, barW / 2, h);
    const path = h > 0 ? `M${x},${H - padB} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + barW - r} Q${x + barW},${yy} ${x + barW},${yy + r} V${H - padB} Z` : '';
    const lab = i % labelEvery === 0 ? `<text x="${x + barW / 2}" y="${H - 6}" class="axl" text-anchor="middle">${esc(d.label)}</text>` : '';
    return `<g class="bar${i === highlight ? ' hl' : ''}"><rect x="${i * bw}" y="0" width="${bw}" height="${H - padB}" class="hit"/><path d="${path}" fill="${color}"/>${lab}<title>${esc(d.tip || d.label)}: ${esc(fmt(d.value))}</title></g>`;
  }).join('');
  const yl = ticks.vals.filter((t) => t > 0).map((t) => `<span style="bottom:${((t / ticks.max) * (H - padB - padT) + padB) / H * 100}%">${esc(shortNum(t, fmt === rp))}</span>`).join('');
  return `<div class="chart" style="height:${H}px"><div class="yax">${yl}</div><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart-svg">${g}${bars}</svg></div>`;
}
export function hbars(data, { fmt = rp, max } = {}) {
  if (!data.length) return `<div class="empty-chart">Belum ada data</div>`;
  const m = max || Math.max(...data.map((d) => d.value), 1);
  return `<div class="hbars">${data.map((d) => `<div class="hb" title="${esc(d.label)}: ${esc(fmt(d.value))}"><span class="hb-l">${esc(d.label)}</span><span class="hb-t"><i style="width:${(d.value / m) * 100}%"></i></span><span class="hb-v">${esc(fmt(d.value))}</span></div>`).join('')}</div>`;
}
function niceTicks(max) {
  const p = Math.pow(10, Math.floor(Math.log10(max)));
  const steps = [1, 2, 2.5, 5, 10];
  let step = p;
  for (const s of steps) { if (max / (s * p) <= 4) { step = s * p; break; } }
  const top = Math.ceil(max / step) * step;
  const vals = []; for (let v = 0; v <= top + 1e-9; v += step) vals.push(v);
  return { max: top, vals };
}
export const shortNum = (v, money) => {
  const a = Math.abs(v);
  const s = a >= 1e9 ? num(v / 1e9, 1) + ' M' : a >= 1e6 ? num(v / 1e6, 1) + ' jt' : a >= 1e3 ? num(v / 1e3, 0) + ' rb' : num(v);
  return money ? s : s;
};

// ---------- File ----------
export function downloadCSV(filename, rows) {
  const csv = rows.map((r) => r.map((c) => { const s = String(c ?? ''); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\n');
  downloadBlob(filename, new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
}
// Di aplikasi Android Kaly Ops unduhan disimpan lewat jendela simpan Android
async function appSave(filename, blob) {
  const n = window.KalyAndroid; if (!n?.saveFile) return false;
  const b = new Uint8Array(await blob.arrayBuffer());
  let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  n.saveFile(filename, blob.type || 'application/octet-stream', btoa(s));
  return true;
}
export function downloadBlob(filename, blob) {
  if (window.KalyAndroid?.saveFile) { appSave(filename, blob).catch((e) => toast(e.message, 'err')); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}
export async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('Disalin ke clipboard'); }
  catch { toast('Tidak bisa menyalin otomatis — salin manual', 'warn'); }
}

// ---------- QR & barcode ----------
export function qrSvg(text, cell = 4) {
  if (!window.qrcode) return '';
  const q = window.qrcode(0, 'M'); q.addData(text); q.make();
  return q.createSvgTag({ cellSize: cell, margin: 2, scalable: true });
}
export function barcodeSvg(text, h = 40) {
  if (!window.JsBarcode) return '';
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  try { window.JsBarcode(s, text, { format: 'CODE128', height: h, displayValue: false, margin: 0, width: 1.6 }); } catch { return ''; }
  return s.outerHTML;
}

// ---------- Suara ----------
let actx;
export function chime() {
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    const t = actx.currentTime;
    [[784, 0], [1046.5, 0.18]].forEach(([f, d]) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.35, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.6);
      o.connect(g).connect(actx.destination); o.start(t + d); o.stop(t + d + 0.65);
    });
  } catch {}
}
export function speak(text) {
  try {
    if (window.KalyAndroid?.speak) return window.KalyAndroid.speak(String(text));  // aplikasi Android: suara Android (id-ID)
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'id-ID'; u.rate = 0.92;
    const v = speechSynthesis.getVoices().find((v) => v.lang?.startsWith('id'));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  } catch {}
}
export const spellNo = (no) => String(no).split('').map((c) => (/\d/.test(c) ? c : c + ',')).join(' ');
