import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequireAuth } from './require-auth';
import { createRequireBusinessPermission } from './require-business-access';
import { roleHasPermission } from './permissions';
import { requestPasswordRecovery } from './password-recovery';
import { safePathAfterOAuthFailure, startGoogleOAuth } from './google-oauth';

type TestResponse = {
  statusCode: number;
  body: unknown;
  status: (code: number) => TestResponse;
  json: (body: unknown) => TestResponse;
};

function response(): TestResponse {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function runMiddleware(
  middleware: (request: any, response: any, next: () => void) => Promise<void>,
  request: any,
) {
  const res = response();
  let nextCalled = false;
  await middleware(request, res, () => { nextCalled = true; });
  return { response: res, nextCalled, request };
}

function authRequest(authorization?: string) {
  return {
    header(name: string) {
      return name.toLowerCase() === 'authorization' ? authorization : undefined;
    },
  };
}

function verificationClient(user: { id: string; email?: string } | null, fail = false): any {
  return {
    auth: {
      async getUser() {
        if (fail) throw new Error('sensitive verification detail');
        return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'invalid JWT' } };
      },
    },
  };
}

function membershipClient(row: Record<string, unknown> | null, fail = false): any {
  return {
    from(table: string) {
      assert.equal(table, 'business_memberships');
      const filters = new Map<string, unknown>();
      const chain: any = {
        select(columns: string) {
          assert.equal(columns, 'business_id,user_id,role,status');
          return chain;
        },
        eq(column: string, value: unknown) {
          filters.set(column, value);
          return chain;
        },
        async maybeSingle() {
          if (fail) return { data: null, error: { message: 'sensitive database detail' } };
          const matches = row
            && Array.from(filters).every(([key, value]) => row[key] === value);
          return { data: matches ? row : null, error: null };
        },
      };
      return chain;
    },
  };
}

async function runTests() {
  const user = { id: '11111111-1111-4111-8111-111111111111', email: 'operator@example.test' };
  const requireAuth = createRequireAuth(verificationClient(user));

  for (const header of [undefined, '', 'Basic abc', 'Bearer', 'Bearer token extra']) {
    const result = await runMiddleware(requireAuth, authRequest(header));
    assert.equal(result.response.statusCode, 401);
    assert.deepEqual(result.response.body, { error: 'unauthenticated' });
    assert.equal(result.nextCalled, false);
  }

  const invalid = await runMiddleware(
    createRequireAuth(verificationClient(null)),
    authRequest('Bearer invalid-token'),
  );
  assert.equal(invalid.response.statusCode, 401);
  assert.doesNotMatch(JSON.stringify(invalid.response.body), /JWT|sensitive/i);

  const verificationFailure = await runMiddleware(
    createRequireAuth(verificationClient(null, true)),
    authRequest('Bearer expired-token'),
  );
  assert.equal(verificationFailure.response.statusCode, 401);
  assert.deepEqual(verificationFailure.response.body, { error: 'unauthenticated' });

  const authenticated = await runMiddleware(requireAuth, authRequest('Bearer valid-token'));
  assert.equal(authenticated.nextCalled, true);
  assert.deepEqual(authenticated.request.auth, { userId: user.id });

  const activeOwner = {
    business_id: 7,
    user_id: user.id,
    role: 'owner',
    status: 'active',
  };
  const ownerAccess = createRequireBusinessPermission('business.manage', {
    client: membershipClient(activeOwner),
  });
  const allowed = await runMiddleware(ownerAccess, {
    auth: { userId: user.id },
    params: { businessId: '7' },
  });
  assert.equal(allowed.nextCalled, true);
  assert.deepEqual(allowed.request.businessAccess, { businessId: 7, role: 'owner' });

  for (const row of [
    null,
    { ...activeOwner, status: 'suspended' },
    { ...activeOwner, status: 'revoked' },
    { ...activeOwner, business_id: 8 },
  ]) {
    const denied = await runMiddleware(
      createRequireBusinessPermission('business.read', { client: membershipClient(row) }),
      { auth: { userId: user.id }, params: { businessId: '7' } },
    );
    assert.equal(denied.response.statusCode, 403);
    assert.deepEqual(denied.response.body, { error: 'forbidden' });
  }

  const viewerDenied = await runMiddleware(
    createRequireBusinessPermission('settings.manage', {
      client: membershipClient({ ...activeOwner, role: 'viewer' }),
    }),
    { auth: { userId: user.id }, params: { id: '7' } },
  );
  assert.equal(viewerDenied.response.statusCode, 403);
  assert.equal(roleHasPermission('agent', 'conversations.send'), true);
  assert.equal(roleHasPermission('agent', 'settings.manage'), false);
  assert.equal(roleHasPermission('viewer', 'analytics.read'), true);
  assert.equal(roleHasPermission('owner', 'business.delete'), true);
  for (const role of ['admin', 'manager', 'agent', 'viewer'] as const) {
    assert.equal(roleHasPermission(role, 'business.delete'), false);
  }

  const adminDeleteDenied = await runMiddleware(
    createRequireBusinessPermission('business.delete', {
      client: membershipClient({ ...activeOwner, role: 'admin' }),
    }),
    { auth: { userId: user.id }, params: { id: '7' } },
  );
  assert.equal(adminDeleteDenied.response.statusCode, 403);

  const crossTenantDeleteDenied = await runMiddleware(
    createRequireBusinessPermission('business.delete', {
      client: membershipClient({ ...activeOwner, business_id: 8 }),
    }),
    { auth: { userId: user.id }, params: { id: '7' } },
  );
  assert.equal(crossTenantDeleteDenied.response.statusCode, 403);

  const ownerDeleteAllowed = await runMiddleware(
    createRequireBusinessPermission('business.delete', {
      client: membershipClient(activeOwner),
    }),
    { auth: { userId: user.id }, params: { id: '7' } },
  );
  assert.equal(ownerDeleteAllowed.nextCalled, true);

  const invalidBusiness = await runMiddleware(ownerAccess, {
    auth: { userId: user.id },
    params: { businessId: '7 OR 1=1' },
  });
  assert.equal(invalidBusiness.response.statusCode, 400);
  assert.deepEqual(invalidBusiness.response.body, { error: 'invalid_business_id' });

  const lookupFailure = await runMiddleware(
    createRequireBusinessPermission('business.read', { client: membershipClient(null, true) }),
    { auth: { userId: user.id }, params: { businessId: '7' } },
  );
  assert.equal(lookupFailure.response.statusCode, 500);
  assert.deepEqual(lookupFailure.response.body, { error: 'authorization_failed' });

  const migration = readFileSync(new URL('../../supabase/migrations/20260801120000_create_business_memberships.sql', import.meta.url), 'utf8');
  assert.match(migration, /unique \(business_id, user_id\)/i);
  assert.match(migration, /role in \('owner', 'admin', 'manager', 'agent', 'viewer'\)/i);
  assert.match(migration, /status in \('active', 'invited', 'suspended', 'revoked'\)/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /auth\.uid\(\) = user_id and status = 'active'/i);
  assert.match(migration, /revoke insert, update, delete .* from anon, authenticated/i);
  assert.match(migration, /new\.updated_at = greatest\(now\(\), new\.created_at\)/i);
  assert.match(migration, /before update on public\.business_memberships[\s\S]*execute function public\.set_business_membership_updated_at\(\)/i);
  assert.match(migration, /create function public\.create_business_with_owner[\s\S]*insert into public\.businesses[\s\S]*insert into public\.business_memberships/i);
  assert.match(migration, /create function public\.delete_business_with_memberships[\s\S]*for update[\s\S]*delete from public\.business_memberships[\s\S]*delete from public\.businesses[\s\S]*deleted_business_count <> 1[\s\S]*raise exception/i);
  assert.match(migration, /revoke all on function public\.create_business_with_owner[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /revoke all on function public\.delete_business_with_memberships[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.create_business_with_owner[\s\S]*to service_role/i);
  assert.match(migration, /grant execute on function public\.delete_business_with_memberships[\s\S]*to service_role/i);
  assert.doesNotMatch(migration, /security definer|execute on function[^;]+to (?:anon|authenticated)/i);
  const createResponse = migration.match(/return jsonb_build_object\(([\s\S]*?)\n  \);/)?.[1] || '';
  assert.doesNotMatch(createResponse, /access_token|verify_token|bot_token|app_secret/i);
  assert.doesNotMatch(migration, /using\s*\(\s*true\s*\)|values\s*\([^<]*[0-9a-f]{8}-[0-9a-f-]{27,}/i);
  assert.doesNotMatch(migration, /\b(drop|truncate)\b|alter table public\.(analytics_events|appointments|chat_history)/i);

  const login = readFileSync(new URL('../pages/Login.tsx', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  const api = readFileSync(new URL('../services/api.ts', import.meta.url), 'utf8');
  const browserAuth = readFileSync(new URL('./supabase-browser.ts', import.meta.url), 'utf8');
  const authProvider = readFileSync(new URL('./AuthProvider.tsx', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(login, /setTimeout|350/);
  assert.match(login, /signIn\(/);
  assert.match(login, /Continue with Google/);
  assert.match(login, /className="google-login-btn"[\s\S]*type="button"/);
  assert.match(login, /const continueWithGoogle = async \(\) => \{[\s\S]*if \(busyAction\) return;[\s\S]*setBusyAction\('google'\)/);
  assert.match(login, /className="google-login-btn"[\s\S]*disabled=\{busyAction !== null\}/);
  assert.match(login, /Business access is assigned separately after sign-in\./);
  assert.match(login, /requestPasswordReset/);
  assert.match(app, /route === '\/dashboard' && !user/);
  assert.match(api, /Authorization: `Bearer \$\{accessToken\}`/);
  assert.doesNotMatch(api, /access_token.*[?&]|console\.(log|error).*token/i);
  assert.doesNotMatch(browserAuth, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(authProvider, /requestPasswordRecovery/);
  assert.match(authProvider, /signInWithGoogle: \(\) => Promise<AuthResult>/);
  assert.match(authProvider, /startGoogleOAuth\([\s\S]*window\.location\.origin/);
  assert.doesNotMatch(authProvider, /console\.(?:log|error).*email|console\.(?:log|error).*token/i);
  assert.match(server, /app\.get\('\/api\/businesses', requireAuth/);
  assert.match(server, /business_memberships[\s\S]*\.eq\('user_id', userId\)[\s\S]*\.eq\('status', 'active'\)/);
  const safeColumns = server.match(/const DASHBOARD_BUSINESS_COLUMNS = \[([\s\S]*?)\]\.join/)?.[1] || '';
  assert.doesNotMatch(safeColumns, /access_token|verify_token|app_secret|bot_token/i);
  const salonColumns = server.match(/const DASHBOARD_SALON_COLUMNS = '([^']+)'/)?.[1] || '';
  assert.equal(salonColumns, 'id,salon_name,business_id,status');
  assert.doesNotMatch(salonColumns, /access_token|verify_token|app_secret|bot_token|credential/i);
  assert.match(server, /from\('salons'\)[\s\S]*?\.select\(DASHBOARD_SALON_COLUMNS\)/);
  const knowledgeRoutes = server.match(/const knowledgeTemporarilyUnavailable[\s\S]*?app\.get\("\/webhook\/instagram"/)?.[0] || '';
  assert.match(knowledgeRoutes, /status\(503\)\.json\(\{ error: 'feature_temporarily_unavailable' \}\)/);
  assert.match(knowledgeRoutes, /app\.get\('\/knowledge', requireAuth, knowledgeTemporarilyUnavailable\)/);
  assert.match(knowledgeRoutes, /app\.post\('\/knowledge', requireAuth, knowledgeTemporarilyUnavailable\)/);
  assert.match(knowledgeRoutes, /app\.delete\('\/knowledge\/:id', requireAuth, knowledgeTemporarilyUnavailable\)/);
  assert.match(knowledgeRoutes, /app\.post\('\/knowledge\/search', requireAuth, knowledgeTemporarilyUnavailable\)/);
  assert.doesNotMatch(knowledgeRoutes, /knowledgeService\.(?:list|addSource|deleteSource|search)/);
  assert.match(server, /requireBusinessPermission\('business\.delete'\)[\s\S]*?\.rpc\(\s*'delete_business_with_memberships'/);
  assert.match(server, /p_owner_user_id: authenticatedRequest\.auth!\.userId/);
  assert.match(server, /\.rpc\(\s*'create_business_with_owner'/);
  assert.doesNotMatch(server, /membershipError[\s\S]*businesses'\)\.delete/);
  assert.doesNotMatch(server, /console\.log\(JSON\.stringify\((?:req\.body|body)/);
  assert.doesNotMatch(server, /Business lookup failed:[^\n]*businessError/);
  assert.doesNotMatch(server, /from "\.\/src\/auth"/);
  for (const publicRoute of [
    'app.post("/api/telegram-webhook", async',
    'app.post("/webhook", async',
    'app.post("/webhook/messenger", async',
    'app.post("/webhook/instagram", async',
  ]) assert.ok(server.includes(publicRoute), publicRoute);
  assert.equal((server.match(/app\.get\(["']\/webhook\/instagram["']/g) || []).length, 1);
  assert.equal((server.match(/app\.post\(["']\/webhook\/instagram["']/g) || []).length, 1);
  assert.doesNotMatch(server, /analytics\/queries|getAnalyticsMetrics/);

  let oauthRequest: unknown;
  const oauthAccepted = await startGoogleOAuth({
    auth: {
      async signInWithOAuth(request: unknown) {
        oauthRequest = request;
        return { data: { provider: 'google', url: 'https://accounts.example.test/' }, error: null };
      },
    },
  } as any, 'https://odinlink.example');
  assert.deepEqual(oauthAccepted, { ok: true });
  assert.deepEqual(oauthRequest, {
    provider: 'google',
    options: { redirectTo: 'https://odinlink.example/login' },
  });
  assert.doesNotMatch(JSON.stringify(oauthRequest), /scope|redirect.*(javascript:|data:)|membership|role/i);

  const oauthFailure = await startGoogleOAuth({
    auth: {
      async signInWithOAuth() {
        return { data: { provider: 'google', url: null }, error: { message: 'raw oauth detail' } };
      },
    },
  } as any, 'https://odinlink.example');
  assert.deepEqual(oauthFailure, { ok: false, error: 'authentication_failed' });
  assert.doesNotMatch(JSON.stringify(oauthFailure), /raw oauth detail|odinlink\.example/i);

  assert.equal(
    safePathAfterOAuthFailure('https://odinlink.example/login?error=access_denied&error_description=raw+detail'),
    '/login',
  );
  assert.equal(
    safePathAfterOAuthFailure('https://odinlink.example/login?mode=reset&error=access_denied#refresh_token=secret'),
    '/login?mode=reset',
  );
  assert.equal(safePathAfterOAuthFailure('https://odinlink.example/login'), null);

  const googleOAuth = readFileSync(new URL('./google-oauth.ts', import.meta.url), 'utf8');
  assert.match(googleOAuth, /provider: 'google'/);
  assert.match(googleOAuth, /new URL\('\/login', origin\)/);
  assert.doesNotMatch(googleOAuth, /localStorage|access_token|refresh_token|business_memberships|\.from\(|scope/i);
  assert.doesNotMatch(`${login}\n${authProvider}\n${googleOAuth}`, /gmail|email.?domain|workspace.?domain|insert.*membership/i);

  const acceptedRecovery = await requestPasswordRecovery({
    auth: { async resetPasswordForEmail() { return { data: {}, error: null }; } },
  } as any, 'unknown-or-existing@example.test', 'https://example.test/login?mode=reset');
  assert.deepEqual(acceptedRecovery, { ok: true });

  const failedRecovery = await requestPasswordRecovery({
    auth: { async resetPasswordForEmail() { return { data: {}, error: { message: 'raw provider detail' } }; } },
  } as any, 'unknown-or-existing@example.test', 'https://example.test/login?mode=reset');
  assert.deepEqual(failedRecovery, { ok: false, error: 'authentication_failed' });
  assert.doesNotMatch(JSON.stringify(failedRecovery), /raw provider detail|example\.test/i);

  console.log('Authentication and authorization foundation tests passed.');
}

void runTests();
