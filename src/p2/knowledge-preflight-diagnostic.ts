import { randomUUID } from 'node:crypto';
import { runOptionalDiagnostic } from '../ai/business-information-timing';

export const providerRejections = ['BINDING_OR_CONNECTION', 'CONNECTION_CHANGED', 'EVENT_TIME', 'TELEGRAM_CONNECTION_MODE',
  'TELEGRAM_BOT_IDENTITY', 'TELEGRAM_PRIVATE_CHAT', 'TELEGRAM_MEMBERSHIP', 'RESPONSE_WINDOW', 'WHATSAPP_CONNECTION_OR_SCOPE',
  'WHATSAPP_APP_CONFIGURATION', 'WHATSAPP_TOKEN_APP', 'WHATSAPP_TOKEN_VALIDITY', 'WHATSAPP_TOKEN_SCOPE', 'WHATSAPP_TOKEN_EXPIRY', 'WHATSAPP_GRANULAR_SCOPE', 'WHATSAPP_WABA_IDENTITY', 'WHATSAPP_WABA_ASSIGNMENT', 'WHATSAPP_PHONE_MEMBERSHIP', 'WHATSAPP_PHONE_HEALTH_OR_WINDOW',
  'META_SAVED_SCOPE', 'META_IDENTITY', 'META_CONVERSATION_OR_WINDOW'] as const;
export type ProviderRejection = typeof providerRejections[number];
export const entryRejections = ['BUSINESS_SCOPE', 'EVIDENCE_FIRST_ROUTE', 'CANCELLED', 'TURN_CONTEXT'] as const;
type EntryRejection = typeof entryRejections[number];
const instance = randomUUID(); // Per-process opaque identity; no hostname/account/environment dump.
export function preflightRejected(turnId: string, channel: string,
  gate: 'provider' | 'execution_entry', reason: ProviderRejection | EntryRejection,
  observer: (event: Readonly<Record<string, string>>) => unknown = event => console.info('[AsyncKnowledgePreflight]', JSON.stringify(event))): void {
  runOptionalDiagnostic(() => {
    if (!/^[a-f0-9-]{36}$/iu.test(turnId) || !['whatsapp','telegram','instagram','messenger'].includes(channel) ||
      !(gate === 'provider' ? providerRejections : entryRejections).includes(reason as never)) return;
    const revision = process.env.RENDER_GIT_COMMIT || '';
    return observer(Object.freeze({ stage: 'execution_preflight_rejected', gate, reason, turnId, channel,
      instance, revision: /^[a-f0-9]{7,40}$/iu.test(revision) ? revision : 'unknown' }));
  });
}
