create table public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  business_id bigint not null references public.businesses(id) on delete cascade,

  provider text not null default 'google',
  provider_account_id text,
  calendar_id text not null,

  credential_ciphertext text not null,
  credential_key_id text not null default 'v1',
  token_expires_at timestamptz,
  granted_scopes text[] not null default '{}',

  status text not null default 'connected',
  connected_at timestamptz,
  last_verified_at timestamptz,
  reconnect_required boolean not null default false,

  metadata jsonb not null default '{}'::jsonb,

  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint calendar_connections_business_id_positive
    check (business_id > 0),

  constraint calendar_connections_provider_valid
    check (provider = 'google'),

  constraint calendar_connections_calendar_id_present
    check (btrim(calendar_id) <> ''),

  constraint calendar_connections_credential_present
    check (btrim(credential_ciphertext) <> ''),

  constraint calendar_connections_status_valid
    check (
      status in (
        'pending',
        'connected',
        'reconnect_required',
        'connection_error',
        'disconnected'
      )
    ),

  constraint calendar_connections_business_provider_key
    unique (business_id, provider)
);

comment on table public.calendar_connections is
  'Backend-only Google Calendar connection and encrypted OAuth credential storage per business.';

comment on column public.calendar_connections.credential_ciphertext is
  'AES-256-GCM credential envelope encrypted by the OdinLink server; never frontend-readable.';

create index calendar_connections_business_status_idx
  on public.calendar_connections (business_id, status);

create function public.set_calendar_connection_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger calendar_connections_set_updated_at
before update on public.calendar_connections
for each row execute function public.set_calendar_connection_updated_at();

alter table public.calendar_connections enable row level security;

revoke all on table public.calendar_connections from public, anon, authenticated;

revoke all on function public.set_calendar_connection_updated_at()
  from public, anon, authenticated;

grant select, insert, update, delete
  on table public.calendar_connections
  to service_role;

create table public.calendar_authorization_sessions (
  id uuid primary key default gen_random_uuid(),
  business_id bigint not null references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,

  provider text not null default 'google',
  state_hash text not null unique,
  browser_nonce_hash text not null,
  redirect_uri text not null,

  metadata jsonb not null default '{}'::jsonb,

  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),

  constraint calendar_authorization_sessions_business_id_positive
    check (business_id > 0),

  constraint calendar_authorization_sessions_provider_valid
    check (provider = 'google'),

  constraint calendar_authorization_sessions_state_present
    check (btrim(state_hash) <> ''),

  constraint calendar_authorization_sessions_nonce_present
    check (btrim(browser_nonce_hash) <> ''),

  constraint calendar_authorization_sessions_redirect_present
    check (btrim(redirect_uri) <> ''),

  constraint calendar_authorization_sessions_expiry_valid
    check (expires_at > created_at)
);

comment on table public.calendar_authorization_sessions is
  'Short-lived, single-use Google Calendar OAuth authorization sessions bound to a business, user and browser nonce.';

create index calendar_authorization_sessions_owner_idx
  on public.calendar_authorization_sessions
  (business_id, user_id, expires_at desc);

create function public.consume_calendar_authorization_session(
  p_state_hash text,
  p_browser_nonce_hash text
)
returns table (
  id uuid,
  business_id bigint,
  user_id uuid,
  redirect_uri text,
  metadata jsonb
)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  return query
  update public.calendar_authorization_sessions as session
  set consumed_at = now()
  where session.state_hash = p_state_hash
    and session.browser_nonce_hash = p_browser_nonce_hash
    and session.provider = 'google'
    and session.consumed_at is null
    and session.expires_at > now()
  returning
    session.id,
    session.business_id,
    session.user_id,
    session.redirect_uri,
    session.metadata;
end;
$$;

alter table public.calendar_authorization_sessions enable row level security;

revoke all on table public.calendar_authorization_sessions
  from public, anon, authenticated;

revoke all on function public.consume_calendar_authorization_session(text, text)
  from public, anon, authenticated;

grant select, insert, update, delete
  on table public.calendar_authorization_sessions
  to service_role;

grant execute
  on function public.consume_calendar_authorization_session(text, text)
  to service_role;
