import {
  CODEX_ACCOUNT_MODELS,
  clearCodexAccountModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import { createUnknownCodexSpeedCatalog } from '@canopy/desktop-shared/lib/codex-speed-availability';
import type { CodexSpeedCatalog } from '@canopy/desktop-shared/types/codex-speed-capabilities';

let catalogListener: ((catalog: CodexSpeedCatalog) => void) | undefined;
const mockUnsubscribe = jest.fn();
jest.mock('../codex-account-models', () => ({
  subscribeCodexSpeedCatalog: (
    listener: (catalog: CodexSpeedCatalog) => void,
  ): (() => void) => {
    catalogListener = listener;
    return mockUnsubscribe;
  },
}));

import { registerCodexAccountModelRegistrySync } from '../codex-account-model-registry';

function readyCatalog(models: CodexSpeedCatalog['models']): CodexSpeedCatalog {
  return {
    ...createUnknownCodexSpeedCatalog(1),
    status: 'ready',
    fetchedAt: 1,
    expiresAt: 2,
    models,
  };
}

describe('account-only Codex model registry sync (CAN-4716)', () => {
  beforeEach(() => {
    initCodexModels([{ id: 'gpt-6.1-sol', label: '6.1 Sol' }]);
    clearCodexAccountModels();
    mockUnsubscribe.mockClear();
  });

  it('registers a ready catalog and clears on an unknown one', () => {
    registerCodexAccountModelRegistrySync();
    catalogListener?.(
      readyCatalog([
        {
          id: 'gpt-6.1-sol',
          model: 'gpt-6.1-sol',
          tiers: null,
          source: 'unknown',
        },
        {
          id: 'free-model',
          model: 'free-model',
          tiers: null,
          source: 'unknown',
          displayName: 'Free',
          isDefault: true,
        },
      ]),
    );
    expect(CODEX_ACCOUNT_MODELS).toEqual(['free-model']);

    catalogListener?.(createUnknownCodexSpeedCatalog(2));
    expect(CODEX_ACCOUNT_MODELS).toEqual([]);
  });

  it('registers nothing from a truncated catalog, which is unknown', () => {
    registerCodexAccountModelRegistrySync();
    catalogListener?.({
      ...readyCatalog([
        {
          id: 'free-model',
          model: 'free-model',
          tiers: null,
          source: 'unknown',
        },
      ]),
      truncated: true,
    });
    expect(CODEX_ACCOUNT_MODELS).toEqual([]);
  });

  it('replaces its listener when registered again', () => {
    registerCodexAccountModelRegistrySync();
    const before = mockUnsubscribe.mock.calls.length;
    registerCodexAccountModelRegistrySync();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(before + 1);
  });
});
