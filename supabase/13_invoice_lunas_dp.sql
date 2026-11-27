-- 2.23 · Invoice reservasi ikut lunas saat bill dilunasi di kasir, dan menampilkan waktu DP & pelunasan.
create or replace function engine.res_paid(p_res text) returns numeric language sql stable security definer set search_path = public as $$
  select coalesce((select dp_amount from reservations where id = p_res), 0)
       + coalesce((select sum(pm.amount) from reservations r join orders o on o.id = r.order_id and o.status = 'paid'
                     join order_payments pm on pm.order_id = o.id and pm.method not in ('dp', 'bill')
                    where r.id = p_res), 0);
$$;

do $mig$
declare d text;
begin
  select pg_get_functiondef('public.invoice_save(jsonb)'::regprocedure) into d;
  if position('engine.res_paid(' in d) = 0 then
    if position('v_paid := coalesce(r.dp_amount, 0);' in d) = 0 or position('return to_jsonb((select x from invoices x where x.id = v_id));' in d) = 0 then
      raise exception 'invoice_save tidak sesuai pola';
    end if;
    d := replace(d, 'v_paid := coalesce(r.dp_amount, 0);', 'v_paid := engine.res_paid(r.id);');
    d := replace(d, 'return to_jsonb((select x from invoices x where x.id = v_id));',
      'update invoices set status = ''lunas'', paid_on = coalesce(paid_on, public.biz_date()), updated_at = now()
     where id = v_id and status = ''terbit'' and total > 0 and paid >= total;
  return to_jsonb((select x from invoices x where x.id = v_id));');
    execute d;
  end if;

  select pg_get_functiondef('public.public_invoice(uuid)'::regprocedure) into d;
  if position('''dpAt''' in d) = 0 then
    if position('''no'', v.no, ''status'', v.status, ''kind'', v.kind,' in d) = 0 then raise exception 'public_invoice tidak sesuai pola'; end if;
    d := replace(d, '''no'', v.no, ''status'', v.status, ''kind'', v.kind,',
      '''no'', v.no, ''status'', v.status, ''kind'', v.kind,
    ''dpAt'', (select dp_paid_at from reservations where id = v.reservation_id),
    ''dpAmount'', (select dp_amount from reservations where id = v.reservation_id),
    ''settledAt'', (select paid_at from orders where status = ''paid'' and id = coalesce(v.order_id, (select order_id from reservations where id = v.reservation_id))),');
    execute d;
  end if;
end $mig$;

-- Bill reservasi dilunasi di kasir -> invoice reservasinya ikut diperbarui (dan lunas bila sudah penuh)
create or replace function engine.tg_invoice_follow_order() returns trigger language plpgsql security definer set search_path = public as $$
declare v_res text;
begin
  v_res := coalesce(new.reservation_id, (select id from reservations where order_id = new.id limit 1));
  if new.status = 'paid' and coalesce(old.status, '') <> 'paid' and v_res is not null then
    update invoices set paid = least(total, engine.res_paid(v_res)), updated_at = now()
     where reservation_id = v_res and status = 'terbit';
    update invoices set status = 'lunas', paid_on = public.biz_date(), updated_at = now()
     where reservation_id = v_res and status = 'terbit' and total > 0 and paid >= total;
  end if;
  return null;
end $$;
drop trigger if exists invoice_follow_order on public.orders;
-- Ditunda sampai akhir transaksi: status bill diubah sebelum baris pembayarannya ditulis
create constraint trigger invoice_follow_order after update of status on public.orders deferrable initially deferred
  for each row execute function engine.tg_invoice_follow_order();
