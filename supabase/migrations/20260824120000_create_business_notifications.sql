create table public.business_notifications (
  id uuid primary key default gen_random_uuid(),
  business_id bigint not null references public.businesses(id) on delete cascade,
  condition_key text not null,
  category text not null check (category in ('integration', 'booking', 'conversation', 'account_system')),
  severity text not null check (severity in ('info', 'attention', 'critical')),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  description text not null check (char_length(btrim(description)) between 1 and 300),
  first_observed_at timestamptz not null,
  last_observed_at timestamptz not null,
  read_at timestamptz,
  resolved_at timestamptz,
  action_type text check (action_type is null or action_type in ('open_health', 'open_activity')),
  action_target text check (action_target is null or action_target in ('#health', '#activity')),
  source_type text not null check (source_type in ('integration_health', 'booking_failure')),
  reason_code text not null check (char_length(btrim(reason_code)) between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, condition_key)
);

create index business_notifications_active_idx
  on public.business_notifications (business_id, last_observed_at desc)
  where resolved_at is null;

create index business_notifications_unread_idx
  on public.business_notifications (business_id, last_observed_at desc)
  where resolved_at is null and read_at is null;

alter table public.business_notifications enable row level security;

comment on table public.business_notifications is
  'Tenant-scoped durable read model for actionable dashboard notifications. Written only by the authenticated server projection.';

comment on column public.business_notifications.condition_key is
  'Internal deterministic deduplication identity; never returned by the notification API.';
