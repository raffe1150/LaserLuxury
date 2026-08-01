import type { Request } from 'express';

export const BUSINESS_ROLES = ['owner', 'admin', 'manager', 'agent', 'viewer'] as const;

export type BusinessRole = (typeof BUSINESS_ROLES)[number];

export type BusinessPermission =
  | 'business.read'
  | 'business.manage'
  | 'business.delete'
  | 'conversations.read'
  | 'conversations.send'
  | 'bookings.read'
  | 'bookings.manage'
  | 'analytics.read'
  | 'team.manage'
  | 'settings.manage';

export type AuthenticatedRequestContext = {
  userId: string;
};

export type BusinessAccessContext = {
  businessId: number;
  role: BusinessRole;
};

export type AuthenticatedRequest = Request & {
  auth?: AuthenticatedRequestContext;
  businessAccess?: BusinessAccessContext;
};
