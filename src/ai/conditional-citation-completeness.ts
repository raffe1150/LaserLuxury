import type {AnswerUnit, Evidence} from './business-information-answer-plan';
import {resolveEvidenceQuote} from './knowledge-citation';
import {assessNumericalConstraint} from './numerical-constraints';

type Ref = AnswerUnit['evidenceRefs'][number];
const normalized = (s:string) => s.normalize('NFC').replace(/\s+/gu,' ').trim();
// A closed semantic frame, not general coreference resolution. Unknown wording,
// extra conditions/consequences and additional sentences remain fail-closed.
// Quantities are dynamic; no tenant, source ID, threshold or question is special.
const claimFrames = [
 /^La (?:visita|cita) no se cancela automáticamente (?:por|debido a) un retraso de más de (\d+) minutos; el personal (?:debe|necesita) (?:evaluar|valorar) primero la situación\.$/u,
 /^(?:With|For) more than (\d+) minutes of delay, the (?:appointment|visit) is not automatically cancelled; staff (?:must|need to) first (?:assess|evaluate) the situation\.$/u,
 /^Vid mer än (\d+) minuter försening avbokas besöket inte automatiskt; personalen behöver först bedöma situationen\.$/u,
 /^Bei mehr als (\d+) Minuten Verspätung wird der Termin nicht automatisch storniert; das Personal muss zuerst die Situation beurteilen\.$/u,
 /^با بیش از (\d+) دقیقه تأخیر، نوبت به طور خودکار لغو نمی‌شود؛ کارکنان باید ابتدا وضعیت را ارزیابی کنند\.$/u,
 /^مع التأخر أكثر من (\d+) دقيقة لا يلغى الموعد تلقائيا؛ يجب على الموظفين تقييم الوضع أولا\.$/u,
];
const digits = (s:string) => s.replace(/[۰-۹٠-٩]/gu,c=>String(c.charCodeAt(0)-(c>='۰'?0x6f0:0x660)));
const conditionFrame = /^(?:Vid|Vid fall av) en försening på mer än (\d+) minuter kan (?:studion|personalen) behöva göra en ny bedömning av om besöket kan genomföras enligt plan\.$/u;
const consequenceFrame = /^(?:Detta|Det) innebär inte att besöket automatiskt avbokas\. Personalen behöver först bedöma situationen\.$/u;

/** Complete only a recognized explicit anaphoric policy binding within ONE
 * canonical source range. This grants no entailment, coverage or publication:
 * the unchanged claim and completed refs still require independent verification.
 * Called only after every original citation has validated. */
export function completeConditionalCitations(
 candidate: Pick<AnswerUnit,'text'|'modality'|'negation'>, refs: readonly Ref[],
 evidence: readonly Evidence[], businessId:number,
): readonly Ref[] {
 if (!Number.isSafeInteger(businessId) || businessId<=0 || refs.length>=4 || candidate.modality!=='descriptive' || !candidate.negation) return refs;
 const text=digits(normalized(candidate.text));
 const claim=claimFrames.map(frame=>text.match(frame)).find(Boolean);
 if (!claim || !Number.isSafeInteger(Number(claim[1])) || Number(claim[1])<=0) return refs;
 if (new Set(evidence.map(e=>e.id)).size!==evidence.length || evidence.some(e=>e.businessId!==businessId)) return refs;
 const initial=assessNumericalConstraint(candidate.text,candidate.text,refs.map(r=>({source:'retrieved_knowledge',quote:r.exactQuote})));
 if (initial.safe || initial.reason!=='SOURCE_CONSTRAINT_UNAVAILABLE') return refs;
 const possibilities: Ref[]=[];
 for (const ref of refs) {
  const e=evidence.find(e=>e.id===ref.evidenceId);
  if (!e || !e.version || ref.sourceId!==e.sourceId || ref.version!==e.version || ref.chunkId!==e.chunkId ||
   evidence.some(other=>other.sourceId===e.sourceId && other.version!==e.version)) continue;
  if (!consequenceFrame.test(normalized(ref.exactQuote))) continue;
  const consequence=resolveEvidenceQuote(e.text,ref.exactQuote);
  if (!consequence.quote || consequence.start===undefined || consequence.end===undefined) continue;
  // Immediately preceding complete sentence, with whitespace only between it
  // and the explicitly anaphoric consequence. Never search another chunk.
  const prefix=e.text.slice(0,consequence.start).trimEnd();
  if (!prefix.endsWith('.')) continue;
  const end=prefix.length, prior=prefix.slice(0,-1).search(/[^.!?]*$/u);
  const start=prior<0?0:prior;
  const quote=prefix.slice(start,end).trim();
  const condition=normalized(quote).match(conditionFrame);
  if (!condition || Number(condition[1])!==Number(claim[1])) continue;
  const antecedent=resolveEvidenceQuote(e.text,quote);
  if (!antecedent.quote || antecedent.start===undefined || antecedent.end===undefined ||
   e.text.slice(antecedent.end,consequence.start).trim() ||
   e.citationRanges && !e.citationRanges.some(r=>antecedent.start!>=r.start && consequence.end!<=r.end)) continue;
  possibilities.push(Object.freeze({...ref,exactQuote:antecedent.quote}));
 }
 if (possibilities.length!==1) return refs;
 const completed=[...refs,possibilities[0]];
 // Reapply the existing numerical grammar, including comparator strictness.
 if (!assessNumericalConstraint(candidate.text,candidate.text,completed.map(r=>({source:'retrieved_knowledge',quote:r.exactQuote}))).safe) return refs;
 return Object.freeze(completed);
}
