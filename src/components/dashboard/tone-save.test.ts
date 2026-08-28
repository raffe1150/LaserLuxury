import assert from 'node:assert/strict';
import { DEFAULT_BUSINESS_TONE_CONFIG } from '../../ai/tone-controls';
import type { Business } from '../../types/dashboard';
import { createToneSaveCoordinator } from './tone-save';

const tone = { ...DEFAULT_BUSINESS_TONE_CONFIG, tonePreset: 'friendly' as const };
const business = (id: string): Business => ({ id, name: `Business ${id}`, toneConfig: tone });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

async function run() {
  const request = deferred<Business>();
  let persistCalls = 0;
  const savingStates: boolean[] = [];
  const persisted: Business[] = [];
  const notices: string[] = [];
  const diagnostics: unknown[] = [];
  const coordinator = createToneSaveCoordinator({
    persist: async () => { persistCalls += 1; return request.promise; },
    onSavingChange: (value) => savingStates.push(value),
    onPersisted: (value) => persisted.push(value),
    onSuccess: () => notices.push('AI tone saved.'),
    onFailure: () => notices.push("Couldn't save AI tone. Please try again."),
    onDiagnostic: (error) => diagnostics.push(error),
  });

  coordinator.selectBusiness('7');
  const firstSave = coordinator.save('7', tone);
  assert.equal(await coordinator.save('7', tone), 'duplicate');
  assert.equal(persistCalls, 1, 'duplicate submission does not issue another request');
  request.resolve(business('7'));
  assert.equal(await firstSave, 'saved');
  assert.deepEqual(savingStates.slice(-2), [true, false]);
  assert.equal(persisted[0].id, '7');
  assert.deepEqual(notices, ['AI tone saved.']);

  const rawBackendError = '{"success":false,"message":"SQL/PostgREST internal detail"}';
  const failed = createToneSaveCoordinator({
    persist: async () => { throw new Error(rawBackendError); },
    onSavingChange: () => undefined,
    onPersisted: () => assert.fail('failed save must not update persisted state'),
    onSuccess: () => assert.fail('failed save must not report success'),
    onFailure: () => notices.push("Couldn't save AI tone. Please try again."),
    onDiagnostic: (error) => diagnostics.push(error),
  });
  failed.selectBusiness('7');
  assert.equal(await failed.save('7', tone), 'failed');
  assert.equal(notices.at(-1), "Couldn't save AI tone. Please try again.");
  assert.doesNotMatch(notices.join(' '), /SQL|PostgREST|success.*false|internal detail/i);
  assert.match(String(diagnostics.at(-1)), /PostgREST/, 'technical error remains diagnostic-only');

  const staleRequest = deferred<Business>();
  const stalePersisted: Business[] = [];
  const staleNotices: string[] = [];
  const isolated = createToneSaveCoordinator({
    persist: async (id) => id === '7' ? staleRequest.promise : business(id),
    onSavingChange: () => undefined,
    onPersisted: (value) => stalePersisted.push(value),
    onSuccess: () => staleNotices.push('success'),
    onFailure: () => staleNotices.push('failure'),
  });
  isolated.selectBusiness('7');
  const oldBusinessSave = isolated.save('7', tone);
  isolated.selectBusiness('8');
  staleRequest.resolve(business('7'));
  assert.equal(await oldBusinessSave, 'stale');
  assert.equal(stalePersisted.length, 0, 'old tenant response is ignored');
  assert.equal(staleNotices.length, 0, 'old tenant response cannot show a toast');
  assert.equal(await isolated.save('8', tone), 'saved');
  assert.equal(stalePersisted[0].id, '8');

  const strictModeRequests: string[] = [];
  const strictModeNotices: string[] = [];
  const strictModeCoordinator = createToneSaveCoordinator({
    persist: async (id) => {
      strictModeRequests.push(id);
      return business(id);
    },
    onSavingChange: () => undefined,
    onPersisted: () => undefined,
    onSuccess: () => strictModeNotices.push('success'),
    onFailure: () => strictModeNotices.push('failure'),
  });
  strictModeCoordinator.selectBusiness('9');
  strictModeCoordinator.dispose();
  strictModeCoordinator.selectBusiness('9');
  assert.equal(
    await strictModeCoordinator.save('9', tone),
    'saved',
    'StrictMode effect cleanup/setup must not permanently disable submit',
  );
  assert.deepEqual(strictModeRequests, ['9'], 'the replayed component issues the save request');
  assert.deepEqual(strictModeNotices, ['success']);
}

await run();
console.log('AI Tone duplicate-submit, safe-error, success, and tenant-switch coordinator tests passed.');
