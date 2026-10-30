# Render backend and guarded Telegram polling

Render is OdinLink's intended hosting target. `render.yaml` builds with `npm ci && npm run build` and starts `node dist/server.cjs` through `npm start`. This describes repository configuration; it does not prove which revision, settings or credentials are currently deployed.

Telegram uses the existing backend **long-polling** path. Database-owned business/bot binding, `getMe`, a durable fenced poller lease and persisted update disposition protect reception. Native messages use the shared language/Knowledge/booking brain; responses use the existing guarded Telegram transport. Removing the retired Netlify function changes none of these sources.

There is no active `/api/telegram-webhook` receiver in this backend. `/api/setup-telegram` is an authenticated, tenant-authorized setup route which starts polling; it is not an inbound webhook. Its legacy success-message wording does not establish a registered webhook. Do not point a Telegram webhook at a guessed Render endpoint.

Controlled trial mode remains default OFF. A dedicated owner-operated trial process requires an explicit enrolled business, exact owned channel/sender/recipient identities, a one-use approved question/source snapshot, durable model-specific financial admission and the paired Sol profile. Sol is not activated by this document. Trial startup refuses an existing or unverifiable Telegram webhook and never deletes it. Normal trial-OFF behavior, including booking and Calendar integration, is unchanged.

The old Netlify handler, deployment instructions and Netlify-only package dependencies have been retired from this repository. **That does not disable any existing remote deployment or clear the bot's webhook.** Telegram live testing remains BLOCKED until an owner verifies remote deactivation/separation and an empty webhook for the owned bot. No live commands were executed in this cleanup.

Use the [controlled release handoff](docs/validation/shared-core-2026-10-22/netlify-retirement-controlled-gate-20261029/HANDOFF.md) for the exact outstanding approvals, Netlify/Telegram owner steps, database prerequisites, manual Git/Render sequence and finite four-channel tests. Old validation captures and historical `telegram-webhook` platform labels remain evidence/backward compatibility, not an alternative live integration.
