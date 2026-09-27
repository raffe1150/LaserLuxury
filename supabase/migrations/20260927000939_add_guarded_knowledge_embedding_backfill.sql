create function public.read_knowledge_embedding_backfill_source(
  p_business_id bigint,
  p_source_id uuid
)
returns table (
  business_id bigint,
  source_id uuid,
  source_status text,
  snapshot_token text,
  chunks jsonb
)
language sql
stable
security invoker
set search_path = pg_catalog, public, extensions
as $$
  select
    ks.business_id,
    ks.id,
    ks.status,
    md5(
      jsonb_build_object(
        'source', to_jsonb(ks),
        'chunks', coalesce(chunk_snapshot.chunks, '[]'::jsonb)
      )::text
    ) as snapshot_token,
    coalesce(chunk_snapshot.chunks, '[]'::jsonb) as chunks
  from public.knowledge_sources ks
  left join lateral (
    select jsonb_agg(
      jsonb_build_object(
        'id', kc.id,
        'business_id', kc.business_id,
        'source_id', kc.source_id,
        'chunk_index', kc.chunk_index,
        'content', kc.content,
        'metadata', kc.metadata,
        'created_at', kc.created_at,
        'updated_at', kc.updated_at,
        'embedding', case
          when kc.embedding is null then null
          else kc.embedding::text
        end,
        'embedding_provider', kc.embedding_provider,
        'embedding_model', kc.embedding_model,
        'embedding_dimensions', kc.embedding_dimensions,
        'embedding_version', kc.embedding_version
      )
      order by kc.chunk_index, kc.id
    ) as chunks
    from public.knowledge_chunks kc
    where kc.business_id = ks.business_id
      and kc.source_id = ks.id
  ) chunk_snapshot on true
  where ks.business_id = p_business_id
    and ks.id = p_source_id
    and ks.status = 'ready';
$$;

revoke all on function public.read_knowledge_embedding_backfill_source(
  bigint,
  uuid
)
from public, anon, authenticated;

grant execute on function public.read_knowledge_embedding_backfill_source(
  bigint,
  uuid
)
to service_role;

comment on function public.read_knowledge_embedding_backfill_source(
  bigint,
  uuid
) is
  'Reads one ready tenant-scoped Knowledge source and an opaque concurrency token for a guarded embedding backfill.';

create function public.backfill_knowledge_chunk_embeddings_if_unchanged(
  p_business_id bigint,
  p_source_id uuid,
  p_expected_snapshot_token text,
  p_expected_update_count integer,
  p_embedding_provider text,
  p_embedding_model text,
  p_embedding_dimensions integer,
  p_embedding_version integer,
  p_chunks jsonb
)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
set lock_timeout = '5s'
as $$
declare
  v_source public.knowledge_sources%rowtype;
  v_current_chunks jsonb;
  v_current_snapshot_token text;
  v_current_update_count integer;
  v_updated_count integer;
begin
  if p_business_id is null or p_business_id <= 0 then
    raise exception 'invalid_business_id';
  end if;

  if p_source_id is null then
    raise exception 'invalid_source_id';
  end if;

  if nullif(btrim(p_expected_snapshot_token), '') is null then
    raise exception 'invalid_expected_snapshot_token';
  end if;

  if p_expected_update_count is null or p_expected_update_count < 1 then
    raise exception 'invalid_expected_update_count';
  end if;

  if nullif(btrim(p_embedding_provider), '') is null
    or nullif(btrim(p_embedding_model), '') is null
    or p_embedding_dimensions is null
    or p_embedding_dimensions <> 768
    or p_embedding_version is null
    or p_embedding_version <= 0
  then
    raise exception 'invalid_expected_embedding_identity';
  end if;

  if p_chunks is null or jsonb_typeof(p_chunks) <> 'array' then
    raise exception 'invalid_chunks_payload';
  end if;

  -- Follow the source-then-chunks lock order used by Knowledge writes. The
  -- function-level lock timeout prevents indefinite waits behind live writes.
  select ks.*
  into v_source
  from public.knowledge_sources ks
  where ks.business_id = p_business_id
    and ks.id = p_source_id
  for update;

  if not found then
    raise exception 'knowledge_source_scope_mismatch';
  end if;

  if v_source.status <> 'ready' then
    raise exception 'knowledge_source_not_ready';
  end if;

  -- Embeddings are generated before this RPC. This lock prevents a concurrent
  -- chunk replacement from slipping between snapshot comparison and update.
  lock table public.knowledge_chunks in share row exclusive mode;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', kc.id,
        'business_id', kc.business_id,
        'source_id', kc.source_id,
        'chunk_index', kc.chunk_index,
        'content', kc.content,
        'metadata', kc.metadata,
        'created_at', kc.created_at,
        'updated_at', kc.updated_at,
        'embedding', case
          when kc.embedding is null then null
          else kc.embedding::text
        end,
        'embedding_provider', kc.embedding_provider,
        'embedding_model', kc.embedding_model,
        'embedding_dimensions', kc.embedding_dimensions,
        'embedding_version', kc.embedding_version
      )
      order by kc.chunk_index, kc.id
    ),
    '[]'::jsonb
  )
  into v_current_chunks
  from public.knowledge_chunks kc
  where kc.business_id = p_business_id
    and kc.source_id = p_source_id;

  v_current_snapshot_token := md5(
    jsonb_build_object(
      'source', to_jsonb(v_source),
      'chunks', v_current_chunks
    )::text
  );

  if v_current_snapshot_token <> p_expected_snapshot_token then
    raise exception 'knowledge_backfill_snapshot_changed'
      using errcode = '40001';
  end if;

  if jsonb_array_length(p_chunks) <> jsonb_array_length(v_current_chunks) then
    raise exception 'knowledge_backfill_incomplete_payload';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_chunks) item
    where jsonb_typeof(item) <> 'object'
      or not (item ? 'chunk_index')
      or not (item ? 'content')
      or not (item ? 'metadata')
      or not (item ? 'embedding')
      or not (item ? 'embedding_provider')
      or not (item ? 'embedding_model')
      or not (item ? 'embedding_dimensions')
      or not (item ? 'embedding_version')
      or coalesce(item->>'chunk_index', '') !~ '^[0-9]+$'
      or nullif(item->>'content', '') is null
      or jsonb_typeof(item->'metadata') <> 'object'
      or jsonb_typeof(item->'embedding') <> 'array'
      or jsonb_array_length(item->'embedding') <> p_embedding_dimensions
      or nullif(btrim(item->>'embedding_provider'), '') <> p_embedding_provider
      or nullif(btrim(item->>'embedding_model'), '') <> p_embedding_model
      or coalesce(item->>'embedding_dimensions', '') !~ '^[0-9]+$'
      or (item->>'embedding_dimensions')::integer <> p_embedding_dimensions
      or coalesce(item->>'embedding_version', '') !~ '^[1-9][0-9]*$'
      or (item->>'embedding_version')::integer <> p_embedding_version
      or exists (
        select 1
        from jsonb_array_elements(item->'embedding') coordinate
        where jsonb_typeof(coordinate) <> 'number'
      )
  ) then
    raise exception 'knowledge_backfill_invalid_payload';
  end if;

  if exists (
    select (item->>'chunk_index')::integer
    from jsonb_array_elements(p_chunks) item
    group by (item->>'chunk_index')::integer
    having count(*) <> 1
  ) then
    raise exception 'knowledge_backfill_duplicate_chunk_index';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_chunks) item
    left join public.knowledge_chunks kc
      on kc.business_id = p_business_id
     and kc.source_id = p_source_id
     and kc.chunk_index = (item->>'chunk_index')::integer
    where kc.id is null
      or kc.content <> item->>'content'
      or kc.metadata <> item->'metadata'
  ) then
    raise exception 'knowledge_backfill_content_changed';
  end if;

  select count(*)::integer
  into v_current_update_count
  from public.knowledge_chunks kc
  where kc.business_id = p_business_id
    and kc.source_id = p_source_id
    and (
      kc.embedding is null
      or kc.embedding_provider is distinct from p_embedding_provider
      or kc.embedding_model is distinct from p_embedding_model
      or kc.embedding_dimensions is distinct from p_embedding_dimensions
      or kc.embedding_version is distinct from p_embedding_version
    );

  if v_current_update_count <> p_expected_update_count then
    raise exception 'knowledge_backfill_update_count_changed'
      using errcode = '40001';
  end if;

  with payload as (
    select
      (item->>'chunk_index')::integer as chunk_index,
      (item->'embedding')::text::extensions.vector(768) as embedding
    from jsonb_array_elements(p_chunks) item
  )
  update public.knowledge_chunks kc
  set
    embedding = payload.embedding,
    embedding_provider = p_embedding_provider,
    embedding_model = p_embedding_model,
    embedding_dimensions = p_embedding_dimensions,
    embedding_version = p_embedding_version
  from payload
  where kc.business_id = p_business_id
    and kc.source_id = p_source_id
    and kc.chunk_index = payload.chunk_index
    and (
      kc.embedding is null
      or kc.embedding_provider is distinct from p_embedding_provider
      or kc.embedding_model is distinct from p_embedding_model
      or kc.embedding_dimensions is distinct from p_embedding_dimensions
      or kc.embedding_version is distinct from p_embedding_version
    );

  get diagnostics v_updated_count = row_count;

  if v_updated_count <> p_expected_update_count then
    raise exception 'knowledge_backfill_partial_update'
      using errcode = '40001';
  end if;

  return v_updated_count;
end;
$$;

revoke all on function public.backfill_knowledge_chunk_embeddings_if_unchanged(
  bigint,
  uuid,
  text,
  integer,
  text,
  text,
  integer,
  integer,
  jsonb
)
from public, anon, authenticated;

grant execute on function public.backfill_knowledge_chunk_embeddings_if_unchanged(
  bigint,
  uuid,
  text,
  integer,
  text,
  text,
  integer,
  integer,
  jsonb
)
to service_role;

comment on function public.backfill_knowledge_chunk_embeddings_if_unchanged(
  bigint,
  uuid,
  text,
  integer,
  text,
  text,
  integer,
  integer,
  jsonb
) is
  'Atomically backfills embeddings for one ready tenant-scoped Knowledge source only when its complete source/chunk snapshot is unchanged.';
