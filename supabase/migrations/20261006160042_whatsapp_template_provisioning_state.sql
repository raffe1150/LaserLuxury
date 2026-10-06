-- Prepared only. No production migration is applied by this change.
-- Private durable state/leases/intents; no tokens and no businesses mapping write.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
create schema if not exists channel_provisioning;
revoke all on schema channel_provisioning from public, anon, authenticated;
grant usage on schema channel_provisioning to service_role;

create table channel_provisioning.leases (
  resource_key text primary key,
  owner uuid not null,
  fence uuid not null default gen_random_uuid(),
  expires_at timestamptz not null
);
create table channel_provisioning.snapshots (
  target_key text primary key,
  business_id bigint not null references public.businesses(id) on delete cascade,
  provider text not null,
  asset_id text not null,
  target jsonb not null,
  state jsonb not null,
  next_check_at bigint not null,
  updated_at timestamptz not null default now()
);
create index provisioning_snapshots_due on channel_provisioning.snapshots(provider, next_check_at);
create index provisioning_snapshots_asset on channel_provisioning.snapshots(provider, asset_id);
create table channel_provisioning.creation_intents (
  key text primary key,
  resource_key text not null,
  intent jsonb not null,
  updated_at timestamptz not null default now()
);
alter table channel_provisioning.leases enable row level security;
alter table channel_provisioning.snapshots enable row level security;
alter table channel_provisioning.creation_intents enable row level security;
revoke all on all tables in schema channel_provisioning from public, anon, authenticated;
grant select, insert, update, delete on all tables in schema channel_provisioning to service_role;

create function public.channel_provisioning_store(p_operation text, p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_target jsonb := p_payload->'target';
  v_state jsonb := p_payload->'state';
  v_lease jsonb := p_payload->'lease';
  v_intent jsonb;
  v_current jsonb;
  v_key text;
  v_resource text;
  v_clock bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_claimed boolean := false;
begin
  -- EXECUTE is also revoked below. Invoker rights never bypass RLS.
  if current_user <> 'service_role' then raise exception 'provisioning_backend_only'; end if;
  if jsonb_typeof(p_payload) <> 'object' then raise exception 'provisioning_payload_invalid'; end if;

  if p_operation = 'acquire' then
    if p_payload->>'resource_key' is null or length(p_payload->>'resource_key') > 200 then
      raise exception 'provisioning_resource_invalid';
    end if;
    insert into channel_provisioning.leases as l(resource_key, owner, expires_at)
    values (p_payload->>'resource_key', (p_payload->>'owner')::uuid,
      clock_timestamp() + make_interval(secs => least(greatest((p_payload->>'ttl_ms')::integer, 1000), 180000) / 1000.0))
    on conflict(resource_key) do update set owner = excluded.owner, fence = gen_random_uuid(), expires_at = excluded.expires_at
    where l.expires_at <= clock_timestamp()
    returning jsonb_build_object('resource_key', resource_key, 'owner', owner::text, 'fence', fence::text) into v_current;
    return v_current;
  elsif p_operation = 'release' then
    delete from channel_provisioning.leases where resource_key = v_lease->>'resource_key'
      and owner = (v_lease->>'owner')::uuid and fence = (v_lease->>'fence')::uuid;
    return 'null'::jsonb;
  end if;

  if p_operation in ('renew', 'save', 'claim', 'settle') then
    -- Row lock and fence enforce ownership atomically for the entire RPC.
    perform 1 from channel_provisioning.leases where resource_key = v_lease->>'resource_key'
      and owner = (v_lease->>'owner')::uuid and fence = (v_lease->>'fence')::uuid
      and expires_at > clock_timestamp() for update;
    if not found then
      if p_operation = 'renew' then return 'false'::jsonb; end if;
      raise exception 'provisioning_lease_lost';
    end if;
    v_resource := v_lease->>'resource_key';
  end if;
  if p_operation = 'renew' then
    update channel_provisioning.leases set expires_at = clock_timestamp() +
      make_interval(secs => least(greatest((p_payload->>'ttl_ms')::integer, 1000), 180000) / 1000.0)
    where resource_key = v_resource;
    return 'true'::jsonb;
  end if;

  if p_operation in ('load', 'save', 'queue') then
    if coalesce(v_target->>'provider', '') not in ('whatsapp', 'instagram', 'messenger', 'telegram', 'email')
      or coalesce(v_target->>'business_id', '') !~ '^[1-9][0-9]*$'
      or coalesce(v_target->>'asset_id', '') = '' or coalesce(v_target->>'identity_id', '') = ''
      or coalesce(v_target->>'app_id', '') = '' or coalesce(v_target->>'authorizing_user_id', '') = '' then
      raise exception 'provisioning_target_invalid';
    end if;
    v_key := jsonb_build_array(v_target->>'provider', (v_target->>'business_id')::bigint,
      v_target->>'asset_id', v_target->>'identity_id', v_target->>'app_id')::text;
    if p_operation = 'load' then
      select state into v_current from channel_provisioning.snapshots where target_key = v_key;
      return v_current;
    end if;
    if (p_operation = 'save' and v_resource <> (v_target->>'provider') || ':' || (v_target->>'asset_id'))
      or v_state->'target' is distinct from v_target
      or jsonb_typeof(v_state) is distinct from 'object'
      or jsonb_path_exists(v_state, '$.**.accessToken') or jsonb_path_exists(v_state, '$.**.access_token') then
      raise exception 'provisioning_snapshot_invalid';
    end if;
    -- Candidate mappings must remain bound to the same exact tenant/asset.
    if v_target->>'provider' = 'whatsapp' and exists (select 1 from jsonb_array_elements(coalesce(v_state->'mappings', '[]'::jsonb)) as m
      where m->>'business_id' is distinct from v_target->>'business_id'
        or m->>'waba_id' is distinct from v_target->>'asset_id'
        or m->>'phone_number_id' is distinct from v_target->>'identity_id') then
      raise exception 'provisioning_mapping_scope_invalid';
    end if;
    insert into channel_provisioning.snapshots as s(target_key, business_id, provider, asset_id, target, state, next_check_at)
    values(v_key, (v_target->>'business_id')::bigint, v_target->>'provider', v_target->>'asset_id', v_target, v_state,
      (v_state->>'next_check_at')::bigint)
    on conflict(target_key) do update set target = excluded.target,
      state = case when p_operation = 'queue' then s.state || jsonb_build_object(
        'target', excluded.target, 'readiness', excluded.state->'readiness', 'reasons', excluded.state->'reasons',
        'code', excluded.state->'code', 'next_check_at', excluded.state->'next_check_at',
        'mappings', '[]'::jsonb, 'mapping_ready', false, 'mappings_persisted', false) else excluded.state end,
      next_check_at = excluded.next_check_at, updated_at = clock_timestamp()
      where p_operation = 'queue' or (s.target->>'authorizing_user_id' = excluded.target->>'authorizing_user_id'
        and s.target->>'authorization_version' is not distinct from excluded.target->>'authorization_version');
    if not found then raise exception 'provisioning_snapshot_superseded'; end if;
    return 'null'::jsonb;
  elsif p_operation = 'targets_due' then
    select coalesce(jsonb_agg(s.target order by s.next_check_at), '[]'::jsonb) into v_current
    from (select target, next_check_at from channel_provisioning.snapshots
      where provider = p_payload->>'provider' and next_check_at <= v_clock
      order by next_check_at, target_key limit least(greatest((p_payload->>'limit')::integer, 1), 25)) as s;
    return v_current;
  elsif p_operation = 'targets_for_asset' then
    select coalesce(jsonb_agg(target order by target_key), '[]'::jsonb) into v_current
    from channel_provisioning.snapshots where provider = p_payload->>'provider' and asset_id = p_payload->>'asset_id';
    return v_current;
  elsif p_operation = 'intent' then
    select intent into v_current from channel_provisioning.creation_intents where key = p_payload->>'key';
    return v_current;
  elsif p_operation = 'claim' then
    v_key := p_payload->>'key';
    if v_key is null or left(v_key, length(v_resource) + 1) <> v_resource || ':' then raise exception 'provisioning_intent_scope_invalid'; end if;
    select intent into v_current from channel_provisioning.creation_intents where key = v_key for update;
    if not found or (v_current->>'state' = 'retryable' and (v_current->>'retry_at')::bigint <= v_clock) then
      v_current := jsonb_build_object('key', v_key, 'state', 'reserved', 'code', 'template_creation_unconfirmed',
        'asset_id', null, 'retry_at', null, 'provider_code', null);
      insert into channel_provisioning.creation_intents(key, resource_key, intent) values(v_key, v_resource, v_current)
      on conflict(key) do update set intent = excluded.intent, updated_at = clock_timestamp();
      v_claimed := true;
    end if;
    return jsonb_build_object('claimed', v_claimed, 'intent', v_current);
  elsif p_operation = 'settle' then
    v_intent := p_payload->'intent'; v_key := v_intent->>'key';
    if v_key is null or left(v_key, length(v_resource) + 1) <> v_resource || ':'
      or coalesce(v_intent->>'state', '') not in ('submitted', 'uncertain', 'retryable', 'failed') then
      raise exception 'provisioning_intent_invalid';
    end if;
    update channel_provisioning.creation_intents set intent = v_intent, updated_at = clock_timestamp()
      where key = v_key and resource_key = v_resource and intent->>'state' = 'reserved';
    if not found then raise exception 'provisioning_intent_unclaimed'; end if;
    return 'null'::jsonb;
  end if;
  raise exception 'provisioning_operation_invalid';
end;
$$;
revoke all on function public.channel_provisioning_store(text, jsonb) from public, anon, authenticated;
grant execute on function public.channel_provisioning_store(text, jsonb) to service_role;
commit;
