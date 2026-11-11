import assert from 'node:assert/strict';
import test from 'node:test';
import { assessNumericalConstraint, numericalComparisonShapes } from './numerical-constraints';
const source='Kunder som besöker studion för första gången rekommenderas att komma cirka 10 minuter före sin bokade tid för att hinna förbereda sig i lugn och ro.';
const base=(n:string,qualifier='حدود')=>`به مراجعه‌کنندگان بار اول توصیه می‌شود ${qualifier} ${n} دقیقه قبل از نوبت رزروشده خود حاضر شوند`;
for(const n of ['۱۰','10','١٠'])test(`Persian comparison categories and unchanged acceptance: ${n}`,()=>{
 const approximate=assessNumericalConstraint(base(n)+'.',base(n)+'.',[source]);assert.equal(approximate.safe,true);
 for(const [qualifier,bound] of [['حداقل','minimum'],['حداکثر','maximum']] as const){
  const claim=base(n,qualifier)+'.';const assessment=assessNumericalConstraint(claim,claim,[source]);
  assert.equal(assessment.safe,false);assert.equal(assessment.reason,'SOURCE_BOUND_ANCHOR_OR_SCOPE_MISMATCH');
  const before=JSON.stringify(assessment),shapes=numericalComparisonShapes(assessment);
  assert.equal(JSON.stringify(assessment),before);assert.equal(shapes[0].candidateBound,bound);
  assert.equal(shapes[0].sourceBound,'unbounded');assert.equal(shapes[0].boundCompatible,false);
  assert.equal(shapes[0].temporalAnchorCompatible,true);assert.equal(shapes[0].sourceAmbiguous,false);
  assert.equal(shapes[0].cancellationKindCompatible,true);
 }
});
for(const n of ['۱۰','10','١٠'])test(`SYNTHETIC faithful preparation purpose clause has no upper bound: ${n}`,()=>{
 const claim=base(n)+' تا زمان کافی برای آماده شدن داشته باشند.';
 const assessment=assessNumericalConstraint(claim,claim,[source]);
 assert.equal(assessment.safe,true);
 const row=numericalComparisonShapes(assessment)[0];
 assert.equal(row.candidateBound,'unbounded');assert.equal(row.sourceBound,'unbounded');
 assert.equal(row.temporalAnchorCompatible,true);assert.equal(row.boundCompatible,true);
});
test('before/after mismatch is visible without exposing values',()=>{
 const claim=base('۱۰','حداقل').replace('قبل','بعد')+'.';
 const a=assessNumericalConstraint(claim,claim,[source]);assert.equal(a.safe,false);
 assert.equal(numericalComparisonShapes(a)[0].temporalAnchorCompatible,false);
});
test('source ambiguity is separate from matching bound and temporal side',()=>{
 const claim='Arrive at least 10 minutes before the appointment.';
 const a=assessNumericalConstraint(claim,claim,['Arrive at least 10 minutes before the appointment or contact us.']);
 assert.equal(a.safe,false);const row=numericalComparisonShapes(a)[0];
 assert.equal(row.sourceAmbiguous,true);assert.equal(row.boundCompatible,true);assert.equal(row.temporalAnchorCompatible,true);
});
test('cancellation-kind incompatibility is visible as a category',()=>{
 const claim='Cancellation is allowed at least 10 minutes before the appointment.';
 const a=assessNumericalConstraint(claim,claim,['Free cancellation is allowed at least 10 minutes before the appointment.']);
 assert.equal(a.safe,false);const row=numericalComparisonShapes(a)[0];
 assert.equal(row.candidateCancellationKind,'notice');assert.equal(row.sourceCancellationKind,'free_window');assert.equal(row.cancellationKindCompatible,false);
});
test('legitimate minimum equivalence remains accepted',()=>{
 const claim='Cancellation is allowed at least 10 minutes before the appointment.';
 assert.equal(assessNumericalConstraint(claim,claim,['Avbokning är tillåten minst 10 minuter före besöket.']).safe,true);
});
test('wrong quantity and unsupported comparisons remain rejected',()=>{
 for(const claim of [base('۲۰')+'.','Arrive between 10 and 20 minutes before your appointment.']){
  const a=assessNumericalConstraint(claim,claim,[source]);assert.equal(a.safe,false);
  const shapes=numericalComparisonShapes(a);assert.ok(shapes.length<=8);
 }
});
test('shape output is bounded, has no quantities/text, and does not mutate assessor output',()=>{
 const claim=base('۱۰','حداقل')+'.';const a=assessNumericalConstraint(claim,claim,Array(8).fill(source));const snapshot=JSON.stringify(a);
 const shapes=numericalComparisonShapes(a);assert.equal(shapes.length,8);assert.equal(JSON.stringify(a),snapshot);
 for(const s of shapes){assert.ok(s.candidateIndex<2&&s.sourceIndex<4);assert.ok(!('seconds'in s));}
 const serialized=JSON.stringify(shapes);assert.ok(!serialized.includes(claim));assert.ok(!serialized.includes(source));assert.ok(!serialized.includes('10'));
 assert.ok(Buffer.byteLength(serialized)<4500);
});

test('Persian marker diagnostics identify the rule that set the candidate bound', () => {
  const cases = [
    { claim: base('۱۰', 'حداکثر'), bound: 'maximum', category: 'explicit_maximum', position: 'before_quantity', branch: 'explicit_bound', safe: false },
    { claim: base('۱۰', 'حداقل'), bound: 'minimum', category: 'explicit_minimum', position: 'before_quantity', branch: 'explicit_bound', safe: false },
    { claim: base('۱۰', 'تا'), bound: 'maximum', category: 'persian_ta', position: 'before_quantity', branch: 'explicit_bound', safe: false },
    { claim: base('۱۰') + ' تا آماده شوند', bound: 'maximum', category: 'persian_ta', position: 'after_quantity', branch: 'explicit_bound', safe: false },
    { claim: base('۱۰') + ' تا زمان کافی برای آماده شدن داشته باشند', bound: 'unbounded', category: 'none', position: 'unknown', branch: 'unbounded', purpose: 'finite_preparation', safe: true },
    { claim: base('۱۰') + ' تا فرصت کافی برای آماده شدن داشته باشند', bound: 'unbounded', category: 'none', position: 'unknown', branch: 'unbounded', purpose: 'time_opportunity', safe: true },
    { claim: base('۱۰', 'حداکثر') + ' تا زمان کافی برای آماده شدن داشته باشند', bound: 'maximum', category: 'explicit_maximum', position: 'before_quantity', branch: 'explicit_bound', purpose: 'finite_preparation', safe: false },
    { claim: 'لغو نه دیرتر از ۱۰ دقیقه قبل از نوبت مجاز است', bound: 'minimum', category: 'latest', position: 'before_quantity', branch: 'temporal_bound', self: true, safe: true },
    { claim: 'نه زودتر از ۱۰ دقیقه قبل از نوبت حاضر شوند', bound: 'maximum', category: 'earliest', position: 'before_quantity', branch: 'temporal_bound', self: true, safe: true },
    { claim: base('۱۰', 'حداقل یا حداکثر'), bound: 'minimum', category: 'explicit_minimum', position: 'before_quantity', branch: 'explicit_bound', ambiguous: true, safe: false },
  ];
  for (const entry of cases) {
    const assessment = assessNumericalConstraint(entry.claim, entry.claim, [entry.self ? entry.claim : source]);
    assert.equal(assessment.safe, entry.safe, entry.claim);
    const [row] = numericalComparisonShapes(assessment);
    assert.ok(row, entry.claim);
    assert.deepEqual(
      [row.candidateBound, row.boundTriggerCategory, row.boundTriggerPosition, row.boundDecisionBranch,
        row.purposeClauseGuardMatched, row.purposeClauseCategory, row.candidateAmbiguous],
      [entry.bound, entry.category, entry.position, entry.branch, Boolean(entry.purpose), entry.purpose, Boolean(entry.ambiguous)],
      entry.claim,
    );
  }
});
