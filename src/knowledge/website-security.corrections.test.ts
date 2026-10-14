import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import http from 'node:http';
import { createWebsiteKnowledgeRouter, type WebsiteInstallation } from './website-chat';
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const revision='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const secret='synthetic-signing-secret-never-used-outside-tests';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve};}
async function fixture(chat?:any, env:any={}) {
  let loads=0,chats=0,globalParsed=0;
  const state:WebsiteInstallation={id,businessId:1,enabled:true,publicKnowledge:true,revision,origins:['https://one.example']};
  const app=express();
  app.use('/api',createWebsiteKnowledgeRouter({environment:{WEBSITE_CHAT_ENABLED:'true',WEBSITE_CHAT_SESSION_SECRET:secret,...env},
    loadInstallation:async selected=>{loads++;return selected===id?{...state}:null;},loadBusiness:async businessId=>({id:businessId}),
    chat:async(req:any,res:any)=>{chats++;if(chat)await chat(req,res);else await req.websitePublish({text:'Synthetic public fact',businessId:req.websiteVisitor.businessId});}}));
  app.use(express.json({limit:'50mb'}));app.use((_req,_res,next)=>{globalParsed++;next();});app.post('/unrelated',(req,res)=>res.json({length:req.body.text.length}));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  const base='http://127.0.0.1:'+(server.address() as any).port;
  const post=(path:string,body:any,token?:string,headers:any={})=>fetch(base+'/api'+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://one.example','X-OdinLink-Installation':id,...(token?{'X-OdinLink-Visitor-Session':token}:{}),...headers},body:JSON.stringify(body)});
  const session=async()=>{const result=await post('/website-chat/session',{businessId:1,installationId:id});assert.equal(result.status,200);return result.json();};
  return{state,server,base,post,session,counts:()=>({loads,chats,globalParsed}),close:async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}};
}
test('only server-approved active public installations issue sessions; forged Origin is not installation authentication',async()=>{
  const f=await fixture();try{
    assert.equal((await f.post('/website-chat/session',{businessId:1,installationId:other},undefined,{'X-OdinLink-Installation':other})).status,403);
    assert.equal((await f.post('/website-chat/session',{businessId:2,installationId:id})).status,403);
    assert.equal((await f.post('/website-chat/session',{businessId:1,installationId:id},undefined,{Origin:'https://evil.example'})).status,403);
    f.state.enabled=false;assert.equal((await f.post('/website-chat/session',{businessId:1,installationId:id})).status,403);
    f.state.enabled=true;f.state.publicKnowledge=false;assert.equal((await f.post('/website-chat/session',{businessId:1,installationId:id})).status,403);
    f.state.publicKnowledge=true;
    // A non-browser caller can spoof an allowed Origin: this is intentionally public opt-in access.
    const session=await f.session();assert.equal((await f.post('/chat',{message:'Public policy?'},session.sessionToken)).status,200);
  }finally{await f.close();}
});
test('disabling and revision revocation reject old sessions, including re-enable and foreign installation claims',async()=>{
  const f=await fixture();try{
    const session=await f.session();
    assert.equal((await f.post('/chat',{businessId:2,message:'Policy?'},session.sessionToken)).status,403);
    assert.equal((await f.post('/chat',{installationId:other,message:'Policy?'},session.sessionToken)).status,403);
    f.state.enabled=false;assert.equal((await f.post('/chat',{message:'Policy?'},session.sessionToken)).status,403);
    f.state.enabled=true;f.state.revision='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    assert.equal((await f.post('/chat',{message:'Policy?'},session.sessionToken)).status,403);
    assert.equal((await f.post('/chat',{message:'Policy?'},(await f.session()).sessionToken)).status,200);
  }finally{await f.close();}
});
test('installation revocation while generation runs prevents publication',async()=>{
  const entered=deferred(),release=deferred();const f=await fixture(async(req:any)=>{entered.resolve();await release.promise;await req.websitePublish({text:'MUST_NOT_PUBLISH'});});
  try{const session=await f.session();const request=f.post('/chat',{message:'Policy?'},session.sessionToken);await entered.promise;
    f.state.revision='cccccccc-cccc-4ccc-8ccc-cccccccccccc';release.resolve();const result=await request;assert.equal(result.status,403);assert.doesNotMatch(await result.text(),/MUST_NOT_PUBLISH/u);
  }finally{release.resolve();await f.close();}
});
test('oversized and unauthenticated requests stop before body parsing, tenant loading or AI work; unrelated parser is unchanged',async()=>{
  const f=await fixture();try{
    assert.equal((await f.post('/chat',{message:'x'.repeat(9000)})).status,413);
    assert.equal((await f.post('/chat',{message:'Policy?'})).status,403);
    assert.deepEqual(f.counts(),{loads:0,chats:0,globalParsed:0});
    const result=await fetch(f.base+'/unrelated',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'x'.repeat(9000)})});
    assert.equal(result.status,200);assert.equal((await result.json()).length,9000);
  }finally{await f.close();}
});
test('chunked bodies have the same small bound before provider work',async()=>{
  const f=await fixture();try{
    const session=await f.session();
    const status=await new Promise<number>((resolve,reject)=>{const req=http.request(f.base+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://one.example','X-OdinLink-Visitor-Session':session.sessionToken,'Transfer-Encoding':'chunked'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});req.on('error',reject);req.write('{"message":"');req.write('x'.repeat(9000));req.end('"}');});
    assert.equal(status,413);assert.equal(f.counts().chats,0);assert.equal(f.counts().globalParsed,0);
  }finally{await f.close();}
});
test('spoofed forwarding headers cannot evade IP limits by default; invalid proxy configuration fails closed',async()=>{
  const f=await fixture();try{for(let i=0;i<30;i++)assert.equal((await f.post('/chat',{message:'Policy?'},undefined,{'X-Forwarded-For':'203.0.113.'+i})).status,403);
    assert.equal((await f.post('/chat',{message:'Policy?'},undefined,{'X-Forwarded-For':'198.51.100.1'})).status,429);
  }finally{await f.close();}
  const invalid=await fixture(undefined,{WEBSITE_CHAT_TRUSTED_PROXY_CIDRS:'definitely-not-a-cidr'});
  try{assert.equal((await invalid.post('/website-chat/session',{businessId:1,installationId:id})).status,503);assert.equal(invalid.counts().loads,0);}finally{await invalid.close();}
});
test('browser preflight uses a public installation selector and still checks authoritative opt-in',async()=>{
  const f=await fixture();try{const options=()=>fetch(f.base+'/api/chat?installationId='+id,{method:'OPTIONS',headers:{Origin:'https://one.example','Access-Control-Request-Headers':'x-odinlink-visitor-session'}});
    assert.equal((await options()).status,204);f.state.enabled=false;assert.equal((await options()).status,403);
  }finally{await f.close();}
});
test('trusted ingress uses the nearest untrusted hop, ignoring attacker-controlled earlier forwarding addresses',async()=>{
  const f=await fixture(undefined,{WEBSITE_CHAT_TRUSTED_PROXY_CIDRS:'loopback'});
  try{for(let i=0;i<30;i++)assert.equal((await f.post('/chat',{message:'Policy?'},undefined,{'X-Forwarded-For':'203.0.113.'+i+', 198.51.100.99'})).status,403);
    assert.equal((await f.post('/chat',{message:'Policy?'},undefined,{'X-Forwarded-For':'203.0.113.200, 198.51.100.99'})).status,429);
  }finally{await f.close();}
});
test('per-installation concurrency is bounded across separately minted visitors',async()=>{
  const release=deferred();let entered=0;const started=deferred();const f=await fixture(async(req:any)=>{if(++entered===4)started.resolve();await release.promise;await req.websitePublish({text:'Synthetic'});});
  try{const sessions=[];for(let i=0;i<5;i++)sessions.push(await f.session());
    const work=sessions.slice(0,4).map(s=>f.post('/chat',{message:'Policy?'},s.sessionToken));await started.promise;
    assert.equal((await f.post('/chat',{message:'Policy?'},sessions[4].sessionToken)).status,429);
    release.resolve();assert.ok((await Promise.all(work)).every(r=>r.status===200));
  }finally{release.resolve();await f.close();}
});
test('case/trailing-slash aliases retain the signature gate and cannot reach the global parser',async()=>{
  const f=await fixture();try{
    for(const path of ['/CHAT','/chat/'])assert.equal((await f.post(path,{message:'Policy?'})).status,403);
    assert.equal(f.counts().loads,0);assert.equal(f.counts().globalParsed,0);
  }finally{await f.close();}
});
test('session expiring during final evidence validation cannot publish',async()=>{
  const original=Date.now;let offset=0;
  const f=await fixture(async(req:any)=>{
    await req.websitePublish({text:'MUST_NOT_PUBLISH'},async()=>{offset=900001;return{text:'MUST_NOT_PUBLISH'};});
  });
  try{Date.now=()=>original()+offset;const session=await f.session();const result=await f.post('/chat',{message:'Policy?'},session.sessionToken);
    assert.equal(result.status,403);assert.doesNotMatch(await result.text(),/MUST_NOT_PUBLISH/u);
  }finally{Date.now=original;await f.close();}
});

for (const change of ['disable', 'revision'] as const) {
  test(`installation ${change} during asynchronous finalize suppresses publication`, async () => {
    const entered = deferred();
    const release = deferred();
    let published: boolean | undefined;
    const f = await fixture(async (req: any) => {
      published = await req.websitePublish({ text: 'ORIGINAL_MUST_NOT_PUBLISH' }, async () => {
        entered.resolve();
        await release.promise;
        return { text: 'FINAL_MUST_NOT_PUBLISH' };
      });
    });
    try {
      const session = await f.session();
      const request = f.post('/chat', { message: 'Policy?' }, session.sessionToken);
      await entered.promise;
      if (change === 'disable') f.state.enabled = false;
      else f.state.revision = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      release.resolve();
      const result = await request;
      assert.equal(result.status, 403);
      assert.deepEqual(await result.json(), { error: 'website_chat_forbidden' });
      assert.equal(published, false);
    } finally {
      release.resolve();
      await f.close();
    }
  });
}

test('active unchanged installation publishes the completed asynchronous finalizer result', async () => {
  const entered = deferred();
  const release = deferred();
  let published: boolean | undefined;
  const f = await fixture(async (req: any) => {
    published = await req.websitePublish({ text: 'Original synthetic text' }, async () => {
      entered.resolve();
      await release.promise;
      return { text: 'Final synthetic answer' };
    });
  });
  try {
    const session = await f.session();
    const request = f.post('/chat', { message: 'Policy?' }, session.sessionToken);
    await entered.promise;
    release.resolve();
    const result = await request;
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { text: 'Final synthetic answer' });
    assert.equal(published, true);
  } finally {
    release.resolve();
    await f.close();
  }
});
