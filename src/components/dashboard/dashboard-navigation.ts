// UI destinations only. Stored notification targets and provider callbacks stay unchanged.
export const PRIMARY_DESTINATIONS = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'inbox', label: 'Inbox', icon: 'inbox' },
  { id: 'bookings', label: 'Bookings', icon: 'calendar' },
  { id: 'ai-assistant', label: 'AI Assistant', icon: 'assistant' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
] as const;

export type DashboardPrimary = (typeof PRIMARY_DESTINATIONS)[number]['id'];
export type DashboardNavigation =
  | { primary: 'home'; secondary?: 'reports' }
  | { primary: 'inbox' | 'bookings' }
  | { primary: 'ai-assistant'; secondary?: 'ai-tone' | 'knowledge' | 'prompt-editor' }
  | { primary: 'settings'; secondary?: 'business-settings' | 'connections' | 'connection-health' | 'notification-center' | 'admin-notifications' | 'businesses' | 'cancellation-settings' };
export type NavigateDashboard = (destination: DashboardNavigation) => void;

export function dashboardDestinationTitle(destination: DashboardNavigation): string {
  if (destination.primary === 'home' && destination.secondary === 'reports') return 'Reports';
  if (destination.primary === 'settings') {
    switch (destination.secondary) {
      case 'business-settings': return 'Business';
      case 'connections': return 'Connections';
      case 'connection-health': return 'Connection health';
      case 'notification-center': return 'Notifications';
      case 'admin-notifications': return 'Business alerts';
      case 'businesses': return 'Manage Businesses';
      case 'cancellation-settings': return 'Cancellation policy';
    }
  }
  return PRIMARY_DESTINATIONS.find((item) => item.id === destination.primary)!.label;
}

export const SETTINGS_AREAS = [
  { id: 'business', secondary: 'business-settings', label: 'Business', description: 'Business information, services, working hours and cancellation policy.' },
  { id: 'connections', secondary: 'connections', label: 'Connections', description: 'Connect your channels and calendar, and check their status.' },
  { id: 'notifications', secondary: 'notification-center', label: 'Notifications', description: 'Review issues and choose where business alerts are sent.' },
] as const;

// Group existing UI targets without changing persisted notification targets or contracts.
export function settingsAreaForNavigation(destination: DashboardNavigation): 'business' | 'connections' | 'notifications' | null {
  if (destination.primary !== 'settings') return null;
  switch (destination.secondary) {
    case 'business-settings': case 'cancellation-settings': return 'business';
    case 'connections': case 'connection-health': return 'connections';
    case 'notification-center': case 'admin-notifications': return 'notifications';
    default: return null;
  }
}

export function dashboardNavigationForTarget(target: string): DashboardNavigation | null {
  switch (target.replace(/^#/, '')) {
    case 'overview': case 'home': return { primary: 'home' };
    case 'analytics': case 'reports': return { primary: 'home', secondary: 'reports' };
    case 'conversations': case 'inbox': return { primary: 'inbox' };
    case 'activity': case 'bookings': return { primary: 'bookings' };
    case 'ai-tone': case 'knowledge': case 'prompt-editor':
      return { primary: 'ai-assistant', secondary: target.replace(/^#/, '') as 'ai-tone' | 'knowledge' | 'prompt-editor' };
    // Retired UI targets stay safe without rewriting stored notification actions.
    case 'usage-statistics': case 'usage': return { primary: 'settings' };
    case 'health': return { primary: 'settings', secondary: 'connection-health' };
    case 'channel-settings': case 'connections': return { primary: 'settings', secondary: 'connections' };
    case 'business-settings': case 'notification-center': case 'admin-notifications':
    case 'businesses': case 'cancellation-settings':
      return { primary: 'settings', secondary: target.replace(/^#/, '') as Extract<DashboardNavigation, { primary: 'settings' }>['secondary'] };
    default: return null;
  }
}

export function initialDashboardNavigation(search: string): DashboardNavigation {
  const params = new URLSearchParams(search);
  return ['connection', 'channel', 'integration'].some((key) => params.has(key))
    ? { primary: 'settings', secondary: 'connections' }
    : { primary: 'home' };
}

export function dashboardFocusTarget(destination: DashboardNavigation, previous?: DashboardNavigation): string {
  if (destination.primary === 'home' && !destination.secondary && previous?.primary === 'home' && previous.secondary === 'reports') return 'home-reports-trigger';
  if (destination.primary === 'settings' && !destination.secondary && previous?.primary === 'settings') {
    const area = settingsAreaForNavigation(previous);
    if (area) return `settings-${area}-trigger`;
  }
  if (destination.primary === 'settings') {
    switch (destination.secondary) {
      case 'business-settings': return 'settings-business-title';
      case 'cancellation-settings': return 'cancellation-title';
      case 'notification-center': return 'settings-notifications-title';
      case 'admin-notifications': return 'business-alerts-title';
      case 'connections': return 'settings-connections-title';
      case 'connection-health': return 'connection-health-title';
    }
  }
  if ('secondary' in destination && destination.secondary) {
    if (destination.secondary === 'reports') return 'analytics-title';
    return destination.secondary;
  }
  return `workspace-${destination.primary}`;
}

export function isDashboardPanelVisible(destination: DashboardNavigation, primary: DashboardPrimary, secondary?: string): boolean {
  return destination.primary === primary && (!secondary || ('secondary' in destination && destination.secondary === secondary));
}

export function isMobileConversationLocked(active: boolean, mobileChatOpen: boolean): boolean {
  return active && mobileChatOpen;
}
