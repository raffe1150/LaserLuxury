import { useEffect, useMemo, useRef, useState } from 'react';
import { groupNotificationsByRecency } from '../../notifications/model';
import { api } from '../../services/api';
import type { NotificationFilter, NotificationItem } from '../../types/dashboard';
import { useDashboardI18n } from '../../i18n/dashboard';

const PAGE_SIZE = 25;
const FILTERS: Array<{ id: NotificationFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'attention', label: 'Attention' },
];

export default function NotificationCenter({
  businessId,
  timezone = 'UTC',
  onUnreadCountChange,
  refreshKey = 0,
}: {
  businessId: string;
  timezone?: string;
  onUnreadCountChange?: (count: number) => void;
  refreshKey?: number;
}) {
  const { locale, formatNumber } = useDashboardI18n();
  const [filter, setFilter] = useState<NotificationFilter>('all');
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const requestGeneration = useRef(0);

  useEffect(() => {
    const requestId = ++requestGeneration.current;
    const controller = new AbortController();
    setItems([]);
    setCursor(null);
    setError(null);
    setLoading(true);
    setUnreadCount(0);
    onUnreadCountChange?.(0);

    api.getNotificationPage(businessId, { limit: PAGE_SIZE, filter }, controller.signal)
      .then((page) => {
        if (requestId !== requestGeneration.current) return;
        setItems(page.items);
        setCursor(page.pagination.nextCursor);
        setUnreadCount(page.unreadCount);
        onUnreadCountChange?.(page.unreadCount);
      })
      .catch((reason) => {
        if (controller.signal.aborted || requestId !== requestGeneration.current) return;
        setError(reason instanceof Error ? reason.message : 'Could not load notifications.');
      })
      .finally(() => {
        if (requestId === requestGeneration.current) setLoading(false);
      });

    return () => controller.abort();
  }, [businessId, filter, retry, refreshKey, onUnreadCountChange]);

  const groups = useMemo(
    () => groupNotificationsByRecency(items, new Date(), timezone),
    [items, timezone],
  );

  const markRead = async (item: NotificationItem) => {
    if (item.read) return;
    const requestId = requestGeneration.current;
    try {
      const result = await api.markNotificationRead(businessId, item.id);
      if (requestId !== requestGeneration.current) return;
      setItems((current) => filter === 'unread'
        ? current.filter((candidate) => candidate.id !== item.id)
        : current.map((candidate) => candidate.id === item.id ? { ...candidate, read: true } : candidate));
      setUnreadCount(result.unreadCount);
      onUnreadCountChange?.(result.unreadCount);
    } catch (reason) {
      if (requestId === requestGeneration.current) setError(reason instanceof Error ? reason.message : 'Could not mark notification as read.');
    }
  };

  const markAllRead = async () => {
    const requestId = requestGeneration.current;
    try {
      await api.markAllNotificationsRead(businessId);
      if (requestId !== requestGeneration.current) return;
      setItems((current) => filter === 'unread' ? [] : current.map((item) => ({ ...item, read: true })));
      setUnreadCount(0);
      onUnreadCountChange?.(0);
    } catch (reason) {
      if (requestId === requestGeneration.current) setError(reason instanceof Error ? reason.message : 'Could not mark notifications as read.');
    }
  };

  const openAction = async (item: NotificationItem) => {
    await markRead(item);
    if (!item.actionTarget) return;
    const dashboardTarget = item.actionTarget === '#activity' ? '#bookings' : item.actionTarget;
    document.querySelector<HTMLAnchorElement>(`.sidebar-nav a[href="${dashboardTarget}"]`)?.click();
  };

  const loadMore = async () => {
    if (cursor === null || loadingMore) return;
    const requestId = requestGeneration.current;
    setLoadingMore(true);
    try {
      const page = await api.getNotificationPage(businessId, { limit: PAGE_SIZE, cursor, filter });
      if (requestId !== requestGeneration.current) return;
      setItems((current) => {
        const merged = new Map(current.map((item) => [item.id, item]));
        for (const item of page.items) merged.set(item.id, item);
        return [...merged.values()];
      });
      setCursor(page.pagination.nextCursor);
      setUnreadCount(page.unreadCount);
      onUnreadCountChange?.(page.unreadCount);
    } catch (reason) {
      if (requestId === requestGeneration.current) setError(reason instanceof Error ? reason.message : 'Could not load more notifications.');
    } finally {
      if (requestId === requestGeneration.current) setLoadingMore(false);
    }
  };

  return (
    <section id="notification-center" className="card dashboard-section notification-center">
      <div className="notification-toolbar">
        <div>
          <div className="card-title">Notifications</div>
          <div className="card-desc">{formatNumber(unreadCount)} unread · Operational issues that may need your attention.</div>
        </div>
        {unreadCount > 0 && <button className="notification-mark-all" type="button" onClick={() => void markAllRead()}>Mark all as read</button>}
      </div>
      <div className="notification-filters" aria-label="Filter notifications">
        {FILTERS.map((option) => <button key={option.id} type="button" className={filter === option.id ? 'active' : ''} aria-pressed={filter === option.id} onClick={() => setFilter(option.id)}>{option.label}</button>)}
      </div>

      <div className="notification-feed" aria-busy={loading}>
        {loading && <div className="notification-skeleton" aria-label="Loading notifications">{Array.from({ length: 4 }, (_, index) => <div key={index}><i /><span /></div>)}</div>}
        {!loading && error && items.length === 0 && <NotificationState title="Notifications unavailable" copy="Your operational workflows are unaffected. Try loading notifications again." action={() => setRetry((value) => value + 1)} />}
        {!loading && !error && items.length === 0 && <NotificationState title="You're all caught up" copy="No issues need your attention right now." />}
        {!loading && groups.map((group) => <section className="notification-date-group" key={group.key}>
          <div className="notification-date-label">{group.label}</div>
          {group.items.map((item) => <article className={`notification-row ${item.severity}${item.read ? ' read' : ' unread'}`} key={item.id}>
            <span className="notification-severity" aria-hidden="true" />
            <div className="notification-row-copy">
              <div><span className="notification-category">{formatCategory(item.category)}</span>{!item.read && <span className="notification-unread-label">Unread</span>}</div>
              <strong>{item.title}</strong>
              <span>{item.description}</span>
            </div>
            <time dateTime={item.lastObservedAt}>{formatTime(item.lastObservedAt, timezone, locale)}</time>
            <div className="notification-row-actions">
              {!item.read && <button type="button" onClick={() => void markRead(item)}>Mark read</button>}
              {item.actionTarget && <button className="primary" type="button" onClick={() => void openAction(item)}>{item.actionType === 'open_health' ? 'Open Health' : 'View bookings'}</button>}
            </div>
          </article>)}
        </section>)}
        {cursor !== null && <button className="notification-load-more" type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'Loading…' : 'Load more'}</button>}
        {error && items.length > 0 && <div className="notification-inline-error">{error}</div>}
      </div>
    </section>
  );
}

function NotificationState({ title, copy, action }: { title: string; copy: string; action?: () => void }) {
  return <div className="notification-state"><strong>{title}</strong><span>{copy}</span>{action && <button type="button" onClick={action}>Retry</button>}</div>;
}

function formatCategory(category: NotificationItem['category']) {
  return category === 'integration' ? 'Integration' : 'Booking';
}

function formatTime(value: string, timezone: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
