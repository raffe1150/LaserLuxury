-- Prepared only. Service-role-only atomic publication; no backfill or activation.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table channel_provisioning.reminder_publications (
  business_id bigint primary key references public.businesses(id) on delete cascade,
  target_key text not null,
  waba_id text not null,
  phone_number_id text not null,
  authorization_version text not null,
  fingerprint text not null,
  version bigint not null check (version > 0),
  reconciled_at timestamptz not null,
  published_at timestamptz not null default clock_timestamp()
);
alter table channel_provisioning.reminder_publications enable row level security;
revoke all on channel_provisioning.reminder_publications from public, anon, authenticated;
grant select, insert, update, delete on channel_provisioning.reminder_publications to service_role;

create function public.whatsapp_reminder_mapping_boundary(p_operation text, p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path = '' set lock_timeout = '5s' set timezone = 'UTC' as $$
declare
  v_state jsonb := p_payload->'state';
  v_target jsonb := coalesce(p_payload->'target', p_payload->'state'->'target');
  v_readiness jsonb := v_state->'readiness';
  v_connection public.channel_connections%rowtype;
  v_snapshot channel_provisioning.snapshots%rowtype;
  v_publication channel_provisioning.reminder_publications%rowtype;
  v_business_id bigint;
  v_key text;
  v_authorization_version text;
  v_fingerprint text;
  v_version bigint;
  v_checked timestamptz;
  v_template jsonb;
  v_expected jsonb;
  v_mappings jsonb;
  v_existing jsonb;
  v_receipt jsonb;
  v_supported boolean;
  v_delivery boolean;
  v_current boolean;
begin
  if current_user <> 'service_role' then raise exception 'provisioning_backend_only'; end if;
  -- The catalog probe is read-only. A missing mapping column or any durable
  -- storage prevents both template writes and publication in the application.
  select exists (select 1 from pg_catalog.pg_attribute where attrelid = 'public.businesses'::regclass
      and attname = 'whatsapp_reminder_templates' and atttypid = 'jsonb'::regtype and not attisdropped)
    and to_regclass('channel_provisioning.leases') is not null
    and to_regclass('channel_provisioning.snapshots') is not null
    and to_regclass('channel_provisioning.creation_intents') is not null
    and to_regclass('channel_provisioning.reminder_publications') is not null
    and to_regprocedure('public.channel_provisioning_store(text,jsonb)') is not null
    and has_function_privilege(current_user, to_regprocedure('public.channel_provisioning_store(text,jsonb)'), 'execute')
    and has_table_privilege(current_user, 'public.businesses', 'SELECT')
    and has_table_privilege(current_user, 'public.businesses', 'UPDATE')
    and has_table_privilege(current_user, 'public.channel_connections', 'SELECT')
    and has_table_privilege(current_user, 'public.channel_connections', 'UPDATE')
    and not exists (select 1 from (values('leases'),('snapshots'),('creation_intents'),('reminder_publications')) as required(name)
      left join pg_catalog.pg_class c on c.oid = to_regclass('channel_provisioning.' || required.name)
      where c.oid is null or not c.relrowsecurity
        or exists (select 1 from unnest(array['SELECT','INSERT','UPDATE','DELETE']) as privilege
          where not has_table_privilege(current_user, c.oid, privilege))) into v_supported;
  if p_operation = 'gate' then return jsonb_build_object('supported', v_supported, 'protocol_version', 1); end if;
  if not v_supported then return jsonb_build_object('code', 'provisioning_schema_missing', 'published', false, 'ready', false, 'delivery_ready', false); end if;
  if p_operation = 'publish' and p_payload->'enabled' is distinct from 'true'::jsonb then
    return jsonb_build_object('code', 'provisioning_rollout_disabled', 'published', false, 'ready', false, 'delivery_ready', false);
  end if;
  if v_target->>'provider' is distinct from 'whatsapp' or coalesce(v_target->>'business_id', '') !~ '^[1-9][0-9]*$'
    or coalesce(v_target->>'asset_id', '') !~ '^[0-9]+$' or coalesce(v_target->>'identity_id', '') !~ '^[0-9]+$'
    or coalesce(v_target->>'app_id', '') = '' or coalesce(v_target->>'authorizing_user_id', '') = '' then
    return jsonb_build_object('code', 'provisioning_connection_changed', 'published', false, 'ready', false, 'delivery_ready', false);
  end if;
  v_business_id := (v_target->>'business_id')::bigint;
  v_key := jsonb_build_array('whatsapp', v_business_id, v_target->>'asset_id', v_target->>'identity_id', v_target->>'app_id')::text;
  -- A publication locks the current authoritative connection before reading its
  -- identity/credential revision. Reconnects and credential rotations serialize
  -- with this transaction; ordinary binding/current probes do not take locks.
  if p_operation = 'publish' then
    select * into v_connection from public.channel_connections
      where business_id = v_business_id and provider = 'whatsapp' for update;
  else
    select * into v_connection from public.channel_connections
      where business_id = v_business_id and provider = 'whatsapp';
  end if;
  if not found or v_connection.status <> 'connected' or v_connection.reconnect_required
    or v_connection.provider_connection_id is distinct from v_target->>'asset_id'
    or v_connection.provider_account_id is distinct from v_target->>'identity_id'
    or v_connection.metadata->>'whatsapp_provisioning_app_id' is distinct from v_target->>'app_id'
    or v_connection.metadata->>'authorizing_odinlink_user_id' is distinct from v_target->>'authorizing_user_id'
    or v_connection.connected_at is null or coalesce(v_connection.credential_ciphertext, '') = ''
    or v_connection.token_expires_at <= clock_timestamp() then
    return jsonb_build_object('code', 'provisioning_connection_changed', 'published', false, 'ready', false, 'delivery_ready', false);
  end if;
  -- Hash only the encrypted credential envelope and authorization identity.
  -- No token, ciphertext, or reversible credential material leaves this RPC.
  v_authorization_version := encode(sha256(convert_to(jsonb_build_array(v_connection.id,
    v_connection.credential_ciphertext, v_connection.credential_key_id, v_connection.connected_at,
    v_connection.token_expires_at, v_connection.granted_scopes,
    v_connection.metadata->>'whatsapp_provisioning_app_id', v_connection.metadata->>'authorizing_odinlink_user_id')::text, 'UTF8')), 'hex');
  if p_operation = 'binding' then return jsonb_build_object('authorization_version', v_authorization_version); end if;
  if v_target->>'authorization_version' is distinct from v_authorization_version then
    return jsonb_build_object('code', 'provisioning_connection_changed', 'published', false, 'ready', false, 'delivery_ready', false);
  end if;
  if p_operation = 'current' then
    select * into v_publication from channel_provisioning.reminder_publications where business_id = v_business_id;
    select whatsapp_reminder_templates into v_existing from public.businesses where id = v_business_id;
    select * into v_snapshot from channel_provisioning.snapshots where target_key = v_key;
    v_current := coalesce(v_publication.target_key = v_key and v_publication.authorization_version = v_authorization_version
      and v_snapshot.target = v_target and v_snapshot.state->'mapping_ready' = 'true'::jsonb
      and v_snapshot.state->'mappings_persisted' = 'true'::jsonb and v_existing = v_snapshot.state->'mappings'
      and v_publication.fingerprint = encode(sha256(convert_to(v_existing::text, 'UTF8')), 'hex')
      and v_snapshot.next_check_at + 60000 >= floor(extract(epoch from clock_timestamp()) * 1000), false);
    return jsonb_build_object('current', v_current);
  end if;
  if p_operation <> 'publish' then raise exception 'provisioning_operation_invalid'; end if;
  -- The business row and snapshot serialize concurrent publishers. A webhook,
  -- queue replacement or newer reconciliation cannot be overwritten by a stale
  -- candidate. Publication bookkeeping alone is excluded for repeat callers.
  select whatsapp_reminder_templates into v_existing from public.businesses where id = v_business_id for update;
  if not found then return jsonb_build_object('code', 'provisioning_connection_changed', 'published', false, 'ready', false, 'delivery_ready', false); end if;
  select * into v_snapshot from channel_provisioning.snapshots where target_key = v_key for update;
  if not found or v_snapshot.target is distinct from v_target then
    return jsonb_build_object('code', 'provisioning_connection_changed', 'published', false, 'ready', false, 'delivery_ready', false);
  end if;
  if (v_snapshot.state - 'publication' - 'mappings_persisted') is distinct from (v_state - 'publication' - 'mappings_persisted') then
    return jsonb_build_object('code', 'template_reconciliation_unverified', 'published', false, 'ready', false, 'delivery_ready', false);
  end if;
  if v_readiness->>'provider' is distinct from 'whatsapp' or v_readiness->>'business_id' is distinct from v_target->>'business_id'
    or v_readiness->'asset'->>'waba_id' is distinct from v_target->>'asset_id'
    or v_readiness->'asset'->>'phone_number_id' is distinct from v_target->>'identity_id'
    or v_readiness->'asset'->'phone_belongs_to_waba' is distinct from 'true'::jsonb
    or v_readiness->'authorization'->>'app_id' is distinct from v_target->>'app_id'
    or v_readiness->'connection_ready' is distinct from 'true'::jsonb
    or v_readiness->'provisioning_ready' is distinct from 'true'::jsonb
    or v_readiness->'authorization'->'token_valid' is distinct from 'true'::jsonb
    or v_readiness->'authorization'->'management_access_sufficient' is distinct from 'true'::jsonb
    or not coalesce(v_readiness->'authorization'->'waba_tasks' @> '["MANAGE"]'::jsonb, false)
    or not coalesce(v_readiness->'authorization'->'effective_scopes' @> '["business_management","whatsapp_business_management","whatsapp_business_messaging"]'::jsonb, false) then
    return jsonb_build_object('code', 'provisioning_preflight_blocked', 'published', false, 'ready', false, 'delivery_ready', false);
  end if;
  v_checked := (v_readiness->>'checked_at')::timestamptz;
  if v_checked is null or v_checked < clock_timestamp() - interval '180 seconds' or v_checked > clock_timestamp() + interval '5 seconds'
    or exists (select 1 from (values(v_readiness->'authorization'->>'expires_at'),(v_readiness->'authorization'->>'data_access_expires_at')) as e(expiry)
      where expiry is not null and expiry::numeric <> 0 and expiry::numeric <= extract(epoch from clock_timestamp())) then
    return jsonb_build_object('code', 'template_reconciliation_unverified', 'published', false, 'ready', false, 'delivery_ready', false);
  end if;
  v_mappings := v_state->'mappings';
  if v_state->'mapping_ready' is distinct from 'true'::jsonb or v_readiness->'reminder_ready' is distinct from 'true'::jsonb
    or jsonb_typeof(v_state->'templates') is distinct from 'array' or jsonb_array_length(v_state->'templates') <> 6
    or jsonb_typeof(v_readiness->'templates') is distinct from 'array' or jsonb_array_length(v_readiness->'templates') <> 6
    or jsonb_typeof(v_mappings) is distinct from 'array' or jsonb_array_length(v_mappings) <> 12 then
    return jsonb_build_object('code', 'reminder_mapping_bundle_invalid', 'published', false, 'ready', false, 'delivery_ready', false);
  end if;
  for v_template in select value from jsonb_array_elements(v_state->'templates') loop
    if v_template->>'name' is distinct from 'appointment_reminder' or v_template->>'status' is distinct from 'APPROVED'
      or v_template->>'category' is distinct from 'UTILITY' or v_template->>'parameter_format' is distinct from 'POSITIONAL'
      or v_template->>'state' is distinct from 'approved_compatible'
      or v_template->'canonical_compatible' is distinct from 'true'::jsonb or v_template->'component_compatible' is distinct from 'true'::jsonb
      or coalesce(v_template->>'template_id', '') !~ '^[0-9]+$'
      or (select count(*) from jsonb_array_elements(v_state->'templates') as t where t->>'template_id' = v_template->>'template_id') <> 1
      or (select count(*) from jsonb_array_elements(v_state->'templates') as t where t->>'language_code' = v_template->>'language_code') <> 1
      or (select count(*) from jsonb_array_elements(v_readiness->'templates') as t where t->>'booking_language' = v_template->>'language_code'
        and t->>'language_code' = v_template->>'language_code' and t->>'template_id' = v_template->>'template_id'
        and t->>'status' = 'APPROVED' and t->>'state' = 'approved_compatible') <> 1 then
      return jsonb_build_object('code', 'reminder_mapping_bundle_invalid', 'published', false, 'ready', false, 'delivery_ready', false);
    end if;
    if v_template->>'last_checked_at' is null or (v_template->>'last_checked_at')::timestamptz < clock_timestamp() - interval '180 seconds'
      or (v_template->>'last_checked_at')::timestamptz > clock_timestamp() + interval '5 seconds'
      or (v_template->>'last_provider_event_at')::timestamptz > (v_template->>'last_checked_at')::timestamptz then
      return jsonb_build_object('code', 'template_reconciliation_unverified', 'published', false, 'ready', false, 'delivery_ready', false);
    end if;
  end loop;
  select jsonb_agg(jsonb_build_object('business_id', v_business_id::text, 'waba_id', v_target->>'asset_id',
    'phone_number_id', v_target->>'identity_id', 'reminder_type', r.kind, 'booking_language', l.lang,
    'template_id', t->>'template_id', 'name', 'appointment_reminder', 'language_code', l.lang,
    'body_parameters', '["customer_name","service","date","time","business_name"]'::jsonb) order by r.ordinal, l.ordinal)
    into v_expected from (values('24h',1),('2h',2)) as r(kind,ordinal)
    cross join (values('en',1),('sv',2),('de',3),('es',4),('fa',5),('ar',6)) as l(lang,ordinal)
    join jsonb_array_elements(v_state->'templates') as t on t->>'language_code' = l.lang;
  if v_expected is distinct from v_mappings or jsonb_array_length(v_expected) <> 12 then
    return jsonb_build_object('code', 'reminder_mapping_bundle_invalid', 'published', false, 'ready', false, 'delivery_ready', false);
  end if;
  v_fingerprint := encode(sha256(convert_to(v_mappings::text, 'UTF8')), 'hex');
  select * into v_publication from channel_provisioning.reminder_publications where business_id = v_business_id for update;
  v_version := case when v_publication.fingerprint = v_fingerprint and v_publication.authorization_version = v_authorization_version
    then v_publication.version else coalesce(v_publication.version, 0) + 1 end;
  -- Configuration readiness never upgrades delivery. Limited verification or
  -- sending health conservatively keeps automated activation unready.
  v_delivery := coalesce(v_readiness->'delivery_ready' = 'true'::jsonb, false)
    and v_readiness->'waba'->'payment_blocked' = 'false'::jsonb
    and v_readiness->'waba'->'business_verification_limited' = 'false'::jsonb
    and v_readiness->'waba'->>'sending_health' = 'AVAILABLE'
    and v_readiness->'phone'->'health'->>'can_send_message' = 'AVAILABLE'
    and not exists (select 1 from jsonb_array_elements(v_readiness->'reasons') as reason
      where reason->>'code' in ('sending_health_limited', 'sending_health_blocked', 'sending_health_unverified'));
  v_receipt := jsonb_build_object('code', case when v_existing = v_mappings then 'reminder_mappings_already_current' else 'reminder_mappings_published' end,
    'published', true, 'fingerprint', v_fingerprint, 'version', v_version, 'reconciled_at', v_checked,
    'reminder_ready', true, 'delivery_ready', coalesce(v_delivery, false), 'ready', coalesce(v_delivery, false));
  if v_existing is distinct from v_mappings then
    update public.businesses set whatsapp_reminder_templates = v_mappings where id = v_business_id;
  end if;
  insert into channel_provisioning.reminder_publications as p(business_id, target_key, waba_id, phone_number_id,
    authorization_version, fingerprint, version, reconciled_at)
  values(v_business_id, v_key, v_target->>'asset_id', v_target->>'identity_id', v_authorization_version, v_fingerprint, v_version, v_checked)
  on conflict(business_id) do update set target_key = excluded.target_key, waba_id = excluded.waba_id,
    phone_number_id = excluded.phone_number_id, authorization_version = excluded.authorization_version,
    fingerprint = excluded.fingerprint, version = excluded.version, reconciled_at = excluded.reconciled_at,
    published_at = case when p.version <> excluded.version then clock_timestamp() else p.published_at end
    where (p.target_key, p.authorization_version, p.fingerprint, p.reconciled_at) is distinct from
      (excluded.target_key, excluded.authorization_version, excluded.fingerprint, excluded.reconciled_at);
  update channel_provisioning.snapshots set state = state || jsonb_build_object('mappings_persisted', true,
    'publication', v_receipt - 'code' - 'published' - 'reminder_ready' - 'delivery_ready' - 'ready')
    where target_key = v_key and (state->'mappings_persisted' is distinct from 'true'::jsonb
      or state->'publication' is distinct from (v_receipt - 'code' - 'published' - 'reminder_ready' - 'delivery_ready' - 'ready'));
  return v_receipt;
end;
$$;
revoke all on function public.whatsapp_reminder_mapping_boundary(text,jsonb) from public, anon, authenticated;
grant execute on function public.whatsapp_reminder_mapping_boundary(text,jsonb) to service_role;
commit;
