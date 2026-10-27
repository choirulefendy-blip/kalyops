// Edge Function kaly-push · Kaly Ops 2.5
// Mengirim notifikasi staf (laporan shift, keuangan, fraud, bahan, pesanan, dll.) ke HP/laptop yang
// mengaktifkan "Notifikasi di perangkat ini", juga saat Kaly Ops sedang tertutup (Web Push standar, tanpa Firebase).
//
//   GET  → { publicKey }   kunci publik VAPID untuk langganan di browser (dibuat otomatis sekali, disimpan di database)
//   POST { id }            dipanggil database (pg_net) setiap ada notifikasi staf baru; perangkat tujuan & isi
//                          diambil sendiri dari database, jadi permintaan palsu tidak bisa mengirim pesan buatan.
//
// Pasang: Supabase › Edge Functions › Deploy new function › nama "kaly-push" › tempel file ini › Deploy,
// lalu matikan "Verify JWT" (Enforce JWT verification) di pengaturan fungsi. Tidak perlu kunci tambahan:
// SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY sudah tersedia otomatis di Edge Function.
// Opsional: secret VAPID_SUBJECT = mailto:email-anda (kontak untuk layanan push).
// Opsional: secret KALY_SERVICE_KEY bila project memakai kunci rahasia baru (sb_secret_…) dan kunci service_role lama dimatikan.

const SB_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SB_KEY = Deno.env.get('KALY_SERVICE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@kaly.id';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const enc = new TextEncoder();
type Bytes = ReturnType<typeof enc.encode>;   // Uint8Array yang diterima Web Crypto (cocok untuk TypeScript lama & baru)

// ---------- bantu ----------
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
function b64u(b: Bytes): string { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64u(s: string): Bytes { s = s.replace(/-/g, '+').replace(/_/g, '/'); s += '='.repeat((4 - (s.length % 4)) % 4); const o = new Uint8Array(new ArrayBuffer(atob(s).length)) as Bytes; const t = atob(s); for (let i = 0; i < t.length; i++) o[i] = t.charCodeAt(i); return o; }
function concat(...a: Bytes[]): Bytes { const o = new Uint8Array(new ArrayBuffer(a.reduce((n, x) => n + x.length, 0))) as Bytes; let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; }

async function rpc(fn: string, args: Record<string, unknown>) {
  if (!SB_URL || !SB_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY tidak tersedia di Edge Function');
  // Kunci JWT lama dikirim juga sebagai Bearer; kunci rahasia baru (sb_secret_…) cukup lewat apikey
  const auth: Record<string, string> = SB_KEY.startsWith('eyJ') ? { Authorization: `Bearer ${SB_KEY}` } : {};
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: SB_KEY, ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${t}`);
  return t ? JSON.parse(t) : null;
}

// ---------- Kunci VAPID (RFC 8292) ----------
let keys: { pub: string; priv: CryptoKey } | null = null;
async function vapid() {
  if (keys) return keys;
  let v = await rpc('push_vapid', {});
  if (!v?.public) {
    const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const pub = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey) as ArrayBuffer) as Bytes);
    await rpc('push_vapid_save', { p_public: pub, p_private: await crypto.subtle.exportKey('jwk', k.privateKey) });
    v = await rpc('push_vapid', {});          // bila dua permintaan bersamaan, pakai yang tersimpan lebih dulu
  }
  const priv = await crypto.subtle.importKey('jwk', v.private, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  keys = { pub: v.public, priv };
  return keys;
}
async function vapidHeader(endpoint: string) {
  const k = await vapid();
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.priv, enc.encode(`${head}.${body}`))) as Bytes;
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${k.pub}`;
}

// ---------- Enkripsi isi pesan (RFC 8291, aes128gcm) ----------
async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, len: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8)) as Bytes;
}
async function encrypt(p256dh: string, auth: string, plain: Bytes): Promise<Bytes> {
  const ua = unb64u(p256dh), secret = unb64u(auth);
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey) as ArrayBuffer) as Bytes;
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256)) as Bytes;
  const ikm = await hkdf(secret, shared, concat(enc.encode('WebPush: info\0'), ua, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16))) as Bytes;
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plain, Uint8Array.of(2) as Bytes))) as Bytes;
  const head = new Uint8Array(new ArrayBuffer(21 + asPub.length)) as Bytes;
  head.set(salt, 0); new DataView(head.buffer).setUint32(16, 4096); head[20] = asPub.length; head.set(asPub, 21);
  return concat(head, ct);
}

// ---------- Isi notifikasi ----------
type Alert = { id: number; kind: string; title: string; detail: string; location_id: string | null; table_id: string | null };
function link(a: Alert) {
  const t = a.table_id ? `?t=${encodeURIComponent(a.table_id)}` : '';
  const m: Record<string, string> = {
    qr_new: `#/denah${t}`, qr_add: `#/denah${t}`, table_paid: `#/denah${t}`, table_move: `#/denah${t}`, web_new: '#/order-admin', res_new: '#/book-admin',
    po_wait: '#/goods', po_done: '#/goods', po_paid: '#/core?tab=keuangan', po_recv: '#/core?tab=stok', tf_in: '#/core?tab=mutasi', stock_low: '#/core?tab=stok',
    opname: '#/core?tab=opname', fraud: '#/core?tab=fraud', shift_open: '#/core?tab=keuangan', shift_close: '#/core?tab=keuangan', day_close: '#/core?tab=keuangan',
    k_new: '#/kitchen', k_add: '#/kitchen', k_void: '#/kitchen', k_move: '#/kitchen',   // 2.5: layar dapur
  };
  return m[a.kind] || '#/';
}
const URGENT = new Set(['fraud', 'qr_new', 'qr_add', 'web_new', 'push_test', 'k_new', 'k_add', 'k_void']);

async function deliver(id: number) {
  const data = await rpc('push_targets', { p_alert: id });
  if (!data) return { skipped: true };
  const a: Alert = data.alert;
  const msg = enc.encode(JSON.stringify({ id: a.id, kind: a.kind, title: a.title, body: a.detail || '', url: link(a), tag: `kaly-a${a.id}` }));
  const ok: number[] = [], gone: number[] = [];
  let failed = 0;
  await Promise.all((data.targets as { id: number; endpoint: string; p256dh: string; auth: string }[]).map(async (s) => {
    try {
      const r = await fetch(s.endpoint, {
        method: 'POST',
        headers: { Authorization: await vapidHeader(s.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: URGENT.has(a.kind) ? 'high' : 'normal' },
        body: await encrypt(s.p256dh, s.auth, msg),
      });
      await r.body?.cancel();
      if (r.status >= 200 && r.status < 300) ok.push(s.id);
      else if (r.status === 404 || r.status === 410) gone.push(s.id);    // langganan sudah dicabut di perangkat
      else { failed++; console.error(`push ${s.id}: layanan push menjawab ${r.status}`); }
    } catch (e) { failed++; console.error(`push ${s.id}: ${String((e as Error)?.message || e)}`); }
  }));
  await rpc('push_result', { p_alert: id, p_ok: ok, p_gone: gone, p_failed: failed });
  return { sent: ok.length, gone: gone.length, failed };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  try {
    if (req.method === 'GET') return json({ publicKey: (await vapid()).pub, app: 'kaly-push', version: '2.5' });
    if (req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      const id = Number(b?.id ?? b?.record?.id);       // juga menerima format Database Webhook Supabase
      if (!Number.isInteger(id) || id <= 0) return json({ error: 'id notifikasi tidak valid' }, 400);
      return json(await deliver(id));
    }
    return json({ error: 'metode tidak didukung' }, 405);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
