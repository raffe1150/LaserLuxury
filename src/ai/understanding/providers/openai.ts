import { generateWithConfiguredProvider } from '../../providers/router';
import type {
  UnderstandingProvider,
  UnderstandingProviderCallOptions,
  UnderstandingProviderInput,
} from '../provider';
import { StructuredUnderstandingProviderError } from '../provider-error';
import { decodeCanonicalStructuredUnderstanding } from '../validation';
import {
  STRUCTURED_UNDERSTANDING_SYSTEM_INSTRUCTION,
  structuredUnderstandingProviderContents,
} from './shared';
import {
  STRUCTURED_UNDERSTANDING_WIRE_SCHEMA,
  decodeStructuredUnderstandingWire,
  mapStructuredUnderstandingWireToCanonical,
} from './wire';

export type OpenAiUnderstandingTransportRequest = {
  model: string;
  systemInstruction: string;
  contents: string;
  responseJsonSchema: unknown;
};

export interface OpenAiUnderstandingTransport {
  generate(
    request: OpenAiUnderstandingTransportRequest,
    signal: AbortSignal,
  ): Promise<unknown>;
}

class UnifiedOpenAiUnderstandingTransport implements OpenAiUnderstandingTransport {
  async generate(
    request: OpenAiUnderstandingTransportRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    const response = await generateWithConfiguredProvider({
      model: request.model,
      systemInstruction: request.systemInstruction,
      messages: [{ role: 'user', content: request.contents }],
      structuredOutput: {
        name: 'odinlink_structured_understanding',
        description: 'Structured semantic understanding of the current customer turn.',
        schema: request.responseJsonSchema as Record<string, unknown>,
        strict: false,
      },
      temperature: 0,
      signal,
    });

    return response.text;
  }
}

export function createUnifiedOpenAiUnderstandingTransport(): OpenAiUnderstandingTransport {
  return new UnifiedOpenAiUnderstandingTransport();
}

export type OpenAiUnderstandingProviderOptions = {
  model: string;
  transport: OpenAiUnderstandingTransport;
};

export class OpenAiUnderstandingProvider implements UnderstandingProvider {
  readonly providerId = 'openai';

  constructor(private readonly options: OpenAiUnderstandingProviderOptions) {
    if (!options.model.trim()) {
      throw new StructuredUnderstandingProviderError('missing_configuration');
    }
  }

  async interpret(
    input: UnderstandingProviderInput,
    options: UnderstandingProviderCallOptions,
  ): Promise<unknown> {
    try {
      const response = await this.options.transport.generate({
        model: this.options.model,
        systemInstruction: STRUCTURED_UNDERSTANDING_SYSTEM_INSTRUCTION,
        contents: structuredUnderstandingProviderContents(input),
        responseJsonSchema: STRUCTURED_UNDERSTANDING_WIRE_SCHEMA,
      }, options.signal);

      if (typeof response !== 'string' || !response.trim()) {
        throw new StructuredUnderstandingProviderError('malformed_response');
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(response);
      } catch {
        throw new StructuredUnderstandingProviderError('malformed_response');
      }

      const wire = decodeStructuredUnderstandingWire(parsed);
      if (!wire.ok) {
        throw new StructuredUnderstandingProviderError('schema_validation_failed');
      }

      const decoded = decodeCanonicalStructuredUnderstanding(
        mapStructuredUnderstandingWireToCanonical(wire.value, input.message),
      );
      if (!decoded.ok) {
        throw new StructuredUnderstandingProviderError('schema_validation_failed');
      }

      return decoded.value;
    } catch (error) {
      if (error instanceof StructuredUnderstandingProviderError) throw error;
      if (options.signal.aborted) {
        throw new StructuredUnderstandingProviderError('timeout');
      }
      throw new StructuredUnderstandingProviderError('provider_error');
    }
  }
}
