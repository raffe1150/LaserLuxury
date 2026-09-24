import crypto from 'node:crypto';
import type { ChannelProvider, StoredCredential } from './contracts';

const graphVersion = () => String(process.env.META_GRAPH_API_VERSION || 'v26.0').replace(/^\/?/, '');

type ProviderConnectionResult = {
  providerAccountId: string;
  providerConnectionId?: string | null;
  credential: StoredCredential;
  tokenExpiresAt?: string | null;
  grantedScopes: string[];
  metadata: Record<string, unknown>;
};

async function providerJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.error) {
    const error = new Error(`provider_request_failed:${response.status}`) as Error & { status?: number; providerCode?: unknown };
    error.status = response.status;
    error.providerCode = data?.error?.code;
    throw error;
  }
  return data;
}

function requiredEnv(name: string, fallback?: string): string {
  const value = String(process.env[name] || (fallback ? process.env[fallback] : '') || '').trim();
  if (!value) throw new Error(`${name.toLowerCase()}_missing`);
  return value;
}

function expiresAt(seconds: unknown): string | null {
  const duration = Number(seconds);
  return Number.isFinite(duration) && duration > 0
    ? new Date(Date.now() + duration * 1000).toISOString()
    : null;
}

export const PROVIDER_SCOPES: Record<Exclude<ChannelProvider, 'telegram'>, string[]> = {
  instagram: [
    'instagram_business_basic',
    'instagram_business_manage_messages',
    'instagram_business_manage_comments',
  ],
  messenger: ['pages_show_list', 'pages_messaging', 'pages_manage_metadata'],
  whatsapp: ['whatsapp_business_management', 'whatsapp_business_messaging'],
};

export function buildAuthorizationUrl(provider: 'instagram' | 'messenger', state: string, redirectUri: string): string {
  if (provider === 'instagram') {
    const url = new URL('https://www.instagram.com/oauth/authorize');
    url.searchParams.set('client_id', requiredEnv('INSTAGRAM_APP_ID'));
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', PROVIDER_SCOPES.instagram.join(','));
    url.searchParams.set('state', state);
    url.searchParams.set('enable_fb_login', '0');
    url.searchParams.set('force_reauth', 'true');
    return url.toString();
  }
  const url = new URL(`https://www.facebook.com/${graphVersion()}/dialog/oauth`);
  url.searchParams.set('client_id', requiredEnv('META_APP_ID'));
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', PROVIDER_SCOPES.messenger.join(','));
  url.searchParams.set('state', state);
  const configId = String(process.env.META_LOGIN_CONFIG_ID || '').trim();
  if (configId) url.searchParams.set('config_id', configId);
  return url.toString();
}

export async function completeInstagram(code: string, redirectUri: string): Promise<ProviderConnectionResult> {
  const form = new URLSearchParams({
    client_id: requiredEnv('INSTAGRAM_APP_ID'),
    client_secret: requiredEnv('INSTAGRAM_APP_SECRET'),
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code,
  });
  const short = await providerJson('https://api.instagram.com/oauth/access_token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form,
  });
  const shortToken = Array.isArray(short?.data) ? short.data[0] : short;
  if (!shortToken?.access_token) throw new Error('instagram_token_exchange_failed');
  const longUrl = new URL('https://graph.instagram.com/access_token');
  longUrl.searchParams.set('grant_type', 'ig_exchange_token');
  longUrl.searchParams.set('client_secret', requiredEnv('INSTAGRAM_APP_SECRET'));
  longUrl.searchParams.set('access_token', shortToken?.access_token);
  const long = await providerJson(longUrl.toString());
  const token = String(long.access_token || shortToken?.access_token || '');
  const profileUrl = new URL(`https://graph.instagram.com/${graphVersion()}/me`);
  profileUrl.searchParams.set('fields', 'user_id,username,name');
  profileUrl.searchParams.set('access_token', token);
  const profile = await providerJson(profileUrl.toString());
  const profileData = Array.isArray(profile?.data) ? profile.data[0] : profile;
  const accountId = String(profileData?.user_id || profileData?.id || shortToken?.user_id || '');
  if (!accountId) throw new Error('instagram_account_identity_missing');
  await providerJson(`https://graph.instagram.com/${graphVersion()}/${encodeURIComponent(accountId)}/subscribed_apps`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscribed_fields: ['messages', 'messaging_postbacks', 'comments', 'live_comments'] }),
  });
  return {
    providerAccountId: accountId,
    credential: { accessToken: token, tokenType: 'bearer' },
    tokenExpiresAt: expiresAt(long.expires_in),
    grantedScopes: PROVIDER_SCOPES.instagram,
    metadata: { display_name: profileData?.username || profileData?.name || 'Instagram account' },
  };
}

export async function completeManualInstagram(input: {
  accountId: string;
  pageId?: string;
  accessToken: string;
}): Promise<ProviderConnectionResult> {
  const accountId = String(input.accountId || '').trim();
  const pageId = String(input.pageId || '').trim();
  const token = String(input.accessToken || '').trim();

  const profileUrl = new URL(
    `https://graph.instagram.com/${graphVersion()}/${encodeURIComponent(accountId)}`,
  );
  profileUrl.searchParams.set('fields', 'user_id,username,name');
  profileUrl.searchParams.set('access_token', token);

  const profile = await providerJson(profileUrl.toString());
  const profileData = Array.isArray(profile?.data) ? profile.data[0] : profile;
  const resolvedAccountId = String(profileData?.user_id || profileData?.id || '');

  if (!resolvedAccountId || resolvedAccountId !== accountId) {
    throw new Error('instagram_account_identity_mismatch');
  }

  await providerJson(
    `https://graph.instagram.com/${graphVersion()}/${encodeURIComponent(accountId)}/subscribed_apps`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        subscribed_fields: [
          'messages',
          'messaging_postbacks',
          'comments',
          'live_comments',
        ],
      }),
    },
  );

  return {
    providerAccountId: accountId,
    credential: {
      accessToken: token,
      tokenType: 'bearer',
    },
    tokenExpiresAt: null,
    grantedScopes: PROVIDER_SCOPES.instagram,
    metadata: {
      display_name: profileData?.username || profileData?.name || 'Instagram account',
      instagram_account_id: accountId,
      page_id: pageId || null,
      connection_method: 'manual',
    },
  };
}

export async function refreshInstagramCredential(accessToken: string): Promise<{ accessToken: string; expiresAt: string | null }> {
  const url = new URL('https://graph.instagram.com/refresh_access_token');
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', accessToken);
  const result = await providerJson(url.toString());
  return { accessToken: String(result.access_token || accessToken), expiresAt: expiresAt(result.expires_in) };
}

export async function completeMessenger(code: string, redirectUri: string): Promise<ProviderConnectionResult> {
  const tokenUrl = new URL(`https://graph.facebook.com/${graphVersion()}/oauth/access_token`);
  tokenUrl.searchParams.set('client_id', requiredEnv('META_APP_ID'));
  tokenUrl.searchParams.set('client_secret', requiredEnv('META_APP_SECRET'));
  tokenUrl.searchParams.set('redirect_uri', redirectUri);
  tokenUrl.searchParams.set('code', code);
  const short = await providerJson(tokenUrl.toString());
  const longUrl = new URL(`https://graph.facebook.com/${graphVersion()}/oauth/access_token`);
  longUrl.searchParams.set('grant_type', 'fb_exchange_token');
  longUrl.searchParams.set('client_id', requiredEnv('META_APP_ID'));
  longUrl.searchParams.set('client_secret', requiredEnv('META_APP_SECRET'));
  longUrl.searchParams.set('fb_exchange_token', short.access_token);
  const long = await providerJson(longUrl.toString());
  const authorizerUrl = new URL(`https://graph.facebook.com/${graphVersion()}/me`);
  authorizerUrl.searchParams.set('fields', 'id');
  authorizerUrl.searchParams.set('access_token', long.access_token);
  const authorizer = await providerJson(authorizerUrl.toString());
  if (!/^[0-9]+$/.test(String(authorizer?.id || ''))) throw new Error('messenger_authorizer_identity_missing');
  const accountsUrl = new URL(`https://graph.facebook.com/${graphVersion()}/me/accounts`);
  accountsUrl.searchParams.set('fields', 'id,name,access_token,tasks');
  accountsUrl.searchParams.set('access_token', long.access_token);
  const accounts = await providerJson(accountsUrl.toString());
  const eligible = (Array.isArray(accounts.data) ? accounts.data : []).filter((page: any) =>
    page?.id && page?.access_token && (!Array.isArray(page.tasks) || page.tasks.includes('MESSAGING')),
  );
  if (eligible.length !== 1) throw new Error(eligible.length ? 'messenger_account_selection_required' : 'messenger_no_eligible_page');
  const page = eligible[0];
  await providerJson(`https://graph.facebook.com/${graphVersion()}/${encodeURIComponent(page.id)}/subscribed_apps`, {
    method: 'POST', headers: { Authorization: `Bearer ${page.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscribed_fields: ['messages', 'messaging_postbacks', 'feed'] }),
  });
  return {
    providerAccountId: String(page.id),
    credential: { accessToken: String(page.access_token), tokenType: 'page' },
    tokenExpiresAt: null,
    grantedScopes: PROVIDER_SCOPES.messenger,
    metadata: { display_name: page.name || 'Facebook Page', authorizing_meta_user_id: String(authorizer.id) },
  };
}

export function whatsappLaunchConfiguration(state: string) {
  return {
    appId: requiredEnv('META_APP_ID'),
    configId: requiredEnv('WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID'),
    graphVersion: graphVersion(),
    state,
  };
}

export async function completeWhatsApp(input: {
  code: string;
  wabaId: string;
  phoneNumberId: string;
  redirectUri: string;
}): Promise<ProviderConnectionResult> {
  const tokenUrl = new URL(`https://graph.facebook.com/${graphVersion()}/oauth/access_token`);
  tokenUrl.searchParams.set('client_id', requiredEnv('META_APP_ID'));
  tokenUrl.searchParams.set('client_secret', requiredEnv('META_APP_SECRET'));
  tokenUrl.searchParams.set('code', input.code);
  const tokenResult = await providerJson(tokenUrl.toString());
  const token = String(tokenResult.access_token || '');
  const pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await providerJson(`https://graph.facebook.com/${graphVersion()}/${encodeURIComponent(input.phoneNumberId)}/register`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
  });
  await providerJson(`https://graph.facebook.com/${graphVersion()}/${encodeURIComponent(input.wabaId)}/subscribed_apps`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  const number = await providerJson(`https://graph.facebook.com/${graphVersion()}/${encodeURIComponent(input.phoneNumberId)}?fields=id,display_phone_number,verified_name&access_token=${encodeURIComponent(token)}`);
  return {
    providerAccountId: input.phoneNumberId,
    providerConnectionId: input.wabaId,
    credential: { accessToken: token, tokenType: 'business', twoStepPin: pin },
    tokenExpiresAt: expiresAt(tokenResult.expires_in),
    grantedScopes: PROVIDER_SCOPES.whatsapp,
    metadata: {
      display_name: number.verified_name || number.display_phone_number || 'WhatsApp Business',
      waba_id: input.wabaId,
      phone_number_id: input.phoneNumberId,
    },
  };
}

export async function completeManualWhatsApp(input: {
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
}): Promise<ProviderConnectionResult> {
  const token = String(input.accessToken || '').trim();
  const wabaId = String(input.wabaId || '').trim();
  const phoneNumberId = String(input.phoneNumberId || '').trim();

  const number = await providerJson(
    `https://graph.facebook.com/${graphVersion()}/${encodeURIComponent(phoneNumberId)}?fields=id,display_phone_number,verified_name&access_token=${encodeURIComponent(token)}`,
  );

  if (String(number?.id || '') !== phoneNumberId) {
    throw new Error('whatsapp_phone_number_mismatch');
  }

  const phonesUrl = new URL(
    `https://graph.facebook.com/${graphVersion()}/${encodeURIComponent(wabaId)}/phone_numbers`,
  );
  phonesUrl.searchParams.set('fields', 'id');
  phonesUrl.searchParams.set('limit', '100');
  phonesUrl.searchParams.set('access_token', token);

  const phones = await providerJson(phonesUrl.toString());
  const belongsToWaba = (Array.isArray(phones?.data) ? phones.data : [])
    .some((item: any) => String(item?.id || '') === phoneNumberId);

  if (!belongsToWaba) {
    throw new Error('whatsapp_waba_phone_mismatch');
  }

  await providerJson(
    `https://graph.facebook.com/${graphVersion()}/${encodeURIComponent(wabaId)}/subscribed_apps`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    },
  );

  return {
    providerAccountId: phoneNumberId,
    providerConnectionId: wabaId,
    credential: {
      accessToken: token,
      tokenType: 'business',
    },
    tokenExpiresAt: null,
    grantedScopes: PROVIDER_SCOPES.whatsapp,
    metadata: {
      display_name: number.verified_name || number.display_phone_number || 'WhatsApp Business',
      waba_id: wabaId,
      phone_number_id: phoneNumberId,
      connection_method: 'manual',
    },
  };
}

export async function revokeProviderCredential(provider: ChannelProvider, accessToken: string): Promise<void> {
  if (provider === 'telegram') return;
  const endpoint = provider === 'instagram'
    ? `https://graph.instagram.com/${graphVersion()}/me/permissions`
    : `https://graph.facebook.com/${graphVersion()}/me/permissions`;
  const response = await fetch(`${endpoint}?access_token=${encodeURIComponent(accessToken)}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) throw new Error(`provider_revoke_failed:${response.status}`);
}

export async function verifyProviderCredential(input: {
  provider: ChannelProvider;
  providerAccountId: string;
  providerConnectionId?: string | null;
  accessToken: string;
}): Promise<'connected' | 'authorization_invalid' | 'provider_unavailable'> {
  let url: string;
  if (input.provider === 'telegram') {
    const method = input.providerConnectionId ? 'getBusinessConnection' : 'getMe';
    url = `https://api.telegram.org/bot${input.accessToken}/${method}`;
    if (input.providerConnectionId) url += `?business_connection_id=${encodeURIComponent(input.providerConnectionId)}`;
  } else {
    const origin = input.provider === 'instagram' ? 'https://graph.instagram.com' : 'https://graph.facebook.com';
    url = `${origin}/${graphVersion()}/${encodeURIComponent(input.providerAccountId)}?fields=id&access_token=${encodeURIComponent(input.accessToken)}`;
  }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(6_000) });
    const data = await response.json().catch(() => null);
    if (response.ok && data?.ok !== false && !data?.error) return 'connected';
    const code = Number(data?.error?.code || data?.error_code);
    if (response.status === 401 || response.status === 403 || code === 190 || code === 401) return 'authorization_invalid';
    return 'provider_unavailable';
  } catch {
    return 'provider_unavailable';
  }
}
