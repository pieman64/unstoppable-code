import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import { PIPELINE_TARGET_GLOBAL_PROJECT_PIPELINE_ERROR } from '@canopy/desktop-shared/lib/automation-pipeline-target';
import {
  AUTOMATION_PIPELINE_TASK_REQUIRED_ERROR,
  displayedPipelineRunIn,
  activityToFormState,
  applyGlobalPipelineSelection,
  applyPipelineRunInSelection,
  applyWorkspaceActionSelection,
  automationFormActionCategory,
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

  it('saves pipeline dependencies on create and clears them on edit', () => {
    const pipelines = [{ pipelineId: 'pipeline-1', source: 'user' as const }];
    expect(
      buildAutomationMutationRequest(
        validCreateState({ pipelineDependencies: pipelines }),
      ),
    ).toMatchObject({
      ok: true,
      mode: 'create',
      request: { dependencies: { pipelines } },
    });
    const empty = buildAutomationMutationRequest(
      validCreateState({ pipelineDependencies: [] }),
    );
    expect(
      empty.ok && empty.mode === 'create' && 'dependencies' in empty.request,
    ).toBe(false);

    const loaded = activityToFormState(
      activity({ dependencies: { pipelines } }),
    );
    expect(loaded.pipelineDependencies).toEqual(pipelines);
    expect(buildAutomationMutationRequest(loaded)).toMatchObject({
      ok: true,
      mode: 'update',
      request: { dependencies: { pipelines } },
    });
    expect(
      buildAutomationMutationRequest({ ...loaded, pipelineDependencies: [] }),
    ).toMatchObject({
      ok: true,
      mode: 'update',
      request: { dependencies: null },
    });
  });

  it('treats an empty pipeline list like no list in the dirty check', () => {
    const state = activityToFormState(activity());
    expect(automationFormSnapshot({ ...state, pipelineDependencies: [] })).toBe(
      automationFormSnapshot(state),
    );
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
      error: 'Enter a prompt for Orchestrator.',
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
      error: 'Pick a workflow to run.',
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
      error: 'Scheduled workflow resumes cannot be edited.',
      section: 'definition',
    });
  });
});

describe('automationDraftFromSeed', () => {
  it('is a pipeline with no project without a seed', () => {
    const draft = automationDraftFromSeed();
    expect(draft).toEqual({
      ...emptyFormState(),
      actionType: 'worktree_pipeline',
      pipelineTargetKind: 'global',
      pipelineTargetExplicit: true,
    });
    expect(automationFormActionCategory(draft)).toBe('global');
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
    const reordered: FormState = { ...state, approvalMode: undefined };
    const reversedEntries = Object.entries(reordered).reverse();
    for (const key of Object.keys(reordered)) {
      Reflect.deleteProperty(reordered, key);
    }
    Object.assign(reordered, Object.fromEntries(reversedEntries));
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

describe('pipeline destinations', () => {
  const pipelineActivity = (
    action: Partial<
      Extract<ScheduledActivity['action'], { type: 'worktree_pipeline' }>
    >,
  ): ScheduledActivity =>
    activity({
      action: {
        type: 'worktree_pipeline',
        pipelineId: 'review',
        pipelineName: 'Review',
        ...action,
      },
    });

  it('round-trips a pipeline with no project without a workspace', () => {
    const state = activityToFormState(
      pipelineActivity({ target: { kind: 'global' } }),
    );
    expect(automationFormActionCategory(state)).toBe('global');
    expect(buildAction(state)).toEqual({
      action: {
        type: 'worktree_pipeline',
        target: { kind: 'global' },
        pipelineId: 'review',
        pipelineName: 'Review',
      },
    });
  });

  it('ignores the inert workspace of a pipeline with no project', () => {
    const state = activityToFormState(
      pipelineActivity({
        target: { kind: 'global' },
        workspaceId: 'workspace-1',
      }),
    );
    expect(state.workspaceId).toBe('');
    expect(buildAction(state).action).not.toHaveProperty('workspaceId');
  });

  it('saves an unchanged legacy action without a target', () => {
    const legacy = pipelineActivity({
      workspaceId: 'workspace-1',
      baseWorktreeId: 'base',
    });
    const state = activityToFormState(legacy);
    expect(state.pipelineTargetExplicit).toBe(false);
    expect(buildAction(state).action).toEqual(legacy.action);
    // A legacy action on a cowork project shows the project folder.
    expect(displayedPipelineRunIn(state, true)).toBe('project');
    expect(displayedPipelineRunIn(state, false)).toBe('new_worktree');
    expect(applyPipelineRunInSelection(state, 'project', 'project')).toBe(
      state,
    );
  });

  it('builds task and project-folder destinations without a base worktree', () => {
    const legacy = activityToFormState(
      pipelineActivity({ workspaceId: 'workspace-1', baseWorktreeId: 'base' }),
    );
    const task = {
      ...applyPipelineRunInSelection(legacy, 'task', 'new_worktree'),
      pipelineTaskId: 'task-1',
    };
    expect(buildAction(task).action).toEqual({
      type: 'worktree_pipeline',
      workspaceId: 'workspace-1',
      target: { kind: 'task', taskId: 'task-1' },
      pipelineId: 'review',
      pipelineName: 'Review',
    });
    const project = applyPipelineRunInSelection(
      legacy,
      'project',
      'new_worktree',
    );
    expect(buildAction(project).action).toEqual({
      type: 'worktree_pipeline',
      workspaceId: 'workspace-1',
      target: { kind: 'project' },
      pipelineId: 'review',
      pipelineName: 'Review',
    });
    expect(automationFormSnapshot(project)).not.toBe(
      automationFormSnapshot(legacy),
    );
  });

  it('asks for a task before saving a task destination', () => {
    const state = applyPipelineRunInSelection(
      activityToFormState(pipelineActivity({ workspaceId: 'workspace-1' })),
      'task',
      'new_worktree',
    );
    expect(buildAction(state)).toEqual({
      error: AUTOMATION_PIPELINE_TASK_REQUIRED_ERROR,
    });
  });

  it('clears project-only fields when switching to no project', () => {
    const state = applyGlobalPipelineSelection(
      activityToFormState(
        activity({
          targetRequirement: { contexts: ['worktree'] },
          action: {
            type: 'worktree_pipeline',
            workspaceId: 'workspace-1',
            baseWorktreeId: 'base',
            repoId: 'repo-1',
            pipelineId: 'review',
            pipelineName: 'Review',
            pipelineSource: 'user',
          },
        }),
      ),
    );
    expect(state).toMatchObject({
      workspaceId: '',
      baseWorktreeId: '',
      repoId: '',
      targetRequirement: undefined,
      pipelineId: 'review',
    });
    expect(buildAction(state).action).toEqual({
      type: 'worktree_pipeline',
      target: { kind: 'global' },
      pipelineId: 'review',
      pipelineName: 'Review',
      pipelineSource: 'user',
    });
  });

  it('drops a project pipeline when switching to no project', () => {
    const state = applyGlobalPipelineSelection(
      activityToFormState(
        pipelineActivity({
          workspaceId: 'workspace-1',
          pipelineSource: 'project',
          projectPipelineFilename: 'review.yaml',
        }),
      ),
    );
    expect(state.pipelineId).toBe('');
    expect(
      buildAction({ ...state, pipelineId: 'x', pipelineSource: 'project' }),
    ).toEqual({ error: PIPELINE_TARGET_GLOBAL_PROJECT_PIPELINE_ERROR });
  });

  it('restores the default project destination after no project', () => {
    const state = applyWorkspaceActionSelection(
      automationDraftFromSeed(),
      'pipeline',
      { id: 'workspace-1', isCowork: false },
    );
    expect(automationFormActionCategory(state)).toBe('workspace');
    expect(state.pipelineTargetExplicit).toBe(false);
    expect(state.workspaceId).toBe('workspace-1');
  });

  it('turns an explicit new worktree into the project folder on a cowork project', () => {
    const code = applyPipelineRunInSelection(
      activityToFormState(pipelineActivity({ workspaceId: 'workspace-1' })),
      'new_worktree',
      'project',
    );
    const cowork = applyWorkspaceActionSelection(code, 'pipeline', {
      id: 'cowork-1',
      isCowork: true,
    });
    expect(cowork.pipelineTargetKind).toBe('project');
    expect(cowork.pipelineTargetExplicit).toBe(true);
  });
});
