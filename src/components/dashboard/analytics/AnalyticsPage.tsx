import { useEffect, useMemo, useState } from 'react';
import { buildAnalyticsDateRange, getDashboardAnalytics } from './analytics-adapter';
import type {
  AnalyticsDatePreset,
  DashboardAnalyticsAdapter,
  DashboardAnalyticsData,
  DashboardAnalyticsPlatform,
} from './analytics-types';

const PLATFORM_DETAILS: Array<{
  key: DashboardAnalyticsPlatform;
  label: string;
  logo: string;
}> = [
  { key: 'telegram', label: 'Telegram', logo: '/logos/telegram.webp' },
  { key: 'whatsapp', label: 'WhatsApp', logo: '/logos/whatsapp-logo.webp' },
  { key: 'messenger', label: 'Messenger', logo: '/logos/messenger.webp' },
  { key: 'instagram', label: 'Instagram', logo: '/logos/instagram.webp' },
];

const PRESETS: Array<{ value: AnalyticsDatePreset; label: string }> = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
];

type AnalyticsPageProps = {
  businessId: string;
  adapter?: DashboardAnalyticsAdapter;
  mode?: 'demo' | 'live';
};

type ViewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; data: DashboardAnalyticsData };

export default function AnalyticsPage({
  businessId,
  adapter = getDashboardAnalytics,
  mode = 'demo',
}: AnalyticsPageProps) {
  const [preset, setPreset] = useState<AnalyticsDatePreset>('30d');
  const [retryKey, setRetryKey] = useState(0);
  const [state, setState] = useState<ViewState>({ status: 'loading' });
  const range = useMemo(() => buildAnalyticsDateRange(preset), [preset]);

  useEffect(() => {
    let active = true;
    const numericBusinessId = Number(businessId);
    setState({ status: 'loading' });
    adapter({ businessId: numericBusinessId, ...range })
      .then((data) => {
        if (active) setState({ status: 'success', data });
      })
      .catch(() => {
        if (active) {
          setState({
            status: 'error',
            message: 'Analytics could not be loaded. Please try again.',
          });
        }
      });
    return () => {
      active = false;
    };
  }, [adapter, businessId, range, retryKey]);

  return (
    <section id="analytics" className="mission-section analytics-section" aria-labelledby="analytics-title">
      <AnalyticsHeader preset={preset} onPresetChange={setPreset} />
      {state.status === 'loading' && <AnalyticsLoading />}
      {state.status === 'error' && (
        <AnalyticsError message={state.message} onRetry={() => setRetryKey((value) => value + 1)} />
      )}
      {state.status === 'success' && <AnalyticsDashboardView data={state.data} mode={mode} />}
    </section>
  );
}

function AnalyticsHeader({
  preset,
  onPresetChange,
}: {
  preset: AnalyticsDatePreset;
  onPresetChange: (preset: AnalyticsDatePreset) => void;
}) {
  return (
    <div className="analytics-header">
      <div>
        <div className="mission-eyebrow">BUSINESS INTELLIGENCE</div>
        <h2 id="analytics-title">Analytics</h2>
        <p>A clear view of message and booking activity for the selected business.</p>
      </div>
      <fieldset className="analytics-range" aria-label="Analytics date range">
        <legend className="analytics-visually-hidden">Date range</legend>
        {PRESETS.map((option) => (
          <button
            key={option.value}
            className={preset === option.value ? 'active' : ''}
            type="button"
            aria-pressed={preset === option.value}
            onClick={() => onPresetChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </fieldset>
    </div>
  );
}

export function AnalyticsDashboardView({
  data,
  mode = 'demo',
}: {
  data: DashboardAnalyticsData;
  mode?: 'demo' | 'live';
}) {
  const empty = data.summary.messagesReceived === 0
    && data.summary.bookingsCreated === 0
    && data.summary.bookingsRescheduled === 0
    && data.summary.bookingsCancelled === 0;

  return (
    <div className="analytics-view" aria-live="polite">
      <AnalyticsDataStatus data={data} mode={mode} />
      {empty ? <AnalyticsEmpty /> : (
        <>
          <AnalyticsSummaryCards data={data} />
          <AnalyticsDailyTrend data={data} />
          <div className="analytics-breakdown-grid">
            <AnalyticsPlatformBreakdown data={data} />
            <AnalyticsServiceBreakdown data={data} />
          </div>
          <aside className="analytics-interpretation-note">
            <span aria-hidden="true">i</span>
            <p>
              These figures describe recorded message and booking activity. Bookings per message is
              not a customer-level conversion rate, and net booking activity is not the number of
              currently active appointments.
            </p>
          </aside>
        </>
      )}
    </div>
  );
}

function AnalyticsDataStatus({
  data,
  mode,
}: {
  data: DashboardAnalyticsData;
  mode: 'demo' | 'live';
}) {
  const status = mode === 'demo'
    ? 'Demo analytics'
    : data.completeness.truncated ? 'Partial data' : 'Complete';
  return (
    <div className="analytics-status-row">
      <div className={`analytics-demo-badge ${mode}`}><span />{status}</div>
      <span className="analytics-updated">
        {mode === 'demo' ? 'Preview updated ' : 'Updated '}
        <time dateTime={data.generatedAt}>{formatTimestamp(data.generatedAt)}</time>
      </span>
      {data.completeness.truncated && (
        <div className="analytics-partial" role="status">
          This report contains partial data for the selected period.
        </div>
      )}
    </div>
  );
}

function AnalyticsSummaryCards({ data }: { data: DashboardAnalyticsData }) {
  const cards = [
    { label: 'Messages received', value: formatNumber(data.summary.messagesReceived), tone: 'messages' },
    { label: 'Bookings created', value: formatNumber(data.summary.bookingsCreated), tone: 'created' },
    { label: 'Reschedules', value: formatNumber(data.summary.bookingsRescheduled), tone: 'rescheduled' },
    { label: 'Cancellations', value: formatNumber(data.summary.bookingsCancelled), tone: 'cancelled' },
    { label: 'Net booking activity', value: formatSigned(data.summary.netBookingActivity), tone: 'net' },
    {
      label: 'Bookings per message',
      value: formatRatio(data.summary.bookingMessageRatio),
      tone: 'ratio',
      title: 'This compares booking events with received message events. It is not a customer-level conversion rate.',
    },
  ];
  return (
    <div className="analytics-kpi-grid" aria-label="Analytics summary">
      {cards.map((card) => (
        <article className={`analytics-kpi ${card.tone}`} key={card.label} title={card.title}>
          <span>{card.label}</span>
          <strong>{card.value}</strong>
          {card.tone === 'ratio' && <small>Activity ratio</small>}
        </article>
      ))}
    </div>
  );
}

function AnalyticsDailyTrend({ data }: { data: DashboardAnalyticsData }) {
  const width = 900;
  const height = 280;
  const plot = { left: 42, right: 18, top: 20, bottom: 42 };
  const maxValue = Math.max(1, ...data.daily.flatMap((day) => [
    day.messagesReceived,
    day.bookingsCreated,
    day.bookingsRescheduled,
    day.bookingsCancelled,
  ]));
  const x = (index: number) => plot.left
    + (index * (width - plot.left - plot.right)) / Math.max(1, data.daily.length - 1);
  const y = (value: number) => plot.top
    + (1 - value / maxValue) * (height - plot.top - plot.bottom);
  const series = [
    { key: 'messagesReceived', label: 'Messages', color: '#3ddc84', dash: undefined },
    { key: 'bookingsCreated', label: 'Bookings', color: '#7aa7ff', dash: undefined },
    { key: 'bookingsRescheduled', label: 'Reschedules', color: '#f2c66d', dash: '7 5' },
    { key: 'bookingsCancelled', label: 'Cancellations', color: '#ef7f87', dash: '3 5' },
  ] as const;
  const labelEvery = Math.max(1, Math.ceil(data.daily.length / 6));

  return (
    <article className="analytics-panel analytics-trend-panel">
      <div className="analytics-panel-head">
        <div><h3>Daily activity</h3><p>Recorded events by UTC day</p></div>
        <div className="analytics-legend" aria-label="Chart legend">
          {series.map((item) => <span key={item.key}><i style={{ background: item.color }} />{item.label}</span>)}
        </div>
      </div>
      <figure className="analytics-chart-wrap">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="analytics-chart-title analytics-chart-desc">
          <title id="analytics-chart-title">Daily analytics activity in UTC</title>
          <desc id="analytics-chart-desc">{chartSummary(data)}</desc>
          {[0, 0.5, 1].map((position) => {
            const lineY = plot.top + position * (height - plot.top - plot.bottom);
            const value = Math.round(maxValue * (1 - position));
            return (
              <g key={position}>
                <line className="analytics-grid-line" x1={plot.left} x2={width - plot.right} y1={lineY} y2={lineY} />
                <text className="analytics-axis-value" x={plot.left - 10} y={lineY + 4}>{value}</text>
              </g>
            );
          })}
          {series.map((item) => (
            <polyline
              key={item.key}
              fill="none"
              stroke={item.color}
              strokeDasharray={item.dash}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2.5"
              points={data.daily.map((day, index) => `${x(index)},${y(day[item.key])}`).join(' ')}
            />
          ))}
          {data.daily.map((day, index) => (
            (index % labelEvery === 0 || index === data.daily.length - 1) && (
              <text key={day.date} className="analytics-axis-date" x={x(index)} y={height - 14} textAnchor="middle">
                {formatShortDate(day.date)}
              </text>
            )
          ))}
        </svg>
        <figcaption className="analytics-visually-hidden">{chartSummary(data)}</figcaption>
      </figure>
    </article>
  );
}

function AnalyticsPlatformBreakdown({ data }: { data: DashboardAnalyticsData }) {
  return (
    <article className="analytics-panel">
      <div className="analytics-panel-head"><div><h3>Platform performance</h3><p>Activity by connected channel</p></div></div>
      <div className="analytics-table-wrap">
        <table className="analytics-table">
          <thead><tr><th>Platform</th><th>Messages</th><th>Bookings</th><th>Moved</th><th>Cancelled</th><th>Bookings/message</th></tr></thead>
          <tbody>
            {PLATFORM_DETAILS.map((platform) => {
              const row = data.platforms.find((item) => item.platform === platform.key);
              return (
                <tr key={platform.key}>
                  <th scope="row"><span className="analytics-platform"><img src={platform.logo} alt="" />{platform.label}</span></th>
                  <td>{formatNumber(row?.messagesReceived || 0)}</td>
                  <td>{formatNumber(row?.bookingsCreated || 0)}</td>
                  <td>{formatNumber(row?.bookingsRescheduled || 0)}</td>
                  <td>{formatNumber(row?.bookingsCancelled || 0)}</td>
                  <td>{formatRatio(row?.bookingMessageRatio ?? null)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function AnalyticsServiceBreakdown({ data }: { data: DashboardAnalyticsData }) {
  const unattributedTotal = data.services.unattributed.bookingsCreated
    + data.services.unattributed.bookingsRescheduled
    + data.services.unattributed.bookingsCancelled;
  return (
    <article className="analytics-panel">
      <div className="analytics-panel-head"><div><h3>Service performance</h3><p>Event-time service names for this period</p></div></div>
      <div className="analytics-table-wrap">
        <table className="analytics-table analytics-service-table">
          <thead><tr><th>Service snapshot</th><th>Created</th><th>Moved</th><th>Cancelled</th><th>Total</th></tr></thead>
          <tbody>
            {data.services.rows.map((service) => {
              const total = service.bookingsCreated + service.bookingsRescheduled + service.bookingsCancelled;
              return <tr key={service.serviceName}><th scope="row">{service.serviceName}</th><td>{service.bookingsCreated}</td><td>{service.bookingsRescheduled}</td><td>{service.bookingsCancelled}</td><td><strong>{total}</strong></td></tr>;
            })}
            {unattributedTotal > 0 && (
              <tr className="analytics-unattributed"><th scope="row">Unattributed</th><td>{data.services.unattributed.bookingsCreated}</td><td>{data.services.unattributed.bookingsRescheduled}</td><td>{data.services.unattributed.bookingsCancelled}</td><td><strong>{unattributedTotal}</strong></td></tr>
            )}
          </tbody>
        </table>
      </div>
      {data.services.truncated && <p className="analytics-service-note">Showing top services for this period.</p>}
    </article>
  );
}

export function AnalyticsLoading() {
  return <div className="analytics-loading" aria-live="polite" aria-busy="true"><div className="analytics-skeleton status" /><div className="analytics-skeleton-grid">{Array.from({ length: 6 }, (_, index) => <div className="analytics-skeleton card" key={index} />)}</div><div className="analytics-skeleton chart" /><div className="analytics-skeleton-breakdowns"><div className="analytics-skeleton panel" /><div className="analytics-skeleton panel" /></div><span className="analytics-visually-hidden">Loading analytics</span></div>;
}

function AnalyticsEmpty() {
  return <div className="analytics-state"><div className="analytics-state-icon" aria-hidden="true">○</div><h3>No analytics activity was recorded for this period.</h3><p>Try selecting a wider date range.</p></div>;
}

export function AnalyticsError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="analytics-state error" role="alert"><div className="analytics-state-icon" aria-hidden="true">!</div><h3>Analytics are temporarily unavailable</h3><p>{message}</p><button type="button" onClick={onRetry}>Try again</button></div>;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatSigned(value: number): string {
  return value > 0 ? `+${formatNumber(value)}` : formatNumber(value);
}

function formatRatio(value: number | null): string {
  return value === null ? '—' : new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(value);
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function formatShortDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`));
}

function chartSummary(data: DashboardAnalyticsData): string {
  return `${data.daily.length} UTC days. ${data.summary.messagesReceived} messages received, ${data.summary.bookingsCreated} bookings created, ${data.summary.bookingsRescheduled} reschedules and ${data.summary.bookingsCancelled} cancellations.`;
}
