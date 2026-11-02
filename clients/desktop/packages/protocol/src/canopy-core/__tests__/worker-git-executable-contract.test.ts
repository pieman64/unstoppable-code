import {
  CANOPY_QUERY_DEFINITIONS,
  WORKER_GIT_EXECUTABLE_QUERY_DEFINITIONS,
  WORKER_GIT_GRANTS,
  WorkerGitExecutableGetErrorSchema,
  WorkerGitExecutableGetParamsSchema,
  WorkerGitExecutableGetResultSchema,
} from '../index';

const ready = {
  platform: 'darwin',
  required: true,
  ready: true,
  version: 'git version 2.47.1',
  source: 'auto-detected',
  wingetAvailable: false,
  checkedAt: '2026-10-26T12:00:00.000Z',
  issue: null,
};

describe('worker.git.executable.get contract', () => {
  it('is a worker-plane Git read registered in the universal catalog', () => {
    expect(Object.keys(WORKER_GIT_EXECUTABLE_QUERY_DEFINITIONS)).toEqual([
      'worker.git.executable.get',
    ]);
    expect(CANOPY_QUERY_DEFINITIONS['worker.git.executable.get']).toBe(
      WORKER_GIT_EXECUTABLE_QUERY_DEFINITIONS['worker.git.executable.get'],
    );
    expect(
      WORKER_GIT_EXECUTABLE_QUERY_DEFINITIONS['worker.git.executable.get'],
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

  it('selects only an authority and target, never a path or workspace', () => {
    for (const params of [
      { scope: {}, recheck: false },
      { scope: { authorityId: 'local-desktop' }, recheck: true },
      { scope: { authorityId: 'a', targetId: 't' }, recheck: false },
    ])
      expect(WorkerGitExecutableGetParamsSchema.parse(params)).toEqual(params);
    for (const params of [
      { scope: {} },
      { recheck: false },
      { scope: {}, recheck: 'yes' },
      { scope: { workspaceId: 'ws' }, recheck: false },
      { scope: {}, recheck: false, path: '/usr/bin/git' },
      { scope: { path: '/usr/bin/git' }, recheck: false },
    ])
      expect(WorkerGitExecutableGetParamsSchema.safeParse(params).success).toBe(
        false,
      );
  });

  it('closes the result to codes and facts, with no path or message', () => {
    expect(WorkerGitExecutableGetResultSchema.parse(ready)).toEqual(ready);
    const missing = {
      ...ready,
      ready: false,
      version: null,
      source: 'not-found',
      issue: 'candidate-unusable',
    };
    expect(WorkerGitExecutableGetResultSchema.parse(missing)).toEqual(missing);
    for (const result of [
      { ...ready, path: '/opt/homebrew/bin/git' },
      { ...ready, error: 'Git executable does not exist' },
      { ...ready, source: 'path' },
      { ...ready, issue: 'broken' },
      { ...ready, checkedAt: 'yesterday' },
      { ...ready, platform: '' },
      Object.fromEntries(
        Object.entries(ready).filter(([key]) => key !== 'issue'),
      ),
    ])
      expect(WorkerGitExecutableGetResultSchema.safeParse(result).success).toBe(
        false,
      );
  });

  it('declares only the detection failure code', () => {
    expect(
      WorkerGitExecutableGetErrorSchema.safeParse({
        kind: 'internal',
        code: 'worker.git.executable.detectionFailed',
        message: 'Git executable detection failed.',
        retry: { kind: 'never' },
      }).success,
    ).toBe(true);
    expect(
      WorkerGitExecutableGetErrorSchema.safeParse({
        kind: 'failed_precondition',
        code: 'worker.git.branch.invalidScope',
        message: 'refused',
        retry: { kind: 'never' },
      }).success,
    ).toBe(false);
  });
});
