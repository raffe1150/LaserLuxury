/** A deliberately narrow alias for an already ENTAILED ordinary check.
 * All request fields remain exact, including claim text, citations, corpus,
 * tenant, question and language. Only a plain claim's final full stop may vary
 * in its candidate quote. This never applies to requested-fact/coverage checks.
 * Callers must still validate the actual quote's boundaries and numerical rules.
 */
export function ordinaryEntailmentPunctuationKey<T extends {
  atomicClaim: string; candidateQuote: string; requireRequestedFact?: boolean;
  cancellationCoverage?: boolean; adjudication?: boolean;
}>(request: T): string | undefined {
  if (request.requireRequestedFact || request.cancellationCoverage || request.adjudication) return undefined;
  const claim = request.atomicClaim;
  // Exclude numbers, identifiers/URLs and internal sentence punctuation. Do not
  // normalize words, qualifiers, whitespace, citations or evidence ownership.
  if (!/^[^.!?؟。！？\r\n]+[\p{L}\p{M}]\.$/u.test(claim) || !/\s/u.test(claim) ||
      /\p{N}|https?:|www\.|@/iu.test(claim)) return undefined;
  if (request.candidateQuote !== claim && request.candidateQuote !== claim.slice(0, -1)) return undefined;
  return JSON.stringify({ ...request, candidateQuote: claim });
}

export function ordinaryEntailmentIsReusable(result: {
  relation: string; claimKind: string; explicitAbsenceEvidence?: boolean;
} | null | undefined, requestedKind: string): boolean {
  return result?.relation === 'ENTAILED' && ['OTHER', 'NEGATIVE_ABSENCE'].includes(result.claimKind) &&
    typeof result.explicitAbsenceEvidence === 'boolean' &&
    (requestedKind !== 'NEGATIVE_ABSENCE' && result.claimKind !== 'NEGATIVE_ABSENCE' || result.explicitAbsenceEvidence === true);
}
