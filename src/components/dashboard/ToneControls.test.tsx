import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { DashboardI18nProvider, DASHBOARD_LOCALE_STORAGE_KEY, dashboardDirection, type DashboardLocale } from '../../i18n/dashboard';
import type { Business } from '../../types/dashboard';
import { BusinessToneControls, SystemPromptEditor } from './DashboardSections';
import { readFileSync } from 'node:fs';

const customGuidance = 'آرام و مطمئن صحبت کن — Calm & confident.';
const business: Business = {
  id: '42',
  name: 'Odin Test',
  systemPrompt: '  Saved prompt\nمرحبا <business> & rules.  ',
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
assert.match(english, /How should OdinLink speak\?/);
assert.match(english, /Save style/);
const defaultStyle = english.split('</section>')[0];
assert.doesNotMatch(defaultStyle, /Response length|Formality|Emoji usage|Custom tone guidance|System Prompt/);
assert.match(english, /<details id="ai-advanced"[^>]*>/);
assert.doesNotMatch(english, /<details[^>]* open=/);
assert.match(english, /Tone adjustments/);
assert.match(english, /Edit custom style/);
assert.match(english, /maxLength="500"/i);
assert.equal((english.match(/id="custom-tone-instructions"/g)||[]).length,1);
for(const label of ['Professional','Friendly','Warm','Casual','Concise','Custom'])assert.match(defaultStyle,new RegExp('>'+label+'<'));
const promptMarkup=renderToStaticMarkup(<SystemPromptEditor business={business} onSaved={() => undefined}/>);
assert.match(promptMarkup,/Custom instructions/);
assert.match(promptMarkup,/  Saved prompt\nمرحبا &lt;business&gt; &amp; rules\.  /);
assert.match(promptMarkup,/maxLength="10000"/i);
assert.match(promptMarkup,/Save instructions/);
assert.doesNotMatch(promptMarkup,/Generate with AI|ai-gen-btn/);

const persian = render('fa');
assert.match(persian, /dir="rtl"/);
assert.match(persian, /اودین‌لینک چگونه صحبت کند/);
assert.match(persian, /ذخیره سبک/);
assert.match(persian, /آرام و مطمئن صحبت کن — Calm &amp; confident\./);

const arabic = render('ar');
assert.match(arabic, /dir="rtl"/);
assert.match(arabic, /كيف ينبغي أن يتحدث OdinLink/);
assert.match(arabic, /حفظ الأسلوب/);
assert.match(arabic, /id="custom-tone-instructions"[^>]*dir="auto"[^>]*translate="no"/);
assert.match(arabic, /آرام و مطمئن صحبت کن — Calm &amp; confident\./);

const source = readFileSync(new URL('./DashboardSections.tsx', import.meta.url), 'utf8');
const toneSource = source.match(/export function BusinessToneControls[\s\S]*?\nfunction ToneChoice/)?.[0] || '';
assert.match(toneSource, /<form[^>]*onSubmit=\{save\}/, 'the Tone card owns its submit form');
assert.match(toneSource, /type="submit" disabled=\{saving\}/, 'the Save button submits and blocks while saving');
assert.match(toneSource, /coordinatorRef\.current\?\.save\(business\.id, tone\)/, 'submit passes the current business and Tone state');

console.log('Business AI tone English, Persian, Arabic, RTL, and business-content UI tests passed.');
