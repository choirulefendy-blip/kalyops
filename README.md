# Kaly Ops

Sistem operasional terintegrasi **Kaly Eatery**: Kaly POS, Kaly Kitchen, Kaly Lounge, Kaly Core, Kaly Order, Kaly Loop, Kaly Book, Kaly Goods — dengan database Supabase.

| Untuk | Alamat |
|---|---|
| Staf operasional (kasir, dapur, gudang, service) — **Kaly Ops** | https://choirulefendy-blip.github.io/kalyops/ |
| Owner / Manajer — **Kaly Backoffice** | https://choirulefendy-blip.github.io/kalyops/backoffice/ |
| Pelanggan (pesan dari meja, reservasi, member) | tautan & QR dari Kaly Order / Kaly Book / Kaly Loop |

## Isi repository

| Folder | Isi |
|---|---|
| `app/` | Aplikasi web (HTML, CSS, JavaScript tanpa build). Inilah yang terbit di GitHub Pages. |
| `supabase/` | Paket database: `kaly-ops-supabase.sql` (semua dalam satu file), file 01–07, dan Edge Function `functions/kaly-push` untuk notifikasi di perangkat. Petunjuk lengkap di `supabase/README.md`. |
| `android/` | Kode sumber aplikasi Android Kaly Ops (tablet kasir & printer LAN/Bluetooth/USB). APK siap pasang ada di `app/android/kaly-ops.apk`. Keystore penandatangan **tidak** disimpan di sini. |
| `.github/workflows/pages.yml` | Menerbitkan `app/` ke GitHub Pages otomatis setiap ada perubahan di branch `main`. |

## Memasang (sekali saja)

1. **Database** — Supabase › SQL Editor: jalankan `supabase/kaly-ops-supabase.sql`. Lihat `supabase/README.md`.
2. **Sambungan** — `app/js/config.js` berisi Project URL dan **anon / publishable key** Supabase. Jangan pernah memasang service_role / secret key (workflow menolak menerbitkan bila ada).
3. **GitHub Pages** — Settings › Pages › Build and deployment › Source: **GitHub Actions**. Setelah itu setiap perubahan di `app/` terbit dalam 1–2 menit (tab **Actions**).
4. **Notifikasi saat aplikasi ditutup (opsional)** — pasang Edge Function `kaly-push` (lihat `supabase/README.md`), lalu Kaly Backoffice › Pengaturan › Notifikasi di perangkat › Sambungkan.

## Memperbarui

- Ubah file di `app/` (atau dorong dari Claude) → terbit otomatis. Perangkat yang sedang terbuka menampilkan *Versi baru tersedia* → **Muat ulang**.
- Bila ada SQL baru, jalankan `supabase/kaly-ops-supabase.sql` lebih dulu (aman dijalankan ulang).

## Catatan pindah dari Netlify

- Aplikasi Android 1.3 otomatis memakai alamat GitHub Pages.
- QR meja yang dicetak dengan alamat `kaly-ops.netlify.app` perlu dicetak ulang dari Kaly Order.
- Notifikasi di perangkat (Web Push) terikat ke alamat situs: setiap HP perlu menekan **Aktifkan notifikasi di perangkat ini** lagi di alamat baru.
