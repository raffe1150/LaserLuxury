# OpenAI temperature compatibility hotfix — 2026-09-30

## Root cause and exact call path

The entailment caller explicitly requests `temperature: 0`. The OpenAI adapter
previously copied every defined temperature into `client.responses.create`,
regardless of the resolved model. The production model rejected this parameter
with HTTP 400. `assessBusinessClaimEntailment` catches the error and returns null;
the strict grounding gate consequently cannot mark the claim entailed. This is
a transport compatibility failure, not evidence that the cited address is false.

The path is:

1. `server.ts:9272`, `guardBusinessSupportGrounding`, validates extraction coverage
   and cited evidence, then invokes the claim entailment decision at line 9562.
2. `server.ts:8867`, `assessmentClaimsAreEntailed`, invokes
   `assessBusinessClaimEntailment` at line 8886 for each claim.
3. `server.ts:8760`, `assessBusinessClaimEntailment`, requests the strict verifier
   through `generateContentWithFallback`. **Line 8785 sets `temperature: 0`**;
   line 8784 supplies the existing internal `gemini-2.5-flash` model name.
4. `server.ts:713`, `generateContentWithFallback`, copies temperature into the
   unified request at line 738. `runAiProviderRequest` and `runWithAiQueue` invoke
   `generateWithConfiguredProvider` at line 764 for OpenAI.
5. `src/ai/providers/router.ts:81`, `generateWithConfiguredProvider`, selects the
   OpenAI adapter; `normalizeGenerationRequestForProvider` at line 55 removes the
   internal Gemini model name while retaining temperature and other fields.
6. `src/ai/providers/openai.ts:112`, `generateWithOpenAi`, resolves the model at
   line 126. Before this fix its parameter spread included every defined
   temperature (old lines 124–125). The new compatibility condition is line 133;
   `client.responses.create` is now line 139.

## Compatibility rule

Only the OpenAI generation boundary changes. Defined caller temperature is
included for documented non-reasoning Responses models: `gpt-4.1`,
`gpt-4.1-mini`, `gpt-4.1-nano`, `gpt-4o`, `gpt-4o-mini`, and their explicitly
listed supported snapshots (4.1 family 2025-04-14; 4o 2024-08-06;
4o-mini 2024-07-18). Other models and unverified snapshots omit the property.

The current runtime does not set `reasoning.effort`; newer models' conditional
support with effort `none` is not assumed. No reasoning setting, model selection,
retry policy, tool conversion, schema, input, instructions, response parsing,
Gemini behavior, or verifier logic changes. Internal callers retain temperature.

Official references: [OpenAI reasoning/sampling compatibility guidance](https://developers.openai.com/api/docs/guides/latest-model),
[documented Responses temperature examples](https://developers.openai.com/cookbook/examples/partners/model_selection_guide/model_selection_guide),
and [supported non-reasoning models and sampling parameters](https://developers.openai.com/api/docs/guides/graders).

## Model discrepancy

Read-only inspection of the Render Environment page for OdinLink
(`srv-d8mvqhernols73d4skhg`) showed **`OPENAI_MODEL=gpt-5.6-luna`**, not
`gpt-6-luna`. The deployed commit displayed was
`e74e85ec84acc8458c4f0ec5979cf32f8e27918b`. The observed setting matches the
reported runtime failure log. No environment value was edited.

This verifier does not explicitly request `gpt-5.6-luna`: it passes the internal
Gemini name, which the router removes. `resolveOpenAiTextModel` then uses
`process.env.OPENAI_MODEL` (line 79). A non-Gemini explicit caller model takes
precedence; the existing `gpt-5.6-luna` fallback applies only when the environment
value is absent/empty. Neither normalization nor fallback replaces a configured
`gpt-6-luna`. Tests prove that this same route sends 6-luna when its test process
environment is set to 6-luna. The production configuration currently contains
5.6-luna; configuration change history was not inspected.

## Tests and verification

Added 27 tests in `src/ai/providers/openai-temperature.integration.test.ts`:

- Six unsupported/unverified models, with and without tools: omitted temperature,
  exact remaining payload, successful single SDK call, unchanged caller request,
  preserved normalized text/function-call response (12 tests).
- Ten documented supported aliases/snapshots preserve temperature (10 tests).
- Absent caller temperature stays absent (1); explicit/environment/default model
  precedence stays unchanged (1); Gemini normalization and temperature stay
  unchanged (1).
- Actual German tenant-3 grounding extraction and entailment paths run through
  a mocked SDK transport, with no extraction/entailment test seam replacement.
  ENTAILED preserves the full catalog and location; CONTRADICTED still rejects
  the address. Both issue temperature-free verifier requests, emit no provider
  failures, and assert the grounding entailment diagnostic (2 tests).

Tenant-3 data and exact Knowledge text come from the existing verified production
snapshot `tests/fixtures/business-information-tenant3.json`. The test derives the
address from that fixture; no runtime address is invented or hardcoded. SDK
responses are mocked: this proves successful execution and enforcement through
the transport boundary, not a live post-deployment model judgment.

Before the fix, the new suite had 15 failures and 12 passes. After: **27/27 pass**.
The existing diagnostic success test's expected payload now omits temperature
for 6-luna while keeping its other exact-payload and diagnostic assertions.

Combined OpenAI provider, provider integration, grounding/entailment, compound
business-info, knowledge, presentation-integrity, and WhatsApp regressions:
**267 passed / 1 failed / 268 total**. The single failure is the existing
`whatsapp-swedish-tomorrow-regression.integration.test.ts:117` awaiting_contact
case: expected `2026-08-31`, actual undefined. Rebundling with the untouched HEAD
OpenAI adapter reproduced that exact failure. Legacy Gemini-mocked suites use
the test-process Gemini selection; new tests explicitly select OpenAI. The
existing offline network harness prevents external requests.

Targeted provider TypeScript: **pass**. Server-inclusive new integration test:
**16 existing diagnostics, zero introduced**, compared using a compiler host
that substitutes the untouched HEAD adapter. `npm run build`: **pass**, with
the existing bundle-size warning. `git diff --check`: **pass**.

## Changed files and scope

- `src/ai/providers/openai.ts`: conservative supported-model set and one request
  field condition; 10 additions / 1 deletion.
- `src/ai/providers/openai-diagnostic.test.ts`: update unsupported-model payload
  expectation and test title; 2 additions / 2 deletions.
- `src/ai/providers/openai-temperature.integration.test.ts`: 162 new lines.
- This report.

All work stayed in `.production-hotfix`. The dirty main worktree, grounding and
entailment logic, compound information logic, semantic routing, booking/contact
logic, tool-schema normalization, named diagnostic blocks, and
`patch_key_rotation.ts` were not modified. Nothing was committed, pushed, or
deployed. Render settings, models, and AI_PROVIDER configuration were unchanged.
