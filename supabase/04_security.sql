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
      new.split_from, new.merged_into, new.public_token, new.payment_pending, new.released, new.scheduled_at, new.delivery_fee, new.created_at)
     is distinct from
     (old.id, old.no, old.biz_day, old.location_id, old.channel, old.status, old.kitchen_state, old.created_by, old.bill, old.total, old.paid_at, old.paid_by,
      old.shift_id, old.change_amount, old.tendered, old.earned_points, old.ready_at, old.picked_at, old.void_reason, old.void_by, old.void_at,
      old.split_from, old.merged_into, old.public_token, old.payment_pending, old.released, old.scheduled_at, old.delivery_fee, old.created_at) then
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
-- Realtime: layar dapur, denah, kasir, dan lounge ikut berubah otomatis
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['orders', 'order_lines', 'order_notices', 'reservations', 'stock', 'menus', 'dining_tables', 'shifts'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

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
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sync_log') then
    alter publication supabase_realtime add table public.sync_log;
  end if;
end $$;

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
  select name into v_name from staff where id = new.staff_id;
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
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 5000)'
    using v_url, jsonb_build_object('id', new.id), '{"Content-Type": "application/json"}'::jsonb;
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
