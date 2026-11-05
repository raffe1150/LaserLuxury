/** Actual native adapters/publication; all model and index judgments SCRIPTED. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {hierarchicalFixture,declaration,policy,exception,condition} from '../../tests/helpers/hierarchical-foundation';
import {incidentFlags,incidentConfig,incidentChannels,incidentInbound,interceptedIncidentSend} from '../../tests/helpers/p0-incident-knowledge';
incidentFlags();
Object.assign(process.env,{ODINLINK_HIERARCHICAL_SEARCH:'hierarchical-search-v1',ODINLINK_KNOWLEDGE_TIMING_POLICY:'accuracy-first-v1',
 ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS:'77',ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL:'source-exhaustive-v2',ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL:'v2',
 ODINLINK_KNOWLEDGE_CONFIG_PROPOSITIONS:'source-partitioned-v1',ODINLINK_KNOWLEDGE_LEXICAL_BATCH:'false'});
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
const records:any[]=[];
const copy={es:['Según este documento ficticio de prueba, los objetos de valor se registran por separado.',
 'Según este documento ficticio de prueba, los objetos peligrosos están excluidos de ese registro.',
 'Según este documento ficticio de prueba, el cliente debe describir el objeto antes de recogerlo.'],
 fa:['طبق این سند تخیلی آزمایشی، اشیای باارزش جداگانه ثبت می‌شوند.',
 'طبق این سند تخیلی آزمایشی، اشیای خطرناک از این ثبت مستثنا هستند.',
 'طبق این سند تخیلی آزمایشی، مشتری باید پیش از تحویل گرفتن شیء آن را توصیف کند.']};
type Fault='none'|'overflow'|'overflow-catalog'|'missing-context'|'missing-context-catalog'|'late-completion'|'revoked'|'changed'|'foreign'|'conflict'|'hint-citation'|'missing-source';
async function replay(t:any,language:'es'|'fa',channel:typeof incidentChannels[number],count:number,fault:Fault){
 for(const key of ['log','warn','error','info'])t.mock.method(console,key,()=>{});b.reset();
 const saved=structuredClone(incidentConfig),f=await hierarchicalFixture(count,fault.startsWith('overflow')?300:0),question=fault.endsWith('-catalog')?'¿Cuánto cuesta Video Consultation y cómo se registran los objetos de valor?':language==='es'?'¿Cómo se registran los objetos de valor?':'اشیای باارزش چگونه ثبت می‌شوند؟';
 if(fault==='conflict'){
  const source={...f.source,id:'conflicting',content:f.source.content.replace(policy,'Wertgegenstände werden nicht getrennt registriert.')};
  // Same-length geometry is not assumed: construct a separately current source.
  const {canonicalAdapterContent}=await import('../knowledge/documents/canonical');
  const adapted=canonicalAdapterContent({format:'txt',adapterVersion:'SCRIPTED-conflict',blocks:[{text:declaration},{text:'Wertgegenstände werden nicht getrennt registriert.'}]});
  await f.storage.create({...source,...adapted});
 }
 await f.index.recover();if(fault==='conflict')await f.index.recover();
 if(fault==='missing-source')await f.storage.delete(77,'guide');
 const sends:string[]=[],stages:string[]=[],payloads:any[]=[];let actions=0,semantic=0,translated=0;
 const deny=async()=>{actions++;throw Error('UNAUTHORIZED_BOOKING_OPERATION');};
 b.configure({offlineAi:true,knowledgeSearch:(id,q,limit)=>f.service.search(id,q,limit),knowledgeSourceLanguages:async()=>['de'],
  completeKnowledgeDocuments:(id,found,anchors,options)=>fault.startsWith('missing-context')?Promise.resolve(null):fault==='late-completion'?new Promise(resolve=>setTimeout(()=>resolve(f.service.completeSelectedDocuments(id,found,anchors,options)),150)):f.service.completeSelectedDocuments(id,found,anchors,options),
  semanticKnowledgeSearchQueries:async()=>{semantic++;throw Error('Metadata lookup must not spend an embedding call');},
  validateKnowledgeMatches:(id,m)=>f.service.validateMatches(id,fault==='foreign'?m.map(x=>({...x,businessId:88})):m,{strictSources:true,captureRevision:true,requireCompleteDocumentContext:true}),
  knowledgeServiceCatalog:async()=>[],aiGenerate:async request=>{
   const data=JSON.parse(request.messages[0].content),instruction=request.systemInstruction;
   if(instruction.includes('retrieval query planner'))return{functionCalls:[],text:JSON.stringify({requestKind:'BUSINESS_INFORMATION',canonicalMeaning:question,queries:[question],
    queryLanguages:[],referenceResolution:'NOT_REQUIRED',requestedFacets:[{subject:'valuables',attribute:question,questionType:'description'}]})};
   if(instruction.startsWith('OdinLink source-language')){translated++;throw Error('No translated query is permitted');}
   if(instruction.includes('UNIT EXTRACTION')){
    stages.push('extraction');assert.ok(data.evidence.length<=5&&data.evidence.every((e:any)=>e.text.length<=2400));
    assert.ok(data.evidence.reduce((n:number,e:any)=>n+e.text.length,0)<=9000);
    for(const quote of [declaration,policy,exception,condition])assert.ok(data.evidence.some((e:any)=>e.text.includes(quote)),quote);
    if(fault==='conflict')assert.ok(data.evidence.some((e:any)=>e.text.includes('Wertgegenstände werden nicht getrennt registriert.')));
    assert.ok(data.evidence.every((e:any)=>!e.text.includes('اشیای باارزش')&&!e.text.includes('objetos de valor')));
    payloads.push({records:data.evidence.length,textChars:data.evidence.reduce((n:number,e:any)=>n+e.text.length,0),canonicalChunks:count});
    if(fault==='revoked')await f.storage.create({...f.source,status:'disabled'});
    if(fault==='changed')await f.storage.create({...f.source,updatedAt:'2'});
    const literal=request.structuredOutput?.name.includes('literal');
    return{functionCalls:[],text:JSON.stringify({oversized:false,units:[policy,exception,condition].map((quote,i)=>({facetIds:['f1'],subject:i===2?'customer':'valuables',
     predicate:['separate registration','registration exception','description before collection'][i],value:copy[language][i],modality:i===2?'required':'descriptive',
     negation:false,scope:'fictional test document',qualifiers:[],language,text:copy[language][i],
     evidenceRefs:[{evidenceId:fault==='hint-citation'?'hint-id':data.evidence.find((e:any)=>e.text.includes(quote)).id,...(!literal?{exactQuote:quote}:{})}]}))})};
   }
   stages.push('verification');assert.equal(request.structuredOutput?.name,'odinlink_knowledge_source_exhaustive_v2');
   return{functionCalls:[],text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:fault==='conflict'?'CONTRADICTED':'ENTAILED',meaningPreserved:true,
    modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),
    coverage:data.facets.map((facet:any)=>({facetId:facet.id,requestAligned:true,materialFactsComplete:true,incompletenessReason:'NONE',materialUnitIds:data.units.map((u:any)=>u.id),
     obligations:facet.obligations.map((o:any)=>({obligationId:o.id,status:'COVERED',unitIds:data.units.map((u:any)=>u.id)}))})),
    sourceCoverage:{protocol:'source-exhaustive-v2',requestAligned:true,availableMaterialFactsComplete:true,conditionsPreserved:true,conflictsAbsent:fault!=='conflict',
     evidenceIdsReviewed:data.evidence.map((e:any)=>e.id),acceptedUnitIdsReviewed:data.units.map((u:any)=>u.id),obligations:data.facets.flatMap((facet:any)=>facet.obligations.map((o:any)=>({facetId:facet.id,obligationId:o.id,state:'COMPLETE'})))}})};
  },calendarAdapter:{getCalendarId:()=> 'offline',getEvents:deny,checkSlots:deny,insertAppointment:deny,cancelAppointment:deny},recordAppointment:deny,cancelAppointmentRow:deny});
 try{
  Object.assign(incidentConfig,{id:77,businessId:77,businessRecordId:77,business_id:77,language,services:fault.endsWith('-catalog')?[{name:'Video Consultation',price:300,duration:60}]:[]});
  t.mock.method(globalThis,'fetch',async(url,options)=>{sends.push(interceptedIncidentSend(url,options));return new Response(JSON.stringify({ok:true,result:{message_id:1},messages:[{id:'offline'}]}));});
  const started=performance.now();await incidentInbound(b,channel,question);
  records.push({kind:'SCRIPTED_HIERARCHICAL_NATIVE',language,channel,count,fault,sends,stages,payloads,actions,semantic,translated,elapsedMs:performance.now()-started});
  assert.equal(sends.length,1);assert.equal(actions,0);assert.equal(semantic,0);assert.equal(translated,0);
  if(fault==='none'){assert.deepEqual(stages,['extraction','verification']);for(const text of copy[language])assert.ok(sends[0].includes(text),sends[0]);}
  else assert.ok(!sends[0].includes(copy[language][0]),JSON.stringify({fault,stages,sends}));
  if(fault==='conflict')assert.ok(stages.includes('verification'));
  if(fault.endsWith('-catalog')||fault==='late-completion'){assert.deepEqual(stages,[]);assert.ok(!sends[0].includes('300'));}
 }finally{for(const key of Object.keys(incidentConfig))delete (incidentConfig as any)[key];Object.assign(incidentConfig,saved);b.reset();}
}
for(const count of [4,50])for(const language of ['fa','es'] as const)for(const channel of incidentChannels)
 test(`SCRIPTED hierarchical native / ${count}/${language}/${channel}`,{timeout:5000},async t=>replay(t,language,channel,count,'none'));
for(const fault of ['overflow','overflow-catalog','missing-context','missing-context-catalog','late-completion','revoked','changed','foreign','conflict','hint-citation','missing-source'] as const)
 test(`SCRIPTED hierarchical native denial / ${fault}`,{timeout:5000},async t=>replay(t,'es','telegram',50,fault));
test('write optional SCRIPTED hierarchical observations',()=>{if(process.env.ODINLINK_HIERARCHICAL_RECEIPT)writeFileSync(process.env.ODINLINK_HIERARCHICAL_RECEIPT,JSON.stringify({providerCalls:0,records},null,2)+'\n',{flag:'wx'});});
