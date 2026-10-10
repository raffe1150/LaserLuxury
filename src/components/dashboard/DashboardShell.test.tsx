import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import DashboardShell, { SCROLL_TO_TOP_THRESHOLD, scrollDashboardToTop, shouldShowScrollToTop } from './DashboardShell';
import { PRIMARY_DESTINATIONS, type DashboardNavigation } from './dashboard-navigation';

function renderShell(navigation: DashboardNavigation, unread = 0) {
  return renderToStaticMarkup(<DashboardShell title="Dashboard" navigation={navigation} notificationUnreadCount={unread}
    businesses={[{ id: '7', name: 'Seven' }, { id: '8', name: 'Eight' }]} selectedBusinessId="8"
    onWorkspaceNavigate={() => undefined} onAddBusiness={() => undefined} onNavigate={() => undefined} onSignOut={() => undefined}>
    <section id="workspace-home">Home</section>
  </DashboardShell>);
}

for (const destination of PRIMARY_DESTINATIONS) {
  const markup = renderShell({ primary: destination.id });
  const desktop = markup.match(/<nav class="sidebar-nav"[\s\S]*?<\/nav>/)![0];
  const mobile = markup.match(/<nav class="mobile-bottom-nav"[\s\S]*?<\/nav>/)![0];
  for (const nav of [desktop, mobile]) {
    assert.equal((nav.match(/<a /g) || []).length, 5);
    for (const item of PRIMARY_DESTINATIONS) assert.match(nav, new RegExp(`href="#workspace-${item.id}"`));
    assert.equal((nav.match(/aria-current="page"/g) || []).length, 1);
    assert.match(nav, new RegExp(`href="#workspace-${destination.id}"[^>]*aria-current="page"`));
  }
  assert.match(markup, /<option value="8"[^>]*selected=""/);
  assert.match(markup, />Account<\/summary>/);
  assert.match(markup, /Manage Businesses/);
  assert.match(markup, /Add Business/);
  assert.match(markup, /Sign out/);
  assert.match(markup, /aria-label="Dashboard language"/);
  assert.doesNotMatch(markup, /Usage|Usage Statistics|Plan|Billing|credits/i);
}
const settingsMarkup = renderShell({ primary: 'settings', secondary: 'notification-center' }, 7);
assert.match(settingsMarkup, /aria-label="7 unread notifications"/);
assert.match(settingsMarkup, /href="#workspace-settings" aria-current="page"/);
assert.doesNotMatch(settingsMarkup, /href="#usage-statistics"|href="#health"/);
const shell = readFileSync(new URL('./DashboardShell.tsx', import.meta.url), 'utf8');
const focusRevealStart = shell.indexOf('  const revealFocusedFormControl =');
const focusRevealEnd = shell.indexOf('\n  const closeAccount', focusRevealStart);
assert.ok(focusRevealStart > 0 && focusRevealEnd > focusRevealStart);
const focusReveal = shell.slice(focusRevealStart, focusRevealEnd);
assert.match(focusReveal, /closest\('#workspace-ai-assistant, #workspace-settings'\)/);
assert.match(focusReveal, /behavior: 'instant'/);
assert.doesNotMatch(focusReveal, /\.focus\(|preventDefault|api\./, 'reveal cannot change focus order or write data');
assert.doesNotMatch(shell.slice(0, focusRevealStart) + shell.slice(focusRevealEnd),
  /getBoundingClientRect|resolveActiveDashboardSection|setActiveSection/, 'navigation remains independent of scroll geometry');
assert.match(shell, /target\.closest\('\[hidden\]'\)/);
assert.match(shell, /className="topbar-title" translate="no"/,'React owns the translated dynamic title; the legacy DOM translator must not overwrite it');
assert.match(shell, /onChange=\{\(event\) => handleBusinessSelection\(event\.target\.value\)\}/);
assert.ok(shell.indexOf('<div className="topbar">') < shell.indexOf('<div className="content"'));
const css = readFileSync(new URL('../../styles/dashboard.css', import.meta.url), 'utf8');
assert.match(css, /\.dashboard-page \[hidden\]\{display:none !important;/);
assert.match(css, /grid-template-areas:"brand account" "title account" "business business"/);
assert.match(css, /grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
assert.equal(shouldShowScrollToTop(SCROLL_TO_TOP_THRESHOLD - 1), false);
assert.equal(shouldShowScrollToTop(SCROLL_TO_TOP_THRESHOLD), true);
const calls: ScrollToOptions[] = [];
const scroller = { scrollTo: (options: ScrollToOptions) => calls.push(options) };
scrollDashboardToTop(scroller, false);
scrollDashboardToTop(scroller, true);
assert.deepEqual(calls, [{ top: 0, behavior: 'smooth' }, { top: 0, behavior: 'auto' }]);
console.log('Five-destination shell and account tests passed.');
