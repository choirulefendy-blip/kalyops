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
     order by s.open_at desc limit 80) q), '[]'::jsonb);
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
