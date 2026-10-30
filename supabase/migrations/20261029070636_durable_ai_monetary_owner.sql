-- Unfunded, default-OFF monetary infrastructure. No policies/allowances are seeded.
-- Single shared provider account; no provider credentials or customer source text stored.
begin;
create schema ai_money;
revoke all on schema ai_money from public, anon, authenticated;

create function ai_money.amount(n numeric) returns bigint language plpgsql immutable strict
set search_path=pg_catalog as $$ begin
 if n<0 or n>9007199254740991 or n<>trunc(n) then raise exception 'ai_money_invalid_amount'; end if;
 return n::bigint;
end $$;
-- Allowances round DOWN; reservations/usage are already exact integer nanoUSD.
-- SEK source units are ore; rational is nanoUSD per ore, explicitly approved.
create function ai_money.allowance(currency text, units bigint, numerator bigint, denominator bigint, fx_ref text)
returns bigint language plpgsql immutable set search_path=pg_catalog as $$ begin
 if units is null or units<0 or numerator is null or denominator is null or numerator<=0 or denominator<=0 then
  raise exception 'ai_money_invalid_currency_policy'; end if;
 if currency='USD' and numerator=1 and denominator=1 and fx_ref='USD_IDENTITY' then return ai_money.amount(units); end if;
 if currency='SEK' and length(btrim(fx_ref))>0 then return ai_money.amount(floor(units::numeric*numerator/denominator)); end if;
 raise exception 'ai_money_unapproved_currency_policy';
end $$;

create table ai_money.operators (
 account_id text primary key check(length(btrim(account_id)) between 1 and 160),
 owner_id text not null, approval_ref text not null check(length(btrim(approval_ref))>0),
 provider_account_ref text not null unique check(provider_account_ref ~ '^proj_[A-Za-z0-9_-]+$'),
 rates_version text not null check(rates_version='openai-sol-standard-30m-2026-10-28'),
 billing_profile text not null check(billing_profile='openai-standard-nonregional-30m-v1'),
 input_bound_approved boolean not null default false,
 enabled boolean not null default false,
 valid_until timestamptz not null,
 monthly_nano_usd bigint not null check(monthly_nano_usd between 0 and 9007199254740991),
 emergency_nano_usd bigint not null check(emergency_nano_usd between 0 and 9007199254740991),
 request_nano_usd bigint not null check(request_nano_usd between 1 and 9007199254740991),
 turn_nano_usd bigint not null check(turn_nano_usd between request_nano_usd and 9007199254740991),
 warning_bps integer not null check(warning_bps between 1 and 10000)
);
create table ai_money.periods (
 account_id text not null references ai_money.operators,
 period_id text not null, starts_at timestamptz not null, ends_at timestamptz not null,
 primary key(account_id,period_id), check(ends_at>starts_at)
);
create table ai_money.plans (
 account_id text not null references ai_money.operators,
 plan_key text not null, revision text not null,
 approval_ref text not null check(length(btrim(approval_ref))>0), enabled boolean not null default false,
 currency text not null, source_units bigint not null,
 fx_numerator bigint not null, fx_denominator bigint not null, fx_ref text not null,
 allowance_nano_usd bigint not null,
 request_nano_usd bigint not null check(request_nano_usd between 1 and 9007199254740991),
 turn_nano_usd bigint not null check(turn_nano_usd between request_nano_usd and 9007199254740991),
 primary key(account_id,plan_key,revision),
 check(allowance_nano_usd=ai_money.allowance(currency,source_units,fx_numerator,fx_denominator,fx_ref))
);
-- An approved read-only projection of subscription entitlement, NOT a subscription
-- authority or checkout system. Must be populated/revoked by an approved owner.
-- A public/dashboard plan label is insufficient. No price/allowance inferred.
create table ai_money.entitlements (
 account_id text not null, business_id bigint not null references public.businesses(id) on delete cascade,
 period_id text not null, subscription_ref text not null check(length(btrim(subscription_ref))>0),
 source_revision text not null check(length(btrim(source_revision))>0),
 authority_ref text not null check(length(btrim(authority_ref))>0),
 status text not null check(status in ('active','suspended','revoked')),
 valid_from timestamptz not null, valid_until timestamptz not null check(valid_until>valid_from),
 plan_key text, plan_revision text,
 -- Optional independently approved tenant cap; cannot exceed a configured plan.
 tenant_nano_usd bigint check(tenant_nano_usd between 0 and 9007199254740991),
 primary key(account_id,business_id,period_id),
 foreign key(account_id,period_id) references ai_money.periods,
 foreign key(account_id,plan_key,plan_revision) references ai_money.plans,
 check((plan_key is null)=(plan_revision is null)),
 check(plan_key is not null or tenant_nano_usd is not null)
);
create index ai_money_entitlement_period on ai_money.entitlements(account_id,period_id);
create index ai_money_entitlement_plan on ai_money.entitlements(account_id,plan_key,plan_revision);
create index ai_money_entitlement_business on ai_money.entitlements(business_id);
create table ai_money.reservations (
 id uuid primary key default gen_random_uuid(), account_id text not null references ai_money.operators,
 business_id bigint not null check(business_id>0), -- retained pseudonymous financial identity; no customer source text
 period_id text not null, request_key text not null, turn_id text not null, stage text not null,
 reservation_key text not null, request_sha text not null, model text not null,
 quote jsonb not null, entitlement_snapshot jsonb not null,
 maximum_nano_usd bigint not null check(maximum_nano_usd between 1 and 9007199254740991),
 state text not null check(state in ('held','unknown','settled')),
 actual_nano_usd bigint check(actual_nano_usd>=0 and actual_nano_usd<=maximum_nano_usd),
 usage jsonb, provider_response_id text,
 created_at timestamptz not null default clock_timestamp(), settled_at timestamptz,
 unique(account_id,reservation_key), unique(account_id,business_id,request_key,stage),
 unique(account_id,provider_response_id),
 foreign key(account_id,period_id) references ai_money.periods,
 check((state='settled')=(actual_nano_usd is not null)),
 check((state='settled')=(usage is not null and provider_response_id is not null))
);
create index ai_money_reservation_business on ai_money.reservations(business_id);
create index ai_money_reservation_period on ai_money.reservations(account_id,period_id,business_id);
create index ai_money_reservation_unknown on ai_money.reservations(account_id,business_id) where state<>'settled';
-- Transactional aggregates avoid scanning account lifetime history on admission.
-- Ledger remains the authority; counters and ledger mutate in the same locked TX.
create table ai_money.counters (
 account_id text not null references ai_money.operators, bucket jsonb not null,
 known_nano_usd bigint not null default 0 check(known_nano_usd between 0 and 9007199254740991),
 held_nano_usd bigint not null default 0 check(held_nano_usd between 0 and 9007199254740991),
 primary key(account_id,bucket)
);
create function ai_money.counter_delta(a text,b bigint,p text,k text,known_delta bigint,held_delta bigint)
returns void language plpgsql set search_path=pg_catalog as $$
declare v jsonb; begin
 foreach v in array array[jsonb_build_array('account'),jsonb_build_array('period',p),jsonb_build_array('tenant',b),
  jsonb_build_array('tenant-period',b,p),jsonb_build_array('turn',b,k)] loop
  insert into ai_money.counters(account_id,bucket,known_nano_usd,held_nano_usd) values(a,v,0,0) on conflict do nothing;
  update ai_money.counters set known_nano_usd=known_nano_usd+known_delta,held_nano_usd=held_nano_usd+held_delta where account_id=a and bucket=v;
 end loop;
end $$;
create function ai_money.counter_value(a text,bucket_key jsonb,kind text) returns bigint language sql stable set search_path=pg_catalog as $$
 select coalesce((select case when kind='held' then held_nano_usd when kind='known' then known_nano_usd else known_nano_usd+held_nano_usd end
  from ai_money.counters where account_id=a and bucket=bucket_key),0);
$$;
create table ai_money.events (
 sequence bigint generated always as identity primary key,
 account_id text not null, reservation_id uuid, kind text not null,
 at timestamptz not null default clock_timestamp(), detail jsonb not null
);
create function ai_money.immutable_policy_revision() returns trigger language plpgsql set search_path=pg_catalog as $$ begin
 if tg_table_name='plans' and (to_jsonb(new)-'enabled')<>(to_jsonb(old)-'enabled') then
  raise exception 'ai_money_new_plan_revision_required';
 end if;
 if tg_table_name='periods' then
  if to_jsonb(new)<>to_jsonb(old) and exists(
   select 1 from ai_money.reservations where account_id=old.account_id and period_id=old.period_id) then
   raise exception 'ai_money_reserved_period_immutable';
  end if;
 end if;
 return new;
end $$;
create trigger plan_revision before update on ai_money.plans for each row execute function ai_money.immutable_policy_revision();
create trigger period_revision before update on ai_money.periods for each row execute function ai_money.immutable_policy_revision();
create function ai_money.append_only() returns trigger language plpgsql set search_path=pg_catalog as $$ begin
 raise exception 'ai_money_append_only'; end $$;
create trigger immutable_events before update or delete on ai_money.events for each row execute function ai_money.append_only();
-- Configuration changes are independently auditable; service_role cannot write policies.
create function ai_money.audit_policy() returns trigger language plpgsql security definer set search_path=pg_catalog as $$ begin
 perform 1 from ai_money.operators where account_id=coalesce(new.account_id,old.account_id) for update;
 insert into ai_money.events(account_id,kind,detail) values(coalesce(new.account_id,old.account_id),'policy_'||tg_op,
  jsonb_build_object('table',tg_table_name,'actor',session_user,'transaction',txid_current(),'before',case when tg_op<>'INSERT' then to_jsonb(old) else null end,
  'after',case when tg_op<>'DELETE' then to_jsonb(new) else null end));
 return coalesce(new,old);
end $$;
create trigger operator_audit after insert or update or delete on ai_money.operators for each row execute function ai_money.audit_policy();
create trigger plan_audit after insert or update or delete on ai_money.plans for each row execute function ai_money.audit_policy();
create trigger entitlement_audit after insert or update or delete on ai_money.entitlements for each row execute function ai_money.audit_policy();
create trigger period_audit after insert or update or delete on ai_money.periods for each row execute function ai_money.audit_policy();

-- One account-row lock serializes reserve/settle/unknown decisions across workers.
-- No unlocked read/update balance emulation; no automatic release/TTL on holds.
create function ai_money.transition(p_account text,p_approval text,p_command text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
 o ai_money.operators%rowtype; e ai_money.entitlements%rowtype; pl ai_money.plans%rowtype;
 r ai_money.reservations%rowtype; per ai_money.periods%rowtype;
 q jsonb:=p_payload->'quote'; u jsonb:=p_payload->'usage'; now_at timestamptz;
 b bigint; maximum bigint; tenant_cap bigint; request_cap bigint; turn_cap bigint;
 total numeric; monthly numeric; tenant_total numeric; turn_total numeric; cost bigint;
 i bigint; out_tokens bigint; cached bigint; writes bigint; reasoning bigint;
begin
 perform set_config('lock_timeout','1500ms',true);
 select * into o from ai_money.operators where account_id=p_account for update;
 if not found or (o.approval_ref<>p_approval and p_command not in ('settle','unknown')) then raise exception 'ai_money_authority_missing'; end if;
 now_at:=clock_timestamp();
 if p_command='configuration' then
  if not o.enabled or not o.input_bound_approved or o.valid_until<=now_at then return null; end if;
  return jsonb_build_object('ownerId',o.owner_id,'approvalReference',o.approval_ref,'ratesVersion',o.rates_version,
   'billingProfile',o.billing_profile,'providerProjectId',o.provider_account_ref,'maximumRequestNanoUsd',o.request_nano_usd,'maximumTurnNanoUsd',o.turn_nano_usd,
   'businessIds',coalesce((select jsonb_agg(distinct business_id) from ai_money.entitlements where account_id=p_account
    and status='active' and valid_from<=now_at and valid_until>now_at),'[]'::jsonb));
 end if;
 if p_command='status' then
  -- Administrative only. No customer API is exposed; business filter mandatory.
  b:=ai_money.amount((p_payload->>'businessId')::numeric);
  select * into per from ai_money.periods where account_id=p_account and starts_at<=now_at and ends_at>now_at;
  select * into e from ai_money.entitlements where account_id=p_account and business_id=b and period_id=per.period_id;
  select * into pl from ai_money.plans where account_id=p_account and plan_key=e.plan_key and revision=e.plan_revision;
  tenant_cap:=case when e.status='active' and e.valid_from<=now_at and e.valid_until>now_at then
   case when e.plan_key is null then e.tenant_nano_usd when pl.enabled then least(coalesce(e.tenant_nano_usd,pl.allowance_nano_usd),pl.allowance_nano_usd) end end;
  select coalesce(sum(coalesce(actual_nano_usd,maximum_nano_usd)),0),
   coalesce(sum(coalesce(actual_nano_usd,maximum_nano_usd)) filter(where period_id=per.period_id or state<>'settled'),0),
   coalesce(sum(coalesce(actual_nano_usd,maximum_nano_usd)) filter(where business_id=b and (period_id=per.period_id or state<>'settled')),0)
   into total,monthly,tenant_total from ai_money.reservations where account_id=p_account;
  return jsonb_build_object('enabled',o.enabled,'currency','USD','warningBps',o.warning_bps,
   'periodId',per.period_id,'operatorExposureNanoUsd',total,'operatorEmergencyLimitNanoUsd',o.emergency_nano_usd,
   'operatorMonthlyExposureNanoUsd',monthly,'operatorMonthlyLimitNanoUsd',o.monthly_nano_usd,
   'tenantExposureNanoUsd',tenant_total,'tenantPeriodAllowanceNanoUsd',tenant_cap,
   'operatorWarning',total*10000>=o.emergency_nano_usd::numeric*o.warning_bps or monthly*10000>=o.monthly_nano_usd::numeric*o.warning_bps,
   'tenantWarning',tenant_cap is not null and tenant_total*10000>=tenant_cap::numeric*o.warning_bps,
   'unknownCount',(select count(*) from ai_money.reservations where account_id=p_account and business_id=b and state<>'settled'));
 end if;
 if q is null or jsonb_typeof(q)<>'object' or q->>'approvalReference'<>p_approval
  or q->>'ratesVersion'<>'openai-sol-standard-30m-2026-10-28'
  or (p_command='reserve' and (q->>'ownerId'<>o.owner_id or q->>'ratesVersion'<>o.rates_version or q->>'providerProjectId' is distinct from o.provider_account_ref)) or q->>'model'<>'gpt-6.1-sol'
  or q->>'stage' not in ('extraction','verification')
  or not(q->>'requestKey' ~ '^[a-f0-9]{64}$') or not(q->>'requestSha256' ~ '^[a-f0-9]{64}$')
  or not(q->>'reservationKey' ~ '^[a-f0-9]{64}$') or length(q->>'turnId') not between 1 and 200
  or not(q ?& array['ownerId','approvalReference','ratesVersion','model','stage','businessId','requestKey','requestSha256',
   'reservationKey','turnId','inputTokenProxy','outputTokenLimit','maximumNanoUsd','maximumRequestNanoUsd','maximumTurnNanoUsd'])
  or exists(select 1 from unnest(array['ownerId','approvalReference','ratesVersion','model','stage','requestKey','requestSha256','reservationKey','turnId']) k
   where jsonb_typeof(q->k) is distinct from 'string')
  or exists(select 1 from unnest(array['businessId','inputTokenProxy','outputTokenLimit','maximumNanoUsd','maximumRequestNanoUsd','maximumTurnNanoUsd']) k
   where jsonb_typeof(q->k) is distinct from 'number')
 then raise exception 'ai_money_quote_identity'; end if;
 b:=ai_money.amount((q->>'businessId')::numeric);
 maximum:=ai_money.amount((q->>'maximumNanoUsd')::numeric);
 if b<=0 or maximum<=0 or ai_money.amount((q->>'outputTokenLimit')::numeric)<>8192
  or ai_money.amount((q->>'inputTokenProxy')::numeric)>272000
  or maximum<>ai_money.amount((q->>'inputTokenProxy')::numeric)*2500+8192*10000
 then raise exception 'ai_money_quote_envelope'; end if;
 select * into r from ai_money.reservations where account_id=p_account and reservation_key=q->>'reservationKey' for update;
 if p_command='reserve' then
  if found then return null; end if; -- Never re-issue a dispatch permit, even settled.
  if not o.enabled or not o.input_bound_approved or o.valid_until<=now_at then return null; end if;
  if (select count(*) from ai_money.periods where account_id=p_account and starts_at<=now_at and ends_at>now_at)<>1 then return null; end if;
  select * into per from ai_money.periods where account_id=p_account and starts_at<=now_at and ends_at>now_at for share;
  select * into e from ai_money.entitlements where account_id=p_account and business_id=b and period_id=per.period_id for share;
  if not found or e.status<>'active' or e.valid_from>now_at or e.valid_until<=now_at then return null; end if;
  tenant_cap:=e.tenant_nano_usd; request_cap:=o.request_nano_usd; turn_cap:=o.turn_nano_usd;
  if e.plan_key is not null then
   select * into pl from ai_money.plans where account_id=p_account and plan_key=e.plan_key and revision=e.plan_revision for share;
   if not found or not pl.enabled then return null; end if;
   tenant_cap:=least(coalesce(tenant_cap,pl.allowance_nano_usd),pl.allowance_nano_usd);
   request_cap:=least(request_cap,pl.request_nano_usd); turn_cap:=least(turn_cap,pl.turn_nano_usd);
  end if;
  if tenant_cap is null then return null; end if;
  if maximum>least(request_cap,ai_money.amount((q->>'maximumRequestNanoUsd')::numeric)) then return jsonb_build_object('denied','budget_exhausted'); end if;
  if exists(select 1 from ai_money.reservations where account_id=p_account and business_id=b and request_key=q->>'requestKey' and stage=q->>'stage') then return null; end if;
  -- A turn cannot silently switch financial entitlement/period mid-flight.
  if exists(select 1 from ai_money.reservations where account_id=p_account and business_id=b and request_key=q->>'requestKey'
   and (period_id<>per.period_id or entitlement_snapshot->'entitlement'<>to_jsonb(e) or entitlement_snapshot->'plan'<>to_jsonb(pl))) then return null; end if;
  total:=ai_money.counter_value(p_account,jsonb_build_array('account'),'total');
  monthly:=ai_money.counter_value(p_account,jsonb_build_array('period',per.period_id),'known')+
   ai_money.counter_value(p_account,jsonb_build_array('account'),'held');
  tenant_total:=ai_money.counter_value(p_account,jsonb_build_array('tenant-period',b,per.period_id),'known')+
   ai_money.counter_value(p_account,jsonb_build_array('tenant',b),'held');
  turn_total:=ai_money.counter_value(p_account,jsonb_build_array('turn',b,q->>'requestKey'),'total');
  if total+maximum>o.emergency_nano_usd or monthly+maximum>o.monthly_nano_usd or tenant_total+maximum>tenant_cap
   or turn_total+maximum>least(turn_cap,ai_money.amount((q->>'maximumTurnNanoUsd')::numeric)) then return jsonb_build_object('denied','budget_exhausted'); end if;
  insert into ai_money.reservations(account_id,business_id,period_id,request_key,turn_id,stage,reservation_key,request_sha,model,quote,
   entitlement_snapshot,maximum_nano_usd,state) values(p_account,b,per.period_id,q->>'requestKey',q->>'turnId',q->>'stage',q->>'reservationKey',
   q->>'requestSha256',q->>'model',q,jsonb_build_object('entitlement',to_jsonb(e),'plan',to_jsonb(pl),'operator',to_jsonb(o)),maximum,'held') returning * into r;
  perform ai_money.counter_delta(p_account,b,per.period_id,q->>'requestKey',0,maximum);
  insert into ai_money.events(account_id,reservation_id,kind,detail) values(p_account,r.id,'reserved',jsonb_build_object('maximumNanoUsd',maximum));
  return jsonb_build_object('id',r.id,'reservationKey',r.reservation_key,'maximumNanoUsd',r.maximum_nano_usd);
 end if;
 if not found then
  if p_command='unknown' then return null; end if;
  raise exception 'ai_money_reservation_missing';
 end if;
 if r.quote<>q or (p_payload->>'id' is not null and r.id::text<>p_payload->>'id') then raise exception 'ai_money_reservation_identity'; end if;
 if p_command='unknown' then
  if r.state<>'settled' then
   update ai_money.reservations set state='unknown' where id=r.id;
   insert into ai_money.events(account_id,reservation_id,kind,detail) values(p_account,r.id,'unknown','{}');
  end if;
  return null;
 end if;
 if p_command<>'settle' then raise exception 'ai_money_invalid_command'; end if;
 if r.state='settled' then
  if r.usage<>u then raise exception 'ai_money_settlement_conflict'; end if;
  return jsonb_build_object('settled',true);
 end if;
 if u is null or jsonb_typeof(u)<>'object' or not(u ?& array['model','ownerId','ratesVersion','requestSha256','inputTokens','outputTokens','reasoningTokens','cachedTokens','cacheWriteTokens','estimatedNanoUsd','providerResponseId'])
  or u->>'model'<>r.model or u->>'ownerId'<>q->>'ownerId' or u->>'ratesVersion'<>q->>'ratesVersion'
  or u->>'providerProjectId' is distinct from q->>'providerProjectId' or u->>'requestSha256'<>r.request_sha or not(u->>'providerResponseId' ~ '^resp_[A-Za-z0-9_-]+$')
  or exists(select 1 from unnest(array['model','ownerId','ratesVersion','requestSha256','providerResponseId','providerProjectId']) k
   where jsonb_typeof(u->k) is distinct from 'string')
  or exists(select 1 from unnest(array['inputTokens','outputTokens','reasoningTokens','cachedTokens','cacheWriteTokens','estimatedNanoUsd']) k
   where jsonb_typeof(u->k) is distinct from 'number')
 then raise exception 'ai_money_receipt_identity'; end if;
 i:=ai_money.amount((u->>'inputTokens')::numeric); out_tokens:=ai_money.amount((u->>'outputTokens')::numeric);
 cached:=ai_money.amount((u->>'cachedTokens')::numeric); writes:=ai_money.amount((u->>'cacheWriteTokens')::numeric);
 reasoning:=ai_money.amount((u->>'reasoningTokens')::numeric);
 if i>(q->>'inputTokenProxy')::bigint or out_tokens>8192 or cached+writes>i or reasoning>out_tokens then raise exception 'ai_money_receipt_bounds'; end if;
 cost:=ai_money.amount((i-cached-writes)::numeric*2000+cached::numeric*100+writes::numeric*2500+out_tokens::numeric*10000);
 if cost>maximum or cost<>ai_money.amount((u->>'estimatedNanoUsd')::numeric) then raise exception 'ai_money_receipt_cost'; end if;
 update ai_money.reservations set state='settled',actual_nano_usd=cost,usage=u,provider_response_id=u->>'providerResponseId',settled_at=clock_timestamp() where id=r.id;
 perform ai_money.counter_delta(p_account,b,r.period_id,r.request_key,cost,-maximum);
 insert into ai_money.events(account_id,reservation_id,kind,detail) values(p_account,r.id,'settled',jsonb_build_object('actualNanoUsd',cost,'releasedNanoUsd',maximum-cost));
 return jsonb_build_object('settled',true);
end $$;

-- RPC exposed only to the privileged backend. Financial authority/configuration
-- tables cannot be mutated by application/tenant roles. Private definer implementation.
create function public.odin_ai_money_v1(p_account text,p_approval text,p_command text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$ begin
 if current_user<>'service_role' then raise exception 'ai_money_backend_only'; end if;
 return ai_money.transition(p_account,p_approval,p_command,p_payload);
end $$;
revoke all on all tables in schema ai_money from public,anon,authenticated,service_role;
revoke all on all sequences in schema ai_money from public,anon,authenticated,service_role;
revoke all on all functions in schema ai_money from public,anon,authenticated,service_role;
revoke all on function public.odin_ai_money_v1(text,text,text,jsonb) from public,anon,authenticated;
grant usage on schema ai_money to service_role;
grant execute on function ai_money.transition(text,text,text,jsonb) to service_role;
grant execute on function public.odin_ai_money_v1(text,text,text,jsonb) to service_role;
alter table ai_money.operators enable row level security;
alter table ai_money.periods enable row level security;
alter table ai_money.plans enable row level security;
alter table ai_money.entitlements enable row level security;
alter table ai_money.reservations enable row level security;
alter table ai_money.events enable row level security;
alter table ai_money.counters enable row level security;
commit;
