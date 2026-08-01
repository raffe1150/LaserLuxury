# Phase I: Internal Analytics Query Layer

Phase I converts append-only `analytics_events` into bounded, tenant-scoped
metrics. The module is internal and is not routed, scheduled, registered at
startup, or exported through the analytics recorder.

## Query contract

Every invocation requires a positive `businessId` and timezone-bearing `from`
and `to` timestamps. The interval is half-open: `[from, to)`. It may span at
most 366 days.

The loader reads only `event_name`, `occurred_at`, `platform`, and
`service_name_snapshot`. Each page is filtered by tenant, supported event name,
and the explicit occurrence-time window. Reads use deterministic ordering,
bounded pagination, and a `maxEvents + 1` sentinel instead of an exact count.
The default event cap is 20,000 and the hard cap is 50,000.

When the cap is reached, metrics are explicitly returned as partial with
`completeness.truncated = true`. The layer never queries appointments,
conversations, businesses, customer data, or other operational tables.

`generatedAt` records when aggregation completed. Coverage includes only
successfully persisted analytics events inside the requested window; it does not
claim completeness before each event's production rollout or for recorder
failures. Callers must use the explicit scope and completeness fields together.

## Metric definitions

- Message, creation, reschedule, and cancellation totals count their respective
  stored events once.
- `netBookingActivity` is creations minus cancellations. It is activity, not
  the current number of active appointments.
- `bookingMessageRatio` is booking-created events divided by received-message
  events. It is not a conversion rate, and the events are not customer-linked.
- Platform rows are limited to Telegram, WhatsApp, Messenger, and Instagram.
  Unknown values do not become trusted platform rows.
- Service rows use the immutable event-time `service_name_snapshot`. Null and
  empty snapshots are counted as unattributed. Named rows default to 20 and are
  capped at 100.
- Daily buckets use `occurred_at`, UTC dates, and zero-fill dates intersecting
  the requested window.

The layer does not report customers, conversations, response performance,
revenue, retention, no-shows, staff time, funnels, or true conversion.

## Scale boundary

Application-side aggregation is appropriate while reads remain tenant-scoped,
time-bounded, capped, and internal. A separately approved database aggregation
design should be considered if truncation becomes frequent, tenants routinely
request long ranges, latency or concurrent dashboard load grows, or exports are
introduced. Phase I adds no view, RPC, materialized view, aggregate table,
warehouse pipeline, repair, or backfill.
