import type { BusinessToneConfig } from '../../ai/tone-controls';
import type { Business } from '../../types/dashboard';

export type ToneSaveResult = 'saved' | 'failed' | 'duplicate' | 'stale';

interface ToneSaveCoordinatorOptions {
  persist: (businessId: string, tone: BusinessToneConfig) => Promise<Business>;
  onSavingChange: (saving: boolean) => void;
  onPersisted: (business: Business) => void;
  onSuccess: () => void;
  onFailure: () => void;
  onDiagnostic?: (error: unknown) => void;
}

export interface ToneSaveCoordinator {
  selectBusiness: (businessId: string) => void;
  save: (businessId: string, tone: BusinessToneConfig) => Promise<ToneSaveResult>;
  dispose: () => void;
}

/** Keeps async save responses scoped to the business that initiated them. */
export function createToneSaveCoordinator(
  options: ToneSaveCoordinatorOptions,
): ToneSaveCoordinator {
  let activeBusinessId = '';
  let generation = 0;
  let saving = false;
  let disposed = false;

  const isCurrent = (businessId: string, requestGeneration: number) =>
    !disposed &&
    activeBusinessId === businessId &&
    generation === requestGeneration;

  return {
    selectBusiness(businessId) {
      // React StrictMode replays effect cleanup/setup in development. Reactivate
      // the same coordinator when the setup effect selects the current tenant.
      disposed = false;
      activeBusinessId = businessId;
      generation += 1;
      saving = false;
      options.onSavingChange(false);
    },

    async save(businessId, tone) {
      if (disposed || businessId !== activeBusinessId) return 'stale';
      if (saving) return 'duplicate';

      saving = true;
      const requestGeneration = generation;
      options.onSavingChange(true);

      try {
        const updated = await options.persist(businessId, tone);
        if (!isCurrent(businessId, requestGeneration)) return 'stale';
        options.onPersisted(updated);
        options.onSuccess();
        return 'saved';
      } catch (error) {
        options.onDiagnostic?.(error);
        if (!isCurrent(businessId, requestGeneration)) return 'stale';
        options.onFailure();
        return 'failed';
      } finally {
        if (isCurrent(businessId, requestGeneration)) {
          saving = false;
          options.onSavingChange(false);
        }
      }
    },

    dispose() {
      disposed = true;
      generation += 1;
      saving = false;
    },
  };
}
