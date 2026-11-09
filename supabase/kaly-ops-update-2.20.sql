-- Kaly Ops 2.20 · Kontak & ikon di nota, dan catatan umum pesanan
-- Jalankan di Supabase > SQL Editor setelah SQL 2.19 (atau lewati bila sudah memakai SQL fresh 2.20).
-- Isi: kolom orders.note (catatan umum pesanan, ikut ke slip Bar & Dapur)
--      dan receipt_save yang menyimpan kontak & ikon (IG, WA, web, dst.) di tampilan nota.

alter table public.orders add column if not exists note text not null default '';
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.orders'::regclass and conname = 'orders_note_len') then
    alter table public.orders add constraint orders_note_len check (length(note) <= 300);
  end if;
end $$;

create or replace function public.receipt_save(p_cfg jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb; ct jsonb := '[]'::jsonb; el jsonb;
begin
  perform engine.require_role(array['owner', 'kasir']);
  if jsonb_typeof(coalesce(p_cfg, 'null'::jsonb)) <> 'object' then raise exception 'Pengaturan nota tidak valid'; end if;
  if length(p_cfg::text) > 4000 then raise exception 'Isi nota terlalu panjang'; end if;
  -- Kontak & ikon (IG, WA, web, dst.): hanya jenis yang dikenal, maksimal 6 baris
  for el in select x from jsonb_array_elements(case when jsonb_typeof(p_cfg -> 'contacts') = 'array' then p_cfg -> 'contacts' else '[]'::jsonb end) x loop
    exit when jsonb_array_length(ct) >= 6;
    if (el ->> 'k') in ('ig', 'wa', 'web', 'tiktok', 'fb', 'phone', 'mail', 'map') and btrim(coalesce(el ->> 'v', '')) <> '' then
      ct := ct || jsonb_build_array(jsonb_build_object('k', el ->> 'k', 'v', left(btrim(el ->> 'v'), 60)));
    end if;
  end loop;
  v := jsonb_strip_nulls(jsonb_build_object(
    'logo', coalesce((p_cfg ->> 'logo')::boolean, true), 'name', left(coalesce(p_cfg ->> 'name', ''), 60),
    'header', left(coalesce(p_cfg ->> 'header', ''), 400), 'outlet', coalesce((p_cfg ->> 'outlet')::boolean, true),
    'cashier', coalesce((p_cfg ->> 'cashier')::boolean, true), 'member', coalesce((p_cfg ->> 'member')::boolean, true),
    'footer', left(coalesce(p_cfg ->> 'footer', ''), 400), 'contacts', ct,
    'paper', case when (p_cfg ->> 'paper') in ('58', '80') then (p_cfg ->> 'paper')::int else 58 end,
    'font', case when (p_cfg ->> 'font') in ('kecil', 'normal', 'besar') then p_cfg ->> 'font' else 'normal' end,
    'qris', coalesce((p_cfg ->> 'qris')::boolean, false)));
  perform engine.on_();
  update settings set receipt = v where id = 1;
  return v;
end $$;
notify pgrst, 'reload schema';
