import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import DashboardShell, {
  getMobileActiveSection,
  resolveActiveDashboardSection,
  SCROLL_TO_TOP_THRESHOLD,
  scrollDashboardToTop,
  shouldShowScrollToTop,
  type DashboardSectionId,
} from './DashboardShell';

function renderShell(activeSection: DashboardSectionId): string {
  return renderToStaticMarkup(
    <DashboardShell
      title="Dashboard"
      initialActiveSection={activeSection}
      onNavigate={() => undefined}
    >
      <section id="overview">Dashboard</section>
    </DashboardShell>,
  );
}

function assertOnlyDesktopSectionIsCurrent(markup: string, sectionId: DashboardSectionId) {
  assert.match(markup, new RegExp(`href="#${sectionId}" aria-current="page"`));

  const currentItems = markup.match(/aria-current="page"/g) || [];
  assert.equal(currentItems.length, 2, 'one desktop and one mobile item should be current');
}

function runTests() {
  const dashboardCss = readFileSync(new URL('../../styles/dashboard.css', import.meta.url), 'utf8');
  const shellSource = readFileSync(new URL('./DashboardShell.tsx', import.meta.url), 'utf8');
  const mainRule = dashboardCss.match(/\/\* ── MAIN ── \*\/\s*\.main\{([\s\S]*?)\}/)?.[1] || '';
  const desktopTopbarRule = dashboardCss.match(/\/\* TOP BAR \*\/\s*\.topbar\{([\s\S]*?)\}/)?.[1] || '';
  const contentRule = dashboardCss.match(/\/\* CONTENT \*\/\s*\.content\{([\s\S]*?)\}/)?.[1] || '';
  const pageRule = dashboardCss.match(/\.dashboard-page\{([\s\S]*?)\}/)?.[1] || '';
  assert.match(mainRule, /display:grid/);
  assert.match(mainRule, /grid-template-rows:auto minmax\(0,1fr\)/);
  assert.match(desktopTopbarRule, /position:relative/);
  assert.doesNotMatch(desktopTopbarRule, /position:sticky/);
  assert.match(desktopTopbarRule, /z-index:20/);
  assert.match(desktopTopbarRule, /background:rgba\(6,10,7,\.94\)/);
  assert.match(contentRule, /min-height:0/);
  assert.match(contentRule, /overflow-y:auto/);
  assert.match(pageRule, /height:100dvh/);
  assert.ok(
    shellSource.indexOf('<div className="topbar">') < shellSource.indexOf('<div className="content"'),
    'the non-scrolling topbar row must precede the content scroll row',
  );
  assert.match(shellSource, /const content = contentRef\.current/);
  assert.match(shellSource, /className="content" ref=\{contentRef\}/);

  const usageMarkup = renderShell('usage-statistics');
  assertOnlyDesktopSectionIsCurrent(usageMarkup, 'usage-statistics');
  assert.doesNotMatch(usageMarkup, /href="#notification-center" aria-current="page"/);
  assert.match(usageMarkup, /href="#businesses"[^>]*aria-current="page"/);

  const notificationsMarkup = renderShell('notification-center');
  assertOnlyDesktopSectionIsCurrent(notificationsMarkup, 'notification-center');
  assert.doesNotMatch(notificationsMarkup, /href="#usage-statistics" aria-current="page"/);

  assert.notEqual(usageMarkup, notificationsMarkup, 'changing sections must update aria-current');
  assert.equal(getMobileActiveSection('usage-statistics'), 'businesses');
  assert.equal(getMobileActiveSection('notification-center'), 'businesses');
  assert.equal(getMobileActiveSection('activity'), 'bookings');

  assert.equal(
    resolveActiveDashboardSection([
      { id: 'notification-center', top: 120 },
      { id: 'usage-statistics', top: 180 },
    ], 220),
    'usage-statistics',
    'the geometrically current section must win regardless of navigation-array order',
  );
  assert.equal(
    resolveActiveDashboardSection([
      { id: 'notification-center', top: 180 },
      { id: 'usage-statistics', top: 320 },
    ], 220),
    'notification-center',
  );

  assert.doesNotMatch(usageMarkup, /aria-label="Back to top"/);
  assert.equal(shouldShowScrollToTop(SCROLL_TO_TOP_THRESHOLD - 1), false);
  assert.equal(shouldShowScrollToTop(SCROLL_TO_TOP_THRESHOLD), true);

  const scrollCalls: ScrollToOptions[] = [];
  const scroller = { scrollTo: (options: ScrollToOptions) => scrollCalls.push(options) };
  scrollDashboardToTop(scroller, false);
  scrollDashboardToTop(scroller, true);
  assert.deepEqual(scrollCalls, [
    { top: 0, behavior: 'smooth' },
    { top: 0, behavior: 'auto' },
  ]);

  console.log('Dashboard shell navigation and scroll tests passed.');
}

runTests();
