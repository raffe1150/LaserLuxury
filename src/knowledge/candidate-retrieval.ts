/** Backend-selected retrieval only. Neither candidates nor scores grant answer authority. */
export const CANDIDATE_RETRIEVAL_POLICY = 'candidate-top5-v1' as const;
export type CandidateRetrievalPolicy = typeof CANDIDATE_RETRIEVAL_POLICY;
export type CandidateFallback = Readonly<{
  policy: CandidateRetrievalPolicy;
  /** True only after a successful ordinary lexical lookup returned no evidence. */
  lexicalEmpty: Promise<boolean>;
}>;
export type RetrievalObservation = Readonly<{
  origin: 'strict-semantic' | 'candidate';
  count: number;
  policy?: CandidateRetrievalPolicy;
}>;
export function selectCandidateRetrievalPolicy(value: string | undefined): CandidateRetrievalPolicy | undefined {
  if (value === undefined || value === '') return undefined;
  if (value !== CANDIDATE_RETRIEVAL_POLICY) throw new Error('knowledge_retrieval_policy_unsupported');
  return CANDIDATE_RETRIEVAL_POLICY;
}
