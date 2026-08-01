# Sprint 4.1 — Analytics Foundation

- **Status:** Approved for phased implementation

## Objective

Build a reliable, append-only analytics foundation that can later power:

- Dashboard metrics
- Charts
- Funnels
- Reports
- Channel performance
- Service performance
- Estimated booking value
- Estimated time saved
- Business insights

The implementation follows the contract established in [ADR-001: Analytics Event Contract](../adr/ADR-001-analytics-event-contract.md).

## Non-goals

Sprint 4.1 does not include:

- Dashboard redesign
- Charts
- Revenue claims
- Time-saved claims
- Lost-opportunity classification
- Full conversation lifecycle tracking
- A large `server.ts` refactor
- A data warehouse
- Kafka
- Materialized views
- External analytics infrastructure

## Approved implementation phases

### Phase A — Documentation and contract freeze

Establish and approve the analytics event contract and Sprint specification before creating database or runtime changes.

### Phase B — Create an empty, secure `analytics_events` table

Introduce the additive analytics storage layer without changing existing operational tables or production behavior.

### Phase C — Create a fail-open analytics recorder

Create an isolated recorder whose failures are contained and cannot interrupt authoritative business workflows.

### Phase D — Integrate `booking_created`

Record the event only after the authoritative booking operation has succeeded.

### Phase E — Integrate booking lifecycle events

Integrate `booking_rescheduled` and `booking_cancelled` after their respective authoritative operations succeed.

### Phase F — Integrate messaging events

Integrate `customer_message_received` and `human_message_sent` at verified success boundaries.

### Phase G — Reconciliation and validation

Compare analytics events with authoritative operational records, document coverage, and resolve discrepancies before releasing metrics.

### Phase H — Initial backend metric queries

Provide authorized backend queries with explicit metric definitions, periods, freshness, and coverage. The frontend must not query the event table directly.

## Production rules

1. `server.ts` behavior remains unchanged unless a small, isolated analytics call is added.
2. Analytics calls happen only after business success.
3. Analytics errors are contained and never break booking, calendar, notification, or conversation flows.
4. No customer-facing metric is released before reconciliation.
5. A fallback error must never be presented as a valid zero.
6. Every metric declares its definition, period, freshness, and coverage.
7. Legacy rows without `business_id` must not be presented as complete tenant data.
8. Existing monthly usage tables remain non-authoritative.
9. `reminder_sent` remains postponed until reminder concurrency is hardened.
10. Existing operational tables remain authoritative and are not replaced.

## Security constraints

- `analytics_events` is service-role write-only.
- Direct browser reads and writes are forbidden.
- Row-level security is deny-by-default.
- Backend authorization is required before customer-facing analytics APIs return data.
- Event metadata must not contain secrets or personally identifiable information.
- Customer correlation uses only a pseudonymous hashed key.

## Documentation-task definition of done

- `docs/adr/ADR-001-analytics-event-contract.md` exists and records the accepted contract.
- `docs/specifications/Sprint-4.1-Analytics-Foundation.md` exists and records the approved phased implementation.
- The `docs/adr`, `docs/architecture`, `docs/specifications`, and `docs/roadmap` directories exist.
- No runtime file is changed.
- No migration or executable code is created.
- No package or deployment configuration is changed.
- The Git diff contains documentation-only changes.

