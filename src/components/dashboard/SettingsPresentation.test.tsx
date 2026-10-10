import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {BusinessSettings, BusinessToneControls, SystemPromptEditor} from './DashboardSections';
import {DashboardI18nProvider, DASHBOARD_LOCALES, DASHBOARD_LOCALE_STORAGE_KEY} from '../../i18n/dashboard';
import type {Business} from '../../types/dashboard';
const business: Business={id:'7',name:'آرام Studio',industry:'Studio',timezone:'Europe/Stockholm',language:'en',systemPrompt:'  Original\nمرحبا & <rules>  ',toneConfig:{tonePreset:'custom',responseLength:'short',formality:'casual',emojiUsage:'light',customToneInstructions:'Keep this guidance'},services:[{name:'Consultation',durationMinutes:60,price:12,currency:'AUD',active:true},{name:'Follow-up',durationMinutes:30,price:null,currency:'EUR',active:false}],workingHours:{monday:[{start:'09:00',end:'12:00'},{start:'13:00',end:'17:00'}]}};
for(const locale of DASHBOARD_LOCALES){
 const storage={getItem:(key:string)=>key===DASHBOARD_LOCALE_STORAGE_KEY?locale:null,setItem:()=>undefined};
 const markup=renderToStaticMarkup(<DashboardI18nProvider storage={storage}><BusinessSettings business={business} onSaved={()=>undefined}/></DashboardI18nProvider>);
 const ids=[...markup.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length);
 for(const target of [...markup.matchAll(/\bfor="([^"]+)"/g)].map(m=>m[1]))assert.ok(ids.includes(target),`label ${target} has a control`);
 for(const id of ['business-name','business-industry','business-language','business-timezone','service-0-name','service-1-duration','service-1-currency','service-1-active'])assert.ok(ids.includes(id));
 assert.equal((markup.match(/type="submit"/g)||[]).length,2,'two submit affordances, one existing bulk form');assert.equal((markup.match(/<form /g)||[]).length,1);
 assert.match(markup,/value="AUD"/);assert.match(markup,/value="EUR"/);assert.match(markup,/aria-pressed="false"/);assert.match(markup,/aria-label="[^"]+1" dir="ltr"/);
}
const tone=renderToStaticMarkup(<BusinessToneControls business={business} onSaved={()=>undefined}/>);assert.match(tone,/<h1>AI Assistant<\/h1>/);assert.match(tone,/tone-selected-mark" aria-hidden="true"/);assert.match(tone,/type="submit" form="ai-style-form"/);assert.equal((tone.match(/id="ai-style-form"/g)||[]).length,1);assert.doesNotMatch(tone,/<details[^>]+open=/);
const prompt=renderToStaticMarkup(<SystemPromptEditor business={business} onSaved={()=>undefined}/>);assert.match(prompt,/Save instructions/);assert.match(prompt,/  Original\nمرحبا &amp; &lt;rules&gt;  /);assert.match(prompt,/maxLength="10000"/i);
console.log('Scoped Settings labels, unique IDs, same-form saves and AI presentation passed in all six locales.');
