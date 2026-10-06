import type { ChannelProvider } from './contracts';

// Provider adapters supply evidence; business code consumes these common states.
export type ProvisioningReason = {
  code: string;
  severity: 'info' | 'warning' | 'blocking';
  scope: 'authorization' | 'asset' | 'phone' | 'waba' | 'template' | 'billing' | 'verification' | 'subscription';
  message: string;
  details?: Record<string, string | number | boolean>;
};

export type ChannelProvisioningReadiness = {
  provider: ChannelProvider;
  business_id: number;
  checked_at: string;
  ready: boolean;
  connection_ready: boolean;
  provisioning_ready: boolean;
  reminder_ready: boolean;
  delivery_ready: boolean;
  reasons: ProvisioningReason[];
};

// Created by the authenticated, tenant-bound authorization flow, never from IDs
// or a claimed scope list supplied by the browser.
export type TenantProvisioningAuthorization = {
  businessId: number;
  authorizingUserId: string;
  appId: string;
  accessToken: string;
  expectedPortfolioId?: string;
  authorizationVersion?: string;
};
