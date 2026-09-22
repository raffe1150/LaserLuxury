import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { publicAppUrl } from './security';

type MetaProvider = 'messenger' | 'instagram';
type RequestType = 'deauthorization' | 'data_deletion';

export function verifyMetaSignedRequest(value: unknown, secret: string): { userId: string; issuedAt: Date } {
  if (!secret || typeof value !== 'string' || value.length > 8192 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('invalid_signed_request');
  }
  const [encodedSignature, encodedPayload] = value.split('.');
  const signature = Buffer.from(encodedSignature, 'base64url');
  const expected = crypto.createHmac('sha256', secret).update(encodedPayload).digest();
  if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) {
    throw new Error('invalid_signed_request');
  }
  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    throw new Error('invalid_signed_request');
  }
  const userId = String(payload?.user_id || '').trim();
  const issuedAtSeconds = Number(payload?.issued_at);
  if (!/^[0-9]{1,30}$/.test(userId) || !Number.isSafeInteger(issuedAtSeconds) ||
      issuedAtSeconds <= 0 || issuedAtSeconds > Math.floor(Date.now() / 1000) + 300 ||
      String(payload?.algorithm || '').toUpperCase() !== 'HMAC-SHA256') {
    throw new Error('invalid_signed_request');
  }
  return { userId, issuedAt: new Date(issuedAtSeconds * 1000) };
}

function appSecret(provider: MetaProvider): string {
  return String((provider === 'instagram' ? process.env.INSTAGRAM_APP_SECRET : process.env.META_APP_SECRET) || '').trim();
}

function fingerprint(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function confirmationCode(value: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(`odinlink:meta:data-deletion:${value}`).digest('hex');
}

async function matchingConnections(client: SupabaseClient, provider: MetaProvider, userId: string, issuedAt: Date) {
  // The authorizing Facebook user can own several Pages. Only revoke rows
  // explicitly bound to that app-scoped user; old unmapped rows need review.
  const query = client.from('channel_connections').select('id,business_id,provider_account_id,connected_at,status,metadata')
    .eq('provider', provider).neq('status', 'disconnected')
    .lte('connected_at', issuedAt.toISOString());
  const result = provider === 'instagram'
    ? await query.eq('provider_account_id', userId)
    : await query.contains('metadata', { authorizing_meta_user_id: userId });
  if (result.error) throw result.error;
  return result.data || [];
}

async function recordRequest(client: SupabaseClient, input: {
  provider: MetaProvider; requestType: RequestType; userId: string;
  signedRequest: string; issuedAt: Date; codeHash?: string;
}) {
  const { error } = await client.from('meta_compliance_requests').upsert({
    provider: input.provider,
    request_type: input.requestType,
    provider_user_id: input.userId,
    request_fingerprint: fingerprint(input.signedRequest),
    confirmation_code_hash: input.codeHash || null,
    issued_at: input.issuedAt.toISOString(),
  }, { onConflict: 'provider,request_type,request_fingerprint', ignoreDuplicates: true });
  if (error) throw error;
}

export async function processMetaComplianceRequest(client: SupabaseClient, input: {
  provider: MetaProvider; requestType: RequestType; signedRequest: string;
}): Promise<{ confirmationCode?: string; matchedConnectionIds: string[] }> {
  const secret = appSecret(input.provider);
  const { userId, issuedAt } = verifyMetaSignedRequest(input.signedRequest, secret);
  const code = input.requestType === 'data_deletion' ? confirmationCode(input.signedRequest, secret) : undefined;
  const codeHash = code ? fingerprint(code) : undefined;
  await recordRequest(client, { ...input, userId, issuedAt, codeHash });
  const matches = await matchingConnections(client, input.provider, userId, issuedAt);
  const ids = matches.map((row: any) => String(row.id));
  if (input.requestType === 'deauthorization') {
    for (const id of ids) {
      const { error } = await client.from('channel_connections').update({
        status: 'disconnected', reconnect_required: false, disconnected_at: new Date().toISOString(),
      }).eq('id', id).eq('provider', input.provider).neq('status', 'disconnected')
        .lte('connected_at', issuedAt.toISOString());
      if (error) throw error;
    }
  }
  if (input.requestType === 'data_deletion' || ids.length) {
    const patch = input.requestType === 'deauthorization'
      ? { matched_connection_ids: ids, status: 'deactivated' }
      : { matched_connection_ids: ids };
    const { error } = await client.from('meta_compliance_requests').update(patch)
      .eq('provider', input.provider).eq('request_type', input.requestType)
      .eq('request_fingerprint', fingerprint(input.signedRequest));
    if (error) throw error;
  }
  return { confirmationCode: code, matchedConnectionIds: ids };
}

export function createMetaComplianceRouter(client: SupabaseClient): express.Router {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: '16kb' }));

  for (const provider of ['messenger', 'instagram'] as const) {
    for (const [path, requestType] of [
      ['deauthorize', 'deauthorization'], ['data-deletion', 'data_deletion'],
    ] as const) {
      router.post(`/${provider}/${path}`, (request: Request, response: Response, next: NextFunction) => {
        const signedRequest = request.body?.signed_request;
        void processMetaComplianceRequest(client, { provider, requestType, signedRequest }).then((result) => {
          if (requestType === 'data_deletion') {
            response.json({
              url: `${publicAppUrl()}/api/meta/data-deletion/status/${result.confirmationCode}`,
              confirmation_code: result.confirmationCode,
            });
          } else {
            response.json({ success: true });
          }
        }).catch(next);
      });
    }
  }

  router.get('/data-deletion/status/:code', (request: Request, response: Response, next: NextFunction) => {
    const code = String(request.params.code || '');
    if (!/^[a-f0-9]{64}$/.test(code)) return response.sendStatus(404);
    void (async () => {
      const { data, error } = await client.from('meta_compliance_requests').select('status,received_at,completed_at')
        .eq('request_type', 'data_deletion').eq('confirmation_code_hash', fingerprint(code)).maybeSingle();
        if (error) throw error;
        if (!data) return response.sendStatus(404);
        response.json({ status: data.status, requested_at: data.received_at, completed_at: data.completed_at });
    })().catch(next);
  });

  router.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const invalid = (error as Error)?.message === 'invalid_signed_request';
    if (!invalid) console.error('[MetaCompliance]', { category: 'processing_failed' });
    response.status(invalid ? 401 : 503).json({ error: invalid ? 'invalid_signed_request' : 'temporarily_unavailable' });
  });
  return router;
}
