/** SCRIPTED offline decisions exercise the actual shared runtime and adapters.
 * They are NOT genuine provider acceptance. Historical provider outputs are verbatim. */
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {incidentConfig,incidentFlags,incidentInbound,incidentChannels,interceptedIncidentSend} from '../../tests/helpers/p0-incident-knowledge';
import {SOURCE_PARTITIONED_PRODUCER,SOURCE_PARTITIONED_SCHEMA} from './canonical-configuration-propositions';
import {publishableKnowledgeManifest,buildEvidenceFirstAnswer,InformationBudget,parseRequestedFacets} from './business-information-answer-plan';
import {runAccuracyFirstNative,nativeKnowledgeTiming} from './knowledge-timing-policy';
const incident=JSON.parse(readFileSync(new URL('../../tests/fixtures/genuine-luna-cancellation-coverage-20261102.json',import.meta.url),'utf8'));
const latest=JSON.parse(readFileSync(new URL('../../docs/validation/p0-integrated-genuine-acceptance-20261102/result.json',import.meta.url),'utf8'));
const oldAttribution=JSON.parse(readFileSync(new URL('../../tests/fixtures/genuine-luna-canonical-attribution-20261102.json',import.meta.url),'utf8'));
const historicalVerdicts:Record<string,string>={
 coverage:incident.verification.outputText,
 witness:JSON.parse(readFileSync(new URL('../../tests/fixtures/genuine-luna-source-shortfalls-20261102.json',import.meta.url),'utf8')).outputText,
 alignment:JSON.parse(readFileSync(new URL('../../tests/fixtures/genuine-luna-source-alignment-20261102.json',import.meta.url),'utf8')).outputText,
 contradiction:JSON.parse(readFileSync(new URL('../../tests/fixtures/genuine-luna-u2-contradiction-20261102.json',import.meta.url),'utf8')).outputText,
 typed:JSON.parse(readFileSync(new URL('../../docs/validation/p0-genuine-canonical-config-acceptance-20261102/result.json',import.meta.url),'utf8')).calls.find((c:any)=>c.stage==='verification').outputText,
};
incidentFlags();Object.assign(process.env,{ODINLINK_KNOWLEDGE_TIMING_POLICY:'accuracy-first-v1',ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS:'77',ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL:'source-exhaustive-v2',ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL:'v2',ODINLINK_KNOWLEDGE_CONFIG_PROPOSITIONS:SOURCE_PARTITIONED_PRODUCER});
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
const receipts:any[]=[];
after(()=>{if(process.env.ODINLINK_PARTITION_RECEIPTS)writeFileSync(process.env.ODINLINK_PARTITION_RECEIPTS,JSON.stringify({mode:'SCRIPTED_OFFLINE_ONLY',providerRequests:0,receipts},null,2),{mode:0o600});});
const specs=[
 ['en',incident.frozen.question,'Automatic appointment cancellation through chat is enabled.','The optional late cancellation fee is disabled.'],
 ['sv','Vad är er avbokningspolicy, och hur långt i förväg måste jag avboka min tid?','Automatisk avbokning av tider via chatt är aktiverad.','Den valfria avgiften för sen avbokning är inaktiverad.'],
 ['de','Was ist Ihre Stornierungsrichtlinie und wie weit im Voraus muss ich meinen Termin stornieren?','Die automatische Terminabsage per Chat ist aktiviert.','Die optionale Gebühr für eine verspätete Stornierung ist deaktiviert.'],
 ['es','¿Cuál es su política de cancelación y con cuánta antelación debo cancelar mi cita?','La cancelación automática de citas por chat está habilitada.','El cargo opcional por cancelación tardía está desactivado.'],
 ['fa','سیاست لغو شما چیست و چند ساعت قبل باید نوبت را لغو کنم؟','لغو خودکار نوبت از طریق چت فعال است.','هزینه اختیاری لغو دیرهنگام غیرفعال است.'],
 ['ar','ما هي سياسة الإلغاء لديكم وكم ساعة قبل الموعد يجب إلغاء الحجز؟','إلغاء المواعيد تلقائياً عبر الدردشة مفعّل.','رسوم الإلغاء المتأخر الاختيارية معطّلة.'],
];
function verdict(data:any){return{decisions:data.units.map((u:any)=>({unitId:u.id,relation:'ENTAILED',facetIds:u.facetIds,meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),
 coverage:data.facets.map((f:any)=>({facetId:f.id,requestAligned:true,materialFactsComplete:false,incompletenessReason:'UNRESOLVED',materialUnitIds:data.units.filter((u:any)=>u.facetIds.includes(f.id)).map((u:any)=>u.id),obligations:f.obligations.map((o:any)=>({obligationId:o.id,status:'UNRESOLVED',unitIds:[]}))})),
 sourceCoverage:{protocol:'source-exhaustive-v2',requestAligned:true,availableMaterialFactsComplete:true,conditionsPreserved:true,conflictsAbsent:true,evidenceIdsReviewed:data.evidence.map((e:any)=>e.id),acceptedUnitIdsReviewed:data.units.map((u:any)=>u.id),obligations:data.facets.flatMap((f:any)=>f.obligations.map((o:any)=>({facetId:f.id,obligationId:o.id,state:o.questionType==='requirement'?'UNRESOLVED_REQUIREMENT':'REQUESTED_INFORMATION_NOT_VERIFIED'})))}};}
function setup(t:any,spec=specs[0],fault='none'){
 for(const m of ['log','info','warn','error'])t.mock.method(console,m,()=>{});b.reset();
 const saved=structuredClone(incidentConfig),row=structuredClone(incident.frozen.rawCancellationSettings),normal=b.promptAuditNormalize(row),matches=structuredClone(incident.frozen.matches);
 const stages:string[]=[],inputs:any[]=[],answers:string[]=[],events:any[]=[];let actions=0,afterExtraction=false,afterVerification=false;
 if(fault==='no-docs')matches.splice(0);
 const forbidden=async()=>{actions++;throw Error('OFFLINE_ACTION_FORBIDDEN');};
 if(['conflict-omitted','same-slot-conflict','conflict-proposed'].includes(fault))matches.push({businessId:77,sourceId:'conflicting-document',text:'Automatic appointment cancellation through chat is disabled.',score:1,metadata:{source:'document',documentRevision:'r1'}});
 if(fault==='missing-condition')matches.push({businessId:77,sourceId:'condition-document',text:'Chat cancellation is enabled only when the appointment reference is supplied.',score:1,metadata:{source:'document',documentRevision:'r1'}});
 if(fault==='documentary')for(const [sourceId,text]of [['reception','Cancellation requests are received by reception.'],['staffed-hours','Reception receives cancellation requests only during staffed reception hours.']])matches.push({businessId:77,sourceId,text,score:1,metadata:{source:'document',documentRevision:'r1'}});
 Object.assign(incidentConfig,row,{id:77,businessId:77,businessRecordId:77,business_id:77,language:spec[0],cancellationSettingsEvidence:normal.cancellationSettingsEvidence,allowCancellation:true,cancellationFeeEnabled:false});
 t.mock.method(globalThis,'fetch',async(url,options)=>{answers.push(interceptedIncidentSend(url,options));return new Response(JSON.stringify({ok:true,result:{message_id:1},messages:[{id:'offline'}]}));});
 b.configure({offlineAi:true,postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:100}),semanticLanguageResolver:async()=>({language:spec[0],confidence:1}),
 knowledgeCancellationConfig:async()=>afterExtraction&&fault==='config-changed'?{...row,allow_cancellation:false}:afterExtraction&&fault==='config-revoked'?null:afterExtraction&&fault==='config-foreign'?{...row,id:88}:structuredClone(row),
 knowledgeSearch:async()=>structuredClone(matches),knowledgeSourceLanguages:async()=>[],semanticKnowledgeSearch:async()=>[],semanticKnowledgeSearchQueries:async()=>[],completeKnowledgeCorpus:async()=>null,
 validateKnowledgeMatches:async(_id,m)=>afterExtraction&&fault==='doc-revoked'?[]:afterExtraction&&fault==='doc-stale'||afterVerification&&fault==='final-stale'?m.map(x=>({...x,metadata:{...x.metadata,documentRevision:'changed'}})):m,
 knowledgeServiceCatalog:async()=>incidentConfig.services,evidenceFirstDecisionDiagnostic:d=>events.push(d),
 aiGenerate:async r=>{
  if(r.systemInstruction.includes('retrieval query planner'))throw new DOMException('offline forced timeout','TimeoutError');
  const data=JSON.parse(r.messages[0].content);
  if(r.systemInstruction.includes('UNIT EXTRACTION')){
   stages.push('extraction');inputs.push(data);assert.equal(r.structuredOutput!.name,SOURCE_PARTITIONED_SCHEMA);assert.match(r.systemInstruction,/Source-partitioned documentary extraction v1/);
   assert.match(r.systemInstruction,/Preserve all directly applicable documentary conditions/);assert.doesNotMatch(r.systemInstruction,/copy its complete fields|canonicalConfigurationProposals/);
   assert.equal(data.authorityScope,'document_only');assert.equal(data.canonicalConfigurationProposals,undefined);assert.equal(data.relevantHistory,undefined);assert.equal(data.businessTone,undefined);
   assert.ok(data.evidence.length>0&&data.evidence.every((e:any)=>e.id!==incident.frozen.configurationEvidence.id));
   const serialized=JSON.stringify({instruction:r.systemInstruction,data,schema:r.structuredOutput});
   for(const privateValue of [incident.frozen.configurationEvidence.id,incident.frozen.configurationEvidence.text,spec[2],spec[3]])assert.ok(!serialized.includes(privateValue));
   assert.equal((r.structuredOutput!.schema as any).properties.units.maxItems,4);
   afterExtraction=true;
   if(fault==='latest-capture')return{text:latest.calls[0].outputText,functionCalls:[]};
   if(fault==='old-attribution')return{text:JSON.stringify(oldAttribution.extraction),functionCalls:[]};
   if(fault==='old-extraction')return{text:incident.extraction.outputText,functionCalls:[]};
   if(fault==='refusal')return{text:'',structuredFailure:'REFUSAL',functionCalls:[]};
   if(fault==='truncated')return{text:'',structuredFailure:'TRUNCATED',functionCalls:[]};
   if(fault==='malformed')return{text:'not-json',functionCalls:[]};
   if(fault==='tools')return{text:'{"oversized":false,"units":[]}',functionCalls:[{id:'offline',function:{name:'invented',arguments:'{}'}}]};
   if(fault==='oversized')return{text:'{"oversized":true,"units":[]}',functionCalls:[]};
   let units:any[]=[];
   const doc=(text:string,refs:string[])=>({facetIds:['f1'],subject:'cancellation reception',predicate:'receives requests',value:'during staffed hours',modality:'descriptive',negation:false,scope:'staffed reception hours',qualifiers:[],language:spec[0],text,evidenceRefs:refs.map(evidenceId=>({evidenceId}))});
   if(fault==='documentary')units=[doc('Cancellation requests are received by reception only during staffed reception hours.',data.evidence.filter((e:any)=>e.text.startsWith('Cancellation requests are received by reception.')||e.text.startsWith('Reception receives cancellation requests only')).map((e:any)=>e.id))];
   if(fault==='conflict-proposed')units=[doc('Automatic appointment cancellation through chat is disabled.',[data.evidence.find((e:any)=>e.text==='Automatic appointment cancellation through chat is disabled.').id])];
   if(fault==='same-slot-conflict')units=[{...doc('Automatic appointment cancellation through chat is disabled.',[data.evidence.at(-1).id]),subject:'business cancellation configuration',predicate:'automatic chat cancellation',value:'disabled'}];
   if(['unknown-id','host-id','invented-deadline','universal-free','parse-loss','overrun'].includes(fault)){
    units=[doc(fault==='invented-deadline'?'You must cancel 24 hours in advance.':fault==='universal-free'?'All cancellations are always free.':'Invented documentary claim.',[fault==='unknown-id'?'unknown':fault==='host-id'?incident.frozen.configurationEvidence.id:data.evidence[0].id])];
    if(fault==='parse-loss')units[0].modality='wrong';if(fault==='overrun')units=Array.from({length:5},()=>structuredClone(units[0]));
   }
   return{text:JSON.stringify({oversized:false,units}),functionCalls:[]};
  }
  assert.match(r.systemInstruction,/BATCH ENTAILMENT/);stages.push('verification');inputs.push(data);assert.equal(r.structuredOutput!.name,'odinlink_knowledge_source_exhaustive_v2');
  assert.ok(data.evidence.some((e:any)=>e.id===incident.frozen.configurationEvidence.id));assert.equal(data.evidence.length,matches.length+1);
  const host=data.units.filter((u:any)=>u.evidenceRefs.some((x:any)=>x.evidenceId===incident.frozen.configurationEvidence.id));assert.equal(host.length,2);assert.equal(host[0].text,spec[2]);assert.equal(host[1].text,spec[3]);
  assert.ok(host.every((u:any)=>u.evidenceRefs[0].exactQuote.includes('business configuration')));
  if(fault==='verifier-withheld')throw Error('NO_INDEPENDENT_VERIFICATION');
  if(fault.startsWith('historical-verifier:'))return{text:historicalVerdicts[fault.slice('historical-verifier:'.length)],functionCalls:[]};
  if(fault==='documentary'){assert.equal(data.units.length,3);assert.equal(data.units[0].evidenceRefs.length,2);assert.ok(data.units[0].text.includes('only during staffed reception hours'));}
  if(fault.startsWith('conflict-'))assert.ok(data.evidence.some((e:any)=>e.text==='Automatic appointment cancellation through chat is disabled.'));
  const raw=verdict(data);afterVerification=true;
  if(fault==='conflict-omitted'||fault==='conflict-proposed'){raw.sourceCoverage.conflictsAbsent=false;raw.decisions[raw.decisions.length-2].relation='CONTRADICTED';}
  if(fault==='missing-condition'){assert.ok(data.evidence.some((e:any)=>e.text.includes('only when the appointment reference')));raw.sourceCoverage.conditionsPreserved=false;}
  if(fault==='typed-requirement')raw.sourceCoverage.obligations[1].state='REQUESTED_INFORMATION_NOT_VERIFIED';
  if(fault==='typed-description')raw.sourceCoverage.obligations[0].state='UNRESOLVED_REQUIREMENT';
  if(fault==='missing-fact')raw.sourceCoverage.availableMaterialFactsComplete=false;
  if(fault==='forged')raw.sourceCoverage.protocol='forged';
  if(fault==='invented-deadline'||fault==='universal-free')raw.decisions[0].relation='UNKNOWN';
  return{text:JSON.stringify(raw),functionCalls:[]};
 },calendarAdapter:{getCalendarId:()=>{throw Error('OFFLINE_ACTION_FORBIDDEN');},getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden,cancelAppointment:forbidden,updateAppointment:forbidden},recordAppointment:forbidden,cancelAppointmentRow:forbidden,updateAppointmentRow:forbidden});
 return{stages,inputs,answers,events,matches,actions:()=>actions,cleanup:()=>{b.reset();for(const k of Object.keys(incidentConfig))delete(incidentConfig as any)[k];Object.assign(incidentConfig,saved);}};
}
for(const spec of specs)for(const channel of incidentChannels)test(`SCRIPTED partitioned scoped answer/${spec[0]}/${channel}`,async t=>{
 const f=setup(t,spec);try{await incidentInbound(b,channel,spec[1]);assert.deepEqual(f.stages,['extraction','verification']);assert.equal(f.answers.length,1);assert.equal(f.actions(),0);assert.ok(f.answers[0].includes(spec[2])&&f.answers[0].includes(spec[3]));assert.doesNotMatch(f.answers[0],/24 hours|always free|cannot verify an answer/);assert.ok(f.events.some((d:any)=>d.stage==='publication'&&d.route==='partial_manifest'));
 if(spec[0]==='en')assert.equal(f.answers[0],spec[2]+' '+spec[3]+'\n\nThe complete cancellation policy and required advance notice cannot be confirmed from the available information.');
 receipts.push({kind:'SCRIPTED_NOT_GENUINE',language:spec[0],channel,stages:f.stages,final:f.answers[0]});
 }finally{f.cleanup();}
});
for(const spec of specs)for(const channel of incidentChannels)test(`latest genuine packet stays rejected/${spec[0]}/${channel}`,async t=>{
 const f=setup(t,spec,'latest-capture');try{await incidentInbound(b,channel,spec[1]);assert.deepEqual(f.stages,['extraction']);assert.equal(f.actions(),0);assert.ok(!f.events.some((d:any)=>d.route==='partial_manifest'));}finally{f.cleanup();}
});
for(const fault of ['old-attribution','old-extraction','same-slot-conflict','refusal','truncated','malformed','tools','oversized','unknown-id','host-id','parse-loss','overrun','config-changed','config-revoked','config-foreign','doc-revoked','doc-stale'])test(`partition extraction fails whole/${fault}`,async t=>{
 const f=setup(t,specs[0],fault);try{await incidentInbound(b,'telegram',specs[0][1]);assert.deepEqual(f.stages,['extraction']);assert.equal(f.actions(),0);assert.ok(!f.events.some((d:any)=>d.route==='partial_manifest'));}finally{f.cleanup();}
});
for(const fault of ['conflict-omitted','conflict-proposed','missing-condition','typed-requirement','typed-description','missing-fact','forged','invented-deadline','universal-free','verifier-withheld','final-stale'])test(`partition full-source verification/publication denies/${fault}`,async t=>{
 const f=setup(t,specs[0],fault);try{await incidentInbound(b,'telegram',specs[0][1]);if(fault==='invented-deadline')assert.deepEqual(f.stages,['extraction']);else assert.deepEqual(f.stages,['extraction','verification']);assert.equal(f.actions(),0);assert.ok(f.answers.every(x=>!x.includes(specs[0][2])&&!x.includes(specs[0][3])));assert.ok(!f.events.some((d:any)=>d.route==='partial_manifest'&&d.publishableUnits>0)||fault==='final-stale');}finally{f.cleanup();}
});
test('legitimate multi-document fact and its qualification survive unchanged into full verifier',async t=>{
 const f=setup(t,specs[0],'documentary');try{await incidentInbound(b,'telegram',specs[0][1]);assert.deepEqual(f.stages,['extraction','verification']);assert.equal(f.actions(),0);assert.ok(f.answers[0].includes('only during staffed reception hours'),JSON.stringify({answers:f.answers,events:f.events.map((d:any)=>({stage:d.stage,reason:d.reason,route:d.route,counts:d.counts}))}));assert.ok(f.answers[0].includes(specs[0][2]));}finally{f.cleanup();}
});
test('no-document scope skips generation explicitly, independently verifies backend proposals, and publishes only valid scoped authority',async t=>{
 const f=setup(t,specs[0],'no-docs');try{await b.nativeKnowledgeEvidenceRequest({sessionId:'partition-no-docs',businessConfig:incidentConfig,question:specs[0][1],language:'en',facets:incident.verification.input.facets,matches:[],channel:'telegram'},async api=>{
  const generated=await api.generate();assert.equal(publishableKnowledgeManifest(api.manifest(),77),true,JSON.stringify({manifest:api.manifest(),events:f.events,inputs:f.inputs}));assert.ok((await api.publish(generated.text))!.includes(specs[0][2]));
 });assert.deepEqual(f.stages,['verification']);assert.ok(f.events.some((d:any)=>d.stage==='extraction'&&d.reason==='NO_EVIDENCE'));assert.equal(f.actions(),0);}finally{f.cleanup();}
});
test('history, tone and authoritative configuration canaries do not leak into extraction request',async()=>{
 const facets=parseRequestedFacets(incident.verification.input.facets).facets,evidence=[...incident.frozen.evidence,incident.frozen.configurationEvidence],seen:string[]=[];
 await runAccuracyFirstNative(async()=>{
  await buildEvidenceFirstAnswer({question:specs[0][1],language:'en',facets,evidence,businessId:77,cancellationEvidence:incident.frozen.configurationEvidence,foreground:true,verificationProtocol:'source-exhaustive-v2',extractionProtocol:'literal-evidence-v1',authoritativeEvidence:'PRIVATE_AUTHORITY_CANARY',businessTone:{secret:'PRIVATE_TONE_CANARY'},history:[{content:'PRIVATE_HISTORY_CANARY '+incident.frozen.configurationEvidence.text}],budget:new InformationBudget(undefined,nativeKnowledgeTiming()),current:async()=>true,revalidateEvidence:async()=>evidence,
   generate:async(stage,_instruction,data:any,contract)=>{seen.push(stage);if(stage==='extraction'){const s=JSON.stringify(data);for(const forbidden of ['PRIVATE_TONE_CANARY','PRIVATE_HISTORY_CANARY','PRIVATE_AUTHORITY_CANARY',incident.frozen.configurationEvidence.id])assert.ok(!s.includes(forbidden));assert.equal(data.relevantHistory,undefined);assert.equal(data.businessTone,undefined);assert.equal(contract!.canonicalConfiguration!.protocol,SOURCE_PARTITIONED_PRODUCER);return{text:'{"oversized":false,"units":[]}' };}assert.equal(data.authoritativeEvidence,'PRIVATE_AUTHORITY_CANARY');assert.equal(data.evidence.length,evidence.length);throw Error('VERIFIER_WITHHELD_OFFLINE');}
  });
 },async()=>{});assert.deepEqual(seen,['extraction','verification']);
});

for(const name of Object.keys(historicalVerdicts))test(`unaltered genuine verifier failure cannot certify new inventory/${name}`,async t=>{
 const before=historicalVerdicts[name],f=setup(t,specs[0],'historical-verifier:'+name);try{await incidentInbound(b,'telegram',specs[0][1]);assert.deepEqual(f.stages,['extraction','verification']);assert.equal(f.actions(),0);assert.ok(!f.events.some((d:any)=>d.route==='partial_manifest'));assert.equal(historicalVerdicts[name],before);}finally{f.cleanup();}
});
