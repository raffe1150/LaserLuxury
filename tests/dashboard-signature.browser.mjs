import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

// Actual application styles/components, using only the existing local API fixture.
export async function runSignatureChecks({page,load,primary,open,out}) {
 const evidence={inbox:[],fields:[],locales:[],errors:[]};
 for(const [width,height] of [[1440,1000],[1440,720],[1200,720],[1280,720],[1024,600],[834,1194],[390,844],[320,568]]) {
  await page.setViewportSize({width,height});await load();await open('inbox');await page.waitForTimeout(150);
  const measure=()=>page.evaluate(()=>{const box=s=>{const e=document.querySelector(s);if(!e||!e.getClientRects().length)return null;const r=e.getBoundingClientRect();return {height:r.height,width:r.width,top:r.top,bottom:r.bottom};};return {transcript:box('.chat-transcript'),search:box('.dashboard-search'),first:box('.conversation-item'),list:box('.conversation-list'),nav:box('.mobile-bottom-nav'),single:document.querySelector('#conversations').classList.contains('conversation-single-pane'),overflow:document.documentElement.scrollWidth>innerWidth};});
  await page.keyboard.press('Tab'); // Establish keyboard modality before checking focus-visible.
  for(const button of await page.locator('.conversation-primary-channels button').all()) {
   assert.equal(await button.isVisible(),true,'primary channels require no disclosure');await button.focus();await page.waitForTimeout(100);
   const reach=await button.evaluate(e=>{const b=e.getBoundingClientRect(),p=e.closest('.conversation-channel-tabs').getBoundingClientRect();return {inside:b.left>=p.left-1&&b.right<=p.right+1,height:b.height,focus:getComputedStyle(e).outlineStyle}});
   assert.ok(reach.inside&&reach.height>=44&&reach.focus==='solid','channel keyboard reachability '+JSON.stringify({width,height,button:await button.innerText(),...reach}));
  }
  const closed=await measure();assert.equal(closed.overflow,false);assert.equal(closed.search.height,44);
  if(width===390)assert.ok(closed.first.bottom<closed.nav.top,'ordinary conversations are visible before mobile navigation');
  await page.locator('.conversation-filter-disclosure > summary').click();const expanded=await measure();
  const popup=await page.locator('.conversation-filters').boundingBox(),workspace=await page.locator('#conversations').boundingBox();assert.ok(popup.x>=workspace.x-1&&popup.x+popup.width<=workspace.x+workspace.width+1,'popover remains inside Inbox at every responsive width');
  if(!closed.single){assert.ok(Math.abs(expanded.transcript.height-closed.transcript.height)<1);assert.equal(expanded.list.width,320);assert.ok(Math.abs(expanded.list.height-closed.list.height)<1,'secondary popover does not consume customer-list area');assert.ok(expanded.transcript.height>=(width===1440?(height===1000?517:257):216),'approved transcript minimum preserved');}
  for(const b of await page.locator('.conversation-filters button').all()){await b.focus();const r=await b.evaluate(e=>{const a=e.getBoundingClientRect(),p=e.closest('.conversation-filters').getBoundingClientRect();return {inside:a.top>=p.top-1&&a.bottom<=p.bottom+1,height:a.height};});assert.ok(r.inside);assert.ok(r.height>=44);}
  if(width<=390) {
   await page.locator('.conversation-status-tabs button').nth(2).click();const reset=page.locator('.conversation-reset');await reset.focus();
   const reach=await reset.boundingBox(),nav=await page.locator('.mobile-bottom-nav').boundingBox();assert.ok(reach.y+reach.height<=nav.y-1,'active reset stays above mobile navigation');
   await reset.click();await page.waitForFunction(()=>window.fixtureCalls.filter(c=>c.method==='getConversationPage').at(-1)?.payload.status==='all');
  }
  await page.locator('.conversation-filter-disclosure > summary').click();await page.locator('.conversation-item').first().click();await page.locator('.conversation-reply-input').waitFor();
  assert.equal(await page.locator('.transcript-message time').first().evaluate(e=>parseFloat(getComputedStyle(e).fontSize)),12);
  for(const role of ['customer','ai','human'])assert.ok(await page.locator('.transcript-message.'+role+' .transcript-author').count()>0,'metadata-backed role has a label');
  const draft='Signature draft — سلام Studio';await page.locator('.conversation-reply-input').fill(draft);
  if(width<=768){assert.equal(await page.locator('.mobile-bottom-nav').isVisible(),false);await page.locator('.conversation-mobile-back').click();}
  await primary('home');await primary('inbox');if(width<=768)await page.locator('.conversation-item').first().click();assert.equal(await page.locator('.conversation-reply-input').inputValue(),draft);
  evidence.inbox.push({width,height,closed,expanded,draftPreserved:true});
 }
 const policy={en:'Booking & Cancellation Policies',sv:'Boknings- och avbokningspolicyer',de:'Buchungs- und Stornierungsrichtlinien',es:'Políticas de reserva y cancelación',fa:'سیاست‌های رزرو و لغو',ar:'سياسات الحجز والإلغاء'};
 for(const locale of Object.keys(policy)){
  await page.setViewportSize({width:390,height:844});await load(locale);await open('business');
  assert.equal(await page.locator('.booking-policy-heading h2').textContent(),policy[locale]);assert.equal(await page.locator('.booking-policy-group form').count(),1);assert.equal(await page.locator('#business-settings-form').count(),1);assert.equal(await page.locator('.booking-policy-group').locator('form #business-name').count(),0,'policy stays outside joint Business form');
  const fields=await page.locator('.business-settings-input-shell').evaluateAll(es=>es.map(e=>{const i=e.querySelector('.business-settings-field-icon').getBoundingClientRect(),c=e.querySelector('input,select'),r=c.getBoundingClientRect();return {clear:getComputedStyle(e).direction==='rtl'?r.right<=i.left+1:r.left>=i.right-1,font:parseFloat(getComputedStyle(c).fontSize)};}));assert.ok(fields.every(x=>x.clear&&x.font>=16));evidence.fields.push({locale,fields});
  await open('ai-assistant');const order=await page.evaluate(()=>!!(document.querySelector('.knowledge-library-card').compareDocumentPosition(document.querySelector('.knowledge-create-card'))&Node.DOCUMENT_POSITION_FOLLOWING));assert.equal(order,true,'library precedes editor in visual and keyboard order');
  const record=page.locator('.knowledge-source-row');await record.waitFor();const material=await record.evaluate(e=>{const c=getComputedStyle(e).backgroundColor.match(/[\d.]+/g).slice(0,3).map(Number);return {dark:c.every(x=>x<70),title:!!e.querySelector('.knowledge-source-title')?.textContent,status:!!e.querySelector('.knowledge-status')?.textContent};});assert.ok(material.dark&&material.title&&material.status,'dark read-only record retains name/readiness');
  const font=await page.locator('.knowledge-field input').evaluate(e=>({family:getComputedStyle(e).fontFamily,size:parseFloat(getComputedStyle(e).fontSize)}));assert.match(font.family,/Manrope/);assert.ok(font.size>=16);evidence.locales.push({locale,policy:policy[locale],material,font});
 }
 for(const locale of ['en','fa'])for(const status of ['pending','failed','unknown']) {
  await load(locale,'knowledge-'+status);await open('ai-assistant');const badge=page.locator('.knowledge-status');await badge.waitFor();const label=await badge.textContent();
  if(status==='unknown')assert.equal(label,'external_state','unknown source state is displayed truthfully');
  else {assert.ok(label);assert.notEqual(label,status,'known source state has a localized human label');}
  assert.equal(await page.locator('.knowledge-create-card input[type=file]').count(),0,'no upload capability is introduced');
  evidence.locales.push({locale,sourceStatus:status,label});
 }
 // New secondary-filter count uses the same locale formatter as the existing unread counts.
 await page.setViewportSize({width:1440,height:1000});
 for(const locale of ['en','sv','de','es','fa','ar']) {
  await load(locale);await primary('inbox');await page.locator('.conversation-filter-disclosure summary').click();
  await page.locator('.conversation-range-tabs button').nth(1).click();await page.locator('.conversation-status-tabs button').nth(2).click();
  assert.equal(await page.locator('.conversation-filter-disclosure summary b').innerText(),new Intl.NumberFormat(locale).format(2));
  await page.locator('.conversation-filter-disclosure summary').press('Escape');assert.equal(await page.locator('.conversation-filters').isVisible(),false);
 }
 // Explicit relocated-filter request and tenant-boundary contract, backed by scoped/filtering fixtures.
 await page.setViewportSize({width:1440,height:1000});await load('en','tenant-filter-controls');await primary('inbox');
 const selectedBusiness=await page.locator('.topbar-search select').inputValue();
 for(const channel of ['all','whatsapp','instagram','messenger','telegram']) {
  const tab=page.locator('.conversation-primary-channels button').nth(['all','whatsapp','instagram','messenger','telegram'].indexOf(channel));
  await tab.focus();await page.keyboard.press('Enter');
  await page.waitForFunction(channel=>window.fixtureCalls.filter(c=>c.method==='getConversationPage').at(-1)?.payload.channel===channel,channel);
  await page.waitForFunction(()=>document.querySelector('.conversation-list').getAttribute('aria-busy')==='false');
  const request=await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='getConversationPage').at(-1));
  assert.equal(request.id,selectedBusiness);assert.equal(await page.locator('.topbar-search select').inputValue(),selectedBusiness);
  const rows=await page.locator('.conversation-item').allTextContents();assert.ok(rows.length);assert.ok(rows.every(text=>text.includes('Tenant '+selectedBusiness+' customer')&&!text.includes('Tenant 8 customer')));
  assert.equal(await tab.getAttribute('aria-pressed'),'true');
  if(channel!=='all')assert.ok((await page.locator('.conversation-channel-name').allTextContents()).every(name=>name.toLowerCase()===channel));
 }
 await page.locator('.conversation-primary-channels button').nth(3).click();
 await page.locator('.conversation-filter-disclosure summary').press('Enter');
 await page.locator('.conversation-range-tabs button').nth(2).click();await page.locator('.conversation-status-tabs button').nth(2).click();
 await page.locator('.conversation-status-tabs button').nth(2).press('Escape');
 assert.equal(await page.locator('.conversation-filters').isVisible(),false);assert.equal(await page.locator('.conversation-filter-disclosure summary').evaluate(e=>e===document.activeElement),true,'Escape closes and returns focus');
 await page.locator('.dashboard-search').fill('Tenant '+selectedBusiness);
 await page.waitForFunction(()=>{const r=window.fixtureCalls.filter(c=>c.method==='getConversationPage').at(-1);return r.payload.channel==='messenger'&&r.payload.range==='30d'&&r.payload.status==='booked'&&r.payload.search.startsWith('Tenant ')});
 await page.waitForFunction(()=>document.querySelector('.conversation-list').getAttribute('aria-busy')==='false');
 assert.ok(await page.locator('.conversation-item').count()>0);
 assert.ok((await page.locator('.conversation-item').allTextContents()).every(text=>text.includes('Tenant '+selectedBusiness+' customer')&&!text.includes('Tenant 8 customer')));
 assert.equal(await page.locator('.topbar-search select').inputValue(),selectedBusiness);
 // A real business switch must replace scope rather than retaining the previous tenant's rows.
 await page.locator('.topbar-search select').selectOption('8');await page.locator('#overview').waitFor();await primary('inbox');
 await page.waitForFunction(()=>document.querySelector('.conversation-list').getAttribute('aria-busy')==='false');
 await page.locator('.conversation-primary-channels button').nth(1).click();await page.waitForFunction(()=>{const r=window.fixtureCalls.filter(c=>c.method==='getConversationPage').at(-1);return r.id==='8'&&r.payload.channel==='whatsapp'});
 await page.waitForFunction(()=>document.querySelector('.conversation-list').getAttribute('aria-busy')==='false');
 assert.ok((await page.locator('.conversation-item').allTextContents()).every(text=>text.includes('Tenant 8 customer')&&!text.includes('Tenant 7 customer')));
 evidence.filters={businessUnchangedOnChannel:true,combinedChannelRangeStatusSearch:true,otherTenantExcluded:true,keyboardSelection:true,escapeFocusReturn:true};
 await page.setViewportSize({width:390,height:844});await load('fa');await open('business');const time=page.locator('.working-hours-time-input').first();await time.focus();const ring=await time.evaluate(e=>({within:e.matches(':focus-within'),outline:getComputedStyle(e).outlineStyle}));assert.ok(ring.within&&ring.outline==='solid','native time segments retain whole-control focus');
 assert.deepEqual(await page.evaluate(()=>window.fixtureCalls.filter(c=>/^(update|create|delete|send)/.test(c.method))),[]);
 if(out)writeFileSync(resolve(out,'signature.json'),JSON.stringify(evidence,null,2));console.log('Signature actual-app transcript, contained filters, drafts, policy boundaries, locales, dark records, fields and native time focus: PASS');
}


// Hero-only checks protect operational reachability, truthful states and wrapping.
export async function runHomeHeroChecks({page,load,primary,out}) {
 const evidence={layouts:[],states:[],actions:[]};
 const measure=()=>page.evaluate(()=>{const box=s=>{const e=document.querySelector(s);if(!e||!e.getClientRects().length)return null;const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,width:r.width};};const h=document.querySelector('#overview h1');return {hero:box('#overview .mission-hero'),heading:box('#overview h1'),name:h?.innerText,nameFits:!h||h.scrollWidth<=h.clientWidth+1,attention:box('#overview .mission-status-indicator'),inbox:box('#overview .home-business-heading button'),footer:box('#overview .home-operational-footer'),nav:box('.mobile-bottom-nav'),kpis:[...document.querySelectorAll('#overview .hero-result-copy strong')].map(e=>e.innerText),metrics:[...document.querySelectorAll('#overview .hero-result-item')].map(e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom};}),overflow:document.documentElement.scrollWidth>innerWidth};});
 for(const [width,height,locale,fixture] of [[1440,1000,'en','rich'],[1440,720,'en','rich'],[1024,600,'en','rich'],[834,1194,'en','rich'],[390,844,'en','rich'],[320,568,'en','rich'],[390,844,'sv','rich'],[390,844,'de','rich'],[390,844,'es','rich'],[390,844,'fa','rtl-name-fa'],[390,844,'ar','rtl-name-ar'],[390,844,'de','long-token']]) {
  await page.setViewportSize({width,height});await load(locale,fixture);await primary('home');const m=await measure();
  assert.equal(m.overflow,false);assert.equal(m.nameFits,true);assert.equal(m.kpis.length,3);assert.ok(m.attention.height>=44&&m.inbox.height>=44);
  assert.ok(m.attention.bottom<(m.nav?.top||height),'attention action is visible on the first screen');
  if(fixture!=='long-token'){
   assert.ok(m.footer.height<180,'stacked footer must not inherit a tall flex basis');
   if(width===1440){assert.ok(m.hero.height<500,'display identity does not consume excessive operating space');assert.ok(m.footer.bottom<height-40);assert.ok(Math.abs(m.metrics[0].top-m.metrics[2].top)<1,'desktop metrics share one row');}
   if(width===390&&locale==='en')assert.ok(m.inbox.bottom<m.nav.top,'primary Inbox action is visible on ordinary mobile');
  }
  const expected=await page.evaluate(()=>window.fixtureBusinesses()[0].name);assert.equal(m.name.toLocaleLowerCase(),expected.toLocaleLowerCase(),'the complete business name survives the existing display capitalization formatter');
  let reached=false;for(let step=0;step<40;step++){await page.keyboard.press('Tab');if(await page.locator('#overview .mission-status-indicator').evaluate(e=>e===document.activeElement)){reached=true;break;}}assert.equal(reached,true,'attention is reachable with native keyboard traversal');const focus=await page.locator('#overview .mission-status-indicator').evaluate(e=>getComputedStyle(e).outlineStyle);assert.equal(focus,'solid');await page.keyboard.press('Tab');assert.equal(await page.locator('#overview .home-business-heading button').evaluate(e=>e===document.activeElement),true,'Inbox follows attention in native keyboard order');await page.waitForTimeout(100);const revealed=await page.locator('#overview .home-business-heading button').evaluate(e=>{const r=e.getBoundingClientRect(),nav=document.querySelector('.mobile-bottom-nav');return {top:r.top,bottom:r.bottom,limit:nav&&nav.getClientRects().length?nav.getBoundingClientRect().top:innerHeight};});assert.ok(revealed.top>=0&&revealed.bottom<=revealed.limit,'Inbox remains reachable above navigation after focus reveal');evidence.layouts.push({width,height,locale,fixture,...m});
 }
 await page.setViewportSize({width:1440,height:720});
 for(const fixture of ['home-empty','home-partial','home-unavailable','home-loading','home-error']) {
  await load('en',fixture);const m=await measure();
  if(fixture==='home-empty')assert.deepEqual(m.kpis,['0','0','0']);
  if(fixture==='home-partial'){assert.deepEqual(m.kpis,['24','7','8,400 SEK + 160 EUR']);assert.match(await page.locator('#overview').innerText(),/partial/i);}
  if(fixture==='home-unavailable'){assert.ok(m.kpis.every(v=>v!=='0'&&v!=='24'&&v!=='7'));assert.match(await page.locator('#overview').innerText(),/unavailable/i);}
  if(fixture==='home-loading'||fixture==='home-error'){assert.equal(m.hero,null);assert.deepEqual(m.kpis,[]);assert.equal(await page.locator('.state-card').isVisible(),true);}
  assert.equal(m.overflow,false);evidence.states.push({fixture,...m});
 }
 await load('en','rich');assert.equal(await page.locator('.home-operational-status').innerText(),'2 unresolved issues. Review Needs attention below.');
 await load('en','health');assert.equal(await page.locator('.home-operational-status').innerText(),'Review integration health for the selected business.');
 await load('en','home-unavailable');assert.match(await page.locator('.home-operational-status').innerText(),/could not be loaded/);
 await load('en','rich');
 for(const [selector,target] of [['.home-business-heading button','inbox'],['.mission-status-indicator','settings'],['.home-workspace-actions button:first-child','bookings']]) {
  await primary('home');await page.locator('#overview '+selector).click();assert.equal(await page.locator('#workspace-'+target).isVisible(),true);evidence.actions.push({selector,target});
 }
 await primary('home');await page.locator('#home-reports-trigger').click();assert.equal(await page.locator('#analytics').isVisible(),true);evidence.actions.push({target:'reports'});
 if(out)writeFileSync(resolve(out,'home-hero.json'),JSON.stringify(evidence,null,2));console.log('Home Hero: display identity, first-screen attention, truthful states, native focus, full names, desktop KPI row and existing actions PASS');
}
