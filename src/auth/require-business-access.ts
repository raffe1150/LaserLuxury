import type { NextFunction, Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { roleHasPermission, isBusinessRole } from './permissions';
import { getAuthorizationClient } from './supabase-auth';
import type { AuthenticatedRequest, BusinessPermission } from './types';

type BusinessIdResolver = (request: Request) => unknown;

function defaultBusinessId(request: Request): unknown {
  return request.params.businessId ?? request.params.id;
}

export function parseBusinessId(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) return null;
  const businessId = Number(normalized);
  return Number.isSafeInteger(businessId) && businessId > 0 ? businessId : null;
}

export function createRequireBusinessPermission(
  permission: BusinessPermission,
  options: {
    client?: SupabaseClient;
    resolveBusinessId?: BusinessIdResolver;
  } = {},
) {
  return async function requireBusinessPermission(
    request: Request,
    response: Response,
    next: NextFunction,
  ): Promise<void> {
    const authenticatedRequest = request as AuthenticatedRequest;
    if (!authenticatedRequest.auth) {
      response.status(401).json({ error: 'unauthenticated' });
      return;
    }

    const businessId = parseBusinessId(
      (options.resolveBusinessId || defaultBusinessId)(request),
    );
    if (!businessId) {
      response.status(400).json({ error: 'invalid_business_id' });
      return;
    }

    try {
      const client = options.client || getAuthorizationClient();
      const { data, error } = await client
        .from('business_memberships')
        .select('business_id,user_id,role,status')
        .eq('business_id', businessId)
        .eq('user_id', authenticatedRequest.auth.userId)
        .eq('status', 'active')
        .maybeSingle();

      if (error) {
        response.status(500).json({ error: 'authorization_failed' });
        return;
      }
      if (!data || !isBusinessRole(data.role) || !roleHasPermission(data.role, permission)) {
        response.status(403).json({ error: 'forbidden' });
        return;
      }

      authenticatedRequest.businessAccess = { businessId, role: data.role };
      next();
    } catch {
      response.status(500).json({ error: 'auth_configuration_error' });
    }
  };
}
