import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeProviderEligible } from './native-knowledge-transport';
import { preflightRejected, providerRejections, entryRejections } from './knowledge-preflight-diagnostic';
import type { NativeKnowledgeBindings } from './native-knowledge-binding';
import type { KnowledgeTask } from './knowledge-lifecycle';
const turnId='42a2c40b-3d5b-4abf-9ccb-151d031a937f';
function fixture(channel='whatsapp') {
  const binding:any={channel,account:'123',recipient:'456'};
  const connection:any={id:'connection',providerAccountId:'123',providerConnectionId:channel==='telegram'?null:'789',
    credential:{accessToken:'DO_NOT_LOG_TOKEN'},grantedScopes:['whatsapp_business_messaging','pages_messaging','instagram_business_manage_messages']};
  const data:any={app_id:'999',is_valid:true,scopes:['whatsapp_business_messaging'],expires_at:0,data_access_expires_at:0};
  const responses:any={debug_token:{data},phone_numbers:{data:[{id:'123'}]},phone:{id:'123',health_status:{can_send_message:'AVAILABLE'}},
    me:channel==='telegram'?{ok:true,result:{id:123,is_bot:true}}:{id:'123',user_id:'123'},
    getChat:{ok:true,result:{id:456,type:'private'}},getChatMember:{ok:true,result:{user:{id:123},status:'member'}},
    conversations:{data:[{participants:{data:[{id:'123'},{id:'456'}]},can_reply:true}]}};
  let time:number|null=Date.now();let resolved:any={binding,connection};let calls=0;let expected:any;
  const bindings={resolve:async()=>resolved,eventTime:async()=>time} as unknown as NativeKnowledgeBindings;
  const task={turnId,scope:{channel},input:{question:'DO_NOT_LOG_CUSTOMER_TEXT'}} as unknown as KnowledgeTask;
  const fetcher:typeof fetch=async url=>{calls++;const path=new URL(String(url)).pathname;const key=path.endsWith('/getMe')?'me':Object.keys(responses).find(k=>path.endsWith('/'+k))||'phone';return new Response(JSON.stringify(responses[key]));};
  return {binding,connection,data,responses,bindings,task,fetcher,clear:()=>{resolved=null;},time:(n:number|null)=>{time=n;},expected:(e:any)=>{expected=e;},calls:()=>calls,
    run:(observer?:(r:any)=>unknown)=>nativeProviderEligible(bindings,task,fetcher,new AbortController().signal,expected,observer)};
}
const mutations:Record<string,(f:ReturnType<typeof fixture>)=>void>={
  BINDING_OR_CONNECTION:f=>f.clear(),CONNECTION_CHANGED:f=>f.expected({...f.connection,id:'changed'}),EVENT_TIME:f=>f.time(null),
  TELEGRAM_CONNECTION_MODE:f=>{f.connection.providerConnectionId='business';},TELEGRAM_BOT_IDENTITY:f=>{f.responses.me={};},
  TELEGRAM_PRIVATE_CHAT:f=>{f.responses.getChat.result.type='group';},TELEGRAM_MEMBERSHIP:f=>{f.responses.getChatMember.result.status='left';},
  RESPONSE_WINDOW:f=>f.time(Date.now()-86400100),WHATSAPP_CONNECTION_OR_SCOPE:f=>{f.connection.grantedScopes=[];},
  WHATSAPP_APP_CONFIGURATION:()=>{process.env.META_APP_ID='';},WHATSAPP_TOKEN_APP:f=>{f.data.app_id='different';},
  WHATSAPP_TOKEN_VALIDITY:f=>{f.data.is_valid=false;},WHATSAPP_TOKEN_SCOPE:f=>{f.data.scopes=[];},WHATSAPP_TOKEN_EXPIRY:f=>{f.data.expires_at=1;},
  WHATSAPP_GRANULAR_SCOPE:f=>{f.data.granular_scopes=[{scope:'whatsapp_business_messaging',target_ids:[]}];},
  WHATSAPP_PHONE_MEMBERSHIP:f=>{f.responses.phone_numbers.data=[];},WHATSAPP_PHONE_HEALTH_OR_WINDOW:f=>{f.responses.phone.health_status={};},
  META_SAVED_SCOPE:f=>{f.connection.grantedScopes=[];},META_IDENTITY:f=>{f.responses.me={};},META_CONVERSATION_OR_WINDOW:f=>{f.responses.conversations.data=[];},
};
for(const reason of providerRejections)test(`provider rejection ${reason}: false, single bounded reason, observer cannot affect requests`,async t=>{
  const old=process.env.META_APP_ID;process.env.META_APP_ID='999';t.after(()=>{if(old===undefined)delete process.env.META_APP_ID;else process.env.META_APP_ID=old;});
  const channel=reason.startsWith('TELEGRAM')?'telegram':reason.startsWith('META_')?'messenger':'whatsapp';
  const f=fixture(channel);mutations[reason](f);const events:string[]=[];
  assert.equal(await f.run(r=>events.push(r)),false);assert.deepEqual(events,[reason]);const calls=f.calls();
  assert.equal(await f.run(()=>{throw Error('optional observer');}),false);assert.equal(f.calls(),calls*2);
  assert.equal(await f.run(()=>Promise.reject(Error('optional async observer'))),false);
});
for(const channel of ['whatsapp','telegram','instagram','messenger'])test(`${channel}: success has no rejection and identical provider request count`,async t=>{
  const old=process.env.META_APP_ID;process.env.META_APP_ID='999';t.after(()=>{if(old===undefined)delete process.env.META_APP_ID;else process.env.META_APP_ID=old;});
  const f=fixture(channel);assert.equal(await f.run(()=>assert.fail('No rejection')),true);assert.equal(f.calls(),channel==='instagram'||channel==='messenger'?2:3);
});
test('provider exceptions preserve original identity rather than becoming false or telemetry',async()=>{
  const f=fixture();const error=Error('DO_NOT_LOG_PROVIDER_ERROR');
  const fetcher:typeof fetch=async()=>{throw error;};
  await assert.rejects(nativeProviderEligible(f.bindings,f.task,fetcher,new AbortController().signal,undefined,()=>{throw Error('telemetry');}),e=>e===error);
});
test('event serialization and sync/async observers are optional; schema excludes sensitive data and bounds revision',async t=>{
  const old=process.env.RENDER_GIT_COMMIT;process.env.RENDER_GIT_COMMIT='DO_NOT_LOG_SECRET';t.after(()=>{if(old===undefined)delete process.env.RENDER_GIT_COMMIT;else process.env.RENDER_GIT_COMMIT=old;});
  const events:any[]=[];for(const reason of entryRejections)preflightRejected(turnId,'whatsapp','execution_entry',reason,e=>events.push(e));
  assert.equal(events.length,4);assert.ok(events.every(e=>e.revision==='unknown'&&e.instance===events[0].instance&&e.turnId===turnId));
  assert.deepEqual(Object.keys(events[0]).sort(),['stage','gate','reason','turnId','channel','instance','revision'].sort());
  preflightRejected(turnId,'whatsapp','execution_entry','CANCELLED',()=>{throw Error('observer');});
  preflightRejected(turnId,'whatsapp','execution_entry','CANCELLED',()=>Promise.reject(Error('observer')));
  const stringify=JSON.stringify;try{JSON.stringify=()=>{throw Error('serialization');};preflightRejected(turnId,'whatsapp','execution_entry','CANCELLED');}finally{JSON.stringify=stringify;}
  preflightRejected('DO_NOT_LOG_TEXT','whatsapp','execution_entry','CANCELLED',()=>assert.fail('invalid identity'));
});
test('concurrent turns retain distinct correlations, same opaque process identity and sanitized revision',async t=>{
  const old=process.env.RENDER_GIT_COMMIT;process.env.RENDER_GIT_COMMIT='99b57d3';t.after(()=>{if(old===undefined)delete process.env.RENDER_GIT_COMMIT;else process.env.RENDER_GIT_COMMIT=old;});
  const other='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';const events:any[]=[];
  await Promise.all([turnId,other].map(async id=>{await Promise.resolve();preflightRejected(id,'whatsapp','provider','EVENT_TIME',e=>events.push(e));}));
  assert.deepEqual(new Set(events.map(e=>e.turnId)),new Set([turnId,other]));assert.equal(events[0].instance,events[1].instance);assert.ok(events.every(e=>e.revision==='99b57d3'));
});
