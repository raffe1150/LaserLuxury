import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

// Deliberately accepts no database URL, credential file or existing server.
// Real SQL + pgvector, private initdb/Unix socket only, TCP disabled.
const bin = '/opt/homebrew/opt/postgresql@17/bin/';
const migration = 'supabase/migrations/20261024145329_durable_knowledge_source_index_coordination.sql';
const identity = { provider: 'openai', model: 'text-embedding-3-small', dimensions: 768, version: 1 };
const google = { provider: 'google', model: 'gemini-embedding-2', dimensions: 768, version: 1 };
const lit = (value: any): string => value === null ? 'NULL' : typeof value === 'number' ? String(value) :
  "'" + (typeof value === 'object' ? JSON.stringify(value) : String(value)).replaceAll("'", "''") + "'" + (typeof value === 'object' ? '::jsonb' : '');
const vector = Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0);

test('durable source index: actual disposable PostgreSQL transactions', { timeout: 120_000 }, async t => {
  const root = mkdtempSync('/tmp/odin-index-'); const socket = join(root, 'socket'); mkdirSync(socket, { mode: 0o700 });
  const env = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', PGPASSFILE: '/dev/null', PSQLRC: '/dev/null' };
  const run = (name: string, args: string[], input?: string) => {
    const p = spawnSync(bin + name, args, { env, input, encoding: 'utf8', timeout: 25_000, maxBuffer: 8_000_000 });
    if (p.status !== 0) throw new Error(name + ': ' + p.stderr);
    return p.stdout.trim();
  };
  const args = ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', '55448', '-U', 'postgres', '-d', 'postgres'];
  const sql = (q: string, role = 'service_role') => run('psql', args, `SET statement_timeout='8s'; SET ROLE ${role};\n${q}`);
  const json = (q: string, role?: string) => JSON.parse(sql(q, role));
  const asyncSql = async (q: string) => (await promisify(execFile)(bin + 'psql', [...args, '-c', `SET statement_timeout='8s'; SET ROLE service_role; ${q}`],
    { env, timeout: 15_000, maxBuffer: 8_000_000 })).stdout.trim();
  const rpc = (name: string, values: any[]) => `public.${name}(${values.map(lit).join(',')})`;
  const source = (tenant = 77, count = 2) => {
    const id = randomUUID(); const chunks = Array.from({ length: count }, (_, i) => ({ chunk_index: i,
      content: `${tenant}: Synthetic instruction ${i}; only if separately approved. Svenska فارسی العربية.`,
      metadata: { source: 'document', page: i + 1, untrusted: true } }));
    sql(`INSERT INTO public.knowledge_sources(id,business_id,type,title,status,content,metadata) VALUES (${lit(id)},${tenant},'document','Synthetic','ready',${lit(chunks.map(c => c.content).join('\n'))},'{"segments":[],"untrusted":true}');
      SELECT public.replace_knowledge_chunks(${tenant},${lit(id)},${lit(chunks)});`);
    return { id, tenant, chunks };
  };
  type Source = { id: string; tenant: number };
  const claim = (s: Source, who = identity, canonical = 1) => json(`SELECT ${rpc('claim_knowledge_source_index_v1', [s.tenant, s.id, who, canonical])};`);
  const ready = (s: Source, who = identity) => json(`SELECT ${rpc('knowledge_source_index_readiness_v1', [s.tenant, s.id, who, 1])};`);
  const payload = (c: any, who = identity) => c.chunks.map((row: any) => ({ chunk_index: row.chunk_index, content: row.content,
    metadata: row.metadata, embedding: [...vector], embedding_provider: who.provider, embedding_model: who.model,
    embedding_dimensions: who.dimensions, embedding_version: who.version }));
  const completeQuery = (s: Source, c: any, p = payload(c), who = identity, canonical = 1) => `SELECT ${rpc('complete_knowledge_source_index_v1',
    [s.tenant, s.id, c.lease_token, c.content_revision, who, canonical, c.snapshot_token, p])};`;
  const transition = (s: Source, c: any, action: string, error: string | null = null) => sql(`SELECT ${rpc('transition_knowledge_source_index_v1', [s.tenant, s.id, c.lease_token, action, error])};`);
  const state = (s: Source) => json(`SELECT to_jsonb(s) FROM public.knowledge_source_index_state s WHERE business_id=${s.tenant} AND source_id=${lit(s.id)};`);
  const vectors = (s: Source) => json(`SELECT jsonb_agg(jsonb_build_array(embedding::text,embedding_provider,embedding_model,embedding_dimensions,embedding_version) ORDER BY chunk_index) FROM public.knowledge_chunks WHERE business_id=${s.tenant} AND source_id=${lit(s.id)};`);
  const expired = (s: Source, backoff = false) => sql(`UPDATE public.knowledge_source_index_state SET lease_until=clock_timestamp()-interval '1 second',next_attempt_at=clock_timestamp()+interval '${backoff ? 30 : -1} seconds' WHERE source_id=${lit(s.id)};`, 'postgres');
  let started = false;
  try {
    run('initdb', ['-D', join(root, 'data'), '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8']);
    run('pg_ctl', ['-D', join(root, 'data'), '-l', join(root, 'postgres.log'), '-o', `-h '' -k ${socket} -p 55448`, '-w', 'start']); started = true;
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA extensions; CREATE SCHEMA auth; CREATE SCHEMA storage;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid';
      CREATE TABLE public.businesses(id bigint PRIMARY KEY);
      CREATE TABLE public.business_memberships(business_id bigint,user_id uuid,status text,role text);
      CREATE TABLE storage.objects(bucket_id text);
      INSERT INTO public.businesses VALUES (77),(88),(99);`, 'postgres');
    const prerequisites = ['20260908212500_create_tenant_safe_knowledge_sources.sql', '20260908220200_harden_knowledge_sources_grants.sql',
      '20260926111502_create_tenant_safe_knowledge_chunks.sql', '20260926111832_harden_knowledge_chunks_performance.sql',
      '20260926224355_add_semantic_knowledge_embeddings.sql', '20260926225209_extend_replace_knowledge_chunks_for_embeddings.sql',
      '20260927000939_add_guarded_knowledge_embedding_backfill.sql', '20261013082149_business_knowledge_documents.sql'];
    for (const name of prerequisites) sql(readFileSync('supabase/migrations/' + name, 'utf8'), 'postgres');
    sql('GRANT USAGE ON SCHEMA public,extensions,auth TO service_role; GRANT ALL ON public.knowledge_sources,public.knowledge_chunks,public.business_memberships TO service_role;', 'postgres');
    const oldNames = ['replace_knowledge_chunks', 'search_knowledge_chunks_semantic', 'read_knowledge_embedding_backfill_source', 'backfill_knowledge_chunk_embeddings_if_unchanged', 'transition_knowledge_document'];
    const oldDefinitions = sql(`SELECT jsonb_object_agg(proname,pg_get_functiondef(oid)) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN (${oldNames.map(lit).join(',')});`, 'postgres');
    sql(readFileSync(migration, 'utf8'), 'postgres');

    await t.test('additive migration leaves all existing RPC definitions unchanged', () => {
      assert.equal(sql(`SELECT jsonb_object_agg(proname,pg_get_functiondef(oid)) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN (${oldNames.map(lit).join(',')});`, 'postgres'), oldDefinitions);
    });
    await t.test('backend-only functions, invoker security, pinned search paths, RLS and grants', () => {
      const names = ['knowledge_index_identity_valid_v1','knowledge_source_index_revision_v1','knowledge_source_index_vector_digest_v1',
        'knowledge_source_index_readiness_v1','claim_knowledge_source_index_v1','transition_knowledge_source_index_v1',
        'complete_knowledge_source_index_v1','knowledge_index_readiness_v1'];
      const fns = json(`SELECT jsonb_agg(jsonb_build_object('name',proname,'definer',prosecdef,'settings',proconfig,
        'anon',has_function_privilege('anon',oid,'execute'),'auth',has_function_privilege('authenticated',oid,'execute'),
        'backend',has_function_privilege('service_role',oid,'execute'))) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN (${names.map(lit).join(',')});`, 'postgres');
      assert.equal(fns.length, 8);
      for (const f of fns) { assert.equal(f.definer, false); assert.equal(f.anon, false); assert.equal(f.auth, false); assert.equal(f.backend, true); assert.ok(f.settings.some((x: string) => x.startsWith('search_path=pg_catalog'))); }
      assert.equal(sql("SELECT relrowsecurity FROM pg_class WHERE oid='public.knowledge_source_index_state'::regclass;", 'postgres'), 't');
      for (const role of ['anon','authenticated']) {
        assert.equal(sql(`SELECT has_table_privilege('${role}','public.knowledge_source_index_state','select,insert,update,delete');`, 'postgres'), 'f');
        assert.throws(() => sql('SELECT * FROM public.knowledge_source_index_state;', role), /permission denied/);
        assert.throws(() => sql(`SELECT public.knowledge_index_readiness_v1(77,${lit(identity)});`, role), /permission denied/);
      }
    });
    await t.test('simultaneous SQL transactions admit one of two workers, not mocked Promise serialization', async () => {
      const s = source();
      const q = `BEGIN; SELECT ${rpc('claim_knowledge_source_index_v1', [77,s.id,identity,1])}; SELECT pg_sleep(0.2); COMMIT;`;
      const out = await Promise.all([asyncSql(q), asyncSql(q)]);
      const claims = out.map(x => JSON.parse(x.split('\n').find(line => line.startsWith('{'))!));
      assert.equal(claims.filter(x => x.admitted).length, 1); assert.equal(claims.find(x => !x.admitted).reason, 'busy');
      assert.equal(state(s).attempts, 1);
    });
    await t.test('tenant/source scope is enforced on claim, completion, transition, readiness and FK', () => {
      const s = source(); const c = claim(s);
      assert.throws(() => claim({ ...s, tenant: 88 }), /scope_mismatch/);
      assert.throws(() => sql(completeQuery({ ...s, tenant: 88 }, c)), /scope_mismatch/);
      assert.throws(() => transition({ ...s, tenant: 88 }, c, 'renew'), /scope_mismatch/);
      assert.equal(ready({ ...s, tenant: 88 }).ready, false);
      assert.throws(() => sql(`INSERT INTO public.knowledge_source_index_state(business_id,source_id) VALUES(88,${lit(s.id)});`), /foreign key constraint/);
      assert.equal(state(s).attempts, 1);
    });
    await t.test('immutable revision includes complete text/provenance but excludes vectors and timestamps', () => {
      const s = source(); const r = ready(s).content_revision;
      sql(`UPDATE public.knowledge_sources SET updated_at=clock_timestamp() WHERE id=${lit(s.id)};
        UPDATE public.knowledge_chunks SET embedding=${lit(JSON.stringify(vector))}::extensions.vector,embedding_provider='google',updated_at=clock_timestamp() WHERE source_id=${lit(s.id)};`);
      assert.equal(ready(s).content_revision, r);
      sql(`UPDATE public.knowledge_chunks SET metadata=metadata||'{"section":"changed"}' WHERE source_id=${lit(s.id)} AND chunk_index=1;`);
      const next = ready(s).content_revision; assert.notEqual(next, r);
      sql(`UPDATE public.knowledge_sources SET metadata=metadata||'{"condition":"only if supplied"}' WHERE id=${lit(s.id)};`);
      assert.notEqual(ready(s).content_revision, next);
    });
    await t.test('expiry fences renewal/completion; recovery observes backoff and replaces token', () => {
      const s = source(); const c = claim(s); expired(s, true);
      assert.equal(transition(s, c, 'renew'), 'f'); assert.throws(() => sql(completeQuery(s,c)), /stale_claim/);
      assert.equal(claim(s).reason, 'backoff');
      expired(s); assert.equal(ready(s).retry_eligible, true);
      const next = claim(s); assert.equal(next.attempt, 2); assert.notEqual(next.lease_token,c.lease_token);
      assert.equal(transition(s,c,'fail','provider_failure'), 'f'); assert.throws(() => sql(completeQuery(s,c)), /stale_claim/);
      assert.equal(state(s).lease_token,next.lease_token);
    });
    await t.test('renewal has fixed lease and absolute job deadline, no caller-selected unlimited duration', () => {
      const s=source(); const c=claim(s); const first=state(s);
      assert.ok(Date.parse(first.lease_until)-Date.now()<=120_000); assert.ok(Date.parse(first.job_deadline)-Date.now()<=300_000);
      sql(`UPDATE public.knowledge_source_index_state SET job_deadline=clock_timestamp()+interval '2 seconds',lease_until=clock_timestamp()+interval '1 second' WHERE source_id=${lit(s.id)};`, 'postgres');
      assert.equal(transition(s,c,'renew'), 't'); assert.equal(state(s).lease_until,state(s).job_deadline);
      assert.equal(sql(`SELECT count(*) FROM pg_proc WHERE proname='transition_knowledge_source_index_v1' AND pronargs=6;`, 'postgres'), '0');
    });
    await t.test('lease maintenance changes neither content revision nor the original completion snapshot',()=>{
      const s=source();const c=claim(s);const before=ready(s).content_revision;
      assert.equal(transition(s,c,'renew'),'t');assert.equal(ready(s).content_revision,before);
      assert.equal(state(s).snapshot_token,c.snapshot_token);assert.equal(json(completeQuery(s,c)).ready,true);
    });
    for (const change of ['content','provenance','chunks','revoked','deleted']) await t.test(`changed ${change} fences the original generation`, () => {
      const s=source(); const c=claim(s);
      const q=change==='content'?`UPDATE public.knowledge_sources SET content=content||' changed' WHERE id=${lit(s.id)};`:
        change==='provenance'?`UPDATE public.knowledge_chunks SET metadata=metadata||'{"page":99}' WHERE source_id=${lit(s.id)};`:
        change==='chunks'?`DELETE FROM public.knowledge_chunks WHERE source_id=${lit(s.id)} AND chunk_index=1;`:
        `UPDATE public.knowledge_sources SET status='${change==='deleted'?'deleted':'disabled'}' WHERE id=${lit(s.id)};`;
      sql(q); assert.equal(transition(s,c,'renew'), 'f'); assert.throws(() => sql(completeQuery(s,c)), /source_changed|snapshot_changed/);
      assert.equal(ready(s).ready,false); assert.ok(vectors(s).every((v: any[])=>v[0]===null));
    });
    await t.test('timestamp-only change keeps content revision but strict original CAS still refuses commit', () => {
      const s=source();const c=claim(s);
      sql(`UPDATE public.knowledge_sources SET updated_at=clock_timestamp() WHERE id=${lit(s.id)};`);
      assert.equal(ready(s).content_revision,c.content_revision);assert.throws(()=>sql(completeQuery(s,c)),/snapshot_changed/);
    });
    const invalids: [string,(p:any[])=>void,RegExp][] = [
      ['partial preparation',p=>p.pop(),/incomplete_payload/],
      ['dimensions',p=>p[1].embedding.pop(),/invalid_vector/],
      ['NaN',p=>p[1].embedding[0]='NaN',/invalid_vector/],
      ['Infinity',p=>p[1].embedding[0]='Infinity',/invalid_vector/],
      ['overflow',p=>p[1].embedding[0]=1e100,/out of range|infinite|overflow/],
      ['zero vector',p=>p[1].embedding.fill(0),/invalid_vector/],
      ['missing vector',p=>delete p[1].embedding,/invalid_vector/],
      ['wrong quotation',p=>p[1].content='Unsupported replacement',/content_changed/],
      ['wrong provenance',p=>p[1].metadata.page=99,/content_changed/],
      ['duplicate chunk',p=>p[1]=structuredClone(p[0]),/duplicate_chunk_index/],
      ['wrong chunk index',p=>p[1].chunk_index=99,/content_changed/],
      ['wrong provider',p=>p[1].embedding_provider='google',/invalid_payload/],
      ['wrong model',p=>p[1].embedding_model='other',/invalid_payload/],
      ['wrong version',p=>p[1].embedding_version=2,/invalid_payload/],
    ];
    for (const [name,alter,error] of invalids) await t.test(`${name} cannot publish a partial or stale index`, () => {
      const s=source();const c=claim(s);const p=payload(c);alter(p);
      assert.throws(()=>sql(completeQuery(s,c,p)),error);assert.equal(ready(s).ready,false);
      assert.ok(vectors(s).every((v:any[])=>v[0]===null));assert.equal(state(s).state,'indexing');
    });
    await t.test('request identity and canonicalization version must exactly match the claim', () => {
      const s=source();const c=claim(s);
      for(const bad of [{...identity,model:'other'},{...identity,dimensions:1536},{...identity,version:2},{...identity,provider:'unknown'}])
        assert.throws(()=>claim(source(),bad),/invalid_request/);
      assert.throws(()=>claim(source(),identity,2),/invalid_request/);
      assert.throws(()=>sql(completeQuery(s,c,payload(c),google)),/stale_claim/);
      assert.throws(()=>sql(completeQuery(s,c,payload(c),identity,2)),/invalid_request/);
      assert.throws(()=>sql(completeQuery(s,{...c,snapshot_token:'wrong'})),/stale_claim/);
    });
    for(const who of [google,identity]) await t.test(`existing ${who.provider} vectors remain byte-identical and unproven`,()=>{
      const s=source();sql(`UPDATE public.knowledge_chunks SET embedding=${lit(JSON.stringify(vector))}::extensions.vector,
        embedding_provider=${lit(who.provider)},embedding_model=${lit(who.model)},embedding_dimensions=768,embedding_version=1 WHERE source_id=${lit(s.id)};`);
      const before=vectors(s);assert.equal(claim(s).reason,'existing_vectors_require_review');assert.equal(ready(s).ready,false);
      assert.deepEqual(vectors(s),before);assert.equal(state(s).attempts,0);
    });
    await t.test('a legacy vector writer racing generation cannot be overwritten by completion',()=>{
      const s=source();const c=claim(s);sql(`UPDATE public.knowledge_chunks SET embedding=${lit(JSON.stringify(vector))}::extensions.vector,
        embedding_provider='google',embedding_model='gemini-embedding-2',embedding_dimensions=768,embedding_version=1 WHERE source_id=${lit(s.id)};`);
      const before=vectors(s);assert.throws(()=>sql(completeQuery(s,c)),/snapshot_changed/);assert.deepEqual(vectors(s),before);
    });
    await t.test('complete vectors and readiness are atomically invisible before commit, visible together afterward', async()=>{
      const s=source();const c=claim(s);
      const completion=asyncSql(`BEGIN; ${completeQuery(s,c)} SELECT pg_advisory_xact_lock(28001); SELECT pg_sleep(0.6); COMMIT;`);
      let checkpoint=false;
      for(let i=0;i<30;i++){
        checkpoint=sql("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=28001 AND granted);",'postgres')==='t';
        if(checkpoint)break;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(checkpoint,true,'Completion reached its pre-commit barrier');
      // Reading while the actual completion transaction is open sees the old committed generation.
      assert.equal(ready(s).ready,false);assert.ok(vectors(s).every((v:any[])=>v[0]===null));
      await completion;assert.equal(ready(s).ready,true);assert.ok(vectors(s).every((v:any[])=>v[1]==='openai'));
      assert.equal(claim(s).reason,'already_ready');
    });
    await t.test('lost acknowledgement is idempotent, but changed payload/token/source is not',()=>{
      const s=source();const c=claim(s);assert.equal(json(completeQuery(s,c)).already_committed,false);
      const before=vectors(s);assert.deepEqual(json(completeQuery(s,c)),{ready:true,already_committed:true});assert.deepEqual(vectors(s),before);
      const p=payload(c);p[0].embedding[0]=.5;assert.throws(()=>sql(completeQuery(s,c,p)),/stale_claim/);
      assert.throws(()=>sql(completeQuery(s,{...c,lease_token:randomUUID()})),/stale_claim/);
      sql(`UPDATE public.knowledge_sources SET title='Revised' WHERE id=${lit(s.id)};`);
      assert.equal(ready(s).ready,false);assert.throws(()=>sql(completeQuery(s,c)),/stale_claim/);
    });
    await t.test('two simultaneous completions commit once and acknowledge the same generation idempotently',async()=>{
      const s=source();const c=claim(s);
      const results=await Promise.all([asyncSql(completeQuery(s,c)),asyncSql(completeQuery(s,c))]);
      const verdicts=results.map(x=>JSON.parse(x));
      assert.equal(verdicts.filter(x=>x.already_committed===false).length,1);
      assert.equal(verdicts.filter(x=>x.already_committed===true).length,1);
      assert.equal(ready(s).ready,true);assert.equal(state(s).attempts,1);
    });
    await t.test('foreign source payload cannot satisfy a tenant-owned original inventory',()=>{
      const a=source(77),b=source(88);const ca=claim(a),cb=claim(b);
      assert.throws(()=>sql(completeQuery(a,ca,payload(cb))),/content_changed/);
      assert.equal(ready(a).ready,false);assert.ok(vectors(a).every((v:any[])=>v[0]===null));
    });
    await t.test('another tenant completing work does not invalidate the original tenant snapshot',()=>{
      const a=source(77),b=source(88);const ca=claim(a),cb=claim(b);
      sql(completeQuery(b,cb));assert.equal(ready(a).content_revision,ca.content_revision);
      assert.equal(json(completeQuery(a,ca)).ready,true);assert.equal(ready(b).ready,true);
    });
    await t.test('an expired worker blocked behind a real row lock cannot complete after the lock releases',async()=>{
      const s=source();const c=claim(s);
      sql(`UPDATE public.knowledge_source_index_state SET lease_until=clock_timestamp()+interval '0.4 seconds' WHERE source_id=${lit(s.id)};`,'postgres');
      const blocker=asyncSql(`BEGIN; SELECT id FROM public.knowledge_sources WHERE id=${lit(s.id)} FOR UPDATE; SELECT pg_advisory_xact_lock(28002); SELECT pg_sleep(0.6); COMMIT;`);
      let checkpoint=false;
      for(let i=0;i<30;i++){
        checkpoint=sql("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=28002 AND granted);",'postgres')==='t';
        if(checkpoint)break;await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(checkpoint,true);
      await assert.rejects(asyncSql(completeQuery(s,c)),/stale_claim/);await blocker;
      assert.equal(ready(s).ready,false);assert.ok(vectors(s).every((v:any[])=>v[0]===null));
    });
    await t.test('fresh Google generation uses the same fenced store without cross-provider readiness',()=>{
      const s=source();const c=claim(s,google);
      assert.equal(json(completeQuery(s,c,payload(c,google),google)).ready,true);
      assert.equal(ready(s,google).ready,true);assert.equal(ready(s,identity).ready,false);
      const before=vectors(s);assert.equal(claim(s,identity).reason,'existing_vectors_require_review');
      assert.deepEqual(vectors(s),before);assert.equal(ready(s,google).ready,true);
    });
    await t.test('bounded complete inventories reject gaps and oversized sources before generation',()=>{
      const s=source();sql(`UPDATE public.knowledge_chunks SET chunk_index=chunk_index+10 WHERE source_id=${lit(s.id)};`);
      assert.throws(()=>claim(s),/invalid_inventory/);assert.throws(()=>claim(source(77,201)),/invalid_inventory/);
    });
    await t.test('transaction error after completion rolls back both vectors and readiness',()=>{
      const s=source();const c=claim(s);assert.throws(()=>sql(`BEGIN; ${completeQuery(s,c)} SELECT 1/0; COMMIT;`),/division by zero/);
      assert.equal(ready(s).ready,false);assert.equal(state(s).state,'indexing');assert.ok(vectors(s).every((v:any[])=>v[0]===null));
      assert.equal(json(completeQuery(s,c)).ready,true);
    });
    await t.test('injected readiness-update failure rolls back preceding vector writes inside the RPC',()=>{
      const s=source();const c=claim(s);
      sql(`CREATE FUNCTION public.test_index_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source_id=${lit(s.id)}::uuid AND NEW.state='ready' THEN RAISE EXCEPTION 'injected_readiness_failure'; END IF; RETURN NEW; END; $$;
        CREATE TRIGGER test_index_failure BEFORE UPDATE ON public.knowledge_source_index_state FOR EACH ROW EXECUTE FUNCTION public.test_index_failure();`, 'postgres');
      try {assert.throws(()=>sql(completeQuery(s,c)),/injected_readiness_failure/);assert.equal(ready(s).ready,false);assert.ok(vectors(s).every((v:any[])=>v[0]===null));}
      finally {sql('DROP TRIGGER test_index_failure ON public.knowledge_source_index_state; DROP FUNCTION public.test_index_failure();','postgres');}
    });
    await t.test('expired completion after real vector-write delay rolls all vectors back',()=>{
      const s=source();const c=claim(s);
      sql(`CREATE FUNCTION public.test_index_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source_id=${lit(s.id)}::uuid THEN PERFORM pg_sleep(0.2); END IF; RETURN NEW; END; $$;
        CREATE TRIGGER test_index_delay AFTER UPDATE ON public.knowledge_chunks FOR EACH ROW EXECUTE FUNCTION public.test_index_delay();
        UPDATE public.knowledge_source_index_state SET lease_until=clock_timestamp()+interval '0.25 seconds' WHERE source_id=${lit(s.id)};`,'postgres');
      try{assert.throws(()=>sql(completeQuery(s,c)),/completion_expired/);assert.ok(vectors(s).every((v:any[])=>v[0]===null));assert.equal(ready(s).ready,false);}
      finally{sql('DROP TRIGGER test_index_delay ON public.knowledge_chunks; DROP FUNCTION public.test_index_delay();','postgres');}
    });
    await t.test('retry backoff is bounded and three attempts cannot be reset by polling or identity toggling',()=>{
      const s=source();let c=claim(s);
      for(let attempt=1;attempt<=3;attempt++){
        assert.equal(c.attempt,attempt);assert.equal(transition(s,c,'fail','provider_timeout'),'t');
        const row=state(s);assert.equal(row.state,attempt===3?'failed':'retry_wait');
        if(attempt<3){const wait=Date.parse(row.next_attempt_at)-Date.now();assert.ok(wait>(attempt===1?28_000:118_000));
          assert.equal(claim(s).reason,'backoff');assert.equal(claim(s,google).reason,'backoff');
          sql(`UPDATE public.knowledge_source_index_state SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE source_id=${lit(s.id)};`,'postgres');
          assert.equal(ready(s).retry_eligible,true);c=claim(s,attempt===1?google:identity);
        }
      }
      assert.equal(claim(s).reason,'attempts_exhausted');assert.equal(claim(s,google).reason,'attempts_exhausted');assert.equal(state(s).attempts,3);
      sql(`UPDATE public.knowledge_sources SET content=content||' New approved revision.' WHERE id=${lit(s.id)};`);
      assert.equal(claim(s).attempt,1);
    });
    for(const error of ['credentials','configuration','invalid_vectors'])await t.test(`${error} blocks automatic retry`,()=>{
      const s=source();const c=claim(s);assert.equal(transition(s,c,'fail',error),'t');assert.equal(claim(s).reason,'blocked');
      assert.equal(claim(s,google).reason,'blocked');assert.equal(ready(s).retry_eligible,false);
    });
    await t.test('database process restart preserves unfinished lease and successful readiness',()=>{
      const a=source(88),b=source(99);const ca=claim(a),cb=claim(b);sql(completeQuery(b,cb));
      run('pg_ctl',['-D',join(root,'data'),'-l',join(root,'postgres.log'),'-m','fast','-o',`-h '' -k ${socket} -p 55448`,'-w','restart']);
      assert.equal(claim(a).reason,'busy');assert.equal(state(a).lease_token,ca.lease_token);assert.equal(ready(b).ready,true);
      expired(a);const recovered=claim(a);assert.notEqual(recovered.lease_token,ca.lease_token);assert.equal(json(completeQuery(a,recovered)).ready,true);
    });
    await t.test('readiness rejects later vector tampering, revoked source and mismatched provider',()=>{
      const s=source();const c=claim(s);sql(completeQuery(s,c));assert.equal(ready(s,google).ready,false);
      sql(`UPDATE public.knowledge_chunks SET embedding=${lit(JSON.stringify(vector.map((v,i)=>i===1?1:v)))}::extensions.vector WHERE source_id=${lit(s.id)} AND chunk_index=0;`);
      assert.equal(ready(s).ready,false);
      const other=source();const d=claim(other);sql(completeQuery(other,d));sql(`UPDATE public.knowledge_sources SET status='disabled' WHERE id=${lit(other.id)};`);
      assert.equal(ready(other).ready,false);
    });
    await t.test('complete tenant inventory includes unknown zero-chunk sources, revisions and new sources',()=>{
      const s=source(99);const c=claim(s);sql(completeQuery(s,c));
      const inventory=()=>json(`SELECT public.knowledge_index_readiness_v1(99,${lit(identity)});`);
      assert.equal(inventory().complete,true);const token=inventory().inventory_token;
      const empty=source(99,0);assert.equal(inventory().complete,false);assert.notEqual(inventory().inventory_token,token);
      assert.throws(()=>claim(empty),/invalid_inventory/);assert.equal(ready(empty).ready,false);
      sql(`UPDATE public.knowledge_sources SET status='disabled' WHERE id=${lit(empty.id)};`);assert.equal(inventory().complete,true);
      assert.equal(json(`SELECT public.knowledge_index_readiness_v1(123456,${lit(identity)});`).complete,false);
    });
    await t.test('old document extraction and Ready semantics work without a semantic generation',()=>{
      const id=randomUUID(),user=randomUUID();sql(`INSERT INTO public.business_memberships VALUES(88,${lit(user)},'active','owner');
        SELECT public.create_knowledge_document(88,${lit(id)},'synthetic.txt','text/plain','txt',20,${lit('a'.repeat(64))},${lit(user)});
        SELECT public.transition_knowledge_document(88,${lit(id)},'uploaded');`);
      const d=json(`SELECT public.transition_knowledge_document(88,${lit(id)},'claim');`);
      const chunks=[{chunk_index:0,content:'New uploaded text.',metadata:{source:'document',section:'test'}}];
      sql(`SELECT public.transition_knowledge_document(88,${lit(id)},'finish',${lit(d.lease_token)},'New uploaded text.',${lit(chunks)});`);
      const s={id,tenant:88,chunks};assert.equal(sql(`SELECT status FROM public.knowledge_sources WHERE id=${lit(id)};`),'ready');assert.equal(ready(s).ready,false);
      const c=claim(s);sql(completeQuery(s,c));assert.equal(ready(s).ready,true);
      assert.equal(sql(`SELECT attempts FROM public.knowledge_documents WHERE source_id=${lit(id)};`),'1');
    });
    await t.test('existing guarded backfill and semantic RPC remain functional for either provider',()=>{
      for(const who of [identity,google]){
        const s=source(88);const snap=json(`SELECT to_jsonb(x) FROM public.read_knowledge_embedding_backfill_source(88,${lit(s.id)}) x;`);
        const count=sql(`SELECT ${rpc('backfill_knowledge_chunk_embeddings_if_unchanged',[88,s.id,snap.snapshot_token,2,who.provider,who.model,768,1,payload(snap,who)])};`);assert.equal(count,'2');
        assert.equal(sql(`SELECT count(*) FROM public.search_knowledge_chunks_semantic(88,${lit(JSON.stringify(vector))}::extensions.vector,10,0.55,${lit(who.provider)},${lit(who.model)},1) WHERE source_id=${lit(s.id)};`),'2');
        assert.equal(sql(`SELECT count(*) FROM public.search_knowledge_chunks_semantic(77,${lit(JSON.stringify(vector))}::extensions.vector,10,0.55,${lit(who.provider)},${lit(who.model)},1) WHERE source_id=${lit(s.id)};`),'0');
        assert.equal(ready(s,who).ready,false,'Legacy unregistered generations are not silently adopted');
      }
    });
    t.diagnostic('PostgreSQL '+sql('SHOW server_version;','postgres')+'; pgvector '+sql("SELECT extversion FROM pg_extension WHERE extname='vector';",'postgres')+'; private Unix socket; TCP disabled; fake vectors only');
  } finally {
    if (started) run('pg_ctl', ['-D', join(root,'data'), '-m','immediate','-w','stop']);
    rmSync(root,{recursive:true,force:true});
  }
});
