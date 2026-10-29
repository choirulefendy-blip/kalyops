// 2.9 · Anggota shift: satu akun login per peran/perangkat, nama petugas dipilih di sini.
// Kasir: nama petugas tersimpan di shift (bisa diganti selama shift berjalan, tercatat).
// Service & dapur: nama petugas tersimpan di perangkat ini.
// Menambah / mengubah anggota shift hanya di Kaly Backoffice (Pengaturan › Anggota shift).
import { getDb, currentUser, getTerminal } from './store.js';
import { getOutlet } from './app.js';
import * as D from './domain.js';
import * as API from './api.js';
import * as C from './cloud.js';
import { esc, ic, toast, openModal, fmtTime } from './lib.js';

const KEY = (role) => `kaly.crew.${role}`;
export const ROLE_OF = { kasir: 'kasir', service: 'service', dapur: 'dapur' };
export const CREW_LABEL = { kasir: 'Kasir', service: 'Service', dapur: 'Kitchen / Bar' };

export function deviceCrew(role) {
  let id = null;
  try { id = localStorage.getItem(KEY(role)); } catch {}
  const c = id && (getDb().crew || []).find((x) => x.id === id && x.active);
  return c || null;
}
export function setDeviceCrew(role, id) { try { id ? localStorage.setItem(KEY(role), id) : localStorage.removeItem(KEY(role)); } catch {} if (role !== 'kasir') C.auditSession((getDb().crew || []).find((c) => c.id === id)?.name || ''); }

// Nama yang tampil di kanan atas
export function currentCrewName() {
  const u = currentUser(); if (!u || !ROLE_OF[u.role]) return '';
  if (u.role === 'kasir') { const sh = D.activeShift(getDb(), getTerminal()); return sh?.crewName || ''; }
  return deviceCrew(u.role)?.name || '';
}

export function chipHtml() {
  const u = currentUser();
  if (!u || !ROLE_OF[u.role]) return '';
  return `<button class="crew-chip" id="crew" data-a="crewPick" hidden></button>`;
}
export function paintChip() {
  const el = document.getElementById('crew'); if (!el) return;
  const u = currentUser(), db = getDb();
  const list = D.crewFor(db, u.role, getOutlet());
  const name = currentCrewName();
  const shiftless = u.role === 'kasir' && !D.activeShift(db, getTerminal());
  // Di Kaly POS nama petugas kasir sudah tampil di baris navigasi kasir
  el.hidden = (!list.length && !name) || (u.role === 'kasir' && location.hash.startsWith('#/pos'));
  if (el.hidden) return;
  el.classList.toggle('none', !name);
  el.title = u.role === 'kasir' ? (shiftless ? 'Belum ada shift aktif di terminal ini' : 'Petugas shift ini · ketuk untuk mengganti nama') : 'Petugas di perangkat ini · ketuk untuk mengganti';
  el.innerHTML = `${ic('user', 16)}<span>${name ? esc(name) : shiftless ? 'Belum buka shift' : 'Pilih nama petugas'}</span>`;
}

// Daftar nama untuk dipilih (dipakai juga saat buka shift)
export function crewOptionsHtml(list, selId, name = 'crew') {
  return `<div class="crew-pick" role="radiogroup">${list.map((c) => `<label class="crew-opt"><input type="radio" name="${name}" value="${c.id}" ${c.id === selId ? 'checked' : ''}><span>${ic('user', 18)}<b>${esc(c.name)}</b></span></label>`).join('')}</div>`;
}

export function pickDialog({ onDone } = {}) {
  const u = currentUser(), db = getDb(), L = getOutlet();
  const list = D.crewFor(db, u.role, L);
  if (u.role === 'kasir') {
    const sh = D.activeShift(db, getTerminal());
    if (!sh) { location.hash = '#/pos?tab=shift'; return toast('Buka shift dulu. Nama petugas dipilih saat buka shift.', 'info'); }
    if (sh.user !== u.id) return toast(`Shift di ${getTerminal()} dibuka akun lain`, 'warn');
    if (!list.length) return toast('Belum ada anggota shift kasir. Owner menambahkannya di Kaly Backoffice.', 'warn', 5000);
    return openModal({
      title: 'Ganti petugas shift', size: 'sm',
      body: `<p class="muted sm">Shift ${esc(sh.term)} sejak ${fmtTime(sh.openAt)}. Login tetap memakai akun kasir yang sama; laporan shift tercatat atas nama petugas yang dipilih. Pergantian nama tercatat di laporan Manajer.</p>${crewOptionsHtml(list, sh.crew)}
        <p class="hint">Serah terima kas antar petugas sebaiknya lewat <b>Tutup shift</b> lalu <b>Buka shift</b> supaya hitungan kas terpisah.</p>`,
      footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Simpan</button>`,
      onMount(m, api) {
        m.querySelector('[data-ok]').onclick = async () => {
          const v = m.querySelector('input[name=crew]:checked')?.value;
          if (!v) return toast('Pilih nama petugas', 'warn');
          try { const n = await API.shiftCrew(sh.id, v); await C.refresh('shifts'); api.close(); toast(`Petugas shift: ${n}`); onDone?.(); } catch (e) { toast(e.message, 'err', 5000); }
        };
      },
    });
  }
  if (!list.length) return toast(`Belum ada anggota shift ${CREW_LABEL[u.role]}. Owner menambahkannya di Kaly Backoffice.`, 'warn', 5000);
  const cur = deviceCrew(u.role);
  openModal({
    title: 'Siapa yang bertugas?', size: 'sm',
    body: `<p class="muted sm">Nama petugas ${esc(CREW_LABEL[u.role])} di perangkat ini. Login tetap memakai akun yang sama.</p>${crewOptionsHtml(list, cur?.id)}`,
    footer: `<button class="btn" data-close>Batal</button><button class="btn btn-pri" data-ok>Simpan</button>`,
    onMount(m, api) {
      m.querySelector('[data-ok]').onclick = () => {
        const v = m.querySelector('input[name=crew]:checked')?.value;
        if (!v) return toast('Pilih nama petugas', 'warn');
        setDeviceCrew(u.role, v); api.close(); toast(`Petugas: ${list.find((c) => c.id === v)?.name}`); onDone?.();
      };
    },
  });
}
