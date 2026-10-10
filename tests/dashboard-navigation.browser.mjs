// Isolated browser integration: Vite serves the real UI, with auth/API modules replaced
// by in-memory fixtures. No server.ts, credentials, provider SDK or external API is used.
// Run: node tests/dashboard-navigation.browser.mjs [path-to-playwright/index.mjs]
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const { chromium } = await import(process.argv[2] || 'playwright');
const root = process.cwd();
// Render untouched production UI against the same mock data for metric equivalence.
// Read blobs only: no checkout, staging or production runtime is involved.
const baseline = 'adec3d68b9dfdaaaede7ed00c3c17dfae22e9540';
const baselineSource = path => execFileSync('git',['show',baseline+':'+path],{cwd:root,encoding:'utf8'});
const baselineModules = {
  '/__baseline-dashboard.tsx': {id:resolve(root,'src/pages/__baseline-dashboard.tsx'),source:baselineSource('src/pages/dashboard.tsx').replace("'../components/dashboard/DashboardShell'","'/__baseline-shell.tsx'").replace("'../components/dashboard/analytics/AnalyticsPage'","'/__baseline-analytics.tsx'")},
  '/__baseline-shell.tsx': {id:resolve(root,'src/components/dashboard/__baseline-shell.tsx'),source:baselineSource('src/components/dashboard/DashboardShell.tsx')},
  '/__baseline-analytics.tsx': {id:resolve(root,'src/components/dashboard/analytics/__baseline-analytics.tsx'),source:baselineSource('src/components/dashboard/analytics/AnalyticsPage.tsx')},
};
const mockApi = String.raw`
import {aggregateBusinessAnalytics} from '/src/analytics/queries/business-summary.ts';
import {resolveAnalyticsWindow} from '/src/analytics/queries/windows.ts';
window.fixtureCalls = [];
window.pendingAnalytics = [];
window.pendingKnowledge = [];
const analyticsFixture = (id, window) => {
  const scope=resolveAnalyticsWindow({businessId:Number(id),timezone:'Europe/Stockholm',window,now:new Date('2026-10-07T12:00:00Z')});
  const occurred_at=new Date(scope.fromMs+3600000).toISOString();
  const event=(event_name,i)=>({business_id:Number(id),event_name,occurred_at,conversation_id:'report-'+id,booking_id:event_name==='booking_completed'?100+i:null,channel:'telegram',platform:'telegram',service_id:null,service_name_snapshot:'Report service '+id,outcome:null,reason_code:null,idempotency_key:event_name+'-'+i});
  const data=aggregateBusinessAnalytics({scope,events:[...Array.from({length:id==='8'?5:3},(_,i)=>event('conversation_started',i)),event('customer_message_received',0),event('booking_started',0),event('booking_completed',0),event('booking_completed',1)],
    appointments:[{id:100,business_id:Number(id),service:'Report service '+id,platform:'telegram',status:'booked',created_at:occurred_at},{id:101,business_id:Number(id),service:'Euro service '+id,platform:'telegram',status:'completed',created_at:occurred_at}],
    services:[{name:'Report service '+id,price:id==='8'?800:100,currency:'SEK'},{name:'Euro service '+id,price:50,currency:'EUR'}],eventsTruncated:fixture==='partial',appointmentsTruncated:false});
  if(fixture==='empty'){data.channels=[];data.services=[];}
  if(fixture==='unavailable')data.dataQuality.status='unavailable';
  return data;
};
const fixture = new URLSearchParams(window.location.search).get('fixture');
const now = new Date().toISOString();
const business = (id) => ({id, name:'Business '+id, timezone:'Europe/Stockholm', language:'en', industry:'Studio', systemPrompt:'  Saved prompt '+id+'\nمرحبا <business> & rules.  ',
  toneConfig:{tonePreset:'custom',responseLength:'short',formality:'casual',emojiUsage:'light',customToneInstructions:'Saved tone '+id},
  services:[{name:'Consultation',durationMinutes:id==='8'?45:60,price:id==='8'?80:100,currency:id==='8'?'AUD':'SEK',active:id!=='8'}],workingHours:{monday:[{start:'09:00',end:'17:00'}],tuesday:[],wednesday:[],thursday:[],friday:[],saturday:[],sunday:[]}});
let businesses = fixture === 'zero' ? [] : [business('7'), business('8')];
window.fixtureBusinesses=()=>businesses;window.pendingSettings=[];window.delayedSettingsMethods=[];
const knowledge=Object.fromEntries(['7','8','9'].map(id=>[id,[{id:'source-'+id,businessId:id,title:'Knowledge '+id,content:'Business facts '+id,type:'text',status:'ready',updatedAt:now}]]));
let knowledgeSequence=0;
const health = [{key:'instagram',label:'Instagram',status:'disconnected',reasonCode:'authorization_invalid',action:'reconnect',detail:'Reconnect Instagram',lastCheckedAt:now,stale:false}];
const makeNotifications = (id) => ['health','activity'].map((type,i)=>({id:String(i),category:type==='health'?'integration':'booking',severity:'attention',title:'Issue '+type+' '+id,description:'Fixture issue',firstObservedAt:now,lastObservedAt:now,read:false,active:true,actionType:type==='health'?'open_health':'open_activity',actionTarget:type==='health'&&fixture==='ai-targets'?'#prompt-editor':type==='health'&&fixture==='usage-targets'?'#usage-statistics':type==='health'&&fixture==='usage-alias'?'#usage':'#'+type}));
const notificationsByBusiness=Object.fromEntries(['7','8','9'].map(id=>[id,makeNotifications(id)]));window.fixtureNotifications=()=>notificationsByBusiness;
const cancellationByBusiness=Object.fromEntries(['7','8','9'].map(id=>[id,{allowCancellation:true,cancellationDeadlineMinutes:720,cancellationFeeEnabled:true,cancellationFeeAmount:25,cancellationFeeCurrency:id==='8'?'AUD':'SEK'}]));
const alertsByBusiness=Object.fromEntries(['7','8','9'].map(id=>[id,{channel:'telegram',telegramChatId:'chat-'+id,whatsappNumber:'4670123456'+id}]));
const pagination = {nextCursor:null,total:0,hasMore:false};
const record = (method,id,range,payload) => window.fixtureCalls.push({method,id,...(range?{window:range}:{}),...(payload!==undefined?{payload}:{})});
export const api = new Proxy({}, {get(_, method) { return async (...args) => {
  const id = args[0]; const notifications=notificationsByBusiness[id]||[]; record(method,id,method==='getBusinessAnalyticsSummary'?args[1]:undefined,['updateBusiness','updateBusinessSettings','createKnowledgeSource','deleteKnowledgeSource'].includes(method)?args[1]:undefined);
  if(window.delayedSettingsMethods.includes(method)){
    window.delayedSettingsMethods=window.delayedSettingsMethods.filter(value=>value!==method);
    const value=method==='getCancellationSettings'?{success:true,data:{...cancellationByBusiness[id]}}:
      method==='getAdminNotificationSettings'?{success:true,data:{...alertsByBusiness[id]}}:
      method==='getChannelConnections'?[{id:'connection-'+id,provider:'whatsapp',status:'connected',reconnectRequired:false}]:
      method==='getCalendarConnection'?{id:'calendar-'+id,status:'connected',reconnectRequired:false}:
      {items:notifications.map(n=>({...n})),pagination,unreadCount:notifications.filter(n=>!n.read).length};
    return new Promise(resolve=>window.pendingSettings.push({method,id,resolve:()=>resolve(value)}));
  }
  switch(method) {
    case 'getConversations': case 'getBookings': case 'getChannelConnections': return [];
    case 'getCalendarConnection': return null;
    case 'getIntegrationHealth': return health;
    case 'refreshIntegrationHealth': return {data:health[0]};
    case 'getKnowledgeSources': {
      const sources=[...(knowledge[id]||[])];
      if(window.delayNextKnowledge){window.delayNextKnowledge=false;return new Promise(resolve=>window.pendingKnowledge.push({id,resolve:()=>resolve(sources)}));}
      return sources;
    }
    case 'createKnowledgeSource': {const source={id:'created-'+(++knowledgeSequence),businessId:id,...args[1],type:'text',status:'ready',updatedAt:now};knowledge[id]=[source,...(knowledge[id]||[])];return source;}
    case 'deleteKnowledgeSource': knowledge[id]=knowledge[id].filter(source=>source.id!==args[1]);return {success:true};
    case 'getCancellationSettings': return {success:true,data:{...cancellationByBusiness[id]}};
    case 'getAdminNotificationSettings': return {success:true,data:{...alertsByBusiness[id]}};
    case 'updateBusinessSettings': {const value=args[1];if('adminNotificationChannel' in value)alertsByBusiness[id]={...alertsByBusiness[id],channel:value.adminNotificationChannel,whatsappNumber:value.adminWhatsAppNumber};else cancellationByBusiness[id]={...cancellationByBusiness[id],...value};return {success:true};}
    case 'getNotificationPage': {let items=notifications.filter(n=>args[1].filter==='unread'?!n.read:args[1].filter==='attention'?n.active:true);const paged=fixture==='notification-pages';const start=args[1].cursor?1:0;return {items:(paged?items.slice(start,start+1):items).map(n=>({...n})),pagination:{...pagination,total:items.length,nextCursor:paged&&start===0&&items.length>1?'next':null,hasMore:paged&&start===0&&items.length>1},unreadCount:notifications.filter(n=>!n.read).length};}
    case 'markNotificationRead': notifications.find(n=>n.id===args[1]).read=true; return {success:true,unreadCount:notifications.filter(n=>!n.read).length};
    case 'markAllNotificationsRead': notifications.forEach(n=>n.read=true); return {success:true,unreadCount:0};
    case 'getBookingPage': return {items:[],pagination,summary:{today:0,upcoming:0,pending:0,cancelled:0,scanTruncated:false}};
    case 'getConversationPage': return {items:[{id:'conversation-'+id,customerName:'Customer '+id,channel:'instagram',status:'open',preview:'Fixture conversation',updatedAt:now,unreadCount:0,messages:[]}],pagination:{...pagination,total:1}};
    case 'getConversationThread': return {messages:[{id:'message-'+id,author:'customer',text:'Question '+id,createdAt:now}],pagination};
    case 'markConversationRead': return {success:true};
    case 'getBusinessAnalyticsSummary': {
      if(window.failNextAnalytics){window.failNextAnalytics=false;throw new Error('Fixture analytics unavailable');}
      const data=analyticsFixture(id,args[1]);
      if(window.delayNextAnalytics){window.delayNextAnalytics=false;return new Promise(resolve=>window.pendingAnalytics.push({id,signal:args[2],resolve:()=>resolve(data)}));}
      return data;
    }
    case 'createBusiness': {const created=business('9');created.name=id.name;businesses.push(created);return created;}
    case 'deleteBusiness': businesses=businesses.filter(b=>b.id!==id);return {ok:true};
    case 'updateBusiness': {
      if(window.failNextBusinessUpdate){window.failNextBusinessUpdate=false;throw new Error('Fixture save failure');}
      const updated={...businesses.find(b=>b.id===id),...args[1]};businesses=businesses.map(b=>b.id===id?updated:b);return updated;
    }
    default: throw new Error('Unmocked API: '+method);
  }
};}});
export async function loadDashboardData(id) {
  record('loadDashboardData',id);
  const selectedBusiness=businesses.find(b=>b.id===id)||businesses[0];
  return {businesses,selectedBusiness,stats:{},health,performance:{},conversations:[],bookings:[],usage:{plan:'Not selected',used:0,limit:0},bookingsChart:[],
    dashboardSummary:{status:'available',data:{scope:{startDate:'2026-10-07',timezone:'Europe/Stockholm'},conversationsToday:{quality:'available',value:1},completedBookingsToday:{quality:'available',value:0},estimatedBookingValue:{quality:'available',amounts:[],completedBookingCount:0},operationalStatus:{state:'attention',title:'Fixture issue status',detail:'Review issues',activeNotificationCount:fixture==='health'?0:2,healthIssueCount:1}}}};
}
`;
const server = await createServer({
  root, configFile: false, server: {host:'127.0.0.1',port:0},
  optimizeDeps:{include:['react','react-dom/client']},
  plugins:[{
    name:'isolated-navigation-fixtures', enforce:'pre',
    resolveId(id) { if(id==='/__navigation-entry.js') return '\0navigation-entry.js'; if(baselineModules[id]) return baselineModules[id].id; },
    load(id) {
      if(id==='\0navigation-entry.js') return `import React from 'react'; import {createRoot} from 'react-dom/client'; import CurrentDashboard from '/src/pages/dashboard.tsx'; import BaselineDashboard from '/__baseline-dashboard.tsx'; const Dashboard=new URLSearchParams(location.search).has('baseline')?BaselineDashboard:CurrentDashboard; createRoot(document.getElementById('root')).render(React.createElement(Dashboard,{onNavigate:(path)=>window.fixtureCalls.push({method:'onNavigate',id:path})}));`;
      const baselineModule=Object.values(baselineModules).find(module=>module.id===id.split('?')[0]);
      if(baselineModule) return baselineModule.source;
      if(id.split('?')[0]===resolve(root,'src/services/api.ts')) return mockApi;
      if(id.split('?')[0]===resolve(root,'src/auth/AuthProvider.tsx')) return `export function useAuth(){return {signOut:async()=>{window.fixtureCalls.push({method:'signOut'});}};}`;
    },
    configureServer(dev) {
      dev.middlewares.use(async (req,res,next)=>{
        if(!req.url.startsWith('/__navigation-test')) return next();
        const html=await dev.transformIndexHtml(req.url,'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__navigation-entry.js"></script></body></html>');
        res.setHeader('Content-Type','text/html');res.end(html);
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  const url=`http://127.0.0.1:${server.httpServer.address().port}/__navigation-test`;
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  page.setDefaultTimeout(10000);
  const errors=[];
  page.on('console',message=>{if(!new URL(page.url()).searchParams.has('baseline')&&message.type()==='error'&&/same key|unique.*key/i.test(message.text()))errors.push(message.text());});
  page.on('pageerror',error=>{errors.push(error.message);console.error(error.message);});
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  const load = async (suffix='') => {navigationCheckpoint=0;await page.goto(url+suffix);await page.locator('#workspace-home').waitFor({state:suffix.includes('connection=')?'attached':suffix.includes('fixture=zero')?'detached':'visible',timeout:10000}).catch(async error=>{console.error(await page.locator('body').innerText());throw error;});};
  const visible = async id => assert.equal(await page.locator('#'+id).isVisible(),true,id+' should be visible');
  const primary = async label => {await page.locator('.sidebar-nav').getByRole('link',{name:label,exact:true}).click();};
  const account = async () => {await page.locator('.dashboard-account summary').click();};
  let navigationCheckpoint=0;
  const assertNoConfigWrites = async () => assert.deepEqual(await page.evaluate(start=>window.fixtureCalls.slice(start).filter(c=>['updateBusiness','updateBusinessSettings','createBusiness','deleteBusiness','createKnowledgeSource','deleteKnowledgeSource','sendConversationMessage'].includes(c.method)),navigationCheckpoint),[]);
  const checkpoint = async () => {navigationCheckpoint=await page.evaluate(()=>window.fixtureCalls.length);};
  const assertUsageAbsent=async()=>{
    assert.equal(await page.locator('#usage-statistics, #settings-usage-trigger').count(),0,'Usage is unmounted, not merely hidden');
    for(const role of ['button','link','heading'])assert.equal(await page.getByRole(role,{name:/^(Usage(?: Statistics)?|Plan|Billing)(?:\s|$)/i}).count(),0,'no Usage/Plan '+role);
    assert.equal(await page.getByText('Usage',{exact:true}).count(),0);
    assert.doesNotMatch(await page.locator('.dashboard-page').ariaSnapshot(),/Usage Statistics|Not selected|\b0 (?:used|limit|remaining)\b|Coming soon|No plan selected|0 credits remaining/);
    const usageReferences=await page.evaluate(()=>{
      const attributes=['aria-controls','aria-labelledby','aria-describedby','aria-owns','aria-activedescendant'];
      return Array.from(document.querySelectorAll(attributes.map(attr=>'['+attr+']').join(',')))
        .flatMap(el=>attributes.flatMap(attr=>(el.getAttribute(attr)||'').split(/\s+/).filter(id=>/^(usage|settings-usage)/i.test(id))));
    });
    assert.deepEqual(usageReferences,[],'no orphaned Usage aria references');
  };
  const openAdvanced=async()=>{const disclosure=page.locator('#ai-advanced');if(await disclosure.getAttribute('open')===null)await disclosure.locator('summary').click();};
  await page.goto(url+'?baseline=1');await page.locator('.analytics-kpi-card strong').first().waitFor();
  const baselineHomeValues=await page.locator('.hero-result-copy strong').allTextContents();
  const baselineReportValues=await page.locator('.analytics-kpi-card strong').allTextContents();
  assert.deepEqual(baselineHomeValues,['1','0','0']);
  assert.deepEqual(baselineReportValues,['3','2','€50 + SEK\u00a0100']);
  await page.setViewportSize({width:320,height:850});
  // Metric equivalence uses production blobs; layout checks use the current scoped stylesheet.
  // Do not assert a historic visual defect against today's shared DashboardSections/CSS.
  await page.setViewportSize({width:1280,height:900});
  await load();
  assert.deepEqual(await page.locator('.sidebar-nav a').allTextContents(),['Home','Inbox','Bookings','AI Assistant','Settings']);
  assert.deepEqual(await page.locator('.mobile-bottom-nav a').allTextContents(),['Home','Inbox','Bookings','AI Assistant','Settings']);
  await visible('overview');
  assert.equal(await page.locator('#analytics').isVisible(),false,'full Analytics is hidden on Home');
  assert.equal(await page.locator('#analytics').count(),1,'only one Analytics instance');
  assert.match(await page.locator('#overview').textContent(),/Conversations with customer activity today/);
  assert.deepEqual(await page.locator('.hero-result-copy strong').allTextContents(),baselineHomeValues);
  await page.getByRole('button',{name:'Open Inbox',exact:true}).click();await visible('conversations');
  await primary('Home');await page.getByRole('button',{name:'Open Bookings',exact:true}).click();await visible('bookings');
  await primary('Home');
  const reports=async()=>{await page.getByRole('button',{name:'View reports',exact:true}).click();await visible('analytics');};
  const backHome=async()=>{await page.getByRole('button',{name:'Back to Home',exact:true}).click();await visible('overview');};
  const range=page.getByRole('group',{name:'Analytics date range'});
  const tabs=page.getByRole('navigation',{name:'Analytics views'});
  await reports();
  assert.equal(await page.locator('#analytics-title').textContent(),'Reports');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'analytics-title');
  assert.equal(await page.locator('.sidebar-nav [aria-current=page]').textContent(),'Home');
  assert.equal(await page.locator('#overview').isVisible(),false);
  assert.doesNotMatch(await page.locator('.content').ariaSnapshot(),/Conversations today|Open Inbox|Open Bookings|View reports/);
  assert.equal(await range.getByRole('button',{name:'30 days',exact:true}).getAttribute('aria-pressed'),'true');
  await page.locator('.analytics-kpi-card strong').first().waitFor();
  assert.deepEqual(await page.locator('.analytics-kpi-card strong').allTextContents(),baselineReportValues);
  const reportValues=await page.locator('.analytics-kpi-card strong').allTextContents();
  await tabs.getByRole('button',{name:'Channels',exact:true}).click();assert.match(await page.getByRole('table',{name:'Channel performance'}).textContent(),/Telegram/);
  await tabs.getByRole('button',{name:'Services',exact:true}).click();assert.match(await page.getByRole('table',{name:'Service performance'}).textContent(),/Report service 7/);
  await tabs.getByRole('button',{name:'Overview',exact:true}).click();
  for(const [label,preset] of [['Today','today'],['7 days','last_7_days'],['30 days','last_30_days']]){
    await range.getByRole('button',{name:label,exact:true}).click();
    await page.waitForFunction(expected=>window.fixtureCalls.filter(c=>c.method==='getBusinessAnalyticsSummary').at(-1)?.window.preset===expected,preset);
    await page.locator('.analytics-kpi-card strong').first().waitFor();
    assert.deepEqual(await page.locator('.analytics-kpi-card strong').allTextContents(),reportValues);
  }
  await page.evaluate(()=>window.delayNextAnalytics=true);
  await range.getByRole('button',{name:'7 days',exact:true}).click();await page.locator('#analytics .analytics-loading[aria-busy=true]').waitFor();
  await page.evaluate(()=>window.pendingAnalytics.at(-1).resolve());await page.locator('.analytics-kpi-card strong').first().waitFor();
  await page.evaluate(()=>window.failNextAnalytics=true);
  await range.getByRole('button',{name:'Today',exact:true}).click();await page.getByText('Analytics are temporarily unavailable',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Try again',exact:true}).click();await page.locator('.analytics-kpi-card strong').first().waitFor();
  await range.getByRole('button',{name:'Custom',exact:true}).click();await page.getByText('Select a custom date range',{exact:true}).waitFor();
  await page.getByLabel('Custom start date').fill('2026-08-01');await page.getByLabel('Custom end date').fill('2026-08-02');
  await page.locator('.analytics-kpi-card strong').first().waitFor();
  assert.deepEqual(await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='getBusinessAnalyticsSummary').at(-1).window),{preset:'custom',startDate:'2026-08-01',endDate:'2026-08-02'});
  await tabs.getByRole('button',{name:'Services',exact:true}).click();
  const requestsBeforeReturn=await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='getBusinessAnalyticsSummary').length);
  await backHome();assert.equal(await page.evaluate(()=>document.activeElement.id),'home-reports-trigger');
  assert.equal(await page.locator('#home-reports-trigger').evaluate(el=>el.tabIndex),0,'return focus does not remove Reports from the tab order');
  await page.keyboard.press('Enter');await visible('analytics');await page.getByRole('button',{name:'Back to Home',exact:true}).press('Enter');await visible('overview');
  assert.deepEqual(await page.locator('.hero-result-copy strong').allTextContents(),baselineHomeValues);
  await reports();
  assert.equal(await range.getByRole('button',{name:'Custom',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await page.getByLabel('Custom start date').inputValue(),'2026-08-01');assert.equal(await page.getByLabel('Custom end date').inputValue(),'2026-08-02');
  assert.equal(await tabs.getByRole('button',{name:'Services',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='getBusinessAnalyticsSummary').length),requestsBeforeReturn);
  // Deliberately resolve a previous tenant's request after the new tenant is displayed.
  await page.evaluate(()=>window.delayNextAnalytics=true);await range.getByRole('button',{name:'7 days',exact:true}).click();await page.locator('#analytics .analytics-loading[aria-busy=true]').waitFor();
  await page.locator('.topbar-search select').selectOption('8');await visible('overview');
  assert.equal(await page.locator('#analytics').isVisible(),false);
  await reports();await page.locator('.analytics-kpi-card strong').first().waitFor();
  assert.equal(await page.locator('.analytics-kpi-card strong').first().textContent(),'5');
  assert.equal(await page.evaluate(()=>window.pendingAnalytics.at(-1).signal.aborted),true);
  await page.evaluate(()=>window.pendingAnalytics.at(-1).resolve());
  await tabs.getByRole('button',{name:'Services',exact:true}).click();assert.match(await page.getByRole('table',{name:'Service performance'}).textContent(),/Report service 8/);assert.doesNotMatch(await page.locator('#analytics').textContent(),/Report service 7/);
  await page.locator('.topbar-search select').selectOption('7');await visible('overview');
  await assertNoConfigWrites();
  await account();await page.locator('#dashboard-account-panel').getByRole('button',{name:'Sign out',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.fixtureCalls.some(c=>c.method==='onNavigate' && c.id==='/login')),true);
  await primary('Inbox');await visible('conversations');
  await page.locator('.conversation-item').waitFor();
  await page.locator('.conversation-reply-input').fill('Unsent reply');
  await primary('Bookings');await visible('bookings');
  await primary('Inbox');assert.equal(await page.locator('.conversation-reply-input').inputValue(),'Unsent reply');
  await primary('AI Assistant');await visible('ai-tone');await visible('knowledge');
  const prompt=page.locator('#prompt-editor textarea');
  const originalPrompt=await page.evaluate(()=>window.fixtureBusinesses().find(b=>b.id==='7').systemPrompt);
  const originalTone=await page.evaluate(()=>window.fixtureBusinesses().find(b=>b.id==='7').toneConfig);
  assert.equal(await page.locator('#ai-advanced').getAttribute('open'),null);
  assert.equal(await page.getByRole('heading',{name:'How should OdinLink speak?',exact:true}).isVisible(),true);
  for(const label of ['Response length','Formality','Emoji usage'])assert.equal(await page.getByRole('group',{name:label,exact:true}).isVisible(),false);
  assert.equal(await prompt.isVisible(),false);
  assert.equal(await page.getByRole('button',{name:'Generate with AI'}).count(),0);
  assert.equal(await page.locator('#prompt-editor textarea').count(),1);
  assert.equal(await page.locator('#custom-tone-instructions').count(),1);
  assert.equal(await page.getByRole('button',{name:'Save style',exact:true}).first().count(),1);
  const normalAI=await page.locator('.content').ariaSnapshot();
  assert.doesNotMatch(normalAI,/Response length|Formality|Emoji usage|Custom instructions|Save instructions|system prompt|higher-priority|tools|LLM|prompt hierarchy/);
  assert.match(normalAI,/Business answers/);
  assert.equal(await page.getByRole('button',{name:/^Custom Use your own style/}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'Edit custom style',exact:true}).click();await visible('prompt-editor');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'custom-tone-instructions');
  assert.equal(await page.locator('#custom-tone-instructions').inputValue(),originalTone.customToneInstructions);
  assert.equal(await prompt.inputValue(),originalPrompt,'stored whitespace/Unicode prompt is not rewritten');
  assert.equal(await prompt.getAttribute('maxlength'),'10000');assert.equal(await page.locator('#custom-tone-instructions').getAttribute('maxlength'),'500');
  await page.locator('#ai-advanced summary').focus();await page.keyboard.press('Enter');
  assert.equal(await prompt.isVisible(),false);
  await page.keyboard.press('Enter');await visible('prompt-editor');
  await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>Boolean(document.activeElement.closest('#ai-advanced'))),true);
  await prompt.fill('Unsent prompt');await page.locator('#custom-tone-instructions').fill('Unsent tone');
  await page.locator('#knowledge').getByRole('textbox',{name:'Title',exact:true}).fill('Unsent source title');
  await page.locator('#knowledge').getByRole('textbox',{name:'Content',exact:true}).fill('Unsent business facts');
  await page.locator('#ai-advanced summary').click();await primary('Home');await primary('AI Assistant');
  assert.equal(await page.locator('#ai-advanced').getAttribute('open'),null);
  await openAdvanced();assert.equal(await prompt.inputValue(),'Unsent prompt');assert.equal(await page.locator('#custom-tone-instructions').inputValue(),'Unsent tone');
  assert.equal(await page.locator('#knowledge').getByRole('textbox',{name:'Title',exact:true}).inputValue(),'Unsent source title');
  assert.equal(await page.locator('#knowledge').getByRole('textbox',{name:'Content',exact:true}).inputValue(),'Unsent business facts');
  await prompt.fill(originalPrompt);await page.locator('#custom-tone-instructions').fill(originalTone.customToneInstructions);
  await page.locator('#ai-advanced summary').click();
  await assertNoConfigWrites();
  // Explicit fixture-only saves: verify separate payloads and all hidden tone values.
  await page.getByRole('button',{name:/^Friendly Approachable/}).click();
  await page.getByRole('button',{name:'Save style',exact:true}).first().click();
  await page.waitForFunction(()=>window.fixtureBusinesses().find(b=>b.id==='7').toneConfig.tonePreset==='friendly');
  const presetSave=await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='updateBusiness').at(-1));
  assert.deepEqual(presetSave.payload,{toneConfig:{...originalTone,tonePreset:'friendly'}});
  assert.equal(await page.evaluate(()=>window.fixtureBusinesses().find(b=>b.id==='7').systemPrompt),originalPrompt);
  assert.equal(await prompt.inputValue(),originalPrompt);
  await openAdvanced();assert.equal(await page.locator('#custom-tone-instructions').inputValue(),originalTone.customToneInstructions);
  await page.getByRole('button',{name:/^Custom Use your own style/}).click();assert.equal(await page.locator('#custom-tone-instructions').inputValue(),originalTone.customToneInstructions);
  await page.getByRole('button',{name:'Save style',exact:true}).first().click();await page.waitForFunction(()=>window.fixtureBusinesses().find(b=>b.id==='7').toneConfig.tonePreset==='custom');
  for(const label of ['Response length','Formality','Emoji usage'])assert.equal(await page.getByRole('group',{name:label,exact:true}).isVisible(),true);
  for(const [label,choice] of [['Response length','Detailed'],['Formality','Formal'],['Emoji usage','Expressive']])await page.getByRole('group',{name:label,exact:true}).getByRole('button',{name:choice,exact:true}).click();
  await page.locator('#custom-tone-instructions').fill('Explicit custom guidance');
  await page.getByRole('button',{name:'Back to assistant style',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Save style',exact:true}).first().evaluate(el=>el===document.activeElement),true);
  await page.getByRole('button',{name:'Save style',exact:true}).first().click();await page.waitForFunction(()=>window.fixtureBusinesses().find(b=>b.id==='7').toneConfig.responseLength==='detailed');
  assert.deepEqual(await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='updateBusiness').at(-1).payload),{toneConfig:{tonePreset:'custom',responseLength:'detailed',formality:'formal',emojiUsage:'expressive',customToneInstructions:'Explicit custom guidance'}});
  assert.equal(await page.evaluate(()=>window.fixtureBusinesses().find(b=>b.id==='7').systemPrompt),originalPrompt);
  for(const [label,choice] of [['Response length','Short'],['Formality','Casual'],['Emoji usage','Light']])await page.getByRole('group',{name:label,exact:true}).getByRole('button',{name:choice,exact:true}).click();
  await page.locator('#custom-tone-instructions').fill(originalTone.customToneInstructions);await page.getByRole('button',{name:'Save style',exact:true}).first().click();await page.waitForFunction(()=>window.fixtureBusinesses().find(b=>b.id==='7').toneConfig.responseLength==='short');
  // Tone save error stays safe and associated with its form, without changing stored data.
  await page.evaluate(()=>window.failNextBusinessUpdate=true);await page.getByRole('button',{name:'Save style',exact:true}).first().click();
  await page.locator('#ai-style-error').waitFor();assert.match(await page.locator('#ai-style-error').textContent(),/Couldn't save AI tone/);
  assert.equal(await page.locator('#ai-style-form').getAttribute('aria-describedby'),'ai-style-error');
  await page.getByRole('button',{name:'Save style',exact:true}).first().click();await page.locator('#ai-style-error').waitFor({state:'detached'});
  // Prompt save is still explicit and independent. Knowledge content is never copied.
  await page.evaluate(()=>window.failNextBusinessUpdate=true);await page.getByRole('button',{name:'Save instructions',exact:true}).click();await page.locator('#custom-instructions-error').waitFor();
  assert.match(await prompt.getAttribute('aria-describedby'),/custom-instructions-error/);assert.equal(await prompt.inputValue(),originalPrompt);
  const toneBeforePrompt=await page.evaluate(()=>window.fixtureBusinesses().find(b=>b.id==='7').toneConfig);
  const writesBeforePrompt=await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='updateBusiness').length);
  await page.getByRole('button',{name:'Save instructions',exact:true}).click();
  await page.waitForFunction(count=>window.fixtureCalls.filter(c=>c.method==='updateBusiness').length===count+1,writesBeforePrompt);
  await page.locator('#ai-tone').waitFor();
  assert.deepEqual(await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='updateBusiness').at(-1).payload),{systemPrompt:originalPrompt});
  assert.deepEqual(await page.evaluate(()=>window.fixtureBusinesses().find(b=>b.id==='7').toneConfig),toneBeforePrompt);
  await primary('AI Assistant');await openAdvanced();assert.equal(await prompt.inputValue(),originalPrompt);
  await prompt.fill('Explicit instructions — only this business');
  await page.getByRole('button',{name:'Save instructions',exact:true}).click();await page.waitForFunction(()=>window.fixtureBusinesses().find(b=>b.id==='7').systemPrompt==='Explicit instructions — only this business');
  await page.locator('#ai-tone').waitFor();await primary('AI Assistant');
  assert.deepEqual(await page.evaluate(()=>window.fixtureBusinesses().find(b=>b.id==='7').toneConfig),toneBeforePrompt);
  // Knowledge uses its own create/delete endpoints and confirmation; never updateBusiness.
  assert.match(await page.locator('#knowledge').textContent(),/Knowledge 7/);
  await page.locator('#knowledge').getByRole('textbox',{name:'Title',exact:true}).fill('  Business policy  ');
  await page.locator('#knowledge').getByRole('textbox',{name:'Content',exact:true}).fill('  New business answer — not a prompt  ');
  const updatesBeforeKnowledge=await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='updateBusiness').length);
  await page.locator('#knowledge').getByRole('button',{name:'Add knowledge',exact:true}).click();await page.getByText('Business policy',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.fixtureCalls.find(c=>c.method==='createKnowledgeSource')),{method:'createKnowledgeSource',id:'7',payload:{title:'Business policy',content:'New business answer — not a prompt'}});
  const added=page.locator('.knowledge-source-row').filter({hasText:'Business policy'});
  page.once('dialog',dialog=>dialog.dismiss());await added.getByRole('button',{name:'Delete: Business policy',exact:true}).click();assert.equal(await added.count(),1);
  assert.equal(await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='deleteKnowledgeSource').length),0);
  page.once('dialog',dialog=>dialog.accept());await added.getByRole('button',{name:'Delete: Business policy',exact:true}).click();await added.waitFor({state:'detached'});
  assert.deepEqual(await page.evaluate(()=>window.fixtureCalls.find(c=>c.method==='deleteKnowledgeSource')),{method:'deleteKnowledgeSource',id:'7',payload:'created-1'});
  assert.equal(await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='updateBusiness').length),updatesBeforeKnowledge);
  assert.equal(await page.evaluate(()=>window.fixtureBusinesses().find(b=>b.id==='7').systemPrompt),'Explicit instructions — only this business');
  await checkpoint();
  await primary('Home');await primary('AI Assistant');await openAdvanced();await page.locator('#ai-advanced summary').click();await assertNoConfigWrites();
  await primary('Settings');await assertUsageAbsent();
  await account();await page.locator('#dashboard-account-panel').getByRole('button',{name:'Manage Businesses'}).click();await visible('businesses');
  await account();await page.locator('#dashboard-account-panel').getByRole('button',{name:'Add Business',exact:true}).click();await page.getByRole('dialog').waitFor();await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await primary('Home');await page.locator('.mission-status-indicator').click();await visible('notification-center');
  await page.getByRole('button',{name:'Open Health'}).click();await visible('health');
  await page.getByRole('button',{name:'Reconnect',exact:true}).click();await visible('channel-settings');
  await account();await page.locator('#dashboard-account-panel').getByRole('button',{name:/^Notifications/}).click();
  await page.getByRole('button',{name:'View bookings'}).click();await visible('bookings');
  await assertNoConfigWrites();
  const accessibleContent=await page.locator('.content').ariaSnapshot();
  assert.doesNotMatch(accessibleContent,/AI Tone|Save instructions|Save Changes|Knowledge 7/);
  for(let i=0;i<10;i++){await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>Boolean(document.activeElement.closest('[hidden]'))),false);}
  // All five workspaces stay attached, but only the selected one can expose controls.
  assert.equal(await page.locator('.dashboard-workspace').count(),5);
  assert.equal(await page.locator('.dashboard-workspace:not([hidden])').count(),1);
  assert.equal(await page.locator('#workspace-ai-assistant').evaluate(el=>getComputedStyle(el).display),'none');
  const beforeSwitch=await page.evaluate(()=>window.fixtureCalls.length);
  await page.locator('.topbar-search select').selectOption('8');await visible('workspace-home');
  await primary('AI Assistant');assert.match(await page.locator('#knowledge').textContent(),/Knowledge 8/);
  const scopedReads=await page.evaluate(start=>window.fixtureCalls.slice(start).filter(c=>c.method.startsWith('get')),beforeSwitch);
  assert.ok(scopedReads.length>=7);assert.ok(scopedReads.every(c=>c.id==='8'),'all panels reload within business 8');
  await primary('AI Assistant');await openAdvanced();assert.equal(await prompt.inputValue(),await page.evaluate(()=>window.fixtureBusinesses().find(b=>b.id==='8').systemPrompt));assert.equal(await page.locator('#custom-tone-instructions').inputValue(),'Saved tone 8');
  await primary('Settings');await page.getByRole('button',{name:'Open Business',exact:true}).click();assert.equal(await page.locator('#business-settings input[placeholder="e.g. Consultation"]').inputValue(),'Consultation');
  await page.locator('.content').evaluate(el=>el.scrollTop=10000);assert.equal(await page.locator('.sidebar-nav [aria-current=page]').textContent(),'Settings');
  await assertNoConfigWrites();
  await page.evaluate(()=>window.delayNextKnowledge=true);await page.locator('.topbar-search select').selectOption('7');await visible('overview');
  await page.waitForFunction(()=>window.pendingKnowledge.length===1);
  await page.locator('.topbar-search select').selectOption('8');await visible('overview');await primary('AI Assistant');
  await page.getByText('Knowledge 8',{exact:true}).waitFor();await page.evaluate(()=>window.pendingKnowledge[0].resolve());
  assert.match(await page.locator('#knowledge').textContent(),/Knowledge 8/);assert.doesNotMatch(await page.locator('#knowledge').textContent(),/Knowledge 7/);
  assert.equal(await page.locator('#ai-advanced').getAttribute('open'),null);await assertNoConfigWrites();
  // Settings: three setup areas; existing forms and separate write boundaries.
  await primary('Settings');
  const settingsIndex=page.getByRole('navigation',{name:'Settings setup',exact:true});
  assert.deepEqual(await settingsIndex.getByRole('heading').allTextContents(),['Business','Connections','Notifications']);
  assert.deepEqual(await settingsIndex.getByRole('button').allTextContents(),['Open Business','Open Connections','Open Notifications']);
  assert.doesNotMatch(await page.locator('.content').ariaSnapshot(),/Save Changes|Save Cancellation Policy|Admin WhatsApp number|Integration Center|Manage Businesses/);
  const openSettingsArea=async(label)=>{await page.getByRole('button',{name:'Open '+label,exact:true}).click();};
  const backSettings=async()=>{await page.getByRole('button',{name:'Back to Settings',exact:true}).click();await settingsIndex.waitFor();};
  await openSettingsArea('Business');await visible('business-settings');await visible('cancellation-settings');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'settings-business-title');
  assert.equal(await page.locator('.sidebar-nav [aria-current=page]').textContent(),'Settings');
  const nameInput=page.locator('.business-settings-info-grid input').first();
  assert.equal(await page.locator('#business-settings').count(),1);
  const business8=await page.evaluate(()=>window.fixtureBusinesses().find(b=>b.id==='8'));
  assert.equal(await page.locator('.service-duration input').inputValue(),'45');
  assert.equal(await page.locator('.service-price input').inputValue(),'80');
  assert.equal(await page.locator('.service-currency input').inputValue(),'AUD');
  assert.equal(await page.locator('.service-active button').getAttribute('aria-pressed'),'false');
  await nameInput.fill('Business eight draft');
  await backSettings();assert.equal(await page.evaluate(()=>document.activeElement.id),'settings-business-trigger');
  await page.keyboard.press('Enter');await visible('business-settings');assert.equal(await nameInput.inputValue(),'Business eight draft','business draft survives navigation');
  const settingsWrites=await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='updateBusinessSettings').length);
  await page.getByRole('button',{name:'Save Changes',exact:true}).first().click();await page.getByText('Business settings saved',{exact:true}).waitFor();await visible('business-settings');
  const bulk=await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='updateBusiness').at(-1));
  assert.deepEqual(bulk,{method:'updateBusiness',id:'8',payload:{name:'Business eight draft',industry:business8.industry,timezone:business8.timezone,language:business8.language,services:business8.services,workingHours:business8.workingHours}});
  assert.equal(await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='updateBusinessSettings').length),settingsWrites,'Business save does not save cancellation or destinations');
  const bulkWrites=await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='updateBusiness').length);
  await page.locator('#cancellation-deadline').selectOption('custom');await page.locator('#custom-cancellation-value').fill('2');await page.locator('#custom-cancellation-unit').selectOption('days');
  await page.locator('#cancellation-fee-amount').fill('35');assert.equal(await page.locator('#cancellation-fee-currency').inputValue(),'AUD');
  await page.getByRole('button',{name:'Save Cancellation Policy',exact:true}).click();await page.getByText('Cancellation policy saved',{exact:true}).waitFor();await visible('business-settings');
  assert.deepEqual(await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='updateBusinessSettings').at(-1)),{method:'updateBusinessSettings',id:'8',payload:{allowCancellation:true,cancellationDeadlineMinutes:2880,cancellationFeeEnabled:true,cancellationFeeAmount:35,cancellationFeeCurrency:'AUD'}});
  assert.equal(await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='updateBusiness').length),bulkWrites,'cancellation keeps its separate save');
  await checkpoint();await backSettings();await openSettingsArea('Connections');await visible('channel-settings');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'settings-connections-title');
  assert.deepEqual(await page.locator('.integration-card h3').allTextContents(),['Google Calendar','Instagram','Facebook Messenger','Telegram','WhatsApp Business']);
  for(const provider of ['Instagram','WhatsApp Business']){
    await page.locator('.integration-card').filter({has:page.getByRole('heading',{name:provider,exact:true})}).getByRole('button',{name:'Connect manually',exact:true}).click();
    await page.getByRole('button',{name:'Manual configuration',exact:true}).click();await page.getByRole('heading',{name:'Manual configuration',exact:true}).waitFor();
    await page.getByRole('button',{name:/All integrations/}).click();
  }
  await page.getByRole('button',{name:'Connect Telegram',exact:true}).click();
  await page.getByRole('button',{name:'Advanced settings',exact:true}).click();
  const telegramField=page.getByRole('textbox',{name:/^Admin Chat ID/});
  await telegramField.fill('unsaved-chat-eight');await backSettings();await openSettingsArea('Connections');assert.equal(await telegramField.inputValue(),'unsaved-chat-eight','provider draft survives Settings navigation');
  await page.getByRole('button',{name:/All integrations/}).click();
  await page.getByRole('button',{name:'Connection health',exact:true}).click();await visible('health');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'connection-health-title');
  await page.getByRole('button',{name:'Check now',exact:true}).click();await page.waitForFunction(()=>window.fixtureCalls.some(c=>c.method==='refreshIntegrationHealth'&&c.id==='8'));
  await page.getByRole('button',{name:'Reconnect',exact:true}).click();await visible('channel-settings');
  await backSettings();assert.equal(await page.evaluate(()=>document.activeElement.id),'settings-connections-trigger');
  await openSettingsArea('Notifications');await visible('notification-center');assert.equal(await page.evaluate(()=>document.activeElement.id),'settings-notifications-title');
  await page.getByRole('button',{name:'Business alerts',exact:true}).click();await visible('admin-notifications');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'business-alerts-title');assert.match(await page.locator('#admin-notifications').textContent(),/chat-8/);
  assert.equal(await page.locator('#notification-center').isVisible(),false);
  assert.doesNotMatch(await page.locator('.content').ariaSnapshot(),/Mark all as read|Filter notifications/);
  await page.locator('input[name=admin-notification-channel][value=whatsapp]').check();
  await page.locator('#admin-whatsapp-number').fill('61 412-345-678');
  await page.getByRole('button',{name:'Save alert destination',exact:true}).click();await page.getByText('Admin notification settings saved',{exact:true}).waitFor();await visible('admin-notifications');
  assert.deepEqual(await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='updateBusinessSettings').at(-1)),{method:'updateBusinessSettings',id:'8',payload:{adminNotificationChannel:'whatsapp',adminWhatsAppNumber:'61412345678'}});
  await page.locator('input[name=admin-notification-channel][value=telegram]').check();
  await page.getByRole('button',{name:'Save alert destination',exact:true}).click();await page.getByText('Admin notification settings saved',{exact:true}).waitFor();await visible('admin-notifications');
  assert.deepEqual(await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='updateBusinessSettings').at(-1)),{method:'updateBusinessSettings',id:'8',payload:{adminNotificationChannel:'telegram',adminWhatsAppNumber:'61412345678'}});
  assert.match(await page.locator('#admin-notifications').textContent(),/chat-8/,'Telegram ID stays in Connections; destination save does not rewrite it');
  assert.equal(await page.evaluate(()=>window.fixtureCalls.filter(c=>c.method==='updateBusiness').length),bulkWrites);
  await checkpoint();await page.getByRole('button',{name:'Issues',exact:true}).click();await visible('notification-center');
  await backSettings();assert.equal(await page.evaluate(()=>document.activeElement.id),'settings-notifications-trigger');
  await assertNoConfigWrites();
  await page.locator('.topbar-search select').selectOption('7');await visible('overview');await primary('Settings');await openSettingsArea('Business');
  assert.equal(await nameInput.inputValue(),'Business 7');assert.equal(await page.locator('.service-currency input').inputValue(),'SEK');assert.equal(await page.locator('#cancellation-fee-amount').inputValue(),'25');
  await backSettings();await openSettingsArea('Notifications');await page.getByText('Issue health 7',{exact:true}).waitFor();assert.match(await page.locator('#notification-center').textContent(),/Issue health 7/);assert.doesNotMatch(await page.locator('#notification-center').textContent(),/Issue health 8/);
  await page.getByRole('button',{name:'Business alerts',exact:true}).click();await page.getByText('chat-7',{exact:true}).waitFor();assert.match(await page.locator('#admin-notifications').textContent(),/chat-7/);assert.doesNotMatch(await page.locator('#admin-notifications').textContent(),/chat-8|61412345678/);
  await assertNoConfigWrites();

  // Late settings/provider/issue reads belong to the old mounted business instance.
  await page.evaluate(()=>window.delayedSettingsMethods=['getCancellationSettings','getAdminNotificationSettings','getChannelConnections','getCalendarConnection','getNotificationPage']);
  await page.locator('.topbar-search select').selectOption('8');await page.waitForFunction(()=>window.pendingSettings.length===5);
  await page.locator('.topbar-search select').selectOption('7');await visible('overview');await primary('Settings');await openSettingsArea('Business');
  await page.locator('#cancellation-fee-currency').waitFor();
  await page.evaluate(()=>window.pendingSettings.forEach(request=>request.resolve()));
  assert.equal(await nameInput.inputValue(),'Business 7');assert.equal(await page.locator('.service-currency input').inputValue(),'SEK');assert.equal(await page.locator('#cancellation-fee-currency').inputValue(),'SEK');assert.equal(await page.locator('#cancellation-fee-amount').inputValue(),'25');
  await backSettings();await openSettingsArea('Notifications');await page.getByText('Issue health 7',{exact:true}).waitFor();assert.doesNotMatch(await page.locator('#notification-center').textContent(),/Issue health 8/);
  await page.getByRole('button',{name:'Business alerts',exact:true}).click();await page.getByText('chat-7',{exact:true}).waitFor();assert.doesNotMatch(await page.locator('#admin-notifications').textContent(),/chat-8/);
  await backSettings();await openSettingsArea('Connections');await page.locator('.integration-card').first().waitFor();
  assert.equal(await page.locator('.integration-card').filter({has:page.getByRole('heading',{name:'WhatsApp Business',exact:true})}).getByRole('status').textContent(),'Disconnected');
  assert.equal(await page.getByRole('button',{name:'Connect Google Calendar',exact:true}).isVisible(),true,'old calendar response cannot mark the new business connected');
  assert.equal(await page.locator('#business-settings').count(),1);await assertNoConfigWrites();

  // Mobile: account is outside the hidden desktop-only topbar group.
  for (const width of [320,375,768]) {
    await page.setViewportSize({width,height:850});
    await page.locator('.mobile-bottom-nav').getByRole('link',{name:'Settings',exact:true}).click();
    await settingsIndex.waitFor();
    for(const [area,section,control] of [['Business','business-settings','Save Cancellation Policy'],['Connections','channel-settings','Connection health'],['Notifications','notification-center','Business alerts']]){
      await openSettingsArea(area);await visible(section);
      assert.equal(await page.locator('.mobile-bottom-nav [aria-current=page]').textContent(),'Settings');
      const action=page.getByRole('button',{name:control,exact:true});await action.scrollIntoViewIfNeeded();
      const box=await action.boundingBox();const bottom=await page.locator('.mobile-bottom-nav').boundingBox();assert.ok(box.y+box.height<=bottom.y,area+' action clears navigation '+width);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,area+' fits '+width);
      for(const control of await page.locator('#workspace-settings input, #workspace-settings select, #workspace-settings textarea').all()){
        if(!await control.isVisible())continue;const box=await control.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width,area+' field fits '+width+': '+await control.evaluate(el=>el.outerHTML)+' '+JSON.stringify(box));
      }
      if(area==='Business'){
        const save=page.getByRole('button',{name:'Save Changes',exact:true}).first();await save.scrollIntoViewIfNeeded();const saveBox=await save.boundingBox();const navBox=await page.locator('.mobile-bottom-nav').boundingBox();assert.ok(saveBox.y+saveBox.height<=navBox.y,'Business bulk save clears navigation '+width);
      }
      if(width===320){await page.locator('.content').evaluate(el=>el.scrollTop=0);await page.screenshot({path:'/tmp/odinlink-step4-'+area.toLowerCase()+'-320.png'});}
      if(area==='Connections'){
        await action.click();await visible('health');const healthAction=page.getByRole('button',{name:'Reconnect',exact:true});await healthAction.scrollIntoViewIfNeeded();await healthAction.click();await visible('channel-settings');
        await page.getByRole('button',{name:'Connect Telegram',exact:true}).click();await page.getByRole('button',{name:'Advanced settings',exact:true}).click();
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'provider manual form fits '+width);await page.getByRole('button',{name:/All integrations/}).click();
      }
      if(area==='Notifications'){
        await action.click();await visible('admin-notifications');await page.locator('input[name=admin-notification-channel][value=whatsapp]').check();
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'business alerts fit '+width);
        const alertSave=page.getByRole('button',{name:'Save alert destination',exact:true});await alertSave.scrollIntoViewIfNeeded();const alertBox=await alertSave.boundingBox();const navBox=await page.locator('.mobile-bottom-nav').boundingBox();assert.ok(alertBox.y+alertBox.height<=navBox.y,'alert save clears navigation '+width);
      }
      await page.getByRole('button',{name:'Back to Settings',exact:true}).press('Enter');await settingsIndex.waitFor();
      assert.equal(await page.evaluate(()=>document.activeElement.id),'settings-'+area.toLowerCase()+'-trigger');
    }
    if(width===320){await page.locator('.content').evaluate(el=>el.scrollTop=0);await page.screenshot({path:'/tmp/odinlink-step4-settings-320.png'});}
    await page.locator('.mobile-bottom-nav').getByRole('link',{name:'AI Assistant',exact:true}).click();
    if(await page.locator('#ai-advanced').getAttribute('open')!==null)await page.locator('#ai-advanced summary').click();
    assert.equal(await prompt.isVisible(),false);
    for(const option of await page.locator('.tone-preset-grid button').all()){await option.scrollIntoViewIfNeeded();const box=await option.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width);assert.ok(box.height>=44);}
    await page.locator('#knowledge').getByRole('textbox',{name:'Content',exact:true}).scrollIntoViewIfNeeded();assert.equal(await page.locator('#knowledge').isVisible(),true);
    await page.locator('#ai-advanced summary').scrollIntoViewIfNeeded();await page.locator('#ai-advanced summary').focus();await page.keyboard.press('Enter');await visible('prompt-editor');
    await prompt.scrollIntoViewIfNeeded();const promptBox=await prompt.boundingBox();assert.ok(promptBox.x>=0&&promptBox.x+promptBox.width<=width,'prompt fits '+width);
    for(const saveButton of [page.getByRole('button',{name:'Save instructions',exact:true}),page.getByRole('button',{name:'Save style',exact:true}).first(),page.locator('#knowledge').getByRole('button',{name:'Add knowledge',exact:true})]){
      await saveButton.scrollIntoViewIfNeeded();const box=await saveButton.boundingBox();const bottomNav=await page.locator('.mobile-bottom-nav').boundingBox();assert.ok(box.y+box.height<=bottomNav.y,'AI save button clears bottom navigation '+width);
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'AI workspace fits '+width);
    if(width===320){await page.locator('#ai-advanced summary').click();await page.locator('.content').evaluate(el=>el.scrollTop=0);await page.screenshot({path:'/tmp/odinlink-step3-ai-320.png'});}

    await page.locator('.mobile-bottom-nav').getByRole('link',{name:'Home',exact:true}).click();
    await reports();
    assert.equal(await page.locator('.mobile-bottom-nav [aria-current=page]').textContent(),'Home');
    assert.equal(await page.locator('.mobile-bottom-nav').getByRole('link',{name:'Analytics',exact:true}).count(),0);
    await range.getByRole('button',{name:'Custom',exact:true}).click();
    assert.equal(await range.getByRole('button',{name:'Custom',exact:true}).getAttribute('aria-pressed'),'true');
    assert.equal(await range.getByRole('button',{name:'Custom',exact:true}).getAttribute('class'),'active');
    assert.equal(await range.getByRole('button',{name:'7 days',exact:true}).getAttribute('class'),'');
    for(const label of ['Custom start date','Custom end date']){
      const box=await page.getByLabel(label).boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width,'custom date control fits '+width);
    }
    await page.getByLabel('Custom start date').fill('2026-08-01');await page.getByLabel('Custom end date').fill('2026-08-02');await page.locator('.analytics-kpi-card strong').first().waitFor();
    for(const button of await page.locator('#analytics .analytics-range button, #analytics .analytics-tabs button').all()){const box=await button.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width,'report button fits '+width);}
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'no page overflow at '+width);
    if(width===320){await page.mouse.move(0,0);await page.screenshot({path:'/tmp/odinlink-step2-reports-320-final.png'});}
    const navBox=await page.locator('.mobile-bottom-nav').boundingBox();await page.locator('.analytics-kpi-card').last().scrollIntoViewIfNeeded();const visibleCard=await page.locator('.analytics-kpi-card').last().boundingBox();assert.ok(visibleCard.y+visibleCard.height<=navBox.y,'report content clears bottom navigation at '+width);
    await page.getByRole('button',{name:'Back to Home',exact:true}).click();await visible('overview');
    assert.equal(await page.locator('.dashboard-account summary').isVisible(),true);
    await account();
    for (const name of ['Add Business','Manage Businesses','Sign out']) assert.equal(await page.locator('#dashboard-account-panel').getByRole('button',{name,exact:true}).isVisible(),true);
    assert.equal(await page.getByRole('combobox',{name:'Dashboard language'}).isVisible(),true);
    assert.equal(await page.locator('.dashboard-language-control > span').isVisible(),true);
    if(width===320 && process.argv[3]) await page.screenshot({path:process.argv[3]});
    await page.keyboard.press('Escape');assert.equal(await page.locator('.dashboard-account').getAttribute('open'),null);
  }
  await page.locator('.mobile-bottom-nav').getByRole('link',{name:'Inbox',exact:true}).click();
  await page.locator('.conversation-item').click();
  assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('mobile-conversation-open')),true);
  // Trigger an actual primary click from the keyboard while the chat covers navigation.
  await page.locator('.sidebar-nav a[href="#workspace-settings"]').evaluate(el=>el.click());
  await visible('workspace-settings');
  assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('mobile-conversation-open')),false);
  assert.equal(await page.locator('.mobile-bottom-nav').isVisible(),true);
  await page.locator('.mobile-bottom-nav').getByRole('link',{name:'Inbox',exact:true}).click();
  await page.getByRole('button',{name:'Back to inbox'}).click();
  assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('mobile-conversation-open')),false);
  await account();await page.locator('#dashboard-account-panel').getByRole('button',{name:'Sign out',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.fixtureCalls.some(c=>c.method==='signOut')),true);
  // The language change is local, not a business update; verify RTL account reachability.
  await load();await account();await page.getByRole('combobox',{name:'Dashboard language'}).selectOption('ar');
  assert.equal(await page.locator('.dashboard-page').getAttribute('dir'),'rtl');
  await page.keyboard.press('Escape');assert.equal(await page.locator('.dashboard-account summary').isVisible(),true);
  await assertNoConfigWrites();
  await page.evaluate(()=>localStorage.removeItem('odinlink_dashboard_language'));
  // Step 5: absence/reachability across phones, tablets in both orientations, and desktop.
  await load();
  const viewports=[
    [320,850],[375,850],[768,1024],
    [834,1194],[834,650],[1194,834],[1024,1366],[1024,768],[1366,1024],
    [1280,900],[1440,900],
  ];
  for(const [width,height] of viewports){
    await page.setViewportSize({width,height});
    const nav=await page.locator('.mobile-bottom-nav').isVisible()?page.locator('.mobile-bottom-nav'):page.locator('.sidebar-nav');
    assert.deepEqual(await nav.getByRole('link').allTextContents(),['Home','Inbox','Bookings','AI Assistant','Settings']);
    for(const destination of ['Home','Inbox','Bookings','AI Assistant','Settings']){
      await nav.getByRole('link',{name:destination,exact:true}).click();
      assert.equal(await nav.locator('[aria-current=page]').textContent(),destination);await assertUsageAbsent();
    }
    assert.deepEqual(await settingsIndex.getByRole('heading').allTextContents(),['Business','Connections','Notifications']);
    assert.deepEqual(await settingsIndex.getByRole('button').allTextContents(),['Open Business','Open Connections','Open Notifications']);
    assert.equal(await page.locator('.settings-index-item').count(),3,'no blank fourth card');
    assert.equal(await page.locator('.settings-auxiliary').count(),0,'removed auxiliary action leaves no separator/container');
    for(const button of await settingsIndex.getByRole('button').all()){
      await button.scrollIntoViewIfNeeded();const box=await button.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width,'Settings open action fits '+width);
    }
    for(const [area,section] of [['Business','business-settings'],['Connections','channel-settings'],['Notifications','notification-center']]){
      await openSettingsArea(area);await visible(section);await assertUsageAbsent();
      await page.getByRole('button',{name:'Back to Settings',exact:true}).press('Enter');await settingsIndex.waitFor();
      assert.equal(await page.evaluate(()=>document.activeElement.id),'settings-'+area.toLowerCase()+'-trigger');
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'Settings page fits '+width+'x'+height);
    for(let i=0;i<8;i++){
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(()=>Boolean(document.activeElement.closest('#usage-statistics, #settings-usage-trigger, [hidden]'))),false,'no removed/hidden control in tab order');
    }
    const accountSummary=page.locator('.dashboard-account summary');await accountSummary.focus();await page.keyboard.press('Enter');
    assert.equal(await page.locator('.dashboard-account').getAttribute('open'),'','Account is keyboard accessible');
    for(const label of ['Add Business','Manage Businesses','Sign out','Landing'])assert.equal(await page.locator('#dashboard-account-panel').getByRole('button',{name:label,exact:true}).isVisible(),true);
    assert.equal(await page.locator('#dashboard-account-panel').getByRole('button',{name:/^Notifications/}).isVisible(),true);
    assert.equal(await page.getByRole('combobox',{name:'Dashboard language'}).isVisible(),true);
    assert.equal(await page.getByRole('combobox',{name:'Selected business'}).isVisible(),true);
    await assertUsageAbsent();await page.keyboard.press('Escape');
    assert.equal(await page.locator('.dashboard-account').getAttribute('open'),null);
    if([320,834,1024,1440].includes(width)){await page.locator('.content').evaluate(el=>el.scrollTop=0);await page.screenshot({path:'/tmp/odinlink-step5-settings-'+width+'x'+height+'.png'});}
    await assertNoConfigWrites();
  }
  // Existing persisted actions are redirected by the real NotificationCenter, never rewritten.
  await page.setViewportSize({width:768,height:850});
  for(const fixture of ['usage-targets','usage-alias']){
    await load('?fixture='+fixture);await page.locator('.mission-status-indicator').click();await visible('notification-center');
    const targetBefore=await page.evaluate(()=>window.fixtureNotifications()['7'][0].actionTarget);
    await page.getByRole('button',{name:'Open Health',exact:true}).click();await settingsIndex.waitFor();
    assert.equal(await page.locator('.mobile-bottom-nav [aria-current=page]').textContent(),'Settings');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'settings-notifications-trigger');
    assert.equal(await page.evaluate(()=>window.fixtureNotifications()['7'][0].actionTarget),targetBefore);
    await assertUsageAbsent();await assertNoConfigWrites();
  }
  await load('#usage-statistics');await visible('overview');await assertUsageAbsent();await assertNoConfigWrites();

  // Callback result is processed by the real, unmodified IntegrationCenter.
  for (const params of ['?connection=connected&channel=instagram','?connection=failed&integration=google_calendar']) {
    await load(params);await visible('channel-settings');
    assert.equal(await page.locator('.mobile-bottom-nav [aria-current=page]').textContent(),'Settings');
    assert.equal(new URL(page.url()).searchParams.has('connection'),false);
  }
  await load('?fixture=ai-targets');await page.locator('.mission-status-indicator').click();await page.getByRole('button',{name:'Open Health'}).click();await visible('prompt-editor');assert.equal(await page.locator('#ai-advanced').getAttribute('open'),'');assert.equal(await page.evaluate(()=>document.activeElement.id),'prompt-editor');
  await load('?fixture=partial');await reports();await page.locator('.analytics-quality.partial summary').waitFor();assert.equal(await page.locator('.analytics-kpi-card strong').first().textContent(),'—');
  await load('?fixture=unavailable');await reports();await page.getByText('Analytics coverage is unavailable',{exact:true}).waitFor();assert.equal(await page.locator('.analytics-kpi-card').count(),0);
  await load('?fixture=empty');await reports();await tabs.getByRole('button',{name:'Channels',exact:true}).click();await page.getByText('No channel activity was recorded in this period.',{exact:true}).waitFor();await tabs.getByRole('button',{name:'Services',exact:true}).click();await page.getByText('No service activity was recorded in this period.',{exact:true}).waitFor();
  await load('?fixture=notification-pages');
  await page.locator('.mobile-bottom-nav').getByRole('link',{name:'Settings',exact:true}).click();await openSettingsArea('Notifications');
  await page.getByRole('button',{name:'Load more',exact:true}).click();assert.equal(await page.locator('.notification-row').count(),2);
  await page.locator('.notification-filters').getByRole('button',{name:'Attention',exact:true}).click();await page.locator('.notification-row').first().getByRole('button',{name:'Mark read',exact:true}).click();
  assert.equal(await page.locator('.notification-row.read').count(),1,'read issue remains in attention');
  await page.locator('.notification-filters').getByRole('button',{name:'Unread',exact:true}).click();await page.getByText('Issue activity 7',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Mark all as read',exact:true}).click();await page.getByText("No unread notifications",{exact:true}).waitFor();
  await page.locator('.notification-filters').getByRole('button',{name:'Attention',exact:true}).click();await page.getByText('Issue health 7',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Load more',exact:true}).click();assert.equal(await page.locator('.notification-row.read').count(),2,'read does not resolve active issues');
  await page.locator('.notification-filters').getByRole('button',{name:'All',exact:true}).click();await page.getByText('Issue health 7',{exact:true}).waitFor();await assertNoConfigWrites();
  await load('?fixture=health');await page.locator('.mission-status-indicator').click();await visible('health');
  await load('?fixture=zero');await page.getByRole('button',{name:'Create business',exact:true}).click();await page.getByRole('dialog').waitFor();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await account();await page.locator('#dashboard-account-panel').getByRole('button',{name:'Add Business',exact:true}).click();
  await page.locator('.dashboard-business-dialog input').first().fill('New business');await page.getByRole('button',{name:'Create Business',exact:true}).click();await visible('workspace-home');
  assert.equal(await page.locator('.topbar-search select').inputValue(),'9');
  await account();await page.locator('#dashboard-account-panel').getByRole('button',{name:'Manage Businesses'}).click();
  await page.locator('.biz-row').getByRole('button',{name:'Delete',exact:true}).click();
  assert.match(await page.locator('.dashboard-business-dialog').textContent(),/New business/);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal(await page.locator('#businesses').isVisible(),true);
  await page.locator('.biz-row').getByRole('button',{name:'Delete',exact:true}).click();
  await page.getByRole('button',{name:'Delete Business',exact:true}).click();
  await page.getByRole('button',{name:'Create business',exact:true}).waitFor();
  assert.equal(await page.locator('.topbar-search select').inputValue(),'');
  assert.deepEqual(errors,[],'real UI should have no uncaught browser exceptions');
  console.log('PASS: hidden Usage/no placeholders, safe legacy targets, unchanged contracts, 11 viewport/orientation layouts, keyboard/aria absence; Settings index/business/cancellation/connections/health/issues/alerts, separate scoped saves, persisted drafts, keyboard focus and mobile Settings; consolidated AI style/Knowledge/Advanced, independent saves and preserved hidden fields, stale Knowledge guard, mobile AI, Home/Reports split, retained range/tab, distinct metrics/currencies, loading/error/retry, stale tenant guard, mobile Reports/focus, real dashboard navigation, retained drafts, contextual actions, tenant switching, mobile Account/RTL/Inbox lock, callbacks and zero-business flows (mock APIs only).');
} finally {
  if(browser) await browser.close();
  await server.close();
}
