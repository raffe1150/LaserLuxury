import { runOptionalDiagnostic } from '../ai/business-information-timing';
import type { ProviderRejection } from './knowledge-preflight-diagnostic';
import type { ResolvedChannelConnection } from '../channels/connections/contracts';
import type { DeliveryOutcome, KnowledgeTask, KnowledgeScope } from './knowledge-lifecycle';
import { NativeKnowledgeBindings, validNativeRecipient } from './native-knowledge-binding';

const VERSION='v25.0'; // Match existing native send helpers, not a provider-version migration.
const messageId=(v:unknown):v is string=>typeof v==='string' && /^[A-Za-z0-9:_.=+/-]{1,256}$/u.test(v);
const unsent=(retryable=false):DeliveryOutcome=>({kind:'DEFINITIVELY_UNSENT',retryable});
const ambiguous=():DeliveryOutcome=>({kind:'AMBIGUOUS'});
async function jsonRead(fetcher:typeof fetch,url:URL,token:string,signal:AbortSignal):Promise<any|null>{
  const response=await fetcher(url,{method:'GET',redirect:'error',headers:{Authorization:`Bearer ${token}`},signal});
  if(!response.ok)return null;const data=await response.json().catch(()=>null);return data?.error?null:data;
}
/** Fresh, read-only provider capability checks. No AI call or send. Unknown
 * response shapes/unsupported account products fail closed. No permission cache.
 */
export async function nativeProviderEligible(bindings:NativeKnowledgeBindings,task:KnowledgeTask,fetcher:typeof fetch=fetch,
  signal:AbortSignal=AbortSignal.timeout(5000), expected?:ResolvedChannelConnection, rejected?:(reason:ProviderRejection)=>unknown):Promise<boolean>{
  const reject=(reason:ProviderRejection):false=>{runOptionalDiagnostic(()=>rejected?.(reason));return false;};
  const resolved=await bindings.resolve(task.scope);if(!resolved)return reject('BINDING_OR_CONNECTION');
  const {binding:b,connection:c}=resolved;
  if(expected && (expected.id!==c.id || expected.credential.accessToken!==c.credential.accessToken || expected.providerAccountId!==c.providerAccountId))return reject('CONNECTION_CHANGED');
  const token=c.credential.accessToken;
  const eventAt=await bindings.eventTime(task);if(eventAt===null || eventAt>Date.now())return reject('EVENT_TIME');
  if(b.channel==='telegram'){
    // Ordinary private bot conversations only; business connections/groups need
    // their own rights/identity contract and are not silently treated as bots.
    if(c.providerConnectionId)return reject('TELEGRAM_CONNECTION_MODE');
    const api=(method:string,params:Record<string,string>={})=>{const u=new URL(`https://api.telegram.org/bot${token}/${method}`);for(const[k,v]of Object.entries(params))u.searchParams.set(k,v);return u;};
    const me=await jsonRead(fetcher,api('getMe'),token,signal);
    if(me?.ok!==true || String(me.result?.id)!==b.account || me.result?.is_bot!==true)return reject('TELEGRAM_BOT_IDENTITY');
    const chat=await jsonRead(fetcher,api('getChat',{chat_id:b.recipient}),token,signal);
    if(chat?.ok!==true || String(chat.result?.id)!==b.recipient || chat.result?.type!=='private')return reject('TELEGRAM_PRIVATE_CHAT');
    const member=await jsonRead(fetcher,api('getChatMember',{chat_id:b.recipient,user_id:b.account}),token,signal);
    return member?.ok===true && String(member.result?.user?.id)===b.account && ['member','administrator','creator'].includes(member.result?.status) || reject('TELEGRAM_MEMBERSHIP');
  }
  if(Date.now()-eventAt>=86400000)return reject('RESPONSE_WINDOW'); // Only standard customer-response windows; no tags/templates/extensions.
  const host=b.channel==='instagram'?'graph.instagram.com':'graph.facebook.com';
  const url=(path:string,params:Record<string,string>={})=>{const u=new URL(`https://${host}/${VERSION}/${path}`);for(const[k,v]of Object.entries(params))u.searchParams.set(k,v);return u;};
  if(b.channel==='whatsapp'){
    if(!c.providerConnectionId || !c.grantedScopes.includes('whatsapp_business_messaging'))return reject('WHATSAPP_CONNECTION_OR_SCOPE');
    // Trusted server configuration only; never infer an allowed app from a token.
    // No fallback to the shared OAuth/webhook app identity.
    const expectedApp=process.env.META_WHATSAPP_APP_ID||'';
    if(!/^[1-9][0-9]{0,31}$/u.test(expectedApp))return reject('WHATSAPP_APP_CONFIGURATION');
    const debug=await jsonRead(fetcher,url('debug_token',{input_token:token}),token,signal);const d=debug?.data;
    if(d?.app_id!==expectedApp)return reject('WHATSAPP_TOKEN_APP');
    if(d?.is_valid!==true)return reject('WHATSAPP_TOKEN_VALIDITY');
    if(!Array.isArray(d.scopes) || !d.scopes.includes('whatsapp_business_messaging'))return reject('WHATSAPP_TOKEN_SCOPE');
    if(['expires_at','data_access_expires_at'].some(k=>typeof d[k]!=='number' || d[k]!==0 && d[k]*1000<=Date.now()))return reject('WHATSAPP_TOKEN_EXPIRY');
    if(Array.isArray(d.granular_scopes) && d.granular_scopes.some((g:any)=>g.scope==='whatsapp_business_messaging' &&
      (!Array.isArray(g.target_ids) || !g.target_ids.includes(c.providerConnectionId))))return reject('WHATSAPP_GRANULAR_SCOPE');
    const phones=await jsonRead(fetcher,url(`${encodeURIComponent(c.providerConnectionId)}/phone_numbers`,{fields:'id',limit:'100'}),token,signal);
    if(!Array.isArray(phones?.data) || !phones.data.some((p:any)=>p.id===b.account))return reject('WHATSAPP_PHONE_MEMBERSHIP');
    const phone=await jsonRead(fetcher,url(b.account,{fields:'id,health_status'}),token,signal);
    return phone?.id===b.account && phone.health_status?.can_send_message==='AVAILABLE' && Date.now()-eventAt<86400000 || reject('WHATSAPP_PHONE_HEALTH_OR_WINDOW');
  }
  const required=b.channel==='instagram'?'instagram_business_manage_messages':'pages_messaging';
  if(!c.grantedScopes.includes(required))return reject('META_SAVED_SCOPE');
  const rawIdentity=await jsonRead(fetcher,url('me',{fields:b.channel==='instagram'?'user_id':'id'}),token,signal);
  const identity=Array.isArray(rawIdentity?.data)?rawIdentity.data[0]:rawIdentity;
  if((b.channel==='instagram'?(identity?.user_id||identity?.id):identity?.id)!==b.account)return reject('META_IDENTITY');
  // Reading conversations requires current messaging access, rather than only
  // trusting the scopes saved during onboarding. Read participant IDs only.
  const conversations=await jsonRead(fetcher,url(`${b.account}/conversations`,{platform:b.channel==='instagram'?'instagram':'messenger',
    user_id:b.recipient,fields:b.channel==='messenger'?'participants,can_reply':'participants',limit:'20'}),token,signal);
  return Array.isArray(conversations?.data) && conversations.data.some((c:any)=>{
    const ids=c.participants?.data?.map((p:any)=>p.id);
    return Array.isArray(ids) && ids.includes(b.recipient) && ids.includes(b.account) && (b.channel!=='messenger' || c.can_reply===true);
  }) && Date.now()-eventAt<86400000 || reject('META_CONVERSATION_OR_WINDOW');
}

/** Exactly one raw provider POST; never call foreground boolean helpers. No
 * logging of URLs/tokens/recipients/body/errors. Network/parse/5xx ambiguity is
 * quarantined by the lifecycle; an HTTP 200 alone does not establish acceptance.
 */
export async function sendNativeKnowledge(c:ResolvedChannelConnection,recipient:string,text:string,signal:AbortSignal,fetcher:typeof fetch=fetch):Promise<DeliveryOutcome>{
  if(signal.aborted || !validNativeRecipient(c.provider,recipient) || !text.trim() || text.length>6000 || !c.credential.accessToken)return unsent();
  const token=c.credential.accessToken;let url:string;let body:any;
  if(c.provider==='telegram'){url=`https://api.telegram.org/bot${token}/sendMessage`;body={chat_id:recipient,text};}
  else if(c.provider==='whatsapp'){url=`https://graph.facebook.com/${VERSION}/${c.providerAccountId}/messages`;
    body={messaging_product:'whatsapp',recipient_type:'individual',to:recipient,type:'text',text:{preview_url:false,body:text}};}
  else {url=`https://${c.provider==='instagram'?'graph.instagram.com':'graph.facebook.com'}/${VERSION}/${c.provider==='instagram'?'me':c.providerAccountId}/messages`;
    body={recipient:{id:recipient},...(c.provider==='messenger'?{messaging_type:'RESPONSE'}:{}),message:{text}};}
  try{
    const response=await fetcher(url,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal});
    const data:any=await response.json().catch(()=>null);
    if(response.ok && !data?.error){
      if(c.provider==='telegram' && data?.ok===true && Number.isSafeInteger(data.result?.message_id) && data.result.message_id>0 && String(data.result.chat?.id)===recipient)
        return {kind:'API_ACCEPTED',providerMessageId:String(data.result.message_id)};
      if(c.provider==='whatsapp' && messageId(data?.messages?.[0]?.id) && /^wamid\./u.test(data.messages[0].id) && data.contacts?.[0]?.wa_id===recipient)
        return {kind:'API_ACCEPTED',providerMessageId:data.messages[0].id};
      if(['instagram','messenger'].includes(c.provider) && messageId(data?.message_id) && data.recipient_id===recipient)
        return {kind:'API_ACCEPTED',providerMessageId:data.message_id};
    }
    const code=c.provider==='telegram'?data?.error_code:data?.error?.code;
    if(response.status>=400 && response.status<500 && response.status!==408 && Number.isInteger(code))return unsent(response.status===429);
    if(c.provider==='telegram' && data?.ok===false && Number.isInteger(code) && code>=400 && code<500 && code!==408)return unsent(code===429);
    return ambiguous();
  }catch{return ambiguous();}
}
