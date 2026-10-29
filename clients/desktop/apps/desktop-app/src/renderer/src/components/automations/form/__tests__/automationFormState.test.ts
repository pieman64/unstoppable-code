import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import {
  activityToFormState,
  applyWorkspaceActionSelection,
  automationDraftFromSeed,
  automationFormSnapshot,
  buildAction,
  buildAutomationMutationRequest,
  buildTrigger,
  emptyFormState,
  type FormState,
} from '../automationFormState';

function activity(
  overrides: Partial<ScheduledActivity> = {},
): ScheduledActivity {
  return {
    version: 1,
    id: 'activity-1',
    name: 'Morning review',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action: { type: 'app_advisor_prompt', prompt: 'Summarize the plan.' },
    createdAt: '2026-05-27T00:00:00.000Z',
    updatedAt: '2026-05-27T00:00:00.000Z',
    failureCount: 0,
    ...overrides,
  };
}

function validCreateState(overrides: Partial<FormState> = {}): FormState {
  return {
    ...emptyFormState(),
    name: '  Daily digest  ',
    prompt: 'Summarize the plan.',
    ...overrides,
  };
}

describe('buildAutomationMutationRequest', () => {
  it('builds a create request the way the page always saved one', () => {
    const state = validCreateState({ ifCommand: '  test -f ready  ' });
    const result = buildAutomationMutationRequest(state);
    const trigger = buildTrigger(state).trigger;
    const action = buildAction(state).action;
    expect(result).toEqual({
      ok: true,
      mode: 'create',
      request: {
        name: 'Daily digest',
        schedule: trigger,
        action,
        enabled: true,
        ifCommand: 'test -f ready',
      },
    });
  });

  it('names an untitled create and omits an empty If Command', () => {
    const result = buildAutomationMutationRequest(
      validCreateState({ name: ' ' }),
    );
    expect(
      result.ok && result.mode === 'create' && result.request,
    ).toMatchObject({ name: 'Untitled automation' });
    expect(
      result.ok && result.mode === 'create' && 'ifCommand' in result.request,
    ).toBe(false);
  });

  it('carries a set target requirement on create and leaves an unset one out', () => {
    const withRequirement = buildAutomationMutationRequest(
      validCreateState({ targetRequirement: { contexts: ['app_advisor'] } }),
    );
    expect(withRequirement).toMatchObject({
      ok: true,
      mode: 'create',
      request: { targetRequirement: { contexts: ['app_advisor'] } },
    });
    const without = buildAutomationMutationRequest(validCreateState());
    expect(
      without.ok &&
        without.mode === 'create' &&
        'targetRequirement' in without.request,
    ).toBe(false);
  });

  it('builds an update request for an edit', () => {
    const state = {
      ...activityToFormState(activity({ ifCommand: 'true' })),
      name: '  Renamed  ',
    };
    const result = buildAutomationMutationRequest(state);
    expect(result).toEqual({
      ok: true,
      mode: 'update',
      request: {
        id: 'activity-1',
        name: 'Renamed',
        schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
        action: { type: 'app_advisor_prompt', prompt: 'Summarize the plan.' },
        targetRequirement: null,
        enabled: true,
        ifCommand: 'true',
      },
    });
  });

  it('always sends the target requirement for an authored edit, so clearing it saves', () => {
    const kept = buildAutomationMutationRequest(
      activityToFormState(
        activity({ targetRequirement: { contexts: ['worktree'] } }),
      ),
    );
    expect(kept).toMatchObject({
      ok: true,
      mode: 'update',
      request: { targetRequirement: { contexts: ['worktree'] } },
    });
    const cleared = buildAutomationMutationRequest({
      ...activityToFormState(
        activity({ targetRequirement: { contexts: ['worktree'] } }),
      ),
      targetRequirement: undefined,
    });
    expect(cleared).toMatchObject({
      ok: true,
      mode: 'update',
      request: { targetRequirement: null },
    });
  });

  it('leaves the target requirement of an installed automation alone', () => {
    const result = buildAutomationMutationRequest({
      ...activityToFormState(
        activity({ targetRequirement: { contexts: ['worktree'] } }),
      ),
      installed: true,
    });
    expect(
      result.ok &&
        result.mode === 'update' &&
        'targetRequirement' in result.request,
    ).toBe(false);
  });

  it('points a trigger error at the trigger section and its field', () => {
    expect(
      buildAutomationMutationRequest(
        validCreateState({ cronExpression: 'not a cron' }),
      ),
    ).toMatchObject({ ok: false, field: 'cronExpression', section: 'trigger' });
    expect(
      buildAutomationMutationRequest(
        validCreateState({ triggerKind: 'one_time', oneTimeTime: '09:00' }),
      ),
    ).toEqual({
      ok: false,
      error: 'Pick a date and time for the one-time trigger.',
      field: 'oneTimeDate',
      section: 'trigger',
    });
    expect(
      buildAutomationMutationRequest(
        validCreateState({
          triggerKind: 'one_time',
          oneTimeDate: '2099-01-01',
        }),
      ),
    ).toMatchObject({ ok: false, field: 'oneTimeTime', section: 'trigger' });
    expect(
      buildAutomationMutationRequest(
        validCreateState({
          triggerKind: 'one_time',
          oneTimeDate: '2000-01-01',
          oneTimeTime: '09:00',
        }),
      ),
    ).toEqual({
      ok: false,
      error: 'Choose a future time.',
      field: 'oneTimeDate',
      section: 'trigger',
    });
  });

  it('reports the trigger before the action, as the page did', () => {
    expect(
      buildAutomationMutationRequest(
        validCreateState({ cronExpression: '', prompt: '' }),
      ),
    ).toMatchObject({ ok: false, section: 'trigger' });
  });

  it('points an action error at the definition section and its field', () => {
    expect(
      buildAutomationMutationRequest(validCreateState({ prompt: '  ' })),
    ).toEqual({
      ok: false,
      error: 'Enter a prompt for App Advisor.',
      field: 'prompt',
      section: 'definition',
    });
    expect(
      buildAutomationMutationRequest(
        validCreateState({ actionType: 'worktree_prompt' }),
      ),
    ).toEqual({
      ok: false,
      error: 'Pick a project.',
      field: 'workspace',
      section: 'definition',
    });
    expect(
      buildAutomationMutationRequest(
        validCreateState({ actionType: 'worktree_pipeline', workspaceId: 'p' }),
      ),
    ).toEqual({
      ok: false,
      error: 'Pick a pipeline to run.',
      field: 'pipeline',
      section: 'definition',
    });
    expect(
      buildAutomationMutationRequest(
        validCreateState({
          actionType: 'worktree_session_prompt',
          worktreeSessionTarget: {
            workspaceId: 'p',
            worktreeId: 'w',
            chatId: '',
          },
        }),
      ),
    ).toMatchObject({ ok: false, field: 'chatTarget', section: 'definition' });
    expect(
      buildAutomationMutationRequest(
        validCreateState({
          actionType: 'worktree_pipeline',
          workspaceId: 'p',
          pipelineId: 'review',
          pipelineModelAliases: [{ id: 'planner', name: 'Planner' }],
        }),
      ),
    ).toEqual({
      ok: false,
      error: 'Configure the Planner model alias before saving this automation.',
      field: 'pipeline',
      section: 'definition',
    });
  });

  it('refuses a scheduled pipeline resume without naming a field', () => {
    const result = buildAutomationMutationRequest(
      activityToFormState(
        activity({
          action: {
            type: 'pipeline_execution_resume',
            executionId: 'exec-1',
            statusReasonIds: [],
            provider: 'claude',
            purpose: 'usage_limit_resume',
            pipelineName: 'Release',
          },
        }),
      ),
    );
    expect(result).toEqual({
      ok: false,
      error: 'Scheduled pipeline resumes cannot be edited.',
      section: 'definition',
    });
  });
});

describe('automationDraftFromSeed', () => {
  it('is the blank form without a seed', () => {
    expect(automationDraftFromSeed()).toEqual(emptyFormState());
  });

  it('targets a project worktree with a new chat each run', () => {
    expect(
      automationDraftFromSeed({
        projectId: 'workspace-1',
        isCowork: false,
        existingWorktreeId: 'worktree-1',
      }),
    ).toEqual({
      ...applyWorkspaceActionSelection(emptyFormState(), 'chat', {
        id: 'workspace-1',
        isCowork: false,
      }),
      existingWorktreeId: 'worktree-1',
    });
  });

  it('ignores a worktree for a Cowork project', () => {
    const state = automationDraftFromSeed({
      projectId: 'cowork-1',
      isCowork: true,
      existingWorktreeId: 'ignored',
    });
    expect(state).toEqual(
      applyWorkspaceActionSelection(emptyFormState(), 'chat', {
        id: 'cowork-1',
        isCowork: true,
      }),
    );
    expect(state).toMatchObject({
      actionType: 'standalone_prompt',
      chatProjectId: 'cowork-1',
      existingWorktreeId: '',
    });
  });

  it('prefills the name and prompt of a repeated task (CAN-4009)', () => {
    const state = automationDraftFromSeed({
      projectId: 'cowork-1',
      isCowork: true,
      name: 'Summarize support tickets',
      prompt: 'Summarize support tickets\nGroup them by product.',
    });
    expect(state).toMatchObject({
      mode: 'create',
      actionType: 'standalone_prompt',
      chatProjectId: 'cowork-1',
      name: 'Summarize support tickets',
      prompt: 'Summarize support tickets\nGroup them by product.',
      triggerKind: emptyFormState().triggerKind,
      cronExpression: emptyFormState().cronExpression,
    });
  });
});

describe('automationFormSnapshot', () => {
  it('ignores key order and undefined versus absent fields', () => {
    const state = emptyFormState();
    const reordered: FormState = Object.fromEntries(
      Object.entries({ ...state, approvalMode: undefined }).reverse(),
    ) as FormState;
    expect(automationFormSnapshot(reordered)).toBe(
      automationFormSnapshot(state),
    );
  });

  it('matches the chat settings the prompt editor echoes back', () => {
    const state = activityToFormState(
      activity({
        action: {
          type: 'worktree_prompt',
          workspaceId: 'workspace-1',
          prompt: 'Run',
          modelConfig: { thinkingLevel: 'high', fastMode: true },
        },
      }),
    );
    const modelConfig = { thinkingLevel: 'high' as const, fastMode: true };
    const echoed: FormState = {
      ...state,
      chatModelConfig: modelConfig,
      thinkingLevel: modelConfig.thinkingLevel,
      fastMode: modelConfig.fastMode,
      promptReferences: [],
    };
    expect(automationFormSnapshot(echoed)).toBe(automationFormSnapshot(state));
  });

  it('changes with anything a save would write', () => {
    const state = activityToFormState(activity());
    const base = automationFormSnapshot(state);
    expect(automationFormSnapshot({ ...state, name: 'Other' })).not.toBe(base);
    expect(automationFormSnapshot({ ...state, enabled: false })).not.toBe(base);
    expect(automationFormSnapshot({ ...state, ifCommand: 'true' })).not.toBe(
      base,
    );
    expect(automationFormSnapshot({ ...state, thinkingLevel: 'low' })).not.toBe(
      base,
    );
    expect(
      automationFormSnapshot({
        ...state,
        targetRequirement: { contexts: ['app_advisor'] },
      }),
    ).not.toBe(base);
  });

  it('leaves out pipeline metadata that is never saved', () => {
    const state = activityToFormState(activity());
    expect(
      automationFormSnapshot({
        ...state,
        pipelineModelAliases: [],
        pipelinePluginCollectionIds: [],
      }),
    ).toBe(automationFormSnapshot(state));
  });
});
