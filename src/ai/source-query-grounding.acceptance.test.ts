import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { InMemoryKnowledgeStorage, KnowledgeService } from '../../knowledge';
import { documentChunks } from '../knowledge/documents/service';
process.env.NODE_ENV='test';process.env.DOTENV_CONFIG_PATH='/dev/null';process.env.AI_PROVIDER='gemini';process.env.GEMINI_API_KEY='synthetic-offline';
globalThis.fetch=async()=>{throw Error('Offline acceptance forbids provider network');};
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
const calibration=JSON.parse(readFileSync(new URL('../../tests/fixtures/knowledge-semantic-calibration.json',import.meta.url),'utf8'));
const entries=calibration.entries as any[];
const orig=entries.find(e=>e.input.kind==='query'&&e.input.language==='fa'&&e.input.form==='original-compound');
const planned=entries.find(e=>e.input.originatingCustomerLanguage==='fa');
const text='نوبت باید حداقل ۳۷ ساعت قبل لغو شود. شناسه دروازه پارکینگ مشتریان TALL-742 است. سرویس Introduktionsbesök مدت ۴۵ دقیقه دارد.';
const config={id:77,businessName:'Synthetic Fjord Studio',language:'fa',services:[{name:'Introduktionsbesök',durationMinutes:45}],systemPrompt:''};
afterEach(()=>b.reset());
test('shared Website information path uses original + measured source query, actual semantic code, fresh provenance and zero tools',async t=>{
 b.reset();for(const m of ['log','warn','error','info'] as const)t.mock.method(console,m,()=>undefined);
 const storage=new InMemoryKnowledgeStorage();
 for(const [i,e] of entries.filter(e=>e.input.kind==='document').entries()){
  const d=documentChunks([{text:e.input.text,section:'SavedCalibration'}],e.input.filename||e.input.role);
  await storage.create({id:'source-'+i,businessId:77,type:'document',status:'ready',title:e.input.filename||e.input.role,content:d.content,metadata:d.metadata,createdAt:'2026',updatedAt:'2026'});
  await storage.replaceChunks(77,'source-'+i,d.chunks.map(c=>({chunkIndex:Number(c.chunk_index),content:String(c.content),metadata:c.metadata as any})));
  storage.completeSemanticIndex(77,'source-'+i,storage.indexSnapshot(77,'source-'+i)!,d.chunks.map(()=>e.vector));
 }
 const service=new KnowledgeService(storage,storage,{supportsLocalSemanticSearch:true,embedQuery:async()=>{throw Error('Use batched query path');},embedDocuments:async texts=>texts.map(text=>{const e=entries.find(e=>e.input.text===text);assert.ok(e);return e.vector;})});
 const retrieval:any[]=[];const requests:any[]=[];const forbidden=async()=>{assert.fail('Information turns cannot execute tools');};
 b.configure({semanticLanguageResolver:async()=>({language:'fa',confidence:1}),knowledgeSourceLanguages:id=>service.sourceLanguageHints(id),knowledgeSearch:async()=>[],
  semanticKnowledgeSearchQueries:async(id,queries,limit)=>{assert.equal(id,77);assert.deepEqual(queries,[orig.input.text,planned.input.text]);const matches=await service.semanticSearchQueries(id,queries,limit);retrieval.push(...matches);return matches;},
  validateKnowledgeMatches:(id,m)=>service.validateMatches(id,m),
  geminiGenerate:async(p:any)=>{if(p.config.systemInstruction.includes('retrieval query planner'))return{text:JSON.stringify({canonicalMeaning:'appointment cancellation notice, customer parking and service duration',queries:[planned.input.text]})};requests.push(p);return{text};},
  assessBusinessSupportGrounding:async()=>({hasBusinessFactualClaims:true,allBusinessClaimsSupported:true,claims:[
   {claim:text.split('. ')[0]+'.',candidateQuote:text.split('. ')[0]+'.',claimKind:'OTHER',requiresBusinessEvidence:true,supported:true,evidence:[{source:'retrieved_knowledge',quote:'En bokad tid ska avbokas senast 37 timmar före besöket.'}]},
   {claim:text.split('. ')[1]+'.',candidateQuote:text.split('. ')[1]+'.',claimKind:'OTHER',requiresBusinessEvidence:true,supported:true,evidence:[{source:'retrieved_knowledge',quote:'parkeringsgrindens märkning är TALL-742.'}]},
   {claim:text.split('. ')[2],candidateQuote:text.split('. ')[2],claimKind:'OTHER',requiresBusinessEvidence:true,supported:true,evidence:[{source:'structured_business_config',quote:'"durationMinutes": 45'}]},
  ]}),assessBusinessClaimEntailment:async()=>({relation:'ENTAILED',claimKind:'OTHER',explicitAbsenceEvidence:false}),
  calendarAdapter:{getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden},recordAppointment:forbidden,postProcess:forbidden,
 });
 const answer=await b.promptAuditWeb({chatId:'measured-sv-plan',message:orig.input.text},config);
 assert.equal(answer.body.text,text);assert.ok(retrieval.length&&retrieval.every(m=>m.businessId===77&&m.metadata.documentRevision));
 assert.equal(requests.length,1);assert.equal(requests[0].config.tools?.length||0,0);
 assert.match(requests[0].config.systemInstruction,/minimum\/at least is not maximum\/at most/u);
 assert.match(requests[0].config.systemInstruction,/untrusted_document_text:/u);
 assert.doesNotMatch(requests[0].config.systemInstruction,/personalens interna utbildningspass|varugrinden|lagerinventering|Personalparkeringen/u);
});
