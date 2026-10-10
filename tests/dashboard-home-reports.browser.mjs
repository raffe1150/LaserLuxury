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
