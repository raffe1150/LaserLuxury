import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

// Run through the existing isolated fixture harness with --rc01. No manual
// scrolling or scrollIntoView is used by this test to reveal focused fields.
export async function runFocusVisibilityChecks({page,load,primary,open,out,profiles}) {
  const evidence={originalCases:[],walks:[],backToTop:[],focusReturn:[],safeArea:[],formControls:[]};
  const save=()=>{if(out)writeFileSync(resolve(out,'focus-visibility.json'),JSON.stringify(evidence,null,2));};
  const settled=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const geometry=()=>page.evaluate(()=>{
    const e=document.activeElement,r=e.getBoundingClientRect();
    const content=document.querySelector('.content'),c=content.getBoundingClientRect();
    const nav=document.querySelector('.mobile-bottom-nav'),n=nav.getClientRects().length?nav.getBoundingClientRect():null;
    const floating=document.querySelector('.scroll-to-top'),f=floating?.getClientRects().length?floating.getBoundingClientRect():null;
    const formControl=e.matches('input,select,textarea,button')&&!!e.closest('#workspace-ai-assistant');
    const blocked=f&&formControl&&r.left<f.right&&r.right>f.left;
    const top=Math.max(0,c.top),bottom=Math.min(innerHeight,c.bottom,n?.top??innerHeight,blocked?f.top:innerHeight);
    return {tag:e.tagName,id:e.id,label:[...(e.labels||[])].map(l=>l.textContent).join(' '),
      name:(e.textContent||e.getAttribute('aria-label')||'').trim().slice(0,80),
      top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height,usableTop:top,usableBottom:bottom,
      visibleHeight:Math.max(0,Math.min(r.bottom,bottom)-Math.max(r.top,top)),
      nav:n?{top:n.top,bottom:n.bottom,height:n.height}:null,
      floating:f?{top:f.top,bottom:f.bottom,left:f.left,right:f.right}:null,
      scrollTop:content.scrollTop,windowScroll:scrollY,hidden:!!e.closest('[hidden],[aria-hidden="true"]'),
      backToTop:e.matches('.scroll-to-top'),
      formControl,
      outline:getComputedStyle(e).outlineStyle,viewport:{width:innerWidth,height:innerHeight},
      overflow:document.documentElement.scrollWidth>innerWidth+1};
  });
  const assertRevealed=(r,context)=>{
    assert.equal(r.hidden,false,context+': no hidden workspace focus');
    assert.equal(r.overflow,false,context+': no page overflow');
    assert.ok(r.top>=r.usableTop+5,context+': field top and focus ring visible');
    assert.ok(r.bottom<=r.usableBottom-5,context+': field bottom above navigation/viewport/floating control');
    assert.ok(r.left>=0&&r.right<=r.viewport.width,context+': field horizontally visible');
    assert.notEqual(r.outline,'none',context+': focus is visible');
  };
  const prepare=async(locale,width,height)=>{
    await page.setViewportSize({width,height});await load(locale);await open('ai-assistant');
    await page.locator('#ai-advanced summary').click();
    await page.locator('#workspace-ai-assistant :is(h1,h2)').filter({visible:true}).first()
      .evaluate(e=>{e.tabIndex=-1;e.focus();});
  };
  const scrollPosition=()=>page.evaluate(()=>({content:document.querySelector('.content').scrollTop,window:scrollY}));
  const walk=async(steps,direction,entries,context)=>{
    for(let step=0;step<steps;step++) {
      const before=await scrollPosition();await page.keyboard.press(direction);await settled();
      const r=await geometry();
      assert.equal(r.hidden,false,context+': hidden content never receives focus');
      if(r.backToTop) {
        evidence.backToTop.push({context,step,direction,before,...r});save();
        assert.ok(r.bottom<=r.usableBottom-5,context+': Back-to-top focus ring clears navigation');
      }
      if(r.formControl) {
        evidence.formControls.push({context,step,direction,before,...r});
        assertRevealed(r,context+'/'+(r.label||r.name));
      }
      if(r.tag!=='TEXTAREA')continue;
      const entry={step,direction,before,...r};entries.push(entry);save();
    }
  };

  try {
    // Keep the original failing native-Tab positions explicit, so the test
    // fails against the pre-RC-01 shell/CSS rather than weakening the gate.
    for(const [locale,width,height,step,id]of [
      ['en',320,850,22,'custom-tone-instructions'],
      ['fa',320,850,22,'custom-tone-instructions'],
      ['fa',834,1194,9,''],
      ['fa',834,1194,25,'custom-assistant-instructions'],
    ]) {
      await prepare(locale,width,height);
      let before;
      for(let i=0;i<=step;i++) {before=await scrollPosition();await page.keyboard.press('Tab');await settled();}
      const r=await geometry();evidence.originalCases.push({locale,width,height,step,before,...r});save();
      if(out)await page.screenshot({path:resolve(out,`original-${locale}-${width}x${height}-tab-${step}.png`),animations:'disabled'});
      assert.equal(r.tag,'TEXTAREA','original case still reaches its textarea');assert.equal(r.id,id);
      assertRevealed(r,`${locale}/${width}/original Tab ${step}`);
    }

    const sizes=process.argv.includes('--rc01-smoke')?[[667,375],[834,500],[1024,500],[720,500]]:
      [...profiles,[667,375],[834,500],[1024,500],[720,500]];
    for(const locale of ['en','fa'])for(const [width,height]of sizes) {
      await prepare(locale,width,height);
      const values=await page.locator('#workspace-ai-assistant textarea').evaluateAll(es=>es.map(e=>e.value));
      const forward=[],backward=[];
      evidence.walks.push({locale,width,height,forward,backward});
      await walk(28,'Tab',forward,`${locale}/${width}x${height}/Tab`);
      await walk(28,'Shift+Tab',backward,`${locale}/${width}x${height}/Shift+Tab`);
      assert.equal(new Set(forward.map(r=>r.label)).size,3,'all three existing textareas reached');
      assert.equal(new Set(backward.map(r=>r.label)).size,3,'all three textareas reachable in reverse');
      assert.deepEqual(await page.locator('#workspace-ai-assistant textarea').evaluateAll(es=>es.map(e=>e.value)),values,'focus preserves exact values');
      assert.deepEqual(await page.evaluate(()=>window.fixtureCalls.filter(c=>/^(update|create|delete|send)/.test(c.method))),[],'focus/navigation creates no writes');
      save();
    }

    // Disclosure remains native, and its existing Custom edit focus works.
    await page.setViewportSize({width:375,height:850});await load();await open('ai-assistant');
    assert.equal(await page.locator('#ai-advanced').getAttribute('open'),null);
    await page.locator('#ai-advanced summary').focus();await page.keyboard.press('Enter');await settled();
    assert.equal(await page.locator('#custom-tone-instructions').isVisible(),true);
    await page.locator('#ai-advanced summary').focus();await page.keyboard.press('Enter');await settled();
    await page.keyboard.press('Tab');assert.equal(await page.locator('#prompt-editor').isVisible(),false);
    assert.equal((await geometry()).hidden,false);
    await primary('home');await page.locator('#home-reports-trigger').focus();await page.keyboard.press('Enter');
    await page.locator('#analytics-title').waitFor();assert.equal(await page.locator('#analytics-title').evaluate(e=>e===document.activeElement),true);
    await page.locator('.reports-back').focus();await page.keyboard.press('Enter');await settled();
    assert.equal(await page.locator('#home-reports-trigger').evaluate(e=>e===document.activeElement),true);
    evidence.focusReturn.push('Reports → Home restores its trigger');

    // Chromium's CSS env override exercises nonzero safe-area clearance; it
    // is emulation, not physical-device/software-keyboard certification.
    const cdp=await page.context().newCDPSession(page);
    try {
      await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets:{bottom:24}});
      for(const locale of ['en','fa'])for(const [width,height]of [[320,850],[375,850]]) {
        await prepare(locale,width,height);
        const entries=[];evidence.safeArea.push({locale,width,height,inset:24,entries});
        assert.equal(await page.locator('.content').evaluate(e=>getComputedStyle(e).scrollPaddingBlockEnd),'180px');
        await walk(28,'Tab',entries,`safe-area/${locale}/${width}`);
      }
    } finally {await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets:{}});await cdp.detach();}

    await page.emulateMedia({reducedMotion:'reduce'});await prepare('fa',320,850);
    const reduced=[];await walk(28,'Tab',reduced,'reduced motion');
    assert.equal((await geometry()).backToTop,true,'Back-to-top is reached by native Tab');
    await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelector('.content').scrollTop===0);
    evidence.focusReturn.push('Back-to-top Enter clears content scroll');
    const scrollBehavior=await page.locator('.content').evaluate(e=>getComputedStyle(e).scrollBehavior);
    assert.equal(scrollBehavior,'auto','reduced-motion reveal has no smooth scroll');
    await page.locator('.tone-custom-summary button').focus();await page.keyboard.press('Enter');await settled();
    assert.equal((await geometry()).id,'custom-tone-instructions','existing Custom edit focus retained');
    assertRevealed(await geometry(),'Custom edit focus');
    const field=page.locator('#custom-tone-instructions'),value=await field.inputValue();
    await page.keyboard.press('End');const caret=await field.evaluate(e=>e.selectionStart);
    await page.keyboard.press('Shift+Enter');
    assert.equal(await field.inputValue(),value.slice(0,caret)+'\n'+value.slice(caret),'textarea newline behavior unchanged');
    await page.keyboard.press('Backspace');assert.equal(await field.inputValue(),value);
    assert.deepEqual(await page.evaluate(()=>window.fixtureCalls.filter(c=>/^(update|create|delete|send)/.test(c.method))),[],'editing/focus never saves');
    await page.emulateMedia({reducedMotion:'no-preference'});
    console.log(`RC-01: ${evidence.originalCases.length} original cases; ${evidence.walks.length} forward/reverse profile walks; ${evidence.backToTop.length} Back-to-top checks.`);
  } finally {save();}
}
