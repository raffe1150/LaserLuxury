# One-request Sol semantic canary

**GO for local offline controls. HOLD for authenticated verification, paid inference and Phase 6.** Baseline `6d05452d7e72c7e5661777dbaeca1fdf9508472f` on `release/owner-answer-approvals-20261112` had a clean tracked tree. The manifest is intact. The canary uses only its first fictional Swedish turn, `sv:1`. Its labels stay local.

## Exact scope

| Pin or limit | Value |
| --- | --- |
| Model and declared project | `gpt-6.1-sol`, `proj_FyeEDfyaHLfKjmWj4hZHoU2z` |
| First generation wire SHA-256 | `5c6f7ebfaa94e556b08d839206ab02552a3c9fdd86f0dc476975b743a2ade6b7` |
| Manifest SHA-256 | `e3892a0fd2095e5944a99e12a157d04aec03c7562416137b6a3e77642d63f92d` |
| Source pin set SHA-256 | `0e5c91965382b412bfefd4b4fd35e29603ef2887fc1c7a4933cb26e6223ede67` |
| Canonical ledger pin set SHA-256 | `581eba77ac7631f14abf4ebab9980aff572a9047b08f3a48acdebd977ac3c0de` |
| Primary ledger SHA-256 | `b5a63a1a86c17871af6fd7755c2314453617f85163da9b2a23b8521397328215` |
| Historical 426-row prefix SHA-256 | `4b003b96827f2cdcbb0c5a6839165d6bcf164def9c0ae28d4b96ffb51f08049a` |
| Resumed ledger SHA-256 | `2b74c1cb2127f3cacf550e9f9b33892b066de94e0430c8bf6a804b8621e0e070` |
| Reserved and remaining | $2.76992243 reserved, $1.23007757 remaining under $4.00, including the separate $0.00000780 probe in the reserve |
| Canary reserve and remaining after full hold | $0.056 and $1.17407757, with the $0.15 absolute per-request ceiling preserved |

The alternate primary path resolves to the same canonical shared-audit ledger. The ledger pins include both canonical paths, both complete hashes, and the historical prefix. The canary does not authorize the remaining 17 turns. No historical file changed.

## Exclusive custody

The credential's owner, file modes and local fingerprint/project pin still validate. The same user can read it through `knowledge-aen-single-provider.ts`. Other legacy scripts accept a key file and can bypass the canonical writer lock. No local process using this same user identity can prevent that user or an already running process with a copy from using it independently. There is no active custody guarantee.

The minimum owner action is to authorize a dedicated OS identity or restricted broker that has exclusive access to the existing experimental credential and both ledger write paths. Verify that legacy identities have no readable or already usable copy and no alternate credential able to spend against the same accounting scope. If a usable copy cannot be ruled out, the current key cannot be safely reused until that copy is invalidated. Any change must be limited to the experimental credential and separately authorized. No third key is assumed. No production credential was inspected or changed. No broker or network transport has been enabled.

## Verification and owner authorization

1. Establish exclusive custody. Through trusted project administration, confirm the key belongs to the intended experimental project, Sol is enabled, and the restricted identity can create Responses. A separately authorized authenticated `GET /v1/models/gpt-6.1-sol` can test visibility under that project. It does not test the create permission. Where administration cannot establish effective permissions, only a corresponding authenticated operation can verify them. Do not add a paid eligibility probe.
2. Issue one owner-controlled authorization with a unique ID, issue time and expiry no more than 15 minutes after issue. Bind the manifest, sources, canonical ledger pins, key fingerprint, project, model, exact wire SHA-256, no retries, one count, one inference, $0.056 run limit, $0.15 absolute per-request and $4.00 cumulative. The local code validates this shape and pins but does not authenticate the issuer. The future exclusive broker must accept the grant only from the owner, not from caller-provided JSON.
3. Under the canonical lock revalidate approval and available budget, durably consume the approval in the existing append-only ledger before sending the count, and make exactly one authenticated `POST /v1/responses/input_tokens`. Send Sol, instructions, input, reasoning and the unchanged JSON-object format. The public [count API schema](https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count) lists JSON-object format. Actual acceptance on this project and count-to-generation framing are untested. [OpenAI documents counting as free](https://help.openai.com/en/articles/4936856-understanding-and-counting-tokens). Reject any failed, mismatched, incomplete, zero or greater-than-16,000 count. Never simplify the payload to obtain a count.
4. If verified, reserve $0.056 durably before a single `POST /v1/responses` for the same generation bytes. Require standard billing settings and 1,600 total output tokens including reasoning. The [Sol model card](https://developers.openai.com/api/docs/models/gpt-6.1-sol) lists Responses and the standard rates. Verify actual response model/project, usage and semantic output before settlement. Leave the full hold on interruption, timeout or uncertain identity or usage. Stop without retry or fallback. Real authenticated verification and inference each require explicit authorization. The optional non-inference metadata lookup must be separately listed.

## Implemented and tested

The existing rehearsal now supports a one-turn mode pinned to the exact wire. It uses temporary files, a synthetic credential and the existing simulation restrictions. A zero-cost append-only claim makes the selected approval single-use before any mocked counting, including when that count fails. A valid count then uses the existing inference reservation and settlement path. Real canary entry validates local pins and stops at `LIVE_CREDENTIAL_EXCLUSION_UNPROVEN`. A caller-supplied isolation flag cannot enable it. Issuer verification, live ledger ownership and authenticated transport depend on the external boundary above.

Four targeted offline tests passed. They cover the first-turn request and count projection, expiry and wire mismatch, replay after a failed count or uncertain inference, project and model mismatch, reserve ordering, zero retries, the existing 18-turn rehearsal and rejection of a non-simulation credential. TypeScript matched the established 12-diagnostic baseline. No authenticated calls were made.

Changed `scripts/sol-semantic-live.ts`, `scripts/sol-semantic-runner.ts`, `scripts/experiment-accounting.ts`, `scripts/sol-semantic-runner.test.ts`, and this report.
