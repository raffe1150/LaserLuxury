create table public.knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  business_id bigint not null references public.businesses(id) on delete cascade,
  type text not null,
  title text not null,
  status text not null default 'pending',
  content text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint knowledge_sources_business_id_positive
    check (business_id > 0),

  constraint knowledge_sources_type_valid
    check (
      type = btrim(type)
      and type in ('faq', 'text', 'pdf', 'website')
    ),

  constraint knowledge_sources_status_valid
    check (
      status = btrim(status)
      and status in ('pending', 'ready', 'disabled', 'error')
    ),

  constraint knowledge_sources_title_nonempty
    check (nullif(btrim(title), '') is not null),

  constraint knowledge_sources_metadata_object
    check (jsonb_typeof(metadata) = 'object'),

  constraint knowledge_sources_timestamps_valid
    check (updated_at >= created_at)
);

comment on table public.knowledge_sources is
  'Tenant-scoped business knowledge sources for the shared OdinLink AI brain.';

comment on column public.knowledge_sources.business_id is
  'Owning OdinLink business. Knowledge is deleted automatically when the business is deleted.';

create index knowledge_sources_business_status_created_idx
  on public.knowledge_sources (business_id, status, created_at desc);

create index knowledge_sources_business_type_idx
  on public.knowledge_sources (business_id, type);

create function public.set_knowledge_source_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  new.updated_at = greatest(now(), new.created_at);
  return new;
end;
$$;

create trigger knowledge_sources_set_updated_at
before update on public.knowledge_sources
for each row
execute function public.set_knowledge_source_updated_at();

alter table public.knowledge_sources enable row level security;

create policy knowledge_sources_read_active_business_member
  on public.knowledge_sources
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.business_memberships bm
      where bm.business_id = knowledge_sources.business_id
        and bm.user_id = auth.uid()
        and bm.status = 'active'
    )
  );

revoke insert, update, delete on public.knowledge_sources from anon, authenticated;

grant select on public.knowledge_sources to authenticated;

revoke all on function public.set_knowledge_source_updated_at()
  from public, anon, authenticated;
