-- 2.23 · Perbaikan: ID reservasi bertipe text, bukan uuid. Versi lama menolak setiap penyimpanan DP.
-- Kolom DP (sudah ada di database cloud, belum pernah tercatat di file SQL repo)
alter table public.reservations add column if not exists dp_amount numeric(12,0) not null default 0;
alter table public.reservations add column if not exists dp_method text not null default '';
alter table public.reservations add column if not exists dp_note text not null default '';
alter table public.reservations add column if not exists dp_paid_at timestamptz;
alter table public.reservations add column if not exists dp_by text;

drop function if exists public.reservation_set_dp(uuid, numeric, text, text);
create or replace function public.reservation_set_dp(p_id text, p_amount numeric, p_method text, p_note text)
returns void language plpgsql security definer set search_path = public, engine as $$
declare me public.staff;
begin
  me := engine.require_role(array['owner', 'kasir']);
  update reservations set
    dp_amount  = greatest(0, coalesce(p_amount, 0)),
    dp_method  = coalesce(p_method, ''),
    dp_note    = coalesce(p_note, ''),
    dp_paid_at = case when p_amount > 0 then now() else null end,
    dp_by      = me.id::text
  where id = p_id;
  if not found then raise exception 'Reservasi tidak ditemukan'; end if;
end $$;
revoke all on function public.reservation_set_dp(text, numeric, text, text) from public, anon;
grant execute on function public.reservation_set_dp(text, numeric, text, text) to authenticated;
