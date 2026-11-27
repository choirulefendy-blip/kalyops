-- 2.23 · Menu pesanan di reservasi (pre-order).
-- Daftar menu disimpan per reservasi. Harga diambil dari tabel menus saat disimpan (disalin ke baris),
-- supaya perubahan harga menu di kemudian hari tidak mengubah pesanan yang sudah dicatat.

create table if not exists public.reservation_items (
  id             bigint generated always as identity primary key,
  reservation_id text not null references public.reservations(id) on delete cascade,
  menu_id        text not null references public.menus(id) on update cascade,
  qty            int not null check (qty > 0),
  price          numeric(12,0) not null check (price >= 0),
  note           text not null default '' check (length(note) <= 200),
  created_at     timestamptz not null default now()
);
create index if not exists reservation_items_res_ix on public.reservation_items (reservation_id);

alter table public.reservation_items enable row level security;
select engine.policy('reservation_items', 'staf baca', 'select', 'public.is_staff()');
revoke all on public.reservation_items from anon;
grant select on public.reservation_items to authenticated;

-- Simpan ulang seluruh daftar menu untuk satu reservasi.
-- p_items: [{ "menu_id": "...", "qty": 2, "note": "tanpa es" }, ...]
create or replace function public.reservation_items_set(p_id text, p_items jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  me public.staff;
  r public.reservations;
  it jsonb;
  v_menu text;
  v_qty int;
  v_price numeric;
begin
  me := engine.require_role(array['owner', 'kasir', 'service']);
  perform engine.on_();

  select * into r from reservations where id = p_id;
  if r.id is null then raise exception 'Reservasi tidak ditemukan'; end if;
  if r.status not in ('menunggu', 'dikonfirmasi', 'datang') then
    raise exception 'Reservasi % sudah tidak bisa diubah menunya', r.code;
  end if;

  delete from reservation_items where reservation_id = p_id;

  for it in select value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_menu := nullif(it->>'menu_id', '');
    v_qty := coalesce((it->>'qty')::int, 0);
    if v_menu is null or v_qty < 1 then continue; end if;

    select price into v_price from menus where id = v_menu and active;
    if v_price is null then raise exception 'Menu tidak aktif atau tidak ditemukan: %', v_menu; end if;

    insert into reservation_items (reservation_id, menu_id, qty, price, note)
      values (p_id, v_menu, v_qty, v_price, left(coalesce(it->>'note', ''), 200));
  end loop;
end $$;

revoke all on function public.reservation_items_set(text, jsonb) from public, anon;
grant execute on function public.reservation_items_set(text, jsonb) to authenticated;

-- Perangkat lain (tablet kasir) ikut memuat ulang reservasi saat menu pesanan berubah
drop trigger if exists sync_log on public.reservation_items;
create trigger sync_log after insert or update or delete on public.reservation_items for each statement execute function engine.tg_sync_log();
