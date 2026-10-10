import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import { PRIMARY_DESTINATIONS, dashboardFocusTarget, type DashboardNavigation, type NavigateDashboard } from './dashboard-navigation';
import type { Business } from '../../types/dashboard';
import { DASHBOARD_LOCALE_OPTIONS, useDashboardI18n } from '../../i18n/dashboard';

interface DashboardShellProps {
  title: string;
  contentReady?: boolean;
  businesses?: Business[];
  selectedBusinessId?: string;
  businessName?: string;
  onNavigate: (path: '/' | '/login' | '/dashboard') => void;
  onBusinessChange?: (businessId: string) => void;
  onSignOut?: () => void | Promise<void>;
  navigation: DashboardNavigation;
  onWorkspaceNavigate: NavigateDashboard;
  onAddBusiness: () => void;
  notificationUnreadCount?: number;
  children: ReactNode;
}

export const SCROLL_TO_TOP_THRESHOLD = 500;

export function shouldShowScrollToTop(scrollTop: number): boolean {
  return scrollTop >= SCROLL_TO_TOP_THRESHOLD;
}

export function scrollDashboardToTop(
  scroller: { scrollTo(options: ScrollToOptions): void },
  reducedMotion: boolean,
) {
  scroller.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
}

export function resetDashboardContentScroll(
  scroller: { scrollTo(options: ScrollToOptions): void },
) {
  scroller.scrollTo({ top: 0, behavior: 'auto' });
}

function MobileNavIcon({ icon }: { icon: (typeof PRIMARY_DESTINATIONS)[number]['icon'] }) {
  if (icon === 'home') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="m3 11 9-7 9 7" />
        <path d="M5 10v10h14V10" />
        <path d="M9 20v-6h6v6" />
      </svg>
    );
  }

  if (icon === 'inbox') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 5h16v14H4z" />
        <path d="M4 14h4l2 3h4l2-3h4" />
      </svg>
    );
  }

  if (icon === 'calendar') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M8 3v4M16 3v4M3 10h18" />
      </svg>
    );
  }

  if (icon === 'assistant') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="m4 20 12-12 4 4-12 12M16 3v3M21 7h-3M5 5v4M3 7h4" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 7h16M4 17h16" />
      <circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" />
    </svg>
  );
}

export default function DashboardShell({
  title,
  contentReady = true,
  businesses = [],
  selectedBusinessId,
  businessName,
  onNavigate,
  onBusinessChange,
  onSignOut,
  navigation,
  onWorkspaceNavigate,
  onAddBusiness,
  notificationUnreadCount = 0,
  children,
}: DashboardShellProps) {
  const { locale, setLocale, t } = useDashboardI18n();
  const [showScrollToTop, setShowScrollToTop] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const accountRef = useRef<HTMLDetailsElement>(null);
  const previousWorkspace = useRef({ navigation, selectedBusinessId });
  const lastWorkspaceFocusTarget = useRef<string | null>(null);

  const revealFocusedFormControl = (event: FocusEvent<HTMLDivElement>) => {
    const control = event.target;
    if (!(control instanceof HTMLElement) || !control.matches('input, textarea, select, button') ||
        !control.closest('#workspace-ai-assistant, #workspace-settings') ||
        control.closest('dialog, [role="dialog"]')) return;
    // Native textarea focus can reveal only the caret. Reveal the whole field
    // after that scroll, using the content scroller's safe-area padding.
    window.requestAnimationFrame(() => {
      const content = contentRef.current;
      if (document.activeElement !== control || !content?.contains(control) || control.closest('[hidden]')) return;
      const bounds = control.getBoundingClientRect();
      const viewport = content.getBoundingClientRect();
      const dashboard = content.closest('.dashboard-page');
      const nav = dashboard?.querySelector('.mobile-bottom-nav');
      const floating = dashboard?.querySelector('.scroll-to-top');
      const floatingBounds = floating?.getBoundingClientRect();
      const bottom = Math.min(viewport.bottom, window.innerHeight,
        nav?.getClientRects().length ? nav.getBoundingClientRect().top : window.innerHeight,
        floatingBounds && bounds.left < floatingBounds.right && bounds.right > floatingBounds.left
          ? floatingBounds.top : window.innerHeight);
      if (control instanceof HTMLTextAreaElement || bounds.top < Math.max(0, viewport.top) + 5 || bounds.bottom > bottom - 5) {
        control.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      }
    });
  };

  const closeAccount = () => {
    const account = accountRef.current;
    if (!account?.open) return;
    account.open = false;
    account.querySelector('summary')?.focus();
  };

  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    }
    const content = contentRef.current;
    if (!content) return;
    const updateScrollButton = () => setShowScrollToTop(shouldShowScrollToTop(content.scrollTop));
    content.addEventListener('scroll', updateScrollButton, { passive: true });
    return () => content.removeEventListener('scroll', updateScrollButton);
  }, []);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    resetDashboardContentScroll(content);
    setShowScrollToTop(false);
    const previous = previousWorkspace.current;
    if (previous.selectedBusinessId !== selectedBusinessId && accountRef.current) accountRef.current.open = false;
    // A business mutation can reload the workspace after the dialog closes.
    // Wait for its visible content instead of focusing a soon-to-be-removed node.
    if (!contentReady) return;
    const workspaceChanged = previous.navigation !== navigation || previous.selectedBusinessId !== selectedBusinessId;
    const targetId = workspaceChanged
      ? dashboardFocusTarget(navigation, previous.selectedBusinessId === selectedBusinessId ? previous.navigation : undefined)
      : lastWorkspaceFocusTarget.current || dashboardFocusTarget(navigation);
    previousWorkspace.current = { navigation, selectedBusinessId };
    const target = document.getElementById(targetId);
    if (!target || target.closest('[hidden]')) return;
    lastWorkspaceFocusTarget.current = targetId;
    // Keep native controls in the tab order when restoring focus.
    if (target.tabIndex < 0) target.tabIndex = -1;
    target.focus({ preventScroll: true });
    // Returning from Reports restores its trigger, including below-the-fold Home layouts.
    if (target.id === 'home-reports-trigger') target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }, [navigation, selectedBusinessId, contentReady]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeAccount();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.dashboard-business-dialog')) return;
      const account = accountRef.current;
      if (account?.open && event.target instanceof Node && !account.contains(event.target)) account.open = false;
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, []);

  const openWorkspace = (destination: DashboardNavigation) => {
    closeAccount();
    onWorkspaceNavigate(destination);
  };

  const handleBusinessSelection = (businessId: string) => {
    closeAccount();
    onWorkspaceNavigate({ primary: 'home' });
    onBusinessChange?.(businessId);
  };

  const handleScrollToTop = () => {
    const content = contentRef.current;
    if (!content) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    scrollDashboardToTop(content, reducedMotion);
  };

  return (
    <>
      <aside className="sidebar">
        <button className="sidebar-logo shell-button" type="button" onClick={() => onNavigate('/')}>
          <svg width="30" height="30" viewBox="0 0 36 36" fill="none">
            <rect width="36" height="36" rx="10" fill="#3ddc84" />
            <path
              d="M10 22 L18 10 L26 22"
              stroke="#060a07"
              strokeWidth="2.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
            <circle cx="18" cy="26" r="2.5" fill="#060a07" />
            <path d="M14 22 L22 22" stroke="#060a07" strokeWidth="2.8" strokeLinecap="round" />
          </svg>
          Odinlink
        </button>

        <nav className="sidebar-nav" aria-label={t('Dashboard sections')}>
          {PRIMARY_DESTINATIONS.map((item) => (
            <a key={item.id}
              className={navigation.primary === item.id ? 'nav-item active' : 'nav-item'}
              href={`#workspace-${item.id}`}
              aria-current={navigation.primary === item.id ? 'page' : undefined}
              onClick={(event) => { event.preventDefault(); openWorkspace({ primary: item.id }); }}
            >
              <span>{t(item.label)}</span>
            </a>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="avatar">{businessName?.slice(0, 1).toUpperCase() || 'B'}</div>
          <div>
            <div className="sidebar-user-name" translate="no">{businessName || t('Select business')}</div>
            <div className="sidebar-user-role">{t('Tenant dashboard')}</div>
          </div>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <button className="mobile-brand shell-button" type="button" onClick={() => onNavigate('/')} aria-label={t('Open OdinLink landing page')}>
            <svg width="30" height="30" viewBox="0 0 36 36" fill="none">
              <rect width="36" height="36" rx="10" fill="#3ddc84" />
              <path d="M10 22 L18 10 L26 22" stroke="#060a07" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="18" cy="26" r="2.5" fill="#060a07" />
              <path d="M14 22 L22 22" stroke="#060a07" strokeWidth="2.8" strokeLinecap="round" />
            </svg>
            <span>Odinlink</span>
          </button>

          <span className="topbar-title" translate="no">{t(title)}</span>

          <div className="topbar-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
              <circle cx="11" cy="11" r="6" />
              <path d="M20 20L16.65 16.65" />
            </svg>
            <select
              aria-label={t('Selected business')}
              value={selectedBusinessId || ''}
              onChange={(event) => handleBusinessSelection(event.target.value)}
            >
              {businesses.length === 0 ? (
                <option value="">{t('No businesses')}</option>
              ) : (
                businesses.map((business) => (
                  <option key={business.id} value={business.id} translate="no">
                    {business.name}
                  </option>
                ))
              )}
            </select>
          </div>

          <details className="dashboard-account" ref={accountRef}>
            <summary className="topbar-btn ghost" aria-controls="dashboard-account-panel">{t('Account')}</summary>
            <div id="dashboard-account-panel" className="dashboard-account-panel">
              <button className="btn btn-ghost" type="button" onClick={() => openWorkspace({ primary: 'settings', secondary: 'businesses' })}>{t('Manage Businesses')}</button>
              <button className="btn btn-ghost" type="button" onClick={onAddBusiness}>{t('Add Business')}</button>
              <button className="btn btn-ghost" type="button" onClick={() => openWorkspace({ primary: 'settings', secondary: 'notification-center' })}>
                {t('Notifications')}
                {notificationUnreadCount > 0 && <span className="nav-badge" aria-label={t('{count} unread notifications', { count: notificationUnreadCount })}>{notificationUnreadCount > 99 ? '99+' : notificationUnreadCount}</span>}
              </button>
              <label className="dashboard-language-control">
                <span>{t('Dashboard language')}</span>
                <select aria-label={t('Dashboard language')} value={locale} onChange={(event) => setLocale(event.target.value as typeof locale)}>
                  {DASHBOARD_LOCALE_OPTIONS.map((option) => <option key={option.value} value={option.value} lang={option.value}>{option.label}</option>)}
                </select>
              </label>
              <button className="btn btn-ghost" type="button" onClick={() => { closeAccount(); void onSignOut?.(); }}>{t('Sign out')}</button>
              <button className="btn btn-ghost" type="button" onClick={() => { closeAccount(); onNavigate('/'); }}>{t('Landing')}</button>
            </div>
          </details>
        </div>

        <div className="content" ref={contentRef} onFocusCapture={revealFocusedFormControl}>{children}</div>

        {showScrollToTop && (
          <button className="scroll-to-top" type="button" aria-label={t('Back to top')} onClick={handleScrollToTop}>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="m6 15 6-6 6 6" />
            </svg>
          </button>
        )}
      </div>

      <nav className="mobile-bottom-nav" aria-label={t('Mobile dashboard navigation')}>
        {PRIMARY_DESTINATIONS.map((item) => (
          <a
            key={item.id}
            href={`#workspace-${item.id}`}
            className={navigation.primary === item.id ? 'mobile-nav-item active' : 'mobile-nav-item'}
            aria-current={navigation.primary === item.id ? 'page' : undefined}
            onClick={(event) => { event.preventDefault(); openWorkspace({ primary: item.id }); }}
          >
            <MobileNavIcon icon={item.icon} />
            <span>{t(item.label)}</span>
          </a>
        ))}
      </nav>
    </>
  );
}
