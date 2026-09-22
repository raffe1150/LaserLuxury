-- Meta sends an app-scoped user identifier, not an OdinLink business ID. Keep
-- requests for manual review when no exact connection can be established.
create table public.meta_compliance_requests (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('messenger', 'instagram')),
  request_type text not null check (request_type in ('deauthorization', 'data_deletion')),
  provider_user_id text not null check (btrim(provider_user_id) <> ''),
  request_fingerprint text not null check (length(request_fingerprint) = 64),
  confirmation_code_hash text check (confirmation_code_hash is null or length(confirmation_code_hash) = 64),
  status text not null default 'pending_review'
    check (status in ('pending_review', 'deactivated', 'completed')),
  matched_connection_ids uuid[] not null default '{}',
  issued_at timestamptz not null,
  received_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint meta_compliance_requests_unique_delivery
    unique (provider, request_type, request_fingerprint),
  constraint meta_compliance_requests_deletion_code
    check (request_type <> 'data_deletion' or confirmation_code_hash is not null)
);

create unique index meta_compliance_requests_confirmation_code_key
  on public.meta_compliance_requests (confirmation_code_hash)
  where confirmation_code_hash is not null;

create index meta_compliance_requests_pending_idx
  on public.meta_compliance_requests (received_at)
  where status = 'pending_review';

alter table public.meta_compliance_requests enable row level security;
revoke all on table public.meta_compliance_requests from public, anon, authenticated;
grant select, insert, update on table public.meta_compliance_requests to service_role;

comment on table public.meta_compliance_requests is
  'Backend-only signed Meta deauthorization/deletion intake. Pending deletion requires verified manual fulfilment; no automatic tenant-wide deletion.';
