# One-time WhatsApp tenant-token diagnostic

Manual operational tool only. No server/worker import or configuration activation. Target is fixed to production project `blknxpoeaqrvvdhixrau`, business 3, WhatsApp. No global/legacy credential fallback. Not an authorization replacement and not a customer delivery test.

## Operator command after separate manual code release

From the deployed repository root, run once:

```
sh scripts/diagnostics/whatsapp-token-check.sh FULL_REVIEWED_DEPLOYED_COMMIT_SHA
```

Replace the placeholder with the independently reviewed full 40-character deployed revision. Do not substitute `$RENDER_GIT_COMMIT`: explicit confirmation is intentional. The CLI is not present in deployed baseline `1bee744`; a separately authorized code commit/push/manual deployment is required before the command is available. Use the NEW reviewed deployment SHA, not `1bee744`. No changes to production variables or migrations are required. Keep all four controls OFF, confirm Auto Deploy OFF, and use the existing operator-controlled frontend-routing release procedure. No release operations were performed by this task.

## Process and credential safety

- `.sh` disables shell tracing, suppresses stderr, requires core dumps disabled, clears Node preload/debug/coverage/warning-output and relevant TLS/loader settings before launching Node. Only the nonsecret revision is a command argument.
- `.cjs` imports Node builtins only and spawns a fresh child with an explicit minimal environment. No application APM/preload/proxy/coverage/TLS-key-log or app-secret environment is inherited. The child has no instrumentation subscribers inherited from the web server. No server startup, background job, reconnection or health-update API is imported.
- `.ts` dynamically imports existing `getBackendSupabaseConfiguration`, `resolveConnectionForBusiness` and the installed Supabase client. The original resolver selects and decrypts the original tenant credential. The query observer changes no filters/data/credential selection; it identifies the lookup-to-decryption boundary for accurate stage errors.
- The database fetch guard permits only the first GET to the exact production channel_connections resource with business3/provider/status/reconnect filters and select*. Auth sessions, auto refresh and persistence are disabled. No writes are permitted. If a library attempts a retry it is blocked before another network request.
- The only provider operation is one GET to the fixed v25.0 debug_token endpoint with the tenant token as input_token and bearer, matching the existing provider introspection flow. No app secret, alternate inspector credential, fallback request, phone lookup, token exchange or message endpoint. Redirects fail closed. Token data remains in process memory; no caches/files containing it are created by this tool. TSX caching is disabled. No package installation.
- Child console output is suppressed. Both stdout and stderr are captured in bounded pipes. The launcher NEVER forwards stderr, exception text, or arbitrary stdout: it parses exactly one object and reconstructs only an allowlisted fixed schema. Unexpected output is replaced by a fixed code. No raw bodies, URLs, app/phone IDs, credentials, metadata or headers are emitted. Intermediate plaintext is not claimed to be cryptographically erased from memory; the process exits and core dumping is disabled.
- Normal imports of either executable module are inert; explicit-entry guards are tested.

Assumptions: trusted host, Node binary, checkout and installed dependencies, as in the approved existing web service. This tool cannot stop host/root/OS interception or Meta/upstream request logging. `input_token` is necessarily part of the approved GET URL and reaches Meta. No OdinLink request logger is imported, and this clean process does not inherit the application's instrumentation; it cannot prove the hosting platform never captures URLs or process environments. If infrastructure inspection records sensitive query strings or requires unapproved proxy interception, DO NOT RUN: obtain query redaction or use a separately approved first-party Meta/operator diagnostic instead. No claim of infrastructure-wide secret non-observability is made.

## Timing and output interpretation

One database read, at most one Meta request, 20-second abort signal and a 25-second parent hard timeout. Bounded response body64KiB, child output16KiB. CLI always exits after producing its safe result under ordinary runtime conditions; shell/runtime failure codes may have only stage/error. Fatal OS termination of the launcher cannot guarantee JSON and must never be interpreted as a provider result. No automatic retry.

Fields: stage, fixed error, httpStatus, numeric graphErrorCode, credentialRecovered, validJson, dataPresent, appIdPresent/type/matchesRuntime, tokenValid, messagingScopePresent, managementScopePresent, expiresAtPresent/Acceptable, dataAccessExpiresAtPresent/Acceptable. Null means not established. Missing/invalid expiry is false; zero expiry is accepted as in the existing guard. The CLI reports management scope presence but only messaging is the existing Async token-scope requirement; no authorization policy change is made.

| Classification | Meaning |
|---|---|
| shell_runtime | Explicit revision missing/wrong; loader/process/output boundary failed; not a provider rejection |
| runtime_configuration | Project/app/backend settings or OFF prerequisites failed; no provider call |
| imports / IMPORT_FAILED | Required source/package unavailable; not a provider failure |
| tenant_lookup | Tenant SELECT failed/missing/wrong scope; no provider call |
| credential_recovery | Original resolver decryption/payload failed, or stored expiry already expired; no provider call |
| http_response / HTTP_REQUEST_FAILED or HTTP_TIMEOUT | Request did not yield a response; no mismatch inferred |
| http_response / HTTP_REJECTED | Non-2xx without a usable Graph error, not an app mismatch |
| json_parsing | Malformed/oversized/unreadable response, not an app mismatch |
| graph_error / GRAPH_ERROR | Explicit provider error (including HTTP200 error body); numeric code only |
| app_identity_comparison / DEBUG_DATA_MISSING, APP_ID_MISSING, APP_ID_TYPE_INVALID | Unknown/malformed identity; remains fail-closed |
| app_identity_comparison / APP_ID_MISMATCH | Successful HTTP/JSON data with a string app ID differing from runtime; never accepts unknown identity |
| token_checks | Matching app; separate validity, messaging scope and expiry checks; error null means these checks passed |

A matching app/null error is NOT full WhatsApp delivery authorization: current phone/WABA ownership, granular permissions, health, messaging window, task/turn/source authority and independent factual verification are not exercised here. Existing product checks remain unchanged. This result alone must not enable Async or replay a FAILED task.

## Review, tests and rollback

The test file invokes the exact shell launcher and child against a private copied checkout. Its test-only local tsx shim intercepts GETs, uses synthetic encrypted tenant rows with the REAL resolver/decryption, and never performs real network requests. It is not a production test flag or alternate runtime credential path. Test cases cover identity, HTTP/Graph/parse, expiry/revocation/scopes, tenant, decryption, controls, timeout, unexpected logging, output injection, revision/import failures and inert imports.

Review only these five new paths for staging: README.md, whatsapp-token-check.sh, whatsapp-token-check.cjs, whatsapp-token-check.ts, whatsapp-token-check.test.mjs under scripts/diagnostics. Preserve historical untracked reports; do not blanket stage. Run the focused tests and TypeScript, inspect the isolated patch, then obtain separate authorization for commit/push/manual deployment with controls OFF. This Work task executes none of those release steps. Rollback is removal/reversion of this standalone CLI in a separately authorized application release; no schema, credential, task or product behavior rollback is necessary.

## Reviewed older-app comparison (diagnostic only)

The operator independently verified the Dashboard identity for **Laser Luxury Agent test** and authorized this single Business 3 comparison. The explicit option is restricted to that one code-reviewed ID in both launcher and worker; arbitrary runtime arguments or inherited diagnostic environment variables cannot add an app to the allowlist. This does NOT assert that the tenant token belongs to that app until the separately executed read-only comparison succeeds.

After separately approving and deploying this extension, use the NEW reviewed full deployment SHA:

```
sh scripts/diagnostics/whatsapp-token-check.sh FULL_REVIEWED_DEPLOYED_COMMIT_SHA --expected-app 26871846599183572
```

The ID here is an explicit diagnostic input, never a credential or emitted result. Do not change `META_APP_ID`, Render settings, credentials or any feature controls. Existing no-option CLI behavior remains compatible and still compares against runtime `META_APP_ID`. Runtime `META_APP_ID` must remain configured/numeric even in reviewed comparison mode.

Comparison mode emits only stage/error, HTTP/numeric Graph error status, `appIdMatchesExpected`, token validity, messaging/management scope booleans and expiry-validity booleans. It omits the legacy credential/data/type detail fields. It never emits either actual app identity. A missing or malformed identity yields a fixed error, not a genuine mismatch verdict. A successful match confirms this introspection's app identity, not permission to activate Async or bypass other product checks.

The existing one-DB-read/at-most-one-provider-GET, clean child environment, output validation, body/output bounds, core-dump/cache suppression, 20-second abort and 25-second hard timeout remain unchanged. Hosting/Meta query logging limitations remain as documented above. No live provider query is performed by development or tests. A separate operator action remains required to execute the command.

## Final granular-scope mode

Use only the existing reviewed-app comparison with this additional explicit flag:

```
sh scripts/diagnostics/whatsapp-token-check.sh FULL_REVIEWED_DEPLOYED_COMMIT_SHA --expected-app 26871846599183572 --granular-scopes
```

The option cannot run without the reviewed expected identity. It uses the existing tenant row's provider_connection_id (WABA), requires its canonical numeric-string form, and performs no additional lookup or provider call. The child independently validates the mode and expected-app prerequisites. Inherited environment variables cannot select this mode. App/token/scope/expiry prerequisites still fail closed before analysis. No application provider-gate code changes.

Output contains only sanitized stage/error/HTTP/numeric Graph-error fields plus:

- messagingEntryCount, managementEntryCount: entries whose scope exactly matches the two WhatsApp permissions.
- messagingTargetIdsPresent/Arrays, managementTargetIdsPresent/Arrays: whether ALL entries of that scope have the property/an array. Zero entries returns null, not a vacuous authorization success.
- messagingAnyWabaMatch, messagingAllWabaMatch, managementAnyWabaMatch: exact string membership of stored WABA; absent/non-array targets fail that comparison. Zero relevant entries returns null.
- numericTargetIdsPresent, unsafeNumericTargetIdsPresent: numeric values in the relevant target arrays; unsafe includes nonpositive, fractional or not-safely-representable integers.
- normalizedMessagingAnyWabaMatch, normalizedMessagingAllWabaMatch, normalizedManagementAnyWabaMatch: diagnostic membership after LOSSLESS conversion of safe positive integer targets to strings. Strings are not trimmed, guessed or coerced. Unsafe numbers produce unknown (null) when a match cannot otherwise be established.
- normalizedComparisonChangesResult: whether safe normalization changes messaging ALL-match, the current application predicate's effective membership requirement. Null means no entries or unresolved numeric uncertainty. Any-match normalization is separately visible.

A malformed/missing granular_scopes field or malformed entry yields a fixed sanitized error; no raw payload/IDs are emitted. All original body/output/request/time limits remain intact. In this mode no app-ID comparison details, token fields, identifiers, customer content or raw provider data are printed.

**Interpretation is evidence, not authorization.** error:null means the authenticated response was summarized, not that the application's granular gate or a customer send is authorized. A well-formed explicit target set excluding the stored WABA supports an asset-grant/identity investigation, but cannot distinguish genuinely missing provider permission from a wrong stored WABA or different provider target semantics. Missing lists do not by themselves establish permission denial. A lossless numeric normalization that changes membership demonstrates a type-sensitive comparison discrepancy; it never authorizes coercion in the product. Any-match true with all-match false demonstrates why the current some-rejection predicate rejects multiple entries, but whether that predicate is faulty requires the provider's grant-combination contract. Management-only references similarly flag a scope-contract question. Actual missing permission requires independent authoritative asset/assignment or provider denial evidence; this diagnostic makes no such extra requests.

## Independent WABA authorization evidence mode

After separate review and manual code release, keep all four Async/Waiting controls OFF. From the deployed root, substitute the NEW independently reviewed full deployment SHA and run once:

```
sh scripts/diagnostics/whatsapp-token-check.sh FULL_REVIEWED_DEPLOYED_COMMIT_SHA --expected-app 26871846599183572 --waba-authorization
```

This explicit mode is mutually exclusive with `--granular-scopes`. It retains the reviewed-app allowlist, fixed production project/Business 3/WhatsApp scope, original credential resolver/decryption, clean child, output reconstruction, redirect rejection, 64KiB provider-body bound, 20-second lifetime and 25-second hard timeout. Existing modes retain their original request bounds. No application authorization or stored configuration changes.

This mode permits at most TWO tenant SELECTs and FOUR serial provider GETs, failing early:

1. Existing `GET /v25.0/debug_token?input_token=TENANT_TOKEN`, tenant bearer authorization. Verify reviewed app, token validity, messaging and management scopes, expiry, and canonical `data.user_id`. The URL contains the token only inside the approved request; never print or persist it.
2. Existing onboarding Meta client's `GET /v25.0/{STORED_WABA}?fields=id,owner_business_info`. Require exact WABA identity and a canonical owner business identity.
3. `GET /v25.0/{STORED_WABA}/assigned_users?business={RETURNED_OWNER}&fields=id,tasks&limit=100`. Require exactly one principal matching introspection's `user_id` and its `MANAGE` task, using onboarding's conservative management-readiness policy. This does not assert that `DEVELOP` is universally insufficient for Meta messaging.
4. `GET /v25.0/{STORED_WABA}/phone_numbers?fields=id&limit=100`. Require exact stored phone membership.

The initial SELECT uses `resolveConnectionForBusiness` with its existing connected/non-reconnect tenant query. A second identical SELECT checks that connection identity, tenant, provider, connected status, WABA, phone, credential, expiry and granted scopes have not changed during the reads. Expiry is checked again. This establishes a bounded snapshot, not future authorization. No new credentials, global fallbacks, refresh, subscription, template, health-update or send requests. No pagination follow-up, automatic retry, arbitrary asset path or provider endpoint override. Paginated results remain unverified, even if the first page contains a match.

Only `error` (fixed code or null) and boolean/null fields are emitted: `tenantScoped`, `appIdentityVerified`, `tokenValid`, `expiryValid`, `messagingScopePresent`, `managementScopePresent`, `explicitGranularExclusionAbsent`, `principalIdentified`, `wabaIdentityVerified`, `ownerIdentityVerified`, `principalAssignedToWaba`, `managementTaskPresent`, `phoneBelongsToWaba`, `connectionCurrent`, `authorizationEvidenceVerified`. Null means unestablished. Launcher failures can emit only fixed shell stage/error. No actual IDs, response bodies, URLs or credentials are output. All true with error null is the complete diagnostic evidence result; this is not a messaging eligibility or delivery receipt.

The implementation reuses onboarding's read client and asset/assignment contracts without invoking the full provisioning flow, which performs unrelated reads and requires a separately authenticated authorizing-user context. Meta's official [assignment verification documentation](https://www.postman.com/meta/whatsapp-business-platform/documentation/du6gzjv/embedded-signup) documents the WABA `assigned_users` read. Assignment read denial, an unidentified principal, absent owner information, indirect assignment not represented by this endpoint, malformed results or pagination leaves authorization UNVERIFIED. Do not supply an alternate administrator credential or infer permission from read failure. The product's messaging windows, phone health, source authorization and final-answer verification are not exercised or changed.

Omitted granular targets are not interpreted as unrestricted access. The mode collects independent evidence; explicit exclusions and malformed targets still fail. A future narrowly scoped correction to the product's missing-target case requires a successful live evidence result and a separately reviewed server-side check of current assignment/task and phone membership, alongside existing app/token/scope/expiry, tenant, phone/WABA and delivery checks. A diagnostic snapshot must never become a cached grant or bypass. If these reads cannot establish the principal's applicable authorization, stop and resolve that evidence gap rather than weakening the gate. No claim is made that a missing target list alone proves either denial or permission.

Existing infrastructure limitations still apply: the clean process avoids OdinLink request instrumentation, but cannot rule out host/root interception or Meta's own URL logging. Do not run on a host with unredacted credential-query logging. No provider request has been made during implementation or tests; execution remains a separate operator action. No environment changes, feature activation, migrations or credential changes are required by this mode.
