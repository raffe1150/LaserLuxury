import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Booking, BookingPage, BookingView } from '../../types/dashboard';
import { bookingStatusLabel, groupBookingsByDate, mergeBookingPages } from '../../bookings/workspace';
import { api } from '../../services/api';
import { ChannelIcon } from './Icons';
import { useDashboardI18n } from '../../i18n/dashboard';

interface BookingsPanelProps {
  businessId: string;
  timezone?: string;
}

const PAGE_SIZE = 25;
const views: Array<{ id: BookingView; label: string }> = [
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'pending', label: 'Pending' },
  { id: 'past', label: 'Past' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'all', label: 'All' },
];
const emptySummary: BookingPage['summary'] = {
  today: 0, upcoming: 0, pending: 0, cancelled: 0, scanTruncated: false,
};

export default function BookingsPanel({ businessId, timezone = 'UTC' }: BookingsPanelProps) {
  const { locale, formatNumber, t } = useDashboardI18n();
  const [view, setView] = useState<BookingView>('upcoming');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [summary, setSummary] = useState(emptySummary);
  const [cursor, setCursor] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const requestGeneration = useRef(0);

  useEffect(() => {
    const timeout = window.setTimeout(() => setSearch(query.trim()), 300);
    return () => window.clearTimeout(timeout);
  }, [query]);

  useEffect(() => {
    const requestId = ++requestGeneration.current;
    const controller = new AbortController();
    setBookings([]);
    setSummary(emptySummary);
    setCursor(null);
    setTotal(0);
    setSelectedId(undefined);
    setError(null);
    setLoading(true);

    api.getBookingPage(
      businessId,
      { limit: PAGE_SIZE, view, search, timezone },
      controller.signal,
    ).then((page) => {
      if (requestId !== requestGeneration.current) return;
      setBookings(page.items);
      setSummary(page.summary);
      setCursor(page.pagination.nextCursor);
      setTotal(page.pagination.total);
      setSelectedId(page.items[0]?.id);
    }).catch((reason) => {
      if (controller.signal.aborted || requestId !== requestGeneration.current) return;
      setError(reason instanceof Error ? reason.message : 'Could not load bookings.');
    }).finally(() => {
      if (requestId === requestGeneration.current) setLoading(false);
    });

    return () => controller.abort();
  }, [businessId, timezone, view, search, retry]);

  const groups = useMemo(
    () => groupBookingsByDate(bookings, new Date(), timezone),
    [bookings, timezone],
  );
  const selected = bookings.find((booking) => booking.id === selectedId);

  const loadMore = async () => {
    if (cursor === null || loadingMore) return;
    const requestId = ++requestGeneration.current;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await api.getBookingPage(businessId, {
        limit: PAGE_SIZE,
        cursor,
        view,
        search,
        timezone,
      });
      if (requestId !== requestGeneration.current) return;
      setBookings((current) => mergeBookingPages(current, page.items));
      setSummary(page.summary);
      setCursor(page.pagination.nextCursor);
      setTotal(page.pagination.total);
    } catch (reason) {
      if (requestId !== requestGeneration.current) return;
      setError(reason instanceof Error ? reason.message : 'Could not load more bookings.');
    } finally {
      if (requestId === requestGeneration.current) setLoadingMore(false);
    }
  };

  return (
    <section id="bookings" className="card dashboard-section booking-workspace">
      <div className="booking-summary" aria-label="Booking summary">
        <SummaryMetric label={t('Today')} value={formatNumber(summary.today)} />
        <SummaryMetric label={t('Upcoming')} value={formatNumber(summary.upcoming)} active={view === 'upcoming'} onClick={() => setView('upcoming')} />
        <SummaryMetric label={t('Pending')} value={formatNumber(summary.pending)} tone={summary.pending ? 'attention' : undefined} active={view === 'pending'} onClick={() => setView('pending')} />
        <SummaryMetric label={t('Cancelled')} value={formatNumber(summary.cancelled)} active={view === 'cancelled'} onClick={() => setView('cancelled')} />
      </div>

      <div className="booking-toolbar">
        <div className="booking-view-tabs" aria-label="Filter bookings">
          {views.map((item) => <button key={item.id} type="button" className={view === item.id ? 'active' : ''} aria-pressed={view === item.id} onClick={() => setView(item.id)}>{t(item.label)}</button>)}
        </div>
        <input className="form-input booking-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search customer, service, date or channel…" aria-label="Search bookings" />
      </div>

      <div className={`booking-workspace-layout${selected ? ' has-selection' : ''}`}>
        <div className="booking-results" aria-busy={loading}>
          {loading && <BookingSkeleton />}
          {!loading && error && bookings.length === 0 && <BookingState title="Bookings unavailable" copy={error} action={() => setRetry((value) => value + 1)} />}
          {!loading && !error && bookings.length === 0 && <BookingState title={t(emptyTitle(view))} copy={t(search ? 'Try a different search.' : emptyCopy(view))} />}
          {!loading && groups.map((group) => <section className="booking-date-group" key={group.key}>
            <div className="booking-date-head"><strong>{t(group.label)}</strong><span>{formatNumber(group.items.length)}</span></div>
            {group.items.map((booking) => <button className={`booking-compact-row${booking.id === selectedId ? ' active' : ''}`} key={booking.id} type="button" onClick={() => setSelectedId(booking.id)}>
              <time><strong>{formatTime(booking.startsAt, timezone, locale)}</strong><span>{formatShortDate(booking.startsAt, timezone, locale)}</span></time>
              <span className="booking-channel"><ChannelIcon channel={booking.channel} /></span>
              <span className="booking-row-copy"><strong translate="no">{booking.customerName}</strong><small translate={booking.serviceName ? 'no' : undefined}>{booking.serviceName || 'Service not specified'}</small></span>
              <span className={`booking-status ${booking.status}`}>{t(bookingStatusLabel(booking.status))}</span>
            </button>)}
          </section>)}
          {cursor !== null && <button className="booking-load-more" type="button" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? t('Loading…') : t('Load more ({loaded} of {total})', { loaded: bookings.length, total })}</button>}
          {error && bookings.length > 0 && <div className="booking-inline-error">{error} <button type="button" onClick={() => void loadMore()}>Retry</button></div>}
        </div>

        {selected && <aside className="booking-detail" aria-label="Booking details">
          <div className="booking-detail-head"><div><span>Booking details</span><strong translate="no">{selected.customerName}</strong></div><button type="button" onClick={() => setSelectedId(undefined)} aria-label="Close booking details">×</button></div>
          <dl>
            <Detail label={t('Status')}><span className={`booking-status ${selected.status}`}>{t(bookingStatusLabel(selected.status))}</span></Detail>
            <Detail label="Date"><span>{formatLongDate(selected.startsAt, timezone, locale)}</span></Detail>
            <Detail label="Time"><span>{formatTimeRange(selected, timezone, locale)}</span></Detail>
            <Detail label="Service"><span translate={selected.serviceName ? 'no' : undefined}>{selected.serviceName || 'Not specified'}</span></Detail>
            <Detail label="Channel"><span className="booking-detail-channel"><ChannelIcon channel={selected.channel} />{formatChannel(selected.channel)}</span></Detail>
            {selected.createdAt && <Detail label="Booked"><span>{formatLongDate(selected.createdAt, timezone, locale)}</span></Detail>}
          </dl>
        </aside>}
      </div>
      {summary.scanTruncated && <div className="booking-coverage-note">Summary covers the latest 2,000 appointment records.</div>}
    </section>
  );
}

function SummaryMetric({ label, value, tone, active, onClick }: { label: string; value: string; tone?: string; active?: boolean; onClick?: () => void }) {
  const content = <><span>{label}</span><strong>{value}</strong></>;
  return onClick
    ? <button type="button" className={`${tone || ''}${active ? ' active' : ''}`} onClick={onClick}>{content}</button>
    : <div className={tone || ''}>{content}</div>;
}

function BookingState({ title, copy, action }: { title: string; copy: string; action?: () => void }) {
  return <div className="booking-state"><strong>{title}</strong><span>{copy}</span>{action && <button type="button" onClick={action}>Retry</button>}</div>;
}

function BookingSkeleton() {
  return <div className="booking-skeleton" aria-label="Loading bookings">{Array.from({ length: 6 }, (_, index) => <div key={index}><i /><span /></div>)}</div>;
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

function emptyTitle(view: BookingView) {
  if (view === 'upcoming') return 'No upcoming bookings';
  if (view === 'pending') return 'No pending bookings';
  if (view === 'past') return 'No past bookings';
  if (view === 'cancelled') return 'No cancelled bookings';
  return 'No bookings found';
}

function emptyCopy(view: BookingView) {
  return view === 'upcoming' ? 'New confirmed and pending appointments will appear here.' : 'There are no bookings in this view.';
}

function formatTime(value: string, timezone: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function formatShortDate(value: string, timezone: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { timeZone: timezone, month: 'short', day: 'numeric' }).format(new Date(value));
}

function formatLongDate(value: string, timezone: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { timeZone: timezone, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(value));
}

function formatTimeRange(booking: Booking, timezone: string, locale: string) {
  const start = formatTime(booking.startsAt, timezone, locale);
  return booking.endsAt ? `${start}–${formatTime(booking.endsAt, timezone, locale)}` : start;
}

function formatChannel(channel: string) {
  if (channel === 'google_calendar') return 'Google Calendar';
  return channel.charAt(0).toUpperCase() + channel.slice(1);
}
