/** Schema and ground-truth invariants for the evaluation corpus. Pure; read-only. */
import { EVAL_CHANNELS, EVAL_LANGUAGES, EVAL_SCHEMA_VERSION, QUESTION_TYPES, ROUTES, type EvalCase, type Fact } from './types';
import { FACTS } from './facts';
import { loadSources, source } from './sources';
import { tenantOf } from './corpus';

export type Issue = Readonly<{ id: string; problem: string }>;

const valueAt = (v: any, path: readonly (string | number)[]) => path.reduce((x, k) => (x == null ? undefined : x[k]), v);

/** Every fact is anchored: exact quote in its hashed source, or exact configuration value. */
export function validateFacts(facts: readonly Fact[] = FACTS): Issue[] {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const f of facts) {
    if (seen.has(f.id)) issues.push({ id: f.id, problem: 'duplicate fact id' });
    seen.add(f.id);
    let s;
    try { s = source(f.source); } catch { issues.push({ id: f.id, problem: `unknown source ${f.source}` }); continue; }
    if (s.tenantId !== f.tenantId) issues.push({ id: f.id, problem: 'fact tenant differs from source tenant' });
    if (!!f.quote === !!f.config) issues.push({ id: f.id, problem: 'fact must have exactly one of quote/config' });
    if (f.quote !== undefined && (s.kind === 'configuration' || !s.text.includes(f.quote))) issues.push({ id: f.id, problem: 'quote is not an exact substring of its source revision' });
    if (f.config && (s.kind !== 'configuration' || JSON.stringify(valueAt(f.config.path.length ? JSON.parse(s.text) : JSON.parse(s.text).map((x: any) => x.name), f.config.path))
      !== JSON.stringify(f.config.value))) issues.push({ id: f.id, problem: 'configuration value differs from its source snapshot' });
    if (!f.gloss.trim()) issues.push({ id: f.id, problem: 'missing reviewer gloss' });
  }
  return issues;
}

const factById = new Map(FACTS.map(f => [f.id, f]));
const status = (f: Fact) => source(f.source).status;

export function validateCase(c: EvalCase): Issue[] {
  const issues: Issue[] = [];
  const bad = (problem: string) => issues.push({ id: c.id, problem });
  if (c.schema !== EVAL_SCHEMA_VERSION) bad('schema version');
  if (!c.id || !c.semanticKey) bad('missing id/semanticKey');
  if (!EVAL_LANGUAGES.includes(c.language)) bad('language');
  if (!c.replyLanguages.length || !c.replyLanguages.every(l => EVAL_LANGUAGES.includes(l)) || !c.replyLanguages.includes(c.language) && c.family !== 'mixed_language') bad('reply languages');
  if (!EVAL_CHANNELS.includes(c.channel)) bad('channel');
  if (!c.turns.length || c.turns.some(t => !t.trim())) bad('turns');
  if (!c.obligations.length || c.obligations.length > 4) bad('obligation count must be 1..4');
  const tenant = tenantOf(c.tenantId);
  if (!loadSources().some(s => s.tenantId === tenant)) bad('tenant has no sources');
  for (const o of c.obligations) {
    if (o.expect === 'ROUTE') { if (!o.route || !ROUTES.includes(o.route) || o.facts.length) bad(`${o.id}: route obligation`); continue; }
    if (!o.questionType || !QUESTION_TYPES.includes(o.questionType)) bad(`${o.id}: question type`);
    const all = [...o.facts, ...(o.foreignFacts ?? [])];
    for (const id of all) if (!factById.has(id)) bad(`${o.id}: unknown fact ${id}`);
    const facts = all.map(id => factById.get(id)).filter((f): f is Fact => !!f);
    if ((o.expect === 'ANSWER' || o.expect === 'CORRECT_PREMISE') && !o.facts.length) bad(`${o.id}: ${o.expect} needs facts`);
    if (o.expect === 'REFUSE_FOREIGN') {
      if (!o.foreignFacts?.length) bad(`${o.id}: foreign facts required`);
      if (facts.some(f => f.tenantId === tenant)) bad(`${o.id}: foreign fact belongs to the case tenant`);
      continue;
    }
    if (facts.some(f => f.tenantId !== tenant)) bad(`${o.id}: fact from another tenant (tenant isolation)`);
    if (c.evidenceProfile === 'CURRENT' && facts.some(f => status(f) !== 'CURRENT')) bad(`${o.id}: non-current fact in CURRENT case`);
    if (c.evidenceProfile === 'STALE' && !facts.every(f => status(f) === 'HISTORICAL')) bad(`${o.id}: STALE case must cite only historical facts`);
    if (c.evidenceProfile === 'CONFLICTING' && o.expect === 'DISCLOSE' && !facts.some(f => status(f) === 'SYNTHETIC_NEGATIVE_CONTROL')) bad(`${o.id}: conflict needs the negative control`);
  }
  if (c.family === 'compound' && c.obligations.length < 2 && !c.provenance.question.includes('direct-conditional')) bad('compound needs >= 2 obligations');
  if (c.family === 'multiturn' && c.turns.length < 2) bad('multi-turn needs >= 2 turns');
  if (c.family === 'premise' && !c.obligations.some(o => o.expect === 'CORRECT_PREMISE')) bad('premise case without CORRECT_PREMISE');
  if (c.family === 'unverified' && c.obligations.some(o => o.expect === 'ANSWER')) bad('unverified case expects an answer');
  if (c.family === 'action' && !c.obligations.some(o => o.expect === 'ROUTE') && !c.categories.includes('information-not-action')) bad('action case without route');
  return issues;
}

export function validateCorpus(cases: readonly EvalCase[]): Issue[] {
  const issues = [...validateFacts(), ...cases.flatMap(validateCase)];
  const ids = new Set<string>();
  for (const c of cases) { if (ids.has(c.id)) issues.push({ id: c.id, problem: 'duplicate case id' }); ids.add(c.id); }
  const sig = (c: EvalCase) => JSON.stringify(c.obligations.map(o => [o.expect, o.questionType ?? o.route, [...o.facts].sort(), [...(o.foreignFacts ?? [])].sort()]));
  for (const c of cases) if (c.semanticKey !== c.id) {
    const base = cases.find(b => b.id === c.semanticKey);
    if (!base) issues.push({ id: c.id, problem: 'variant of unknown scenario' });
    else if (sig(base) !== sig(c) || tenantOf(base.tenantId) !== tenantOf(c.tenantId)) issues.push({ id: c.id, problem: 'variant changes the semantic obligations' });
  }
  return issues;
}

/** Strict distinctness: scenarios whose obligation signature AND evidence profile AND turn count are identical. */
export function semanticStats(cases: readonly EvalCase[]) {
  const scenarios = cases.filter(c => c.semanticKey === c.id);
  const strict = new Set(scenarios.map(c => JSON.stringify([tenantOf(c.tenantId), c.evidenceProfile, c.turns.length,
    c.obligations.map(o => [o.expect, o.questionType ?? o.route, [...o.facts].sort(), [...(o.foreignFacts ?? [])].sort()])])));
  return { instances: cases.length, scenarios: scenarios.length, strictObligationSignatures: strict.size, variants: cases.length - scenarios.length };
}
