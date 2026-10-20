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
