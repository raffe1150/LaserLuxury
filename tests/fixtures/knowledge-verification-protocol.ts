// Explicit offline verdict fixtures, derived from the existing reliability and
// native parking fixtures. Encoding here is independent of the production decoder.
export function compactFixture(raw: any) {
  return { d: raw.decisions.map((d: any) => ({ i: d.unitId, r: d.relation, f: d.facetIds,
    m: d.meaningPreserved, o: d.modalityPreserved, q: d.qualifiersPreserved, v: d.relevant,
    l: d.languageCorrect, a: d.explicitAbsenceEvidence, n: d.negativeAbsence })),
  c: raw.coverage.map((c: any) => ({ i: c.facetId, a: c.requestAligned, c: c.materialFactsComplete,
    r: c.incompletenessReason, u: c.materialUnitIds,
    o: c.obligations.map((o: any) => ({ i: o.obligationId, s: o.status, u: o.unitIds })) })) };
}
export const verdictFixture = (unit: any) => ({ unitId: unit.id, relation: 'ENTAILED', facetIds: [...unit.facetIds],
  meaningPreserved: true, modalityPreserved: true, qualifiersPreserved: true, relevant: true,
  languageCorrect: true, explicitAbsenceEvidence: false, negativeAbsence: false });
export function coverageFixture(facets: readonly any[], units: readonly any[], complete = true) {
  return facets.map(f => { const ids = units.filter(u => u.facetIds.includes(f.id)).map(u => u.id); return {
    facetId: f.id, requestAligned: true, materialFactsComplete: complete && ids.length > 0,
    incompletenessReason: complete && ids.length ? 'NONE' : 'MISSING_RECOMMENDATION', materialUnitIds: ids,
    obligations: f.obligations.map((o: any) => ({ obligationId: o.id, status: complete && ids.length ? 'COVERED' : 'UNRESOLVED',
      unitIds: complete && ids.length ? ids : [] })),
  }; });
}
