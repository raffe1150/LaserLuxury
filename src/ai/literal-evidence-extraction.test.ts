/** Offline source/citation contracts. Any changed verifier decisions are scripted;
 * historical captures are immutable and are not new model acceptance. */
import test,{after} from 'node:test';import assert from 'node:assert/strict';import{readFileSync,writeFileSync}from'node:fs';import{createHash}from'node:crypto';
import{captureLiteralEvidence,hydrateLiteralEvidenceReferences,resolveEvidenceQuote}from'./knowledge-citation';
import{knowledgeStructuredOutput,selectKnowledgeExtractionProtocol}from'./knowledge-answer-protocol';
import{buildEvidenceFirstAnswer,answerEvidence,InformationBudget,parseRequestedFacets,publishableKnowledgeManifest,completeKnowledgeManifest,literalEvidenceExtractionInstruction,UNIT_EXTRACTION_INSTRUCTION,FOREGROUND_UNIT_EXTRACTION_INSTRUCTION,UNIT_VERIFICATION_INSTRUCTION,FOREGROUND_UNIT_VERIFICATION_INSTRUCTION,type Evidence}from'./business-information-answer-plan';
import{DOCUMENT_AUTHORITY_EXTRACTION}from'./source-aware-service-proposal';
import{configuredServiceEvidence}from'./configured-service-evidence';
import{runAccuracyFirstNative,nativeKnowledgeTiming}from'./knowledge-timing-policy';
import{compactKnowledgeVerifierInput}from'./knowledge-verifier-input';
import{numericalConstraintSafe}from'./numerical-constraints';
const root='docs/validation/shared-core-2026-10-22',e:Evidence={id:'e1',businessId:77,sourceId:'owned',chunkId:'chunk',version:'r1',text:'För besökare fi nns Nordpark .\nشرط 😀'};
const unit={evidenceRefs:[{evidenceId:'e1'}]},raw={oversized:false,units:[unit,unit]};
const records:unknown[]=[];
after(()=>{if(process.env.ODINLINK_LITERAL_CONTRACT_RESULTS)writeFileSync(process.env.ODINLINK_LITERAL_CONTRACT_RESULTS,JSON.stringify({providerCalls:0,judgments:'SCRIPTED when inputs/protocols differ; saved captures unchanged',records},null,2),{flag:'wx'});});
test('backend snapshots are immutable; exact full-span UTF16 and OCR bytes survive without model offsets',()=>{
 const original={...e},s=captureLiteralEvidence(77,[original])!;assert.ok(Object.isFrozen(s)&&Object.isFrozen(s.spans)&&Object.isFrozen(s.spans[0]));original.text='changed';
 assert.equal(s.spans[0].start,0);assert.equal(s.spans[0].end,e.text.length);
 const hydrated=hydrateLiteralEvidenceReferences(raw,s,[e])as typeof raw&{units:{evidenceRefs:{exactQuote:string}[]}[]};assert.equal(hydrated.units.length,2);
 for(const u of hydrated.units)assert.equal(u.evidenceRefs[0].exactQuote,e.text);
 assert.equal(resolveEvidenceQuote(e.text,'För besökare finns Nordpark.').quote,undefined);
 assert.throws(()=>hydrateLiteralEvidenceReferences(raw,JSON.parse(JSON.stringify(s)),[e]),/unowned/);
});
for(const [name,items]of Object.entries({foreign:[{...e,businessId:88}],duplicate:[e,e],alias:[e,{...e,id:'e2'}],revision:[{...e,version:''}],source:[{...e,sourceId:''}]}))test(`invalid captured inventory fails closed: ${name}`,()=>assert.throws(()=>captureLiteralEvidence(77,items)));
test('2400 UTF16 limit selects v2 without truncating; the whole selected inventory must fit',()=>{
 assert.ok(captureLiteralEvidence(77,[{...e,text:'x'.repeat(2400)}]));assert.equal(captureLiteralEvidence(77,[e,{...e,id:'e2',chunkId:'other',text:'x'.repeat(2401)}]),null);
});
for(const [name,refs]of Object.entries({unknown:[{evidenceId:'e99'}],duplicate:[{evidenceId:'e1'},{evidenceId:'e1'}],quote:[{evidenceId:'e1',exactQuote:e.text}],offset:[{evidenceId:'e1',start:0,end:4}],type:[{evidenceId:1}]}))test(`invalid literal references preserve proposal count and receive no usable citation: ${name}`,()=>{
 const r={units:[{...unit,evidenceRefs:refs},unit]},s=captureLiteralEvidence(77,[e])!,h=hydrateLiteralEvidenceReferences(r,s,[e])as typeof r;
 assert.equal(h.units.length,2);assert.deepEqual(h.units[0].evidenceRefs,[]);assert.equal(h.units[1].evidenceRefs.length,1);assert.deepEqual(r.units[0].evidenceRefs,refs);
});
for(const [name,current]of Object.entries({revoked:[],source:[{...e,sourceId:'another'}],chunk:[{...e,chunkId:'another'}],revision:[{...e,version:'r2'}],text:[{...e,text:e.text+'!'}],id:[{...e,id:'e2'}]}))test(`changed current binding cannot hydrate: ${name}`,()=>{
 const h=hydrateLiteralEvidenceReferences(raw,captureLiteralEvidence(77,[e])!,current)as typeof raw;assert.equal(h.units.length,2);assert.ok(h.units.every(u=>!u.evidenceRefs.length));
});
test('foreign or duplicate current inventories are terminal, not permissive hydration',()=>{const s=captureLiteralEvidence(77,[e])!;assert.throws(()=>hydrateLiteralEvidenceReferences(raw,s,[{...e,businessId:88}]));assert.throws(()=>hydrateLiteralEvidenceReferences(raw,s,[e,e]));});
test('legacy prompts and serialized strict extraction/verifier schemas are unchanged',()=>{
 const old=JSON.parse(readFileSync(`${root}/literal-evidence-extraction-20261027/legacy-contracts.json`,'utf8'));
 for(const[k,v]of Object.entries({UNIT_EXTRACTION_INSTRUCTION,FOREGROUND_UNIT_EXTRACTION_INSTRUCTION,UNIT_VERIFICATION_INSTRUCTION,FOREGROUND_UNIT_VERIFICATION_INSTRUCTION,DOCUMENT_AUTHORITY_EXTRACTION}))assert.equal(createHash('sha256').update(v).digest('hex'),old.instructions[k]);
 for(const[k,v]of Object.entries({extraction:knowledgeStructuredOutput('extraction'),bounded:knowledgeStructuredOutput('extraction',false,['f1'],6),catalog:knowledgeStructuredOutput('extraction',false,['f1'],5),natural:knowledgeStructuredOutput('extraction',true,['f1'],6),verification:knowledgeStructuredOutput('verification',false,undefined,6,'v2')}))assert.equal(JSON.stringify(v),JSON.stringify(old.schemas[k]));
});
for(const natural of [false,true])test(`strict literal schema forbids model quotation/offsets, retaining bounds and natural=${natural}`,()=>{
 const s=knowledgeStructuredOutput('extraction',natural,['f1'],6,'v2','literal-evidence-v1'),schema=s.schema as any;
 assert.match(s.name,/extraction_literal_v1/);assert.equal(s.strict,true);const ref=schema.properties.units.items.properties.evidenceRefs;
 assert.deepEqual(ref.items.required,['evidenceId']);assert.equal(ref.items.additionalProperties,false);assert.deepEqual(Object.keys(ref.items.properties),['evidenceId']);assert.equal(ref.maxItems,4);assert.equal(schema.properties.units.maxItems,6);
});
test('protocol default remains v2; unsupported selection is rejected',()=>{const old=process.env.ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL;try{delete process.env.ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL;assert.equal(selectKnowledgeExtractionProtocol(),'v2');process.env.ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL='other';assert.throws(selectKnowledgeExtractionProtocol);}finally{if(old===undefined)delete process.env.ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL;else process.env.ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL=old;}});
for(const base of [UNIT_EXTRACTION_INSTRUCTION,FOREGROUND_UNIT_EXTRACTION_INSTRUCTION,DOCUMENT_AUTHORITY_EXTRACTION])test('versioned instruction replaces only the citation-transport clause',()=>{const selected=literalEvidenceExtractionInstruction(base);assert.match(selected,/literal-evidence-v1/);assert.doesNotMatch(selected,/Copy exact contiguous evidence quotes|exactQuote remains|Use exact contiguous quotes in the source language|"exactQuote":/);assert.match(selected,/untrusted/);assert.match(selected,/condition/);assert.match(selected,/negation/);});

function fixture(id:'C-fa'|'A-en'|'B-en'|'C-en'){
 const folder=id==='C-fa'?'native-four-language-revalidation-20261027/C-fa':id==='A-en'?'aen-accuracy-first-acceptance-20261025':id==='B-en'?'ben-direct-acceptance-20261025':'cen-direct-acceptance-20261025';
 const r=JSON.parse(readFileSync(`${root}/${folder}/${id==='C-fa'?'result':id+'.result'}.json`,'utf8')),ex=r.state.calls.find((c:any)=>c.stage==='extraction'),v=r.state.calls.find((c:any)=>c.stage==='verification'),vi=JSON.parse(v.request.input[0].content),context=JSON.parse(ex.request.input[0].content),proposal=JSON.parse(ex.outputText);
 const fresh=r.retrieval.filter((x:any)=>x.phase==='freshness').at(-1).matches;
 const matches=vi.evidence.filter((x:any)=>x.id!=='configured-services').map((x:any)=>{const match=fresh.find((m:any)=>m.text.trim()===x.text.trim());assert.ok(match);return{...match,text:x.text};});
 const evidence=answerEvidence(77,matches),catalog=vi.evidence.find((x:any)=>x.id==='configured-services');if(catalog)evidence.push(configuredServiceEvidence(77,JSON.parse(catalog.text).services)!);
 return{ex,v,vi,context,proposal,evidence};
}
type Fault='none'|'unknown-id'|'quote-injection'|'foreign'|'revoked'|'revision'|'stale-text'|'wrong-source'|'unsupported-fee'|'borrowed-number'|'permission'|'missing-condition'|'unknown'|'coverage'|'false-complete-after-loss'|'oversized'|'no-revalidation'|'timeout'|'duplicate-current'|'foreign-current';
async function replay(id:'C-fa'|'A-en'|'B-en'|'C-en',fault:Fault='none',protocol:'v2'|'literal-evidence-v1'='literal-evidence-v1'){
 const f=fixture(id),proposal=structuredClone(f.proposal),stages:string[]=[],events:any[]=[],sizes:any[]=[];let evidence=f.evidence,reads=0,result:any;
 if(protocol==='literal-evidence-v1')for(const u of proposal.units)u.evidenceRefs=u.evidenceRefs.map((r:any)=>({evidenceId:r.evidenceId}));
 if(fault==='foreign')evidence=evidence.map(e=>({...e,businessId:88}));
 if(fault==='oversized')evidence=evidence.map(e=>e.id==='e1'?{...e,text:e.text+'x'.repeat(2401)}:e);
 if(['unknown-id','false-complete-after-loss'].includes(fault))proposal.units[0].evidenceRefs[0].evidenceId='e99';
 if(fault==='quote-injection')proposal.units[0].evidenceRefs[0].exactQuote='Model supplied quote';
 if(fault==='unsupported-fee')proposal.units[0].text='هزینه پارکینگ Nordpark برابر با 999 SEK است.';
 if(fault==='borrowed-number')proposal.units[0].text='هزینه پارکینگ Nordpark برابر با 14 SEK است.';
 if(fault==='permission')proposal.units[0].text='You may drink water in the treatment room.';
 if(fault==='missing-condition')proposal.units[0].text='You must follow preparation instructions before every visit.';
 await runAccuracyFirstNative(async()=>{
 const manifest=await buildEvidenceFirstAnswer({question:f.vi.question,language:f.vi.requestedLanguage,facets:parseRequestedFacets(f.vi.facets).facets,evidence,businessId:77,extractionProtocol:protocol,verificationProtocol:'v2',foreground:true,omitModelEvidenceVersions:true,authoritativeEvidence:f.vi.authoritativeEvidence,businessTone:f.context.businessTone,history:f.context.relevantHistory,budget:new InformationBudget(undefined,nativeKnowledgeTiming()),current:async()=>true,languageSafe:u=>u.language===f.vi.requestedLanguage,diagnostic:e=>events.push(e),
  ...(fault==='no-revalidation'?{}:{revalidateEvidence:async()=>{reads++;if(reads<2)return evidence;if(fault==='duplicate-current')return [...evidence,evidence[0]];if(fault==='foreign-current')return [{...evidence[0],businessId:88},...evidence];if(fault==='revoked')return evidence.filter(e=>e.id!=='e1');if(fault==='revision')return evidence.map(e=>e.id==='e1'?{...e,version:e.version+'-changed'}:e);if(fault==='stale-text')return evidence.map(e=>({...e,text:e.text+' changed'}));if(fault==='wrong-source')return evidence.map(e=>({...e,sourceId:'different'}));return evidence;}}),
  generate:async(stage,instruction,data:any,contract)=>{
   stages.push(stage);
   if(stage==='extraction'){
    const effective=contract!.extractionProtocol;assert.ok(Object.isFrozen(contract));assert.equal(effective,fault==='oversized'?'v2':protocol);
    const schema=knowledgeStructuredOutput('extraction',false,data.allowedFacetIds,6,'v2',effective);
    assert.equal(schema.name,effective==='v2'?'odinlink_knowledge_extraction_v2':'odinlink_knowledge_extraction_literal_v1');
    assert.equal(instruction.includes('literal-evidence-v1'),effective==='literal-evidence-v1');
    sizes.push({stage,inputBytes:Buffer.byteLength(JSON.stringify(data)),schemaBytes:Buffer.byteLength(JSON.stringify(schema)),responseBytes:Buffer.byteLength(JSON.stringify(proposal)),protocol:effective});
    process.env.ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL='v2'; // Must not change captured hydration.
    if(fault==='timeout')throw Error('information_deadline');
    return{text:JSON.stringify(fault==='oversized'?f.proposal:proposal)};
   }
   assert.equal(stage,'verification','No optional generation or retry');assert.equal(data.question,f.vi.question);
   for(const u of data.units)for(const ref of u.evidenceRefs){const e=data.evidence.find((e:any)=>e.id===ref.evidenceId);assert.ok(e?.text.includes(ref.exactQuote));if(protocol==='literal-evidence-v1'&&fault!=='oversized'&&ref.evidenceId!=='configured-services')assert.equal(ref.exactQuote,e.text);}
   if(id==='C-fa'&&protocol==='literal-evidence-v1'&&fault==='none'){assert.equal(data.units.length,3);assert.ok(data.units[0].evidenceRefs[0].exactQuote.includes('fi nns'));}
   sizes.push({stage,inputBytes:Buffer.byteLength(JSON.stringify(compactKnowledgeVerifierInput(data))),quotedCharacters:data.units.flatMap((u:any)=>u.evidenceRefs).reduce((n:number,r:any)=>n+r.exactQuote.length,0)});
   // New protocol changes the verifier input. These are explicitly SCRIPTED
   // consumer controls, never reused real judgments for the enlarged quotes.
   const v=JSON.parse(f.v.outputText);
   v.decisions=data.units.map((u:any,i:number)=>({unitId:u.id,facetIds:u.facetIds,relation:['borrowed-number','permission','missing-condition','unknown'].includes(fault)&&i===0?'UNKNOWN':'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:fault!=='missing-condition'||i!==0,relevant:!(id==='C-fa'&&u.id==='u1'),languageCorrect:true,negativeAbsence:id==='C-fa'&&u.id!=='u1',explicitAbsenceEvidence:id==='C-fa'&&u.id!=='u1'}));
   if(fault==='coverage'){v.coverage[0].materialFactsComplete=false;v.coverage[0].incompletenessReason='MISSING_CONDITION';v.coverage[0].obligations.forEach((o:any)=>o.status='UNRESOLVED');}
   if(fault==='false-complete-after-loss'){v.coverage.forEach((c:any)=>{c.materialFactsComplete=true;c.incompletenessReason='NONE';c.materialUnitIds=data.units.map((u:any)=>u.id);c.obligations.forEach((o:any)=>{o.status='COVERED';o.unitIds=c.materialUnitIds;});});}
   return{text:JSON.stringify(v)};
  }});
 result={manifest,allowed:publishableKnowledgeManifest(manifest,77),complete:completeKnowledgeManifest(manifest),events,stages,reads,sizes};
 },async()=>{});
 assert.ok(result);assert.ok(stages.filter(s=>s==='extraction').length<=1);assert.ok(stages.filter(s=>s==='verification').length<=1);
 records.push({id,fault,protocol,...result});return result;
}
test('C-fa all three original proposals parse literally; scripted independent rejection of irrelevant supplement permits correct PARTIAL',async()=>{
 const r=await replay('C-fa');assert.equal(r.allowed,true);assert.equal(r.complete,false);assert.equal(r.manifest.units.length,2);assert.ok(!r.events.some((e:any)=>e.reason==='INVALID_CITATION'));assert.match(r.manifest.text,/AdMotion Studio پارکینگ رایگان ارائه نمی‌کند/);assert.match(r.manifest.text,/نمی‌تواند برای بازدیدکننده جای پارک رزرو کند/);assert.match(r.manifest.text,/نمی‌توانم «هزینه پارکینگ Nordpark»/);assert.deepEqual(r.stages,['extraction','verification']);
});
test('original unchanged C-fa v2 rewritten quotation remains rejected',async()=>{const r=await replay('C-fa','none','v2');assert.equal(r.allowed,false);assert.ok(r.events.some((e:any)=>e.reason==='INVALID_CITATION'));});
for(const fault of ['unknown-id','quote-injection','foreign','revoked','revision','stale-text','wrong-source','unsupported-fee','borrowed-number','unknown','coverage','false-complete-after-loss','no-revalidation','timeout','duplicate-current','foreign-current']as const)test(`literal C-fa fail-closed control: ${fault}`,async()=>{const r=await replay('C-fa',fault);assert.equal(r.allowed,false);assert.equal(r.complete,false);});
for(const fault of ['permission','missing-condition']as const)test(`whole chunk provenance cannot authorize ${fault}`,async()=>{const r=await replay('A-en',fault);assert.equal(r.allowed,false);assert.equal(r.complete,false);});
test('oversized chunk falls back to original v2 before the single extraction dispatch',async()=>{const r=await replay('C-fa','oversized');assert.equal(r.sizes[0].protocol,'v2');assert.equal(r.stages.filter((s:string)=>s==='extraction').length,1);});
for(const id of ['A-en','B-en','C-en']as const)test(`literal opt-in preserves ${id} coverage/catalog contract with SCRIPTED verifier responses`,async()=>{const r=await replay(id);assert.equal(r.allowed,true);assert.equal(r.complete,id==='A-en');if(id==='B-en'){assert.match(r.manifest.text,/300 SEK.*60 minutes/);assert.match(r.manifest.text,/cannot confirm whether/);const catalog=r.manifest.units.find((u:any)=>u.evidenceRefs.some((r:any)=>r.evidenceId==='configured-services'));assert.ok(catalog);assert.ok(catalog.evidenceRefs[0].exactQuote.length<2400);}if(id==='C-en')assert.match(r.manifest.text,/cannot verify “Nordpark's parking fee”/);});

// Isolate semantic guards from the separately recorded broad-quotation/numeric
// incompatibility. These source fixtures contain no unrelated temporal rule.
for(const fault of ['none','fee','borrowed-number','permission','condition','unknown','false-complete-after-loss']as const)test(`literal provenance is not publication authority: isolated ${fault}`,async()=>{
 const text='If preparation instructions are received, follow them. Visitors may bring a water bottle. Food is prohibited in treatment rooms, but light snacks are permitted in the waiting room. The entrance is at number 14.';
 const evidence=[{...e,text}],question='May I eat snacks in the waiting room and in treatment rooms?';let stages:string[]=[],verificationCalls=0,allowed=false,complete=false;
 await runAccuracyFirstNative(async()=>{
  const manifest=await buildEvidenceFirstAnswer({question,language:'en',businessId:77,extractionProtocol:'literal-evidence-v1',verificationProtocol:'v2',facets:parseRequestedFacets([{subject:'visitor policy',attribute:question,questionType:'description'}]).facets,evidence,foreground:true,authoritativeEvidence:'{}',businessTone:{},history:[],budget:new InformationBudget(undefined,nativeKnowledgeTiming()),current:async()=>true,revalidateEvidence:async()=>evidence,languageSafe:()=>true,
   generate:async(stage,_instruction,data:any)=>{
    stages.push(stage);if(stage==='extraction')return{text:JSON.stringify({oversized:false,units:[{facetIds:['f1'],subject:'Visitors',predicate:'food policy',value:'room-specific rule',scope:'visitor rooms',modality:'descriptive',negation:true,qualifiers:[],language:'en',text:fault==='fee'?'Parking costs 999 SEK.':fault==='borrowed-number'?'Parking costs 14 SEK.':fault==='permission'?'Visitors may drink water in treatment rooms.':fault==='condition'?'Visitors must always follow preparation instructions.':'Food is prohibited in treatment rooms, but light snacks are permitted in the waiting room.',evidenceRefs:[{evidenceId:fault==='false-complete-after-loss'?'missing':'e1'}]}]})};
    assert.equal(stage,'verification');verificationCalls++;assert.equal(data.units[0].evidenceRefs[0].exactQuote,text);
    return{text:JSON.stringify({decisions:[{unitId:'u1',facetIds:['f1'],relation:fault==='none'?'ENTAILED':'UNKNOWN',meaningPreserved:fault==='none',modalityPreserved:fault!=='permission',qualifiersPreserved:fault!=='condition',relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false}],coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:fault==='none',incompletenessReason:fault==='none'?'NONE':fault==='condition'?'MISSING_CONDITION':'UNRESOLVED',materialUnitIds:['u1'],obligations:data.facets[0].obligations.map((o:any)=>({obligationId:o.id,status:fault==='none'?'COVERED':'UNRESOLVED',unitIds:['u1']}))}]})};
   }});allowed=publishableKnowledgeManifest(manifest,77);complete=completeKnowledgeManifest(manifest);
 },async()=>{});
 assert.equal(allowed,fault==='none');assert.equal(complete,fault==='none');assert.equal(stages.filter(s=>s==='extraction').length,1);assert.equal(verificationCalls,fault==='false-complete-after-loss'?0:1);
});

test('documented compatibility blocker: unrelated arrival timing in whole C-fa chunk triggers unchanged numeric veto',()=>{const f=fixture('C-fa'),claim=f.proposal.units[1].text,quote=f.proposal.units[1].evidenceRefs[0].exactQuote,chunk=f.evidence[0].text;assert.match(chunk,/10 minuter före/u);assert.equal(numericalConstraintSafe(claim,claim,[quote]),true);assert.equal(numericalConstraintSafe(claim,claim,[chunk]),false);});
