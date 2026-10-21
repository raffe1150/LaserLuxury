import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DisposableNativeKnowledgeDatabase } from '../../tests/helpers/disposable-native-knowledge-db';
import { NativeKnowledgeRuntime } from './native-knowledge-runtime';
import { NativeIntakeAcknowledgement } from './native-intake-acknowledgement';
import { TelegramPollerLease } from './telegram-poller-lease';
import type { ResolvedChannelConnection } from '../channels/connections/contracts';

test('Phase 1: durable intake, attachment recovery and fenced polling in isolated PostgreSQL',async t=>{
  const pg=new DisposableNativeKnowledgeDatabase();t.after(()=>pg.close());
  const connection:ResolvedChannelConnection={id:'connection',businessId:77,provider:'telegram',providerAccountId:'123456',
    providerConnectionId:null,tokenExpiresAt:null,grantedScopes:[],status:'connected',connectedAt:null,lastVerifiedAt:null,
    reconnectRequired:false,displayName:null,source:'self_service',credential:{accessToken:'123456:synthetic'},metadata:{}};
  const options={db:pg.db,secret:'synthetic-intake-secret-at-least-32-bytes',
    controls:()=>({admission:true,processing:false,delivery:false,executionMs:40000}),
    connections:async(b:number)=>b===77?connection:null,
    execute:async()=>assert.fail('Intake must not execute a model or action'),
    fetcher:async()=>assert.fail('Intake must not contact a provider')};
  let runtime=new NativeKnowledgeRuntime(options);t.after(()=>runtime.stop());
  let serial=0;
  const ingress=()=>({businessId:77,channel:'telegram' as const,account:'123456',recipient:String(7000+ ++serial),eventId:'event-'+serial,
    order:{atMs:Math.floor((Date.now()-10000)/1000)*1000,sequence:serial}});
  const input={question:'Where can I park?',language:'en',history:[{role:'user' as const,content:'I am visiting the studio.'}]};
  const taskCount=()=>Number(pg.sql('select count(*) from public.odin_tasks;'));
  const mutate=pg.db.rpc;
  const loseResponse=(command:string)=>{
    let lost=false;
    pg.db.rpc=async(name,args)=>{
      const result=await mutate(name,args);
      if(!lost && name==='odin_native_intake_v1' && args.p_command===command && !result.error){lost=true;return {data:null,error:new Error('synthetic lost response')};}
      return result;
    };
  };
  t.after(()=>{pg.db.rpc=mutate;});

  await t.test('before successful acknowledgement, routing input is durable but cannot execute or replay actions',async()=>{
    const event=ingress();const a=(await runtime.beginIntake(event,'Book a visit and tell me about parking'))!;
    assert.equal(a.run,true);const before=taskCount();
    assert.equal(pg.sql("select knowledge_intake_state from public.odin_inbox where provider_event_id='"+event.eventId+"';"),'ROUTING');
    await assert.rejects(runtime.beginIntake(event,'changed duplicate'),/still_routing/);
    await runtime.repository.recoverIntakes();assert.equal(taskCount(),before);
    await runtime.finishIntake(a.admission); // Existing foreground explicitly completed without a Knowledge handoff.
    assert.equal((await runtime.beginIntake(event,'duplicate'))!.run,false);
  });
  await t.test('crash between prepared admission and task attachment recovers exact frozen input after database restart',async()=>{
    const event=ingress();const a=(await runtime.beginIntake(event,'Parking?'))!;const before=taskCount();
    await runtime.repository.intake(a.admission.scope,event.eventId,event.order,'prepare',a.admission.intakeOwner!,'',input);
    assert.equal(taskCount(),before);await runtime.stop();pg.restart();runtime=new NativeKnowledgeRuntime(options);
    await runtime.repository.recoverIntakes();assert.equal(taskCount(),before+1);
    assert.deepEqual(JSON.parse(pg.sql("select payload from public.odin_tasks where knowledge_inbox_id=(select id from public.odin_inbox where provider_event_id='"+event.eventId+"');")),input);
    assert.equal((await runtime.beginIntake(event,'different question'))!.run,false);
    await runtime.repository.recoverIntakes();assert.equal(taskCount(),before+1);
  });
  await t.test('committed preparation with lost acknowledgement remains recoverable, never completed as foreground',async()=>{
    const event=ingress();const a=(await runtime.beginIntake(event,'Parking?'))!;const before=taskCount();loseResponse('prepare');
    await assert.rejects(runtime.attach(a.admission,input),/repository_operation_failed/);pg.db.rpc=mutate;
    assert.equal(pg.sql("select knowledge_intake_state from public.odin_inbox where provider_event_id='"+event.eventId+"';"),'PREPARED');
    const other=new NativeKnowledgeRuntime(options);try{
      assert.equal((await other.beginIntake(event,'duplicate'))!.run,false);assert.equal(taskCount(),before+1);
    }finally{await other.stop();}
  });
  await t.test('committed task attachment with lost acknowledgement and repeated events creates one task',async()=>{
    const event=ingress();const a=(await runtime.beginIntake(event,'Parking?'))!;const before=taskCount();loseResponse('reconcile');
    await assert.rejects(runtime.attach(a.admission,input),/repository_operation_failed/);pg.db.rpc=mutate;
    const second=new NativeKnowledgeRuntime(options);try{
      const results=await Promise.all([runtime.beginIntake(event,'duplicate'),second.beginIntake(event,'duplicate')]);
      assert.ok(results.every(r=>r?.run===false));assert.equal(taskCount(),before+1);
    }finally{await second.stop();}
  });
  await t.test('wrong owner, modified prepared input and recipient/tenant substitution cannot attach',async()=>{
    const event=ingress();const a=(await runtime.beginIntake(event,'Parking?'))!;
    await assert.rejects(runtime.repository.intake(a.admission.scope,event.eventId,event.order,'prepare',randomUUID(),'',input));
    await runtime.repository.intake(a.admission.scope,event.eventId,event.order,'prepare',a.admission.intakeOwner!,'',input);
    await assert.rejects(runtime.attach(a.admission,{...input,question:'Changed'}));
    await assert.rejects(runtime.beginIntake({...event,order:{...event.order,atMs:event.order.atMs+1000}},'Changed event time'));
    await assert.rejects(runtime.beginIntake({...event,recipient:'9999'},'Parking?'));
    await assert.rejects(runtime.beginIntake({...event,businessId:88},'Parking?'));
    await runtime.repository.recoverIntakes();
  });
  await t.test('newer conversation fence terminalizes unfinished handoff without replay',async()=>{
    const event=ingress();const a=(await runtime.beginIntake(event,'Parking?'))!;const before=taskCount();
    await runtime.repository.intake(a.admission.scope,event.eventId,event.order,'prepare',a.admission.intakeOwner!,'',input);
    const newer={...event,eventId:event.eventId+'-new',order:{...event.order,sequence:event.order.sequence+1}};
    const b=(await runtime.beginIntake(newer,'Different topic'))!;await runtime.finishIntake(b.admission);
    await runtime.repository.recoverIntakes();assert.equal(taskCount(),before);
    assert.equal(pg.sql("select knowledge_intake_reason from public.odin_inbox where provider_event_id='"+event.eventId+"';"),'SUPERSEDED');
  });
  await t.test('lost begin response and interrupted routing expire explicitly, never dispatch raw mixed input',async()=>{
    const short=new NativeKnowledgeRuntime({...options,controls:()=>({...options.controls(),executionMs:1000})});
    try {
      const event=ingress();const before=taskCount();loseResponse('begin');
      await assert.rejects(short.beginIntake(event,'Cancel my booking and where can I park?'));pg.db.rpc=mutate;
      await assert.rejects(short.beginIntake(event,'duplicate'),/still_routing/);
      await new Promise(resolve=>setTimeout(resolve,1100));await short.repository.recoverIntakes();
      assert.equal((await short.beginIntake(event,'duplicate'))!.run,false);assert.equal(taskCount(),before);
      assert.equal(pg.sql("select knowledge_intake_reason from public.odin_inbox where provider_event_id='"+event.eventId+"';"),'ROUTING_INTERRUPTED');
    }finally{await short.stop();}
  });
  await t.test('two pollers share one durable cursor; takeover fences old renewals, release and commits',async()=>{
    const first=new TelegramPollerLease(pg.db,77,'123456',randomUUID());const next=new TelegramPollerLease(pg.db,77,'123456',randomUUID());
    try {
      assert.equal(await first.acquire(),true);assert.equal(await next.acquire(),false);
      await first.commit(101);assert.equal(first.lastUpdateId,101);
      pg.sql("update public.odin_telegram_pollers set lease_until=clock_timestamp()-interval '1 second' where bot_id='123456';");
      assert.equal(await next.acquire(),true);assert.equal(next.lastUpdateId,101);
      await assert.rejects(first.commit(102));await assert.rejects(first.current());await first.stop();
      await next.current();assert.equal(next.lastUpdateId,101);await next.commit(102);
      assert.equal(pg.sql("select last_update_id from public.odin_telegram_pollers where bot_id='123456';"),'102');
      const foreign=new TelegramPollerLease(pg.db,88,'123456',randomUUID());try{assert.equal(await foreign.acquire(),false);}finally{await foreign.stop();}
    }finally{await first.stop();await next.stop();}
  });
  await t.test('uncertain cursor commit stops local owner; successor recovers committed offset',async()=>{
    const first=new TelegramPollerLease(pg.db,77,'222222',randomUUID());const next=new TelegramPollerLease(pg.db,77,'222222',randomUUID());
    try {
      await first.acquire();let once=true;
      pg.db.rpc=async(name,args)=>{const result=await mutate(name,args);if(once && name==='odin_telegram_poller_v1'&&args.p_command==='commit'){
        once=false;return {data:null,error:new Error('lost cursor acknowledgement')};}return result;};
      await assert.rejects(first.commit(50));assert.equal(first.controller.signal.aborted,true);assert.equal(first.lastUpdateId,-1);
      pg.db.rpc=mutate;await first.stop();assert.equal(await next.acquire(),true);assert.equal(next.lastUpdateId,50);
    }finally{pg.db.rpc=mutate;await first.stop();await next.stop();}
  });
  await t.test('deployment takeover during prepared processing cannot acknowledge early or replay the foreground branch',async()=>{
    const first=new TelegramPollerLease(pg.db,77,'123456',randomUUID());const next=new TelegramPollerLease(pg.db,77,'123456',randomUUID());
    const event={...ingress(),eventId:'103',order:{atMs:Math.floor((Date.now()-10000)/1000)*1000,sequence:103}};
    let release!:()=>void,entered!:()=>void,foreground=0;
    const waiting=new Promise<void>(resolve=>{release=resolve;});const ready=new Promise<void>(resolve=>{entered=resolve;});
    try {
      await first.acquire();assert.equal(first.lastUpdateId,102);
      const processing=first.dispose(103,async()=>{
        const a=(await runtime.beginIntake(event,'Book a visit and where can I park?'))!;assert.equal(a.run,true);foreground++;
        await runtime.repository.intake(a.admission.scope,event.eventId,event.order,'prepare',a.admission.intakeOwner!,'',input);
        entered();await waiting;return true;
      }).then(()=>null,error=>error);
      await ready;
      assert.equal(pg.sql("SELECT last_update_id FROM public.odin_telegram_pollers WHERE bot_id='123456';"),'102');
      pg.sql("UPDATE public.odin_telegram_pollers SET lease_until=clock_timestamp()-interval '1 second' WHERE bot_id='123456';");
      assert.equal(await next.acquire(),true);assert.equal(next.lastUpdateId,102);
      release();assert.ok(await processing);
      await next.dispose(103,async()=>{const a=(await runtime.beginIntake(event,'duplicate'))!;assert.equal(a.run,false);return true;});
      assert.equal(foreground,1);assert.equal(next.lastUpdateId,103);
      assert.equal(pg.sql("SELECT count(*) FROM public.odin_tasks WHERE knowledge_inbox_id=(SELECT id FROM public.odin_inbox WHERE provider_event_id='103');"),'1');
      await assert.rejects(next.dispose(104,async()=>false),/intake_unfinished/);assert.equal(next.lastUpdateId,103);
      await assert.rejects(next.dispose(104,async()=>{throw new Error('interrupted processing');}),/interrupted processing/);
      assert.equal(pg.sql("SELECT last_update_id FROM public.odin_telegram_pollers WHERE bot_id='123456';"),'103');
    }finally{release?.();await first.stop();await next.stop();}
  });
  await t.test('an idle bot reads without its historical offset before acknowledging a lower Telegram update-ID epoch',async()=>{
    const first=new TelegramPollerLease(pg.db,77,'444444',randomUUID());const next=new TelegramPollerLease(pg.db,77,'444444',randomUUID());
    try {
      await first.acquire();await first.dispose(9000,async()=>true);await first.stop();
      pg.sql("UPDATE public.odin_telegram_pollers SET last_update_at=clock_timestamp()-interval '8 days' WHERE bot_id='444444';");
      await next.acquire();assert.equal(next.lastUpdateId,9000);assert.equal(next.nextOffset,0);
      await assert.rejects(next.dispose(10,async()=>false));assert.equal(next.nextOffset,0);
      assert.equal(pg.sql("SELECT last_update_id FROM public.odin_telegram_pollers WHERE bot_id='444444';"),'9000');
      await next.dispose(10,async()=>true);assert.equal(next.lastUpdateId,10);assert.equal(next.nextOffset,11);
    }finally{await first.stop();await next.stop();}
  });
  await t.test('new RPCs and poller rows remain service-only with invoker execution',async()=>{
    for(const role of ['anon','authenticated']){
      assert.equal(pg.sql("select has_table_privilege('"+role+"','public.odin_telegram_pollers','SELECT');"),'f');
      assert.equal(pg.sql("select bool_and(not has_function_privilege('"+role+"',oid,'EXECUTE')) from pg_proc where proname in ('odin_native_intake_v1','odin_recover_native_intakes_v1','odin_telegram_poller_v1');"),'t');
    }
    assert.equal(pg.sql("select bool_and(not prosecdef) from pg_proc where proname in ('odin_native_intake_v1','odin_recover_native_intakes_v1','odin_telegram_poller_v1');"),'t');
  });
});

test('native acknowledgement waits for durable disposition and returns retryable failure on interruption',async()=>{
  const statuses:number[]=[];const response={status:(code:number)=>({send:()=>statuses.push(code)})};
  let release!:(v:boolean)=>void;const pending=new Promise<boolean>(resolve=>{release=resolve;});
  const ack=new NativeIntakeAcknowledgement(true,response);ack.acknowledge();ack.track(pending,()=>{});
  const completed=ack.complete();await Promise.resolve();assert.deepEqual(statuses,[]);
  release(true);await completed;assert.deepEqual(statuses,[200]);
  const interrupted=new NativeIntakeAcknowledgement(true,response);interrupted.track(Promise.reject(new Error('crash before disposition')),()=>{});
  await interrupted.complete();assert.deepEqual(statuses,[200,503]);
  const duplicateActive=new NativeIntakeAcknowledgement(true,response);duplicateActive.track(Promise.resolve(false),()=>{});
  await duplicateActive.complete();assert.equal(statuses.at(-1),503);
});
