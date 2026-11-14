import type { LanguageBrainResolution } from '../../language-brain';
import { SEMANTIC_VERSION, type Binding, type Field, type Intent, type Missing, type Parameter,
  type ParametersByField, type QuestionType, type ReferenceOption, type Route } from '../semantic/contracts';

export type EvidenceStatus = 'UNVERIFIED' | 'VERIFIED_FOR_TURN' | 'UNSUPPORTED';
export type ObligationState = Readonly<{
  id: string;
  intent: Intent;
  questionType?: QuestionType;
  polarity?: 'positive' | 'negative';
  hasSuspectedPremise: boolean;
  conditions: readonly Readonly<{ kind: 'if' | 'unless' | 'while'; explicit: boolean }>[];
  evidence: EvidenceStatus;
  state: 'OPEN' | 'RESOLVED';
}>;

export type PendingClarification = Readonly<{ field: Missing; firstTurn: number; lastTurn: number }>;
export type Goal = Readonly<{
  id: string;
  kind: ReferenceOption['kind'];
  intent: Intent;
  lastTurn: number;
  updatedAtMs: number;
  parameters: ParametersByField;
  topics: ReferenceOption['topics'];
  obligations: readonly ObligationState[];
  pending?: PendingClarification;
}>;

export type TurnMemory = Readonly<{
  turn: number;
  atMs: number;
  primary: Intent;
  secondary: readonly Intent[];
  referencedGoalIds: readonly string[];
  obligationIds: readonly string[];
}>;

export type TurnFrame = Readonly<{
  version: typeof SEMANTIC_VERSION;
  binding: Binding;
  turn: number;
  updatedAtMs: number;
  language: LanguageBrainResolution;
  lifecycle: 'OPEN' | 'CLOSED';
  currentIntent: Intent;
  previousIntent?: Intent;
  activeGoalId?: string;
  goals: readonly Goal[];
  recent: readonly TurnMemory[];
  corrections: readonly Readonly<{ turn: number; goalId: string; field: Field; previous: Parameter }>[];
}>;

export type Guidance =
  | Readonly<{ kind: 'CHECK_KNOWLEDGE'; obligationId: string }>
  | Readonly<{ kind: 'ANSWER_CANDIDATE'; obligationId: string }>
  | Readonly<{ kind: 'DISCLOSE_UNSUPPORTED'; obligationId: string }>
  | Readonly<{ kind: 'ASK' | 'WAIT_FOR_CLARIFICATION'; obligationId: string; field: Missing }>
  | Readonly<{ kind: 'REFER_TO_BOOKING_AUTHORITY'; obligationId: string; route: Route }>
  | Readonly<{ kind: 'CORRECTION'; obligationId: string; goalId: string; updated: readonly Field[] }>
  | Readonly<{ kind: 'CLOSE'; obligationId: string }>;
