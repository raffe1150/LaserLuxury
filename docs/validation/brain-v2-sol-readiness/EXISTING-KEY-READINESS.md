# Existing experimental credential readiness

**GO for offline rehearsal. HOLD for authenticated execution.** Baseline `a1189e2c644a9c7b589c3d79d7192fe9adde20f9`, branch `release/owner-answer-approvals-20261112`, clean tracked tree at entry. The existing key may be reused if exclusive access can be demonstrated. This review neither requires a third key nor modifies the existing key or its files.

The credential directory and its two files are owned by the current user, with modes 0700 and 0600 respectively. The existing loader verified the key against the stored fingerprint and the local configuration names `proj_FyeEDfyaHLfKjmWj4hZHoU2z`. This proves agreement with local metadata. It does not prove current remote association, expiry, model access, inference permissions or separation from every installed key. The runner never reads a credential from the production route or environment and never prints, passes to a mock, or transmits a key.

The current user can still run `knowledge-aen-single-provider.ts`, which reads the experimental key file directly. Other legacy scripts, including `shared-core-real-provider.ts` and `knowledge-four-case-provider-gate.ts`, accept a key file path and can write outside the shared lock. File permissions protect against other users but not processes running as this user. The shared lock protects cooperating writers only. To retain this key, enforce exclusive custody at an OS-separated execution boundary or broker that also owns both ledger paths and the budget lock. Prevent legacy identities from accessing or spending with the credential for the duration of the run. If a usable copy already exists outside that boundary, exclusion cannot be proven by moving the key file. Resolve access and reconcile exposure before issuing the run approval. No credential or writer configuration was changed.

## Implementation

- `scripts/sol-semantic-live.ts` adds a separate, read-only live admission entry point and a mock-only count flow. It checks a maximum 15-minute approval window, manifest hash, source hashes, canonical ledger paths and pins, model, credential fingerprint, declared project, call counts and ceilings. The real entry point always stops after local validation because exclusive custody is unproven. There is no installed live transport or authenticated eligibility/count call.
- `scripts/sol-semantic-runner.ts` exposes its existing pins and source validation and accepts an abort-aware asynchronous simulation meter. Simulation still requires temporary ledgers, synthetic credentials and `OFFLINE_SIMULATION`. Its reservation, receipt validation and settlement path is reused.
- `scripts/sol-semantic-runner.test.ts` tests live admission, mocked count-to-wire binding over all 18 turns, rejected count evidence, and restart after interruption, in addition to the existing writer and reservation controls.
- This is the only new report. The manifest, accounting implementation, historical ledgers and production code were preserved.

The mock counts the generation request's model-visible projection, including instructions, current input and redacted prior state, reasoning and JSON format. The response must be successful, match the project, have the documented object type and report a positive integer. The existing runner rejects counts over 16,000 and checks the local SHA-256 of the identical generation string before reserving $0.056. Response usage checks include the 1,600 output-token ceiling including reasoning. After an inference reservation the authorization ID is durably present and cannot be reused, even after interruption. The mock approval shape validates fields and binding. It is not independent proof of owner authorization. Before any authenticated call a real broker must verify the owner's authorization and atomically consume the run ID even if the first count fails before any inference reservation. The mock-only path makes no external call in that case.

## Ledger verification

| Item | Verified value |
| --- | --- |
| Manifest | `e3892a0fd2095e5944a99e12a157d04aec03c7562416137b6a3e77642d63f92d` |
| Canonical primary ledger | `b5a63a1a86c17871af6fd7755c2314453617f85163da9b2a23b8521397328215` |
| Immutable 426-row prefix | `4b003b96827f2cdcbb0c5a6839165d6bcf164def9c0ae28d4b96ffb51f08049a` |
| Resumed ledger | `2b74c1cb2127f3cacf550e9f9b33892b066de94e0430c8bf6a804b8621e0e070` |
| Reserve including the $0.00000780 probe | $2.76992243 |
| Remaining under $4.00 | $1.23007757 |
| Maximum inference exposure | 18 × $0.056 = $1.008 |
| Remaining after full run reserve | $0.22207757 |

The other primary path resolves to the same canonical file and is counted once. The ledgers were read only. Approved maximum exposure remains $0.15 for a request and $4.00 cumulative. At standard rates the narrower inference reservation covers 16,000 input tokens at up to $2.50 per million for the configured 30-minute cache rate and 1,600 output tokens at $10 per million.

## First authenticated request

Obtain separate, expiring and single-use approval after establishing exclusive custody. Pin the manifest, source and ledger hashes, exact canonical paths and historical prefix, verified experimental fingerprint and project, model, endpoints, wire settings and spending limits. The public [Sol model card](https://developers.openai.com/api/docs/models/gpt-6.1-sol) confirms Responses support. Project eligibility remains unverified. Authorize at most one optional metadata request for model visibility and separately establish the restricted key's Responses write permission. Visibility alone does not prove billing readiness. If the permission or project status is uncertain, stop before inference.

Explicitly authorize up to 18 authenticated `POST /v1/responses/input_tokens` calls at **$0** as documented by [OpenAI token accounting](https://help.openai.com/en/articles/4936856-understanding-and-counting-tokens), plus up to 18 authenticated `POST /v1/responses` inference requests reserved at **$1.008 total**. There are zero retries and fallbacks. Use the same intended project for counting and inference. Verify that the official endpoint covers equivalent framing for the exact model-visible request, including JSON object mode, and capture authenticated count provenance tied to its generation digest. If the format or count cannot be verified, stop before inference. For each valid turn, reserve before dispatch and keep the whole hold on any uncertain send, identity or billing result. No paid eligibility probe or other generation call is proposed.

## Validation

The twelve focused tests include 18 ordered mocked count calls and 18 reserved simulated calls, prior and later request hash checks, unknown receipts, timeout and late completion, credential and project mismatch, lock contention and replacement, companion-ledger drift, missing and invalid counts, 16,000 and 16,001 boundaries, budget rejection and interruption with a retained hold on disk. TypeScript was compared with the established 12-diagnostic baseline. No authenticated calls, paid inference, historical writes, booking actions, production changes or customer messages occurred.
