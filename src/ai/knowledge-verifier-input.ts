/** Remove a redundant JSON-string envelope, never evidence or authority.
 * Full source text, exact citations, conflicts and nulls remain in the request. */
export function compactKnowledgeVerifierInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || !('authoritativeEvidence' in input) || typeof input.authoritativeEvidence !== 'string') return input;
  try {
    const authority = JSON.parse(input.authoritativeEvidence);
    if (authority && typeof authority === 'object' && !Array.isArray(authority)) return { ...input, authoritativeEvidence: authority };
  } catch { /* An unknown wire contract is never silently discarded. */ }
  return input;
}
