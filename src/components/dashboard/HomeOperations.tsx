import type { ReactNode } from 'react';
import type { Booking, IntegrationHealth, NotificationItem } from '../../types/dashboard';
import { bookingStatusLabel } from '../../bookings/workspace';
import { useDashboardI18n } from '../../i18n/dashboard';
import type { NavigateDashboard } from './dashboard-navigation';
import { ChannelIcon } from './Icons';
import { CalendarClock, TriangleAlert, Network } from 'lucide-react';

// Presentation snapshots from the already mounted workspaces. Home performs no requests.
export interface WorkspacePreview<T> {
  businessId: string;
  status: 'loading' | 'available' | 'partial' | 'unavailable';
  items: readonly T[];
}

interface HomeOperationsProps {
  businessId: string;
  timezone?: string;
  bookings: WorkspacePreview<Booking> | null;
  notifications: WorkspacePreview<NotificationItem> | null;
  health: WorkspacePreview<IntegrationHealth> | null;
  onNavigate: NavigateDashboard;
}

export default function HomeOperations({ businessId, timezone = 'UTC', bookings, notifications, health, onNavigate }: HomeOperationsProps) {
  const { locale, t } = useDashboardI18n();
  const scoped = <T,>(preview: WorkspacePreview<T> | null): WorkspacePreview<T> => preview?.businessId === businessId
    ? preview : { businessId, status: 'loading', items: [] };
  const appointments = scoped(bookings);
  const issues = scoped(notifications);
  const connections = scoped(health);
  const activeIssues = issues.items.filter((item) => item.active).slice(0, 3);
  const date = new Intl.DateTimeFormat(locale, { timeZone: timezone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return <div className="home-operations" translate="no">
    <section className="home-operation-card home-attention" aria-labelledby="home-attention-title" aria-busy={issues.status === 'loading'}>
      <header><div><span className="home-section-kicker">{t('Your next steps')}</span><h2 id="home-attention-title"><TriangleAlert aria-hidden="true" />{t('Needs attention')}</h2></div>
        <button className="btn btn-ghost" type="button" onClick={() => onNavigate({ primary: 'settings', secondary: 'notification-center' })}>{t('View issues')}</button></header>
      <PreviewState status={issues.status} empty={activeIssues.length === 0} emptyCopy={issues.status === 'partial' ? 'No active issues in loaded results.' : 'There are no active issues in this view.'}>
        <ul className="home-preview-list">{activeIssues.map((item) => <li className={`home-issue ${item.severity}`} key={item.id}>
          <span className="home-issue-mark" aria-hidden="true">{item.severity === 'info' ? 'i' : '!'}</span><div><small className="home-issue-severity">{t(notificationSeverityLabel(item.severity))}</small><strong dir="auto">{t(item.title)}</strong><p dir="auto">{t(item.description)}</p></div>
        </li>)}</ul>
      </PreviewState>
    </section>
    <section className="home-operation-card home-upcoming" aria-labelledby="home-upcoming-title" aria-busy={appointments.status === 'loading'}>
      <header><div><span className="home-section-kicker">{t('Coming up')}</span><h2 id="home-upcoming-title"><CalendarClock aria-hidden="true" />{t('Upcoming bookings')}</h2></div>
        <button className="btn btn-ghost" type="button" onClick={() => onNavigate({ primary: 'bookings' })}>{t('View bookings')}</button></header>
      <PreviewState status={appointments.status} empty={appointments.items.length === 0} emptyCopy={appointments.status === 'partial' ? 'No upcoming bookings in loaded results.' : 'No upcoming bookings'}>
        <ul className="home-preview-list home-booking-list">{appointments.items.slice(0, 3).map((booking) => <li key={booking.id}>
          <time dateTime={booking.startsAt}><bdi dir="ltr">{date.format(new Date(booking.startsAt))}</bdi></time>
          <strong dir="auto">{booking.customerName}</strong><span dir="auto">{booking.serviceName || t('Service not specified')}</span>
          <span className={`booking-status ${booking.status}`}>{t(bookingStatusLabel(booking.status))}</span>
        </li>)}</ul>
      </PreviewState>
      {appointments.status === 'available' && appointments.items.length === 0 && <p className="home-preview-hint">{t('New confirmed and pending appointments will appear here.')}</p>}
    </section>
    <section className="home-connections home-health-band" aria-labelledby="home-health-title" aria-busy={connections.status === 'loading'}>
        <div className="home-connections-heading"><h3 id="home-health-title"><Network aria-hidden="true" />{t('Connection health')}</h3><button className="btn btn-ghost" type="button" onClick={() => onNavigate({ primary: 'settings', secondary: 'connection-health' })}>{t('View health')}</button></div>
        <PreviewState status={connections.status} empty={connections.items.length === 0} emptyCopy="Connection status unavailable">
          <ul className="home-channel-summary">{connections.items.map((item) => <li key={item.key} className={`home-channel ${item.refreshInProgress ? 'checking' : item.status}`}>
            <ChannelIcon channel={item.key} /><span>{item.label}</span><small>{t(homeHealthLabel(item))}{item.stale && <span> · {t('Last known status')}</span>}</small>
          </li>)}</ul>
          {connections.items.some((item) => item.status === 'setup_required') && <button className="btn btn-secondary" type="button" onClick={() => onNavigate({ primary: 'settings', secondary: 'connections' })}>{t('Connect a channel')}</button>}
        </PreviewState>
      </section>
  </div>;
}

function PreviewState({ status, empty, emptyCopy, children }: { status: WorkspacePreview<unknown>['status']; empty: boolean; emptyCopy: string; children: ReactNode }) {
  const { t } = useDashboardI18n();
  if (status === 'loading') return <p className="home-preview-state" role="status">{t('Loading your overview…')}</p>;
  if (status === 'unavailable') return <p className="home-preview-state unavailable">{t('This preview is unavailable. Open the workspace to try again.')}</p>;
  return <>{empty ? <p className="home-preview-state clear">{t(emptyCopy)}</p> : children}
    {status === 'partial' && <p className="home-preview-hint">{t('Showing loaded results. Open the workspace for full details.')}</p>}</>;
}

function homeHealthLabel(item: IntegrationHealth) {
  if (item.refreshInProgress || item.status === 'checking') return 'Checking';
  if (item.status === 'connected' || item.status === 'synced') return 'Connected';
  if (item.status === 'setup_required') return 'Setup required';
  if (item.status === 'degraded') return 'Degraded';
  if (item.status === 'disconnected') return 'Disconnected';
  return item.status === 'error' ? 'Needs attention' : 'Unknown';
}

export function notificationSeverityLabel(severity: NotificationItem['severity']) {
  return severity === 'critical' ? 'Critical' : severity === 'attention' ? 'Needs attention' : 'Information';
}
