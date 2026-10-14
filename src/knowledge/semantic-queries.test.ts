import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { InMemoryKnowledgeStorage, KnowledgeService } from '../../knowledge';
import { documentChunks } from './documents/service';
import { CompatibleSemanticIndex } from './semantic-index';
import { confirmedTextLanguage, selectSemanticQueries, explicitlyWrongWorkflow, type SourceLanguage } from './semantic-queries';
const saved=JSON.parse(readFileSync(new URL('../../tests/fixtures/knowledge-semantic-calibration.json',import.meta.url),'utf8'));
const entries=saved.entries as Array<{input:any;vector:any}>;
const docEntries=entries.filter(e=>e.input.kind==='document');
const query=(language:string,planned=false)=>entries.find(e=>e.input.kind==='query'&&(planned?e.input.form==='saved-real-source-language-plan'&&e.input.originatingCustomerLanguage===language:e.input.form==='original-compound'&&e.input.language===language))!;
async function fixture(mutate?: (s:InMemoryKnowledgeStorage)=>Promise<void>){
 const storage=new InMemoryKnowledgeStorage();const calls:string[][]=[];
 for(const [i,e] of docEntries.entries()){
  const data=documentChunks([{text:e.input.text,section:'Calibration'}],e.input.filename||e.input.role);
  await storage.create({id:'doc-'+i,businessId:77,type:'document',status:'ready',title:e.input.filename||e.input.role,createdAt:'2026-10-13',updatedAt:'2026-10-13',content:data.content,metadata:data.metadata});
  await storage.replaceChunks(77,'doc-'+i,data.chunks.map(c=>({chunkIndex:Number(c.chunk_index),content:String(c.content),metadata:c.metadata as any})));
 }
 let count=0;
 const provider={supportsLocalSemanticSearch:true,embedQuery:async()=>{throw Error('Must use bounded query batch');},embedDocuments:async(texts:string[])=>{
  calls.push(texts);if(++count===2&&mutate)await mutate(storage);
  return texts.map(text=>{const e=entries.find(e=>e.input.text===text);assert.ok(e,`Unexpected input: ${text}`);return structuredClone(e.vector);});
 }};
 return{storage,calls,provider,service:new KnowledgeService(storage,storage,provider)};
}
for(const language of ['sv','en','de','es','fa','ar'])test(`saved real ${language} vector + Swedish planner vector recover gold at unchanged .55`,async()=>{
 const f=await fixture();const original=query(language).input.text;const planned=query(language,true).input.text;
 const languages=await f.service.sourceLanguageHints(77);assert.deepEqual(languages,['sv']);
 const selected=selectSemanticQueries(original,[planned],languages);assert.deepEqual(selected,[original,planned]);
 const matches=await f.service.semanticSearchQueries(77,selected,5);
 assert.ok(matches.some(m=>m.text!.includes('37 timmar')&&m.text!.includes('TALL-742')));
 assert.ok(matches.every(m=>m.businessId===77&&Number(m.score)>=.55&&m.metadata?.documentRevision));
 assert.ok(matches.every(m=>!explicitlyWrongWorkflow(m.text!,original)));
 assert.equal(new Set(matches.map(m=>`${m.sourceId}:${m.text}`)).size,matches.length);assert.ok(matches.length<=5);
 assert.equal(f.calls.length,2,'One query API batch + one cold corpus batch; no repeated corpus embedding per query');
 assert.deepEqual(f.calls[0],selected);
});
test('hard negatives above .55 are excluded for customers, but remain eligible for their own workflow',async()=>{
 const f=await fixture();const q=query('fa',true);const chunks=docEntries.map((e,i)=>({sourceId:'raw-'+i,businessId:77,text:e.input.text,metadata:{}}));
 const raw=await new CompatibleSemanticIndex().search(77,chunks,q.vector,f.provider,5,.55);
 assert.ok(raw.some(m=>m.text!.includes('personalens interna utbildningspass')&&m.score!>=.55));
 const filtered=await f.service.semanticSearchQueries(77,[query('fa').input.text,q.input.text]);
 assert.ok(filtered.every(m=>!m.text!.includes('personalens interna utbildningspass')));
 const training=docEntries.find(e=>e.input.role==='hard-negative-other-workflow-cancellation')!.input.text;
 assert.equal(explicitlyWrongWorkflow(training,'What notice is required for staff training?'),false);
});
test('query selection preserves original, deduplicates forms/prefixes, prefers mixed source languages, caps extras at two',()=>{
 const original='What is the CUSTOMER parking gate?';
 const sv='Vilken märkning har kundparkeringens grind?';const de='Welche Kennzeichnung hat das Tor zum Kundenparkplatz vor dem Termin?';
 assert.deepEqual(selectSemanticQueries(original,['what is the customer parking gate!',sv,'Which parking gate is for the customer?',de,'more'],['sv','de']),[original,sv,de]);
 const long=query('en').input.text;assert.equal(selectSemanticQueries(long,[long.slice(0,120),query('en',true).input.text],['sv']).length,2);
});
test('unknown language has no Swedish default or business-locale assumption',()=>{
 assert.equal(confirmedTextLanguage('123 BJORK-915'),null);
 assert.deepEqual(selectSemanticQueries('original',['de unknown','en unknown'],[]),['original','de unknown','en unknown']);
});
test('mixed current sources yield content-confirmed hints; spoofed metadata, foreign/unready sources do not',async()=>{
 const f=await fixture();
 const de='Ein Termin muss mindestens 91 Stunden vor dem Termin abgesagt werden.';
 const en='The customer must cancel the appointment at least 37 hours before the visit.';
 const add=async(id:string,text:string,businessId=77,status:any='ready')=>{const d=documentChunks([{text,section:'Text'}],id);await f.storage.create({id,businessId,status,type:'document',title:id,content:d.content,metadata:{...d.metadata,language:'ar',verifiedSourceLanguage:'ar'},createdAt:'2026',updatedAt:'2026'});};
 await add('mixed',de+'\n'+en);await add('foreign','ساعت قبل نوبت پارکینگ مشتریان',88);await add('failed','ساعة قبل الموعد العملاء سيارات',77,'failed');
 const langs=await f.service.sourceLanguageHints(77);assert.deepEqual(new Set(langs),new Set(['sv','de','en']));
});
for(const change of ['delete','revise','failed'] as const)test(`source ${change} during shared corpus embedding rejects the whole planned result`,async()=>{
 const f=await fixture(async storage=>{
  if(change==='delete')await storage.delete(77,'doc-0');else {const src=(await storage.list(77)).find(s=>s.id==='doc-0')!;await storage.create({...src,status:change==='failed'?'failed':'ready',content:src.content+' Changed revision.'});}
 });
 assert.deepEqual(await f.service.semanticSearchQueries(77,[query('fa').input.text,query('fa',true).input.text]),[]);
});
test('foreign source results and stale captured document revisions are rejected',async()=>{
 const f=await fixture();const matches=await f.service.semanticSearchQueries(77,[query('fa').input.text,query('fa',true).input.text]);
 assert.deepEqual(await f.service.validateMatches(88,matches),[]);
 for(const m of matches)await f.storage.delete(77,m.sourceId);
 assert.deepEqual(await f.service.validateMatches(77,matches),[]);
});
test('batch bound, query deduplication, cache reuse and oversized extras fail closed',async()=>{
 const f=await fixture();const q=query('fa').input.text;const planned=query('fa',true).input.text;
 await f.service.semanticSearchQueries(77,[q,planned,planned,planned]);assert.equal(f.calls[0].length,2);
 await f.service.semanticSearchQueries(77,[q,planned]);assert.equal(f.calls.length,3,'Warm corpus reused; one further query batch only');
 assert.deepEqual(await f.service.semanticSearchQueries(77,[q,'x'.repeat(121)]),[]);assert.equal(f.calls.length,3);
});
test('mixed customer and staff content remains available for atomic workflow grounding',()=>{
 const mixed='Staff training requires at least 37 hours notice; this is not for customers. Customer parking is behind the studio.';
 assert.equal(explicitlyWrongWorkflow(mixed,'Where is customer parking?'),false);
});
test('source language optimization times out without blocking retrieval or trusting a locale',async()=>{
 const f=await fixture();f.storage.list=()=>new Promise(()=>{});
 assert.deepEqual(await f.service.sourceLanguageHints(77),[]);
});

test('short planner language labels retain source-language query even when distinctive-token heuristic cannot',()=>{
 const plans=['appointment cancellation deadline','deadline to cancel my appointment','avbokningsfrist för tid'];
 assert.equal(confirmedTextLanguage(plans[2]),null);
 assert.deepEqual(selectSemanticQueries('What cancellation deadline applies?',plans,['sv'],{'avbokningsfrist för tid':'sv'}),['What cancellation deadline applies?',plans[2],plans[0]]);
});
for (const [language,query] of [['sv','avbokningsfrist'],['en','cancellation deadline'],['de','Stornierungsfrist'],['es','plazo de cancelación'],['fa','مهلت لغو'],['ar','مهلة الإلغاء']] as const)test(`explicit ${language} short-query label survives original-plus-two bound`,()=>{
 const original='Original question';const selected=selectSemanticQueries(original,['other query',query,'third query'],[language],{[query]:language});
 assert.equal(selected[0],original);assert.equal(selected[1],query);assert.equal(selected.length,3);
});
test('metadata is bounded to exact planned queries, supported language codes and mixed-source coverage',()=>{
 const original='Question';const plans=['parking deadline','avbokningsfrist','Stornierungsfrist'];
 const tags:any={'parking deadline':'unsupported','avbokningsfrist':'sv','Stornierungsfrist':'de','injected query':'ar'};
 assert.deepEqual(selectSemanticQueries(original,plans,['sv','de'],tags),[original,'avbokningsfrist','Stornierungsfrist']);
 assert.deepEqual(selectSemanticQueries(original,['unknown','avbokningsfrist'],[],{'avbokningsfrist':'sv'}),[original,'unknown','avbokningsfrist'],'No Swedish assumption for unknown source languages');
});
test('equivalent tagged query forms cannot duplicate queries or exceed the cap',()=>{
 const original='Customer question';const plans=['avbokningsfrist','AVBOKNINGSFRIST!','other','other'];
 assert.deepEqual(selectSemanticQueries(original,plans,['sv'],{'avbokningsfrist':'sv','AVBOKNINGSFRIST!':'sv'}),[original,'avbokningsfrist','other']);
});

test('untrusted metadata cannot import inherited language labels or unplanned query strings',()=>{
 const inherited=Object.create({'avbokningsfrist':'sv'});
 assert.deepEqual(selectSemanticQueries('Question',['first','avbokningsfrist'],['sv'],inherited),['Question','first','avbokningsfrist']);
 assert.deepEqual(selectSemanticQueries('Question',['first','avbokningsfrist'],['sv'],{'injected':'sv'}),['Question','first','avbokningsfrist']);
});
test('malformed planner metadata leaves legacy ordering and bounded query behavior intact',()=>{
 for(const bad of [null,[],{'avbokningsfrist':{}},{'avbokningsfrist':99}])assert.deepEqual(selectSemanticQueries('Question',['first','avbokningsfrist'],['sv'],bad as any),['Question','first','avbokningsfrist']);
});
