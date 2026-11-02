import {
  WORKER_GIT_GRANTS,
  WORKER_GIT_QUERY_DEFINITIONS,
  type CanopyCallerDescriptor,
  type WorkerGitBranchListParams,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import type { CanopyDispatcher } from '../../../runtime/types';
import { CanopyOperationError } from '../../../runtime/errors';
import {
  createWorkerGitBranchListHandlers,
  WorkerGitScopeError,
  type WorkerGitBranchListHost,
} from '../worker-git-branch-list';

const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'test',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [WORKER_GIT_GRANTS.read],
};
const NOW = Date.parse('2026-10-26T12:00:00.000Z');

interface Recorded {
  resolved: WorkerGitBranchListParams[];
  remoteReads: number;
  refReads?: number;
}

function host(
  overrides: Partial<WorkerGitBranchListHost<string>> = {},
  recorded: Recorded = { resolved: [], remoteReads: 0 },
): WorkerGitBranchListHost<string> {
  return {
    authorityId: 'local-desktop',
    resolveRepository: (params): Promise<string> => {
      recorded.resolved.push(params);
      return Promise.resolve('/repo');
    },
    reads: () => ({
      readBranchRefs: (): Promise<string> => {
        recorded.refReads = (recorded.refReads ?? 0) + 1;
        return Promise.resolve(
          'refs/heads/feature\tfeature*\nrefs/heads/main\tmain \nrefs/remotes/origin/main\torigin/main \n',
        );
      },
      readWorktreeList: () =>
        Promise.resolve({
          output: 'worktree /main\nbranch refs/heads/main\n',
          checkoutPath: '/repo',
        }),
      defaultBranchFacts: {
        readHint: () => Promise.resolve(null),
        readRemoteHead: (): Promise<string> => {
          recorded.remoteReads += 1;
          return Promise.resolve('main');
        },
        readLocalOriginHead: () => Promise.resolve(null),
        readConventional: () => Promise.resolve(null),
      },
    }),
    now: () => NOW,
    ...overrides,
  };
}

function dispatcher(
  gitHost: WorkerGitBranchListHost<string>,
): CanopyDispatcher<typeof WORKER_GIT_QUERY_DEFINITIONS> {
  return createCanopyDispatcher({
    profile: 'worker',
    definitions: WORKER_GIT_QUERY_DEFINITIONS,
    handlers: createWorkerGitBranchListHandlers(gitHost),
  });
}

const checkout: WorkerGitBranchListParams = {
  scope: { workspaceId: 'ws', worktreeId: 'wt' },
  repository: { kind: 'checkout' },
};

describe('worker.git.branch.list handler', () => {
  it('lists through the host and labels the selected default', async () => {
    const recorded: Recorded = { resolved: [], remoteReads: 0 };
    await expect(
      dispatcher(host({}, recorded)).query('worker.git.branch.list', checkout, {
        caller,
      }),
    ).resolves.toEqual({
      branches: [
        expect.objectContaining({ name: 'feature', isCurrent: true }),
        expect.objectContaining({
          name: 'main',
          isUsedByWorktree: true,
          hasRemoteRef: true,
        }),
      ],
      defaultBranch: 'main',
      defaultBranchSource: 'remote',
    });
    expect(recorded.resolved).toEqual([checkout]);
    expect(recorded.remoteReads).toBe(1);
  });

  it('denies a caller without worker.git.read before the host runs', async () => {
    const recorded: Recorded = { resolved: [], remoteReads: 0 };
    await expect(
      dispatcher(host({}, recorded)).query('worker.git.branch.list', checkout, {
        caller: { ...caller, grants: ['worker.filesystem.read'] },
      }),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(recorded.resolved).toEqual([]);
  });

  it('rejects scopes that cannot name the requested repository', async () => {
    const recorded: Recorded = { resolved: [], remoteReads: 0 };
    const runtime = dispatcher(host({}, recorded));
    for (const params of [
      { scope: {}, repository: { kind: 'checkout' } },
      { scope: { workspaceId: 'ws' }, repository: { kind: 'checkout' } },
      {
        scope: { workspaceId: 'ws', worktreeId: 'wt' },
        repository: { kind: 'reference' },
      },
      {
        scope: { workspaceId: 'ws', repoId: 'repo' },
        repository: { kind: 'reference' },
      },
    ] satisfies WorkerGitBranchListParams[])
      await expect(
        runtime.query('worker.git.branch.list', params, { caller }),
      ).rejects.toMatchObject({
        payload: {
          kind: 'invalid_argument',
          code: 'worker.git.branch.invalidScope',
        },
      });
    expect(recorded.resolved).toEqual([]);
  });

  it('refuses another authority or target before resolving or reading', async () => {
    const reference: WorkerGitBranchListParams = {
      scope: { workspaceId: 'ws' },
      repository: { kind: 'reference' },
    };
    for (const params of [checkout, reference])
      for (const selection of [
        { authorityId: 'foreign-authority' },
        { targetId: 'remote-worker' },
        { authorityId: 'local-desktop', targetId: 'remote-worker' },
      ]) {
        const recorded: Recorded = { resolved: [], remoteReads: 0 };
        const failure = await dispatcher(host({}, recorded))
          .query(
            'worker.git.branch.list',
            { ...params, scope: { ...params.scope, ...selection } },
            { caller },
          )
          .catch((thrown: unknown) => thrown);
        expect(failure).toBeInstanceOf(CanopyOperationError);
        expect(failure).toMatchObject({
          payload: { kind: 'capability_unavailable', retry: { kind: 'never' } },
        });
        expect(recorded).toEqual({ resolved: [], remoteReads: 0 });
      }
  });

  it('serves its own authority and target when a scope names them', async () => {
    for (const params of [
      {
        scope: { workspaceId: 'ws', worktreeId: 'wt' },
        repository: { kind: 'checkout' },
      },
      { scope: { workspaceId: 'ws' }, repository: { kind: 'reference' } },
    ] satisfies WorkerGitBranchListParams[]) {
      const recorded: Recorded = { resolved: [], remoteReads: 0 };
      const local = { ...params.scope, authorityId: 'local-desktop' };
      await expect(
        dispatcher(host({}, recorded)).query(
          'worker.git.branch.list',
          { ...params, scope: local },
          { caller },
        ),
      ).resolves.toMatchObject({ defaultBranch: 'main' });
      expect(recorded.refReads).toBe(1);

      const targeted = { ...local, targetId: 'worker-1' };
      await expect(
        dispatcher(host({ targetId: 'worker-1' })).query(
          'worker.git.branch.list',
          { ...params, scope: targeted },
          { caller },
        ),
      ).resolves.toMatchObject({ defaultBranch: 'main' });
      await expect(
        dispatcher(host({ targetId: 'worker-1' })).query(
          'worker.git.branch.list',
          { ...params, scope: { ...targeted, targetId: 'worker-2' } },
          { caller },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
    }
  });

  it('types host scope refusals and keeps the host error as the cause', async () => {
    const hostCause = new Error('Invalid workspaceId');
    for (const [error, kind, code] of [
      [
        new WorkerGitScopeError('invalid', 'Invalid workspaceId', hostCause),
        'invalid_argument',
        'worker.git.branch.invalidScope',
      ],
      [
        new WorkerGitScopeError('unsupported', 'App-managed scope'),
        'failed_precondition',
        'worker.git.branch.scopeUnsupported',
      ],
    ] as const) {
      const failure = await dispatcher(
        host({ resolveRepository: () => Promise.reject(error) }),
      )
        .query('worker.git.branch.list', checkout, { caller })
        .catch((thrown: unknown) => thrown);
      expect(failure).toBeInstanceOf(CanopyOperationError);
      expect(failure).toMatchObject({
        payload: { kind, code, message: error.message },
      });
      if (failure instanceof CanopyOperationError)
        expect(failure.runtimeCause).toBe(error.hostCause);
    }
  });

  it('reports a workspace without a source repository as a typed precondition', async () => {
    await expect(
      dispatcher(
        host({ resolveRepository: () => Promise.resolve(null) }),
      ).query(
        'worker.git.branch.list',
        { scope: { workspaceId: 'ws' }, repository: { kind: 'reference' } },
        { caller },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'worker.git.branch.repositoryUnavailable',
      },
    });
  });

  it('fails a ref read as internal and keeps the Git error as the cause', async () => {
    const gitError = new Error('fatal: not a git repository');
    const failure = await dispatcher(
      host({
        reads: () => ({
          ...host().reads('/repo', {
            requestId: 'r',
            caller,
            metadata: {},
            signal: new AbortController().signal,
          }),
          readBranchRefs: (): Promise<string> => Promise.reject(gitError),
        }),
      }),
    )
      .query('worker.git.branch.list', checkout, { caller })
      .catch((thrown: unknown) => thrown);
    expect(failure).toMatchObject({ payload: { kind: 'internal' } });
    if (failure instanceof CanopyOperationError)
      expect(failure.runtimeCause).toBe(gitError);
    expect(JSON.stringify(failure)).not.toContain('not a git repository');
  });
});
