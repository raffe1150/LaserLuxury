import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'vite';
const { chromium } = await import(process.argv[2] || 'playwright');
const root=resolve(import.meta.dirname,'..');const scratch=mkdtempSync(resolve(tmpdir(),'odinlink-document-ui-'));
const output=resolve(root,'docs/audits/document-upload-phase1');mkdirSync(output,{recursive:true});
const mock=String.raw`
window.calls=[];
const source=(id,status)=>({id,businessId:1,type:'document',title:id+'.txt',status,updatedAt:'2026-10-13T08:00:00Z',metadata:{format:'txt',bytes:200,errorCode:status==='failed'?'document_parse':null,attempts:1}});
window.docs=['pending','processing','ready','failed'].map(status=>source(status,status));
window.manual=[{id:'manual',type:'text',title:'Manual policy',status:'ready',updatedAt:'2026-10-13T08:00:00Z'}];
export const api={
getKnowledgeSources:async()=>window.manual,
createKnowledgeSource:async(b,p)=>{window.calls.push(['manual',b,p]);const s={id:'new-manual',title:p.title,status:'ready',type:'text'};window.manual.unshift(s);return s;},
deleteKnowledgeSource:async(b,id)=>{window.calls.push(['delete-manual',b,id]);},
getKnowledgeDocuments:async(b)=>{
  if(window.docDelay&&b==='1'){window.docDelay=false;return new Promise(resolve=>{window.resolveDocs=resolve;});}
  return b==='1'?window.docs:[source('Business Two','ready')];
},
uploadKnowledgeDocument:async(b,f)=>{window.calls.push(['upload',b,f.name]);if(window.uploadError)throw new Error(JSON.stringify({error:window.uploadError}));window.docs.unshift(source(f.name,'pending'));},
retryKnowledgeDocument:async(b,id)=>{window.calls.push(['retry',b,id]);window.docs=window.docs.map(s=>s.id===id?{...s,status:'pending'}:s);},
deleteKnowledgeDocument:async(b,id)=>{window.calls.push(['delete-document',b,id]);window.docs=window.docs.filter(s=>s.id!==id);},
};`;
let browser;
const server=await createServer({root,configFile:false,envDir:scratch,cacheDir:resolve(scratch,'cache'),optimizeDeps:{noDiscovery:true,include:['react','react-dom/client','react/jsx-dev-runtime']},server:{host:'127.0.0.1',port:0},plugins:[{
name:'synthetic-document-ui',enforce:'pre',resolveId(id){if(id==='/__document-fixture.js')return '\0documents';},
load(id){if(id.split('?')[0]===resolve(root,'src/services/api.ts'))return mock;
if(id==='\0documents')return `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import '/src/index.css';import '/src/styles/dashboard.css';import '/src/styles/dashboard-signature.css';import KnowledgePanel from '/src/components/dashboard/KnowledgePanel.tsx';import {DashboardI18nProvider,useDashboardI18n} from '/src/i18n/dashboard.tsx';function Fixture(){const [biz,set]=useState('1');window.changeBusiness=set;const {direction,locale}=useDashboardI18n();return React.createElement('div',{className:'dashboard-page signature-dashboard',dir:direction,lang:locale,style:{minHeight:'100vh',height:'auto',overflow:'visible',display:'block',padding:16}},React.createElement(KnowledgePanel,{businessId:biz,onSaved:()=>{}}));}createRoot(document.getElementById('root')).render(React.createElement(DashboardI18nProvider,null,React.createElement(Fixture)));`;
},configureServer(dev){dev.middlewares.use(async(req,res,next)=>{if(!req.url.startsWith('/__documents'))return next();const html=await dev.transformIndexHtml(req.url,'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__document-fixture.js"></script></body></html>');res.setHeader('Content-Type','text/html');res.end(html);});}
}]});
try {
await server.listen();const url=`http://127.0.0.1:${server.httpServer.address().port}/__documents`;
browser=await chromium.launch({headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',err=>errors.push(err.message));
await page.route('**/*',route=>{if(new URL(route.request().url()).hostname!=='127.0.0.1')return route.abort();return route.continue();});
for(const locale of ['en','sv','de','es','fa','ar'])for(const width of [375,1440]){
await page.setViewportSize({width,height:1000});await page.goto(url);await page.locator('.knowledge-documents .knowledge-source-row').last().waitFor();await page.evaluate(l=>localStorage.setItem('odinlink_dashboard_language',l),locale);await page.reload();
await page.locator('.knowledge-documents .knowledge-source-row').last().waitFor();
assert.equal(await page.locator('.knowledge-documents .knowledge-source-row').count(),4);
assert.equal(await page.locator('.knowledge-documents button[type=submit]').isDisabled(),true);
assert.equal(await page.locator('.dashboard-page').getAttribute('dir'),['ar','fa'].includes(locale)?'rtl':'ltr');
assert.equal(await page.locator('.knowledge-source-title').first().textContent(),'pending.txt');
assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`overflow ${locale}/${width}`);
const source=await page.locator('.knowledge-documents').innerText();if(locale!=='en')assert.ok(!source.includes('Upload document'),locale);
if((locale==='en'&&width===1440)||(locale==='fa'&&width===375))await page.screenshot({path:resolve(output,`${locale}-${width}.png`),fullPage:true});
}
await page.evaluate(()=>localStorage.setItem('odinlink_dashboard_language','en'));await page.reload();await page.locator('.knowledge-documents .knowledge-source-row').last().waitFor();
await page.locator('input[type=file]').setInputFiles({name:'synthetic.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic policy')});
assert.equal(await page.getByRole('button',{name:'Upload document',exact:true}).isDisabled(),true);
await page.locator('input[type=checkbox]').check();await page.getByRole('button',{name:'Upload document',exact:true}).click();
await page.waitForFunction(()=>window.calls.some(c=>c[0]==='upload'));await page.locator('.knowledge-source-title').filter({hasText:'synthetic.txt.txt'}).waitFor();
await page.locator('.knowledge-source-row').filter({hasText:'failed.txt'}).getByRole('button',{name:'Retry',exact:true}).click();await page.waitForFunction(()=>window.calls.some(c=>c[0]==='retry'));
page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'Delete: ready.txt',exact:true}).click();assert.equal(await page.evaluate(()=>window.calls.filter(c=>c[0]==='delete-document').length),0);
page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Delete: ready.txt',exact:true}).click();await page.waitForFunction(()=>window.calls.some(c=>c[0]==='delete-document'));
await page.locator('.knowledge-create-card input').fill('New manual');await page.locator('.knowledge-create-card textarea').fill('Synthetic manual text');await page.locator('.knowledge-create-card button[type=submit]').click();await page.waitForFunction(()=>window.calls.some(c=>c[0]==='manual'));
await page.locator('input[type=file]').setInputFiles({name:'large.txt',mimeType:'text/plain',buffer:Buffer.alloc(5*1024*1024+1)});await page.locator('input[type=checkbox]').check();await page.getByRole('button',{name:'Upload document',exact:true}).click();await page.getByRole('alert').filter({hasText:'5 MiB'}).waitFor();
await page.evaluate(()=>{window.docDelay=true;window.changeBusiness('2');});await page.locator('.knowledge-source-title').filter({hasText:'Business Two'}).waitFor();
await page.evaluate(()=>window.changeBusiness('1'));await page.waitForFunction(()=>typeof window.resolveDocs==='function');
await page.evaluate(()=>window.changeBusiness('2'));await page.locator('.knowledge-source-title').filter({hasText:'Business Two'}).waitFor();
await page.evaluate(()=>window.resolveDocs([{id:'foreign',title:'FOREIGN OLD BUSINESS',status:'ready'}]));
await page.waitForTimeout(100);assert.equal(await page.getByText('FOREIGN OLD BUSINESS').count(),0);
assert.deepEqual(errors,[]);
console.log('PASS: six locales, mobile/desktop overflow, RTL, pending/processing/ready/failed, attestation, upload, retry, cancel/confirm deletion, oversized feedback, manual creation and stale business-switch protection.');
} finally {await browser?.close();await server.close();rmSync(scratch,{recursive:true,force:true});}
