import type { KnowledgeSearchMatch } from '../../knowledge';

/** Transport grouping, never relevance or source authority. Canonical rows remain
 * separate for currentness checks. No words are removed or rewritten. */
export const DOCUMENT_EVIDENCE_LIMITS = Object.freeze({ items: 5, itemChars: 2400, totalChars: 9000, chunksPerSource: 5 });
export type DocumentEvidenceGroup = { text: string; matches: readonly KnowledgeSearchMatch[] };
export function packDocumentEvidence(matches: readonly KnowledgeSearchMatch[]): DocumentEvidenceGroup[] | null {
  const limits = DOCUMENT_EVIDENCE_LIMITS;
  if (!matches.length || matches.length > limits.items * limits.chunksPerSource) return null;
  const tenant = matches[0].businessId, sources = new Map<string, { revision: string; count: number }>();
  if (!Number.isSafeInteger(tenant) || tenant <= 0) return null;
  for (const m of matches) {
    if (m.businessId !== tenant || typeof m.sourceId !== 'string' || !m.sourceId.trim() || m.sourceId.length > 256 || m.metadata?.source !== 'document' ||
        typeof m.metadata.documentRevision !== 'string' || !m.metadata.documentRevision ||
        !m.text?.trim() || m.text.length > limits.itemChars) return null;
    const prior = sources.get(m.sourceId);
    if (prior && prior.revision !== m.metadata.documentRevision) return null;
    const count = (prior?.count || 0) + 1;
    if (count > limits.chunksPerSource) return null;
    sources.set(m.sourceId, { revision: m.metadata.documentRevision, count });
  }
  if (sources.size > limits.items) return null;
  const groups: DocumentEvidenceGroup[] = [];
  for (const m of matches) {
    const last = groups.at(-1);
    // Keep the existing transport unchanged when it already fits. Never join
    // tenants, sources, revisions, or truncate a canonical constituent.
    if (matches.length > limits.items && last && last.matches[0].sourceId === m.sourceId &&
        last.text.length + 2 + m.text!.length <= limits.itemChars) {
      last.text += '\n\n' + m.text;
      last.matches = [...last.matches, m];
    } else groups.push({ text: m.text!, matches: [m] });
  }
  return groups.length <= limits.items && groups.reduce((n, g) => n + g.text.length, 0) <= limits.totalChars ? groups : null;
}
