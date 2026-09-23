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
    if (provider === 'telegram') {
      const username = String(process.env.TELEGRAM_PLATFORM_BOT_USERNAME || '').replace(/^@/, '').trim();
      const token = String(process.env.TELEGRAM_PLATFORM_BOT_TOKEN || '').trim();
      const webhookSecret = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
      if (!username) throw new Error('telegram_platform_bot_username_missing');
      if (!token || !webhookSecret) throw new Error('telegram_platform_webhook_configuration_missing');
      const legacyTokens = [process.env.TELEGRAM_TOKEN, process.env.TELEGRAM_BOT_TOKEN]
        .map((value) => String(value || '').trim()).filter(Boolean);
      if (legacyTokens.includes(token)) throw new Error('telegram_platform_bot_must_be_dedicated');
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) throw new Error('telegram_webhook_secret_invalid');
      const identityResponse = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const identity = await identityResponse.json().catch(() => null);
      if (!identityResponse.ok || identity?.ok === false || !identity?.result) {
        throw new Error('telegram_platform_bot_invalid');
      }
      if (String(identity.result.username || '').toLowerCase() !== username.toLowerCase()) {
        throw new Error('telegram_platform_bot_username_mismatch');
      }
      if (identity.result.can_connect_to_business !== true) {
        throw new Error('telegram_platform_business_mode_required');
      }
      const webhookResponse = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: `${new URL(redirectUri).origin}/api/telegram-webhook`,
          secret_token: webhookSecret,
          allowed_updates: ['message', 'business_connection', 'business_message'],
        }),
      });
      const webhookResult = await webhookResponse.json().catch(() => null);
      if (!webhookResponse.ok || webhookResult?.ok === false) throw new Error('telegram_webhook_registration_failed');
      response.json({
        success: true,
        mode: 'telegram_business',
        authorizationUrl: `https://t.me/${encodeURIComponent(username)}?start=ol_${state}`,
        instructions: 'Open Telegram, start the OdinLink bot, then connect it in Telegram Business > Chatbots.',
      });
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

export async function handleTelegramConnectionUpdate(
  client: SupabaseClient,
  update: any,
): Promise<{ handled: boolean; connectionBusinessId?: number; businessConnectionId?: string; translatedUpdate?: any }> {
  const start = String(update?.message?.text || '').match(/^\/start\s+ol_([A-Za-z0-9_-]{20,})$/);
  if (start && update?.message?.chat?.id) {
    const { data, error } = await client.rpc('bind_telegram_channel_authorization_session', {
      p_state_hash: hashAuthorizationValue(start[1]),
      p_provider_user_id: String(update.message.chat.id),
    });
    if (error) throw error;
    const token = String(process.env.TELEGRAM_PLATFORM_BOT_TOKEN || '').trim();
    if (token) {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: update.message.chat.id,
          text: data?.length
            ? 'OdinLink is ready. In Telegram, open Settings > Telegram Business > Chatbots and connect this bot. Return to OdinLink when Telegram confirms the connection.'
            : 'This connection link is invalid, expired, or already belongs to another Telegram account. Start again from OdinLink.',
        }),
      });
    }
    return { handled: true };
  }

  if (update?.business_connection?.id && update.business_connection.user_chat_id) {
    const connection = update.business_connection;
    const { data: sessions, error } = await client.from('channel_authorization_sessions').select('*')
      .eq('provider', 'telegram').eq('provider_user_id', String(connection.user_chat_id))
      .is('consumed_at', null).gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(1);
    if (error) throw error;
    const session = sessions?.[0];
    if (!connection.is_enabled) {
      await client.from('channel_connections').update({
        status: 'reconnect_required', reconnect_required: true,
      }).eq('provider', 'telegram').eq('provider_connection_id', String(connection.id));
      return { handled: true };
    }
    if (!session) return { handled: true };
    await assertAuthorizationOwnerStillActive(client, session);
    const token = String(process.env.TELEGRAM_PLATFORM_BOT_TOKEN || '').trim();
    if (!token) throw new Error('telegram_platform_bot_token_missing');
    if (connection.rights?.can_reply !== true) {
      await sendTelegramPlatformMessage(
        token,
        connection.user_chat_id,
        'OdinLink needs permission to reply to messages. Enable Reply to Messages for this chatbot in Telegram Business, then try again.',
      );
      return { handled: true };
    }
    try {
      await saveConnection(client, {
        businessId: Number(session.business_id), provider: 'telegram',
        providerAccountId: String(connection.user?.id || connection.user_chat_id),
        providerConnectionId: String(connection.id),
        credential: { accessToken: token, tokenType: 'bot' },
        grantedScopes: Object.entries(connection.rights || {}).filter(([, enabled]) => enabled).map(([right]) => right),
        metadata: { display_name: connection.user?.username || connection.user?.first_name || 'Telegram Business' },
      });
    } catch (error: any) {
      if (String(error?.code || '') !== '23505') throw error;
      await sendTelegramPlatformMessage(
        token,
        connection.user_chat_id,
        'This Telegram Business account is already connected to another OdinLink business. Disconnect it there before trying again.',
      );
      return { handled: true };
    }
    await client.from('channel_authorization_sessions').update({ consumed_at: new Date().toISOString() }).eq('id', session.id).is('consumed_at', null);
    await sendTelegramPlatformMessage(
      token,
      connection.user_chat_id,
      'Telegram is connected to OdinLink. Return to the OdinLink dashboard to see the connection status.',
    );
    return { handled: true };
  }

  if (update?.business_message?.business_connection_id) {
    const identity = String(update.business_message.business_connection_id);
    const { data: connection, error } = await client.from('channel_connections')
      .select('business_id,provider_connection_id')
      .eq('provider', 'telegram').eq('provider_connection_id', identity)
      .eq('status', 'connected').eq('reconnect_required', false).maybeSingle();
    if (error) throw error;
    if (!connection) return { handled: true };
    return {
      handled: false,
      connectionBusinessId: Number(connection.business_id),
      businessConnectionId: identity,
      translatedUpdate: { ...update, message: update.business_message },
    };
  }
  return { handled: false };
}

async function sendTelegramPlatformMessage(token: string, chatId: unknown, text: string): Promise<void> {
  if (!token || chatId === undefined || chatId === null) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}
