// Runs inside the existing isolated visual fixture server (including production CSS).
// node tests/dashboard-visual.browser.mjs [playwright] [evidence] --phase2 [--before]
import assert from 'node:assert/strict';
import {resolve} from 'node:path';

export async function runTabletDialogChecks({page,load,primary,open,before,out,measurements}) {
  const profiles=[[320,850],[375,850],[390,844],[430,932],[768,1024],[820,1180],[834,1194],[1024,1366],[1024,768],[1180,820],[1194,834],[1366,1024],[1280,900],[1440,1000]];
  const capture=async(name)=>{if(out)await page.screenshot({path:resolve(out,name+'.png'),animations:'disabled'});};
  const noWrites=async()=>assert.deepEqual(await page.evaluate(()=>window.fixtureCalls.filter(c=>/^(update|create|delete|send)/.test(c.method))),[]);
  const bounds=async(selector)=>page.locator(selector).evaluate(e=>{
    const r=e.getBoundingClientRect(),clips=[];
    for(let p=e.parentElement;p;p=p.parentElement){const style=getComputedStyle(p),b=p.getBoundingClientRect();
      if((/hidden|clip|auto|scroll/.test(style.overflowX)&&(r.left<b.left-1||r.right>b.right+1))||(/hidden|clip|auto|scroll/.test(style.overflowY)&&(r.top<b.top-1||r.bottom>b.bottom+1)))clips.push(p.id||p.className);
      // Existing mobile threads are viewport-fixed and escape the list card's overflow.
      if(style.position==='fixed')break;
    }
    return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,clips};
  });
  const keyboardContained=async(dialog)=>{
    for(let i=0;i<16;i++){
      await page.keyboard.press('Tab');
      assert.equal(await dialog.evaluate(e=>e.contains(document.activeElement)),true,'forward Tab stays in dialog');
    }
    for(let i=0;i<12;i++){
      await page.keyboard.press('Shift+Tab');
      assert.equal(await dialog.evaluate(e=>e.contains(document.activeElement)),true,'reverse Tab stays in dialog');
    }
    await page.locator('.dashboard-account summary').evaluate(e=>e.focus());
    assert.equal(await dialog.evaluate(e=>e.contains(document.activeElement)),true,'background cannot take focus');
  };
  for(const [width,height] of process.argv.includes('--extended-only')?[]:profiles) {
    await page.setViewportSize({width,height});await load();await primary('inbox');
    await page.locator('.conversation-item').first().click();await page.locator('.conversation-reply-input:not([disabled])').waitFor();
    await page.locator('.conversation-reply-input').fill('Unsent tablet draft');
    await page.locator('.content').evaluate(e=>e.scrollTop=0);
    const textarea=await bounds('.conversation-reply-input'),send=await bounds('.conversation-reply-actions button');
    const panel=await bounds('#conversations');
    const state=await page.evaluate(()=>({width:innerWidth,pageWidth:document.documentElement.scrollWidth,contentScroll:document.querySelector('.content').scrollTop,
      single:document.querySelector('#conversations').classList.contains('conversation-single-pane'),lock:document.body.classList.contains('mobile-conversation-open'),
      hiddenList:document.querySelector('.conversation-list').hidden,nav:[...document.querySelectorAll('.sidebar-nav a')].map(e=>e.getAttribute('href')),
      mobileNav:[...document.querySelectorAll('.mobile-nav-item')].map(e=>e.getAttribute('href'))}));
    measurements.push({id:'inbox-thread',profile:{width,height},textarea,send,panel,...state});
    if(!before) {
      for(const r of [textarea,send]){assert.ok(r.x>=0&&r.right<=width+1&&r.y>=0&&r.bottom<=height+1,`composer fits ${width}x${height}: ${JSON.stringify(r)}`);assert.deepEqual(r.clips,[],'no clipping ancestor');}
      assert.ok(state.pageWidth<=width+1,'no page overflow');assert.equal(state.contentScroll,0,'composer does not require outer scrolling');
      if(width===820||width===834)assert.equal(state.single,true,'narrow tablet uses one pane');
      if(width>=1024)assert.equal(state.single,false,'wide workspace retains split view');
      assert.equal(state.lock,width<=768,'only full-screen mobile thread locks body');
      const destinations=['home','inbox','bookings','ai-assistant','settings'].map(id=>'#workspace-'+id);
      assert.deepEqual(state.nav,destinations);assert.deepEqual(state.mobileNav,destinations);
      assert.equal(await page.locator('.conversation-reply-input').getAttribute('maxlength'),'4000');
      if(state.single){await page.locator('.conversation-mobile-back').click();assert.equal(await page.locator('.conversation-list').isVisible(),true);
        assert.equal(await page.locator('.conversation-detail').isVisible(),false);await page.locator('.conversation-item').first().click();assert.equal(await page.locator('.conversation-reply-input').inputValue(),'Unsent tablet draft');}
      await noWrites();
    }
    if([375,820,834,1024,1180,1440].includes(width))await capture(`${width}x${height}-inbox`);
    if(width<=768)await page.locator('.conversation-mobile-back').click();
    if(!before){
      // A hidden mounted thread is not focusable; leaving Inbox clears mobile body lock.
      await primary('settings').catch(async()=>{
        await page.locator('.conversation-mobile-back').click();await primary('settings');
      });
      assert.equal(await page.locator('body').evaluate(e=>e.classList.contains('mobile-conversation-open')),false);
      assert.equal(await page.locator('#conversations').isVisible(),false);
    }
    await open('settings');
    const cards=await page.locator('.settings-index-item').evaluateAll(es=>es.map(e=>({width:e.clientWidth,text:e.querySelector('h3').textContent,buttonY:e.querySelector('button').getBoundingClientRect().bottom})));
    if(!before){assert.equal(cards.length,3);for(const c of cards)assert.ok(c.width>=230,'Settings cards are readable');}
    if(width===834){await capture('834-settings');await page.locator('#settings-connections-trigger').click();await page.locator('.integration-card').first().waitFor();
      const providers=await page.locator('.integration-card').evaluateAll(es=>es.map(e=>({width:e.clientWidth,title:e.querySelector('h3').textContent})));
      measurements.push({id:'connections',profile:{width,height},providers});
      if(!before){assert.equal(providers.length,5);for(const c of providers)assert.ok(c.width>=290,'provider cards are not squeezed');}
      await capture('834-connections');}
    // Named, contained dialogs at every size. Account remains open beneath the native modal.
    await page.locator('.dashboard-account summary').click();
    const addTrigger=page.locator('.dashboard-account-panel button').filter({hasText:'Add Business'});
    await addTrigger.click();const add=page.getByRole('dialog');await add.waitFor();
    const addState=await add.evaluate(e=>({name:e.getAttribute('aria-labelledby'),focusInside:e.contains(document.activeElement),fieldLabels:[...e.querySelectorAll('input,select')].map(c=>({id:c.id,labels:c.labels.length})),width:e.getBoundingClientRect().width}));
    measurements.push({id:'add-dialog',profile:{width,height},...addState});
    if(!before){assert.equal(await page.getByRole('dialog',{name:'Add Business'}).count(),1);assert.equal(addState.focusInside,true);assert.ok(addState.fieldLabels.every(f=>f.id&&f.labels===1));
      assert.ok(addState.width<=width);assert.equal(await page.getByRole('dialog').getByLabel('Timezone',{exact:true}).getAttribute('dir'),'ltr');await keyboardContained(add);}
    if([375,834,1440].includes(width))await capture(`${width}-add-dialog`);
    if(before)await add.getByRole('button',{name:'Cancel',exact:true}).click();else {
      await page.keyboard.press('Escape');await add.waitFor({state:'hidden'});assert.equal(await addTrigger.evaluate(e=>e===document.activeElement),true,'focus returns to Add invoker');await noWrites();
      await addTrigger.click();await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
      assert.equal(await addTrigger.evaluate(e=>e===document.activeElement),true,'explicit Close returns focus');
    }
    if(await page.locator('.dashboard-account').getAttribute('open')===null)await page.locator('.dashboard-account summary').click();
    await page.locator('.dashboard-account-panel button').filter({hasText:'Manage Businesses'}).click();
    const deleteTrigger=page.locator('.biz-row .btn-danger').first();await deleteTrigger.click();const del=page.getByRole('dialog');await del.waitFor();
    if(!before){assert.equal(await page.getByRole('dialog',{name:'Delete Business'}).count(),1);assert.equal(await del.evaluate(e=>e.contains(document.activeElement)),true);
      assert.equal(await del.getByRole('button',{name:'Cancel',exact:true}).evaluate(e=>e===document.activeElement),true,'safe initial focus');await keyboardContained(del);
      assert.equal(await del.locator('strong').textContent(),'Admotion Studio — Advanced Beauty & Wellness Stockholm');assert.equal(await del.locator('strong').getAttribute('translate'),'no');}
    if([375,834,1440].includes(width))await capture(`${width}-delete-dialog`);
    if(before)await del.getByRole('button',{name:'Cancel',exact:true}).click();else {await page.keyboard.press('Escape');await del.waitFor({state:'hidden'});assert.equal(await deleteTrigger.evaluate(e=>e===document.activeElement),true);await noWrites();}
    console.log(`${before?'BEFORE':'PASS'} tablet/dialog ${width}x${height}`);
  }
  // Changing the locale on an already open destination must update the title itself.
  for(const locale of process.argv.includes('--extended-only')?[]:['sv','de','es','fa','ar']) {
    await page.setViewportSize({width:834,height:1194});await load();
    for(const destination of ['inbox','settings','ai-assistant']) {
      await primary(destination);await page.locator('.dashboard-account summary').click();
      await page.locator('.dashboard-language-control select').selectOption(locale);
      await page.waitForTimeout(50);
      const navText=await page.locator(`.sidebar-nav [href="#workspace-${destination}"] span`).textContent();
      const title=await page.locator('.topbar-title').textContent();
      const active=await page.locator('.sidebar-nav [aria-current]').getAttribute('href');
      measurements.push({id:'locale-title',locale,destination,title,navText,active});
      if(!before){assert.equal(title,navText,'title follows current destination/current locale');assert.equal(await page.locator('.sidebar-user-name').textContent(),'Admotion Studio — Advanced Beauty & Wellness Stockholm');}
      await capture(`834-${destination}-${locale}`);
      await page.locator('.dashboard-account summary').click();
    }
    if(!before) {
      await open('reports');assert.equal(await page.locator('.topbar-title').textContent(),await page.locator('#analytics-title').textContent());
      assert.equal(await page.locator('.sidebar-nav [aria-current]').getAttribute('href'),'#workspace-home');
      await open('business');assert.equal(await page.locator('.topbar-title').textContent(),await page.locator('.settings-index-item h3').first().textContent());
      await open('health');assert.equal(await page.locator('.topbar-title').textContent(),await page.locator('#connection-health-title').textContent());
      await noWrites();
    }
    if(['fa','ar'].includes(locale)){
      await page.locator('.dashboard-account summary').click();await page.locator('.dashboard-language-control select').selectOption(locale);
      await page.locator('.dashboard-account-panel button').nth(1).click();await page.getByRole('dialog').waitFor();
      if(!before){assert.equal(await page.getByRole('dialog').evaluate(e=>getComputedStyle(e).direction),'rtl');await keyboardContained(page.getByRole('dialog'));}
      await capture(`834-add-dialog-${locale}`);
      if(before)await page.getByRole('dialog').locator('.save-row button').first().click();else await page.keyboard.press('Escape');
      if(!before){
        await page.locator('.dashboard-account-panel button').first().click();await page.locator('.biz-row .btn-danger').first().click();
        const del=page.getByRole('dialog');assert.equal(await del.evaluate(e=>getComputedStyle(e).direction),'rtl');await keyboardContained(del);
        assert.equal(await del.locator('strong').textContent(),'Admotion Studio — Advanced Beauty & Wellness Stockholm');
        await capture(`834-delete-dialog-${locale}`);await page.keyboard.press('Escape');
        await primary('inbox');await page.locator('.conversation-item').nth(2).click();
        assert.equal(await page.locator('.conversation-detail-name').textContent(),'لیلا احمدی');
        assert.equal(await page.locator('.conversation-detail-name').getAttribute('dir'),'auto');
        assert.equal(await page.locator('.conversation-mobile-back svg').evaluate(e=>getComputedStyle(e).transform),'matrix(-1, 0, 0, 1, 0, 0)');
        const send=await bounds('.conversation-reply-actions button');assert.ok(send.x>=0&&send.right<=834);
        await capture(`834-inbox-thread-${locale}`);await primary('settings');await page.locator('#settings-connections-trigger').click();
        assert.ok((await page.locator('.integration-card-icon img').evaluateAll(es=>es.map(e=>getComputedStyle(e).transform))).every(t=>t==='none'),'provider logos never mirror');
        await noWrites();
      }
    }
  }
  if(!before) {
    await page.setViewportSize({width:1440,height:1000});await load();await primary('inbox');
    await page.locator('.conversation-item').nth(1).click();
    const identity=await page.locator('.conversation-detail-name').textContent();
    await page.waitForFunction(()=>window.fixtureCalls.filter(c=>c.method==='getConversationThread').length===2);
    await page.locator('.conversation-reply-input:not([disabled])').fill('Keep this draft during resize');
    for(const [width,height] of [[834,1194],[1024,768],[820,1180],[375,850],[1180,820]]) {
      await page.setViewportSize({width,height});
      await page.waitForFunction(()=>document.querySelector('#conversations').classList.contains('conversation-single-pane')===(innerWidth<1024)&&document.body.classList.contains('mobile-conversation-open')===(innerWidth<=768));
      assert.equal(await page.locator('.conversation-reply-input').inputValue(),'Keep this draft during resize');
      assert.equal(await page.locator('.conversation-detail-name').textContent(),identity);
      assert.equal(await page.locator('body').evaluate(e=>e.classList.contains('mobile-conversation-open')),width<=768);
    }
    await primary('settings');await primary('inbox');
    measurements.push({id:'draft-navigation',identity:await page.locator('.conversation-detail-name').textContent(),draft:await page.locator('.conversation-reply-input').inputValue(),calls:await page.evaluate(()=>window.fixtureCalls)});
    assert.equal(await page.locator('.conversation-reply-input').inputValue(),'Keep this draft during resize','navigation retains draft');
    await noWrites();
    // The existing filtering and send contract is exercised, not replaced by layout code.
    await page.locator('.conversation-channel-tabs').first().locator('button').nth(1).click();
    await page.waitForFunction(()=>window.fixtureCalls.some(c=>c.method==='getConversationPage'&&c.payload.channel==='whatsapp'));
    await page.locator('.conversation-range-tabs').getByRole('button',{name:'30 days',exact:true}).click();
    await page.waitForFunction(()=>window.fixtureCalls.some(c=>c.method==='getConversationPage'&&c.payload.channel==='whatsapp'&&c.payload.range==='30d'));
    await page.locator('.conversation-status-tabs').getByRole('button',{name:'Booked',exact:true}).click();
    await page.waitForFunction(()=>window.fixtureCalls.some(c=>c.method==='getConversationPage'&&c.payload.status==='booked'));
    await page.getByRole('textbox',{name:'Search conversations'}).fill('Sofia');
    try { await page.waitForFunction(()=>window.fixtureCalls.some(c=>c.method==='getConversationPage'&&c.payload.search==='Sofia'&&c.payload.channel==='whatsapp'&&c.payload.range==='30d'&&c.payload.status==='booked')); }
    catch(error){measurements.push({id:'filters-failure',calls:await page.evaluate(()=>window.fixtureCalls)});throw error;}
    await page.locator('.conversation-item').first().click();
    const reply=page.locator('.conversation-reply-input');await reply.fill('Hello fixture owner');
    await page.locator('.conversation-reply-actions button').click();
    await page.waitForFunction(()=>window.fixtureCalls.some(c=>c.method==='sendConversationMessage'));
    assert.equal(await reply.inputValue(),'');
    const sent=await page.evaluate(()=>window.fixtureCalls.find(c=>c.method==='sendConversationMessage'));
    assert.equal(sent.id,'7');assert.equal(sent.payload,'Hello fixture owner');
    await page.locator('.chat-transcript').getByText('Hello fixture owner',{exact:true}).waitFor();
    await page.evaluate(()=>window.failNextSend=true);await reply.fill('Retry this reply');await reply.press('Enter');
    await page.locator('.conversation-send-error').waitFor();assert.equal(await reply.inputValue(),'Retry this reply');
    await page.locator('.conversation-reply-actions button').click();await page.locator('.conversation-send-error').waitFor({state:'hidden'});
    const sendCount=await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='sendConversationMessage').length);
    await reply.fill('Line one');await reply.press('Shift+Enter');assert.equal(await reply.inputValue(),'Line one\n');
    assert.equal(await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='sendConversationMessage').length),sendCount,'Shift+Enter never sends');
    await reply.press('Enter');await page.waitForFunction(count=>window.fixtureCalls.filter(c=>c.method==='sendConversationMessage').length===count+1,sendCount);
    // An old tenant's delayed thread must never replace the new tenant's thread.
    await load('en','tenant-threads');await primary('inbox');await page.locator('.conversation-item').first().click();
    await page.evaluate(()=>window.delayNextThread=true);await page.locator('.conversation-item').nth(1).click();
    await page.waitForFunction(()=>window.pendingThreads.length===1);
    await page.locator('.topbar-search select').selectOption('8');await page.locator('#overview').waitFor({state:'visible'});
    assert.equal(await page.locator('.sidebar-nav [aria-current]').getAttribute('href'),'#workspace-home');
    await primary('inbox');await page.locator('.conversation-item').first().click();await page.getByText(/^Tenant 8 ·/).first().waitFor();
    await page.evaluate(()=>window.pendingThreads.shift().resolve());await page.waitForTimeout(50);
    assert.equal(await page.getByText(/^Tenant 7 ·/).count(),0,'old thread cannot leak');await noWrites();
    // Pending mutations cannot be dismissed or submitted twice. All calls use fixture APIs.
    await page.setViewportSize({width:375,height:850});await load();
    await page.locator('.dashboard-account summary').click();await page.locator('.dashboard-account-panel button').nth(1).click();
    await page.getByRole('dialog').getByLabel('Business Name',{exact:true}).fill('A safe fixture business');
    await page.getByRole('dialog').getByLabel('Business Type',{exact:true}).fill('Studio');
    await page.getByRole('dialog').getByLabel('Timezone',{exact:true}).fill('Australia/Sydney');
    await page.getByRole('dialog').getByLabel('Language',{exact:true}).selectOption('de');
    await page.evaluate(()=>window.delayedBusinessMethods=['createBusiness']);
    await page.getByRole('dialog').getByRole('button',{name:'Create Business',exact:true}).click();
    await page.waitForFunction(()=>window.pendingBusinessOperations.length===1);await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').isVisible(),true);assert.equal(await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).isDisabled(),true);
    const create=await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='createBusiness'));
    assert.equal(create.length,1);assert.deepEqual(create[0].id,{name:'A safe fixture business',industry:'Studio',timezone:'Australia/Sydney',language:'de'},'creation payload remains unchanged');
    await page.evaluate(()=>window.pendingBusinessOperations.shift().resolve());await page.waitForFunction(()=>document.querySelector('.topbar-search select').value==='9'&&!document.querySelector('dialog'));
    await page.locator('#overview').waitFor({state:'visible'});
    assert.equal(await page.locator('.topbar-search select').inputValue(),'9');assert.equal(await page.getByRole('dialog').count(),0);
    await page.locator('.dashboard-account summary').click();await page.locator('.dashboard-account-panel button').first().click();
    const row=page.locator('.biz-row').filter({hasText:'A safe fixture business'});await row.locator('.btn-danger').click();
    await page.evaluate(()=>window.delayedBusinessMethods=['deleteBusiness']);await page.getByRole('dialog').getByRole('button',{name:'Delete Business',exact:true}).click();
    await page.waitForFunction(()=>window.pendingBusinessOperations.length===1);await page.keyboard.press('Escape');await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('dialog').isVisible(),true);assert.equal(await page.getByRole('dialog').evaluate(e=>e.contains(document.activeElement)),true);
    assert.equal(await page.getByRole('dialog').getByRole('button',{name:'Delete Business',exact:true}).isDisabled(),true);
    assert.deepEqual(await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='deleteBusiness').map(c=>c.id)),['9']);
    await page.evaluate(()=>window.pendingBusinessOperations.shift().resolve());await page.getByRole('dialog').waitFor({state:'hidden'});
    await page.locator('#overview').waitFor({state:'visible'});
    assert.equal(await page.evaluate(()=>document.activeElement.matches('.dashboard-account summary, #workspace-home')),true,'a tenant reset may focus Home; a removed invoker never leaves focus trapped');
    // Zero-business create/cancel is accessible and performs no writes.
    await load('en','zero');
    const zero=page.getByRole('button',{name:'Create business',exact:true});await zero.click();await page.keyboard.press('Escape');
    assert.equal(await zero.evaluate(e=>e===document.activeElement),true);await noWrites();
    console.log('PASS resize/drafts, filters, send/retry/Enter, tenant guards, pending dialogs, exact CRUD payloads and zero-business focus');
  }
  if(!before) {
    // Phase 7: inspect focused filter buttons, including legacy overflow ancestors.
    for(const locale of ['en','sv','de','es','fa','ar']) for(const width of [320,834]) {
      await page.setViewportSize({width,height:1194});await load(locale);await primary('inbox');await page.locator('.dashboard-search').focus();
      const count=await page.locator('.conversation-channel-tab').count();
      for(let i=0;i<count;i++) {
        await page.keyboard.press('Tab');await page.waitForTimeout(40);
        const r=await page.evaluate(()=>{const e=document.activeElement,b=e.getBoundingClientRect();return {button:e.classList.contains('conversation-channel-tab'),left:b.left,right:b.right};});
        assert.equal(r.button,true,'filter is keyboard reachable');assert.ok(r.left>=-1&&r.right<=width+1,'focused filter fully visible in '+locale+' / '+width);
      }
      await noWrites();
    }
    // Short workspaces reuse single-pane mode; Back retains filters and the draft.
    for(const locale of ['en','de','fa','ar']) for(const [width,height] of [[834,500],[1024,500],[834,600],[1024,600]]) {
      await page.setViewportSize({width,height});await load(locale,'long-customer');await primary('inbox');await page.locator('.conversation-item').first().click();await page.locator('.conversation-reply-input:not([disabled])').waitFor();await page.locator('.conversation-reply-input').fill('Short-height draft');
      for(const selector of ['.conversation-reply-input','.conversation-reply-actions button']) {
        const b=await bounds(selector);assert.ok(b.y>=0&&b.bottom<=height+1,'short-height composer fits');assert.deepEqual(b.clips,[],'short-height composer has no clipping ancestor');
      }
      assert.equal(await page.locator('.conversation-filters').isVisible(),false);
      assert.equal(await page.locator('.conversation-detail-head').getAttribute('tabindex'),'0');
      await page.locator('.conversation-mobile-back').click();assert.equal(await page.locator('.conversation-filters').isVisible(),true);await page.locator('.conversation-item').first().click();assert.equal(await page.locator('.conversation-reply-input').inputValue(),'Short-height draft');await noWrites();
    }
    await page.setViewportSize({width:834,height:1194});await load();await open('health');await page.evaluate(()=>window.delayNextDashboard=true);await page.getByRole('button',{name:'Check now',exact:true}).first().click();await open('notifications');await page.getByRole('button',{name:'Back to Settings',exact:true}).click();
    await page.waitForFunction(()=>window.pendingDashboard.length===1);await page.evaluate(()=>window.pendingDashboard.shift().resolve());await page.locator('.settings-index').waitFor();assert.equal(await page.evaluate(()=>document.activeElement.id),'settings-notifications-trigger','background refresh retains Back focus');
    console.log('PASS Phase 7 focused filters in six locales; short-height/long-name composer, header scrolling and retained drafts');
  }
}
