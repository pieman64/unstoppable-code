/** @jest-environment jsdom */
import {
  mergePlanModeHintRecords,
  type PlanModeHintRecord,
} from '@canopy/protocol/onboarding';
import { isPlanModeHintRetired } from '@canopy/app-state';
import type { PreferencesSaveResult } from '@canopy/desktop-shared/types';
import { getPlanModeHintStore, resetPlanModeHint } from '../planModeHint';

jest.mock('../renderer-error-logging', () => ({
  reportRendererConsoleError: jest.fn(),
}));
let stored: PlanModeHintRecord = { version: 1, generation: 0 };
let broadcast: (prefs: PreferencesSaveResult) => void;
const save = jest.fn(
  (patch: {
    planModeHint: PlanModeHintRecord;
  }): Promise<{ planModeHint: PlanModeHintRecord }> => {
    stored = mergePlanModeHintRecords(stored, patch.planModeHint);
    return Promise.resolve({ planModeHint: stored });
  },
);
Object.defineProperty(window, 'api', {
  value: {
    loadPreferences: jest.fn(() => Promise.resolve({ planModeHint: stored })),
    savePreferences: save,
    onPreferencesSynced: (callback: typeof broadcast): (() => void) => {
      broadcast = callback;
      return () => undefined;
    },
  },
});
it('uses a single scope, sends preference patches and reconciles cross-window reset/retirement', async () => {
  const store = getPlanModeHintStore();
  expect(getPlanModeHintStore()).toBe(store);
  await store.getState().hydrate();
  await store.getState().markTried();
  expect(isPlanModeHintRetired(store.getState())).toBe(true);
  expect(
    save.mock.calls.every(
      ([patch]) => Object.keys(patch).join() === 'planModeHint',
    ),
  ).toBe(true);
  await resetPlanModeHint();
  expect(stored).toEqual({ version: 1, generation: 1 });
  broadcast({
    planModeHint: {
      version: 1,
      generation: 1,
      dismissedAt: '2026-10-13T12:00:00.000Z',
    },
  } as PreferencesSaveResult);
  expect(isPlanModeHintRetired(store.getState())).toBe(true);
});
