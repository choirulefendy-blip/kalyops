-- Kaly Ops 2.15 · Printer diatur dari akun kasir (Kaly POS › Printer); Backoffice hanya memantau.

alter table public.locations add column if not exists print_copies jsonb;

comment on column public.locations.print_copies is 'Jumlah lembar sekali cetak per outlet: {"cust":1,"copy":1,"bar":1,"dapur":1}. Kosong = memakai settings.print_copies. Diatur kasir di Kaly POS › Printer.';



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
  -- 2.15: printer diatur dari akun kasir (Kaly POS › Printer) untuk outletnya sendiri
  perform engine.require_role(array['owner', 'kasir']);
  if not public.can_loc(p_loc) then raise exception 'Tidak punya akses ke outlet ini' using errcode = '42501'; end if;
  if p_id is not null and exists (select 1 from print_stations where id = p_id and not public.can_loc(location_id)) then
    raise exception 'Printer ini milik outlet lain' using errcode = '42501';
  end if;
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

create or replace function public.print_station_model(p_id text, p_model text) returns void language plpgsql security definer set search_path = public as $$
begin
  perform engine.require_role(array['owner', 'kasir']);
  if exists (select 1 from print_stations where id = p_id and not public.can_loc(location_id)) then raise exception 'Printer ini milik outlet lain' using errcode = '42501'; end if;
  if coalesce(p_model, '') not in ('umum', 'epson_t82x', 'rongta_rpp02n') then raise exception 'Model printer tidak dikenal: %', p_model; end if;
  update print_stations set model = p_model where id = p_id;
  if not found then raise exception 'Printer tidak ditemukan'; end if;
end $$;

create or replace function public.print_route_save(p_loc text, p_route jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb := '{}'::jsonb; r record;
begin
  perform engine.require_role(array['owner', 'kasir']);
  if not public.can_loc(p_loc) then raise exception 'Tidak punya akses ke outlet ini' using errcode = '42501'; end if;
  if not exists (select 1 from locations where id = p_loc and type = 'outlet') then raise exception 'Outlet % tidak ditemukan', coalesce(p_loc, ''); end if;
  for r in select key k, value #>> '{}' val from jsonb_each(coalesce(p_route, '{}'::jsonb)) loop
    if r.k not in ('cust', 'copy', 'bar', 'dapur') then raise exception 'Jenis lembar tidak dikenal: %', r.k; end if;
    if coalesce(r.val, 'local') <> 'local' and not exists (select 1 from print_stations where id = r.val and location_id = p_loc and active) then
      raise exception 'Printer % tidak ada di outlet ini', r.val;
    end if;
    v := v || jsonb_build_object(r.k, coalesce(r.val, 'local'));
  end loop;
  perform engine.on_();
  update locations set print_route = v where id = p_loc;
  return v;
end $$;

create or replace function public.print_copies_save(p_loc text, p_copies jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb := '{}'::jsonb; k text; n int;
begin
  perform engine.require_role(array['owner', 'kasir']);
  if not public.can_loc(p_loc) then raise exception 'Tidak punya akses ke outlet ini' using errcode = '42501'; end if;
  foreach k in array array['cust', 'copy', 'bar', 'dapur'] loop
    n := coalesce((p_copies ->> k)::int, 1);
    if n not between 0 and 5 then raise exception 'Jumlah lembar 0 sampai 5'; end if;
    v := v || jsonb_build_object(k, n);
  end loop;
  perform engine.on_();
  update locations set print_copies = v where id = p_loc;
  if not found then raise exception 'Outlet tidak ditemukan'; end if;
  return v;
end $$;

create or replace function public.receipt_save(p_cfg jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  perform engine.require_role(array['owner', 'kasir']);
  if jsonb_typeof(coalesce(p_cfg, 'null'::jsonb)) <> 'object' then raise exception 'Pengaturan nota tidak valid'; end if;
  if length(p_cfg::text) > 4000 then raise exception 'Isi nota terlalu panjang'; end if;
  v := jsonb_strip_nulls(jsonb_build_object(
    'logo', coalesce((p_cfg ->> 'logo')::boolean, true), 'name', left(coalesce(p_cfg ->> 'name', ''), 60),
    'header', left(coalesce(p_cfg ->> 'header', ''), 400), 'outlet', coalesce((p_cfg ->> 'outlet')::boolean, true),
    'cashier', coalesce((p_cfg ->> 'cashier')::boolean, true), 'member', coalesce((p_cfg ->> 'member')::boolean, true),
    'footer', left(coalesce(p_cfg ->> 'footer', ''), 400),
    'paper', case when (p_cfg ->> 'paper') in ('58', '80') then (p_cfg ->> 'paper')::int else 58 end,
    'font', case when (p_cfg ->> 'font') in ('kecil', 'normal', 'besar') then p_cfg ->> 'font' else 'normal' end,
    'qris', coalesce((p_cfg ->> 'qris')::boolean, false)));
  perform engine.on_();
  update settings set receipt = v where id = 1;
  return v;
end $$;

revoke execute on function public.print_route_save(text, jsonb), public.print_copies_save(text, jsonb), public.receipt_save(jsonb) from public, anon;

grant execute on function public.print_route_save(text, jsonb), public.print_copies_save(text, jsonb), public.receipt_save(jsonb) to authenticated;
