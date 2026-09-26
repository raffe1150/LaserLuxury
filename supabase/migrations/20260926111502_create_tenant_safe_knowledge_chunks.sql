alter table public.knowledge_sources
  add constraint knowledge_sources_id_business_unique
  unique (id, business_id);

create table public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),

  business_id bigint not null
    references public.businesses(id)
    on delete cascade,

  source_id uuid not null,

  chunk_index integer not null,

  content text not null,

  metadata jsonb not null default '{}'::jsonb,

  search_vector tsvector generated always as (
    to_tsvector('simple'::regconfig, content)
  ) stored,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint knowledge_chunks_source_business_fkey
    foreign key (source_id, business_id)
    references public.knowledge_sources(id, business_id)
    on delete cascade,

  constraint knowledge_chunks_business_id_positive
    check (business_id > 0),

  constraint knowledge_chunks_chunk_index_nonnegative
    check (chunk_index >= 0),

  constraint knowledge_chunks_content_nonempty
    check (nullif(btrim(content), '') is not null),

  constraint knowledge_chunks_metadata_object
    check (jsonb_typeof(metadata) = 'object'),

  constraint knowledge_chunks_timestamps_valid
    check (updated_at >= created_at),

  constraint knowledge_chunks_source_chunk_unique
    unique (source_id, chunk_index)
);

comment on table public.knowledge_chunks is
  'Tenant-scoped searchable chunks derived from OdinLink business knowledge sources.';

comment on column public.knowledge_chunks.search_vector is
  'Deterministic multilingual PostgreSQL full-text index using the simple configuration.';

create index knowledge_chunks_business_source_idx
  on public.knowledge_chunks (business_id, source_id, chunk_index);

create index knowledge_chunks_business_created_idx
  on public.knowledge_chunks (business_id, created_at desc);

create index knowledge_chunks_search_vector_idx
  on public.knowledge_chunks
  using gin (search_vector);

create function public.set_knowledge_chunk_updated_at()
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

create trigger knowledge_chunks_set_updated_at
before update on public.knowledge_chunks
for each row
execute function public.set_knowledge_chunk_updated_at();

alter table public.knowledge_chunks enable row level security;

create policy knowledge_chunks_read_active_business_member
  on public.knowledge_chunks
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.business_memberships bm
      where bm.business_id = knowledge_chunks.business_id
        and bm.user_id = auth.uid()
        and bm.status = 'active'
    )
  );

revoke all on table public.knowledge_chunks from anon, authenticated;
grant select on table public.knowledge_chunks to authenticated;

revoke all on function public.set_knowledge_chunk_updated_at()
  from public, anon, authenticated;

create function public.replace_knowledge_chunks(
  p_business_id bigint,
  p_source_id uuid,
  p_chunks jsonb
)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if p_business_id is null or p_business_id <= 0 then
    raise exception 'invalid_business_id';
  end if;

  if p_source_id is null then
    raise exception 'invalid_source_id';
  end if;

  if p_chunks is null or jsonb_typeof(p_chunks) <> 'array' then
    raise exception 'invalid_chunks_payload';
  end if;

  if not exists (
    select 1
    from public.knowledge_sources ks
    where ks.id = p_source_id
      and ks.business_id = p_business_id
  ) then
    raise exception 'knowledge_source_scope_mismatch';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_chunks) item
    where
      jsonb_typeof(item) <> 'object'
      or not (item ? 'chunk_index')
      or not (item ? 'content')
      or (item->>'chunk_index') !~ '^[0-9]+$'
      or nullif(btrim(item->>'content'), '') is null
      or (
        item ? 'metadata'
        and jsonb_typeof(item->'metadata') <> 'object'
      )
  ) then
    raise exception 'invalid_chunk';
  end if;

  delete from public.knowledge_chunks
  where business_id = p_business_id
    and source_id = p_source_id;

  insert into public.knowledge_chunks (
    business_id,
    source_id,
    chunk_index,
    content,
    metadata
  )
  select
    p_business_id,
    p_source_id,
    (item->>'chunk_index')::integer,
    btrim(item->>'content'),
    case
      when item ? 'metadata' then item->'metadata'
      else '{}'::jsonb
    end
  from jsonb_array_elements(p_chunks) item;
end;
$$;

revoke all on function public.replace_knowledge_chunks(bigint, uuid, jsonb)
  from public, anon, authenticated;

grant execute on function public.replace_knowledge_chunks(bigint, uuid, jsonb)
  to service_role;

create function public.search_knowledge_chunks(
  p_business_id bigint,
  p_query text,
  p_limit integer default 5
)
returns table (
  source_id uuid,
  business_id bigint,
  chunk_index integer,
  content text,
  metadata jsonb,
  score real
)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with query_tokens as (
    select distinct lexeme
    from pg_catalog.ts_debug('simple', p_query) as debug,
         lateral unnest(debug.lexemes) as lexeme
    where nullif(btrim(lexeme), '') is not null
  ),
  query_expression as (
    select
      case
        when count(*) = 0 then null::tsquery
        else to_tsquery(
          'simple'::regconfig,
          string_agg(quote_literal(lexeme), ' | ')
        )
      end as query
    from query_tokens
  )
  select
    kc.source_id,
    kc.business_id,
    kc.chunk_index,
    kc.content,
    kc.metadata,
    ts_rank_cd(kc.search_vector, qe.query)::real as score
  from public.knowledge_chunks kc
  join public.knowledge_sources ks
    on ks.id = kc.source_id
   and ks.business_id = kc.business_id
  cross join query_expression qe
  where kc.business_id = p_business_id
    and ks.status = 'ready'
    and nullif(btrim(p_query), '') is not null
    and qe.query is not null
    and kc.search_vector @@ qe.query
  order by score desc, kc.chunk_index asc
  limit greatest(1, least(coalesce(p_limit, 5), 10));
$$;

revoke all on function public.search_knowledge_chunks(bigint, text, integer)
  from public, anon, authenticated;

grant execute on function public.search_knowledge_chunks(bigint, text, integer)
  to service_role;
