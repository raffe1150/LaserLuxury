export const STRUCTURED_UNDERSTANDING_SCHEMA_VERSION = 1 as const;

export type UnderstandingConfidence = number;

export type UnderstandingEvidence = {
  start: number;
  end: number;
  explicit: boolean;
};

export type UnderstandingFact<T> = {
  value: T;
  confidence: UnderstandingConfidence;
  evidence?: UnderstandingEvidence[];
};

export type UnderstandingIntent =
  | 'new_booking'
  | 'availability'
  | 'booking_lookup'
  | 'reschedule'
  | 'cancellation'
  | 'general_question'
  | 'unknown';

export type UnderstandingDateValue = {
  kind: 'absolute' | 'weekday' | 'relative' | 'range';
  value?: string;
  endValue?: string;
  weekday?: number;
  relativeExpression?: string;
};

export type UnderstandingTimeValue = {
  kind: 'exact' | 'before' | 'after' | 'from' | 'between' | 'daypart';
  start?: string;
  end?: string;
  daypart?: 'morning' | 'afternoon' | 'evening';
};

export type UnderstandingSlotReferenceValue = {
  kind: 'ordinal' | 'deictic' | 'time';
  ordinal?: number;
  time?: string;
};

export type UnderstandingCorrectionValue = {
  kind: 'correction' | 'replacement' | 'mind_change';
  targets: Array<'service' | 'date' | 'time' | 'name' | 'phone' | 'slot'>;
};

export type CanonicalStructuredUnderstandingV1 = {
  schemaVersion: typeof STRUCTURED_UNDERSTANDING_SCHEMA_VERSION;
  language: {
    primary: UnderstandingFact<string>;
    codeSwitches: Array<{
      language: string;
      start: number;
      end: number;
      confidence: UnderstandingConfidence;
    }>;
  };
  intents: Array<UnderstandingFact<UnderstandingIntent>>;
  acts: {
    bookingRequest?: UnderstandingFact<boolean>;
    bookingConfirmation?: UnderstandingFact<'affirmed' | 'rejected' | 'unclear'>;
  };
  entities: {
    service?: UnderstandingFact<{ statedValue: string }>;
    date?: UnderstandingFact<UnderstandingDateValue>;
    time?: UnderstandingFact<UnderstandingTimeValue>;
    name?: UnderstandingFact<string>;
    phone?: UnderstandingFact<string>;
    slotReference?: UnderstandingFact<UnderstandingSlotReferenceValue>;
  };
  correction?: UnderstandingFact<UnderstandingCorrectionValue>;
  ambiguities: Array<{
    field: string;
    reason: string;
    confidence: UnderstandingConfidence;
    evidence?: UnderstandingEvidence[];
  }>;
};

export type CanonicalStructuredUnderstanding = CanonicalStructuredUnderstandingV1;
