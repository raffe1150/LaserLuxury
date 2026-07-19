import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import type { Business } from '../../types/dashboard';

interface DashboardShellProps {
  title: string;
  businesses?: Business[];
  selectedBusinessId?: string;
  businessName?: string;
  onNavigate: (path: '/' | '/login' | '/dashboard') => void;
  onBusinessChange?: (businessId: string) => void;
  children: ReactNode;
}

const NAV_ITEMS = [
  { id: 'overview', label: 'Dashboard', group: 'Overview' },
  { id: 'health', label: 'Health' },
  { id: 'conversations', label: 'Conversations', group: 'Management' },
  { id: 'bookings', label: 'Bookings' },
  { id: 'businesses', label: 'Businesses' },
  { id: 'business-settings', label: 'Business Settings' },
  { id: 'prompt-editor', label: 'Prompt Editor' },
  { id: 'channel-settings', label: 'Channel Settings' },
  { id: 'usage-statistics', label: 'Usage' },
  { id: 'activity', label: 'Activity' },
  { id: 'notification-center', label: 'Notifications' },
] as const;

const MOBILE_NAV_ITEMS = [
  { id: 'overview', label: 'Home', icon: 'home' },
  { id: 'conversations', label: 'Inbox', icon: 'inbox' },
  { id: 'bookings', label: 'Bookings', icon: 'calendar' },
  { id: 'businesses', label: 'More', icon: 'more' },
] as const;

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
  children,
}: DashboardShellProps) {
  const [activeSection, setActiveSection] = useState('overview');

  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    }

    const content = document.querySelector<HTMLElement>('.dashboard-page .content');
    if (!content) return;

    const updateActiveSection = () => {
      const contentTop = content.getBoundingClientRect().top;
      const activationLine = contentTop + Math.min(170, window.innerHeight * 0.24);
      let current = 'overview';

      for (const item of NAV_ITEMS) {
        const section = document.getElementById(item.id);
        if (!section) continue;

        if (section.getBoundingClientRect().top <= activationLine) {
          current = item.id;
        }
      }

      setActiveSection(current);
    };

    updateActiveSection();
    content.addEventListener('scroll', updateActiveSection, { passive: true });
    window.addEventListener('resize', updateActiveSection);

    return () => {
      content.removeEventListener('scroll', updateActiveSection);
      window.removeEventListener('resize', updateActiveSection);
    };
  }, []);

  const handleSectionClick = (event: MouseEvent<HTMLAnchorElement>, sectionId: string) => {
    event.preventDefault();

    const section = document.getElementById(sectionId);
    if (!section) return;

    setActiveSection(sectionId);
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  };

  const mobileActiveSection =
    activeSection === 'overview'
      ? 'overview'
      : activeSection === 'conversations'
        ? 'conversations'
        : activeSection === 'bookings' || activeSection === 'activity'
          ? 'bookings'
          : 'businesses';

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

        <nav className="sidebar-nav" aria-label="Dashboard sections">
          {NAV_ITEMS.map((item, index) => (
            <div key={item.id}>
              {item.group && (
                <div
                  className="nav-group-label"
                  style={index > 0 ? { marginTop: 8 } : undefined}
                >
                  {item.group}
                </div>
              )}
              <a
                className={activeSection === item.id ? 'nav-item active' : 'nav-item'}
                href={`#${item.id}`}
                aria-current={activeSection === item.id ? 'page' : undefined}
                onClick={(event) => handleSectionClick(event, item.id)}
              >
                {item.label}
              </a>
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="avatar">{businessName?.slice(0, 1).toUpperCase() || 'B'}</div>
          <div>
            <div className="sidebar-user-name">{businessName || 'Select business'}</div>
            <div className="sidebar-user-role">Tenant dashboard</div>
          </div>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <button className="mobile-brand shell-button" type="button" onClick={() => onNavigate('/')} aria-label="Open OdinLink landing page">
            <svg width="30" height="30" viewBox="0 0 36 36" fill="none">
              <rect width="36" height="36" rx="10" fill="#3ddc84" />
              <path d="M10 22 L18 10 L26 22" stroke="#060a07" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="18" cy="26" r="2.5" fill="#060a07" />
              <path d="M14 22 L22 22" stroke="#060a07" strokeWidth="2.8" strokeLinecap="round" />
            </svg>
            <span>Odinlink</span>
          </button>

          <span className="topbar-title">{title}</span>

          <div className="topbar-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
              <circle cx="11" cy="11" r="6" />
              <path d="M20 20L16.65 16.65" />
            </svg>
            <select
              aria-label="Selected business"
              value={selectedBusinessId || ''}
              onChange={(event) => onBusinessChange?.(event.target.value)}
            >
              {businesses.length === 0 ? (
                <option value="">No businesses</option>
              ) : (
                businesses.map((business) => (
                  <option key={business.id} value={business.id}>
                    {business.name}
                  </option>
                ))
              )}
            </select>
          </div>

          <div className="topbar-right">
            <button className="topbar-btn ghost" type="button" onClick={() => onNavigate('/')}>
              Landing
            </button>
          </div>
        </div>

        <div className="content">{children}</div>
      </div>

      <nav className="mobile-bottom-nav" aria-label="Mobile dashboard navigation">
        {MOBILE_NAV_ITEMS.map((item) => (
          <a
            key={item.id}
            href={`#${item.id}`}
            className={mobileActiveSection === item.id ? 'mobile-nav-item active' : 'mobile-nav-item'}
            aria-current={mobileActiveSection === item.id ? 'page' : undefined}
            onClick={(event) => handleSectionClick(event, item.id)}
          >
            <MobileNavIcon icon={item.icon} />
            <span>{item.label}</span>
          </a>
        ))}
      </nav>
    </>
  );
}
