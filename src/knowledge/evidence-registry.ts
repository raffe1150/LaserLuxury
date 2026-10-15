import { createHash } from 'node:crypto';
import type { KnowledgeSearchMatch } from '../../knowledge';
import { immutable } from './request-security';

export type DocumentEvidenceSnapshot = Readonly<{ businessId: number; text: string; matches: KnowledgeSearchMatch[] }>;

/** One tenant-scoped batch. An invalid/missing chunk quarantines its entire source.
 * Unexpected rows cannot expand the captured authority. Errors fail closed.
 */
export async function revalidateKnowledgeSourceIds(businessId: number, captured: readonly KnowledgeSearchMatch[],
  validate: (id: number, matches: KnowledgeSearchMatch[]) => Promise<KnowledgeSearchMatch[]>): Promise<ReadonlySet<string>> {
  if (!Number.isSafeInteger(businessId) || businessId <= 0 || !captured.length) return new Set();
  try {
    const fresh = await validate(businessId, structuredClone([...captured]));
    if (!Array.isArray(fresh)) return new Set();
    const valid = new Set<string>();
    for (const sourceId of new Set(captured.map(m => m.sourceId))) {
      if (!sourceId) continue;
      const before = captured.filter(m => m.sourceId === sourceId);
      const after = fresh.filter(m => m?.sourceId === sourceId);
      if (before.some(m => m.businessId !== businessId) || after.some(m => m.businessId !== businessId)) continue;
      if (JSON.stringify(before.map(m => JSON.stringify(m)).sort()) === JSON.stringify(after.map(m => JSON.stringify(m)).sort())) valid.add(sourceId);
    }
    return valid;
  } catch { return new Set(); }
}

/** Bounded turn evidence. Revalidate before and after grounding; never trust old prose. */
export class DocumentEvidenceRegistry {
  private entries = new Map<string, { expires: number; matches: KnowledgeSearchMatch[] }>();
  private key(businessId: number, text: string) { return `${businessId}:${createHash('sha256').update(text).digest('hex')}`; }
  register(businessId: number, text: string, matches: KnowledgeSearchMatch[]) {
    const documents = matches.filter(m => m.metadata?.source === 'document');
    if (!documents.length) return;
    const key = this.key(businessId, text);
    this.entries.delete(key);
    while (this.entries.size >= 256) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { expires: Date.now() + 120_000, matches: structuredClone(documents) });
  }
  async current(businessId: number, text: string, validate: (id: number, matches: KnowledgeSearchMatch[]) => Promise<KnowledgeSearchMatch[]>): Promise<boolean> {
    if (!text.includes('untrusted_document_text:')) return true;
    const entry = this.entries.get(this.key(businessId, text));
    if (!entry || entry.expires <= Date.now()) return false;
    try {
      const fresh = await validate(businessId, entry.matches);
      return JSON.stringify(fresh) === JSON.stringify(entry.matches);
    } catch { return false; }
  }
  capture(businessId: number, text: string): DocumentEvidenceSnapshot | null {
    const entry = this.entries.get(this.key(businessId, text));
    if (!entry || entry.expires <= Date.now()) return null;
    return immutable({ businessId, text, matches: entry.matches });
  }
  async validate(snapshot: DocumentEvidenceSnapshot | null, businessId: number, text: string,
    validate: (id: number, matches: KnowledgeSearchMatch[]) => Promise<KnowledgeSearchMatch[]>): Promise<boolean> {
    if (!snapshot || snapshot.businessId !== businessId || snapshot.text !== text || !snapshot.matches.length) return false;
    try {
      const fresh = await validate(businessId, structuredClone(snapshot.matches));
      return JSON.stringify(fresh) === JSON.stringify(snapshot.matches);
    } catch { return false; }
  }
  clear() { this.entries.clear(); }
}
