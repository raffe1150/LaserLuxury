import { useEffect, useMemo, useState } from 'react';
import { api } from '../../services/api';
import type { Business, IntegrationHealth, IntegrationKey } from '../../types/dashboard';
import {
  INTEGRATION_PROVIDERS,
  getInitialIntegrationValues,
  getGuidedIntegrationFields,
  getIntegrationDisplayState,
  getProviderPayload,
  hasUnsavedProviderChanges,
  missingRequiredFields,
  type IntegrationFieldDefinition,
  type IntegrationProviderDefinition,
  type IntegrationStepVisual,
  type IntegrationValues,
} from '../../integrations/integration-center';
import { useDashboardI18n } from '../../i18n/dashboard';
import { ChannelIcon, StatusDot } from './Icons';

export interface IntegrationCenterProps {
  business: Business;
  health: IntegrationHealth[];
  onTest: (integration: IntegrationKey) => Promise<IntegrationHealth | void>;
  onSaved: (message: string, refresh?: boolean) => void;
}

type DetailMode = 'manage' | 'wizard' | 'advanced';

export function IntegrationCenter({ business, health, onTest, onSaved }: IntegrationCenterProps) {
  const { t, formatDate } = useDashboardI18n();
  const [values, setValues] = useState<IntegrationValues>(() => getInitialIntegrationValues(business));
  const [selectedKey, setSelectedKey] = useState<IntegrationKey | null>(null);
  const [mode, setMode] = useState<DetailMode>('manage');
  const [wizardStep, setWizardStep] = useState(0);
  const [savingKey, setSavingKey] = useState<IntegrationKey | null>(null);
  const [checkingKey, setCheckingKey] = useState<IntegrationKey | null>(null);
  const [savedAwaitingVerification, setSavedAwaitingVerification] = useState<Set<IntegrationKey>>(new Set());
  const [healthOverrides, setHealthOverrides] = useState<Partial<Record<IntegrationKey, IntegrationHealth>>>({});
  const [validationMessage, setValidationMessage] = useState('');

  useEffect(() => {
    setValues(getInitialIntegrationValues(business));
  }, [business]);

  useEffect(() => {
    setSelectedKey(null);
    setMode('manage');
    setWizardStep(0);
    setSavingKey(null);
    setCheckingKey(null);
    setSavedAwaitingVerification(new Set());
    setHealthOverrides({});
    setValidationMessage('');
  }, [business.id]);

  const healthByKey = useMemo(() => {
    const items = new Map(health.map((item) => [item.key, item]));
    for (const [key, item] of Object.entries(healthOverrides)) {
      if (item) items.set(key as IntegrationKey, item);
    }
    return items;
  }, [health, healthOverrides]);

  const selectedProvider = INTEGRATION_PROVIDERS.find((provider) => provider.key === selectedKey);

  const openProvider = (provider: IntegrationProviderDefinition, nextMode?: DetailMode) => {
    const item = healthByKey.get(provider.key);
    const defaultMode = item?.status === 'setup_required' ? 'wizard' : 'manage';
    setSelectedKey(provider.key);
    setMode(nextMode || defaultMode);
    setWizardStep(0);
    setValidationMessage('');
  };

  const updateValue = (field: IntegrationFieldDefinition, value: string) => {
    setValues((current) => ({ ...current, [field.key]: value }));
    setValidationMessage('');
  };

  const testConnection = async (provider: IntegrationProviderDefinition) => {
    setCheckingKey(provider.key);
    setValidationMessage('');
    try {
      const result = await onTest(provider.key);
      if (result) {
        setHealthOverrides((current) => ({ ...current, [provider.key]: result }));
        if (result.status === 'connected' || result.status === 'synced') {
          setSavedAwaitingVerification((current) => {
            const next = new Set(current);
            next.delete(provider.key);
            return next;
          });
        }
      }
    } finally {
      setCheckingKey(null);
    }
  };

  const saveProvider = async (provider: IntegrationProviderDefinition) => {
    const item = healthByKey.get(provider.key);
    const missing = missingRequiredFields(provider, values, item);
    if (missing.length > 0) {
      setValidationMessage(t('Complete the required fields before saving.'));
      return false;
    }

    setSavingKey(provider.key);
    setValidationMessage('');
    try {
      await api.updateBusiness(business.id, getProviderPayload(provider, values));
      const pendingHealth: IntegrationHealth = {
        key: provider.key,
        label: provider.title,
        status: 'unknown',
        detail: 'Saved configuration has not been verified.',
        lastCheckedAt: null,
        stale: true,
        refreshInProgress: false,
        reasonCode: 'not_yet_checked',
        action: 'check_now',
      };
      setHealthOverrides((current) => ({ ...current, [provider.key]: pendingHealth }));
      setSavedAwaitingVerification((current) => new Set(current).add(provider.key));
      setValues((current) => {
        const next = { ...current };
        for (const field of provider.fields) if (field.secret) next[field.key] = '';
        return next;
      });
      onSaved('Configuration saved. Test the connection to finish.', true);
      return true;
    } catch {
      setValidationMessage(t("We couldn't save this connection. Check the fields and try again."));
      return false;
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <section id="channel-settings" className="card dashboard-section integration-center">
      <div className="card-header integration-center-heading">
        <div>
          <div className="card-title">{t('Integration Center')}</div>
          <div className="card-desc">{t('Connect the tools your business uses. OdinLink verifies every connection before showing it as connected.')}</div>
        </div>
      </div>

      {!selectedProvider ? (
        <div className="integration-card-grid" aria-label={t('Available integrations')}>
          {INTEGRATION_PROVIDERS.map((provider) => {
            const item = healthByKey.get(provider.key);
            const state = getIntegrationDisplayState(item, checkingKey === provider.key);
            const needsSetup = item?.status === 'setup_required' || !item;
            const unsaved = hasUnsavedProviderChanges(provider, values, business);
            return (
              <article className="integration-card" key={provider.key}>
                <div className="integration-card-top">
                  <div className="integration-card-icon"><ChannelIcon channel={provider.key} /></div>
                  <div><h3>{provider.title}</h3><p>{t(provider.description)}</p>{unsaved && <span className="integration-unsaved-note">{t('Unsaved changes')}</span>}</div>
                </div>
                <div className="integration-card-footer">
                  <span className={`integration-state ${state.tone}`} role="status">
                    <StatusDot status={state.tone} />{t(state.label)}
                  </span>
                  <button className="btn btn-primary" type="button" onClick={() => openProvider(provider)}>
                    {needsSetup ? t('Connect {provider}', { provider: provider.title }) : t('Manage')}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="integration-detail">
          <button className="integration-back" type="button" onClick={() => setSelectedKey(null)}>← {t('All integrations')}</button>
          <div className="integration-detail-heading">
            <div className="integration-card-icon"><ChannelIcon channel={selectedProvider.key} /></div>
            <div><h3>{selectedProvider.title}</h3><p>{t(selectedProvider.description)}</p></div>
          </div>

          {mode === 'manage' && (
            <ManageIntegration
              provider={selectedProvider}
              health={healthByKey.get(selectedProvider.key)}
              checking={checkingKey === selectedProvider.key}
              savedAwaitingVerification={savedAwaitingVerification.has(selectedProvider.key)}
              formatDate={formatDate}
              t={t}
              onTest={() => void testConnection(selectedProvider)}
              onSetup={() => { setMode('wizard'); setWizardStep(0); }}
              onAdvanced={() => setMode('advanced')}
            />
          )}

          {mode === 'wizard' && (
            <SetupWizard
              provider={selectedProvider}
              values={values}
              health={healthByKey.get(selectedProvider.key)}
              step={wizardStep}
              saving={savingKey === selectedProvider.key}
              checking={checkingKey === selectedProvider.key}
              validationMessage={validationMessage}
              t={t}
              onChange={updateValue}
              onStep={setWizardStep}
              onSave={async () => {
                if (await saveProvider(selectedProvider)) setWizardStep(getGuidedIntegrationFields(selectedProvider).length + 2);
              }}
              onTest={() => void testConnection(selectedProvider)}
              onAdvanced={() => setMode('advanced')}
            />
          )}

          {mode === 'advanced' && (
            <AdvancedSetup
              provider={selectedProvider}
              values={values}
              saving={savingKey === selectedProvider.key}
              validationMessage={validationMessage}
              t={t}
              onChange={updateValue}
              onSave={() => void saveProvider(selectedProvider)}
              onGuided={() => { setMode('wizard'); setWizardStep(0); }}
            />
          )}
        </div>
      )}
    </section>
  );
}

function ManageIntegration({ provider, health, checking, savedAwaitingVerification, formatDate, t, onTest, onSetup, onAdvanced }: {
  provider: IntegrationProviderDefinition;
  health?: IntegrationHealth;
  checking: boolean;
  savedAwaitingVerification: boolean;
  formatDate: (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
  t: (source: string, values?: Record<string, string | number>) => string;
  onTest: () => void;
  onSetup: () => void;
  onAdvanced: () => void;
}) {
  const state = getIntegrationDisplayState(health, checking);
  return (
    <div className="integration-manage-panel">
      <div className={`integration-status-panel ${state.tone}`}>
        <div><span className={`integration-state ${state.tone}`} role="status"><StatusDot status={state.tone} />{t(state.label)}</span><p>{t(savedAwaitingVerification ? 'Configuration saved, but this connection has not been verified yet.' : health?.detail || 'Complete setup to use this integration.')}</p></div>
        <div className="integration-last-check">{health?.lastCheckedAt ? `${t('Last verified')}: ${formatDate(health.lastCheckedAt, { dateStyle: 'medium', timeStyle: 'short' })}` : t('Not verified yet')}</div>
      </div>
      <div className="integration-manage-actions">
        <button className="btn btn-primary" type="button" onClick={onTest} disabled={checking}>{checking ? t('Checking…') : t('Test connection')}</button>
        <button className="btn btn-ghost" type="button" onClick={onSetup}>{t('Setup / Edit connection')}</button>
        <button className="btn btn-ghost" type="button" onClick={onAdvanced}>{t('Advanced settings')}</button>
      </div>
      <div className="integration-security-note"><strong>{t('Security')}</strong><span>{t('Stored secrets stay masked. Leave a secret field blank to keep the existing value.')}</span></div>
    </div>
  );
}

export function SetupWizard({ provider, values, health, step, saving, checking, validationMessage, t, onChange, onStep, onSave, onTest, onAdvanced }: {
  provider: IntegrationProviderDefinition;
  values: IntegrationValues;
  health?: IntegrationHealth;
  step: number;
  saving: boolean;
  checking: boolean;
  validationMessage: string;
  t: (source: string, values?: Record<string, string | number>) => string;
  onChange: (field: IntegrationFieldDefinition, value: string) => void;
  onStep: (step: number) => void;
  onSave: () => void;
  onTest: () => void;
  onAdvanced: () => void;
}) {
  const guidedFields = getGuidedIntegrationFields(provider);
  const totalSteps = guidedFields.length + 3;
  const reviewStep = guidedFields.length + 1;
  const verifyStep = guidedFields.length + 2;
  const field = step > 0 && step <= guidedFields.length ? guidedFields[step - 1] : null;
  const state = getIntegrationDisplayState(health, checking);

  return (
    <div className="integration-wizard" aria-live="polite">
      <div className="wizard-progress"><span>{t('Step {current} of {total}', { current: step + 1, total: totalSteps })}</span><div><i style={{ width: `${((step + 1) / totalSteps) * 100}%` }} /></div></div>

      {step === 0 && (
        <div className="wizard-step">
          <span className="wizard-eyebrow">{t('Start here')}</span><h4>{t(provider.startTitle)}</h4><p>{t(provider.startCopy)}</p>
          <SetupVisualGuide provider={provider} stepNumber={step + 1} caption={provider.startCopy} visual={provider.startVisual} t={t} />
        </div>
      )}

      {field && (
        <div className="wizard-step">
          <span className="wizard-eyebrow">{field.optional ? t('Optional') : field.advanced ? t('Advanced') : t('Required')}</span>
          <h4>{t('Find your {field}', { field: field.label })}</h4>
          <p>{t('Copy this value from {provider}, then paste it below.', { provider: provider.title })}</p>
          <SetupVisualGuide provider={provider} stepNumber={step + 1} caption={field.help} visual={field.visual} exampleLabel={field.label} example={field.example} compact t={t} />
          <IntegrationField field={field} value={values[field.key]} t={t} onChange={(value) => onChange(field, value)} />
        </div>
      )}

      {step === reviewStep && (
        <div className="wizard-step">
          <span className="wizard-eyebrow">{t('Save configuration')}</span><h4>{t('Review and save')}</h4>
          <p>{t('Saving stores the configuration for this business. It does not mark the connection as verified.')}</p>
          <div className="wizard-review-list">{guidedFields.map((item) => <div key={item.key}><span>{item.label}</span><b>{item.secret ? (values[item.key] ? t('New value ready') : t('Keep existing value')) : (values[item.key] || t('Not entered'))}</b></div>)}</div>
          <button className="btn btn-primary" type="button" onClick={onSave} disabled={saving}>{saving ? t('Saving...') : t('Save configuration')}</button>
        </div>
      )}

      {step === verifyStep && (
        <div className="wizard-step wizard-verify-step">
          <span className="wizard-eyebrow">{t('Verify connection')}</span><h4>{t('Test the connection')}</h4>
          <p>{t('OdinLink will contact the provider and verify the saved configuration before showing Connected.')}</p>
          <span className={`integration-state ${state.tone}`} role="status"><StatusDot status={state.tone} />{t(state.label)}</span>
          {state.tone === 'error' && <p className="wizard-safe-error">{t("We couldn't verify this connection. Check that the IDs and access token belong to the same provider account.")}</p>}
          <button className="btn btn-primary" type="button" onClick={onTest} disabled={checking}>{checking ? t('Checking…') : t('Test connection')}</button>
        </div>
      )}

      {validationMessage && <div className="wizard-validation" role="alert">{validationMessage}</div>}
      <div className="wizard-footer">
        <button className="btn btn-ghost" type="button" onClick={() => onStep(Math.max(0, step - 1))} disabled={step === 0 || saving || checking}>{t('Back')}</button>
        <button className="btn btn-ghost" type="button" onClick={onAdvanced}>{t('Manual configuration')}</button>
        {step < reviewStep && <button className="btn btn-primary" type="button" onClick={() => onStep(step + 1)}>{t('Continue')}</button>}
      </div>
    </div>
  );
}

function SetupVisualGuide({ provider, stepNumber, caption, visual, t, compact = false, exampleLabel, example }: {
  provider: IntegrationProviderDefinition;
  stepNumber: number;
  caption: string;
  visual: IntegrationStepVisual;
  t: (source: string, values?: Record<string, string | number>) => string;
  compact?: boolean;
  exampleLabel?: string;
  example?: string;
}) {
  return (
    <figure className={`setup-visual-guide${compact ? ' compact' : ''}`}>
      <div className={`setup-visual-frame ${visual.type}`} role="img" aria-label={t('Educational setup guide — not a provider screenshot')}>
        {visual.type === 'approved_screenshot' && visual.imageSrc ? <img src={visual.imageSrc} alt="" /> : visual.type === 'illustration' ? (
          <div className="setup-journey">
            <div className="setup-journey-brand"><ChannelIcon channel={provider.key} /><span>{t('Choose this path')}</span></div>
            <div className="setup-journey-path">
              {visual.path.map((node, index) => (
                <div className="setup-journey-segment" key={`${node}-${index}`}>
                  <span className={`setup-journey-node${index === visual.targetIndex ? ' target' : ''}`}>{t(node)}</span>
                  {index < visual.path.length - 1 && <span className="setup-journey-arrow" aria-hidden="true">→</span>}
                </div>
              ))}
            </div>
            {example && <div className="setup-example"><span>{t('Look for')} · {exampleLabel}</span><code>{example}</code><small>{t('Example only — never share a real secret.')}</small></div>}
          </div>
        ) : <div className="setup-visual-placeholder-content"><ChannelIcon channel={provider.key} /><strong>{t('Visual guide unavailable')}</strong><span>{t('Follow the short instruction below.')}</span></div>}
        <span className="setup-visual-step">{stepNumber}</span>
        {visual.type === 'approved_screenshot' && visual.highlight && <span className="setup-visual-target" style={visual.highlight}>{t('Highlighted target area')}</span>}
      </div>
      <figcaption>{t(caption)}</figcaption>
      <a className="btn btn-ghost" href={provider.destinationUrl} target="_blank" rel="noreferrer">{t(provider.destinationLabel)} ↗</a>
    </figure>
  );
}

function AdvancedSetup({ provider, values, saving, validationMessage, t, onChange, onSave, onGuided }: {
  provider: IntegrationProviderDefinition;
  values: IntegrationValues;
  saving: boolean;
  validationMessage: string;
  t: (source: string, values?: Record<string, string | number>) => string;
  onChange: (field: IntegrationFieldDefinition, value: string) => void;
  onSave: () => void;
  onGuided: () => void;
}) {
  return (
    <div className="integration-advanced">
      <div className="integration-subheading"><div><h4>{t('Manual configuration')}</h4><p>{t('Advanced access for support, developers, and unusual provider setups.')}</p></div><button className="btn btn-ghost" type="button" onClick={onGuided}>{t('Guided setup')}</button></div>
      <div className="form-grid-2">{provider.fields.map((field) => <div className="form-group" key={field.key}><IntegrationField field={field} value={values[field.key]} t={t} onChange={(value) => onChange(field, value)} /></div>)}</div>
      <div className="integration-security-note"><strong>{t('Security')}</strong><span>{t('Stored secrets stay masked. Leave a secret field blank to keep the existing value.')}</span></div>
      {validationMessage && <div className="wizard-validation" role="alert">{validationMessage}</div>}
      <div className="save-row"><button className="btn btn-primary" type="button" onClick={onSave} disabled={saving}>{saving ? t('Saving...') : t('Save configuration')}</button></div>
    </div>
  );
}

function IntegrationField({ field, value, t, onChange }: {
  field: IntegrationFieldDefinition;
  value: string;
  t: (source: string, values?: Record<string, string | number>) => string;
  onChange: (value: string) => void;
}) {
  const id = `integration-${field.key}`;
  return (
    <div className="integration-field">
      <label className="form-label" htmlFor={id}>{t(field.label)}{field.optional ? ` · ${t('Optional')}` : ''}</label>
      <input id={id} className="form-input mono" type={field.secret ? 'password' : 'text'} value={value} autoComplete="off" placeholder={field.secret ? '••••••••••••••••' : ''} onChange={(event) => onChange(event.target.value)} />
      {field.secret && <div className="form-hint secret-note">{t('Leave blank to keep the existing credential.')}</div>}
      <details className="integration-field-help"><summary>{t('Where do I find this?')}</summary><p>{t(field.help)}</p></details>
    </div>
  );
}

export default IntegrationCenter;
