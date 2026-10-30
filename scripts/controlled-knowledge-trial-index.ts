/** Explicit operator job only. No automatic upload/index worker or policy funding.
 * Requires a separately owner-approved, exact source-revision/request-hash case.
 */
import {pathToFileURL} from 'node:url';
import {createClient} from '@supabase/supabase-js';
import {getBackendSupabaseConfiguration} from '../src/auth/backend-supabase';
import {installControlledTrial,runControlledSourceIndex,controlledTrialSource,controlledTrialSignal,trialModeOn} from '../src/runtime/controlled-knowledge-trial';
import {SourceIndexCoordinator,SupabaseSourceIndexRepository} from '../src/knowledge/documents/indexing';
import {embedWithOpenAi} from '../src/ai/providers/openai';
import {OPENAI_KNOWLEDGE_EMBEDDING_IDENTITY} from '../src/knowledge/embedding-backfill';
export async function controlledIndexCase(caseId:string):Promise<unknown>{
 if(!trialModeOn()||!caseId||caseId.length>200)throw Error('controlled_index_explicit_policy_required');
 const {url,serviceRoleKey}=getBackendSupabaseConfiguration();
 const db=createClient(url,serviceRoleKey,{auth:{persistSession:false,autoRefreshToken:false}});
 await installControlledTrial(db);
 return runControlledSourceIndex(caseId,async()=>{
  const source=controlledTrialSource(),trialSignal=controlledTrialSignal();if(!source||!trialSignal)throw Error('controlled_index_source_required');
  const stop=new AbortController();
  const abort=()=>stop.abort();process.once('SIGTERM',abort);process.once('SIGINT',abort);
  const coordinator=new SourceIndexCoordinator(new SupabaseSourceIndexRepository(db),{embedDocuments:embedWithOpenAi},OPENAI_KNOWLEDGE_EMBEDDING_IDENTITY,
   {allowedBusinessIds:[source.businessId],maxSources:1,maxRequests:1,maxInputChars:266000,maxInputBytes:266000},AbortSignal.any([stop.signal,trialSignal]));
  try{return await coordinator.indexSource({businessId:source.businessId,sourceId:source.sourceId});}
  finally{coordinator.stop();process.removeListener('SIGTERM',abort);process.removeListener('SIGINT',abort);}
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==4||process.argv[2]!=='--execute-approved-case')throw Error('controlled_index_explicit_case_required');
 controlledIndexCase(process.argv[3]).then(out=>console.info('[ControlledIndex]',out),()=>{console.error('[ControlledIndex]',{status:'blocked'});process.exitCode=1;});
}
