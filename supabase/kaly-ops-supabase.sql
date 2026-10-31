-- =====================================================================
-- Kaly Ops 2.13 · Database Supabase · SEMUA DALAM SATU FILE
-- Isi: 01 struktur tabel, 02 mesin bisnis, 03 fungsi aplikasi, 04 keamanan, 05 laporan, 06 data master.
-- Cara pakai: Supabase > SQL Editor > New query > tempel seluruh isi file ini > Run. Lalu buat Owner: select public.kaly_setup_owner('emailanda@gmail.com', 'Nama Anda'); Lihat README.md.
-- =====================================================================


-- =====================================================================
-- Kaly Ops · Database Supabase · 01 Struktur tabel
-- ---------------------------------------------------------------------
-- Urutan pasang: 01_schema → 02_functions → 03_security → 04_reports → 05_seed_master
-- (atau jalankan satu file kaly-ops-supabase.sql yang sudah berisi semuanya).
-- Aman dijalankan ulang: tabel dibuat "if not exists", fungsi "create or replace".
-- Target: Postgres 15 ke atas (Supabase).
-- =====================================================================

-- Pengaman: berhenti sebelum mengubah apa pun kalau project ini berisi tabel milik aplikasi lain
-- dengan nama yang sama (misalnya tabel items/settings dari aplikasi lain di project Supabase yang salah).
do $$
declare r record; v_bad text := '';
begin
  for r in select * from (values ('settings', 'tax_rate'), ('staff', 'role'), ('locations', 'entity_id'), ('items', 'yield_qty'),
      ('menus', 'prep_min'), ('stock', 'avg_cost'), ('members', 'points'), ('orders', 'kitchen_state'), ('dining_tables', 'is_gazebo'),
      ('accounts', 'is_cash'), ('journals', 'cash_flow'), ('vouchers', 'max_disc')) as v(t, c) loop
    if to_regclass('public.' || r.t) is not null
       and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = r.t and column_name = r.c) then
      v_bad := v_bad || ' public.' || r.t;
    end if;
  end loop;
  if v_bad <> '' then
    raise exception 'BERHENTI, TIDAK ADA YANG DIUBAH: project Supabase ini sudah berisi tabel milik aplikasi lain (%). Kemungkinan ini bukan project Kaly Ops. Buka project yang Project URL-nya sama dengan js/config.js, lalu jalankan lagi.', trim(v_bad);
  end if;
end $$;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ID pendek berawalan, misalnya o3f9a1c2b7d40 untuk pesanan
create or replace function public.new_id(prefix text)
returns text language sql volatile set search_path = public as $$
  select prefix || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)
$$;

-- ---------------------------------------------------------------------
-- Pengaturan usaha (satu baris)
-- ---------------------------------------------------------------------
create table if not exists public.settings (
  id               smallint primary key default 1 check (id = 1),
  brand_name       text not null default 'Kaly Eatery',
  brand_tagline    text not null default 'Eat x Play x Nature',
  brand_color      text not null default '#475331',
  brand_accent     text not null default '#CC5E44',
  timezone         text not null default 'Asia/Jakarta',
  tax_rate         numeric(6,4) not null default 0.10,
  service_rate     numeric(6,4) not null default 0,
  points_per       numeric(12,0) not null default 10000,
  point_value      numeric(12,0) not null default 100,
  welcome_points   int not null default 20,
  auto_produce     boolean not null default true,
  stock_guard      boolean not null default true,
  sla_min          int not null default 15,
  disc_approval    numeric(6,4) not null default 0.15,
  cash_var_tol     numeric(12,0) not null default 20000,
  po_price_tol     numeric(6,4) not null default 0.10,
  po_approval      numeric(14,0) not null default 3000000,
  transfer_fee     numeric(12,0) not null default 2500,
  deliv_base       numeric(12,0) not null default 8000,
  deliv_per_km     numeric(12,0) not null default 3000,
  max_km           numeric(6,2) not null default 10,
  same_day_cutoff  time not null default '15:00',
  schedule_lead    int not null default 30,
  res_duration     int not null default 120,
  auto_confirm_res boolean not null default false,
  open_hour        int not null default 9,
  close_hour       int not null default 21,
  qr_auto_send     boolean not null default true,
  demo_online_pay  boolean not null default false,
  b2b_markup       numeric(6,4) not null default 0.15,
  birthday_pct     numeric(6,4) not null default 0.25,
  updated_at       timestamptz not null default now()
);
comment on table public.settings is 'Aturan operasional Kaly Ops: pajak, poin, anti-fraud, pengantaran, reservasi. Satu baris (id = 1).';
comment on column public.settings.demo_online_pay is 'true = pembayaran online di halaman pesan dianggap lunas langsung (untuk uji coba). false = menunggu konfirmasi payment gateway atau kasir.';

-- Hal rahasia yang tidak boleh terbaca dari aplikasi (hanya fungsi server)
create table if not exists public.app_secrets (
  id               smallint primary key default 1 check (id = 1),
  manager_pin_hash text not null
);
comment on table public.app_secrets is 'PIN manajer (hash bcrypt). Tidak bisa dibaca aplikasi; dicek lewat fungsi verify_manager_pin.';

-- Tanggal bisnis menurut zona waktu usaha (default Asia/Jakarta)
create or replace function public.biz_date(ts timestamptz default now())
returns date language sql stable set search_path = public as $$
  select (ts at time zone coalesce((select timezone from settings where id = 1), 'Asia/Jakarta'))::date
$$;
create or replace function public.biz_ts(ts timestamptz default now())
returns timestamp language sql stable set search_path = public as $$
  select ts at time zone coalesce((select timezone from settings where id = 1), 'Asia/Jakarta')
$$;

create table if not exists public.entities (
  id    text primary key,
  name  text not null,
  short text not null
);
comment on table public.entities is 'Badan usaha untuk pembukuan: Kaly Eatery (resto & play) dan Central Kitchen.';

create table if not exists public.locations (
  id        text primary key,
  name      text not null,
  entity_id text not null references public.entities(id),
  type      text not null check (type in ('outlet', 'gudang')),
  active    boolean not null default true
);
comment on table public.locations is 'Outlet dan gudang. L1 Resto, L2 Play Corner, L3 Gudang Central Kitchen.';

create table if not exists public.accounts (
  code    text primary key,
  name    text not null,
  type    text not null check (type in ('asset', 'liability', 'equity', 'revenue', 'contra', 'cogs', 'expense')),
  is_cash boolean not null default false
);
comment on table public.accounts is 'Bagan akun untuk jurnal double-entry.';

-- ---------------------------------------------------------------------
-- Staf & peran. Akun login dibuat di Supabase Auth; baris staff disambungkan lewat email.
-- ---------------------------------------------------------------------
create table if not exists public.staff (
  id         text primary key default public.new_id('u'),
  user_id    uuid unique references auth.users(id) on delete set null,
  email      text not null unique,
  name       text not null,
  role       text not null check (role in ('owner', 'kasir', 'dapur', 'gudang', 'service')),
  outlets    text[],
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
comment on table public.staff is 'Staf Kaly Ops. user_id terisi otomatis saat akun dengan email yang sama dibuat di Supabase Auth. outlets kosong = semua outlet.';
comment on column public.staff.role is 'owner = Owner/Manajer, kasir, dapur, gudang, service = pramusaji';

-- ---------------------------------------------------------------------
-- Meja & denah
-- ---------------------------------------------------------------------
create table if not exists public.areas (
  name text primary key,
  sort int not null default 0
);
create table if not exists public.dining_tables (
  id          text primary key,
  location_id text not null default 'L1' references public.locations(id),
  area        text not null references public.areas(name) on update cascade,
  seats       int not null default 4 check (seats > 0),
  x           numeric(6,2),
  y           numeric(6,2),
  is_gazebo   boolean not null default false,
  active      boolean not null default true,
  sort        int not null default 0
);
comment on table public.dining_tables is 'Meja di denah Kaly Eatery. x, y = posisi pin dalam persen terhadap gambar denah.';

-- ---------------------------------------------------------------------
-- Bahan, resep, menu
-- ---------------------------------------------------------------------
create table if not exists public.items (
  id         text primary key,
  name       text not null,
  unit       text not null,
  type       text not null check (type in ('raw', 'semi')),
  category   text,
  std_cost   numeric(14,2) not null default 0,
  yield_qty  numeric(12,4),
  active     boolean not null default true,
  check (type = 'raw' or yield_qty > 0)
);
comment on table public.items is 'Bahan baku (raw) dan bahan setengah jadi (semi). std_cost = harga acuan bahan baku; HPP semi dihitung dari resepnya.';
comment on column public.items.yield_qty is 'Hasil satu batch produksi bahan setengah jadi, dalam satuan unit.';

create table if not exists public.item_bom (
  item_id      text not null references public.items(id) on delete cascade,
  component_id text not null references public.items(id),
  qty          numeric(12,4) not null check (qty > 0),
  primary key (item_id, component_id),
  check (item_id <> component_id)
);
comment on table public.item_bom is 'Resep produksi bahan setengah jadi (per satu batch).';

create table if not exists public.menu_categories (
  id      text primary key,
  name    text not null,
  color   text not null default 'slate' check (color in ('orange', 'kunyit', 'plum', 'kopi', 'kolam', 'olive', 'cabai', 'slate')),
  station text not null default 'dapur' check (station in ('dapur', 'bar', 'none')),
  sort    int not null default 0
);

create table if not exists public.menus (
  id          text primary key default public.new_id('m_'),
  name        text not null,
  category_id text references public.menu_categories(id) on update cascade on delete set null,
  price       numeric(12,0) not null default 0 check (price >= 0),
  station     text not null default 'dapur' check (station in ('dapur', 'bar', 'none')),
  prep_min    int not null default 0,
  active      boolean not null default true,
  sold_out    boolean not null default false,
  is_package  boolean not null default false,
  description text not null default '',
  tags        text[] not null default '{}',
  image_path  text,
  sort        int not null default 0,
  updated_at  timestamptz not null default now(),
  constraint menus_price_check2 check (price > 0 or sold_out or not active)
);
comment on table public.menus is 'Menu jual. Harga 0 hanya boleh untuk menu yang ditandai habis. image_path = path di bucket menu-images.';

create table if not exists public.menu_outlets (
  menu_id     text not null references public.menus(id) on delete cascade,
  location_id text not null references public.locations(id),
  primary key (menu_id, location_id)
);
create table if not exists public.menu_bom (
  menu_id text not null references public.menus(id) on delete cascade,
  item_id text not null references public.items(id),
  qty     numeric(12,4) not null check (qty > 0),
  primary key (menu_id, item_id)
);
comment on table public.menu_bom is 'Resep menu per porsi. Stok terpotong sesuai resep saat pesanan dikirim ke dapur.';
create table if not exists public.menu_package_items (
  package_id text not null references public.menus(id) on delete cascade,
  menu_id    text not null references public.menus(id),
  qty        numeric(8,2) not null check (qty > 0),
  primary key (package_id, menu_id)
);

-- ---------------------------------------------------------------------
-- Stok
-- ---------------------------------------------------------------------
create table if not exists public.stock (
  location_id text not null references public.locations(id),
  item_id     text not null references public.items(id),
  qty         numeric(14,4) not null default 0,
  avg_cost    numeric(18,6) not null default 0,
  min_qty     numeric(14,4) not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (location_id, item_id)
);
comment on table public.stock is 'Posisi stok per lokasi dengan harga rata-rata bergerak. Hanya berubah lewat fungsi server (kartu stok di stock_moves).';

create table if not exists public.stock_moves (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  location_id text not null references public.locations(id),
  item_id     text not null references public.items(id),
  qty         numeric(14,4) not null,
  unit_cost   numeric(18,6) not null default 0,
  type        text not null check (type in ('sale', 'prod-out', 'prod-in', 'po', 'tf-out', 'tf-in', 'b2b-out', 'b2b-in', 'opname', 'adjust')),
  ref         text,
  created_by  text references public.staff(id)
);
comment on table public.stock_moves is 'Kartu stok: setiap mutasi masuk (+) dan keluar (-). Tidak ada batas jumlah baris.';
create index if not exists stock_moves_item_idx on public.stock_moves (location_id, item_id, at desc);
create index if not exists stock_moves_ref_idx on public.stock_moves (ref);

create table if not exists public.productions (
  id          text primary key,
  at          timestamptz not null default now(),
  location_id text not null references public.locations(id),
  item_id     text not null references public.items(id),
  qty         numeric(14,4) not null,
  cost        numeric(14,0) not null default 0,
  is_auto     boolean not null default false,
  ref         text,
  created_by  text references public.staff(id)
);

-- ---------------------------------------------------------------------
-- Kaly Loop: tier, misi, member, poin, promo, voucher, kampanye
-- ---------------------------------------------------------------------
create table if not exists public.tiers (
  id        text primary key,
  name      text not null,
  min_spend numeric(14,0) not null default 0,
  discount  numeric(6,4) not null default 0,
  multiplier numeric(6,3) not null default 1,
  perks     text not null default '',
  sort      int not null default 0
);
create table if not exists public.missions (
  id          text primary key default public.new_id('ms'),
  name        text not null,
  description text not null default '',
  kind        text not null check (kind in ('visits', 'menu', 'cat', 'spend')),
  menu_id     text references public.menus(id) on delete set null,
  category_id text references public.menu_categories(id) on delete set null,
  target      numeric(14,0) not null check (target > 0),
  reward      int not null default 0,
  active      boolean not null default true
);
create table if not exists public.members (
  id            text primary key default public.new_id('m'),
  name          text not null default 'Pelanggan',
  phone         text not null unique check (phone ~ '^0[0-9]{8,14}$'),
  email         text not null default '',
  birthday      text not null default '' check (birthday = '' or birthday ~ '^[01][0-9]-[0-3][0-9]$'),
  points        int not null default 0 check (points >= 0),
  spend         numeric(14,0) not null default 0,
  visits        int not null default 0,
  joined_at     timestamptz not null default now(),
  last_visit_at timestamptz,
  source        text not null default 'kasir'
);
comment on table public.members is 'Member Kaly Loop. phone dinormalisasi ke format 08xxxx. birthday = MM-DD.';
create table if not exists public.member_missions (
  member_id  text not null references public.members(id) on delete cascade,
  mission_id text not null references public.missions(id) on delete cascade,
  month      text not null,
  progress   numeric(14,0) not null default 0,
  done       boolean not null default false,
  primary key (member_id, mission_id)
);
create table if not exists public.point_tx (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  member_id text not null references public.members(id) on delete cascade,
  delta     int not null,
  reason    text not null check (reason in ('welcome', 'earn', 'redeem', 'mission', 'adjust')),
  order_id  text,
  note      text,
  created_by text references public.staff(id)
);
comment on table public.point_tx is 'Riwayat perubahan poin member (audit).';

create table if not exists public.promos (
  id          text primary key default public.new_id('p'),
  name        text not null,
  type        text not null check (type in ('pct-cat', 'bxgy')),
  category_id text references public.menu_categories(id) on delete cascade,
  pct         numeric(6,4),
  menu_id     text references public.menus(id) on delete cascade,
  buy         int,
  free        int,
  from_time   time,
  to_time     time,
  days        int[] not null default '{}',
  outlets     text[],
  active      boolean not null default true,
  until       timestamptz,
  check ((type = 'pct-cat' and category_id is not null and pct > 0) or (type = 'bxgy' and menu_id is not null and buy > 0 and free > 0))
);
comment on column public.promos.days is 'Hari berlaku, 0 = Minggu … 6 = Sabtu. Kosong = setiap hari.';

create table if not exists public.campaigns (
  id         text primary key default public.new_id('c'),
  name       text not null,
  segment    jsonb not null default '{}',
  voucher_code text,
  message    text not null default '',
  reach      text[] not null default '{}',
  sent       int not null default 0,
  status     text not null default 'aktif',
  created_at timestamptz not null default now()
);
create table if not exists public.vouchers (
  code        text primary key check (code = upper(code)),
  name        text not null,
  type        text not null check (type in ('pct', 'amt')),
  value       numeric(14,4) not null check (value > 0),
  max_disc    numeric(14,0) not null default 0,
  min_spend   numeric(14,0) not null default 0,
  quota       int not null default 0,
  used        int not null default 0,
  revenue     numeric(16,0) not null default 0,
  cost        numeric(16,0) not null default 0,
  new_only    boolean not null default false,
  member_ids  text[],
  campaign_id text references public.campaigns(id) on delete set null,
  active      boolean not null default true,
  until       timestamptz
);
comment on column public.vouchers.value is 'pct: 0,15 = 15%. amt: nominal rupiah.';

-- ---------------------------------------------------------------------
-- Kartu deposit (Play Corner)
-- ---------------------------------------------------------------------
create table if not exists public.deposit_cards (
  id         text primary key,
  holder     text not null,
  phone      text not null default '',
  member_id  text references public.members(id) on delete set null,
  balance    numeric(14,0) not null default 0 check (balance >= 0),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Supplier & pembelian (Kaly Goods)
-- ---------------------------------------------------------------------
create table if not exists public.suppliers (
  id             text primary key default public.new_id('s'),
  name           text not null,
  category       text not null default '',
  phone          text not null default '',
  bank           text not null default '',
  verified_npwp  boolean not null default false,
  verified_bank  boolean not null default false,
  verified_visit boolean not null default false,
  rating         numeric(3,1) not null default 0,
  active         boolean not null default true
);
create table if not exists public.supplier_prices (
  supplier_id text not null references public.suppliers(id) on delete cascade,
  item_id     text not null references public.items(id) on delete cascade,
  price       numeric(14,2) not null check (price > 0),
  updated_at  timestamptz not null default now(),
  primary key (supplier_id, item_id)
);
create table if not exists public.item_suppliers (
  item_id             text primary key references public.items(id) on delete cascade,
  primary_supplier_id text references public.suppliers(id) on delete set null,
  backup_supplier_id  text references public.suppliers(id) on delete set null
);
create table if not exists public.purchase_orders (
  id          text primary key default public.new_id('po'),
  no          text not null unique,
  supplier_id text not null references public.suppliers(id),
  location_id text not null references public.locations(id),
  entity_id   text not null references public.entities(id),
  status      text not null default 'draft' check (status in ('draft', 'diajukan', 'disetujui', 'ditolak', 'diterima', 'dibayar')),
  is_auto     boolean not null default false,
  flags       text[] not null default '{}',
  total       numeric(16,0) not null default 0,
  created_by  text references public.staff(id),
  created_at  timestamptz not null default now(),
  approved_by text references public.staff(id),
  approved_at timestamptz,
  received_by text references public.staff(id),
  received_at timestamptz,
  invoice_no  text,
  paid_by     text references public.staff(id),
  paid_at     timestamptz,
  fee         numeric(12,0) not null default 0
);
create unique index if not exists purchase_orders_invoice_uq on public.purchase_orders (supplier_id, upper(invoice_no)) where invoice_no is not null;
create table if not exists public.purchase_order_lines (
  po_id        text not null references public.purchase_orders(id) on delete cascade,
  item_id      text not null references public.items(id),
  qty          numeric(14,4) not null check (qty > 0),
  price        numeric(14,2) not null check (price > 0),
  received_qty numeric(14,4) not null default 0,
  primary key (po_id, item_id)
);

-- Mutasi antar lokasi dalam satu entitas
create table if not exists public.transfers (
  id            text primary key default public.new_id('tf'),
  no            text not null unique,
  from_location text not null references public.locations(id),
  to_location   text not null references public.locations(id),
  status        text not null default 'dikirim' check (status in ('dikirim', 'diterima')),
  has_diff      boolean not null default false,
  created_by    text references public.staff(id),
  created_at    timestamptz not null default now(),
  received_by   text references public.staff(id),
  received_at   timestamptz,
  check (from_location <> to_location)
);
create table if not exists public.transfer_lines (
  transfer_id  text not null references public.transfers(id) on delete cascade,
  item_id      text not null references public.items(id),
  qty          numeric(14,4) not null check (qty > 0),
  unit_cost    numeric(18,6) not null default 0,
  received_qty numeric(14,4) not null default 0,
  primary key (transfer_id, item_id)
);

-- Stock opname
create table if not exists public.opnames (
  id          text primary key default public.new_id('op'),
  no          text not null unique,
  location_id text not null references public.locations(id),
  total       numeric(16,0) not null default 0,
  created_by  text references public.staff(id),
  created_at  timestamptz not null default now()
);
create table if not exists public.opname_lines (
  opname_id  text not null references public.opnames(id) on delete cascade,
  item_id    text not null references public.items(id),
  system_qty numeric(14,4) not null,
  actual_qty numeric(14,4) not null,
  diff       numeric(14,4) not null,
  value      numeric(16,0) not null,
  primary key (opname_id, item_id)
);

-- Penjualan antar entitas (Central Kitchen → Resto)
create table if not exists public.b2b_invoices (
  id            text primary key default public.new_id('b'),
  no            text not null unique,
  seller_id     text not null references public.entities(id),
  buyer_id      text not null references public.entities(id),
  from_location text not null references public.locations(id),
  to_location   text not null references public.locations(id),
  total         numeric(16,0) not null,
  cost          numeric(16,0) not null,
  status        text not null default 'belum lunas' check (status in ('belum lunas', 'lunas')),
  created_by    text references public.staff(id),
  created_at    timestamptz not null default now(),
  paid_at       timestamptz,
  check (seller_id <> buyer_id)
);
create table if not exists public.b2b_lines (
  invoice_id text not null references public.b2b_invoices(id) on delete cascade,
  item_id    text not null references public.items(id),
  qty        numeric(14,4) not null check (qty > 0),
  price      numeric(14,2) not null,
  unit_cost  numeric(18,6) not null,
  primary key (invoice_id, item_id)
);

-- ---------------------------------------------------------------------
-- Kasir: shift, pesanan, pembayaran
-- ---------------------------------------------------------------------
create table if not exists public.shifts (
  id          text primary key default public.new_id('sh'),
  staff_id    text not null references public.staff(id),
  terminal    text not null,
  location_id text not null references public.locations(id),
  open_at     timestamptz not null default now(),
  open_cash   numeric(14,0) not null default 0,
  close_at    timestamptz,
  counted     numeric(14,0),
  expected    numeric(14,0),
  variance    numeric(14,0),
  closed_by   text references public.staff(id),
  no_sale     int not null default 0
);
create unique index if not exists shifts_one_open_per_terminal on public.shifts (terminal) where close_at is null;

create table if not exists public.counters (
  location_id text not null,
  biz_day     date not null,
  prefix      text not null,
  value       int not null default 0,
  primary key (location_id, biz_day, prefix)
);
comment on table public.counters is 'Nomor urut pesanan per outlet per hari (A001, Q001, W001, P001).';

create table if not exists public.reservations (
  id          text primary key default public.new_id('r'),
  code        text not null unique,
  name        text not null,
  phone       text not null default '',
  date        date not null,
  time        time not null,
  pax         int not null check (pax > 0),
  area        text not null default '',
  table_id    text references public.dining_tables(id) on update cascade,
  join_tables text[] not null default '{}',
  status      text not null default 'menunggu' check (status in ('menunggu', 'dikonfirmasi', 'datang', 'selesai', 'batal', 'no-show')),
  source      text not null default 'web',
  note        text not null default '',
  member_id   text references public.members(id) on delete set null,
  order_id    text,
  created_at  timestamptz not null default now()
);
create index if not exists reservations_date_idx on public.reservations (date, status);

create table if not exists public.orders (
  id             text primary key default public.new_id('o'),
  no             text not null,
  biz_day        date not null default public.biz_date(),
  location_id    text not null references public.locations(id),
  channel        text not null default 'pos' check (channel in ('pos', 'qr', 'web')),
  type           text not null default 'dine' check (type in ('dine', 'take', 'deliv')),
  table_id       text references public.dining_tables(id) on update cascade,
  merged_tables  text[] not null default '{}',
  status         text not null default 'open' check (status in ('open', 'paid', 'void', 'refund')),
  kitchen_state  text not null default 'none' check (kitchen_state in ('none', 'new', 'cook', 'ready', 'served')),
  created_by     text references public.staff(id),
  terminal       text not null default '',
  customer_name  text not null default '',
  customer_phone text not null default '',
  customer_addr  text not null default '',
  distance_km    numeric(6,2),
  member_id      text references public.members(id) on delete set null,
  reservation_id text references public.reservations(id) on delete set null,
  scheduled_at   timestamptz,
  released       boolean not null default true,
  delivery_fee   numeric(12,0) not null default 0,
  delivery_status text check (delivery_status in ('menunggu', 'dijemput kurir', 'diantar', 'selesai')),
  discount       jsonb not null default '{}',
  bill           jsonb,
  total          numeric(14,0),
  paid_at        timestamptz,
  paid_by        text,
  shift_id       text references public.shifts(id),
  change_amount  numeric(14,0) not null default 0,
  tendered       numeric(14,0) not null default 0,
  earned_points  int not null default 0,
  ready_at       timestamptz,
  picked_at      timestamptz,
  void_reason    text,
  void_by        text references public.staff(id),
  void_at        timestamptz,
  split_from     text,
  merged_into    text,
  public_token   uuid not null default gen_random_uuid() unique,
  payment_pending boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (location_id, biz_day, no)
);
comment on table public.orders is 'Pesanan/bill dari kasir, QR meja, dan pesan online. bill = rincian tagihan saat lunas (sub, discs, disc, base, svc, tax, deliv, total).';
comment on column public.orders.discount is '{"voucher": "KODE", "points": 50, "manual": {"type": "pct|amt", "value": 0.2, "reason": "...", "by": "u1", "approved": true}}';
comment on column public.orders.public_token is 'Token untuk halaman lacak pesanan pelanggan (tidak bisa ditebak).';
comment on column public.orders.payment_pending is 'true = pesanan online menunggu konfirmasi payment gateway (confirm_online_payment).';
create index if not exists orders_open_idx on public.orders (location_id, status) where status = 'open';
create index if not exists orders_kitchen_idx on public.orders (location_id, kitchen_state, created_at) where kitchen_state in ('new', 'cook', 'ready');
create index if not exists orders_day_idx on public.orders (location_id, biz_day);
create index if not exists orders_member_idx on public.orders (member_id, paid_at desc);
create index if not exists orders_shift_idx on public.orders (shift_id);

create table if not exists public.order_lines (
  id             text primary key default public.new_id('l'),
  order_id       text not null references public.orders(id) on delete cascade,
  menu_id        text not null references public.menus(id),
  name           text not null default '',
  qty            numeric(10,2) not null check (qty > 0),
  price          numeric(12,0) not null default 0,
  status         text not null default 'draft' check (status in ('draft', 'new', 'cook', 'ready', 'served', 'void')),
  station        text not null default 'dapur' check (station in ('dapur', 'bar', 'none')),
  note           text not null default '',
  parent_line_id text references public.order_lines(id) on delete cascade,
  base_qty       numeric(10,2),
  is_package     boolean not null default false,
  sent_at        timestamptz,
  cook_at        timestamptz,
  ready_at       timestamptz,
  served_at      timestamptz,
  stock_deducted boolean not null default false,
  cost           numeric(14,0),
  void_reason    text,
  void_by        text references public.staff(id),
  void_at        timestamptz,
  sort           bigint generated always as identity
);
comment on table public.order_lines is 'Item pesanan. status: draft (belum dikirim) → new → cook → ready → served, atau void. Komponen paket punya parent_line_id.';
create index if not exists order_lines_order_idx on public.order_lines (order_id);

create table if not exists public.order_payments (
  id       bigint generated always as identity primary key,
  order_id text not null references public.orders(id) on delete cascade,
  method   text not null check (method in ('cash', 'qris', 'card', 'transfer', 'deposit')),
  amount   numeric(14,0) not null check (amount > 0),
  card_id  text references public.deposit_cards(id),
  ref      text
);
create index if not exists order_payments_order_idx on public.order_payments (order_id);

create table if not exists public.order_notices (
  id       bigint generated always as identity primary key,
  at       timestamptz not null default now(),
  order_id text not null references public.orders(id) on delete cascade,
  seen     boolean not null default false
);
comment on table public.order_notices is 'Notifikasi pesanan siap dari dapur untuk kasir & pramusaji.';

create table if not exists public.deposit_tx (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  card_id    text not null references public.deposit_cards(id),
  amount     numeric(14,0) not null,
  type       text not null check (type in ('topup', 'pay', 'refund', 'return')),
  method     text,
  ref        text,
  created_by text references public.staff(id),
  shift_id   text references public.shifts(id)
);

-- ---------------------------------------------------------------------
-- Pembukuan & kontrol
-- ---------------------------------------------------------------------
create table if not exists public.journals (
  id         text primary key default public.new_id('j'),
  entity_id  text not null references public.entities(id),
  at         timestamptz not null default now(),
  memo       text not null,
  ref        text,
  cash_flow  text,
  tag        text,
  created_by text references public.staff(id)
);
comment on table public.journals is 'Jurnal umum. Setiap jurnal wajib seimbang (dicek saat commit).';
comment on column public.journals.cash_flow is 'Kelompok arus kas: Penerimaan dari pelanggan, Pembayaran ke supplier, Beban operasional, dll.';
create index if not exists journals_entity_idx on public.journals (entity_id, at);
create index if not exists journals_ref_idx on public.journals (ref);

create table if not exists public.journal_lines (
  id           bigint generated always as identity primary key,
  journal_id   text not null references public.journals(id) on delete cascade,
  account_code text not null references public.accounts(code),
  debit        numeric(16,0) not null default 0 check (debit >= 0),
  credit       numeric(16,0) not null default 0 check (credit >= 0),
  check (debit = 0 or credit = 0)
);
create index if not exists journal_lines_journal_idx on public.journal_lines (journal_id);
create index if not exists journal_lines_account_idx on public.journal_lines (account_code);

create table if not exists public.fraud_flags (
  id          text primary key default public.new_id('f'),
  at          timestamptz not null default now(),
  type        text not null,
  severity    text not null default 'sedang' check (severity in ('rendah', 'sedang', 'tinggi')),
  message     text not null,
  staff_id    text references public.staff(id),
  ref         text,
  location_id text references public.locations(id),
  status      text not null default 'open' check (status in ('open', 'ok'))
);
comment on table public.fraud_flags is 'Temuan anti-fraud & kontrol: void, diskon besar, selisih kas, stok minus, PO di atas harga acuan.';
create index if not exists fraud_flags_open_idx on public.fraud_flags (status, at desc);
create index if not exists fraud_flags_ref_idx on public.fraud_flags (ref);

-- =====================================================================
-- Versi 1.1: tambahan untuk aplikasi yang tersambung ke database ini.
-- Aman dijalankan di database versi 1.0: hanya menambah kolom dan tabel yang belum ada.
-- =====================================================================
alter table public.orders add column if not exists prints int not null default 0;
alter table public.fraud_flags add column if not exists checked_by text references public.staff(id) on delete set null;
alter table public.fraud_flags add column if not exists checked_at timestamptz;
alter table public.members add column if not exists updated_at timestamptz not null default now();
create index if not exists orders_updated_idx on public.orders (updated_at);
create index if not exists orders_open_idx on public.orders (location_id) where status = 'open';
create index if not exists members_updated_idx on public.members (updated_at);
create index if not exists stock_moves_item_idx on public.stock_moves (location_id, item_id, at desc);

-- Catatan perubahan per tabel. Setiap perangkat yang sedang membuka Kaly Ops mengecek catatan ini
-- (atau menerimanya lewat realtime) untuk tahu data mana yang perlu dimuat ulang. Dibersihkan otomatis setelah 1 jam.
create table if not exists public.sync_log (
  id  bigint generated always as identity primary key,
  at  timestamptz not null default clock_timestamp(),
  tbl text not null
);
create index if not exists sync_log_at_idx on public.sync_log (at);
comment on table public.sync_log is 'Catatan tabel yang berubah, untuk sinkron antar perangkat. Isinya hanya nama tabel dan waktu.';
alter table public.settings add column if not exists qris_image text;
comment on column public.settings.qris_image is 'Path gambar QRIS statis toko di bucket menu-images. Ditampilkan ke pelanggan yang memilih bayar online.';

-- ---------------------------------------------------------------------
-- 1.2 · Notifikasi staf & meja yang menunggu dikosongkan
-- ---------------------------------------------------------------------
create table if not exists public.staff_alerts (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  kind        text not null,
  location_id text references public.locations(id) on delete set null,
  order_id    text,
  table_id    text,
  ref         text,
  title       text not null,
  detail      text not null default ''
);
create index if not exists staff_alerts_at_idx on public.staff_alerts (at desc);
create index if not exists staff_alerts_kind_ref_idx on public.staff_alerts (kind, ref);
comment on table public.staff_alerts is 'Notifikasi untuk layar staf (dengan suara): pesanan QR/online, meja sudah bayar, reservasi, PO, mutasi, stok menipis, fraud. Dihapus otomatis setelah 3 hari.';
alter table public.dining_tables add column if not exists hold_order text, add column if not exists hold_at timestamptz;

-- 1.8: cetak nota rangkap (pelanggan, salinan, slip bar, slip dapur)
alter table public.settings add column if not exists print_copies jsonb not null default '{"cust": 1, "copy": 1, "bar": 1, "dapur": 1}';
comment on column public.settings.print_copies is 'Jumlah lembar sekali cetak: cust = nota pelanggan, copy = salinan kasir, bar = slip Bar (stasiun bar: minuman & dessert), dapur = slip Dapur (stasiun dapur: main dish & snack). 0 = tidak dicetak.';
alter table public.order_lines add column if not exists slip_at timestamptz;
-- 2.0: tampilan nota (logo, nama usaha, baris alamat/kontak, outlet, kasir, member, pesan bawah, lebar kertas, ukuran huruf, QRIS)
alter table public.settings add column if not exists receipt jsonb not null default '{}';
comment on column public.settings.receipt is 'Tampilan nota: {"logo": true, "name": "", "header": "", "outlet": true, "cashier": true, "member": true, "footer": "...", "paper": 58|80, "font": "kecil|normal|besar", "qris": false}. Kunci yang kosong memakai bawaan aplikasi.';
comment on column public.order_lines.slip_at is 'Waktu item tercetak di slip Bar/Dapur. Item yang sudah tercetak tidak dicetak lagi di slip berikutnya (kecuali cetak ulang).';

-- 1.7: saklar integrasi stok Kaly Core per outlet
alter table public.locations add column if not exists core_stock boolean not null default true;
-- 1.7: notifikasi siap per item (layar dapur per item)
alter table public.order_notices add column if not exists line_id text references public.order_lines(id) on delete cascade;
comment on column public.order_notices.line_id is 'Item yang siap diantar (sejak 1.7 notifikasi dikirim per item). Kosong = notifikasi lama per pesanan.';
comment on column public.locations.core_stock is 'true = penjualan outlet ini memotong stok Bahan & Bumbu di Kaly Core (resep, HPP, menu habis otomatis). false = tidak terhubung: tidak ada potong stok, HPP penjualan, maupun menu habis karena bahan.';
comment on column public.dining_tables.hold_order is 'Bill terakhir yang sudah dibayar di meja ini. Meja tampil Sudah bayar di Denah sampai service menekan Kosongkan meja, atau bill baru dibuka di meja itu.';

-- ---------------------------------------------------------------------
-- 1.4 · Riwayat aktivitas meja (untuk laporan Aktivitas denah meja)
-- Tamu duduk, bayar, dan batal dibaca dari tabel orders; tabel ini mencatat sisanya:
-- move = pindah meja, clear = meja dikosongkan, serve = pesanan diantar ke meja.
-- ---------------------------------------------------------------------
create table if not exists public.table_events (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  location_id text not null,
  table_id    text not null,
  kind        text not null check (kind in ('move', 'clear', 'serve')),
  order_id    text,
  to_table    text,
  staff_id    text,
  qty         int not null default 0,
  detail      text not null default ''
);
create index if not exists table_events_loc_at_idx on public.table_events (location_id, at);
create index if not exists table_events_order_idx on public.table_events (order_id);
comment on table public.table_events is 'Riwayat aktivitas meja: pindah meja, meja dikosongkan (manual oleh staf atau otomatis saat bill baru dibuka), dan pesanan diantar. Dibaca laporan Aktivitas denah meja.';

-- ---------------------------------------------------------------------
-- 2.1 · Printer & stasiun cetak
-- Setiap printer = satu stasiun cetak. Perangkat yang tersambung ke printer itu (PC, laptop, tablet di bar/dapur/kasir)
-- membuka Kaly Ops sebagai stasiun, lalu mencetak antreannya otomatis. Saat kasir menekan Cetak, setiap jenis lembar
-- (nota pelanggan, salinan, slip Bar, slip Dapur) dikirim ke printer sesuai locations.print_route.
-- ---------------------------------------------------------------------
create table if not exists public.print_stations (
  id          text primary key default public.new_id('ps_'),
  name        text not null check (length(trim(name)) between 1 and 40),
  location_id text not null references public.locations(id),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
comment on table public.print_stations is 'Printer/stasiun cetak per outlet, misalnya Printer Kasir, Printer Bar, Printer Dapur. Dihapus = active false supaya riwayat cetak tetap ada.';
create table if not exists public.print_station_seen (
  station_id text primary key references public.print_stations(id) on delete cascade,
  last_seen  timestamptz not null default now(),
  staff_id   text
);
comment on table public.print_station_seen is 'Kapan perangkat stasiun cetak terakhir aktif. Dipisah dari print_stations supaya denyutnya tidak memicu sinkron ke semua perangkat.';
create table if not exists public.print_jobs (
  id          bigint generated always as identity primary key,
  station_id  text not null references public.print_stations(id) on delete cascade,
  location_id text not null references public.locations(id),
  order_id    text,
  kind        text not null check (kind in ('cust', 'copy', 'bar', 'dapur', 'test')),
  label       text not null default '',
  html        text not null check (length(html) between 1 and 1500000),
  status      text not null default 'queued' check (status in ('queued', 'printing', 'printed', 'failed', 'cancelled', 'expired')),
  created_at  timestamptz not null default now(),
  queued_at   timestamptz not null default now(),
  created_by  text,
  claimed_at  timestamptz,
  printed_at  timestamptz,
  error       text not null default ''
);
create index if not exists print_jobs_station_idx on public.print_jobs (station_id, status, id);
create index if not exists print_jobs_at_idx on public.print_jobs (created_at);
comment on table public.print_jobs is 'Antrean cetak: satu baris = satu jenis lembar (semua rangkapnya) untuk satu printer. html = isi cetakan yang sudah jadi. queued -> printing (diambil stasiun) -> printed/failed. Antrean lebih dari 6 jam tidak dicetak (expired).';
alter table public.locations add column if not exists print_route jsonb not null default '{}';
comment on column public.locations.print_route is 'Tujuan cetak per jenis lembar: {"cust": "local" | id print_stations, "copy": ..., "bar": ..., "dapur": ...}. local atau kosong = dicetak di perangkat yang menekan Cetak.';
-- 2.2: printer LAN (dicetak langsung oleh aplikasi Android Kaly Ops lewat ESC/POS ke ip:port)
alter table public.print_stations add column if not exists ip text check (ip is null or ip ~ '^[A-Za-z0-9.:-]{1,64}$');
alter table public.print_stations add column if not exists port int not null default 9100 check (port between 1 and 65535);
alter table public.print_stations add column if not exists paper int check (paper is null or paper in (58, 80));
alter table public.print_stations add column if not exists mode text not null default 'raster' check (mode in ('raster', 'escstar'));
comment on column public.print_stations.ip is 'Alamat IP printer LAN/Wi-Fi (mis. 192.168.1.31). Diisi = aplikasi Android Kaly Ops mencetak langsung ke printer ini (ESC/POS, port biasanya 9100) tanpa stasiun cetak.';
comment on column public.print_stations.paper is 'Lebar kertas printer ini dalam mm (58/80). Kosong = mengikuti Tampilan nota.';
comment on column public.print_stations.mode is 'Cara mengirim gambar ESC/POS: raster (GS v 0, umum) atau escstar (ESC *, untuk printer lama yang tidak mendukung GS v 0).';
-- 2.3: jenis sambungan printer. pc = PC/stasiun cetak (jendela cetak), lan = LAN/Wi-Fi (ip:port),
-- bt = Bluetooth (alamat MAC, printer dipasangkan di tablet), usb = USB ke tablet (vendor:produk).
alter table public.print_stations add column if not exists conn text not null default 'pc' check (conn in ('pc', 'lan', 'bt', 'usb'));
alter table public.print_stations add column if not exists bt_addr text check (bt_addr is null or bt_addr ~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$');
alter table public.print_stations add column if not exists usb_id text check (usb_id is null or usb_id ~ '^[0-9a-f]{4}:[0-9a-f]{4}$');
update public.print_stations set conn = 'lan' where conn = 'pc' and ip is not null;
comment on column public.print_stations.conn is 'Sambungan printer: pc (PC/stasiun cetak), lan (LAN/Wi-Fi lewat ip:port), bt (Bluetooth, bt_addr), usb (USB ke tablet, usb_id). lan/bt/usb dicetak langsung oleh aplikasi Android Kaly Ops.';
comment on column public.print_stations.bt_addr is 'Alamat Bluetooth printer (mis. 66:22:B3:44:55:66). Printer harus sudah dipasangkan (paired) di pengaturan Bluetooth tablet.';
comment on column public.print_stations.usb_id is 'Printer USB: vendor:produk heksadesimal (mis. 0416:5011), dicetak oleh tablet yang tersambung kabel USB/OTG.';

-- ---------------------------------------------------------------------
-- 2.4 · Notifikasi di perangkat (notifikasi sistem HP/laptop/tablet), termasuk saat aplikasi tertutup (Web Push)
-- ---------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id         bigint generated always as identity primary key,
  staff_id   text not null references public.staff(id) on delete cascade,
  endpoint   text not null unique check (endpoint ~ '^https://' and length(endpoint) <= 1000),
  p256dh     text not null check (length(p256dh) between 20 and 200),
  auth       text not null check (length(auth) between 8 and 100),
  kinds      text[] not null default '{}',
  label      text not null default '',
  created_at timestamptz not null default now(),
  last_ok    timestamptz,
  fails      int not null default 0
);
comment on table public.push_subscriptions is 'Perangkat yang mengaktifkan notifikasi saat aplikasi tertutup (Web Push). kinds = jenis notifikasi yang dipilih di perangkat itu. Dikelola lewat fungsi push_*; dikirim oleh Edge Function kaly-push.';
create table if not exists public.push_log (
  alert_id bigint primary key,
  at       timestamptz not null default now(),
  targets  int not null default 0,
  sent     int not null default 0,
  failed   int not null default 0
);
comment on table public.push_log is 'Notifikasi staf yang sudah diproses Edge Function kaly-push (mencegah kiriman ganda).';
alter table public.settings add column if not exists push_url text;
comment on column public.settings.push_url is 'Alamat Edge Function kaly-push (https://<project>.supabase.co/functions/v1/kaly-push). Kosong = notifikasi saat aplikasi tertutup belum aktif.';
alter table public.app_secrets add column if not exists vapid_public text;
alter table public.app_secrets add column if not exists vapid_private jsonb;

-- 2.8 · Model printer (lebar titik & pemotong kertas per model)
alter table public.print_stations add column if not exists model text not null default 'umum' check (model in ('umum', 'epson_t82x', 'rongta_rpp02n'));
comment on column public.print_stations.model is 'Model printer: umum, epson_t82x (80 mm, 512 titik, pemotong), rongta_rpp02n (58 mm, 384 titik, Bluetooth, tanpa pemotong).';

-- ---------------------------------------------------------------------
-- 2.9 · Anggota shift: nama petugas (kasir, service, dapur) tanpa akun login sendiri.
-- Satu akun login per perangkat/peran; nama petugas dipilih saat buka shift dan bisa diganti di akun kasir.
-- Hanya Owner/Manajer (Kaly Backoffice) yang menambah atau mengubah anggota shift.
-- ---------------------------------------------------------------------
create table if not exists public.crew (
  id          text primary key default public.new_id('cr'),
  name        text not null check (length(trim(name)) between 1 and 40),
  role        text not null check (role in ('kasir', 'service', 'dapur')),
  location_id text references public.locations(id) on delete set null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
comment on table public.crew is 'Anggota shift (nama petugas) untuk akun kasir, service, dan dapur. location_id kosong = semua outlet. Dikelola Owner di Kaly Backoffice.';
alter table public.shifts add column if not exists crew_id text references public.crew(id) on delete set null,
  add column if not exists crew_name text;
comment on column public.shifts.crew_name is 'Nama petugas shift saat ini (bisa diganti selama shift berjalan).';

-- ---------------------------------------------------------------------
-- 2.12 · Audit log: semua aktivitas akun (login/logout & setiap perubahan data oleh akun staf)
-- Diisi trigger engine.tg_audit dan fungsi audit_event; hanya Owner yang bisa membaca.
-- ---------------------------------------------------------------------
create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default clock_timestamp(),
  staff_id    text,
  staff_name  text not null default '',
  role        text not null default '',
  crew_name   text not null default '',
  device      text not null default '',
  action      text not null,
  entity      text not null default '',
  entity_id   text not null default '',
  location_id text,
  summary     text not null default '',
  data        jsonb not null default '{}'::jsonb
);
create index if not exists audit_log_at_idx on public.audit_log (at desc);
create index if not exists audit_log_staff_idx on public.audit_log (staff_id, at desc);
create index if not exists audit_log_entity_idx on public.audit_log (entity, entity_id);
-- Nama petugas & perangkat per sesi login (satu akun bisa dipakai beberapa perangkat/petugas)
create table if not exists public.audit_sessions (
  session_id text primary key,
  staff_id   text,
  crew_name  text not null default '',
  device     text not null default '',
  at         timestamptz not null default now()
);
comment on table public.audit_log is 'Audit log Kaly Ops: login/logout dan setiap tambah/ubah/hapus data oleh akun staf. Disimpan 1 tahun. Hanya Owner yang bisa membaca.';
-- 2.12 · Rahasia bersama database ↔ API Vercel (/api/push). Tidak bisa dibaca aplikasi.
alter table public.app_secrets add column if not exists push_secret text;

-- ---------------------------------------------------------------------
-- 2.13 · Refund bill (khusus Owner/Manajer). Bill yang di-refund berstatus 'refund': tidak lagi dihitung sebagai penjualan,
-- tetapi tetap tercatat di shift tempat bill itu dibayar. Uang tunai yang dikembalikan mengurangi kas shift tempat refund dilakukan.
-- ---------------------------------------------------------------------
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check check (status in ('open', 'paid', 'void', 'refund'));
alter table public.orders add column if not exists refund_at timestamptz;
alter table public.orders add column if not exists refund_by text references public.staff(id);
alter table public.orders add column if not exists refund_reason text;
alter table public.orders add column if not exists refund_shift text references public.shifts(id);
alter table public.orders add column if not exists refund_pays jsonb;
comment on column public.orders.refund_pays is 'Uang yang dikembalikan per metode: [{"m":"cash","a":50000},{"m":"deposit","a":20000,"card":"KD-0001"}]. Tunai diambil dari laci shift refund_shift (null = kas outlet di luar laci kasir).';
create index if not exists orders_refund_shift_idx on public.orders (refund_shift) where refund_shift is not null;
create index if not exists orders_paid_at_idx on public.orders (location_id, paid_at desc) where paid_at is not null;
-- Saldo kartu deposit yang dikembalikan karena refund bill
alter table public.deposit_tx drop constraint if exists deposit_tx_type_check;
alter table public.deposit_tx add constraint deposit_tx_type_check check (type in ('topup', 'pay', 'refund', 'return'));


-- =====================================================================
-- Kaly Ops · Database Supabase · 02 Mesin bisnis (schema engine)
-- ---------------------------------------------------------------------
-- Logika inti yang sama dengan aplikasi: stok + produksi otomatis, HPP, jurnal,
-- tagihan (promo, member, voucher, poin, diskon manual, pajak), kirim ke dapur,
-- status dapur, pembayaran, poin & misi member.
-- Schema "engine" tidak dibuka ke API; hanya dipanggil oleh fungsi di 03_rpc.sql.
-- =====================================================================

create schema if not exists engine;

-- Penanda bahwa perubahan berasal dari mesin (fungsi server), bukan tulis langsung dari aplikasi.
create or replace function engine.on_() returns void language sql set search_path = public as $$ select set_config('kaly.engine', 'on', true); $$;
create or replace function engine.is_on() returns boolean language sql stable set search_path = public as $$ select coalesce(current_setting('kaly.engine', true), '') = 'on'; $$;

-- Pembulatan seperti Math.round di aplikasi (setengah selalu ke atas)
create or replace function engine.jsround(x numeric) returns numeric language sql immutable set search_path = public as $$ select floor(x + 0.5); $$;
create or replace function engine.r4(x numeric) returns numeric language sql immutable set search_path = public as $$ select floor(x * 10000 + 0.5) / 10000; $$;
create or replace function engine.rp(x numeric) returns text language sql immutable set search_path = public as $$
  select case when x < 0 then '-Rp' else 'Rp' end || replace(to_char(abs(round(x)), 'FM999G999G999G999G990'), ',', '.');
$$;
create or replace function engine.norm_phone(p text) returns text language sql immutable set search_path = public as $$
  select case when d like '62%' then '0' || substr(d, 3) else d end from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) x;
$$;

create or replace function engine.cfg() returns public.settings language sql stable set search_path = public as $$ select * from settings where id = 1; $$;

-- Staf yang sedang login (null kalau anon atau service_role)
create or replace function engine.me() returns public.staff language sql stable security definer set search_path = public as $$
  select * from staff where user_id = auth.uid() and active limit 1;
$$;
create or replace function engine.require_role(roles text[]) returns public.staff language plpgsql stable security definer set search_path = public as $$
declare s public.staff;
begin
  select * into s from staff where user_id = auth.uid() and active limit 1;
  if s.id is null then raise exception 'Akses ditolak: akun ini belum terdaftar sebagai staf Kaly Ops' using errcode = '42501'; end if;
  if not (s.role = any(roles)) then raise exception 'Akses ditolak untuk peran %', s.role using errcode = '42501'; end if;
  return s;
end $$;

create or replace function engine.entity_of(p_loc text) returns text language sql stable set search_path = public as $$ select entity_id from locations where id = p_loc; $$;
create or replace function engine.pay_account(p_method text) returns text language sql immutable set search_path = public as $$
  select case p_method when 'cash' then '1101' when 'deposit' then '2103' else '1102' end;
$$;

-- ---------------------------------------------------------------------
-- Fraud & kontrol
-- ---------------------------------------------------------------------
create or replace function engine.flag(p_type text, p_sev text, p_msg text, p_staff text, p_ref text, p_loc text)
returns void language sql set search_path = public as $$
  insert into fraud_flags (type, severity, message, staff_id, ref, location_id) values (p_type, coalesce(p_sev, 'sedang'), p_msg, nullif(p_staff, ''), nullif(p_ref, ''), nullif(p_loc, ''));
$$;

-- ---------------------------------------------------------------------
-- Jurnal: baris [akun, debit, kredit]; selisih pembulatan < Rp50 dirapikan seperti aplikasi
-- ---------------------------------------------------------------------
create or replace function engine.post(p_entity text, p_memo text, p_ref text, p_cf text, p_lines jsonb, p_at timestamptz default now(), p_tag text default null, p_by text default null)
returns text language plpgsql set search_path = public as $$
declare
  v_id text; v_dr numeric := 0; v_cr numeric := 0; v_diff numeric; v_rows jsonb := '[]'::jsonb; r jsonb; i int; v_best int; v_bestv numeric;
begin
  for r in select * from jsonb_array_elements(p_lines) loop
    if engine.jsround(coalesce((r->>1)::numeric, 0)) <> 0 or engine.jsround(coalesce((r->>2)::numeric, 0)) <> 0 then
      v_rows := v_rows || jsonb_build_array(jsonb_build_array(r->>0, engine.jsround(coalesce((r->>1)::numeric, 0)), engine.jsround(coalesce((r->>2)::numeric, 0))));
    end if;
  end loop;
  if jsonb_array_length(v_rows) = 0 then return null; end if;
  select coalesce(sum((x->>1)::numeric), 0), coalesce(sum((x->>2)::numeric), 0) into v_dr, v_cr from jsonb_array_elements(v_rows) x;
  v_diff := v_dr - v_cr;
  if v_diff <> 0 and abs(v_diff) < 50 then
    v_best := null; v_bestv := -1;
    for i in 0 .. jsonb_array_length(v_rows) - 1 loop
      if v_diff > 0 and (v_rows->i->>2)::numeric > v_bestv then v_best := i; v_bestv := (v_rows->i->>2)::numeric; end if;
      if v_diff < 0 and (v_rows->i->>1)::numeric > v_bestv then v_best := i; v_bestv := (v_rows->i->>1)::numeric; end if;
    end loop;
    if v_best is not null and v_bestv > 0 then
      if v_diff > 0 then v_rows := jsonb_set(v_rows, array[v_best::text, '2'], to_jsonb((v_rows->v_best->>2)::numeric + v_diff));
      else v_rows := jsonb_set(v_rows, array[v_best::text, '1'], to_jsonb((v_rows->v_best->>1)::numeric - v_diff)); end if;
    end if;
  end if;
  insert into journals (entity_id, at, memo, ref, cash_flow, tag, created_by)
    values (p_entity, coalesce(p_at, now()), p_memo, nullif(p_ref, ''), nullif(p_cf, ''), p_tag, p_by) returning id into v_id;
  insert into journal_lines (journal_id, account_code, debit, credit)
    select v_id, x->>0, (x->>1)::numeric, (x->>2)::numeric from jsonb_array_elements(v_rows) x;
  return v_id;
end $$;

-- Setiap jurnal wajib seimbang; dicek di akhir transaksi
create or replace function engine.check_journal_balance() returns trigger language plpgsql security definer set search_path = public as $$
declare v_id text := coalesce(new.journal_id, old.journal_id); v_diff numeric;
begin
  select coalesce(sum(debit - credit), 0) into v_diff from journal_lines where journal_id = v_id;
  if v_diff <> 0 and exists (select 1 from journals where id = v_id) then
    raise exception 'Jurnal % tidak seimbang (selisih %)', v_id, v_diff;
  end if;
  return null;
end $$;
drop trigger if exists journal_lines_balanced on public.journal_lines;
create constraint trigger journal_lines_balanced after insert or update or delete on public.journal_lines
  deferrable initially deferred for each row execute function engine.check_journal_balance();

-- ---------------------------------------------------------------------
-- Stok, HPP, produksi
-- ---------------------------------------------------------------------
create or replace function engine.std_cost(p_item text, p_depth int default 0) returns numeric language plpgsql stable set search_path = public as $$
declare it public.items; v numeric := 0; b record;
begin
  select * into it from items where id = p_item;
  if it.id is null then return 0; end if;
  if it.type <> 'semi' or p_depth > 6 or not exists (select 1 from item_bom where item_id = p_item) then return it.std_cost; end if;
  for b in select component_id, qty from item_bom where item_id = p_item loop
    v := v + b.qty * engine.std_cost(b.component_id, p_depth + 1);
  end loop;
  return v / coalesce(nullif(it.yield_qty, 0), 1);
end $$;

create or replace function engine.menu_hpp(p_menu text) returns numeric language sql stable set search_path = public as $$
  select coalesce((select sum(p.qty * engine.menu_hpp(p.menu_id)) from menu_package_items p where p.package_id = p_menu), 0)
       + coalesce((select sum(b.qty * engine.std_cost(b.item_id)) from menu_bom b where b.menu_id = p_menu), 0);
$$;

-- Pastikan baris stok ada, lalu kunci untuk diubah
create or replace function engine.slot(p_loc text, p_item text) returns public.stock language plpgsql set search_path = public as $$
declare s public.stock;
begin
  -- Semua perubahan stok antre satu per satu (kunci sampai transaksi selesai), supaya dua pesanan yang memakai bahan yang sama
  -- tidak saling mengunci (deadlock) saat dikirim ke dapur bersamaan.
  perform pg_advisory_xact_lock(7316001);
  insert into stock (location_id, item_id, qty, avg_cost, min_qty) values (p_loc, p_item, 0, engine.std_cost(p_item), 0)
    on conflict (location_id, item_id) do nothing;
  select * into s from stock where location_id = p_loc and item_id = p_item for update;
  return s;
end $$;

-- Kunci bill lebih dulu sebelum mengubah itemnya, supaya urutan kunci selalu sama (bill → item) di semua fungsi
create or replace function engine.lock_order(p_order text) returns void language sql set search_path = public as $$
  select null from (select 1 from orders where id = p_order for update) x;
$$;

create or replace function engine.add_stock(p_loc text, p_item text, p_qty numeric, p_unit numeric, p_type text, p_ref text, p_by text default null)
returns void language plpgsql set search_path = public as $$
declare s public.stock; v_c numeric;
begin
  s := engine.slot(p_loc, p_item);
  if s.qty <= 0 or coalesce(s.avg_cost, 0) = 0 then v_c := p_unit;
  else v_c := (s.qty * s.avg_cost + p_qty * p_unit) / (s.qty + p_qty); end if;
  update stock set qty = engine.r4(s.qty + p_qty), avg_cost = v_c, updated_at = now() where location_id = p_loc and item_id = p_item;
  insert into stock_moves (location_id, item_id, qty, unit_cost, type, ref, created_by) values (p_loc, p_item, p_qty, p_unit, p_type, p_ref, nullif(p_by, ''));
end $$;

create or replace function engine.consume(p_loc text, p_item text, p_qty numeric, p_type text, p_ref text, p_by text default null)
returns numeric language plpgsql set search_path = public as $$
declare it public.items; s public.stock; v_need numeric; v_batch numeric; v_c numeric; v_new numeric; v_key text;
begin
  if coalesce(p_qty, 0) = 0 then return 0; end if;
  select * into it from items where id = p_item;
  if it.id is null then return 0; end if;
  s := engine.slot(p_loc, p_item);
  if it.type = 'semi' and exists (select 1 from item_bom where item_id = p_item) and (engine.cfg()).auto_produce
     and s.qty < p_qty - 1e-9 and p_type not in ('b2b-out', 'tf-out', 'opname') then
    v_need := p_qty - greatest(0, s.qty);
    v_batch := coalesce(nullif(it.yield_qty, 0), 1);
    perform engine.produce(p_loc, p_item, ceil(v_need / v_batch - 1e-9) * v_batch, true, p_ref, p_by);
    select * into s from stock where location_id = p_loc and item_id = p_item for update;
  end if;
  v_c := case when s.avg_cost > 0 then s.avg_cost else engine.std_cost(p_item) end;
  v_new := engine.r4(s.qty - p_qty);
  update stock set qty = v_new, updated_at = now() where location_id = p_loc and item_id = p_item;
  insert into stock_moves (location_id, item_id, qty, unit_cost, type, ref, created_by) values (p_loc, p_item, -p_qty, v_c, p_type, p_ref, nullif(p_by, ''));
  -- Stok tercatat di bawah nol: tandai sekali per bahan per hari supaya dicek fisik
  if v_new < -1e-9 and s.qty >= -1e-9 then
    v_key := 'minus:' || p_loc || ':' || p_item || ':' || public.biz_date()::text;
    if not exists (select 1 from fraud_flags where ref = v_key) then
      perform engine.flag('Stok minus', 'sedang',
        it.name || ' di ' || coalesce((select name from locations where id = p_loc), p_loc) || ' tercatat minus ' || replace(rtrim(rtrim(to_char(abs(v_new), 'FM999999990.0000'), '0'), '.'), '.', ',') || ' ' || it.unit
        || ' setelah ' || coalesce(nullif(p_ref, ''), p_type) || '. Cek stok fisik atau catat penerimaan barang yang belum diinput.', p_by, v_key, p_loc);
    end if;
  end if;
  return p_qty * v_c;
end $$;

create or replace function engine.produce(p_loc text, p_semi text, p_qty numeric, p_auto boolean, p_ref text, p_by text default null)
returns numeric language plpgsql set search_path = public as $$
declare it public.items; v_f numeric; v_no text; v_cost numeric := 0; b record;
begin
  select * into it from items where id = p_semi;
  if it.id is null or it.type <> 'semi' then raise exception 'Bahan % bukan bahan setengah jadi', p_semi; end if;
  v_f := p_qty / coalesce(nullif(it.yield_qty, 0), 1);
  v_no := 'PRD-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  for b in select component_id, qty from item_bom where item_id = p_semi order by component_id loop
    v_cost := v_cost + engine.consume(p_loc, b.component_id, b.qty * v_f, 'prod-out', v_no, p_by);
  end loop;
  perform engine.add_stock(p_loc, p_semi, p_qty, case when p_qty <> 0 then v_cost / p_qty else 0 end, 'prod-in', v_no, p_by);
  insert into productions (id, location_id, item_id, qty, cost, is_auto, ref, created_by)
    values (v_no, p_loc, p_semi, p_qty, engine.jsround(v_cost), coalesce(p_auto, false), nullif(p_ref, ''), nullif(p_by, ''));
  return v_cost;
end $$;

-- ---------------------------------------------------------------------
-- Penjaga stok: porsi yang masih bisa dibuat dari stok outlet
-- (bahan setengah jadi = stoknya + batch utuh yang masih bisa diproduksi dari bahan bakunya)
-- ---------------------------------------------------------------------
create or replace function engine.item_avail(p_loc text, p_item text, p_depth int default 0) returns numeric language plpgsql stable set search_path = public as $$
declare it public.items; v_have numeric; v_batches numeric := null; b record; v_n numeric;
begin
  select * into it from items where id = p_item;
  select greatest(0, coalesce((select qty from stock where location_id = p_loc and item_id = p_item), 0)) into v_have;
  if it.type = 'semi' and (engine.cfg()).auto_produce and p_depth < 4 and exists (select 1 from item_bom where item_id = p_item) then
    for b in select component_id, qty from item_bom where item_id = p_item loop
      v_n := floor(engine.item_avail(p_loc, b.component_id, p_depth + 1) / b.qty + 1e-9);
      v_batches := least(coalesce(v_batches, v_n), v_n);
    end loop;
    return v_have + coalesce(v_batches, 0) * coalesce(nullif(it.yield_qty, 0), 1);
  end if;
  return v_have;
end $$;

-- Outlet terhubung ke stok Kaly Core? (Pengaturan > Integrasi Kaly Core)
create or replace function engine.core_on(p_loc text) returns boolean language sql stable set search_path = public as $$
  select coalesce((select core_stock from locations where id = p_loc), true);
$$;

-- Porsi tersedia (null = tidak terbatas, misalnya menu tanpa resep atau outlet tidak terhubung Kaly Core)
create or replace function engine.menu_portions(p_menu text, p_loc text) returns numeric language plpgsql stable set search_path = public as $$
declare v numeric := null; v_n numeric; r record;
begin
  if not engine.core_on(p_loc) then return null; end if;
  if exists (select 1 from menu_package_items where package_id = p_menu) then
    for r in select menu_id, qty from menu_package_items where package_id = p_menu loop
      v_n := floor(coalesce(engine.menu_portions(r.menu_id, p_loc), 1e9) / r.qty + 1e-9);
      v := least(coalesce(v, v_n), v_n);
    end loop;
    return v;
  end if;
  for r in select item_id, qty from menu_bom where menu_id = p_menu and qty > 0 loop
    v_n := floor(engine.item_avail(p_loc, r.item_id) / r.qty + 1e-9);
    v := least(coalesce(v, v_n), v_n);
  end loop;
  return v;
end $$;
create or replace function engine.menu_limit_item(p_menu text, p_loc text) returns text language sql stable set search_path = public as $$
  select i.name from menu_bom b join items i on i.id = b.item_id where b.menu_id = p_menu and b.qty > 0
  order by floor(engine.item_avail(p_loc, b.item_id) / b.qty + 1e-9), b.item_id limit 1;
$$;

-- Alasan menu tidak bisa dipesan di outlet: null | 'nonaktif' | 'habis' | 'harga' | 'bahan'
create or replace function engine.menu_block(p_menu text, p_loc text) returns text language plpgsql stable set search_path = public as $$
declare m public.menus;
begin
  select * into m from menus where id = p_menu;
  if m.id is null or not m.active or (exists (select 1 from menu_outlets where menu_id = p_menu) and not exists (select 1 from menu_outlets where menu_id = p_menu and location_id = p_loc)) then return 'nonaktif'; end if;
  if m.sold_out then return 'habis'; end if;
  if m.price <= 0 then return 'harga'; end if;
  if (engine.cfg()).stock_guard and coalesce(engine.menu_portions(p_menu, p_loc), 1e9) < 1 then return 'bahan'; end if;
  return null;
end $$;

-- ---------------------------------------------------------------------
-- Pesanan
-- ---------------------------------------------------------------------
create or replace function engine.next_no(p_loc text, p_prefix text) returns text language plpgsql set search_path = public as $$
declare v int;
begin
  insert into counters (location_id, biz_day, prefix, value) values (p_loc, public.biz_date(), p_prefix, 1)
    on conflict (location_id, biz_day, prefix) do update set value = counters.value + 1
    returning value into v;
  return p_prefix || lpad(v::text, 3, '0');
end $$;
create or replace function engine.order_prefix(p_channel text, p_loc text) returns text language sql immutable set search_path = public as $$
  select case when p_channel = 'qr' then 'Q' when p_channel = 'web' then 'W' when p_loc = 'L2' then 'P' else 'A' end;
$$;

create or replace function engine.kitchen_state(p_order text) returns text language sql stable set search_path = public as $$
  select case
    when count(*) = 0 then 'none'
    when bool_and(status = 'served') then 'served'
    when bool_and(status in ('ready', 'served')) then 'ready'
    when bool_or(status in ('cook', 'ready', 'served')) then 'cook'
    else 'new' end
  from order_lines where order_id = p_order and station <> 'none' and not is_package and status not in ('void', 'draft');
$$;

-- Semua item pesanan siap: catat waktunya (untuk Lounge). Notifikasi ke pramusaji dikirim per item (engine.line_ready).
create or replace function engine.check_ready(p_order text) returns void language plpgsql set search_path = public as $$
begin
  if engine.kitchen_state(p_order) = 'ready' and exists (select 1 from orders where id = p_order and ready_at is null) then
    update orders set ready_at = now() where id = p_order;
  end if;
end $$;

-- Satu item siap di dapur/bar: beri tahu pramusaji & kasir supaya item itu langsung diantar
create or replace function engine.line_ready(p_line text) returns void language plpgsql set search_path = public as $$
begin
  insert into order_notices (order_id, line_id)
    select order_id, id from order_lines where id = p_line and status = 'ready' and station <> 'none' and not is_package
      and not exists (select 1 from order_notices n where n.line_id = p_line and not n.seen);
end $$;

-- Tambah item ke pesanan (dipakai halaman pesan pelanggan & split bill). Paket otomatis dipecah ke komponennya.
create or replace function engine.add_line(p_order text, p_menu text, p_qty numeric, p_note text default '') returns text language plpgsql set search_path = public as $$
declare m public.menus; o public.orders; v_id text; v_ex text; v_draft numeric; c record;
begin
  select * into o from orders where id = p_order;
  select * into m from menus where id = p_menu;
  if m.id is null or m.sold_out or m.price <= 0 then return null; end if;
  if (engine.cfg()).stock_guard then
    select coalesce(sum(qty), 0) into v_draft from order_lines where order_id = p_order and menu_id = p_menu and status = 'draft' and parent_line_id is null;
    if coalesce(engine.menu_portions(p_menu, o.location_id), 1e9) < v_draft + p_qty then return null; end if;
  end if;
  if not m.is_package then
    select id into v_ex from order_lines where order_id = p_order and menu_id = p_menu and status = 'draft' and note = coalesce(p_note, '') and parent_line_id is null and not is_package limit 1;
    if v_ex is not null then update order_lines set qty = qty + p_qty where id = v_ex; return v_ex; end if;
  end if;
  insert into order_lines (order_id, menu_id, name, qty, price, status, station, note, is_package)
    values (p_order, p_menu, m.name, p_qty, m.price, 'draft', case when m.is_package then 'none' else m.station end, coalesce(p_note, ''), m.is_package)
    returning id into v_id;
  if m.is_package then
    for c in select p.menu_id, p.qty, mm.name, mm.station from menu_package_items p join menus mm on mm.id = p.menu_id where p.package_id = p_menu loop
      insert into order_lines (order_id, menu_id, name, qty, price, status, station, parent_line_id, base_qty)
        values (p_order, c.menu_id, c.name, c.qty * p_qty, 0, 'draft', c.station, v_id, c.qty);
    end loop;
  end if;
  return v_id;
end $$;

-- Potong stok sesuai resep untuk item yang baru dikirim + jurnal HPP
create or replace function engine.deduct_lines(p_order text, p_by text default null) returns numeric language plpgsql set search_path = public as $$
declare o public.orders; l record; v_c numeric; v_total numeric := 0; b record;
begin
  select * into o from orders where id = p_order;
  -- Outlet tidak terhubung Kaly Core: item ditandai selesai tanpa potong stok & tanpa HPP (cost null = tidak dihitung)
  if not engine.core_on(o.location_id) then
    update order_lines set stock_deducted = true, cost = null where order_id = p_order and not stock_deducted and status not in ('draft', 'void');
    return 0;
  end if;
  for l in select ol.*, m.is_package as m_pkg, m.id as m_id from order_lines ol left join menus m on m.id = ol.menu_id
           where ol.order_id = p_order and not ol.stock_deducted and ol.status not in ('draft', 'void') order by ol.sort loop
    if l.m_id is null or l.is_package then
      update order_lines set stock_deducted = true, cost = 0 where id = l.id;
      continue;
    end if;
    v_c := 0;
    for b in select item_id, qty from menu_bom where menu_id = l.menu_id order by item_id loop
      v_c := v_c + engine.consume(o.location_id, b.item_id, b.qty * l.qty, 'sale', o.no, p_by);
    end loop;
    update order_lines set stock_deducted = true, cost = engine.jsround(v_c) where id = l.id;
    v_total := v_total + v_c;
  end loop;
  if v_total > 0 then
    perform engine.post(engine.entity_of(o.location_id), 'HPP ' || o.no, o.id, null, jsonb_build_array(jsonb_build_array('5101', v_total, 0), jsonb_build_array('1201', 0, v_total)), now(), null, p_by);
  end if;
  return v_total;
end $$;

-- Kirim item draft ke dapur (item tanpa proses dapur langsung "served"); kembalikan jumlah item dapur
create or replace function engine.send_lines(p_order text, p_by text default null) returns int language plpgsql set search_path = public as $$
declare v_n int;
begin
  with u as (
    update order_lines set sent_at = now(), status = case when is_package or station = 'none' then 'served' else 'new' end
      where order_id = p_order and status = 'draft' returning status
  ) select count(*) filter (where status = 'new') into v_n from u;
  if v_n > 0 then update orders set ready_at = null where id = p_order; end if;
  update orders set released = true where id = p_order;
  perform engine.deduct_lines(p_order, p_by);
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- Promo, voucher, member
-- ---------------------------------------------------------------------
create or replace function engine.promo_active(p public.promos, p_at timestamptz) returns boolean language plpgsql stable set search_path = public as $$
declare v_local timestamp := public.biz_ts(p_at);
begin
  if not p.active then return false; end if;
  if coalesce(array_length(p.days, 1), 0) > 0 and not (extract(dow from v_local)::int = any(p.days)) then return false; end if;
  if p.from_time is not null and p.to_time is not null and (v_local::time < p.from_time or v_local::time >= p.to_time) then return false; end if;
  if p.until is not null and p_at > p.until then return false; end if;
  return true;
end $$;

create or replace function engine.tier_of(p_spend numeric) returns public.tiers language sql stable set search_path = public as $$
  select * from tiers order by (coalesce(p_spend, 0) >= min_spend) desc, case when coalesce(p_spend, 0) >= min_spend then -min_spend else min_spend end limit 1;
$$;

-- {ok, msg, code, type, value, max_disc}
create or replace function engine.voucher_check(p_code text, p_sub numeric, p_member text, p_at timestamptz default now()) returns jsonb language plpgsql stable set search_path = public as $$
declare v public.vouchers; m public.members;
begin
  select * into v from vouchers where code = upper(trim(coalesce(p_code, '')));
  if v.code is null then return jsonb_build_object('ok', false, 'msg', 'Kode voucher tidak ditemukan'); end if;
  if not v.active then return jsonb_build_object('ok', false, 'msg', 'Voucher tidak aktif'); end if;
  if v.until is not null and p_at > v.until then return jsonb_build_object('ok', false, 'msg', 'Voucher sudah kedaluwarsa'); end if;
  if v.quota > 0 and v.used >= v.quota then return jsonb_build_object('ok', false, 'msg', 'Kuota voucher sudah habis'); end if;
  if v.min_spend > 0 and p_sub < v.min_spend then return jsonb_build_object('ok', false, 'msg', 'Minimal belanja ' || engine.rp(v.min_spend)); end if;
  if coalesce(array_length(v.member_ids, 1), 0) > 0 and not (coalesce(p_member, '') = any(v.member_ids)) then
    return jsonb_build_object('ok', false, 'msg', 'Voucher ini khusus member tertentu. Hubungkan member dulu.');
  end if;
  if v.new_only and p_member is not null then
    select * into m from members where id = p_member;
    if m.id is not null and m.visits > 0 then return jsonb_build_object('ok', false, 'msg', 'Voucher khusus kunjungan pertama'); end if;
  end if;
  return jsonb_build_object('ok', true, 'code', v.code, 'type', v.type, 'value', v.value, 'max_disc', v.max_disc);
end $$;

-- Rincian tagihan pesanan, sama dengan bill() di aplikasi
create or replace function engine.compute_bill(p_order text, p_at timestamptz default null) returns jsonb language plpgsql stable set search_path = public as $$
declare
  o public.orders; s public.settings := engine.cfg(); p public.promos; t public.tiers; mem public.members;
  v_at timestamptz; v_sub numeric; v_base numeric; v_q numeric; v_free numeric; v_run numeric; v_a numeric; v_disc numeric; v_svc numeric; v_tax numeric;
  v_discs jsonb := '[]'::jsonb; v_chk jsonb; v_md jsonb; v_pts numeric;
begin
  select * into o from orders where id = p_order;
  if o.id is null then return null; end if;
  if o.status in ('paid', 'refund') and o.bill is not null then return o.bill; end if;
  v_at := coalesce(p_at, o.created_at, now());
  select coalesce(sum(qty * price), 0) into v_sub from order_lines where order_id = p_order and status <> 'void' and parent_line_id is null;
  for p in select * from promos order by id loop
    continue when not engine.promo_active(p, v_at);
    continue when p.outlets is not null and not (o.location_id = any(p.outlets));
    if p.type = 'pct-cat' then
      select coalesce(sum(l.qty * l.price), 0) into v_base from order_lines l join menus m on m.id = l.menu_id
        where l.order_id = p_order and l.status <> 'void' and l.parent_line_id is null and not l.is_package and m.category_id = p.category_id;
      if v_base > 0 then v_discs := v_discs || jsonb_build_object('label', p.name, 'amt', engine.jsround(v_base * p.pct), 'kind', 'promo', 'id', p.id); end if;
    elsif p.type = 'bxgy' then
      select coalesce(sum(qty), 0) into v_q from order_lines where order_id = p_order and status <> 'void' and parent_line_id is null and menu_id = p.menu_id;
      v_free := floor(v_q / (p.buy + p.free)) * p.free;
      if v_free > 0 then v_discs := v_discs || jsonb_build_object('label', p.name, 'amt', v_free * coalesce((select price from menus where id = p.menu_id), 0), 'kind', 'promo', 'id', p.id); end if;
    end if;
  end loop;
  select coalesce(sum((d->>'amt')::numeric), 0) into v_a from jsonb_array_elements(v_discs) d;
  v_run := greatest(0, v_sub - v_a);
  if o.member_id is not null then
    select * into mem from members where id = o.member_id;
    if mem.id is not null then
      t := engine.tier_of(mem.spend);
      if t.discount > 0 and v_run > 0 then
        v_a := engine.jsround(v_run * t.discount);
        v_discs := v_discs || jsonb_build_object('label', 'Diskon member ' || t.name || ' ' || engine.jsround(t.discount * 100)::int || '%', 'amt', v_a, 'kind', 'member');
        v_run := v_run - v_a;
      end if;
    end if;
  end if;
  if coalesce(o.discount->>'voucher', '') <> '' then
    v_chk := engine.voucher_check(o.discount->>'voucher', v_sub, o.member_id, v_at);
    if (v_chk->>'ok')::boolean then
      v_a := case when v_chk->>'type' = 'pct' then v_run * (v_chk->>'value')::numeric else (v_chk->>'value')::numeric end;
      if (v_chk->>'max_disc')::numeric > 0 then v_a := least(v_a, (v_chk->>'max_disc')::numeric); end if;
      v_a := least(engine.jsround(v_a), v_run);
      v_discs := v_discs || jsonb_build_object('label', 'Voucher ' || (v_chk->>'code'), 'amt', v_a, 'kind', 'voucher', 'code', v_chk->>'code');
      v_run := v_run - v_a;
    end if;
  end if;
  v_pts := coalesce((o.discount->>'points')::numeric, 0);
  if v_pts > 0 then
    v_a := least(v_pts * s.point_value, v_run);
    v_discs := v_discs || jsonb_build_object('label', 'Tukar ' || v_pts::int || ' poin', 'amt', v_a, 'kind', 'points');
    v_run := v_run - v_a;
  end if;
  v_md := o.discount->'manual';
  if v_md is not null and jsonb_typeof(v_md) = 'object' then
    v_a := case when v_md->>'type' = 'pct' then v_run * (v_md->>'value')::numeric else (v_md->>'value')::numeric end;
    v_a := least(engine.jsround(v_a), v_run);
    if v_a > 0 then
      v_discs := v_discs || jsonb_build_object('label', 'Diskon manual' || case when v_md->>'type' = 'pct' then ' ' || engine.jsround((v_md->>'value')::numeric * 100)::int || '%' else '' end, 'amt', v_a, 'kind', 'manual');
      v_run := v_run - v_a;
    end if;
  end if;
  v_disc := v_sub - v_run;
  v_svc := engine.jsround(v_run * s.service_rate);
  v_tax := engine.jsround((v_run + v_svc) * s.tax_rate);
  return jsonb_build_object('sub', v_sub, 'discs', v_discs, 'disc', v_disc, 'base', v_run, 'svc', v_svc, 'tax', v_tax, 'deliv', o.delivery_fee,
                            'total', v_run + v_svc + v_tax + o.delivery_fee);
end $$;

-- Progres misi member setelah pesanan lunas; kembalikan misi yang baru selesai
create or replace function engine.update_missions(p_member text, p_order text) returns jsonb language plpgsql set search_path = public as $$
declare ms public.missions; st public.member_missions; v_month text := to_char(public.biz_date(), 'YYYY-MM'); v_inc numeric; v_done jsonb := '[]'::jsonb; v_total numeric;
begin
  select total into v_total from orders where id = p_order;
  for ms in select * from missions where active order by id loop
    insert into member_missions (member_id, mission_id, month) values (p_member, ms.id, v_month) on conflict do nothing;
    select * into st from member_missions where member_id = p_member and mission_id = ms.id for update;
    if st.month <> v_month then
      update member_missions set month = v_month, progress = 0, done = false where member_id = p_member and mission_id = ms.id;
      st.progress := 0; st.done := false;
    end if;
    continue when st.done;
    v_inc := case ms.kind
      when 'visits' then 1
      when 'menu' then (select coalesce(sum(qty), 0) from order_lines where order_id = p_order and status <> 'void' and not is_package and menu_id = ms.menu_id)
      when 'cat' then (select coalesce(sum(l.qty), 0) from order_lines l join menus m on m.id = l.menu_id where l.order_id = p_order and l.status <> 'void' and not l.is_package and m.category_id = ms.category_id)
      when 'spend' then coalesce(v_total, 0) else 0 end;
    update member_missions set progress = progress + v_inc where member_id = p_member and mission_id = ms.id;
    if st.progress + v_inc >= ms.target then
      update member_missions set done = true where member_id = p_member and mission_id = ms.id;
      update members set points = points + ms.reward where id = p_member;
      insert into point_tx (member_id, delta, reason, order_id, note) values (p_member, ms.reward, 'mission', p_order, ms.name);
      v_done := v_done || jsonb_build_object('id', ms.id, 'name', ms.name, 'reward', ms.reward);
    end if;
  end loop;
  return v_done;
end $$;

-- ---------------------------------------------------------------------
-- Pembayaran (sama dengan settle() di aplikasi)
-- p_pays: [{"m": "cash|qris|card|transfer|deposit", "a": 50000, "card": "KD-0001"}]
-- ---------------------------------------------------------------------
create or replace function engine.settle(p_order text, p_pays jsonb, p_by text, p_shift text, p_send boolean default true, p_tendered numeric default 0)
returns jsonb language plpgsql set search_path = public as $$
declare
  o public.orders; b jsonb; v_total numeric; v_noncash numeric; v_cashgiven numeric; v_cashnet numeric; v_change numeric; p jsonb; c public.deposit_cards;
  v_norm jsonb := '[]'::jsonb; v_lines jsonb := '[]'::jsonb; r record; mem public.members; t public.tiers; v_earned int := 0; v_missions jsonb := '[]'::jsonb; v_vd jsonb; v_pts int;
  s public.settings := engine.cfg();
begin
  select * into o from orders where id = p_order for update;
  if o.id is null then return jsonb_build_object('ok', false, 'msg', 'Pesanan tidak ditemukan'); end if;
  if o.status <> 'open' then return jsonb_build_object('ok', false, 'msg', 'Pesanan ini sudah ' || case o.status when 'paid' then 'lunas' else 'dibatalkan' end); end if;
  b := engine.compute_bill(p_order, o.created_at);
  v_total := (b->>'total')::numeric;
  select coalesce(sum((x->>'a')::numeric), 0) into v_noncash from jsonb_array_elements(coalesce(p_pays, '[]')) x where x->>'m' <> 'cash';
  if v_noncash > v_total then return jsonb_build_object('ok', false, 'msg', 'Pembayaran non-tunai melebihi total tagihan'); end if;
  select coalesce(sum((x->>'a')::numeric), 0) into v_cashgiven from jsonb_array_elements(coalesce(p_pays, '[]')) x where x->>'m' = 'cash';
  if v_noncash + v_cashgiven < v_total then return jsonb_build_object('ok', false, 'msg', 'Pembayaran kurang ' || engine.rp(v_total - v_noncash - v_cashgiven)); end if;
  for p in select * from jsonb_array_elements(coalesce(p_pays, '[]')) loop
    if p->>'m' not in ('cash', 'qris', 'card', 'transfer', 'deposit') then return jsonb_build_object('ok', false, 'msg', 'Metode bayar tidak dikenal: ' || coalesce(p->>'m', '')); end if;
    if p->>'m' = 'deposit' then
      select * into c from deposit_cards where id = p->>'card' for update;
      if c.id is null or not c.active then return jsonb_build_object('ok', false, 'msg', 'Kartu deposit tidak ditemukan atau nonaktif'); end if;
      if c.balance < (p->>'a')::numeric then return jsonb_build_object('ok', false, 'msg', 'Saldo kartu ' || c.id || ' kurang (' || engine.rp(c.balance) || ')'); end if;
    end if;
    if p->>'m' <> 'cash' and (p->>'a')::numeric > 0 then v_norm := v_norm || p; end if;
  end loop;
  v_pts := coalesce((o.discount->>'points')::int, 0);
  if v_pts > 0 then
    select * into mem from members where id = o.member_id;
    if mem.id is null or mem.points < v_pts then return jsonb_build_object('ok', false, 'msg', 'Poin member tidak cukup untuk ditukar'); end if;
  end if;
  v_cashnet := v_total - v_noncash;
  if v_cashnet > 0 then v_norm := v_norm || jsonb_build_object('m', 'cash', 'a', v_cashnet); end if;
  v_change := greatest(0, v_cashgiven - v_cashnet);
  update orders set bill = b, total = v_total, status = 'paid', paid_at = now(), paid_by = coalesce(p_by, 'online'), shift_id = p_shift,
                    change_amount = v_change, tendered = case when coalesce(p_tendered, 0) > 0 then p_tendered else v_cashgiven end, updated_at = now()
    where id = p_order;
  -- Meja dine-in tetap tampil terisi (Sudah bayar) sampai service mengosongkannya di Denah
  if o.type = 'dine' and o.table_id is not null then
    update dining_tables set hold_order = p_order, hold_at = now() where id = o.table_id or id = any(o.merged_tables);
    if p_shift is not null then  -- dibayar di kasir (bukan pembayaran online di muka)
      perform engine.alert('table_paid', o.location_id, 'Meja ' || array_to_string(array[o.table_id] || o.merged_tables, ' + ') || ' sudah dibayar',
                           'Bill ' || o.no || '. Kosongkan meja di Denah setelah tamu pergi dan meja dibersihkan.', p_order, o.table_id);
    end if;
  end if;
  insert into order_payments (order_id, method, amount, card_id)
    select p_order, x->>'m', (x->>'a')::numeric, x->>'card' from jsonb_array_elements(v_norm) x;
  if p_send then perform engine.send_lines(p_order, p_by); end if;
  -- Jurnal penjualan
  for r in select engine.pay_account(x->>'m') as acc, sum((x->>'a')::numeric) as amt from jsonb_array_elements(v_norm) x group by 1 order by 1 loop
    v_lines := v_lines || jsonb_build_array(jsonb_build_array(r.acc, r.amt, 0));
  end loop;
  if (b->>'disc')::numeric > 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_array('4201', (b->>'disc')::numeric, 0)); end if;
  v_lines := v_lines || jsonb_build_array(jsonb_build_array('4101', 0, (b->>'sub')::numeric));
  if (b->>'tax')::numeric > 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_array('2104', 0, (b->>'tax')::numeric)); end if;
  if (b->>'svc')::numeric + (b->>'deliv')::numeric > 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_array('4103', 0, (b->>'svc')::numeric + (b->>'deliv')::numeric)); end if;
  perform engine.post(engine.entity_of(o.location_id), 'Penjualan ' || o.no, o.id, 'Penerimaan dari pelanggan', v_lines, now(), null, p_by);
  -- Kartu deposit
  for p in select * from jsonb_array_elements(v_norm) loop
    if p->>'m' = 'deposit' then
      update deposit_cards set balance = balance - (p->>'a')::numeric where id = p->>'card';
      insert into deposit_tx (card_id, amount, type, ref, created_by, shift_id) values (p->>'card', (p->>'a')::numeric, 'pay', o.no, p_by, p_shift);
    end if;
  end loop;
  -- Voucher
  select d into v_vd from jsonb_array_elements(b->'discs') d where d->>'kind' = 'voucher' limit 1;
  if v_vd is not null then
    update vouchers set used = used + 1, revenue = revenue + v_total, cost = cost + (v_vd->>'amt')::numeric where code = v_vd->>'code';
  end if;
  -- Member: poin & misi
  if o.member_id is not null then
    select * into mem from members where id = o.member_id for update;
    if mem.id is not null then
      t := engine.tier_of(mem.spend);
      if v_pts > 0 then
        update members set points = greatest(0, points - v_pts) where id = mem.id;
        insert into point_tx (member_id, delta, reason, order_id, created_by) values (mem.id, -v_pts, 'redeem', o.id, p_by);
      end if;
      v_earned := floor(((b->>'base')::numeric / s.points_per) * coalesce(t.multiplier, 1));
      update members set points = points + v_earned, spend = spend + v_total, visits = visits + 1, last_visit_at = now() where id = mem.id;
      if v_earned > 0 then insert into point_tx (member_id, delta, reason, order_id, created_by) values (mem.id, v_earned, 'earn', o.id, p_by); end if;
      v_missions := engine.update_missions(mem.id, o.id);
      update orders set earned_points = v_earned where id = o.id;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'bill', b, 'change', v_change, 'earned', v_earned, 'missions', v_missions, 'no', o.no);
end $$;

-- Pola void berulang: 3 pembatalan oleh orang yang sama dalam 8 jam
create or replace function engine.void_pattern(p_staff text, p_loc text) returns void language plpgsql set search_path = public as $$
declare v_n int; v_name text;
begin
  select count(*) into v_n from fraud_flags where staff_id = p_staff and at > now() - interval '8 hours' and type like 'Void%';
  if v_n = 3 then
    select name into v_name from staff where id = p_staff;
    perform engine.flag('Pola void berulang', 'tinggi', coalesce(v_name, p_staff) || ' melakukan ' || v_n || ' pembatalan dalam 8 jam terakhir.', p_staff, null, p_loc);
  end if;
end $$;

-- Ringkasan shift kasir
create or replace function engine.shift_summary(p_shift text) returns jsonb language plpgsql stable set search_path = public as $$
declare sh public.shifts; v_by jsonb; v_cash numeric; v_top numeric; v_ref numeric; v_count int; v_total numeric; v_disc numeric; v_voids int;
  v_rn int; v_rtot numeric; v_rcash numeric; v_rlater int; v_rlater_tot numeric;
begin
  select * into sh from shifts where id = p_shift;
  -- 2.13: bill yang kemudian di-refund tetap dihitung di shift tempat ia dibayar (uangnya memang masuk laci saat itu)
  select count(*), coalesce(sum(total), 0), coalesce(sum((bill->>'disc')::numeric), 0) into v_count, v_total, v_disc from orders where shift_id = p_shift and status in ('paid', 'refund');
  select coalesce(jsonb_object_agg(method, amt), '{}'::jsonb) into v_by from (select p.method, sum(p.amount) amt from order_payments p join orders o on o.id = p.order_id where o.shift_id = p_shift and o.status in ('paid', 'refund') group by p.method) x;
  v_cash := coalesce((v_by->>'cash')::numeric, 0);
  select coalesce(sum(amount) filter (where type = 'topup' and method = 'cash'), 0), coalesce(sum(amount) filter (where type = 'refund'), 0) into v_top, v_ref from deposit_tx where shift_id = p_shift;
  select count(*) into v_voids from orders where status = 'void' and void_by = sh.staff_id and void_at >= sh.open_at and (sh.close_at is null or void_at <= sh.close_at);
  -- 2.13: refund bill yang uang tunainya diambil dari laci shift ini
  select count(*), coalesce(sum(total), 0),
         coalesce(sum((select coalesce(sum((x->>'a')::numeric), 0) from jsonb_array_elements(coalesce(refund_pays, '[]'::jsonb)) x where x->>'m' = 'cash')), 0)
    into v_rn, v_rtot, v_rcash from orders where refund_shift = p_shift and status = 'refund';
  select count(*), coalesce(sum(total), 0) into v_rlater, v_rlater_tot from orders where shift_id = p_shift and status = 'refund';
  return jsonb_build_object('count', v_count, 'total', v_total, 'disc', v_disc, 'by', v_by, 'top_cash', v_top, 'refund_cash', v_ref,
                            'refunds', v_rn, 'refund_total', v_rtot, 'refund_bill_cash', v_rcash, 'refunded_later', v_rlater, 'refunded_later_total', v_rlater_tot,
                            'expected', sh.open_cash + v_cash + v_top - v_ref - v_rcash, 'voids', v_voids, 'no_sale', sh.no_sale);
end $$;

-- Notifikasi staf. Tidak pernah menggagalkan transaksi yang memanggilnya.
create or replace function engine.alert(p_kind text, p_loc text, p_title text, p_detail text default '', p_order text default null, p_table text default null, p_ref text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into staff_alerts (kind, location_id, order_id, table_id, ref, title, detail)
    values (p_kind, nullif(p_loc, ''), p_order, p_table, p_ref, left(coalesce(p_title, ''), 160), left(coalesce(p_detail, ''), 400));
  if random() < 0.02 then delete from staff_alerts where at < now() - interval '3 days'; end if;
exception when others then null;
end $$;

-- 1.4 · Catat aktivitas meja (tidak pernah menggagalkan transaksi utamanya)
create or replace function engine.table_event(p_loc text, p_table text, p_kind text, p_order text default null, p_to text default null,
  p_staff text default null, p_qty int default 0, p_detail text default '')
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_table is null or p_loc is null then return; end if;
  insert into table_events (location_id, table_id, kind, order_id, to_table, staff_id, qty, detail)
    values (p_loc, p_table, p_kind, p_order, p_to, p_staff, coalesce(p_qty, 0), left(coalesce(p_detail, ''), 200));
exception when others then null;
end $$;

-- Kartu stok/HPP/dll. tidak boleh dipanggil langsung dari API
revoke all on schema engine from public;
revoke all on all functions in schema engine from public;


-- =====================================================================
-- Kaly Ops · Database Supabase · 03 Fungsi untuk aplikasi (RPC)
-- ---------------------------------------------------------------------
-- Dipanggil dari aplikasi lewat supabase.rpc('nama_fungsi', {...}).
-- Semua fungsi memeriksa peran staf yang login; fungsi public_* boleh dipanggil tanpa login
-- (halaman pesan QR, lacak pesanan, reservasi, cek poin member).
-- =====================================================================

-- ---------------------------------------------------------------------
-- PIN manajer
-- ---------------------------------------------------------------------
create or replace function public.verify_manager_pin(p_pin text) returns boolean
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform engine.require_role(array['owner', 'kasir', 'dapur', 'gudang', 'service']);
  return exists (select 1 from app_secrets where id = 1 and manager_pin_hash = extensions.crypt(coalesce(p_pin, ''), manager_pin_hash));
end $$;

create or replace function public.set_manager_pin(p_new text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform engine.require_role(array['owner']);
  if coalesce(p_new, '') !~ '^[0-9]{4,6}$' then raise exception 'PIN harus 4 sampai 6 angka'; end if;
  insert into app_secrets (id, manager_pin_hash) values (1, extensions.crypt(p_new, extensions.gen_salt('bf')))
    on conflict (id) do update set manager_pin_hash = excluded.manager_pin_hash;
end $$;

-- ---------------------------------------------------------------------
-- Informasi untuk layar staf
-- ---------------------------------------------------------------------
create or replace function public.whoami() returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(s) - 'user_id' from staff s where s.user_id = auth.uid() and s.active;
$$;

create or replace function public.order_bill(p_order text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform engine.require_role(array['owner', 'kasir', 'service', 'dapur']);
  return engine.compute_bill(p_order);
end $$;

create or replace function public.menu_portions(p_menu text, p_loc text default 'L1') returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform engine.require_role(array['owner', 'kasir', 'service', 'dapur', 'gudang']);
  return jsonb_build_object('portions', engine.menu_portions(p_menu, p_loc), 'block', engine.menu_block(p_menu, p_loc), 'limit', engine.menu_limit_item(p_menu, p_loc));
end $$;

-- Menu yang sedang tidak bisa dijual karena bahan, per outlet
create or replace function public.stock_blocked_menus(p_loc text default 'L1') returns table (menu_id text, name text, limit_item text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform engine.require_role(array['owner', 'kasir', 'service', 'dapur', 'gudang']);
  return query select m.id, m.name, engine.menu_limit_item(m.id, p_loc) from menus m
    where engine.menu_block(m.id, p_loc) = 'bahan' order by m.sort, m.name;
end $$;

-- ---------------------------------------------------------------------
-- POS: kirim ke dapur, diskon manual, split, gabung, void, bayar
-- ---------------------------------------------------------------------
create or replace function public.pos_send(p_order text) returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.staff; o public.orders; v_n int; v_drafts int;
begin
  me := engine.require_role(array['owner', 'kasir']);
  perform engine.on_();
  select * into o from orders where id = p_order for update;
  if o.id is null or o.status <> 'open' then raise exception 'Pesanan tidak ditemukan atau sudah ditutup'; end if;
  select count(*) into v_drafts from order_lines where order_id = p_order and status = 'draft';
  if v_drafts = 0 then return jsonb_build_object('kitchen_items', 0, 'sent', 0); end if;
  v_n := engine.send_lines(p_order, me.id);
  return jsonb_build_object('kitchen_items', v_n, 'sent', v_drafts);
end $$;

create or replace function public.apply_manual_discount(p_order text, p_type text, p_value numeric, p_reason text, p_pin text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare me public.staff; o public.orders; b jsonb; v_ratio numeric; v_val numeric; v_ok boolean := false; s public.settings := engine.cfg();
begin
  me := engine.require_role(array['owner', 'kasir']);
  perform engine.on_();
  select * into o from orders where id = p_order for update;
  if o.id is null or o.status <> 'open' then raise exception 'Pesanan tidak ditemukan atau sudah ditutup'; end if;
  if p_type not in ('pct', 'amt') or coalesce(p_value, 0) <= 0 then raise exception 'Isi nilai diskon'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Alasan diskon wajib diisi'; end if;
  b := engine.compute_bill(p_order);
  v_val := case when p_type = 'pct' then p_value / 100 else p_value end;
  v_ratio := case when p_type = 'pct' then v_val else v_val / greatest(1, (b->>'sub')::numeric) end;
  if v_ratio > s.disc_approval then
    v_ok := exists (select 1 from app_secrets where id = 1 and manager_pin_hash = extensions.crypt(coalesce(p_pin, ''), manager_pin_hash));
    if not v_ok then raise exception 'PIN manajer salah. Diskon di atas % perlu persetujuan manajer.', engine.jsround(s.disc_approval * 100)::int || '%'; end if;
  end if;
  update orders set discount = discount || jsonb_build_object('manual', jsonb_build_object('type', p_type, 'value', v_val, 'reason', trim(p_reason), 'by', me.id, 'approved', v_ok)), updated_at = now()
    where id = p_order;
  if v_ok then
    perform engine.flag('Diskon manual besar', 'sedang',
      'Diskon ' || case when p_type = 'pct' then p_value::text || '%' else engine.rp(p_value) end || ' di ' || o.no || ' disetujui manajer. Alasan: ' || trim(p_reason), me.id, o.id, o.location_id);
  end if;
  return engine.compute_bill(p_order);
end $$;

create or replace function public.remove_discount(p_order text, p_kind text) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform engine.require_role(array['owner', 'kasir']);
  perform engine.on_();
  if p_kind not in ('manual', 'voucher', 'points') then raise exception 'Jenis diskon tidak dikenal'; end if;
  update orders set discount = discount - p_kind, updated_at = now() where id = p_order and status = 'open';
  return engine.compute_bill(p_order);
end $$;

-- Pisahkan sebagian item ke bill baru. p_sel = {"<line_id>": jumlah}
create or replace function public.split_order(p_order text, p_sel jsonb) returns text language plpgsql security definer set search_path = public as $$
declare me public.staff; a public.orders; v_new text; l record; v_q numeric; v_left int; v_nl text; v_cg numeric;
begin
  me := engine.require_role(array['owner', 'kasir']);
  perform engine.on_();
  select * into a from orders where id = p_order for update;
  if a.id is null or a.status <> 'open' then raise exception 'Pesanan tidak ditemukan atau sudah ditutup'; end if;
  if not exists (select 1 from jsonb_each_text(p_sel) where value::numeric > 0) then raise exception 'Pilih minimal satu item'; end if;
  select count(*) into v_left from order_lines x where x.order_id = p_order and x.parent_line_id is null and x.status <> 'void'
    and coalesce((p_sel->>x.id)::numeric, 0) < x.qty;
  if v_left = 0 then raise exception 'Sisakan minimal satu item di bill asal'; end if;
  insert into orders (no, location_id, channel, type, table_id, merged_tables, created_by, terminal, customer_name, customer_phone, member_id, split_from, created_at)
    values (engine.next_no(a.location_id, engine.order_prefix(a.channel, a.location_id)), a.location_id, a.channel, a.type, a.table_id, '{}', me.id, a.terminal, a.customer_name, a.customer_phone, a.member_id, a.id, a.created_at)
    returning id into v_new;
  for l in select * from order_lines where order_id = p_order and parent_line_id is null and status <> 'void' order by sort loop
    v_q := least(coalesce((p_sel->>l.id)::numeric, 0), l.qty);
    continue when v_q <= 0;
    if v_q >= l.qty or l.is_package then
      update order_lines set order_id = v_new where id = l.id or parent_line_id = l.id;
    else
      v_cg := case when l.cost is not null then engine.jsround(l.cost * v_q / l.qty) end;
      update order_lines set qty = qty - v_q, cost = case when cost is not null then cost - v_cg end where id = l.id;
      insert into order_lines (order_id, menu_id, name, qty, price, status, station, note, sent_at, cook_at, ready_at, served_at, stock_deducted, cost, slip_at)
        values (v_new, l.menu_id, l.name, v_q, l.price, l.status, l.station, l.note, l.sent_at, l.cook_at, l.ready_at, l.served_at, l.stock_deducted, v_cg, l.slip_at);
    end if;
  end loop;
  update orders set kitchen_state = engine.kitchen_state(id), updated_at = now() where id in (p_order, v_new);
  return v_new;
end $$;

-- Gabungkan bill meja lain (p_source) ke bill ini (p_target)
create or replace function public.merge_orders(p_target text, p_source text) returns void language plpgsql security definer set search_path = public as $$
declare a public.orders; b public.orders;
begin
  perform engine.require_role(array['owner', 'kasir']);
  perform engine.on_();
  select * into a from orders where id = p_target for update;
  select * into b from orders where id = p_source for update;
  if a.id is null or b.id is null or a.status <> 'open' or b.status <> 'open' or a.id = b.id then raise exception 'Kedua bill harus masih terbuka'; end if;
  update order_lines set order_id = a.id where order_id = b.id;
  update orders set merged_tables = coalesce((select array_agg(distinct t) from unnest(a.merged_tables || b.merged_tables || array[b.table_id]) t where t is not null and t is distinct from a.table_id), '{}'),
                    member_id = coalesce(a.member_id, b.member_id), kitchen_state = engine.kitchen_state(a.id), updated_at = now()
    where id = a.id;
  update orders set status = 'void', void_reason = 'Digabung ke ' || a.no, merged_into = a.id, void_at = now(), kitchen_state = 'none', updated_at = now() where id = b.id;
end $$;

create or replace function public.void_line(p_line text, p_reason text) returns void language plpgsql security definer set search_path = public as $$
declare me public.staff; ln public.order_lines; o public.orders; v_sent boolean; v_waste numeric;
begin
  me := engine.require_role(array['owner', 'kasir']);
  perform engine.on_();
  perform engine.lock_order((select order_id from order_lines where id = p_line));
  select * into ln from order_lines where id = p_line for update;
  if ln.id is null then raise exception 'Item tidak ditemukan'; end if;
  select * into o from orders where id = ln.order_id for update;
  if o.status <> 'open' then raise exception 'Bill sudah ditutup'; end if;
  select bool_or(status <> 'draft') into v_sent from order_lines where id = p_line or parent_line_id = p_line;
  if not v_sent then delete from order_lines where id = p_line; return; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Alasan pembatalan wajib diisi'; end if;
  select coalesce(sum(cost) filter (where stock_deducted), 0) into v_waste from order_lines where (id = p_line or parent_line_id = p_line) and status <> 'void';
  update order_lines set status = 'void', void_reason = trim(p_reason), void_by = me.id, void_at = now() where id = p_line or parent_line_id = p_line;
  if v_waste > 0 then
    perform engine.post(engine.entity_of(o.location_id), 'Waste void ' || o.no, o.id, null, jsonb_build_array(jsonb_build_array('6105', v_waste, 0), jsonb_build_array('5101', 0, v_waste)), now(), null, me.id);
  end if;
  perform engine.flag('Void item setelah ke dapur', 'sedang', trim(to_char(ln.qty, 'FM999990.##'), '.') || '× ' || ln.name || ' di ' || o.no || ' dibatalkan. Alasan: ' || trim(p_reason), me.id, o.id, o.location_id);
  perform engine.void_pattern(me.id, o.location_id);
  update orders set kitchen_state = engine.kitchen_state(o.id), updated_at = now() where id = o.id;
  perform engine.check_ready(o.id);
end $$;

create or replace function public.void_order(p_order text, p_reason text) returns void language plpgsql security definer set search_path = public as $$
declare me public.staff; o public.orders; v_sent boolean; v_waste numeric;
begin
  me := engine.require_role(array['owner', 'kasir']);
  perform engine.on_();
  select * into o from orders where id = p_order for update;
  if o.id is null or o.status <> 'open' then raise exception 'Bill tidak ditemukan atau sudah ditutup'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Alasan pembatalan wajib diisi'; end if;
  select coalesce(bool_or(status not in ('draft', 'void')), false), coalesce(sum(cost) filter (where stock_deducted and status <> 'void'), 0) into v_sent, v_waste from order_lines where order_id = p_order;
  update order_lines set status = 'void', void_reason = trim(p_reason), void_by = me.id, void_at = now() where order_id = p_order and status <> 'void';
  update orders set status = 'void', void_reason = trim(p_reason), void_by = me.id, void_at = now(), kitchen_state = 'none', updated_at = now() where id = p_order;
  if v_waste > 0 then
    perform engine.post(engine.entity_of(o.location_id), 'Waste void ' || o.no, o.id, null, jsonb_build_array(jsonb_build_array('6105', v_waste, 0), jsonb_build_array('5101', 0, v_waste)), now(), null, me.id);
  end if;
  if v_sent then
    perform engine.flag('Void bill', 'tinggi', 'Bill ' || o.no || coalesce(' (meja ' || o.table_id || ')', '') || ' dibatalkan setelah pesanan diproses. Alasan: ' || trim(p_reason), me.id, o.id, o.location_id);
    perform engine.void_pattern(me.id, o.location_id);
  end if;
end $$;

-- Bayar. p_pays = [{"m":"cash","a":100000}, {"m":"qris","a":46000}, {"m":"deposit","a":20000,"card":"KD-0001"}]
create or replace function public.pay_order(p_order text, p_pays jsonb, p_shift text, p_tendered numeric default 0) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.staff; sh public.shifts;
begin
  me := engine.require_role(array['owner', 'kasir']);
  perform engine.on_();
  select * into sh from shifts where id = p_shift;
  if sh.id is null or sh.close_at is not null then return jsonb_build_object('ok', false, 'msg', 'Buka shift dulu sebelum menerima pembayaran'); end if;
  if sh.staff_id <> me.id and me.role <> 'owner' then return jsonb_build_object('ok', false, 'msg', 'Shift di ' || sh.terminal || ' milik staf lain'); end if;
  return engine.settle(p_order, p_pays, me.id, sh.id, true, p_tendered);
end $$;

-- ---------------------------------------------------------------------
-- Dapur & pramusaji
-- ---------------------------------------------------------------------
-- Ketuk item di layar dapur: new → cook → ready → (ketuk lagi) cook
create or replace function public.kitchen_tap_line(p_line text) returns text language plpgsql security definer set search_path = public as $$
declare ln public.order_lines; v_next text;
begin
  perform engine.require_role(array['owner', 'dapur', 'kasir']);
  perform engine.on_();
  perform engine.lock_order((select order_id from order_lines where id = p_line));
  select * into ln from order_lines where id = p_line for update;
  if ln.id is null or ln.status not in ('new', 'cook', 'ready') then raise exception 'Item tidak ada di antrean dapur'; end if;
  v_next := case ln.status when 'new' then 'cook' when 'cook' then 'ready' else 'cook' end;
  if ln.status = 'ready' then
    update order_lines set status = 'cook', ready_at = null where id = p_line;
    update orders set ready_at = null where id = ln.order_id;
    update order_notices set seen = true where line_id = p_line;
  elsif v_next = 'cook' then
    update order_lines set status = 'cook', cook_at = now() where id = p_line;
  else
    update order_lines set status = 'ready', ready_at = now(), cook_at = coalesce(cook_at, now()) where id = p_line;
    perform engine.line_ready(p_line);
  end if;
  update orders set kitchen_state = engine.kitchen_state(ln.order_id), updated_at = now() where id = ln.order_id;
  perform engine.check_ready(ln.order_id);
  return v_next;
end $$;

-- Layar dapur (checker per item): ubah status SATU item. p_to: 'cook' (mulai dimasak), 'uncook' (batal dimasak, kembali antre),
-- 'ready' (siap diantar, pramusaji & kasir diberi tahu), 'back' (batal siap, kembali dimasak)
create or replace function public.kitchen_line(p_line text, p_to text) returns text language plpgsql security definer set search_path = public as $$
declare ln public.order_lines;
begin
  perform engine.require_role(array['owner', 'dapur', 'kasir']);
  perform engine.on_();
  perform engine.lock_order((select order_id from order_lines where id = p_line));
  select * into ln from order_lines where id = p_line for update;
  if ln.id is null or ln.station = 'none' or ln.is_package then raise exception 'Item tidak ada di antrean dapur'; end if;
  if p_to = 'cook' then
    if ln.status <> 'new' then return ln.status; end if;
    update order_lines set status = 'cook', cook_at = now() where id = p_line;
  elsif p_to = 'uncook' then
    if ln.status <> 'cook' then return ln.status; end if;
    update order_lines set status = 'new', cook_at = null where id = p_line;
  elsif p_to = 'ready' then
    if ln.status = 'ready' then return 'ready'; end if;
    if ln.status not in ('new', 'cook') then raise exception 'Item ini sudah diantar atau dibatalkan'; end if;
    update order_lines set status = 'ready', ready_at = now(), cook_at = coalesce(cook_at, now()) where id = p_line;
    perform engine.line_ready(p_line);
  elsif p_to = 'back' then
    if ln.status <> 'ready' then raise exception 'Item ini sudah diantar, tidak bisa dikembalikan'; end if;
    update order_lines set status = 'cook', ready_at = null where id = p_line;
    update orders set ready_at = null where id = ln.order_id;
    update order_notices set seen = true where line_id = p_line;
  else
    raise exception 'Status tidak dikenal: %', p_to;
  end if;
  update orders set kitchen_state = engine.kitchen_state(ln.order_id), updated_at = now() where id = ln.order_id;
  perform engine.check_ready(ln.order_id);
  return (select status from order_lines where id = p_line);
end $$;

-- Tandai semua item (di stasiun tertentu, atau semua) siap
create or replace function public.kitchen_bump(p_order text, p_station text default null) returns int language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  perform engine.require_role(array['owner', 'dapur', 'kasir']);
  perform engine.on_();
  perform engine.lock_order(p_order);
  with u as (
    update order_lines set status = 'ready', ready_at = now(), cook_at = coalesce(cook_at, now())
      where order_id = p_order and status in ('new', 'cook') and station <> 'none' and not is_package and (p_station is null or station = p_station)
      returning id, order_id
  ), n as (insert into order_notices (order_id, line_id) select order_id, id from u returning 1)
  select count(*) into v_n from n;
  update orders set kitchen_state = engine.kitchen_state(p_order), updated_at = now() where id = p_order;
  perform engine.check_ready(p_order);
  return v_n;
end $$;

create or replace function public.kitchen_recall(p_order text) returns void language plpgsql security definer set search_path = public as $$
begin
  perform engine.require_role(array['owner', 'dapur', 'kasir']);
  perform engine.on_();
  perform engine.lock_order(p_order);
  update order_lines set status = 'cook' where order_id = p_order and status in ('ready', 'served') and station <> 'none' and not is_package;
  update orders set ready_at = null, picked_at = null, kitchen_state = engine.kitchen_state(p_order), updated_at = now() where id = p_order;
  update order_notices set seen = true where order_id = p_order;
end $$;

-- Pramusaji/kasir mengantar SATU item (checker per item). Item yang belum ditandai siap oleh dapur
-- tetap boleh diantar oleh kasir/pramusaji yang menjadi checker: waktu siapnya dicatat saat diantar.
create or replace function public.serve_line(p_line text) returns int language plpgsql security definer set search_path = public as $$
declare me public.staff; ln public.order_lines; o record;
begin
  me := engine.require_role(array['owner', 'service', 'kasir']);
  perform engine.on_();
  perform engine.lock_order((select order_id from order_lines where id = p_line));
  select * into ln from order_lines where id = p_line for update;
  if ln.id is null then raise exception 'Item tidak ditemukan'; end if;
  if ln.status = 'served' then return 0; end if;
  if ln.status not in ('new', 'cook', 'ready') or ln.station = 'none' or ln.is_package then raise exception 'Item ini tidak bisa diantar (belum dikirim ke dapur atau sudah dibatalkan)'; end if;
  update order_lines set status = 'served', served_at = now(), ready_at = coalesce(ready_at, now()), cook_at = coalesce(cook_at, now()) where id = p_line;
  update orders set kitchen_state = engine.kitchen_state(ln.order_id), updated_at = now(),
                    picked_at = case when engine.kitchen_state(ln.order_id) = 'served' then now() else picked_at end
    where id = ln.order_id;
  update order_notices set seen = true where line_id = p_line;
  select location_id, table_id, no into o from orders where id = ln.order_id;
  perform engine.table_event(o.location_id, o.table_id, 'serve', ln.order_id, null, me.id, 1, trim_scale(ln.qty)::text || '× ' || ln.name);
  return 1;
end $$;

-- Pramusaji mengantar item yang sudah siap (sebagian atau semua)
create or replace function public.serve_ready(p_order text) returns int language plpgsql security definer set search_path = public as $$
declare v_n int; me public.staff; o record;
begin
  me := engine.require_role(array['owner', 'service', 'kasir']);
  perform engine.on_();
  perform engine.lock_order(p_order);
  update order_lines set status = 'served', served_at = now() where order_id = p_order and status = 'ready' and station <> 'none' and not is_package;
  get diagnostics v_n = row_count;
  update orders set kitchen_state = engine.kitchen_state(p_order), updated_at = now(),
                    picked_at = case when engine.kitchen_state(p_order) = 'served' then now() else picked_at end
    where id = p_order;
  update order_notices set seen = true where order_id = p_order;
  if v_n > 0 then
    select location_id, table_id, no into o from orders where id = p_order;
    perform engine.table_event(o.location_id, o.table_id, 'serve', p_order, null, me.id, v_n, 'Bill ' || o.no);
  end if;
  return v_n;
end $$;

-- Pesanan diambil/diantar seluruhnya (takeaway, delivery)
create or replace function public.mark_served(p_order text) returns void language plpgsql security definer set search_path = public as $$
begin
  perform engine.require_role(array['owner', 'service', 'kasir']);
  perform engine.on_();
  perform engine.lock_order(p_order);
  update order_lines set status = 'served', served_at = now(), ready_at = coalesce(ready_at, now())
    where order_id = p_order and status in ('new', 'cook', 'ready') and station <> 'none' and not is_package;
  update orders set picked_at = now(), kitchen_state = engine.kitchen_state(p_order), updated_at = now() where id = p_order;
  update order_notices set seen = true where order_id = p_order;
end $$;

-- Pesanan terjadwal masuk dapur otomatis X menit sebelum jamnya (jalankan tiap 5 menit dengan pg_cron)
create or replace function public.release_due_orders() returns int language plpgsql security definer set search_path = public as $$
declare o record; v_n int := 0;
begin
  perform engine.on_();
  for o in select id from orders where scheduled_at is not null and not released and status <> 'void' and not payment_pending
           and now() >= scheduled_at - make_interval(mins => (engine.cfg()).schedule_lead) loop
    perform engine.lock_order(o.id);
    perform engine.send_lines(o.id, null);
    update orders set kitchen_state = engine.kitchen_state(o.id), updated_at = now() where id = o.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- Shift kasir
-- ---------------------------------------------------------------------
create or replace function public.shift_open(p_terminal text, p_location text, p_cash numeric) returns text language plpgsql security definer set search_path = public as $$
declare me public.staff; v_id text;
begin
  me := engine.require_role(array['owner', 'kasir']);
  perform engine.on_();
  if exists (select 1 from shifts where terminal = p_terminal and close_at is null) then raise exception 'Masih ada shift terbuka di %', p_terminal; end if;
  insert into shifts (staff_id, terminal, location_id, open_cash) values (me.id, p_terminal, p_location, coalesce(p_cash, 0)) returning id into v_id;
  return v_id;
end $$;

create or replace function public.shift_summary(p_shift text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform engine.require_role(array['owner', 'kasir']);
  return engine.shift_summary(p_shift);
end $$;

create or replace function public.shift_close(p_shift text, p_counted numeric) returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.staff; sh public.shifts; v_sum jsonb; v_exp numeric; v_var numeric;
begin
  me := engine.require_role(array['owner', 'kasir']);
  perform engine.on_();
  select * into sh from shifts where id = p_shift for update;
  if sh.id is null or sh.close_at is not null then raise exception 'Shift tidak ditemukan atau sudah ditutup'; end if;
  if sh.staff_id <> me.id and me.role <> 'owner' then raise exception 'Shift ini milik staf lain'; end if;
  v_sum := engine.shift_summary(p_shift);
  v_exp := (v_sum->>'expected')::numeric; v_var := coalesce(p_counted, 0) - v_exp;
  update shifts set close_at = now(), counted = coalesce(p_counted, 0), expected = v_exp, variance = v_var, closed_by = me.id where id = p_shift;
  if abs(v_var) > (engine.cfg()).cash_var_tol then
    perform engine.flag('Selisih kas tutup shift', 'tinggi',
      'Shift ' || coalesce((select name from staff where id = sh.staff_id), '') || ' di ' || sh.terminal || ': selisih ' || engine.rp(v_var) || ' (seharusnya ' || engine.rp(v_exp) || ', dihitung ' || engine.rp(coalesce(p_counted, 0)) || ').',
      sh.staff_id, sh.id, sh.location_id);
  end if;
  return v_sum || jsonb_build_object('counted', coalesce(p_counted, 0), 'variance', v_var);
end $$;

-- ---------------------------------------------------------------------
-- Kartu deposit (Play Corner)
-- ---------------------------------------------------------------------
create or replace function public.deposit_topup(p_card text, p_amount numeric, p_method text, p_shift text) returns numeric language plpgsql security definer set search_path = public as $$
declare me public.staff; c public.deposit_cards; sh public.shifts;
begin
  me := engine.require_role(array['owner', 'kasir']);
  perform engine.on_();
  if coalesce(p_amount, 0) < 1000 then raise exception 'Isi nominal top-up'; end if;
  if p_method not in ('cash', 'qris', 'card', 'transfer') then raise exception 'Metode top-up tidak dikenal'; end if;
  select * into sh from shifts where id = p_shift and close_at is null;
  if sh.id is null then raise exception 'Buka shift dulu untuk menerima top-up'; end if;
  select * into c from deposit_cards where id = p_card for update;
  if c.id is null or not c.active then raise exception 'Kartu deposit tidak ditemukan atau nonaktif'; end if;
  update deposit_cards set balance = balance + p_amount where id = p_card;
  insert into deposit_tx (card_id, amount, type, method, created_by, shift_id) values (p_card, p_amount, 'topup', p_method, me.id, sh.id);
  perform engine.post(engine.entity_of(sh.location_id), 'Top-up ' || p_card, p_card, 'Top-up deposit pelanggan',
    jsonb_build_array(jsonb_build_array(engine.pay_account(p_method), p_amount, 0), jsonb_build_array('2103', 0, p_amount)), now(), null, me.id);
  return c.balance + p_amount;
end $$;

create or replace function public.deposit_card_new(p_holder text, p_phone text, p_topup numeric default 0, p_method text default 'cash', p_shift text default null) returns text
language plpgsql security definer set search_path = public as $$
declare me public.staff; v_id text; v_mem text;
begin
  me := engine.require_role(array['owner', 'kasir']);
  perform engine.on_();
  if coalesce(trim(p_holder), '') = '' then raise exception 'Isi nama pemegang kartu'; end if;
  select 'KD-' || lpad((coalesce(max(nullif(regexp_replace(id, '\D', '', 'g'), '')::int), 0) + 1)::text, 4, '0') into v_id from deposit_cards;
  select id into v_mem from members where phone = engine.norm_phone(p_phone);
  insert into deposit_cards (id, holder, phone, member_id) values (v_id, trim(p_holder), engine.norm_phone(p_phone), v_mem);
  if coalesce(p_topup, 0) > 0 then perform public.deposit_topup(v_id, p_topup, p_method, p_shift); end if;
  return v_id;
end $$;

create or replace function public.deposit_refund(p_card text, p_shift text) returns numeric language plpgsql security definer set search_path = public as $$
declare me public.staff; c public.deposit_cards; sh public.shifts;
begin
  me := engine.require_role(array['owner', 'kasir']);
  perform engine.on_();
  select * into sh from shifts where id = p_shift and close_at is null;
  if sh.id is null then raise exception 'Buka shift dulu'; end if;
  select * into c from deposit_cards where id = p_card for update;
  if c.id is null or c.balance <= 0 then return 0; end if;
  update deposit_cards set balance = 0 where id = p_card;
  insert into deposit_tx (card_id, amount, type, method, created_by, shift_id) values (p_card, c.balance, 'refund', 'cash', me.id, sh.id);
  perform engine.post(engine.entity_of(sh.location_id), 'Refund saldo ' || p_card, p_card, 'Refund deposit pelanggan',
    jsonb_build_array(jsonb_build_array('2103', c.balance, 0), jsonb_build_array('1101', 0, c.balance)), now(), null, me.id);
  perform engine.flag('Refund saldo deposit', 'rendah', 'Refund tunai ' || engine.rp(c.balance) || ' dari kartu ' || c.id || ' (' || c.holder || ').', me.id, c.id, sh.location_id);
  return c.balance;
end $$;

-- ---------------------------------------------------------------------
-- Gudang: produksi, mutasi, opname, B2B
-- ---------------------------------------------------------------------
create or replace function public.produce_manual(p_loc text, p_item text, p_batches numeric) returns numeric language plpgsql security definer set search_path = public as $$
declare me public.staff; it public.items;
begin
  me := engine.require_role(array['owner', 'gudang', 'dapur']);
  perform engine.on_();
  select * into it from items where id = p_item and type = 'semi';
  if it.id is null then raise exception 'Bahan setengah jadi tidak ditemukan'; end if;
  if coalesce(p_batches, 0) <= 0 then raise exception 'Isi jumlah batch'; end if;
  return engine.produce(p_loc, p_item, p_batches * it.yield_qty, false, 'Manual', me.id);
end $$;

-- p_lines = [{"item":"i_pkambing","qty":5}]
create or replace function public.transfer_send(p_from text, p_to text, p_lines jsonb) returns text language plpgsql security definer set search_path = public as $$
declare me public.staff; v_no text; v_id text; r jsonb; s public.stock;
begin
  me := engine.require_role(array['owner', 'gudang']);
  perform engine.on_();
  if engine.entity_of(p_from) <> engine.entity_of(p_to) then raise exception 'Beda entitas. Gunakan B2B antar entitas.'; end if;
  if p_from = p_to then raise exception 'Lokasi asal dan tujuan sama'; end if;
  v_no := 'MUT-' || to_char(public.biz_date(), 'YYMMDD') || '-' || lpad(((select count(*) from transfers) + 1)::text, 3, '0');
  insert into transfers (no, from_location, to_location, created_by) values (v_no, p_from, p_to, me.id) returning id into v_id;
  for r in select * from jsonb_array_elements(p_lines) loop
    continue when coalesce((r->>'qty')::numeric, 0) <= 0;
    s := engine.slot(p_from, r->>'item');
    perform engine.consume(p_from, r->>'item', (r->>'qty')::numeric, 'tf-out', v_no, me.id);
    insert into transfer_lines (transfer_id, item_id, qty, unit_cost) values (v_id, r->>'item', (r->>'qty')::numeric, s.avg_cost);
  end loop;
  if not exists (select 1 from transfer_lines where transfer_id = v_id) then raise exception 'Tambahkan barang'; end if;
  return v_no;
end $$;

-- p_received = {"i_pkambing": 4.5}  (kosong = diterima sesuai kiriman)
create or replace function public.transfer_receive(p_id text, p_received jsonb default '{}') returns numeric language plpgsql security definer set search_path = public as $$
declare me public.staff; t public.transfers; l record; v_rq numeric; v_loss numeric := 0;
begin
  me := engine.require_role(array['owner', 'gudang', 'kasir']);
  perform engine.on_();
  select * into t from transfers where id = p_id for update;
  if t.id is null or t.status <> 'dikirim' then raise exception 'Mutasi tidak ditemukan atau sudah diterima'; end if;
  for l in select * from transfer_lines where transfer_id = p_id loop
    v_rq := least(greatest(0, coalesce((p_received->>l.item_id)::numeric, l.qty)), l.qty);
    update transfer_lines set received_qty = v_rq where transfer_id = p_id and item_id = l.item_id;
    if v_rq > 0 then perform engine.add_stock(t.to_location, l.item_id, v_rq, l.unit_cost, 'tf-in', t.no, me.id); end if;
    v_loss := v_loss + (l.qty - v_rq) * l.unit_cost;
  end loop;
  update transfers set status = 'diterima', received_at = now(), received_by = me.id, has_diff = v_loss > 0 where id = p_id;
  if v_loss > 0 then
    perform engine.post(engine.entity_of(t.from_location), 'Selisih mutasi ' || t.no, t.id, null, jsonb_build_array(jsonb_build_array('6105', v_loss, 0), jsonb_build_array('1201', 0, v_loss)), now(), null, me.id);
    perform engine.flag('Selisih mutasi stok', 'sedang', t.no || ': barang diterima kurang dari yang dikirim, nilai ' || engine.rp(v_loss) || '.', me.id, t.id, t.to_location);
  end if;
  return v_loss;
end $$;

-- p_counts = {"i_minyak": 29.5, "i_telur": 150}  (jumlah fisik hasil hitung)
create or replace function public.opname_post(p_loc text, p_counts jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.staff; v_no text; v_id text; k text; v numeric; s public.stock; v_diff numeric; v_val numeric; v_total numeric := 0;
begin
  me := engine.require_role(array['owner', 'gudang']);
  perform engine.on_();
  if p_counts is null or p_counts = '{}'::jsonb then raise exception 'Isi minimal satu hitungan fisik'; end if;
  v_no := 'OPN-' || p_loc || '-' || lpad(((select count(*) from opnames where location_id = p_loc) + 1)::text, 2, '0');
  insert into opnames (no, location_id, created_by) values (v_no, p_loc, me.id) returning id into v_id;
  for k, v in select key, value::numeric from jsonb_each_text(p_counts) loop
    s := engine.slot(p_loc, k);
    v_diff := v - s.qty;
    if abs(v_diff) < 1e-9 then
      insert into opname_lines values (v_id, k, s.qty, v, 0, 0);
      continue;
    end if;
    v_val := engine.jsround(v_diff * s.avg_cost);
    insert into opname_lines values (v_id, k, s.qty, v, v_diff, v_val);
    if v_diff < 0 then perform engine.consume(p_loc, k, -v_diff, 'opname', v_no, me.id);
    else perform engine.add_stock(p_loc, k, v_diff, s.avg_cost, 'opname', v_no, me.id); end if;
    v_total := v_total + v_val;
  end loop;
  update opnames set total = v_total where id = v_id;
  if v_total < 0 then
    perform engine.post(engine.entity_of(p_loc), 'Penyesuaian stock opname ' || v_no, v_no, null, jsonb_build_array(jsonb_build_array('6105', -v_total, 0), jsonb_build_array('1201', 0, -v_total)), now(), null, me.id);
  elsif v_total > 0 then
    perform engine.post(engine.entity_of(p_loc), 'Penyesuaian stock opname ' || v_no, v_no, null, jsonb_build_array(jsonb_build_array('1201', v_total, 0), jsonb_build_array('6105', 0, v_total)), now(), null, me.id);
  end if;
  if v_total < -200000 then
    perform engine.flag('Selisih stock opname', 'sedang', v_no || ': persediaan kurang ' || engine.rp(-v_total) || ' dari catatan sistem.', me.id, v_no, p_loc);
  end if;
  return jsonb_build_object('no', v_no, 'total', v_total);
end $$;

-- p_lines = [{"item":"s_sambal","qty":6,"price":48000}]
create or replace function public.b2b_create(p_from text, p_to text, p_lines jsonb) returns text language plpgsql security definer set search_path = public as $$
declare me public.staff; v_seller text := engine.entity_of(p_from); v_buyer text := engine.entity_of(p_to); v_no text; v_id text; r jsonb; v_c numeric; v_cost numeric := 0; v_total numeric := 0;
begin
  me := engine.require_role(array['owner', 'gudang']);
  perform engine.on_();
  if v_seller = v_buyer then raise exception 'Lokasi asal dan tujuan satu entitas. Gunakan mutasi stok.'; end if;
  v_no := 'B2B-' || to_char(public.biz_date(), 'YYMMDD') || '-' || lpad(((select count(*) from b2b_invoices) + 1)::text, 3, '0');
  insert into b2b_invoices (no, seller_id, buyer_id, from_location, to_location, total, cost, created_by) values (v_no, v_seller, v_buyer, p_from, p_to, 0, 0, me.id) returning id into v_id;
  for r in select * from jsonb_array_elements(p_lines) loop
    continue when coalesce((r->>'qty')::numeric, 0) <= 0 or coalesce((r->>'price')::numeric, 0) <= 0;
    v_c := engine.consume(p_from, r->>'item', (r->>'qty')::numeric, 'b2b-out', v_no, me.id);
    perform engine.add_stock(p_to, r->>'item', (r->>'qty')::numeric, (r->>'price')::numeric, 'b2b-in', v_no, me.id);
    insert into b2b_lines values (v_id, r->>'item', (r->>'qty')::numeric, (r->>'price')::numeric, v_c / (r->>'qty')::numeric);
    v_cost := v_cost + v_c; v_total := v_total + (r->>'qty')::numeric * (r->>'price')::numeric;
  end loop;
  if v_total = 0 then raise exception 'Tambahkan barang'; end if;
  v_total := engine.jsround(v_total);
  update b2b_invoices set total = v_total, cost = engine.jsround(v_cost) where id = v_id;
  perform engine.post(v_seller, 'Penjualan ' || v_no || ' ke ' || (select short from entities where id = v_buyer), v_id, null, jsonb_build_array(jsonb_build_array('1104', v_total, 0), jsonb_build_array('4102', 0, v_total)), now(), null, me.id);
  perform engine.post(v_seller, 'HPP ' || v_no, v_id, null, jsonb_build_array(jsonb_build_array('5101', v_cost, 0), jsonb_build_array('1201', 0, v_cost)), now(), 'ic', me.id);
  perform engine.post(v_buyer, 'Pembelian ' || v_no || ' dari ' || (select short from entities where id = v_seller), v_id, null, jsonb_build_array(jsonb_build_array('1201', v_total, 0), jsonb_build_array('2102', 0, v_total)), now(), null, me.id);
  return v_no;
end $$;

create or replace function public.b2b_pay(p_id text) returns void language plpgsql security definer set search_path = public as $$
declare me public.staff; x public.b2b_invoices;
begin
  me := engine.require_role(array['owner']);
  perform engine.on_();
  select * into x from b2b_invoices where id = p_id for update;
  if x.id is null or x.status = 'lunas' then raise exception 'Tagihan B2B tidak ditemukan atau sudah lunas'; end if;
  update b2b_invoices set status = 'lunas', paid_at = now() where id = p_id;
  perform engine.post(x.buyer_id, 'Bayar ' || x.no, x.id, 'Pembayaran antar perusahaan', jsonb_build_array(jsonb_build_array('2102', x.total, 0), jsonb_build_array('1102', 0, x.total)), now(), null, me.id);
  perform engine.post(x.seller_id, 'Terima pembayaran ' || x.no, x.id, 'Pembayaran antar perusahaan', jsonb_build_array(jsonb_build_array('1102', x.total, 0), jsonb_build_array('1104', 0, x.total)), now(), null, me.id);
end $$;

-- ---------------------------------------------------------------------
-- Kaly Goods: purchase order
-- ---------------------------------------------------------------------
create or replace function engine.ref_price(p_sup text, p_item text) returns numeric language sql stable set search_path = public as $$
  select coalesce((select price from supplier_prices where supplier_id = p_sup and item_id = p_item), (select std_cost from items where id = p_item));
$$;

create or replace function engine.po_flags(p_po text) returns text[] language plpgsql stable set search_path = public as $$
declare po public.purchase_orders; sp public.suppliers; l record; v_ref numeric; v_fl text[] := '{}'; v_same int; v_same_tot numeric; v_tot numeric; s public.settings := engine.cfg();
begin
  select * into po from purchase_orders where id = p_po;
  select * into sp from suppliers where id = po.supplier_id;
  for l in select pl.*, i.name from purchase_order_lines pl join items i on i.id = pl.item_id where pl.po_id = p_po loop
    v_ref := engine.ref_price(po.supplier_id, l.item_id);
    if v_ref > 0 and l.price > v_ref * (1 + s.po_price_tol) then v_fl := v_fl || ('Harga ' || l.name || ' ' || engine.jsround((l.price / v_ref - 1) * 100)::int || '% di atas harga acuan'); end if;
  end loop;
  if not (sp.verified_npwp and sp.verified_bank and sp.verified_visit) then
    v_fl := v_fl || ('Supplier belum terverifikasi penuh (' || array_to_string(array_remove(array[case when not sp.verified_npwp then 'NPWP' end, case when not sp.verified_bank then 'rekening' end, case when not sp.verified_visit then 'kunjungan lokasi' end], null), ', ') || ')');
  end if;
  if not sp.active then v_fl := v_fl || 'Supplier sedang ditandai tidak bisa kirim'::text; end if;
  select coalesce(sum(qty * price), 0) into v_tot from purchase_order_lines where po_id = p_po;
  select count(*), coalesce(sum(total), 0) into v_same, v_same_tot from purchase_orders
    where id <> p_po and supplier_id = po.supplier_id and created_by = po.created_by and public.biz_date(created_at) = public.biz_date(po.created_at) and status <> 'ditolak';
  if v_same > 0 and v_tot < s.po_approval and v_tot + v_same_tot > s.po_approval then
    v_fl := v_fl || ('Kemungkinan PO dipecah: ' || (v_same + 1) || ' PO ke supplier yang sama hari ini, total ' || engine.rp(v_tot + v_same_tot));
  end if;
  return v_fl;
end $$;

create or replace function engine.po_raise_flags(p_po text, p_by text) returns void language plpgsql set search_path = public as $$
declare po public.purchase_orders; f text;
begin
  select * into po from purchase_orders where id = p_po;
  foreach f in array po.flags loop
    perform engine.flag(case when f like 'Harga%' then 'PO di atas harga acuan' when f like 'Kemungkinan%' then 'PO dipecah' else 'Supplier belum terverifikasi' end,
      'sedang', po.no || ': ' || f, p_by, po.id, po.location_id);
  end loop;
end $$;

-- p_lines = [{"item":"i_beras","qty":50,"price":14000}]; p_submit = langsung diajukan ke manajer
create or replace function public.po_create(p_supplier text, p_location text, p_lines jsonb, p_submit boolean default true) returns text
language plpgsql security definer set search_path = public as $$
declare me public.staff; v_id text; v_no text;
begin
  me := engine.require_role(array['owner', 'gudang']);
  perform engine.on_();
  v_no := 'PO-' || to_char(public.biz_date(), 'YYMMDD') || '-' || lpad(((select count(*) from purchase_orders) + 1)::text, 3, '0');
  insert into purchase_orders (no, supplier_id, location_id, entity_id, status, created_by) values (v_no, p_supplier, p_location, engine.entity_of(p_location), 'draft', me.id) returning id into v_id;
  insert into purchase_order_lines (po_id, item_id, qty, price)
    select v_id, x->>'item', (x->>'qty')::numeric, (x->>'price')::numeric from jsonb_array_elements(p_lines) x where (x->>'qty')::numeric > 0 and (x->>'price')::numeric > 0;
  if not exists (select 1 from purchase_order_lines where po_id = v_id) then raise exception 'Tambahkan minimal satu barang'; end if;
  update purchase_orders set total = (select sum(qty * price) from purchase_order_lines where po_id = v_id) where id = v_id;
  update purchase_orders set flags = engine.po_flags(v_id) where id = v_id;
  if p_submit then perform public.po_submit(v_id); end if;
  return v_id;
end $$;

create or replace function public.po_submit(p_id text) returns void language plpgsql security definer set search_path = public as $$
declare me public.staff;
begin
  me := engine.require_role(array['owner', 'gudang']);
  perform engine.on_();
  update purchase_orders set total = (select coalesce(sum(qty * price), 0) from purchase_order_lines where po_id = p_id), created_at = now() where id = p_id and status = 'draft';
  if not found then raise exception 'Hanya PO draft yang bisa diajukan'; end if;
  update purchase_orders set flags = engine.po_flags(p_id), status = 'diajukan' where id = p_id;
  perform engine.po_raise_flags(p_id, me.id);
end $$;

-- Hanya Owner/Manajer, dan bukan pembuat PO-nya sendiri
create or replace function public.po_approve(p_id text, p_approve boolean default true) returns void language plpgsql security definer set search_path = public as $$
declare me public.staff; po public.purchase_orders;
begin
  me := engine.require_role(array['owner']);
  perform engine.on_();
  select * into po from purchase_orders where id = p_id for update;
  if po.id is null or po.status <> 'diajukan' then raise exception 'Hanya PO yang diajukan yang bisa disetujui atau ditolak'; end if;
  if po.created_by = me.id then raise exception 'PO harus disetujui manajer lain, bukan pembuatnya'; end if;
  update purchase_orders set status = case when p_approve then 'disetujui' else 'ditolak' end, approved_by = me.id, approved_at = now() where id = p_id;
end $$;

-- p_received = {"i_beras": 48}  (kosong = diterima sesuai PO); p_invoice = nomor invoice supplier
create or replace function public.po_receive(p_id text, p_received jsonb, p_invoice text) returns numeric language plpgsql security definer set search_path = public as $$
declare me public.staff; po public.purchase_orders; l record; v_q numeric; v_notes text[] := '{}'; v_val numeric := 0;
begin
  me := engine.require_role(array['owner', 'gudang']);
  perform engine.on_();
  select * into po from purchase_orders where id = p_id for update;
  if po.id is null or po.status <> 'disetujui' then raise exception 'Hanya PO yang sudah disetujui yang bisa diterima'; end if;
  if coalesce(trim(p_invoice), '') = '' then raise exception 'Isi nomor invoice dari supplier'; end if;
  if exists (select 1 from purchase_orders where id <> p_id and supplier_id = po.supplier_id and upper(invoice_no) = upper(trim(p_invoice))) then
    raise exception 'Nomor invoice ini sudah pernah dipakai. Cek kemungkinan tagihan ganda.';
  end if;
  for l in select pl.*, i.name, i.unit from purchase_order_lines pl join items i on i.id = pl.item_id where pl.po_id = p_id loop
    v_q := greatest(0, coalesce((p_received->>l.item_id)::numeric, l.qty));
    if v_q > l.qty then v_notes := v_notes || (l.name || ' datang lebih (' || v_q || ' dari ' || l.qty || '), dibatasi sesuai PO'); v_q := l.qty; end if;
    if v_q < l.qty then v_notes := v_notes || (l.name || ' kurang ' || (l.qty - v_q) || ' ' || l.unit); end if;
    update purchase_order_lines set received_qty = v_q where po_id = p_id and item_id = l.item_id;
    if v_q > 0 then
      perform engine.add_stock(po.location_id, l.item_id, v_q, l.price, 'po', po.no, me.id);
      update items set std_cost = l.price where id = l.item_id and type = 'raw';
    end if;
    v_val := v_val + v_q * l.price;
  end loop;
  update purchase_orders set status = 'diterima', received_by = me.id, received_at = now(), invoice_no = trim(p_invoice), flags = flags || v_notes where id = p_id;
  if array_length(v_notes, 1) > 0 then
    perform engine.flag('Penerimaan tidak sesuai PO', 'sedang', po.no || ': ' || array_to_string(v_notes, '; '), me.id, po.id, po.location_id);
  end if;
  perform engine.post(po.entity_id, 'Terima barang ' || po.no, po.id, null, jsonb_build_array(jsonb_build_array('1201', v_val, 0), jsonb_build_array('2101', 0, v_val)), now(), null, me.id);
  return v_val;
end $$;

create or replace function public.po_pay(p_id text) returns numeric language plpgsql security definer set search_path = public as $$
declare me public.staff; po public.purchase_orders; v_val numeric; v_fee numeric := (engine.cfg()).transfer_fee;
begin
  me := engine.require_role(array['owner']);
  perform engine.on_();
  select * into po from purchase_orders where id = p_id for update;
  if po.id is null or po.status <> 'diterima' then raise exception 'Hanya PO yang barangnya sudah diterima yang bisa dibayar'; end if;
  select coalesce(sum(received_qty * price), 0) into v_val from purchase_order_lines where po_id = p_id;
  update purchase_orders set status = 'dibayar', paid_at = now(), paid_by = me.id, fee = v_fee where id = p_id;
  perform engine.post(po.entity_id, 'Bayar ' || po.no || ' ke ' || (select name from suppliers where id = po.supplier_id), po.id, 'Pembayaran ke supplier',
    jsonb_build_array(jsonb_build_array('2101', v_val, 0), jsonb_build_array('6106', v_fee, 0), jsonb_build_array('1102', 0, v_val + v_fee)), now(), null, me.id);
  return v_val + v_fee;
end $$;

-- Buat draft PO otomatis dari bahan di bawah minimum (pakai supplier utama, atau cadangan kalau utama nonaktif)
create or replace function public.po_auto(p_location text) returns int language plpgsql security definer set search_path = public as $$
declare me public.staff; r record; v_sup text; v_po text; v_n int := 0; v_no text;
begin
  me := engine.require_role(array['owner', 'gudang']);
  perform engine.on_();
  for r in
    select s.item_id, s.qty, s.min_qty,
           case when ps.active then isup.primary_supplier_id when bs.active then isup.backup_supplier_id end as sup
    from stock s join item_suppliers isup on isup.item_id = s.item_id
    left join suppliers ps on ps.id = isup.primary_supplier_id left join suppliers bs on bs.id = isup.backup_supplier_id
    where s.location_id = p_location and s.min_qty > 0 and s.qty < s.min_qty order by 4, 1
  loop
    continue when r.sup is null;
    if v_sup is distinct from r.sup then
      v_no := 'PO-' || to_char(public.biz_date(), 'YYMMDD') || '-' || lpad(((select count(*) from purchase_orders) + 1)::text, 3, '0');
      insert into purchase_orders (no, supplier_id, location_id, entity_id, status, is_auto, created_by) values (v_no, r.sup, p_location, engine.entity_of(p_location), 'draft', true, me.id) returning id into v_po;
      v_sup := r.sup; v_n := v_n + 1;
    end if;
    insert into purchase_order_lines (po_id, item_id, qty, price) values (v_po, r.item_id, ceil((r.min_qty * 2 - r.qty) * 2) / 2, engine.ref_price(r.sup, r.item_id));
  end loop;
  update purchase_orders p set total = (select sum(qty * price) from purchase_order_lines where po_id = p.id), flags = engine.po_flags(p.id)
    where p.is_auto and p.status = 'draft' and p.created_by = me.id and p.created_at > now() - interval '1 minute';
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- Keuangan
-- ---------------------------------------------------------------------
create or replace function public.expense_post(p_entity text, p_account text, p_amount numeric, p_source text default '1102', p_memo text default null, p_date date default null) returns text
language plpgsql security definer set search_path = public as $$
declare me public.staff;
begin
  me := engine.require_role(array['owner']);
  perform engine.on_();
  if coalesce(p_amount, 0) <= 0 then raise exception 'Isi jumlah beban'; end if;
  if (select type from accounts where code = p_account) <> 'expense' then raise exception 'Akun % bukan akun beban', p_account; end if;
  return engine.post(p_entity, coalesce(nullif(trim(p_memo), ''), (select name from accounts where code = p_account)), null, 'Beban operasional',
    jsonb_build_array(jsonb_build_array(p_account, p_amount, 0), jsonb_build_array(p_source, 0, p_amount)),
    least(coalesce((p_date::timestamp + interval '12 hours') at time zone (engine.cfg()).timezone, now()), now()), null, me.id);
end $$;

-- ---------------------------------------------------------------------
-- Kaly Loop
-- ---------------------------------------------------------------------
create or replace function public.member_adjust_points(p_member text, p_delta int, p_reason text) returns int language plpgsql security definer set search_path = public as $$
declare me public.staff; m public.members; v_new int;
begin
  me := engine.require_role(array['owner']);
  perform engine.on_();
  if coalesce(p_delta, 0) = 0 or coalesce(trim(p_reason), '') = '' then raise exception 'Isi jumlah poin dan alasan'; end if;
  select * into m from members where id = p_member for update;
  if m.id is null then raise exception 'Member tidak ditemukan'; end if;
  v_new := greatest(0, m.points + p_delta);
  update members set points = v_new where id = p_member;
  insert into point_tx (member_id, delta, reason, note, created_by) values (p_member, v_new - m.points, 'adjust', trim(p_reason), me.id);
  perform engine.flag('Penyesuaian poin manual', 'rendah', 'Poin ' || m.name || ' diubah ' || case when p_delta > 0 then '+' else '' end || p_delta || '. Alasan: ' || trim(p_reason), me.id, m.id, null);
  return v_new;
end $$;

-- Voucher ulang tahun untuk member yang berulang tahun bulan ini
create or replace function public.birthday_vouchers() returns int language plpgsql security definer set search_path = public as $$
declare v_n int; v_yy text := to_char(public.biz_date(), 'YY'); v_mm text := to_char(public.biz_date(), 'MM');
begin
  perform engine.require_role(array['owner']);
  perform engine.on_();
  insert into vouchers (code, name, type, value, max_disc, min_spend, quota, member_ids, active, until)
    select 'ULTAH' || v_yy || '-' || upper(m.id), 'Birthday treat ' || split_part(m.name, ' ', 1), 'pct', (engine.cfg()).birthday_pct, 50000, 0, 1, array[m.id], true, now() + interval '30 days'
    from members m where m.birthday like v_mm || '-%'
    on conflict (code) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- Halaman pelanggan (boleh tanpa login)
-- ---------------------------------------------------------------------
create or replace function public.public_menu(p_loc text default 'L1') returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'brand', (select jsonb_build_object('name', brand_name, 'tagline', brand_tagline, 'color', brand_color, 'accent', brand_accent, 'tax_rate', tax_rate, 'service_rate', service_rate,
               'deliv_base', deliv_base, 'deliv_per_km', deliv_per_km, 'max_km', max_km, 'open_hour', open_hour, 'close_hour', close_hour, 'same_day_cutoff', same_day_cutoff,
               'schedule_lead', schedule_lead, 'welcome_points', welcome_points, 'points_per', points_per) from settings where id = 1),
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'color', color) order by sort, name) from menu_categories), '[]'),
    'menus', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'category_id', m.category_id, 'price', m.price, 'description', m.description, 'tags', m.tags,
               'image_path', m.image_path, 'is_package', m.is_package, 'available', engine.menu_block(m.id, p_loc) is null,
               'portions_left', case when (engine.cfg()).stock_guard and engine.core_on(p_loc) then least(engine.menu_portions(m.id, p_loc), 99) end) order by m.sort, m.name)
             from menus m where engine.menu_block(m.id, p_loc) is distinct from 'nonaktif'), '[]'),
    'promos', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'type', p.type, 'category_id', p.category_id, 'menu_id', p.menu_id))
             from promos p where engine.promo_active(p, now()) and (p.outlets is null or p_loc = any(p.outlets))), '[]')
  );
$$;

-- Pesan dari HP pelanggan: QR meja atau pre-order reservasi (sejak 1.7 tanpa takeaway & delivery). Harga & tagihan dihitung di server.
-- p = {"mode":"meja|take|deliv", "table":"G1", "reservation":"RSV-1234", "items":[{"menu":"m_geprek","qty":2,"note":""}],
--      "name":"Ayu", "phone":"0812...", "member":true, "addr":"...", "km":3, "when":"now|later", "at":"2026-10-22T19:00:00+07:00",
--      "voucher":"KALYBARU", "pay":"online|kasir"}
create or replace function public.public_place_order(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.settings := engine.cfg(); v_loc text := 'L1'; v_type text; v_table text; r public.reservations; v_mem text; o public.orders; v_ex public.orders; v_id text;
  it jsonb; v_block text; v_name text := trim(coalesce(p->>'name', '')); v_phone text := engine.norm_phone(p->>'phone'); v_sched timestamptz; v_local timestamp;
  v_online boolean; v_fee numeric := 0; v_km numeric; b jsonb; v_qty numeric; v_portions numeric; v_sub numeric; v_chk jsonb; v_mname text; v_sum text;
begin
  perform engine.on_();
  v_type := case p->>'mode' when 'deliv' then 'deliv' when 'take' then 'take' else 'dine' end;
  if v_type <> 'dine' and coalesce(p->>'reservation', '') = '' then
    raise exception 'Pesan dari HP hanya lewat QR di meja atau pre-order reservasi. Scan QR di meja kamu.';
  end if;
  if coalesce(p->>'reservation', '') <> '' then
    select * into r from reservations where code = upper(p->>'reservation') and status in ('menunggu', 'dikonfirmasi', 'datang');
    if r.id is null then raise exception 'Kode reservasi tidak ditemukan'; end if;
    v_type := 'dine'; v_table := r.table_id;
  elsif v_type = 'dine' then
    select id into v_table from dining_tables where id = p->>'table' and active;
    if v_table is null then raise exception 'Meja tidak ditemukan. Scan ulang QR di meja.'; end if;
  end if;
  -- Validasi
  if jsonb_array_length(coalesce(p->'items', '[]')) = 0 then raise exception 'Pesanan masih kosong'; end if;
  for it in select * from jsonb_array_elements(p->'items') loop
    v_qty := coalesce((it->>'qty')::numeric, 0);
    if v_qty <= 0 or v_qty > 50 then raise exception 'Jumlah pesanan tidak valid'; end if;
    v_block := engine.menu_block(it->>'menu', v_loc);
    select name into v_mname from menus where id = it->>'menu';
    if v_block is not null then raise exception '% baru saja habis. Hapus dari pesanan dulu.', coalesce(v_mname, 'Menu'); end if;
    if s.stock_guard then
      select sum((x->>'qty')::numeric) into v_qty from jsonb_array_elements(p->'items') x where x->>'menu' = it->>'menu';
      v_portions := engine.menu_portions(it->>'menu', v_loc);
      if v_portions is not null and v_qty > v_portions then raise exception '% tinggal % porsi. Kurangi jumlahnya dulu.', v_mname, v_portions; end if;
    end if;
  end loop;
  if v_name = '' then raise exception 'Isi nama pemesan'; end if;
  if (v_type <> 'dine' or coalesce((p->>'member')::boolean, false)) and length(v_phone) < 9 then raise exception 'Isi nomor WhatsApp yang valid'; end if;
  if v_type = 'deliv' then
    if coalesce(trim(p->>'addr'), '') = '' then raise exception 'Isi alamat pengantaran'; end if;
    v_km := greatest(1, coalesce((p->>'km')::numeric, 1));
    if v_km > s.max_km then raise exception 'Jarak maksimal % km', s.max_km; end if;
    v_fee := s.deliv_base + ceil(v_km) * s.deliv_per_km;
  end if;
  if r.id is not null then v_sched := (r.date + r.time) at time zone s.timezone;
  elsif v_type <> 'dine' and p->>'when' = 'later' then
    v_sched := (p->>'at')::timestamptz;
    if v_sched is null then raise exception 'Pilih tanggal dan jam'; end if;
    if v_sched < now() + interval '40 minutes' then raise exception 'Jadwal minimal 45 menit dari sekarang'; end if;
    v_local := v_sched at time zone s.timezone;
    if extract(hour from v_local) < s.open_hour or extract(hour from v_local) >= s.close_hour then raise exception 'Kami buka pukul %.00 sampai %.00', s.open_hour, s.close_hour; end if;
    if v_type = 'deliv' and v_local::date = public.biz_date() and public.biz_ts()::time > s.same_day_cutoff then
      raise exception 'Same-day delivery ditutup pukul %. Pilih tanggal besok.', to_char(s.same_day_cutoff, 'HH24:MI');
    end if;
  end if;
  -- Member: pakai yang ada, atau daftarkan kalau pelanggan mencentang
  if length(v_phone) >= 9 then
    select id into v_mem from members where phone = v_phone;
    if v_mem is null and coalesce((p->>'member')::boolean, false) then
      insert into members (name, phone, source, points) values (v_name, v_phone, case when v_table is not null then 'qr' else 'web' end, s.welcome_points) returning id into v_mem;
      if s.welcome_points > 0 then insert into point_tx (member_id, delta, reason, note) values (v_mem, s.welcome_points, 'welcome', 'Daftar dari halaman pesan'); end if;
    end if;
  end if;
  -- Meja yang sedang punya bill terbuka: item ditambahkan ke bill itu (dibayar di kasir)
  if v_table is not null and r.id is null then
    select * into v_ex from orders where location_id = v_loc and status = 'open' and released and (table_id = v_table or v_table = any(merged_tables)) order by created_at limit 1 for update;
  end if;
  if v_ex.id is not null then
    for it in select * from jsonb_array_elements(p->'items') loop
      perform engine.add_line(v_ex.id, it->>'menu', (it->>'qty')::numeric, coalesce(it->>'note', ''));
    end loop;
    if v_ex.member_id is null and v_mem is not null then update orders set member_id = v_mem where id = v_ex.id; end if;
    if s.qr_auto_send then perform engine.send_lines(v_ex.id, null); end if;
    update orders set kitchen_state = engine.kitchen_state(v_ex.id), updated_at = now() where id = v_ex.id;
    select string_agg(trim_scale((x->>'qty')::numeric)::text || '× ' || m.name, ', ') into v_sum from jsonb_array_elements(p->'items') x join menus m on m.id = x->>'menu';
    perform engine.alert('qr_add', v_loc, 'Tambahan pesanan QR · Meja ' || v_table, coalesce(v_sum, '') || case when s.qr_auto_send then '. Sudah masuk dapur.' else '. Buka bill dan kirim ke dapur.' end, v_ex.id, v_table);
    return jsonb_build_object('order_id', v_ex.id, 'no', v_ex.no, 'token', v_ex.public_token, 'added_to_open_bill', true, 'payment_required', false, 'total', (engine.compute_bill(v_ex.id)->>'total')::numeric);
  end if;
  insert into orders (no, location_id, channel, type, table_id, customer_name, customer_phone, customer_addr, distance_km, member_id, reservation_id, scheduled_at, released, delivery_fee, delivery_status)
    values (engine.next_no(v_loc, engine.order_prefix(case when v_table is not null then 'qr' else 'web' end, v_loc)), v_loc, case when v_table is not null then 'qr' else 'web' end, v_type, v_table,
            v_name, v_phone, case when v_type = 'deliv' then trim(p->>'addr') else '' end, case when v_type = 'deliv' then v_km end, v_mem, r.id,
            case when v_sched > now() then v_sched end, not coalesce(v_sched > now(), false), v_fee, case when v_type = 'deliv' then 'menunggu' end)
    returning * into o;
  for it in select * from jsonb_array_elements(p->'items') loop
    v_id := engine.add_line(o.id, it->>'menu', (it->>'qty')::numeric, coalesce(it->>'note', ''));
    if v_id is null then raise exception 'Menu tidak bisa dipesan'; end if;
  end loop;
  if coalesce(p->>'voucher', '') <> '' then
    select coalesce(sum(qty * price), 0) into v_sub from order_lines where order_id = o.id and parent_line_id is null;
    v_chk := engine.voucher_check(p->>'voucher', v_sub, v_mem);
    if (v_chk->>'ok')::boolean then update orders set discount = jsonb_build_object('voucher', v_chk->>'code') where id = o.id; end if;
  end if;
  if r.id is not null then update reservations set order_id = o.id where id = r.id; end if;
  v_online := v_type <> 'dine' or r.id is not null or coalesce(p->>'pay', 'online') = 'online';
  b := engine.compute_bill(o.id);
  if v_online then
    if s.demo_online_pay then
      perform engine.settle(o.id, jsonb_build_array(jsonb_build_object('m', 'qris', 'a', (b->>'total')::numeric)), null, null, not coalesce(v_sched > now(), false) and (v_type <> 'dine' or s.qr_auto_send), 0);
    else
      update orders set payment_pending = true where id = o.id;
    end if;
  elsif s.qr_auto_send and not coalesce(v_sched > now(), false) then
    perform engine.send_lines(o.id, null);
  end if;
  update orders set kitchen_state = engine.kitchen_state(o.id), updated_at = now() where id = o.id;
  select string_agg(trim_scale((x->>'qty')::numeric)::text || '× ' || m.name, ', ') into v_sum from jsonb_array_elements(p->'items') x join menus m on m.id = x->>'menu';
  if v_table is not null and r.id is null then
    perform engine.alert('qr_new', v_loc, 'Pesanan QR baru · Meja ' || v_table, o.no || ' · ' || coalesce(v_sum, '')
      || case when v_online and not s.demo_online_pay then '. Pelanggan bayar online, cek dana masuk lalu konfirmasi.' when s.qr_auto_send then '. Sudah masuk dapur, dibayar di kasir.' else '. Buka bill dan kirim ke dapur.' end, o.id, v_table);
  else
    perform engine.alert('web_new', v_loc, 'Pesanan online ' || o.no || ' · ' || case when r.id is not null then 'pre-order reservasi' when v_type = 'deliv' then 'Delivery' else 'Takeaway' end,
      v_name || ' · ' || coalesce(v_sum, '') || case when v_online and not s.demo_online_pay then '. Menunggu pembayaran.' else '' end, o.id, v_table);
  end if;
  return jsonb_build_object('order_id', o.id, 'no', o.no, 'token', o.public_token, 'added_to_open_bill', false,
                            'payment_required', v_online and not s.demo_online_pay, 'total', (b->>'total')::numeric, 'bill', b);
end $$;

-- Konfirmasi pembayaran online. Dipanggil Edge Function webhook payment gateway (service_role),
-- atau kasir/Owner setelah mengecek mutasi QRIS secara manual.
create or replace function public.confirm_online_payment(p_order text, p_amount numeric, p_ref text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o public.orders; me public.staff; v_res jsonb;
  v_role text := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb)->>'role', '');
begin
  if v_role = 'service_role' then null;                                     -- webhook payment gateway (Edge Function)
  elsif auth.uid() is not null then me := engine.require_role(array['owner', 'kasir']);  -- kasir/Owner cek mutasi manual
  elsif v_role <> '' or session_user = 'authenticator' then raise exception 'Akses ditolak' using errcode = '42501';  -- pengunjung tanpa login / lewat API tanpa token
  end if;
  perform engine.on_();
  select * into o from orders where id = p_order for update;
  if o.id is null or o.status <> 'open' or not o.payment_pending then return jsonb_build_object('ok', false, 'msg', 'Pesanan tidak menunggu pembayaran online'); end if;
  if p_amount < (engine.compute_bill(p_order)->>'total')::numeric then return jsonb_build_object('ok', false, 'msg', 'Nominal pembayaran kurang dari tagihan'); end if;
  update orders set payment_pending = false where id = p_order;
  v_res := engine.settle(p_order, jsonb_build_array(jsonb_build_object('m', 'qris', 'a', (engine.compute_bill(p_order)->>'total')::numeric)), me.id, null,
                         o.released and (o.type <> 'dine' or (engine.cfg()).qr_auto_send), 0);
  update order_payments set ref = p_ref where order_id = p_order and p_ref is not null;
  update orders set kitchen_state = engine.kitchen_state(p_order), updated_at = now() where id = p_order;
  return v_res;
end $$;

-- Halaman lacak pesanan pelanggan
create or replace function public.public_track(p_token uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('no', o.no, 'status', o.status, 'type', o.type, 'table', o.table_id, 'kitchen_state', o.kitchen_state, 'payment_pending', o.payment_pending,
    'delivery_status', o.delivery_status, 'created_at', o.created_at, 'ready_at', o.ready_at, 'scheduled_at', o.scheduled_at, 'total', coalesce(o.total, (engine.compute_bill(o.id)->>'total')::numeric),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('name', l.name, 'qty', l.qty, 'status', l.status) order by l.sort) from order_lines l where l.order_id = o.id and l.parent_line_id is null and l.status <> 'void'), '[]'))
  from orders o where o.public_token = p_token;
$$;

-- Cari meja untuk reservasi; kalau tidak ada satu meja yang cukup, gabungkan meja terdekat di area yang sama
create or replace function engine.suggest_table(p_date date, p_time time, p_pax int, p_area text, p_ignore text default null) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  v_start timestamp := p_date + p_time; v_dur interval := make_interval(mins => (engine.cfg()).res_duration);
  v_free text[]; v_one text; a text; t record; x record; v_g text[]; v_seats int; v_spread numeric; v_best text[]; v_best_s numeric; v_best_seats int;
begin
  select array_agg(d.id order by d.sort, d.id) into v_free from dining_tables d
    where d.active and (coalesce(p_area, '') = '' or d.area = p_area)
      and not exists (select 1 from reservations rr where rr.id is distinct from p_ignore and rr.status in ('menunggu', 'dikonfirmasi', 'datang')
                      and d.id = any(array[rr.table_id] || rr.join_tables) and (rr.date + rr.time) < v_start + v_dur and (rr.date + rr.time) + v_dur > v_start);
  if v_free is null then return null; end if;
  select d.id into v_one from dining_tables d where d.id = any(v_free) and d.seats >= p_pax order by d.seats, d.sort, d.id limit 1;
  if v_one is not null then return jsonb_build_object('table', v_one, 'join', '[]'::jsonb, 'seats', (select seats from dining_tables where id = v_one)); end if;
  for a in select distinct area from dining_tables where id = any(v_free) loop
    for t in select * from dining_tables where id = any(v_free) and area = a order by sort, id loop
      v_g := array[t.id]; v_seats := t.seats; v_spread := 0;
      for x in select d.*, sqrt(power((coalesce(d.x, 0) - coalesce(t.x, 0)) * 1.27, 2) + power(coalesce(d.y, 0) - coalesce(t.y, 0), 2)) as dist
               from dining_tables d where d.id = any(v_free) and d.area = a and d.id <> t.id order by dist, d.sort, d.id loop
        exit when v_seats >= p_pax;
        v_g := v_g || x.id; v_seats := v_seats + x.seats; v_spread := v_spread + x.dist;
      end loop;
      continue when v_seats < p_pax;
      if v_best is null or array_length(v_g, 1) < array_length(v_best, 1) or (array_length(v_g, 1) = array_length(v_best, 1) and v_spread < v_best_s) then
        v_best := v_g; v_best_s := v_spread; v_best_seats := v_seats;
      end if;
    end loop;
  end loop;
  if v_best is null then return null; end if;
  return jsonb_build_object('table', v_best[1], 'join', to_jsonb(v_best[2:]), 'seats', v_best_seats);
end $$;

-- p = {"name":"Maya","phone":"0812...","date":"2026-10-25","time":"18:00","pax":4,"area":"Riverside","note":"Anniversary","member":true,"source":"web"}
create or replace function public.public_book(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.settings := engine.cfg(); v_t jsonb; v_code text; v_mem text; v_phone text := engine.norm_phone(p->>'phone'); v_date date := (p->>'date')::date; v_time time := (p->>'time')::time; v_pax int := (p->>'pax')::int;
begin
  perform engine.on_();
  if coalesce(trim(p->>'name'), '') = '' then raise exception 'Isi nama pemesan'; end if;
  if length(v_phone) < 9 then raise exception 'Isi nomor WhatsApp yang valid'; end if;
  if v_date is null or v_time is null or coalesce(v_pax, 0) < 1 or v_pax > 40 then raise exception 'Pilih tanggal, jam, dan jumlah tamu'; end if;
  if (v_date + v_time) < public.biz_ts() then raise exception 'Jam itu sudah lewat'; end if;
  if extract(hour from v_time) < s.open_hour or extract(hour from v_time) >= s.close_hour then raise exception 'Kami buka pukul %.00 sampai %.00', s.open_hour, s.close_hour; end if;
  v_t := engine.suggest_table(v_date, v_time, v_pax, p->>'area');
  if v_t is null then return jsonb_build_object('ok', false, 'msg', 'Jam itu sudah penuh. Pilih jam lain.'); end if;
  select id into v_mem from members where phone = v_phone;
  if v_mem is null and coalesce((p->>'member')::boolean, false) then
    insert into members (name, phone, source, points) values (trim(p->>'name'), v_phone, 'book', s.welcome_points) returning id into v_mem;
    if s.welcome_points > 0 then insert into point_tx (member_id, delta, reason, note) values (v_mem, s.welcome_points, 'welcome', 'Daftar dari halaman reservasi'); end if;
  end if;
  loop
    v_code := 'RSV-' || (1000 + floor(random() * 9000))::int;
    exit when not exists (select 1 from reservations where code = v_code);
  end loop;
  insert into reservations (code, name, phone, date, time, pax, area, table_id, join_tables, status, source, note, member_id)
    values (v_code, trim(p->>'name'), v_phone, v_date, v_time, v_pax, coalesce(p->>'area', ''), v_t->>'table', array(select jsonb_array_elements_text(v_t->'join')),
            case when s.auto_confirm_res then 'dikonfirmasi' else 'menunggu' end, coalesce(nullif(p->>'source', ''), 'web'), coalesce(p->>'note', ''), v_mem);
  return jsonb_build_object('ok', true, 'code', v_code, 'tables', array_to_string(array[v_t->>'table'] || array(select jsonb_array_elements_text(v_t->'join')), ' + '),
                            'status', case when s.auto_confirm_res then 'dikonfirmasi' else 'menunggu' end);
end $$;

-- Jam yang masih tersedia untuk tanggal, jumlah tamu, dan area tertentu
create or replace function public.public_slots(p_date date, p_pax int, p_area text default '') returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.settings := engine.cfg(); h int; m int; v jsonb := '[]'::jsonb; v_t time;
begin
  for h in s.open_hour .. s.close_hour - 2 loop
    foreach m in array array[0, 30] loop
      v_t := make_time(h, m, 0);
      continue when (p_date + v_t) < public.biz_ts() + interval '30 minutes';
      v := v || jsonb_build_object('time', to_char(v_t, 'HH24:MI'), 'available', engine.suggest_table(p_date, v_t, p_pax, p_area) is not null);
    end loop;
  end loop;
  return v;
end $$;

-- Cek poin member dari nomor HP (data dibatasi: nama depan, tier, poin)
create or replace function public.public_member(p_phone text) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('name', split_part(m.name, ' ', 1), 'tier', t.name, 'points', m.points,
    'next_tier', (select jsonb_build_object('name', n.name, 'min_spend', n.min_spend, 'to_go', n.min_spend - m.spend) from tiers n where n.min_spend > m.spend order by n.min_spend limit 1),
    'perks', t.perks)
  from members m cross join lateral engine.tier_of(m.spend) t where m.phone = engine.norm_phone(p_phone);
$$;

-- =====================================================================
-- Versi 1.1: fungsi untuk aplikasi Kaly Ops yang tersambung ke database ini
-- =====================================================================

-- Sinkron antar perangkat: tabel apa saja yang berubah sejak waktu tertentu
create or replace function public.sync_poll(p_since timestamptz default null) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform engine.require_role(array['owner', 'kasir', 'dapur', 'gudang', 'service']);
  return jsonb_build_object('now', clock_timestamp(),
    'changes', coalesce((select jsonb_agg(jsonb_build_array(id, tbl) order by id) from sync_log
                         where at > coalesce(p_since, clock_timestamp() - interval '30 seconds')), '[]'::jsonb));
end $$;

-- Cetak struk: hitung jumlah cetak, cetak ulang tercatat di laporan fraud
create or replace function public.order_print(p_order text) returns int language plpgsql security definer set search_path = public as $$
declare me public.staff; o public.orders;
begin
  me := engine.require_role(array['owner', 'kasir', 'service']);
  perform engine.on_();
  update orders set prints = prints + 1 where id = p_order returning * into o;
  if o.id is null then raise exception 'Pesanan tidak ditemukan'; end if;
  if o.prints = 2 then perform engine.flag('Cetak ulang struk', 'rendah', 'Struk ' || o.no || ' dicetak ulang.', me.id, o.id, o.location_id); end if;
  return o.prints;
end $$;

-- Cetak slip Bar & Dapur: tandai item yang dikirim ke dapur dan belum pernah tercetak, kembalikan id-nya.
-- p_reprint = true: kembalikan semua item yang sudah pernah tercetak (cetak ulang, misalnya kertas macet).
create or replace function public.print_slips(p_order text, p_reprint boolean default false) returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.staff; o public.orders; v_ids text[];
begin
  me := engine.require_role(array['owner', 'kasir', 'service']);
  perform engine.on_();
  perform engine.lock_order(p_order);
  select * into o from orders where id = p_order;
  if o.id is null then raise exception 'Pesanan tidak ditemukan'; end if;
  if p_reprint then
    select coalesce(array_agg(id order by sort), '{}') into v_ids from order_lines
      where order_id = p_order and slip_at is not null and status not in ('draft', 'void') and station in ('bar', 'dapur') and not is_package;
  else
    with u as (
      update order_lines set slip_at = now()
        where order_id = p_order and slip_at is null and status not in ('draft', 'void') and station in ('bar', 'dapur') and not is_package
        returning id, sort
    ) select coalesce(array_agg(id order by sort), '{}') into v_ids from u;
  end if;
  return jsonb_build_object('lines', to_jsonb(v_ids), 'reprint', p_reprint);
end $$;

-- Buka laci tanpa transaksi (wajib alasan, tercatat per shift)
create or replace function public.pos_no_sale(p_shift text, p_reason text) returns int language plpgsql security definer set search_path = public as $$
declare me public.staff; sh public.shifts;
begin
  me := engine.require_role(array['owner', 'kasir']);
  perform engine.on_();
  if coalesce(trim(p_reason), '') = '' then raise exception 'Alasan wajib diisi'; end if;
  update shifts set no_sale = coalesce(no_sale, 0) + 1 where id = p_shift and close_at is null returning * into sh;
  if sh.id is null then raise exception 'Shift tidak aktif'; end if;
  perform engine.flag('Buka laci tanpa transaksi', 'rendah', 'Laci di ' || sh.terminal || ' dibuka tanpa transaksi oleh ' || me.name || '. Alasan: ' || trim(p_reason), me.id, sh.id, sh.location_id);
  return sh.no_sale;
end $$;

-- Kirim pesanan terjadwal ke dapur sekarang (sebelum jadwal otomatisnya)
create or replace function public.order_release(p_order text) returns int language plpgsql security definer set search_path = public as $$
declare me public.staff; o public.orders; v_n int;
begin
  me := engine.require_role(array['owner', 'kasir']);
  perform engine.on_();
  select * into o from orders where id = p_order for update;
  if o.id is null or o.status = 'void' then raise exception 'Pesanan tidak ditemukan'; end if;
  if o.payment_pending then raise exception 'Pesanan ini masih menunggu pembayaran online'; end if;
  if o.released then return 0; end if;
  v_n := engine.send_lines(p_order, me.id);
  update orders set kitchen_state = engine.kitchen_state(p_order), updated_at = now() where id = p_order;
  return v_n;
end $$;

-- Pesanan terjadwal masuk dapur otomatis X menit sebelum jamnya.
-- Dipanggil layar staf yang sedang terbuka (tiap 20 detik), atau pg_cron bila dipasang.
create or replace function public.release_due_orders() returns int language plpgsql security definer set search_path = public as $$
declare o record; v_n int := 0;
begin
  if auth.uid() is not null then perform engine.require_role(array['owner', 'kasir', 'dapur', 'gudang', 'service']); end if;
  perform engine.on_();
  for o in select id from orders where scheduled_at is not null and not released and status <> 'void' and not payment_pending
           and now() >= scheduled_at - make_interval(mins => (engine.cfg()).schedule_lead) for update skip locked loop
    perform engine.send_lines(o.id, null);
    update orders set kitchen_state = engine.kitchen_state(o.id), updated_at = now() where id = o.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- Batalkan bill. Bill yang sudah diproses dapur perlu PIN manajer (kecuali Owner sendiri yang membatalkan).
drop function if exists public.void_order(text, text);
create or replace function public.void_order(p_order text, p_reason text, p_pin text default null) returns void language plpgsql security definer set search_path = public, extensions as $$
declare me public.staff; o public.orders; v_sent boolean; v_waste numeric;
begin
  me := engine.require_role(array['owner', 'kasir']);
  perform engine.on_();
  select * into o from orders where id = p_order for update;
  if o.id is null or o.status <> 'open' then raise exception 'Bill tidak ditemukan atau sudah ditutup'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Alasan pembatalan wajib diisi'; end if;
  select coalesce(bool_or(status not in ('draft', 'void')), false), coalesce(sum(cost) filter (where stock_deducted and status <> 'void'), 0) into v_sent, v_waste from order_lines where order_id = p_order;
  if v_sent and me.role <> 'owner' and not exists (select 1 from app_secrets where id = 1 and manager_pin_hash = extensions.crypt(coalesce(p_pin, ''), manager_pin_hash)) then
    raise exception 'PIN manajer salah. Bill yang sudah diproses dapur perlu persetujuan manajer.';
  end if;
  update order_lines set status = 'void', void_reason = trim(p_reason), void_by = me.id, void_at = now() where order_id = p_order and status <> 'void';
  update orders set status = 'void', void_reason = trim(p_reason), void_by = me.id, void_at = now(), kitchen_state = 'none', updated_at = now() where id = p_order;
  if v_waste > 0 then
    perform engine.post(engine.entity_of(o.location_id), 'Waste void ' || o.no, o.id, null, jsonb_build_array(jsonb_build_array('6105', v_waste, 0), jsonb_build_array('5101', 0, v_waste)), now(), null, me.id);
  end if;
  if v_sent then
    perform engine.flag('Void bill', 'tinggi', 'Bill ' || o.no || coalesce(' (meja ' || o.table_id || ')', '') || ' dibatalkan setelah pesanan diproses. Alasan: ' || trim(p_reason), me.id, o.id, o.location_id);
    perform engine.void_pattern(me.id, o.location_id);
  end if;
end $$;

-- Stok minimum per lokasi (baris stok dibuat bila belum ada)
create or replace function public.stock_set_min(p_loc text, p_item text, p_min numeric) returns void language plpgsql security definer set search_path = public as $$
begin
  perform engine.require_role(array['owner', 'gudang']);
  perform engine.slot(p_loc, p_item);
  update stock set min_qty = greatest(0, coalesce(p_min, 0)) where location_id = p_loc and item_id = p_item;
end $$;

-- Simpan satu menu. p = {"id","name","category_id","price","station","prep_min","active","sold_out","description","tags":[],
--   "image_path","outlets":["L1"],"bom":[{"item":"i_beras","qty":0.2}]}. Kunci yang tidak dikirim tidak diubah.
create or replace function engine.menu_upsert(p jsonb) returns text language plpgsql set search_path = public as $$
declare v_id text := nullif(p->>'id', ''); v_ex public.menus; v_active boolean; v_sold boolean; v_price numeric;
begin
  if v_id is not null then select * into v_ex from menus where id = v_id; end if;
  if v_ex.id is null and coalesce(trim(p->>'name'), '') = '' then raise exception 'Isi nama menu'; end if;
  v_active := coalesce((p->>'active')::boolean, v_ex.active, true);
  v_sold := coalesce((p->>'sold_out')::boolean, v_ex.sold_out, false);
  v_price := coalesce((p->>'price')::numeric, v_ex.price, 0);
  if v_active and not v_sold and v_price <= 0 then raise exception 'Isi harga jual %, atau tandai menu habis atau nonaktif', coalesce(nullif(trim(p->>'name'), ''), v_ex.name, ''); end if;
  if v_ex.id is null then
    insert into menus (id, name, category_id, price, station, prep_min, active, sold_out, description, tags, image_path, sort)
      values (coalesce(v_id, public.new_id('m_')), trim(p->>'name'), nullif(p->>'category_id', ''), v_price, coalesce(nullif(p->>'station', ''), 'dapur'),
              coalesce((p->>'prep_min')::int, 0), v_active, v_sold, coalesce(p->>'description', ''),
              coalesce(array(select jsonb_array_elements_text(p->'tags')), '{}'), nullif(p->>'image_path', ''),
              coalesce((p->>'sort')::int, (select coalesce(max(sort), 0) + 1 from menus)))
      returning id into v_id;
  else
    update menus set
      name = coalesce(nullif(trim(p->>'name'), ''), name),
      category_id = case when p ? 'category_id' then nullif(p->>'category_id', '') else category_id end,
      price = v_price, active = v_active, sold_out = v_sold,
      station = coalesce(nullif(p->>'station', ''), station), prep_min = coalesce((p->>'prep_min')::int, prep_min),
      description = coalesce(p->>'description', description),
      tags = case when p ? 'tags' then coalesce(array(select jsonb_array_elements_text(p->'tags')), '{}') else tags end,
      image_path = case when p ? 'image_path' then nullif(p->>'image_path', '') else image_path end,
      sort = coalesce((p->>'sort')::int, sort)
    where id = v_id;
  end if;
  if p ? 'outlets' then
    delete from menu_outlets where menu_id = v_id;
    insert into menu_outlets (menu_id, location_id) select distinct v_id, x from jsonb_array_elements_text(p->'outlets') x;
  end if;
  if p ? 'bom' then
    delete from menu_bom where menu_id = v_id;
    insert into menu_bom (menu_id, item_id, qty)
      select v_id, x->>'item', sum((x->>'qty')::numeric) from jsonb_array_elements(p->'bom') x where coalesce((x->>'qty')::numeric, 0) > 0 group by x->>'item';
  end if;
  return v_id;
end $$;

create or replace function public.menu_save(p jsonb) returns text language plpgsql security definer set search_path = public as $$
begin
  perform engine.require_role(array['owner']);
  return engine.menu_upsert(p);
end $$;

-- Simpan kategori dan banyak menu sekaligus (kelola kategori, impor daftar menu).
-- p = {"categories":[{"id","name","color","station"}] (urutan = urutan tampil; kategori yang tidak ada di daftar dihapus),
--      "menus":[{...seperti menu_save...}]}
create or replace function public.catalog_save(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare c jsonb; i int := 0; m jsonb; v_n int := 0;
begin
  perform engine.require_role(array['owner']);
  if p ? 'categories' then
    for c in select * from jsonb_array_elements(p->'categories') loop
      i := i + 1;
      if coalesce(trim(c->>'name'), '') = '' then raise exception 'Nama kategori tidak boleh kosong'; end if;
      insert into menu_categories (id, name, color, station, sort) values (c->>'id', trim(c->>'name'), coalesce(nullif(c->>'color', ''), 'slate'), coalesce(nullif(c->>'station', ''), 'dapur'), i)
        on conflict (id) do update set name = excluded.name, color = excluded.color, station = excluded.station, sort = excluded.sort;
    end loop;
    delete from menu_categories where id not in (select x->>'id' from jsonb_array_elements(p->'categories') x);
  end if;
  for m in select * from jsonb_array_elements(coalesce(p->'menus', '[]'::jsonb)) loop
    perform engine.menu_upsert(m); v_n := v_n + 1;
  end loop;
  return jsonb_build_object('menus', v_n);
end $$;

-- Simpan bahan (nama, satuan, kategori, harga standar) dan resep bahan setengah jadi.
-- p = {"id","name","unit","type":"raw|semi","category","std_cost","yield_qty","bom":[{"item","qty"}]}
create or replace function public.item_save(p jsonb) returns text language plpgsql security definer set search_path = public as $$
declare v_id text := nullif(p->>'id', ''); v_ex public.items;
begin
  perform engine.require_role(array['owner', 'gudang']);
  if v_id is not null then select * into v_ex from items where id = v_id; end if;
  if v_ex.id is null then
    if coalesce(trim(p->>'name'), '') = '' or coalesce(trim(p->>'unit'), '') = '' then raise exception 'Isi nama dan satuan bahan'; end if;
    insert into items (id, name, unit, type, category, std_cost, yield_qty)
      values (coalesce(v_id, public.new_id('i_')), trim(p->>'name'), trim(p->>'unit'), coalesce(nullif(p->>'type', ''), 'raw'), nullif(p->>'category', ''),
              coalesce((p->>'std_cost')::numeric, 0), case when p->>'type' = 'semi' then greatest(coalesce((p->>'yield_qty')::numeric, 1), 0.0001) end)
      returning id into v_id;
  else
    update items set name = coalesce(nullif(trim(p->>'name'), ''), name), unit = coalesce(nullif(trim(p->>'unit'), ''), unit),
      category = case when p ? 'category' then nullif(p->>'category', '') else category end,
      std_cost = coalesce((p->>'std_cost')::numeric, std_cost),
      yield_qty = case when type = 'semi' then coalesce(nullif((p->>'yield_qty')::numeric, 0), yield_qty) else yield_qty end,
      active = coalesce((p->>'active')::boolean, active)
    where id = v_id;
  end if;
  if p ? 'bom' then
    delete from item_bom where item_id = v_id;
    insert into item_bom (item_id, component_id, qty)
      select v_id, x->>'item', sum((x->>'qty')::numeric) from jsonb_array_elements(p->'bom') x
      where coalesce((x->>'qty')::numeric, 0) > 0 and x->>'item' <> v_id group by x->>'item';
  end if;
  return v_id;
end $$;

-- Daftar reservasi dari kasir/Owner (telepon atau walk-in). Meja boleh dipilih manual; kosong = dicarikan otomatis.
-- p = {"name","phone","date","time","pax","area","table","join":[],"note","status","source"}
create or replace function public.reservation_create(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.staff; s public.settings := engine.cfg(); v_t jsonb; v_code text; v_mem text; v_phone text := engine.norm_phone(p->>'phone');
  v_date date := (p->>'date')::date; v_time time := (p->>'time')::time; v_pax int := (p->>'pax')::int; v_id text;
begin
  me := engine.require_role(array['owner', 'kasir', 'service']);
  perform engine.on_();
  if coalesce(trim(p->>'name'), '') = '' then raise exception 'Isi nama tamu'; end if;
  if v_date is null or v_time is null or coalesce(v_pax, 0) < 1 then raise exception 'Isi tanggal, jam, dan jumlah tamu'; end if;
  if coalesce(p->>'table', '') <> '' then
    v_t := jsonb_build_object('table', p->>'table', 'join', coalesce(p->'join', '[]'::jsonb));
  else
    v_t := engine.suggest_table(v_date, v_time, v_pax, p->>'area');
    if v_t is null then raise exception 'Tidak ada meja kosong di jam itu. Pilih jam atau area lain.'; end if;
  end if;
  select id into v_mem from members where phone = v_phone and length(v_phone) >= 9;
  loop
    v_code := 'RSV-' || (1000 + floor(random() * 9000))::int;
    exit when not exists (select 1 from reservations where code = v_code);
  end loop;
  insert into reservations (code, name, phone, date, time, pax, area, table_id, join_tables, status, source, note, member_id)
    values (v_code, trim(p->>'name'), coalesce(v_phone, ''), v_date, v_time, v_pax, coalesce(p->>'area', ''), v_t->>'table', array(select jsonb_array_elements_text(v_t->'join')),
            coalesce(nullif(p->>'status', ''), 'dikonfirmasi'), coalesce(nullif(p->>'source', ''), 'telepon'), coalesce(p->>'note', ''), v_mem)
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'code', v_code, 'table', v_t->>'table', 'join', v_t->'join');
end $$;

-- Layar antrean Lounge & layar pelanggan (tanpa login): nomor pesanan yang sedang dibuat / siap, dan menu terlaris
create or replace function public.public_lounge(p_loc text default 'L1') returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'location', (select name from locations where id = p_loc),
    'now', now(),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'no', o.no, 'type', o.type, 'table', o.table_id,
                 'name', split_part(coalesce(o.customer_name, ''), ' ', 1), 'state', o.kitchen_state, 'created_at', o.created_at, 'ready_at', o.ready_at) order by o.created_at)
               from orders o where o.location_id = p_loc and o.status <> 'void' and o.released and o.created_at >= now() - interval '18 hours'
                 and o.kitchen_state in ('new', 'cook', 'ready')), '[]'::jsonb),
    'top', coalesce((select jsonb_agg(x.menu_id order by x.q desc) from (
               select l.menu_id, sum(l.qty) q from order_lines l join orders o on o.id = l.order_id join menus m on m.id = l.menu_id
               where o.location_id = p_loc and o.status = 'paid' and o.paid_at >= now() - interval '7 days' and l.parent_line_id is null and l.status <> 'void'
                 and m.station <> 'none' and engine.menu_block(m.id, p_loc) is null
               group by l.menu_id order by 2 desc limit 6) x), '[]'::jsonb));
$$;

-- Daftar member dari halaman member pelanggan. p = {"name","phone","birthday":"MM-DD atau YYYY-MM-DD"}
create or replace function public.public_register_member(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.settings := engine.cfg(); v_phone text := engine.norm_phone(p->>'phone'); v_name text := trim(coalesce(p->>'name', '')); v_b text := coalesce(p->>'birthday', ''); v_id text; v_new boolean := false;
begin
  perform engine.on_();
  if v_name = '' then raise exception 'Isi nama'; end if;
  if length(v_phone) < 9 then raise exception 'Isi nomor WhatsApp yang valid'; end if;
  if v_b ~ '^\d{4}-\d{2}-\d{2}$' then v_b := substr(v_b, 6); end if;
  if v_b <> '' and v_b !~ '^[01][0-9]-[0-3][0-9]$' then v_b := ''; end if;
  select id into v_id from members where phone = v_phone;
  if v_id is null then
    insert into members (name, phone, birthday, source, points) values (v_name, v_phone, v_b, 'member', s.welcome_points) returning id into v_id;
    if s.welcome_points > 0 then insert into point_tx (member_id, delta, reason, note) values (v_id, s.welcome_points, 'welcome', 'Daftar dari halaman member'); end if;
    v_new := true;
  end if;
  return public.public_member(v_phone) || jsonb_build_object('created', v_new);
end $$;

-- Voucher & tukar poin di bill kasir. p_voucher: kode (string kosong = hapus voucher), p_points: jumlah poin (0 = batal tukar)
create or replace function public.order_set_discount(p_order text, p_voucher text default null, p_points int default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.staff; o public.orders; v_chk jsonb; v_sub numeric; v_pts int;
begin
  me := engine.require_role(array['owner', 'kasir']);
  perform engine.on_();
  select * into o from orders where id = p_order for update;
  if o.id is null or o.status <> 'open' then raise exception 'Bill tidak ditemukan atau sudah ditutup'; end if;
  if p_voucher is not null then
    if trim(p_voucher) = '' then
      update orders set discount = discount - 'voucher' where id = p_order;
    else
      select coalesce(sum(qty * price), 0) into v_sub from order_lines where order_id = p_order and parent_line_id is null and status <> 'void';
      v_chk := engine.voucher_check(upper(trim(p_voucher)), v_sub, o.member_id);
      if not coalesce((v_chk->>'ok')::boolean, false) then raise exception '%', coalesce(v_chk->>'msg', 'Voucher tidak bisa dipakai'); end if;
      update orders set discount = discount || jsonb_build_object('voucher', v_chk->>'code') where id = p_order;
    end if;
  end if;
  if p_points is not null then
    if p_points <= 0 then
      update orders set discount = discount - 'points' where id = p_order;
    else
      if o.member_id is null then raise exception 'Hubungkan member dulu untuk menukar poin'; end if;
      select points into v_pts from members where id = o.member_id;
      update orders set discount = discount || jsonb_build_object('points', least(p_points, coalesce(v_pts, 0))) where id = p_order;
    end if;
  end if;
  update orders set updated_at = now() where id = p_order;
  return engine.compute_bill(p_order);
end $$;

-- Hubungkan / lepas member dari bill (poin yang sedang ditukar ikut dibatalkan saat member dilepas)
create or replace function public.order_set_member(p_order text, p_member text default null) returns void language plpgsql security definer set search_path = public as $$
declare o public.orders;
begin
  perform engine.require_role(array['owner', 'kasir']);
  perform engine.on_();
  select * into o from orders where id = p_order for update;
  if o.id is null or o.status <> 'open' then raise exception 'Bill tidak ditemukan atau sudah ditutup'; end if;
  if p_member is not null and not exists (select 1 from members where id = p_member) then raise exception 'Member tidak ditemukan'; end if;
  update orders set member_id = p_member, discount = case when p_member is distinct from o.member_id then discount - 'points' else discount end, updated_at = now() where id = p_order;
end $$;

-- Halaman member Kaly Loop (tanpa login): tier, dan bila nomor terdaftar: poin, misi, voucher, kunjungan terakhir
create or replace function public.public_loop(p_phone text default null) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare m public.members; v_phone text := engine.norm_phone(coalesce(p_phone, '')); v_month text := to_char(public.biz_date(), 'YYYY-MM');
begin
  if length(v_phone) >= 9 then select * into m from members where phone = v_phone; end if;
  return jsonb_build_object(
    'brand', (select jsonb_build_object('name', brand_name, 'tagline', brand_tagline, 'color', brand_color, 'accent', brand_accent, 'welcome_points', welcome_points,
              'point_value', point_value, 'points_per', points_per, 'birthday_pct', birthday_pct) from settings where id = 1),
    'tiers', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'min', min_spend, 'perks', perks) order by min_spend) from tiers), '[]'::jsonb),
    'member', case when m.id is null then null else jsonb_build_object(
      'name', m.name, 'points', m.points, 'spend', m.spend, 'visits', m.visits, 'birthday', m.birthday,
      'missions', coalesce((select jsonb_agg(jsonb_build_object('name', x.name, 'desc', x.description, 'target', x.target, 'reward', x.reward,
                  'progress', coalesce(mm.progress, 0), 'done', coalesce(mm.done, false)) order by x.name)
                from missions x left join member_missions mm on mm.mission_id = x.id and mm.member_id = m.id and mm.month = v_month where x.active), '[]'::jsonb),
      'vouchers', coalesce((select jsonb_agg(jsonb_build_object('code', v.code, 'name', v.name, 'min', v.min_spend, 'until', v.until, 'personal', m.id = any(v.member_ids),
                  'birthday', v.code like 'ULTAH%'))
                from vouchers v where v.active and (v.until is null or v.until > now()) and (coalesce(v.quota, 0) = 0 or v.used < v.quota)
                  and (m.id = any(v.member_ids) or (coalesce(array_length(v.member_ids, 1), 0) = 0 and not (v.new_only and m.visits > 0)))), '[]'::jsonb),
      'recent', coalesce((select jsonb_agg(jsonb_build_object('at', o.paid_at, 'earned', o.earned_points) order by o.paid_at desc)
                from (select paid_at, earned_points from orders where member_id = m.id and status = 'paid' order by paid_at desc limit 5) o), '[]'::jsonb))
    end);
end $$;

-- Halaman reservasi (tanpa login): merek, area meja, jam buka
create or replace function public.public_book_info() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'brand', (select jsonb_build_object('name', brand_name, 'tagline', brand_tagline, 'color', brand_color, 'accent', brand_accent, 'open_hour', open_hour, 'close_hour', close_hour,
              'welcome_points', welcome_points) from settings where id = 1),
    'areas', coalesce((select jsonb_agg(a.name order by a.sort, a.name) from areas a where exists (select 1 from dining_tables t where t.area = a.name and t.active)), '[]'::jsonb));
$$;

-- Halaman pesan (tanpa login): info meja / kode reservasi, menu laris di jam ini, QRIS toko
create or replace function public.public_order_ctx(p_table text default null, p_res text default null, p_loc text default 'L1') returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'table', (select jsonb_build_object('id', id, 'area', area) from dining_tables where id = upper(coalesce(p_table, '')) and active),
    'open_bill', exists (select 1 from orders where location_id = p_loc and status = 'open' and released
                         and (table_id = upper(coalesce(p_table, '')) or upper(coalesce(p_table, '')) = any(merged_tables))),
    'reservation', (select jsonb_build_object('code', r.code, 'name', r.name, 'phone', r.phone, 'date', r.date, 'time', to_char(r.time, 'HH24:MI'), 'pax', r.pax,
                      'table', r.table_id, 'area', (select area from dining_tables where id = r.table_id))
                    from reservations r where r.code = upper(coalesce(p_res, '')) and r.status in ('menunggu', 'dikonfirmasi', 'datang')),
    'top_now', coalesce((select jsonb_agg(x.menu_id order by x.q desc) from (
                 select l.menu_id, sum(l.qty) q from order_lines l join orders o on o.id = l.order_id join menus m on m.id = l.menu_id
                 where o.location_id = p_loc and o.status = 'paid' and o.created_at >= now() - interval '28 days'
                   and abs(extract(hour from o.created_at at time zone (engine.cfg()).timezone) - extract(hour from now() at time zone (engine.cfg()).timezone)) <= 1
                   and l.parent_line_id is null and l.status <> 'void' and not m.is_package and engine.menu_block(m.id, p_loc) is null
                 group by 1 order by 2 desc limit 4) x), '[]'::jsonb),
    'qris_image', (select qris_image from settings where id = 1));
$$;

-- Menu yang sering dibeli bersama isi keranjang (30 hari terakhir)
create or replace function public.public_reco(p_menus text[], p_loc text default 'L1') returns jsonb language sql stable security definer set search_path = public as $$
  with base as (
    select distinct l.order_id from order_lines l join orders o on o.id = l.order_id
    where o.status = 'paid' and o.location_id = p_loc and o.created_at >= now() - interval '30 days' and l.menu_id = any(p_menus) and l.parent_line_id is null and l.status <> 'void'),
  cnt as (
    select l.menu_id, count(distinct l.order_id) c from order_lines l join base b on b.order_id = l.order_id
    where not (l.menu_id = any(p_menus)) and l.parent_line_id is null and l.status <> 'void' group by l.menu_id)
  select coalesce(jsonb_agg(jsonb_build_object('m', x.menu_id, 'conf', round(x.c::numeric / greatest(1, (select count(*) from base)), 3)) order by x.c desc), '[]'::jsonb)
  from (select * from cnt where engine.menu_block(menu_id, p_loc) is null order by c desc limit 3) x;
$$;

-- Hitung perkiraan tagihan di halaman pesan (promo, member, voucher, pajak, ongkir) tanpa menyimpan apa pun.
-- p = {"mode":"meja|take|deliv","items":[{"menu","qty"}],"phone","voucher","km"}
create or replace function public.public_quote(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.settings := engine.cfg(); v_id text := public.new_id('q'); it jsonb; v_mem text; v_phone text := engine.norm_phone(p->>'phone');
  v_type text; v_fee numeric := 0; v_sub numeric; v_chk jsonb; v_bill jsonb; m public.members; t public.tiers;
begin
  perform engine.on_();
  v_type := 'dine';  -- hanya QR meja & pre-order reservasi (tanpa ongkir)
  if length(v_phone) >= 9 then select * into m from members where phone = v_phone; v_mem := m.id; end if;
  begin
    insert into orders (id, no, location_id, channel, type, member_id, delivery_fee, released) values (v_id, 'HITUNG-' || v_id, 'L1', 'web', v_type, v_mem, v_fee, false);
    for it in select * from jsonb_array_elements(coalesce(p->'items', '[]'::jsonb)) loop
      insert into order_lines (order_id, menu_id, name, qty, price, station, is_package)
        select v_id, x.id, x.name, least(50, (it->>'qty')::numeric), x.price, x.station, x.is_package from menus x where x.id = it->>'menu' and coalesce((it->>'qty')::numeric, 0) > 0;
    end loop;
    if coalesce(p->>'voucher', '') <> '' then
      select coalesce(sum(qty * price), 0) into v_sub from order_lines where order_id = v_id;
      v_chk := engine.voucher_check(p->>'voucher', v_sub, v_mem);
      if coalesce((v_chk->>'ok')::boolean, false) then update orders set discount = jsonb_build_object('voucher', v_chk->>'code') where id = v_id; end if;
    end if;
    v_bill := engine.compute_bill(v_id);
    raise exception 'kaly-quote' using errcode = 'P0001';
  exception when raise_exception then null;
  end;
  if m.id is not null then t := engine.tier_of(m.spend); end if;
  return jsonb_build_object('bill', v_bill,
    'voucher', case when coalesce(p->>'voucher', '') = '' then null else jsonb_build_object('ok', coalesce((v_chk->>'ok')::boolean, false), 'msg', v_chk->>'msg', 'code', v_chk->>'code') end,
    'member', case when m.id is null then null else jsonb_build_object('name', split_part(m.name, ' ', 1), 'tier', t.name, 'points', m.points, 'mult', t.multiplier) end);
end $$;

-- Lacak pesanan: tambah gambar QRIS toko untuk pesanan yang menunggu pembayaran
create or replace function public.public_track(p_token uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('no', o.no, 'status', o.status, 'type', o.type, 'table', o.table_id, 'kitchen_state', o.kitchen_state, 'payment_pending', o.payment_pending,
    'delivery_status', o.delivery_status, 'created_at', o.created_at, 'ready_at', o.ready_at, 'scheduled_at', o.scheduled_at, 'released', o.released,
    'total', coalesce(o.total, (engine.compute_bill(o.id)->>'total')::numeric), 'addr', o.customer_addr,
    'qris_image', case when o.payment_pending then (select qris_image from settings where id = 1) end,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('name', l.name, 'qty', l.qty, 'status', l.status, 'note', l.note) order by l.sort) from order_lines l
                       where l.order_id = o.id and l.parent_line_id is null and l.status <> 'void'), '[]'::jsonb))
  from orders o where o.public_token = p_token;
$$;

-- ---------------------------------------------------------------------
-- 1.2 · Kosongkan meja yang sudah dibayar (service, kasir, owner)
-- p_table kosong = semua meja Sudah bayar di outlet itu
-- ---------------------------------------------------------------------
create or replace function public.table_clear(p_table text default null, p_loc text default 'L1') returns int language plpgsql security definer set search_path = public as $$
declare me public.staff; v_n int := 0; r record;
begin
  me := engine.require_role(array['owner', 'kasir', 'service']);
  if not public.can_loc(p_loc) then raise exception 'Akun ini tidak punya akses ke outlet tersebut' using errcode = '42501'; end if;
  for r in select id, hold_order, hold_at from dining_tables
            where location_id = p_loc and hold_order is not null and (p_table is null or id = p_table) order by id for update loop
    update dining_tables set hold_order = null, hold_at = null where id = r.id;
    perform engine.table_event(p_loc, r.id, 'clear', r.hold_order, null, me.id, 0,
      case when p_table is null then 'kosongkan semua' else '' end);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- 1.3 · Pindah meja (kasir, service, owner)
-- Memindahkan semua yang ada di meja p_from ke meja kosong p_to dalam satu transaksi:
--   · bill terbuka di meja itu (meja utama atau meja gabungan),
--   · pesanan yang sudah dibayar di muka (QR/online) tapi makanannya belum selesai,
--   · tanda "Sudah bayar, belum dikosongkan",
--   · reservasi yang tamunya sudah datang.
-- p_unmerge = true: bila p_from meja utama sebuah bill gabungan, lepas meja gabungannya (satu rombongan pindah ke satu meja).
-- ---------------------------------------------------------------------
create or replace function public.table_move(p_from text, p_to text, p_loc text default 'L1', p_unmerge boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.staff; v_ids text[]; v_no text; v_n int := 0; v_hold text; v_hold_at timestamptz; r record;
begin
  me := engine.require_role(array['owner', 'kasir', 'service']);
  if not public.can_loc(p_loc) then raise exception 'Akun ini tidak punya akses ke outlet tersebut' using errcode = '42501'; end if;
  p_from := upper(trim(coalesce(p_from, ''))); p_to := upper(trim(coalesce(p_to, '')));
  if p_from = '' or p_to = '' then raise exception 'Pilih meja asal dan meja tujuan'; end if;
  if p_from = p_to then raise exception 'Meja tujuan sama dengan meja asal'; end if;
  -- Satu pemindahan per outlet dalam satu waktu, supaya dua staf tidak memindahkan tamu ke meja yang sama
  perform pg_advisory_xact_lock(7316002, hashtext(p_loc));
  if not exists (select 1 from dining_tables where id = p_from and location_id = p_loc) then raise exception 'Meja % tidak ada di outlet ini', p_from; end if;
  if not exists (select 1 from dining_tables where id = p_to and location_id = p_loc and active) then raise exception 'Meja % tidak ada atau sedang tidak dipakai', p_to; end if;
  if exists (select 1 from dining_tables where id = p_to and hold_order is not null)
     or exists (select 1 from orders o where o.location_id = p_loc and (o.table_id = p_to or p_to = any(o.merged_tables))
       and (o.status = 'open' or (o.status = 'paid' and o.biz_day = public.biz_date() and o.kitchen_state in ('new', 'cook', 'ready')))) then
    raise exception 'Meja % sedang terisi. Pilih meja yang kosong, atau gabungkan bill-nya di kasir.', p_to;
  end if;

  -- Pesanan yang menempati meja: bill terbuka, pesanan lunas hari ini yang masih diproses dapur/bar, dan pesanan dari tanda lunas.
  -- Kunci pesanan dulu (urutan sama dengan bayar/void), baru baris meja.
  perform engine.on_();
  for r in select o.id, o.no, o.status from orders o
            where o.location_id = p_loc and (o.table_id = p_from or p_from = any(o.merged_tables))
              and (o.status = 'open' or (o.status = 'paid' and (o.id = (select hold_order from dining_tables where id = p_from)
                   or (o.biz_day = public.biz_date() and o.kitchen_state in ('new', 'cook', 'ready')))))
            order by o.id for update loop
    update orders set
      table_id = case when table_id = p_from then p_to else table_id end,
      merged_tables = case when table_id = p_from and p_unmerge and status = 'open' then '{}'::text[] else array_replace(merged_tables, p_from, p_to) end
     where id = r.id;
    v_n := v_n + 1; v_ids := v_ids || r.id;
    if r.status = 'open' or v_no is null then v_no := r.no; end if;
  end loop;

  select hold_order, hold_at into v_hold, v_hold_at from dining_tables where id = p_from for update;
  if v_hold is not null then
    update dining_tables set hold_order = v_hold, hold_at = v_hold_at where id = p_to;
    update dining_tables set hold_order = null, hold_at = null where id = p_from;
    if v_no is null then select no into v_no from orders where id = v_hold; end if;
  end if;
  if v_n = 0 and v_hold is null then raise exception 'Meja % sedang kosong, tidak ada yang perlu dipindah', p_from; end if;

  -- Reservasi yang tamunya sudah datang ikut pindah, supaya meja lama tidak tampil "reservasi datang"
  update reservations set
    table_id = case when table_id = p_from then p_to else table_id end,
    join_tables = array_replace(join_tables, p_from, p_to)
   where status = 'datang' and date >= public.biz_date() - 1 and (table_id = p_from or p_from = any(join_tables) or order_id = any(coalesce(v_ids, '{}')));

  perform engine.table_event(p_loc, p_from, 'move', coalesce(v_ids[1], v_hold), p_to, me.id, v_n, coalesce('Bill ' || v_no, ''));
  perform engine.alert('table_move', p_loc, 'Meja ' || p_from || ' pindah ke meja ' || p_to,
    coalesce('Bill ' || v_no || ' · ', '') || 'dipindah oleh ' || me.name, coalesce(v_ids[1], v_hold), p_to, me.id);
  return jsonb_build_object('ok', true, 'from', p_from, 'to', p_to, 'orders', v_n, 'hold', v_hold is not null, 'no', v_no, 'ids', to_jsonb(coalesce(v_ids, '{}'::text[])));
end $$;

-- ---------------------------------------------------------------------
-- 2.1 · Printer & stasiun cetak
-- Kasir mengirim lembar ke printer lain (print_enqueue). Perangkat stasiun mengambil antreannya (print_claim),
-- mencetak, lalu melapor (print_done). Pembaruan tabel hanya dijalankan bila ada baris yang berubah, supaya
-- denyut stasiun tidak memicu sinkron ke semua perangkat.
-- ---------------------------------------------------------------------
create or replace function engine.print_staff() returns public.staff language plpgsql stable security definer set search_path = public as $$
declare s public.staff;
begin
  s := engine.me();
  if s.id is null then raise exception 'Akses ditolak: akun ini belum terdaftar sebagai staf Kaly Ops' using errcode = '42501'; end if;
  return s;
end $$;

-- Owner menambah, mengubah, atau menghapus (menonaktifkan) printer. Hasil: id printer.
-- p_conn: pc (PC/stasiun cetak), lan (p_ip:p_port), bt (p_bt = alamat MAC), usb (p_usb = vendor:produk).
-- lan/bt/usb dicetak langsung oleh aplikasi Android Kaly Ops (ESC/POS).
drop function if exists public.print_station_save(text, text, text, boolean);
drop function if exists public.print_station_save(text, text, text, boolean, text, int, int, text);
create or replace function public.print_station_save(p_id text, p_name text, p_loc text, p_active boolean default true,
  p_ip text default null, p_port int default 9100, p_paper int default null, p_mode text default 'raster',
  p_conn text default null, p_bt text default null, p_usb text default null) returns text language plpgsql security definer set search_path = public as $$
declare
  v_id text;
  v_ip text := nullif(trim(coalesce(p_ip, '')), '');
  v_bt text := nullif(upper(replace(trim(coalesce(p_bt, '')), '-', ':')), '');
  v_usb text := nullif(lower(trim(coalesce(p_usb, ''))), '');
  v_conn text;
begin
  perform engine.require_role(array['owner']);
  -- tanpa p_conn (aplikasi 2.2): ada IP = lan, selain itu pc
  v_conn := coalesce(nullif(p_conn, ''), case when v_ip is not null then 'lan' else 'pc' end);
  if coalesce(trim(p_name), '') = '' then raise exception 'Isi nama printer, misalnya Printer Bar'; end if;
  if length(trim(p_name)) > 40 then raise exception 'Nama printer maksimal 40 huruf'; end if;
  if not exists (select 1 from locations where id = p_loc and type = 'outlet') then raise exception 'Outlet % tidak ditemukan', coalesce(p_loc, ''); end if;
  if v_conn not in ('pc', 'lan', 'bt', 'usb') then raise exception 'Jenis sambungan printer tidak dikenal: %', v_conn; end if;
  if v_conn = 'lan' and v_ip is null then raise exception 'Isi alamat IP printer LAN/Wi-Fi, misalnya 192.168.1.31'; end if;
  if v_conn = 'bt' and v_bt is null then raise exception 'Pilih printer Bluetooth, atau isi alamatnya (mis. 66:22:B3:44:55:66)'; end if;
  if v_conn = 'usb' and v_usb is null then raise exception 'Pilih printer USB dari tablet yang tersambung'; end if;
  if v_ip is not null and v_ip !~ '^[A-Za-z0-9.:-]{1,64}$' then raise exception 'Alamat IP printer tidak valid: %', v_ip; end if;
  if v_bt is not null and v_bt !~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' then raise exception 'Alamat Bluetooth tidak valid: % (contoh 66:22:B3:44:55:66)', v_bt; end if;
  if v_usb is not null and v_usb !~ '^[0-9a-f]{4}:[0-9a-f]{4}$' then raise exception 'Kode printer USB tidak valid: % (contoh 0416:5011)', v_usb; end if;
  if coalesce(p_port, 9100) not between 1 and 65535 then raise exception 'Port printer harus 1 sampai 65535'; end if;
  if p_paper is not null and p_paper not in (58, 80) then raise exception 'Lebar kertas 58 atau 80 mm'; end if;
  if coalesce(p_mode, 'raster') not in ('raster', 'escstar') then raise exception 'Mode cetak tidak dikenal'; end if;
  -- simpan hanya alamat milik sambungan yang dipilih
  if v_conn <> 'lan' then v_ip := null; end if;
  if v_conn <> 'bt' then v_bt := null; end if;
  if v_conn <> 'usb' then v_usb := null; end if;
  if p_id is null or not exists (select 1 from print_stations where id = p_id) then
    insert into print_stations (id, name, location_id, active, conn, ip, port, bt_addr, usb_id, paper, mode)
      values (coalesce(p_id, public.new_id('ps_')), trim(p_name), p_loc, coalesce(p_active, true), v_conn, v_ip, coalesce(p_port, 9100), v_bt, v_usb, p_paper, coalesce(p_mode, 'raster'))
      returning id into v_id;
  else
    update print_stations set name = trim(p_name), location_id = p_loc, active = coalesce(p_active, true), conn = v_conn, ip = v_ip, port = coalesce(p_port, 9100),
      bt_addr = v_bt, usb_id = v_usb, paper = p_paper, mode = coalesce(p_mode, 'raster')
     where id = p_id returning id into v_id;
  end if;
  if not coalesce(p_active, true) then
    -- printer dihapus: tujuan cetak yang memakainya kembali ke perangkat kasir, antreannya dibatalkan
    update locations set print_route = (select coalesce(jsonb_object_agg(k, case when v = to_jsonb(v_id) then '"local"'::jsonb else v end), '{}') from jsonb_each(print_route) e(k, v))
     where print_route::text like '%' || v_id || '%';
    if exists (select 1 from print_jobs where station_id = v_id and status = 'queued') then
      update print_jobs set status = 'cancelled', error = 'Printer dihapus' where station_id = v_id and status = 'queued';
    end if;
  end if;
  return v_id;
end $$;

-- Kirim lembar ke printer. p_jobs = [{"station","kind":"cust|copy|bar|dapur|test","order","label","html"}]
-- Hasil: [{"id","station","name","seen"}], seen = kapan stasiun terakhir aktif (kosong = belum pernah).
create or replace function public.print_enqueue(p_jobs jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.staff; j jsonb; st public.print_stations; v_loc text; v_id bigint; v_out jsonb := '[]'; v_kind text;
begin
  s := engine.print_staff();
  if jsonb_typeof(p_jobs) is distinct from 'array' or jsonb_array_length(p_jobs) = 0 then raise exception 'Tidak ada yang dicetak'; end if;
  if jsonb_array_length(p_jobs) > 20 then raise exception 'Terlalu banyak lembar dalam sekali cetak'; end if;
  for j in select * from jsonb_array_elements(p_jobs) loop
    v_kind := coalesce(j->>'kind', '');
    if v_kind not in ('cust', 'copy', 'bar', 'dapur', 'test') then raise exception 'Jenis lembar tidak dikenal: %', v_kind; end if;
    if v_kind <> 'test' and not (s.role = any(array['owner', 'kasir', 'service'])) then raise exception 'Akses ditolak untuk peran %', s.role using errcode = '42501'; end if;
    if coalesce(j->>'html', '') = '' then raise exception 'Isi cetakan kosong'; end if;
    select * into st from print_stations where id = j->>'station' and active;
    if st.id is null then raise exception 'Printer tujuan tidak ditemukan atau sudah dihapus. Periksa Pengaturan › Printer & tujuan cetak.'; end if;
    if not public.can_loc(st.location_id) then raise exception 'Akses ditolak untuk %', st.name using errcode = '42501'; end if;
    if j->>'order' is not null then
      select location_id into v_loc from orders where id = j->>'order';
      if v_loc is null then raise exception 'Pesanan tidak ditemukan'; end if;
      if v_loc <> st.location_id then raise exception '% milik outlet lain', st.name; end if;
    end if;
    insert into print_jobs (station_id, location_id, order_id, kind, label, html, created_by)
      values (st.id, st.location_id, j->>'order', v_kind, left(coalesce(j->>'label', ''), 120), j->>'html', s.id)
      returning id into v_id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', v_id, 'station', st.id, 'name', st.name, 'seen', (select last_seen from print_station_seen where station_id = st.id)));
  end loop;
  if random() < 0.05 then delete from print_jobs where created_at < now() - interval '3 days'; end if;
  return v_out;
end $$;

-- Perangkat stasiun mengambil antreannya (maksimal 20 lembar sekali ambil) dan sekaligus melapor masih aktif.
create or replace function public.print_claim(p_station text) returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.staff; st public.print_stations; v_jobs jsonb := '[]';
begin
  s := engine.print_staff();
  select * into st from print_stations where id = p_station;
  if st.id is null or not st.active then raise exception 'Printer ini sudah dihapus. Pilih printer lain di Stasiun cetak.'; end if;
  if not public.can_loc(st.location_id) then raise exception 'Akses ditolak untuk %', st.name using errcode = '42501'; end if;
  insert into print_station_seen (station_id, last_seen, staff_id) values (st.id, now(), s.id)
    on conflict (station_id) do update set last_seen = excluded.last_seen, staff_id = excluded.staff_id;
  if exists (select 1 from print_jobs where station_id = st.id and status = 'queued' and queued_at < now() - interval '6 hours') then
    update print_jobs set status = 'expired', error = 'Lebih dari 6 jam di antrean' where station_id = st.id and status = 'queued' and queued_at < now() - interval '6 hours';
  end if;
  if exists (select 1 from print_jobs where station_id = st.id and status = 'queued') then
    with c as (select id from print_jobs where station_id = st.id and status = 'queued' order by id limit 20 for update skip locked),
         u as (update print_jobs p set status = 'printing', claimed_at = now() from c where p.id = c.id
               returning p.id, p.kind, p.label, p.html, p.order_id, p.created_at)
    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'label', label, 'html', html, 'order', order_id, 'at', created_at) order by id), '[]') into v_jobs from u;
  end if;
  return jsonb_build_object('name', st.name, 'loc', st.location_id, 'jobs', v_jobs);
end $$;

-- Stasiun melapor hasil cetak. Hasil: jumlah lembar yang diperbarui.
create or replace function public.print_done(p_ids bigint[], p_ok boolean default true, p_error text default '') returns int language plpgsql security definer set search_path = public as $$
declare v_n int := 0;
begin
  perform engine.print_staff();
  if exists (select 1 from print_jobs where id = any(p_ids) and status = 'printing' and public.can_loc(location_id)) then
    update print_jobs set status = case when p_ok then 'printed' else 'failed' end, printed_at = case when p_ok then now() end, error = left(coalesce(p_error, ''), 300)
     where id = any(p_ids) and status = 'printing' and public.can_loc(location_id);
    get diagnostics v_n = row_count;
  end if;
  return v_n;
end $$;

-- Cetak lagi lembar yang gagal, kedaluwarsa, dibatalkan, atau sudah tercetak (kertas macet).
create or replace function public.print_retry(p_id bigint) returns boolean language plpgsql security definer set search_path = public as $$
declare j public.print_jobs;
begin
  perform engine.print_staff();
  select * into j from print_jobs where id = p_id;
  if j.id is null or not public.can_loc(j.location_id) then raise exception 'Lembar cetak tidak ditemukan'; end if;
  if not exists (select 1 from print_stations where id = j.station_id and active) then raise exception 'Printer lembar ini sudah dihapus'; end if;
  if j.status = 'queued' then return false; end if;
  update print_jobs set status = 'queued', queued_at = now(), claimed_at = null, printed_at = null, error = '' where id = p_id;
  return true;
end $$;

-- Batalkan lembar yang belum dicetak (misalnya dicetak di perangkat kasir karena printer tujuan mati). Hasil: id yang dibatalkan.
create or replace function public.print_cancel(p_ids bigint[]) returns bigint[] language plpgsql security definer set search_path = public as $$
declare v_ids bigint[] := '{}';
begin
  perform engine.require_role(array['owner', 'kasir', 'service']);
  if exists (select 1 from print_jobs where id = any(p_ids) and status = 'queued' and public.can_loc(location_id)) then
    with u as (update print_jobs set status = 'cancelled', error = 'Dibatalkan, dicetak di perangkat lain'
                where id = any(p_ids) and status = 'queued' and public.can_loc(location_id) returning id)
    select coalesce(array_agg(id order by id), '{}') into v_ids from u;
  end if;
  return v_ids;
end $$;

-- ---------------------------------------------------------------------
-- 2.4 · Notifikasi di perangkat
-- ---------------------------------------------------------------------
-- Peran yang boleh menerima (dan membaca) tiap jenis notifikasi; null = semua staf outlet itu
create or replace function public.alert_roles(p_kind text) returns text[] language sql immutable set search_path = public as $$
  select case
    when p_kind in ('fraud', 'shift_open', 'shift_close', 'day_close', 'po_paid', 'po_wait') then array['owner']
    when p_kind in ('po_done', 'po_recv', 'tf_in', 'stock_low', 'opname') then array['owner', 'gudang']
    when p_kind in ('k_new', 'k_add', 'k_void', 'k_move') then array['owner', 'dapur']   -- 2.5: untuk layar dapur
    when p_kind = 'res_seat' then array['owner', 'kasir']   -- 2.10: tamu dibooking service → kasir membuka bill
    else null end;
$$;

-- Status notifikasi untuk perangkat ini: alamat server push, kunci publik, jumlah perangkat saya
create or replace function public.push_info() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.staff;
begin
  s := engine.print_staff();
  return jsonb_build_object(
    'url', (select push_url from settings where id = 1),
    'public_key', (select vapid_public from app_secrets where id = 1),
    'devices', (select count(*) from push_subscriptions where staff_id = s.id));
end $$;

-- Owner menyambungkan / memutus Edge Function kaly-push
create or replace function public.push_setup(p_url text) returns void language plpgsql security definer set search_path = public as $$
declare v text := nullif(trim(coalesce(p_url, '')), '');
begin
  perform engine.require_role(array['owner']);
  -- https, atau http khusus Supabase lokal (supabase start) untuk pengembang
  -- 2.12: juga API Vercel (https://<domain>/api/push)
  if v is not null and v !~ '^(https://[A-Za-z0-9.-]+|http://(localhost|127\.0\.0\.1|kong|host\.docker\.internal)(:[0-9]{2,5})?)/functions/v1/[A-Za-z0-9_-]+$'
     and v !~ '^(https://[A-Za-z0-9.-]+|http://(localhost|127\.0\.0\.1|host\.docker\.internal)(:[0-9]{2,5})?)/api/push$' then
    raise exception 'Alamat Edge Function tidak valid: %', v;
  end if;
  perform engine.on_();
  update settings set push_url = v where id = 1;
end $$;

-- Perangkat mendaftar / memperbarui pilihan / berhenti menerima notifikasi saat aplikasi tertutup
create or replace function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_kinds text[], p_label text default '') returns bigint
language plpgsql security definer set search_path = public as $$
declare s public.staff; v_id bigint;
begin
  s := engine.print_staff();
  if coalesce(p_endpoint, '') !~ '^https://' then raise exception 'Alamat langganan notifikasi tidak valid'; end if;
  insert into push_subscriptions (staff_id, endpoint, p256dh, auth, kinds, label)
    values (s.id, p_endpoint, p_p256dh, p_auth, coalesce(p_kinds, '{}'), left(coalesce(p_label, ''), 80))
    on conflict (endpoint) do update set staff_id = excluded.staff_id, p256dh = excluded.p256dh, auth = excluded.auth, kinds = excluded.kinds, label = excluded.label, fails = 0
    returning id into v_id;
  return v_id;
end $$;
create or replace function public.push_kinds(p_endpoint text, p_kinds text[]) returns boolean language plpgsql security definer set search_path = public as $$
declare s public.staff;
begin
  s := engine.print_staff();
  update push_subscriptions set kinds = coalesce(p_kinds, '{}') where endpoint = p_endpoint and staff_id = s.id;
  return found;
end $$;
create or replace function public.push_unsubscribe(p_endpoint text) returns boolean language plpgsql security definer set search_path = public as $$
declare s public.staff;
begin
  s := engine.print_staff();
  delete from push_subscriptions where endpoint = p_endpoint and staff_id = s.id;
  return found;
end $$;

-- Kirim notifikasi tes ke semua perangkat saya
create or replace function public.push_test() returns int language plpgsql security definer set search_path = public as $$
declare s public.staff;
begin
  s := engine.print_staff();
  perform engine.alert('push_test', null, 'Notifikasi tes Kaly Ops', 'Notifikasi di perangkat ini sudah aktif, ' || s.name || '.', null, null, s.id);
  return (select count(*) from push_subscriptions where staff_id = s.id);
end $$;

-- ---------- Hanya untuk Edge Function kaly-push (kunci service_role) ----------
-- Ambil notifikasi & perangkat tujuannya, sekaligus tandai sudah diproses (sekali saja per notifikasi)
create or replace function public.push_targets(p_alert bigint) returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.staff_alerts; v_roles text[];
begin
  select * into a from staff_alerts where id = p_alert;
  if a.id is null or a.at < now() - interval '15 minutes' then return null; end if;
  insert into push_log (alert_id) values (a.id) on conflict do nothing;
  if not found then return null; end if;
  v_roles := public.alert_roles(a.kind);
  return jsonb_build_object('alert', to_jsonb(a), 'targets', coalesce((
    select jsonb_agg(jsonb_build_object('id', p.id, 'endpoint', p.endpoint, 'p256dh', p.p256dh, 'auth', p.auth))
    from push_subscriptions p join staff st on st.id = p.staff_id and st.active
    where (a.kind = any(p.kinds) or a.kind = 'push_test')
      and (v_roles is null or st.role = any(v_roles))
      and (a.location_id is null or st.role = 'owner' or st.outlets is null or cardinality(st.outlets) = 0 or a.location_id = any(st.outlets))
      and (a.kind <> 'push_test' or p.staff_id = a.ref)
      and not (a.kind = 'table_move' and a.ref = st.id)), '[]'::jsonb));
end $$;
create or replace function public.push_result(p_alert bigint, p_ok bigint[], p_gone bigint[], p_failed int) returns void language plpgsql security definer set search_path = public as $$
begin
  update push_subscriptions set last_ok = now(), fails = 0 where id = any(coalesce(p_ok, '{}'));
  delete from push_subscriptions where id = any(coalesce(p_gone, '{}'));
  update push_log set targets = coalesce(array_length(p_ok, 1), 0) + coalesce(array_length(p_gone, 1), 0) + coalesce(p_failed, 0),
    sent = coalesce(array_length(p_ok, 1), 0), failed = coalesce(p_failed, 0) + coalesce(array_length(p_gone, 1), 0) where alert_id = p_alert;
  if random() < 0.05 then delete from push_log where at < now() - interval '7 days'; end if;
end $$;
create or replace function public.push_vapid() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('public', vapid_public, 'private', vapid_private) from app_secrets where id = 1;
$$;
create or replace function public.push_vapid_save(p_public text, p_private jsonb) returns void language plpgsql security definer set search_path = public as $$
begin
  update app_secrets set vapid_public = p_public, vapid_private = p_private where id = 1 and vapid_public is null;
end $$;

-- 2.8 · Simpan model printer (hanya Owner)
create or replace function public.print_station_model(p_id text, p_model text) returns void language plpgsql security definer set search_path = public as $$
begin
  perform engine.require_role(array['owner']);
  if coalesce(p_model, '') not in ('umum', 'epson_t82x', 'rongta_rpp02n') then raise exception 'Model printer tidak dikenal: %', p_model; end if;
  update print_stations set model = p_model where id = p_id;
  if not found then raise exception 'Printer tidak ditemukan'; end if;
end $$;

-- ---------------------------------------------------------------------
-- 2.9 · Anggota shift & laporan per shift
-- ---------------------------------------------------------------------
-- Petugas kasir yang boleh dipakai di outlet ini
create or replace function engine.crew_kasir(p_crew text, p_loc text) returns public.crew language plpgsql stable security definer set search_path = public as $$
declare c public.crew;
begin
  select * into c from crew where id = p_crew and active and role = 'kasir' and (location_id is null or location_id = p_loc);
  if c.id is null then raise exception 'Nama petugas kasir tidak ditemukan. Anggota shift ditambahkan di Kaly Backoffice.'; end if;
  return c;
end $$;

-- Buka shift atas nama petugas. Bila outlet sudah punya daftar petugas kasir, nama wajib dipilih.
create or replace function public.shift_open(p_terminal text, p_location text, p_cash numeric, p_crew text) returns text language plpgsql security definer set search_path = public as $$
declare me public.staff; v_id text; c public.crew;
begin
  me := engine.require_role(array['owner', 'kasir']);
  perform engine.on_();
  if exists (select 1 from shifts where terminal = p_terminal and close_at is null) then raise exception 'Masih ada shift terbuka di %', p_terminal; end if;
  if p_crew is not null then c := engine.crew_kasir(p_crew, p_location);
  elsif exists (select 1 from crew where active and role = 'kasir' and (location_id is null or location_id = p_location)) then
    raise exception 'Pilih nama petugas shift';
  end if;
  insert into shifts (staff_id, terminal, location_id, open_cash, crew_id, crew_name)
    values (me.id, p_terminal, p_location, coalesce(p_cash, 0), c.id, c.name) returning id into v_id;
  return v_id;
end $$;
create or replace function public.shift_open(p_terminal text, p_location text, p_cash numeric) returns text language sql security definer set search_path = public as $$
  select public.shift_open(p_terminal, p_location, p_cash, null::text);
$$;

-- Ganti nama petugas pada shift yang sedang berjalan (tanpa ganti email login). Tercatat di laporan fraud (rendah).
create or replace function public.shift_crew(p_shift text, p_crew text) returns text language plpgsql security definer set search_path = public as $$
declare me public.staff; sh public.shifts; c public.crew;
begin
  me := engine.require_role(array['owner', 'kasir']);
  select * into sh from shifts where id = p_shift for update;
  if sh.id is null or sh.close_at is not null then raise exception 'Shift tidak ditemukan atau sudah ditutup'; end if;
  if sh.staff_id <> me.id and me.role <> 'owner' then raise exception 'Shift ini milik akun lain'; end if;
  c := engine.crew_kasir(p_crew, sh.location_id);
  if sh.crew_id is not distinct from c.id then return c.name; end if;
  update shifts set crew_id = c.id, crew_name = c.name where id = p_shift;
  perform engine.flag('Ganti petugas shift', 'rendah',
    'Shift ' || sh.terminal || ': petugas diganti dari ' || coalesce(sh.crew_name, '(tanpa nama)') || ' ke ' || c.name || '.', me.id, sh.id, sh.location_id);
  return c.name;
end $$;

-- Laporan tiap shift (aktif & selesai) untuk layar kasir: penjualan, metode bayar, kas, selisih
create or replace function public.shift_reports(p_location text, p_days int default 7) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare me public.staff;
begin
  me := engine.require_role(array['owner', 'kasir']);
  if not public.can_loc(p_location) then raise exception 'Tidak punya akses ke outlet ini'; end if;
  return coalesce((select jsonb_agg(x order by x->>'open_at' desc) from (
    select jsonb_build_object('id', s.id, 'terminal', s.terminal, 'crew', coalesce(s.crew_name, st.name), 'open_at', s.open_at, 'close_at', s.close_at,
             'open_cash', s.open_cash, 'counted', s.counted, 'expected', s.expected, 'variance', s.variance) || engine.shift_summary(s.id) x
      from shifts s left join staff st on st.id = s.staff_id
     where s.location_id = p_location and (s.close_at is null or s.open_at >= now() - make_interval(days => least(greatest(coalesce(p_days, 7), 1), 45)))
     order by s.open_at desc limit 200) q), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- 2.12 · Produksi gabungan dapur: ubah status banyak item (dari beberapa nota) sekaligus
-- ---------------------------------------------------------------------
create or replace function public.kitchen_batch(p_lines text[], p_to text) returns int language plpgsql security definer set search_path = public as $$
declare r record; v_n int := 0;
begin
  perform engine.require_role(array['owner', 'dapur', 'kasir']);
  if p_to not in ('cook', 'ready') then raise exception 'Status tidak dikenal: %', p_to; end if;
  if coalesce(cardinality(p_lines), 0) = 0 then return 0; end if;
  if cardinality(p_lines) > 200 then raise exception 'Terlalu banyak item sekaligus'; end if;
  -- nota dikunci berurutan supaya dua layar dapur tidak saling menunggu
  for r in select l.id from order_lines l where l.id = any(p_lines) and l.station <> 'none' and not l.is_package
             and l.status in ('new', 'cook') order by l.order_id, l.sort, l.id loop
    begin
      perform public.kitchen_line(r.id, p_to);
      v_n := v_n + 1;
    exception when others then null;   -- item yang baru saja diubah layar lain dilewati
    end;
  end loop;
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- 2.12 · Audit log
-- ---------------------------------------------------------------------
-- Siapa yang sedang bekerja: akun login + nama petugas & perangkat dari sesi login (audit_session), atau shift kasir
create or replace function engine.audit_sid() returns text language sql stable set search_path = '' as $$
  select left(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id', 80);
$$;
create or replace function engine.audit_who() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare me public.staff; s public.audit_sessions; v_crew text;
begin
  if auth.uid() is null then return null; end if;
  select * into me from staff where user_id = auth.uid() limit 1;
  if me.id is null then return null; end if;
  begin select * into s from audit_sessions where session_id = engine.audit_sid(); exception when others then null; end;
  v_crew := nullif(s.crew_name, '');
  if v_crew is null then
    select crew_name into v_crew from shifts where staff_id = me.id and close_at is null and crew_name is not null order by open_at desc limit 1;
  end if;
  return jsonb_build_object('id', me.id, 'name', me.name, 'role', me.role, 'crew', coalesce(v_crew, ''), 'device', coalesce(s.device, ''));
end $$;

-- Perangkat memberi tahu nama petugas & perangkatnya (dipanggil saat login, ganti petugas, ganti terminal)
create or replace function public.audit_session(p_crew text default '', p_device text default '') returns void language plpgsql security definer set search_path = public as $$
declare me public.staff; v_sid text := engine.audit_sid();
begin
  me := engine.require_role(array['owner', 'kasir', 'dapur', 'gudang', 'service']);
  if v_sid is null then return; end if;
  insert into audit_sessions (session_id, staff_id, crew_name, device, at) values (v_sid, me.id, left(coalesce(p_crew, ''), 40), left(coalesce(p_device, ''), 60), now())
    on conflict (session_id) do update set crew_name = excluded.crew_name, device = excluded.device, at = now();
  if random() < 0.01 then delete from audit_sessions where at < now() - interval '60 days'; end if;
end $$;

create or replace function engine.audit_write(p_action text, p_entity text, p_id text, p_loc text, p_summary text, p_data jsonb) returns void language plpgsql security definer set search_path = public as $$
declare w jsonb := engine.audit_who();
begin
  if w is null then return; end if;
  insert into audit_log (staff_id, staff_name, role, crew_name, device, action, entity, entity_id, location_id, summary, data)
    values (w->>'id', w->>'name', w->>'role', w->>'crew', w->>'device', p_action, coalesce(p_entity, ''), coalesce(p_id, ''), nullif(p_loc, ''), left(coalesce(p_summary, ''), 300), coalesce(p_data, '{}'::jsonb));
  if random() < 0.001 then delete from audit_log where at < now() - interval '365 days'; end if;
exception when others then null;   -- audit tidak pernah menggagalkan transaksi
end $$;

-- Dipanggil aplikasi: masuk, keluar, cetak ulang, buka laci, dll.
create or replace function public.audit_event(p_action text, p_detail text default '', p_entity text default '', p_id text default '') returns void language plpgsql security definer set search_path = public as $$
begin
  perform engine.require_role(array['owner', 'kasir', 'dapur', 'gudang', 'service']);
  if p_action not in ('login', 'logout', 'open', 'print', 'export', 'view') then raise exception 'Aksi audit tidak dikenal'; end if;
  perform engine.audit_write(p_action, left(p_entity, 40), left(p_id, 80), null, left(p_detail, 300), '{}'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- 2.12 · API notifikasi di Vercel (/api/push): satu pintu yang dijaga rahasia bersama (app_secrets.push_secret),
-- tanpa kunci service_role. Rahasia yang sama disimpan di Vercel sebagai KALY_PUSH_SECRET.
-- ---------------------------------------------------------------------
create or replace function public.push_api(p_secret text, p_op text, p_args jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_s text;
begin
  select push_secret into v_s from app_secrets where id = 1;
  if v_s is null or length(v_s) < 32 or p_secret is null or md5(p_secret) <> md5(v_s) or p_secret <> v_s then
    perform pg_sleep(0.3); raise exception 'Ditolak';
  end if;
  if p_op = 'vapid' then return public.push_vapid();
  elsif p_op = 'vapid_save' then perform public.push_vapid_save(p_args ->> 'public', p_args -> 'private'); return '{}'::jsonb;
  elsif p_op = 'targets' then return public.push_targets((p_args ->> 'alert')::bigint);
  elsif p_op = 'result' then
    perform public.push_result((p_args ->> 'alert')::bigint,
      array(select jsonb_array_elements_text(coalesce(p_args -> 'ok', '[]'::jsonb))::bigint),
      array(select jsonb_array_elements_text(coalesce(p_args -> 'gone', '[]'::jsonb))::bigint),
      coalesce((p_args ->> 'failed')::int, 0));
    return '{}'::jsonb;
  end if;
  raise exception 'Operasi tidak dikenal';
end $$;

-- ---------------------------------------------------------------------
-- 2.13 · Aktivitas transaksi & refund
-- ---------------------------------------------------------------------
-- Daftar transaksi (bill lunas, refund, batal) per outlet. Kasir: 7 hari terakhir. Owner/Manajer: tanpa batas.
-- Ringkasan ('sum') dihitung dari seluruh hasil filter, bukan hanya halaman ini.
create or replace function public.trx_list(p_location text, p_from date default null, p_to date default null, p_shift text default null,
  p_q text default '', p_status text default '', p_method text default '', p_limit int default 60, p_before timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare me public.staff; v_to date; v_from date; v_min date; v_q text := nullif(trim(coalesce(p_q, '')), ''); v_lim int := least(greatest(coalesce(p_limit, 60), 1), 200);
  v_rows jsonb; v_sum jsonb;
begin
  me := engine.require_role(array['owner', 'kasir']);
  if not public.can_loc(p_location) then raise exception 'Tidak punya akses ke outlet ini' using errcode = '42501'; end if;
  if coalesce(p_status, '') not in ('', 'paid', 'refund', 'void') then raise exception 'Status tidak dikenal'; end if;
  v_min := case when me.role = 'kasir' then public.biz_date() - 6 else date '2000-01-01' end;
  v_to := coalesce(p_to, public.biz_date()); v_from := greatest(coalesce(p_from, v_to), v_min);
  with f as (
    select o.id, coalesce(o.paid_at, o.void_at, o.created_at) t from orders o
     where o.location_id = p_location and o.status in ('paid', 'refund', 'void') and o.merged_into is null
       and o.biz_day >= v_min
       and (case when p_shift is not null then (o.shift_id = p_shift or o.refund_shift = p_shift)
                 else o.biz_day between v_from and v_to end)
       and (coalesce(p_status, '') = '' or o.status = p_status)
       and (coalesce(p_method, '') = '' or exists (select 1 from order_payments p where p.order_id = o.id and p.method = p_method))
       and (v_q is null or o.no ilike '%' || v_q || '%' or coalesce(o.table_id, '') ilike v_q || '%' or o.customer_name ilike '%' || v_q || '%'
            or exists (select 1 from members m where m.id = o.member_id and (m.name ilike '%' || v_q || '%' or m.phone like '%' || v_q || '%')))
  ), pg as (
    select x.id, x.t from f x where p_before is null or x.t < p_before order by x.t desc, x.id desc limit v_lim
  )
  select
    (select jsonb_build_object(
        'count', count(*) filter (where o.status in ('paid', 'refund')),
        'paid', count(*) filter (where o.status = 'paid'), 'paid_total', coalesce(sum(o.total) filter (where o.status = 'paid'), 0),
        'refund', count(*) filter (where o.status = 'refund'), 'refund_total', coalesce(sum(o.total) filter (where o.status = 'refund'), 0),
        'void', count(*) filter (where o.status = 'void'),
        'by', coalesce((select jsonb_object_agg(method, amt) from (select p.method, sum(p.amount) amt from order_payments p join f x2 on x2.id = p.order_id
                         join orders o2 on o2.id = p.order_id where o2.status = 'paid' group by 1) y), '{}'::jsonb))
       from f x join orders o on o.id = x.id),
    (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'no', o.no, 'day', o.biz_day, 't', x.t, 'created_at', o.created_at, 'paid_at', o.paid_at, 'status', o.status,
             'type', o.type, 'channel', o.channel, 'table', o.table_id, 'merged', o.merged_tables, 'terminal', o.terminal,
             'total', coalesce(o.total, (o.bill->>'total')::numeric, (select sum(l.qty * l.price) from order_lines l where l.order_id = o.id and l.parent_line_id is null)),
             'items', (select coalesce(sum(l.qty), 0) from order_lines l where l.order_id = o.id and l.parent_line_id is null
                        and (l.status <> 'void' or (o.status = 'refund' and l.void_reason like 'Refund:%'))),
             'shift', o.shift_id, 'cashier', coalesce(nullif(s.crew_name, ''), sp.name, sc.name), 'customer', o.customer_name, 'member', m.name,
             'pays', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('m', p.method, 'a', p.amount, 'card', p.card_id)) order by p.id), '[]'::jsonb) from order_payments p where p.order_id = o.id),
             'change', o.change_amount, 'prints', o.prints,
             'refund_at', o.refund_at, 'refund_by', rb.name, 'refund_reason', o.refund_reason, 'refund_shift', o.refund_shift, 'refund_pays', o.refund_pays,
             'void_reason', o.void_reason, 'void_by', vb.name) order by x.t desc, x.id desc), '[]'::jsonb)
       from pg x join orders o on o.id = x.id
       left join shifts s on s.id = o.shift_id left join staff sp on sp.id = o.paid_by left join staff sc on sc.id = o.created_by
       left join members m on m.id = o.member_id left join staff rb on rb.id = o.refund_by left join staff vb on vb.id = o.void_by)
    into v_sum, v_rows;
  return jsonb_build_object('rows', v_rows, 'sum', v_sum, 'more', jsonb_array_length(v_rows) = v_lim, 'from', v_from, 'to', v_to, 'min', v_min);
end $$;

-- Refund penuh satu bill (khusus Owner/Manajer). Uang kembali ke metode semula:
--   tunai → dari laci shift kasir yang dipilih (p_shift), atau kas outlet di luar laci bila p_shift kosong
--   QRIS / kartu / transfer → dari rekening bank (1102)
--   kartu deposit → saldo kartu dikembalikan
-- Jurnal penjualan dibalik, voucher & poin member dikembalikan, item yang belum selesai di dapur dihentikan.
-- Stok bahan tidak dikembalikan (makanan sudah dibuat).
create or replace function public.order_refund(p_order text, p_reason text, p_shift text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.staff; o public.orders; b jsonb; sh public.shifts; v_pays jsonb; v_cash numeric; v_lines jsonb := '[]'::jsonb; r record; p jsonb;
  v_vd jsonb; v_back int; v_delta int; v_reason text := trim(coalesce(p_reason, ''));
begin
  me := engine.require_role(array['owner']);
  perform engine.on_();
  select * into o from orders where id = p_order for update;
  if o.id is null then raise exception 'Bill tidak ditemukan'; end if;
  if not public.can_loc(o.location_id) then raise exception 'Tidak punya akses ke outlet ini' using errcode = '42501'; end if;
  if o.status = 'refund' then raise exception 'Bill % sudah di-refund', o.no; end if;
  if o.status <> 'paid' then raise exception 'Hanya bill yang sudah lunas yang bisa di-refund'; end if;
  if v_reason = '' then raise exception 'Alasan refund wajib diisi'; end if;
  b := coalesce(o.bill, engine.compute_bill(o.id));
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('m', method, 'a', amt, 'card', card_id)) order by method, card_id), '[]'::jsonb) into v_pays
    from (select method, card_id, sum(amount) amt from order_payments where order_id = o.id group by 1, 2) x;
  select coalesce(sum((x->>'a')::numeric), 0) into v_cash from jsonb_array_elements(v_pays) x where x->>'m' = 'cash';
  if v_cash > 0 and p_shift is not null then
    select * into sh from shifts where id = p_shift;
    if sh.id is null or sh.close_at is not null then raise exception 'Shift kasir yang dipilih sudah ditutup. Pilih shift yang sedang aktif.'; end if;
    if sh.location_id <> o.location_id then raise exception 'Shift kasir harus di outlet yang sama dengan bill'; end if;
  end if;
  update orders set status = 'refund', refund_at = now(), refund_by = me.id, refund_reason = v_reason,
                    refund_shift = case when v_cash > 0 then p_shift end, refund_pays = v_pays, updated_at = now()
    where id = o.id;
  -- Item yang belum selesai di dapur dihentikan supaya tidak terus dimasak
  update order_lines set status = 'void', void_reason = 'Refund: ' || v_reason, void_by = me.id, void_at = now()
    where order_id = o.id and status in ('draft', 'new', 'cook', 'ready');
  update orders set kitchen_state = engine.kitchen_state(o.id) where id = o.id;
  -- Jurnal pembalik penjualan
  for r in select engine.pay_account(x->>'m') as acc, sum((x->>'a')::numeric) as amt from jsonb_array_elements(v_pays) x group by 1 order by 1 loop
    v_lines := v_lines || jsonb_build_array(jsonb_build_array(r.acc, 0, r.amt));
  end loop;
  if (b->>'disc')::numeric > 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_array('4201', 0, (b->>'disc')::numeric)); end if;
  v_lines := v_lines || jsonb_build_array(jsonb_build_array('4101', (b->>'sub')::numeric, 0));
  if (b->>'tax')::numeric > 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_array('2104', (b->>'tax')::numeric, 0)); end if;
  if coalesce((b->>'svc')::numeric, 0) + coalesce((b->>'deliv')::numeric, 0) > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_array('4103', coalesce((b->>'svc')::numeric, 0) + coalesce((b->>'deliv')::numeric, 0), 0));
  end if;
  perform engine.post(engine.entity_of(o.location_id), 'Refund ' || o.no, o.id, 'Refund penjualan', v_lines, now(), null, me.id);
  -- Saldo kartu deposit dikembalikan
  for p in select * from jsonb_array_elements(v_pays) loop
    if p->>'m' = 'deposit' and p->>'card' is not null then
      update deposit_cards set balance = balance + (p->>'a')::numeric where id = p->>'card';
      insert into deposit_tx (card_id, amount, type, ref, created_by) values (p->>'card', (p->>'a')::numeric, 'return', 'Refund ' || o.no, me.id);
    end if;
  end loop;
  -- Voucher dipakai lagi
  select d into v_vd from jsonb_array_elements(coalesce(b->'discs', '[]'::jsonb)) d where d->>'kind' = 'voucher' limit 1;
  if v_vd is not null then
    update vouchers set used = greatest(0, used - 1), revenue = greatest(0, revenue - o.total), cost = greatest(0, cost - (v_vd->>'amt')::numeric) where code = v_vd->>'code';
  end if;
  -- Member: poin yang didapat ditarik, poin yang ditukar dikembalikan, belanja & kunjungan dikurangi
  if o.member_id is not null and exists (select 1 from members where id = o.member_id) then
    select coalesce(-sum(delta), 0) into v_back from point_tx where order_id = o.id and reason = 'redeem';
    v_delta := v_back - coalesce(o.earned_points, 0);
    update members set points = greatest(0, points + v_delta), spend = greatest(0, spend - coalesce(o.total, 0)), visits = greatest(0, visits - 1) where id = o.member_id;
    if v_delta <> 0 then
      insert into point_tx (member_id, delta, reason, order_id, note, created_by) values (o.member_id, v_delta, 'adjust', o.id, 'Refund bill ' || o.no, me.id);
    end if;
  end if;
  perform engine.flag('Refund bill', 'sedang', 'Bill ' || o.no || coalesce(' (meja ' || o.table_id || ')', '') || ' senilai ' || engine.rp(o.total) || ' di-refund'
    || case when v_cash > 0 then case when p_shift is null then ', tunai ' || engine.rp(v_cash) || ' dari kas outlet' else ', tunai ' || engine.rp(v_cash) || ' dari laci ' || sh.terminal end else '' end
    || '. Alasan: ' || v_reason, me.id, o.id, o.location_id);
  return jsonb_build_object('ok', true, 'no', o.no, 'total', o.total, 'pays', v_pays, 'cash', v_cash, 'shift', case when v_cash > 0 then p_shift end, 'terminal', sh.terminal);
end $$;


-- =====================================================================
-- Kaly Ops · Database Supabase · 04 Keamanan: peran, RLS, penjaga data, realtime, storage
-- ---------------------------------------------------------------------
-- Prinsip:
--  - Aplikasi hanya boleh membaca/menulis sesuai peran staf (owner, kasir, dapur, gudang, service).
--  - Stok, jurnal, poin, saldo deposit, status bayar hanya berubah lewat fungsi server (03_rpc.sql).
--  - Kasir boleh menambah/mengubah item yang masih draft; harga & nama item selalu diambil dari menu.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Fungsi bantu untuk policy
-- ---------------------------------------------------------------------
create or replace function public.is_staff(p_roles text[] default null) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select active and (p_roles is null or role = any(p_roles)) from staff where user_id = auth.uid() limit 1), false);
$$;
create or replace function public.staff_id() returns text language sql stable security definer set search_path = public as $$
  select id from staff where user_id = auth.uid() and active limit 1;
$$;
create or replace function public.can_loc(p_loc text) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select active and (role = 'owner' or outlets is null or cardinality(outlets) = 0 or p_loc = any(outlets)) from staff where user_id = auth.uid() limit 1), false);
$$;
create or replace function public.can_order(p_order text) returns boolean language sql stable security definer set search_path = public as $$
  select public.can_loc((select location_id from orders where id = p_order));
$$;

-- ---------------------------------------------------------------------
-- Trigger: waktu ubah, telepon, sambung akun staf
-- ---------------------------------------------------------------------
create or replace function engine.tg_touch() returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists orders_touch on public.orders;
create trigger orders_touch before update on public.orders for each row execute function engine.tg_touch();
drop trigger if exists menus_touch on public.menus;
create trigger menus_touch before update on public.menus for each row execute function engine.tg_touch();
drop trigger if exists members_touch on public.members;
create trigger members_touch before update on public.members for each row execute function engine.tg_touch();
drop trigger if exists settings_touch on public.settings;
create trigger settings_touch before update on public.settings for each row execute function engine.tg_touch();

-- Akun Supabase Auth baru otomatis tersambung ke baris staff dengan email yang sama
create or replace function engine.tg_link_auth_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.staff set user_id = new.id where lower(email) = lower(new.email) and user_id is null;
  return new;
end $$;
drop trigger if exists kaly_link_staff on auth.users;
create trigger kaly_link_staff after insert or update of email on auth.users for each row execute function engine.tg_link_auth_user();

create or replace function engine.tg_staff_norm() returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.email := lower(trim(new.email));
  if new.user_id is null then select id into new.user_id from auth.users where lower(email) = new.email limit 1; end if;
  return new;
end $$;
drop trigger if exists staff_norm on public.staff;
create trigger staff_norm before insert or update of email on public.staff for each row execute function engine.tg_staff_norm();

-- ---------------------------------------------------------------------
-- Penjaga pesanan
-- ---------------------------------------------------------------------
create or replace function engine.tg_orders_guard() returns trigger language plpgsql security definer set search_path = public as $$
declare me public.staff;
begin
  if engine.is_on() then return new; end if;
  select * into me from staff where user_id = auth.uid() and active;
  if tg_op = 'INSERT' then
    if me.id is null then raise exception 'Akses ditolak' using errcode = '42501'; end if;
    new.channel := 'pos';
    -- Outlet yang punya meja (Resto) wajib memakai meja; outlet tanpa meja (Play Corner) menjual langsung
    if new.table_id is null and exists (select 1 from dining_tables where location_id = new.location_id and active) then
      raise exception 'Pilih meja dulu. Setiap pesanan di outlet ini memakai meja.';
    end if;
    new.type := case when new.table_id is not null then 'dine' else 'take' end;
    new.status := 'open';
    new.biz_day := public.biz_date();
    new.no := engine.next_no(new.location_id, engine.order_prefix('pos', new.location_id));
    new.kitchen_state := 'none';
    new.created_by := me.id;
    new.bill := null; new.total := null; new.paid_at := null; new.paid_by := null; new.shift_id := null;
    new.change_amount := 0; new.tendered := 0; new.earned_points := 0; new.ready_at := null; new.picked_at := null;
    new.void_reason := null; new.void_by := null; new.void_at := null; new.split_from := null; new.merged_into := null;
    new.payment_pending := false; new.released := true; new.scheduled_at := null; new.delivery_fee := 0;
    new.discount := coalesce(new.discount, '{}'::jsonb) - 'manual';
    new.created_at := now();
    return new;
  end if;
  -- UPDATE dari aplikasi: hanya data tamu, meja, member, tipe, voucher/poin, dan status kurir
  if (new.id, new.no, new.biz_day, new.location_id, new.channel, new.status, new.kitchen_state, new.created_by, new.bill, new.total, new.paid_at, new.paid_by,
      new.shift_id, new.change_amount, new.tendered, new.earned_points, new.ready_at, new.picked_at, new.void_reason, new.void_by, new.void_at,
      new.split_from, new.merged_into, new.public_token, new.payment_pending, new.released, new.scheduled_at, new.delivery_fee, new.created_at,
      new.refund_at, new.refund_by, new.refund_reason, new.refund_shift, new.refund_pays)
     is distinct from
     (old.id, old.no, old.biz_day, old.location_id, old.channel, old.status, old.kitchen_state, old.created_by, old.bill, old.total, old.paid_at, old.paid_by,
      old.shift_id, old.change_amount, old.tendered, old.earned_points, old.ready_at, old.picked_at, old.void_reason, old.void_by, old.void_at,
      old.split_from, old.merged_into, old.public_token, old.payment_pending, old.released, old.scheduled_at, old.delivery_fee, old.created_at,
      old.refund_at, old.refund_by, old.refund_reason, old.refund_shift, old.refund_pays) then
    raise exception 'Kolom ini hanya bisa diubah lewat fungsi Kaly Ops (bayar, void, kirim ke dapur)' using errcode = '42501';
  end if;
  if new.table_id is null and old.table_id is not null then
    raise exception 'Bill ini harus tetap memakai meja. Pakai Pindah meja untuk mengganti meja.' using errcode = '42501';
  end if;
  new.type := case when new.table_id is not null then 'dine' when old.type = 'deliv' then 'deliv' else 'take' end;
  if (new.discount->'manual') is distinct from (old.discount->'manual') then
    raise exception 'Diskon manual harus lewat apply_manual_discount (dengan PIN bila perlu)' using errcode = '42501';
  end if;
  if old.status <> 'open' and (new.type, new.table_id, new.merged_tables, new.member_id, new.discount, new.customer_name, new.customer_phone, new.customer_addr)
     is distinct from (old.type, old.table_id, old.merged_tables, old.member_id, old.discount, old.customer_name, old.customer_phone, old.customer_addr) then
    raise exception 'Bill sudah ditutup' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists orders_guard on public.orders;
create trigger orders_guard before insert or update on public.orders for each row execute function engine.tg_orders_guard();

create or replace function engine.tg_order_lines_guard() returns trigger language plpgsql security definer set search_path = public as $$
declare o public.orders; m public.menus; v_block text; v_draft numeric; v_port numeric;
begin
  if engine.is_on() then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then raise exception 'Item sudah dikirim ke dapur. Gunakan void dengan alasan.' using errcode = '42501'; end if;
    return old;
  end if;
  select * into o from orders where id = new.order_id;
  if o.id is null or o.status <> 'open' then raise exception 'Bill sudah ditutup' using errcode = '42501'; end if;
  if tg_op = 'INSERT' then
    if new.parent_line_id is not null then raise exception 'Komponen paket dibuat otomatis' using errcode = '42501'; end if;
    select * into m from menus where id = new.menu_id;
    v_block := engine.menu_block(new.menu_id, o.location_id);
    if v_block is not null then
      raise exception '% %', coalesce(m.name, 'Menu'), case v_block when 'bahan' then 'tidak bisa dipesan: bahan tidak cukup' when 'habis' then 'sedang habis' when 'harga' then 'belum punya harga' else 'tidak dijual di outlet ini' end;
    end if;
    new.name := m.name; new.price := m.price; new.is_package := m.is_package;
    new.station := case when m.is_package then 'none' else m.station end;
    new.status := 'draft'; new.base_qty := null; new.sent_at := null; new.cook_at := null; new.ready_at := null; new.served_at := null;
    new.stock_deducted := false; new.cost := null; new.void_reason := null; new.void_by := null; new.void_at := null; new.slip_at := null;
    new.note := coalesce(new.note, '');
    select coalesce(sum(qty), 0) into v_draft from order_lines where order_id = new.order_id and menu_id = new.menu_id and status = 'draft' and parent_line_id is null;
  else
    if old.status <> 'draft' or new.status <> 'draft' then raise exception 'Item sudah dikirim ke dapur. Gunakan void dengan alasan.' using errcode = '42501'; end if;
    new.order_id := old.order_id; new.menu_id := old.menu_id; new.name := old.name; new.price := old.price; new.station := old.station;
    new.is_package := old.is_package; new.parent_line_id := old.parent_line_id; new.base_qty := old.base_qty;
    new.stock_deducted := false; new.cost := null; new.slip_at := null;
    if new.parent_line_id is not null and new.qty is distinct from old.qty then raise exception 'Jumlah komponen paket mengikuti paketnya' using errcode = '42501'; end if;
    select coalesce(sum(qty), 0) into v_draft from order_lines where order_id = new.order_id and menu_id = new.menu_id and status = 'draft' and parent_line_id is null and id <> old.id;
  end if;
  if (engine.cfg()).stock_guard and new.parent_line_id is null and (tg_op = 'INSERT' or new.qty > old.qty) then
    v_port := engine.menu_portions(new.menu_id, o.location_id);
    if v_port is not null and v_draft + new.qty > v_port then
      raise exception 'Bahan % hanya cukup untuk % porsi', new.name, v_port;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists order_lines_guard on public.order_lines;
create trigger order_lines_guard before insert or update or delete on public.order_lines for each row execute function engine.tg_order_lines_guard();

-- Setelah item berubah: pecah paket, samakan jumlah komponen, perbarui status dapur di pesanan
create or replace function engine.tg_order_lines_sync() returns trigger language plpgsql security definer set search_path = public as $$
declare v_prev text := current_setting('kaly.engine', true); v_order text := coalesce(new.order_id, old.order_id); c record;
begin
  perform set_config('kaly.engine', 'on', true);
  if tg_op = 'INSERT' and new.is_package and new.parent_line_id is null and coalesce(v_prev, '') <> 'on' then
    for c in select p.menu_id, p.qty, mm.name, mm.station from menu_package_items p join menus mm on mm.id = p.menu_id where p.package_id = new.menu_id loop
      insert into order_lines (order_id, menu_id, name, qty, price, status, station, parent_line_id, base_qty)
        values (new.order_id, c.menu_id, c.name, c.qty * new.qty, 0, 'draft', c.station, new.id, c.qty);
    end loop;
  elsif tg_op = 'UPDATE' and new.is_package and new.qty is distinct from old.qty and new.status = 'draft' then
    update order_lines set qty = base_qty * new.qty where parent_line_id = new.id and status = 'draft';
  end if;
  if tg_op = 'UPDATE' and old.order_id <> new.order_id then
    update orders set kitchen_state = engine.kitchen_state(old.order_id) where id = old.order_id;
  end if;
  -- selalu sentuh pesanan (updated_at) supaya perangkat lain tahu ada item yang berubah
  update orders set kitchen_state = engine.kitchen_state(v_order), updated_at = now() where id = v_order;
  perform set_config('kaly.engine', coalesce(v_prev, ''), true);
  return null;
end $$;
drop trigger if exists order_lines_sync on public.order_lines;
create trigger order_lines_sync after insert or update or delete on public.order_lines for each row execute function engine.tg_order_lines_sync();

-- ---------------------------------------------------------------------
-- Penjaga member, stok, kartu deposit, PO, flag
-- ---------------------------------------------------------------------
create or replace function engine.tg_members_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.phone := engine.norm_phone(new.phone);
  if engine.is_on() then return new; end if;
  if tg_op = 'INSERT' then
    new.points := (engine.cfg()).welcome_points; new.spend := 0; new.visits := 0; new.joined_at := now(); new.last_visit_at := null;
  elsif (new.points, new.spend, new.visits, new.last_visit_at, new.joined_at) is distinct from (old.points, old.spend, old.visits, old.last_visit_at, old.joined_at) then
    raise exception 'Poin dan riwayat belanja member hanya berubah lewat transaksi atau penyesuaian Owner' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists members_guard on public.members;
create trigger members_guard before insert or update on public.members for each row execute function engine.tg_members_guard();

create or replace function engine.tg_members_welcome() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not engine.is_on() and new.points > 0 then insert into point_tx (member_id, delta, reason, note, created_by) values (new.id, new.points, 'welcome', 'Daftar member', public.staff_id()); end if;
  return null;
end $$;
drop trigger if exists members_welcome on public.members;
create trigger members_welcome after insert on public.members for each row execute function engine.tg_members_welcome();

create or replace function engine.tg_stock_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if engine.is_on() then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then raise exception 'Baris stok tidak bisa dihapus. Gunakan stock opname.' using errcode = '42501'; end if;
  if tg_op = 'INSERT' then new.qty := 0; new.avg_cost := engine.std_cost(new.item_id); return new; end if;
  if (new.qty, new.avg_cost, new.location_id, new.item_id) is distinct from (old.qty, old.avg_cost, old.location_id, old.item_id) then
    raise exception 'Jumlah stok hanya berubah lewat penjualan, penerimaan barang, mutasi, produksi, atau stock opname' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists stock_guard on public.stock;
create trigger stock_guard before insert or update or delete on public.stock for each row execute function engine.tg_stock_guard();

create or replace function engine.tg_deposit_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if engine.is_on() then return new; end if;
  if tg_op = 'INSERT' then new.balance := 0; new.phone := engine.norm_phone(new.phone); return new; end if;
  if new.balance is distinct from old.balance then raise exception 'Saldo kartu hanya berubah lewat top-up, pembayaran, atau refund' using errcode = '42501'; end if;
  return new;
end $$;
drop trigger if exists deposit_guard on public.deposit_cards;
create trigger deposit_guard before insert or update on public.deposit_cards for each row execute function engine.tg_deposit_guard();

create or replace function engine.tg_po_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if engine.is_on() then return new; end if;
  if tg_op = 'INSERT' then raise exception 'Buat PO lewat fungsi po_create' using errcode = '42501'; end if;
  if old.status <> 'draft' or (new.status, new.no, new.entity_id, new.approved_by, new.approved_at, new.received_by, new.received_at, new.invoice_no, new.paid_by, new.paid_at, new.fee, new.flags, new.total, new.created_by)
     is distinct from (old.status, old.no, old.entity_id, old.approved_by, old.approved_at, old.received_by, old.received_at, old.invoice_no, old.paid_by, old.paid_at, old.fee, old.flags, old.total, old.created_by) then
    raise exception 'Status PO hanya berubah lewat ajukan, setujui, terima, dan bayar' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists po_guard on public.purchase_orders;
create trigger po_guard before insert or update on public.purchase_orders for each row execute function engine.tg_po_guard();

create or replace function engine.tg_po_lines_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if engine.is_on() then return coalesce(new, old); end if;
  if (select status from purchase_orders where id = coalesce(new.po_id, old.po_id)) <> 'draft' then raise exception 'Barang hanya bisa diubah selama PO masih draft' using errcode = '42501'; end if;
  if tg_op <> 'DELETE' then new.received_qty := 0; end if;
  return coalesce(new, old);
end $$;
drop trigger if exists po_lines_guard on public.purchase_order_lines;
create trigger po_lines_guard before insert or update or delete on public.purchase_order_lines for each row execute function engine.tg_po_lines_guard();

create or replace function engine.tg_flags_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if engine.is_on() then return new; end if;
  if (new.at, new.type, new.severity, new.message, new.staff_id, new.ref, new.location_id) is distinct from (old.at, old.type, old.severity, old.message, old.staff_id, old.ref, old.location_id) then
    raise exception 'Isi temuan tidak bisa diubah, hanya statusnya' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists flags_guard on public.fraud_flags;
create trigger flags_guard before update on public.fraud_flags for each row execute function engine.tg_flags_guard();

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['settings', 'app_secrets', 'entities', 'locations', 'accounts', 'staff', 'areas', 'dining_tables', 'items', 'item_bom',
    'menu_categories', 'menus', 'menu_outlets', 'menu_bom', 'menu_package_items', 'stock', 'stock_moves', 'productions', 'tiers', 'missions', 'members',
    'member_missions', 'point_tx', 'promos', 'campaigns', 'vouchers', 'deposit_cards', 'deposit_tx', 'suppliers', 'supplier_prices', 'item_suppliers',
    'purchase_orders', 'purchase_order_lines', 'transfers', 'transfer_lines', 'opnames', 'opname_lines', 'b2b_invoices', 'b2b_lines', 'shifts', 'counters',
    'reservations', 'orders', 'order_lines', 'order_payments', 'order_notices', 'journals', 'journal_lines', 'fraud_flags'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- Membuat policy dengan aman saat skrip dijalankan ulang
create or replace function engine.policy(p_table text, p_name text, p_cmd text, p_using text, p_check text default null) returns void language plpgsql set search_path = public as $$
begin
  execute format('drop policy if exists %I on public.%I', p_name, p_table);
  execute format('create policy %I on public.%I for %s to authenticated %s %s', p_name, p_table, p_cmd,
    case when p_cmd in ('insert') then '' else 'using (' || p_using || ')' end,
    case when p_cmd in ('insert', 'update', 'all') then 'with check (' || coalesce(p_check, p_using) || ')' else '' end);
end $$;

do $$
declare
  t text;
  staff_all text := 'public.is_staff()';
  owner_only text := 'public.is_staff(array[''owner''])';
  owner_gudang text := 'public.is_staff(array[''owner'',''gudang''])';
  front text := 'public.is_staff(array[''owner'',''kasir'',''service''])';
  cashier text := 'public.is_staff(array[''owner'',''kasir''])';
begin
  -- Data master: semua staf boleh baca, yang mengubah sesuai peran
  foreach t in array array['settings', 'entities', 'locations', 'accounts', 'staff', 'areas', 'dining_tables', 'menu_categories', 'menus', 'menu_outlets',
                           'menu_bom', 'menu_package_items', 'tiers', 'missions', 'promos', 'vouchers', 'campaigns'] loop
    perform engine.policy(t, 'staf baca', 'select', staff_all);
    perform engine.policy(t, 'owner tambah', 'insert', null, owner_only);
    perform engine.policy(t, 'owner ubah', 'update', owner_only);
    perform engine.policy(t, 'owner hapus', 'delete', owner_only);
  end loop;
  foreach t in array array['items', 'item_bom', 'suppliers', 'supplier_prices', 'item_suppliers'] loop
    perform engine.policy(t, 'staf baca', 'select', case when t like 'supplier%' or t = 'item_suppliers' then owner_gudang else staff_all end);
    perform engine.policy(t, 'gudang tambah', 'insert', null, owner_gudang);
    perform engine.policy(t, 'gudang ubah', 'update', owner_gudang);
    perform engine.policy(t, 'gudang hapus', 'delete', owner_gudang);
  end loop;

  -- Stok: semua staf baca; Owner/Gudang boleh mengatur stok minimum (jumlah dijaga trigger)
  perform engine.policy('stock', 'staf baca', 'select', staff_all);
  perform engine.policy('stock', 'gudang tambah', 'insert', null, owner_gudang);
  perform engine.policy('stock', 'gudang ubah minimum', 'update', owner_gudang);
  perform engine.policy('stock_moves', 'gudang baca', 'select', 'public.is_staff(array[''owner'',''gudang'',''dapur''])');
  perform engine.policy('productions', 'gudang baca', 'select', 'public.is_staff(array[''owner'',''gudang'',''dapur''])');
  foreach t in array array['transfers', 'transfer_lines'] loop perform engine.policy(t, 'baca', 'select', 'public.is_staff(array[''owner'',''gudang'',''kasir''])'); end loop;
  foreach t in array array['opnames', 'opname_lines', 'b2b_invoices', 'b2b_lines'] loop perform engine.policy(t, 'baca', 'select', owner_gudang); end loop;

  -- Pembelian: Owner & Gudang; status dijaga trigger + fungsi
  foreach t in array array['purchase_orders', 'purchase_order_lines'] loop
    perform engine.policy(t, 'baca', 'select', owner_gudang);
    perform engine.policy(t, 'ubah draft', 'update', owner_gudang);
    perform engine.policy(t, 'hapus draft', 'delete', owner_gudang || ' and ' || case when t = 'purchase_orders' then 'status = ''draft''' else '(select status from public.purchase_orders p where p.id = po_id) = ''draft''' end);
  end loop;
  perform engine.policy('purchase_order_lines', 'tambah draft', 'insert', null, owner_gudang);

  -- Member & loyalty
  perform engine.policy('members', 'baca', 'select', front);
  perform engine.policy('members', 'daftar', 'insert', null, front);
  perform engine.policy('members', 'ubah data', 'update', cashier);
  perform engine.policy('members', 'hapus', 'delete', owner_only);
  perform engine.policy('member_missions', 'baca', 'select', cashier);
  perform engine.policy('point_tx', 'baca', 'select', cashier);

  -- Kartu deposit
  perform engine.policy('deposit_cards', 'baca', 'select', cashier);
  perform engine.policy('deposit_cards', 'buat', 'insert', null, cashier);
  perform engine.policy('deposit_cards', 'ubah data', 'update', cashier);
  perform engine.policy('deposit_tx', 'baca', 'select', cashier);

  -- Shift & pembayaran
  perform engine.policy('shifts', 'baca', 'select', cashier);
  perform engine.policy('order_payments', 'baca', 'select', cashier);

  -- Reservasi
  perform engine.policy('reservations', 'staf baca', 'select', staff_all);
  perform engine.policy('reservations', 'tambah', 'insert', null, front);
  perform engine.policy('reservations', 'ubah', 'update', front);
  perform engine.policy('reservations', 'hapus', 'delete', owner_only);

  -- Pesanan: sesuai outlet yang boleh diakses staf
  perform engine.policy('orders', 'baca', 'select', staff_all || ' and public.can_loc(location_id)');
  perform engine.policy('orders', 'buat', 'insert', null, front || ' and public.can_loc(location_id)');
  perform engine.policy('orders', 'ubah', 'update', front || ' and public.can_loc(location_id)');
  perform engine.policy('order_lines', 'baca', 'select', staff_all || ' and public.can_order(order_id)');
  perform engine.policy('order_lines', 'tambah', 'insert', null, front || ' and public.can_order(order_id)');
  perform engine.policy('order_lines', 'ubah draft', 'update', front || ' and public.can_order(order_id)');
  perform engine.policy('order_lines', 'hapus draft', 'delete', front || ' and public.can_order(order_id)');
  perform engine.policy('order_notices', 'baca', 'select', staff_all);
  perform engine.policy('order_notices', 'tandai dibaca', 'update', staff_all);

  -- Pembukuan & kontrol: Owner
  perform engine.policy('journals', 'owner baca', 'select', owner_only);
  perform engine.policy('journal_lines', 'owner baca', 'select', owner_only);
  perform engine.policy('fraud_flags', 'owner baca', 'select', owner_only);
  perform engine.policy('fraud_flags', 'owner tandai', 'update', owner_only);
  -- app_secrets & counters: tanpa policy = tidak bisa dibaca aplikasi
end $$;

-- ---------------------------------------------------------------------
-- Hak akses
-- ---------------------------------------------------------------------
grant usage on schema public to anon, authenticated;
revoke all on all tables in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke all on public.app_secrets, public.counters from authenticated;
grant usage, select on all sequences in schema public to authenticated;

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
grant execute on function public.public_menu(text), public.public_place_order(jsonb), public.public_track(uuid), public.public_book(jsonb),
  public.public_slots(date, int, text), public.public_member(text), public.is_staff(text[]), public.can_loc(text), public.biz_date(timestamptz),
  public.biz_ts(timestamptz), public.new_id(text) to anon;
grant execute on function public.public_lounge(text), public.public_register_member(jsonb), public.public_loop(text), public.public_book_info(),
  public.public_order_ctx(text, text, text), public.public_reco(text[], text), public.public_quote(jsonb) to anon;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema public to service_role;
    grant execute on function public.confirm_online_payment(text, numeric, text), public.release_due_orders() to service_role;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2.12 · Realtime TIDAK dipakai: aplikasi memuat ulang data lewat sync_poll (refresh berkala).
-- Tabel Kaly Ops dikeluarkan dari publikasi supabase_realtime (lihat bagian 2.12 di akhir file).

-- ---------------------------------------------------------------------
-- Storage: foto menu (baca publik, unggah oleh Owner)
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') and to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('menu-images', 'menu-images', true) on conflict (id) do nothing;
    begin
      drop policy if exists "kaly menu images read" on storage.objects;
      create policy "kaly menu images read" on storage.objects for select using (bucket_id = 'menu-images');
      drop policy if exists "kaly menu images write" on storage.objects;
      create policy "kaly menu images write" on storage.objects for insert to authenticated with check (bucket_id = 'menu-images' and public.is_staff(array['owner']));
      drop policy if exists "kaly menu images update" on storage.objects;
      create policy "kaly menu images update" on storage.objects for update to authenticated using (bucket_id = 'menu-images' and public.is_staff(array['owner']));
      drop policy if exists "kaly menu images delete" on storage.objects;
      create policy "kaly menu images delete" on storage.objects for delete to authenticated using (bucket_id = 'menu-images' and public.is_staff(array['owner']));
    exception when insufficient_privilege then
      raise notice 'Policy storage tidak bisa dibuat lewat SQL di project ini. Buat manual di Storage > Policies (lihat README).';
    end;
  end if;
end $$;

-- =====================================================================
-- Versi 1.1: sinkron antar perangkat & pengaman akun staf
-- =====================================================================
-- Setiap perubahan tabel dicatat (nama tabel saja) di sync_log. Aplikasi membaca catatan ini lewat realtime
-- atau sync_poll untuk memuat ulang data yang berubah. Catatan lebih dari 1 jam dihapus otomatis.
create or replace function engine.tg_sync_log() returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- satu catatan per tabel per transaksi sudah cukup untuk memberi tahu perangkat lain
  if current_setting('kaly.sl_' || tg_table_name, true) = '1' then return null; end if;
  perform set_config('kaly.sl_' || tg_table_name, '1', true);
  insert into public.sync_log (tbl) values (tg_table_name);
  if random() < 0.02 then delete from public.sync_log where at < clock_timestamp() - interval '1 hour'; end if;
  return null;
end $$;
do $$
declare t text;
begin
  foreach t in array array['settings', 'entities', 'locations', 'accounts', 'staff', 'areas', 'dining_tables', 'items', 'item_bom',
    'menu_categories', 'menus', 'menu_outlets', 'menu_bom', 'menu_package_items', 'stock', 'stock_moves', 'productions', 'tiers', 'missions', 'members',
    'member_missions', 'point_tx', 'promos', 'campaigns', 'vouchers', 'deposit_cards', 'deposit_tx', 'suppliers', 'supplier_prices', 'item_suppliers',
    'purchase_orders', 'purchase_order_lines', 'transfers', 'transfer_lines', 'opnames', 'opname_lines', 'b2b_invoices', 'b2b_lines', 'shifts',
    'reservations', 'orders', 'order_lines', 'order_payments', 'order_notices', 'journals', 'journal_lines', 'fraud_flags'] loop
    execute format('drop trigger if exists sync_log on public.%I', t);
    execute format('create trigger sync_log after insert or update or delete on public.%I for each statement execute function engine.tg_sync_log()', t);
  end loop;
end $$;
alter table public.sync_log enable row level security;
select engine.policy('sync_log', 'staf baca', 'select', 'public.is_staff()');
revoke all on public.sync_log from anon;
revoke insert, update, delete on public.sync_log from authenticated;
grant select on public.sync_log to authenticated;


-- Akun staf: harus selalu ada minimal satu Owner aktif yang sudah punya login, supaya pengaturan tidak terkunci
create or replace function engine.tg_staff_owner_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if engine.is_on() then return null; end if;
  if not exists (select 1 from staff where role = 'owner' and active) then
    raise exception 'Minimal harus ada satu Owner aktif' using errcode = '42501';
  end if;
  return null;
end $$;
drop trigger if exists staff_owner_guard on public.staff;
create trigger staff_owner_guard after update or delete on public.staff for each statement execute function engine.tg_staff_owner_guard();

-- Hapus baris staf contoh dari paket lama (email @kaly.id) yang belum punya login dan belum pernah dipakai transaksi
create or replace function engine.drop_placeholder_staff() returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in select id, role from staff
           where email in ('owner@kaly.id', 'kasir@kaly.id', 'kasir2@kaly.id', 'play@kaly.id', 'service@kaly.id', 'dapur@kaly.id', 'gudang@kaly.id') and user_id is null
           order by (role = 'owner') loop
    if r.role = 'owner' and not exists (select 1 from staff where role = 'owner' and active and id <> r.id) then continue; end if;
    begin delete from staff where id = r.id; n := n + 1; exception when others then null; end;
  end loop;
  return n;
end $$;
revoke all on function engine.drop_placeholder_staff() from public;

-- Owner pertama. Jalankan sekali di SQL Editor (hanya bisa dari dashboard Supabase, tidak bisa dari aplikasi):
--   select public.kaly_setup_owner('emailanda@gmail.com', 'Nama Anda');
-- Lalu buat akun login dengan email yang sama di Authentication → Users → Add user (centang Auto Confirm User).
create or replace function public.kaly_setup_owner(p_email text, p_name text default 'Owner') returns text
language plpgsql security definer set search_path = public as $$
declare v_email text := lower(trim(coalesce(p_email, ''))); v_name text := coalesce(nullif(trim(p_name), ''), 'Owner'); v_id text; v_uid uuid;
begin
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'Email tidak valid: %', coalesce(p_email, '(kosong)'); end if;
  select id into v_id from staff where lower(email) = v_email;
  if v_id is null then
    insert into staff (email, name, role, active) values (v_email, v_name, 'owner', true) returning id into v_id;
  else
    update staff set role = 'owner', active = true, outlets = null, name = v_name where id = v_id;
  end if;
  select id into v_uid from auth.users where lower(email) = v_email limit 1;
  if v_uid is not null then update staff set user_id = v_uid where id = v_id and user_id is null; end if;
  perform engine.drop_placeholder_staff();
  return case when v_uid is null
    then 'Owner ' || v_email || ' siap. Sekarang buat akun loginnya di Authentication → Users → Add user dengan email yang sama.'
    else 'Owner ' || v_email || ' siap dan sudah tersambung ke akun login. Silakan masuk di Kaly Ops.' end;
end $$;
revoke all on function public.kaly_setup_owner(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 1.2 · Notifikasi staf
-- ---------------------------------------------------------------------
alter table public.staff_alerts enable row level security;
select engine.policy('staff_alerts', 'staf baca', 'select', 'public.is_staff() and (location_id is null or public.can_loc(location_id))');
revoke all on public.staff_alerts from anon;
-- 1.4 · riwayat aktivitas meja: hanya Owner yang membaca langsung; ditulis oleh fungsi Kaly Ops
alter table public.table_events enable row level security;
select engine.policy('table_events', 'owner baca', 'select', 'public.is_staff(array[''owner'']) and public.can_loc(location_id)');
revoke all on public.table_events from anon;
revoke insert, update, delete on public.table_events from authenticated;
grant select on public.table_events to authenticated;
revoke insert, update, delete on public.staff_alerts from authenticated;
grant select on public.staff_alerts to authenticated;
drop trigger if exists sync_log on public.staff_alerts;
create trigger sync_log after insert or update or delete on public.staff_alerts for each statement execute function engine.tg_sync_log();

-- PO diajukan → Owner; PO disetujui/ditolak → gudang
create or replace function engine.tg_alert_po() returns trigger language plpgsql security definer set search_path = public as $$
declare v_sup text;
begin
  if new.status is distinct from old.status and new.status in ('diajukan', 'disetujui', 'ditolak') then
    select name into v_sup from suppliers where id = new.supplier_id;
    perform engine.alert(case when new.status = 'diajukan' then 'po_wait' else 'po_done' end, new.location_id,
      new.no || case new.status when 'diajukan' then ' menunggu persetujuan' when 'disetujui' then ' disetujui' else ' ditolak' end,
      coalesce(v_sup, 'Supplier') || ' · ' || engine.rp(coalesce(new.total, 0)), null, null, new.id);
  end if;
  return null;
end $$;
drop trigger if exists alert_po on public.purchase_orders;
create trigger alert_po after update of status on public.purchase_orders for each row execute function engine.tg_alert_po();

-- Mutasi dikirim → gudang/outlet tujuan
create or replace function engine.tg_alert_transfer() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform engine.alert('tf_in', new.to_location, 'Mutasi masuk ' || new.no,
    'Dari ' || coalesce((select name from locations where id = new.from_location), new.from_location) || '. Terima dan cek jumlahnya di Kaly Core.', null, null, new.id);
  return null;
end $$;
drop trigger if exists alert_transfer on public.transfers;
create trigger alert_transfer after insert on public.transfers for each row execute function engine.tg_alert_transfer();

-- Temuan fraud baru → Owner
create or replace function engine.tg_alert_fraud() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform engine.alert('fraud', new.location_id, 'Temuan fraud baru' || case when new.severity = 'tinggi' then ' (tinggi)' else '' end, new.message, null, null, new.id);
  return null;
end $$;
drop trigger if exists alert_fraud on public.fraud_flags;
create trigger alert_fraud after insert on public.fraud_flags for each row execute function engine.tg_alert_fraud();

-- Reservasi dari pelanggan (halaman reservasi) → kasir, service, owner
create or replace function engine.tg_alert_reservation() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    perform engine.alert('res_new', 'L1', 'Reservasi baru · ' || new.name,
      new.pax || ' orang · ' || to_char(new.date, 'DD/MM') || ' pukul ' || to_char(new.time, 'HH24:MI') || coalesce(' · meja ' || new.table_id, '') || case when new.status = 'menunggu' then '. Perlu dikonfirmasi.' else '.' end,
      null, new.table_id, new.id);
  end if;
  return null;
end $$;
drop trigger if exists alert_reservation on public.reservations;
create trigger alert_reservation after insert on public.reservations for each row execute function engine.tg_alert_reservation();

-- Stok turun di bawah minimum → gudang & owner (paling banyak sekali per 12 jam per bahan)
create or replace function engine.tg_alert_stock() returns trigger language plpgsql security definer set search_path = public as $$
declare v_name text; v_unit text;
begin
  if new.min_qty > 0 and old.qty >= new.min_qty and new.qty < new.min_qty
     and not exists (select 1 from staff_alerts where kind = 'stock_low' and ref = new.item_id and location_id = new.location_id and at > now() - interval '12 hours') then
    select name, unit into v_name, v_unit from items where id = new.item_id;
    perform engine.alert('stock_low', new.location_id, 'Stok ' || coalesce(v_name, new.item_id) || ' menipis',
      'Sisa ' || trim_scale(round(new.qty, 2))::text || ' ' || coalesce(v_unit, '') || ', minimum ' || trim_scale(new.min_qty)::text || '.', null, null, new.item_id);
  end if;
  return null;
end $$;
drop trigger if exists alert_stock on public.stock;
create trigger alert_stock after update of qty on public.stock for each row execute function engine.tg_alert_stock();

-- Bill baru dibuka (atau meja dipindah/digabung) di meja yang Sudah bayar → meja otomatis dianggap terisi lagi
create or replace function engine.tg_orders_table_hold() returns trigger language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if new.table_id is not null and new.status = 'open' then
    for r in select id, location_id, hold_order from dining_tables
              where hold_order is not null and (id = new.table_id or id = any(new.merged_tables)) order by id for update loop
      update dining_tables set hold_order = null, hold_at = null where id = r.id;
      perform engine.table_event(r.location_id, r.id, 'clear', r.hold_order, null, coalesce(public.staff_id(), new.created_by), 0, 'otomatis: bill baru dibuka');
    end loop;
  end if;
  return null;
end $$;
drop trigger if exists orders_table_hold on public.orders;
create trigger orders_table_hold after insert or update of table_id, merged_tables on public.orders for each row execute function engine.tg_orders_table_hold();
revoke all on function engine.alert(text, text, text, text, text, text, text), engine.tg_alert_po(), engine.tg_alert_transfer(), engine.tg_alert_fraud(),
  engine.tg_alert_reservation(), engine.tg_alert_stock(), engine.tg_orders_table_hold() from public;

-- ---------------------------------------------------------------------
-- 2.1 · Printer & stasiun cetak: semua staf outlet itu boleh membaca; perubahan hanya lewat fungsi print_*
-- ---------------------------------------------------------------------
alter table public.print_stations enable row level security;
alter table public.print_station_seen enable row level security;
alter table public.print_jobs enable row level security;
select engine.policy('print_stations', 'staf baca', 'select', 'public.is_staff() and public.can_loc(location_id)');
select engine.policy('print_station_seen', 'staf baca', 'select', 'public.is_staff() and public.can_loc((select p.location_id from public.print_stations p where p.id = station_id))');
select engine.policy('print_jobs', 'staf baca', 'select', 'public.is_staff() and public.can_loc(location_id)');
revoke all on public.print_stations, public.print_station_seen, public.print_jobs from anon;
revoke insert, update, delete, truncate on public.print_stations, public.print_station_seen, public.print_jobs from authenticated;
grant select on public.print_stations, public.print_station_seen, public.print_jobs to authenticated;
drop trigger if exists sync_log on public.print_stations;
create trigger sync_log after insert or update or delete on public.print_stations for each statement execute function engine.tg_sync_log();
drop trigger if exists sync_log on public.print_jobs;
create trigger sync_log after insert or update or delete on public.print_jobs for each statement execute function engine.tg_sync_log();
revoke all on function engine.print_staff() from public;
revoke execute on function public.print_station_save(text, text, text, boolean, text, int, int, text, text, text, text), public.print_enqueue(jsonb), public.print_claim(text),
  public.print_done(bigint[], boolean, text), public.print_retry(bigint), public.print_cancel(bigint[]) from public, anon;
grant execute on function public.print_station_save(text, text, text, boolean, text, int, int, text, text, text, text), public.print_enqueue(jsonb), public.print_claim(text),
  public.print_done(bigint[], boolean, text), public.print_retry(bigint), public.print_cancel(bigint[]) to authenticated;

-- ---------------------------------------------------------------------
-- 2.4 · Notifikasi di perangkat: jenis baru untuk Owner/Manajer, hak baca per peran, Web Push lewat Edge Function
-- ---------------------------------------------------------------------
-- Notifikasi sensitif (fraud, shift, keuangan, stok) hanya terbaca peran yang berhak
select engine.policy('staff_alerts', 'staf baca', 'select',
  'public.is_staff() and (location_id is null or public.can_loc(location_id)) and (public.alert_roles(kind) is null or public.is_staff(public.alert_roles(kind)))');

create or replace function engine.pay_label(p_method text) returns text language sql immutable set search_path = '' as $$
  select case p_method when 'cash' then 'Tunai' when 'qris' then 'QRIS' when 'card' then 'Kartu' when 'transfer' then 'Transfer' when 'deposit' then 'Deposit' else initcap(p_method) end;
$$;

-- Shift dibuka / ditutup → Owner; semua shift outlet ditutup → ringkasan penjualan hari itu
create or replace function engine.tg_alert_shift() returns trigger language plpgsql security definer set search_path = public as $$
declare v_name text; v_sum jsonb; v_by jsonb; v_n int; v_tot numeric; v_pay text;
begin
  v_name := coalesce(new.crew_name, (select name from staff where id = new.staff_id));
  if tg_op = 'INSERT' then
    perform engine.alert('shift_open', new.location_id, 'Shift ' || new.terminal || ' dibuka · ' || coalesce(v_name, ''), 'Modal kas ' || engine.rp(new.open_cash) || '.', null, null, new.id);
    return null;
  end if;
  if old.close_at is null and new.close_at is not null then
    v_sum := engine.shift_summary(new.id);
    v_by := coalesce(v_sum->'by', '{}'::jsonb);
    perform engine.alert('shift_close', new.location_id, 'Shift ' || new.terminal || ' ditutup · ' || coalesce(v_name, ''),
      (v_sum->>'count') || ' transaksi · penjualan ' || engine.rp((v_sum->>'total')::numeric) || ' · tunai ' || engine.rp(coalesce((v_by->>'cash')::numeric, 0))
        || ' · selisih kas ' || engine.rp(coalesce(new.variance, 0))
        || case when coalesce((v_sum->>'voids')::int, 0) > 0 then ' · ' || (v_sum->>'voids') || ' bill batal' else '' end || '.',
      null, null, new.id);
    if not exists (select 1 from shifts where location_id = new.location_id and close_at is null) then
      select count(*), coalesce(sum(total), 0) into v_n, v_tot from orders
       where location_id = new.location_id and status = 'paid' and public.biz_date(paid_at) = public.biz_date();
      select string_agg(engine.pay_label(m) || ' ' || engine.rp(a), ' · ' order by a desc) into v_pay
        from (select p.method m, sum(p.amount) a from order_payments p join orders o on o.id = p.order_id
               where o.location_id = new.location_id and o.status = 'paid' and public.biz_date(o.paid_at) = public.biz_date() group by p.method) x;
      perform engine.alert('day_close', new.location_id, 'Semua shift ' || coalesce((select name from locations where id = new.location_id), '') || ' sudah ditutup',
        'Penjualan hari ini ' || engine.rp(v_tot) || ' dari ' || v_n || ' transaksi'
          || case when v_n > 0 then ' (rata-rata ' || engine.rp(round(v_tot / v_n)) || ')' else '' end || coalesce('. ' || v_pay, '') || '.',
        null, null, new.id);
    end if;
  end if;
  return null;
end $$;
drop trigger if exists alert_shift on public.shifts;
create trigger alert_shift after insert or update of close_at on public.shifts for each row execute function engine.tg_alert_shift();

-- PO: diajukan → Owner; disetujui/ditolak → gudang; diterima → bahan masuk (Owner & gudang); dibayar → keuangan (Owner)
create or replace function engine.tg_alert_po() returns trigger language plpgsql security definer set search_path = public as $$
declare v_sup text;
begin
  if new.status is distinct from old.status and new.status in ('diajukan', 'disetujui', 'ditolak', 'diterima', 'dibayar') then
    select name into v_sup from suppliers where id = new.supplier_id;
    if new.status = 'diterima' then
      perform engine.alert('po_recv', new.location_id, new.no || ' diterima · ' || coalesce((select name from locations where id = new.location_id), ''),
        coalesce(v_sup, 'Supplier') || ' · ' || (select count(*) from purchase_order_lines where po_id = new.id) || ' bahan · ' || engine.rp(coalesce(new.total, 0))
          || coalesce(' · faktur ' || nullif(new.invoice_no, ''), '') || '. Stok bahan sudah bertambah.', null, null, new.id);
    elsif new.status = 'dibayar' then
      perform engine.alert('po_paid', new.location_id, 'Pembayaran supplier ' || new.no, engine.rp(coalesce(new.total, 0)) || ' ke ' || coalesce(v_sup, 'supplier') || '.', null, null, new.id);
    else
      perform engine.alert(case when new.status = 'diajukan' then 'po_wait' else 'po_done' end, new.location_id,
        new.no || case new.status when 'diajukan' then ' menunggu persetujuan' when 'disetujui' then ' disetujui' else ' ditolak' end,
        coalesce(v_sup, 'Supplier') || ' · ' || engine.rp(coalesce(new.total, 0)), null, null, new.id);
    end if;
  end if;
  return null;
end $$;

-- Stock opname selesai → Owner & gudang
create or replace function engine.tg_alert_opname() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform engine.alert('opname', new.location_id, 'Stock opname ' || new.no || ' selesai',
    coalesce((select name from locations where id = new.location_id), '') || ' · ' || (select count(*) from opname_lines where opname_id = new.id) || ' bahan dihitung · selisih '
      || case when new.total > 0 then '+' else '' end || engine.rp(new.total) || '.', null, null, new.id);
  return null;
end $$;
drop trigger if exists alert_opname on public.opnames;
create trigger alert_opname after update of total on public.opnames for each row execute function engine.tg_alert_opname();

-- Web Push: setiap notifikasi baru dikirim ke Edge Function kaly-push (bila sudah disambungkan & ada perangkat yang memilihnya)
do $$ begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    -- Supabase menyarankan ekstensi di skema "extensions" (fungsi pg_net sendiri tetap di skema net)
    if exists (select 1 from pg_namespace where nspname = 'extensions') then
      if exists (select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_net' and n.nspname = 'public') then
        drop extension pg_net;   -- 2.4 awal memasangnya di public; dipindah (antrean kosong, tidak ada data yang hilang)
      end if;
      create extension if not exists pg_net with schema extensions;
    else
      create extension if not exists pg_net;
    end if;
  end if;
exception when others then raise notice 'pg_net belum bisa diaktifkan: %', sqlerrm;
end $$;
create or replace function engine.tg_push() returns trigger language plpgsql security definer set search_path = public as $$
declare v_url text;
begin
  select push_url into v_url from settings where id = 1;
  if v_url is null or not exists (select 1 from push_subscriptions where new.kind = any(kinds) or (new.kind = 'push_test' and staff_id = new.ref)) then return null; end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then return null; end if;
  -- 2.12: API Vercel memerlukan rahasia bersama di header x-kaly-secret (Edge Function lama mengabaikannya)
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 5000)'
    using v_url, jsonb_build_object('id', new.id),
      jsonb_build_object('Content-Type', 'application/json', 'x-kaly-secret', coalesce((select push_secret from app_secrets where id = 1), ''));
  return null;
exception when others then return null;   -- notifikasi tidak pernah menggagalkan transaksi
end $$;
drop trigger if exists push_alert on public.staff_alerts;
create trigger push_alert after insert on public.staff_alerts for each row execute function engine.tg_push();

alter table public.push_subscriptions enable row level security;
alter table public.push_log enable row level security;
revoke all on public.push_subscriptions, public.push_log from anon, authenticated;
revoke all on function engine.tg_alert_shift(), engine.tg_alert_opname(), engine.tg_push(), engine.pay_label(text) from public;
-- Fungsi khusus Edge Function (kunci service_role), tidak bisa dipanggil aplikasi
revoke execute on function public.push_targets(bigint), public.push_result(bigint, bigint[], bigint[], int), public.push_vapid(), public.push_vapid_save(text, jsonb) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.push_targets(bigint), public.push_result(bigint, bigint[], bigint[], int), public.push_vapid(), public.push_vapid_save(text, jsonb) to service_role;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2.5 · Notifikasi untuk layar dapur dari kasir
-- k_new  pesanan baru masuk dapur       k_add  tambahan item di nota yang sudah di dapur
-- k_void item yang sudah di dapur dibatalkan kasir (item atau seluruh bill)
-- k_move nota berubah: pindah meja, split bill, gabung bill
-- Satu notifikasi per nota per stasiun (Dapur / Bar); stasiun disimpan di kolom ref supaya layar Bar
-- hanya menerima item Bar. Hanya Owner & dapur yang bisa membacanya (alert_roles).
-- ---------------------------------------------------------------------
create or replace function engine.k_where(o public.orders) returns text language sql stable set search_path = public as $$
  select case when o.table_id is not null
    then 'Meja ' || array_to_string(array[o.table_id] || coalesce(o.merged_tables, '{}'::text[]), '+') || ' · ' || o.no
    else o.no || coalesce(' · ' || nullif(o.customer_name, ''), '') end;
$$;
create or replace function engine.k_item(p_qty numeric, p_name text, p_note text) returns text language sql immutable set search_path = '' as $$
  select trim(trailing '.' from to_char(p_qty, 'FM999990.##')) || '× ' || coalesce(p_name, '') || coalesce(' (' || nullif(trim(p_note), '') || ')', '');
$$;
create or replace function engine.k_station(p text) returns text language sql immutable set search_path = '' as $$
  select case p when 'bar' then 'Bar' else 'Dapur' end;
$$;

-- Perubahan item: dikirim ke dapur, dibatalkan, atau pindah nota (satu kali per perintah, bukan per baris)
create or replace function engine.tg_kitchen_lines_upd() returns trigger language plpgsql security definer set search_path = public as $$
declare r record; o public.orders; a public.orders; v_sent text[]; v_prev boolean; v_who text; v_all boolean;
begin
  select coalesce(array_agg(n.id), '{}') into v_sent from new_rows n join old_rows p on p.id = n.id where p.status = 'draft' and n.status <> 'draft';
  -- 1. Pesanan baru / tambahan
  if cardinality(v_sent) > 0 then
    for r in select n.order_id, n.station, string_agg(engine.k_item(n.qty, n.name, n.note), ' · ' order by n.sort) items
               from new_rows n join old_rows p on p.id = n.id
              where p.status = 'draft' and n.status = 'new' and n.station in ('dapur', 'bar')
              group by n.order_id, n.station loop
      select * into o from orders where id = r.order_id;
      select exists (select 1 from order_lines x where x.order_id = r.order_id and x.station in ('dapur', 'bar') and x.sent_at is not null
                     and x.status <> 'draft' and not (x.id = any(v_sent))) into v_prev;
      perform engine.alert(case when v_prev then 'k_add' else 'k_new' end, o.location_id,
        (case when v_prev then 'Tambahan · ' else 'Pesanan baru · ' end) || engine.k_where(o),
        engine.k_station(r.station) || ': ' || r.items, o.id, o.table_id, r.station);
    end loop;
  end if;
  -- 2. Pembatalan item yang sudah di dapur
  for r in select n.order_id, n.station, string_agg(engine.k_item(n.qty, n.name, n.note), ' · ' order by n.sort) items,
                  max(n.void_reason) reason, max(n.void_by) by_, bool_and(p.status = 'ready') all_ready
             from new_rows n join old_rows p on p.id = n.id
            where p.status in ('new', 'cook', 'ready') and n.status = 'void' and n.station in ('dapur', 'bar')
            group by n.order_id, n.station loop
    select * into o from orders where id = r.order_id;
    select name into v_who from staff where id = r.by_;
    v_all := not exists (select 1 from order_lines x where x.order_id = r.order_id and x.status <> 'void');
    perform engine.alert('k_void', o.location_id, 'BATAL · ' || r.items || ' · ' || engine.k_where(o),
      engine.k_station(r.station) || ': ' || case when v_all then 'seluruh bill dibatalkan kasir' else 'item dibatalkan kasir' end
        || coalesce('. Alasan: ' || nullif(trim(r.reason), ''), '') || coalesce(' · oleh ' || v_who, '')
        || case when r.all_ready then '. Sudah siap: jangan diantar.' else '. Hentikan pembuatannya.' end,
      o.id, o.table_id, r.station);
  end loop;
  -- 3. Item yang sedang dibuat pindah nota (split / gabung bill)
  for r in select p.order_id from_id, n.order_id to_id, n.station, string_agg(engine.k_item(n.qty, n.name, n.note), ' · ' order by n.sort) items
             from new_rows n join old_rows p on p.id = n.id
            where n.order_id <> p.order_id and n.status in ('new', 'cook', 'ready') and n.station in ('dapur', 'bar')
            group by p.order_id, n.order_id, n.station loop
    select * into a from orders where id = r.from_id;
    select * into o from orders where id = r.to_id;
    perform engine.alert('k_move', o.location_id, 'Nota berubah · ' || engine.k_where(o),
      engine.k_station(r.station) || ': ' || r.items || ' pindah dari ' || engine.k_where(a) || ' ke ' || o.no
        || case when o.split_from = a.id then ' (split bill).' else ' (gabung bill).' end,
      o.id, o.table_id, r.station);
  end loop;
  return null;
exception when others then return null;   -- notifikasi tidak pernah menggagalkan transaksi kasir
end $$;
drop trigger if exists kitchen_lines_upd on public.order_lines;
create trigger kitchen_lines_upd after update on public.order_lines referencing old table as old_rows new table as new_rows
  for each statement execute function engine.tg_kitchen_lines_upd();

-- Split bill sebagian: item yang sedang dibuat disalin ke nota baru
create or replace function engine.tg_kitchen_lines_ins() returns trigger language plpgsql security definer set search_path = public as $$
declare r record; o public.orders; a public.orders;
begin
  for r in select n.order_id, n.station, string_agg(engine.k_item(n.qty, n.name, n.note), ' · ' order by n.sort) items
             from new_rows n where n.status in ('new', 'cook', 'ready') and n.station in ('dapur', 'bar')
            group by n.order_id, n.station loop
    select * into o from orders where id = r.order_id;
    continue when o.split_from is null;
    select * into a from orders where id = o.split_from;
    perform engine.alert('k_move', o.location_id, 'Nota berubah · ' || engine.k_where(o),
      engine.k_station(r.station) || ': ' || r.items || ' dipisah dari ' || coalesce(a.no, 'nota asal') || ' ke ' || o.no || ' (split bill).',
      o.id, o.table_id, r.station);
  end loop;
  return null;
exception when others then return null;
end $$;
drop trigger if exists kitchen_lines_ins on public.order_lines;
create trigger kitchen_lines_ins after insert on public.order_lines referencing new table as new_rows
  for each statement execute function engine.tg_kitchen_lines_ins();

-- Pindah meja saat masih ada item yang dibuat dapur
create or replace function engine.tg_kitchen_move() returns trigger language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if new.status <> 'open' or old.table_id is not distinct from new.table_id then return null; end if;
  for r in select station, string_agg(engine.k_item(qty, name, note), ' · ' order by sort) items
             from order_lines where order_id = new.id and status in ('new', 'cook', 'ready') and station in ('dapur', 'bar')
            group by station loop
    perform engine.alert('k_move', new.location_id, 'Pindah meja · ' || coalesce(old.table_id, '-') || ' → ' || coalesce(new.table_id, '-') || ' · ' || new.no,
      engine.k_station(r.station) || ': ' || r.items || '. Antar ke meja ' || coalesce(new.table_id, '-') || '.', new.id, new.table_id, r.station);
  end loop;
  return null;
exception when others then return null;
end $$;
drop trigger if exists kitchen_move on public.orders;
create trigger kitchen_move after update of table_id on public.orders for each row execute function engine.tg_kitchen_move();

revoke all on function engine.tg_kitchen_lines_upd(), engine.tg_kitchen_lines_ins(), engine.tg_kitchen_move(),
  engine.k_where(public.orders), engine.k_item(numeric, text, text), engine.k_station(text) from public;

-- 2.8
revoke execute on function public.print_station_model(text, text) from public, anon;
grant execute on function public.print_station_model(text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 2.9 · Anggota shift: semua staf boleh membaca, hanya Owner (Kaly Backoffice) yang menambah/mengubah
-- ---------------------------------------------------------------------
alter table public.crew enable row level security;
select engine.policy('crew', 'staf baca', 'select', 'public.is_staff()');
select engine.policy('crew', 'owner tambah', 'insert', null, 'public.is_staff(array[''owner''])');
select engine.policy('crew', 'owner ubah', 'update', 'public.is_staff(array[''owner''])');
select engine.policy('crew', 'owner hapus', 'delete', 'public.is_staff(array[''owner''])');
revoke all on public.crew from anon;
drop trigger if exists sync_log on public.crew;
create trigger sync_log after insert or update or delete on public.crew for each statement execute function engine.tg_sync_log();
revoke execute on function public.shift_open(text, text, numeric, text), public.shift_crew(text, text), public.shift_reports(text, int) from public, anon;
grant execute on function public.shift_open(text, text, numeric, text), public.shift_crew(text, text), public.shift_reports(text, int) to authenticated;
revoke all on function engine.crew_kasir(text, text) from public;

-- ---------------------------------------------------------------------
-- 2.10 · Kaly POS hanya untuk akun Kasir (dan Owner). Service tidak lagi membuat/mengubah bill;
-- service tetap bisa membaca pesanan, mengantar item, memindah/mengosongkan meja (lewat fungsi), dan mencatat reservasi.
-- ---------------------------------------------------------------------
select engine.policy('orders', 'buat', 'insert', null, 'public.is_staff(array[''owner'',''kasir'']) and public.can_loc(location_id)');
select engine.policy('orders', 'ubah', 'update', 'public.is_staff(array[''owner'',''kasir'']) and public.can_loc(location_id)');
select engine.policy('order_lines', 'tambah', 'insert', null, 'public.is_staff(array[''owner'',''kasir'']) and public.can_order(order_id)');
select engine.policy('order_lines', 'ubah draft', 'update', 'public.is_staff(array[''owner'',''kasir'']) and public.can_order(order_id)');
select engine.policy('order_lines', 'hapus draft', 'delete', 'public.is_staff(array[''owner'',''kasir'']) and public.can_order(order_id)');

-- 2.10 · Service mem-booking meja / menandai tamu reservasi datang → kasir dikabari untuk membuka bill
create or replace function engine.tg_alert_res_seat() returns trigger language plpgsql security definer set search_path = public as $$
declare v_who public.staff; v_loc text;
begin
  if new.status <> 'datang' or new.table_id is null or new.order_id is not null then return null; end if;
  if tg_op = 'UPDATE' and old.status = 'datang' then return null; end if;
  select * into v_who from staff where user_id = auth.uid() and active;
  if v_who.id is null or v_who.role = 'kasir' then return null; end if;   -- kasir sendiri langsung membuka bill
  select location_id into v_loc from dining_tables where id = new.table_id;
  perform engine.alert('res_seat', coalesce(v_loc, 'L1'), 'Meja ' || array_to_string(array[new.table_id] || coalesce(new.join_tables, '{}'), '+') || ' · tamu sudah duduk',
    new.name || ' · ' || new.pax || ' orang' || case when new.source = 'walk-in' then ' (walk-in)' else ' (reservasi ' || to_char(new.time, 'HH24:MI') || ')' end
      || coalesce('. Catatan: ' || nullif(trim(new.note), ''), '') || '. Dicatat ' || v_who.name || '. Silakan buka bill di Kaly POS.',
    null, new.table_id, new.id);
  return null;
end $$;
drop trigger if exists alert_res_seat on public.reservations;
create trigger alert_res_seat after insert or update of status on public.reservations for each row execute function engine.tg_alert_res_seat();
revoke all on function engine.tg_alert_res_seat() from public;

-- ---------------------------------------------------------------------
-- 2.12 · Realtime tidak dipakai (aplikasi memakai refresh berkala lewat sync_poll)
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    for t in select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' loop
      execute format('alter publication supabase_realtime drop table public.%I', t);
    end loop;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2.12 · Audit log: setiap tambah/ubah/hapus oleh akun staf dicatat otomatis
-- ---------------------------------------------------------------------
create or replace function engine.tg_audit() returns trigger language plpgsql security definer set search_path = public as $$
declare v_new jsonb; v_old jsonb; v_chg jsonb := '{}'::jsonb; k text; v_id text; v_loc text; v_sum text;
  v_skip text[] := array['updated_at', 'created_at', 'search', 'pin_hash', 'p256dh', 'auth'];
begin
  if auth.uid() is null then return null; end if;   -- tamu (QR/online/reservasi) & proses sistem tidak dicatat di sini
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
  -- kolom turunan yang dihitung mesin dari item (sudah tercatat di perubahan item-nya)
  if tg_table_name = 'orders' then v_skip := v_skip || array['kitchen_state', 'ready_at', 'picked_at']; end if;
  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(v_new) loop
      if not (k = any(v_skip)) and (v_new -> k) is distinct from (v_old -> k) then
        v_chg := v_chg || jsonb_build_object(k, jsonb_build_array(v_old -> k, v_new -> k));
      end if;
    end loop;
    if v_chg = '{}'::jsonb then return null; end if;
  else
    v_chg := coalesce(v_new, v_old);
    foreach k in array v_skip loop v_chg := v_chg - k; end loop;
  end if;
  v_id := coalesce(v_new ->> 'id', v_old ->> 'id', v_new ->> 'code', v_old ->> 'code', '');
  v_loc := coalesce(v_new ->> 'location_id', v_old ->> 'location_id');
  v_sum := case tg_op when 'INSERT' then 'tambah' when 'DELETE' then 'hapus' else 'ubah ' || (select string_agg(x, ', ') from (select jsonb_object_keys(v_chg) x limit 8) q) end;
  -- ringkasan yang mudah dicari: nomor nota, nama item/menu/staf
  if tg_table_name = 'orders' then v_sum := coalesce(coalesce(v_new, v_old) ->> 'no', '') || ' · ' || v_sum;
  elsif tg_table_name in ('order_lines', 'order_payments') then
    v_sum := coalesce((select no from orders where id = coalesce(v_new, v_old) ->> 'order_id'), '') || ' · '
      || coalesce(trim(trailing '.' from to_char((coalesce(v_new, v_old) ->> 'qty')::numeric, 'FM999990.##')) || '× ', '') || coalesce(coalesce(v_new, v_old) ->> 'name', coalesce(v_new, v_old) ->> 'method', '') || ' · ' || v_sum;
  elsif coalesce(v_new, v_old) ? 'name' then v_sum := coalesce(coalesce(v_new, v_old) ->> 'name', '') || ' · ' || v_sum;
  end if;
  perform engine.audit_write(lower(tg_op), tg_table_name, v_id, v_loc, v_sum, v_chg);
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['orders', 'order_lines', 'order_payments', 'shifts', 'deposit_cards', 'deposit_tx', 'reservations', 'members',
    'menus', 'menu_categories', 'menu_outlets', 'menu_bom', 'menu_package_items', 'items', 'item_bom', 'promos', 'vouchers', 'campaigns', 'tiers', 'missions',
    'settings', 'staff', 'crew', 'print_stations', 'dining_tables', 'areas', 'locations', 'purchase_orders', 'purchase_order_lines', 'transfers', 'transfer_lines',
    'opnames', 'opname_lines', 'productions', 'b2b_invoices', 'suppliers', 'supplier_prices', 'fraud_flags'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists audit on public.%I', t);
      execute format('create trigger audit after insert or update or delete on public.%I for each row execute function engine.tg_audit()', t);
    end if;
  end loop;
end $$;

alter table public.audit_log enable row level security;
select engine.policy('audit_log', 'owner baca', 'select', 'public.is_staff(array[''owner''])');
revoke all on public.audit_log from anon;
revoke insert, update, delete on public.audit_log from authenticated;
grant select on public.audit_log to authenticated;
alter table public.audit_sessions enable row level security;
revoke all on public.audit_sessions from anon, authenticated;
revoke all on function engine.tg_audit(), engine.audit_write(text, text, text, text, text, jsonb), engine.audit_who() from public;
revoke execute on function public.audit_event(text, text, text, text), public.audit_session(text, text), public.kitchen_batch(text[], text) from public, anon;
grant execute on function public.audit_event(text, text, text, text), public.audit_session(text, text), public.kitchen_batch(text[], text) to authenticated;

revoke execute on function public.push_api(text, text, jsonb) from public;
grant execute on function public.push_api(text, text, jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 2.13 · Aktivitas transaksi & refund
-- ---------------------------------------------------------------------
revoke execute on function public.trx_list(text, date, date, text, text, text, text, int, timestamptz), public.order_refund(text, text, text) from public, anon;
grant execute on function public.trx_list(text, date, date, text, text, text, text, int, timestamptz), public.order_refund(text, text, text) to authenticated;


-- =====================================================================
-- Kaly Ops · Database Supabase · 05 Laporan (view)
-- ---------------------------------------------------------------------
-- View memakai security_invoker, jadi hak akses tetap mengikuti peran staf (RLS).
-- Contoh: select * from v_sales_daily where biz_day >= current_date - 7;
-- =====================================================================

create or replace function public.menu_std_cost(p_menu text) returns numeric language sql stable security definer set search_path = public as $$
  select engine.menu_hpp(p_menu);
$$;
grant execute on function public.menu_std_cost(text) to authenticated;

-- Neraca saldo per entitas
create or replace view public.v_trial_balance with (security_invoker = true) as
select j.entity_id, a.code, a.name, a.type,
       sum(l.debit) as debit, sum(l.credit) as credit, sum(l.debit - l.credit) as balance
from public.journal_lines l
join public.journals j on j.id = l.journal_id
join public.accounts a on a.code = l.account_code
group by j.entity_id, a.code, a.name, a.type;

-- Laba rugi per bulan per entitas
create or replace view public.v_profit_loss_monthly with (security_invoker = true) as
select j.entity_id, to_char(j.at at time zone 'Asia/Jakarta', 'YYYY-MM') as month,
       sum(case when a.type = 'revenue' then l.credit - l.debit else 0 end) as revenue,
       sum(case when a.type = 'contra' then l.debit - l.credit else 0 end) as discounts,
       sum(case when a.type = 'cogs' then l.debit - l.credit else 0 end) as cogs,
       sum(case when a.type = 'expense' then l.debit - l.credit else 0 end) as expenses,
       sum(case when a.type = 'revenue' then l.credit - l.debit when a.type in ('contra', 'cogs', 'expense') then -(l.debit - l.credit) else 0 end) as profit
from public.journal_lines l
join public.journals j on j.id = l.journal_id
join public.accounts a on a.code = l.account_code
group by 1, 2;

-- Penjualan harian per outlet & channel
create or replace view public.v_sales_daily with (security_invoker = true) as
select o.biz_day, o.location_id, o.channel,
       count(*) as orders,
       sum((o.bill->>'sub')::numeric) as gross,
       sum((o.bill->>'disc')::numeric) as discount,
       sum((o.bill->>'tax')::numeric) as tax,
       sum((o.bill->>'svc')::numeric + (o.bill->>'deliv')::numeric) as other,
       sum(o.total) as total,
       round(avg(o.total)) as avg_bill
from public.orders o
where o.status = 'paid'
group by 1, 2, 3;

-- Pembayaran harian per metode
create or replace view public.v_payments_daily with (security_invoker = true) as
select o.biz_day, o.location_id, p.method, count(*) as payments, sum(p.amount) as amount
from public.order_payments p
join public.orders o on o.id = p.order_id
where o.status = 'paid'
group by 1, 2, 3;

-- Menu terlaris 30 hari terakhir
create or replace view public.v_top_menus_30d with (security_invoker = true) as
select o.location_id, l.menu_id, m.name, m.category_id, sum(l.qty) as qty, sum(l.qty * l.price) as revenue, sum(coalesce(l.cost, 0)) as cost
from public.order_lines l
join public.orders o on o.id = l.order_id
join public.menus m on m.id = l.menu_id
where o.status = 'paid' and l.status <> 'void' and l.parent_line_id is null and o.paid_at >= now() - interval '30 days'
group by 1, 2, 3, 4;

-- Nilai persediaan & stok di bawah minimum
create or replace view public.v_stock_value with (security_invoker = true) as
select s.location_id, s.item_id, i.name, i.unit, i.type, s.qty, s.avg_cost, round(s.qty * s.avg_cost) as value, s.min_qty,
       (s.min_qty > 0 and s.qty < s.min_qty) as below_min, (s.qty < 0) as negative
from public.stock s
join public.items i on i.id = s.item_id;

-- HPP standar & food cost per menu
create or replace view public.v_menu_cost with (security_invoker = true) as
select m.id, m.name, m.category_id, m.price, round(public.menu_std_cost(m.id)) as hpp,
       case when m.price > 0 then round(public.menu_std_cost(m.id) / m.price, 4) end as food_cost_ratio, m.active, m.sold_out
from public.menus m;

-- Waktu dapur per item (dari dikirim sampai siap)
create or replace view public.v_kitchen_times with (security_invoker = true) as
select o.biz_day, o.location_id, o.no, l.menu_id, l.name, l.station, l.qty, l.sent_at, l.ready_at,
       round(extract(epoch from (l.ready_at - l.sent_at)) / 60, 1) as minutes
from public.order_lines l
join public.orders o on o.id = l.order_id
where l.sent_at is not null and l.ready_at is not null and l.station <> 'none' and l.status <> 'void';

-- Ringkasan jurnal per hari, per akun, per kelompok arus kas (dipakai laporan keuangan di aplikasi)
create or replace view public.v_journal_daily with (security_invoker = true) as
select j.entity_id, (j.at at time zone 'Asia/Jakarta')::date as day, coalesce(j.cash_flow, '') as cash_flow, l.account_code,
       sum(l.debit) as debit, sum(l.credit) as credit
from public.journal_lines l
join public.journals j on j.id = l.journal_id
group by 1, 2, 3, 4;

-- Minta API Supabase membaca ulang daftar tabel & fungsi (Supabase biasanya melakukannya otomatis)
notify pgrst, 'reload schema';

-- =====================================================================
-- 1.4 · Laporan operasional (dipanggil layar Laporan di Kaly Core, khusus Owner)
-- Semua jam memakai zona waktu di Pengaturan (default Asia/Jakarta).
-- Periode bebas: dihitung langsung di database, tidak terbatas data yang sedang dimuat aplikasi.
-- =====================================================================
create or replace function engine.report_locs(p_locs text[]) returns text[] language plpgsql stable security definer set search_path = public as $$
declare v text[];
begin
  perform engine.require_role(array['owner']);
  select array_agg(id order by id) into v from locations where (p_locs is null or id = any(p_locs)) and public.can_loc(id);
  return coalesce(v, '{}');
end $$;
create or replace function engine.report_tz() returns text language sql stable security definer set search_path = public as $$
  select coalesce(nullif((select timezone from settings where id = 1), ''), 'Asia/Jakarta');
$$;

-- Rekap transaksi per nota & jam penjualan (jam = waktu bayar)
create or replace function public.report_receipts(p_from timestamptz, p_to timestamptz, p_locs text[] default null, p_limit int default 3000)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_locs text[]; tz text := engine.report_tz(); r jsonb;
begin
  v_locs := engine.report_locs(p_locs);
  with o as (
    select o.id, o.no, o.location_id loc, o.channel ch, o.type, o.table_id, o.merged_tables, o.paid_at, o.created_at, o.paid_by, o.member_id,
           coalesce((o.bill->>'sub')::numeric, 0) sub, coalesce((o.bill->>'disc')::numeric, 0) disc, coalesce((o.bill->>'svc')::numeric, 0) svc,
           coalesce((o.bill->>'tax')::numeric, 0) tax, coalesce((o.bill->>'deliv')::numeric, 0) deliv, coalesce(o.total, 0) total,
           (o.paid_at at time zone tz) lt
      from orders o
     where o.status = 'paid' and o.location_id = any(v_locs) and o.paid_at >= p_from and o.paid_at <= p_to
  ), it as (
    select l.order_id, sum(l.qty) q from order_lines l join o on o.id = l.order_id where l.parent_line_id is null and l.status <> 'void' group by 1
  ), pay as (
    select p.order_id, jsonb_agg(jsonb_build_array(p.method, p.amount) order by p.id) a from order_payments p join o on o.id = p.order_id group by 1
  ), x as (
    select o.*, coalesce(it.q, 0) items, coalesce(pay.a, '[]'::jsonb) pays from o left join it on it.order_id = o.id left join pay on pay.order_id = o.id
  )
  select jsonb_build_object(
    'tz', tz,
    'n', (select count(*) from x),
    'total', (select coalesce(sum(total), 0) from x),
    'sub', (select coalesce(sum(sub), 0) from x),
    'disc', (select coalesce(sum(disc), 0) from x),
    'tax', (select coalesce(sum(tax), 0) from x),
    'items', (select coalesce(sum(items), 0) from x),
    'hours', (select coalesce(jsonb_agg(jsonb_build_object('h', h, 'n', n, 'total', t, 'items', q) order by h), '[]'::jsonb)
                from (select extract(hour from lt)::int h, count(*) n, sum(total) t, sum(items) q from x group by 1) h),
    'days', (select coalesce(jsonb_agg(jsonb_build_object('d', d, 'n', n, 'total', t) order by d), '[]'::jsonb)
               from (select lt::date d, count(*) n, sum(total) t from x group by 1) d),
    'dowh', (select coalesce(jsonb_agg(jsonb_build_object('w', w, 'h', h, 'n', n, 'total', t)), '[]'::jsonb)
               from (select extract(isodow from lt)::int w, extract(hour from lt)::int h, count(*) n, sum(total) t from x group by 1, 2) w),
    'pays', (select coalesce(jsonb_agg(jsonb_build_object('m', m, 'n', n, 'total', t) order by t desc), '[]'::jsonb)
               from (select e->>0 m, count(*) n, sum((e->>1)::numeric) t from x, jsonb_array_elements(x.pays) e group by 1) p),
    'list', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'no', x.no, 'at', x.paid_at, 'opened', x.created_at, 'loc', x.loc, 'ch', x.ch, 'type', x.type,
                       'table', x.table_id, 'merged', x.merged_tables, 'by', coalesce(s.name, case when x.ch <> 'pos' then 'Bayar online' else '' end),
                       'member', mb.name, 'items', x.items, 'sub', x.sub, 'disc', x.disc, 'svc', x.svc, 'tax', x.tax, 'deliv', x.deliv, 'total', x.total, 'pays', x.pays)
                       order by x.paid_at desc), '[]'::jsonb)
               from (select * from x order by paid_at desc limit greatest(coalesce(p_limit, 100000), 1)) x
               left join staff s on s.id = x.paid_by left join members mb on mb.id = x.member_id),
    'truncated', (select count(*) from x) > coalesce(p_limit, 100000),
    'voids', (select jsonb_build_object('n', count(*), 'value', coalesce(sum(v), 0))
                from (select (select coalesce(sum(l.qty * l.price), 0) from order_lines l where l.order_id = v.id and l.parent_line_id is null) v
                        from orders v where v.status = 'void' and v.merged_into is null and v.location_id = any(v_locs) and v.void_at >= p_from and v.void_at <= p_to) z)
  ) into r;
  return r;
end $$;

-- Rekap penjualan per kategori & jam (nilai item sebelum diskon tagihan dan PB1; HPP aktual dari pemotongan stok)
create or replace function public.report_categories(p_from timestamptz, p_to timestamptz, p_locs text[] default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_locs text[]; tz text := engine.report_tz(); r jsonb;
begin
  v_locs := engine.report_locs(p_locs);
  with o as (
    select o.id, (o.paid_at at time zone tz) lt from orders o
     where o.status = 'paid' and o.location_id = any(v_locs) and o.paid_at >= p_from and o.paid_at <= p_to
  ), l as (
    select l.order_id, l.menu_id, coalesce(nullif(l.name, ''), m.name, l.menu_id) name, l.qty, l.qty * l.price v,
           coalesce(l.cost, 0) + coalesce((select sum(c.cost) from order_lines c where c.parent_line_id = l.id and c.status <> 'void'), 0) hpp,
           extract(hour from o.lt)::int h, o.lt::date d, coalesce(m.category_id, '_') cat
      from order_lines l join o on o.id = l.order_id left join menus m on m.id = l.menu_id
     where l.parent_line_id is null and l.status <> 'void'
  )
  select jsonb_build_object(
    'tz', tz,
    'master', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'sort', c.sort) order by c.sort, c.id), '[]'::jsonb) from menu_categories c),
    'cats', (select coalesce(jsonb_agg(jsonb_build_object('id', x.cat, 'name', coalesce(c.name, 'Tanpa kategori'), 'sort', coalesce(c.sort, 999),
                       'qty', x.q, 'value', x.v, 'hpp', x.hpp, 'orders', x.n, 'menus', x.nm) order by coalesce(c.sort, 999), x.cat), '[]'::jsonb)
               from (select cat, sum(qty) q, sum(v) v, sum(hpp) hpp, count(distinct order_id) n, count(distinct menu_id) nm from l group by cat) x
               left join menu_categories c on c.id = x.cat),
    'orders', (select count(*) from o),
    'hours', (select coalesce(jsonb_agg(jsonb_build_object('c', cat, 'h', h, 'qty', q, 'value', v)), '[]'::jsonb)
                from (select cat, h, sum(qty) q, sum(v) v from l group by 1, 2) y),
    'days', (select coalesce(jsonb_agg(jsonb_build_object('c', cat, 'd', d, 'qty', q, 'value', v)), '[]'::jsonb)
               from (select cat, d, sum(qty) q, sum(v) v from l group by 1, 2) y),
    'menus', (select coalesce(jsonb_agg(jsonb_build_object('c', cat, 'id', menu_id, 'name', name, 'qty', q, 'value', v, 'hpp', hpp) order by cat, v desc), '[]'::jsonb)
                from (select cat, menu_id, max(name) name, sum(qty) q, sum(v) v, sum(hpp) hpp, row_number() over (partition by cat order by sum(v) desc, menu_id) rn
                        from l group by cat, menu_id) z where rn <= 10)
  ) into r;
  return r;
end $$;

-- Rekap aktivitas denah meja: kunjungan, lama duduk, keterisian per jam, per meja/area, aktivitas staf, dan log
create or replace function public.report_tables(p_from timestamptz, p_to timestamptz, p_loc text default 'L1', p_log int default 400)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_locs text[]; tz text := engine.report_tz(); r jsonb; v_end timestamptz := least(p_to, now()); v_days int;
begin
  v_locs := engine.report_locs(array[p_loc]);
  if not (p_loc = any(v_locs)) then raise exception 'Akun ini tidak punya akses ke outlet tersebut' using errcode = '42501'; end if;
  v_days := greatest(1, ((v_end at time zone tz)::date - (p_from at time zone tz)::date) + 1);
  with v as (
    select o.id, o.no, o.status, o.channel, o.table_id, o.merged_tables, 1 + coalesce(cardinality(o.merged_tables), 0) nt, o.created_at st, o.paid_at, o.split_from,
           coalesce(o.total, 0) total, t.area,
           (select min(e.at) from table_events e where e.order_id = o.id and e.kind = 'clear' and e.at >= o.paid_at and e.at <= o.paid_at + interval '4 hours') cleared
      from orders o left join dining_tables t on t.id = o.table_id
     where o.location_id = p_loc and o.type = 'dine' and o.table_id is not null and o.status in ('paid', 'open')
       and o.created_at >= p_from and o.created_at <= p_to
  ), w as (
    select v.*, case when status = 'open' then greatest(st, least(now(), st + interval '6 hours')) else coalesce(cleared, paid_at) end en from v
  ), d as (
    select w.*, least(extract(epoch from (en - st)) / 60, 360) dur, extract(epoch from (cleared - paid_at)) / 60 linger from w
  ), occ as (
    select extract(hour from hs)::int h,
           sum(nt * greatest(0, extract(epoch from (least(d.en at time zone tz, hs + interval '1 hour') - greatest(d.st at time zone tz, hs))) / 60)) mins
      from d, generate_series(date_trunc('hour', d.st at time zone tz), d.en at time zone tz, interval '1 hour') hs
     where d.en > d.st and d.split_from is null
     group by 1
  ), ev as (
    select e.* from table_events e where e.location_id = p_loc and e.at >= p_from and e.at <= p_to
  ), sw as (
    select l.ready_at, l.served_at from order_lines l join orders o on o.id = l.order_id
     where o.location_id = p_loc and o.type = 'dine' and l.served_at >= p_from and l.served_at <= p_to and l.ready_at is not null and l.served_at >= l.ready_at
  ), lg as (
    select v.st at, v.table_id tbl, 'open' kind, v.no, case when v.channel = 'qr' then 'QR pelanggan' else coalesce((select name from staff where id = o.created_by), '') end who, null::text to_table, 0 qty,
           case when v.split_from is not null then 'Split bill dari ' || coalesce((select no from orders where id = v.split_from), '') when v.channel = 'qr' then 'Pesan lewat QR meja' when v.channel = 'web' then 'Pesanan online' else 'Bill dibuka di kasir' end detail
      from v join orders o on o.id = v.id
    union all
    select v.paid_at, v.table_id, 'paid', v.no, coalesce((select s.name from staff s join orders o on o.paid_by = s.id where o.id = v.id), 'Bayar online'), null, 0, engine.rp(v.total)
      from v where v.status = 'paid' and v.paid_at <= p_to
    union all
    select o.void_at, o.table_id, 'void', o.no, coalesce((select name from staff where id = o.void_by), ''), null, 0, coalesce(o.void_reason, '')
      from orders o where o.location_id = p_loc and o.type = 'dine' and o.table_id is not null and o.status = 'void' and o.merged_into is null and o.void_at >= p_from and o.void_at <= p_to
    union all
    select ev.at, ev.table_id, ev.kind, (select no from orders where id = ev.order_id), coalesce((select name from staff where id = ev.staff_id), case when ev.detail like 'otomatis%' then 'Sistem' else '' end),
           ev.to_table, ev.qty, ev.detail
      from ev
  )
  select jsonb_build_object(
    'tz', tz, 'days', v_days,
    'tables', (select count(*) from dining_tables where location_id = p_loc and active),
    'visits', (select count(*) from d where split_from is null),
    'open', (select count(*) from d where status = 'open' and split_from is null),
    'sales', (select coalesce(sum(total), 0) from d where status = 'paid'),
    'avg_dur', (select round(avg(dur)::numeric, 1) from d where status = 'paid' and split_from is null),
    'avg_linger', (select round(avg(linger)::numeric, 1) from d where linger is not null and split_from is null),
    'cleared_n', (select count(*) from d where cleared is not null and split_from is null),
    'serve_wait', (select round(avg(extract(epoch from (served_at - ready_at)) / 60)::numeric, 1) from sw where served_at - ready_at < interval '3 hours'),
    'serve_n', (select count(*) from sw),
    'voids', (select count(*) from lg where kind = 'void'),
    'ev', (select jsonb_build_object('move', count(*) filter (where kind = 'move'), 'clear', count(*) filter (where kind = 'clear' and detail not like 'otomatis%'),
                                     'auto', count(*) filter (where kind = 'clear' and detail like 'otomatis%'), 'serve', coalesce(sum(qty) filter (where kind = 'serve'), 0)) from ev),
    'hours', (select coalesce(jsonb_agg(jsonb_build_object('h', h.h, 'starts', coalesce(s.n, 0), 'occ', round(coalesce(oc.mins, 0)::numeric / (60 * v_days), 2)) order by h.h), '[]'::jsonb)
                from generate_series(0, 23) h(h)
                left join (select extract(hour from st at time zone tz)::int h, count(*) n from d where split_from is null group by 1) s on s.h = h.h
                left join occ oc on oc.h = h.h
               where coalesce(s.n, 0) > 0 or coalesce(oc.mins, 0) > 0),
    'dur', (select jsonb_agg(jsonb_build_object('b', b, 'n', n) order by b) from (
              select b, (select count(*) from d where status = 'paid' and split_from is null and case b when 0 then dur < 30 when 1 then dur >= 30 and dur < 60 when 2 then dur >= 60 and dur < 90
                                                                   when 3 then dur >= 90 and dur < 120 else dur >= 120 end) n from generate_series(0, 4) b) q),
    'per_table', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'area', t.area, 'seats', t.seats, 'visits', coalesce(x.n, 0), 'sales', coalesce(x.s, 0),
                         'avg_dur', x.a, 'moves', coalesce(m.n, 0), 'clears', coalesce(c.n, 0)) order by coalesce(x.n, 0) desc, t.sort, t.id), '[]'::jsonb)
                    from dining_tables t
                    left join (select table_id, count(*) filter (where split_from is null) n, sum(total) filter (where status = 'paid') s,
                                      round(avg(dur) filter (where status = 'paid' and split_from is null)::numeric, 1) a from d group by 1) x on x.table_id = t.id
                    left join (select table_id, count(*) n from ev where kind = 'move' group by 1) m on m.table_id = t.id
                    left join (select table_id, count(*) n from ev where kind = 'clear' group by 1) c on c.table_id = t.id
                   where t.location_id = p_loc and t.active),
    'per_area', (select coalesce(jsonb_agg(jsonb_build_object('area', a.area, 'tables', a.n, 'visits', coalesce(x.n, 0), 'sales', coalesce(x.s, 0), 'avg_dur', x.a,
                        'turn', round(coalesce(x.n, 0)::numeric / a.n / v_days, 2)) order by coalesce(x.n, 0) desc, a.area), '[]'::jsonb)
                   from (select area, count(*) n from dining_tables where location_id = p_loc and active group by 1) a
                   left join (select area, count(*) filter (where split_from is null) n, sum(total) filter (where status = 'paid') s,
                                     round(avg(dur) filter (where status = 'paid' and split_from is null)::numeric, 1) a from d group by 1) x on x.area = a.area),
    'per_day', (select coalesce(jsonb_agg(jsonb_build_object('d', dd, 'visits', n, 'sales', s, 'avg_dur', a) order by dd), '[]'::jsonb)
                  from (select (st at time zone tz)::date dd, count(*) filter (where split_from is null) n, coalesce(sum(total) filter (where status = 'paid'), 0) s,
                               round(avg(dur) filter (where status = 'paid' and split_from is null)::numeric, 1) a from d group by 1) q),
    'staff', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'role', s.role, 'opens', coalesce(op.n, 0), 'paid', coalesce(pd.n, 0),
                     'serves', coalesce(e.sv, 0), 'serve_items', coalesce(e.si, 0), 'clears', coalesce(e.cl, 0), 'moves', coalesce(e.mv, 0))
                     order by coalesce(e.sv, 0) + coalesce(e.cl, 0) + coalesce(e.mv, 0) + coalesce(op.n, 0) + coalesce(pd.n, 0) desc, s.name), '[]'::jsonb)
                from staff s
                left join (select o.created_by id, count(*) n from v join orders o on o.id = v.id where v.channel = 'pos' and v.split_from is null group by 1) op on op.id = s.id
                left join (select o.paid_by id, count(*) n from v join orders o on o.id = v.id where v.status = 'paid' group by 1) pd on pd.id = s.id
                left join (select staff_id id, count(*) filter (where kind = 'serve') sv, coalesce(sum(qty) filter (where kind = 'serve'), 0) si,
                                  count(*) filter (where kind = 'clear' and detail not like 'otomatis%') cl, count(*) filter (where kind = 'move') mv
                             from ev group by 1) e on e.id = s.id
               where coalesce(op.n, 0) + coalesce(pd.n, 0) + coalesce(e.sv, 0) + coalesce(e.cl, 0) + coalesce(e.mv, 0) > 0),
    'log', (select coalesce(jsonb_agg(jsonb_build_object('at', at, 'table', tbl, 'kind', kind, 'no', no, 'who', who, 'to', to_table, 'qty', qty, 'detail', detail) order by at desc), '[]'::jsonb)
              from (select * from lg order by at desc limit greatest(coalesce(p_log, 400), 1)) q),
    'log_total', (select count(*) from lg)
  ) into r;
  return r;
end $$;

revoke all on function engine.report_locs(text[]), engine.report_tz() from public;
revoke execute on function public.report_receipts(timestamptz, timestamptz, text[], int), public.report_categories(timestamptz, timestamptz, text[]),
  public.report_tables(timestamptz, timestamptz, text, int) from public, anon;
grant execute on function public.report_receipts(timestamptz, timestamptz, text[], int), public.report_categories(timestamptz, timestamptz, text[]),
  public.report_tables(timestamptz, timestamptz, text, int) to authenticated;


-- =====================================================================
-- Kaly Ops · Database Supabase · 06 Data master
-- ---------------------------------------------------------------------
-- Dibuat otomatis dari data master aplikasi Kaly Ops 1.0 (menu Grand Opening, kategori, resep, bahan,
-- stok awal, 42 meja, tier member, bagan akun, pengaturan). Tanpa transaksi, member, supplier, dan promo contoh.
-- Aman dijalankan ulang: data yang sudah ada tidak ditimpa.
-- PENTING: resep (komposisi bahan) dan stok awal adalah contoh. Sesuaikan lewat Kaly Core dan stock opname.
-- =====================================================================

-- Selama mengisi data master, penjaga data (trigger) dilewati. Dikembalikan di akhir file.
do $$ begin perform set_config('kaly.engine', 'on', false); end $$;

insert into public.settings (id, brand_name, brand_tagline, brand_color, brand_accent, tax_rate, service_rate, points_per, point_value, welcome_points,
  auto_produce, stock_guard, sla_min, disc_approval, cash_var_tol, po_price_tol, po_approval, transfer_fee, deliv_base, deliv_per_km, max_km,
  same_day_cutoff, schedule_lead, res_duration, auto_confirm_res, open_hour, close_hour, qr_auto_send, b2b_markup, birthday_pct)
values (1, 'Kaly Eatery', 'Eat x Play x Nature', '#475331', '#CC5E44', 0.1, 0, 10000, 100, 20,
  true, true, 15, 0.15, 20000, 0.1, 3000000, 2500, 8000, 3000, 10,
  '15:00', 30, 120, false, 9, 21, true, 0.15, 0.25)
on conflict (id) do nothing;

-- PIN manajer awal 1234. Segera ganti: select public.set_manager_pin('PIN-baru');  (sebagai Owner)
insert into public.app_secrets (id, manager_pin_hash) values (1, extensions.crypt('1234', extensions.gen_salt('bf'))) on conflict (id) do nothing;

insert into public.entities (id, name, short) values
  ('e1', 'Kaly Eatery (Resto & Play)', 'Kaly Eatery'),
  ('e2', 'Kaly Central Kitchen', 'Central Kitchen')
on conflict (id) do nothing;

insert into public.locations (id, name, entity_id, type) values
  ('L1', 'Resto Kaly Eatery', 'e1', 'outlet'),
  ('L2', 'Play Corner', 'e1', 'outlet'),
  ('L3', 'Gudang Central Kitchen', 'e2', 'gudang')
on conflict (id) do nothing;

insert into public.accounts (code, name, type, is_cash) values
  ('1101', 'Kas outlet', 'asset', true),
  ('1102', 'Bank & QRIS', 'asset', true),
  ('1104', 'Piutang antar perusahaan', 'asset', false),
  ('1201', 'Persediaan', 'asset', false),
  ('1501', 'Aset tetap (gazebo, kolam, dapur)', 'asset', false),
  ('2101', 'Hutang usaha (supplier)', 'liability', false),
  ('2102', 'Hutang antar perusahaan', 'liability', false),
  ('2103', 'Saldo deposit pelanggan', 'liability', false),
  ('2104', 'Hutang pajak restoran (PB1)', 'liability', false),
  ('3101', 'Modal disetor', 'equity', false),
  ('4101', 'Penjualan', 'revenue', false),
  ('4102', 'Penjualan antar perusahaan', 'revenue', false),
  ('4103', 'Pendapatan lain (service & ongkir)', 'revenue', false),
  ('4201', 'Diskon penjualan', 'contra', false),
  ('5101', 'Harga pokok penjualan', 'cogs', false),
  ('6101', 'Beban gaji', 'expense', false),
  ('6102', 'Beban listrik & air', 'expense', false),
  ('6103', 'Beban sewa lahan', 'expense', false),
  ('6104', 'Beban pemasaran', 'expense', false),
  ('6105', 'Selisih & waste persediaan', 'expense', false),
  ('6106', 'Biaya admin transfer', 'expense', false),
  ('6107', 'Beban operasional lain', 'expense', false)
on conflict (code) do nothing;

-- Akun staf tidak diisi contoh. Owner pertama dibuat dengan: select public.kaly_setup_owner('emailanda@gmail.com', 'Nama Anda');
-- Staf lain ditambahkan Owner dari aplikasi (Pengaturan → Staf & akses). Baris staf contoh dari paket versi lama dibersihkan.
select engine.drop_placeholder_staff();

insert into public.areas (name, sort) values
  ('Garden & Panggung', 1),
  ('Sawah', 2),
  ('Riverside', 3),
  ('Pelataran', 4),
  ('Pelataran Limasan', 5),
  ('Joglo Limasan', 6),
  ('Joglo Pakudusan', 7)
on conflict (name) do nothing;

insert into public.dining_tables (id, location_id, area, seats, x, y, is_gazebo, sort) values
  ('G1', 'L1', 'Garden & Panggung', 4, 50.6, 35.76, false, 1),
  ('G2', 'L1', 'Garden & Panggung', 4, 39.6, 10.41, false, 2),
  ('G3', 'L1', 'Garden & Panggung', 4, 41.72, 10.41, false, 3),
  ('G4', 'L1', 'Garden & Panggung', 4, 43.79, 10.41, false, 4),
  ('R1', 'L1', 'Sawah', 4, 50.34, 45.82, false, 5),
  ('R2', 'L1', 'Sawah', 4, 35.83, 41.49, false, 6),
  ('R3', 'L1', 'Riverside', 4, 10.95, 87.87, false, 7),
  ('R4', 'L1', 'Riverside', 4, 31.14, 87.87, false, 8),
  ('R5', 'L1', 'Riverside', 4, 46.16, 87.89, true, 9),
  ('R6', 'L1', 'Riverside', 4, 50.83, 87.89, true, 10),
  ('R7', 'L1', 'Riverside', 4, 63.73, 87.89, true, 11),
  ('R8', 'L1', 'Riverside', 4, 78.75, 87.87, false, 12),
  ('R9', 'L1', 'Riverside', 4, 89.24, 87.87, false, 13),
  ('R10', 'L1', 'Riverside', 4, 92.96, 87.87, false, 14),
  ('PR1', 'L1', 'Pelataran', 4, 78.59, 39.15, false, 15),
  ('PR2', 'L1', 'Pelataran', 4, 75.99, 39.15, false, 16),
  ('PR3', 'L1', 'Pelataran', 4, 73.41, 39.15, false, 17),
  ('PR4', 'L1', 'Pelataran', 4, 72.93, 27.87, false, 18),
  ('PR5', 'L1', 'Pelataran', 4, 76.82, 27.87, false, 19),
  ('PR6', 'L1', 'Pelataran', 4, 79.39, 27.87, false, 20),
  ('PL2', 'L1', 'Pelataran Limasan', 4, 83.12, 20.88, false, 21),
  ('PL3', 'L1', 'Pelataran Limasan', 4, 85.67, 20.88, false, 22),
  ('PL4', 'L1', 'Pelataran Limasan', 4, 79.9, 20.26, false, 23),
  ('PL5', 'L1', 'Pelataran Limasan', 4, 79.23, 17.57, false, 24),
  ('PL6', 'L1', 'Pelataran Limasan', 4, 79.23, 10.2, false, 25),
  ('PL7', 'L1', 'Pelataran Limasan', 4, 79.23, 6.93, false, 26),
  ('PL8', 'L1', 'Pelataran Limasan', 4, 75.94, 14.94, false, 27),
  ('PL9', 'L1', 'Pelataran Limasan', 4, 70.06, 8.98, false, 28),
  ('PL10', 'L1', 'Pelataran Limasan', 4, 73.18, 17.57, false, 29),
  ('PL11', 'L1', 'Pelataran Limasan', 4, 70.42, 17.57, false, 30),
  ('L1', 'L1', 'Joglo Limasan', 4, 82.61, 16.05, false, 31),
  ('L2', 'L1', 'Joglo Limasan', 4, 82.61, 10.61, false, 32),
  ('L3', 'L1', 'Joglo Limasan', 4, 85.14, 16.05, false, 33),
  ('L4', 'L1', 'Joglo Limasan', 4, 87.63, 13.3, false, 34),
  ('L5', 'L1', 'Joglo Limasan', 4, 85.14, 10.61, false, 35),
  ('L6', 'L1', 'Joglo Limasan', 4, 87.63, 7.75, false, 36),
  ('L7', 'L1', 'Joglo Limasan', 4, 85.14, 5.29, false, 37),
  ('P1', 'L1', 'Joglo Pakudusan', 4, 83.85, 40.5, false, 38),
  ('P2', 'L1', 'Joglo Pakudusan', 4, 83.85, 29.09, false, 39),
  ('P3', 'L1', 'Joglo Pakudusan', 4, 86.29, 34.65, false, 40),
  ('P4', 'L1', 'Joglo Pakudusan', 4, 88.78, 29.09, false, 41),
  ('P5', 'L1', 'Joglo Pakudusan', 4, 88.78, 40.5, false, 42)
on conflict (id) do nothing;

insert into public.items (id, name, unit, type, category, std_cost, yield_qty) values
  ('i_beras', 'Beras', 'kg', 'raw', 'Pokok', 14000, null),
  ('i_mie', 'Mie telur', 'bks', 'raw', 'Pokok', 3500, null),
  ('i_spageti', 'Spaghetti', 'kg', 'raw', 'Pokok', 32000, null),
  ('i_terigu', 'Tepung terigu', 'kg', 'raw', 'Pokok', 12000, null),
  ('i_tpberas', 'Tepung beras', 'kg', 'raw', 'Pokok', 14000, null),
  ('i_panir', 'Tepung panir', 'kg', 'raw', 'Pokok', 28000, null),
  ('i_roti', 'Roti tawar', 'lembar', 'raw', 'Pokok', 1300, null),
  ('i_minyak', 'Minyak goreng', 'L', 'raw', 'Pokok', 17500, null),
  ('i_gula', 'Gula pasir', 'kg', 'raw', 'Pokok', 16500, null),
  ('i_aren', 'Gula aren', 'kg', 'raw', 'Pokok', 32000, null),
  ('i_kerupuk', 'Kerupuk', 'pcs', 'raw', 'Pokok', 600, null),
  ('i_kentang', 'Kentang segar', 'kg', 'raw', 'Pokok', 14000, null),
  ('i_ubi', 'Ubi ungu', 'kg', 'raw', 'Pokok', 15000, null),
  ('i_tape', 'Tape singkong', 'kg', 'raw', 'Pokok', 14000, null),
  ('i_ayam', 'Ayam potong', 'kg', 'raw', 'Protein', 38000, null),
  ('i_sayap', 'Sayap ayam', 'kg', 'raw', 'Protein', 42000, null),
  ('i_fillet', 'Dada ayam fillet', 'kg', 'raw', 'Protein', 55000, null),
  ('i_sei', 'Se''i sapi', 'kg', 'raw', 'Protein', 200000, null),
  ('i_giling', 'Daging sapi giling', 'kg', 'raw', 'Protein', 130000, null),
  ('i_paru', 'Paru sapi', 'kg', 'raw', 'Protein', 90000, null),
  ('i_ikanpe', 'Ikan pe asap', 'kg', 'raw', 'Protein', 85000, null),
  ('i_telur', 'Telur ayam', 'butir', 'raw', 'Protein', 2200, null),
  ('i_beef', 'Smoked beef', 'kg', 'raw', 'Protein', 150000, null),
  ('i_pepperoni', 'Pepperoni', 'kg', 'raw', 'Protein', 220000, null),
  ('i_nugget', 'Nugget & sosis ayam', 'kg', 'raw', 'Protein', 65000, null),
  ('i_tahu', 'Tahu', 'pcs', 'raw', 'Protein', 900, null),
  ('i_bmerah', 'Bawang merah', 'kg', 'raw', 'Sayur & bumbu', 42000, null),
  ('i_bputih', 'Bawang putih', 'kg', 'raw', 'Sayur & bumbu', 36000, null),
  ('i_cabai', 'Cabai rawit', 'kg', 'raw', 'Sayur & bumbu', 60000, null),
  ('i_cabaihijau', 'Cabai hijau', 'kg', 'raw', 'Sayur & bumbu', 45000, null),
  ('i_kunyit', 'Kunyit & rempah', 'kg', 'raw', 'Sayur & bumbu', 25000, null),
  ('i_tomat', 'Tomat', 'kg', 'raw', 'Sayur & bumbu', 15000, null),
  ('i_sayur', 'Sayur & lalapan', 'kg', 'raw', 'Sayur & bumbu', 15000, null),
  ('i_sereh', 'Sereh & daun jeruk', 'kg', 'raw', 'Sayur & bumbu', 20000, null),
  ('i_santan', 'Santan', 'L', 'raw', 'Sayur & bumbu', 25000, null),
  ('i_lemon', 'Lemon', 'kg', 'raw', 'Buah', 35000, null),
  ('i_jeruk', 'Jeruk peras', 'kg', 'raw', 'Buah', 20000, null),
  ('i_pisang', 'Pisang raja', 'kg', 'raw', 'Buah', 18000, null),
  ('i_melon', 'Melon', 'kg', 'raw', 'Buah', 18000, null),
  ('i_semangka', 'Semangka', 'kg', 'raw', 'Buah', 9000, null),
  ('i_kelapa', 'Kelapa muda', 'butir', 'raw', 'Buah', 9000, null),
  ('i_leci', 'Leci kaleng', 'kaleng', 'raw', 'Buah', 28000, null),
  ('i_jahe', 'Jahe merah', 'kg', 'raw', 'Jamu & rempah', 32000, null),
  ('i_kencur', 'Kencur', 'kg', 'raw', 'Jamu & rempah', 40000, null),
  ('i_asam', 'Asam jawa', 'kg', 'raw', 'Jamu & rempah', 30000, null),
  ('i_rempah', 'Rempah wedang (uwuh & pletok)', 'pack', 'raw', 'Jamu & rempah', 6000, null),
  ('i_mozza', 'Keju mozzarella', 'kg', 'raw', 'Susu & keju', 120000, null),
  ('i_cheddar', 'Keju cheddar', 'kg', 'raw', 'Susu & keju', 125000, null),
  ('i_susu', 'Susu UHT', 'L', 'raw', 'Susu & keju', 18500, null),
  ('i_skm', 'Susu kental manis', 'kg', 'raw', 'Susu & keju', 30000, null),
  ('i_cream', 'Whipping cream', 'L', 'raw', 'Susu & keju', 75000, null),
  ('i_butter', 'Butter', 'kg', 'raw', 'Susu & keju', 110000, null),
  ('i_mayo', 'Mayones', 'kg', 'raw', 'Saus & kering', 45000, null),
  ('i_saus', 'Saus tomat & sambal', 'kg', 'raw', 'Saus & kering', 30000, null),
  ('i_teriyaki', 'Saus teriyaki', 'L', 'raw', 'Saus & kering', 55000, null),
  ('i_coklat', 'Cokelat meses & ganache', 'kg', 'raw', 'Saus & kering', 90000, null),
  ('i_cocoa', 'Bubuk cokelat', 'kg', 'raw', 'Saus & kering', 120000, null),
  ('i_matcha', 'Bubuk matcha', 'kg', 'raw', 'Saus & kering', 450000, null),
  ('i_taro', 'Bubuk taro', 'kg', 'raw', 'Saus & kering', 150000, null),
  ('i_sirup', 'Sirup cocopandan', 'L', 'raw', 'Saus & kering', 40000, null),
  ('i_cincau', 'Cincau hitam', 'kg', 'raw', 'Saus & kering', 15000, null),
  ('i_dawet', 'Cendol dawet', 'kg', 'raw', 'Saus & kering', 20000, null),
  ('i_kopi', 'Biji kopi Kalibrantas', 'kg', 'raw', 'Minuman', 190000, null),
  ('i_teh', 'Teh hitam', 'kg', 'raw', 'Minuman', 60000, null),
  ('i_es', 'Es batu', 'kg', 'raw', 'Minuman', 2000, null),
  ('i_air', 'Air mineral botol', 'botol', 'raw', 'Minuman', 3000, null),
  ('i_cup', 'Cup & kemasan', 'pcs', 'raw', 'Kemasan', 900, null),
  ('i_pkambing', 'Pakan kambing', 'kg', 'raw', 'Play', 7000, null),
  ('i_pkelinci', 'Pakan kelinci', 'kg', 'raw', 'Play', 16000, null),
  ('i_pelet', 'Pelet ikan', 'kg', 'raw', 'Play', 21000, null),
  ('s_nasi', 'Nasi putih', 'porsi', 'semi', 'Setengah jadi', 0, 10),
  ('s_bmerah', 'Bumbu dasar merah', 'kg', 'semi', 'Setengah jadi', 0, 1),
  ('s_bkuning', 'Bumbu dasar kuning', 'kg', 'semi', 'Setengah jadi', 0, 1),
  ('s_sambal', 'Sambal bawang', 'kg', 'semi', 'Setengah jadi', 0, 1),
  ('s_matah', 'Sambal matah', 'kg', 'semi', 'Setengah jadi', 0, 1),
  ('s_ijo', 'Sambal ijo', 'kg', 'semi', 'Setengah jadi', 0, 1),
  ('s_cabegaram', 'Bumbu cabe garam', 'kg', 'semi', 'Setengah jadi', 0, 1),
  ('s_lodho', 'Kuah lodho', 'porsi', 'semi', 'Setengah jadi', 0, 10),
  ('s_ayam', 'Ayam ungkep', 'pcs', 'semi', 'Setengah jadi', 0, 5),
  ('s_bolognese', 'Saus bolognese', 'porsi', 'semi', 'Setengah jadi', 0, 8),
  ('s_carbonara', 'Saus carbonara', 'porsi', 'semi', 'Setengah jadi', 0, 8),
  ('s_adonan', 'Adonan krispi', 'kg', 'semi', 'Setengah jadi', 0, 1.6),
  ('s_aren', 'Sirup gula aren', 'L', 'semi', 'Setengah jadi', 0, 1),
  ('s_pizza', 'Adonan pizza', 'pcs', 'semi', 'Setengah jadi', 0, 4)
on conflict (id) do nothing;

insert into public.item_bom (item_id, component_id, qty) values
  ('s_nasi', 'i_beras', 1),
  ('s_bmerah', 'i_bmerah', 0.45),
  ('s_bmerah', 'i_bputih', 0.2),
  ('s_bmerah', 'i_cabai', 0.15),
  ('s_bmerah', 'i_minyak', 0.25),
  ('s_bkuning', 'i_bmerah', 0.35),
  ('s_bkuning', 'i_bputih', 0.25),
  ('s_bkuning', 'i_kunyit', 0.2),
  ('s_bkuning', 'i_minyak', 0.25),
  ('s_sambal', 'i_cabai', 0.45),
  ('s_sambal', 'i_bputih', 0.25),
  ('s_sambal', 'i_minyak', 0.35),
  ('s_sambal', 'i_gula', 0.02),
  ('s_matah', 'i_bmerah', 0.45),
  ('s_matah', 'i_cabai', 0.25),
  ('s_matah', 'i_sereh', 0.1),
  ('s_matah', 'i_minyak', 0.2),
  ('s_matah', 'i_lemon', 0.05),
  ('s_ijo', 'i_cabaihijau', 0.55),
  ('s_ijo', 'i_bmerah', 0.2),
  ('s_ijo', 'i_tomat', 0.15),
  ('s_ijo', 'i_minyak', 0.2),
  ('s_cabegaram', 'i_bputih', 0.4),
  ('s_cabegaram', 'i_cabai', 0.3),
  ('s_cabegaram', 'i_bmerah', 0.2),
  ('s_cabegaram', 'i_minyak', 0.2),
  ('s_lodho', 'i_santan', 1.5),
  ('s_lodho', 's_bkuning', 0.15),
  ('s_lodho', 'i_cabai', 0.1),
  ('s_lodho', 'i_sereh', 0.05),
  ('s_ayam', 'i_ayam', 1),
  ('s_ayam', 's_bkuning', 0.12),
  ('s_bolognese', 'i_giling', 0.6),
  ('s_bolognese', 'i_tomat', 1),
  ('s_bolognese', 'i_bputih', 0.05),
  ('s_bolognese', 'i_minyak', 0.05),
  ('s_carbonara', 'i_cream', 0.6),
  ('s_carbonara', 'i_cheddar', 0.15),
  ('s_carbonara', 'i_telur', 3),
  ('s_carbonara', 'i_beef', 0.2),
  ('s_carbonara', 'i_butter', 0.05),
  ('s_adonan', 'i_terigu', 1),
  ('s_adonan', 'i_telur', 2),
  ('s_aren', 'i_aren', 0.8),
  ('s_pizza', 'i_terigu', 1),
  ('s_pizza', 'i_minyak', 0.05),
  ('s_pizza', 'i_gula', 0.02)
on conflict do nothing;

insert into public.menu_categories (id, name, color, station, sort) values
  ('main', 'Main Dish', 'orange', 'dapur', 1),
  ('snack', 'Snacks', 'kunyit', 'dapur', 2),
  ('dessert', 'Desserts', 'plum', 'bar', 3),
  ('coffee', 'Coffee', 'kopi', 'bar', 4),
  ('noncoffee', 'Non-Coffee', 'kolam', 'bar', 5),
  ('play', 'Play & pakan', 'olive', 'none', 6)
on conflict (id) do nothing;

insert into public.menus (id, name, category_id, price, station, prep_min, active, sold_out, is_package, description, tags, sort) values
  ('m_pizza', 'Pizza Pepperoni (for 3 pax)', 'main', 75000, 'dapur', 18, true, false, false, '', '{}'::text[], 1),
  ('m_sei_sandwich', 'Se''i Brunch Sandwich', 'main', 50000, 'dapur', 10, true, false, false, '', '{}'::text[], 2),
  ('m_bolognese', 'Spaghetti Bolognese', 'main', 48000, 'dapur', 12, true, false, false, '', '{}'::text[], 3),
  ('m_sei_fries', 'Se''i Loaded Cheese Fries', 'main', 50000, 'dapur', 10, true, false, false, '', '{}'::text[], 4),
  ('m_carbonara', 'Spaghetti Carbonara', 'main', 48000, 'dapur', 12, true, false, false, '', '{}'::text[], 5),
  ('m_nasi_sei', 'Nasi Sei Sapi', 'main', 48000, 'dapur', 9, true, false, false, '', '{}'::text[], 6),
  ('m_jimbaran', 'Nasi Ayam Bakar Jimbaran', 'main', 45000, 'dapur', 15, true, false, false, '', '{}'::text[], 7),
  ('m_grilled_cheese', 'Grilled Cheese Sandwich', 'main', 45000, 'dapur', 9, true, false, false, '', '{}'::text[], 8),
  ('m_nasgor_sei', 'Nasi Goreng Se''i Sapi', 'main', 40000, 'dapur', 9, true, false, false, '', '{}'::text[], 9),
  ('m_penyet_matah', 'Nasi Ayam Penyet Sambal Matah', 'main', 40000, 'dapur', 10, true, false, false, '', '{}'::text[], 10),
  ('m_godhog_lodho', 'Mie Godhog Lodho', 'main', 38000, 'dapur', 10, true, false, false, '', '{}'::text[], 11),
  ('m_ayam_lodho', 'Nasi Ayam Lodho', 'main', 38000, 'dapur', 8, true, false, false, '', '{}'::text[], 12),
  ('m_ayam_cabegaram', 'Nasi Ayam Cabe Garam', 'main', 38000, 'dapur', 10, true, false, false, '', '{}'::text[], 13),
  ('m_geprek', 'Nasi Ayam Geprek Sambal Bawang', 'main', 38000, 'dapur', 10, true, false, false, '', '{}'::text[], 14),
  ('m_iwakpe', 'Nasi Iwak Pe Lodho', 'main', 35000, 'dapur', 8, true, false, false, '', '{}'::text[], 15),
  ('m_nasgor_paru', 'Nasi Goreng Paru Sambal Ijo', 'main', 35000, 'dapur', 9, true, false, false, '', '{}'::text[], 16),
  ('m_ayam_suwir', 'Nasi Ayam Suwir Sambal Matah', 'main', 35000, 'dapur', 8, true, false, false, '', '{}'::text[], 17),
  ('m_mie_goreng', 'Mie Goreng Kaly', 'main', 33000, 'dapur', 8, true, false, false, '', '{}'::text[], 18),
  ('m_mie_godhog', 'Mie Godhog Kaly', 'main', 33000, 'dapur', 8, true, false, false, '', '{}'::text[], 19),
  ('m_nasgor_kaly', 'Nasi Goreng Kaly', 'main', 33000, 'dapur', 8, true, false, false, '', '{}'::text[], 20),
  ('m_nasgor_kids', 'Nasi Goreng Kids Friendly', 'main', 30000, 'dapur', 8, true, false, false, '', '{}'::text[], 21),
  ('m_kids_platter', 'Kids Platter', 'main', 30000, 'dapur', 9, true, false, false, '', '{}'::text[], 22),
  ('m_kerupuk', 'Paket Kerupuk', 'main', 3000, 'none', 0, true, false, false, '', '{}'::text[], 23),
  ('m_wings_teriyaki', 'Teriyaki Chicken Wings', 'snack', 40000, 'dapur', 12, true, false, false, '', '{}'::text[], 24),
  ('m_cordon_bleu', 'Chicken Cordon Bleu Bites', 'snack', 35000, 'dapur', 10, true, false, false, '', '{}'::text[], 25),
  ('m_wings_cabegaram', 'Chicken Wings Cabe Garam', 'snack', 35000, 'dapur', 12, true, false, false, '', '{}'::text[], 26),
  ('m_kroket', 'Kroket Mozzarella', 'snack', 35000, 'dapur', 8, true, false, false, '', '{}'::text[], 27),
  ('m_pisgor_ck', 'Pisang Goreng Coklat Keju', 'snack', 0, 'dapur', 7, true, true, false, '', '{}'::text[], 28),
  ('m_pisbakar_ck', 'Pisang Bakar Coklat Keju', 'snack', 0, 'dapur', 8, true, true, false, '', '{}'::text[], 29),
  ('m_tahu_walik', 'Tahu Goreng Walik', 'snack', 28000, 'dapur', 8, true, false, false, '', '{}'::text[], 30),
  ('m_tape_goreng', 'Tape Goreng Coklat Keju', 'snack', 25000, 'dapur', 7, true, false, false, '', '{}'::text[], 31),
  ('m_churros', 'Churros', 'snack', 25000, 'dapur', 8, true, false, false, '', '{}'::text[], 32),
  ('m_fries', 'Handcut Fries with Garlic Mayo', 'snack', 25000, 'dapur', 7, true, false, false, '', '{}'::text[], 33),
  ('m_tape_bakar', 'Tape Bakar Coklat Keju', 'snack', 22000, 'dapur', 7, true, false, false, '', '{}'::text[], 34),
  ('m_ubi_keju', 'Ubi Ungu Saus Keju', 'snack', 22000, 'dapur', 7, true, false, false, '', '{}'::text[], 35),
  ('m_tahu_krispi', 'Tahu Krispi Cabe Garam', 'snack', 20000, 'dapur', 7, true, false, false, '', '{}'::text[], 36),
  ('m_dawet', 'Es Dawet', 'dessert', 25000, 'bar', 4, true, false, false, '', '{}'::text[], 37),
  ('m_pisang_ijo', 'Es Pisang Ijo', 'dessert', 25000, 'bar', 4, true, false, false, '', '{}'::text[], 38),
  ('m_doger', 'Es Doger', 'dessert', 25000, 'bar', 4, true, false, false, '', '{}'::text[], 39),
  ('m_magic', 'Magic Latte', 'coffee', 32000, 'bar', 4, true, false, false, '', '{}'::text[], 40),
  ('m_latte', 'Latte', 'coffee', 30000, 'bar', 4, true, false, false, '', '{}'::text[], 41),
  ('m_cocoricano', 'Cocoricano', 'coffee', 30000, 'bar', 4, true, false, false, '', '{}'::text[], 42),
  ('m_macho', 'Iced Macho', 'coffee', 30000, 'bar', 4, true, false, false, '', '{}'::text[], 43),
  ('m_kopi_aren', 'Es Kopi Creamy Aren', 'coffee', 25000, 'bar', 4, true, false, false, '', '{}'::text[], 44),
  ('m_shaken', 'Iced-Shaken Espresso', 'coffee', 25000, 'bar', 3, true, false, false, '', '{}'::text[], 45),
  ('m_americano', 'Americano', 'coffee', 22000, 'bar', 3, true, false, false, '', '{}'::text[], 46),
  ('m_kopsu', 'Kopi Susu Kalibrantas', 'coffee', 22000, 'bar', 3, true, false, false, '', '{}'::text[], 47),
  ('m_espresso', 'Espresso', 'coffee', 20000, 'bar', 2, true, false, false, '', '{}'::text[], 48),
  ('m_kopi_jahe', 'Kopi Jahe', 'coffee', 20000, 'bar', 4, true, false, false, '', '{}'::text[], 49),
  ('m_tubruk', 'Kopi Tubruk Kalibrantas', 'coffee', 20000, 'bar', 3, true, false, false, '', '{}'::text[], 50),
  ('m_extra_shot', 'Extra Espresso Shot', 'coffee', 5000, 'bar', 1, true, false, false, '', '{}'::text[], 51),
  ('m_kopi_lemon', 'Kopi Lemon Kebun Bapak', 'coffee', 30000, 'bar', 4, true, false, false, '', '{}'::text[], 52),
  ('m_soklat', 'Es Soklat', 'noncoffee', 25000, 'bar', 3, true, false, false, '', '{}'::text[], 53),
  ('m_sinom', 'Es Sinom', 'noncoffee', 25000, 'bar', 3, true, false, false, '', '{}'::text[], 54),
  ('m_teh_tarik', 'Es Teh Tarik', 'noncoffee', 22000, 'bar', 3, true, false, false, '', '{}'::text[], 55),
  ('m_bir_pletok', 'Bir Pletok', 'noncoffee', 20000, 'bar', 4, true, false, false, '', '{}'::text[], 56),
  ('m_setrup_cincau', 'Es Setrup Cincau', 'noncoffee', 20000, 'bar', 3, true, false, false, '', '{}'::text[], 57),
  ('m_lemon_tea', 'Lemon Tea', 'noncoffee', 20000, 'bar', 2, true, false, false, '', '{}'::text[], 58),
  ('m_orange', 'Orange Juice', 'noncoffee', 18000, 'bar', 3, true, false, false, '', '{}'::text[], 59),
  ('m_wedhang_jahe', 'Wedhang Jahe', 'noncoffee', 18000, 'bar', 4, true, false, false, '', '{}'::text[], 60),
  ('m_lemonade', 'Lemonade', 'noncoffee', 18000, 'bar', 2, true, false, false, '', '{}'::text[], 61),
  ('m_black_tea', 'Iced Black Tea', 'noncoffee', 15000, 'bar', 2, true, false, false, '', '{}'::text[], 62),
  ('m_uwuh', 'Wedhang Uwuh', 'noncoffee', 15000, 'bar', 4, true, false, false, '', '{}'::text[], 63),
  ('m_air', 'Air Mineral', 'noncoffee', 10000, 'none', 0, true, false, false, '', '{}'::text[], 64),
  ('m_lychee', 'Iced Lychee Tea', 'noncoffee', 30000, 'bar', 3, true, false, false, '', '{}'::text[], 65),
  ('m_melonade', 'Fresh Melonade', 'noncoffee', 32000, 'bar', 4, true, false, false, '', '{}'::text[], 66),
  ('m_watermelonade', 'Fresh Watermelonade', 'noncoffee', 32000, 'bar', 4, true, false, false, '', '{}'::text[], 67),
  ('m_taro', 'Taro Latte', 'noncoffee', 28000, 'bar', 3, true, false, false, '', '{}'::text[], 68),
  ('m_matcha', 'Matcha Latte', 'noncoffee', 28000, 'bar', 3, true, false, false, '', '{}'::text[], 69),
  ('m_beras_kencur', 'Beras Kencur', 'noncoffee', 20000, 'bar', 3, true, false, false, '', '{}'::text[], 70),
  ('m_kunir_asem', 'Kunir Asem', 'noncoffee', 20000, 'bar', 3, true, false, false, '', '{}'::text[], 71),
  ('m_pkambing', 'Pakan Kambing', 'play', 10000, 'none', 0, true, false, false, 'Satu cup pakan untuk kambing di kandang sawah', '{}'::text[], 72),
  ('m_pkelinci', 'Pakan Kelinci', 'play', 10000, 'none', 0, true, false, false, '', '{}'::text[], 73),
  ('m_pikan', 'Pakan Ikan', 'play', 5000, 'none', 0, true, false, false, '', '{}'::text[], 74),
  ('m_pancing', 'Sewa Pancing 1 Jam', 'play', 25000, 'none', 0, true, false, false, '', '{}'::text[], 75)
on conflict (id) do nothing;

insert into public.menu_outlets (menu_id, location_id) values
  ('m_pizza', 'L1'),
  ('m_sei_sandwich', 'L1'),
  ('m_bolognese', 'L1'),
  ('m_sei_fries', 'L1'),
  ('m_carbonara', 'L1'),
  ('m_nasi_sei', 'L1'),
  ('m_jimbaran', 'L1'),
  ('m_grilled_cheese', 'L1'),
  ('m_nasgor_sei', 'L1'),
  ('m_penyet_matah', 'L1'),
  ('m_godhog_lodho', 'L1'),
  ('m_ayam_lodho', 'L1'),
  ('m_ayam_cabegaram', 'L1'),
  ('m_geprek', 'L1'),
  ('m_iwakpe', 'L1'),
  ('m_nasgor_paru', 'L1'),
  ('m_ayam_suwir', 'L1'),
  ('m_mie_goreng', 'L1'),
  ('m_mie_godhog', 'L1'),
  ('m_nasgor_kaly', 'L1'),
  ('m_nasgor_kids', 'L1'),
  ('m_kids_platter', 'L1'),
  ('m_kerupuk', 'L1'),
  ('m_wings_teriyaki', 'L1'),
  ('m_cordon_bleu', 'L1'),
  ('m_wings_cabegaram', 'L1'),
  ('m_kroket', 'L1'),
  ('m_pisgor_ck', 'L1'),
  ('m_pisbakar_ck', 'L1'),
  ('m_tahu_walik', 'L1'),
  ('m_tape_goreng', 'L1'),
  ('m_churros', 'L1'),
  ('m_fries', 'L1'),
  ('m_tape_bakar', 'L1'),
  ('m_ubi_keju', 'L1'),
  ('m_tahu_krispi', 'L1'),
  ('m_dawet', 'L1'),
  ('m_pisang_ijo', 'L1'),
  ('m_doger', 'L1'),
  ('m_magic', 'L1'),
  ('m_latte', 'L1'),
  ('m_cocoricano', 'L1'),
  ('m_macho', 'L1'),
  ('m_kopi_aren', 'L1'),
  ('m_shaken', 'L1'),
  ('m_americano', 'L1'),
  ('m_kopsu', 'L1'),
  ('m_espresso', 'L1'),
  ('m_kopi_jahe', 'L1'),
  ('m_tubruk', 'L1'),
  ('m_extra_shot', 'L1'),
  ('m_kopi_lemon', 'L1'),
  ('m_soklat', 'L1'),
  ('m_soklat', 'L2'),
  ('m_sinom', 'L1'),
  ('m_teh_tarik', 'L1'),
  ('m_bir_pletok', 'L1'),
  ('m_setrup_cincau', 'L1'),
  ('m_lemon_tea', 'L1'),
  ('m_lemon_tea', 'L2'),
  ('m_orange', 'L1'),
  ('m_orange', 'L2'),
  ('m_wedhang_jahe', 'L1'),
  ('m_lemonade', 'L1'),
  ('m_black_tea', 'L1'),
  ('m_black_tea', 'L2'),
  ('m_uwuh', 'L1'),
  ('m_air', 'L1'),
  ('m_air', 'L2'),
  ('m_lychee', 'L1'),
  ('m_melonade', 'L1'),
  ('m_watermelonade', 'L1'),
  ('m_taro', 'L1'),
  ('m_matcha', 'L1'),
  ('m_beras_kencur', 'L1'),
  ('m_kunir_asem', 'L1'),
  ('m_pkambing', 'L2'),
  ('m_pkelinci', 'L2'),
  ('m_pikan', 'L2'),
  ('m_pancing', 'L2')
on conflict do nothing;

insert into public.menu_bom (menu_id, item_id, qty) values
  ('m_pizza', 's_pizza', 1),
  ('m_pizza', 'i_mozza', 0.1),
  ('m_pizza', 'i_pepperoni', 0.05),
  ('m_pizza', 'i_saus', 0.08),
  ('m_sei_sandwich', 'i_roti', 2),
  ('m_sei_sandwich', 'i_sei', 0.05),
  ('m_sei_sandwich', 'i_telur', 1),
  ('m_sei_sandwich', 'i_cheddar', 0.015),
  ('m_sei_sandwich', 'i_sayur', 0.03),
  ('m_sei_sandwich', 'i_mayo', 0.015),
  ('m_sei_sandwich', 'i_kentang', 0.12),
  ('m_sei_sandwich', 'i_minyak', 0.04),
  ('m_bolognese', 'i_spageti', 0.12),
  ('m_bolognese', 's_bolognese', 1),
  ('m_bolognese', 'i_cheddar', 0.015),
  ('m_bolognese', 'i_butter', 0.01),
  ('m_sei_fries', 'i_kentang', 0.25),
  ('m_sei_fries', 'i_minyak', 0.06),
  ('m_sei_fries', 'i_sei', 0.04),
  ('m_sei_fries', 'i_cheddar', 0.03),
  ('m_sei_fries', 'i_mozza', 0.02),
  ('m_sei_fries', 'i_mayo', 0.02),
  ('m_carbonara', 'i_spageti', 0.12),
  ('m_carbonara', 's_carbonara', 1),
  ('m_nasi_sei', 's_nasi', 1),
  ('m_nasi_sei', 'i_sei', 0.07),
  ('m_nasi_sei', 's_matah', 0.03),
  ('m_nasi_sei', 'i_sayur', 0.03),
  ('m_jimbaran', 's_nasi', 1),
  ('m_jimbaran', 's_ayam', 1),
  ('m_jimbaran', 's_bmerah', 0.03),
  ('m_jimbaran', 'i_aren', 0.02),
  ('m_jimbaran', 's_matah', 0.03),
  ('m_jimbaran', 'i_sayur', 0.03),
  ('m_grilled_cheese', 'i_roti', 2),
  ('m_grilled_cheese', 'i_cheddar', 0.04),
  ('m_grilled_cheese', 'i_mozza', 0.04),
  ('m_grilled_cheese', 'i_butter', 0.02),
  ('m_grilled_cheese', 'i_kentang', 0.12),
  ('m_grilled_cheese', 'i_minyak', 0.04),
  ('m_grilled_cheese', 'i_mayo', 0.01),
  ('m_nasgor_sei', 's_nasi', 1),
  ('m_nasgor_sei', 'i_sei', 0.04),
  ('m_nasgor_sei', 'i_telur', 1),
  ('m_nasgor_sei', 's_bmerah', 0.03),
  ('m_nasgor_sei', 'i_minyak', 0.02),
  ('m_nasgor_sei', 'i_kerupuk', 1),
  ('m_penyet_matah', 's_nasi', 1),
  ('m_penyet_matah', 's_ayam', 1),
  ('m_penyet_matah', 'i_minyak', 0.05),
  ('m_penyet_matah', 's_matah', 0.04),
  ('m_penyet_matah', 'i_tahu', 1),
  ('m_penyet_matah', 'i_sayur', 0.03),
  ('m_godhog_lodho', 'i_mie', 1),
  ('m_godhog_lodho', 's_lodho', 1),
  ('m_godhog_lodho', 's_ayam', 0.5),
  ('m_godhog_lodho', 'i_telur', 1),
  ('m_godhog_lodho', 'i_sayur', 0.03),
  ('m_ayam_lodho', 's_nasi', 1),
  ('m_ayam_lodho', 's_ayam', 1),
  ('m_ayam_lodho', 's_lodho', 1),
  ('m_ayam_cabegaram', 's_nasi', 1),
  ('m_ayam_cabegaram', 's_ayam', 1),
  ('m_ayam_cabegaram', 's_adonan', 0.05),
  ('m_ayam_cabegaram', 'i_minyak', 0.06),
  ('m_ayam_cabegaram', 's_cabegaram', 0.03),
  ('m_geprek', 's_nasi', 1),
  ('m_geprek', 's_ayam', 1),
  ('m_geprek', 's_adonan', 0.06),
  ('m_geprek', 'i_minyak', 0.06),
  ('m_geprek', 's_sambal', 0.04),
  ('m_iwakpe', 's_nasi', 1),
  ('m_iwakpe', 'i_ikanpe', 0.08),
  ('m_iwakpe', 's_lodho', 1),
  ('m_nasgor_paru', 's_nasi', 1),
  ('m_nasgor_paru', 'i_paru', 0.07),
  ('m_nasgor_paru', 's_bmerah', 0.03),
  ('m_nasgor_paru', 's_ijo', 0.03),
  ('m_nasgor_paru', 'i_telur', 1),
  ('m_nasgor_paru', 'i_minyak', 0.02),
  ('m_ayam_suwir', 's_nasi', 1),
  ('m_ayam_suwir', 's_ayam', 0.8),
  ('m_ayam_suwir', 's_matah', 0.04),
  ('m_ayam_suwir', 'i_sayur', 0.03),
  ('m_ayam_suwir', 'i_kerupuk', 1),
  ('m_mie_goreng', 'i_mie', 1),
  ('m_mie_goreng', 'i_telur', 1),
  ('m_mie_goreng', 's_bmerah', 0.025),
  ('m_mie_goreng', 's_ayam', 0.3),
  ('m_mie_goreng', 'i_sayur', 0.04),
  ('m_mie_goreng', 'i_minyak', 0.02),
  ('m_mie_godhog', 'i_mie', 1),
  ('m_mie_godhog', 'i_telur', 1),
  ('m_mie_godhog', 's_bkuning', 0.02),
  ('m_mie_godhog', 's_ayam', 0.3),
  ('m_mie_godhog', 'i_sayur', 0.04),
  ('m_nasgor_kaly', 's_nasi', 1),
  ('m_nasgor_kaly', 'i_telur', 1),
  ('m_nasgor_kaly', 's_bmerah', 0.03),
  ('m_nasgor_kaly', 's_ayam', 0.3),
  ('m_nasgor_kaly', 'i_minyak', 0.02),
  ('m_nasgor_kaly', 'i_kerupuk', 1),
  ('m_nasgor_kaly', 's_sambal', 0.01),
  ('m_nasgor_kids', 's_nasi', 1),
  ('m_nasgor_kids', 'i_telur', 1),
  ('m_nasgor_kids', 'i_nugget', 0.05),
  ('m_nasgor_kids', 'i_saus', 0.02),
  ('m_nasgor_kids', 'i_minyak', 0.02),
  ('m_nasgor_kids', 'i_butter', 0.01),
  ('m_kids_platter', 's_nasi', 0.7),
  ('m_kids_platter', 'i_nugget', 0.1),
  ('m_kids_platter', 'i_kentang', 0.1),
  ('m_kids_platter', 'i_minyak', 0.05),
  ('m_kids_platter', 'i_saus', 0.02),
  ('m_kids_platter', 'i_telur', 0.5),
  ('m_kerupuk', 'i_kerupuk', 2),
  ('m_wings_teriyaki', 'i_sayap', 0.3),
  ('m_wings_teriyaki', 'i_teriyaki', 0.03),
  ('m_wings_teriyaki', 'i_minyak', 0.05),
  ('m_wings_teriyaki', 's_adonan', 0.03),
  ('m_cordon_bleu', 'i_fillet', 0.11),
  ('m_cordon_bleu', 'i_beef', 0.015),
  ('m_cordon_bleu', 'i_mozza', 0.015),
  ('m_cordon_bleu', 'i_panir', 0.03),
  ('m_cordon_bleu', 'i_telur', 0.5),
  ('m_cordon_bleu', 'i_minyak', 0.06),
  ('m_cordon_bleu', 'i_mayo', 0.015),
  ('m_wings_cabegaram', 'i_sayap', 0.25),
  ('m_wings_cabegaram', 's_adonan', 0.04),
  ('m_wings_cabegaram', 'i_minyak', 0.05),
  ('m_wings_cabegaram', 's_cabegaram', 0.03),
  ('m_kroket', 'i_kentang', 0.2),
  ('m_kroket', 'i_mozza', 0.05),
  ('m_kroket', 'i_panir', 0.04),
  ('m_kroket', 'i_telur', 0.5),
  ('m_kroket', 'i_minyak', 0.06),
  ('m_kroket', 'i_mayo', 0.02),
  ('m_pisgor_ck', 'i_pisang', 0.25),
  ('m_pisgor_ck', 's_adonan', 0.08),
  ('m_pisgor_ck', 'i_coklat', 0.02),
  ('m_pisgor_ck', 'i_cheddar', 0.02),
  ('m_pisgor_ck', 'i_minyak', 0.05),
  ('m_pisbakar_ck', 'i_pisang', 0.25),
  ('m_pisbakar_ck', 'i_butter', 0.01),
  ('m_pisbakar_ck', 'i_coklat', 0.02),
  ('m_pisbakar_ck', 'i_cheddar', 0.02),
  ('m_pisbakar_ck', 'i_skm', 0.02),
  ('m_tahu_walik', 'i_tahu', 5),
  ('m_tahu_walik', 'i_terigu', 0.05),
  ('m_tahu_walik', 'i_fillet', 0.04),
  ('m_tahu_walik', 'i_minyak', 0.06),
  ('m_tahu_walik', 's_sambal', 0.02),
  ('m_tape_goreng', 'i_tape', 0.2),
  ('m_tape_goreng', 's_adonan', 0.06),
  ('m_tape_goreng', 'i_coklat', 0.02),
  ('m_tape_goreng', 'i_cheddar', 0.02),
  ('m_tape_goreng', 'i_minyak', 0.05),
  ('m_tape_goreng', 'i_skm', 0.02),
  ('m_churros', 'i_terigu', 0.1),
  ('m_churros', 'i_butter', 0.02),
  ('m_churros', 'i_telur', 1),
  ('m_churros', 'i_gula', 0.02),
  ('m_churros', 'i_coklat', 0.03),
  ('m_churros', 'i_minyak', 0.06),
  ('m_fries', 'i_kentang', 0.3),
  ('m_fries', 'i_minyak', 0.06),
  ('m_fries', 'i_mayo', 0.03),
  ('m_fries', 'i_bputih', 0.005),
  ('m_tape_bakar', 'i_tape', 0.2),
  ('m_tape_bakar', 'i_butter', 0.01),
  ('m_tape_bakar', 'i_coklat', 0.02),
  ('m_tape_bakar', 'i_cheddar', 0.015),
  ('m_tape_bakar', 'i_skm', 0.02),
  ('m_ubi_keju', 'i_ubi', 0.25),
  ('m_ubi_keju', 'i_cheddar', 0.02),
  ('m_ubi_keju', 'i_susu', 0.05),
  ('m_ubi_keju', 'i_butter', 0.005),
  ('m_ubi_keju', 'i_minyak', 0.03),
  ('m_tahu_krispi', 'i_tahu', 5),
  ('m_tahu_krispi', 's_adonan', 0.05),
  ('m_tahu_krispi', 'i_minyak', 0.06),
  ('m_tahu_krispi', 's_cabegaram', 0.02),
  ('m_dawet', 'i_dawet', 0.12),
  ('m_dawet', 'i_santan', 0.1),
  ('m_dawet', 's_aren', 0.04),
  ('m_dawet', 'i_es', 0.15),
  ('m_dawet', 'i_cup', 1),
  ('m_pisang_ijo', 'i_pisang', 0.15),
  ('m_pisang_ijo', 'i_tpberas', 0.05),
  ('m_pisang_ijo', 'i_santan', 0.08),
  ('m_pisang_ijo', 'i_sirup', 0.03),
  ('m_pisang_ijo', 'i_skm', 0.02),
  ('m_pisang_ijo', 'i_es', 0.15),
  ('m_pisang_ijo', 'i_cup', 1),
  ('m_doger', 'i_kelapa', 0.4),
  ('m_doger', 'i_tape', 0.05),
  ('m_doger', 'i_santan', 0.08),
  ('m_doger', 'i_sirup', 0.03),
  ('m_doger', 'i_skm', 0.02),
  ('m_doger', 'i_es', 0.15),
  ('m_doger', 'i_cup', 1),
  ('m_magic', 'i_kopi', 0.02),
  ('m_magic', 'i_susu', 0.15),
  ('m_latte', 'i_kopi', 0.018),
  ('m_latte', 'i_susu', 0.2),
  ('m_cocoricano', 'i_kopi', 0.018),
  ('m_cocoricano', 'i_cocoa', 0.015),
  ('m_cocoricano', 'i_gula', 0.015),
  ('m_cocoricano', 'i_es', 0.15),
  ('m_cocoricano', 'i_cup', 1),
  ('m_macho', 'i_kopi', 0.018),
  ('m_macho', 'i_susu', 0.15),
  ('m_macho', 'i_cream', 0.02),
  ('m_macho', 'i_es', 0.15),
  ('m_macho', 'i_cup', 1),
  ('m_kopi_aren', 'i_kopi', 0.018),
  ('m_kopi_aren', 'i_susu', 0.12),
  ('m_kopi_aren', 'i_cream', 0.02),
  ('m_kopi_aren', 's_aren', 0.03),
  ('m_kopi_aren', 'i_es', 0.15),
  ('m_kopi_aren', 'i_cup', 1),
  ('m_shaken', 'i_kopi', 0.018),
  ('m_shaken', 's_aren', 0.02),
  ('m_shaken', 'i_es', 0.2),
  ('m_shaken', 'i_cup', 1),
  ('m_americano', 'i_kopi', 0.018),
  ('m_kopsu', 'i_kopi', 0.018),
  ('m_kopsu', 'i_susu', 0.1),
  ('m_kopsu', 'i_skm', 0.02),
  ('m_kopsu', 'i_es', 0.15),
  ('m_kopsu', 'i_cup', 1),
  ('m_espresso', 'i_kopi', 0.018),
  ('m_kopi_jahe', 'i_kopi', 0.012),
  ('m_kopi_jahe', 'i_jahe', 0.02),
  ('m_kopi_jahe', 'i_gula', 0.015),
  ('m_tubruk', 'i_kopi', 0.012),
  ('m_tubruk', 'i_gula', 0.015),
  ('m_extra_shot', 'i_kopi', 0.009),
  ('m_kopi_lemon', 'i_kopi', 0.018),
  ('m_kopi_lemon', 'i_lemon', 0.05),
  ('m_kopi_lemon', 'i_gula', 0.02),
  ('m_kopi_lemon', 'i_es', 0.15),
  ('m_kopi_lemon', 'i_cup', 1),
  ('m_soklat', 'i_cocoa', 0.025),
  ('m_soklat', 'i_susu', 0.15),
  ('m_soklat', 'i_gula', 0.015),
  ('m_soklat', 'i_es', 0.15),
  ('m_soklat', 'i_cup', 1),
  ('m_sinom', 'i_kunyit', 0.02),
  ('m_sinom', 'i_asam', 0.02),
  ('m_sinom', 's_aren', 0.03),
  ('m_sinom', 'i_es', 0.15),
  ('m_sinom', 'i_cup', 1),
  ('m_teh_tarik', 'i_teh', 0.008),
  ('m_teh_tarik', 'i_skm', 0.04),
  ('m_teh_tarik', 'i_susu', 0.05),
  ('m_teh_tarik', 'i_es', 0.15),
  ('m_teh_tarik', 'i_cup', 1),
  ('m_bir_pletok', 'i_rempah', 0.25),
  ('m_bir_pletok', 'i_jahe', 0.02),
  ('m_bir_pletok', 'i_gula', 0.02),
  ('m_setrup_cincau', 'i_cincau', 0.1),
  ('m_setrup_cincau', 'i_sirup', 0.03),
  ('m_setrup_cincau', 'i_skm', 0.02),
  ('m_setrup_cincau', 'i_es', 0.15),
  ('m_setrup_cincau', 'i_cup', 1),
  ('m_lemon_tea', 'i_teh', 0.006),
  ('m_lemon_tea', 'i_lemon', 0.04),
  ('m_lemon_tea', 'i_gula', 0.02),
  ('m_lemon_tea', 'i_es', 0.15),
  ('m_lemon_tea', 'i_cup', 1),
  ('m_orange', 'i_jeruk', 0.25),
  ('m_orange', 'i_gula', 0.01),
  ('m_orange', 'i_es', 0.1),
  ('m_orange', 'i_cup', 1),
  ('m_wedhang_jahe', 'i_jahe', 0.03),
  ('m_wedhang_jahe', 's_aren', 0.03),
  ('m_wedhang_jahe', 'i_sereh', 0.01),
  ('m_lemonade', 'i_lemon', 0.06),
  ('m_lemonade', 'i_gula', 0.025),
  ('m_lemonade', 'i_es', 0.15),
  ('m_lemonade', 'i_cup', 1),
  ('m_black_tea', 'i_teh', 0.005),
  ('m_black_tea', 'i_gula', 0.02),
  ('m_black_tea', 'i_es', 0.15),
  ('m_black_tea', 'i_cup', 1),
  ('m_uwuh', 'i_rempah', 0.5),
  ('m_uwuh', 's_aren', 0.02),
  ('m_air', 'i_air', 1),
  ('m_lychee', 'i_teh', 0.006),
  ('m_lychee', 'i_leci', 0.2),
  ('m_lychee', 'i_gula', 0.01),
  ('m_lychee', 'i_es', 0.15),
  ('m_lychee', 'i_cup', 1),
  ('m_melonade', 'i_melon', 0.3),
  ('m_melonade', 'i_lemon', 0.03),
  ('m_melonade', 'i_gula', 0.02),
  ('m_melonade', 'i_es', 0.15),
  ('m_melonade', 'i_cup', 1),
  ('m_watermelonade', 'i_semangka', 0.4),
  ('m_watermelonade', 'i_lemon', 0.03),
  ('m_watermelonade', 'i_gula', 0.02),
  ('m_watermelonade', 'i_es', 0.15),
  ('m_watermelonade', 'i_cup', 1),
  ('m_taro', 'i_taro', 0.03),
  ('m_taro', 'i_susu', 0.2),
  ('m_taro', 'i_es', 0.15),
  ('m_taro', 'i_cup', 1),
  ('m_matcha', 'i_matcha', 0.008),
  ('m_matcha', 'i_susu', 0.2),
  ('m_matcha', 'i_gula', 0.01),
  ('m_matcha', 'i_es', 0.15),
  ('m_matcha', 'i_cup', 1),
  ('m_beras_kencur', 'i_tpberas', 0.03),
  ('m_beras_kencur', 'i_kencur', 0.03),
  ('m_beras_kencur', 'i_jahe', 0.01),
  ('m_beras_kencur', 's_aren', 0.03),
  ('m_beras_kencur', 'i_cup', 1),
  ('m_kunir_asem', 'i_kunyit', 0.04),
  ('m_kunir_asem', 'i_asam', 0.03),
  ('m_kunir_asem', 's_aren', 0.03),
  ('m_kunir_asem', 'i_cup', 1),
  ('m_pkambing', 'i_pkambing', 0.25),
  ('m_pkambing', 'i_cup', 1),
  ('m_pkelinci', 'i_pkelinci', 0.15),
  ('m_pkelinci', 'i_cup', 1),
  ('m_pikan', 'i_pelet', 0.1),
  ('m_pikan', 'i_cup', 1)
on conflict do nothing;

insert into public.tiers (id, name, min_spend, discount, multiplier, perks, sort) values
  ('bibit', 'Bibit', 0, 0, 1, 'Poin 1× setiap Rp10.000, birthday treat 25%', 1),
  ('tunas', 'Tunas', 1000000, 0.05, 1.25, 'Diskon 5%, poin 1,25×, prioritas reservasi gazebo', 2),
  ('panen', 'Panen', 3000000, 0.1, 1.5, 'Diskon 10%, poin 1,5×, gratis 1 cup pakan setiap kunjungan', 3)
on conflict (id) do nothing;

-- Stok awal (contoh). Lakukan stock opname di hari pertama operasional supaya sesuai stok fisik.
insert into public.stock (location_id, item_id, qty, avg_cost, min_qty)
select v.* from (values
  ('L1', 'i_beras', 45, 14000, 25),
  ('L1', 'i_mie', 40, 3500, 20),
  ('L1', 'i_spageti', 6, 32000, 4),
  ('L1', 'i_terigu', 12, 12000, 8),
  ('L1', 'i_tpberas', 3, 14000, 2),
  ('L1', 'i_panir', 4, 28000, 2),
  ('L1', 'i_roti', 60, 1300, 40),
  ('L1', 'i_minyak', 30, 17500, 15),
  ('L1', 'i_gula', 14, 16500, 8),
  ('L1', 'i_aren', 6, 32000, 4),
  ('L1', 'i_kerupuk', 180, 600, 100),
  ('L1', 'i_kentang', 22, 14000, 15),
  ('L1', 'i_ubi', 6, 15000, 4),
  ('L1', 'i_tape', 7, 14000, 4),
  ('L1', 'i_ayam', 18, 38000, 15),
  ('L1', 'i_sayap', 9, 42000, 8),
  ('L1', 'i_fillet', 5, 55000, 4),
  ('L1', 'i_sei', 3.2, 200000, 2),
  ('L1', 'i_paru', 3, 90000, 2),
  ('L1', 'i_ikanpe', 1.5, 85000, 2),
  ('L1', 'i_telur', 160, 2200, 90),
  ('L1', 'i_beef', 1.6, 150000, 1),
  ('L1', 'i_pepperoni', 1.2, 220000, 1),
  ('L1', 'i_nugget', 4, 65000, 3),
  ('L1', 'i_tahu', 120, 900, 80),
  ('L1', 'i_bmerah', 2, 42000, 1),
  ('L1', 'i_bputih', 1.5, 36000, 1),
  ('L1', 'i_cabai', 1, 60000, 1.5),
  ('L1', 'i_cabaihijau', 1.2, 45000, 1),
  ('L1', 'i_kunyit', 1, 25000, 0.5),
  ('L1', 'i_tomat', 3, 15000, 2),
  ('L1', 'i_sayur', 6, 15000, 4),
  ('L1', 'i_sereh', 1, 20000, 0.5),
  ('L1', 'i_santan', 6, 25000, 4),
  ('L1', 'i_lemon', 4, 35000, 3),
  ('L1', 'i_jeruk', 9, 20000, 6),
  ('L1', 'i_pisang', 5, 18000, 3),
  ('L1', 'i_melon', 8, 18000, 5),
  ('L1', 'i_semangka', 10, 9000, 6),
  ('L1', 'i_kelapa', 14, 9000, 10),
  ('L1', 'i_leci', 8, 28000, 6),
  ('L1', 'i_jahe', 2, 32000, 1.5),
  ('L1', 'i_kencur', 1, 40000, 0.5),
  ('L1', 'i_asam', 1, 30000, 0.5),
  ('L1', 'i_rempah', 20, 6000, 12),
  ('L1', 'i_mozza', 3, 120000, 2),
  ('L1', 'i_cheddar', 1.4, 125000, 2),
  ('L1', 'i_susu', 24, 18500, 18),
  ('L1', 'i_skm', 4, 30000, 3),
  ('L1', 'i_cream', 4, 75000, 3),
  ('L1', 'i_butter', 2, 110000, 1.5),
  ('L1', 'i_mayo', 4, 45000, 2),
  ('L1', 'i_saus', 4, 30000, 2),
  ('L1', 'i_teriyaki', 2, 55000, 1),
  ('L1', 'i_coklat', 2, 90000, 1.5),
  ('L1', 'i_cocoa', 1.2, 120000, 1),
  ('L1', 'i_matcha', 0.4, 450000, 0.3),
  ('L1', 'i_taro', 0.8, 150000, 0.5),
  ('L1', 'i_sirup', 3, 40000, 2),
  ('L1', 'i_cincau', 3, 15000, 2),
  ('L1', 'i_dawet', 3, 20000, 2),
  ('L1', 'i_kopi', 1.4, 190000, 2),
  ('L1', 'i_teh', 1.5, 60000, 1),
  ('L1', 'i_es', 60, 2000, 40),
  ('L1', 'i_air', 72, 3000, 48),
  ('L1', 'i_cup', 420, 900, 300),
  ('L1', 'i_pkambing', 4, 7000, 3),
  ('L1', 's_nasi', 24, 1400, 20),
  ('L1', 's_ayam', 14, 8393.8, 20),
  ('L1', 's_adonan', 3, 10250, 2),
  ('L1', 's_bmerah', 2.4, 39475, 2),
  ('L1', 's_bkuning', 1.5, 33075, 1),
  ('L1', 's_sambal', 1.6, 42455, 1.5),
  ('L1', 's_matah', 1.2, 41150, 1),
  ('L1', 's_ijo', 0.9, 38900, 0.8),
  ('L1', 's_cabegaram', 1, 44300, 0.8),
  ('L1', 's_lodho', 18, 4946.125, 20),
  ('L1', 's_bolognese', 8, 11959.375, 10),
  ('L1', 's_carbonara', 6, 13231.25, 6),
  ('L1', 's_aren', 2, 25600, 1.5),
  ('L1', 's_pizza', 6, 3301.25, 4),
  ('L2', 'i_pkambing', 18, 7000, 10),
  ('L2', 'i_pkelinci', 6, 16000, 4),
  ('L2', 'i_pelet', 5, 21000, 3),
  ('L2', 'i_cup', 380, 900, 250),
  ('L2', 'i_teh', 1, 60000, 0.5),
  ('L2', 'i_gula', 5, 16500, 3),
  ('L2', 'i_es', 30, 2000, 20),
  ('L2', 'i_jeruk', 5, 20000, 4),
  ('L2', 'i_lemon', 2, 35000, 1.5),
  ('L2', 'i_cocoa', 0.6, 120000, 0.5),
  ('L2', 'i_susu', 8, 18500, 6),
  ('L2', 'i_air', 48, 3000, 24),
  ('L3', 'i_bmerah', 15, 42000, 10),
  ('L3', 'i_bputih', 9, 36000, 6),
  ('L3', 'i_cabai', 6, 60000, 5),
  ('L3', 'i_cabaihijau', 4, 45000, 3),
  ('L3', 'i_kunyit', 5, 25000, 3),
  ('L3', 'i_tomat', 12, 15000, 8),
  ('L3', 'i_santan', 20, 25000, 12),
  ('L3', 'i_giling', 10, 130000, 8),
  ('L3', 'i_sereh', 3, 20000, 2),
  ('L3', 'i_aren', 8, 32000, 5),
  ('L3', 'i_minyak', 25, 17500, 15),
  ('L3', 'i_gula', 10, 16500, 5),
  ('L3', 's_bmerah', 9, 39475, 6),
  ('L3', 's_bkuning', 6, 33075, 4),
  ('L3', 's_sambal', 5, 42455, 4),
  ('L3', 's_lodho', 40, 4946.125, 30),
  ('L3', 's_bolognese', 24, 11959.375, 16)
) as v(location_id, item_id, qty, avg_cost, min_qty)
where not exists (select 1 from public.stock_moves limit 1)
on conflict do nothing;

-- Kartu stok dibuka dengan saldo awal, dan nilainya dibukukan ke akun Persediaan (lawan: Modal disetor)
do $$
declare e record; v numeric;
begin
  if exists (select 1 from public.stock_moves limit 1) then return; end if;
  perform engine.on_();
  insert into public.stock_moves (location_id, item_id, qty, unit_cost, type, ref)
    select location_id, item_id, qty, avg_cost, 'adjust', 'SALDO-AWAL' from public.stock where qty <> 0;
  for e in select id from public.entities loop
    select coalesce(round(sum(s.qty * s.avg_cost)), 0) into v from public.stock s join public.locations l on l.id = s.location_id where l.entity_id = e.id;
    if v > 0 then
      perform engine.post(e.id, 'Saldo awal persediaan', null, 'Saldo awal', jsonb_build_array(jsonb_build_array('1201', v, 0), jsonb_build_array('3101', 0, v)), now(), null, null);
    end if;
  end loop;
end $$;

do $$ begin perform set_config('kaly.engine', '', false); end $$;
