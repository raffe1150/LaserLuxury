-- Additive, backend-only coordination for the existing Knowledge vector store.
-- No worker, provider call, historical backfill, or customer-reader switch.
begin;

do $$ begin
  if to_regprocedure('extensions.vector_norm(extensions.vector)') is null then
    raise exception 'knowledge_index_requires_vector_norm';
  end if;
end; $$;

create function public.knowledge_index_identity_valid_v1(p_identity jsonb)
returns boolean language sql immutable security invoker
set search_path = pg_catalog
as $$
  select coalesce(p_identity in (
    '{"provider":"openai","model":"text-embedding-3-small","dimensions":768,"version":1}'::jsonb,
    '{"provider":"google","model":"gemini-embedding-2","dimensions":768,"version":1}'::jsonb
  ), false);
$$;

create table public.knowledge_source_index_state (
  business_id bigint not null,
  source_id uuid not null,
  primary key (business_id, source_id),
  foreign key (source_id, business_id) references public.knowledge_sources(id,business_id) on delete cascade,
  state text not null default 'pending' check (state in ('pending','indexing','retry_wait','ready','blocked','failed')),
  target_revision text check (target_revision ~ '^[a-f0-9]{64}$'),
  target_identity jsonb check (target_identity is null or public.knowledge_index_identity_valid_v1(target_identity)),
  canonical_version integer not null default 1 check (canonical_version = 1),
  expected_chunk_count integer check (expected_chunk_count between 1 and 200),
  snapshot_token text,
  attempts integer not null default 0 check (attempts between 0 and 3),
  lease_token uuid,
  lease_until timestamptz,
  job_deadline timestamptz,
  next_attempt_at timestamptz,
  error_code text,
  completed_revision text check (completed_revision ~ '^[a-f0-9]{64}$'),
  completed_identity jsonb check (completed_identity is null or public.knowledge_index_identity_valid_v1(completed_identity)),
  completed_canonical_version integer check (completed_canonical_version = 1),
  completed_chunk_count integer check (completed_chunk_count between 1 and 200),
  completed_token uuid,
  completed_snapshot_token text,
  completed_payload_digest text,
  completed_vector_digest text,
  completed_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  check (business_id > 0),
  check ((state = 'indexing') = (lease_token is not null and lease_until is not null and job_deadline is not null)),
  check (state <> 'indexing' or (target_revision is not null and target_identity is not null
    and snapshot_token is not null and expected_chunk_count is not null and attempts > 0
    and lease_until <= job_deadline)),
  check (state <> 'ready' or (completed_revision is not null and completed_identity is not null
    and completed_canonical_version is not null and completed_chunk_count is not null
    and completed_token is not null and completed_snapshot_token is not null
    and completed_payload_digest is not null and completed_vector_digest is not null and completed_at is not null))
);
comment on table public.knowledge_source_index_state is
  'Internal source-index coordination only. Text Ready remains independent of semantic readiness. No vectors or source text are duplicated here.';
create index knowledge_source_index_recovery_v1 on public.knowledge_source_index_state(next_attempt_at,business_id,source_id)
  where state in ('indexing','retry_wait','pending');
alter table public.knowledge_source_index_state enable row level security;
revoke all on table public.knowledge_source_index_state from public, anon, authenticated;
grant select, insert, update on table public.knowledge_source_index_state to service_role;

-- Content revision excludes embeddings, timestamps and coordination fields.
-- SQL's versioned canonical JSON encoding is independent of the existing JS citation hash.
create function public.knowledge_source_index_revision_v1(p_business_id bigint,p_source_id uuid)
returns text language sql stable security invoker
set search_path = pg_catalog, public
as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'canonical_version',1,'id',s.id,'business_id',s.business_id,'type',s.type,
    'title',s.title,'status',s.status,'content',s.content,'metadata',s.metadata,
    'chunks',coalesce((select jsonb_agg(jsonb_build_object(
      'id',c.id,'business_id',c.business_id,'source_id',c.source_id,
      'chunk_index',c.chunk_index,'content',c.content,'metadata',c.metadata
    ) order by c.chunk_index,c.id) from public.knowledge_chunks c
      where c.business_id=s.business_id and c.source_id=s.id),'[]'::jsonb)
  )::text,'UTF8')),'hex') from public.knowledge_sources s
  where s.business_id=p_business_id and s.id=p_source_id and s.status='ready';
$$;

create function public.knowledge_source_index_vector_digest_v1(p_business_id bigint,p_source_id uuid)
returns text language sql stable security invoker
set search_path = pg_catalog, public
as $$
  select encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object(
    'id',c.id,'chunk_index',c.chunk_index,'embedding',c.embedding::text,
    'provider',c.embedding_provider,'model',c.embedding_model,
    'dimensions',c.embedding_dimensions,'version',c.embedding_version
  ) order by c.chunk_index,c.id),'[]'::jsonb)::text,'UTF8')),'hex')
  from public.knowledge_chunks c where c.business_id=p_business_id and c.source_id=p_source_id;
$$;

create function public.knowledge_source_index_readiness_v1(
  p_business_id bigint,p_source_id uuid,p_identity jsonb,p_canonical_version integer default 1
) returns jsonb language plpgsql stable security invoker
set search_path = pg_catalog, public, extensions
as $$
declare r text; n integer; compatible integer; st public.knowledge_source_index_state%rowtype; ok boolean;
begin
  if not public.knowledge_index_identity_valid_v1(p_identity) or p_canonical_version is distinct from 1
    or p_business_id is null or p_business_id <= 0 or p_source_id is null then
    raise exception 'knowledge_index_invalid_request';
  end if;
  r := public.knowledge_source_index_revision_v1(p_business_id,p_source_id);
  select * into st from public.knowledge_source_index_state where business_id=p_business_id and source_id=p_source_id;
  select count(*), count(*) filter (where c.embedding is not null
    and c.embedding_provider=p_identity->>'provider' and c.embedding_model=p_identity->>'model'
    and c.embedding_dimensions=(p_identity->>'dimensions')::integer and c.embedding_version=(p_identity->>'version')::integer
    and extensions.vector_norm(c.embedding)>0)
    into n,compatible from public.knowledge_chunks c where c.business_id=p_business_id and c.source_id=p_source_id;
  ok := coalesce(r is not null and st.completed_revision=r and st.completed_identity=p_identity
    and st.completed_canonical_version=p_canonical_version and st.completed_chunk_count=n
    and n between 1 and 200 and compatible=n
    and st.completed_vector_digest=public.knowledge_source_index_vector_digest_v1(p_business_id,p_source_id),false);
  return jsonb_build_object('ready',ok,'content_revision',r,'state',coalesce(st.state,'unknown'),
    'expected_chunk_count',n,'compatible_chunk_count',compatible,'attempts',coalesce(st.attempts,0),
    'next_attempt_at',st.next_attempt_at,'lease_active',coalesce(st.lease_until>clock_timestamp(),false),
    'retry_eligible',coalesce(r is not null and st.target_revision=r and st.state in ('retry_wait','indexing')
      and st.attempts<3 and st.next_attempt_at<=clock_timestamp()
      and (st.lease_until is null or st.lease_until<=clock_timestamp()),false));
end;
$$;

create function public.claim_knowledge_source_index_v1(
  p_business_id bigint,p_source_id uuid,p_identity jsonb,p_canonical_version integer default 1
) returns jsonb language plpgsql volatile security invoker
set search_path = pg_catalog, public, extensions set lock_timeout = '5s'
as $$
declare s public.knowledge_sources%rowtype; st public.knowledge_source_index_state%rowtype;
  r text; snap record; n integer; indices integer[]; token uuid; moment timestamptz; tries integer;
begin
  if not public.knowledge_index_identity_valid_v1(p_identity) or p_canonical_version is distinct from 1
    or p_business_id is null or p_business_id<=0 or p_source_id is null then
    raise exception 'knowledge_index_invalid_request';
  end if;
  select * into s from public.knowledge_sources where business_id=p_business_id and id=p_source_id for update;
  if not found then raise exception 'knowledge_source_scope_mismatch'; end if;
  if s.status<>'ready' then return jsonb_build_object('admitted',false,'reason','source_not_ready'); end if;
  insert into public.knowledge_source_index_state(business_id,source_id) values(p_business_id,p_source_id) on conflict do nothing;
  select * into st from public.knowledge_source_index_state where business_id=p_business_id and source_id=p_source_id for update;
  -- Same source -> state -> chunk-write lock order in all mutation contracts.
  lock table public.knowledge_chunks in share row exclusive mode;
  r := public.knowledge_source_index_revision_v1(p_business_id,p_source_id);
  moment := clock_timestamp();
  if (public.knowledge_source_index_readiness_v1(p_business_id,p_source_id,p_identity,p_canonical_version)->>'ready')::boolean then
    return jsonb_build_object('admitted',false,'reason','already_ready');
  end if;
  if st.state='indexing' and st.lease_until>moment then return jsonb_build_object('admitted',false,'reason','busy'); end if;
  -- Retargeting a provider does not replenish the attempt allowance for unchanged content.
  tries := case when st.target_revision is distinct from r then 0 else st.attempts end;
  if tries>=3 then
    update public.knowledge_source_index_state set state='failed',lease_token=null,lease_until=null,job_deadline=null,
      next_attempt_at=null,error_code='attempts_exhausted',updated_at=moment where business_id=p_business_id and source_id=p_source_id;
    return jsonb_build_object('admitted',false,'reason','attempts_exhausted');
  end if;
  if st.target_revision=r and st.state in ('blocked','failed') then return jsonb_build_object('admitted',false,'reason',st.state); end if;
  if st.target_revision=r and st.next_attempt_at>moment then return jsonb_build_object('admitted',false,'reason','backoff'); end if;
  select count(*),array_agg(chunk_index order by chunk_index) into n,indices
    from public.knowledge_chunks where business_id=p_business_id and source_id=p_source_id;
  if n not between 1 and 200 or indices is distinct from array(select generate_series(0,n-1)) then
    raise exception 'knowledge_index_invalid_inventory';
  end if;
  -- No adoption of unknown historical generations, even if identity/count look compatible.
  if exists(select 1 from public.knowledge_chunks where business_id=p_business_id and source_id=p_source_id and embedding is not null) then
    update public.knowledge_source_index_state set state='blocked',target_revision=r,target_identity=p_identity,
      canonical_version=p_canonical_version,expected_chunk_count=n,attempts=tries,lease_token=null,lease_until=null,job_deadline=null,
      next_attempt_at=null,error_code='existing_vectors_require_review',updated_at=moment where business_id=p_business_id and source_id=p_source_id;
    return jsonb_build_object('admitted',false,'reason','existing_vectors_require_review');
  end if;
  select * into snap from public.read_knowledge_embedding_backfill_source(p_business_id,p_source_id);
  token := gen_random_uuid();
  update public.knowledge_source_index_state set state='indexing',target_revision=r,target_identity=p_identity,
    canonical_version=p_canonical_version,expected_chunk_count=n,snapshot_token=snap.snapshot_token,
    attempts=tries+1,lease_token=token,lease_until=moment+interval '120 seconds',job_deadline=moment+interval '5 minutes',
    next_attempt_at=moment+interval '120 seconds'+case when tries=0 then interval '30 seconds' else interval '120 seconds' end,
    error_code=null,updated_at=moment where business_id=p_business_id and source_id=p_source_id;
  return jsonb_build_object('admitted',true,'lease_token',token,'content_revision',r,'identity',p_identity,
    'canonical_version',p_canonical_version,'snapshot_token',snap.snapshot_token,'chunks',snap.chunks,
    'lease_until',moment+interval '120 seconds','job_deadline',moment+interval '5 minutes','attempt',tries+1);
end;
$$;

create function public.transition_knowledge_source_index_v1(
  p_business_id bigint,p_source_id uuid,p_token uuid,p_action text,p_error text default null
) returns boolean language plpgsql volatile security invoker
set search_path = pg_catalog, public, extensions set lock_timeout = '5s'
as $$
declare s public.knowledge_sources%rowtype; st public.knowledge_source_index_state%rowtype;
  moment timestamptz; until_time timestamptz; snap record;
begin
  if p_business_id is null or p_business_id<=0 or p_source_id is null or p_token is null
    or p_action is null or p_action not in ('renew','fail') then raise exception 'knowledge_index_invalid_request'; end if;
  select * into s from public.knowledge_sources where business_id=p_business_id and id=p_source_id for update;
  if not found then raise exception 'knowledge_source_scope_mismatch'; end if;
  select * into st from public.knowledge_source_index_state where business_id=p_business_id and source_id=p_source_id for update;
  lock table public.knowledge_chunks in share row exclusive mode;
  moment := clock_timestamp();
  if st.state is distinct from 'indexing' or st.lease_token is distinct from p_token
    or st.lease_until<=moment or st.job_deadline<=moment or s.status<>'ready' then return false; end if;
  select * into snap from public.read_knowledge_embedding_backfill_source(p_business_id,p_source_id);
  if snap.snapshot_token is distinct from st.snapshot_token
    or public.knowledge_source_index_revision_v1(p_business_id,p_source_id) is distinct from st.target_revision then return false; end if;
  if p_action='renew' then
    until_time := least(moment+interval '120 seconds',st.job_deadline);
    update public.knowledge_source_index_state set lease_until=until_time,
      next_attempt_at=until_time+case when attempts=1 then interval '30 seconds' else interval '120 seconds' end,
      updated_at=moment where business_id=p_business_id and source_id=p_source_id;
  else
    if p_error is null or p_error not in ('provider_failure','provider_timeout','invalid_vectors','credentials','configuration') then
      raise exception 'knowledge_index_invalid_error_code';
    end if;
    update public.knowledge_source_index_state set
      state=case when p_error in ('credentials','configuration','invalid_vectors') then 'blocked'
        when attempts>=3 then 'failed' else 'retry_wait' end,
      next_attempt_at=case when p_error in ('provider_failure','provider_timeout') and attempts<3 then
        moment+case when attempts=1 then interval '30 seconds' else interval '120 seconds' end else null end,
      lease_token=null,lease_until=null,job_deadline=null,error_code=p_error,updated_at=moment
      where business_id=p_business_id and source_id=p_source_id;
  end if;
  return true;
end;
$$;

create function public.complete_knowledge_source_index_v1(
  p_business_id bigint,p_source_id uuid,p_token uuid,p_revision text,p_identity jsonb,
  p_canonical_version integer,p_snapshot_token text,p_chunks jsonb
) returns jsonb language plpgsql volatile security invoker
set search_path = pg_catalog, public, extensions set lock_timeout = '5s'
as $$
declare s public.knowledge_sources%rowtype; st public.knowledge_source_index_state%rowtype;
  snap record; digest text; updated integer; item jsonb;
begin
  if p_business_id is null or p_business_id<=0 or p_source_id is null or p_token is null
    or not public.knowledge_index_identity_valid_v1(p_identity) or p_canonical_version is distinct from 1
    or p_revision is null or p_snapshot_token is null or p_chunks is null or jsonb_typeof(p_chunks)<>'array' then
    raise exception 'knowledge_index_invalid_request';
  end if;
  select * into s from public.knowledge_sources where business_id=p_business_id and id=p_source_id for update;
  if not found then raise exception 'knowledge_source_scope_mismatch'; end if;
  select * into st from public.knowledge_source_index_state where business_id=p_business_id and source_id=p_source_id for update;
  lock table public.knowledge_chunks in share row exclusive mode;
  digest := encode(sha256(convert_to(p_chunks::text,'UTF8')),'hex');
  if st.completed_token=p_token and st.completed_revision=p_revision and st.completed_identity=p_identity
    and st.completed_canonical_version=p_canonical_version and st.completed_snapshot_token=p_snapshot_token
    and st.completed_payload_digest=digest
    and (public.knowledge_source_index_readiness_v1(p_business_id,p_source_id,p_identity,p_canonical_version)->>'ready')::boolean then
    return jsonb_build_object('ready',true,'already_committed',true);
  end if;
  if st.state is distinct from 'indexing' or st.lease_token is distinct from p_token
    or st.lease_until<=clock_timestamp() or st.job_deadline<=clock_timestamp()
    or st.target_revision is distinct from p_revision or st.target_identity is distinct from p_identity
    or st.canonical_version is distinct from p_canonical_version or st.snapshot_token is distinct from p_snapshot_token then
    raise exception 'knowledge_index_stale_claim';
  end if;
  if s.status<>'ready' or public.knowledge_source_index_revision_v1(p_business_id,p_source_id) is distinct from p_revision then
    raise exception 'knowledge_index_source_changed' using errcode='40001';
  end if;
  select * into snap from public.read_knowledge_embedding_backfill_source(p_business_id,p_source_id);
  if snap.snapshot_token is distinct from p_snapshot_token then raise exception 'knowledge_index_snapshot_changed' using errcode='40001'; end if;
  if jsonb_array_length(p_chunks)<>st.expected_chunk_count then raise exception 'knowledge_index_incomplete_payload'; end if;
  if exists(select 1 from public.knowledge_chunks where business_id=p_business_id and source_id=p_source_id and embedding is not null) then
    raise exception 'knowledge_index_existing_vectors';
  end if;
  -- SQL casts reject NaN/infinity/overflow; norm check rejects unusable zero vectors.
  for item in select value from jsonb_array_elements(p_chunks) loop
    if jsonb_typeof(item->'embedding') is distinct from 'array' then raise exception 'knowledge_index_invalid_vector'; end if;
    if jsonb_array_length(item->'embedding')<>768 then raise exception 'knowledge_index_invalid_vector'; end if;
    if exists(select 1 from jsonb_array_elements(item->'embedding') coordinate where jsonb_typeof(coordinate)<>'number') then
      raise exception 'knowledge_index_invalid_vector';
    end if;
    if not (extensions.vector_norm((item->'embedding')::text::extensions.vector(768))>0) then
      raise exception 'knowledge_index_invalid_vector';
    end if;
  end loop;
  updated := public.backfill_knowledge_chunk_embeddings_if_unchanged(p_business_id,p_source_id,p_snapshot_token,
    st.expected_chunk_count,p_identity->>'provider',p_identity->>'model',768,(p_identity->>'version')::integer,p_chunks);
  if updated<>st.expected_chunk_count or st.lease_until<=clock_timestamp() or st.job_deadline<=clock_timestamp() then
    raise exception 'knowledge_index_completion_expired';
  end if;
  update public.knowledge_source_index_state set state='ready',lease_token=null,lease_until=null,job_deadline=null,
    next_attempt_at=null,error_code=null,completed_revision=p_revision,completed_identity=p_identity,
    completed_canonical_version=p_canonical_version,completed_chunk_count=st.expected_chunk_count,
    completed_token=p_token,completed_snapshot_token=p_snapshot_token,completed_payload_digest=digest,
    completed_vector_digest=public.knowledge_source_index_vector_digest_v1(p_business_id,p_source_id),
    completed_at=clock_timestamp(),updated_at=clock_timestamp() where business_id=p_business_id and source_id=p_source_id;
  if not (public.knowledge_source_index_readiness_v1(p_business_id,p_source_id,p_identity,p_canonical_version)->>'ready')::boolean then
    raise exception 'knowledge_index_incomplete_commit';
  end if;
  return jsonb_build_object('ready',true,'already_committed',false,'updated_chunks',updated);
end;
$$;

-- Full inventory, not semantic top-N count. Empty coverage is explicitly not complete.
create function public.knowledge_index_readiness_v1(
  p_business_id bigint,p_identity jsonb,p_canonical_version integer default 1
) returns jsonb language plpgsql stable security invoker
set search_path = pg_catalog, public
as $$
declare n integer; ready_n integer; expected integer; compatible integer; inventory text;
begin
  if p_business_id is null or p_business_id<=0 or not public.knowledge_index_identity_valid_v1(p_identity)
    or p_canonical_version is distinct from 1 then raise exception 'knowledge_index_invalid_request'; end if;
  select count(*),count(*) filter(where (r->>'ready')::boolean),coalesce(sum((r->>'expected_chunk_count')::integer),0),
    coalesce(sum((r->>'compatible_chunk_count')::integer),0),
    encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(id,r->>'content_revision',r->'ready') order by id),'[]'::jsonb)::text,'UTF8')),'hex')
    into n,ready_n,expected,compatible,inventory from (
      select id,public.knowledge_source_index_readiness_v1(p_business_id,id,p_identity,p_canonical_version) as r
      from public.knowledge_sources where business_id=p_business_id and status='ready'
    ) sources;
  return jsonb_build_object('complete',n>0 and ready_n=n,'source_count',n,'ready_source_count',ready_n,
    'unready_source_count',n-ready_n,'expected_chunk_count',expected,'compatible_chunk_count',compatible,
    'inventory_token',inventory,'identity',p_identity,'canonical_version',p_canonical_version);
end;
$$;

-- No SECURITY DEFINER and no public access, including helper functions.
revoke all on function public.knowledge_index_identity_valid_v1(jsonb) from public,anon,authenticated;
revoke all on function public.knowledge_source_index_revision_v1(bigint,uuid) from public,anon,authenticated;
revoke all on function public.knowledge_source_index_vector_digest_v1(bigint,uuid) from public,anon,authenticated;
revoke all on function public.knowledge_source_index_readiness_v1(bigint,uuid,jsonb,integer) from public,anon,authenticated;
revoke all on function public.claim_knowledge_source_index_v1(bigint,uuid,jsonb,integer) from public,anon,authenticated;
revoke all on function public.transition_knowledge_source_index_v1(bigint,uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.complete_knowledge_source_index_v1(bigint,uuid,uuid,text,jsonb,integer,text,jsonb) from public,anon,authenticated;
revoke all on function public.knowledge_index_readiness_v1(bigint,jsonb,integer) from public,anon,authenticated;
grant execute on function public.knowledge_index_identity_valid_v1(jsonb) to service_role;
grant execute on function public.knowledge_source_index_revision_v1(bigint,uuid) to service_role;
grant execute on function public.knowledge_source_index_vector_digest_v1(bigint,uuid) to service_role;
grant execute on function public.knowledge_source_index_readiness_v1(bigint,uuid,jsonb,integer) to service_role;
grant execute on function public.claim_knowledge_source_index_v1(bigint,uuid,jsonb,integer) to service_role;
grant execute on function public.transition_knowledge_source_index_v1(bigint,uuid,uuid,text,text) to service_role;
grant execute on function public.complete_knowledge_source_index_v1(bigint,uuid,uuid,text,jsonb,integer,text,jsonb) to service_role;
grant execute on function public.knowledge_index_readiness_v1(bigint,jsonb,integer) to service_role;
commit;
