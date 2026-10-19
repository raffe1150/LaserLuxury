BEGIN;
SET LOCAL odin.approved_ordered_knowledge_v2 = 'yes';
-- UNAPPLIED. Outside automatic migration discovery. Separate application approval required.
-- Foundation + Slice 1 are prerequisites; never replay or alter their pinned files.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $$ begin
  if current_setting('odin.approved_ordered_knowledge_v2',true) is distinct from 'yes' then
    raise exception 'ordered_knowledge_v2_separate_approval_required'; end if;
  if to_regprocedure('public.odin_accept_knowledge_turn_v1(bigint,uuid,text,text,text,jsonb,integer,integer,integer)') is null
    or exists(select 1 from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
      where ns.nspname='public' and p.proname='odin_accept_knowledge_turn_v2') then
    raise exception 'ordered_knowledge_v2_prerequisites'; end if;
end $$;

-- Dedicated namespace in existing aggregate_meta; bounded order evidence in the
-- existing inbox payload/turn_sequence. No new tables, columns, indexes or grants.
create function public.odin_accept_knowledge_turn_v2(
  p_business bigint,p_conversation uuid,p_channel text,p_account text,p_event text,p_key text,
  p_order jsonb,p_input jsonb default null,p_execution_ms integer default 40000,
  p_max_runs integer default 3,p_max_models integer default 4
) returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare c public.odin_conversations%rowtype; i public.odin_inbox%rowtype;
  t public.odin_tasks%rowtype; n timestamptz; turn_id uuid:=gen_random_uuid();
  w jsonb; new_w jsonb; at_ms bigint; seq bigint; previous_at bigint; previous_seq bigint;
  disposition text:='ACCEPTED'; state text:='ACTIVE'; duplicate boolean:=false; may_attach boolean:=false;
begin
  if p_business is null or p_business<=0 or p_conversation is null or p_key is null or length(p_key) not between 1 and 1000
    or p_channel is null or p_channel not in ('whatsapp','telegram','instagram','messenger')
    or p_account is null or p_account !~ '^[A-Za-z0-9:_-]{1,160}$'
    or p_event is null or length(p_event) not between 1 and 256 or p_event !~ '^[A-Za-z0-9:_.=+/-]+$'
    or p_execution_ms is null or p_execution_ms not between 1000 and 120000
    or p_max_runs is null or p_max_runs not between 1 and 5
    or p_max_models is null or p_max_models not between 1 and 8 then raise exception 'invalid_ordered_acceptance'; end if;
  if p_order is not null then
    if jsonb_typeof(p_order) is distinct from 'object' or (p_order-array['atMs','sequence'])<>'{}'::jsonb
      or jsonb_typeof(p_order->'atMs') is distinct from 'number' or coalesce(p_order->>'atMs','') !~ '^[1-9][0-9]{0,15}$'
      or (p_channel='telegram' and (jsonb_typeof(p_order->'sequence') is distinct from 'number'
        or coalesce(p_order->>'sequence','') !~ '^[0-9]{1,16}$'))
      or (p_channel<>'telegram' and p_order->'sequence' is distinct from 'null'::jsonb) then raise exception 'invalid_native_order'; end if;
    at_ms:=(p_order->>'atMs')::bigint; seq:=(p_order->>'sequence')::bigint;
    if at_ms>9007199254740991 or seq>9007199254740991
      or (p_channel in ('telegram','whatsapp') and at_ms%1000<>0) then raise exception 'invalid_native_order'; end if;
  end if;
  -- All admission, duplicate attachment and supersession checks share this lock.
  select * into c from public.odin_conversations where business_id=p_business and id=p_conversation for update;
  if not found or c.conversation_key is distinct from p_key then raise exception 'ordered_conversation_scope'; end if;
  if c.knowledge_channel is not null and (c.knowledge_channel is distinct from p_channel or c.knowledge_account is distinct from p_account) then
    raise exception 'ordered_provider_scope'; end if;
  n:=clock_timestamp(); w:=c.aggregate_meta->'knowledge_native_order_v2';
  if w is not null and (jsonb_typeof(w) is distinct from 'object' or
    coalesce(w->>'state','') not in ('ACTIVE','TIED','BLOCKED') or
    (w->>'ownerSequence')::bigint is distinct from c.knowledge_sequence or
    (w->>'state' in ('ACTIVE','TIED') and (w->>'atMs' is null or
      (p_channel='telegram' and w->>'sequence' is null)))) then raise exception 'ordered_metadata_invalid'; end if;
  select * into i from public.odin_inbox where business_id=p_business and channel=p_channel
    and provider_scope=p_account and provider_event_id=p_event for update;
  if found then
    if i.conversation_id is distinct from p_conversation or i.knowledge_turn_id is null
      or i.payload->'native_order_v2' is null then raise exception 'ordered_existing_event_requires_review'; end if;
    duplicate:=true; disposition:='DUPLICATE';
    select * into t from public.odin_tasks where business_id=p_business and knowledge_inbox_id=i.id;
    may_attach:=coalesce(i.knowledge_sequence=c.knowledge_sequence and i.knowledge_expires_at>n
      and w->>'state'='ACTIVE' and i.payload->'native_order_v2'->>'disposition'='ACCEPTED'
      and i.payload->'native_order_v2'->'order' is not distinct from p_order,false);
    if t.id is not null or p_input is null or not may_attach then
      return jsonb_build_object('disposition',disposition,'mayAttach',may_attach,'inserted',false,'inbox',to_jsonb(i),
        'task',case when t.id is null then null else to_jsonb(t) end); end if;
    n:=i.knowledge_accepted_at; turn_id:=i.knowledge_turn_id;
    p_max_runs:=i.knowledge_max_runs; p_max_models:=i.knowledge_max_models;
  else
    if w is null and c.knowledge_sequence<>0 then raise exception 'ordered_legacy_conversation_requires_drain'; end if;
    if w->>'state'='BLOCKED' then
      return jsonb_build_object('disposition','BLOCKED','mayAttach',false,'inserted',false,'inbox',null,'task',null); end if;
    previous_at:=(w->>'atMs')::bigint; previous_seq:=(w->>'sequence')::bigint;
    -- Missing/future order is not receipt time. Fence current work and latch
    -- BLOCKED until a separately authorized resynchronization; no invented epoch.
    if p_order is null or at_ms>floor(extract(epoch from clock_timestamp())*1000)::bigint then
      disposition:='AMBIGUOUS'; state:='BLOCKED'; at_ms:=previous_at; seq:=previous_seq;
    elsif p_channel='telegram' and previous_at is not null and at_ms<previous_at and seq>previous_seq then
      disposition:='AMBIGUOUS'; state:='BLOCKED'; at_ms:=previous_at; seq:=previous_seq;
    elsif previous_at is not null and (at_ms<previous_at or
      (p_channel='telegram' and at_ms=previous_at and seq<previous_seq)) then
      return jsonb_build_object('disposition','STALE','mayAttach',false,'inserted',false,'inbox',null,'task',null);
    elsif previous_at is not null and at_ms=previous_at and
      (p_channel<>'telegram' or seq=previous_seq or w->>'state'='TIED') then
      disposition:='AMBIGUOUS'; state:='TIED'; seq:=previous_seq;
    -- Telegram IDs may reset after a week without updates. A higher timestamp
    -- with a regressed sequence inside that interval is contradictory: fence.
    elsif p_channel='telegram' and previous_at is not null and at_ms>previous_at and seq<=previous_seq
      and at_ms-previous_at<604800000 then
      disposition:='AMBIGUOUS'; state:='BLOCKED';
    end if;
    may_attach:=state='ACTIVE';
  end if;
  if p_input is not null and may_attach then
    if jsonb_typeof(p_input) is distinct from 'object' or (p_input-array['question','language','history'])<>'{}'::jsonb
      or jsonb_typeof(p_input->'question') is distinct from 'string' or length(p_input->>'question') not between 1 and 4000
      or coalesce(p_input->>'language','') !~ '^[a-z]{2,3}(-[A-Za-z]{2,8})?$'
      or jsonb_typeof(p_input->'history') is distinct from 'array' then raise exception 'knowledge_input_bounds'; end if;
    if jsonb_array_length(p_input->'history')>4 or octet_length(p_input::text)>40000 or exists(
      select 1 from jsonb_array_elements(p_input->'history') h where jsonb_typeof(h) is distinct from 'object'
      or (h-array['role','content'])<>'{}'::jsonb or coalesce(h->>'role','') not in ('user','assistant')
      or jsonb_typeof(h->'content') is distinct from 'string' or length(coalesce(h->>'content','')) not between 1 and 1200
    ) then raise exception 'knowledge_history_bounds'; end if;
  end if;
  if not duplicate then
    new_w:=jsonb_build_object('state',state,'atMs',at_ms,'sequence',seq,'ownerSequence',c.knowledge_sequence+1);
    -- knowledge_sequence is an invalidation fence, not a claim of native order.
    -- Ambiguity advances ONLY this fence; atMs/sequence never invent a tie order.
    update public.odin_conversations set knowledge_sequence=knowledge_sequence+1,knowledge_channel=p_channel,knowledge_account=p_account,
      aggregate_meta=jsonb_set(aggregate_meta,'{knowledge_native_order_v2}',new_w) where id=c.id returning * into c;
    insert into public.odin_inbox(business_id,conversation_id,channel,provider_scope,provider_event_id,turn_sequence,schema_version,payload,status,
      knowledge_turn_id,knowledge_sequence,knowledge_accepted_at,knowledge_expires_at,knowledge_max_runs,knowledge_max_models)
    values(p_business,p_conversation,p_channel,p_account,p_event,case when p_channel='telegram' then (p_order->>'sequence')::bigint else null end,
      1,jsonb_build_object('native_order_v2',jsonb_build_object('order',p_order,'disposition',disposition)),'accepted',turn_id,c.knowledge_sequence,
      n,n+p_execution_ms*interval '1 millisecond',p_max_runs,p_max_models) returning * into i;
  end if;
  if p_input is not null and may_attach then
    insert into public.odin_tasks(business_id,conversation_id,schema_version,task_type,status,task_revision,payload,
      knowledge_turn_id,knowledge_inbox_id,knowledge_channel,knowledge_account,knowledge_sequence,
      knowledge_accepted_at,knowledge_expires_at,knowledge_state,knowledge_max_runs,knowledge_max_models)
    values(p_business,p_conversation,1,'knowledge_async_v1','accepted',0,p_input,turn_id,i.id,p_channel,p_account,c.knowledge_sequence,
      n,i.knowledge_expires_at,'ACCEPTED',p_max_runs,p_max_models) returning * into t;
  end if;
  return jsonb_build_object('disposition',disposition,'mayAttach',may_attach,'inserted',not duplicate,'inbox',to_jsonb(i),
    'task',case when t.id is null then null else to_jsonb(t) end);
end $$;
revoke all on function public.odin_accept_knowledge_turn_v2(bigint,uuid,text,text,text,text,jsonb,jsonb,integer,integer,integer) from public,anon,authenticated;
grant execute on function public.odin_accept_knowledge_turn_v2(bigint,uuid,text,text,text,text,jsonb,jsonb,integer,integer,integer) to service_role;

-- Prevent accidental v1/native-order mixing after a conversation enrolls in v2.
-- v1 function/ACL remain untouched. Generic unenrolled P2 conversations unchanged.
create function public.odin_guard_native_order_v2() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare w jsonb; old_w jsonb; c public.odin_conversations%rowtype; i public.odin_inbox%rowtype;
begin
  if tg_table_name='odin_conversations' then
    w:=new.aggregate_meta->'knowledge_native_order_v2'; old_w:=old.aggregate_meta->'knowledge_native_order_v2';
    if old_w is not null or w is not null then
      if w is null or jsonb_typeof(w) is distinct from 'object' or
        coalesce(w->>'state','') not in ('ACTIVE','TIED','BLOCKED') or
        (w->>'ownerSequence')::bigint is distinct from new.knowledge_sequence then raise exception 'ordered_fence_required'; end if;
      if new.knowledge_sequence<>old.knowledge_sequence then
        if new.knowledge_sequence<>old.knowledge_sequence+1 then raise exception 'ordered_fence_regression'; end if;
      elsif w is distinct from old_w then raise exception 'ordered_metadata_requires_fence'; end if;
      if old_w->>'state'='BLOCKED' and w->>'state'<>'BLOCKED' then raise exception 'ordered_resynchronization_required'; end if;
    end if;
  elsif tg_table_name='odin_inbox' then
    if old.payload->'native_order_v2' is not null and
      (new.payload is distinct from old.payload or new.turn_sequence is distinct from old.turn_sequence) then
      raise exception 'ordered_immutable_ingress'; end if;
  elsif new.knowledge_turn_id is not null then
    select * into c from public.odin_conversations where business_id=new.business_id and id=new.conversation_id for update;
    w:=c.aggregate_meta->'knowledge_native_order_v2';
    if w is not null then
      select * into i from public.odin_inbox where business_id=new.business_id and id=new.knowledge_inbox_id and conversation_id=new.conversation_id;
      if w->>'state'<>'ACTIVE' or new.knowledge_sequence<>c.knowledge_sequence or
        i.knowledge_turn_id is distinct from new.knowledge_turn_id or
        i.payload->'native_order_v2'->>'disposition' is distinct from 'ACCEPTED' then raise exception 'ordered_task_not_authorized'; end if;
    end if;
  end if;
  return new;
end $$;
create trigger odin_guard_native_order_conversation_v2 before update on public.odin_conversations
  for each row execute function public.odin_guard_native_order_v2();
create trigger odin_guard_native_order_ingress_v2 before update on public.odin_inbox
  for each row execute function public.odin_guard_native_order_v2();
create trigger odin_guard_native_order_task_v2 before insert on public.odin_tasks
  for each row execute function public.odin_guard_native_order_v2();
revoke all on function public.odin_guard_native_order_v2() from public,anon,authenticated;
grant execute on function public.odin_guard_native_order_v2() to service_role;
commit;
