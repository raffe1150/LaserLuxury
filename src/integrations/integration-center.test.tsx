import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import IntegrationCenter, { SetupWizard } from '../components/dashboard/IntegrationCenter';
import { DashboardI18nProvider, DASHBOARD_LOCALES, dashboardDirection, translateDashboardText } from '../i18n/dashboard';
import type { Business, IntegrationHealth } from '../types/dashboard';
import {
  INTEGRATION_PROVIDERS,
  getInitialIntegrationValues,
  getGuidedIntegrationFields,
  getIntegrationDisplayState,
  getProviderPayload,
  hasUnsavedProviderChanges,
  missingRequiredFields,
} from './integration-center';

const business: Business = {
  id: '7',
  name: 'Tenant Seven',
  timezone: 'Europe/Stockholm',
  calendarId: 'calendar@example.com',
  instagramPageId: 'page-7',
  instagramAccountId: 'instagram-7',
  instagramAccessToken: 'must-never-render',
  telegramToken: 'must-never-render-either',
};
const health: IntegrationHealth[] = INTEGRATION_PROVIDERS.map((provider) => ({
  key: provider.key,
  label: provider.title,
  status: provider.key === 'google_calendar' ? 'connected' : 'setup_required',
  detail: provider.key === 'google_calendar' ? 'Calendar is configured and reachable.' : 'Complete setup.',
  lastCheckedAt: provider.key === 'google_calendar' ? '2026-08-26T08:00:00Z' : null,
  stale: false,
  refreshInProgress: false,
  reasonCode: provider.key === 'google_calendar' ? 'verified' : 'not_configured',
  action: provider.key === 'google_calendar' ? 'check_now' : 'complete_setup',
}));

assert.deepEqual(INTEGRATION_PROVIDERS.map((provider) => provider.key), ['google_calendar', 'instagram', 'messenger', 'telegram', 'whatsapp']);
assert.deepEqual(INTEGRATION_PROVIDERS.find((provider) => provider.key === 'google_calendar')?.fields.map((field) => field.key), ['calendarId', 'timezone']);
assert.deepEqual(INTEGRATION_PROVIDERS.find((provider) => provider.key === 'instagram')?.fields.map((field) => field.key), ['instagramPageId', 'instagramAccountId', 'instagramAccessToken', 'instagramWebhookVerifyToken']);
assert.deepEqual(INTEGRATION_PROVIDERS.find((provider) => provider.key === 'messenger')?.fields.map((field) => field.key), ['messengerPageId', 'messengerAccessToken', 'messengerAppSecret', 'messengerWebhookVerifyToken']);
assert.deepEqual(INTEGRATION_PROVIDERS.find((provider) => provider.key === 'telegram')?.fields.map((field) => field.key), ['telegramToken', 'telegramAdminChatId']);
assert.deepEqual(INTEGRATION_PROVIDERS.find((provider) => provider.key === 'whatsapp')?.fields.map((field) => field.key), ['whatsappPhoneNumberId', 'whatsappBusinessAccountId', 'whatsappAccessToken', 'whatsappWebhookVerifyToken']);
const instagram = INTEGRATION_PROVIDERS.find((provider) => provider.key === 'instagram')!;
assert.deepEqual(getGuidedIntegrationFields(instagram).map((field) => field.key), ['instagramPageId', 'instagramAccountId', 'instagramAccessToken']);
assert.deepEqual(getGuidedIntegrationFields(INTEGRATION_PROVIDERS.find((provider) => provider.key === 'messenger')!).map((field) => field.key), ['messengerPageId', 'messengerAccessToken']);
assert.deepEqual(getGuidedIntegrationFields(INTEGRATION_PROVIDERS.find((provider) => provider.key === 'whatsapp')!).map((field) => field.key), ['whatsappPhoneNumberId', 'whatsappBusinessAccountId', 'whatsappAccessToken']);
for (const provider of INTEGRATION_PROVIDERS) {
  assert.equal(provider.startVisual.type, 'illustration', `${provider.title} has a real educational start visual`);
  assert.ok(provider.startVisual.path.length >= 3, `${provider.title} start journey is provider-specific`);
  for (const field of getGuidedIntegrationFields(provider)) {
    assert.equal(field.visual.type, 'illustration', `${provider.title} ${field.label} has an educational discovery visual`);
    assert.ok(field.visual.path.length >= 3);
    assert.ok(field.visual.targetIndex >= 0 && field.visual.targetIndex < field.visual.path.length);
    assert.ok(field.example && !/must-never-render|replacement-secret/.test(field.example));
  }
}
assert.notDeepEqual(INTEGRATION_PROVIDERS.find((provider) => provider.key === 'instagram')?.startVisual.path, INTEGRATION_PROVIDERS.find((provider) => provider.key === 'messenger')?.startVisual.path);
assert.notDeepEqual(INTEGRATION_PROVIDERS.find((provider) => provider.key === 'messenger')?.startVisual.path, INTEGRATION_PROVIDERS.find((provider) => provider.key === 'whatsapp')?.startVisual.path);

assert.deepEqual(getIntegrationDisplayState(health[0]), { label: 'Connected', tone: 'connected', verified: true });
assert.equal(getIntegrationDisplayState(health[1]).label, 'Not connected');
assert.equal(getIntegrationDisplayState({ ...health[1], status: 'unknown' }).label, 'Needs attention');
assert.equal(getIntegrationDisplayState({ ...health[1], status: 'degraded' }).label, 'Needs attention');
assert.equal(getIntegrationDisplayState({ ...health[1], status: 'disconnected' }).label, 'Connection failed');
assert.equal(getIntegrationDisplayState(health[0], true).label, 'Checking connection');

const initial = getInitialIntegrationValues(business);
assert.equal(initial.instagramAccessToken, '', 'stored Instagram secrets never enter form state');
assert.equal(initial.telegramToken, '', 'stored Telegram secrets never enter form state');
assert.doesNotMatch(JSON.stringify(initial), /must-never-render/);
assert.doesNotMatch(JSON.stringify(getProviderPayload(instagram, initial)), /AccessToken|VerifyToken/, 'blank secret fields preserve existing credentials');
const telegram = INTEGRATION_PROVIDERS.find((provider) => provider.key === 'telegram')!;
assert.equal('telegramAdminChatId' in getProviderPayload(telegram, initial), false, 'an unavailable blank optional admin ID is preserved rather than erased');
assert.equal(hasUnsavedProviderChanges(instagram, initial, business), false);
const edited = { ...initial, instagramAccessToken: 'replacement-secret' };
assert.equal(hasUnsavedProviderChanges(instagram, edited, business), true);
assert.equal(getProviderPayload(instagram, edited).instagramAccessToken, 'replacement-secret');
assert.ok(missingRequiredFields(instagram, initial, health[1]).some((field) => field.key === 'instagramAccessToken'));
assert.equal(missingRequiredFields(instagram, initial, { ...health[1], status: 'unknown', reasonCode: 'not_yet_checked' }).some((field) => field.key === 'instagramAccessToken'), false, 'existing masked secrets can be preserved');

const markup = renderToStaticMarkup(createElement(DashboardI18nProvider, null,
  createElement(IntegrationCenter, {
    business,
    health,
    onTest: async () => undefined,
    onSaved: () => undefined,
  }),
));
assert.match(markup, /Integration Center/);
for (const provider of INTEGRATION_PROVIDERS) assert.match(markup, new RegExp(provider.title));
assert.match(markup, /Manage/);
assert.match(markup, /Connect Instagram/);
assert.doesNotMatch(markup, /must-never-render/);
assert.equal((markup.match(/integration-card"/g) || []).length, 5);

for (const provider of INTEGRATION_PROVIDERS) {
  const wizardProps = {
    provider,
    values: initial,
    health: health.find((item) => item.key === provider.key),
    saving: false,
    checking: false,
    validationMessage: '',
    t: (source: string, values?: Record<string, string | number>) => translateDashboardText('en', source, values),
    onChange: () => undefined,
    onStep: () => undefined,
    onSave: () => undefined,
    onTest: () => undefined,
    onAdvanced: () => undefined,
  };
  const introMarkup = renderToStaticMarkup(createElement(SetupWizard, { ...wizardProps, step: 0 }));
  assert.match(introMarkup, /setup-journey-path/);
  assert.doesNotMatch(introMarkup, /Visual guide coming soon/);
  const fieldMarkup = renderToStaticMarkup(createElement(SetupWizard, { ...wizardProps, step: 1 }));
  assert.match(fieldMarkup, /setup-example/);
  assert.match(fieldMarkup, new RegExp(`integration-${getGuidedIntegrationFields(provider)[0].key}`));
  assert.match(fieldMarkup, />Back<|>Continue</);
}

const providerCopy = INTEGRATION_PROVIDERS.flatMap((provider) => [
  provider.description,
  provider.destinationLabel,
  provider.startTitle,
  provider.startCopy,
  ...provider.startVisual.path,
  ...provider.fields.map((field) => field.help),
  ...getGuidedIntegrationFields(provider).flatMap((field) => field.visual.path),
]);
const visualCopy = ['Find your {field}', 'Educational setup guide — not a provider screenshot', 'Choose this path', 'Look for', 'Example only — never share a real secret.'];
const technicalVisualLabels = ['Google Calendar', 'Instagram', 'Messenger', 'Telegram', 'WhatsApp', 'BotFather', 'Meta for Developers', 'Calendar ID', 'Instagram Account ID', 'WhatsApp Business Account ID', 'Phone Number ID', 'API Setup', 'General'];
for (const locale of DASHBOARD_LOCALES.filter((item) => item !== 'en')) {
  assert.notEqual(translateDashboardText(locale, 'Integration Center'), 'Integration Center');
  assert.notEqual(translateDashboardText(locale, 'Where do I find this?'), 'Where do I find this?');
  for (const source of providerCopy) {
    if (!technicalVisualLabels.includes(source)) {
      assert.notEqual(translateDashboardText(locale, source), source, `${locale} localizes provider guidance: ${source}`);
    }
  }
  for (const source of visualCopy) assert.notEqual(translateDashboardText(locale, source), source, `${locale} localizes visual UI: ${source}`);
}
assert.equal(dashboardDirection('fa'), 'rtl');
assert.equal(dashboardDirection('ar'), 'rtl');

const componentSource = readFileSync(new URL('../components/dashboard/IntegrationCenter.tsx', import.meta.url), 'utf8');
const pageSource = readFileSync(new URL('../pages/dashboard.tsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../services/api.ts', import.meta.url), 'utf8');
const serverSource = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../styles/dashboard.css', import.meta.url), 'utf8');
assert.match(pageSource, /<IntegrationCenter/);
assert.match(componentSource, /setWizardStep/);
assert.match(componentSource, /function SetupVisualGuide/);
assert.match(componentSource, /approved_screenshot/);
assert.match(componentSource, /visual\.imageSrc/);
assert.match(componentSource, /visual\.highlight/);
assert.match(componentSource, /setup-visual-target/);
assert.match(componentSource, /setup-journey-path/);
assert.match(componentSource, /setup-example/);
assert.match(componentSource, /<IntegrationField field=\{field\}/, 'field paste input stays on the same guided step');
assert.match(componentSource, /Math\.max\(0, step - 1\)/, 'Back navigation remains bounded');
assert.match(componentSource, /onStep\(step \+ 1\)/, 'Continue navigation remains available');
assert.doesNotMatch(componentSource, /Visual guide coming soon/);
assert.match(componentSource, /mode === 'manage'/);
assert.match(componentSource, /mode === 'wizard'/);
assert.match(componentSource, /mode === 'advanced'/);
assert.match(componentSource, /Saved configuration has not been verified/);
assert.match(componentSource, /type=\{field\.secret \? 'password'/);
assert.match(componentSource, /Leave blank to keep the existing credential/);
assert.doesNotMatch(componentSource, /console\.|localStorage|sessionStorage|URLSearchParams/);
assert.match(apiSource, /secret && typeof value === 'string' && value\.trim\(\) === ''/);
assert.match(serverSource, /requireBusinessPermission\('settings\.manage'\)/);
assert.match(serverSource, /\.update\(payload\)[\s\S]*?\.eq\('id', businessId\)/);
assert.match(serverSource, /invalidateIntegrationHealthCache\(businessId, changedIntegrations\)/);
assert.doesNotMatch(serverSource.match(/const DASHBOARD_BUSINESS_COLUMNS = \[[\s\S]*?\]\.join\(','\);/)?.[0] || '', /access_token|app_secret|verify_token|telegram_bot_token|private_key/);
assert.match(cssSource, /@media\(max-width:760px\)[\s\S]*?\.integration-card-grid\{grid-template-columns:1fr;/);
assert.match(cssSource, /@media\(max-width:760px\)[\s\S]*?\.setup-journey-path,[\s\S]*?flex-direction:column/);
assert.match(cssSource, /focus-visible/);

console.log('Integration Center provider fields, verified states, security, localization, and responsive UX tests passed.');
