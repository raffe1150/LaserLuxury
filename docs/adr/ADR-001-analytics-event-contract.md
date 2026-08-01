# ADR-001: Analytics Event Contract

- **Status:** Accepted
- **Schema version:** 1

## Context

OdinLink is evolving from an AI booking assistant into a business intelligence platform. The analytics layer must support dashboards, reports, charts, funnels, historical analysis, and business insights while remaining isolated from booking operations and never breaking production workflows.

Existing operational tables—including `appointments`, `chat_history`, and `businesses`—remain the authoritative sources of truth.

## Decision

OdinLink will use a lightweight, append-only analytics event layer. Analytics events are immutable projections created for analysis only; they do not replace or become authoritative over operational data.

### Approved V1 events

- `booking_created`
- `booking_rescheduled`
- `booking_cancelled`
- `customer_message_received`
- `human_message_sent`

### Postponed events

- `conversation_started`
- `conversation_resolved`
- `ai_message_sent`
- `booking_requested`
- `booking_intent_detected`
- `lost_opportunity`
- `recovered_opportunity`
- `reminder_sent`
- `human_handoff_requested`

## Event contract

### Required fields

- `id`
- `business_id`
- `event_name`
- `event_category`
- `occurred_at`
- `recorded_at`
- `schema_version`
- `source`
- `actor`
- `outcome`
- `idempotency_key`

### Optional correlation fields

- `conversation_id`
- `booking_id`
- `customer_key`
- `platform`
- `channel`
- `service_id`
- `service_name_snapshot`
- `language`
- `reason_code`
- `numeric_value`
- `currency`
- `metadata`

`business_id` and `booking_id` are immutable operational correlation snapshots.
They are not referentially enforced against `businesses` or `appointments`;
reconciliation detects snapshots whose operational records no longer exist.
Analytics must never block or modify operational business or appointment
deletion. Tenant existence is validated by the trusted recorder before an event
is inserted.

## Rules and invariants

1. Events are immutable and append-only.
2. Events are emitted only after authoritative business success.
3. Analytics failure must never break booking, calendar, notification, or conversation flows.
4. Every event requires `business_id`.
5. Every event requires a stable idempotency key.
6. Every event uses `schema_version = 1`.
7. Event names use lowercase snake_case and past-tense naming.
8. Raw messages, phone numbers, email addresses, names, tokens, and secrets must never be stored.
9. Customer correlation uses a tenant-separated pseudonymous keyed hash/HMAC.
10. Event metadata must not contain secrets or personally identifiable information.
11. The frontend never queries `analytics_events` directly.
12. The frontend reads metrics through authorized backend APIs.
13. Existing monthly usage tables are not authoritative analytics sources.
14. Existing operational tables are not replaced.

## Consequences

### Positive

- Trustworthy and reproducible metrics
- Historical traceability
- Safe, additive rollout without replacing operational systems
- A stable foundation for dashboards, reports, charts, funnels, and business insights
- Future compatibility with Website Chat, Voice, Email, the AI Business Advisor, and the AI Health Monitor

### Tradeoffs

- Some desired metrics must be postponed.
- Historical legacy data may remain incomplete.
- Operational and analytics data require reconciliation.
- Event definitions become versioned contracts that must be governed carefully.
