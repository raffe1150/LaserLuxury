import { useEffect, useMemo, useRef, useState } from 'react';
import type { IntegrationHealth, IntegrationKey } from '../../types/dashboard';
import { api } from '../../services/api';
import { ChannelIcon } from './Icons';
import { useDashboardI18n } from '../../i18n/dashboard';

interface HealthStatusProps {
  businessId: string;
  onHealthChanged?: () => void;
}

export default function HealthStatus({ businessId, onHealthChanged }: HealthStatusProps) {
  const { t } = useDashboardI18n();
  const [health, setHealth] = useState<IntegrationHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const requestGeneration = useRef(0);
  const backgroundStarted = useRef(new Set<IntegrationKey>());

  useEffect(() => {
    const requestId = ++requestGeneration.current;
    const controller = new AbortController();
    backgroundStarted.current.clear();
    setHealth([]);
    setError(null);
    setLoading(true);

    api.getIntegrationHealth(businessId, controller.signal)
      .then((items) => {
        if (requestId !== requestGeneration.current) return;
        setHealth(items);
        const staleConfigured = items.filter((item) =>
          item.stale && item.status !== 'setup_required' && !backgroundStarted.current.has(item.key),
        );
        for (const item of staleConfigured) {
          backgroundStarted.current.add(item.key);
          void refreshOne(item.key, false, requestId, controller.signal);
        }
      })
      .catch((reason) => {
        if (controller.signal.aborted || requestId !== requestGeneration.current) return;
        setError(reason instanceof Error ? reason.message : 'Could not load integration health.');
      })
      .finally(() => {
        if (requestId === requestGeneration.current) setLoading(false);
      });
    return () => controller.abort();
  }, [businessId, retry]);

  const refreshOne = async (
    integration: IntegrationKey,
    force: boolean,
    requestId = requestGeneration.current,
    signal?: AbortSignal,
  ) => {
    setHealth((current) => current.map((item) => item.key === integration
      ? { ...item, refreshInProgress: true, status: item.lastCheckedAt ? item.status : 'checking' }
      : item));
    try {
      const result = await api.refreshIntegrationHealth(businessId, integration, force, signal);
      if (requestId !== requestGeneration.current) return;
      setHealth((current) => current.map((item) => item.key === integration ? result.data : item));
      onHealthChanged?.();
    } catch {
      if (signal?.aborted || requestId !== requestGeneration.current) return;
      setHealth((current) => current.map((item) => item.key === integration
        ? {
            ...item,
            status: item.lastCheckedAt ? item.status : 'unknown',
            detail: 'Health check could not be completed.',
            refreshInProgress: false,
            reasonCode: 'check_failed',
            action: 'retry',
          }
        : item));
    }
  };

  const summary = useMemo(() => summarizeHealth(health, loading, t), [health, loading, t]);

  return (
    <section id="health" className="insight-card dashboard-section automatic-health">
      <div className="health-overview-head">
        <div><div className="chart-title">Integration health</div><div className="chart-sub">Automatic, cached connection checks for this business</div></div>
        <div className={`health-overall ${summary.tone}`}><i aria-hidden="true" /><span>{summary.label}</span></div>
      </div>

      {loading && <HealthSkeleton />}
      {!loading && error && <div className="health-load-state"><strong>Health unavailable</strong><span>{error}</span><button type="button" onClick={() => setRetry((value) => value + 1)}>Retry</button></div>}
      {!loading && !error && <div className="automatic-health-list">
        {health.map((item) => <div className={`automatic-health-row ${statusTone(item.status)}`} key={item.key}>
          <div className="automatic-health-identity"><ChannelIcon channel={item.key} /><div><strong>{item.label}</strong><span>{t(item.detail)}</span></div></div>
          <div className="automatic-health-state"><span className="health-status-label"><i aria-hidden="true" />{t(statusLabel(item.status))}</span><small>{checkedLabel(item, t)}</small></div>
          <div className="automatic-health-actions">
            {(item.action === 'complete_setup' || item.action === 'reconnect') && <button className="health-action primary" type="button" onClick={openChannelSettings}>{item.action === 'reconnect' ? 'Reconnect' : 'Set up'}</button>}
            {item.status !== 'setup_required' && <button className="health-action" type="button" disabled={item.refreshInProgress} onClick={() => void refreshOne(item.key, true)}>{item.refreshInProgress ? 'Checking…' : 'Check now'}</button>}
          </div>
        </div>)}
      </div>}
    </section>
  );
}

function HealthSkeleton() {
  return <div className="health-skeleton" aria-label="Loading integration health">{Array.from({ length: 5 }, (_, index) => <div key={index}><i /><span /></div>)}</div>;
}

type Translate = (source: string, values?: Readonly<Record<string, string | number>>) => string;

function summarizeHealth(health: IntegrationHealth[], loading: boolean, t: Translate) {
  if (loading) return { label: t('Loading health…'), tone: 'checking' };
  const attention = health.filter((item) => ['setup_required', 'degraded', 'disconnected', 'error'].includes(item.status)).length;
  const unknown = health.filter((item) => item.status === 'unknown' || item.status === 'checking').length;
  if (attention) return { label: t(attention === 1 ? '{count} integration needs attention' : '{count} integrations need attention', { count: attention }), tone: 'attention' };
  if (unknown) return { label: t(unknown === 1 ? '{count} status awaiting verification' : '{count} statuses awaiting verification', { count: unknown }), tone: 'unknown' };
  return { label: t('All systems operational'), tone: 'healthy' };
}

function statusTone(status: IntegrationHealth['status']) {
  if (status === 'connected' || status === 'synced') return 'healthy';
  if (status === 'checking') return 'checking';
  if (status === 'setup_required' || status === 'unknown') return 'unknown';
  return 'attention';
}

function statusLabel(status: IntegrationHealth['status']) {
  if (status === 'connected' || status === 'synced') return 'Connected';
  if (status === 'checking') return 'Checking';
  if (status === 'setup_required') return 'Setup required';
  if (status === 'degraded') return 'Degraded';
  if (status === 'disconnected') return 'Disconnected';
  return 'Unknown';
}

function checkedLabel(item: IntegrationHealth, t: Translate) {
  if (!item.lastCheckedAt) return t(item.refreshInProgress ? 'Verification in progress' : 'Not checked yet');
  const elapsed = Math.max(0, Date.now() - Date.parse(item.lastCheckedAt));
  const minutes = Math.floor(elapsed / 60_000);
  const key = minutes < 1
    ? (item.stale ? 'Last checked just now' : 'Checked just now')
    : (item.stale ? 'Last checked {minutes} min ago' : 'Checked {minutes} min ago');
  const checked = t(key, { minutes });
  return item.refreshInProgress ? `${checked} · ${t('refreshing')}` : checked;
}

function openChannelSettings() {
  document.getElementById('channel-settings')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
