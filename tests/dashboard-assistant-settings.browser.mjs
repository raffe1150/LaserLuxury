// Real UI and production CSS; only synthetic, business-scoped API fixtures.
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
export async function runAssistantSettingsChecks({page,load,primary,open,before,out,measure,profiles}) {
 const capture=async(name,selector)=>{if(!out)return;if(selector)await page.locator(selector).scrollIntoViewIfNeeded();await page.screenshot({path:resolve(out,name+'.png'),animations:'disabled'});};
 const sample=([w,h])=>[375,834,1440].includes(w)||(w===1024&&h===768);
 if(process.argv.includes('--business-load-check')) {
  for(const [width,height]of profiles.filter(sample)) {
   await page.setViewportSize({width,height});await load('en','home-error');await primary('settings');
   await page.locator('.state-card.error').waitFor();assert.equal(await page.locator('#business-settings').count(),0,'failed business load cannot expose default-looking fields');
   await measure('business-load-error','en');await capture(`${width}x${height}-business-load-error`);
  }
  return;
 }
 for(const [width,height]of before?profiles.filter(sample):profiles){
  await page.setViewportSize({width,height});await load();await primary('ai-assistant');await page.locator('.knowledge-source-row').first().waitFor();await measure('ai-default','en');if(sample([width,height]))await capture(`${width}x${height}-ai-default`);
  await page.locator('#ai-advanced summary').click();await measure('ai-advanced','en');if(sample([width,height])){await capture(`${width}x${height}-ai-advanced`,'#tone-adjustments');await capture(`${width}x${height}-instructions`,'#prompt-editor');await capture(`${width}x${height}-knowledge`,'.knowledge-library-card');}
  await open('settings');await measure('settings','en');if(sample([width,height]))await capture(`${width}x${height}-settings`);
  await open('business');await measure('business','en');if(sample([width,height])){await capture(`${width}x${height}-business`,'#business-settings');await capture(`${width}x${height}-services`,'.business-services-card');await capture(`${width}x${height}-hours`,'.working-hours-target-card');await capture(`${width}x${height}-cancellation`,'#cancellation-settings');}
  await primary('settings');await page.locator('#settings-connections-trigger').click();await measure('connections','en');if(sample([width,height]))await capture(`${width}x${height}-connections`);
  await page.locator('.integration-card').filter({hasText:'Telegram'}).getByRole('button').first().click();await measure('provider-setup','en');if(!before)for(const button of await page.locator('.wizard-footer .btn').all())await reachable(page,button);if(sample([width,height]))await capture(`${width}x${height}-provider-setup`);
  await open('health');await measure('health','en');if(sample([width,height]))await capture(`${width}x${height}-health`);
  await open('notifications');await measure('issues','en');if(sample([width,height]))await capture(`${width}x${height}-issues`);
  await page.locator('.settings-secondary-nav:visible button').nth(1).click();await measure('alerts','en');if(sample([width,height]))await capture(`${width}x${height}-alerts`);
  if(!before) {
    for(const id of ['business','ai-assistant']) {
      await open(id);
      const labels=await page.locator(id==='business'?'#business-settings label[for]':'#ai-tone label[for]').evaluateAll(es=>es.map(e=>({target:e.htmlFor,exists:!!document.getElementById(e.htmlFor)})));
      assert.ok(labels.every(e=>e.exists),'labels target existing controls');
    }
    await open('business');
    const ids=await page.locator('#business-settings [id]').evaluateAll(es=>es.map(e=>e.id));assert.equal(new Set(ids).size,ids.length,'service/time controls have unique IDs');
    const actions=await page.locator('.working-hours-target-actions button').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect(),p=e.closest('.working-hours-target-day').getBoundingClientRect();return {left:r.left,right:r.right,parentLeft:p.left,parentRight:p.right};}));assert.ok(actions.every(r=>r.left>=r.parentLeft-1&&r.right<=r.parentRight+1),'copy/close touch targets fit within the day row');
    for(const input of await page.locator('#business-settings input[type="time"]').all()){const width=await input.evaluate(e=>e.getBoundingClientRect().width);assert.ok(width>=130,'native time field retains hours, minutes and picker width');assert.equal(await input.getAttribute('dir'),'ltr');}
    assert.equal(await page.locator('#business-settings form').count(),1);assert.equal(await page.locator('#business-settings button[type="submit"]').count(),2);
    for(const button of await page.locator('#business-settings button[type="submit"]').all())await reachable(page,button);
    await primary('ai-assistant');assert.equal(await page.locator('#ai-advanced').getAttribute('open'),'');await page.locator('#ai-advanced summary').click();assert.equal(await page.locator('#prompt-editor').isVisible(),false);
    assert.equal(await page.locator('.tone-preset-grid button[aria-pressed="true"] .tone-selected-mark').count(),1);
    await page.locator('#ai-advanced summary').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('#prompt-editor').isVisible(),true);
    for(const button of await page.locator('#ai-tone .save-row button, #tone-adjustments button[type="submit"], #prompt-editor .save-row button, #knowledge button[type="submit"]').all())await reachable(page,button);
    assert.equal(await page.locator('#custom-assistant-instructions').inputValue(),'  Saved prompt 7\nمرحبا <business> & rules.  ');
  }
  console.log(`ASSISTANT/SETTINGS ${width}x${height}`);
 }
 for(const locale of ['en','sv','de','es','fa','ar'])for(const [width,height]of before?[[375,850],[834,1194]]:profiles){
  await page.setViewportSize({width,height});await load(locale,'long-setup');await primary('ai-assistant');await page.locator('#ai-advanced summary').click();await measure('ai-expanded-'+locale,locale);if(width===375||width===834){await capture(`${width}-ai-${locale}`,'#tone-adjustments');await capture(`${width}-knowledge-long-${locale}`,'.knowledge-library-card');}await open('business');await measure('business-'+locale,locale);if(width===375||width===834)await capture(`${width}-business-${locale}`,'.business-services-card');
  await primary('settings');await page.locator('#settings-connections-trigger').click();await measure('connections-'+locale,locale);
  if(!before){await primary('ai-assistant');const source=page.locator('.knowledge-source-title');assert.equal(await source.innerText(),'Information '+('InternationalAppointments'.repeat(6)));assert.equal(await source.getAttribute('dir'),'auto');assert.equal(await source.getAttribute('translate'),'no');assert.equal(await source.evaluate(e=>e.scrollWidth<=e.clientWidth+1),true,'long source title wraps rather than clipping');}
  await open('health');await measure('health-'+locale,locale);await open('notifications');await measure('issues-'+locale,locale);await page.locator('.settings-secondary-nav:visible button').nth(1).click();await measure('alerts-'+locale,locale);
 }
 for(const [width,height]of profiles.filter(sample)){
  await page.setViewportSize({width,height});await load('en','visual-empty');await primary('ai-assistant');await measure('knowledge-empty','en');await capture(`${width}x${height}-knowledge-empty`,'#knowledge');
  await load('en','setup-error');await primary('ai-assistant');await page.locator('#knowledge-error').waitFor();await capture(`${width}x${height}-knowledge-error`,'#knowledge');
  if(!before){assert.equal(await page.locator('.knowledge-empty').count(),0,'failed Knowledge load is not an empty library');assert.equal(await page.locator('.knowledge-source-count').innerText(),'—\nsources');}
  await open('business');await capture(`${width}x${height}-cancellation-error`,'#cancellation-settings');if(!before){await page.locator('#cancellation-settings .settings-load-error').waitFor();assert.equal(await page.locator('#cancellation-settings form').count(),0);assert.equal(await page.locator('#cancellation-settings input[type="checkbox"]').count(),0);}
  await open('health');await capture(`${width}x${height}-health-error`);if(!before){await page.locator('.health-load-state').waitFor();assert.equal(await page.locator('.health-overall').count(),0,'failed health load cannot look healthy');}
  await open('notifications');await page.locator('.settings-secondary-nav:visible button').nth(1).click();await capture(`${width}x${height}-alerts-error`);if(!before){await page.locator('#admin-notifications .settings-load-error').waitFor();assert.equal(await page.locator('#admin-notifications form').count(),0);}
  await load('en','visual-loading');await primary('ai-assistant');await capture(`${width}x${height}-knowledge-loading`,'#knowledge');await open('business');await capture(`${width}x${height}-cancellation-loading`,'#cancellation-settings');await open('notifications');await page.locator('.settings-secondary-nav:visible button').nth(1).click();await capture(`${width}x${height}-alerts-loading`);
  await load();await primary('ai-assistant');await page.evaluate(()=>window.failNextBusinessUpdate=true);await page.locator('#ai-tone button[type="submit"]').click();await page.locator('#ai-style-error').waitFor();await capture(`${width}x${height}-style-save-error`);
  await page.locator('#ai-advanced summary').click();await page.evaluate(()=>window.failNextBusinessUpdate=true);await page.locator('#prompt-editor .save-row button').click();await page.locator('#custom-instructions-error').waitFor();await capture(`${width}x${height}-instructions-error`,'#prompt-editor');
 }
 if(!before){
  await page.setViewportSize({width:834,height:1194});await load();await primary('ai-assistant');const custom=await page.locator('#custom-tone-instructions').inputValue();const prompt=await page.locator('#custom-assistant-instructions').inputValue();
  await page.locator('.tone-preset-grid button').first().click();assert.equal(await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='updateBusiness').length),0);
  await page.locator('#ai-tone button[type="submit"]').click();await page.waitForFunction(()=>window.fixtureCalls.some(c=>c.method==='updateBusiness'));
  assert.deepEqual(await page.evaluate(()=>window.fixtureCalls.find(c=>c.method==='updateBusiness').payload),{toneConfig:{tonePreset:'professional',responseLength:'short',formality:'casual',emojiUsage:'light',customToneInstructions:custom}});
  assert.equal(await page.locator('#custom-assistant-instructions').inputValue(),prompt);
  await page.locator('#ai-advanced summary').click();await page.locator('#tone-adjustments button[type="submit"]').click();await page.waitForFunction(()=>window.fixtureCalls.filter(c=>c.method==='updateBusiness').length===2);
  const writes=await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='updateBusiness').map(c=>c.payload));assert.deepEqual(writes[0],writes[1],'lower Save style uses the same coordinator and tone object');
  await page.locator('#prompt-editor .save-row button').click();await page.waitForFunction(()=>window.fixtureCalls.filter(c=>c.method==='updateBusiness').length===3);assert.deepEqual(await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='updateBusiness').at(-1).payload),{systemPrompt:prompt});
 }
}
async function reachable(page,control){
 await control.scrollIntoViewIfNeeded();const box=await control.boundingBox();const nav=await page.locator('.mobile-bottom-nav').isVisible()?await page.locator('.mobile-bottom-nav').boundingBox():null;
 assert.ok(box.x>=0&&box.x+box.width<=page.viewportSize().width+1,'control fits horizontally');assert.ok(box.y>=0&&box.y+box.height<=(nav?nav.y:page.viewportSize().height)+1,'save is reachable above bottom navigation');assert.ok(box.height>=44,'44px touch target');
}
