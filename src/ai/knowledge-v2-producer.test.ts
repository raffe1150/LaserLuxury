/** Producer-contract and consumer-safety controls only. Hypothetical responses
 * are SCRIPTED; these tests do not measure the prompt's real-model efficacy. */
import test,{after}from'node:test';import assert from'node:assert/strict';import{readFileSync,writeFileSync}from'node:fs';
import{buildEvidenceFirstAnswer,answerEvidence,parseRequestedFacets,InformationBudget,publishableKnowledgeManifest,completeKnowledgeManifest,FOREGROUND_UNIT_EXTRACTION_INSTRUCTION,FOREGROUND_UNIT_VERIFICATION_INSTRUCTION,NATIVE_V2_PRODUCER_GUIDANCE,NATIVE_V2_QUESTION_RESPONSIVENESS_GUIDANCE,NATIVE_V2_MIXED_DOCUMENTARY_GUIDANCE}from'./business-information-answer-plan';
import{runAccuracyFirstNative,nativeKnowledgeTiming}from'./knowledge-timing-policy';import{knowledgeStructuredOutput}from'./knowledge-answer-protocol';import{compactKnowledgeVerifierInput}from'./knowledge-verifier-input';import{configuredServiceEvidence}from'./configured-service-evidence';
const base='docs/validation/shared-core-2026-10-22',records:any[]=[];
function fixture(id:'C-fa'|'A-en'|'B-en'){
 const file=id==='C-fa'?'native-four-language-revalidation-20261027/C-fa/result.json':id==='A-en'?'aen-accuracy-first-acceptance-20261025/A-en.result.json':'ben-direct-acceptance-20261025/B-en.result.json';
 const saved=JSON.parse(readFileSync(base+'/'+file,'utf8')),ex=saved.state.calls.find((c:any)=>c.stage==='extraction'),vc=saved.state.calls.find((c:any)=>c.stage==='verification'),context=JSON.parse(ex.request.input[0].content),vi=JSON.parse(vc.request.input[0].content),proposal=JSON.parse(ex.outputText);
 const fresh=saved.retrieval.filter((x:any)=>x.phase==='freshness').at(-1).matches;
 const evidence=answerEvidence(77,vi.evidence.filter((e:any)=>e.id!=='configured-services').map((e:any)=>{const m=fresh.find((m:any)=>m.text.trim()===e.text.trim());assert.ok(m);return{...m,text:e.text};}));
 const catalog=vi.evidence.find((e:any)=>e.id==='configured-services');if(catalog)evidence.push(configuredServiceEvidence(77,JSON.parse(catalog.text).services)!);
 return{saved,ex,vc,context,vi,proposal,evidence};
}
after(()=>{if(process.env.ODINLINK_V2_PRODUCER_RESULTS)writeFileSync(process.env.ODINLINK_V2_PRODUCER_RESULTS,JSON.stringify({providerCalls:0,kind:'SCRIPTED_PRODUCER_AND_VERIFIER_CONTROLS_NOT_PROMPT_EFFICACY',records},null,2),{flag:'wx'});});
type Fault='none'|'original-capture'|'invalid-quote'|'extra-supplement'|'missing-reservation'|'invented-fee'|'unknown'|'missing-condition'|'invented-permission'|'revoked'|'timeout';
async function exercise(id:'C-fa'|'A-en'|'B-en',fault:Fault='none',native=true,options:{literal?:boolean;durable?:boolean}={}){
 const f=fixture(id),raw=structuredClone(f.proposal),stages:string[]=[],instructions:any[]=[],events:any[]=[];let reads=0,result:any;
 // New hypothetical producer fixture only. No runtime proposal filtering exists.
 if(id==='C-fa'&&fault!=='original-capture'&&fault!=='extra-supplement')raw.units=raw.units.slice(1);
 if(fault==='extra-supplement'){
  const t=f.evidence[0].text,start=t.indexOf('För besökare som kommer med bil fi nns'),end=t.indexOf('AdMotion Studio erbjuder inte gratis parkering');
  raw.units[0].evidenceRefs=[{evidenceId:'e1',exactQuote:t.slice(start,end).trimEnd()}];
 }
 if(fault==='missing-reservation')raw.units=raw.units.slice(0,1);
 if(fault==='invalid-quote')raw.units[0].evidenceRefs[0].exactQuote='AdMotion Studio erbjuder gratis parkering.';
 if(fault==='invented-fee'){const unit=structuredClone(raw.units[0]);unit.text='هزینه پارکینگ Nordpark برابر با 999 SEK است.';unit.negation=false;raw.units.push(unit);}
 if(fault==='missing-condition')raw.units[0].text='You must follow preparation instructions before every visit.';
 if(fault==='invented-permission')raw.units[2].text='You may drink water in treatment rooms.';
 if(options.literal)for(const u of raw.units)u.evidenceRefs=u.evidenceRefs.map((r:any)=>({evidenceId:r.evidenceId}));
 const work=async()=>{
 const manifest=await buildEvidenceFirstAnswer({question:f.vi.question,language:f.vi.requestedLanguage,facets:parseRequestedFacets(f.vi.facets).facets,evidence:f.evidence,businessId:77,foreground:true,omitModelEvidenceVersions:true,extractionProtocol:options.literal?'literal-evidence-v1':'v2',verificationProtocol:'v2',requireCompleteCoverage:options.durable,authoritativeEvidence:f.vi.authoritativeEvidence,businessTone:f.context.businessTone,history:f.context.relevantHistory,budget:new InformationBudget(undefined,native?nativeKnowledgeTiming():undefined),current:async()=>true,languageSafe:u=>u.language===f.vi.requestedLanguage,diagnostic:e=>events.push(e),revalidateEvidence:async()=>{reads++;return fault==='revoked'&&reads>=2?[]:f.evidence;},
 generate:async(stage,instruction,data:any,contract)=>{
  stages.push(stage);instructions.push({stage,instruction,contract});
  if(stage==='extraction'){
   if(id==='C-fa'&&!options.literal){assert.deepEqual(data,f.context,'Only instructions change; full frozen source/question/facets/tone remain');assert.equal(instruction,native&&!options.durable?FOREGROUND_UNIT_EXTRACTION_INSTRUCTION+'\n'+NATIVE_V2_PRODUCER_GUIDANCE+'\n'+NATIVE_V2_QUESTION_RESPONSIVENESS_GUIDANCE:FOREGROUND_UNIT_EXTRACTION_INSTRUCTION);}
   assert.equal(contract?.extractionProtocol,options.literal?'literal-evidence-v1':'v2');
   if(fault==='timeout')throw Error('information_deadline');
   return{text:JSON.stringify(raw)};
  }
  assert.equal(stage,'verification','No retry or optional composition');assert.equal(instruction,FOREGROUND_UNIT_VERIFICATION_INSTRUCTION+(native&&!options.durable&&!options.literal&&id!=='B-en'?'\n'+NATIVE_V2_QUESTION_RESPONSIVENESS_GUIDANCE:''));assert.equal(data.question,f.vi.question);assert.equal(knowledgeStructuredOutput(stage,false,undefined,6,'v2').name,'odinlink_knowledge_verification_v2');
  for(const u of data.units)for(const ref of u.evidenceRefs)assert.ok(data.evidence.find((e:any)=>e.id===ref.evidenceId)?.text.includes(ref.exactQuote));
  if(fault==='original-capture'){assert.deepEqual(compactKnowledgeVerifierInput(data),f.vi);return{text:f.vc.outputText};}
  if(id==='A-en'&&fault==='none'){assert.deepEqual(compactKnowledgeVerifierInput(data),f.vi);return{text:f.vc.outputText};}
  if(id==='B-en')return{text:f.vc.outputText};
  const ids=data.units.map((u:any)=>u.id),bad=fault==='invented-fee'?ids.at(-1):fault==='missing-condition'||fault==='unknown'?'u1':fault==='invented-permission'?'u3':null;
  const verdict=id==='A-en'?JSON.parse(f.vc.outputText):{coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:false,incompletenessReason:'MISSING_RELEVANT_FACT',materialUnitIds:ids,obligations:[{obligationId:'f1.o1',status:'UNRESOLVED',unitIds:[]},{obligationId:'f1.o2',status:fault==='missing-reservation'?'UNRESOLVED':'COVERED',unitIds:fault==='missing-reservation'?[]:ids}]}]};
  verdict.decisions=data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:u.id===bad?'UNKNOWN':'ENTAILED',meaningPreserved:u.id!==bad,modalityPreserved:fault!=='invented-permission'||u.id!==bad,qualifiersPreserved:fault!=='missing-condition'||u.id!==bad,relevant:!(fault==='extra-supplement'&&u.id==='u1'),languageCorrect:true,negativeAbsence:id==='C-fa'&&u.negation,explicitAbsenceEvidence:id==='C-fa'&&u.negation}));
  if(fault==='missing-condition'){verdict.coverage[0].materialFactsComplete=false;verdict.coverage[0].incompletenessReason='MISSING_CONDITION';verdict.coverage[0].obligations.forEach((o:any)=>o.status='UNRESOLVED');}
  if(fault==='invalid-quote'){verdict.coverage[0].materialFactsComplete=true;verdict.coverage[0].incompletenessReason='NONE';verdict.coverage[0].materialUnitIds=ids;verdict.coverage[0].obligations.forEach((o:any)=>{o.status='COVERED';o.unitIds=ids;});}
  return{text:JSON.stringify(verdict)};
 }});
 result={manifest,allowed:publishableKnowledgeManifest(manifest,77),complete:completeKnowledgeManifest(manifest),stages,instructions,events,reads};
 };
 if(native)await runAccuracyFirstNative(work,async()=>{});else await work();assert.ok(result);assert.ok(stages.filter(s=>s==='extraction').length<=1);assert.ok(stages.filter(s=>s==='verification').length<=1);records.push({id,fault,native,options,...result});return result;
}
test('native v2 producer adjunct is generic, exact and preserves quotation/materiality requirements',()=>{
 assert.doesNotMatch(NATIVE_V2_PRODUCER_GUIDANCE,/Nordpark|AdMotion|tenant|parking|پارکینگ/u);assert.match(NATIVE_V2_PRODUCER_GUIDANCE,/every requested clause/);assert.match(NATIVE_V2_PRODUCER_GUIDANCE,/OCR split words/);assert.match(NATIVE_V2_PRODUCER_GUIDANCE,/do not substitute/);assert.match(NATIVE_V2_PRODUCER_GUIDANCE,/Do not omit a supported requested fact/);
});
test('hypothetical two-fact C-fa producer output passes unchanged verifier/consumer with explicit fee PARTIAL',async()=>{
 const r=await exercise('C-fa');assert.equal(r.allowed,true);assert.equal(r.complete,false);assert.equal(r.manifest.units.length,2);assert.match(r.manifest.text,/پارکینگ رایگان ارائه نمی‌کند/u);assert.match(r.manifest.text,/نمی‌تواند برای بازدیدکننده جای پارک رزرو کند/u);assert.match(r.manifest.text,/نمی‌توانم «هزینه پارکینگ Nordpark»/u);assert.doesNotMatch(r.manifest.text,/Stjärngatan|999|پنج دقیقه/u);assert.deepEqual(r.stages,['extraction','verification']);assert.equal(r.manifest.outcomes[0].obligations[0].status,'UNRESOLVED');assert.equal(r.manifest.outcomes[0].obligations[1].status,'COVERED');
});
test('unmodified genuine C-fa response still fails quote parsing/publication; no repair or regrade',async()=>{const r=await exercise('C-fa','original-capture');assert.equal(r.allowed,false);assert.equal(r.complete,false);assert.ok(r.events.some((e:any)=>e.reason==='INVALID_CITATION'));});
for(const fault of ['invalid-quote','extra-supplement','invented-fee','unknown','revoked','timeout']as const)test(`unchanged safety veto: ${fault}`,async()=>{const r=await exercise('C-fa',fault);assert.equal(r.allowed,false);assert.equal(r.complete,false);});
test('omitted reservation fact cannot be classified as positive C-fa acceptance or covered',async()=>{const r=await exercise('C-fa','missing-reservation');assert.equal(r.complete,false);assert.equal(r.manifest.outcomes[0].obligations[1].status,'UNRESOLVED');assert.ok(!r.manifest.units.some((u:any)=>u.text.includes('نمی‌تواند برای بازدیدکننده جای پارک رزرو کند')));const positiveAcceptance=r.allowed&&r.manifest.outcomes[0].obligations[1].status==='COVERED';assert.equal(positiveAcceptance,false);});
for(const fault of ['missing-condition','invented-permission']as const)test(`unchanged independent rejection of ${fault}`,async()=>{const r=await exercise('A-en',fault);assert.equal(r.allowed,false);assert.equal(r.complete,false);});
test('existing A-en complete source-faithful output and verifier replay remain compatible',async()=>{const r=await exercise('A-en');assert.equal(r.allowed,true);assert.equal(r.complete,true);assert.equal(r.manifest.units.length,5);assert.match(r.instructions[0].instruction,/Producer check:/);});
test('native mixed strict-v2 selects its producer-only adjunct exactly once, retaining historical B-en semantics',async()=>{
 const r=await exercise('B-en');
 assert.ok(!r.instructions[0].instruction.includes(NATIVE_V2_PRODUCER_GUIDANCE));
 assert.ok(r.instructions.every(i=>!i.instruction.includes(NATIVE_V2_QUESTION_RESPONSIVENESS_GUIDANCE)));
 assert.equal(r.instructions[0].instruction.split(NATIVE_V2_MIXED_DOCUMENTARY_GUIDANCE).length-1,1);
 assert.equal(r.instructions[1].instruction,FOREGROUND_UNIT_VERIFICATION_INSTRUCTION);
 assert.equal(r.allowed,true);assert.equal(r.complete,false);
 assert.match(r.manifest.text,/300 SEK.*60 minutes/);assert.match(r.manifest.text,/cannot confirm whether/);
});
for(const [label,native,options]of [['non-native',false,{}],['durable',true,{durable:true}],['literal',true,{literal:true}]]as const)
 test(`mixed ${label} does not acquire the native mixed v2 adjunct`,async()=>{
  const r=await exercise('B-en','none',native,options);assert.ok(r.instructions.every(i=>!i.instruction.includes(NATIVE_V2_MIXED_DOCUMENTARY_GUIDANCE)));
 });
test('non-native foreground base contract remains unchanged',async()=>{const r=await exercise('C-fa','none',false);assert.equal(r.instructions[0].instruction,FOREGROUND_UNIT_EXTRACTION_INSTRUCTION);});
test('durable callers do not acquire the native producer adjunct',async()=>{const r=await exercise('C-fa','none',true,{durable:true});assert.equal(r.instructions[0].instruction,FOREGROUND_UNIT_EXTRACTION_INSTRUCTION);});
test('disabled literal experiment is not extended by this v2-only producer change',async()=>{const r=await exercise('C-fa','none',true,{literal:true});assert.ok(!r.instructions[0].instruction.includes(NATIVE_V2_PRODUCER_GUIDANCE));assert.equal(r.allowed,false);});
