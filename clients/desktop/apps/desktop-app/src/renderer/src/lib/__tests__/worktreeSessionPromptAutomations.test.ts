import {
  formatScheduledCadence,
  formatScheduledSendLabel,
  getScheduledMessagesForChat,
  getScheduledMessagesForWorktree,
  hasScheduledMessagesForWorktree,
} from '../worktreeSessionPromptAutomations';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import { formatUsageLimitTimeLabel } from '../usage-limit-time-label';

const NOW = new Date('2026-06-05T12:00:00.000Z');

function activity(overrides: Partial<ScheduledActivity>): ScheduledActivity {
  return {
    version: 1,
    id: 'a1',
    name: 'Scheduled message',
    enabled: true,
    schedule: {
      kind: 'one_time',
      runAt: '2026-06-05T13:00:00.000Z',
      timezone: 'local',
    },
    action: {
      type: 'worktree_session_prompt',
      workspaceId: 'ws',
      worktreeId: 'wt',
      chatId: 'chat',
      prompt: 'hello',
    },
    createdAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
    nextRunAt: '2026-06-05T13:00:00.000Z',
    failureCount: 0,
    ...overrides,
  } as ScheduledActivity;
}

const TARGET = {
  workspaceId: 'ws',
  worktreeId: 'wt',
  chatId: 'chat',
  now: NOW,
};

describe('getScheduledMessagesForChat', () => {
  it('includes enabled future session prompts for the target chat', () => {
    const result = getScheduledMessagesForChat({
      activities: [activity({})],
      ...TARGET,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      automationId: 'a1',
      chatId: 'chat',
      text: 'hello',
      scheduledAt: '2026-06-05T13:00:00.000Z',
      scheduleKind: 'one_time',
    });
  });

  it('keeps enabled past-due session prompts visible for the target chat', () => {
    const result = getScheduledMessagesForChat({
      activities: [
        activity({
          id: 'past',
          nextRunAt: '2026-06-05T11:00:00.000Z',
        }),
      ],
      ...TARGET,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      automationId: 'past',
      scheduledAt: '2026-06-05T11:00:00.000Z',
    });
  });

  it('excludes disabled, missing-next-run, mismatched-target, and non-session activities', () => {
    const result = getScheduledMessagesForChat({
      activities: [
        activity({ id: 'disabled', enabled: false }),
        activity({
          id: 'no-next',
          nextRunAt: undefined,
        }),
        activity({
          id: 'other-chat',
          action: {
            type: 'worktree_session_prompt',
            workspaceId: 'ws',
            worktreeId: 'wt',
            chatId: 'different',
            prompt: 'x',
          },
        }),
        activity({
          id: 'other-type',
          action: { type: 'app_advisor_prompt', prompt: 'x' },
        }),
      ],
      ...TARGET,
    });
    expect(result).toHaveLength(0);
  });

  it('sorts by next run ascending with a stable id tiebreak', () => {
    const result = getScheduledMessagesForChat({
      activities: [
        activity({ id: 'b', nextRunAt: '2026-06-05T15:00:00.000Z' }),
        activity({ id: 'a', nextRunAt: '2026-06-05T13:00:00.000Z' }),
        activity({ id: 'c', nextRunAt: '2026-06-05T13:00:00.000Z' }),
      ],
      ...TARGET,
    });
    expect(result.map((entry) => entry.automationId)).toEqual(['a', 'c', 'b']);
  });

  it('carries the attachment payload through', () => {
    const result = getScheduledMessagesForChat({
      activities: [
        activity({
          action: {
            type: 'worktree_session_prompt',
            workspaceId: 'ws',
            worktreeId: 'wt',
            chatId: 'chat',
            prompt: 'with attachments',
            attachmentPaths: ['/tmp/a.png'],
            inputMode: 'voice',
          },
        }),
      ],
      ...TARGET,
    });
    expect(result[0]).toMatchObject({
      attachmentPaths: ['/tmp/a.png'],
      inputMode: 'voice',
    });
  });
});

describe('getScheduledMessagesForWorktree', () => {
  it('includes scheduled messages across chats for the target worktree', () => {
    const result = getScheduledMessagesForWorktree({
      activities: [
        activity({
          id: 'chat-a',
          action: {
            type: 'worktree_session_prompt',
            workspaceId: 'ws',
            worktreeId: 'wt',
            chatId: 'chat-a',
            chatTitle: 'Planning',
            prompt: 'review the plan',
          },
        }),
        activity({
          id: 'chat-b',
          nextRunAt: '2026-06-05T14:00:00.000Z',
          action: {
            type: 'worktree_session_prompt',
            workspaceId: 'ws',
            worktreeId: 'wt',
            chatId: 'chat-b',
            prompt: 'send a follow-up',
          },
        }),
        activity({
          id: 'other-worktree',
          action: {
            type: 'worktree_session_prompt',
            workspaceId: 'ws',
            worktreeId: 'other',
            chatId: 'chat-c',
            prompt: 'ignore me',
          },
        }),
      ],
      workspaceId: 'ws',
      worktreeId: 'wt',
    });

    expect(result.map((entry) => entry.automationId)).toEqual([
      'chat-a',
      'chat-b',
    ]);
    expect(result[0]).toMatchObject({
      chatId: 'chat-a',
      chatTitle: 'Planning',
      text: 'review the plan',
    });
  });
});

// CAN-3053 finding 5: the sidebar row reads this boolean through a per-row
// selector instead of subscribing to the whole activities array, so it must
// match `getScheduledMessagesForWorktree`'s own match rule exactly — a drift
// here would either hide a badge that should show, or show one with no
// popover content.
describe('hasScheduledMessagesForWorktree', () => {
  it('is true exactly when getScheduledMessagesForWorktree would return a match', () => {
    const activities = [
      activity({
        id: 'match',
        action: {
          type: 'worktree_session_prompt',
          workspaceId: 'ws',
          worktreeId: 'wt',
          chatId: 'chat',
          prompt: 'hello',
        },
      }),
      activity({
        id: 'other-worktree',
        action: {
          type: 'worktree_session_prompt',
          workspaceId: 'ws',
          worktreeId: 'other',
          chatId: 'chat-c',
          prompt: 'ignore me',
        },
      }),
    ];
    expect(hasScheduledMessagesForWorktree(activities, 'ws', 'wt')).toBe(true);
    expect(
      getScheduledMessagesForWorktree({
        activities,
        workspaceId: 'ws',
        worktreeId: 'wt',
      }).length > 0,
    ).toBe(true);
  });

  it('is false for a worktree with no matching schedule', () => {
    const activities = [
      activity({
        action: {
          type: 'worktree_session_prompt',
          workspaceId: 'ws',
          worktreeId: 'other',
          chatId: 'chat',
          prompt: 'hello',
        },
      }),
    ];
    expect(hasScheduledMessagesForWorktree(activities, 'ws', 'wt')).toBe(false);
  });

  it('is false for a disabled activity, matching the message-list rule', () => {
    const activities = [activity({ enabled: false })];
    expect(hasScheduledMessagesForWorktree(activities, 'ws', 'wt')).toBe(false);
  });
});

describe('scheduleExpression projection', () => {
  it('sets scheduleExpression for cron automations', () => {
    const result = getScheduledMessagesForChat({
      activities: [
        activity({
          schedule: {
            kind: 'cron',
            expression: '0 * * * *',
            timezone: 'local',
          },
        }),
      ],
      ...TARGET,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      scheduleKind: 'cron',
      scheduleExpression: '0 * * * *',
    });
  });

  it('omits scheduleExpression for one-time automations', () => {
    const result = getScheduledMessagesForChat({
      activities: [activity({})],
      ...TARGET,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('scheduleExpression');
  });
});

describe('formatScheduledCadence', () => {
  it('describes an hourly cron', () => {
    expect(
      formatScheduledCadence({
        scheduleKind: 'cron',
        scheduleExpression: '0 * * * *',
      }),
    ).toBe('Every hour');
  });

  it('describes a daily cron', () => {
    expect(
      formatScheduledCadence({
        scheduleKind: 'cron',
        scheduleExpression: '30 9 * * *',
      }),
    ).toBe('Every day at 09:30');
  });

  it('falls back to Recurring for an expression it cannot describe', () => {
    expect(
      formatScheduledCadence({
        scheduleKind: 'cron',
        scheduleExpression: '0 9 1 1 *',
      }),
    ).toBe('Recurring');
    expect(formatScheduledCadence({ scheduleKind: 'cron' })).toBe('Recurring');
  });

  it('returns null for one-time schedules', () => {
    expect(formatScheduledCadence({ scheduleKind: 'one_time' })).toBeNull();
  });
});

describe('formatScheduledSendLabel', () => {
  const LOCAL_NOW = new Date(2026, 8, 30, 12, 0, 0);

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(LOCAL_NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows a bare clock time for later today', () => {
    const at = new Date(2026, 8, 30, 18, 0, 0).toISOString();
    const label = formatScheduledSendLabel(at);
    expect(label).toBe(formatUsageLimitTimeLabel(at));
    expect(label).not.toContain(',');
  });

  it('shows weekday and time within the coming week', () => {
    const at = new Date(2026, 9, 6, 9, 0, 0).toISOString();
    expect(formatScheduledSendLabel(at)).toBe(formatUsageLimitTimeLabel(at));
  });

  it('uses a short date for the same weekday on another date', () => {
    // LOCAL_NOW is a Wednesday; the next Wednesday morning is under seven
    // days away, where a bare "Wed" would read as today.
    const target = new Date(2026, 9, 7, 9, 0, 0);
    const label = formatScheduledSendLabel(target.toISOString());
    expect(label).toBe(
      target.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }),
    );
    expect(label).not.toBe(formatUsageLimitTimeLabel(target.toISOString()));
  });

  it('falls back to a short date seven or more days out', () => {
    const target = new Date(2026, 9, 14, 9, 0, 0);
    const label = formatScheduledSendLabel(target.toISOString());
    expect(label).toBe(
      target.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }),
    );
    expect(label).toContain('14');
    expect(label).not.toBe(formatUsageLimitTimeLabel(target.toISOString()));
  });

  it('returns null for missing or invalid times', () => {
    expect(formatScheduledSendLabel('')).toBeNull();
    expect(formatScheduledSendLabel(undefined)).toBeNull();
    expect(formatScheduledSendLabel('not a date')).toBeNull();
  });
});
