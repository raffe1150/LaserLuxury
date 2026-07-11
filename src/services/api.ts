import type {
  Booking,
  Business,
  BusinessStats,
  Conversation,
  DashboardData,
  IntegrationHealth,
  PlatformPerformance,
  UsageInfo,
} from '../types/dashboard';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
    ...init,
  });

  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new Error(message || `Request failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
}

const emptyStats: BusinessStats = {
  todaysBookings: 0,
  missedConversations: 0,
  conversionRate: 0,
  aiRepliesUsed: 0,
  aiRepliesLimit: 0,
  aiSavedMinutes: 0,
  customersServedOffline: 0,
};

const defaultHealth: IntegrationHealth[] = [
  { key: 'instagram', label: 'Instagram', status: 'setup_required', detail: 'Setup required' },
  { key: 'messenger', label: 'Facebook Messenger', status: 'setup_required', detail: 'Setup required' },
  { key: 'telegram', label: 'Telegram', status: 'setup_required', detail: 'Setup required' },
  { key: 'google_calendar', label: 'Google Calendar', status: 'setup_required', detail: 'Setup required' },
  { key: 'whatsapp', label: 'WhatsApp', status: 'setup_required', detail: 'Setup required' },
];

const defaultPerformance: PlatformPerformance = {
  handledAutomatically: 0,
  escalatedToHuman: 0,
  bookingSuccess: 0,
  averageReplySeconds: 0,
};

const defaultUsage: UsageInfo = {
  plan: 'Not selected',
  used: 0,
  limit: 0,
};

export const api = {
  getBusinesses: async () => normalizeBusinesses(await request<unknown>('/api/businesses')),
  createBusiness: (payload: Partial<Business>) =>
    request<Business>('/api/businesses', {
      method: 'POST',
      body: JSON.stringify(toBackendBusinessPayload(payload)),
    }).then(normalizeBusiness),
  updateBusiness: (businessId: string, payload: Partial<Business>) =>
    request<Business>(`/api/businesses/${businessId}`, {
      method: 'PUT',
      body: JSON.stringify(toBackendBusinessPayload(payload)),
    }).then(normalizeBusiness),
  deleteBusiness: (businessId: string) =>
    request<{ ok: boolean }>(`/api/businesses/${businessId}`, {
      method: 'DELETE',
    }),
  // TODO backend: confirm exact endpoint for business_usage_stats.
  getBusinessStats: (businessId: string) =>
    request<BusinessStats>(`/api/businesses/${businessId}/stats`),
  // TODO backend: confirm exact endpoint for channel connection health.
  getIntegrationHealth: (businessId: string) =>
    request<IntegrationHealth[]>(`/api/businesses/${businessId}/integrations/health`),
  // TODO backend: confirm exact endpoint for derived platform performance.
  getPlatformPerformance: (businessId: string) =>
    request<PlatformPerformance>(`/api/businesses/${businessId}/performance`),
  // TODO backend: confirm exact endpoint for chat_history.
  getConversations: (businessId: string) =>
    request<Conversation[]>(`/api/businesses/${businessId}/conversations`),
  // TODO backend: confirm exact endpoint for appointments/bookings.
  getBookings: (businessId: string) => request<Booking[]>(`/api/businesses/${businessId}/bookings`),
  // TODO backend: confirm exact endpoint for message_usage.
  getUsage: (businessId: string) => request<UsageInfo>(`/api/businesses/${businessId}/usage`),
  // TODO backend: credential updates should be accepted server-side and stored securely.
  testIntegration: (businessId: string, integration: string) =>
    request<{ ok: boolean; message: string }>(
      `/api/businesses/${businessId}/integrations/${integration}/test`,
      { method: 'POST' },
    ),
  // TODO backend: implement prompt generation server-side. Never call model providers with secrets from the browser.
  generatePrompt: (payload: { name: string; services: string; hours: string; tone: string }) =>
    request<{ prompt: string }>('/api/ai/prompt', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};

function normalizeBusinesses(response: unknown): Business[] {
  const envelope = response as { businesses?: unknown; data?: unknown };
  const rows = Array.isArray(response)
    ? response
    : Array.isArray(envelope.businesses)
      ? envelope.businesses
      : Array.isArray(envelope.data)
        ? envelope.data
        : [];

  return rows.map(normalizeBusiness);
}

function normalizeBusiness(row: unknown): Business {
  const raw = (row || {}) as Record<string, unknown>;
  const item = ((raw.business || raw.data || raw) || {}) as Record<string, unknown>;
  const id = stringValue(item.id || item.business_id || item.businessId);
  const name = stringValue(
    item.name || item.business_name || item.businessName || item.company_name || item.companyName,
  );

  return {
    id,
    name,
    industry: optionalString(item.industry || item.business_type || item.businessType),
    timezone: optionalString(item.timezone || item.time_zone || item.timeZone),
    language: optionalString(item.language || item.default_language || item.defaultLanguage) as Business['language'],
    plan: optionalString(item.plan || item.subscription_plan || item.subscriptionPlan),
    systemPrompt: optionalString(
      item.custom_system_prompt || item.system_prompt || item.systemPrompt || item.prompt,
    ),
    calendarId: optionalString(item.calendar_id || item.calendarId || item.google_calendar_id || item.googleCalendarId),
    bokadirektBusinessId: optionalString(item.bokadirekt_business_id || item.bokadirektBusinessId),
    telegramToken: optionalString(item.telegram_bot_token || item.telegram_token || item.telegramToken),
    telegramAdminChatId: optionalString(item.telegram_admin_chat_id || item.telegramAdminChatId),
    instagramPageId: optionalString(item.instagram_page_id || item.instagramPageId),
    instagramAccountId: optionalString(item.instagram_account_id || item.instagramAccountId),
    instagramAccessToken: optionalString(item.instagram_access_token || item.instagramAccessToken),
    instagramWebhookVerifyToken: optionalString(
      item.instagram_verify_token || item.instagram_webhook_verify_token || item.instagramWebhookVerifyToken,
    ),
    messengerPageId: optionalString(item.messenger_page_id || item.facebook_page_id || item.messengerPageId || item.facebookPageId),
    messengerAccessToken: optionalString(
      item.messenger_page_access_token || item.messenger_access_token || item.facebook_page_access_token || item.messengerAccessToken || item.facebookPageAccessToken,
    ),
    messengerAppSecret: optionalString(item.messenger_app_secret || item.facebook_app_secret || item.messengerAppSecret || item.facebookAppSecret),
    messengerWebhookVerifyToken: optionalString(
      item.messenger_webhook_verify_token || item.facebook_webhook_verify_token || item.messengerWebhookVerifyToken || item.facebookWebhookVerifyToken,
    ),
    whatsappPhoneNumberId: optionalString(item.whatsapp_phone_number_id || item.whatsappPhoneNumberId),
    whatsappBusinessAccountId: optionalString(item.whatsapp_business_account_id || item.whatsappBusinessAccountId || item.waba_id || item.wabaId),
    whatsappAccessToken: optionalString(item.whatsapp_access_token || item.whatsappAccessToken),
    whatsappWebhookVerifyToken: optionalString(item.whatsapp_webhook_verify_token || item.whatsappWebhookVerifyToken),
  };
}

function toBackendBusinessPayload(payload: Partial<Business>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  setAliases(out, ['businessName', 'business_name', 'name'], payload.name);
  setAliases(out, ['businessType', 'business_type', 'industry'], payload.industry);
  setAliases(out, ['timezone', 'time_zone'], payload.timezone);
  setAliases(out, ['language', 'default_language'], payload.language);
  setAliases(out, ['plan', 'subscription_plan'], payload.plan);
  setAliases(out, ['systemPrompt', 'custom_system_prompt', 'system_prompt'], payload.systemPrompt);
  setAliases(out, ['calendarId', 'calendar_id', 'google_calendar_id'], payload.calendarId);
  setAliases(out, ['bokadirektBusinessId', 'bokadirekt_business_id'], payload.bokadirektBusinessId);
  setAliases(out, ['telegramToken', 'telegram_bot_token', 'telegram_token'], payload.telegramToken, true);
  setAliases(out, ['telegramAdminChatId', 'telegram_admin_chat_id'], payload.telegramAdminChatId);
  setAliases(out, ['instagramPageId', 'instagram_page_id'], payload.instagramPageId);
  setAliases(out, ['instagramAccountId', 'instagram_account_id'], payload.instagramAccountId);
  setAliases(out, ['instagramAccessToken', 'instagram_access_token'], payload.instagramAccessToken, true);
  setAliases(
    out,
    ['instagramWebhookVerifyToken', 'instagram_verify_token', 'instagram_webhook_verify_token'],
    payload.instagramWebhookVerifyToken,
    true,
  );
  setAliases(out, ['messengerPageId', 'messenger_page_id', 'facebook_page_id'], payload.messengerPageId);
  setAliases(
    out,
    ['messengerAccessToken', 'messenger_page_access_token', 'messenger_access_token', 'facebook_page_access_token'],
    payload.messengerAccessToken,
    true,
  );
  setAliases(out, ['messengerAppSecret', 'messenger_app_secret', 'facebook_app_secret'], payload.messengerAppSecret, true);
  setAliases(
    out,
    ['messengerWebhookVerifyToken', 'messenger_webhook_verify_token', 'facebook_webhook_verify_token'],
    payload.messengerWebhookVerifyToken,
    true,
  );
  setAliases(out, ['whatsappPhoneNumberId', 'whatsapp_phone_number_id'], payload.whatsappPhoneNumberId);
  setAliases(out, ['whatsappBusinessAccountId', 'whatsapp_business_account_id', 'waba_id'], payload.whatsappBusinessAccountId);
  setAliases(out, ['whatsappAccessToken', 'whatsapp_access_token'], payload.whatsappAccessToken, true);
  setAliases(out, ['whatsappWebhookVerifyToken', 'whatsapp_webhook_verify_token'], payload.whatsappWebhookVerifyToken, true);
  return out;
}

function setAliases(out: Record<string, unknown>, keys: string[], value: unknown, secret = false) {
  if (value === undefined) return;
  if (secret && typeof value === 'string' && value.trim() === '') return;
  keys.forEach((key) => {
    out[key] = value;
  });
}

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function optionalString(value: unknown): string | undefined {
  const normalized = stringValue(value);
  return normalized || undefined;
}

export async function loadDashboardData(selectedBusinessId?: string): Promise<DashboardData> {
  const businesses = await api.getBusinesses();
  const selectedBusiness =
    businesses.find((business) => business.id === selectedBusinessId) || businesses[0];

  if (!selectedBusiness) {
    return {
      businesses,
      selectedBusiness,
      stats: emptyStats,
      health: defaultHealth,
      performance: defaultPerformance,
      conversations: [],
      bookings: [],
      usage: defaultUsage,
      bookingsChart: [],
    };
  }

  const [stats, health, performance, conversations, bookings, usage] = await Promise.all([
    api.getBusinessStats(selectedBusiness.id).catch(() => emptyStats),
    api.getIntegrationHealth(selectedBusiness.id).catch(() => defaultHealth),
    api.getPlatformPerformance(selectedBusiness.id).catch(() => defaultPerformance),
    api.getConversations(selectedBusiness.id).catch(() => []),
    api.getBookings(selectedBusiness.id).catch(() => []),
    api.getUsage(selectedBusiness.id).catch(() => defaultUsage),
  ]);

  return {
    businesses,
    selectedBusiness,
    stats,
    health,
    performance,
    conversations,
    bookings,
    usage,
    bookingsChart: buildBookingsChart(bookings),
  };
}

function buildBookingsChart(bookings: Booking[]) {
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const totals = new Map(labels.map((label) => [label, 0]));

  bookings.forEach((booking) => {
    const label = new Intl.DateTimeFormat('en', { weekday: 'short' }).format(
      new Date(booking.startsAt),
    );
    totals.set(label, (totals.get(label) || 0) + 1);
  });

  return labels.map((label) => ({ label, value: totals.get(label) || 0 }));
}
