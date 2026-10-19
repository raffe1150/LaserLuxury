import { snapshot, type Acceptance, type KnowledgeScope } from './knowledge-lifecycle';

/** Trusted only when captured AFTER native webhook authentication/account routing.
 * This is ordering evidence, not authentication, a recipient or mutation authority.
 * atMs is provider event time, NEVER server receipt/processing time.
 */
export type NativeKnowledgeOrder = Readonly<{ atMs: number; sequence: number | null }>;
export type OrderedAdmission = Readonly<{
  disposition: 'ACCEPTED' | 'DUPLICATE' | 'STALE' | 'AMBIGUOUS' | 'BLOCKED';
  mayAttach: boolean; acceptance: Acceptance | null;
}>;
export function captureNativeOrder(channel: KnowledgeScope['channel'], raw: unknown): NativeKnowledgeOrder | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Object.keys(raw).sort().join(',') !== 'atMs,sequence') throw new Error('knowledge_invalid_native_order');
  const { atMs, sequence } = raw as NativeKnowledgeOrder;
  if (!Number.isSafeInteger(atMs) || atMs <= 0 ||
    (channel === 'telegram' ? !Number.isSafeInteger(sequence) || sequence! < 0 : sequence !== null) ||
    (['telegram', 'whatsapp'].includes(channel) && atMs % 1000 !== 0)) throw new Error('knowledge_invalid_native_order');
  return snapshot({ atMs, sequence });
}

/** Field-level capture for the four existing native entry shapes. Malformed or
 * absent order returns null so admission can invalidate/latch unknown-order work.
 * Does not infer order from opaque IDs, message text, array order or receipt time.
 * Caller excludes echoes/noncustomer events and validates provider identity.
 */
export function nativeKnowledgeOrder(channel: KnowledgeScope['channel'], event: any): NativeKnowledgeOrder | null {
  let atMs: unknown; let sequence: unknown = null;
  if (channel === 'telegram') {
    if (typeof event?.message?.date !== 'number' || typeof event?.update_id !== 'number') return null;
    atMs = event.message.date * 1000; sequence = event.update_id;
  } else if (channel === 'whatsapp') {
    if (typeof event?.timestamp !== 'string' || !/^[1-9][0-9]*$/u.test(event.timestamp)) return null;
    atMs = Number(event.timestamp) * 1000;
  } else {
    if (event?.message?.is_echo || typeof event?.timestamp !== 'number') return null;
    atMs = event.timestamp;
  }
  try { return captureNativeOrder(channel, { atMs, sequence }); } catch { return null; }
}
