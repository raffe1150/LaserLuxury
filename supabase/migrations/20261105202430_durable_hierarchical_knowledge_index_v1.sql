-- REVIEW DRAFT ONLY. Not applied. Independent of vector/embedding revision state.
begin;
create schema knowledge_hint_private;
revoke all on schema knowledge_hint_private from public, anon, authenticated;
grant usage on schema knowledge_hint_private to service_role;
create sequence knowledge_hint_private.epoch_seq as bigint;
create table public.knowledge_hint_source_epochs (
 business_id bigint not null, source_id uuid not null, epoch bigint not null check(epoch>0),
 primary key(business_id,source_id),
 foreign key(source_id,business_id) references public.knowledge_sources(id,business_id) on delete cascade
);
create table public.knowledge_hint_generations_v1 (
 business_id bigint not null, source_id uuid not null, epoch bigint not null check(epoch>0),
 producer_version text not null check(producer_version ~ '^[a-f0-9]{64}$'),
 identity jsonb not null check(jsonb_typeof(identity)='object'),
 canonical_version text not null default 'canonical-document-v1' check(canonical_version='canonical-document-v1'),
 snapshot_token text not null, binding jsonb not null check(octet_length(binding::text)<=524288),
 state text not null check(state in ('indexing','ready','failed','ambiguous','invalidated')),
 lease_token uuid not null, lease_until timestamptz not null, job_deadline timestamptz not null,
 expected_requests integer not null check(expected_requests between 2 and 80),
 started integer not null default 0, completed integer not null default 0, pending boolean not null default false,
 generation jsonb, verified boolean not null default false,
 primary key(business_id,source_id,epoch,producer_version),
 foreign key(source_id,business_id) references public.knowledge_sources(id,business_id) on delete cascade,
 check(completed>=0 and completed<=started and started<=expected_requests),
 check(started-completed=case when pending then 1 else 0 end),
 check(lease_until<=job_deadline),
 check(state<>'ready' or (verified and generation is not null and not pending and completed=expected_requests))
);
create index knowledge_hint_generation_read_v1 on public.knowledge_hint_generations_v1(business_id,producer_version) where state='ready';
alter table public.knowledge_hint_source_epochs enable row level security;
alter table public.knowledge_hint_generations_v1 enable row level security;
revoke all on public.knowledge_hint_source_epochs,public.knowledge_hint_generations_v1 from public,anon,authenticated;
grant select,insert,update on public.knowledge_hint_source_epochs,public.knowledge_hint_generations_v1 to service_role;
grant usage on sequence knowledge_hint_private.epoch_seq to service_role;

-- Trigger privilege is deliberately private: source RLS/owner authorization still
-- runs before this trigger. Clients cannot edit epochs or call this as an RPC.
create function knowledge_hint_private.invalidate_source() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
 if TG_OP='UPDATE' and NEW.business_id is distinct from OLD.business_id then
   delete from public.knowledge_hint_source_epochs where business_id=OLD.business_id and source_id=OLD.id;
   update public.knowledge_hint_generations_v1 set state='invalidated',verified=false where business_id=OLD.business_id and source_id=OLD.id;
 end if;
 insert into public.knowledge_hint_source_epochs(business_id,source_id,epoch)
 values(NEW.business_id,NEW.id,nextval('knowledge_hint_private.epoch_seq'))
 on conflict(business_id,source_id) do update set epoch=excluded.epoch;
 update public.knowledge_hint_generations_v1 set state='invalidated',verified=false where business_id=NEW.business_id and source_id=NEW.id;
 return NEW;
end $$;
revoke all on function knowledge_hint_private.invalidate_source() from public,anon,authenticated,service_role;
create trigger knowledge_hint_invalidate_v1 after insert or update on public.knowledge_sources
 for each row execute function knowledge_hint_private.invalidate_source();
-- Seed fencing only, never search readiness, provider work or embeddings.
insert into public.knowledge_hint_source_epochs(business_id,source_id,epoch)
 select business_id,id,nextval('knowledge_hint_private.epoch_seq') from public.knowledge_sources;

create function knowledge_hint_private.source_json(b bigint,s uuid) returns jsonb
language sql stable security invoker set search_path=pg_catalog as $$
 select jsonb_build_object('id',id,'businessId',business_id,'type',type,'title',title,'status',status,
  'content',content,'metadata',metadata,'createdAt',created_at,'updatedAt',updated_at)
 from public.knowledge_sources where business_id=b and id=s and type='document' and status='ready';
$$;
create function knowledge_hint_private.source_token(b bigint,s uuid) returns text
language sql stable security invoker set search_path=pg_catalog as $$
 select encode(sha256(convert_to(knowledge_hint_private.source_json(b,s)::text,'UTF8')),'hex');
$$;
create function public.knowledge_hint_source_snapshot_v1(p_business_id bigint,p_source_id uuid,p_version text) returns jsonb
language sql stable security invoker set search_path=pg_catalog as $$
 select jsonb_build_object('epoch',e.epoch::text,'snapshot',knowledge_hint_private.source_token(e.business_id,e.source_id),
 'source',knowledge_hint_private.source_json(e.business_id,e.source_id)) from public.knowledge_hint_source_epochs e
 where e.business_id=p_business_id and e.source_id=p_source_id and knowledge_hint_private.source_json(e.business_id,e.source_id) is not null;
$$;
create function public.claim_knowledge_hint_generation_v1(p_business_id bigint,p_source_id uuid,p_version text,
 p_epoch text,p_snapshot text,p_binding jsonb,p_identity jsonb,p_requests integer) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
declare token uuid:=gen_random_uuid(); deadline timestamptz:=clock_timestamp()+interval '30 minutes'; n integer;
begin
 if p_business_id<=0 or p_version !~ '^[a-f0-9]{64}$' or p_epoch !~ '^[0-9]+$' or p_snapshot is null or
  jsonb_typeof(p_identity) is distinct from 'object' or exists(select 1 from unnest(array['provider','model','version','verifierModel','verifierVersion']) k where coalesce(p_identity->>k,'')='')
  or jsonb_typeof(p_binding->'chunks') is distinct from 'array' or jsonb_typeof(p_binding->'nodes') is distinct from 'array' then raise exception 'hint_invalid_claim'; end if;
 n:=jsonb_array_length(p_binding->'chunks');
 if n not between 1 and 200 or p_requests is distinct from 2*((n+4)/5) or
  exists(select 1 from unnest(array['revision','fence','inventoryRoot']) k where coalesce(p_binding->>k,'') !~ '^[a-f0-9]{64}$') then raise exception 'hint_invalid_binding'; end if;
 perform 1 from public.knowledge_sources where id=p_source_id and business_id=p_business_id and status='ready' and type='document' for update;
 if not found then return null; end if;
 perform 1 from public.knowledge_hint_source_epochs where business_id=p_business_id and source_id=p_source_id and epoch=p_epoch::bigint for update;
 if not found or p_snapshot is distinct from knowledge_hint_private.source_token(p_business_id,p_source_id) then return null; end if;
 -- Never reclaim a dispatch that may have reached a provider. New epoch or
 -- explicitly reviewed producer version is a different job, not an automatic retry.
 update public.knowledge_hint_generations_v1 set state='ambiguous',verified=false
 where business_id=p_business_id and source_id=p_source_id and epoch=p_epoch::bigint and producer_version=p_version and state='indexing' and lease_until<clock_timestamp();
 insert into public.knowledge_hint_generations_v1(business_id,source_id,epoch,producer_version,identity,snapshot_token,binding,state,lease_token,lease_until,job_deadline,expected_requests)
 values(p_business_id,p_source_id,p_epoch::bigint,p_version,p_identity,p_snapshot,p_binding,'indexing',token,clock_timestamp()+interval '60 seconds',deadline,p_requests)
 on conflict do nothing;
 if not found then return null; end if;
 return jsonb_build_object('token',token,'epoch',p_epoch,'deadline',deadline);
end $$;

create function public.transition_knowledge_hint_generation_v1(p_business_id bigint,p_source_id uuid,p_version text,p_token uuid,p_epoch text,p_action text,p_stage integer) returns boolean
language plpgsql security invoker set search_path=pg_catalog as $$
declare j public.knowledge_hint_generations_v1%rowtype;
begin
 perform 1 from public.knowledge_sources where business_id=p_business_id and id=p_source_id for update;
 if not found then return false; end if;
 select * into j from public.knowledge_hint_generations_v1 where business_id=p_business_id and source_id=p_source_id and producer_version=p_version and epoch=p_epoch::bigint for update;
 if not found or j.lease_token is distinct from p_token or j.state<>'indexing' then return false; end if;
 if p_action in ('fail','fail-known') then
  update public.knowledge_hint_generations_v1 set state=case when pending and p_action='fail' then 'ambiguous' else 'failed' end,verified=false
  where business_id=p_business_id and source_id=p_source_id and producer_version=p_version and epoch=j.epoch; return true;
 end if;
 if j.lease_until<=clock_timestamp() or j.job_deadline<=clock_timestamp() or j.snapshot_token is distinct from knowledge_hint_private.source_token(p_business_id,p_source_id)
  or not exists(select 1 from public.knowledge_hint_source_epochs where business_id=p_business_id and source_id=p_source_id and epoch=j.epoch) then return false; end if;
 if p_action='begin' and not j.pending and p_stage=j.completed and j.started=j.completed and j.started<j.expected_requests then
  update public.knowledge_hint_generations_v1 set started=started+1,pending=true,lease_until=least(job_deadline,clock_timestamp()+interval '60 seconds')
   where business_id=p_business_id and source_id=p_source_id and producer_version=p_version and epoch=j.epoch; return true;
 elsif p_action='ack' and j.pending and p_stage=j.completed then
  update public.knowledge_hint_generations_v1 set completed=completed+1,pending=false,lease_until=least(job_deadline,clock_timestamp()+interval '60 seconds')
   where business_id=p_business_id and source_id=p_source_id and producer_version=p_version and epoch=j.epoch; return true;
 end if;
 return false;
end $$;

create function public.complete_knowledge_hint_generation_v1(p_business_id bigint,p_source_id uuid,p_version text,p_token uuid,p_epoch text,p_generation jsonb) returns boolean
language plpgsql security invoker set search_path=pg_catalog as $$
declare j public.knowledge_hint_generations_v1%rowtype;
begin
 perform 1 from public.knowledge_sources where business_id=p_business_id and id=p_source_id and status='ready' and type='document' for update;
 if not found then return false; end if;
 select * into j from public.knowledge_hint_generations_v1 where business_id=p_business_id and source_id=p_source_id and producer_version=p_version and epoch=p_epoch::bigint for update;
 if not found or j.lease_token is distinct from p_token or j.snapshot_token is distinct from knowledge_hint_private.source_token(p_business_id,p_source_id)
  or not exists(select 1 from public.knowledge_hint_source_epochs where business_id=p_business_id and source_id=p_source_id and epoch=j.epoch) then return false; end if;
 if j.state='ready' then return j.generation=p_generation; end if;
 if j.state<>'indexing' or j.lease_until<=clock_timestamp() or j.job_deadline<=clock_timestamp() or j.pending or j.completed<>j.expected_requests
  or octet_length(p_generation::text)>1048576 or p_generation->>'protocol' is distinct from 'hierarchical-search-v1'
  or p_generation->>'businessId' is distinct from p_business_id::text or p_generation->>'sourceId' is distinct from p_source_id::text
  or p_generation->>'producerVersion' is distinct from p_version or p_generation->>'revocationEpoch' is distinct from p_epoch
  or p_generation->'producerIdentity' is distinct from j.identity or p_generation->>'inventoryRoot' is distinct from j.binding->>'inventoryRoot'
  or p_generation->>'fence' is distinct from j.binding->>'fence'
  or jsonb_typeof(p_generation->'hints') is distinct from 'array' or jsonb_typeof(p_generation->'checks') is distinct from 'array'
  or jsonb_array_length(p_generation->'checks')<>j.expected_requests/2
  or p_generation->'reviewedChunks' is distinct from (select jsonb_agg(c->'id' order by ord) from jsonb_array_elements(j.binding->'chunks') with ordinality t(c,ord))
  then return false; end if;
 update public.knowledge_hint_generations_v1 set generation=p_generation,verified=true,state='ready'
 where business_id=p_business_id and source_id=p_source_id and producer_version=p_version and epoch=j.epoch;
 return true;
end $$;
create function public.read_knowledge_hint_generations_v1(p_business_id bigint,p_version text,p_expected_sources jsonb default null) returns jsonb
language sql stable security invoker set search_path=pg_catalog as $$
 with sources as (select id from public.knowledge_sources where business_id=p_business_id and type='document' and status='ready'),
 generations as (select g.source_id,g.generation from public.knowledge_hint_generations_v1 g
 join public.knowledge_hint_source_epochs e on e.business_id=g.business_id and e.source_id=g.source_id and e.epoch=g.epoch
 where g.business_id=p_business_id and g.producer_version=p_version and g.state='ready' and g.verified
 and g.snapshot_token=knowledge_hint_private.source_token(g.business_id,g.source_id) order by g.source_id limit 201)
 select case when (select count(*) from sources)>200 or count(*)>200 or coalesce(sum(octet_length(generation::text)),0)>2000000
  or (p_expected_sources is not null and p_expected_sources is distinct from (select coalesce(jsonb_agg(id::text order by id),'[]'::jsonb) from sources))
  then null else coalesce(jsonb_agg(generation order by source_id),'[]'::jsonb) end from generations;
$$;
-- Backend-only RPCs; no authenticated/anon access or owner-written search hints.
revoke all on all functions in schema knowledge_hint_private from public,anon,authenticated;
grant execute on function knowledge_hint_private.source_json(bigint,uuid),knowledge_hint_private.source_token(bigint,uuid) to service_role;
revoke all on function public.knowledge_hint_source_snapshot_v1(bigint,uuid,text),public.claim_knowledge_hint_generation_v1(bigint,uuid,text,text,text,jsonb,jsonb,integer),
 public.transition_knowledge_hint_generation_v1(bigint,uuid,text,uuid,text,text,integer),public.complete_knowledge_hint_generation_v1(bigint,uuid,text,uuid,text,jsonb),
 public.read_knowledge_hint_generations_v1(bigint,text,jsonb) from public,anon,authenticated;
grant execute on function public.knowledge_hint_source_snapshot_v1(bigint,uuid,text),public.claim_knowledge_hint_generation_v1(bigint,uuid,text,text,text,jsonb,jsonb,integer),
 public.transition_knowledge_hint_generation_v1(bigint,uuid,text,uuid,text,text,integer),public.complete_knowledge_hint_generation_v1(bigint,uuid,text,uuid,text,jsonb),
 public.read_knowledge_hint_generations_v1(bigint,text,jsonb) to service_role;
commit;
