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

const navigationItems = [
  { id: 'overview', label: 'Dashboard' },
  { id: 'health', label: 'Health' },
  { id: 'conversations', label: 'Conversations' },
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
    const scrollContainer = document.querySelector<HTMLElement>('.dashboard-page .content');

    if (!scrollContainer) return;

    const sections = navigationItems
      .map((item) => document.getElementById(item.id))
      .filter((section): section is HTMLElement => Boolean(section));

    if (sections.length === 0) return;

    const updateActiveSection = () => {
      const containerTop = scrollContainer.getBoundingClientRect().top;
      const activationPoint = containerTop + Math.min(180, scrollContainer.clientHeight * 0.28);
      let currentSection = sections[0].id;

      for (const section of sections) {
        if (section.getBoundingClientRect().top <= activationPoint) {
          currentSection = section.id;
        } else {
          break;
        }
      }

      setActiveSection(currentSection);
    };

    updateActiveSection();
    scrollContainer.addEventListener('scroll', updateActiveSection, { passive: true });
    window.addEventListener('resize', updateActiveSection);

    return () => {
      scrollContainer.removeEventListener('scroll', updateActiveSection);
      window.removeEventListener('resize', updateActiveSection);
    };
  }, [children]);

  const handleSectionClick = (
    event: MouseEvent<HTMLAnchorElement>,
    sectionId: string,
  ) => {
    event.preventDefault();
    const section = document.getElementById(sectionId);
    if (!section) return;

    setActiveSection(sectionId);
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const renderNavigationItem = (item: (typeof navigationItems)[number]) => (
    <a
      key={item.id}
      href={`#${item.id}`}
      className={`nav-item ${activeSection === item.id ? 'active' : ''}`}
      onClick={(event) => handleSectionClick(event, item.id)}
      aria-current={activeSection === item.id ? 'page' : undefined}
    >
      {item.label}
    </a>
  );

  return (
    <>
      <aside className="sidebar">
        <button className="sidebar-logo shell-button" type="button" onClick={() => onNavigate('/')}>
          <svg width="30" height="30" viewBox="0 0 36 36" fill="none">
            <rect width="36" height="36" rx="10" fill="#3ddc84" />
            <path d="M10 22 L18 10 L26 22" stroke="#060a07" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            <circle cx="18" cy="26" r="2.5" fill="#060a07" />
            <path d="M14 22 L22 22" stroke="#060a07" strokeWidth="2.8" strokeLinecap="round" />
          </svg>
          Odinlink
        </button>

        <nav className="sidebar-nav" aria-label="Dashboard sections">
          <div className="nav-group-label">Overview</div>
          {navigationItems.slice(0, 2).map(renderNavigationItem)}

          <div className="nav-group-label" style={{ marginTop: 8 }}>Management</div>
          {navigationItems.slice(2).map(renderNavigationItem)}
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
            <select aria-label="Selected business" value={selectedBusinessId || ''} onChange={(event) => onBusinessChange?.(event.target.value)}>
              {businesses.length === 0 ? (
                <option value="">No businesses</option>
              ) : (
                businesses.map((business) => (
                  <option key={business.id} value={business.id}>{business.name}</option>
                ))
              )}
            </select>
          </div>

          <div className="topbar-right">
            <button className="topbar-btn ghost" type="button" onClick={() => onNavigate('/')}>Landing</button>
          </div>
        </div>

        <div className="content">{children}</div>
      </div>
    </>
  );
}
