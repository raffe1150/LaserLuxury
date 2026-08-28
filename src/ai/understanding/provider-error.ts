export type StructuredUnderstandingFailureCategory =
  | 'disabled'
  | 'missing_configuration'
  | 'timeout'
  | 'provider_error'
  | 'malformed_response'
  | 'schema_validation_failed';

export class StructuredUnderstandingProviderError extends Error {
  constructor(public readonly category: StructuredUnderstandingFailureCategory) {
    super(`Structured understanding failed (${category})`);
    this.name = 'StructuredUnderstandingProviderError';
  }
}
