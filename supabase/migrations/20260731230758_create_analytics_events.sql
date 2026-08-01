create table public.analytics_events (
  id uuid primary key default gen_random_uuid(),
  business_id bigint not null,
  event_name text not null,
  event_category text not null,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  conversation_id text,
  booking_id bigint,
  customer_key text,
  platform text,
  channel text,
  service_id text,
  service_name_snapshot text,
  language text,
  source text not null,
  actor text not null,
  outcome text not null,
  reason_code text,
  numeric_value numeric(18, 4),
  currency char(3),
  metadata jsonb not null default '{}'::jsonb,
  schema_version smallint not null default 1,
  idempotency_key text not null,

  constraint analytics_events_business_id_idempotency_key_key
    unique (business_id, idempotency_key),
  constraint analytics_events_schema_version_positive
    check (schema_version > 0),
  constraint analytics_events_metadata_object
    check (jsonb_typeof(metadata) = 'object'),
  constraint analytics_events_currency_format
    check (currency is null or currency::text ~ '^[A-Z]{3}$'),
  constraint analytics_events_event_name_length
    check (char_length(btrim(event_name)) between 1 and 100),
  constraint analytics_events_event_category_length
    check (char_length(btrim(event_category)) between 1 and 50),
  constraint analytics_events_source_length
    check (char_length(btrim(source)) between 1 and 100),
  constraint analytics_events_actor_length
    check (char_length(btrim(actor)) between 1 and 30),
  constraint analytics_events_outcome_length
    check (char_length(btrim(outcome)) between 1 and 30),
  constraint analytics_events_idempotency_key_length
    check (char_length(btrim(idempotency_key)) between 1 and 255),
  constraint analytics_events_customer_key_length
    check (
      customer_key is null
      or char_length(btrim(customer_key)) between 1 and 255
    ),
  constraint analytics_events_platform_length
    check (platform is null or char_length(btrim(platform)) between 1 and 50),
  constraint analytics_events_channel_length
    check (channel is null or char_length(btrim(channel)) between 1 and 50),
  constraint analytics_events_service_id_length
    check (
      service_id is null
      or char_length(btrim(service_id)) between 1 and 255
    ),
  constraint analytics_events_service_name_snapshot_length
    check (
      service_name_snapshot is null
      or char_length(btrim(service_name_snapshot)) between 1 and 255
    ),
  constraint analytics_events_language_length
    check (language is null or char_length(btrim(language)) between 1 and 20),
  constraint analytics_events_reason_code_length
    check (
      reason_code is null
      or char_length(btrim(reason_code)) between 1 and 100
    ),
  constraint analytics_events_conversation_id_length
    check (
      conversation_id is null
      or char_length(btrim(conversation_id)) between 1 and 255
    )
);

create index analytics_events_business_occurred_at_idx
  on public.analytics_events (business_id, occurred_at desc);

create index analytics_events_business_event_occurred_at_idx
  on public.analytics_events (business_id, event_name, occurred_at desc);

create index analytics_events_business_booking_occurred_at_idx
  on public.analytics_events (business_id, booking_id, occurred_at desc)
  where booking_id is not null;

create index analytics_events_business_customer_occurred_at_idx
  on public.analytics_events (business_id, customer_key, occurred_at desc)
  where customer_key is not null;

comment on table public.analytics_events is
  'Append-only analytics and reporting projections. Operational tables remain authoritative.';

comment on column public.analytics_events.business_id is
  'Immutable tenant correlation snapshot. Intentionally non-referential in V1 so analytics cannot affect operational business deletion.';

comment on column public.analytics_events.booking_id is
  'Immutable operational correlation snapshot without referential enforcement. Reconciliation detects missing operational appointments.';

comment on column public.analytics_events.customer_key is
  'Pseudonymous hashed customer key. Must never contain a raw phone number, email address, or provider identity.';

comment on column public.analytics_events.numeric_value is
  'Numeric value interpreted according to the versioned analytics event contract.';

comment on column public.analytics_events.currency is
  'ISO-style three-letter uppercase currency code when numeric_value represents money.';

comment on column public.analytics_events.metadata is
  'Non-PII event metadata. Must never contain raw messages, names, contact details, tokens, secrets, or webhook payloads.';

alter table public.analytics_events enable row level security;

create function public.prevent_analytics_events_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'public.analytics_events is append-only; % operations are not permitted',
    tg_op
    using errcode = '55000';
end;
$$;

comment on function public.prevent_analytics_events_mutation() is
  'Rejects updates and deletes so analytics events remain immutable and append-only.';

create trigger analytics_events_prevent_update_delete
before update or delete on public.analytics_events
for each row
execute function public.prevent_analytics_events_mutation();
