import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { DashboardI18nProvider, DASHBOARD_LOCALE_STORAGE_KEY, dashboardDirection, type DashboardLocale } from '../../i18n/dashboard';
import type { Business } from '../../types/dashboard';
import { BusinessToneControls } from './DashboardSections';
import { readFileSync } from 'node:fs';

const customGuidance = 'آرام و مطمئن صحبت کن — Calm & confident.';
const business: Business = {
  id: '42',
  name: 'Odin Test',
  toneConfig: {
    tonePreset: 'custom',
    responseLength: 'short',
    emojiUsage: 'light',
    formality: 'balanced',
    customToneInstructions: customGuidance,
  },
};

function render(locale: DashboardLocale) {
  const storage = {
    getItem: (key: string) => key === DASHBOARD_LOCALE_STORAGE_KEY ? locale : null,
    setItem: () => undefined,
  };
  return renderToStaticMarkup(
    <DashboardI18nProvider storage={storage}>
      <div dir={dashboardDirection(locale)}>
        <BusinessToneControls business={business} onSaved={() => undefined} />
      </div>
    </DashboardI18nProvider>,
  );
}

const english = render('en');
assert.match(english, /AI Tone/);
assert.match(english, /Save AI Tone/);

const persian = render('fa');
assert.match(persian, /dir="rtl"/);
assert.match(persian, /لحن هوش مصنوعی/);
assert.match(persian, /ذخیره لحن هوش مصنوعی/);
assert.match(persian, /آرام و مطمئن صحبت کن — Calm &amp; confident\./);

const arabic = render('ar');
assert.match(arabic, /dir="rtl"/);
assert.match(arabic, /نبرة الذكاء الاصطناعي/);
assert.match(arabic, /حفظ نبرة الذكاء الاصطناعي/);
assert.match(arabic, /id="custom-tone-instructions"[^>]*dir="auto"[^>]*translate="no"/);
assert.match(arabic, /آرام و مطمئن صحبت کن — Calm &amp; confident\./);

const source = readFileSync(new URL('./DashboardSections.tsx', import.meta.url), 'utf8');
const toneSource = source.match(/export function BusinessToneControls[\s\S]*?\nfunction ToneChoice/)?.[0] || '';
assert.match(toneSource, /<form onSubmit=\{save\}>/, 'the Tone card owns its submit form');
assert.match(toneSource, /type="submit" disabled=\{saving\}/, 'the Save button submits and blocks while saving');
assert.match(toneSource, /coordinatorRef\.current\?\.save\(business\.id, tone\)/, 'submit passes the current business and Tone state');

console.log('Business AI tone English, Persian, Arabic, RTL, and business-content UI tests passed.');
