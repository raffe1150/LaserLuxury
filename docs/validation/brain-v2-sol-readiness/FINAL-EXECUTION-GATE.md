# Sol multilingual validation execution gate

**HOLD for live execution.** The baseline was `9e62f1d7bb72582776ad47a140b92e80aa79f464` with a clean tracked tree. Existing untracked files include legacy scripts, their fixtures, outputs and the dependency symlink. The semantic runner's dependency closure does not use the historical scripts or fixture outputs. Those scripts still matter for operational exclusion because some can spend using the same credential.

| Blocker | Status | Required evidence before inference |
| --- | --- | --- |
| Full input count | Official method verified in documentation. No authenticated count obtained. The runner accepts synthetic counts only in rehearsal. | A successful provider count covering the exact generation input and framing, bound to the immutable generation wire. |
| Credential exclusion | The shared lock excludes compatible writers. The rehearsal now rejects non-simulation credentials even with matching metadata. | Revoke or disable legacy experimental credentials that could spend against the same accounting scope. Make an experiment credential available only inside a dedicated, OS-isolated runner or broker that alone can reserve against both canonical ledgers. Establish that other accessible keys and writers cannot bypass that boundary. |
| Sol eligibility | The local credential passed file owner, mode, fingerprint and configured-project checks for `proj_FyeEDfyaHLfKjmWj4hZHoU2z`. The public Sol model card lists Responses support. Current project and key access remain unverified. | Confirm Responses write permission and Sol enablement for the intended project and restricted key. A separately approved `GET /v1/models/gpt-6.1-sol` with the same key and project can verify model visibility if model-read permission is granted. Visibility does not prove Responses write access or billing readiness. |

## Count and bind the future requests

1. Preserve the current 18-turn manifest and four semantic source pins. Build each generation wire after processing the preceding turn's actual interpretation. There is one immutable UTF-8 string per turn. It contains the Sol model, instruction, current turn, redacted prior goal context, JSON output format, reasoning and billing parameters. It includes no tools, previous response ID, or remote conversation.
2. Use the same experimental project and model to call `POST https://api.openai.com/v1/responses/input_tokens`. Send the same model-visible fields, including `instructions`, `input`, and `text.format` if required by the count contract. The current generation format is JSON object mode. Confirm that the counting endpoint supports that format or that the provider contract establishes equivalent framing. If it cannot count a component or cover the same effective input, stop. Never drop a schema or format from the counting request merely to make it succeed.
3. In the trusted dispatcher, correlate the response with its own authenticated counting call. Require a successful response with object `response.input_tokens` and a positive safe-integer count at or below 16,000. Store the count with the generation SHA-256, counting-request SHA-256, model, project and turn. Any change to generation bytes invalidates the count. Do not accept caller-supplied counts or raw response-shaped JSON as proof.
4. Under the same exclusive boundary, recheck approval, ledger hashes, lock, count and exact wire. Durably reserve $0.056 before sending those same bytes once. Stop on authentication, permissions, rate-limit, transport, count, billing or identity uncertainty. Preserve any existing hold if a generation attempt might have been sent. Do not retry, truncate or fall back.

OpenAI documents [Responses input counting](https://developers.openai.com/api/docs/guides/token-counting) as including message framing. Its [token accounting help article](https://help-lb.openai.com/en/articles/4936856-understanding-and-counting-tokens) states that the endpoint is free and does not consume normal inference quota. The published counting cost is **$0**. This is still an authenticated call. A later approval must explicitly cover up to 18 count calls plus 18 inference calls, and separately cover any optional model metadata lookup. Dynamic follow-up context means 18 counts cannot be precomputed before the experiment. No authenticated calls were made for this review.

The [Sol model card](https://developers.openai.com/api/docs/models/gpt-6.1-sol) documents the model and endpoint. The [model visibility guidance](https://developers.openai.com/api/docs/guides/rate-limits) and [project permission guide](https://developers.openai.com/api/docs/guides/rbac) explain why visibility and permission to generate must be assessed separately.

## Ledger and scope

| Pin or budget | Current local value |
| --- | --- |
| Manifest SHA-256 | `e3892a0fd2095e5944a99e12a157d04aec03c7562416137b6a3e77642d63f92d` |
| Primary SHA-256 | `b5a63a1a86c17871af6fd7755c2314453617f85163da9b2a23b8521397328215` |
| Historical 426-row prefix SHA-256 | `4b003b96827f2cdcbb0c5a6839165d6bcf164def9c0ae28d4b96ffb51f08049a` |
| Resumed ledger SHA-256 | `2b74c1cb2127f3cacf550e9f9b33892b066de94e0430c8bf6a804b8621e0e070` |
| Conservative reserve including documented probe | $2.76992243 |
| Headroom under $4.00 | $1.23007757 |
| Planned inference exposure | $0.056 × 18 = $1.008 |
| Post-reservation headroom | $0.22207757 |

The two primary paths still resolve to the same file. All 18 manifest row digests match. Distribution is Swedish 3, English 3, German 2, Spanish 4, Persian 3, Arabic 3. No ledger, prior report or manifest byte changed. The $0.056 calculation remains 16,000 input tokens at the $2.50 worst-case 30-minute cache-write rate per million plus 1,600 output tokens at $10 per million, including reasoning. Reconfirm rates and wire settings before authorization. The absolute request cap remains $0.15 and the cumulative cap remains $4.00.

The canonical lock applies to the shared writer only. `shared-core-real-provider.ts` writes directly, `knowledge-four-case-provider-gate.ts` uses a separate per-output lock, and `knowledge-aen-single-provider.ts` reads the experimental key directly. Moving or checking the existing same-user key file would not invalidate another process's copy. No unrelated runner, key or project setting was modified.

## Validation and changes

All eight focused tests passed with the offline network preload. They include all 18 sequential turns and exact per-turn request hashes, missing or invalid counts, hash and model mismatches, 16,000 and 16,001 boundaries, lock contention and bypass detection through ledger drift, duplicate-run rejection, timeout and late completion, invalid usage and project identity, historical prefix integrity, and full hold retention. The new test also rejects a matching non-simulation credential before creating a lock. TypeScript matched the baseline of 12 diagnostics across 10 files.

Changed only `scripts/sol-semantic-runner.ts`, `scripts/sol-semantic-runner.test.ts`, and this new report. There is no live transport, count client, or eligibility probe in this change.

Once the blockers are resolved, obtain one expiring, single-use approval binding the manifest and source pins, canonical ledger hashes and prefix, isolated experimental credential fingerprint and project, model and transport, exact count and inference call caps, $1.008 run maximum, $0.15 absolute request maximum and $4.00 cumulative maximum. Recheck every pin under the exclusive boundary before execution. Until then the approved action is offline rehearsal only.
