import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthenticatedRequest } from '../../auth/types';
import { encryptCredential, credentialKeyId } from './credential-crypto';
import { isChannelProvider, type ChannelProvider } from './contracts';
import {
  disconnectConnection,
  listConnections,
  markReconnectRequired,
  resolveConnectionForBusiness,
  saveConnection,
} from './repository';
import {
  buildAuthorizationUrl,
  completeInstagram,
  completeMessenger,
  completeWhatsApp,
  completeManualWhatsApp,
  revokeProviderCredential,
  verifyProviderCredential,
  refreshInstagramCredential,
  whatsappLaunchConfiguration,
} from './providers';
import {
  AUTHORIZATION_COOKIE,
  AUTHORIZATION_TTL_MS,
  authorizationCookie,
  callbackUrl,
  clearAuthorizationCookie,
  dashboardReturnUrl,
  hashAuthorizationValue,
  parseCookie,
  randomAuthorizationValue,
} from './security';

type RouterOptions = {
  client: SupabaseClient;
  requireAuth: RequestHandler;
  requireBusinessPermission: (permission: 'settings.manage') => RequestHandler;
};

const callbackProviders = new Set<ChannelProvider>(['instagram', 'messenger']);

function asyncRoute(handler: (request: Request, response: Response, next: NextFunction) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response, next).catch(next);
  };
}

function safeErrorCode(error: unknown): string {
  const code = String((error as Error)?.message || 'connection_failed');
  return /^[a-z0-9_:-]{1,100}$/i.test(code) ? code.replace(/:.*/, '') : 'connection_failed';
}

function publicConnection(connection: Awaited<ReturnType<typeof saveConnection>>) {
  return {
    id: connection.id,
    businessId: connection.businessId,
    provider: connection.provider,
    status: connection.status,
    reconnectRequired: connection.reconnectRequired,
    connectedAt: connection.connectedAt,
    lastVerifiedAt: connection.lastVerifiedAt,
    displayName: connection.displayName,
    source: connection.source,
  };
}

async function createAuthorizationSession(
  client: SupabaseClient,
  input: { businessId: number; userId: string; provider: ChannelProvider; state: string; browserNonce: string; redirectUri: string },
) {
  await client.from('channel_authorization_sessions').delete()
    .eq('business_id', input.businessId).eq('provider', input.provider)
    .lt('expires_at', new Date().toISOString());
  const { error } = await client.from('channel_authorization_sessions').insert({
    business_id: input.businessId,
    user_id: input.userId,
    provider: input.provider,
    state_hash: hashAuthorizationValue(input.state),
    browser_nonce_hash: hashAuthorizationValue(input.browserNonce),
    redirect_uri: input.redirectUri,
    expires_at: new Date(Date.now() + AUTHORIZATION_TTL_MS).toISOString(),
  });
  if (error) throw error;
}

async function assertAuthorizationOwnerStillActive(client: SupabaseClient, session: { business_id: unknown; user_id: unknown }) {
  const { data, error } = await client.from('business_memberships')
    .select('role,status').eq('business_id', Number(session.business_id))
    .eq('user_id', String(session.user_id)).eq('status', 'active').maybeSingle();
  if (error) throw error;
  if (!data || !['owner', 'admin', 'manager'].includes(String(data.role))) {
    throw new Error('authorization_owner_inactive');
  }
}

export async function consumeAuthorizationSession(
  client: SupabaseClient,
  state: string,
  browserNonce: string,
  provider: ChannelProvider,
) {
  const { data, error } = await client.rpc('consume_channel_authorization_session', {
    p_state_hash: hashAuthorizationValue(state),
    p_browser_nonce_hash: hashAuthorizationValue(browserNonce),
    p_provider: provider,
  });
  if (error) throw error;
  const session = Array.isArray(data) ? data[0] : data;
  if (!session) throw new Error('authorization_state_invalid');
  if (session.redirect_uri !== callbackUrl(provider)) throw new Error('authorization_redirect_mismatch');
  return session;
}

export function createChannelConnectionsRouter(options: RouterOptions): express.Router {
  const router = express.Router();
  const manage = options.requireBusinessPermission('settings.manage');

  router.get('/:businessId', options.requireAuth, manage, asyncRoute(async (request, response) => {
    const businessId = (request as AuthenticatedRequest).businessAccess!.businessId;
    const connections = await listConnections(options.client, businessId);
    await Promise.all(connections.map(async (connection) => {
      if (connection.status === 'connected' && connection.tokenExpiresAt && Date.parse(connection.tokenExpiresAt) <= Date.now()) {
        await markReconnectRequired(options.client, connection.id);
        connection.status = 'reconnect_required';
        connection.reconnectRequired = true;
      } else if (connection.status === 'connected') {
        const resolved = await resolveConnectionForBusiness(options.client, businessId, connection.provider);
        if (resolved) {
          if (resolved.provider === 'instagram' && resolved.tokenExpiresAt && Date.parse(resolved.tokenExpiresAt) - Date.now() < 7 * 24 * 60 * 60_000) {
            try {
              const refreshed = await refreshInstagramCredential(resolved.credential.accessToken);
              await options.client.from('channel_connections').update({
                credential_ciphertext: encryptCredential({ ...resolved.credential, accessToken: refreshed.accessToken }),
                credential_key_id: credentialKeyId(),
                token_expires_at: refreshed.expiresAt,
                last_verified_at: new Date().toISOString(),
              }).eq('id', resolved.id);
              connection.tokenExpiresAt = refreshed.expiresAt;
            } catch {
              // Verification below distinguishes a revoked token from a temporary refresh failure.
            }
          }
          const health = await verifyProviderCredential({
            provider: resolved.provider,
            providerAccountId: resolved.providerAccountId,
            providerConnectionId: resolved.providerConnectionId,
            accessToken: resolved.credential.accessToken,
          });
          if (health === 'authorization_invalid') {
            await markReconnectRequired(options.client, connection.id);
            connection.status = 'reconnect_required';
            connection.reconnectRequired = true;
          } else if (health === 'connected') {
            const verifiedAt = new Date().toISOString();
            await options.client.from('channel_connections').update({ last_verified_at: verifiedAt }).eq('id', connection.id);
            connection.lastVerifiedAt = verifiedAt;
          }
        }
      }
    }));
    response.json({
      success: true,
      data: connections.map(publicConnection),
    });
  }));

  router.post('/:businessId/:provider/authorize', options.requireAuth, manage, asyncRoute(async (request, response) => {
    const provider = request.params.provider;
    if (!isChannelProvider(provider)) {
      response.status(400).json({ error: 'unsupported_provider' });
      return;
    }
    const authenticated = request as AuthenticatedRequest;
    const state = randomAuthorizationValue();
    const browserNonce = randomAuthorizationValue();
    const redirectUri = callbackUrl(provider);
    await createAuthorizationSession(options.client, {
      businessId: authenticated.businessAccess!.businessId,
      userId: authenticated.auth!.userId,
      provider,
      state,
      browserNonce,
      redirectUri,
    });
    response.setHeader('Set-Cookie', authorizationCookie(browserNonce));
    if (provider === 'whatsapp') {
      response.json({ success: true, mode: 'embedded_signup', ...whatsappLaunchConfiguration(state), redirectUri });
      return;
    }
    response.json({ success: true, mode: 'redirect', authorizationUrl: buildAuthorizationUrl(provider, state, redirectUri) });
  }));

  router.get('/:provider/callback', asyncRoute(async (request, response) => {
    const provider = request.params.provider as ChannelProvider;
    if (!callbackProviders.has(provider)) {
      response.status(404).send('Not found');
      return;
    }
    const state = String(request.query.state || '');
    const code = String(request.query.code || '');
    const browserNonce = parseCookie(request.header('cookie'), AUTHORIZATION_COOKIE) || '';
    try {
      if (!state || !code || !browserNonce || request.query.error) throw new Error('authorization_callback_invalid');
      const session = await consumeAuthorizationSession(options.client, state, browserNonce, provider);
      await assertAuthorizationOwnerStillActive(options.client, session);
      const completed = provider === 'instagram'
        ? await completeInstagram(code, session.redirect_uri)
        : await completeMessenger(code, session.redirect_uri);
      await saveConnection(options.client, { businessId: Number(session.business_id), provider, ...completed });
      response.setHeader('Set-Cookie', clearAuthorizationCookie());
      response.redirect(303, dashboardReturnUrl(provider, 'connected'));
    } catch (error) {
      response.setHeader('Set-Cookie', clearAuthorizationCookie());
      response.redirect(303, dashboardReturnUrl(provider, safeErrorCode(error)));
    }
  }));

  router.post('/:businessId/whatsapp/complete', options.requireAuth, manage, asyncRoute(async (request, response) => {
    const state = String(request.body?.state || '');
    const code = String(request.body?.code || '');
    const wabaId = String(request.body?.wabaId || '');
    const phoneNumberId = String(request.body?.phoneNumberId || '');
    const browserNonce = parseCookie(request.header('cookie'), AUTHORIZATION_COOKIE) || '';
    if (!state || !code || !wabaId || !phoneNumberId || !browserNonce) {
      response.status(400).json({ error: 'authorization_callback_invalid' });
      return;
    }
    const session = await consumeAuthorizationSession(options.client, state, browserNonce, 'whatsapp');
    const authenticated = request as AuthenticatedRequest;
    if (Number(session.business_id) !== authenticated.businessAccess!.businessId || session.user_id !== authenticated.auth!.userId) {
      response.status(403).json({ error: 'authorization_owner_mismatch' });
      return;
    }
    const completed = await completeWhatsApp({ code, wabaId, phoneNumberId, redirectUri: session.redirect_uri });
    const connection = await saveConnection(options.client, {
      businessId: authenticated.businessAccess!.businessId,
      provider: 'whatsapp',
      ...completed,
    });
    response.setHeader('Set-Cookie', clearAuthorizationCookie());
    response.json({ success: true, data: publicConnection(connection) });
  }));

  router.post('/:businessId/whatsapp/manual', options.requireAuth, manage, asyncRoute(async (request, response) => {
    const authenticated = request as AuthenticatedRequest;
    const businessId = authenticated.businessAccess!.businessId;

    const phoneNumberId = String(request.body?.phoneNumberId || '').trim();
    const wabaId = String(request.body?.wabaId || '').trim();
    const accessToken = String(request.body?.accessToken || '').trim();

    if (!phoneNumberId || !wabaId || !accessToken) {
      response.status(400).json({ error: 'whatsapp_manual_fields_required' });
      return;
    }

    const completed = await completeManualWhatsApp({
      phoneNumberId,
      wabaId,
      accessToken,
    });

    const connection = await saveConnection(options.client, {
      businessId,
      provider: 'whatsapp',
      ...completed,
    });

    response.json({
      success: true,
      data: publicConnection(connection),
    });
  }));

  router.delete('/:businessId/:provider', options.requireAuth, manage, asyncRoute(async (request, response) => {
    const provider = request.params.provider;
    if (!isChannelProvider(provider)) {
      response.status(400).json({ error: 'unsupported_provider' });
      return;
    }
    const businessId = (request as AuthenticatedRequest).businessAccess!.businessId;
    const connection = await resolveConnectionForBusiness(options.client, businessId, provider);
    if (connection) {
      try {
        await revokeProviderCredential(provider, connection.credential.accessToken);
      } catch {
        // Local deactivation is authoritative; provider revocation is best effort and reconnect-safe.
      }
    }
    const disconnected = await disconnectConnection(options.client, businessId, provider);
    response.json({ success: true, disconnected });
  }));

  router.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    console.error('[ChannelConnection]', { category: safeErrorCode(error) });
    response.status(500).json({ error: safeErrorCode(error) });
  });

  return router;
}
