# Manual Swedish canary without official token counting

**HOLD for the first paid Sol request.** This change adds a one-turn offline rehearsal and a live preflight that rejects an unproven manual input bound. The previously consumed metadata and counting authorization confers no authority for this route. The earlier HTTP 400 is owner-reported. No provider call was made here.

HEAD was `c6195a8e655d09ce66b402fb52bc08218f597aec`, with a clean tracked tree. The original 18-turn manifest is unchanged. Its ordinary count path and the original one-turn official-count path retain their checks. The new approval has zero count calls, one potential inference and zero retries. The anonymous mock uses synthetic credentials and temporary ledgers through the existing simulation boundary.

| Item | Verified value |
| --- | --- |
| Turn | `sv:1`, the first fictional turn, with no prior conversation goals |
| Exact generation body SHA-256 | `5c6f7ebfaa94e556b08d839206ab02552a3c9fdd86f0dc476975b743a2ade6b7` |
| Model, output cap and cache | `gpt-6.1-sol`, 1,600 total output tokens including reasoning, standard service and 30-minute cache |
| Manifest SHA-256 | `e3892a0fd2095e5944a99e12a157d04aec03c7562416137b6a3e77642d63f92d` |
| Source pin set SHA-256 | `0e5c91965382b412bfefd4b4fd35e29603ef2887fc1c7a4933cb26e6223ede67` |
| Primary ledger SHA-256 | `b5a63a1a86c17871af6fd7755c2314453617f85163da9b2a23b8521397328215` |
| Historical 426-row prefix SHA-256 | `4b003b96827f2cdcbb0c5a6839165d6bcf164def9c0ae28d4b96ffb51f08049a` |
| Resumed ledger SHA-256 | `2b74c1cb2127f3cacf550e9f9b33892b066de94e0430c8bf6a804b8621e0e070` |
| Combined reserve including documented probe | $2.76992243 |
| Available before and after the proposed hold | $1.23007757 and $1.17407757 under $4.00 |

The rehearsal fixes the exact wire rather than relying on user-supplied fields or settings. It verifies source hashes and rejects any changed wire, including additions. Under the approved [standard rates](https://developers.openai.com/api/docs/pricing), $0.056 minus the 1,600-token output maximum at $10 per million leaves $0.04. That covers at most 16,000 input tokens at $2.50 per million. The $0.15 absolute per-request cap is unchanged.

The exact wire occupies 2,105 UTF-8 bytes, including 1,537 decoded instruction bytes and 244 decoded message bytes. For byte-segmenting tokenization, each nonempty text token consumes at least one byte. Even counting every serialized byte as text, the envelope would have room for 13,895 additional billed tokens. The figure is conditional on the provider preserving that byte relationship and capping all extra normalization, wrappers, and JSON-object formatting at or below the remaining amount. [OpenAI's accounting documentation](https://help.openai.com/en/articles/4936856-understanding-and-counting-tokens) explains that complete requests include provider framing. It does not establish a maximum for that framing. No trustworthy local Sol contract was available to close the proof. Neither the byte calculation nor a mock framing value is accepted for real admission.

The existing credential matched its local fingerprint and declared project `proj_FyeEDfyaHLfKjmWj4hZHoU2z`. Its actual remote access remains unverified here. Legacy scripts running as the same user can read or use the credential outside the canonical lock. Exclusive custody is unproven. This path does not issue a new key or create an OS user. It does not enable live transport or waive the accounting boundary.

## Evaluation key

Compare the returned structured interpretation against the pinned labels. Expect a primary business-information intent, with two distinct questions. The customer asks whether arriving fifteen minutes early is required if they already filled out the form, and separately asks what they are recommended to bring. Preserve the condition on the first question and the difference between requirement and recommendation. The request is the first turn, so a reference to another goal or remembered facts would be unsupported.

Check that the interpretation supplies accurate span bindings in the Swedish customer text and preserves Swedish as the host-selected language. The wire provides language as context. Language selection in the final product is a separate measure. A useful interpretation would let a later response answer the two questions distinctly, after verifying the policy. Reject an invented business rule, a claimed booking or an action handoff. This evaluates semantic interpretation. Knowledge retrieval, factual policy answers and customer-facing prose are outside the request.

## Separate execution authorization

Before requesting approval, independently establish the complete input bound for the pinned wire and resolve credential/budget exclusion and project access. If the existing key can be used by a bypass writer, the local lock alone cannot protect the cumulative ceiling. Once these gates are established, obtain a trusted, single-use approval expiring within 15 minutes. Bind its ID to the key fingerprint, project, model, wire and manifest hashes, sources, canonical ledger hashes and historical prefix, one inference at most, zero counting calls, zero retries, a $0.056 hold, and the $0.15 and $4.00 caps. Revalidate those pins under the accounting lock, durably claim the approval, and reserve the full $0.056 before sending the identical bytes once. Keep the hold on timeout, unknown usage, or uncertain identity or billing. A change to the request or its billing limits requires a new approval.

## Validation and files

The four targeted tests passed, including the existing 18-turn ordered rehearsal and synthetic credential guard. The manual test rejects a wrong wire and a bound above 16,000 before reservation, reaches exactly one mock inference at 16,000, confirms reserve ordering, and retains the whole hold on missing usage. A replay with fresh ledger pins is rejected because its approval ID was consumed.

Changed `scripts/sol-semantic-live.ts`, `scripts/sol-semantic-runner.test.ts`, and this report. The original runner, accounting code, manifest, ledgers, credential files and production code were preserved.
