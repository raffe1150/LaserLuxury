// Draft SQL validation only: disposable local cluster, one rolled-back transaction,
// no Supabase access, bucket creation or migration history. --concurrency-only
// commits fixtures exclusively in this disposable cluster for two-session races.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(resolve(tmpdir(), 'odinlink-doc-sql-'));
const data = resolve(scratch,'data'); const socket = resolve(scratch,'socket'); mkdirSync(socket);
const file = (name) => readFileSync(resolve(root,'supabase/migrations',name),'utf8');
const draft = file('20261013082149_business_knowledge_documents.sql').replace(/^begin;$/m,'').replace(/^commit;$/m,'');
const checks = String.raw`
insert into public.businesses values(1),(2),(3);
insert into public.business_memberships values
(1,'11111111-1111-4111-8111-111111111111','owner','active'),
(2,'22222222-2222-4222-8222-222222222222','owner','active'),
(3,'11111111-1111-4111-8111-111111111111','owner','active');
insert into public.knowledge_sources(id,business_id,type,title,status,content) values
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,'text','Manual','ready','Manual policy retained'),
('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',2,'text','Foreign','ready','Foreign policy');
select public.replace_knowledge_chunks(1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','[{"chunk_index":0,"content":"Manual policy retained"}]');
select public.replace_knowledge_chunks(2,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','[{"chunk_index":0,"content":"Foreign policy"}]');
do $$ declare r jsonb; t uuid; old_token uuid; begin
  begin
    perform public.create_knowledge_document(2,'cccccccc-cccc-4ccc-8ccc-cccccccccccc','policy.txt','text/plain','txt',12,repeat('a',64),'11111111-1111-4111-8111-111111111111');
    raise exception 'cross-business creation accepted';
  exception when raise_exception then if sqlerrm<>'document_forbidden' then raise; end if; end;
  perform public.create_knowledge_document(1,'cccccccc-cccc-4ccc-8ccc-cccccccccccc','policy.txt','text/plain','txt',12,repeat('a',64),'11111111-1111-4111-8111-111111111111');
  if public.transition_knowledge_document(2,'cccccccc-cccc-4ccc-8ccc-cccccccccccc','claim') is not null then raise exception 'foreign claim'; end if;
  if public.transition_knowledge_document(1,'cccccccc-cccc-4ccc-8ccc-cccccccccccc','claim') is not null then raise exception 'unstored file claimed'; end if;
  perform public.transition_knowledge_document(1,'cccccccc-cccc-4ccc-8ccc-cccccccccccc','uploaded');
  r=public.transition_knowledge_document(1,'cccccccc-cccc-4ccc-8ccc-cccccccccccc','claim'); old_token=(r->>'lease_token')::uuid;
  if old_token is null then raise exception 'claim not leased'; end if;
  if public.transition_knowledge_document(1,'cccccccc-cccc-4ccc-8ccc-cccccccccccc','claim') is not null then raise exception 'duplicate live claim'; end if;
  if exists(select 1 from public.search_knowledge_chunks(1,'policy') where source_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc') then raise exception 'processing retrieved'; end if;
  if public.transition_knowledge_document(1,'cccccccc-cccc-4ccc-8ccc-cccccccccccc','abandon_upload') is not null then raise exception 'processing upload abandoned'; end if;
  if public.transition_knowledge_document(1,'cccccccc-cccc-4ccc-8ccc-cccccccccccc','upload_failed') is not null then raise exception 'accepted upload cancelled'; end if;

  begin
    perform public.transition_knowledge_document(1,'cccccccc-cccc-4ccc-8ccc-cccccccccccc','finish',old_token,'Policy','[{"chunk_index":-1,"content":"Policy"}]');
    raise exception 'invalid chunks accepted';
  exception when raise_exception then if sqlerrm<>'invalid_chunk' then raise; end if; end;
  if (select status from public.knowledge_sources where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc')<>'processing' then raise exception 'failed publish not atomic'; end if;
  update public.knowledge_documents set lease_until=now()-interval '1 second' where source_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  r=public.transition_knowledge_document(1,'cccccccc-cccc-4ccc-8ccc-cccccccccccc','claim'); t=(r->>'lease_token')::uuid;
  if t is null or t=old_token then raise exception 'lease not recovered'; end if;
  if public.transition_knowledge_document(1,'cccccccc-cccc-4ccc-8ccc-cccccccccccc','fail',old_token,p_error=>'document_sensitive') is not null then raise exception 'stale sensitive failure accepted'; end if;
  if public.transition_knowledge_document(1,'cccccccc-cccc-4ccc-8ccc-cccccccccccc','quarantine',old_token,p_error=>'document_sensitive') is not null then raise exception 'unfenced quarantine accepted'; end if;
  if exists(select 1 from public.knowledge_document_cleanup where object_key='1/cccccccc-cccc-4ccc-8ccc-cccccccccccc/original.txt') then raise exception 'stale quarantine queued cleanup'; end if;
  if (select lease_token<>t or not uploaded from public.knowledge_documents where source_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc') then raise exception 'new lease invalidated'; end if;

  if public.transition_knowledge_document(1,'cccccccc-cccc-4ccc-8ccc-cccccccccccc','finish',old_token,'Stale policy','[{"chunk_index":0,"content":"Stale policy"}]') is not null then raise exception 'stale worker published'; end if;
  perform public.transition_knowledge_document(1,'cccccccc-cccc-4ccc-8ccc-cccccccccccc','finish',t,'Document policy','[{"chunk_index":0,"content":"Document policy","metadata":{"page":1}}]','{"extractorVersion":1}');
  if not exists(select 1 from public.search_knowledge_chunks(1,'policy') where source_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc') then raise exception 'ready not retrieved'; end if;
  if exists(select 1 from public.search_knowledge_chunks(2,'policy') where source_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc') then raise exception 'cross-business retrieval'; end if;
  if public.transition_knowledge_document(2,'cccccccc-cccc-4ccc-8ccc-cccccccccccc','delete') is not null then raise exception 'foreign delete'; end if;
  perform public.transition_knowledge_document(1,'cccccccc-cccc-4ccc-8ccc-cccccccccccc','delete');
  perform public.transition_knowledge_document(1,'cccccccc-cccc-4ccc-8ccc-cccccccccccc','delete');
  if (select status<>'deleted' or content<>'' from public.knowledge_sources where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc') then raise exception 'delete not hidden'; end if;
  if exists(select 1 from public.knowledge_chunks where source_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc') then raise exception 'chunks not deleted'; end if;
  if not exists(select 1 from public.knowledge_document_cleanup where object_key='1/cccccccc-cccc-4ccc-8ccc-cccccccccccc/original.txt') then raise exception 'cleanup not durable'; end if;
  if public.transition_knowledge_document(1,'cccccccc-cccc-4ccc-8ccc-cccccccccccc','finish',t,'Late policy','[{"chunk_index":0,"content":"Late policy"}]') is not null then raise exception 'delete resurrected'; end if;
  perform public.create_knowledge_document(1,'dddddddd-dddd-4ddd-8ddd-dddddddddddd','failure.txt','text/plain','txt',12,repeat('a',64),'11111111-1111-4111-8111-111111111111');
  perform public.transition_knowledge_document(1,'dddddddd-dddd-4ddd-8ddd-dddddddddddd','uploaded');
  for i in 1..3 loop
    r=public.transition_knowledge_document(1,'dddddddd-dddd-4ddd-8ddd-dddddddddddd','claim');
    t=(r->>'lease_token')::uuid;
    if t is null then raise exception 'retry not claimed'; end if;
    perform public.transition_knowledge_document(1,'dddddddd-dddd-4ddd-8ddd-dddddddddddd','fail',t,p_error=>'document_parse');
    if exists(select 1 from public.search_knowledge_chunks(1,'policy') where source_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd') then raise exception 'failed retrieved'; end if;
    if i<3 then perform public.transition_knowledge_document(1,'dddddddd-dddd-4ddd-8ddd-dddddddddddd','retry'); end if;
  end loop;
  if public.transition_knowledge_document(1,'dddddddd-dddd-4ddd-8ddd-dddddddddddd','retry') is not null then raise exception 'attempt limit bypassed'; end if;
  perform public.create_knowledge_document(3,'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','cascade.txt','text/plain','txt',12,repeat('a',64),'11111111-1111-4111-8111-111111111111');
  delete from public.businesses where id=3;
  if not exists(select 1 from public.knowledge_document_cleanup where object_key='3/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/original.txt') then raise exception 'cascade cleanup missing'; end if;
  if not exists(select 1 from public.search_knowledge_chunks(1,'policy') where source_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') then raise exception 'manual knowledge changed'; end if;
end $$;
-- Deterministic interleavings: a recovery snapshot is stale by the time the RPC locks.
do $$ declare v_id uuid; r jsonb; t uuid; old_token uuid; begin
  v_id='ffffffff-ffff-4fff-8fff-ffffffffffff';
  perform public.create_knowledge_document(1,v_id,'accepted.txt','text/plain','txt',12,repeat('a',64),'11111111-1111-4111-8111-111111111111');
  update public.knowledge_documents set created_at=clock_timestamp()-interval '121 seconds' where source_id=v_id;
  -- Recovery observes uploaded=false, then the uploader commits its acceptance.
  perform public.transition_knowledge_document(1,v_id,'uploaded');
  if public.transition_knowledge_document(1,v_id,'abandon_upload') is not null then raise exception 'completed upload lost to stale recovery'; end if;
  if exists(select 1 from public.knowledge_document_cleanup where object_key='1/'||v_id||'/original.txt') then raise exception 'accepted upload queued'; end if;
  if (select not uploaded from public.knowledge_documents where source_id=v_id) or (select status<>'pending' from public.knowledge_sources where knowledge_sources.id=v_id) then raise exception 'accepted upload changed'; end if;
  v_id='10101010-1010-4010-8010-101010101010';
  perform public.create_knowledge_document(1,v_id,'abandoned.txt','text/plain','txt',12,repeat('a',64),'11111111-1111-4111-8111-111111111111');
  if public.transition_knowledge_document(1,v_id,'abandon_upload') is not null then raise exception 'fresh upload abandoned'; end if;
  update public.knowledge_documents set created_at=clock_timestamp()-interval '121 seconds' where source_id=v_id;
  if public.transition_knowledge_document(1,v_id,'abandon_upload') is null then raise exception 'abandoned upload retained'; end if;
  if (select status<>'failed' from public.knowledge_sources where knowledge_sources.id=v_id) or not exists(select 1 from public.knowledge_document_cleanup where object_key='1/'||v_id||'/original.txt') then raise exception 'abandonment not durable'; end if;
  if public.transition_knowledge_document(1,v_id,'uploaded') is not null then raise exception 'abandoned upload accepted late'; end if;
  v_id='20202020-2020-4020-8020-202020202020';
  perform public.create_knowledge_document(1,v_id,'sensitive.txt','text/plain','txt',12,repeat('a',64),'11111111-1111-4111-8111-111111111111');
  perform public.transition_knowledge_document(1,v_id,'uploaded');
  r=public.transition_knowledge_document(1,v_id,'claim'); old_token=(r->>'lease_token')::uuid;
  update public.knowledge_documents set lease_until=clock_timestamp()-interval '1 second' where source_id=v_id;
  if public.transition_knowledge_document(1,v_id,'fail',old_token,p_error=>'document_sensitive') is not null then raise exception 'expired worker quarantined'; end if;
  r=public.transition_knowledge_document(1,v_id,'claim'); t=(r->>'lease_token')::uuid;
  if public.transition_knowledge_document(1,v_id,'fail',old_token,p_error=>'document_sensitive') is not null then raise exception 'competing lease quarantined'; end if;
  if exists(select 1 from public.knowledge_document_cleanup where object_key='1/'||v_id||'/original.txt') then raise exception 'stale lease queued cleanup'; end if;
  perform public.transition_knowledge_document(1,v_id,'fail',t,p_error=>'document_sensitive');
  if (select status<>'failed' or content<>'' from public.knowledge_sources where knowledge_sources.id=v_id) then raise exception 'sensitive failure not committed'; end if;
  if (select uploaded or lease_token is not null or error_code<>'document_sensitive' from public.knowledge_documents where source_id=v_id) then raise exception 'sensitive lease not cleared'; end if;
  if not exists(select 1 from public.knowledge_document_cleanup where object_key='1/'||v_id||'/original.txt') then raise exception 'sensitive cleanup not committed'; end if;
  if public.transition_knowledge_document(1,v_id,'retry') is not null then raise exception 'quarantined document retried'; end if;
  perform public.transition_knowledge_document(1,v_id,'delete');
end $$;
insert into storage.objects(bucket_id,name) values('business-knowledge','1/file'),('avatars','avatar');
-- Prove restrictive bucket denials still hold beside a broad permissive policy.
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
do $$ begin
  if exists(select 1 from public.knowledge_sources where business_id=2) then raise exception 'foreign source RLS'; end if;
  if exists(select 1 from public.knowledge_chunks where business_id=2) then raise exception 'foreign chunk RLS'; end if;
  if exists(select 1 from storage.objects where bucket_id='business-knowledge') then raise exception 'private object read'; end if;
  if not exists(select 1 from storage.objects where bucket_id='avatars') then raise exception 'unrelated bucket affected'; end if;
  begin perform 1 from public.knowledge_documents; raise exception 'metadata exposed'; exception when insufficient_privilege then null; end;
  begin insert into storage.objects(bucket_id,name) values('business-knowledge','x'); raise exception 'direct client upload'; exception when insufficient_privilege then null; end;
  if has_function_privilege(current_user,'public.transition_knowledge_document(bigint,uuid,text,uuid,text,jsonb,jsonb,text)','execute') then raise exception 'RPC exposed'; end if;
  if has_function_privilege(current_user,'public.create_knowledge_document(bigint,uuid,text,text,text,integer,text,uuid)','execute') then raise exception 'create exposed'; end if;
end $$;
set local role anon;
do $$ begin
  if exists(select 1 from storage.objects where bucket_id='business-knowledge') then raise exception 'anonymous document read'; end if;
  begin perform 1 from public.knowledge_sources; raise exception 'anonymous source read'; exception when insufficient_privilege then null; end;
end $$;
reset role;
`;
let started=false;
try {
  execFileSync('initdb',['-D',data,'--auth=trust','--username=fixture_admin'],{stdio:'pipe'});
  execFileSync('pg_ctl',['-D',data,'-l',resolve(scratch,'postgres.log'),'-o',`-k ${socket} -c listen_addresses=''`,'-w','start'],{stdio:'pipe'});started=true;
  const sql=`begin;
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create schema storage;
create function auth.uid() returns uuid language sql stable as 'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
create table public.businesses(id bigint primary key);
create table public.business_memberships(business_id bigint references public.businesses(id) on delete cascade,user_id uuid,role text,status text);
grant usage on schema public,auth,storage to anon,authenticated,service_role;
grant select on public.business_memberships to authenticated;
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
alter table storage.objects enable row level security;
grant select,insert,update,delete on storage.objects to anon,authenticated,service_role;
create policy permissive_fixture on storage.objects for all to anon,authenticated using(true) with check(true);
${file('20260908212500_create_tenant_safe_knowledge_sources.sql')}
${file('20260908220200_harden_knowledge_sources_grants.sql')}
${file('20260926111502_create_tenant_safe_knowledge_chunks.sql')}
${draft}
grant all on all tables in schema public to service_role;
${checks}
rollback;
`;
  if (process.argv.includes('--concurrency-only')) {
    const setup=sql.slice(0,sql.indexOf(checks))+'commit;';
    await concurrentChecks(setup);
  } else {
  execFileSync('psql',['-X','-v','ON_ERROR_STOP=1','-h',socket,'-U','fixture_admin','-d','postgres'],{input:sql,stdio:['pipe','pipe','pipe']});
  console.log('PASS: draft SQL rolled back; stale upload recovery, abandoned cleanup, atomic sensitive failure, competing lease fencing, atomic publish, lease fencing/recovery, retry ceiling, scoped delete, cascade cleanup, ready-only search, manual preservation, tenant RLS and restrictive storage denial.');
  }
} catch(error) { console.error(error.stderr?.toString() || error.message);process.exitCode=1; }
finally { if(started)execFileSync('pg_ctl',['-D',data,'-m','immediate','-w','stop'],{stdio:'pipe'});rmSync(scratch,{recursive:true,force:true}); }

async function concurrentChecks(setup) {
  const args=['-X','-Atq','-v','ON_ERROR_STOP=1','-h',socket,'-U','fixture_admin','-d','postgres'];
  const execute=sql=>execFileSync('psql',args,{input:sql,encoding:'utf8'}).trim();
  execute(setup);
  execute(`insert into public.businesses values(1);
    insert into public.business_memberships values(1,'11111111-1111-4111-8111-111111111111','owner','active');
    select public.create_knowledge_document(1,'30303030-3030-4030-8030-303030303030','race.txt','text/plain','txt',12,repeat('a',64),'11111111-1111-4111-8111-111111111111');
    update public.knowledge_documents set created_at=clock_timestamp()-interval '121 seconds';`);
  const clients=[];
  const connection=()=>{
    const child=spawn('psql',args);clients.push(child);let output='';let errors='';
    child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>errors+=data);
    const done=new Promise((resolve,reject)=>child.on('close',code=>code===0?resolve():reject(new Error(errors))));
    done.catch(()=>{});
    return {child,done,output:()=>output};
  };
  const until=async(check)=>{const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw new Error('concurrent SQL barrier timed out');await new Promise(r=>setTimeout(r,20));}};
  const race=async(id,blockedSql,winningSql,tag)=>{
    const winner=connection();const loser=connection();
    winner.child.stdin.write(`begin;select id from public.knowledge_sources where id='${id}' for update;select 'locked';\n`);
    await until(()=>winner.output().includes('locked'));
    loser.child.stdin.end(blockedSql+` /* ${tag} */;\n`);
    await until(()=>execute(`select count(*) from pg_stat_activity where query like '%${tag}%' and wait_event_type='Lock';`)==='1');
    winner.child.stdin.end(winningSql+';commit;\n');
    await Promise.all([winner.done,loser.done]);
    if(loser.output()!=='null\n')throw new Error('stale transition did not return null: '+loser.output());
  };
  try {
    const id='30303030-3030-4030-8030-303030303030';
    await race(id,`select coalesce(public.transition_knowledge_document(1,'${id}','abandon_upload')::text,'null')`,
      `select public.transition_knowledge_document(1,'${id}','uploaded')`,'odinlink_abandon_race');
    if(execute(`select uploaded and s.status='pending' and not exists(select 1 from public.knowledge_document_cleanup) from public.knowledge_documents d join public.knowledge_sources s on s.id=d.source_id where s.id='${id}';`)!=='t')throw new Error('concurrently accepted upload changed');
    console.log('PASS: two-session upload completion wins against blocked stale abandonment.');
    execute(`select public.transition_knowledge_document(1,'${id}','claim');`);
    const token=execute(`select lease_token from public.knowledge_documents where source_id='${id}';`);
    execute(`update public.knowledge_documents set lease_until=clock_timestamp()-interval '1 second' where source_id='${id}';`);
    await race(id,`select coalesce(public.transition_knowledge_document(1,'${id}','fail','${token}',p_error=>'document_sensitive')::text,'null')`,
      `select public.transition_knowledge_document(1,'${id}','claim')`,'odinlink_quarantine_race');
    if(execute(`select uploaded and lease_token<>'${token}' and s.status='processing' and not exists(select 1 from public.knowledge_document_cleanup) from public.knowledge_documents d join public.knowledge_sources s on s.id=d.source_id where s.id='${id}';`)!=='t')throw new Error('competing processing lease invalidated');
    console.log('PASS: two-session replacement lease rejects blocked stale sensitive failure without cleanup.');
  } finally {for(const client of clients)client.kill('SIGKILL');}
}
