-- Kaly Ops 2.21 · Refund per item dalam satu nota
-- Jalankan di Supabase > SQL Editor setelah SQL 2.20.
-- Isi: tabel order_refunds (riwayat refund per item), order_refund_items (refund parsial oleh Owner),
--      order_refund (refund penuh kini menolak bila bill sudah pernah di-refund sebagian),
--      engine.shift_summary (refund tunai parsial dari laci ikut dihitung di kas shift).

-- Tabel riwayat refund per item
-- 2.21 · Refund per item: satu baris per item yang di-refund (satu batch = satu kali refund)
create table if not exists public.order_refunds (
  id          bigint generated always as identity primary key,
  batch       text not null,
  order_id    text not null references public.orders(id) on delete cascade,
  location_id text not null references public.locations(id),
  line_id     text references public.order_lines(id) on delete set null,
  item_name   text not null default '',
  qty         numeric(10,2) not null check (qty > 0),
  amount      numeric(14,0) not null check (amount > 0),
  method      text not null check (method in ('cash', 'qris', 'card', 'transfer', 'deposit')),
  card_id     text references public.deposit_cards(id),
  shift_id    text references public.shifts(id),
  reason      text not null default '',
  created_at  timestamptz not null default now(),
  created_by  text references public.staff(id)
);
create index if not exists order_refunds_order_idx on public.order_refunds (order_id);
create index if not exists order_refunds_shift_idx on public.order_refunds (shift_id);

alter table public.order_refunds enable row level security;
revoke all on public.order_refunds from anon;
select engine.policy('order_refunds', 'staf baca', 'select', 'public.is_staff() and public.can_loc(location_id)');
drop trigger if exists sync_log on public.order_refunds;
create trigger sync_log after insert or update or delete on public.order_refunds for each statement execute function engine.tg_sync_log();
drop trigger if exists audit on public.order_refunds;
create trigger audit after insert or update or delete on public.order_refunds for each row execute function engine.tg_audit();

create or replace function engine.shift_summary(p_shift text) returns jsonb language plpgsql stable set search_path = public as $$
declare sh public.shifts; v_by jsonb; v_cash numeric; v_top numeric; v_ref numeric; v_count int; v_total numeric; v_disc numeric; v_voids int;
  v_rn int; v_rtot numeric; v_rcash numeric; v_rlater int; v_rlater_tot numeric;
begin
  select * into sh from shifts where id = p_shift;
  -- 2.13: bill yang kemudian di-refund tetap dihitung di shift tempat ia dibayar (uangnya memang masuk laci saat itu)
  select count(*), coalesce(sum(total), 0), coalesce(sum((bill->>'disc')::numeric), 0) into v_count, v_total, v_disc from orders where shift_id = p_shift and status in ('paid', 'refund');
  select coalesce(jsonb_object_agg(method, amt), '{}'::jsonb) into v_by from (select p.method, sum(p.amount) amt from order_payments p join orders o on o.id = p.order_id where o.shift_id = p_shift and o.status in ('paid', 'refund') group by p.method) x;
  v_cash := coalesce((v_by->>'cash')::numeric, 0);
  select coalesce(sum(amount) filter (where type = 'topup' and method = 'cash'), 0), coalesce(sum(amount) filter (where type = 'refund'), 0) into v_top, v_ref from deposit_tx where shift_id = p_shift;
  select count(*) into v_voids from orders where status = 'void' and void_by = sh.staff_id and void_at >= sh.open_at and (sh.close_at is null or void_at <= sh.close_at);
  -- 2.13: refund bill yang uang tunainya diambil dari laci shift ini
  select count(*), coalesce(sum(total), 0),
         coalesce(sum((select coalesce(sum((x->>'a')::numeric), 0) from jsonb_array_elements(coalesce(refund_pays, '[]'::jsonb)) x where x->>'m' = 'cash')), 0)
    into v_rn, v_rtot, v_rcash from orders where refund_shift = p_shift and status = 'refund';
  -- 2.21: refund sebagian per item yang tunainya diambil dari laci shift ini
  select v_rcash + coalesce(sum(amount), 0) into v_rcash from order_refunds where shift_id = p_shift and method = 'cash';
  select count(*), coalesce(sum(total), 0) into v_rlater, v_rlater_tot from orders where shift_id = p_shift and status = 'refund';
  return jsonb_build_object('count', v_count, 'total', v_total, 'disc', v_disc, 'by', v_by, 'top_cash', v_top, 'refund_cash', v_ref,
                            'refunds', v_rn, 'refund_total', v_rtot, 'refund_bill_cash', v_rcash, 'refunded_later', v_rlater, 'refunded_later_total', v_rlater_tot,
                            'expected', sh.open_cash + v_cash + v_top - v_ref - v_rcash, 'voids', v_voids, 'no_sale', sh.no_sale);
end $$;

create or replace function public.order_refund(p_order text, p_reason text, p_shift text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.staff; o public.orders; b jsonb; sh public.shifts; v_pays jsonb; v_cash numeric; v_lines jsonb := '[]'::jsonb; r record; p jsonb;
  v_vd jsonb; v_back int; v_delta int; v_reason text := trim(coalesce(p_reason, ''));
begin
  me := engine.require_role(array['owner']);
  perform engine.on_();
  select * into o from orders where id = p_order for update;
  if o.id is null then raise exception 'Bill tidak ditemukan'; end if;
  if not public.can_loc(o.location_id) then raise exception 'Tidak punya akses ke outlet ini' using errcode = '42501'; end if;
  if o.status = 'refund' then raise exception 'Bill % sudah di-refund', o.no; end if;
  if o.status <> 'paid' then raise exception 'Hanya bill yang sudah lunas yang bisa di-refund'; end if;
  if v_reason = '' then raise exception 'Alasan refund wajib diisi'; end if;
  if exists (select 1 from order_refunds where order_id = o.id) then raise exception 'Bill ini sudah pernah di-refund sebagian. Refund sisa item satu per satu.'; end if;
  b := coalesce(o.bill, engine.compute_bill(o.id));
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('m', method, 'a', amt, 'card', card_id)) order by method, card_id), '[]'::jsonb) into v_pays
    from (select method, card_id, sum(amount) amt from order_payments where order_id = o.id group by 1, 2) x;
  select coalesce(sum((x->>'a')::numeric), 0) into v_cash from jsonb_array_elements(v_pays) x where x->>'m' = 'cash';
  if v_cash > 0 and p_shift is not null then
    select * into sh from shifts where id = p_shift;
    if sh.id is null or sh.close_at is not null then raise exception 'Shift kasir yang dipilih sudah ditutup. Pilih shift yang sedang aktif.'; end if;
    if sh.location_id <> o.location_id then raise exception 'Shift kasir harus di outlet yang sama dengan bill'; end if;
  end if;
  update orders set status = 'refund', refund_at = now(), refund_by = me.id, refund_reason = v_reason,
                    refund_shift = case when v_cash > 0 then p_shift end, refund_pays = v_pays, updated_at = now()
    where id = o.id;
  -- Item yang belum selesai di dapur dihentikan supaya tidak terus dimasak
  update order_lines set status = 'void', void_reason = 'Refund: ' || v_reason, void_by = me.id, void_at = now()
    where order_id = o.id and status in ('draft', 'new', 'cook', 'ready');
  update orders set kitchen_state = engine.kitchen_state(o.id) where id = o.id;
  -- Jurnal pembalik penjualan
  for r in select engine.pay_account(x->>'m') as acc, sum((x->>'a')::numeric) as amt from jsonb_array_elements(v_pays) x group by 1 order by 1 loop
    v_lines := v_lines || jsonb_build_array(jsonb_build_array(r.acc, 0, r.amt));
  end loop;
  if (b->>'disc')::numeric > 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_array('4201', 0, (b->>'disc')::numeric)); end if;
  v_lines := v_lines || jsonb_build_array(jsonb_build_array('4101', (b->>'sub')::numeric, 0));
  if (b->>'tax')::numeric > 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_array('2104', (b->>'tax')::numeric, 0)); end if;
  if coalesce((b->>'svc')::numeric, 0) + coalesce((b->>'deliv')::numeric, 0) > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_array('4103', coalesce((b->>'svc')::numeric, 0) + coalesce((b->>'deliv')::numeric, 0), 0));
  end if;
  perform engine.post(engine.entity_of(o.location_id), 'Refund ' || o.no, o.id, 'Refund penjualan', v_lines, now(), null, me.id);
  -- Saldo kartu deposit dikembalikan
  for p in select * from jsonb_array_elements(v_pays) loop
    if p->>'m' = 'deposit' and p->>'card' is not null then
      update deposit_cards set balance = balance + (p->>'a')::numeric where id = p->>'card';
      insert into deposit_tx (card_id, amount, type, ref, created_by) values (p->>'card', (p->>'a')::numeric, 'return', 'Refund ' || o.no, me.id);
    end if;
  end loop;
  -- Voucher dipakai lagi
  select d into v_vd from jsonb_array_elements(coalesce(b->'discs', '[]'::jsonb)) d where d->>'kind' = 'voucher' limit 1;
  if v_vd is not null then
    update vouchers set used = greatest(0, used - 1), revenue = greatest(0, revenue - o.total), cost = greatest(0, cost - (v_vd->>'amt')::numeric) where code = v_vd->>'code';
  end if;
  -- Member: poin yang didapat ditarik, poin yang ditukar dikembalikan, belanja & kunjungan dikurangi
  if o.member_id is not null and exists (select 1 from members where id = o.member_id) then
    select coalesce(-sum(delta), 0) into v_back from point_tx where order_id = o.id and reason = 'redeem';
    v_delta := v_back - coalesce(o.earned_points, 0);
    update members set points = greatest(0, points + v_delta), spend = greatest(0, spend - coalesce(o.total, 0)), visits = greatest(0, visits - 1) where id = o.member_id;
    if v_delta <> 0 then
      insert into point_tx (member_id, delta, reason, order_id, note, created_by) values (o.member_id, v_delta, 'adjust', o.id, 'Refund bill ' || o.no, me.id);
    end if;
  end if;
  perform engine.flag('Refund bill', 'sedang', 'Bill ' || o.no || coalesce(' (meja ' || o.table_id || ')', '') || ' senilai ' || engine.rp(o.total) || ' di-refund'
    || case when v_cash > 0 then case when p_shift is null then ', tunai ' || engine.rp(v_cash) || ' dari kas outlet' else ', tunai ' || engine.rp(v_cash) || ' dari laci ' || sh.terminal end else '' end
    || '. Alasan: ' || v_reason, me.id, o.id, o.location_id);
  return jsonb_build_object('ok', true, 'no', o.no, 'total', o.total, 'pays', v_pays, 'cash', v_cash, 'shift', case when v_cash > 0 then p_shift end, 'terminal', sh.terminal);
end $$;

create or replace function public.order_refund_items(p_order text, p_items jsonb, p_reason text, p_method text, p_card text default null, p_shift text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.staff; o public.orders; b jsonb; sh public.shifts; it jsonb; l public.order_lines;
  v_q numeric; v_done numeric; v_gross numeric; v_dsh numeric; v_nr numeric; v_tx numeric; v_sv numeric; v_base numeric; v_sub numeric;
  v_amt numeric := 0; v_gross_t numeric := 0; v_dsh_t numeric := 0; v_tx_t numeric := 0; v_sv_t numeric := 0; v_prior numeric; v_pts numeric := 0;
  v_batch text := gen_random_uuid()::text; v_reason text := trim(coalesce(p_reason, '')); v_names text := ''; v_lines jsonb := '[]'::jsonb; v_vd jsonb; v_disc numeric;
begin
  me := engine.require_role(array['owner']);
  perform engine.on_();
  select * into o from orders where id = p_order for update;
  if o.id is null then raise exception 'Bill tidak ditemukan'; end if;
  if not public.can_loc(o.location_id) then raise exception 'Tidak punya akses ke outlet ini' using errcode = '42501'; end if;
  if o.status <> 'paid' then raise exception 'Hanya bill yang sudah lunas yang bisa di-refund'; end if;
  if v_reason = '' then raise exception 'Alasan refund wajib diisi'; end if;
  if p_method not in ('cash', 'qris', 'card', 'transfer', 'deposit') then raise exception 'Metode pengembalian tidak dikenal'; end if;
  if jsonb_typeof(coalesce(p_items, 'null'::jsonb)) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Pilih item yang mau di-refund'; end if;
  if p_method = 'deposit' and (p_card is null or not exists (select 1 from order_payments where order_id = o.id and method = 'deposit' and card_id = p_card)) then
    raise exception 'Pilih kartu deposit yang dipakai untuk bayar bill ini';
  end if;
  if p_method = 'cash' and p_shift is not null then
    select * into sh from shifts where id = p_shift;
    if sh.id is null or sh.close_at is not null then raise exception 'Shift kasir yang dipilih sudah ditutup. Pilih shift yang sedang aktif.'; end if;
    if sh.location_id <> o.location_id then raise exception 'Shift kasir harus di outlet yang sama dengan bill'; end if;
  end if;
  b := coalesce(o.bill, engine.compute_bill(o.id));
  v_sub := (b->>'sub')::numeric; v_disc := coalesce((b->>'disc')::numeric, 0); v_base := v_sub - v_disc;
  select coalesce(sum(amount), 0) into v_prior from order_refunds where order_id = o.id;
  for it in select x from jsonb_array_elements(p_items) x loop
    v_q := coalesce((it ->> 'qty')::numeric, 0);
    continue when v_q <= 0;
    select * into l from order_lines where id = it ->> 'line' and order_id = o.id;
    if l.id is null then raise exception 'Item tidak ada di bill ini'; end if;
    if l.parent_line_id is not null then raise exception 'Refund dilakukan per item utama, bukan komponen paket: %', l.name; end if;
    if l.status = 'void' then raise exception 'Item % sudah dibatalkan', l.name; end if;
    select coalesce(sum(qty), 0) into v_done from order_refunds where order_id = o.id and line_id = l.id;
    if v_q > l.qty - v_done then raise exception 'Jumlah refund % melebihi yang tersisa (%)', l.name, l.qty - v_done; end if;
    v_gross := round(v_q * l.price);
    v_dsh := case when v_sub > 0 then round(v_gross * v_disc / v_sub) else 0 end;
    v_nr := v_gross - v_dsh;
    v_tx := case when v_base > 0 then round(v_nr * coalesce((b->>'tax')::numeric, 0) / v_base) else 0 end;
    v_sv := case when v_base > 0 then round(v_nr * coalesce((b->>'svc')::numeric, 0) / v_base) else 0 end;
    v_amt := v_amt + v_nr + v_tx + v_sv;
    v_gross_t := v_gross_t + v_gross; v_dsh_t := v_dsh_t + v_dsh; v_tx_t := v_tx_t + v_tx; v_sv_t := v_sv_t + v_sv;
    v_names := v_names || case when v_names = '' then '' else ', ' end || v_q::text || '× ' || l.name;
    if v_nr + v_tx + v_sv > 0 then
      insert into order_refunds (batch, order_id, location_id, line_id, item_name, qty, amount, method, card_id, shift_id, reason, created_by)
        values (v_batch, o.id, o.location_id, l.id, l.name, v_q, v_nr + v_tx + v_sv, p_method,
                case when p_method = 'deposit' then p_card end, case when p_method = 'cash' then p_shift end, v_reason, me.id);
    end if;
  end loop;
  if v_amt <= 0 then raise exception 'Pilih item dan jumlah yang mau di-refund'; end if;
  if v_prior + v_amt > o.total then raise exception 'Total refund melebihi total bill'; end if;
  -- Jurnal pembalik: kas/bank/deposit dikredit, penjualan didebit, diskon & pajak ikut dibalik
  v_lines := jsonb_build_array(jsonb_build_array(engine.pay_account(p_method), 0, v_amt), jsonb_build_array('4101', v_gross_t, 0));
  if v_dsh_t > 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_array('4201', 0, v_dsh_t)); end if;
  if v_tx_t > 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_array('2104', v_tx_t, 0)); end if;
  if v_sv_t > 0 then v_lines := v_lines || jsonb_build_array(jsonb_build_array('4103', v_sv_t, 0)); end if;
  perform engine.post(engine.entity_of(o.location_id), 'Refund sebagian ' || o.no, o.id, 'Refund item', v_lines, now(), null, me.id);
  if p_method = 'deposit' then
    update deposit_cards set balance = balance + v_amt where id = p_card;
    insert into deposit_tx (card_id, amount, type, ref, created_by) values (p_card, v_amt, 'return', 'Refund sebagian ' || o.no, me.id);
  end if;
  -- Member: poin dari belanja ini ditarik proporsional, belanja berkurang
  if o.member_id is not null and exists (select 1 from members where id = o.member_id) and o.total > 0 then
    v_pts := round(coalesce(o.earned_points, 0) * v_amt / o.total);
    update members set points = greatest(0, points - v_pts), spend = greatest(0, spend - v_amt) where id = o.member_id;
    if v_pts <> 0 then
      insert into point_tx (member_id, delta, reason, order_id, note, created_by) values (o.member_id, -v_pts, 'adjust', o.id, 'Refund sebagian bill ' || o.no, me.id);
    end if;
  end if;
  -- Voucher: pendapatan & biaya dikurangi proporsional; pemakaian dihitung ulang bila sudah habis di-refund
  select d into v_vd from jsonb_array_elements(coalesce(b->'discs', '[]'::jsonb)) d where d->>'kind' = 'voucher' limit 1;
  if v_vd is not null and o.total > 0 then
    update vouchers set revenue = greatest(0, revenue - v_amt), cost = greatest(0, cost - round((v_vd->>'amt')::numeric * v_amt / o.total)) where code = v_vd->>'code';
    if v_prior + v_amt >= o.total then update vouchers set used = greatest(0, used - 1) where code = v_vd->>'code'; end if;
  end if;
  perform engine.flag('Refund item', 'sedang', 'Bill ' || o.no || ': ' || v_names || ' senilai ' || engine.rp(v_amt) || ' di-refund sebagian ke ' || p_method
    || case when p_method = 'cash' and p_shift is null then ' (kas outlet)' when p_method = 'cash' then ' dari laci ' || sh.terminal else '' end
    || '. Alasan: ' || v_reason, me.id, o.id, o.location_id);
  return jsonb_build_object('ok', true, 'no', o.no, 'amount', v_amt, 'method', p_method, 'batch', v_batch,
                            'cash', case when p_method = 'cash' then v_amt else 0 end, 'shift', case when p_method = 'cash' then p_shift end, 'terminal', sh.terminal);
end $$;

revoke execute on function public.order_refund_items(text, jsonb, text, text, text, text) from public, anon;
grant execute on function public.order_refund_items(text, jsonb, text, text, text, text) to authenticated;
notify pgrst, 'reload schema';
