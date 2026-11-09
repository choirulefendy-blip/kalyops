-- Kaly Ops 2.18 · Satu jenis lembar boleh dicetak di beberapa printer (locations.print_route berisi larik id)
-- Jalankan di Supabase > SQL Editor setelah SQL 2.15 dan 2.17. Tidak ada tabel baru; data lama tetap terbaca.
-- Teks tunggal tetap sah ('local' atau id printer); larik [id, id] = satu jenis lembar ke beberapa printer.

create or replace function public.print_route_save(p_loc text, p_route jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb := '{}'::jsonb; r record; el jsonb; pid text; arr text[]; n int;
begin
  perform engine.require_role(array['owner', 'kasir']);
  if not public.can_loc(p_loc) then raise exception 'Tidak punya akses ke outlet ini' using errcode = '42501'; end if;
  if not exists (select 1 from locations where id = p_loc and type = 'outlet') then raise exception 'Outlet % tidak ditemukan', coalesce(p_loc, ''); end if;
  for r in select key k, value val from jsonb_each(coalesce(p_route, '{}'::jsonb)) loop
    if r.k not in ('cust', 'copy', 'bar', 'dapur') then raise exception 'Jenis lembar tidak dikenal: %', r.k; end if;
    -- 2.18: satu jenis lembar boleh ke beberapa printer: teks tunggal ('local' atau id) atau larik id
    arr := '{}';
    for el in select x from jsonb_array_elements(case when jsonb_typeof(r.val) = 'array' then r.val else jsonb_build_array(r.val) end) x loop
      pid := el #>> '{}';
      if pid is null or pid = '' or pid = 'local' then continue; end if;
      if not exists (select 1 from print_stations where id = pid and location_id = p_loc and active) then
        raise exception 'Printer % tidak ada di outlet ini', pid;
      end if;
      if not (pid = any(arr)) then arr := arr || pid; end if;
    end loop;
    n := coalesce(cardinality(arr), 0);
    v := v || jsonb_build_object(r.k, case when n = 0 then to_jsonb('local'::text) when n = 1 then to_jsonb(arr[1]) else to_jsonb(arr) end);
  end loop;
  perform engine.on_();
  update locations set print_route = v where id = p_loc;
  return v;
end $$;

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
    -- 2.18: satu jenis lembar bisa punya beberapa printer (larik); printer ini dibuang dari larik itu
    update locations set print_route = (
      select coalesce(jsonb_object_agg(e.k, case
          when jsonb_typeof(e.v) = 'array' then (select case when count(*) = 0 then '"local"'::jsonb else jsonb_agg(x) end
               from jsonb_array_elements(e.v) x where x #>> '{}' <> v_id)
          when e.v #>> '{}' = v_id then '"local"'::jsonb
          else e.v end), '{}')
      from jsonb_each(print_route) e(k, v))
     where print_route::text like '%' || v_id || '%';
    if exists (select 1 from print_jobs where station_id = v_id and status = 'queued') then
      update print_jobs set status = 'cancelled', error = 'Printer dihapus' where station_id = v_id and status = 'queued';
    end if;
  end if;
  return v_id;
end $$;

notify pgrst, 'reload schema';
