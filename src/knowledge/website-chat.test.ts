import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { createHmac } from 'node:crypto';
import { createWebsiteKnowledgeRouter } from './website-chat';
const installationId='11111111-1111-4111-8111-111111111111';
const installation={id:installationId,businessId:1,enabled:true,publicKnowledge:true,revision:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',origins:['https://one.example']};
const loadInstallation=async(id:string)=>id===installationId?{...installation}:null;
const secret='synthetic-visitor-signing-secret-with-32-bytes';
const environment={WEBSITE_CHAT_ENABLED:'true',WEBSITE_CHAT_SESSION_SECRET:secret,
  WEBSITE_CHAT_ALLOWED_ORIGINS:JSON.stringify({1:['https://one.example'],2:['https://two.example']})};
test('public visitor HTTP sessions verify signature, origin, business and visitor identity before loading chat',async()=>{
  let chats=0;const app=express();
  app.use('/api',createWebsiteKnowledgeRouter({environment,loadInstallation,loadBusiness:async id=>({id}),chat:async(req:any,res)=>{chats++;await req.websitePublish({businessId:req.websiteVisitor.businessId,visitor:req.websiteVisitor.visitorId});}}));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${(server.address() as any).port}/api`;
  const post=(path:string,body:any,origin='https://one.example',token?:string)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-OdinLink-Installation':installationId,Origin:origin,...(token?{'X-OdinLink-Visitor-Session':token}:{})},body:JSON.stringify({...body,installationId})});
  try {
    assert.equal((await post('/chat',{message:'Parking?'})).status,403);
    assert.equal((await post('/website-chat/session',{businessId:2})).status,403);
    const bootstrap=await post('/website-chat/session',{businessId:1});const session=await bootstrap.json();assert.equal(bootstrap.status,200);
    assert.equal(bootstrap.headers.get('access-control-allow-origin'),'https://one.example');
    const valid=await post('/chat',{message:'Parking?',chatId:session.chatId},'https://one.example',session.sessionToken);assert.equal(valid.status,200);assert.equal((await valid.json()).businessId,1);
    for(const [body,origin,token] of [
      [{businessId:2},'https://one.example',session.sessionToken],
      [{chatId:'another-visitor'},'https://one.example',session.sessionToken],
      [{},'https://two.example',session.sessionToken],
      [{},'https://one.example',session.sessionToken+'bad'],
    ] as any[]) assert.equal((await post('/chat',body,origin,token)).status,403);
    const claims=JSON.parse(Buffer.from(session.sessionToken.split('.')[0],'base64url').toString());claims.expires=Date.now()-1;
    const body=Buffer.from(JSON.stringify(claims)).toString('base64url');const expired=body+'.'+createHmac('sha256',secret).update(body).digest('base64url');
    assert.equal((await post('/chat',{},'https://one.example',expired)).status,403);assert.equal(chats,1);
    const next=await (await post('/website-chat/session',{businessId:1})).json();assert.notEqual(next.chatId,session.chatId);
  } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
test('unconfigured public chat fails closed and never loads tenant/provider data',async()=>{
  const app=express();app.use('/api',createWebsiteKnowledgeRouter({environment:{},loadInstallation,loadBusiness:async()=>{throw Error('must not load');},chat:()=>{throw Error('must not chat');}}));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  try{assert.equal((await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/chat`,{method:'POST'})).status,503);}
  finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
test('visitor concurrency remains held after disconnect until underlying work completes',async()=>{
  let entered:()=>void;let release:()=>void;const started=new Promise<void>(r=>entered=r);const done=new Promise<void>(r=>release=r);
  const app=express();app.use('/api',createWebsiteKnowledgeRouter({environment,loadInstallation,loadBusiness:async id=>({id}),chat:async(_req,res)=>{entered();await done;if(!res.destroyed)res.json({text:'done'});}}));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${(server.address() as any).port}/api`;
  const headers={'Content-Type':'application/json','X-OdinLink-Installation':installationId,Origin:'https://one.example'};
  try {
    const session=await (await fetch(base+'/website-chat/session',{method:'POST',headers,body:JSON.stringify({businessId:1,installationId})})).json();
    const controller=new AbortController();const request={method:'POST',headers:{...headers,'X-OdinLink-Visitor-Session':session.sessionToken},body:'{"message":"Parking?"}'};
    const first=fetch(base+'/chat',{...request,signal:controller.signal}).catch(()=>undefined);await started;controller.abort();await first;
    assert.equal((await fetch(base+'/chat',request)).status,429);release();
  } finally {release();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
