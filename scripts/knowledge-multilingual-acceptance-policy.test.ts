import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {preliminaryAcceptancePlan,laterExpansionPlan,acceptanceFamilies,acceptanceLanguages,documentaryQuotes,documentaryStatements,obligations} from '../tests/fixtures/multilingual-knowledge-acceptance';
import {budgetPolicy,requestFits,validateLedger,admitRequest,safeDiagnostic,classifyNetwork,assertCaseAuthorization,claimCase,latchFailure,planSha256,sha256,captureRequirements,claimProviderLock} from './knowledge-multilingual-acceptance-policy';
import {answerEvidence,buildEvidenceFirstAnswer,InformationBudget,parseRequestedFacets} from '../src/ai/business-information-answer-plan';
const historical=JSON.parse(readFileSync('docs/validation/shared-core-2026-10-22/source-aware-usage.json','utf8'));
const raw=JSON.parse(readFileSync('tests/fixtures/admotion-production-document.json','utf8'));
const binding={planSha256,candidateSha256:'a'.repeat(64),sourceSnapshotSha256:'b'.repeat(64)};
const auth=(caseId='A-en')=>({providerExecutionAuthorized:true,scope:'one-preliminary-case-only',caseId,...binding,localCapUsd:1,automaticRetry:false});

test('new cap preserves all historical accounting and grants zero execution permission',()=>{
 const policy=budgetPolicy();assert.equal(policy.localCapUsd,1);assert.equal(policy.providerExecutionAuthorized,false);assert.equal(policy.historicalRows,160);
 assert.equal(sha256(readFileSync(policy.ledger)),policy.historicalLedgerSha256);validateLedger(historical,historical);
 assert.equal(historical.calls.length,160);assert.ok(Math.abs(historical.estimatedUsd-.08213982)<1e-12);assert.equal(historical.unmeteredReserveUsd,.32);
 assert.ok(Math.abs(1-historical.estimatedUsd-historical.unmeteredReserveUsd-.59786018)<1e-12);
 assert.throws(()=>assertCaseAuthorization(policy,'A-en',binding));
});
for(const mutation of ['drop-row','edit-row','lower-metered','lower-unknown','nan']as const)test(`ledger cannot reset on key rotation / ${mutation}`,()=>{
 const changed=structuredClone(historical);
 if(mutation==='drop-row')changed.calls.shift();if(mutation==='edit-row')changed.calls[0]={changed:true};if(mutation==='lower-metered')changed.estimatedUsd=0;if(mutation==='lower-unknown')changed.unmeteredReserveUsd=.30;if(mutation==='nan')changed.estimatedUsd=NaN;
 assert.throws(()=>validateLedger(changed,historical));
});
for(const [estimated,reserve,expected]of [[.08213982,.32,true],[.66,.32,true],[.66000001,.32,false],[NaN,.32,false],[-1,.32,false],[.08213982,Infinity,false]]as const)test(`per-request reserve admission / ${estimated}/${reserve}`,()=>assert.equal(requestFits(estimated,reserve,1),expected));
for(const ceiling of [NaN,Infinity,-.01,.02000001])test(`request ceiling fails closed / ${ceiling}`,()=>assert.throws(()=>admitRequest(historical,ceiling)));
test('every request rechecks remaining budget instead of trusting initial case admission',()=>{
 const ledger=structuredClone(historical);let admitted=0;
 while(requestFits(ledger.estimatedUsd,ledger.unmeteredReserveUsd,1)){admitRequest(ledger,.02);ledger.unmeteredReserveUsd+=.02;admitted++;}
 assert.equal(admitted,29);assert.throws(()=>admitRequest(ledger,0));assert.ok(ledger.unmeteredReserveUsd>=.32);assert.equal(ledger.calls.length,160);
 assert.equal(captureRequirements.limits.maximumRequestsPerCase,7);assert.equal(captureRequirements.limits.providerAutomaticRetries,0);
});
for(const bad of ['https://evil.invalid/v1/responses','https://api.openai.com.evil.invalid/v1/responses','http://api.openai.com/v1/responses','https://api.openai.com/v1/other','https://api.openai.com/v1/responses?token=x','https://example.invalid/rest/v1/knowledge_sources'])test(`network allowlist rejects ${bad}`,()=>assert.throws(()=>classifyNetwork(bad,'POST','gpt-5.6-luna')));
test('provider destinations are exact; all native channel transport remains intercept-only',()=>{
 assert.equal(classifyNetwork('https://api.openai.com/v1/responses','POST','gpt-5.6-luna'),'provider');assert.equal(classifyNetwork('https://api.openai.com/v1/embeddings','POST','text-embedding-3-small'),'provider');
 assert.throws(()=>classifyNetwork('https://api.openai.com/v1/responses','POST','unapproved-model'));
 for(const host of ['api.telegram.org','graph.facebook.com','graph.instagram.com'])assert.equal(classifyNetwork(`https://${host}/synthetic-channel`,'POST'),'intercept-only');
});
for(const payload of [{key:'sk-synthetic-do-not-log'},{header:'Bearer synthetic-only'},{authorization:'synthetic'}])test('credential-shaped values never enter diagnostics '+Object.keys(payload)[0],()=>assert.throws(()=>safeDiagnostic(payload)));
test('runtime-known secret redaction rejects values without printing them',()=>assert.throws(()=>safeDiagnostic({data:'synthetic-sensitive'},['synthetic-sensitive'])));
for(const field of ['caseId','scope','providerExecutionAuthorized','candidateSha256','planSha256','sourceSnapshotSha256','localCapUsd','automaticRetry'])test(`exclusive authorization binding / ${field}`,()=>{
 const invalid:any=auth();invalid[field]=field==='providerExecutionAuthorized'?false:field==='automaticRetry'?true:'wrong';assert.throws(()=>assertCaseAuthorization(invalid,'A-en',binding));
});
test('exclusive consumption, output protection, first-failure latch and immutable historical files',()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'odin-multilingual-prep-'));
 try{
  const history=resolve(dir,'historical-failure.json');writeFileSync(history,'original failed evidence',{flag:'wx'});const before=sha256(readFileSync(history));
  const output=claimCase(dir,'A-en',auth(),binding);assert.equal(readFileSync(output,'utf8'),'{}');assert.throws(()=>claimCase(dir,'A-en',auth(),binding));assert.throws(()=>writeFileSync(output,'overwrite',{flag:'wx'}));
  latchFailure(dir,'A-en','MATERIAL_SEMANTIC_FAILURE');assert.throws(()=>claimCase(dir,'A-sv',auth('A-sv'),binding),/Gate stopped/);assert.equal(sha256(readFileSync(history)),before);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('output collision still consumes the attempted authorization',()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'odin-multilingual-prep-'));
 try{writeFileSync(resolve(dir,'A-en.result.json'),'preserved',{flag:'wx'});assert.throws(()=>claimCase(dir,'A-en',auth(),binding));assert.ok(existsSync(resolve(dir,'A-en.consumed.json')));assert.equal(readFileSync(resolve(dir,'A-en.result.json'),'utf8'),'preserved');}finally{rmSync(dir,{recursive:true,force:true});}
});
test('automated PASS, incomplete human review and changed raw evidence cannot authorize next case',()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'odin-multilingual-prep-'));
 try{
  assert.throws(()=>claimCase(dir,'A-sv',auth('A-sv'),binding));
  const path=claimCase(dir,'A-en',auth(),binding);writeFileSync(path,JSON.stringify({caseId:'A-en',stopReason:null,binding,forbiddenActions:0,outbound:'intercepted',provider:'real OpenAI',units:[{id:'u1',text:'Synthetic verified fact.'}]}));
  const reviewPath=resolve(dir,'A-en.manual-review.json'),review={passed:true,reviewerKind:'automated',rawResultSha256:sha256(readFileSync(path)),claims:[{unitId:'u1',text:'Synthetic verified fact.',correct:true,sourceBound:true,conditionsPreserved:true}],obligations:obligations.A.map(id=>({id,passed:true}))};
  writeFileSync(reviewPath,JSON.stringify(review));assert.throws(()=>claimCase(dir,'A-sv',auth('A-sv'),binding));
  review.reviewerKind='human';review.obligations.pop();writeFileSync(reviewPath,JSON.stringify(review));assert.throws(()=>claimCase(dir,'A-sv',auth('A-sv'),binding));
  review.obligations=obligations.A.map(id=>({id,passed:true}));writeFileSync(reviewPath,JSON.stringify(review));writeFileSync(path,readFileSync(path,'utf8')+' ');assert.throws(()=>claimCase(dir,'A-sv',auth('A-sv'),binding));
  review.rawResultSha256=sha256(readFileSync(path));writeFileSync(reviewPath,JSON.stringify(review));assert.ok(claimCase(dir,'A-sv',auth('A-sv'),binding));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('18 preliminary cases distribute over all four channels; 72-case expansion remains separate',()=>{
 assert.equal(preliminaryAcceptancePlan.length,18);assert.equal(new Set(preliminaryAcceptancePlan.map(c=>c.id)).size,18);assert.equal(laterExpansionPlan.length,72);
 assert.deepEqual([...new Set(preliminaryAcceptancePlan.map(c=>c.channel))].sort(),['instagram','messenger','telegram','whatsapp']);
 for(const language of acceptanceLanguages)assert.equal(preliminaryAcceptancePlan.filter(c=>c.language===language).length,3);
});
for(const family of acceptanceFamilies)for(const language of acceptanceLanguages)test(`question/source obligation contract ${family}/${language}`,()=>{
 const spec=preliminaryAcceptancePlan.find(c=>c.id===`${family}-${language}`)!;assert.deepEqual(spec.obligations,[...obligations[family]]);assert.ok(spec.question.length>60&&spec.question.length<=240);
 assert.equal(documentaryStatements[family][language].length,documentaryQuotes[family].length);
 for(const quote of documentaryQuotes[family])assert.ok(raw.chunks.some((c:any)=>c.content.includes(quote)),'Exact unchanged source span, not a translation or joined quote');
 if(family==='B')assert.ok(spec.question.includes('Video Consultation'));if(family==='C')assert.ok(spec.question.includes('Nordpark'));
});
for(const language of acceptanceLanguages)test(`missing fee still preserves independent documentary facts in core / ${language}`,async()=>{
 const spec=preliminaryAcceptancePlan.find(c=>c.id===`C-${language}`)!,evidence=answerEvidence(77,raw.chunks.map((c:any)=>({sourceId:'incident-pdf',businessId:77,text:c.content,metadata:{...c.metadata,documentRevision:'synthetic-current'}})));
 const manifest=await buildEvidenceFirstAnswer({question:spec.question,language,facets:parseRequestedFacets([{subject:'parking',attribute:spec.question,questionType:'description'}]).facets,evidence,authoritativeEvidence:'{}',history:[],businessTone:{},budget:new InformationBudget(),foreground:true,current:async()=>true,
 generate:async(stage,_instruction,data:any)=>{
  if(stage==='extraction')return{text:JSON.stringify({units:documentaryStatements.C[language].map((text,i)=>{const exactQuote=documentaryQuotes.C[i],e=data.evidence.find((e:any)=>e.text.includes(exactQuote));assert.ok(e);return{facetIds:['f1'],subject:'AdMotion Studio',predicate:'parking policy',value:text,scope:'studio parking arrangements',modality:'descriptive',negation:true,qualifiers:[],language,text,evidenceRefs:[{evidenceId:e.id,exactQuote}]};})})};
  if(stage==='verification')return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:false,incompletenessReason:'MISSING_RELEVANT_FACT',materialUnitIds:['u1','u2'],obligations:[{obligationId:'f1.o1',status:'UNRESOLVED',unitIds:['u1','u2']}]}]})};
  throw Error('No extra composition/answer architecture allowed');
 }});
 assert.equal(manifest.outcomes[0].status,'PARTIAL');assert.equal(manifest.units.length,2);for(const text of documentaryStatements.C[language])assert.ok(manifest.text.includes(text));assert.doesNotMatch(manifest.text,/\d+\s*(?:SEK|EUR)/u);
});

test('shared provider lock excludes simultaneous ledger writers and survives a rejected claim',()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'odin-multilingual-prep-')),path=resolve(dir,'provider.lock');
 try{const release=claimProviderLock(path);assert.throws(()=>claimProviderLock(path));assert.ok(existsSync(path));release();assert.equal(existsSync(path),false);}finally{rmSync(dir,{recursive:true,force:true});}
});
