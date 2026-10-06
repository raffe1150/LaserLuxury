# WhatsApp provisioning preflight

The shared read-only adapter accepts a trusted tenant authorization context and
an explicitly selected WABA/phone. It never enumerates alternative accounts to
fill missing templates, writes provider assets, sends messages, or writes storage.
The common readiness/reason interfaces can be reused by future Messenger and
Instagram adapters without sharing WhatsApp-specific rules.

## Readiness model

- `connection_ready`: valid unexpired token, expected issuing app, all three
  effective scopes (`business_management`, `whatsapp_business_management`,
  `whatsapp_business_messaging`), no explicit granular WABA exclusion, exact
  returned identities and phone membership, and no trusted portfolio mismatch.
- `authorization.management_access_sufficient`: connection evidence, discovered
  portfolio, and exactly one `MANAGE` assignment for the introspected token subject
  on the selected WABA. Browser-supplied scope/task claims are never trusted.
- `provisioning_ready`: management access plus known Cloud API/LIVE phone state,
  readable app-subscription inventory, and safe registration prerequisites. A
  disconnected number needs verified ownership and explicitly disabled existing
  PIN state before the existing code may generate a new PIN. A connected number
  is not re-registered. Missing templates or billing blocks do not erase access.
- `reminder_ready`: verified connection and six exact `appointment_reminder`
  variants (`en`, `sv`, `de`, `es`, `fa`, `ar`), each unique, APPROVED, UTILITY,
  explicitly POSITIONAL, with a supported BODY/header/footer shape and five
  sequential unique numbered parameters. Validation uses the same body-contract
  helper as the reminder sender. Preflight requires explicit format because its
  lookup requests that field; existing default-field sender compatibility remains.
- `delivery_ready`: verified connection, CONNECTED/CLOUD_API/LIVE, known overall
  phone and selected-WABA sending health, no reported messaging block or payment
  error, and the intended app's subscription. AVAILABLE and LIMITED health are
  eligible; LIMITED is reported as a warning. SIP calling errors are not messaging
  blocks. This is account-level eligibility, not recipient consent or proof of a
  delivered message. It does not imply templates or tenant mappings are installed.
- `ready`: conjunction of the four readiness states.

Results contain a `checked_at` snapshot, asset identity, effective authorization,
phone and WABA state, safe health error codes, per-language template states, and
stable reasons with severity and scope. Provider error text, credentials, debug
URLs, arbitrary health descriptions, and template examples are not returned or
logged. Errors and incomplete pagination leave evidence unverified. Paging uses
cursors on rebuilt same-account Graph URLs, with ten 100-row pages maximum; paging
URLs are never followed. Requests reject redirects and time out after ten seconds.

## Completion boundary

Embedded completion remains bound to the consumed authorization session, current
OdinLink business and authenticated user. After token exchange, it invokes the
preflight before registration, subscription, or connection persistence. Manual
completion uses the same preflight before subscription/persistence.

If `provisioning_ready` is false, completion returns HTTP 409 with
`whatsapp_setup_needs_attention` and the safe readiness result; no provider write
or connection save is reached. Human-readable reasons use simple setup language.
The browser continues to use the existing simple Connect WhatsApp flow.

Existing registration/subscription code remains behind this gate. Connected phones
and existing app subscriptions skip repeat writes. Successful completion stores
the verified effective scopes rather than the requested-scope constant. The API
returns the **pre-write snapshot**; successful writes do not optimistically turn
readiness on. A future reconciliation read must establish post-write readiness.
Other channel completion paths and reminder delivery behavior are unchanged.

## Stable reason codes

Authorization/asset: `authorization_context_invalid`, `authorization_unverified`,
`authorization_invalid`, `authorization_app_mismatch`, `authorization_scope_missing`,
`authorization_asset_scope_missing`, `asset_identity_unverified`,
`phone_not_in_selected_waba`, `portfolio_identity_unverified`, `portfolio_mismatch`,
`waba_assignment_unverified`, `waba_assignment_missing`,
`waba_management_access_missing`.

Phone/verification: `phone_not_registered`, `phone_platform_unsupported`,
`phone_mode_unverified`, `phone_quality_limited`, `phone_verification_expired`,
`phone_pin_not_enabled`, `phone_registration_verification_required`,
`phone_registration_pin_required`, `phone_display_name_limited`.

Health/subscription: `sending_health_unverified`, `sending_health_blocked`,
`sending_health_limited`, `billing_payment_blocked`, `business_verification_limited`,
`app_subscription_unverified`, `app_subscription_missing`.

Templates: `template_lookup_unverified`, `template_missing_for_selected_waba`,
`template_pending`, `template_rejected`, `template_paused_disabled`,
`template_incompatible`. Compatible approved templates use state
`approved_compatible`; failed inventories use `unverified` rather than `missing`.

## Scope and remaining work

The preflight itself creates no templates and writes no mappings or storage.
The optional automated lifecycle and prepared, unapplied state migration are now
described in [automated template provisioning](whatsapp-automated-template-provisioning.md).
No production health-monitor deployment or mapping installation is performed.
The six test-WABA IDs must not be configured for the live WABA. Business 3 still
needs reminder assets approved in its live WABA and payment remediation. The
production mapping column remains absent according to the prior read-only audit.
Public customer onboarding also needs independently verified app production
access/configuration; the current owner's system-user scopes do not prove this.

All automated validation uses synthetic credentials and mocked provider/database
behavior. No live Meta or Supabase request is needed to validate this revision.
