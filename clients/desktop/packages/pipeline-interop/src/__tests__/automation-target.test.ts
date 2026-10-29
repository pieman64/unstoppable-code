import {
  resolveAutomationTargetRequirement,
  pipelineScopeTargetContexts,
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
    ).toMatchObject({ status: 'error', contexts: [] });
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
