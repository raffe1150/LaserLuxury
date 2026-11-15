# First Sol inference readiness

**GO for the offline HTTP transport. HOLD for paid inference.** The baseline was `373b0e2a8c0e836b64a086221df0917f21ef14db` on `release/owner-answer-approvals-20261112`, with a clean tracked tree. No authenticated calls were made.

The one-shot transport serializes no new generation data and accepts only the pinned Swedish `sv:1` body. It sends one POST to `https://api.openai.com/v1/responses` with the experimental project header, disables redirects, and propagates cancellation. Its only executable caller in this change is the existing temporary-ledger rehearsal with a synthetic key and an injected mock. The live entry point remains deliberately closed. Missing or mismatched response project identity is rejected, and the request project is never used as a substitute. The existing receipt decoder verifies model, settings, output length, usage and semantic output before settlement. The 18-turn lane and its simulation protections are unchanged.

## Evidence and accounting

The owner reported HTTP 200 for the Sol metadata and official count calls, and 387 input tokens for the corrected generation request. The code records this as `OWNER_REPORTED`. The reported generation hash matches the independently reconstructed local wire. There is no authenticated counting receipt or exact submitted count payload in this change. The response and exact count request, including the separate JSON developer message and JSON-object formatting, must be reviewed with trustworthy provenance and tied to the same model, project and generation hash. Model visibility and count success do not establish Responses write permission or billing readiness. The previous count approval is consumed.

| Pin or amount | Local verification |
| --- | --- |
| Exact generation wire | `d4ba9ed34d15df92a0ee61bd2b4196ad29cf64aeee9eb198b5c2bde4f510b16c` |
| Manifest | `e3892a0fd2095e5944a99e12a157d04aec03c7562416137b6a3e77642d63f92d` |
| Canonical ledger pin set | `581eba77ac7631f14abf4ebab9980aff572a9047b08f3a48acdebd977ac3c0de` |
| Primary ledger | `b5a63a1a86c17871af6fd7755c2314453617f85163da9b2a23b8521397328215` |
| Historical 426-row prefix | `4b003b96827f2cdcbb0c5a6839165d6bcf164def9c0ae28d4b96ffb51f08049a` |
| Resumed ledger | `2b74c1cb2127f3cacf550e9f9b33892b066de94e0430c8bf6a804b8621e0e070` |
| Conservative reserve | $2.76992243, including the $0.00000780 probe |
| Remaining under $4.00 | $1.23007757 now, $1.17407757 after a full $0.056 canary hold |

Under the approved pricing, if 387 is independently verified as a complete input bound, 387 input tokens at $2.50 per million plus 1,600 output tokens at $10 per million gives $0.01696750. Retain the existing $0.056 hold and $0.15 absolute per-request limit. The ledger aliases resolve to the same primary file. No historical bytes or unknown reserves changed.

## Owner procedure and remaining blockers

The existing local credential passed its fingerprint and configured project check for `proj_FyeEDfyaHLfKjmWj4hZHoU2z`. Legacy scripts running under the same OS user can still access the key and bypass the shared ledger writer. A supervised run on its own cannot guarantee the $4 limit. The smallest remedy is an enforceable exclusive boundary around use of the existing key and authoritative ledgers, with any usable legacy copies excluded. This may reuse the existing key. No third key or account is required by this implementation.

After exclusive custody is proven, review authenticated count provenance and verify Responses write access and standard billing settings through trusted project evidence. Then issue a fresh, trusted, single-use approval for **one inference, zero count calls and zero retries**, expiring within 15 minutes. Pin the credential fingerprint, project, model, request, sources, manifest, ledger paths and hashes, and $0.056/$0.15/$4.00 limits. Under that exclusive boundary, claim the approval durably, reserve the entire $0.056 before sending, and send the identical bytes once. On an interrupted, timed-out or ambiguous request, leave the entire hold and stop. No existing approval opens the live gate in this change.

A genuine reply would measure Swedish semantic interpretation on one fictional turn. The independent labels separate a conditional early-arrival requirement question from a recommendation about what to bring. No Knowledge retrieval, policy answer, channel dispatch, or booking action participates.

## Verification and files

All 17 focused tests passed. The new tests cover one POST, exact wire and project, expiry and changed hash, durable reservation, replay denial, invalid or missing project identity, bad JSON, unknown usage, usage over the reported count, and interruption with the full hold retained. They verify historical row preservation in temporary ledgers. TypeScript matched the prior baseline of 12 errors in 10 files.

Changed `scripts/sol-semantic-live.ts`, `scripts/sol-semantic-runner.test.ts`, and this report. The manifest, accounting implementation, production routing, credential files and historical ledgers were preserved.
