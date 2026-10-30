/** Existing six-language conditional fixtures, actual native adapters, synthetic
 * retrieval vectors and scripted extraction/verdicts. Zero real model acceptance. */
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {Responses} from 'openai/resources/responses';
import {KnowledgeService,InMemoryKnowledgeStorage} from '../../knowledge';
import {documentChunks} from '../knowledge/documents/service';
import {OPENAI_KNOWLEDGE_EMBEDDING_IDENTITY as identity} from '../knowledge/embedding-backfill';
import {directConditionalQuestions} from '../../tests/fixtures/direct-conditional-questions';
import {incidentConfig,incidentChannels,incidentInbound,interceptedIncidentSend} from '../../tests/helpers/p0-incident-knowledge';
import {wholeQuestionInformationPlan} from './knowledge-planning';
Object.assign(process.env,{NODE_ENV:'test',DOTENV_CONFIG_PATH:'/dev/null',AI_PROVIDER:'openai',OPENAI_API_KEY:'synthetic-offline-only',ODINLINK_EVIDENCE_FIRST_KNOWLEDGE:'true',ODINLINK_GROUNDED_NATURAL_RESPONSES:'false',
 ODINLINK_KNOWLEDGE_RETRIEVAL_POLICY:'candidate-top5-v1',ODINLINK_KNOWLEDGE_TIMING_POLICY:'accuracy-first-v1',ODINLINK_ASYNC_KNOWLEDGE_ADMISSION:'false',ODINLINK_ASYNC_KNOWLEDGE_PROCESSING:'false',ODINLINK_ASYNC_KNOWLEDGE_DELIVERY:'false',ODINLINK_SMART_WAITING:'false'});
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
const fixture=JSON.parse(readFileSync('tests/fixtures/cedar-repair-knowledge.json','utf8'));
const storage=new InMemoryKnowledgeStorage();
const v={...identity,values:Array.from({length:768},(_,i)=>i===0?1:0)},qv={...v,values:Array.from({length:768},(_,i)=>i===0?.2:i===1?Math.sqrt(.96):0)};
for(const d of [...fixture.documents,...Array.from({length:4},(_,i)=>({sourceId:`zz-control-${i}`,text:`Synthetic unrelated document ${i}.`}))]){
 const rebuilt=documentChunks([{text:d.text,section:'Text'}],`${d.sourceId}.txt`),id=d.sourceId;
 await storage.create({id,businessId:88,type:'document',title:`${id}.txt`,status:'ready',content:rebuilt.content,metadata:rebuilt.metadata,createdAt:'2026',updatedAt:'2026'});
 await storage.replaceChunks(88,id,rebuilt.chunks.map(c=>({chunkIndex:Number(c.chunk_index),content:String(c.content),metadata:c.metadata as Record<string,unknown>})));
 storage.completeSemanticIndex(88,id,storage.indexSnapshot(88,id)!,rebuilt.chunks.map(()=>v));
}
const statements={en:'You should bring the device serial number if one is available.',sv:'Du bör ta med enhetens serienummer om det finns tillgängligt.',
 de:'Sie sollten die Seriennummer des Geräts mitbringen, falls sie verfügbar ist.',es:'Deberías llevar el número de serie del dispositivo si está disponible.',
 fa:'اگر شماره سریال دستگاه موجود است، بهتر است آن را همراه بیاورید.',ar:'يُنصح بإحضار الرقم التسلسلي للجهاز إذا كان متاحًا.'};
const quote='Visitors should bring the device serial number if one is available.';
let serial=46888000000;
const cases=[...directConditionalQuestions.map(([language,question])=>({language,question,lexicalFailure:false})),
 {language:'en' as const,question:directConditionalQuestions[0][1],lexicalFailure:true}];
for(const {language,question,lexicalFailure}of cases)for(const channel of incidentChannels)test(`candidate native conditional ${language}/${channel}${lexicalFailure?'/lexical-failure':''}`,async t=>{
 const old=structuredClone(incidentConfig);b.reset();let embeddings=0,actions=0;const replies:string[]=[],stages:string[]=[],diagnostics:any[]=[];
 let generate: (p:any)=>Promise<any>;
 const recipient=String(++serial),service=new KnowledgeService(storage,storage,{supportsLocalSemanticSearch:true,embedQuery:async()=>{throw Error('Batch only');},embedDocuments:async queries=>{
  embeddings++;assert.equal(queries[0],question.replace(/؟/gu,'?').replace(/،/gu,',').replace(/‌/gu,' '));return queries.map(()=>qv);
 }});
 const forbidden=async()=>{actions++;throw Error('Unauthorized operation');};
 for(const method of ['log','info','warn','error']as const)t.mock.method(console,method,()=>{});
 try{
  Object.assign(incidentConfig,{id:88,businessId:88,businessName:fixture.businessName,services:fixture.services.map((s:any)=>({...s,id:'remote'})),defaultBookingService:'Remote Assessment'});
  t.mock.method(globalThis,'fetch',async(input,options)=>{const body=JSON.parse(String(options?.body));assert.equal(String(body.chat_id||body.to||body.recipient?.id),recipient);
   if(body.chat_id)body.chat_id='46700000001';else if(body.to)body.to='46700000001';else body.recipient.id='46700000001';
   replies.push(interceptedIncidentSend(input,{...options,body:JSON.stringify(body)}));return new Response(JSON.stringify({ok:true,result:{message_id:1},message_id:'synthetic',messages:[{id:'synthetic'}]}));});
  b.configure({postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:1000}),knowledgeSearch:async()=>{if(lexicalFailure)throw Error('Synthetic lexical failure');return[];},
   knowledgeSourceLanguages:id=>service.sourceLanguageHints(id),completeKnowledgeCorpus:(id,m)=>service.completeSmallCorpus(id,m),
   semanticKnowledgeSearchQueries:(id,queries,limit,options)=>{assert.equal(id,88);return service.semanticSearchQueries(id,queries,limit,options);},
   validateKnowledgeMatches:(id,m)=>service.validateMatches(id,m,{strictSources:true,captureRevision:true}),knowledgeRetrievalDiagnostic:d=>diagnostics.push(d),
   geminiGenerate:generate=async p=>{
    const instruction=p.config.systemInstruction;
    if(instruction.includes('language-routing classifier'))return{text:JSON.stringify({language,requestedReplyLanguage:null,confidence:.99})};
    assert.doesNotMatch(instruction,/retrieval query planner|SOURCE_LANGUAGE_QUERY/,'Existing direct admission requires no new planner');
    const data=JSON.parse(p.contents[0].parts[0].text);assert.ok(data.evidence.every((e:any)=>e.businessId===88));
    if(instruction.includes('UNIT EXTRACTION')){
     stages.push('extraction');const e=data.evidence.find((e:any)=>e.text.includes(quote));assert.ok(e);
     return{text:JSON.stringify({units:[{facetIds:['f1'],subject:'Visitors',predicate:'bring device serial number',value:statements[language],scope:'Cedar visitor preparation',
      modality:'recommended',negation:false,qualifiers:['if one is available'],language,text:statements[language],evidenceRefs:[{evidenceId:e.id,exactQuote:quote}]}]})};
    }
    assert.ok(instruction.includes('BATCH ENTAILMENT'));stages.push('verification');assert.equal(data.question,question.replace(/؟/gu,'?').replace(/،/gu,',').replace(/‌/gu,' '));
    return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,explicitAbsenceEvidence:false,negativeAbsence:false})),
     coverage:data.facets.map((f:any)=>({facetId:f.id,requestAligned:true,materialFactsComplete:true,incompletenessReason:'NONE',materialUnitIds:data.units.map((u:any)=>u.id),obligations:f.obligations.map((o:any)=>({obligationId:o.id,status:'COVERED',unitIds:data.units.map((u:any)=>u.id)}))}))})};
   },calendarAdapter:{getCalendarId:()=> 'synthetic',getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden,cancelAppointment:forbidden,updateAppointment:forbidden},recordAppointment:forbidden,cancelAppointmentRow:forbidden,updateAppointmentRow:forbidden});
  t.mock.method(Responses.prototype,'create',async(p:any)=>({output_text:(await generate({config:{systemInstruction:p.instructions},contents:[{parts:[{text:p.input[0].content}]}]})).text,status:'completed',output:[],usage:{input_tokens:10,output_tokens:10}}as any));
  assert.ok(wholeQuestionInformationPlan(question,true));await incidentInbound(b,channel,question,recipient);
  assert.equal(embeddings,1);assert.equal(actions,0);assert.deepEqual(stages,lexicalFailure?[]:['extraction','verification']);assert.equal(replies.length,1);
  assert.equal(replies[0].includes(statements[language]),!lexicalFailure);
  assert.equal(diagnostics.at(-1)?.retrievalOrigins.candidate,lexicalFailure?0:5);assert.equal(diagnostics.at(-1)?.retrievalOrigins.lexical,0);assert.equal(diagnostics.at(-1)?.retrievalOrigins.strictSemantic,0);
 }finally{Object.assign(incidentConfig,old);b.reset();}
});
