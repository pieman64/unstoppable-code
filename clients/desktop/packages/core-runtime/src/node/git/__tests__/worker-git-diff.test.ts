import {
  WORKER_GIT_DIFF_QUERY_DEFINITIONS,
  WORKER_GIT_GRANTS,
  type CanopyCallerDescriptor,
  type WorkerGitDiffGetParams,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import type { CanopyDispatcher } from '../../../runtime/types';
import { CanopyOperationError } from '../../../runtime/errors';
import type {
  GitChangeSetRead,
  GitChangeSetSample,
  GitUntrackedEstimate,
} from '../change-set';
import { WorkerGitScopeError } from '../worker-git-branch-list';
import {
  createWorkerGitDiffHandlers,
  workerGitDiffRange,
  type WorkerGitDiffHost,
} from '../worker-git-diff';

const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'test',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [WORKER_GIT_GRANTS.read],
};

const OID = 'a'.repeat(40);
const OID_256 = 'b'.repeat(64);

/** Canned `-z` output for one renamed, one modified and one untracked file. */
const OUTPUT: Record<GitChangeSetRead['kind'], string> = {
  'diff-name-status': 'R090\0src/a.ts\0src/b.ts\0M\0/etc/x\0',
  'diff-numstat': '2\t1\t\0src/a.ts\0src/b.ts\0' + '1\t0\t/etc/x\0',
  'untracked-files': 'new.txt\0',
  'unmerged-files': '',
  'object-exists': '',
};

interface Recorded {
  resolved: WorkerGitDiffGetParams[];
  reads: GitChangeSetRead[];
  observed: GitChangeSetSample[];
}

function host(
  recorded: Recorded,
  overrides: Partial<WorkerGitDiffHost<string>> = {},
): WorkerGitDiffHost<string> {
  return {
    authorityId: 'local-desktop',
    resolveRepository: (params): Promise<string> => {
      recorded.resolved.push(params);
      return Promise.resolve('/host/ws/wt');
    },
    reads: () => ({
      read: (read): Promise<string> => {
        recorded.reads.push(read);
        return Promise.resolve(OUTPUT[read.kind]);
      },
      estimateUntracked: (paths) =>
        Promise.resolve(paths.map(() => ({ insertions: 3, binary: false }))),
    }),
    observe: (_repository, sample) => recorded.observed.push(sample),
    ...overrides,
  };
}

function dispatcher(
  gitHost: WorkerGitDiffHost<string>,
): CanopyDispatcher<typeof WORKER_GIT_DIFF_QUERY_DEFINITIONS> {
  return createCanopyDispatcher({
    profile: 'worker',
    definitions: WORKER_GIT_DIFF_QUERY_DEFINITIONS,
    handlers: createWorkerGitDiffHandlers(gitHost),
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
const params: WorkerGitDiffGetParams = {
  scope,
  repoId: '__workspace_root__',
  base: 'HEAD',
  head: 'WORKTREE',
};

const fresh = (): Recorded => ({ resolved: [], reads: [], observed: [] });

function refusalOf(read: () => unknown): CanopyOperationError['payload'] {
  try {
    read();
  } catch (error) {
    if (error instanceof CanopyOperationError) return error.payload;
    throw error;
  }
  throw new Error('Expected a refusal');
}

describe('workerGitDiffRange', () => {
  it('reads the served ranges', () => {
    expect(workerGitDiffRange('HEAD', 'WORKTREE')).toEqual({
      kind: 'worktree',
      base: 'HEAD',
    });
    expect(workerGitDiffRange(OID, 'WORKTREE')).toEqual({
      kind: 'worktree',
      base: OID,
    });
    expect(workerGitDiffRange(OID, 'HEAD')).toEqual({
      kind: 'objects',
      base: OID,
      head: 'HEAD',
    });
    expect(workerGitDiffRange(OID, OID_256)).toEqual({
      kind: 'objects',
      base: OID,
      head: OID_256,
    });
  });

  it('refuses pairs outside the vocabulary', () => {
    for (const [base, head] of [
      ['HEAD', 'HEAD'],
      ['HEAD', OID],
      ['WORKTREE', 'HEAD'],
      ['', 'WORKTREE'],
      ['main', OID],
      [OID, 'main'],
      [OID, 'HEAD~1'],
      [OID, OID.toUpperCase()],
    ])
      expect(refusalOf(() => workerGitDiffRange(base, head))).toMatchObject({
        kind: 'invalid_argument',
        code: 'worker.git.diff.invalidRange',
      });
  });

  it('refuses a branch base as unserved, hex-like names included', () => {
    for (const [base, head] of [
      ['main', 'HEAD'],
      ['main', 'WORKTREE'],
      [OID.toUpperCase(), 'HEAD'],
      [OID.slice(1), 'WORKTREE'],
    ])
      expect(refusalOf(() => workerGitDiffRange(base, head))).toMatchObject({
        kind: 'capability_unavailable',
      });
  });
});

describe('worker.git.diff.get handler', () => {
  it('returns raw paths, counts and statuses and lets the host observe the reads', async () => {
    const recorded = fresh();
    const result = await dispatcher(host(recorded)).query(
      'worker.git.diff.get',
      params,
      { caller },
    );
    expect(result).toEqual({
      truncated: false,
      files: [
        {
          path: '/etc/x',
          previousPath: null,
          status: 'modified',
          additions: 1,
          deletions: 0,
          patch: null,
        },
        {
          path: 'new.txt',
          previousPath: null,
          status: 'untracked',
          additions: 3,
          deletions: 0,
          patch: null,
        },
        {
          path: 'src/b.ts',
          previousPath: 'src/a.ts',
          status: 'renamed',
          additions: 2,
          deletions: 1,
          patch: null,
        },
      ],
    });
    expect(recorded.resolved).toEqual([params]);
    expect(recorded.observed).toEqual([
      expect.objectContaining({ range: { kind: 'worktree', base: 'HEAD' } }),
    ]);
    expect(JSON.stringify(result)).not.toContain('/host');
  });

  it('refuses another authority, any target and a mismatched repository before resolving', async () => {
    const recorded = fresh();
    const gitDispatcher = dispatcher(host(recorded));
    const cases: Array<[WorkerGitDiffGetParams, string]> = [
      [
        { ...params, scope: { ...scope, authorityId: 'other' } },
        'capability_unavailable',
      ],
      [
        { ...params, scope: { ...scope, targetId: 'in_process_worker' } },
        'capability_unavailable',
      ],
      [{ ...params, scope: { ...scope, repoId: 'alpha' } }, 'invalid_argument'],
      [{ ...params, base: 'main' }, 'capability_unavailable'],
      [{ ...params, head: 'HEAD' }, 'invalid_argument'],
      [{ ...params, contextLines: 3 }, 'capability_unavailable'],
      // This host reads no patches.
      [{ ...params, paths: ['src/b.ts'] }, 'capability_unavailable'],
    ];
    for (const [request, kind] of cases)
      expect(
        (
          await failure(
            gitDispatcher.query('worker.git.diff.get', request, { caller }),
          )
        ).payload.kind,
      ).toBe(kind);
    expect(recorded.resolved).toEqual([]);
    expect(recorded.reads).toEqual([]);
  });

  it('patches only the named files when the host reads patches', async () => {
    const recorded = fresh();
    const patchReads: unknown[] = [];
    const result = await dispatcher(
      host(recorded, {
        patchReads: () => ({
          readPatch: (
            read,
          ): Promise<{ data: Uint8Array; truncated: boolean }> => {
            patchReads.push(read);
            return Promise.resolve({
              data: Buffer.from('diff --git a/src/a.ts b/src/b.ts\n'),
              truncated: false,
            });
          },
          readUntracked: (): Promise<null> => Promise.resolve(null),
        }),
      }),
    ).query(
      'worker.git.diff.get',
      { ...params, paths: ['src/a.ts', 'missing.txt'] },
      { caller },
    );
    expect(result).toEqual({
      truncated: false,
      files: [
        {
          path: 'src/b.ts',
          previousPath: 'src/a.ts',
          status: 'renamed',
          additions: 2,
          deletions: 1,
          patch: 'diff --git a/src/a.ts b/src/b.ts\n',
        },
      ],
    });
    expect(patchReads).toEqual([
      {
        range: { kind: 'worktree', base: 'HEAD' },
        paths: ['src/a.ts', 'src/b.ts'],
      },
    ]);
    const empty = await dispatcher(
      host(fresh(), {
        patchReads: () => ({
          readPatch: (): Promise<never> => Promise.reject(new Error('unused')),
          readUntracked: (): Promise<never> =>
            Promise.reject(new Error('unused')),
        }),
      }),
    ).query('worker.git.diff.get', { ...params, paths: [] }, { caller });
    expect(empty).toEqual({ files: [], truncated: false });
  });

  it('accepts a scope repository equal to repoId', async () => {
    const recorded = fresh();
    await dispatcher(host(recorded)).query(
      'worker.git.diff.get',
      { ...params, scope: { ...scope, repoId: '__workspace_root__' } },
      { caller },
    );
    expect(recorded.resolved).toHaveLength(1);
  });

  it('maps host scope refusals and an unlocated repository to typed codes', async () => {
    const hostCause = new Error('Invalid workspaceId');
    for (const [reason, kind, code] of [
      ['invalid', 'invalid_argument', 'worker.git.diff.invalidScope'],
      [
        'unsupported',
        'failed_precondition',
        'worker.git.diff.scopeUnsupported',
      ],
    ] as const) {
      const error = await failure(
        dispatcher(
          host(fresh(), {
            resolveRepository: () =>
              Promise.reject(
                new WorkerGitScopeError(reason, 'refused', hostCause),
              ),
          }),
        ).query('worker.git.diff.get', params, { caller }),
      );
      expect(error.payload).toMatchObject({ kind, code });
      expect(error.runtimeCause).toBe(hostCause);
    }
    const recorded = fresh();
    const missing = await failure(
      dispatcher(
        host(recorded, { resolveRepository: () => Promise.resolve(null) }),
      ).query('worker.git.diff.get', params, { caller }),
    );
    expect(missing.payload).toMatchObject({
      kind: 'not_found',
      code: 'worker.git.diff.notFound',
    });
    expect(recorded.reads).toEqual([]);
  });

  it('lets the host observe a failed comparison before the typed error', async () => {
    const recorded = fresh();
    const gitFailure = Object.assign(new Error('unknown revision'), {
      code: 128,
    });
    const error = await failure(
      dispatcher(
        host(recorded, {
          reads: () => ({
            read: (read): Promise<string> => {
              recorded.reads.push(read);
              if (read.kind === 'object-exists')
                return Promise.reject(Object.assign(new Error(), { code: 1 }));
              return read.kind.startsWith('diff-')
                ? Promise.reject(gitFailure)
                : Promise.resolve(OUTPUT[read.kind]);
            },
            estimateUntracked: (paths): Promise<GitUntrackedEstimate[]> =>
              Promise.resolve(
                paths.map(() => ({ insertions: 0, binary: false })),
              ),
          }),
        }),
      ).query('worker.git.diff.get', params, { caller }),
    );
    expect(error.payload).toMatchObject({
      kind: 'failed_precondition',
      code: 'worker.git.diff.invalidState',
    });
    expect(error.runtimeCause).toBe(gitFailure);
    expect(recorded.observed).toEqual([
      expect.objectContaining({
        nameStatus: { ok: false, error: gitFailure },
        untracked: { ok: true, stdout: 'new.txt\0' },
      }),
    ]);
  });

  it('refuses a result past the frame budget', async () => {
    const name = 'x'.repeat(4_000);
    const many = Array.from({ length: 2_200 }, (_, index) => `${name}${index}`);
    const error = await failure(
      dispatcher(
        host(fresh(), {
          reads: () => ({
            read: (read): Promise<string> =>
              Promise.resolve(
                read.kind === 'diff-name-status'
                  ? many.map((path) => `M\0${path}\0`).join('')
                  : '',
              ),
            estimateUntracked: (): Promise<GitUntrackedEstimate[]> =>
              Promise.resolve([]),
          }),
        }),
      ).query('worker.git.diff.get', params, { caller }),
    );
    expect(error.payload.kind).toBe('resource_exhausted');
  });

  it('denies a caller without worker.git.read before the handler', async () => {
    const recorded = fresh();
    expect(
      (
        await failure(
          dispatcher(host(recorded)).query('worker.git.diff.get', params, {
            caller: { ...caller, grants: [] },
          }),
        )
      ).payload.kind,
    ).toBe('permission_denied');
    expect(recorded.resolved).toEqual([]);
  });
});
