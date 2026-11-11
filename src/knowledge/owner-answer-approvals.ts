import { normalizeConversationText } from '../ai/booking-intelligence';
import { Router, type RequestHandler } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { chunkKnowledgeContent, knowledgeSourceRevision, type KnowledgeSource } from '../../knowledge';
import type { AuthenticatedRequest } from '../auth/types';
import { canonicalDocument, canonicalHash } from './documents/canonical';
import type { Evidence, Facet, OwnerAnswerProposal } from '../ai/business-information-answer-plan';
import { resolveEvidenceQuote } from '../ai/knowledge-citation';
import type { SourceLanguage } from './semantic-queries';

const languages: readonly SourceLanguage[] = ['fa', 'ar', 'en', 'sv', 'de', 'es'];
const sourceFields = 'id,business_id,type,title,status,content,metadata,created_at,updated_at';
export const ownerAnswerApprovalsEnabled = () => process.env.ODINLINK_OWNER_ANSWER_APPROVALS === 'true';

function sourceFromRow(row: Record<string, any>): KnowledgeSource {
  return { id: row.id, businessId: Number(row.business_id), type: row.type, title: row.title,
    status: row.status, content: row.content, metadata: row.metadata, createdAt: row.created_at, updatedAt: row.updated_at };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function reviewedAnswer(body: Record<string, unknown>, source: KnowledgeSource) {
  const { answerText, spans, qualifications } = body;
  if (body.confirmCompleteReview !== true || typeof answerText !== 'string' || !answerText.trim() ||
      answerText.length > 800 || !Array.isArray(spans) || spans.length < 1 || spans.length > 4 ||
      !Array.isArray(qualifications) || qualifications.length > 8) return null;

  const nodes = source.type === 'document' ? canonicalDocument(source).nodes :
    [{ rawStart: 0, rawEnd: source.content.length }];
  let previousEnd = 0;
  const checkedSpans = [];
  for (const span of spans) {
    if (!object(span) || typeof span.start !== 'number' || typeof span.end !== 'number' ||
        !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end)) return null;
    const { start, end } = span;
    if (start < previousEnd || end <= start || end - start > 2400 ||
        !nodes.some(node => start >= node.rawStart && end <= node.rawEnd)) return null;
    const text = source.content.slice(start, end);
    if (!text.trim() || canonicalHash(text) !== span.digest) return null;
    checkedSpans.push({ start, end, digest: span.digest });
    previousEnd = end;
  }
  const checkedQualifications = [];
  for (const qualification of qualifications) {
    if (!object(qualification) || typeof qualification.spanIndex !== 'number' ||
        !Number.isSafeInteger(qualification.spanIndex) || !checkedSpans[qualification.spanIndex] ||
        typeof qualification.answerPhrase !== 'string' || !qualification.answerPhrase.trim() ||
        qualification.answerPhrase.length > 300 || !answerText.includes(qualification.answerPhrase)) return null;
    checkedQualifications.push({ spanIndex: qualification.spanIndex, answerPhrase: qualification.answerPhrase });
  }
  const { question, proposition } = body;
  let reviewedProposition: Pick<OwnerAnswerProposal, 'subject' | 'predicate' | 'value' | 'scope' | 'modality' | 'negation'> | undefined;
  if (question !== undefined || proposition !== undefined) {
    if (typeof question !== 'string' || !question.trim() || question !== question.trim() || question.length > 800 ||
        !object(proposition)) return null;
    const { subject, predicate, value, scope, negation } = proposition;
    const modality = (['descriptive', 'recommended', 'required', 'permitted', 'prohibited'] as const)
      .find(value => value === proposition.modality);
    const short = (value: unknown, limit: number): value is string =>
      typeof value === 'string' && !!value.trim() && value.length <= limit;
    if (!short(subject, 240) || !short(predicate, 240) || !short(value, 600) || !short(scope, 400) ||
        typeof negation !== 'boolean' || !modality) return null;
    reviewedProposition = { subject, predicate, value, scope, modality, negation };
  }
  return { ...(reviewedProposition ? { question, proposition: reviewedProposition } : {}), answerText, spans: checkedSpans, qualifications: checkedQualifications, confirmCompleteReview: true };
}

export function ownerAnswerApprovalRouter(
  client: () => SupabaseClient | null, authenticate: RequestHandler, membership: RequestHandler,
  enabled = ownerAnswerApprovalsEnabled,
) {
  const router = Router({ mergeParams: true });
  router.use((_req, res, next) => enabled() ? next() : res.sendStatus(404));
  router.use(authenticate, membership);

  for (const operation of ['approve', 'revoke'] as const) {
    router.post('/' + operation, async (req, res) => {
      const { auth, businessAccess } = req as AuthenticatedRequest;
      if (!auth?.userId || businessAccess?.role !== 'owner') { res.sendStatus(403); return; }
      const db = client();
      if (!db) { res.sendStatus(503); return; }
      const body = req.body;
      if (!object(body)) { res.sendStatus(400); return; }
      try {
        const args = { p_business_id: businessAccess.businessId, p_actor: auth.userId,
          p_source_id: null as string | null, p_revoke_id: null as string | null,
          p_source_snapshot: null as unknown, p_revision: null as string | null,
          p_language: null as string | null, p_reviewed_answer: null as unknown };
        if (operation === 'revoke') {
          if (typeof body.approvalId !== 'string' || body.approvalId.length !== 36) { res.sendStatus(400); return; }
          args.p_revoke_id = body.approvalId;
        } else {
          if (typeof body.sourceId !== 'string' || body.sourceId.length !== 36 ||
              typeof body.revision !== 'string' || body.revision.length !== 64 ||
              !languages.some(language => language === body.language)) { res.sendStatus(400); return; }
          const { data, error } = await db.from('knowledge_sources').select(sourceFields)
            .eq('business_id', businessAccess.businessId).eq('id', body.sourceId).maybeSingle();
          if (error) { res.sendStatus(error.code === '22P02' ? 400 : 503); return; }
          if (!data) { res.sendStatus(404); return; }
          const source = sourceFromRow(data);
          if (source.status !== 'ready' || knowledgeSourceRevision(source) !== body.revision) { res.sendStatus(409); return; }
          if (source.type !== 'document' && (source.type !== 'text' || source.metadata.source !== 'manual')) {
            res.sendStatus(400); return;
          }
          let answer;
          try { answer = reviewedAnswer(body, source); } catch { res.sendStatus(400); return; }
          if (!answer) { res.sendStatus(400); return; }
          args.p_source_id = source.id;
          args.p_source_snapshot = data;
          args.p_revision = body.revision;
          args.p_language = body.language as SourceLanguage;
          args.p_reviewed_answer = answer;
        }
        const { data: approvalId, error } = await db.rpc('write_knowledge_answer_approval', args);
        if (error) {
          res.sendStatus(error.code === '42501' ? 403 : error.code === '23505' || error.code === 'P0001' ? 409 :
            error.code === '22P02' ? 400 : 503);
          return;
        }
        if (!approvalId) { res.sendStatus(404); return; }
        res.status(operation === 'approve' ? 201 : 200).json({ approvalId });
      } catch {
        res.sendStatus(503);
      }
    });
  }
  return router;
}

type ApprovalScope = { businessId: number; sourceId: string; revision: string; language: SourceLanguage };
type ApprovalKey = ApprovalScope & { approvalId: string };

async function readActiveApproval(db: SupabaseClient, key: ApprovalScope & { approvalId?: string },
  enabled: () => boolean, signal?: AbortSignal) {
  if (!enabled() || signal?.aborted) return null;
  try {
    let query = db.from('knowledge_answer_approvals')
      .select(`id,business_id,source_id,source_revision,language,reviewed_answer,approved_by,approved_at,revoked_at,source:knowledge_sources!inner(${sourceFields})`)
      .eq('business_id', key.businessId).eq('source_id', key.sourceId).eq('source_revision', key.revision)
      .eq('language', key.language).is('revoked_at', null);
    if (key.approvalId) query = query.eq('id', key.approvalId);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query.maybeSingle();
    if (error) return undefined;
    if (!data || !enabled() || signal?.aborted || !object(data.source) ||
        typeof data.id !== 'string' || !data.id || (key.approvalId && data.id !== key.approvalId) ||
        data.revoked_at !== null || !data.approved_by ||
        Number(data.business_id) !== key.businessId || data.source_id !== key.sourceId ||
        data.source_revision !== key.revision || data.language !== key.language) return null;
    const source = sourceFromRow(data.source);
    if (source.id !== key.sourceId || source.businessId !== key.businessId || source.status !== 'ready' ||
        knowledgeSourceRevision(source) !== key.revision) return null;
    const { source: _source, revoked_at: _revokedAt, ...approval } = data;
    return { approval, source };
  } catch {
    return undefined;
  }
}

export async function lookupActiveOwnerAnswerApproval(db: SupabaseClient, key: ApprovalKey,
  enabled = ownerAnswerApprovalsEnabled) {
  return (await readActiveApproval(db, key, enabled))?.approval ?? null;
}

export type OwnerAnswerSelection = Readonly<{
  key: ApprovalKey;
  digest: string;
  proposal: OwnerAnswerProposal;
}>;

export async function selectOwnerAnswerProposal(db: SupabaseClient, input: {
  businessId: number; question: string; language: string; facets: readonly Facet[]; evidence: readonly Evidence[];
}, signal: AbortSignal): Promise<OwnerAnswerSelection | null> {
  const language = languages.find(candidate => candidate === input.language);
  if (!ownerAnswerApprovalsEnabled() || !language || input.facets.length !== 1 ||
      input.evidence.some(item => item.businessId !== input.businessId)) return null;

  // Candidate keys come only from validated retrieval. The owner-reviewed
  // question authorizes applicability, and the database supplies the ID.
  const scopes = new Map<string, ApprovalScope>();
  for (const item of input.evidence) {
    const key = { businessId: input.businessId, sourceId: item.sourceId, revision: item.version, language };
    scopes.set(JSON.stringify(key), key);
  }
  const candidates = await Promise.all([...scopes.values()].map(key => readActiveApproval(db, key, ownerAnswerApprovalsEnabled, signal)));
  if (!ownerAnswerApprovalsEnabled() || signal.aborted || candidates.some(candidate => candidate === undefined)) return null;
  // Exact-question contract: both sides pass through the same trusted
  // conversation normalizer here, independent of what the caller already did.
  // This is not fuzzy matching; any other textual difference is a non-match.
  const requested = normalizeConversationText(input.question);
  if (!requested) return null;
  const matching = candidates.filter(candidate => {
    const question = candidate?.approval.reviewed_answer?.question;
    return typeof question === 'string' && normalizeConversationText(question) === requested;
  });
  if (matching.length !== 1) return null;
  const { approval, source } = matching[0]!;
  try {
    const review = object(approval.reviewed_answer) && reviewedAnswer(approval.reviewed_answer, source);
    if (!review || !review.proposition) return null;
    const evidence = input.evidence.filter(item => item.sourceId === source.id && item.version === approval.source_revision);
    if (source.type !== 'document') {
      if (source.type !== 'text' || source.metadata.source !== 'manual') return null;
      if (!chunkKnowledgeContent(source.content).every(chunk => evidence.some(item => item.text === chunk.content))) return null;
    }
    const evidenceRefs = [];
    for (const span of review.spans) {
      const exactQuote = source.content.slice(span.start, span.end);
      // A repeated raw quote cannot prove that the reviewed occurrence is in
      // the admitted chunk. Existing citation boundaries still apply.
      if (source.content.indexOf(exactQuote) !== span.start || source.content.indexOf(exactQuote, span.start + 1) >= 0) return null;
      const bindings = evidence.filter(item => {
        const citation = resolveEvidenceQuote(item.text, exactQuote);
        return citation.quote === exactQuote && (!item.citationRanges ||
          item.citationRanges.some(range => citation.start! >= range.start && citation.end! <= range.end));
      });
      if (bindings.length !== 1) return null;
      evidenceRefs.push({ evidenceId: bindings[0].id, exactQuote });
    }
    return {
      key: { businessId: input.businessId, sourceId: source.id, revision: approval.source_revision, language, approvalId: approval.id },
      digest: canonicalHash(approval.reviewed_answer),
      proposal: { ...review.proposition, language, text: review.answerText,
        qualifiers: review.qualifications.map(item => item.answerPhrase), facetIds: [input.facets[0].id], evidenceRefs },
    };
  } catch {
    return null;
  }
}

export async function ownerAnswerSelectionCurrent(db: SupabaseClient, selection: OwnerAnswerSelection, signal: AbortSignal) {
  const current = await readActiveApproval(db, selection.key, ownerAnswerApprovalsEnabled, signal);
  return !!current && canonicalHash(current.approval.reviewed_answer) === selection.digest;
}
