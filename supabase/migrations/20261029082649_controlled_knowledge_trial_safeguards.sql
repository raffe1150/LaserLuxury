-- Additive default-OFF controlled trial. No grants, identities, funds or cases seeded.
-- Reuses the v1 monetary ledger/counters; does not alter commercial subscriptions.
begin;
alter table ai_money.operators add column trial_only boolean not null default false;
alter table ai_money.operators add column trial_rates_version text
 check(trial_rates_version is null or trial_rates_version='controlled-trial-standard-20261029');
alter table ai_money.reservations add column trial_id text;
alter table ai_money.reservations add column trial_case_id text;
create table ai_money.trials (
 id text primary key,account_id text not null references ai_money.operators,
 business_id bigint not null references public.businesses(id) on delete cascade,
 approval_ref text not null check(length(btrim(approval_ref))>0),enabled boolean not null default false,
 valid_from timestamptz not null,valid_until timestamptz not null check(valid_until>valid_from),
 maximum_native_cases integer not null check(maximum_native_cases between 1 and 1000),
 maximum_index_cases integer not null check(maximum_index_cases between 0 and 100),
 unique(account_id,business_id)
);
create table ai_money.trial_identities (
 trial_id text not null references ai_money.trials on delete restrict,
 channel text not null check(channel in ('telegram','whatsapp','messenger','instagram')),
 account text not null check(length(account) between 1 and 200),sender text not null check(length(sender) between 1 and 200),
 recipient text not null check(length(recipient) between 1 and 200),enabled boolean not null default false,
 primary key(trial_id,channel,account,sender,recipient)
);
create table ai_money.trial_cases (
 trial_id text not null references ai_money.trials on delete restrict,id text not null,
 kind text not null check(kind in ('knowledge','source_index')),enabled boolean not null default false,
 human_approval_ref text not null check(length(btrim(human_approval_ref))>0),
 channel text,account text,sender text,recipient text,question_sha256 text,
 inventory_token text,expected_chunks integer,
 source_id uuid,source_revision text,source_request_sha256 text,
 stage_caps jsonb not null check(jsonb_typeof(stage_caps)='object'),
 state text not null default 'pending' check(state in ('pending','claimed')),
 lease_token uuid,event_key text,claimed_at timestamptz,send_started boolean not null default false,
 primary key(trial_id,id),unique(trial_id,event_key),
 foreign key(trial_id,channel,account,sender,recipient) references ai_money.trial_identities,
 check((state='claimed')=(lease_token is not null and event_key is not null and claimed_at is not null)),
 check((kind='knowledge' and channel is not null and account is not null and sender is not null and recipient is not null
  and question_sha256 is not null and inventory_token is not null and expected_chunks is not null
  and question_sha256 ~ '^[a-f0-9]{64}$' and inventory_token ~ '^[a-f0-9]{64}$' and expected_chunks>0
  and source_id is null and source_revision is null and source_request_sha256 is null)
 or (kind='source_index' and source_id is not null and source_revision is not null and source_request_sha256 is not null and source_revision ~ '^[a-f0-9]{64}$'
  and source_request_sha256 ~ '^[a-f0-9]{64}$' and channel is null and account is null and sender is null and recipient is null
  and question_sha256 is null and inventory_token is null and expected_chunks is null))
);
alter table ai_money.reservations add foreign key(trial_id,trial_case_id) references ai_money.trial_cases;
create index trial_cases_identity on ai_money.trial_cases(trial_id,channel,account,sender,recipient);
create index trial_cases_source on ai_money.trial_cases(source_id) where source_id is not null;
create index trial_business on ai_money.trials(business_id);
create index reservation_trial on ai_money.reservations(trial_id,trial_case_id);
create function ai_money.trial_immutable() returns trigger language plpgsql set search_path=pg_catalog as $$ begin
 if tg_table_name='trial_cases' then
  if old.send_started and not new.send_started then raise exception 'ai_trial_send_claim_immutable'; end if;
  if old.state='claimed' and (to_jsonb(new)-array['enabled','send_started'])<>(to_jsonb(old)-array['enabled','send_started']) then
   raise exception 'ai_trial_consumed_case_immutable'; end if;
 elsif (to_jsonb(new)-'enabled')<>(to_jsonb(old)-'enabled') and exists(select 1 from ai_money.trial_cases where trial_id=old.id and state='claimed') then
  raise exception 'ai_trial_consumed_policy_immutable';
 end if;
 return new;
end $$;
create trigger trial_policy_immutable before update on ai_money.trials for each row execute function ai_money.trial_immutable();
create trigger trial_case_immutable before update on ai_money.trial_cases for each row execute function ai_money.trial_immutable();
create trigger trial_policy_audit after insert or update or delete on ai_money.trials for each row execute function ai_money.audit_policy();
-- Other trial changes audited separately because identities/cases carry trial_id, not account_id.
create function ai_money.trial_audit() returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare a text; begin
 select account_id into a from ai_money.trials where id=coalesce(new.trial_id,old.trial_id);
 perform 1 from ai_money.operators where account_id=a for update;
 insert into ai_money.events(account_id,kind,detail) values(a,'trial_'||tg_op,jsonb_build_object('table',tg_table_name,
  'actor',session_user,'before',case when tg_op<>'INSERT' then to_jsonb(old) end,'after',case when tg_op<>'DELETE' then to_jsonb(new) end));
 return coalesce(new,old);
end $$;
create trigger trial_identity_audit after insert or update or delete on ai_money.trial_identities for each row execute function ai_money.trial_audit();
create trigger trial_case_audit after insert or update or delete on ai_money.trial_cases for each row execute function ai_money.trial_audit();

create function ai_money.trial_source_current(c ai_money.trial_cases,b bigint) returns boolean language plpgsql volatile set search_path=pg_catalog as $$
declare readiness jsonb; begin
 if c.kind='source_index' then
  return public.knowledge_source_index_revision_v1(b,c.source_id) is not distinct from c.source_revision;
 end if;
 readiness:=public.knowledge_index_readiness_v1(b,'{"provider":"openai","model":"text-embedding-3-small","dimensions":768,"version":1}'::jsonb,1);
 return coalesce((readiness->>'complete')::boolean,false) and readiness->>'inventory_token'=c.inventory_token
  and (readiness->>'compatible_chunk_count')::integer=c.expected_chunks;
end $$;
create function ai_money.trial_connection_current(t ai_money.trials,c ai_money.trial_cases) returns boolean language plpgsql stable set search_path=pg_catalog as $$ begin
 if c.kind='source_index' then return true; end if;
 if c.channel='telegram' then
  return exists(select 1 from public.businesses b where b.id=t.business_id and split_part(b.telegram_bot_token,':',1)=c.account);
 end if;
 return exists(select 1 from public.channel_connections x where x.business_id=t.business_id and x.provider=c.channel and x.provider_account_id=c.account
  and x.status='connected' and not x.reconnect_required and (x.token_expires_at is null or x.token_expires_at>clock_timestamp()));
end $$;
create function ai_money.trial_current(p_account text,p_scope jsonb) returns boolean language plpgsql volatile set search_path=pg_catalog as $$
declare t ai_money.trials%rowtype;c ai_money.trial_cases%rowtype; begin
 select * into t from ai_money.trials where id=p_scope->>'trialId' and account_id=p_account;
 if not found or not t.enabled or t.valid_from>clock_timestamp() or t.valid_until<=clock_timestamp() then return false; end if;
 select * into c from ai_money.trial_cases where trial_id=t.id and id=p_scope->>'caseId';
 if not found or not c.enabled or c.state<>'claimed' or c.lease_token::text is distinct from p_scope->>'leaseToken' then return false; end if;
 if c.kind='knowledge' and not exists(select 1 from ai_money.trial_identities i where i.trial_id=c.trial_id and i.channel=c.channel
  and i.account=c.account and i.sender=c.sender and i.recipient=c.recipient and i.enabled) then return false; end if;
 return ai_money.trial_connection_current(t,c) and ai_money.trial_source_current(c,t.business_id);
end $$;
create function ai_money.transition_core_v2(p_account text,p_approval text,p_command text,p_payload jsonb,p_scope jsonb default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
 o ai_money.operators%rowtype; e ai_money.entitlements%rowtype; pl ai_money.plans%rowtype;
 r ai_money.reservations%rowtype; per ai_money.periods%rowtype;
 q jsonb:=p_payload->'quote'; u jsonb:=p_payload->'usage'; now_at timestamptz;
 b bigint; maximum bigint; tenant_cap bigint; request_cap bigint; turn_cap bigint;
 total numeric; monthly numeric; tenant_total numeric; turn_total numeric; cost bigint;
 i bigint; out_tokens bigint; cached bigint; writes bigint; reasoning bigint;
 price_input bigint;price_read bigint;price_write bigint;price_output bigint;output_limit bigint;
 trial_case ai_money.trial_cases%rowtype;trial_policy ai_money.trials%rowtype;
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
 if q->>'model'='gpt-6.1-sol' and q->>'stage' in ('extraction','verification') and q->>'ratesVersion'='openai-sol-standard-30m-2026-10-28' then
  price_input:=2000;price_read:=100;price_write:=2500;price_output:=10000;output_limit:=8192;
 elsif q->>'model'='gpt-5.6-luna' and q->>'stage'='language' and q->>'ratesVersion'='controlled-trial-standard-20261029' then
  price_input:=200;price_read:=20;price_write:=250;price_output:=1200;output_limit:=8192;
 elsif q->>'model'='text-embedding-3-small' and q->>'stage' in ('query_embedding','source_index') and q->>'ratesVersion'='controlled-trial-standard-20261029' then
  price_input:=20;price_read:=20;price_write:=20;price_output:=0;output_limit:=0;
 else raise exception 'ai_money_unapproved_model_stage'; end if;
 if p_command='reserve' then
  if p_scope is null then
   if o.trial_only or q->>'model'<>'gpt-6.1-sol' then return null; end if;
  else
   if not o.trial_only or o.trial_rates_version is distinct from 'controlled-trial-standard-20261029' or not ai_money.trial_current(p_account,p_scope) then return null; end if;
   select * into trial_policy from ai_money.trials where id=p_scope->>'trialId';
   select * into trial_case from ai_money.trial_cases where trial_id=trial_policy.id and id=p_scope->>'caseId';
   if q->>'requestKey' is distinct from trial_case.event_key or q->>'turnId' is distinct from 'trial:'||trial_case.lease_token::text
    or (q->>'businessId')::bigint<>trial_policy.business_id or trial_case.send_started
    or not(trial_case.stage_caps ? (q->>'stage')) then return null; end if;
   if trial_case.kind='source_index' and (q->>'stage'<>'source_index' or q->>'requestSha256'<>trial_case.source_request_sha256) then return null; end if;
   if trial_case.kind='knowledge' and q->>'stage' not in ('language','query_embedding','extraction','verification') then return null; end if;
   if ai_money.amount((q->>'maximumNanoUsd')::numeric)>ai_money.amount((trial_case.stage_caps->>(q->>'stage'))::numeric) then return jsonb_build_object('denied','budget_exhausted'); end if;
  end if;
 end if;
 if q is null or jsonb_typeof(q)<>'object'  or q->>'approvalReference'<>p_approval
  or (p_command='reserve' and (q->>'ownerId'<>o.owner_id or (q->>'model'='gpt-6.1-sol' and q->>'ratesVersion'<>o.rates_version) or q->>'providerProjectId' is distinct from o.provider_account_ref))
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
 if b<=0 or maximum<=0 or ai_money.amount((q->>'outputTokenLimit')::numeric)<>output_limit
  or ai_money.amount((q->>'inputTokenProxy')::numeric)>272000
  or maximum<>ai_money.amount((q->>'inputTokenProxy')::numeric)*price_write+output_limit*price_output
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
  if p_scope is not null then update ai_money.reservations set trial_id=trial_policy.id,trial_case_id=trial_case.id where id=r.id; end if;
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
  or u->>'providerProjectId' is distinct from q->>'providerProjectId' or u->>'requestSha256'<>r.request_sha or not(u->>'providerResponseId' ~ (case when output_limit=0 then '^req_[A-Za-z0-9_-]+$' else '^resp_[A-Za-z0-9_-]+$' end))
  or exists(select 1 from unnest(array['model','ownerId','ratesVersion','requestSha256','providerResponseId','providerProjectId']) k
   where jsonb_typeof(u->k) is distinct from 'string')
  or exists(select 1 from unnest(array['inputTokens','outputTokens','reasoningTokens','cachedTokens','cacheWriteTokens','estimatedNanoUsd']) k
   where jsonb_typeof(u->k) is distinct from 'number')
 then raise exception 'ai_money_receipt_identity'; end if;
 i:=ai_money.amount((u->>'inputTokens')::numeric); out_tokens:=ai_money.amount((u->>'outputTokens')::numeric);
 cached:=ai_money.amount((u->>'cachedTokens')::numeric); writes:=ai_money.amount((u->>'cacheWriteTokens')::numeric);
 reasoning:=ai_money.amount((u->>'reasoningTokens')::numeric);
 if i>(q->>'inputTokenProxy')::bigint or out_tokens>output_limit or cached+writes>i or reasoning>out_tokens then raise exception 'ai_money_receipt_bounds'; end if;
 cost:=ai_money.amount((i-cached-writes)::numeric*price_input+cached::numeric*price_read+writes::numeric*price_write+out_tokens::numeric*price_output);
 if cost>maximum or cost<>ai_money.amount((u->>'estimatedNanoUsd')::numeric) then raise exception 'ai_money_receipt_cost'; end if;
 update ai_money.reservations set state='settled',actual_nano_usd=cost,usage=u,provider_response_id=u->>'providerResponseId',settled_at=clock_timestamp() where id=r.id;
 perform ai_money.counter_delta(p_account,b,r.period_id,r.request_key,cost,-maximum);
 insert into ai_money.events(account_id,reservation_id,kind,detail) values(p_account,r.id,'settled',jsonb_build_object('actualNanoUsd',cost,'releasedNanoUsd',maximum-cost));
 return jsonb_build_object('settled',true);
end $$;

create or replace function ai_money.transition(p_account text,p_approval text,p_command text,p_payload jsonb)
returns jsonb language sql security definer set search_path=pg_catalog as $$
 select ai_money.transition_core_v2(p_account,p_approval,p_command,p_payload,null);
$$;

create function ai_money.trial_transition(p_account text,p_approval text,p_trial text,p_command text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare o ai_money.operators%rowtype;t ai_money.trials%rowtype;c ai_money.trial_cases%rowtype;
 now_at timestamptz;key text;caps numeric;total bigint;max_cases integer;
begin
 if p_command in ('settle','unknown') then return ai_money.transition_core_v2(p_account,p_approval,p_command,p_payload,null); end if;
 perform set_config('lock_timeout','1500ms',true);
 select * into o from ai_money.operators where account_id=p_account for update;
 if not found or o.approval_ref<>p_approval or not o.enabled or not o.input_bound_approved or not o.trial_only
  or o.trial_rates_version is distinct from 'controlled-trial-standard-20261029' or o.valid_until<=clock_timestamp() then return null; end if;
 select * into t from ai_money.trials where id=p_trial and account_id=p_account for update;
 now_at:=clock_timestamp();
 if not found or not t.enabled or t.valid_from>now_at or t.valid_until<=now_at then return null; end if;
 if p_command='configuration' then
  return jsonb_build_object('trialId',t.id,'businessId',t.business_id,'ownerId',o.owner_id,'approvalReference',o.approval_ref,
   'providerProjectId',o.provider_account_ref,'ratesVersion',o.trial_rates_version,'maximumRequestNanoUsd',o.request_nano_usd,
   'maximumTurnNanoUsd',o.turn_nano_usd,'expiresAt',t.valid_until,
   'identities',coalesce((select jsonb_agg(jsonb_build_object('channel',channel,'account',account,'sender',sender,'recipient',recipient))
     from ai_money.trial_identities where trial_id=t.id and enabled),'[]'));
 end if;
 if p_command='claim' then
  if p_payload->>'kind'='source_index' then
   select * into c from ai_money.trial_cases where trial_id=t.id and id=p_payload->>'caseId' and kind='source_index' and enabled and state='pending' for update;
  else
   -- Exactly one explicitly armed native case; no automatic progress/retry.
   if (select count(*) from ai_money.trial_cases where trial_id=t.id and kind='knowledge' and enabled and state='pending')<>1 then return null; end if;
   select * into c from ai_money.trial_cases where trial_id=t.id and kind='knowledge' and enabled and state='pending'
    and channel=p_payload->>'channel' and account=p_payload->>'account' and sender=p_payload->>'sender' and recipient=p_payload->>'recipient'
    and question_sha256=p_payload->>'questionSha256' for update;
  end if;
  if not found or not ai_money.trial_connection_current(t,c) or not ai_money.trial_source_current(c,t.business_id) then return null; end if;
  if c.kind='knowledge' and not exists(select 1 from ai_money.trial_identities i where i.trial_id=t.id and i.channel=c.channel and i.account=c.account
    and i.sender=c.sender and i.recipient=c.recipient and i.enabled) then return null; end if;
  if c.kind='knowledge' and (p_payload->>'businessId')::bigint is distinct from t.business_id then return null; end if;
  if coalesce(length(p_payload->>'eventId'),0) not between 1 and 200 then return null; end if;
  key:=encode(sha256(convert_to(jsonb_build_array(t.id,c.channel,c.account,c.sender,c.recipient,p_payload->>'eventId',c.question_sha256,c.source_id,c.source_revision)::text,'UTF8')),'hex');
  if exists(select 1 from ai_money.trial_cases where trial_id=t.id and event_key=key) then return null; end if;
  max_cases:=case when c.kind='knowledge' then t.maximum_native_cases else t.maximum_index_cases end;
  if (select count(*) from ai_money.trial_cases where trial_id=t.id and kind=c.kind and state='claimed')>=max_cases then return null; end if;
  if c.kind='knowledge' and (select array_agg(k order by k) from jsonb_object_keys(c.stage_caps) k) is distinct from array['extraction','language','query_embedding','verification']::text[] then return null; end if;
  if c.kind='source_index' and (select array_agg(k) from jsonb_object_keys(c.stage_caps) k) is distinct from array['source_index']::text[] then return null; end if;
  if exists(select 1 from jsonb_each(c.stage_caps) where jsonb_typeof(value) is distinct from 'number') then return null; end if;
  select sum(ai_money.amount(value::text::numeric)),max(ai_money.amount(value::text::numeric)) into caps,total from jsonb_each(c.stage_caps);
  if caps>o.turn_nano_usd or total>o.request_nano_usd or exists(select 1 from jsonb_each(c.stage_caps) where ai_money.amount(value::text::numeric)<=0) then return null; end if;
  update ai_money.trial_cases set state='claimed',lease_token=gen_random_uuid(),event_key=key,claimed_at=now_at where trial_id=t.id and id=c.id returning * into c;
  insert into ai_money.events(account_id,kind,detail) values(p_account,'trial_case_claimed',jsonb_build_object('trialId',t.id,'caseId',c.id,'eventKey',key));
  return jsonb_build_object('trialId',t.id,'caseId',c.id,'leaseToken',c.lease_token,'businessId',t.business_id,'requestKey',key,
   'turnId','trial:'||c.lease_token::text,'kind',c.kind,'channel',c.channel,'account',c.account,'sender',c.sender,'recipient',c.recipient,
   'stageCaps',c.stage_caps,'sourceId',c.source_id,'sourceRevision',c.source_revision,'sourceRequestSha256',c.source_request_sha256);
 end if;
 if p_payload->'scope'->>'trialId' is distinct from p_trial or not ai_money.trial_current(p_account,p_payload->'scope') then return null; end if;
 if p_command='current' then return 'true'::jsonb; end if;
 if p_command='reserve' then return ai_money.transition_core_v2(p_account,p_approval,'reserve',p_payload,p_payload->'scope'); end if;
 if p_command='send' then
  select * into c from ai_money.trial_cases where trial_id=t.id and id=p_payload->'scope'->>'caseId' for update;
  if c.kind<>'knowledge' or c.send_started then return null; end if;
  update ai_money.trial_cases set send_started=true where trial_id=t.id and id=c.id;
  insert into ai_money.events(account_id,kind,detail) values(p_account,'trial_send_claimed',jsonb_build_object('caseId',c.id));
  return 'true'::jsonb;
 end if;
 return null;
end $$;
create function public.odin_ai_money_trial_v1(p_account text,p_approval text,p_trial text,p_command text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$ begin
 if current_user<>'service_role' then raise exception 'ai_trial_backend_only'; end if;
 return ai_money.trial_transition(p_account,p_approval,p_trial,p_command,p_payload);
end $$;
alter table ai_money.trials enable row level security;
alter table ai_money.trial_identities enable row level security;
alter table ai_money.trial_cases enable row level security;
revoke all on all tables in schema ai_money from public,anon,authenticated,service_role;
revoke all on all functions in schema ai_money from public,anon,authenticated,service_role;
grant execute on function ai_money.transition(text,text,text,jsonb) to service_role;
grant execute on function ai_money.trial_transition(text,text,text,text,jsonb) to service_role;
revoke all on function public.odin_ai_money_trial_v1(text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.odin_ai_money_trial_v1(text,text,text,text,jsonb) to service_role;
commit;
