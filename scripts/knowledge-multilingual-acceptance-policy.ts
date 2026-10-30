/** Preparation-only contracts. This module has no provider, credential or network
 * entry point. A separately reviewed executor is required before real tests. */
import {readFileSync,writeFileSync,existsSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {preliminaryAcceptancePlan} from '../tests/fixtures/multilingual-knowledge-acceptance';
export const preparationRoot='docs/validation/shared-core-2026-10-22/multilingual-acceptance-preparation-20261024';
export const sharedProviderLockPath=resolve('docs/validation/shared-core-2026-10-22/authorized-four-case-gate/provider.lock');
export function claimProviderLock(path=sharedProviderLockPath){const fd=openSync(path,'wx',0o600);closeSync(fd);return()=>unlinkSync(path);}
export const policyPath=resolve(preparationRoot,'local-budget-cap-20261024-100.json');
export const sha256=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
export const planSha256=sha256(JSON.stringify(preliminaryAcceptancePlan));
export const budgetPolicy=()=>JSON.parse(readFileSync(policyPath,'utf8'));
export type Ledger={calls:unknown[];estimatedUsd:number;unmeteredReserveUsd:number};
export const requestFits=(estimated:number,reserve:number,cap:number,next=.02)=>
 [estimated,reserve,cap,next].every(n=>Number.isFinite(n)&&n>=0)&&estimated+reserve+next<=cap+1e-12;
export function validateLedger(current:Ledger,historical:Ledger){
 if(!Array.isArray(current.calls)||!Array.isArray(historical.calls)||historical.calls.length!==160||current.calls.length<160||
  sha256(JSON.stringify(current.calls.slice(0,160)))!==sha256(JSON.stringify(historical.calls))||
  !Number.isFinite(current.estimatedUsd)||current.estimatedUsd<historical.estimatedUsd||
  !Number.isFinite(current.unmeteredReserveUsd)||current.unmeteredReserveUsd<historical.unmeteredReserveUsd)throw Error('Historical accounting changed');
}
export function admitRequest(ledger:Ledger,requestCeilingUsd:number,policy=budgetPolicy()){
 if(policy.localCapUsd!==1||policy.perRequestReserveUsd!==.02||policy.perRequestCostCeilingUsd!==.02||
  !Number.isFinite(requestCeilingUsd)||requestCeilingUsd<0||requestCeilingUsd>.02)throw Error('Invalid request ceiling or cap policy');
 if(!requestFits(ledger.estimatedUsd,ledger.unmeteredReserveUsd,policy.localCapUsd,policy.perRequestReserveUsd))throw Error('Insufficient request reserve');
 return {reservationUsd:.02,remainingAfterReservationUsd:1-ledger.estimatedUsd-ledger.unmeteredReserveUsd-.02};
}
export function safeDiagnostic(value:unknown,secrets:readonly string[]=[]){
 const text=JSON.stringify(value);
 if(!text||secrets.some(s=>s&&text.includes(s))||/Bearer\s+\S+|sk-[\w-]+|authorization["']?\s*:/iu.test(text))throw Error('Sensitive diagnostic rejected');
 return text;
}
export function classifyNetwork(input:string,method:string,model?:string){
 const url=new URL(input);
 if(url.username||url.password||url.search||url.hash)throw Error('Unexpected URL components');
 if(url.origin==='https://api.openai.com'&&method==='POST'&&
  (url.pathname==='/v1/responses'&&model==='gpt-5.6-luna'||url.pathname==='/v1/embeddings'&&model==='text-embedding-3-small'))return 'provider';
 if(method==='POST'&&url.protocol==='https:'&&['api.telegram.org','graph.facebook.com','graph.instagram.com'].includes(url.hostname))return 'intercept-only';
 throw Error('Network destination denied');
}
export type Binding={planSha256:string;candidateSha256:string;sourceSnapshotSha256:string};
export function assertCaseAuthorization(auth:any,caseId:string,binding:Binding){
 if(!preliminaryAcceptancePlan.some(c=>c.id===caseId)||auth?.providerExecutionAuthorized!==true||auth?.scope!=='one-preliminary-case-only'||auth?.caseId!==caseId||
  auth?.planSha256!==planSha256||binding.planSha256!==planSha256||auth?.candidateSha256!==binding.candidateSha256||
  !/^[a-f0-9]{64}$/u.test(binding.candidateSha256)||auth?.sourceSnapshotSha256!==binding.sourceSnapshotSha256||
  !/^[a-f0-9]{64}$/u.test(binding.sourceSnapshotSha256)||auth?.localCapUsd!==1||auth?.automaticRetry!==false)throw Error('Separate case-specific execution authorization required');
}
export function claimCase(directory:string,caseId:string,auth:any,binding:Binding){
 assertCaseAuthorization(auth,caseId,binding);
 if(existsSync(resolve(directory,'first-failure-stop.json')))throw Error('Gate stopped after first failure');
 const index=preliminaryAcceptancePlan.findIndex(c=>c.id===caseId);
 for(const prior of preliminaryAcceptancePlan.slice(0,index)){
  const resultPath=resolve(directory,`${prior.id}.result.json`),resultBytes=readFileSync(resultPath),result=JSON.parse(resultBytes.toString());
  const review=JSON.parse(readFileSync(resolve(directory,`${prior.id}.manual-review.json`),'utf8'));
  if(result.caseId!==prior.id||result.stopReason!==null||result.forbiddenActions!==0||result.outbound!=='intercepted'||result.provider!=='real OpenAI'||result.binding?.planSha256!==binding.planSha256||result.binding?.candidateSha256!==binding.candidateSha256||
   result.binding?.sourceSnapshotSha256!==binding.sourceSnapshotSha256||review.passed!==true||review.reviewerKind!=='human'||review.rawResultSha256!==sha256(resultBytes)||
   !Array.isArray(result.units)||!result.units.length||!Array.isArray(review.claims)||review.claims.length!==result.units.length||
   result.units.some((u:any)=>!review.claims.some((c:any)=>c.unitId===u.id&&c.text===u.text))||review.claims.some((c:any)=>c.correct!==true||c.sourceBound!==true||c.conditionsPreserved!==true)||
   prior.obligations.some(id=>!review.obligations?.some((o:any)=>o.id===id&&o.passed===true)))throw Error('Previous case lacks complete bound manual semantic review');
 }
 // This persistent marker is consumed before an attempted execution and survives
 // crashes/output collisions. No retry command is supplied by this preparation.
 writeFileSync(resolve(directory,`${caseId}.consumed.json`),safeDiagnostic({caseId,binding,executionApproval:auth}),{flag:'wx',mode:0o600});
 const path=resolve(directory,`${caseId}.result.json`);
 writeFileSync(path,'{}',{flag:'wx',mode:0o600});return path;
}
export function latchFailure(directory:string,caseId:string,reason:string){
 if(!existsSync(resolve(directory,'first-failure-stop.json')))writeFileSync(resolve(directory,'first-failure-stop.json'),safeDiagnostic({caseId,reason}),{flag:'wx',mode:0o600});
}
export const captureRequirements={
 case:['originalQuestion','language','channel','sourceSnapshotSha256','candidateSha256','ledgerBefore','ledgerAfter','exactReply','coverage','manualReview'],
 eachCall:['model','stage','requestWithoutHeaders','requestSha256','sourceEvidence','extractedPropositions','verifierInput','verifierOutput','durationMs','usage','estimatedUsd','unknownReservationUsd'],
 source:['businessId','sourceId','chunkId','version','exactQuote','currentAtVerification','currentAtPublication'],
 manual:['everyMaterialClaim','allRequestedObligations','modality','conditions','negation','quantifiers','scope','languageNaturalness','unknowns','absenceOfUnauthorizedActions'],
 limits:{requestReserveUsd:.02,requestCeilingUsd:.02,caseWatchdogMs:45000,maximumRequestsPerCase:7,providerAutomaticRetries:0,plannerAndOptionalSemanticMs:2500,foregroundMs:20000},
} as const;
