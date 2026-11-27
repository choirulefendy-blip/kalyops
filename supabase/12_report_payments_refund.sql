-- 2.23 · Laporan Metode bayar: bill yang di-refund dan dibayar dengan "Tagih nanti" (piutang dibatalkan)
-- tidak lagi dihitung sebagai uang masuk.
do $mig$
declare d text;
begin
  select pg_get_functiondef('public.report_payments(timestamptz, timestamptz, text[])'::regprocedure) into d;
  if position('pm.amount > 0 and not' in d) > 0 then return; end if;
  if position('select o.id, (o.paid_at at time zone tz) lt' in d) = 0 or position('where pm.amount > 0' in d) = 0 then
    raise exception 'report_payments tidak sesuai pola yang diharapkan';
  end if;
  d := replace(d, 'select o.id, (o.paid_at at time zone tz) lt', 'select o.id, o.status st, (o.paid_at at time zone tz) lt');
  d := replace(d, 'where pm.amount > 0', 'where pm.amount > 0 and not (pm.method = ''bill'' and o.st = ''refund'')');
  d := replace(d, '''orders'',  (select count(*) from o)', '''orders'',  (select count(distinct order_id) from p)');
  execute d;
end $mig$;
