begin;

lock table public.chat_history in access exclusive mode;

alter table public.chat_history
  add column if not exists provider_event_at timestamptz;

-- The lock is held until commit. The snapshot below therefore
-- contains only rows that existed at this database-clock cutover. New rows always
-- default to NULL, including delayed/backdated inserts from the previous server.
do $cutover$
declare
  cutover_at timestamptz;
begin
  -- The column itself is the one-time initialization marker. Replaying this
  -- migration must not mark newly inserted rows or extend an existing transition.
  if not exists (
    select 1 from pg_attribute
    where attrelid = 'public.chat_history'::regclass
      and attname = 'reminder_provider_time_cutover_at'
      and not attisdropped
  ) then
    alter table public.chat_history
      add column reminder_provider_time_cutover_at timestamptz;
    cutover_at := clock_timestamp();
    update public.chat_history
      set reminder_provider_time_cutover_at = cutover_at
      where platform in ('whatsapp', 'messenger', 'instagram')
        and sender in ('user', 'customer')
        and provider_event_at is null
        and created_at > cutover_at - interval '24 hours'
        and created_at < cutover_at;
  end if;
end;
$cutover$;

comment on column public.chat_history.provider_event_at is
  'Actual inbound Meta webhook event time; null when unavailable or unverified. Local created_at must never be backfilled as provider-window evidence.';

comment on column public.chat_history.reminder_provider_time_cutover_at is
  'One-time database-clock cutover marker on legacy Meta inbound rows only. NULL for new inserts. Reminder created_at compatibility expires strictly before cutover + 24 hours.';

commit;
