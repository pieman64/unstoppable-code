jest.mock('../provider-presence', () => ({
  detectProviderStorePresence: jest.fn(),
}));
jest.mock('../ledger', () => ({
  markExternalProjectInviteShown: jest.fn().mockResolvedValue(undefined),
  readExternalProjectImportLedger: jest.fn(),
}));
jest.mock('../../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn().mockResolvedValue({ items: [] }),
}));
jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: jest
    .fn()
    .mockResolvedValue({ onboardingCompleted: ['v1'] }),
}));

import { readPreferencesFile } from '../../lib/preferences-store';
import {
  hasAnyProviderStore,
  readExternalProjectImportInvite,
  resetProviderPresenceCacheForTests,
} from '../invite';
import {
  markExternalProjectInviteShown,
  readExternalProjectImportLedger,
} from '../ledger';
import { detectProviderStorePresence } from '../provider-presence';

const detect = jest.mocked(detectProviderStorePresence);
const ledger = jest.mocked(readExternalProjectImportLedger);
const preferences = jest.mocked(readPreferencesFile);

describe('provider presence memoization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetProviderPresenceCacheForTests();
    detect.mockResolvedValue(true);
    ledger.mockResolvedValue({
      imports: {},
      lastScanAt: null,
      inviteShownAt: null,
    });
  });

  it('shares one in-flight probe and reuses the result', async () => {
    const [a, b] = await Promise.all([
      hasAnyProviderStore(),
      hasAnyProviderStore(),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    await hasAnyProviderStore();
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it('shows the invite once for an onboarded install with a store, never after retirement', async () => {
    expect(await readExternalProjectImportInvite()).toEqual({
      show: true,
      providerStoresPresent: true,
    });
    // Retired in main the moment it is shown, so a second window is too late.
    expect(markExternalProjectInviteShown).toHaveBeenCalledTimes(1);
    ledger.mockResolvedValue({
      imports: {},
      lastScanAt: '2026-09-10T00:00:00.000Z',
      inviteShownAt: null,
    });
    resetProviderPresenceCacheForTests();
    // Retired: decided from the ledger alone, no probe at all.
    expect(await readExternalProjectImportInvite()).toEqual({
      show: false,
      providerStoresPresent: false,
    });
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it('never shows the invite without a provider store', async () => {
    detect.mockResolvedValue(false);
    expect(await readExternalProjectImportInvite()).toEqual({
      show: false,
      providerStoresPresent: false,
    });
    expect(preferences).not.toHaveBeenCalled();
  });
});
