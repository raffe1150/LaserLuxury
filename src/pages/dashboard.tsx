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

  useEffect(() => {
    if (!toast) return;
    const timeoutId = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(timeoutId);
  }, [toast]);

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
                  <div className="mission-eyebrow">ODINLINK INBOX</div>
                  <h2>Customer conversations</h2>
                  <p>See who OdinLink helped, what needs attention and the latest customer activity.</p>
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
                    <span>Open the full inbox to review every customer interaction.</span>
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
              <CancellationSettings business={selectedBusiness} onSaved={handleSaved} />
              <AdminNotificationSettings business={selectedBusiness} onSaved={handleSaved} />
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


function CancellationSettings({
  business,
  onSaved,
}: {
  business: Business;
  onSaved: (message: string, refresh?: boolean) => void;
}) {
  const [allowCancellation, setAllowCancellation] = useState(false);
  const [deadlinePreset, setDeadlinePreset] = useState<'0' | '360' | '720' | '1440' | 'custom'>('0');
  const [customDeadlineValue, setCustomDeadlineValue] = useState('');
  const [customDeadlineUnit, setCustomDeadlineUnit] = useState<'hours' | 'days'>('hours');
  const [feeEnabled, setFeeEnabled] = useState(false);
  const [feeAmount, setFeeAmount] = useState('');
  const [currency, setCurrency] = useState('SEK');
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    setLoadingSettings(true);
    fetch(`/api/businesses/${business.id}/cancellation-settings`, { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        return response.json();
      })
      .then((result) => {
        if (!active) return;
        const settings = result?.data || {};
        const minutes = Math.max(0, Number(settings.cancellationDeadlineMinutes || 0));
        setAllowCancellation(Boolean(settings.allowCancellation));
        if ([0, 360, 720, 1440].includes(minutes)) {
          setDeadlinePreset(String(minutes) as '0' | '360' | '720' | '1440');
          setCustomDeadlineValue('');
        } else {
          setDeadlinePreset('custom');
          if (minutes % 1440 === 0) {
            setCustomDeadlineValue(String(minutes / 1440));
            setCustomDeadlineUnit('days');
          } else {
            setCustomDeadlineValue(String(minutes / 60));
            setCustomDeadlineUnit('hours');
          }
        }
        setFeeEnabled(Boolean(settings.cancellationFeeEnabled));
        setFeeAmount(settings.cancellationFeeAmount ? String(settings.cancellationFeeAmount) : '');
        setCurrency(String(settings.cancellationFeeCurrency || 'SEK').toUpperCase());
      })
      .catch((error) => {
        if (active) onSaved(error instanceof Error ? error.message : 'Could not load cancellation settings');
      })
      .finally(() => {
        if (active) setLoadingSettings(false);
      });

    return () => { active = false; };
  }, [business.id]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    let deadlineMinutes = deadlinePreset === 'custom'
      ? Number(customDeadlineValue) * (customDeadlineUnit === 'days' ? 1440 : 60)
      : Number(deadlinePreset);
    const amount = Number(feeAmount || 0);

    if (!Number.isFinite(deadlineMinutes) || deadlineMinutes < 0) {
      onSaved('Enter a valid cancellation deadline');
      return;
    }
    deadlineMinutes = Math.round(deadlineMinutes);
    if (deadlinePreset === 'custom' && deadlineMinutes <= 0) {
      onSaved('Custom deadline must be greater than zero');
      return;
    }
    if (feeEnabled && (!Number.isFinite(amount) || amount <= 0)) {
      onSaved('Enter the late-cancellation fee amount');
      return;
    }

    setSaving(true);
    try {
      const response = await fetch(`/api/businesses/${business.id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          allowCancellation,
          cancellationDeadlineMinutes: deadlineMinutes,
          cancellationFeeEnabled: feeEnabled,
          cancellationFeeAmount: feeEnabled ? amount : 0,
          cancellationFeeCurrency: currency.trim().toUpperCase() || 'SEK',
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      onSaved('Cancellation policy saved', true);
    } catch (error) {
      onSaved(error instanceof Error ? error.message : 'Could not save cancellation policy');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section id="cancellation-settings" className="card dashboard-section cancellation-settings-card">
      <div className="card-header cancellation-card-header">
        <div>
          <div className="card-title">Customer Cancellations</div>
          <div className="card-desc">Let customers cancel a selected appointment in chat, with final confirmation and an optional late-cancellation fee.</div>
        </div>
        <label className="toggle-wrap">
          <span className="enabled-label">{allowCancellation ? 'Enabled' : 'Disabled'}</span>
          <span className="toggle">
            <input type="checkbox" checked={allowCancellation} onChange={(event) => setAllowCancellation(event.target.checked)} />
            <span className="toggle-slider" />
          </span>
        </label>
      </div>

      {loadingSettings ? (
        <div className="admin-notification-loading">Loading cancellation settings...</div>
      ) : (
        <form onSubmit={save}>
          <div className={allowCancellation ? 'cancellation-policy-body' : 'cancellation-policy-body disabled'}>
            <div className="form-group">
              <label className="form-label" htmlFor="cancellation-deadline">Free cancellation deadline</label>
              <select id="cancellation-deadline" className="form-input" value={deadlinePreset} disabled={!allowCancellation} onChange={(event) => setDeadlinePreset(event.target.value as typeof deadlinePreset)}>
                <option value="0">Anytime before the appointment</option>
                <option value="360">6 hours before</option>
                <option value="720">12 hours before</option>
                <option value="1440">24 hours before</option>
                <option value="custom">Custom</option>
              </select>
              <div className="form-hint">Inside this window, the optional late-cancellation fee can apply.</div>
            </div>

            {deadlinePreset === 'custom' && (
              <div className="cancellation-custom-grid">
                <div className="form-group">
                  <label className="form-label" htmlFor="custom-cancellation-value">Custom value</label>
                  <input id="custom-cancellation-value" className="form-input" type="number" min="1" step="1" value={customDeadlineValue} disabled={!allowCancellation} onChange={(event) => setCustomDeadlineValue(event.target.value)} placeholder="36" />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="custom-cancellation-unit">Unit</label>
                  <select id="custom-cancellation-unit" className="form-input" value={customDeadlineUnit} disabled={!allowCancellation} onChange={(event) => setCustomDeadlineUnit(event.target.value as 'hours' | 'days')}>
                    <option value="hours">Hours</option>
                    <option value="days">Days</option>
                  </select>
                </div>
              </div>
            )}

            <div className="cancellation-fee-box">
              <label className="cancellation-fee-toggle">
                <span>
                  <strong>Charge a late-cancellation fee</strong>
                  <small>The business chooses the exact amount. OdinLink only informs the customer; it does not collect payment.</small>
                </span>
                <span className="toggle">
                  <input type="checkbox" checked={feeEnabled} disabled={!allowCancellation || deadlinePreset === '0'} onChange={(event) => setFeeEnabled(event.target.checked)} />
                  <span className="toggle-slider" />
                </span>
              </label>

              {feeEnabled && deadlinePreset !== '0' && (
                <div className="cancellation-fee-grid">
                  <div className="form-group">
                    <label className="form-label" htmlFor="cancellation-fee-amount">Fee amount</label>
                    <input id="cancellation-fee-amount" className="form-input" type="number" min="0" step="0.01" value={feeAmount} disabled={!allowCancellation} onChange={(event) => setFeeAmount(event.target.value)} placeholder="250" />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="cancellation-fee-currency">Currency</label>
                    <input id="cancellation-fee-currency" className="form-input mono" maxLength={3} value={currency} disabled={!allowCancellation} onChange={(event) => setCurrency(event.target.value.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase())} placeholder="SEK" />
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="save-row">
            <button className="btn btn-primary" type="submit" disabled={saving}>
              {saving ? 'Saving...' : 'Save Cancellation Policy'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function AdminNotificationSettings({
  business,
  onSaved,
}: {
  business: Business;
  onSaved: (message: string, refresh?: boolean) => void;
}) {
  const [channel, setChannel] = useState<'telegram' | 'whatsapp'>('telegram');
  const [whatsappNumber, setWhatsappNumber] = useState('');
  const [telegramChatId, setTelegramChatId] = useState('');
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    setLoadingSettings(true);

    fetch(`/api/businesses/${business.id}/admin-notification-settings`, {
      credentials: 'include',
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        return response.json();
      })
      .then((result) => {
        if (!active) return;
        const settings = result?.data || {};
        setChannel(settings.channel === 'whatsapp' ? 'whatsapp' : 'telegram');
        setWhatsappNumber(String(settings.whatsappNumber || ''));
        setTelegramChatId(String(settings.telegramChatId || ''));
      })
      .catch((error) => {
        if (active) onSaved(error instanceof Error ? error.message : 'Could not load notification settings');
      })
      .finally(() => {
        if (active) setLoadingSettings(false);
      });

    return () => {
      active = false;
    };
  }, [business.id]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const cleanWhatsApp = whatsappNumber.replace(/\D/g, '');

    if (channel === 'whatsapp' && cleanWhatsApp.length < 8) {
      onSaved('Enter the admin WhatsApp number with country code, for example 46701234567');
      return;
    }

    if (channel === 'telegram' && !telegramChatId.trim()) {
      onSaved('Add the Telegram Admin Chat ID under Channel Settings first');
      return;
    }

    setSaving(true);
    try {
      const response = await fetch(`/api/businesses/${business.id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adminNotificationChannel: channel,
          adminWhatsAppNumber: cleanWhatsApp,
        }),
      });

      if (!response.ok) throw new Error(await response.text());
      setWhatsappNumber(cleanWhatsApp);
      onSaved('Admin notification settings saved', true);
    } catch (error) {
      onSaved(error instanceof Error ? error.message : 'Could not save notification settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section id="admin-notifications" className="card dashboard-section admin-notification-card">
      <div className="card-header">
        <div>
          <div className="card-title">Admin Notifications</div>
          <div className="card-desc">Choose where the business receives new booking and reschedule alerts.</div>
        </div>
      </div>

      {loadingSettings ? (
        <div className="admin-notification-loading">Loading notification settings...</div>
      ) : (
        <form onSubmit={save}>
          <div className="admin-notification-options" role="radiogroup" aria-label="Admin notification channel">
            <label className={channel === 'telegram' ? 'admin-channel-option selected' : 'admin-channel-option'}>
              <input
                type="radio"
                name="admin-notification-channel"
                value="telegram"
                checked={channel === 'telegram'}
                onChange={() => setChannel('telegram')}
              />
              <span className="admin-channel-icon">✈</span>
              <span>
                <strong>Telegram</strong>
                <small>Send booking alerts to the configured Admin Chat ID.</small>
              </span>
            </label>

            <label className={channel === 'whatsapp' ? 'admin-channel-option selected' : 'admin-channel-option'}>
              <input
                type="radio"
                name="admin-notification-channel"
                value="whatsapp"
                checked={channel === 'whatsapp'}
                onChange={() => setChannel('whatsapp')}
              />
              <span className="admin-channel-icon">☏</span>
              <span>
                <strong>WhatsApp</strong>
                <small>Send booking alerts to the business owner's WhatsApp.</small>
              </span>
            </label>
          </div>

          {channel === 'telegram' ? (
            <div className="admin-notification-summary">
              <span>Telegram Admin Chat ID</span>
              <strong>{telegramChatId || 'Not configured'}</strong>
              <small>Change this value under Channel Settings → Telegram.</small>
            </div>
          ) : (
            <div className="form-group admin-whatsapp-field">
              <label className="form-label" htmlFor="admin-whatsapp-number">Admin WhatsApp number</label>
              <input
                id="admin-whatsapp-number"
                className="form-input mono"
                inputMode="tel"
                value={whatsappNumber}
                onChange={(event) => setWhatsappNumber(event.target.value)}
                placeholder="46701234567"
              />
              <div className="form-hint">Use country code without +, spaces or dashes.</div>
            </div>
          )}

          <div className="save-row">
            <button className="btn btn-primary" type="submit" disabled={saving}>
              {saving ? 'Saving...' : 'Save Notification Channel'}
            </button>
          </div>
        </form>
      )}
    </section>
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
    ? `Working across ${connectedChannelCount} connected ${connectedChannelCount === 1 ? 'channel' : 'channels'}`
    : 'Working across your connected channels';

  const automationLabel =
    automationRate >= 95
      ? 'Excellent'
      : automationRate >= 80
        ? 'Strong'
        : automationRate >= 60
          ? 'Moderate'
          : 'Needs attention';

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

          <div className="hero-results-block">
            <div className="hero-results-label">TODAY’S RESULTS</div>
            <div className="hero-result-grid">
              <HeroResult icon="customers" value={String(totalConversations)} label="Customers helped" />
              <HeroResult icon="bookings" value={String(bookingCount)} label="Appointments booked" />
              <HeroResult icon="time" value={formatMinutesLong(estimatedMinutesSaved)} label="Saved for your team" />
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
          <div className="mission-impact-copy">
            <div className="mission-eyebrow">BUSINESS IMPACT</div>
            <h2>How OdinLink performed today</h2>
            <p>Customer service, automation, bookings and estimated value in one clear view.</p>
          </div>

          <div className="automation-score-card">
            <div
              className="automation-ring"
              style={{ '--automation': `${automationRate}%` } as CSSProperties}
              aria-label={`${automationRate}% automation score`}
            >
              <div>
                <strong>{automationRate}%</strong>
              </div>
            </div>
            <div className="automation-score-copy">
              <span>AUTOMATION SCORE</span>
              <strong>{automationLabel}</strong>
              <small>
                {attentionCount > 0
                  ? `${attentionCount} ${attentionCount === 1 ? 'conversation needs' : 'conversations need'} human help`
                  : 'All conversations handled without human help'}
              </small>
            </div>
          </div>
        </div>

        <div className="mission-metrics">
          <ImpactMetric
            eyebrow="CUSTOMER ACTIVITY"
            value={String(totalConversations)}
            label="Customers helped today"
            detail={totalConversations === 1 ? 'One customer received a response' : `${totalConversations} customer conversations handled`}
          />
          <ImpactMetric
            eyebrow="AUTOMATION"
            value={`${automationRate}%`}
            label="Fully automated"
            detail={
              attentionCount > 0
                ? `${attentionCount} ${attentionCount === 1 ? 'conversation required' : 'conversations required'} human help`
                : 'No manual intervention required'
            }
          />
          <ImpactMetric
            eyebrow="BOOKING SUCCESS"
            value={String(bookingCount)}
            label="Appointments booked"
            detail={bookingCount > 0 ? 'Created directly by OdinLink' : 'No appointments booked yet'}
          />
          <ImpactMetric
            eyebrow="BUSINESS VALUE"
            value={estimatedStaffValue.toLocaleString('sv-SE')}
            label="Value created today"
            detail={`≈ ${formatMinutesLong(estimatedMinutesSaved)} returned to your team`}
            accent
          />
        </div>

        <div className="mission-value-strip compact">
          <div className="mission-value-icon">↗</div>
          <div className="mission-value-main">
            <span>Value created today</span>
            <strong>{estimatedStaffValue.toLocaleString('sv-SE')} <em>SEK</em></strong>
          </div>
          <div className="mission-value-detail">
            <span>≈ {formatMinutesLong(estimatedMinutesSaved)} back</span>
            <small>Calculated using your hourly value</small>
          </div>
        </div>
      </div>

      <div className={attentionCount > 0 ? 'action-center needs-attention' : 'action-center all-clear'}>
        <div className="action-center-status">
          <div className="action-center-icon" aria-hidden="true">
            {attentionCount > 0 ? '!' : '✓'}
          </div>
          <div className="action-center-copy">
            <div className="mission-eyebrow">ACTION CENTER</div>
            <h3>
              {attentionCount > 0
                ? `${attentionCount} ${attentionCount === 1 ? 'conversation needs' : 'conversations need'} your attention`
                : 'Everything is handled'}
            </h3>
            <p>
              {attentionCount > 0
                ? 'OdinLink has flagged conversations that need a human response.'
                : 'OdinLink is actively serving customers. No action is required right now.'}
            </p>
          </div>
        </div>

        <div className="action-center-summary">
          <div className="action-center-summary-item">
            <span>STATUS</span>
            <strong>{attentionCount > 0 ? 'Needs attention' : 'All clear'}</strong>
          </div>
          <div className="action-center-summary-item">
            <span>HUMAN ACTIONS</span>
            <strong>{attentionCount}</strong>
          </div>
        </div>

        <button
          className="mission-action-button"
          type="button"
          onClick={() => document.getElementById('conversations')?.scrollIntoView({ behavior: 'smooth' })}
        >
          {attentionCount > 0 ? 'Review now' : 'Open inbox'} →
        </button>
      </div>
    </section>
  );
}

function HeroResult({
  icon,
  value,
  label,
}: {
  icon: 'customers' | 'bookings' | 'time';
  value: string;
  label: string;
}) {
  return (
    <div className="hero-result-item">
      <div className="hero-result-icon" aria-hidden="true">
        {icon === 'customers' && (
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        )}
        {icon === 'bookings' && (
          <svg viewBox="0 0 24 24" fill="none">
            <rect x="3" y="4" width="18" height="17" rx="2" />
            <path d="M16 2v4M8 2v4M3 10h18" />
            <path d="m9 16 2 2 4-4" />
          </svg>
        )}
        {icon === 'time' && (
          <svg viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
        )}
      </div>
      <div className="hero-result-copy">
        <strong>{value}</strong>
        <span>{label}</span>
      </div>
    </div>
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

function formatMinutesLong(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining ? `${hours} hr ${remaining} min` : `${hours} hr`;
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
