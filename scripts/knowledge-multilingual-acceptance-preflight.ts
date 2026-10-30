/** Offline preparation only: no credential loader or provider transport. */
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {preliminaryAcceptancePlan,laterExpansionPlan,documentaryQuotes,documentaryStatements,obligations} from '../tests/fixtures/multilingual-knowledge-acceptance';
import {preparationRoot,budgetPolicy,validateLedger,admitRequest,sha256,planSha256,captureRequirements,sharedProviderLockPath} from './knowledge-multilingual-acceptance-policy';
import {sharedCorpus} from '../tests/helpers/shared-core-incident';
import {incidentConfig} from '../tests/helpers/p0-incident-knowledge';
import {businessInformationTopics,isBusinessInformationQuestion,isExplicitBusinessActionRequest} from '../src/ai/business-information';
import {documentKnowledgeTopicsEligible} from '../src/ai/knowledge-planning';
import {serviceRelationshipUnresolved} from '../src/ai/source-aware-service-proposal';
process.env.NODE_ENV='test';process.env.DOTENV_CONFIG_PATH='/dev/null';delete process.env.ODINLINK_SHARED_PG;
const policy=budgetPolicy(),ledger=JSON.parse(readFileSync(policy.ledger,'utf8'));assert.equal(sha256(readFileSync(policy.ledger)),policy.historicalLedgerSha256);validateLedger(ledger,ledger);admitRequest(ledger,.02);
const walk=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):e.name.endsWith('.ts')&&!e.name.endsWith('.test.ts')?[join(dir,e.name)]:[]);
const runtimeSources=Object.fromEntries(['server.ts','knowledge.ts',...walk('src')].sort().map(path=>[path,sha256(readFileSync(path))]));
const candidateSha256=sha256(JSON.stringify(runtimeSources)),corpus=await sharedCorpus(false,true);
try{
 const sources=await corpus.storage.list(77),catalog=incidentConfig.services,sourceSnapshotSha256=sha256(JSON.stringify({sources,catalog}));
 const bindings={planSha256,candidateSha256,sourceSnapshotSha256};
 const costs=ledger.calls.map((c:any)=>c.estimatedUsd).sort((a:number,b:number)=>a-b),average=costs.reduce((a:number,b:number)=>a+b,0)/costs.length,p95=costs[Math.floor(.95*(costs.length-1))];
 const plan={phase:'PREPARATION_ONLY',providerExecutionAuthorized:false,providerRequests:0,apiCredentialRead:false,
  fixture:'existing sanitized AdMotion production-document snapshot plus competing TXT; synthetic tenant 77; not live dashboard proof',
  bindings,runtimeSources,sources,catalog,sourceFileSha256:sha256(readFileSync('tests/fixtures/admotion-production-document.json')),
  budget:policy,historicalLedger:{rows:ledger.calls.length,meteredUsd:ledger.estimatedUsd,unknownReserveUsd:ledger.unmeteredReserveUsd,reservedUsd:ledger.estimatedUsd+ledger.unmeteredReserveUsd},
  preliminaryCases:preliminaryAcceptancePlan,laterExpansion:{enabled:false,cases:laterExpansionPlan,languageChannelCombinations:24,primaryCases:72,prerequisite:'All 18 preliminary cases independently reviewed PASS, stable representative repeats, sufficient remaining budget and separate authorization'},
  sourceRubric:{obligations,documentaryQuotes,documentaryStatements},captureRequirements,sharedProviderLockPath,
  exposure:{expectedCallsPerCase:6,maximumCallsPerCase:7,expected18CaseCalls:108,maximum18CaseCalls:126,
   estimated18CaseMeteredAtHistoricalAverageUsd:108*average,estimated18CaseMeteredAtHistoricalP95Usd:108*p95,
   worstCaseFirstCaseReservedUsd:.14,worstCaseAll18ReservedUsd:2.52,maxAdditionalUnmeteredReservations:29,
   estimateOnly:'Historical modeled costs, not newly verified pricing, a promise of completion, or a budget admission override'},
  routingObservations:preliminaryAcceptancePlan.map(spec=>({...spec,topics:businessInformationTopics(spec.question),informationRequest:isBusinessInformationQuestion(spec.question),explicitBusinessAction:isExplicitBusinessActionRequest(spec.question),documentTopicEligibility:documentKnowledgeTopicsEligible(spec.question),
   boundedApplicabilityDetected:spec.family==='B'?serviceRelationshipUnresolved({name:'Video Consultation',evidenceId:'configured-services'},spec.question,[],[]):null})),
  executorStatus:'Preparation contract and native offline rehearsal only. Existing historical real-provider runner remains unchanged and cannot execute these new specs. A separately authorized, minimal single-case transport binding is still required; no multi-case execution command is enabled.',
  firstCaseAuthorizationTemplate:{providerExecutionAuthorized:false,scope:'one-preliminary-case-only',caseId:'A-en',...bindings,localCapUsd:1,automaticRetry:false},
 };
 writeFileSync(resolve(preparationRoot,'prepared-gate-final.json'),JSON.stringify(plan,null,2),{flag:'wx'});
 let questions='# Exact preliminary questions and common semantic obligations\n\nAll questions use the unchanged synthetic AdMotion tenant 77 and six-chunk corpus. This is an 18-case preliminary gate, not full 24-combination coverage.\n\n';
 for(const family of ['A','B','C']as const){questions+=`## Family ${family}\n\nRequired obligations: ${obligations[family].join('; ')}.\n\n`;for(const spec of preliminaryAcceptancePlan.filter(c=>c.family===family))questions+=`### ${spec.sequence}. ${spec.id} — ${spec.channel}\n\n${spec.question}\n\n`;}
 questions+='## Review standard\n\nEvery material proposition must be checked independently against its exact tenant-owned, current evidence span. Conditions, exceptions, recommendations versus requirements, negation, quantities, source actors and configured service identity must survive in the actual customer text. Review all required obligations, naturalness and language; do not approve on keywords or numbers alone.\n\nFamily B must retain an explicit unresolved applicability caveat and must never equate Video Consultation with digital information calls. Family C must acknowledge that the fee is unverified, preserve both supported parking policies, and remain partial. A generic fallback that drops supported facts fails.\n\nThe translations were reviewed against this common rubric during preparation. Scripted offline text is neither a real-provider judgment nor independent human acceptance of a future response.\n';
 writeFileSync(resolve(preparationRoot,'QUESTIONS-final.md'),questions,{flag:'wx'});
 console.log(JSON.stringify({offline:true,providerRequests:0,preliminaryCases:18,expansionCases:72,capUsd:1,remainingHeadroomUsd:1-ledger.estimatedUsd-ledger.unmeteredReserveUsd,bindings}));
}finally{corpus.cleanup();}
