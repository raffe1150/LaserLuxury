import type { BusinessStats, PlatformPerformance, UsageInfo } from '../../types/dashboard';

interface OverviewCardsProps {
  stats: BusinessStats;
  performance: PlatformPerformance;
  usage: UsageInfo;
  chart: Array<{ label: string; value: number }>;
}

export default function OverviewCards({ stats, performance, usage, chart }: OverviewCardsProps) {
  const max = Math.max(1, ...chart.map((item) => item.value));
  const usagePercent = usage.limit > 0 ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;

  return (
    <section id="overview">
      <div className="stats-grid">
        <article className="stat-card">
          <div className="stat-card-num">
            <em>{stats.todaysBookings}</em>
          </div>
          <div className="stat-card-label">Today's bookings</div>
        </article>
        <article className="stat-card">
          <div className="stat-card-num">
            <em>{stats.missedConversations}</em>
          </div>
          <div className="stat-card-label">Missed conversations</div>
        </article>
        <article className="stat-card">
          <div className="stat-card-num">
            <em>{stats.conversionRate}%</em>
          </div>
          <div className="stat-card-label">Conversion</div>
        </article>
        <article className="stat-card">
          <div className="stat-card-num">
            <em>{formatMinutes(stats.aiSavedMinutes)}</em>
          </div>
          <div className="stat-card-label">AI saved you this week</div>
        </article>
      </div>

      <div className="overview-grid">
        <article className="chart-card">
          <div className="chart-header">
            <div>
              <div className="chart-title">Bookings</div>
              <div className="chart-sub">Last 7 days</div>
            </div>
            <div className="chart-toggle">
              <span className="active">Week</span>
            </div>
          </div>
          <div className="bar-chart">
            {chart.map((item) => (
              <div key={item.label} className="bar-col">
                <div className="bar-track">
                  <div
                    className="bar-fill"
                    style={{ height: `${Math.max(4, (item.value / max) * 100)}%` }}
                  />
                </div>
                <div className="bar-label">{item.label}</div>
              </div>
            ))}
          </div>
        </article>

        <article className="insight-card">
          <div className="chart-header">
            <div>
              <div className="chart-title">Platform performance</div>
              <div className="chart-sub">Automation quality</div>
            </div>
          </div>
          <Metric label="Handled automatically" value={`${performance.handledAutomatically}%`} />
          <Metric label="Escalated to human" value={`${performance.escalatedToHuman}%`} />
          <Metric label="Booking success" value={`${performance.bookingSuccess}%`} />
          <Metric label="Average reply" value={`${performance.averageReplySeconds} sec`} />
        </article>
      </div>

      <div className="overview-grid">
        <article className="insight-card">
          <div className="chart-header">
            <div>
              <div className="chart-title">Usage</div>
              <div className="chart-sub">{usage.plan}</div>
            </div>
          </div>
          <div className="usage-meta">
            <span>{usage.used} AI replies</span>
            <span>{usage.limit} limit</span>
          </div>
          <div className="usage-bar">
            <div className="usage-fill" style={{ width: `${usagePercent}%` }} />
          </div>
          <div className="usage-meta">
            <span>{usagePercent}% used</span>
            <span>{usage.limit > usage.used ? usage.limit - usage.used : 0} remaining</span>
          </div>
        </article>

        <article className="ai-saved-card">
          <div className="chart-title">Customers served while offline</div>
          <div className="stat-card-num">
            <em>{stats.customersServedOffline}</em>
          </div>
          <div className="chart-sub">Calculated from backend business stats</div>
        </article>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="performance-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatMinutes(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}h ${rest}m`;
}

