import {
  CANOPY_HOST_EXECUTION_OPERATIONS,
  CANOPY_INSTRUCTION_DEFINITIONS,
  WORKER_GIT_GRANTS,
  WORKER_GIT_SYNC_WRITE_INSTRUCTION_DEFINITIONS,
  WorkerGitFetchErrorSchema,
  WorkerGitFetchParamsSchema,
  WorkerGitFetchResultSchema,
  WorkerGitPullErrorSchema,
  WorkerGitPullParamsSchema,
  WorkerGitPullResultSchema,
  composeCanopyOperationEnvelopes,
} from '../index';

const scope = { workspaceId: 'ws', worktreeId: 'wt' };

describe('worker.git fetch and pull contracts (CAN-5517)', () => {
  it.each(['worker.git.fetch', 'worker.git.pull'] as const)(
    '%s is a worker instruction under worker.git.write, idempotency none, admitting _execution',
    (name) => {
      const definition = WORKER_GIT_SYNC_WRITE_INSTRUCTION_DEFINITIONS[name];
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
      expect(CANOPY_HOST_EXECUTION_OPERATIONS.has(name)).toBe(true);
    },
  );

  it('selects a checkout by scope ids, never by path or remote, and takes no _meta', () => {
    expect(
      WorkerGitFetchParamsSchema.parse({
        scope: { ...scope, repoId: 'api' },
        prune: true,
      }),
    ).toEqual({ scope: { ...scope, repoId: 'api' }, prune: true });
    for (const params of [
      { scope },
      { scope, prune: true, remote: 'upstream' },
      { scope, prune: true, refspecs: ['main'] },
      { scope: { ...scope, chatId: 'chat' }, prune: true },
      { scope, prune: true, _meta: { idempotencyKey: 'key' } },
    ])
      expect(WorkerGitFetchParamsSchema.safeParse(params).success).toBe(false);
    expect(
      WorkerGitPullParamsSchema.parse({
        scope,
        branch: 'feature',
        strategy: 'rebase',
        expected: { branch: 'feature' },
      }),
    ).toMatchObject({ strategy: 'rebase', expected: { branch: 'feature' } });
    for (const params of [
      { scope, branch: 'feature' },
      { scope, branch: 'feature', strategy: 'merge' },
      { scope, branch: 'feature', strategy: 'ff_only' },
      { scope, branch: 'feature', strategy: 'rebase', remote: 'origin' },
      { scope, branch: 'feature', strategy: 'rebase', expectedHeadSha: 'a' },
      { scope, branch: 'feature', strategy: 'rebase', expected: { branch: '' } }, // prettier-ignore
      {
        scope,
        branch: 'feature',
        strategy: 'rebase',
        _meta: { idempotencyKey: 'key' },
      },
    ])
      expect(WorkerGitPullParamsSchema.safeParse(params).success).toBe(false);
  });

  it('accepts _execution beside the params of both instructions', () => {
    const execution = { childEnvironment: { PATH: '/usr/bin' } };
    for (const [name, params] of [
      ['worker.git.fetch', { scope, prune: false }],
      ['worker.git.pull', { scope, branch: 'b', strategy: 'fast-forward' }],
    ] as const) {
      const envelopes = composeCanopyOperationEnvelopes(
        name,
        WORKER_GIT_SYNC_WRITE_INSTRUCTION_DEFINITIONS[name],
      );
      expect(
        envelopes.request.safeParse({
          jsonrpc: '2.0',
          id: 1,
          method: name,
          params: { ...params, _execution: execution },
        }).success,
      ).toBe(true);
    }
  });

  it('answers outcomes without paths, URLs or Git output', () => {
    expect(
      WorkerGitFetchResultSchema.parse({ remote: 'origin', pruned: true }),
    ).toEqual({ remote: 'origin', pruned: true });
    expect(
      WorkerGitFetchResultSchema.safeParse({
        remote: 'origin',
        pruned: false,
        url: 'https://example.test/repo.git',
      }).success,
    ).toBe(false);
    expect(WorkerGitPullResultSchema.parse({ outcome: 'pulled' })).toEqual({
      outcome: 'pulled',
    });
    expect(
      WorkerGitPullResultSchema.parse({
        outcome: 'conflict',
        conflict: 'autostash',
      }),
    ).toEqual({ outcome: 'conflict', conflict: 'autostash' });
    for (const result of [
      { outcome: 'conflict' },
      { outcome: 'conflict', conflict: 'merge' },
      { outcome: 'pulled', conflict: 'rebase' },
      { outcome: 'conflict', conflict: 'rebase', files: ['a.txt'] },
    ])
      expect(WorkerGitPullResultSchema.safeParse(result).success).toBe(false);
  });

  it('types refusals with family codes and refresh-or-never retries', () => {
    expect(
      WorkerGitPullErrorSchema.parse({
        kind: 'conflict',
        code: 'worker.git.pull.headChanged',
        message: 'changed',
        retry: { kind: 'after_refresh', resource: 'worker.git.status.get' },
      }),
    ).toMatchObject({ code: 'worker.git.pull.headChanged' });
    expect(
      WorkerGitFetchErrorSchema.safeParse({
        kind: 'unavailable',
        message: 'offline',
        retry: { kind: 'same_idempotency_key' },
      }).success,
    ).toBe(false);
    expect(
      WorkerGitFetchErrorSchema.safeParse({
        kind: 'permission_denied',
        code: 'worker.git.pull.callerRefused',
        message: 'wrong family',
        retry: { kind: 'never' },
      }).success,
    ).toBe(false);
  });
});
