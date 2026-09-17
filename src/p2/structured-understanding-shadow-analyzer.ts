import type {
  CanonicalStructuredUnderstanding,
  UnderstandingFact,
  UnderstandingIntent,
} from "../ai/understanding/types";

import type {
  UnderstandingProvider,
  UnderstandingProviderInput,
} from "../ai/understanding/provider";

import {
  decodeCanonicalStructuredUnderstanding,
} from "../ai/understanding/validation";

import type {
  P2ShadowAnalyzer,
  P2ShadowDecision,
  P2ShadowEvent,
} from "./shadow-evaluator";

export class P2StructuredUnderstandingShadowAnalyzerError
  extends Error {
  readonly code =
    "P2_STRUCTURED_UNDERSTANDING_SHADOW_ANALYZER_ERROR";

  constructor(
    message: string,
    readonly causeCode:
      | "message_required"
      | "invalid_provider_input"
      | "schema_validation_failed",
  ) {
    super(message);
    this.name =
      "P2StructuredUnderstandingShadowAnalyzerError";
  }
}

export interface P2StructuredUnderstandingShadowAnalyzerOptions {
  provider: UnderstandingProvider;
}

type ShadowProviderPayload = {
  text?: unknown;
  activeLanguage?: unknown;
  timezone?: unknown;
  currentTimeIso?: unknown;
  configuredServices?: unknown;
  bookingPhase?: unknown;
  offeredSlotCount?: unknown;
  selectedSlotPresent?: unknown;
  knownFields?: unknown;
};

const BOOKING_INTENTS =
  new Set<UnderstandingIntent>([
    "new_booking",
    "availability",
    "booking_lookup",
    "reschedule",
    "cancellation",
  ]);

function cleanString(
  value: unknown,
): string | undefined {
  const normalized =
    String(value ?? "").trim();

  return normalized || undefined;
}

function validateKnownFields(
  value: unknown,
): UnderstandingProviderInput["context"]["knownFields"] {
  if (!Array.isArray(value)) return [];

  const allowed = new Set([
    "service",
    "date",
    "time",
    "name",
    "phone",
  ]);

  return value
    .map((item) =>
      cleanString(item),
    )
    .filter(
      (
        item,
      ): item is
        UnderstandingProviderInput["context"]["knownFields"][number] =>
        Boolean(
          item &&
            allowed.has(item),
        ),
    );
}

function providerInputFromEvent(
  event: P2ShadowEvent,
): UnderstandingProviderInput {
  const payload =
    event.payload as ShadowProviderPayload;

  const message =
    cleanString(payload.text);

  if (!message) {
    throw new P2StructuredUnderstandingShadowAnalyzerError(
      "Shadow message text is required.",
      "message_required",
    );
  }

  const timezone =
    cleanString(payload.timezone);

  if (!timezone) {
    throw new P2StructuredUnderstandingShadowAnalyzerError(
      "Business timezone is required for shadow understanding.",
      "invalid_provider_input",
    );
  }

  const currentTimeIso =
    cleanString(
      payload.currentTimeIso,
    ) || event.receivedAt;

  const parsedTime =
    Date.parse(currentTimeIso);

  if (!Number.isFinite(parsedTime)) {
    throw new P2StructuredUnderstandingShadowAnalyzerError(
      "Invalid shadow current time.",
      "invalid_provider_input",
    );
  }

  const configuredServices =
    Array.isArray(
      payload.configuredServices,
    )
      ? payload.configuredServices
          .map((item) =>
            cleanString(item),
          )
          .filter(
            (
              item,
            ): item is string =>
              Boolean(item),
          )
          .slice(0, 50)
      : [];

  const offeredSlotCount =
    Number(
      payload.offeredSlotCount ??
        0,
    );

  if (
    !Number.isInteger(
      offeredSlotCount,
    ) ||
    offeredSlotCount < 0
  ) {
    throw new P2StructuredUnderstandingShadowAnalyzerError(
      "Invalid offered slot count.",
      "invalid_provider_input",
    );
  }

  return {
    message,
    inputMode: "text",
    ...(cleanString(
      payload.activeLanguage,
    )
      ? {
          activeLanguage:
            cleanString(
              payload.activeLanguage,
            ),
        }
      : {}),
    timezone,
    currentTimeIso:
      new Date(
        parsedTime,
      ).toISOString(),
    configuredServices,
    context: {
      bookingPhase:
        cleanString(
          payload.bookingPhase,
        ) || "idle",
      offeredSlotCount,
      selectedSlotPresent:
        payload.selectedSlotPresent ===
        true,
      knownFields:
        validateKnownFields(
          payload.knownFields,
        ),
    },
  };
}

function strongestIntent(
  understanding:
    CanonicalStructuredUnderstanding,
): UnderstandingFact<UnderstandingIntent> | undefined {
  return understanding.intents
    .slice()
    .sort(
      (left, right) =>
        right.confidence -
        left.confidence,
    )[0];
}

function taskTypeFromUnderstanding(
  understanding:
    CanonicalStructuredUnderstanding,
): string | null {
  const intents =
    understanding.intents.map(
      (entry) => entry.value,
    );

  if (
    intents.some((intent) =>
      BOOKING_INTENTS.has(intent),
    ) ||
    understanding.acts
      .bookingRequest?.value ===
      true ||
    understanding.acts
      .bookingConfirmation
  ) {
    return "booking";
  }

  if (
    intents.includes(
      "general_question",
    )
  ) {
    return "support";
  }

  return "unknown";
}

function operationTypeFromUnderstanding(
  understanding:
    CanonicalStructuredUnderstanding,
): string | null {
  const ranked =
    understanding.intents
      .filter((entry) =>
        BOOKING_INTENTS.has(
          entry.value,
        ),
      )
      .slice()
      .sort(
        (left, right) =>
          right.confidence -
          left.confidence,
      );

  return ranked[0]?.value ?? null;
}

function confidenceFromUnderstanding(
  understanding:
    CanonicalStructuredUnderstanding,
): number {
  const primaryIntent =
    strongestIntent(
      understanding,
    );

  if (primaryIntent) {
    return primaryIntent.confidence;
  }

  const bookingRequest =
    understanding.acts
      .bookingRequest;

  if (bookingRequest) {
    return bookingRequest.confidence;
  }

  const confirmation =
    understanding.acts
      .bookingConfirmation;

  if (confirmation) {
    return confirmation.confidence;
  }

  return understanding.language.primary
    .confidence;
}

export class P2StructuredUnderstandingShadowAnalyzer
  implements P2ShadowAnalyzer {
  constructor(
    private readonly options:
      P2StructuredUnderstandingShadowAnalyzerOptions,
  ) {}

  async analyze(
    event: P2ShadowEvent,
  ): Promise<P2ShadowDecision> {
    const input =
      providerInputFromEvent(
        event,
      );

    const controller =
      new AbortController();

    const raw =
      await this.options.provider.interpret(
        input,
        {
          signal:
            controller.signal,
        },
      );

    const decoded =
      decodeCanonicalStructuredUnderstanding(
        raw,
      );

    if (!decoded.ok) {
      throw new P2StructuredUnderstandingShadowAnalyzerError(
        "Structured understanding failed canonical validation.",
        "schema_validation_failed",
      );
    }

    const understanding =
      decoded.value;

    const primaryIntent =
      strongestIntent(
        understanding,
      );

    return {
      languageCode:
        understanding.language
          .primary.value,
      taskType:
        taskTypeFromUnderstanding(
          understanding,
        ),
      operationType:
        operationTypeFromUnderstanding(
          understanding,
        ),
      // Structured Understanding describes semantic meaning,
      // not the verified outcome of a booking operation.
      outcome: null,
      confidence:
        confidenceFromUnderstanding(
          understanding,
        ),
      metadata: {
        structuredUnderstandingSchemaVersion:
          understanding.schemaVersion,
        provider:
          this.options.provider
            .providerId,
        primaryIntent:
          primaryIntent?.value ??
          null,
        primaryIntentConfidence:
          primaryIntent?.confidence ??
          null,
        bookingConfirmation:
          understanding.acts
            .bookingConfirmation?.value ??
          null,
        bookingConfirmationConfidence:
          understanding.acts
            .bookingConfirmation?.confidence ??
          null,
        bookingRequest:
          understanding.acts
            .bookingRequest?.value ??
          null,
        bookingRequestConfidence:
          understanding.acts
            .bookingRequest?.confidence ??
          null,
        ambiguityCount:
          understanding.ambiguities
            .length,
      },
    };
  }
}
