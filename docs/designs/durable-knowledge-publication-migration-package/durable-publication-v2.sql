begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
set local search_path=pg_catalog,public;
do $guard$
declare expected record; p pg_catalog.pg_proc%rowtype;
begin
  for expected in select * from (values
    ('public.odin_guard_knowledge_identity_v1()', 1792, '194f2d0cec77d601f40b54d775b50603', '4a6457e7a904f4c4cd965c3db6069e3f713b03762e6f940a7c49307e37da321f'),
    ('public.odin_transition_knowledge_v1(bigint,uuid,uuid,text,text,text,jsonb)', 12497, '326115746050bf861430c0060aeeb7d1', '71663465cb9a3a46247afcc597992bdbf969bf76073722895ebdc2721bf14ef6'),
    ('public.odin_transition_knowledge_v2(bigint,uuid,uuid,text,text,text,jsonb)', 9124, '3c12af1a9b0399558f13426aa8bc2bba', '007ee748c099355b58c3cf809414a390f5b4187a1c4f17b3b7a6981500d0a5c9'),
    ('public.odin_discover_knowledge_v2(text,integer)', 4119, '2d5a7f3294604e178135697b7b67ac6e', 'c83ea8e7556d3635c1ac0e2770800bb31f3b0224a3a4b67a947d328a5cfd5b64'),
    ('public.odin_native_intake_v1(bigint,uuid,text,text,text,text,jsonb,text,uuid,text,jsonb,integer)', 5629, 'b148163112740ac6bc3b86283c392d36', '13dce22c39f9407e9e420131e9ad28a52c75ee669cc3f99947b9bebd9d125f3c'),
    ('public.odin_accept_knowledge_turn_v2(bigint,uuid,text,text,text,text,jsonb,jsonb,integer,integer,integer)', 8806, '5cb63627a622724b9d364b2aa76d15a8', 'a5f3c7be1c9c0acea5b7140cc32a6ba170b872d0087bcc44e2ee60d2cebb8fb0')
  ) as pins(signature, body_bytes, body_md5, body_sha256) loop
    select * into p from pg_catalog.pg_proc where oid=to_regprocedure(expected.signature);
    if not found or p.prosecdef or octet_length(p.prosrc)<>expected.body_bytes or md5(p.prosrc)<>expected.body_md5
      or encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')<>expected.body_sha256
      or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
      or not has_function_privilege('service_role',p.oid,'EXECUTE')
      or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE')
    then raise exception 'knowledge_publication_fingerprint_or_acl: %', expected.signature; end if;
  end loop;
  if to_regprocedure('public.odin_native_intake_v2(bigint,uuid,text,text,text,text,jsonb,text,uuid,text,jsonb,integer,integer)') is not null then raise exception 'knowledge_publication_unexpected_function'; end if;
end $guard$;
-- Retained on rollback so the original fact and source pins stay available for audit.
alter table public.odin_tasks add column if not exists knowledge_withdrawn_result jsonb;
alter table public.odin_inbox add column knowledge_publication_v2 boolean not null default false
  check (not knowledge_publication_v2 or (business_id=3 and knowledge_turn_id is not null and knowledge_max_models in (4,5)));
alter table public.odin_tasks add column knowledge_publication_v2 boolean not null default false
  check (not knowledge_publication_v2 or (business_id=3 and knowledge_turn_id is not null and knowledge_max_models in (4,5)));
create function public.odin_native_intake_v2(
  p_business bigint,p_conversation uuid,p_channel text,p_account text,p_event text,p_key text,
  p_order jsonb,p_command text,p_owner uuid,p_context text,p_input jsonb,p_execution_ms integer,p_max_models integer
) returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $body$
declare c public.odin_conversations%rowtype; i public.odin_inbox%rowtype;
  t public.odin_tasks%rowtype; r jsonb; reason text;
begin
  if p_max_models is not null and (p_business is distinct from 3 or p_command is distinct from 'begin' or p_max_models not in (4,5)) then
    raise exception 'knowledge_publication_scope'; end if;
  if p_command is null or p_command not in ('begin','prepare','reconcile','finish','legacy') or p_owner is null
    or p_context is null or length(p_context)>4000 then raise exception 'intake_invalid_command'; end if;
  select * into c from public.odin_conversations where business_id=p_business and id=p_conversation for update;
  if not found or c.conversation_key is distinct from p_key then raise exception 'intake_scope'; end if;
  if p_command='begin' then
    r:=public.odin_accept_knowledge_turn_v2(p_business,p_conversation,p_channel,p_account,p_event,p_key,p_order,null,p_execution_ms,3,coalesce(p_max_models,4));
    if r->'inbox'='null'::jsonb then return r||jsonb_build_object('intakeState','TERMINAL','intakeReason',r->>'disposition'); end if;
  end if;
  select * into i from public.odin_inbox where business_id=p_business and conversation_id=p_conversation
    and channel=p_channel and provider_scope=p_account and provider_event_id=p_event for update;
  if not found or i.payload->'native_order_v2'->'order' is distinct from coalesce(p_order,'null'::jsonb) then
    raise exception 'intake_event_scope'; end if;
  select * into t from public.odin_tasks where business_id=p_business and knowledge_inbox_id=i.id;
  if p_command='begin' and i.knowledge_intake_state is null then
    update public.odin_inbox set knowledge_intake_owner=p_owner,knowledge_intake_context=p_context,
      knowledge_publication_v2=(p_max_models is not null and r->'inserted'='true'::jsonb and r->'mayAttach'='true'::jsonb),
      knowledge_intake_state=case when t.id is not null then 'ATTACHED' when r->'inserted'='true'::jsonb and r->'mayAttach'='true'::jsonb then 'ROUTING' else 'TERMINAL' end,
      knowledge_intake_reason=case when t.id is not null then null when r->'inserted'='true'::jsonb and r->'mayAttach'='true'::jsonb then null else 'LEGACY_OR_ORDER_REJECTED' end
      where id=i.id returning * into i;
  end if;
  if i.knowledge_intake_state is null then raise exception 'intake_not_enrolled'; end if;
  -- Re-read after V2 updated the conversation fence inside this transaction.
  select * into c from public.odin_conversations where business_id=p_business and id=p_conversation;
  if i.knowledge_intake_state in ('ROUTING','PREPARED') and
    (i.knowledge_sequence<>c.knowledge_sequence or i.knowledge_expires_at<=clock_timestamp()) then
    reason:=case when i.knowledge_sequence<>c.knowledge_sequence then 'SUPERSEDED'
      when i.knowledge_intake_state='ROUTING' then 'ROUTING_INTERRUPTED' else 'EXPIRED' end;
    update public.odin_inbox set knowledge_intake_state='TERMINAL',knowledge_intake_reason=reason where id=i.id returning * into i;
  end if;
  if p_command='prepare' and i.knowledge_intake_state='ROUTING' then
    if i.knowledge_intake_owner is distinct from p_owner then raise exception 'intake_owner'; end if;
    if p_input is null or jsonb_typeof(p_input) is distinct from 'object' or (p_input-array['question','language','history'])<>'{}'::jsonb
      or jsonb_typeof(p_input->'question') is distinct from 'string' or length(btrim(p_input->>'question')) not between 1 and 4000
      or coalesce(p_input->>'language','') !~ '^[a-z]{2,3}(-[A-Za-z]{2,8})?$'
      or jsonb_typeof(p_input->'history') is distinct from 'array' then raise exception 'intake_input'; end if;
    if jsonb_array_length(p_input->'history')>4 or octet_length(p_input::text)>40000 or exists(
      select 1 from jsonb_array_elements(p_input->'history') h where jsonb_typeof(h) is distinct from 'object'
      or (h-array['role','content'])<>'{}'::jsonb or coalesce(h->>'role','') not in ('user','assistant')
      or jsonb_typeof(h->'content') is distinct from 'string' or length(btrim(h->>'content')) not between 1 and 1200
    ) then raise exception 'intake_history'; end if;
    update public.odin_inbox set knowledge_intake_input=p_input,knowledge_intake_state='PREPARED' where id=i.id returning * into i;
  elsif p_command='prepare' and i.knowledge_intake_state in ('PREPARED','ATTACHED') and
    (i.knowledge_intake_owner is distinct from p_owner or i.knowledge_intake_input is distinct from p_input) then
    raise exception 'intake_immutable_input';
  end if;
  if p_command in ('reconcile','finish') and i.knowledge_intake_state='PREPARED' then
    r:=public.odin_accept_knowledge_turn_v2(p_business,p_conversation,p_channel,p_account,p_event,p_key,p_order,i.knowledge_intake_input,p_execution_ms,3,4);
    select * into t from public.odin_tasks where business_id=p_business and knowledge_inbox_id=i.id;
    update public.odin_inbox set knowledge_intake_state=case when t.id is null then 'TERMINAL' else 'ATTACHED' end,
      knowledge_intake_reason=case when t.id is null then 'ATTACHMENT_REJECTED' else null end where id=i.id returning * into i;
  elsif p_command in ('finish','legacy') and i.knowledge_intake_state='ROUTING' then
    if i.knowledge_intake_owner is distinct from p_owner then raise exception 'intake_owner'; end if;
    update public.odin_inbox set knowledge_intake_state='TERMINAL',
      knowledge_intake_reason=case when p_command='legacy' then 'LEGACY_CLAIM_REQUIRES_REVIEW' else 'FOREGROUND_HANDLED' end
      where id=i.id returning * into i;
  end if;
  return coalesce(r,'{}'::jsonb)||jsonb_build_object('disposition',coalesce(r->>'disposition','DUPLICATE'),
    'mayAttach',i.knowledge_intake_state in ('ROUTING','PREPARED','ATTACHED'), 'inserted',coalesce(r->'inserted','false'::jsonb),
    'inbox',to_jsonb(i),'task',case when t.id is null then null else to_jsonb(t) end,
    'intakeState',i.knowledge_intake_state,'intakeReason',i.knowledge_intake_reason,'intakeOwner',i.knowledge_intake_owner);
end $body$;
revoke all on function public.odin_native_intake_v2(bigint,uuid,text,text,text,text,jsonb,text,uuid,text,jsonb,integer,integer) from public,anon,authenticated;
grant execute on function public.odin_native_intake_v2(bigint,uuid,text,text,text,text,jsonb,text,uuid,text,jsonb,integer,integer) to service_role;
do $install$
declare patch record; def text; old_body text; delimiter constant text := '$function$';
begin
  for patch in select * from (values
    ('public.odin_accept_knowledge_turn_v2(bigint,uuid,text,text,text,text,jsonb,jsonb,integer,integer,integer)', $body$
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
    or p_max_models is null or p_max_models not between 1 and (case when p_business=3 then 5 else 4 end) then raise exception 'invalid_ordered_acceptance'; end if;
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
      knowledge_accepted_at,knowledge_expires_at,knowledge_state,knowledge_max_runs,knowledge_max_models,knowledge_publication_v2)
    values(p_business,p_conversation,1,'knowledge_async_v1','accepted',0,p_input,turn_id,i.id,p_channel,p_account,c.knowledge_sequence,
      n,i.knowledge_expires_at,'ACCEPTED',p_max_runs,p_max_models,i.knowledge_publication_v2) returning * into t;
  end if;
  return jsonb_build_object('disposition',disposition,'mayAttach',may_attach,'inserted',not duplicate,'inbox',to_jsonb(i),
    'task',case when t.id is null then null else to_jsonb(t) end);
end $body$),
    ('public.odin_native_intake_v1(bigint,uuid,text,text,text,text,jsonb,text,uuid,text,jsonb,integer)', $body$
begin
  return public.odin_native_intake_v2(p_business,p_conversation,p_channel,p_account,p_event,p_key,p_order,
    p_command,p_owner,p_context,p_input,p_execution_ms,null);
end $body$),
    ('public.odin_transition_knowledge_v1(bigint,uuid,uuid,text,text,text,jsonb)', $body$
declare c public.odin_conversations%rowtype; t public.odin_tasks%rowtype;
  d public.odin_outbox%rowtype; n timestamptz; receipt jsonb:=p_args->'authority';
  owner_id text:=p_args->>'owner'; lease_ms integer; stage integer; previous_stage integer;
  body text; kind text; valid_authority boolean; result jsonb; key text; final_only boolean; safe_text text;
begin
  select * into c from public.odin_conversations where business_id=p_business and id=p_conversation for update;
  if not found then return null; end if;
  select * into t from public.odin_tasks where business_id=p_business and conversation_id=p_conversation and id=p_task
    and knowledge_channel=p_channel and knowledge_account=p_account and task_type='knowledge_async_v1'
    and knowledge_turn_id is not null for update;
  if not found then return null; end if;
  n:=clock_timestamp();
  if c.knowledge_channel is distinct from p_channel or c.knowledge_account is distinct from p_account then return null; end if;
  if t.knowledge_sequence<>c.knowledge_sequence then
    update public.odin_tasks set knowledge_state='SUPERSEDED',knowledge_owner=null,knowledge_lease_until=null where id=t.id and knowledge_state not in ('FAILED','EXPIRED','SUPERSEDED');
    update public.odin_outbox set knowledge_state='SUPERSEDED' where knowledge_task_id=t.id and knowledge_state in ('PENDING','FAILED');
    -- An in-flight send cannot be recalled. Preserve it for factual settlement;
    -- expired sending leases become uncertain below/on the next recovery scan.
    if p_command<>'settle_delivery' then
      update public.odin_outbox set knowledge_state='UNCERTAIN',knowledge_owner=null,knowledge_lease_until=null
        where knowledge_task_id=t.id and knowledge_state='SENDING' and knowledge_lease_until<=n;
      return null; end if;
  end if;
  update public.odin_outbox set knowledge_state='UNCERTAIN',knowledge_owner=null,knowledge_lease_until=null
    where knowledge_task_id=t.id and knowledge_state='SENDING' and knowledge_lease_until<=n;
  if t.knowledge_expires_at<=n then
    update public.odin_tasks set knowledge_state='EXPIRED',knowledge_owner=null,knowledge_lease_until=null
      where id=t.id and knowledge_state in ('ACCEPTED','RUNNING','VERIFIED');
    update public.odin_outbox set knowledge_state='EXPIRED' where knowledge_task_id=t.id and knowledge_state in ('PENDING','FAILED');
    return null;
  end if;
  if p_command='recover' then return to_jsonb(t); end if;
  if p_command in ('verified','withdraw_result') and t.knowledge_publication_v2 then
      safe_text:=case split_part(lower(t.payload->>'language'),'-',1)
        when 'sv' then 'Jag kan inte bekräfta de efterfrågade uppgifterna just nu.'
        when 'de' then 'Ich kann die angefragten Angaben gerade nicht bestätigen.'
        when 'es' then 'No puedo verificar los detalles solicitados en este momento.'
        when 'fa' then 'در حال حاضر نمی‌توانم جزئیات درخواست‌شده را تأیید کنم.'
        when 'ar' then 'لا أستطيع التحقق من التفاصيل المطلوبة الآن.'
        else 'I can’t verify the requested details right now.' end;
  end if;
  if p_command in ('claim','renew','claim_delivery') then
    lease_ms:=(p_args->>'leaseMs')::integer;
    if owner_id is null or owner_id !~ '^[A-Za-z0-9:_-]{1,160}$' or lease_ms is null or lease_ms not between 1 and 30000 then
      raise exception 'knowledge_invalid_lease'; end if;
  end if;
  if p_command='claim' then
    if t.knowledge_state not in ('ACCEPTED','RUNNING','VERIFIED') or t.knowledge_lease_until>n then return null; end if;
    -- Recovery can take a new finalization-only fence without taking another model run.
    final_only:=t.knowledge_publication_v2 and (t.knowledge_run_attempts>=t.knowledge_max_runs
      or t.knowledge_state<>'VERIFIED' and t.knowledge_model_attempts>=t.knowledge_max_models);
    if t.knowledge_run_attempts>=t.knowledge_max_runs and not final_only then
      update public.odin_tasks set knowledge_state='FAILED',knowledge_owner=null,knowledge_lease_until=null where id=t.id; return null; end if;
    update public.odin_tasks set knowledge_state=case when knowledge_state='VERIFIED' then 'VERIFIED' else 'RUNNING' end,
      knowledge_fence=knowledge_fence+1,knowledge_owner=owner_id,knowledge_lease_until=least(n+lease_ms*interval '1 millisecond',knowledge_expires_at),
      knowledge_run_attempts=knowledge_run_attempts+case when final_only then 0 else 1 end,task_revision=task_revision+1 where id=t.id returning * into t;
    return to_jsonb(t);
  end if;
  if p_command in ('renew','model_attempt','checkpoint','verified','fail','finalize') then
    if t.knowledge_state not in ('RUNNING','VERIFIED') or t.knowledge_owner is distinct from owner_id or
       t.knowledge_fence is distinct from (p_args->>'fence')::bigint or t.knowledge_lease_until is null or t.knowledge_lease_until<=n then return null; end if;
  end if;
  if p_command='renew' then
    update public.odin_tasks set knowledge_lease_until=least(n+lease_ms*interval '1 millisecond',knowledge_expires_at),task_revision=task_revision+1 where id=t.id returning * into t;
  elsif p_command='model_attempt' then
    if t.knowledge_state<>'RUNNING' or t.knowledge_model_attempts>=t.knowledge_max_models
      or (t.knowledge_publication_v2 and t.knowledge_fence>t.knowledge_run_attempts) then return null; end if;
    update public.odin_tasks set knowledge_model_attempts=knowledge_model_attempts+1,task_revision=task_revision+1 where id=t.id returning * into t;
  elsif p_command='checkpoint' then
    stage:=array_position(array['planning','retrieval','extraction'],p_args->>'checkpoint');
    previous_stage:=coalesce(array_position(array['planning','retrieval','extraction'],t.knowledge_checkpoint),0);
    if stage is null then raise exception 'knowledge_invalid_checkpoint'; end if;
    if t.knowledge_state<>'RUNNING' or stage<=previous_stage then return null; end if;
    update public.odin_tasks set knowledge_checkpoint=p_args->>'checkpoint',task_revision=task_revision+1 where id=t.id returning * into t;
  elsif p_command='verified' then
    result:=p_args->'result';
    if t.knowledge_state<>'RUNNING' or jsonb_typeof(result) is distinct from 'object'
       or jsonb_typeof(result->'sources') is distinct from 'array' or jsonb_typeof(result->'text') is distinct from 'string'
       or length(btrim(result->>'text')) not between 1 and 6000 or octet_length(result::text)>40000 then
      raise exception 'knowledge_unverified_result'; end if;
    if (result-array['protocol','independentlyVerified','completeRequiredFacts','text','sources'])<>'{}'::jsonb then raise exception 'knowledge_result_fields'; end if;
    if result->>'protocol'='safe-unavailable-v1' and t.knowledge_publication_v2 then
      if result->'independentlyVerified' is distinct from 'false'::jsonb
        or result->'completeRequiredFacts' is distinct from 'false'::jsonb
        or result->>'text' is distinct from safe_text or jsonb_array_length(result->'sources')<>0 then
        raise exception 'knowledge_unsafe_unavailable'; end if;
    else
      if result->'independentlyVerified' is distinct from 'true'::jsonb or
        (t.knowledge_publication_v2 and t.knowledge_fence>t.knowledge_run_attempts) or not coalesce((
          (result->>'protocol'='evidence-first-v2' and result->'completeRequiredFacts'='true'::jsonb) or
          (t.knowledge_publication_v2 and result->>'protocol'='evidence-first-partial-v1'
            and result->'completeRequiredFacts'='false'::jsonb)),false) then
        raise exception 'knowledge_unverified_result'; end if;
      if jsonb_array_length(result->'sources') not between 1 and 10 then raise exception 'knowledge_source_bounds'; end if;
    end if;
    if
      (select count(*)<>count(distinct s->>'id') from jsonb_array_elements(result->'sources') s) or exists(select 1 from jsonb_array_elements(result->'sources') s
      where (s-array['id','revision'])<>'{}'::jsonb or coalesce(s->>'id','') !~ '^[A-Za-z0-9:_-]{1,160}$' or coalesce(s->>'revision','') !~ '^[A-Za-z0-9:_-]{1,160}$') then raise exception 'knowledge_source_bounds'; end if;
    update public.odin_tasks set knowledge_result=result,knowledge_result_digest=encode(sha256(convert_to(
      (result->>'protocol')||E'\n'||octet_length(convert_to(result->>'text','UTF8'))::text||':'||(result->>'text')||E'\n'||
      jsonb_array_length(result->'sources')::text||E'\n'||
      coalesce((select string_agg(length(s->>'id')::text||':'||(s->>'id')||length(s->>'revision')::text||':'||(s->>'revision'),E'\n' order by ord)
        from jsonb_array_elements(result->'sources') with ordinality as sources(s,ord)),''), 'UTF8')),'hex'),
      knowledge_state='VERIFIED',task_revision=task_revision+1 where id=t.id returning * into t;
  elsif p_command='fail' then
    update public.odin_tasks set knowledge_state='FAILED',knowledge_owner=null,knowledge_lease_until=null,task_revision=task_revision+1 where id=t.id returning * into t;
  elsif p_command in ('finalize','progress','claim_delivery','settle_delivery','withdraw_result') then
    valid_authority:=coalesce(receipt->'allowed'='true'::jsonb and receipt->>'taskId'=t.id::text
      and receipt->>'turnId'=t.knowledge_turn_id::text and (receipt->>'sequence')::bigint=c.knowledge_sequence
      and (receipt->>'businessId')::bigint=p_business and receipt->>'channel'=p_channel and receipt->>'account'=p_account
      and receipt->>'conversationId'=p_conversation::text
      and receipt->>'phase'=case when p_command='finalize' or (p_command='withdraw_result' and t.knowledge_state='VERIFIED') then 'finalize' else 'send' end
      and (receipt->>'checkedAt')::timestamptz between n-interval '1 second' and n
      and (receipt->>'resultDigest') is not distinct from t.knowledge_result_digest,false);
    if p_command='withdraw_result' then
      -- Retain the sealed facts and preserve the original delivery ID and send budget.
      if not valid_authority or receipt->'withdrawResult' is distinct from 'true'::jsonb or not t.knowledge_publication_v2 or t.knowledge_withdrawn_result is not null
        or coalesce(t.knowledge_result->>'protocol','') not in ('evidence-first-v2','evidence-first-partial-v1') then return null; end if;
      if t.knowledge_state='VERIFIED' then
        if t.knowledge_owner is distinct from owner_id or t.knowledge_fence is distinct from (p_args->>'fence')::bigint
          or t.knowledge_lease_until is null or t.knowledge_lease_until<=n then return null; end if;
      elsif t.knowledge_state='FINALIZED' then
        select * into d from public.odin_outbox where id=(p_args->>'deliveryId')::uuid and business_id=p_business
          and conversation_id=p_conversation and channel=p_channel and knowledge_task_id=t.id and knowledge_kind='final' for update;
        if not found or d.knowledge_state not in ('PENDING','FAILED') or d.knowledge_terminal_reason is not null
          or d.attempt_count>=d.knowledge_max_attempts or d.available_at>n or d.artifact->>'text' is distinct from t.knowledge_result->>'text'
          then return null; end if;
        update public.odin_outbox set artifact=jsonb_set(artifact,'{text}',to_jsonb(safe_text)) where id=d.id;
      else return null;
      end if;
      if clock_timestamp()>=t.knowledge_expires_at or (t.knowledge_state='VERIFIED' and clock_timestamp()>=t.knowledge_lease_until)
        or (receipt->>'checkedAt')::timestamptz<clock_timestamp()-interval '1 second' then
        raise exception 'knowledge_authority_expired_during_withdrawal'; end if;
      update public.odin_tasks set knowledge_withdrawn_result=jsonb_build_object('result',knowledge_result,'digest',knowledge_result_digest),
        knowledge_result=jsonb_build_object('protocol','safe-unavailable-v1','independentlyVerified',false,
          'completeRequiredFacts',false,'text',safe_text,'sources','[]'::jsonb),
        knowledge_result_digest=encode(sha256(convert_to('safe-unavailable-v1'||E'\n'||
          octet_length(convert_to(safe_text,'UTF8'))::text||':'||safe_text||E'\n0\n','UTF8')),'hex'),
        task_revision=task_revision+1 where id=t.id returning * into t;
      return to_jsonb(t);
    end if;
    if p_command='finalize' then
      if t.knowledge_state<>'VERIFIED' or t.knowledge_result is null or not valid_authority then return null; end if;
      kind:='final'; body:=t.knowledge_result->>'text';
    elsif p_command='progress' then
      if t.knowledge_state not in ('ACCEPTED','RUNNING','VERIFIED') then return null; end if;
      kind:='progress'; body:=p_args->>'text';
      if body is null or length(body) not between 1 and 240 then raise exception 'knowledge_progress_bounds'; end if;
    end if;
    if p_command in ('finalize','progress') then
      key:='knowledge:v1:'||t.knowledge_turn_id::text||':'||kind;
      -- Separate progress/final keys; caller cannot select another recipient.
      -- Recipient key is a scoped conversation reference, resolved by the future
      -- transport bridge. Never pass this directly as a provider recipient ID.
      insert into public.odin_outbox(business_id,conversation_id,schema_version,channel,recipient_key,delivery_key,artifact,status,attempt_count,
        knowledge_task_id,knowledge_kind,knowledge_state)
      values(p_business,p_conversation,1,p_channel,c.conversation_key,key,
        jsonb_build_object('text',body,'requiresLiveAuthorization',true),'pending',0,t.id,kind,'PENDING')
      on conflict (business_id,knowledge_task_id,knowledge_kind) where knowledge_task_id is not null do nothing;
      select * into d from public.odin_outbox where business_id=p_business and knowledge_task_id=t.id and knowledge_kind=kind;
      if p_command='finalize' then
        if clock_timestamp()>=t.knowledge_expires_at or clock_timestamp()>=t.knowledge_lease_until
          or (receipt->>'checkedAt')::timestamptz<clock_timestamp()-interval '1 second' then
          raise exception 'knowledge_authority_expired_during_commit'; end if;
        update public.odin_tasks set knowledge_state='FINALIZED',knowledge_owner=null,knowledge_lease_until=null,task_revision=task_revision+1 where id=t.id;
        update public.odin_outbox set knowledge_state='SUPERSEDED' where knowledge_task_id=t.id and knowledge_kind='progress' and knowledge_state in ('PENDING','FAILED');
      end if;
      return to_jsonb(d);
    end if;
    select * into d from public.odin_outbox where id=(p_args->>'deliveryId')::uuid and business_id=p_business and knowledge_task_id=t.id for update;
    if not found then return null; end if;
    if p_command='claim_delivery' then
      if d.knowledge_state not in ('PENDING','FAILED') or d.attempt_count>=d.knowledge_max_attempts or not valid_authority
        or t.knowledge_state in ('FAILED','EXPIRED','SUPERSEDED') or (d.knowledge_kind='final' and t.knowledge_state<>'FINALIZED') then return null; end if;
      update public.odin_outbox set knowledge_state='SENDING',knowledge_fence=knowledge_fence+1,knowledge_owner=owner_id,
        knowledge_lease_until=least(n+lease_ms*interval '1 millisecond',t.knowledge_expires_at),attempt_count=attempt_count+1,last_attempt_at=n where id=d.id returning * into d;
    else
      if d.knowledge_state<>'SENDING' or d.knowledge_owner is distinct from owner_id or d.knowledge_fence is distinct from (p_args->>'fence')::bigint
        or d.knowledge_lease_until is null or d.knowledge_lease_until<=n then return null; end if;
      if p_args->>'outcome' not in ('API_ACCEPTED','DEFINITIVELY_UNSENT','AMBIGUOUS') or p_args->>'outcome' is null then raise exception 'knowledge_invalid_delivery_outcome'; end if;
      if p_args->>'outcome'='API_ACCEPTED' and (length(coalesce(p_args->>'providerMessageId','')) not between 1 and 256 or coalesce(p_args->>'providerMessageId','') !~ '^[A-Za-z0-9:_.=+/-]+$') then raise exception 'knowledge_provider_id'; end if;
      if p_args->>'outcome'='DEFINITIVELY_UNSENT' and jsonb_typeof(p_args->'retryable') is distinct from 'boolean' then raise exception 'knowledge_retry_outcome'; end if;
      update public.odin_outbox set knowledge_state=case p_args->>'outcome' when 'API_ACCEPTED' then 'SENT' when 'AMBIGUOUS' then 'UNCERTAIN' else 'FAILED' end,
        knowledge_max_attempts=case when p_args->>'outcome'='DEFINITIVELY_UNSENT' and p_args->'retryable'='false'::jsonb then attempt_count else knowledge_max_attempts end,
        provider_message_id=case when p_args->>'outcome'='API_ACCEPTED' then p_args->>'providerMessageId' else provider_message_id end,
        knowledge_owner=null,knowledge_lease_until=null where id=d.id returning * into d;
    end if;
    if p_command='claim_delivery' and (clock_timestamp()>=d.knowledge_lease_until
      or (receipt->>'checkedAt')::timestamptz<clock_timestamp()-interval '1 second') then
      raise exception 'knowledge_delivery_authority_expired_during_claim'; end if;
    return to_jsonb(d);
  else raise exception 'knowledge_unknown_transition';
  end if;
  return to_jsonb(t);
end $body$),
    ('public.odin_guard_knowledge_identity_v1()', $body$
begin
  if old.knowledge_turn_id is null then return new; end if;
  if row(new.id,new.business_id,new.conversation_id,new.task_type,new.payload,new.knowledge_turn_id,new.knowledge_inbox_id,
      new.knowledge_channel,new.knowledge_account,new.knowledge_sequence,new.knowledge_accepted_at,new.knowledge_expires_at,
      new.knowledge_max_runs,new.knowledge_max_models)
    is distinct from row(old.id,old.business_id,old.conversation_id,old.task_type,old.payload,old.knowledge_turn_id,old.knowledge_inbox_id,
      old.knowledge_channel,old.knowledge_account,old.knowledge_sequence,old.knowledge_accepted_at,old.knowledge_expires_at,
      old.knowledge_max_runs,old.knowledge_max_models) then raise exception 'knowledge_immutable_acceptance'; end if;
  if new.knowledge_run_attempts<old.knowledge_run_attempts or new.knowledge_model_attempts<old.knowledge_model_attempts
    or new.knowledge_fence<old.knowledge_fence then raise exception 'knowledge_accounting_regression'; end if;
  if old.knowledge_result is not null and (new.knowledge_result is distinct from old.knowledge_result
    or new.knowledge_result_digest is distinct from old.knowledge_result_digest) and not coalesce((
      old.knowledge_publication_v2 and old.knowledge_state in ('VERIFIED','FINALIZED') and old.knowledge_withdrawn_result is null
      and old.knowledge_result->>'protocol' in ('evidence-first-v2','evidence-first-partial-v1')
      and new.knowledge_state=old.knowledge_state and new.knowledge_result->>'protocol'='safe-unavailable-v1'
      and new.knowledge_withdrawn_result=jsonb_build_object('result',old.knowledge_result,'digest',old.knowledge_result_digest)),false)
    then raise exception 'knowledge_immutable_result'; end if;
  if old.knowledge_withdrawn_result is not null and new.knowledge_withdrawn_result is distinct from old.knowledge_withdrawn_result then
    raise exception 'knowledge_immutable_withdrawn_result'; end if;
  if new.knowledge_state is distinct from old.knowledge_state and not (
    (old.knowledge_state='ACCEPTED' and new.knowledge_state in ('RUNNING','FAILED','EXPIRED','SUPERSEDED')) or
    (old.knowledge_state='RUNNING' and new.knowledge_state in ('VERIFIED','FAILED','EXPIRED','SUPERSEDED')) or
    (old.knowledge_state='VERIFIED' and new.knowledge_state in ('FINALIZED','FAILED','EXPIRED','SUPERSEDED')) or
    (old.knowledge_state='FINALIZED' and new.knowledge_state='SUPERSEDED')
  ) then raise exception 'knowledge_invalid_transition'; end if;
  return new;
end $body$),
    ('public.odin_transition_knowledge_v2(bigint,uuid,uuid,text,text,text,jsonb)', $body$
declare c public.odin_conversations%rowtype; t public.odin_tasks%rowtype; d public.odin_outbox%rowtype;
  r jsonb; n timestamptz; delay_ms integer; late boolean;
begin
  select * into c from public.odin_conversations where business_id=p_business and id=p_conversation for update;
  if not found then return null; end if;
  if p_command not in ('cleanup','settle_delivery','reject_delivery','defer_delivery') and
    (c.knowledge_channel is distinct from p_channel or c.knowledge_account is distinct from p_account) then return null; end if;
  select * into t from public.odin_tasks where business_id=p_business and conversation_id=p_conversation and id=p_task
    and task_type='knowledge_async_v1' and knowledge_channel=p_channel and knowledge_account=p_account
    and knowledge_turn_id is not null for update;
  if not found then return null; end if;
  n:=clock_timestamp();
  if p_command in ('settle_delivery','reject_delivery','defer_delivery','claim_delivery') then
    select * into d from public.odin_outbox where business_id=p_business and conversation_id=p_conversation
      and knowledge_task_id=p_task and channel=p_channel and id=(p_args->>'deliveryId')::uuid for update;
    if not found then return null; end if;
  end if;
  -- Factual settlement never grants send authority. Retain original sender and
  -- fence across quarantine so a late positive provider receipt can be recorded
  -- after expiry/supersession, without resending or claiming customer delivery.
  if p_command='settle_delivery' then
    if d.knowledge_fence is distinct from (p_args->>'fence')::bigint or
      coalesce(d.knowledge_last_owner,d.knowledge_owner) is distinct from p_args->>'owner' then return null; end if;
    if d.knowledge_state='SENT' then
      return case when p_args->>'outcome'='API_ACCEPTED' and d.provider_message_id=p_args->>'providerMessageId' then to_jsonb(d) else null end;
    end if;
    if d.knowledge_state not in ('SENDING','UNCERTAIN') then return null; end if;
    if coalesce(p_args->>'outcome','') not in ('API_ACCEPTED','AMBIGUOUS','DEFINITIVELY_UNSENT') then raise exception 'knowledge_delivery_outcome'; end if;
    if p_args->>'outcome'='API_ACCEPTED' and (length(coalesce(p_args->>'providerMessageId','')) not between 1 and 256
      or coalesce(p_args->>'providerMessageId','') !~ '^[A-Za-z0-9:_.=+/-]+$') then raise exception 'knowledge_provider_id'; end if;
    if p_args->>'outcome'='DEFINITIVELY_UNSENT' and jsonb_typeof(p_args->'retryable') is distinct from 'boolean' then raise exception 'knowledge_retry_outcome'; end if;
    delay_ms:=coalesce((p_args->>'retryAfterMs')::integer,least(8000,1000*power(2,greatest(0,d.attempt_count-1))::integer));
    if delay_ms not between 0 and 60000 then raise exception 'knowledge_retry_delay'; end if;
    delay_ms:=greatest(1000,delay_ms);
    late:=d.knowledge_state='UNCERTAIN' or d.knowledge_lease_until is null or d.knowledge_lease_until<=n or t.knowledge_expires_at<=n
      or t.knowledge_sequence<>c.knowledge_sequence or t.knowledge_state<>'FINALIZED'
      or c.knowledge_channel is distinct from t.knowledge_channel or c.knowledge_account is distinct from t.knowledge_account;
    update public.odin_outbox set knowledge_last_owner=coalesce(knowledge_last_owner,knowledge_owner),
      knowledge_state=case when p_args->>'outcome'='API_ACCEPTED' then 'SENT' when p_args->>'outcome'='AMBIGUOUS' then 'UNCERTAIN'
        when not late and p_args->'retryable'='true'::jsonb and attempt_count<knowledge_max_attempts and n+delay_ms*interval '1 millisecond'>=t.knowledge_expires_at then 'EXPIRED' else 'FAILED' end,
      knowledge_terminal_reason=case when p_args->>'outcome'='API_ACCEPTED' then null when p_args->>'outcome'='AMBIGUOUS' then 'DELIVERY_UNCERTAIN'
        when late then 'LATE_UNSENT' when p_args->'retryable'='false'::jsonb then 'DEFINITIVELY_UNSENT'
        when attempt_count>=knowledge_max_attempts then 'ATTEMPTS_EXHAUSTED' else null end,
      available_at=case when p_args->>'outcome'='DEFINITIVELY_UNSENT' then n+delay_ms*interval '1 millisecond' else available_at end,
      provider_message_id=case when p_args->>'outcome'='API_ACCEPTED' then p_args->>'providerMessageId' else provider_message_id end,
      knowledge_owner=null,knowledge_lease_until=null where id=d.id returning * into d;
    return to_jsonb(d);
  end if;
  -- Preserve sender evidence before the old recovery function clears its lease.
  update public.odin_outbox set knowledge_last_owner=coalesce(knowledge_last_owner,knowledge_owner)
    where knowledge_task_id=t.id and knowledge_kind='final' and knowledge_state='SENDING';
  if p_command='cleanup' then
    if c.knowledge_channel is distinct from t.knowledge_channel or c.knowledge_account is distinct from t.knowledge_account then
      update public.odin_tasks set knowledge_state='SUPERSEDED',knowledge_owner=null,knowledge_lease_until=null
        where id=t.id and knowledge_state not in ('FAILED','EXPIRED','SUPERSEDED');
      update public.odin_outbox set knowledge_state='SUPERSEDED' where knowledge_task_id=t.id and knowledge_state in ('PENDING','FAILED');
      update public.odin_outbox set knowledge_state='UNCERTAIN',knowledge_owner=null,knowledge_lease_until=null
        where knowledge_task_id=t.id and knowledge_state='SENDING' and knowledge_lease_until<=n;
      return null;
    end if;
    perform public.odin_transition_knowledge_v1(p_business,p_conversation,p_task,p_channel,p_account,'recover','{}');
    update public.odin_tasks set knowledge_state='FAILED',knowledge_owner=null,knowledge_lease_until=null,task_revision=task_revision+1
      where id=t.id and knowledge_state in ('ACCEPTED','RUNNING','VERIFIED') and coalesce(knowledge_lease_until,n)<=n
      and not knowledge_publication_v2 and (knowledge_run_attempts>=knowledge_max_runs or knowledge_state<>'VERIFIED' and knowledge_model_attempts>=knowledge_max_models);
    update public.odin_outbox set knowledge_state='FAILED',knowledge_terminal_reason='ATTEMPTS_EXHAUSTED'
      where knowledge_task_id=t.id and knowledge_state in ('PENDING','FAILED') and attempt_count>=knowledge_max_attempts;
    return to_jsonb(t);
  end if;
  if p_command='interrupt' then
    if t.knowledge_state not in ('RUNNING','VERIFIED') or t.knowledge_owner is distinct from p_args->>'owner'
      or t.knowledge_fence is distinct from (p_args->>'fence')::bigint or t.knowledge_lease_until is null or t.knowledge_lease_until<=n then return null; end if;
    if t.knowledge_sequence<>c.knowledge_sequence or t.knowledge_expires_at<=n then
      perform public.odin_transition_knowledge_v1(p_business,p_conversation,p_task,p_channel,p_account,'recover','{}'); return null; end if;
    update public.odin_tasks set knowledge_owner=null,knowledge_lease_until=null,task_revision=task_revision+1,
      knowledge_available_at=n+least(8000,1000*power(2,greatest(0,knowledge_run_attempts-1))::integer)*interval '1 millisecond',
      knowledge_state=case when not knowledge_publication_v2 and (knowledge_run_attempts>=knowledge_max_runs or knowledge_state<>'VERIFIED' and knowledge_model_attempts>=knowledge_max_models) then 'FAILED' else knowledge_state end
      where id=t.id returning * into t;
    return to_jsonb(t);
  end if;
  if p_command='reject_task' then
    if t.knowledge_state not in ('ACCEPTED','RUNNING','VERIFIED') or t.knowledge_lease_until>n then return null; end if;
    update public.odin_tasks set knowledge_state='FAILED',knowledge_owner=null,knowledge_lease_until=null,task_revision=task_revision+1
      where id=t.id returning * into t;
    return to_jsonb(t);
  end if;
  if p_command='defer_delivery' then
    -- A preflight storage/provider exception grants no send authority. Bound
    -- repeated failures before claim so a stalled head cannot starve new work.
    if d.knowledge_state not in ('PENDING','FAILED') or d.knowledge_terminal_reason is not null then return null; end if;
    update public.odin_outbox set knowledge_preflight_attempts=least(3,knowledge_preflight_attempts+1),
      available_at=n+power(2,knowledge_preflight_attempts)*interval '1 second',
      knowledge_state=case when knowledge_preflight_attempts>=2 then 'FAILED' else knowledge_state end,
      knowledge_terminal_reason=case when knowledge_preflight_attempts>=2 then 'PREFLIGHT_EXHAUSTED' else null end
      where id=d.id returning * into d;
    return to_jsonb(d);
  end if;
  if p_command='reject_delivery' then
    if d.knowledge_state not in ('PENDING','FAILED') then return null; end if;
    update public.odin_outbox set knowledge_state='FAILED',knowledge_terminal_reason='AUTHORITY_REJECTED' where id=d.id returning * into d;
    return to_jsonb(d);
  end if;
  if p_command='claim' and t.knowledge_available_at>n then return null; end if;
  if p_command='claim_delivery' and (d.knowledge_terminal_reason is not null or d.available_at>n) then return null; end if;
  r:=public.odin_transition_knowledge_v1(p_business,p_conversation,p_task,p_channel,p_account,p_command,p_args);
  if p_command='claim_delivery' and r is not null then
    update public.odin_outbox set knowledge_last_owner=knowledge_owner where id=d.id returning * into d; return to_jsonb(d);
  end if;
  return r;
end $body$),
    ('public.odin_discover_knowledge_v2(text,integer)', $body$
declare x record; n timestamptz:=clock_timestamp(); r jsonb;
begin
  if p_kind is null or p_kind not in ('work','delivery') or p_limit is null or p_limit not between 1 and 100 then raise exception 'knowledge_discovery_limit'; end if;
  -- Maintenance does not depend on provider eligibility or canonical credentials.
  -- Its bounded scan cannot hold newer work behind old expired/leased rows.
  for x in select t.id,t.business_id,t.conversation_id,t.knowledge_channel,t.knowledge_account
    from public.odin_tasks t join public.odin_conversations c on c.id=t.conversation_id and c.business_id=t.business_id
    where t.task_type='knowledge_async_v1' and t.knowledge_turn_id is not null and (
      t.knowledge_state in ('ACCEPTED','RUNNING','VERIFIED') and (t.knowledge_expires_at<=n or t.knowledge_sequence<>c.knowledge_sequence or t.knowledge_channel is distinct from c.knowledge_channel or t.knowledge_account is distinct from c.knowledge_account or
        not t.knowledge_publication_v2 and coalesce(t.knowledge_lease_until,n)<=n and (t.knowledge_run_attempts>=t.knowledge_max_runs or t.knowledge_state<>'VERIFIED' and t.knowledge_model_attempts>=t.knowledge_max_models))
      or exists(select 1 from public.odin_outbox d where d.knowledge_task_id=t.id and (
        d.knowledge_state='SENDING' and d.knowledge_lease_until<=n or d.knowledge_state in ('PENDING','FAILED') and d.knowledge_terminal_reason is null
        and (t.knowledge_expires_at<=n or t.knowledge_sequence<>c.knowledge_sequence or t.knowledge_channel is distinct from c.knowledge_channel or t.knowledge_account is distinct from c.knowledge_account or d.attempt_count>=d.knowledge_max_attempts))))
    order by t.knowledge_expires_at,t.id limit 16 loop
    begin
      perform public.odin_transition_knowledge_v2(x.business_id,x.conversation_id,x.id,x.knowledge_channel,x.knowledge_account,'cleanup','{}');
    exception when lock_not_available then null; end;
  end loop;
  if p_kind='work' then
    select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) into r from (
      select t.id as "taskId",jsonb_build_object('businessId',t.business_id,'conversationId',t.conversation_id,'channel',t.knowledge_channel,'providerAccount',t.knowledge_account) as scope
      from public.odin_tasks t join public.odin_conversations c on c.id=t.conversation_id and c.business_id=t.business_id
      where t.task_type='knowledge_async_v1' and t.knowledge_turn_id is not null and t.knowledge_state in ('ACCEPTED','RUNNING','VERIFIED')
        and t.knowledge_expires_at>clock_timestamp() and t.knowledge_available_at<=clock_timestamp()
        and coalesce(t.knowledge_lease_until,clock_timestamp())<=clock_timestamp()
        and (t.knowledge_publication_v2 or (t.knowledge_run_attempts<t.knowledge_max_runs
          and (t.knowledge_state='VERIFIED' or t.knowledge_model_attempts<t.knowledge_max_models)))
        and t.knowledge_sequence=c.knowledge_sequence and t.knowledge_channel=c.knowledge_channel and t.knowledge_account=c.knowledge_account
      order by t.knowledge_expires_at,t.id limit p_limit for update of c,t skip locked) q;
  else
    select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) into r from (
      select t.id as "taskId",d.id as "deliveryId",jsonb_build_object('businessId',t.business_id,'conversationId',t.conversation_id,'channel',t.knowledge_channel,'providerAccount',t.knowledge_account) as scope
      from public.odin_outbox d join public.odin_tasks t on t.id=d.knowledge_task_id and t.business_id=d.business_id and t.conversation_id=d.conversation_id
        join public.odin_conversations c on c.id=t.conversation_id and c.business_id=t.business_id
      where d.knowledge_kind='final' and d.knowledge_state in ('PENDING','FAILED') and d.knowledge_terminal_reason is null
        and d.available_at<=clock_timestamp() and d.attempt_count<d.knowledge_max_attempts and t.knowledge_state='FINALIZED'
        and t.knowledge_expires_at>clock_timestamp() and t.knowledge_sequence=c.knowledge_sequence
        and t.knowledge_channel=c.knowledge_channel and t.knowledge_account=c.knowledge_account
      order by d.available_at,d.id limit p_limit for update of c,t,d skip locked) q;
  end if;
  return r;
end $body$)
  ) as patches(signature, body) loop
    select prosrc, pg_get_functiondef(oid) into strict old_body, def
      from pg_catalog.pg_proc where oid=to_regprocedure(patch.signature);
    if strpos(def,delimiter||old_body||delimiter)=0 then raise exception 'knowledge_publication_definition_layout'; end if;
    execute replace(def,delimiter||old_body||delimiter,delimiter||patch.body||delimiter);
  end loop;
end $install$;
do $guard$
declare expected record; p pg_catalog.pg_proc%rowtype;
begin
  for expected in select * from (values
    ('public.odin_accept_knowledge_turn_v2(bigint,uuid,text,text,text,text,jsonb,jsonb,integer,integer,integer)', 8899, 'c3e324692116dd0016569028f8cdda56', '6d5f24dcf146ece0c4cb54f1f4aeb11d13ebcccdea20a2e765adb51c721b7ebb'),
    ('public.odin_native_intake_v1(bigint,uuid,text,text,text,text,jsonb,text,uuid,text,jsonb,integer)', 180, 'f566426164e448da40461ca2a1c56edf', '39522af787e6b17862a65e6ecd4e7816c8d60c08396493fdc28c5b495cbeec6e'),
    ('public.odin_transition_knowledge_v1(bigint,uuid,uuid,text,text,text,jsonb)', 16988, '0d345c8884265faca45564a443a8c078', 'd9009a01df78acf3365185e930488687af6c12eb5bf69940ffb7c815c7cf8945'),
    ('public.odin_guard_knowledge_identity_v1()', 2492, 'ce9494eaa049d738b0dcdaef122ec423', '4c0a93d1f770a361caadb9623652f25daa31e7c07085430f1e48604e1a273fef'),
    ('public.odin_transition_knowledge_v2(bigint,uuid,uuid,text,text,text,jsonb)', 9192, '2d8e6504f1d6d63e99362063c1c80688', '9c13247a0c46260360926267b020c21bfe2d5c842d7fa3f5895426428e611ade'),
    ('public.odin_discover_knowledge_v2(text,integer)', 4198, 'd5a69dcc31913573504b0d703cdd0302', '479de8a21f7fcbaecdfac48400611d563dc0d21d90e56f4acbc62caa8d7a4d07'),
    ('public.odin_native_intake_v2(bigint,uuid,text,text,text,text,jsonb,text,uuid,text,jsonb,integer,integer)', 5973, '41194f86753afce529e01b468f77acaa', '712115014b13ec79b78063a5632edfbbc24085205a5332a03dcfafc88625cc26')
  ) as pins(signature, body_bytes, body_md5, body_sha256) loop
    select * into p from pg_catalog.pg_proc where oid=to_regprocedure(expected.signature);
    if not found or p.prosecdef or octet_length(p.prosrc)<>expected.body_bytes or md5(p.prosrc)<>expected.body_md5
      or encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')<>expected.body_sha256
      or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
      or not has_function_privilege('service_role',p.oid,'EXECUTE')
      or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE')
    then raise exception 'knowledge_publication_fingerprint_or_acl: %', expected.signature; end if;
  end loop;
end $guard$;
commit;
