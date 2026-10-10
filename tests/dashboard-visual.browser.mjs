// Isolated browser integration: Vite serves the real UI, with auth/API modules replaced
// by in-memory fixtures. No server.ts, credentials, provider SDK or external API is used.
// Run: node tests/dashboard-visual.browser.mjs [playwright module] [evidence directory] [--before]
// Synthetic dense/long-name fixtures; production global CSS and dashboard CSS are both loaded.
import tailwindcss from '@tailwindcss/vite';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { resolve } from 'node:path';

const { chromium } = await import(process.argv[2] || 'playwright');
const root = process.cwd();
const mockApi = String.raw`
import {aggregateBusinessAnalytics} from '/src/analytics/queries/business-summary.ts';
import {resolveAnalyticsWindow} from '/src/analytics/queries/windows.ts';
window.fixtureCalls = [];
window.pendingAnalytics = [];
window.pendingDashboard = [];
window.pendingKnowledge = [];
window.pendingThreads = [];
window.pendingWorkspacePages = [];
window.pendingBusinessOperations = [];
window.delayedBusinessMethods = [];
const analyticsFixture = (id, window) => {
  const scope=resolveAnalyticsWindow({businessId:Number(id),timezone:'Europe/Stockholm',window,now:new Date('2026-10-07T12:00:00Z')});
  const occurred_at=new Date(scope.fromMs+3600000).toISOString();
  const reportService=fixture==='long-service'?'Report '+('InternationalConsultation'.repeat(8)):'Report service '+id;
  const event=(event_name,i)=>({business_id:Number(id),event_name,occurred_at,conversation_id:'report-'+id,booking_id:event_name==='booking_completed'?100+i:null,channel:'telegram',platform:'telegram',service_id:null,service_name_snapshot:reportService,outcome:null,reason_code:null,idempotency_key:event_name+'-'+i});
  const data=aggregateBusinessAnalytics({scope,events:[...Array.from({length:id==='8'?5:3},(_,i)=>event('conversation_started',i)),event('customer_message_received',0),event('booking_started',0),event('booking_completed',0),event('booking_completed',1)],
    appointments:[{id:100,business_id:Number(id),service:reportService,platform:'telegram',status:'booked',created_at:occurred_at},{id:101,business_id:Number(id),service:'Euro service '+id,platform:'telegram',status:'completed',created_at:occurred_at},...(fixture==='partial-price'?[{id:102,business_id:Number(id),service:'Unpriced service '+id,platform:'telegram',status:'booked',created_at:occurred_at}]:[])],
    services:[{name:reportService,price:id==='8'?800:100,currency:'SEK'},{name:'Euro service '+id,price:50,currency:'EUR'}],eventsTruncated:fixture==='partial',appointmentsTruncated:fixture==='partial-price'});
  if(fixture==='empty'){data.channels=[];data.services=[];}
  if(fixture==='unavailable')data.dataQuality.status='unavailable';
  return data;
};
const fixture = new URLSearchParams(window.location.search).get('fixture');
const now = new Date().toISOString();
const business = (id) => ({id, name:fixture==='rtl-name-ar'?'استوديو أودين للعناية بالصحة والجمال — مركز المواعيد والخدمات الدولية':fixture==='rtl-name-fa'?'استودیو اودین برای سلامت و زیبایی — مرکز بین‌المللی خدمات و نوبت‌دهی':fixture==='long-token'?'Admotion'+('International'.repeat(12)):id==='7'?'Admotion Studio — Advanced Beauty & Wellness Stockholm':'North Harbour Health & Wellness International', timezone:'Europe/Stockholm', language:'en', industry:'Studio', systemPrompt:'  Saved prompt '+id+'\nمرحبا <business> & rules.  ',
  toneConfig:{tonePreset:'custom',responseLength:'short',formality:'casual',emojiUsage:'light',customToneInstructions:'Saved tone '+id},
  services:[{name:fixture==='long-setup'?'Personalised '+('InternationalTreatment'.repeat(6)):'Initial consultation and personalised treatment plan',durationMinutes:60,price:1200,currency:'SEK',active:true},{name:'Signature facial treatment',durationMinutes:90,price:1850,currency:'SEK',active:true},{name:'Follow-up consultation',durationMinutes:30,price:80,currency:'EUR',active:true},{name:'Premium membership appointment',durationMinutes:45,price:100,currency:'AUD',active:false}],workingHours:{monday:[{start:'09:00',end:'17:00'}],tuesday:[{start:'09:00',end:'17:00'}],wednesday:[{start:'09:00',end:'17:00'}],thursday:[{start:'09:00',end:'19:00'}],friday:[{start:'09:00',end:'16:00'}],saturday:[],sunday:[]}});
let businesses = fixture === 'zero' ? [] : [business('7'), business('8')];
window.fixtureBusinesses=()=>businesses;window.pendingSettings=[];window.delayedSettingsMethods=[];
const knowledge=Object.fromEntries(['7','8','9'].map(id=>[id,[{id:'source-'+id,businessId:id,title:fixture==='long-setup'?'Information '+('InternationalAppointments'.repeat(6)):'Appointments, arrival and parking information',content:'Please arrive ten minutes before your appointment. Free parking is available behind the studio. Bring your consultation form. Rescheduling is subject to the agreed cancellation policy.',type:'text',status:'ready',updatedAt:now}]]));
let knowledgeSequence=0;
const health = [{key:'instagram',label:'Instagram',status:'disconnected',reasonCode:'authorization_invalid',action:'reconnect',detail:'Reconnect Instagram',lastCheckedAt:now,stale:false},{key:'messenger',label:'Messenger',status:'connected',reasonCode:'verified',action:'check_now',detail:'Connected account verified',lastCheckedAt:now,stale:false},{key:'whatsapp',label:'WhatsApp',status:'degraded',reasonCode:'provider_unavailable',action:'retry',detail:'The provider is temporarily unavailable. Your saved connection remains in place.',lastCheckedAt:now,stale:['stale-health','held-stale-health'].includes(fixture)},{key:'telegram',label:'Telegram',status:fixture==='feedback-toast'?'connected':'setup_required',reasonCode:'not_configured',action:'complete_setup',detail:'Finish connecting Telegram to receive customer messages.',lastCheckedAt:now,stale:false},{key:'google_calendar',label:'Google Calendar',status:'connected',reasonCode:'verified',action:'check_now',detail:'Calendar access verified',lastCheckedAt:now,stale:false}];
const makeNotifications = (id) => Array.from({length:18},(_,i)=>i%3?'activity':'health').map((type,i)=>({id:String(i),category:type==='health'?'integration':'booking',severity:i%4===0?'critical':i%3===0?'attention':'info',title:type==='health'?'Instagram needs to be reconnected':'A customer changed their appointment',description:type==='health'?'Reconnect your account to continue receiving customer messages. Your saved settings will remain in place.':'Sofia Andersson rescheduled her consultation. Open bookings to review the updated appointment.',firstObservedAt:now,lastObservedAt:now,read:i%4===1,active:i%5!==2,actionType:type==='health'?'open_health':'open_activity',actionTarget:type==='health'&&fixture==='ai-targets'?'#prompt-editor':type==='health'&&fixture==='usage-targets'?'#usage-statistics':type==='health'&&fixture==='usage-alias'?'#usage':'#'+type}));
const notificationsByBusiness=Object.fromEntries(['7','8','9'].map(id=>[id,makeNotifications(id)]));window.fixtureNotifications=()=>notificationsByBusiness;
const cancellationByBusiness=Object.fromEntries(['7','8','9'].map(id=>[id,{allowCancellation:true,cancellationDeadlineMinutes:720,cancellationFeeEnabled:true,cancellationFeeAmount:25,cancellationFeeCurrency:id==='8'?'AUD':'SEK'}]));
const alertsByBusiness=Object.fromEntries(['7','8','9'].map(id=>[id,{channel:'telegram',telegramChatId:'chat-'+id,whatsappNumber:'4670123456'+id}]));
const fixtureBookings=(id)=>Array.from({length:18},(_,i)=>({id:'booking-'+id+'-'+i,customerName:fixture==='tenant-workspaces'?'Tenant '+id+' customer '+i:fixture==='long-customer'&&i===0?'Alexandra '+('InternationalCustomer'.repeat(7)):['Sofia Andersson','Alexander Montgomery-Svensson','لیلا احمدی','Omar Al Rashid'][i%4],serviceName:fixture==='long-customer'&&i===0?'Personalised '+('InternationalTreatment'.repeat(7)):['Initial consultation and personalised treatment plan','Signature facial treatment','Follow-up consultation'][i%3],channel:['instagram','whatsapp','messenger','telegram'][i%4],status:['confirmed','pending','confirmed','completed','cancelled'][i%5],startsAt:new Date(Date.now()+i*3600000).toISOString(),endsAt:new Date(Date.now()+(i+1)*3600000).toISOString(),createdAt:now}));
const fixtureConversations=(id)=>Array.from({length:16},(_,i)=>({id:'conversation-'+id+'-'+i,customerName:fixture==='tenant-workspaces'?'Tenant '+id+' customer '+i:fixture==='long-customer'&&i===0?'Alexandra '+('InternationalCustomer'.repeat(7)):['Sofia Andersson','Alexander Montgomery-Svensson','لیلا احمدی','Omar Al Rashid'][i%4],channel:['instagram','whatsapp','messenger','telegram'][i%4],status:['open','escalated','booked','handled','pending'][i%5],preview:['Can I book a consultation this Friday afternoon?','Thank you, that appointment works for me.','سلام، آیا می‌توانم برای هفته آینده وقت بگیرم؟','I have a question about your cancellation policy and parking.'][i%4],updatedAt:new Date(Date.now()-i*300000).toISOString(),unreadCount:i%3===0?i+2:0,messages:[]}));
const pagination = {nextCursor:null,total:0,hasMore:false};
const record = (method,id,range,payload) => window.fixtureCalls.push({method,id,...(range?{window:range}:{}),...(payload!==undefined?{payload}:{})});
export const api = new Proxy({}, {get(_, method) { return async (...args) => {
  const id = args[0]; if(fixture==='visual-loading' && !['markConversationRead'].includes(method))await new Promise(()=>{});if((fixture==='setup-error'&&['getKnowledgeSources','getCancellationSettings','getAdminNotificationSettings','getIntegrationHealth'].includes(method))||(fixture==='visual-error' && String(method).startsWith('get')))throw new Error('This information is temporarily unavailable. Please try again.'); const notifications=fixture==='visual-empty'?[]:notificationsByBusiness[id]||[]; record(method,id,method==='getBusinessAnalyticsSummary'?args[1]:undefined,method==='sendConversationMessage'?args[2]:['updateBusiness','updateBusinessSettings','createKnowledgeSource','deleteKnowledgeSource','getConversationPage','getBookingPage','getConversationThread'].includes(method)?args[1]:undefined);
  if(window.failNextKnowledgeMethod===method && ['getKnowledgeSources','createKnowledgeSource','deleteKnowledgeSource'].includes(method)){window.failNextKnowledgeMethod=null;throw window.knowledgeErrorMessage ? new Error(window.knowledgeErrorMessage) : null;}
  if(window.delayedBusinessMethods.includes(method)){
    window.delayedBusinessMethods=window.delayedBusinessMethods.filter(value=>value!==method);
    await new Promise(resolve=>window.pendingBusinessOperations.push({method,resolve}));
  }
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
    case 'refreshIntegrationHealth': {if(window.returnErrorHealth){window.returnErrorHealth=false;return {data:{...health.find(h=>h.key===args[1]),status:'error',detail:'The connection could not be verified.',reasonCode:'check_failed',action:'retry'}};}if(window.failNextHealth){window.failNextHealth=false;throw new Error('The connection could not be verified. Please try again.');}const index=health.findIndex(item=>item.key===args[1]);if(fixture==='held-stale-health')await new Promise(()=>{});health[index]={...health[index],stale:false};return {data:health[index]};}
    case 'getKnowledgeSources': {
      const sources=fixture==='visual-empty'?[]:[...(knowledge[id]||[])];
      if(window.delayNextKnowledge){window.delayNextKnowledge=false;return new Promise(resolve=>window.pendingKnowledge.push({id,resolve:()=>resolve(sources)}));}
      return sources;
    }
    case 'createKnowledgeSource': {const source={id:'created-'+(++knowledgeSequence),businessId:id,...args[1],type:'text',status:'ready',updatedAt:now};knowledge[id]=[source,...(knowledge[id]||[])];return source;}
    case 'deleteKnowledgeSource': knowledge[id]=knowledge[id].filter(source=>source.id!==args[1]);return {success:true};
    case 'getCancellationSettings': return {success:true,data:{...cancellationByBusiness[id]}};
    case 'getAdminNotificationSettings': return {success:true,data:{...alertsByBusiness[id]}};
    case 'updateBusinessSettings': {if(window.failNextSettingsSave){window.failNextSettingsSave=false;throw new Error('Your changes could not be saved. Please try again.');}const value=args[1];if('adminNotificationChannel' in value)alertsByBusiness[id]={...alertsByBusiness[id],channel:value.adminNotificationChannel,whatsappNumber:value.adminWhatsAppNumber};else cancellationByBusiness[id]={...cancellationByBusiness[id],...value};return {success:true};}
    case 'getNotificationPage': {let items=notifications.filter(n=>args[1].filter==='unread'?!n.read:args[1].filter==='attention'?n.active:true);const paged=fixture==='notification-pages';const start=args[1].cursor?1:0;return {items:(paged?items.slice(start,start+1):items).map(n=>({...n})),pagination:{...pagination,total:items.length,nextCursor:paged&&start===0&&items.length>1?'next':null,hasMore:paged&&start===0&&items.length>1},unreadCount:notifications.filter(n=>!n.read).length};}
    case 'markNotificationRead': notifications.find(n=>n.id===args[1]).read=true; return {success:true,unreadCount:notifications.filter(n=>!n.read).length};
    case 'markAllNotificationsRead': notifications.forEach(n=>n.read=true); return {success:true,unreadCount:0};
    case 'getBookingPage': {if(fixture==='bookings-loading')await new Promise(()=>{});if(fixture==='bookings-error'||window.failNextBookings){window.failNextBookings=false;throw new Error('Bookings could not be loaded. Please try again.');}const items=fixture==='visual-empty'||fixture==='bookings-empty'?[]:fixtureBookings(id).filter(b=>args[1].view==='pending'?b.status==='pending':args[1].view==='cancelled'?b.status==='cancelled':args[1].view==='past'?b.status==='completed':args[1].view==='upcoming'?['confirmed','pending'].includes(b.status):true);const paged=fixture==='workspace-pages';const start=args[1].cursor||0;const response={items:paged?items.slice(start,start+6):items,pagination:{...pagination,total:items.length,nextCursor:paged&&start+6<items.length?start+6:null},summary:{today:6,upcoming:11,pending:4,cancelled:3,scanTruncated:fixture==='workspace-pages'}};if(window.delayNextBookings){window.delayNextBookings=false;return new Promise(resolve=>window.pendingWorkspacePages.push({method,id,resolve:()=>resolve(response)}));}return response;}
    case 'getConversationPage': {if(fixture==='inbox-loading')await new Promise(()=>{});if(fixture==='inbox-error')throw new Error('Conversations could not be loaded. Please try again.');const items=fixture==='visual-empty'||fixture==='inbox-empty'||args[1].search==='NoMatches'?[]:fixtureConversations(id);const paged=fixture==='workspace-pages';const start=args[1].cursor||0;const response={items:paged?items.slice(start,start+6):items,pagination:{...pagination,total:items.length,nextCursor:paged&&start+6<items.length?start+6:null}};if(window.delayNextConversations){window.delayNextConversations=false;return new Promise(resolve=>window.pendingWorkspacePages.push({method,id,resolve:()=>resolve(response)}));}return response;}
    case 'getConversationThread': {if(fixture==='thread-loading')await new Promise(()=>{});if(fixture==='thread-error')throw new Error('Messages could not be loaded. Please try again.');const response= {conversationId:args[1],messages:Array.from({length:12},(_,i)=>({id:'message-'+id+'-'+i,author:i%4===0?'human':i%2===0?'ai':'customer',text:['Hello! I would like to book a consultation for next Friday. Do you have any appointments after 3 pm?','Of course. We have appointments available at 15:30 and 16:30. The consultation lasts 60 minutes and costs SEK 1,200. Which time would you prefer?','15:30 sounds good. Is there parking nearby?','Yes, there is free parking behind the studio. Please arrive ten minutes before your appointment. Your booking confirmation will include the address and cancellation information.'][i%4],createdAt:new Date(Date.now()-(12-i)*60000).toISOString()})),pagination};if(fixture==='tenant-threads')response.messages.forEach(message=>message.text='Tenant '+id+' · '+message.text);if(window.delayNextThread){window.delayNextThread=false;return new Promise(resolve=>window.pendingThreads.push({id,resolve:()=>resolve(response)}));}return response;}
    case 'sendConversationMessage': if(window.failNextSend){window.failNextSend=false;throw new Error('Fixture send failed');}return {messageId:'sent-'+Date.now(),createdAt:now};
    case 'markConversationRead': return {success:true};
    case 'getBusinessAnalyticsSummary': {
      if(fixture==='visual-empty'){const data=analyticsFixture(id,args[1]);data.channels=[];data.services=[];return data;}
      if(window.failNextAnalytics){window.failNextAnalytics=false;throw new Error('Fixture analytics unavailable');}
      const data=analyticsFixture(id,args[1]);
      if(window.delayNextAnalytics){window.delayNextAnalytics=false;return new Promise(resolve=>window.pendingAnalytics.push({id,signal:args[2],resolve:()=>resolve(data)}));}
      return data;
    }
    case 'createBusiness': {if(window.failNextCreate){window.failNextCreate=false;throw new Error('Your business could not be created. Please try again.');}const created=business('9');created.name=id.name;businesses.push(created);return created;}
    case 'deleteBusiness': if(window.failNextDelete){window.failNextDelete=false;throw new Error('Your business could not be deleted. Please try again.');}businesses=businesses.filter(b=>b.id!==id);return {ok:true};
    case 'updateBusiness': {
      if(window.failNextBusinessUpdate){window.failNextBusinessUpdate=false;throw new Error('Fixture save failure');}
      const updated={...businesses.find(b=>b.id===id),...args[1]};businesses=businesses.map(b=>b.id===id?updated:b);return updated;
    }
    default: throw new Error('Unmocked API: '+method);
  }
};}});
export async function loadDashboardData(id) {
  record('loadDashboardData',id);
  if(window.delayNextDashboard){window.delayNextDashboard=false;await new Promise(resolve=>window.pendingDashboard.push({id,resolve}));}
  if(fixture==='home-loading')await new Promise(()=>{});
  if(fixture==='home-error')throw new Error('This overview is temporarily unavailable.');
  const selectedBusiness=businesses.find(b=>b.id===id)||businesses[0];
  return {businesses,selectedBusiness,stats:{},health,performance:{},conversations:[],bookings:[],usage:{plan:'Not selected',used:0,limit:0},bookingsChart:[],
    dashboardSummary:fixture==='home-unavailable'?{status:'unavailable'}:{status:'available',data:{scope:{startDate:'2026-10-07',timezone:'Europe/Stockholm'},conversationsToday:{quality:fixture==='home-partial'?'partial':'available',value:fixture==='home-empty'?0:24},completedBookingsToday:{quality:'available',value:fixture==='home-empty'?0:7},estimatedBookingValue:{quality:fixture==='home-partial'?'partial':'available',amounts:fixture==='home-empty'?[]:[{currency:'SEK',amount:8400},{currency:'EUR',amount:160}],completedBookingCount:fixture==='home-empty'?0:7,knownPriceCount:fixture==='home-empty'?0:7,unknownPriceCount:0,priceCoverageRate:1},operationalStatus:{state:'attention',title:fixture==='health'?'1 connection needs attention':'2 issues need attention',detail:fixture==='health'?'Review integration health for the selected business.':'Review active notifications for the selected business.',activeNotificationCount:fixture==='health'?0:2,healthIssueCount:1}}}};
}
`;
const server = await createServer({
  root, configFile: false, cacheDir:resolve(tmpdir(),'odinlink-visual-vite-'+process.pid), server: {host:'127.0.0.1',port:0,watch:null},
  optimizeDeps:{include:['react','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime']},
  plugins:[tailwindcss(),{
    name:'isolated-navigation-fixtures', enforce:'pre',
    resolveId(id) { if(id==='/__navigation-entry.js') return '\0navigation-entry.js'; },
    load(id) {
      if(process.argv.includes('--phase6-snapshot-before')) {
        const path=id.split('?')[0],relative=path.startsWith(root+'/')?path.slice(root.length+1):'';
        if(['src/pages/dashboard.tsx','src/components/dashboard/DashboardSections.tsx','src/components/dashboard/KnowledgePanel.tsx','src/components/dashboard/HealthStatus.tsx','src/components/dashboard/NotificationCenter.tsx','src/components/dashboard/IntegrationCenter.tsx','src/components/dashboard/ConversationsPanel.tsx','src/components/dashboard/BookingsPanel.tsx','src/components/dashboard/analytics/AnalyticsPage.tsx','src/styles/dashboard.css','src/i18n/dashboard.tsx'].includes(relative)) {
          try { const source=readFileSync(resolve('/tmp/odinlink-visual-phase6-before',relative),'utf8');
            return id.endsWith('?raw')?'export default '+JSON.stringify(source):source;
          } catch { /* Fixture/auth virtual modules and new presentation helpers use normal loading. */ }
        }
      }
      if(process.argv.includes('--phase5-snapshot-before')) {
        const path=id.split('?')[0],relative=path.startsWith(root+'/')?path.slice(root.length+1):'';
        if(['src/pages/dashboard.tsx','src/components/dashboard/DashboardSections.tsx','src/components/dashboard/KnowledgePanel.tsx','src/components/dashboard/HealthStatus.tsx','src/components/dashboard/IntegrationCenter.tsx','src/components/dashboard/NotificationCenter.tsx','src/styles/dashboard.css','src/i18n/dashboard.tsx'].includes(relative)) {
          const source=readFileSync(resolve('/tmp/odinlink-visual-phase5-before',relative),'utf8');
          return id.endsWith('?raw')?'export default '+JSON.stringify(source):source;
        }
      }
      if(process.argv.includes('--phase4-snapshot-before')) {
        const path=id.split('?')[0],relative=path.startsWith(root+'/')?path.slice(root.length+1):'';
        if(['src/components/dashboard/ConversationsPanel.tsx','src/components/dashboard/BookingsPanel.tsx','src/styles/dashboard.css','src/i18n/dashboard.tsx'].includes(relative)) {
          const source=readFileSync(resolve('/tmp/odinlink-visual-phase4-before',relative),'utf8');
          return id.endsWith('?raw')?'export default '+JSON.stringify(source):source;
        }
      }
      if(process.argv.includes('--phase3-snapshot-before')) {
        const path=id.split('?')[0],relative=path.startsWith(root+'/')?path.slice(root.length+1):'';
        if(['src/pages/dashboard.tsx','src/styles/dashboard.css','src/components/dashboard/analytics/AnalyticsPage.tsx','src/i18n/dashboard.tsx','src/components/dashboard/DashboardShell.tsx'].includes(relative)) {
          const source=readFileSync(resolve('/tmp/odinlink-visual-phase3-before',relative),'utf8');
          return id.endsWith('?raw')?'export default '+JSON.stringify(source):source;
        }
      }
      if(process.argv.includes('--snapshot-before')) {
        const path=id.split('?')[0],relative=path.startsWith(root+'/')?path.slice(root.length+1):'';
        if(['src/pages/dashboard.tsx','src/styles/dashboard.css','src/components/dashboard/ConversationsPanel.tsx','src/components/dashboard/DashboardShell.tsx','src/components/dashboard/dashboard-navigation.ts'].includes(relative)) {
          const source=readFileSync(resolve('/tmp/odinlink-visual-phase2-before',relative),'utf8');
          return id.endsWith('?raw')?'export default '+JSON.stringify(source):source;
        }
      }
      if(id==='\0navigation-entry.js') return `import '/src/index.css'; import React from 'react'; import {createRoot} from 'react-dom/client'; import CurrentDashboard from '/src/pages/dashboard.tsx'; const Dashboard=CurrentDashboard; createRoot(document.getElementById('root')).render(React.createElement(Dashboard,{onNavigate:(path)=>window.fixtureCalls.push({method:'onNavigate',id:path})}));`;
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
const before = process.argv.includes('--before');
const out = process.argv[3] && !process.argv[3].startsWith('--') ? resolve(process.argv[3]) : null;
if(out)mkdirSync(out,{recursive:true});
const profiles=[[320,850],[375,850],[390,844],[430,932],[768,1024],[820,1180],[834,1194],[1024,1366],[1024,768],[1180,820],[1194,834],[1366,1024],[1280,900],[1366,900],[1440,1000],[1536,1000],[1728,1100]];
const captures=new Set(['375x850','834x1194','1024x768','1440x1000']);
const measurements=[];const errors=[];let browser;
const luminance=rgb=>rgb.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
const contrastAgainstRaised=color=>{const rgb=color.match(/[\d.]+/g).map(Number);assert.equal(rgb.length,3,'meaningful text uses opaque color');const a=luminance(rgb),b=luminance([23,33,25]);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
try {
  await server.listen();
  const url=`http://127.0.0.1:${server.httpServer.address().port}/__navigation-test`;
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage();page.setDefaultTimeout(12000);page.setDefaultNavigationTimeout(45000);
  page.on('pageerror',e=>errors.push(e.message));
  // Only local fixture resources and public font assets are allowed.
  await page.route('**/*',r=>['127.0.0.1','fonts.googleapis.com','fonts.gstatic.com'].includes(new URL(r.request().url()).hostname)?r.continue():r.abort());
  const load=async(locale='en',fixture='')=>{
    await page.goto(url+'?fixture='+fixture);
    await page.evaluate(value=>localStorage.setItem('odinlink_dashboard_language',value),locale);
    await page.reload();await page.locator(fixture==='zero'?'.content .btn-primary':fixture==='home-loading'||fixture==='home-error'?'.state-card':'#overview').waitFor({state:'visible'});await page.evaluate(()=>document.fonts.ready);
  };
  const primary=async(id)=>{
    const nav=await page.locator('.mobile-bottom-nav').isVisible()?page.locator('.mobile-bottom-nav'):page.locator('.sidebar-nav');
    await nav.locator(`[href="#workspace-${id}"]`).click();
  };
  const open=async(id)=>{
    if(['home','settings','ai-assistant','inbox','bookings'].includes(id))await primary(id);
    else if(id==='reports'){await primary('home');await page.locator('#home-reports-trigger').click();await page.locator('.analytics-kpi-card strong').first().waitFor();}
    else {await primary('settings');await page.locator(`#settings-${id==='business'?'business':id==='health'?'connections':'notifications'}-trigger`).click();if(id==='health')await page.locator('.settings-secondary-nav button').nth(1).click();}
  };
  const measure=async(id,locale)=>{
    const result=await page.evaluate(()=>{
      const visible=e=>e.getClientRects().length&&!e.closest('[hidden]');
      const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
      // Check actual text fragments against every clipping ancestor, not only scrollWidth.
      const inspect=e=>{
        const range=document.createRange();range.selectNodeContents(e);const fragments=[...range.getClientRects()].filter(r=>r.width>0);
        const clips=[];let scrollableY=false;
        for(let a=e;a;a=a.parentElement){const cs=getComputedStyle(a);const r=a.getBoundingClientRect();if(/auto|scroll/.test(cs.overflowY)&&a.scrollHeight>a.clientHeight)scrollableY=true;if(fragments.some(f=>(/hidden|clip|auto|scroll/.test(cs.overflowX)&&(f.left<r.left-1||f.right>r.right+1))||(!scrollableY&&/hidden|clip/.test(cs.overflowY)&&(f.top<r.top-1||f.bottom>r.bottom+1))))clips.push(a.id||a.className);}
        const cs=getComputedStyle(e);return {text:e.textContent,...rect(e),scroll:e.scrollWidth,client:e.clientWidth,clips,font:cs.fontFamily,size:parseFloat(cs.fontSize),color:cs.color,opacity:cs.opacity,direction:cs.direction,bidi:cs.unicodeBidi};
      };
      const headings=[...document.querySelectorAll('.content h1,.content h2,.content h3')].filter(visible).map(inspect);
      const currency=[...document.querySelectorAll('.hero-result-item.accent strong,.analytics-kpi-card.gold strong,.analytics-currency-value')].filter(visible).map(inspect);
      const text=[...document.querySelectorAll('.mission-greeting,.mission-monitoring-copy,.hero-result-copy small,.automatic-health-identity span,.automatic-health-state small,.notification-row-copy>span,.notification-row time,.knowledge-source-meta,.tone-precedence-note,.conversation-title-right small,.conversation-channel-name,.transcript-author,.transcript-message time,.booking-compact-row>time span,.booking-row-copy small,.analytics-kpi-card small,.mobile-nav-item span,.health-load-state>span,.notification-state>span')].filter(visible).map(inspect);
      const actions=[...document.querySelectorAll('.home-workspace-actions button,.analytics-range button,.analytics-tabs button,.settings-index button,.health-action,.health-load-state button,.notification-state button,.analytics-state button,.analytics-custom-range input,.notification-row-actions button')].filter(visible).map(inspect);
      return {pageWidth:document.documentElement.scrollWidth,viewport:innerWidth,headings,currency,text,actions,hidden:[...document.querySelectorAll('.dashboard-workspace[hidden]')].map(e=>({id:e.id,rects:e.getClientRects().length})),primary:[...document.querySelectorAll('.sidebar-nav a')].map(e=>e.getAttribute('href')),mobilePrimary:[...document.querySelectorAll('.mobile-nav-item')].map(e=>e.getAttribute('href')),active:document.querySelector('.sidebar-nav [aria-current]')?.getAttribute('href')};
    });
    measurements.push({profile:page.viewportSize(),id,locale,...result});
    if(!before){
      assert.ok(result.pageWidth<=result.viewport+1,`${id}/${locale}: page overflow ${result.pageWidth}/${result.viewport}`);
      for(const h of result.headings){assert.deepEqual(h.clips,[],`${id}/${locale}: heading clipped ${h.text}`);assert.ok(h.scroll<=h.client+1,`${id}/${locale}: intrinsic heading overflow ${h.text}`);}
      for(const value of result.currency){assert.deepEqual(value.clips,[],`${id}/${locale}: currency clipped ${value.text}`);assert.ok(value.scroll<=value.client+1,'currency intrinsic overflow');assert.equal(value.direction,'ltr','currency amount/code order remains LTR');assert.equal(value.bidi,'isolate','currency isolation in RTL');}
      for(const text of result.text){assert.ok(text.size>=12,`${id}: useful text below 12px: ${text.text} (${text.size})`);assert.ok(contrastAgainstRaised(text.color)>=4.5,`${id}: text contrast below 4.5: ${text.text} (${text.color})`);}
      for(const action of result.actions){assert.ok(action.x>=-1&&action.right<=result.viewport+1,`${id}/${locale}: offscreen action ${action.text}`);assert.ok(action.size>=13,`${id}: tiny action`);assert.ok(action.height>=(result.viewport<=1199?44:40),`${id}: short action`);}
      assert.ok(result.hidden.every(h=>h.rects===0),'hidden workspaces have no layout');
      const destinations=['home','inbox','bookings','ai-assistant','settings'].map(id=>'#workspace-'+id);
      assert.deepEqual(result.primary,destinations);assert.deepEqual(result.mobilePrimary,destinations);
      if(id==='reports')assert.equal(result.active,'#workspace-home');
      assert.deepEqual(await page.evaluate(()=>window.fixtureCalls.filter(c=>/^(update|create|delete|send)/.test(c.method))),[],'navigation performs no configuration writes');
    }
    return result;
  };
  if(process.argv.includes('--rc02b')) {
    const {runRemainingKnowledgeLocalizationChecks} = await import('./dashboard-knowledge-localization.browser.mjs');
    await runRemainingKnowledgeLocalizationChecks({page,load,primary,before,out});
  } else if(process.argv.includes('--rc02')) {
    const {runKnowledgeLocalizationChecks} = await import('./dashboard-knowledge-localization.browser.mjs');
    await runKnowledgeLocalizationChecks({page,load,primary,before,out});
  } else if(process.argv.includes('--rc01')) {
    const {runFocusVisibilityChecks} = await import('./dashboard-focus-visibility.browser.mjs');
    await runFocusVisibilityChecks({page,load,primary,open,out,profiles});
  } else if(process.argv.includes('--phase6')) {
    const {runStateFeedbackChecks} = await import('./dashboard-states.browser.mjs');
    await runStateFeedbackChecks({page,load,primary,open,before,out,measure,profiles});
  } else if(process.argv.includes('--phase5')) {
    const {runAssistantSettingsChecks} = await import('./dashboard-assistant-settings.browser.mjs');
    await runAssistantSettingsChecks({page,load,primary,open,before,out,measure,profiles});
  } else if(process.argv.includes('--phase4')) {
    const {runInboxBookingsChecks} = await import('./dashboard-inbox-bookings.browser.mjs');
    await runInboxBookingsChecks({page,load,primary,open,before,out,measure,profiles});
  } else if(process.argv.includes('--phase3')) {
    const {runHomeReportsChecks} = await import('./dashboard-home-reports.browser.mjs');
    await runHomeReportsChecks({page,load,primary,open,before,out,measure,profiles});
  } else if(process.argv.includes('--phase2')) {
    const {runTabletDialogChecks} = await import('./dashboard-tablet-dialog.browser.mjs');
    await runTabletDialogChecks({page,load,primary,open,before,out,measurements});
  } else {
  for(const [width,height]of before?profiles.filter(([w,h])=>captures.has(w+'x'+h)):profiles){
    await page.setViewportSize({width,height});await load();
    for(const id of ['home','reports','settings','ai-assistant','health','notifications','business','inbox','bookings']){
      await open(id);if(id==='health')await page.locator('.automatic-health-row').first().waitFor();if(id==='notifications')await page.locator('.notification-row').first().waitFor();
      const data=await measure(id,'en');
      if(!before&&id==='business'){
        assert.equal(data.headings.filter(h=>/Business(?: Settings)?/.test(h.text)).length,1,'one Business title retains the existing focus target');
        const group=await page.locator('.working-hours-target-title h3').evaluate(e=>({size:getComputedStyle(e).fontSize,font:getComputedStyle(e).fontFamily}));assert.equal(group.size,'16px');assert.match(group.font,/Inter/);
      }
      if(id==='home'){assert.match(data.currency[0].text,/8,400 SEK \+ 160 EUR/);if(!before)assert.ok(data.headings[0].size>=(width<=1199?24:28)&&data.headings[0].size<=(width<=1199?28:32),'Home identity uses bounded type scale');}
      if(id==='reports')assert.equal(data.currency[0].text,'€50 + SEK\u00a0100');
      if(out&&captures.has(width+'x'+height)&&!['business','inbox','bookings'].includes(id))await page.screenshot({path:resolve(out,width+'x'+height+'-'+id+'.png'),animations:'disabled'});
    }
    if(!before){await open('home');await page.locator('.hero-result-item.accent strong').evaluate(e=>e.scrollIntoView({block:'center',behavior:'instant'}));
      const currency=await page.locator('.hero-result-item.accent strong').evaluate(e=>{const r=e.getBoundingClientRect();const nav=document.querySelector('.mobile-bottom-nav');return {top:r.top,bottom:r.bottom,limit:nav.getClientRects().length?nav.getBoundingClientRect().top:innerHeight};});
      assert.ok(currency.top>=0&&currency.bottom<=currency.limit+1,'all currency buckets reachable above bottom nav');
      await page.locator('#home-reports-trigger').evaluate(e=>e.scrollIntoView({block:'center',behavior:'instant'}));
      const reach=await page.locator('#home-reports-trigger').evaluate(e=>{const r=e.getBoundingClientRect();const nav=document.querySelector('.mobile-bottom-nav');return {top:r.top,bottom:r.bottom,limit:nav.getClientRects().length?nav.getBoundingClientRect().top:innerHeight};});
      assert.ok(reach.top>=0&&reach.bottom<=reach.limit+1,'Reports action reachable above bottom nav');}
    console.log(`${before?'BEFORE':'PASS'} ${width}x${height}`);
  }
  for(const locale of ['en','sv','de','es','fa','ar'])for(const [width,height]of before?[[320,850],[375,850],[834,1194],[1024,768],[1440,1000]]:profiles){
    await page.setViewportSize({width,height});await load(locale,'long-token');
    for(const id of ['home','business','settings','ai-assistant','reports']){await open(id);await measure(id,locale);}
    console.log(`LOCALIZED ${locale} ${width}x${height}`);
    if(out&&width===375) {await open('home');await page.screenshot({path:resolve(out,`375-long-token-${locale}.png`),animations:'disabled'});await open('business');await page.screenshot({path:resolve(out,`375-business-${locale}.png`),animations:'disabled'});}
  }
  if(!before){
    for(const [width,height]of [[320,850],[375,850],[834,1194],[1024,768],[1440,1000]]){
      await page.setViewportSize({width,height});await load();await open('reports');
      await page.locator('.analytics-range button').last().click();const dates=page.locator('.analytics-custom-range input');
      await dates.nth(0).fill('2026-09-01');await dates.nth(1).fill('2026-10-07');await measure('reports-custom','en');
      assert.equal(await dates.nth(0).inputValue(),'2026-09-01');assert.equal(await dates.nth(1).inputValue(),'2026-10-07');
      if(out&&width===375)await page.screenshot({path:resolve(out,'375-reports-custom.png'),animations:'disabled'});
    }
    for(const [width,height]of [[375,850],[834,1194],[1024,768],[1440,1000]]){
      await page.setViewportSize({width,height});await load('en','visual-error');
      for(const id of ['health','notifications']){await open(id);await page.locator(id==='health'?'.health-load-state button':'.notification-state button').waitFor();await measure(id+'-error','en');}
    }
    for(const locale of ['fa','ar'])for(const [width,height]of [[375,850],[834,1194],[1440,1000]]){
      await page.setViewportSize({width,height});await load(locale,'rtl-name-'+locale);await open('home');await measure('home',locale);
      assert.equal(await page.locator('.mission-hero h1').getAttribute('dir'),'auto');
      if(out)await page.screenshot({path:resolve(out,`${width}-native-${locale}.png`),animations:'disabled'});
    }
    await page.setViewportSize({width:375,height:850});await load();await open('home');
    await page.locator('#home-reports-trigger').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('#analytics-title').evaluate(e=>e===document.activeElement),true);
    const focus=await page.locator('#analytics-title').evaluate(e=>({style:getComputedStyle(e).outlineStyle,width:getComputedStyle(e).outlineWidth}));assert.notEqual(focus.style,'none');assert.notEqual(focus.width,'0px');
    await open('ai-assistant');assert.equal(await page.locator('#ai-advanced').getAttribute('open'),null);assert.equal(await page.locator('#prompt-editor').isVisible(),false);
    await page.locator('#ai-advanced summary').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('#prompt-editor').isVisible(),true);
    await open('notifications');const read=page.locator('.notification-row.read').first();assert.equal(await read.evaluate(e=>getComputedStyle(e).opacity),'1','read issues are not disabled-looking');
    await page.emulateMedia({reducedMotion:'reduce'});await load('en','visual-loading');await primary('home');await page.locator('#home-reports-trigger').click();await page.locator('.analytics-skeleton').first().waitFor();assert.equal(await page.locator('.analytics-skeleton').first().evaluate(e=>getComputedStyle(e).animationName),'none');
    await open('health');await page.locator('.health-skeleton i').first().waitFor();assert.equal(await page.locator('.health-skeleton i').first().evaluate(e=>getComputedStyle(e).animationName),'none');
    await open('notifications');await page.locator('.notification-skeleton i').first().waitFor();assert.equal(await page.locator('.notification-skeleton i').first().evaluate(e=>getComputedStyle(e).animationName),'none');
  }
  }
  assert.deepEqual(errors,[],'no browser runtime errors');
  console.log(`Visual foundation: ${measurements.length} page/profile/locale checks; production global CSS included.`);
} finally {
  if(out)writeFileSync(resolve(out,'measurements.json'),JSON.stringify({before,measurements,errors},null,2));
  await browser?.close();await server.close();
}
