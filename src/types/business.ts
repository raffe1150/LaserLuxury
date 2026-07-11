export interface Business {
  id: string;
  name: string;
  industry?: string;
  timezone?: string;
  language?: string;
  systemPrompt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Appointment {
  id: string;
  businessId: string;
  customerName?: string;
  serviceName?: string;
  startsAt: string;
  endsAt?: string;
  status: 'pending' | 'confirmed' | 'completed' | 'cancelled';
  channel?: string;
}

export interface UsageStat {
  businessId: string;
  periodStart: string;
  periodEnd: string;
  aiRepliesUsed: number;
  aiRepliesLimit: number;
}

export interface MessageUsage {
  businessId: string;
  channel: string;
  inbound: number;
  outbound: number;
  aiHandled: number;
}

export interface ChatMessage {
  id: string;
  businessId: string;
  conversationId: string;
  sender: 'customer' | 'ai' | 'human' | 'system';
  text: string;
  createdAt: string;
}

export interface ChannelConnection {
  businessId: string;
  channel: 'instagram' | 'telegram' | 'messenger' | 'whatsapp' | 'google_calendar';
  enabled: boolean;
  status: 'connected' | 'synced' | 'setup_required' | 'disconnected' | 'error';
  maskedCredential?: string;
  updatedAt?: string;
}

