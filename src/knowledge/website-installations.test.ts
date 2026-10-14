import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { createRequireBusinessPermission } from '../auth/require-business-access';
import { websiteInstallationRouter } from './website-installations';
const installationId='22222222-2222-4222-8222-222222222222';
test('installation management uses settings permission and tenant-scoped updates; public policy requires explicit opt-in',async()=>{
  let writes=0;
  const ownerClient:any={from:()=>{const filters:any={};const q={select:()=>q,eq:(k:string,v:any)=>{filters[k]=v;return q;},maybeSingle:async()=>({data:filters.business_id===1?{business_id:1,user_id:'synthetic',role:'owner',status:'active'}:null})};return q;}};
  const state={id:installationId,business_id:2,enabled:false};
  const client:any={from:()=>{const filters:any={};let payload:any;const q={update:(p:any)=>{payload=p;return q;},eq:(k:string,v:any)=>{filters[k]=v;return q;},select:()=>q,maybeSingle:async()=>{
    if(filters.id===state.id&&filters.business_id===state.business_id){writes++;Object.assign(state,payload);return{data:state};}return{data:null};}};return q;}};
  const app=express();app.use(express.json());app.use((req:any,_res,next)=>{req.auth={userId:'synthetic'};next();});
  app.use('/businesses/:businessId/installations',createRequireBusinessPermission('settings.manage',{client:ownerClient}),websiteInstallationRouter(client));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  const put=(business:number,policy:any)=>fetch('http://127.0.0.1:'+(server.address() as any).port+'/businesses/'+business+'/installations/'+installationId,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(policy)});
  const policy={enabled:true,publicKnowledge:true,origins:['https://public.example']};
  try{
    assert.equal((await put(2,policy)).status,403); // Owner of A cannot configure B.
    assert.equal((await put(1,policy)).status,404); // Foreign installation cannot be reassigned to A.
    assert.equal((await put(1,{...policy,publicKnowledge:false})).status,400);
    assert.equal(writes,0);assert.equal(state.enabled,false);
    state.business_id=1;assert.equal((await put(1,policy)).status,200);assert.equal(writes,1);
    assert.equal((await put(1,{...policy,enabled:false})).status,200);assert.equal(state.enabled,false);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
