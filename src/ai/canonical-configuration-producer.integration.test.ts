/** No fabricated verifier acceptance. Valid extraction is inspected at the real
 * adapter boundary, then verification is withheld; publication must fail closed. */
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {incidentConfig,incidentFlags,incidentInbound,incidentChannels,interceptedIncidentSend} from '../../tests/helpers/p0-incident-knowledge';
import {CANONICAL_CONFIG_PRODUCER,CANONICAL_CONFIG_SCHEMA} from './canonical-configuration-propositions';
import {SOURCE_EXHAUSTIVE_V2_INSTRUCTION} from './source-exhaustive-coverage';
import {publishableKnowledgeManifest} from './business-information-answer-plan';
const incident=JSON.parse(readFileSync(new URL('../../tests/fixtures/genuine-luna-cancellation-coverage-20261102.json',import.meta.url),'utf8'));
const attribution=JSON.parse(readFileSync(new URL('../../tests/fixtures/genuine-luna-canonical-attribution-20261102.json',import.meta.url),'utf8'));
const genuine=JSON.parse(readFileSync(new URL('../../tests/fixtures/genuine-luna-u2-contradiction-20261102.json',import.meta.url),'utf8'));
incidentFlags();Object.assign(process.env,{ODINLINK_KNOWLEDGE_TIMING_POLICY:'accuracy-first-v1',ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS:'77',
 ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL:'source-exhaustive-v2',ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL:'v2',ODINLINK_KNOWLEDGE_CONFIG_PROPOSITIONS:CANONICAL_CONFIG_PRODUCER});
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
const records:any[]=[];
after(()=>{if(process.env.ODINLINK_CANONICAL_CONFIG_RECEIPTS)writeFileSync(process.env.ODINLINK_CANONICAL_CONFIG_RECEIPTS,
 JSON.stringify({mode:'OFFLINE_PRODUCER_ADMISSION_AND_WITHHELD_VERIFICATION_NO_POSITIVE_CERTIFICATE',providerRequests:0,records},null,2),{mode:0o600});});
const specs=[
 ['en',incident.frozen.question,'Automatic appointment cancellation through chat is enabled.','The optional late cancellation fee is disabled.'],
 ['sv','Vad är er avbokningspolicy, och hur långt i förväg måste jag avboka min tid?','Automatisk avbokning av tider via chatt är aktiverad.','Den valfria avgiften för sen avbokning är inaktiverad.'],
 ['de','Was ist Ihre Stornierungsrichtlinie und wie weit im Voraus muss ich meinen Termin stornieren?','Die automatische Terminabsage per Chat ist aktiviert.','Die optionale Gebühr für eine verspätete Stornierung ist deaktiviert.'],
 ['es','¿Cuál es su política de cancelación y con cuánta antelación debo cancelar mi cita?','La cancelación automática de citas por chat está habilitada.','El cargo opcional por cancelación tardía está desactivado.'],
 ['fa','سیاست لغو شما چیست و چند ساعت قبل باید نوبت را لغو کنم؟','لغو خودکار نوبت از طریق چت فعال است.','هزینه اختیاری لغو دیرهنگام غیرفعال است.'],
 ['ar','ما هي سياسة الإلغاء لديكم وكم ساعة قبل الموعد يجب إلغاء الحجز؟','إلغاء المواعيد تلقائياً عبر الدردشة مفعّل.','رسوم الإلغاء المتأخر الاختيارية معطّلة.'],
];
function setup(t:any,spec=specs[0],fault='none'){
 for(const m of ['log','info','warn','error'])t.mock.method(console,m,()=>{});b.reset();
 const saved=structuredClone(incidentConfig),row=structuredClone(incident.frozen.rawCancellationSettings),normalized=b.promptAuditNormalize(row);
 const stages:string[]=[],inputs:any[]=[],answers:string[]=[];let actions=0,changed=false,feeChanged=false;
 const forbidden=async()=>{actions++;throw Error('OFFLINE_ACTION_FORBIDDEN');};
 const missingFee=()=>{const x=structuredClone(row);delete x.cancellation_fee_enabled;delete x.cancellationFeeEnabled;return x;};
 Object.assign(incidentConfig,row,{id:77,businessId:77,businessRecordId:77,business_id:77,language:spec[0],cancellationSettingsEvidence:normalized.cancellationSettingsEvidence,
  allowCancellation:true,cancellationFeeEnabled:false});
 t.mock.method(globalThis,'fetch',async(url,init)=>{answers.push(interceptedIncidentSend(url,init));return new Response(JSON.stringify({ok:true,result:{message_id:1},messages:[{id:'offline'}]}));});
 b.configure({offlineAi:true,postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:100}),semanticLanguageResolver:async()=>({language:spec[0],confidence:1}),
  knowledgeCancellationConfig:async()=>fault==='missing'?null:fault==='missing-fee'?missingFee():fault==='foreign'?{...row,id:88}:feeChanged?{...row,cancellation_fee_enabled:true,cancellation_fee_amount:100,cancellation_fee_currency:'SEK'}:changed?{...row,allow_cancellation:false}:structuredClone(row),
  knowledgeSearch:async()=>structuredClone(incident.frozen.matches),knowledgeSourceLanguages:async()=>[],semanticKnowledgeSearch:async()=>[],semanticKnowledgeSearchQueries:async()=>[],completeKnowledgeCorpus:async()=>null,
  validateKnowledgeMatches:async(id,matches)=>{assert.equal(id,77);return matches;},knowledgeServiceCatalog:async()=>incidentConfig.services,
  aiGenerate:async request=>{
   if(request.systemInstruction.includes('retrieval query planner'))throw new DOMException('offline planner timeout','TimeoutError');
   const data=JSON.parse(request.messages[0].content);
   if(request.systemInstruction.includes('UNIT EXTRACTION')){
    stages.push('extraction');inputs.push(data);
    if(fault==='missing'||fault==='missing-fee'||fault==='foreign'){assert.equal(data.canonicalConfigurationProposals,undefined);return{text:'{"oversized":false,"units":[]}',functionCalls:[]};}
    assert.equal(request.structuredOutput!.name,fault==='replay-original'?'odinlink_knowledge_extraction_literal_v1':CANONICAL_CONFIG_SCHEMA);
    if(fault==='replay-original')return{text:incident.extraction.outputText,functionCalls:[]};
    if(fault==='genuine-attribution')return{text:JSON.stringify(attribution.extraction),functionCalls:[]};
    assert.match(request.systemInstruction,/literal-evidence-v1/);assert.match(request.systemInstruction,/Canonical configuration propositions v1/);
    const units=structuredClone(data.canonicalConfigurationProposals);assert.equal(units.length,2);
    assert.equal(units[1].predicate,'optional late fee');assert.equal(units[1].value,'disabled');assert.equal(units[1].negation,true);
    assert.ok(units.every((u:any)=>Object.keys(u.evidenceRefs[0]).join(',')==='evidenceId'));
    if(fault==='ambiguous')return{text:incident.extraction.outputText,functionCalls:[]};
    if(fault==='documentary-attribution')units.forEach((u:any)=>u.evidenceRefs=[{evidenceId:incident.frozen.evidence[0].id}]);
    if(fault==='charging')units[1].predicate='charges an optional late cancellation fee';
    if(fault==='free')units[1].text='All cancellations are always free.';
    if(fault==='deadline')units[1].text='You must cancel 24 hours in advance.';
    if(fault==='unrelated-fee')units[1].text='No mandatory cancellation fees apply.';
    if(fault==='invalid-citation')units[1].evidenceRefs[0].evidenceId='foreign';
    if(fault==='quotation')units[1].evidenceRefs[0].exactQuote='free';
    if(fault==='changed')changed=true;
    if(fault==='fee-changed')feeChanged=true;
    return{text:JSON.stringify({oversized:false,units:fault==='omitted-model-facts'?[]:units}),functionCalls:[]};
   }
   assert.match(request.systemInstruction,/BATCH ENTAILMENT/);stages.push('verification');inputs.push(data);
   assert.equal(request.structuredOutput!.name,'odinlink_knowledge_source_exhaustive_v2');
   if(fault==='replay-original'){
    assert.deepEqual(data,JSON.parse(genuine.request.messages[0].content));assert.notEqual(request.systemInstruction,genuine.request.systemInstruction);assert.ok(request.systemInstruction.endsWith(SOURCE_EXHAUSTIVE_V2_INSTRUCTION));
    return{text:genuine.outputText,functionCalls:[]}; // Exact genuine rejection, never overridden.
   }
   if(fault==='genuine-attribution'){assert.deepEqual(data,attribution.verification.input);return{text:JSON.stringify(attribution.verification.raw),functionCalls:[]};}
   assert.equal(data.units.length,2);assert.equal(data.units[0].value,'enabled');assert.equal(data.units[1].value,'disabled');
   assert.equal(data.units[1].predicate,'optional late fee');assert.ok(data.units.every((u:any)=>u.evidenceRefs[0].exactQuote.includes('business configuration')));
   throw Error('OFFLINE_INDEPENDENT_GENUINE_VERIFICATION_UNAVAILABLE');
  },calendarAdapter:{getCalendarId:()=> 'offline',getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden,cancelAppointment:forbidden,updateAppointment:forbidden},
  recordAppointment:forbidden,cancelAppointmentRow:forbidden,updateAppointmentRow:forbidden});
 return{stages,inputs,answers,actions:()=>actions,cleanup:()=>{for(const k of Object.keys(incidentConfig))delete(incidentConfig as any)[k];Object.assign(incidentConfig,saved);b.reset();}};
}
for(const spec of specs)for(const channel of incidentChannels)test(`canonical producer real adapter/${spec[0]}/${channel}`,async t=>{
 const f=setup(t,spec);try{await incidentInbound(b,channel,spec[1]);assert.deepEqual(f.stages,['extraction','verification']);assert.equal(f.answers.length,1);
  assert.ok(!f.answers[0].includes(spec[2])&&!f.answers[0].includes(spec[3]),'No facts publish without independent genuine verification');assert.equal(f.actions(),0);
  records.push({kind:'PRODUCER_ADAPTER_PASS_VERIFIER_WITHHELD_PUBLICATION_DENIED',language:spec[0],channel,final:f.answers[0],stages:f.stages,extractionProposals:f.inputs[0].canonicalConfigurationProposals});
 }finally{f.cleanup();}
});
for(const fault of ['ambiguous','charging','free','deadline','unrelated-fee','invalid-citation','quotation','changed','fee-changed','missing','missing-fee','foreign'])
test(`canonical native extraction fails closed/${fault}`,async t=>{
 const f=setup(t,specs[0],fault);try{await incidentInbound(b,'telegram',specs[0][1]);assert.ok(!f.stages.includes('verification'));
  assert.equal(f.actions(),0);assert.ok(f.answers.every(x=>!x.includes(specs[0][2])&&!x.includes(specs[0][3])));
 }finally{f.cleanup();}
});
test('backend canonical recovery remains present when model omits both facts; independent verification is still mandatory',async t=>{
 const f=setup(t,specs[0],'omitted-model-facts');try{await incidentInbound(b,'telegram',specs[0][1]);assert.deepEqual(f.stages,['extraction','verification']);assert.equal(f.inputs[1].units.length,2);assert.equal(f.actions(),0);
 }finally{f.cleanup();}
});
test('exact genuine CONTRADICTED capture still rejects at native publication with producer opt-in off',async t=>{
 const profile=process.env.ODINLINK_KNOWLEDGE_CONFIG_PROPOSITIONS;process.env.ODINLINK_KNOWLEDGE_CONFIG_PROPOSITIONS='off';const f=setup(t,specs[0],'replay-original');
 try{await b.nativeKnowledgeEvidenceRequest({sessionId:'canonical-original-rejection',channel:'telegram',businessConfig:incidentConfig,question:specs[0][1],language:'en',facets:dataFacets(),matches:incident.frozen.matches},async api=>{
  const result=await api.generate();assert.equal(publishableKnowledgeManifest(api.manifest(),77),false);assert.equal(await api.publish(result.text),incident.finalInterceptedResponse);
 });assert.deepEqual(f.stages,['extraction','verification']);assert.equal(f.actions(),0);
 }finally{f.cleanup();process.env.ODINLINK_KNOWLEDGE_CONFIG_PROPOSITIONS=profile;}
});
function dataFacets(){return JSON.parse(genuine.request.messages[0].content).facets;}

// Before correction, this exact real response reached verification and was denied.
// After correction it must be rejected earlier; no capture field is changed.
test('exact genuine wrong-attribution extraction never obtains publication authority',async t=>{
 const f=setup(t,specs[0],'genuine-attribution');try{
  await b.nativeKnowledgeEvidenceRequest({sessionId:'genuine-attribution-replay',channel:'telegram',businessConfig:incidentConfig,question:specs[0][1],language:'en',facets:attribution.verification.input.facets,matches:incident.frozen.matches},async api=>{
   const result=await api.generate();assert.equal(publishableKnowledgeManifest(api.manifest(),77),false);
   assert.equal(await api.publish(result.text),incident.finalInterceptedResponse);
  });
  assert.deepEqual(f.stages,['extraction']);
  assert.equal(f.actions(),0);
 }finally{f.cleanup();}
});

for(const spec of specs)for(const channel of incidentChannels)test(`canonical attribution fails before verification/${spec[0]}/${channel}`,async t=>{
 const f=setup(t,spec,'documentary-attribution');try{await incidentInbound(b,channel,spec[1]);
  assert.deepEqual(f.stages,['extraction']);assert.equal(f.actions(),0);
  assert.ok(f.answers.every(x=>!x.includes(spec[2])&&!x.includes(spec[3])));
 }finally{f.cleanup();}
});
