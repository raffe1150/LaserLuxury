import type { TenantProvisioningAuthorization } from '../connections/provisioning-readiness';
import { withProvisioningLease, type ProvisioningStore, type ProvisioningTarget } from '../provisioning/orchestration';
import { provisionWhatsAppTemplates, type WhatsAppTemplateProvisioningState } from './template-provisioning';

const fields = new Set(['message_template_status_update', 'template_category_update', 'message_template_quality_update', 'message_template_components_update']);
type TemplateEvent = { waba_id: string; template_id: string; language: string | null; field: string; time: string;
  quality: string | null };
const metaId = (value: unknown) => typeof value === 'string' && /^\d+$/u.test(value) ? value :
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null;

export function templateEvents(payload: any, receivedAt = Date.now()): TemplateEvent[] {
  if (payload?.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) return [];
  const events: TemplateEvent[] = [];
  for (const entry of payload.entry) {
    const wabaId = metaId(entry?.id);
    if (!wabaId || !Array.isArray(entry.changes)) continue;
    const timestamp = typeof entry.time === 'number' && Number.isFinite(entry.time) && entry.time > 0 ? entry.time * 1000 : receivedAt;
    // Future provider timestamps must not suppress later legitimate events.
    const time = new Date(Math.min(timestamp, receivedAt)).toISOString();
    for (const change of entry.changes) {
      if (!fields.has(change?.field)) continue;
      const value = change.value, templateId = metaId(value?.message_template_id);
      if (!templateId) continue;
      const quality = ['GREEN', 'YELLOW', 'RED', 'UNKNOWN', 'HIGH', 'MEDIUM', 'LOW'].includes(value?.new_quality_score) ? value.new_quality_score : null;
      events.push({ waba_id: wabaId, template_id: templateId, field: change.field, time,
        language: typeof value?.message_template_language === 'string' ? value.message_template_language : null, quality });
    }
  }
  return events;
}

export function createWhatsAppApprovalTracker(input: {
  store: ProvisioningStore<WhatsAppTemplateProvisioningState>;
  resolveAuthorization: (target: ProvisioningTarget) => Promise<TenantProvisioningAuthorization | null>;
  graphVersion?: string; fetchImpl?: typeof fetch; now?: () => number;
}) {
  const now = input.now || Date.now;
  const reconcileTarget = async (target: ProvisioningTarget) => {
    const authorization = await input.resolveAuthorization(target);
    if (!authorization || authorization.businessId !== target.business_id || authorization.appId !== target.app_id ||
        authorization.authorizingUserId !== target.authorizing_user_id) {
      return withProvisioningLease(input.store, target, async lease => {
        const state = await input.store.load(target);
        if (!state) return null;
        state.mappings = []; state.mapping_ready = false; state.readiness.ready = false;
        state.readiness.connection_ready = false; state.readiness.provisioning_ready = false;
        state.readiness.reminder_ready = false; state.readiness.delivery_ready = false;
        state.code = 'provisioning_connection_changed'; state.next_check_at = now() + 300_000;
        state.reasons = [{ code: state.code, severity: 'blocking', scope: 'authorization', message: 'Please reconnect this channel.' }];
        await input.store.save(target, state, lease);
        return state;
      });
    }
    return provisionWhatsAppTemplates({ authorization, wabaId: target.asset_id, phoneNumberId: target.identity_id,
      graphVersion: input.graphVersion, fetchImpl: input.fetchImpl, now, confirmAuthorization: async () => {
        const current = await input.resolveAuthorization(target);
        return current?.businessId === authorization.businessId && current.appId === authorization.appId &&
          current.authorizingUserId === authorization.authorizingUserId && current.accessToken === authorization.accessToken &&
          current.authorizationVersion === authorization.authorizationVersion;
      } }, input.store);
  };
  return {
    // Caller MUST have passed the existing raw-body Meta signature middleware.
    // Payloads can invalidate cached readiness, never approve it or create assets.
    async handleVerifiedWebhook(payload: unknown) {
      for (const event of templateEvents(payload, now())) {
        const targets = await input.store.targetsForAsset('whatsapp', event.waba_id);
        for (const target of targets) {
          if (target.provider !== 'whatsapp' || target.asset_id !== event.waba_id) continue;
          const processed = await withProvisioningLease(input.store, target, async lease => {
            const state = await input.store.load(target);
            const entry = state?.templates.find(t => t.template_id === event.template_id && (!event.language || t.language_code === event.language));
            if (!state || !entry || entry.last_provider_event_at && entry.last_provider_event_at > event.time) return;
            // Replayed events already awaiting reconciliation are a no-op.
            if (entry.last_provider_event_at === event.time && entry.state === 'unverified' && (!event.quality || entry.quality_rating === event.quality)) return;
            entry.last_provider_event_at = event.time;
            if (event.quality) entry.quality_rating = event.quality;
            entry.state = 'unverified'; entry.code = 'template_provider_event_reconciliation_required'; entry.last_error = entry.code;
            state.mappings = []; state.mapping_ready = false; state.readiness.reminder_ready = false; state.readiness.ready = false;
            state.next_check_at = now(); state.code = entry.code;
            state.reasons = [...state.readiness.reasons, { code: entry.code, severity: 'blocking', scope: 'template', message: 'Appointment reminder approval is being checked.' }];
            await input.store.save(target, state, lease);
          });
          if (processed === null) throw new Error('provisioning_busy'); // Ask Meta to retry rather than drop a contended event.
        }
      }
    },
    // Due approved assets are checked too, so missed category/status webhooks
    // cannot keep mappings ready indefinitely. Each run is bounded to 25 tenants.
    async reconcileDue() {
      const targets = await input.store.targetsDue('whatsapp', now(), 25);
      const results: Array<WhatsAppTemplateProvisioningState | null> = [];
      for (const target of targets) {
        if (target.provider === 'whatsapp') results.push(await reconcileTarget(target));
      }
      return results;
    },
    reconcileTarget,
  };
}
