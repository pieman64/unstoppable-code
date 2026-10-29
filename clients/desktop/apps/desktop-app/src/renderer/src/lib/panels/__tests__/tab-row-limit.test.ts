/** @jest-environment jsdom */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

import { MAX_TABS_PER_GROUP } from '@canopy/ui-shared/panels';
import { resetExperimentalFeaturesStoreForTest } from '@/stores/experimentalFeaturesStore';
import { usePanelLayoutStore } from '@/stores/panelLayoutStore';
import {
  ensureTabRowLimitSync,
  resetTabRowLimitSyncForTest,
} from '../tab-row-limit';

const limit = (): number | null => usePanelLayoutStore.getState().tabRowLimit;

describe('ensureTabRowLimitSync', () => {
  afterEach(() => {
    resetTabRowLimitSyncForTest();
    resetExperimentalFeaturesStoreForTest();
    usePanelLayoutStore.getState().setTabRowLimit(null);
  });

  it('enforces the row limit without Labs hydration', () => {
    ensureTabRowLimitSync();
    expect(limit()).toBe(MAX_TABS_PER_GROUP);
  });

  it('applies the limit when early access is already on', () => {
    setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
    ensureTabRowLimitSync();
    expect(limit()).toBe(MAX_TABS_PER_GROUP);
  });

  it('keeps the limit when legacy preferences change', () => {
    ensureTabRowLimitSync();
    setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
    expect(limit()).toBe(MAX_TABS_PER_GROUP);
    setTestEarlyAccessFeatures({ enabled: false, hydrated: true });
    expect(limit()).toBe(MAX_TABS_PER_GROUP);
  });
});
