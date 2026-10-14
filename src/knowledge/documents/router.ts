import express, { type RequestHandler } from 'express';
import type { AuthenticatedRequest } from '../../auth/types';
import { DOCUMENT_LIMITS, DocumentError } from './formats';
import { DocumentService } from './service';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export function documentRouter(service: DocumentService, auth: RequestHandler, read: RequestHandler, manage: RequestHandler) {
  const router = express.Router({ mergeParams: true });
  router.use(auth);
  const scope = (request: express.Request) => {
    const req = request as AuthenticatedRequest;
    if (!req.auth || !req.businessAccess?.businessId) throw new DocumentError('document_forbidden', 403);
    return { businessId: req.businessAccess.businessId, userId: req.auth.userId };
  };
  const id = (req: express.Request) => {
    if (!uuid.test(req.params.sourceId)) throw new DocumentError('document_not_found', 404);
    return req.params.sourceId;
  };
  const handle = (operation: (req: express.Request, res: express.Response) => Promise<unknown>): RequestHandler => (req, res) => {
    operation(req, res).catch((error) => {
      const safe = error instanceof DocumentError ? error : new DocumentError('document_unavailable', 503);
      res.status(safe.status).json({ success: false, error: safe.code });
    });
  };
  router.get('/', read, handle(async (req, res) => res.json({ success: true, data: await service.list(scope(req).businessId) })));
  let uploads = 0;
  router.post('/', manage, (req, res, next) => {
    if (uploads >= 2) return res.status(429).json({ error: 'document_busy' });
    uploads++;
    let released = false;
    const release = () => { if (!released) { uploads--; released = true; } clearTimeout(deadline); };
    const deadline = setTimeout(() => { if (!res.headersSent) res.status(408).json({ error: 'document_timeout' }); req.destroy(); }, 30_000);
    res.once('finish', release); res.once('close', release);
    next();
  }, (req, res, next) => {
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') return res.status(415).json({ error: 'document_content' });
    if (!req.is('application/octet-stream')) return res.status(415).json({ error: 'document_mime' });
    // Mounted before global JSON middleware; auth/permission precede body allocation.
    express.raw({ type: 'application/octet-stream', limit: DOCUMENT_LIMITS.bytes, inflate: false })(req, res, (error) => {
      if (error) return res.status(error.status === 413 ? 413 : 400).json({ error: error.status === 413 ? 'document_size' : 'document_content' });
      next();
    });
  }, handle(async (req, res) => {
    const { businessId, userId } = scope(req);
    let filename: string;
    try { filename = decodeURIComponent(String(req.headers['x-document-name'] || '')); }
    catch { throw new DocumentError('document_filename', 400); }
    if (!Buffer.isBuffer(req.body)) throw new DocumentError('document_content');
    const sourceId = await service.upload(businessId, userId, req.body, filename, String(req.headers['x-document-mime'] || ''), req.headers['x-business-knowledge-only'] === 'true');
    res.status(202).json({ success: true, sourceId });
  }));
  router.post('/:sourceId/retry', manage, handle(async (req, res) => {
    await service.retry(scope(req).businessId, id(req)); res.status(202).json({ success: true });
  }));
  router.delete('/:sourceId', manage, handle(async (req, res) => {
    await service.delete(scope(req).businessId, id(req)); res.json({ success: true });
  }));
  router.use((_req, res) => { res.status(404).json({ error: 'document_not_found' }); });
  return router;
}
