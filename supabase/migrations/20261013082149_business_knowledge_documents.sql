-- REVIEW ONLY: requires existing Knowledge source/chunk/embedding and membership migrations.
-- Bucket creation is intentionally a separate, human-approved Storage API operation.
begin;
alter table public.knowledge_sources drop constraint knowledge_sources_type_valid;
alter table public.knowledge_sources add constraint knowledge_sources_type_valid
  check (type = btrim(type) and type in ('faq','text','pdf','website','document'));
alter table public.knowledge_sources drop constraint knowledge_sources_status_valid;
alter table public.knowledge_sources add constraint knowledge_sources_status_valid
  check (status = btrim(status) and status in ('pending','processing','ready','failed','deleted','disabled','error'));

create table public.knowledge_documents (
  source_id uuid primary key,
  business_id bigint not null,
  object_key text not null unique,
  filename text not null check (length(filename) between 1 and 200),
  mime text not null,
  format text not null check (format in ('pdf','docx','txt','csv','xlsx')),
  bytes integer not null check (bytes between 1 and 5242880),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  uploaded_by uuid not null,
  uploaded boolean not null default false,
  lease_token uuid,
  lease_until timestamptz,
  attempts integer not null default 0,
  error_code text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (source_id,business_id) references public.knowledge_sources(id,business_id) on delete cascade,
  check (object_key = business_id::text || '/' || source_id::text || '/original.' || format)
);
create index knowledge_documents_recovery_idx on public.knowledge_documents(lease_until,created_at) where deleted_at is null;
alter table public.knowledge_documents enable row level security;
revoke all on public.knowledge_documents from public, anon, authenticated;
grant all on public.knowledge_documents to service_role;

-- Independent tombstones survive source/business cascade deletion and server crashes.
create table public.knowledge_document_cleanup (
  object_key text primary key,
  created_at timestamptz not null default now()
);
alter table public.knowledge_document_cleanup enable row level security;
revoke all on public.knowledge_document_cleanup from public, anon, authenticated;
grant all on public.knowledge_document_cleanup to service_role;
create function public.queue_knowledge_document_cleanup() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
begin
  insert into public.knowledge_document_cleanup(object_key) values (old.object_key) on conflict do nothing;
  return old;
end; $$;
revoke all on function public.queue_knowledge_document_cleanup() from public,anon,authenticated;
create trigger knowledge_document_cleanup_before_delete before delete on public.knowledge_documents
  for each row execute function public.queue_knowledge_document_cleanup();

-- Fenced transaction boundaries; only the server service role can invoke these.
create function public.create_knowledge_document(p_business_id bigint,p_id uuid,p_filename text,p_mime text,p_format text,p_bytes integer,p_sha256 text,p_user uuid)
returns void language plpgsql security invoker set search_path = pg_catalog as $$
begin
  if not exists (select 1 from public.business_memberships where business_id=p_business_id and user_id=p_user and status='active' and role in ('owner','admin','manager')) then
    raise exception 'document_forbidden';
  end if;
  perform pg_advisory_xact_lock(p_business_id);
  if (select count(*) from public.knowledge_documents d where business_id=p_business_id and (deleted_at is null or exists(select 1 from public.knowledge_document_cleanup c where c.object_key=d.object_key)))>=50
    or (select coalesce(sum(bytes),0) from public.knowledge_documents d where business_id=p_business_id and (deleted_at is null or exists(select 1 from public.knowledge_document_cleanup c where c.object_key=d.object_key)))+p_bytes>104857600 then
    raise exception 'document_quota';
  end if;
  insert into public.knowledge_sources(id,business_id,type,title,status,metadata)
    values (p_id,p_business_id,'document',p_filename,'pending',jsonb_build_object('source','document','filename',p_filename,'format',p_format,'bytes',p_bytes,'untrusted',true));
  insert into public.knowledge_documents(source_id,business_id,object_key,filename,mime,format,bytes,sha256,uploaded_by)
    values (p_id,p_business_id,p_business_id::text||'/'||p_id::text||'/original.'||p_format,p_filename,p_mime,p_format,p_bytes,p_sha256,p_user);
end; $$;

create function public.transition_knowledge_document(p_business_id bigint,p_id uuid,p_action text,p_token uuid default null,p_content text default '',p_chunks jsonb default '[]',p_metadata jsonb default '{}',p_error text default null)
returns jsonb language plpgsql security invoker set search_path = pg_catalog as $$
declare d public.knowledge_documents; s public.knowledge_sources; token uuid;
begin
  -- Lock source first, matching FK/cascade lock order. Serializes publish/delete/retry.
  select * into s from public.knowledge_sources where id=p_id and business_id=p_business_id for update;
  if not found then return null; end if;
  select * into d from public.knowledge_documents where source_id=p_id and business_id=p_business_id for update;
  if not found then return null; end if;
  if p_action='delete' then
    update public.knowledge_sources set status='deleted',content='',metadata=metadata-'segments' where id=p_id and business_id=p_business_id;
    delete from public.knowledge_chunks where source_id=p_id and business_id=p_business_id;
    update public.knowledge_documents set deleted_at=coalesce(deleted_at,now()),lease_token=null,lease_until=null where source_id=p_id;
    insert into public.knowledge_document_cleanup(object_key) values(d.object_key) on conflict do nothing;
    return jsonb_build_object('object_key',d.object_key);
  end if;
  if d.deleted_at is not null then return null; end if;
  if p_action in ('upload_failed','abandon_upload') then
    -- Recheck under both locks, including ambiguous upload acknowledgements.
    -- An accepted upload can never be undone by a stale uploader/recovery sweep.
    if d.uploaded or s.status<>'pending' then return null; end if;
    if p_action='abandon_upload' and d.created_at>clock_timestamp()-interval '120 seconds' then return null; end if;
    update public.knowledge_sources set status='failed',content='' where id=p_id;
    delete from public.knowledge_chunks where source_id=p_id and business_id=p_business_id;
    update public.knowledge_documents set uploaded=false,error_code=p_error,lease_token=null,lease_until=null where source_id=p_id;
    insert into public.knowledge_document_cleanup(object_key) values(d.object_key) on conflict do nothing;
    return jsonb_build_object('ok',true);
  end if;
  if p_action='retry' then
    if not d.uploaded or d.attempts>=3 then return null; end if;
    if s.status='ready' or (s.status='processing' and d.lease_until>now()) then return jsonb_build_object('ok',true); end if;
    update public.knowledge_sources set status='pending' where id=p_id;
    update public.knowledge_documents set error_code=null,lease_token=null,lease_until=null where source_id=p_id;
  elsif p_action='uploaded' and s.status='pending' then
    update public.knowledge_documents set uploaded=true where source_id=p_id;
  elsif p_action='uploaded' then return null;
  elsif p_action='claim' then
    if not d.uploaded or s.status='ready' or (s.status='processing' and d.lease_until>now()) then return null; end if;
    if d.attempts>=3 then
      update public.knowledge_sources set status='failed',content='' where id=p_id;
      update public.knowledge_documents set error_code='document_attempts' where source_id=p_id;
      return null;
    end if;
    token=gen_random_uuid();
    update public.knowledge_documents set lease_token=token,lease_until=now()+interval '120 seconds',attempts=attempts+1,error_code=null where source_id=p_id;
    update public.knowledge_sources set status='processing',content='' where id=p_id;
    delete from public.knowledge_chunks where source_id=p_id and business_id=p_business_id;
    return to_jsonb(d)||jsonb_build_object('lease_token',token);
  elsif p_action in ('finish','fail') then
    if s.status<>'processing' or p_token is null or d.lease_token is distinct from p_token or d.lease_until is null or d.lease_until<=clock_timestamp() then return null; end if;
    if p_action='finish' then
      if length(p_content) not between 1 and 100000 or jsonb_array_length(p_chunks) not between 1 and 200 then raise exception 'document_limits'; end if;
      perform public.replace_knowledge_chunks(p_business_id,p_id,p_chunks);
      update public.knowledge_sources set content=p_content,status='ready',metadata=metadata||p_metadata where id=p_id and business_id=p_business_id;
    else
      delete from public.knowledge_chunks where source_id=p_id and business_id=p_business_id;
      update public.knowledge_sources set status='failed',content='' where id=p_id;
      update public.knowledge_documents set error_code=p_error where source_id=p_id;
      if p_error='document_sensitive' then
        update public.knowledge_documents set uploaded=false where source_id=p_id;
        insert into public.knowledge_document_cleanup(object_key) values(d.object_key) on conflict do nothing;
      end if;
    end if;
    update public.knowledge_documents set lease_token=null,lease_until=null where source_id=p_id;
  else return null;
  end if;
  return jsonb_build_object('ok',true);
end; $$;
revoke all on function public.create_knowledge_document(bigint,uuid,text,text,text,integer,text,uuid) from public,anon,authenticated;
revoke all on function public.transition_knowledge_document(bigint,uuid,text,uuid,text,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.create_knowledge_document(bigint,uuid,text,text,text,integer,text,uuid) to service_role;
grant execute on function public.transition_knowledge_document(bigint,uuid,text,uuid,text,jsonb,jsonb,text) to service_role;

-- Backend-only object access. RESTRICTIVE policies prevent unrelated broad permissive
-- policies from accidentally exposing this private bucket. No client upload/download URLs.
create policy business_knowledge_no_client_select on storage.objects as restrictive for select to anon,authenticated using(bucket_id<>'business-knowledge');
create policy business_knowledge_no_client_insert on storage.objects as restrictive for insert to anon,authenticated with check(bucket_id<>'business-knowledge');
create policy business_knowledge_no_client_update on storage.objects as restrictive for update to anon,authenticated using(bucket_id<>'business-knowledge') with check(bucket_id<>'business-knowledge');
create policy business_knowledge_no_client_delete on storage.objects as restrictive for delete to anon,authenticated using(bucket_id<>'business-knowledge');
commit;
