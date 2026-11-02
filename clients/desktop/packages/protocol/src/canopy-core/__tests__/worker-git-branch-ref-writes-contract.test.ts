import {
  CANOPY_INSTRUCTION_DEFINITIONS,
  WORKER_GIT_BRANCH_REF_INSTRUCTION_DEFINITIONS,
  WORKER_GIT_GRANTS,
  WorkerGitBranchDeleteErrorSchema,
  WorkerGitBranchDeleteParamsSchema,
  WorkerGitBranchDeleteResultSchema,
  WorkerGitBranchRenameErrorSchema,
  WorkerGitBranchRenameParamsSchema,
  WorkerGitBranchRenameResultSchema,
} from '../index';

const scope = { workspaceId: 'ws', worktreeId: 'wt' };
const SHA1 = 'a'.repeat(40);

describe('worker.git branch rename and delete contracts (CAN-5516)', () => {
  it.each(['worker.git.branch.rename', 'worker.git.branch.delete'] as const)(
    '%s is a worker instruction under worker.git.write, idempotency none',
    (name) => {
      const definition = WORKER_GIT_BRANCH_REF_INSTRUCTION_DEFINITIONS[name];
      expect(definition).toMatchObject({
        kind: 'instruction',
        plane: 'worker',
        domain: 'git',
        version: 1,
        placement: 'target-selectable',
        idempotency: 'none',
        requiredGrants: [WORKER_GIT_GRANTS.write],
      });
      expect(CANOPY_INSTRUCTION_DEFINITIONS[name]).toBe(definition);
    },
  );

  it('renames in a checkout selected by scope ids, never by path, and takes no _meta', () => {
    expect(
      WorkerGitBranchRenameParamsSchema.parse({
        scope: { ...scope, repoId: 'api' },
        name: ' untrimmed ',
        expected: { branch: 'task' },
      }),
    ).toEqual({
      scope: { ...scope, repoId: 'api' },
      name: ' untrimmed ',
      expected: { branch: 'task' },
    });
    for (const params of [
      { scope: { workspaceId: 'ws' }, name: 'new' },
      { scope, name: 'new', path: '/repo' },
      { scope, name: 'new', _meta: { idempotencyKey: 'key' } },
      { scope, name: 'new', expected: { branch: '' } },
      { scope },
    ])
      expect(WorkerGitBranchRenameParamsSchema.safeParse(params).success).toBe(
        false,
      );
  });

  it('deletes in a recorded repository, with one of three closed deletion kinds', () => {
    for (const deletion of [
      { kind: 'merged' },
      { kind: 'force' },
      { kind: 'tip', tip: SHA1 },
      { kind: 'tip', tip: 'b'.repeat(64) },
    ])
      expect(
        WorkerGitBranchDeleteParamsSchema.parse({
          scope: { workspaceId: 'ws', repoId: 'api' },
          branch: 'old',
          deletion,
        }),
      ).toEqual({
        scope: { workspaceId: 'ws', repoId: 'api' },
        branch: 'old',
        deletion,
      });
    for (const params of [
      // A repository, not a checkout: no worktree selector.
      { scope, branch: 'old', deletion: { kind: 'merged' } },
      { scope: {}, branch: 'old', deletion: { kind: 'merged' } },
      { scope: { workspaceId: 'ws' }, branch: 'old' },
      {
        scope: { workspaceId: 'ws' },
        branch: 'old',
        deletion: { kind: 'all' },
      },
      // A tip is a full lowercase object ID, never a revision expression.
      ...['HEAD', 'main', SHA1.slice(1), SHA1.toUpperCase(), `${SHA1}^`].map(
        (tip) => ({
          scope: { workspaceId: 'ws' },
          branch: 'old',
          deletion: { kind: 'tip', tip },
        }),
      ),
      {
        scope: { workspaceId: 'ws' },
        branch: 'old',
        deletion: { kind: 'force', tip: SHA1 },
      },
      {
        scope: { workspaceId: 'ws' },
        branch: 'old',
        deletion: { kind: 'merged' },
        _meta: { idempotencyKey: 'key' },
      },
    ])
      expect(WorkerGitBranchDeleteParamsSchema.safeParse(params).success).toBe(
        false,
      );
  });

  it('answers the branch name only', () => {
    expect(
      WorkerGitBranchRenameResultSchema.parse({ branch: 'renamed' }),
    ).toEqual({ branch: 'renamed' });
    expect(
      WorkerGitBranchDeleteResultSchema.safeParse({
        branch: 'old',
        path: '/repo',
      }).success,
    ).toBe(false);
  });

  it('types refusals with their family codes and refresh-or-never retries', () => {
    expect(
      WorkerGitBranchRenameErrorSchema.parse({
        kind: 'conflict',
        code: 'worker.git.branch.nameUnavailable',
        message: 'taken',
        retry: { kind: 'after_refresh', resource: 'worker.git.branch.list' },
      }),
    ).toMatchObject({ code: 'worker.git.branch.nameUnavailable' });
    expect(
      WorkerGitBranchDeleteErrorSchema.parse({
        kind: 'failed_precondition',
        code: 'worker.git.branch.checkedOut',
        message: 'held',
        retry: { kind: 'after_refresh', resource: 'worker.git.branch.list' },
      }),
    ).toMatchObject({ code: 'worker.git.branch.checkedOut' });
    expect(
      WorkerGitBranchDeleteErrorSchema.safeParse({
        kind: 'conflict',
        code: 'worker.git.branch.nameUnavailable',
        message: 'wrong family',
        retry: { kind: 'never' },
      }).success,
    ).toBe(false);
    expect(
      WorkerGitBranchRenameErrorSchema.safeParse({
        kind: 'internal',
        message: 'Git failed',
        retry: { kind: 'same_idempotency_key' },
      }).success,
    ).toBe(false);
  });
});
