import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

export const indexSqlLiteral = (v: any): string => v === null ? 'NULL' : typeof v === 'number' ? String(v) :
  "'" + (typeof v === 'object' ? JSON.stringify(v) : String(v)).replaceAll("'", "''") + "'" + (typeof v === 'object' ? '::jsonb' : '');
const ident = (s: string) => { assert.match(s, /^[a-z_][a-z_0-9]*$/u); return '"' + s + '"'; };
const bin = '/opt/homebrew/opt/postgresql@17/bin/';

/** Owns initdb, accepts no URL/credentials, TCP disabled, no existing database accepted. */
export class DisposableSourceIndexDatabase {
  private root = mkdtempSync('/tmp/odin-index-worker-');
  private socket = join(this.root, 'socket');
  private started = false;
  private env = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', PGPASSFILE: '/dev/null', PSQLRC: '/dev/null' };
  private args = () => ['-X','-qAt','-v','ON_ERROR_STOP=1','-h',this.socket,'-p','55449','-U','postgres','-d','postgres'];
  calls: { name: string; args: any }[] = [];
  private run(name: string, args: string[], input?: string) {
    const p = spawnSync(bin + name, args, { env: this.env, input, encoding: 'utf8', timeout: 25_000, maxBuffer: 12_000_000 });
    if (p.status !== 0) throw new Error(name + ': ' + p.stderr);
    return p.stdout.trim();
  }
  sql(q: string) { return this.run('psql', this.args(), q); }
  private async query(q: string, signal?: AbortSignal) {
    const r = await promisify(execFile)(bin + 'psql', [...this.args(), '-c', "SET statement_timeout='8s'; SET ROLE service_role; " + q],
      { env: this.env, timeout: 15_000, maxBuffer: 12_000_000, signal });
    return JSON.parse(r.stdout.trim() || 'null');
  }
  backendSql(q:string,signal?:AbortSignal) { return this.query(q,signal); }
  readonly client = {
    rpc: (name: string, args: any) => {
      assert.ok(['odin_ai_money_v1','odin_ai_money_trial_v1','knowledge_index_readiness_v1','search_knowledge_chunks','claim_knowledge_source_index_v1','transition_knowledge_source_index_v1','complete_knowledge_source_index_v1',
        'search_knowledge_index_snapshot_v1','knowledge_source_index_readiness_v1','read_knowledge_embedding_backfill_source','create_knowledge_document','transition_knowledge_document'].includes(name));
      this.calls.push({ name, args: structuredClone(args) });
      let signal: AbortSignal | undefined;
      const sql = 'SELECT ' + (['read_knowledge_embedding_backfill_source','search_knowledge_chunks'].includes(name) ? 'coalesce(jsonb_agg(to_jsonb(x)),\'[]\'::jsonb) FROM ' : 'to_jsonb(') +
        'public.' + ident(name) + '(' + Object.entries(args).map(([k,v]) => ident(k) + '=>' + indexSqlLiteral(v)).join(',') + ')' +
        (['read_knowledge_embedding_backfill_source','search_knowledge_chunks'].includes(name) ? ' x' : ')') + ';';
      const q: any = { abortSignal: (s: AbortSignal) => { signal = s; return q; },
        then: (resolve: any, reject: any) => this.query(sql, signal).then(data => ({ data, error: null }), error => ({ data: null, error: { message: String(error.message) } })).then(resolve, reject) };
      return q;
    },
    from: (table: string) => {
      assert.ok(['knowledge_sources','knowledge_source_index_state','knowledge_documents','knowledge_document_cleanup'].includes(table));
      let fields = '*', filters: string[] = [], ordering = '', limit = 100, single = false, signal: AbortSignal | undefined;
      const q: any = {
        select: (s: string) => { fields = s === '*' ? '*' : s.split(',').map(ident).join(','); return q; },
        eq: (key: string, value: any) => { filters.push(ident(key) + '=' + indexSqlLiteral(value)); return q; },
        gt: (key: string, value: any) => { filters.push(ident(key) + '>' + indexSqlLiteral(value)); return q; },
        order: (key: string) => { ordering = ' ORDER BY ' + ident(key); return q; },
        limit: (n: number) => { assert.ok(Number.isSafeInteger(n) && n <= 100); limit = n; return q; },
        maybeSingle: () => { single = true; return q; },
        abortSignal: (s: AbortSignal) => { signal = s; return q; },
        then: (resolve: any, reject: any) => this.query("SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM (SELECT " + fields + ' FROM public.' + ident(table) +
          (filters.length ? ' WHERE ' + filters.join(' AND ') : '') + ordering + ' LIMIT ' + limit + ') x;', signal)
          .then(data => ({ data: single ? data[0] ?? null : data, error: null }), error => ({ data: null, error: { message: String(error.message) } })).then(resolve, reject),
      }; return q;
    },
  };
  restart() { this.run('pg_ctl', ['-D',join(this.root,'data'),'-l',join(this.root,'postgres.log'),'-m','fast','-o',`-h '' -k ${this.socket} -p 55449`,'-w','restart']); }
  constructor(extraMigrations: string[] = []) {
    try {
      mkdirSync(this.socket, { mode: 0o700 });
      this.run('initdb', ['-D',join(this.root,'data'),'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8']);
      this.run('pg_ctl', ['-D',join(this.root,'data'),'-l',join(this.root,'postgres.log'),'-o',`-h '' -k ${this.socket} -p 55449`,'-w','start']); this.started = true;
      this.sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
        CREATE SCHEMA extensions; CREATE SCHEMA auth; CREATE SCHEMA storage;
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid';
        CREATE TABLE public.businesses(id bigint PRIMARY KEY);
        CREATE TABLE public.business_memberships(business_id bigint,user_id uuid,status text,role text);
        CREATE TABLE storage.objects(bucket_id text); INSERT INTO public.businesses VALUES(77),(88),(99);`);
      for (const name of ['20260908212500_create_tenant_safe_knowledge_sources.sql','20260908220200_harden_knowledge_sources_grants.sql',
        '20260926111502_create_tenant_safe_knowledge_chunks.sql','20260926111832_harden_knowledge_chunks_performance.sql',
        '20260926224355_add_semantic_knowledge_embeddings.sql','20260926225209_extend_replace_knowledge_chunks_for_embeddings.sql',
        '20260927000939_add_guarded_knowledge_embedding_backfill.sql','20261013082149_business_knowledge_documents.sql',
        '20261024145329_durable_knowledge_source_index_coordination.sql']) this.sql(readFileSync('supabase/migrations/' + name,'utf8'));
      for (const name of extraMigrations) this.sql(readFileSync('supabase/migrations/'+name,'utf8'));
      this.sql('GRANT USAGE ON SCHEMA public,extensions,auth TO service_role; GRANT ALL ON public.knowledge_sources,public.knowledge_chunks,public.business_memberships TO service_role;');
    } catch (error) { this.close(); throw error; }
  }
  close() {
    try { if (this.started) this.run('pg_ctl',['-D',join(this.root,'data'),'-m','immediate','-w','stop']); }
    finally { this.started = false; rmSync(this.root,{recursive:true,force:true}); }
  }
}
