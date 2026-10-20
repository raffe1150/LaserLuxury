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
function envelope(value=token){const iv=Buffer.alloc(12,5);const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([cipher.update(JSON.stringify({accessToken:value})),cipher.final()]);return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),data.toString('base64url')].join('.');}
function run(kind,overrides={},extraArgs=[],granularFixture,authorizationFixture){
 const dir=mkdtempSync(join(tmpdir(),'odin-manual-cli-'));
 try{
  for(const file of ['scripts/diagnostics/whatsapp-token-check.sh','scripts/diagnostics/whatsapp-token-check.cjs','scripts/diagnostics/whatsapp-token-check.ts','src/auth/backend-supabase.ts','src/channels/connections/repository.ts','src/channels/connections/credential-crypto.ts','src/channels/whatsapp/meta-client.ts']){
   mkdirSync(dirname(join(dir,file)),{recursive:true});cpSync(join(root,file),join(dir,file));
  }
  writeFileSync(join(dir,'package.json'),'{"type":"module"}');mkdirSync(join(dir,'node_modules/tsx'),{recursive:true});symlinkSync(join(modules,'@supabase'),join(dir,'node_modules/@supabase'));
  writeFileSync(join(dir,'node_modules/tsx/package.json'),'{"type":"module","exports":"./index.mjs"}');
  // Test-only dependency intercept. Production CLI has no mock flag or endpoint override.
  const payload={data:{app_id:'12345',is_valid:true,scopes:['whatsapp_business_messaging','whatsapp_business_management'],expires_at:0,data_access_expires_at:0}};
  const row={id:'synthetic-connection',business_id:3,provider:'whatsapp',provider_account_id:'synthetic-phone',provider_connection_id:'synthetic-waba',status:'connected',reconnect_required:false,token_expires_at:null,credential_ciphertext:envelope(),metadata:{private:'SYNTHETIC_METADATA_NEVER_OUTPUT'}};
  const principal='987654321',portfolio='987654322',waba='123456789012345',phone='123456789012346';
  const account={id:waba,owner_business_info:{id:portfolio}};
  const assignments={data:[{id:principal,tasks:['MANAGE']}]};const phones={data:[{id:phone}]};
  const currentRow={...row};
  if(authorizationFixture){
    payload.data.app_id='26871846599183572';payload.data.user_id=principal;
    row.provider_account_id=phone;row.provider_connection_id=waba;Object.assign(currentRow,row);
    if(authorizationFixture.principalMissing)delete payload.data.user_id;
    if(authorizationFixture.principalNumeric)payload.data.user_id=Number(principal);
    if(authorizationFixture.ownerMissing)delete account.owner_business_info;
    if(authorizationFixture.wabaMismatch)account.id='999';
    if(authorizationFixture.managementScopeMissing)payload.data.scopes=['whatsapp_business_messaging'];
    if(authorizationFixture.explicitExclusion)payload.data.granular_scopes=[{scope:'whatsapp_business_messaging',target_ids:['999']}];
    if(authorizationFixture.malformedTargets)payload.data.granular_scopes=[{scope:'whatsapp_business_messaging',target_ids:null}];
    if(authorizationFixture.omittedTargets)payload.data.granular_scopes=[{scope:'whatsapp_business_messaging'},{scope:'whatsapp_business_management'}];
    if(authorizationFixture.assignments!==undefined)assignments.data=authorizationFixture.assignments;
    if(authorizationFixture.assignmentNext)assignments.paging={next:'SYNTHETIC_NEXT_URL_NEVER_FOLLOW'};
    if(authorizationFixture.phones!==undefined)phones.data=authorizationFixture.phones;
    if(authorizationFixture.phoneNext)phones.paging={next:'SYNTHETIC_NEXT_URL_NEVER_FOLLOW'};
    if(authorizationFixture.changedToken)currentRow.credential_ciphertext=envelope('SYNTHETIC_CHANGED_TOKEN_NEVER_OUTPUT');
    if(authorizationFixture.changedTenant)currentRow.business_id=4;
    if(authorizationFixture.changedPhone)currentRow.provider_account_id='999';
    if(authorizationFixture.changedWaba)currentRow.provider_connection_id='999';
  }
  if(kind==='tenant')row.business_id=4;if(kind==='decrypt')row.credential_ciphertext='invalid';if(kind==='stored-expired')row.token_expires_at='2000-01-01';
  if(kind==='reviewed-match')payload.data.app_id='26871846599183572';
  if(granularFixture){
    payload.data.app_id=granularFixture.wrongApp?'unreviewed':'26871846599183572';
    row.provider_connection_id=granularFixture.waba??'123456789012345';
    if(Object.prototype.hasOwnProperty.call(granularFixture,'scopes'))payload.data.granular_scopes=granularFixture.scopes;
  }
  if(kind==='wrong-app')payload.data.app_id='67890';if(kind==='revoked')payload.data.is_valid=false;if(kind==='expired')payload.data.expires_at=1;
  if(kind==='scope')payload.data.scopes=[];if(kind==='missing-app')delete payload.data.app_id;if(kind==='numeric-app')payload.data.app_id=12345;
  if(kind==='missing-data')delete payload.data;
  writeFileSync(join(dir,'node_modules/tsx/index.mjs'),`
import ${JSON.stringify(tsx)};
import {appendFileSync} from 'node:fs';
const kind=${JSON.stringify(kind)};const row=${JSON.stringify(row)};const payload=${JSON.stringify(payload)};
const auth=${JSON.stringify(authorizationFixture??null)};const currentRow=${JSON.stringify(currentRow)};const account=${JSON.stringify(account)};const assignments=${JSON.stringify(assignments)};const phones=${JSON.stringify(phones)};let databaseReads=0;
globalThis.fetch=async(input,init)=>{
 const r=new Request(input,init);const u=new URL(r.url);
 if(r.method!=='GET')throw Error('WRITE_FORBIDDEN');
 if(u.origin==='https://blknxpoeaqrvvdhixrau.supabase.co' && u.pathname==='/rest/v1/channel_connections'){
  databaseReads++;appendFileSync(${JSON.stringify(join(dir,'calls'))},'DB_GET\\n');
  if(kind==='db-error')return new Response('{"message":"SYNTHETIC_RAW_ERROR_NEVER_OUTPUT"}',{status:403});
  if(auth && databaseReads===2 && auth.currentReadError)return new Response('{}',{status:403});
  return new Response(JSON.stringify(kind==='no-connection'||auth&&databaseReads===2&&auth.currentMissing?[]:[auth&&databaseReads===2?currentRow:row]),{headers:{'Content-Type':'application/json'}});
 }
 if(auth && u.origin==='https://graph.facebook.com' && u.pathname!=='/v25.0/debug_token'){
  if(r.headers.get('Authorization')!==${JSON.stringify('Bearer '+token)})throw Error('CREDENTIAL_BOUNDARY');
  let label,body,fail=false;
  if(u.pathname==='/v25.0/123456789012345' && u.searchParams.get('fields')==='id,owner_business_info'){label='WABA_GET';body=account;fail=auth.wabaError;}
  else if(u.pathname==='/v25.0/123456789012345/assigned_users' && u.searchParams.get('business')==='987654322' && u.searchParams.get('fields')==='id,tasks' && u.searchParams.get('limit')==='100'){label='ASSIGNMENT_GET';body=assignments;fail=auth.assignmentError;}
  else if(u.pathname==='/v25.0/123456789012345/phone_numbers' && u.searchParams.get('fields')==='id' && u.searchParams.get('limit')==='100'){label='PHONE_GET';body=phones;fail=auth.phoneError;}
  else throw Error('ASSET_ENDPOINT_FORBIDDEN');
  appendFileSync(${JSON.stringify(join(dir,'calls'))},label+'\\n');
  if(auth.assetTimeout)throw new DOMException('SYNTHETIC_RAW_TIMEOUT','TimeoutError');
  if(auth.assetOversize)return new Response('x'.repeat(65537));
  if(auth.assetMalformed)return new Response('SYNTHETIC_RAW_BODY_NEVER_OUTPUT');
  return new Response(JSON.stringify(fail?{error:{code:10,message:'SYNTHETIC_RAW_BODY_NEVER_OUTPUT'}}:body),{status:fail?403:200,headers:{'Content-Type':'application/json'}});
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
  const args=['scripts/diagnostics/whatsapp-token-check.sh',kind==='revision'?'0'.repeat(40):revision,...extraArgs];
  const result=spawnSync('sh',args,{cwd:dir,env,encoding:'utf8',timeout:30000});assert.equal(result.error,undefined);assert.equal(result.status,0);assert.equal(result.stderr,'');
  assert.ok(!/SYNTHETIC_|Bearer|https:|12345|67890|synthetic-phone|26871846599183572|stack/.test(result.stdout),result.stdout);
  const output=JSON.parse(result.stdout);let calls=[];try{calls=readFileSync(join(dir,'calls'),'utf8').trim().split('\n');}catch{}
  assert.ok(calls.filter(x=>x==='DB_GET').length<=(authorizationFixture?2:1));for(const k of ['WABA_GET','ASSIGNMENT_GET','PHONE_GET'])assert.ok(calls.filter(x=>x===k).length<=1);assert.ok(calls.filter(x=>x==='META_GET').length<=1);
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
const reviewedArgs=['--expected-app','26871846599183572'];
test('explicit reviewed identity matches older app while runtime app remains different',()=>{
 const {output,calls}=run('reviewed-match',{},reviewedArgs);
 assert.equal(output.error,null);assert.equal(output.appIdMatchesExpected,true);assert.equal(output.tokenValid,true);
 assert.equal(output.messagingScopePresent,true);assert.equal(output.managementScopePresent,true);
 assert.equal(output.expiresAtAcceptable,true);assert.equal(output.dataAccessExpiresAtAcceptable,true);
 assert.deepEqual(calls,['DB_GET','META_GET']);
 assert.deepEqual(Object.keys(output).sort(),['stage','error','httpStatus','graphErrorCode','appIdMatchesExpected','tokenValid','messagingScopePresent','managementScopePresent','expiresAtAcceptable','dataAccessExpiresAtAcceptable'].sort());
});
for(const kind of ['valid','wrong-app','missing-app','numeric-app','missing-data','graph200','http403','malformed','timeout','decrypt','tenant','logging'])test(`reviewed comparison preserves fail-closed behavior: ${kind}`,()=>{
 const {output}=run(kind,{},reviewedArgs);
 const expected=kind==='valid'||kind==='wrong-app'||kind==='logging'?'APP_ID_MISMATCH':cases[kind];
 assert.equal(output.error,expected);if(['valid','wrong-app','logging'].includes(kind))assert.equal(output.appIdMatchesExpected,false);
});
for(const args of [['--expected-app','67890'],['--expected-app',''],['--expected-app','26871846599183572 '],['--other','26871846599183572'],['--expected-app'],['--expected-app','26871846599183572','extra']])test('arbitrary, malformed or extra expected identity arguments reject before IO: '+JSON.stringify(args.map((v,i)=>i===0?v:'redacted')),()=>{
 const {output,calls}=run('valid',{},args);assert.equal(output.error,'EXPECTED_APP_NOT_ALLOWLISTED');assert.deepEqual(calls,[]);
});
test('runtime-supplied diagnostic expected identity is not inherited or accepted',()=>{
 const {output}=run('valid',{ODIN_DIAGNOSTIC_EXPECTED_APP_ID:'26871846599183572'});
 assert.equal(output.error,null);assert.equal(output.appIdMatchesRuntime,true);assert.equal(output.appIdMatchesExpected,undefined);
});
test('reviewed option retains OFF and numeric runtime-app prerequisites',()=>{
 for(const overrides of [{ODINLINK_ASYNC_KNOWLEDGE_ADMISSION:'true'},{META_APP_ID:''}]){
  const {output,calls}=run('reviewed-match',overrides,reviewedArgs);assert.ok(['CONTROLS_NOT_OFF','APP_CONFIGURATION_INVALID'].includes(output.error));assert.deepEqual(calls,[]);
 }
});
const granularArgs=[...reviewedArgs,'--granular-scopes'];
const waba='123456789012345';
const scope=(target,management=false)=>({scope:management?'whatsapp_business_management':'whatsapp_business_messaging',...(target===undefined?{}:{target_ids:target})});
const granularCases=[
 ['matching strings',[scope([waba]),scope([waba],true)],{messagingEntryCount:1,managementEntryCount:1,messagingTargetIdsPresent:true,messagingTargetIdsArrays:true,messagingAnyWabaMatch:true,messagingAllWabaMatch:true,managementAnyWabaMatch:true,numericTargetIdsPresent:false,normalizedComparisonChangesResult:false}],
 ['explicit different targets',[scope(['999']),scope(['999'],true)],{messagingAnyWabaMatch:false,messagingAllWabaMatch:false,managementAnyWabaMatch:false,normalizedComparisonChangesResult:false}],
 ['missing target list',[scope(undefined)],{messagingTargetIdsPresent:false,messagingTargetIdsArrays:false,messagingAnyWabaMatch:false,messagingAllWabaMatch:false}],
 ['null target list',[scope(null)],{messagingTargetIdsPresent:true,messagingTargetIdsArrays:false,messagingAnyWabaMatch:false}],
 ['non-array target list',[scope({private:'SYNTHETIC_RAW_TARGET_NEVER_OUTPUT'})],{messagingTargetIdsPresent:true,messagingTargetIdsArrays:false}],
 ['empty target list',[scope([])],{messagingTargetIdsPresent:true,messagingTargetIdsArrays:true,messagingAnyWabaMatch:false}],
 ['multiple messaging entries, only one includes WABA',[scope([waba]),scope(['999'])],{messagingEntryCount:2,messagingAnyWabaMatch:true,messagingAllWabaMatch:false,normalizedMessagingAllWabaMatch:false}],
 ['management only references WABA',[scope(undefined),scope([waba],true)],{managementEntryCount:1,managementAnyWabaMatch:true,messagingAnyWabaMatch:false}],
 ['numeric exact-safe WABA',[scope([Number(waba)]),scope([Number(waba)],true)],{numericTargetIdsPresent:true,unsafeNumericTargetIdsPresent:false,messagingAnyWabaMatch:false,messagingAllWabaMatch:false,normalizedMessagingAnyWabaMatch:true,normalizedMessagingAllWabaMatch:true,normalizedManagementAnyWabaMatch:true,normalizedComparisonChangesResult:true}],
 ['safe numeric not equal',[scope([123])],{numericTargetIdsPresent:true,normalizedMessagingAnyWabaMatch:false,normalizedComparisonChangesResult:false}],
 ['unsafe numeric target',[scope([26871846599183572])],{numericTargetIdsPresent:true,unsafeNumericTargetIdsPresent:true,normalizedMessagingAnyWabaMatch:null,normalizedMessagingAllWabaMatch:null,normalizedComparisonChangesResult:null}],
 ['malformed numeric target',[scope([1.5])],{unsafeNumericTargetIdsPresent:true,normalizedMessagingAnyWabaMatch:null}],
 ['safe match overrides unrelated unsafe target',[scope([waba,26871846599183572])],{unsafeNumericTargetIdsPresent:true,normalizedMessagingAnyWabaMatch:true,normalizedMessagingAllWabaMatch:true,normalizedComparisonChangesResult:false}],
 ['no relevant granular entries',[],{messagingEntryCount:0,managementEntryCount:0,messagingAnyWabaMatch:null,messagingAllWabaMatch:null,messagingTargetIdsArrays:null,normalizedComparisonChangesResult:null}],
 ['management without messaging',[scope([waba],true)],{messagingEntryCount:0,managementAnyWabaMatch:true,messagingAllWabaMatch:null}],
];
for(const [name,scopes,expected]of granularCases)test('exact granular CLI: '+name,()=>{
 const {output,calls}=run('valid',{},granularArgs,{scopes});assert.equal(output.error,null);assert.equal(output.stage,'granular_scopes');assert.deepEqual(calls,['DB_GET','META_GET']);
 for(const [key,value]of Object.entries(expected))assert.equal(output[key],value,key);
 for(const forbidden of ['appIdMatchesExpected','tokenValid','appIdType','credentialRecovered','validJson','dataPresent','messagingScopePresent','expiresAtAcceptable'])assert.equal(output[forbidden],undefined);
 assert.ok(!JSON.stringify(output).includes(waba));
});
for(const [fixture,error]of [[{},'GRANULAR_SCOPES_MISSING'],[{scopes:null},'GRANULAR_SCOPES_INVALID'],[{scopes:{}},'GRANULAR_SCOPES_INVALID'],[{scopes:[null]},'GRANULAR_SCOPE_ENTRY_INVALID'],[{scopes:[{scope:123}]},'GRANULAR_SCOPE_ENTRY_INVALID'],[{wrongApp:true},'APP_ID_MISMATCH'],[{waba:'not-an-id'},'STORED_WABA_INVALID']])test('granular CLI sanitizes unknown/malformed shape: '+error,()=>{
 const {output,calls}=run('valid',{},granularArgs,fixture);assert.equal(output.error,error);assert.equal(calls.filter(x=>x==='META_GET').length,error==='STORED_WABA_INVALID'?0:1);assert.equal(output.messagingEntryCount,null);
});
for(const kind of ['graph200','http403','malformed','timeout','tenant','decrypt','logging','stdout'])test('granular CLI preserves security boundary: '+kind,()=>{
 const {output}=run(kind,{},granularArgs,{scopes:[scope([waba])]});assert.equal(output.error,kind==='logging'?null:cases[kind]);
});
test('granular mode requires explicit reviewed identity and exact option syntax before IO',()=>{
 for(const args of [['--granular-scopes'],['--expected-app','67890','--granular-scopes'],[...reviewedArgs,'--granular-scopes','extra'],[...reviewedArgs,'--granular-scopes=1']]){
  const {output,calls}=run('valid',{},args);assert.equal(output.error,'EXPECTED_APP_NOT_ALLOWLISTED');assert.deepEqual(calls,[]);
 }
});
test('inherited granular-mode environment cannot select or change output mode',()=>{
 const {output}=run('valid',{ODIN_DIAGNOSTIC_GRANULAR_SCOPES:'1'});assert.equal(output.error,null);assert.equal(output.messagingEntryCount,undefined);assert.equal(output.appIdMatchesRuntime,true);
});
const authorizationArgs=[...reviewedArgs,'--waba-authorization'];
test('exact authorization entry proves current principal/assignment/MANAGE/phone through shared onboarding reads, omitted targets alone grant nothing',()=>{
 const {output,calls}=run('valid',{},authorizationArgs,undefined,{omittedTargets:true});assert.equal(output.error,null);
 assert.deepEqual(calls,['DB_GET','META_GET','WABA_GET','ASSIGNMENT_GET','PHONE_GET','DB_GET']);
 assert.ok(Object.entries(output).every(([k,v])=>k==='error'?v===null:v===true));
 assert.equal(output.authorizationEvidenceVerified,true);assert.equal(output.connectionCurrent,true);
 assert.deepEqual(Object.keys(output).sort(),['error','tenantScoped','appIdentityVerified','tokenValid','expiryValid','messagingScopePresent','managementScopePresent','explicitGranularExclusionAbsent','principalIdentified','wabaIdentityVerified','ownerIdentityVerified','principalAssignedToWaba','managementTaskPresent','phoneBelongsToWaba','connectionCurrent','authorizationEvidenceVerified'].sort());
});
const authorizationCases=[
 [{principalMissing:true},'PRINCIPAL_UNVERIFIED'],[{principalNumeric:true},'PRINCIPAL_UNVERIFIED'],
 [{managementScopeMissing:true},'MANAGEMENT_SCOPE_MISSING'],[{wabaError:true},'WABA_READ_UNVERIFIED'],
 [{wabaMismatch:true},'WABA_IDENTITY_UNVERIFIED'],[{ownerMissing:true},'WABA_OWNER_UNVERIFIED'],
 [{assignmentError:true},'ASSIGNMENT_READ_UNVERIFIED'],[{assignments:[]},'PRINCIPAL_ASSIGNMENT_MISSING'],
 [{assignments:[],assignmentNext:true},'ASSIGNMENT_PAGINATION_UNVERIFIED'],
 [{assignments:[{id:'987654321',tasks:['MANAGE']}],assignmentNext:true},'PRINCIPAL_ASSIGNMENT_AMBIGUOUS'],
 [{assignments:[{id:'987654321',tasks:['MANAGE']},{id:'987654321',tasks:['MANAGE']}]},'PRINCIPAL_ASSIGNMENT_AMBIGUOUS'],
 [{assignments:[{id:'987654321'}]},'MANAGEMENT_TASK_UNVERIFIED'],
 [{assignments:[{id:'987654321',tasks:['DEVELOP']}]},'MANAGEMENT_TASK_MISSING'],
 [{assignments:[{id:'different-principal',tasks:['MANAGE']}]},'ASSIGNMENT_READ_UNVERIFIED'],
 [{assignments:[{id:'111',tasks:['MANAGE']}]},'PRINCIPAL_ASSIGNMENT_MISSING'],
 [{phoneError:true},'PHONE_MEMBERSHIP_READ_UNVERIFIED'],[{phones:[]},'PHONE_MEMBERSHIP_MISSING'],
 [{phones:[],phoneNext:true},'PHONE_MEMBERSHIP_PAGINATION_UNVERIFIED'],
 [{phones:[{id:'123456789012346'},{id:'123456789012346'}]},'PHONE_MEMBERSHIP_AMBIGUOUS'],
 [{changedToken:true},'CONNECTION_CHANGED'],[{changedPhone:true},'CONNECTION_CHANGED'],[{changedWaba:true},'CONNECTION_CHANGED'],
 [{changedTenant:true},'TENANT_SCOPE_REJECTED'],[{currentMissing:true},'TENANT_CONNECTION_NOT_FOUND'],[{currentReadError:true},'TENANT_LOOKUP_FAILED'],
 [{explicitExclusion:true},'GRANULAR_ASSET_EXCLUSION'],[{malformedTargets:true},'GRANULAR_TARGETS_INVALID'],
 [{assetTimeout:true},'WABA_READ_UNVERIFIED'],[{assetMalformed:true},'WABA_READ_UNVERIFIED'],[{assetOversize:true},'RESPONSE_TOO_LARGE'],
];
for(const [fixture,error]of authorizationCases)test('exact authorization entry fails closed: '+Object.keys(fixture).join(','),()=>{
 const {output}=run('valid',{},authorizationArgs,undefined,fixture);assert.equal(output.error,error);assert.notEqual(output.authorizationEvidenceVerified,true);
 assert.ok(Object.entries(output).every(([k,v])=>k==='error'?typeof v==='string':typeof v==='boolean'||v===null));
 if(error==='PRINCIPAL_ASSIGNMENT_MISSING')assert.equal(output.principalAssignedToWaba,false);
 if(error==='ASSIGNMENT_PAGINATION_UNVERIFIED')assert.equal(output.principalAssignedToWaba,null);
 if(error==='PHONE_MEMBERSHIP_MISSING')assert.equal(output.phoneBelongsToWaba,false);
});
test('authorization option cannot be selected by environment, combined with granular mode or an arbitrary app',()=>{
 const legacy=run('valid',{ODIN_DIAGNOSTIC_WABA_AUTHORIZATION:'1'});assert.equal(legacy.output.error,null);assert.equal(legacy.output.authorizationEvidenceVerified,undefined);
 for(const args of [['--waba-authorization'],['--expected-app','67890','--waba-authorization'],[...authorizationArgs,'--granular-scopes']]){
  const {output,calls}=run('valid',{},args);assert.equal(output.error,'EXPECTED_APP_NOT_ALLOWLISTED');assert.deepEqual(calls,[]);
 }
});
test('authorization prerequisites, tenant boundaries and output filtering remain active',()=>{
 for(const [kind,error]of [['graph200','GRAPH_ERROR'],['malformed','INVALID_JSON'],['decrypt','CREDENTIAL_RECOVERY_FAILED'],['tenant','TENANT_SCOPE_REJECTED'],['stdout','CHILD_OUTPUT_REJECTED']]){
  const {output}=run(kind,{},authorizationArgs,undefined,{});assert.equal(output.error,error);
 }
 for(const flag of ['ODINLINK_ASYNC_KNOWLEDGE_ADMISSION','ODINLINK_ASYNC_KNOWLEDGE_PROCESSING','ODINLINK_ASYNC_KNOWLEDGE_DELIVERY','ODINLINK_SMART_WAITING']){
  const {output,calls}=run('valid',{[flag]:'true'},authorizationArgs,undefined,{});assert.equal(output.error,'CONTROLS_NOT_OFF');assert.deepEqual(calls,[]);
 }
});
