# Multilingual service extraction fix and architecture audit

Baseline: `bfb5344ad2e4165e19ec577bbab1c0068bea09ee`. Work is isolated in the attached `multilingual-service-extraction` worktree. No commit, push, deployment, migration, or production-data change was made. Tests use offline calendar/provider/database doubles.

## A. Exact root cause and baseline reproduction

The exact input was reproduced through the shared production engine's test boundary with `platformName: telegram`, the configured `Video Consultation` service, and a fixed clock of `2026-10-07T10:00:00Z` in `Europe/Stockholm`.

Input:

> Jag vill boka en videokonsultation imorgon runt kl. 13:00.

Baseline candidate:

> videokonsultation imorgon runt

Baseline reply:

> Jag kan inte matcha “videokonsultation imorgon runt” mot en bokningsbar tjänst. Den tjänsten erbjuds inte. Tillgängliga tjänster är: Video Consultation. Vilka av dem vill du välja för bokningen?

The date was already `{ kind: relative_date, value: 2026-10-08, relative: tomorrow }`; the normalized time was already `{ kind: exact, startMinutes: 780 }`.

The precise path is `handleUnifiedBookingEngineTurn` → `understandBookingTurn` → `normalizeBookingRequest`, plus the shared `resolveAuthoritativeBookingService` gate in `server.ts`. The Swedish service regex in `extractConcreteRequestedService` captures up to five letter-only words after `boka en`, with a lazy capture ending before `kl. <clock>` or sentence punctuation. Its date lookahead handles preposition + weekday/numeric date, while its Swedish cleanup handles `till/på/för` + date-only tails. Neither handles bare `imorgon runt`. Consequently, the capture expands to `videokonsultation imorgon runt` and stops at `kl.`.

There is a second failure: the literal catalog matcher has no compound/translation equivalence for `videokonsultation`. `inferService` requires standalone consultation words. `inferServiceFromText` also misses this compound in the whole sentence: its word-boundary consultation regex fails and its compact fuzzy regex is anchored at the beginning of the entire sentence. No configured candidate survives, and the unsupported-service gate returns before general response generation can correct it.

**All four channels are affected by this shared path:** Instagram, Messenger, WhatsApp, and Telegram. The new regression runs the same shared engine boundary for all four; no channel adapter patch was added.

## B. Shared fix and narrow architecture improvement

- Strip a complete recognized temporal suffix only from the service-extraction view of the turn. Date/time normalization still receives the original text. Relative dates, clock relations, dayparts, weekdays and named/numeric dates are covered in sv/en/de/es/fa/ar.
- Preserve complete literal catalog names before temporal cleanup, require every word in a removed suffix to belong to the temporal grammar, and protect service concepts containing temporal-looking words such as Arabic `استشارة عن بعد`.
- Preserve multiword service candidates, increasing the legacy capture ceiling from five to twelve words. Tests include six-word labels and names containing `Morning`, `Morgon`, and `Morgen`.
- Add bounded video/online/virtual consultation concepts across the six languages, compact/concatenated labels, selected inflections, and conservative whole-label typo tolerance. Arbitrary configured services can use tenant-owned aliases and the same bounded spelling comparison.
- Resolve against the current tenant's eligible catalog only. Explicit foreign-owner rows are rejected, inactive/nonbookable services are excluded, and different IDs sharing a label remain ambiguous rather than choosing the first record. No global service pool or cross-tenant fuzzy lookup exists.
- Prefer an exact label/alias; otherwise auto-resolve only one high-confidence match. Multiple equally plausible matches ask for clarification. Unknown wording does not create a service. Shared generic/token similarity is no longer enough to auto-select a qualified service.

Confidence tiers are deterministic evidence scores, not statistically calibrated probabilities: exact 1.00, compact 0.98, recognized concept 0.94, bounded typo 0.90; automatic matching requires at least 0.90 and a unique result. Multiple matches are evaluated before restricting clarification display to five items.

### Existing LLM involvement and deterministic overrides

Before this change, the structured OpenAI/Gemini provider could output `serviceText`, decoded to `entities.service.value.statedValue`. However, `ControlledUnderstandingCandidates` and `resolveControlledUnderstandingAdoption` adopted intent, relative date, owned time, confirmation, name and phone only. Service intent was discarded. `understandBookingTurn` itself always called the deterministic normalizer, and the service gate could return an unavailable-service reply before general LLM generation.

The narrow improvement consumes the already available structured service phrase when controlled adoption is enabled. The phrase must have confidence ≥0.8, have no reported service ambiguity, and match a complete verbatim span in the current customer turn. It can fill a missing literal extraction or remove a bounded polite filler; it cannot erase meaningful service qualifiers or inject a configured label absent from the message. The same deterministic tenant catalog resolver then supplies the configured name and ID. The provider never supplies booking authority or an ID.

The provider instruction now asks for service wording without date/time or request fillers. Provider/schema shape, feature flags, credentials, and deployment configuration are unchanged. `STRUCTURED_UNDERSTANDING_ADOPTION_ENABLED` still controls adoption and defaults to false in the example configuration. Live production flag state was not inspected or changed. The exact Swedish fix works without an LLM.

## C. Files changed

| File | Change |
| --- | --- |
| `server.ts` | Shared extraction, authoritative confidence matching, scoped eligibility, current-turn semantic hint, test boundary. |
| `src/ai/service-intent.ts` | New pure temporal/concept/spelling/evidence helpers. |
| `src/ai/understanding/providers/shared.ts` | Service-phrase extraction instruction. |
| `src/ai/multilingual-service-intent.integration.test.ts` | New multilingual/channel/ambiguity/tenant/semantic regressions. |
| `src/ai/swedish-generic-booking-service-date.integration.test.ts` | Update an old assertion that explicitly expected temporal contamination. |
| `docs/multilingual-service-extraction-fix.md` | This audit and validation report. |

`src/ai/booking-intelligence.ts` is unchanged. No channel-specific production files changed.

## D. Tests added

The new integration file passes **141 regression cases**, including:

- Exact Swedish candidate `videokonsultation`, configured `Video Consultation` ID, tomorrow, normalized exact 13:00, and availability progression.
- Six native booking sentences × four channels, with unchanged date/time semantics and calendar access only after service resolution.
- `video konsultation`, `videokonsultasion`, selected Swedish inflections, `video consult`, `online consultation`, German/Spanish/Persian/Arabic equivalents and misspellings, and mixed-language variants.
- Temporal boundaries across today/tomorrow, at/around, before/after, dayparts, weekdays and calendar dates in all six languages.
- Multiword and temporal-looking service labels; Arabic remote consultation remains intact.
- Multiple services with the same concept, duplicate labels with different IDs, alias collisions, and catalogs larger than the clarification display cap.
- Tenant changes, catalog order changes, foreign-owner rows, inactive/nonbookable rows, and unsupported video wording in a skin-only tenant.
- High/low-confidence semantic extraction, missing verbatim evidence, invented labels, short-token/contact collisions, and safe removal of polite fillers.

## E. Validation results

Final run: **60 test files; 53 passed; 7 failed**. All seven failures also reproduce on unchanged `bfb5344`; the failure list is below. The requested booking-intelligence/service-resolution, multilingual service/date/time, availability-broadening, booking-progression, selected-slot/contact, reminder and WhatsApp safety groups were executed. Each file's final exit status is listed at the end of this report.

`npm run build`: passed (existing bundle-size warnings). `git diff --check`: passed. New pure service-intent module type check: passed. Repository `tsc --noEmit`: blocked by the same six syntax diagnostics in unchanged `patch_key_rotation.ts` on baseline and patch. A separate server-focused type check produces the same 16 pre-existing diagnostics as baseline after ignoring shifted line numbers; no new diagnostics were introduced.

Existing failing suites:

- `src/ai/german-initial-booking-intent.test.ts` — Existing intent expectation: `new_booking` vs `clarification`.
- `src/ai/german-multifact-booking.integration.test.ts` — Existing contact extraction expectation: missing `Alex Testsson`.
- `src/ai/multilingual-compound-location.integration.test.ts` — Existing business-information routing assertions (20 failing subtests).
- `src/ai/persian-instagram-post-booking-continuation.integration.test.ts` — Existing phone-continuation expectation: missing `0700007628`.
- `src/ai/rtl-service-catalog-channels.integration.test.ts` — Existing catalog length expectation: 5 displayed vs 10 expected (8 failing subtests).
- `src/ai/spanish-booking-boundaries.integration.test.ts` — Existing slot/contact progression expectation for `Sí, reserva las 09:15.`.
- `src/ai/whatsapp-swedish-tomorrow-regression.integration.test.ts` — Existing awaiting-contact tomorrow-date expectation: missing `2026-08-31`.

No failing baseline suite was edited to conceal its failure. The Swedish generic-service assertion that expected `tid hårbehandling i morgon` was updated to the corrected temporal-free `tid hårbehandling`; its remaining assertions pass. An initial exploratory change to time parsing was removed after testing showed it altered existing approximate-time behavior.

## F. Remaining ambiguity and architectural limits

This is a bounded semantic improvement, not universal intent understanding. Unlisted paraphrases/translations, heavy misspellings, or arbitrary abbreviations such as `VC` need a tenant alias or a later separately scoped semantic-concept proposal design. The LLM extracts grounded wording; it does not guess arbitrary catalog concepts. Spelling tolerance is disabled for labels shorter than six characters, limited to one edit for shorter names and two for names at least twelve characters long. Service capture is bounded to twelve words, and semantic phrases to 160 characters. Unknown temporal idioms or clauses containing additional non-temporal prose can still require clarification.

Multiple genuine service equivalents remain a clarification case. Literal configured labels and exact aliases take precedence over weaker semantic synonyms. The system does not change labels or durations to resolve ambiguity.

**Strict configured-ID-only booking is not universal in the baseline:** older name-only catalog entries have no ID, and the pre-existing explicit-default/no-catalog policy can also carry `id: null`. This patch copies actual IDs where configured, never fabricates them, and tests ID-backed catalogs. Removing legacy label-only/default behavior would require a separate catalog contract change, outside this narrow fix and the no-migration instruction.

Time semantics remain those of `bfb5344`: the exact Swedish input uses an exact 13:00 constraint; the representative English, Spanish, Persian and Arabic booking paths also retain their baseline effective constraints, while German `gegen 13:00` remains approximate. Nearest real available slots may be offered according to existing availability logic. This patch does not introduce a new tolerance window for “around”.

Validation used shared runtime boundaries and offline doubles; live webhook delivery, real provider interpretation quality, and production feature-flag state were not tested.

## G. Recommended live retest

After a separately authorized release, send the exact Swedish input to each of Instagram, Messenger, WhatsApp and Telegram using a tenant with `Video Consultation`. Verify the configured service ID/name, tomorrow in the tenant timezone, 13:00 under existing exact semantics, and normal slot/contact progression. The candidate should be exactly `videokonsultation`; the reply must not claim that service is unavailable.

Repeat with `video konsultation`, `videokonsultasion`, `video consult`, and `online consultation`; send the six native phrases from the new regression. Test a tenant with both Video and Online Consultation: an unqualified translated equivalent must clarify, while an explicit configured label can select that label. Test a tenant without video consultation: it must never receive another tenant's service ID. If semantic adoption is enabled, also retest unfamiliar request syntax and confirm low-confidence/ambiguous extraction does not select a service.

## Final test-file results

| Test file | Result |
| --- | --- |
| `src/ai/arabic-booking-intake.integration.test.ts` | PASS |
| `src/ai/arabic-instagram-booking-routing.integration.test.ts` | PASS |
| `src/ai/availability-broadening.integration.test.ts` | PASS |
| `src/ai/availability-broadening.test.ts` | PASS |
| `src/ai/availability-weekday-refinement.integration.test.ts` | PASS |
| `src/ai/booking-intelligence.test.ts` | PASS |
| `src/ai/booking-progression-reliability.integration.test.ts` | PASS |
| `src/ai/booking-time-constraint.integration.test.ts` | PASS |
| `src/ai/configured-service-duration-linkage.test.ts` | PASS |
| `src/ai/configured-service-duration-parity.integration.test.ts` | PASS |
| `src/ai/confirmation-contact.integration.test.ts` | PASS |
| `src/ai/contact-phone-provenance.integration.test.ts` | PASS |
| `src/ai/contact-submission-selected-slot.integration.test.ts` | PASS |
| `src/ai/german-initial-booking-intent.test.ts` | FAIL — also fails on baseline |
| `src/ai/german-multifact-booking.integration.test.ts` | FAIL — also fails on baseline |
| `src/ai/multichannel-booking-progression.integration.test.ts` | PASS |
| `src/ai/multilingual-compound-location.integration.test.ts` | FAIL — also fails on baseline |
| `src/ai/multilingual-contact-service-collision.integration.test.ts` | PASS |
| `src/ai/multilingual-date-normalization.integration.test.ts` | PASS |
| `src/ai/multilingual-explicit-date.integration.test.ts` | PASS |
| `src/ai/multilingual-meaningful-language-switch.integration.test.ts` | PASS |
| `src/ai/multilingual-service-intent.integration.test.ts` | PASS |
| `src/ai/multilingual-slot-confirmation.test.ts` | PASS |
| `src/ai/persian-instagram-post-booking-continuation.integration.test.ts` | FAIL — also fails on baseline |
| `src/ai/priority-2-1-multilingual-time.test.ts` | PASS |
| `src/ai/rtl-service-catalog-channels.integration.test.ts` | FAIL — also fails on baseline |
| `src/ai/rtl-service-catalog.test.ts` | PASS |
| `src/ai/selected-slot-completion-availability.integration.test.ts` | PASS |
| `src/ai/selected-slot-confirmation.integration.test.ts` | PASS |
| `src/ai/service-catalog-presentation.integration.test.ts` | PASS |
| `src/ai/service-clarification-presentation.integration.test.ts` | PASS |
| `src/ai/service-resolution-before-availability.integration.test.ts` | PASS |
| `src/ai/spanish-booking-boundaries.integration.test.ts` | FAIL — also fails on baseline |
| `src/ai/sv-de-service-date-normalization.integration.test.ts` | PASS |
| `src/ai/swedish-generic-booking-service-date.integration.test.ts` | PASS |
| `src/ai/telegram-persian-booking-runtime.integration.test.ts` | PASS |
| `src/ai/understanding/adoption.test.ts` | PASS |
| `src/ai/understanding/providers/gemini.test.ts` | PASS |
| `src/ai/understanding/providers/openai.test.ts` | PASS |
| `src/ai/understanding/providers/wire.test.ts` | PASS |
| `src/ai/understanding/shadow.test.ts` | PASS |
| `src/ai/understanding/structured-understanding.test.ts` | PASS |
| `src/ai/unsupported-service-booking.integration.test.ts` | PASS |
| `src/ai/unsupported-service-explicit-date.integration.test.ts` | PASS |
| `src/ai/whatsapp-active-slot-routing.integration.test.ts` | PASS |
| `src/ai/whatsapp-arabic-initial-booking.integration.test.ts` | PASS |
| `src/ai/whatsapp-booking-contact.integration.test.ts` | PASS |
| `src/ai/whatsapp-multilingual-production-regressions.integration.test.ts` | PASS |
| `src/ai/whatsapp-recent-completion-boundary.integration.test.ts` | PASS |
| `src/ai/whatsapp-swedish-tomorrow-regression.integration.test.ts` | FAIL — also fails on baseline |
| `src/channels/whatsapp/reminder-mapping-publisher.integration.test.ts` | PASS |
| `src/channels/whatsapp/reminder-mapping-publisher.test.ts` | PASS |
| `src/p2/structured-understanding-shadow-analyzer.test.ts` | PASS |
| `src/runtime/messenger-reminder-scheduler.integration.test.ts` | PASS |
| `src/runtime/reminder-calendar-verification.integration.test.ts` | PASS |
| `src/runtime/reminder-delivery-policy.integration.test.ts` | PASS |
| `src/runtime/reminder-language.integration.test.ts` | PASS |
| `src/runtime/reminder-provider-time-migration.integration.test.ts` | PASS |
| `src/runtime/whatsapp-canonical-identity.integration.test.ts` | PASS |
| `src/runtime/whatsapp-proactive-delivery-safety.integration.test.ts` | PASS |
