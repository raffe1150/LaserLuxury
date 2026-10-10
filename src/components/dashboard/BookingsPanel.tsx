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
  const workspaceRef = useRef<HTMLElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const [singlePane, setSinglePane] = useState(true);
  const [detailOpen, setDetailOpen] = useState(false);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  useEffect(() => {
    let previousSingle: boolean | undefined;
    // A readable 440px list + 280px detail + separators need 760px of workspace.
    const observer = new ResizeObserver(([entry]) => {
      if (!entry.contentRect.width) return; // Hidden mounted workspaces keep their mode.
      const compact = entry.contentRect.width < 760;
      if (previousSingle === false && compact && selectedRef.current) {
        const listHadFocus = workspaceRef.current?.querySelector('.booking-results')?.contains(document.activeElement);
        setDetailOpen(true);
        if (listHadFocus) requestAnimationFrame(() => detailRef.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true }));
      }
      previousSingle = compact;
      setSinglePane(compact);
    });
    observer.observe(workspaceRef.current!);
    return () => observer.disconnect();
  }, []);

  const openDetail = (id: string) => {
    setSelectedId(id);
    if (singlePane) {
      setDetailOpen(true);
      requestAnimationFrame(() => {
        detailRef.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
        detailRef.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      });
    }
  };
  const closeDetail = () => {
    const row = workspaceRef.current?.querySelector<HTMLElement>('.booking-compact-row.active');
    setDetailOpen(false);
    if (!singlePane) setSelectedId(undefined);
    requestAnimationFrame(() => {
      row?.focus({ preventScroll: true });
      row?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    });
  };


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
    setDetailOpen(false);
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
    <section ref={workspaceRef} id="bookings" translate="no" className={`card dashboard-section booking-workspace${singlePane ? ' booking-single-pane' : ''}`}>
      <div className="booking-summary" aria-label={t("Booking summary")}>
        <SummaryMetric label={t('Today')} value={loading || (error && bookings.length === 0) ? '—' : formatNumber(summary.today)} />
        <SummaryMetric label={t('Upcoming')} value={loading || (error && bookings.length === 0) ? '—' : formatNumber(summary.upcoming)} active={view === 'upcoming'} onClick={() => setView('upcoming')} />
        <SummaryMetric label={t('Pending')} value={loading || (error && bookings.length === 0) ? '—' : formatNumber(summary.pending)} tone={summary.pending ? 'attention' : undefined} active={view === 'pending'} onClick={() => setView('pending')} />
        <SummaryMetric label={t('Cancelled')} value={loading || (error && bookings.length === 0) ? '—' : formatNumber(summary.cancelled)} active={view === 'cancelled'} onClick={() => setView('cancelled')} />
      </div>

      <div className="booking-toolbar">
        <div className="booking-view-tabs" aria-label={t("Filter bookings")}>
          {views.map((item) => <button key={item.id} type="button" className={view === item.id ? 'active' : ''} aria-pressed={view === item.id} onClick={() => setView(item.id)}>{t(item.label)}</button>)}
        </div>
        <input className="form-input booking-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("Search customer, service, date or channel…")} aria-label={t("Search bookings")} />
      </div>

      <div className={`booking-workspace-layout${selected ? ' has-selection' : ''}`}>
        <div className="booking-results" role="region" tabIndex={0} aria-label={t("Bookings")} aria-busy={loading} hidden={singlePane && detailOpen && Boolean(selected)}>
          {loading && <BookingSkeleton label={t("Loading bookings")} />}
          {!loading && error && bookings.length === 0 && <BookingState title={t("Bookings unavailable")} copy={error} action={() => setRetry((value) => value + 1)} />}
          {!loading && !error && bookings.length === 0 && <BookingState title={t(emptyTitle(view))} copy={t(search ? 'Try a different search.' : emptyCopy(view))} />}
          {!loading && groups.map((group) => <section className="booking-date-group" key={group.key}>
            <div className="booking-date-head"><strong>{t(group.label)}</strong><span>{formatNumber(group.items.length)}</span></div>
            {group.items.map((booking) => <button className={`booking-compact-row${booking.id === selectedId ? ' active' : ''}`} key={booking.id} type="button" aria-pressed={booking.id === selectedId} onClick={() => openDetail(booking.id)}>
              <time dir="ltr"><strong>{formatTime(booking.startsAt, timezone, locale)}</strong><span>{formatShortDate(booking.startsAt, timezone, locale)}</span></time>
              <span className="booking-channel" aria-label={formatChannel(booking.channel)}><ChannelIcon channel={booking.channel} /><span>{formatChannel(booking.channel)}</span></span>
              <span className="booking-row-copy"><strong translate="no" dir="auto">{booking.customerName}</strong><small dir="auto">{booking.serviceName || t('Service not specified')}</small></span>
              <span className={`booking-status ${booking.status}`} translate="no">{t(bookingStatusLabel(booking.status))}</span>
            </button>)}
          </section>)}
          {cursor !== null && <button className="booking-load-more" type="button" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? t('Loading…') : t('Load more ({loaded} of {total})', { loaded: bookings.length, total })}</button>}
          {error && bookings.length > 0 && <div className="booking-inline-error" role="alert">{error} <button type="button" onClick={() => void loadMore()}>{t("Retry")}</button></div>}
        </div>

        {selected && <aside ref={detailRef} className="booking-detail" tabIndex={0} aria-label={t("Booking details")} hidden={singlePane && !detailOpen}>
          <div className="booking-detail-head"><div><span>{t("Booking details")}</span><h3 translate="no" dir="auto">{selected.customerName}</h3></div><button className="booking-detail-back" type="button" onClick={closeDetail} aria-label={t(singlePane ? "Back to bookings" : "Close booking details")}>{singlePane ? <><span aria-hidden="true">←</span>{t("Bookings")}</> : '×'}</button></div>
          <dl>
            <Detail label={t('Status')}><span className={`booking-status ${selected.status}`} translate="no">{t(bookingStatusLabel(selected.status))}</span></Detail>
            <Detail label={t("Date")}><span dir="ltr">{formatLongDate(selected.startsAt, timezone, locale)}</span></Detail>
            <Detail label={t("Time")}><span dir="ltr">{formatTimeRange(selected, timezone, locale)}</span></Detail>
            <Detail label={t("Service")}><span dir="auto">{selected.serviceName || t('Not specified')}</span></Detail>
            <Detail label={t("Channel")}><span className="booking-detail-channel"><ChannelIcon channel={selected.channel} />{formatChannel(selected.channel)}</span></Detail>
            {selected.createdAt && <Detail label={t("Booked")}><span dir="ltr">{formatLongDate(selected.createdAt, timezone, locale)}</span></Detail>}
          </dl>
        </aside>}
      </div>
      {summary.scanTruncated && <div className="booking-coverage-note">{t("Summary covers the latest 2,000 appointment records.")}</div>}
    </section>
  );
}

function SummaryMetric({ label, value, tone, active, onClick }: { label: string; value: string; tone?: string; active?: boolean; onClick?: () => void }) {
  const content = <><span>{label}</span><strong dir="ltr">{value}</strong></>;
  return onClick
    ? <button type="button" className={`${tone || ''}${active ? ' active' : ''}`} aria-pressed={Boolean(active)} onClick={onClick}>{content}</button>
    : <div className={tone || ''}>{content}</div>;
}

function BookingState({ title, copy, action }: { title: string; copy: string; action?: () => void }) {
  const { t } = useDashboardI18n();
  return <div className="booking-state" role={action ? 'alert' : undefined}><h3>{title}</h3><span>{copy}</span>{action && <button type="button" onClick={action}>{t("Retry")}</button>}</div>;
}

function BookingSkeleton({ label }: { label: string }) {
  return <div className="booking-skeleton" aria-label={label} role="status"><span className="dashboard-state-label">{label}</span>{Array.from({ length: 6 }, (_, index) => <div key={index}><i /><span /></div>)}</div>;
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
