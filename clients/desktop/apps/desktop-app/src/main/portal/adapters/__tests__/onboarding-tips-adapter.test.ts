import type {
  PortalCommandEnvelope,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import {
  handlePortalOnboardingTipsGet,
  handlePortalOnboardingTipsUpdate,
} from '../onboarding-tips-adapter';
import type { PortalAdapterContext } from '../types';
import {
  readPreferencesFileDetailed,
  updatePreferencesFile,
} from '../../../lib/preferences-store';
import { broadcastCommittedPreferences } from '../../../ipc/preferences';
import { makeTestPreferences } from '../../../../renderer/src/test-utils/preferences';

jest.mock('../../../lib/preferences-store', () => ({
  readPreferencesFileDetailed: jest.fn(),
  updatePreferencesFile: jest.fn(),
}));
jest.mock('../../../ipc/preferences', () => ({
  broadcastCommittedPreferences: jest.fn(),
}));

const mockedRead = jest.mocked(readPreferencesFileDetailed);
const mockedUpdate = jest.mocked(updatePreferencesFile);
const mockedBroadcast = jest.mocked(broadcastCommittedPreferences);

function command(
  type: 'portal.onboarding_tips.get' | 'portal.onboarding_tips.update',
  payload: unknown,
): PortalCommandEnvelope<unknown> {
  return {
    id: 'cmd-1',
    sequence: 1,
    type,
    payload,
    createdAt: '2026-10-24T00:00:00.000Z',
    expiresAt: null,
  };
}

interface Outcome {
  completed?: unknown;
  failed?: { code: string; message: string };
}

function context(outcome: Outcome): PortalAdapterContext {
  return {
    getWindow: () => null,
    enqueueEvent: jest.fn(),
    complete: (_command, result): void => {
      outcome.completed = result;
    },
    fail: (_command, code, message): void => {
      outcome.failed = { code, message };
    },
  };
}

function preferences(
  onboardingTipsDismissed: PreferencesData['onboardingTipsDismissed'],
): PreferencesData {
  return makeTestPreferences({ onboardingTipsDismissed });
}

describe('onboarding tips portal adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the stored dismissals', async () => {
    mockedRead.mockResolvedValue({
      preferences: preferences({ workflows: '2026-10-24T09:00:00.000Z' }),
      authority: 'ok',
    });
    const outcome: Outcome = {};
    await handlePortalOnboardingTipsGet(
      command('portal.onboarding_tips.get', {}),
      context(outcome),
    );
    expect(outcome.completed).toEqual({
      dismissed: { workflows: '2026-10-24T09:00:00.000Z' },
    });
  });

  it('fails rather than report nothing dismissed when preferences are unreadable', async () => {
    mockedRead.mockResolvedValue({
      preferences: preferences({}),
      authority: 'unreadable',
    });
    const outcome: Outcome = {};
    await handlePortalOnboardingTipsGet(
      command('portal.onboarding_tips.get', {}),
      context(outcome),
    );
    expect(outcome.completed).toBeUndefined();
    expect(outcome.failed?.code).toBe('execution_failed');
  });

  it('rejects a malformed update without writing', async () => {
    const outcome: Outcome = {};
    await handlePortalOnboardingTipsUpdate(
      command('portal.onboarding_tips.update', {
        action: 'dismiss',
        tipId: 'not-a-tip',
      }),
      context(outcome),
    );
    expect(outcome.failed?.code).toBe('invalid_payload');
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it('applies a dismissal to the latest stored record and syncs desktop windows', async () => {
    const captured: { written?: Partial<PreferencesData> | null } = {};
    mockedUpdate.mockImplementation(async (updater) => {
      // The desktop dismissed another tip after the browser last read.
      const latest = preferences({
        'worktree-chat': '2026-10-24T08:00:00.000Z',
      });
      captured.written = await updater(latest);
      return { ...latest, ...captured.written };
    });
    const outcome: Outcome = {};
    await handlePortalOnboardingTipsUpdate(
      command('portal.onboarding_tips.update', {
        action: 'dismiss',
        tipId: 'workflows',
      }),
      context(outcome),
    );
    const dismissed = captured.written?.onboardingTipsDismissed ?? {};
    expect(Object.keys(dismissed).sort()).toEqual([
      'workflows',
      'worktree-chat',
    ]);
    expect(dismissed['worktree-chat']).toBe('2026-10-24T08:00:00.000Z');
    expect(Number.isNaN(Date.parse(dismissed.workflows ?? ''))).toBe(false);
    expect(outcome.completed).toEqual({ dismissed });
    expect(mockedBroadcast).toHaveBeenCalledTimes(1);
  });

  it('clears every dismissal on reset', async () => {
    mockedUpdate.mockImplementation(async (updater) => {
      const latest = preferences({ workflows: '2026-10-24T08:00:00.000Z' });
      return { ...latest, ...(await updater(latest)) };
    });
    const outcome: Outcome = {};
    await handlePortalOnboardingTipsUpdate(
      command('portal.onboarding_tips.update', { action: 'reset' }),
      context(outcome),
    );
    expect(outcome.completed).toEqual({ dismissed: {} });
  });
});
