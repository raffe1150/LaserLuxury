// Synthetic Inbox/Bookings checks inside the existing production-CSS fixture server.
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
export async function runInboxBookingsChecks({page,load,primary,before,out,measure,profiles}) {
 const capture=async(name)=>{if(out)await page.screenshot({path:resolve(out,name+'.png'),animations:'disabled'});};
 const noWrites=async()=>assert.deepEqual(await page.evaluate(()=>window.fixtureCalls.filter(c=>/^(update|create|delete|send)/.test(c.method))),[]);
 for(const [width,height] of before?profiles.filter(([w,h])=>[375,834,1440].includes(w)||(w===1024&&h===768)):profiles) {
  await page.setViewportSize({width,height});await load();await primary('inbox');await page.locator('.conversation-item').first().waitFor();await measure('inbox','en');await capture(`${width}x${height}-inbox-list`);
  await page.locator('.conversation-item').first().click();await page.locator('.conversation-reply-input:not([disabled])').waitFor();await measure('inbox-thread','en');if(!before)await verifyComposer(page,width,height);await capture(`${width}x${height}-inbox-thread`);
  if(await page.locator('.conversation-mobile-back').isVisible())await page.locator('.conversation-mobile-back').click();
  await primary('bookings');await page.locator('.booking-compact-row').first().waitFor();await measure('bookings','en');await capture(`${width}x${height}-bookings-list`);
  await page.locator('.booking-compact-row').first().click();await measure('booking-detail','en');if(!before)await verifyBookingDetail(page,width,height);await capture(`${width}x${height}-booking-detail`);await noWrites();
 }
 for(const locale of ['en','sv','de','es','fa','ar'])for(const [width,height] of before?[[375,850],[834,1194]]:profiles){
  await page.setViewportSize({width,height});await load(locale,'long-customer');await primary('inbox');await page.locator('.conversation-item').first().click();await page.locator('.conversation-reply-input:not([disabled])').waitFor();await measure('inbox-long-'+locale,locale);if(!before)await verifyComposer(page,width,height);if(width===375||width===834)await capture(`${width}-inbox-long-${locale}`);
  if(await page.locator('.conversation-mobile-back').isVisible())await page.locator('.conversation-mobile-back').click();await primary('bookings');await page.locator('.booking-compact-row').first().click();await measure('booking-long-'+locale,locale);if(!before)await verifyBookingDetail(page,width,height);if(width===375||width===834)await capture(`${width}-booking-long-${locale}`);
 }
 await page.setViewportSize({width:375,height:850});
 for(const fixture of ['inbox-empty','inbox-error','inbox-loading','thread-error','thread-loading','bookings-empty','bookings-error','bookings-loading']) {
  await load('en',fixture);const isInbox=fixture.startsWith('inbox')||fixture.startsWith('thread');await primary(isInbox?'inbox':'bookings');await page.waitForTimeout(150);
  if(fixture.startsWith('thread'))await page.locator('.conversation-item').first().click();await measure(fixture,'en');await capture('375-'+fixture);
 }
 await load();await primary('inbox');await page.locator('.conversation-item').first().click();await page.locator('.conversation-reply-input:not([disabled])').fill('A preserved draft');await page.evaluate(()=>window.failNextSend=true);await page.locator('.conversation-reply-actions button').click();await page.locator('.conversation-send-error').waitFor();await capture('375-send-error');
 if(!before)assert.equal(await page.locator('.conversation-reply-input').inputValue(),'A preserved draft');
 if(await page.locator('.conversation-mobile-back').isVisible())await page.locator('.conversation-mobile-back').click();
 await load();await primary('bookings');for(const view of ['pending','cancelled']){await page.locator('.booking-view-tabs button').filter({hasText:new RegExp('^'+view+'$','i')}).click();await page.locator('.booking-compact-row').first().waitFor();await measure('bookings-'+view,'en');await capture('375-bookings-'+view);}
 if(!before)await regressions({page,load,primary,capture,noWrites});

}

async function verifyComposer(page,width,height){
 for(const selector of ['.conversation-reply-input','.conversation-reply-actions button']){
  const bounds=await page.locator(selector).evaluate(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};});
  assert.ok(bounds.left>=-1&&bounds.right<=width+1&&bounds.top>=0&&bounds.bottom<=height+1,`composer visible ${width}x${height}: ${JSON.stringify(bounds)}`);
 }
 assert.equal(await page.locator('.conversation-reply-input').getAttribute('maxlength'),'4000');
 assert.ok(await page.locator('.conversation-reply-input').getAttribute('aria-describedby'));
 assert.equal(await page.locator('.conversation-reply-label').getAttribute('for'),await page.locator('.conversation-reply-input').getAttribute('id'));
 assert.equal(await page.locator('#conversations').evaluate(e=>e.classList.contains('conversation-single-pane')),await page.locator('#conversations').evaluate(e=>e.clientWidth<760||innerWidth<=768));
 if(width===820||width===834)assert.equal(await page.locator('.conversation-list').isVisible(),false);
 assert.equal(await page.locator('body').evaluate(e=>e.classList.contains('mobile-conversation-open')),width<=768);
 assert.equal(await page.locator('.chat-transcript').getAttribute('tabindex'),'0');
 if(width>=1024&&height<=850){const r=await page.locator('.chat-transcript').boundingBox();const longIdentity=(await page.locator('.conversation-detail-name').innerText()).length>80;assert.ok(r.height>=(longIdentity?24:110),`short landscape transcript remains locally usable (${width}x${height}, ${r.height}px, long identity: ${longIdentity})`);}
 for(const bubble of await page.locator('.transcript-bubble').all()){assert.equal(await bubble.getAttribute('dir'),'auto');assert.equal(await bubble.getAttribute('translate'),'no');}
}
async function verifyBookingDetail(page,width,height){
 const compact=await page.locator('#bookings').evaluate(e=>e.clientWidth<760);
 assert.equal(await page.locator('#bookings').evaluate(e=>e.classList.contains('booking-single-pane')),compact);
 assert.equal(await page.locator('.booking-results').isVisible(),!compact);
 assert.equal(await page.locator('.booking-detail').isVisible(),true);
 assert.equal(await page.locator('.booking-detail-head h3').getAttribute('dir'),'auto');
 if(compact){
  const back=page.locator('.booking-detail-back');const r=await back.boundingBox();const nav=await page.locator('.mobile-bottom-nav').isVisible()?await page.locator('.mobile-bottom-nav').boundingBox():null;
  assert.ok(r.y>=0&&r.y+r.height<= (nav?nav.y:height),`booking Back visible ${width}: ${JSON.stringify(r)}`);
  assert.equal(await back.evaluate(e=>e===document.activeElement),true,'opening detail focuses Back');
  await back.press('Enter');assert.equal(await page.locator('.booking-results').isVisible(),true);assert.equal(await page.locator('.booking-detail').isVisible(),false);await page.waitForFunction(()=>document.querySelector('.booking-compact-row.active')===document.activeElement);
  await page.locator('.booking-compact-row.active').press('Enter');
 }
}
async function regressions({page,load,primary,capture,noWrites}){
 await page.setViewportSize({width:1440,height:1000});await load();await primary('inbox');await page.locator('.conversation-item').first().click();await page.locator('.conversation-reply-input:not([disabled])').waitFor();
 const beforeCalls=await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='getConversationPage'||c.method==='getConversationThread').length);
 await page.locator('.conversation-reply-input').fill('Persistent draft');await primary('bookings');await primary('inbox');assert.equal(await page.locator('.conversation-reply-input').inputValue(),'Persistent draft');
 assert.equal(await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='getConversationPage'||c.method==='getConversationThread').length),beforeCalls,'navigation adds no Inbox request');await noWrites();
 const input=page.locator('.conversation-reply-input');await input.fill('first line');await input.press('Shift+Enter');await input.press('l');assert.equal(await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='sendConversationMessage').length),0);await input.press('Enter');await page.waitForFunction(()=>window.fixtureCalls.some(c=>c.method==='sendConversationMessage'));
 assert.deepEqual(await page.evaluate(()=>window.fixtureCalls.find(c=>c.method==='sendConversationMessage')),{method:'sendConversationMessage',id:'7',payload:'first line\nl'});
 await page.evaluate(()=>window.failNextSend=true);await input.fill('  Restored draft  ');await page.locator('.conversation-reply-actions button').click();await page.locator('.conversation-send-error').waitFor();assert.equal(await input.inputValue(),'Restored draft');assert.equal(await page.locator('.conversation-send-error').getAttribute('role'),'alert');await page.locator('.conversation-reply-actions button').click();await page.waitForFunction(()=>window.fixtureCalls.filter(c=>c.method==='sendConversationMessage').length===3);assert.equal(await input.inputValue(),'');
 await load();await primary('inbox');for(const [selector,index,key,expected]of [['.conversation-channel-tabs:not(.conversation-range-tabs):not(.conversation-status-tabs)',2,'channel','instagram'],['.conversation-range-tabs',2,'range','30d'],['.conversation-status-tabs',2,'status','booked']]){
  await page.locator(selector+' button').nth(index).click();await page.waitForFunction(({key,expected})=>window.fixtureCalls.filter(c=>c.method==='getConversationPage').at(-1)?.payload[key]===expected,{key,expected});assert.equal(await page.locator(selector+' button').nth(index).getAttribute('aria-pressed'),'true');
 }
 await page.locator('.dashboard-search').fill('NoMatches');await page.locator('.conversation-state').getByText('No conversations found',{exact:true}).waitFor();await capture('1440-inbox-filtered-empty');await noWrites();
 await load('en','workspace-pages');await primary('inbox');await page.locator('.conversation-load-more').click();await page.waitForFunction(()=>document.querySelectorAll('.conversation-item').length===12);assert.equal(new Set(await page.locator('.conversation-item').evaluateAll(es=>es.map(e=>e.textContent))).size,12);assert.ok((await page.locator('.conversation-toolbar-stats').innerText()).includes('loaded'));await noWrites();
 await primary('bookings');await page.locator('.booking-load-more').click();await page.waitForFunction(()=>document.querySelectorAll('.booking-compact-row').length===12);await page.locator('.booking-coverage-note').waitFor();
 const options=await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='getBookingPage').at(-1).payload);assert.deepEqual(options,{limit:25,cursor:6,view:'upcoming',search:'',timezone:'Europe/Stockholm'});await noWrites();
 await load();await primary('bookings');const labels=await page.locator('.booking-view-tabs button').allTextContents();assert.deepEqual(labels,['Upcoming','Pending','Past','Cancelled','All']);assert.equal(await page.locator('.booking-summary').getByText('Today',{exact:true}).count(),1);
 for(const [i,value]of ['upcoming','pending','past','cancelled','all'].entries()){await page.locator('.booking-view-tabs button').nth(i).click();await page.waitForFunction(value=>window.fixtureCalls.filter(c=>c.method==='getBookingPage').at(-1)?.payload.view===value,value);await page.locator('.booking-compact-row').first().waitFor();assert.equal(await page.locator('.booking-view-tabs button').nth(i).getAttribute('aria-pressed'),'true');}
 await noWrites();
 // Resizing and Back preserve selection/draft and never add data requests.
 await primary('inbox');await page.locator('.conversation-item').nth(1).click();await page.locator('.conversation-reply-input:not([disabled])').waitFor();await page.locator('.conversation-reply-input').fill('Resize draft');const name=await page.locator('.conversation-detail-name').innerText();const calls=await page.evaluate(()=>window.fixtureCalls.length);
 for(const [width,height]of [[834,1194],[1024,768],[375,850],[1440,1000]]){await page.setViewportSize({width,height});await page.waitForTimeout(60);assert.equal(await page.locator('.conversation-detail-name').innerText(),name);assert.equal(await page.locator('.conversation-reply-input').inputValue(),'Resize draft');await verifyComposer(page,width,height);}
 assert.equal(await page.evaluate(()=>window.fixtureCalls.length),calls,'resize adds no requests');
 await page.setViewportSize({width:375,height:850});await page.waitForTimeout(60);await page.keyboard.press('Escape');await page.waitForFunction(()=>document.querySelector('.conversation-item.active')===document.activeElement);await primary('settings');assert.equal(await page.locator('body').evaluate(e=>e.classList.contains('mobile-conversation-open')),false);
 await page.setViewportSize({width:1440,height:1000});await primary('bookings');await page.locator('.booking-compact-row').nth(1).click();const customer=await page.locator('.booking-detail-head h3').innerText();const bookCalls=await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='getBookingPage').length);
 for(const [width,height]of [[834,1194],[375,850],[1024,768],[1440,1000]]){await page.setViewportSize({width,height});await page.waitForTimeout(60);assert.equal(await page.locator('.booking-detail-head h3').innerText(),customer);assert.equal(await page.locator('.booking-detail').isVisible(),true);}
 assert.equal(await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='getBookingPage').length),bookCalls);await page.locator('.booking-detail-back').click();await page.waitForFunction(()=>document.activeElement?.classList.contains('booking-compact-row'));assert.equal(await page.locator('.booking-detail').count(),0,'desktop Close keeps its existing selection-clearing behavior');
 // Live locale changes update controls, not customer content or data requests.
 await load();await primary('inbox');await page.locator('.conversation-item').first().click();await page.locator('.conversation-reply-input:not([disabled])').waitFor();const message=await page.locator('.transcript-bubble').first().innerText();const customerName=await page.locator('.conversation-detail-name').innerText();const prior=await page.evaluate(()=>window.fixtureCalls.length);
 for(const locale of ['sv','de','es','fa','ar','en']){await page.locator('.dashboard-account summary').click();await page.locator('.dashboard-language-control select').selectOption(locale);await page.locator('.dashboard-account summary').click();assert.equal(await page.locator('.conversation-detail-name').innerText(),customerName);assert.equal(await page.locator('.transcript-bubble').first().innerText(),message);assert.equal(await page.locator('.dashboard-page').getAttribute('dir'),['fa','ar'].includes(locale)?'rtl':'ltr');assert.ok(!(await page.locator('.conversation-toolbar-stats').innerText()).includes('{count}'));}
 assert.equal(await page.evaluate(()=>window.fixtureCalls.length),prior,'locale switch adds no requests');
 // Resolve the old business's already-started list requests after the new scope loads.
 for(const [method,flag,destination]of [['getConversationPage','delayNextConversations','inbox'],['getBookingPage','delayNextBookings','bookings']]){
  await load('en','tenant-workspaces');await page.locator('.topbar-search select').selectOption('7');await page.locator('#overview').waitFor();await page.evaluate(flag=>window[flag]=true,flag);await primary(destination);await page.locator(destination==='inbox'?'.dashboard-search':'.booking-search').fill('deferred');await page.waitForFunction(method=>window.pendingWorkspacePages.some(p=>p.method===method),method);await page.locator('.topbar-search select').selectOption('8');await page.locator('#overview').waitFor();await primary(destination);await page.locator(destination==='inbox'?'.conversation-item':'.booking-compact-row').first().waitFor();await page.evaluate(()=>window.pendingWorkspacePages.splice(0).forEach(p=>p.resolve()));await page.waitForTimeout(60);
  const ids=await page.evaluate(method=>window.fixtureCalls.filter(c=>c.method===method).map(c=>c.id),method);assert.equal(ids.at(-1),'8');const dataText=await page.locator(destination==='inbox'?'.conversation-list':'.booking-results').innerText();assert.ok(dataText.includes('Tenant 8'));assert.ok(!dataText.includes('Tenant 7'),'late previous-business list cannot leak');await noWrites();
 }
}
