// Salin aplikasi Kaly Ops (../app) ke public/ dan tulis js/config.js dari variabel lingkungan Vercel.
// Staging (Preview) dan Production memakai database Supabase yang berbeda lewat env masing-masing.
import { cpSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../../app');
const out = resolve(here, '../public');
if (!existsSync(resolve(src, 'index.html'))) { console.error('Folder app/ (aplikasi Kaly Ops) tidak ditemukan di ' + src); process.exit(1); }

const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim().replace(/\/+$/, '');
const anon = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim();
const env = process.env.KALY_ENV || (process.env.VERCEL_ENV === 'production' ? 'production' : process.env.VERCEL_ENV ? 'staging' : 'local');
if (!/^https?:\/\//.test(url) || anon.length < 20) { console.error('Isi NEXT_PUBLIC_SUPABASE_URL dan NEXT_PUBLIC_SUPABASE_ANON_KEY (anon / publishable key, BUKAN service_role).'); process.exit(1); }
// Penjaga: kunci rahasia tidak boleh ikut ke browser
const role = (() => { try { return JSON.parse(Buffer.from(anon.split('.')[1], 'base64url').toString()).role; } catch { return anon.startsWith('sb_publishable_') ? 'anon' : ''; } })();
if (anon.startsWith('sb_secret_') || role === 'service_role') { console.error('DITOLAK: NEXT_PUBLIC_SUPABASE_ANON_KEY berisi kunci rahasia. Pakai anon / publishable key.'); process.exit(1); }

// KALY_APP=backoffice untuk project Vercel Kaly Backoffice; selain itu Kaly Ops
const mode = (process.env.KALY_APP || 'ops').trim() === 'backoffice' ? 'backoffice' : 'ops';
const opsUrl = (process.env.KALY_OPS_URL || 'https://kalyops.vercel.app').trim().replace(/\/+$/, '');
const boUrl = (process.env.KALY_BO_URL || 'https://kalybackoffice.vercel.app').trim().replace(/\/+$/, '');
rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true, dereference: true, filter: (p) => !/[\\/]js[\\/]config\.js(\.[a-z]+)?$/.test(p) && !/[\\/](node_modules|\.git)([\\/]|$)/.test(p) });
writeFileSync(resolve(out, 'js/config.js'), `// Dibuat otomatis saat build (${env}). Jangan diubah manual.
// Di browser: lewat proksi /sb di alamat ini (lihat next.config.mjs); langsung ke Supabase hanya bila dibuka di luar http(s)
export const SUPABASE_DIRECT = ${JSON.stringify(url)};
export const SUPABASE_URL = (typeof location !== 'undefined' && /^https?:$/.test(location.protocol) && !${JSON.stringify(process.env.KALY_NO_PROXY ? '1' : '')}) ? location.origin + '/sb' : SUPABASE_DIRECT;
export const SUPABASE_ANON_KEY = ${JSON.stringify(anon)};
export const KALY_ENV = ${JSON.stringify(env)};
export const API_BASE = '/api';
// 2.16: Kaly Ops (kasir, dapur, service, gudang) dan Kaly Backoffice (Owner/Manajer) di alamat terpisah
export const APP_MODE = ${JSON.stringify(mode)};
export const OPS_URL = ${JSON.stringify(opsUrl)};
export const BO_URL = ${JSON.stringify(boUrl)};
export const PUSH_URL = ${JSON.stringify(mode === 'backoffice' ? opsUrl + '/api/push' : '')};
`);
if (mode === 'backoffice') {
  // Nama, ikon, dan warna sendiri supaya Kaly Backoffice terpisah dari Kaly Ops di layar HP/laptop
  writeFileSync(resolve(out, 'manifest.webmanifest'), JSON.stringify({
    name: 'Kaly Backoffice — Kaly Eatery', short_name: 'Kaly Backoffice', start_url: './', display: 'standalone', background_color: '#2A3220', theme_color: '#2A3220',
    icons: [{ src: 'assets/bo-icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'assets/bo-icon-512.png', sizes: '512x512', type: 'image/png' }],
  }, null, 2));
  const ix = resolve(out, 'index.html');
  writeFileSync(ix, readFileSync(ix, 'utf8').replace('<title>Kaly Ops</title>', '<title>Kaly Backoffice</title>').replace(/assets\/icon-192\.png/g, 'assets/bo-icon-192.png'));
}
const sha = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7);
let ver = '';
try { ver = JSON.parse(readFileSync(resolve(src, 'version.json'), 'utf8')).build || ''; } catch {}
writeFileSync(resolve(out, 'version.json'), JSON.stringify({ build: `${ver || 'kaly'}${sha ? '-' + sha : '-' + Date.now()}`, env }));
console.log(`${mode === 'backoffice' ? 'Kaly Backoffice' : 'Kaly Ops'} siap: ${env} → ${url.replace(/^https?:\/\//, '')}`);
