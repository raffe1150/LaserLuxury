import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';
import{buildEvidenceFirstAnswer,answerEvidence,parseRequestedFacets,InformationBudget,pruneAnswerManifest}from'./business-information-answer-plan';
import{wholeQuestionInformationPlan}from'./knowledge-planning';
import{acceptanceQuestions,documentaryQuotes,documentaryStatements}from'../../tests/fixtures/multilingual-knowledge-acceptance';
const saved=JSON.parse(readFileSync('docs/validation/shared-core-2026-10-22/aen-single-provider-20261024/A-en.result.json','utf8'));
const matches=saved.retrieval.find((e:any)=>e.phase==='freshness').matches;
const sources=answerEvidence(77,matches),question=acceptanceQuestions.A.en,facets=parseRequestedFacets(wholeQuestionInformationPlan(question,true)!.requestedFacets).facets;
const texts=documentaryStatements.A.en,quotes=documentaryQuotes.A;
const units=texts.map((text,i)=>{const e=sources.find(e=>e.text.includes(quotes[i]))!;const quote:string=quotes[i];assert.ok(e.text.includes(quote));return{facetIds:['f1'],subject:'Visitors',predicate:`visitor condition ${i}`,value:text,scope:'the documented visit conditions',modality:['required','recommended','permitted','prohibited','permitted'][i],negation:i===3,qualifiers:[],language:'en',text,evidenceRefs:[{evidenceId:e.id,exactQuote:quote}]};});
type Mode='complete'|'lost-condition'|'wrong-modality'|'invented-drinking-permission'|'omitted-room-ban'|'omitted-snack-exception'|'invalid-citation'|'invalid-quote'|'missing-preparation-source'|'missing-coverage'|'unrelated-evidence'|'foreign-evidence';
async function run(mode:Mode){
 let ev=sources,proposal=structuredClone(units);const rejected=new Set<string>();
 if(mode==='lost-condition'){proposal[0].text=proposal[0].value='You must follow preparation instructions even if none were received.';rejected.add(proposal[0].text);}
 if(mode==='wrong-modality'){proposal[1].text=proposal[1].value='You must never wear perfume.';proposal[1].modality='prohibited';rejected.add(proposal[1].text);}
 if(mode==='invented-drinking-permission'){proposal[2].text=proposal[2].value='You may drink water in treatment rooms.';rejected.add(proposal[2].text);}
 if(mode==='omitted-room-ban')proposal.splice(3,1);
 if(mode==='omitted-snack-exception')proposal.splice(4,1);
 if(mode==='invalid-citation')proposal[0].evidenceRefs[0].evidenceId='nonexistent-source';
 if(mode==='invalid-quote')proposal[0].evidenceRefs[0].exactQuote='You must prepare unconditionally.';
 if(mode==='missing-preparation-source'){const id=proposal[0].evidenceRefs[0].evidenceId;ev=ev.filter(e=>e.id!==id);proposal=proposal.slice(1);}
 if(mode==='unrelated-evidence'){ev=answerEvidence(77,[{businessId:77,sourceId:'unrelated',text:'A blue chair is in the lobby.',metadata:{documentRevision:'v1'}}]);proposal=[];}
 if(mode==='foreign-evidence'){ev=answerEvidence(77,matches.map((m:any)=>({...m,businessId:88})));proposal=[];assert.equal(ev.length,0);}
 const payloads:any[]=[];
 const manifest=await buildEvidenceFirstAnswer({question,language:'en',facets,evidence:ev,authoritativeEvidence:'',businessTone:{},history:[],budget:new InformationBudget(),foreground:true,current:async()=>true,
 generate:async(stage,_instruction,data:any)=>{
  payloads.push({stage,data});assert.equal(data.question,question);assert.equal(data.facets[0].obligations[0].description,question);assert.ok(data.evidence.every((e:any)=>e.businessId===77));
  if(stage==='extraction')return{text:JSON.stringify({units:proposal})};
  if(stage==='verification'){
   for(const u of data.units)for(const ref of u.evidenceRefs){const e=data.evidence.find((e:any)=>e.id===ref.evidenceId);assert.ok(e?.text.includes(ref.exactQuote));}
   const accepted=data.units.filter((u:any)=>!rejected.has(u.text)).map((u:any)=>u.id),complete=mode==='complete';
   return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:rejected.has(u.text)?'UNKNOWN':'ENTAILED',meaningPreserved:!rejected.has(u.text),modalityPreserved:!rejected.has(u.text),qualifiersPreserved:!rejected.has(u.text),relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:mode==='missing-coverage'?[]:[{facetId:'f1',requestAligned:true,materialFactsComplete:complete,incompletenessReason:complete?'NONE':mode==='lost-condition'?'MISSING_CONDITION':'MISSING_RELEVANT_FACT',materialUnitIds:accepted,obligations:[{obligationId:'f1.o1',status:complete?'COVERED':'UNRESOLVED',unitIds:accepted}]}]})};
  }
  return{text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})};
 }});
 return{manifest,payloads};
}
test('complete five-proposition checklist remains independently verified and source bound',async()=>{
 const{manifest,payloads}=await run('complete');assert.equal(manifest.outcomes[0].status,'VERIFIED');assert.equal(manifest.units.length,5);assert.deepEqual(payloads.map(p=>p.stage),['extraction','verification']);
 for(const text of texts)assert.ok(manifest.text.includes(text));
 for(const u of manifest.units)for(const ref of u.evidenceRefs){const e=sources.find(e=>e.id===ref.evidenceId)!;assert.equal(e.sourceId,ref.sourceId);assert.equal(e.version,ref.version);assert.ok(e.text.includes(ref.exactQuote));}
});
for(const mode of ['lost-condition','wrong-modality','invented-drinking-permission','omitted-room-ban','omitted-snack-exception','invalid-citation','invalid-quote','missing-preparation-source','missing-coverage','unrelated-evidence','foreign-evidence']as const)test(`direct admission grants no completeness or support: ${mode}`,async()=>{
 const{manifest}=await run(mode);assert.notEqual(manifest.outcomes[0].status,'VERIFIED');assert.equal(manifest.outcomes[0].materialFactsComplete,false);
 if(['lost-condition','invalid-citation','invalid-quote','missing-preparation-source'].includes(mode))assert.ok(!manifest.text.includes(texts[0]));
 assert.doesNotMatch(manifest.text,/even if none|must never wear|drink water in treatment rooms/);
 if(mode==='omitted-room-ban')assert.ok(!manifest.text.includes(texts[3]));if(mode==='omitted-snack-exception')assert.ok(!manifest.text.includes(texts[4]));
 if(mode==='unrelated-evidence'||mode==='foreign-evidence')assert.equal(manifest.units.length,0);
});
for(const mode of ['changed','revoked']as const)test(`final ${mode} evidence cannot publish a stale checklist`,async()=>{const{manifest}=await run('complete');const current=mode==='revoked'?[]:sources.map(e=>({...e,version:'new-revision'}));const pruned=pruneAnswerManifest(manifest,current);assert.equal(pruned.units.length,0);assert.notEqual(pruned.outcomes[0].status,'VERIFIED');});
