import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync,mkdirSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const bin='/opt/homebrew/opt/postgresql@17/bin/';
const literal=(v:any):string=>v===null?'NULL':typeof v==='number'?String(v):"'"+(typeof v==='object'?JSON.stringify(v):String(v)).replaceAll("'","''")+"'"+(typeof v==='object'?'::jsonb':'');
const identifier=(v:string)=>{assert.match(v,/^[a-z_][a-z_0-9]*$/u);return '"'+v+'"';};
/** This fixture cannot accept a database URL. It owns an initdb cluster with
 * TCP disabled and scrubs all PG* connection variables. No project credentials.
 */
export class DisposableNativeKnowledgeDatabase {
  private root=mkdtempSync(join(tmpdir(),'odin-native-'));private socket=join(this.root,'socket');private started=false;
  private env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('PG')));
  calls:string[]=[];
  private run(name:string,args:string[],input?:string){const p=spawnSync(bin+name,args,{env:this.env,input,encoding:'utf8',timeout:25000});
    if(p.status!==0)throw new Error(name+': '+p.stderr);return p.stdout.trim();}
  sql(query:string){return this.run('psql',['-X','-qAt','-v','ON_ERROR_STOP=1','-h',this.socket,'-p','55439','-U','postgres','-d','postgres'],query);}
  constructor(){
    try{
      mkdirSync(this.socket,{mode:0o700});this.run('initdb',['-D',join(this.root,'data'),'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8']);
      this.run('pg_ctl',['-D',join(this.root,'data'),'-l',join(this.root,'postgres.log'),'-o',"-h '' -k "+this.socket+' -p 55439','-w','start']);this.started=true;
      this.sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE TABLE public.businesses(id bigint PRIMARY KEY); INSERT INTO public.businesses VALUES(77),(88);');
      const pins=[['docs/designs/knowledge-migration-wrappers/foundation.sql.payload','89472b7d676dfc005ec9345c3810225422f38fa688be47df6d3089e224e29b49'],
        ['docs/designs/knowledge-migration-wrappers/extension.sql.payload','269dfd172d21840b9f610da4697479a8176052d9faafff45e02d5210b365f038']];
      for(const[path,hash]of pins){const bytes=readFileSync(path);assert.equal(createHash('sha256').update(bytes).digest('hex'),hash);this.sql(bytes.toString('utf8'));}
      this.sql("SET odin.approved_ordered_knowledge_v2='yes';\n"+readFileSync('docs/designs/ordered-native-admission/20261019120000_ordered_knowledge_admission_v2.sql.draft','utf8'));
      this.sql(readFileSync('docs/designs/async-intake-phase1/intake-and-poller.sql.draft','utf8'));
      this.sql(readFileSync('docs/designs/async-recovery-phase2/recovery-and-settlement.sql.draft','utf8'));
    }catch(error){this.close();throw error;}
  }
  async holdConversation(id:string):Promise<()=>Promise<void>> {
    assert.match(id,/^[0-9a-f-]{36}$/u);
    const child=spawn(bin+'psql',['-X','-qAt','-v','ON_ERROR_STOP=1','-h',this.socket,'-p','55439','-U','postgres','-d','postgres'],{env:this.env,stdio:'pipe'});
    const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
    try {
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('isolated lock not acquired')),3000);
        child.once('error',error=>{clearTimeout(timer);reject(error);});
        child.stdout.on('data',data=>{if(String(data).includes('LOCK_READY')){clearTimeout(timer);resolve();}});
        child.stdin.write("BEGIN; SELECT id FROM public.odin_conversations WHERE id='"+id+"' FOR UPDATE; SELECT 'LOCK_READY';\n");
      });
    } catch(error) {child.kill();await closed;throw error;}
    return async()=>{child.stdin.end('ROLLBACK;\n');await closed;};
  }
  restart(){this.run('pg_ctl',['-D',join(this.root,'data'),'-l',join(this.root,'postgres.log'),'-m','fast','-o',"-h '' -k "+this.socket+' -p 55439','-w','restart']);}
  close(){if(this.started){this.run('pg_ctl',['-D',join(this.root,'data'),'-m','immediate','-w','stop']);this.started=false;}rmSync(this.root,{recursive:true,force:true});}
  readonly db={
    rpc:async(name:string,args:Record<string,unknown>)=>{
      assert.ok(['odin_accept_knowledge_turn_v2','odin_transition_knowledge_v1','odin_claim_knowledge_progress_v1','odin_native_intake_v1','odin_recover_native_intakes_v1','odin_telegram_poller_v1','odin_transition_knowledge_v2','odin_discover_knowledge_v2'].includes(name),'No v1 admission or Booking RPC permitted');this.calls.push(name);
      try{return {data:JSON.parse(this.sql('SET ROLE service_role; SELECT public.'+identifier(name)+'('+Object.entries(args).map(([k,v])=>identifier(k)+'=>'+literal(v)).join(',')+');')||'null'),error:null};}
      catch(error){return {data:null,error};}
    },
    from:(table:string)=>{
      assert.ok(['odin_conversations','odin_inbox','odin_tasks','odin_outbox'].includes(table));let fields='*',where:string[]=[],order='',limit=1000,single=false,insert:any=null;
      const q:any={select:(v:string)=>{fields=v==='*'?'*':v.split(',').map(identifier).join(',');return q;},
        eq:(k:string,v:any)=>{where.push(identifier(k)+'='+literal(v));return q;},
        in:(k:string,v:any[])=>{where.push(identifier(k)+' IN ('+v.map(literal).join(',')+')');return q;},
        not:(k:string,op:string,v:any)=>{assert.equal(op,'is');assert.equal(v,null);where.push(identifier(k)+' IS NOT NULL');return q;},
        order:(k:string,o:any)=>{order=' ORDER BY '+identifier(k)+(o.ascending?' ASC':' DESC');return q;},
        limit:(n:number)=>{assert.ok(Number.isSafeInteger(n)&&n>0&&n<=1000);limit=n;return q;},
        maybeSingle:()=>{single=true;return q;},
        upsert:(data:any,opts:any)=>{assert.equal(table,'odin_conversations');assert.equal(opts.onConflict,'business_id,conversation_key');assert.equal(opts.ignoreDuplicates,true);insert=data;return q;},
        then:(resolve:any,reject:any)=>Promise.resolve().then(()=>{
          try{
            if(insert){this.sql('SET ROLE service_role; INSERT INTO public.'+identifier(table)+'('+Object.keys(insert).map(identifier).join(',')+') VALUES('+Object.values(insert).map(literal).join(',')+') ON CONFLICT(business_id,conversation_key) DO NOTHING;');return {data:null,error:null};}
            const rows=JSON.parse(this.sql("SET ROLE service_role; SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) FROM (SELECT "+fields+' FROM public.'+identifier(table)+(where.length?' WHERE '+where.join(' AND '):'')+order+' LIMIT '+limit+') t;'));
            return {data:single?rows[0]??null:rows,error:null};
          }catch(error){return {data:null,error};}
        }).then(resolve,reject)};return q;
    }};
}
