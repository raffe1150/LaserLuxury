import { sha256 } from './hash';

/** @internal */
export function createIdempotencyKey(input: {
  businessId: number;
  eventName: string;
  source: string;
  sourceEventId: string | number;
}): string {
  if (!Number.isSafeInteger(input.businessId) || input.businessId <= 0) {
    throw new Error('Idempotency key requires a positive safe business ID.');
  }

  const parts = [
    String(input.businessId),
    input.eventName.trim(),
    input.source.trim(),
    String(input.sourceEventId).trim(),
  ];

  if (parts.some((part) => !part)) {
    throw new Error('Idempotency key components must be non-empty.');
  }

  const encoded = parts
    .map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`)
    .join('|');

  return `v1:${sha256(`odinlink:analytics:idempotency:v1|${encoded}`)}`;
}
