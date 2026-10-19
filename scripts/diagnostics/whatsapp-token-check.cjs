// Manual launcher: no application modules, no network, no raw child output.
if (require.main === module) {
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const stages = ['runtime_configuration','imports','tenant_lookup','credential_recovery','http_response','json_parsing','graph_error','app_identity_comparison','token_checks'];
const errors = ['RUNTIME_TARGET_INVALID','CONTROLS_NOT_OFF','APP_CONFIGURATION_INVALID','DATABASE_TARGET_INVALID','READ_BOUNDARY_REJECTED','TENANT_LOOKUP_FAILED','TENANT_CONNECTION_NOT_FOUND','TENANT_SCOPE_REJECTED','CREDENTIAL_RECOVERY_FAILED','CREDENTIAL_EXPIRED','RESPONSE_BODY_UNAVAILABLE','RESPONSE_TOO_LARGE','INVALID_JSON','GRAPH_ERROR','HTTP_REJECTED','DEBUG_DATA_MISSING','APP_ID_MISSING','APP_ID_TYPE_INVALID','APP_ID_MISMATCH','TOKEN_INVALID','TOKEN_SCOPE_MISSING','TOKEN_EXPIRY_INVALID','RUNTIME_CONFIGURATION_FAILED','IMPORT_FAILED','HTTP_REQUEST_FAILED','HTTP_TIMEOUT','RESPONSE_READ_FAILED','APP_COMPARISON_FAILED','DIAGNOSTIC_FAILED'];
const bools = ['credentialRecovered','validJson','dataPresent','appIdPresent','appIdMatchesRuntime','tokenValid','messagingScopePresent','managementScopePresent','expiresAtPresent','expiresAtAcceptable','dataAccessExpiresAtPresent','dataAccessExpiresAtAcceptable'];
const keys = ['stage','error','httpStatus','graphErrorCode','appIdType',...bools];
const fail = error => process.stdout.write(JSON.stringify({stage:'shell_runtime',error})+'\n');
try {
  const revision = process.argv[2];
  if (process.argv.length !== 3 || !/^[a-f0-9]{40}$/i.test(revision || '') || revision !== process.env.RENDER_GIT_COMMIT) {
    fail('REVIEWED_REVISION_REQUIRED');
  } else {
    // No instrumentation/preload/proxy/secret-app/coverage/TLS-key-log environment.
    const env = {PATH:process.env.PATH || '',NODE_ENV:'production',TSX_DISABLE_CACHE:'1',ODIN_DIAGNOSTIC_EXPECTED_REVISION:revision};
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
      const valid = p && Object.keys(p).length === keys.length && Object.keys(p).every(k=>keys.includes(k)) &&
        stages.includes(p.stage) && (p.error === null || errors.includes(p.error)) &&
        (p.httpStatus === null || Number.isInteger(p.httpStatus) && p.httpStatus>=100 && p.httpStatus<=599) &&
        (p.graphErrorCode === null || Number.isSafeInteger(p.graphErrorCode)) &&
        (p.appIdType === null || ['missing','null','array','string','number','boolean','object'].includes(p.appIdType)) &&
        bools.every(k=>p[k]===null || typeof p[k]==='boolean');
      if (!valid) fail('CHILD_OUTPUT_REJECTED');
      else process.stdout.write(JSON.stringify(Object.fromEntries(keys.map(k=>[k,p[k]])))+'\n');
    }
  }
} catch { fail('SHELL_RUNTIME_FAILED'); }

}
