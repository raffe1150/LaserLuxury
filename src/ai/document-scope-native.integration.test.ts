/** Offline native publication controls. All model judgments are SCRIPTED. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {InMemoryKnowledgeStorage,KnowledgeService,knowledgeSourceRevision} from '../../knowledge';
import {documentChunks} from '../knowledge/documents/service';
import {incidentFlags,incidentConfig,incidentChannels} from '../../tests/helpers/p0-incident-knowledge';
incidentFlags();
Object.assign(process.env,{ODINLINK_KNOWLEDGE_TIMING_POLICY:'accuracy-first-v1',ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS:'77',
 ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL:'source-exhaustive-v2',ODINLINK_KNOWLEDGE_CONFIG_PROPOSITIONS:'source-partitioned-v1'});
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
const declaration='Alle Angaben dieses Dokuments sind erfunden und ausschließlich für einen Test bestimmt. Sie sind keine tatsächlichen Kundenbedingungen.';
const policy='Wertgegenstände werden getrennt registriert.';
const copy={fa:'طبق شرایط تخیلی این سند آزمایشی، اشیای باارزش جداگانه ثبت می‌شوند.',es:'Según las condiciones ficticias de este documento de prueba, los objetos de valor se registran por separado.'};
type Fault='ordinary'|'none'|'same-chunk'|'missing'|'revoked'|'stale'|'cross-document'|'foreign'|'conflict'|'unqualified'|'packed-out'|'unsegmented';
async function replay(t:any,language:'fa'|'es',channel:typeof incidentChannels[number],fault:Fault){
 b.reset();for(const name of ['log','info','warn','error'] as const)t.mock.method(console,name,()=>{});
 const storage=new InMemoryKnowledgeStorage(),service=new KnowledgeService(storage);
 const texts=fault==='ordinary'?[policy]:fault==='same-chunk'?[declaration+'\n'+policy]:[policy,declaration,
  ...(fault==='conflict'?['Die Angaben dieses Dokuments sind tatsächliche Kundenbedingungen.']:[]),
  ...(fault==='packed-out'?['Zusatz A.','Zusatz B.','Zusatz C.','Zusatz D.']:[])];
 const sections=texts.map((text,index)=>({text,page:index+1}));
 const document=documentChunks(sections,'Besuchsregeln.pdf');
 const source={id:'guide',businessId:77,type:'document' as const,title:'Besuchsregeln.pdf',status:'ready' as const,
  content:document.content,metadata:document.metadata,createdAt:'2026',updatedAt:'2026'};
 if(fault==='unsegmented')source.metadata.segments=source.metadata.segments.slice(0,1);
 await storage.create(source);
 let matches=document.chunks.map((chunk:any)=>({businessId:77,sourceId:source.id,text:chunk.content,score:1,
  metadata:{...chunk.metadata,documentRevision:knowledgeSourceRevision(source)}}));
 if(fault==='missing'||fault==='unsegmented')matches=matches.slice(0,1);
 if(fault==='cross-document'){
  const other={...source,id:'other',content:declaration,metadata:{segments:[{start:0,end:declaration.length,page:2}]}};
  await storage.create(other);
  matches=[matches[0],{...matches[1],sourceId:other.id,metadata:{...matches[1].metadata,documentRevision:knowledgeSourceRevision(other)}}];
 }
 if(fault==='foreign')matches=matches.map((match,index)=>index===1?{...match,businessId:88}:match);
 const events:any[]=[],stages:string[]=[];let actions=0,extracted=false;
 const deny=async()=>{actions++;throw Error('UNEXPECTED_OPERATION');};
 b.configure({offlineAi:true,knowledgeServiceCatalog:async()=>[],
  validateKnowledgeMatches:async(id,found)=>service.validateMatches(id,found,{strictSources:true,requireCompleteDocumentContext:true}),
  evidenceFirstDecisionDiagnostic:event=>events.push(event),
  aiGenerate:async request=>{
   const data=JSON.parse(request.messages[0].content);
   if(request.systemInstruction.includes('UNIT EXTRACTION')){
    stages.push('extraction');extracted=true;
    assert.equal(data.evidence.some((e:any)=>e.text.includes(declaration)),fault!=='ordinary');
    if(fault==='cross-document'){
     assert.ok(data.evidence.every((e:any)=>!e.text.includes(policy)),'The incomplete policy source must be absent');
     return{functionCalls:[],text:JSON.stringify({oversized:false,units:[]})};
    }
    const references=data.evidence.filter((e:any)=>e.text.includes(policy)||e.text.includes(declaration)).map((e:any)=>({evidenceId:e.id}));
    if(fault==='revoked')await storage.create({...source,status:'disabled'});
    if(fault==='stale')await storage.create({...source,content:source.content.replace('erfunden','ungeklärt')});
    const text=fault==='ordinary'||fault==='unqualified'?'Los objetos de valor se registran por separado.':copy[language];
    return{functionCalls:[],text:JSON.stringify({oversized:false,units:[{facetIds:['f1'],subject:'valuables',predicate:'registration',value:'separate',
     modality:'descriptive',negation:false,scope:'fictional test document',qualifiers:[],language,text,evidenceRefs:references}]})};
   }
   assert.ok(request.systemInstruction.includes('BATCH ENTAILMENT'));stages.push('verification');
   for(const u of data.units)for(const ref of u.evidenceRefs)assert.equal(ref.exactQuote,data.evidence.find((e:any)=>e.id===ref.evidenceId).text);
   const safe=fault!=='conflict'&&fault!=='unqualified';
   return{functionCalls:[],text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:'ENTAILED',meaningPreserved:true,
    modalityPreserved:true,qualifiersPreserved:fault!=='unqualified',relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),
    coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:safe,incompletenessReason:safe?'NONE':'MISSING_CONDITION',materialUnitIds:['u1'],
     obligations:[{obligationId:'f1.o1',status:safe?'COVERED':'UNRESOLVED',unitIds:['u1']}]}],
    sourceCoverage:{protocol:'source-exhaustive-v2',requestAligned:true,availableMaterialFactsComplete:safe,conditionsPreserved:safe,conflictsAbsent:fault!=='conflict',
     evidenceIdsReviewed:data.evidence.map((e:any)=>e.id),acceptedUnitIdsReviewed:['u1'],obligations:[{facetId:'f1',obligationId:'f1.o1',state:safe?'COMPLETE':'MISSING_CONDITION'}]}})};
  },calendarAdapter:{getCalendarId:()=> 'offline',getEvents:deny,checkSlots:deny,insertAppointment:deny,cancelAppointment:deny},recordAppointment:deny,cancelAppointmentRow:deny,
 });
 let final:string|null=null;
 try{
  const question=language==='fa'?'اشیای باارزش چگونه ثبت می‌شوند؟':'¿Cómo se registran los objetos de valor?';
  await b.nativeKnowledgeEvidenceRequest({sessionId:'scope-'+language+'-'+channel+'-'+fault,businessConfig:{...incidentConfig,services:[]},question,language,channel,
   facets:[{subject:'valuables',attribute:question,questionType:'description'}],matches},async api=>{
   const result=await api.generate();final=await api.publish(result.text);
  });
  const success=fault==='none'||fault==='same-chunk'||fault==='ordinary';
  assert.equal(events.some(e=>e.stage==='publication'&&e.publishableUnits>0),success,JSON.stringify({fault,stages,events}));
  if(success){assert.deepEqual(stages,['extraction','verification']);assert.equal(final,fault==='ordinary'?'Los objetos de valor se registran por separado.':copy[language]);}
  else assert.ok(!final?.includes(copy[language]));
  if(['missing','foreign','packed-out','unsegmented'].includes(fault))assert.equal(extracted,false);
  if(fault==='revoked'||fault==='stale')assert.deepEqual(stages,['extraction']);
  assert.equal(actions,0);
 }finally{b.reset();}
}
for(const channel of incidentChannels)for(const language of ['fa','es'] as const)
 test('SCRIPTED German document scope / '+language+'/'+channel,async t=>replay(t,language,channel,'none'));
for(const fault of ['ordinary','same-chunk','missing','revoked','stale','cross-document','foreign','conflict','unqualified','packed-out','unsegmented'] as const)
 test('SCRIPTED native document scope / '+fault,async t=>replay(t,'es','telegram',fault));
