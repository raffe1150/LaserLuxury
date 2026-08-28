import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { Business } from '../../types/dashboard';
import { DASHBOARD_LOCALE_OPTIONS, useDashboardI18n } from '../../i18n/dashboard';

interface DashboardShellProps {
  title: string;
  businesses?: Business[];
  selectedBusinessId?: string;
  businessName?: string;
  onNavigate: (path: '/' | '/login' | '/dashboard') => void;
  onBusinessChange?: (businessId: string) => void;
  onSignOut?: () => void | Promise<void>;
  initialActiveSection?: DashboardSectionId;
  notificationUnreadCount?: number;
  children: ReactNode;
}

const NAV_ITEMS = [
  { id: 'overview', label: 'Dashboard', group: 'Overview' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'health', label: 'Health' },
  { id: 'conversations', label: 'Conversations', group: 'Management' },
  { id: 'bookings', label: 'Bookings' },
  { id: 'businesses', label: 'Businesses' },
  { id: 'business-settings', label: 'Business Settings' },
  { id: 'ai-tone', label: 'AI Tone' },
  { id: 'prompt-editor', label: 'Prompt Editor' },
  { id: 'channel-settings', label: 'Channel Settings' },
  { id: 'usage-statistics', label: 'Usage' },
  { id: 'notification-center', label: 'Notifications' },
] as const;

const MOBILE_NAV_ITEMS = [
  { id: 'overview', label: 'Home', icon: 'home' },
  { id: 'analytics', label: 'Analytics', icon: 'analytics' },
  { id: 'conversations', label: 'Inbox', icon: 'inbox' },
  { id: 'bookings', label: 'Bookings', icon: 'calendar' },
  { id: 'businesses', label: 'More', icon: 'more' },
] as const;

export type DashboardSectionId = (typeof NAV_ITEMS)[number]['id'];
type MobileSectionId = (typeof MOBILE_NAV_ITEMS)[number]['id'];

export const SCROLL_TO_TOP_THRESHOLD = 500;

export function resolveActiveDashboardSection(
  sectionPositions: ReadonlyArray<{ id: DashboardSectionId; top: number }>,
  activationLine: number,
): DashboardSectionId {
  let active: DashboardSectionId = 'overview';
  let activeTop = Number.NEGATIVE_INFINITY;

  for (const section of sectionPositions) {
    if (section.top <= activationLine && section.top > activeTop) {
      active = section.id;
      activeTop = section.top;
    }
  }

  return active;
}

export function getMobileActiveSection(activeSection: DashboardSectionId): MobileSectionId {
  if (activeSection === 'overview' || activeSection === 'analytics' || activeSection === 'conversations') {
    return activeSection;
  }
  if (activeSection === 'bookings') return 'bookings';
  return 'businesses';
}

export function shouldShowScrollToTop(scrollTop: number): boolean {
  return scrollTop >= SCROLL_TO_TOP_THRESHOLD;
}

export function scrollDashboardToTop(
  scroller: { scrollTo(options: ScrollToOptions): void },
  reducedMotion: boolean,
) {
  scroller.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
}

export function getDashboardSectionScrollTop(
  sectionId: DashboardSectionId,
  currentScrollTop: number,
  contentTop: number,
  sectionTop: number,
  scrollMarginTop: number,
): number {
  if (sectionId === 'overview') return 0;
  return Math.max(0, currentScrollTop + sectionTop - contentTop - scrollMarginTop);
}

export function scrollDashboardToSection(
  scroller: { scrollTop: number; scrollTo(options: ScrollToOptions): void },
  sectionId: DashboardSectionId,
  contentTop: number,
  sectionTop: number,
  scrollMarginTop: number,
) {
  scroller.scrollTo({
    top: getDashboardSectionScrollTop(
      sectionId,
      scroller.scrollTop,
      contentTop,
      sectionTop,
      scrollMarginTop,
    ),
    behavior: 'auto',
  });
}

export function resetDashboardContentScroll(
  scroller: { scrollTo(options: ScrollToOptions): void },
) {
  scroller.scrollTo({ top: 0, behavior: 'auto' });
}

function MobileNavIcon({ icon }: { icon: (typeof MOBILE_NAV_ITEMS)[number]['icon'] }) {
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

  if (icon === 'analytics') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 19V9M10 19V5M16 19v-7M22 19H2" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </svg>
  );
}

export default function DashboardShell({
  title,
  businesses = [],
  selectedBusinessId,
  businessName,
  onNavigate,
  onBusinessChange,
  onSignOut,
  initialActiveSection = 'overview',
  notificationUnreadCount = 0,
  children,
}: DashboardShellProps) {
  const { locale, setLocale, t } = useDashboardI18n();
  const [activeSection, setActiveSection] = useState<DashboardSectionId>(initialActiveSection);
  const [showScrollToTop, setShowScrollToTop] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const previousBusinessIdRef = useRef(selectedBusinessId);

  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    }

    const content = contentRef.current;
    if (!content) return;

    const updateNavigationState = () => {
      const contentTop = content.getBoundingClientRect().top;
      const activationLine = contentTop + Math.min(170, window.innerHeight * 0.24);
      const sectionPositions = NAV_ITEMS.flatMap((item) => {
        const section = document.getElementById(item.id);
        return section ? [{ id: item.id, top: section.getBoundingClientRect().top }] : [];
      });

      setActiveSection(resolveActiveDashboardSection(sectionPositions, activationLine));
      setShowScrollToTop(shouldShowScrollToTop(content.scrollTop));
    };

    updateNavigationState();
    content.addEventListener('scroll', updateNavigationState, { passive: true });
    window.addEventListener('resize', updateNavigationState);

    return () => {
      content.removeEventListener('scroll', updateNavigationState);
      window.removeEventListener('resize', updateNavigationState);
    };
  }, []);

  useEffect(() => {
    if (previousBusinessIdRef.current !== selectedBusinessId) {
      const content = contentRef.current;
      if (content && content.scrollTop !== 0) {
        resetDashboardContentScroll(content);
      }
      setActiveSection('overview');
      previousBusinessIdRef.current = selectedBusinessId;
    }
  }, [selectedBusinessId]);

  const handleSectionClick = (event: MouseEvent<HTMLAnchorElement>, sectionId: DashboardSectionId) => {
    event.preventDefault();

    const content = contentRef.current;
    const section = document.getElementById(sectionId);
    if (!content || !section) return;

    setActiveSection(sectionId);
    const scrollMarginTop = Number.parseFloat(window.getComputedStyle(section).scrollMarginTop) || 0;
    scrollDashboardToSection(
      content,
      sectionId,
      content.getBoundingClientRect().top,
      section.getBoundingClientRect().top,
      scrollMarginTop,
    );
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  };

  const handleBusinessSelection = (businessId: string) => {
    const content = contentRef.current;
    if (content && content.scrollTop !== 0) {
      resetDashboardContentScroll(content);
    }
    setActiveSection('overview');
    onBusinessChange?.(businessId);
  };

  const mobileActiveSection = getMobileActiveSection(activeSection);

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
          {NAV_ITEMS.map((item, index) => (
            <div key={item.id}>
              {'group' in item && item.group && (
                <div
                  className="nav-group-label"
                  style={index > 0 ? { marginTop: 8 } : undefined}
                >
                  {t(item.group)}
                </div>
              )}
              <a
                className={activeSection === item.id ? 'nav-item active' : 'nav-item'}
                href={`#${item.id}`}
                aria-current={activeSection === item.id ? 'page' : undefined}
                onClick={(event) => handleSectionClick(event, item.id)}
              >
                <span>{t(item.label)}</span>
                {item.id === 'notification-center' && notificationUnreadCount > 0 && (
                  <span className="nav-badge" aria-label={t('{count} unread notifications', { count: notificationUnreadCount })}>
                    {notificationUnreadCount > 99 ? '99+' : notificationUnreadCount}
                  </span>
                )}
              </a>
            </div>
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

          <span className="topbar-title">{t(title)}</span>

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

          <div className="topbar-right">
            <label className="dashboard-language-control">
              <span>{t('Dashboard language')}</span>
              <select
                aria-label={t('Dashboard language')}
                value={locale}
                onChange={(event) => setLocale(event.target.value as typeof locale)}
              >
                {DASHBOARD_LOCALE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value} lang={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <button className="topbar-btn ghost" type="button" onClick={() => void onSignOut?.()}>
              {t('Sign out')}
            </button>
            <button className="topbar-btn ghost" type="button" onClick={() => onNavigate('/')}>
              {t('Landing')}
            </button>
          </div>
        </div>

        <div className="content" ref={contentRef}>{children}</div>

        {showScrollToTop && (
          <button className="scroll-to-top" type="button" aria-label={t('Back to top')} onClick={handleScrollToTop}>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="m6 15 6-6 6 6" />
            </svg>
          </button>
        )}
      </div>

      <nav className="mobile-bottom-nav" aria-label={t('Mobile dashboard navigation')}>
        {MOBILE_NAV_ITEMS.map((item) => (
          <a
            key={item.id}
            href={`#${item.id}`}
            className={mobileActiveSection === item.id ? 'mobile-nav-item active' : 'mobile-nav-item'}
            aria-current={mobileActiveSection === item.id ? 'page' : undefined}
            onClick={(event) => handleSectionClick(event, item.id)}
          >
            <MobileNavIcon icon={item.icon} />
            <span>{t(item.label)}</span>
          </a>
        ))}
      </nav>
    </>
  );
}
