import {
  WORKER_GIT_GRANTS,
  WORKER_GIT_WORKTREE_HEALTH_QUERY_DEFINITIONS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import type { CanopyDispatcher } from '../../../runtime/types';
import { CanopyOperationError } from '../../../runtime/errors';
import { WorkerGitScopeError } from '../worker-git-branch-list';
import {
  createWorkerGitWorktreeHealthHandlers,
  toWorkerGitWorktreeHealthResult,
  type WorkerGitWorktreeHealthHost,
} from '../worker-git-worktree-health';
import type {
  WorktreeHealthIssue,
  WorktreeHealthSources,
} from '../worktree-health';

const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'test',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [WORKER_GIT_GRANTS.read],
};

const NOW = new Date('2026-10-27T12:00:00.000Z');

/** A missing multi-repository root: the check reads nothing else. */
function missingRoot(path: string): WorktreeHealthSources {
  const absent = (): Promise<never> => Promise.reject(new Error('ENOENT'));
  return {
    worktreePath: path,
    readWorkspace: () =>
      Promise.resolve({
        type: 'multi-repo',
        repos: [],
        hasSourceRepository: false,
      }),
    listRepositoryEntries: () => Promise.resolve([]),
    readIncludedRepoIds: () => Promise.resolve(undefined),
    stat: absent,
    lstat: absent,
    readText: absent,
    confirmWorkTree: absent,
    now: () => NOW,
  };
}

interface Recorded {
  resolved: string[];
  observed: Array<WorktreeHealthIssue | null>;
}

function host(
  recorded: Recorded,
  overrides: Partial<WorkerGitWorktreeHealthHost<string>> = {},
): WorkerGitWorktreeHealthHost<string> {
  return {
    authorityId: 'local-desktop',
    resolveWorktree: ({ scope }): Promise<string> => {
      recorded.resolved.push(`${scope.workspaceId}/${scope.worktreeId}`);
      return Promise.resolve(`/host/${scope.workspaceId}/${scope.worktreeId}`);
    },
    sources: (path) => missingRoot(path),
    observe: (_path, issue) => recorded.observed.push(issue),
    ...overrides,
  };
}

function dispatcher(
  gitHost: WorkerGitWorktreeHealthHost<string>,
): CanopyDispatcher<typeof WORKER_GIT_WORKTREE_HEALTH_QUERY_DEFINITIONS> {
  return createCanopyDispatcher({
    profile: 'worker',
    definitions: WORKER_GIT_WORKTREE_HEALTH_QUERY_DEFINITIONS,
    handlers: createWorkerGitWorktreeHealthHandlers(gitHost),
  });
}

async function failure(
  promise: Promise<unknown>,
): Promise<CanopyOperationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CanopyOperationError) return error;
    throw error;
  }
  throw new Error('Expected the query to fail');
}

const scope = { workspaceId: 'ws', worktreeId: 'wt' };

describe('worker.git.worktree.health.get handler', () => {
  it('returns codes only and lets the host observe its full issue', async () => {
    const recorded: Recorded = { resolved: [], observed: [] };
    const result = await dispatcher(host(recorded)).query(
      'worker.git.worktree.health.get',
      { scope },
      { caller },
    );
    expect(result).toEqual({
      healthy: false,
      issue: {
        code: 'missing-worktree-path',
        checkedAt: NOW.toISOString(),
        repoIssues: null,
      },
    });
    expect(recorded.resolved).toEqual(['ws/wt']);
    expect(recorded.observed).toEqual([
      expect.objectContaining({ worktreePath: '/host/ws/wt' }),
    ]);
    expect(JSON.stringify(result)).not.toContain('/host');
  });

  it('refuses another authority or any target before resolving', async () => {
    const recorded: Recorded = { resolved: [], observed: [] };
    const gitDispatcher = dispatcher(host(recorded));
    for (const selection of [
      { authorityId: 'other' },
      { targetId: 'in_process_worker' },
    ])
      expect(
        (
          await failure(
            gitDispatcher.query(
              'worker.git.worktree.health.get',
              { scope: { ...scope, ...selection } },
              { caller },
            ),
          )
        ).payload.kind,
      ).toBe('capability_unavailable');
    expect(recorded.resolved).toEqual([]);
  });

  it('maps host scope refusals to typed codes with the host cause', async () => {
    const hostCause = new Error('Invalid workspaceId');
    for (const [reason, kind, code] of [
      ['invalid', 'invalid_argument', 'worker.git.worktree.invalidScope'],
      [
        'unsupported',
        'failed_precondition',
        'worker.git.worktree.scopeUnsupported',
      ],
    ] as const) {
      const error = await failure(
        dispatcher(
          host(
            { resolved: [], observed: [] },
            {
              resolveWorktree: () =>
                Promise.reject(
                  new WorkerGitScopeError(reason, 'refused', hostCause),
                ),
            },
          ),
        ).query('worker.git.worktree.health.get', { scope }, { caller }),
      );
      expect(error.payload).toMatchObject({ kind, code });
      expect(error.runtimeCause).toBe(hostCause);
    }
  });

  it('fails a host error as internal, keeping it as the runtime cause', async () => {
    const hostFailure = new Error('records unreadable');
    const recorded: Recorded = { resolved: [], observed: [] };
    const error = await failure(
      dispatcher(
        host(recorded, {
          sources: (path) => ({
            ...missingRoot(path),
            readWorkspace: (): Promise<never> => Promise.reject(hostFailure),
          }),
        }),
      ).query('worker.git.worktree.health.get', { scope }, { caller }),
    );
    expect(error.payload.kind).toBe('internal');
    expect(error.runtimeCause).toBe(hostFailure);
    expect(recorded.observed).toEqual([]);
  });

  it('denies a caller without worker.git.read before the handler', async () => {
    const recorded: Recorded = { resolved: [], observed: [] };
    expect(
      (
        await failure(
          dispatcher(host(recorded)).query(
            'worker.git.worktree.health.get',
            { scope },
            { caller: { ...caller, grants: [] } },
          ),
        )
      ).payload.kind,
    ).toBe('permission_denied');
    expect(recorded.resolved).toEqual([]);
  });
});

describe('toWorkerGitWorktreeHealthResult', () => {
  it('keeps repository ids and codes and drops paths, names and messages', () => {
    expect(toWorkerGitWorktreeHealthResult(null)).toEqual({ healthy: true });
    expect(
      toWorkerGitWorktreeHealthResult({
        status: 'broken',
        code: 'missing-repository',
        message: 'One or more repositories in this project are missing.',
        checkedAt: NOW.toISOString(),
        worktreePath: '/host/ws/wt',
        gitError: 'Missing gitdir target: /host/admin',
        repoIssues: [
          {
            repoId: 'alpha',
            repoName: 'Alpha',
            repoPath: '/host/ws/wt/repos/alpha',
            code: 'missing-repository',
            message: 'Repository directory is missing from this worktree.',
          },
          {
            repoId: '__workspace_root__',
            repoName: 'Project root',
            repoPath: '/host/ws/wt',
            code: 'invalid-git-worktree',
            message: 'x',
            gitError: 'Missing gitdir target: /host/admin',
          },
        ],
      }),
    ).toEqual({
      healthy: false,
      issue: {
        code: 'missing-repository',
        checkedAt: NOW.toISOString(),
        repoIssues: [
          { repoId: 'alpha', code: 'missing-repository' },
          { repoId: '__workspace_root__', code: 'invalid-git-worktree' },
        ],
      },
    });
  });
});
