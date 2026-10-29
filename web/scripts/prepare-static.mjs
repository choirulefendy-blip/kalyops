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

rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true, dereference: true, filter: (p) => !/[\\/]js[\\/]config\.js(\.[a-z]+)?$/.test(p) && !/[\\/](node_modules|\.git)([\\/]|$)/.test(p) });
writeFileSync(resolve(out, 'js/config.js'), `// Dibuat otomatis saat build (${env}). Jangan diubah manual.
export const SUPABASE_URL = ${JSON.stringify(url)};
export const SUPABASE_ANON_KEY = ${JSON.stringify(anon)};
export const KALY_ENV = ${JSON.stringify(env)};
export const API_BASE = '/api';
`);
const sha = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7);
let ver = '';
try { ver = JSON.parse(readFileSync(resolve(src, 'version.json'), 'utf8')).build || ''; } catch {}
writeFileSync(resolve(out, 'version.json'), JSON.stringify({ build: `${ver || 'kaly'}${sha ? '-' + sha : '-' + Date.now()}`, env }));
console.log(`Kaly Ops siap: ${env} → ${url.replace(/^https?:\/\//, '')}`);
