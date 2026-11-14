/**
 * Tier 1 — reply-language resolution through the REAL server-side authority
 * (prepareConversationLanguageForTurn via the existing test-only boundary).
 * Earlier turns are replayed in the same session, so language continuity is
 * exercised. The only external stage — the semantic LLM language resolver — is
 * withheld (returns null) and counted: any case where V1 consults it is
 * INDETERMINATE (model dependent), never PASS.
 * Requires NODE_ENV=test before import (the boundary refuses otherwise).
 */
import type { EvalCase, MetricResult } from './types';
import { tenantOf } from './corpus';

const FALLBACK_LANGUAGE: Record<number, string> = { 3: 'sv', 88: 'en', 99: 'en', 8802: 'sv' };

export async function evaluateServerLanguage(cases: readonly EvalCase[]): Promise<Map<string, MetricResult>> {
  if (process.env.NODE_ENV !== 'test') throw new Error('server language evaluation requires NODE_ENV=test');
  const { priority1hUnifiedEngineTestBoundary: b } = await import('../../../../server');
  const out = new Map<string, MetricResult>();
  for (const c of cases) {
    let semanticCalls = 0;
    b.reset();
    b.configure({ semanticLanguageResolver: async () => { semanticCalls++; return null; } } as any);
    const tenant = tenantOf(c.tenantId);
    const businessConfig = { id: `eval-${tenant}`, language: FALLBACK_LANGUAGE[tenant] ?? 'en', services: [] };
    const session = `eval-language:${c.id}`;
    for (const earlier of c.turns.slice(0, -1)) await b.prepareConversationLanguageForTest(session, earlier, businessConfig);
    semanticCalls = 0;
    const language = await b.prepareConversationLanguageForTest(session, c.turns[c.turns.length - 1], businessConfig);
    const ok = c.replyLanguages.includes(language as any);
    out.set(c.id, { metric: 'language', tier: 'T1_DETERMINISTIC', exercised: ['server.prepareConversationLanguageForTurn (test boundary)'],
      substituted: semanticCalls ? ['semantic LLM language resolver withheld (returned null)'] : [],
      evidence: { resolved: language, expected: c.replyLanguages, semanticResolverConsulted: semanticCalls > 0, businessFallback: businessConfig.language },
      grade: semanticCalls ? 'INDETERMINATE' : ok ? 'PASS' : 'FAIL',
      reason: semanticCalls ? `semantic_resolver_consulted_model_dependent_fallback_${language}` : ok ? 'resolved_language_matches' : `resolved_${language}_expected_${c.replyLanguages.join('|')}` });
  }
  b.reset();
  return out;
}
