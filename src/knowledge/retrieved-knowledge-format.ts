import type { KnowledgeSearchMatch } from '../../knowledge';
import { DOCUMENT_EVIDENCE_LIMITS, packDocumentEvidence } from './document-evidence-packing';

type RetrievedMatch = { sourceId?: string; text?: string; metadata?: Record<string, unknown> };
export type KnowledgeFormattingFailure = 'EVIDENCE_PACKING_FAILED' | 'EVIDENCE_ITEM_OVERFLOW' | 'EVIDENCE_FORMAT_OVERFLOW';
export type KnowledgeFormattingResult =
  | { ok: true; text: string; serializedChars: number }
  | { ok: false; reason: KnowledgeFormattingFailure; serializedChars: number | null };

/** Presentation only. Canonical rows, revisions and constituent citation ranges
 * remain authoritative in answerEvidenceBindings and DocumentEvidenceRegistry.
 * Never trim, truncate or select a prefix to satisfy the serialized budget. */
export function formatRetrievedBusinessKnowledge(matches: readonly RetrievedMatch[]): KnowledgeFormattingResult {
  const limits = DOCUMENT_EVIDENCE_LIMITS;
  const grouped = matches.length > limits.items ? packDocumentEvidence(matches as KnowledgeSearchMatch[]) : null;
  if (matches.length > limits.items && !grouped) return { ok: false, reason: 'EVIDENCE_PACKING_FAILED', serializedChars: null };
  const groups = grouped || matches.map(match => ({ text: match.text || '', matches: [match] }));
  if (groups.some(group => !group.text.trim()))
    return { ok: false, reason: 'EVIDENCE_PACKING_FAILED', serializedChars: null };
  if (groups.some(group => group.text.length > limits.itemChars))
    return { ok: false, reason: 'EVIDENCE_ITEM_OVERFLOW', serializedChars: null };

  const location = (match: RetrievedMatch) => ({ page: match.metadata?.page, sheet: match.metadata?.sheet, section: match.metadata?.section });
  const text = groups.map((group, index) => {
    const match = group.matches[0];
    return [
      `KNOWLEDGE CHUNK ${index + 1}`,
      `source_id: ${String(match.sourceId || '')}`,
      ...(match.metadata?.source === 'document' ? [
        // Filename/source are shared within a group. Only multi-row groups need
        // ordered constituent locations; full row bindings are never serialized
        // redundantly here or replaced by this compact presentation metadata.
        `document_provenance: ${JSON.stringify({ filename: match.metadata.filename,
          ...(group.matches.length > 1 ? { constituents: group.matches.map(location) } : location(match)) })}`,
        `untrusted_document_text: ${JSON.stringify(group.text)}`,
      ] : [group.text]),
    ].join('\n');
  }).join('\n\n');
  return text.length > limits.totalChars
    ? { ok: false, reason: 'EVIDENCE_FORMAT_OVERFLOW', serializedChars: text.length }
    : { ok: true, text, serializedChars: text.length };
}
