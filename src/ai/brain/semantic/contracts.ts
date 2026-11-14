import type { BusinessInformationTopic } from '../../business-information';
import type { UnderstandingIntent } from '../../understanding/types';
import type { SupportedConversationLanguage } from '../../language-brain';
import type { NormalizedBookingRequest, NormalizedTimeConstraint } from '../../booking-intelligence';

export const SEMANTIC_VERSION = 1 as const;
export const SEMANTIC_LIMITS = Object.freeze({
  inputChars: 2400, proposalChars: 8192, obligations: 6, conditions: 3, recentTurns: 8,
  goals: 4, goalObligations: 8, corrections: 6, frameBytes: 16_384,
  recentMs: 15 * 60_000, taskMs: 30 * 60_000,
});

export type Intent = UnderstandingIntent | 'correction' | 'close';
export type Route = Extract<Intent, 'new_booking' | 'availability' | 'booking_lookup' | 'reschedule' | 'cancellation'>;
export type QuestionType = 'description' | 'recommendation' | 'requirement' | 'permission' | 'prohibition';
export type Span = Readonly<{ start: number; end: number }>; // UTF-16 offsets in the current turn
export type Field = 'service' | 'staff' | 'date' | 'time';
export type Missing = Field | 'reference' | 'intent' | 'conflict';
export type Condition = Readonly<{ kind: 'if' | 'unless' | 'while'; explicit: boolean; span: Span }>;
export type Reading = Readonly<{
  intent: Intent;
  span: Span;
  questionType?: QuestionType;
  polarity?: 'positive' | 'negative';
  premise?: Span; // suspected premise, never a verified claim or a verified falsehood
  conditions?: readonly Condition[];
  reference?: number; // index in the bounded request's reference options
  missing?: Missing;
  change?: readonly Field[];
  entities?: Readonly<Partial<Record<Field, Span>>>;
}>;
export type Binding = Readonly<{ tenantId: number; conversationId: string }>;
export type Catalog = Readonly<{ services: readonly CatalogItem[]; staff: readonly CatalogItem[] }>;
export type CatalogItem = Readonly<{ id: string; label: string }>;
export type DateValue = Readonly<Pick<NonNullable<NormalizedBookingRequest['date']>, 'kind' | 'value' | 'endValue'>>;
export type TimeValue = Readonly<Omit<NormalizedTimeConstraint, 'confidence'>>;
export type Parameter = Readonly<{
  value: string | DateValue | TimeValue;
  provenance: 'USER_STATED' | 'USER_SPAN_INTERPRETED';
  turn: number;
  atMs: number;
}>;
export type ParametersByField = Readonly<Partial<Record<Field, Parameter>>>;
export type ReferenceOption = Readonly<{
  goalId: string;
  kind: 'information' | 'booking';
  intent: Intent;
  lastTurn: number;
  parameters: ParametersByField;
  topics: readonly BusinessInformationTopic[];
  questionTypes: readonly QuestionType[];
  waitingFor: readonly Missing[];
}>;
export type InterpretationRequest = Readonly<{
  version: 1;
  text: string;
  language: SupportedConversationLanguage;
  references: readonly ReferenceOption[];
  limits: Readonly<{ obligations: number; conditionsPerObligation: number; outputChars: number }>;
}>;
/** External adapter seam. Phase 3 only accepts a locally supplied response.
 * The caller owns admission, deadlines and any future transport. */
export type InterpretationPort = (request: InterpretationRequest, signal: AbortSignal) => Promise<unknown>;
