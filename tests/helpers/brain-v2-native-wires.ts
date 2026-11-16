import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { toOpenAiInput, routeOpenAiRequest, openAiReasoningEnabled } from '../../src/ai/providers/openai';
import { CONDITIONAL_EXEMPTION_GUIDANCE } from '../../src/ai/business-information-answer-plan';
import type { UnifiedAiGenerationRequest } from '../../src/ai/providers/provider';
import { normalizeConversationText } from '../../src/ai/booking-intelligence';
import { swedishKnowledgeFixture } from './brain-v2-knowledge';

/** Pure native-request wire checks shared by offline tests and the guarded
 * experimental runner. Validation and serialization only: no credentials, no
 * network, no ledger, no file system. A mismatched request throws. */
export const NATIVE_WIRE_MODEL = 'gpt-5.6-luna';
export const NATIVE_WIRE_OUTPUT_LIMIT = 8192;
const model = NATIVE_WIRE_MODEL;
const outputLimit = NATIVE_WIRE_OUTPUT_LIMIT;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type Stage = 'extraction' | 'verification';
export type ReferenceHistory = readonly { role: 'user' | 'assistant'; content: string }[];

export function boundedKnowledgeWire(request: UnifiedAiGenerationRequest, stage: Stage) {
  const route = routeOpenAiRequest(request.model, request);
  const schema = request.structuredOutput;
  if (route.model !== model || request.routingStage !== 'knowledge_' + stage || request.knowledgeExecution ||
      request.tools?.length || request.messages.length !== 1 || request.messages[0].role !== 'user' ||
      typeof request.messages[0].content !== 'string' || !request.systemInstruction ||
      !openAiReasoningEnabled(request, route) || !schema?.strict || schema.name !== 'odinlink_knowledge_' + stage + '_v2')
    throw new Error('KNOWLEDGE_STAGE_OR_WIRE_MISMATCH');
  return serializeWire(request, true);
}

export function serializeWire(request: UnifiedAiGenerationRequest, lowReasoning: boolean) {
  const schema = request.structuredOutput;
  const countBody = JSON.stringify({ model, instructions: request.systemInstruction, input: toOpenAiInput(request.messages),
    ...(lowReasoning ? { reasoning: { effort: 'low' } } : {}), truncation: 'disabled',
    ...(schema ? { text: { format: { type: 'json_schema', ...schema } } } : {}) });
  const body = JSON.stringify({ ...JSON.parse(countBody), store: false, stream: false,
    service_tier: 'default', prompt_cache_options: { mode: 'explicit' }, max_output_tokens: outputLimit });
  return { body, countBody, requestSha256: sha(body) };
}

export function customerEntryWire(request: UnifiedAiGenerationRequest, stage: Stage) {
  const payload = JSON.parse(request.messages[0]?.content ?? '');
  const fixture = swedishKnowledgeFixture;
  if (stage === 'extraction' && !request.systemInstruction?.includes(CONDITIONAL_EXEMPTION_GUIDANCE))
    throw Error('CUSTOMER_ENTRY_NATIVE_EXEMPTION_PROMPT_MISSING');
  if (payload.question !== fixture.first + ' ' + fixture.second || payload.requestedLanguage !== 'sv' ||
      !Array.isArray(payload.evidence) || payload.evidence.length !== fixture.sources.length ||
      !payload.evidence.every((item: { businessId: number; text: string }, index: number) =>
        item.businessId === 77 && item.text === fixture.sources[index]) ||
      !Array.isArray(payload.facets) || payload.facets.length !== 2 ||
      !payload.facets.every((facet: { id: string; questionType: string }, index: number) =>
        facet.id === 'f' + (index + 1) && facet.questionType === (index === 0 ? 'requirement' : 'recommendation')))
    throw Error('CUSTOMER_ENTRY_EVIDENCE_OR_SCOPE_MISMATCH');
  return boundedKnowledgeWire(request, stage);
}

export function fiveWire(request: UnifiedAiGenerationRequest, question: string, language: string, history: ReferenceHistory = []) {
  const instruction = request.systemInstruction ?? '';
  const schema = request.structuredOutput;
  const route = routeOpenAiRequest(request.model, request);
  if (route.model !== model || route.fallbackReason || request.tools?.length || request.knowledgeExecution ||
      request.messages.length !== 1 || request.messages[0].role !== 'user' || typeof request.messages[0].content !== 'string')
    throw Error('FIVE_PROVIDER_PIN');
  const body = request.messages[0].content;
  if (request.routingStage === 'general' && instruction.startsWith("You are OdinLink's language-routing classifier.") && !schema) {
    if (body !== question) throw Error('FIVE_LANGUAGE_INPUT_PIN');
    return { stage: 'language' as const, wire: serializeWire(request, openAiReasoningEnabled(request, route)) };
  }
  const input = JSON.parse(body);
  if (typeof input.question !== 'string' || normalizeConversationText(input.question) !== normalizeConversationText(question))
    throw Error('FIVE_QUESTION_PIN');
  if (request.routingStage === 'knowledge_planning' && schema?.strict) {
    if (schema.name === 'odinlink_source_query_v1' && input.targetLanguage === 'sv')
      return { stage: 'source-query' as const, wire: serializeWire(request, openAiReasoningEnabled(request, route)) };
    if (schema.name === 'odinlink_knowledge_planning_v2' && isDeepStrictEqual(input.referenceHistory, history))
      return { stage: 'planning' as const, wire: serializeWire(request, openAiReasoningEnabled(request, route)) };
  }
  if (input.requestedLanguage !== language) throw Error('FIVE_LANGUAGE_PIN');
  if (request.routingStage === 'general' && !schema && instruction.startsWith('OdinLink VERIFIED-UNIT PRESENTATION.'))
    return { stage: 'composition' as const, wire: serializeWire(request, openAiReasoningEnabled(request, route)) };
  if (!Array.isArray(input.evidence) || !input.evidence.length ||
      !input.evidence.every((row: { businessId: number; text: string }) =>
        row.businessId === 77 && typeof row.text === 'string' && row.text.length > 0))
    throw Error('FIVE_TENANT_OR_EVIDENCE_PIN');
  if (request.routingStage === 'knowledge_extraction' && instruction.includes(CONDITIONAL_EXEMPTION_GUIDANCE)) {
    if (history.length && !isDeepStrictEqual(input.relevantHistory, history)) throw Error('FIVE_EXTRACTION_HISTORY_PIN');
    return { stage: 'extraction' as const, wire: boundedKnowledgeWire(request, 'extraction') };
  }
  if (request.routingStage === 'knowledge_verification')
    return { stage: 'verification' as const, wire: boundedKnowledgeWire(request, 'verification') };
  throw Error('FIVE_UNAPPROVED_NATIVE_STAGE');
}
