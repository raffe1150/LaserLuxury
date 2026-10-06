import { APPOINTMENT_TEMPLATE_FACTS, hasCompatibleAppointmentTemplateBody } from '../whatsapp/appointment-template-contract';
import type { ChannelProvisioningReadiness, ProvisioningReason, TenantProvisioningAuthorization } from './provisioning-readiness';
import { createWhatsAppMetaClient } from '../whatsapp/meta-client';
import { WHATSAPP_REMINDER_LANGUAGES } from '../whatsapp/appointment-reminder-templates';

export { WHATSAPP_REMINDER_LANGUAGES };
type Language = typeof WHATSAPP_REMINDER_LANGUAGES[number];
type TemplateState = 'missing' | 'pending' | 'rejected' | 'paused_disabled' | 'incompatible' | 'approved_compatible' | 'unverified';
type Health = { can_send_message: string | null; entities: Array<{
  entity_type: string; id: string; can_send_message: string | null; error_codes: number[];
}> };

export type WhatsAppProvisioningPreflight = ChannelProvisioningReadiness & {
  asset: { portfolio_id: string | null; portfolio_name: string | null; waba_id: string;
    waba_name: string | null; phone_number_id: string; display_phone_number: string | null;
    verified_name: string | null; phone_belongs_to_waba: boolean | null };
  authorization: { token_valid: boolean | null; app_id: string | null; subject_id: string | null;
    effective_scopes: string[]; waba_tasks: string[] | null; management_access_sufficient: boolean;
    expires_at: number | null; data_access_expires_at: number | null };
  phone: { status: string | null; platform_type: string | null; account_mode: string | null;
    quality_rating: string | null; messaging_limit_tier: string | null; throughput: string | null;
    name_status: string | null; code_verification_status: string | null; is_pin_enabled: boolean | null;
    health: Health | null };
  waba: { account_review_status: string | null; business_verification_status: string | null;
    sending_health: string | null; app_subscription_present: boolean | null;
    payment_blocked: boolean; business_verification_limited: boolean };
  templates: Array<{ booking_language: Language; language_code: Language; name: 'appointment_reminder';
    template_id: string | null; status: string | null; state: TemplateState;
    body_parameters: readonly string[] }>;
};

const REASONS = {
  authorization_context_invalid: ['blocking', 'authorization', 'Please reconnect this channel.'],
  authorization_unverified: ['blocking', 'authorization', 'We could not verify the channel authorization.'],
  authorization_invalid: ['blocking', 'authorization', 'The channel authorization is no longer valid.'],
  authorization_app_mismatch: ['blocking', 'authorization', 'Please connect this channel through OdinLink.'],
  authorization_scope_missing: ['blocking', 'authorization', 'The connection is missing required access.'],
  authorization_asset_scope_missing: ['blocking', 'authorization', 'Access has not been granted for the selected account.'],
  asset_identity_unverified: ['blocking', 'asset', 'We could not verify the selected account and number.'],
  phone_not_in_selected_waba: ['blocking', 'asset', 'The selected number does not belong to this account.'],
  portfolio_identity_unverified: ['blocking', 'asset', 'We could not verify the account owner.'],
  portfolio_mismatch: ['blocking', 'asset', 'The selected account belongs to a different business.'],
  waba_assignment_unverified: ['blocking', 'authorization', 'We could not verify account management access.'],
  waba_assignment_missing: ['blocking', 'authorization', 'Account access has not been granted to the connection.'],
  waba_management_access_missing: ['blocking', 'authorization', 'Account management access is required to finish setup.'],
  phone_not_registered: ['blocking', 'phone', 'The number still needs to finish registration.'],
  phone_platform_unsupported: ['blocking', 'phone', 'This connection needs a supported WhatsApp setup.'],
  phone_mode_unverified: ['blocking', 'phone', 'We could not confirm that this number is available for production.'],
  phone_quality_limited: ['warning', 'phone', 'The number has a reduced quality rating.'],
  phone_verification_expired: ['warning', 'verification', 'A previous number verification has expired.'],
  phone_pin_not_enabled: ['warning', 'verification', 'Two-step verification is not enabled for this number.'],
  phone_registration_verification_required: ['blocking', 'verification', 'Please finish verifying this number before setup continues.'],
  phone_registration_pin_required: ['blocking', 'verification', 'Please confirm the existing two-step verification before setup continues.'],
  phone_display_name_limited: ['warning', 'verification', 'The display name may limit messaging availability.'],
  sending_health_unverified: ['blocking', 'waba', 'We could not verify current messaging availability.'],
  sending_health_blocked: ['blocking', 'waba', 'WhatsApp is currently blocking messaging for this connection.'],
  sending_health_limited: ['warning', 'waba', 'Messaging is available with account limits.'],
  billing_payment_blocked: ['blocking', 'billing', 'Please resolve the payment issue in your WhatsApp account.'],
  business_verification_limited: ['warning', 'verification', 'Business verification is still incomplete.'],
  app_subscription_unverified: ['blocking', 'subscription', 'We could not verify channel updates are connected.'],
  app_subscription_missing: ['blocking', 'subscription', 'Channel updates still need to be connected.'],
  template_lookup_unverified: ['blocking', 'template', 'We could not verify appointment reminder setup.'],
  template_missing_for_selected_waba: ['blocking', 'template', 'Appointment reminders need setup for this language.'],
  template_pending: ['blocking', 'template', 'Appointment reminders are awaiting approval for this language.'],
  template_rejected: ['blocking', 'template', 'Appointment reminders were not approved for this language.'],
  template_paused_disabled: ['blocking', 'template', 'Appointment reminders are unavailable for this language.'],
  template_incompatible: ['blocking', 'template', 'Appointment reminder setup needs attention for this language.'],
} as const satisfies Record<string, readonly [ProvisioningReason['severity'], ProvisioningReason['scope'], string]>;
export const WHATSAPP_PREFLIGHT_REASON_CODES = Object.keys(REASONS) as Array<keyof typeof REASONS>;
const str = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const id = (value: unknown): string | null => typeof value === 'string' && /^\d+$/u.test(value) ? value : null;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : [];
const health = (value: any): Health | null => value && typeof value === 'object' ? {
  can_send_message: str(value.can_send_message),
  entities: Array.isArray(value.entities) ? value.entities.map((entity: any) => ({
    entity_type: str(entity?.entity_type) || '', id: id(entity?.id) || '',
    can_send_message: str(entity?.can_send_message),
    error_codes: Array.isArray(entity?.errors) ? entity.errors.map((e: any) => e?.error_code).filter(Number.isSafeInteger) : [],
  })) : [],
} : null;

export async function inspectWhatsAppProvisioning(input: {
  authorization: TenantProvisioningAuthorization;
  wabaId: string;
  phoneNumberId: string;
  graphVersion?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<WhatsAppProvisioningPreflight> {
  const auth = input.authorization;
  const result: WhatsAppProvisioningPreflight = {
    provider: 'whatsapp', business_id: auth.businessId, checked_at: new Date((input.now || Date.now)()).toISOString(),
    ready: false, connection_ready: false, provisioning_ready: false, reminder_ready: false, delivery_ready: false, reasons: [],
    asset: { portfolio_id: null, portfolio_name: null, waba_id: input.wabaId, waba_name: null,
      phone_number_id: input.phoneNumberId, display_phone_number: null, verified_name: null, phone_belongs_to_waba: null },
    authorization: { token_valid: null, app_id: null, subject_id: null, effective_scopes: [], waba_tasks: null,
      management_access_sufficient: false, expires_at: null, data_access_expires_at: null },
    phone: { status: null, platform_type: null, account_mode: null, quality_rating: null, messaging_limit_tier: null,
      throughput: null, name_status: null, code_verification_status: null, is_pin_enabled: null, health: null },
    waba: { account_review_status: null, business_verification_status: null, sending_health: null,
      app_subscription_present: null, payment_blocked: false, business_verification_limited: false },
    templates: WHATSAPP_REMINDER_LANGUAGES.map(language => ({ booking_language: language, language_code: language,
      name: 'appointment_reminder', template_id: null, status: null, state: 'unverified', body_parameters: APPOINTMENT_TEMPLATE_FACTS })),
  };
  function reason(code: keyof typeof REASONS, details?: ProvisioningReason['details']) {
    const [severity, scope, message] = REASONS[code];
    result.reasons.push({ code, severity, scope, message, ...(details ? { details } : {}) });
  }
  const version = input.graphVersion || 'v25.0';
  if (!Number.isSafeInteger(auth.businessId) || auth.businessId <= 0 || !str(auth.authorizingUserId) ||
      !id(auth.appId) || !str(auth.accessToken) || !id(input.wabaId) || !id(input.phoneNumberId) ||
      auth.expectedPortfolioId != null && !id(auth.expectedPortfolioId) || !/^v\d+\.\d+$/u.test(version)) {
    reason('authorization_context_invalid'); return result;
  }
  const { read, list } = createWhatsAppMetaClient({ accessToken: auth.accessToken, graphVersion: version, fetchImpl: input.fetchImpl });
  const [debugResponse, waba, phones, phone, subscriptions, templates] = await Promise.all([
    read('debug_token', { input_token: auth.accessToken }),
    read(input.wabaId, { fields: 'id,name,owner_business_info,account_review_status,business_verification_status,health_status' }),
    list(`${input.wabaId}/phone_numbers`, { fields: 'id' }),
    read(input.phoneNumberId, { fields: 'id,display_phone_number,verified_name,status,platform_type,account_mode,quality_rating,messaging_limit_tier,throughput,name_status,code_verification_status,is_pin_enabled,health_status' }),
    list(`${input.wabaId}/subscribed_apps`),
    list(`${input.wabaId}/message_templates`, { name: 'appointment_reminder', fields: 'id,name,language,status,category,parameter_format,components' }),
  ]);
  const debug = debugResponse?.data;
  const scopes = strings(debug?.scopes);
  result.authorization.effective_scopes = [...new Set(scopes)];
  result.authorization.app_id = id(debug?.app_id);
  result.authorization.subject_id = id(debug?.user_id);
  for (const field of ['expires_at', 'data_access_expires_at'] as const) {
    result.authorization[field] = Number.isSafeInteger(debug?.[field]) && debug[field] >= 0 ? debug[field] : null;
  }
  const nowSeconds = (input.now || Date.now)() / 1000;
  result.authorization.token_valid = typeof debug?.is_valid === 'boolean' ? debug.is_valid &&
    ![result.authorization.expires_at, result.authorization.data_access_expires_at].some(expiry => expiry != null && expiry > 0 && expiry <= nowSeconds) : null;
  if (result.authorization.token_valid == null || !result.authorization.subject_id || !Array.isArray(debug?.scopes)) reason('authorization_unverified');
  else if (!result.authorization.token_valid) reason('authorization_invalid');
  const appMatches = result.authorization.app_id === auth.appId;
  if (debug && !appMatches) reason('authorization_app_mismatch');
  const requiredScopes = ['business_management', 'whatsapp_business_management', 'whatsapp_business_messaging'];
  const scopesSufficient = requiredScopes.every(scope => scopes.includes(scope));
  for (const scope of requiredScopes.filter(scope => !scopes.includes(scope))) reason('authorization_scope_missing', { permission: scope });
  // A granted scope can still be restricted to a different WABA. Absent target
  // lists need asset/assignment evidence below; an explicit exclusion fails.
  const assetScopesSufficient = !Array.isArray(debug?.granular_scopes) || !debug.granular_scopes.some((grant: any) =>
    ['whatsapp_business_management', 'whatsapp_business_messaging'].includes(grant?.scope) &&
    Array.isArray(grant?.target_ids) && !grant.target_ids.includes(input.wabaId));
  if (!assetScopesSufficient) reason('authorization_asset_scope_missing');
  const identityVerified = waba?.id === input.wabaId && phone?.id === input.phoneNumberId;
  if (!identityVerified || !phones) reason('asset_identity_unverified');
  result.asset.phone_belongs_to_waba = phones ? phones.some(p => p?.id === input.phoneNumberId) : null;
  if (result.asset.phone_belongs_to_waba === false) reason('phone_not_in_selected_waba');
  result.asset.portfolio_id = id(waba?.owner_business_info?.id);
  result.asset.portfolio_name = str(waba?.owner_business_info?.name);
  result.asset.waba_name = str(waba?.name);
  result.asset.display_phone_number = str(phone?.display_phone_number);
  result.asset.verified_name = str(phone?.verified_name);
  if (!result.asset.portfolio_id) reason('portfolio_identity_unverified');
  const portfolioMatches = !auth.expectedPortfolioId || result.asset.portfolio_id === auth.expectedPortfolioId;
  if (!portfolioMatches) reason('portfolio_mismatch');
  const users = result.asset.portfolio_id && result.authorization.subject_id ? await list(`${input.wabaId}/assigned_users`, {
    business: result.asset.portfolio_id, fields: 'id,tasks',
  }) : null;
  const assignments = users?.filter(user => user?.id === result.authorization.subject_id);
  if (!users) reason('waba_assignment_unverified');
  else if (assignments?.length !== 1) reason('waba_assignment_missing');
  else {
    result.authorization.waba_tasks = strings(assignments[0].tasks);
    if (!result.authorization.waba_tasks.includes('MANAGE')) reason('waba_management_access_missing');
  }
  result.connection_ready = result.authorization.token_valid === true && Boolean(result.authorization.subject_id) &&
    appMatches && scopesSufficient && assetScopesSufficient && identityVerified && result.asset.phone_belongs_to_waba === true && portfolioMatches;
  result.authorization.management_access_sufficient = result.connection_ready && Boolean(result.asset.portfolio_id) &&
    Boolean(result.authorization.waba_tasks?.includes('MANAGE'));
  for (const key of ['status', 'platform_type', 'account_mode', 'quality_rating', 'messaging_limit_tier', 'name_status', 'code_verification_status'] as const) {
    result.phone[key] = str(phone?.[key]);
  }
  result.phone.throughput = str(phone?.throughput?.level);
  result.phone.is_pin_enabled = typeof phone?.is_pin_enabled === 'boolean' ? phone.is_pin_enabled : null;
  result.phone.health = health(phone?.health_status);
  if (result.phone.status !== 'CONNECTED') reason('phone_not_registered');
  if (result.phone.platform_type !== 'CLOUD_API') reason('phone_platform_unsupported');
  if (result.phone.account_mode !== 'LIVE') reason('phone_mode_unverified');
  if (['YELLOW', 'RED'].includes(result.phone.quality_rating || '')) reason('phone_quality_limited');
  if (result.phone.code_verification_status === 'EXPIRED') reason('phone_verification_expired');
  if (result.phone.is_pin_enabled === false) reason('phone_pin_not_enabled');
  const registrationVerified = result.phone.status === 'CONNECTED' || result.phone.code_verification_status === 'VERIFIED';
  const registrationPinSafe = result.phone.status === 'CONNECTED' || result.phone.is_pin_enabled === false;
  if (!registrationVerified) reason('phone_registration_verification_required');
  if (!registrationPinSafe) reason('phone_registration_pin_required');
  if (result.phone.name_status !== 'APPROVED') reason('phone_display_name_limited');
  result.waba.account_review_status = str(waba?.account_review_status);
  result.waba.business_verification_status = str(waba?.business_verification_status);
  const wabaHealth = health(waba?.health_status);
  const entities = [...(result.phone.health?.entities || []), ...(wabaHealth?.entities || [])];
  result.waba.sending_health = wabaHealth?.can_send_message || entities.find(e => e.entity_type === 'WABA' && e.id === input.wabaId)?.can_send_message || null;
  result.waba.payment_blocked = entities.some(e => e.error_codes.includes(141006));
  result.waba.business_verification_limited = result.waba.business_verification_status !== 'verified' || entities.some(e => e.error_codes.includes(141010));
  if (result.waba.payment_blocked) reason('billing_payment_blocked', { provider_code: 141006 });
  if (result.waba.business_verification_limited) reason('business_verification_limited');
  const healthStates = [result.phone.health?.can_send_message, result.waba.sending_health];
  const healthVerified = healthStates.every(state => ['AVAILABLE', 'LIMITED', 'BLOCKED'].includes(state || ''));
  const healthBlocked = healthStates.includes('BLOCKED') || entities.some(e => e.can_send_message === 'BLOCKED');
  if (!healthVerified) reason('sending_health_unverified');
  if (healthBlocked) reason('sending_health_blocked');
  else if (healthStates.includes('LIMITED') || entities.some(e => e.can_send_message === 'LIMITED')) reason('sending_health_limited');
  result.waba.app_subscription_present = subscriptions ? subscriptions.some(s =>
    s?.whatsapp_business_api_data?.id === auth.appId || s?.id === auth.appId) : null;
  if (result.waba.app_subscription_present == null) reason('app_subscription_unverified');
  else if (!result.waba.app_subscription_present) reason('app_subscription_missing');
  // Missing templates or billing do not remove proven management access. Unknown
  // phone/subscription state must still stop the existing registration boundary.
  result.provisioning_ready = result.authorization.management_access_sufficient && Boolean(result.phone.status) &&
    result.phone.platform_type === 'CLOUD_API' && result.phone.account_mode === 'LIVE' &&
    registrationVerified && registrationPinSafe && result.waba.app_subscription_present != null;
  if (!templates) reason('template_lookup_unverified');
  for (const entry of result.templates) {
    if (!templates) continue;
    const matches = templates.filter(t => t?.name === entry.name && t?.language === entry.language_code);
    if (!matches.length) { entry.state = 'missing'; reason('template_missing_for_selected_waba', { language: entry.booking_language }); continue; }
    const template = matches[0];
    entry.template_id = id(template?.id); entry.status = str(template?.status);
    if (matches.length !== 1 || !entry.template_id) entry.state = 'incompatible';
    else if (['PENDING', 'IN_APPEAL'].includes(entry.status || '')) entry.state = 'pending';
    else if (entry.status === 'REJECTED') entry.state = 'rejected';
    else if (['PAUSED', 'DISABLED'].includes(entry.status || '')) entry.state = 'paused_disabled';
    else if (entry.status !== 'APPROVED' || template.category !== 'UTILITY' ||
      !hasCompatibleAppointmentTemplateBody(template, APPOINTMENT_TEMPLATE_FACTS.length, true)) entry.state = 'incompatible';
    else entry.state = 'approved_compatible';
    const code = { pending: 'template_pending', rejected: 'template_rejected', paused_disabled: 'template_paused_disabled', incompatible: 'template_incompatible' } as const;
    if (entry.state in code) reason(code[entry.state as keyof typeof code], { language: entry.booking_language });
  }
  result.reminder_ready = result.connection_ready && result.templates.every(t => t.state === 'approved_compatible');
  result.delivery_ready = result.connection_ready && result.phone.status === 'CONNECTED' && result.phone.platform_type === 'CLOUD_API' &&
    result.phone.account_mode === 'LIVE' && healthVerified && !healthBlocked && !result.waba.payment_blocked && result.waba.app_subscription_present === true;
  result.ready = result.connection_ready && result.provisioning_ready && result.reminder_ready && result.delivery_ready;
  return result;
}
