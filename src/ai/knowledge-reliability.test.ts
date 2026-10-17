import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerEvidence, buildEvidenceFirstAnswer, InformationBudget, parseRequestedFacets, pruneAnswerManifest, withinInformationDeadline } from './business-information-answer-plan';
import { type KnowledgeDecision, knowledgeStructuredOutput, safeModelIdentifier } from './knowledge-answer-protocol';
import { normalizeOpenAiGenerationResponse } from './providers/openai';
import { buildGeminiGenerationParams, normalizeGeminiGenerationResponse } from './providers/gemini';

const recommendation='We recommend booking ahead.',arrangement='Visits are arranged by agreement.',permission='Walk-in visits are permitted.',parking='Parking is behind the studio.';
const evidence=answerEvidence(77,[{businessId:77,sourceId:'private-source-A',text:`${recommendation}\n${arrangement}\n${permission}\nWalk-in visits are not prohibited.`,metadata:{documentRevision:'v1'}},
 {businessId:77,sourceId:'private-source-B',text:parking,metadata:{documentRevision:'v1'}}]);
const facets=(type='recommendation')=>parseRequestedFacets([{subject:'visits',attribute:'visit policy',questionType:type}]).facets;
const unit=(text=recommendation,modality='recommended',facetId='f1',ref='e1')=>({facetIds:[facetId],subject:'studio',predicate:'states',value:text,modality,negation:false,scope:'visits',qualifiers:[],language:'en',text,evidenceRefs:[{evidenceId:ref,exactQuote:text}]});
const decision=(u:any)=>({unitId:u.id,relation:'ENTAILED',facetIds:u.facetIds,meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,
 languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false});
const coverage=(fs:any[],us:any[])=>fs.map(f=>({facetId:f.id,requestAligned:true,materialFactsComplete:true,materialUnitIds:us.filter(u=>u.facetIds.includes(f.id)).map(u=>u.id),
 obligations:f.obligations.map((o:any)=>({obligationId:o.id,status:'COVERED',unitIds:us.filter(u=>u.facetIds.includes(f.id)).map(u=>u.id)}))}));
async function run(options:{type?:string;units?:any[];verify?:(data:any)=>any;extraction?:any;languageSafe?:()=>boolean;failure?:string;fresh?:()=>Promise<any>;shortDeadline?:boolean}={}) {
 const fs=facets(options.type),budget=new InformationBudget(options.shortDeadline?10:20_000),events:KnowledgeDecision[]=[],calls:string[]=[];
 const manifest=await buildEvidenceFirstAnswer({question:'Synthetic private question',language:'en',facets:fs,evidence,authoritativeEvidence:'',businessTone:{tonePreset:'warm'},history:[],budget,
  current:async()=>true,diagnostic:e=>events.push(e),languageSafe:options.languageSafe,revalidateEvidence:options.fresh,
  generate:async(stage,_instruction,data:any)=>{
   budget.attempt();calls.push(stage);
   if(options.shortDeadline)await withinInformationDeadline(budget,()=>new Promise(()=>{}));
   if(options.failure===stage)throw new Error('private error body must never be logged');
   if(stage==='extraction')return options.extraction||{text:JSON.stringify({units:options.units||[unit()]})};
   if(stage==='verification')return{text:JSON.stringify(options.verify?options.verify(data):{decisions:data.units.map(decision),coverage:coverage(data.facets,data.units)})};
   return{text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'acknowledgement',addition:false})};
  }});
 return{manifest,budget,events,calls};
}
test('one complete independently verified unit renders directly without pretending composition occurred',async()=>{
 const {manifest,calls,events}=await run();assert.deepEqual(calls,['extraction','verification']);assert.equal(manifest.text,recommendation);
 assert.equal(manifest.outcomes[0].status,'VERIFIED');assert.equal(manifest.presentationPath,'direct_single_unit');assert.equal(manifest.presentationFallback,false);
 assert.ok(events.some(e=>e.reason==='DIRECT_SINGLE_UNIT'));assert.equal(events.some(e=>e.reason==='COMPOSED'),false);
});
for(const type of ['permission','requirement','prohibition'])test(`${type}: recommendation cannot satisfy a stronger requested obligation even if coverage claims it`,async()=>{
 const {manifest}=await run({type});assert.equal(manifest.outcomes[0].status,'PARTIAL');assert.equal(manifest.outcomes[0].obligations[0].status,'UNRESOLVED');
 assert.ok(manifest.text.includes(recommendation));assert.equal(manifest.text.includes(permission),false);assert.equal(manifest.units[0].modality,'recommended');
});
test('explicitly evidenced permission can satisfy the permission obligation',async()=>{
 const {manifest}=await run({type:'permission',units:[unit(permission,'permitted')]});assert.equal(manifest.outcomes[0].status,'VERIFIED');assert.equal(manifest.text,permission);
});
test('a negated prohibition is not automatically a permission decision',async()=>{
 const {manifest}=await run({type:'permission',units:[{...unit('Walk-in visits are not prohibited.','prohibited'),negation:true}]});
 assert.equal(manifest.outcomes[0].status,'PARTIAL');assert.equal(manifest.outcomes[0].obligations[0].status,'UNRESOLVED');assert.equal(manifest.units.length,1);
});
test('independent request alignment can reject incomplete planning without erasing facts',async()=>{
 const {manifest,events}=await run({verify:d=>({decisions:d.units.map(decision),coverage:coverage(d.facets,d.units).map(c=>({...c,requestAligned:false}))})});
 assert.equal(manifest.outcomes[0].status,'PARTIAL');assert.ok(manifest.text.includes(recommendation));assert.ok(events.some(e=>e.reason==='REQUEST_OBLIGATIONS_MISSING'));
});
test('generic descriptive fact cannot replace a missing recommendation despite a positive coverage assertion',async()=>{
 const {manifest}=await run({units:[unit(arrangement,'descriptive')]});assert.equal(manifest.outcomes[0].status,'PARTIAL');assert.ok(manifest.text.includes(arrangement));
 assert.equal(manifest.text.includes(recommendation),false,'do not invent the omitted fact at publication');assert.equal(manifest.outcomes[0].obligations[0].status,'UNRESOLVED');
});
test('complete coverage logs NONE without changing VERIFIED status',async()=>{
 const {manifest,events}=await run({verify:d=>({
  decisions:d.units.map(decision),
  coverage:coverage(d.facets,d.units).map(c=>({...c,incompletenessReason:'NONE'}))
 })});
 assert.equal(manifest.outcomes[0].status,'VERIFIED');
 assert.ok(events.some(e=>e.stage==='verification'&&e.facetId==='f1'&&e.incompletenessReason==='NONE'));
});

test('invalid coverage cannot report a trusted incompleteness reason',async()=>{
 const {manifest,events}=await run({verify:d=>({
  decisions:d.units.map(decision),
  coverage:coverage(d.facets,d.units).map(c=>({
   ...c,materialFactsComplete:false,
   obligations:[],
   incompletenessReason:'MISSING_RECOMMENDATION'
  }))
 })});
 assert.notEqual(manifest.outcomes[0].status,'VERIFIED');
 assert.ok(events.some(e=>e.facetId==='f1'&&e.reason==='INVALID_COVERAGE'));
 assert.ok(!events.some(e=>e.facetId==='f1'&&e.incompletenessReason==='MISSING_RECOMMENDATION'));
});

test('incompleteness reason is diagnostic only and cannot promote partial coverage',async()=>{
 const {manifest,events}=await run({verify:d=>({
  decisions:d.units.map(decision),
  coverage:coverage(d.facets,d.units).map(c=>({
   ...c,materialFactsComplete:false,incompletenessReason:'MISSING_RECOMMENDATION'
  }))
 })});
 assert.equal(manifest.outcomes[0].status,'PARTIAL');
 assert.equal(manifest.outcomes[0].materialFactsComplete,false);
 assert.ok(events.some(e=>e.stage==='verification'&&e.facetId==='f1'&&e.incompletenessReason==='MISSING_RECOMMENDATION'));
});
test('independent material-completeness rejection preserves the verified requested fact',async()=>{
 const {manifest,events}=await run({verify:d=>({decisions:d.units.map(decision),coverage:coverage(d.facets,d.units).map(c=>({...c,materialFactsComplete:false}))})});
 assert.equal(manifest.outcomes[0].status,'PARTIAL');assert.equal(manifest.outcomes[0].obligations[0].status,'COVERED');assert.ok(manifest.text.includes(recommendation));
 assert.ok(events.some(e=>e.reason==='MATERIAL_FACTS_MISSING'));
});
for(const fault of ['missing','duplicate','wrong-facet','wrong-unit','wrong-obligation','duplicate-obligation','malformed','missing-flag'] as const)test(`coverage/${fault}: cannot claim completeness or erase a supported fact`,async()=>{
 const {manifest}=await run({verify:d=>{
  let cs:any=coverage(d.facets,d.units);
  if(fault==='missing')cs=undefined;if(fault==='duplicate')cs=[...cs,...cs];if(fault==='wrong-facet')cs[0].facetId='foreign';
  if(fault==='wrong-unit')cs[0].materialUnitIds=['u9'];if(fault==='wrong-obligation')cs[0].obligations[0].obligationId='f9.o1';
  if(fault==='duplicate-obligation')cs[0].obligations.push(cs[0].obligations[0]);if(fault==='malformed')cs='not-array';if(fault==='missing-flag')delete cs[0].materialFactsComplete;
  return{decisions:d.units.map(decision),coverage:cs};
 }});assert.equal(manifest.outcomes[0].status,'PARTIAL');assert.ok(manifest.text.includes(recommendation));assert.equal(manifest.units.length,1);
});
const verdictFaults=[['UNKNOWN','UNKNOWN'],['NOT_APPLICABLE','NOT_APPLICABLE'],['CONTRADICTED','CONTRADICTED'],['missing','MISSING_VERDICT'],['duplicate','DUPLICATE_VERDICT'],
 ['wrong-id','MISSING_VERDICT'],['meaning','MEANING_CHANGED'],['modality','MODALITY_CHANGED'],['qualifiers','QUALIFIERS_CHANGED'],['relevant','NOT_RELEVANT'],
 ['language','VERIFIER_LANGUAGE'],['flags','INVALID_FLAGS'],['facet','FACET_MISMATCH'],['relation','INVALID_RELATION'],['absence','NEGATIVE_ABSENCE']] as const;
for(const [fault,reason] of verdictFaults)test(`verification/${fault}: explicit reason, no transport-based approval`,async()=>{
 const {manifest,events}=await run({verify:d=>{
  const v:any=decision(d.units[0]);if(['UNKNOWN','NOT_APPLICABLE','CONTRADICTED'].includes(fault))v.relation=fault;
  if(fault==='wrong-id')v.unitId='private-recipient';if(fault==='meaning')v.meaningPreserved=false;if(fault==='modality')v.modalityPreserved=false;
  if(fault==='qualifiers')v.qualifiersPreserved=false;if(fault==='relevant')v.relevant=false;if(fault==='language')v.languageCorrect=false;
  if(fault==='flags')delete v.negativeAbsence;if(fault==='facet')v.facetIds=['f9'];if(fault==='relation')v.relation='private-model-output';if(fault==='absence')v.negativeAbsence=true;
  return{decisions:fault==='missing'?[]:fault==='duplicate'?[v,v]:[v],coverage:coverage(d.facets,d.units)};
 }});
 assert.equal(manifest.units.length,0);assert.equal(manifest.text.includes(recommendation),false);assert.ok(events.some(e=>e.unitId==='u1'&&e.reason===reason),JSON.stringify(events));
 assert.doesNotMatch(JSON.stringify(events),/private-model-output|private-recipient|private-source|private error|Synthetic private|We recommend/);
});
test('local language veto is distinct from a successful semantic language flag',async()=>{
 const {manifest,events}=await run({languageSafe:()=>false});assert.equal(manifest.units.length,0);assert.ok(events.some(e=>e.reason==='LOCAL_LANGUAGE'&&e.flags?.languageCorrect===true));
});
for(const structuredFailure of ['REFUSAL','TRUNCATED','BLOCKED'] as const)test(`${structuredFailure}: even a valid JSON body is not accepted`,async()=>{
 const {manifest,calls,events}=await run({extraction:{text:JSON.stringify({units:[unit()]}),structuredFailure}});
 assert.equal(manifest.units.length,0);assert.deepEqual(calls,['extraction']);assert.ok(events.some(e=>e.reason===structuredFailure));
});
for(const raw of ['not-json','{"units":null}','{"units":[{"text":"private invalid candidate"}]}'])test('malformed extraction is bounded and never logs raw content',async()=>{
 const {manifest,events}=await run({extraction:{text:raw}});assert.equal(manifest.units.length,0);assert.ok(events.some(e=>['MALFORMED_JSON','MALFORMED_ARRAY','INVALID_FIELDS'].includes(e.reason)));
 assert.equal(JSON.stringify(events).includes('private invalid candidate'),false);
});
test('deadline failure is explicit and cannot start verification or retries',async()=>{
 const {manifest,calls}=await run({shortDeadline:true});assert.deepEqual(calls,['extraction']);assert.equal(manifest.fallbackReason,'DEADLINE');assert.equal(manifest.units.length,0);
});
test('partial source removal recomputes exact obligation dependencies',async()=>{
 const {manifest}=await run();const pruned=pruneAnswerManifest(manifest,[]);
 assert.equal(pruned.units.length,0);assert.equal(pruned.outcomes[0].status,'UNAVAILABLE');assert.equal(pruned.outcomes[0].obligations[0].status,'UNRESOLVED');
 assert.equal(pruned.outcomes[0].materialFactsComplete,false);assert.equal(pruned.fallbackReason,'SOURCE_INVALID');
});
test('facet obligations are server-assigned, bounded and immutable',()=>{
 const fs=parseRequestedFacets([{subject:'visits',attribute:'policy',questionType:'permission',obligations:[{id:'foreign',description:'permission',questionType:'permission'},{description:'recommendation',questionType:'recommendation'}]}]).facets;
 assert.deepEqual(fs[0].obligations.map(o=>o.id),['f1.o1','f1.o2']);assert.ok(Object.isFrozen(fs[0].obligations[0]));
 assert.equal(parseRequestedFacets([{subject:'visits',attribute:'policy',questionType:'permission',obligations:[]}]).facets.length,0);
 assert.equal(parseRequestedFacets([{subject:'visits',attribute:'policy',questionType:'permission',obligations:[{description:'generic fact',questionType:'description'}]}]).facets.length,0);
 assert.equal(parseRequestedFacets([{subject:'visits',attribute:'policy',questionType:'permission',obligations:[1,2,3]}]).oversized,true);
});
for(const stage of ['planning','extraction','verification'] as const)test(`${stage}: strict schema uses existing OpenAI contract; Gemini retains validated text`,()=>{
 const schema=knowledgeStructuredOutput(stage);assert.equal(schema.strict,true);assert.equal(schema.schema.additionalProperties,false);
 const params=buildGeminiGenerationParams({messages:[],structuredOutput:schema});assert.equal(params.config.responseSchema,undefined);assert.equal(params.config.responseJsonSchema,undefined);
});
test('provider refusal and truncation status survives normalization without raw bodies',()=>{
 assert.equal(normalizeOpenAiGenerationResponse({output_text:'{}',status:'incomplete'}).structuredFailure,'TRUNCATED');
 assert.equal(normalizeOpenAiGenerationResponse({output_text:'{}',output:[{content:[{type:'refusal',refusal:'private content'}]}]}).structuredFailure,'REFUSAL');
 assert.equal(normalizeGeminiGenerationResponse({text:'{}',candidates:[{finishReason:'MAX_TOKENS'}]}).structuredFailure,'TRUNCATED');
 assert.equal(normalizeGeminiGenerationResponse({text:'{}',promptFeedback:{blockReason:'SAFETY'}}).structuredFailure,'BLOCKED');
 assert.equal(safeModelIdentifier('sk-private-key'),'invalid_identifier');assert.equal(safeModelIdentifier('gpt-5.6-luna'),'gpt-5.6-luna');
});

for (const variant of ['complete','omitted','rejected'] as const) test(`source-backed contact recommendation: ${variant} inventory retains independent completeness authority`,async()=>{
 const location='Visitor parking is behind the building.';
 const contact='For alternative parking information, we recommend contacting the business.';
 const sources=answerEvidence(77,[
  {businessId:77,sourceId:'synthetic-pdf',text:location,metadata:{documentRevision:'v1'}},
  {businessId:77,sourceId:'synthetic-txt',text:contact,metadata:{documentRevision:'v1'}},
 ]);
 const fs=facets('description'),calls:string[]=[],events:KnowledgeDecision[]=[];
 const manifest=await buildEvidenceFirstAnswer({question:'Where is visitor parking?',language:'en',facets:fs,evidence:sources,
  authoritativeEvidence:'',businessTone:{},history:[],budget:new InformationBudget(),current:async()=>true,
  diagnostic:e=>events.push(e),generate:async(stage,instruction,data:any)=>{
   calls.push(stage);
   if(stage==='extraction'){
    assert.ok(instruction.includes('No greeting, question, unsolicited CTA'));
    assert.ok(instruction.includes('not an unsolicited CTA; include it with its conditions and recommended modality when relevant'));
    assert.equal(data.evidence.length,2);
    return{text:JSON.stringify({units:[unit(location,'descriptive','f1','e1'),
     ...(variant==='omitted'?[]:[unit(contact,'recommended','f1','e2')])]})};
   }
   if(stage==='verification')return{text:JSON.stringify({
    decisions:data.units.map((u:any)=>({...decision(u),...(variant==='rejected'&&u.id==='u2'?{relation:'UNKNOWN'}:{})})),
    coverage:coverage(data.facets,data.units).map(c=>({...c,materialFactsComplete:variant!=='omitted',
     incompletenessReason:variant==='omitted'?'MISSING_RECOMMENDATION':'NONE'})),
   })};
   return{text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})};
  }});
 assert.ok(manifest.text.includes(location));
 assert.equal(manifest.text.includes(contact),variant==='complete');
 assert.equal(manifest.outcomes[0].status,variant==='complete'?'VERIFIED':'PARTIAL');
 assert.equal(manifest.outcomes[0].materialFactsComplete,variant==='complete');
 assert.equal(calls.filter(s=>s==='extraction').length,1);assert.equal(calls.filter(s=>s==='verification').length,1);
 if(variant==='omitted')assert.ok(events.some(e=>e.incompletenessReason==='MISSING_RECOMMENDATION'));
});
