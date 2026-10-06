import { APPOINTMENT_TEMPLATE_FACTS, hasCompatibleAppointmentTemplateBody } from './appointment-template-contract';
import { canonicalAppointmentReminder, isCanonicalAppointmentReminder, WHATSAPP_REMINDER_LANGUAGES,
  type ReminderLanguage } from './appointment-reminder-templates';
import { createWhatsAppMetaClient } from './meta-client';
import { inspectWhatsAppProvisioning, type WhatsAppProvisioningPreflight } from '../connections/whatsapp-provisioning-preflight';
import type { ProvisioningReason, TenantProvisioningAuthorization } from '../connections/provisioning-readiness';
import { submitProvisioningItem, withProvisioningLease, type CreationIntent, type ProvisioningStore,
  type ProvisioningTarget } from '../provisioning/orchestration';

export const WHATSAPP_TEMPLATE_PROVISIONING_CODES = [
  'template_already_ready', 'template_created_pending', 'template_approval_pending', 'template_rejected',
  'template_paused_disabled', 'template_incompatible_existing', 'template_duplicate_conflict',
  'template_creation_failed', 'template_creation_permission_denied', 'template_creation_rate_limited',
  'template_meta_error', 'template_creation_unconfirmed', 'template_reconciliation_unverified',
  'template_creation_id_mismatch', 'template_missing_for_selected_waba', 'template_provider_event_reconciliation_required',
  'provisioning_preflight_blocked', 'provisioning_busy', 'provisioning_storage_unavailable', 'provisioning_lease_lost',
  'provisioning_connection_changed',
  'provisioning_queued',
  'reminder_mappings_published', 'reminder_mappings_already_current', 'reminder_mapping_bundle_invalid',
  'provisioning_rollout_disabled', 'provisioning_schema_missing',
] as const;
export type TemplateProvisioningCode = typeof WHATSAPP_TEMPLATE_PROVISIONING_CODES[number];
export type ReminderTemplateMapping = { business_id: string; waba_id: string; phone_number_id: string;
  reminder_type: '24h' | '2h'; booking_language: ReminderLanguage; template_id: string;
  name: 'appointment_reminder'; language_code: ReminderLanguage; body_parameters: string[] };
export type TrackedTemplate = {
  template_id: string | null; name: 'appointment_reminder'; language_code: ReminderLanguage;
  status: string | null; category: string | null; parameter_format: string | null;
  component_compatible: boolean; canonical_compatible: boolean;
  state: 'missing' | 'pending' | 'approved_compatible' | 'rejected' | 'paused_disabled' | 'conflict' | 'unverified' | 'creation_failed';
  code: TemplateProvisioningCode; last_checked_at: string; last_provider_event_at: string | null;
  last_error: TemplateProvisioningCode | null; provider_error_code: number | null;
  quality_rating: string | null;
};
export type WhatsAppTemplateProvisioningState = { target: ProvisioningTarget; templates: TrackedTemplate[];
  mappings: ReminderTemplateMapping[]; mapping_ready: boolean; mappings_persisted: boolean;
  publication?: { fingerprint: string; version: number; reconciled_at: string };
  readiness: WhatsAppProvisioningPreflight; reasons: ProvisioningReason[]; next_check_at: number;
  code: TemplateProvisioningCode | null };
export type WhatsAppTemplateProvisioningInput = { authorization: TenantProvisioningAuthorization; wabaId: string;
  phoneNumberId: string; graphVersion?: string; fetchImpl?: typeof fetch; now?: () => number; createMissing?: boolean;
  confirmAuthorization?: () => Promise<boolean> };
export type WhatsAppTemplateProvisioner = (input: WhatsAppTemplateProvisioningInput,
  preflight: WhatsAppProvisioningPreflight) => Promise<WhatsAppTemplateProvisioningState>;

const numericId = (value: unknown): string | null => typeof value === 'string' && /^\d+$/u.test(value) ? value : null;
const enumValue = (value: unknown): string | null => typeof value === 'string' && /^[A-Z_a-z0-9]{1,64}$/u.test(value) ? value : null;
export const creationKey = (wabaId: string, language: ReminderLanguage) => `whatsapp:${wabaId}:appointment_reminder:${language}`;
export function provisioningTarget(input: WhatsAppTemplateProvisioningInput): ProvisioningTarget {
  return { provider: 'whatsapp', business_id: input.authorization.businessId, asset_id: input.wabaId,
    identity_id: input.phoneNumberId, app_id: input.authorization.appId, authorizing_user_id: input.authorization.authorizingUserId,
    ...(input.authorization.expectedPortfolioId ? { expected_portfolio_id: input.authorization.expectedPortfolioId } : {}),
    ...(input.authorization.authorizationVersion ? { authorization_version: input.authorization.authorizationVersion } : {}) };
}
function provisioningReason(code: TemplateProvisioningCode, language?: ReminderLanguage): ProvisioningReason {
  const info = code === 'template_already_ready', pending = ['template_created_pending', 'template_approval_pending', 'provisioning_queued'].includes(code);
  return { code, scope: code.startsWith('provisioning_') && code !== 'provisioning_queued' ? 'authorization' : 'template',
    severity: info ? 'info' : pending ? 'warning' : 'blocking',
    message: code === 'provisioning_queued' ? 'Appointment reminder setup is starting.' : info ? 'Appointment reminders are set up for this language.' : pending ? 'Appointment reminders are awaiting approval.' :
      'Appointment reminder setup needs attention.', ...(language ? { details: { language } } : {}) };
}
function inspectLanguage(rows: any[] | null, language: ReminderLanguage, checkedAt: string, previous?: TrackedTemplate): TrackedTemplate {
  const entry: TrackedTemplate = { template_id: null, name: 'appointment_reminder', language_code: language, status: null,
    category: null, parameter_format: null, component_compatible: false, canonical_compatible: false, state: 'unverified',
    code: 'template_reconciliation_unverified', last_checked_at: checkedAt,
    last_provider_event_at: previous?.last_provider_event_at || null, last_error: 'template_reconciliation_unverified',
    provider_error_code: null, quality_rating: previous?.quality_rating || null };
  if (!rows) return entry;
  const matches = rows.filter(row => row?.name === entry.name && row.language === language);
  if (matches.length === 0) { entry.state = 'missing'; entry.code = 'template_missing_for_selected_waba'; }
  else if (matches.length !== 1) { entry.state = 'conflict'; entry.code = 'template_duplicate_conflict'; }
  else {
    const asset = matches[0];
    entry.template_id = numericId(asset.id); entry.status = enumValue(asset.status);
    entry.category = enumValue(asset.category); entry.parameter_format = enumValue(asset.parameter_format);
    entry.component_compatible = hasCompatibleAppointmentTemplateBody(asset, APPOINTMENT_TEMPLATE_FACTS.length, true) && asset.components.length === 1;
    entry.canonical_compatible = isCanonicalAppointmentReminder(asset, language);
    entry.quality_rating = enumValue(asset.quality_score?.score) || entry.quality_rating;
    if (!entry.template_id || !entry.canonical_compatible) { entry.state = 'conflict'; entry.code = 'template_incompatible_existing'; }
    else if (entry.status === 'APPROVED') { entry.state = 'approved_compatible'; entry.code = 'template_already_ready'; }
    else if (['PENDING', 'IN_APPEAL'].includes(entry.status || '')) { entry.state = 'pending'; entry.code = 'template_approval_pending'; }
    else if (entry.status === 'REJECTED') { entry.state = 'rejected'; entry.code = 'template_rejected'; }
    else if (['PAUSED', 'DISABLED'].includes(entry.status || '')) { entry.state = 'paused_disabled'; entry.code = 'template_paused_disabled'; }
    else { entry.state = 'conflict'; entry.code = 'template_incompatible_existing'; }
  }
  entry.last_error = entry.state === 'approved_compatible' || entry.state === 'pending' ? null : entry.code;
  return entry;
}
export function generateReminderMappings(target: ProvisioningTarget, templates: TrackedTemplate[]): ReminderTemplateMapping[] {
  // Partial approval produces no deployable mapping bundle. Superseded or revoked
  // approval removes every candidate; persistence is a separate atomic boundary.
  if (templates.length !== 6 || WHATSAPP_REMINDER_LANGUAGES.some(language =>
    templates.filter(t => t.language_code === language && t.state === 'approved_compatible' && t.canonical_compatible &&
      t.component_compatible && t.status === 'APPROVED' && t.category === 'UTILITY' && t.parameter_format === 'POSITIONAL' &&
      t.name === 'appointment_reminder' && typeof t.template_id === 'string' && /^\d+$/u.test(t.template_id)).length !== 1) ||
    new Set(templates.map(t => t.template_id)).size !== 6) return [];
  return (['24h', '2h'] as const).flatMap(reminderType => WHATSAPP_REMINDER_LANGUAGES.map(language => ({
    business_id: String(target.business_id), waba_id: target.asset_id, phone_number_id: target.identity_id,
    reminder_type: reminderType, booking_language: language, template_id: templates.find(t => t.language_code === language)!.template_id!,
    name: 'appointment_reminder', language_code: language, body_parameters: [...APPOINTMENT_TEMPLATE_FACTS],
  })));
}

// Onboarding persists its credential first, then queues non-secret state. A worker
// can resume independently of the browser request; it always repeats preflight.
export async function queueWhatsAppTemplateProvisioning(input: WhatsAppTemplateProvisioningInput,
  preflight: WhatsAppProvisioningPreflight, store: ProvisioningStore<WhatsAppTemplateProvisioningState>): Promise<WhatsAppTemplateProvisioningState> {
  const target = provisioningTarget(input), now = input.now || Date.now;
  const state: WhatsAppTemplateProvisioningState = { target,
    templates: WHATSAPP_REMINDER_LANGUAGES.map(language => ({ template_id: null, name: 'appointment_reminder', language_code: language,
      status: null, category: null, parameter_format: null, component_compatible: false, canonical_compatible: false,
      state: 'unverified', code: 'template_reconciliation_unverified', last_checked_at: preflight.checked_at,
      last_provider_event_at: null, last_error: null, provider_error_code: null, quality_rating: null })),
    mappings: [], mapping_ready: false, mappings_persisted: false, readiness: { ...preflight, ready: false, reminder_ready: false },
    reasons: [...preflight.reasons, provisioningReason('provisioning_queued')], next_check_at: now(), code: 'provisioning_queued' };
  if (!preflight.provisioning_ready || preflight.business_id !== target.business_id || preflight.asset.waba_id !== target.asset_id ||
      preflight.asset.phone_number_id !== target.identity_id || preflight.authorization.app_id !== target.app_id ||
      !Number.isFinite(Date.parse(preflight.checked_at)) || Math.abs(now() - Date.parse(preflight.checked_at)) > 180_000) {
    state.code = 'provisioning_preflight_blocked'; state.reasons.push(provisioningReason(state.code)); return state;
  }
  try {
    // Atomic tenant queueing is independent of the asset creation lease. A
    // contended WABA cannot lose a newly authorized tenant's onboarding job.
    await store.enqueue(target, state);
    return state;
  } catch { state.code = 'provisioning_storage_unavailable'; }
  state.reasons.push(provisioningReason(state.code)); return state;
}

export async function provisionWhatsAppTemplates(input: WhatsAppTemplateProvisioningInput,
  store: ProvisioningStore<WhatsAppTemplateProvisioningState>): Promise<WhatsAppTemplateProvisioningState> {
  const now = input.now || Date.now, target = provisioningTarget(input);
  const bindingConfirmed = async () => {
    if (!input.confirmAuthorization) return true;
    try { return await input.confirmAuthorization() === true; } catch { return false; }
  };
  let bindingLost = !await bindingConfirmed();
  let readiness = await inspectWhatsAppProvisioning(input);
  if (bindingLost) readiness = { ...readiness, ready: false, connection_ready: false, provisioning_ready: false, reminder_ready: false, delivery_ready: false };
  const empty = (code: TemplateProvisioningCode): WhatsAppTemplateProvisioningState => ({ target,
    templates: WHATSAPP_REMINDER_LANGUAGES.map(language => inspectLanguage(null, language, new Date(now()).toISOString())), mappings: [],
    mapping_ready: false, mappings_persisted: false, readiness: { ...readiness, reminder_ready: false, ready: false },
    reasons: [...readiness.reasons, provisioningReason(code)], next_check_at: now() + 60_000, code });
  if (!readiness.provisioning_ready || bindingLost) {
    const blocked = empty(bindingLost ? 'provisioning_connection_changed' : 'provisioning_preflight_blocked');
    // Revocation must invalidate previously-ready tracking, even though it can
    // never authorize new provider assets or a new connection/mapping write.
    if (!readiness.reasons.some(r => r.code === 'authorization_context_invalid')) {
      try { await withProvisioningLease(store, target, async lease => {
        const previous = await store.load(target);
        if (previous) {
          blocked.templates = blocked.templates.map(entry => ({ ...entry,
            template_id: previous.templates.find(t => t.language_code === entry.language_code)?.template_id || null,
            last_provider_event_at: previous.templates.find(t => t.language_code === entry.language_code)?.last_provider_event_at || null,
          }));
          await store.save(target, blocked, lease);
        }
      }); } catch { blocked.reasons.push(provisioningReason('provisioning_storage_unavailable')); }
    }
    return blocked;
  }
  try {
    const result = await withProvisioningLease(store, target, async lease => {
      const previous = await store.load(target);
      const client = createWhatsAppMetaClient({ accessToken: input.authorization.accessToken, graphVersion: input.graphVersion || 'v25.0', fetchImpl: input.fetchImpl });
      const readTemplates = () => client.list(`${target.asset_id}/message_templates`, { name: 'appointment_reminder',
        fields: 'id,name,language,status,category,parameter_format,components,quality_score' });
      let rows = await readTemplates();
      let tracked = WHATSAPP_REMINDER_LANGUAGES.map(language => inspectLanguage(rows, language, new Date(now()).toISOString(),
        previous?.templates.find(t => t.language_code === language)));
      const attempts = new Map<ReminderLanguage, { intent: CreationIntent; submitted: boolean }>();
      for (const language of WHATSAPP_REMINDER_LANGUAGES) {
        const entry = tracked.find(t => t.language_code === language)!;
        if (entry.state !== 'missing' || input.createMissing === false) continue;
        if (!await bindingConfirmed()) { bindingLost = true; break; }
        // Revalidate authorization and membership immediately before each write.
        // Billing/template absence is independent of the management write gate.
        readiness = await inspectWhatsAppProvisioning(input);
        if (!readiness.provisioning_ready) break;
        rows = await readTemplates();
        const fresh = inspectLanguage(rows, language, new Date(now()).toISOString(), entry);
        if (fresh.state !== 'missing') { tracked = tracked.map(t => t.language_code === language ? fresh : t); continue; }
        const attempt = await submitProvisioningItem(store, lease, creationKey(target.asset_id, language), now(), async () => {
          const response = await client.createTemplate(target.asset_id, canonicalAppointmentReminder(language));
          if (response.ok === true) {
            const assetId = numericId(response.data?.id);
            return { state: assetId ? 'submitted' : 'uncertain', code: assetId ? 'template_created_pending' : 'template_creation_unconfirmed',
              asset_id: assetId, retry_at: null, provider_code: null };
          }
          const error = response.error;
          const code: TemplateProvisioningCode = error.kind === 'permission' ? 'template_creation_permission_denied' :
            error.kind === 'rate_limit' ? 'template_creation_rate_limited' : error.kind === 'uncertain' ? 'template_meta_error' : 'template_creation_failed';
          return { state: error.kind === 'rate_limit' ? 'retryable' : error.kind === 'uncertain' ? 'uncertain' : 'failed',
            code, asset_id: null, retry_at: error.kind === 'rate_limit' ? now() + error.retry_after_ms : null, provider_code: error.provider_code };
        });
        attempts.set(language, attempt);
        // A successful POST is never approval/ownership evidence, even if it
        // claims APPROVED. Always reread the explicitly selected WABA edge.
        rows = await readTemplates();
        tracked = WHATSAPP_REMINDER_LANGUAGES.map(lang => inspectLanguage(rows, lang, new Date(now()).toISOString(),
          tracked.find(t => t.language_code === lang)));
        if (attempt.intent.state === 'retryable' || attempt.intent.state === 'uncertain' || attempt.intent.state === 'failed') break;
      }
      readiness = await inspectWhatsAppProvisioning(input);
      if (!await bindingConfirmed()) bindingLost = true;
      if (bindingLost) readiness = { ...readiness, ready: false, connection_ready: false, provisioning_ready: false, reminder_ready: false, delivery_ready: false };
      rows = await readTemplates();
      tracked = WHATSAPP_REMINDER_LANGUAGES.map(language => inspectLanguage(rows, language, new Date(now()).toISOString(),
        tracked.find(t => t.language_code === language)));
      for (const entry of tracked) {
        const attempt = attempts.get(entry.language_code);
        const intent = attempt?.intent || await store.intent(creationKey(target.asset_id, entry.language_code));
        if (!intent) continue;
        if (entry.state === 'unverified' && !entry.template_id && intent.asset_id) entry.template_id = intent.asset_id;
        if (intent.asset_id && entry.template_id && entry.template_id !== intent.asset_id) {
          entry.state = 'conflict'; entry.code = 'template_creation_id_mismatch'; entry.last_error = entry.code;
        } else if (entry.state === 'missing') {
          entry.template_id = intent.asset_id;
          entry.state = intent.state === 'failed' || intent.state === 'retryable' ? 'creation_failed' : 'unverified';
          entry.code = intent.state === 'reserved' || intent.state === 'submitted' || intent.state === 'uncertain' && !attempt ?
            'template_creation_unconfirmed' : intent.code as TemplateProvisioningCode;
          entry.last_error = entry.code; entry.provider_error_code = intent.provider_code;
        } else if (entry.state === 'pending' && attempt?.submitted && intent.state === 'submitted') {
          entry.code = 'template_created_pending';
        }
      }
      const mappings = readiness.connection_ready ? generateReminderMappings(target, tracked) : [];
      const mappingReady = mappings.length === 12;
      readiness = { ...readiness, reminder_ready: mappingReady,
        ready: readiness.connection_ready && readiness.provisioning_ready && mappingReady && readiness.delivery_ready };
      const state: WhatsAppTemplateProvisioningState = { target, templates: tracked, mappings, mapping_ready: mappingReady,
        mappings_persisted: false, readiness, reasons: [...readiness.reasons, ...tracked.map(t => provisioningReason(t.code, t.language_code))],
        next_check_at: now() + (mappingReady ? 900_000 : 60_000), code: bindingLost ? 'provisioning_connection_changed' : readiness.provisioning_ready ? null : 'provisioning_preflight_blocked' };
      if (state.code) state.reasons.push(provisioningReason(state.code));
      await store.save(target, state, lease);
      return state;
    });
    return result || empty('provisioning_busy');
  } catch (error) {
    return empty(error instanceof Error && error.message === 'provisioning_lease_lost' ? 'provisioning_lease_lost' : 'provisioning_storage_unavailable');
  }
}
