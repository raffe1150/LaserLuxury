import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createCalendarContractDiagnosticRouter,inspectCalendarEnvelope} from '../../src/calendar/contract-diagnostic';
import {createRequireAuth} from '../../src/auth/require-auth';
import {createRequireBusinessPermission} from '../../src/auth/require-business-access';
const {p1Internals:i}=createRequire(import.meta.url)('./.server.cjs');
let reads=0,loads=0,role='owner';
const membership:any={from(){const filters:any={};const chain:any={select:()=>chain,eq:(k:string,v:any)=>{filters[k]=v;return chain},maybeSingle:async()=>({data:filters.business_id===7?{role}:null,error:null})};return chain}};
const router:any=createCalendarContractDiagnosticRouter({requireAuth:createRequireAuth({auth:{getUser:async()=>({data:{user:{id:'synthetic'}},error:null})}} as any),requireSettings:createRequireBusinessPermission('settings.manage',{client:membership}),loadConfig:async id=>{loads++;assert.equal(id,7);return{id,timezone:'Europe/Stockholm'}},resolve:()=>({adapter:'google',read:async()=>{reads++;return{kind:'calendar#events',items:[]}}})});
async function request(businessId:string,authorization?:string,date:any='2026-09-18'){
 const req:any={method:'GET',params:{businessId},query:{date},header:()=>authorization};const res:any={statusCode:200,headers:{},setHeader(k:string,v:string){this.headers[k]=v},status(n:number){this.statusCode=n;return this},json(v:any){this.body=v;return this}};
 for(const layer of router.stack[0].route.stack){let next=false;await layer.handle(req,res,()=>{next=true});if(!next)break;}assert.equal(res.headers['Cache-Control'],'no-store');return res;
}
assert.equal((await request('7')).statusCode,401);assert.equal(reads,0);assert.equal(loads,0);
assert.equal((await request('8','Bearer synthetic')).statusCode,403);assert.equal(loads,0);
assert.equal((await request('7','Bearer synthetic','2026-02-30')).statusCode,400);
role='viewer';assert.equal((await request('7','Bearer synthetic')).statusCode,403);role='owner';
assert.equal((await request('7','Bearer synthetic')).statusCode,200);assert.equal(reads,1);
for(const adapter of ['google','generic'] as const){
 for(const [data,success,count] of [[{kind:'calendar#events',items:[]},true,0],[{items:[{summary:'PRIVATE NAME PHONE',id:'SECRET EVENT'}]},true,1],[{kind:'calendar#events'},adapter==='google',null],[{items:{}},false,null],[{items:[],nextPageToken:'SECRET TOKEN'},true,0]] as const){
  const out=await inspectCalendarEnvelope(adapter,async()=>data);assert.equal(out.success,success);assert.equal((out as any).itemCount,count);assert.doesNotMatch(JSON.stringify(out),/PRIVATE|SECRET/);if('nextPageToken' in data)assert.equal((out as any).nextPageTokenPresent,true);
 }
}
assert.equal((await inspectCalendarEnvelope('generic',async()=>({events:[]}))).success,true);
assert.equal((await inspectCalendarEnvelope('google',async()=>{throw {response:{status:502,data:'SECRET'}}})).category,'unavailable');
assert.equal((await inspectCalendarEnvelope('google',()=>new Promise(()=>{}),5)).category,'timeout');
assert.equal((await inspectCalendarEnvelope('google',async()=>({items:[],SECRET_CUSTOMER_NAME:'x'})) as any).topLevelFields.includes('SECRET_CUSTOMER_NAME'),false);
const google=Object.create(i.GoogleCalendarAdapter.prototype);google.calendarId='PRIVATE CALENDAR';let lists=0;
google.calendar={events:new Proxy({list:async(p:any,o:any)=>{lists++;assert.equal(p.calendarId,'PRIVATE CALENDAR');assert.equal(p.timeMin,'2026-09-17T22:00:00.000Z');assert.equal(p.timeMax,'2026-09-18T21:59:59.000Z');assert.equal(o.retry,false);return{data:{kind:'calendar#events'}};}},{get(t:any,k){if(k!=='list')throw new Error('Mutation/write forbidden');return t[k]}})};
assert.deepEqual(await google.inspectContractEnvelope('2026-09-18','Europe/Stockholm'),{kind:'calendar#events'});assert.equal(lists,1);
const generic=new i.GenericCalendarAdapter('https://synthetic.invalid','PRIVATE KEY');globalThis.fetch=async(_url:any,init:any)=>{assert.equal(init.method,'GET');assert.equal(init.redirect,'error');return new Response(JSON.stringify({events:[]}));};assert.deepEqual(await generic.inspectContractEnvelope('2026-09-18','Europe/Stockholm'),{events:[]});
globalThis.fetch=async()=>new Response('SECRET ERROR',{status:500});await assert.rejects(()=>generic.inspectContractEnvelope('2026-09-18','Europe/Stockholm'),/unavailable/);
console.log('Diagnostic authorization, raw envelopes, privacy, timeout and read-only methods passed');
