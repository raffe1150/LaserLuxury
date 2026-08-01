import type { NextFunction, Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { verifyAccessToken } from './supabase-auth';
import type { AuthenticatedRequest } from './types';

const BEARER_TOKEN = /^Bearer\s+([^\s]+)$/i;

export function createRequireAuth(
  verificationClient?: Pick<SupabaseClient, 'auth'>,
) {
  return async function requireAuth(
    request: Request,
    response: Response,
    next: NextFunction,
  ): Promise<void> {
    const authorization = request.header('authorization') || '';
    const match = BEARER_TOKEN.exec(authorization);
    if (!match) {
      response.status(401).json({ error: 'unauthenticated' });
      return;
    }

    try {
      const user = await verifyAccessToken(match[1], verificationClient);
      if (!user) {
        response.status(401).json({ error: 'unauthenticated' });
        return;
      }
      (request as AuthenticatedRequest).auth = {
        userId: user.id,
      };
      next();
    } catch {
      response.status(500).json({ error: 'auth_configuration_error' });
    }
  };
}
