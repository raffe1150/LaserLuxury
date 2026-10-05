import type { RequestHandler } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseBusinessId } from '../auth/require-business-access';
import type { AuthenticatedRequest } from '../auth/types';

export const DASHBOARD_SALON_COLUMNS = 'id,salon_name,business_id,status';

type SalonDependencies = {
  client: SupabaseClient | null;
  getAuthorizationClient: () => SupabaseClient;
  onFailure: (category: string, request: AuthenticatedRequest, businessId?: number) => void;
};

// These legacy endpoints remain behind verified auth and membership checks.
// The unmapped legacy text key is never treated as a numeric tenant identity.
export function createSalonListHandler(dependencies: SalonDependencies): RequestHandler {
  return async (request, response) => {
    const req = request as AuthenticatedRequest;
    if (!req.auth) {
      response.status(401).json({ error: 'unauthenticated' });
      return;
    }
    try {
      if (!dependencies.client) {
        response.status(500).json({ success: false, message: 'Supabase is not configured.' });
        return;
      }
      const { data: memberships, error: membershipError } = await dependencies.getAuthorizationClient()
        .from('business_memberships').select('business_id')
        .eq('user_id', req.auth.userId).eq('status', 'active');
      if (membershipError) {
        dependencies.onFailure('salon_authorization_failed', req);
        response.status(500).json({ error: 'authorization_failed' });
        return;
      }
      const businessIds = (memberships || []).map(row => parseBusinessId(row.business_id));
      if (businessIds.some(id => id === null)) throw new Error('salon_membership_scope_invalid');
      if (businessIds.length === 0) {
        response.status(200).json([]);
        return;
      }
      const { data, error } = await dependencies.client.from('salons')
        .select(DASHBOARD_SALON_COLUMNS).in('business_id', businessIds.map(String));
      if (error) throw error;
      response.status(200).json(data || []);
    } catch {
      dependencies.onFailure('salon_list_failed', req);
      response.status(500).json({ success: false, message: 'Could not load salons.' });
    }
  };
}

// Mounted behind settings.manage. Persist only its authorized canonical ID,
// never a differently formatted or conflicting request-supplied text key.
export function createSalonCreateHandler(dependencies: SalonDependencies): RequestHandler {
  return async (request, response) => {
    const req = request as AuthenticatedRequest;
    const businessId = parseBusinessId(req.businessAccess?.businessId);
    if (!req.auth || !businessId) {
      response.status(403).json({ error: 'forbidden' });
      return;
    }
    const body = req.body || {};
    if (['businessId', 'business_id'].some(field =>
      body[field] !== undefined && parseBusinessId(body[field]) !== businessId)) {
      response.status(403).json({ error: 'forbidden' });
      return;
    }
    if (!body.salonName || (body.businessId == null && body.business_id == null)) {
      response.status(400).json({ success: false, message: 'salonName and businessId are required.' });
      return;
    }
    try {
      if (!dependencies.client) {
        response.status(500).json({ success: false, message: 'Supabase is not configured.' });
        return;
      }
      const { data, error } = await dependencies.client.from('salons').insert([{
        salon_name: body.salonName,
        business_id: String(businessId),
        status: body.status || 'active',
      }]).select(DASHBOARD_SALON_COLUMNS);
      if (error) throw error;
      response.status(200).json({ success: true, data });
    } catch {
      dependencies.onFailure('salon_create_failed', req, businessId);
      response.status(500).json({ success: false, message: 'Could not create salon.' });
    }
  };
}
