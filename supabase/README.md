# Kaly Ops 2.8 · Database Supabase & Pemasangan

Kaly Ops 2.8 sudah tersambung penuh ke Supabase. Semua kasir, dapur, layar antrean, tablet service, dan HP pelanggan memakai satu database yang sama dan tersinkron otomatis dalam hitungan detik. Tidak ada lagi akun demo atau data contoh transaksi: login memakai email dan kata sandi masing-masing staf.

Pemasangan cukup sekali, kira-kira 20 menit:

1. Pasang database di project Supabase Anda (paket ini).
2. Buat akun Owner.
3. Isi `app/js/config.js`, lalu terbitkan lewat GitHub Pages (repository `choirulefendy-blip/kalyops`).
4. Owner masuk, menambahkan staf, dan menyiapkan outlet.

## Isi paket

| File | Isi |
|---|---|
| `kaly-ops-supabase.sql` | **Semua dalam satu file** (gabungan 01 sampai 06). Cara paling mudah. |
| `01_schema.sql` | 57 tabel: pengaturan, outlet, staf, meja, bahan, resep, menu, stok, pesanan, pembayaran, member, promo, voucher, deposit, supplier, PO, mutasi, opname, B2B, jurnal, temuan fraud, log sinkron, notifikasi staf, riwayat meja, printer & antrean cetak, perangkat penerima notifikasi. |
| `02_engine.sql` | Mesin bisnis (skema `engine`, tidak terbuka ke internet): HPP rata-rata, potong stok + produksi otomatis bahan setengah jadi, hitung tagihan, poin & misi member, jurnal otomatis. |
| `03_rpc.sql` | Fungsi yang dipanggil aplikasi: kirim ke dapur, bayar, split/gabung bill, void, shift, layar dapur, deposit, produksi, mutasi, opname, PO, menu & resep, halaman pesan online, reservasi, kartu member. |
| `04_security.sql` | Hak akses per peran (RLS), penjaga data, sambungan akun login ke staf, fungsi pembuat Owner, sinkron realtime, bucket foto menu. |
| `05_reports.sql` | Laporan: neraca saldo, laba rugi bulanan, penjualan harian, pembayaran, menu terlaris, nilai stok, HPP menu, waktu dapur, jurnal harian, serta fungsi laporan operasional 1.4 (nota & jam, kategori & jam, aktivitas meja). |
| `06_seed_master.sql` | Data master: 2 entitas, 3 lokasi, bagan akun, 42 meja, 84 bahan & resep, 75 menu Grand Opening, tier member, stok awal + jurnal saldo awal persediaan. **Tanpa akun staf contoh**, transaksi, member, supplier, dan promo. |
| `07_kosongkan_transaksi.sql` | Opsional. Menghapus semua transaksi uji coba sebelum operasional sungguhan. |
| `functions/kaly-push/index.ts` | Edge Function **kaly-push** (2.4): mengirim notifikasi ke HP/laptop staf saat Kaly Ops ditutup (Web Push standar, tanpa Firebase). Opsional, dipasang sekali lewat dashboard Supabase. |

Semua file aman dijalankan ulang. Data master yang sudah ada dan sudah Anda ubah tidak ditimpa.

## Langkah 1 · Pasang database

Masuk ke supabase.com dengan akun (email) yang memiliki project Kaly Ops. Kalau belum ada project: **New project**, isi nama `kaly-ops`, buat Database Password yang kuat dan simpan, pilih region **Southeast Asia (Singapore)**.

1. Buka **SQL Editor → New query**.
2. Buka `kaly-ops-supabase.sql` dengan Notepad, tekan Ctrl+A lalu Ctrl+C, tempel di SQL Editor, lalu klik **Run**.
3. Hasil yang benar: `Success. No rows returned` (10 sampai 30 detik). Kalau muncul peringatan "destructive operation", pilih **Run this query**: file ini memang menghapus dan membuat ulang fungsi lamanya, data tidak hilang.

Kalau editor menolak karena file terlalu panjang, jalankan file satu per satu: 01, 02, 03, 04, 05, 06 (satu query baru untuk tiap file).

**Sudah pernah memasang versi sebelumnya (1.0 sampai 1.8)?** Jalankan saja `kaly-ops-supabase.sql` versi ini di project yang sama, lalu perbarui folder aplikasi. Jalankan SQL-nya **lebih dulu**: cetak nota rangkap, checker per item di dapur dan kasir, notifikasi item siap, dan saklar Integrasi Kaly Core memakai fungsi dan kolom baru dari SQL ini. Tabel dan data Anda tetap, fungsi diperbarui, dan baris staf contoh `@kaly.id` yang belum punya login dihapus otomatis.

Periksa hasilnya:

```sql
select
  (select count(*) from menus)         as menu,        -- 75
  (select count(*) from dining_tables) as meja,        -- 42
  (select count(*) from items)         as bahan,       -- 84
  (select count(*) from stock)         as baris_stok;  -- 110
```

## Langkah 2 · Buat akun Owner

1. Di SQL Editor, jalankan (ganti dengan email dan nama Anda):

   ```sql
   select public.kaly_setup_owner('emailanda@gmail.com', 'Nama Anda');
   ```

   Fungsi ini hanya bisa dijalankan dari SQL Editor, tidak bisa dari aplikasi atau internet.

2. Buka **Authentication → Users → Add user → Create new user**. Isi email yang **sama persis**, buat kata sandi, centang **Auto Confirm User**, lalu **Create user**. Akun login otomatis tersambung ke Owner.

3. Disarankan: **Authentication → Sign In / Providers**, matikan **Allow new users to sign up**. Semua akun staf dibuat Owner dari dashboard, jadi pendaftaran umum tidak diperlukan. Akun yang mendaftar sendiri tetap tidak bisa membuka data apa pun karena tidak terdaftar sebagai staf.

Periksa:

```sql
select name, role, email, user_id is not null as sudah_tersambung from staff;
```

## Langkah 3 · Sambungkan aplikasi & terbitkan lewat GitHub Pages

1. Di Supabase, klik tombol **Connect** di atas dashboard, atau buka **Project Settings → API Keys**. Salin:
   - **Project URL**, contoh `https://abcdefghijklm.supabase.co`
   - **Publishable key** (`sb_publishable_...`) atau **anon key** (legacy). Keduanya boleh dipasang di aplikasi.
2. Ekstrak `kaly-ops.zip`. Buka `js/config.js` dengan Notepad dan isi di antara tanda kutip:

   ```js
   export const SUPABASE_URL = 'https://abcdefghijklm.supabase.co';
   export const SUPABASE_ANON_KEY = 'sb_publishable_xxxxxxxx';
   ```

   Simpan. **Jangan pernah** memakai `service_role` atau `secret key` di file ini, karena kunci itu bisa membuka semua data tanpa batas.
3. GitHub › repository **kalyops** › **Settings › Pages** › Source: **GitHub Actions** (sekali saja). Setiap perubahan di folder `app/` pada branch `main` terbit otomatis lewat workflow `.github/workflows/pages.yml` ke https://choirulefendy-blip.github.io/kalyops/. Owner / Manajer masuk lewat https://choirulefendy-blip.github.io/kalyops/backoffice/.
4. Opsional: **Authentication → URL Configuration**, isi **Site URL** dengan `https://kaly-ops.netlify.app`.

Kalau `config.js` belum diisi, halaman login menampilkan kartu **Sambungkan ke database** sebagai pengingat.

## Langkah 4 · Owner menyiapkan outlet

Masuk di `kaly-ops.netlify.app` dengan email dan kata sandi Owner. Beranda menampilkan **Persiapan sebelum buka**:

1. **Staf.** Pengaturan → Staf & akses → **Tambah staf**: nama, email, peran, outlet. Lalu buat akun loginnya di Supabase (Authentication → Users → Add user) dengan email yang sama dan centang Auto Confirm User. Berikan email dan kata sandi itu ke staf. Staf bisa mengganti kata sandinya sendiri di Pengaturan → Akun saya.
2. **PIN manajer.** Ganti PIN bawaan `1234` di Pengaturan. PIN dipakai untuk diskon manual di atas batas, void bill, dan buka laci.
3. **Stok awal.** Stok awal di paket masih contoh. Lakukan stock opname pertama di Kaly Core supaya sesuai stok fisik, dan sesuaikan resep bila perlu.
4. **Supplier.** Tambahkan supplier dan harga acuan di Kaly Goods.
5. **QRIS toko.** Kaly Order → Pengaturan → Unggah gambar QRIS dari bank. Gambar itu tampil di jendela bayar kasir, layar pelanggan, dan halaman lacak pesanan online.
6. **Foto menu.** Kaly Core → Menu & resep → pilih menu → unggah foto. Foto langsung tampil di semua perangkat.

| Peran | Halaman pertama | Yang bisa dilakukan |
|---|---|---|
| owner | Beranda | Semua modul, laporan, setujui & bayar PO, menu, harga, resep, staf, pengaturan. |
| kasir | Kaly POS | Pesanan & pembayaran di outletnya, shift, member, deposit, reservasi, Kaly Order. |
| service | Denah Meja | Pesanan dan meja, antar pesanan siap, reservasi. Tidak menerima pembayaran. |
| dapur | Kaly Kitchen | Layar dapur, produksi bahan setengah jadi, lihat stok. |
| gudang | Kaly Goods | Stok, PO, penerimaan barang, mutasi antar lokasi, opname, B2B. |
| tanpa login | | Halaman pelanggan saja (pesan, lacak, reservasi, kartu member, layar antrean). Tidak bisa membaca tabel apa pun. |

## Notifikasi suara & meja Sudah bayar (baru di 1.2)

Database mencatat kejadian penting di tabel `staff_alerts`, dan setiap layar staf membunyikannya sesuai peran:

| Notifikasi | Menyala bawaan untuk |
|---|---|
| Pesanan QR baru dari meja, tambahan pesanan QR di bill meja | Kasir, Owner (diulang sampai bill dibuka) |
| Pesanan online baru | Kasir, Owner |
| Pesanan siap diantar | Kasir, Service, Owner |
| Meja sudah dibayar, perlu dikosongkan | Service |
| Tamu pindah meja (1.3) | Service, Kasir (tidak berbunyi di perangkat yang memindahkan) |
| Reservasi baru dari pelanggan | Kasir, Service, Owner |
| Tiket baru di layar dapur | Dapur |
| PO menunggu persetujuan / PO disetujui atau ditolak | Owner / Gudang |
| Mutasi barang masuk, stok di bawah minimum | Gudang (stok juga Owner) |
| Temuan fraud baru | Owner |
| Versi aplikasi baru terbit di GitHub Pages | Semua |

Setiap perangkat bisa mengatur suaranya sendiri lewat ikon speaker di bilah atas. Browser baru mengizinkan suara setelah layar diketuk sekali.

Setelah bill dine-in dibayar, meja **tidak langsung kosong**. Meja tampil *Sudah bayar* di Denah sampai service menekan **Kosongkan meja** (fungsi `table_clear`). Membuka bill baru di meja itu juga otomatis mengosongkan tandanya.

## Kosongkan & pindah meja dari Kasir dan Service (baru di 1.3)

**Kosongkan meja** sekarang bisa dari kasir juga, tidak hanya service:

- Di Kaly POS, meja *Lunas* yang diketuk membuka pilihan **Kosongkan meja**, **Pindah ke meja lain**, atau **Tamu pesan lagi: buka bill baru**.
- Kepala daftar meja menampilkan tombol **N lunas**: daftar semua meja yang sudah dibayar tapi belum dikosongkan, dengan tombol Kosongkan per meja dan **Kosongkan semua**.
- Struk setelah bayar dine-in punya tombol **Kosongkan meja** untuk tamu yang langsung pergi.
- Di Denah Meja (kasir dan service) tombol Kosongkan tetap ada seperti di 1.2.

**Pindah meja** untuk meja yang sudah terisi, dari Kasir maupun Service (fungsi `table_move`):

- Kasir: ikon ⇄ di kepala bill, atau dari pilihan meja *Lunas*.
- Service: tombol **Pindah ke meja lain** di detail meja Denah (meja Terisi, Siap diantar, atau Sudah bayar).
- Yang ikut pindah dalam satu langkah: bill terbuka, pesanan QR yang sudah dibayar tapi makanannya belum diantar, tanda *Sudah bayar*, dan reservasi yang tamunya sudah datang. Tiket dapur dan notifikasi "siap diantar" berikutnya langsung memakai nomor meja baru.
- Hanya meja kosong yang bisa dipilih. Meja yang ada reservasi dalam 2 jam diberi tanda dan diminta konfirmasi. Kalau dua staf memindahkan tamu ke meja yang sama bersamaan, hanya satu yang berhasil.
- Bill gabungan (mis. R1 + R2): pilihan **Lepas meja gabungan** (bawaan dicentang) memindahkan satu rombongan ke satu meja. Memindahkan meja gabungannya saja (R2 → R4) hanya mengganti meja itu.
- Dapur dan gudang tidak bisa mengosongkan atau memindahkan meja.

## Laporan operasional & grafik (baru di 1.4)

Tab **Kaly Core → Laporan** (khusus Owner) kini berisi delapan laporan, semuanya dengan grafik, tooltip, dan unduhan CSV: Laba rugi, Neraca, Arus kas, Penjualan, **Nota & jam**, **Kategori & jam**, **Aktivitas meja**, dan Jurnal.

Tiga laporan baru dihitung langsung di database, jadi periode berapa pun (termasuk lebih dari 35 hari) tetap lengkap dan ringan untuk HP:

| Fungsi | Isi |
|---|---|
| `report_receipts(dari, sampai, outlet[], batas)` | Nota lunas per jam bayar, per hari, per hari × jam, per metode bayar, daftar nota, dan nota batal. |
| `report_categories(dari, sampai, outlet[])` | Porsi, nilai, HPP aktual, dan margin per kategori; kategori × jam; tren harian; menu teratas per kategori. |
| `report_tables(dari, sampai, outlet)` | Kunjungan meja, lama duduk, duduk setelah bayar, tunggu antar, keterisian per jam, per meja/area, aktivitas staf, dan log meja. |

Jam memakai zona waktu di Pengaturan (bawaan Asia/Jakarta). Hanya Owner yang bisa memanggil fungsi ini.

Tabel baru `table_events` mencatat **pindah meja, kosongkan meja** (manual oleh staf atau otomatis saat bill baru dibuka), dan **antar pesanan**, lengkap dengan petugasnya. Pencatatan dimulai sejak SQL 1.4 dijalankan; untuk tanggal sebelumnya laporan Aktivitas meja tetap menampilkan kunjungan, penjualan, dan lama duduk sampai dibayar.

Warna grafik memakai turunan warna brand KALY dan sudah diuji dengan validator buta warna (pasangan bersebelahan aman untuk protanopia/deuteranopia). Hijau olive dan oranye brand tidak pernah dipakai berdampingan; naik/turun memakai pasangan teal ↔ oranye.

## Baru di 2.9: kasir tablet, anggota shift, laporan per shift

- Tabel baru `crew` (anggota shift): nama petugas kasir, service, dan dapur yang bergantian memakai satu akun login. Semua staf boleh membaca; **hanya Owner** yang bisa menambah/mengubah (RLS), dari Kaly Backoffice › Pengaturan › Anggota shift.
- `shifts.crew_id` dan `shifts.crew_name`: nama petugas shift. `shift_open(p_terminal, p_location, p_cash, p_crew)` mewajibkan nama bila outlet sudah punya petugas kasir. Versi lama tiga parameter tetap bisa dipakai.
- `shift_crew(p_shift, p_crew)`: kasir mengganti nama petugas pada shift berjalan tanpa ganti email login. Setiap pergantian tercatat di laporan fraud dengan tingkat **rendah**.
- `shift_reports(p_location, p_days)`: laporan tiap shift (aktif & selesai, maks. 45 hari) untuk layar kasir: penjualan, jumlah transaksi, metode bayar, diskon, bill batal, kas seharusnya, selisih.
- Notifikasi buka/tutup shift dan nama kasir di nota memakai nama petugas shift.
- Database lama: jalankan `kaly-ops-update-2.9.sql`.

## Baru di 2.8: model printer

Kolom baru `print_stations.model` (`umum`, `epson_t82x`, `rongta_rpp02n`) dan fungsi `print_station_model(p_id, p_model)` (hanya Owner). Aplikasi memakai model untuk lebar gambar ESC/POS dan pemotong kertas:

| Model | Kertas | Lebar cetak | Pemotong | Sambungan yang disarankan |
|---|---|---|---|---|
| Epson TM-T82X | 80 mm | 512 titik (180 dpi) | otomatis | LAN (model Ethernet) atau USB |
| Rongta RPP02N | 58 mm | 384 titik (203 dpi) | tidak ada, disobek | Bluetooth atau USB |
| Printer lain | 58 / 80 mm | 384 / 576 titik | perintah potong dikirim | — |

## Baru di 2.7: GitHub Pages & Kaly Backoffice

- Aplikasi tidak lagi di Netlify. Repository `choirulefendy-blip/kalyops` berisi `app/` (situs), `supabase/` (paket ini), dan `android/` (kode aplikasi Android tanpa keystore). Workflow `pages.yml` menerbitkan `app/` ke GitHub Pages dan memberi nomor build baru setiap terbit, sehingga perangkat yang terbuka mendapat pemberitahuan versi baru.
- Akun **Owner / Manajer** memakai portal **Kaly Backoffice** (`/backoffice/`), dengan menu tersendiri. Akun kasir, dapur, gudang, dan service ditolak di Backoffice dan tetap memakai Kaly Ops. Hak akses database tidak berubah (tetap dijaga RLS per peran).
- Tidak ada perubahan SQL di 2.6–2.7.
- Supabase › Authentication › URL Configuration: isi **Site URL** dengan alamat GitHub Pages (tidak wajib untuk login email & kata sandi, tetapi berguna bila nanti memakai tautan email).

## Baru di 2.5: layar dapur menerima notifikasi dari kasir

Layar dapur (Kaly Kitchen) sekarang diberi tahu setiap kali kasir mengubah pesanan yang menyangkut dapur. Notifikasi dibuat database lewat pemicu pada `order_lines` dan `orders`, jadi berlaku dari mana pun perubahan dilakukan (kasir, QR meja yang langsung masuk dapur, pre-order yang dilepas otomatis).

| Jenis | Kapan | Contoh |
|---|---|---|
| `k_new` | Item pertama sebuah nota dikirim ke dapur | *Pesanan baru · Meja G3 · A015* — Dapur: 2× Nasi Goreng (pedas) |
| `k_add` | Tambahan item di nota yang sudah pernah dikirim | *Tambahan · Meja G3 · A015* — Bar: 1× Es Teh |
| `k_void` | Item yang sudah di dapur dibatalkan kasir, atau seluruh bill dibatalkan | *BATAL · 2× Nasi Goreng · Meja G3 · A015* — alasan, nama kasir, "Hentikan pembuatannya" / "Sudah siap: jangan diantar" |
| `k_move` | Pindah meja, split bill, atau gabung bill saat item masih dibuat | *Pindah meja · A5 → G1 · A012* — Antar ke meja G1 |

- Satu notifikasi per nota **per stasiun** (Dapur / Bar). Layar dapur yang dipilih **Bar** hanya menerima item Bar; pilihan stasiun disimpan per perangkat.
- Dibaca hanya oleh **dapur** dan **Owner** (Owner mati bawaan, bisa dinyalakan). Kasir dan service tidak menerimanya.
- Di layar dapur: kartu notifikasi dengan suara dan ucapan; kartu **BATAL** tidak hilang sendiri sampai ditekan *Oke, dimengerti*; item yang dibatalkan tetap tampil **dicoret** di tiket selama 30 menit.
- **Lonceng** di bilah atas layar dapur sekarang berisi **Notifikasi dari kasir** (sebelumnya berisi "pesanan siap dari dapur", yang hanya berguna untuk kasir & service).
- Bisa juga muncul di bilah notifikasi tablet/HP dapur lewat notifikasi perangkat 2.4. Agar notifikasi dapur membuka layar dapur saat diketuk, perbarui Edge Function `kaly-push` dengan `functions/kaly-push/index.ts` versi 2.5.
- Notifikasi tidak pernah menggagalkan transaksi kasir. Aplikasi kini hanya mengambil notifikasi yang lebih baru dari yang sudah dimuat, jadi tambahan notifikasi dapur tidak membebani sinkron.

## Baru di 2.4: notifikasi di perangkat masing-masing

Notifikasi staf (`staff_alerts`) sekarang bisa muncul di bilah notifikasi HP, tablet, atau laptop masing-masing, **juga saat Kaly Ops ditutup**.

**Jenis notifikasi baru** (dibuat otomatis oleh database):

| Jenis | Kapan | Untuk |
|---|---|---|
| `shift_close` | Shift kasir ditutup: jumlah transaksi, penjualan, tunai, selisih kas, bill batal | Owner |
| `day_close` | Semua shift di outlet sudah ditutup: penjualan hari ini, jumlah & rata-rata transaksi, rincian per metode bayar | Owner |
| `shift_open` | Shift kasir dibuka dengan modal kas (mati bawaan, bisa dinyalakan) | Owner |
| `po_paid` | PO dibayar ke supplier | Owner |
| `po_recv` | Barang PO diterima, stok bahan bertambah | Owner & gudang |
| `opname` | Stock opname selesai dengan nilai selisihnya | Owner & gudang |

Yang sudah ada tetap berjalan: fraud, stok menipis, PO menunggu/disetujui, mutasi masuk, pesanan QR & online, meja, reservasi. Notifikasi fraud, keuangan, dan shift **hanya bisa dibaca Owner**; bahan & PO hanya Owner dan gudang (aturan baru di RLS `staff_alerts`, lewat fungsi `alert_roles`).

**Cara kerjanya:**

1. Staf menekan tombol speaker di bilah atas › **Aktifkan notifikasi di perangkat ini**. Browser meminta izin notifikasi; perangkat didaftarkan ke tabel `push_subscriptions` bersama jenis notifikasi yang dipilihnya (`push_subscribe`, `push_kinds`, `push_unsubscribe`). Keluar akun menghapus pendaftaran perangkat itu.
2. Selama Kaly Ops terbuka (termasuk di tab/aplikasi latar), aplikasi sendiri menampilkan notifikasi sistem.
3. Saat Kaly Ops ditutup: setiap baris baru di `staff_alerts` memicu `pg_net` memanggil Edge Function **kaly-push** dengan id notifikasinya saja. Fungsi mengambil isi & perangkat tujuan dari database (`push_targets`, hanya bisa dipanggil kunci service_role), mengenkripsi pesan (RFC 8291) dan menandatanganinya (VAPID, RFC 8292), lalu mengirim ke layanan push browser. Perangkat yang sudah mencabut izin dihapus otomatis. Setiap notifikasi hanya dikirim sekali (`push_log`) dan hanya bila umurnya di bawah 15 menit. Pemicu tidak pernah menggagalkan transaksi.
4. Notifikasi yang sama dari jalur 2 dan 3 memakai tag yang sama, jadi tidak muncul dobel. Ketuk notifikasi untuk membuka halaman terkait.

**Memasang server notifikasi (sekali, ±5 menit):**

1. Jalankan `kaly-ops-supabase.sql` 2.4 (juga menyalakan ekstensi `pg_net`).
2. **Edge Functions › Deploy a new function › Via Editor**, nama `kaly-push`, tempel isi `functions/kaly-push/index.ts`, **Deploy**.
3. Fungsi kaly-push › **Details**: matikan **Verify JWT** (Enforce JWT verification). Database memanggil fungsi ini tanpa login; fungsi tidak menerima isi pesan dari luar, jadi aman. Lewat CLI: `supabase functions deploy kaly-push --no-verify-jwt`.
4. Kaly Ops › **Pengaturan › Notifikasi di perangkat › Sambungkan**. Kunci VAPID dibuat otomatis dan disimpan di `app_secrets` (tidak bisa dibaca aplikasi).
5. Di setiap HP/laptop: tombol speaker › **Aktifkan notifikasi di perangkat ini** › **Kirim tes**.

Tidak perlu Firebase, akun tambahan, atau kunci yang ditempel manual. `SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY` sudah tersedia otomatis di Edge Function; secret opsional `VAPID_SUBJECT` (mis. `mailto:emailanda@gmail.com`) dan `KALY_SERVICE_KEY` (bila project hanya memakai kunci rahasia baru `sb_secret_…`).

**Perangkat yang didukung:** Android (Chrome, Edge, Samsung Internet, Firefox), laptop (Chrome, Edge, Firefox, Safari), iPhone/iPad iOS 16.4+ setelah Kaly Ops ditambahkan ke Layar Utama dari Safari. Aplikasi Android Kaly Ops 1.2 di tablet kasir menampilkan notifikasi Android selama aplikasinya berjalan (WebView Android tidak mendukung Web Push), jadi HP pribadi Owner/Manajer sebaiknya memakai Chrome.

## Baru di 2.3: sambungan printer Bluetooth, USB, LAN/Wi-Fi, PC

Kolom baru di `print_stations`: `conn` (`pc` = PC/stasiun cetak, `lan` = LAN/Wi-Fi, `bt` = Bluetooth, `usb` = USB ke tablet), `bt_addr` (alamat MAC, dirapikan ke huruf besar dengan titik dua), dan `usb_id` (`vendor:produk`, mis. `0416:5011`). Printer ber-IP dari 2.2 otomatis menjadi `lan`. `print_station_save` menerima `p_conn`, `p_bt`, `p_usb`, memeriksa alamat sesuai sambungannya, dan hanya menyimpan alamat milik sambungan yang dipilih. Bluetooth & USB dicetak oleh aplikasi Android Kaly Ops 1.1.

## Baru di 2.2: aplikasi Android & printer LAN

Kolom baru di `print_stations`: `ip` (alamat printer LAN/Wi-Fi), `port` (bawaan 9100), `paper` (58/80 mm, kosong = ikut Tampilan nota), dan `mode` (`raster` = GS v 0, `escstar` = ESC * untuk printer lama). `print_station_save` menerima keempatnya (fungsi lama 4 parameter diganti). Printer ber-IP dicetak langsung oleh **aplikasi Android Kaly Ops** di tablet kasir: lembar digambar di tablet, diubah menjadi perintah ESC/POS, lalu dikirim ke `ip:port` tanpa lewat database. Printer tanpa IP tetap memakai stasiun cetak 2.1. Tablet dengan aplikasi juga bisa menjadi stasiun cetak untuk printer ber-IP, sehingga kasir di PC/browser pun bisa mengirim slip ke printer LAN.

## Baru di 2.1: printer & stasiun cetak

Setiap jenis lembar (nota pelanggan, salinan kasir, slip Bar, slip Dapur) bisa dikirim ke printer yang berbeda. Browser tidak bisa memilih printer sendiri, jadi setiap printer dijalankan oleh **stasiun cetak**: PC/laptop yang tersambung ke printer itu membuka halaman **Stasiun cetak** dan mencetak antreannya otomatis (Chrome dengan `--kiosk-printing` mencetak tanpa jendela cetak).

- Tabel baru `print_stations` (printer per outlet, dihapus = `active false`), `print_station_seen` (kapan stasiun terakhir aktif, sengaja tanpa pemicu sinkron), dan `print_jobs` (antrean: isi cetakan HTML yang sudah jadi; `queued` → `printing` → `printed`/`failed`, plus `cancelled` dan `expired` untuk antrean lebih dari 6 jam).
- Kolom baru `locations.print_route` (jsonb): tujuan tiap jenis lembar per outlet, `"local"` = perangkat yang menekan Cetak. Diubah Owner di **Pengaturan → Printer & tujuan cetak**.
- Fungsi baru: `print_station_save` (Owner), `print_enqueue` (kasir/service/Owner; peran lain hanya cetak tes), `print_claim` (perangkat stasiun mengambil antrean dengan `for update skip locked` sekaligus melapor aktif), `print_done`, `print_retry`, `print_cancel` (mengembalikan id yang benar-benar dibatalkan, supaya kasir tidak mencetak dobel bila stasiun sudah mengambilnya).
- Semua staf hanya melihat printer dan antrean outlet yang boleh mereka akses. Tabel tidak bisa ditulis langsung, hanya lewat fungsi di atas. Antrean lebih dari 3 hari dihapus otomatis.
- Bila printer tujuan tidak aktif lebih dari 90 detik, kasir ditanya: biarkan di antrean (tercetak saat stasiun menyala) atau cetak di perangkat kasir (antrean dibatalkan).

## Baru di 2.0: Kaly POS untuk Owner, impor Excel, tampilan nota

Kolom baru `settings.receipt` (jsonb, bawaan `{}`) menyimpan tampilan nota yang diatur Owner: logo, nama usaha, baris alamat/WhatsApp/Instagram/NPWP di bawah nama, nama outlet, nama kasir, nama member & poin, pesan di bagian bawah, QRIS toko di tagihan sementara, lebar kertas (`58` atau `80` mm) dan ukuran huruf (`kecil`, `normal`, `besar`). Kunci yang kosong memakai bawaan aplikasi. Hanya Owner yang bisa mengubah; semua kasir membacanya saat mencetak, jadi perubahan langsung berlaku di semua perangkat.

Kaly POS untuk akun Owner tidak lagi untuk transaksi: isinya daftar menu untuk diubah dan ditambah, impor/unduh Excel, kelola kategori, dan tampilan nota. Impor Excel memakai fungsi yang sudah ada (`catalog_save`, hanya Owner) dan hanya mengirim menu yang berubah. Tidak ada perubahan hak akses lain: transaksi tetap dicatat dari akun kasir.

## Baru di 1.9: cetak nota rangkap

Kolom baru `settings.print_copies` (jumlah lembar: `cust` nota pelanggan, `copy` salinan kasir, `bar` slip Bar, `dapur` slip Dapur; bawaan 1 semua, hanya Owner yang bisa mengubah) dan `order_lines.slip_at` (waktu item tercetak di slip). Fungsi baru `print_slips(pesanan, cetak_ulang)` menandai item yang sudah dikirim ke dapur dan belum pernah tercetak, lalu mengembalikan id-nya untuk slip Bar (stasiun `bar`: Desserts, Coffee, Non-Coffee) dan slip Dapur (stasiun `dapur`: Main Dish, Snacks). Dengan `cetak_ulang = true` semua item yang pernah tercetak dikembalikan. Kasir tidak bisa mengubah `slip_at` langsung dari tabel.

## Baru di 1.8: checker per item di dapur & kasir

Layar dapur kembali satu kolom per nota, tetapi setiap menu di dalamnya punya status dan tombol **Siap** sendiri. `kitchen_line` kini juga menerima `'uncook'` (batal dimasak, kembali antre). Di Kaly POS, tab **Checker** menampilkan setiap nota yang belum selesai dengan tombol **Antar** per menu, dan `serve_line` boleh dipakai kasir/pramusaji untuk menu yang belum ditandai siap oleh dapur (waktu siapnya dicatat saat diantar). Menu yang belum dikirim ke dapur atau sudah dibatalkan tetap ditolak.

## Baru di 1.7: tanpa takeaway & delivery, dapur per item, saklar Kaly Core

**Takeaway & delivery dihapus.** `public_place_order` hanya menerima pesanan QR meja dan pre-order reservasi (mode lain ditolak dengan pesan "Pesan dari HP hanya lewat QR di meja atau pre-order reservasi"), dan `public_quote` tidak lagi menghitung ongkir. Bill dari kasir di outlet yang punya meja (Resto) wajib memakai meja: trigger `orders_guard` menolak bill tanpa meja, menyamakan tipe bill (`dine` bila bermeja, `take` = **Langsung** untuk outlet tanpa meja seperti Play Corner), dan menolak melepas meja dari bill. Data takeaway/delivery lama tetap tersimpan dan tampil di laporan.

**Layar dapur per item.** Fungsi baru `kitchen_line(item, 'cook' | 'ready' | 'back')` mengubah status satu item, dan `serve_line(item)` menandai satu item sudah diantar (pramusaji, kasir, Owner). Notifikasi siap kini dikirim per item: kolom baru `order_notices.line_id`. Bill selesai (`kitchen_state = served`) setelah semua itemnya diantar, dan setiap antar tercatat di log meja. Fungsi lama `kitchen_tap_line`, `kitchen_bump`, dan `serve_ready` tetap ada.

**Integrasi Kaly Core per outlet.** Kolom baru `locations.core_stock` (bawaan `true`). Bila `false`, penjualan outlet itu tidak memotong stok bahan & bumbu, tidak membuat jurnal HPP maupun waste void, item tercatat dengan `cost` kosong, dan menu tidak pernah habis karena bahan (`menu_portions` = tak terbatas). Owner mengubahnya di **Pengaturan → Integrasi Kaly Core**.

## Pembayaran online

- Pre-order reservasi, dan pesanan QR meja yang memilih bayar sekarang, berstatus **Menunggu bayar online** dan belum masuk dapur.
- Pelanggan melihat QRIS toko dan total di halaman lacak pesanan.
- Setelah dana masuk di mutasi QRIS/rekening, kasir atau Owner menekan **Sudah dibayar?** di Kaly Order. Pesanan lunas dan langsung masuk dapur.
- Untuk status bayar otomatis, sambungkan payment gateway (Midtrans/Xendit) lewat Edge Function yang memanggil `confirm_online_payment` dengan secret key.
- `settings.demo_online_pay = true` hanya untuk uji coba: pembayaran online langsung dianggap lunas.

## Pre-order reservasi terjadwal (opsional)

Aplikasi yang sedang terbuka di kasir mengirim pre-order reservasi ke dapur otomatis 30 menit sebelum jam reservasi. Supaya tetap jalan walau semua kasir tertutup, aktifkan **Database → Extensions → pg_cron**, lalu:

```sql
select cron.schedule('kaly-pesanan-terjadwal', '*/5 * * * *', $$select public.release_due_orders()$$);
```

## Sebelum operasional sungguhan

- Kalau database sudah dipakai untuk uji coba, jalankan `07_kosongkan_transaksi.sql`, lalu jalankan ulang `06_seed_master.sql` (atau langsung lakukan stock opname). Menu, resep, meja, staf, dan pengaturan tetap.
- Paket Pro Supabase menyimpan cadangan harian otomatis (**Database → Backups**). Di paket gratis, buat cadangan sendiri secara berkala, misalnya dengan `supabase db dump` (Supabase CLI) atau `pg_dump`.
- Paket gratis Supabase menghentikan sementara project yang tidak dipakai 7 hari. Untuk outlet yang buka setiap hari ini tidak terjadi, tapi pertimbangkan paket Pro untuk operasional.

## Hasil pengujian

Diuji di PostgreSQL 16 dengan peniru Supabase (Auth, Data API, Storage, Realtime) dan aplikasi asli di Chromium:

- File gabungan berjalan sebagai satu transaksi di database kosong, dan bisa dijalankan ulang di database versi 1.0 tanpa kehilangan data.
- 210 dari 210 uji fungsi database lulus (hak akses tiap peran, PIN, penjaga stok, split/gabung, void, shift, deposit, PO, mutasi, opname, B2B, pre-order, reservasi, keseimbangan jurnal, dan uji 1.7: takeaway/delivery ditolak, Resto wajib meja, dapur & antar per item, checker kasir untuk menu yang belum siap, saklar Kaly Core per outlet, slip Bar/Dapur tanpa cetak dobel, cetak ulang, hak akses pengaturan cetak, dan uji 2.0: tampilan nota hanya bisa diubah Owner tetapi terbaca kasir & dapur, impor menu dari Excel dengan outlet & status Nonaktif, kasir tidak bisa mengimpor atau mengubah harga, menu tanpa harga ditolak, dan uji 2.1: printer per outlet, tujuan cetak hanya diubah Owner, slip hanya ke printer outlet yang sama, stasiun hanya mengambil antreannya sendiri tanpa dobel, denyut stasiun tidak memicu sinkron, cetak lagi, gagal cetak, batal, kedaluwarsa 6 jam, printer dihapus mengembalikan tujuan ke kasir, staf outlet lain tidak bisa memakai printer, dan uji 2.2: printer LAN dengan IP, port, kertas, dan mode; IP/port/kertas/mode yang salah ditolak; kasir bisa membaca IP untuk mencetak langsung; dan uji 2.3: printer Bluetooth & USB, alamat dirapikan, sambungan tanpa alamat atau alamat salah ditolak, ganti ke PC mengosongkan alamat, printer lama ber-IP tercatat LAN, dan uji 2.4: laporan tutup shift, ringkasan harian saat shift terakhir ditutup, shift dibuka, PO diterima & dibayar, opname, hak baca notifikasi per peran, pendaftaran perangkat & pilihan jenis, sasaran push per peran/outlet/pilihan, tes hanya ke perangkat sendiri, notifikasi lama & dobel tidak dikirim, perangkat kedaluwarsa dihapus, kunci VAPID tersimpan sekali, alamat fungsi diperiksa, tanpa pg_net transaksi tetap jalan, dan uji 2.5: notifikasi dapur per stasiun saat kirim, tambahan, item dimasak/siap tidak memicu notifikasi, batal saat dimasak & saat sudah siap, item draf dihapus tanpa notifikasi, pindah meja, split sebagian, gabung bill, batal seluruh bill, pesanan tanpa meja, hanya dapur & Owner yang bisa membaca).
- Pembaruan ke 2.5 diuji: SQL 2.5 dijalankan di atas database 2.4 berisi transaksi; sebelumnya SQL 2.4 di atas database 2.3 berisi transaksi & printer; sebelumnya SQL 2.3 di atas database 2.2 berisi printer LAN (otomatis menjadi `lan`), sebelumnya 2.1 → 2.2, 2.0 → 2.1, 1.9 → 2.0, dan 1.4 → 1.9, lalu dijalankan ulang, tanpa error dan tanpa kehilangan data. `07_kosongkan_transaksi.sql` ikut mengosongkan antrean cetak.
- Uji alur 1.7/1.8 di browser: 44 uji (kasir Resto wajib meja, Play Corner langsung, dapur per nota dengan Siap per item → notifikasi pramusaji → antar per item dari Denah, Checker kasir, dan bill, Batal siap, halaman pesan tanpa takeaway/delivery, Kaly Order, saklar Kaly Core tanpa potong stok & HPP).
- Edge Function kaly-push: 15 uji dengan Deno, layanan push tiruan (HTTPS), dan perangkat tiruan yang mendekripsi pesan (kunci VAPID dibuat & disimpan sekali, JWT VAPID ES256 sah, isi terenkripsi aes128gcm terbaca, kasir tidak menerima fraud, perangkat 410 dihapus, tidak dikirim dua kali, format Database Webhook, jalur penuh pemicu → pg_net → fungsi).
- Notifikasi dapur 2.5: 19 uji di Chromium (kartu pesanan baru per stasiun di layar dapur, lonceng Notifikasi dari kasir & angka belum dibaca, layar Bar tidak menerima item Dapur, kartu BATAL yang harus dikonfirmasi, item batal dicoret di tiket, pindah meja, kasir & Owner tidak menerima secara bawaan, pengaturan per perangkat).
- Notifikasi di perangkat 2.4: 30 uji di Chromium (ajakan di Beranda, izin & service worker, Sambungkan server dari Pengaturan, pendaftaran perangkat & pilihan jenis tersinkron, fraud dan laporan tutup shift sampai di HP lewat Web Push, tidak dobel saat aplikasi terbuka, notifikasi sistem saat tab di latar, Kirim tes, ketuk notifikasi membuka Kaly Core di tab yang tepat, kasir hanya menerima notifikasi pesanan, keluar akun menghentikan notifikasi). Aplikasi Android 1.2 (notifikasi Android) diperiksa tanda tangan & isinya; belum diuji di tablet fisik.
- Sambungan printer 2.3: 18 uji di browser dengan jembatan aplikasi 1.1 tiruan (pilihan LAN/Bluetooth/USB/PC, Cari printer Bluetooth & USB di tablet, alamat manual dari PC, nota & salinan ke USB + slip Bar ke Bluetooth + slip Dapur ke LAN dalam sekali cetak, petunjuk khusus saat Bluetooth mati, aplikasi 1.0 tetap bisa LAN dan diminta memperbarui untuk USB/Bluetooth).
- Aplikasi Android 2.2: 22 uji di browser dengan jembatan aplikasi tiruan (3 printer LAN sekaligus dari tablet tanpa jendela cetak & tanpa antrean, hasil ESC/POS diurai kembali menjadi gambar: nota + salinan 576 titik, slip Bar 384 titik GS v 0, slip Dapur ESC *, printer mati → Coba lagi / Cetak lewat Android, printer tablet untuk lembar Perangkat kasir, Cek koneksi, Cetak tes, PC kasir → antrean → tablet stasiun mencetak ke printer LAN, simpan file & suara lewat aplikasi). Pengirim TCP aplikasi diuji dengan printer tiruan (kirim 100 KB, printer mati, IP tidak ada, dua cetakan bersamaan). APK diperiksa tanda tangan (v1+v2+v3) dan isinya; belum diuji di tablet & printer fisik.
- Printer & stasiun cetak 2.1 di browser: 28 uji (tambah printer & tujuan cetak, tautan stasiun, stasiun tetap mencetak di layar Kaly Kitchen, kasir hanya mencetak nota & salinan sementara slip Bar/Dapur keluar di stasiun masing-masing, printer mati → cetak di kasir tanpa dobel atau biarkan antre lalu tercetak saat menyala, riwayat & cetak lagi, cetak tes dari Pengaturan, isi cetakan dibersihkan dari skrip, printer dihapus, tampilan HP).
- Kaly POS Owner 2.0 di browser: 42 uji (tanpa meja/bill/bayar/shift, ubah harga dari kartu menu, tambah menu per kategori, unduh Excel lalu dibuka dengan openpyxl, impor Excel yang diubah: harga, Habis, Nonaktif, menu & kategori baru, outlet Keduanya, ringkasan baru/diperbarui/tidak berubah, editor tampilan nota dengan pratinjau nota/tagihan/slip, hasil cetak kasir memakai tampilan baru di nota & slip, kembalikan bawaan, Beranda & Denah Owner, tampilan HP).
- Cetak nota rangkap 1.9 di browser: 21 uji (4 lembar sekaligus, pemisahan Bar/Dapur, tambahan pesanan tanpa slip dobel, cetak ulang, jumlah lembar dari Pengaturan, cetak setelah bayar, tampilan HP).
- Uji kesetaraan 120 skenario acak: tagihan, poin, misi, stok, dan produksi otomatis identik dengan aplikasi.
- Uji alur di browser: kasir → dapur tersinkron di bawah 1 detik, pesanan QR masuk bill meja, pesanan online menunggu bayar lalu dikonfirmasi, layar antrean, layar pelanggan dengan QRIS, Kaly Core, Goods, Loop, Book, Pengaturan, staf, dan halaman publik. Tanpa error di konsol.
- Laporan 1.4: 47 uji database (angka tiap laporan dicocokkan dengan perhitungan manual: jam lokal, split bill, meja gabungan, bill batal, filter outlet, hak akses, pencatatan pindah/kosongkan/antar) dan 32 uji di browser (8 laporan × 4 periode, angka layar = database, tooltip, filter jam, cari nota, CSV, tampilan HP tanpa gulir samping).
- Pindah & kosongkan meja 1.3: 25 uji database (bill terbuka, pesanan lunas yang masih dimasak, tanda lunas, meja gabungan, reservasi, hak akses tiap peran, pindah bersamaan ke meja yang sama) dan 36 uji di browser untuk kasir, service, dan tampilan HP.
- Notifikasi 1.2: 19 uji database (pesanan QR baru & tambahan, online, meja ditahan & dikosongkan, reservasi, PO, mutasi, stok menipis, fraud) dan uji di browser untuk 5 peran sekaligus, termasuk bunyi, ucapan, tombol Buka bill, pengaturan per perangkat, dan pemberitahuan versi baru.
- Uji beban 210 pesanan dalam 25 detik: 3 kasir bersamaan, dapur, service, 20 pesanan online, dan 10 pesanan QR meja. Tidak ada error, semua jurnal seimbang, total bayar sama dengan tagihan, stok sama dengan kartu stok, poin dan saldo deposit sesuai riwayat, selisih kas tiap shift nol, dan layar owner serta dapur sama persis dengan database.

## Kalau ada kendala

- **Muncul "BERHENTI, TIDAK ADA YANG DIUBAH" atau error `column ... does not exist` saat Run.** SQL dijalankan di project Supabase yang salah (project aplikasi lain). Pastikan alamat dashboard berisi `/project/<Project ID>` yang sama dengan alamat di `js/config.js`, lalu jalankan lagi di project itu.
- **Login berhasil tapi muncul "belum terdaftar sebagai staf aktif".** Email di Authentication berbeda dengan email di daftar staf, atau staf dinonaktifkan. Samakan emailnya.
- **Halaman login menampilkan "Sambungkan ke database".** `js/config.js` masih kosong atau belum ikut terunggah. Isi, simpan, perbarui folder `app/` di GitHub.
- **"Tidak tersambung ke server".** Cek internet perangkat. Kalau semua perangkat mengalami, buka dashboard Supabase dan pastikan project tidak dalam status Paused.
- **"Akun ini tidak punya akses".** Peran staf tidak mengizinkan tindakan itu, atau outlet tidak termasuk outlet yang boleh diakses. Ubah di Pengaturan → Staf & akses.
- **`Akses ditolak` saat mencoba fungsi di SQL Editor.** Normal. Fungsi aplikasi memeriksa staf yang login, sedangkan SQL Editor tidak login sebagai staf.
- **Foto menu tidak terunggah.** Hanya Owner yang bisa mengunggah. Kalau saat Run SQL muncul pesan `Policy storage tidak bisa dibuat lewat SQL`, buat kebijakan di **Storage → menu-images → Policies**: SELECT untuk semua orang; INSERT, UPDATE, DELETE untuk `authenticated` dengan syarat `public.is_staff(array['owner'])`.
- **Muncul "Database Supabase belum diperbarui ke versi aplikasi ini".** Aplikasi di GitHub Pages sudah lebih baru dari SQL-nya (misalnya laporan Nota & jam di 1.4). Jalankan ulang `kaly-ops-supabase.sql` terbaru di SQL Editor.
- **Notifikasi tidak muncul saat Kaly Ops ditutup.** Cek Pengaturan › Notifikasi di perangkat: server harus *Tersambung*. Tekan tombol speaker › Kirim tes. Bila tes tidak sampai: pastikan Verify JWT fungsi kaly-push mati, lihat **Edge Functions › kaly-push › Logs**, dan cek izin notifikasi browser, mode Jangan Ganggu, serta penghemat baterai HP. Di iPhone, notifikasi hanya jalan dari ikon Kaly Ops di Layar Utama.
- **Sambungkan menjawab 401 / fungsi tidak ditemukan.** Nama fungsi harus persis `kaly-push` dan Verify JWT dimatikan.
- **Lupa kata sandi staf.** Owner membuka Authentication → Users, pilih akun, lalu ganti kata sandinya.
