import { FormEvent, useEffect, useState, type CSSProperties } from 'react';
import BookingsPanel from '../components/dashboard/BookingsPanel';
import ConversationsPanel from '../components/dashboard/ConversationsPanel';
import DashboardShell from '../components/dashboard/DashboardShell';
import {
  Activity,
  BusinessSettings,
  ChannelSettings,
  NotificationCenter,
  SystemPromptEditor,
  UsageStatistics,
} from '../components/dashboard/DashboardSections';
import HealthStatus from '../components/dashboard/HealthStatus';
import { api, loadDashboardData } from '../services/api';
import dashboardCss from '../styles/dashboard.css?raw';
import type { Business, DashboardData, IntegrationKey } from '../types/dashboard';

interface DashboardProps {
  onNavigate: (path: '/' | '/login' | '/dashboard') => void;
}

export default function Dashboard({ onNavigate }: DashboardProps) {
  const [selectedBusinessId, setSelectedBusinessId] = useState<string>(() => {
    return localStorage.getItem('odinlink_selected_business') || '';
  });
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [addBusinessOpen, setAddBusinessOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Business | null>(null);

  useEffect(() => {
    const style = document.createElement('style');
    style.dataset.pageStyle = 'dashboard';
    style.textContent = dashboardCss;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    loadDashboardData(selectedBusinessId || undefined)
      .then((dashboardData) => {
        if (!active) return;
        setData(dashboardData);
        const id = dashboardData.selectedBusiness?.id || '';
        setSelectedBusinessId(id);
        if (id) localStorage.setItem('odinlink_selected_business', id);
      })
      .catch((err: Error) => {
        if (active) setError(err.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [selectedBusinessId, refreshKey]);

  const selectedBusiness = data?.selectedBusiness;

  useEffect(() => {
    if (!selectedBusiness) return;

    let active = true;
    let requestInFlight = false;

    const refreshConversations = async () => {
      if (requestInFlight) return;
      requestInFlight = true;

      try {
        const conversations = await api.getConversations(selectedBusiness.id);

        if (!active) return;

        setData((current) => {
          if (!current || current.selectedBusiness?.id !== selectedBusiness.id) {
            return current;
          }

          return {
            ...current,
            conversations,
          };
        });
      } catch (error) {
        console.error('Conversation auto refresh failed:', error);
      } finally {
        requestInFlight = false;
      }
    };

    const intervalId = window.setInterval(refreshConversations, 5000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [selectedBusiness?.id]);

  const handleBusinessChange = (businessId: string) => {
    setSelectedBusinessId(businessId);
    localStorage.setItem('odinlink_selected_business', businessId);
  };

  const handleSaved = (message: string, refresh = false) => {
    setToast(message);
    if (refresh) setRefreshKey((value) => value + 1);
  };

  const testIntegration = async (integration: string) => {
    if (!selectedBusiness) return;

    const integrationKey = integration as IntegrationKey;
    setToast('Testing connection...');

    try {
      const result = await api.testIntegration(
        selectedBusiness.id,
        integrationKey,
      );

      if (!result.ok) {
        throw new Error(result.message || 'Connection test failed');
      }

      setData((current) => {
        if (!current) return current;

        return {
          ...current,
          health: current.health.map((item) =>
            item.key === integrationKey
              ? {
                  ...item,
                  status:
                    integrationKey === 'google_calendar'
                      ? 'synced'
                      : 'connected',
                  detail:
                    integrationKey === 'google_calendar'
                      ? 'Synced'
                      : 'Connected',
                }
              : item,
          ),
        };
      });

      setToast(null);
    } catch (err) {
      const message = getReadableApiError(
        err instanceof Error ? err.message : 'Connection test failed',
      );

      setData((current) => {
        if (!current) return current;

        return {
          ...current,
          health: current.health.map((item) =>
            item.key === integrationKey
              ? {
                  ...item,
                  status: 'error',
                  detail: 'Connection failed',
                }
              : item,
          ),
        };
      });

      setToast(message);
    }
  };

  const createBusiness = async (payload: Partial<Business>) => {
    setToast('Creating business...');
    try {
      const created = await api.createBusiness(payload);
      setSelectedBusinessId(created.id);
      localStorage.setItem('odinlink_selected_business', created.id);
      setAddBusinessOpen(false);
      setRefreshKey((value) => value + 1);
      setToast('Business created');
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Could not create business');
    }
  };

  const deleteBusiness = async (business: Business) => {
    setToast('Deleting business...');
    try {
      await api.deleteBusiness(business.id);
      if (business.id === selectedBusinessId) {
        localStorage.removeItem('odinlink_selected_business');
        setSelectedBusinessId('');
      }
      setDeleteTarget(null);
      setRefreshKey((value) => value + 1);
      setToast('Business deleted');
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Could not delete business');
    }
  };

  return (
    <div className="dashboard-page">
      <DashboardShell
        title="Dashboard"
        businesses={data?.businesses || []}
        selectedBusinessId={selectedBusiness?.id || selectedBusinessId}
        businessName={selectedBusiness?.name}
        onBusinessChange={handleBusinessChange}
        onNavigate={onNavigate}
      >
        {loading && (
          <StateCard title="Loading dashboard" copy="Loading businesses and scoped dashboard data from backend APIs." />
        )}

        {!loading && error && <StateCard tone="error" title="Could not load dashboard" copy={error} />}

        {!loading && !error && data && !selectedBusiness && (
          <StateCard title="No business selected" copy="Create or select a business to load dashboard data." />
        )}

        {!loading && !error && data && selectedBusiness && (
          <>
            <MissionControl
              business={selectedBusiness}
              data={data}
            />

            <section id="conversations" className="mission-section">
              <div className="mission-section-head">
                <div>
                  <div className="mission-eyebrow">SMART INBOX</div>
                  <h2>Recent conversations</h2>
                  <p>Only the four most recent customers are shown here, so the dashboard stays focused.</p>
                </div>
                <div className="mission-total-pill">
                  {data.conversations.length} total
                </div>
              </div>

              <ConversationsPanel
                conversations={data.conversations.slice(0, 4)}
                businessId={selectedBusiness.id}
              />

              {data.conversations.length > 4 && (
                <div className="more-conversations-card">
                  <div>
                    <strong>+{data.conversations.length - 4} more conversations</strong>
                    <span>Your full customer history is safely available in OdinLink.</span>
                  </div>
                  <button
                    className="mission-link-button"
                    type="button"
                    onClick={() => setToast('Full Inbox will be added in the next sprint')}
                  >
                    Open full inbox →
                  </button>
                </div>
              )}
            </section>

            <section id="bookings" className="mission-section">
              <div className="mission-section-head">
                <div>
                  <div className="mission-eyebrow">TODAY</div>
                  <h2>Bookings and activity</h2>
                  <p>See the customer outcomes OdinLink is creating for the business.</p>
                </div>
              </div>
              <BookingsPanel bookings={data.bookings} />
              <Activity conversations={data.conversations} bookings={data.bookings} health={data.health} />
            </section>

            <section className="mission-section mission-admin-section">
              <div className="mission-section-head">
                <div>
                  <div className="mission-eyebrow">CONTROL CENTER</div>
                  <h2>Business setup and operations</h2>
                  <p>Manage channels, automation, usage and business settings.</p>
                </div>
              </div>

              <HealthStatus health={data.health} onTest={testIntegration} />
              <NotificationCenter health={data.health} bookings={data.bookings} />
              <UsageStatistics usage={data.usage} />
              <BusinessesCard
                businesses={data.businesses}
                selectedBusinessId={selectedBusiness.id}
                onCreate={() => setAddBusinessOpen(true)}
                onDelete={setDeleteTarget}
                onSelect={handleBusinessChange}
              />
              <BusinessSettings business={selectedBusiness} onSaved={handleSaved} />
              <SystemPromptEditor business={selectedBusiness} onSaved={handleSaved} />
              <ChannelSettings
                business={selectedBusiness}
                health={data.health}
                onSaved={handleSaved}
                onTest={testIntegration}
              />
            </section>
          </>
        )}
      </DashboardShell>

      {addBusinessOpen && (
        <AddBusinessModal onClose={() => setAddBusinessOpen(false)} onCreate={createBusiness} />
      )}

      {deleteTarget && (
        <DeleteBusinessDialog
          business={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => deleteBusiness(deleteTarget)}
        />
      )}

      {toast && (
        <button className="toast show" type="button" onClick={() => setToast(null)}>
          <span>{toast}</span>
        </button>
      )}
    </div>
  );
}


function getReadableApiError(rawMessage: string) {
  const message = String(rawMessage || '').trim();

  try {
    const parsed = JSON.parse(message) as {
      message?: string;
      error?: string;
    };

    return parsed.message || parsed.error || 'Connection test failed';
  } catch {
    return message || 'Connection test failed';
  }
}

function MissionControl({
  business,
  data,
}: {
  business: Business;
  data: DashboardData;
}) {
  const totalConversations = data.conversations.length;
  const attentionCount = data.conversations.filter(needsHumanAttention).length;
  const handledByOdinLink = Math.max(totalConversations - attentionCount, 0);
  const automationRate =
    totalConversations > 0
      ? Math.round((handledByOdinLink / totalConversations) * 100)
      : 0;

  const estimatedMinutesSaved = handledByOdinLink * 4;
  const estimatedStaffValue = Math.round((estimatedMinutesSaved / 60) * 300);
  const bookingCount = data.bookings.length;
  const greeting = getGreeting();
  const displayBusinessName = formatBusinessName(business.name);
  const connectedChannelCount = data.health.filter((item) =>
    ['connected', 'synced', 'healthy', 'active'].includes(String(item.status).toLowerCase()),
  ).length;
  const monitoringCopy = connectedChannelCount > 0
    ? `Monitoring ${connectedChannelCount} connected ${connectedChannelCount === 1 ? 'channel' : 'channels'}`
    : 'Monitoring connected customer channels';

  return (
    <section id="overview" className="mission-control">
      <div className="mission-hero">
        <div className="mission-hero-content">
          <div className="mission-live-status">
            <div className="mission-live-badge">
              <span />
              OdinLink Active
            </div>
            <span className="mission-monitoring-copy">{monitoringCopy}</span>
          </div>

          <p className="mission-greeting">{greeting} <span aria-hidden="true">👋</span></p>
          <h1>{displayBusinessName}</h1>
          <p className="mission-hero-intro">Here’s what OdinLink has accomplished today.</p>

          <div className="mission-daily-summary" aria-label="Today’s OdinLink results">
            <div className="mission-daily-item">
              <span className="mission-check" aria-hidden="true">✓</span>
              <span>Handled <strong>{handledByOdinLink}</strong> customer {handledByOdinLink === 1 ? 'conversation' : 'conversations'}</span>
            </div>
            <div className="mission-daily-item">
              <span className="mission-check" aria-hidden="true">✓</span>
              <span>Booked <strong>{bookingCount}</strong> {bookingCount === 1 ? 'appointment' : 'appointments'}</span>
            </div>
            <div className="mission-daily-item">
              <span className="mission-check" aria-hidden="true">✓</span>
              <span>Saved approximately <strong>{formatMinutes(estimatedMinutesSaved)}</strong></span>
            </div>
          </div>
        </div>

        <div className={attentionCount > 0 ? 'mission-hero-summary attention' : 'mission-hero-summary clear'}>
          <div className="mission-hero-summary-label">
            <i aria-hidden="true" />
            <span>Today</span>
          </div>
          <strong>
            {attentionCount > 0
              ? `${attentionCount} ${attentionCount === 1 ? 'conversation needs' : 'conversations need'} your attention`
              : 'Everything is running smoothly'}
          </strong>
          <small>{attentionCount > 0 ? 'Open the inbox to review.' : 'No action required.'}</small>
        </div>
      </div>

      <div className="mission-impact-card">
        <div className="mission-impact-head">
          <div>
            <div className="mission-eyebrow">ODINLINK IMPACT</div>
            <h2>Today’s business impact</h2>
            <p>Everything OdinLink accomplished for your business today.</p>
          </div>
          <div className="automation-ring" style={{ '--automation': `${automationRate}%` } as CSSProperties}>
            <div>
              <strong>{automationRate}%</strong>
              <span>automated</span>
            </div>
          </div>
        </div>

        <div className="mission-metrics">
          <ImpactMetric
            eyebrow="CUSTOMERS HELPED"
            value={String(totalConversations)}
            label="Customer conversations today"
            detail={totalConversations === 1 ? 'One customer received a response' : `${totalConversations} customers received a response`}
          />
          <ImpactMetric
            eyebrow="AUTOMATION"
            value={`${automationRate}%`}
            label="Handled without human help"
            detail={
              attentionCount > 0
                ? `${attentionCount} ${attentionCount === 1 ? 'conversation requires' : 'conversations require'} attention`
                : 'No human intervention required'
            }
          />
          <ImpactMetric
            eyebrow="APPOINTMENTS"
            value={String(bookingCount)}
            label="Appointments booked"
            detail={bookingCount > 0 ? 'Created directly by OdinLink' : 'No appointments booked yet'}
          />
          <ImpactMetric
            eyebrow="BUSINESS VALUE"
            value={`≈ ${estimatedStaffValue.toLocaleString('sv-SE')} SEK`}
            label="Estimated staff-time value"
            detail={`${formatMinutes(estimatedMinutesSaved)} saved today`}
            accent
          />
        </div>

        <div className="mission-value-strip">
          <div className="mission-value-icon">↗</div>
          <div>
            <span>Estimated staff-time value</span>
            <strong>≈ {estimatedStaffValue.toLocaleString('sv-SE')} SEK</strong>
          </div>
          <p>Calculated at 300 SEK/hour. A configurable business estimate can replace this later.</p>
        </div>
      </div>

      <div className={attentionCount > 0 ? 'action-center needs-attention' : 'action-center all-clear'}>
        <div className="action-center-icon">{attentionCount > 0 ? '!' : '✓'}</div>
        <div className="action-center-copy">
          <div className="mission-eyebrow">ACTION CENTER</div>
          <h3>
            {attentionCount > 0
              ? `${attentionCount} ${attentionCount === 1 ? 'conversation needs' : 'conversations need'} your attention`
              : 'OdinLink is handling your customers'}
          </h3>
          <p>
            {attentionCount > 0
              ? 'These conversations contain a human-attention status in the current data.'
              : 'There are no conversations currently marked for human attention.'}
          </p>
        </div>
        <button
          className="mission-action-button"
          type="button"
          onClick={() => document.getElementById('recent-conversations')?.scrollIntoView({ behavior: 'smooth' })}
        >
          {attentionCount > 0 ? 'Review conversations' : 'View recent activity'} →
        </button>
      </div>
    </section>
  );
}

function ImpactMetric({
  eyebrow,
  value,
  label,
  detail,
  accent = false,
}: {
  eyebrow: string;
  value: string;
  label: string;
  detail: string;
  accent?: boolean;
}) {
  return (
    <div className={accent ? 'impact-metric accent' : 'impact-metric'}>
      <div className="impact-metric-eyebrow">{eyebrow}</div>
      <strong>{value}</strong>
      <span>{label}</span>
      <small>{detail}</small>
    </div>
  );
}

function needsHumanAttention(conversation: unknown) {
  if (!conversation || typeof conversation !== 'object') return false;

  const record = conversation as Record<string, unknown>;
  const booleanFlags = [
    record.needs_human,
    record.needsHuman,
    record.requires_human,
    record.requiresHuman,
    record.human_attention,
    record.humanAttention,
    record.escalated,
  ];

  if (booleanFlags.some((value) => value === true)) return true;

  const status = String(
    record.status ||
    record.state ||
    record.handoff_status ||
    record.handoffStatus ||
    '',
  ).toLowerCase();

  return [
    'needs_human',
    'human_required',
    'waiting_for_human',
    'escalated',
    'takeover',
  ].some((value) => status.includes(value));
}


function formatBusinessName(name: string) {
  const normalized = String(name || '').trim().replace(/\s+/g, ' ');
  if (!normalized) return 'Your business';

  return normalized
    .split(' ')
    .map((word) => {
      if (/^[A-Z0-9]{2,}$/.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function formatMinutes(minutes: number) {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining ? `${hours}h ${remaining}m` : `${hours}h`;
}

function BusinessesCard({
  businesses,
  selectedBusinessId,
  onSelect,
  onCreate,
  onDelete,
}: {
  businesses: Business[];
  selectedBusinessId: string;
  onSelect: (businessId: string) => void;
  onCreate: () => void;
  onDelete: (business: Business) => void;
}) {
  return (
    <section id="businesses" className="card dashboard-section">
      <div className="card-header">
        <div>
          <div className="card-title">Businesses</div>
          <div className="card-desc">Select the tenant whose settings and statistics should be shown.</div>
        </div>
        <button className="btn btn-primary" type="button" onClick={onCreate}>
          Add Business
        </button>
      </div>
      {businesses.length === 0 ? (
        <div className="empty-state">No businesses returned from /api/businesses.</div>
      ) : (
        businesses.map((business) => (
          <div
            className={business.id === selectedBusinessId ? 'biz-row selected' : 'biz-row'}
            key={business.id}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(business.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') onSelect(business.id);
            }}
          >
            <div className="biz-logo">{business.name.slice(0, 1).toUpperCase()}</div>
            <div className="biz-info">
              <div className="biz-name">{business.name}</div>
              <div className="biz-meta">
                {[business.industry, business.timezone, business.language].filter(Boolean).join(' · ') || 'Business tenant'}
              </div>
            </div>
            <span className={business.id === selectedBusinessId ? 'status-chip connected' : 'status-chip disconnected'}>
              {business.id === selectedBusinessId ? 'Selected' : 'Select'}
            </span>
            <span
              className="btn btn-danger"
              role="button"
              tabIndex={0}
              onClick={(event) => {
                event.stopPropagation();
                onDelete(business);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.stopPropagation();
                  onDelete(business);
                }
              }}
            >
              Delete
            </span>
          </div>
        ))
      )}
    </section>
  );
}

function AddBusinessModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (payload: Partial<Business>) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState('');
  const [timezone, setTimezone] = useState('Europe/Stockholm');
  const [language, setLanguage] = useState<Business['language']>('en');
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onCreate({
        name: name.trim(),
        industry: industry.trim() || undefined,
        timezone: timezone.trim() || undefined,
        language,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ai-modal-overlay show" role="dialog" aria-modal="true">
      <form className="ai-modal" onSubmit={submit}>
        <button className="ai-modal-close" type="button" onClick={onClose}>×</button>
        <div className="ai-modal-title">Add Business</div>
        <div className="ai-modal-desc">Create a new tenant. Its settings, channels and stats will be scoped separately.</div>
        <div className="form-grid-2">
          <div className="form-group form-full">
            <label className="form-label">Business Name</label>
            <input className="form-input" value={name} onChange={(event) => setName(event.target.value)} required />
          </div>
          <div className="form-group">
            <label className="form-label">Business Type</label>
            <input className="form-input" value={industry} onChange={(event) => setIndustry(event.target.value)} placeholder="Service business" />
          </div>
          <div className="form-group">
            <label className="form-label">Timezone</label>
            <input className="form-input mono" value={timezone} onChange={(event) => setTimezone(event.target.value)} />
          </div>
          <div className="form-group form-full">
            <label className="form-label">Language</label>
            <select className="form-input" value={language} onChange={(event) => setLanguage(event.target.value as Business['language'])}>
              <option value="en">English</option>
              <option value="sv">Svenska</option>
              <option value="de">Deutsch</option>
              <option value="es">Español</option>
              <option value="fa">فارسی</option>
              <option value="ar">العربية</option>
            </select>
          </div>
        </div>
        <div className="save-row">
          <button className="btn btn-ghost" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" type="submit" disabled={saving || !name.trim()}>
            {saving ? 'Creating...' : 'Create Business'}
          </button>
        </div>
      </form>
    </div>
  );
}

function DeleteBusinessDialog({
  business,
  onCancel,
  onConfirm,
}: {
  business: Business;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="ai-modal-overlay show" role="dialog" aria-modal="true">
      <div className="ai-modal">
        <button className="ai-modal-close" type="button" onClick={onCancel}>×</button>
        <div className="ai-modal-title">Delete Business</div>
        <div className="ai-modal-desc">
          This will delete <strong>{business.name}</strong> and its tenant-scoped settings from the backend.
        </div>
        <div className="save-row">
          <button className="btn btn-ghost" type="button" onClick={onCancel}>Cancel</button>
          <button className="btn btn-danger" type="button" onClick={onConfirm}>Delete Business</button>
        </div>
      </div>
    </div>
  );
}

function StateCard({ title, copy, tone }: { title: string; copy: string; tone?: 'error' }) {
  return (
    <div className={`card dashboard-section state-card ${tone || ''}`}>
      <div className="card-title">{title}</div>
      <div className="card-desc">{copy}</div>
    </div>
  );
}
