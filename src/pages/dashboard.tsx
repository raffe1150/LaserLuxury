import { FormEvent, useEffect, useState } from 'react';
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
import OverviewCards from '../components/dashboard/OverviewCards';
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
            <OverviewCards
              stats={data.stats}
              performance={data.performance}
              usage={data.usage}
              chart={data.bookingsChart}
            />
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
            <ChannelSettings business={selectedBusiness} health={data.health} onSaved={handleSaved} onTest={testIntegration} />
            <ConversationsPanel conversations={data.conversations} />
            <BookingsPanel bookings={data.bookings} />
            <Activity conversations={data.conversations} bookings={data.bookings} health={data.health} />
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
