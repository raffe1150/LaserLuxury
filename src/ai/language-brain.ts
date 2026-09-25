export const SUPPORTED_CONVERSATION_LANGUAGES = [
  'sv',
  'en',
  'de',
  'es',
  'fa',
  'ar',
] as const;

export type SupportedConversationLanguage =
  typeof SUPPORTED_CONVERSATION_LANGUAGES[number];

export type SemanticLanguageDecision = Readonly<{
  language?: string | null;
  requestedReplyLanguage?: string | null;
  confidence: number;
}>;

export type LanguageBrainSource =
  | 'explicit_switch'
  | 'protected_previous'
  | 'deterministic'
  | 'semantic_requested_reply'
  | 'semantic_language'
  | 'previous'
  | 'business_fallback'
  | 'english_fallback';

export type LanguageBrainResolution = Readonly<{
  language: SupportedConversationLanguage;
  source: LanguageBrainSource;
}>;

export type ResolveLanguageBrainInput = Readonly<{
  text: string;
  previousLanguage?: string | null;
  businessFallback?: string | null;
  explicitSwitch?: string | null;
  deterministicLanguage?: string | null;

  /**
   * True when the existing deterministic conversation guards say this turn
   * must not change an established language (short confirmation, name,
   * phone, date, time, etc.).
   */
  preservePrevious: boolean;

  /**
   * Semantic classification is deliberately opt-in. The caller should only
   * enable it when deterministic language evidence is insufficient.
   */
  semanticEligible: boolean;

  semanticResolver?: (
    text: string,
  ) => Promise<SemanticLanguageDecision | null>;
}>;

const SEMANTIC_LANGUAGE_CONFIDENCE = 0.85;

export function normalizeConversationLanguage(
  value?: string | null,
): SupportedConversationLanguage | null {
  const normalized = String(value || '').trim().toLowerCase();

  return (SUPPORTED_CONVERSATION_LANGUAGES as readonly string[]).includes(
    normalized,
  )
    ? normalized as SupportedConversationLanguage
    : null;
}

function usableSemanticConfidence(value: number): boolean {
  return Number.isFinite(value) &&
    value >= SEMANTIC_LANGUAGE_CONFIDENCE &&
    value <= 1;
}

export async function resolveLanguageBrain(
  input: ResolveLanguageBrainInput,
): Promise<LanguageBrainResolution> {
  const explicitSwitch =
    normalizeConversationLanguage(input.explicitSwitch);

  if (explicitSwitch) {
    return {
      language: explicitSwitch,
      source: 'explicit_switch',
    };
  }

  const previous =
    normalizeConversationLanguage(input.previousLanguage);

  if (input.preservePrevious && previous) {
    return {
      language: previous,
      source: 'protected_previous',
    };
  }

  const deterministic =
    normalizeConversationLanguage(input.deterministicLanguage);

  if (deterministic) {
    return {
      language: deterministic,
      source: 'deterministic',
    };
  }

  if (
    input.semanticEligible &&
    String(input.text || '').trim() &&
    input.semanticResolver
  ) {
    try {
      const semantic = await input.semanticResolver(input.text);

      if (
        semantic &&
        usableSemanticConfidence(semantic.confidence)
      ) {
        const requestedReplyLanguage =
          normalizeConversationLanguage(
            semantic.requestedReplyLanguage,
          );

        if (requestedReplyLanguage) {
          return {
            language: requestedReplyLanguage,
            source: 'semantic_requested_reply',
          };
        }

        const semanticLanguage =
          normalizeConversationLanguage(semantic.language);

        if (semanticLanguage) {
          return {
            language: semanticLanguage,
            source: 'semantic_language',
          };
        }
      }
    } catch {
      // Semantic language resolution is fail-open.
      // Existing deterministic conversation behavior remains authoritative.
    }
  }

  if (previous) {
    return {
      language: previous,
      source: 'previous',
    };
  }

  const businessFallback =
    normalizeConversationLanguage(input.businessFallback);

  if (businessFallback) {
    return {
      language: businessFallback,
      source: 'business_fallback',
    };
  }

  return {
    language: 'en',
    source: 'english_fallback',
  };
}
