begin;

-- Launch-safety seam for cross-worker slot ownership. One row represents one
-- exact provider-calendar interval. Released/expired reservations are reclaimed
-- by updating the same row, so uniqueness remains simple and race-free.
create table public.booking_slot_reservations (
  business_id bigint not null references public.businesses(id) on delete cascade,
  calendar_identity text not null check (char_length(btrim(calendar_identity)) between 1 and 200),
  start_time timestamptz not null,
  end_time timestamptz not null,
  operation_id text not null check (char_length(btrim(operation_id)) between 1 and 200),
  customer_key text not null check (char_length(btrim(customer_key)) between 1 and 500),
  status text not null check (status in ('reserved', 'settled', 'released')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, calendar_identity, start_time, end_time),
  check (end_time > start_time)
);

create index booking_slot_reservations_expiry_idx
  on public.booking_slot_reservations (expires_at)
  where status = 'reserved';

-- Minimal durable outbox for terminal booking confirmations only. This is not a
-- general messaging queue. operation_id is the idempotency identity.
create table public.booking_result_outbox (
  id uuid primary key default gen_random_uuid(),
  operation_id text not null unique check (char_length(btrim(operation_id)) between 1 and 200),
  business_id bigint not null references public.businesses(id) on delete cascade,
  channel text not null check (channel in ('telegram', 'whatsapp', 'instagram', 'messenger')),
  customer_id text not null check (char_length(btrim(customer_id)) between 1 and 500),
  session_id text not null check (char_length(btrim(session_id)) between 1 and 1000),
  booking_id text not null,
  provider_booking_id text not null,
  terminal_result jsonb not null check (jsonb_typeof(terminal_result) = 'object'),
  response_text text not null check (char_length(btrim(response_text)) between 1 and 4000),
  status text not null default 'pending' check (status in ('pending', 'delivering', 'delivered', 'failed', 'cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  delivery_token uuid,
  lease_expires_at timestamptz,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index booking_result_outbox_recovery_idx
  on public.booking_result_outbox (business_id, channel, customer_id, created_at desc);

create index booking_result_outbox_delivery_idx
  on public.booking_result_outbox (status, lease_expires_at, created_at)
  where status in ('pending', 'failed', 'delivering');

alter table public.booking_slot_reservations enable row level security;
alter table public.booking_result_outbox enable row level security;

revoke all on public.booking_slot_reservations from anon, authenticated;
revoke all on public.booking_result_outbox from anon, authenticated;
grant all on public.booking_slot_reservations to service_role;
grant all on public.booking_result_outbox to service_role;

create or replace function public.claim_booking_slot_reservation(
  p_business_id bigint,
  p_calendar_identity text,
  p_start_time timestamptz,
  p_end_time timestamptz,
  p_operation_id text,
  p_customer_key text,
  p_expires_at timestamptz
)
returns setof public.booking_slot_reservations
language plpgsql
security invoker
set search_path = public
as $function$
begin
  if p_end_time <= p_start_time or p_expires_at <= now() then
    raise exception 'invalid slot reservation interval';
  end if;

  return query
  insert into public.booking_slot_reservations as reservation (
    business_id, calendar_identity, start_time, end_time,
    operation_id, customer_key, status, expires_at
  ) values (
    p_business_id, btrim(p_calendar_identity), p_start_time, p_end_time,
    btrim(p_operation_id), btrim(p_customer_key), 'reserved', p_expires_at
  )
  on conflict (business_id, calendar_identity, start_time, end_time)
  do update set
    operation_id = excluded.operation_id,
    customer_key = excluded.customer_key,
    status = 'reserved',
    expires_at = excluded.expires_at,
    updated_at = now()
  where
    reservation.status = 'released' or
    (
      reservation.status = 'reserved' and
      (
        reservation.operation_id = excluded.operation_id or
        reservation.expires_at <= now()
      )
    )
  returning reservation.*;
end;
$function$;

create or replace function public.settle_booking_slot_reservation(
  p_business_id bigint,
  p_calendar_identity text,
  p_start_time timestamptz,
  p_end_time timestamptz,
  p_operation_id text
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $function$
declare changed integer;
begin
  update public.booking_slot_reservations
  set status = 'settled', expires_at = 'infinity'::timestamptz, updated_at = now()
  where business_id = p_business_id
    and calendar_identity = btrim(p_calendar_identity)
    and start_time = p_start_time
    and end_time = p_end_time
    and operation_id = btrim(p_operation_id)
    and status in ('reserved', 'settled');
  get diagnostics changed = row_count;
  return changed = 1;
end;
$function$;

create or replace function public.release_booking_slot_reservation(
  p_business_id bigint,
  p_calendar_identity text,
  p_start_time timestamptz,
  p_end_time timestamptz,
  p_operation_id text
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $function$
declare changed integer;
begin
  update public.booking_slot_reservations
  set status = 'released', expires_at = now(), updated_at = now()
  where business_id = p_business_id
    and calendar_identity = btrim(p_calendar_identity)
    and start_time = p_start_time
    and end_time = p_end_time
    and operation_id = btrim(p_operation_id)
    and status = 'reserved';
  get diagnostics changed = row_count;
  return changed = 1;
end;
$function$;

-- Atomically makes the operation claim terminal and creates the exact recovery
-- message. The calendar and appointment have already passed read-back checks.
create or replace function public.finalize_booking_result_outbox(
  p_claim_user_id text,
  p_claim_platform text,
  p_claim_state text,
  p_operation_id text,
  p_business_id bigint,
  p_channel text,
  p_customer_id text,
  p_session_id text,
  p_booking_id text,
  p_provider_booking_id text,
  p_calendar_identity text,
  p_slot_start_time timestamptz,
  p_slot_end_time timestamptz,
  p_terminal_result jsonb,
  p_response_text text
)
returns setof public.booking_result_outbox
language plpgsql
security invoker
set search_path = public
as $function$
declare claim_exists boolean;
declare reservation_changed integer;
begin
  select true into claim_exists
  from public.appointments_leads
  where user_id = p_claim_user_id and platform = p_claim_platform
  for update;

  if not coalesce(claim_exists, false) then
    raise exception 'booking operation claim not found';
  end if;

  update public.booking_slot_reservations
  set status = 'settled', expires_at = 'infinity'::timestamptz, updated_at = now()
  where business_id = p_business_id
    and calendar_identity = btrim(p_calendar_identity)
    and start_time = p_slot_start_time
    and end_time = p_slot_end_time
    and operation_id = btrim(p_operation_id)
    and status in ('reserved', 'settled');
  get diagnostics reservation_changed = row_count;
  if reservation_changed <> 1 then
    raise exception 'booking slot reservation not owned';
  end if;

  insert into public.booking_result_outbox (
    operation_id, business_id, channel, customer_id, session_id,
    booking_id, provider_booking_id, terminal_result, response_text
  ) values (
    btrim(p_operation_id), p_business_id, btrim(p_channel), btrim(p_customer_id), p_session_id,
    p_booking_id, p_provider_booking_id, p_terminal_result, p_response_text
  )
  on conflict (operation_id) do nothing;

  update public.appointments_leads
  set ai_summary = p_claim_state
  where user_id = p_claim_user_id and platform = p_claim_platform;

  return query
  select * from public.booking_result_outbox where operation_id = btrim(p_operation_id);
end;
$function$;

create or replace function public.claim_booking_result_outbox_delivery(
  p_operation_id text,
  p_delivery_token uuid,
  p_lease_seconds integer default 60
)
returns setof public.booking_result_outbox
language sql
security invoker
set search_path = public
as $function$
  update public.booking_result_outbox
  set status = 'delivering',
      attempts = attempts + 1,
      delivery_token = p_delivery_token,
      lease_expires_at = now() + make_interval(secs => greatest(10, least(p_lease_seconds, 300))),
      updated_at = now(),
      last_error = null
  where operation_id = btrim(p_operation_id)
    and (
      status in ('pending', 'failed') or
      (status = 'delivering' and lease_expires_at <= now())
    )
  returning *;
$function$;

create or replace function public.complete_booking_result_outbox_delivery(
  p_operation_id text,
  p_delivery_token uuid,
  p_delivered boolean,
  p_error text default null
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $function$
declare changed integer;
begin
  update public.booking_result_outbox
  set status = case when p_delivered then 'delivered' else 'failed' end,
      delivered_at = case when p_delivered then now() else delivered_at end,
      lease_expires_at = null,
      last_error = case when p_delivered then null else left(coalesce(p_error, 'delivery_failed'), 500) end,
      updated_at = now()
  where operation_id = btrim(p_operation_id)
    and delivery_token = p_delivery_token
    and status = 'delivering';
  get diagnostics changed = row_count;
  if changed = 1 then
    return true;
  end if;

  -- A provider acknowledgement may be retried after the process loses its
  -- response. Return the existing terminal success only to the same lease
  -- token; foreign tokens must not be able to acknowledge this delivery.
  return p_delivered and exists (
    select 1
    from public.booking_result_outbox
    where operation_id = btrim(p_operation_id)
      and delivery_token = p_delivery_token
      and status = 'delivered'
  );
end;
$function$;

revoke all on function public.claim_booking_slot_reservation(bigint, text, timestamptz, timestamptz, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.settle_booking_slot_reservation(bigint, text, timestamptz, timestamptz, text) from public, anon, authenticated;
revoke all on function public.release_booking_slot_reservation(bigint, text, timestamptz, timestamptz, text) from public, anon, authenticated;
revoke all on function public.finalize_booking_result_outbox(text, text, text, text, bigint, text, text, text, text, text, text, timestamptz, timestamptz, jsonb, text) from public, anon, authenticated;
revoke all on function public.claim_booking_result_outbox_delivery(text, uuid, integer) from public, anon, authenticated;
revoke all on function public.complete_booking_result_outbox_delivery(text, uuid, boolean, text) from public, anon, authenticated;

grant execute on function public.claim_booking_slot_reservation(bigint, text, timestamptz, timestamptz, text, text, timestamptz) to service_role;
grant execute on function public.settle_booking_slot_reservation(bigint, text, timestamptz, timestamptz, text) to service_role;
grant execute on function public.release_booking_slot_reservation(bigint, text, timestamptz, timestamptz, text) to service_role;
grant execute on function public.finalize_booking_result_outbox(text, text, text, text, bigint, text, text, text, text, text, text, timestamptz, timestamptz, jsonb, text) to service_role;
grant execute on function public.claim_booking_result_outbox_delivery(text, uuid, integer) to service_role;
grant execute on function public.complete_booking_result_outbox_delivery(text, uuid, boolean, text) to service_role;

comment on table public.booking_slot_reservations is
  'Durable cross-worker ownership for one exact business/calendar interval. Drop this table and its three functions to reverse the reservation seam.';
comment on table public.booking_result_outbox is
  'Minimal recoverable outbox for verified transactional booking confirmations. Drop this table and its three functions to reverse the outbox seam.';

commit;
