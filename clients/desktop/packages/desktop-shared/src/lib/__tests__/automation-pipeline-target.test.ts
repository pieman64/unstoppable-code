import {
  automationPipelineDestinationKey,
  automationPipelineTargetError,
  isGlobalPipelineAutomationAction,
  pipelineAutomationTaskId,
  pipelineAutomationWorkspaceId,
  resolveAutomationPipelineTarget,
  PIPELINE_TARGET_BASE_WORKTREE_ERROR,
  PIPELINE_TARGET_GLOBAL_PROJECT_FIELDS_ERROR,
  PIPELINE_TARGET_GLOBAL_PROJECT_PIPELINE_ERROR,
  PIPELINE_TARGET_KIND_ERROR,
  PIPELINE_TARGET_TASK_ID_ERROR,
  PIPELINE_TARGET_WORKSPACE_REQUIRED_ERROR,
  type PipelineAutomationAction,
} from '../automation-pipeline-target';

function pipeline(
  fields: Partial<PipelineAutomationAction> = {},
): PipelineAutomationAction {
  return {
    type: 'worktree_pipeline',
    pipelineId: 'bundled-review',
    pipelineSource: 'bundled',
    ...fields,
  };
}

describe('resolveAutomationPipelineTarget', () => {
  it('reads an absent target as the legacy destination', () => {
    expect(
      resolveAutomationPipelineTarget(pipeline({ workspaceId: 'ws-1' })),
    ).toEqual({ kind: 'new_worktree', workspaceId: 'ws-1', explicit: false });
  });

  it('reads an in-memory undefined target as absent', () => {
    expect(
      resolveAutomationPipelineTarget(
        pipeline({ workspaceId: 'ws-1', target: undefined }),
      ),
    ).toEqual({ kind: 'new_worktree', workspaceId: 'ws-1', explicit: false });
  });

  it.each([
    [
      { kind: 'new_worktree' as const },
      { kind: 'new_worktree', workspaceId: 'ws-1', explicit: true },
    ],
    [
      { kind: 'task' as const, taskId: 'wt-1' },
      { kind: 'task', workspaceId: 'ws-1', taskId: 'wt-1' },
    ],
    [{ kind: 'project' as const }, { kind: 'project', workspaceId: 'ws-1' }],
  ])('resolves %j', (target, expected) => {
    expect(
      resolveAutomationPipelineTarget(
        pipeline({ workspaceId: 'ws-1', target }),
      ),
    ).toEqual(expected);
  });

  it('resolves global with or without the inert workspaceId', () => {
    const target = { kind: 'global' as const };
    expect(resolveAutomationPipelineTarget(pipeline({ target }))).toEqual({
      kind: 'global',
    });
    expect(
      resolveAutomationPipelineTarget(
        pipeline({ target, workspaceId: 'ws-1' }),
      ),
    ).toEqual({ kind: 'global' });
  });

  it('returns null for stored data the validator rejects', () => {
    expect(resolveAutomationPipelineTarget(pipeline())).toBeNull();
    expect(
      resolveAutomationPipelineTarget(
        pipeline({ target: { kind: 'project' } }),
      ),
    ).toBeNull();
    expect(
      resolveAutomationPipelineTarget(
        pipeline({ workspaceId: 'ws-1', target: { kind: 'task', taskId: '' } }),
      ),
    ).toBeNull();
  });
});

describe('pipeline destination projections', () => {
  it('never reads the inert global workspaceId', () => {
    const action = pipeline({
      target: { kind: 'global' },
      workspaceId: 'ws-1',
    });
    expect(pipelineAutomationWorkspaceId(action)).toBeUndefined();
    expect(pipelineAutomationTaskId(action)).toBeUndefined();
    expect(isGlobalPipelineAutomationAction(action)).toBe(true);
  });

  it('reports the task of a task destination', () => {
    const action = pipeline({
      workspaceId: 'ws-1',
      target: { kind: 'task', taskId: 'wt-1' },
    });
    expect(pipelineAutomationWorkspaceId(action)).toBe('ws-1');
    expect(pipelineAutomationTaskId(action)).toBe('wt-1');
    expect(isGlobalPipelineAutomationAction(action)).toBe(false);
  });
});

describe('automationPipelineDestinationKey', () => {
  it('ignores the inert global workspaceId', () => {
    expect(
      automationPipelineDestinationKey(
        pipeline({ target: { kind: 'global' }, workspaceId: 'ws-1' }),
      ),
    ).toBe(
      automationPipelineDestinationKey(
        pipeline({ target: { kind: 'global' } }),
      ),
    );
  });

  it('distinguishes every destination', () => {
    const keys = [
      pipeline({ workspaceId: 'ws-1' }),
      pipeline({ workspaceId: 'ws-1', target: { kind: 'new_worktree' } }),
      pipeline({ workspaceId: 'ws-1', target: { kind: 'project' } }),
      pipeline({ workspaceId: 'ws-1', target: { kind: 'task', taskId: 'a' } }),
      pipeline({ workspaceId: 'ws-1', target: { kind: 'task', taskId: 'b' } }),
      pipeline({ workspaceId: 'ws-2', target: { kind: 'project' } }),
      pipeline({ target: { kind: 'global' } }),
    ].map(automationPipelineDestinationKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('automationPipelineTargetError', () => {
  it.each([
    [{ workspaceId: 'ws-1' }, null],
    [{ workspaceId: 'ws-1', target: undefined }, null],
    [{}, PIPELINE_TARGET_WORKSPACE_REQUIRED_ERROR],
    [{ workspaceId: 'ws-1', target: null }, PIPELINE_TARGET_KIND_ERROR],
    [{ workspaceId: 'ws-1', target: 'global' }, PIPELINE_TARGET_KIND_ERROR],
    [
      { workspaceId: 'ws-1', target: { kind: 'x' } },
      PIPELINE_TARGET_KIND_ERROR,
    ],
    [
      { workspaceId: 'ws-1', target: { kind: 'project', taskId: 'wt-1' } },
      PIPELINE_TARGET_KIND_ERROR,
    ],
    [
      { workspaceId: 'ws-1', target: { kind: 'global', extra: true } },
      PIPELINE_TARGET_KIND_ERROR,
    ],
    [
      { workspaceId: 'ws-1', target: { kind: 'task' } },
      PIPELINE_TARGET_TASK_ID_ERROR,
    ],
    [
      { target: { kind: 'task', taskId: 'wt-1' } },
      PIPELINE_TARGET_WORKSPACE_REQUIRED_ERROR,
    ],
    [
      { target: { kind: 'new_worktree' } },
      PIPELINE_TARGET_WORKSPACE_REQUIRED_ERROR,
    ],
    [{ target: { kind: 'project' } }, PIPELINE_TARGET_WORKSPACE_REQUIRED_ERROR],
    [{ target: { kind: 'global' } }, null],
    [{ target: { kind: 'global' }, workspaceId: 'ws-1' }, null],
    [
      { target: { kind: 'global' }, workspaceId: 7 },
      PIPELINE_TARGET_WORKSPACE_REQUIRED_ERROR,
    ],
    [
      { target: { kind: 'global' }, baseWorktreeId: 'main' },
      PIPELINE_TARGET_GLOBAL_PROJECT_FIELDS_ERROR,
    ],
    [
      { target: { kind: 'global' }, repoId: 'r' },
      PIPELINE_TARGET_GLOBAL_PROJECT_FIELDS_ERROR,
    ],
    [
      { target: { kind: 'global' }, projectPipelineFilename: 'p.yml' },
      PIPELINE_TARGET_GLOBAL_PROJECT_FIELDS_ERROR,
    ],
    [
      { target: { kind: 'global' }, pipelineSource: 'project' },
      PIPELINE_TARGET_GLOBAL_PROJECT_PIPELINE_ERROR,
    ],
    [
      {
        workspaceId: 'ws-1',
        target: { kind: 'task', taskId: 'wt-1' },
        baseWorktreeId: 'main',
      },
      PIPELINE_TARGET_BASE_WORKTREE_ERROR,
    ],
    [
      {
        workspaceId: 'ws-1',
        target: { kind: 'project' },
        baseWorktreeId: 'main',
      },
      PIPELINE_TARGET_BASE_WORKTREE_ERROR,
    ],
    [
      {
        workspaceId: 'ws-1',
        target: { kind: 'new_worktree' },
        baseWorktreeId: 'main',
      },
      null,
    ],
    [{ workspaceId: 'ws-1', target: { kind: 'project' }, repoId: 'r' }, null],
  ])('%j → %s', (fields, expected) => {
    expect(
      automationPipelineTargetError({
        type: 'worktree_pipeline',
        pipelineId: 'p',
        ...fields,
      }),
    ).toBe(expected);
  });
});
