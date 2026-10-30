import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildEvidenceFirstAnswer,InformationBudget,parseRequestedFacets,answerEvidence,pruneAnswerManifest,publishableKnowledgeManifest,type AnswerManifest,type Evidence} from './business-information-answer-plan';
import {nativeKnowledgeTiming,runAccuracyFirstNative} from './knowledge-timing-policy';
import {configuredServiceEvidence} from './configured-service-evidence';
import {acceptanceQuestions,documentaryQuotes,documentaryStatements} from '../../tests/fixtures/multilingual-knowledge-acceptance';

const pdf=JSON.parse(readFileSync(new URL('../../tests/fixtures/admotion-production-document.json',import.meta.url),'utf8'));
const catalog=configuredServiceEvidence(77,[{name:'Video Consultation',price:300,currency:'SEK',durationMinutes:60,active:true}])!;
type Options={family?:'B'|'C';fail?:'extraction'|'verification';noDocument?:boolean;
 mutateProposal?:(raw:any)=>void;mutateVerdict?:(raw:any)=>void;
 evidence?:(items:Evidence[])=>Evidence[];inspect?:(m:AnswerManifest,e:Evidence[])=>void};
async function exercise(options:Options={}) {
 let failure:unknown;
 const result=await runAccuracyFirstNative(async()=>{
  try {
   const family=options.family||'B',question=acceptanceQuestions[family].en;
   const facets=parseRequestedFacets([{subject:'customer request',attribute:question,questionType:'description'}]).facets;
   const selected=pdf.chunks.find((c:any)=>c.content.includes(documentaryQuotes[family][0]));assert.ok(selected);
   let evidence=answerEvidence(77,[{sourceId:'pdf',businessId:77,text:selected.content,metadata:{documentRevision:'v1',source:'document'}}]);
   if(options.noDocument)evidence=[];if(family==='B')evidence.push(catalog);evidence=options.evidence?.(evidence)||evidence;
   const budget=new InformationBudget(undefined,nativeKnowledgeTiming()),calls:string[]=[];
   const manifest=await buildEvidenceFirstAnswer({question,language:'en',facets,evidence,foreground:true,
    authoritativeEvidence:'{}',businessTone:{},history:[],budget,current:async()=>true,revalidateEvidence:async()=>evidence,languageSafe:()=>true,
    generate:async(stage,_instruction,data:any)=>{
     calls.push(stage);if(options.fail===stage)throw Error('information_deadline');
     if(stage==='extraction'){
      const raw={oversized:false,units:documentaryStatements[family].en.map((text,i)=>({facetIds:['f1'],subject:family==='B'?'Digital information calls':'AdMotion Studio',
       predicate:`document fact ${i}`,value:text,modality:'descriptive',negation:family==='C'||i>=2,scope:'documentary offering only',qualifiers:[],language:'en',text,
       evidenceRefs:[{evidenceId:'e1',exactQuote:documentaryQuotes[family][i]}]}))};options.mutateProposal?.(raw);return{text:JSON.stringify(raw)};
     }
     if(stage==='verification'){
      const raw={decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),
       coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:false,incompletenessReason:'UNRESOLVED',materialUnitIds:data.units.map((u:any)=>u.id),obligations:data.facets[0].obligations.map((o:any,i:number)=>({obligationId:o.id,status:family==='C'&&i===1?'COVERED':'UNRESOLVED',unitIds:family==='C'&&i===0?[]:data.units.map((u:any)=>u.id)}))}]};
      options.mutateVerdict?.(raw);return{text:JSON.stringify(raw)};
     }
     throw Error('No optional model needed');
    }});
   options.inspect?.(manifest,evidence);
   return{manifest,allowed:publishableKnowledgeManifest(manifest,77),calls};
  }catch(error){failure=error;throw error;}
 },async()=>{});
 if(failure)throw failure;assert.ok(result);return result;
}
test('current-run B partial retains catalog and documentary facts, original PARTIAL status and explicit applicability caveat',async()=>{
 const {manifest,allowed}=await exercise();assert.equal(allowed,true);assert.equal(manifest.units.length,5);
 assert.equal(manifest.outcomes[0].status,'PARTIAL');assert.equal(manifest.outcomes[0].materialFactsComplete,false);
 assert.match(manifest.text,/300 SEK.*60 minutes/);assert.match(manifest.text,/cannot confirm whether the document's information applies to Video Consultation/);
 for(const text of documentaryStatements.B.en)assert.ok(manifest.text.includes(text));
});
test('C partial retains supported parking policies without a fabricated fee',async()=>{
 const {manifest,allowed}=await exercise({family:'C'});assert.equal(allowed,true);assert.equal(manifest.outcomes[0].status,'PARTIAL');
 for(const text of documentaryStatements.C.en)assert.ok(manifest.text.includes(text));
 assert.doesNotMatch(manifest.text,/\d+\s*(?:SEK|EUR|USD)|parking is free/iu);assert.match(manifest.text,/cannot verify “Nordpark's parking fee” from the available information/);
});
for(const [name,mutate]of Object.entries({
 unknown:(v:any)=>{v.decisions[1].relation='UNKNOWN';},contradiction:(v:any)=>{v.decisions[1].relation='CONTRADICTED';},
 lostQualifier:(v:any)=>{v.decisions[1].qualifiersPreserved=false;},wrongModality:(v:any)=>{v.decisions[1].modalityPreserved=false;},
 missingVerdict:(v:any)=>{v.decisions.pop();},duplicateVerdict:(v:any)=>{v.decisions.push({...v.decisions[0]});},
 missingCoverage:(v:any)=>{v.coverage=[];},malformedCoverage:(v:any)=>{v.coverage[0].obligations[0].unitIds=['u99'];},
 misaligned:(v:any)=>{v.coverage[0].requestAligned=false;},missingCondition:(v:any)=>{v.coverage[0].incompletenessReason='MISSING_CONDITION';},
 missingRecommendation:(v:any)=>{v.coverage[0].incompletenessReason='MISSING_RECOMMENDATION';},
 unsupportedAbsence:(v:any)=>{v.decisions[1].negativeAbsence=true;},
}))test(`qualified partial fails closed: ${name}`,async()=>{
 assert.equal((await exercise({mutateVerdict:mutate})).allowed,false);
});
for(const [name,mutate]of Object.entries({
 invalidQuote:(p:any)=>{p.units[0].evidenceRefs[0].exactQuote='Not in evidence';},wrongCitation:(p:any)=>{p.units[0].evidenceRefs[0].evidenceId='foreign';},
 missingCitation:(p:any)=>{p.units[0].evidenceRefs=[];},unsupportedNumber:(p:any)=>{p.units[0].text='Digital information calls cost 999 SEK.';},
 unauthorizedBooking:(p:any)=>{p.units[0].text='Your appointment is confirmed.';},oversized:(p:any)=>{p.oversized=true;},
}))test(`invalid proposal cannot gain qualified authority: ${name}`,async()=>assert.equal((await exercise({mutateProposal:mutate})).allowed,false));
for(const stage of ['extraction','verification']as const)test(`${stage} timeout never publishes qualified facts`,async()=>{
 assert.equal((await exercise({fail:stage})).allowed,false);
});
test('missing document without a failed extraction can preserve an independently verified catalog fact',async()=>{
 const result=await exercise({noDocument:true});assert.equal(result.allowed,true);assert.deepEqual(result.calls,['verification']);
 assert.equal(result.manifest.units.length,1);assert.match(result.manifest.text,/cannot confirm whether/);
});
test('new partial permission is not granted outside the current owner, by JSON restoration or by token copying',async()=>{
 const {manifest}=await exercise({inspect:m=>{
  assert.equal(publishableKnowledgeManifest(JSON.parse(JSON.stringify(m)),77),false);
  assert.equal(publishableKnowledgeManifest({...m,text:m.units.map(u=>u.text).join(' ')},77),false,'Removing caveat is unsafe');
  assert.equal(publishableKnowledgeManifest({...m,sourceScopeNotice:undefined},77),false);
  assert.equal(publishableKnowledgeManifest({...m,units:m.units.slice(1)},77),false);
  assert.equal(publishableKnowledgeManifest(m,88),false);
 }});
 assert.equal(publishableKnowledgeManifest(manifest,77),false,'Closed/historical ownership is not current-run verification');
 await runAccuracyFirstNative(async()=>{assert.equal(publishableKnowledgeManifest(manifest,77),false);},async()=>assert.fail());
});
for(const mode of ['document-revoked','catalog-revoked','revision','text','foreign']as const)test(`freshness pruning invalidates partial authority: ${mode}`,async()=>{
 await exercise({inspect:(m,e)=>{
  const changed=mode==='document-revoked'?e.filter(x=>x.id!=='e1'):mode==='catalog-revoked'?e.filter(x=>x.id!=='configured-services'):
   e.map(x=>x.id==='e1'?{...x,...(mode==='revision'?{version:'v2'}:mode==='text'?{text:x.text+' changed'}:{businessId:88})}:x);
  const pruned=pruneAnswerManifest(m,changed);assert.equal(publishableKnowledgeManifest(pruned,77),false);
  assert.equal(publishableKnowledgeManifest(pruneAnswerManifest(pruned,e),77),false,'Restored input cannot restore lost permission');
 }});
});
test('foreign input cannot satisfy tenant-scoped publication',async()=>{
 assert.equal((await exercise({evidence:e=>e.map(x=>({...x,businessId:88}))})).allowed,false);
});
test('independent false-complete coverage cannot invent a service relationship',async()=>{
 const {manifest,allowed}=await exercise({mutateVerdict:v=>{v.coverage[0].materialFactsComplete=true;v.coverage[0].incompletenessReason='NONE';v.coverage[0].obligations[0].status='COVERED';}});
 assert.equal(allowed,true);assert.equal(manifest.outcomes[0].status,'PARTIAL');assert.equal(manifest.outcomes[0].materialFactsComplete,false);
 assert.match(manifest.text,/cannot confirm whether/);
});
