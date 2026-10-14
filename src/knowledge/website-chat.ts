import express, { type Request, type RequestHandler } from 'express';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import proxyAddr from 'proxy-addr';
import { parseBusinessId } from '../auth/require-business-access';
const TTL = 15 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export const WEBSITE_BODY_LIMIT = 8192;
export type WebsiteInstallation = { id: string; businessId: number; enabled: boolean; publicKnowledge: boolean; revision: string; origins: string[] };
type VisitorClaims = { v: 2; kid: string; businessId: number; installationId: string; revision: string; visitorId: string; origin: string; issued: number; expires: number };
export type WebsiteVisitorRequest = Request & { websiteVisitor?: VisitorClaims; websiteBusinessConfig?: any; websiteSessionCurrent?: () => Promise<boolean>; websitePublish?: (body: any, finalize?: () => Promise<any | null>) => Promise<boolean> };
export function validWebsiteOrigins(origins: unknown): origins is string[] {
  return Array.isArray(origins) && origins.length > 0 && origins.length <= 10 && origins.every(origin => {
    try { const url = new URL(origin); return url.origin === origin && (url.protocol === 'https:' || (['localhost','127.0.0.1'].includes(url.hostname) && url.protocol === 'http:')); } catch { return false; }
  });
}
export function createWebsiteKnowledgeRouter(options: {
  loadBusiness: (id: number) => Promise<any | null>; loadInstallation: (id: string) => Promise<WebsiteInstallation | null>;
  chat: RequestHandler; environment?: Record<string, string | undefined>;
}) {
  const router = express.Router(); const env = options.environment || process.env;
  const kid = env.WEBSITE_CHAT_SESSION_KEY_ID || '1'; const secret = env.WEBSITE_CHAT_SESSION_SECRET || '';
  const keys = new Map<string,string>();
  try { const previous = JSON.parse(env.WEBSITE_CHAT_PREVIOUS_SESSION_KEYS || '{}');
    if (previous && typeof previous === 'object' && !Array.isArray(previous)) for (const [id,value] of Object.entries(previous).slice(0,3)) {
      if (typeof value === 'string' && Buffer.byteLength(value) >= 32) keys.set(id,value);
    }
  } catch {}
  keys.set(kid,secret);
  let trust = (_address: string, _index: number) => false; let proxyValid = true;
  try {
    if (env.WEBSITE_CHAT_TRUSTED_PROXY_CIDRS?.trim()) {
      const proxies = env.WEBSITE_CHAT_TRUSTED_PROXY_CIDRS.split(',').map(s => s.trim());
      if (proxies.some(s => /\/0$/u.test(s))) throw new Error('unbounded_proxy_trust');
      trust = proxyAddr.compile(proxies);
    }
  } catch { proxyValid=false; }
  const configured = env.WEBSITE_CHAT_ENABLED === 'true' && Buffer.byteLength(secret) >= 32 && proxyValid;
  const sign = (body:string,key:string) => createHmac('sha256',key).update(body).digest('base64url');
  const decode = (token:string): VisitorClaims | null => {
    try {
      if (token.length > 2048) return null;
      const [body,signature,extra] = token.split('.'); if (!body || !signature || extra !== undefined) return null;
      const claims = JSON.parse(Buffer.from(body,'base64url').toString('utf8')); const key = keys.get(claims.kid);
      if (!key || Buffer.byteLength(key) < 32) return null;
      const actual = Buffer.from(signature,'base64url'), expected = Buffer.from(sign(body,key),'base64url');
      if (actual.length !== expected.length || !timingSafeEqual(actual,expected)) return null;
      const now = Date.now();
      if (claims.v !== 2 || parseBusinessId(claims.businessId) !== claims.businessId || !UUID.test(claims.visitorId) || !UUID.test(claims.installationId) || !UUID.test(claims.revision) ||
        typeof claims.origin !== 'string' || !Number.isSafeInteger(claims.issued) || claims.issued > now || !Number.isSafeInteger(claims.expires) || claims.expires <= now || claims.expires <= claims.issued || claims.expires - claims.issued > TTL) return null;
      return Object.freeze(claims);
    } catch { return null; }
  };
  const permitted = (installation:WebsiteInstallation|null,origin:string): installation is WebsiteInstallation => Boolean(installation && UUID.test(installation.id) && UUID.test(installation.revision) &&
    parseBusinessId(installation.businessId) === installation.businessId && installation.enabled === true && installation.publicKnowledge === true && validWebsiteOrigins(installation.origins) && installation.origins.includes(origin));
  const current = async (claims:VisitorClaims) => {
    if (claims.expires <= Date.now()) return false;
    const installation = await options.loadInstallation(claims.installationId);
    return claims.expires > Date.now() && permitted(installation,claims.origin) && installation.id === claims.installationId && installation.businessId === claims.businessId && installation.revision === claims.revision;
  };
  const cors = (res:express.Response,origin:string) => { res.set('Access-Control-Allow-Origin',origin);res.vary('Origin');res.set('Cache-Control','no-store'); };
  const rates = new Map<string,{until:number;count:number}>(); const visitors = new Set<string>(); const installations = new Map<string,number>(); let active = 0;
  const rate = (key:string,limit:number) => {
    const now=Date.now();for(const [id,value] of rates) if(value.until<=now) rates.delete(id);
    const value=rates.get(key)||{until:now+60_000,count:0};if((!rates.has(key)&&rates.size>=2048)||++value.count>limit)return false;
    rates.set(key,value);return true;
  };
  type Gate={claims?:VisitorClaims;installation?:WebsiteInstallation;running:boolean;release:()=>void}; const gates=new WeakMap<Request,Gate>();
  // Mount before the unrelated global parser. Hold capacity until underlying work ends.
  router.all(['/chat','/website-chat/session'],async(req,res,next)=>{
    if(!configured)return void res.status(503).json({error:'website_chat_unavailable'});
    if(!['POST','OPTIONS'].includes(req.method))return void res.sendStatus(405);
    let ip:string;try{ip=proxyAddr(req,trust);}catch{return void res.sendStatus(403);}
    if(!rate('ip:'+ip,30)||active>=8)return void res.status(429).json({error:'website_chat_busy'});
    const length=req.headers['content-length'];if(length&&(!/^\d+$/u.test(length)||Number(length)>WEBSITE_BODY_LIMIT))return void res.status(413).json({error:'website_chat_body_too_large'});
    const isChat = req.path.replace(/\/$/u, '').toLowerCase() === '/chat';
    const claims=isChat&&req.method==='POST'?decode(String(req.headers['x-odinlink-visitor-session']||'')):null;
    // Query selector supports browser preflight, which cannot carry custom header values.
    const installationId=claims?.installationId||String(req.headers['x-odinlink-installation']||req.query.installationId||'');
    if(claims&&req.query.installationId!==undefined&&req.query.installationId!==claims.installationId)return void res.status(403).json({error:'website_chat_forbidden'});
    if(!UUID.test(installationId)||(isChat&&req.method==='POST'&&!claims))return void res.status(403).json({error:'website_chat_forbidden'});
    if(!rate('installation:'+installationId,60)||(claims&&!rate('visitor:'+claims.visitorId,15)))return void res.status(429).json({error:'website_chat_busy'});
    if((installations.get(installationId)||0)>=4||(claims&&visitors.has(claims.visitorId)))return void res.status(429).json({error:'website_chat_busy'});
    active++;installations.set(installationId,(installations.get(installationId)||0)+1);if(claims)visitors.add(claims.visitorId);
    let released=false;let timer:ReturnType<typeof setTimeout>|undefined;
    const gate:Gate={running:true,claims:claims||undefined,release:()=>{
      if(released)return;released=true;clearTimeout(timer);active--;
      const count=(installations.get(installationId)||1)-1;if(count)installations.set(installationId,count);else installations.delete(installationId);
      if(claims)visitors.delete(claims.visitorId);
    }};gates.set(req,gate);
    res.on('close',()=>{if(!gate.running)gate.release();});res.on('finish',()=>{if(!gate.running)gate.release();});
    try{
      const origin=String(req.headers.origin||'');const installation=await options.loadInstallation(installationId);
      if(req.destroyed){gate.release();return;}
      if(!permitted(installation,origin)||installation.id!==installationId||(claims&&(claims.origin!==origin||claims.businessId!==installation.businessId||claims.revision!==installation.revision))){gate.release();return void res.status(403).json({error:'website_chat_forbidden'});}
      gate.installation=installation;cors(res,origin);
      if(req.method==='OPTIONS'){res.set('Access-Control-Allow-Methods','POST');res.set('Access-Control-Allow-Headers','Content-Type, X-OdinLink-Visitor-Session, X-OdinLink-Installation');gate.release();return void res.sendStatus(204);}
      gate.running=false;
      timer=setTimeout(()=>{if(!gate.running&&!res.headersSent){res.status(408).json({error:'website_chat_body_timeout'});req.destroy();gate.release();}},10_000);timer.unref();req.once('end',()=>clearTimeout(timer));next();
    }catch{gate.release();if(!res.headersSent)res.status(503).json({error:'website_chat_unavailable'});}
  });
  router.use(['/chat','/website-chat/session'],express.json({limit:WEBSITE_BODY_LIMIT,inflate:false}));
  router.post('/website-chat/session',async(req,res)=>{
    const gate=gates.get(req)!;gate.running=true;
    try{
      const installation=gate.installation!,id=parseBusinessId(req.body?.businessId);
      if(id!==installation.businessId||req.body?.installationId!==installation.id)return void res.status(403).json({error:'website_chat_forbidden'});
      const config=await options.loadBusiness(id);if(!config||Number(config.id??config.business_id)!==id)return void res.status(403).json({error:'website_chat_forbidden'});
      const issued=Date.now();const claims:VisitorClaims={v:2,kid,businessId:id,installationId:installation.id,revision:installation.revision,visitorId:randomUUID(),origin:String(req.headers.origin),issued,expires:issued+TTL};
      if(!await current(claims))return void res.status(403).json({error:'website_chat_forbidden'});
      const body=Buffer.from(JSON.stringify(claims)).toString('base64url');res.json({sessionToken:body+'.'+sign(body,secret),chatId:claims.visitorId,businessId:id,installationId:installation.id,expiresAt:new Date(claims.expires).toISOString()});
    }catch{if(!res.headersSent)res.status(503).json({error:'website_chat_unavailable'});}finally{gate.release();}
  });
  router.post('/chat',async(req,res,next)=>{
    const gate=gates.get(req)!;gate.running=true;const claims=gate.claims!;
    try{
      if((req.body?.businessId!==undefined&&parseBusinessId(req.body.businessId)!==claims.businessId)||(req.body?.installationId!==undefined&&req.body.installationId!==claims.installationId)||(req.body?.chatId!==undefined&&req.body.chatId!==claims.visitorId))return void res.status(403).json({error:'website_chat_forbidden'});
      const config=await options.loadBusiness(claims.businessId);if(!config||Number(config.id??config.business_id)!==claims.businessId||!await current(claims))return void res.status(403).json({error:'website_chat_forbidden'});
      const scoped=req as WebsiteVisitorRequest;scoped.websiteVisitor=claims;scoped.websiteBusinessConfig=config;
      scoped.websiteSessionCurrent=async()=>{try{return await current(claims);}catch{return false;}};
      scoped.websitePublish=async(body,finalize)=>{
        if(!await scoped.websiteSessionCurrent!()){if(!res.headersSent)res.status(403).json({error:'website_chat_forbidden'});return false;}
        const finalBody=finalize?await finalize():body;
        // Final evidence validation may await I/O while the installation is revoked.
        if(!await scoped.websiteSessionCurrent!()){if(!res.headersSent)res.status(403).json({error:'website_chat_forbidden'});return false;}
        if(claims.expires<=Date.now()){if(!res.headersSent)res.status(403).json({error:'website_chat_forbidden'});return false;}
        if(finalBody===null){if(!res.headersSent)res.status(409).json({error:'website_chat_request_superseded'});return false;}
        if(res.destroyed)return false;res.json(finalBody);return true;
      };
      await options.chat(req,res,next);
    }catch{if(!res.headersSent)res.status(503).json({error:'website_chat_unavailable'});}finally{gate.release();}
  });
  router.use((error:any,req:Request,res:express.Response,next:express.NextFunction)=>{if(!gates.has(req))return next(error);gates.get(req)!.release();res.status(error.type==='entity.too.large'?413:400).json({error:'website_chat_invalid_body'});});
  return router;
}
