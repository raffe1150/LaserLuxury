// Manual launcher: no application modules, no network, no raw child output.
if (require.main === module) {
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const stages = ['runtime_configuration','imports','tenant_lookup','credential_recovery','http_response','json_parsing','graph_error','app_identity_comparison','token_checks','granular_scopes'];
const errors = ['RUNTIME_TARGET_INVALID','CONTROLS_NOT_OFF','APP_CONFIGURATION_INVALID','DATABASE_TARGET_INVALID','READ_BOUNDARY_REJECTED','TENANT_LOOKUP_FAILED','TENANT_CONNECTION_NOT_FOUND','TENANT_SCOPE_REJECTED','CREDENTIAL_RECOVERY_FAILED','CREDENTIAL_EXPIRED','RESPONSE_BODY_UNAVAILABLE','RESPONSE_TOO_LARGE','INVALID_JSON','GRAPH_ERROR','HTTP_REJECTED','DEBUG_DATA_MISSING','APP_ID_MISSING','APP_ID_TYPE_INVALID','APP_ID_MISMATCH','TOKEN_INVALID','TOKEN_SCOPE_MISSING','TOKEN_EXPIRY_INVALID','RUNTIME_CONFIGURATION_FAILED','IMPORT_FAILED','HTTP_REQUEST_FAILED','HTTP_TIMEOUT','RESPONSE_READ_FAILED','APP_COMPARISON_FAILED','DIAGNOSTIC_FAILED','EXPECTED_APP_NOT_ALLOWLISTED','GRANULAR_MODE_INVALID','STORED_WABA_INVALID','GRANULAR_SCOPES_MISSING','GRANULAR_SCOPES_INVALID','GRANULAR_SCOPE_ENTRY_INVALID'];
const bools = ['credentialRecovered','validJson','dataPresent','appIdPresent','appIdMatchesRuntime','tokenValid','messagingScopePresent','managementScopePresent','expiresAtPresent','expiresAtAcceptable','dataAccessExpiresAtPresent','dataAccessExpiresAtAcceptable'];
const granularBools = ['messagingTargetIdsPresent','messagingTargetIdsArrays','managementTargetIdsPresent','managementTargetIdsArrays','messagingAnyWabaMatch','messagingAllWabaMatch','managementAnyWabaMatch','normalizedManagementAnyWabaMatch','numericTargetIdsPresent','unsafeNumericTargetIdsPresent','normalizedMessagingAnyWabaMatch','normalizedMessagingAllWabaMatch','normalizedComparisonChangesResult'];
const granularCounts = ['messagingEntryCount','managementEntryCount'];
const keys = ['stage','error','httpStatus','graphErrorCode','appIdType',...bools];
const fail = error => process.stdout.write(JSON.stringify({stage:'shell_runtime',error})+'\n');
try {
  const revision = process.argv[2];
  // Operator-verified Laser Luxury Agent test identity, Business 3 diagnostic only.
  const reviewedApp = '26871846599183572';
  const comparison = process.argv.length > 3;
  const granular = process.argv.length === 6 && process.argv[5] === '--granular-scopes';
  if (comparison && ((process.argv.length !== 5 && !granular) || process.argv[3] !== '--expected-app' || process.argv[4] !== reviewedApp)) {
    fail('EXPECTED_APP_NOT_ALLOWLISTED');
  } else if ((!comparison && process.argv.length !== 3) || !/^[a-f0-9]{40}$/i.test(revision || '') || revision !== process.env.RENDER_GIT_COMMIT) {
    fail('REVIEWED_REVISION_REQUIRED');
  } else {
    // No instrumentation/preload/proxy/secret-app/coverage/TLS-key-log environment.
    const env = {PATH:process.env.PATH || '',NODE_ENV:'production',TSX_DISABLE_CACHE:'1',ODIN_DIAGNOSTIC_EXPECTED_REVISION:revision};
    if (comparison) env.ODIN_DIAGNOSTIC_EXPECTED_APP_ID = reviewedApp;
    if (granular) env.ODIN_DIAGNOSTIC_GRANULAR_SCOPES = '1';
    for (const key of ['RENDER_GIT_COMMIT','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','CHANNEL_CREDENTIAL_ENCRYPTION_KEY','CHANNEL_CREDENTIAL_KEY_ID','META_APP_ID','ODINLINK_ASYNC_KNOWLEDGE_ADMISSION','ODINLINK_ASYNC_KNOWLEDGE_PROCESSING','ODINLINK_ASYNC_KNOWLEDGE_DELIVERY','ODINLINK_SMART_WAITING']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    const result = spawnSync(process.execPath,['--import','tsx',path.join(__dirname,'whatsapp-token-check.ts')],{
      cwd:path.resolve(__dirname,'../..'),env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:25000,maxBuffer:16384
    });
    if (result.error?.code === 'ETIMEDOUT') fail('CHILD_TIMEOUT');
    else if (result.error || result.status !== 0) fail('CHILD_STARTUP_OR_RUNTIME_FAILED');
    else {
      let p; try { p = JSON.parse(result.stdout); } catch {}
      const expectedKeys = granular ? [...keys,...granularBools,...granularCounts] : keys;
      const valid = p && Object.keys(p).length === expectedKeys.length && Object.keys(p).every(k=>expectedKeys.includes(k)) &&
        stages.includes(p.stage) && (p.error === null || errors.includes(p.error)) &&
        (p.httpStatus === null || Number.isInteger(p.httpStatus) && p.httpStatus>=100 && p.httpStatus<=599) &&
        (p.graphErrorCode === null || Number.isSafeInteger(p.graphErrorCode)) &&
        (p.appIdType === null || ['missing','null','array','string','number','boolean','object'].includes(p.appIdType)) &&
        bools.every(k=>p[k]===null || typeof p[k]==='boolean') && (!granular ||
          granularBools.every(k=>p[k]===null || typeof p[k]==='boolean') && granularCounts.every(k=>p[k]===null || Number.isInteger(p[k]) && p[k]>=0 && p[k]<=65536));
      if (!valid) fail('CHILD_OUTPUT_REJECTED');
      else {
        // Comparison mode exposes only verdict/status, token checks and safe errors.
        const safe = granular ? Object.fromEntries(['stage','error','httpStatus','graphErrorCode',...granularCounts,...granularBools].map(k=>[k,p[k]])) : comparison ? {
          stage:p.stage,error:p.error,httpStatus:p.httpStatus,graphErrorCode:p.graphErrorCode,
          appIdMatchesExpected:p.appIdMatchesRuntime,tokenValid:p.tokenValid,
          messagingScopePresent:p.messagingScopePresent,managementScopePresent:p.managementScopePresent,
          expiresAtAcceptable:p.expiresAtAcceptable,dataAccessExpiresAtAcceptable:p.dataAccessExpiresAtAcceptable
        } : Object.fromEntries(keys.map(k=>[k,p[k]]));
        process.stdout.write(JSON.stringify(safe)+'\n');
      }
    }
  }
} catch { fail('SHELL_RUNTIME_FAILED'); }

}
