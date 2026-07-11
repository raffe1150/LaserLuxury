import type { ReactNode } from 'react';
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

export default function DashboardShell({
  title,
  businesses = [],
  selectedBusinessId,
  businessName,
  onNavigate,
  onBusinessChange,
  children,
}: DashboardShellProps) {
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
        <nav className="sidebar-nav">
          <div className="nav-group-label">Overview</div>
          <a className="nav-item active" href="#overview">
            Dashboard
          </a>
          <a className="nav-item" href="#health">
            Health
          </a>
          <div className="nav-group-label" style={{ marginTop: 8 }}>Management</div>
          <a className="nav-item" href="#conversations">
            Conversations
          </a>
          <a className="nav-item" href="#bookings">
            Bookings
          </a>
          <a className="nav-item" href="#businesses">
            Businesses
          </a>
          <a className="nav-item" href="#business-settings">
            Business Settings
          </a>
          <a className="nav-item" href="#prompt-editor">
            Prompt Editor
          </a>
          <a className="nav-item" href="#channel-settings">
            Channel Settings
          </a>
          <a className="nav-item" href="#usage-statistics">
            Usage
          </a>
          <a className="nav-item" href="#activity">
            Activity
          </a>
          <a className="nav-item" href="#notification-center">
            Notifications
          </a>
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
