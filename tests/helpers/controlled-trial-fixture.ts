/** Owned local DB, retained genuine vectors; policies/identities/receipts synthetic. */
import {readFileSync} from 'node:fs';
import {prepareDatabase} from '../../docs/validation/shared-core-2026-10-22/semantic-only-nibble-diagnostic-20261025/diagnostic';
import {indexSqlLiteral as lit} from './disposable-source-index-db';
import {installControlledTrial,trialSha} from '../../src/runtime/controlled-knowledge-trial';
import {installConfiguredKnowledgeBudgetOwner} from '../../src/ai/durable-knowledge-budget-owner';
export async function trialFixture(){
 const p=await prepareDatabase({});
 p.db.sql(readFileSync('supabase/migrations/20261029070636_durable_ai_monetary_owner.sql','utf8'));
 p.db.sql(`alter table public.businesses add column telegram_bot_token text;
 update public.businesses set telegram_bot_token='123456:synthetic-offline' where id=77;
 create table public.channel_connections(business_id bigint,provider text,provider_account_id text,status text,reconnect_required boolean,token_expires_at timestamptz);
 insert into public.channel_connections values(77,'whatsapp','10001','connected',false,null),(77,'instagram','30001','connected',false,null),(77,'messenger','40001','connected',false,null);`);
 p.db.sql(readFileSync('supabase/migrations/20261029082649_controlled_knowledge_trial_safeguards.sql','utf8'));
 return p;
}
export type TrialFixture=Awaited<ReturnType<typeof trialFixture>>;
export const identities={telegram:'123456',whatsapp:'10001',instagram:'30001',messenger:'40001'} as const;
export async function seedTrial(p:TrialFixture,question='May visitors nibble before being called?',channel:keyof typeof identities='telegram',recipient='46700000001'){
 p.db.sql(`truncate ai_money.events,ai_money.counters,ai_money.reservations,ai_money.trial_cases,ai_money.trial_identities,ai_money.trials,ai_money.entitlements,ai_money.plans,ai_money.periods,ai_money.operators;
 insert into ai_money.operators values('local-trial','local-owner','OFFLINE_SYNTHETIC_NOT_APPROVED','proj_trial_local',
 'openai-sol-standard-30m-2026-10-28','openai-standard-nonregional-30m-v1',true,true,now()+interval '1 day',1000000000,1000000000,150000000,350000000,8000,true,'controlled-trial-standard-20261029');
 insert into ai_money.periods values('local-trial','period',now()-interval '1 day',now()+interval '1 day');
 insert into ai_money.entitlements values('local-trial',77,'period','trial','r1','OFFLINE_SYNTHETIC_NOT_APPROVED','active',now()-interval '1 day',now()+interval '1 day',null,null,500000000);
 insert into ai_money.trials values('local-test','local-trial',77,'OFFLINE_SYNTHETIC_NOT_APPROVED',true,now()-interval '1 day',now()+interval '1 day',10,10);`);
 const readiness=JSON.parse(p.db.sql(`select public.knowledge_index_readiness_v1(77,'{"provider":"openai","model":"text-embedding-3-small","dimensions":768,"version":1}'::jsonb,1);`));
 if(!readiness.complete||readiness.compatible_chunk_count!==6)throw Error('fixture_not_ready');
 p.db.sql(`insert into ai_money.trial_identities values('local-test',${lit(channel)},${lit(identities[channel])},${lit(recipient)},${lit(recipient)},true);
 insert into ai_money.trial_cases(trial_id,id,kind,enabled,human_approval_ref,channel,account,sender,recipient,question_sha256,inventory_token,expected_chunks,stage_caps)
 values('local-test','case','knowledge',true,'OFFLINE_SYNTHETIC_NOT_APPROVED',${lit(channel)},${lit(identities[channel])},${lit(recipient)},${lit(recipient)},${lit(trialSha(question))},${lit(readiness.inventory_token)},6,'{"language":12000000,"query_embedding":100000,"extraction":150000000,"verification":150000000}');`);
 Object.assign(process.env,{ODINLINK_CONTROLLED_KNOWLEDGE_TRIAL:'controlled-knowledge-v1',ODINLINK_CONTROLLED_KNOWLEDGE_TRIAL_ID:'local-test',
  ODINLINK_AI_MONEY_ACCOUNT:'local-trial',ODINLINK_AI_MONEY_APPROVAL:'OFFLINE_SYNTHETIC_NOT_APPROVED',AI_PROVIDER:'openai',OPENAI_MODEL:'gpt-5.6-luna',
  ODINLINK_KNOWLEDGE_MODEL_PROFILE:'sol-low-v1',ODINLINK_KNOWLEDGE_SOL_TENANT_IDS:'77',ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL:'v2',ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL:'v2',
  ODINLINK_EVIDENCE_FIRST_KNOWLEDGE:'true',ODINLINK_KNOWLEDGE_TIMING_POLICY:'accuracy-first-v1',ODINLINK_GROUNDED_NATURAL_RESPONSES:'false',
  ODINLINK_ASYNC_KNOWLEDGE_ADMISSION:'false',ODINLINK_ASYNC_KNOWLEDGE_PROCESSING:'false',ODINLINK_ASYNC_KNOWLEDGE_DELIVERY:'false'});
 await installConfiguredKnowledgeBudgetOwner(p.db.client);await installControlledTrial(p.db.client);
 return readiness;
}
