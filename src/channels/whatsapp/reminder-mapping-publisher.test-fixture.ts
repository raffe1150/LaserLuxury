import type { WhatsAppProvisioningPreflight } from '../connections/whatsapp-provisioning-preflight';
import { WHATSAPP_REMINDER_LANGUAGES } from './appointment-reminder-templates';
import { generateReminderMappings, type TrackedTemplate, type WhatsAppTemplateProvisioningState } from './template-provisioning';

export function mappingPublicationFixture(now = Date.now(), authorizationVersion = 'a'.repeat(64)): WhatsAppTemplateProvisioningState {
  const checked = new Date(now).toISOString();
  const target = { provider: 'whatsapp' as const, business_id: 3, asset_id: '200', identity_id: '500', app_id: '100',
    authorizing_user_id: 'owner', authorization_version: authorizationVersion };
  const templates: TrackedTemplate[] = WHATSAPP_REMINDER_LANGUAGES.map((language, index) => ({
    template_id: String(6000 + index), name: 'appointment_reminder', language_code: language, status: 'APPROVED', category: 'UTILITY',
    parameter_format: 'POSITIONAL', component_compatible: true, canonical_compatible: true, state: 'approved_compatible', code: 'template_already_ready',
    last_checked_at: checked, last_provider_event_at: null, last_error: null, provider_error_code: null, quality_rating: 'GREEN',
  }));
  const readiness: WhatsAppProvisioningPreflight = {
    provider: 'whatsapp', business_id: 3, checked_at: checked, ready: true, connection_ready: true, provisioning_ready: true,
    reminder_ready: true, delivery_ready: true, reasons: [],
    asset: { portfolio_id: '300', portfolio_name: 'Owner', waba_id: '200', waba_name: 'Selected', phone_number_id: '500',
      display_phone_number: '+460000000', verified_name: 'Test', phone_belongs_to_waba: true },
    authorization: { token_valid: true, app_id: '100', subject_id: '400', effective_scopes: ['business_management', 'whatsapp_business_management', 'whatsapp_business_messaging'],
      waba_tasks: ['MANAGE'], management_access_sufficient: true, expires_at: 0, data_access_expires_at: 0 },
    phone: { status: 'CONNECTED', platform_type: 'CLOUD_API', account_mode: 'LIVE', quality_rating: 'GREEN', messaging_limit_tier: 'TIER_250', throughput: 'STANDARD',
      name_status: 'APPROVED', code_verification_status: 'EXPIRED', is_pin_enabled: false, health: { can_send_message: 'AVAILABLE', entities: [] } },
    waba: { account_review_status: 'APPROVED', business_verification_status: 'verified', sending_health: 'AVAILABLE', app_subscription_present: true,
      payment_blocked: false, business_verification_limited: false },
    templates: templates.map(t => ({ booking_language: t.language_code, language_code: t.language_code, name: t.name,
      template_id: t.template_id, status: 'APPROVED', state: 'approved_compatible', body_parameters: ['customer_name', 'service', 'date', 'time', 'business_name'] })),
  };
  return { target, templates, mappings: generateReminderMappings(target, templates), mapping_ready: true, mappings_persisted: false,
    readiness, reasons: [], next_check_at: now + 900_000, code: null };
}
