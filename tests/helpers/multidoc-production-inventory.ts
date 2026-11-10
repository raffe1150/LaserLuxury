import { readFileSync } from 'node:fs';
import { InMemoryKnowledgeStorage, KnowledgeService } from '../../knowledge';

// Actual sanitized source rows captured read-only during the production incident.
// Source text is untrusted test-business content, never synthetic model output.
export const capturedSources = JSON.parse(readFileSync(new URL('../fixtures/admotion-two-pdf-production-20261110.json', import.meta.url), 'utf8')).sources;
export async function productionInventory(selection: 'old' | 'new' | 'both' = 'both', businessId = 3) {
  const storage = new InMemoryKnowledgeStorage();
  const sources = capturedSources.filter((s: any) => selection === 'both' || (selection === 'old') === (s.title === 'admotion studio1.pdf'));
  for (const s of sources) await storage.create({ id: s.id, businessId, type: s.type, title: s.title, status: s.status,
    content: s.content, metadata: s.metadata, createdAt: s.created_at, updatedAt: s.updated_at });
  const service = new KnowledgeService(storage, storage, null);
  const matches = await service.completeSmallCorpus(businessId, [], undefined, 'native-documentary');
  if (!matches) throw new Error('Captured canonical inventory unexpectedly unavailable');
  return { storage, service, matches };
}
