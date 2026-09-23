import type { StoredCredential } from '../../channels/connections/contracts';

export type CalendarConnectionStatus =
  | 'pending'
  | 'connected'
  | 'reconnect_required'
  | 'connection_error'
  | 'disconnected';

export type CalendarConnection = {
  id: string;
  businessId: number;
  provider: 'google';
  providerAccountId: string | null;
  calendarId: string;
  tokenExpiresAt: string | null;
  grantedScopes: string[];
  status: CalendarConnectionStatus;
  connectedAt: string | null;
  lastVerifiedAt: string | null;
  reconnectRequired: boolean;
};

export type ResolvedCalendarConnection = CalendarConnection & {
  credential: StoredCredential;
  metadata: Record<string, unknown>;
};
