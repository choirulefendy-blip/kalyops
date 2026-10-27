-- =====================================================================
-- Kaly Ops · Database Supabase · 05 Laporan (view)
-- ---------------------------------------------------------------------
-- View memakai security_invoker, jadi hak akses tetap mengikuti peran staf (RLS).
-- Contoh: select * from v_sales_daily where biz_day >= current_date - 7;
-- =====================================================================

create or replace function public.menu_std_cost(p_menu text) returns numeric language sql stable security definer set search_path = public as $$
  select engine.menu_hpp(p_menu);
$$;
grant execute on function public.menu_std_cost(text) to authenticated;

-- Neraca saldo per entitas
create or replace view public.v_trial_balance with (security_invoker = true) as
select j.entity_id, a.code, a.name, a.type,
       sum(l.debit) as debit, sum(l.credit) as credit, sum(l.debit - l.credit) as balance
from public.journal_lines l
join public.journals j on j.id = l.journal_id
join public.accounts a on a.code = l.account_code
group by j.entity_id, a.code, a.name, a.type;

-- Laba rugi per bulan per entitas
create or replace view public.v_profit_loss_monthly with (security_invoker = true) as
select j.entity_id, to_char(j.at at time zone 'Asia/Jakarta', 'YYYY-MM') as month,
       sum(case when a.type = 'revenue' then l.credit - l.debit else 0 end) as revenue,
       sum(case when a.type = 'contra' then l.debit - l.credit else 0 end) as discounts,
       sum(case when a.type = 'cogs' then l.debit - l.credit else 0 end) as cogs,
       sum(case when a.type = 'expense' then l.debit - l.credit else 0 end) as expenses,
       sum(case when a.type = 'revenue' then l.credit - l.debit when a.type in ('contra', 'cogs', 'expense') then -(l.debit - l.credit) else 0 end) as profit
from public.journal_lines l
join public.journals j on j.id = l.journal_id
join public.accounts a on a.code = l.account_code
group by 1, 2;

-- Penjualan harian per outlet & channel
create or replace view public.v_sales_daily with (security_invoker = true) as
select o.biz_day, o.location_id, o.channel,
       count(*) as orders,
       sum((o.bill->>'sub')::numeric) as gross,
       sum((o.bill->>'disc')::numeric) as discount,
       sum((o.bill->>'tax')::numeric) as tax,
       sum((o.bill->>'svc')::numeric + (o.bill->>'deliv')::numeric) as other,
       sum(o.total) as total,
       round(avg(o.total)) as avg_bill
from public.orders o
where o.status = 'paid'
group by 1, 2, 3;

-- Pembayaran harian per metode
create or replace view public.v_payments_daily with (security_invoker = true) as
select o.biz_day, o.location_id, p.method, count(*) as payments, sum(p.amount) as amount
from public.order_payments p
join public.orders o on o.id = p.order_id
where o.status = 'paid'
group by 1, 2, 3;

-- Menu terlaris 30 hari terakhir
create or replace view public.v_top_menus_30d with (security_invoker = true) as
select o.location_id, l.menu_id, m.name, m.category_id, sum(l.qty) as qty, sum(l.qty * l.price) as revenue, sum(coalesce(l.cost, 0)) as cost
from public.order_lines l
join public.orders o on o.id = l.order_id
join public.menus m on m.id = l.menu_id
where o.status = 'paid' and l.status <> 'void' and l.parent_line_id is null and o.paid_at >= now() - interval '30 days'
group by 1, 2, 3, 4;

-- Nilai persediaan & stok di bawah minimum
create or replace view public.v_stock_value with (security_invoker = true) as
select s.location_id, s.item_id, i.name, i.unit, i.type, s.qty, s.avg_cost, round(s.qty * s.avg_cost) as value, s.min_qty,
       (s.min_qty > 0 and s.qty < s.min_qty) as below_min, (s.qty < 0) as negative
from public.stock s
join public.items i on i.id = s.item_id;

-- HPP standar & food cost per menu
create or replace view public.v_menu_cost with (security_invoker = true) as
select m.id, m.name, m.category_id, m.price, round(public.menu_std_cost(m.id)) as hpp,
       case when m.price > 0 then round(public.menu_std_cost(m.id) / m.price, 4) end as food_cost_ratio, m.active, m.sold_out
from public.menus m;

-- Waktu dapur per item (dari dikirim sampai siap)
create or replace view public.v_kitchen_times with (security_invoker = true) as
select o.biz_day, o.location_id, o.no, l.menu_id, l.name, l.station, l.qty, l.sent_at, l.ready_at,
       round(extract(epoch from (l.ready_at - l.sent_at)) / 60, 1) as minutes
from public.order_lines l
join public.orders o on o.id = l.order_id
where l.sent_at is not null and l.ready_at is not null and l.station <> 'none' and l.status <> 'void';

-- Ringkasan jurnal per hari, per akun, per kelompok arus kas (dipakai laporan keuangan di aplikasi)
create or replace view public.v_journal_daily with (security_invoker = true) as
select j.entity_id, (j.at at time zone 'Asia/Jakarta')::date as day, coalesce(j.cash_flow, '') as cash_flow, l.account_code,
       sum(l.debit) as debit, sum(l.credit) as credit
from public.journal_lines l
join public.journals j on j.id = l.journal_id
group by 1, 2, 3, 4;

-- Minta API Supabase membaca ulang daftar tabel & fungsi (Supabase biasanya melakukannya otomatis)
notify pgrst, 'reload schema';

-- =====================================================================
-- 1.4 · Laporan operasional (dipanggil layar Laporan di Kaly Core, khusus Owner)
-- Semua jam memakai zona waktu di Pengaturan (default Asia/Jakarta).
-- Periode bebas: dihitung langsung di database, tidak terbatas data yang sedang dimuat aplikasi.
-- =====================================================================
create or replace function engine.report_locs(p_locs text[]) returns text[] language plpgsql stable security definer set search_path = public as $$
declare v text[];
begin
  perform engine.require_role(array['owner']);
  select array_agg(id order by id) into v from locations where (p_locs is null or id = any(p_locs)) and public.can_loc(id);
  return coalesce(v, '{}');
end $$;
create or replace function engine.report_tz() returns text language sql stable security definer set search_path = public as $$
  select coalesce(nullif((select timezone from settings where id = 1), ''), 'Asia/Jakarta');
$$;

-- Rekap transaksi per nota & jam penjualan (jam = waktu bayar)
create or replace function public.report_receipts(p_from timestamptz, p_to timestamptz, p_locs text[] default null, p_limit int default 3000)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_locs text[]; tz text := engine.report_tz(); r jsonb;
begin
  v_locs := engine.report_locs(p_locs);
  with o as (
    select o.id, o.no, o.location_id loc, o.channel ch, o.type, o.table_id, o.merged_tables, o.paid_at, o.created_at, o.paid_by, o.member_id,
           coalesce((o.bill->>'sub')::numeric, 0) sub, coalesce((o.bill->>'disc')::numeric, 0) disc, coalesce((o.bill->>'svc')::numeric, 0) svc,
           coalesce((o.bill->>'tax')::numeric, 0) tax, coalesce((o.bill->>'deliv')::numeric, 0) deliv, coalesce(o.total, 0) total,
           (o.paid_at at time zone tz) lt
      from orders o
     where o.status = 'paid' and o.location_id = any(v_locs) and o.paid_at >= p_from and o.paid_at <= p_to
  ), it as (
    select l.order_id, sum(l.qty) q from order_lines l join o on o.id = l.order_id where l.parent_line_id is null and l.status <> 'void' group by 1
  ), pay as (
    select p.order_id, jsonb_agg(jsonb_build_array(p.method, p.amount) order by p.id) a from order_payments p join o on o.id = p.order_id group by 1
  ), x as (
    select o.*, coalesce(it.q, 0) items, coalesce(pay.a, '[]'::jsonb) pays from o left join it on it.order_id = o.id left join pay on pay.order_id = o.id
  )
  select jsonb_build_object(
    'tz', tz,
    'n', (select count(*) from x),
    'total', (select coalesce(sum(total), 0) from x),
    'sub', (select coalesce(sum(sub), 0) from x),
    'disc', (select coalesce(sum(disc), 0) from x),
    'tax', (select coalesce(sum(tax), 0) from x),
    'items', (select coalesce(sum(items), 0) from x),
    'hours', (select coalesce(jsonb_agg(jsonb_build_object('h', h, 'n', n, 'total', t, 'items', q) order by h), '[]'::jsonb)
                from (select extract(hour from lt)::int h, count(*) n, sum(total) t, sum(items) q from x group by 1) h),
    'days', (select coalesce(jsonb_agg(jsonb_build_object('d', d, 'n', n, 'total', t) order by d), '[]'::jsonb)
               from (select lt::date d, count(*) n, sum(total) t from x group by 1) d),
    'dowh', (select coalesce(jsonb_agg(jsonb_build_object('w', w, 'h', h, 'n', n, 'total', t)), '[]'::jsonb)
               from (select extract(isodow from lt)::int w, extract(hour from lt)::int h, count(*) n, sum(total) t from x group by 1, 2) w),
    'pays', (select coalesce(jsonb_agg(jsonb_build_object('m', m, 'n', n, 'total', t) order by t desc), '[]'::jsonb)
               from (select e->>0 m, count(*) n, sum((e->>1)::numeric) t from x, jsonb_array_elements(x.pays) e group by 1) p),
    'list', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'no', x.no, 'at', x.paid_at, 'opened', x.created_at, 'loc', x.loc, 'ch', x.ch, 'type', x.type,
                       'table', x.table_id, 'merged', x.merged_tables, 'by', coalesce(s.name, case when x.ch <> 'pos' then 'Bayar online' else '' end),
                       'member', mb.name, 'items', x.items, 'sub', x.sub, 'disc', x.disc, 'svc', x.svc, 'tax', x.tax, 'deliv', x.deliv, 'total', x.total, 'pays', x.pays)
                       order by x.paid_at desc), '[]'::jsonb)
               from (select * from x order by paid_at desc limit greatest(coalesce(p_limit, 100000), 1)) x
               left join staff s on s.id = x.paid_by left join members mb on mb.id = x.member_id),
    'truncated', (select count(*) from x) > coalesce(p_limit, 100000),
    'voids', (select jsonb_build_object('n', count(*), 'value', coalesce(sum(v), 0))
                from (select (select coalesce(sum(l.qty * l.price), 0) from order_lines l where l.order_id = v.id and l.parent_line_id is null) v
                        from orders v where v.status = 'void' and v.merged_into is null and v.location_id = any(v_locs) and v.void_at >= p_from and v.void_at <= p_to) z)
  ) into r;
  return r;
end $$;

-- Rekap penjualan per kategori & jam (nilai item sebelum diskon tagihan dan PB1; HPP aktual dari pemotongan stok)
create or replace function public.report_categories(p_from timestamptz, p_to timestamptz, p_locs text[] default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_locs text[]; tz text := engine.report_tz(); r jsonb;
begin
  v_locs := engine.report_locs(p_locs);
  with o as (
    select o.id, (o.paid_at at time zone tz) lt from orders o
     where o.status = 'paid' and o.location_id = any(v_locs) and o.paid_at >= p_from and o.paid_at <= p_to
  ), l as (
    select l.order_id, l.menu_id, coalesce(nullif(l.name, ''), m.name, l.menu_id) name, l.qty, l.qty * l.price v,
           coalesce(l.cost, 0) + coalesce((select sum(c.cost) from order_lines c where c.parent_line_id = l.id and c.status <> 'void'), 0) hpp,
           extract(hour from o.lt)::int h, o.lt::date d, coalesce(m.category_id, '_') cat
      from order_lines l join o on o.id = l.order_id left join menus m on m.id = l.menu_id
     where l.parent_line_id is null and l.status <> 'void'
  )
  select jsonb_build_object(
    'tz', tz,
    'master', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'sort', c.sort) order by c.sort, c.id), '[]'::jsonb) from menu_categories c),
    'cats', (select coalesce(jsonb_agg(jsonb_build_object('id', x.cat, 'name', coalesce(c.name, 'Tanpa kategori'), 'sort', coalesce(c.sort, 999),
                       'qty', x.q, 'value', x.v, 'hpp', x.hpp, 'orders', x.n, 'menus', x.nm) order by coalesce(c.sort, 999), x.cat), '[]'::jsonb)
               from (select cat, sum(qty) q, sum(v) v, sum(hpp) hpp, count(distinct order_id) n, count(distinct menu_id) nm from l group by cat) x
               left join menu_categories c on c.id = x.cat),
    'orders', (select count(*) from o),
    'hours', (select coalesce(jsonb_agg(jsonb_build_object('c', cat, 'h', h, 'qty', q, 'value', v)), '[]'::jsonb)
                from (select cat, h, sum(qty) q, sum(v) v from l group by 1, 2) y),
    'days', (select coalesce(jsonb_agg(jsonb_build_object('c', cat, 'd', d, 'qty', q, 'value', v)), '[]'::jsonb)
               from (select cat, d, sum(qty) q, sum(v) v from l group by 1, 2) y),
    'menus', (select coalesce(jsonb_agg(jsonb_build_object('c', cat, 'id', menu_id, 'name', name, 'qty', q, 'value', v, 'hpp', hpp) order by cat, v desc), '[]'::jsonb)
                from (select cat, menu_id, max(name) name, sum(qty) q, sum(v) v, sum(hpp) hpp, row_number() over (partition by cat order by sum(v) desc, menu_id) rn
                        from l group by cat, menu_id) z where rn <= 10)
  ) into r;
  return r;
end $$;

-- Rekap aktivitas denah meja: kunjungan, lama duduk, keterisian per jam, per meja/area, aktivitas staf, dan log
create or replace function public.report_tables(p_from timestamptz, p_to timestamptz, p_loc text default 'L1', p_log int default 400)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_locs text[]; tz text := engine.report_tz(); r jsonb; v_end timestamptz := least(p_to, now()); v_days int;
begin
  v_locs := engine.report_locs(array[p_loc]);
  if not (p_loc = any(v_locs)) then raise exception 'Akun ini tidak punya akses ke outlet tersebut' using errcode = '42501'; end if;
  v_days := greatest(1, ((v_end at time zone tz)::date - (p_from at time zone tz)::date) + 1);
  with v as (
    select o.id, o.no, o.status, o.channel, o.table_id, o.merged_tables, 1 + coalesce(cardinality(o.merged_tables), 0) nt, o.created_at st, o.paid_at, o.split_from,
           coalesce(o.total, 0) total, t.area,
           (select min(e.at) from table_events e where e.order_id = o.id and e.kind = 'clear' and e.at >= o.paid_at and e.at <= o.paid_at + interval '4 hours') cleared
      from orders o left join dining_tables t on t.id = o.table_id
     where o.location_id = p_loc and o.type = 'dine' and o.table_id is not null and o.status in ('paid', 'open')
       and o.created_at >= p_from and o.created_at <= p_to
  ), w as (
    select v.*, case when status = 'open' then greatest(st, least(now(), st + interval '6 hours')) else coalesce(cleared, paid_at) end en from v
  ), d as (
    select w.*, least(extract(epoch from (en - st)) / 60, 360) dur, extract(epoch from (cleared - paid_at)) / 60 linger from w
  ), occ as (
    select extract(hour from hs)::int h,
           sum(nt * greatest(0, extract(epoch from (least(d.en at time zone tz, hs + interval '1 hour') - greatest(d.st at time zone tz, hs))) / 60)) mins
      from d, generate_series(date_trunc('hour', d.st at time zone tz), d.en at time zone tz, interval '1 hour') hs
     where d.en > d.st and d.split_from is null
     group by 1
  ), ev as (
    select e.* from table_events e where e.location_id = p_loc and e.at >= p_from and e.at <= p_to
  ), sw as (
    select l.ready_at, l.served_at from order_lines l join orders o on o.id = l.order_id
     where o.location_id = p_loc and o.type = 'dine' and l.served_at >= p_from and l.served_at <= p_to and l.ready_at is not null and l.served_at >= l.ready_at
  ), lg as (
    select v.st at, v.table_id tbl, 'open' kind, v.no, case when v.channel = 'qr' then 'QR pelanggan' else coalesce((select name from staff where id = o.created_by), '') end who, null::text to_table, 0 qty,
           case when v.split_from is not null then 'Split bill dari ' || coalesce((select no from orders where id = v.split_from), '') when v.channel = 'qr' then 'Pesan lewat QR meja' when v.channel = 'web' then 'Pesanan online' else 'Bill dibuka di kasir' end detail
      from v join orders o on o.id = v.id
    union all
    select v.paid_at, v.table_id, 'paid', v.no, coalesce((select s.name from staff s join orders o on o.paid_by = s.id where o.id = v.id), 'Bayar online'), null, 0, engine.rp(v.total)
      from v where v.status = 'paid' and v.paid_at <= p_to
    union all
    select o.void_at, o.table_id, 'void', o.no, coalesce((select name from staff where id = o.void_by), ''), null, 0, coalesce(o.void_reason, '')
      from orders o where o.location_id = p_loc and o.type = 'dine' and o.table_id is not null and o.status = 'void' and o.merged_into is null and o.void_at >= p_from and o.void_at <= p_to
    union all
    select ev.at, ev.table_id, ev.kind, (select no from orders where id = ev.order_id), coalesce((select name from staff where id = ev.staff_id), case when ev.detail like 'otomatis%' then 'Sistem' else '' end),
           ev.to_table, ev.qty, ev.detail
      from ev
  )
  select jsonb_build_object(
    'tz', tz, 'days', v_days,
    'tables', (select count(*) from dining_tables where location_id = p_loc and active),
    'visits', (select count(*) from d where split_from is null),
    'open', (select count(*) from d where status = 'open' and split_from is null),
    'sales', (select coalesce(sum(total), 0) from d where status = 'paid'),
    'avg_dur', (select round(avg(dur)::numeric, 1) from d where status = 'paid' and split_from is null),
    'avg_linger', (select round(avg(linger)::numeric, 1) from d where linger is not null and split_from is null),
    'cleared_n', (select count(*) from d where cleared is not null and split_from is null),
    'serve_wait', (select round(avg(extract(epoch from (served_at - ready_at)) / 60)::numeric, 1) from sw where served_at - ready_at < interval '3 hours'),
    'serve_n', (select count(*) from sw),
    'voids', (select count(*) from lg where kind = 'void'),
    'ev', (select jsonb_build_object('move', count(*) filter (where kind = 'move'), 'clear', count(*) filter (where kind = 'clear' and detail not like 'otomatis%'),
                                     'auto', count(*) filter (where kind = 'clear' and detail like 'otomatis%'), 'serve', coalesce(sum(qty) filter (where kind = 'serve'), 0)) from ev),
    'hours', (select coalesce(jsonb_agg(jsonb_build_object('h', h.h, 'starts', coalesce(s.n, 0), 'occ', round(coalesce(oc.mins, 0)::numeric / (60 * v_days), 2)) order by h.h), '[]'::jsonb)
                from generate_series(0, 23) h(h)
                left join (select extract(hour from st at time zone tz)::int h, count(*) n from d where split_from is null group by 1) s on s.h = h.h
                left join occ oc on oc.h = h.h
               where coalesce(s.n, 0) > 0 or coalesce(oc.mins, 0) > 0),
    'dur', (select jsonb_agg(jsonb_build_object('b', b, 'n', n) order by b) from (
              select b, (select count(*) from d where status = 'paid' and split_from is null and case b when 0 then dur < 30 when 1 then dur >= 30 and dur < 60 when 2 then dur >= 60 and dur < 90
                                                                   when 3 then dur >= 90 and dur < 120 else dur >= 120 end) n from generate_series(0, 4) b) q),
    'per_table', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'area', t.area, 'seats', t.seats, 'visits', coalesce(x.n, 0), 'sales', coalesce(x.s, 0),
                         'avg_dur', x.a, 'moves', coalesce(m.n, 0), 'clears', coalesce(c.n, 0)) order by coalesce(x.n, 0) desc, t.sort, t.id), '[]'::jsonb)
                    from dining_tables t
                    left join (select table_id, count(*) filter (where split_from is null) n, sum(total) filter (where status = 'paid') s,
                                      round(avg(dur) filter (where status = 'paid' and split_from is null)::numeric, 1) a from d group by 1) x on x.table_id = t.id
                    left join (select table_id, count(*) n from ev where kind = 'move' group by 1) m on m.table_id = t.id
                    left join (select table_id, count(*) n from ev where kind = 'clear' group by 1) c on c.table_id = t.id
                   where t.location_id = p_loc and t.active),
    'per_area', (select coalesce(jsonb_agg(jsonb_build_object('area', a.area, 'tables', a.n, 'visits', coalesce(x.n, 0), 'sales', coalesce(x.s, 0), 'avg_dur', x.a,
                        'turn', round(coalesce(x.n, 0)::numeric / a.n / v_days, 2)) order by coalesce(x.n, 0) desc, a.area), '[]'::jsonb)
                   from (select area, count(*) n from dining_tables where location_id = p_loc and active group by 1) a
                   left join (select area, count(*) filter (where split_from is null) n, sum(total) filter (where status = 'paid') s,
                                     round(avg(dur) filter (where status = 'paid' and split_from is null)::numeric, 1) a from d group by 1) x on x.area = a.area),
    'per_day', (select coalesce(jsonb_agg(jsonb_build_object('d', dd, 'visits', n, 'sales', s, 'avg_dur', a) order by dd), '[]'::jsonb)
                  from (select (st at time zone tz)::date dd, count(*) filter (where split_from is null) n, coalesce(sum(total) filter (where status = 'paid'), 0) s,
                               round(avg(dur) filter (where status = 'paid' and split_from is null)::numeric, 1) a from d group by 1) q),
    'staff', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'role', s.role, 'opens', coalesce(op.n, 0), 'paid', coalesce(pd.n, 0),
                     'serves', coalesce(e.sv, 0), 'serve_items', coalesce(e.si, 0), 'clears', coalesce(e.cl, 0), 'moves', coalesce(e.mv, 0))
                     order by coalesce(e.sv, 0) + coalesce(e.cl, 0) + coalesce(e.mv, 0) + coalesce(op.n, 0) + coalesce(pd.n, 0) desc, s.name), '[]'::jsonb)
                from staff s
                left join (select o.created_by id, count(*) n from v join orders o on o.id = v.id where v.channel = 'pos' and v.split_from is null group by 1) op on op.id = s.id
                left join (select o.paid_by id, count(*) n from v join orders o on o.id = v.id where v.status = 'paid' group by 1) pd on pd.id = s.id
                left join (select staff_id id, count(*) filter (where kind = 'serve') sv, coalesce(sum(qty) filter (where kind = 'serve'), 0) si,
                                  count(*) filter (where kind = 'clear' and detail not like 'otomatis%') cl, count(*) filter (where kind = 'move') mv
                             from ev group by 1) e on e.id = s.id
               where coalesce(op.n, 0) + coalesce(pd.n, 0) + coalesce(e.sv, 0) + coalesce(e.cl, 0) + coalesce(e.mv, 0) > 0),
    'log', (select coalesce(jsonb_agg(jsonb_build_object('at', at, 'table', tbl, 'kind', kind, 'no', no, 'who', who, 'to', to_table, 'qty', qty, 'detail', detail) order by at desc), '[]'::jsonb)
              from (select * from lg order by at desc limit greatest(coalesce(p_log, 400), 1)) q),
    'log_total', (select count(*) from lg)
  ) into r;
  return r;
end $$;

revoke all on function engine.report_locs(text[]), engine.report_tz() from public;
revoke execute on function public.report_receipts(timestamptz, timestamptz, text[], int), public.report_categories(timestamptz, timestamptz, text[]),
  public.report_tables(timestamptz, timestamptz, text, int) from public, anon;
grant execute on function public.report_receipts(timestamptz, timestamptz, text[], int), public.report_categories(timestamptz, timestamptz, text[]),
  public.report_tables(timestamptz, timestamptz, text, int) to authenticated;
