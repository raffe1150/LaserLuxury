import DashboardFeedback, { useDashboardFeedback, type DashboardSaved, type DashboardFeedbackValue, type DashboardFeedbackMemory } from '../components/dashboard/DashboardFeedback';
import { FormEvent, useEffect, useRef, useState, type ReactNode } from 'react';
import BookingsPanel from '../components/dashboard/BookingsPanel';
import ConversationsPanel from '../components/dashboard/ConversationsPanel';
import KnowledgePanel from '../components/dashboard/KnowledgePanel';
import DashboardShell from '../components/dashboard/DashboardShell';
import BusinessDialog from '../components/dashboard/BusinessDialog';
import { dashboardDestinationTitle, initialDashboardNavigation, isDashboardPanelVisible, SETTINGS_AREAS, settingsAreaForNavigation, PRIMARY_DESTINATIONS, type DashboardNavigation, type DashboardPrimary, type NavigateDashboard } from '../components/dashboard/dashboard-navigation';
import NotificationCenter from '../components/dashboard/NotificationCenter';
import {
  BusinessSettings,
  BusinessToneControls,
  SystemPromptEditor,
} from '../components/dashboard/DashboardSections';
import IntegrationCenter from '../components/dashboard/IntegrationCenter';
import HealthStatus from '../components/dashboard/HealthStatus';
import AnalyticsPage from '../components/dashboard/analytics/AnalyticsPage';
import CurrencyValue from '../components/dashboard/CurrencyValue';
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
  const { locale, direction, t } = useDashboardI18n();
  const pageRef = useRef<HTMLDivElement>(null);
  const [selectedBusinessId, setSelectedBusinessId] = useState<string>(() => {
    return localStorage.getItem('odinlink_selected_business') || '';
  });
  const [navigation, setNavigation] = useState<DashboardNavigation>(() => initialDashboardNavigation(window.location.search));
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<(DashboardFeedbackValue & { businessId?: string }) | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [addBusinessOpen, setAddBusinessOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Business | null>(null);
  const [notificationUnreadCount, setNotificationUnreadCount] = useState(0);
  const [notificationRefreshKey, setNotificationRefreshKey] = useState(0);
  const notificationRefreshTimer = useRef<number | null>(null);
  const businessFeedback = useRef<DashboardFeedbackMemory["current"]>(null);
  const instructionsFeedback = useRef<DashboardFeedbackMemory["current"]>(null);
  const knowledgeFeedback = useRef<DashboardFeedbackMemory["current"]>(null);
  const cancellationFeedback = useRef<DashboardFeedbackMemory["current"]>(null);
  const alertsFeedback = useRef<DashboardFeedbackMemory["current"]>(null);
  const connectionsFeedback = useRef<DashboardFeedbackMemory["current"]>(null);

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
    setToast(null);
    setNavigation({ primary: 'home' });
    setDeleteTarget(null);
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

  const handleSaved: DashboardSaved = (message, refresh = false, feedback) => {
    if (!feedback?.local) setToast({ message, kind: feedback?.kind || 'info' });
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
    if (!toast || toast.kind === 'error') return;
    const timeoutId = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(timeoutId);
  }, [toast]);

  const testIntegration = async (integration: string) => {
    if (!selectedBusiness) return;

    const integrationKey = integration as IntegrationKey;
    setToast({ message: 'Testing connection...', kind: 'info', businessId: selectedBusiness.id });

    try {
      const result = await api.refreshIntegrationHealth(
        selectedBusiness.id,
        integrationKey,
        true,
      );

      setData((current) => {
        if (!current || current.selectedBusiness?.id !== selectedBusiness.id) return current;

        return {
          ...current,
          health: current.health.map((item) =>
            item.key === integrationKey ? result.data : item,
          ),
        };
      });

      setToast(result.data.status === 'connected' || result.data.status === 'synced' ? null : { message: result.data.detail, kind: result.data.status === 'error' ? 'error' : 'info', businessId: selectedBusiness.id });
      return result.data;
    } catch (err) {
      const message = getReadableApiError(
        err instanceof Error ? err.message : 'Connection test failed',
      );

      setData((current) => {
        if (!current || current.selectedBusiness?.id !== selectedBusiness.id) return current;

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

      setToast({ message, kind: 'error', businessId: selectedBusiness.id });
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
    setToast({ message: 'Creating business...', kind: 'info' });
    try {
      const created = await api.createBusiness(payload);
      setNavigation({ primary: 'home' });
      setSelectedBusinessId(created.id);
      localStorage.setItem('odinlink_selected_business', created.id);
      setAddBusinessOpen(false);
      setRefreshKey((value) => value + 1);
      setToast({ message: 'Business created', kind: 'success' });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Could not create business', kind: 'error' });
    }
  };

  const deleteBusiness = async (business: Business) => {
    setToast({ message: 'Deleting business...', kind: 'info' });
    try {
      await api.deleteBusiness(business.id);
      if (business.id === selectedBusinessId) {
        setNavigation({ primary: 'home' });
        localStorage.removeItem('odinlink_selected_business');
        setSelectedBusinessId('');
      }
      setDeleteTarget(null);
      setRefreshKey((value) => value + 1);
      setToast({ message: 'Business deleted', kind: 'success' });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Could not delete business', kind: 'error' });
    }
  };

  return (
    <div className="dashboard-page" ref={pageRef} dir={direction} lang={locale} data-dashboard-locale={locale}>
      <DashboardShell
        title={dashboardDestinationTitle(navigation)}
        contentReady={!loading && !error}
        navigation={navigation}
        onWorkspaceNavigate={setNavigation}
        onAddBusiness={() => { setToast(null); setAddBusinessOpen(true); }}
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
          <StateCard home={navigation.primary === 'home'} title="Loading dashboard" copy={navigation.primary === 'home' ? 'Loading your business overview.' : 'Loading your business workspace.'} />
        )}

        {!loading && error && <StateCard home={navigation.primary === 'home'} tone="error" title="Could not load dashboard" copy={error} />}

        {!loading && !error && data && !selectedBusiness && (
          <div>
            <StateCard title="No business selected" copy="Create or select a business to load dashboard data." />
            <button className="btn btn-primary" type="button" onClick={() => { setToast(null); setAddBusinessOpen(true); }}>{t('Create business')}</button>
          </div>
        )}

        {!loading && !error && data && selectedBusiness && (
          <>
            <Workspace primary="home" navigation={navigation}>
              <div hidden={navigation.primary === 'home' && navigation.secondary === 'reports'}>
                <MissionControl
                  business={selectedBusiness}
                  data={data}
                  onWorkspaceNavigate={setNavigation}
                />
              </div>
              <WorkspacePanel primary="home" secondary="reports" navigation={navigation}>
                <div className="reports-workspace">
                  <AnalyticsPage businessId={selectedBusiness.id} title={t('Reports')} backAction={
                    <button className="btn btn-ghost reports-back" type="button" onClick={() => setNavigation({ primary: 'home' })}>
                      {t('Back to {destination}', { destination: t('Home') })}
                    </button>
                  } />
                </div>
              </WorkspacePanel>
            </Workspace>

            <Workspace primary="inbox" navigation={navigation}>

              <section className="mission-section">
                <div className="mission-section-head">
                  <div>
                    <div className="mission-eyebrow">ODINLINK INBOX</div>
                    <h2>Customer conversations</h2>
                    <p>Review recent conversations, their current status and the latest customer activity.</p>
                  </div>
                </div>

                <ConversationsPanel
                  active={navigation.primary === 'inbox'}
                  key={selectedBusiness.id}
                  businessId={selectedBusiness.id}
                />
              </section>
            </Workspace>

            <Workspace primary="bookings" navigation={navigation}>
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

            </Workspace>

            <Workspace primary="ai-assistant" navigation={navigation}>
              <BusinessToneControls
                key={selectedBusiness.id}
                business={selectedBusiness}
                onSaved={handleSaved}
                onBusinessUpdated={handleBusinessUpdated}
                requestedSection={navigation.primary === 'ai-assistant' ? navigation.secondary : undefined}
                businessAnswers={<KnowledgePanel key={`knowledge-${selectedBusiness.id}`} businessId={selectedBusiness.id} onSaved={handleSaved} feedbackMemory={knowledgeFeedback} />}
                customInstructions={<SystemPromptEditor business={selectedBusiness} onSaved={handleSaved} feedbackMemory={instructionsFeedback} />}
              />
            </Workspace>

            <Workspace primary="settings" navigation={navigation}>
              <SettingsNavigation navigation={navigation} onNavigate={setNavigation} />
              <div hidden={settingsAreaForNavigation(navigation) !== 'business'}>
                <BusinessSettings key={`business-${selectedBusiness.id}`} business={selectedBusiness} onSaved={handleSaved} feedbackMemory={businessFeedback} />
                <CancellationSettings key={`cancellation-${selectedBusiness.id}`} business={selectedBusiness} onSaved={handleSaved} feedbackMemory={cancellationFeedback} />
              </div>
              <div hidden={settingsAreaForNavigation(navigation) !== 'connections'}>
                <nav className="settings-secondary-nav" aria-label={t('Connections')}>
                  <button className="btn btn-ghost" type="button" aria-pressed={navigation.primary === 'settings' && navigation.secondary === 'connections'} onClick={() => setNavigation({ primary: 'settings', secondary: 'connections' })}>{t('Connections')}</button>
                  <button className="btn btn-ghost" type="button" aria-pressed={navigation.primary === 'settings' && navigation.secondary === 'connection-health'} onClick={() => setNavigation({ primary: 'settings', secondary: 'connection-health' })}>{t('Connection health')}</button>
                </nav>
                <WorkspacePanel navigation={navigation} primary="settings" secondary="connections">
                  <IntegrationCenter key={selectedBusiness.id} business={selectedBusiness} health={data.health} onSaved={handleSaved} feedbackMemory={connectionsFeedback} onTest={testIntegration} />
                </WorkspacePanel>
                <WorkspacePanel navigation={navigation} primary="settings" secondary="connection-health">
                  <HealthStatus key={selectedBusiness.id} businessId={selectedBusiness.id} onHealthChanged={scheduleNotificationRefresh} onWorkspaceNavigate={setNavigation} />
                </WorkspacePanel>
              </div>
              <div hidden={settingsAreaForNavigation(navigation) !== 'notifications'}>
                <h2 id="settings-notifications-title" tabIndex={-1}>{t('Notifications')}</h2>
                <nav className="settings-secondary-nav" aria-label={t('Notifications')}>
                  <button className="btn btn-ghost" type="button" aria-pressed={navigation.primary === 'settings' && navigation.secondary === 'notification-center'} onClick={() => setNavigation({ primary: 'settings', secondary: 'notification-center' })}>{t('Issues')}</button>
                  <button className="btn btn-ghost" type="button" aria-pressed={navigation.primary === 'settings' && navigation.secondary === 'admin-notifications'} onClick={() => setNavigation({ primary: 'settings', secondary: 'admin-notifications' })}>{t('Business alerts')}</button>
                </nav>
                <WorkspacePanel navigation={navigation} primary="settings" secondary="notification-center">
                  <NotificationCenter key={selectedBusiness.id} businessId={selectedBusiness.id} timezone={selectedBusiness.timezone} onUnreadCountChange={setNotificationUnreadCount} refreshKey={notificationRefreshKey} onWorkspaceNavigate={setNavigation} />
                </WorkspacePanel>
                <WorkspacePanel navigation={navigation} primary="settings" secondary="admin-notifications">
                  <AdminNotificationSettings key={selectedBusiness.id} business={selectedBusiness} onSaved={handleSaved} feedbackMemory={alertsFeedback} />
                </WorkspacePanel>
              </div>
              <WorkspacePanel navigation={navigation} primary="settings" secondary="businesses">
                <BusinessesCard businesses={data.businesses} selectedBusinessId={selectedBusiness.id} onCreate={() => { setToast(null); setAddBusinessOpen(true); }} onDelete={(business) => { setToast(null); setDeleteTarget(business); }} onSelect={handleBusinessChange} />
              </WorkspacePanel>
            </Workspace>
          </>
        )}
      </DashboardShell>

      {addBusinessOpen && (
        <AddBusinessModal feedback={toast?.kind === 'error' ? toast : null} onClose={() => { setAddBusinessOpen(false); setToast(null); }} onCreate={createBusiness} />
      )}

      {deleteTarget && (
        <DeleteBusinessDialog
          business={deleteTarget}
          feedback={toast?.kind === 'error' ? toast : null}
          onCancel={() => { setDeleteTarget(null); setToast(null); }}
          onConfirm={() => deleteBusiness(deleteTarget)}
        />
      )}

      {toast && (!toast.businessId || toast.businessId === selectedBusinessId) && !addBusinessOpen && !deleteTarget && (
        <div className={`toast show dashboard-toast ${toast.kind}`}>
          <div role={toast.kind === 'error' ? 'alert' : 'status'} aria-atomic="true" translate="no"><span aria-hidden="true" className="dashboard-toast-symbol">{toast.kind === 'success' ? '✓' : toast.kind === 'error' ? '!' : 'i'}</span><span>{t(toast.message)}</span></div>
          <button type="button" aria-label={t('Close message')} onClick={() => setToast(null)}>×</button>
        </div>
      )}
    </div>
  );
}

function Workspace({ primary, navigation, children }: { primary: DashboardPrimary; navigation: DashboardNavigation; children: ReactNode }) {
  const { t } = useDashboardI18n();
  return <section id={`workspace-${primary}`} className="dashboard-workspace" tabIndex={-1} aria-label={t(PRIMARY_DESTINATIONS.find((item) => item.id === primary)!.label)} hidden={!isDashboardPanelVisible(navigation, primary)}>{children}</section>;
}

function WorkspacePanel({ primary, secondary, navigation, children }: { primary: DashboardPrimary; secondary: string; navigation: DashboardNavigation; children: ReactNode }) {
  return <div className="dashboard-workspace-panel" hidden={!isDashboardPanelVisible(navigation, primary, secondary)}>{children}</div>;
}

function SettingsNavigation({ navigation, onNavigate }: { navigation: DashboardNavigation; onNavigate: NavigateDashboard }) {
  const { t } = useDashboardI18n();
  const hasSecondary = navigation.primary === 'settings' && Boolean(navigation.secondary);
  return <div className="workspace-navigation">
    <div hidden={hasSecondary}>
      <h2>{t('Settings')}</h2>
      <nav className="settings-index" aria-label={t('Settings setup')}>
        {SETTINGS_AREAS.map((area) => <div className="card settings-index-item" key={area.id}>
          <h3>{t(area.label)}</h3>
          <p>{t(area.description)}</p>
          <button id={`settings-${area.id}-trigger`} className="btn btn-ghost" type="button" onClick={() => onNavigate({ primary: 'settings', secondary: area.secondary })}>{t('Open {destination}', { destination: t(area.label) })}</button>
        </div>)}
      </nav>
    </div>
    <button hidden={!hasSecondary} className="btn btn-ghost" type="button" onClick={() => onNavigate({ primary: 'settings' })}>{t('Back to {destination}', { destination: t('Settings') })}</button>
  </div>;
}

function CancellationSettings({
  business,
  onSaved,
  feedbackMemory,
}: {
  business: Business;
  onSaved: DashboardSaved;
  feedbackMemory?: DashboardFeedbackMemory;
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
  const [loadError, setLoadError] = useState('');
  const { feedback, reportFeedback, clearFeedback } = useDashboardFeedback(onSaved, feedbackMemory, business.id);

  useEffect(() => {
    let active = true;
    setLoadingSettings(true);
    setLoadError('');
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
        if (active) {
          const message = error instanceof Error ? error.message : 'Could not load cancellation settings';
          setLoadError(message);
          onSaved(message, false, { kind: 'error', local: true });
        }
      })
      .finally(() => {
        if (active) setLoadingSettings(false);
      });

    return () => { active = false; };
  }, [business.id]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    clearFeedback();
    let deadlineMinutes = deadlinePreset === 'custom'
      ? Number(customDeadlineValue) * (customDeadlineUnit === 'days' ? 1440 : 60)
      : Number(deadlinePreset);
    const amount = Number(feeAmount || 0);

    if (!Number.isFinite(deadlineMinutes) || deadlineMinutes < 0) {
      reportFeedback('Enter a valid cancellation deadline', false, 'error');
      return;
    }
    deadlineMinutes = Math.round(deadlineMinutes);
    if (deadlinePreset === 'custom' && deadlineMinutes <= 0) {
      reportFeedback('Custom deadline must be greater than zero', false, 'error');
      return;
    }
    if (feeEnabled && (!Number.isFinite(amount) || amount <= 0)) {
      reportFeedback('Enter the late-cancellation fee amount', false, 'error');
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
      reportFeedback('Cancellation policy saved', true);
    } catch (error) {
      reportFeedback(error instanceof Error ? error.message : 'Could not save cancellation policy', false, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section id="cancellation-settings" className="card dashboard-section cancellation-settings-card">
      <div className="card-header cancellation-card-header">
        <div>
          <h2 id="cancellation-title" className="card-title" tabIndex={-1}>Cancellation policy</h2>
          <div className="card-desc">Let customers cancel a selected appointment in chat, with final confirmation and an optional late-cancellation fee.</div>
        </div>
        {!loadingSettings && !loadError && <label className="toggle-wrap">
          <span className="enabled-label">{allowCancellation ? 'Enabled' : 'Disabled'}</span>
          <span className="toggle">
            <input type="checkbox" aria-label="Cancellation policy" disabled={loadingSettings || Boolean(loadError)} checked={allowCancellation} onChange={(event) => setAllowCancellation(event.target.checked)} />
            <span className="toggle-slider" />
          </span>
        </label>}
      </div>

      {loadingSettings ? (
        <div className="admin-notification-loading" role="status">Loading cancellation settings...</div>
      ) : loadError ? (
        <div className="settings-load-error" role="alert"><strong>Could not load cancellation settings</strong><p>{loadError}</p></div>
      ) : (
        <form onSubmit={save} onChangeCapture={() => { if (feedback?.kind === 'success') clearFeedback(); }}>
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

          <DashboardFeedback feedback={feedback} saving={saving} />
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
  feedbackMemory,
}: {
  business: Business;
  onSaved: DashboardSaved;
  feedbackMemory?: DashboardFeedbackMemory;
}) {
  const [channel, setChannel] = useState<'telegram' | 'whatsapp'>('telegram');
  const [whatsappNumber, setWhatsappNumber] = useState('');
  const [telegramChatId, setTelegramChatId] = useState('');
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const { feedback, reportFeedback, clearFeedback } = useDashboardFeedback(onSaved, feedbackMemory, business.id);

  useEffect(() => {
    let active = true;
    setLoadingSettings(true);
    setLoadError('');

    api.getAdminNotificationSettings(business.id)
      .then((result) => {
        if (!active) return;
        const settings = result?.data || {};
        setChannel(settings.channel === 'whatsapp' ? 'whatsapp' : 'telegram');
        setWhatsappNumber(String(settings.whatsappNumber || ''));
        setTelegramChatId(String(settings.telegramChatId || ''));
      })
      .catch((error) => {
        if (active) {
          const message = error instanceof Error ? error.message : 'Could not load notification settings';
          setLoadError(message);
          onSaved(message, false, { kind: 'error', local: true });
        }
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
    clearFeedback();
    const cleanWhatsApp = whatsappNumber.replace(/\D/g, '');

    if (channel === 'whatsapp' && cleanWhatsApp.length < 8) {
      reportFeedback('Enter the admin WhatsApp number with country code, for example 46701234567', false, 'error');
      return;
    }

    if (channel === 'telegram' && !telegramChatId.trim()) {
      reportFeedback('Add the Telegram Admin Chat ID under Connections first', false, 'error');
      return;
    }

    setSaving(true);
    try {
      await api.updateBusinessSettings(business.id, {
          adminNotificationChannel: channel,
          adminWhatsAppNumber: cleanWhatsApp,
      });
      setWhatsappNumber(cleanWhatsApp);
      reportFeedback('Admin notification settings saved', true);
    } catch (error) {
      reportFeedback(error instanceof Error ? error.message : 'Could not save notification settings', false, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section id="admin-notifications" className="card dashboard-section admin-notification-card">
      <div className="card-header">
        <div>
          <h2 id="business-alerts-title" className="card-title" tabIndex={-1}>Business alerts</h2>
          <div className="card-desc">Choose where the business receives new booking and reschedule alerts.</div>
        </div>
      </div>

      {loadingSettings ? (
        <div className="admin-notification-loading" role="status">Loading notification settings...</div>
      ) : loadError ? (
        <div className="settings-load-error" role="alert"><strong>Could not load notification settings</strong><p>{loadError}</p></div>
      ) : (
        <form onSubmit={save} onChangeCapture={() => { if (feedback?.kind === 'success') clearFeedback(); }}>
          <div className="admin-notification-options" role="radiogroup" aria-label="Business alerts">
            <label className={channel === 'telegram' ? 'admin-channel-option selected' : 'admin-channel-option'}>
              <input
                type="radio"
                name="admin-notification-channel"
                value="telegram"
                checked={channel === 'telegram'}
                onChange={() => setChannel('telegram')}
              />
              <span className="admin-channel-icon" aria-hidden="true">✈</span>
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
              <span className="admin-channel-icon" aria-hidden="true">☏</span>
              <span>
                <strong>WhatsApp</strong>
                <small>Send booking alerts to the business owner's WhatsApp.</small>
              </span>
            </label>
          </div>

          {channel === 'telegram' ? (
            <div className="admin-notification-summary">
              <span>Telegram Admin Chat ID</span>
              <strong>{telegramChatId ? <bdi dir="ltr" translate="no">{telegramChatId}</bdi> : 'Not configured'}</strong>
              <small>Change this value under Connections → Telegram.</small>
            </div>
          ) : (
            <div className="form-group admin-whatsapp-field">
              <label className="form-label" htmlFor="admin-whatsapp-number">Admin WhatsApp number</label>
              <input
                id="admin-whatsapp-number"
                className="form-input mono"
                inputMode="tel"
                dir="ltr"
                aria-describedby="alert-number-help"
                value={whatsappNumber}
                onChange={(event) => setWhatsappNumber(event.target.value)}
                placeholder="46701234567"
              />
              <div id="alert-number-help" className="form-hint">Use country code without +, spaces or dashes.</div>
            </div>
          )}

          <DashboardFeedback feedback={feedback} saving={saving} />
          <div className="save-row">
            <button className="btn btn-primary" type="submit" disabled={saving}>
              {saving ? 'Saving...' : 'Save alert destination'}
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
  onWorkspaceNavigate,
}: {
  business: Business;
  data: DashboardData;
  onWorkspaceNavigate: NavigateDashboard;
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
              <span className="mission-monitoring-copy" translate="no">{summary ? <bdi dir="ltr">{metricScope}</bdi> : t(metricScope)}</span>
            </div>
          </div>

          <p className="mission-greeting">{greeting} <span aria-hidden="true">👋</span></p>
          <h1 dir="auto" translate="no">{displayBusinessName}</h1>

          <div className="hero-results-block">
            <div className="hero-results-label">TODAY’S RESULTS</div>
            <div className="hero-result-grid dashboard-primary-kpis">
              <HeroResult
                icon="customers"
                value={conversationValue}
                label={metricLabel('Conversations today', conversationsMetric, t)}
                detail={countMetricDetail(conversationsMetric, 'Conversations with customer activity today', t)}
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
          <div className="home-operational-footer">
            <div className="home-operational-status" translate="no">
              <button
                className={`mission-status-indicator ${statusClass}`}
                type="button"
                title={t(operationalStatus.detail)}
                aria-label={`${t(operationalStatus.title)}. ${t(operationalStatus.detail)}`}
                onClick={() => onWorkspaceNavigate({ primary: 'settings', secondary: actionTarget === 'notification-center' ? 'notification-center' : 'connection-health' })}
              >
                <i aria-hidden="true" />
                <span>{t(operationalStatus.title)}</span>
                <b aria-hidden="true">→</b>
              </button>
              <p>{t(operationalStatus.detail)}</p>
            </div>
            <nav className="home-workspace-actions" aria-label={t('Home actions')}>
              <button className="btn btn-ghost" type="button" onClick={() => onWorkspaceNavigate({ primary: 'inbox' })}>{t('Open Inbox')}</button>
              <button className="btn btn-ghost" type="button" onClick={() => onWorkspaceNavigate({ primary: 'bookings' })}>{t('Open Bookings')}</button>
              <button id="home-reports-trigger" className="btn btn-ghost" type="button" onClick={() => onWorkspaceNavigate({ primary: 'home', secondary: 'reports' })}>{t('View reports')}</button>
            </nav>
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
        <span translate="no">{label}</span>
        <strong translate="no" dir="ltr">{accent ? <CurrencyValue formattedValue={value} /> : value}</strong>
        <small translate="no">{detail}</small>
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
  feedback,
}: {
  onClose: () => void;
  feedback: DashboardFeedbackValue | null;
  onCreate: (payload: Partial<Business>) => Promise<void>;
}) {
  const { t } = useDashboardI18n();
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
    <BusinessDialog titleId="add-business-title" descriptionId="add-business-description" busy={saving} onClose={onClose}>
      <form onSubmit={submit}>
        <h2 id="add-business-title" className="ai-modal-title">{t('Add Business')}</h2>
        <div id="add-business-description" className="ai-modal-desc">{t('Create a new tenant. Its settings, channels and stats will be scoped separately.')}</div>
        <div className="form-grid-2">
          <div className="form-group form-full">
            <label className="form-label" htmlFor="add-business-name">{t('Business Name')}</label>
            <input id="add-business-name" data-dialog-initial-focus className="form-input" dir="auto" value={name} onChange={(event) => setName(event.target.value)} required />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="add-business-industry">{t('Business Type')}</label>
            <input id="add-business-industry" className="form-input" dir="auto" value={industry} onChange={(event) => setIndustry(event.target.value)} placeholder={t('Service business')} />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="add-business-timezone">{t('Timezone')}</label>
            <input id="add-business-timezone" className="form-input mono" dir="ltr" value={timezone} onChange={(event) => setTimezone(event.target.value)} />
          </div>
          <div className="form-group form-full">
            <label className="form-label" htmlFor="add-business-language">{t('Language')}</label>
            <select id="add-business-language" className="form-input" value={language} onChange={(event) => setLanguage(event.target.value as Business['language'])}>
              <option value="en">English</option>
              <option value="sv">Svenska</option>
              <option value="de">Deutsch</option>
              <option value="es">Español</option>
              <option value="fa">فارسی</option>
              <option value="ar">العربية</option>
            </select>
          </div>
        </div>
        <DashboardFeedback feedback={feedback} />
        <div className="save-row">
          <button className="btn btn-ghost" type="button" onClick={onClose} disabled={saving}>{t('Cancel')}</button>
          <button className="btn btn-primary" type="submit" disabled={saving || !name.trim()}>
            {t(saving ? 'Creating...' : 'Create Business')}
          </button>
        </div>
      </form>
    </BusinessDialog>
  );
}

function DeleteBusinessDialog({
  business,
  onCancel,
  onConfirm,
  feedback,
}: {
  business: Business;
  feedback: DashboardFeedbackValue | null;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { t } = useDashboardI18n();
  const [deleting, setDeleting] = useState(false);
  const confirm = async () => {
    if (deleting) return;
    setDeleting(true);
    try { await onConfirm(); } finally { setDeleting(false); }
  };
  return (
    <BusinessDialog titleId="delete-business-title" descriptionId="delete-business-description" busy={deleting} onClose={onCancel}>
      <div>
        <h2 id="delete-business-title" className="ai-modal-title">{t('Delete Business')}</h2>
        <div id="delete-business-description" className="ai-modal-desc">
          {t('This will delete')} <strong translate="no" dir="auto">{business.name}</strong> {t('and its tenant-scoped settings from the backend.')}
        </div>
        <DashboardFeedback feedback={feedback} />
        <div className="save-row">
          <button className="btn btn-ghost" data-dialog-initial-focus type="button" onClick={onCancel} disabled={deleting}>{t('Cancel')}</button>
          <button className="btn btn-danger" type="button" onClick={() => void confirm()} disabled={deleting}>{t('Delete Business')}</button>
        </div>
      </div>
    </BusinessDialog>
  );
}

function StateCard({ title, copy, tone, home = false }: { title: string; copy: string; tone?: 'error'; home?: boolean }) {
  return (
    <div className={`card dashboard-section state-card ${tone || ''} ${home ? 'home-dashboard-state' : ''}`} role={tone === 'error' ? 'alert' : title === 'Loading dashboard' ? 'status' : undefined}>
      {home ? <h1 className="card-title">{title}</h1> : <div className="card-title">{title}</div>}
      <div className="card-desc">{copy}</div>
    </div>
  );
}
