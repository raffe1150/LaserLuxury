import type {
  Conversation,
  ConversationMessage,
  ConversationStatus,
  IntegrationKey,
} from '../types/dashboard';

export interface ConversationSourceRow {
  id: string | number;
  business_id?: string | number | null;
  user_id?: string | null;
  platform?: string | null;
  sender?: string | null;
  message?: string | null;
  created_at?: string | null;
  is_read?: boolean | null;
}

export interface ConversationCustomerRow {
  business_id?: string | number | null;
  user_id?: string | null;
  platform?: string | null;
  customer_name?: string | null;
  status?: string | null;
}

export interface BuildConversationOptions {
  businessId: string;
  messages: ConversationSourceRow[];
  leads?: ConversationCustomerRow[];
  appointments?: ConversationCustomerRow[];
  search?: string;
  channel?: string;
  status?: ConversationStatusFilter;
  range?: ConversationActivityRange;
  now?: Date;
}

export type ConversationActivityRange = 'recent' | '7d' | '30d' | '3m';
export type ConversationStatusFilter = 'all' | 'active' | 'booked';

export function normalizeConversationStatusFilter(value: unknown): ConversationStatusFilter {
  const status = String(value || 'all').trim().toLowerCase();
  return status === 'active' || status === 'booked' ? status : 'all';
}

export function conversationMatchesStatusFilter(
  status: ConversationStatus,
  filter: ConversationStatusFilter,
): boolean {
  if (filter === 'booked') return status === 'booked';
  if (filter === 'active') return status === 'open' || status === 'pending';
  return true;
}

export function normalizeConversationActivityRange(value: unknown): ConversationActivityRange {
  const range = String(value || 'recent').trim().toLowerCase();
  if (range === '7d' || range === '7days') return '7d';
  if (range === '30d' || range === '30days') return '30d';
  if (range === '3m' || range === '3months') return '3m';
  return 'recent';
}

const RANGE_DAYS: Readonly<Record<Exclude<ConversationActivityRange, 'recent'>, number>> = {
  '7d': 7,
  '30d': 30,
  '3m': 90,
};

export function conversationActivityCutoff(
  range: ConversationActivityRange,
  now = new Date(),
): string | null {
  if (range === 'recent') return null;
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) return null;
  return new Date(instant.getTime() - RANGE_DAYS[range] * 86_400_000).toISOString();
}

export async function collectConversationSourcePages<T>(
  fetchPage: (from: number, to: number) => Promise<T[]>,
  pageSize = 1000,
): Promise<T[]> {
  const rows: T[] = [];
  while (true) {
    const page = await fetchPage(rows.length, rows.length + pageSize - 1);
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

export async function collectConversationMatchPage<T>(
  fetchPage: (from: number, to: number) => Promise<T[]>,
  matches: (row: T) => boolean,
  cursor: number,
  limit: number,
  sourcePageSize = 1000,
): Promise<{ rows: T[]; hasMore: boolean }> {
  const requiredMatches = cursor + limit + 1;
  const matchingRows: T[] = [];
  let sourceOffset = 0;

  while (matchingRows.length < requiredMatches) {
    const page = await fetchPage(sourceOffset, sourceOffset + sourcePageSize - 1);
    matchingRows.push(...page.filter(matches));
    sourceOffset += page.length;
    if (page.length < sourcePageSize) break;
  }

  return {
    rows: matchingRows.slice(cursor, cursor + limit),
    hasMore: matchingRows.length > cursor + limit,
  };
}

export function normalizeConversationChannel(value: unknown): string {
  const channel = String(value || '').trim().toLowerCase();
  if (channel === 'facebook' || channel === 'facebook_messenger' || channel === 'messenger-api') {
    return 'messenger';
  }
  if (channel.startsWith('instagram')) return 'instagram';
  if (channel.startsWith('messenger')) return 'messenger';
  if (channel.startsWith('telegram')) return 'telegram';
  if (channel.startsWith('whatsapp')) return 'whatsapp';
  return channel;
}

export function normalizeConversationUserId(value: unknown, channel: string): string {
  let userId = String(value || '').trim();
  if (!userId) return '';

  const lower = userId.toLowerCase();
  const prefixes = [
    `${channel}_`,
    `${channel}-`,
    channel === 'messenger' ? 'ms_' : '',
    channel === 'instagram' ? 'ig_' : '',
    channel === 'telegram' ? 'telegram_' : '',
    channel === 'whatsapp' ? 'whatsapp_' : '',
    channel === 'whatsapp' ? 'wa_' : '',
  ].filter(Boolean);

  for (const prefix of prefixes) {
    if (lower.startsWith(prefix)) {
      userId = userId.slice(prefix.length);
      break;
    }
  }
  return userId.trim();
}

export function parseConversationId(value: string): { channel: string; userId: string } | null {
  const separatorIndex = value.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) return null;
  const channel = normalizeConversationChannel(value.slice(0, separatorIndex));
  const userId = normalizeConversationUserId(value.slice(separatorIndex + 1), channel);
  return channel && userId ? { channel, userId } : null;
}

export function toConversationMessage(row: ConversationSourceRow): ConversationMessage {
  const sender = String(row.sender || '').trim().toLowerCase();
  const author = sender === 'user' || sender === 'customer'
    ? 'customer'
    : sender === 'human' || sender === 'admin'
      ? 'human'
      : sender === 'system'
        ? 'system'
        : 'ai';

  return {
    id: String(row.id),
    author,
    text: String(row.message || '').trim(),
    createdAt: row.created_at || new Date(0).toISOString(),
  };
}

export function buildConversationSummaries(options: BuildConversationOptions): Conversation[] {
  const { businessId } = options;
  const sameBusiness = (row: { business_id?: string | number | null }) =>
    String(row.business_id ?? '') === businessId;
  const usableName = (value: unknown) => {
    const name = String(value || '').trim();
    return name && !/^(unknown|null|undefined|customer)$/i.test(name) ? name : '';
  };
  const keyFor = (row: ConversationCustomerRow | ConversationSourceRow) => {
    const channel = normalizeConversationChannel(row.platform);
    const userId = normalizeConversationUserId(row.user_id, channel);
    return channel && userId ? `${channel}:${userId}` : '';
  };

  const leads = new Map<string, string>();
  for (const row of options.leads || []) {
    if (!sameBusiness(row)) continue;
    const key = keyFor(row);
    const name = usableName(row.customer_name);
    if (key && name && !leads.has(key)) leads.set(key, name);
  }

  const appointments = new Map<string, { name: string; status: string }>();
  for (const row of options.appointments || []) {
    if (!sameBusiness(row)) continue;
    const key = keyFor(row);
    if (!key || appointments.has(key)) continue;
    appointments.set(key, {
      name: usableName(row.customer_name),
      status: String(row.status || '').trim().toLowerCase(),
    });
  }

  const grouped = new Map<string, Conversation>();
  const orderedRows = [...options.messages]
    .filter(sameBusiness)
    .sort((a, b) => {
      const time = new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
      return time || String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
    });

  for (const row of orderedRows) {
    const channel = normalizeConversationChannel(row.platform);
    const rawUserId = String(row.user_id || '').trim();
    const userId = normalizeConversationUserId(rawUserId, channel);
    if (!channel || !userId) continue;
    const key = `${channel}:${userId}`;
    const appointment = appointments.get(key);
    const appointmentStatus = appointment?.status || '';
    const status: ConversationStatus = appointmentStatus === 'booked' || appointmentStatus === 'confirmed'
      ? 'booked'
      : appointmentStatus === 'pending'
        ? 'pending'
        : 'open';
    const fallback = channel === 'whatsapp'
      ? (userId.replace(/\D/g, '') ? `+${userId.replace(/\D/g, '')}` : 'WhatsApp customer')
      : `${channel.charAt(0).toUpperCase()}${channel.slice(1)} ${userId}`;

    if (!grouped.has(key)) {
      grouped.set(key, {
        id: key,
        customerName: leads.get(key) || appointment?.name || fallback,
        channel: channel as IntegrationKey,
        status,
        preview: 'No message preview available.',
        updatedAt: row.created_at || new Date(0).toISOString(),
        unreadCount: 0,
        messages: [],
      });
    }

    const conversation = grouped.get(key)!;
    const text = String(row.message || '').trim();
    if (text) conversation.preview = text;
    conversation.updatedAt = row.created_at || conversation.updatedAt;
    const author = toConversationMessage(row).author;
    if (author === 'customer' && row.is_read === false) {
      conversation.unreadCount = Number(conversation.unreadCount || 0) + 1;
    }
  }

  const search = String(options.search || '').trim().toLowerCase();
  const channel = normalizeConversationChannel(options.channel);
  const status = normalizeConversationStatusFilter(options.status);
  const cutoff = conversationActivityCutoff(normalizeConversationActivityRange(options.range), options.now);
  return [...grouped.values()]
    .filter((item) => !cutoff || Date.parse(item.updatedAt) >= Date.parse(cutoff))
    .filter((item) => !channel || channel === 'all' || item.channel === channel)
    .filter((item) => conversationMatchesStatusFilter(item.status, status))
    .filter((item) => !search || `${item.customerName} ${item.preview} ${item.status} ${item.channel}`.toLowerCase().includes(search))
    .sort((a, b) => {
      const time = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      return time || a.id.localeCompare(b.id);
    });
}

export function mergeConversationPages(current: Conversation[], next: Conversation[]): Conversation[] {
  const merged = new Map(current.map((conversation) => [conversation.id, conversation]));
  for (const conversation of next) merged.set(conversation.id, conversation);
  return [...merged.values()].sort((a, b) => {
    const time = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    return time || a.id.localeCompare(b.id);
  });
}
