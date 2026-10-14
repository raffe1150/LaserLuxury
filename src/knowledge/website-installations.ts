import express from 'express';
import { parseBusinessId } from '../auth/require-business-access';
import { validWebsiteOrigins, type WebsiteInstallation } from './website-chat';

export function mapWebsiteInstallation(row: any): WebsiteInstallation | null {
  if (!row) return null;
  return { id: row.id, businessId: Number(row.business_id), enabled: row.enabled,
    publicKnowledge: row.public_knowledge, revision: row.revision, origins: row.allowed_origins };
}

/** Mount behind existing authentication and settings.manage membership checks. */
export function websiteInstallationRouter(client: any) {
  const router = express.Router({ mergeParams: true });
  router.get('/', async (req: express.Request, res) => {
    try {
      if (!client) throw new Error('unavailable');
      const { data, error } = await client.from('website_chat_installations').select('*').eq('business_id', parseBusinessId(req.params.businessId));
      if (error) throw error;
      res.json({ installations: data || [] });
    } catch { res.status(503).json({ error: 'website_installation_unavailable' }); }
  });
  const save = async (req: express.Request, res: express.Response) => {
    const businessId = parseBusinessId(req.params.businessId);
    const installationId = req.params.installationId;
    if (!businessId || (installationId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(installationId))) return void res.status(400).json({ error: 'invalid_installation' });
    const body = req.body || {};
    // Opt-in certifies that ready Knowledge and configured business facts may be public.
    if (!validWebsiteOrigins(body.origins) || typeof body.enabled !== 'boolean' || typeof body.publicKnowledge !== 'boolean' ||
      (body.enabled && !body.publicKnowledge)) return void res.status(400).json({ error: 'invalid_installation_policy' });
    try {
      if (!client) throw new Error('unavailable');
      const policy = { allowed_origins: body.origins, enabled: body.enabled, public_knowledge: body.publicKnowledge };
      const table = client.from('website_chat_installations');
      const query = installationId ? table.update(policy).eq('id', installationId).eq('business_id', businessId)
        : table.insert({ ...policy, business_id: businessId });
      const { data, error } = await query.select('*').maybeSingle();
      if (error) throw error;
      if (!data) return void res.status(404).json({ error: 'installation_not_found' });
      res.json({ installation: data });
    } catch { res.status(503).json({ error: 'website_installation_unavailable' }); }
  };
  router.post('/', save); router.put('/:installationId', save);
  return router;
}
