import type { IntegrationHealth } from '../../types/dashboard';
import { ChannelIcon, StatusDot } from './Icons';

interface HealthStatusProps {
  health: IntegrationHealth[];
  onTest: (integration: string) => void;
}

export default function HealthStatus({ health, onTest }: HealthStatusProps) {
  return (
    <section id="health" className="insight-card dashboard-section">
      <div className="chart-header">
        <div>
          <div className="chart-title">Health status</div>
          <div className="chart-sub">Connection health for this business</div>
        </div>
      </div>
      <div className="health-list">
        {health.map((item) => (
          <div className="health-row" key={item.key}>
            <div>
              <ChannelIcon channel={item.key} />
              <strong>{item.label}</strong>
            </div>
            <div className="health-state">
              <StatusDot status={item.status} />
              <span>{item.detail}</span>
              <button className="topbar-btn ghost compact" type="button" onClick={() => onTest(item.key)}>
                Test
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
