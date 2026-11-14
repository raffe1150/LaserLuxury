import { KNOWLEDGE_SOL_RATES } from '../../knowledge-model-policy';
import { MODEL_INTERPRETATION_LIMITS } from '../semantic/model-adapter';
import { HELD_OUT } from '../phase4/held-out';

/** Planning math only. A future runner must separately verify the rates and
 * cap actual requests before sending. This module has no dispatch function. */
export const LIVE_VALIDATION_PLAN = (() => {
  const attempts = HELD_OUT.reduce((count, scenario) => count + scenario.turns.length + 1, 0);
  const inputTokenReserve = 16_000;
  const outputTokenLimit = MODEL_INTERPRETATION_LIMITS.outputTokens;
  const inputRate = Math.max(KNOWLEDGE_SOL_RATES.input, KNOWLEDGE_SOL_RATES.cacheRead, KNOWLEDGE_SOL_RATES.cacheWrite);
  const outputRate = KNOWLEDGE_SOL_RATES.output;
  const projectedMaximumUsd = attempts * (inputTokenReserve * inputRate + outputTokenLimit * outputRate) / 1_000_000;
  return { model: 'gpt-6.1-sol', rateSnapshot: KNOWLEDGE_SOL_RATES.version, attempts, inputTokenReserve, outputTokenLimit,
    inputRate, outputRate, projectedMaximumUsd, proposedCeilingUsd: Math.ceil(projectedMaximumUsd * 100) / 100,
    authorization: 'OWNER_APPROVAL_REQUIRED', dispatch: 'DISABLED' } as const;
})();
