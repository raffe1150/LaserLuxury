# Canonical availability test bridge

The test bridge is a disabled-by-default interface for black-box availability
checks and scoped test-execution provenance. It is registered only under
`/api/test-bridge/v1`. Availability operations remain read-only. Execution
operations write only durable test metadata; they never mutate bookings,
pending holds, calendars, or customer records.

Enable it only in an isolated local or test environment:

```env
ODINLINK_TEST_BRIDGE_ENABLED=true
ODINLINK_TEST_BRIDGE_TOKEN="a-dedicated-random-server-secret-of-at-least-32-bytes"
# Optional; defaults to 30 minutes and is clamped to 1 minute–24 hours.
ODINLINK_TEST_EXECUTION_TTL_MS=1800000
```

When disabled, every bridge route returns `404` without capability or route
details. When enabled, every request requires
`Authorization: Bearer <ODINLINK_TEST_BRIDGE_TOKEN>`. Missing or incorrect
credentials return `401`. A missing or unsafe (shorter than 32 bytes) configured
secret fails closed with `503`. The secret is compared using constant-time
digest comparison and is never returned or logged.

## Capabilities

`GET /api/test-bridge/v1/capabilities`

Returns the schema version, supported operations, authentication requirement,
mutation safety flags, and durable execution-provenance capability. When
enabled, `operations` contains `availability.verify`,
`availability.earliest.verify`, `availability.pending-blockers.inspect`,
`test-execution.create`, and `test-execution.inspect`. Cleanup is deliberately
not advertised or implemented.

The legacy top-level `readOnly: true` guarantee applies to production/customer
artifacts. `executionProvenance.testMetadataWrites: true` explicitly discloses
that create/expiry operations write isolated test metadata to durable storage.

## Create and inspect a test execution

`POST /api/test-bridge/v1/executions`

```json
{
  "businessId": "business-id",
  "channel": "telegram",
  "userId": "test-user-id"
}
```

The server creates a cryptographically random, opaque execution ID. The raw ID
is returned once in the creation response; durable storage contains only its
SHA-256 hash. The record is scoped to the canonical business, normalized
channel, and normalized owner, and expires after the configured TTL. Caller-
supplied execution IDs and unknown body fields are rejected.

Inspect it with the same scope:

`GET /api/test-bridge/v1/executions/<executionId>?businessId=business-id&channel=telegram&userId=test-user-id`

Inspection returns a sanitized execution fingerprint, scope, timestamps, and
status, but never the raw execution ID or raw owner ID. An unknown ID returns
`404`, a scope mismatch returns `403`, and an expired record returns `410`.
The execution ID is a lookup capability only: bridge Bearer authentication is
still mandatory. Execution metadata uses the existing durable server store and
survives process restart; creation fails closed with `503` if that store is not
available. No cleanup endpoint exists in this foundation.

## Verify availability

`POST /api/test-bridge/v1/verify`

```json
{
  "operation": "availability.verify",
  "businessId": "business-id",
  "date": "2026-08-14",
  "time": "14:15",
  "durationMinutes": 60,
  "service": "Optional service name",
  "channel": "telegram",
  "userId": "test-user-id"
}
```

`channel` must resolve to `telegram`, `whatsapp`, `instagram`, or `messenger`. The response contains only normalized request/result fields, calendar and pending-hold counts, and read-only safety flags. It never returns raw event bodies or provider credentials.

A successful provider read returns HTTP `200` with `status: "verified"` and the category from the canonical exact-slot validator. A provider/configuration failure returns HTTP `503` with `status: "inconclusive"`; it is never represented as an available slot.

## Verify earliest availability across a range

Use `availability.earliest.verify` to run the production canonical candidate
generator and exact-slot validator across a complete date range. The bridge
forces the existing chronological `selectFirstAvailable` ranking and returns
only the first validated candidate.

```json
{
  "operation": "availability.earliest.verify",
  "businessId": "business-id",
  "startDate": "2026-08-15",
  "endDate": "2026-08-21",
  "durationMinutes": 60,
  "channel": "telegram",
  "userId": "test-user-id",
  "service": "Optional service name",
  "constraints": {
    "minTime": "09:00",
    "maxTime": "17:00",
    "excludedTimes": ["11:15"]
  }
}
```

`service` and `constraints` are optional. No diagnostic-only service name is
invented when `service` is omitted. The exact constraint allowlist is:

- `minTime`: inclusive `HH:mm` lower bound
- `maxTime`: inclusive `HH:mm` upper bound
- `afterTime`: exclusive `HH:mm` lower boundary
- `beforeTime`: exclusive `HH:mm` upper boundary
- `daypart`: `morning`, `afternoon`, or `evening`
- `excludedTimes`: at most 200 `HH:mm` values

`afterTime` and `beforeTime` cannot be combined because the existing canonical
slot options expose one strict time boundary. Daypart and min/max bounds are
intersected. Unknown keys, malformed values, contradictory bounds, reversed
ranges, and ranges longer than 366 days return HTTP `400` with
`status: "invalid_request"`.

Available response:

```json
{
  "schemaVersion": "odinlink-test-bridge-v1",
  "operation": "availability.earliest.verify",
  "status": "verified",
  "timestamp": "2026-08-14T12:00:00.000Z",
  "businessId": "business-id",
  "requested": {
    "startDate": "2026-08-15",
    "endDate": "2026-08-21",
    "durationMinutes": 60,
    "timezone": "Europe/Stockholm"
  },
  "result": {
    "available": true,
    "earliestSlot": { "date": "2026-08-17", "time": "09:00" },
    "category": "available"
  },
  "evidence": {
    "calendarReadSucceeded": true,
    "calendarEventCount": 2,
    "pendingHoldCount": 1,
    "source": "canonical-availability"
  },
  "safety": {
    "readOnly": true,
    "calendarModified": false,
    "bookingModified": false,
    "pendingModified": false
  }
}
```

When the complete range has no validated candidate, `status` remains
`"verified"`, `available` is `false`, `earliestSlot` is `null`, and `category`
is `"none_available"`. A provider read failure instead returns HTTP `503`,
`status: "inconclusive"`, and `category: "calendar_read_failure"`. Responses do
not include the raw channel user ID, pending identity, calendar events, provider
payloads, customer data, or credentials.

## Inspect pending availability blockers

Use the same endpoint with `operation` set to
`availability.pending-blockers.inspect` and omit `service`:

```json
{
  "operation": "availability.pending-blockers.inspect",
  "businessId": "business-id",
  "date": "2026-08-21",
  "time": "14:15",
  "durationMinutes": 60,
  "channel": "telegram",
  "userId": "test-user-id"
}
```

The response schema is:

```json
{
  "schemaVersion": "odinlink-test-bridge-v1",
  "operation": "availability.pending-blockers.inspect",
  "status": "inspected",
  "businessId": "business-id",
  "requested": {
    "date": "2026-08-21",
    "time": "14:15",
    "durationMinutes": 60,
    "timezone": "Europe/Stockholm",
    "normalizedStart": "2026-08-21T14:15:00+02:00",
    "normalizedEnd": "2026-08-21T13:15:00.000Z"
  },
  "counts": {
    "totalPendingRecordsInspected": 3,
    "sameBusinessPendingCount": 2,
    "activeBlockingPendingCount": 1,
    "overlappingBlockerCount": 1
  },
  "pendingRecords": [
    {
      "sessionFingerprint": "12-hex-chars",
      "businessId": "business-id",
      "platform": "telegram",
      "status": "awaiting_confirmation",
      "operation": "new_booking",
      "startTime": "2026-08-21T14:15:00+02:00",
      "selectedEndTime": "2026-08-21T15:15:00+02:00",
      "durationMinutes": 60,
      "createdAt": 1787300000000,
      "updatedAt": 1787300300000,
      "ageMs": 600000,
      "inactivityMs": 300000,
      "configuredTtlMs": 2700000,
      "expired": false,
      "blockingStatus": true,
      "overlapsRequestedInterval": true,
      "belongsToRequestingOwner": false,
      "activeBlockingPending": true,
      "canonicalOverlappingBlocker": true,
      "source": "in-memory"
    }
  ],
  "overlappingBlockers": [
    {
      "sessionFingerprint": "12-hex-chars",
      "businessId": "business-id",
      "platform": "telegram",
      "status": "awaiting_confirmation",
      "operation": "new_booking",
      "startTime": "2026-08-21T14:15:00+02:00",
      "selectedEndTime": "2026-08-21T15:15:00+02:00",
      "durationMinutes": 60,
      "createdAt": 1787300000000,
      "updatedAt": 1787300300000,
      "ageMs": 600000,
      "inactivityMs": 300000,
      "configuredTtlMs": 2700000,
      "expired": false,
      "blockingStatus": true,
      "overlapsRequestedInterval": true,
      "belongsToRequestingOwner": false,
      "activeBlockingPending": true,
      "canonicalOverlappingBlocker": true,
      "source": "in-memory"
    }
  ],
  "safety": {
    "readOnly": true,
    "calendarModified": false,
    "bookingModified": false,
    "pendingModified": false
  }
}
```

`pendingRecords` contains sanitized records for the requested business only.
`overlappingBlockers` is the subset that the canonical in-memory pending-hold
predicate treats as active blockers for the requested interval. Other businesses
contribute only to `totalPendingRecordsInspected`; their metadata is not returned.
Timestamps and ages are milliseconds. A missing timestamp or selected end is
returned as `null`.

The registry being inspected is in memory. Restored records are not currently
tagged with their origin, so `source` truthfully describes their current source as
`in-memory` and does not claim whether they were originally restored.
