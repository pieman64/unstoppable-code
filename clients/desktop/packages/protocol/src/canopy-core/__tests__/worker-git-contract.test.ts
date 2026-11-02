import {
  CANOPY_QUERY_DEFINITIONS,
  WORKER_GIT_GRANTS,
  WORKER_GIT_QUERY_DEFINITIONS,
  WORKER_GIT_REMOTE_QUERY_DEFINITIONS,
  WorkerGitBranchListErrorSchema,
  WorkerGitBranchListParamsSchema,
  WorkerGitBranchListResultSchema,
  WorkerGitRemoteGetErrorSchema,
  WorkerGitRemoteGetParamsSchema,
  WorkerGitRemoteGetResultSchema,
  gitRemoteEndpoint,
  isNetworkGitRemoteUrl,
} from '../index';

const branch = {
  name: 'main',
  isRemote: false,
  isCurrent: true,
  isUsedByWorktree: false,
  hasLocalRef: true,
  hasRemoteRef: true,
};

describe('worker.git.branch.list contract', () => {
  it('is a worker-plane read registered in the universal catalog', () => {
    expect(Object.keys(WORKER_GIT_QUERY_DEFINITIONS)).toEqual([
      'worker.git.branch.list',
    ]);
    expect(CANOPY_QUERY_DEFINITIONS['worker.git.branch.list']).toBe(
      WORKER_GIT_QUERY_DEFINITIONS['worker.git.branch.list'],
    );
    expect(
      WORKER_GIT_QUERY_DEFINITIONS['worker.git.branch.list'],
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

  it('targets repositories by scope and kind, never by path', () => {
    for (const repository of [{ kind: 'checkout' }, { kind: 'reference' }])
      expect(
        WorkerGitBranchListParamsSchema.parse({
          scope: { workspaceId: 'ws', worktreeId: 'wt', repoId: 'repo' },
          repository,
        }),
      ).toEqual({
        scope: { workspaceId: 'ws', worktreeId: 'wt', repoId: 'repo' },
        repository,
      });
    for (const params of [
      { scope: { workspaceId: 'ws' } },
      { scope: { workspaceId: 'ws' }, repository: { kind: 'path' } },
      {
        scope: { workspaceId: 'ws' },
        repository: { kind: 'checkout', path: '/repo' },
      },
      {
        scope: { workspaceId: 'ws', path: '/repo' },
        repository: { kind: 'checkout' },
      },
      {
        scope: { workspaceId: 'ws' },
        repository: { kind: 'reference' },
        defaultBranch: 'main',
      },
    ])
      expect(WorkerGitBranchListParamsSchema.safeParse(params).success).toBe(
        false,
      );
  });

  it('closes the result to branch facts and a labelled default', () => {
    expect(
      WorkerGitBranchListResultSchema.parse({
        branches: [branch],
        defaultBranch: 'main',
        defaultBranchSource: 'remote',
      }),
    ).toEqual({
      branches: [branch],
      defaultBranch: 'main',
      defaultBranchSource: 'remote',
    });
    expect(
      WorkerGitBranchListResultSchema.parse({
        branches: [],
        defaultBranch: null,
        defaultBranchSource: null,
      }),
    ).toEqual({ branches: [], defaultBranch: null, defaultBranchSource: null });
    for (const result of [
      { branches: [branch], defaultBranch: 'main' },
      {
        branches: [{ ...branch, headSha: 'abc' }],
        defaultBranch: null,
        defaultBranchSource: null,
      },
      {
        branches: [],
        defaultBranch: 'main',
        defaultBranchSource: 'guess',
      },
      {
        branches: [],
        defaultBranch: null,
        defaultBranchSource: null,
        repoPath: '/repo',
      },
    ])
      expect(WorkerGitBranchListResultSchema.safeParse(result).success).toBe(
        false,
      );
  });

  it('declares only the branch-list error codes', () => {
    for (const code of [
      'worker.git.branch.invalidScope',
      'worker.git.branch.scopeUnsupported',
      'worker.git.branch.repositoryUnavailable',
    ])
      expect(
        WorkerGitBranchListErrorSchema.safeParse({
          kind: 'failed_precondition',
          code,
          message: 'refused',
          retry: { kind: 'never' },
        }).success,
      ).toBe(true);
    expect(
      WorkerGitBranchListErrorSchema.safeParse({
        kind: 'not_found',
        code: 'worker.git.branch.notFound',
        message: 'refused',
        retry: { kind: 'never' },
      }).success,
    ).toBe(false);
  });
});

describe('worker.git.remote.get contract', () => {
  it('is a worker-plane read registered in the universal catalog', () => {
    expect(Object.keys(WORKER_GIT_REMOTE_QUERY_DEFINITIONS)).toEqual([
      'worker.git.remote.get',
    ]);
    expect(CANOPY_QUERY_DEFINITIONS['worker.git.remote.get']).toBe(
      WORKER_GIT_REMOTE_QUERY_DEFINITIONS['worker.git.remote.get'],
    );
    expect(
      WORKER_GIT_REMOTE_QUERY_DEFINITIONS['worker.git.remote.get'],
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

  it('selects workspace repositories by kind, never by path', () => {
    for (const params of [
      { scope: { workspaceId: 'ws' }, repository: { kind: 'recorded' } },
      {
        scope: { workspaceId: 'ws', repoId: 'member' },
        repository: { kind: 'recorded' },
      },
      { scope: { workspaceId: 'ws' }, repository: { kind: 'source' } },
    ])
      expect(WorkerGitRemoteGetParamsSchema.parse(params)).toEqual(params);
    for (const params of [
      { scope: { workspaceId: 'ws' } },
      { scope: { workspaceId: 'ws' }, repository: { kind: 'checkout' } },
      { scope: { workspaceId: 'ws' }, repository: { kind: 'reference' } },
      {
        scope: { workspaceId: 'ws' },
        repository: { kind: 'recorded', path: '/repo' },
      },
      {
        scope: { workspaceId: 'ws', path: '/repo' },
        repository: { kind: 'recorded' },
      },
      {
        scope: { workspaceId: 'ws' },
        repository: { kind: 'source' },
        repoPath: '/repo',
      },
    ])
      expect(WorkerGitRemoteGetParamsSchema.safeParse(params).success).toBe(
        false,
      );
  });

  it('closes the result to the origin fact', () => {
    const network = (url: string): object => ({
      origin: { state: 'configured', endpoint: { kind: 'network', url } },
    });
    for (const result of [
      network('example.com:org/repo.git'),
      network('https://example.com/org/repo.git'),
      { origin: { state: 'configured', endpoint: { kind: 'local' } } },
      { origin: { state: 'absent' } },
    ])
      expect(WorkerGitRemoteGetResultSchema.parse(result)).toEqual(result);
    for (const result of [
      {},
      { origin: null },
      { origin: { state: 'configured' } },
      { origin: { state: 'configured', url: 'git@example.com:org/repo.git' } },
      { origin: { state: 'configured', endpoint: { kind: 'network' } } },
      {
        origin: {
          state: 'configured',
          endpoint: { kind: 'local', url: '/repo.git' },
        },
      },
      { origin: { state: 'absent', endpoint: { kind: 'local' } } },
      { origin: { state: 'unknown' } },
      { origin: { state: 'absent' }, repoPath: '/repo' },
      {
        origin: {
          state: 'configured',
          endpoint: { kind: 'network', url: 'example.com:o/r.git' },
          pushUrl: 'y',
        },
      },
    ])
      expect(WorkerGitRemoteGetResultSchema.safeParse(result).success).toBe(
        false,
      );
  });

  const rejectsAsNetwork = (url: string): void => {
    expect(
      WorkerGitRemoteGetResultSchema.safeParse({
        origin: { state: 'configured', endpoint: { kind: 'network', url } },
      }).success,
    ).toBe(false);
  };

  it('never carries a local remote URL, which can name a host path', () => {
    for (const url of [
      '/Users/someone/repos/origin.git',
      '../origin.git',
      './dir:with-colon',
      '\\\\server\\share\\origin.git',
      'C:\\repos\\origin.git',
      'c:/repos/origin.git',
      'file:///Users/someone/repos/origin.git',
      'FILE:///C:/repos/origin.git',
      'file:/Users/someone/repos/origin.git',
      'gcrypt::/Users/someone/repos/origin.git',
      'ext::git-remote-helper %S',
      'custom:///Users/someone/repos/origin.git',
      'ssh:///Users/someone/repos/origin.git',
      'git://user@/Users/someone/repos/origin.git',
      'https://:443/Users/someone/repos/origin.git',
      ':no-host',
      '',
      ' ',
      'origin',
    ]) {
      expect(isNetworkGitRemoteUrl(url)).toBe(false);
      expect(gitRemoteEndpoint(url)).toEqual({ kind: 'local' });
      rejectsAsNetwork(url);
    }
  });

  it('carries network remote URLs as Git prints them', () => {
    for (const url of [
      'example.com:org/repo.git',
      'host:/srv/repo.git',
      '[::1]:repo.git',
      'HTTP://example.com/org/repo.git',
      'ssh://example.com:22/org/repo.git',
      'git+ssh://example.com/org/repo.git',
      'ssh+git://example.com/org/repo.git',
      'git://example.com/org/repo.git',
      'ftps://example.com/org/repo.git',
      'https://example.com/org/a@b.git',
      'example.com:/srv/a@b:c.git',
    ]) {
      expect(isNetworkGitRemoteUrl(url)).toBe(true);
      expect(gitRemoteEndpoint(url)).toEqual({ kind: 'network', url });
      expect(
        WorkerGitRemoteGetResultSchema.parse({
          origin: { state: 'configured', endpoint: { kind: 'network', url } },
        }),
      ).toBeDefined();
    }
  });

  it('never carries remote userinfo, which can hold an access token', () => {
    for (const [url, canonical] of [
      ['git@example.com:org/repo.git', 'example.com:org/repo.git'],
      ['git@[::1]:repo.git', '[::1]:repo.git'],
      ['user:secret@example.com:org/repo.git', 'example.com:org/repo.git'],
      ['a@secret@example.com:org/repo.git', 'example.com:org/repo.git'],
      ['git@example.com:org/a@b.git', 'example.com:org/a@b.git'],
      ['https://ghp_secret@github.com/o/r.git', 'https://github.com/o/r.git'],
      [
        'https://x-access-token:secret@github.com/o/r.git',
        'https://github.com/o/r.git',
      ],
      ['https://u:p@ss@example.com/o/r.git', 'https://example.com/o/r.git'],
      [
        'ssh://git@example.com:22/org/repo.git',
        'ssh://example.com:22/org/repo.git',
      ],
    ]) {
      expect(isNetworkGitRemoteUrl(url)).toBe(true);
      expect(gitRemoteEndpoint(url)).toEqual({
        kind: 'network',
        url: canonical,
      });
      // The handler's result always satisfies the schema it is served under.
      expect(
        WorkerGitRemoteGetResultSchema.safeParse({
          origin: { state: 'configured', endpoint: gitRemoteEndpoint(url) },
        }).success,
      ).toBe(true);
      rejectsAsNetwork(url);
    }
    // Without its userinfo, an scp-like host of one letter reads as a drive.
    expect(gitRemoteEndpoint('me@c:repo.git')).toEqual({ kind: 'local' });
  });

  it('declares only the remote error codes', () => {
    for (const code of [
      'worker.git.remote.invalidScope',
      'worker.git.remote.repositoryUnavailable',
      'worker.git.remote.notRepository',
    ])
      expect(
        WorkerGitRemoteGetErrorSchema.safeParse({
          kind: 'failed_precondition',
          code,
          message: 'refused',
          retry: { kind: 'never' },
        }).success,
      ).toBe(true);
    expect(
      WorkerGitRemoteGetErrorSchema.safeParse({
        kind: 'failed_precondition',
        code: 'worker.git.branch.repositoryUnavailable',
        message: 'refused',
        retry: { kind: 'never' },
      }).success,
    ).toBe(false);
  });
});
