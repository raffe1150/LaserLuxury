import { writeFileSync } from 'node:fs';
import { evaluateResponses } from './response-eval';
import { evaluateSemantics } from './semantic-eval';
import { LIVE_VALIDATION_PLAN } from './live-plan';

const output = process.argv[2];
if (!output) throw new Error('usage: run-report.ts <new-output.json>');
const result = { schema: 'odinlink-brain-phase5-offline-v1', semantics: await evaluateSemantics(),
  responses: await evaluateResponses(), independentNativeNaturalnessRating: 'NOT_RUN',
  liveValidationProposal: LIVE_VALIDATION_PLAN, providerCalls: 0, spendUsd: 0 };
writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
