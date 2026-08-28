import {
  normalizeBookingRequest,
  type ConversationInput,
  type NormalizedBookingRequest,
} from '../booking-intelligence';
import type {
  ShadowObservation,
  UnderstandingShadowObserver,
} from './shadow';

export type UnderstandBookingTurnOptions = Readonly<{
  shadowObserver?: UnderstandingShadowObserver | null;
  shadow?: Omit<ShadowObservation, 'legacy'>;
}>;

function understandLegacyBookingTurn(input: ConversationInput): NormalizedBookingRequest {
  return normalizeBookingRequest(input);
}

/**
 * Phase 1 integration seam. It intentionally delegates only to the existing
 * deterministic normalizer and has no provider dependency or side effects.
 */
export function understandBookingTurn(
  input: ConversationInput,
  options: UnderstandBookingTurnOptions = {},
): NormalizedBookingRequest {
  const legacy = understandLegacyBookingTurn(input);
  if (options.shadowObserver && options.shadow?.eligible) {
    try {
      options.shadowObserver.observe({ ...options.shadow, legacy });
    } catch {
      // The observer is side-effect-only and must never change legacy behavior.
    }
  }
  return legacy;
}
