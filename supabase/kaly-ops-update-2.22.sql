-- Kaly Ops 2.22 · Diskon per item, pembulatan dua arah, dan Invoice
-- Jalankan di Supabase > SQL Editor setelah SQL 2.21.
-- Isi:
--   1. Diskon per item  : kolom order_lines.disc, RPC line_discount_apply/remove,
--                         engine.compute_bill memotong diskon item paling awal,
--                         report_items & report_categories menempelkan potongan ke itemnya.
--   2. Pembulatan       : kolom settings.rounding_down_below (ambang gaya Moka POS),
--                         compute_bill membulatkan dua arah, engine.settle menjurnal arah naik.
--   3. Invoice          : tabel invoices & invoice_lines, settings.invoice, RPC invoice_save /
--                         invoice_mark_paid / invoice_void, public_invoice untuk tautan tamu.

-- ---------------------------------------------------------------------
-- 1 & 2 · Diskon per item dan pembulatan dua arah
-- ---------------------------------------------------------------------
alter table public.order_lines add column if not exists disc jsonb;
comment on column public.order_lines.disc is '2.22: diskon khusus baris ini {type,value,name,disc,max,reason,by,approved}';

alter table public.settings add column if not exists rounding_down_below numeric not null default 51;
alter table public.settings drop constraint if exists settings_rounding_down_below_check;
alter table public.settings add constraint settings_rounding_down_below_check
  check (rounding_down_below >= 0 and rounding_down_below < rounding_to);

-- compute_bill, settle, report_items, report_categories, line_discount_apply dan
-- line_discount_remove disalin apa adanya dari 02_engine.sql, 03_rpc.sql dan 05_reports.sql.
-- Jalankan ulang ketiga berkas itu bila ingin memastikan semuanya sinkron.

-- ---------------------------------------------------------------------
-- 3 · Invoice
-- ---------------------------------------------------------------------
create table if not exists public.invoices (
  id             text primary key default public.new_id('inv'),
  no             text not null unique,
  location_id    text not null references public.locations(id) on update cascade,
  kind           text not null default 'manual' check (kind in ('order', 'reservation', 'manual')),
  order_id       text references public.orders(id) on delete set null,
  reservation_id text references public.reservations(id) on delete set null,
  bill_name      text not null default '',
  bill_company   text not null default '',
  bill_address   text not null default '',
  bill_phone     text not null default '',
  bill_email     text not null default '',
  bill_npwp      text not null default '',
  issued_on      date not null default public.biz_date(),
  due_on         date,
  sub            numeric not null default 0,
  disc           numeric not null default 0,
  svc            numeric not null default 0,
  tax            numeric not null default 0,
  round          numeric not null default 0,
  total          numeric not null default 0,
  paid           numeric not null default 0,   -- DP atau cicilan yang sudah masuk
  status         text not null default 'terbit' check (status in ('terbit', 'lunas', 'batal')),
  paid_on        date,
  void_reason    text,
  note           text not null default '',
  token          uuid not null default gen_random_uuid(),
  created_by     text references public.staff(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index if not exists invoices_token_uq on public.invoices (token);
create index if not exists invoices_loc_issued_ix on public.invoices (location_id, issued_on desc);
create index if not exists invoices_order_ix on public.invoices (order_id) where order_id is not null;
create index if not exists invoices_res_ix on public.invoices (reservation_id) where reservation_id is not null;

create table if not exists public.invoice_lines (
  id         text primary key default public.new_id('il'),
  invoice_id text not null references public.invoices(id) on delete cascade,
  name       text not null,
  qty        numeric not null default 1,
  price      numeric not null default 0,
  amount     numeric not null default 0,
  sort       int not null default 0
);
create index if not exists invoice_lines_inv_ix on public.invoice_lines (invoice_id, sort);

-- Identitas penerbit dan rekening tujuan transfer, dipakai di kepala dan kaki invoice.
alter table public.settings add column if not exists invoice jsonb not null default '{}';
comment on column public.settings.invoice is 'Identitas di invoice: {"name","address","phone","email","npwp","bank":[{"bank","no","an"}],"terms","dueDays","footer"}. Kunci kosong memakai data nota.';

alter table public.invoices enable row level security;
alter table public.invoice_lines enable row level security;
do $$
declare staff_all text := 'public.is_staff(null)'; kasir text := 'public.is_staff(array[''owner'', ''kasir''])'; owner_only text := 'public.is_staff(array[''owner''])';
begin
  perform engine.policy('invoices', 'baca', 'select', staff_all || ' and public.can_loc(location_id)');
  perform engine.policy('invoices', 'buat', 'insert', null, kasir || ' and public.can_loc(location_id)');
  perform engine.policy('invoices', 'ubah', 'update', kasir || ' and public.can_loc(location_id)');
  perform engine.policy('invoices', 'hapus', 'delete', owner_only);
  perform engine.policy('invoice_lines', 'baca', 'select', staff_all);
  perform engine.policy('invoice_lines', 'buat', 'insert', null, kasir);
  perform engine.policy('invoice_lines', 'ubah', 'update', kasir);
  perform engine.policy('invoice_lines', 'hapus', 'delete', kasir);
end $$;

-- Nomor invoice berurut per hari usaha: INV-261126-001
create or replace function engine.invoice_no() returns text language plpgsql set search_path = public as $$
declare d date := public.biz_date(); n int;
begin
  select count(*) + 1 into n from invoices where issued_on = d;
  loop
    exit when not exists (select 1 from invoices where no = 'INV-' || to_char(d, 'YYMMDD') || '-' || lpad(n::text, 3, '0'));
    n := n + 1;
  end loop;
  return 'INV-' || to_char(d, 'YYMMDD') || '-' || lpad(n::text, 3, '0');
end $$;

-- Menyusun invoice. Angka tidak pernah diambil dari aplikasi: untuk invoice yang bersumber dari
-- bill, semuanya dibaca ulang dari nota aslinya; untuk tagihan manual, service dan PB1 dihitung
-- dari tarif yang berlaku. Jadi invoice tidak bisa menyimpang dari pembukuan.
create or replace function public.invoice_save(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.staff; s public.settings; v public.invoices; v_id text; o public.orders; r public.reservations;
        b jsonb; v_loc text; v_sub numeric := 0; v_disc numeric := 0; v_svc numeric := 0;
        v_tax numeric := 0; v_round numeric := 0; v_paid numeric := 0; v_kind text;
        v_order text; v_res text; li jsonb; i int := 0;
begin
  me := engine.require_role(array['owner', 'kasir']);
  perform engine.on_();
  select * into s from settings where id = 1;
  v_id := nullif(p->>'id', '');

  if v_id is not null then
    select * into v from invoices where id = v_id for update;
    if v.id is null then raise exception 'Invoice tidak ditemukan'; end if;
    if v.status <> 'terbit' then raise exception 'Invoice yang sudah % tidak bisa diubah', v.status; end if;
    v_kind := v.kind; v_loc := v.location_id; v_order := v.order_id; v_res := v.reservation_id;
  else
    v_kind := coalesce(nullif(p->>'kind', ''), 'manual');
    v_loc := nullif(p->>'loc', ''); v_order := nullif(p->>'order', ''); v_res := nullif(p->>'reservation', '');
  end if;

  if v_kind = 'order' then
    select * into o from orders where id = v_order;
    if o.id is null then raise exception 'Bill tidak ditemukan'; end if;
    if o.status not in ('paid', 'refund') then raise exception 'Bill ini belum ditutup, jadi belum bisa ditagihkan'; end if;
    v_loc := o.location_id; b := o.bill;
    v_sub := coalesce((b->>'sub')::numeric, 0); v_disc := coalesce((b->>'disc')::numeric, 0);
    v_svc := coalesce((b->>'svc')::numeric, 0); v_tax := coalesce((b->>'tax')::numeric, 0);
    v_round := coalesce((b->>'round')::numeric, 0);
    select coalesce(sum(amount), 0) into v_paid from order_payments where order_id = o.id and method <> 'bill';
  elsif v_kind = 'reservation' then
    select * into r from reservations where id = v_res;
    if r.id is null then raise exception 'Reservasi tidak ditemukan'; end if;
    v_loc := coalesce(v_loc, nullif(p->>'loc', ''), (select id from locations order by id limit 1));
    v_paid := coalesce(r.dp_amount, 0);
  end if;
  if v_loc is null then raise exception 'Outlet penerbit wajib dipilih'; end if;
  if not public.can_loc(v_loc) then raise exception 'Tidak punya akses ke outlet ini' using errcode = '42501'; end if;

  if v_id is null then
    insert into invoices (no, location_id, kind, order_id, reservation_id, created_by)
      values (engine.invoice_no(), v_loc, v_kind, v_order, v_res, me.id) returning id into v_id;
  end if;

  update invoices set
    bill_name = coalesce(p->'billTo'->>'name', bill_name),
    bill_company = coalesce(p->'billTo'->>'company', bill_company),
    bill_address = coalesce(p->'billTo'->>'address', bill_address),
    bill_phone = coalesce(p->'billTo'->>'phone', bill_phone),
    bill_email = coalesce(p->'billTo'->>'email', bill_email),
    bill_npwp = coalesce(p->'billTo'->>'npwp', bill_npwp),
    due_on = coalesce((nullif(p->>'dueOn', ''))::date, due_on),
    note = coalesce(p->>'note', note),
    updated_at = now()
  where id = v_id;

  delete from invoice_lines where invoice_id = v_id;
  if v_kind = 'order' then
    insert into invoice_lines (invoice_id, name, qty, price, amount, sort)
      select v_id, l.name, l.qty, l.price, l.qty * l.price, row_number() over (order by l.sort)
        from order_lines l where l.order_id = o.id and l.status <> 'void' and l.parent_line_id is null;
  else
    for li in select * from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) loop
      if coalesce(nullif(li->>'name', ''), '') = '' then continue; end if;
      i := i + 1;
      insert into invoice_lines (invoice_id, name, qty, price, amount, sort)
        values (v_id, li->>'name', coalesce((li->>'qty')::numeric, 1), coalesce((li->>'price')::numeric, 0),
                engine.jsround(coalesce((li->>'qty')::numeric, 1) * coalesce((li->>'price')::numeric, 0)), i);
    end loop;
    select coalesce(sum(amount), 0) into v_sub from invoice_lines where invoice_id = v_id;
    v_disc := greatest(0, least(coalesce((p->>'disc')::numeric, 0), v_sub));
    if coalesce((p->>'svcOn')::boolean, false) then v_svc := engine.jsround((v_sub - v_disc) * s.service_rate); end if;
    if coalesce((p->>'taxOn')::boolean, true) then v_tax := engine.jsround((v_sub - v_disc + v_svc) * s.tax_rate); end if;
    if v_kind = 'manual' then v_paid := greatest(0, coalesce((p->>'paid')::numeric, 0)); end if;
  end if;

  update invoices set sub = v_sub, disc = v_disc, svc = v_svc, tax = v_tax, round = v_round,
         total = v_sub - v_disc + v_svc + v_tax - v_round, paid = v_paid, updated_at = now()
   where id = v_id;
  return to_jsonb((select x from invoices x where x.id = v_id));
end $$;

-- Status dokumen saja; uangnya tetap dicatat lewat kasir atau pelunasan piutang.
create or replace function public.invoice_mark_paid(p_id text, p_on date default null, p_paid numeric default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.staff; v public.invoices;
begin
  me := engine.require_role(array['owner', 'kasir']);
  select * into v from invoices where id = p_id for update;
  if v.id is null then raise exception 'Invoice tidak ditemukan'; end if;
  if not public.can_loc(v.location_id) then raise exception 'Tidak punya akses ke outlet ini' using errcode = '42501'; end if;
  if v.status <> 'terbit' then raise exception 'Invoice ini sudah %', v.status; end if;
  if coalesce(p_on, public.biz_date()) > public.biz_date() then raise exception 'Tanggal pelunasan tidak boleh di masa depan'; end if;
  if v.kind = 'order' and exists (select 1 from receivables where order_id = v.order_id and status = 'open') then
    raise exception 'Bill ini masih tercatat sebagai piutang. Tandai lunas lewat Laporan keuangan - Piutang supaya jurnalnya ikut tercatat.';
  end if;
  update invoices set status = 'lunas', paid_on = coalesce(p_on, public.biz_date()),
         paid = coalesce(p_paid, total), updated_at = now() where id = p_id;
  return to_jsonb((select x from invoices x where x.id = p_id));
end $$;

create or replace function public.invoice_void(p_id text, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.staff; v public.invoices;
begin
  me := engine.require_role(array['owner', 'kasir']);
  if coalesce(trim(p_reason), '') = '' then raise exception 'Alasan pembatalan wajib diisi'; end if;
  select * into v from invoices where id = p_id for update;
  if v.id is null then raise exception 'Invoice tidak ditemukan'; end if;
  if not public.can_loc(v.location_id) then raise exception 'Tidak punya akses ke outlet ini' using errcode = '42501'; end if;
  if v.status = 'lunas' then raise exception 'Invoice yang sudah lunas tidak bisa dibatalkan'; end if;
  update invoices set status = 'batal', void_reason = trim(p_reason), updated_at = now() where id = p_id;
  return to_jsonb((select x from invoices x where x.id = p_id));
end $$;

-- Piutang dilunasi lewat jalur yang sudah ada -> invoice-nya ikut menjadi lunas, supaya
-- dokumen dan pembukuan tidak pernah berbeda cerita.
create or replace function engine.tg_invoice_follow_receivable() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'paid' and coalesce(old.status, '') <> 'paid' then
    update invoices set status = 'lunas', paid_on = new.paid_on, paid = total, updated_at = now()
     where order_id = new.order_id and status = 'terbit';
  end if;
  return new;
end $$;
drop trigger if exists invoice_follow_receivable on public.receivables;
create trigger invoice_follow_receivable after update of status on public.receivables
  for each row execute function engine.tg_invoice_follow_receivable();

-- Halaman invoice untuk tamu: dibuka lewat tautan bertoken, tanpa login. Hanya mengembalikan
-- isi invoice itu sendiri — tidak ada jalan ke data lain.
create or replace function public.public_invoice(p_token uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v public.invoices; s public.settings; loc public.locations; iv jsonb;
begin
  select * into v from invoices where token = p_token;
  if v.id is null then return null; end if;
  select * into s from settings where id = 1;
  select * into loc from locations where id = v.location_id;
  iv := coalesce(s.invoice, '{}'::jsonb);
  return jsonb_build_object(
    'no', v.no, 'status', v.status, 'kind', v.kind,
    'issuedOn', v.issued_on, 'dueOn', v.due_on, 'paidOn', v.paid_on,
    'billTo', jsonb_build_object('name', v.bill_name, 'company', v.bill_company, 'address', v.bill_address,
                                 'phone', v.bill_phone, 'email', v.bill_email, 'npwp', v.bill_npwp),
    'sub', v.sub, 'disc', v.disc, 'svc', v.svc, 'tax', v.tax, 'round', v.round,
    'total', v.total, 'paid', v.paid, 'due', v.total - v.paid, 'note', v.note,
    'taxRate', s.tax_rate, 'serviceRate', s.service_rate,
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('name', l.name, 'qty', l.qty, 'price', l.price, 'amount', l.amount) order by l.sort), '[]'::jsonb)
                from invoice_lines l where l.invoice_id = v.id),
    'from', jsonb_build_object(
      'name', coalesce(nullif(iv->>'name', ''), nullif(s.receipt->>'name', ''), s.brand_name),
      'address', coalesce(nullif(iv->>'address', ''), nullif(s.receipt->>'header', ''), ''),
      'phone', coalesce(iv->>'phone', ''), 'email', coalesce(iv->>'email', ''),
      'npwp', coalesce(iv->>'npwp', ''), 'bank', coalesce(iv->'bank', '[]'::jsonb),
      'terms', coalesce(iv->>'terms', ''), 'footer', coalesce(iv->>'footer', ''),
      'outlet', coalesce(loc.name, ''), 'tz', s.timezone));
end $$;

revoke all on function public.invoice_save(jsonb), public.invoice_mark_paid(text, date, numeric), public.invoice_void(text, text) from public, anon;
grant execute on function public.invoice_save(jsonb), public.invoice_mark_paid(text, date, numeric), public.invoice_void(text, text) to authenticated;
revoke all on function public.public_invoice(uuid) from public;
grant execute on function public.public_invoice(uuid) to anon, authenticated;
