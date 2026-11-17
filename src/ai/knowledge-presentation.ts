/** Verified natural presentation, Tier A (S2). Zero-model and pure.
 *
 * Runs only on an already publishable, frozen AnswerManifest. It may only
 * (1) regroup verified unit texts and backend limitation notices by the
 * question they answer, in plan order, and (2) insert a fixed, reviewed,
 * fact-free transition before the 2nd..4th question. Every verified text is
 * kept byte-for-byte and exactly once; nothing is paraphrased, added or
 * removed. Any unsupported shape or failed check returns null, and the caller
 * keeps the canonical text unchanged. */
import type { AnswerManifest } from './business-information-answer-plan';

export type PresentationMode = 'off' | 'shadow' | 'active';
export const KNOWLEDGE_PRESENTATION_FLAG = 'ODINLINK_KNOWLEDGE_PRESENTATION';
export const KNOWLEDGE_PRESENTATION_TENANTS = 'ODINLINK_KNOWLEDGE_PRESENTATION_TENANTS';
export const PRESENTATION_SCHEMA = 'knowledge-presentation-v1';
const MAX_CHARS = 1800;

/** Default OFF. Any unrecognised value is OFF. Shadow/active also require the
 * tenant to be on the explicit allowlist (comma-separated positive integers). */
export function knowledgePresentationConfig(env: Readonly<Record<string, string | undefined>> = process.env):
  Readonly<{ mode: PresentationMode; tenants: ReadonlySet<number> }> {
  const raw = env[KNOWLEDGE_PRESENTATION_FLAG];
  const mode: PresentationMode = raw === 'shadow' || raw === 'active' ? raw : 'off';
  const tenants = new Set((env[KNOWLEDGE_PRESENTATION_TENANTS] || '').split(',').map(s => s.trim())
    .filter(s => /^[1-9]\d{0,9}$/u.test(s)).map(Number));
  return Object.freeze({ mode, tenants });
}

// Reviewed Phase 5 transition wording (brain/response/compose.ts). Fact-free.
const otherQuestion: Record<string, string> = { en: 'On your other question:', sv: 'Om din andra fråga:', de: 'Zu Ihrer anderen Frage:',
  es: 'Sobre tu otra pregunta:', fa: 'دربارهٔ سؤال دیگرتان:', ar: 'بخصوص سؤالك الآخر:' };
const numbered: Record<string, string> = { en: 'Question', sv: 'Fråga', de: 'Frage', es: 'Pregunta', fa: 'سؤال', ar: 'السؤال' };
const localDigits: Record<string, (n: number) => string> = {
  fa: n => String(n).replace(/\d/gu, d => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]), ar: n => String(n).replace(/\d/gu, d => '٠١٢٣٤٥٦٧٨٩'[Number(d)]),
};
export function presentationTransition(language: string, questionIndex: number, questions: number): string | null {
  if (!otherQuestion[language] || questionIndex < 1 || questions < 2 || questions > 4) return null;
  if (questions === 2) return otherQuestion[language];
  return `${numbered[language]} ${(localDigits[language] ?? String)(questionIndex + 1)}:`;
}

export type PresentationReason = 'APPLIED' | 'SINGLE_QUESTION' | 'UNSUPPORTED_LANGUAGE' | 'UNSUPPORTED_SHAPE' |
  'CANONICAL_MISMATCH' | 'VALIDATION_FAILED' | 'LENGTH' | 'UNCHANGED';
export type PresentationResult = Readonly<{ text: string | null; reason: PresentationReason; facets: number; units: number; notices: number }>;

const count = (haystack: string, needle: string) => { let n = 0, at = haystack.indexOf(needle); while (at >= 0) { n++; at = haystack.indexOf(needle, at + needle.length); } return n; };
const digits = (s: string) => (s.replace(/[۰-۹]/gu, c => String(c.charCodeAt(0) - 0x6f0)).replace(/[٠-٩]/gu, c => String(c.charCodeAt(0) - 0x660)).match(/\d/gu) || []).sort().join('');

export function presentVerifiedManifest(manifest: AnswerManifest): PresentationResult {
  const language = manifest.language, facets = manifest.facets, units = manifest.units;
  const noticeKinds = [manifest.sourceLimitations, manifest.unresolvedRequirements, manifest.obligationLimitations].filter(n => n?.length);
  const notices = noticeKinds[0] ?? [];
  const result = (reason: PresentationReason, text: string | null = null): PresentationResult =>
    Object.freeze({ text, reason, facets: facets.length, units: units.length, notices: notices.length });
  if (!otherQuestion[language]) return result('UNSUPPORTED_LANGUAGE');
  if (facets.length < 2) return result('SINGLE_QUESTION');
  // Shapes with any other rendered element keep their canonical layout.
  if (noticeKinds.length > 1 || manifest.naturalAttachment || manifest.clarification || manifest.sourceScopeNotice ||
      manifest.unresolvedNoticeOnly || manifest.presentation.prefix !== 'none' || manifest.presentation.addition || !units.length ||
      facets.length > 4 || (!notices.length && manifest.outcomes.some(o => o.status !== 'VERIFIED'))) return result('UNSUPPORTED_SHAPE');
  const ordered = manifest.presentation.unitIds.map(id => units.find(u => u.id === id));
  if (ordered.length !== units.length || ordered.some(u => !u) || new Set(manifest.presentation.unitIds).size !== units.length) return result('UNSUPPORTED_SHAPE');
  if (notices.some(n => !facets.some(f => f.id === n.facetId))) return result('UNSUPPORTED_SHAPE');
  // Each verified unit belongs to the first planned question it answers.
  const groups = facets.map(f => ({ facet: f, texts: [] as string[] }));
  for (const u of ordered) {
    const index = facets.findIndex(f => u!.facetIds.includes(f.id));
    if (index < 0) return result('UNSUPPORTED_SHAPE');
    groups[index].texts.push(u!.text);
  }
  for (const n of [...new Set(notices.map(n => n.text))]) groups[facets.findIndex(f => f.id === notices.find(x => x.text === n)!.facetId)].texts.push(n);
  if (groups.some(g => !g.texts.length)) return result('UNSUPPORTED_SHAPE');
  const transitions: string[] = [];
  const paragraphs = groups.map((g, i) => {
    const t = i ? presentationTransition(language, i, groups.length) : null;
    if (t) transitions.push(t);
    return [t, ...g.texts].filter(Boolean).join(' ');
  });
  const text = paragraphs.join('\n\n');
  // Deterministic post-checks against the canonical, already-published text.
  const verified = [...ordered.map(u => u!.text), ...new Set(notices.map(n => n.text))];
  if (verified.some(v => count(manifest.text, v) < 1)) return result('CANONICAL_MISMATCH');
  if (verified.some(v => count(text, v) !== count(verified.join('\u0000'), v))) return result('VALIDATION_FAILED');
  let rest = text;
  for (const v of [...verified].sort((a, b) => b.length - a.length)) rest = rest.split(v).join('');
  for (const t of transitions) rest = rest.split(t).join('');
  if (rest.trim()) return result('VALIDATION_FAILED');
  let withoutTransitions = text;
  for (const t of transitions) withoutTransitions = withoutTransitions.split(t).join('');
  if (digits(withoutTransitions) !== digits(verified.join(' '))) return result('VALIDATION_FAILED');
  if (text.length > MAX_CHARS) return result('LENGTH');
  if (text === manifest.text) return result('UNCHANGED');
  return result('APPLIED', text);
}
