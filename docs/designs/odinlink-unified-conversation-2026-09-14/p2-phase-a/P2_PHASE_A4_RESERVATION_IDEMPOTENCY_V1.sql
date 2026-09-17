begin;

create unique index if not exists
  odin_resource_reservations_operation_resource_uidx
on public.odin_resource_reservations (
  business_id,
  operation_id,
  resource_id
)
where operation_id is not null;


create or replace function public.odin_create_capacity_one_reservation(
  p_business_id bigint,
  p_operation_id uuid,
  p_resource_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_buffer_before_minutes integer default 0,
  p_buffer_after_minutes integer default 0,
  p_status text default 'held',
  p_expires_at timestamptz default null
)
returns table (
  outcome text,
  reservation_id uuid,
  business_id bigint,
  operation_id uuid,
  resource_id uuid,
  schema_version integer,
  units integer,
  start_at timestamptz,
  end_at timestamptz,
  buffer_before_minutes integer,
  buffer_after_minutes integer,
  status text,
  expires_at timestamptz,
  exclusive_capacity_one boolean,
  effective_window tstzrange,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_capacity integer;
  v_row public.odin_resource_reservations%rowtype;
begin
  if p_business_id is null or p_business_id <= 0 then
    raise exception 'invalid_business_id';
  end if;

  if p_operation_id is null then
    raise exception 'operation_id_required';
  end if;

  if p_resource_id is null then
    raise exception 'resource_id_required';
  end if;

  if p_start_at is null or p_end_at is null or p_end_at <= p_start_at then
    raise exception 'invalid_reservation_window';
  end if;

  if p_buffer_before_minutes < 0 or p_buffer_after_minutes < 0 then
    raise exception 'invalid_reservation_buffer';
  end if;

  if p_status not in (
    'held',
    'reserved',
    'dispatching',
    'uncertain',
    'verified'
  ) then
    raise exception 'invalid_authoritative_reservation_status';
  end if;

  select r.capacity
    into v_capacity
  from public.odin_resources r
  where r.business_id = p_business_id
    and r.id = p_resource_id
    and r.status = 'active'
  for update;

  if v_capacity is null then
    raise exception 'resource_not_found_or_inactive';
  end if;

  if v_capacity <> 1 then
    raise exception 'multi_capacity_not_yet_authoritative';
  end if;

  perform 1
  from public.odin_operations o
  where o.business_id = p_business_id
    and o.id = p_operation_id;

  if not found then
    raise exception 'operation_not_found';
  end if;

  select rr.*
    into v_row
  from public.odin_resource_reservations rr
  where rr.business_id = p_business_id
    and rr.operation_id = p_operation_id
    and rr.resource_id = p_resource_id
  limit 1;

  if found then
    if (
      v_row.units <> 1
      or v_row.start_at <> p_start_at
      or v_row.end_at <> p_end_at
      or v_row.buffer_before_minutes <> p_buffer_before_minutes
      or v_row.buffer_after_minutes <> p_buffer_after_minutes
    ) then
      raise exception 'reservation_idempotency_mismatch';
    end if;

    return query
    select
      'existing'::text,
      v_row.id,
      v_row.business_id,
      v_row.operation_id,
      v_row.resource_id,
      v_row.schema_version,
      v_row.units,
      v_row.start_at,
      v_row.end_at,
      v_row.buffer_before_minutes,
      v_row.buffer_after_minutes,
      v_row.status,
      v_row.expires_at,
      v_row.exclusive_capacity_one,
      v_row.effective_window,
      v_row.created_at,
      v_row.updated_at;

    return;
  end if;

  begin
    insert into public.odin_resource_reservations (
      business_id,
      operation_id,
      resource_id,
      schema_version,
      units,
      start_at,
      end_at,
      buffer_before_minutes,
      buffer_after_minutes,
      status,
      expires_at
    )
    values (
      p_business_id,
      p_operation_id,
      p_resource_id,
      1,
      1,
      p_start_at,
      p_end_at,
      p_buffer_before_minutes,
      p_buffer_after_minutes,
      p_status,
      p_expires_at
    )
    returning *
      into v_row;

  exception
    when exclusion_violation then
      return query
      select
        'conflict'::text,
        null::uuid,
        p_business_id,
        p_operation_id,
        p_resource_id,
        1,
        1,
        p_start_at,
        p_end_at,
        p_buffer_before_minutes,
        p_buffer_after_minutes,
        p_status,
        p_expires_at,
        true,
        tstzrange(
          p_start_at - (p_buffer_before_minutes * interval '1 minute'),
          p_end_at + (p_buffer_after_minutes * interval '1 minute'),
          '[)'
        ),
        null::timestamptz,
        null::timestamptz;

      return;
  end;

  return query
  select
    'created'::text,
    v_row.id,
    v_row.business_id,
    v_row.operation_id,
    v_row.resource_id,
    v_row.schema_version,
    v_row.units,
    v_row.start_at,
    v_row.end_at,
    v_row.buffer_before_minutes,
    v_row.buffer_after_minutes,
    v_row.status,
    v_row.expires_at,
    v_row.exclusive_capacity_one,
    v_row.effective_window,
    v_row.created_at,
    v_row.updated_at;
end;
$$;

revoke all on function public.odin_create_capacity_one_reservation(
  bigint,
  uuid,
  uuid,
  timestamptz,
  timestamptz,
  integer,
  integer,
  text,
  timestamptz
) from public, anon, authenticated;

commit;
