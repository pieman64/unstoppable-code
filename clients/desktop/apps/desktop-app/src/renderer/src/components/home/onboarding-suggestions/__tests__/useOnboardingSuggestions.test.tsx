/**
 * @jest-environment jsdom
 *
 * Start + persistence semantics for the Home onboarding suggestions module:
 * every install starts it once (existing users included), queue exhaustion,
 * and the now-ignored historical whole-module dismissals.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  HomeOnboardingSuggestionsPreferences,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import {
  useHomeOnboardingSuggestionsState,
  type HomeOnboardingSuggestionsState,
} from '../useOnboardingSuggestions';
import { withEntryCompleted } from '../queue';
import { completeOnboardingSuggestionDurably } from '../completionWriter';

const mockLoadPreferences = jest.fn<Promise<Partial<PreferencesData>>, []>();
const mockSavePreferences = jest.fn<
  Promise<void>,
  [Partial<PreferencesData>]
>();

const syncedListeners = new Set<(prefs: Partial<PreferencesData>) => void>();

let latest: HomeOnboardingSuggestionsState | null = null;

function Harness({ enabled }: { enabled: boolean }): JSX.Element | null {
  latest = useHomeOnboardingSuggestionsState(enabled);
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  jest.clearAllMocks();
  latest = null;
  syncedListeners.clear();
  mockLoadPreferences.mockResolvedValue({ onboardingCompleted: [] });
  mockSavePreferences.mockResolvedValue(undefined);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences: (): Promise<Partial<PreferencesData>> =>
        mockLoadPreferences(),
      savePreferences: (partial: Partial<PreferencesData>): Promise<void> =>
        mockSavePreferences(partial),
      onPreferencesSynced: (
        listener: (prefs: Partial<PreferencesData>) => void,
      ): (() => void) => {
        syncedListeners.add(listener);
        return () => syncedListeners.delete(listener);
      },
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  container.remove();
});

async function render(enabled = true): Promise<void> {
  await act(async () => {
    root.render(createElement(Harness, { enabled }));
    await Promise.resolve();
  });
}

function startedState(
  entries: HomeOnboardingSuggestionsPreferences['entries'] = {},
  retiredAt?: string,
): HomeOnboardingSuggestionsPreferences {
  return {
    startedAt: '2026-08-27T00:00:00.000Z',
    ...(retiredAt !== undefined ? { retiredAt } : {}),
    entries,
  };
}

describe('useHomeOnboardingSuggestionsState', () => {
  it('applies a completion that lands before its first preferences read resolves', async () => {
    // The hook's first read is not on the writer's chain. A completion that
    // reads and writes while that first read is still in flight must not be
    // lost to the hook's stale snapshot: it is buffered and applied when
    // the read lands, so the visible checklist matches what was written.
    let resolveFirstRead: (prefs: Partial<PreferencesData>) => void = () => {
      throw new Error('first read not started');
    };
    mockLoadPreferences.mockImplementationOnce(
      () =>
        new Promise<Partial<PreferencesData>>((resolve) => {
          resolveFirstRead = resolve;
        }),
    );
    mockLoadPreferences.mockResolvedValue({});
    await render();
    expect(latest?.persisted).toBeNull();

    completeOnboardingSuggestionDurably('import-projects');
    await act(async () => {
      for (let hop = 0; hop < 10; hop += 1) await Promise.resolve();
    });
    // The writer started the module on disk with the entry done...
    expect(
      mockSavePreferences.mock.calls.some(
        ([partial]) =>
          partial.homeOnboardingSuggestions?.entries['import-projects']
            ?.completedAt !== undefined,
      ),
    ).toBe(true);

    // ...and the hook's late first read, taken before that write, must not
    // erase it from the mounted copy.
    await act(async () => {
      resolveFirstRead({});
      for (let hop = 0; hop < 10; hop += 1) await Promise.resolve();
    });
    expect(latest?.visible).toBe(true);
    expect(
      typeof latest?.persisted?.entries['import-projects']?.completedAt,
    ).toBe('string');
  });

  it('applies a completion heard after the first read landed but before React committed it', async () => {
    // The first read's `setState` is scheduled, not committed: until React
    // renders, the ref the completed-listener consults still says the
    // module has no state. A completion in that window must not be parked
    // on a buffer that nothing drains again, or the mounted checklist keeps
    // offering an entry disk already resolved for the rest of the session.
    let resolveFirstRead: (prefs: Partial<PreferencesData>) => void = () => {
      throw new Error('first read not started');
    };
    mockLoadPreferences.mockImplementationOnce(
      () =>
        new Promise<Partial<PreferencesData>>((resolve) => {
          resolveFirstRead = resolve;
        }),
    );
    mockLoadPreferences.mockResolvedValue({
      homeOnboardingSuggestions: startedState(),
    });
    await render();
    expect(latest?.persisted).toBeNull();

    await act(async () => {
      resolveFirstRead({ homeOnboardingSuggestions: startedState() });
      // The hook's read handler runs on this hop; React has not committed.
      await Promise.resolve();
      completeOnboardingSuggestionDurably('import-projects');
      for (let hop = 0; hop < 10; hop += 1) await Promise.resolve();
    });
    expect(latest?.visible).toBe(true);
    expect(
      typeof latest?.persisted?.entries['import-projects']?.completedAt,
    ).toBe('string');
  });

  it('completes an entry in the forced-fresh replay although disk has it resolved', async () => {
    // `canopy.dev.forceHomeOnboarding` replays the module from an in-memory
    // seed; on disk this install dismissed the import entry long ago. A
    // completion must still reach the mounted copy, or the replayed
    // checklist keeps offering the import after the user finished it.
    Object.defineProperty(window, 'devInfo', {
      configurable: true,
      value: { isDev: true },
    });
    window.localStorage.setItem('canopy.dev.forceHomeOnboarding', '1');
    mockLoadPreferences.mockResolvedValue({
      homeOnboardingSuggestions: startedState({
        'import-projects': { dismissedAt: '2026-09-12T13:01:43.823Z' },
      }),
    });
    try {
      await render();
      expect(latest?.persisted?.entries['import-projects']).toBeUndefined();

      completeOnboardingSuggestionDurably('import-projects', 'skipped');
      await act(async () => {
        for (let hop = 0; hop < 10; hop += 1) await Promise.resolve();
      });
      // Nothing written: the persisted decision stands.
      expect(mockSavePreferences).not.toHaveBeenCalled();
      const first = latest?.persisted?.entries['import-projects']?.completedAt;
      expect(typeof first).toBe('string');

      // Idempotent: a repeat keeps the first completion time.
      completeOnboardingSuggestionDurably('import-projects', 'skipped');
      await act(async () => {
        for (let hop = 0; hop < 10; hop += 1) await Promise.resolve();
      });
      expect(latest?.persisted?.entries['import-projects']?.completedAt).toBe(
        first,
      );
    } finally {
      window.localStorage.removeItem('canopy.dev.forceHomeOnboarding');
      Reflect.deleteProperty(window, 'devInfo');
    }
  });

  it('starts on first load and becomes visible', async () => {
    await render();
    expect(latest?.visible).toBe(true);
    expect(typeof latest?.persisted?.startedAt).toBe('string');
    expect(mockSavePreferences).toHaveBeenCalledTimes(1);
    const saved = mockSavePreferences.mock.calls[0][0];
    expect(saved.homeOnboardingSuggestions?.entries).toEqual({});
  });

  it('starts for an existing install that completed the wizard', async () => {
    // Every install gets the checklist: the wizard-completed marker only
    // records that the old first-run wizard ran, not that setup is done.
    mockLoadPreferences.mockResolvedValue({ onboardingCompleted: ['v1'] });
    await render();
    expect(latest?.visible).toBe(true);
    expect(mockSavePreferences).toHaveBeenCalledTimes(1);
    expect(
      mockSavePreferences.mock.calls[0][0].homeOnboardingSuggestions?.entries,
    ).toEqual({});
  });

  it('stays hidden and does not seed when the preferences read is degraded', async () => {
    // A degraded read resolves with defaults plus `__error`; seeding over it
    // would rewrite the last-good preferences snapshot from those defaults.
    mockLoadPreferences.mockResolvedValue({
      onboardingCompleted: [],
      __error: 'EACCES',
    });
    await render();
    expect(latest?.visible).toBe(false);
    expect(mockSavePreferences).not.toHaveBeenCalled();
  });

  it('still starts for a user who dismissed the legacy card', async () => {
    // The welcome card no longer offers a card-level dismiss, so a stored
    // dismissal from when it did must not keep an eligible user from it.
    mockLoadPreferences.mockResolvedValue({
      onboardingCompleted: [],
      homeOnboardingDismissedAt: '2026-08-01T00:00:00.000Z',
    });
    await render();
    expect(latest?.visible).toBe(true);
  });

  it('reads back an already-started install without seeding again', async () => {
    mockLoadPreferences.mockResolvedValue({
      onboardingCompleted: [],
      homeOnboardingSuggestions: startedState(),
    });
    await render();
    expect(latest?.visible).toBe(true);
    // No re-latch save for an already-started install.
    expect(mockSavePreferences).not.toHaveBeenCalled();
  });

  it('stays visible for an install that was historically retired', async () => {
    // Retirement was written by a removed code path; honoring it now would
    // permanently hide a card the user can no longer bring back.
    mockLoadPreferences.mockResolvedValue({
      onboardingCompleted: [],
      homeOnboardingSuggestions: startedState({}, '2026-08-28T00:00:00.000Z'),
    });
    await render();
    expect(latest?.visible).toBe(true);
  });

  it('stays visible after the last curated entry resolves', async () => {
    // Plugin suggestions join the queue dynamically, so persisted-state
    // exhaustion must not hide the owner; future recommendations can appear.
    mockLoadPreferences.mockResolvedValue({
      onboardingCompleted: [],
      homeOnboardingSuggestions: startedState({
        roles: { completedAt: 'x' },
        'add-repo': { completedAt: 'x' },
        github: { dismissedAt: 'x' },
        agents: { completedAt: 'x' },
      }),
    });
    await render();
    await act(async () => {
      latest?.update((previous) =>
        withEntryCompleted(previous, 'linear', '2026-08-28T00:00:00.000Z'),
      );
      await Promise.resolve();
    });
    expect(latest?.visible).toBe(true);
    expect(latest?.persisted?.retiredAt).toBeUndefined();
  });

  it('exposes persisted roles, projecting a wizard-era single answer', async () => {
    mockLoadPreferences.mockResolvedValue({
      onboardingCompleted: [],
      homeOnboardingSuggestions: startedState(),
      profileRoles: ['designer', 'founder'],
    });
    await render();
    expect(latest?.selectedRoles).toEqual(['designer', 'founder']);

    mockLoadPreferences.mockResolvedValue({
      onboardingCompleted: [],
      homeOnboardingSuggestions: startedState(),
      profileRole: 'software-engineer',
    });
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    root = createRoot(container);
    await render();
    expect(latest?.selectedRoles).toEqual(['software-engineer']);
  });

  it('refreshes roles from preference broadcasts and observes an explicit reset', async () => {
    mockLoadPreferences.mockResolvedValue({
      homeOnboardingSuggestions: startedState(),
      profileRole: 'software-engineer',
      profileRoles: ['software-engineer', 'designer'],
    });
    await render();
    const updated: Partial<PreferencesData> = {
      profileRole: 'designer',
      profileRoles: ['designer'],
    };
    mockLoadPreferences.mockResolvedValue(updated);
    await act(async () => {
      syncedListeners.forEach((listener) => listener(updated));
      await Promise.resolve();
    });
    expect(latest?.selectedRoles).toEqual(['designer']);
    mockLoadPreferences.mockResolvedValue({});
    await act(async () => {
      syncedListeners.forEach((listener) => listener({}));
      await Promise.resolve();
    });
    expect(latest?.selectedRoles).toBeNull();
  });

  it('does not replace a newer broadcast role with a late initial read', async () => {
    let resolveLoad: ((prefs: Partial<PreferencesData>) => void) | undefined;
    mockLoadPreferences.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );
    await render();
    mockLoadPreferences.mockResolvedValue({ profileRole: 'designer' });
    act(() =>
      syncedListeners.forEach((listener) =>
        listener({ profileRole: 'designer' }),
      ),
    );
    await act(async () => {
      resolveLoad?.({
        homeOnboardingSuggestions: startedState(),
        profileRole: 'software-engineer',
      });
      await Promise.resolve();
    });
    expect(latest?.selectedRoles).toEqual(['designer']);
  });

  it('keeps the current persisted role when an older cloud-sync broadcast arrives last', async () => {
    mockLoadPreferences.mockResolvedValue({
      homeOnboardingSuggestions: startedState(),
      profileRoles: ['designer'],
    });
    await render();
    await act(async () => {
      syncedListeners.forEach((listener) =>
        listener({
          profileRole: 'software-engineer',
          profileRoles: ['software-engineer'],
        }),
      );
      await Promise.resolve();
    });
    expect(latest?.selectedRoles).toEqual(['designer']);
  });

  it('changeRoles saves each category pick at once, seeding navigation only on the first', async () => {
    // The hook re-reads preferences once a save chain drains, so the read
    // must see what the saves wrote, as the store would show (an explicit
    // empty list also clears the primary role there).
    const stored: Partial<PreferencesData> = {};
    mockSavePreferences.mockImplementation((partial) => {
      if (partial.profileRoles !== undefined) {
        stored.profileRoles = [...partial.profileRoles];
        if (partial.profileRoles.length === 0) delete stored.profileRole;
      }
      if (partial.profileRole) stored.profileRole = partial.profileRole;
      return Promise.resolve();
    });
    mockLoadPreferences.mockImplementation(() =>
      Promise.resolve({
        onboardingCompleted: [],
        homeOnboardingSuggestions: startedState(),
        ...stored,
      }),
    );
    await render();

    await act(async () => {
      // Designer listed first: the primary must still be the first selected
      // role in canonical PROFILE_ROLES order (engineering outranks design).
      latest?.changeRoles(['designer', 'software-engineer']);
      await Promise.resolve();
    });
    expect(latest?.selectedRoles).toEqual(['designer', 'software-engineer']);
    const roleSaves = (): Partial<PreferencesData>[] =>
      mockSavePreferences.mock.calls
        .map((call) => call[0])
        .filter((partial) => partial.profileRoles !== undefined);
    expect(roleSaves()).toEqual([
      {
        profileRoles: ['designer', 'software-engineer'],
        profileRole: 'software-engineer',
        // CAN-1817: the first answer's primary role seeds Code/Work mode.
        navigationMode: 'code',
      },
    ]);

    // Later picks re-rank tools without reshaping navigation, and clearing
    // every category saves an explicit empty list.
    await act(async () => {
      latest?.changeRoles(['designer']);
      latest?.changeRoles([]);
      for (let hop = 0; hop < 12; hop += 1) await Promise.resolve();
    });
    expect(latest?.selectedRoles).toEqual([]);
    expect(roleSaves().slice(1)).toEqual([
      { profileRoles: ['designer'], profileRole: 'designer' },
      { profileRoles: [] },
    ]);
    // There is no roles entry to complete any more.
    expect(
      mockSavePreferences.mock.calls.some(
        (call) => call[0].homeOnboardingSuggestions?.entries.roles,
      ),
    ).toBe(false);
  });

  it('treats an explicitly cleared profile as answered, so a later pick keeps the navigation mode', async () => {
    mockLoadPreferences.mockResolvedValue({
      onboardingCompleted: [],
      homeOnboardingSuggestions: startedState(),
      // Every category was cleared earlier: the store keeps the empty list.
      profileRoles: [],
    });
    await render();
    expect(latest?.selectedRoles).toEqual([]);

    await act(async () => {
      latest?.changeRoles(['designer']);
      await Promise.resolve();
    });
    const roleSaves = mockSavePreferences.mock.calls
      .map((call) => call[0])
      .filter((partial) => partial.profileRoles !== undefined);
    expect(roleSaves).toEqual([
      { profileRoles: ['designer'], profileRole: 'designer' },
    ]);
  });

  it('re-reads the saved roles once a save chain drains', async () => {
    mockLoadPreferences.mockResolvedValue({
      onboardingCompleted: [],
      homeOnboardingSuggestions: startedState(),
    });
    await render();
    let resolveSave: () => void = () => {
      throw new Error('save not started');
    };
    mockSavePreferences.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    await act(async () => {
      latest?.changeRoles(['designer']);
      await Promise.resolve();
    });
    expect(latest?.selectedRoles).toEqual(['designer']);

    // Another window changes the roles while the save is in flight: the
    // broadcast is held off so it cannot restore an older selection...
    mockLoadPreferences.mockResolvedValue({
      onboardingCompleted: [],
      homeOnboardingSuggestions: startedState(),
      profileRoles: ['marketing'],
    });
    await act(async () => {
      syncedListeners.forEach((listener) =>
        listener({ profileRoles: ['marketing'] }),
      );
      for (let hop = 0; hop < 5; hop += 1) await Promise.resolve();
    });
    expect(latest?.selectedRoles).toEqual(['designer']);

    // ...and the saved state is re-read once the chain drains.
    await act(async () => {
      resolveSave();
      for (let hop = 0; hop < 10; hop += 1) await Promise.resolve();
    });
    expect(latest?.selectedRoles).toEqual(['marketing']);
  });

  it('keeps the local pick when its save fails', async () => {
    mockLoadPreferences.mockResolvedValue({
      onboardingCompleted: [],
      homeOnboardingSuggestions: startedState(),
      profileRoles: ['marketing'],
    });
    await render();
    expect(latest?.selectedRoles).toEqual(['marketing']);
    mockSavePreferences.mockRejectedValueOnce(new Error('disk full'));
    await act(async () => {
      latest?.changeRoles(['designer']);
      for (let hop = 0; hop < 10; hop += 1) await Promise.resolve();
    });
    // A failed save must not be followed by a re-read that quietly puts the
    // saved roles back over the pick.
    expect(latest?.selectedRoles).toEqual(['designer']);
  });

  it('still seeds the navigation mode on the next pick after a failed first answer', async () => {
    mockLoadPreferences.mockResolvedValue({
      onboardingCompleted: [],
      homeOnboardingSuggestions: startedState(),
    });
    await render();
    expect(latest?.selectedRoles).toBeNull();
    mockSavePreferences.mockRejectedValueOnce(new Error('disk full'));
    await act(async () => {
      latest?.changeRoles(['designer']);
      for (let hop = 0; hop < 10; hop += 1) await Promise.resolve();
    });
    expect(mockSavePreferences).toHaveBeenLastCalledWith(
      expect.objectContaining({ navigationMode: 'work' }),
    );
    // Nothing was persisted, so the next pick is still the first answer and
    // must carry the seed again: the one fixed by the first pick (Designer,
    // Work), not one recomputed from the larger set (whose primary is the
    // engineer, Code).
    await act(async () => {
      latest?.changeRoles(['designer', 'software-engineer']);
      for (let hop = 0; hop < 10; hop += 1) await Promise.resolve();
    });
    expect(mockSavePreferences).toHaveBeenLastCalledWith(
      expect.objectContaining({
        profileRoles: ['designer', 'software-engineer'],
        profileRole: 'software-engineer',
        navigationMode: 'work',
      }),
    );
  });

  it('collapses picks made while a save is in flight into one save of the newest selection', async () => {
    mockLoadPreferences.mockResolvedValue({
      onboardingCompleted: [],
      homeOnboardingSuggestions: startedState(),
      profileRoles: ['designer'],
    });
    await render();
    let resolveSave: () => void = () => {
      throw new Error('save not started');
    };
    mockSavePreferences.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const roleSaves = (): readonly (readonly string[] | undefined)[] =>
      mockSavePreferences.mock.calls.map((call) => call[0].profileRoles);
    await act(async () => {
      latest?.changeRoles(['designer', 'marketing']);
      await Promise.resolve();
      latest?.changeRoles(['designer', 'marketing', 'founder']);
      latest?.changeRoles(['marketing', 'founder']);
      for (let hop = 0; hop < 5; hop += 1) await Promise.resolve();
    });
    // The selection re-ranks at once; only the first pick has been saved.
    expect(latest?.selectedRoles).toEqual(['marketing', 'founder']);
    expect(roleSaves()).toEqual([['designer', 'marketing']]);
    await act(async () => {
      resolveSave();
      for (let hop = 0; hop < 12; hop += 1) await Promise.resolve();
    });
    // One more save, with the newest selection; the middle pick never hit
    // the cloud sync or the catalog refresh.
    expect(roleSaves()).toEqual([
      ['designer', 'marketing'],
      ['marketing', 'founder'],
    ]);
  });

  it('stays inert while disabled', async () => {
    await render(false);
    expect(latest?.visible).toBe(false);
    expect(mockLoadPreferences).not.toHaveBeenCalled();
  });

  describe('dev force-fresh flag', () => {
    afterEach(() => {
      window.localStorage.removeItem('canopy.dev.forceHomeOnboarding');
      Object.defineProperty(window, 'devInfo', {
        configurable: true,
        value: undefined,
      });
    });

    it('re-shows a retired module with a fresh in-memory seed in dev', async () => {
      Object.defineProperty(window, 'devInfo', {
        configurable: true,
        value: { isDev: true },
      });
      window.localStorage.setItem('canopy.dev.forceHomeOnboarding', '1');
      mockLoadPreferences.mockResolvedValue({
        onboardingCompleted: [],
        homeOnboardingSuggestions: startedState(
          { roles: { completedAt: 'x' } },
          '2026-08-28T00:00:00.000Z',
        ),
        profileRoles: ['designer'],
      });
      await render();
      expect(latest?.visible).toBe(true);
      // Fresh seed: persisted retirement and completions are ignored...
      expect(latest?.persisted?.entries).toEqual({});
      expect(latest?.persisted?.retiredAt).toBeUndefined();
      // ...while a prior roles answer still pre-selects tiles.
      expect(latest?.selectedRoles).toEqual(['designer']);
      // The seed itself is not persisted.
      expect(mockSavePreferences).not.toHaveBeenCalled();
    });

    it('ignores the flag outside dev builds', async () => {
      window.localStorage.setItem('canopy.dev.forceHomeOnboarding', '1');
      mockLoadPreferences.mockResolvedValue({
        onboardingCompleted: [],
        homeOnboardingSuggestions: startedState(
          { roles: { completedAt: 'x' } },
          '2026-08-28T00:00:00.000Z',
        ),
      });
      await render();
      // Persisted state is used verbatim — no fresh in-memory replay seed.
      expect(latest?.persisted?.entries).toEqual({
        roles: { completedAt: 'x' },
      });
      expect(latest?.persisted?.retiredAt).toBe('2026-08-28T00:00:00.000Z');
      expect(mockSavePreferences).not.toHaveBeenCalled();
    });
  });
});
