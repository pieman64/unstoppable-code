const mockComputeState = jest.fn();
const mockReadJourneyState = jest.fn();
const mockLatchSignal = jest.fn();
const mockReaddir = jest.fn();
const mockReadFile = jest.fn();

jest.mock('../lib/onboarding-checklist-progress', () => ({
  computeOnboardingChecklistState: (): unknown => mockComputeState(),
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
  ACTIVATION_ITEM_IDS,
  hasEverPairedMobile,
  hasMeaningfullyActivated,
  hasSubmittedFirstTask,
  isCampaignEligible,
  latchFirstTaskSubmitted,
  resetActivationSignalsForTests,
} from '../notifications/campaigns/activation-signals';
import { ONBOARDING_CHECKLIST_ITEM_IDS } from '@canopy/desktop-shared/types';
import type { OnboardingChecklistItemId } from '@canopy/desktop-shared/types';

// Built from the real id list rather than a hardcoded copy: a hardcoded one
// silently stopped covering `start-chat` when CAN-2663 changed the step set,
// which made the parameterized activation test below fail for a fixture
// reason rather than a behavior one.
function checklist(complete: OnboardingChecklistItemId[]): unknown {
  return {
    items: ONBOARDING_CHECKLIST_ITEM_IDS.map((id) => ({
      id,
      complete: complete.includes(id),
    })),
    dismissedAt: null,
    snoozedUntil: null,
    providersNotUsed: [],
  };
}

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
  mockComputeState.mockResolvedValue(checklist([]));
  mockReadJourneyState.mockResolvedValue(journey());
  mockLatchSignal.mockResolvedValue({ changed: true });
  // Default: no workspaces on disk, so the backfill scan finds nothing.
  mockReaddir.mockRejectedValue(new Error('ENOENT'));
});

describe('hasMeaningfullyActivated', () => {
  it('is false for a user who has done nothing', async () => {
    await expect(hasMeaningfullyActivated()).resolves.toBe(false);
  });

  // Signing in is an account action, not evidence the user did anything with
  // the product -- the same reason the retired `choose-role` item was excluded.
  it('does not count creating an account as activation', async () => {
    mockComputeState.mockResolvedValue(checklist(['create-account']));
    await expect(hasMeaningfullyActivated()).resolves.toBe(false);
  });

  it.each(ACTIVATION_ITEM_IDS)('counts %s as activation', async (itemId) => {
    mockComputeState.mockResolvedValue(checklist([itemId]));
    await expect(hasMeaningfullyActivated()).resolves.toBe(true);
  });

  it('counts a submitted task even with no checklist item complete', async () => {
    // The cowork-only case: many tasks, zero checklist items.
    mockReadJourneyState.mockResolvedValue(
      journey({ 'first-task-submitted': '2026-01-01T00:00:00.000Z' }),
    );
    await expect(hasMeaningfullyActivated()).resolves.toBe(true);
  });

  it('propagates a checklist read failure instead of swallowing it', async () => {
    // The fail-closed decision belongs to the caller's `safePredicate`, which
    // maps a rejection to the RETRYABLE `probe-failed`. Swallowing it here
    // returned `true`, which suppressed via the terminal `already-activated`
    // -- so one transient disk error retired the campaign for the session,
    // and `probe-failed` was unreachable in production.
    mockComputeState.mockRejectedValue(new Error('boom'));
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
    mockComputeState.mockResolvedValue(checklist(['add-capability']));
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

  it('propagates a checklist read failure instead of swallowing it', async () => {
    // Same reason as above: the gate turns this into `probe-failed`, not the
    // terminal `not-eligible`.
    mockComputeState.mockRejectedValue(new Error('boom'));
    await expect(isCampaignEligible('activation-marketplace')).rejects.toThrow(
      'boom',
    );
  });
});
