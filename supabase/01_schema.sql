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
  status         text not null default 'open' check (status in ('open', 'paid', 'void')),
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
  type       text not null check (type in ('topup', 'pay', 'refund')),
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
