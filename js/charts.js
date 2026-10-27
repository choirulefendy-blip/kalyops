// Kaly Ops — grafik laporan (HTML + SVG ringan, tanpa pustaka luar).
// Warna kategori diuji dengan validator dataviz (permukaan putih): urutan tetap, aman untuk buta warna
// pada pasangan bersebelahan. Hijau olive & oranye brand TIDAK pernah berdampingan (sulit dibedakan
// penderita buta warna merah-hijau); naik/turun memakai pasangan teal ↔ oranye.
import { esc } from './lib.js';

export const PAL = ['#6B8E23', '#0E8DA6', '#CC5E44', '#8E5BB5', '#D99A1E', '#3A6FC4', '#D06A9A'];
export const OTHER = '#A3A79A';
export const POS = '#0E8DA6', NEG = '#CC5E44', ONE = PAL[0];
export const SEQ = ['#ebf2dc', '#cad4b5', '#abb68f', '#8d996a', '#707c45', '#55611c', '#3c4600'];

// Warna mengikuti entitas (urutan master), bukan peringkat; lebih dari 7 → "Lainnya"
export function colorMap(ids) {
  const m = {};
  ids.forEach((id, i) => { m[id] = i < PAL.length ? PAL[i] : OTHER; });
  return m;
}

// ---------- Angka ringkas untuk sumbu ----------
const nf1 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 1 });
export function compact(v, rupiah = true) {
  const a = Math.abs(v), s = v < 0 ? '-' : '';
  const p = rupiah ? 'Rp' : '';
  if (a >= 1e9) return `${s}${p}${nf1.format(a / 1e9)} M`;
  if (a >= 1e6) return `${s}${p}${nf1.format(a / 1e6)} jt`;
  if (a >= 1e3) return `${s}${p}${nf1.format(a / 1e3)} rb`;
  return `${s}${p}${nf1.format(a)}`;
}
function ticks(min, max, n = 4) {
  if (max === min) { max = min + 1; }
  const span = max - min, raw = span / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => span / s <= n) || 10 * mag;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const vals = []; for (let v = lo; v <= hi + step / 2; v += step) vals.push(+v.toFixed(6));
  return { lo, hi, vals };
}

// ---------- Tooltip bersama (hover, ketuk, dan fokus keyboard) ----------
// data-tt = JSON {t: judul, r: [[warna, label, nilai]], n: catatan}; teks disisipkan dengan textContent.
export const tip = (o) => `data-tt="${esc(JSON.stringify(o))}" tabindex="0" aria-label="${esc([o.t, ...(o.r || []).map((x) => `${x[1]} ${x[2]}`), o.n || ''].filter(Boolean).join(', '))}"`;
let ttEl = null, ttFor = null;
function ttShow(el, x, y) {
  let d; try { d = JSON.parse(el.dataset.tt); } catch { return; }
  if (!ttEl) { ttEl = document.createElement('div'); ttEl.id = 'cx-tt'; ttEl.setAttribute('role', 'tooltip'); document.body.appendChild(ttEl); }
  ttEl.replaceChildren();
  if (d.t) { const h = document.createElement('div'); h.className = 'cx-tt-t'; h.textContent = d.t; ttEl.appendChild(h); }
  for (const [c, l, v] of d.r || []) {
    const row = document.createElement('div'); row.className = 'cx-tt-r';
    const k = document.createElement('i'); if (c) k.style.background = c; else k.className = 'none';
    const val = document.createElement('b'); val.textContent = v;
    const lab = document.createElement('span'); lab.textContent = l;
    row.append(k, val, lab); ttEl.appendChild(row);
  }
  if (d.n) { const n = document.createElement('div'); n.className = 'cx-tt-n'; n.textContent = d.n; ttEl.appendChild(n); }
  ttEl.style.display = 'block'; ttFor = el; el.classList.add('cx-on');
  ttMove(x, y, el);
}
function ttMove(x, y, el) {
  if (!ttEl) return;
  const w = ttEl.offsetWidth, h = ttEl.offsetHeight;
  if (x == null) { const r = el.getBoundingClientRect(); x = r.left + r.width / 2; y = r.top; }
  let L = x + 14, T = y - h - 12;
  if (L + w > innerWidth - 8) L = x - w - 14;
  if (L < 8) L = 8;
  if (T < 8) T = y + 18;
  ttEl.style.left = L + 'px'; ttEl.style.top = T + 'px';
}
function ttHide() { if (ttEl) ttEl.style.display = 'none'; ttFor?.classList.remove('cx-on'); ttFor = null; }
if (typeof document !== 'undefined' && !window.__cxTT) {
  window.__cxTT = true;
  document.addEventListener('pointerover', (e) => { const el = e.target.closest?.('[data-tt]'); if (el) ttShow(el, e.clientX, e.clientY); else if (ttFor) ttHide(); });
  document.addEventListener('pointermove', (e) => { if (ttFor && e.target.closest?.('[data-tt]') === ttFor) ttMove(e.clientX, e.clientY, ttFor); });
  document.addEventListener('pointerleave', ttHide);
  document.addEventListener('focusin', (e) => { const el = e.target.closest?.('[data-tt]'); if (el) ttShow(el); else ttHide(); });
  document.addEventListener('focusout', (e) => { if (e.target === ttFor) ttHide(); });
  document.addEventListener('scroll', ttHide, true);
  window.addEventListener('hashchange', ttHide);
}

// ---------- Legenda (kotak untuk batang, garis untuk garis) ----------
export function legend(items) {
  return `<div class="cx-leg">${items.map((x) => `<span><i class="${x.line ? 'ln' : 'sw'}" style="background:${x.color}"></i>${esc(x.label)}</span>`).join('')}</div>`;
}
const empty = (t) => `<div class="empty-chart">${esc(t || 'Belum ada data di periode ini')}</div>`;
const every = (n, max) => Math.max(1, Math.ceil(n / max));
function yAxis(tk, pos, fmt) {
  return `<div class="cx-grid">${tk.vals.map((v) => `<i class="${v === 0 ? 'z' : ''}" style="bottom:${pos(v)}%"><span>${esc(fmt(v))}</span></i>`).join('')}</div>`;
}

// ---------- Kolom (tunggal, bertumpuk, atau naik/turun di sekitar nol) ----------
// x: label sumbu X; series: [{id, label, color, values}]; tipTitle(i) → judul tooltip; act/actV: aksi klik per kolom
export function columns({ x, series, fmt, axisFmt, height = 200, tipTitle, tipNote, act, actV, sel = -1, maxLabels = 12, emptyText, legendOn } = {}) {
  if (!x?.length || !series?.length || series.every((s) => s.values.every((v) => !v))) return empty(emptyText);
  fmt ||= (v) => String(v); axisFmt ||= (v) => compact(v);
  const n = x.length;
  const up = x.map((_, i) => series.reduce((a, s) => a + Math.max(0, s.values[i] || 0), 0));
  const dn = x.map((_, i) => series.reduce((a, s) => a + Math.min(0, s.values[i] || 0), 0));
  const tk = ticks(Math.min(0, ...dn), Math.max(0, ...up));
  const R = tk.hi - tk.lo || 1, pos = (v) => ((v - tk.lo) / R) * 100, z = pos(0);
  const k = every(n, maxLabels);
  const cols = x.map((lab, i) => {
    const segs = (sign) => series.map((s) => ({ s, v: s.values[i] || 0 })).filter((q) => (sign > 0 ? q.v > 0 : q.v < 0));
    const stack = (sign) => {
      const ss = segs(sign); if (!ss.length) return '';
      const tot = Math.abs(sign > 0 ? up[i] : dn[i]);
      const h = (tot / R) * 100;
      const parts = (sign > 0 ? ss : ss).map((q) => `<i style="flex:${Math.abs(q.v)};background:${q.s.color}"></i>`).join('');
      return `<div class="cx-st ${sign > 0 ? 'up' : 'dn'}" style="${sign > 0 ? `bottom:${z}%` : `top:${100 - z}%`};height:${h}%">${parts}</div>`;
    };
    const t = { t: tipTitle ? tipTitle(i) : String(lab), r: series.filter((s) => s.values[i]).map((s) => [s.color, s.label, fmt(s.values[i])]) };
    if (!t.r.length) t.r = [[null, 'Tidak ada', fmt(0)]];
    if (tipNote) t.n = tipNote(i);
    const click = act ? ` data-a="${act}" data-v="${esc(actV ? actV(i) : i)}"` : '';
    return `<div class="cx-col${i === sel ? ' sel' : ''}${act ? ' clk' : ''}" ${tip(t)}${click}>${stack(1)}${stack(-1)}</div>`;
  }).join('');
  const xs = x.map((lab, i) => `<span class="${(i / k) % 2 === 1 ? 'alt' : ''}">${i % k === 0 ? esc(lab) : ''}</span>`).join('');
  const leg = (legendOn ?? series.length > 1) ? legend(series.map((s) => ({ label: s.label, color: s.color }))) : '';
  return `<div class="cx" style="--cx-h:${height}px">${leg}<div class="cx-plot">${yAxis(tk, pos, axisFmt)}<div class="cx-cols" style="--n:${n}">${cols}</div></div>
    <div class="cx-x" style="--n:${n}">${xs}</div></div>`;
}

// ---------- Garis (satu sumbu; hover menampilkan semua seri di titik X) ----------
export function lines({ x, series, fmt, axisFmt, height = 200, tipTitle, maxLabels = 10, area = false, emptyText, zero = true } = {}) {
  if (!x?.length || !series?.length || series.every((s) => s.values.every((v) => v == null || v === 0))) return empty(emptyText);
  fmt ||= (v) => String(v); axisFmt ||= (v) => compact(v);
  const n = x.length, all = series.flatMap((s) => s.values.filter((v) => v != null));
  const tk = ticks(zero ? Math.min(0, ...all) : Math.min(...all), Math.max(zero ? 0 : -Infinity, ...all));
  const R = tk.hi - tk.lo || 1, pos = (v) => ((v - tk.lo) / R) * 100;
  const X = (i) => (n === 1 ? 50 : (i / (n - 1)) * 100);
  const H = 100;
  const paths = series.map((s) => {
    const pts = s.values.map((v, i) => (v == null ? null : [X(i), H - pos(v)]));
    const d = pts.map((p, i) => (p ? `${i === 0 || !pts[i - 1] ? 'M' : 'L'}${p[0].toFixed(2)},${p[1].toFixed(2)}` : '')).join('');
    const a = area && series.length === 1 ? `<path d="${d}L${X(n - 1)},${H - pos(Math.max(tk.lo, 0))}L${X(0)},${H - pos(Math.max(tk.lo, 0))}Z" fill="${s.color}" opacity=".1"/>` : '';
    return `${a}<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
  }).join('');
  const dots = series.map((s) => s.values.map((v, i) => (v == null || (n > 16 && i !== n - 1) ? '' : `<i class="cx-dot" style="left:${X(i)}%;bottom:${pos(v)}%;background:${s.color}"></i>`)).join('')).join('');
  const hov = x.map((lab, i) => `<div ${tip({ t: tipTitle ? tipTitle(i) : String(lab), r: series.map((s) => [s.color, s.label, s.values[i] == null ? '–' : fmt(s.values[i])]) })}></div>`).join('');
  const k = every(n, maxLabels);
  const showX = (i) => i === n - 1 || (i % k === 0 && n - 1 - i >= Math.ceil(k * 0.7));
  const xs = x.map((lab, i) => `<span class="${i !== n - 1 && (i / k) % 2 === 1 ? 'alt' : ''}" style="left:${X(i)}%">${showX(i) ? esc(lab) : ''}</span>`).join('');
  const leg = series.length > 1 ? legend(series.map((s) => ({ label: s.label, color: s.color, line: true }))) : '';
  return `<div class="cx cx-line" style="--cx-h:${height}px">${leg}<div class="cx-plot">${yAxis(tk, pos, axisFmt)}
    <svg class="cx-svg" viewBox="0 0 100 ${H}" preserveAspectRatio="none" aria-hidden="true">${paths}</svg>${dots}<div class="cx-hov${n === 1 ? ' one' : ''}" style="grid-template-columns:${n <= 2 ? `repeat(${n},minmax(0,1fr))` : `.5fr repeat(${n - 2},minmax(0,1fr)) .5fr`}">${hov}</div></div>
    <div class="cx-xl">${xs}</div></div>`;
}

// ---------- Batang mendatar (peringkat / porsi) ----------
// rows: [{label, value, color?, note?}]; total → tampilkan persen
export function hbar(rows, { fmt, total, max, color = ONE, emptyText, act, actV } = {}) {
  const rs = rows.filter((r) => r.value);
  if (!rs.length) return empty(emptyText);
  fmt ||= (v) => String(v);
  const m = max || Math.max(...rs.map((r) => r.value), 1);
  return `<div class="cx-hb">${rs.map((r, i) => {
    const p = total ? ` · ${(100 * r.value / total).toLocaleString('id-ID', { maximumFractionDigits: 1 })}%` : '';
    const click = act ? ` data-a="${act}" data-v="${esc(actV ? actV(r, i) : i)}"` : '';
    return `<div class="cx-hbr${act ? ' clk' : ''}" ${tip({ t: r.label, r: [[r.color || color, r.tipLabel || 'Nilai', fmt(r.value) + p]], n: r.note })}${click}>
      <span class="cx-hbl">${r.color ? `<i style="background:${r.color}"></i>` : ''}${esc(r.label)}</span>
      <span class="cx-hbt"><i style="width:${Math.max(0.6, (r.value / m) * 100)}%;background:${r.color || color}"></i></span>
      <span class="cx-hbv">${esc(fmt(r.value))}${total ? `<small>${esc(p.replace(' · ', ''))}</small>` : ''}</span></div>`;
  }).join('')}</div>`;
}

// ---------- Peta panas (baris × kolom), satu warna terang → gelap ----------
// val(ri, ci) → angka; cell(v) → teks di sel; rowTotal/colTotal opsional
export function heat({ rows, cols, val, fmt, cell, title, rowTotal, colTotal, totalFmt, emptyText, maxLabels = 24 } = {}) {
  const M = rows.map((_, ri) => cols.map((_, ci) => val(ri, ci) || 0));
  const mx = Math.max(0, ...M.flat());
  if (!mx) return empty(emptyText);
  fmt ||= String; cell ||= (v) => compact(v, false); totalFmt ||= fmt;
  const bin = (v) => (v <= 0 ? -1 : Math.min(SEQ.length - 1, Math.floor((v / mx) * SEQ.length - 1e-9)));
  const k = every(cols.length, maxLabels);
  const head = `<tr><th></th>${cols.map((c, i) => `<th>${i % k === 0 ? esc(c) : ''}</th>`).join('')}${rowTotal ? '<th class="tot">Total</th>' : ''}</tr>`;
  const body = rows.map((r, ri) => `<tr><th>${r.color ? `<i class="cx-key" style="background:${r.color}"></i>` : ''}${esc(r.label)}</th>${cols.map((c, ci) => {
    const v = M[ri][ci], b = bin(v);
    return `<td class="${b < 0 ? 'nil' : b >= 4 ? 'dk' : ''}" style="${b >= 0 ? `background:${SEQ[b]}` : ''}" ${tip({ t: title ? title(ri, ci) : `${r.label} · ${c}`, r: [[b >= 0 ? SEQ[Math.max(b, 2)] : null, 'Nilai', fmt(v)]] })}>${v ? esc(cell(v)) : ''}</td>`;
  }).join('')}${rowTotal ? `<td class="tot">${esc(totalFmt(rowTotal(ri)))}</td>` : ''}</tr>`).join('');
  const foot = colTotal ? `<tr class="tot"><th>Total</th>${cols.map((_, ci) => `<td>${colTotal(ci) ? esc(cell(colTotal(ci))) : ''}</td>`).join('')}${rowTotal ? '<td></td>' : ''}</tr>` : '';
  const scale = `<div class="cx-scale"><span>0</span>${SEQ.map((c) => `<i style="background:${c}"></i>`).join('')}<span>${esc(fmt(mx))}</span></div>`;
  return `<div class="cx-heat-w"><table class="cx-heat"><thead>${head}</thead><tbody>${body}${foot}</tbody></table></div>${scale}`;
}

// ---------- Waterfall (laba rugi): total dari nol, pengurang mengambang ----------
// steps: [{label, value, kind:'total'|'minus'|'plus'}] — nilai minus ditulis positif
export function waterfall(steps, { fmt, axisFmt, height = 230 } = {}) {
  if (!steps.length || steps.every((s) => !s.value)) return empty();
  fmt ||= String; axisFmt ||= (v) => compact(v);
  let run = 0;
  // Pengurang bernilai negatif (mis. selisih persediaan positif) justru menambah
  steps = steps.map((s) => (s.kind === 'minus' && s.value < 0 ? { ...s, kind: 'plus', value: -s.value } : s.kind === 'plus' && s.value < 0 ? { ...s, kind: 'minus', value: -s.value } : s));
  const bars = steps.map((s) => {
    let a, b;
    if (s.kind === 'total') { a = 0; b = s.value; run = s.value; }
    else if (s.kind === 'minus') { a = run; b = run - s.value; run = b; }
    else { a = run; b = run + s.value; run = b; }
    return { ...s, a, b };
  });
  const tk = ticks(Math.min(0, ...bars.map((x) => Math.min(x.a, x.b))), Math.max(0, ...bars.map((x) => Math.max(x.a, x.b))));
  const R = tk.hi - tk.lo || 1, pos = (v) => ((v - tk.lo) / R) * 100;
  const n = bars.length;
  const cols = bars.map((x) => {
    const lo = Math.min(x.a, x.b), hi = Math.max(x.a, x.b);
    const neg = x.kind === 'minus' || (x.kind === 'total' && x.value < 0);
    const c = neg ? NEG : POS;
    const val = x.kind === 'minus' ? -x.value : x.value;
    return `<div class="cx-col wf" ${tip({ t: x.label, r: [[c, x.kind === 'total' ? 'Jumlah' : x.kind === 'minus' ? 'Mengurangi' : 'Menambah', fmt(val)]] })}>
      <div class="cx-st ${x.kind === 'total' ? 'tot' : 'flt'}${x.kind === 'total' && x.value < 0 ? ' dn' : ''}" style="bottom:${pos(lo)}%;height:${Math.max(0.4, pos(hi) - pos(lo))}%"><i style="background:${c}"></i></div>
      <span class="cx-wv" style="bottom:${pos(hi)}%">${esc(axisFmt(val))}</span></div>`;
  }).join('');
  return `<div class="cx" style="--cx-h:${height}px">${legend([{ label: 'Pendapatan & laba', color: POS }, { label: 'Pengurang (HPP, beban, rugi)', color: NEG }])}
    <div class="cx-plot">${yAxis(tk, pos, axisFmt)}<div class="cx-cols wfc" style="--n:${n}">${cols}</div></div>
    <div class="cx-x wf" style="--n:${n}">${bars.map((x) => `<span>${esc(x.label)}</span>`).join('')}</div></div>`;
}

// ---------- Batang 100% mendatar (komposisi, mis. neraca) ----------
// rows: [{label, total, segs: [{label, value, color}]}]
export function stack100(rows, { fmt } = {}) {
  fmt ||= String;
  const seen = new Map();
  const html = rows.map((r) => {
    const tot = r.segs.reduce((a, s) => a + Math.max(0, s.value), 0);
    if (!tot) return '';
    return `<div class="cx-s100"><div class="cx-s100-h"><b>${esc(r.label)}</b><span>${esc(fmt(r.total ?? tot))}</span></div>
      <div class="cx-s100-b">${r.segs.filter((s) => s.value > 0).map((s) => {
        seen.set(s.label, s.color);
        const p = (100 * s.value) / tot;
        const dark = s.color !== PAL[4] && s.color !== OTHER;
        return `<i style="flex:${s.value};background:${s.color}" ${tip({ t: r.label, r: [[s.color, s.label, `${fmt(s.value)} · ${p.toLocaleString('id-ID', { maximumFractionDigits: 1 })}%`]] })}>${p >= 14 ? `<em class="${dark ? '' : 'ink'}">${Math.round(p)}%</em>` : ''}</i>`;
      }).join('')}</div></div>`;
  }).join('');
  return html ? html + legend([...seen].map(([label, color]) => ({ label, color }))) : empty();
}
