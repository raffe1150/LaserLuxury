import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityCategory, ActivityEvent } from '../../types/dashboard';
import { compactActivityEvents, groupActivityByDate, mergeActivityPages } from '../../activity/feed';
import { api } from '../../services/api';
import { ChannelIcon } from './Icons';
import { useDashboardI18n } from '../../i18n/dashboard';

interface ActivityFeedProps {
  businessId: string;
  timezone?: string;
}

const PAGE_SIZE = 30;
const filters: Array<{ id: 'all' | ActivityCategory; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'bookings', label: 'Bookings' },
  { id: 'conversations', label: 'Conversations' },
];

export default function ActivityFeed({ businessId, timezone = 'UTC' }: ActivityFeedProps) {
  const { locale, t } = useDashboardI18n();
  const [category, setCategory] = useState<'all' | ActivityCategory>('all');
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const requestGeneration = useRef(0);

  useEffect(() => {
    const requestId = ++requestGeneration.current;
    const controller = new AbortController();
    setEvents([]);
    setCursor(null);
    setError(null);
    setLoading(true);

    api.getActivityPage(businessId, { limit: PAGE_SIZE, category }, controller.signal)
      .then((page) => {
        if (requestId !== requestGeneration.current) return;
        setEvents(page.items);
        setCursor(page.pagination.nextCursor);
      })
      .catch((reason) => {
        if (controller.signal.aborted || requestId !== requestGeneration.current) return;
        setError(reason instanceof Error ? reason.message : 'Could not load recent activity.');
      })
      .finally(() => {
        if (requestId === requestGeneration.current) setLoading(false);
      });

    return () => controller.abort();
  }, [businessId, category, retry]);

  const compacted = useMemo(() => compactActivityEvents(events, timezone), [events, timezone]);
  const dateGroups = useMemo(
    () => groupActivityByDate(compacted, new Date(), timezone),
    [compacted, timezone],
  );

  const loadMore = async () => {
    if (cursor === null || loadingMore) return;
    const requestId = ++requestGeneration.current;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await api.getActivityPage(businessId, {
        limit: PAGE_SIZE,
        cursor,
        category,
      });
      if (requestId !== requestGeneration.current) return;
      setEvents((current) => mergeActivityPages(current, page.items));
      setCursor(page.pagination.nextCursor);
    } catch (reason) {
      if (requestId !== requestGeneration.current) return;
      setError(reason instanceof Error ? reason.message : 'Could not load more activity.');
    } finally {
      if (requestId === requestGeneration.current) setLoadingMore(false);
    }
  };

  return (
    <section id="activity" className="card dashboard-section recent-activity">
      <div className="activity-toolbar">
        <div><div className="card-title">Recent activity</div><div className="card-desc">Meaningful customer and booking changes, newest first.</div></div>
        <div className="activity-filters" aria-label="Filter activity">
          {filters.map((filter) => <button key={filter.id} type="button" className={category === filter.id ? 'active' : ''} aria-pressed={category === filter.id} onClick={() => setCategory(filter.id)}>{t(filter.label)}</button>)}
        </div>
      </div>

      <div className="recent-activity-feed" aria-busy={loading}>
        {loading && <ActivitySkeleton />}
        {!loading && error && events.length === 0 && <ActivityState title="Activity unavailable" copy={error} action={() => setRetry((value) => value + 1)} />}
        {!loading && !error && events.length === 0 && <ActivityState title="No recent activity" copy="Meaningful booking and conversation events will appear here." />}
        {!loading && dateGroups.map((group) => <section className="activity-date-group" key={group.key}>
          <div className="activity-date-label">{t(group.label)}</div>
          {group.items.map((event) => <div className={`activity-event ${event.severity}`} key={event.key}>
            <div className="activity-event-icon">{event.channel ? <ChannelIcon channel={event.channel} /> : <span className="activity-generic-icon" aria-hidden="true">•</span>}<i aria-hidden="true" /></div>
            <div className="activity-event-copy"><strong>{t(event.title)}</strong>{event.detail && <span translate={event.count ? undefined : 'no'}>{event.count ? t(event.detail) : event.detail}</span>}</div>
            {event.channel && <span className="activity-event-channel">{formatChannel(event.channel)}</span>}
            <time dateTime={event.occurredAt}>{formatTime(event.occurredAt, timezone, locale)}</time>
          </div>)}
        </section>)}
        {cursor !== null && <button className="activity-load-more" type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? t('Loading…') : t('Load more activity')}</button>}
        {error && events.length > 0 && <div className="activity-inline-error">{error} <button type="button" onClick={() => void loadMore()}>Retry</button></div>}
      </div>
    </section>
  );
}

function ActivitySkeleton() {
  return <div className="activity-skeleton" aria-label="Loading activity">{Array.from({ length: 7 }, (_, index) => <div key={index}><i /><span /></div>)}</div>;
}

function ActivityState({ title, copy, action }: { title: string; copy: string; action?: () => void }) {
  return <div className="activity-state"><strong>{title}</strong><span>{copy}</span>{action && <button type="button" onClick={action}>Retry</button>}</div>;
}

function formatTime(value: string, timezone: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function formatChannel(channel: string) {
  if (channel === 'whatsapp') return 'WhatsApp';
  if (channel === 'instagram') return 'Instagram';
  if (channel === 'messenger') return 'Messenger';
  if (channel === 'telegram') return 'Telegram';
  return channel;
}
