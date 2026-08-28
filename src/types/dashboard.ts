import type { BusinessToneConfig } from '../ai/tone-controls';

export type LanguageCode = 'en' | 'sv' | 'de' | 'es' | 'fa' | 'ar';

export type IntegrationKey =
  | 'instagram'
  | 'telegram'
  | 'messenger'
  | 'whatsapp'
  | 'google_calendar';

export type IntegrationStatus =
  | 'connected'
  | 'synced'
  | 'checking'
  | 'setup_required'
  | 'degraded'
  | 'disconnected'
  | 'unknown'
  | 'error';

export interface BusinessService {
  name: string;
  durationMinutes: number;
  price: number | null;
  currency: string;
  active: boolean;
}

export interface Business {
  id: string;
  name: string;
  industry?: string;
  timezone?: string;
  language?: LanguageCode;
  plan?: string;
  systemPrompt?: string;
  toneConfig?: BusinessToneConfig;
  services?: BusinessService[];
  calendarId?: string;
  bokadirektBusinessId?: string;
  telegramToken?: string;
  telegramAdminChatId?: string;
  instagramPageId?: string;
  instagramAccountId?: string;
  instagramAccessToken?: string;
  instagramWebhookVerifyToken?: string;
  messengerPageId?: string;
  messengerAccessToken?: string;
  messengerAppSecret?: string;
  messengerWebhookVerifyToken?: string;
  whatsappPhoneNumberId?: string;
  whatsappBusinessAccountId?: string;
  whatsappAccessToken?: string;
  whatsappWebhookVerifyToken?: string;
  workingHours?: Partial<Record<
    'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday',
    Array<{ start: string; end: string }>
  >>;

}

export interface BusinessStats {
  todaysBookings: number;
  estimatedRevenue?: number;
  missedConversations: number;
  conversionRate: number;
  aiRepliesUsed: number;
  aiRepliesLimit: number;
  aiSavedMinutes: number;
  customersServedOffline: number;
}

export interface IntegrationHealth {
  key: IntegrationKey;
  label: string;
  status: IntegrationStatus;
  detail: string;
  lastCheckedAt?: string | null;
  stale?: boolean;
  refreshInProgress?: boolean;
  reasonCode?:
    | 'verified'
    | 'not_configured'
    | 'not_yet_checked'
    | 'check_in_progress'
    | 'authorization_invalid'
    | 'provider_unavailable'
    | 'rate_limited'
    | 'timeout'
    | 'check_failed';
  action?: 'complete_setup' | 'check_now' | 'retry' | 'reconnect';
}

export interface PlatformPerformance {
  handledAutomatically: number;
  escalatedToHuman: number;
  bookingSuccess: number;
  averageReplySeconds: number;
}

export type ConversationStatus = 'open' | 'booked' | 'pending' | 'handled' | 'escalated';

export interface ConversationMessage {
  id: string;
  author: 'customer' | 'ai' | 'human' | 'system';
  text: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  customerName: string;
  channel: IntegrationKey;
  status: ConversationStatus;
  preview: string;
  updatedAt: string;
  unreadCount?: number;
  messages: ConversationMessage[];
}

export interface ConversationPage {
  items: Conversation[];
  pagination: {
    nextCursor: number | null;
    hasMore: boolean;
    total: number;
  };
}

export interface ConversationThreadPage {
  conversationId: string;
  messages: ConversationMessage[];
  pagination: {
    nextCursor: number | null;
    hasMore: boolean;
  };
}

export type BookingStatus = 'confirmed' | 'pending' | 'cancelled' | 'completed' | 'unknown';
export type BookingView = 'upcoming' | 'pending' | 'past' | 'cancelled' | 'all';

export interface Booking {
  id: string;
  customerName: string;
  serviceName?: string;
  channel: IntegrationKey;
  status: BookingStatus;
  startsAt: string;
  endsAt?: string;
  createdAt?: string;
}

export interface BookingPage {
  items: Booking[];
  summary: {
    today: number;
    upcoming: number;
    pending: number;
    cancelled: number;
    scanTruncated: boolean;
  };
  pagination: {
    nextCursor: number | null;
    hasMore: boolean;
    total: number;
  };
}

export type ActivityCategory = 'bookings' | 'conversations';
export type ActivityEventType =
  | 'booking_confirmed'
  | 'booking_cancelled'
  | 'booking_rescheduled'
  | 'booking_failed'
  | 'conversation_started';

export interface ActivityEvent {
  key: string;
  type: ActivityEventType;
  category: ActivityCategory;
  title: string;
  detail?: string;
  occurredAt: string;
  channel?: IntegrationKey;
  severity: 'info' | 'success' | 'warning' | 'error';
  count?: number;
}

export interface ActivityPage {
  items: ActivityEvent[];
  pagination: {
    nextCursor: number | null;
    hasMore: boolean;
  };
}

export type NotificationCategory = 'integration' | 'booking';
export type NotificationSeverity = 'info' | 'attention' | 'critical';
export type NotificationFilter = 'all' | 'unread' | 'attention';

export interface NotificationItem {
  id: string;
  category: NotificationCategory;
  severity: NotificationSeverity;
  title: string;
  description: string;
  firstObservedAt: string;
  lastObservedAt: string;
  read: boolean;
  active: boolean;
  actionType?: 'open_health' | 'open_activity';
  actionTarget?: '#health' | '#activity';
}

export interface NotificationPage {
  items: NotificationItem[];
  unreadCount: number;
  pagination: {
    nextCursor: number | null;
    hasMore: boolean;
  };
}

export interface UsageInfo {
  plan: string;
  used: number;
  limit: number;
}

export interface DashboardData {
  businesses: Business[];
  selectedBusiness?: Business;
  stats: BusinessStats;
  health: IntegrationHealth[];
  performance: PlatformPerformance;
  conversations: Conversation[];
  bookings: Booking[];
  usage: UsageInfo;
  bookingsChart: Array<{ label: string; value: number }>;
  dashboardSummary: import('../dashboard/contracts').DashboardSummaryState;
}
