import {
  WORKER_GIT_CHANGE_QUERY_DEFINITIONS,
  WORKER_GIT_DIFF_FILE_STATUSES,
  WORKER_GIT_DIFF_QUERY_DEFINITIONS,
  WORKER_GIT_GRANTS,
  WORKER_GIT_STATUS_QUERY_DEFINITIONS,
  WorkerGitDiffGetErrorSchema,
  WorkerGitDiffGetParamsSchema,
  WorkerGitDiffGetResultSchema,
  type WorkerGitDiffFileStatus,
} from '../index';
import type { CloudSessionGitChangedFile } from '../../cloud-session';

const file = {
  path: 'src/b.ts',
  previousPath: 'src/a.ts',
  status: 'renamed',
  additions: 1,
  deletions: 0,
  patch: null,
};

describe('worker.git.diff.get contract', () => {
  it('is its own family partition, which the web change registry includes', () => {
    expect(Object.keys(WORKER_GIT_DIFF_QUERY_DEFINITIONS)).toEqual([
      'worker.git.diff.get',
    ]);
    expect(Object.keys(WORKER_GIT_STATUS_QUERY_DEFINITIONS)).toEqual([
      'worker.git.status.get',
    ]);
    expect(WORKER_GIT_CHANGE_QUERY_DEFINITIONS['worker.git.diff.get']).toBe(
      WORKER_GIT_DIFF_QUERY_DEFINITIONS['worker.git.diff.get'],
    );
    expect(WORKER_GIT_CHANGE_QUERY_DEFINITIONS['worker.git.status.get']).toBe(
      WORKER_GIT_STATUS_QUERY_DEFINITIONS['worker.git.status.get'],
    );
    expect(
      WORKER_GIT_DIFF_QUERY_DEFINITIONS['worker.git.diff.get'],
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

  it('keeps the params the web core accepts and rejects host paths', () => {
    for (const params of [
      { scope: {}, repoId: 'r', base: 'HEAD', head: 'WORKTREE' },
      {
        scope: { workspaceId: 'ws', worktreeId: 'wt', repoId: 'r' },
        repoId: 'r',
        base: 'a'.repeat(40),
        head: 'HEAD',
        paths: ['src/a.ts'],
      },
    ])
      expect(WorkerGitDiffGetParamsSchema.parse(params)).toEqual(params);
    for (const params of [
      { scope: {}, base: 'HEAD', head: 'WORKTREE' },
      { scope: {}, repoId: 'r', base: 'HEAD', head: 'WORKTREE', cwd: '/wt' },
      { scope: { path: '/wt' }, repoId: 'r', base: 'HEAD', head: 'WORKTREE' },
    ])
      expect(WorkerGitDiffGetParamsSchema.safeParse(params).success).toBe(
        false,
      );
  });

  it("lists every status the web core relays from Cloud's change sets", () => {
    // Compiles only while each Cloud status is in the spec's vocabulary.
    const relayed = (
      status: CloudSessionGitChangedFile['status'],
    ): WorkerGitDiffFileStatus => status;
    for (const status of [
      'added',
      'modified',
      'deleted',
      'renamed',
      'copied',
      'type_changed',
      'untracked',
    ] satisfies CloudSessionGitChangedFile['status'][])
      expect(WORKER_GIT_DIFF_FILE_STATUSES).toContain(relayed(status));
    // The schema keeps CAN-4158's string; the vocabulary is the spec's.
    for (const status of [...WORKER_GIT_DIFF_FILE_STATUSES, 'type-changed'])
      expect(
        WorkerGitDiffGetResultSchema.safeParse({
          files: [{ ...file, status }],
          truncated: false,
        }).success,
      ).toBe(true);
  });

  it('accepts the binary and staged flags and additive fields', () => {
    const result = {
      files: [{ ...file, binary: true, staged: false, futureField: 'kept' }],
      truncated: true,
      futureTotal: 3,
    };
    expect(WorkerGitDiffGetResultSchema.parse(result)).toEqual(result);
    expect(
      WorkerGitDiffGetResultSchema.safeParse({
        files: [{ ...file, binary: 'yes' }],
        truncated: false,
      }).success,
    ).toBe(false);
    expect(
      WorkerGitDiffGetResultSchema.safeParse({
        files: [{ ...file, patch: 'x'.repeat(8_000_001) }],
        truncated: false,
      }).success,
    ).toBe(false);
  });

  it('names the desktop error codes', () => {
    for (const code of [
      'worker.git.diff.invalidScope',
      'worker.git.diff.scopeUnsupported',
      'worker.git.diff.invalidRange',
      'worker.git.diff.invalidState',
      'worker.git.diff.notFound',
    ])
      expect(
        WorkerGitDiffGetErrorSchema.safeParse({
          kind: 'invalid_argument',
          code,
          message: 'refused',
          retry: { kind: 'never' },
        }).success,
      ).toBe(true);
  });
});
