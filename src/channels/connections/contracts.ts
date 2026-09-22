export const CHANNEL_PROVIDERS = ['instagram', 'messenger', 'whatsapp', 'telegram'] as const;

export type ChannelProvider = (typeof CHANNEL_PROVIDERS)[number];
export type ChannelConnectionStatus =
  | 'pending'
  | 'connected'
  | 'reconnect_required'
  | 'connection_error'
  | 'disconnected';

export type StoredCredential = {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  twoStepPin?: string;
};

export type ChannelConnection = {
  id: string;
  businessId: number;
  provider: ChannelProvider;
  providerAccountId: string;
  providerConnectionId: string | null;
  tokenExpiresAt: string | null;
  grantedScopes: string[];
  status: ChannelConnectionStatus;
  connectedAt: string | null;
  lastVerifiedAt: string | null;
  reconnectRequired: boolean;
  displayName: string | null;
  source: 'self_service' | 'legacy_manual';
};

export type ResolvedChannelConnection = ChannelConnection & {
  credential: StoredCredential;
  metadata: Record<string, unknown>;
};

export function isChannelProvider(value: unknown): value is ChannelProvider {
  return typeof value === 'string' && (CHANNEL_PROVIDERS as readonly string[]).includes(value);
}
