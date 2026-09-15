// TEMPORARY P1 release diagnostic. Remove after provider-contract verification.
import { Router, type RequestHandler } from 'express';
import type { AuthenticatedRequest } from '../auth/types';
export type DiagnosticAdapter = 'google' | 'generic' | 'other';
export class CalendarDiagnosticFailure extends Error {
  constructor(readonly category: 'unavailable' | 'timeout' | 'malformed' | 'forbidden' | 'configuration') { super(category); }
}
// Restrict field names too: unknown provider keys could themselves contain PII.
const safeFields = new Set(['kind','etag','summary','description','updated','timeZone','accessRole','defaultReminders','items','events','nextPageToken','nextSyncToken','next','hasMore','success']);
export async function inspectCalendarEnvelope(adapter: DiagnosticAdapter, read: () => Promise<unknown>, timeoutMs = 20_000) {
  const started = performance.now(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([Promise.resolve().then(read),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new CalendarDiagnosticFailure('timeout')),timeoutMs);})]);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CalendarDiagnosticFailure('malformed');
    const data = raw as Record<string,unknown>;
    if (data.success === false) throw new CalendarDiagnosticFailure('unavailable');
    const present = Object.prototype.hasOwnProperty.call(data,'items');
    const malformed = (present && !Array.isArray(data.items)) ||
      (!present && !(adapter === 'google' ? data.kind === 'calendar#events' : Array.isArray(data.events)));
    return {adapter,success:!malformed,category:malformed?'malformed':'ok',
      topLevelFields:Object.keys(data).filter(k=>safeFields.has(k)).sort(),
      itemsFieldPresent:present,itemsIsArray:Array.isArray(data.items),
      itemCount:Array.isArray(data.items)?data.items.length:adapter==='generic'&&Array.isArray(data.events)?data.events.length:null,
      nextPageTokenPresent:Boolean(data.nextPageToken || (adapter==='generic' && (data.next || data.hasMore))),latencyMs:Math.round(performance.now()-started)};
  } catch (error) {
    const e=error as any;const status=Number(e?.response?.status || e?.status);
    const category=error instanceof CalendarDiagnosticFailure?error.category:
      ['AbortError','TimeoutError'].includes(e?.name)||['ETIMEDOUT','ECONNABORTED'].includes(e?.code)?'timeout':status===401||status===403?'forbidden':'unavailable';
    return {adapter,success:false,category,latencyMs:Math.round(performance.now()-started)};
  } finally { clearTimeout(timer); }
}
export function createCalendarContractDiagnosticRouter(deps: {
  requireAuth: RequestHandler; requireSettings: RequestHandler;
  loadConfig: (businessId:number)=>Promise<any>;
  resolve: (config:any)=>{adapter:DiagnosticAdapter;read:(date:string,timezone:string)=>Promise<unknown>};
}) {
  const router=Router();
  const route='/api/businesses/:businessId/diagnostics/calendar-contract';
  router.get(route, (req,res,next)=>{res.setHeader('Cache-Control','no-store');if(req.method!=='GET'){res.status(405).end();return;}next();},deps.requireAuth,deps.requireSettings,async(req,res)=>{
    const id=(req as AuthenticatedRequest).businessAccess?.businessId;
    if (!id || String(id)!==req.params.businessId) {res.status(403).json({success:false,category:'forbidden'});return;}
    const date=req.query.date;
    if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date){res.status(400).json({success:false,category:'invalid_date'});return;}
    try {
      const config=await deps.loadConfig(id);
      if (!config || String(config.id)!==String(id)) {res.status(503).json({success:false,category:'configuration'});return;}
      const timezone=String(config.timezone||'Europe/Stockholm');
      try{new Intl.DateTimeFormat('en',{timeZone:timezone});}catch{throw new CalendarDiagnosticFailure('configuration');}
      const provider=deps.resolve(config);
      const result=await inspectCalendarEnvelope(provider.adapter,()=>provider.read(date,timezone));
      res.status(result.success?200:503).json(result);
    } catch(error) {res.status(503).json({success:false,category:error instanceof CalendarDiagnosticFailure?error.category:'unavailable'});}
  });
  return router;
}
