import {
  WORKER_GIT_BRANCH_REF_INSTRUCTION_DEFINITIONS,
  WORKER_GIT_BRANCH_WRITE_INSTRUCTION_DEFINITIONS,
  WORKER_GIT_DIFF_QUERY_DEFINITIONS,
  WORKER_GIT_EXECUTABLE_QUERY_DEFINITIONS,
  WORKER_GIT_QUERY_DEFINITIONS,
  WORKER_GIT_REMOTE_QUERY_DEFINITIONS,
  WORKER_GIT_WORKTREE_HEALTH_QUERY_DEFINITIONS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import type { CanopyDispatcher } from '../../../runtime/types';
import type { WorkspaceFileRead } from '../../workspace/read-formats';
import {
  createRecordedWorkerGitHosts,
  type RecordedWorkerGitHostsOptions,
} from '../recorded-worker-git-hosts';
import {
  GitRepositoryReadError,
  type GitExecutableSelectionFacts,
  type GitRepositoryRead,
  type GitRepositoryReader,
} from '../repository-reads';
import {
  GitRepositoryWriteError,
  type GitRepositoryWrite,
  type GitRepositoryWritePort,
} from '../repository-writes';
import { createWorkerGitBranchListHandlers } from '../worker-git-branch-list';
import { createWorkerGitBranchWriteHandlers } from '../worker-git-branch-writes';
import { createWorkerGitDiffHandlers } from '../worker-git-diff';
import { createWorkerGitExecutableHandlers } from '../worker-git-executable';
import { createWorkerGitRemoteHandlers } from '../worker-git-remote-get';
import { createWorkerGitWorktreeHealthHandlers } from '../worker-git-worktree-health';

const ROOT = '/data';
const AUTHORITY = 'authority';
const TARGET = 'in-process';
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const caller: CanopyCallerDescriptor = {
  principalId: 'user',
  clientInstanceId: 'test',
  authorityId: AUTHORITY,
  interfaceKind: 'test',
  grants: ['worker.git.read'],
};

type Records = Record<string, unknown>;

function index(...entries: [string, string][]): unknown {
  return {
    version: 1,
    workspaces: entries.map(([id, type]) => ({
      id,
      name: id,
      type,
      color: '#fff',
    })),
  };
}

function baseRecords(): Records {
  return {
    '/data/workspaces/index.json': index(
      ['single', 'single-repo'],
      ['multi', 'multi-repo'],
      ['team', 'single-repo'],
    ),
    '/data/workspaces/single/workspace.json': {
      version: 1,
      type: 'single-repo',
      repoPath: '/src/single',
      repos: [],
    },
    '/data/workspaces/single/worktrees.json': {
      version: 1,
      worktrees: [{ id: 'task', branchName: 'topic', createdAt: 'now' }],
    },
    '/data/workspaces/multi/workspace.json': {
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: '/src/multi',
      repos: [{ id: 'api', name: 'API', repoPath: '/src/api' }],
    },
    '/data/workspaces/multi/worktrees.json': {
      version: 1,
      worktrees: [
        {
          id: 'task',
          branchName: 'topic',
          createdAt: 'now',
          includedRepoIds: ['api'],
        },
      ],
    },
    '/data/workspaces/team/workspace.json': {
      version: 1,
      type: 'single-repo',
      repoPath: '/src/team',
      owner: {
        type: 'organization',
        organizationId: ORG,
        projectId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        instanceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        bindingGeneration: 0,
      },
    },
    '/data/workspaces/team/worktrees.json': {
      version: 1,
      worktrees: [{ id: 'task', branchName: 'topic', createdAt: 'now' }],
    },
  };
}

interface Fixture {
  readonly records: Records;
  readonly reads: { kind: string; cwd: string }[];
  /** Output by `kind` or `kind@cwd`; a missing answer exits non-zero. */
  readonly answers: Record<string, string>;
  /** Exit code by key for a read without an answer; 128 otherwise. */
  readonly exits: Record<string, number>;
  /** Paths `lstat` reports as directories; anything else is absent. */
  readonly directories: string[];
  facts: GitExecutableSelectionFacts;
}

function fixture(): Fixture {
  return {
    records: baseRecords(),
    reads: [],
    answers: {},
    exits: {},
    directories: [],
    facts: { ready: true, version: 'git version 2.47.1', origin: 'discovered', override: false }, // prettier-ignore
  };
}

function readKey(read: GitRepositoryRead): string {
  switch (read.kind) {
    case 'origin-branch':
      return `${read.kind}:${read.branch}`;
    case 'object-exists':
      return `${read.kind}:${read.object}`;
    default:
      return read.kind;
  }
}

function reader(f: Fixture): GitRepositoryReader {
  return {
    read: (read: GitRepositoryRead, cwd: string): Promise<string> => {
      f.reads.push({ kind: read.kind, cwd });
      const key = readKey(read);
      const answer = f.answers[`${key}@${cwd}`] ?? f.answers[key];
      return answer === undefined
        ? Promise.reject(
            new GitRepositoryReadError('exit_status', {
              exitCode: f.exits[key] ?? 128,
            }),
          )
        : Promise.resolve(answer);
    },
    selectExecutable: () => Promise.resolve(f.facts),
  };
}

function dispatcher(
  f: Fixture,
  overrides: Partial<RecordedWorkerGitHostsOptions> = {},
): ReturnType<typeof createCanopyDispatcher> {
  const hosts = createRecordedWorkerGitHosts({
    dataRoot: ROOT,
    authorityId: AUTHORITY,
    recordsTargetId: TARGET,
    os: 'darwin',
    arch: 'arm64',
    git: reader(f),
    now: () => new Date('2026-10-27T00:00:00.000Z'),
    files: {
      readRecord: (path): Promise<WorkspaceFileRead> => {
        const value = f.records[path];
        if (value === undefined) return Promise.resolve({ state: 'absent' });
        return Promise.resolve(
          typeof value === 'string'
            ? { state: 'present', raw: value }
            : { state: 'present', raw: JSON.stringify(value) },
        );
      },
      realpath: (path) => Promise.resolve(path),
      stat: () => Promise.reject(new Error('ENOENT')),
      lstat: (path) =>
        f.directories.includes(path)
          ? Promise.resolve({ isDirectory: () => true, isFile: () => false })
          : Promise.reject(new Error('ENOENT')),
      readText: () => Promise.reject(new Error('ENOENT')),
      readDirectory: () => Promise.resolve([]),
    },
    ...overrides,
  });
  return createCanopyDispatcher({
    profile: 'worker',
    definitions: {
      queries: {
        ...WORKER_GIT_QUERY_DEFINITIONS,
        ...WORKER_GIT_EXECUTABLE_QUERY_DEFINITIONS,
        ...WORKER_GIT_REMOTE_QUERY_DEFINITIONS,
        ...WORKER_GIT_WORKTREE_HEALTH_QUERY_DEFINITIONS,
        ...WORKER_GIT_DIFF_QUERY_DEFINITIONS,
      },
      instructions: {},
      streams: {},
    },
    handlers: {
      queries: {
        ...createWorkerGitBranchListHandlers(hosts.branchList),
        ...createWorkerGitExecutableHandlers(hosts.executable),
        ...createWorkerGitRemoteHandlers(hosts.remote),
        ...createWorkerGitWorktreeHealthHandlers(hosts.worktreeHealth),
        ...createWorkerGitDiffHandlers(hosts.diff),
      },
      instructions: {},
      streams: {},
    },
  });
}

const REFS = 'refs/heads/main\tmain*\nrefs/heads/topic\ttopic\n';

describe('scope resolution from records', () => {
  it('lists a checkout from its recorded path, under the data root', async () => {
    const f = fixture();
    Object.assign(f.answers, {
      'branch-refs': REFS,
      'common-dir': '/src/single/.git/worktrees/task',
      'worktree-list': 'worktree /src/single\nbranch refs/heads/main\n',
      'remote-head': 'ref: refs/heads/main\tHEAD\nabc\tHEAD\n',
    });
    await expect(
      dispatcher(f).query(
        'worker.git.branch.list',
        {
          scope: { workspaceId: 'single', worktreeId: 'task' },
          repository: { kind: 'checkout' },
        },
        { caller },
      ),
    ).resolves.toMatchObject({
      branches: [
        { name: 'main', isCurrent: true, isUsedByWorktree: true },
        { name: 'topic' },
      ],
      defaultBranch: 'main',
      defaultBranchSource: 'remote',
    });
    const checkout = '/data/workspaces/single/worktrees/task';
    expect(f.reads).toEqual(
      expect.arrayContaining([
        { kind: 'branch-refs', cwd: checkout },
        { kind: 'common-dir', cwd: checkout },
        // The root Git named is the recorded repository.
        { kind: 'worktree-list', cwd: '/src/single' },
        { kind: 'remote-head', cwd: checkout },
      ]),
    );
  });

  it('runs no worktree listing in a root the records do not name', async () => {
    const f = fixture();
    Object.assign(f.answers, {
      'branch-refs': REFS,
      'common-dir': '/elsewhere/.git/worktrees/task',
      'worktree-list': 'worktree /elsewhere\nbranch refs/heads/main\n',
    });
    await expect(
      dispatcher(f).query(
        'worker.git.branch.list',
        {
          scope: { workspaceId: 'single', worktreeId: 'task' },
          repository: { kind: 'checkout' },
        },
        { caller },
      ),
    ).resolves.toMatchObject({
      branches: [{ name: 'main', isUsedByWorktree: false }, { name: 'topic' }],
    });
    expect(f.reads.map(({ kind }) => kind)).not.toContain('worktree-list');
  });

  it('keeps a reference repository at its recorded path unless Git names a recorded root', async () => {
    const f = fixture();
    Object.assign(f.answers, {
      'branch-refs': REFS,
      'common-dir@/src/multi': '/elsewhere/.git',
      'common-dir@/src/api/linked': '/src/api/.git/worktrees/linked',
    });
    const list = (workspaceId: string): Promise<unknown> =>
      dispatcher(f).query(
        'worker.git.branch.list',
        { scope: { workspaceId }, repository: { kind: 'reference' } },
        { caller },
      );
    await list('multi');
    expect(f.reads.find(({ kind }) => kind === 'branch-refs')).toEqual({
      kind: 'branch-refs',
      cwd: '/src/multi',
    });
    // A linked source whose main root is another recorded repository.
    f.records['/data/workspaces/multi/workspace.json'] = {
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: '/src/api/linked',
      repos: [{ id: 'api', name: 'API', repoPath: '/src/api' }],
    };
    f.reads.length = 0;
    await list('multi');
    expect(f.reads.find(({ kind }) => kind === 'branch-refs')).toEqual({
      kind: 'branch-refs',
      cwd: '/src/api',
    });
  });

  it.each<[string, (records: Records) => void, Record<string, unknown>]>([
    [
      'an untracked workspace',
      (): void => undefined,
      { workspaceId: 'gone', worktreeId: 'task' },
    ],
    [
      'an unreadable index',
      (records): void => {
        records['/data/workspaces/index.json'] = '{';
      },
      { workspaceId: 'single', worktreeId: 'task' },
    ],
    [
      'a duplicated index entry',
      (records): void => {
        records['/data/workspaces/index.json'] = index(
          ['single', 'single-repo'],
          ['single', 'single-repo'],
        );
      },
      { workspaceId: 'single', worktreeId: 'task' },
    ],
    [
      'a manifest whose type disagrees with the index',
      (records): void => {
        records['/data/workspaces/single/workspace.json'] = {
          version: 1,
          type: 'multi-repo',
        };
      },
      { workspaceId: 'single', worktreeId: 'task' },
    ],
    [
      'a manifest for another authority',
      (records): void => {
        records['/data/workspaces/single/workspace.json'] = {
          version: 1,
          type: 'single-repo',
          repoPath: '/src/single',
          authorityId: 'other',
        };
      },
      { workspaceId: 'single', worktreeId: 'task' },
    ],
    [
      'malformed repository records',
      (records): void => {
        records['/data/workspaces/multi/workspace.json'] = {
          version: 1,
          type: 'multi-repo',
          repos: [{ id: 'api' }],
        };
      },
      { workspaceId: 'multi', worktreeId: 'task' },
    ],
    [
      'an unlisted worktree',
      (): void => undefined,
      { workspaceId: 'single', worktreeId: 'other' },
    ],
    [
      'an organization selector the owner does not match',
      (): void => undefined,
      {
        workspaceId: 'team',
        worktreeId: 'task',
        organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
    ],
    [
      'an organization selector on a Personal workspace',
      (): void => undefined,
      { workspaceId: 'single', worktreeId: 'task', organizationId: ORG },
    ],
    [
      'a repository the multi-repo workspace does not record',
      (): void => undefined,
      { workspaceId: 'multi', worktreeId: 'task', repoId: 'web' },
    ],
  ])('refuses %s before any Git runs', async (_, edit, scope) => {
    const f = fixture();
    edit(f.records);
    await expect(
      dispatcher(f).query(
        'worker.git.branch.list',
        { scope, repository: { kind: 'checkout' } },
        { caller },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'worker.git.branch.scopeUnsupported',
      },
    });
    expect(f.reads).toEqual([]);
  });

  it('serves an organization-owned workspace to its matching selector', async () => {
    const f = fixture();
    Object.assign(f.answers, { 'branch-refs': REFS });
    await expect(
      dispatcher(f).query(
        'worker.git.branch.list',
        {
          scope: {
            workspaceId: 'team',
            worktreeId: 'task',
            organizationId: ORG.toUpperCase(),
          },
          repository: { kind: 'checkout' },
        },
        { caller },
      ),
    ).resolves.toHaveProperty('branches');
  });

  it.each([
    ['a relative recorded path', 'src/single'],
    ['a recorded path with NUL', '/src/sin\0gle'],
    ['an empty recorded path', ''],
  ])('answers no repository for %s', async (_, repoPath) => {
    const f = fixture();
    f.records['/data/workspaces/single/workspace.json'] = {
      version: 1,
      type: 'single-repo',
      repoPath,
      repos: [],
    };
    await expect(
      dispatcher(f).query(
        'worker.git.branch.list',
        { scope: { workspaceId: 'single' }, repository: { kind: 'reference' } },
        { caller },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'worker.git.branch.repositoryUnavailable' },
    });
    await expect(
      dispatcher(f).query(
        'worker.git.remote.get',
        { scope: { workspaceId: 'single' }, repository: { kind: 'recorded' } },
        { caller },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'worker.git.remote.repositoryUnavailable' },
    });
    expect(f.reads).toEqual([]);
  });

  it('rejects a malformed repository id as invalid', async () => {
    const f = fixture();
    await expect(
      dispatcher(f).query(
        'worker.git.remote.get',
        {
          scope: { workspaceId: 'multi', repoId: '../api' },
          repository: { kind: 'recorded' },
        },
        { caller },
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'invalid_argument' },
    });
  });
});

describe('remote reads', () => {
  it('answers absent only when the repository lists no origin', async () => {
    const f = fixture();
    Object.assign(f.answers, {
      'remote-names': 'upstream\n',
      'git-dir': '.git',
    });
    await expect(
      dispatcher(f).query(
        'worker.git.remote.get',
        {
          scope: { workspaceId: 'multi', repoId: 'api' },
          repository: { kind: 'recorded' },
        },
        { caller },
      ),
    ).resolves.toEqual({ origin: { state: 'absent' } });
    f.answers['remote-names'] = 'origin\n';
    await expect(
      dispatcher(f).query(
        'worker.git.remote.get',
        {
          scope: { workspaceId: 'multi', repoId: 'api' },
          repository: { kind: 'recorded' },
        },
        { caller },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'internal' } });
    expect(new Set(f.reads.map(({ cwd }) => cwd))).toEqual(
      new Set(['/src/api']),
    );
  });
});

describe('worktree health sources', () => {
  it('reads the included ids, names and source flag from the records', async () => {
    const f = fixture();
    const worktree = '/data/workspaces/multi/worktrees/task';
    const dirs = new Set([worktree, `${worktree}/repos/api`]);
    const health = dispatcher(f, {
      files: {
        readRecord: (path) =>
          Promise.resolve({
            state: 'present',
            raw: JSON.stringify(f.records[path]),
          }),
        realpath: (path) => Promise.resolve(path),
        stat: (path) =>
          dirs.has(path)
            ? Promise.resolve({ isDirectory: () => true, isFile: () => false })
            : Promise.reject(new Error('ENOENT')),
        lstat: () => Promise.reject(new Error('ENOENT')),
        readText: () => Promise.reject(new Error('ENOENT')),
        readDirectory: (path) =>
          Promise.resolve(
            path === `${worktree}/repos`
              ? [
                  { name: 'api', isDirectory: (): boolean => true },
                  { name: 'payload', isDirectory: (): boolean => true },
                ]
              : [],
          ),
      },
    });
    await expect(
      health.query(
        'worker.git.worktree.health.get',
        { scope: { workspaceId: 'multi', worktreeId: 'task' } },
        { caller },
      ),
    ).resolves.toEqual({
      healthy: false,
      issue: {
        code: 'missing-git-metadata',
        checkedAt: '2026-10-27T00:00:00.000Z',
        // The untracked `payload` directory is not an included repository.
        repoIssues: [
          { repoId: 'api', code: 'missing-git-metadata' },
          { repoId: '__workspace_root__', code: 'missing-git-metadata' },
        ],
      },
    });
  });
});

describe('executable facts', () => {
  const executable = (f: Fixture, os: string, arch: string): Promise<unknown> =>
    dispatcher(f, { os, arch }).query(
      'worker.git.executable.get',
      { scope: {}, recheck: true },
      { caller },
    );

  it.each<[string, string, string, GitExecutableSelectionFacts, unknown]>([
    ['darwin', 'arm64', 'a saved choice', { ready: true, version: 'git version 2.47.1', origin: 'saved', override: false }, { source: 'cache', ready: true }], // prettier-ignore
    ['darwin', 'arm64', 'an override', { ready: true, version: 'git version 2.47.1', origin: 'override', override: true }, { source: 'auto-detected' }], // prettier-ignore
    ['darwin', 'arm64', 'a discovery', { ready: true, version: 'git version 2.47.1', origin: 'discovered', override: false }, { source: 'auto-detected' }], // prettier-ignore
    ['linux', 'x64', 'a saved choice', { ready: true, version: 'git version 2.43.0', origin: 'saved', override: false }, { source: 'user-selected' }], // prettier-ignore
    ['linux', 'x64', 'the discovery cache', { ready: true, version: 'git version 2.43.0', origin: 'discovery-cache', override: false }, { source: 'cache' }], // prettier-ignore
    ['linux', 'x64', 'a login-PATH Git', { ready: true, version: 'git version 2.43.0', origin: 'login-path', override: false }, { source: 'login-path' }], // prettier-ignore
    ['linux', 'arm64', 'a saved choice', { ready: true, version: 'git version 2.43.0', origin: 'saved', override: false }, { source: 'user-selected', required: true }], // prettier-ignore
    ['linux', 'arm64', 'an override', { ready: true, version: 'git version 2.43.0', origin: 'override', override: true }, { source: 'user-selected', required: true }], // prettier-ignore
    ['linux', 's390x', 'an unvalidated Git', { ready: true, version: null, origin: 'unvalidated', override: false }, { source: 'not-found', required: false, version: null }], // prettier-ignore
    ['linux', 'x64', 'a broken explicit choice', { ready: false, code: 'git_unavailable', explicit: true }, { ready: false, source: 'not-found', issue: 'selected-unusable' }], // prettier-ignore
    ['darwin', 'arm64', 'an unreadable found Git', { ready: false, code: 'selection_rejected', explicit: false }, { ready: false, issue: 'candidate-unusable' }], // prettier-ignore
    ['darwin', 'arm64', 'no Git', { ready: false, code: 'git_unavailable', explicit: false }, { ready: false, issue: 'not-found' }], // prettier-ignore
  ])('reports %s %s %s', async (os, arch, _, facts, expected) => {
    const f = fixture();
    f.facts = facts;
    await expect(executable(f, os, arch)).resolves.toMatchObject({
      platform: os,
      wingetAvailable: false,
      checkedAt: '2026-10-27T00:00:00.000Z',
      ...(facts.ready && { issue: null }),
      ...(typeof expected === 'object' ? expected : {}),
    });
  });

  it('fails as detectionFailed when the host could not select', async () => {
    const f = fixture();
    f.facts = { ready: false, code: 'stopped', explicit: false };
    await expect(executable(f, 'darwin', 'arm64')).rejects.toMatchObject({
      payload: {
        kind: 'internal',
        code: 'worker.git.executable.detectionFailed',
      },
    });
  });
});

describe('changed files', () => {
  const OID = 'e'.repeat(40);
  const HOME = '/data/workspaces/single/worktrees/task';
  const MULTI = '/data/workspaces/multi/worktrees/task';
  const diff = (
    f: Fixture,
    params: {
      scope: Record<string, string>;
      repoId?: string;
      base?: string;
      head?: string;
      paths?: string[];
    },
  ): Promise<unknown> =>
    dispatcher(f).query(
      'worker.git.diff.get',
      {
        repoId: '__workspace_root__',
        base: 'HEAD',
        head: 'WORKTREE',
        ...params,
      },
      { caller },
    );
  const changed = (f: Fixture): void => {
    Object.assign(f.answers, {
      'diff-name-status': 'M\0a.txt\0R090\0old\0new\0',
      'diff-numstat': '1\t2\ta.txt\0' + '3\t4\t\0old\0new\0',
      'untracked-files': '',
      'unmerged-files': '',
    });
  };

  it('reads the listed worktree root and a member directory under its repos/', async () => {
    const f = fixture();
    changed(f);
    f.directories.push(`${MULTI}/repos/api`);
    const expected = {
      files: [
        { path: 'a.txt', previousPath: null, status: 'modified', additions: 1, deletions: 2, patch: null }, // prettier-ignore
        { path: 'new', previousPath: 'old', status: 'renamed', additions: 3, deletions: 4, patch: null }, // prettier-ignore
      ],
      truncated: false,
    };
    await expect(
      diff(f, { scope: { workspaceId: 'single', worktreeId: 'task' } }),
    ).resolves.toEqual(expected);
    await expect(
      diff(f, {
        scope: { workspaceId: 'multi', worktreeId: 'task', repoId: 'api' },
        repoId: 'api',
      }),
    ).resolves.toEqual(expected);
    expect(new Set(f.reads.map(({ cwd }) => cwd))).toEqual(
      new Set([HOME, `${MULTI}/repos/api`]),
    );
    expect(new Set(f.reads.map(({ kind }) => kind))).toEqual(
      new Set(['diff-name-status', 'diff-numstat', 'untracked-files', 'unmerged-files']), // prettier-ignore
    );
  });

  it('compares two objects without the working-tree listings', async () => {
    const f = fixture();
    changed(f);
    await expect(
      diff(f, {
        scope: { workspaceId: 'single', worktreeId: 'task' },
        base: OID,
        head: 'HEAD',
      }),
    ).resolves.toMatchObject({ truncated: false });
    expect(f.reads.map(({ kind }) => kind).sort()).toEqual([
      'diff-name-status',
      'diff-numstat',
    ]);
  });

  it.each<[string, Record<string, string>, string]>([
    ['an unlisted worktree', { workspaceId: 'single', worktreeId: 'unlisted' }, 'worker.git.diff.scopeUnsupported'], // prettier-ignore
    ['an untracked workspace', { workspaceId: 'elsewhere', worktreeId: 'task' }, 'worker.git.diff.scopeUnsupported'], // prettier-ignore
    ['an app-managed chat scope', { workspaceId: 'code-review-chat', worktreeId: 'task' }, 'worker.git.diff.scopeUnsupported'], // prettier-ignore
    ['no worktree', { workspaceId: 'single' }, 'worker.git.diff.invalidScope'],
    ['an invalid worktree id', { workspaceId: 'single', worktreeId: '../x' }, 'worker.git.diff.invalidScope'], // prettier-ignore
  ])('refuses %s before any Git runs', async (_, scope, code) => {
    const f = fixture();
    changed(f);
    await expect(diff(f, { scope })).rejects.toMatchObject({
      payload: { code },
    });
    expect(f.reads).toEqual([]);
  });

  it.each<[string, string, string]>([
    ['a member of a single-repository workspace', 'single', 'api'],
    ['a member that is not a directory', 'multi', 'docs'],
    ['a parent-directory member', 'multi', '..'],
    ['a nested member', 'multi', 'api/x'],
  ])('answers notFound for %s', async (_, workspaceId, repoId) => {
    const f = fixture();
    changed(f);
    f.directories.push(`${MULTI}/repos/api`, `${MULTI}/repos/api/x`, MULTI);
    await expect(
      diff(f, { scope: { workspaceId, worktreeId: 'task' }, repoId }),
    ).rejects.toMatchObject({ payload: { code: 'worker.git.diff.notFound' } });
    expect(f.reads).toEqual([]);
  });

  it('classifies a failed diff by the exit code of the object probe', async () => {
    const scope = { workspaceId: 'single', worktreeId: 'task' };
    const listings = { 'untracked-files': '', 'unmerged-files': '' };
    // The diffs fail; HEAD exists, the base object does not (exit 1).
    const missing = fixture();
    Object.assign(missing.answers, listings, { 'object-exists:HEAD': 'x\n' });
    missing.exits[`object-exists:${OID}`] = 1;
    await expect(
      diff(missing, { scope, base: OID, head: 'HEAD' }),
    ).rejects.toMatchObject({
      payload: { kind: 'not_found', code: 'worker.git.diff.notFound' },
    });
    // No commit yet: HEAD itself is absent.
    const empty = fixture();
    Object.assign(empty.answers, listings);
    empty.exits['object-exists:HEAD'] = 1;
    await expect(diff(empty, { scope })).rejects.toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'worker.git.diff.invalidState',
      },
    });
    // Any other probe exit leaves Git's failure internal.
    const broken = fixture();
    Object.assign(broken.answers, listings);
    await expect(diff(broken, { scope })).rejects.toMatchObject({
      payload: { kind: 'internal' },
    });
  });

  it('serves no patches: paths are refused before anything is read', async () => {
    const f = fixture();
    changed(f);
    await expect(
      diff(f, {
        scope: { workspaceId: 'single', worktreeId: 'task' },
        paths: ['a.txt'],
      }),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
    expect(f.reads).toEqual([]);
  });

  it('refuses a foreign target before resolving records', async () => {
    const f = fixture();
    await expect(
      diff(f, {
        scope: { workspaceId: 'single', worktreeId: 'task', targetId: 'x' },
      }),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
    expect(f.reads).toEqual([]);
  });
});

const WRITE_INSTRUCTIONS = {
  ...WORKER_GIT_BRANCH_WRITE_INSTRUCTION_DEFINITIONS,
  ...WORKER_GIT_BRANCH_REF_INSTRUCTION_DEFINITIONS,
};

describe('branch writes (CAN-4108)', () => {
  const core: CanopyCallerDescriptor = {
    principalId: 'core',
    clientInstanceId: 'bundled-core',
    authorityId: AUTHORITY,
    interfaceKind: 'daemon',
    grants: ['worker.git.write'],
  };

  function writeHandlers(
    f: Fixture,
    writes?: GitRepositoryWritePort,
    git: GitRepositoryReader = reader(f),
  ): ReturnType<typeof createWorkerGitBranchWriteHandlers> {
    const hosts = createRecordedWorkerGitHosts({
      dataRoot: ROOT,
      authorityId: AUTHORITY,
      recordsTargetId: TARGET,
      os: 'darwin',
      arch: 'arm64',
      git,
      ...(writes && { writes }),
      files: {
        readRecord: (path): Promise<WorkspaceFileRead> => {
          const value = f.records[path];
          if (value === undefined) return Promise.resolve({ state: 'absent' });
          return Promise.resolve({
            state: 'present',
            raw: JSON.stringify(value),
          });
        },
        realpath: (path) => Promise.resolve(path),
      },
    });
    return createWorkerGitBranchWriteHandlers(hosts.branchWrite);
  }

  function writeDispatcher(
    f: Fixture,
    writes?: GitRepositoryWritePort,
    git?: GitRepositoryReader,
  ): CanopyDispatcher<Record<never, never>, typeof WRITE_INSTRUCTIONS> {
    return createCanopyDispatcher({
      profile: 'worker',
      definitions: {
        queries: {},
        instructions: WRITE_INSTRUCTIONS,
        streams: {},
      },
      handlers: {
        queries: {},
        instructions: writeHandlers(f, writes, git),
        streams: {},
      },
    });
  }

  /** Answers by kind (and branch or name); unknown commands exit 1. */
  function writePort(
    runs: { kind: string; cwd: string }[],
    answers: Record<string, { exitCode: number; stdout?: string } | Error>,
  ): GitRepositoryWritePort {
    return {
      run: (write: GitRepositoryWrite, cwd: string) => {
        runs.push({ kind: write.kind, cwd });
        const value =
          'branch' in write
            ? write.branch
            : 'name' in write
              ? write.name
              : undefined;
        const answer =
          answers[value === undefined ? write.kind : `${write.kind}:${value}`];
        if (answer instanceof Error) return Promise.reject(answer);
        return Promise.resolve({
          exitCode: answer?.exitCode ?? 1,
          stdout: answer?.stdout ?? '',
        });
      },
    };
  }

  it('runs the checkout in the recorded checkout and lists worktrees at the recorded root', async () => {
    const f = fixture();
    f.answers['common-dir@/data/workspaces/single/worktrees/task'] =
      '/src/single/.git/worktrees/task';
    f.answers['worktree-list@/src/single'] =
      'worktree /src/single\nbranch refs/heads/main\n';
    const runs: { kind: string; cwd: string }[] = [];
    const writes = writePort(runs, {
      status: { exitCode: 0 },
      'local-branch:feature': { exitCode: 0 },
      'checkout:feature': { exitCode: 0 },
    });
    await expect(
      writeDispatcher(f, writes).instruction(
        'worker.git.checkout',
        {
          scope: { workspaceId: 'single', worktreeId: 'task' },
          branch: 'feature',
        },
        { caller: core },
      ),
    ).resolves.toEqual({ branch: 'feature' });
    expect(runs).toEqual(
      ['status', 'local-branch', 'checkout'].map((kind) => ({
        kind,
        cwd: '/data/workspaces/single/worktrees/task',
      })),
    );
    expect(f.reads).toEqual([
      { kind: 'common-dir', cwd: '/data/workspaces/single/worktrees/task' },
      { kind: 'worktree-list', cwd: '/src/single' },
    ]);
  });

  it("runs every branch-write read and command with the request's forwarded environment (CAN-5496)", async () => {
    const f = fixture();
    f.answers['common-dir@/data/workspaces/single/worktrees/task'] =
      '/src/single/.git/worktrees/task';
    f.answers['worktree-list@/src/single'] =
      'worktree /src/single\nbranch refs/heads/main\n';
    const base = reader(f);
    const readEnvironments: unknown[] = [];
    const git: GitRepositoryReader = {
      ...base,
      read: (read, cwd, invocation) => {
        readEnvironments.push(invocation.environment);
        return base.read(read, cwd, invocation);
      },
    };
    const writeEnvironments: unknown[] = [];
    const runs: { kind: string; cwd: string }[] = [];
    const answers = writePort(runs, {
      status: { exitCode: 0 },
      'remote-branch:feature': { exitCode: 0 },
      'checkout-new-branch:feature': { exitCode: 0 },
    });
    const writes: GitRepositoryWritePort = {
      run: (write, cwd, environment) => {
        writeEnvironments.push(environment);
        return answers.run(write, cwd);
      },
    };
    const childEnvironment = {
      PATH: '/login/bin:/usr/bin',
      SSH_AUTH_SOCK: '/a',
    };
    const dispatcher = writeDispatcher(f, writes, git);
    const call = (execution?: {
      childEnvironment: Record<string, string>;
    }): Promise<unknown> =>
      dispatcher.instruction(
        'worker.git.checkout',
        {
          scope: { workspaceId: 'single', worktreeId: 'task' },
          branch: 'feature',
        },
        { caller: core, ...(execution && { execution }) },
      );
    await expect(call({ childEnvironment })).resolves.toEqual({
      branch: 'feature',
    });
    expect(runs.map(({ kind }) => kind)).toEqual([
      'status',
      'local-branch',
      'remote-branch',
      'checkout-new-branch',
    ]);
    expect(readEnvironments).toEqual([childEnvironment, childEnvironment]);
    expect(writeEnvironments).toEqual(Array(4).fill(childEnvironment));
    // A caller that forwards none keeps the hosts' own snapshot.
    readEnvironments.length = 0;
    writeEnvironments.length = 0;
    await expect(call()).resolves.toEqual({ branch: 'feature' });
    expect(readEnvironments).toEqual([undefined, undefined]);
    expect(writeEnvironments).toEqual(Array(4).fill(undefined));
  });

  it('selects a member checkout and refuses an unlisted worktree before any write', async () => {
    const f = fixture();
    const runs: { kind: string; cwd: string }[] = [];
    const writes = writePort(runs, {
      status: { exitCode: 0, stdout: ' M a\n' },
    });
    await expect(
      writeDispatcher(f, writes).instruction(
        'worker.git.checkout',
        {
          scope: { workspaceId: 'multi', worktreeId: 'task', repoId: 'api' },
          branch: 'feature',
        },
        { caller: core },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'worker.git.checkout.uncommittedChanges' },
    });
    expect(runs).toEqual([
      {
        kind: 'status',
        cwd: '/data/workspaces/multi/worktrees/task/repos/api',
      },
    ]);
    runs.length = 0;
    await expect(
      writeDispatcher(f, writes).instruction(
        'worker.git.checkout',
        { scope: { workspaceId: 'single', worktreeId: 'gone' }, branch: 'x' },
        { caller: core },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'worker.git.checkout.scopeUnsupported' },
    });
    expect(runs).toEqual([]);
  });

  it('fails as unavailable without a write host, before any effect', async () => {
    await expect(
      writeDispatcher(fixture()).instruction(
        'worker.git.branch.create',
        {
          scope: { workspaceId: 'single', worktreeId: 'task' },
          name: 'fresh',
          startPoint: { branch: 'main', remote: false },
        },
        { caller: core },
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'unavailable', message: 'Git is unavailable.' },
    });
  });

  const single = { workspaceId: 'single', worktreeId: 'task' };
  const listed = (): Fixture => {
    const f = fixture();
    f.answers['common-dir@/data/workspaces/single/worktrees/task'] =
      '/src/single/.git/worktrees/task';
    f.answers['worktree-list@/src/single'] =
      'worktree /src/single\nbranch refs/heads/main\n';
    return f;
  };
  const kinds = (runs: { kind: string }[]): string[] =>
    runs.map(({ kind }) => kind);

  it('fails closed, before any effect, when a cancel cuts the occupied-branch check short', async () => {
    const f = listed();
    const base = reader(f);
    let listing!: () => void;
    const listingStarted = new Promise<void>((resolve) => {
      listing = resolve;
    });
    // The read host rejects an aborted read with the signal's reason.
    const git: GitRepositoryReader = {
      ...base,
      read: (read, cwd, invocation) => {
        if (read.kind !== 'worktree-list')
          return base.read(read, cwd, invocation);
        listing();
        const { signal } = invocation;
        return new Promise((_resolve, reject) =>
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the port contract rejects with the raw reason, here a string
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          }),
        );
      },
    };
    const runs: { kind: string; cwd: string }[] = [];
    const writes = writePort(runs, {
      status: { exitCode: 0 },
      'local-branch:main': { exitCode: 0 },
      'checkout:main': { exitCode: 0 },
    });
    const controller = new AbortController();
    const call = writeHandlers(f, writes, git)['worker.git.checkout'](
      { scope: single, branch: 'main' },
      {
        requestId: 'request',
        caller: core,
        metadata: {},
        signal: controller.signal,
      },
    );
    await listingStarted;
    controller.abort('caller');
    await expect(call).rejects.toMatchObject({
      payload: { kind: 'cancelled' },
    });
    expect(kinds(runs)).toEqual(['status']);
  });

  it.each(['stopped', 'git_unavailable', 'deadline_exceeded'] as const)(
    'fails closed as unavailable when the worktree listing ends %s',
    async (code) => {
      const f = listed();
      const base = reader(f);
      const git: GitRepositoryReader = {
        ...base,
        read: (read, cwd, invocation) =>
          read.kind === 'worktree-list'
            ? Promise.reject(new GitRepositoryReadError(code))
            : base.read(read, cwd, invocation),
      };
      const runs: { kind: string; cwd: string }[] = [];
      const writes = writePort(runs, {
        status: { exitCode: 0 },
        'local-branch:main': { exitCode: 0 },
        'checkout:main': { exitCode: 0 },
      });
      await expect(
        writeDispatcher(f, writes, git).instruction(
          'worker.git.checkout',
          { scope: single, branch: 'main' },
          { caller: core },
        ),
      ).rejects.toMatchObject({
        payload: { kind: 'unavailable', retry: { kind: 'after_refresh' } },
      });
      expect(kinds(runs)).toEqual(['status']);
    },
  );

  it("keeps the desktop's best effort when Git itself cannot list worktrees", async () => {
    // No common-dir answer: Git exits non-zero, so no branch reads as occupied.
    const f = fixture();
    const runs: { kind: string; cwd: string }[] = [];
    const writes = writePort(runs, {
      status: { exitCode: 0 },
      'local-branch:main': { exitCode: 0 },
      'checkout:main': { exitCode: 0 },
    });
    await expect(
      writeDispatcher(f, writes).instruction(
        'worker.git.checkout',
        { scope: single, branch: 'main' },
        { caller: core },
      ),
    ).resolves.toEqual({ branch: 'main' });
    expect(kinds(runs)).toEqual(['status', 'local-branch', 'checkout']);
  });

  it('keeps that best effort for a listing past the 8 MiB the desktop also refuses', async () => {
    const f = listed();
    const base = reader(f);
    const git: GitRepositoryReader = {
      ...base,
      read: (read, cwd, invocation) =>
        read.kind === 'worktree-list'
          ? Promise.reject(new GitRepositoryReadError('output_limit'))
          : base.read(read, cwd, invocation),
    };
    const runs: { kind: string; cwd: string }[] = [];
    const writes = writePort(runs, {
      status: { exitCode: 0 },
      'local-branch:main': { exitCode: 0 },
      'checkout:main': { exitCode: 0 },
    });
    await expect(
      writeDispatcher(f, writes, git).instruction(
        'worker.git.checkout',
        { scope: single, branch: 'main' },
        { caller: core },
      ),
    ).resolves.toEqual({ branch: 'main' });
    expect(kinds(runs)).toEqual(['status', 'local-branch', 'checkout']);
  });

  it.each([
    ['the checkout', 'local-branch:local', 'local', ['status', 'local-branch']],
    [
      'the fetch',
      'remote-branch:late',
      'late',
      ['status', 'local-branch', 'remote-branch'],
    ],
    [
      'the tracking checkout',
      'remote-branch:feature',
      'feature',
      ['status', 'local-branch', 'remote-branch'],
    ],
  ])(
    'never starts %s after a cancel the caller was already answered',
    async (_, cancelAt, branch, expected) => {
      const controller = new AbortController();
      const runs: { kind: string; cwd: string }[] = [];
      const answers = writePort(runs, {
        status: { exitCode: 0 },
        'local-branch:local': { exitCode: 0 },
        'remote-branch:feature': { exitCode: 0 },
      });
      // The cancel lands while a probe runs, after the listing finished.
      const writes: GitRepositoryWritePort = {
        run: (write, cwd) => {
          const answer = answers.run(write, cwd);
          const value = 'branch' in write ? write.branch : undefined;
          if (`${write.kind}:${value}` === cancelAt) controller.abort('caller');
          return answer;
        },
      };
      await expect(
        writeHandlers(listed(), writes)['worker.git.checkout'](
          { scope: single, branch },
          {
            requestId: 'request',
            caller: core,
            metadata: {},
            signal: controller.signal,
          },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'cancelled' } });
      expect(kinds(runs)).toEqual(expected);
    },
  );

  it.each([
    ['local-branch:feature', ['status', 'local-branch']],
    ['remote-branch:feature', ['status', 'local-branch', 'remote-branch']],
    [
      'fetch-origin-branch:feature',
      ['status', 'local-branch', 'remote-branch', 'fetch-origin-branch'],
    ],
  ])(
    'reports a write host stopping at %s as unavailable, not a missing branch',
    async (stoppedAt, expected) => {
      const runs: { kind: string; cwd: string }[] = [];
      const writes = writePort(runs, {
        status: { exitCode: 0 },
        [stoppedAt]: new GitRepositoryWriteError('stopped'),
      });
      await expect(
        writeDispatcher(listed(), writes).instruction(
          'worker.git.checkout',
          { scope: single, branch: 'feature' },
          { caller: core },
        ),
      ).rejects.toMatchObject({
        payload: { kind: 'unavailable', message: 'The Git host stopped.' },
      });
      expect(kinds(runs)).toEqual(expected);
    },
  );

  it('reports a write host stopping during name selection as unavailable', async () => {
    const runs: { kind: string; cwd: string }[] = [];
    const writes = writePort(runs, {
      status: { exitCode: 0 },
      'check-branch-name:fresh': { exitCode: 0 },
      'local-branch:fresh': { exitCode: 1 },
      'local-branches-under:fresh': new GitRepositoryWriteError('stopped'),
    });
    await expect(
      writeDispatcher(listed(), writes).instruction(
        'worker.git.branch.create',
        {
          scope: single,
          name: 'fresh',
          startPoint: { branch: 'main', remote: false },
        },
        { caller: core },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'unavailable' } });
    expect(kinds(runs)).not.toContain('checkout-new-branch');
  });

  it('answers branchNotFound only when Git said no, or refused the value', async () => {
    for (const branch of ['feature', '-option']) {
      const runs: { kind: string; cwd: string }[] = [];
      const refused = new GitRepositoryWriteError('invalid_request');
      const writes = writePort(
        runs,
        branch === 'feature'
          ? { status: { exitCode: 0 } }
          : {
              status: { exitCode: 0 },
              [`local-branch:${branch}`]: refused,
              [`remote-branch:${branch}`]: refused,
              [`fetch-origin-branch:${branch}`]: refused,
            },
      );
      await expect(
        writeDispatcher(listed(), writes).instruction(
          'worker.git.checkout',
          { scope: single, branch },
          { caller: core },
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'not_found',
          code: 'worker.git.checkout.branchNotFound',
        },
      });
      expect(kinds(runs)).not.toContain('checkout');
    }
  });

  it('keeps a probe Git did not finish untyped, never a "no"', async () => {
    const runs: { kind: string; cwd: string }[] = [];
    const writes = writePort(runs, {
      status: { exitCode: 0 },
      'local-branch:feature': new GitRepositoryWriteError('exit_status'),
    });
    await expect(
      writeDispatcher(listed(), writes).instruction(
        'worker.git.checkout',
        { scope: single, branch: 'feature' },
        { caller: core },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'internal' } });
    expect(kinds(runs)).toEqual(['status', 'local-branch']);
  });
  // CAN-5516: rename runs in the recorded checkout, delete in the recorded
  // repository, each with the request's forwarded environment.
  it('renames in the recorded checkout after the name checks', async () => {
    const runs: { kind: string; cwd: string }[] = [];
    const writes = writePort(runs, {
      'check-branch-name:renamed': { exitCode: 0 },
      'local-branch:renamed': { exitCode: 1 },
      'local-branches-under:renamed': { exitCode: 0 },
      'rename-current-branch:renamed': { exitCode: 0 },
    });
    await expect(
      writeDispatcher(fixture(), writes).instruction(
        'worker.git.branch.rename',
        { scope: single, name: 'renamed' },
        { caller: core },
      ),
    ).resolves.toEqual({ branch: 'renamed' });
    expect(runs).toEqual(
      [
        'check-branch-name',
        'local-branch',
        'local-branches-under',
        'rename-current-branch',
      ].map((kind) => ({
        kind,
        cwd: '/data/workspaces/single/worktrees/task',
      })),
    );
  });

  it('refuses a rename the write host refuses as invalid, before any effect', async () => {
    const runs: { kind: string; cwd: string }[] = [];
    const writes = writePort(runs, {
      'check-branch-name:-x': new GitRepositoryWriteError('invalid_request'),
    });
    await expect(
      writeDispatcher(fixture(), writes).instruction(
        'worker.git.branch.rename',
        { scope: single, name: '-x' },
        { caller: core },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'worker.git.branch.invalidName' },
    });
    expect(kinds(runs)).toEqual(['check-branch-name']);
  });

  it('never starts a rename after a cancel the caller was already answered', async () => {
    const controller = new AbortController();
    const runs: { kind: string; cwd: string }[] = [];
    const answers = writePort(runs, {
      'check-branch-name:renamed': { exitCode: 0 },
      'local-branch:renamed': { exitCode: 1 },
      'local-branches-under:renamed': { exitCode: 0 },
    });
    const writes: GitRepositoryWritePort = {
      run: (write, cwd) => {
        if (write.kind === 'local-branches-under') controller.abort('caller');
        return answers.run(write, cwd);
      },
    };
    await expect(
      writeHandlers(fixture(), writes)['worker.git.branch.rename'](
        { scope: single, name: 'renamed' },
        {
          requestId: 'request',
          caller: core,
          metadata: {},
          signal: controller.signal,
        },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'cancelled' } });
    expect(kinds(runs)).not.toContain('rename-current-branch');
  });

  it.each([
    [{ workspaceId: 'single' }, '/src/single'],
    [{ workspaceId: 'single', repoId: '__workspace_root__' }, '/src/single'],
    [{ workspaceId: 'multi' }, '/src/multi'],
    [{ workspaceId: 'multi', repoId: 'api' }, '/src/api'],
  ])('deletes in the repository %o records (%s)', async (scope, repository) => {
    const runs: { kind: string; cwd: string }[] = [];
    const writes = writePort(runs, {
      'delete-branch:old': { exitCode: 0 },
      'force-delete-branch:old': { exitCode: 0 },
    });
    const dispatcher = writeDispatcher(fixture(), writes);
    for (const kind of ['merged', 'force'] as const)
      await expect(
        dispatcher.instruction(
          'worker.git.branch.delete',
          { scope, branch: 'old', deletion: { kind } },
          { caller: core },
        ),
      ).resolves.toEqual({ branch: 'old' });
    expect(runs).toEqual([
      { kind: 'delete-branch', cwd: repository },
      { kind: 'force-delete-branch', cwd: repository },
    ]);
  });

  it.each([
    [
      'a member the workspace does not record',
      { workspaceId: 'multi', repoId: 'web' },
    ],
    [
      'a member of a single-repo workspace',
      { workspaceId: 'single', repoId: 'api' },
    ],
    ['an unlisted workspace', { workspaceId: 'gone' }],
  ])('refuses %s before any command', async (_label, scope) => {
    const runs: { kind: string; cwd: string }[] = [];
    await expect(
      writeDispatcher(fixture(), writePort(runs, {})).instruction(
        'worker.git.branch.delete',
        { scope, branch: 'old', deletion: { kind: 'force' } },
        { caller: core },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'worker.git.branch.scopeUnsupported' },
    });
    expect(runs).toEqual([]);
  });

  it('lists worktrees in the repository before a tip delete, with the forwarded environment', async () => {
    const f = fixture();
    f.answers['worktree-list@/src/single'] =
      'worktree /src/single\nbranch refs/heads/main\n\nworktree /elsewhere\nbranch refs/heads/held\n';
    const base = reader(f);
    const readEnvironments: unknown[] = [];
    const git: GitRepositoryReader = {
      ...base,
      read: (read, cwd, invocation) => {
        readEnvironments.push(invocation.environment);
        return base.read(read, cwd, invocation);
      },
    };
    const runs: { kind: string; cwd: string }[] = [];
    const writeEnvironments: unknown[] = [];
    const answers = writePort(runs, {
      'delete-branch-ref:old': { exitCode: 0 },
    });
    const writes: GitRepositoryWritePort = {
      run: (write, cwd, environment) => {
        writeEnvironments.push(environment);
        return answers.run(write, cwd);
      },
    };
    const childEnvironment = { PATH: '/login/bin:/usr/bin' };
    const dispatcher = writeDispatcher(f, writes, git);
    const tip = 'a'.repeat(40);
    await expect(
      dispatcher.instruction(
        'worker.git.branch.delete',
        {
          scope: { workspaceId: 'single' },
          branch: 'old',
          deletion: { kind: 'tip', tip },
        },
        { caller: core, execution: { childEnvironment } },
      ),
    ).resolves.toEqual({ branch: 'old' });
    expect(f.reads).toEqual([{ kind: 'worktree-list', cwd: '/src/single' }]);
    expect(runs).toEqual([{ kind: 'delete-branch-ref', cwd: '/src/single' }]);
    expect(readEnvironments).toEqual([childEnvironment]);
    expect(writeEnvironments).toEqual([childEnvironment]);
    runs.length = 0;
    await expect(
      dispatcher.instruction(
        'worker.git.branch.delete',
        {
          scope: { workspaceId: 'single' },
          branch: 'held',
          deletion: { kind: 'tip', tip },
        },
        { caller: core },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'worker.git.branch.checkedOut',
        message: 'Branch "held" is checked out in a worktree.',
      },
    });
    expect(runs).toEqual([]);
  });

  it('fails a tip delete before the effect when the listing fails or is cut short', async () => {
    const runs: { kind: string; cwd: string }[] = [];
    const writes = writePort(runs, {
      'delete-branch-ref:old': { exitCode: 0 },
    });
    const deletion = { kind: 'tip', tip: 'a'.repeat(40) } as const;
    // No worktree-list answer: Git exits non-zero.
    await expect(
      writeDispatcher(fixture(), writes).instruction(
        'worker.git.branch.delete',
        { scope: { workspaceId: 'single' }, branch: 'old', deletion },
        { caller: core },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'internal' } });
    const f = fixture();
    const base = reader(f);
    const stopped: GitRepositoryReader = {
      ...base,
      read: () => Promise.reject(new GitRepositoryReadError('stopped')),
    };
    await expect(
      writeDispatcher(f, writes, stopped).instruction(
        'worker.git.branch.delete',
        { scope: { workspaceId: 'single' }, branch: 'old', deletion },
        { caller: core },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'unavailable' } });
    expect(runs).toEqual([]);
  });

  it("reports Git's refusal of a delete as internal", async () => {
    const runs: { kind: string; cwd: string }[] = [];
    await expect(
      writeDispatcher(
        fixture(),
        writePort(runs, { 'delete-branch:old': { exitCode: 1 } }),
      ).instruction(
        'worker.git.branch.delete',
        {
          scope: { workspaceId: 'single' },
          branch: 'old',
          deletion: { kind: 'merged' },
        },
        { caller: core },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'internal' } });
  });
});
