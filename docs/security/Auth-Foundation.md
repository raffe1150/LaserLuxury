# Authentication and authorization foundation

OdinLink uses Supabase Auth for operator identity. The browser uses only the
project URL and anonymous key, lets Supabase manage its supported session
storage, and attaches the current access token as an `Authorization: Bearer`
header through the central API helper. Express verifies that token with
`supabase.auth.getUser(token)` before accepting an operator request.

Tenant access is authoritative in `public.business_memberships`. Backend
authorization requires an exact authenticated `user_id`, requested
`business_id`, `status = 'active'`, and a role containing the route's required
permission. Browser business selection and role claims are never trusted.

## Environment

Local and Render environments require the following values for the same
Supabase project:

- `SUPABASE_URL` — server project URL.
- `SUPABASE_ANON_KEY` — server-side Auth verification key.
- `SUPABASE_SERVICE_ROLE_KEY` — server-only membership lookup key. Never use a
  `VITE_` prefix.
- `VITE_SUPABASE_URL` — browser-safe project URL, embedded during the Vite
  build.
- `VITE_SUPABASE_ANON_KEY` — browser-safe anonymous key, embedded during the
  Vite build. A publishable key may instead be supplied as
  `VITE_SUPABASE_PUBLISHABLE_KEY`.
- `APP_URL` — the deployed HTTPS application origin registered with Supabase.

In Supabase Auth URL Configuration, set the Site URL to `APP_URL` and allow the
exact `${APP_URL}/login?mode=reset` password-recovery redirect. Local
development must likewise allow the exact local origin used by the developer.

## Google OAuth login

Google login authenticates through Supabase Auth and does not grant business
access. Authentication provider data, Gmail address, Google Workspace domain,
and email domain are never used to create or infer a business membership. The
only authorization source remains an explicit active row in
`public.business_memberships` keyed by the exact Supabase Auth user UUID.

In the Supabase Dashboard, open **Authentication → Providers → Google**, enable
the provider, and enter the Google OAuth Client ID and Client Secret. Keep the
client secret only in Supabase provider configuration; do not add it to source,
frontend variables, `.env.example`, or Render.

In Google Cloud Console, create an OAuth 2.0 Client ID for a Web application.
Use the Supabase callback URL displayed by the Google provider configuration,
normally:

```text
https://<SUPABASE_PROJECT_REF>.supabase.co/auth/v1/callback
```

Do not use OdinLink's `/login` URL as the Google provider callback unless the
Supabase Dashboard explicitly instructs otherwise. Add authorized JavaScript
origins only if required by the selected Supabase flow.

OdinLink starts OAuth with a fixed same-origin application return URL:

```text
${window.location.origin}/login
```

Add these exact application redirects to Supabase Auth URL Configuration for
the environments that are actually used:

```text
http://localhost:3000/login
https://<STAGING_RENDER_HOST>/login
https://<PRODUCTION_RENDER_HOST>/login
```

If local development uses another port, register that exact origin instead.
Keep the existing password-recovery entries as well:

```text
http://localhost:3000/login?mode=reset
https://<STAGING_RENDER_HOST>/login?mode=reset
https://<PRODUCTION_RENDER_HOST>/login?mode=reset
```

After the first existing owner signs in with Google, copy the exact user UUID
from `auth.users` and follow the owner bootstrap procedure below. Never use the
Gmail address as the membership key and never automatically match an email to
a business.

## Existing-business owner bootstrap

The membership migration intentionally contains no production identities and
does not infer ownership. After the migration is reviewed and applied through
the normal deployment process, an authorized operator must obtain the exact
Supabase Auth user UUID and exact bigint business ID, verify both independently,
and run this statement once in the Supabase SQL editor with both placeholders
replaced:

```sql
insert into public.business_memberships (
  business_id,
  user_id,
  role,
  status,
  created_by
)
values (
  <EXACT_BUSINESS_BIGINT>,
  '<EXACT_AUTH_USER_UUID>'::uuid,
  'owner',
  'active',
  '<EXACT_AUTH_USER_UUID>'::uuid
);
```

Review the resulting row by exact `business_id` and `user_id`. Do not use an
email, provider identity, business name, selected browser state, or customer
identifier as ownership evidence. Existing dashboards remain inaccessible
until this explicit bootstrap is complete.

New businesses created by an already authenticated operator receive an active
owner membership for that verified user. The backend calls the
`create_business_with_owner` service-role RPC, so the business and membership
are committed together or both are rolled back. The RPC accepts the owner UUID
only from the verified backend request context and returns an allowlisted
business object without provider credentials.

Business deletion is owner-only through the dedicated `business.delete`
permission. The backend calls `delete_business_with_memberships`, which locks
the exact business and deletes its memberships and operational business row in
one transaction. Analytics events are deliberately retained. Ownership
transfer and last-owner transfer rules are not implemented and require a
future approved feature phase.

Both lifecycle RPCs use invoker security and are executable only by the
`service_role` database role. `PUBLIC`, `anon`, and `authenticated` execution is
revoked, so browser clients cannot call them directly. Membership updates use
a table-specific `BEFORE UPDATE` trigger to maintain `updated_at`.

## Route classification

Public provider infrastructure remains public: Telegram, Instagram, Messenger,
and Facebook webhook verification/delivery endpoints, public website chat and
transcription endpoints, temporary provider media delivery, static assets, and
the SPA fallback.

Operator routes require verified authentication. Business-scoped conversation,
booking, integration, settings, update, and delete routes additionally require
an active membership and the mapped permission. Business and salon listings are
filtered to active memberships and return explicit dashboard-safe columns.

The four dashboard Knowledge endpoints return HTTP 503 with
`feature_temporarily_unavailable`. The current Knowledge model has no business
key, so list, create, delete, and search remain disabled until a separately
approved tenant-scoped schema phase. Internal Knowledge service calls are not
removed, preserving current booking/AI behavior. Prompt generation remains
authenticated and does not read the Knowledge store.

Provider webhooks, website chat, transcription, and temporary media delivery
remain public. Audited webhook handlers do not log request payloads or raw
processing errors. Provider signature verification and hardening of public
chat, transcription, and media access remain a future Security Hardening phase.

No analytics API is added by this foundation.
