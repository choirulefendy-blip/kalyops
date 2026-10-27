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
  if o.status = 'paid' and o.bill is not null then return o.bill; end if;
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
begin
  select * into sh from shifts where id = p_shift;
  select count(*), coalesce(sum(total), 0), coalesce(sum((bill->>'disc')::numeric), 0) into v_count, v_total, v_disc from orders where shift_id = p_shift and status = 'paid';
  select coalesce(jsonb_object_agg(method, amt), '{}'::jsonb) into v_by from (select p.method, sum(p.amount) amt from order_payments p join orders o on o.id = p.order_id where o.shift_id = p_shift and o.status = 'paid' group by p.method) x;
  v_cash := coalesce((v_by->>'cash')::numeric, 0);
  select coalesce(sum(amount) filter (where type = 'topup' and method = 'cash'), 0), coalesce(sum(amount) filter (where type = 'refund'), 0) into v_top, v_ref from deposit_tx where shift_id = p_shift;
  select count(*) into v_voids from orders where status = 'void' and void_by = sh.staff_id and void_at >= sh.open_at and (sh.close_at is null or void_at <= sh.close_at);
  return jsonb_build_object('count', v_count, 'total', v_total, 'disc', v_disc, 'by', v_by, 'top_cash', v_top, 'refund_cash', v_ref,
                            'expected', sh.open_cash + v_cash + v_top - v_ref, 'voids', v_voids, 'no_sale', sh.no_sale);
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
