import {
  CANOPY_INSTRUCTION_DEFINITIONS,
  WORKER_GIT_BRANCH_WRITE_INSTRUCTION_DEFINITIONS,
  WORKER_GIT_GRANTS,
  WorkerGitBranchCreateErrorSchema,
  WorkerGitBranchCreateParamsSchema,
  WorkerGitBranchCreateResultSchema,
  WorkerGitCheckoutErrorSchema,
  WorkerGitCheckoutParamsSchema,
  WorkerGitCheckoutResultSchema,
} from '../index';

const scope = { workspaceId: 'ws', worktreeId: 'wt' };

describe('worker.git branch write contracts (CAN-4108)', () => {
  it.each(['worker.git.checkout', 'worker.git.branch.create'] as const)(
    '%s is a worker instruction under worker.git.write, idempotency none',
    (name) => {
      const definition = WORKER_GIT_BRANCH_WRITE_INSTRUCTION_DEFINITIONS[name];
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

  it('selects a checkout by scope ids, never by path, and takes no _meta', () => {
    expect(
      WorkerGitCheckoutParamsSchema.parse({
        scope: { ...scope, repoId: 'api' },
        branch: 'release',
        expected: { branch: 'task' },
      }),
    ).toEqual({
      scope: { ...scope, repoId: 'api' },
      branch: 'release',
      expected: { branch: 'task' },
    });
    for (const params of [
      { scope: { workspaceId: 'ws' }, branch: 'release' },
      { scope: { worktreeId: 'wt' }, branch: 'release' },
      { scope: { ...scope, chatId: 'chat' }, branch: 'release' },
      { scope, branch: 'release', path: '/repo' },
      { scope, branch: 'release', _meta: { idempotencyKey: 'key' } },
      { scope, branch: 'release', expected: { branch: '' } },
    ])
      expect(WorkerGitCheckoutParamsSchema.safeParse(params).success).toBe(
        false,
      );
    for (const params of [
      { scope, name: 'new', startPoint: { branch: 'main' } },
      {
        scope,
        name: 'new',
        startPoint: { branch: 'main', remote: false },
        _meta: { idempotencyKey: 'key' },
      },
      {
        scope,
        name: 'new',
        startPoint: { branch: 'main', remote: false, ref: 'refs/x' },
      },
    ])
      expect(WorkerGitBranchCreateParamsSchema.safeParse(params).success).toBe(
        false,
      );
  });

  it('answers the branch name only', () => {
    expect(WorkerGitCheckoutResultSchema.parse({ branch: 'release' })).toEqual({
      branch: 'release',
    });
    expect(
      WorkerGitBranchCreateResultSchema.safeParse({
        branch: 'new-2',
        path: '/repo',
      }).success,
    ).toBe(false);
  });

  it('types refusals with codes and refresh-or-never retries', () => {
    expect(
      WorkerGitCheckoutErrorSchema.parse({
        kind: 'conflict',
        code: 'worker.git.checkout.headChanged',
        message: 'changed',
        retry: { kind: 'after_refresh', resource: 'worker.git.branch.list' },
      }),
    ).toMatchObject({ code: 'worker.git.checkout.headChanged' });
    expect(
      WorkerGitBranchCreateErrorSchema.safeParse({
        kind: 'internal',
        message: 'Git failed',
        retry: { kind: 'same_idempotency_key' },
      }).success,
    ).toBe(false);
    expect(
      WorkerGitBranchCreateErrorSchema.safeParse({
        kind: 'invalid_argument',
        code: 'worker.git.checkout.invalidScope',
        message: 'wrong family',
        retry: { kind: 'never' },
      }).success,
    ).toBe(false);
  });
});
