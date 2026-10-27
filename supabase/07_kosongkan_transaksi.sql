-- =====================================================================
-- Kaly Ops · Database Supabase · 07 Kosongkan transaksi uji coba (OPSIONAL)
-- ---------------------------------------------------------------------
-- HATI-HATI: menghapus SEMUA transaksi: pesanan, pembayaran, jurnal, kartu stok, stok, shift,
-- reservasi, member & poin, kartu deposit, PO, mutasi, opname, B2B, temuan fraud, dan antrean cetak.
-- Data master tetap: menu, kategori, resep, bahan, meja, staf, tier, supplier, promo, voucher, pengaturan.
-- Pakai sekali sebelum mulai operasional sungguhan, lalu jalankan ulang 06_seed_master.sql
-- untuk mengisi stok awal dan saldo awal persediaan lagi (atau langsung lakukan stock opname).
-- =====================================================================
do $$ begin perform set_config('kaly.engine', 'on', false); end $$;
truncate table
  public.order_payments, public.order_notices, public.order_lines, public.orders, public.counters,
  public.deposit_tx, public.deposit_cards, public.shifts,
  public.point_tx, public.member_missions, public.reservations, public.members,
  public.journal_lines, public.journals, public.stock_moves, public.productions, public.stock,
  public.fraud_flags, public.purchase_order_lines, public.purchase_orders, public.transfer_lines, public.transfers,
  public.opname_lines, public.opnames, public.b2b_lines, public.b2b_invoices, public.print_jobs, public.sync_log
restart identity;
update public.vouchers set used = 0, revenue = 0, cost = 0;
do $$ begin perform set_config('kaly.engine', '', false); end $$;
