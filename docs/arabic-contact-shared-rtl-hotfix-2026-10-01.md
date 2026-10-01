# Arabic contact completion and shared RTL catalog hotfix

Base: `f9b35f0646eab9752cd358cae973447cdceede4d`.
Scope: local changes in `.production-hotfix` only. No commit, push, deployment,
production messages, Blackbox changes, or main-worktree use.

## Proven name-loop cause

The previous diagnostic boundary accepted only a decimal run identifier or an
ellipsis after `AIBB`. The actual live identifier `7a928ba6` is hexadecimal and
contains letters. Consequently, the boundary did not remove the marker, channel
tag, or unrelated sentence. This was not an end-of-string-only cleanup bug: the
old regex already removed all subsequent text when its numeric identifier matched.

The real unified booking engine reproduced the failure with the exact reported
input before the fix. The selected slot and verified WhatsApp phone remained, but
`customerName` was null and the state remained `awaiting_contact`. The Arabic
prefix parser was reached; its whole-field Unicode validation rejected the
Arabic name together with the unremoved Latin marker/identifier/channel. Recursive
first-sentence parsing did not help because that sentence still contained those
tokens. No successfully captured name was subsequently overwritten in this
reproduction. The missing-contact gate correctly asked for the still-missing name.

Earlier tests used decimal identifiers and abbreviated markers, which did match
the cleanup. They did not exercise this hexadecimal runtime input. In addition,
the old standalone-name fallback accepted Latin names only, so a bare Arabic or
Persian name could fail even without a diagnostic marker.

The tests exposed a related state hazard: unrelated Arabic text after the marker
containing “today” could reach temporal normalization and change the selected
date before contact submission. Cleaning only the extracted name would leave
this hazard. The contact turn now uses the human portion before the diagnostic
boundary for booking interpretation too.

## Contact path before and after

Before:

1. Inbound channel message → conversation-language handling → restored pending
   booking and state-first booking dispatch → serialized unified booking engine.
2. Full message → booking understanding/normalization → combined-contact parser
   or `extractPendingBookingCustomerName` → `extractNameOnly` → Arabic prefix
   parser and diagnostic cleanup.
3. Hex marker survived cleanup → mixed-script field failed validation → both
   entry contact resolution and the later awaiting-contact resolution had no name.
4. `getMissingBookingContact` → save pending state → repeat localized name prompt.

After:

1. Same channel, language, pending-state and dispatch path.
2. After pending restoration, only in `awaiting_contact`/`failed_recoverable`, a
   recognized `AIBB` opaque identifier ends the human contact turn. Its suffix
   cannot donate dates, services, names, or numbers to booking interpretation.
   Real contact details or date corrections before the boundary still follow the
   existing behavior.
3. Shared cleanup recognizes hexadecimal, digit-bearing opaque/UUID tokens,
   localized decimal identifiers and existing ellipsis placeholders. No concrete
   customer name, run ID, channel tag or quoted stress word is hard-coded.
4. Existing Arabic explicit-name validation receives just the human field. A
   short bare Arabic-script name is accepted only by the contact-collection
   fallback and reuses that Unicode validation. Greetings, empty field labels,
   digits and conversational booking tokens remain rejected.
5. Existing `resolveAuthoritativeContact`, pending state and selected-slot
   ownership checks remain in force. The complete contact passes the missing-field
   gate and the existing transaction creates/verifies calendar and booking records,
   sends its notification, and emits the normal final confirmation. Replay creates
   no second booking.

Persian uses the shared diagnostic boundary and contact fallback, so it shares
these risks. Native Persian names now pass the same tested path. This does not
claim new support for every Unicode script or redesign name validation.

`server.ts` changes are limited to one import, the Arabic-script standalone
fallback, and contact-stage cleanup before booking interpretation. This file had
to change because it owns both the actual standalone fallback and the pre-parser
booking state path; a helper-only fix could not protect the selected slot from
the unrelated suffix. Phone extraction, phone precedence, transactions,
availability, service matching and channel adapters are unchanged.

## Shared RTL catalog cause and representation

The old row placed a Latin service name, RTL duration and Latin currency on one
line, separated by neutral dashes and invisible directional isolation. Raw string
tests could confirm logical order but could not establish visual ordering in a
client. The reported screenshots show that representation was insufficient.

The shared formatter now emits separate labeled fields, with labels and values
on their own lines and a blank line between services:

```text
• Video Consultation
المدة:
60 دقيقة
السعر:
300 SEK
```

```text
• Video Consultation
مدت:
60 دقیقه
قیمت:
300 SEK
```

No invisible directional controls are needed. Each value occupies its own line,
so duration and price cannot visually run together, and a label cannot appear
between the price and currency. RTL clients may display the currency before its
number; both remain the sole price value beneath the price label. Service names,
duration values, prices and currency are copied from the existing configured
catalog. Missing fields remain omitted. EN/SV/DE/ES rows are byte-for-byte unchanged.
Recommendation summaries reuse this formatter and keep the same service selection
and continuation behavior.

Catalog normalization recognizes adjacent configured multiline fields belonging
to a service row so repeated catalogs are removed once. Matching text beneath an
unknown factual heading, qualified facts, negation and separately grounded
location facts must remain intact; regression coverage checks these protections.

An offline Chromium preview was visually inspected in both RTL and LTR
containers, without bidi CSS overrides or directional controls. A three-line
label-plus-value draft still put the price label between number and currency in
an LTR container; the final five-line block resolved that ambiguity. This is a
local browser check, not proof of actual WhatsApp/Messenger client rendering.
Temporary previews and isolated browser profiles were removed.

## Cross-channel runtime audit

Catalog generation and localization are shared in
`src/ai/business-information.ts`, including the canonical catalog and
recommendation summary. Shared business-support grounding/catalog normalization
uses this representation. Each text conversation handler applies the shared
customer-facing guard, grounding guard, repetition/promotion/identity handling
and final concision before channel delivery; unified deterministic business-info
responses also use the shared catalog/grounding path.

Delivery:

| Channel | Shared final text → transport |
| --- | --- |
| WhatsApp | `sendCustomerMessage` → `sendWhatsAppMessage` → `prepareWhatsAppOutboundText` → `prepareMetaOutboundText`/customer-facing guard → JSON `text.body` |
| Messenger | `sendCustomerMessage` → `sendMessengerMessage` → `prepareMessengerOutboundText` → same Meta/customer-facing guard → JSON `message.text` |
| Instagram | `sendCustomerMessage` → `sendInstagramMessage` → `prepareInstagramOutboundText` → same Meta/customer-facing guard → JSON `message.text` |
| Telegram | conversation `sendTelegramPreferredReply` → `sendCustomerMessage("telegram")` → JSON `text`, without `parse_mode` |

Meta's guard can reject unsafe or wrong-language replies but does not independently
reformat these business facts. Eight production-send-path tests (AR/FA × all four
channels), with mocked fetch, prove the final grounded catalog and address survive
guarding, concision and adapter JSON serialization byte-for-byte. There are no
adapter changes or duplicated channel localization rules.

## Files and deterministic coverage

Production:

- `server.ts`
- `src/ai/arabic-customer-name.ts`
- `src/ai/business-information.ts`

Tests:

- `src/ai/contact-submission-selected-slot.integration.test.ts`: actual language
  preparation, WhatsApp state-first dispatch, engine contact resolution, selected
  slot, calendar/record/notification/final confirmation and replay. Covers bare
  Arabic, `اسمي`, marker-only/channel/stress variants, exact reported input,
  different names/opaque IDs/UUIDs, Persian, Latin and six-language phone
  preservation. Invalid attempts retain the slot; a later valid attempt completes
  exactly once. Truly empty inbound messages retain pending state and are ignored,
  preserving existing behavior. Also covers missing-phone collection in the other
  three channels and intentional phone/date corrections before the boundary.
- `src/ai/arabic-booking-intake.integration.test.ts`: native Arabic booking intake
  through confirmation and contact completion, expanded from 16 to 20 journeys
  across the four text channels, including the live structural pattern.
- `src/ai/customer-name-diagnostic-suffix.test.ts`: opaque-ID cleanup, native
  standalone names only during contact collection, invalid fields and greetings.
- `src/ai/rtl-service-catalog.test.ts`: exact five-line AR/FA blocks, missing fields,
  recommendation reuse, catalog deduplication/idempotence, unknown factual headings,
  qualified facts and unchanged four-language LTR rows.
- `src/ai/rtl-service-catalog-channels.integration.test.ts` (new): eight actual
  text-delivery-path tests with no real API calls.
- `src/ai/business-verification-unavailable.integration.test.ts`: old provider
  row fixtures now explicitly represent the legacy format; verified service-only
  responses receive the same new shared formatter.

This document is the tenth changed file. Existing multilingual location tests
are run without modification. No location retrieval/grounding recovery logic,
model/provider/timeout configuration, sender-phone logic, availability or
Blackbox code is changed.

## Validation and limitations

- Before-fix engine reproduction: the reported hexadecimal input failed with a
  null name and retained pending contact state, matching the live loop.
- Final focused suite: **196/196 passed**.
- First wider audit: **502/506 passed**. Its four failures reproduced using the
  baseline HEAD server source: one obsolete superseded-turn assertion in
  `multichannel-language-isolation.integration.test.ts`; one obsolete source
  assertion in `meta-compliance.test.ts`; and two HTTP callback tests rejected by
  the mandatory offline network guard. No production/network calls were enabled
  to make these tests pass.
- Broader safe suite (39 files): first final-format run **499/500 passed**, with
  one intermittent, unchanged credential-envelope tamper test. The test replaces
  the last base64url character with `x`; a local reproduction proved different
  encoded text can decode to identical ciphertext, so the assertion sometimes
  makes no cryptographic alteration. Its isolated rerun passed **12/12**. Both the
  credential implementation and test are identical to HEAD and were not modified.
- Final broader rerun of the same 39-file suite: **500/500 passed**.
- `npm run build`: passed; existing large-bundle warning remains.
- Changed AI modules: targeted TypeScript check passed. Server/transitive-source
  diagnostic comparison: **16 baseline, 16 current, zero new diagnostics**.
- Repository-wide `npm run lint` (`tsc --noEmit`) remains blocked by the unchanged
  `patch_key_rotation.ts` syntax errors at lines 47/94/99. Its bytes match HEAD.
- `git diff --check`: passed, including whitespace checks for the two new files.

All runtime suites used the offline network guard and mocked external adapters.
Six-language known/unknown-location, safe verification failure, catalog
deduplication, recommendation clarification, booking continuity/completion,
authoritative sender-phone, explicit-phone, service-collision, provider and text
adapter regressions are included. Unsupported location facts remain withheld;
no address is introduced by this patch.

## Recommended validation after a separately authorized deployment

1. Complete an Arabic WhatsApp booking through a selected and confirmed slot.
   Send the reported structural name/opaque-marker/channel/stress sentence at the
   name prompt. Expect the human name only, verified sender phone, unchanged
   service/date/start/end, one normal confirmation and one calendar/booking/
   notification operation. Replay must not create a second booking. Also check a
   plain Arabic name and a failed-then-valid name attempt.
2. Request Arabic services and services plus location. Inspect the actual
   WhatsApp screenshot: one catalog, separate duration and price fields, exact
   values/SEK, and independently grounded Aurora Street 742.
3. Repeat for Persian. Inspect native-language labels and the actual display.
4. Repeat the AR/FA catalog requests in Telegram as the additional text channel,
   comparing rendered fields and exact transmitted content with WhatsApp.
5. Keep EN/SV/DE/ES and six-language grounded-location controls. Do not change
   OdinLink to satisfy known unrelated Blackbox evaluator mistakes.
