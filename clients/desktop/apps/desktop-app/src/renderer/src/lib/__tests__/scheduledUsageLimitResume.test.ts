import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import {
  findPendingUsageLimitResume,
  hasPendingUsageLimitResume,
  isPendingUsageLimitResume,
} from '../scheduledUsageLimitResume';

const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const TARGET = { workspaceId: 'ws-a', worktreeId: 'wt', chatId: 'c1' };

function resumeActivity(
  overrides: Partial<ScheduledActivity> = {},
  action: Partial<{
    workspaceId: string;
    worktreeId: string;
    chatId: string;
    purpose: 'usage_limit_resume' | 'scheduled_send';
  }> = {},
): ScheduledActivity {
  return {
    version: 1,
    id: 'auto-1',
    name: 'Resume',
    enabled: true,
    schedule: {
      kind: 'one_time',
      runAt: '2026-10-25T13:00:00.000Z',
      timezone: 'local',
    },
    action: {
      type: 'worktree_session_prompt',
      workspaceId: 'ws-a',
      worktreeId: 'wt',
      chatId: 'c1',
      prompt: 'continue',
      purpose: 'usage_limit_resume',
      ...action,
    },
    createdAt: '2026-10-25T11:00:00.000Z',
    updatedAt: '2026-10-25T11:00:00.000Z',
    nextRunAt: '2026-10-25T13:00:00.000Z',
    failureCount: 0,
    ...overrides,
  };
}

describe('isPendingUsageLimitResume', () => {
  it('matches an enabled future usage-limit resume for the exact chat', () => {
    expect(isPendingUsageLimitResume(resumeActivity(), TARGET, NOW)).toBe(true);
  });

  it('ignores disabled automations', () => {
    expect(
      isPendingUsageLimitResume(
        resumeActivity({ enabled: false }),
        TARGET,
        NOW,
      ),
    ).toBe(false);
  });

  it('ignores ordinary scheduled sends and automations without a purpose', () => {
    expect(
      isPendingUsageLimitResume(
        resumeActivity({}, { purpose: 'scheduled_send' }),
        TARGET,
        NOW,
      ),
    ).toBe(false);
    const withoutPurpose = resumeActivity();
    if (withoutPurpose.action.type === 'worktree_session_prompt') {
      delete withoutPurpose.action.purpose;
    }
    expect(isPendingUsageLimitResume(withoutPurpose, TARGET, NOW)).toBe(false);
  });

  it('ignores other action types', () => {
    expect(
      isPendingUsageLimitResume(
        resumeActivity({
          action: { type: 'app_advisor_prompt', prompt: 'continue' },
        }),
        TARGET,
        NOW,
      ),
    ).toBe(false);
  });

  it.each([
    ['workspace', { workspaceId: 'ws-b' }],
    ['worktree', { worktreeId: 'wt-2' }],
    ['chat', { chatId: 'c2' }],
  ])('requires the same %s', (_label, action) => {
    expect(
      isPendingUsageLimitResume(resumeActivity({}, action), TARGET, NOW),
    ).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['malformed', 'not a date'],
    ['past', '2026-10-25T11:59:59.999Z'],
    ['exactly now', '2026-10-25T12:00:00.000Z'],
  ])('ignores a %s nextRunAt', (_label, nextRunAt) => {
    expect(
      isPendingUsageLimitResume(resumeActivity({ nextRunAt }), TARGET, NOW),
    ).toBe(false);
  });

  it('matches one millisecond before the scheduled time', () => {
    expect(
      isPendingUsageLimitResume(
        resumeActivity({ nextRunAt: '2026-10-25T12:00:00.001Z' }),
        TARGET,
        NOW,
      ),
    ).toBe(true);
  });
});

describe('findPendingUsageLimitResume', () => {
  it('returns the first matching automation in list order', () => {
    const past = resumeActivity({
      id: 'past',
      nextRunAt: '2026-10-25T11:00:00.000Z',
    });
    const first = resumeActivity({ id: 'first' });
    const second = resumeActivity({ id: 'second' });
    expect(
      findPendingUsageLimitResume([past, first, second], TARGET, NOW)?.id,
    ).toBe('first');
    expect(findPendingUsageLimitResume([past], TARGET, NOW)).toBeUndefined();
  });

  it('stays pending while any duplicate remains', () => {
    const first = resumeActivity({ id: 'first' });
    const second = resumeActivity({ id: 'second' });
    expect(hasPendingUsageLimitResume([first, second], TARGET, NOW)).toBe(true);
    expect(hasPendingUsageLimitResume([second], TARGET, NOW)).toBe(true);
    expect(hasPendingUsageLimitResume([], TARGET, NOW)).toBe(false);
  });
});
