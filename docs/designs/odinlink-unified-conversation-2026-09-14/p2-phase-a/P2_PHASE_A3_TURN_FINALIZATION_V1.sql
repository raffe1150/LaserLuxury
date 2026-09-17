begin;

create or replace function public.odin_finalize_conversation_turn(
  p_business_id bigint,
  p_conversation_id uuid,
  p_inbox_id uuid,
  p_worker_id text,
  p_expected_revision bigint,
  p_fence_epoch bigint
)
returns table (
  outcome text,
  conversation_id uuid,
  inbox_id uuid,
  previous_revision bigint,
  new_revision bigint,
  fence_epoch bigint,
  inbox_status text
)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_conversation public.odin_conversations%rowtype;
  v_inbox public.odin_inbox%rowtype;
begin
  if p_business_id is null or p_business_id <= 0 then
    raise exception 'invalid_business_id';
  end if;

  if p_conversation_id is null then
    raise exception 'conversation_id_required';
  end if;

  if p_inbox_id is null then
    raise exception 'inbox_id_required';
  end if;

  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id_required';
  end if;

  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'invalid_expected_revision';
  end if;

  if p_fence_epoch is null or p_fence_epoch < 0 then
    raise exception 'invalid_fence_epoch';
  end if;

  select c.*
    into v_conversation
  from public.odin_conversations c
  where c.business_id = p_business_id
    and c.id = p_conversation_id
  for update;

  if not found then
    raise exception 'conversation_not_found';
  end if;

  if v_conversation.revision <> p_expected_revision then
    return query
    select
      'rejected_revision'::text,
      v_conversation.id,
      p_inbox_id,
      v_conversation.revision,
      v_conversation.revision,
      v_conversation.fence_epoch,
      null::text;
    return;
  end if;

  if v_conversation.lease_owner is distinct from p_worker_id then
    return query
    select
      'rejected_worker'::text,
      v_conversation.id,
      p_inbox_id,
      v_conversation.revision,
      v_conversation.revision,
      v_conversation.fence_epoch,
      null::text;
    return;
  end if;

  if v_conversation.fence_epoch <> p_fence_epoch then
    return query
    select
      'rejected_fence'::text,
      v_conversation.id,
      p_inbox_id,
      v_conversation.revision,
      v_conversation.revision,
      v_conversation.fence_epoch,
      null::text;
    return;
  end if;

  if (
    v_conversation.lease_expires_at is null
    or v_conversation.lease_expires_at <= clock_timestamp()
  ) then
    return query
    select
      'rejected_expired_lease'::text,
      v_conversation.id,
      p_inbox_id,
      v_conversation.revision,
      v_conversation.revision,
      v_conversation.fence_epoch,
      null::text;
    return;
  end if;

  select i.*
    into v_inbox
  from public.odin_inbox i
  where i.business_id = p_business_id
    and i.id = p_inbox_id
  for update;

  if not found then
    raise exception 'inbox_not_found';
  end if;

  if v_inbox.conversation_id is distinct from p_conversation_id then
    raise exception 'inbox_conversation_mismatch';
  end if;

  if v_inbox.status <> 'accepted' then
    return query
    select
      'already_finalized'::text,
      v_conversation.id,
      v_inbox.id,
      v_conversation.revision,
      v_conversation.revision,
      v_conversation.fence_epoch,
      v_inbox.status;
    return;
  end if;

  update public.odin_inbox
  set status = 'processed'
  where business_id = p_business_id
    and id = p_inbox_id;

  update public.odin_conversations
  set
    revision = revision + 1,
    lease_owner = null,
    lease_expires_at = null,
    updated_at = clock_timestamp()
  where business_id = p_business_id
    and id = p_conversation_id
  returning *
    into v_conversation;

  return query
  select
    'finalized'::text,
    v_conversation.id,
    p_inbox_id,
    p_expected_revision,
    v_conversation.revision,
    v_conversation.fence_epoch,
    'processed'::text;
end;
$$;

revoke all on function public.odin_finalize_conversation_turn(
  bigint,
  uuid,
  uuid,
  text,
  bigint,
  bigint
) from public, anon, authenticated;

commit;
