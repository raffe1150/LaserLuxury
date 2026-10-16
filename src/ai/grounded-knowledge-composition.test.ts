import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerEvidence, buildEvidenceFirstAnswer, InformationBudget, parseRequestedFacets, pruneAnswerManifest, UNIT_VERIFICATION_INSTRUCTION } from './business-information-answer-plan';
import { NATURAL_FLAGS, NATURAL_LIMITS, naturalAttachmentCurrent, naturalContractHash, naturalProposalReason, parseNaturalProposal } from './grounded-knowledge-composition';
import { knowledgeStructuredOutput } from './knowledge-answer-protocol';

const rec='We recommend booking in advance.', arrangement='Visits are arranged by agreement.';
const natural='We recommend arranging your visit in advance. I cannot confirm whether you can visit without a booking.';
const scope={turnId:'synthetic-turn',businessId:77,question:'May I visit without a booking?',tone:{tonePreset:'warm'}};
const evidence=answerEvidence(77,[{businessId:77,sourceId:'rec-source',text:rec,metadata:{documentRevision:'v1'}},
 {businessId:77,sourceId:'arr-source',text:arrangement,metadata:{documentRevision:'v1'}}]);
const facets=parseRequestedFacets([{subject:'visits',attribute:'visit policy',questionType:'permission',obligations:[
 {description:'permission to visit without booking',questionType:'permission'},{description:'advance booking recommendation',questionType:'recommendation'}]}]).facets;
const proposal=()=>({blocks:[{kind:'fact',text:'We recommend arranging your visit in advance.',proposedUnitOrdinals:[1],obligationIds:[]},
 {kind:'uncertainty',text:'I cannot confirm whether you can visit without a booking.',proposedUnitOrdinals:[],obligationIds:['f1.o1']}]});
export function naturalVerdict(data:any) {
 return {contractHash:data.contractHash,proposalHash:data.proposalHash,flags:Object.fromEntries(NATURAL_FLAGS.map(f=>[f,true])),
  blocks:data.proposal.blocks.map((b:any)=>({blockId:b.id,relation:'ENTAILED',noUnsupportedFacts:true,meaningPreserved:true,uncertaintyAccurate:true})),
  unitCoverage:data.contract.units.map((u:any)=>({unitId:u.id,blockIds:data.proposal.blocks.filter((b:any)=>b.unitIds.includes(u.id)).map((b:any)=>b.id),complete:true})),
  obligationCoverage:data.contract.outcomes.flatMap((o:any)=>o.obligations.filter((d:any)=>d.status==='UNRESOLVED').map((d:any)=>({obligationId:d.obligationId,
   blockIds:data.proposal.blocks.filter((b:any)=>b.obligationIds.includes(d.obligationId)).map((b:any)=>b.id),accurate:true})))};
}
// Native fixtures define their own verifier responses; this helper drives only
// pure contract tests. No provider, database, transport or Calendar is available.
async function run(o:{proposal?:any;verdict?:(data:any)=>any;single?:boolean;direct?:boolean;enabled?:boolean;allowSinglePartial?:boolean;
  stageFailure?:string;result?:any;delay?:number;budget?:InformationBudget;fresh?:()=>Promise<any>;current?:()=>Promise<boolean>;
  languageSafe?:(u:any)=>boolean;scope?:typeof scope;unitReject?:boolean}={}) {
 const calls:string[]=[],events:any[]=[],budget=o.budget||new InformationBudget();
 const units=[rec,...(o.single===false?[arrangement]:[])].map((text,i)=>({facetIds:['f1'],subject:'studio',predicate:'states',value:text,
  modality:i?'descriptive':'recommended',negation:false,scope:'visits',qualifiers:[],language:'en',text,evidenceRefs:[{evidenceId:`e${i+1}`,exactQuote:text}]}));
 const fs=o.direct?parseRequestedFacets([{subject:'visits',attribute:'recommendation',questionType:'recommendation'}]).facets:facets;
 const manifest=await buildEvidenceFirstAnswer({question:scope.question,language:'en',facets:fs,evidence,authoritativeEvidence:'',businessTone:scope.tone,history:[],budget,
  ...(o.enabled===false?{}:{natural:{scope:o.scope||scope,allowSinglePartial:o.allowSinglePartial!==false}}),
  current:o.current|| (async()=>true),revalidateEvidence:o.fresh,languageSafe:o.languageSafe||(()=>true),diagnostic:e=>events.push(e),
  generate:async(stage,instruction,data:any)=>{
   budget.attempt();calls.push(stage);if(o.stageFailure===stage)throw new Error('private provider failure body');
   if(stage==='extraction')return{text:JSON.stringify({units,naturalProposal:o.proposal===undefined?proposal():o.proposal})};
   if(stage==='verification'){
    assert.equal(instruction,UNIT_VERIFICATION_INSTRUCTION,'factual judge instructions unchanged');
    assert.equal(JSON.stringify(data).includes('naturalProposal'),false);assert.equal(JSON.stringify(data).includes('arranging your visit'),false,'unit judge is blind to speculative prose');
    return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,relation:o.unitReject?'UNKNOWN':'ENTAILED',facetIds:u.facetIds,meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,
     relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:fs.map(f=>({facetId:f.id,requestAligned:true,materialFactsComplete:true,materialUnitIds:data.units.map((u:any)=>u.id),
      obligations:f.obligations.map(ob=>({obligationId:ob.id,status:ob.questionType==='permission'?'UNRESOLVED':'COVERED',unitIds:ob.questionType==='permission'?[]:['u1']}))}))})};
   }
   if(stage==='composition')return{text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})};
   assert.equal(stage,'presentation_verification');assert.equal(JSON.stringify(data.contract).includes('exactQuote'),false,'no full-document/quote replay');
   if(o.delay)await new Promise(resolve=>setTimeout(resolve,o.delay));
   return o.result||{text:JSON.stringify(o.verdict?o.verdict(data):naturalVerdict(data))};
  }});
 return {manifest,calls,events,budget};
}
test('independently accepted partial answer uses fluent prose without fixed question echo or tail',async()=>{
 const {manifest,calls}=await run();assert.equal(manifest.text,natural);assert.equal(manifest.naturalOutcome,'accepted_natural');
 assert.equal(manifest.presentationPath,'validated_natural');assert.equal(manifest.outcomes[0].status,'PARTIAL');assert.equal(manifest.units[0].text,rec);
 assert.deepEqual(calls,['extraction','verification','presentation_verification']);assert.ok(manifest.naturalAttachment);assert.ok(Object.isFrozen(manifest.naturalAttachment));
 assert.equal(naturalAttachmentCurrent(manifest.naturalAttachment!,manifest,scope),true);
});
test('single VERIFIED remains direct, even if an optional presentation was proposed',async()=>{
 const {manifest,calls}=await run({direct:true});assert.equal(manifest.text,rec);assert.equal(manifest.naturalOutcome,'direct_canonical');assert.equal(calls.length,2);
});
test('single PARTIAL has an explicit default-off admission gate',async()=>{
 const {manifest,calls}=await run({allowSinglePartial:false});assert.equal(manifest.naturalOutcome,'canonical_fallback');assert.equal(manifest.naturalReason,'NATURAL_SINGLE_PARTIAL_DISABLED');
 assert.ok(manifest.text.includes(rec));assert.equal(calls.length,2);
});
test('feature OFF keeps original reference composer and canonical wording',async()=>{
 const {manifest,calls}=await run({enabled:false,single:false});assert.deepEqual(calls,['extraction','verification','composition']);assert.equal(manifest.naturalOutcome,undefined);assert.ok(manifest.text.includes(rec));assert.ok(manifest.text.includes(arrangement));
});
for(const field of NATURAL_FLAGS)test(`final verifier rejects ${field}=false without erasing a verified fact`,async()=>{
 const {manifest}=await run({verdict:d=>{const v=naturalVerdict(d);v.flags[field]=false;return v;}});
 assert.equal(manifest.naturalOutcome,'canonical_fallback');assert.equal(manifest.naturalReason,'NATURAL_SEMANTIC_REJECTION');assert.ok(manifest.text.includes(rec));assert.equal(manifest.text.includes('arranging your visit'),false);
});
for(const fault of ['wrong-hash','wrong-proposal','missing-block','duplicate-block','wrong-block','unknown','contradicted','missing-unit','duplicate-unit','wrong-unit','wrong-binding','missing-obligation','duplicate-obligation','wrong-obligation','missing-flag','extra-prose'] as const)
 test(`protocol/${fault}: invalid independent verdict fails closed`,async()=>{
  const {manifest}=await run({verdict:d=>{const v:any=naturalVerdict(d);
   if(fault==='wrong-hash')v.contractHash='foreign';if(fault==='wrong-proposal')v.proposalHash='stale';if(fault==='missing-block')v.blocks.pop();if(fault==='duplicate-block')v.blocks[1]=v.blocks[0];if(fault==='wrong-block')v.blocks[0].blockId='foreign';
   if(fault==='unknown')v.blocks[0].relation='UNKNOWN';if(fault==='contradicted')v.blocks[0].relation='CONTRADICTED';if(fault==='missing-unit')v.unitCoverage=[];if(fault==='duplicate-unit')v.unitCoverage.push(v.unitCoverage[0]);if(fault==='wrong-unit')v.unitCoverage[0].unitId='u6';
   if(fault==='wrong-binding')v.unitCoverage[0].blockIds=['b2'];if(fault==='missing-obligation')v.obligationCoverage=[];if(fault==='duplicate-obligation')v.obligationCoverage.push(v.obligationCoverage[0]);if(fault==='wrong-obligation')v.obligationCoverage[0].obligationId='f9.o9';if(fault==='missing-flag')delete v.flags.noActionClaims;if(fault==='extra-prose')v.answer='Unsupported replacement';return v;
  }});assert.equal(manifest.naturalOutcome,'canonical_fallback');assert.ok(manifest.text.includes(rec));
 });
for(const p of [null,{},'not-json',{blocks:[]},{...proposal(),extra:'outside prose'},{blocks:[{...proposal().blocks[0],kind:'courtesy'}]},
 {blocks:[{...proposal().blocks[0],proposedUnitOrdinals:[7]}]},{blocks:[{...proposal().blocks[0],obligationIds:['foreign']}]},
 {blocks:[{...proposal().blocks[0],text:'x'.repeat(2401)}]},{blocks:Array(9).fill(proposal().blocks[0])}])
 test('malformed optional proposal cannot invalidate canonical units or spend another call',async()=>{
  const {manifest,calls}=await run({proposal:p});assert.equal(manifest.units.length,1);assert.equal(manifest.naturalOutcome,'canonical_fallback');assert.equal(calls.length,2);
 });
for(const [text,reason] of [['You must book in advance.','NATURAL_SEMANTIC_REJECTION'],['Walk-in visits are permitted.','NATURAL_SEMANTIC_REJECTION'],
 ['Walk-in visits are forbidden.','NATURAL_SEMANTIC_REJECTION'],['There is no walk-in policy.','NATURAL_SEMANTIC_REJECTION'],['Parking is free.','NATURAL_SEMANTIC_REJECTION']] as const)
 test(`unsupported policy mutation is rejected by independent verification: ${text}`,async()=>{
  const p=proposal();p.blocks[0].text=text;const {manifest}=await run({proposal:p,verdict:d=>{const v=naturalVerdict(d);v.flags.noUnsupportedFacts=false;return v;}});
  assert.equal(manifest.naturalReason,reason);assert.equal(manifest.text.includes(text),false);assert.ok(manifest.text.includes(rec));
 });
test('local booking-success veto rejects even an approving mock verdict before a final call',async()=>{
 const p=proposal();p.blocks[0].text='Your appointment is confirmed.';const {manifest,calls}=await run({proposal:p});assert.equal(manifest.naturalReason,'OPERATION_CLAIM');assert.equal(calls.length,2);
});
test('local quantity check rejects added business numbers before a final call',async()=>{
 const p=proposal();p.blocks[0].text='We require 24 hours of notice.';const {manifest,calls}=await run({proposal:p});assert.equal(manifest.naturalReason,'NUMERICAL_CONSTRAINT');assert.equal(calls.length,2);
});
test('missing independent fact cannot hide behind a complete-coverage mock',async()=>{
 const {manifest,calls}=await run({single:false});assert.equal(manifest.naturalReason,'NATURAL_BINDINGS');assert.equal(calls.length,2);assert.ok(manifest.text.includes(arrangement));
 const accepted=await run();const partial={...accepted.manifest,outcomes:accepted.manifest.outcomes.map(o=>({...o,materialFactsComplete:false}))};
 assert.equal(naturalProposalReason(parseNaturalProposal(proposal(),facets)!,partial,scope,()=>true),'NATURAL_CONTRACT_INVALID','an unrepresented material gap cannot be replaced by apparently adequate uncertainty prose');
});
test('question echo is locally rejected, without factual loss',async()=>{
 const p=proposal();p.blocks[1].text=scope.question;const {manifest}=await run({proposal:p});assert.equal(manifest.naturalReason,'NATURAL_REPETITION');assert.ok(manifest.text.includes(rec));
});
test('language mismatch is locally rejected after unit verification',async()=>{
 const {manifest,calls}=await run({languageSafe:u=>u.text===rec});assert.equal(manifest.naturalReason,'LOCAL_LANGUAGE');assert.equal(calls.length,2);assert.ok(manifest.text.includes(rec));
});
for(const failure of ['REFUSAL','TRUNCATED','BLOCKED'])test(`final ${failure} retains canonical partial information`,async()=>{
 const {manifest}=await run({result:{text:'{}',structuredFailure:failure}});assert.equal(manifest.naturalReason,failure);assert.ok(manifest.text.includes(rec));
});
test('invalid JSON is never customer-facing prose',async()=>{
 const {manifest}=await run({result:{text:'Unsupported free text'}});assert.equal(manifest.naturalOutcome,'canonical_fallback');assert.ok(manifest.text.includes(rec));assert.equal(manifest.text.includes('Unsupported free text'),false);
});
test('unit rejection never reaches presentation approval',async()=>{
 const {manifest,calls}=await run({unitReject:true});assert.equal(manifest.units.length,0);assert.deepEqual(calls,['extraction','verification']);
});
test('foreign scope cannot authorize a natural attachment',async()=>{
 const {manifest,calls}=await run({scope:{...scope,businessId:88}});assert.equal(manifest.naturalReason,'NATURAL_CONTRACT_INVALID');assert.equal(calls.length,2);
});
test('revocation after natural acceptance invalidates prose and preserves independent current units',async()=>{
 const p=proposal();p.blocks[0].proposedUnitOrdinals=[1,2];p.blocks[0].text=rec+' '+arrangement;
 const {manifest,calls}=await run({single:false,proposal:p});assert.equal(manifest.naturalOutcome,'accepted_natural');
 const pruned=pruneAnswerManifest(manifest,[evidence[0]]);assert.equal(pruned.naturalAttachment,undefined);assert.equal(pruned.naturalOutcome,'canonical_fallback');
 assert.ok(pruned.text.includes(rec));assert.equal(pruned.text.includes(arrangement),false);assert.equal(calls.length,3);
});
for(const change of ['turn','tenant','language','coverage'] as const)test(`contract ${change} change invalidates cached natural prose even with unchanged sources`,async()=>{
 const {manifest}=await run();const changed:any={...manifest};
 if(change==='turn')changed.naturalScope={...scope,turnId:'next-turn'};if(change==='tenant')changed.naturalScope={...scope,businessId:88};if(change==='language')changed.language='sv';if(change==='coverage')changed.outcomes=manifest.outcomes.map(o=>({...o,materialFactsComplete:false}));
 const pruned=pruneAnswerManifest(changed,evidence);assert.equal(pruned.naturalAttachment,undefined);assert.equal(pruned.naturalOutcome,'canonical_fallback');assert.ok(pruned.text.includes(rec));
});
test('exhausted four-call budget cannot launch a fifth request',async()=>{
 const budget=new InformationBudget();budget.attempt();budget.attempt();const {manifest,calls}=await run({budget});assert.equal(budget.attempts,4);assert.equal(calls.length,2);assert.equal(manifest.naturalReason,'COMPOSER_SKIPPED_BUDGET');
});
test('insufficient shared deadline skips optional validation and retains canonical facts',async()=>{
 const budget=new InformationBudget(1900);const {manifest,calls}=await run({budget});assert.equal(calls.length,2);assert.equal(manifest.naturalReason,'COMPOSER_SKIPPED_BUDGET');assert.ok(manifest.text.includes(rec));
});
test('final verification is capped at two seconds with no late prose publication',async()=>{
 const start=Date.now();const {manifest,calls}=await run({delay:2050});assert.equal(manifest.naturalReason,'NATURAL_TIMEOUT');assert.equal(manifest.naturalOutcome,'canonical_fallback');assert.equal(calls.length,3);
 assert.ok(Date.now()-start<2400);assert.equal(NATURAL_LIMITS.verificationMs,2000);assert.ok(manifest.text.includes(rec));
});
test('natural schemas are explicit extensions, OFF unit schema is unchanged',()=>{
 const off:any=knowledgeStructuredOutput('extraction'),on:any=knowledgeStructuredOutput('extraction',true),judge:any=knowledgeStructuredOutput('presentation_verification',true);
 assert.equal(off.name,'odinlink_knowledge_extraction_v2');assert.equal(off.schema.properties.naturalProposal,undefined);assert.ok(on.schema.properties.naturalProposal);
 assert.deepEqual(on.schema.properties.units,off.schema.properties.units);assert.equal(judge.schema.additionalProperties,false);assert.ok(judge.schema.required.includes('flags'));
});
test('proposal references are immutable, bounded and server assigned',()=>{
 const parsed=parseNaturalProposal(proposal(),facets)!;assert.equal(parsed.blocks[0].id,'b1');assert.deepEqual(parsed.blocks[0].unitIds,['u1']);assert.ok(Object.isFrozen(parsed.blocks[0].unitIds));
 assert.equal(parsed.hash.length,64);assert.equal(naturalContractHash({language:'en',units:[],facets,outcomes:[]},scope).length,64);
});
