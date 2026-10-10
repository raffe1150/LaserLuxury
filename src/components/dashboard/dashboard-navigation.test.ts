import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SETTINGS_AREAS, settingsAreaForNavigation, PRIMARY_DESTINATIONS, dashboardDestinationTitle, dashboardNavigationForTarget, dashboardFocusTarget, initialDashboardNavigation, isDashboardPanelVisible, isMobileConversationLocked } from './dashboard-navigation';

assert.deepEqual(PRIMARY_DESTINATIONS.map(({ label }) => label), ['Home', 'Inbox', 'Bookings', 'AI Assistant', 'Settings']);
assert.deepEqual(initialDashboardNavigation(''), { primary: 'home' });
for (const search of ['?connection=connected&channel=instagram', '?connection=failed&integration=google_calendar', '?channel=whatsapp', '?integration=telegram']) {
  assert.deepEqual(initialDashboardNavigation(search), { primary: 'settings', secondary: 'connections' });
}
assert.deepEqual(initialDashboardNavigation('?unrelated=value'), { primary: 'home' });
for (const [target, expected] of [
  ['#health', { primary: 'settings', secondary: 'connection-health' }],
  ['#activity', { primary: 'bookings' }], ['#bookings', { primary: 'bookings' }],
  ['#conversations', { primary: 'inbox' }], ['#channel-settings', { primary: 'settings', secondary: 'connections' }],
  ['#notification-center', { primary: 'settings', secondary: 'notification-center' }],
  ['#knowledge', { primary: 'ai-assistant', secondary: 'knowledge' }],
  ['#prompt-editor', { primary: 'ai-assistant', secondary: 'prompt-editor' }],
  ['#ai-tone', { primary: 'ai-assistant', secondary: 'ai-tone' }],
  ['#usage-statistics', { primary: 'settings' }],
  ['#businesses', { primary: 'settings', secondary: 'businesses' }],
  ['#business-settings', { primary: 'settings', secondary: 'business-settings' }],
  ['#cancellation-settings', { primary: 'settings', secondary: 'cancellation-settings' }],
  ['#admin-notifications', { primary: 'settings', secondary: 'admin-notifications' }],
  ['#analytics', { primary: 'home', secondary: 'reports' }],
  ['#reports', { primary: 'home', secondary: 'reports' }],
] as const) assert.deepEqual(dashboardNavigationForTarget(target), expected);
assert.equal(dashboardNavigationForTarget('https://untrusted.example'), null);
assert.equal(dashboardNavigationForTarget('#unknown'), null);
assert.equal(dashboardFocusTarget({ primary: 'settings', secondary: 'connection-health' }), 'connection-health-title');
assert.equal(dashboardFocusTarget({ primary: 'settings', secondary: 'connections' }), 'settings-connections-title');
assert.equal(isDashboardPanelVisible({ primary: 'home' }, 'settings', 'connections'), false);
assert.equal(isDashboardPanelVisible({ primary: 'settings' }, 'settings', 'connections'), false);
assert.equal(isDashboardPanelVisible({ primary: 'settings', secondary: 'connections' }, 'settings', 'connections'), true);
for (const active of [false, true]) for (const open of [false, true]) assert.equal(isMobileConversationLocked(active, open), active && open);
const notifications = readFileSync(new URL('./NotificationCenter.tsx', import.meta.url), 'utf8');
assert.doesNotMatch(notifications, /sidebar-nav|querySelector/);
assert.match(notifications, /await markRead\(item\)/);
assert.match(notifications, /dashboardNavigationForTarget\(item\.actionTarget\)/);
const health = readFileSync(new URL('./HealthStatus.tsx', import.meta.url), 'utf8');
assert.doesNotMatch(health, /scrollIntoView/);
assert.match(health, /onWorkspaceNavigate\(\{ primary: 'settings', secondary: 'connections' \}\)/);
const inbox = readFileSync(new URL('./ConversationsPanel.tsx', import.meta.url), 'utf8');
assert.match(inbox, /isMobileConversationLocked\(active, mobileChatOpen && mobileViewport\)/);
assert.match(inbox, /classList\.remove\('mobile-conversation-open'\)/);
const navigation = readFileSync(new URL('./dashboard-navigation.ts', import.meta.url), 'utf8');
assert.doesNotMatch(navigation, /services\/api|updateBusiness|createBusiness|fetch\(/);
console.log('Explicit destinations, contextual mapping and mobile-lock tests passed.');

assert.equal(dashboardFocusTarget({ primary: 'home', secondary: 'reports' }), 'analytics-title');
assert.equal(dashboardFocusTarget({ primary: 'home' }, { primary: 'home', secondary: 'reports' }), 'home-reports-trigger');
assert.equal(dashboardFocusTarget({ primary: 'home' }), 'workspace-home');
assert.equal(isDashboardPanelVisible({ primary: 'home', secondary: 'reports' }, 'home'), true);
assert.equal(isDashboardPanelVisible({ primary: 'home', secondary: 'reports' }, 'home', 'reports'), true);
assert.equal(isDashboardPanelVisible({ primary: 'home' }, 'home', 'reports'), false);
assert.equal(isDashboardPanelVisible({ primary: 'inbox' }, 'home', 'reports'), false);

assert.equal(dashboardFocusTarget({primary:'ai-assistant',secondary:'prompt-editor'}),'prompt-editor');
assert.equal(dashboardFocusTarget({primary:'ai-assistant',secondary:'knowledge'}),'knowledge');
assert.equal(isDashboardPanelVisible({primary:'ai-assistant',secondary:'knowledge'},'ai-assistant'),true);

assert.deepEqual(SETTINGS_AREAS.map(area=>area.label),['Business','Connections','Notifications']);
for (const area of SETTINGS_AREAS) {
  assert.ok(area.description);
  const destination = {primary:'settings',secondary:area.secondary} as const;
  assert.equal(settingsAreaForNavigation(destination),area.id);
  assert.equal(dashboardFocusTarget({primary:'settings'},destination),`settings-${area.id}-trigger`);
}
for(const [secondary,area] of [['cancellation-settings','business'],['connection-health','connections'],['admin-notifications','notifications']] as const){
  assert.equal(settingsAreaForNavigation({primary:'settings',secondary}),area);
  assert.equal(dashboardFocusTarget({primary:'settings'},{primary:'settings',secondary}),`settings-${area}-trigger`);
}
assert.equal(settingsAreaForNavigation({primary:'settings'}),null);
assert.equal(settingsAreaForNavigation({primary:'home'}),null);
assert.equal(settingsAreaForNavigation({primary:'settings',secondary:'businesses'}),null);
assert.equal(dashboardFocusTarget({primary:'settings',secondary:'cancellation-settings'}),'cancellation-title');
assert.equal(dashboardFocusTarget({primary:'settings',secondary:'admin-notifications'}),'business-alerts-title');
for(const target of ['#usage-statistics','usage-statistics','#usage','usage']) {
  const safeDestination=dashboardNavigationForTarget(target);
  assert.deepEqual(safeDestination,{primary:'settings'});
  assert.equal(dashboardFocusTarget(safeDestination!),'workspace-settings');
  assert.equal(dashboardFocusTarget(safeDestination!,{primary:'settings',secondary:'notification-center'}),'settings-notifications-trigger');
}
const dashboard=readFileSync(new URL('../../pages/dashboard.tsx',import.meta.url),'utf8');
assert.doesNotMatch(dashboard,/UsageStatistics|usage-statistics|settings-usage-trigger|data\.usage/,'dashboard never renders the retained Usage component');
const sections=readFileSync(new URL('./DashboardSections.tsx',import.meta.url),'utf8');
assert.match(sections,/export function UsageStatistics\(/,'Usage presentation source is retained for future metering work');
const api=readFileSync(new URL('../../services/api.ts',import.meta.url),'utf8');
assert.match(api,/getUsage: \(businessId: string\)/);
assert.match(api,/api\.getUsage\(selectedBusiness\.id\)\.catch\(\(\) => defaultUsage\)/,'shared data-loading contract remains untouched');
console.log('Usage rendering removed; legacy targets return to Settings; component/API contract retained.');
console.log('Settings areas, legacy contextual targets and focus restoration passed.');
for (const destination of PRIMARY_DESTINATIONS) assert.equal(dashboardDestinationTitle({primary:destination.id}),destination.label);
assert.equal(dashboardDestinationTitle({primary:'home',secondary:'reports'}),'Reports');
for (const [secondary,title] of [['business-settings','Business'],['connections','Connections'],['connection-health','Connection health'],['notification-center','Notifications'],['admin-notifications','Business alerts'],['businesses','Manage Businesses'],['cancellation-settings','Cancellation policy']] as const) {
  assert.equal(dashboardDestinationTitle({primary:'settings',secondary}),title);
}
assert.equal(dashboardDestinationTitle({primary:'ai-assistant',secondary:'prompt-editor'}),'AI Assistant');
