import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveConnectionForBusiness } from '../connections/repository';
import type { ProvisioningTarget } from '../provisioning/orchestration';
import { SupabaseProvisioningStore } from '../provisioning/supabase-store';
import { createWhatsAppApprovalTracker } from './approval-tracking';
import { createWhatsAppMappingBoundary, publishedReminderDeliveryReady, type MappingPublicationCode } from './reminder-mapping-publisher';
import { provisioningTarget, queueWhatsAppTemplateProvisioning, type WhatsAppTemplateProvisioner,
  type WhatsAppTemplateProvisioningState, type WhatsAppTemplateProvisioningInput } from './template-provisioning';

export function createWhatsAppProvisioningRuntime(client: SupabaseClient) {
  const store = new SupabaseProvisioningStore<WhatsAppTemplateProvisioningState>(client);
  const boundary = createWhatsAppMappingBoundary(client);
  const graphVersion = String(process.env.META_GRAPH_API_VERSION || 'v26.0').replace(/^\/?/, '');
  const resolveAuthorization = async (target: ProvisioningTarget) => {
    if (!target.authorization_version || !(await boundary.gate()).allowed) return null;
    const before = await boundary.binding(target);
    if (before?.authorization_version !== target.authorization_version) return null;
    const connection = await resolveConnectionForBusiness(client, target.business_id, 'whatsapp');
    if (!connection || connection.providerAccountId !== target.identity_id || connection.providerConnectionId !== target.asset_id ||
        connection.metadata.whatsapp_provisioning_app_id !== target.app_id ||
        connection.metadata.authorizing_odinlink_user_id !== target.authorizing_user_id || process.env.META_APP_ID !== target.app_id ||
        (await boundary.binding(target))?.authorization_version !== before.authorization_version) return null;
    return { businessId: target.business_id, authorizingUserId: target.authorizing_user_id, appId: target.app_id,
      accessToken: connection.credential.accessToken, expectedPortfolioId: target.expected_portfolio_id,
      authorizationVersion: before.authorization_version };
  };
  const tracker = createWhatsAppApprovalTracker({ store, graphVersion, resolveAuthorization });
  const blocked = (input: WhatsAppTemplateProvisioningInput, readiness: WhatsAppTemplateProvisioningState['readiness'],
    code: MappingPublicationCode): WhatsAppTemplateProvisioningState => ({ target: provisioningTarget(input), templates: [], mappings: [],
    mapping_ready: false, mappings_persisted: false, readiness: { ...readiness, ready: false, reminder_ready: false },
    reasons: [...readiness.reasons, { code, severity: 'blocking', scope: 'authorization', message: 'Appointment reminder setup is not available yet.' }],
    next_check_at: Date.now() + 60_000, code });
  return {
    // Existing connection registration/subscription/storage is unchanged. Only
    // this automated reminder path is guarded by the flag and schema capability.
    provision: (async (input, preflight) => {
      const rollout = await boundary.gate();
      if (!rollout.allowed) return blocked(input, preflight, rollout.code!);
      const target = provisioningTarget(input), binding = await boundary.binding(target);
      if (!binding) return blocked(input, preflight, 'provisioning_connection_changed');
      const versioned = { ...target, authorization_version: binding.authorization_version };
      const current = await resolveAuthorization(versioned);
      if (!current || current.accessToken !== input.authorization.accessToken) return blocked(input, preflight, 'provisioning_connection_changed');
      return queueWhatsAppTemplateProvisioning({ ...input, authorization: current }, preflight, store);
    }) as WhatsAppTemplateProvisioner,
    async handleVerifiedWebhook(payload: unknown) {
      // Schema rollout must not interrupt normal incoming conversations.
      if ((await boundary.gate()).allowed) await tracker.handleVerifiedWebhook(payload);
    },
    async reconcileDue() {
      if (!(await boundary.gate()).allowed) return [];
      const results = await tracker.reconcileDue();
      for (const state of results) {
        if (!state?.mapping_ready) continue;
        const publication = await boundary.publish(state);
        state.mappings_persisted = publication.published;
        if (publication.published) {
          state.publication = { fingerprint: publication.fingerprint!, version: publication.version!, reconciled_at: publication.reconciled_at! };
          state.readiness.delivery_ready = publication.delivery_ready;
          state.readiness.ready = publication.ready;
        } else {
          state.readiness.ready = false;
          state.code = publication.code;
          if (publication.code === 'provisioning_connection_changed') {
            state.readiness.connection_ready = false; state.readiness.provisioning_ready = false; state.readiness.delivery_ready = false;
          }
          state.reasons.push({ code: publication.code, severity: 'blocking', scope: 'template', message: 'Appointment reminder configuration is awaiting verification.' });
        }
      }
      return results;
    },
    async status(businessId: number) {
      if (!(await boundary.gate()).allowed) return null;
      const connection = await resolveConnectionForBusiness(client, businessId, 'whatsapp');
      if (!connection?.providerConnectionId || !connection.metadata.authorizing_odinlink_user_id || !connection.metadata.whatsapp_provisioning_app_id) return null;
      const target: ProvisioningTarget = { provider: 'whatsapp', business_id: businessId, asset_id: connection.providerConnectionId,
        identity_id: connection.providerAccountId, app_id: String(connection.metadata.whatsapp_provisioning_app_id),
        authorizing_user_id: String(connection.metadata.authorizing_odinlink_user_id) };
      const state = await store.load(target);
      if (!state) return null;
      const binding = await boundary.binding(target);
      const changed = !binding || binding.authorization_version !== state.target.authorization_version;
      if (changed || state.next_check_at + 60_000 < Date.now()) {
        state.mappings = []; state.mapping_ready = false; state.readiness.ready = false;
        state.readiness.connection_ready = false; state.readiness.provisioning_ready = false;
        state.readiness.reminder_ready = false; state.readiness.delivery_ready = false;
        state.code = changed ? 'provisioning_connection_changed' : 'template_reconciliation_unverified';
        state.reasons.push({ code: state.code, severity: 'blocking', scope: 'template', message: 'Appointment reminder approval needs to be checked again.' });
      }
      state.mappings_persisted = await boundary.current(state);
      state.readiness.delivery_ready = publishedReminderDeliveryReady(state.readiness);
      state.readiness.ready = state.mappings_persisted && state.mapping_ready && state.readiness.connection_ready && state.readiness.provisioning_ready && state.readiness.delivery_ready;
      return state;
    },
  };
}
