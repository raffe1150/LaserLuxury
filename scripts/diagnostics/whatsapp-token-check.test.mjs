// Exact shell + launcher + TS worker + real resolver/decryption, private fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,cpSync,writeFileSync,readFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,dirname,join} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
const root=resolve(import.meta.dirname,'../..');const require=createRequire(import.meta.url);
const modules=resolve(root,'node_modules');const tsx=pathToFileURL(require.resolve('tsx')).href;
const revision='1bee74483edfb37b2c7dbce8e820d86948cd1d47';
const token='SYNTHETIC_SECRET_TOKEN_NEVER_OUTPUT';const key=Buffer.alloc(32,7);
function envelope(){const iv=Buffer.alloc(12,5);const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([cipher.update(JSON.stringify({accessToken:token})),cipher.final()]);return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),data.toString('base64url')].join('.');}
function run(kind,overrides={}){
 const dir=mkdtempSync(join(tmpdir(),'odin-manual-cli-'));
 try{
  for(const file of ['scripts/diagnostics/whatsapp-token-check.sh','scripts/diagnostics/whatsapp-token-check.cjs','scripts/diagnostics/whatsapp-token-check.ts','src/auth/backend-supabase.ts','src/channels/connections/repository.ts','src/channels/connections/credential-crypto.ts']){
   mkdirSync(dirname(join(dir,file)),{recursive:true});cpSync(join(root,file),join(dir,file));
  }
  writeFileSync(join(dir,'package.json'),'{"type":"module"}');mkdirSync(join(dir,'node_modules/tsx'),{recursive:true});symlinkSync(join(modules,'@supabase'),join(dir,'node_modules/@supabase'));
  writeFileSync(join(dir,'node_modules/tsx/package.json'),'{"type":"module","exports":"./index.mjs"}');
  // Test-only dependency intercept. Production CLI has no mock flag or endpoint override.
  const payload={data:{app_id:'12345',is_valid:true,scopes:['whatsapp_business_messaging','whatsapp_business_management'],expires_at:0,data_access_expires_at:0}};
  const row={id:'synthetic-connection',business_id:3,provider:'whatsapp',provider_account_id:'synthetic-phone',provider_connection_id:'synthetic-waba',status:'connected',reconnect_required:false,token_expires_at:null,credential_ciphertext:envelope(),metadata:{private:'SYNTHETIC_METADATA_NEVER_OUTPUT'}};
  if(kind==='tenant')row.business_id=4;if(kind==='decrypt')row.credential_ciphertext='invalid';if(kind==='stored-expired')row.token_expires_at='2000-01-01';
  if(kind==='wrong-app')payload.data.app_id='67890';if(kind==='revoked')payload.data.is_valid=false;if(kind==='expired')payload.data.expires_at=1;
  if(kind==='scope')payload.data.scopes=[];if(kind==='missing-app')delete payload.data.app_id;if(kind==='numeric-app')payload.data.app_id=12345;
  if(kind==='missing-data')delete payload.data;
  writeFileSync(join(dir,'node_modules/tsx/index.mjs'),`
import ${JSON.stringify(tsx)};
import {appendFileSync} from 'node:fs';
const kind=${JSON.stringify(kind)};const row=${JSON.stringify(row)};const payload=${JSON.stringify(payload)};
globalThis.fetch=async(input,init)=>{
 const r=new Request(input,init);const u=new URL(r.url);
 if(r.method!=='GET')throw Error('WRITE_FORBIDDEN');
 if(u.origin==='https://blknxpoeaqrvvdhixrau.supabase.co' && u.pathname==='/rest/v1/channel_connections'){
  appendFileSync(${JSON.stringify(join(dir,'calls'))},'DB_GET\\n');
  if(kind==='db-error')return new Response('{"message":"SYNTHETIC_RAW_ERROR_NEVER_OUTPUT"}',{status:403});
  return new Response(JSON.stringify(kind==='no-connection'?[]:[row]),{headers:{'Content-Type':'application/json'}});
 }
 if(u.origin!=='https://graph.facebook.com' || u.pathname!=='/v25.0/debug_token' || u.searchParams.get('input_token')!==${JSON.stringify(token)} || r.headers.get('Authorization')!==${JSON.stringify('Bearer '+token)})throw Error('OUTBOUND_FORBIDDEN');
 appendFileSync(${JSON.stringify(join(dir,'calls'))},'META_GET\\n');
 if(kind==='timeout')throw new DOMException('SYNTHETIC_RAW_ERROR_NEVER_OUTPUT','TimeoutError');
 if(kind==='hard-timeout'){setInterval(()=>{},1000);await new Promise(()=>{});}
 if(kind==='network')throw Error('SYNTHETIC_RAW_ERROR_NEVER_OUTPUT');
 if(kind==='logging'){console.log('SYNTHETIC_SECRET_TOKEN_NEVER_OUTPUT');console.error('SYNTHETIC_RAW_ERROR_NEVER_OUTPUT');process.stderr.write('SYNTHETIC_SECRET_TOKEN_NEVER_OUTPUT');}
 if(kind==='stdout')process.stdout.write('SYNTHETIC_SECRET_TOKEN_NEVER_OUTPUT');
 if(kind==='oversize')return new Response('x'.repeat(65537));
 if(kind==='malformed')return new Response('SYNTHETIC_RAW_BODY_NEVER_OUTPUT');
 if(kind.startsWith('graph'))return new Response(JSON.stringify({error:{code:190,message:'SYNTHETIC_RAW_BODY_NEVER_OUTPUT'}}),{status:kind==='graph200'?200:403});
 const status=kind.startsWith('http')?Number(kind.slice(4)):200;
 return new Response(JSON.stringify(status===200?payload:{}),{status});
};`);
  if(kind==='import-missing')rmSync(join(dir,'src/channels/connections/repository.ts'));
  const env={PATH:process.env.PATH,RENDER_GIT_COMMIT:revision,SUPABASE_URL:'https://blknxpoeaqrvvdhixrau.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_synthetic',CHANNEL_CREDENTIAL_ENCRYPTION_KEY:key.toString('base64'),META_APP_ID:'12345',...overrides};
  const args=['scripts/diagnostics/whatsapp-token-check.sh',kind==='revision'?'0'.repeat(40):revision];
  const result=spawnSync('sh',args,{cwd:dir,env,encoding:'utf8',timeout:30000});assert.equal(result.error,undefined);assert.equal(result.status,0);assert.equal(result.stderr,'');
  assert.ok(!/SYNTHETIC_|Bearer|https:|12345|67890|synthetic-phone|stack/.test(result.stdout),result.stdout);
  const output=JSON.parse(result.stdout);let calls=[];try{calls=readFileSync(join(dir,'calls'),'utf8').trim().split('\n');}catch{}
  assert.ok(calls.filter(x=>x==='DB_GET').length<=1);assert.ok(calls.filter(x=>x==='META_GET').length<=1);
  return {output,calls};
 }finally{rmSync(dir,{recursive:true,force:true});}
}
const cases={valid:null,'wrong-app':'APP_ID_MISMATCH',http400:'HTTP_REJECTED',http401:'HTTP_REJECTED',http403:'HTTP_REJECTED',http429:'HTTP_REJECTED',http500:'HTTP_REJECTED',http503:'HTTP_REJECTED',graph403:'GRAPH_ERROR',graph200:'GRAPH_ERROR','missing-data':'DEBUG_DATA_MISSING','missing-app':'APP_ID_MISSING','numeric-app':'APP_ID_TYPE_INVALID',malformed:'INVALID_JSON',revoked:'TOKEN_INVALID',expired:'TOKEN_EXPIRY_INVALID',scope:'TOKEN_SCOPE_MISSING',tenant:'TENANT_SCOPE_REJECTED',decrypt:'CREDENTIAL_RECOVERY_FAILED','stored-expired':'CREDENTIAL_EXPIRED','no-connection':'TENANT_CONNECTION_NOT_FOUND','db-error':'TENANT_LOOKUP_FAILED',timeout:'HTTP_TIMEOUT','hard-timeout':'CHILD_TIMEOUT',network:'HTTP_REQUEST_FAILED',logging:null,stdout:'CHILD_OUTPUT_REJECTED',oversize:'RESPONSE_TOO_LARGE','import-missing':'IMPORT_FAILED',revision:'REVIEWED_REVISION_REQUIRED'};
for(const [kind,error] of Object.entries(cases))test(`exact manual entry: ${kind}`,()=>{
 const {output,calls}=run(kind);assert.equal(output.error,error);
 if(kind==='valid'){assert.equal(output.appIdMatchesRuntime,true);assert.equal(output.credentialRecovered,true);assert.equal(output.tokenValid,true);assert.deepEqual(calls,['DB_GET','META_GET']);}
 if(['tenant','decrypt','stored-expired','no-connection','db-error'].includes(kind))assert.deepEqual(calls,['DB_GET']);
 if(kind==='revision'||kind==='import-missing')assert.deepEqual(calls,[]);
 if(kind.startsWith('graph'))assert.equal(output.graphErrorCode,190);
});
for(const key of ['ODINLINK_ASYNC_KNOWLEDGE_ADMISSION','ODINLINK_ASYNC_KNOWLEDGE_PROCESSING','ODINLINK_ASYNC_KNOWLEDGE_DELIVERY','ODINLINK_SMART_WAITING'])test(`prerequisite rejects enabled ${key} without IO`,()=>{
 const {output,calls}=run('valid',{[key]:'true'});assert.equal(output.error,'CONTROLS_NOT_OFF');assert.deepEqual(calls,[]);
});
test('wrong database and invalid app config fail before reads',()=>{
 for(const overrides of [{SUPABASE_URL:'https://another-project.supabase.co'},{META_APP_ID:''}]){const {output,calls}=run('valid',overrides);assert.ok(['DATABASE_TARGET_INVALID','APP_CONFIGURATION_INVALID'].includes(output.error));assert.deepEqual(calls,[]);}
});
test('shell clears debug/preload/coverage settings before Node startup',()=>{
 const {output}=run('valid',{NODE_OPTIONS:'--require /must-not-load',NODE_DEBUG:'http,https',NODE_DEBUG_NATIVE:'*',SSLKEYLOGFILE:'/must-not-write',NODE_V8_COVERAGE:'/must-not-write'});assert.equal(output.error,null);
});
test('importing launcher and TS worker is inert: no IO, output or console mutation',()=>{
 const script=`const old=console.log;globalThis.fetch=()=>{throw Error('NO_NETWORK')};await import(${JSON.stringify(pathToFileURL(join(root,'scripts/diagnostics/whatsapp-token-check.ts')).href)});await import(${JSON.stringify(pathToFileURL(join(root,'scripts/diagnostics/whatsapp-token-check.cjs')).href)});if(console.log!==old)throw Error('CONSOLE_MUTATED');`;
 const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:root,env:{PATH:process.env.PATH},encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');assert.equal(result.stderr,'');
});
