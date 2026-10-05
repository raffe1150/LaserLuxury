import type { RequestHandler } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseBusinessId } from '../auth/require-business-access';
import type { AuthenticatedRequest } from '../auth/types';

type SetupDependencies = {
  client: SupabaseClient | null;
  normalizeToken: (token: string) => string;
  buildConfig: (row: Record<string, any>) => Promise<Record<string, any>>;
  saveConfig: (config: Record<string, any>) => void;
  startPolling: (config: Record<string, any>) => void;
  onFailure: (category: string, request: AuthenticatedRequest, businessId?: number) => void;
};

const BUSINESS_ID_FIELDS = ['businessId', 'business_id', 'businessRecordId', 'id'] as const;

// Mounted behind verified user auth and settings.manage membership middleware.
// Unlike background token routing, this route must never search other businesses.
export function createTelegramSetupHandler(dependencies: SetupDependencies): RequestHandler {
  return async (request, response) => {
    const req = request as AuthenticatedRequest;
    const businessId = parseBusinessId(req.businessAccess?.businessId);
    if (!req.auth || !businessId) {
      response.status(403).json({ error: 'forbidden' });
      return;
    }
    const body = req.body || {};
    if (BUSINESS_ID_FIELDS.some(field => body[field] !== undefined && parseBusinessId(body[field]) !== businessId)) {
      response.status(403).json({ error: 'forbidden' });
      return;
    }
    if (body.telegramToken != null && typeof body.telegramToken !== 'string') {
      response.status(400).json({ error: 'invalid_telegram_token' });
      return;
    }
    if (!dependencies.client) {
      response.status(503).json({ error: 'telegram_setup_unavailable' });
      return;
    }
    try {
      const { data: row, error } = await dependencies.client.from('businesses')
        .select('*').eq('id', businessId).maybeSingle();
      if (error) throw new Error('telegram_setup_query_failed');
      if (!row) {
        response.status(404).json({ error: 'business_not_found' });
        return;
      }
      if (parseBusinessId(row.id) !== businessId) throw new Error('telegram_setup_scope_mismatch');
      const requestedToken = dependencies.normalizeToken(body.telegramToken || '');
      const storedToken = dependencies.normalizeToken(row.telegram_bot_token || '');
      if (requestedToken && requestedToken !== storedToken) {
        response.status(403).json({ error: 'forbidden' });
        return;
      }
      // Build only from the authorized database row, never request-supplied
      // provider credentials or another business's active/global configuration.
      const resolved = await dependencies.buildConfig(row);
      if (BUSINESS_ID_FIELDS.some(field => resolved[field] !== undefined && parseBusinessId(resolved[field]) !== businessId)
          || dependencies.normalizeToken(resolved.telegramToken || '') !== storedToken) {
        throw new Error('telegram_setup_scope_mismatch');
      }
      const config = {
        ...resolved,
        businessId, business_id: businessId, businessRecordId: businessId, id: businessId,
        telegramToken: storedToken,
        telegramBusinessResolved: Boolean(storedToken),
        telegramResolutionSource: 'public.businesses.authorized_business_id',
      };
      dependencies.saveConfig(config);
      if (requestedToken) dependencies.startPolling(config);
      response.json({ success: true, message: 'Configuration saved and webhook registered.' });
    } catch {
      dependencies.onFailure('setup_telegram_failed', req, businessId);
      response.status(503).json({ error: 'telegram_setup_unavailable' });
    }
  };
}
