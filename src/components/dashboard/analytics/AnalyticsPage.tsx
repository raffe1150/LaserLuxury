import { useEffect, useMemo, useRef, useState } from 'react';
import {
  analyticsRequestKey,
  analyticsWindowForSelection,
  createAnalyticsRequestGuard,
  getDashboardAnalytics,
} from './analytics-adapter';
import type {
  AnalyticsDatePreset,
  DashboardAnalyticsAdapter,
  DashboardAnalyticsData,
  DashboardAnalyticsRequest,
} from './analytics-types';
import { useDashboardI18n } from '../../../i18n/dashboard';

const PLATFORM_DETAILS = {
  telegram: { label: 'Telegram', logo: '/logos/telegram.webp' },
  whatsapp: { label: 'WhatsApp', logo: '/logos/whatsapp-logo.webp' },
  messenger: { label: 'Messenger', logo: '/logos/messenger.webp' },
  instagram: { label: 'Instagram', logo: '/logos/instagram.webp' },
} as const;

const PRESETS: Array<{ value: AnalyticsDatePreset; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'custom', label: 'Custom' },
];

type WorkspaceTab = 'overview' | 'channels' | 'services';

type AnalyticsPageProps = {
  businessId: string;
  adapter?: DashboardAnalyticsAdapter;
};

type ViewState =
  | { status: 'loading' }
  | { status: 'custom' }
  | { status: 'error'; message: string }
  | { status: 'success'; data: DashboardAnalyticsData; requestKey: string };

export default function AnalyticsPage({ businessId, adapter = getDashboardAnalytics }: AnalyticsPageProps) {
  const [preset, setPreset] = useState<AnalyticsDatePreset>('30d');
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const [state, setState] = useState<ViewState>({ status: 'loading' });
  const requestGuard = useRef(createAnalyticsRequestGuard());
  const window = useMemo(
    () => analyticsWindowForSelection(preset, customStartDate, customEndDate),
    [customEndDate, customStartDate, preset],
  );
  const request = useMemo<DashboardAnalyticsRequest | null>(
    () => window ? { businessId, window } : null,
    [businessId, window],
  );
  const currentRequestKey = request ? analyticsRequestKey(request) : null;
  const visibleState: ViewState = state.status === 'success' && state.requestKey !== currentRequestKey
    ? (request ? { status: 'loading' } : { status: 'custom' })
    : state;

  useEffect(() => {
    if (!request) {
      requestGuard.current.invalidate();
      setState({ status: 'custom' });
      return;
    }
    const controller = new AbortController();
    const identity = requestGuard.current.begin();
    const requestKey = analyticsRequestKey(request);
    setState({ status: 'loading' });
    adapter(request, controller.signal)
      .then((data) => {
        if (identity.isCurrent()) setState({ status: 'success', data, requestKey });
      })
      .catch((error: unknown) => {
        if (identity.isCurrent() && !(error instanceof DOMException && error.name === 'AbortError')) {
          setState({ status: 'error', message: 'Analytics could not be loaded. Please try again.' });
        }
      });
    return () => {
      controller.abort();
      if (identity.isCurrent()) requestGuard.current.invalidate();
    };
  }, [adapter, request, retryKey]);

  return (
    <section id="analytics" className="mission-section analytics-section" aria-labelledby="analytics-title">
      <AnalyticsHeader
        preset={preset}
        customStartDate={customStartDate}
        customEndDate={customEndDate}
        onPresetChange={setPreset}
        onCustomStartDateChange={setCustomStartDate}
        onCustomEndDateChange={setCustomEndDate}
      />
      {visibleState.status === 'loading' && <AnalyticsLoading />}
      {visibleState.status === 'custom' && <AnalyticsCustomRangePrompt />}
      {visibleState.status === 'error' && (
        <AnalyticsError message={visibleState.message} onRetry={() => setRetryKey((value) => value + 1)} />
      )}
      {visibleState.status === 'success' && <AnalyticsDashboardView data={visibleState.data} />}
    </section>
  );
}

function AnalyticsHeader({
  preset,
  customStartDate,
  customEndDate,
  onPresetChange,
  onCustomStartDateChange,
  onCustomEndDateChange,
}: {
  preset: AnalyticsDatePreset;
  customStartDate: string;
  customEndDate: string;
  onPresetChange: (preset: AnalyticsDatePreset) => void;
  onCustomStartDateChange: (value: string) => void;
  onCustomEndDateChange: (value: string) => void;
}) {
  return (
    <div className="analytics-header">
      <div>
        <div className="mission-eyebrow">BUSINESS INTELLIGENCE</div>
        <h2 id="analytics-title">Analytics</h2>
        <p>Performance, demand and booking outcomes at a glance.</p>
      </div>
      <fieldset className="analytics-range" aria-label="Analytics date range">
        <legend className="analytics-visually-hidden">Date range</legend>
        {PRESETS.map((option) => (
          <button key={option.value} className={preset === option.value ? 'active' : ''} type="button" aria-pressed={preset === option.value} onClick={() => onPresetChange(option.value)}>
            {option.label}
          </button>
        ))}
        {preset === 'custom' && (
          <span className="analytics-custom-range">
            <label><span className="analytics-visually-hidden">Custom start date</span><input type="date" value={customStartDate} onChange={(event) => onCustomStartDateChange(event.target.value)} /></label>
            <span aria-hidden="true">–</span>
            <label><span className="analytics-visually-hidden">Custom end date</span><input type="date" value={customEndDate} onChange={(event) => onCustomEndDateChange(event.target.value)} /></label>
          </span>
        )}
      </fieldset>
    </div>
  );
}

export function AnalyticsDashboardView({
  data,
  initialTab = 'overview',
}: {
  data: DashboardAnalyticsData;
  initialTab?: WorkspaceTab;
}) {
  const { t } = useDashboardI18n();
  const [tab, setTab] = useState<WorkspaceTab>(initialTab);

  return (
    <div className="analytics-workspace" aria-live="polite">
      <div className="analytics-workspace-bar">
        <nav className="analytics-tabs" aria-label="Analytics views">
          {(['overview', 'channels', 'services'] as const).map((value) => (
            <button key={value} type="button" className={tab === value ? 'active' : ''} aria-pressed={tab === value} onClick={() => setTab(value)}>
              {t(value[0].toUpperCase() + value.slice(1))}
            </button>
          ))}
        </nav>
        <AnalyticsDataStatus data={data} />
      </div>
      {data.dataQuality.status === 'unavailable' ? <AnalyticsUnavailable /> : (
        <>
          {tab === 'overview' && <AnalyticsOverview data={data} />}
          {tab === 'channels' && <AnalyticsChannelTable data={data} />}
          {tab === 'services' && <AnalyticsServiceTable data={data} />}
        </>
      )}
    </div>
  );
}

function AnalyticsDataStatus({ data }: { data: DashboardAnalyticsData }) {
  const { locale, t } = useDashboardI18n();
  const status = data.dataQuality.status === 'complete' ? 'Complete data'
    : data.dataQuality.status === 'partial' ? 'Partial data coverage'
      : 'Data unavailable';
  return (
    <details className={`analytics-quality ${data.dataQuality.status}`}>
      <summary><span aria-hidden="true" />{status}<b aria-hidden="true">ⓘ</b></summary>
      <div className="analytics-quality-popover">
        <strong>{status}</strong>
        <p>{t('{events} events and {appointments} authoritative appointments checked.', { events: formatNumber(data.dataQuality.checkedEvents, locale), appointments: formatNumber(data.dataQuality.checkedAppointments, locale) })}</p>
        {data.dataQuality.status !== 'complete' && <p>Some metrics may not represent the entire selected period.</p>}
        <p>Updated <time dateTime={data.generatedAt}>{formatTimestamp(data.generatedAt, locale)}</time>.</p>
      </div>
    </details>
  );
}

function AnalyticsOverview({ data }: { data: DashboardAnalyticsData }) {
  return (
    <div className="analytics-overview">
      <AnalyticsKpiStrip data={data} />
    </div>
  );
}

function AnalyticsKpiStrip({ data }: { data: DashboardAnalyticsData }) {
  const { locale, t } = useDashboardI18n();
  const conversationCoverage = data.dataQuality.conversations;
  const conversationValue = conversationCoverage === 'complete'
    ? formatNumber(data.conversations.totalConversations, locale)
    : '—';
  const conversationContext = conversationCoverage === 'complete'
    ? 'Conversation starts'
    : conversationCoverage === 'partial'
      ? 'Incomplete event coverage'
      : 'Conversation data unavailable';
  const value = formatRevenueEstimate(data, locale);
  const revenueContext = data.revenue.coverage === 'complete'
    ? 'Configured prices · not payments'
    : data.revenue.coverage === 'partial'
      ? t('{known} of {total} bookings priced · not payments', { known: formatNumber(data.revenue.revenueKnownCount, locale), total: formatNumber(data.revenue.completedBookingCount, locale) })
      : 'Configured price coverage unavailable';
  const cards = [
    { label: 'New conversations', value: conversationValue, note: conversationContext, tone: conversationCoverage === 'complete' ? 'green' : 'caution' },
    { label: 'Completed bookings', value: formatNumber(data.funnel.bookingCompleted, locale), note: 'Verified completions', tone: 'blue' },
    { label: 'Estimated booking value', value, note: revenueContext, tone: data.revenue.coverage === 'complete' ? 'gold' : 'caution' },
  ];
  return (
    <div className="analytics-kpi-strip" aria-label="Business performance summary">
      {cards.map((card) => (
        <article className={`analytics-kpi-card ${card.tone}`} key={card.label}>
          <span>{card.label}</span>
          <strong>{card.value}</strong>
          <small>{card.note}</small>
        </article>
      ))}
    </div>
  );
}

export function AnalyticsChannelTable({ data }: { data: DashboardAnalyticsData }) {
  const { locale, t } = useDashboardI18n();
  const rows = data.channels.map((channel) => ({
    ...channel,
    identity: PLATFORM_DETAILS[channel.channel as keyof typeof PLATFORM_DETAILS],
  }));
  return (
    <article className="analytics-module analytics-table-module">
      <div className="analytics-module-head"><div><span>CHANNEL PERFORMANCE</span><h3>Where bookings come from</h3></div><small>{t(rows.length === 1 ? '{count} active channel in this period' : '{count} active channels in this period', { count: rows.length })}</small></div>
      <div className="analytics-compact-table" role="table" aria-label="Channel performance">
        <div className="analytics-table-row header" role="row"><span role="columnheader">Channel</span><span role="columnheader">Conversations</span><span role="columnheader">Completed</span><span role="columnheader">Conversion</span><span role="columnheader">Needs attention</span></div>
        {rows.map((row) => (
          <div className="analytics-table-row" role="row" key={row.channel}>
            <span role="cell" className="analytics-table-identity">{row.identity && <img src={row.identity.logo} alt="" />}<strong>{row.identity?.label || titleCase(row.channel)}</strong></span>
            <strong role="cell">{data.dataQuality.conversations === 'complete' ? formatNumber(row.conversations, locale) : '—'}</strong>
            <strong role="cell">{formatNumber(row.bookingCompleted, locale)}</strong>
            <strong role="cell">{formatRatio(data.dataQuality.status === 'complete' ? row.conversionRate : null, locale)}</strong>
            <span role="cell" className={row.failures > 0 || row.noAvailability > 0 ? 'analytics-attention' : ''}>{t('{failed} failed · {unavailable} unavailable', { failed: formatNumber(row.failures, locale), unavailable: formatNumber(row.noAvailability, locale) })}</span>
          </div>
        ))}
      </div>
      {rows.length === 0 && <p className="analytics-table-empty">No channel activity was recorded in this period.</p>}
    </article>
  );
}

export function AnalyticsServiceTable({ data }: { data: DashboardAnalyticsData }) {
  const { locale } = useDashboardI18n();
  const completeCoverage = data.dataQuality.status === 'complete';
  const rows = [...data.services].sort((left, right) => right.bookingCompleted - left.bookingCompleted || right.bookingStarted - left.bookingStarted);
  return (
    <article className="analytics-module analytics-table-module">
      <div className="analytics-module-head"><div><span>SERVICE PERFORMANCE</span><h3>What customers book</h3></div><small>Ranked by completed bookings</small></div>
      <div className="analytics-compact-table services" role="table" aria-label="Service performance">
        <div className="analytics-table-row header" role="row"><span role="columnheader">Service</span><span role="columnheader">Demand</span><span role="columnheader">Started</span><span role="columnheader">Completed</span><span role="columnheader">Conversion</span></div>
        {rows.map((row, index) => (
          <div className="analytics-table-row" role="row" key={`${row.serviceName || 'unattributed'}-${index}`}>
            <span role="cell" className="analytics-service-name"><i>{formatNumber(index + 1, locale)}</i><strong translate={row.serviceName ? 'no' : undefined}>{row.serviceName || 'Unattributed'}</strong></span>
            <strong role="cell">{completeCoverage ? formatNumber(row.availabilityRequests, locale) : '—'}</strong>
            <strong role="cell">{completeCoverage ? formatNumber(row.bookingStarted, locale) : '—'}</strong>
            <strong role="cell">{formatNumber(row.bookingCompleted, locale)}</strong>
            <strong role="cell">{formatRatio(completeCoverage ? row.conversionRate : null, locale)}</strong>
          </div>
        ))}
      </div>
      {rows.length === 0 && <p className="analytics-table-empty">No service activity was recorded in this period.</p>}
      <p className="analytics-table-footnote">Service-level value is not shown because the backend does not currently attribute known-price estimates by service.</p>
    </article>
  );
}

export function AnalyticsLoading() {
  return <div className="analytics-loading" aria-live="polite" aria-busy="true"><div className="analytics-skeleton analytics-skeleton-bar" /><div className="analytics-skeleton-grid">{Array.from({ length: 3 }, (_, index) => <div className="analytics-skeleton card" key={index} />)}</div><span className="analytics-visually-hidden">Loading analytics</span></div>;
}

function AnalyticsCustomRangePrompt() {
  return <div className="analytics-state"><div className="analytics-state-icon" aria-hidden="true">○</div><h3>Select a custom date range</h3><p>Choose a start and end date to load business-local analytics.</p></div>;
}

function AnalyticsUnavailable() {
  return <div className="analytics-state"><div className="analytics-state-icon" aria-hidden="true">!</div><h3>Analytics coverage is unavailable</h3><p>No zero-value performance claim is being made.</p></div>;
}

export function AnalyticsError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="analytics-state error" role="alert"><div className="analytics-state-icon" aria-hidden="true">!</div><h3>Analytics are temporarily unavailable</h3><p>{message}</p><button type="button" onClick={onRetry}>Try again</button></div>;
}

function formatRevenueEstimate(data: DashboardAnalyticsData, locale = 'en'): string {
  if (data.revenue.coverage === 'unavailable' || data.revenue.estimatedRevenueFromKnownPrices.length === 0) return '—';
  return data.revenue.estimatedRevenueFromKnownPrices
    .map(({ currency, amount }) => new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount))
    .join(' + ');
}

function formatNumber(value: number, locale = 'en'): string {
  return new Intl.NumberFormat(locale).format(value);
}

function formatRatio(value: number | null, locale = 'en'): string {
  return value === null ? '—' : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(value);
}

function formatTimestamp(value: string, locale = 'en'): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}


function titleCase(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
