import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerEvidence, buildEvidenceFirstAnswer, InformationBudget, parseRequestedFacets, parseAnswerUnits } from './business-information-answer-plan';
import { knowledgeStructuredOutput, type KnowledgeDecision } from './knowledge-answer-protocol';

const question='Do you supply equipment, and can you arrange delivery?';
const facets=parseRequestedFacets([{subject:'business',attribute:'equipment and delivery',questionType:'description',
  obligations:[{description:question,questionType:'description'}]}]).facets;
const sentences=['The business supplies equipment.', 'The business cannot arrange delivery.', 'Collection is at the rear entrance.'];
const evidence=answerEvidence(77,[{businessId:77,sourceId:'fixture',text:sentences.join('\n'),metadata:{documentRevision:'v1'}}]);
const proposal=(text:string,language='en',facetIds=['f1'])=>({facetIds,subject:'business',predicate:'offering',value:text,
  modality:'descriptive',negation:text===sentences[1],scope:'this business',qualifiers:[],language,text,
  evidenceRefs:[{evidenceId:'e1',exactQuote:text}]});
const refs=(schema:any)=>schema.properties.units.items.properties.facetIds;

test('request-local schema binds only supplied facet IDs, including natural proposals, without changing other schemas',()=>{
  const legacy=JSON.stringify(knowledgeStructuredOutput('extraction'));
  for(const natural of [false,true]) {
    const first=knowledgeStructuredOutput('extraction',natural,['f1']);
    const second=knowledgeStructuredOutput('extraction',natural,['f2','f4']);
    assert.deepEqual(refs(first.schema),{type:'array',items:{type:'string',enum:['f1']},minItems:1,maxItems:4});
    assert.deepEqual(refs(second.schema).items.enum,['f2','f4']);
    assert.deepEqual(refs(first.schema).items.enum,['f1'],'concurrent tenants cannot mutate another request schema');
  }
  assert.equal(JSON.stringify(knowledgeStructuredOutput('extraction')),legacy);
  assert.deepEqual(knowledgeStructuredOutput('verification',false,['f1']),knowledgeStructuredOutput('verification'));
  for(const ids of [[],['f1','f1'],[''],['f1','f2','f3','f4','f5']])assert.throws(()=>knowledgeStructuredOutput('extraction',false,ids));
});

test('three invalid facet references reproduce NO_PARSED_UNITS; no reference repair or verifier invocation',async()=>{
  const events:KnowledgeDecision[]=[],calls:string[]=[];
  const invalid=sentences.map((s,i)=>proposal(s,'en',[`f${i+2}`]));
  const manifest=await buildEvidenceFirstAnswer({question,language:'en',facets,evidence,foreground:true,
    authoritativeEvidence:'',businessTone:{},history:[],budget:new InformationBudget(),current:async()=>true,
    diagnostic:e=>events.push(e),generate:async(stage)=>{calls.push(stage);assert.equal(stage,'extraction');return{text:JSON.stringify({units:invalid})};}});
  assert.deepEqual(calls,['extraction']);assert.equal(manifest.fallbackReason,'NO_PARSED_UNITS');
  assert.equal(events.filter(e=>e.reason==='INVALID_FACET').length,3);assert.equal(manifest.units.length,0);
  for(const ids of [[],['unknown'],['f1','f2']])assert.equal(parseAnswerUnits({units:[proposal(sentences[0],'en',ids)]},facets,evidence,'en').units.length,0);
});

for(const language of ['en','sv','de','es','fa','ar'])for(const outcome of ['complete','partial','timeout']as const)
test(`${language}/${outcome}: shared facet reuse never establishes entailment or complete-question coverage`,async()=>{
  const events:KnowledgeDecision[]=[],calls:string[]=[];
  const manifest=await buildEvidenceFirstAnswer({question,language,facets,evidence,foreground:true,omitModelEvidenceVersions:true,
    authoritativeEvidence:'unchanged veto context',businessTone:{},history:[],budget:new InformationBudget(),current:async()=>true,
    diagnostic:e=>events.push(e),generate:async(stage,instruction,data:any)=>{
      calls.push(stage);
      if(stage==='extraction') {
        assert.deepEqual(data.allowedFacetIds,['f1']);assert.deepEqual(data.facets,facets);assert.equal(data.question,question);
        // Facet binding is asserted by the request-local schema and payload,
        // not an arbitrary sentence in the extraction prompt. Retain the same
        // complete/partial/timeout verdicts and publication expectations below.
        return{text:JSON.stringify({units:sentences.slice(0,2).map(s=>proposal(s,language))})};
      }
      if(stage==='verification') {
        assert.equal(data.authoritativeEvidence,'unchanged veto context');assert.equal(data.evidence[0].text,evidence[0].text);
        assert.deepEqual(data.units.map((u:any)=>u.facetIds),[['f1'],['f1']]);assert.deepEqual(data.facets,facets);
        if(outcome==='timeout')throw Object.assign(new Error('synthetic timeout'),{category:'TIMEOUT'});
        const ids=data.units.map((u:any)=>u.id);
        return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:'ENTAILED',
          meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,
          explicitAbsenceEvidence:true,negativeAbsence:u.negation})),coverage:[{facetId:'f1',requestAligned:true,
          materialFactsComplete:outcome==='complete',incompletenessReason:outcome==='complete'?'NONE':'UNRESOLVED',materialUnitIds:ids,
          obligations:[{obligationId:'f1.o1',status:outcome==='complete'?'COVERED':'UNRESOLVED',unitIds:outcome==='complete'?ids:[]}]}]})};
      }
      return{text:JSON.stringify({unitIds:['u1','u2'],prefix:'none',addition:false})};
    }});
  assert.ok(calls.includes('verification'));
  if(outcome==='timeout') {
    assert.equal(manifest.fallbackReason,'DEADLINE');assert.equal(manifest.units.length,0);assert.ok(!calls.includes('composition'));
  } else {
    assert.equal(manifest.units.length,2);assert.equal(manifest.outcomes[0].status,outcome==='complete'?'VERIFIED':'PARTIAL');
    if(outcome==='partial')assert.ok(events.some(e=>e.reason==='MATERIAL_FACTS_MISSING'&&e.incompletenessReason==='UNRESOLVED'));
  }
});

// Inference judgments and language labels above are deliberate fixtures. They
// validate contracts/gates in six language modes, not model translation quality.
