import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

// Independent expected copy; the browser exercises the real panel and shared
// i18n provider through the existing mock-API / production-CSS fixture.
export const knowledgeInterfaceCopy = {
  en: ['sources', 'Add knowledge', 'Use manual text for policies, FAQs, procedures and other business information.', 'Manual text', 'Title', 'Content', 'Example: Cancellation policy', 'Write the information the assistant should know...'],
  sv: ['källor', 'Lägg till information', 'Använd manuell text för policyer, vanliga frågor, rutiner och annan verksamhetsinformation.', 'Manuell text', 'Rubrik', 'Innehåll', 'Exempel: Avbokningspolicy', 'Ange informationen som assistenten behöver känna till...'],
  de: ['Quellen', 'Information hinzufügen', 'Nutze manuelle Texte für Richtlinien, häufige Fragen, Abläufe und weitere Unternehmensinformationen.', 'Manueller Text', 'Titel', 'Inhalt', 'Beispiel: Stornierungsrichtlinie', 'Gib die Informationen ein, die der Assistent kennen sollte...'],
  es: ['fuentes', 'Añadir información', 'Usa texto manual para políticas, preguntas frecuentes, procedimientos y otra información del negocio.', 'Texto manual', 'Título', 'Contenido', 'Ej.: Política de cancelación', 'Escribe la información que el asistente debe conocer...'],
  fa: ['منابع', 'افزودن اطلاعات', 'برای سیاست‌ها، پرسش‌های متداول، رویه‌ها و سایر اطلاعات کسب‌وکار، متن را دستی وارد کنید.', 'متن دستی', 'عنوان', 'محتوا', 'مثال: سیاست لغو', 'اطلاعاتی را که دستیار باید بداند بنویسید...'],
  ar: ['مصادر', 'إضافة معلومات', 'أدخل نصًا يدويًا للسياسات والأسئلة الشائعة والإجراءات ومعلومات النشاط الأخرى.', 'نص يدوي', 'العنوان', 'المحتوى', 'مثال: سياسة الإلغاء', 'اكتب المعلومات التي ينبغي أن يعرفها المساعد...'],
};

export async function runKnowledgeLocalizationChecks({page,load,primary,before,out}) {
  const evidence={renders:[],behavior:[],widthCorrection:[],errors:[]};
  const save=()=>{if(out)writeFileSync(resolve(out,'knowledge-localization.json'),JSON.stringify(evidence,null,2));};
  const writes=()=>page.evaluate(()=>window.fixtureCalls.filter(c=>/^(update|create|delete|send)/.test(c.method)));
  const values=()=>page.locator('#knowledge').evaluate(panel=>{
    const fields=panel.querySelectorAll('.knowledge-field');
    return [panel.querySelector('.knowledge-source-count span').textContent,
      panel.querySelector('.knowledge-create-card h3').textContent,
      panel.querySelector('.knowledge-create-card .knowledge-card-heading p').textContent,
      panel.querySelector('.knowledge-create-card .knowledge-type-badge').textContent,
      fields[0].querySelector('span').textContent,fields[1].querySelector('span').textContent,
      fields[0].querySelector('input').placeholder,fields[1].querySelector('textarea').placeholder];
  });
  const checkCopy=async(locale)=>{
    const actual=await values();assert.deepEqual(actual,knowledgeInterfaceCopy[locale],locale+': exact eight DOM translations');
    if(locale!=='en')actual.forEach((value,i)=>assert.notEqual(value,knowledgeInterfaceCopy.en[i],locale+': no English fallback'));
    assert.equal(await page.locator('.knowledge-create-card button[type="submit"]').innerText(),knowledgeInterfaceCopy[locale][1]);
    assert.deepEqual(await page.locator('.knowledge-source-meta>span:first-child').allTextContents(),[knowledgeInterfaceCopy[locale][3]]);
  };
  try {
    for(const locale of Object.keys(knowledgeInterfaceCopy))for(const [width,height]of [[320,850],[390,844],[834,1194],[1440,1000]]) {
      await page.setViewportSize({width,height});await load(locale);await primary('ai-assistant');
      await page.locator('.knowledge-source-row').first().waitFor();
      const copy=await values();
      const geometry=await page.locator('#knowledge').evaluate(panel=>{
        const elements=[...panel.querySelectorAll('.knowledge-source-count span,.knowledge-source-meta>span:first-child,.knowledge-card-heading h3,.knowledge-card-heading p,.knowledge-type-badge,.knowledge-field>span,input,textarea,button')];
        const clips=elements.flatMap(e=>{
          const range=document.createRange();range.selectNodeContents(e);
          const fragments=[...range.getClientRects()].filter(r=>r.width>0);const problems=[];
          for(let ancestor=e;ancestor;ancestor=ancestor.parentElement){const s=getComputedStyle(ancestor),r=ancestor.getBoundingClientRect();if(/hidden|clip|auto|scroll/.test(s.overflowX)&&fragments.some(f=>f.left<r.left-1||f.right>r.right+1))problems.push(ancestor.id||ancestor.className);}
          const r=e.getBoundingClientRect();if(r.left<0||r.right>innerWidth+1||e.scrollWidth>e.clientWidth+1)problems.push('intrinsic/viewport width');
          return problems.length?[{text:e.textContent,problems}]:[];
        });
        const input=panel.querySelector('input'),s=getComputedStyle(input),canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');ctx.font=s.font;
        return {clips,pageOverflow:document.documentElement.scrollWidth>innerWidth+1,
          exampleWidth:ctx.measureText(input.placeholder).width,exampleSpace:input.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight),
          direction:getComputedStyle(panel).direction,labelDirection:getComputedStyle(panel.querySelector('.knowledge-field>span')).direction,
          textareaDir:panel.querySelector('textarea').getAttribute('dir'),textareaTranslate:panel.querySelector('textarea').getAttribute('translate')};
      });
      evidence.renders.push({locale,width,height,copy,...geometry});save();
      if(!before) {
        await checkCopy(locale);assert.deepEqual(geometry.clips,[],locale+'/'+width+': no clipping ancestor or intrinsic overflow');
        assert.equal(geometry.pageOverflow,false);assert.ok(geometry.exampleWidth<=geometry.exampleSpace+1,locale+': cancellation example fits');
        assert.equal(geometry.direction,['fa','ar'].includes(locale)?'rtl':'ltr');assert.equal(geometry.labelDirection,geometry.direction);
        assert.equal(geometry.textareaDir,'auto');assert.equal(geometry.textareaTranslate,'no');
        assert.deepEqual(await writes(),[],'locale/navigation causes no writes');
      }
      await page.locator('.knowledge-create-card textarea').focus();
      await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
      const focused=await page.locator('.knowledge-create-card textarea').evaluate(e=>{
        const r=e.getBoundingClientRect(),c=e.closest('.content').getBoundingClientRect();
        const nav=document.querySelector('.mobile-bottom-nav'),n=nav.getClientRects().length?nav.getBoundingClientRect():null;
        const floating=document.querySelector('.scroll-to-top')?.getBoundingClientRect();
        return {top:r.top,bottom:r.bottom,usableTop:c.top,
          usableBottom:Math.min(innerHeight,c.bottom,n?.top??innerHeight,
            floating&&r.left<floating.right&&r.right>floating.left?floating.top:innerHeight)};
      });
      evidence.renders.at(-1).focused=focused;save();
      if(!before){assert.ok(focused.top>=focused.usableTop+5);assert.ok(focused.bottom<=focused.usableBottom-5,'translated Knowledge field/focus ring clears fixed navigation');}
      if(out)await page.screenshot({path:resolve(out,`${before?'before':'after'}-${locale}-${width}x${height}.png`),animations:'disabled'});
    }
    if(before)return;

    // Isolate the small translated-count width defect without changing data.
    await page.setViewportSize({width:834,height:1194});await load('de');await primary('ai-assistant');
    await page.locator('.knowledge-source-row').first().waitFor();
    const countBounds=()=>page.locator('.knowledge-source-count').evaluate(e=>({
      badge:e.getBoundingClientRect().width,client:e.querySelector('span').clientWidth,
      scroll:e.querySelector('span').scrollWidth,text:e.querySelector('span').textContent,
    }));
    const oldWidth=await page.addStyleTag({content:'.dashboard-page .knowledge-source-count { flex-shrink: 1; min-inline-size: 78px; }'});
    const oldCount=await countBounds();await oldWidth.evaluate(e=>e.remove());const newCount=await countBounds();
    evidence.widthCorrection.push({before:oldCount,after:newCount});save();
    assert.ok(oldCount.scroll>oldCount.client+1,'old width reproduces the German label overflow');
    assert.ok(newCount.scroll<=newCount.client+1,'natural badge width contains the full label');

    // Locale changes preserve draft/source bytes and never save implicitly.
    await load();await primary('ai-assistant');
    const title='  Customer title / سیاست لغو 123  ',content='  Customer content\nالمعلومات 13:00 + SEK 100\n  ';
    const input=page.locator('.knowledge-create-card input'),textarea=page.locator('.knowledge-create-card textarea');
    const original=await page.locator('.knowledge-source-title').innerText();
    await input.fill(title);await textarea.fill(content);
    for(const locale of Object.keys(knowledgeInterfaceCopy)) {
      await page.locator('.dashboard-account summary').click();await page.locator('.dashboard-language-control select').selectOption(locale);
      await page.locator('.dashboard-account summary').click();await checkCopy(locale);
      assert.equal(await input.inputValue(),title);assert.equal(await textarea.inputValue(),content);
      assert.equal(await page.locator('.knowledge-source-title').innerText(),original);assert.deepEqual(await writes(),[]);
    }
    const businessId=await page.locator('.topbar-search select').inputValue();
    await page.locator('.knowledge-create-card button[type="submit"]').click();
    const created=page.locator('.knowledge-source-row').filter({has:page.locator('.knowledge-source-title',{hasText:title.trim()})});
    await created.waitFor();assert.equal(await input.inputValue(),'');assert.equal(await textarea.inputValue(),'');
    assert.deepEqual(await writes(),[{method:'createKnowledgeSource',id:businessId,payload:{title:title.trim(),content:content.trim()}}]);
    evidence.behavior.push('Explicit create uses the unchanged business ID and trimmed title/content payload; locale changes preserve draft/source bytes.');
    const canceled=async d=>d.dismiss();page.once('dialog',canceled);await created.locator('.knowledge-delete-button').click();
    assert.equal((await writes()).length,1,'cancel delete never mutates');
    page.once('dialog',async d=>{assert.ok(d.message().includes(title.trim()),'confirmation names the exact source');await d.accept();});
    await created.locator('.knowledge-delete-button').click();await created.waitFor({state:'detached'});
    const operations=await writes();assert.equal(operations.length,2);assert.deepEqual(operations[1],{method:'deleteKnowledgeSource',id:businessId,payload:'created-1'});
    evidence.behavior.push('Delete confirmation/cancel and exact scoped source ID remain unchanged.');
    for(const fixture of ['visual-empty','setup-error']) {
      await load('fa',fixture);await primary('ai-assistant');
      await page.locator(fixture==='setup-error'?'#knowledge-error':'.knowledge-empty').waitFor();
      assert.equal(await page.locator('.knowledge-empty').count(),fixture==='setup-error'?0:1);
      assert.deepEqual(await writes(),[]);
    }
    evidence.behavior.push('Error remains distinct from confirmed empty; neither performs writes.');
    console.log(`RC-02: ${evidence.renders.length} locale/profile renders; 192 exact-copy checks; scoped create/delete and draft preservation pass.`);
  } catch(error) {evidence.errors.push(String(error));throw error;} finally {save();}
}

export const knowledgeRemainingCopy = {
  en: ['Knowledge library', 'Information currently available to this business AI.', 'Loading...', 'Refresh', 'No Knowledge added yet', 'Add your first business policy, FAQ or procedure using the form.', 'Delete "{title}" from Knowledge?'],
  sv: ['Informationsbibliotek', 'Information som för närvarande är tillgänglig för företagets AI.', 'Laddar...', 'Uppdatera', 'Ingen information har lagts till än', 'Lägg till företagets första policy, vanliga frågor eller rutin med hjälp av formuläret.', 'Ta bort "{title}" från informationsbiblioteket?'],
  de: ['Wissensbibliothek', 'Informationen, die der KI deines Unternehmens derzeit zur Verfügung stehen.', 'Wird geladen...', 'Aktualisieren', 'Noch keine Informationen hinzugefügt', 'Füge über das Formular die erste Richtlinie, häufige Fragen oder einen Ablauf deines Unternehmens hinzu.', '"{title}" aus der Wissensbibliothek löschen?'],
  es: ['Biblioteca de información', 'Información disponible actualmente para la IA de tu negocio.', 'Cargando...', 'Actualizar', 'Aún no se ha añadido información', 'Usa el formulario para añadir la primera política, preguntas frecuentes o procedimiento de tu negocio.', '¿Eliminar "{title}" de la biblioteca de información?'],
  fa: ['کتابخانه اطلاعات', 'اطلاعاتی که در حال حاضر در اختیار هوش مصنوعی کسب‌وکار شماست.', 'در حال بارگیری...', 'بازخوانی', 'هنوز اطلاعاتی اضافه نشده است', 'با استفاده از فرم، اولین سیاست، پرسش‌های متداول یا رویه کسب‌وکارتان را اضافه کنید.', 'آیا "{title}" از کتابخانه اطلاعات حذف شود؟'],
  ar: ['مكتبة المعلومات', 'المعلومات المتاحة حاليًا للذكاء الاصطناعي الخاص بنشاطك التجاري.', 'جارٍ التحميل...', 'تحديث', 'لم تُضف أي معلومات بعد', 'استخدم النموذج لإضافة أول سياسة أو أسئلة شائعة أو إجراء لنشاطك التجاري.', 'هل تريد حذف "{title}" من مكتبة المعلومات؟'],
};

export const knowledgeLocalErrorCopy = {
  en: ['Could not load Knowledge sources', 'Could not add Knowledge', 'Could not delete Knowledge'],
  sv: ['Kunde inte läsa in informationskällorna', 'Kunde inte lägga till informationen', 'Kunde inte ta bort informationen'],
  de: ['Die Informationsquellen konnten nicht geladen werden', 'Die Informationen konnten nicht hinzugefügt werden', 'Die Informationen konnten nicht gelöscht werden'],
  es: ['No se pudieron cargar las fuentes de información', 'No se pudo añadir la información', 'No se pudo eliminar la información'],
  fa: ['بارگیری منابع اطلاعات ممکن نشد', 'افزودن اطلاعات ممکن نشد', 'حذف اطلاعات ممکن نشد'],
  ar: ['تعذر تحميل مصادر المعلومات', 'تعذرت إضافة المعلومات', 'تعذر حذف المعلومات'],
};

export async function runRemainingKnowledgeLocalizationChecks({page,load,primary,before,out}) {
  const evidence={renders:[],localErrors:[],errors:[]};
  const save=()=>{if(out)writeFileSync(resolve(out,'knowledge-remaining-localization.json'),JSON.stringify(evidence,null,2));};
  const calls=method=>page.evaluate(m=>window.fixtureCalls.filter(c=>c.method===m),method);
  const writes=()=>page.evaluate(()=>window.fixtureCalls.filter(c=>/^(update|create|delete|send)/.test(c.method)));
  const measure=async()=>page.locator('#knowledge').evaluate(panel=>{
    const selectors='.knowledge-library-card .knowledge-card-heading h3,.knowledge-library-card .knowledge-card-heading p,.knowledge-refresh-button,.knowledge-empty,.knowledge-empty strong,.knowledge-empty span';
    const clips=[...panel.querySelectorAll(selectors)].flatMap(e=>{
      const range=document.createRange();range.selectNodeContents(e);const fragments=[...range.getClientRects()].filter(r=>r.width>0);const problems=[];
      for(let a=e;a;a=a.parentElement){const s=getComputedStyle(a),r=a.getBoundingClientRect();if(/hidden|clip|auto|scroll/.test(s.overflowX)&&fragments.some(f=>f.left<r.left-1||f.right>r.right+1))problems.push(a.id||a.className);}
      const r=e.getBoundingClientRect();if(r.left<-1||r.right>innerWidth+1||e.scrollWidth>e.clientWidth+1)problems.push('intrinsic/viewport');
      return problems.length?[{text:e.textContent,problems}]:[];
    });
    return {clips,pageOverflow:document.documentElement.scrollWidth>innerWidth+1,direction:getComputedStyle(panel).direction};
  });
  try {
    const profiles=before?[[390,844]]:[[320,850],[390,844],[834,1194],[1440,1000]];
    for(const locale of Object.keys(knowledgeRemainingCopy))for(const [width,height]of profiles) {
      const expected=knowledgeRemainingCopy[locale];await page.setViewportSize({width,height});await load(locale);await primary('ai-assistant');
      const panel=page.locator('#knowledge'),refresh=panel.locator('.knowledge-refresh-button');
      await panel.locator('.knowledge-source-row').waitFor();await panel.locator('.knowledge-refresh-button:not([disabled])').waitFor();
      const title=await panel.locator('.knowledge-source-title').innerText(),businessId=await page.locator('.topbar-search select').inputValue();
      const rendered=[await panel.locator('.knowledge-library-card h3').innerText(),await panel.locator('.knowledge-library-card .knowledge-card-heading p').innerText(),null,await refresh.innerText()];
      const row={locale,width,height,populated:await measure(),rendered};evidence.renders.push(row);save();
      if(!before){assert.deepEqual(rendered.filter(v=>v!==null),[expected[0],expected[1],expected[3]]);assert.deepEqual(row.populated.clips,[]);assert.equal(row.populated.pageOverflow,false);assert.equal(row.populated.direction,['fa','ar'].includes(locale)?'rtl':'ltr');}
      assert.deepEqual(await writes(),[],'navigation causes no writes');
      if(out)await page.screenshot({path:resolve(out,`${before?'before':'after'}-${locale}-${width}-populated.png`),animations:'disabled'});
      let message;page.once('dialog',async d=>{message=d.message();await d.dismiss();});
      await panel.locator('.knowledge-delete-button').click();row.confirmation=message;save();
      if(!before)assert.equal(message,expected[6].replace('{title}',()=>title));
      assert.deepEqual(await calls('deleteKnowledgeSource'),[],'cancel confirmation never deletes');
      page.once('dialog',async d=>{assert.equal(d.message(),message);await d.accept();});
      await panel.locator('.knowledge-delete-button').click();await panel.locator('.knowledge-source-row').waitFor({state:'detached'});
      assert.deepEqual(await calls('deleteKnowledgeSource'),[{method:'deleteKnowledgeSource',id:businessId,payload:'source-'+businessId}]);
      rendered[4]=await panel.locator('.knowledge-empty strong').innerText();rendered[5]=await panel.locator('.knowledge-empty span').innerText();row.empty=await measure();save();
      if(!before){assert.deepEqual(rendered.slice(4),expected.slice(4,6));assert.deepEqual(row.empty.clips,[]);assert.equal(row.empty.pageOverflow,false);}
      if(out)await page.screenshot({path:resolve(out,`${before?'before':'after'}-${locale}-${width}-empty.png`),animations:'disabled'});
      const readsBefore=(await calls('getKnowledgeSources')).length;
      await page.evaluate(()=>{window.delayNextKnowledge=true;});await refresh.click();
      await page.waitForFunction(()=>window.pendingKnowledge.length===1);
      rendered[2]=await refresh.innerText();row.loadingText=await panel.locator('.knowledge-empty').innerText();row.loading=await measure();save();
      if(!before){assert.equal(rendered[2],expected[2]);if(locale==='en')assert.equal(row.loadingText,'Loading Knowledge...');else assert.notEqual(row.loadingText,'Loading Knowledge...');assert.deepEqual(row.loading.clips,[]);assert.equal(row.loading.pageOverflow,false);}
      assert.equal(await refresh.isDisabled(),true);
      if(out)await page.screenshot({path:resolve(out,`${before?'before':'after'}-${locale}-${width}-loading.png`),animations:'disabled'});
      await page.evaluate(()=>window.pendingKnowledge.shift().resolve());await panel.locator('.knowledge-empty strong').waitFor();
      assert.equal((await calls('getKnowledgeSources')).length,readsBefore+1,'refresh performs exactly the existing one read');
      assert.equal((await writes()).length,1,'only accepted delete mutated');
      if(!before&&locale!=='en')rendered.forEach((value,i)=>assert.notEqual(value,knowledgeRemainingCopy.en[i],locale+': no English UI fallback'));
      // The mocked backend message must remain raw and distinct from empty.
      if(!before){await load(locale,'setup-error');await primary('ai-assistant');await page.locator('#knowledge-error').waitFor();assert.equal(await page.locator('#knowledge-error p').innerText(),'This information is temporarily unavailable. Please try again.');assert.equal(await page.locator('.knowledge-empty').count(),0);assert.deepEqual(await writes(),[]);}
    }
    if(!before) {
      // Source titles are inserted verbatim: no number formatting, recursive
      // interpolation, replacement-token interpretation or source translation.
      for(const locale of Object.keys(knowledgeRemainingCopy))for(const title of ['1234567','{title} "$&" سیاست ١٣']) {
        await load(locale);await primary('ai-assistant');await page.locator('.knowledge-source-row').waitFor();
        await page.locator('.knowledge-create-card input').fill(title);await page.locator('.knowledge-create-card textarea').fill('Source bytes\nالمعلومات 123');
        await page.locator('.knowledge-create-card button[type="submit"]').click();
        const row=page.locator('.knowledge-source-row').filter({has:page.locator('.knowledge-source-title',{hasText:title})});await row.waitFor();
        const id=await page.locator('.topbar-search select').inputValue();
        assert.deepEqual(await calls('createKnowledgeSource'),[{method:'createKnowledgeSource',id,payload:{title,content:'Source bytes\nالمعلومات 123'}}]);
        page.once('dialog',async d=>{assert.equal(d.message(),knowledgeRemainingCopy[locale][6].replace('{title}',()=>title));await d.dismiss();});
        await row.locator('.knowledge-delete-button').click();assert.deepEqual(await calls('deleteKnowledgeSource'),[]);
      }
      for(const locale of Object.keys(knowledgeRemainingCopy)) {
        await page.setViewportSize({width:320,height:850});await load(locale);await primary('ai-assistant');
        const refresh=page.locator('.knowledge-refresh-button');await page.locator('.knowledge-refresh-button:not([disabled])').waitFor();
        const id=await page.locator('.topbar-search select').inputValue();
        await page.evaluate(()=>{window.failNextKnowledgeMethod='getKnowledgeSources';});await refresh.click();
        await page.locator('#knowledge-error').waitFor();assert.equal(await page.locator('#knowledge-error p').innerText(),knowledgeLocalErrorCopy[locale][0]);
        assert.equal(await page.locator('.knowledge-empty').count(),0);
        await refresh.click();await page.locator('#knowledge-error').waitFor({state:'detached'});await page.locator('.knowledge-refresh-button:not([disabled])').waitFor();
        await page.locator('.knowledge-create-card input').fill('Source title');await page.locator('.knowledge-create-card textarea').fill('Raw content\n123');
        await page.evaluate(()=>{window.failNextKnowledgeMethod='createKnowledgeSource';});await page.locator('.knowledge-create-card button[type="submit"]').click();
        await page.locator('#knowledge-error').waitFor();assert.equal(await page.locator('#knowledge-error p').innerText(),knowledgeLocalErrorCopy[locale][1]);
        assert.deepEqual(await calls('createKnowledgeSource'),[{method:'createKnowledgeSource',id,payload:{title:'Source title',content:'Raw content\n123'}}]);
        assert.equal(await page.locator('.knowledge-create-card textarea').inputValue(),'Raw content\n123');
        await page.evaluate(()=>{window.failNextKnowledgeMethod='deleteKnowledgeSource';});page.once('dialog',async d=>{await d.accept();});await page.locator('.knowledge-delete-button').click();
        await page.waitForFunction(value=>document.querySelector('#knowledge-error p')?.textContent===value,knowledgeLocalErrorCopy[locale][2]);
        assert.deepEqual(await calls('deleteKnowledgeSource'),[{method:'deleteKnowledgeSource',id,payload:'source-'+id}]);
        assert.equal(await page.locator('.knowledge-source-row').count(),1);assert.deepEqual((await measure()).clips,[]);
        evidence.localErrors.push({locale,messages:knowledgeLocalErrorCopy[locale],calls:await writes()});save();
        if(out)await page.screenshot({path:resolve(out,`after-${locale}-320-local-error.png`),animations:'disabled'});
        if(locale==='en')for(const next of Object.keys(knowledgeRemainingCopy)) {
          await page.locator('.dashboard-account summary').click();await page.locator('.dashboard-language-control select').selectOption(next);await page.locator('.dashboard-account summary').click();
          assert.equal(await page.locator('#knowledge-error p').innerText(),knowledgeLocalErrorCopy[next][2]);assert.equal((await writes()).length,2,'locale switching never retries or saves');
        }
        await page.evaluate(()=>{window.knowledgeErrorMessage='Knowledge library';window.failNextKnowledgeMethod='getKnowledgeSources';});await refresh.click();
        await page.waitForFunction(()=>document.querySelector('#knowledge-error p')?.textContent==='Knowledge library');
        assert.equal((await writes()).length,2,'raw backend errors never trigger a write');
      }
    }
    console.log(`RC-02b: ${evidence.renders.length} locale/profile renders; native accept/cancel, refresh, populated/empty/loading/error and source-byte checks pass.`);
  }catch(error){evidence.errors.push(String(error));throw error;}finally{save();}
}
