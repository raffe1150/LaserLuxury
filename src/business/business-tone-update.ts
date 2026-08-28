import {
  validateBusinessToneConfig,
  type BusinessToneConfig,
} from '../ai/tone-controls';

export const BUSINESS_TONE_UPDATE_KEYS = [
  'ai_tone_config',
  'toneConfig',
  'tone_config',
] as const;

/**
 * Adds the canonical JSONB field to the existing business update payload.
 * Authorization and tenant scoping remain owned by the existing PUT route.
 */
export function applyBusinessToneConfigUpdate(
  body: unknown,
  payload: Record<string, unknown>,
): BusinessToneConfig | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;

  const input = body as Record<string, unknown>;
  const requestKey = BUSINESS_TONE_UPDATE_KEYS.find((key) =>
    Object.prototype.hasOwnProperty.call(input, key)
  );

  if (!requestKey) return undefined;

  const toneConfig = validateBusinessToneConfig(input[requestKey]);
  payload.ai_tone_config = toneConfig;
  return toneConfig;
}
