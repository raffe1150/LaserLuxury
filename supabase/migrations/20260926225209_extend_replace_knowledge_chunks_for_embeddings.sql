create or replace function public.replace_knowledge_chunks(
  p_business_id bigint,
  p_source_id uuid,
  p_chunks jsonb
)
returns void
language plpgsql
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

  if exists (
    select 1
    from jsonb_array_elements(p_chunks) item
    where
      item ? 'embedding'
      and (
        item->'embedding' is null
        or jsonb_typeof(item->'embedding') <> 'array'
        or jsonb_array_length(item->'embedding') <> 768
        or nullif(btrim(item->>'embedding_provider'), '') is null
        or nullif(btrim(item->>'embedding_model'), '') is null
        or coalesce(item->>'embedding_dimensions', '') !~ '^[0-9]+$'
        or (item->>'embedding_dimensions')::integer <> 768
        or coalesce(item->>'embedding_version', '') !~ '^[1-9][0-9]*$'
      )
  ) then
    raise exception 'invalid_embedding_payload';
  end if;

  delete from public.knowledge_chunks
  where business_id = p_business_id
    and source_id = p_source_id;

  insert into public.knowledge_chunks (
    business_id,
    source_id,
    chunk_index,
    content,
    metadata,
    embedding,
    embedding_provider,
    embedding_model,
    embedding_dimensions,
    embedding_version
  )
  select
    p_business_id,
    p_source_id,
    (item->>'chunk_index')::integer,
    btrim(item->>'content'),
    case
      when item ? 'metadata' then item->'metadata'
      else '{}'::jsonb
    end,
    case
      when item ? 'embedding'
        then (item->'embedding')::text::extensions.vector
      else null
    end,
    case
      when item ? 'embedding'
        then nullif(btrim(item->>'embedding_provider'), '')
      else null
    end,
    case
      when item ? 'embedding'
        then nullif(btrim(item->>'embedding_model'), '')
      else null
    end,
    case
      when item ? 'embedding'
        then (item->>'embedding_dimensions')::integer
      else null
    end,
    case
      when item ? 'embedding'
        then (item->>'embedding_version')::integer
      else null
    end
  from jsonb_array_elements(p_chunks) item;
end;
$$;

revoke all on function public.replace_knowledge_chunks(
  bigint,
  uuid,
  jsonb
)
from public, anon, authenticated;

grant execute on function public.replace_knowledge_chunks(
  bigint,
  uuid,
  jsonb
)
to service_role;

comment on function public.replace_knowledge_chunks(
  bigint,
  uuid,
  jsonb
) is
  'Atomically replaces tenant-scoped Knowledge chunks and optionally stores provider-neutral semantic embeddings.';
