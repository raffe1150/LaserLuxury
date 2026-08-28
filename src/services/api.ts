import type {
  Booking,
  BookingPage,
  BookingView,
  ActivityCategory,
  ActivityPage,
  Business,
  BusinessStats,
  Conversation,
  ConversationPage,
  ConversationThreadPage,
  DashboardData,
  IntegrationHealth,
  IntegrationKey,
  NotificationFilter,
  NotificationPage,
  PlatformPerformance,
  UsageInfo,
} from '../types/dashboard';
import { getBrowserSupabaseClient, getCurrentAccessToken } from '../auth/supabase-browser';
import type {
  AnalyticsReconciliationStatus,
  BusinessAnalyticsApiRequest,
  BusinessAnalyticsApiResponse,
} from '../analytics/api-contracts';
import type { DashboardTodaySummary } from '../dashboard/contracts';
import { normalizeBusinessToneConfig } from '../ai/tone-controls';
import type { ConversationActivityRange, ConversationStatusFilter } from '../conversations/inbox';

const API_BASE = import.meta.env?.VITE_API_BASE_URL || '';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: 'unauthenticated' | 'forbidden' | 'request_failed';

  constructor(status: number, code: ApiRequestError['code'], message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }
}

let invalidSessionCleanup: Promise<unknown> | null = null;

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const accessToken = await getCurrentAccessToken();
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(init?.headers || {}),
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      if (!invalidSessionCleanup) {
        try {
          invalidSessionCleanup = getBrowserSupabaseClient().auth.signOut({ scope: 'local' })
            .catch(() => undefined)
            .finally(() => { invalidSessionCleanup = null; });
        } catch {
          invalidSessionCleanup = null;
        }
      }
      throw new ApiRequestError(401, 'unauthenticated', 'Your session has expired. Please sign in again.');
    }
    if (response.status === 403) {
      throw new ApiRequestError(403, 'forbidden', 'You do not have permission to perform this action.');
    }
    const message = await response.text().catch(() => response.statusText);
    throw new ApiRequestError(response.status, 'request_failed', message || `Request failed with status ${response.status}`);
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

function analyticsWindowQuery(window: BusinessAnalyticsApiRequest): string {
  const query = new URLSearchParams({ window: window.preset });
  if (window.preset === 'custom') {
    query.set('startDate', window.startDate);
    query.set('endDate', window.endDate);
  }
  return query.toString();
}

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
  updateBusinessSettings: (businessId: string, payload: Record<string, unknown>) =>
    request<Business>(`/api/businesses/${businessId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }).then(normalizeBusiness),
  deleteBusiness: (businessId: string) =>
    request<{ ok: boolean }>(`/api/businesses/${businessId}`, {
      method: 'DELETE',
    }),
  getBusinessStats: (businessId: string) =>
    request<BusinessStats>(`/api/businesses/${businessId}/stats`),
  getBusinessAnalyticsSummary: (
    businessId: string,
    window: BusinessAnalyticsApiRequest,
    signal?: AbortSignal,
  ) => request<BusinessAnalyticsApiResponse>(
    `/api/businesses/${encodeURIComponent(businessId)}/analytics/summary?${analyticsWindowQuery(window)}`,
    { signal },
  ),
  getBusinessAnalyticsReconciliation: (
    businessId: string,
    window: BusinessAnalyticsApiRequest,
  ) => request<AnalyticsReconciliationStatus>(
    `/api/businesses/${encodeURIComponent(businessId)}/analytics/reconciliation?${analyticsWindowQuery(window)}`,
  ),
  getDashboardSummary: (businessId: string, signal?: AbortSignal) =>
    request<DashboardTodaySummary>(
      `/api/businesses/${encodeURIComponent(businessId)}/dashboard/summary`,
      { signal },
    ),
  getIntegrationHealth: (businessId: string, signal?: AbortSignal) =>
    request<IntegrationHealth[]>(`/api/businesses/${businessId}/integrations/health`, { signal }),
  refreshIntegrationHealth: (
    businessId: string,
    integration: IntegrationKey,
    force = false,
    signal?: AbortSignal,
  ) => request<{ success: boolean; data: IntegrationHealth }>(
    `/api/businesses/${encodeURIComponent(businessId)}/integrations/health/refresh`,
    {
      method: 'POST',
      body: JSON.stringify({ integration, force }),
      signal,
    },
  ),
  getPlatformPerformance: (businessId: string) =>
    request<PlatformPerformance>(`/api/businesses/${businessId}/performance`),
  getConversationPage: (
    businessId: string,
    options: { limit?: number; cursor?: number; search?: string; channel?: string; status?: ConversationStatusFilter; range?: ConversationActivityRange } = {},
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams();
    if (options.limit) query.set('limit', String(options.limit));
    if (options.cursor) query.set('cursor', String(options.cursor));
    if (options.search) query.set('search', options.search);
    if (options.channel && options.channel !== 'all') query.set('channel', options.channel);
    if (options.status && options.status !== 'all') query.set('status', options.status);
    if (options.range && options.range !== 'recent') query.set('range', options.range);
    return request<ConversationPage>(
      `/api/businesses/${encodeURIComponent(businessId)}/conversations?${query}`,
      { signal },
    );
  },
  getConversations: (businessId: string) =>
    api.getConversationPage(businessId, { limit: 50 }).then((page) => page.items),
  getConversationThread: (
    businessId: string,
    conversationId: string,
    options: { limit?: number; cursor?: number } = {},
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams();
    if (options.limit) query.set('limit', String(options.limit));
    if (options.cursor) query.set('cursor', String(options.cursor));
    return request<ConversationThreadPage>(
      `/api/businesses/${encodeURIComponent(businessId)}/conversations/${encodeURIComponent(conversationId)}?${query}`,
      { signal },
    );
  },
  markConversationRead: (businessId: string, conversationId: string) =>
    request<{ success: boolean; updatedCount?: number }>(
      `/api/businesses/${businessId}/conversations/${encodeURIComponent(
        conversationId,
      )}/read`,
      {
        method: 'PUT',
      },
    ),
  sendConversationMessage: (
    businessId: string,
    conversationId: string,
    text: string,
  ) =>
    request<{ success: boolean; messageId?: string; createdAt?: string }>(
      `/api/businesses/${businessId}/conversations/${encodeURIComponent(
        conversationId,
      )}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ text }),
      },
    ),
  getBookings: (businessId: string) =>
    request<Booking[]>(`/api/businesses/${businessId}/bookings`),
  getBookingPage: (
    businessId: string,
    options: { limit?: number; cursor?: number; view?: BookingView; search?: string; timezone?: string } = {},
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams();
    query.set('limit', String(options.limit || 25));
    query.set('view', options.view || 'upcoming');
    if (options.cursor) query.set('cursor', String(options.cursor));
    if (options.search) query.set('search', options.search);
    if (options.timezone) query.set('timezone', options.timezone);
    return request<BookingPage>(
      `/api/businesses/${encodeURIComponent(businessId)}/bookings?${query}`,
      { signal },
    );
  },
  getActivityPage: (
    businessId: string,
    options: { limit?: number; cursor?: number; category?: 'all' | ActivityCategory } = {},
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams();
    query.set('limit', String(options.limit || 30));
    if (options.cursor) query.set('cursor', String(options.cursor));
    if (options.category && options.category !== 'all') query.set('category', options.category);
    return request<ActivityPage>(
      `/api/businesses/${encodeURIComponent(businessId)}/activity?${query}`,
      { signal },
    );
  },
  getNotificationPage: (
    businessId: string,
    options: { limit?: number; cursor?: number; filter?: NotificationFilter } = {},
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams();
    query.set('limit', String(options.limit || 25));
    if (options.cursor) query.set('cursor', String(options.cursor));
    if (options.filter && options.filter !== 'all') query.set('filter', options.filter);
    return request<NotificationPage>(
      `/api/businesses/${encodeURIComponent(businessId)}/notifications?${query}`,
      { signal },
    );
  },
  markNotificationRead: (businessId: string, notificationId: string) =>
    request<{ success: boolean; unreadCount: number }>(
      `/api/businesses/${encodeURIComponent(businessId)}/notifications/${encodeURIComponent(notificationId)}/read`,
      { method: 'PUT' },
    ),
  markAllNotificationsRead: (businessId: string) =>
    request<{ success: boolean; unreadCount: number }>(
      `/api/businesses/${encodeURIComponent(businessId)}/notifications/read-all`,
      { method: 'PUT' },
    ),
  getUsage: (businessId: string) =>
    request<UsageInfo>(`/api/businesses/${businessId}/usage`),
  getCancellationSettings: (businessId: string) =>
    request<{ success: boolean; data: Record<string, unknown> }>(
      `/api/businesses/${businessId}/cancellation-settings`,
    ),
  getAdminNotificationSettings: (businessId: string) =>
    request<{ success: boolean; data: Record<string, unknown> }>(
      `/api/businesses/${businessId}/admin-notification-settings`,
    ),
  testIntegration: (businessId: string, integration: string) =>
    request<{ ok: boolean; message: string }>(
      `/api/businesses/${businessId}/integrations/${integration}/test`,
      { method: 'POST' },
    ),
  generateSystemPrompt: (
    payload: {
      businessName: string;
      businessType: string;
      tone: string;
      bookingRules: string;
      escalationRules: string;
    },
    signal?: AbortSignal,
  ) =>
    request<{ success: boolean; prompt: string }>('/api/ai/generate-system-prompt', {
      method: 'POST',
      body: JSON.stringify(payload),
      signal,
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

export function normalizeBusiness(row: unknown): Business {
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
    workingHours:
      item.working_hours && typeof item.working_hours === 'object'
        ? item.working_hours as Business['workingHours']
        : item.workingHours && typeof item.workingHours === 'object'
          ? item.workingHours as Business['workingHours']
          : undefined,
    language: optionalString(item.language || item.default_language || item.defaultLanguage) as Business['language'],
    plan: optionalString(item.plan || item.subscription_plan || item.subscriptionPlan),
    systemPrompt: optionalString(
      item.custom_system_prompt || item.system_prompt || item.systemPrompt || item.prompt,
    ),
    toneConfig: normalizeBusinessToneConfig(item.ai_tone_config || item.toneConfig || item.tone_config),
    services: Array.isArray(item.services)
      ? item.services
          .filter(
            (service): service is Record<string, unknown> =>
              Boolean(service) &&
              typeof service === 'object' &&
              !Array.isArray(service),
          )
          .map((service) => ({
            name: stringValue(service.name).trim(),
            durationMinutes: Number(
              service.durationMinutes ?? service.duration_minutes ?? 0,
            ),
            price:
              service.price === null ||
              service.price === undefined ||
              service.price === ''
                ? null
                : Number(service.price),
            currency: stringValue(service.currency || 'SEK')
              .trim()
              .toUpperCase(),
            active:
              service.active === undefined
                ? true
                : Boolean(service.active),
          }))
          .filter(
            (service) =>
              Boolean(service.name) &&
              Number.isFinite(service.durationMinutes) &&
              service.durationMinutes > 0,
          )
      : undefined,
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

export function toBackendBusinessPayload(payload: Partial<Business>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  setAliases(out, ['businessName', 'business_name', 'name'], payload.name);
  setAliases(out, ['businessType', 'business_type', 'industry'], payload.industry);
  setAliases(out, ['timezone', 'time_zone'], payload.timezone);
  setAliases(out, ['workingHours', 'working_hours'], payload.workingHours);
  setAliases(out, ['services'], payload.services);
  setAliases(out, ['language', 'default_language'], payload.language);
  setAliases(out, ['plan', 'subscription_plan'], payload.plan);
  setAliases(out, ['systemPrompt', 'custom_system_prompt', 'system_prompt'], payload.systemPrompt);
  setAliases(out, ['ai_tone_config'], payload.toneConfig);
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
      dashboardSummary: { status: 'unavailable' },
    };
  }

  const [stats, health, performance, conversations, bookings, usage, dashboardSummary] = await Promise.all([
    api.getBusinessStats(selectedBusiness.id).catch(() => emptyStats),
    api.getIntegrationHealth(selectedBusiness.id).catch(() => defaultHealth),
    api.getPlatformPerformance(selectedBusiness.id).catch(() => defaultPerformance),
    api.getConversations(selectedBusiness.id).catch(() => []),
    api.getBookings(selectedBusiness.id).catch(() => []),
    api.getUsage(selectedBusiness.id).catch(() => defaultUsage),
    api.getDashboardSummary(selectedBusiness.id)
      .then((summary) => ({ status: 'available' as const, data: summary }))
      .catch(() => ({ status: 'unavailable' as const })),
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
    dashboardSummary,
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
