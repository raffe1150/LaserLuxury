import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DASHBOARD_LOCALES,
  DASHBOARD_LOCALE_STORAGE_KEY,
  DASHBOARD_TRANSLATION_KEYS,
  dashboardDirection,
  formatDashboardDate,
  formatDashboardNumber,
  missingDashboardTranslationKeys,
  persistDashboardLocale,
  resolveDashboardLocale,
  translateDashboardText,
} from './dashboard';

function runTests() {
  const expected = {
    en: 'Business Settings',
    sv: 'Verksamhetsinställningar',
    es: 'Configuración del negocio',
    de: 'Unternehmenseinstellungen',
    fa: 'تنظیمات کسب‌وکار',
    ar: 'إعدادات النشاط',
  } as const;

  assert.deepEqual([...DASHBOARD_LOCALES], ['en', 'sv', 'es', 'de', 'fa', 'ar']);
  for (const locale of DASHBOARD_LOCALES) {
    assert.equal(translateDashboardText(locale, 'Business Settings'), expected[locale]);
    assert.deepEqual(missingDashboardTranslationKeys(locale), [], `${locale} has every canonical dashboard key`);
  }
  assert.ok(DASHBOARD_TRANSLATION_KEYS.length > 450, 'the canonical set covers the full dashboard, not only navigation');

  assert.equal(translateDashboardText('en', '{count} conversations loaded · {range}', { count: '16', range: 'Recent' }), '16 conversations loaded · Recent');
  assert.equal(translateDashboardText('de', 'Reply via {channel}…', { channel: 'Instagram' }), 'Über Instagram antworten…');
  for (const locale of DASHBOARD_LOCALES) {
    assert.ok(!translateDashboardText(locale, '{count} unread in loaded results', { count: 5 }).includes('{count}'));
  }
  assert.equal(resolveDashboardLocale('sv', ['de-DE']), 'sv', 'an explicit persisted locale wins');
  assert.equal(resolveDashboardLocale(null, ['fa-IR', 'en-US']), 'fa', 'browser locale seeds the preference once');
  assert.equal(resolveDashboardLocale('pt', ['pt-BR']), 'en', 'unsupported locales fall back safely');
  assert.equal(dashboardDirection('fa'), 'rtl');
  assert.equal(dashboardDirection('ar'), 'rtl');
  assert.equal(dashboardDirection('de'), 'ltr');

  const values = new Map<string, string>([['odinlink_selected_business', 'business-a'], ['business_language', 'sv']]);
  const storage = { setItem: (key: string, value: string) => values.set(key, value) };
  persistDashboardLocale(storage, 'ar');
  assert.equal(values.get(DASHBOARD_LOCALE_STORAGE_KEY), 'ar');
  assert.equal(values.get('odinlink_selected_business'), 'business-a', 'business switching state is independent');
  assert.equal(values.get('business_language'), 'sv', 'customer-facing language is not mutated');

  assert.notEqual(formatDashboardNumber('de', 1234567.5), formatDashboardNumber('en', 1234567.5));
  assert.match(formatDashboardNumber('fa', 42), /[۰-۹]/, 'Persian numbers use locale digits');
  assert.doesNotThrow(() => formatDashboardDate('ar', '2026-08-24T12:30:00Z', { dateStyle: 'medium' }));

  const credential = 'EAABwzLixnjYBO-secret-token';
  assert.equal(translateDashboardText('ar', credential), credential, 'raw credentials are never translated');
  assert.equal(translateDashboardText('sv', 'Laser Luxury'), 'Laser Luxury', 'business-entered names remain unchanged');

  assert.equal(translateDashboardText('en', 'Connected'), 'Connected');
  assert.equal(translateDashboardText('fa', 'Connected'), 'متصل');
  assert.equal(translateDashboardText('ar', 'Cancelled'), 'ملغى');
  assert.equal(translateDashboardText('fa', 'Save Prompt'), 'ذخیره پرامپت');
  assert.match(translateDashboardText('ar', 'Connect WhatsApp via Meta Cloud API for customer messages.'), /Meta Cloud API/);
  assert.equal(translateDashboardText('ar', 'Instagram'), 'Instagram', 'platform brands remain unchanged');
  const toneLabels = {
    en: 'AI Tone', sv: 'AI-ton', es: 'Tono de IA', de: 'KI-Ton', fa: 'لحن هوش مصنوعی', ar: 'نبرة الذكاء الاصطناعي',
  } as const;
  for (const locale of DASHBOARD_LOCALES) assert.equal(translateDashboardText(locale, 'AI Tone'), toneLabels[locale]);
  const toneSuccess = {
    en: 'AI tone saved.', sv: 'AI-tonen sparades.', es: 'Tono de IA guardado.',
    de: 'KI-Ton gespeichert.', fa: 'لحن هوش مصنوعی ذخیره شد.', ar: 'تم حفظ نبرة الذكاء الاصطناعي.',
  } as const;
  for (const locale of DASHBOARD_LOCALES) {
    assert.equal(translateDashboardText(locale, 'AI tone saved.'), toneSuccess[locale]);
    const failure = translateDashboardText(locale, "Couldn't save AI tone. Please try again.");
    if (locale !== 'en') {
      assert.notEqual(failure, "Couldn't save AI tone. Please try again.", `${locale} has localized safe Tone failure feedback`);
    }
    assert.doesNotMatch(failure, /JSON|SQL|PostgREST|stack/i);
  }
  assert.match(translateDashboardText('fa', 'Checked {minutes} min ago', { minutes: 17 }), /۱۷/);
  for (const locale of DASHBOARD_LOCALES) {
    const unavailableLabel = translateDashboardText(locale, '{label} · unavailable', {
      label: translateDashboardText(locale, 'Estimated booking value today'),
    });
    const unavailablePrice = translateDashboardText(
      locale,
      'Unavailable · 0 of {total} bookings have a configured price',
      { total: 24 },
    );
    assert.doesNotMatch(unavailableLabel, /\{label\}/);
    assert.doesNotMatch(unavailablePrice, /\{total\}/);
  }
  const i18nSource = readFileSync(new URL('./dashboard.tsx', import.meta.url), 'utf8');
  assert.match(
    i18nSource,
    /t:\s*\(source, values\)\s*=>\s*translateDashboardText\(locale, source, values\)/,
    'the dashboard provider forwards interpolation values to the shared translator',
  );
  assert.match(translateDashboardText('ar', '3 integrations need attention'), /3/);
  assert.doesNotMatch(translateDashboardText('ar', '3 integrations need attention'), /integrations need attention/);
  assert.match(translateDashboardText('ar', 'Credentials are masked and updates should be sent to the backend for {business}.', { business: 'Laser Luxury' }), /Laser Luxury/);

  const settingsSource = readFileSync(new URL('../components/dashboard/DashboardSections.tsx', import.meta.url), 'utf8');
  const dashboardShellSource = readFileSync(new URL('../components/dashboard/DashboardShell.tsx', import.meta.url), 'utf8');
  const toneSettingsSource = settingsSource.match(/export function BusinessToneControls[\s\S]*?\nfunction ToneChoice/)?.[0] || '';
  assert.match(settingsSource, /Default assistant language/);
  assert.match(settingsSource, /Used only as a fallback when the customer's language cannot be determined/);
  assert.doesNotMatch(settingsSource, /dashboard-language-setting|setDashboardLocale|DASHBOARD_LOCALE_OPTIONS/);
  assert.match(dashboardShellSource, /Dashboard language/);
  assert.match(dashboardShellSource, /setLocale/);
  assert.match(settingsSource, /language,/s, 'business language remains in the business update payload');
  assert.doesNotMatch(settingsSource, /dashboardLocale,\s*services/s, 'dashboard locale is not sent to the backend');
  assert.match(settingsSource, /dir="auto"/);
  assert.match(settingsSource, /translate="no"/);
  assert.match(settingsSource, /value=\{prompt\}/, 'the business prompt remains the saved value');
  assert.match(settingsSource, /value=\{tone\.customToneInstructions\}/, 'custom tone text remains business-owned content');
  assert.match(toneSettingsSource, /\.save\(business\.id, tone\)/, 'structured tone settings use the guarded business update path');
  assert.match(toneSettingsSource, /AI tone saved\./);
  assert.match(toneSettingsSource, /Couldn't save AI tone\. Please try again\./);
  assert.doesNotMatch(toneSettingsSource, /error\.message/, 'Tone errors are never rendered directly');
  assert.match(settingsSource, /id="custom-tone-instructions"[\s\S]*?dir="auto"[\s\S]*?translate="no"/);

  const assistantLanguageLabels = {
    en: 'Default assistant language', sv: 'Standardspråk för assistenten',
    es: 'Idioma predeterminado del asistente', de: 'Standardsprache des Assistenten',
    fa: 'زبان پیش‌فرض دستیار', ar: 'لغة المساعد الافتراضية',
  } as const;
  const assistantLanguageHelp = "Used only as a fallback when the customer's language cannot be determined. OdinLink automatically responds in the customer's detected language.";
  for (const locale of DASHBOARD_LOCALES) {
    assert.equal(translateDashboardText(locale, 'Default assistant language'), assistantLanguageLabels[locale]);
    assert.match(translateDashboardText(locale, assistantLanguageHelp), /OdinLink|اودین‌لینک/);
    if (locale !== 'en') assert.notEqual(translateDashboardText(locale, assistantLanguageHelp), assistantLanguageHelp);
  }

  const bookingsSource = readFileSync(new URL('../components/dashboard/BookingsPanel.tsx', import.meta.url), 'utf8');
  assert.match(bookingsSource, /t\(bookingStatusLabel\(booking\.status\)\)/, 'canonical booking statuses are translated only at render time');
  assert.match(bookingsSource, /Load more \(\{loaded\} of \{total\}\)/, 'booking counts use interpolation');

  const healthSource = readFileSync(new URL('../components/dashboard/HealthStatus.tsx', import.meta.url), 'utf8');
  assert.match(healthSource, /Checked \{minutes\} min ago/);
  assert.doesNotMatch(healthSource, /`\$\{minutes\} min ago`/);

  const pageSource = readFileSync(new URL('../pages/dashboard.tsx', import.meta.url), 'utf8');
  assert.match(pageSource, /data-dashboard-locale=\{locale\}/);
  assert.match(pageSource, /dir=\{direction\}/);
  assert.match(pageSource, /DashboardI18nProvider/);

  const dashboardStyles = readFileSync(new URL('../styles/dashboard.css', import.meta.url), 'utf8');
  assert.match(dashboardStyles, /\.mono,[\s\S]*?unicode-bidi:isolate;direction:ltr/, 'technical values stay LTR and isolated in RTL layouts');

  for (const locale of DASHBOARD_LOCALES) {
    for (const label of ['AI Assistant', 'Account', 'Manage Businesses', 'Create business', 'Connections', 'Connection health', 'Back to {destination}', 'Reports', 'Open Inbox', 'Open Bookings', 'View reports', 'Home actions', 'Conversations with customer activity today', 'How should OdinLink speak?', 'Style changes how OdinLink communicates. Your business information and booking rules still apply.', 'Business answers', 'Advanced', 'Tone adjustments', 'Custom tone guidance', 'Edit custom style', 'Save style', 'Custom instructions', 'Instructions', 'Back to assistant style', 'Used when Custom is selected. Add business facts in Business answers.', 'Add information OdinLink can use when answering customer questions.']) {
      const translated = translateDashboardText(locale, label, { destination: 'Home' });
      assert.ok(translated.length > 0);
      if (locale !== 'en') assert.notEqual(translated, label.replace('{destination}', 'Home'));
    }
  }

  console.log('Dashboard localization tests passed.');
}

runTests();

for(const locale of DASHBOARD_LOCALES){
  for(const label of ['Business','Settings setup','Issues','Business alerts','Cancellation policy']){
    assert.ok(translateDashboardText(locale,label));
    if(locale!=='en')assert.notEqual(translateDashboardText(locale,label),label);
  }
  assert.doesNotMatch(translateDashboardText(locale,'Open {destination}',{destination:translateDashboardText(locale,'Business')}),/\{destination\}/);
}

for(const locale of ['sv','de','es','fa','ar'] as const)for(const key of ['Save instructions','Save alert destination','Optional style adjustments and custom instructions.','Business information, services and working hours are saved together.'])assert.notEqual(translateDashboardText(locale,key),key,`Phase 5 copy is translated: ${locale}/${key}`);

// RC-02: these Knowledge labels previously fell outside the canonical key set.
const knowledgeInterfaceKeys = [
  'sources', 'Add knowledge',
  'Use manual text for policies, FAQs, procedures and other business information.',
  'Manual text', 'Title', 'Content', 'Example: Cancellation policy',
  'Write the information the assistant should know...',
] as const;
for (const key of knowledgeInterfaceKeys) {
  assert.ok(DASHBOARD_TRANSLATION_KEYS.includes(key), `Knowledge key is canonical: ${key}`);
  assert.equal(translateDashboardText('en', key), key, 'English remains the source text');
  for (const locale of ['sv', 'de', 'es', 'fa', 'ar'] as const) {
    const translated = translateDashboardText(locale, key);
    assert.notEqual(translated, key, `${locale}/${key} has no English fallback`);
    assert.ok(translated.trim().length > 0);
    assert.equal(dashboardDirection(locale), locale === 'fa' || locale === 'ar' ? 'rtl' : 'ltr');
  }
}

// RC-02b: every literal Knowledge UI label, including shared feedback, resolves.
const knowledgePanelSource = readFileSync(new URL('../components/dashboard/KnowledgePanel.tsx', import.meta.url), 'utf8');
const knowledgeRemainingKeys = ['Knowledge library', 'Information currently available to this business AI.', 'Loading...', 'Refresh', 'No Knowledge added yet', 'Add your first business policy, FAQ or procedure using the form.', 'Delete "{title}" from Knowledge?'];
const knowledgeVisibleKeys = [...new Set([
  ...Array.from(knowledgePanelSource.matchAll(/\bt\(\s*'([^']+)'/g), match => match[1]),
  ...knowledgeRemainingKeys, 'Knowledge added', 'Knowledge deleted', 'Done', 'Needs attention', 'Adding...', 'Deleting...',
  'Could not load Knowledge sources', 'Could not add Knowledge', 'Could not delete Knowledge',
])];
for (const key of knowledgeVisibleKeys) {
  assert.equal(translateDashboardText('en', key), key);
  for (const locale of ['sv', 'de', 'es', 'fa', 'ar'] as const) {
    assert.ok(DASHBOARD_TRANSLATION_KEYS.includes(key), `Knowledge UI key is canonical: ${key}`);
    assert.notEqual(translateDashboardText(locale, key), key, `${locale}: no Knowledge UI fallback for ${key}`);
  }
}
for (const title of ['1234567', '  {title} "$&" سیاست ١٣  ', 'Customer\nsource']) {
  assert.equal(translateDashboardText('en', 'Delete "{title}" from Knowledge?').replace('{title}', () => title), `Delete "${title}" from Knowledge?`, 'confirmation preserves raw titles and English bytes');
}
