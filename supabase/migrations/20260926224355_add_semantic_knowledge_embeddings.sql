create extension if not exists vector
with schema extensions;

alter table public.knowledge_chunks
  add column if not exists embedding extensions.vector(768);

alter table public.knowledge_chunks
  add column if not exists embedding_provider text;

alter table public.knowledge_chunks
  add column if not exists embedding_model text;

alter table public.knowledge_chunks
  add column if not exists embedding_dimensions integer;

alter table public.knowledge_chunks
  add column if not exists embedding_version integer;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'knowledge_chunks_embedding_dimensions_valid'
      and conrelid = 'public.knowledge_chunks'::regclass
  ) then
    alter table public.knowledge_chunks
      add constraint knowledge_chunks_embedding_dimensions_valid
      check (
        embedding_dimensions is null
        or embedding_dimensions > 0
      )
      not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'knowledge_chunks_embedding_version_valid'
      and conrelid = 'public.knowledge_chunks'::regclass
  ) then
    alter table public.knowledge_chunks
      add constraint knowledge_chunks_embedding_version_valid
      check (
        embedding_version is null
        or embedding_version > 0
      )
      not valid;
  end if;
end
$$;

create or replace function public.search_knowledge_chunks_semantic(
  p_business_id bigint,
  p_embedding extensions.vector(768),
  p_limit integer default 5,
  p_min_similarity real default 0.55,
  p_embedding_provider text default null,
  p_embedding_model text default null,
  p_embedding_version integer default null
)
returns table (
  source_id uuid,
  business_id bigint,
  content text,
  metadata jsonb,
  score real,
  embedding_provider text,
  embedding_model text,
  embedding_dimensions integer,
  embedding_version integer
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    kc.source_id,
    kc.business_id,
    kc.content,
    kc.metadata,
    (1 - (kc.embedding <=> p_embedding))::real as score,
    kc.embedding_provider,
    kc.embedding_model,
    kc.embedding_dimensions,
    kc.embedding_version
  from public.knowledge_chunks kc
  join public.knowledge_sources ks
    on ks.id = kc.source_id
   and ks.business_id = kc.business_id
  where
    kc.business_id = p_business_id
    and ks.status = 'ready'
    and kc.embedding is not null
    and (
      p_embedding_provider is null
      or kc.embedding_provider = p_embedding_provider
    )
    and (
      p_embedding_model is null
      or kc.embedding_model = p_embedding_model
    )
    and (
      p_embedding_version is null
      or kc.embedding_version = p_embedding_version
    )
    and (1 - (kc.embedding <=> p_embedding)) >= p_min_similarity
  order by kc.embedding <=> p_embedding
  limit greatest(1, least(coalesce(p_limit, 5), 10));
$$;

revoke all on function public.search_knowledge_chunks_semantic(
  bigint,
  extensions.vector,
  integer,
  real,
  text,
  text,
  integer
)
from public, anon, authenticated;

grant execute on function public.search_knowledge_chunks_semantic(
  bigint,
  extensions.vector,
  integer,
  real,
  text,
  text,
  integer
)
to service_role;

comment on column public.knowledge_chunks.embedding is
  'Provider-neutral semantic embedding vector for Knowledge retrieval.';

comment on column public.knowledge_chunks.embedding_provider is
  'Embedding provider identifier, for example google or openai.';

comment on column public.knowledge_chunks.embedding_model is
  'Embedding model identifier used to generate this vector.';

comment on column public.knowledge_chunks.embedding_dimensions is
  'Embedding vector dimensionality.';

comment on column public.knowledge_chunks.embedding_version is
  'Application-level embedding schema/version for safe reindexing.';

comment on function public.search_knowledge_chunks_semantic(
  bigint,
  extensions.vector,
  integer,
  real,
  text,
  text,
  integer
) is
  'Tenant-scoped semantic Knowledge retrieval over ready sources only, with optional embedding-provider/model/version matching.';
