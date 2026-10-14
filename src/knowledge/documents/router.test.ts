import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { documentRouter } from './router';
import { createRequireBusinessPermission } from '../../auth/require-business-access';
import type { AuthenticatedRequest } from '../../auth/types';
import { DocumentService } from './service';

function memberships() {
  return { from: () => {
    const filters: Record<string, unknown> = {};
    const query = { select: () => query, eq: (k: string,v: unknown) => { filters[k]=v; return query; }, maybeSingle: async () => {
      const role = filters.user_id === 'viewer' ? 'viewer' : 'owner';
      return { data: filters.business_id===1 && ['owner','viewer'].includes(String(filters.user_id)) ? { business_id:1,user_id:filters.user_id,role,status:'active' } : null, error:null };
    } }; return query;
  } } as any;
}
test('HTTP upload/list/retry/delete require verified auth and matching business permissions before reading body', async () => {
  const calls: unknown[] = [];
  const service = { list: async (b: number) => { calls.push(['list',b]);return []; }, upload: async (...args: any[])=>{ calls.push(['upload',args[0],args[1],args[2].toString(),args[3]]);return 'id'; }, delete: async (...a: any[])=>{calls.push(['delete',...a]);}, retry: async (...a: any[])=>{calls.push(['retry',...a]);} } as unknown as DocumentService;
  const app = express(); const auth: express.RequestHandler = (req,res,next)=>{
    const token=req.headers.authorization?.replace('Bearer ','');
    if (!token || token==='invalid') return void res.status(401).json({ error:'unauthenticated' });
    (req as AuthenticatedRequest).auth={ userId:token };next();
  };
  const client = memberships();
  app.use('/api/businesses/:businessId/knowledge/documents',documentRouter(service,auth,createRequireBusinessPermission('business.read',{client}),createRequireBusinessPermission('settings.manage',{client})));
  const listener=app.listen(0,'127.0.0.1'); await new Promise<void>((r)=>listener.once('listening',r));
  const base=`http://127.0.0.1:${(listener.address() as any).port}/api/businesses`;
  const id='11111111-1111-4111-8111-111111111111';
  const fileHeaders={ 'Content-Type':'application/octet-stream','X-Document-Name':'policy.txt','X-Document-Mime':'text/plain','X-Business-Knowledge-Only':'true' };
  try {
    for (const [path,method] of [[`/knowledge/documents`,'GET'],[`/knowledge/documents`,'POST'],[`/knowledge/documents/${id}`,'DELETE'],[`/knowledge/documents/${id}/retry`,'POST']]) {
      assert.equal((await fetch(`${base}/1${path}`,{method})).status,401);
      assert.equal((await fetch(`${base}/2${path}`,{method,headers:{Authorization:'Bearer owner'}})).status,403);
    }
    assert.equal(calls.length,0);
    assert.equal((await fetch(`${base}/1/knowledge/documents`,{headers:{Authorization:'Bearer viewer'}})).status,200);
    for (const [path,method] of [['','POST'],[`/${id}`,'DELETE'],[`/${id}/retry`,'POST']]) assert.equal((await fetch(`${base}/1/knowledge/documents${path}`,{method,headers:{Authorization:'Bearer viewer'}})).status,403);
    assert.equal((await fetch(`${base}/1/knowledge/documents`,{method:'POST',headers:{Authorization:'Bearer owner',...fileHeaders},body:'Synthetic policy'})).status,202);
    assert.deepEqual(calls[1],['upload',1,'owner','Synthetic policy','policy.txt']);
    assert.equal((await fetch(`${base}/1/knowledge/documents`,{method:'POST',headers:{Authorization:'Bearer owner','Content-Type':'application/json'},body:'{}'})).status,415);
    assert.equal((await fetch(`${base}/1/knowledge/documents/bad`,{method:'DELETE',headers:{Authorization:'Bearer owner'}})).status,404);
    assert.equal((await fetch(`${base}/1/knowledge/documents/${id}`,{method:'DELETE',headers:{Authorization:'Bearer owner'}})).status,200);
    assert.equal((await fetch(`${base}/1/knowledge/documents/${id}/retry`,{method:'POST',headers:{Authorization:'Bearer owner'}})).status,202);
    assert.equal((await fetch(`${base}/1/knowledge/documents`,{method:'POST',headers:{Authorization:'Bearer owner',...fileHeaders},body:Buffer.alloc(5*1024*1024+1)})).status,413);
  } finally { listener.closeAllConnections(); await new Promise<void>((resolve)=>listener.close(()=>resolve())); }
});
test('missing durable storage rejects all service operations without memory success', async () => {
  const service = new DocumentService(null);
  await assert.rejects(service.upload(1,'owner',Buffer.from('Policy'),'x.txt','text/plain',true),/document_unavailable/u);
  await assert.rejects(service.upload(1,'owner',Buffer.from('Policy'),'x.txt','text/plain',false),/document_attestation/u);
  await assert.rejects(service.list(1),/document_unavailable/u);
  await assert.rejects(service.delete(1,'id'),/document_unavailable/u);
  await assert.rejects(service.retry(1,'id'),/document_unavailable/u);
});
