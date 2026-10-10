// State presentation only; served by the existing isolated real-UI fixture harness.
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
export async function runStateFeedbackChecks({page,load,primary,open,before,out,measure,profiles}) {
 const representative=new Set(['375x850','834x1194','1024x768','1440x1000']);let checks=0;
 const account=async()=>{if(!await page.locator('.dashboard-account').evaluate(e=>e.open))await page.locator('.dashboard-account summary').click();};
 const report=async()=>{await primary('home');await page.locator('#home-reports-trigger').click();await page.locator('#analytics-title').waitFor();};
 const alerts=async()=>{await open('notifications');await page.locator('.settings-secondary-nav:visible button').nth(1).click();};
 const capture=async(name,selector)=>{if(selector)await page.locator(selector).first().scrollIntoViewIfNeeded();if(out)await page.screenshot({path:resolve(out,name+'.png'),animations:'disabled'});};
 const safe=async(selector)=>{const el=page.locator(selector).first();await el.scrollIntoViewIfNeeded();const r=await el.evaluate(e=>{const r=e.getBoundingClientRect(),n=document.querySelector('.mobile-bottom-nav');return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,limit:n.getClientRects().length?n.getBoundingClientRect().top:innerHeight};});assert.ok(r.left>=-1&&r.right<=page.viewportSize().width+1&&r.top>=-1&&r.bottom<=r.limit+1,selector+' reachable: '+JSON.stringify(r));};
 let scenarios=[
  ['home-loading','home-loading','home','.state-card'],['home-error','home-error','home','.state-card'],
  ['reports-loading','visual-loading','reports','.analytics-loading'],['reports-error','visual-error','reports','.analytics-state.error'],['reports-unavailable','unavailable','reports','.analytics-state'],
  ['inbox-loading','inbox-loading','inbox','.conversation-skeleton'],['inbox-empty','inbox-empty','inbox','.conversation-state'],
  ['bookings-loading','bookings-loading','bookings','.booking-skeleton'],['bookings-empty','bookings-empty','bookings','.booking-state'],['bookings-error','bookings-error','bookings','.booking-state'],
  ['knowledge-loading','visual-loading','ai-assistant','.knowledge-empty'],['knowledge-empty','visual-empty','ai-assistant','.knowledge-empty'],['knowledge-error','setup-error','ai-assistant','.knowledge-error'],
  ['business-load-error','home-error','home','.state-card'],['cancellation-error','setup-error','business','#cancellation-settings .settings-load-error'],
  ['connections-error','visual-error','connections',before?'#channel-settings':'#channel-settings .settings-load-error'],['connections-loading','visual-loading','connections','.integration-card-grid'],
  ['health-error','visual-error','health','.health-load-state'],['health-stale','held-stale-health','health','.automatic-health-row'],
  ['notifications-empty','visual-empty','notifications','.notification-state'],['notifications-error','visual-error','notifications','.notification-state'],
  ['alerts-load-error','setup-error','alerts','#admin-notifications .settings-load-error']
 ];
 if(process.argv.includes('--before-supplement'))scenarios=scenarios.filter(([name])=>name.startsWith('connections-'));
 for(const [width,height]of process.argv.includes('--feedback-supplement')?[]:before?profiles.filter(([w,h])=>representative.has(w+'x'+h)):profiles){
  await page.setViewportSize({width,height});
  for(const [name,fixture,dest,selector]of scenarios){
   await load('en',fixture);if(dest==='reports')await report();else if(dest==='alerts')await alerts();else if(dest==='connections'){await primary('settings');await page.locator('#settings-connections-trigger').click();}else if(!fixture.startsWith('home-'))await open(dest);
   await page.locator(selector).first().waitFor();if(!before){await measure(name,'en');checks++;if(name.includes('error'))assert.equal(await page.locator(selector).first().getAttribute('role'),'alert');if(name.includes('loading')&&!['reports-loading','connections-loading'].includes(name))assert.equal(await page.locator(selector).first().getAttribute('role'),'status');}
   if(representative.has(width+'x'+height))await capture(`${width}x${height}-${name}`,selector);
  }
  if(process.argv.includes('--before-supplement'))continue;
  // Explicit saves exercise existing handlers, independent payloads and durable local results.
  await load();await primary('ai-assistant');await page.locator('#ai-tone button[type="submit"]').click();
  if(!before){await page.locator('#ai-tone .dashboard-feedback.success').waitFor();await safe('#ai-tone .dashboard-feedback.success');assert.equal(await page.locator('.dashboard-toast').count(),0,'local save has one announcement');}
  if(representative.has(width+'x'+height))await capture(`${width}x${height}-style-saved`,'#ai-tone');
  await page.evaluate(()=>window.failNextBusinessUpdate=true);await page.locator('#ai-tone button[type="submit"]').click();await page.locator('#ai-style-error').waitFor();if(representative.has(width+'x'+height))await capture(`${width}x${height}-style-error`,'#ai-style-error');
  await page.locator('#ai-advanced summary').click();await page.locator('#prompt-editor .save-row button').click();
  if(await page.locator('#ai-advanced').getAttribute('open')===null)await page.locator('#ai-advanced summary').click();
  if(!before)await page.locator('#prompt-editor .dashboard-feedback.success').waitFor();
  if(representative.has(width+'x'+height))await capture(`${width}x${height}-instructions-saved`,'#prompt-editor');
  await open('business');await page.evaluate(()=>window.failNextBusinessUpdate=true);await page.locator('#business-settings-form button[type="submit"]').first().click();
  if(!before){await page.locator('#business-settings .dashboard-feedback.error').waitFor();await safe('#business-settings .dashboard-feedback.error');}
  if(representative.has(width+'x'+height))await capture(`${width}x${height}-business-save-error`,'#business-settings');
  await page.locator('#business-settings-form button[type="submit"]').first().click();if(!before)await page.locator('#business-settings .dashboard-feedback.success').waitFor();
  await page.evaluate(()=>window.failNextSettingsSave=true);await page.locator('#cancellation-settings button[type="submit"]').click();if(!before)await page.locator('#cancellation-settings .dashboard-feedback.error').waitFor();
  if(representative.has(width+'x'+height))await capture(`${width}x${height}-cancellation-save-error`,'#cancellation-settings');
  await alerts();await page.evaluate(()=>window.failNextSettingsSave=true);await page.locator('#admin-notifications button[type="submit"]').click();if(!before)await page.locator('#admin-notifications .dashboard-feedback.error').waitFor();
  if(representative.has(width+'x'+height))await capture(`${width}x${height}-alerts-save-error`,'#admin-notifications');
  await page.locator('#admin-notifications button[type="submit"]').click();if(!before)await page.locator('#admin-notifications .dashboard-feedback.success').waitFor();
  if(representative.has(width+'x'+height))await capture(`${width}x${height}-alerts-saved`,'#admin-notifications');
  // Existing sender error and draft behavior, no new message feature.
  await load();await primary('inbox');await page.locator('.conversation-item').first().click();await page.locator('.conversation-reply-box textarea').fill('Keep my draft');await page.evaluate(()=>window.failNextSend=true);await page.locator('.conversation-reply-box button').click();await page.locator('.conversation-send-error').waitFor();if(!before)assert.equal(await page.locator('.conversation-reply-box textarea').inputValue(),'Keep my draft');if(representative.has(width+'x'+height))await capture(`${width}x${height}-inbox-send-error`,'.conversation-reply-box');
  // Toasts produced by existing create/delete paths; provider/auth is never invoked.
  await load();await account();await page.locator('.dashboard-account').getByRole('button',{name:'Add Business',exact:true}).click();await page.locator('#add-business-name').fill('Synthetic business');await page.locator('dialog button[type="submit"]').click();
  await page.locator('.toast.show').waitFor();if(!before){assert.equal(await page.locator('.dashboard-toast').getAttribute('class'),'toast show dashboard-toast success');await safe('.dashboard-toast');assert.equal(await page.locator('.dashboard-toast [role="status"]').count(),1);await page.locator('.dashboard-toast button').focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');assert.notEqual(await page.locator('.dashboard-toast button').evaluate(e=>getComputedStyle(e).outlineStyle),'none');}
  if(representative.has(width+'x'+height))await capture(`${width}x${height}-toast-success`);
  if(!before)await page.locator('.dashboard-toast button').click();else await page.locator('.toast').click();
  await account();await page.locator('.dashboard-account').getByRole('button',{name:'Add Business',exact:true}).click();await page.locator('#add-business-name').fill('Synthetic failure');await page.evaluate(()=>window.failNextCreate=true);await page.locator('dialog button[type="submit"]').click();
  if(!before){await page.locator('dialog .dashboard-feedback.error').waitFor();assert.equal(await page.locator('.dashboard-toast').count(),0,'dialog owns its error; no inert background toast');await page.locator('dialog').getByRole('button',{name:'Close',exact:true}).click();await account();await page.locator('.dashboard-account').getByRole('button',{name:'Manage Businesses',exact:true}).click();await page.locator('.biz-row [role="button"]').first().click();await page.evaluate(()=>window.failNextDelete=true);await page.locator('dialog').getByRole('button',{name:'Delete Business',exact:true}).click();await page.locator('dialog .dashboard-feedback.error').waitFor();await page.locator('dialog').getByRole('button',{name:'Cancel',exact:true}).click();}
  await load('en','feedback-toast');await primary('settings');await page.locator('#settings-connections-trigger').click();await page.locator('.integration-card').filter({has:page.getByRole('heading',{name:'Telegram',exact:true})}).getByRole('button',{name:'Manage',exact:true}).click();await page.evaluate(()=>window.failNextHealth=true);await page.getByRole('button',{name:'Test connection',exact:true}).click();await page.locator('.toast.show').waitFor();
  if(!before){await safe('.dashboard-toast');assert.equal(await page.locator('.dashboard-toast [role="alert"]').count(),1);if(width===375){await page.waitForTimeout(3800);assert.equal(await page.locator('.dashboard-toast').isVisible(),true,'errors wait for explicit dismissal');}}
  if(representative.has(width+'x'+height))await capture(`${width}x${height}-toast-error`);
  checks+=12;
 }
 if(!before){
  // Every currently mounted animation and generated shape stops under reduced motion.
  await page.emulateMedia({reducedMotion:'reduce'});await load('en','visual-loading');
  for(const dest of ['inbox','bookings','ai-assistant','reports','health','notifications']){
   if(dest==='reports')await report();else await open(dest);
   const moving=await page.locator('.dashboard-page').evaluate(root=>[root,...root.querySelectorAll('*')].flatMap(e=>[null,'::before','::after'].map(p=>{const s=getComputedStyle(e,p);return {name:e.className,p,animation:s.animationName,transition:s.transitionDuration};})).filter(s=>s.animation!=='none'||s.transition.split(',').some(v=>parseFloat(v)>0)));
   assert.deepEqual(moving,[],'static shimmer, pulse and transitions for '+dest);checks++;
  }
  await page.emulateMedia({reducedMotion:'no-preference'});
 }
 {
  for(const locale of ['sv','de','es','fa','ar'])for(const [width,height]of [[375,850],[834,1194],[1024,768],[1440,1000]]){
   await page.setViewportSize({width,height});await load(locale,'setup-error');await primary('ai-assistant');if(!before)await measure('knowledge-error',locale);await page.locator('#knowledge-error').scrollIntoViewIfNeeded();if(out)await capture(`${width}x${height}-${locale}-knowledge-error`);await open('business');if(!before)await measure('cancellation-error',locale);await page.locator('#cancellation-settings .settings-load-error').scrollIntoViewIfNeeded();if(out)await capture(`${width}x${height}-${locale}-cancellation-error`);checks+=2;
   await load(locale,'visual-error');await primary('settings');await page.locator('#settings-connections-trigger').click();if(!before){await measure('connections-unavailable',locale);const statuses=await page.locator('.integration-card').filter({hasText:/Google Calendar|Instagram|Facebook Messenger|WhatsApp Business/}).locator('.integration-state').allTextContents();assert.equal(statuses.length,4);assert.ok(statuses.every(s=>s.trim()===({'sv':'Inte tillgänglig','de':'Nicht verfügbar','es':'No disponible','fa':'در دسترس نیست','ar':'غير متاح'}[locale])),'failed lookup shows the current localized Unavailable label, never stale Loading/Disconnected: '+JSON.stringify(statuses));}if(out)await capture(`${width}x${height}-${locale}-connections-unavailable`);checks++;
  }
 }
 if(!before){
  await page.setViewportSize({width:375,height:850});await load();await primary('ai-assistant');
  const count=()=>page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='updateBusiness').length);
  const initial=await count();await page.evaluate(()=>window.delayedBusinessMethods=['updateBusiness']);await page.locator('#ai-tone button[type="submit"]').click();await page.locator('#ai-tone .dashboard-feedback.info').waitFor();assert.equal(await count(),initial+1);assert.equal(await page.locator('#ai-tone .dashboard-feedback.success').count(),0);if(out)await capture('375x850-style-saving','#ai-tone');
  await page.evaluate(()=>window.pendingBusinessOperations.shift().resolve());await page.locator('#ai-tone .dashboard-feedback.success').waitFor();
  await page.locator('#ai-tone .tone-option').first().click();assert.equal(await count(),initial+1,'editing remains explicit-save only');assert.equal(await page.locator('#ai-tone .dashboard-feedback.success').count(),0,'saved is not autosaved after another edit');
  await open('business');await page.locator('#business-settings-form button[type="submit"]').first().click();await page.locator('#business-settings .dashboard-feedback.success').waitFor();await page.locator('#business-name').fill('Unsaved name');assert.equal(await page.locator('#business-settings .dashboard-feedback.success').count(),0);
  await page.locator('.topbar-search select').selectOption('8');await page.locator('#overview').waitFor();await open('business');assert.equal(await page.locator('#business-settings .dashboard-feedback').count(),0,'previous tenant feedback cannot leak');checks+=6;
  await load('en','feedback-toast');await primary('settings');await page.locator('#settings-connections-trigger').click();await page.locator('.integration-card').filter({has:page.getByRole('heading',{name:'Telegram',exact:true})}).getByRole('button',{name:'Manage',exact:true}).click();await page.evaluate(()=>window.returnErrorHealth=true);await page.getByRole('button',{name:'Test connection',exact:true}).click();await page.locator('.dashboard-toast.error [role="alert"]').waitFor();await page.locator('.topbar-search select').selectOption('8');await page.locator('#overview').waitFor();assert.equal(await page.locator('.dashboard-toast').count(),0,'connection feedback cannot follow the previous business');checks+=2;
 }
 if(!before){
  // Phase 7: a late A connection check must never project its evidence into B.
  for(const failure of ['returnErrorHealth','failNextHealth']){
   await page.setViewportSize({width:834,height:1194});await load('en','feedback-toast');await page.locator('.topbar-search select').selectOption('7');await page.locator('#overview').waitFor();await primary('settings');await page.locator('#settings-connections-trigger').click();
   const card=()=>page.locator('.integration-card').filter({has:page.getByRole('heading',{name:'Telegram',exact:true})});
   await card().getByRole('button',{name:'Manage',exact:true}).click();await page.evaluate(failure=>{window.delayedBusinessMethods=['refreshIntegrationHealth'];window[failure]=true;},failure);await page.getByRole('button',{name:'Test connection',exact:true}).click();await page.waitForFunction(()=>window.pendingBusinessOperations.length===1);
   await page.locator('.topbar-search select').selectOption('8');await page.locator('#overview').waitFor();await primary('settings');await page.locator('#settings-connections-trigger').click();await card().locator('.integration-state.connected').waitFor();
   await page.evaluate(()=>window.pendingBusinessOperations.shift().resolve());await page.waitForTimeout(120);
   assert.equal(await card().locator('.integration-state').innerText(),'Connected','late A evidence must not overwrite B for '+failure);assert.equal(await page.locator('.dashboard-toast').count(),0,'A connection feedback remains absent under B');checks+=2;
  }
 }
 console.log(`State/feedback: ${checks} checks; existing actions and synthetic fixtures only.`);
}
