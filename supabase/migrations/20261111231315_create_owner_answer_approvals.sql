-- Review draft. This file is outside the automatic migration directory.
begin;

create table public.knowledge_answer_approvals (
  id uuid primary key default gen_random_uuid(),
  business_id bigint not null,
  source_id uuid not null,
  source_revision text not null check (length(source_revision) = 64),
  language text not null check (language in ('fa','ar','en','sv','de','es')),
  reviewed_answer jsonb not null check (jsonb_typeof(reviewed_answer) = 'object'),
  approved_by uuid not null,
  approved_at timestamptz not null default now(),
  revoked_by uuid,
  revoked_at timestamptz,
  foreign key (source_id, business_id) references public.knowledge_sources(id, business_id) on delete cascade,
  check ((revoked_by is null) = (revoked_at is null))
);

-- Require explicit revocation before replacing an active approval.
create unique index knowledge_answer_approvals_one_active
  on public.knowledge_answer_approvals (business_id, source_id, language) where revoked_at is null;

alter table public.knowledge_answer_approvals enable row level security;
revoke all on public.knowledge_answer_approvals from public, anon, authenticated, service_role;
grant select, insert on public.knowledge_answer_approvals to service_role;
grant update (revoked_at, revoked_by) on public.knowledge_answer_approvals to service_role;

create function public.write_knowledge_answer_approval(
  p_business_id bigint, p_actor uuid, p_source_id uuid, p_revoke_id uuid,
  p_source_snapshot jsonb, p_revision text, p_language text, p_reviewed_answer jsonb
) returns uuid
language plpgsql security invoker set search_path = pg_catalog
as $$
declare
  source_row public.knowledge_sources%rowtype;
  approval_id uuid;
begin
  perform 1 from public.business_memberships
    where business_id = p_business_id and user_id = p_actor and role = 'owner' and status = 'active'
    for share;
  if not found then raise insufficient_privilege; end if;

  if p_revoke_id is not null then
    update public.knowledge_answer_approvals
      set revoked_at = now(), revoked_by = p_actor
      where id = p_revoke_id and business_id = p_business_id and revoked_at is null
      returning id into approval_id;
    return approval_id;
  end if;

  select * into source_row from public.knowledge_sources
    where id = p_source_id and business_id = p_business_id and status = 'ready'
    for share;
  if not found or p_source_snapshot is null or
     source_row.type is distinct from p_source_snapshot->>'type' or
     source_row.title is distinct from p_source_snapshot->>'title' or
     source_row.content is distinct from p_source_snapshot->>'content' or
     source_row.metadata is distinct from p_source_snapshot->'metadata' or
     source_row.updated_at is distinct from (p_source_snapshot->>'updated_at')::timestamptz
  then raise exception using errcode = 'P0001', message = 'stale_source'; end if;

  insert into public.knowledge_answer_approvals
    (business_id, source_id, source_revision, language, reviewed_answer, approved_by)
    values (p_business_id, p_source_id, p_revision, p_language, p_reviewed_answer, p_actor)
    returning id into approval_id;
  return approval_id;
end;
$$;
revoke all on function public.write_knowledge_answer_approval(bigint,uuid,uuid,uuid,jsonb,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.write_knowledge_answer_approval(bigint,uuid,uuid,uuid,jsonb,text,text,jsonb) to service_role;

commit;
