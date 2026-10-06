import { isDeepStrictEqual } from 'node:util';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProvisioningTarget } from '../provisioning/orchestration';
import { generateReminderMappings, type WhatsAppTemplateProvisioningState } from './template-provisioning';
import { isRuntimeReminderMapping } from './appointment-template-contract';

export const WHATSAPP_MAPPING_PUBLICATION_CODES = [
  'reminder_mappings_published', 'reminder_mappings_already_current', 'reminder_mapping_bundle_invalid',
  'provisioning_connection_changed', 'template_reconciliation_unverified', 'provisioning_preflight_blocked',
  'provisioning_rollout_disabled', 'provisioning_schema_missing', 'provisioning_storage_unavailable',
] as const;
export type MappingPublicationCode = typeof WHATSAPP_MAPPING_PUBLICATION_CODES[number];
export type MappingPublicationResult = { code: MappingPublicationCode; published: boolean;
  fingerprint?: string; version?: number; reconciled_at?: string; reminder_ready?: boolean;
  delivery_ready: boolean; ready: boolean };
export type ProvisioningRolloutGate = { allowed: boolean; code: MappingPublicationCode | null };

export function publishedReminderDeliveryReady(readiness: WhatsAppTemplateProvisioningState['readiness']): boolean {
  return readiness.delivery_ready && !readiness.waba.payment_blocked && !readiness.waba.business_verification_limited &&
    readiness.waba.sending_health === 'AVAILABLE' && readiness.phone.health?.can_send_message === 'AVAILABLE' &&
    !readiness.reasons.some(reason => ['sending_health_limited', 'sending_health_blocked', 'sending_health_unverified'].includes(reason.code));
}

// The HTTP read and database write cannot be one provider transaction. A short
// evidence lifetime plus a locked, exact snapshot comparison closes the local
// race; the reminder runtime still verifies current Meta assets at send time.
export function validateReminderPublication(state: WhatsAppTemplateProvisioningState, now = Date.now()): MappingPublicationCode | null {
  const r = state.readiness, target = state.target;
  if (!r.connection_ready || !r.provisioning_ready || r.asset.phone_belongs_to_waba !== true ||
      r.authorization.token_valid !== true || !r.authorization.management_access_sufficient ||
      !r.authorization.waba_tasks?.includes('MANAGE') ||
      !['business_management', 'whatsapp_business_management', 'whatsapp_business_messaging'].every(scope => r.authorization.effective_scopes.includes(scope))) {
    return 'provisioning_preflight_blocked';
  }
  if (!target.authorization_version || !/^[a-f0-9]{64}$/u.test(target.authorization_version) ||
      target.provider !== 'whatsapp' || r.provider !== 'whatsapp' || r.business_id !== target.business_id ||
      r.asset.waba_id !== target.asset_id || r.asset.phone_number_id !== target.identity_id || r.authorization.app_id !== target.app_id) {
    return 'provisioning_connection_changed';
  }
  const fresh = (time: string) => Number.isFinite(Date.parse(time)) && Date.parse(time) <= now + 5_000 && now - Date.parse(time) <= 180_000;
  if (!fresh(r.checked_at) || state.templates.some(t => !fresh(t.last_checked_at) ||
      t.last_provider_event_at != null && (!Number.isFinite(Date.parse(t.last_provider_event_at)) || Date.parse(t.last_provider_event_at) > Date.parse(t.last_checked_at))) ||
      [r.authorization.expires_at, r.authorization.data_access_expires_at].some(expiry => expiry != null && expiry !== 0 && expiry * 1000 <= now)) {
    return 'template_reconciliation_unverified';
  }
  const expected = generateReminderMappings(target, state.templates);
  if (!state.mapping_ready || !r.reminder_ready || expected.length !== 12 || !isDeepStrictEqual(state.mappings, expected) ||
      state.mappings.some(mapping => !isRuntimeReminderMapping(mapping, { businessId: String(target.business_id),
        wabaId: target.asset_id, phoneNumberId: target.identity_id }, mapping.booking_language)) ||
      r.templates.length !== 6 || state.templates.some(t => r.templates.filter(p => p.booking_language === t.language_code &&
        p.language_code === t.language_code && p.template_id === t.template_id && p.status === 'APPROVED' && p.state === 'approved_compatible').length !== 1)) {
    return 'reminder_mapping_bundle_invalid';
  }
  return null;
}

export function createWhatsAppMappingBoundary(client: Pick<SupabaseClient, 'rpc'>,
  options: { enabled?: () => boolean; now?: () => number } = {}) {
  const enabled = options.enabled || (() => process.env.WHATSAPP_TEMPLATE_PROVISIONING_ENABLED === 'true');
  const now = options.now || Date.now;
  async function call(operation: string, payload: unknown): Promise<any> {
    const { data, error } = await client.rpc('whatsapp_reminder_mapping_boundary', { p_operation: operation, p_payload: payload });
    if (error) throw new Error('provisioning_storage_unavailable');
    return data;
  }
  async function gate(): Promise<ProvisioningRolloutGate> {
    if (!enabled()) return { allowed: false, code: 'provisioning_rollout_disabled' };
    try {
      const result = await call('gate', {});
      return result?.protocol_version === 1 && result?.supported === true ? { allowed: true, code: null } :
        { allowed: false, code: 'provisioning_schema_missing' };
    } catch { return { allowed: false, code: 'provisioning_schema_missing' }; }
  }
  return {
    gate,
    async binding(target: ProvisioningTarget): Promise<{ authorization_version: string } | null> {
      const rollout = await gate();
      if (!rollout.allowed) return null;
      try {
        const result = await call('binding', { target });
        return /^[a-f0-9]{64}$/u.test(result?.authorization_version || '') ? result : null;
      } catch { return null; }
    },
    async publish(state: WhatsAppTemplateProvisioningState): Promise<MappingPublicationResult> {
      const fail = (code: MappingPublicationCode): MappingPublicationResult => ({ code, published: false,
        delivery_ready: !['provisioning_connection_changed', 'provisioning_preflight_blocked', 'template_reconciliation_unverified'].includes(code) && publishedReminderDeliveryReady(state.readiness), ready: false });
      const rollout = await gate();
      if (!rollout.allowed) return fail(rollout.code!);
      const invalid = validateReminderPublication(state, now());
      if (invalid) return fail(invalid);
      try {
        // The RPC rereads and locks the connection, business and durable
        // snapshot. A preceding read alone is never the write authorization.
        const result = await call('publish', { enabled: enabled(), state });
        if (!WHATSAPP_MAPPING_PUBLICATION_CODES.includes(result?.code) || typeof result?.published !== 'boolean' ||
            typeof result?.delivery_ready !== 'boolean' || typeof result?.ready !== 'boolean' ||
            result.published && (!['reminder_mappings_published', 'reminder_mappings_already_current'].includes(result.code) ||
              !/^[a-f0-9]{64}$/u.test(result.fingerprint || '') || !Number.isSafeInteger(result.version) || result.version < 1 ||
              !Number.isFinite(Date.parse(result.reconciled_at)) || result.reminder_ready !== true || result.ready !== result.delivery_ready)) {
          return fail('provisioning_storage_unavailable');
        }
        return result;
      } catch { return fail('provisioning_storage_unavailable'); }
    },
    async current(state: WhatsAppTemplateProvisioningState): Promise<boolean> {
      if (!(await gate()).allowed) return false;
      try { return (await call('current', { target: state.target }))?.current === true; } catch { return false; }
    },
  };
}
