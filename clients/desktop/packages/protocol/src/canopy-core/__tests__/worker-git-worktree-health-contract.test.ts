import {
  CANOPY_QUERY_DEFINITIONS,
  WORKER_GIT_GRANTS,
  WORKER_GIT_WORKTREE_HEALTH_QUERY_DEFINITIONS,
  WorkerGitWorktreeHealthGetErrorSchema,
  WorkerGitWorktreeHealthGetParamsSchema,
  WorkerGitWorktreeHealthGetResultSchema,
} from '../index';

const broken = {
  healthy: false,
  issue: {
    code: 'missing-repository',
    checkedAt: '2026-10-27T12:00:00.000Z',
    repoIssues: [
      { repoId: 'alpha', code: 'missing-repository' },
      { repoId: '__workspace_root__', code: 'git-error' },
    ],
  },
};

describe('worker.git.worktree.health.get contract', () => {
  it('is a worker-plane Git read registered in the universal catalog', () => {
    expect(Object.keys(WORKER_GIT_WORKTREE_HEALTH_QUERY_DEFINITIONS)).toEqual([
      'worker.git.worktree.health.get',
    ]);
    expect(CANOPY_QUERY_DEFINITIONS['worker.git.worktree.health.get']).toBe(
      WORKER_GIT_WORKTREE_HEALTH_QUERY_DEFINITIONS[
        'worker.git.worktree.health.get'
      ],
    );
    expect(
      WORKER_GIT_WORKTREE_HEALTH_QUERY_DEFINITIONS[
        'worker.git.worktree.health.get'
      ],
    ).toMatchObject({
      kind: 'query',
      plane: 'worker',
      domain: 'git',
      version: 1,
      placement: 'target-selectable',
      idempotency: 'inherent',
      requiredGrants: [WORKER_GIT_GRANTS.read],
    });
  });

  it('selects one worktree by ids, never by path or repository', () => {
    for (const params of [
      { scope: { workspaceId: 'ws', worktreeId: 'wt' } },
      {
        scope: {
          workspaceId: 'ws',
          worktreeId: 'wt',
          authorityId: 'local-desktop',
          targetId: 't',
        },
      },
    ])
      expect(WorkerGitWorktreeHealthGetParamsSchema.parse(params)).toEqual(
        params,
      );
    for (const params of [
      { scope: {} },
      { scope: { workspaceId: 'ws' } },
      { scope: { worktreeId: 'wt' } },
      { scope: { workspaceId: '', worktreeId: 'wt' } },
      { scope: { workspaceId: 'ws', worktreeId: 'wt', repoId: 'alpha' } },
      { scope: { workspaceId: 'ws', worktreeId: 'wt', path: '/wt' } },
      { scope: { workspaceId: 'ws', worktreeId: 'wt' }, path: '/wt' },
    ])
      expect(
        WorkerGitWorktreeHealthGetParamsSchema.safeParse(params).success,
      ).toBe(false);
  });

  it('closes the result to ids, codes and the check time', () => {
    expect(
      WorkerGitWorktreeHealthGetResultSchema.parse({ healthy: true }),
    ).toEqual({ healthy: true });
    expect(WorkerGitWorktreeHealthGetResultSchema.parse(broken)).toEqual(
      broken,
    );
    const single = {
      healthy: false,
      issue: {
        code: 'invalid-git-worktree',
        checkedAt: '2026-10-27T12:00:00.000Z',
        repoIssues: null,
      },
    };
    expect(WorkerGitWorktreeHealthGetResultSchema.parse(single)).toEqual(
      single,
    );
    // Configured repository ids are unbounded; the answer must not fail.
    const storedIds = {
      healthy: false,
      issue: {
        ...broken.issue,
        repoIssues: [
          { repoId: '', code: 'missing-repository' },
          { repoId: 'c'.repeat(600), code: 'missing-repository' },
        ],
      },
    };
    expect(WorkerGitWorktreeHealthGetResultSchema.parse(storedIds)).toEqual(
      storedIds,
    );
    for (const result of [
      { healthy: true, issue: broken.issue },
      { healthy: false },
      { healthy: false, issue: null },
      { ...broken, worktree: { id: 'wt' } },
      { ...broken, issue: { ...broken.issue, worktreePath: '/wt' } },
      { ...broken, issue: { ...broken.issue, message: 'broken' } },
      { ...broken, issue: { ...broken.issue, gitError: 'fatal' } },
      { ...broken, issue: { ...broken.issue, code: 'broken' } },
      { ...broken, issue: { ...broken.issue, checkedAt: 'yesterday' } },
      {
        ...broken,
        issue: {
          ...broken.issue,
          repoIssues: [
            { repoId: 'alpha', code: 'missing-repository', repoPath: '/a' },
          ],
        },
      },
      {
        ...broken,
        issue: {
          ...broken.issue,
          repoIssues: [
            { repoId: 'alpha', code: 'missing-repository', repoName: 'Alpha' },
          ],
        },
      },
    ])
      expect(
        WorkerGitWorktreeHealthGetResultSchema.safeParse(result).success,
      ).toBe(false);
  });

  it('declares only the scope codes', () => {
    for (const [kind, code] of [
      ['invalid_argument', 'worker.git.worktree.invalidScope'],
      ['failed_precondition', 'worker.git.worktree.scopeUnsupported'],
    ])
      expect(
        WorkerGitWorktreeHealthGetErrorSchema.safeParse({
          kind,
          code,
          message: 'refused',
          retry: { kind: 'never' },
        }).success,
      ).toBe(true);
    expect(
      WorkerGitWorktreeHealthGetErrorSchema.safeParse({
        kind: 'failed_precondition',
        code: 'worker.git.branch.scopeUnsupported',
        message: 'refused',
        retry: { kind: 'never' },
      }).success,
    ).toBe(false);
  });
});
