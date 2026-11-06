import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash,createHmac,randomBytes} from 'node:crypto';
import {constants,lstatSync,mkdtempSync,openSync,writeFileSync,closeSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import type {Evidence} from './business-information-answer-plan';
import type {NumericalConstraintAssessment} from './numerical-constraints';

export const LATE_ARRIVAL_DIAGNOSTIC_QUESTION='Hola, creo que llegaré unos 20 minutos tarde a mi cita. ¿La cancelan automáticamente o todavía puedo acudir?';
type Scope={businessId?:number;question:string;language:string};
type Candidate={id:string;text:string;subject:string;predicate:string;value:string;scope:string;qualifiers:string[];
 modality:string;negation:boolean;evidenceRefs:readonly {evidenceId:string;sourceId:string;chunkId:string;version:string;exactQuote:string}[]};
type Session={directory:string;key:Buffer;records:unknown[];closed?:boolean};
const sessions=new AsyncLocalStorage<Session>();
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const permitted=new Set(`
      segun la informacion ficticia de prueba test si preves llegar tarde deberias contactar al estudio cuanto antes por tu su
      el canal habitual con mas de minutos minuto retraso puede necesitar evaluar nuevo visita realizarse lo previsto no se cancela
      automaticamente personal debe primero situacion cita citas reserva cancelacion retrasos puntualidad los las del para una un en y o es
      esta estan sera ser hay requiere requieren evaluacion valoracion contactar contacto pronto posible automaticamente cancelada cancelado anulada anulado anula acudir
      todavia puedes debe debes que te por favor caso superar supera superan excede exceden superior despues retrasarse demoras demora cliente
      clientes aviso avisar normalmente siempre nunca solo sin como acuerdo llegada politica condiciones recomendacion recomienda recomendado recomienda necesario necesario obligacion
      obligatorio requisito limite umbral ficticio ficticios ficticias datos admotion studio customer visit arrival lateness staff automatic cancellation delay appointment studio
      policy fictional test threshold more than minutes minute assessment contact prompt recommended descriptive required permitted prohibited states requires recommendation condition
      first usual communication channel reassessment planned visit not cancelled may need assess situation none documented visitor delayed scope a unos
      unas sus tus mi mis le este estos estas documento documentos proporcionada proporcionadas conforme acuerdo hipotetica hipotetico exclusiva exclusivamente pruebas
      reales real implica implican significa significan automatico automatica automaticas automaticos llego llegas llega llegan llegues llegara llegare llegamos podra podria
      podrias debera deberias deberan deberias hace falta estaba prevista previsto nueva nuevas esto estos nuestra nuestro nuestros nuestras valorar valorar
      valorara valorar valoracion viabilidad suficiente confirmado confirmada confirmacion garantiza garantizar garantizado garantizada quince veinte diez treinta cuarenta horas regla reglas
      politica politicas terminos habitual habituales plazo plazos recomendado recomendada comunicarse comunicar informa informar notificar antelacion conditional late arrive automatically cancel
      rule must should would could possible actual document content all information and or before after greater time promptly business normal
      scheduled state process pdf facts are chat enabled disabled optional fee setting settings configuration through permission notice advance
      habilitada habilitado activada activado desactivada desactivado cargo cargos opcional tarifa tardia tardio gratuita gratuito anulacion autorizada permiso

 cuando aunque porque tampoco entonces entre sobre hasta tras ante demora tardanza retrasada retrasado individual individualmente
 podemos podemos puedan podria pueden puedan asistencia asistir atender atenderte llegada anterior siguiente recibido recibida necesita
 necesite necesitar necesaria necesaria necesario necesaria segun dicha dicho superar supera superan superado supera exceder excesivo
 respecto propia propias propio propios aplica aplicable solamente documento incluye incluida incluido contenida contenido materiales
 material informacion declaracion declara documentacion provisional automaticamente inmediatamente brevedad brevemente posible condiciones
 customer assessment requires staff individually may exceeds exceeding late arrival must contact studio promptly automatic cancellation
`.trim().split(/\s+/u));
const enabled=()=>process.env.NODE_ENV==='test'&&process.env.ODINLINK_PRIVATE_NUMERICAL_DIAGNOSTICS==='fixture-v1';
const eligible=(s:Scope)=>s.businessId===3&&s.language==='es'&&s.question===LATE_ARRIVAL_DIAGNOSTIC_QUESTION;
/** A private capability for one isolated test/replay, never an ordinary logger.
 * The flag alone cannot create a sink. No production process can opt in.
 * The directory must already be owned by this user and mode 0700. */
export async function withPrivateLateArrivalNumericalDiagnostics<T>(options:Scope&{directory:string},work:()=>Promise<T>):Promise<{
 value:T;capture:'disabled'|'refused'|'written'|'write_failed';path?:string}> {
 if(!enabled()||!eligible(options))return{value:await work(),capture:'disabled'};
 let directory:string|undefined;
 try{
  const info=lstatSync(options.directory);
  if(info.isDirectory()&&!info.isSymbolicLink()&&info.uid===process.getuid?.()&&(info.mode&0o777)===0o700)
   directory=mkdtempSync(join(realpathSync(options.directory),'late-arrival-'));
 }catch{/* Invalid private roots disable capture, without running work here. */}
 if(!directory)return{value:await work(),capture:'refused'};
 const session:Session={directory,key:randomBytes(32),records:[]};
 let value:T,failed=false,failure:unknown;
 try{value=await sessions.run(session,work);}catch(error){failed=true;failure=error;}
 session.closed=true;
 const finish=(capture:'written'|'write_failed',path?:string)=>{session.key.fill(0);if(failed)throw failure;return{value:value!,capture,...(path?{path}:{})};};
 const path=join(directory,'numerical.json');
 try{
  const payload=JSON.stringify({schemaVersion:'private-numerical-v1',businessId:3,customerDelayMinutes:20,records:session.records},null,2)+'\n';
  if(Buffer.byteLength(payload)>65536)return finish('write_failed');
  const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,payload);}finally{closeSync(fd);}
 }catch{return finish('write_failed');}
 return finish('written',path);
}
function field(text:string,key:Buffer,limit:number){
 if(typeof text!=='string'||text.length>limit)throw Error('private_capture_limit');
 const cleaned=text.replace(/(?:https?:\/\/|www\.)\S+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\+?\d[\s().-]*){7,}|(?:sk|key|token)[_-][\w-]+/giu,'[REDACTED]');
 const redacted=cleaned.replace(/[\p{L}\p{N}_-]+/gu,token=>{
  const word=token.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase();
  return permitted.has(word)||/^[0-9]{1,3}$/u.test(word)?token:'[REDACTED]';
 }).replace(/[^\p{L}\p{N}\s.,;:!?¿¡()'"«»–—<>=%\[\]-]/gu,'[REDACTED]');
 return{text:redacted,status:redacted===text?'complete':'redacted',length:text.length,
  fingerprint:createHmac('sha256',key).update(text).digest('hex')};
}
/** Called after citation resolution, immediately before the numerical veto.
 * Neither the private sink nor a failure in it grants answer authority. */
export function recordPrivateNumericalCandidate(scope:Scope|undefined,unit:Candidate,evidence:readonly Evidence[],assessment:NumericalConstraintAssessment):void {
 try{
  const session=sessions.getStore();
  if(!session||session.closed||!enabled()||!scope||!eligible(scope)||session.records.length>=6||!/^u[1-6]$/u.test(unit.id))return;
  if(!evidence.length||evidence.length>6||evidence.some(e=>e.businessId!==3)||
   new Set(evidence.map(e=>e.id)).size!==evidence.length||evidence.reduce((n,e)=>n+e.text.length,0)>9000)return;
  const sources=new Map<string,Evidence[]>();
  for(const e of evidence)sources.set(e.sourceId,[...(sources.get(e.sourceId)||[]),e]);
  const pins=new Map([['e2f08b302d6bfd256f01a9b187213cd85e24689123eb47328a90b924549a862f','8eec8b5c-87bc-4a7b-9789-b65d977b5ae4'],
   ['6b4ce43b5464e2c0b4cda65e3542fae1694af416ddb38899e70aeb7e700bc5af','511ef115-4873-4894-9228-5944109d12d8']]);
  if(sources.size!==2)return;
  const inventory=[...sources.values()].map(items=>{
   if(new Set(items.map(e=>e.version)).size!==1)throw Error('revision_mismatch');
   const contentHash=sha(items.map(e=>e.text).join('').replace(/\s/gu,''));
   if(pins.get(contentHash)!==items[0].sourceId)throw Error('source_identity_mismatch');return contentHash;
  });
  if(new Set(inventory).size!==2||inventory.some(h=>!pins.has(h)))return;
  if(unit.evidenceRefs.length>4||unit.qualifiers.length>8)return;
  const citations=unit.evidenceRefs.map(ref=>{
   const e=evidence.find(e=>e.id===ref.evidenceId);
   if(!e||e.sourceId!==ref.sourceId||e.chunkId!==ref.chunkId||e.version!==ref.version)throw Error('binding_mismatch');
   const start=e.text.indexOf(ref.exactQuote);
   if(start<0||e.text.indexOf(ref.exactQuote,start+1)>=0)throw Error('quote_missing_or_ambiguous');
   return{evidenceId:e.id,sourceId:e.sourceId,chunkId:sha(e.chunkId),revision:sha(e.version),evidenceTextSha256:sha(e.text),
    startUtf16:start,endUtf16:start+ref.exactQuote.length,quote:field(ref.exactQuote,session.key,2400)};
  });
  session.records.push({unitId:unit.id,claim:{text:field(unit.text,session.key,800),subject:field(unit.subject,session.key,300),
   predicate:field(unit.predicate,session.key,300),value:field(unit.value,session.key,600),scope:field(unit.scope,session.key,400),
   qualifiers:unit.qualifiers.map(q=>field(q,session.key,300)),modality:unit.modality,negation:unit.negation},
   inventory,citations,numerical:assessment});
 }catch{/* Optional private capture cannot alter parsing, verification or publication. */}
}
