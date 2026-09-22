create table public.channel_connections (
  id uuid primary key default gen_random_uuid(),
  business_id bigint not null references public.businesses(id) on delete cascade,
  provider text not null,
  provider_account_id text not null,
  provider_connection_id text,
  credential_ciphertext text not null,
  credential_key_id text not null default 'v1',
  token_expires_at timestamptz,
  granted_scopes text[] not null default '{}',
  status text not null default 'connected',
  connected_at timestamptz,
  last_verified_at timestamptz,
  reconnect_required boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  source text not null default 'self_service',
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint channel_connections_business_id_positive check (business_id > 0),
  constraint channel_connections_provider_valid check (
    provider in ('instagram', 'messenger', 'whatsapp', 'telegram')
  ),
  constraint channel_connections_provider_account_present check (btrim(provider_account_id) <> ''),
  constraint channel_connections_credential_present check (btrim(credential_ciphertext) <> ''),
  constraint channel_connections_status_valid check (
    status in ('pending', 'connected', 'reconnect_required', 'connection_error', 'disconnected')
  ),
  constraint channel_connections_source_valid check (
    source in ('self_service', 'legacy_manual')
  ),
  constraint channel_connections_business_provider_key unique (business_id, provider)
);

comment on table public.channel_connections is
  'Backend-only authoritative channel-to-business mapping and encrypted provider credential envelope.';
comment on column public.channel_connections.credential_ciphertext is
  'AES-256-GCM credential envelope encrypted by the OdinLink server; never frontend-readable.';

create unique index channel_connections_active_provider_identity_key
  on public.channel_connections (provider, provider_account_id)
  where status <> 'disconnected';

create unique index channel_connections_active_provider_connection_key
  on public.channel_connections (provider, provider_connection_id)
  where provider_connection_id is not null and status <> 'disconnected';

create index channel_connections_business_status_idx
  on public.channel_connections (business_id, status, provider);

create table public.channel_authorization_sessions (
  id uuid primary key default gen_random_uuid(),
  business_id bigint not null references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  state_hash text not null unique,
  browser_nonce_hash text not null,
  redirect_uri text not null,
  provider_user_id text,
  metadata jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),

  constraint channel_authorization_sessions_business_id_positive check (business_id > 0),
  constraint channel_authorization_sessions_provider_valid check (
    provider in ('instagram', 'messenger', 'whatsapp', 'telegram')
  ),
  constraint channel_authorization_sessions_state_present check (btrim(state_hash) <> ''),
  constraint channel_authorization_sessions_nonce_present check (btrim(browser_nonce_hash) <> ''),
  constraint channel_authorization_sessions_redirect_present check (btrim(redirect_uri) <> ''),
  constraint channel_authorization_sessions_expiry_valid check (expires_at > created_at)
);

comment on table public.channel_authorization_sessions is
  'Short-lived, single-use authorization requests bound to a user, business, provider, browser nonce and exact redirect URI.';

create index channel_authorization_sessions_owner_idx
  on public.channel_authorization_sessions (business_id, user_id, provider, expires_at desc);

create index channel_authorization_sessions_telegram_claim_idx
  on public.channel_authorization_sessions (provider, provider_user_id, expires_at desc)
  where consumed_at is null and provider = 'telegram';

create function public.set_channel_connection_updated_at()
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

create trigger channel_connections_set_updated_at
before update on public.channel_connections
for each row execute function public.set_channel_connection_updated_at();

create function public.consume_channel_authorization_session(
  p_state_hash text,
  p_browser_nonce_hash text,
  p_provider text
)
returns table (
  id uuid,
  business_id bigint,
  user_id uuid,
  provider text,
  redirect_uri text,
  metadata jsonb
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  return query
  update public.channel_authorization_sessions as session
  set consumed_at = now()
  where session.state_hash = p_state_hash
    and session.browser_nonce_hash = p_browser_nonce_hash
    and session.provider = p_provider
    and session.consumed_at is null
    and session.expires_at > now()
  returning session.id, session.business_id, session.user_id,
    session.provider, session.redirect_uri, session.metadata;
end;
$$;

create function public.bind_telegram_channel_authorization_session(
  p_state_hash text,
  p_provider_user_id text
)
returns table (id uuid, business_id bigint, user_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  return query
  update public.channel_authorization_sessions as session
  set provider_user_id = p_provider_user_id
  where session.state_hash = p_state_hash
    and session.provider = 'telegram'
    and session.consumed_at is null
    and session.expires_at > now()
    and (session.provider_user_id is null or session.provider_user_id = p_provider_user_id)
  returning session.id, session.business_id, session.user_id;
end;
$$;

alter table public.channel_connections enable row level security;
alter table public.channel_authorization_sessions enable row level security;

revoke all on table public.channel_connections from public, anon, authenticated;
revoke all on table public.channel_authorization_sessions from public, anon, authenticated;
revoke all on function public.set_channel_connection_updated_at() from public, anon, authenticated;
revoke all on function public.consume_channel_authorization_session(text, text, text) from public, anon, authenticated;
revoke all on function public.bind_telegram_channel_authorization_session(text, text) from public, anon, authenticated;

grant select, insert, update, delete on table public.channel_connections to service_role;
grant select, insert, update, delete on table public.channel_authorization_sessions to service_role;
grant execute on function public.consume_channel_authorization_session(text, text, text) to service_role;
grant execute on function public.bind_telegram_channel_authorization_session(text, text) to service_role;
