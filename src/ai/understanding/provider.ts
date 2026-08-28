import type { CanonicalStructuredUnderstanding } from './types';

export type UnderstandingInputMode = 'text' | 'voice';

export type CompactBookingSemanticContext = {
  bookingPhase: string;
  offeredSlotCount: number;
  selectedSlotPresent: boolean;
  knownFields: Array<'service' | 'date' | 'time' | 'name' | 'phone'>;
};

export type UnderstandingProviderInput = {
  message: string;
  inputMode: UnderstandingInputMode;
  activeLanguage?: string;
  timezone: string;
  currentTimeIso: string;
  configuredServices: string[];
  context: CompactBookingSemanticContext;
};

export type UnderstandingProviderCallOptions = Readonly<{
  signal: AbortSignal;
}>;

export interface UnderstandingProvider {
  readonly providerId: string;

  // Provider output remains unknown until the strict decoder accepts it.
  interpret(
    input: UnderstandingProviderInput,
    options: UnderstandingProviderCallOptions,
  ): Promise<unknown>;
}

export type ValidatedUnderstandingProviderOutput = CanonicalStructuredUnderstanding;
