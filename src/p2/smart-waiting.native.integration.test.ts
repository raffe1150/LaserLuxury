import {readFileSync} from 'node:fs';
import {approvedWaitingText} from './smart-waiting-presentation';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_BOOKING_STATE_VERSION } from '../ai/booking-operation-state';
import { createHash } from 'node:crypto';
import { DisposableNativeKnowledgeDatabase } from '../../tests/helpers/disposable-native-knowledge-db';
import { NativeKnowledgeRuntime, nativeAsyncControls, type NativeAsyncControls } from './native-knowledge-runtime';
import { knowledgeSourceRevision, type KnowledgeSource } from '../../knowledge';
import type { KnowledgeScope } from './knowledge-lifecycle';
import type { ResolvedChannelConnection } from '../channels/connections/contracts';
import { naturalLocationCases } from '../../tests/fixtures/knowledge-natural-location';
process.env.GEMINI_API_KEY='synthetic-only';
const {executeDurableKnowledgeTask,priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
const channels=['whatsapp','telegram','instagram','messenger'] as const;
type Channel=typeof channels[number];
const accounts={whatsapp:'10001',telegram:'123456',instagram:'30001',messenger:'40001'};
const config={id:77,businessId:77,businessName:'Synthetic studio',language:'en',timezone:'Europe/Stockholm',
  services:[{id:'video',name:'Video Consultation',durationMinutes:60}],defaultBookingService:'Video Consultation',calendarProvider:'custom',
  channelConnectionId:'synthetic-connection',telegramToken:'123456:synthetic-offline',telegramBusinessResolved:true,whatsappPhoneNumberId:accounts.whatsapp,whatsappAccessToken:'synthetic-only',
  instagramAccountId:accounts.instagram,instagramAccessToken:'synthetic-only',messengerPageId:accounts.messenger,messengerPageAccessToken:'synthetic-only',
  toneConfig:{tonePreset:'warm'},workingHours:Object.fromEntries(['monday','tuesday','wednesday','thursday','friday'].map(d=>[d,[{start:'09:00',end:'17:00'}]]))};
const secret='synthetic-p2-native-secret-at-least-32-bytes';

test('Smart Waiting through four actual native entries, PostgreSQL safety and independent verified publication',async t=>{
  const pg=new DisposableNativeKnowledgeDatabase();t.after(()=>pg.close());const oldFetch=globalThis.fetch;const oldFlags=[process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE,process.env.ODINLINK_GROUNDED_NATURAL_RESPONSES,process.env.META_APP_ID,process.env.META_WHATSAPP_APP_ID];
  t.after(()=>{globalThis.fetch=oldFetch;['ODINLINK_EVIDENCE_FIRST_KNOWLEDGE','ODINLINK_GROUNDED_NATURAL_RESPONSES','META_APP_ID','META_WHATSAPP_APP_ID'].forEach((k,i)=>{if(oldFlags[i]===undefined)delete process.env[k];else process.env[k]=oldFlags[i];});b.reset();});
  process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE='true';process.env.ODINLINK_GROUNDED_NATURAL_RESPONSES='false';process.env.META_APP_ID='789';process.env.META_WHATSAPP_APP_ID='789';
  for(const level of ['log','warn','error','info'] as const)t.mock.method(console,level,()=>{});
  const draft=readFileSync('docs/designs/knowledge-progress-safety-v1/progress-safety-v1.sql.draft','utf8');
  assert.equal(createHash('sha256').update(draft).digest('hex'),'d93ee49ec845dcef99abc8e0f5e663b04b32a4338dc83809f85720e394aa8b04');
  pg.sql("SET odin.approved_knowledge_progress_safety_v1='yes';\n"+draft);
  const alarms=new Set<()=>void>();let waitingEnabled=true,facetAttribute='parking';
  let verificationHold:Promise<void>|null=null,verificationEntered:(()=>void)|null=null;
  let progressHttpHold:Promise<void>|null=null;
  let providerAck=0;
  let language='en',fact='Parking is nearby.',serial=10000;let controls:NativeAsyncControls={admission:true,processing:true,delivery:true,executionMs:40000};
  let source:KnowledgeSource;let stages:string[]=[];let posts:{channel:string;recipient:string;text:string}[]=[];let diagnostic:any[]=[];
  let extractionHold:Promise<void>|null=null,extractionEntered:(()=>void)|null=null;
  let extra:Parameters<typeof b.configure>[0]={};
  let revoked=false,ambiguous=false,verifyRelation='ENTAILED',calendarReads=0,changeAfterExecution=false,telemetryThrows=false;
  const connections=new Map<string,ResolvedChannelConnection>();
  for(const channel of channels)connections.set(channel,{id:`connection-${channel}`,businessId:77,provider:channel,providerAccountId:accounts[channel],
    providerConnectionId:channel==='whatsapp'?'20001':null,tokenExpiresAt:null,grantedScopes:channel==='whatsapp'?['whatsapp_business_messaging']:channel==='instagram'?['instagram_business_manage_messages']:channel==='messenger'?['pages_messaging']:[],
    status:'connected',connectedAt:null,lastVerifiedAt:null,reconnectRequired:false,displayName:null,source:'self_service',credential:{accessToken:channel==='telegram'?config.telegramToken:'synthetic-only'},metadata:{}});
  const fetcher:typeof fetch=async(input,options)=>{
    const url=new URL(String(input));assert.ok(['graph.facebook.com','graph.instagram.com','api.telegram.org'].includes(url.hostname));
    const channel:Channel=url.hostname==='api.telegram.org'?'telegram':url.hostname==='graph.instagram.com'?'instagram':url.pathname.includes('/10001')||url.pathname.includes('/20001')||url.pathname.endsWith('/debug_token')?'whatsapp':'messenger';
    const response=(body:any,status=200)=>new Response(JSON.stringify(body),{status});
    if(options?.method==='POST'){
      const body=JSON.parse(String(options.body));const recipient=String(body.chat_id||body.to||body.recipient?.id);const text=body.text?.body||body.message?.text||body.text;
      posts.push({channel,recipient,text});if(ambiguous&&text!==fact){ambiguous=false;throw new Error('synthetic ambiguous progress POST');}
      if(progressHttpHold&&text!==fact){const held=progressHttpHold;progressHttpHold=null;await held;}
      return response(channel==='telegram'?{ok:true,result:{message_id:++providerAck,chat:{id:Number(recipient)}}}:channel==='whatsapp'?{contacts:[{wa_id:recipient}],messages:[{id:`wamid.synthetic-${++providerAck}`}]}:{message_id:`mid-${++providerAck}`,recipient_id:recipient});
    }
    if(revoked)return response({error:{code:190}},403);
    if(url.pathname.endsWith('/getMe'))return response({ok:true,result:{id:123456,is_bot:true}});
    if(url.pathname.endsWith('/getChat'))return response({ok:true,result:{id:Number(url.searchParams.get('chat_id')),type:'private'}});
    if(url.pathname.endsWith('/getChatMember'))return response({ok:true,result:{user:{id:123456},status:'member'}});
    if(url.pathname.endsWith('/debug_token'))return response({data:{is_valid:true,app_id:'789',user_id:'60001',scopes:['whatsapp_business_messaging','whatsapp_business_management'],granular_scopes:[{scope:'whatsapp_business_messaging'},{scope:'whatsapp_business_management'}],expires_at:0,data_access_expires_at:0}});
    if(url.pathname==='/v25.0/20001')return response({id:'20001',owner_business_info:{id:'50001'}});
    if(url.pathname.endsWith('/assigned_users'))return response({data:[{id:'60001',tasks:['MANAGE']}]});
    if(url.pathname.endsWith('/phone_numbers'))return response({data:[{id:accounts.whatsapp}]});
    if(channel==='whatsapp')return response({id:accounts.whatsapp,health_status:{can_send_message:'AVAILABLE'}});
    if(url.pathname.endsWith('/me'))return response(channel==='instagram'?{user_id:accounts.instagram}:{id:accounts.messenger});
    if(url.pathname.endsWith('/conversations'))return response({data:[{participants:{data:[{id:accounts[channel]},{id:url.searchParams.get('user_id')}]},can_reply:true}]});
    assert.fail('Unrecognized synthetic provider GET '+url.pathname);
  };
  globalThis.fetch=fetcher;
  const resetSource=(text:string)=>{source={id:'doc',businessId:77,type:'document',title:'Synthetic parking',status:'ready',content:text,createdAt:'synthetic',updatedAt:'synthetic',metadata:{segments:[{text}]}};};
  resetSource(fact);
  const createRuntime=()=>new NativeKnowledgeRuntime({db:pg.db,secret,controls:()=>controls,waiting:()=>({enabled:waitingEnabled,delayMs:5000}),
    waitingSchedule:(run,ms)=>{assert.equal(ms,5000);alarms.add(run);return()=>alarms.delete(run);},connections:async(business,channel)=>business===77?connections.get(channel)||null:null,
    sources:{list:async business=>business===77?[source]:[]},fetcher,diagnostic:event=>{diagnostic.push(event);if(telemetryThrows)throw new Error('synthetic optional observer');},
    execute:async(task,context,current)=>{const result=await executeDurableKnowledgeTask(task,context,config,current);if(changeAfterExecution)source={...source,status:'disabled'};return result;}});
  let runtime=createRuntime();t.after(()=>runtime.stop());
  const configure=()=>{b.reset();b.configure({nativeKnowledgeRuntime:runtime,
    semanticLanguageResolver:async()=>({language,confidence:1}),postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:1000}),
    knowledgeSearch:async business=>[{businessId:business,sourceId:'doc',text:source.content,score:1,metadata:{source:'document',documentRevision:knowledgeSourceRevision(source)}}],
    semanticKnowledgeSearch:async()=>[],validateKnowledgeMatches:async(business,matches)=>source.status==='ready'&&source.businessId===business?matches.filter(m=>m.metadata?.documentRevision===knowledgeSourceRevision(source)):[],
    geminiGenerate:async p=>{
      const instruction=p.config.systemInstruction;stages.push(instruction.includes('UNIT EXTRACTION')?'extraction':instruction.includes('BATCH ENTAILMENT')?'verification':instruction.includes('retrieval query planner')?'planning':'unexpected');
      if(instruction.includes('retrieval query planner'))return {text:JSON.stringify({canonicalMeaning:'parking at the studio',queries:[],requestedFacets:[{subject:'studio',attribute:facetAttribute,questionType:'description'}]})};
      const data=JSON.parse(p.contents[0].parts[0].text);
      if(instruction.includes('UNIT EXTRACTION') && extractionHold){const hold=extractionHold;extractionHold=null;extractionEntered?.();await hold;}
      if(instruction.includes('UNIT EXTRACTION'))return {text:JSON.stringify({units:[{facetIds:data.facets.map((f:any)=>f.id),subject:'studio',predicate:'offers',value:fact,modality:'descriptive',negation:false,scope:'studio',qualifiers:[],language,text:fact,evidenceRefs:[{evidenceId:'e1',exactQuote:fact}]}]})};
      if(instruction.includes('BATCH ENTAILMENT')&&verificationHold){const hold=verificationHold;verificationHold=null;verificationEntered?.();await hold;}
      if(instruction.includes('BATCH ENTAILMENT'))return {text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,relation:verifyRelation,facetIds:u.facetIds,meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),
        coverage:data.facets.map((f:any)=>({facetId:f.id,requestAligned:true,materialFactsComplete:true,materialUnitIds:data.units.map((u:any)=>u.id),obligations:f.obligations.map((o:any)=>({obligationId:o.id,status:'COVERED',unitIds:data.units.map((u:any)=>u.id)}))}))})};
      assert.fail('No unrestricted generation or extra orchestration call');
    },calendarAdapter:{getCalendarId:()=> 'synthetic',getEvents:async()=>{calendarReads++;return [];},checkSlots:async()=>assert.fail('No legacy availability'),
      insertAppointment:async()=>assert.fail('Knowledge recovery cannot mutate Booking'),cancelAppointment:async()=>assert.fail('No Booking mutation'),updateAppointment:async()=>assert.fail('No Booking mutation')},
    recordAppointment:async()=>assert.fail('No Booking mutation'),cancelAppointmentRow:async()=>assert.fail('No Booking mutation'),updateAppointmentRow:async()=>assert.fail('No Booking mutation'),...extra});};
  const inbound=async(channel:Channel,text:string,recipient:string,event?:number,at:number|null=Date.now()-60000)=>{
    const id=event||++serial;const cfg={...config};
    if(channel==='telegram')return b.telegramInbound({update_id:id,message:{chat:{id:Number(recipient),type:'private'},text,date:at===null?undefined:Math.floor(at/1000)}},cfg);
    if(channel==='whatsapp')return b.whatsappInbound({id:`event-${id}`,from:recipient,text:{body:text},type:'text',timestamp:at===null?undefined:String(Math.floor(at/1000))},{phone_number_id:accounts.whatsapp},cfg);
    const e={sender:{id:recipient},recipient:{id:accounts[channel]},timestamp:at===null?undefined:Math.floor(at),message:{mid:`event-${id}`,text}};
    return channel==='instagram'?b.instagramInbound(e,cfg):b.messengerInbound(e,cfg);
  };
  const latestTask=()=>JSON.parse(pg.sql("SELECT to_jsonb(t) FROM public.odin_tasks t ORDER BY created_at DESC LIMIT 1;"));
  const invalidate=async(task:any)=>{const channel=task.knowledge_channel as Channel;await runtime.repository.acceptOrdered(
    {businessId:77,channel,providerAccount:task.knowledge_account,conversationId:task.conversation_id},'cleanup-'+ ++serial,
    {atMs:Math.floor((Date.now()-1000)/1000)*1000,sequence:channel==='telegram'?serial:null});};
  const progress=(taskId:string)=>JSON.parse(pg.sql("SELECT coalesce(jsonb_agg(to_jsonb(d)),'[]'::jsonb) FROM public.odin_outbox d WHERE knowledge_kind='progress' AND knowledge_task_id='"+taskId+"';"));
  const waitFor=async(predicate:()=>boolean)=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}assert.fail('Expected bounded offline condition');};
  const fire=()=>{assert.ok(alarms.size>0,'a real confirmed generation stage armed the delay');for(const run of [...alarms]){alarms.delete(run);run();}};
  const heldTick=async(stage:'extraction'|'verification'='extraction')=>{
    let release!:()=>void,entered!:()=>void;const pending=new Promise<void>(r=>{release=r;});const begun=new Promise<void>(r=>{entered=r;});
    if(stage==='extraction'){extractionHold=pending;extractionEntered=entered;}else{verificationHold=pending;verificationEntered=entered;}
    const tick=runtime.tick();
    try{await Promise.race([begun,tick.then(()=>{throw new Error('Expected a held Knowledge stage, but the turn completed first');})]);}
    catch(error){release();throw error;}
    await new Promise(r=>setImmediate(r));return {release,tick};
  };
  const six=[...new Map(naturalLocationCases.map(c=>[c[0],c])).values()];
  for(const channel of channels)for(const[lang,question,text]of six)await t.test(`${channel}/${lang}: simulated five-second slow stage → one guarded localized acknowledgement → verified final`,async()=>{
    language=lang;fact=text;resetSource(fact);posts=[];stages=[];diagnostic=[];configure();
    const recipient=String(46700000000+ ++serial);await inbound(channel,question,recipient);const task=latestTask();
    const held=await heldTick();assert.equal(posts.length,0,'no immediate waiting');fire();
    await waitFor(()=>progress(task.id)[0]?.knowledge_state==='SENT');assert.equal(posts.length,1);assert.ok(approvedWaitingText(lang,posts[0].text));
    assert.ok(posts[0].text.includes(({en:'parking',sv:'parkering',de:'Parken',es:'aparcamiento',fa:'پارکینگ',ar:'مواقف'} as const)[lang]));
    assert.ok(!posts[0].text.includes(fact));assert.equal(posts[0].recipient,recipient);held.release();await held.tick;
    assert.equal(posts.length,2);assert.equal(posts[1].text,fact);assert.equal(posts[1].recipient,recipient);
    assert.equal(stages.filter(v=>v==='extraction').length,1);assert.equal(stages.filter(v=>v==='verification').length,1);assert.ok(stages.length<=3,'no extra waiting model');
    assert.equal(progress(task.id).length,1);assert.equal(progress(task.id)[0].knowledge_state,'SENT');
    assert.ok(diagnostic.some(e=>e.stage==='waiting_transport_result'));assert.ok(diagnostic.every(e=>!e.turnId||e.turnId===task.knowledge_turn_id));
    assert.equal(JSON.stringify(diagnostic).includes(recipient),false);assert.equal(JSON.stringify(diagnostic).includes(posts[0].text),false);
    await runtime.tick();assert.equal(posts.length,2);assert.equal(calendarReads,0);
  });
  await t.test('parking follow-up uses frozen durable history and gets its own single waiting identity',async()=>{
    language='en';fact='Parking is at the Nordpark garage.';resetSource(fact);posts=[];configure();const recipient='46709000015';
    await inbound('whatsapp','Where can I park my car?',recipient,++serial,Date.now()-60000);await runtime.tick();
    configure();await inbound('whatsapp','Where is that parking?',recipient,++serial,Date.now()-30000);const task=latestTask();
    assert.ok(task.payload.history.some((h:any)=>h.role==='assistant'&&h.content===fact));const held=await heldTick();fire();
    await waitFor(()=>progress(task.id)[0]?.knowledge_state==='SENT');held.release();await held.tick;
    assert.equal(posts.length,3);assert.equal(posts.filter(p=>approvedWaitingText(language,p.text)).length,1);
    assert.equal(posts[2].text,fact);assert.equal(progress(task.id).length,1);
  });
  await t.test('fast native question publishes directly, without an unnecessary acknowledgement',async()=>{
    language='en';fact='Parking is nearby.';resetSource(fact);posts=[];stages=[];configure();await inbound('telegram','Where can I park my car?','46709000001');
    const task=latestTask();await runtime.tick();assert.equal(posts.length,1);assert.equal(posts[0].text,fact);assert.equal(progress(task.id).length,0);assert.equal(alarms.size,0);
  });
  await t.test('actual verification stage and non-parking context choose fact-free verification wording',async()=>{
    facetAttribute='pet_policy';language='en';fact='Dogs are allowed in the waiting area.';resetSource(fact);posts=[];stages=[];configure();
    await inbound('messenger','Can I bring my dog to the studio?','46709000002');const task=latestTask();const held=await heldTick('verification');fire();
    await waitFor(()=>progress(task.id)[0]?.knowledge_state==='SENT');assert.ok(/details/u.test(posts[0].text));assert.ok(!/parking|Dogs/u.test(posts[0].text));
    held.release();await held.tick;assert.equal(posts[1].text,fact);facetAttribute='parking';
  });
  await t.test('duplicate native event retains one progress identity and one final reply',async()=>{
    language='en';fact='Parking is nearby.';resetSource(fact);posts=[];configure();const event=++serial,recipient='46709000003';
    await inbound('whatsapp','Where can I park my car?',recipient,event);const task=latestTask();const held=await heldTick();fire();await waitFor(()=>progress(task.id)[0]?.knowledge_state==='SENT');held.release();await held.tick;
    configure();await inbound('whatsapp','Where can I park my car?',recipient,event);await runtime.tick();assert.equal(posts.length,2);assert.equal(progress(task.id).length,1);
  });
  await t.test('two host workers cannot create two waiting messages for the same task',async()=>{
    posts=[];configure();await inbound('instagram','Where can I park my car?','46709000004');const task=latestTask();const held=await heldTick();
    const other=createRuntime();await other.tick();fire();await waitFor(()=>progress(task.id)[0]?.knowledge_state==='SENT');held.release();await held.tick;await other.stop();
    assert.equal(posts.length,2);assert.equal(progress(task.id).length,1);
  });
  await t.test('recipient permission revocation suppresses waiting and factual publication',async()=>{
    posts=[];configure();await inbound('telegram','Where can I park my car?','46709000005');const task=latestTask();const held=await heldTick();revoked=true;fire();
    await waitFor(()=>diagnostic.some(e=>e.stage==='waiting_attempt'&&e.turnId===task.knowledge_turn_id));
    held.release();await held.tick;assert.equal(posts.length,0);await invalidate(task);revoked=false;
  });
  await t.test('superseded native turn cannot emit waiting or a stale final answer',async()=>{
    posts=[];configure();const recipient='46709000006';await inbound('whatsapp','Where can I park my car?',recipient,++serial,Date.now()-60000);
    const old=latestTask();const held=await heldTick();await inbound('whatsapp','Where is the parking?',recipient,++serial,Date.now()-30000);fire();held.release();
    await held.tick.catch(()=>{});await runtime.tick();assert.equal(progress(old.id).length,0);assert.equal(posts.length,1);assert.equal(posts[0].text,fact);
  });
  await t.test('ambiguous progress send is quarantined without delaying or duplicating final publication',async()=>{
    posts=[];configure();await inbound('messenger','Where can I park my car?','46709000007');const task=latestTask();const held=await heldTick();ambiguous=true;fire();
    await waitFor(()=>progress(task.id)[0]?.knowledge_state==='UNCERTAIN');held.release();await held.tick;assert.equal(posts.length,2);assert.equal(posts[1].text,fact);
    await runtime.tick();assert.equal(posts.length,2);assert.equal(progress(task.id)[0].attempt_count,1);
  });
  await t.test('a slow in-flight progress POST never holds the independently verified final reply',async()=>{
    posts=[];configure();await inbound('telegram','Where can I park my car?','46709000008');const task=latestTask();const held=await heldTick();let releaseHttp!:()=>void;
    progressHttpHold=new Promise<void>(r=>{releaseHttp=r;});fire();await waitFor(()=>posts.length===1);held.release();await held.tick;
    assert.equal(posts.length,2);assert.equal(posts[1].text,fact);assert.equal(progress(task.id)[0].knowledge_state,'SENDING');releaseHttp();
    await waitFor(()=>progress(task.id)[0]?.knowledge_state==='SENT');
  });
  await t.test('database/process restart and lease takeover do not resend an accepted acknowledgement',async()=>{
    posts=[];configure();await inbound('instagram','Where can I park my car?','46709000009');const task=latestTask();const held=await heldTick();fire();
    await waitFor(()=>progress(task.id)[0]?.knowledge_state==='SENT');assert.equal(await runtime.stop(5),false);pg.restart();
    pg.sql("UPDATE public.odin_tasks SET knowledge_lease_until=clock_timestamp()-interval '1 second' WHERE id='"+task.id+"';");runtime=createRuntime();configure();await runtime.tick();held.release();await held.tick.catch(()=>{});
    assert.equal(posts.length,2);assert.equal(posts[1].text,fact);assert.equal(progress(task.id)[0].attempt_count,1);assert.equal(latestTask().knowledge_expires_at,task.knowledge_expires_at);
  });
  await t.test('missing progress migration permission is an optional failure; verified final still succeeds',async()=>{
    posts=[];configure();await inbound('whatsapp','Where can I park my car?','46709000010');const task=latestTask();const held=await heldTick();
    pg.sql('REVOKE EXECUTE ON FUNCTION public.odin_claim_knowledge_progress_v1(bigint,uuid,uuid,text,text,text,text,bigint,text,jsonb,integer) FROM service_role;');
    try{fire();await waitFor(()=>diagnostic.some(e=>e.turnId===task.knowledge_turn_id&&e.stage==='waiting_failed'));}
    finally{pg.sql('GRANT EXECUTE ON FUNCTION public.odin_claim_knowledge_progress_v1(bigint,uuid,uuid,text,text,text,text,bigint,text,jsonb,integer) TO service_role;');}
    held.release();await held.tick;assert.equal(posts.length,1);assert.equal(posts[0].text,fact);
  });
  await t.test('failed independent verification never turns waiting into factual authority',async()=>{
    posts=[];configure();await inbound('instagram','Where can I park my car?','46709000012');const task=latestTask();const held=await heldTick();fire();
    await waitFor(()=>progress(task.id)[0]?.knowledge_state==='SENT');verifyRelation='UNKNOWN';held.release();await held.tick;verifyRelation='ENTAILED';
    assert.equal(posts.length,1);assert.ok(approvedWaitingText(language,posts[0].text));assert.equal(latestTask().knowledge_state,'FAILED');
  });
  await t.test('source revocation after waiting still prevents factual finalization',async()=>{
    posts=[];configure();await inbound('messenger','Where can I park my car?','46709000013');const task=latestTask();const held=await heldTick();fire();
    await waitFor(()=>progress(task.id)[0]?.knowledge_state==='SENT');changeAfterExecution=true;held.release();await held.tick;changeAfterExecution=false;
    assert.equal(posts.length,1);assert.equal(latestTask().knowledge_state,'VERIFIED');await invalidate(task);resetSource(fact);
  });
  await t.test('throwing telemetry cannot change waiting or final transport results',async()=>{
    posts=[];configure();await inbound('whatsapp','Where can I park my car?','46709000014');const task=latestTask();const held=await heldTick();telemetryThrows=true;fire();
    await waitFor(()=>progress(task.id)[0]?.knowledge_state==='SENT');held.release();await held.tick;telemetryThrows=false;assert.equal(posts.length,2);assert.equal(posts[1].text,fact);
  });
  await t.test('independent waiting off keeps the foreground/native async final behavior unchanged',async()=>{
    waitingEnabled=false;posts=[];configure();await inbound('telegram','Where can I park my car?','46709000011');const task=latestTask();await runtime.tick();
    assert.equal(posts.length,1);assert.equal(progress(task.id).length,0);assert.equal(alarms.size,0);waitingEnabled=true;
  });
  await t.test('authorized foreground booking commits once; duplicate ingress and Knowledge recovery cannot replay it',async()=>{
    language='en';fact='Parking is nearby.';resetSource(fact);stages=[];posts=[];let mutations=0,rows=0;
    const channel:Channel='telegram',recipient='46700910008',events=new Map<string,any>();
    extra={calendarAdapter:{getCalendarId:()=> 'synthetic',getEvents:async()=>[...events.values()],getEventById:async(id:string)=>events.get(id)||null,
      checkSlots:async()=>assert.fail('No legacy booking slots'),insertAppointment:async(name:string,phone:string,_service:string,dateTime:string,duration=60)=>{
        mutations++;const event={id:'calendar-'+mutations,status:'confirmed',summary:`Booked: ${name} - ${phone}`,start:{dateTime},end:{dateTime:new Date(Date.parse(dateTime)+duration*60000).toISOString()},extendedProperties:{private:{platform:channel,userId:recipient}}};events.set(event.id,event);return {success:true,event};},
      cancelAppointment:async()=>assert.fail('No cancellation'),updateAppointment:async()=>assert.fail('No reschedule')},
      notifyBooking:async()=>true,recordAppointment:async(params:any)=>{rows++;return {id:rows,business_id:77,platform:channel,user_id:recipient,service:params.service,start_time:params.dateTime,end_time:new Date(Date.parse(params.dateTime)+3600000).toISOString(),status:'booked',created_at:new Date().toISOString()};}};
    try{
      configure();const session=`tg:77:${createHash('sha256').update(config.telegramToken).digest('hex').slice(0,12)}:${recipient}`;
      b.stateAuditConfig(session,config);const day=new Date(Date.now()+172800000).toLocaleDateString('sv-SE',{timeZone:'Europe/Stockholm'});
      const start=day+'T13:00:00+02:00',end=day+'T14:00:00+02:00';
      b.seedPending(session,{businessConfig:config,bookingStateVersion:CURRENT_BOOKING_STATE_VERSION,businessId:'77',platform:channel,userId:recipient,sessionId:session,
        operation:'new_booking',status:'awaiting_contact',expectedInput:'contact',service:'Video Consultation',durationMinutes:60,selectedDate:day,dateTime:start,selectedSlotEnd:end,language:'en',
        availabilityConstraint:{startDate:day,endDate:day,kind:'exact_time',exactTime:'13:00',rejectedTimes:[]},offeredSlots:[],
        ownedOfferedSlots:[{start,end,durationMinutes:60,service:'Video Consultation',businessId:'77',platform:channel,userId:recipient,generatedAt:Date.now()-120000,searchStartDate:day,searchEndDate:day}]});
      b.seedFlowLanguage(session,'en');const event=++serial;const at=Date.now()-30000;
      await inbound(channel,'Please book Video Consultation for me. My name is Ada Example and my phone number is 0701234567. Also where can I park my car?',recipient,event,at);
      assert.equal(mutations,1,JSON.stringify({state:b.pendingStateSnapshot(session)?.status,posts:posts.map(p=>p.text)}));assert.equal(rows,1);
      await inbound(channel,'Please book Video Consultation for me. My name is Ada Example and my phone number is 0701234567. Also where can I park my car?',recipient,event,at);
      const held=await heldTick();fire();await waitFor(()=>posts.some(p=>approvedWaitingText(language,p.text)));held.release();await held.tick;assert.equal(mutations,1);assert.equal(rows,1);assert.equal(posts.filter(p=>p.recipient===recipient&&p.text===fact).length,1);
    }finally{extra={};}
  });


});
