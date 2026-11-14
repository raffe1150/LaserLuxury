/**
 * Source registry: every evaluation fact is anchored to one of these exact,
 * hashed fixture texts. Read-only; files are only read, never written.
 * Business content is the repository's own fictional test material.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mixedBusinesses } from '../../../../tests/fixtures/mixed-source-questions';
import type { SourceRecord } from './types';

export const REPO_ROOT = new URL('../../../../', import.meta.url);
const sha256 = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const file = (path: string) => readFileSync(new URL(path, REPO_ROOT));
const json = (path: string) => JSON.parse(file(path).toString('utf8'));
const canonical = (v: unknown) => JSON.stringify(v);

function record(r: Omit<SourceRecord, 'revision' | 'provenance'> & { file: string; capturedAt: string; note: string }): SourceRecord {
  const { file: path, capturedAt, note, ...rest } = r;
  return Object.freeze({ ...rest, revision: sha256(rest.text),
    provenance: Object.freeze({ file: path, fileSha256: sha256(file(path)), capturedAt, note }) });
}

let cache: readonly SourceRecord[] | undefined;
export function loadSources(): readonly SourceRecord[] {
  if (cache) return cache;
  const current = json('tests/fixtures/admotion-current-production-20261112.json');
  const byId = (id: string) => current.sources.find((s: any) => s.id === id);
  const t3 = json('tests/fixtures/business-information-tenant3.json');
  const cancel = json('tests/fixtures/cancellation-business3-audited-20261101.json');
  const studio1 = json('tests/fixtures/admotion-production-document.json');
  const cedar = json('tests/fixtures/cedar-repair-knowledge.json');
  const summit = mixedBusinesses.find(b => b.id === 99)!;
  const birch = file('tests/fixtures/knowledge-named-business-b.txt').toString('utf8');
  const admotion = { tenantId: 3, businessName: 'AdMotion Studio', businessType: 'video production studio' };
  const services = (t3.business.services as any[]).map(s => ({ name: s.name, price: s.price, currency: s.currency, durationMinutes: s.durationMinutes, active: s.active }));
  const cancellation = { allowCancellation: cancel.business.allow_cancellation, cancellationDeadlineMinutes: cancel.business.cancellation_deadline_minutes,
    feeEnabled: cancel.business.cancellation_fee_enabled, feeAmount: cancel.business.cancellation_fee_amount, feeCurrency: cancel.business.cancellation_fee_currency };
  cache = Object.freeze([
    record({ ...admotion, key: 't3.dge', sourceId: '2ac009ba-c913-48bc-b13d-c09adf34c8e0', kind: 'document', title: 'AdMotion_Studio_dge.pdf', status: 'CURRENT',
      text: byId('2ac009ba-c913-48bc-b13d-c09adf34c8e0').content, file: 'tests/fixtures/admotion-current-production-20261112.json',
      capturedAt: '2026-11-12', note: 'Read-only READY-source snapshot of business 3 (updated 2026-11-09T23:02).' }),
    record({ ...admotion, key: 't3.txt', sourceId: '964e268a-bb19-4bfb-81bb-2e60831bdb91', kind: 'document', title: 'odinlink-test.txt', status: 'CURRENT',
      text: byId('964e268a-bb19-4bfb-81bb-2e60831bdb91').content, file: 'tests/fixtures/admotion-current-production-20261112.json',
      capturedAt: '2026-11-12', note: 'Read-only READY-source snapshot of business 3 (updated 2026-11-11T09:48).' }),
    record({ ...admotion, key: 't3.manual', sourceId: '864b7aff-4848-4bdf-8a71-fbced131c565', kind: 'manual', title: 'Första besöket – rekommenderad ankomsttid', status: 'CURRENT',
      text: byId('864b7aff-4848-4bdf-8a71-fbced131c565').content, file: 'tests/fixtures/admotion-current-production-20261112.json',
      capturedAt: '2026-11-12', note: 'Manual owner text, created 2026-11-11T19:03.' }),
    record({ ...admotion, key: 't3.services', sourceId: 'configured-services:3', kind: 'configuration', title: 'Configured services', status: 'CURRENT',
      text: canonical(services), file: 'tests/fixtures/business-information-tenant3.json', capturedAt: '2026-09-30',
      note: 'Latest available configured-service snapshot in the repository (2026-09-30); consistent with the 2026-10-22 delivered reply (300 SEK / 60 min).' }),
    record({ ...admotion, key: 't3.cancellation', sourceId: 'business-cancellation-configuration:3', kind: 'configuration', title: 'Cancellation configuration',
      status: 'CURRENT', text: canonical(cancellation), file: 'tests/fixtures/cancellation-business3-audited-20261101.json', capturedAt: '2026-11-01',
      note: 'Audited cancellation fields only. Authority scope (repository contract): chat automation and the optional late fee; mandatory advance notice is outside this source.' }),
    record({ ...admotion, key: 't3.studio1', sourceId: '8eec8b5c-87bc-4a7b-9789-b65d977b5ae4', kind: 'document', title: 'admotion studio1.pdf', status: 'HISTORICAL',
      text: studio1.content, file: 'tests/fixtures/admotion-production-document.json', capturedAt: '2026-10-16',
      note: 'Ready on 2026-11-10 (admotion-two-pdf-production-20261110.json); absent from the 2026-11-12 READY snapshot.' }),
    record({ ...admotion, key: 't3.smoke', sourceId: t3.sources[0].id, kind: 'document', title: t3.sources[0].title, status: 'TEMPORARY',
      text: t3.sources[0].content, file: 'tests/fixtures/business-information-tenant3.json', capturedAt: '2026-09-26',
      note: 'Temporary production runtime smoke test (metadata.temporary=true); absent from the 2026-11-12 READY snapshot.' }),
    ...cedar.documents.map((d: any) => record({ tenantId: 88, businessName: cedar.businessName, businessType: 'electronics repair lab',
      key: `c.${d.sourceId}`, sourceId: d.sourceId, kind: 'document', title: d.sourceId, status: 'CURRENT', text: d.text,
      file: 'tests/fixtures/cedar-repair-knowledge.json', capturedAt: 'fixture', note: 'Synthetic second tenant used by repository tests.' })),
    record({ tenantId: 88, businessName: cedar.businessName, businessType: 'electronics repair lab', key: 'c.services', sourceId: 'configured-services:88',
      kind: 'configuration', title: 'Configured services', status: 'CURRENT', text: canonical(cedar.services), file: 'tests/fixtures/cedar-repair-knowledge.json',
      capturedAt: 'fixture', note: 'Synthetic tenant configuration.' }),
    record({ tenantId: 99, businessName: summit.name, businessType: 'bicycle workshop', key: 's.guide', sourceId: 'summit-guide', kind: 'document',
      title: 'Summit guide', status: 'CURRENT', text: summit.source, file: 'tests/fixtures/mixed-source-questions.ts', capturedAt: 'fixture', note: 'Synthetic third tenant.' }),
    record({ tenantId: 99, businessName: summit.name, businessType: 'bicycle workshop', key: 's.services', sourceId: 'configured-services:99', kind: 'configuration',
      title: 'Configured services', status: 'CURRENT', text: canonical([summit.service]), file: 'tests/fixtures/mixed-source-questions.ts', capturedAt: 'fixture',
      note: 'Synthetic tenant configuration.' }),
    record({ tenantId: 8802, businessName: 'Synthetic Birch Studio', businessType: 'appointment studio', key: 'b.doc', sourceId: 'synthetic-birch-studio-txt',
      kind: 'document', title: 'Synthetic Birch Studio.txt', status: 'CURRENT', text: birch, file: 'tests/fixtures/knowledge-named-business-b.txt',
      capturedAt: 'fixture', note: 'Synthetic fourth tenant (tenant id 8802 in knowledge-quality.acceptance.test.ts).' }),
    // Existing repository negative control (source-exhaustive-publication.test.ts); NOT a business policy.
    record({ ...admotion, key: 't3.neg-conflict', sourceId: 'material-policy-conflict', kind: 'document', title: 'Negative control: conflict', status: 'SYNTHETIC_NEGATIVE_CONTROL',
      text: 'Automatic appointment cancellation through chat is disabled.', file: 'src/ai/source-exhaustive-publication.test.ts', capturedAt: 'fixture',
      note: 'Team-authored negative control that contradicts the cancellation configuration. Used only for CONFLICTING-evidence cases.' }),
  ]);
  return cache;
}
export const source = (key: string) => {
  const s = loadSources().find(s => s.key === key);
  if (!s) throw new Error(`unknown source ${key}`);
  return s;
};
