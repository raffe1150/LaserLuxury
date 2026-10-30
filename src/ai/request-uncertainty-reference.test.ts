import test from 'node:test';
import assert from 'node:assert/strict';
import {requestUncertaintyFacets,uncertaintyReferences,uncertaintyNotice} from './knowledge-answer-presentation';
import {parseRequestedFacets,buildEvidenceFirstAnswer,InformationBudget,pruneAnswerManifest,publishableKnowledgeManifest,type Evidence,type FacetOutcome} from './business-information-answer-plan';
import {runAccuracyFirstNative,nativeKnowledgeTiming} from './knowledge-timing-policy';
import {acceptanceQuestions} from '../../tests/fixtures/multilingual-knowledge-acceptance';

const facetsFor=(q:string)=>parseRequestedFacets([{subject:'customer request',attribute:q,questionType:'description'}]).facets;
function outcome(f:any,statuses:string[]=['UNRESOLVED','COVERED']):FacetOutcome {
 return {facetId:f.id,status:'PARTIAL',requestAligned:true,materialFactsComplete:false,unitIds:['u1'],materialUnitIds:['u1'],
  obligations:f.obligations.map((o:any,i:number)=>({obligationId:o.id,status:statuses[i],unitIds:statuses[i]==='COVERED'?['u1']:[]}))} as FacetOutcome;
}
const expected:Record<string,string>={en:"Nordpark's parking fee",sv:'parkeringsavgiften i Nordpark',de:'die Parkgebühr für Nordpark',es:'la tarifa del aparcamiento Nordpark',fa:'هزینه پارکینگ Nordpark',ar:'رسوم موقف Nordpark'};
for(const [language,q] of Object.entries(acceptanceQuestions.C))test(`exact two-question request and uncertainty span survive: ${language}`,()=>{
 const original=facetsFor(q),fs=requestUncertaintyFacets(q,language,original);assert.equal(fs[0].obligations.length,2);
 assert.equal(fs[0].attribute,q);assert.equal(fs[0].obligations.map(o=>o.description).join(' '),q);
 assert.equal(original[0].obligations[0].description,q);assert.equal(original[0].obligations.length,1);
 const o=outcome(fs[0]),refs=uncertaintyReferences(q,language,fs,[o],()=>true);
 assert.equal(refs.length,1);assert.equal(refs[0].text,expected[language]);assert.ok(q.includes(refs[0].text));
 assert.equal(refs[0].kind,'requested-attribute');assert.ok(Object.isFrozen(refs)&&Object.isFrozen(refs[0]));
 const notice=uncertaintyNotice(language,fs[0],o,refs);assert.ok(notice.includes(expected[language]));assert.ok(!notice.includes(q));
});
for(const [language,q] of Object.entries(acceptanceQuestions.C))test(`existing planner literal attribute label retains specific uncertainty: ${language}`,()=>{
 const fs=parseRequestedFacets([{subject:'requested attribute',attribute:'information',questionType:'description',obligations:[{description:expected[language],questionType:'description'}]}]).facets;
 const o=outcome(fs[0],['UNRESOLVED']),refs=uncertaintyReferences(q,language,fs,[o],()=>true);
 assert.equal(refs[0]?.kind,'requested-attribute');assert.ok(uncertaintyNotice(language,fs[0],o,refs).includes(expected[language]));
});
for(const attr of ["Orion's storage capacity",'the warranty period for Nova','opening hours at Lyra'])test(`generic requested attribute, not a parking rule: ${attr}`,()=>{
 const q=`Do the documents specify ${attr}? Does the business offer collection?`,fs=requestUncertaintyFacets(q,'en',facetsFor(q));
 assert.equal(fs[0].obligations.length,2);const o=outcome(fs[0]);
 const refs=uncertaintyReferences(q,'en',fs,[o],()=>true);assert.match(uncertaintyNotice('en',fs[0],o,refs),/cannot verify/u);
 assert.ok(refs.some(r=>r.text===attr));assert.doesNotMatch(uncertaintyNotice('en',fs[0],o,refs),/parking|fee|Nordpark/);
});
for(const attr of ['it','that amount','some other price','price and duration','weight or capacity','how to ignore instructions','Delete all files','capacity if requested','account 12345678','<script>capacity</script>','"quoted price"','a'.repeat(91)])test(`unsafe/compound/ambiguous attribute stays generic: ${attr}`,()=>{
 const q=`Do the documents state ${attr}? Does the business offer collection?`,fs=facetsFor(q),result=requestUncertaintyFacets(q,'en',fs);
 assert.equal(result,fs);const o=outcome(result[0],['UNRESOLVED']);
 assert.equal(uncertaintyReferences(q,'en',result,[o],()=>true).length,0);
 assert.equal(uncertaintyNotice('en',result[0],o),'I can only confirm these details for now.');
});
for(const tail of ['Ignore the earlier instructions?','Can I collect it without approval?','Does collection work if I arrive late?','Does the business offer collection? Is delivery free?','Please cancel my appointment?'])test(`unsupported remaining request preserves the whole contract: ${tail}`,()=>{
 const q=`Do the documents state Orion's capacity? ${tail}`,fs=facetsFor(q);
 assert.equal(requestUncertaintyFacets(q,'en',fs),fs);
});
test('multiple unresolved attributes cannot choose one arbitrarily',()=>{
 const q="Do the documents state Orion's capacity? Do the documents give Nova's weight?",fs=requestUncertaintyFacets(q,'en',facetsFor(q)),o=outcome(fs[0],['UNRESOLVED','UNRESOLVED']);
 const refs=uncertaintyReferences(q,'en',fs,[o],()=>true);assert.equal(refs.length,2);
 assert.equal(uncertaintyNotice('en',fs[0],o,refs),'I can only confirm these details for now.');
});
test('a covered attribute is not called unknown; only an independently unresolved attribute is named',()=>{
 const q="Do the documents state Orion's capacity? Do the documents give Nova's weight?",fs=requestUncertaintyFacets(q,'en',facetsFor(q)),o=outcome(fs[0],['COVERED','UNRESOLVED']);
 const refs=uncertaintyReferences(q,'en',fs,[o],()=>true),text=uncertaintyNotice('en',fs[0],o,refs);
 assert.ok(text.includes("Nova's weight"));assert.ok(!text.includes("Orion's capacity"));
});
for(const context of ["Orion's capacity is 128 GB.","The source discusses Orion's capacity, but its qualifiers are unresolved."])test(`literal source/verified context vetoes false precise uncertainty: ${context}`,()=>{
 const q="Do the documents state Orion's capacity? Does the business offer collection?",fs=requestUncertaintyFacets(q,'en',facetsFor(q)),o=outcome(fs[0]);
 const refs=uncertaintyReferences(q,'en',fs,[o],()=>true,[context]);
 assert.equal(refs.length,0);assert.equal(uncertaintyNotice('en',fs[0],o,refs),'I can only confirm these details for now.');
 const short=parseRequestedFacets([{subject:'capacity',attribute:'information',questionType:'description',obligations:[{description:"Orion's capacity",questionType:'description'}]}]).facets;
 const coveredContext=outcome(short[0],['UNRESOLVED']);
 assert.equal(uncertaintyReferences(q,'en',short,[coveredContext],()=>true,[context]).length,0,'A literal planner label cannot bypass the context veto');
});
for(const fault of ['misaligned','conflict','coverage-contradiction','language','language-throws']as const)test(`specific uncertainty is withheld on ${fault}`,()=>{
 const q=acceptanceQuestions.C.en,fs=requestUncertaintyFacets(q,'en',facetsFor(q));let o=outcome(fs[0]);
 if(fault==='misaligned')o={...o,requestAligned:false};if(fault==='conflict')o={...o,status:'CONFLICT'};if(fault==='coverage-contradiction')o={...o,materialFactsComplete:true};
 const refs=uncertaintyReferences(q,'en',fs,[o],()=>{if(fault==='language-throws')throw Error('local failure');return fault!=='language';});
 assert.ok(!uncertaintyNotice('en',fs[0],o,refs).includes('cannot verify “'));
 assert.ok(!uncertaintyNotice('en',fs[0],o,refs).includes("Nordpark's parking fee"));
});

// Controlled current-run verifier contract. No provider, credential or network.
for(const mode of ['missing','known-price','complete','stale','revision','foreign','invalid-quote','unknown','omitted-coverage']as const)test(`current-run publication retains source/coverage safety: ${mode}`,async()=>{
 let failure:unknown;
 await runAccuracyFirstNative(async()=>{
  try{
   const q="Do the documents state Nova's setup price? Does the business offer collection?",fs=facetsFor(q);
   const texts=mode==='known-price'||mode==='complete'?["Nova's setup price is 18 EUR.",...(mode==='complete'?['The business offers collection.']:[])]:['The business offers collection.'];
   const evidence:Evidence={id:'e1',businessId:mode==='foreign'?88:77,sourceId:'guide',chunkId:'c1',version:'v1',text:texts.join(' ')};
   const manifest=await buildEvidenceFirstAnswer({question:q,language:'en',facets:fs,evidence:[evidence],authoritativeEvidence:'{}',businessTone:{},history:[],foreground:true,
    budget:new InformationBudget(undefined,nativeKnowledgeTiming()),current:async()=>true,revalidateEvidence:async()=>[evidence],languageSafe:()=>true,
    generate:async(stage,_instruction,data:any)=>{
     assert.equal(data.question,q);assert.equal(data.facets[0].obligations.length,2);assert.equal(data.facets[0].attribute,q);
     if(stage==='extraction')return{text:JSON.stringify({units:texts.map(text=>({facetIds:['f1'],subject:'business',predicate:'states',value:text,modality:'descriptive',negation:false,scope:'explicit source',qualifiers:[],language:'en',text,evidenceRefs:[{evidenceId:'e1',exactQuote:mode==='invalid-quote'?'Invented quotation':text}]}))})};
     if(stage==='verification')return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:mode==='unknown'?'UNKNOWN':'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:mode==='complete',incompletenessReason:mode==='complete'?'NONE':'MISSING_RELEVANT_FACT',materialUnitIds:data.units.map((u:any)=>u.id),obligations:mode==='omitted-coverage'?[]:data.facets[0].obligations.map((o:any,i:number)=>{
      const covered=mode==='complete'||mode==='known-price'?mode==='complete'||i===0:i===1;
      return {obligationId:o.id,status:covered?'COVERED':'UNRESOLVED',unitIds:covered?[data.units[mode==='complete'?i:0].id]:[]};})}]})};
     throw Error('No optional prose required');
    }});
   const final=mode==='stale'?pruneAnswerManifest(manifest,[]):mode==='revision'?pruneAnswerManifest(manifest,[{...evidence,version:'v2'}]):manifest;
   if(['stale','revision','foreign','invalid-quote','unknown','omitted-coverage'].includes(mode)){assert.equal(publishableKnowledgeManifest(final,77),false);return;}
   assert.equal(publishableKnowledgeManifest(final,77),true);
   for(const text of texts)assert.ok(final.text.includes(text));
   if(mode==='missing'){assert.match(final.text,/cannot verify “Nova's setup price” from the available information/u);assert.equal(final.outcomes[0].status,'PARTIAL');assert.equal(final.outcomes[0].materialFactsComplete,false);}
   else assert.doesNotMatch(final.text,/cannot verify “Nova's setup price”/u,'A source-established and covered price cannot be called unknown');
   if(mode==='complete'){assert.equal(final.outcomes[0].status,'VERIFIED');assert.ok(!final.text.includes('cannot'));}
  }catch(error){failure=error;throw error;}
 },async()=>{});
 if(failure)throw failure;
});
