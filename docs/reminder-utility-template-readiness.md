# Appointment reminder Utility-template readiness

Local extension of `98313d4` on `hotfix/reminder-delivery-safety`, audited 2026-10-04.
No commit, push, merge, deployment, Render change, or migration application.

## Capability audit before implementation

| Channel | Repository capability at checkpoint | Gap and resulting behavior |
| --- | --- | --- |
| WhatsApp | Tenant `whatsapp_access_token`, `whatsapp_phone_number_id`, `whatsapp_business_account_id`; self-service connection credentials, WABA/phone validation and `whatsapp_business_management`/`whatsapp_business_messaging` scopes. Ordinary Cloud API text sender. | No template names/languages/parameter mappings, approved-template state, template sender or tenant reminder-template contract. This extension adds the optional contract and verified template sender below. No live tenant assets or approval state were inspected. |
| Messenger | Tenant Page/token, generic stored granted scopes; OAuth requests `pages_show_list`, `pages_messaging`, `pages_manage_metadata`. Normal `RESPONSE` conversations. | No request/use of `page_utility_messaging`, approved Page Utility assets, reminder mappings, or one-time notification token storage. No authoritative current automated standard-reminder wire enum is available locally. Reminder remains fail-closed, including inside the window. |
| Instagram | Tenant account/token, ordinary message sender, authoritative inbound event time. | No persisted provider-authoritative Click-to-Instagram-Direct ad-entry eligibility or automated extended-window contract. Ordinary-window reminders remain supported; outside-window reminders remain blocked. |
| Telegram | Tenant bot credential and ordinary Bot API `sendMessage`. | No defect found; sender and reminder behavior unchanged. |

Repository scope: business normalization/loading, channel connection contracts,
OAuth scope lists, provider registration/validation, inbound webhook handlers,
reminder scheduling/delivery, schema migrations, and existing tests. No production
database or customer messaging endpoints were contacted for this audit.

## Provider evidence and limits

Meta's current [WhatsApp Business Messaging Policy, section 2](https://whatsappbusiness.com/policy/)
requires approved templates outside the 24-hour customer service window and permits
ordinary replies inside it. Recipient opt-in and opt-out obligations still apply
under section 1; template approval does not establish recipient consent.

Meta's [Utility product description](https://whatsappbusiness.com/products/conversation-categories/utility/)
includes time-sensitive information related to an existing transaction. Appointment
reminders are implemented only when Meta itself returns category `UTILITY` for the
configured asset; a local category/approval assertion cannot authorize sending.

The [official Meta Postman workspace](https://www.postman.com/meta/whatsapp-business-platform/overview)
identifies its collections as official. Its current examples establish:

- [Template send](https://www.postman.com/meta/whatsapp-business-platform/request/lwtlz1k/send-message-template-interactive): `POST /{phone-number-id}/messages`, `type: "template"`, configured name/language/body text parameters; acceptance message ID prefixed `wamid`.
- [Template lookup by name](https://www.postman.com/meta/whatsapp-business-platform/request/7whkjje/get-template-by-name-default-fields): `GET /{WABA-ID}/message_templates?name=...`, returning ID, name, language, status, category, components.
- [WABA phone ownership](https://www.postman.com/meta/whatsapp-business-platform/request/e9ady51/get-phone-numbers): `GET /{WABA-ID}/phone_numbers`, returning WABA-owned phone IDs.

Direct Meta developer pages for Messenger Utility/current send types and Instagram
returned access/rate-limit errors during this revision. No new unsupported wire
value, tag, or extended eligibility was inferred. The checkpoint's conservative
Messenger/Instagram decisions are preserved. Messenger's missing Page approval,
permission, recipient/geographic eligibility and wire contract must be verified
before a separate integration can enable reminders. HUMAN_AGENT is not used.

## Minimal tenant configuration foundation

The unapplied migration adds nullable `businesses.whatsapp_reminder_templates jsonb`
with `ADD COLUMN IF NOT EXISTS`. No table, policy, default asset, approval flag or
historical data rewrite is added. Existing business ownership/access controls
continue to apply. The provider-time migration and its test are unchanged.

Configuration is provisioned by a trusted operator on the exact tenant's business
row after Meta approves its template. No dashboard/UI, auto-template creation,
environment default or global asset fallback is introduced. Example contract
(placeholders must be replaced with actual tenant assets, never copied blindly):

```json
[
  {
    "business_id": "<CURRENT_BUSINESS_ID_AS_STRING>",
    "waba_id": "<CURRENT_TENANT_WABA_ID>",
    "phone_number_id": "<CURRENT_TENANT_PHONE_NUMBER_ID>",
    "reminder_type": "24h",
    "booking_language": "en",
    "template_id": "<ACTUAL_APPROVED_TEMPLATE_ID>",
    "name": "<ACTUAL_APPROVED_TEMPLATE_NAME>",
    "language_code": "<ACTUAL_APPROVED_LANGUAGE_CODE>",
    "body_parameters": ["customer_name", "service", "date", "time", "business_name"]
  }
]
```

Provide a separate mapping for `2h` and each supported stored appointment language.
The same approved asset can be explicitly mapped to both reminder types if its
wording is valid for both. Use absolute date/time placeholders rather than static
“tomorrow” or “today” in a shared asset. Only one mapping per reminder type/language
is accepted. Names and language codes are selected solely from this configuration.

Only positional text-body parameters are supported, in the approved body's exact
`{{1}}`, `{{2}}`, ... order. Service, date and time must be mapped. Customer/business
name are supported when the approved template requires them; required empty values
fail closed. Optional static text header/footer are supported. Dynamic headers,
buttons, media and named parameters are rejected rather than guessed.

## Exact send behavior and isolation

1. Strict Calendar verification runs unchanged before delivery.
2. The existing exact tenant/channel/canonical-or-generated-scoped customer history
   lookup, inbound sender filter, provider-event-time precedence and bounded legacy
   cutover remain unchanged. No analytics/shadow backfill is introduced.
3. Inside the verified WhatsApp window, existing ordinary text delivery is preserved.
4. Outside it, hydrate only the current tenant's channel credentials. Require exact
   business/WABA/phone configuration binding and a unique explicit language mapping.
5. Using only those credentials, verify the phone belongs to that WABA and retrieve
   the configured template from that WABA. Require exact ID/name/language,
   `APPROVED`, `UTILITY`, and supported components/placeholder shape on every attempt.
   No approval cache or provider paging URL is trusted. An asset absent from the
   returned page fails closed; no template is substituted.
6. Send the deterministic template only to the original WhatsApp booking recipient.
   Require HTTP success, no provider error, and the same valid `wamid.*` check as
   proactive text. Rejection/verification failures leave reminder flags false.
7. The existing flag write still requires exact appointment/business and exactly one
   updated row. Accepted delivery and flag-write failure remain separately reported.

Tenant row normalization explicitly clears inherited/global template configuration
when its row has none. A copied mapping from another business, WABA or phone cannot
authorize this business's send. Disconnected/missing canonical credentials retain
their existing guard. No reminder changes channel, including on rejection.

Structured reasons retain `whatsapp_template_required` for missing/misconfigured,
language-unavailable, fact-missing, verification/account mismatch, unapproved,
non-Utility and unsupported template-shape cases. Actual rejected sends return
`provider_rejected`. Logs contain only existing safe reminder identifiers and
categories; neither credentials nor customer/template bodies are logged.

## Language, eligibility and external setup

Templates require the appointment's supported stored language (`sv`, `en`, `de`,
`es`, `fa`, `ar`) plus a matching configured and provider-approved language code.
Missing/unsupported appointment language or unavailable variant fails closed; there
is no template language fallback. Date/time use the existing reminder locales,
Gregorian calendar and business timezone. Service localization remains the existing
deterministic function; no LLM changes names, service, date, time or business facts.

Existing ordinary reminder formatting/booking persistence still defaults missing
language to Swedish. That legacy behavior is unchanged; older already-defaulted
rows do not record language provenance. This revision neither guesses nor backfills
customer language. Operators must configure the actual needed approved variants.

Actual readiness requires later migration application, approved Utility templates
in the tenant WABA, exact operator mappings, valid tenant management/messaging
permissions, recipient consent, and provider/account availability. These steps have
not been performed; passing mocked tests does not prove production delivery.

Instagram remains limited to the verified ordinary inbound-message window; the
conservative equality boundary expires at exactly 24 hours. This is not a complete
model of all Instagram eligibility. Any future extension needs provider-authoritative
ad-entry event/customer/account correlation and the applicable verified entitlement
and time range. Local persistence time, vague ad/session heuristics or tags cannot
prove that state. Normal conversational senders are unchanged for every channel.

WhatsApp delivered/failed webhook reconciliation still requires provider message ID
association with appointment/reminder and tenant-scoped status handling. This
revision implements strongest existing synchronous acceptance only.

## Validation

- Added 62 deterministic policy scenarios: both template reminder types and exact
  payload/facts, approval/ownership/language/shape failures, invalid acceptance IDs,
  expiry during hydration, optional name/static components, flag write failures,
  normalization isolation and same-channel behavior. Existing boundary tests remain.
- Focused reminder suite: **7 passed, 0 failed/skipped**, including **481 policy scenarios**.
- Related channel/booking suites: **23 passed, 10 failed**, identical failure names
  and totals on an isolated untouched archive of HEAD `98313d4`. Failures: one
  superseded-turn language isolation assertion, eight RTL catalog line-count cases,
  and one existing Meta compliance source assertion. No unrelated fixes made.
- Provider-time migration suite invoked unchanged with PostgreSQL executables
  intentionally excluded: **1 skipped**, honoring the prohibition on applying
  migrations. No SQL migration ran; the new migration is likewise unapplied.
- Isolated TypeScript check of the new template module: **PASS**.
- `npm run build`: **PASS**, existing bundle-size warning.
- `git diff --check`: **PASS**.

The full focused/related logs and HEAD comparison are recorded under
`/tmp/odinlink-template-*.log` on this workstation.
