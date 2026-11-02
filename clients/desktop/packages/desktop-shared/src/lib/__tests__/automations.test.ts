import type {
  AutomationAction,
  AutomationCreateRequest,
  AutomationTrigger,
  ScheduledActivity,
} from '../../types';
import { SIDEBAR_ITEM_GROUP_NAME_LIMIT } from '@canopy/protocol/sidebar';
import {
  automationPipelineSpeedError,
  describeAutomationAction,
  enumerateAutomationOccurrences,
  enumerateAutomationTriggerOccurrences,
  formatCronValidationError,
  getAutomationChatRunMode,
  getAutomationChatRunModeLabel,
  getAutomationTriggerLabel,
  getNextCronRun,
  getNextAutomationTriggerRun,
  parseFiveFieldCron,
  validateAutomationAction,
  validateAutomationActionForWrite,
  validateAutomationCreateRequest,
  validateAutomationTrigger,
  validateAutomationInstalledFrom,
  validateAutomationSharedPipelineReview,
  normalizeAutomationSharedPipelineReview,
  MAX_AUTOMATION_PIPELINE_DEPENDENCIES,
  normalizeAutomationDependencies,
  validateAutomationDependencies,
} from '../automations';

function createActivity(
  id: string,
  schedule: AutomationTrigger,
  enabled = true,
): ScheduledActivity {
  return {
    version: 1,
    id,
    name: id,
    enabled,
    schedule,
    action: {
      type: 'app_advisor_prompt',
      prompt: 'Run automation',
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    failureCount: 0,
  };
}

describe('parseFiveFieldCron', () => {
  it('accepts step-only every-15-minutes expressions', () => {
    const parsed = parseFiveFieldCron('*/15 * * * *');
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    expect(parsed.minute.values).toEqual([0, 15, 30, 45]);
    expect(parsed.minute.isWildcard).toBe(false);
    expect(parsed.hour.isWildcard).toBe(true);
    expect(parsed.dayOfMonth.isWildcard).toBe(true);
    expect(parsed.month.isWildcard).toBe(true);
    expect(parsed.dayOfWeek.isWildcard).toBe(true);
  });

  it('accepts business-hours weekdays expressions', () => {
    const parsed = parseFiveFieldCron('0 9 * * 1-5');
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    expect(parsed.minute.values).toEqual([0]);
    expect(parsed.hour.values).toEqual([9]);
    expect(parsed.dayOfWeek.values).toEqual([1, 2, 3, 4, 5]);
    expect(parsed.dayOfMonth.isWildcard).toBe(true);
    expect(parsed.dayOfWeek.isWildcard).toBe(false);
  });

  it('accepts stepped range expressions', () => {
    const parsed = parseFiveFieldCron('0 9-17/2 * * 1-5');
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    expect(parsed.hour.values).toEqual([9, 11, 13, 15, 17]);
    expect(parsed.hour.isWildcard).toBe(false);
  });

  it('accepts comma-separated day-of-month lists', () => {
    const parsed = parseFiveFieldCron('30 18 1,15 * *');
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    expect(parsed.minute.values).toEqual([30]);
    expect(parsed.hour.values).toEqual([18]);
    expect(parsed.dayOfMonth.values).toEqual([1, 15]);
    expect(parsed.dayOfMonth.isWildcard).toBe(false);
  });

  it('normalizes Sunday=7 to Sunday=0', () => {
    const parsed = parseFiveFieldCron('0 0 * * 7');
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    expect(parsed.dayOfWeek.values).toEqual([0]);
  });

  it('rejects too few fields', () => {
    const result = parseFiveFieldCron('* * * *');
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toMatch(/must have exactly 5 fields/);
  });

  it('rejects too many fields', () => {
    const result = parseFiveFieldCron('* * * * * *');
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toMatch(/must have exactly 5 fields/);
  });

  it('rejects named tokens like @daily', () => {
    const result = parseFiveFieldCron('@daily');
    expect('error' in result).toBe(true);
  });

  it('rejects out-of-range minute values', () => {
    const result = parseFiveFieldCron('60 * * * *');
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toMatch(/minute/);
  });

  it('rejects out-of-range day-of-month values', () => {
    const result = parseFiveFieldCron('0 0 32 * *');
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toMatch(/day-of-month/);
  });

  it('rejects out-of-range month values', () => {
    const result = parseFiveFieldCron('0 0 * 13 *');
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toMatch(/month/);
  });

  it('rejects ranges with start greater than end', () => {
    const result = parseFiveFieldCron('0 0 * * 6-2');
    expect('error' in result).toBe(true);
  });

  it('rejects non-numeric step values', () => {
    const result = parseFiveFieldCron('*/x * * * *');
    expect('error' in result).toBe(true);
  });

  it('rejects single-value step syntax', () => {
    const result = parseFiveFieldCron('5/2 * * * *');
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toMatch(/step syntax/);
  });

  it('rejects empty expressions', () => {
    const result = parseFiveFieldCron('   ');
    expect('error' in result).toBe(true);
  });
});

describe('getNextCronRun', () => {
  it('returns a future minute matching the expression', () => {
    // 2026-01-05 is a Monday — *no* match before because dayOfWeek 1-5
    // restricts to weekdays.
    const after = new Date(2026, 0, 5, 8, 30, 0); // Mon 08:30 local
    const next = getNextCronRun('0 9 * * 1-5', after);
    expect(next).not.toBeNull();
    if (!next) return;
    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(0);
    expect(next.getDate()).toBe(5);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
  });

  it('rolls forward when the candidate is past the current matching window', () => {
    const after = new Date(2026, 0, 5, 9, 30, 0); // Mon 09:30 local
    const next = getNextCronRun('0 9 * * 1-5', after);
    expect(next).not.toBeNull();
    if (!next) return;
    // Next match should be Tuesday 09:00 local
    expect(next.getDate()).toBe(6);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
  });

  it('matches when day-of-month OR day-of-week is satisfied', () => {
    // 2026-04-15 is a Wednesday; expression `0 9 15 * 5` requires DOM=15 OR
    // DOW=5 (Friday). At Mon 2026-04-13 08:00 the next valid match should be
    // Wed 2026-04-15 09:00 (matches via DOM rather than DOW).
    const after = new Date(2026, 3, 13, 8, 0, 0); // Mon 2026-04-13 08:00
    const next = getNextCronRun('0 9 15 * 5', after);
    expect(next).not.toBeNull();
    if (!next) return;
    expect(next.getDate()).toBe(15);
    expect(next.getMonth()).toBe(3);
    expect(next.getHours()).toBe(9);
  });

  it('falls back to day-of-week when day-of-month does not match', () => {
    // From Wed 2026-04-15 10:00 the next match should be Fri 2026-04-17 09:00.
    const after = new Date(2026, 3, 15, 10, 0, 0); // Wed 10:00
    const next = getNextCronRun('0 9 15 * 5', after);
    expect(next).not.toBeNull();
    if (!next) return;
    expect(next.getDate()).toBe(17);
    expect(next.getDay()).toBe(5);
  });

  it('returns null for invalid expressions', () => {
    expect(getNextCronRun('* * *', new Date())).toBeNull();
  });
});

describe('getNextAutomationTriggerRun', () => {
  it('forwards scheduled cron triggers to getNextCronRun', () => {
    const after = new Date(2026, 0, 5, 8, 0, 0);
    const trigger: AutomationTrigger = {
      kind: 'cron',
      expression: '0 9 * * 1-5',
      timezone: 'local',
    };
    const next = getNextAutomationTriggerRun(trigger, after);
    expect(next).not.toBeNull();
  });

  it('returns the runAt for a future one-time trigger', () => {
    const after = new Date('2026-05-27T10:00:00Z');
    const trigger: AutomationTrigger = {
      kind: 'one_time',
      runAt: '2026-05-27T11:00:00Z',
      timezone: 'local',
    };
    const next = getNextAutomationTriggerRun(trigger, after);
    expect(next?.toISOString()).toBe('2026-05-27T11:00:00.000Z');
  });

  it('returns null for a past one-time trigger', () => {
    const after = new Date('2026-05-27T10:00:00Z');
    const trigger: AutomationTrigger = {
      kind: 'one_time',
      runAt: '2026-05-27T09:00:00Z',
      timezone: 'local',
    };
    expect(getNextAutomationTriggerRun(trigger, after)).toBeNull();
  });

  it('returns null for malformed one-time runAt strings', () => {
    const trigger: AutomationTrigger = {
      kind: 'one_time',
      runAt: 'not-a-date',
      timezone: 'local',
    };
    expect(getNextAutomationTriggerRun(trigger, new Date())).toBeNull();
  });
});

describe('getAutomationTriggerLabel', () => {
  it('maps supported trigger variants to user-facing labels', () => {
    expect(
      getAutomationTriggerLabel({
        kind: 'cron',
        expression: '0 9 * * *',
        timezone: 'local',
      }),
    ).toBe('Scheduled');
    expect(
      getAutomationTriggerLabel({
        kind: 'one_time',
        runAt: '2026-06-01T12:00:00Z',
        timezone: 'local',
      }),
    ).toBe('One-time');
  });
});

describe('enumerateAutomationTriggerOccurrences', () => {
  it('enumerates daily cron occurrences over a seven-day window', () => {
    const result = enumerateAutomationTriggerOccurrences(
      { kind: 'cron', expression: '30 9 * * *', timezone: 'local' },
      new Date(2026, 0, 1, 0, 0, 0),
      new Date(2026, 0, 8, 0, 0, 0),
      20,
    );

    expect(result.truncated).toBe(false);
    expect(result.occurrences).toHaveLength(7);
    expect(
      result.occurrences.map((occurrence) => [
        occurrence.getFullYear(),
        occurrence.getMonth(),
        occurrence.getDate(),
        occurrence.getHours(),
        occurrence.getMinutes(),
      ]),
    ).toEqual([
      [2026, 0, 1, 9, 30],
      [2026, 0, 2, 9, 30],
      [2026, 0, 3, 9, 30],
      [2026, 0, 4, 9, 30],
      [2026, 0, 5, 9, 30],
      [2026, 0, 6, 9, 30],
      [2026, 0, 7, 9, 30],
    ]);
  });

  it('enumerates one-time triggers only when inside the window', () => {
    const trigger: AutomationTrigger = {
      kind: 'one_time',
      runAt: '2026-05-27T11:00:00.000Z',
      timezone: 'local',
    };

    expect(
      enumerateAutomationTriggerOccurrences(
        trigger,
        new Date('2026-05-27T10:00:00.000Z'),
        new Date('2026-05-27T12:00:00.000Z'),
        10,
      ).occurrences.map((occurrence) => occurrence.toISOString()),
    ).toEqual(['2026-05-27T11:00:00.000Z']);

    expect(
      enumerateAutomationTriggerOccurrences(
        trigger,
        new Date('2026-05-27T12:00:00.000Z'),
        new Date('2026-05-27T13:00:00.000Z'),
        10,
      ).occurrences,
    ).toEqual([]);
  });

  it('marks every-minute cron enumeration truncated when it hits the cap', () => {
    const result = enumerateAutomationTriggerOccurrences(
      { kind: 'cron', expression: '* * * * *', timezone: 'local' },
      new Date(2026, 0, 1, 0, 0, 0),
      new Date(2026, 0, 1, 1, 0, 0),
      5,
    );

    expect(result.occurrences).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });

  it('includes rangeStart and excludes rangeEnd', () => {
    const result = enumerateAutomationTriggerOccurrences(
      { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
      new Date(2026, 0, 1, 9, 0, 0),
      new Date(2026, 0, 2, 9, 0, 0),
      10,
    );

    expect(
      result.occurrences.map((occurrence) => [
        occurrence.getFullYear(),
        occurrence.getMonth(),
        occurrence.getDate(),
        occurrence.getHours(),
        occurrence.getMinutes(),
      ]),
    ).toEqual([[2026, 0, 1, 9, 0]]);
  });

  it('enumerates once per day across a spring-forward boundary', () => {
    const result = enumerateAutomationTriggerOccurrences(
      { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
      new Date(2026, 2, 7, 0, 0, 0),
      new Date(2026, 2, 11, 0, 0, 0),
      10,
    );

    expect(result.truncated).toBe(false);
    expect(
      result.occurrences.map((occurrence) => [
        occurrence.getFullYear(),
        occurrence.getMonth(),
        occurrence.getDate(),
        occurrence.getHours(),
        occurrence.getMinutes(),
      ]),
    ).toEqual([
      [2026, 2, 7, 9, 0],
      [2026, 2, 8, 9, 0],
      [2026, 2, 9, 9, 0],
      [2026, 2, 10, 9, 0],
    ]);
  });
});

describe('enumerateAutomationOccurrences', () => {
  it('excludes disabled activities by default and includes them when requested', () => {
    const enabled = createActivity('enabled', {
      kind: 'cron',
      expression: '0 9 * * *',
      timezone: 'local',
    });
    const disabled = createActivity(
      'disabled',
      { kind: 'cron', expression: '30 9 * * *', timezone: 'local' },
      false,
    );
    const options = {
      rangeStart: new Date(2026, 0, 1, 0, 0, 0),
      rangeEnd: new Date(2026, 0, 2, 0, 0, 0),
    };

    expect(
      enumerateAutomationOccurrences(
        [disabled, enabled],
        options,
      ).occurrences.map((occurrence) => occurrence.key),
    ).toEqual([`enabled:${new Date(2026, 0, 1, 9, 0, 0).getTime()}`]);

    expect(
      enumerateAutomationOccurrences([disabled, enabled], {
        ...options,
        includeDisabled: true,
      }).occurrences.map((occurrence) => occurrence.key),
    ).toEqual([
      `enabled:${new Date(2026, 0, 1, 9, 0, 0).getTime()}`,
      `disabled:${new Date(2026, 0, 1, 9, 30, 0).getTime()}`,
    ]);
  });

  it('sorts occurrences across activities and reports aggregate truncation', () => {
    const slow = createActivity('slow', {
      kind: 'cron',
      expression: '30 9 * * *',
      timezone: 'local',
    });
    const frequent = createActivity('frequent', {
      kind: 'cron',
      expression: '* * * * *',
      timezone: 'local',
    });

    const result = enumerateAutomationOccurrences([slow, frequent], {
      rangeStart: new Date(2026, 0, 1, 9, 0, 0),
      rangeEnd: new Date(2026, 0, 1, 10, 0, 0),
      maxOccurrencesPerActivity: 2,
    });

    expect(result.truncated).toBe(true);
    expect(result.occurrences.map((occurrence) => occurrence.key)).toEqual([
      `frequent:${new Date(2026, 0, 1, 9, 0, 0).getTime()}`,
      `frequent:${new Date(2026, 0, 1, 9, 1, 0).getTime()}`,
      `slow:${new Date(2026, 0, 1, 9, 30, 0).getTime()}`,
    ]);
  });
});

describe('validateAutomationTrigger', () => {
  it('rejects non-object trigger input', () => {
    expect(validateAutomationTrigger(null)).toBe('Trigger must be an object.');
    expect(validateAutomationTrigger('x')).toBe('Trigger must be an object.');
  });

  it('accepts a valid scheduled cron trigger', () => {
    expect(
      validateAutomationTrigger({
        kind: 'cron',
        expression: '*/30 * * * *',
        timezone: 'local',
      }),
    ).toBeNull();
  });

  it('accepts a valid one-time trigger', () => {
    expect(
      validateAutomationTrigger({
        kind: 'one_time',
        runAt: '2026-06-01T12:00:00Z',
        timezone: 'local',
      }),
    ).toBeNull();
  });

  it('rejects scheduled triggers whose expression is invalid', () => {
    const error = validateAutomationTrigger({
      kind: 'cron',
      expression: '60 * * * *',
      timezone: 'local',
    });
    expect(error).toMatch(/minute/);
  });

  it('rejects scheduled triggers with no future occurrence', () => {
    const error = validateAutomationTrigger({
      kind: 'cron',
      expression: '0 0 31 2 *',
      timezone: 'local',
    });
    expect(error).toBe('Scheduled trigger has no future runs.');
  });

  it('rejects non-local timezones', () => {
    const error = validateAutomationTrigger({
      kind: 'cron',
      expression: '0 9 * * *',
      timezone: 'utc',
    });
    expect(error).toMatch(/local/);
  });

  it('rejects missing trigger kinds', () => {
    const error = validateAutomationTrigger({
      timezone: 'local',
    });
    expect(error).toBe('Unknown trigger kind: undefined');
  });

  it('rejects one-time triggers with missing runAt', () => {
    const error = validateAutomationTrigger({
      kind: 'one_time',
      runAt: '',
      timezone: 'local',
    });
    expect(error).toMatch(/runAt/);
  });
});

describe('validateAutomationAction', () => {
  it('rejects a configured file reference that escapes its logical root', () => {
    expect(
      validateAutomationAction({
        type: 'worktree_prompt',
        workspaceId: 'project',
        prompt: 'Read ../secret.txt',
        promptReferences: [
          {
            kind: 'file',
            textStart: 5,
            displayText: '../secret.txt',
            root: { kind: 'workspace' },
            relativePath: '../secret.txt',
          },
        ],
      }),
    ).toMatch(/promptReferences|relativePath/);
  });

  it('accepts a valid app_advisor_prompt action', () => {
    const action: AutomationAction = {
      type: 'app_advisor_prompt',
      prompt: 'Daily standup',
      model: 'gpt-6-sol',
      modelConfig: { thinkingLevel: 'high', fastMode: true },
      approvalMode: 'ask',
      plugins: [
        {
          type: 'skill',
          source: { type: 'builtin', id: 'canopy' },
          skill_name: 'canopy-feedback-triage',
        },
      ],
    };
    expect(validateAutomationAction(action)).toBeNull();
  });

  it('accepts full chat plugin selections including custom skills and MCP servers', () => {
    const action: AutomationAction = {
      type: 'app_advisor_prompt',
      prompt: 'Daily standup',
      pluginSelections: {
        collectionIds: ['collection-1'],
        skillRefs: [{ sourceId: 'custom:local', skillName: 'team-standup' }],
        pluginRefs: [
          { marketplaceId: 'local-marketplace', pluginName: 'private-tools' },
        ],
        mcpServerRefs: [{ serverId: 'linear', configId: 'work' }],
      },
    };
    expect(validateAutomationAction(action)).toBeNull();

    expect(
      validateAutomationAction({
        type: 'app_advisor_prompt',
        prompt: 'Daily standup',
        pluginSelections: {
          collectionIds: [],
          skillRefs: [{ sourceId: 'custom:local' }],
          pluginRefs: [],
          mcpServerRefs: [],
        },
      }),
    ).toMatch(/pluginSelections/);
  });

  it('requires a non-empty prompt for app_advisor_prompt', () => {
    const action: AutomationAction = { type: 'app_advisor_prompt', prompt: '' };
    expect(validateAutomationAction(action)).toMatch(/prompt/);
  });

  it('rejects an invalid App Advisor approval mode', () => {
    expect(
      validateAutomationAction({
        type: 'app_advisor_prompt',
        prompt: 'Daily standup',
        approvalMode: 'invalid',
      }),
    ).toMatch(/approvalMode/);
  });

  it('requires chatProjectId and prompt for standalone_prompt', () => {
    expect(
      validateAutomationAction({
        type: 'standalone_prompt',
        chatProjectId: '',
        prompt: 'hi',
      }),
    ).toMatch(/chatProjectId/);
    expect(
      validateAutomationAction({
        type: 'standalone_prompt',
        chatProjectId: 'project-1',
        prompt: '   ',
      }),
    ).toMatch(/prompt/);
  });

  it('accepts standalone_prompt chat settings', () => {
    expect(
      validateAutomationAction({
        type: 'standalone_prompt',
        chatProjectId: 'project-1',
        prompt: 'Roundup',
        model: 'gpt-6-sol',
        modelConfig: { thinkingLevel: 'xhigh', fastMode: false },
        plugins: [
          {
            type: 'skill',
            source: { type: 'builtin', id: 'canopy' },
            skill_name: 'canopy-feedback-triage',
          },
        ],
        approvalMode: 'auto',
      }),
    ).toBeNull();
  });

  it('rejects an invalid standalone_prompt approvalMode', () => {
    expect(
      validateAutomationAction({
        type: 'standalone_prompt',
        chatProjectId: 'project-1',
        prompt: 'Roundup',
        approvalMode: 'yolo',
      }),
    ).toMatch(/approvalMode/);
  });

  it('requires workspaceId and prompt for worktree_prompt', () => {
    expect(
      validateAutomationAction({
        type: 'worktree_prompt',
        workspaceId: '',
        prompt: 'hi',
      }),
    ).toMatch(/workspaceId/);
    expect(
      validateAutomationAction({
        type: 'worktree_prompt',
        workspaceId: 'ws',
        prompt: '',
      }),
    ).toMatch(/prompt/);
  });

  it('accepts worktree_prompt chat settings', () => {
    expect(
      validateAutomationAction({
        type: 'worktree_prompt',
        workspaceId: 'ws',
        prompt: 'Plan the release',
        model: 'claude-sonnet-4-6',
        modelConfig: { thinkingLevel: 'xhigh', fastMode: true },
        plugins: [
          {
            type: 'skill',
            source: { type: 'builtin', id: 'canopy' },
            skill_name: 'canopy-feedback-triage',
          },
        ],
        planMode: true,
        interfaceMode: 'claude-code',
        approvalMode: 'full-access',
      }),
    ).toBeNull();
  });

  it('rejects malformed worktree_prompt chat settings', () => {
    expect(
      validateAutomationAction({
        type: 'worktree_prompt',
        workspaceId: 'ws',
        prompt: 'Plan the release',
        modelConfig: { thinkingLevel: 'warp' },
      }),
    ).toMatch(/thinkingLevel/);
    expect(
      validateAutomationAction({
        type: 'worktree_prompt',
        workspaceId: 'ws',
        prompt: 'Plan the release',
        plugins: [{ type: 'local-plugin', id: 'private' }],
      }),
    ).toMatch(/shareable plugin refs/);
    expect(
      validateAutomationAction({
        type: 'worktree_prompt',
        workspaceId: 'ws',
        prompt: 'Plan the release',
        planMode: 'yes',
      }),
    ).toMatch(/planMode/);
    expect(
      validateAutomationAction({
        type: 'worktree_prompt',
        workspaceId: 'ws',
        prompt: 'Plan the release',
        interfaceMode: 'terminal',
      }),
    ).toMatch(/interfaceMode/);
    expect(
      validateAutomationAction({
        type: 'worktree_prompt',
        workspaceId: 'ws',
        prompt: 'Plan the release',
        approvalMode: 'yolo',
      }),
    ).toMatch(/approvalMode/);
  });

  it('accepts worktree_prompt with an existingBranch', () => {
    expect(
      validateAutomationAction({
        type: 'worktree_prompt',
        workspaceId: 'ws',
        prompt: 'Plan the release',
        existingBranch: 'feature/foo',
        purpose: 'scheduled_task',
        workspaceName: 'Canopy',
      }),
    ).toBeNull();
  });

  it('rejects an empty-string existingBranch for worktree_prompt', () => {
    expect(
      validateAutomationAction({
        type: 'worktree_prompt',
        workspaceId: 'ws',
        prompt: 'Plan the release',
        existingBranch: '',
      }),
    ).toMatch(/existingBranch/);
  });

  it('rejects worktree_prompt existingBranch combined with baseWorktreeId', () => {
    expect(
      validateAutomationAction({
        type: 'worktree_prompt',
        workspaceId: 'ws',
        prompt: 'Plan the release',
        existingBranch: 'feature/foo',
        baseWorktreeId: 'wt-1',
      }),
    ).toMatch(/existingBranch.*baseWorktreeId|baseWorktreeId.*existingBranch/);
  });

  it('accepts worktree_prompt with an existingWorktreeId', () => {
    expect(
      validateAutomationAction({
        type: 'worktree_prompt',
        workspaceId: 'ws',
        prompt: 'Implement leg 2 in place',
        existingWorktreeId: 'wt-1',
      }),
    ).toBeNull();
  });

  it('rejects an empty-string existingWorktreeId for worktree_prompt', () => {
    expect(
      validateAutomationAction({
        type: 'worktree_prompt',
        workspaceId: 'ws',
        prompt: 'Implement leg 2 in place',
        existingWorktreeId: '',
      }),
    ).toMatch(/existingWorktreeId/);
  });

  it('rejects worktree_prompt existingWorktreeId combined with baseWorktreeId', () => {
    expect(
      validateAutomationAction({
        type: 'worktree_prompt',
        workspaceId: 'ws',
        prompt: 'Implement leg 2 in place',
        existingWorktreeId: 'wt-1',
        baseWorktreeId: 'wt-2',
      }),
    ).toMatch(
      /existingWorktreeId.*baseWorktreeId|baseWorktreeId.*existingWorktreeId/,
    );
  });

  it('rejects worktree_prompt existingWorktreeId combined with existingBranch', () => {
    expect(
      validateAutomationAction({
        type: 'worktree_prompt',
        workspaceId: 'ws',
        prompt: 'Implement leg 2 in place',
        existingWorktreeId: 'wt-1',
        existingBranch: 'feature/foo',
      }),
    ).toMatch(
      /existingWorktreeId.*existingBranch|existingBranch.*existingWorktreeId/,
    );
  });

  it('accepts a baseBranch and rejects combining it with another base source', () => {
    expect(
      validateAutomationAction({
        type: 'worktree_prompt',
        workspaceId: 'ws',
        prompt: 'Plan the release',
        baseBranch: 'release',
      }),
    ).toBeNull();

    expect(
      validateAutomationAction({
        type: 'worktree_prompt',
        workspaceId: 'ws',
        prompt: 'Plan the release',
        baseBranch: 'release',
        baseWorktreeId: 'wt-1',
      }),
    ).toMatch(/baseWorktreeId.*baseBranch|baseBranch.*baseWorktreeId/);
  });

  it('rejects worktree_prompt existingWorktreeId combined with baseBranch', () => {
    expect(
      validateAutomationAction({
        type: 'worktree_prompt',
        workspaceId: 'ws',
        prompt: 'Implement leg 2 in place',
        existingWorktreeId: 'wt-1',
        baseBranch: 'release',
      }),
    ).toMatch(/existingWorktreeId.*baseBranch|baseBranch.*existingWorktreeId/);
  });

  it('rejects an invalid worktree_prompt purpose value', () => {
    expect(
      validateAutomationAction({
        type: 'worktree_prompt',
        workspaceId: 'ws',
        prompt: 'Plan the release',
        purpose: 'not_a_real_purpose',
      }),
    ).toMatch(/purpose/);
  });

  it('rejects a non-string worktree_prompt workspaceName', () => {
    expect(
      validateAutomationAction({
        type: 'worktree_prompt',
        workspaceId: 'ws',
        prompt: 'Plan the release',
        workspaceName: 42,
      }),
    ).toMatch(/workspaceName/);
  });

  it('accepts a full worktree_session_prompt action', () => {
    const action: AutomationAction = {
      type: 'worktree_session_prompt',
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      prompt: 'Continue',
      fileReferences: [
        {
          displayPath: 'src/index.ts',
          absolutePath: '/repo/src/index.ts',
          repoName: 'canopy',
        },
      ],
      attachmentPaths: ['/tmp/note.md'],
      attachmentPromptContexts: [
        {
          attachmentPath: '/tmp/note.md',
          promptKind: 'in-app-browser-resource',
        },
      ],
      inputMode: 'typed',
      purpose: 'usage_limit_resume',
      workspaceName: 'Canopy',
      worktreeName: 'egret',
      chatTitle: 'Release planning',
    };
    expect(validateAutomationAction(action)).toBeNull();
  });

  it('accepts a worktree_session_prompt action with a linear-ticket attachment context', () => {
    const action: AutomationAction = {
      type: 'worktree_session_prompt',
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      prompt: 'Implement this ticket',
      attachmentPaths: ['/tmp/linear-can-202.md'],
      attachmentPromptContexts: [
        {
          attachmentPath: '/tmp/linear-can-202.md',
          promptKind: 'linear-ticket',
        },
      ],
    };
    expect(validateAutomationAction(action)).toBeNull();
  });

  it('accepts a minimal worktree_session_prompt action', () => {
    expect(
      validateAutomationAction({
        type: 'worktree_session_prompt',
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        prompt: 'Continue',
      }),
    ).toBeNull();
  });

  it('requires ids and prompt for worktree_session_prompt', () => {
    expect(
      validateAutomationAction({
        type: 'worktree_session_prompt',
        workspaceId: '',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        prompt: 'Continue',
      }),
    ).toMatch(/workspaceId/);
    expect(
      validateAutomationAction({
        type: 'worktree_session_prompt',
        workspaceId: 'ws-1',
        worktreeId: '',
        chatId: 'chat-1',
        prompt: 'Continue',
      }),
    ).toMatch(/worktreeId/);
    expect(
      validateAutomationAction({
        type: 'worktree_session_prompt',
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        chatId: '',
        prompt: 'Continue',
      }),
    ).toMatch(/chatId/);
    expect(
      validateAutomationAction({
        type: 'worktree_session_prompt',
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        prompt: '   ',
      }),
    ).toMatch(/prompt/);
  });

  it('rejects malformed worktree_session_prompt optional fields', () => {
    expect(
      validateAutomationAction({
        type: 'worktree_session_prompt',
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        prompt: 'Continue',
        inputMode: 'keyboard',
      }),
    ).toMatch(/inputMode/);
    expect(
      validateAutomationAction({
        type: 'worktree_session_prompt',
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        prompt: 'Continue',
        attachmentPaths: ['/tmp/a.md', 5],
      }),
    ).toMatch(/attachmentPaths/);
    expect(
      validateAutomationAction({
        type: 'worktree_session_prompt',
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        prompt: 'Continue',
        fileReferences: [{ displayPath: 'x' }],
      }),
    ).toMatch(/fileReferences/);
    expect(
      validateAutomationAction({
        type: 'worktree_session_prompt',
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        prompt: 'Continue',
        attachmentPromptContexts: [{ attachmentPath: '/tmp/a.md' }],
      }),
    ).toMatch(/attachmentPromptContexts/);
    expect(
      validateAutomationAction({
        type: 'worktree_session_prompt',
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        prompt: 'Continue',
        purpose: 'manual',
      }),
    ).toMatch(/purpose/);
  });

  it('requires workspaceId and pipelineId for worktree_pipeline', () => {
    expect(
      validateAutomationAction({
        type: 'worktree_pipeline',
        workspaceId: '',
        pipelineId: 'pipeline-1',
      }),
    ).toMatch(/workspaceId/);
    expect(
      validateAutomationAction({
        type: 'worktree_pipeline',
        workspaceId: 'ws',
        pipelineId: '',
      }),
    ).toMatch(/pipelineId/);
  });

  it('validates pipeline destinations and keeps legacy messages for an absent target', () => {
    const base = { type: 'worktree_pipeline', pipelineId: 'p-1' };
    expect(validateAutomationAction({ ...base, workspaceId: 'ws' })).toBeNull();
    expect(validateAutomationAction({ ...base })).toBe(
      'Worktree pipeline action requires a workspaceId.',
    );
    expect(
      validateAutomationAction({ ...base, target: { kind: 'global' } }),
    ).toBeNull();
    expect(
      validateAutomationAction({
        ...base,
        workspaceId: 'ws',
        target: { kind: 'task', taskId: 'wt-1' },
      }),
    ).toBeNull();
    expect(
      validateAutomationAction({
        ...base,
        workspaceId: 'ws',
        target: { kind: 'elsewhere' },
      }),
    ).toBe(
      'Pipeline automation target.kind must be global, new_worktree, task, or project.',
    );
    expect(
      validateAutomationAction({
        ...base,
        target: { kind: 'global' },
        pipelineSource: 'project',
      }),
    ).toBe(
      'Project workflows need a project. Choose another workflow or a project destination.',
    );
    // A target on another action type is not part of its validation.
    expect(
      validateAutomationAction({
        type: 'worktree_prompt',
        workspaceId: 'ws',
        prompt: 'Hi',
        target: { kind: 'global' },
      }),
    ).toBeNull();
  });

  it('accepts all three Codex speeds on prompt actions and rejects invalid or contradictory ones', () => {
    for (const speed of ['standard', 'fast', 'ultrafast'] as const) {
      expect(
        validateAutomationAction({
          type: 'worktree_prompt',
          workspaceId: 'ws',
          prompt: 'Plan the release',
          model: 'gpt-6-sol',
          modelConfig: { speed, fastMode: speed === 'fast' },
        }),
      ).toBeNull();
    }
    expect(
      validateAutomationAction({
        type: 'app_advisor_prompt',
        prompt: 'Daily standup',
        modelConfig: { speed: 'turbo' },
      }),
    ).toMatch(/speed/);
    expect(
      validateAutomationAction({
        type: 'app_advisor_prompt',
        prompt: 'Daily standup',
        modelConfig: { speed: 'ultrafast', fastMode: true },
      }),
    ).toMatch(/fastMode/);
  });

  it('keeps worktree_pipeline speed boolean and explicitly rejects Ultra fast on writes', () => {
    const ultraPipeline: AutomationAction = {
      type: 'worktree_pipeline',
      workspaceId: 'ws',
      pipelineId: 'pipeline-1',
      modelConfig: { speed: 'ultrafast' },
    };
    expect(
      validateAutomationActionForWrite({
        type: 'worktree_pipeline',
        workspaceId: 'ws',
        pipelineId: 'pipeline-1',
        modelConfig: { speed: 'fast', fastMode: true },
      }),
    ).toBeNull();
    expect(validateAutomationActionForWrite(ultraPipeline)).toMatch(
      /Ultra fast/,
    );
    expect(
      validateAutomationCreateRequest({
        name: 'Nightly',
        schedule: {
          kind: 'one_time',
          runAt: '2027-01-01T09:00:00.000Z',
          timezone: 'local',
        },
        action: ultraPipeline,
      }),
    ).toMatch(/Ultra fast/);
    // Persisted reads stay valid so a stored automation is never silently
    // dropped; its run is rejected explicitly instead.
    expect(validateAutomationAction(ultraPipeline)).toBeNull();
    expect(automationPipelineSpeedError({ speed: 'ultrafast' })).toMatch(
      /Ultra fast/,
    );
    expect(automationPipelineSpeedError({ speed: 'ultrafast' })).toBe(
      'Workflow automations do not support Ultra fast. Choose Regular or Fast.',
    );
    expect(automationPipelineSpeedError({ fastMode: true })).toBeNull();
    expect(automationPipelineSpeedError(undefined)).toBeNull();
  });

  it('rejects worktree_pipeline inputs that are not string records', () => {
    const error = validateAutomationAction({
      type: 'worktree_pipeline',
      workspaceId: 'ws',
      pipelineId: 'pipeline-1',
      inputs: { count: 5 },
    });
    expect(error).toMatch(/inputs\[count\] must be a string/);
  });

  it('accepts worktree_pipeline inputs that are string records', () => {
    expect(
      validateAutomationAction({
        type: 'worktree_pipeline',
        workspaceId: 'ws',
        pipelineId: 'pipeline-1',
        inputs: { target: 'test', env: 'staging' },
      }),
    ).toBeNull();
  });

  it('rejects malformed worktree_pipeline modelConfig', () => {
    const error = validateAutomationAction({
      type: 'worktree_pipeline',
      workspaceId: 'ws',
      pipelineId: 'pipeline-1',
      modelConfig: { thinkingLevel: 'maximum' },
    });
    expect(error).toMatch(/modelConfig\.thinkingLevel/);
  });

  it('validates provider-scoped pipeline execution resume actions', () => {
    const validAction: AutomationAction = {
      type: 'pipeline_execution_resume',
      executionId: 'execution-1',
      statusReasonIds: ['123e4567-e89b-42d3-a456-426614174000'],
      provider: 'codex',
      purpose: 'usage_limit_resume',
      pipelineName: 'Release',
    };
    expect(validateAutomationAction(validAction)).toBeNull();
    expect(
      validateAutomationAction({
        ...validAction,
        statusReasonIds: [],
      }),
    ).toMatch(/statusReasonIds/);
    expect(
      validateAutomationAction({
        ...validAction,
        statusReasonIds: [
          '123e4567-e89b-42d3-a456-426614174000',
          '123e4567-e89b-42d3-a456-426614174000',
        ],
      }),
    ).toMatch(/unique/);
    expect(
      validateAutomationAction({
        ...validAction,
        provider: 'ollama',
      }),
    ).toMatch(/claude or codex/);
  });
});

describe('automation prompt sidebar group names', () => {
  const promptActions: AutomationAction[] = [
    { type: 'app_advisor_prompt', prompt: 'Review' },
    {
      type: 'standalone_prompt',
      chatProjectId: 'cowork-one',
      prompt: 'Review',
    },
    {
      type: 'worktree_prompt',
      workspaceId: 'workspace-one',
      prompt: 'Review',
    },
  ];

  it('accepts optional names, trimmed blanks and the Unicode name limit on every prompt variant', () => {
    const limitName = '😀'.repeat(SIDEBAR_ITEM_GROUP_NAME_LIMIT);
    for (const action of promptActions) {
      expect(
        validateAutomationAction({
          ...action,
          sidebarGroupName: `  ${limitName}  `,
        }),
      ).toBeNull();
      expect(
        validateAutomationAction({ ...action, sidebarGroupName: '  \t ' }),
      ).toBeNull();
      expect(
        validateAutomationAction({
          ...action,
          sidebarGroupName: ` ${limitName}😀 `,
        }),
      ).toMatch(/sidebarGroupName/);
      expect(
        validateAutomationAction({ ...action, sidebarGroupName: 42 }),
      ).toMatch(/sidebarGroupName/);
    }
  });

  it('does not accept sidebarGroupName on non-prompt actions', () => {
    expect(
      validateAutomationAction({
        type: 'worktree_pipeline',
        workspaceId: 'workspace-one',
        pipelineId: 'pipeline-one',
        sidebarGroupName: 'Daily',
      }),
    ).toMatch(/sidebarGroupName/);
  });
});

describe('validateAutomationCreateRequest', () => {
  it('accepts a complete request', () => {
    const request: AutomationCreateRequest = {
      name: 'Nightly review',
      schedule: {
        kind: 'cron',
        expression: '0 22 * * *',
        timezone: 'local',
      },
      action: {
        type: 'app_advisor_prompt',
        prompt: 'Review today’s diffs',
      },
    };
    expect(validateAutomationCreateRequest(request)).toBeNull();
  });

  it('rejects requests with a blank name', () => {
    const request: AutomationCreateRequest = {
      name: '   ',
      schedule: {
        kind: 'cron',
        expression: '0 22 * * *',
        timezone: 'local',
      },
      action: { type: 'app_advisor_prompt', prompt: 'go' },
    };
    expect(validateAutomationCreateRequest(request)).toMatch(/name/);
  });

  it('propagates schedule and action errors', () => {
    expect(
      validateAutomationCreateRequest({
        name: 'Bad cron',
        schedule: {
          kind: 'cron',
          expression: 'not-a-cron-expression',
          timezone: 'local',
        },
        action: { type: 'app_advisor_prompt', prompt: 'go' },
      }),
    ).not.toBeNull();
    expect(
      validateAutomationCreateRequest({
        name: 'Bad action',
        schedule: {
          kind: 'cron',
          expression: '0 0 * * *',
          timezone: 'local',
        },
        action: {
          type: 'standalone_prompt',
          chatProjectId: '',
          prompt: 'go',
        },
      }),
    ).toMatch(/chatProjectId/);
  });

  it.each([null, 42, {}])(
    'rejects a non-string executionContext (%p)',
    (executionContext) => {
      expect(
        validateAutomationCreateRequest({
          name: 'Nightly',
          schedule: {
            kind: 'cron',
            expression: '0 0 * * *',
            timezone: 'local',
          },
          action: { type: 'app_advisor_prompt', prompt: 'go' },
          executionContext,
        }),
      ).toMatch(/executionContext/);
    },
  );

  it('accepts a string executionContext for the service to check', () => {
    expect(
      validateAutomationCreateRequest({
        name: 'Nightly',
        schedule: { kind: 'cron', expression: '0 0 * * *', timezone: 'local' },
        action: { type: 'app_advisor_prompt', prompt: 'go' },
        executionContext: 'personal',
      }),
    ).toBeNull();
  });
});

describe('validateAutomationAction workEntryId', () => {
  it.each<AutomationAction['type']>([
    'app_advisor_prompt',
    'standalone_prompt',
  ])('accepts a Work Entry target on %s', (type) => {
    expect(
      validateAutomationAction({
        type,
        chatProjectId: 'project-1',
        workEntryId: 'entry-1',
        prompt: 'go',
      }),
    ).toBeNull();
  });

  it.each<AutomationAction['type']>([
    'app_advisor_prompt',
    'standalone_prompt',
  ])('rejects an empty Work Entry target on %s', (type) => {
    expect(
      validateAutomationAction({
        type,
        chatProjectId: 'project-1',
        workEntryId: '',
        prompt: 'go',
      }),
    ).toMatch(/workEntryId/);
  });
});

describe('getAutomationChatRunMode', () => {
  it('derives new-chat mode for App Advisor, standalone and worktree prompts', () => {
    expect(
      getAutomationChatRunMode({
        type: 'app_advisor_prompt',
        prompt: 'Summarize standup',
      }),
    ).toBe('new_chat');
    expect(
      getAutomationChatRunMode({
        type: 'standalone_prompt',
        chatProjectId: 'project-1',
        prompt: 'Roundup',
      }),
    ).toBe('new_chat');
    expect(
      getAutomationChatRunMode({
        type: 'worktree_prompt',
        workspaceId: 'ws-1',
        prompt: 'Catch up',
      }),
    ).toBe('new_chat');
  });

  it('keeps worktree provisioning sources in new-chat mode', () => {
    expect(
      getAutomationChatRunMode({
        type: 'worktree_prompt',
        workspaceId: 'ws-1',
        baseWorktreeId: 'wt-1',
        prompt: 'Catch up',
      }),
    ).toBe('new_chat');
    expect(
      getAutomationChatRunMode({
        type: 'worktree_prompt',
        workspaceId: 'ws-1',
        existingBranch: 'feature/a',
        prompt: 'Catch up',
      }),
    ).toBe('new_chat');
  });

  it('derives existing-chat mode for a new chat in an existing worktree or Work Entry', () => {
    expect(
      getAutomationChatRunMode({
        type: 'worktree_prompt',
        workspaceId: 'ws-1',
        existingWorktreeId: 'wt-1',
        prompt: 'Catch up',
      }),
    ).toBe('existing_chat');
    expect(
      getAutomationChatRunMode({
        type: 'standalone_prompt',
        chatProjectId: 'project-1',
        workEntryId: 'entry-1',
        prompt: 'Roundup',
      }),
    ).toBe('existing_chat');
    expect(
      getAutomationChatRunMode({
        type: 'app_advisor_prompt',
        workEntryId: 'entry-1',
        prompt: 'Summarize standup',
      }),
    ).toBe('existing_chat');
  });

  it('derives existing-chat mode for worktree session prompts', () => {
    expect(
      getAutomationChatRunMode({
        type: 'worktree_session_prompt',
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        prompt: 'Continue',
      }),
    ).toBe('existing_chat');
  });

  it.each<AutomationAction>([
    {
      type: 'worktree_pipeline',
      workspaceId: 'ws-1',
      pipelineId: 'pipeline-1',
    },
    {
      type: 'pipeline_execution_resume',
      executionId: 'execution-1',
      statusReasonIds: ['123e4567-e89b-42d3-a456-426614174000'],
      provider: 'claude',
      purpose: 'usage_limit_resume',
      pipelineName: 'Release',
    },
  ])('does not derive a run mode for $type', (action) => {
    expect(getAutomationChatRunMode(action)).toBeUndefined();
  });

  it('returns the user-facing label for each mode', () => {
    expect(getAutomationChatRunModeLabel('new_chat')).toBe('New chat each run');
    expect(getAutomationChatRunModeLabel('existing_chat')).toBe(
      'Existing chat',
    );
  });
});

describe('describeAutomationAction', () => {
  it('summarizes each action variant', () => {
    expect(
      describeAutomationAction({
        type: 'app_advisor_prompt',
        prompt: 'Summarize standup',
      }),
    ).toContain('Orchestrator prompt');
    expect(
      describeAutomationAction({
        type: 'standalone_prompt',
        chatProjectId: 'project-1',
        prompt: 'Roundup',
      }),
    ).toContain('Standalone chat');
    expect(
      describeAutomationAction({
        type: 'worktree_prompt',
        workspaceId: 'ws-1',
        prompt: 'Catch up',
      }),
    ).toContain('Worktree chat');
    expect(
      describeAutomationAction({
        type: 'worktree_pipeline',
        workspaceId: 'ws-1',
        pipelineId: 'pipeline-1',
        pipelineName: 'Build',
      }),
    ).toContain('Build');
    expect(
      describeAutomationAction({
        type: 'worktree_pipeline',
        workspaceId: 'ws-1',
        pipelineId: 'pipeline-1',
        pipelineName: 'Build',
      }),
    ).toBe('Run workflow "Build" on project ws-1');
    expect(
      describeAutomationAction({
        type: 'worktree_pipeline',
        target: { kind: 'global' },
        workspaceId: 'ws-1',
        pipelineId: 'pipeline-1',
        pipelineName: 'Build',
      }),
    ).toBe('Run workflow "Build" with no project');
    expect(
      describeAutomationAction(
        {
          type: 'worktree_pipeline',
          target: { kind: 'task', taskId: 'wt-1' },
          workspaceId: 'ws-1',
          pipelineId: 'pipeline-1',
          pipelineName: 'Build',
        },
        {
          workspaceName: () => 'Repo',
          worktreeName: () => 'Fix login',
        },
      ),
    ).toBe('Run workflow "Build" in Fix login on project Repo');
    expect(
      describeAutomationAction({
        type: 'worktree_pipeline',
        target: { kind: 'task', taskId: 'wt-1' },
        workspaceId: 'ws-1',
        pipelineId: 'pipeline-1',
        pipelineName: 'Build',
      }),
    ).toBe('Run workflow "Build" in wt-1 on project ws-1');
    expect(
      describeAutomationAction({
        type: 'worktree_pipeline',
        target: { kind: 'project' },
        workspaceId: 'ws-1',
        pipelineId: 'pipeline-1',
        pipelineName: 'Build',
      }),
    ).toBe('Run workflow "Build" in the ws-1 project folder');
    expect(
      describeAutomationAction({
        type: 'worktree_session_prompt',
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        prompt: 'Continue',
      }),
    ).toBe('Existing chat (ws-1 / wt-1 / chat-1): Continue');
    expect(
      describeAutomationAction({
        type: 'pipeline_execution_resume',
        executionId: 'execution-1',
        statusReasonIds: ['123e4567-e89b-42d3-a456-426614174000'],
        provider: 'claude',
        purpose: 'usage_limit_resume',
        pipelineName: 'Release',
      }),
    ).toBe('Resume workflow "Release" after Claude usage reset');
    expect(
      describeAutomationAction({
        type: 'worktree_pipeline',
        workspaceId: 'ws-1',
        pipelineId: 'release',
        pipelineName: 'Release',
      }),
    ).toBe('Run workflow "Release" on project ws-1');
  });

  it('prefers cached display labels for worktree_session_prompt', () => {
    const description = describeAutomationAction({
      type: 'worktree_session_prompt',
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      prompt: 'Continue',
      workspaceName: 'Canopy',
      worktreeName: 'egret',
      chatTitle: 'Release planning',
    });
    expect(description).toContain('Existing chat');
    expect(description).toContain('Canopy');
    expect(description).toContain('egret');
    expect(description).toContain('Release planning');
  });

  it('falls back to resolver then raw ids for worktree_session_prompt', () => {
    const resolver = {
      workspaceName: (id: string): string | undefined =>
        id === 'ws-1' ? 'Canopy' : undefined,
      worktreeName: (
        workspaceId: string,
        worktreeId: string,
      ): string | undefined =>
        workspaceId === 'ws-1' && worktreeId === 'wt-1' ? 'egret' : undefined,
      chatTitle: (
        workspaceId: string,
        worktreeId: string,
        chatId: string,
      ): string | undefined =>
        workspaceId === 'ws-1' && worktreeId === 'wt-1' && chatId === 'chat-1'
          ? 'Release planning'
          : undefined,
    };

    const resolved = describeAutomationAction(
      {
        type: 'worktree_session_prompt',
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        prompt: 'Continue',
      },
      resolver,
    );
    expect(resolved).toContain('Canopy');
    expect(resolved).toContain('egret');
    expect(resolved).toContain('Release planning');

    const rawIds = describeAutomationAction({
      type: 'worktree_session_prompt',
      workspaceId: 'ws-9',
      worktreeId: 'wt-9',
      chatId: 'chat-9',
      prompt: 'Continue',
    });
    expect(rawIds).toContain('ws-9');
    expect(rawIds).toContain('wt-9');
    expect(rawIds).toContain('chat-9');
  });

  it('uses optional display names for chat and project action labels', () => {
    const resolver = {
      standaloneChatProjectName: (id: string): string | undefined =>
        id === 'project-1' ? 'Default chat' : undefined,
      workspaceName: (id: string): string | undefined =>
        id === 'ws-1' ? 'Canopy' : undefined,
    };

    expect(
      describeAutomationAction(
        {
          type: 'standalone_prompt',
          chatProjectId: 'project-1',
          prompt: 'Roundup',
        },
        resolver,
      ),
    ).toContain('Default chat');
    expect(
      describeAutomationAction(
        {
          type: 'worktree_prompt',
          workspaceId: 'ws-1',
          prompt: 'Catch up',
        },
        resolver,
      ),
    ).toContain('Canopy');
    expect(
      describeAutomationAction(
        {
          type: 'worktree_pipeline',
          workspaceId: 'ws-1',
          pipelineId: 'pipeline-1',
          pipelineName: 'Build',
        },
        resolver,
      ),
    ).toContain('project Canopy');
  });
});

describe('formatCronValidationError', () => {
  it('capitalizes the first letter of an error string', () => {
    expect(formatCronValidationError('minute out of range')).toBe(
      'Minute out of range',
    );
  });

  it('passes empty strings through unchanged', () => {
    expect(formatCronValidationError('')).toBe('');
  });
});

describe('validateAutomationInstalledFrom', () => {
  const valid = {
    remoteId: '4f6b0f5e-2f66-4be4-9f8e-1f0a54a1c111',
    contentHash: 'a'.repeat(64),
    installedAt: '2026-08-20T12:00:00.000Z',
  };

  it('accepts undefined and a well-formed provenance object', () => {
    expect(validateAutomationInstalledFrom(undefined)).toBeNull();
    expect(validateAutomationInstalledFrom(valid)).toBeNull();
    expect(
      validateAutomationInstalledFrom({
        ...valid,
        bundledPipelineContentHash: 'b'.repeat(64),
        staleAt: '2026-08-21T00:00:00.000Z',
        firstEnableReportedAt: '2026-08-21T01:00:00.000Z',
      }),
    ).toBeNull();
  });

  it('accepts an approved run condition and rejects a malformed one', () => {
    expect(
      validateAutomationInstalledFrom({
        ...valid,
        approvedRunCondition: 'test -f ready',
      }),
    ).toBeNull();
    for (const approvedRunCondition of ['', '   ', 7, 'x'.repeat(20_001)]) {
      expect(
        validateAutomationInstalledFrom({ ...valid, approvedRunCondition }),
      ).toContain('approvedRunCondition');
    }
  });

  it('enforces the repo id contract on remoteId', () => {
    for (const remoteId of ['Not Valid', '../etc', 'UPPER', '-leading', '']) {
      expect(validateAutomationInstalledFrom({ ...valid, remoteId })).toContain(
        'remoteId',
      );
    }
  });

  it('enforces the 64-hex contract on contentHash', () => {
    for (const contentHash of ['short', 'g'.repeat(64), 'A'.repeat(64), '']) {
      expect(
        validateAutomationInstalledFrom({ ...valid, contentHash }),
      ).toContain('contentHash');
    }
  });

  it('rejects a malformed bundled pipeline content hash', () => {
    expect(
      validateAutomationInstalledFrom({
        ...valid,
        bundledPipelineContentHash: 'short',
      }),
    ).toContain('bundledPipelineContentHash');
  });

  it('validates context-owned provenance and its materialized pipeline id', () => {
    expect(
      validateAutomationInstalledFrom({
        ...valid,
        remoteId: 'daily-review',
        sourceKind: 'curated',
      }),
    ).toBeNull();
    expect(
      validateAutomationInstalledFrom({ ...valid, sourceKind: 'external' }),
    ).toContain('sourceKind');
    expect(
      validateAutomationInstalledFrom({
        ...valid,
        bundledPipelineLocalId: '../pipeline',
      }),
    ).toContain('bundledPipelineLocalId');
    expect(
      validateAutomationInstalledFrom({
        ...valid,
        sourceKind: 'public',
        bundledPipelineLocalId: 'pipeline_1-A',
      }),
    ).toBeNull();
  });

  it('requires parseable timestamps', () => {
    expect(
      validateAutomationInstalledFrom({ ...valid, installedAt: 'not-a-date' }),
    ).toContain('installedAt');
    expect(
      validateAutomationInstalledFrom({ ...valid, staleAt: 'nope' }),
    ).toContain('staleAt');
  });
});

describe('shared pipeline review persistence', () => {
  const valid = {
    detectedAt: '2026-09-26T12:00:00.000Z',
    remoteId: 'remote-pipeline',
    pipelineName: 'Shared pipeline',
  };

  it('accepts and normalizes the persisted review state', () => {
    expect(validateAutomationSharedPipelineReview(valid)).toBeNull();
    expect(
      normalizeAutomationSharedPipelineReview({
        ...valid,
        pipelineName: '  Shared pipeline  ',
      }),
    ).toEqual(valid);
  });

  it('rejects malformed review state', () => {
    expect(
      validateAutomationSharedPipelineReview({
        ...valid,
        detectedAt: 'not-a-date',
      }),
    ).toContain('detectedAt');
    expect(
      validateAutomationSharedPipelineReview({ ...valid, remoteId: '' }),
    ).toContain('remoteId');
    expect(
      validateAutomationSharedPipelineReview({ ...valid, pipelineName: 42 }),
    ).toContain('pipelineName');
  });
});

describe('automation pipeline dependencies', () => {
  const request: AutomationCreateRequest = {
    name: 'Specialists',
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action: { type: 'app_advisor_prompt', prompt: 'Run the specialists.' },
  };

  it('accepts user and project pipelines on create', () => {
    expect(
      validateAutomationCreateRequest({
        ...request,
        dependencies: {
          pipelines: [
            {
              pipelineId: 'b1b2c3d4-0000-4000-8000-00000000000b',
              source: 'user',
            },
            { pipelineId: 'project:specialists.yaml', source: 'project' },
          ],
        },
      }),
    ).toBeNull();
  });

  it('rejects malformed dependency lists', () => {
    for (const dependencies of [
      null,
      [],
      { pipelines: 'all' },
      { pipelines: [{ pipelineId: '', source: 'user' }] },
      { pipelines: [{ pipelineId: ' padded ', source: 'user' }] },
      { pipelines: [{ pipelineId: 'p-1', source: 'bundled' }] },
      { pipelines: [{ pipelineId: 7, source: 'user' }] },
      {
        pipelines: Array.from(
          { length: MAX_AUTOMATION_PIPELINE_DEPENDENCIES + 1 },
          (_, index) => ({ pipelineId: `p-${index}`, source: 'user' }),
        ),
      },
    ]) {
      expect(
        validateAutomationCreateRequest({ ...request, dependencies }),
      ).toEqual(expect.any(String));
    }
  });

  it('accepts null only where an update clears the list', () => {
    expect(validateAutomationDependencies(undefined)).toBeNull();
    expect(validateAutomationDependencies(null)).toEqual(expect.any(String));
    expect(
      validateAutomationDependencies(null, { allowNull: true }),
    ).toBeNull();
  });

  it('normalizes to known fields, deduplicated by source and id', () => {
    expect(
      normalizeAutomationDependencies({
        pipelines: [
          { pipelineId: 'p-1', source: 'user' },
          { pipelineId: 'p-1', source: 'project' },
          { pipelineId: 'p-1', source: 'user' },
        ],
      }),
    ).toEqual({
      pipelines: [
        { pipelineId: 'p-1', source: 'user' },
        { pipelineId: 'p-1', source: 'project' },
      ],
    });
    expect(normalizeAutomationDependencies({ pipelines: [] })).toBeUndefined();
  });

  it('validates installed dependency provenance', () => {
    const installedFrom = {
      remoteId: '4f6b0f5e-2f66-4be4-9f8e-1f0a54a1c111',
      contentHash: 'a'.repeat(64),
      installedAt: '2026-08-20T12:00:00.000Z',
    };
    const entry = {
      key: '8f14e45f-ceea-467a-9575-0b5b4b2b1c11',
      localPipelineId: 'b1b2c3d4-0000-4000-8000-00000000000b',
      pipelineContentHash: 'b'.repeat(64),
    };
    expect(
      validateAutomationInstalledFrom({
        ...installedFrom,
        pipelineDependencies: [entry],
      }),
    ).toBeNull();
    for (const pipelineDependencies of [
      'all',
      [{ ...entry, key: 'Not A Key' }],
      [{ ...entry, localPipelineId: '../escape' }],
      [{ ...entry, pipelineContentHash: 'short' }],
      [entry, { ...entry, localPipelineId: 'other' }],
    ]) {
      expect(
        validateAutomationInstalledFrom({
          ...installedFrom,
          pipelineDependencies,
        }),
      ).toEqual(expect.any(String));
    }
  });
});
