import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {buildEvidenceFirstAnswer,answerEvidence,InformationBudget,pruneAnswerManifest,type Evidence} from './business-information-answer-plan';
import {configuredServiceEvidence} from './configured-service-evidence';
import {compactKnowledgeVerifierInput} from './knowledge-verifier-input';
import {mixedBusinesses,mixedQuestion} from '../../tests/fixtures/mixed-source-questions';

// Immutable real-provider witness, replayed offline: no provider, model judge or sends.
const raw=readFileSync(new URL('../../docs/validation/shared-core-2026-10-22/authorized-four-case-gate/case-3-final-bounded-2026-10-23T10-06-30-763Z-235a43ce-0336-4911-840c-cd715ec6dfca.json',import.meta.url),'utf8');
assert.equal(createHash('sha256').update(raw).digest('hex'),'e9d976b11b20736ce4b898b715e8b56e71d8afc5d948443cd10529a71522c490');
const capture=JSON.parse(raw),wire=JSON.parse(capture.calls[2].request.input[0].content);
const originalExtraction=JSON.parse(capture.calls[1].outputText),originalVerdict=JSON.parse(capture.calls[2].outputText);
const docs=answerEvidence(88,capture.retrieval.find((x:any)=>x.phase==='lexical').matches);
const catalog=configuredServiceEvidence(88,JSON.parse(wire.evidence.find((e:any)=>e.id==='configured-services').text).services)!;

const witnesses:any[]=[];
after(()=>{if(process.env.ODINLINK_DOCUMENTARY_RESULTS)writeFileSync(process.env.ODINLINK_DOCUMENTARY_RESULTS,JSON.stringify({providerCalls:0,kind:'Offline replay of captured provider judgments; no new inference',witnesses},null,2)+'\n',{flag:'wx'});});
type Options={mutate?:(extraction:any,verdict:any)=>void; evidence?:readonly Evidence[]; currentEvidence?:()=>Promise<readonly Evidence[]>; exact?:boolean; recordedBudget?:boolean};
async function replay(options:Options={}){
 const extraction=structuredClone(originalExtraction),verdict=structuredClone(originalVerdict);
 options.mutate?.(extraction,verdict);
 const evidence=options.evidence||[...docs,catalog],events:any[]=[],stages:string[]=[],budget=new InformationBudget();
 const manifest=await buildEvidenceFirstAnswer({question:wire.question,language:'en',facets:wire.facets,evidence,
  authoritativeEvidence:JSON.stringify(wire.authoritativeEvidence),businessTone:{},history:[],foreground:true,omitModelEvidenceVersions:true,
  budget,current:async()=>true,revalidateEvidence:options.currentEvidence,diagnostic:e=>events.push(e),
  generate:async(stage,_instruction,data:any)=>{
   stages.push(stage);
   if(stage==='extraction')return{text:JSON.stringify(extraction)};
   if(stage==='verification'){
    if(options.exact)assert.deepEqual(compactKnowledgeVerifierInput(data),wire,'Exact original question, units and full authority reach the verifier unchanged');
    if(options.recordedBudget)budget.remaining=()=>6284;
    return{text:JSON.stringify(verdict)};
   }
   assert.equal(stage,'composition');
   return{text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})};
  }});
 if(options.exact)witnesses.push({recordedBudget:!!options.recordedBudget,manifest,events,stages});
 return{manifest,events,stages};
}

test('captured Cedar u1-u5: irrelevant supplement must not erase verified purpose and limits',async()=>{
 const {manifest,events}=await replay({exact:true});
 assert.deepEqual(manifest.units.map(u=>u.id),['u1','u2','u3','u4']);
 assert.deepEqual(manifest.documentaryInventoryIds,['u2','u3','u4'],'Retained documents remain a conservative freshness dependency group');
 assert.match(manifest.text,/Remote Assessment costs 145 EUR and lasts 25 minutes\./);
 for(const u of wire.units.slice(1,4))assert.ok(manifest.text.includes(u.text),`Required exact fact missing: ${u.text}`);
 assert.doesNotMatch(manifest.text,/serial number/);
 assert.match(manifest.text,/cannot confirm whether the document's information applies to Remote Assessment/);
 assert.equal(manifest.outcomes[0].status,'PARTIAL');assert.equal(manifest.outcomes[0].materialFactsComplete,false);
 assert.equal(manifest.outcomes[0].requestAligned,true);
 assert.ok(events.some(e=>e.unitId==='u5'&&e.reason==='NOT_RELEVANT'));
 assert.ok(!events.some(e=>e.reason==='INVALID_COVERAGE'));
 for(const u of manifest.units)for(const ref of u.evidenceRefs){
  const e=[...docs,catalog].find(e=>e.id===ref.evidenceId)!;
  assert.ok(e.text.includes(ref.exactQuote));assert.equal(ref.version,e.version);assert.equal(ref.sourceId,e.sourceId);
 }
});

const unsafe:Record<string,(e:any,v:any)=>void>={
 'unknown sibling':(_e,v)=>{v.decisions[4].relation='UNKNOWN';},
 'contradicted sibling':(_e,v)=>{v.decisions[4].relation='CONTRADICTED';},
 'meaning failure':(_e,v)=>{v.decisions[4].meaningPreserved=false;},
 'lost condition':(_e,v)=>{v.decisions[4].qualifiersPreserved=false;},
 'wrong modality':(_e,v)=>{v.decisions[4].modalityPreserved=false;},
 'wrong language':(_e,v)=>{v.decisions[4].languageCorrect=false;},
 'unsupported absence':(_e,v)=>{v.decisions[4].negativeAbsence=true;v.decisions[4].explicitAbsenceEvidence=false;},
 'duplicate verdict':(_e,v)=>{v.decisions.push({...v.decisions[4]});},
 'missing verdict':(_e,v)=>{v.decisions.pop();},
 'wrong facet':(_e,v)=>{v.decisions[4].facetIds=['f9'];},
 'missing coverage':(_e,v)=>{v.coverage=[];},
 'misaligned coverage':(_e,v)=>{v.coverage[0].requestAligned=false;},
 'invalid coverage':(_e,v)=>{v.coverage[0].obligations[0].unitIds=['u99'];},
 'material rejected restriction':(_e,v)=>{v.coverage[0].materialUnitIds.push('u5');},
 'obligation depends on rejected claim':(_e,v)=>{v.coverage[0].obligations[0].unitIds.push('u5');},
 'missing essential condition':(_e,v)=>{v.coverage[0].incompletenessReason='MISSING_CONDITION';},
 'wrong citation alias':(e)=>{e.units[3].evidenceRefs[0].evidenceId='foreign';},
 'invalid quotation':(e)=>{e.units[3].evidenceRefs[0].exactQuote='Invented source quotation.';},
 'lost recommended premise':(e,v)=>{e.units[3].text='Visitors must bring the device serial number.';v.decisions[4].modalityPreserved=false;},
 'untrusted oversized inventory':e=>{e.oversized=true;},
 'other material condition unknown':(_e,v)=>{v.decisions[2].relation='UNKNOWN';},
};
for(const [name,mutate] of Object.entries(unsafe))test(`unsafe documentary omission still withholds the group: ${name}`,async()=>{
 const {manifest}=await replay({mutate});
 assert.deepEqual(manifest.units.map(u=>u.id),['u1']);
 assert.equal(manifest.outcomes[0].status,'PARTIAL');
 assert.doesNotMatch(manifest.text,/Photo briefings|Safety-critical|Visitors/);
});

test('even complete provider coverage cannot upgrade the supplementary-omission exception to complete',async()=>{
 const {manifest}=await replay({mutate:(_e,v)=>{v.coverage[0].materialFactsComplete=true;v.coverage[0].incompletenessReason='NONE';v.coverage[0].obligations[0].status='COVERED';}});
 assert.equal(manifest.units.length,4);assert.equal(manifest.outcomes[0].status,'PARTIAL');assert.equal(manifest.outcomes[0].materialFactsComplete,false);
});

for(const mode of ['revoke-doc','doc-revision','catalog-revision','catalog-revoke']as const)test(`post-verification ${mode} preserves source authority`,async()=>{
 const {manifest}=await replay();
 const valid=[...docs,catalog].filter(e=>mode==='revoke-doc'?e.id!==docs[0].id:mode==='catalog-revoke'?e.id!==catalog.id:true).map(e=>
  e.id===(mode==='doc-revision'?docs[0].id:catalog.id)&&mode.endsWith('revision')?{...e,version:'changed'}:e);
 const result=pruneAnswerManifest(manifest,valid);
 if(mode.startsWith('catalog')){assert.doesNotMatch(result.text,/145 EUR|25 minutes/);assert.deepEqual(result.units.map(u=>u.id),['u2','u3','u4']);}
 else {assert.deepEqual(result.units.map(u=>u.id),['u1']);assert.doesNotMatch(result.text,/Photo briefings|Safety-critical/);}
 assert.notEqual(result.outcomes[0].status,'VERIFIED');
 assert.equal(pruneAnswerManifest(result,[...docs,catalog]).text,result.text,'Restoring source cannot resurrect removed claims');
});

for(const b of mixedBusinesses)test(`same supplement semantics under tenant ${b.id}, without service equivalence`,async()=>{
 const statements=b.source.split(/(?<=\.) /u),evidence=answerEvidence(b.id,[{businessId:b.id,sourceId:'guide',text:b.source}]);
 const cat=configuredServiceEvidence(b.id,[b.service])!,question=mixedQuestion(b,'en');
 const {manifest}=await (async()=>{
  const changedWire={...wire,question};
  return{manifest:await buildEvidenceFirstAnswer({question,language:'en',facets:wire.facets.map((f:any)=>({...f,subject:'customer request',attribute:question,obligations:f.obligations.map((o:any)=>({...o,description:question}))})),evidence:[...evidence,cat],authoritativeEvidence:'{}',businessTone:{},history:[],foreground:true,budget:new InformationBudget(),current:async()=>true,
   generate:async(stage,_instruction,data:any)=>{
    if(stage==='extraction')return{text:JSON.stringify({oversized:false,units:statements.map((text,i)=>({...originalExtraction.units[i],subject:i===3?'Visitors':b.subject,scope:b.subject,text,value:text,evidenceRefs:[{evidenceId:'e1',exactQuote:text}]}))})};
    if(stage==='verification'){assert.equal(data.question,changedWire.question);assert.ok(data.evidence.every((e:any)=>e.businessId===b.id));return{text:JSON.stringify(originalVerdict)};}
    return{text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})};
   }})};
 })();
 assert.equal(manifest.units.length,4);for(const text of statements.slice(0,3))assert.ok(manifest.text.includes(text));
 assert.ok(manifest.text.includes(`${b.service.price} ${b.service.currency}`));assert.equal(manifest.outcomes[0].status,'PARTIAL');
 assert.ok(manifest.sourceScopeNotice);assert.ok(manifest.units.every(u=>u.evidenceRefs.every(ref=>ref.sourceId===`configured-services:${b.id}`||ref.sourceId==='guide')));
});

for(const target of ['document','catalog']as const)test(`tenant reassociation at authority revalidation cannot publish foreign ${target} facts`,async()=>{
 const sources=[...docs,catalog],id=target==='document'?docs[0].id:catalog.id;
 const {manifest}=await replay({currentEvidence:async()=>sources.map(e=>e.id===id?{...e,businessId:999}:e)});
 if(target==='document'){assert.doesNotMatch(manifest.text,/Photo briefings|Safety-critical|serial number/);assert.match(manifest.text,/145 EUR/);}
 else assert.doesNotMatch(manifest.text,/145 EUR|25 minutes/);
 assert.notEqual(manifest.outcomes[0].status,'VERIFIED');
});

test('recorded post-verification allowance publishes useful partial facts without another model stage',async()=>{
 const {manifest,stages}=await replay({exact:true,recordedBudget:true});
 assert.equal(manifest.units.length,4);assert.equal(manifest.outcomes[0].status,'PARTIAL');
 assert.deepEqual(stages,['extraction','verification']);
 assert.equal(manifest.fallbackReason,null);
 assert.equal(manifest.presentationFallback,false);assert.equal(manifest.presentationPath,'direct_verified_units');
 for(const u of wire.units.slice(0,4))assert.ok(manifest.text.includes(u.text));
 assert.doesNotMatch(manifest.text,/serial number/);
});
