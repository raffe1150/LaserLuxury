import { FormEvent, useEffect, useRef, useState } from 'react';
import BookingsPanel from '../components/dashboard/BookingsPanel';
import ConversationsPanel from '../components/dashboard/ConversationsPanel';
import DashboardShell from '../components/dashboard/DashboardShell';
import NotificationCenter from '../components/dashboard/NotificationCenter';
import {
  BusinessSettings,
  BusinessToneControls,
  SystemPromptEditor,
  UsageStatistics,
} from '../components/dashboard/DashboardSections';
import IntegrationCenter from '../components/dashboard/IntegrationCenter';
import HealthStatus from '../components/dashboard/HealthStatus';
import AnalyticsPage from '../components/dashboard/analytics/AnalyticsPage';
import { api, loadDashboardData } from '../services/api';
import { useAuth } from '../auth/AuthProvider';
import dashboardCss from '../styles/dashboard.css?raw';
import type { Business, DashboardData, IntegrationKey } from '../types/dashboard';
import type {
  DashboardCountMetric,
  DashboardEstimatedValueMetric,
} from '../dashboard/contracts';
import {
  DashboardI18nProvider,
  localizeDashboardDom,
  useDashboardI18n,
} from '../i18n/dashboard';

interface DashboardProps {
  onNavigate: (path: '/' | '/login' | '/dashboard') => void;
}

export default function Dashboard(props: DashboardProps) {
  return <DashboardI18nProvider><DashboardContent {...props} /></DashboardI18nProvider>;
}

function DashboardContent({ onNavigate }: DashboardProps) {
  const { signOut } = useAuth();
  const { locale, direction } = useDashboardI18n();
  const pageRef = useRef<HTMLDivElement>(null);
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
  const [notificationUnreadCount, setNotificationUnreadCount] = useState(0);
  const [notificationRefreshKey, setNotificationRefreshKey] = useState(0);
  const notificationRefreshTimer = useRef<number | null>(null);

  useEffect(() => {
    const style = document.createElement('style');
    style.dataset.pageStyle = 'dashboard';
    style.textContent = dashboardCss;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    return localizeDashboardDom(page, locale);
  }, [locale]);

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
    setNotificationUnreadCount(0);
    setSelectedBusinessId(businessId);
    localStorage.setItem('odinlink_selected_business', businessId);
  };

  const scheduleNotificationRefresh = () => {
    if (notificationRefreshTimer.current !== null) window.clearTimeout(notificationRefreshTimer.current);
    notificationRefreshTimer.current = window.setTimeout(() => {
      setNotificationRefreshKey((value) => value + 1);
      setRefreshKey((value) => value + 1);
      notificationRefreshTimer.current = null;
    }, 500);
  };

  useEffect(() => () => {
    if (notificationRefreshTimer.current !== null) window.clearTimeout(notificationRefreshTimer.current);
  }, []);

  const handleSaved = (message: string, refresh = false) => {
    setToast(message);
    if (refresh) setRefreshKey((value) => value + 1);
  };

  const handleBusinessUpdated = (updatedBusiness: Business) => {
    setData((current) => {
      if (!current || current.selectedBusiness?.id !== updatedBusiness.id) return current;
      return {
        ...current,
        selectedBusiness: updatedBusiness,
        businesses: current.businesses.map((business) =>
          business.id === updatedBusiness.id ? updatedBusiness : business
        ),
      };
    });
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
      const result = await api.refreshIntegrationHealth(
        selectedBusiness.id,
        integrationKey,
        true,
      );

      setData((current) => {
        if (!current) return current;

        return {
          ...current,
          health: current.health.map((item) =>
            item.key === integrationKey ? result.data : item,
          ),
        };
      });

      setToast(result.data.status === 'connected' || result.data.status === 'synced' ? null : result.data.detail);
      return result.data;
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
      return {
        key: integrationKey,
        label: integrationKey,
        status: 'error' as const,
        detail: 'Connection failed',
        lastCheckedAt: null,
        stale: true,
        refreshInProgress: false,
        reasonCode: 'check_failed' as const,
        action: 'retry' as const,
      };
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
    <div className="dashboard-page" ref={pageRef} dir={direction} lang={locale} data-dashboard-locale={locale}>
      <DashboardShell
        title="Dashboard"
        businesses={data?.businesses || []}
        selectedBusinessId={selectedBusiness?.id || selectedBusinessId}
        businessName={selectedBusiness?.name}
        onBusinessChange={handleBusinessChange}
        notificationUnreadCount={notificationUnreadCount}
        onNavigate={onNavigate}
        onSignOut={async () => {
          await signOut();
          onNavigate('/login');
        }}
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

            <AnalyticsPage businessId={selectedBusiness.id} />

            <section className="mission-section">
              <div className="mission-section-head">
                <div>
                  <div className="mission-eyebrow">ODINLINK INBOX</div>
                  <h2>Customer conversations</h2>
                  <p>Review recent conversations, their current status and the latest customer activity.</p>
                </div>
              </div>

              <ConversationsPanel
                key={selectedBusiness.id}
                businessId={selectedBusiness.id}
              />
            </section>

            <section className="mission-section">
              <div className="mission-section-head">
                <div>
                  <div className="mission-eyebrow">BOOKING WORKSPACE</div>
                  <h2>Bookings</h2>
                  <p>Review upcoming, pending and historical appointments for the business.</p>
                </div>
              </div>
              <BookingsPanel
                key={selectedBusiness.id}
                businessId={selectedBusiness.id}
                timezone={selectedBusiness.timezone}
              />
            </section>

            <section className="mission-section mission-admin-section">
              <div className="mission-section-head">
                <div>
                  <div className="mission-eyebrow">CONTROL CENTER</div>
                  <h2>Business setup and operations</h2>
                  <p>Manage channels, automation, usage and business settings.</p>
                </div>
              </div>

              <HealthStatus key={selectedBusiness.id} businessId={selectedBusiness.id} onHealthChanged={scheduleNotificationRefresh} />
              <NotificationCenter
                key={selectedBusiness.id}
                businessId={selectedBusiness.id}
                timezone={selectedBusiness.timezone}
                onUnreadCountChange={setNotificationUnreadCount}
                refreshKey={notificationRefreshKey}
              />
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
              <BusinessToneControls
                key={selectedBusiness.id}
                business={selectedBusiness}
                onSaved={handleSaved}
                onBusinessUpdated={handleBusinessUpdated}
              />
              <SystemPromptEditor business={selectedBusiness} onSaved={handleSaved} />
              <IntegrationCenter
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
    api.getCancellationSettings(business.id)
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
      await api.updateBusinessSettings(business.id, {
          allowCancellation,
          cancellationDeadlineMinutes: deadlineMinutes,
          cancellationFeeEnabled: feeEnabled,
          cancellationFeeAmount: feeEnabled ? amount : 0,
          cancellationFeeCurrency: currency.trim().toUpperCase() || 'SEK',
      });
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

    api.getAdminNotificationSettings(business.id)
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
      await api.updateBusinessSettings(business.id, {
          adminNotificationChannel: channel,
          adminWhatsAppNumber: cleanWhatsApp,
      });
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
  const { locale, t } = useDashboardI18n();
  const summary = data.dashboardSummary.status === 'available'
    ? data.dashboardSummary.data
    : null;
  const conversationsMetric = summary?.conversationsToday;
  // The single primary booking KPI consumes the canonical backend field directly.
  const canonicalBookingMetric = summary?.completedBookingsToday;
  const conversationValue = formatCountMetric(conversationsMetric, locale);
  const bookingValue = formatCountMetric(canonicalBookingMetric, locale);
  const estimatedValue = formatEstimatedBookingValue(summary?.estimatedBookingValue, locale, t);
  const estimatedValueMetric = summary?.estimatedBookingValue;
  const operationalStatus = summary?.operationalStatus || {
    state: 'unavailable' as const,
    title: 'Status unavailable',
    detail: 'The current dashboard summary could not be loaded.',
    activeNotificationCount: null,
    healthIssueCount: null,
  };
  const greeting = t(getGreeting());
  const displayBusinessName = formatBusinessName(business.name);
  const metricScope = summary
    ? `${summary.scope.startDate} · ${summary.scope.timezone}`
    : 'Current data unavailable';
  const statusClass = operationalStatus.state === 'attention'
    ? 'attention'
    : operationalStatus.state === 'operational'
      ? 'clear'
      : 'unavailable';
  const actionTarget = operationalStatus.activeNotificationCount && operationalStatus.activeNotificationCount > 0
    ? 'notification-center'
    : 'health';

  return (
    <section id="overview" className="mission-control">
      <div className="mission-hero">
        <div className="mission-hero-content">
          <div className="mission-hero-topline">
            <div className="mission-live-status">
              <div className="mission-live-badge">
                <span />
                Today’s overview
              </div>
              <span className="mission-monitoring-copy">{metricScope}</span>
            </div>
            <button
              className={`mission-status-indicator ${statusClass}`}
              type="button"
              title={t(operationalStatus.detail)}
              aria-label={`${t(operationalStatus.title)}. ${t(operationalStatus.detail)}`}
              onClick={() => document.getElementById(actionTarget)?.scrollIntoView({ behavior: 'smooth' })}
            >
              <i aria-hidden="true" />
              <span>{t(operationalStatus.title)}</span>
              <b aria-hidden="true">→</b>
            </button>
          </div>

          <p className="mission-greeting">{greeting} <span aria-hidden="true">👋</span></p>
          <h1>{displayBusinessName}</h1>

          <div className="hero-results-block">
            <div className="hero-results-label">TODAY’S RESULTS</div>
            <div className="hero-result-grid dashboard-primary-kpis">
              <HeroResult
                icon="customers"
                value={conversationValue}
                label={metricLabel('Conversations today', conversationsMetric, t)}
                detail={countMetricDetail(conversationsMetric, 'Canonical conversation starts', t)}
              />
              <HeroResult
                icon="bookings"
                value={bookingValue}
                label={metricLabel('Completed bookings today', canonicalBookingMetric, t)}
                detail={countMetricDetail(canonicalBookingMetric, 'Booked or completed appointment records', t)}
              />
              <HeroResult
                icon="value"
                value={estimatedValue.value}
                label={estimatedMetricLabel(estimatedValueMetric, t)}
                detail={estimatedValue.detail}
                accent
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function HeroResult({
  icon,
  value,
  label,
  detail,
  accent = false,
}: {
  icon: 'customers' | 'bookings' | 'value';
  value: string;
  label: string;
  detail: string;
  accent?: boolean;
}) {
  return (
    <div className={accent ? 'hero-result-item accent' : 'hero-result-item'}>
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
        {icon === 'value' && (
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M4 19V9M10 19V5M16 19v-7M22 19H2" />
            <path d="m4 7 6-4 6 5 5-4" />
          </svg>
        )}
      </div>
      <div className="hero-result-copy">
        <strong>{value}</strong>
        <span>{label}</span>
        <small>{detail}</small>
      </div>
    </div>
  );
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

function formatCountMetric(metric: DashboardCountMetric | undefined, locale = 'en'): string {
  return metric && metric.value !== null ? new Intl.NumberFormat(locale).format(metric.value) : '—';
}

type TranslateDashboard = (source: string, values?: Readonly<Record<string, string | number>>) => string;

function metricLabel(label: string, metric: DashboardCountMetric | undefined, t: TranslateDashboard): string {
  if (!metric || metric.quality === 'unavailable') return t('{label} · unavailable', { label: t(label) });
  return metric.quality === 'partial' ? t('{label} · partial', { label: t(label) }) : t(label);
}

function estimatedMetricLabel(metric: DashboardEstimatedValueMetric | undefined, t: TranslateDashboard): string {
  if (!metric || metric.quality === 'unavailable') return t('{label} · unavailable', { label: t('Estimated booking value today') });
  return metric.quality === 'partial'
    ? t('{label} · partial', { label: t('Estimated booking value today') })
    : t('Estimated booking value today');
}

function countMetricDetail(metric: DashboardCountMetric | undefined, definition: string, t: TranslateDashboard): string {
  if (!metric || metric.quality === 'unavailable') return t('Data unavailable — not reported as zero');
  if (metric.quality === 'partial') return t('Partial coverage · {definition}', { definition: t(definition) });
  return metric.value === 0 ? t('Zero · {definition}', { definition: t(definition) }) : t(definition);
}

function formatEstimatedBookingValue(metric: DashboardEstimatedValueMetric | undefined, locale = 'en', t: TranslateDashboard = (source) => source): {
  value: string;
  detail: string;
} {
  if (!metric || metric.quality === 'unavailable') {
    return {
      value: '—',
      detail: metric && metric.completedBookingCount > 0
        ? t('Unavailable · 0 of {total} bookings have a configured price', { total: metric.completedBookingCount })
        : t('Data unavailable — not reported as zero'),
    };
  }
  if (metric.completedBookingCount === 0) {
    return { value: '0', detail: t('Zero completed bookings in the canonical today window') };
  }
  const value = metric.amounts
    .map(({ amount, currency }) => `${new Intl.NumberFormat(locale).format(amount)} ${currency}`)
    .join(' + ') || '0';
  if (metric.quality === 'partial') {
    return {
      value,
      detail: t('Partial coverage · {known} of {total} bookings priced', { known: metric.knownPriceCount, total: metric.completedBookingCount }),
    };
  }
  return {
    value,
    detail: t('{known} of {total} bookings matched configured prices', { known: metric.knownPriceCount, total: metric.completedBookingCount }),
  };
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
  const { t } = useDashboardI18n();
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
                {business.industry || business.timezone || business.language ? <>
                  {business.industry && <span translate="no">{business.industry}</span>}
                  {business.industry && (business.timezone || business.language) && ' · '}
                  {business.timezone && <bdi dir="ltr">{business.timezone}</bdi>}
                  {business.timezone && business.language && ' · '}
                  {business.language && <bdi dir="ltr">{business.language}</bdi>}
                </> : t('Business tenant')}
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
