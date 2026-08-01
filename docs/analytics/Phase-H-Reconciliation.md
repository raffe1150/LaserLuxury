# Phase H: Analytics Reliability and Reconciliation

Phase H is an isolated, read-only diagnostic module. It is not registered at
startup, routed, scheduled, or exported through the analytics recorder API.

## Authority and scope

`public.appointments` remains authoritative for current booking state, while
`public.analytics_events` remains an immutable analytical projection. The
reconciler never inserts, updates, deletes, retries, backfills, or repairs data.

Every run requires one valid `businessId`. Every analytics query includes that
tenant filter. A run also requires an explicit lower time boundary, supplied as
the caller's `from` value or the server-only `ANALYTICS_RECONCILIATION_FROM`
default. There is no earliest-event fallback because an observed first row is
not reliable evidence of analytics activation.

## Supported checks

- Exact `(business_id, idempotency_key)` duplicates within the bounded scan.
- Semantic duplicate booking creation/cancellation events and equivalent
  reschedule events.
- Orphaned booking correlations and critical business-ID mismatches, using only
  primary-key lookups for booking IDs referenced by the tenant's scanned events.
- Latest reschedule time compared with current `appointments.start_time`.
- Contract, timestamp, canonical source/platform, and required-field quality.
- Forbidden metadata keys, probable PII indicators, and unusually large
  metadata, without returning inspected values.
- Safe daily volume aggregates by business, event, platform, and UTC date.

## Deliberate limitations

Missing `booking_created` coverage is deferred. `appointments` does not have the
approved tenant/time index needed for a bounded coverage scan, so Phase H does
not query all appointments in a date range or infer completeness from a broad
scan.

`appointments` has no `updated_at` or `cancelled_at`. Current cancellation state
cannot prove when cancellation happened, so cancellation reconciliation is a
coverage classification only; it does not scan appointment rows looking for
missing cancellation events.

Only the latest `booking_rescheduled` event is compared with current appointment
state. Older events may correctly describe earlier states.

`customer_message_received` has no privacy-safe stable identifier shared with
`chat_history`, so it receives internal event-quality and idempotency checks
only. Reports never include provider IDs, message bodies, customer names, phone
numbers, email addresses, or inspected metadata values.

Volume is returned as aggregate evidence only. Phase H does not infer incidents
from spikes or silence without an external expected-traffic signal.

## Production bounds

Analytics event reads use tenant and time filters, deterministic ordering, and
`maxRows + 1` sentinel detection. The default page size is 500 (hard cap 1,000);
the default event cap is 10,000 (hard cap 50,000). Booking lookups contain only
referenced primary keys, run in chunks of 200, and are capped to each chunk.

Issue samples default to 200 and are capped at 2,000. Counts remain available
when samples are truncated. If the event cap is reached, duplicate coverage is
reported as partial rather than complete.

Use narrow time windows for routine production runs. Privileged reads remain
server-only.
