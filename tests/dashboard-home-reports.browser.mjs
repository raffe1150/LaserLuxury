// Home/Reports presentation checks in the existing local, synthetic fixture server.
import assert from 'node:assert/strict';
import {resolve} from 'node:path';

export async function runHomeReportsChecks({page,load,primary,open,before,out,measure,profiles}) {
  const representative=new Set(['375x850','834x1194','1024x768','1440x1000']);
  const capture=async(name,preserveScroll=false)=>{if(!preserveScroll)await page.locator('.content').evaluate(e=>e.scrollTop=0);if(!preserveScroll)await page.locator('.analytics-table-scroll').evaluateAll(elements=>elements.forEach(e=>e.scrollLeft=0));if(out)await page.screenshot({path:resolve(out,name+'.png'),animations:'disabled'});};
  const counts=()=>page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='getBusinessAnalyticsSummary').length);
  const noWrites=async()=>assert.deepEqual(await page.evaluate(()=>window.fixtureCalls.filter(c=>/^(update|create|delete|send)/.test(c.method))),[]);
  const reach=async(selector)=>{
    await page.locator(selector).first().evaluate(e=>e.scrollIntoView({block:'center',behavior:'instant'}));
    const r=await page.locator(selector).first().evaluate(e=>{const r=e.getBoundingClientRect(),nav=document.querySelector('.mobile-bottom-nav');return {top:r.top,bottom:r.bottom,right:r.right,left:r.left,limit:nav.getClientRects().length?nav.getBoundingClientRect().top:innerHeight};});
    assert.ok(r.top>=0&&r.bottom<=r.limit+1&&r.left>=-1&&r.right<=page.viewportSize().width+1,`reachable ${selector}: ${JSON.stringify(r)}`);
  };
  const tableCheck=async()=>{
    const state=await page.locator('[role="table"]').evaluate(e=>({headers:[...e.querySelectorAll('[role="columnheader"]')].map(c=>c.textContent),rows:[...e.querySelectorAll('[role="row"]')].slice(1).map(r=>[...r.querySelectorAll('[role="cell"]')].map(c=>c.textContent))}));
    assert.equal(state.headers.length,5);assert.ok(state.rows.every(r=>r.length===5),'same five columns');
    if(!before){
      const region=page.locator('.analytics-table-scroll');assert.equal(await region.getAttribute('tabindex'),'0');assert.ok(await region.getAttribute('aria-label'));
      await reach('.analytics-table-scroll');await region.focus();
      const initial=await region.evaluate(e=>e.scrollLeft);await page.keyboard.press('ArrowRight');await page.waitForTimeout(180);
      const sizes=await region.evaluate(e=>({scroll:e.scrollWidth,width:e.clientWidth,left:e.scrollLeft}));
      if(sizes.scroll>sizes.width+1){assert.notEqual(sizes.left,initial,'keyboard scroll works');assert.equal(await page.locator('.analytics-scroll-hint').isVisible(),true,'local scroll has a visible instruction');}
      await region.evaluate(e=>e.scrollLeft=e.scrollWidth);
      const last=await region.locator('[role="columnheader"]').last().evaluate(e=>{const r=e.getBoundingClientRect(),p=e.closest('.analytics-table-scroll').getBoundingClientRect();return {right:r.right,left:r.left,pr:p.right,pl:p.left};});
      assert.ok(last.left>=last.pl-1&&last.right<=last.pr+1,'last column reachable locally');
    }
    return state;
  };
  if(process.argv.includes('--regressions-only')) profiles=[];
  if(process.argv.includes('--home-premium')) {await homePremium({page,load,primary,open,noWrites,measure});return;}
  if(process.argv.includes('--polish-regressions')) {await homeOperations({page,load,primary,open,noWrites,capture});return;}
  for(const [width,height] of before?profiles.filter(([w,h])=>representative.has(w+'x'+h)):profiles){
    await page.setViewportSize({width,height});await load();await open('home');
    const home=await page.locator('.hero-result-copy strong').allTextContents();assert.deepEqual(home,['24','7','8,400 SEK + 160 EUR']);
    if(!before)assert.deepEqual(await page.locator('.hero-result-item.accent .currency-bucket').allTextContents(),['8,400 SEK','160 EUR']);
    await measure('home','en');if(representative.has(width+'x'+height))await capture(`${width}x${height}-home`);
    const requests=await counts();await open('reports');await measure('reports','en');
    assert.deepEqual(await page.locator('.analytics-kpi-card strong').allTextContents(),['3','2','€50 + SEK\u00a0100'],'Reports intentionally differs from Home');
    if(!before)assert.deepEqual(await page.locator('.analytics-currency-value .currency-bucket').allTextContents(),['€50','SEK\u00a0100']);
    assert.equal(await counts(),requests,'opening Reports adds no request');
    assert.equal(await page.locator('.analytics-range button').nth(2).getAttribute('aria-pressed'),'true','default 30 days');
    if(representative.has(width+'x'+height))await capture(`${width}x${height}-reports-overview`);
    for(const [tab,index] of [['channels',1],['services',2]]){
      await page.locator('.analytics-tabs button').nth(index).click();await tableCheck();
      if([375,834,1440].includes(width)&&representative.has(width+'x'+height))await capture(`${width}x${height}-reports-${tab}`);
    }
    await page.locator('.analytics-range button').last().click();const dates=page.locator('.analytics-custom-range input');
    await dates.nth(0).fill('2026-09-01');await dates.nth(1).fill('2026-10-07');await page.locator('.analytics-kpi-card').first().waitFor();
    await measure('reports-custom','en');
    if(!before){for(const date of await dates.all()){assert.ok(await date.evaluate(e=>e.labels.length&&e.labels[0].textContent.trim()),'visible date label');}await reach('.analytics-custom-range input');await reach('.analytics-custom-range label:last-child input');}
    if([375,834,1024].includes(width)&&representative.has(width+'x'+height))await capture(`${width}x${height}-reports-custom`);
    await page.locator('.analytics-tabs button').nth(2).click();const tabRequests=await counts();
    await page.locator('.reports-back').click();if(!before){assert.equal(await page.locator('#home-reports-trigger').evaluate(e=>e===document.activeElement),true,'Back restores focus');
      const focus=await page.locator('#home-reports-trigger').evaluate(e=>{const r=e.getBoundingClientRect(),nav=document.querySelector('.mobile-bottom-nav');return {top:r.top,bottom:r.bottom,limit:nav.getClientRects().length?nav.getBoundingClientRect().top:innerHeight};});assert.ok(focus.top>=0&&focus.bottom<=focus.limit,'restored focus is visible above bottom navigation');}
    await page.locator('#home-reports-trigger').click();assert.equal(await dates.nth(0).inputValue(),'2026-09-01');assert.equal(await dates.nth(1).inputValue(),'2026-10-07');assert.equal(await page.locator('.analytics-tabs button').nth(2).getAttribute('aria-pressed'),'true');assert.equal(await counts(),tabRequests,'range/tab survive Home navigation without fetching');
    if(!before){assert.equal(await page.locator('#analytics-title').evaluate(e=>e===document.activeElement),true);await reach('.reports-back');}
    await noWrites();console.log(`${before?'BEFORE':'PASS'} Home/Reports ${width}x${height}`);
  }
  for(const locale of ['en','sv','de','es','fa','ar'])for(const [width,height] of before?[[375,850],[834,1194]]:profiles){
    await page.setViewportSize({width,height});await load(locale,locale==='ar'||locale==='fa'?'rtl-name-'+locale:'long-token');await measure('home',locale);await open('reports');
    await page.locator('.analytics-range button').last().click();const dates=page.locator('.analytics-custom-range input');await dates.nth(0).fill('2026-09-01');await dates.nth(1).fill('2026-10-07');await page.locator('.analytics-kpi-card').first().waitFor();await measure('reports-custom',locale);
    if(out&&[375,834].includes(width)&&['de','ar'].includes(locale))await capture(`${width}-${locale}-reports-custom`);
    if(!before){assert.equal(await page.locator('.analytics-currency-value .currency-bucket').count(),2,'each currency bucket isolated independently');await page.locator('.analytics-quality summary').click();await measure('reports-quality',locale);await noWrites();}
    if(!before){for(const [tab,index]of [['channels',1],['services',2]]){await page.locator('.analytics-tabs button').nth(index).click();await measure('reports-'+tab,locale);} }
    console.log(`${before?'BEFORE':'PASS'} localized Home/Reports ${locale} ${width}x${height}`);
  }
  for(const fixture of ['partial','partial-price','unavailable','empty','home-partial','home-unavailable','home-empty'])for(const [width,height]of [[375,850],[834,1194],[1024,768],[1440,1000]]){
    await page.setViewportSize({width,height});await load('en',fixture);
    if(fixture.startsWith('home-')){
      await measure(fixture,'en');if(!before&&fixture==='home-unavailable')assert.deepEqual(await page.locator('.hero-result-copy strong').allTextContents(),['—','—','—']);
      if(!before&&fixture==='home-empty')assert.deepEqual(await page.locator('.hero-result-copy strong').allTextContents(),['0','0','0'],'verified zeros remain zeros');
      if(out&&[375,834].includes(width))await capture(`${width}-${fixture}`);
    }else{
      await page.locator('#home-reports-trigger').click();await page.locator('.analytics-quality').waitFor();await measure('reports-'+fixture,'en');
      if(fixture==='partial')assert.equal(await page.locator('.analytics-kpi-card strong').first().textContent(),'—');
      if(fixture==='partial-price'){assert.equal(await page.locator('.analytics-kpi-card strong').last().textContent(),'€50 + SEK\u00a0100','partial currency buckets remain separate');if(!before){assert.ok(await page.locator('.analytics-kpi-card').last().evaluate(e=>e.classList.contains('caution')),'partial prices exercise the non-gold currency presentation');assert.match(await page.locator('.analytics-kpi-card small').last().textContent(),/2 of 3 bookings priced/);}}
      if(fixture==='unavailable')assert.equal(await page.locator('.analytics-kpi-card').count(),0,'unavailable is not zero');
      if(fixture==='empty'){await page.locator('.analytics-tabs button').nth(1).click();await page.locator('.analytics-table-empty').waitFor();}
      if(out&&[375,834].includes(width))await capture(`${width}-reports-${fixture}`);
      if(out&&fixture==='partial-price'){await reach('.analytics-kpi-card:last-child strong');await capture(`${width}-reports-partial-price-currency`,true);}
    }
    await noWrites();
  }
  for(const fixture of ['home-loading','home-error'])for(const [width,height]of [[375,850],[834,1194],[1440,1000]]) {
    await page.setViewportSize({width,height});await load('en',fixture);await measure(fixture,'en');
    if(!before){assert.equal(await page.locator('.hero-result-copy strong').count(),0,'loading/error never show zero metrics');assert.equal(await page.locator('.home-dashboard-state h1').count(),1);if(fixture==='home-error')assert.equal(await page.locator('.home-dashboard-state').getAttribute('role'),'alert');}
    await capture(`${width}-${fixture}`);await noWrites();
  }
  for(const [width,height]of [[375,850],[834,1194],[1440,1000]]) {
    await page.setViewportSize({width,height});await load('en','long-service');await open('reports');await page.locator('.analytics-tabs button').nth(2).click();await tableCheck();
    if(!before){const name=page.locator('.analytics-service-name strong').filter({hasText:'InternationalConsultation'});assert.ok((await name.textContent()).length>150);assert.equal(await name.getAttribute('translate'),'no');assert.equal(await name.evaluate(e=>e.scrollWidth<=e.clientWidth+1&&getComputedStyle(e).whiteSpace==='normal'),true,'complete long service name wraps without ellipsis');}
    await measure('reports-long-service','en');await capture(`${width}-reports-long-service`);
  }
  if(!before){
    await homeOperations({page,load,primary,open,noWrites,capture});
    const tabCopy={en:['Overview','Channels','Services'],sv:['Översikt','Kanaler','Tjänster'],de:['Übersicht','Kanäle','Dienstleistungen'],es:['Resumen','Canales','Servicios'],fa:['نمای کلی','کانال‌ها','خدمات'],ar:['نظرة عامة','القنوات','الخدمات']};
    await load();await open('reports');const localeRequests=await counts();
    for(const locale of ['sv','de','es','fa','ar','en']){
      await page.locator('.dashboard-account summary').click();await page.locator('.dashboard-account-panel select').selectOption(locale);await page.locator('.dashboard-account summary').click();
      assert.deepEqual(await page.locator('.analytics-tabs button').allTextContents(),tabCopy[locale],'live tab labels follow current locale');
      assert.equal(await counts(),localeRequests,'locale switching adds no analytics request');
      assert.deepEqual(await page.locator('.analytics-currency-value .currency-bucket').allTextContents(),[new Intl.NumberFormat(locale,{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(50),new Intl.NumberFormat(locale,{style:'currency',currency:'SEK',maximumFractionDigits:0}).format(100)],'each exact locale-formatted bucket retained in original order');
    }
    await page.setViewportSize({width:375,height:850});await load();await page.evaluate(()=>window.failNextAnalytics=true);await open('reports');await page.locator('.analytics-range button').first().click();await page.locator('.analytics-state.error').waitFor();await measure('reports-error','en');await capture('375-reports-error');await page.locator('.analytics-state button').click();await page.locator('.analytics-kpi-card').first().waitFor();
    await page.evaluate(()=>window.delayNextAnalytics=true);await page.locator('.analytics-range button').nth(1).click();await page.locator('.analytics-loading').waitFor();await capture('375-reports-loading');
    await page.locator('.dashboard-account summary').click();const selector=page.locator('.topbar-search select');await selector.selectOption('8');await page.locator('#overview').waitFor();await page.evaluate(()=>window.pendingAnalytics[0].resolve());await open('reports');assert.deepEqual(await page.locator('.analytics-kpi-card strong').allTextContents(),['5','2','€50 + SEK\u00a0800'],'late old tenant response cannot replace new business');await noWrites();
  }
}

async function homeOperations({page,load,primary,open,noWrites,capture}) {
 await page.setViewportSize({width:1440,height:1000});await load();
 await page.locator('.home-booking-list li').first().waitFor();
 assert.equal(await page.locator('.hero-result-item').count(),3,'only the three existing truthful metrics');
 assert.equal(await page.locator('.home-attention .home-issue').count(),3);
 assert.equal(await page.locator('.home-channel').count(),5);
 assert.equal(await page.locator('.home-booking-list li').count(),3);
 assert.doesNotMatch(await page.locator('#overview').innerText(),/\d+%|time saved|growth|sparkline/i,'Home invents no trend or time-saved metric');
 const calls=await page.evaluate(()=>window.fixtureCalls.length);await primary('settings');await primary('home');
 assert.equal(await page.evaluate(()=>window.fixtureCalls.length),calls,'Home reuses mounted workspace data without another request');
 for(const fixture of ['home-preview-loading','home-preview-error','home-preview-empty','home-preview-partial','home-preview-partial-empty']) {
  await load('en',fixture);const cards=page.locator('.home-operations');await cards.waitFor();
  if(fixture.endsWith('loading')) {await cards.getByText('Loading your overview…',{exact:true}).first().waitFor();assert.equal(await cards.locator('li').count(),0);}
  if(fixture.endsWith('error')) {await cards.locator('.unavailable').first().waitFor();assert.equal(await cards.locator('li').count(),0);assert.equal(await cards.getByText('No upcoming bookings',{exact:true}).count(),0,'failed preview cannot look empty');}
  if(fixture==='home-preview-partial-empty') {await cards.getByText('No upcoming bookings in loaded results.',{exact:true}).waitFor();assert.equal(await cards.getByText('No upcoming bookings',{exact:true}).count(),0,'partial empty is never a complete zero claim');}
  if(fixture==='home-preview-empty') {await cards.getByText('No upcoming bookings',{exact:true}).waitFor();assert.equal(await cards.locator('.home-issue').count(),0);assert.equal(await cards.locator('.home-channel.connected').count(),5);assert.equal(await cards.getByText('Connect a channel',{exact:true}).count(),0,'configured business gets no generic setup checklist');}
  if(fixture.endsWith('partial')) {await cards.getByText('Showing loaded results. Open the workspace for full details.',{exact:true}).first().waitFor();assert.ok(await cards.locator('.home-preview-hint').count()>=2);assert.ok((await cards.innerText()).includes('Last known status'),'cached health is explicit');}
  await capture(fixture);await noWrites();
 }
 await load('en','tenant-workspaces');await page.locator('.home-booking-list li').first().waitFor();assert.match(await page.locator('.home-booking-list').innerText(),/Tenant 7/);
 await page.locator('.topbar-search select').selectOption('8');await page.locator('#overview').waitFor();await page.locator('.home-booking-list').getByText('Tenant 8 customer 0',{exact:true}).waitFor();
 assert.doesNotMatch(await page.locator('.home-booking-list').innerText(),/Tenant 7/,'Home preview never exposes previous business');
 await page.locator('.topbar-search select').selectOption('7');await page.locator('#overview').waitFor();await page.locator('.home-booking-list').getByText('Tenant 7 customer 0',{exact:true}).waitFor();
 await noWrites();
}

// Home-only finishing pass: test actual geometry/data/actions rather than color tokens.
async function homePremium({page,load,primary,open,noWrites,measure}) {
 for(const [width,height,locale] of [[1440,1000,'en'],[834,1194,'sv'],[1024,600,'es'],[720,500,'en'],[390,844,'en'],[320,568,'en'],[375,850,'de'],[320,568,'de'],[390,844,'fa'],[320,568,'fa'],[430,932,'ar'],[320,568,'ar']]) {
  await page.setViewportSize({width,height});await load(locale);await page.locator('.home-booking-list li').first().waitFor();
  assert.equal(await page.locator('.hero-result-item').count(),3,'only existing three metrics');
  const geometry=await page.locator('.hero-result-item').evaluateAll(es=>es.map(e=>{const icon=e.querySelector('.hero-result-icon').getBoundingClientRect(),label=e.querySelector('.hero-result-copy > span'),range=document.createRange();range.selectNodeContents(label);const rtl=getComputedStyle(e).direction==='rtl';return {clear:icon.width===0||[...range.getClientRects()].every(r=>rtl?r.left>=icon.right-1:r.right<=icon.left+1),overflow:e.scrollWidth>e.clientWidth+1,value:e.querySelector('strong').textContent,icon:{left:icon.left,right:icon.right,top:icon.top,bottom:icon.bottom},lines:[...range.getClientRects()].map(r=>({left:r.left,right:r.right,top:r.top,bottom:r.bottom})),padding:getComputedStyle(label).paddingInlineEnd,wrap:getComputedStyle(label).overflowWrap};}));
  assert.ok(geometry.every(g=>g.clear),'translated KPI labels clear their icons: '+locale+' '+width+' '+JSON.stringify(geometry));
  assert.ok(geometry.every(g=>!g.overflow),'metric cards contain long labels/currencies');
  if(locale==='en')assert.deepEqual(geometry.map(g=>g.value),['24','7','8,400 SEK + 160 EUR'],'canonical KPI values unchanged');
  const action=page.locator('.home-business-heading .btn');await action.focus();
  const focus=await action.evaluate(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e),nav=document.querySelector('.mobile-bottom-nav');return {height:r.height,bottom:r.bottom,limit:nav.getClientRects().length?nav.getBoundingClientRect().top:innerHeight,outline:s.outlineStyle,width:parseFloat(s.outlineWidth)};});
  assert.ok(focus.height>=44&&focus.bottom<=focus.limit+1,'primary Home action is reachable above navigation');assert.notEqual(focus.outline,'none');assert.ok(focus.width>=2);
  await measure('home-premium',locale);await noWrites();
 }
 await page.setViewportSize({width:1440,height:1000});await load();
 const beforeCalls=await page.evaluate(()=>window.fixtureCalls.length);await page.locator('.home-business-heading .btn').click();assert.equal(await page.locator('#conversations').isVisible(),true);
 await primary('home');await page.locator('.home-workspace-actions .btn').first().click();assert.equal(await page.locator('#bookings').isVisible(),true);
 await primary('home');await page.locator('#home-reports-trigger').click();assert.equal(await page.locator('#analytics-title').isVisible(),true);await page.locator('.reports-back').click();
 assert.equal(await page.locator('#home-reports-trigger').evaluate(e=>e===document.activeElement),true,'Reports returns focus to the existing Home action');
 await page.locator('.mission-status-indicator').click();assert.equal(await page.locator('#notification-center').isVisible(),true);
 await primary('home');await page.locator('.home-attention header .btn').click();assert.equal(await page.locator('#notification-center').isVisible(),true);
 await primary('home');await page.locator('.home-connections-heading .btn').click();assert.equal(await page.locator('#health').isVisible(),true);
 await primary('home');await page.locator('.home-upcoming header .btn').click();assert.equal(await page.locator('#bookings').isVisible(),true);await primary('home');
 assert.equal(await page.evaluate(()=>window.fixtureCalls.length),beforeCalls,'Home actions reuse mounted data');
 for(const fixture of ['home-empty','home-unavailable','home-partial','home-loading','home-error'])for(const [width,height] of [[320,568],[390,844],[1440,1000]]){
  await page.setViewportSize({width,height});await load('en',fixture);const values=await page.locator('.hero-result-copy strong').allTextContents();
  if(fixture==='home-empty')assert.deepEqual(values,['0','0','0']);
  if(fixture==='home-unavailable')assert.deepEqual(values,['—','—','—']);
  if(['home-loading','home-error'].includes(fixture))assert.deepEqual(values,[],'loading/error is never a fabricated zero');
  if(fixture==='home-partial')assert.match(await page.locator('#overview').innerText(),/Partial|partial|loaded/i,'quality disclosure stays visible');
  await measure('premium-'+fixture,'en');await noWrites();
 }
 console.log('Home premium: 12 locale/profile layouts; existing KPI values, 7 action routes, focus return, icon clearance, zero/loading/error/unavailable/partial and no extra requests passed.');
}
