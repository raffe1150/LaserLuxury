/** Parse-loss safety controls using preserved synthetic real-provider captures.
 * Injected judgments below are scripted; no provider or credential is accessed. */
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {buildEvidenceFirstAnswer,InformationBudget,parseRequestedFacets,answerEvidence,publishableKnowledgeManifest,completeKnowledgeManifest} from './business-information-answer-plan';
import {runAccuracyFirstNative,nativeKnowledgeTiming} from './knowledge-timing-policy';
import {configuredServiceEvidence} from './configured-service-evidence';
const root='docs/validation/shared-core-2026-10-22';
type Family='A'|'A-en'|'B'|'C';
const source=(family:Family)=>{
 const file=family==='A'?'asv-direct-acceptance-20261025/A-sv.result.json':family==='A-en'?'aen-accuracy-first-acceptance-20261025/A-en.result.json':family==='B'?'ben-direct-acceptance-20261025/B-en.result.json':'cen-direct-acceptance-20261025/C-en.result.json';
 const saved=JSON.parse(readFileSync(`${root}/${file}`,'utf8')),calls=saved.state.calls;
 const ex=calls.find((c:any)=>c.stage==='extraction'),vc=calls.find((c:any)=>c.stage==='verification');
 const raw=JSON.parse(ex.outputText),vi=JSON.parse(vc.request.input[0].content),verdict=JSON.parse(vc.outputText),context=JSON.parse(ex.request.input[0].content);
 const fresh=saved.retrieval.filter((r:any)=>r.phase==='freshness').at(-1).matches;
 const matches=vi.evidence.filter((e:any)=>e.id!=='configured-services').map((e:any)=>{const m=fresh.find((m:any)=>m.text.trim()===e.text.trim());assert.ok(m);return {...m,text:e.text};});
 const catalogRow=vi.evidence.find((e:any)=>e.id==='configured-services');
 const catalog=catalogRow?configuredServiceEvidence(77,JSON.parse(catalogRow.text).services):null;
 if(catalogRow)assert.equal(catalog?.text,catalogRow.text);
 return{raw,vi,verdict,context,matches,catalog};
};
type Fault='none'|'quote'|'alias'|'missing-quote'|'malformed-quote'|'missing-citation'|'language'|'facet'|'foreign'|'mixed-foreign'|'revoked-before-verification'|'revision-before-verification'|'partial-parse-loss'|'legacy';
async function exercise(family:Family,fault:Fault='none'){
 const f=source(family);let result:any,problem:unknown;
 const work=async()=>{try{
  const raw=structuredClone(f.raw);let matches=f.matches;
  if(['quote','partial-parse-loss','legacy'].includes(fault))raw.units[0].evidenceRefs[0].exactQuote='Quotation not present in the source.';
  if(fault==='alias')raw.units[0].evidenceRefs[0].evidenceId=family==='A'?'e4':'e2';
  if(fault==='missing-quote')delete raw.units[0].evidenceRefs[0].exactQuote;
  if(fault==='malformed-quote')raw.units[0].evidenceRefs[0].exactQuote={invalid:true};
  if(fault==='missing-citation')raw.units[0].evidenceRefs=[];
  if(fault==='language')raw.units[0].language='unsupported';
  if(fault==='facet')raw.units[0].facetIds=['f99'];
  if(fault==='foreign')matches=matches.map((m:any)=>({...m,businessId:88}));
  if(fault==='mixed-foreign')matches=matches.map((m:any,i:number)=>i===1?{...m,businessId:88}:m);
  const evidence=[...answerEvidence(77,matches),...(f.catalog?[f.catalog]:[])],stages:string[]=[],events:any[]=[];let checks=0;
  const lost=family==='A'?'e2':'e1';
  const manifest=await buildEvidenceFirstAnswer({question:f.vi.question,language:f.vi.requestedLanguage,facets:parseRequestedFacets(f.vi.facets).facets,evidence,foreground:true,omitModelEvidenceVersions:true,
   authoritativeEvidence:f.vi.authoritativeEvidence,businessTone:f.context.businessTone,history:f.context.relevantHistory,budget:new InformationBudget(undefined,nativeKnowledgeTiming()),current:async()=>true,
   languageSafe:u=>u.language===f.vi.requestedLanguage,
   diagnostic:e=>events.push(e),revalidateEvidence:async()=>{
    checks++;
    if(checks>=2&&fault==='revoked-before-verification')return evidence.filter(e=>e.id!==lost);
    if(checks>=2&&fault==='revision-before-verification')return evidence.map(e=>e.id===lost?{...e,version:e.version+'-changed'}:e);
    return evidence;
   },generate:async(stage,_instruction,data:any)=>{
    stages.push(stage);assert.equal(data.question,stage==='extraction'&&family==='B'?f.context.question:f.vi.question);assert.ok(data.evidence.every((e:any)=>e.businessId===77));
    if(stage==='extraction')return{text:JSON.stringify(raw)};
    assert.equal(stage,'verification','No extra verifier/composition permitted');
    for(const u of data.units)for(const ref of u.evidenceRefs)assert.ok(data.evidence.find((e:any)=>e.id===ref.evidenceId)?.text.includes(ref.exactQuote));
    if(fault==='none')return{text:JSON.stringify(f.verdict)};
    const ids=data.units.map((u:any)=>u.id),partial=fault==='partial-parse-loss';
    // Deliberately false COMPLETE over survivors; mandatory guard must subtract.
    return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:data.facets.map((fa:any)=>({facetId:fa.id,requestAligned:true,materialFactsComplete:!partial,incompletenessReason:partial?'UNRESOLVED':'NONE',materialUnitIds:ids,obligations:fa.obligations.map((o:any)=>({obligationId:o.id,status:partial?'UNRESOLVED':'COVERED',unitIds:ids}))}))})};
   }});
  result={manifest,stages,events,allowed:publishableKnowledgeManifest(manifest,77),complete:completeKnowledgeManifest(manifest)};
 }catch(e){problem=e;throw e;}};
 if(fault==='legacy')await work();else await runAccuracyFirstNative(work,async()=>{});
 if(problem)throw problem;assert.ok(result);return result;
}
for(const fault of ['quote','alias','missing-quote','malformed-quote','missing-citation','language','facet','foreign','mixed-foreign','revoked-before-verification','revision-before-verification']as const)test(`Knowledge parse/source loss cannot produce COMPLETE: ${fault}`,async()=>{
 const x=await exercise('A',fault);assert.equal(x.complete,false);assert.equal(x.allowed,false);assert.equal(x.manifest.qualifiedPartial,undefined);
 if(!['foreign','mixed-foreign'].includes(fault)){assert.ok(!x.manifest.units.some((u:any)=>u.id==='u1'),'Rejected preparation fact must not be published');assert.ok(x.manifest.units.every((u:any)=>u.verification==='ENTAILED'));}
 assert.ok(x.stages.filter(s=>s==='verification').length<=1);
});
test('existing real A-sv MISSING_CONDITION verdict stays five ENTAILED / unresolved / unpublished',async()=>{const x=await exercise('A');assert.equal(x.manifest.units.length,5);assert.ok(x.manifest.units.every((u:any)=>u.verification==='ENTAILED'));assert.equal(x.manifest.outcomes[0].materialFactsComplete,false);assert.equal(x.manifest.outcomes[0].obligations[0].status,'UNRESOLVED');assert.equal(x.allowed,false);assert.equal(x.complete,false);assert.ok(x.events.some((e:any)=>e.incompletenessReason==='MISSING_CONDITION'));});
test('accepted real C-en qualified PARTIAL remains current-run publishable with exact missing-fee caveat',async()=>{const x=await exercise('C');assert.equal(x.allowed,true);assert.equal(x.complete,false);assert.equal(x.manifest.outcomes[0].status,'PARTIAL');assert.match(x.manifest.text,/cannot verify “Nordpark's parking fee”/);});
test('descriptive C-en parse loss cannot acquire qualified-PARTIAL authority',async()=>{const x=await exercise('C','partial-parse-loss');assert.equal(x.allowed,false);assert.equal(x.complete,false);assert.equal(x.manifest.qualifiedPartial,undefined);});
test('legacy parse loss also subtracts completeness; no verifier decision becomes an entailment',async()=>{const x=await exercise('A','legacy');assert.equal(x.complete,false);assert.equal(x.allowed,false);assert.equal(x.manifest.outcomes[0].materialFactsComplete,false);assert.ok(x.manifest.units.every((u:any)=>u.verification==='ENTAILED'));});
test('accepted real A-en outputs still replay as complete and publishable',async()=>{const x=await exercise('A-en');assert.equal(x.complete,true);assert.equal(x.allowed,true);assert.equal(x.manifest.units.length,5);});
test('accepted real B-en outputs retain catalog authority and qualified applicability PARTIAL',async()=>{const x=await exercise('B');assert.equal(x.complete,false);assert.equal(x.allowed,true);assert.equal(x.manifest.units.length,6);assert.match(x.manifest.text,/300 SEK.*60 minutes/);assert.match(x.manifest.text,/cannot confirm whether the document's information applies to Video Consultation/);});
test('catalog parse-loss behavior stays conservative while retaining its independently verified proposal',async()=>{const x=await exercise('B','quote');assert.equal(x.complete,false);assert.equal(x.allowed,false);assert.equal(x.manifest.qualifiedPartial,undefined);assert.ok(x.manifest.units.some((u:any)=>u.text.includes('300 SEK')&&u.evidenceRefs.every((r:any)=>r.evidenceId==='configured-services')));});
