// Web Push untuk notifikasi staf Kaly Ops (port dari Supabase Edge Function kaly-push ke Vercel Function).
// Database (pg_net) memanggil POST /api/push { id } setiap ada notifikasi staf baru, dengan header x-kaly-secret.
// Perangkat tujuan & isi pesan diambil sendiri dari database lewat fungsi push_api (dijaga rahasia yang sama),
// jadi permintaan palsu tidak bisa mengirim pesan buatan. Tanpa kunci service_role.
const enc = new TextEncoder();
const subtle = globalThis.crypto.subtle;

export const env = () => ({
  url: (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim().replace(/\/+$/, ''),
  anon: (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim(),
  secret: (process.env.KALY_PUSH_SECRET || '').trim(),
  subject: process.env.VAPID_SUBJECT || 'mailto:admin@kaly.id',
});

function b64u(b) { return Buffer.from(b).toString('base64url'); }
function unb64u(s) { return new Uint8Array(Buffer.from(s, 'base64url')); }
function concat(...a) { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; }

export async function pushApi(op, args = {}) {
  const E = env();
  if (!E.url || !E.anon) throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY belum diisi di Vercel');
  if (!E.secret) throw new Error('KALY_PUSH_SECRET belum diisi di Vercel');
  const r = await fetch(`${E.url}/rest/v1/rpc/push_api`, {
    method: 'POST', cache: 'no-store',
    headers: { apikey: E.anon, ...(E.anon.startsWith('eyJ') ? { Authorization: `Bearer ${E.anon}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_secret: E.secret, p_op: op, p_args: args }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`push_api ${op}: ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}

// ---------- Kunci VAPID (RFC 8292), dibuat sekali & disimpan di database ----------
let keys = null;
export async function vapid() {
  if (keys) return keys;
  let v = await pushApi('vapid');
  if (!v?.public) {
    const k = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const pub = b64u(new Uint8Array(await subtle.exportKey('raw', k.publicKey)));
    await pushApi('vapid_save', { public: pub, private: await subtle.exportKey('jwk', k.privateKey) });
    v = await pushApi('vapid');   // bila dua permintaan bersamaan, pakai yang tersimpan lebih dulu
  }
  const priv = await subtle.importKey('jwk', v.private, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  keys = { pub: v.public, priv };
  return keys;
}
async function vapidHeader(endpoint) {
  const k = await vapid();
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env().subject })));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.priv, enc.encode(`${head}.${body}`)));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${k.pub}`;
}

// ---------- Enkripsi isi pesan (RFC 8291, aes128gcm) ----------
async function hkdf(salt, ikm, info, len) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}
export async function encrypt(p256dh, auth, plain) {
  const ua = unb64u(p256dh), secret = unb64u(auth);
  const uaKey = await subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const as = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await subtle.exportKey('raw', as.publicKey));
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(secret, shared, concat(enc.encode('WebPush: info\0'), ua, asPub), 32);
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plain, Uint8Array.of(2))));
  const head = new Uint8Array(21 + asPub.length);
  head.set(salt, 0); new DataView(head.buffer).setUint32(16, 4096); head[20] = asPub.length; head.set(asPub, 21);
  return concat(head, ct);
}

// ---------- Isi notifikasi ----------
export function link(a) {
  const t = a.table_id ? `?t=${encodeURIComponent(a.table_id)}` : '';
  const m = {
    qr_new: `#/denah${t}`, qr_add: `#/denah${t}`, table_paid: `#/denah${t}`, table_move: `#/denah${t}`, web_new: '#/order-admin', res_new: '#/book-admin',
    po_wait: '#/goods', po_done: '#/goods', po_paid: '#/core?tab=keuangan', po_recv: '#/core?tab=stok', tf_in: '#/core?tab=mutasi', stock_low: '#/core?tab=stok',
    opname: '#/core?tab=opname', fraud: '#/core?tab=fraud', shift_open: '#/core?tab=keuangan', shift_close: '#/core?tab=keuangan', day_close: '#/core?tab=keuangan',
    k_new: '#/kitchen', k_add: '#/kitchen', k_void: '#/kitchen', k_move: '#/kitchen',
    res_seat: a.table_id ? `#/pos?seat=${encodeURIComponent(a.table_id)}` : '#/pos',
  };
  return m[a.kind] || '#/';
}
const URGENT = new Set(['fraud', 'qr_new', 'qr_add', 'web_new', 'push_test', 'k_new', 'k_add', 'k_void', 'res_seat']);

export async function deliver(id) {
  const data = await pushApi('targets', { alert: id });
  if (!data) return { skipped: true };
  const a = data.alert;
  const msg = enc.encode(JSON.stringify({ id: a.id, kind: a.kind, title: a.title, body: a.detail || '', url: link(a), tag: `kaly-a${a.id}` }));
  const ok = [], gone = [];
  let failed = 0;
  await Promise.all((data.targets || []).map(async (s) => {
    try {
      const r = await fetch(s.endpoint, {
        method: 'POST',
        headers: { Authorization: await vapidHeader(s.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: URGENT.has(a.kind) ? 'high' : 'normal' },
        body: await encrypt(s.p256dh, s.auth, msg),
      });
      await r.arrayBuffer().catch(() => {});
      if (r.status >= 200 && r.status < 300) ok.push(s.id);
      else if (r.status === 404 || r.status === 410) gone.push(s.id);   // langganan sudah dicabut di perangkat
      else { failed++; console.error(`push ${s.id}: layanan push menjawab ${r.status}`); }
    } catch (e) { failed++; console.error(`push ${s.id}: ${e?.message || e}`); }
  }));
  await pushApi('result', { alert: id, ok, gone, failed });
  return { sent: ok.length, gone: gone.length, failed };
}

// Pembanding rahasia dengan waktu tetap
export function sameSecret(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  if (!x.length || x.length !== y.length) return false;
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
