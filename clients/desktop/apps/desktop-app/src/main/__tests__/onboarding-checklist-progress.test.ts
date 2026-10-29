const mockReadPersistedState = jest.fn<Promise<unknown>, []>();
const mockLatchItemComplete = jest.fn<Promise<unknown>, [string]>();
const mockReadLockFile = jest.fn<unknown, []>();
const mockLoadMarketplacesCacheOnly = jest.fn<Promise<unknown>, []>();
const mockHasEverSentChatMessage = jest.fn<Promise<boolean>, []>();
const mockResetChatHistoryScan = jest.fn<void, []>();
const mockLoadCloudAccount = jest.fn<Promise<unknown>, []>();

jest.mock('../lib/onboarding-checklist-state', () => ({
  readOnboardingChecklistPersistedState: (): Promise<unknown> =>
    mockReadPersistedState(),
  latchOnboardingChecklistItemComplete: (itemId: string): Promise<unknown> =>
    mockLatchItemComplete(itemId),
}));
jest.mock('../lib/chat-history-scan', () => ({
  hasEverSentChatMessage: (): Promise<boolean> => mockHasEverSentChatMessage(),
  resetChatHistoryScanForTests: (): void => mockResetChatHistoryScan(),
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: (): Promise<unknown> => mockLoadCloudAccount(),
}));
jest.mock('../skills/lock-file', () => ({
  readLockFile: (): unknown => mockReadLockFile(),
}));
jest.mock('../plugins/plugin-service', () => ({
  loadMarketplacesCacheOnly: (): Promise<unknown> =>
    mockLoadMarketplacesCacheOnly(),
}));

import {
  computeOnboardingChecklistState,
  resetOnboardingChecklistProgressForTests,
} from '../lib/onboarding-checklist-progress';

interface PersistedStateFixture {
  completedItems: Record<string, string>;
  dismissedAt: string | null;
  snoozedUntil: string | null;
  providersNotUsed: string[];
}

function persistedState(
  overrides: Partial<PersistedStateFixture> = {},
): PersistedStateFixture {
  return {
    completedItems: {},
    dismissedAt: null,
    snoozedUntil: null,
    providersNotUsed: [],
    ...overrides,
  };
}

function itemById(
  state: { items: { id: string; complete: boolean }[] },
  id: string,
): { id: string; complete: boolean } {
  const item = state.items.find((entry) => entry.id === id);
  if (!item) throw new Error(`missing checklist item ${id}`);
  return item;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetOnboardingChecklistProgressForTests();
  mockReadPersistedState.mockImplementation(() =>
    Promise.resolve(persistedState()),
  );
  mockLatchItemComplete.mockImplementation((itemId: string) =>
    Promise.resolve({
      state: persistedState({
        completedItems: { [itemId]: '2026-08-25T00:00:00.000Z' },
      }),
      changed: true,
    }),
  );
  mockReadLockFile.mockReturnValue({ version: 2, skills: {} });
  mockLoadMarketplacesCacheOnly.mockResolvedValue({
    success: true,
    data: { version: 2, lastRefreshed: '', marketplaces: [] },
  });
  mockHasEverSentChatMessage.mockResolvedValue(false);
  mockLoadCloudAccount.mockResolvedValue(null);
});

describe('computeOnboardingChecklistState', () => {
  it('reports every item incomplete for a pristine install, in display order', async () => {
    const state = await computeOnboardingChecklistState();
    expect(state.items.map((item) => item.id)).toEqual([
      'create-account',
      'start-chat',
      'connect-accounts',
      'add-capability',
    ]);
    expect(state.items.every((item) => !item.complete)).toBe(true);
    expect(state.dismissedAt).toBeNull();
    expect(state.snoozedUntil).toBeNull();
    expect(state.providersNotUsed).toEqual([]);
    expect(mockLatchItemComplete).not.toHaveBeenCalled();
  });

  it('completes and latches start-chat once a chat message exists', async () => {
    mockHasEverSentChatMessage.mockResolvedValue(true);
    const state = await computeOnboardingChecklistState();
    expect(itemById(state, 'start-chat').complete).toBe(true);
    expect(mockLatchItemComplete).toHaveBeenCalledWith('start-chat');
  });

  it('skips the chat-history scan when start-chat is already latched', async () => {
    mockReadPersistedState.mockResolvedValue(
      persistedState({
        completedItems: { 'start-chat': '2026-08-01T00:00:00.000Z' },
      }),
    );
    const state = await computeOnboardingChecklistState();
    expect(itemById(state, 'start-chat').complete).toBe(true);
    expect(mockHasEverSentChatMessage).not.toHaveBeenCalled();
  });

  describe('create-account', () => {
    it('completes and latches for a signed-in non-guest account', async () => {
      mockLoadCloudAccount.mockResolvedValue({
        authMode: 'oauth',
        credentialSource: 'oauth_desktop',
      });
      const state = await computeOnboardingChecklistState();
      expect(itemById(state, 'create-account').complete).toBe(true);
      expect(mockLatchItemComplete).toHaveBeenCalledWith('create-account');
    });

    // The load-bearing case: every fresh install mints a guest credential for
    // the included AI Credits, and a guest resolves as a real cloud user. If
    // guests counted, this step would render pre-completed for every single
    // user -- including exactly the users it exists to reach.
    it('stays incomplete for a guest credential', async () => {
      mockLoadCloudAccount.mockResolvedValue({
        authMode: 'guest',
        credentialSource: 'guest',
      });
      const state = await computeOnboardingChecklistState();
      expect(itemById(state, 'create-account').complete).toBe(false);
      expect(mockLatchItemComplete).not.toHaveBeenCalledWith('create-account');
    });

    // A normalized guest can carry `authMode: 'guest'` with a non-guest
    // `credentialSource`, so a credentialSource-only check would miss it.
    it('stays incomplete for a normalized guest with a manual source', async () => {
      mockLoadCloudAccount.mockResolvedValue({
        authMode: 'guest',
        credentialSource: 'manual',
      });
      const state = await computeOnboardingChecklistState();
      expect(itemById(state, 'create-account').complete).toBe(false);
    });

    // `loadCanopyCloudAccount` collapses a degraded/unavailable secure-store
    // read to `null`, which is indistinguishable from a real sign-out. Not
    // latching is the safe direction: the next good read completes the item,
    // whereas a wrong latch is permanent.
    it('stays incomplete and unlatched when the account read fails', async () => {
      mockLoadCloudAccount.mockRejectedValue(new Error('keychain locked'));
      const state = await computeOnboardingChecklistState();
      expect(itemById(state, 'create-account').complete).toBe(false);
      expect(mockLatchItemComplete).not.toHaveBeenCalledWith('create-account');
    });
  });

  it('completes add-capability from an installed skill', async () => {
    mockReadLockFile.mockReturnValue({
      version: 2,
      skills: { 'source/skill-a': { name: 'skill-a' } },
    });
    const state = await computeOnboardingChecklistState();
    expect(itemById(state, 'add-capability').complete).toBe(true);
  });

  it('completes add-capability from an installed plugin', async () => {
    mockLoadMarketplacesCacheOnly.mockResolvedValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '',
        marketplaces: [
          {
            plugins: [
              {
                globalInstallStatus: {
                  claude: { available: true, installed: true },
                  checkedAt: '',
                },
              },
            ],
          },
        ],
      },
    });
    const state = await computeOnboardingChecklistState();
    expect(itemById(state, 'add-capability').complete).toBe(true);
  });

  it('keeps connect-accounts derived only from its latch', async () => {
    mockReadPersistedState.mockResolvedValue(
      persistedState({
        completedItems: { 'connect-accounts': '2026-08-01T00:00:00.000Z' },
        providersNotUsed: ['linear'],
      }),
    );
    const state = await computeOnboardingChecklistState();
    expect(itemById(state, 'connect-accounts').complete).toBe(true);
    expect(state.providersNotUsed).toEqual(['linear']);
  });

  it('keeps a latched item complete when its live signal has regressed', async () => {
    mockReadPersistedState.mockResolvedValue(
      persistedState({
        completedItems: { 'create-account': '2026-08-01T00:00:00.000Z' },
      }),
    );
    // The user signed out again; `loadCanopyCloudAccount` now resolves null.
    const state = await computeOnboardingChecklistState();
    expect(itemById(state, 'create-account').complete).toBe(true);
    expect(mockLatchItemComplete).not.toHaveBeenCalledWith('create-account');
  });

  it('survives a collaborator failure by treating that signal as incomplete', async () => {
    mockHasEverSentChatMessage.mockRejectedValue(new Error('disk error'));
    const state = await computeOnboardingChecklistState();
    expect(itemById(state, 'start-chat').complete).toBe(false);
    // The rest of the snapshot still resolves rather than rejecting wholesale.
    expect(itemById(state, 'add-capability').complete).toBe(false);
  });

  // Retired ids (CAN-2663) must not reappear in the wire snapshot just
  // because an old latch for them is still on disk.
  it('ignores latches for items retired from the checklist', async () => {
    mockReadPersistedState.mockResolvedValue(
      persistedState({
        completedItems: {
          'run-pipeline': '2026-08-01T00:00:00.000Z',
          'add-repository': '2026-08-01T00:00:00.000Z',
        },
      }),
    );
    const state = await computeOnboardingChecklistState();
    expect(state.items.map((item) => item.id)).toEqual([
      'create-account',
      'start-chat',
      'connect-accounts',
      'add-capability',
    ]);
    expect(state.items.every((item) => !item.complete)).toBe(true);
  });
});
