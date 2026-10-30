import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {configuredServiceEvidence} from './configured-service-evidence';
import {independentServiceProposal,documentQuestionProjection,DOCUMENT_AUTHORITY_EXTRACTION} from './source-aware-service-proposal';
import {configuredServiceScopeSupported} from './configured-service-evidence';
import {buildEvidenceFirstAnswer,answerEvidence,parseRequestedFacets,InformationBudget,publishableKnowledgeManifest,completeKnowledgeManifest,NATIVE_V2_MIXED_DOCUMENTARY_GUIDANCE,FOREGROUND_UNIT_VERIFICATION_INSTRUCTION,type Evidence} from './business-information-answer-plan';
import {runAccuracyFirstNative,nativeKnowledgeTiming} from './knowledge-timing-policy';
import {knowledgeStructuredOutput} from './knowledge-answer-protocol';
import {compactKnowledgeVerifierInput} from './knowledge-verifier-input';
import {generateWithOpenAi} from './providers/openai';

const question='I am considering booking a Video Consultation. What does it cost, how long does it last, and can it replace an in-person visit?';
const facets=parseRequestedFacets([{subject:'requested information',attribute:'cost, duration and replacement',questionType:'description',obligations:[{description:question,questionType:'description'}]}]).facets;
const catalog=configuredServiceEvidence(77,[{name:'Video Consultation',price:300,currency:'SEK',durationMinutes:60}])!;
const doc:Evidence={id:'e1',businessId:77,sourceId:'pdf',chunkId:'chunk',version:'current',text:'Digital information calls are used only for initial information. They do not automatically replace an in-person visit, and not all matters can be handled digitally.'};

test('separate catalog proposal uses exactly one named active record, never guessed service identity',()=>{
 const result=independentServiceProposal(question,'en',facets,[doc,catalog]);
 assert.ok(result);assert.equal(result.unit.text,'Video Consultation costs 300 SEK and lasts 60 minutes.');
 assert.equal(result.unit.evidenceRefs[0].sourceId,'configured-services:77');
 assert.equal(independentServiceProposal('What does a consultation cost?','en',facets,[doc,catalog]),null);
 assert.equal(independentServiceProposal('Does Video Consultation include aftercare and parking?','en',facets,[doc,catalog]),null);
 assert.equal(independentServiceProposal('What does Video ConsultationPlus cost?','en',facets,[doc,catalog]),null);
 assert.equal(independentServiceProposal(question,'en',facets,[{...doc,businessId:88},catalog]),null);
 for(const services of [[{name:'Video Consultation',price:300,currency:'SEK'}],[{name:'Video Consultation',price:-1,currency:'SEK',durationMinutes:60}],[{name:'Video Consultation',price:300,currency:'SEK',durationMinutes:60},{name:'Video Consultation',price:400,currency:'SEK',durationMinutes:60}]]){
  const e=configuredServiceEvidence(77,services)!;assert.equal(independentServiceProposal(question,'en',facets,[doc,e]),null);
 }
});

test('document query projection isolates catalog identity without changing source text or verifier request',()=>{
 const context={question,facets,history:[{text:'Video Consultation'}]};
 const projected:any=documentQuestionProjection(context,'Video Consultation');
 assert.doesNotMatch(JSON.stringify(projected),/Video Consultation/);assert.match(projected.question,/can it replace an in-person visit/);
 assert.equal(projected.facets[0].id,facets[0].id);assert.match(context.question,/Video Consultation/);
 assert.match(projected.question,/\[question subject\]/);
 assert.doesNotMatch(DOCUMENT_AUTHORITY_EXTRACTION,/catalog|configured service|separate catalog/iu);
 assert.match(DOCUMENT_AUTHORITY_EXTRACTION,/actual text/);
});

test('a question placeholder cannot become independently publishable source scope',()=>{
 const unit:any={subject:'Digital information calls',predicate:'purpose',value:'initial information',scope:'document',qualifiers:['Not the [question subject]'],text:'Digital information calls are used only for initial information.',evidenceRefs:[{evidenceId:'e1'}]};
 assert.equal(configuredServiceScopeSupported(unit,[doc,catalog]),false);
});

test('durable complete-coverage callers retain the original extraction path',async()=>{
 let calls=0;
 const manifest=await buildEvidenceFirstAnswer({question,language:'en',facets,evidence:[doc,catalog],authoritativeEvidence:'{}',businessTone:{},history:[],budget:new InformationBudget(),foreground:true,requireCompleteCoverage:true,current:async()=>true,
  generate:async(stage,instruction,data:any)=>{calls++;assert.equal(stage,'extraction');assert.equal(data.authorityScope,undefined);assert.equal(data.question,question);assert.ok(data.evidence.some((e:any)=>e.id==='configured-services'));throw Error('information_deadline');}});
 assert.equal(calls,1);assert.equal(manifest.units.length,0);
});

test('foreground producer schema enforces existing parser lengths and reserves the separate catalog slot',async()=>{
 const {knowledgeStructuredOutput}=await import('./knowledge-answer-protocol');
 const schema:any=knowledgeStructuredOutput('extraction',false,['f1'],5).schema;
 const units=schema.properties.units,fields=units.items.properties;
 assert.equal(units.maxItems,5);assert.equal(fields.predicate.maxLength,240);assert.equal(fields.subject.maxLength,240);
 assert.equal(fields.value.maxLength,600);assert.equal(fields.scope.maxLength,400);assert.equal(fields.text.maxLength,800);
 assert.equal(fields.qualifiers.maxItems,8);assert.equal(fields.qualifiers.items.maxLength,300);
 assert.equal(fields.evidenceRefs.maxItems,4);assert.equal(fields.evidenceRefs.items.properties.exactQuote.maxLength,2400);
 assert.equal((knowledgeStructuredOutput('extraction').schema as any).properties.units.maxItems,undefined,'Unscoped legacy wire contract stays unchanged');
 assert.throws(()=>knowledgeStructuredOutput('extraction',false,['f1'],7));
});

for(const mode of ['normal','reject-catalog','document-timeout','revoke-catalog','explicit-binding'] as const)test(`source-aware proposal retains independent verification and freshness: ${mode}`,async()=>{
 let extracted=false,verified=false;const seen:any[]=[];
 const evidence=mode==='explicit-binding'?[{...doc,text:'Video Consultation is used only for initial information. Video Consultation does not automatically replace an in-person visit, and not all matters can be handled digitally.'},catalog]:[doc,catalog];
 const manifest=await buildEvidenceFirstAnswer({question,language:'en',facets,evidence,authoritativeEvidence:JSON.stringify({services:[{name:'Video Consultation',price:300,currency:'SEK',durationMinutes:60}]}),businessTone:{},history:[],budget:new InformationBudget(),foreground:true,omitModelEvidenceVersions:true,current:async()=>true,
  revalidateEvidence:async()=>mode==='revoke-catalog'&&extracted?[evidence[0]]:evidence,
  generate:async(stage,instruction,data:any)=>{
   seen.push({stage,data});
   if(stage==='extraction'){
    assert.equal(verified,false);assert.equal(data.authorityScope,'document_only');assert.doesNotMatch(JSON.stringify({question:data.question,facets:data.facets,history:data.relevantHistory}),/Video Consultation/);
    assert.equal(data.separatelyProposedCatalogAttributes,undefined);
    assert.doesNotMatch(instruction,/configured service|catalog/iu);
    assert.deepEqual(data.evidence.map((e:any)=>e.id),['e1']);assert.equal(data.evidence[0].text,evidence[0].text,'Complete context, including all conditions, is retained');
    extracted=true;if(mode==='document-timeout')throw Error('information_deadline');
    return{text:JSON.stringify({oversized:false,units:[{facetIds:['f1'],subject:mode==='explicit-binding'?'Video Consultation':'Digital information calls',predicate:'purpose and limits',value:'initial information only; not automatic replacement; not all matters digital',modality:'descriptive',negation:true,scope:'documented offering',qualifiers:[],language:'en',text:evidence[0].text,evidenceRefs:[{evidenceId:'e1',exactQuote:evidence[0].text}]}]})};
   }
   if(stage==='verification'){
    assert.ok(extracted);verified=true;assert.ok(data.evidence.some((e:any)=>e.id==='e1'));assert.equal(data.question,question);assert.deepEqual(data.facets,facets);
    if(mode==='revoke-catalog')assert.ok(data.units.every((u:any)=>u.evidenceRefs.every((r:any)=>r.evidenceId!=='configured-services')));
    else assert.ok(data.units.some((u:any)=>u.evidenceRefs.some((r:any)=>r.evidenceId==='configured-services')),'Catalog proposal must pass the verifier too');
    return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:mode==='reject-catalog'&&u.evidenceRefs.some((r:any)=>r.evidenceId==='configured-services')?'UNKNOWN':'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:true,incompletenessReason:'NONE',materialUnitIds:data.units.map((u:any)=>u.id),obligations:[{obligationId:'f1.o1',status:'COVERED',unitIds:data.units.map((u:any)=>u.id)}]}]})};
   }
   return{text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})};
  }});
 assert.equal(verified,true);
 if(mode==='reject-catalog'||mode==='revoke-catalog')assert.doesNotMatch(manifest.text,/300|60 minutes/);
 else assert.match(manifest.text,/300 SEK and lasts 60 minutes/);
 if(mode==='document-timeout')assert.doesNotMatch(manifest.text,/used only for initial information/);
 if(mode==='explicit-binding')assert.equal(manifest.outcomes[0].status,'VERIFIED');
 else {assert.equal(manifest.outcomes[0].status,'PARTIAL');assert.equal(manifest.outcomes[0].materialFactsComplete,false);}
 if(mode==='normal')assert.match(manifest.text,/cannot confirm whether the document's information applies to Video Consultation/);
});

// These are deterministic publication controls, not provider entailment claims.
for(const mode of ['accepted','unknown-condition','negation','quantifier','missing-condition','wrong-alias','wrong-quote','revoke','changed','oversized','incomplete'] as const)
test(`atomic documentary inventory fails closed independently from catalog: ${mode}`,async()=>{
 const {pruneAnswerManifest}=await import('./business-information-answer-plan');
 const restriction={...doc,id:'e2',sourceId:'restriction',chunkId:'restriction',text:'Digital information calls are used only for initial information.'};
 const sources=[doc,restriction,catalog];
 const atom=(e:Evidence,text:string)=>({facetIds:['f1'],subject:'Digital information calls',predicate:'documented purpose',value:'information',modality:'descriptive',negation:false,scope:'documented offering',qualifiers:[],language:'en',text,evidenceRefs:[{evidenceId:e.id,exactQuote:e.text}]});
 const manifest=await buildEvidenceFirstAnswer({question,language:'en',facets,evidence:sources,authoritativeEvidence:'',businessTone:{},history:[],budget:new InformationBudget(),foreground:true,current:async()=>true,
 generate:async(stage,instruction,data:any)=>{
  if(stage==='extraction'){
   assert.match(instruction,/one independently assessable factual predicate/);
   assert.match(instruction,/never detach a conditional premise/);
   const units=[atom(doc,'Digital information calls do not automatically replace an in-person visit.'),atom(restriction,restriction.text)];
   if(mode==='wrong-alias')units[1].evidenceRefs[0].evidenceId='absent';
   if(mode==='wrong-quote')units[1].evidenceRefs[0].exactQuote='Invented quotation';
   if(mode==='negation')units[1].text='Digital information calls replace a visit.';
   if(mode==='quantifier')units[1].text='No matters can be handled digitally.';
   if(mode==='missing-condition')units[1].text='Digital information calls provide information.';
   return{text:JSON.stringify({oversized:mode==='oversized',units:mode==='oversized'?[]:units})};
  }
  if(stage==='verification')return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:u.id==='u3'&&['unknown-condition','negation','quantifier','missing-condition'].includes(mode)?'UNKNOWN':'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:mode!=='incomplete',incompletenessReason:mode==='incomplete'?'MISSING_RELEVANT_FACT':'NONE',materialUnitIds:data.units.map((u:any)=>u.id),obligations:[{obligationId:'f1.o1',status:'COVERED',unitIds:data.units.map((u:any)=>u.id)}]}]})};
  return{text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})};
 }});
 const final=mode==='revoke'||mode==='changed'?pruneAnswerManifest(manifest,[doc,...(mode==='changed'?[{...restriction,version:'new-revision'}]:[]),catalog]):manifest;
 assert.match(final.text,/300 SEK/,'Independent verified catalog survives');
 assert.equal(final.outcomes[0].status,'PARTIAL','No entailment-only completeness upgrade');
 if(['accepted','incomplete'].includes(mode))assert.equal(final.units.length,3);
 else assert.equal(final.units.length,1,'No orphaned documentary offering or restrictions');
});

test('coarse inventory deliberately withholds unrelated document atoms when a restriction fails',async()=>{
 const extra:Evidence={id:'e2',businessId:77,sourceId:'access',chunkId:'access',version:'v1',text:'Visitors may use the reception.'};
 const manifest=await buildEvidenceFirstAnswer({question,language:'en',facets,evidence:[doc,extra,catalog],authoritativeEvidence:'',businessTone:{},history:[],budget:new InformationBudget(),foreground:true,current:async()=>true,
 generate:async(stage,_instruction,data:any)=>{
  if(stage==='extraction')return{text:JSON.stringify({oversized:false,units:[doc,extra].map(e=>({facetIds:['f1'],subject:e===doc?'Digital information calls':'Visitors',predicate:'source fact',value:'source assertion',modality:'descriptive',negation:false,scope:'explicit source actor',qualifiers:[],language:'en',text:e.text,evidenceRefs:[{evidenceId:e.id,exactQuote:e.text}]}))})};
  if(stage==='verification')return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:u.id==='u2'?'UNKNOWN':'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:false,incompletenessReason:'MISSING_CONDITION',materialUnitIds:data.units.map((u:any)=>u.id),obligations:[{obligationId:'f1.o1',status:'UNRESOLVED',unitIds:[]}]}]})};
  return{text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})};
 }});
 assert.equal(manifest.units.length,1,'Conservative inventory includes unrelated documentary units');
 assert.match(manifest.text,/300 SEK/);assert.doesNotMatch(manifest.text,/reception/);
 assert.equal(manifest.outcomes[0].status,'PARTIAL');
});

// Saved genuine evidence is immutable. All changed proposals and judgments below
// are SCRIPTED contract controls, not proof of prompt efficacy or human gold.
function germanMixedFixture(){
 const root='docs/validation/shared-core-2026-10-22/de-ar-native-preparation-20261028/B-de/execution/';
 const bytes=readFileSync(root+'result.json');
 assert.equal(createHash('sha256').update(bytes).digest('hex'),JSON.parse(readFileSync(root+'result.seal.json','utf8')).resultSha256);
 const capture=JSON.parse(bytes.toString()),ex=capture.calls.find((c:any)=>c.stage==='extraction'),vc=capture.calls.find((c:any)=>c.stage==='verification');
 const output=(c:any)=>c.rawProviderResponse.output.flatMap((o:any)=>o.content??[]).filter((c:any)=>c.type==='output_text').map((c:any)=>c.text).join('');
 const context=JSON.parse(ex.request.input[0].content),vi=JSON.parse(vc.request.input[0].content);
 const evidence=answerEvidence(77,capture.retrieval.find((r:any)=>r.phase==='freshness').matches);
 evidence.push(configuredServiceEvidence(77,JSON.parse(vi.evidence.find((e:any)=>e.id==='configured-services').text).services)!);
 const original=JSON.parse(output(ex)),verdict=JSON.parse(output(vc));
 const noticeText=context.evidence[1].text;
 const notice=noticeText.slice(noticeText.indexOf('Observera:'),noticeText.indexOf('AdMotion Studios verkliga kundvillkor.')+'AdMotion Studios verkliga kundvillkor.'.length);
 const qualified=structuredClone(original);
 for(const u of qualified.units){
  u.text='Dem fiktiven Testdokument zufolge: '+u.text+' Dies sind keine tatsächlichen Geschäftsbedingungen.';
  u.scope+='; fiktives Testdokument, keine realen Geschäftsbedingungen';
  u.evidenceRefs.push({evidenceId:'e2',exactQuote:notice});
 }
 return{capture,ex,vc,context,vi,evidence,original,verdict,qualified,notice,output};
}

test('mixed adjunct has generic clause, necessary-context and factual-text scope requirements',()=>{
 assert.doesNotMatch(NATIVE_V2_MIXED_DOCUMENTARY_GUIDANCE,/German|parking|appointment|administrative|AdMotion|Nordpark|tenant/iu);
 for(const phrase of ['every independently asserted clause','procedural context only when requested or necessary','original conditions and modality','every coordinated restriction','fictional, hypothetical or test-only','actual factual text','never invent it or transfer it to an independent source'])assert.ok(NATIVE_V2_MIXED_DOCUMENTARY_GUIDANCE.includes(phrase));
 assert.ok(!DOCUMENT_AUTHORITY_EXTRACTION.includes(NATIVE_V2_MIXED_DOCUMENTARY_GUIDANCE));
});

test('original B-de exact SDK wire changes only documentary Extraction instructions; Verification stays byte-equivalent',async t=>{
 const f=germanMixedFixture(),seen:string[]=[];let allowed=false;
 const previous=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='synthetic-offline-only';
 t.mock.method(globalThis,'fetch',async(input,init)=>{
  assert.equal(String(input),'https://api.openai.com/v1/responses');
  const wire=JSON.parse(String(init?.body)),stage=wire.text.format.name==='odinlink_knowledge_extraction_v2'?'extraction':'verification';seen.push(stage);
  const saved=stage==='extraction'?f.ex:f.vc;
  const {max_output_tokens,service_tier,prompt_cache_options,...expected}=saved.request;
  assert.equal(max_output_tokens,8192);assert.equal(service_tier,'default');assert.deepEqual(prompt_cache_options,{mode:'implicit',ttl:'30m'});
  assert.deepEqual(wire,{...expected,instructions:stage==='extraction'?DOCUMENT_AUTHORITY_EXTRACTION+'\n'+NATIVE_V2_MIXED_DOCUMENTARY_GUIDANCE:expected.instructions});
  return new Response(JSON.stringify({object:'response',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:f.output(saved)}]}]}),{status:200,headers:{'Content-Type':'application/json'}});
 });
 try{await runAccuracyFirstNative(async()=>{
  const m=await buildEvidenceFirstAnswer({question:f.vi.question,language:'de',facets:parseRequestedFacets(f.vi.facets).facets,evidence:f.evidence,businessId:77,foreground:true,omitModelEvidenceVersions:true,extractionProtocol:'v2',verificationProtocol:'v2',authoritativeEvidence:f.vi.authoritativeEvidence,businessTone:f.context.businessTone,history:f.context.relevantHistory,budget:new InformationBudget(undefined,nativeKnowledgeTiming()),current:async()=>true,revalidateEvidence:async()=>f.evidence,
   generate:async(stage,instruction,data:any)=>{
    assert.ok(stage==='extraction'||stage==='verification','No composition or extra stage');
    if(stage==='extraction')assert.deepEqual(data,f.context);
    else{assert.deepEqual(compactKnowledgeVerifierInput(data),f.vi);assert.equal(instruction,FOREGROUND_UNIT_VERIFICATION_INSTRUCTION);}
    const saved=stage==='extraction'?f.ex:f.vc;
    return generateWithOpenAi({model:saved.request.model,reasoningEffort:'low',systemInstruction:instruction,messages:[{role:'user',content:JSON.stringify(stage==='verification'?compactKnowledgeVerifierInput(data):data)}],structuredOutput:knowledgeStructuredOutput(stage,false,stage==='extraction'?['f1']:undefined,stage==='extraction'?5:6,'v2')});
   }});
  allowed=publishableKnowledgeManifest(m,77);assert.equal(m.text,f.capture.replies[0]);assert.equal(completeKnowledgeManifest(m),false);
 },async()=>{});}finally{if(previous===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previous;}
 assert.deepEqual(seen,['extraction','verification']);assert.equal(allowed,true,'Saved output replay does not regrade the genuine source-scope FAIL');
});

const scopeModes=['native-mixed','non-native','background','natural','durable','literal','literal-fallback','witness','compact','nonmixed']as const;
for(const mode of scopeModes)test(`mixed producer adjunct scope: ${mode}`,async()=>{
 const f=germanMixedFixture();const calls:{stage:string;instruction:string}[]=[];
 const evidence=mode==='nonmixed'?f.evidence.filter(e=>e.id!=='configured-services'):mode==='literal-fallback'?f.evidence.map(e=>e.id==='e1'?{...e,text:e.text+'x'.repeat(2500)}:e):f.evidence;
 const work=async()=>{await buildEvidenceFirstAnswer({question:f.vi.question,language:'de',facets:parseRequestedFacets(f.vi.facets).facets,evidence,businessId:77,foreground:mode!=='background',omitModelEvidenceVersions:true,extractionProtocol:mode==='literal'||mode==='literal-fallback'?'literal-evidence-v1':'v2',verificationProtocol:mode==='witness'?'coverage-witness-v1':mode==='compact'?'compact-v1':'v2',requireCompleteCoverage:mode==='durable',...(mode==='natural'?{natural:{scope:{turnId:'mixed-scope-offline',businessId:77,question:f.vi.question,tone:{}},allowSinglePartial:false}}:{}),authoritativeEvidence:f.vi.authoritativeEvidence,businessTone:{},history:[],budget:new InformationBudget(undefined,mode==='non-native'?undefined:nativeKnowledgeTiming()),current:async()=>true,revalidateEvidence:async()=>evidence,
 generate:async(stage,instruction)=>{calls.push({stage,instruction});if(stage==='extraction')throw Error('information_deadline');return{text:'{}'};}});};
 if(mode==='non-native')await work();else await runAccuracyFirstNative(work,async()=>{});
 const extraction=calls.filter(c=>c.stage==='extraction');assert.equal(extraction.length,1,'No extraction retries');
 assert.equal(extraction[0].instruction.split(NATIVE_V2_MIXED_DOCUMENTARY_GUIDANCE).length-1,mode==='native-mixed'?1:0);
 assert.ok(calls.filter(c=>c.stage==='verification').length<=1,'Existing independent catalog verification may follow documentary failure');
 assert.ok(calls.filter(c=>c.stage!=='extraction').every(c=>!c.instruction.includes(NATIVE_V2_MIXED_DOCUMENTARY_GUIDANCE)));
 if(mode==='native-mixed')assert.equal(extraction[0].instruction,DOCUMENT_AUTHORITY_EXTRACTION+'\n'+NATIVE_V2_MIXED_DOCUMENTARY_GUIDANCE);
});

type MixedFault='none'|'scope-omitted'|'extra-supplement'|'missing-fact'|'invalid-quote'|'wrong-alias'|'unknown'|'contradicted'|'foreign'|'revoked'|'revised';
async function scriptedGermanMixed(fault:MixedFault='none'){
 const f=germanMixedFixture(),raw=structuredClone(f.qualified),events:any[]=[],stages:string[]=[];let result:{allowed:boolean;complete:boolean;manifest:Awaited<ReturnType<typeof buildEvidenceFirstAnswer>>;events:any[]}|undefined,reads=0;
 if(fault==='scope-omitted')raw.units[0].text=f.original.units[0].text;
 if(fault==='extra-supplement'){
  const sol=JSON.parse(readFileSync('docs/validation/shared-core-2026-10-22/sol-bde-extraction-preparation-20261028/execution/result.json','utf8'));
  raw.units.push(JSON.parse(sol.outputText).units[3]);
 }
 if(fault==='missing-fact')raw.units.pop();
 if(fault==='invalid-quote')raw.units[0].evidenceRefs[1].exactQuote=f.notice.replace('fi ktiv','fiktiv');
 if(fault==='wrong-alias')raw.units[0].evidenceRefs[1].evidenceId='absent';
 const evidence=fault==='foreign'?f.evidence.map(e=>e.id==='e1'?{...e,businessId:88}:e):f.evidence;
 await runAccuracyFirstNative(async()=>{
 const manifest=await buildEvidenceFirstAnswer({question:f.vi.question,language:'de',facets:parseRequestedFacets(f.vi.facets).facets,evidence,businessId:77,foreground:true,omitModelEvidenceVersions:true,extractionProtocol:'v2',verificationProtocol:'v2',authoritativeEvidence:f.vi.authoritativeEvidence,businessTone:{},history:[],budget:new InformationBudget(undefined,nativeKnowledgeTiming()),current:async()=>true,diagnostic:e=>events.push(e),revalidateEvidence:async()=>{
  reads++;return reads>1&&fault==='revoked'?evidence.filter(e=>e.id!=='e1'):reads>1&&fault==='revised'?evidence.map(e=>e.id==='e1'?{...e,version:'changed'}:e):evidence;
 },generate:async(stage,instruction,data:any)=>{
  stages.push(stage);
  if(stage==='extraction'){assert.equal(instruction,DOCUMENT_AUTHORITY_EXTRACTION+'\n'+NATIVE_V2_MIXED_DOCUMENTARY_GUIDANCE);return{text:JSON.stringify(raw)};}
  assert.equal(stage,'verification');assert.equal(instruction,FOREGROUND_UNIT_VERIFICATION_INSTRUCTION);assert.equal(data.question,f.vi.question);
  const ids=data.units.map((u:any)=>u.id),bad=fault==='extra-supplement'?ids.at(-1):['scope-omitted','unknown','contradicted'].includes(fault)?'u2':null;
  const falseComplete=['invalid-quote','wrong-alias'].includes(fault);
  return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:u.id===bad&&fault==='unknown'?'UNKNOWN':u.id===bad&&fault==='contradicted'?'CONTRADICTED':'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:!(fault==='scope-omitted'&&u.id===bad),relevant:!(fault==='extra-supplement'&&u.id===bad),languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:falseComplete,incompletenessReason:falseComplete?'NONE':fault==='scope-omitted'?'MISSING_CONDITION':fault==='missing-fact'?'MISSING_RELEVANT_FACT':'UNRESOLVED',materialUnitIds:ids.filter((id:string)=>id!==bad),obligations:[{obligationId:'f1.o1',status:falseComplete?'COVERED':'UNRESOLVED',unitIds:falseComplete?ids:[]}]}]})};
 }});
 result={manifest,allowed:publishableKnowledgeManifest(manifest,77),complete:completeKnowledgeManifest(manifest),events};
 },async()=>{});
 assert.ok(result);assert.ok(stages.filter(s=>s==='extraction').length===1);assert.ok(stages.filter(s=>s==='verification').length<=1);return result;
}
test('SCRIPTED qualified B-de retains four documentary facts, local/global scope and independent catalog PARTIAL',async()=>{
 const f=germanMixedFixture(),r=await scriptedGermanMixed();assert.equal(r.allowed,true);assert.equal(r.complete,false);assert.equal(r.manifest.units.length,5);
 for(const u of f.qualified.units)assert.ok(r.manifest.text.includes(u.text));
 assert.match(r.manifest.text,/300 SEK.*60 Minuten/);assert.match(r.manifest.text,/nicht bestätigen.*Video Consultation/u);
 assert.equal(r.manifest.units[0].text,'Video Consultation kostet 300 SEK und dauert 60 Minuten.','Fictional document scope does not transfer to catalog authority');
 assert.match(r.manifest.text,/ersten Besuch/);assert.match(r.manifest.text,/nur für einführende/);assert.match(r.manifest.text,/nicht automatisch/);assert.match(r.manifest.text,/Nicht alle Anliegen/);
});
for(const fault of ['scope-omitted','extra-supplement','missing-fact','invalid-quote','wrong-alias','unknown','contradicted','foreign','revoked','revised']as const)
 test(`SCRIPTED mixed producer preserves existing publication veto: ${fault}`,async()=>{
  const r=await scriptedGermanMixed(fault);assert.equal(r.complete,false);
  if(fault!=='missing-fact')assert.equal(r.allowed,false);
  if(fault==='extra-supplement')assert.ok(r.events.some(e=>e.reason==='NOT_RELEVANT'));
  if(fault==='invalid-quote'||fault==='wrong-alias')assert.ok(r.events.some(e=>e.reason==='INVALID_CITATION'));
  if(fault==='missing-fact'){assert.equal(r.manifest.outcomes[0].materialFactsComplete,false);assert.equal(r.manifest.outcomes[0].obligations[0].status,'UNRESOLVED');assert.equal(r.manifest.units.length,4,'A missing requested fact cannot count as positive four-fact acceptance');}
 });

// Explicit procedure questions remain eligible: this is no topic/keyword blacklist.
for(const scenario of [
 {id:'both procedures requested',request:'Where are available times and prices maintained?',source:'Available times and prices are maintained in the service register.',text:'Available times and prices are maintained in the service register.',modality:'descriptive',reject:false},
 {id:'only price procedure requested',request:'Where are prices maintained?',source:'Available times and prices are maintained in the service register.',text:'Prices are maintained in the service register.',modality:'descriptive',reject:false},
 {id:'unrequested independent clause',request:'Where are prices maintained?',source:'Available times and prices are maintained in the service register.',text:'Available times and prices are maintained in the service register.',modality:'descriptive',reject:true},
 {id:'necessary procedural condition',request:'Can visitors enter after hours?',source:'Visitors may enter after hours only after collecting an access code from reception.',text:'Visitors may enter after hours only after collecting an access code from reception.',modality:'permitted',reject:false},
 {id:'missing procedural condition',request:'Can visitors enter after hours?',source:'Visitors may enter after hours only after collecting an access code from reception.',text:'Visitors may enter after hours.',modality:'permitted',reject:true},
 {id:'directly applicable conditional recommendation',request:'How should visitors prepare when sensitive to noise?',source:'Visitors sensitive to noise are advised to request a quiet room.',text:'Visitors sensitive to noise are advised to request a quiet room.',modality:'recommended',reject:false},
]as const)test(`SCRIPTED mixed responsiveness distinction: ${scenario.id}`,async()=>{
 const q='What does Video Consultation cost and how long does it last? '+scenario.request;
 const fs=parseRequestedFacets([{subject:'requested information',attribute:'full question',questionType:'description',obligations:[{description:q,questionType:'description'}]}]).facets;
 const source={...doc,text:scenario.source};let outcome:any;
 await runAccuracyFirstNative(async()=>{
 const manifest=await buildEvidenceFirstAnswer({question:q,language:'en',facets:fs,evidence:[source,catalog],businessId:77,foreground:true,omitModelEvidenceVersions:true,extractionProtocol:'v2',verificationProtocol:'v2',authoritativeEvidence:'',businessTone:{},history:[],budget:new InformationBudget(undefined,nativeKnowledgeTiming()),current:async()=>true,revalidateEvidence:async()=>[source,catalog],
 generate:async(stage,instruction,data:any)=>{
  if(stage==='extraction'){
   assert.equal(instruction,DOCUMENT_AUTHORITY_EXTRACTION+'\n'+NATIVE_V2_MIXED_DOCUMENTARY_GUIDANCE);
   assert.ok(data.question.includes(scenario.request));assert.deepEqual(data.evidence,[{id:'e1',businessId:77,text:scenario.source}]);
   return{text:JSON.stringify({oversized:false,units:[{facetIds:['f1'],subject:'Visitors',predicate:'documented arrangement',value:scenario.text,modality:scenario.modality,negation:false,scope:'source-bound condition',qualifiers:[],language:'en',text:scenario.text,evidenceRefs:[{evidenceId:'e1',exactQuote:scenario.source}]}]})};
  }
  assert.equal(stage,'verification');assert.equal(instruction,FOREGROUND_UNIT_VERIFICATION_INSTRUCTION);assert.equal(data.question,q);
  return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:!(scenario.id==='missing procedural condition'&&u.id==='u2'),relevant:!(scenario.id==='unrequested independent clause'&&u.id==='u2'),languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:!scenario.reject,incompletenessReason:scenario.reject?'MISSING_CONDITION':'NONE',materialUnitIds:scenario.reject?['u1']:data.units.map((u:any)=>u.id),obligations:[{obligationId:'f1.o1',status:scenario.reject?'UNRESOLVED':'COVERED',unitIds:scenario.reject?[]:data.units.map((u:any)=>u.id)}]}]})};
 }});outcome={manifest,allowed:publishableKnowledgeManifest(manifest,77)};
 },async()=>{});
 assert.equal(outcome.allowed,!scenario.reject);
 if(!scenario.reject)assert.ok(outcome.manifest.text.includes(scenario.text));else assert.ok(!outcome.manifest.text.includes(scenario.text));
});
