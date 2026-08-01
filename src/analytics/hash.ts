import crypto from 'node:crypto';

const CUSTOMER_KEY_DOMAIN = 'analytics-customer-key:v1';
const MINIMUM_HASH_SECRET_BYTES = 32;

function encodeParts(parts: readonly string[]): string {
  return parts.map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`).join('|');
}

/** @internal */
export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function reportCustomerKeyFailure(reason: string): null {
  console.error('[Analytics] Customer key generation unavailable.', {
    reason,
  });
  return null;
}

/**
 * Creates a tenant-scoped pseudonymous customer key without returning or
 * logging any raw identifier.
 *
 * @internal
 */
export function createCustomerKey(input: {
  businessId: number;
  identifier: string;
}): string | null {
  try {
    if (!Number.isSafeInteger(input.businessId) || input.businessId <= 0) {
      return reportCustomerKeyFailure('invalid_business_id');
    }

    if (typeof input.identifier !== 'string') {
      return reportCustomerKeyFailure('invalid_identifier');
    }

    const normalizedIdentifier = input.identifier.trim().normalize('NFKC');
    if (!normalizedIdentifier) {
      return reportCustomerKeyFailure('invalid_identifier');
    }

    const secret = process.env.ANALYTICS_HASH_SECRET;
    if (
      typeof secret !== 'string'
      || Buffer.byteLength(secret, 'utf8') < MINIMUM_HASH_SECRET_BYTES
    ) {
      return reportCustomerKeyFailure('missing_or_invalid_hash_secret');
    }

    const signedInput = encodeParts([
      CUSTOMER_KEY_DOMAIN,
      String(input.businessId),
      normalizedIdentifier,
    ]);

    return crypto
      .createHmac('sha256', secret)
      .update(signedInput, 'utf8')
      .digest('hex');
  } catch {
    return reportCustomerKeyFailure('unexpected_hash_error');
  }
}
