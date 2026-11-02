import {
  WORKER_GIT_GRANTS,
  WORKER_GIT_REMOTE_QUERY_DEFINITIONS,
  type CanopyCallerDescriptor,
  type WorkerGitRemoteGetParams,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import type { CanopyDispatcher } from '../../../runtime/types';
import { CanopyOperationError } from '../../../runtime/errors';
import { WorkerGitScopeError } from '../worker-git-branch-list';
import {
  createWorkerGitRemoteHandlers,
  type WorkerGitRemoteHost,
  type WorkerGitRemoteReads,
} from '../worker-git-remote-get';

const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'test',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [WORKER_GIT_GRANTS.read],
};

interface Recorded {
  resolved: WorkerGitRemoteGetParams[];
  reads: string[];
}

function fresh(): Recorded {
  return { resolved: [], reads: [] };
}

function host(
  reads: Partial<WorkerGitRemoteReads> = {},
  overrides: Partial<WorkerGitRemoteHost<string>> = {},
  recorded: Recorded = fresh(),
): WorkerGitRemoteHost<string> {
  return {
    authorityId: 'local-desktop',
    resolveRepository: (params): Promise<string> => {
      recorded.resolved.push(params);
      return Promise.resolve('/repo');
    },
    reads: () => ({
      readOriginUrl: (): Promise<string | null> => {
        recorded.reads.push('origin');
        return reads.readOriginUrl
          ? reads.readOriginUrl()
          : Promise.resolve('git@example.com:org/repo.git');
      },
      isRepository: (): Promise<boolean> => {
        recorded.reads.push('repository');
        return reads.isRepository
          ? reads.isRepository()
          : Promise.resolve(true);
      },
    }),
    ...overrides,
  };
}

function dispatcher(
  gitHost: WorkerGitRemoteHost<string>,
): CanopyDispatcher<typeof WORKER_GIT_REMOTE_QUERY_DEFINITIONS> {
  return createCanopyDispatcher({
    profile: 'worker',
    definitions: WORKER_GIT_REMOTE_QUERY_DEFINITIONS,
    handlers: createWorkerGitRemoteHandlers(gitHost),
  });
}

const recordedRoot: WorkerGitRemoteGetParams = {
  scope: { workspaceId: 'ws' },
  repository: { kind: 'recorded' },
};
const source: WorkerGitRemoteGetParams = {
  scope: { workspaceId: 'ws' },
  repository: { kind: 'source' },
};

async function failure(
  gitHost: WorkerGitRemoteHost<string>,
  params: WorkerGitRemoteGetParams = recordedRoot,
): Promise<unknown> {
  return dispatcher(gitHost)
    .query('worker.git.remote.get', params, { caller })
    .catch((thrown: unknown) => thrown);
}

describe('worker.git.remote.get handler', () => {
  it('reports a network origin URL without its userinfo or asking where it ran', async () => {
    for (const [url, canonical] of [
      ['example.com:org/repo.git', 'example.com:org/repo.git'],
      ['git@example.com:org/repo.git', 'example.com:org/repo.git'],
      ['https://example.com/org/repo.git', 'https://example.com/org/repo.git'],
      [
        'https://x-access-token:secret@example.com/org/repo.git',
        'https://example.com/org/repo.git',
      ],
      [
        'ssh://git@example.com:22/org/repo.git',
        'ssh://example.com:22/org/repo.git',
      ],
    ]) {
      const recorded = fresh();
      await expect(
        dispatcher(
          host({ readOriginUrl: () => Promise.resolve(url) }, {}, recorded),
        ).query('worker.git.remote.get', recordedRoot, { caller }),
      ).resolves.toEqual({
        origin: {
          state: 'configured',
          endpoint: { kind: 'network', url: canonical },
        },
      });
      expect(recorded).toEqual({
        resolved: [recordedRoot],
        reads: ['origin'],
      });
    }
  });

  it('keeps a local origin URL, which can name a host path, with the host', async () => {
    for (const url of [
      '/Users/someone/repos/origin.git',
      'file:///Users/someone/repos/origin.git',
      'C:\\repos\\origin.git',
      '../origin.git',
      'gcrypt::/Users/someone/repos/origin.git',
      'ssh:///Users/someone/repos/origin.git',
      '',
      'origin',
    ]) {
      const recorded = fresh();
      const result = await dispatcher(
        host({ readOriginUrl: () => Promise.resolve(url) }, {}, recorded),
      ).query('worker.git.remote.get', recordedRoot, { caller });
      expect(result).toEqual({
        origin: { state: 'configured', endpoint: { kind: 'local' } },
      });
      expect(JSON.stringify(result)).not.toContain('repos');
      expect(recorded).toEqual({
        resolved: [recordedRoot],
        reads: ['origin'],
      });
    }
  });

  it('reports a confirmed repository without origin as absent', async () => {
    const recorded = fresh();
    await expect(
      dispatcher(
        host({ readOriginUrl: () => Promise.resolve(null) }, {}, recorded),
      ).query('worker.git.remote.get', source, { caller }),
    ).resolves.toEqual({ origin: { state: 'absent' } });
    expect(recorded.reads).toEqual(['origin', 'repository']);
  });

  it('refuses a location without origin that is no repository, with no Git error', async () => {
    const failed = await failure(
      host({
        readOriginUrl: () => Promise.resolve(null),
        isRepository: () => Promise.resolve(false),
      }),
      source,
    );
    expect(failed).toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'worker.git.remote.notRepository',
      },
    });
    if (failed instanceof CanopyOperationError)
      expect(failed.runtimeCause).toBeUndefined();
  });

  it('types a failed read outside a repository and keeps the Git error', async () => {
    const gitError = new Error('fatal: not a git repository');
    const failed = await failure(
      host({
        readOriginUrl: () => Promise.reject(gitError),
        isRepository: () => Promise.resolve(false),
      }),
    );
    expect(failed).toBeInstanceOf(CanopyOperationError);
    expect(failed).toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'worker.git.remote.notRepository',
        retry: { kind: 'never' },
      },
    });
    if (failed instanceof CanopyOperationError)
      expect(failed.runtimeCause).toBe(gitError);
    expect(JSON.stringify(failed)).not.toContain('not a git repository');
  });

  it('fails a read inside a repository as internal and keeps the Git error', async () => {
    const gitError = new Error("fatal: bad boolean config value 'x'");
    const failed = await failure(
      host({ readOriginUrl: () => Promise.reject(gitError) }),
    );
    expect(failed).toMatchObject({
      payload: { kind: 'internal', retry: { kind: 'never' } },
    });
    expect(failed).toBeInstanceOf(CanopyOperationError);
    if (failed instanceof CanopyOperationError) {
      expect(failed.payload.code).toBeUndefined();
      expect(failed.runtimeCause).toBe(gitError);
    }
    expect(JSON.stringify(failed)).not.toContain('bad boolean');
  });

  it('denies a caller without worker.git.read before the host runs', async () => {
    const recorded = fresh();
    await expect(
      dispatcher(host({}, {}, recorded)).query(
        'worker.git.remote.get',
        recordedRoot,
        { caller: { ...caller, grants: ['worker.filesystem.read'] } },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(recorded).toEqual(fresh());
  });

  it('rejects scopes that cannot name a workspace repository', async () => {
    const recorded = fresh();
    const runtime = dispatcher(host({}, {}, recorded));
    for (const params of [
      { scope: {}, repository: { kind: 'recorded' } },
      {
        scope: { workspaceId: 'ws', worktreeId: 'wt' },
        repository: { kind: 'recorded' },
      },
      {
        scope: { workspaceId: 'ws', worktreeId: 'wt' },
        repository: { kind: 'source' },
      },
      {
        scope: { workspaceId: 'ws', repoId: 'member' },
        repository: { kind: 'source' },
      },
    ] satisfies WorkerGitRemoteGetParams[])
      await expect(
        runtime.query('worker.git.remote.get', params, { caller }),
      ).rejects.toMatchObject({
        payload: {
          kind: 'invalid_argument',
          code: 'worker.git.remote.invalidScope',
        },
      });
    expect(recorded).toEqual(fresh());
  });

  it('refuses another authority or target before resolving or reading', async () => {
    for (const params of [recordedRoot, source])
      for (const selection of [
        { authorityId: 'foreign-authority' },
        { targetId: 'remote-worker' },
        { authorityId: 'local-desktop', targetId: 'remote-worker' },
      ]) {
        const recorded = fresh();
        const failed = await failure(host({}, {}, recorded), {
          ...params,
          scope: { ...params.scope, ...selection },
        });
        expect(failed).toBeInstanceOf(CanopyOperationError);
        expect(failed).toMatchObject({
          payload: { kind: 'capability_unavailable', retry: { kind: 'never' } },
        });
        expect(recorded).toEqual(fresh());
      }
  });

  it('serves its own authority and target when a scope names them', async () => {
    const local = { ...recordedRoot.scope, authorityId: 'local-desktop' };
    await expect(
      dispatcher(host()).query(
        'worker.git.remote.get',
        { ...recordedRoot, scope: local },
        { caller },
      ),
    ).resolves.toMatchObject({ origin: { state: 'configured' } });
    await expect(
      dispatcher(host({}, { targetId: 'worker-1' })).query(
        'worker.git.remote.get',
        { ...recordedRoot, scope: { ...local, targetId: 'worker-1' } },
        { caller },
      ),
    ).resolves.toMatchObject({ origin: { state: 'configured' } });
  });

  it('types host scope refusals and keeps the host error as the cause', async () => {
    const hostCause = new Error('Invalid workspaceId');
    for (const [error, kind, code] of [
      [
        new WorkerGitScopeError('invalid', 'Invalid workspaceId', hostCause),
        'invalid_argument',
        'worker.git.remote.invalidScope',
      ],
      [
        new WorkerGitScopeError('unsupported', 'App-managed scope'),
        'failed_precondition',
        'worker.git.remote.repositoryUnavailable',
      ],
    ] as const) {
      const failed = await failure(
        host({}, { resolveRepository: () => Promise.reject(error) }),
      );
      expect(failed).toMatchObject({
        payload: { kind, code, message: error.message },
      });
      if (failed instanceof CanopyOperationError)
        expect(failed.runtimeCause).toBe(error.hostCause);
    }
  });

  it('reports a missing repository record before running Git', async () => {
    const recorded = fresh();
    const failed = await failure(
      host({}, { resolveRepository: () => Promise.resolve(null) }, recorded),
      source,
    );
    expect(failed).toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'worker.git.remote.repositoryUnavailable',
      },
    });
    expect(recorded.reads).toEqual([]);
  });

  it('fails an unexpected resolver error as internal with its cause', async () => {
    const hostError = new Error('index unreadable');
    const failed = await failure(
      host({}, { resolveRepository: () => Promise.reject(hostError) }),
    );
    expect(failed).toMatchObject({ payload: { kind: 'internal' } });
    if (failed instanceof CanopyOperationError)
      expect(failed.runtimeCause).toBe(hostError);
  });
});
