-- Kaly Ops 2.19 · Template diskon dari Backoffice, kasir hanya memilih
-- Jalankan di Supabase > SQL Editor setelah SQL 2.18.
-- Isi: tabel discounts + keamanannya, compute_bill (nama template & batas rupiah),
--      fungsi discount_save / discount_delete / discount_apply, apply_manual_discount jadi khusus Owner,
--      dan trx_export (laporan per transaksi yang bisa diunduh di Backoffice).

create table if not exists public.discounts (
  id          text primary key default public.new_id('dsc'),
  name        text not null,
  type        text not null check (type in ('pct', 'amt')),
  value       numeric(14,4) not null,
  max_disc    numeric(14,0) not null default 0,
  outlets     text[],
  need_reason boolean not null default false,
  need_pin    boolean not null default false,
  active      boolean not null default true,
  until       timestamptz,
  sort        int not null default 0,
  created_at  timestamptz not null default now(),
  check ((type = 'pct' and value > 0 and value <= 1) or (type = 'amt' and value > 0))
);
comment on table public.discounts is 'Template diskon yang dibuat Owner/Manajer di Kaly Backoffice (2.19). Kasir hanya memilih template ini, tidak mengisi angka sendiri (apply_manual_discount kini khusus Owner).';
comment on column public.discounts.value is 'pct: 0,20 = 20%. amt: nominal rupiah.';
comment on column public.discounts.max_disc is 'Batas rupiah untuk diskon persen. 0 = tanpa batas.';
comment on column public.discounts.outlets is 'Outlet yang boleh memakai. Kosong = semua outlet.';

alter table public.discounts enable row level security;
-- 2.19: role anon (kunci publik di web) tidak boleh menyentuh template diskon sama sekali.
-- TRUNCATE tidak tunduk pada RLS, jadi harus dicabut langsung. Pasang baru sudah bersih lewat 04_security;
-- migrasi ini membuat tabel baru di database yang sudah ada, yang mewarisi hak default.
revoke all on public.discounts from anon;
select engine.policy('discounts', 'staf baca', 'select', 'public.is_staff()');
select engine.policy('discounts', 'owner tambah', 'insert', null, 'public.is_staff(array[''owner''])');
select engine.policy('discounts', 'owner ubah', 'update', 'public.is_staff(array[''owner''])');
select engine.policy('discounts', 'owner hapus', 'delete', 'public.is_staff(array[''owner''])');
drop trigger if exists sync_log on public.discounts;
create trigger sync_log after insert or update or delete on public.discounts for each statement execute function engine.tg_sync_log();
drop trigger if exists audit on public.discounts;
create trigger audit after insert or update or delete on public.discounts for each row execute function engine.tg_audit();

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
    v_a := engine.jsround(v_a);
    -- 2.19: template diskon boleh punya batas rupiah untuk diskon persen
    if coalesce((v_md->>'max')::numeric, 0) > 0 then v_a := least(v_a, (v_md->>'max')::numeric); end if;
    v_a := least(v_a, v_run);
    if v_a > 0 then
      -- 2.19: nota memakai nama template diskon bila ada
      v_discs := v_discs || jsonb_build_object('label', coalesce(nullif(v_md->>'name', ''),
        'Diskon manual' || case when v_md->>'type' = 'pct' then ' ' || engine.jsround((v_md->>'value')::numeric * 100)::int || '%' else '' end), 'amt', v_a, 'kind', 'manual');
      v_run := v_run - v_a;
    end if;
  end if;
  v_disc := v_sub - v_run;
  v_svc := engine.jsround(v_run * s.service_rate);
  v_tax := engine.jsround((v_run + v_svc) * s.tax_rate);
  return jsonb_build_object('sub', v_sub, 'discs', v_discs, 'disc', v_disc, 'base', v_run, 'svc', v_svc, 'tax', v_tax, 'deliv', o.delivery_fee,
                            'total', v_run + v_svc + v_tax + o.delivery_fee);
end $$;

create or replace function public.apply_manual_discount(p_order text, p_type text, p_value numeric, p_reason text, p_pin text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare me public.staff; o public.orders; b jsonb; v_ratio numeric; v_val numeric; v_ok boolean := false; s public.settings := engine.cfg();
begin
  me := engine.require_role(array['owner']);
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

create or replace function public.discount_save(p_id text, p_name text, p_type text, p_value numeric, p_max numeric default 0,
  p_outlets text[] default null, p_need_reason boolean default false, p_need_pin boolean default false,
  p_active boolean default true, p_until timestamptz default null, p_sort int default 0)
returns text language plpgsql security definer set search_path = public as $$
declare v_id text; v_val numeric; v_outs text[]; o text;
begin
  perform engine.require_role(array['owner']);
  if coalesce(trim(p_name), '') = '' then raise exception 'Isi nama diskon, misalnya Diskon Karyawan 20%%'; end if;
  if length(trim(p_name)) > 60 then raise exception 'Nama diskon maksimal 60 huruf'; end if;
  if coalesce(p_type, '') not in ('pct', 'amt') then raise exception 'Jenis diskon harus persen atau nominal'; end if;
  if coalesce(p_value, 0) <= 0 then raise exception 'Isi nilai diskon'; end if;
  if p_type = 'pct' then
    if p_value > 100 then raise exception 'Diskon persen maksimal 100%%'; end if;
    v_val := p_value / 100;
  else
    if p_value > 100000000 then raise exception 'Nilai diskon terlalu besar'; end if;
    v_val := p_value;
  end if;
  if coalesce(p_max, 0) < 0 then raise exception 'Batas rupiah tidak boleh minus'; end if;
  v_outs := (select array_agg(distinct x) from unnest(coalesce(p_outlets, '{}')) x where nullif(trim(x), '') is not null);
  foreach o in array coalesce(v_outs, '{}') loop
    if not exists (select 1 from locations where id = o and type = 'outlet') then raise exception 'Outlet % tidak ditemukan', o; end if;
  end loop;
  perform engine.on_();
  if p_id is null or not exists (select 1 from discounts where id = p_id) then
    insert into discounts (id, name, type, value, max_disc, outlets, need_reason, need_pin, active, until, sort)
      values (coalesce(nullif(p_id, ''), public.new_id('dsc')), trim(p_name), p_type, v_val, coalesce(p_max, 0), v_outs,
              coalesce(p_need_reason, false), coalesce(p_need_pin, false), coalesce(p_active, true), p_until, coalesce(p_sort, 0))
      returning id into v_id;
  else
    update discounts set name = trim(p_name), type = p_type, value = v_val, max_disc = coalesce(p_max, 0), outlets = v_outs,
      need_reason = coalesce(p_need_reason, false), need_pin = coalesce(p_need_pin, false), active = coalesce(p_active, true),
      until = p_until, sort = coalesce(p_sort, 0)
     where id = p_id returning id into v_id;
  end if;
  return v_id;
end $$;

create or replace function public.discount_delete(p_id text) returns void language plpgsql security definer set search_path = public as $$
begin
  perform engine.require_role(array['owner']);
  perform engine.on_();
  delete from discounts where id = p_id;
  if not found then raise exception 'Diskon tidak ditemukan'; end if;
end $$;

create or replace function public.discount_apply(p_order text, p_disc text, p_reason text default null, p_pin text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare me public.staff; o public.orders; d public.discounts; v_ok boolean := false; v_reason text;
begin
  me := engine.require_role(array['owner', 'kasir']);
  perform engine.on_();
  select * into o from orders where id = p_order for update;
  if o.id is null or o.status <> 'open' then raise exception 'Pesanan tidak ditemukan atau sudah ditutup'; end if;
  select * into d from discounts where id = p_disc;
  if d.id is null then raise exception 'Diskon tidak ditemukan. Minta Owner/Manajer membuatnya di Backoffice.'; end if;
  if not d.active then raise exception 'Diskon % sudah dinonaktifkan', d.name; end if;
  if d.until is not null and d.until < now() then raise exception 'Diskon % sudah lewat masa berlakunya', d.name; end if;
  if d.outlets is not null and cardinality(d.outlets) > 0 and not (o.location_id = any(d.outlets)) then
    raise exception 'Diskon % tidak berlaku di outlet ini', d.name;
  end if;
  v_reason := nullif(trim(coalesce(p_reason, '')), '');
  if d.need_reason and v_reason is null then raise exception 'Alasan wajib diisi untuk diskon %', d.name; end if;
  if d.need_pin then
    v_ok := exists (select 1 from app_secrets where id = 1 and manager_pin_hash = extensions.crypt(coalesce(p_pin, ''), manager_pin_hash));
    if not v_ok then raise exception 'PIN manajer salah. Diskon % perlu persetujuan manajer.', d.name; end if;
  end if;
  update orders set discount = discount || jsonb_build_object('manual', jsonb_strip_nulls(jsonb_build_object(
      'type', d.type, 'value', d.value, 'name', d.name, 'disc', d.id, 'max', d.max_disc,
      'reason', v_reason, 'by', me.id, 'approved', v_ok))), updated_at = now()
   where id = p_order;
  if v_ok then
    perform engine.flag('Diskon perlu persetujuan manajer', 'sedang',
      'Diskon ' || d.name || ' di ' || o.no || ' disetujui manajer.' || coalesce(' Alasan: ' || v_reason, ''), me.id, o.id, o.location_id);
  end if;
  return engine.compute_bill(p_order);
end $$;

create or replace function public.trx_export(p_location text, p_from date default null, p_to date default null, p_shift text default null,
  p_q text default '', p_status text default '', p_method text default '')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_to date; v_from date; v_q text := nullif(trim(coalesce(p_q, '')), ''); v_cap int := 5000;
  v_bills jsonb; v_items jsonb; v_n int;
begin
  perform engine.require_role(array['owner']);
  if not public.can_loc(p_location) then raise exception 'Tidak punya akses ke outlet ini' using errcode = '42501'; end if;
  if coalesce(p_status, '') not in ('', 'paid', 'refund', 'void') then raise exception 'Status tidak dikenal'; end if;
  v_to := coalesce(p_to, public.biz_date()); v_from := coalesce(p_from, v_to);
  with f as (
    select o.id, coalesce(o.paid_at, o.void_at, o.created_at) t from orders o
     where o.location_id = p_location and o.status in ('paid', 'refund', 'void') and o.merged_into is null
       and (case when p_shift is not null then (o.shift_id = p_shift or o.refund_shift = p_shift)
                 else o.biz_day between v_from and v_to end)
       and (coalesce(p_status, '') = '' or o.status = p_status)
       and (coalesce(p_method, '') = '' or exists (select 1 from order_payments p where p.order_id = o.id and p.method = p_method))
       and (v_q is null or o.no ilike '%' || v_q || '%' or coalesce(o.table_id, '') ilike v_q || '%' or o.customer_name ilike '%' || v_q || '%'
            or exists (select 1 from members m where m.id = o.member_id and (m.name ilike '%' || v_q || '%' or m.phone like '%' || v_q || '%')))
     order by coalesce(o.paid_at, o.void_at, o.created_at) desc, o.id desc
     limit v_cap
  )
  select
    (select coalesce(jsonb_agg(jsonb_build_object(
        'no', o.no, 'day', o.biz_day, 't', x.t, 'opened_at', o.created_at, 'paid_at', o.paid_at, 'status', o.status,
        'channel', o.channel, 'type', o.type,
        'table', nullif(concat_ws(' + ', o.table_id, nullif(array_to_string(o.merged_tables, ' + '), '')), ''),
        'terminal', o.terminal, 'cashier', coalesce(nullif(s.crew_name, ''), sp.name, sc.name), 'shift', o.shift_id,
        'customer', o.customer_name, 'member', m.name, 'member_phone', m.phone,
        'items', (select coalesce(sum(l.qty), 0) from order_lines l where l.order_id = o.id and l.parent_line_id is null and l.status <> 'void'),
        'sub', coalesce((o.bill->>'sub')::numeric, 0), 'disc', coalesce((o.bill->>'disc')::numeric, 0),
        'disc_labels', (select string_agg(d->>'label', ' + ') from jsonb_array_elements(coalesce(o.bill->'discs', '[]'::jsonb)) d),
        'svc', coalesce((o.bill->>'svc')::numeric, 0), 'tax', coalesce((o.bill->>'tax')::numeric, 0),
        'deliv', coalesce(o.delivery_fee, 0), 'total', coalesce(o.total, (o.bill->>'total')::numeric, 0),
        'pays', (select string_agg(p.method || ' ' || engine.jsround(p.amount)::text, ' + ' order by p.id) from order_payments p where p.order_id = o.id),
        'change', coalesce(o.change_amount, 0), 'prints', coalesce(o.prints, 0), 'points', coalesce(o.earned_points, 0),
        'refund_at', o.refund_at, 'refund_by', rb.name, 'refund_reason', o.refund_reason,
        'void_reason', o.void_reason, 'void_by', vb.name) order by x.t desc, o.no desc), '[]'::jsonb)
      from f x join orders o on o.id = x.id
      left join shifts s on s.id = o.shift_id left join staff sp on sp.id = o.paid_by left join staff sc on sc.id = o.created_by
      left join members m on m.id = o.member_id left join staff rb on rb.id = o.refund_by left join staff vb on vb.id = o.void_by),
    (select coalesce(jsonb_agg(jsonb_build_object(
        'no', o.no, 'day', o.biz_day, 'paid_at', o.paid_at, 'status', o.status, 'table', o.table_id,
        'menu', l.name, 'category', c.name, 'station', l.station, 'qty', l.qty, 'price', l.price,
        'amount', engine.jsround(l.qty * l.price), 'note', l.note,
        'line_status', case when l.status = 'void' then 'batal' else l.status end,
        'void_reason', l.void_reason) order by x.t desc, o.no desc, l.sort), '[]'::jsonb)
      from f x join orders o on o.id = x.id
      join order_lines l on l.order_id = o.id and l.parent_line_id is null
      left join menus mn on mn.id = l.menu_id left join menu_categories c on c.id = mn.category_id),
    (select count(*) from f)
    into v_bills, v_items, v_n;
  return jsonb_build_object('bills', v_bills, 'items', v_items, 'from', v_from, 'to', v_to,
    'count', jsonb_array_length(v_bills), 'capped', v_n >= v_cap, 'cap', v_cap);
end $$;

revoke execute on function public.discount_save(text, text, text, numeric, numeric, text[], boolean, boolean, boolean, timestamptz, int),
  public.discount_delete(text), public.discount_apply(text, text, text, text) from public, anon;
grant execute on function public.discount_save(text, text, text, numeric, numeric, text[], boolean, boolean, boolean, timestamptz, int),
  public.discount_delete(text), public.discount_apply(text, text, text, text) to authenticated;

revoke execute on function public.trx_export(text, date, date, text, text, text, text) from public, anon;
grant execute on function public.trx_export(text, date, date, text, text, text, text) to authenticated;

notify pgrst, 'reload schema';
