import { FormEvent, useEffect, useMemo, useState } from 'react';
import { api } from '../../services/api';
import type {
  Booking,
  Business,
  Conversation,
  IntegrationHealth,
  IntegrationKey,
  UsageInfo,
} from '../../types/dashboard';
import { ChannelIcon, StatusDot } from './Icons';
import GeneratePromptModal, {
  type GeneratePromptFormData,
} from './GeneratePromptModal';

interface BusinessSettingsProps {
  business: Business;
  onSaved: (message: string, refresh?: boolean) => void;
}

export function BusinessSettings({ business, onSaved }: BusinessSettingsProps) {
  const [name, setName] = useState(business.name || '');
  const [industry, setIndustry] = useState(business.industry || '');
  const [timezone, setTimezone] = useState(business.timezone || '');
  const [language, setLanguage] = useState(business.language || 'en');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(business.name || '');
    setIndustry(business.industry || '');
    setTimezone(business.timezone || '');
    setLanguage(business.language || 'en');
  }, [business.id, business.name, business.industry, business.timezone, business.language]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await api.updateBusiness(business.id, { name, industry, timezone, language });
      onSaved('Business settings saved', true);
    } catch (error) {
      onSaved(error instanceof Error ? error.message : 'Could not save business settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section id="business-settings" className="card dashboard-section">
      <div className="card-header">
        <div>
          <div className="card-title">Business Settings</div>
          <div className="card-desc">Settings are scoped to the selected business tenant.</div>
        </div>
      </div>
      <form onSubmit={save}>
        <div className="form-grid">
          <div className="form-group">
            <label className="form-label">Business Name</label>
            <input className="form-input" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Business Type</label>
            <input className="form-input" value={industry} onChange={(event) => setIndustry(event.target.value)} placeholder="Service business" />
          </div>
          <div className="form-group">
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
          <div className="form-group">
            <label className="form-label">Timezone</label>
            <input className="form-input mono" value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="Europe/Stockholm" />
          </div>
        </div>
        <div className="save-row">
          <button className="btn btn-primary" type="submit" disabled={saving}>
            {saving ? 'Saving...' : 'Save Business'}
          </button>
        </div>
      </form>
    </section>
  );
}

export function SystemPromptEditor({ business, onSaved }: BusinessSettingsProps) {
  const [prompt, setPrompt] = useState(business.systemPrompt || '');
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setPrompt(business.systemPrompt || '');
  }, [business.id, business.systemPrompt]);

  const save = async () => {
    setSaving(true);
    try {
      await api.updateBusiness(business.id, { systemPrompt: prompt });
      onSaved('Prompt saved', true);
    } catch (error) {
      onSaved(error instanceof Error ? error.message : 'Could not save prompt');
    } finally {
      setSaving(false);
    }
  };

  const handleGeneratePrompt = (data: GeneratePromptFormData) => {
    console.log('Generate prompt data:', data);
    setModalOpen(false);
  };

  return (
    <section id="prompt-editor" className="card dashboard-section">
      <div className="card-header">
        <div>
          <div className="card-title">System Prompt Editor</div>
          <div className="card-desc">Controls how the AI assistant responds for this business.</div>
        </div>
      </div>
      <div className="form-group form-full">
        <label className="form-label">Custom AI System Prompt</label>
        <div className="prompt-toolbar">
          <button className="ai-gen-btn" type="button" onClick={() => setModalOpen(true)}>
            Generate with AI
          </button>
          <span className="prompt-char-count">{prompt.length} / 10000</span>
        </div>

        <textarea
          className="form-input"
          maxLength={10000}
          rows={6}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Describe this business, booking rules, tone and escalation policy."
        />

        <div className="form-hint">
          This prompt is saved for the selected business only.
        </div>
      </div>
      <div className="save-row">
        <button className="btn btn-primary" type="button" onClick={save} disabled={saving}>
          {saving ? 'Saving...' : 'Save Prompt'}
        </button>
      </div>
      <GeneratePromptModal
        open={modalOpen}
        initialBusinessName={business.name}
        onClose={() => setModalOpen(false)}
        onGenerate={handleGeneratePrompt}
      />
    </section>
  );
}


export function ChannelSettings({
  business,
  health,
  onTest,
  onSaved,
}: {
  business: Business;
  health: IntegrationHealth[];
  onTest: (integration: string) => void;
  onSaved: (message: string, refresh?: boolean) => void;
}) {
  const [values, setValues] = useState(() => getChannelValues(business));
  const [saving, setSaving] = useState(false);
  const byKey = new Map(health.map((item) => [item.key, item]));
  const channels: Array<{ key: IntegrationKey; title: string; copy: string; fields: Array<{ key: keyof Business; label: string; secret?: boolean }> }> = [
    { key: 'google_calendar', title: 'Google Calendar', copy: 'Sync availability and create bookings directly in the business calendar.', fields: [{ key: 'calendarId', label: 'Calendar ID' }, { key: 'timezone', label: 'Timezone' }] },
    { key: 'instagram', title: 'Instagram', copy: 'Connect Instagram DMs and comment replies through Meta Graph API.', fields: [{ key: 'instagramPageId', label: 'Instagram Page ID' }, { key: 'instagramAccountId', label: 'Instagram Account ID' }, { key: 'instagramAccessToken', label: 'Access Token', secret: true }, { key: 'instagramWebhookVerifyToken', label: 'Webhook Verify Token', secret: true }] },
    { key: 'messenger', title: 'Facebook Messenger', copy: 'Connect Messenger inbox, page comments and post reply automation.', fields: [{ key: 'messengerPageId', label: 'Facebook Page ID' }, { key: 'messengerAccessToken', label: 'Page Access Token', secret: true }, { key: 'messengerAppSecret', label: 'App Secret', secret: true }, { key: 'messengerWebhookVerifyToken', label: 'Webhook Verify Token', secret: true }] },
    { key: 'telegram', title: 'Telegram', copy: 'Connect Telegram bot for DMs, voice messages and booking notifications.', fields: [{ key: 'telegramToken', label: 'Bot Token', secret: true }, { key: 'telegramAdminChatId', label: 'Admin Chat ID' }] },
    { key: 'whatsapp', title: 'WhatsApp Business', copy: 'Connect WhatsApp via Meta Cloud API for customer messages.', fields: [{ key: 'whatsappPhoneNumberId', label: 'Phone Number ID' }, { key: 'whatsappBusinessAccountId', label: 'WABA ID' }, { key: 'whatsappAccessToken', label: 'Access Token', secret: true }, { key: 'whatsappWebhookVerifyToken', label: 'Webhook Verify Token', secret: true }] },
  ];

  useEffect(() => {
    setValues(getChannelValues(business));
  }, [business]);

  const updateValue = (key: keyof Business, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.updateBusiness(business.id, values);
      onSaved('Channel settings saved', true);
    } catch (error) {
      onSaved(error instanceof Error ? error.message : 'Could not save channel settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section id="channel-settings" className="card dashboard-section">
      <div className="card-header">
        <div>
          <div className="card-title">Channel Settings</div>
          <div className="card-desc">Credentials are masked and updates should be sent to the backend for {business.name}.</div>
        </div>
      </div>
      {channels.map((channel) => {
        const status = byKey.get(channel.key);
        const connected = status?.status === 'connected' || status?.status === 'synced';
        return (
          <div className="integration-shell" key={channel.key}>
            <div className="channel-header">
              <div className="channel-icon"><ChannelIcon channel={channel.key} /></div>
              <div className="channel-info">
                <h3>{channel.title}</h3>
                <p>{channel.copy}</p>
              </div>
              <div className="card-header-right" style={{ marginLeft: 'auto' }}>
                <span className={connected ? 'status-chip connected' : 'status-chip disconnected'}>
                  <StatusDot status={status?.status || 'setup_required'} />
                  {status?.detail || 'Setup required'}
                </span>
                <button className="btn btn-ghost" type="button" onClick={() => onTest(channel.key)}>Test</button>
              </div>
            </div>
            <div className="api-guide">
              <div>
                <div className="api-guide-title">Setup notes</div>
                <div className="api-steps">
                  <div className="api-step"><span>Use credentials generated for the selected business only.</span></div>
                  <div className="api-step"><span>Store and rotate secrets through backend endpoints.</span></div>
                  <div className="api-step"><span>Run a test connection before enabling automation.</span></div>
                </div>
              </div>
              <div className="api-guide-list">
                <div className="api-guide-item"><b>Tenant</b><span>{business.name}</span></div>
                <div className="api-guide-item"><b>Security</b><span>Tokens stay masked in the browser.</span></div>
              </div>
            </div>
            <div className="form-grid-2">
              {channel.fields.map((field) => (
                <div className="form-group" key={field.key}>
                  <label className="form-label">{field.label}</label>
                  <input
                    className="form-input mono"
                    type={field.secret ? 'password' : 'text'}
                    value={(values[field.key] as string | undefined) || ''}
                    placeholder={field.secret ? '••••••••••••••••' : ''}
                    onChange={(event) => updateValue(field.key, event.target.value)}
                  />
                  <div className="form-hint secret-note">
                    {field.secret ? 'Leave blank to keep the existing credential.' : 'Update is sent server-side for the selected business.'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      <div className="save-row">
        <button className="btn btn-primary" type="button" onClick={save} disabled={saving}>
          {saving ? 'Saving...' : 'Save Channel Settings'}
        </button>
      </div>
    </section>
  );
}

function getChannelValues(business: Business): Partial<Business> {
  return {
    calendarId: business.calendarId || '',
    timezone: business.timezone || '',
    telegramToken: '',
    telegramAdminChatId: business.telegramAdminChatId || '',
    instagramPageId: business.instagramPageId || '',
    instagramAccountId: business.instagramAccountId || '',
    instagramAccessToken: '',
    instagramWebhookVerifyToken: '',
    messengerPageId: business.messengerPageId || '',
    messengerAccessToken: '',
    messengerAppSecret: '',
    messengerWebhookVerifyToken: '',
    whatsappPhoneNumberId: business.whatsappPhoneNumberId || '',
    whatsappBusinessAccountId: business.whatsappBusinessAccountId || '',
    whatsappAccessToken: '',
    whatsappWebhookVerifyToken: '',
  };
}

export function UsageStatistics({ usage }: { usage: UsageInfo }) {
  const used = usage.limit > 0 ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;
  return (
    <section id="usage-statistics" className="insight-card dashboard-section">
      <div className="chart-header">
        <div>
          <div className="chart-title">Usage Statistics</div>
          <div className="chart-sub">{usage.plan}</div>
        </div>
      </div>
      <div className="usage-meta"><span>{usage.used} used</span><span>{usage.limit} limit</span></div>
      <div className="usage-bar"><div className="usage-fill" style={{ width: `${used}%` }} /></div>
      <div className="usage-meta"><span>{used}%</span><span>{Math.max(0, usage.limit - usage.used)} remaining</span></div>
    </section>
  );
}

export function Activity({
  conversations,
  bookings,
  health,
}: {
  conversations: Conversation[];
  bookings: Booking[];
  health: IntegrationHealth[];
}) {
  const items = useMemo(() => {
    const activityItems: Array<{
      id: string;
      title: string;
      meta: string;
      time: string;
      channel: IntegrationKey;
    }> = [
      ...bookings.map((booking) => ({
        id: `booking-${booking.id}`,
        title: `Booking ${booking.status}`,
        meta: `${booking.customerName} · ${booking.serviceName || 'Service'}`,
        time: booking.startsAt,
        channel: booking.channel,
      })),
      ...conversations.map((conversation) => ({
        id: `conversation-${conversation.id}`,
        title: `Conversation ${conversation.status}`,
        meta: `${conversation.customerName} · ${conversation.preview}`,
        time: conversation.updatedAt,
        channel: conversation.channel,
      })),
      ...health.map((item) => ({
        id: `health-${item.key}`,
        title: `${item.label} ${item.status.replace('_', ' ')}`,
        meta: item.detail,
        time: '',
        channel: item.key,
      })),
    ];
    return activityItems.slice(0, 12);
  }, [bookings, conversations, health]);

  return (
    <section id="activity" className="card dashboard-section">
      <div className="card-header">
        <div>
          <div className="card-title">Activity</div>
          <div className="card-desc">Latest dynamic events for the selected business.</div>
        </div>
      </div>
      <div className="activity-feed">
        {items.length === 0 ? <div className="empty-state">No activity returned from backend yet.</div> : items.map((item) => (
          <div className="activity-item" key={item.id}>
            <div className="activity-icon"><ChannelIcon channel={item.channel} /></div>
            <div className="activity-text">
              <div className="activity-title">{item.title}</div>
              <div className="activity-meta">{item.meta}</div>
            </div>
            <div className="activity-time">{item.time ? formatDate(item.time) : ''}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function NotificationCenter({
  health,
  bookings,
}: {
  health: IntegrationHealth[];
  bookings: Booking[];
}) {
  const alerts = [
    ...health.filter((item) => item.status === 'error' || item.status === 'disconnected').map((item) => `${item.label}: ${item.detail}`),
    ...bookings.filter((booking) => booking.status === 'pending').map((booking) => `Pending booking: ${booking.customerName}`),
  ];
  return (
    <section id="notification-center" className="card dashboard-section">
      <div className="card-header">
        <div>
          <div className="card-title">Notification Center</div>
          <div className="card-desc">Backend-driven alerts for the selected business.</div>
        </div>
      </div>
      {alerts.length === 0 ? <div className="empty-state">No notifications.</div> : alerts.map((alert) => (
        <div className="notification-item" key={alert}>
          <div className="notification-icon"><span className="status-dot pending" /></div>
          <div className="notification-copy">{alert}</div>
        </div>
      ))}
    </section>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
