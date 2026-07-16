export type LanguageCode = 'en' | 'sv' | 'de' | 'es' | 'fa' | 'ar';

export type IntegrationKey =
  | 'instagram'
  | 'telegram'
  | 'messenger'
  | 'whatsapp'
  | 'google_calendar';

export type IntegrationStatus = 'connected' | 'synced' | 'setup_required' | 'disconnected' | 'error';

export interface Business {
  id: string;
  name: string;
  industry?: string;
  timezone?: string;
  language?: LanguageCode;
  plan?: string;
  systemPrompt?: string;
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

export type BookingStatus = 'confirmed' | 'pending' | 'cancelled' | 'completed';

export interface Booking {
  id: string;
  customerName: string;
  serviceName?: string;
  channel: IntegrationKey;
  status: BookingStatus;
  startsAt: string;
  endsAt?: string;
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
}
