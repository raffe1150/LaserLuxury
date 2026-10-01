# Location reliability, customer names and RTL catalog hotfix

Base: `b841d355685bb34b2749dcaaa32a051fea7cfbc0`.
Work: `/Users/raffe/Documents/OdinLink/.production-hotfix` only.
Changes are uncommitted. No push, deployment, production message, Render setting, Blackbox platform change, or main checkout operation was performed.

## 1. Swedish intermittent suppression: proven path and limits

The supplied notice is the localized verification-unavailable fallback introduced in b841d35. Its runtime condition is either a missing full grounding assessment or an unavailable independent entailment result, with the location topic still uncovered. Full-response verification and claim verification can fail independently. The notice alone does not identify which request failed.

Before: business-info intent → retrieved knowledge and configured evidence snapshot → conversation candidate → full claim/citation extraction → exact citation/coverage checks → independent semantic entailment → compound recovery. Successful verification preserves the location. Failed verification retains the directly trusted configured catalog, but no equivalent configured-address recovery existed; missing location coverage gets a verification-unavailable notice. Retrieved text survives in state but cannot, by itself, authorize a factual reply.

This explains how the manual query can succeed while the later identical query returns the notice: the final outcome depends on completed verification, not just intent/language recognition. There is no evidence establishing the latest run's retrieval content, pre-verification candidate, exact failing stage, latency cause, or provider-internal failure. Do not report the older timeout logs as proof about this newer request.

After: existing success path remains. During compound recovery, only if the customer asked for location, no location has already survived, and verification was unavailable:

1. An explicit nonempty string in the business-owned `address` configuration can be rendered directly, consistently with the configured catalog's direct trust.
2. Otherwise, address-shaped syntax in location-related retrieval is a proposal only. One narrow independent semantic entailment request checks that proposal against the complete current retrieved, factual-prompt, and structured-config sources. It uses the existing provider/model/deadline/reliability mechanism. Only `ENTAILED` plus `OTHER` permits emission. Unknown, neutral, contradicted, inapplicable, malformed, thrown and timeout results retain the safe notice. No lexical rescue or repeated inconclusive adjudication can authorize this new proposal.

The source passages retain all negation, qualifiers and conflicting context. Retrieval chunk numbers/source identifiers are excluded from proposal extraction. No prior-turn or cross-tenant verdict is cached. Diagnostics retain the earlier retrieval/candidate fingerprints and add `[BusinessSupportLocationRecovery]` with the recovery disposition, language, business and verification relation.

This provides a shared recovery opportunity, not a guarantee of an address during a total provider outage when only unverified retrieval is available. The fixture's Aurora Street 742 fact is in Knowledge; the fixture does not supply an `address` field. Production configuration and the newer live candidate/retrieval are not assumed to match that fixture. A retrieval-only address still needs positive verification.

No timeout, model, provider, retry, queue or retrieval configuration was changed. A failed full verifier can now be followed by one additional semantic check; that check retains the existing per-request deadline and can add latency. The full candidate is not regenerated or repeatedly verified by this new path.

## 2. Arabic customer-name completion loop

`extractNameOnly` routes explicit Arabic self-identification into `extractExplicitArabicCustomerName`. That parser captures the complete suffix and requires every name word to satisfy its Arabic-script or Latin-name validation. A valid Arabic name followed inline by `AIBB`, a numeric run identifier and `whatsapp-ar` fails that validation and returns null. Contact resolution retains the sender phone but the required customer name is missing, so awaiting_contact repeats the name request.

Arabic validation already uses Unicode script/letter/mark properties: this particular failure is not rejection of Arabic letters by a Latin-only validator. Existing period-separated regressions did not cover the inline marker: the first-sentence name could be accepted before the diagnostic suffix was examined.

After: a shared name-only cleanup removes a clearly bounded AIBB diagnostic suffix before validating the name. It requires the marker followed by a Unicode numeric identifier or an abbreviated ellipsis placeholder. Ordinary unmarked prose is not trimmed into a name, and a standalone AIBB word is not indiscriminately cut. The Arabic Unicode validation, multiword/diacritic support and conversational-token rejection remain intact.

The same cleanup is applied at `extractNameOnly`, so Persian self-identification can reach its required end/copula boundary after the marker is removed. Persian messages without a copula can otherwise lose that boundary when the inline marker follows the name. Other scripts can have analogous whole-field/boundary issues; this change does not invent new unsupported language parsers.

Awaiting_contact then captures the human name → existing authoritative contact resolver keeps the sender phone → existing selected-slot transaction creates/verifies the calendar event and booking, notifies, and returns final confirmation. Replayed names do not create another booking. Explicit phone extraction, phone precedence, channel adapters, slot/availability logic and booking transaction logic are unchanged.

## 3. RTL duration and price

Previously the catalog used `service (duration unit, price currency)` for every language. Parentheses/comma have neutral bidi direction while Latin service names, Arabic/Persian unit text, numbers and SEK mix directions.

For Arabic and Persian only, canonical rows now separate the service, duration and price with em dashes and wrap each component in Unicode first-strong isolate/pop-directional-isolate controls (U+2068/U+2069). Values, names and currency are unchanged. Missing fields remain missing. Other four languages retain their exact earlier parentheses/comma format.

Before: configured plan → shared LTR-style formatter; a verified service-only provider reply could also retain its original punctuation.
After: configured plan → isolated RTL components. Already grounded Arabic/Persian service-only provider catalogs also pass through the existing catalog normalizer, ensuring the same rendering as compound/fallback catalogs. Normalization remains after grounding and preserves independently verified non-catalog facts. Existing catalog deduplication, unknown headings, qualifiers, negation, attached Arabic conjunctions and recommendation clarification tests pass.

String/control-character regressions prove deterministic rendering contracts; actual WhatsApp visual rendering should be checked in the authorized next live validation.

## 4. Tests added and updated

New tests:

- `src/ai/customer-name-diagnostic-suffix.test.ts`: 21 cases for native Arabic/Persian names, inline localized-digit identifiers, stress sentences, Arabic diacritics/multiword names, Latin-language parity, invalid/empty names and bounded diagnostic stripping.
- `src/ai/rtl-service-catalog.test.ts`: 6 cases for isolated Arabic/Persian names/duration/price/currency, missing values, duplicate normalization and unchanged EN/SV/DE/ES rows.

Expanded tests:

- `business-verification-unavailable.integration.test.ts`: shared six-language independent recovery after full-verifier failure, configured address during total outage, strict rejection of inconclusive/negative outcomes, full qualifier/negation preservation, success → recoverable failure → total outage on the same source, and verified RTL service-only provider rendering. Existing unknown-location/outage tests remain.
- `contact-submission-selected-slot.integration.test.ts`: native Arabic/Persian completion, inline diagnostics/stress suffixes, exact persisted name/phone/slot in calendar/booking/notification, replay protection, and invalid-name state retention followed by exactly one valid completion. Existing channel/no-sender/explicit-phone tests pass.
- `multilingual-compound-location.integration.test.ts`: row assertions account for isolated RTL components; missing-assessment fixture now also simulates an unavailable narrow check.
- `business-grounding-cancellation.integration.test.ts`: SDK cancellation/queue tests still require late extraction to be aborted; independently successful address checks can now recover. Failed extraction is not treated as successful extraction.
- `business-grounding-reuse.integration.test.ts`: the outage fixture fails both the original location wording and the new proposal, proving transport failures cannot authorize a location.
- `business-grounding-timing.integration.test.ts`: the 20-second extraction deadline remains; its narrow recovery returns an unavailable assessment and remains fail-closed.

## 5. Full validation results

Every runtime suite used the offline network guard:
`AI_PROVIDER=gemini node --require ./tests/pre-p2-routing/offline-network.cjs --import tsx --test ...`
Tests explicitly simulating OpenAI override the provider inside their fixtures and replace SDK/HTTP transport. No real network tests or production messages were sent.

- Focused suite, including cancellation/reuse: **161/161 pass**.
- Broad suite across 34 files: **428 tests, 426 pass, 2 fail**.
- Both failures reproduced against HEAD's server source copied temporarily within this worktree, with the temporary copies subsequently removed:
  - `booking-state-machine.test.ts`: pre-existing source assertion expects the removed `const pendingSlotConfirmationAtEntry = isPendingSlotConfirmation(text, pending)` spelling. Behavioral booking regressions pass.
  - `recent-completion-presentation-language.integration.test.ts:162`: pre-existing `en !== sv` assertion.
- Other broad tests pass: business-info/location, inline/deduplicated catalogs, recommendation clarification, grounding/evidence, SDK cancellation/timing/reuse, booking language/state/selected slots/completion, multilingual contact collisions, Arabic intake, multichannel progression, sender/explicit-phone provenance, OpenAI configuration, provider routing, reliability and queue behavior.
- `npm run build`: **pass**; existing large frontend bundle warning remains.
- `npm run lint`: **fails before checking this change** on existing syntax errors in `patch_key_rotation.ts:47,94,99`. File content matches HEAD and was not changed.
- Module TypeScript check for both changed AI modules: **pass**.
- TypeScript compiler diagnostic comparison for changed production modules and server/transitive dependencies: **16 existing diagnostics before, 16 after; 0 new**. Baseline sources were supplied in memory from HEAD.
- `git diff --check`: **pass**.

## 6. Exact files changed

Production:

- `server.ts`
- `src/ai/arabic-customer-name.ts`
- `src/ai/business-information.ts`

Tests:

- `src/ai/business-grounding-cancellation.integration.test.ts`
- `src/ai/business-grounding-reuse.integration.test.ts`
- `src/ai/business-grounding-timing.integration.test.ts`
- `src/ai/business-verification-unavailable.integration.test.ts`
- `src/ai/contact-submission-selected-slot.integration.test.ts`
- `src/ai/multilingual-compound-location.integration.test.ts`
- `src/ai/customer-name-diagnostic-suffix.test.ts` (new)
- `src/ai/rtl-service-catalog.test.ts` (new)

Documentation:

- `docs/multilingual-location-name-rtl-hotfix-2026-10-01.md` (new)

`server.ts` changes are surgical: name-cleanup import/call, location proposal extraction shared with existing verified-address recovery, compound-outage recovery helper/invocation, and application of the existing normalizer to grounded RTL service-only catalogs. These production entry points are in server.ts, so module-only changes would miss them. No broad refactor.

## 7. Scope confirmations and next live validation

Unknown locations cannot be promoted from a candidate or numeric token alone. The configured catalog remains deduplicated. EN/DE/ES regressions pass and LTR rendering is unchanged. Booking/contact/sender-phone precedence and transaction/availability behavior remain intact; only customer-name parsing is intentionally fixed. Blackbox/evaluator, dashboard, analytics, voice, channel adapters and main checkout were untouched. Nothing was committed, pushed, deployed or sent to production. HEAD remains b841d35.

After a separately authorized deployment:

1. Repeat exactly `Hej! Vilka tjänster erbjuder ni och var finns ni?` several times in Swedish WhatsApp, then the EN/DE compound controls. Confirm one catalog and Aurora Street 742. Capture KnowledgeRetrieval, grounding retrieval/candidate fingerprints, verifier timing/entailment and BusinessSupportLocationRecovery disposition for each correlated request. Prove actual retrieval/candidate/config presence rather than inferring it from lengths. The provider-internal cause of the latest live failure remains open.
2. Through an ordinary Arabic booking, submit `اسمي لينا اختبار AIBB 93414557 whatsapp-ar. وبالمناسبة، قال لي أحدهم اليوم "hej".` after the name prompt. Verify one confirmation with name لينا اختبار and the verified sender phone; compare one booking/calendar/notification record. Repeat the equivalent native Persian name control. Replay must not duplicate a booking.
3. Visually inspect Arabic/Persian catalogs in WhatsApp: exact configured service, separate duration and SEK price, no duplicates. Check an unknown-location tenant receives no fabricated address. Keep the known Blackbox classification errors out of product decisions.
