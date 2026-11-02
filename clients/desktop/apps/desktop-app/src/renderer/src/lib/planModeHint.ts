import {
  createPlanModeHintStore,
  type PlanModeHintStore,
} from '@canopy/app-state';
import { normalizePlanModeHintRecord } from '@canopy/protocol/onboarding';
import { reportRendererConsoleError } from './renderer-error-logging';

let store: PlanModeHintStore | null = null;

/** One renderer scope, sharing the main-owned preference authority across windows. */
export function getPlanModeHintStore(): PlanModeHintStore {
  if (store !== null) return store;
  let initialized = false;
  const scope = createPlanModeHintStore({
    load: async () => {
      const prefs = await window.api.loadPreferences();
      if (prefs.__error)
        throw new Error('Unable to read plan mode hint preferences.');
      const record = normalizePlanModeHintRecord(prefs.planModeHint);
      if (!record)
        throw new Error('Plan mode hint preferences are unavailable.');
      // Main may have derived the marker from legacy progress on read. Saving
      // through its merge queue commits initialization without replacing prefs.
      return { record, persisted: initialized };
    },
    save: async (record) => {
      const prefs = await window.api.savePreferences({ planModeHint: record });
      const stored = normalizePlanModeHintRecord(prefs.planModeHint);
      if (!stored)
        throw new Error('Plan mode hint preferences were not saved.');
      initialized = true;
      return stored;
    },
    onError: (_error, operation) =>
      reportRendererConsoleError('Plan mode hint persistence failed', {
        operation,
      }),
  });
  store = scope;
  window.api.onPreferencesSynced?.((prefs) => {
    const record = normalizePlanModeHintRecord(prefs.planModeHint);
    if (record) {
      initialized = true;
      scope.getState().reconcile(record);
      void scope.getState().hydrate();
    }
  });
  window.addEventListener('focus', () => {
    void scope.getState().hydrate();
  });
  void scope.getState().hydrate();
  return scope;
}

export async function resetPlanModeHint(): Promise<void> {
  const scope = getPlanModeHintStore();
  // Refresh the committed generation, including resets from other windows.
  await scope.getState().hydrate();
  if (!(await scope.getState().reset()))
    throw new Error('Unable to reset plan mode hint.');
}
