// POST /api/push { id }  — dipanggil database (pg_net) dengan header x-kaly-secret saat ada notifikasi staf baru
// GET  /api/push         — kunci publik VAPID untuk langganan di browser (dipakai tombol "Sambungkan" di Pengaturan)
import { deliver, vapid, env, sameSecret } from '../../../lib/push.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, x-kaly-secret', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const json = (o, status = 200) => Response.json(o, { status, headers: { ...CORS, 'Cache-Control': 'no-store' } });

export function OPTIONS() { return new Response(null, { status: 204, headers: CORS }); }

export async function GET() {
  try { return json({ publicKey: (await vapid()).pub, app: 'kaly-push', host: 'vercel', version: '2.12' }); }
  catch (e) { return json({ error: String(e?.message || e) }, 500); }
}

export async function POST(req) {
  if (!sameSecret(req.headers.get('x-kaly-secret'), env().secret)) return json({ error: 'ditolak' }, 401);
  try {
    const b = await req.json().catch(() => ({}));
    const id = Number(b?.id ?? b?.record?.id);
    if (!Number.isInteger(id) || id <= 0) return json({ error: 'id notifikasi tidak valid' }, 400);
    return json(await deliver(id));
  } catch (e) { return json({ error: String(e?.message || e) }, 500); }
}
