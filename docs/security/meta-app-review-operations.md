# Meta App Review and compliance operations

This code supports two distinct Meta apps/secrets: Facebook Login for Business
(`META_APP_SECRET`) for Messenger and Instagram Login (`INSTAGRAM_APP_SECRET`).
Configure each app's callbacks against the same public origin used by
`PUBLIC_BASE_URL`, `APP_URL`, or `RENDER_EXTERNAL_URL` (in that precedence).

| Meta setting | Callback |
| --- | --- |
| Facebook Login for Business deauthorization | `/api/meta/messenger/deauthorize` |
| Facebook Login for Business data deletion | `/api/meta/messenger/data-deletion` |
| Instagram Login deauthorization, if offered | `/api/meta/instagram/deauthorize` |
| Instagram Login data deletion, if offered | `/api/meta/instagram/data-deletion` |

Meta sends a form-encoded `signed_request`. The callback verifies HMAC-SHA256
with the corresponding app secret and stores an idempotent request in
`meta_compliance_requests`. A data deletion callback returns a `url` and
`confirmation_code`; the URL is `/api/meta/data-deletion/status/:code` and
shows `pending_review` until an operator has actually fulfilled the request.
The code is a secret bearer reference; only its SHA-256 hash is stored.

## Required manual deletion workflow

The signed request identifies a Meta app user, not necessarily an OdinLink
customer or business. Do **not** delete a whole business, its bookings, or
unrelated customer records based only on that identifier. An authorized
operator must review pending rows, correlate `matched_connection_ids` and
tenant-scoped records, assess legal retention requirements, and carry out the
specific deletion or anonymization. For unmatched IDs, seek additional
verified identity information before acting. Only then set the request to
`completed` and `completed_at = now()` with backend service-role access.
Never mark a request completed merely to clear the queue. Monitor pending
requests and respond within the applicable Meta and legal deadlines.

For deauthorization, new Messenger connections store the app-scoped Facebook
authorizer ID. A signed callback deactivates only matching connections that
predate the event. Existing Messenger connections made before that mapping
was stored cannot safely be auto-matched; review those pending rows and ask
the business to reconnect if needed. Instagram deauthorization matches its
Instagram account ID. If Meta supplies a different identifier, it remains
pending for manual review rather than crossing tenant boundaries.

Before publication: apply the migration in staging, verify the callback URLs
against the correct app secrets, make a signed test request for each app,
verify the status URL, and confirm the pending-request review owner and
response process. Do not put a placeholder URL into Meta's dashboard.
