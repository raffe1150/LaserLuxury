-- Additive backend-only read contract. STABLE gives readiness, source inventory,
-- generation proof and scoring one caller-statement MVCC snapshot. No writes.
create function public.search_knowledge_index_snapshot_v1(
  p_business_id bigint, p_identity jsonb, p_queries jsonb,
  p_limit integer default 5, p_min_similarity real default 0.55,
  p_excluded_chunks jsonb default '[]'::jsonb
) returns jsonb language plpgsql stable security invoker
set search_path = pg_catalog, public, extensions
as $$
declare result jsonb; q jsonb; v extensions.vector;
begin
  if p_business_id is null or p_business_id<=0 or
    p_identity is distinct from '{"provider":"openai","model":"text-embedding-3-small","dimensions":768,"version":1}'::jsonb or
    jsonb_typeof(p_queries) is distinct from 'array' or jsonb_array_length(p_queries)>3 or
    jsonb_typeof(p_excluded_chunks) is distinct from 'array' or jsonb_array_length(p_excluded_chunks)>10000 or
    p_limit is null or p_limit not between 1 and 10 or p_min_similarity is null or
    not (p_min_similarity between -1 and 1) then raise exception 'knowledge_index_invalid_search'; end if;
  for q in select value from jsonb_array_elements(p_queries) loop
    if jsonb_typeof(q) is distinct from 'array' or jsonb_array_length(q)<>768 or
      exists(select 1 from jsonb_array_elements(q) x where jsonb_typeof(x)<>'number') then
      raise exception 'knowledge_index_invalid_query_vector'; end if;
    v := q::text::extensions.vector;
    if not (extensions.vector_norm(v)>0) then raise exception 'knowledge_index_invalid_query_vector'; end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(p_excluded_chunks) x
    where jsonb_typeof(x)<>'object' or jsonb_typeof(x->'source_id') is distinct from 'string'
      or jsonb_typeof(x->'content') is distinct from 'string') then raise exception 'knowledge_index_invalid_exclusions'; end if;

  with sources as materialized (
    select s.id,s.business_id,s.status,
      public.knowledge_source_index_readiness_v1(p_business_id,s.id,p_identity,1) as readiness,
      st.completed_token,st.completed_vector_digest
    from public.knowledge_sources s left join public.knowledge_source_index_state st
      on st.business_id=s.business_id and st.source_id=s.id
    where s.business_id=p_business_id and s.status<>'deleted'
  ), proofs as materialized (
    select *, jsonb_build_object('sourceId',id,'businessId',business_id,'sourceStatus',status,
      'ready',(readiness->>'ready')::boolean,'revision',readiness->'content_revision',
      'state',readiness->'state','indexStatus',case
        when readiness->>'ready'='true' then 'ready'
        when readiness->>'state' in ('blocked','failed') then 'blocked'
        when status<>'ready' then 'incomplete'
        when readiness->>'state'='unknown' then 'missing'
        else 'incomplete' end,'expectedChunks',readiness->'expected_chunk_count',
      'compatibleChunks',readiness->'compatible_chunk_count',
      'generation',completed_token,'vectorDigest',completed_vector_digest) as proof from sources
  ), inventory as materialized (
    select jsonb_build_object('businessId',p_business_id,'complete',count(*) filter(where status='ready')>0 and
        count(*) filter(where status='ready' and readiness->>'ready'='true')=count(*) filter(where status='ready'),
      'sourceCount',count(*),'readySourceCount',count(*) filter(where readiness->>'ready'='true'),
      'textReadySourceCount',count(*) filter(where status='ready'),
      'sources',coalesce(jsonb_agg(proof order by id),'[]'::jsonb),
      'inventoryToken',encode(sha256(convert_to(jsonb_build_array(p_business_id,coalesce(jsonb_agg(proof order by id),'[]'::jsonb))::text,'UTF8')),'hex'),
      'identity',p_identity,'canonicalVersion',1) as coverage from proofs
  ), queries as (
    select value::text::extensions.vector as embedding,ordinality as ordinal
    from jsonb_array_elements(p_queries) with ordinality
  ), sets as (
    select q.ordinal,coalesce((select jsonb_agg(x.match order by x.score desc,x.source_id,x.chunk_index) from (
      select c.source_id,c.chunk_index,(1-(c.embedding <=> q.embedding))::real as score,
        jsonb_build_object('sourceId',c.source_id,'businessId',c.business_id,'text',c.content,
          'metadata',c.metadata,'score',(1-(c.embedding <=> q.embedding))::real,
          'indexProof',jsonb_build_object('source',p.proof,'inventoryToken',i.coverage->'inventoryToken')) as match
      from public.knowledge_chunks c join proofs p on p.id=c.source_id and p.business_id=c.business_id
      cross join inventory i
      where c.business_id=p_business_id and p.status='ready' and p.readiness->>'ready'='true'
        and c.embedding is not null and c.embedding_provider=p_identity->>'provider'
        and c.embedding_model=p_identity->>'model' and c.embedding_dimensions=768 and c.embedding_version=1
        and (1-(c.embedding <=> q.embedding))>=p_min_similarity
        and not exists(select 1 from jsonb_array_elements(p_excluded_chunks) e
          where e->>'source_id'=c.source_id::text and e->>'content'=c.content)
      order by c.embedding <=> q.embedding,c.source_id,c.chunk_index limit p_limit
    ) x),'[]'::jsonb) as matches from queries q
  ) select jsonb_build_object('coverage',i.coverage,'matches',
    coalesce((select jsonb_agg(matches order by ordinal) from sets),'[]'::jsonb)) into result from inventory i;
  return result;
end;
$$;
revoke all on function public.search_knowledge_index_snapshot_v1(bigint,jsonb,jsonb,integer,real,jsonb) from public,anon,authenticated;
grant execute on function public.search_knowledge_index_snapshot_v1(bigint,jsonb,jsonb,integer,real,jsonb) to service_role;
