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
    // A previous URL hash must not leave Health (or another item) selected after reload.
    if (window.location.hash) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    }

    const content = document.querySelector<HTMLElement>('.dashboard-page .content');
    if (!content) return;

    const updateActiveSection = () => {
      const contentTop = content.getBoundingClientRect().top;
      const activationLine = contentTop + 150;
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

    // Keep the URL clean so a stale #health hash cannot control the next page load.
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
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
    </>
  );
}
