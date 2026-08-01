import type { BusinessPermission, BusinessRole } from './types';

const ALL_PERMISSIONS: readonly BusinessPermission[] = [
  'business.read',
  'business.manage',
  'business.delete',
  'conversations.read',
  'conversations.send',
  'bookings.read',
  'bookings.manage',
  'analytics.read',
  'team.manage',
  'settings.manage',
];

const ROLE_PERMISSIONS: Record<BusinessRole, ReadonlySet<BusinessPermission>> = {
  owner: new Set(ALL_PERMISSIONS),
  admin: new Set(ALL_PERMISSIONS.filter((permission) => permission !== 'business.delete')),
  manager: new Set([
    'business.read',
    'conversations.read',
    'conversations.send',
    'bookings.read',
    'bookings.manage',
    'analytics.read',
    'settings.manage',
  ]),
  agent: new Set([
    'business.read',
    'conversations.read',
    'conversations.send',
    'bookings.read',
    'bookings.manage',
  ]),
  viewer: new Set([
    'business.read',
    'conversations.read',
    'bookings.read',
    'analytics.read',
  ]),
};

export function isBusinessRole(value: unknown): value is BusinessRole {
  return typeof value === 'string' && value in ROLE_PERMISSIONS;
}

export function roleHasPermission(
  role: BusinessRole,
  permission: BusinessPermission,
): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}
