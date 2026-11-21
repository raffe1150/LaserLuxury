-- Rollback for tierb-natural-stages-v1. NOT APPLIED. Restores the exact re_extraction body (md5 e54c7052fd6ad27b10983d7d78cda9b4).
-- Refuses while any Tier B reservation is still held: those rows must settle or be recorded unknown first,
-- because the restored body can no longer price them. Existing rows are never deleted or changed.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $guard$
begin
 if (select md5(prosrc) from pg_proc where oid='ai_money.transition_core_v2(text,text,text,jsonb,jsonb)'::regprocedure) is distinct from 'cf7773b3a165f6118f91cede0f265b45' then
  raise exception 'ai_money_tierb_rollback_unexpected_body';
 end if;
 if exists(select 1 from ai_money.reservations where stage in ('knowledge_natural_composition','knowledge_natural_validation') and state='held') then
  raise exception 'ai_money_tierb_rollback_held_rows';
 end if;
end $guard$;
create or replace function ai_money.transition_core_v2(p_account text,p_approval text,p_command text,p_payload jsonb,p_scope jsonb default null)
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
 if q->>'model'='gpt-6.1-sol' and q->>'stage' in ('extraction','re_extraction','verification') and q->>'ratesVersion'='openai-sol-standard-30m-2026-10-28' then
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
   if trial_case.kind='knowledge' and q->>'stage' not in ('language','query_embedding','extraction','re_extraction','verification') then return null; end if;
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
do $post$
begin
 if (select md5(prosrc) from pg_proc where oid='ai_money.transition_core_v2(text,text,text,jsonb,jsonb)'::regprocedure) is distinct from 'e54c7052fd6ad27b10983d7d78cda9b4' then
  raise exception 'ai_money_tierb_rollback_mismatch';
 end if;
end $post$;
commit;
