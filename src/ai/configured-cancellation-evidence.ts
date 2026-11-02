import { createHash } from 'node:crypto';
import type { Evidence } from './business-information-answer-plan';
import { captureCancellationSettings, cancellationInformationEvidence } from './cancellation-information';

const columns = {
  allowCancellation: 'allow_cancellation', cancellationDeadlineMinutes: 'cancellation_deadline_minutes',
  cancellationFeeEnabled: 'cancellation_fee_enabled', cancellationFeeAmount: 'cancellation_fee_amount',
  cancellationFeeCurrency: 'cancellation_fee_currency',
} as const;
const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const tenantId = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value :
  typeof value === 'string' && /^[1-9]\d*$/u.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;

/** Canonicalize only the existing presence-aware information contract. Normalized
 * operational defaults are never evidence. Reject malformed/stale captured
 * records and conflicting tenant aliases rather than selecting an alias. */
function canonicalSettings(businessId: number, config: unknown) {
  if (!Number.isSafeInteger(businessId) || businessId <= 0 || !record(config)) return null;
  const ids = ['id', 'businessRecordId', 'business_id'].filter(key => owns(config, key));
  if (!ids.length || ids.some(key => tenantId(config[key]) !== businessId)) return null;
  const captured = captureCancellationSettings(config), raw: Record<string, unknown> = { id: businessId };
  if (captured.businessId !== String(businessId)) return null;
  for (const [key, column] of Object.entries(columns)) {
    const field = captured.fields[key as keyof typeof columns];
    if (!record(field) || !['missing', 'null', 'invalid', 'valid'].includes(field.presence)) return null;
    if (field.presence !== 'valid' && owns(field, 'value')) return null;
    if (field.presence === 'valid') raw[column] = field.value;
    else if (field.presence === 'null') raw[column] = null;
    else if (field.presence === 'invalid') raw[column] = '?';
    const canonical = captureCancellationSettings({ id: businessId, [column]: raw[column] }).fields[key as keyof typeof columns];
    if (canonical.presence !== field.presence || !Object.is(canonical.value, field.value)) return null;
    // Raw columns, when present, must agree with retained presence evidence.
    // Valid captured values must also agree with their normalized runtime alias.
    for (const alias of [column, ...(field.presence === 'valid' ? [key] : [])]) if (owns(config, alias)) {
      const other = captureCancellationSettings({ id: businessId, [column]: config[alias] }).fields[key as keyof typeof columns];
      if (other.presence !== field.presence || !Object.is(other.value, field.value)) return null;
    }
  }
  return { raw, captured: captureCancellationSettings(raw) };
}

/** Backend evidence adapter only; never action authority or a customer reply.
 * Stable tenant/source identity, content-addressed revision (including presence
 * and inactive raw settings), and allowlisted exact citable statements. */
export function configuredCancellationEvidence(businessId: number, config: unknown): Evidence | null {
  const settings = canonicalSettings(businessId, config);
  if (!settings) return null;
  const projection = cancellationInformationEvidence(settings.raw);
  if (!projection) return null;
  const { automaticCancellationEnabled, lateFeeEnabled, freeCancellationDeadlineMinutes, lateFeeAmount, lateFeeCurrency } = projection;
  const facts = {
    ...(automaticCancellationEnabled !== undefined ? { automaticCancellationEnabled } : {}),
    ...(lateFeeEnabled !== undefined ? { lateFeeEnabled } : {}),
    ...(freeCancellationDeadlineMinutes !== undefined ? { freeCancellationDeadlineMinutes, lateFeeAmount, lateFeeCurrency } : {}),
  };
  const statements = [
    ...(automaticCancellationEnabled !== undefined ? [`Automatic appointment cancellation through chat is ${automaticCancellationEnabled ? 'enabled' : 'disabled'} in the business configuration.`] : []),
    ...(lateFeeEnabled === false ? ['The optional late cancellation fee is disabled in the business configuration.'] : []),
    ...(lateFeeEnabled === true ? [`The configured optional late cancellation fee is ${lateFeeAmount} ${lateFeeCurrency}.`,
      `Under this configured optional late-fee policy, free cancellation is available at least ${freeCancellationDeadlineMinutes} minutes before the appointment.`] : []),
  ];
  // No raw inactive deadline or null cutoff in the citable text. Omission is
  // never evidence of no notice requirement, universal permission or no fees.
  const text = JSON.stringify({ authority: 'business_cancellation_configuration', contractVersion: 1,
    scope: 'Chat automation settings and this optional late fee only; business-wide permission, other fees and mandatory advance notice are outside this source.', facts, statements });
  const version = createHash('sha256').update(JSON.stringify([1, businessId, settings.captured, text])).digest('hex');
  return Object.freeze({ id: `configured-cancellation:${businessId}`, businessId,
    sourceId: `business-cancellation-configuration:${businessId}`, chunkId: version, version, text });
}

/** The caller supplies an authoritative tenant-scoped read, under its existing
 * Knowledge deadline/abort owner. No database/provider access or fallback here.
 * Revalidation can only return the original frozen item or withdraw it forever
 * for this bridge instance. Merge documents using their independent validator. */
export function createCancellationEvidenceBridge(businessId: number, config: unknown,
  readCurrent: (businessId: number, signal?: AbortSignal) => Promise<unknown>) {
  const item = configuredCancellationEvidence(businessId, config);
  const evidence: readonly Evidence[] = Object.freeze(item ? [item] : []);
  let withdrawn = !item;
  return Object.freeze({ evidence, revalidate: async (signal?: AbortSignal): Promise<readonly Evidence[]> => {
    if (withdrawn) return [];
    try {
      signal?.throwIfAborted();
      const current = configuredCancellationEvidence(businessId, await readCurrent(businessId, signal));
      signal?.throwIfAborted();
      if (!current || current.version !== item!.version || JSON.stringify(current) !== JSON.stringify(item)) withdrawn = true;
    } catch { withdrawn = true; }
    return withdrawn ? [] : evidence;
  } });
}
