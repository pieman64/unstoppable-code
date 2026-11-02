const mockHasCapability = jest.fn();
const mockMigrateLegacy = jest.fn();
const mockReadJourneyState = jest.fn();
const mockLatchSignal = jest.fn();
const mockReaddir = jest.fn();
const mockReadFile = jest.fn();

jest.mock('../notifications/campaigns/installed-capability', () => ({
  hasInstalledCapability: (): unknown => mockHasCapability(),
}));
jest.mock('../notifications/campaigns/legacy-checklist-migration', () => ({
  migrateLegacyChecklistSignals: (): unknown => mockMigrateLegacy(),
}));

jest.mock('../notifications/campaigns/journey-state', () => ({
  readActivationJourneyState: (): unknown => mockReadJourneyState(),
  latchActivationSignal: (name: string, now: string): unknown =>
    mockLatchSignal(name, now),
}));

jest.mock('node:fs/promises', () => ({
  readdir: (dir: string): unknown => mockReaddir(dir),
  readFile: (file: string, encoding: string): unknown =>
    mockReadFile(file, encoding),
}));

jest.mock('../lib/paths', () => ({
  getWorkspacesRootDir: (): string => '/mock/data-dir/workspaces',
}));

import {
  hasEverPairedMobile,
  hasMeaningfullyActivated,
  hasSubmittedFirstTask,
  isCampaignEligible,
  latchFirstTaskSubmitted,
  resetActivationSignalsForTests,
} from '../notifications/campaigns/activation-signals';
function journey(signals: Record<string, string> = {}): unknown {
  return {
    firstOpenAt: null,
    lastActiveAt: null,
    holdout: null,
    campaigns: {},
    signals,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetActivationSignalsForTests();
  mockHasCapability.mockResolvedValue(false);
  mockMigrateLegacy.mockResolvedValue(undefined);
  mockReadJourneyState.mockResolvedValue(journey());
  mockLatchSignal.mockResolvedValue({ changed: true });
  // Default: no workspaces on disk, so the backfill scan finds nothing.
  mockReaddir.mockRejectedValue(new Error('ENOENT'));
});

describe('hasMeaningfullyActivated', () => {
  it('is false for a user who has done nothing', async () => {
    await expect(hasMeaningfullyActivated()).resolves.toBe(false);
  });

  it.each(['tool-connected', 'capability-installed', 'first-task-submitted'])(
    'counts the independent %s latch',
    async (signal) => {
      mockReadJourneyState.mockResolvedValue(
        journey({ [signal]: '2026-01-01T00:00:00.000Z' }),
      );
      await expect(hasMeaningfullyActivated()).resolves.toBe(true);
    },
  );
  it('latches an observed canonical capability', async () => {
    mockHasCapability.mockResolvedValue(true);
    await expect(hasMeaningfullyActivated()).resolves.toBe(true);
    expect(mockLatchSignal).toHaveBeenCalledWith(
      'capability-installed',
      expect.any(String),
    );
  });
  it('preserves known activation when the legacy probe fails', async () => {
    mockReadJourneyState.mockResolvedValue(
      journey({ 'tool-connected': '2026-01-01T00:00:00.000Z' }),
    );
    mockMigrateLegacy.mockRejectedValue(new Error('legacy unavailable'));
    await expect(hasMeaningfullyActivated()).resolves.toBe(true);
    expect(mockMigrateLegacy).not.toHaveBeenCalled();
  });
  it('counts a submitted task even with no checklist item complete', async () => {
    // The cowork-only case: many tasks, zero checklist items.
    mockReadJourneyState.mockResolvedValue(
      journey({ 'first-task-submitted': '2026-01-01T00:00:00.000Z' }),
    );
    await expect(hasMeaningfullyActivated()).resolves.toBe(true);
  });

  it('propagates a legacy read failure instead of swallowing it', async () => {
    // The fail-closed decision belongs to the caller's `safePredicate`, which
    // maps a rejection to the RETRYABLE `probe-failed`. Swallowing it here
    // returned `true`, which suppressed via the terminal `already-activated`
    // -- so one transient disk error retired the campaign for the session,
    // and `probe-failed` was unreachable in production.
    mockMigrateLegacy.mockRejectedValue(new Error('boom'));
    await expect(hasMeaningfullyActivated()).rejects.toThrow('boom');
  });
});

describe('hasSubmittedFirstTask', () => {
  it('is true once the signal is latched', async () => {
    mockReadJourneyState.mockResolvedValue(
      journey({ 'first-task-submitted': '2026-01-01T00:00:00.000Z' }),
    );
    await expect(hasSubmittedFirstTask()).resolves.toBe(true);
  });

  it('backfills from a persisted chat containing a user message', async () => {
    mockReaddir.mockImplementation((dir: string) => {
      if (dir.endsWith('/workspaces')) {
        // The workspaces root is read with `withFileTypes`, so entries must
        // be Dirent-like; the chats dir is read with plain names.
        return Promise.resolve([
          { name: 'ws-1', isDirectory: (): boolean => true },
        ]);
      }
      return Promise.resolve(
        dir.endsWith('/chat-storage-manifests') ? [] : ['entry-1.json'],
      );
    });
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        tabs: [{ id: 't1', messages: [{ id: 'm1', role: 'user' }] }],
      }),
    );
    await expect(hasSubmittedFirstTask()).resolves.toBe(true);
  });

  it('does not backfill from an assistant-only transcript', async () => {
    mockReaddir.mockImplementation((dir: string) => {
      if (dir.endsWith('/workspaces')) {
        // The workspaces root is read with `withFileTypes`, so entries must
        // be Dirent-like; the chats dir is read with plain names.
        return Promise.resolve([
          { name: 'ws-1', isDirectory: (): boolean => true },
        ]);
      }
      return Promise.resolve(
        dir.endsWith('/chat-storage-manifests') ? [] : ['entry-1.json'],
      );
    });
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        tabs: [{ id: 't1', messages: [{ id: 'm1', role: 'assistant' }] }],
      }),
    );
    await expect(hasSubmittedFirstTask()).resolves.toBe(false);
  });
});

describe('hasEverPairedMobile', () => {
  it('is false without a latch, since there is no backfill', async () => {
    await expect(hasEverPairedMobile()).resolves.toBe(false);
  });

  it('is true once paired', async () => {
    mockReadJourneyState.mockResolvedValue(
      journey({ 'mobile-paired': '2026-01-01T00:00:00.000Z' }),
    );
    await expect(hasEverPairedMobile()).resolves.toBe(true);
  });
});

describe('latchFirstTaskSubmitted', () => {
  it('never rejects, so a failed latch cannot break a chat send', async () => {
    mockLatchSignal.mockRejectedValue(new Error('disk full'));
    await expect(
      latchFirstTaskSubmitted('2026-01-01T00:00:00.000Z'),
    ).resolves.toBeUndefined();
  });
});

describe('isCampaignEligible', () => {
  it('allows the marketplace campaign when no capability is installed', async () => {
    await expect(isCampaignEligible('activation-marketplace')).resolves.toBe(
      true,
    );
  });

  it('blocks the marketplace campaign once a capability is installed', async () => {
    mockReadJourneyState.mockResolvedValue(
      journey({ 'capability-installed': '2026-01-01T00:00:00.000Z' }),
    );
    await expect(isCampaignEligible('activation-marketplace')).resolves.toBe(
      false,
    );
  });

  it('allows the first-task campaign when no task was submitted', async () => {
    await expect(isCampaignEligible('activation-first-task')).resolves.toBe(
      true,
    );
  });

  it('blocks the first-task campaign once a task was submitted', async () => {
    mockReadJourneyState.mockResolvedValue(
      journey({ 'first-task-submitted': '2026-01-01T00:00:00.000Z' }),
    );
    await expect(isCampaignEligible('activation-first-task')).resolves.toBe(
      false,
    );
  });

  it('allows the mobile campaign when never paired', async () => {
    await expect(isCampaignEligible('activation-mobile')).resolves.toBe(true);
  });

  it('blocks the mobile campaign once paired', async () => {
    mockReadJourneyState.mockResolvedValue(
      journey({ 'mobile-paired': '2026-01-01T00:00:00.000Z' }),
    );
    await expect(isCampaignEligible('activation-mobile')).resolves.toBe(false);
  });

  it('leaves the role campaign to its variant resolver', async () => {
    // "No activation action" is already enforced by the global activation
    // gate; the role mapping decides reachability, not this predicate.
    await expect(isCampaignEligible('activation-role-branch')).resolves.toBe(
      true,
    );
  });

  it('propagates a legacy read failure instead of swallowing it', async () => {
    // Same reason as above: the gate turns this into `probe-failed`, not the
    // terminal `not-eligible`.
    mockMigrateLegacy.mockRejectedValue(new Error('boom'));
    await expect(isCampaignEligible('activation-marketplace')).rejects.toThrow(
      'boom',
    );
  });
});

it('keeps independent mobile eligibility available when historical migration fails', async () => {
  mockMigrateLegacy.mockRejectedValue(new Error('legacy unavailable'));
  await expect(isCampaignEligible('activation-mobile')).resolves.toBe(true);
  expect(mockMigrateLegacy).not.toHaveBeenCalled();
});
it('keeps marketplace activation latched after uninstall', async () => {
  mockReadJourneyState.mockResolvedValue(
    journey({ 'capability-installed': '2026-01-01T00:00:00.000Z' }),
  );
  mockHasCapability.mockResolvedValue(false);
  await expect(isCampaignEligible('activation-marketplace')).resolves.toBe(
    false,
  );
});
it('does not hide capability read failures as inactivity', async () => {
  mockHasCapability.mockRejectedValue(new Error('capability unavailable'));
  await expect(hasMeaningfullyActivated()).rejects.toThrow(
    'capability unavailable',
  );
  await expect(isCampaignEligible('activation-marketplace')).rejects.toThrow(
    'capability unavailable',
  );
});

it('does not turn legacy uncertainty into an outage for the independent mobile campaign', async () => {
  mockMigrateLegacy.mockRejectedValue(new Error('legacy unavailable'));
  await expect(hasMeaningfullyActivated('activation-mobile')).resolves.toBe(
    false,
  );
  await expect(
    hasMeaningfullyActivated('activation-marketplace'),
  ).rejects.toThrow('legacy unavailable');
});

it('keeps a positive canonical observation suppressing mobile even if its latch rejects', async () => {
  mockHasCapability.mockResolvedValue(true);
  mockLatchSignal.mockRejectedValue(new Error('latch unavailable'));
  mockMigrateLegacy.mockRejectedValue(new Error('legacy unavailable'));
  await expect(hasMeaningfullyActivated('activation-mobile')).resolves.toBe(
    true,
  );
});
