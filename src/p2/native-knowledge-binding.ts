import { knowledgeDatabaseRead, knowledgeOperation } from './knowledge-operation';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createP2ConversationKey } from './conversation-key';
import { snapshot, type KnowledgeScope, type KnowledgeTask } from './knowledge-lifecycle';
import type { KnowledgeDatabase } from './supabase-knowledge-lifecycle-repository';
import type { ResolvedChannelConnection } from '../channels/connections/contracts';
import { resolveConnectionForBusiness } from '../channels/connections/repository';

export type NativeConnectionResolver = (businessId: number, channel: KnowledgeScope['channel']) => Promise<ResolvedChannelConnection | null>;
type Binding = Readonly<{ version: 1; businessId: number; channel: KnowledgeScope['channel']; account: string;
  connectionId: string; recipient: string; mac: string }>;
const NS = 'knowledge_native_recipient_v1';
const digits = (v: unknown) => typeof v === 'string' && /^[0-9]{1,30}$/u.test(v);
export function validNativeRecipient(channel: KnowledgeScope['channel'], recipient: unknown): recipient is string {
  return digits(recipient) && (channel !== 'whatsapp' || /^[0-9]{6,20}$/u.test(recipient as string)) &&
    (channel !== 'telegram' || /^[1-9][0-9]*$/u.test(recipient as string));
}
/** Current credential recovery. Meta requires a normalized connection; legacy
 * global/account fallbacks are intentionally not background-delivery authority.
 * Telegram's existing tenant-owned business bot token is an authoritative store.
 */
export function databaseNativeConnections(db: KnowledgeDatabase): NativeConnectionResolver {
  return async (businessId, channel) => {
    const c = await knowledgeOperation(()=>resolveConnectionForBusiness(db as any, businessId, channel));
    if (c || channel !== 'telegram') return c;
    const { data, error } = await knowledgeDatabaseRead(db.from('businesses').select('id,telegram_bot_token').eq('id', businessId).maybeSingle());
    if (error) throw new Error('knowledge_connection_read_failed');
    const token = data?.telegram_bot_token;
    if (Number(data?.id) !== businessId || typeof token !== 'string' || !/^[1-9][0-9]*:[A-Za-z0-9_-]+$/u.test(token)) return null;
    const botId = token.split(':')[0];
    return { id: `telegram-business:${businessId}:${botId}`, businessId, provider: channel, providerAccountId: botId,
      providerConnectionId: null, tokenExpiresAt: null, grantedScopes: [], status: 'connected', connectedAt: null,
      lastVerifiedAt: null, reconnectRequired: false, displayName: null, source: 'legacy_manual', credential: { accessToken: token }, metadata: {} };
  };
}
export class NativeKnowledgeBindings {
  constructor(private readonly db: KnowledgeDatabase, private readonly secret: string, readonly connections: NativeConnectionResolver) {
    if (Buffer.byteLength(secret, 'utf8') < 32) throw new Error('knowledge_binding_secret_required');
  }
  private frame(b: Omit<Binding,'mac'>) { return JSON.stringify([b.version,b.businessId,b.channel,b.account,b.connectionId,b.recipient]); }
  private signature(b: Omit<Binding,'mac'>) { return createHmac('sha256',this.secret).update(this.frame(b)).digest('hex'); }
  private key(b: Binding) { return createP2ConversationKey({secret:this.secret,businessId:b.businessId,channel:b.channel,
    sessionId:JSON.stringify([b.account,b.connectionId,b.recipient])}); }
  private valid(b: any): b is Binding {
    if (!b || Object.keys(b).sort().join(',')!=='account,businessId,channel,connectionId,mac,recipient,version' || b.version !== 1 || !Number.isSafeInteger(b.businessId) || b.businessId <= 0 ||
      !['whatsapp','telegram','instagram','messenger'].includes(b.channel) || !digits(b.account) ||
      typeof b.connectionId !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/u.test(b.connectionId) ||
      !validNativeRecipient(b.channel,b.recipient) || typeof b.mac !== 'string' || !/^[a-f0-9]{64}$/u.test(b.mac)) return false;
    return timingSafeEqual(Buffer.from(b.mac,'hex'),Buffer.from(this.signature(b),'hex'));
  }
  private async result(query: PromiseLike<any>) { const {data,error}=await knowledgeDatabaseRead(query);if(error)throw new Error('knowledge_binding_storage_failed');return data; }
  async ensure(businessId:number,channel:KnowledgeScope['channel'],account:string,recipient:string):Promise<KnowledgeScope> {
    const c=await this.connections(businessId,channel);
    if (!c || c.businessId !== businessId || c.provider !== channel || c.providerAccountId !== account ||
      c.status !== 'connected' || c.reconnectRequired || !validNativeRecipient(channel,recipient)) throw new Error('knowledge_native_binding_refused');
    const plain={version:1 as const,businessId,channel,account,connectionId:c.id,recipient};const b:Binding={...plain,mac:this.signature(plain)};
    if(!this.valid(b))throw new Error('knowledge_native_binding_refused');
    const key=this.key(b);
    // ON CONFLICT DO NOTHING: never overwrite recipients or v2 ordering metadata.
    await this.result(this.db.from('odin_conversations').upsert({business_id:businessId,conversation_key:key,aggregate_meta:{[NS]:b}},
      {onConflict:'business_id,conversation_key',ignoreDuplicates:true}));
    const row=await this.result(this.db.from('odin_conversations').select('id,business_id,conversation_key,aggregate_meta')
      .eq('business_id',businessId).eq('conversation_key',key).maybeSingle());
    const stored=row?.aggregate_meta?.[NS];
    if(!row || !this.valid(stored) || this.frame(stored)!==this.frame(b) || row.conversation_key!==key)throw new Error('knowledge_binding_conflict');
    return snapshot({businessId,channel,providerAccount:account,conversationId:row.id});
  }
  private async stored(scope:KnowledgeScope):Promise<Readonly<{binding:Binding;key:string}>|null> {
    const row=await this.result(this.db.from('odin_conversations').select('business_id,conversation_key,aggregate_meta')
      .eq('business_id',scope.businessId).eq('id',scope.conversationId).maybeSingle());
    const b=row?.aggregate_meta?.[NS];
    if(!this.valid(b) || b.businessId!==scope.businessId || b.channel!==scope.channel || b.account!==scope.providerAccount || row.conversation_key!==this.key(b))return null;
    return {binding:snapshot(b),key:this.key(b)};
  }
  async resolve(scope:KnowledgeScope):Promise<Readonly<{binding:Binding;connection:ResolvedChannelConnection;key:string}>|null> {
    const stored=await this.stored(scope);if(!stored)return null;const b=stored.binding;
    const c=await knowledgeOperation(()=>this.connections(scope.businessId,scope.channel));
    if(!c || c.businessId!==b.businessId || c.provider!==b.channel || c.id!==b.connectionId || c.providerAccountId!==b.account ||
      c.status!=='connected' || c.reconnectRequired || !c.credential?.accessToken ||
      c.tokenExpiresAt!==null && (!Number.isFinite(Date.parse(c.tokenExpiresAt)) || Date.parse(c.tokenExpiresAt)<=Date.now()))return null;
    return {binding:snapshot(b),connection:snapshot(c),key:this.key(b)};
  }
  async canonicalKey(scope:KnowledgeScope):Promise<string> { return (await this.stored(scope))?.key || ''; }
  async eventTime(task:KnowledgeTask):Promise<number|null> {
    const row=await this.result(this.db.from('odin_inbox').select('payload,knowledge_sequence')
      .eq('business_id',task.scope.businessId).eq('conversation_id',task.scope.conversationId).eq('channel',task.scope.channel)
      .eq('provider_scope',task.scope.providerAccount).eq('provider_event_id',task.eventId).eq('knowledge_turn_id',task.turnId).maybeSingle());
    const proof=row?.payload?.native_order_v2;
    return proof?.disposition==='ACCEPTED' && Number(row.knowledge_sequence)===task.sequence && Number.isSafeInteger(proof.order?.atMs) ? proof.order.atMs : null;
  }
}
