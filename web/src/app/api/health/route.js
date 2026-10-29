// GET /api/health — cek lingkungan (staging/production), database, dan server notifikasi
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const anon = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim();
  const out = { app: 'kaly-ops', env: process.env.VERCEL_ENV || 'local', commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7), db: url.replace(/^https?:\/\//, '').split('.')[0], dbOk: false, pushSecret: !!process.env.KALY_PUSH_SECRET };
  try {
    const t0 = Date.now();
    const r = await fetch(`${url}/rest/v1/rpc/sync_poll`, { method: 'POST', cache: 'no-store', headers: { apikey: anon, ...(anon.startsWith('eyJ') ? { Authorization: `Bearer ${anon}` } : {}), 'Content-Type': 'application/json' }, body: '{}' });
    out.dbOk = r.status < 500; out.dbStatus = r.status; out.dbMs = Date.now() - t0;
  } catch (e) { out.dbError = String(e?.message || e); }
  return Response.json(out, { status: out.dbOk ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
}
