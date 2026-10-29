/**
 * @jest-environment jsdom
 *
 * Durable send-driven completion, decoupled from the module's mount
 * lifetime — the regression: every navigating Home send unmounts the
 * module, so completion must persist through a module-scope writer, not a
 * component subscriber. These tests exercise the writer with NO component
 * mounted at all.
 */

import type {
  HomeOnboardingSuggestionsPreferences,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import { notifyHomeTaskSent } from '../sendEvents';
import {
  clearOnboardingProfileRolesDurably,
  __resetOnboardingSuggestionArmingForTests,
  armOnboardingSuggestion,
  completeOnboardingSuggestionDurably,
  disarmOnboardingSuggestion,
  onOnboardingSuggestionCompleted,
  mutateOnboardingSuggestionsDurably,
  onOnboardingSuggestionsRestored,
  restoreOnboardingSuggestionsDurably,
  seedOnboardingSuggestionsDurably,
} from '../completionWriter';

const mockTrackCompleted = jest.fn();
jest.mock('../telemetry', () => ({
  trackOnboardingSuggestionCompleted: (...args: unknown[]): void => {
    mockTrackCompleted(...args);
  },
}));

const mockLoadPreferences = jest.fn<Promise<Partial<PreferencesData>>, []>();
const mockSavePreferences = jest.fn<
  Promise<void>,
  [Partial<PreferencesData>]
>();

function persisted(
  entries: HomeOnboardingSuggestionsPreferences['entries'] = {},
): HomeOnboardingSuggestionsPreferences {
  return { startedAt: '2026-08-27T00:00:00.000Z', entries };
}

async function flushWrites(): Promise<void> {
  // The serialized mutation chain adds promise hops (chain → load →
  // mutator → save → listener); flush generously.
  for (let hop = 0; hop < 10; hop += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetOnboardingSuggestionArmingForTests();
  mockLoadPreferences.mockResolvedValue({
    homeOnboardingSuggestions: persisted(),
  });
  mockSavePreferences.mockResolvedValue(undefined);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences: mockLoadPreferences,
      savePreferences: mockSavePreferences,
    },
  });
});

describe('completionWriter', () => {
  it('persists an armed entry on the next chat send with no component mounted', async () => {
    armOnboardingSuggestion('github');
    notifyHomeTaskSent({ kind: 'chat' });
    await flushWrites();

    expect(mockSavePreferences).toHaveBeenCalledTimes(1);
    const saved = mockSavePreferences.mock.calls[0][0];
    expect(
      typeof saved.homeOnboardingSuggestions?.entries.github?.completedAt,
    ).toBe('string');

    // Disarmed: a second send writes nothing more.
    notifyHomeTaskSent({ kind: 'chat' });
    await flushWrites();
    expect(mockSavePreferences).toHaveBeenCalledTimes(1);
  });

  it('does nothing for an unarmed chat send', async () => {
    notifyHomeTaskSent({ kind: 'chat' });
    await flushWrites();
    expect(mockLoadPreferences).not.toHaveBeenCalled();
    expect(mockSavePreferences).not.toHaveBeenCalled();
  });

  it('completes the plan lesson only after a successful Plan-mode chat send', async () => {
    notifyHomeTaskSent({ kind: 'pipeline' });
    notifyHomeTaskSent({ kind: 'chat' });
    await flushWrites();
    expect(mockSavePreferences).not.toHaveBeenCalled();
    notifyHomeTaskSent({ kind: 'chat', planMode: true });
    await flushWrites();
    const saved = mockSavePreferences.mock.calls[0][0];
    expect(
      typeof saved.homeOnboardingSuggestions?.entries['plan-mode']?.completedAt,
    ).toBe('string');
  });

  it('starts the module with the entry completed when a dispatch lands before it started', async () => {
    // A Plan-mode chat send can precede the first Home mount that seeds the
    // module; the finished lesson must still count.
    mockLoadPreferences.mockResolvedValue({});
    notifyHomeTaskSent({ kind: 'chat', planMode: true });
    await flushWrites();
    expect(mockSavePreferences).toHaveBeenCalledTimes(1);
    const saved =
      mockSavePreferences.mock.calls[0][0].homeOnboardingSuggestions;
    expect(typeof saved?.startedAt).toBe('string');
    expect(typeof saved?.entries['plan-mode']?.completedAt).toBe('string');
  });

  it('skips the write when the entry is already resolved', async () => {
    mockLoadPreferences.mockResolvedValue({
      homeOnboardingSuggestions: persisted({
        'plan-mode': { dismissedAt: 'x' },
      }),
    });
    notifyHomeTaskSent({ kind: 'chat', planMode: true });
    await flushWrites();
    expect(mockSavePreferences).not.toHaveBeenCalled();
  });

  it('disarm prevents a stale completion', async () => {
    armOnboardingSuggestion('linear');
    disarmOnboardingSuggestion('linear');
    notifyHomeTaskSent({ kind: 'chat' });
    await flushWrites();
    expect(mockSavePreferences).not.toHaveBeenCalled();
  });

  it('targeted disarm of a DIFFERENT entry leaves the arm intact', async () => {
    armOnboardingSuggestion('github');
    disarmOnboardingSuggestion('linear');
    notifyHomeTaskSent({ kind: 'chat' });
    await flushWrites();
    const saved = mockSavePreferences.mock.calls[0][0];
    expect(
      typeof saved.homeOnboardingSuggestions?.entries.github?.completedAt,
    ).toBe('string');
  });

  it('targeted disarm of the SAME entry clears the arm', async () => {
    armOnboardingSuggestion('github');
    disarmOnboardingSuggestion('github');
    notifyHomeTaskSent({ kind: 'chat' });
    await flushWrites();
    expect(mockSavePreferences).not.toHaveBeenCalled();
  });

  it('an unrelated pipeline dispatch does not cancel a pending armed entry', async () => {
    armOnboardingSuggestion('github');
    // An unrelated pipeline must leave the pending chat lesson armed.
    notifyHomeTaskSent({ kind: 'pipeline' });
    await flushWrites();
    expect(mockSavePreferences).not.toHaveBeenCalled();
    notifyHomeTaskSent({ kind: 'chat' });
    await flushWrites();

    expect(mockSavePreferences).toHaveBeenCalledTimes(1);
    const first = mockSavePreferences.mock.calls[0][0];
    expect(
      typeof first.homeOnboardingSuggestions?.entries.github?.completedAt,
    ).toBe('string');
  });

  it('notifies mounted listeners after the durable write', async () => {
    const listener = jest.fn();
    const unsubscribe = onOnboardingSuggestionCompleted(listener);
    armOnboardingSuggestion('github');
    notifyHomeTaskSent({ kind: 'chat' });
    await flushWrites();
    expect(listener).toHaveBeenCalledWith('github');
    unsubscribe();
  });

  it('starts the module with the entry completed when nothing is persisted yet', async () => {
    // The first-run wizard's import step runs before Home has ever mounted,
    // so no module state exists to patch. The completion must still be
    // durable: start the module here, with this entry already done, so the
    // Getting started checklist never re-offers work the user finished.
    // The mounted copy (a forced replay running in memory, or a seed still
    // in flight) hears it as well.
    mockLoadPreferences.mockResolvedValue({});
    const listener = jest.fn();
    const unsubscribe = onOnboardingSuggestionCompleted(listener);
    completeOnboardingSuggestionDurably('import-projects');
    await flushWrites();
    expect(mockSavePreferences).toHaveBeenCalledTimes(1);
    const saved =
      mockSavePreferences.mock.calls[0][0].homeOnboardingSuggestions;
    expect(typeof saved?.startedAt).toBe('string');
    expect(typeof saved?.entries['import-projects']?.completedAt).toBe(
      'string',
    );
    expect(listener).toHaveBeenCalledWith('import-projects');
    unsubscribe();
  });

  it('does not start a module the harness has hidden', async () => {
    // The E2E harness suppresses the module so unrelated automation sees a
    // settled Home; a completion must not start it behind that switch.
    mockLoadPreferences.mockResolvedValue({});
    Object.defineProperty(window, 'devInfo', {
      configurable: true,
      value: { hideOnboardingSuggestions: true },
    });
    try {
      completeOnboardingSuggestionDurably('import-projects');
      await flushWrites();
      expect(mockSavePreferences).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(window, 'devInfo');
    }
  });

  it('reports why an entry completed', async () => {
    // Skip for now and a real import both complete the entry; telemetry
    // keeps them apart so the funnel can still count actual imports.
    completeOnboardingSuggestionDurably('import-projects', 'skipped');
    await flushWrites();
    expect(mockTrackCompleted).toHaveBeenCalledWith(
      'import-projects',
      'skipped',
    );
  });

  it('never starts the module over a degraded preferences read', async () => {
    mockLoadPreferences.mockResolvedValue({ __error: 'EACCES' });
    const listener = jest.fn();
    const unsubscribe = onOnboardingSuggestionCompleted(listener);
    completeOnboardingSuggestionDurably('import-projects');
    await flushWrites();
    expect(mockSavePreferences).not.toHaveBeenCalled();
    // An in-memory module may still be running; it hears the completion.
    expect(listener).toHaveBeenCalledWith('import-projects');
    unsubscribe();
  });

  it('still tells the mounted module when the entry is already resolved on disk', async () => {
    // Disk and the mounted copy can disagree: the dev-only forced replay
    // runs the module from an in-memory seed in which the entry is still
    // pending while the persisted entry was dismissed weeks ago. Nothing is
    // written, but the mounted copy must hear the completion or it keeps
    // offering work the user just finished.
    mockLoadPreferences.mockResolvedValue({
      homeOnboardingSuggestions: persisted({
        'import-projects': { dismissedAt: '2026-09-01T00:00:00.000Z' },
      }),
    });
    const listener = jest.fn();
    const unsubscribe = onOnboardingSuggestionCompleted(listener);
    completeOnboardingSuggestionDurably('import-projects');
    await flushWrites();
    expect(mockSavePreferences).not.toHaveBeenCalled();
    expect(mockTrackCompleted).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledWith('import-projects');
    unsubscribe();
  });
});

describe('mutateOnboardingSuggestionsDurably', () => {
  it('does not mutate over a degraded preferences read', async () => {
    mockLoadPreferences.mockResolvedValue({
      __error: 'EACCES',
      homeOnboardingSuggestions: persisted(),
    });
    await mutateOnboardingSuggestionsDurably((state) => ({
      ...state,
      entries: { ...state.entries, github: { dismissedAt: 'x' } },
    }));
    expect(mockSavePreferences).not.toHaveBeenCalled();
  });
});

describe('seedOnboardingSuggestionsDurably', () => {
  it('does not write over a degraded preferences read', async () => {
    mockLoadPreferences.mockResolvedValue({ __error: 'EACCES' });
    await seedOnboardingSuggestionsDurably(persisted());
    expect(mockSavePreferences).not.toHaveBeenCalled();
  });

  it('writes the seed once when no module state exists', async () => {
    mockLoadPreferences.mockResolvedValue({});
    await seedOnboardingSuggestionsDurably(persisted());
    expect(mockSavePreferences).toHaveBeenCalledTimes(1);
  });
});

describe('restoreOnboardingSuggestionsDurably', () => {
  it('clears row dismissals but keeps completions and the start', async () => {
    // Settings → "Show setup checklist" is the only way back for a user who
    // dismissed rows one by one, so it must undo those dismissals while
    // leaving finished work finished.
    mockLoadPreferences.mockResolvedValue({
      homeOnboardingSuggestions: {
        ...persisted({
          github: { dismissedAt: '2026-09-01T00:00:00.000Z' },
          'agent-connections': { completedAt: '2026-09-01T00:00:00.000Z' },
        }),
        retiredAt: '2026-09-02T00:00:00.000Z',
      },
    });
    const listener = jest.fn();
    const unsubscribe = onOnboardingSuggestionsRestored(listener);
    await restoreOnboardingSuggestionsDurably();

    expect(mockSavePreferences).toHaveBeenCalledTimes(1);
    const saved =
      mockSavePreferences.mock.calls[0][0].homeOnboardingSuggestions;
    expect(saved?.startedAt).toBe('2026-08-27T00:00:00.000Z');
    expect(saved?.retiredAt).toBeUndefined();
    expect(saved?.entries.github?.dismissedAt).toBeUndefined();
    expect(saved?.entries['agent-connections']?.completedAt).toBe(
      '2026-09-01T00:00:00.000Z',
    );
    expect(listener).toHaveBeenCalledWith(saved);
    unsubscribe();
  });
});

describe('clearOnboardingProfileRolesDurably', () => {
  it('clears the saved roles and reopens only the tools step that asks for them', async () => {
    mockLoadPreferences.mockResolvedValue({
      homeOnboardingSuggestions: persisted({
        github: { completedAt: '2026-09-01T00:00:00.000Z' },
        'add-repo': { dismissedAt: '2026-09-01T00:00:00.000Z' },
      }),
    });
    await clearOnboardingProfileRolesDurably();
    expect(mockSavePreferences).toHaveBeenCalledTimes(1);
    const saved = mockSavePreferences.mock.calls[0][0];
    expect(saved.profileRoles).toEqual([]);
    // The category row on the tools step replaced the roles lesson.
    expect(saved.homeOnboardingSuggestions?.entries.github).toBeUndefined();
    expect(saved.homeOnboardingSuggestions?.entries['add-repo']).toEqual({
      dismissedAt: '2026-09-01T00:00:00.000Z',
    });
  });
});

describe('completionWriter arming scope (CAN-3032)', () => {
  it('completes a chat-armed entry only on a send from that same tab', async () => {
    armOnboardingSuggestion('blueprint:p1:prompt:ws-1', { chatId: 'tab-a' });
    notifyHomeTaskSent({ kind: 'chat', chatId: 'tab-b' });
    notifyHomeTaskSent({ kind: 'chat' });
    await flushWrites();
    expect(mockSavePreferences).not.toHaveBeenCalled();

    notifyHomeTaskSent({ kind: 'chat', chatId: 'tab-a' });
    await flushWrites();
    expect(mockSavePreferences).toHaveBeenCalledTimes(1);
    const saved = mockSavePreferences.mock.calls[0][0];
    expect(
      typeof saved.homeOnboardingSuggestions?.entries[
        'blueprint:p1:prompt:ws-1'
      ]?.completedAt,
    ).toBe('string');
  });

  it('keeps a Home-armed entry pending across sends from chat tabs', async () => {
    armOnboardingSuggestion('notifications');
    notifyHomeTaskSent({ kind: 'chat', chatId: 'tab-a' });
    await flushWrites();
    expect(mockSavePreferences).not.toHaveBeenCalled();

    notifyHomeTaskSent({ kind: 'chat' });
    await flushWrites();
    expect(mockSavePreferences).toHaveBeenCalledTimes(1);
    expect(
      typeof mockSavePreferences.mock.calls[0][0].homeOnboardingSuggestions
        ?.entries.notifications?.completedAt,
    ).toBe('string');
  });

  it('leaves the plan lesson to Home sends', async () => {
    notifyHomeTaskSent({ kind: 'chat', chatId: 'tab-a', planMode: true });
    await flushWrites();
    expect(mockSavePreferences).not.toHaveBeenCalled();
  });
});
