// Kaly Ops di Next.js: halaman aplikasi (public/, disalin dari ../app saat build) + API di /api/* (Vercel Functions).
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: process.env.KALY_STANDALONE ? 'standalone' : undefined,   // Docker
  async rewrites() {
    return {
      beforeFiles: [
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
