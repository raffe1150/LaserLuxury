/** Controlled embedding-only diagnostic; never contacts a customer channel. */
import {readFileSync,writeFileSync} from 'node:fs';
import {parse} from 'dotenv';
import {incidentFlags} from '../tests/helpers/p0-incident-knowledge';
import {sharedCorpus,sharedQuestions} from '../tests/helpers/shared-core-incident';
import {normalizeConversationText} from '../src/ai/booking-intelligence';
incidentFlags();
const key=parse(readFileSync(process.env.ODINLINK_P0_KEY_FILE!)).OPENAI_API_KEY;
if(!key)throw new Error('Credential file unavailable');process.env.OPENAI_API_KEY=key;
const realFetch=globalThis.fetch;let corpusVectors:number[][]=[],latestQuery:number[]=[];
globalThis.fetch=async(input,options)=>{
 const url=new URL(String(input));if(url.origin!=='https://api.openai.com'||url.pathname!=='/v1/embeddings')throw new Error('Forbidden diagnostic network');
 const body=JSON.parse(String(options?.body)),result=await realFetch(input,options),payload=await result.clone().json();
 const vectors=payload.data?.sort((a:any,b:any)=>a.index-b.index).map((e:any)=>e.embedding)||[];
 if(body.input.length>1)corpusVectors=vectors;else latestQuery=vectors[0]||[];
 return result;
};
const {service,cleanup}=await sharedCorpus(true);const cases=[];
try{
 for(const [index,text]of sharedQuestions.fa.entries()){
  const matches=await service.semanticSearchQueries(77,[normalizeConversationText(text)],5);
  const scores=corpusVectors.map(v=>v.reduce((s,x,i)=>s+x*latestQuery[i],0)/(Math.hypot(...v)*Math.hypot(...latestQuery)));
  cases.push({questionIndex:index,corpusChunks:corpusVectors.length,maximumCosine:Math.max(...scores),threshold:0.55,returnedMatches:matches.length});
 }
 writeFileSync('docs/validation/shared-core-2026-10-22/real-persian-semantic-scores.json',JSON.stringify({provider:'real OpenAI embeddings',cases},null,2));
 console.log(JSON.stringify(cases));
}finally{globalThis.fetch=realFetch;cleanup();}
