// Manual child only: no server import, startup hook, worker or product dependency.
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
for (const key of ['log','info','warn','error','debug','trace'] as const) console[key]=()=>{};
type Stage='runtime_configuration'|'imports'|'tenant_lookup'|'credential_recovery'|'http_response'|'json_parsing'|'graph_error'|'app_identity_comparison'|'token_checks'|'granular_scopes';
const out:{stage:Stage;error:string|null;httpStatus:number|null;graphErrorCode:number|null;credentialRecovered:boolean;validJson:boolean|null;dataPresent:boolean|null;appIdPresent:boolean|null;appIdType:string|null;appIdMatchesRuntime:boolean|null;tokenValid:boolean|null;messagingScopePresent:boolean|null;managementScopePresent:boolean|null;expiresAtPresent:boolean|null;expiresAtAcceptable:boolean|null;dataAccessExpiresAtPresent:boolean|null;dataAccessExpiresAtAcceptable:boolean|null}={
  stage:'runtime_configuration',error:null,httpStatus:null,graphErrorCode:null,credentialRecovered:false,validJson:null,dataPresent:null,appIdPresent:null,appIdType:null,appIdMatchesRuntime:null,tokenValid:null,messagingScopePresent:null,managementScopePresent:null,expiresAtPresent:null,expiresAtAcceptable:null,dataAccessExpiresAtPresent:null,dataAccessExpiresAtAcceptable:null};
const granularKeys=['messagingTargetIdsPresent','messagingTargetIdsArrays','managementTargetIdsPresent','managementTargetIdsArrays','messagingAnyWabaMatch','messagingAllWabaMatch','managementAnyWabaMatch','normalizedManagementAnyWabaMatch','numericTargetIdsPresent','unsafeNumericTargetIdsPresent','normalizedMessagingAnyWabaMatch','normalizedMessagingAllWabaMatch','normalizedComparisonChangesResult'] as const;
const granular:Record<string,boolean|number|null>=Object.fromEntries(['messagingEntryCount','managementEntryCount',...granularKeys].map(k=>[k,null]));
const granularMode=process.env.ODIN_DIAGNOSTIC_GRANULAR_SCOPES==='1';
const stop=(code:string):never=>{out.error ??= code;throw new Error('STOP');};
const object=(v:any)=>v!==null && typeof v==='object' && !Array.isArray(v);
const local=(p:string)=>import(pathToFileURL(resolve(process.cwd(),p)).href);
const lifetime=AbortSignal.timeout(20000);
try {
  // Direct execution outside the clean launcher fails before imports/credentials.
  if(!/^[a-f0-9]{40}$/i.test(process.env.ODIN_DIAGNOSTIC_EXPECTED_REVISION||'') ||
    process.env.RENDER_GIT_COMMIT!==process.env.ODIN_DIAGNOSTIC_EXPECTED_REVISION) stop('RUNTIME_TARGET_INVALID');
  for(const k of ['ODINLINK_ASYNC_KNOWLEDGE_ADMISSION','ODINLINK_ASYNC_KNOWLEDGE_PROCESSING','ODINLINK_ASYNC_KNOWLEDGE_DELIVERY','ODINLINK_SMART_WAITING']) {
    if(![undefined,'','false'].includes(process.env[k]))stop('CONTROLS_NOT_OFF');
  }
  const configured=process.env.META_APP_ID||'';if(!/^[0-9]+$/.test(configured))stop('APP_CONFIGURATION_INVALID');
  // This reviewed comparison changes no app environment or product authorization.
  const comparison=process.env.ODIN_DIAGNOSTIC_EXPECTED_APP_ID;
  if(comparison!==undefined && comparison!=='26871846599183572')stop('EXPECTED_APP_NOT_ALLOWLISTED');
  const expected=comparison??configured;
  if(process.env.ODIN_DIAGNOSTIC_GRANULAR_SCOPES!==undefined && !granularMode || granularMode && comparison!=='26871846599183572')stop('GRANULAR_MODE_INVALID');
  out.stage='imports';
  const {createClient}=await import('@supabase/supabase-js');
  const {getBackendSupabaseConfiguration}=await local('src/auth/backend-supabase.ts');
  const {resolveConnectionForBusiness}=await local('src/channels/connections/repository.ts');
  out.stage='runtime_configuration';
  const config=getBackendSupabaseConfiguration();const dbUrl=new URL(config.url);
  if(dbUrl.origin!=='https://blknxpoeaqrvvdhixrau.supabase.co' || !['','/'].includes(dbUrl.pathname) || dbUrl.username || dbUrl.password || dbUrl.search || dbUrl.hash)stop('DATABASE_TARGET_INVALID');
  let reads=0;
  const db=createClient(config.url,config.serviceRoleKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(input:RequestInfo|URL,init?:RequestInit)=>{
    const r=new Request(input,init);const u=new URL(r.url);
    if(++reads!==1 || r.method!=='GET' || u.origin!==dbUrl.origin || u.pathname!=='/rest/v1/channel_connections' ||
      u.searchParams.get('select')!=='*' || u.searchParams.get('business_id')!=='eq.3' || u.searchParams.get('provider')!=='eq.whatsapp' ||
      u.searchParams.get('status')!=='eq.connected' || u.searchParams.get('reconnect_required')!=='eq.false')stop('READ_BOUNDARY_REJECTED');
    return fetch(r,{redirect:'error',signal:lifetime});
  }}});
  // Observe existing query boundary, without replacing credential selection/decryption.
  const observed={from:(table:string)=>{
    if(table!=='channel_connections')stop('READ_BOUNDARY_REJECTED');
    return {select:(columns:string)=>{
      if(columns!=='*')stop('READ_BOUNDARY_REJECTED');
      const q=db.from(table).select(columns);const original=q.maybeSingle.bind(q);
      (q as any).maybeSingle=async()=>{
        const r=await original();if(r.error)stop('TENANT_LOOKUP_FAILED');if(!r.data)stop('TENANT_CONNECTION_NOT_FOUND');
        const row=r.data as any;
        if(Number(row.business_id)!==3 || row.provider!=='whatsapp' || row.status!=='connected' || row.reconnect_required!==false)stop('TENANT_SCOPE_REJECTED');
        out.stage='credential_recovery';return r;
      };
      return q;
    }};
  }};
  out.stage='tenant_lookup';const c=await resolveConnectionForBusiness(observed,3,'whatsapp');
  if(!c || c.businessId!==3 || c.provider!=='whatsapp' || c.status!=='connected' || c.reconnectRequired || typeof c.credential?.accessToken!=='string' || !c.credential.accessToken.trim())stop('CREDENTIAL_RECOVERY_FAILED');
  out.credentialRecovered=true;
  if(c.tokenExpiresAt!==null && (!Number.isFinite(Date.parse(c.tokenExpiresAt)) || Date.parse(c.tokenExpiresAt)<=Date.now()))stop('CREDENTIAL_EXPIRED');
  if(granularMode && (typeof c.providerConnectionId!=='string' || !/^[1-9][0-9]{0,31}$/.test(c.providerConnectionId)))stop('STORED_WABA_INVALID');
  const token=c.credential.accessToken;const url=new URL('https://graph.facebook.com/v25.0/debug_token');url.searchParams.set('input_token',token);
  out.stage='http_response';
  const response=await fetch(url,{method:'GET',redirect:'error',headers:{Authorization:`Bearer ${token}`},signal:lifetime});out.httpStatus=response.status;
  out.stage='json_parsing';const reader=response.body?.getReader();if(!reader)stop('RESPONSE_BODY_UNAVAILABLE');
  const chunks:Buffer[]=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536){await reader.cancel();stop('RESPONSE_TOO_LARGE');}chunks.push(Buffer.from(value));}
  let body:any;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));out.validJson=true;}catch{out.validJson=false;stop('INVALID_JSON');}
  out.dataPresent=object(body?.data);
  if(body?.error){out.stage='graph_error';if(Number.isSafeInteger(body.error.code))out.graphErrorCode=body.error.code;stop('GRAPH_ERROR');}
  if(!response.ok){out.stage='http_response';stop('HTTP_REJECTED');}
  out.stage='app_identity_comparison';if(!out.dataPresent)stop('DEBUG_DATA_MISSING');const d=body.data;
  out.appIdPresent=Object.prototype.hasOwnProperty.call(d,'app_id');out.appIdType=!out.appIdPresent?'missing':d.app_id===null?'null':Array.isArray(d.app_id)?'array':typeof d.app_id;
  out.appIdMatchesRuntime=d.app_id===expected;out.tokenValid=typeof d.is_valid==='boolean'?d.is_valid:null;
  out.messagingScopePresent=Array.isArray(d.scopes)?d.scopes.includes('whatsapp_business_messaging'):null;
  out.managementScopePresent=Array.isArray(d.scopes)?d.scopes.includes('whatsapp_business_management'):null;
  out.expiresAtPresent=Object.prototype.hasOwnProperty.call(d,'expires_at');out.dataAccessExpiresAtPresent=Object.prototype.hasOwnProperty.call(d,'data_access_expires_at');
  const expiry=(v:any)=>typeof v==='number' && Number.isFinite(v) && (v===0 || v*1000>Date.now());
  out.expiresAtAcceptable=expiry(d.expires_at);out.dataAccessExpiresAtAcceptable=expiry(d.data_access_expires_at);
  if(!out.appIdPresent)stop('APP_ID_MISSING');if(out.appIdType!=='string')stop('APP_ID_TYPE_INVALID');if(!out.appIdMatchesRuntime)stop('APP_ID_MISMATCH');
  out.stage='token_checks';if(!out.tokenValid)stop('TOKEN_INVALID');if(!out.messagingScopePresent)stop('TOKEN_SCOPE_MISSING');if(!out.expiresAtAcceptable || !out.dataAccessExpiresAtAcceptable)stop('TOKEN_EXPIRY_INVALID');
  if(granularMode){
    out.stage='granular_scopes';
    if(!Object.prototype.hasOwnProperty.call(d,'granular_scopes'))stop('GRANULAR_SCOPES_MISSING');
    if(!Array.isArray(d.granular_scopes))stop('GRANULAR_SCOPES_INVALID');
    if(d.granular_scopes.some((g:any)=>!object(g) || typeof g.scope!=='string'))stop('GRANULAR_SCOPE_ENTRY_INVALID');
    const messaging=d.granular_scopes.filter((g:any)=>g.scope==='whatsapp_business_messaging');
    const management=d.granular_scopes.filter((g:any)=>g.scope==='whatsapp_business_management');
    const waba=c.providerConnectionId;
    const present=(g:any)=>Object.prototype.hasOwnProperty.call(g,'target_ids');
    const array=(g:any)=>Array.isArray(g.target_ids);
    const strict=(g:any)=>array(g) && g.target_ids.includes(waba);
    const numeric=(v:any)=>typeof v==='number';
    const safeNumeric=(v:any)=>Number.isSafeInteger(v) && v>0;
    // Lossless diagnostic comparison only. Unsafe numbers remain unknown.
    const normalized=(g:any):boolean|null=>{
      if(!array(g))return false;
      if(g.target_ids.some((v:any)=>v===waba || numeric(v) && safeNumeric(v) && String(v)===waba))return true;
      return g.target_ids.some((v:any)=>numeric(v) && !safeNumeric(v))?null:false;
    };
    const any=(v:(boolean|null)[]):boolean|null=>v.length===0?null:v.includes(true)?true:v.includes(null)?null:false;
    const all=(v:(boolean|null)[]):boolean|null=>v.length===0?null:v.includes(false)?false:v.includes(null)?null:true;
    granular.messagingEntryCount=messaging.length;granular.managementEntryCount=management.length;
    granular.messagingTargetIdsPresent=messaging.length?messaging.every(present):null;
    granular.messagingTargetIdsArrays=messaging.length?messaging.every(array):null;
    granular.managementTargetIdsPresent=management.length?management.every(present):null;
    granular.managementTargetIdsArrays=management.length?management.every(array):null;
    granular.messagingAnyWabaMatch=any(messaging.map(strict));granular.messagingAllWabaMatch=all(messaging.map(strict));
    granular.managementAnyWabaMatch=any(management.map(strict));granular.normalizedManagementAnyWabaMatch=any(management.map(normalized));
    const targets=[...messaging,...management].filter(array).flatMap((g:any)=>g.target_ids);
    granular.numericTargetIdsPresent=targets.some(numeric);granular.unsafeNumericTargetIdsPresent=targets.some((v:any)=>numeric(v)&&!safeNumeric(v));
    granular.normalizedMessagingAnyWabaMatch=any(messaging.map(normalized));granular.normalizedMessagingAllWabaMatch=all(messaging.map(normalized));
    granular.normalizedComparisonChangesResult=granular.normalizedMessagingAllWabaMatch===null || granular.messagingAllWabaMatch===null?null:granular.normalizedMessagingAllWabaMatch!==granular.messagingAllWabaMatch;
  }
}catch(e){
  if(out.error===null)out.error=out.stage==='http_response' && (lifetime.aborted || (e as any)?.name==='TimeoutError')?'HTTP_TIMEOUT':({runtime_configuration:'RUNTIME_CONFIGURATION_FAILED',imports:'IMPORT_FAILED',tenant_lookup:'TENANT_LOOKUP_FAILED',credential_recovery:'CREDENTIAL_RECOVERY_FAILED',http_response:'HTTP_REQUEST_FAILED',json_parsing:'RESPONSE_READ_FAILED',app_identity_comparison:'APP_COMPARISON_FAILED',graph_error:'GRAPH_ERROR',token_checks:'DIAGNOSTIC_FAILED',granular_scopes:'DIAGNOSTIC_FAILED'} as const)[out.stage];
}
process.stdout.write(JSON.stringify(granularMode?{...out,...granular}:out)+'\n');

}
