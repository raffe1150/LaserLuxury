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

test('real four native entries → ordered PostgreSQL admission → real Knowledge executor → guarded fake provider',async t=>{
  const pg=new DisposableNativeKnowledgeDatabase();t.after(()=>pg.close());const oldFetch=globalThis.fetch;const oldFlags=[process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE,process.env.ODINLINK_GROUNDED_NATURAL_RESPONSES,process.env.META_APP_ID,process.env.META_WHATSAPP_APP_ID];
  t.after(()=>{globalThis.fetch=oldFetch;['ODINLINK_EVIDENCE_FIRST_KNOWLEDGE','ODINLINK_GROUNDED_NATURAL_RESPONSES','META_APP_ID','META_WHATSAPP_APP_ID'].forEach((k,i)=>{if(oldFlags[i]===undefined)delete process.env[k];else process.env[k]=oldFlags[i];});b.reset();});
  process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE='true';process.env.ODINLINK_GROUNDED_NATURAL_RESPONSES='false';process.env.META_APP_ID='789';process.env.META_WHATSAPP_APP_ID='789';
  for(const level of ['log','warn','error','info'] as const)t.mock.method(console,level,()=>{});
  let language='en',fact='Parking is nearby.',serial=10000;let controls:NativeAsyncControls={admission:true,processing:true,delivery:true,executionMs:40000};
  let modelGenerate:(p:any)=>Promise<any>;let sdkRequests:any[]=[];
  let measuring=false;let measured:Record<string,number[]>={};let eventTimes:Record<string,number>={};
  const measure=(stage:string,ms:number)=>{if(measuring)(measured[stage]||=[]).push(ms);};
  const providerEnv=Object.fromEntries(['AI_PROVIDER','OPENAI_API_KEY','OPENAI_MODEL'].map(k=>[k,process.env[k]]));
  t.after(()=>{for(const[k,v]of Object.entries(providerEnv)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
  let source:KnowledgeSource;let stages:string[]=[];let posts:{channel:string;recipient:string;text:string}[]=[];let diagnostic:any[]=[];
  let extractionHold:Promise<void>|null=null,extractionEntered:(()=>void)|null=null;
  let extra:Parameters<typeof b.configure>[0]={};
  let revoked=false,ambiguous=false,verifyRelation='ENTAILED',calendarReads=0,changeAfterExecution=false,telemetryThrows=false;
  const connections=new Map<string,ResolvedChannelConnection>();
  for(const channel of channels)connections.set(channel,{id:`connection-${channel}`,businessId:77,provider:channel,providerAccountId:accounts[channel],
    providerConnectionId:channel==='whatsapp'?'20001':null,tokenExpiresAt:null,grantedScopes:channel==='whatsapp'?['whatsapp_business_messaging']:channel==='instagram'?['instagram_business_manage_messages']:channel==='messenger'?['pages_messaging']:[],
    status:'connected',connectedAt:null,lastVerifiedAt:null,reconnectRequired:false,displayName:null,source:'self_service',credential:{accessToken:channel==='telegram'?config.telegramToken:'synthetic-only'},metadata:{}});
  const providerFixture:typeof fetch=async(input,options)=>{
    const url=new URL(String(input));
    if(url.hostname==='api.openai.com'){
      assert.equal(url.pathname,'/v1/responses');const params=JSON.parse(String(options?.body));sdkRequests.push(params);
      assert.equal(params.text.format.type,'json_schema');assert.equal(params.text.format.strict,true);
      const data=JSON.parse(params.input[0].content);
      if(params.instructions.includes('UNIT EXTRACTION')){
        assert.deepEqual(params.text.format.schema.properties.units.items.properties.facetIds.items.enum,data.allowedFacetIds);
        assert.equal(params.reasoning.effort,'low');
      }
      const generated=await modelGenerate({config:{systemInstruction:params.instructions,tools:[]},contents:[{parts:[{text:params.input[0].content}]}]});
      return new Response(JSON.stringify({id:'resp_synthetic',object:'response',status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:generated.text,annotations:[]}]}],usage:{input_tokens:10,output_tokens:10}}),{headers:{'content-type':'application/json'}});
    }
    assert.ok(['graph.facebook.com','graph.instagram.com','api.telegram.org'].includes(url.hostname));
    const channel:Channel=url.hostname==='api.telegram.org'?'telegram':url.hostname==='graph.instagram.com'?'instagram':url.pathname.includes('/10001')||url.pathname.includes('/20001')||url.pathname.endsWith('/debug_token')?'whatsapp':'messenger';
    const response=(body:any,status=200)=>new Response(JSON.stringify(body),{status});
    if(options?.method==='POST'){
      const body=JSON.parse(String(options.body));const recipient=String(body.chat_id||body.to||body.recipient?.id);const text=body.text?.body||body.message?.text||body.text;
      posts.push({channel,recipient,text});if(ambiguous)throw new Error('synthetic connection reset after POST');
      return response(channel==='telegram'?{ok:true,result:{message_id:serial,chat:{id:Number(recipient)}}}:channel==='whatsapp'?{contacts:[{wa_id:recipient}],messages:[{id:`wamid.synthetic-${serial}`}]}:{message_id:`mid-${serial}`,recipient_id:recipient});
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
  const fetcher:typeof fetch=async(input,options)=>{
    const started=performance.now();const response=await providerFixture(input,options);
    const url=new URL(String(input));const stage=url.hostname==='api.openai.com'?(JSON.parse(String(options?.body)).instructions.includes('UNIT EXTRACTION')?'proposal':'verification'):options?.method==='POST'?'send':'eligibilityRead';
    measure(stage,performance.now()-started);return response;
  };
  globalThis.fetch=fetcher;
  const resetSource=(text:string)=>{source={id:'doc',businessId:77,type:'document',title:'Synthetic parking',status:'ready',content:text,createdAt:'synthetic',updatedAt:'synthetic',metadata:{segments:[{text}]}};};
  resetSource(fact);
  const createRuntime=()=>new NativeKnowledgeRuntime({db:pg.db,secret,controls:()=>controls,connections:async(business,channel)=>business===77?connections.get(channel)||null:null,
    sources:{list:async business=>{const start=performance.now();const result=business===77?[source]:[];measure('sourceRead',performance.now()-start);return result;}},fetcher,diagnostic:event=>{if(measuring)eventTimes[event.stage]=performance.now();diagnostic.push(event);if(telemetryThrows)throw new Error('synthetic optional observer');},
    execute:async(task,context,current)=>{const result=await executeDurableKnowledgeTask(task,context,config,current);if(changeAfterExecution)source={...source,status:'disabled'};return result;}});
  let runtime=createRuntime();t.after(()=>runtime.stop());
  const configure=()=>{b.reset();b.configure({nativeKnowledgeRuntime:runtime,
    knowledgeRetrievalDiagnostic:event=>{if(measuring)measure('retrieval',Number(event.durationMs));},
    evidenceFirstDiagnostic:event=>{if(measuring)for(const stage of event.stages as any[]||[]){if(stage.stage==='extraction')measure('proposalStage',stage.durationMs);if(stage.stage==='verification')measure('verificationStage',stage.durationMs);}},
    semanticLanguageResolver:async()=>({language,confidence:1}),postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:1000}),
    knowledgeSearch:async business=>[{businessId:business,sourceId:'doc',text:source.content,score:1,metadata:{source:'document',documentRevision:knowledgeSourceRevision(source)}}],
    semanticKnowledgeSearch:async()=>[],validateKnowledgeMatches:async(business,matches)=>source.status==='ready'&&source.businessId===business?matches.filter(m=>m.metadata?.documentRevision===knowledgeSourceRevision(source)):[],
    geminiGenerate:modelGenerate=async p=>{
      const instruction=p.config.systemInstruction;stages.push(instruction.includes('UNIT EXTRACTION')?'extraction':instruction.includes('BATCH ENTAILMENT')?'verification':instruction.includes('retrieval query planner')?'planning':'unexpected');
      if(instruction.includes('retrieval query planner'))return {text:JSON.stringify({canonicalMeaning:'parking at the studio',queries:[],requestedFacets:[{subject:'studio',attribute:'parking',questionType:'description'}]})};
      const data=JSON.parse(p.contents[0].parts[0].text);
      if(instruction.includes('UNIT EXTRACTION')){assert.deepEqual(data.allowedFacetIds,data.facets.map((f:any)=>f.id));assert.ok(data.evidence.every((e:any)=>!Object.hasOwn(e,'version')));assert.match(instruction,/multiple units answering the same question reuse the same facet ID/);}
      if(instruction.includes('BATCH ENTAILMENT'))assert.match(instruction,/modalityPreserved=false/);
      if(instruction.includes('UNIT EXTRACTION') && extractionHold){const hold=extractionHold;extractionHold=null;extractionEntered?.();await hold;}
      if(instruction.includes('UNIT EXTRACTION'))return {text:JSON.stringify({units:[{facetIds:data.facets.map((f:any)=>f.id),subject:'studio',predicate:'offers',value:fact,modality:'descriptive',negation:false,scope:'studio',qualifiers:[],language,text:fact,evidenceRefs:[{evidenceId:'e1',exactQuote:fact}]}]})};
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
  const six=[...new Map(naturalLocationCases.map(c=>[c[0],c])).values()];
  for(const provider of ['gemini','openai'] as const)for(const channel of channels)for(const [lang,question,text]of six)await t.test(`${provider}/${channel}/${lang}: exactly one verified native async answer`,async()=>{
    Object.assign(process.env,{AI_PROVIDER:provider,OPENAI_API_KEY:'synthetic-offline-only',OPENAI_MODEL:'gpt-5.6-luna'});sdkRequests=[];measured={};eventTimes={};measuring=provider==='openai';
    language=lang;fact=text;resetSource(fact);stages=[];posts=[];diagnostic=[];configure();const recipient=String(46700000000+ ++serial);
    await inbound(channel,question,recipient);
    assert.deepEqual(stages,[],'foreground must stop before Knowledge planning');assert.equal(posts.length,0);
    const task=latestTask();assert.equal(task.knowledge_channel,channel);assert.equal(task.payload.language,lang);
    const report=await runtime.tick();assert.equal(report.deliveries.length,1,JSON.stringify({stages,task,report}));
    assert.equal(report.deliveries[0].result.outcome.kind,'API_ACCEPTED');assert.equal(posts.length,1);assert.equal(posts[0].recipient,recipient);assert.equal(posts[0].text,fact);
    assert.equal(stages.filter(s=>s==='extraction').length,1);assert.equal(stages.filter(s=>s==='verification').length,1);assert.equal(calendarReads,0);
    assert.equal(diagnostic.filter(e=>e.turnId).every(e=>e.turnId===task.knowledge_turn_id),true);
    assert.equal(JSON.stringify(diagnostic).includes(recipient),false);assert.equal(JSON.stringify(diagnostic).includes(fact),false);
    await runtime.tick();assert.equal(posts.length,1,'recovery must not resend SENT');
    if(provider==='openai'){
      assert.equal(sdkRequests.length,2,'separate proposal and independent verification through installed SDK');
      const headroomMs=Date.parse(task.knowledge_expires_at)-Date.now();assert.ok(headroomMs>0);
      for(const stage of ['verified','finalized','native_send_attempt','native_api_accepted','settled'])assert.ok(Number.isFinite(eventTimes[stage]),stage);
      assert.ok(measured.retrieval.length&&measured.proposal.length&&measured.verification.length&&measured.send.length);
      t.diagnostic('Phase3Timing '+JSON.stringify({providerFixture:true,channel,language:lang,...measured,
        finalAuthorityAndPublicationMs:eventTimes.finalized-eventTimes.verified,deliveryAuthorityMs:eventTimes.native_send_attempt-eventTimes.finalized,
        settlementMs:eventTimes.settled-eventTimes.native_api_accepted,headroomMs,customerDelivery:'UNCONFIRMED'}));
    }
    measuring=false;
  });
  process.env.AI_PROVIDER='gemini';
  await t.test('database/process restart recovers exact recipient, current connection and frozen preceding answer',async()=>{
    language='en';fact='Parking is available at the Nordpark garage.';resetSource(fact);stages=[];posts=[];configure();
    const recipient='46700900001';await inbound('whatsapp','Where can I park my car?',recipient,++serial,Date.now()-30000);
    const task=latestTask();await runtime.stop();pg.restart();runtime=createRuntime();configure();
    await runtime.tick();assert.equal(posts.length,1);assert.equal(posts[0].recipient,recipient);
    configure(); // Simulate lost process-local conversation history after restart.
    await inbound('whatsapp','Where is that parking?',recipient,++serial,Date.now()-20000);
    const followup=latestTask();assert.ok(followup.payload.history.some((h:any)=>h.role==='assistant'&&h.content===fact));
    await runtime.tick();assert.equal(posts.filter(p=>p.recipient===recipient).length,2);
    assert.equal(task.payload.question,'Where can I park my car?');
  });
  await t.test('mixed action-first foreground availability plus one async information branch',async()=>{
    language='en';fact='Parking is nearby.';resetSource(fact);stages=[];posts=[];configure();calendarReads=0;
    await inbound('telegram','I want to book Video Consultation tomorrow. Also where can I park my car?','46700900002');
    assert.ok(calendarReads>0,'foreground Booking authority remains active');assert.equal(stages.length,0);
    const before=calendarReads;await runtime.tick();assert.equal(calendarReads,before,'recovery cannot repeat Booking reads/actions');
    assert.equal(posts.filter(p=>p.text===fact).length,1);assert.equal(stages.filter(s=>s==='verification').length,1);
  });
  for(const channel of channels)await t.test(`${channel}: duplicate and delayed older native entries keep one task and reply`,async()=>{
    language='en';fact='Parking is nearby.';resetSource(fact);stages=[];posts=[];calendarReads=0;configure();
    const recipient=String(46710000000+ ++serial),event=++serial,at=Date.now()-40000;
    await inbound(channel,'Where can I park my car?',recipient,event,at);const first=latestTask();
    await inbound(channel,'Where can I park my car?',recipient,event-1,at-1000);
    configure(); // Lose the foreground dedup cache; retain the real durable identity.
    await inbound(channel,'Where can I park my car?',recipient,event,at);
    assert.equal(pg.sql("SELECT count(*) FROM public.odin_tasks WHERE conversation_id='"+first.conversation_id+"';"),'1');
    await runtime.tick();assert.equal(posts.filter(p=>p.recipient===recipient).length,1);assert.equal(calendarReads,0);
    assert.equal(stages.filter(s=>s==='extraction').length,1);
  });
  await t.test('two Telegram bot accounts sharing a business and update ID retain distinct foreground claims',async()=>{
    language='en';fact='Parking is nearby.';resetSource(fact);stages=[];posts=[];configure();
    const original=connections.get('telegram')!;const update=++serial,at=Math.floor((Date.now()-30000)/1000);
    const before=Number(pg.sql('SELECT count(*) FROM public.odin_tasks;'));
    try {
      await b.telegramInbound({update_id:update,message:{chat:{id:46700911001,type:'private'},text:'Where can I park my car?',date:at}},config);
      connections.set('telegram',{...original,id:'second-telegram-connection',providerAccountId:'654321',credential:{accessToken:'654321:synthetic-offline'}});
      const otherConfig={...config,telegramToken:'654321:synthetic-offline'};
      await b.telegramInbound({update_id:update,message:{chat:{id:46700911002,type:'private'},text:'Where can I park my car?',date:at}},otherConfig);
      assert.equal(Number(pg.sql('SELECT count(*) FROM public.odin_tasks;')),before+2);
      assert.equal(pg.sql("SELECT count(DISTINCT knowledge_account) FROM public.odin_tasks WHERE knowledge_inbox_id IN (SELECT id FROM public.odin_inbox WHERE provider_event_id='"+update+"');"),'2');
      const count=Number(pg.sql('SELECT count(*) FROM public.odin_tasks;'));
      await b.telegramInbound({update_id:update,message:{chat:{id:46700911002,type:'private'},text:'Changed duplicate',date:at}},otherConfig);
      assert.equal(Number(pg.sql('SELECT count(*) FROM public.odin_tasks;')),count);assert.deepEqual(stages,[]);
    }finally{connections.set('telegram',original);}
    // Preserve later test isolation without executing either fixture answer.
    pg.sql("UPDATE public.odin_tasks SET knowledge_state='FAILED' WHERE knowledge_inbox_id IN (SELECT id FROM public.odin_inbox WHERE provider_event_id='"+update+"');");
  });
  await t.test('legacy Telegram claims cannot replay under the new account-scoped key',async()=>{
    language='en';fact='Parking is nearby.';resetSource(fact);stages=[];posts=[];configure();
    const event=++serial,recipient='46700911003',at=Date.now()-30000;
    const claim=await b.claimAtomic({type:'inbound_message_claim',tenantScope:'77',platform:'telegram',exactId:String(event),businessId:'77'});
    assert.equal(claim.claimed,true);
    assert.equal(await b.settleAtomic(claim,'completed'),true);
    const before=Number(pg.sql('SELECT count(*) FROM public.odin_tasks;'));calendarReads=0;
    await inbound('telegram','I want to book Video Consultation tomorrow. Also where can I park my car?',recipient,event,at);
    assert.equal(Number(pg.sql('SELECT count(*) FROM public.odin_tasks;')),before);assert.equal(calendarReads,0);
    assert.equal(pg.sql("SELECT knowledge_intake_reason FROM public.odin_inbox WHERE provider_event_id='"+event+"';"),'LEGACY_CLAIM_REQUIRES_REVIEW');
    await inbound('telegram','I want to book Video Consultation tomorrow. Also where can I park my car?',recipient,event,at);
    assert.equal(calendarReads,0);assert.deepEqual(stages,[]);
  });
  for(const channel of channels)await t.test(`${channel}: rejected preparation cannot mark inbound or Knowledge handoff completed`,async()=>{
    language='en';fact='Parking is nearby.';resetSource(fact);stages=[];posts=[];
    const settled:string[]=[];extra={settleOperation:async(_handle,status)=>{settled.push(status);return true;}};configure();
    const originalRpc=pg.db.rpc;const event=++serial,recipient=String(46700912000+serial),at=Date.now()-30000;
    pg.db.rpc=async(name,args)=>name==='odin_native_intake_v1'&&args.p_command==='prepare'
      ? {data:null,error:new Error('synthetic preparation rejected before commit')}:originalRpc(name,args);
    try {
      await assert.rejects(inbound(channel,'Where can I park my car?',recipient,event,at));
      assert.equal(settled.includes('completed'),false);
      const nativeId=channel==='telegram'?String(event):'event-'+event;
      assert.equal(pg.sql("SELECT knowledge_intake_state FROM public.odin_inbox WHERE provider_event_id='"+nativeId+"';"),'ROUTING');
      assert.equal(pg.sql("SELECT count(*) FROM public.odin_tasks WHERE knowledge_inbox_id=(SELECT id FROM public.odin_inbox WHERE provider_event_id='"+nativeId+"');"),'0');
      await assert.rejects(inbound(channel,'Where can I park my car?',recipient,event,at),/still_routing/);
      assert.deepEqual(stages,[]);
    }finally{pg.db.rpc=originalRpc;extra={};}
  });
  for(const channel of channels)await t.test(`${channel}: ambiguous order cannot fall back into foreground Knowledge`,async()=>{
    language='en';fact='Parking is nearby.';resetSource(fact);stages=[];posts=[];calendarReads=0;configure();
    const recipient=String(46720000000+ ++serial),at=Math.floor((Date.now()-40000)/1000)*1000;
    await inbound(channel,'Where can I park my car?',recipient,++serial,at);const first=latestTask();
    await inbound(channel,'Where can I park my car?',recipient,++serial,channel==='telegram'?null:at);
    await runtime.tick();assert.deepEqual(stages,[]);assert.equal(posts.some(p=>p.text===fact),false);
    assert.equal(pg.sql("SELECT knowledge_state FROM public.odin_tasks WHERE id='"+first.id+"';"),'SUPERSEDED');
  });
  for(const channel of channels)await t.test(`${channel}: ambiguous remote result stays UNCERTAIN and is never blindly retried`,async()=>{
    language='en';fact='Parking is nearby.';resetSource(fact);stages=[];posts=[];configure();ambiguous=true;
    try{
      const recipient=String(46730000000+ ++serial);await inbound(channel,'Where can I park my car?',recipient);const task=latestTask();
      const result=await runtime.tick();assert.ok(result.deliveries.some(d=>d.taskId===task.id&&d.result.outcome.kind==='AMBIGUOUS'));
      assert.equal(pg.sql("SELECT knowledge_state FROM public.odin_outbox WHERE knowledge_task_id='"+task.id+"';"),'UNCERTAIN');
      const count=posts.length;await runtime.tick();assert.equal(posts.length,count);assert.equal(posts.filter(p=>p.recipient===recipient).length,1);
    }finally{ambiguous=false;}
  });
  await t.test('two recovery workers compete for one native turn without duplicate model work or replies',async()=>{
    language='en';fact='Parking is nearby.';resetSource(fact);stages=[];posts=[];configure();
    const recipient='46700910001';await inbound('messenger','Where can I park my car?',recipient);
    const other=createRuntime();try{await Promise.all([runtime.tick(),other.tick()]);}finally{await other.stop();}
    assert.equal(posts.filter(p=>p.recipient===recipient).length,1);assert.equal(stages.filter(s=>s==='extraction').length,1);
  });
  await t.test('revoked current provider permission prevents finalization and any POST',async()=>{
    language='en';fact='Parking is nearby.';resetSource(fact);stages=[];posts=[];configure();
    const recipient='46700910002';await inbound('instagram','Where can I park my car?',recipient);const task=latestTask();revoked=true;
    try{await runtime.tick();assert.equal(posts.some(p=>p.recipient===recipient),false);assert.equal(pg.sql("SELECT count(*) FROM public.odin_outbox WHERE knowledge_task_id='"+task.id+"';"),'0');}
    finally{revoked=false;}
  });
  await t.test('revoked evidence after verified execution cannot become an authorized outbound artifact',async()=>{
    language='en';fact='Parking is nearby.';resetSource(fact);stages=[];posts=[];configure();changeAfterExecution=true;
    try{await inbound('whatsapp','Where can I park my car?','46700910003');const task=latestTask();await runtime.tick();
      assert.equal(posts.some(p=>p.recipient==='46700910003'),false);assert.equal(pg.sql("SELECT count(*) FROM public.odin_outbox WHERE knowledge_task_id='"+task.id+"';"),'0');}
    finally{changeAfterExecution=false;resetSource(fact);}
  });
  await t.test('failed independent verification never publishes extraction-only text',async()=>{
    language='en';fact='Parking is nearby.';resetSource(fact);stages=[];posts=[];configure();verifyRelation='UNKNOWN';
    try{await inbound('telegram','Where can I park my car?','46700910004');const task=latestTask();await runtime.tick();
      assert.equal(posts.some(p=>p.recipient==='46700910004'),false);assert.equal(pg.sql("SELECT knowledge_state FROM public.odin_tasks WHERE id='"+task.id+"';"),'FAILED');}
    finally{verifyRelation='ENTAILED';}
  });
  await t.test('telemetry failures before and after a send cannot change API acceptance or duplicate the POST',async()=>{
    language='en';fact='Parking is nearby.';resetSource(fact);stages=[];posts=[];configure();telemetryThrows=true;
    try{await inbound('whatsapp','Where can I park my car?','46700910005');const task=latestTask();const result=await runtime.tick();
      assert.ok(result.deliveries.some(d=>d.taskId===task.id&&d.result.outcome.kind==='API_ACCEPTED'&&d.result.settled));
      assert.equal(posts.filter(p=>p.recipient==='46700910005').length,1);}
    finally{telemetryThrows=false;}
  });

  for(const channel of channels)await t.test(`${channel}: standard window and bot policy are checked before recovery execution`,async()=>{
    language='en';fact='Parking is nearby.';resetSource(fact);stages=[];posts=[];configure();
    const recipient=String(46740000000+ ++serial);await inbound(channel,'Where can I park my car?',recipient,++serial,Date.now()-86401000);
    const task=latestTask();await runtime.tick();
    if(channel==='telegram')assert.equal(posts.filter(p=>p.recipient===recipient).length,1,'ordinary Telegram bot chats have no Meta 24-hour rule');
    else{assert.equal(posts.some(p=>p.recipient===recipient),false);assert.equal(pg.sql("SELECT count(*) FROM public.odin_outbox WHERE knowledge_task_id='"+task.id+"';"),'0');}
  });
  await t.test('signed recipient metadata cannot be changed into another customer or tenant',async()=>{
    language='en';fact='Parking is nearby.';resetSource(fact);stages=[];posts=[];configure();
    const recipient='46700910006';await inbound('instagram','Where can I park my car?',recipient);const task=latestTask();
    const scope:KnowledgeScope={businessId:77,channel:'instagram',providerAccount:accounts.instagram,conversationId:task.conversation_id};
    assert.equal(await runtime.bindings.resolve({...scope,businessId:88}),null);
    const meta=JSON.parse(pg.sql("SELECT aggregate_meta FROM public.odin_conversations WHERE id='"+task.conversation_id+"';"));
    const ordering=structuredClone(meta.knowledge_native_order_v2);meta.knowledge_native_recipient_v1.recipient='46700919999';
    pg.sql("UPDATE public.odin_conversations SET aggregate_meta='"+JSON.stringify(meta).replaceAll("'","''")+"'::jsonb WHERE id='"+task.conversation_id+"';");
    assert.equal(await runtime.bindings.resolve(scope),null);await runtime.tick();
    assert.equal(posts.some(p=>[recipient,'46700919999'].includes(p.recipient)),false);
    const retained=JSON.parse(pg.sql("SELECT aggregate_meta->'knowledge_native_order_v2' FROM public.odin_conversations WHERE id='"+task.conversation_id+"';"));
    assert.deepEqual(retained,ordering,'recipient validation must preserve ordered admission namespace');
  });
  await t.test('processing and delivery controls are independent and shutdown stops future work',async()=>{
    language='en';fact='Parking is nearby.';resetSource(fact);stages=[];posts=[];configure();const recipient='46700910007';
    await inbound('messenger','Where can I park my car?',recipient);const task=latestTask();
    controls={...controls,processing:false,delivery:false};await runtime.tick();assert.equal(stages.length,0);assert.equal(posts.length,0);
    controls={...controls,processing:true};await runtime.tick();assert.ok(stages.includes('verification'));assert.equal(posts.some(p=>p.recipient===recipient),false);
    assert.equal(pg.sql("SELECT knowledge_state FROM public.odin_outbox WHERE knowledge_task_id='"+task.id+"';"),'PENDING');
    controls={...controls,processing:false,delivery:true};const before=stages.length;await runtime.tick();assert.equal(stages.length,before);
    assert.equal(posts.filter(p=>p.recipient===recipient).length,1);await runtime.stop();assert.equal((await runtime.tick()).ran,false);
    controls={admission:true,processing:true,delivery:true,executionMs:40000};runtime=createRuntime();configure();
  });
  for(const fault of ['none','lost_prepare','lost_attach'])await t.test(`authorized foreground booking commits once despite ${fault}; duplicate ingress and Knowledge recovery cannot replay it`,async()=>{
    language='en';fact='Parking is nearby.';resetSource(fact);stages=[];posts=[];let mutations=0,rows=0;
    const channel:Channel='telegram',recipient=String(46700910008+['none','lost_prepare','lost_attach'].indexOf(fault)),events=new Map<string,any>();
    const originalRpc=pg.db.rpc;let injected=false;
    extra={calendarAdapter:{getCalendarId:()=> 'synthetic',getEvents:async()=>[...events.values()],getEventById:async(id:string)=>events.get(id)||null,
      checkSlots:async()=>assert.fail('No legacy booking slots'),insertAppointment:async(name:string,phone:string,_service:string,dateTime:string,duration=60)=>{
        mutations++;const event={id:'calendar-'+mutations,status:'confirmed',summary:`Booked: ${name} - ${phone}`,start:{dateTime},end:{dateTime:new Date(Date.parse(dateTime)+duration*60000).toISOString()},extendedProperties:{private:{platform:channel,userId:recipient}}};events.set(event.id,event);return {success:true,event};},
      cancelAppointment:async()=>assert.fail('No cancellation'),updateAppointment:async()=>assert.fail('No reschedule')},
      notifyBooking:async()=>true,recordAppointment:async(params:any)=>{rows++;return {id:rows,business_id:77,platform:channel,user_id:recipient,service:params.service,start_time:params.dateTime,end_time:new Date(Date.parse(params.dateTime)+3600000).toISOString(),status:'booked',created_at:new Date().toISOString()};}};
    try{
      configure();const session=`tg:77:${createHash('sha256').update(config.telegramToken).digest('hex').slice(0,12)}:${recipient}`;
      b.stateAuditConfig(session,config);
      const target=new Date(Date.now()+172800000);
      while ([0,6].includes(new Date(target.toLocaleString('en-US',{timeZone:'Europe/Stockholm'})).getDay())) target.setDate(target.getDate()+1);
      const day=target.toLocaleDateString('sv-SE',{timeZone:'Europe/Stockholm'});
      const offset=new Intl.DateTimeFormat('en-US',{timeZone:'Europe/Stockholm',timeZoneName:'shortOffset'}).formatToParts(new Date(day+'T12:00:00Z')).find(part=>part.type==='timeZoneName')?.value==='GMT+1'?'+01:00':'+02:00';
      const start=day+'T13:00:00'+offset,end=day+'T14:00:00'+offset;
      b.seedPending(session,{businessConfig:config,bookingStateVersion:CURRENT_BOOKING_STATE_VERSION,businessId:'77',platform:channel,userId:recipient,sessionId:session,
        operation:'new_booking',status:'awaiting_contact',expectedInput:'contact',service:'Video Consultation',durationMinutes:60,selectedDate:day,dateTime:start,selectedSlotEnd:end,language:'en',
        availabilityConstraint:{startDate:day,endDate:day,kind:'exact_time',exactTime:'13:00',rejectedTimes:[]},offeredSlots:[],
        ownedOfferedSlots:[{start,end,durationMinutes:60,service:'Video Consultation',businessId:'77',platform:channel,userId:recipient,generatedAt:Date.now()-120000,searchStartDate:day,searchEndDate:day}]});
      b.seedFlowLanguage(session,'en');const event=++serial;const at=Date.now()-30000;
      pg.db.rpc=async(name,args)=>{
        const result=await originalRpc(name,args);
        if(!injected && fault!=='none' && name==='odin_native_intake_v1' && args.p_event===String(event) &&
          args.p_command===(fault==='lost_prepare'?'prepare':'reconcile') && !result.error){
          injected=true;return {data:null,error:new Error('synthetic lost acknowledgement after commit')};
        }
        return result;
      };
      try{await inbound(channel,'Please book Video Consultation for me. My name is Ada Example and my phone number is 0701234567. Also where can I park my car?',recipient,event,at);}
      catch(error){if(fault==='none')throw error;}
      pg.db.rpc=originalRpc;
      assert.equal(mutations,1,JSON.stringify({state:b.pendingStateSnapshot(session)?.status,posts:posts.map(p=>p.text)}));assert.equal(rows,1);
      assert.equal(injected,fault!=='none');
      await inbound(channel,'Please book Video Consultation for me. My name is Ada Example and my phone number is 0701234567. Also where can I park my car?',recipient,event,at);
      await runtime.tick();assert.equal(mutations,1);assert.equal(rows,1);assert.equal(posts.filter(p=>p.recipient===recipient&&p.text===fact).length,1);
    }finally{pg.db.rpc=originalRpc;extra={};}
  });

  await t.test('shutdown during uncancellable extraction, database restart and lease takeover reject the stale worker',async()=>{
    language='en';fact='Parking is nearby.';resetSource(fact);stages=[];posts=[];configure();
    const recipient='46700910009';await inbound('messenger','Where can I park my car?',recipient);const task=latestTask();
    let release!:()=>void;let entered!:()=>void;extractionHold=new Promise<void>(resolve=>{release=resolve;});
    const ready=new Promise<void>(resolve=>{entered=resolve;});extractionEntered=entered;
    const old=runtime;const pending=old.tick().then(value=>({value}),error=>({error}));await ready;
    assert.equal(await old.stop(1000),true,'bounded cancellation releases the worker even when the provider ignores abort');
    pg.restart();pg.sql("UPDATE public.odin_tasks SET knowledge_lease_until=clock_timestamp()-interval '1 second',knowledge_available_at=clock_timestamp()-interval '1 second' WHERE id='"+task.id+"';");
    runtime=createRuntime();configure();await runtime.tick();release();await pending;extractionEntered=null;
    assert.equal(posts.filter(p=>p.recipient===recipient).length,1);
    const recovered=JSON.parse(pg.sql("SELECT to_jsonb(t) FROM public.odin_tasks t WHERE id='"+task.id+"';"));
    assert.equal(recovered.knowledge_expires_at,task.knowledge_expires_at);assert.equal(recovered.knowledge_run_attempts,2);
    assert.equal(recovered.knowledge_model_attempts,3);assert.equal(recovered.knowledge_state,'FINALIZED');
  });

});
