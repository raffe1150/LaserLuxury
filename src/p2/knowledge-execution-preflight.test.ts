import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeKnowledgeDatabase, FakeKnowledgeLifecycle } from '../../tests/helpers/fake-knowledge-lifecycle';
process.env.NODE_ENV='test';
const {executeDurableKnowledgeTask}=await import('../../server');
for(const reason of ['BUSINESS_SCOPE','EVIDENCE_FIRST_ROUTE','CANCELLED','TURN_CONTEXT'] as const){
  for(const throwing of [false,true])test(`real execution-entry ${reason}, telemetry throwing=${throwing}: null before any checkpoint/model work`,async t=>{
    const old=process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE;process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE=reason==='EVIDENCE_FIRST_ROUTE'?'false':'true';
    t.after(()=>{if(old===undefined)delete process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE;else process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE=old;});
    const repo=new FakeKnowledgeLifecycle(new FakeKnowledgeDatabase(),Date.now,async()=>true);
    const scope={businessId:77,channel:'whatsapp' as const,providerAccount:'account',conversationId:'conversation'};
    const accepted=await repo.accept(scope,'event',{question:'Where can I park?',language:'en',history:[]});
    const task=accepted.task!;const abort=new AbortController();if(reason==='CANCELLED')abort.abort();
    const events:any[]=[];t.mock.method(console,'info',(_label,event)=>{events.push(JSON.parse(event));if(throwing)throw Error('optional logger');});
    let currentCalls=0;
    const current=async()=>{currentCalls++;return false;};
    assert.equal(await executeDurableKnowledgeTask(task,{signal:abort.signal,expiresAt:task.expiresAt,
      checkpoint:async()=>assert.fail('No checkpoint'),reserveModelAttempt:async()=>assert.fail('No model')},
      {id:reason==='BUSINESS_SCOPE'?88:77,businessId:reason==='BUSINESS_SCOPE'?88:77},current),null);
    assert.equal(currentCalls,reason==='TURN_CONTEXT'?1:0);assert.equal(events.length,1);assert.equal(events[0].reason,reason);
    assert.equal(events[0].gate,'execution_entry');assert.equal(events[0].turnId,task.turnId);
  });
}
test('real execution-entry current-authority exception remains original exception',async t=>{
  const old=process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE;process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE='true';
  t.after(()=>{if(old===undefined)delete process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE;else process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE=old;});
  const repo=new FakeKnowledgeLifecycle(new FakeKnowledgeDatabase(),Date.now,async()=>true);
  const a=await repo.accept({businessId:77,channel:'whatsapp',providerAccount:'account',conversationId:'conversation'},'event',{question:'Where can I park?',language:'en',history:[]});
  const error=Error('original authority read failure');t.mock.method(console,'info',()=>assert.fail('No false-rejection event for throw'));
  await assert.rejects(executeDurableKnowledgeTask(a.task!,{signal:new AbortController().signal,expiresAt:a.task!.expiresAt,
    checkpoint:async()=>assert.fail('No checkpoint'),reserveModelAttempt:async()=>assert.fail('No model')},{id:77,businessId:77},async()=>{throw error;}),e=>e===error);
});
