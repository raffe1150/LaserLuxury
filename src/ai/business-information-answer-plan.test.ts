import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ANSWER_LIMITS, InformationBudget, answerEvidence, parseRequestedFacets, parseAnswerUnits, buildEvidenceFirstAnswer, withinInformationDeadline, pruneAnswerManifest, UNIT_EXTRACTION_INSTRUCTION, UNIT_VERIFICATION_INSTRUCTION, FOREGROUND_UNIT_EXTRACTION_INSTRUCTION, FOREGROUND_UNIT_VERIFICATION_INSTRUCTION } from './business-information-answer-plan';
import { literalInformationFallback } from './knowledge-planning';
import { normalizeOpenAiGenerationResponse } from './providers/openai';
import { normalizeGeminiGenerationResponse } from './providers/gemini';
const quote = 'Vi rekommenderar att du bokar tid i förväg.';
const second = 'Vissa tjänster kan genomföras digitalt.';
const facets = parseRequestedFacets([{ subject:'visits', attribute:'advance booking', questionType:'permission' }, { subject:'services', attribute:'digital meetings', questionType:'description' }]).facets;
const evidence = answerEvidence(77,[{ businessId:77, sourceId:'doc', text:`${quote}\n${second}`, metadata:{ documentRevision:'v1' } }]);
const proposal = (text = quote, f = 'f1') => ({ subject:'studio', predicate:'recommends', value:'advance booking', modality:'recommended', negation:false,
 scope:'visits', qualifiers:[], language:'sv', text, facetIds:[f], evidenceRefs:[{ evidenceId:'e1', exactQuote:text }] });
const parsed = (units:any[]) => parseAnswerUnits({ units },facets,evidence,'sv').units;
const verdict = (id:string, f:string) => ({ unitId:id, relation:'ENTAILED', facetIds:[f], meaningPreserved:true, modalityPreserved:true, qualifiersPreserved:true, relevant:true, languageCorrect:true, negativeAbsence:false, explicitAbsenceEvidence:false });
async function run(options:{ units?:any[]; decisions?:any[]; compose?:any; current?:()=>Promise<boolean>; fail?:string; budget?:InformationBudget; omitModelEvidenceVersions?:boolean; finalPublicationRevalidates?:boolean; revalidateEvidence?:()=>Promise<typeof evidence> } = {}) {
 const budget = options.budget || new InformationBudget(), calls:string[] = [];
 const manifest = await buildEvidenceFirstAnswer({ question:'Can I visit and do you offer digital meetings?', language:'sv', facets, evidence,
  authoritativeEvidence:'', businessTone:{}, history:[], budget, finalPublicationRevalidates:options.finalPublicationRevalidates, revalidateEvidence:options.revalidateEvidence, current:options.current || (async()=>true), generate:async(stage,_instruction,data:any)=>{
   if(stage==='extraction'||stage==='verification')assert.deepEqual(data.evidence,evidence.map(({id,businessId,version,text})=>options.omitModelEvidenceVersions===false?{id,businessId,version,text}:{id,businessId,text}), 'Full evidence bytes and tenant IDs survive wire projection');
   budget.attempt(); calls.push(stage); if(options.fail === stage) throw new Error('synthetic');
   return { text:JSON.stringify(stage === 'extraction' ? { units:options.units || [proposal(),proposal(second,'f2')] } : stage === 'verification' ?
    { decisions:options.decisions || [verdict('u1','f1'),verdict('u2','f2')],coverage:data.facets.map((f:any)=>({facetId:f.id,requestAligned:true,materialFactsComplete:true,materialUnitIds:data.units.filter((u:any)=>u.facetIds.includes(f.id)).map((u:any)=>u.id),obligations:f.obligations.map((o:any)=>({obligationId:o.id,status:'COVERED',unitIds:data.units.filter((u:any)=>u.facetIds.includes(f.id)).map((u:any)=>u.id)}))})) } : options.compose || { unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false }) };
  },omitModelEvidenceVersions:options.omitModelEvidenceVersions!==false });
 return { manifest, calls, budget };
}
test('server assigns stable source/chunk version and immutable unit provenance',()=>{
 const [unit] = parsed([proposal()]); assert.equal(unit.evidenceRefs[0].version,'v1'); assert.equal(unit.evidenceRefs[0].sourceId,'doc');
 assert.ok(Object.isFrozen(unit)); assert.ok(Object.isFrozen(unit.qualifiers)); assert.ok(Object.isFrozen(unit.evidenceRefs[0])); assert.equal(unit.verification,'PROPOSED');
 assert.equal(answerEvidence(88,[{businessId:77,sourceId:'doc',text:quote}]).length,0);
});
test('wire projection removes only opaque revisions; verified refs retain exact source/chunk/version bindings',async()=>{
 const {manifest}=await run();
 assert.equal(manifest.units.length,2);
 for(const u of manifest.units)for(const r of u.evidenceRefs){
  assert.equal(r.sourceId,evidence[0].sourceId);assert.equal(r.chunkId,evidence[0].chunkId);
  assert.equal(r.version,evidence[0].version);assert.ok(evidence[0].text.includes(r.exactQuote));
 }
});
test('callers outside foreground retain their existing evidence version wire fields',async()=>{
 const {manifest}=await run({omitModelEvidenceVersions:false});assert.equal(manifest.units.length,2);
});
for (const field of ['subject','predicate','value','scope','language','modality','negation','qualifiers','facetIds','text','evidenceRefs']) test(`malformed ${field} cannot become an answer unit`,()=>{
 const unit:any = proposal(); unit[field] = null; assert.equal(parsed([unit]).length,0);
});
for (const [name,patch] of [
 ['foreign reference',{evidenceRefs:[{evidenceId:'foreign',exactQuote:quote}]}], ['paraphrased citation',{evidenceRefs:[{evidenceId:'e1',exactQuote:'Please book ahead.'}]}],
 ['wrong language',{language:'en'}], ['unknown facet',{facetIds:['f9']}], ['false booking confirmation',{text:'Your appointment is confirmed.'}],
 ['false cancellation',{text:'Jag har avbokat din tid.'}], ['empty citations',{evidenceRefs:[]}],
] as const) test(`${name} is rejected before semantic verification`,()=>assert.equal(parsed([{...proposal(),...patch}]).length,0));
test('identifier prefix is not an exact complete evidence token',()=>{
 const ev = answerEvidence(77,[{businessId:77,sourceId:'doc',text:'Diagnostic code ZX-7429',metadata:{documentRevision:'v1'}}]);
 assert.equal(parseAnswerUnits({units:[{...proposal(),text:'The code is ZX-742.',evidenceRefs:[{evidenceId:'e1',exactQuote:'Diagnostic code ZX-742'}]}]},facets,ev,'sv').units.length,0);
});
test('oversized facets and units clarify rather than silently drop material',()=>{
 assert.equal(parseRequestedFacets(Array.from({length:5},()=>({subject:'x',attribute:'y',questionType:'description'}))).oversized,true);
 assert.equal(parseAnswerUnits({units:Array.from({length:7},()=>proposal())},facets,evidence,'sv').oversized,true);
});
for (const bad of ['UNKNOWN','CONTRADICTED','NOT_APPLICABLE','missing','duplicate','meaning-change','language-change','modality-upgrade','negative-absence','facet-drift']) test(`independent verification: ${bad} preserves unrelated verified unit`,async()=>{
 let d:any = {...verdict('u2','f2')};
 if(['UNKNOWN','CONTRADICTED','NOT_APPLICABLE'].includes(bad)) d.relation=bad;
 if(bad==='meaning-change'||bad==='modality-upgrade')d.meaningPreserved=false;
 if(bad==='language-change')d.languageCorrect=false;
 if(bad==='negative-absence')d.negativeAbsence=true;
 if(bad==='facet-drift')d.facetIds=['f1'];
 const ds = bad==='missing' ? [verdict('u1','f1')] : bad==='duplicate' ? [verdict('u1','f1'),d,d] : [verdict('u1','f1'),d];
 const {manifest} = await run({decisions:ds}); assert.ok(manifest.text.includes(quote)); assert.equal(manifest.text.includes(second),false); assert.equal(manifest.units.length,1);
 assert.equal(manifest.units[0].verification,'ENTAILED');
});
test('malformed independent proposal does not erase a well-formed verified sibling',async()=>{
 const {manifest}=await run({units:[proposal(),{...proposal(second,'f2'),evidenceRefs:[]}],decisions:[verdict('u1','f1')]});
 assert.ok(manifest.text.includes(quote));assert.equal(manifest.units.length,1);
});
for(const compose of [{unitIds:['u1'],prefix:'none',addition:false},{unitIds:['u1','u1'],prefix:'none',addition:false},{unitIds:['u1','u2'],prefix:'none',addition:false,extra:'mandatory'}, {unitIds:['u1','u2'],prefix:'invented fact',addition:false}])test('unsafe presentation falls back to all exact verified facts',async()=>{
 const {manifest}=await run({compose});assert.equal(manifest.presentationFallback,true);assert.ok(manifest.text.includes(quote));assert.ok(manifest.text.includes(second));
});
test('source revocation after verification cannot publish any stale unit',async()=>{
 let checks=0;const {manifest}=await run({current:async()=>++checks<4});assert.equal(manifest.units.length,0);assert.equal(manifest.text.includes(quote),false);
});
test('provider failure in composer preserves verified units without retries',async()=>{
 const {manifest,calls}=await run({fail:'composition'});assert.deepEqual(calls,['extraction','verification','composition']);assert.equal(manifest.units.length,2);assert.equal(manifest.presentationFallback,true);
});
test('request-local attempt and deadline limits are enforced',async()=>{
 const budget=new InformationBudget();for(let i=0;i<ANSWER_LIMITS.attempts;i++)budget.attempt();assert.throws(()=>budget.attempt(),/budget/);
 await assert.rejects(withinInformationDeadline(new InformationBudget(5),()=>new Promise(()=>{})),/deadline/);
});
test('known usage has explicit estimated pricing; missing usage/rates stays unknown',()=>{
 const budget=new InformationBudget();assert.equal(budget.estimatedCostUsd,null);budget.usage(100,200,'1','2');assert.equal(budget.estimatedCostUsd,0.0005);
 budget.usage(undefined,undefined);assert.equal(budget.meteredAttempts,1);
});
test('normalized provider responses retain optional token usage without secrets',()=>{
 assert.deepEqual(normalizeOpenAiGenerationResponse({output_text:'x',usage:{input_tokens:12,output_tokens:3}}).usage,{inputTokens:12,outputTokens:3});
 assert.deepEqual(normalizeGeminiGenerationResponse({text:'x',usageMetadata:{promptTokenCount:9,candidatesTokenCount:2}}).usage,{inputTokens:9,outputTokens:2});
 assert.deepEqual(normalizeGeminiGenerationResponse({text:'x',usageMetadata:{promptTokenCount:9,candidatesTokenCount:2,thoughtsTokenCount:5}}).usage,{inputTokens:9,outputTokens:7});
});
test('conversational acknowledgement cannot imply permission before a recommendation',async()=>{
 const {manifest}=await run({compose:{unitIds:['u1','u2'],prefix:'acknowledgement',addition:false}});
 assert.ok(manifest.text.startsWith('Tack för din fråga.'));assert.doesNotMatch(manifest.text,/^(?:Självklart|Ja|Of course|Yes)[.!]/u);
 assert.ok(manifest.text.includes(quote));
});

test('partial publication is subtraction only, preserves presentation and recomputes affected facets',async()=>{
 const {manifest}=await run({compose:{unitIds:['u2','u1'],prefix:'acknowledgement',addition:true}});
 const separate=answerEvidence(77,[{businessId:77,sourceId:'one',text:quote,metadata:{documentRevision:'v1'}},{businessId:77,sourceId:'two',text:second,metadata:{documentRevision:'v1'}}]);
 const bound={...manifest,units:manifest.units.map((u,i)=>({...u,evidenceRefs:[{...u.evidenceRefs[0],evidenceId:separate[i].id,sourceId:separate[i].sourceId,chunkId:separate[i].chunkId,version:separate[i].version}]}))};
 const pruned=pruneAnswerManifest(bound,[separate[1]]);
 assert.equal(pruned.units.length,1);assert.ok(pruned.text.startsWith('Tack för din fråga.'));assert.ok(pruned.text.includes(second));assert.equal(pruned.text.includes(quote),false);
 assert.deepEqual(pruned.outcomes.map(o=>o.status),['UNAVAILABLE','VERIFIED']);assert.deepEqual(pruned.presentation.unitIds,['u2']);
 assert.equal(pruneAnswerManifest(pruned,separate),pruned,'later evidence cannot restore a revoked unit');
 assert.equal(manifest.units.length,2,'original verified snapshot remains immutable');
});
test('multi-source compound statement loses its entire text, qualifiers and negation together',async()=>{
 const {manifest}=await run(); const units=[{...manifest.units[0],qualifiers:['only by agreement'],negation:true,evidenceRefs:[...manifest.units[0].evidenceRefs,{...manifest.units[0].evidenceRefs[0],sourceId:'revoked',evidenceId:'e2'}]},manifest.units[1]];
 const pruned=pruneAnswerManifest({...manifest,units},evidence);
 assert.deepEqual(pruned.units.map(u=>u.id),['u2']);assert.equal(pruned.text.includes(quote),false);assert.ok(pruned.text.includes(second));
});
test('loss of one unit on a shared facet does not claim complete coverage',async()=>{
 const {manifest}=await run();
 const units=manifest.units.map((u,i)=>({...u,facetIds:['f1'],evidenceRefs:i?[{...u.evidenceRefs[0],sourceId:'revoked'}]:u.evidenceRefs}));
 const outcomes=manifest.outcomes.map(o=>o.facetId==='f1'?{...o,materialUnitIds:['u1','u2']}:o);
 const pruned=pruneAnswerManifest({...manifest,units,outcomes},evidence);
 assert.equal(pruned.units.length,1);assert.equal(pruned.outcomes[0].status,'PARTIAL');assert.deepEqual(pruned.outcomes[0].unitIds,['u1']);
 assert.equal(pruned.outcomes[0].materialFactsComplete,false);
});

for(const remaining of [4159,6500,6501,8000])test(`composer admission at ${remaining}ms preserves exact verified sentences`,async()=>{
 const budget=new InformationBudget();budget.remaining=()=>remaining;
 let validations=0;
 const {manifest,calls}=await run({budget,finalPublicationRevalidates:true,revalidateEvidence:async()=>{validations++;return evidence;}});
 assert.equal(calls.includes('composition'),remaining>6500);
 assert.deepEqual(manifest.units.map(u=>u.text),[quote,second]);
 assert.deepEqual(manifest.units.map(u=>u.modality),['recommended','recommended']);
 assert.equal(validations,remaining>6500?4:2);
});
test('unguarded canonical caller still revalidates after verification when composer is skipped',async()=>{
 const budget=new InformationBudget();budget.remaining=()=>4159;let validations=0;
 await run({budget,revalidateEvidence:async()=>{validations++;return evidence;}});
 assert.equal(validations,3);
});

test('foreground contract preserves all canonical fields and leaves default caller instructions unchanged',async()=>{
 for(const foreground of [false,true]){
  const observed:string[]=[];
  await buildEvidenceFirstAnswer({question:'What arrangements are available?',language:'sv',facets,evidence,authoritativeEvidence:'',businessTone:{},history:[],budget:new InformationBudget(),foreground,current:async()=>true,
   generate:async(stage,instruction)=>{observed.push(instruction);return{text:stage==='extraction'?JSON.stringify({units:[proposal()]}):JSON.stringify({decisions:[],coverage:[]})};}});
  assert.equal(observed[0],foreground?FOREGROUND_UNIT_EXTRACTION_INSTRUCTION:UNIT_EXTRACTION_INSTRUCTION);
  assert.equal(observed[1],foreground?FOREGROUND_UNIT_VERIFICATION_INSTRUCTION:UNIT_VERIFICATION_INSTRUCTION);
 }
});

// Contract and rejection-gate tests with explicit semantic verdict fixtures.
// These do not establish how a live model will classify evidence.
const equipmentQuestion='Is equipment available for visitors, and is it free?';
const arrangement='Loan equipment is available through CityHire, collected at Side Door 4, about a three-minute walk from the centre.';
const offeringLimits='The centre does not supply free equipment and cannot arrange delivery.';
const optionalDetail='The cafe sells notebooks.';
const equipmentEvidence=answerEvidence(77,[{businessId:77,sourceId:'equipment-document',text:[arrangement,offeringLimits,optionalDetail].join('\n'),metadata:{documentRevision:'v1'}}]);
const equipmentFacets=parseRequestedFacets(literalInformationFallback(equipmentQuestion,true)!.requestedFacets).facets;
for(const kind of ['complete','optional-omitted','material-conjunct-missing','conjunct-only-in-quote','wrong-modality','unknown-third-party-terms','missing-direct-obligation','misaligned-plan','unsupported-price','contradiction']as const)
 test(`full-question coverage/${kind}: independent verdicts control completeness, never quote presence`,async()=>{
  const events:any[]=[],calls:string[]=[];
  const secondText=['material-conjunct-missing','conjunct-only-in-quote'].includes(kind)?'The centre does not supply free equipment.':kind==='missing-direct-obligation'?'The centre cannot arrange delivery.':kind==='unsupported-price'?'CityHire charges 25 SEK per hour.':offeringLimits;
  const missing=['material-conjunct-missing','conjunct-only-in-quote','missing-direct-obligation'].includes(kind);
  const units=[{...proposal(arrangement),language:'en',subject:'CityHire',predicate:'offers',value:'loan equipment',modality:'descriptive',scope:'visitor equipment',evidenceRefs:[{evidenceId:'e1',exactQuote:arrangement}]},
   {...proposal(secondText),language:'en',subject:'the centre',predicate:'provides',value:'free equipment and arranged delivery',modality:kind==='wrong-modality'?'prohibited':'descriptive',negation:true,scope:'the centre offering',evidenceRefs:[{evidenceId:'e1',exactQuote:kind==='material-conjunct-missing'?'The centre does not supply free equipment':offeringLimits}]}];
  const manifest=await buildEvidenceFirstAnswer({question:equipmentQuestion,language:'en',facets:equipmentFacets,evidence:equipmentEvidence,authoritativeEvidence:'',businessTone:{},history:[],budget:new InformationBudget(),foreground:true,current:async()=>true,diagnostic:e=>events.push(e),
   generate:async(stage,instruction,data:any)=>{
    calls.push(stage);
    if(stage==='extraction'||stage==='verification'){
     assert.equal(data.question,equipmentQuestion);assert.equal(data.facets[0].obligations[0].description,equipmentQuestion);
     assert.equal(data.evidence[0].text,equipmentEvidence[0].text,'No source clause is dropped or replaced');
     // Behavior below checks direct obligations, conditions and optional details.
     // The two stage contracts need not repeat the same editorial headings.
     assert.equal(instruction,stage==='extraction'?FOREGROUND_UNIT_EXTRACTION_INSTRUCTION:FOREGROUND_UNIT_VERIFICATION_INSTRUCTION);
    }
    if(stage==='extraction')return{text:JSON.stringify({oversized:false,units})};
    if(stage==='composition')return{text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})};
    assert.equal(stage,'verification');
    const rejected=['wrong-modality','unsupported-price','contradiction'].includes(kind);
    const ids=data.units.filter((_:any,i:number)=>!(i===1&&rejected)).map((u:any)=>u.id);
    const complete=!missing&&!rejected;
    return{text:JSON.stringify({decisions:data.units.map((u:any,i:number)=>({...verdict(u.id,'f1'),relation:i===1&&kind==='unsupported-price'?'UNKNOWN':i===1&&kind==='contradiction'?'CONTRADICTED':'ENTAILED',modalityPreserved:!(i===1&&kind==='wrong-modality'),negativeAbsence:i===1,explicitAbsenceEvidence:true})),
     coverage:[{facetId:'f1',requestAligned:kind!=='misaligned-plan',materialFactsComplete:complete,incompletenessReason:complete?'NONE':'MISSING_CONDITION',materialUnitIds:ids,obligations:[{obligationId:'f1.o1',status:complete&&kind!=='unknown-third-party-terms'?'COVERED':'UNRESOLVED',unitIds:complete&&kind!=='unknown-third-party-terms'?ids:[]}]}]})};
   }});
  assert.deepEqual(calls.slice(0,2),['extraction','verification']);assert.equal(events.some(e=>e.reason==='INVALID_CITATION'),false);
  const complete=['complete','optional-omitted'].includes(kind);
  assert.equal(manifest.outcomes[0].status,complete?'VERIFIED':'PARTIAL');
  if(complete){assert.ok(manifest.text.includes(offeringLimits));assert.equal(manifest.text.includes(optionalDetail),false);assert.ok(manifest.units.every(u=>u.modality==='descriptive'));}
  if(kind==='wrong-modality'){assert.ok(events.some(e=>e.reason==='MODALITY_CHANGED'));assert.equal(manifest.text.includes(secondText),false);}
  if(kind==='unsupported-price')assert.equal(manifest.text.includes('25 SEK'),false);
  if(kind==='unknown-third-party-terms'){assert.equal(manifest.outcomes[0].materialFactsComplete,true);assert.equal(manifest.outcomes[0].obligations[0].status,'UNRESOLVED');}
  if(missing)assert.ok(events.some(e=>e.reason==='MATERIAL_FACTS_MISSING'));
 });
for(const wrong of [false,true])test(`an actual prohibition stays normative; wrong descriptive tag rejected=${wrong}`,async()=>{
 const text='Guests must not use loan equipment unattended.';
 const facets=parseRequestedFacets([{subject:'guests',attribute:'unsupervised equipment use',questionType:'permission'}]).facets;
 const ev=answerEvidence(77,[{businessId:77,sourceId:'rules',text,metadata:{documentRevision:'v1'}}]);
 const events:any[]=[];
 const manifest=await buildEvidenceFirstAnswer({question:'May guests use loan equipment unattended?',language:'en',facets,evidence:ev,authoritativeEvidence:'',businessTone:{},history:[],budget:new InformationBudget(),foreground:true,current:async()=>true,diagnostic:e=>events.push(e),
  generate:async(stage)=>({text:JSON.stringify(stage==='extraction'?{units:[{...proposal(text),language:'en',subject:'guests',predicate:'use',value:'loan equipment unattended',scope:'guests',modality:wrong?'descriptive':'prohibited',negation:false}]}:stage==='verification'?{decisions:[{...verdict('u1','f1'),modalityPreserved:!wrong}],coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:!wrong,materialUnitIds:wrong?[]:['u1'],obligations:[{obligationId:'f1.o1',status:wrong?'UNRESOLVED':'COVERED',unitIds:wrong?[]:['u1']}]}]}:{unitIds:['u1'],prefix:'none',addition:false})})});
 assert.equal(manifest.units.length,wrong?0:1);if(!wrong){assert.equal(manifest.units[0].modality,'prohibited');assert.equal(manifest.outcomes[0].status,'VERIFIED');}
 else assert.ok(events.some(e=>e.reason==='MODALITY_CHANGED'));
});
