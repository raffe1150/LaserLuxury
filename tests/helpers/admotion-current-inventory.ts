import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chunkKnowledgeContent, InMemoryKnowledgeStorage, KnowledgeService, type KnowledgeSource } from '../../knowledge';
import { answerEvidence } from '../../src/ai/business-information-answer-plan';

// Read-only capture of the current production library (business 3). Shared by
// the owner-first replay and the re-extraction evaluation. Never invents text.
export const CURRENT_CAPTURE = new URL('../fixtures/admotion-current-production-20261112.json', import.meta.url);
export const TENANT = 3;

type Row = { id: string; business_id: string | number; type: string; title: string; status: string; content: string;
  metadata: Record<string, unknown> & { segments?: Record<string, unknown>[] }; created_at: string; updated_at: string };
export const toSource = (row: Row): KnowledgeSource => ({ id: row.id, businessId: Number(row.business_id), type: row.type as KnowledgeSource['type'],
  status: row.status as KnowledgeSource['status'], title: row.title, content: row.content, createdAt: row.created_at, updatedAt: row.updated_at,
  metadata: { ...row.metadata, ...(row.metadata.segments ? { segments: row.metadata.segments.map(segment => Object.fromEntries(
    Object.entries(segment).map(([key, value]) => [key, ['start', 'end', 'page'].includes(key) ? Number(value) : value]))) } : {}) } as KnowledgeSource['metadata'] });

export function readySources(path: string | URL = CURRENT_CAPTURE) {
  const capture = JSON.parse(readFileSync(path, 'utf8')) as { sources: Row[] };
  return capture.sources.filter(row => row.status === 'ready' && Number(row.business_id) === TENANT).map(toSource);
}

/** Production admission rules: exhaustive documentary inventory, then the
 * lexical small-corpus proof, else the ranked lexical hits. */
export async function admitted(sources: KnowledgeSource[]) {
  const storage = new InMemoryKnowledgeStorage();
  for (const source of sources) {
    await storage.create(source);
    // Stored search rows as production writes them: canonical document chunks
    // for documents, the shared text chunker for manual text.
    if (source.type === 'document') {
      const single = new InMemoryKnowledgeStorage();
      await single.create(source);
      const canonical = await new KnowledgeService(single, single, null).completeSmallCorpus(TENANT, [], undefined, 'native-documentary');
      assert.ok(canonical?.length, `document ${source.id} has no canonical chunks`);
      await storage.replaceChunks(TENANT, source.id, canonical.map((chunk, chunkIndex) => ({ chunkIndex, content: chunk.text,
        metadata: chunk.metadata as never })));
    } else await storage.replaceChunks(TENANT, source.id, chunkKnowledgeContent(source.content).map((chunk, chunkIndex) =>
      ({ chunkIndex, content: chunk.content, metadata: chunk.metadata as never })));
  }
  const service = new KnowledgeService(storage, storage, null);
  const exhaustive = await service.completeSmallCorpus(TENANT, [], undefined, 'native-documentary');
  const hits = await service.search(TENANT, 'minuter', 5);
  const lexicalComplete = hits.length ? await service.completeSmallCorpus(TENANT, hits, undefined, 'lexical') : null;
  const matches = exhaustive ?? lexicalComplete ?? hits;
  return { exhaustive: !!exhaustive, lexicalComplete: !!lexicalComplete, matches, evidence: answerEvidence(TENANT, matches) };
}

/** Locates an exact sentence span in source text without assuming line breaks. */
export function sentence(text: string, startsWith: RegExp, endsWith: RegExp) {
  const start = text.search(startsWith);
  if (start < 0) return null;
  const tail = text.slice(start).search(endsWith);
  return tail < 0 ? null : text.slice(start, start + tail + text.slice(start + tail).match(endsWith)![0].length);
}
