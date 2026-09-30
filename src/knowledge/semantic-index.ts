import { createHash } from "node:crypto";
import type { EmbeddingProvider, EmbeddingVector } from "../ai/embeddings";
import type { KnowledgeSearchMatch } from "../../knowledge";

export type SemanticChunk = KnowledgeSearchMatch & { text: string };
const identity = (vector: EmbeddingVector) =>
  `${vector.provider}:${vector.model}:${vector.dimensions}:${vector.version}`;

export function semanticCorpusFingerprint(chunks: SemanticChunk[]): string {
  return createHash("sha256").update(JSON.stringify(chunks)).digest("hex");
}

/** Read-only bridge for a corpus whose persisted vectors belong to another provider.
 * Never compares vectors across models or writes/reindexes tenant knowledge.
 */
export class CompatibleSemanticIndex {
  private readonly cache = new Map<string, { fingerprint: string; expires: number; vectors: EmbeddingVector[] }>();

  async search(businessId: number, chunks: SemanticChunk[], query: EmbeddingVector,
    provider: EmbeddingProvider, limit: number, minSimilarity: number): Promise<KnowledgeSearchMatch[]> {
    if (!chunks.length) return [];
    if (chunks.some((chunk) => chunk.businessId !== businessId)) {
      throw new Error("Semantic corpus tenant mismatch.");
    }
    const key = `${businessId}:${identity(query)}`;
    const fingerprint = semanticCorpusFingerprint(chunks);
    const cached = this.cache.get(key);
    let vectors = cached?.fingerprint === fingerprint && cached.expires > Date.now() ? cached.vectors : null;
    if (!vectors) {
      vectors = [];
      // Bound each API request independently of tenant corpus size.
      for (let offset = 0; offset < chunks.length; offset += 64) {
        const batch = chunks.slice(offset, offset + 64);
        const embedded = await provider.embedDocuments(batch.map((chunk) => chunk.text));
        if (embedded.length !== batch.length || embedded.some((vector) =>
          identity(vector) !== identity(query) || vector.values.length !== query.dimensions ||
          vector.values.some((value) => !Number.isFinite(value)))) {
          throw new Error("Semantic corpus embedding identity mismatch.");
        }
        vectors.push(...embedded);
      }
      // Bound retained vectors across tenants; large corpora still remain searchable.
      this.cache.delete(key);
      while ([...this.cache.values()].reduce((sum, entry) => sum + entry.vectors.length, 0) + vectors.length > 2048 && this.cache.size) {
        this.cache.delete(this.cache.keys().next().value!);
      }
      if (vectors.length <= 2048) this.cache.set(key, { fingerprint, expires: Date.now() + 300_000, vectors });
    }
    const queryMagnitude = Math.hypot(...query.values);
    const threshold = Math.max(-1, Math.min(Number.isFinite(minSimilarity) ? minSimilarity : 0.55, 1));
    return chunks.map((chunk, index) => {
      const values = vectors![index].values;
      const denominator = queryMagnitude * Math.hypot(...values);
      const score = denominator ? values.reduce((sum, value, i) => sum + value * query.values[i], 0) / denominator : -1;
      return { ...chunk, score };
    }).filter((match) => match.score >= threshold).sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
