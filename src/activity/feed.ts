import type { ActivityEvent } from '../types/dashboard';

export interface ActivityDateGroup {
  key: 'today' | 'yesterday' | 'earlier';
  label: string;
  items: ActivityEvent[];
}

function dateKey(value: string | Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function stableNewestFirst(events: ActivityEvent[]): ActivityEvent[] {
  return [...events].sort((left, right) => {
    const time = new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime();
    return time || left.key.localeCompare(right.key);
  });
}

export function mergeActivityPages(current: ActivityEvent[], next: ActivityEvent[]): ActivityEvent[] {
  const merged = new Map(current.map((event) => [event.key, event]));
  for (const event of next) merged.set(event.key, event);
  return stableNewestFirst([...merged.values()]);
}

export function compactActivityEvents(events: ActivityEvent[], timezone = 'UTC'): ActivityEvent[] {
  const conversations = new Map<string, ActivityEvent[]>();
  const retained: ActivityEvent[] = [];
  for (const event of stableNewestFirst(events)) {
    if (event.type !== 'conversation_started') {
      retained.push(event);
      continue;
    }
    const groupKey = `${dateKey(event.occurredAt, timezone)}:${event.channel || 'unknown'}`;
    const group = conversations.get(groupKey) || [];
    group.push(event);
    conversations.set(groupKey, group);
  }

  for (const [groupKey, group] of conversations) {
    if (group.length === 1) {
      retained.push(group[0]);
      continue;
    }
    const latest = stableNewestFirst(group)[0];
    retained.push({
      ...latest,
      key: `conversation-group:${groupKey}`,
      title: `${group.length} conversations started`,
      detail: latest.channel ? `Via ${formatChannel(latest.channel)}` : undefined,
      count: group.length,
    });
  }
  return stableNewestFirst(retained);
}

export function groupActivityByDate(
  events: ActivityEvent[],
  now = new Date(),
  timezone = 'UTC',
): ActivityDateGroup[] {
  const currentKey = dateKey(now, timezone);
  const yesterday = new Date(Date.parse(`${currentKey}T00:00:00Z`) - 86_400_000);
  const yesterdayKey = dateKey(yesterday, 'UTC');
  const groups = new Map<ActivityDateGroup['key'], ActivityEvent[]>();
  for (const event of stableNewestFirst(events)) {
    const eventKey = dateKey(event.occurredAt, timezone);
    const key: ActivityDateGroup['key'] = eventKey === currentKey
      ? 'today'
      : eventKey === yesterdayKey
        ? 'yesterday'
        : 'earlier';
    groups.set(key, [...(groups.get(key) || []), event]);
  }

  const definitions: Array<{ key: ActivityDateGroup['key']; label: string }> = [
    { key: 'today', label: 'Today' },
    { key: 'yesterday', label: 'Yesterday' },
    { key: 'earlier', label: 'Earlier' },
  ];
  return definitions.filter(({ key }) => groups.has(key)).map(({ key, label }) => ({
    key,
    label,
    items: groups.get(key)!,
  }));
}

function formatChannel(channel: string): string {
  if (channel === 'whatsapp') return 'WhatsApp';
  if (channel === 'instagram') return 'Instagram';
  if (channel === 'messenger') return 'Messenger';
  if (channel === 'telegram') return 'Telegram';
  return channel;
}
