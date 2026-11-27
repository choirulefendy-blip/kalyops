-- 2.23 · Tablet kasir ikut memuat ulang reservasi saat menu pesanan berubah
drop trigger if exists sync_log on public.reservation_items;
create trigger sync_log after insert or update or delete on public.reservation_items for each statement execute function engine.tg_sync_log();
