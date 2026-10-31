// Kaly Ops di Next.js: halaman aplikasi (public/, disalin dari ../app saat build) + API di /api/* (Vercel Functions).
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: process.env.KALY_STANDALONE ? 'standalone' : undefined,   // Docker
  async rewrites() {
    // 2.13: database Supabase lewat alamat ini sendiri (/sb/...), jadi perangkat cukup bisa membuka kalyops.vercel.app
    // (beberapa jaringan seluler tidak bisa membuka *.supabase.co langsung)
    const sb = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim().replace(/\/+$/, '');
    return {
      beforeFiles: [
        ...(/^https?:\/\//.test(sb) ? [{ source: '/sb/:path*', destination: `${sb}/:path*` }] : []),
        { source: '/', destination: '/index.html' },
        { source: '/backoffice', destination: '/backoffice/index.html' },
        { source: '/backoffice/', destination: '/backoffice/index.html' },
      ],
    };
  },
  async headers() {
    const noStore = [{ key: 'Cache-Control', value: 'no-store, max-age=0' }];
    return [
      // Selalu ambil versi terbaru: halaman, konfigurasi lingkungan, nomor build, service worker
      { source: '/', headers: noStore },
      { source: '/index.html', headers: noStore },
      { source: '/version.json', headers: noStore },
      { source: '/js/config.js', headers: noStore },
      { source: '/sw.js', headers: [...noStore, { key: 'Service-Worker-Allowed', value: '/' }] },
      { source: '/(.*)', headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
      ] },
    ];
  },
};
export default nextConfig;
