begin;

create table public.odin_shadow_evaluations (
  id uuid primary key default gen_random_uuid(),

  business_id bigint not null,
  schema_version integer not null default 1,

  conversation_key text not null,
  channel text not null,
  provider_scope text not null default '',
  provider_event_id text not null,

  execution_mode text not null default 'shadow'
    check (execution_mode = 'shadow'),

  legacy_observation jsonb,
  shadow_decision jsonb not null,

  comparison text not null
    check (
      comparison in (
        'match',
        'divergent',
        'not_comparable'
      )
    ),

  evaluated_at timestamptz not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (
    business_id,
    channel,
    provider_scope,
    provider_event_id
  )
);

create index odin_shadow_evaluations_business_time_idx
  on public.odin_shadow_evaluations (
    business_id,
    evaluated_at desc
  );

create index odin_shadow_evaluations_comparison_idx
  on public.odin_shadow_evaluations (
    business_id,
    comparison,
    evaluated_at desc
  );

alter table public.odin_shadow_evaluations
  enable row level security;

revoke all
on table public.odin_shadow_evaluations
from anon, authenticated;

commit;
