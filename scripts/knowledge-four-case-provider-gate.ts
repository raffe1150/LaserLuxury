/** Explicit synthetic acceptance gate. No production imports/configuration writes.
 * Only the existing real OpenAI adapter may leave this process. Native sends are intercepted. */
import {readFileSync,writeFileSync,existsSync,openSync,closeSync,unlinkSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {parse} from 'dotenv';
import {performance} from 'node:perf_hooks';
import {createHash,randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import {sharedCorpus} from '../tests/helpers/shared-core-incident';
import {incidentConfig,incidentFlags,incidentInbound,interceptedIncidentSend} from '../tests/helpers/p0-incident-knowledge';

const root=resolve('docs/validation/shared-core-2026-10-22/authorized-four-case-gate');
const cedar=JSON.parse(readFileSync('tests/fixtures/cedar-repair-knowledge.json','utf8'));
export const gatePlan=[
 {id:1,kind:'knowledge-only',businessId:88,question:'For my first visit to Cedar Repair Lab, what should I bring if a device serial number is available?',required:'Recommended serial number with its availability condition; no invented preparation requirements.'},
 {id:2,kind:'catalog-only',businessId:77,question:'What is the configured price of Video Consultation, and how long does it last?',required:'Video Consultation: 300 SEK and 60 minutes, bound to current configured service record.'},
 {id:3,kind:'mixed-source',businessId:88,question:'What does Remote Assessment cost and how long does it last, and can it replace a workshop inspection? Please also explain the documented purpose and limits of photo briefings.',required:'Remote Assessment 145 EUR/25 minutes. Photo briefings: initial orientation only; no automatic replacement; safety-critical faults cannot be assessed from photographs. Relationship to Remote Assessment is unverified.'},
 {id:4,kind:'missing-support',businessId:77,question:"Do your documents give Nordpark's parking fee, and does the studio offer parking-space reservations?",required:'Parking fee unspecified; studio cannot reserve parking. No invented fee or external parking policy.'},
]as const;

export function requestFits(estimated:number,reserve:number,cap:number,next=.02){
 return [estimated,reserve,cap,next].every(n=>Number.isFinite(n)&&n>=0)&&estimated+reserve+next<=cap+1e-12;
}
function currentLocalBudgetCap(){
 const budget=JSON.parse(readFileSync(resolve(root,'local-budget-cap-20261022-050.json'),'utf8'));
 if(budget.localCapUsd!==.50||budget.perRequestReserveUsd!==.02||budget.providerExecutionAuthorized!==false)throw Error('Expected offline-only cumulative cap authorization');
 return budget.localCapUsd as number;
}
// The ordinary gate still uses historical results. A separate, explicitly authorized
// one-use continuation may recognize the reviewed Cedar retry without rewriting history.
const retryMarkerName='case-1-single-retry-consumed.json';
function caseOutput(selected:number,retry:boolean,directory:string){
 const original=resolve(directory,`case-${selected}.json`);
 if(retry){
  if(selected!==1)throw Error('Retry is restricted to Cedar case 1');
  if(existsSync(resolve(directory,retryMarkerName)))throw Error('Authorized single retry already consumed');
  const prior=JSON.parse(readFileSync(original,'utf8'));
  if(prior.spec?.id!==1||prior.spec?.businessId!==88||prior.spec?.question!==gatePlan[0].question||!prior.stopReason||prior.manualReview?.passed!==false)throw Error('Expected historical failed Cedar case is unavailable');
  return resolve(directory,`case-1-cedar-retry-${new Date().toISOString().replace(/[:.]/gu,'-')}-${randomUUID()}.json`);
 }
 if(existsSync(original))throw Error('Case already recorded: inspect saved result, do not repeat');
 if(selected>1){const prior=JSON.parse(readFileSync(resolve(directory,`case-${selected-1}.json`),'utf8'));if(prior.manualReview?.passed!==true||prior.stopReason)throw Error('Previous case has not passed manual acceptance');}
 return original;
}
function claimRetryOutput(directory:string,destination:string,record:unknown){
 // Exclusive marker survives failure: this authorization cannot start a second run.
 writeFileSync(resolve(directory,retryMarkerName),JSON.stringify(record,null,2),{flag:'wx',mode:0o600});
 writeFileSync(destination,'{}',{flag:'wx',mode:0o600});
}
const continuationMarkerName='cases-2-4-one-use-continuation.json';
const fileHash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
function reviewedCase(path:string,id:number,directory:string){
 if(dirname(resolve(path))!==resolve(directory))throw Error('Evidence must remain in the synthetic gate directory');
 const reviewPath=path.replace(/\.json$/u,'-manual-review.json');
 const result=JSON.parse(readFileSync(path,'utf8')),review=JSON.parse(readFileSync(reviewPath,'utf8'));
 if(result.spec?.id!==id||result.spec?.businessId!==gatePlan[id-1]?.businessId||result.spec?.question!==gatePlan[id-1]?.question||result.stopReason!==null||result.forbiddenActions!==0||result.provider!=='real OpenAI'||result.channel!=='whatsapp'||result.language!=='en'||review.passed!==true||resolve(review.result)!==resolve(path)||review.rawEvidenceSha256!==fileHash(path))throw Error('Previous real-provider case lacks bound manual acceptance');
 return {result:resolve(path),resultSha256:fileHash(path),review:resolve(reviewPath),reviewSha256:fileHash(reviewPath)};
}
function continuationOutput(selected:number,directory:string){
 if(![2,3,4].includes(selected))throw Error('Continuation is restricted to cases 2–4');
 const markerPath=resolve(directory,continuationMarkerName);
 if(selected===2&&existsSync(markerPath))throw Error('One-use continuation already consumed');
 const cedarMarker=JSON.parse(readFileSync(resolve(directory,retryMarkerName),'utf8'));
 const original=resolve(directory,'case-1.json'),failed=JSON.parse(readFileSync(original,'utf8'));
 if(cedarMarker.authorizedCase!==1||fileHash(original)!==cedarMarker.retryOf?.sha256||failed.manualReview?.passed!==false||!failed.stopReason)throw Error('Historical failure must remain preserved');
 const cedarAcceptance=reviewedCase(cedarMarker.result,1,directory);
 let authorization:any;
 if(selected===2){
  const run=`${new Date().toISOString().replace(/[:.]/gu,'-')}-${randomUUID()}`;
  authorization={scope:'one-use-cases-2-4',capUsd:.35,originalFailureSha256:fileHash(original),cedarAcceptance,results:Object.fromEntries([2,3,4].map(id=>[id,resolve(directory,`case-${id}-continuation-${run}.json`)]))};
 }else{
  authorization=JSON.parse(readFileSync(markerPath,'utf8'));
  if(authorization.scope!=='one-use-cases-2-4'||authorization.capUsd!==.35||authorization.originalFailureSha256!==fileHash(original)||JSON.stringify(authorization.cedarAcceptance)!==JSON.stringify(cedarAcceptance))throw Error('Continuation evidence or authorization changed');
  reviewedCase(authorization.results?.[selected-1],selected-1,directory);
 }
 const destination=authorization.results?.[selected];
 if(typeof destination!=='string'||dirname(destination)!==resolve(directory)||!destination.startsWith(resolve(directory,`case-${selected}-continuation-`))||existsSync(destination))throw Error('Continuation output is invalid or already recorded');
 return {destination,authorization,first:selected===2};
}
function claimContinuationOutput(directory:string,plan:ReturnType<typeof continuationOutput>){
 if(plan.first)writeFileSync(resolve(directory,continuationMarkerName),JSON.stringify(plan.authorization,null,2),{flag:'wx',mode:0o600});
 // Each case can be claimed once; failure never authorizes a retry or next case.
 writeFileSync(plan.destination,'{}',{flag:'wx',mode:0o600});
}
// Specific authorization for the failed catalog case; never a continuation.
const case2RetryMarkerName='case-2-single-retry-consumed-20261023.json';
function case2RetryOutput(selected:number,directory:string){
 if(selected!==2)throw Error('Catalog retry is restricted to case 2');
 if(existsSync(resolve(directory,case2RetryMarkerName)))throw Error('Single case-2 retry already consumed');
 const continuationPath=resolve(directory,continuationMarkerName),priorAuthorization=JSON.parse(readFileSync(continuationPath,'utf8'));
 const originalCase1=resolve(directory,'case-1.json');
 if(priorAuthorization.scope!=='one-use-cases-2-4'||fileHash(originalCase1)!==priorAuthorization.originalFailureSha256)throw Error('Historical authorization or original case 1 changed');
 const cedar=reviewedCase(priorAuthorization.cedarAcceptance?.result,1,directory);
 if(JSON.stringify(cedar)!==JSON.stringify(priorAuthorization.cedarAcceptance))throw Error('Reviewed Cedar prerequisite changed');
 const prior=priorAuthorization.results?.['2'];
 if(typeof prior!=='string'||dirname(resolve(prior))!==resolve(directory))throw Error('Historical case 2 must remain in the gate directory');
 const reviewPath=prior.replace(/\.json$/u,'-manual-review.json'),failed=JSON.parse(readFileSync(prior,'utf8')),review=JSON.parse(readFileSync(reviewPath,'utf8'));
 if(failed.spec?.id!==2||failed.spec?.businessId!==77||failed.spec?.question!==gatePlan[1].question||failed.stopReason!=='PROVIDER_STAGE_ABORT'||failed.forbiddenActions!==0||review.passed!==false||resolve(review.result)!==resolve(prior)||review.rawEvidenceSha256!==fileHash(prior))throw Error('Expected bound failed case-2 evidence is unavailable');
 return {destination:resolve(directory,`case-2-catalog-retry-${new Date().toISOString().replace(/[:.]/gu,'-')}-${randomUUID()}.json`),
  retryOf:{result:prior,resultSha256:fileHash(prior),review:reviewPath,reviewSha256:fileHash(reviewPath),continuationAuthorizationSha256:fileHash(continuationPath),originalCase1Sha256:fileHash(originalCase1),cedarAcceptance:cedar}};
}
function claimCase2RetryOutput(directory:string,plan:ReturnType<typeof case2RetryOutput>){
 writeFileSync(resolve(directory,case2RetryMarkerName),JSON.stringify({scope:'one-use-case-2-only',capUsd:currentLocalBudgetCap(),...plan},null,2),{flag:'wx',mode:0o600});
 writeFileSync(plan.destination,'{}',{flag:'wx',mode:0o600});
}
// One mixed-source execution, independently authorized; historical gates stay closed.
const case3SingleMarkerName='case-3-single-consumed-20261023.json';
function case3SingleOutput(selected:number,directory:string){
 if(selected!==3)throw Error('Single mixed-source execution is restricted to case 3');
 if(existsSync(resolve(directory,case3SingleMarkerName)))throw Error('Single case-3 authorization already consumed');
 return {destination:resolve(directory,`case-3-mixed-single-${new Date().toISOString().replace(/[:.]/gu,'-')}-${randomUUID()}.json`),prerequisites:case3Prerequisites(directory)};
}
function case3Prerequisites(directory:string){
 const priorPath=resolve(directory,case2RetryMarkerName),prior=JSON.parse(readFileSync(priorPath,'utf8'));
 if(prior.scope!=='one-use-case-2-only'||prior.capUsd!==.5)throw Error('Expected preserved case-2 retry authorization');
 const case2=reviewedCase(prior.destination,2,directory),cedar=reviewedCase(prior.retryOf?.cedarAcceptance?.result,1,directory);
 if(JSON.stringify(cedar)!==JSON.stringify(prior.retryOf.cedarAcceptance)||fileHash(resolve(directory,'case-1.json'))!==prior.retryOf.originalCase1Sha256||fileHash(resolve(directory,continuationMarkerName))!==prior.retryOf.continuationAuthorizationSha256||fileHash(prior.retryOf.result)!==prior.retryOf.resultSha256||fileHash(prior.retryOf.review)!==prior.retryOf.reviewSha256)throw Error('Historical failures or prerequisite evidence changed');
 return {cedarAcceptance:cedar,case2Acceptance:case2,case2AuthorizationSha256:fileHash(priorPath)};
}
function claimCase3SingleOutput(directory:string,plan:ReturnType<typeof case3SingleOutput>){
 writeFileSync(resolve(directory,case3SingleMarkerName),JSON.stringify({scope:'one-use-case-3-only',capUsd:currentLocalBudgetCap(),...plan},null,2),{flag:'wx',mode:0o600});
 writeFileSync(plan.destination,'{}',{flag:'wx',mode:0o600});
}
// Separately authorized retry of the specific planner-aborted mixed case only.
// The old consumed marker and its result/review remain immutable prerequisites.
const case3RetryMarkerName='case-3-mixed-retry-consumed-20261023.json';
function case3RetryOutput(selected:number,directory:string){
 if(selected!==3)throw Error('Mixed-source retry is restricted to case 3');
 if(existsSync(resolve(directory,case3RetryMarkerName)))throw Error('Single mixed-source retry already consumed');
 const authorizationPath=resolve(directory,case3SingleMarkerName),prior=JSON.parse(readFileSync(authorizationPath,'utf8'));
 const prerequisites=case3Prerequisites(directory);
 if(prior.scope!=='one-use-case-3-only'||prior.capUsd!==.5||JSON.stringify(prior.prerequisites)!==JSON.stringify(prerequisites))throw Error('Historical case-3 authorization or prerequisites changed');
 const path=prior.destination;
 if(typeof path!=='string'||dirname(resolve(path))!==resolve(directory)||!path.startsWith(resolve(directory,'case-3-mixed-single-')))throw Error('Expected original mixed-source result');
 const reviewPath=path.replace(/\.json$/u,'-manual-review.json'),failed=JSON.parse(readFileSync(path,'utf8')),review=JSON.parse(readFileSync(reviewPath,'utf8'));
 if(failed.spec?.id!==3||failed.spec?.businessId!==88||failed.spec?.question!==gatePlan[2].question||failed.stopReason!=='PROVIDER_STAGE_ABORT'||failed.forbiddenActions!==0||failed.provider!=='real OpenAI'||failed.channel!=='whatsapp'||failed.language!=='en'||review.passed!==false||resolve(review.result)!==resolve(path)||review.rawEvidenceSha256!==fileHash(path))throw Error('Expected bound planner-failed case-3 evidence');
 return {destination:resolve(directory,`case-3-mixed-retry-${new Date().toISOString().replace(/[:.]/gu,'-')}-${randomUUID()}.json`),prerequisites,
  retryOf:{result:path,resultSha256:fileHash(path),review:reviewPath,reviewSha256:fileHash(reviewPath),authorizationSha256:fileHash(authorizationPath)}};
}
function claimCase3RetryOutput(directory:string,plan:ReturnType<typeof case3RetryOutput>){
 writeFileSync(resolve(directory,case3RetryMarkerName),JSON.stringify({scope:'one-use-case-3-retry-only',capUsd:currentLocalBudgetCap(),...plan},null,2),{flag:'wx',mode:0o600});
 writeFileSync(plan.destination,'{}',{flag:'wx',mode:0o600});
}
// Final bounded retry after the separately reviewed source-proof correction.
// Fixed case/marker scope; this does not reopen either prior retry authorization.
const case3FinalMarkerName='case-3-final-bounded-consumed-20261023.json';
function case3FinalOutput(selected:number,directory:string){
 if(selected!==3)throw Error('Final bounded retry is restricted to case 3');
 if(existsSync(resolve(directory,case3FinalMarkerName)))throw Error('Final bounded case-3 retry already consumed');
 const authorizationPath=resolve(directory,case3RetryMarkerName),prior=JSON.parse(readFileSync(authorizationPath,'utf8')),prerequisites=case3Prerequisites(directory);
 if(prior.scope!=='one-use-case-3-retry-only'||prior.capUsd!==.5||JSON.stringify(prior.prerequisites)!==JSON.stringify(prerequisites))throw Error('Previous mixed retry authorization or prerequisites changed');
 const original=prior.retryOf;
 if(!original||fileHash(original.result)!==original.resultSha256||fileHash(original.review)!==original.reviewSha256||fileHash(resolve(directory,case3SingleMarkerName))!==original.authorizationSha256)throw Error('Original mixed failure or consumed marker changed');
 const path=prior.destination;
 if(typeof path!=='string'||dirname(resolve(path))!==resolve(directory)||!path.startsWith(resolve(directory,'case-3-mixed-retry-')))throw Error('Expected previous mixed retry result');
 const reviewPath=path.replace(/\.json$/u,'-manual-review.json'),failed=JSON.parse(readFileSync(path,'utf8')),review=JSON.parse(readFileSync(reviewPath,'utf8'));
 if(failed.spec?.id!==3||failed.spec?.businessId!==88||failed.spec?.question!==gatePlan[2].question||failed.stopReason!=='PROVIDER_STAGE_ABORT'||failed.forbiddenActions!==0||failed.provider!=='real OpenAI'||failed.channel!=='whatsapp'||failed.language!=='en'||!failed.calls?.some((c:any)=>c.kind==='embedding'&&c.errorType==='AbortError')||review.passed!==false||review.failureStage!=='semantic_retrieval_cold_corpus_embedding'||resolve(review.result)!==resolve(path)||review.rawEvidenceSha256!==fileHash(path))throw Error('Expected bound cold-embedding failure');
 return {destination:resolve(directory,`case-3-final-bounded-${new Date().toISOString().replace(/[:.]/gu,'-')}-${randomUUID()}.json`),prerequisites,
  retryOf:{result:path,resultSha256:fileHash(path),review:reviewPath,reviewSha256:fileHash(reviewPath),authorizationSha256:fileHash(authorizationPath)}};
}
function claimCase3FinalOutput(directory:string,plan:ReturnType<typeof case3FinalOutput>){
 writeFileSync(resolve(directory,case3FinalMarkerName),JSON.stringify({scope:'one-use-case-3-final-bounded-only',capUsd:currentLocalBudgetCap(),...plan},null,2),{flag:'wx',mode:0o600});
 writeFileSync(plan.destination,'{}',{flag:'wx',mode:0o600});
}
// One semantic revalidation after the two reviewed deterministic publication fixes.
// Historical final-bounded failure remains a prerequisite, never relabeled as a pass.
const case3SemanticMarkerName='case-3-semantic-revalidation-consumed-20261023.json';
function semanticCandidateBinding(){
 const snapshotPath=resolve('docs/validation/shared-core-2026-10-22/case-3-semantic-revalidation-20261023/preflight-before.json');
 const acceptedPath=resolve('docs/validation/shared-core-2026-10-22/false-complete-repair-20261023/validation-accepted.json');
 const snapshot=JSON.parse(readFileSync(snapshotPath,'utf8')),accepted=JSON.parse(readFileSync(acceptedPath,'utf8'));
 for(const [path,hash]of Object.entries(accepted.acceptedSourceHashes))assert.equal(fileHash(path),hash,'Accepted candidate changed');
 for(const [path,hash]of Object.entries({...snapshot.runtimeSources,...snapshot.fixtures}))assert.equal(fileHash(path),hash,'Runtime or fixture changed after preflight');
 const languagePatch='docs/validation/shared-core-2026-10-22/language-polarity-repair/language-only-polarity-v2.patch';
 assert.equal(fileHash(languagePatch),snapshot.files[languagePatch],'Language-only patch changed');
 assert.equal(fileHash('docs/validation/shared-core-2026-10-22/source-aware-usage.json'),snapshot.ledgerSha256,'Budget ledger changed before admission');
 return {snapshotSha256:fileHash(snapshotPath),acceptedValidationSha256:fileHash(acceptedPath),acceptedSourceHashes:accepted.acceptedSourceHashes,runtimeSources:snapshot.runtimeSources,fixtures:snapshot.fixtures,languagePatchSha256:fileHash(languagePatch),ledgerSha256Before:snapshot.ledgerSha256};
}
function case3SemanticOutput(selected:number,directory:string){
 if(selected!==3)throw Error('Semantic revalidation is restricted to case 3');
 if(existsSync(resolve(directory,case3SemanticMarkerName)))throw Error('Single semantic revalidation already consumed');
 const authorizationPath=resolve(directory,case3FinalMarkerName),prior=JSON.parse(readFileSync(authorizationPath,'utf8')),prerequisites=case3Prerequisites(directory);
 if(prior.scope!=='one-use-case-3-final-bounded-only'||prior.capUsd!==.5||JSON.stringify(prior.prerequisites)!==JSON.stringify(prerequisites))throw Error('Final bounded authorization or prerequisites changed');
 const original=prior.retryOf;
 if(!original||fileHash(original.result)!==original.resultSha256||fileHash(original.review)!==original.reviewSha256||fileHash(resolve(directory,case3RetryMarkerName))!==original.authorizationSha256)throw Error('Historical mixed retry evidence changed');
 const path=prior.destination;
 if(typeof path!=='string'||dirname(resolve(path))!==resolve(directory)||!path.startsWith(resolve(directory,'case-3-final-bounded-')))throw Error('Expected final bounded case-3 evidence');
 const reviewPath=path.replace(/\.json$/u,'-manual-review.json'),failed=JSON.parse(readFileSync(path,'utf8')),review=JSON.parse(readFileSync(reviewPath,'utf8'));
 if(failed.spec?.id!==3||failed.spec?.businessId!==88||failed.spec?.question!==gatePlan[2].question||failed.stopReason!==null||failed.forbiddenActions!==0||failed.provider!=='real OpenAI'||failed.channel!=='whatsapp'||failed.language!=='en'||review.passed!==false||review.failureStage!=='post-verification documentary inventory pruning / final answer completeness'||resolve(review.result)!==resolve(path)||review.rawEvidenceSha256!==fileHash(path))throw Error('Expected bound documentary-suppression failure');
 return {destination:resolve(directory,`case-3-semantic-revalidation-${new Date().toISOString().replace(/[:.]/gu,'-')}-${randomUUID()}.json`),prerequisites,candidate:semanticCandidateBinding(),
  retryOf:{result:path,resultSha256:fileHash(path),review:reviewPath,reviewSha256:fileHash(reviewPath),authorizationSha256:fileHash(authorizationPath)}};
}
function claimCase3SemanticOutput(directory:string,plan:ReturnType<typeof case3SemanticOutput>){
 writeFileSync(resolve(directory,case3SemanticMarkerName),JSON.stringify({scope:'one-use-case-3-semantic-revalidation-only',capUsd:currentLocalBudgetCap(),...plan},null,2),{flag:'wx',mode:0o600});
 writeFileSync(plan.destination,'{}',{flag:'wx',mode:0o600});
}
if(process.argv.includes('--case3-single-preflight')||process.argv.includes('--case3-retry-preflight')||(process.argv.includes('--case3-final-preflight')||process.argv.includes('--case3-semantic-preflight'))){
 const directory=mkdtempSync(resolve(tmpdir(),'odinlink-case3-single-'));let checks=0;
 const check=(fn:()=>void)=>{fn();checks++;};
 const accepted=(path:string,id:number)=>{
  writeFileSync(path,JSON.stringify({spec:gatePlan[id-1],provider:'real OpenAI',channel:'whatsapp',language:'en',stopReason:null,forbiddenActions:0}),{flag:'wx'});
  writeFileSync(path.replace(/\.json$/u,'-manual-review.json'),JSON.stringify({passed:true,result:path,rawEvidenceSha256:fileHash(path)}),{flag:'wx'});
 };
 try{
  for(const id of [1,2,4])check(()=>assert.throws(()=>case3SingleOutput(id,directory)));
  check(()=>assert.throws(()=>case3SingleOutput(3,directory)));
  const original=resolve(directory,'case-1.json'),cedar=resolve(directory,'case-1-test-pass.json'),case2=resolve(directory,'case-2-test-pass.json'),failed=resolve(directory,'case-2-test-failure.json'),failedReview=failed.replace(/\.json$/u,'-manual-review.json');
  writeFileSync(original,JSON.stringify({spec:gatePlan[0],stopReason:'PROVIDER_STAGE_ABORT',manualReview:{passed:false}}),{flag:'wx'});accepted(cedar,1);accepted(case2,2);
  writeFileSync(resolve(directory,retryMarkerName),JSON.stringify({authorizedCase:1,result:cedar,retryOf:{sha256:fileHash(original)}}),{flag:'wx'});
  writeFileSync(failed,JSON.stringify({spec:gatePlan[1],stopReason:'PROVIDER_STAGE_ABORT',forbiddenActions:0}),{flag:'wx'});
  writeFileSync(failedReview,JSON.stringify({passed:false,result:failed,rawEvidenceSha256:fileHash(failed)}),{flag:'wx'});
  const continuation=resolve(directory,continuationMarkerName);
  writeFileSync(continuation,JSON.stringify({scope:'one-use-cases-2-4',capUsd:.35,originalFailureSha256:fileHash(original),cedarAcceptance:reviewedCase(cedar,1,directory),results:{2:failed,3:resolve(directory,'case-3-never-run.json'),4:resolve(directory,'case-4-never-run.json')}}),{flag:'wx'});
  writeFileSync(resolve(directory,case2RetryMarkerName),JSON.stringify({scope:'one-use-case-2-only',capUsd:.5,destination:case2,retryOf:{result:failed,resultSha256:fileHash(failed),review:failedReview,reviewSha256:fileHash(failedReview),originalCase1Sha256:fileHash(original),continuationAuthorizationSha256:fileHash(continuation),cedarAcceptance:reviewedCase(cedar,1,directory)}}),{flag:'wx'});
  const historical=[...Array.from(['case-1.json',retryMarkerName,continuationMarkerName,case2RetryMarkerName],name=>resolve(directory,name)),cedar,cedar.replace(/\.json$/u,'-manual-review.json'),case2,case2.replace(/\.json$/u,'-manual-review.json'),failed,failedReview].map(path=>({path,hash:fileHash(path)}));
  const plan=case3SingleOutput(3,directory);check(()=>assert.equal(existsSync(plan.destination),false));check(()=>assert.notEqual(plan.destination,case3SingleOutput(3,directory).destination));
  const reviewPath=case2.replace(/\.json$/u,'-manual-review.json'),review=readFileSync(reviewPath,'utf8');writeFileSync(reviewPath,JSON.stringify({...JSON.parse(review),passed:false}));
  check(()=>assert.throws(()=>case3SingleOutput(3,directory)));writeFileSync(reviewPath,review);
  const originalText=readFileSync(original,'utf8');writeFileSync(original,originalText+' ');
  check(()=>assert.throws(()=>case3SingleOutput(3,directory)));writeFileSync(original,originalText);
  check(()=>assert.equal(currentLocalBudgetCap(),.5));check(()=>assert.equal(requestFits(.07705597,.26,.5),true));check(()=>assert.equal(requestFits(.22,.26,.5),true));check(()=>assert.equal(requestFits(.22000001,.26,.5),false));
  claimCase3SingleOutput(directory,plan);
  check(()=>assert.throws(()=>case3SingleOutput(3,directory)));check(()=>assert.throws(()=>claimCase3SingleOutput(directory,plan)));check(()=>assert.throws(()=>writeFileSync(plan.destination,'overwrite',{flag:'wx'})));check(()=>assert.equal(readFileSync(plan.destination,'utf8'),'{}'));
  // A new case-3 PASS cannot become the prior gate's case-3 result or unlock case 4.
  writeFileSync(plan.destination,JSON.stringify({spec:gatePlan[2],provider:'real OpenAI',channel:'whatsapp',language:'en',stopReason:null,forbiddenActions:0}));writeFileSync(plan.destination.replace(/\.json$/u,'-manual-review.json'),JSON.stringify({passed:true,result:plan.destination,rawEvidenceSha256:fileHash(plan.destination)}),{flag:'wx'});
  check(()=>assert.throws(()=>continuationOutput(3,directory),/lacks bound manual acceptance/u));check(()=>assert.throws(()=>continuationOutput(4,directory)));check(()=>assert.throws(()=>caseOutput(4,false,directory)));
  if(process.argv.includes('--case3-retry-preflight')||(process.argv.includes('--case3-final-preflight')||process.argv.includes('--case3-semantic-preflight'))){
   for(const id of [1,2,4])check(()=>assert.throws(()=>case3RetryOutput(id,directory)));
   check(()=>assert.throws(()=>case3RetryOutput(3,directory),'A previous PASS is not a retryable failure'));
   const failure={spec:gatePlan[2],provider:'real OpenAI',channel:'whatsapp',language:'en',stopReason:'PROVIDER_STAGE_ABORT',forbiddenActions:0};
   writeFileSync(plan.destination,JSON.stringify(failure));const failed3Review=plan.destination.replace(/\.json$/u,'-manual-review.json');
   const bindReview=()=>writeFileSync(failed3Review,JSON.stringify({passed:false,result:plan.destination,rawEvidenceSha256:fileHash(plan.destination)}));bindReview();
   const retryPlan=case3RetryOutput(3,directory);check(()=>assert.notEqual(retryPlan.destination,case3RetryOutput(3,directory).destination));check(()=>assert.equal(existsSync(retryPlan.destination),false));
   const failureText=readFileSync(plan.destination,'utf8'),failedReviewText=readFileSync(failed3Review,'utf8');
   writeFileSync(plan.destination,failureText+' ');check(()=>assert.throws(()=>case3RetryOutput(3,directory)));writeFileSync(plan.destination,failureText);
   writeFileSync(failed3Review,JSON.stringify({passed:true}));check(()=>assert.throws(()=>case3RetryOutput(3,directory)));writeFileSync(failed3Review,failedReviewText);
   const originalMarker=readFileSync(resolve(directory,case3SingleMarkerName),'utf8');
   writeFileSync(resolve(directory,case3SingleMarkerName),JSON.stringify({...JSON.parse(originalMarker),prerequisites:{}}));check(()=>assert.throws(()=>case3RetryOutput(3,directory)));writeFileSync(resolve(directory,case3SingleMarkerName),originalMarker);
   const preserved=[...historical,...[plan.destination,failed3Review,resolve(directory,case3SingleMarkerName)].map(path=>({path,hash:fileHash(path)}))];
   for(const [estimated,reserve,expected]of [[.07716717,.28,true],[.20,.28,true],[.20000001,.28,false],[NaN,.28,false],[-1,.28,false],[.07716717,Infinity,false]]as const)check(()=>assert.equal(requestFits(estimated,reserve,.5),expected));
   // Test an independent collision without removing or resetting any marker.
   const collisionDirectory=mkdtempSync(resolve(tmpdir(),'odinlink-case3-collision-'));
   try{const collision={...retryPlan,destination:resolve(collisionDirectory,'existing.json')};writeFileSync(collision.destination,'existing',{flag:'wx'});check(()=>assert.throws(()=>claimCase3RetryOutput(collisionDirectory,collision)));check(()=>assert.equal(readFileSync(collision.destination,'utf8'),'existing'));check(()=>assert.equal(existsSync(resolve(collisionDirectory,case3RetryMarkerName)),true));check(()=>assert.throws(()=>claimCase3RetryOutput(collisionDirectory,collision)));}finally{rmSync(collisionDirectory,{recursive:true,force:true});}
   claimCase3RetryOutput(directory,retryPlan);check(()=>assert.equal(readFileSync(retryPlan.destination,'utf8'),'{}'));check(()=>assert.throws(()=>case3RetryOutput(3,directory)));check(()=>assert.throws(()=>claimCase3RetryOutput(directory,retryPlan)));check(()=>assert.throws(()=>writeFileSync(retryPlan.destination,'overwrite',{flag:'wx'})));
   writeFileSync(retryPlan.destination,JSON.stringify({spec:gatePlan[2],provider:'real OpenAI',channel:'whatsapp',language:'en',stopReason:null,forbiddenActions:0}));writeFileSync(retryPlan.destination.replace(/\.json$/u,'-manual-review.json'),JSON.stringify({passed:true,result:retryPlan.destination,rawEvidenceSha256:fileHash(retryPlan.destination)}),{flag:'wx'});
   check(()=>assert.throws(()=>case3RetryOutput(3,directory)));check(()=>assert.throws(()=>continuationOutput(4,directory)));check(()=>assert.throws(()=>caseOutput(4,false,directory)));
   if((process.argv.includes('--case3-final-preflight')||process.argv.includes('--case3-semantic-preflight'))){
    for(const id of [1,2,4])check(()=>assert.throws(()=>case3FinalOutput(id,directory)));
    check(()=>assert.throws(()=>case3FinalOutput(3,directory),'Previous PASS cannot authorize this failed-case retry'));
    writeFileSync(retryPlan.destination,JSON.stringify({...failure,calls:[{kind:'embedding',errorType:'AbortError'}]}));
    const lastReview=retryPlan.destination.replace(/\.json$/u,'-manual-review.json');writeFileSync(lastReview,JSON.stringify({passed:false,result:retryPlan.destination,rawEvidenceSha256:fileHash(retryPlan.destination),failureStage:'semantic_retrieval_cold_corpus_embedding'}));
    const final=case3FinalOutput(3,directory);check(()=>assert.equal(existsSync(final.destination),false));check(()=>assert.notEqual(final.destination,case3FinalOutput(3,directory).destination));
    const raw=readFileSync(retryPlan.destination,'utf8'),review=readFileSync(lastReview,'utf8');
    writeFileSync(retryPlan.destination,raw+' ');check(()=>assert.throws(()=>case3FinalOutput(3,directory)));writeFileSync(retryPlan.destination,raw);
    writeFileSync(lastReview,JSON.stringify({...JSON.parse(review),passed:true}));check(()=>assert.throws(()=>case3FinalOutput(3,directory)));writeFileSync(lastReview,review);
    const markerPath=resolve(directory,case3RetryMarkerName),marker=readFileSync(markerPath,'utf8');writeFileSync(markerPath,JSON.stringify({...JSON.parse(marker),prerequisites:{}}));check(()=>assert.throws(()=>case3FinalOutput(3,directory)));writeFileSync(markerPath,marker);
    const allPrior=[...preserved,...[retryPlan.destination,lastReview,markerPath].map(path=>({path,hash:fileHash(path)}))];
    for(const [estimated,reserve,expected]of [[.07728617,.30,true],[.18,.30,true],[.18000001,.30,false],[NaN,.30,false]]as const)check(()=>assert.equal(requestFits(estimated,reserve,.5),expected));
    const collisionDirectory=mkdtempSync(resolve(tmpdir(),'odinlink-case3-final-collision-'));
    try{const collision={...final,destination:resolve(collisionDirectory,'existing.json')};writeFileSync(collision.destination,'existing',{flag:'wx'});check(()=>assert.throws(()=>claimCase3FinalOutput(collisionDirectory,collision)));check(()=>assert.equal(readFileSync(collision.destination,'utf8'),'existing'));check(()=>assert.equal(existsSync(resolve(collisionDirectory,case3FinalMarkerName)),true));check(()=>assert.throws(()=>claimCase3FinalOutput(collisionDirectory,collision)));}finally{rmSync(collisionDirectory,{recursive:true,force:true});}
    claimCase3FinalOutput(directory,final);check(()=>assert.equal(readFileSync(final.destination,'utf8'),'{}'));check(()=>assert.throws(()=>case3FinalOutput(3,directory)));check(()=>assert.throws(()=>claimCase3FinalOutput(directory,final)));check(()=>assert.throws(()=>writeFileSync(final.destination,'overwrite',{flag:'wx'})));
    writeFileSync(final.destination,JSON.stringify({spec:gatePlan[2],stopReason:null,manualReview:{passed:true}}));check(()=>assert.throws(()=>continuationOutput(4,directory)));check(()=>assert.throws(()=>caseOutput(4,false,directory)));check(()=>assert.throws(()=>case3RetryOutput(3,directory)));
    for(const h of allPrior)check(()=>assert.equal(fileHash(h.path),h.hash));
    if(process.argv.includes('--case3-semantic-preflight')){
     for(const id of [1,2,4])check(()=>assert.throws(()=>case3SemanticOutput(id,directory)));
     check(()=>assert.throws(()=>case3SemanticOutput(3,directory),'A prior PASS cannot authorize this revalidation'));
     writeFileSync(final.destination,JSON.stringify({...failure,stopReason:null}));
     const reviewPath=final.destination.replace(/\.json$/u,'-manual-review.json');
     writeFileSync(reviewPath,JSON.stringify({passed:false,result:final.destination,rawEvidenceSha256:fileHash(final.destination),failureStage:'post-verification documentary inventory pruning / final answer completeness'}),{flag:'wx'});
     const preservedFinal=[...allPrior,...[final.destination,reviewPath,resolve(directory,case3FinalMarkerName)].map(path=>({path,hash:fileHash(path)}))];
     const semantic=case3SemanticOutput(3,directory);check(()=>assert.equal(existsSync(semantic.destination),false));check(()=>assert.notEqual(semantic.destination,case3SemanticOutput(3,directory).destination));
     const raw=readFileSync(final.destination,'utf8'),review=readFileSync(reviewPath,'utf8');
     writeFileSync(final.destination,raw+' ');check(()=>assert.throws(()=>case3SemanticOutput(3,directory)));writeFileSync(final.destination,raw);
     writeFileSync(reviewPath,JSON.stringify({...JSON.parse(review),passed:true}));check(()=>assert.throws(()=>case3SemanticOutput(3,directory)));writeFileSync(reviewPath,review);
     writeFileSync(reviewPath,JSON.stringify({...JSON.parse(review),failureStage:'different failure'}));check(()=>assert.throws(()=>case3SemanticOutput(3,directory)));writeFileSync(reviewPath,review);
     for(const [estimated,reserve,expected]of [[.07972512,.30,true],[.18,.30,true],[.18000001,.30,false],[NaN,.30,false],[-1,.30,false],[.07972512,Infinity,false]]as const)check(()=>assert.equal(requestFits(estimated,reserve,.5),expected));
     const collisionDirectory=mkdtempSync(resolve(tmpdir(),'odinlink-case3-semantic-collision-'));
     try{const collision={...semantic,destination:resolve(collisionDirectory,'existing.json')};writeFileSync(collision.destination,'existing',{flag:'wx'});check(()=>assert.throws(()=>claimCase3SemanticOutput(collisionDirectory,collision)));check(()=>assert.equal(readFileSync(collision.destination,'utf8'),'existing'));check(()=>assert.equal(existsSync(resolve(collisionDirectory,case3SemanticMarkerName)),true));check(()=>assert.throws(()=>claimCase3SemanticOutput(collisionDirectory,collision)));}finally{rmSync(collisionDirectory,{recursive:true,force:true});}
     claimCase3SemanticOutput(directory,semantic);check(()=>assert.equal(readFileSync(semantic.destination,'utf8'),'{}'));check(()=>assert.throws(()=>case3SemanticOutput(3,directory)));check(()=>assert.throws(()=>claimCase3SemanticOutput(directory,semantic)));check(()=>assert.throws(()=>writeFileSync(semantic.destination,'overwrite',{flag:'wx'})));
     check(()=>assert.throws(()=>continuationOutput(4,directory)));check(()=>assert.throws(()=>caseOutput(4,false,directory)));check(()=>assert.throws(()=>case3FinalOutput(3,directory)));
     for(const h of preservedFinal)check(()=>assert.equal(fileHash(h.path),h.hash));
    }

   }
   for(const id of [1,2,3,4])check(()=>assert.throws(()=>caseOutput(id,id===1,directory)));
   check(()=>assert.throws(()=>continuationOutput(4,directory)));check(()=>assert.throws(()=>case3SingleOutput(3,directory)));
   for(const h of preserved)check(()=>assert.equal(fileHash(h.path),h.hash));
  }
  for(const h of historical)check(()=>assert.equal(fileHash(h.path),h.hash));
  console.log(JSON.stringify({offline:true,checks,passed:checks,providerRequests:0}));
 }finally{rmSync(directory,{recursive:true,force:true});}
 process.exit(0);
}
if(process.argv.includes('--case2-retry-preflight')){
 const directory=mkdtempSync(resolve(tmpdir(),'odinlink-case2-retry-'));let checks=0;
 const check=(fn:()=>void)=>{fn();checks++;};
 try{
  for(const id of [1,3,4])check(()=>assert.throws(()=>case2RetryOutput(id,directory)));
  check(()=>assert.throws(()=>case2RetryOutput(2,directory)));
  const original=resolve(directory,'case-1.json'),cedar=resolve(directory,'case-1-synthetic-retry.json'),failedPath=resolve(directory,'case-2-synthetic-failure.json');
  writeFileSync(original,JSON.stringify({spec:gatePlan[0],stopReason:'PROVIDER_STAGE_ABORT',manualReview:{passed:false}}),{flag:'wx'});
  writeFileSync(cedar,JSON.stringify({spec:gatePlan[0],provider:'real OpenAI',channel:'whatsapp',language:'en',stopReason:null,forbiddenActions:0}),{flag:'wx'});
  writeFileSync(cedar.replace(/\.json$/u,'-manual-review.json'),JSON.stringify({passed:true,result:cedar,rawEvidenceSha256:fileHash(cedar)}),{flag:'wx'});
  const failed={spec:gatePlan[1],stopReason:'PROVIDER_STAGE_ABORT',forbiddenActions:0};
  writeFileSync(failedPath,JSON.stringify(failed),{flag:'wx'});
  const failedReviewPath=failedPath.replace(/\.json$/u,'-manual-review.json'),failedReview=JSON.stringify({passed:false,result:failedPath,rawEvidenceSha256:fileHash(failedPath)});
  writeFileSync(failedReviewPath,failedReview,{flag:'wx'});
  writeFileSync(resolve(directory,retryMarkerName),JSON.stringify({authorizedCase:1,result:cedar,retryOf:{sha256:fileHash(original)}}),{flag:'wx'});
  const markerPath=resolve(directory,continuationMarkerName),marker=JSON.stringify({scope:'one-use-cases-2-4',capUsd:.35,originalFailureSha256:fileHash(original),cedarAcceptance:reviewedCase(cedar,1,directory),results:{2:failedPath,3:resolve(directory,'case-3-never-run.json'),4:resolve(directory,'case-4-never-run.json')}});
  writeFileSync(markerPath,marker,{flag:'wx'});
  const hashes=[original,cedar,failedPath,failedReviewPath,markerPath].map(path=>({path,hash:fileHash(path)}));
  const plan=case2RetryOutput(2,directory);
  check(()=>assert.notEqual(plan.destination,failedPath));
  check(()=>assert.notEqual(plan.destination,case2RetryOutput(2,directory).destination));
  check(()=>assert.equal(existsSync(plan.destination),false));
  writeFileSync(failedReviewPath,JSON.stringify({passed:true,result:failedPath,rawEvidenceSha256:fileHash(failedPath)}));
  check(()=>assert.throws(()=>case2RetryOutput(2,directory)));
  writeFileSync(failedReviewPath,failedReview);
  writeFileSync(failedPath,JSON.stringify({...failed,stopReason:null}));
  check(()=>assert.throws(()=>case2RetryOutput(2,directory)));
  writeFileSync(failedPath,JSON.stringify(failed));
  writeFileSync(markerPath,JSON.stringify({...JSON.parse(marker),originalFailureSha256:'wrong'}));
  check(()=>assert.throws(()=>case2RetryOutput(2,directory)));
  writeFileSync(markerPath,marker);
  check(()=>assert.equal(requestFits(.07627087,.26,currentLocalBudgetCap()),true));
  check(()=>assert.equal(requestFits(.22,.26,currentLocalBudgetCap()),true));
  check(()=>assert.equal(requestFits(.22000001,.26,currentLocalBudgetCap()),false));
  check(()=>assert.equal(requestFits(NaN,.26,currentLocalBudgetCap()),false));
  claimCase2RetryOutput(directory,plan);
  check(()=>assert.throws(()=>case2RetryOutput(2,directory)));
  check(()=>assert.throws(()=>claimCase2RetryOutput(directory,plan)));
  check(()=>assert.throws(()=>writeFileSync(plan.destination,'overwrite',{flag:'wx'})));
  check(()=>assert.equal(readFileSync(plan.destination,'utf8'),'{}'));
  // Even a successful case-2 retry is not the old continuation's prerequisite.
  writeFileSync(plan.destination,JSON.stringify({spec:gatePlan[1],provider:'real OpenAI',channel:'whatsapp',language:'en',stopReason:null,forbiddenActions:0}));
  writeFileSync(plan.destination.replace(/\.json$/u,'-manual-review.json'),JSON.stringify({passed:true,result:plan.destination,rawEvidenceSha256:fileHash(plan.destination)}),{flag:'wx'});
  check(()=>assert.throws(()=>continuationOutput(3,directory),/lacks bound manual acceptance/u));
  check(()=>assert.throws(()=>continuationOutput(4,directory)));
  check(()=>assert.throws(()=>continuationOutput(2,directory)));
  check(()=>assert.throws(()=>caseOutput(2,false,directory)));
  for(const h of hashes)check(()=>assert.equal(fileHash(h.path),h.hash));
  console.log(JSON.stringify({offline:true,checks,passed:checks,providerRequests:0}));
 }finally{rmSync(directory,{recursive:true,force:true});}
 process.exit(0);
}
if(process.argv.includes('--continuation-preflight')){
 const directory=mkdtempSync(resolve(tmpdir(),'odinlink-continuation-'));let checks=0;
 const check=(fn:()=>void)=>{fn();checks++;};
 const accept=(path:string,id:number)=>{
  const result={spec:gatePlan[id-1],stopReason:null,forbiddenActions:0,provider:'real OpenAI',channel:'whatsapp',language:'en'};
  writeFileSync(path,JSON.stringify(result));
  writeFileSync(path.replace(/\.json$/u,'-manual-review.json'),JSON.stringify({passed:true,result:path,rawEvidenceSha256:fileHash(path)}),{flag:'wx'});
 };
 try{
  const original=resolve(directory,'case-1.json'),cedarResult=resolve(directory,'case-1-test-retry.json');
  writeFileSync(original,JSON.stringify({spec:gatePlan[0],stopReason:'PROVIDER_STAGE_ABORT',manualReview:{passed:false}}),{flag:'wx'});
  const originalHash=fileHash(original);accept(cedarResult,1);
  writeFileSync(resolve(directory,retryMarkerName),JSON.stringify({authorizedCase:1,result:cedarResult,retryOf:{sha256:originalHash}}),{flag:'wx'});
  check(()=>assert.throws(()=>continuationOutput(1,directory)));
  check(()=>assert.throws(()=>continuationOutput(3,directory)));
  check(()=>assert.throws(()=>caseOutput(2,false,directory)));
  const plan=continuationOutput(2,directory);
  check(()=>assert.equal(existsSync(plan.destination),false));
  check(()=>assert.notEqual(plan.destination,continuationOutput(2,directory).destination));
  claimContinuationOutput(directory,plan);
  check(()=>assert.throws(()=>continuationOutput(2,directory)));
  check(()=>assert.throws(()=>claimContinuationOutput(directory,plan)));
  check(()=>assert.throws(()=>continuationOutput(3,directory)));
  check(()=>assert.throws(()=>continuationOutput(4,directory)));
  accept(plan.destination,2);
  const third=continuationOutput(3,directory);claimContinuationOutput(directory,third);
  check(()=>assert.throws(()=>continuationOutput(3,directory)));
  check(()=>assert.throws(()=>claimContinuationOutput(directory,third)));
  check(()=>assert.throws(()=>continuationOutput(4,directory)));
  accept(third.destination,3);
  const fourth=continuationOutput(4,directory);claimContinuationOutput(directory,fourth);
  check(()=>assert.throws(()=>continuationOutput(4,directory)));
  check(()=>assert.throws(()=>claimContinuationOutput(directory,fourth)));
  check(()=>assert.equal(fileHash(original),originalHash));
  check(()=>assert.throws(()=>caseOutput(2,false,directory)));
  check(()=>assert.equal(requestFits(.07617027,.24,.35),true));
  check(()=>assert.equal(requestFits(.07617027,.26,.35),false));
  check(()=>assert.equal(requestFits(.09,.24,.35),true));
  check(()=>assert.equal(requestFits(.09000001,.24,.35),false));
  check(()=>assert.equal(requestFits(NaN,.24,.35),false));
  check(()=>assert.equal(currentLocalBudgetCap(),.50));
  check(()=>assert.equal(requestFits(.07627087,.26,currentLocalBudgetCap()),true));
  check(()=>assert.equal(requestFits(.22,.26,currentLocalBudgetCap()),true));
  check(()=>assert.equal(requestFits(.22000001,.26,currentLocalBudgetCap()),false));
  // Tampering cannot turn a prior failure or a changed raw result into acceptance.
  const secondReview=plan.destination.replace(/\.json$/u,'-manual-review.json');
  writeFileSync(secondReview,JSON.stringify({passed:false,result:plan.destination,rawEvidenceSha256:fileHash(plan.destination)}));
  check(()=>assert.throws(()=>continuationOutput(3,directory)));
  writeFileSync(cedarResult,JSON.stringify({changed:true}));
  check(()=>assert.throws(()=>continuationOutput(2,directory)));
  check(()=>assert.throws(()=>continuationOutput(4,directory)));
  console.log(JSON.stringify({offline:true,checks,passed:checks,providerRequests:0}));
 }finally{rmSync(directory,{recursive:true,force:true});}
 process.exit(0);
}
if(process.argv.includes('--retry-preflight')){
 const directory=mkdtempSync(resolve(tmpdir(),'odinlink-cedar-retry-'));let checks=0;
 const check=(fn:()=>void)=>{fn();checks++;};
 try{
  check(()=>assert.equal(caseOutput(1,false,directory),resolve(directory,'case-1.json')));
  check(()=>assert.throws(()=>caseOutput(1,true,directory)));
  const original=JSON.stringify({spec:gatePlan[0],stopReason:'PROVIDER_STAGE_ABORT',manualReview:{passed:false}});
  writeFileSync(resolve(directory,'case-1.json'),original,{flag:'wx'});
  check(()=>assert.throws(()=>caseOutput(1,false,directory)));
  for(const id of [2,3,4]){
   check(()=>assert.throws(()=>caseOutput(id,true,directory)));
   // Preserve the original sequential gate; prepare failures for each next case.
   check(()=>assert.throws(()=>caseOutput(id,false,directory)));
   writeFileSync(resolve(directory,`case-${id}.json`),original,{flag:'wx'});
  }
  const output=caseOutput(1,true,directory);
  check(()=>assert.notEqual(output,caseOutput(1,true,directory)));
  check(()=>assert.equal(existsSync(output),false));
  claimRetryOutput(directory,output,{synthetic:true});
  check(()=>assert.throws(()=>caseOutput(1,true,directory)));
  check(()=>assert.throws(()=>claimRetryOutput(directory,output,{synthetic:true})));
  check(()=>assert.equal(readFileSync(resolve(directory,'case-1.json'),'utf8'),original));
  check(()=>assert.throws(()=>writeFileSync(output,'overwrite',{flag:'wx'})));
  check(()=>assert.equal(readFileSync(output,'utf8'),'{}'));
  check(()=>assert.equal(requestFits(.07492467,.24,.35),true));
  check(()=>assert.equal(requestFits(.09492467,.24,.35),false));
  check(()=>assert.equal(requestFits(.09,.24,.35),true));
  check(()=>assert.equal(requestFits(.09000001,.24,.35),false));
  for(const values of [[NaN,.24,.35],[-1,.24,.35],[.07,Infinity,.35],[.07,.24,-.35]])check(()=>assert.equal(requestFits(...values as [number,number,number]),false));
  console.log(JSON.stringify({offline:true,checks,passed:checks,providerRequests:0}));
 }finally{rmSync(directory,{recursive:true,force:true});}
 process.exit(0);
}
if(process.argv.includes('--plan')){console.log(JSON.stringify(gatePlan,null,2));process.exit(0);}
const selected=Number(process.argv.find(v=>v.startsWith('--case='))?.split('=')[1]);
const spec=gatePlan.find(c=>c.id===selected);if(!spec)throw Error('Exactly one --case=1..4 is required');
const retry=process.argv.includes('--retry-cedar-case-1');
const continuation=process.argv.includes('--continue-reviewed-cedar-cases-2-4');
const catalogRetry=process.argv.includes('--retry-catalog-case-2');
const mixedSingle=process.argv.includes('--single-mixed-case-3');
const mixedRetry=process.argv.includes('--retry-mixed-case-3');
const mixedFinal=process.argv.includes('--final-bounded-mixed-case-3');
const mixedSemantic=process.argv.includes('--semantic-revalidation-case-3');
if([retry,continuation,catalogRetry,mixedSingle,mixedRetry,mixedFinal,mixedSemantic].filter(Boolean).length>1)throw Error('Retry and continuation modes cannot be combined');
const mixedSemanticPlan=mixedSemantic?case3SemanticOutput(selected,root):undefined;
const mixedFinalPlan=mixedFinal?case3FinalOutput(selected,root):undefined;
const mixedRetryPlan=mixedRetry?case3RetryOutput(selected,root):undefined;
const mixedSinglePlan=mixedSingle?case3SingleOutput(selected,root):undefined;
const catalogRetryPlan=catalogRetry?case2RetryOutput(selected,root):undefined;
const continuationPlan=continuation?continuationOutput(selected,root):undefined;
const destination=mixedSemanticPlan?.destination??mixedFinalPlan?.destination??mixedRetryPlan?.destination??mixedSinglePlan?.destination??catalogRetryPlan?.destination??continuationPlan?.destination??caseOutput(selected,retry,root);
const authorization=JSON.parse(readFileSync(resolve(root,'authorization.json'),'utf8'));
if(authorization.localCapUsd!==.35)throw Error('Historical gate authorization changed');
const cap=currentLocalBudgetCap(),reservePerCall=.02,ledgerPath=resolve('docs/validation/shared-core-2026-10-22/source-aware-usage.json');
const ledger=JSON.parse(readFileSync(ledgerPath,'utf8'));
if(!Array.isArray(ledger.calls)||!requestFits(ledger.estimatedUsd,ledger.unmeteredReserveUsd,cap))throw Error('Insufficient reserved budget for safe next request');
const keyFile=process.env.ODINLINK_P0_KEY_FILE;if(!keyFile)throw Error('Dedicated credential file required');
const key=parse(readFileSync(keyFile)).OPENAI_API_KEY;if(!key)throw Error('Dedicated credential is unavailable');
process.env.OPENAI_API_KEY=key;process.env.DOTENV_CONFIG_PATH='/dev/null';incidentFlags();delete process.env.ODINLINK_SHARED_PG;
for(const name of Object.keys(process.env))if(/SUPABASE|^PG(?:HOST|PORT|USER|PASSWORD|DATABASE|SERVICE)|^DATABASE_URL$/u.test(name))delete process.env[name];
const lock=resolve(root,'provider.lock');const fd=openSync(lock,'wx');closeSync(fd);
const retryOf=retry?{path:resolve(root,'case-1.json'),sha256:createHash('sha256').update(readFileSync(resolve(root,'case-1.json'))).digest('hex')}:undefined;
if(retry){
 try{claimRetryOutput(root,destination,{authorizedCase:1,result:destination,retryOf,ledgerSha256Before:createHash('sha256').update(readFileSync(ledgerPath)).digest('hex')});}
 catch(error){unlinkSync(lock);throw error;}
}
if(continuationPlan){
 try{claimContinuationOutput(root,continuationPlan);}
 catch(error){unlinkSync(lock);throw error;}
}
if(catalogRetryPlan){
 try{claimCase2RetryOutput(root,catalogRetryPlan);}
 catch(error){unlinkSync(lock);throw error;}
}
if(mixedSinglePlan){
 try{claimCase3SingleOutput(root,mixedSinglePlan);}
 catch(error){unlinkSync(lock);throw error;}
}
if(mixedRetryPlan){
 try{claimCase3RetryOutput(root,mixedRetryPlan);}
 catch(error){unlinkSync(lock);throw error;}
}
if(mixedFinalPlan){
 try{claimCase3FinalOutput(root,mixedFinalPlan);}
 catch(error){unlinkSync(lock);throw error;}
}
if(mixedSemanticPlan){
 try{claimCase3SemanticOutput(root,mixedSemanticPlan);}
 catch(error){unlinkSync(lock);throw error;}
}
const realFetch=globalThis.fetch,originalConsole={...console},startBudget={estimatedUsd:ledger.estimatedUsd,unmeteredReserveUsd:ledger.unmeteredReserveUsd,calls:ledger.calls.length};
const calls:any[]=[],retrieval:any[]=[],diagnostics:any[]=[],decisions:any[]=[],replies:string[]=[];
let stopReason:string|null=null,caseStarted=performance.now(),stage='setup',b:any,cleanup=()=>{},actions=0;
const deadline=new AbortController();const watchdog=setTimeout(()=>{stopReason||='HARNESS_CASE_DEADLINE';deadline.abort();},45000);
const safe=(value:unknown)=>{const text=JSON.stringify(value);if(text.includes(key)||/Bearer\s+\S+/u.test(text))throw Error('Sensitive diagnostic output rejected');return text;};
const saveLedger=()=>writeFileSync(ledgerPath,JSON.stringify(ledger,null,2));
const save=()=>writeFileSync(destination,safe({spec,retryOf,mixedCase3SemanticRevalidation:mixedSemanticPlan,mixedCase3Prerequisites:(mixedSemanticPlan||mixedFinalPlan||mixedRetryPlan||mixedSinglePlan)?.prerequisites,mixedCase3FinalRetryOf:mixedFinalPlan?.retryOf,mixedCase3RetryOf:mixedRetryPlan?.retryOf,catalogRetryOf:catalogRetryPlan?.retryOf,continuationAuthorization:continuationPlan?resolve(root,continuationMarkerName):undefined,channel:'whatsapp',language:'en',provider:'real OpenAI',model:'gpt-5.6-luna',outbound:'intercepted',database:'in-memory canonical synthetic fixtures; actual lexical and real embedding retrieval',asyncKnowledge:false,smartWaiting:false,stopReason,stage,elapsedMs:Math.round(performance.now()-caseStarted),calls,retrieval,diagnostics,decisions,replies,forbiddenActions:actions,budget:{capUsd:cap,before:startBudget,after:{estimatedUsd:ledger.estimatedUsd,unmeteredReserveUsd:ledger.unmeteredReserveUsd,reservedTotalUsd:ledger.estimatedUsd+ledger.unmeteredReserveUsd},incrementalEstimatedUsd:ledger.estimatedUsd-startBudget.estimatedUsd},manualReview:{passed:null,status:'PENDING'}}));
for(const method of ['log','info','warn','error']as const)console[method]=()=>{};
globalThis.fetch=async(input,options)=>{
 const url=new URL(String(input));
 if(url.origin==='https://api.openai.com'&&['/v1/responses','/v1/embeddings'].includes(url.pathname)){
  if(stopReason||deadline.signal.aborted)throw Error('Gate stopped');
  if(!requestFits(ledger.estimatedUsd,ledger.unmeteredReserveUsd,cap)){stopReason='INSUFFICIENT_NEXT_REQUEST_RESERVE';save();throw Error('Reserved local budget exhausted');}
  const body=JSON.parse(String(options?.body));if(!['gpt-5.6-luna','text-embedding-3-small'].includes(body.model))throw Error('Unexpected model');
  // Diagnostic-only billing ceiling, not a production setting. If it truncates,
  // the case fails. Never change reasoning, prompts, evidence or stage deadlines.
  if(url.pathname==='/v1/responses')body.max_output_tokens=Math.min(body.max_output_tokens??8192,8192);
  const requestText=JSON.stringify(body),inputTokenUpperBound=Buffer.byteLength(requestText,'utf8')+2048;
  const conservativeCeilingUsd=(inputTokenUpperBound*.25+(body.max_output_tokens??0)*1.2)/1e6;
  if(conservativeCeilingUsd>reservePerCall){stopReason='REQUEST_EXCEEDS_RESERVED_COST_CEILING';save();throw Error('Request too large for reserved budget');}
  const kind=url.pathname==='/v1/embeddings'?'embedding':body.instructions?.includes('UNIT EXTRACTION')?'extraction':body.instructions?.includes('BATCH ENTAILMENT')?'verification':body.instructions?.includes('query planner')?'planning':'other';
  let payload:any;try{payload=JSON.parse(body.input?.[0]?.content);}catch{}
  if(['extraction','verification'].includes(kind)&&payload?.evidence?.some((e:any)=>e.businessId!==spec.businessId)){stopReason='EVIDENCE_TENANT_MISMATCH';save();throw Error('Foreign tenant evidence');}
  const call:any={kind,model:body.model,startedAfterCaseMs:Math.round(performance.now()-caseStarted),request:body,inputTokenUpperBound,conservativeCeilingUsd};
  safe(call);calls.push(call);ledger.unmeteredReserveUsd+=reservePerCall;saveLedger();save();const started=performance.now();
  try{
   const response=await realFetch(input,{...options,body:requestText,signal:options?.signal?AbortSignal.any([options.signal,deadline.signal]):deadline.signal});
   const result=await response.clone().json();
   const usage=result.usage;const text=String(result.output_text||result.output?.filter((i:any)=>i.type==='message').flatMap((i:any)=>i.content||[]).filter((i:any)=>i.type==='output_text').map((i:any)=>i.text).join('')||'');
   Object.assign(call,{durationMs:Math.round(performance.now()-started),status:response.status,responseStatus:result.status,outputText:text,usage,providerError:result.error?{type:result.error.type,code:result.error.code}:undefined,incompleteDetails:result.incomplete_details});
   if(usage&&Number.isSafeInteger(usage.input_tokens??usage.prompt_tokens)&&Number.isSafeInteger(usage.output_tokens??usage.completion_tokens??0)){
    const inputTokens=usage.input_tokens??usage.prompt_tokens,outputTokens=usage.output_tokens??usage.completion_tokens??0,cached=usage.input_tokens_details?.cached_tokens??0,written=usage.input_tokens_details?.cache_write_tokens??0;
    const estimatedUsd=((inputTokens-cached-written)*.2+cached*.02+written*.25+outputTokens*1.2)/1e6;
    ledger.unmeteredReserveUsd-=reservePerCall;ledger.estimatedUsd+=estimatedUsd;
    ledger.calls.push({profile:'source-aware-authorized-four-case',case:spec.id,model:body.model,inputTokens,outputTokens,cached,estimatedUsd});saveLedger();call.estimatedUsd=estimatedUsd;
    if(estimatedUsd>reservePerCall||ledger.estimatedUsd+ledger.unmeteredReserveUsd>cap+1e-12)stopReason='COST_CEILING_VIOLATION';
   }else call.unknownReserveRetainedUsd=reservePerCall;
   if(!response.ok)stopReason||='PROVIDER_HTTP_FAILURE';
   if(result.status==='incomplete')stopReason||='PROVIDER_TRUNCATED';
   save();return response;
  }catch(error){call.durationMs=Math.round(performance.now()-started);call.errorType=error instanceof Error?error.name:'unknown';call.unknownReserveRetainedUsd=reservePerCall;stopReason||=options?.signal?.aborted?'PROVIDER_STAGE_ABORT':'PROVIDER_TRANSPORT_FAILURE';save();throw error;}
 }
 if(stopReason&&deadline.signal.aborted)throw Error('No delivery after harness expiry');
 replies.push(interceptedIncidentSend(input,options));save();
 return new Response(JSON.stringify({ok:true,result:{message_id:replies.length},messages:[{id:'synthetic'}],message_id:'synthetic'}),{status:200});
};
try{
 const imported=await import('../server');b=imported.priority1hUnifiedEngineTestBoundary;
 const corpus=await sharedCorpus(true);cleanup=corpus.cleanup;const {service,storage}=corpus;
 for(const [i,doc]of cedar.documents.entries()){
  const id=`cedar-${i}`,metadata={segments:[{start:0,end:doc.text.length,section:'Text'}]};
  await storage.create({id,businessId:88,type:'document',title:doc.sourceId,status:'ready',content:doc.text,metadata,createdAt:'2026',updatedAt:'2026'});
  await storage.replaceChunks(88,id,[{chunkIndex:0,content:doc.text,metadata:{source:'document',section:'Text'}}]);
 }
 if(spec.businessId===88)Object.assign(incidentConfig,{id:88,businessId:88,businessName:cedar.businessName,services:cedar.services,defaultBookingService:'Remote Assessment',language:'en',address:'Synthetic Cedar Lane'});
 else incidentConfig.language='en';
 const sources=await storage.list(spec.businessId);retrieval.push({phase:'canonical-corpus',businessId:spec.businessId,sources});
 const forbidden=async()=>{actions++;stopReason='UNAUTHORIZED_ACTION_ATTEMPT';save();throw Error('Information gate cannot operate booking/calendar/notifications');};
 b.reset();b.configure({postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:1000}),
  knowledgeRetrievalDiagnostic:(e:any)=>{retrieval.push({phase:'retrieval-diagnostic',businessId:spec.businessId,detail:e});save();},
  knowledgeSearch:async(id:number,q:string,limit:number)=>{if(id!==spec.businessId)throw Error('Unexpected retrieval tenant');const matches=await service.search(id,q,limit);retrieval.push({phase:'lexical',businessId:id,query:q,matches});save();return matches;},
  knowledgeSourceLanguages:(id:number)=>service.sourceLanguageHints(id),
  completeKnowledgeCorpus:(id:number,matches:any)=>service.completeSmallCorpus(id,matches),
  semanticKnowledgeSearchQueries:async(id:number,queries:any,limit:number,options:any)=>{if(id!==spec.businessId)throw Error('Unexpected semantic tenant');const matches=await service.semanticSearchQueries(id,queries,limit,options);retrieval.push({phase:'semantic',businessId:id,queries,matches});save();return matches;},
  validateKnowledgeMatches:async(id:number,matches:any)=>{const valid=await service.validateMatches(id,matches,{strictSources:true,captureRevision:true});retrieval.push({phase:'freshness',businessId:id,matches:valid});save();return valid;},
  knowledgeServiceCatalog:async(id:number)=>{if(id!==spec.businessId)throw Error('Unexpected catalog tenant');return incidentConfig.services;},
  evidenceFirstDiagnostic:(e:any)=>{diagnostics.push(e);save();},evidenceFirstDecisionDiagnostic:(e:any)=>{decisions.push(e);save();},
  calendarAdapter:{getCalendarId:()=> 'synthetic',getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden,cancelAppointment:forbidden,updateAppointment:forbidden},recordAppointment:forbidden,cancelAppointmentRow:forbidden,updateAppointmentRow:forbidden});
 stage='native-inbound';caseStarted=performance.now();save();await incidentInbound(b,'whatsapp',spec.question);
 stage='manual-review-required';if(replies.length!==1)stopReason||='MISSING_OR_DUPLICATE_REPLY';save();
}catch(error){stopReason||='CASE_EXECUTION_FAILURE';stage='stopped';save();}
finally{clearTimeout(watchdog);deadline.abort();globalThis.fetch=realFetch;Object.assign(console,originalConsole);b?.reset();cleanup();unlinkSync(lock);save();console.log(JSON.stringify({case:spec.id,stopReason,calls:calls.length,replies:replies.length,elapsedMs:Math.round(performance.now()-caseStarted),result:destination}));}
