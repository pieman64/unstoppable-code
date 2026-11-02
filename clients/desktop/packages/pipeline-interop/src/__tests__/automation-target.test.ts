import {
  automationDestinationExecutionScope,
  pipelineSupportsAutomationDestination,
  resolveAutomationTargetRequirement,
  pipelineScopeTargetContexts,
  PIPELINE_TARGET_NO_PROJECT_SCOPE_ERROR,
  PIPELINE_TARGET_REQUIREMENT_GLOBAL_ERROR,
} from '../automation-target';

describe('automation target scope policy', () => {
  it.each([
    ['directory', ['cowork', 'worktree']],
    ['worktree', ['worktree']],
    ['global', []],
    [['global', 'worktree'], ['worktree']],
    [
      ['directory', 'worktree'],
      ['cowork', 'worktree'],
    ],
    [undefined, ['cowork', 'worktree']],
  ])('uses established scope semantics for %j', (scopes, contexts) => {
    const result = resolveAutomationTargetRequirement(
      'worktree_pipeline',
      undefined,
      { status: 'resolved', scopes },
    );
    expect(result.contexts).toEqual(contexts);
    expect(result.status).toBe(contexts.length ? 'resolved' : 'error');
  });
  it('does not apply default scopes to missing or invalid definitions', () => {
    expect(
      resolveAutomationTargetRequirement('worktree_pipeline'),
    ).toMatchObject({ status: 'pending' });
    expect(
      resolveAutomationTargetRequirement('worktree_pipeline', undefined, {
        status: 'error',
        error: 'unreadable',
      }),
    ).toMatchObject({ status: 'error' });
    expect(
      resolveAutomationTargetRequirement('worktree_pipeline', undefined, {
        status: 'resolved',
        scopes: 'invalid',
      }),
    ).toMatchObject({ status: 'error' });
  });
  it('preserves the declaration when replacement scopes change', () => {
    const declaration = { contexts: ['cowork'] as const };
    const requirement = { contexts: [...declaration.contexts] };
    expect(
      resolveAutomationTargetRequirement('worktree_pipeline', requirement, {
        status: 'resolved',
        scopes: 'directory',
      }),
    ).toEqual({ status: 'resolved', contexts: ['cowork'] });
    expect(
      resolveAutomationTargetRequirement('worktree_pipeline', requirement, {
        status: 'resolved',
        scopes: 'worktree',
      }),
    ).toMatchObject({
      status: 'error',
      contexts: [],
      error:
        'This workflow has no compatible automation target. Choose another workflow or edit its target requirement.',
    });
  });
  it('rejects action contradictions before resolving pipelines', () => {
    expect(
      resolveAutomationTargetRequirement('worktree_prompt', {
        contexts: ['cowork'],
      }),
    ).toMatchObject({ status: 'error' });
    expect(pipelineScopeTargetContexts(['global', 'directory'])).toEqual([
      'cowork',
      'worktree',
    ]);
  });
});

describe('automation pipeline destinations', () => {
  it.each([
    ['global', undefined, 'global'],
    ['global', 'single-repo', 'global'],
    ['project', 'single-repo', 'directory'],
    ['project', 'cowork', 'directory'],
    ['task', 'single-repo', 'worktree'],
    ['task', 'multi-repo', 'worktree'],
    ['task', 'cowork', 'directory'],
    ['new_worktree', 'single-repo', 'worktree'],
    [undefined, 'single-repo', 'worktree'],
    [undefined, 'cowork', 'directory'],
  ] as const)('%s on %s needs %s', (destination, projectKind, scope) => {
    expect(automationDestinationExecutionScope(destination, projectKind)).toBe(
      scope,
    );
  });

  it('keeps the directory-in-worktree rule and refuses new worktrees on cowork', () => {
    expect(
      pipelineSupportsAutomationDestination(
        ['directory'],
        'task',
        'single-repo',
      ),
    ).toBe(true);
    expect(
      pipelineSupportsAutomationDestination(
        ['worktree'],
        'project',
        'single-repo',
      ),
    ).toBe(false);
    expect(
      pipelineSupportsAutomationDestination(['directory'], 'global', undefined),
    ).toBe(false);
    expect(
      pipelineSupportsAutomationDestination(
        ['worktree'],
        'new_worktree',
        'cowork',
      ),
    ).toBe(false);
  });

  it('resolves a global destination with no contexts', () => {
    expect(
      resolveAutomationTargetRequirement(
        'worktree_pipeline',
        undefined,
        { status: 'resolved', scopes: ['global'] },
        'global',
      ),
    ).toEqual({ status: 'resolved', contexts: [] });
    expect(
      resolveAutomationTargetRequirement(
        'worktree_pipeline',
        undefined,
        { status: 'pending' },
        'global',
      ),
    ).toEqual({ status: 'pending', contexts: [] });
    expect(
      resolveAutomationTargetRequirement(
        'worktree_pipeline',
        undefined,
        { status: 'resolved', scopes: ['directory'] },
        'global',
      ),
    ).toEqual({
      status: 'error',
      contexts: [],
      error: PIPELINE_TARGET_NO_PROJECT_SCOPE_ERROR,
    });
  });

  it('refuses a target requirement on a global destination', () => {
    expect(
      resolveAutomationTargetRequirement(
        'worktree_pipeline',
        { contexts: ['worktree'] },
        { status: 'resolved', scopes: ['global'] },
        'global',
      ),
    ).toEqual({
      status: 'error',
      contexts: [],
      error: PIPELINE_TARGET_REQUIREMENT_GLOBAL_ERROR,
    });
  });

  it('narrows explicit destinations to the contexts their scope admits', () => {
    expect(
      resolveAutomationTargetRequirement(
        'worktree_pipeline',
        undefined,
        { status: 'resolved', scopes: ['worktree'] },
        'task',
      ),
    ).toEqual({ status: 'resolved', contexts: ['worktree'] });
    expect(
      resolveAutomationTargetRequirement(
        'worktree_pipeline',
        undefined,
        { status: 'resolved', scopes: ['directory'] },
        'new_worktree',
      ),
    ).toEqual({ status: 'resolved', contexts: ['worktree'] });
    expect(
      resolveAutomationTargetRequirement(
        'worktree_pipeline',
        undefined,
        { status: 'resolved', scopes: ['worktree'] },
        'project',
      ),
    ).toMatchObject({ status: 'error', contexts: [] });
  });

  it('keeps legacy behavior when the destination is omitted', () => {
    expect(
      resolveAutomationTargetRequirement('worktree_pipeline', undefined, {
        status: 'resolved',
        scopes: ['directory'],
      }),
    ).toEqual({ status: 'resolved', contexts: ['cowork', 'worktree'] });
  });
});
