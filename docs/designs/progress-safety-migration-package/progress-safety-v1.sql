BEGIN;
SET LOCAL odin.approved_knowledge_progress_safety_v1 = 'yes';
-- UNAPPLIED additive draft. Outside migration discovery. No activation.
-- Existing Foundation, Slice 1 and Ordered V2 are prerequisites; never replay them.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $$ begin
  if current_setting('odin.approved_knowledge_progress_safety_v1',true) is distinct from 'yes' then
    raise exception 'progress_safety_separate_approval_required'; end if;
  if to_regprocedure('public.odin_transition_knowledge_v1(bigint,uuid,uuid,text,text,text,jsonb)') is null
    or to_regprocedure('public.odin_accept_knowledge_turn_v2(bigint,uuid,text,text,text,text,jsonb,jsonb,integer,integer,integer)') is null
    or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      and p.proname in ('odin_claim_knowledge_progress_v1','odin_guard_knowledge_progress_dispatch_v1'))
    or exists(select 1 from pg_trigger where tgrelid='public.odin_outbox'::regclass and tgname='odin_guard_knowledge_progress_dispatch_v1') then
    raise exception 'progress_safety_prerequisites_or_conflict'; end if;
end $$;

-- Covers claims through BOTH the new progress RPC and the unchanged legacy RPC.
-- Settlement transitions out of SENDING remain factual, even after finalization.
create function public.odin_guard_knowledge_progress_dispatch_v1() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare c public.odin_conversations%rowtype; t public.odin_tasks%rowtype; x jsonb;
begin
  if new.knowledge_kind is distinct from 'progress' or new.knowledge_state is distinct from 'SENDING' then return new; end if;
  -- RPCs already hold these locks in this order. Do not use outbox-first direct
  -- backend updates as a dispatch API; privileged operators remain trusted.
  select * into c from public.odin_conversations where business_id=new.business_id and id=new.conversation_id for update;
  select * into t from public.odin_tasks where business_id=new.business_id and conversation_id=new.conversation_id
    and id=new.knowledge_task_id and task_type='knowledge_async_v1' for update;
  x:=new.artifact->'progress_execution_v1';
  if t.id is null or c.id is null or t.knowledge_state<>'RUNNING' or t.knowledge_result is not null
    or t.knowledge_sequence<>c.knowledge_sequence or c.knowledge_channel is distinct from t.knowledge_channel
    or c.knowledge_account is distinct from t.knowledge_account or new.channel is distinct from t.knowledge_channel
    or new.recipient_key is distinct from c.conversation_key
    or c.aggregate_meta->'knowledge_native_order_v2'->>'state' is distinct from 'ACTIVE'
    or t.knowledge_owner is null or t.knowledge_lease_until is null or t.knowledge_lease_until<=clock_timestamp() or t.knowledge_expires_at<=clock_timestamp()
    or x->>'owner' is distinct from t.knowledge_owner or (x->>'fence')::bigint is distinct from t.knowledge_fence
    or x->>'checkpoint' is distinct from t.knowledge_checkpoint
    or t.knowledge_checkpoint is null or new.knowledge_owner is distinct from t.knowledge_owner
    or new.knowledge_lease_until is null or new.knowledge_lease_until>t.knowledge_lease_until
    or new.knowledge_lease_until>t.knowledge_expires_at or new.knowledge_lease_until<=clock_timestamp() then
    raise exception 'knowledge_progress_dispatch_not_authorized'; end if;
  return new;
end $$;
create trigger odin_guard_knowledge_progress_dispatch_v1 before insert or update on public.odin_outbox
  for each row execute function public.odin_guard_knowledge_progress_dispatch_v1();
revoke all on function public.odin_guard_knowledge_progress_dispatch_v1() from public,anon,authenticated;
grant execute on function public.odin_guard_knowledge_progress_dispatch_v1() to service_role;

-- Receipt is issued only by a trusted progress-specific server bridge. It is NOT
-- a final-answer verification receipt, factual evidence or webhook input.
create function public.odin_claim_knowledge_progress_v1(
 p_business bigint,p_conversation uuid,p_task uuid,p_channel text,p_account text,p_key text,
 p_owner text,p_task_fence bigint,p_text text,p_receipt jsonb,p_lease_ms integer default 3000
) returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare c public.odin_conversations%rowtype; t public.odin_tasks%rowtype; d public.odin_outbox%rowtype; n timestamptz;
begin
  if p_channel is null or p_channel not in ('whatsapp','telegram','instagram','messenger') or p_business is null or p_business<=0
    or p_conversation is null or p_task is null or p_account is null or p_account !~ '^[A-Za-z0-9:_-]{1,160}$'
    or p_key is null or length(p_key) not between 1 and 1000 or p_owner is null or p_owner !~ '^[A-Za-z0-9:_-]{1,160}$'
    or p_task_fence is null or p_task_fence<1 or p_text is null or length(btrim(p_text)) not between 1 and 240
    or p_lease_ms is null or p_lease_ms not between 1 and 5000 then raise exception 'invalid_progress_claim'; end if;
  select * into c from public.odin_conversations where business_id=p_business and id=p_conversation for update;
  if not found or c.conversation_key is distinct from p_key then return null; end if;
  select * into t from public.odin_tasks where business_id=p_business and conversation_id=p_conversation and id=p_task
    and knowledge_channel=p_channel and knowledge_account=p_account and task_type='knowledge_async_v1' for update;
  if not found then return null; end if;
  n:=clock_timestamp();
  if t.knowledge_state<>'RUNNING' or t.knowledge_result is not null or t.knowledge_owner is distinct from p_owner
    or t.knowledge_fence<>p_task_fence or t.knowledge_lease_until is null or t.knowledge_lease_until<=n or t.knowledge_expires_at<=n
    or t.knowledge_sequence<>c.knowledge_sequence or c.knowledge_channel is distinct from p_channel or c.knowledge_account is distinct from p_account
    or c.aggregate_meta->'knowledge_native_order_v2'->>'state' is distinct from 'ACTIVE'
    or t.knowledge_checkpoint is null then return null; end if;
  if not coalesce(jsonb_typeof(p_receipt)='object' and p_receipt->>'purpose'='knowledge-progress-v1'
    and p_receipt->>'businessId'=p_business::text and p_receipt->>'conversationId'=p_conversation::text
    and p_receipt->>'taskId'=p_task::text and p_receipt->>'turnId'=t.knowledge_turn_id::text
    and p_receipt->>'channel'=p_channel and p_receipt->>'account'=p_account and p_receipt->>'key'=p_key
    and p_receipt->>'sequence'=c.knowledge_sequence::text and p_receipt->>'owner'=p_owner
    and p_receipt->>'fence'=p_task_fence::text and p_receipt->>'checkpoint'=t.knowledge_checkpoint
    and p_receipt->>'bindingMac' ~ '^[a-f0-9]{64}$'
    and p_receipt->>'bindingMac'=c.aggregate_meta->'knowledge_native_recipient_v1'->>'mac'
    and (p_receipt->>'checkedAt')::timestamptz between n-interval '1 second' and n,false) then return null; end if;
  insert into public.odin_outbox(business_id,conversation_id,schema_version,channel,recipient_key,delivery_key,artifact,status,attempt_count,
    knowledge_task_id,knowledge_kind,knowledge_state)
  values(p_business,p_conversation,1,p_channel,c.conversation_key,'knowledge:v1:'||t.knowledge_turn_id::text||':progress',
    jsonb_build_object('text',p_text,'requiresLiveAuthorization',true),'pending',0,t.id,'progress','PENDING')
  on conflict (business_id,knowledge_task_id,knowledge_kind) where knowledge_task_id is not null do nothing;
  select * into d from public.odin_outbox where business_id=p_business and conversation_id=p_conversation
    and knowledge_task_id=t.id and knowledge_kind='progress' for update;
  if d.knowledge_state='SENDING' and d.knowledge_lease_until<=n then
    update public.odin_outbox set knowledge_state='UNCERTAIN',knowledge_owner=null,knowledge_lease_until=null where id=d.id;
    return null; end if;
  if d.knowledge_state not in ('PENDING','FAILED') or d.attempt_count>=d.knowledge_max_attempts
    or d.artifact->>'text' is distinct from p_text then return null; end if;
  update public.odin_outbox set knowledge_state='SENDING',knowledge_fence=knowledge_fence+1,knowledge_owner=p_owner,
    knowledge_lease_until=least(n+p_lease_ms*interval '1 millisecond',t.knowledge_lease_until,t.knowledge_expires_at),
    attempt_count=attempt_count+1,last_attempt_at=n,
    artifact=jsonb_set(artifact,'{progress_execution_v1}',jsonb_build_object('owner',p_owner,'fence',p_task_fence,'checkpoint',t.knowledge_checkpoint))
    where id=d.id returning * into d;
  if clock_timestamp()>=d.knowledge_lease_until or (p_receipt->>'checkedAt')::timestamptz<clock_timestamp()-interval '1 second' then
    raise exception 'progress_authority_expired_during_claim'; end if;
  return to_jsonb(d);
end $$;
revoke all on function public.odin_claim_knowledge_progress_v1(bigint,uuid,uuid,text,text,text,text,bigint,text,jsonb,integer) from public,anon,authenticated;
grant execute on function public.odin_claim_knowledge_progress_v1(bigint,uuid,uuid,text,text,text,text,bigint,text,jsonb,integer) to service_role;
commit;
