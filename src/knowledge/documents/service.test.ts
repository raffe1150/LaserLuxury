import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { DocumentService } from './service';
const id='11111111-1111-4111-8111-111111111111';
const bytes=Buffer.from('Synthetic cancellation policy');
function fixture(overrides: { storageFailure?: boolean; publicBucket?: boolean; badHash?: boolean; wrongScope?: boolean; finishFailure?: boolean; removeFailure?: boolean } = {}) {
  const calls: any[]=[];
  const row={source_id:id,business_id:overrides.wrongScope?2:1,object_key:`1/${id}/original.txt`,filename:'policy.txt',format:'txt',mime:'text/plain',bytes:bytes.length,
    sha256:overrides.badHash?'0'.repeat(64):createHash('sha256').update(bytes).digest('hex'),lease_token:'22222222-2222-4222-8222-222222222222'};
  const client={ rpc:async(name:string,args:any)=>{
    calls.push([name,args]);
    if (name==='create_knowledge_document') return {error:null};
    if (args.p_action==='claim') return {data:row,error:null};
    if (args.p_action==='finish' && overrides.finishFailure) return {error:{message:'write failed'}};
    return {data:{ok:true},error:null};
  }, storage:{getBucket:async()=>({data:{public:!!overrides.publicBucket,file_size_limit:5*1024*1024},error:null}),from:(bucket:string)=>{
    assert.equal(bucket,'business-knowledge');return {
      upload:async(key:string,blob:Buffer,options:any)=>{calls.push(['upload',key,options]);return {error:overrides.storageFailure?{message:'storage failed'}:null};},
      download:async(key:string)=>{calls.push(['download',key]);return {data:new Blob([bytes]),error:null};},
      remove:async(keys:string[])=>{calls.push(['remove',keys]);return {error:overrides.removeFailure?{message:'unavailable'}:null};},
    };
  }},from:(table:string)=>{
    const query:any={select:()=>query,is:()=>query,in:()=>query,eq:()=>query,lt:()=>query,order:()=>query,
      limit:async()=>({data:table==='knowledge_document_cleanup'?[{object_key:row.object_key}]:[],error:null}),
      delete:()=>{calls.push(['cleanup-ack',table]);return query;},then:(resolve:Function)=>resolve({data:[],error:null})};
    return query;
  }};
  return {calls,client,row};
}
test('uploads persist metadata before private storage with generated keys and no raw filenames',async()=>{
  const f=fixture();const service=new DocumentService(f.client as any);
  await service.upload(1,'synthetic-user',bytes,'../../Policy.txt','text/plain',true);
  assert.equal(f.calls[0][0],'create_knowledge_document');assert.equal(f.calls[0][1].p_business_id,1);
  assert.match(f.calls[1][1],/^1\/[0-9a-f-]{36}\/original\.txt$/u);assert.equal(f.calls[1][2].upsert,false);
  assert.equal(f.calls[2][1].p_action,'uploaded');
});
test('storage failure and public bucket fail closed; interrupted upload leaves durable cleanup work',async()=>{
  const f=fixture({storageFailure:true});
  await assert.rejects(new DocumentService(f.client as any).upload(1,'user',bytes,'policy.txt','text/plain',true),/document_storage/u);
  assert.equal(f.calls.at(-1)[1].p_action,'upload_failed');
  const p=fixture({publicBucket:true});
  await assert.rejects(new DocumentService(p.client as any).upload(1,'user',bytes,'policy.txt','text/plain',true),/document_unavailable/u);
  assert.equal(p.calls.length,0);
});
test('publish waits for extraction; chunk failure marks failed instead of ready; provenance is persisted',async()=>{
  const f=fixture();const service=new DocumentService(f.client as any,async()=>[{text:'Cancellation policy',page:2}]);
  await service.process(1,id);
  const finish=f.calls.find(c=>c[1]?.p_action==='finish')[1];assert.equal(finish.p_token,f.row.lease_token);
  assert.equal(finish.p_chunks[0].metadata.page,2);assert.equal(finish.p_metadata.extractorVersion,1);
  const g=fixture({finishFailure:true});await new DocumentService(g.client as any,async()=>[{text:'Policy'}]).process(1,id);
  assert.equal(g.calls.at(-1)[1].p_action,'fail');assert.equal(g.calls.at(-1)[1].p_error,'document_unavailable');
});
test('ownership and hash mismatches prevent extraction; sensitive content triggers physical quarantine',async()=>{
  for (const options of [{wrongScope:true},{badHash:true}]) {
    const f=fixture(options);let extracted=false;
    await new DocumentService(f.client as any,async()=>{extracted=true;return [{text:'Should never parse'}];}).process(1,id);
    assert.equal(extracted,false);assert.equal(f.calls.at(-1)[1].p_action,'fail');
    if (options.wrongScope) assert.equal(f.calls.some(c=>c[0]==='download'),false);
  }
  const f=fixture();const {DocumentError}=await import('./formats');
  await new DocumentService(f.client as any,async()=>{throw new DocumentError('document_sensitive');}).process(1,id);
  assert.equal(f.calls.at(-1)[1].p_action,'fail');
  assert.equal(f.calls.at(-1)[1].p_token,f.row.lease_token);
  assert.equal(f.calls.filter(c=>c[1]?.p_action==='fail').length,1);
  assert.equal(f.calls.some(c=>c[1]?.p_action==='quarantine'),false);
});
test('cleanup failure keeps its tombstone; cleanup succeeds only after storage removal',async()=>{
  const f=fixture({removeFailure:true});await new DocumentService(f.client as any).recover();assert.equal(f.calls.some(c=>c[0]==='cleanup-ack'),false);
  const g=fixture();await new DocumentService(g.client as any).recover();assert.deepEqual(g.calls.map(c=>c[0]),['remove','cleanup-ack']);
});
test('stale recovery snapshot delegates abandonment to SQL after concurrent upload completion',async()=>{
  const f=fixture();let completed=false;
  const snapshot={...f.row,uploaded:false,error_code:null,created_at:new Date(Date.now()-121_000).toISOString()};
  f.client.from=(table:string)=>{
    if(table!=='knowledge_documents'){
      const query:any={select:()=>query,lt:()=>query,limit:async()=>({data:[],error:null})};return query;
    }
    const query:any={select:()=>query,is:()=>query,in:()=>query,order:()=>query,
      limit:async()=>{completed=true;return {data:[snapshot],error:null};}};
    return query;
  };
  f.client.rpc=async(name:string,args:any)=>{
    f.calls.push([name,args]);assert.equal(completed,true);
    assert.equal(args.p_action,'abandon_upload');return {data:null,error:null};
  };
  await new DocumentService(f.client as any).recover();
  assert.equal(f.calls.some(c=>c[1]?.p_action==='upload_failed'),false);
  assert.equal(f.calls.some(c=>c[0]==='remove'),false);
});
test('rejected sensitive failure never follows up with an unfenced quarantine',async()=>{
  const f=fixture();const originalRpc=f.client.rpc;
  f.client.rpc=async(name:string,args:any)=>args.p_action==='fail'?(f.calls.push([name,args]),{data:null,error:null}):originalRpc(name,args);
  const {DocumentError}=await import('./formats');
  await new DocumentService(f.client as any,async()=>{throw new DocumentError('document_sensitive');}).process(1,id);
  assert.equal(f.calls.at(-1)[1].p_action,'fail');
  assert.equal(f.calls.at(-1)[1].p_token,f.row.lease_token);
  assert.equal(f.calls.some(c=>c[1]?.p_action==='quarantine'),false);
});
test('local extraction concurrency stays held until extraction completion is confirmed',async()=>{
  const f=fixture();let release:()=>void;let entered:()=>void;
  const started=new Promise<void>(r=>entered=r);
  const done=new Promise<void>(r=>release=r);
  const service=new DocumentService(f.client as any,async()=>{entered();await done;return [{text:'Synthetic policy'}];});
  const processing=service.process(1,id);await started;
  await service.process(1,id);
  assert.equal(f.calls.filter(c=>c[1]?.p_action==='claim').length,1);
  assert.equal(f.calls.some(c=>c[1]?.p_action==='finish'),false);
  release();await processing;
  await service.process(1,id);
  assert.equal(f.calls.filter(c=>c[1]?.p_action==='claim').length,2);
});
