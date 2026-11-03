/** Exact genuine failure replay; isolated changed scenarios below are explicitly
 * SCRIPTED contract controls, never new genuine acceptance or repaired verdicts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {captureCanonicalConfigurationProducer,canonicalConfigurationOutputValid} from './canonical-configuration-propositions';
import {cancellationConfigurationProposals} from './cancellation-answer-recovery';
import {parseAnswerUnits,parseRequestedFacets} from './business-information-answer-plan';
import {assessSourceCoverage,SOURCE_EXHAUSTIVE_V2_PROTOCOL,SOURCE_EXHAUSTIVE_V2_INSTRUCTION,sourceExhaustiveSchema} from './source-exhaustive-coverage';
import {knowledgeStructuredOutput} from './knowledge-answer-protocol';
const genuine=JSON.parse(readFileSync(new URL('../../tests/fixtures/genuine-luna-canonical-attribution-20261102.json',import.meta.url),'utf8'));
const incident=JSON.parse(readFileSync(new URL('../../tests/fixtures/genuine-luna-cancellation-coverage-20261102.json',import.meta.url),'utf8'));
const input=genuine.verification.input,evidence=[...incident.frozen.evidence,incident.frozen.configurationEvidence];
const facets=parseRequestedFacets(input.facets).facets,units=parseAnswerUnits({units:input.units},facets,evidence,'en').units;
const proposals=cancellationConfigurationProposals(input.question,'en',facets,incident.frozen.configurationEvidence);
const ctx=captureCanonicalConfigurationProducer(77,proposals,evidence);
const packet=()=>({oversized:false,units:structuredClone(ctx.units)});

test('exact genuine wrong-attribution output is rejected whole without changing capture or verdict',()=>{
 const before=JSON.stringify(genuine);
 assert.equal(canonicalConfigurationOutputValid(genuine.extraction,ctx,evidence),false);
 assert.deepEqual(genuine.verification.raw.decisions.map((d:any)=>d.relation),['UNKNOWN','UNKNOWN','ENTAILED','ENTAILED']);
 assert.equal(assessSourceCoverage(genuine.verification.raw,facets,units,evidence,77,SOURCE_EXHAUSTIVE_V2_PROTOCOL).state,'DENIED');
 assert.equal(JSON.stringify(genuine),before);
});
test('correctly attributed canonical units remain admissible, not verified by producer membership',()=>{
 assert.equal(canonicalConfigurationOutputValid(packet(),ctx,evidence),true);
});
for(const [name,change] of Object.entries({
 exact:()=>{},value:(u:any)=>{u.value='enabled';},negation:(u:any)=>{u.negation=false;},scope:(u:any)=>{u.scope='all fees';},
 text:(u:any)=>{u.text='All cancellations are always free.';},
 'renamed fields with copied assertion':(u:any)=>{u.subject='different';u.predicate='different';},
 'unicode and whitespace slot':(u:any)=>{u.subject='  BUSINESS  CANCELLATION CONFIGURATION ';u.predicate='ＯＰＴＩＯＮＡＬ ＬＡＴＥ ＦＥＥ';u.text='different';},
} as Record<string,(u:any)=>void>))test(`reserved proposition cannot enter documentary branch/${name}`,()=>{
 const p=packet(),u:any=p.units[1];u.evidenceRefs=[{evidenceId:evidence[0].id}];change(u);
 const before=JSON.stringify(p);assert.equal(canonicalConfigurationOutputValid(p,ctx,evidence),false);assert.equal(JSON.stringify(p),before);
});
test('legitimate independent documentary fact remains admissible beside canonical facts',()=>{
 const doc={...ctx.units[0],subject:'lost property',predicate:'storage duration',value:'up to 21 days',scope:'normally',
 text:'Lost property is normally stored for up to 21 days.',evidenceRefs:[{evidenceId:evidence[0].id}]};
 assert.equal(canonicalConfigurationOutputValid({oversized:false,units:[doc,...ctx.units]},ctx,evidence),true);
 // This is producer admission only. Relevance, exact entailment and publication
 // still require the independent verifier; this fact is not a cancellation answer.
});
for(const [name,change] of Object.entries({
 unknown:(es:any[])=>{es[0].id='unknown';},stale:(es:any[])=>{es[1].version='stale';},
 revoked:(es:any[])=>{es.splice(1,1);},foreign:(es:any[])=>{es[1].businessId=999;},
 changed:(es:any[])=>{es[1].text+=' changed';},
} as Record<string,(es:any[])=>void>))test(`current authoritative inventory must match/${name}`,()=>{
 const es=structuredClone(evidence);change(es);assert.equal(canonicalConfigurationOutputValid(packet(),ctx,es),false);
});
for(const language of ['sv','ar','fa','de','es'])test(`source slots depend on host contract, not English or tenant/${language}`,()=>{
 const es=[{id:'host-flag',sourceId:'reminder-settings',chunkId:'settings',businessId:4382,version:'r3',text:'حالت یادآوری: غیرفعال'},
 {id:'doc',sourceId:'handbook',chunkId:'d1',businessId:4382,version:'r5',text:'Documentary facts.'}];
 const p={...proposals[1],subject:'یادآوری',predicate:'وضعیت',value:'غیرفعال',text:'یادآوری غیرفعال است.',language,
 evidenceRefs:[{evidenceId:es[0].id,sourceId:es[0].sourceId,chunkId:es[0].chunkId,version:es[0].version,exactQuote:es[0].text}]};
 const c=captureCanonicalConfigurationProducer(4382,[p],es);
 assert.equal(canonicalConfigurationOutputValid({oversized:false,units:c.units},c,es),true);
 const wrong=structuredClone(c.units);wrong[0].evidenceRefs=[{evidenceId:'doc'}];
 assert.equal(canonicalConfigurationOutputValid({oversized:false,units:wrong},c,es),false);
});

// Isolated SCRIPTED control: a DIFFERENT inventory containing only the two
// backend units and their retained genuine entailment decisions. This is not a
// corrected real capture, not a runtime filter, and not genuine success evidence.
function scriptedBackendOnly(){
 const raw=structuredClone(genuine.verification.raw);raw.decisions=raw.decisions.slice(2);
 raw.sourceCoverage.acceptedUnitIdsReviewed=units.slice(2).map(u=>u.id);
 raw.sourceCoverage.obligations[1].state='UNRESOLVED_REQUIREMENT';return raw;
}
function assess(raw:any){return assessSourceCoverage(raw,facets,units.slice(2),evidence,77,SOURCE_EXHAUSTIVE_V2_PROTOCOL);}
test('SCRIPTED: unavailable descriptive policy and unresolved mandatory notice remain distinct',()=>{
 const raw=scriptedBackendOnly(),r=assess(raw);assert.equal(r.state,'SCOPED_PARTIAL');
 assert.deepEqual(r.unavailable.map(x=>x.state),['REQUESTED_INFORMATION_NOT_VERIFIED','UNRESOLVED_REQUIREMENT']);
 assert.ok(raw.coverage.every((c:any)=>!c.materialFactsComplete&&c.obligations.every((o:any)=>o.status==='UNRESOLVED')));
 assert.equal(raw.coverage[1].obligations[0].unitIds.length,0);
 assert.ok(!units.slice(2).some(u=>/24|deadline/.test(u.text)));
});
for(const [name,change] of Object.entries({
 'original genuine mistyped requirement':(r:any)=>{r.sourceCoverage.obligations[1].state=genuine.verification.raw.sourceCoverage.obligations[1].state;},
 'mistyped description':(r:any)=>{r.sourceCoverage.obligations[0].state='UNRESOLVED_REQUIREMENT';},
 'unlocated':(r:any)=>{r.sourceCoverage.obligations[1].state='UNLOCATED';},
 'invented completeness':(r:any)=>{r.sourceCoverage.obligations[1].state='COMPLETE';},
 'missing material source fact':(r:any)=>{r.sourceCoverage.availableMaterialFactsComplete=false;},
 'omitted source fact state':(r:any)=>{r.sourceCoverage.obligations[0].state='AVAILABLE_SOURCE_FACT_OMITTED';},
 'missing condition':(r:any)=>{r.sourceCoverage.obligations[0].state='MISSING_CONDITION';},
 'contradicted':(r:any)=>{r.decisions[0].relation='CONTRADICTED';},
} as Record<string,(r:any)=>void>))test(`SCRIPTED: independent coverage veto unchanged/${name}`,()=>{
 const raw=scriptedBackendOnly();change(raw);const before=JSON.stringify(raw);assert.equal(assess(raw).state,'DENIED');assert.equal(JSON.stringify(raw),before);
});
test('V2 instructions and schema describe original typed obligation mapping; V1 unchanged',()=>{
 assert.match(SOURCE_EXHAUSTIVE_V2_INSTRUCTION,/description -> REQUESTED_INFORMATION_NOT_VERIFIED; requirement -> UNRESOLVED_REQUIREMENT/);
 assert.match(SOURCE_EXHAUSTIVE_V2_INSTRUCTION,/not by the descriptive modality of proposed facts/);
 const base=knowledgeStructuredOutput('verification',false,['f1','f2'],6,'v2').schema;
 const v2=sourceExhaustiveSchema(base,SOURCE_EXHAUSTIVE_V2_PROTOCOL),v1=sourceExhaustiveSchema(base);
 assert.match(v2.properties.sourceCoverage.properties.obligations.items.properties.state.description,/ORIGINAL obligation.questionType/);
 assert.equal(v1.properties.sourceCoverage.properties.obligations.items.properties.state.description,undefined);
 assert.deepEqual(v2.properties.sourceCoverage.properties.obligations.items.properties.state.enum,v1.properties.sourceCoverage.properties.obligations.items.properties.state.enum);
});
