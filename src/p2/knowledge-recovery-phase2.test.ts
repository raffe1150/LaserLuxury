import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DisposableNativeKnowledgeDatabase } from '../../tests/helpers/disposable-native-knowledge-db';
import { SupabaseOrderedKnowledgeRepository } from './supabase-ordered-knowledge-repository';
import { KnowledgeRunner, deliverKnowledge, type GuardedKnowledgeTransport } from './knowledge-runner';
import { KnowledgeWorkerCycle } from './knowledge-worker-cycle';
import { knowledgeOperation, knowledgeDatabaseRead, knowledgeExecutionDeadline } from './knowledge-operation';
import { DurableKnowledgeBudget } from './durable-knowledge-budget';
import { sendNativeKnowledge } from './native-knowledge-transport';
import type { KnowledgeScope, VerifiedKnowledge } from './knowledge-lifecycle';
import type { ResolvedChannelConnection } from '../channels/connections/contracts';
const verified:VerifiedKnowledge={protocol:'evidence-first-v2',independentlyVerified:true,completeRequiredFacts:true,
  text:'Parking nearby.',sources:[{id:'doc',revision:'v1'}]};
const never=()=>new Promise<never>(()=>{});
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

test('Phase 2: bounded durable recovery and factual settlement in disposable PostgreSQL',async t=>{
  const pg=new DisposableNativeKnowledgeDatabase();t.after(()=>pg.close());let serial=0,allowed=true,canonical=true;
  const repo=new SupabaseOrderedKnowledgeRepository(pg.db,s=>Promise.resolve(canonical?'canonical-'+s.conversationId:'revoked'),async()=>allowed);
  const fixture=async(final=false,executionMs=120000)=>{
    const scope:KnowledgeScope={businessId:77,conversationId:randomUUID(),channel:'telegram',providerAccount:'123456'};
    pg.sql("insert into public.odin_conversations(id,business_id,conversation_key) values('"+scope.conversationId+"',77,'canonical-"+scope.conversationId+"');");
    const a=await repo.acceptOrdered(scope,'event-'+ ++serial,{atMs:Math.floor((Date.now()-1000)/1000)*1000,sequence:serial},{question:'Parking?',language:'en',history:[]},{executionMs});
    const task=a.acceptance!.task!;
    if(!final)return {scope,task,delivery:null};
    const claimed=(await repo.claim(scope,task.id,'worker',15000))!;
    const token={taskId:task.id,owner:'worker',fence:claimed.fence};
    assert.equal(await repo.verified(scope,token,verified),true);
    const delivery=(await repo.finalize(scope,token))!;assert.ok(delivery);
    return {scope,task,delivery};
  };
  const state=(table:string,id:string)=>JSON.parse(pg.sql('select to_jsonb(t) from public.'+table+" t where id='"+id+"';"));
  const sending=async()=>{const f=await fixture(true);const d=(await repo.claimDelivery(f.scope,f.delivery!.id,'sender',15000))!;assert.ok(d);return {...f,token:{deliveryId:d.id,owner:'sender',fence:d.fence}};};

  await t.test('more than a discovery page of exhausted and leased tasks cannot hide newer work',async()=>{
    const blocked=[];for(let i=0;i<18;i++)blocked.push(await fixture());
    for(const [i,f]of blocked.entries())pg.sql("update public.odin_tasks set knowledge_run_attempts=knowledge_max_runs,knowledge_state='RUNNING',knowledge_owner='old',knowledge_fence=1,knowledge_lease_until=clock_timestamp()+interval '30 seconds' where id='"+f.task.id+"';");
    const fresh=await fixture();assert.ok((await repo.discoverWork()).some(w=>w.taskId===fresh.task.id));
    for(const f of blocked)pg.sql("update public.odin_tasks set knowledge_lease_until=clock_timestamp()-interval '1 second' where id='"+f.task.id+"';");
    assert.ok((await repo.discoverWork()).some(w=>w.taskId===fresh.task.id));await repo.discoverWork();
    for(const f of blocked)assert.equal(state('odin_tasks',f.task.id).knowledge_state,'FAILED');
    // Remove the remaining fresh fixture from subsequent delivery-only tests.
    const c=(await repo.claim(fresh.scope,fresh.task.id,'clean',15000))!;await repo.fail(fresh.scope,{taskId:c.id,owner:'clean',fence:c.fence});
  });
  await t.test('an independently locked conversation cannot fill a discovery page or block a later task',async()=>{
    const locked=await fixture(),fresh=await fixture();const release=await pg.holdConversation(locked.scope.conversationId);
    try {assert.equal((await repo.discoverWork(1))[0]?.taskId,fresh.task.id);}finally{await release();}
    for(const f of [locked,fresh]){const c=(await repo.claim(f.scope,f.task.id,'clean',15000))!;await repo.fail(f.scope,{taskId:c.id,owner:'clean',fence:c.fence});}
  });
  await t.test('expired rows terminalize without canonical credentials; rejected binding cannot poison the queue',async()=>{
    const f=await fixture();canonical=false;assert.equal(await repo.claim(f.scope,f.task.id,'worker',15000),null);canonical=true;
    assert.equal(state('odin_tasks',f.task.id).knowledge_state,'FAILED');
    const expired=await fixture();
    // Acceptance timestamps are immutable: expire by waiting on a short real acceptance instead.
    const short=await repo.acceptOrdered(expired.scope,'short-'+serial,{atMs:Math.floor(Date.now()/1000)*1000,sequence:serial+1000},{question:'Parking?',language:'en',history:[]},{executionMs:1000});
    await wait(1050);canonical=false;await repo.discoverWork();canonical=true;
    assert.equal(state('odin_tasks',short.acceptance!.task!.id).knowledge_state,'EXPIRED');
  });
  await t.test('interruption persists attempts, backoff and original expiry; restart takes a new fence',async()=>{
    const f=await fixture();const before=state('odin_tasks',f.task.id);
    await assert.rejects(new KnowledgeRunner(repo,async(_task,c)=>{await c.reserveModelAttempt();throw new Error('injected worker crash');},'old').run(f.scope,f.task.id),/injected worker crash/);
    let row=state('odin_tasks',f.task.id);assert.equal(row.knowledge_owner,null);assert.equal(row.knowledge_model_attempts,1);
    assert.equal(row.knowledge_expires_at,before.knowledge_expires_at);assert.ok(Date.parse(row.knowledge_available_at)>Date.now());
    assert.equal(await repo.claim(f.scope,f.task.id,'new',15000),null);
    pg.sql("update public.odin_tasks set knowledge_available_at=clock_timestamp()-interval '1 second' where id='"+f.task.id+"';");pg.restart();
    const delivery=await new KnowledgeRunner(repo,async(_task,c)=>{await c.reserveModelAttempt();return verified;},'new').run(f.scope,f.task.id);assert.ok(delivery);
    row=state('odin_tasks',f.task.id);assert.equal(row.knowledge_run_attempts,2);assert.equal(row.knowledge_model_attempts,2);assert.equal(row.knowledge_expires_at,before.knowledge_expires_at);
    assert.equal(await repo.verified(f.scope,{taskId:f.task.id,owner:'old',fence:1},verified),false);
    await repo.rejectDelivery(f.scope,f.task.id,delivery.id);
  });
  await t.test('a persisted VERIFIED result recovers without another provider call',async()=>{
    const f=await fixture();const c=(await repo.claim(f.scope,f.task.id,'old',15000))!;const token={taskId:c.id,owner:'old',fence:c.fence};
    await repo.reserveModelAttempt(f.scope,token);await repo.verified(f.scope,token,verified);await repo.interrupt(f.scope,token);
    pg.sql("update public.odin_tasks set knowledge_available_at=clock_timestamp()-interval '1 second' where id='"+f.task.id+"';");
    const d=await new KnowledgeRunner(repo,async()=>assert.fail('VERIFIED recovery must not infer'),'new').run(f.scope,f.task.id);assert.ok(d);
    assert.equal(state('odin_tasks',f.task.id).knowledge_model_attempts,1);await repo.rejectDelivery(f.scope,f.task.id,d.id);
  });
  await t.test('exhausted final outbox rows do not hide a newer delivery and reach terminal status',async()=>{
    const blocked=[];for(let i=0;i<17;i++)blocked.push(await fixture(true));
    for(const f of blocked)pg.sql("update public.odin_outbox set attempt_count=knowledge_max_attempts where id='"+f.delivery!.id+"';");
    const fresh=await fixture(true);assert.ok((await repo.discoverDeliveries()).some(w=>w.deliveryId===fresh.delivery!.id));await repo.discoverDeliveries();
    for(const f of blocked)assert.equal(state('odin_outbox',f.delivery!.id).knowledge_terminal_reason,'ATTEMPTS_EXHAUSTED');
    await repo.rejectDelivery(fresh.scope,fresh.task.id,fresh.delivery!.id);
  });
  await t.test('429 has a bounded due time; a later 5xx is quarantined and cannot resend',async()=>{
    const f=await sending();assert.equal(await repo.settleDelivery(f.scope,f.token,{kind:'DEFINITIVELY_UNSENT',retryable:true,retryAfterMs:6000}),true);
    const row=state('odin_outbox',f.token.deliveryId);assert.ok(Date.parse(row.available_at)>Date.now()+5000);
    assert.equal(await repo.claimDelivery(f.scope,f.token.deliveryId,'next',15000),null);
    pg.sql("update public.odin_outbox set available_at=clock_timestamp()-interval '1 second' where id='"+f.token.deliveryId+"';");
    const next=(await repo.claimDelivery(f.scope,f.token.deliveryId,'next',15000))!;
    await repo.settleDelivery(f.scope,{deliveryId:next.id,owner:'next',fence:next.fence},{kind:'AMBIGUOUS'});
    assert.equal(await repo.claimDelivery(f.scope,next.id,'third',15000),null);assert.equal(state('odin_outbox',next.id).knowledge_state,'UNCERTAIN');
  });
  await t.test('expired SENDING survives restart as UNCERTAIN; only exact late positive receipt may settle',async()=>{
    const f=await sending();pg.sql("update public.odin_outbox set knowledge_lease_until=clock_timestamp()-interval '1 second' where id='"+f.token.deliveryId+"';");pg.restart();
    canonical=false;await repo.discoverDeliveries();canonical=true;
    assert.equal(state('odin_outbox',f.token.deliveryId).knowledge_state,'UNCERTAIN');assert.equal(await repo.claimDelivery(f.scope,f.token.deliveryId,'next',15000),null);
    assert.equal(await repo.settleDelivery(f.scope,{...f.token,owner:'forged'},{kind:'API_ACCEPTED',providerMessageId:'late-123'}),false);
    assert.equal(await repo.settleDelivery({...f.scope,businessId:88},f.token,{kind:'API_ACCEPTED',providerMessageId:'late-123'}),false);
    assert.equal(await repo.settleDelivery(f.scope,{...f.token,fence:f.token.fence+1},{kind:'API_ACCEPTED',providerMessageId:'late-123'}),false);
    canonical=false;assert.equal(await repo.settleDelivery(f.scope,f.token,{kind:'API_ACCEPTED',providerMessageId:'late-123'}),true);canonical=true;
    assert.equal(state('odin_outbox',f.token.deliveryId).knowledge_state,'SENT');
    assert.equal(await repo.settleDelivery(f.scope,f.token,{kind:'AMBIGUOUS'}),false);
    assert.equal(await repo.settleDelivery(f.scope,f.token,{kind:'API_ACCEPTED',providerMessageId:'late-123'}),true);
  });
  await t.test('late unsent proof cannot reopen quarantine; supersession does not suppress factual positive settlement',async()=>{
    const f=await sending();await repo.settleDelivery(f.scope,f.token,{kind:'AMBIGUOUS'});
    assert.equal(await repo.settleDelivery(f.scope,f.token,{kind:'DEFINITIVELY_UNSENT',retryable:true}),true);
    assert.equal(state('odin_outbox',f.token.deliveryId).knowledge_terminal_reason,'LATE_UNSENT');assert.equal(await repo.claimDelivery(f.scope,f.token.deliveryId,'next',15000),null);
    const g=await sending();await repo.acceptOrdered(g.scope,'newer-'+ ++serial,{atMs:Math.floor(Date.now()/1000)*1000,sequence:serial+10000});
    assert.equal(await repo.settleDelivery(g.scope,g.token,{kind:'API_ACCEPTED',providerMessageId:'accepted-before-new-turn'}),true);
    assert.equal(state('odin_outbox',g.token.deliveryId).knowledge_state,'SENT');
  });
  const transport:GuardedKnowledgeTransport={authorize:async()=>true,resolve:async task=>({recipient:'7000',channel:task.scope.channel,providerAccount:task.scope.providerAccount}),eligible:async()=>true,
    send:async()=>({kind:'API_ACCEPTED',providerMessageId:'accepted-123'})};
  await t.test('API acceptance with unavailable settlement is visible and never authorizes another POST',async()=>{
    const f=await fixture(true);let posts=0;const settle=repo.settleDelivery.bind(repo);
    repo.settleDelivery=async()=>{throw new Error('database unavailable');};
    try{const r=await deliverKnowledge(repo,{...transport,send:async(...args)=>{posts++;return transport.send(...args);}},f.scope,f.task.id,f.delivery!.id,'sender');
      assert.equal(r!.outcome.kind,'API_ACCEPTED');assert.equal(r!.settled,false);
    }finally{repo.settleDelivery=settle;}
    assert.equal(posts,1);assert.equal(await repo.claimDelivery(f.scope,f.delivery!.id,'other',15000),null);
    pg.sql("update public.odin_outbox set knowledge_lease_until=clock_timestamp()-interval '1 second' where id='"+f.delivery!.id+"';");await repo.discoverDeliveries();
    assert.equal(state('odin_outbox',f.delivery!.id).knowledge_state,'UNCERTAIN');
  });
  await t.test('committed settlement with lost acknowledgement remains SENT and cannot send twice',async()=>{
    const f=await fixture(true);const original=repo.settleDelivery.bind(repo);let posts=0;
    repo.settleDelivery=async(...args)=>{assert.equal(await original(...args),true);throw new Error('committed response lost');};
    try {const r=await deliverKnowledge(repo,{...transport,send:async(...args)=>{posts++;return transport.send(...args);}},f.scope,f.task.id,f.delivery!.id,'sender');
      assert.equal(r!.outcome.kind,'API_ACCEPTED');assert.equal(r!.settled,false);
    }finally{repo.settleDelivery=original;}
    assert.equal(state('odin_outbox',f.delivery!.id).knowledge_state,'SENT');
    await deliverKnowledge(repo,{...transport,send:async()=>assert.fail('No duplicate POST')},f.scope,f.task.id,f.delivery!.id,'other');assert.equal(posts,1);
  });
  await t.test('positive provider acknowledgement can settle after the immutable task expiry',async()=>{
    const f=await fixture(true,1000);const d=(await repo.claimDelivery(f.scope,f.delivery!.id,'sender',15000))!;assert.ok(d);
    await wait(1050);await repo.discoverDeliveries();
    assert.equal(state('odin_outbox',d.id).knowledge_state,'UNCERTAIN');
    assert.equal(await repo.settleDelivery(f.scope,{deliveryId:d.id,owner:'sender',fence:d.fence},{kind:'API_ACCEPTED',providerMessageId:'late-after-expiry'}),true);
    assert.equal(state('odin_outbox',d.id).knowledge_state,'SENT');
  });
  await t.test('repeated preflight exceptions terminate without claiming or sending; explicit source denial is terminal',async()=>{
    const f=await fixture(true);
    for(let i=0;i<3;i++)await assert.rejects(deliverKnowledge(repo,{...transport,authorize:async()=>{throw new Error('source storage unavailable');}},f.scope,f.task.id,f.delivery!.id,'sender'),/source storage unavailable/);
    assert.equal(state('odin_outbox',f.delivery!.id).knowledge_terminal_reason,'PREFLIGHT_EXHAUSTED');assert.equal(state('odin_outbox',f.delivery!.id).attempt_count,0);
    const g=await fixture(true);allowed=false;
    try{const r=await deliverKnowledge(repo,{...transport,authorize:async()=>false},g.scope,g.task.id,g.delivery!.id,'sender');assert.equal(r,null);}finally{allowed=true;}
    assert.equal(state('odin_outbox',g.delivery!.id).knowledge_terminal_reason,'AUTHORITY_REJECTED');
  });
  await t.test('a failed delivery preflight does not prevent the next discovered delivery from settling',async()=>{
    const bad=await fixture(true),good=await fixture(true);
    const cycle=new KnowledgeWorkerCycle(repo,new KnowledgeRunner(repo,async()=>assert.fail('Processing disabled'),'worker'),
      {...transport,resolve:async task=>{if(task.id===bad.task.id)throw new Error('one broken preflight');return transport.resolve(task);}},'sender',{processing:()=>false,delivery:()=>true});
    await assert.rejects(cycle.tick(),/one broken preflight/);cycle.stop();
    assert.equal(state('odin_outbox',bad.delivery!.id).knowledge_preflight_attempts,1);
    assert.equal(state('odin_outbox',good.delivery!.id).knowledge_state,'SENT');await repo.rejectDelivery(bad.scope,bad.task.id,bad.delivery!.id);
  });
  await t.test('new recovery RPCs stay service-only and use invoker rights; phase dependency is explicit',async()=>{
    for(const role of ['anon','authenticated'])assert.equal(pg.sql("select bool_and(not has_function_privilege('"+role+"',oid,'EXECUTE')) from pg_proc where proname in ('odin_discover_knowledge_v2','odin_transition_knowledge_v2');"),'t');
    const draft=readFileSync('docs/designs/async-recovery-phase2/recovery-and-settlement.sql.draft','utf8');
    assert.throws(()=>pg.sql("BEGIN; ALTER FUNCTION public.odin_native_intake_v1(bigint,uuid,text,text,text,text,jsonb,text,uuid,text,jsonb,integer) RENAME TO hidden_intake;\n"+draft.match(/do \$\$[\s\S]*?end \$\$;/)![0]),/phase1_intake_required/);
    assert.equal(pg.sql("select bool_and(not prosecdef) from pg_proc where proname in ('odin_discover_knowledge_v2','odin_transition_knowledge_v2');"),'t');
  });
});

test('database reads abort stalled adapters and release logical capacity',async()=>{
  let observed:AbortSignal|undefined;
  await assert.rejects(knowledgeOperation(()=>knowledgeDatabaseRead({abortSignal:(s:AbortSignal)=>{observed=s;return never();}}),{timeoutMs:30}),/knowledge_operation_stopped/);
  assert.equal(observed!.aborted,true);
});
test('cycle discovery stalls are bounded; a later tick is allowed',async()=>{
  let stalled=true;const repo:any={discoverWork:()=>stalled?never():Promise.resolve([]),discoverDeliveries:async()=>[]};
  const runner=new KnowledgeRunner(repo,async()=>null,'worker');const cycle=new KnowledgeWorkerCycle(repo,runner,{} as any,'sender');
  await assert.rejects(knowledgeOperation(()=>cycle.tick(),{timeoutMs:30}),/knowledge_operation_stopped/);await wait(0);stalled=false;
  assert.equal((await cycle.tick()).ran,true);cycle.stop();
});
test('claim, renewal and cancellation stalls release worker capacity and forbid late reservations',async()=>{
  let lateContext:any,renewed!:()=>void;const ready=new Promise<void>(r=>{renewed=r;});
  const task:any={id:'task',turnId:'turn',scope:{channel:'telegram'},acceptedAt:Date.now(),expiresAt:Date.now()+40000,state:'RUNNING',fence:1,runAttempts:1};
  let reserve=0;const repo:any={claim:async()=>task,renew:()=>{renewed();return never();},interrupt:async()=>true,reserveModelAttempt:async()=>{reserve++;return true;}};
  const runner=new KnowledgeRunner(repo,async(_task,c)=>{lateContext=c;return never();},'worker',1,undefined,30);
  const pending=knowledgeOperation(()=>runner.run({businessId:77,channel:'telegram',providerAccount:'account',conversationId:'conv'},'task'),{timeoutMs:80});await ready;
  await assert.rejects(pending,/knowledge_operation_stopped/);await wait(0);repo.claim=never;await assert.rejects(knowledgeOperation(()=>runner.run({businessId:77,channel:'telegram',providerAccount:'account',conversationId:'conv'},'other'),{timeoutMs:30}),/knowledge_operation_stopped/);
  runner.stop();await assert.rejects(lateContext.reserveModelAttempt(),/knowledge_runner_stopped/);assert.equal(reserve,0);
});
test('40-second candidate keeps a fixed expiry and reserves 15 seconds; foreground deadline stays 20 seconds',async()=>{
  const task:any={acceptedAt:Date.now(),expiresAt:Date.now()+40000,modelAttempts:0};assert.equal(knowledgeExecutionDeadline(task),task.expiresAt-15000);
  const b=new DurableKnowledgeBudget(task,new AbortController().signal,async()=>{});assert.equal(b.deadlineAt,task.expiresAt);assert.ok(b.remaining()<=25000);
  const {InformationBudget}=await import('../ai/business-information-answer-plan');const fg=new InformationBudget();assert.equal(fg.deadlineAt-fg.startedAt,20000);
});
test('raw provider timeout remains ambiguous; Retry-After is bounded without a second request',async()=>{
  const c:ResolvedChannelConnection={id:'synthetic',businessId:77,provider:'telegram',providerAccountId:'123456',providerConnectionId:null,tokenExpiresAt:null,grantedScopes:[],status:'connected',connectedAt:null,lastVerifiedAt:null,reconnectRequired:false,displayName:null,source:'self_service',credential:{accessToken:'synthetic'},metadata:{}};
  let calls=0;const abort=new AbortController();setTimeout(()=>abort.abort(),20);
  const outcome=await sendNativeKnowledge(c,'7000','Answer',abort.signal,async()=>{calls++;return never();});assert.equal(outcome.kind,'AMBIGUOUS');assert.equal(calls,1);
  const retry=await sendNativeKnowledge(c,'7000','Answer',new AbortController().signal,async()=>{calls++;return new Response(JSON.stringify({ok:false,error_code:429,parameters:{retry_after:120}}),{status:429});});
  assert.deepEqual(retry,{kind:'DEFINITIVELY_UNSENT',retryable:false});assert.equal(calls,2);
});

test('lease loss stops uncancellable execution without persisting or finalizing its late result',async()=>{
  let release!:(v:VerifiedKnowledge)=>void;let writes=0;
  const task:any={id:'task',turnId:'turn',scope:{channel:'telegram'},acceptedAt:Date.now(),expiresAt:Date.now()+40000,state:'RUNNING',fence:1,runAttempts:1};
  const repo:any={claim:async()=>task,renew:async()=>false,interrupt:async()=>false,verified:async()=>{writes++;return true;},finalize:async()=>{writes++;return null;}};
  const runner=new KnowledgeRunner(repo,async()=>new Promise<VerifiedKnowledge>(r=>{release=r;}),'worker',1,undefined,30);
  await assert.rejects(runner.run({businessId:77,channel:'telegram',providerAccount:'account',conversationId:'conv'},'task'),/knowledge_operation_stopped/);
  release(verified);await wait(0);assert.equal(writes,0);runner.stop();
});
test('received factual outcomes survive a clock crossing; ordinary results still fail their deadline',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  await assert.rejects(knowledgeOperation(async()=>{now+=100;return 'ordinary';},{timeoutMs:50}),/knowledge_operation_stopped/);
  assert.equal(await knowledgeOperation(async()=>{now+=100;return 'factual';},{timeoutMs:50,factualResult:true}),'factual');
});

test('a stalled settlement returns a visible failure within its independent database bound',async()=>{
  const scope:KnowledgeScope={businessId:77,channel:'telegram',providerAccount:'account',conversationId:'conv'};
  const task:any={id:'task',turnId:'turn',scope,acceptedAt:Date.now(),expiresAt:Date.now()+40000,state:'FINALIZED',result:verified};
  const delivery:any={id:'delivery',taskId:'task',kind:'final',text:verified.text,fence:1,attempts:1,lease:{until:Date.now()+15000}};
  const repo:any={get:async()=>task,claimDelivery:async()=>delivery,settleDelivery:never};let posts=0;const events:any[]=[];const start=performance.now();
  const r=await deliverKnowledge(repo,{authorize:async()=>true,resolve:async()=>({recipient:'7000',channel:'telegram',providerAccount:'account'}),eligible:async()=>true,
    send:async()=>{posts++;return {kind:'API_ACCEPTED',providerMessageId:'received'};}},scope,'task','delivery','sender',e=>events.push(e));
  assert.ok(performance.now()-start<3800);assert.equal(r!.settled,false);assert.equal(r!.outcome.kind,'API_ACCEPTED');assert.equal(posts,1);
  assert.ok(events.some(e=>e.stage==='settlement_failed'&&e.customerDelivery==='UNCONFIRMED'));
});
