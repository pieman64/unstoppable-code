// CAN-4070 rule: captured on the unchanged GitHub IPC handlers before CAN-4109
// serves them through core.pullRequest.* and core.integration.*. Real data
// root, workspace records and Git checkouts with configured origins (origins
// are only read, never contacted). GitHub is faked at the broker client and
// the shared pull-request read model, the boundaries the handlers reach.
// Responses are recorded as JSON text, so key order is pinned too.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IPC_CHANNELS,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { IPC_REMOTE_DISPOSITIONS } from '@canopy/desktop-shared/remote-control/channel-dispositions';

type Handler = (event: unknown, request?: unknown) => Promise<unknown>;

const mockHandlers = new Map<string, Handler>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    mockHandlers.set(channel, handler);
  },
}));

interface MockEnqueueCall {
  priority: unknown;
  options: unknown;
}
const mockEnqueueCalls: MockEnqueueCall[] = [];
const mockOctokit = {
  pulls: { list: jest.fn(), update: jest.fn() },
  graphql: jest.fn(),
  repos: { listForAuthenticatedUser: jest.fn() },
};
const mockEnqueue = jest.fn(
  (
    fn: (octokit: typeof mockOctokit) => Promise<unknown>,
    priority?: unknown,
    options?: unknown,
  ): Promise<unknown> => {
    mockEnqueueCalls.push({ priority, options });
    return fn(mockOctokit);
  },
);
jest.mock('../lib/github-client', () => ({
  getGitHubClient: (): { enqueue: typeof mockEnqueue } => ({
    enqueue: mockEnqueue,
  }),
}));
// No request reaches GitHub: the broker sends nothing (CAN-4109).
jest.mock('../lib/github-broker', () => {
  const actual = jest.requireActual<{ getGitHubBroker: () => object }>(
    '../lib/github-broker',
  );
  return {
    ...actual,
    getGitHubBroker: (): object =>
      new Proxy(actual.getGitHubBroker(), {
        get: (target, property): unknown => {
          if (property === 'execute')
            return (): Promise<never> =>
              Promise.reject(
                new Error('The GitHub broker sends nothing here.'),
              );
          const value: unknown = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
  };
});

const mockGetGitHubPullRequestStatus = jest.fn();
const mockInvalidateGitHubPullRequest = jest.fn();
// The canonical reads core.pullRequest.update adds (CAN-4109 harness).
const mockReadGitHubPullRequestProjection = jest.fn();
jest.mock('../lib/github-pr-read-model', () => ({
  ...jest.requireActual<object>('../lib/github-pr-read-model'),
  getGitHubPullRequestStatus: (...args: unknown[]): unknown =>
    mockGetGitHubPullRequestStatus(...args),
  invalidateGitHubPullRequest: (...args: unknown[]): unknown =>
    mockInvalidateGitHubPullRequest(...args),
  readGitHubPullRequestProjection: (...args: unknown[]): unknown =>
    mockReadGitHubPullRequestProjection(...args),
}));

jest.mock('../lib/github-poller', () => ({
  refreshNow: jest.fn(() => Promise.resolve(null)),
  requestRefresh: jest.fn(),
  startPolling: jest.fn(),
  enqueueFastRefresh: jest.fn(),
  enqueueKnownPrFastRefresh: jest.fn(() => Promise.resolve(false)),
  setForegroundWorktree: jest.fn(),
}));

// The update handler's worktree resolution; checkouts are real repositories.
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
}));
jest.mock('../lib/workspace-registry', () => ({
  isMultiRepoWorkspace: jest.fn(),
}));
jest.mock('../lib/worktree-repo-entries', () => ({
  listWorkspaceWorktreeRepoEntries: jest.fn(),
}));

jest.mock('../lib/github-pr-generator', () => ({
  generatePrContent: jest.fn(),
}));
jest.mock('../lib/commit-message-generator', () => ({
  generateCommitMessage: jest.fn(),
}));
jest.mock('../ipc/preferences', () => ({
  readPreferencesFile: jest.fn(),
}));

import {
  CORE_INTEGRATION_QUERIES,
  CORE_PULL_REQUEST_INSTRUCTION_DEFINITIONS,
  CORE_PULL_REQUEST_QUERY_DEFINITIONS,
  WORKER_GIT_REMOTE_QUERY_DEFINITIONS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '@canopy/core-runtime';
import { createWorkerGitRemoteHandlers } from '@canopy/core-runtime/node/git';
import { createCoreIntegrationAdapter } from '../canopy-runtime/core-integration-adapter';
import { createCorePullRequestAdapter } from '../canopy-runtime/core-pull-request-adapter';
import { desktopWorkerGitRemoteHost } from '../canopy-runtime/worker-git-adapter';
import {
  deriveDesktopIpcCaller,
  type DesktopIpcFrame,
  type DesktopIpcSender,
} from '../canopy-runtime/desktop-ipc-caller';
import { registerGitHubHandlers } from '../ipc/github';
import { GitHubBrokerError } from '../lib/github-broker/errors';
import { enqueueFastRefresh } from '../lib/github-poller';
import {
  __resetRepoSlugCacheForTests,
  invalidatePullRequestListingCache,
} from '../lib/github-pr-listing';
import { invalidateGitHubRepoListCache } from '../lib/github-repo-listing';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { isMultiRepoWorkspace } from '../lib/workspace-registry';
import { listWorkspaceWorktreeRepoEntries } from '../lib/worktree-repo-entries';

jest.setTimeout(120_000);

const mockedEnqueueFastRefresh = jest.mocked(enqueueFastRefresh);
const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);
const mockedIsMultiRepoWorkspace = jest.mocked(isMultiRepoWorkspace);
const mockedListWorktreeRepoEntries = jest.mocked(
  listWorkspaceWorktreeRepoEntries,
);

const NO_TOKEN_MESSAGE =
  'No GitHub token is available. Configure a PAT or sign in with the GitHub CLI.';

let dir: string;
let originalDataDir: string | undefined;
const repos: Record<string, string> = {};

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
}

function repoWithOrigin(name: string, origin: string | null): string {
  const path = join(dir, 'repos', name);
  mkdirSync(path, { recursive: true });
  git(path, ['init', '-q', '-b', 'main']);
  if (origin !== null) git(path, ['remote', 'add', 'origin', origin]);
  return path;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function handler(channel: string): Handler {
  const registered = mockHandlers.get(channel);
  if (!registered) throw new Error(`${channel} is not registered`);
  return registered;
}

// One sender for every call, so a later caller resolver can recognise it.
const IPC_EVENT = { sender: { id: 1 } };

// The real core.pullRequest, core.integration and worker.git.remote.get
// handlers and desktop hosts on a dispatcher that installs only them; the
// projected channels reach GitHub through it.
const pullRequestAdapter = createCorePullRequestAdapter();
const dispatcher = createCanopyDispatcher({
  profile: 'core+worker',
  definitions: {
    queries: {
      ...CORE_PULL_REQUEST_QUERY_DEFINITIONS,
      ...CORE_INTEGRATION_QUERIES,
      ...WORKER_GIT_REMOTE_QUERY_DEFINITIONS,
    },
    instructions: CORE_PULL_REQUEST_INSTRUCTION_DEFINITIONS,
    streams: {},
  },
  handlers: {
    queries: {
      ...pullRequestAdapter.queries,
      ...createCoreIntegrationAdapter().queries,
      ...createWorkerGitRemoteHandlers(desktopWorkerGitRemoteHost),
    },
    instructions: pullRequestAdapter.instructions,
    streams: {},
  },
});
const DESKTOP_IPC_CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['worker.filesystem.read', 'core.workspace.read'],
};
let resolveIpcCaller: (event: unknown) => CanopyCallerDescriptor = () =>
  DESKTOP_IPC_CALLER;

async function invoke(channel: string, request?: unknown): Promise<string> {
  return JSON.stringify(await handler(channel)(IPC_EVENT, request));
}

/** `{ name, message }` of the rejection, as it crosses IPC. */
async function rejection(
  channel: string,
  request?: unknown,
): Promise<{ name: string; message: string }> {
  try {
    await handler(channel)(IPC_EVENT, request);
  } catch (error: unknown) {
    if (error instanceof Error)
      return { name: error.name, message: error.message };
    throw error;
  }
  throw new Error(`${channel} resolved`);
}

function registerHandlers(): void {
  const window = {
    isDestroyed: (): boolean => false,
    webContents: {
      send: jest.fn(),
      isDestroyed: (): boolean => false,
      isCrashed: (): boolean => false,
      mainFrame: { isDestroyed: (): boolean => false, detached: false },
    },
  };
  // A partial window: these channels push no progress events.
  registerGitHubHandlers(() => window as never, {
    dispatcher,
    resolveCaller: (event) => resolveIpcCaller(event),
  });
}

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'github-pr-ipc-golden-')));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  const dataDir = join(dir, 'data');
  process.env.CANOPY_DATA_DIR = dataDir;

  repos.single = repoWithOrigin(
    'single',
    'git@github.com:golden-org/golden-repo.git',
  );
  repos.source = repoWithOrigin(
    'source',
    'https://github.com/golden-org/source.git',
  );
  repos.member = repoWithOrigin(
    'member',
    'https://x-access-token:secret@github.com/golden-org/member.git',
  );
  repos.gitlab = repoWithOrigin(
    'gitlab',
    'https://gitlab.com/golden-org/gitlab.git',
  );
  repos.sshUrl = repoWithOrigin(
    'ssh-url',
    'ssh://git@github.com/golden-org/ssh-url.git',
  );
  repos.noOrigin = repoWithOrigin('no-origin', null);
  // A GitHub checkout no workspace records.
  repos.untracked = repoWithOrigin(
    'untracked',
    'git@github.com:golden-org/untracked.git',
  );

  // Recorded workspaces, so these paths also exercise the dispatcher route
  // once one exists; the unchanged handlers do not read the records.
  const single = [
    ['golden-single', repos.single],
    ['golden-gitlab', repos.gitlab],
    ['golden-ssh-url', repos.sshUrl],
    ['golden-no-origin', repos.noOrigin],
  ] as const;
  writeJson(join(dataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      ...single.map(([id], order) => ({
        id,
        name: id,
        type: 'single-repo',
        color: '#38BDF8',
        collapsed: false,
        order,
      })),
      {
        id: 'golden-multi',
        name: 'golden-multi',
        type: 'multi-repo',
        color: '#38BDF8',
        collapsed: false,
        order: single.length,
      },
    ],
  });
  for (const [id, repoPath] of single)
    writeJson(join(dataDir, 'workspaces', id, 'workspace.json'), {
      version: 1,
      repos: [],
      type: 'single-repo',
      repoPath,
    });
  writeJson(join(dataDir, 'workspaces', 'golden-multi', 'workspace.json'), {
    version: 1,
    type: 'multi-repo',
    sourceRepoPath: repos.source,
    repos: [{ id: 'member', name: 'member', repoPath: repos.member }],
  });

  registerHandlers();
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockEnqueueCalls.length = 0;
  // No canonical read reaches GitHub unless a test fakes it.
  mockReadGitHubPullRequestProjection.mockImplementation(() =>
    Promise.reject(new Error('not faked')),
  );
  // The production credential-reset entry points, plus the slug test hook.
  invalidatePullRequestListingCache();
  invalidateGitHubRepoListCache();
  __resetRepoSlugCacheForTests();
});

function restPullRequest(
  number: number,
  overrides: {
    title?: string;
    head?: string;
    base?: string;
    headRepo?: string | null;
    user?: string | null;
    draft?: boolean;
  } = {},
): Record<string, unknown> {
  return {
    number,
    title: overrides.title ?? `PR ${number}`,
    html_url: `https://github.com/golden-org/golden-repo/pull/${number}`,
    draft: overrides.draft ?? false,
    user: overrides.user === null ? null : { login: overrides.user ?? 'octo' },
    head: {
      ref: overrides.head ?? `feature-${number}`,
      repo:
        overrides.headRepo === null
          ? null
          : { full_name: overrides.headRepo ?? 'golden-org/golden-repo' },
    },
    base: { ref: overrides.base ?? 'main' },
  };
}

describe('github:list-pull-requests', () => {
  it('lists open pull requests of the origin repository, most recently updated first', async () => {
    mockOctokit.pulls.list.mockResolvedValue({
      data: [
        restPullRequest(7, { title: 'Same repo' }),
        restPullRequest(8, { draft: true, base: 'release/1.0' }),
        restPullRequest(9, { headRepo: 'someone/golden-repo' }),
        restPullRequest(10, { headRepo: null, user: null }),
        restPullRequest(11, { headRepo: 'Golden-Org/Golden-Repo' }),
      ],
    });

    await expect(
      invoke(IPC_CHANNELS.githubListPullRequests, { repoPath: repos.single }),
    ).resolves.toBe(
      '{"pullRequests":[' +
        '{"number":7,"title":"Same repo","headRefName":"feature-7","baseRefName":"main","url":"https://github.com/golden-org/golden-repo/pull/7","authorLogin":"octo","isDraft":false,"isCrossRepo":false},' +
        '{"number":8,"title":"PR 8","headRefName":"feature-8","baseRefName":"release/1.0","url":"https://github.com/golden-org/golden-repo/pull/8","authorLogin":"octo","isDraft":true,"isCrossRepo":false},' +
        '{"number":9,"title":"PR 9","headRefName":"feature-9","baseRefName":"main","url":"https://github.com/golden-org/golden-repo/pull/9","authorLogin":"octo","isDraft":false,"isCrossRepo":true},' +
        '{"number":10,"title":"PR 10","headRefName":"feature-10","baseRefName":"main","url":"https://github.com/golden-org/golden-repo/pull/10","authorLogin":"","isDraft":false,"isCrossRepo":true},' +
        '{"number":11,"title":"PR 11","headRefName":"feature-11","baseRefName":"main","url":"https://github.com/golden-org/golden-repo/pull/11","authorLogin":"octo","isDraft":false,"isCrossRepo":false}' +
        ']}',
    );
    expect(mockOctokit.pulls.list).toHaveBeenCalledTimes(1);
    expect(mockOctokit.pulls.list).toHaveBeenCalledWith({
      owner: 'golden-org',
      repo: 'golden-repo',
      state: 'open',
      per_page: 50,
      sort: 'updated',
      direction: 'desc',
    });
    expect(mockEnqueueCalls).toEqual([
      { priority: 'high', options: undefined },
    ]);
  });

  it('lists a multi-repository member through its origin, without the userinfo', async () => {
    mockOctokit.pulls.list.mockResolvedValue({ data: [] });

    await expect(
      invoke(IPC_CHANNELS.githubListPullRequests, { repoPath: repos.member }),
    ).resolves.toBe('{"pullRequests":[]}');
    expect(mockOctokit.pulls.list).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'golden-org', repo: 'member' }),
    );
  });

  it('serves a repeated listing from the cache, shares a concurrent one, and refetches after a credential reset', async () => {
    mockOctokit.pulls.list.mockResolvedValue({ data: [restPullRequest(1)] });
    const request = { repoPath: repos.single };

    const [first, concurrent] = await Promise.all([
      invoke(IPC_CHANNELS.githubListPullRequests, request),
      invoke(IPC_CHANNELS.githubListPullRequests, request),
    ]);
    const cached = await invoke(IPC_CHANNELS.githubListPullRequests, request);
    expect(concurrent).toBe(first);
    expect(cached).toBe(first);
    expect(mockOctokit.pulls.list).toHaveBeenCalledTimes(1);

    invalidatePullRequestListingCache();
    await invoke(IPC_CHANNELS.githubListPullRequests, request);
    expect(mockOctokit.pulls.list).toHaveBeenCalledTimes(2);
  });

  it('lists an untracked checkout', async () => {
    mockOctokit.pulls.list.mockResolvedValue({ data: [] });

    await expect(
      invoke(IPC_CHANNELS.githubListPullRequests, {
        repoPath: repos.untracked,
      }),
    ).resolves.toBe('{"pullRequests":[]}');
    expect(mockOctokit.pulls.list).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'golden-org', repo: 'untracked' }),
    );
  });

  it.each([
    ['no origin', (): string => repos.noOrigin],
    ['a non-GitHub origin', (): string => repos.gitlab],
    ['an ssh:// GitHub origin', (): string => repos.sshUrl],
  ])('refuses %s without calling GitHub', async (_label, repoPath) => {
    await expect(
      rejection(IPC_CHANNELS.githubListPullRequests, { repoPath: repoPath() }),
    ).resolves.toEqual({
      name: 'Error',
      message:
        'This repository has no GitHub origin remote, so pull requests cannot be listed.',
    });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('refuses a relative path', async () => {
    await expect(
      rejection(IPC_CHANNELS.githubListPullRequests, { repoPath: 'repos/a' }),
    ).resolves.toEqual({
      name: 'Error',
      message: 'Invalid repoPath: must be an absolute path',
    });
  });

  it('rethrows the broker authentication failure unchanged', async () => {
    mockEnqueue.mockRejectedValueOnce(
      new GitHubBrokerError('not_authenticated', NO_TOKEN_MESSAGE),
    );

    await expect(
      rejection(IPC_CHANNELS.githubListPullRequests, {
        repoPath: repos.single,
      }),
    ).resolves.toEqual({
      name: 'GitHubBrokerError',
      message: NO_TOKEN_MESSAGE,
    });
  });
});

function searchNode(
  number: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    __typename: 'PullRequest',
    number,
    title: `Match ${number}`,
    url: `https://github.com/golden-org/golden-repo/pull/${number}`,
    headRefName: `match-${number}`,
    baseRefName: 'main',
    isDraft: false,
    author: { login: 'octo' },
    headRepository: { nameWithOwner: 'golden-org/golden-repo' },
    ...overrides,
  };
}

describe('github:search-pull-requests', () => {
  it('searches open pull request titles in the origin repository, capped at 20', async () => {
    mockOctokit.graphql.mockResolvedValue({
      search: {
        nodes: [
          searchNode(1, { isDraft: true }),
          searchNode(2, { author: null, headRepository: null }),
          { __typename: 'Issue', number: 3 },
          searchNode(4, { title: '' }),
          ...Array.from({ length: 20 }, (_, index) => searchNode(10 + index)),
        ],
      },
    });

    const response = await invoke(IPC_CHANNELS.githubSearchPullRequests, {
      repoPath: repos.single,
      query: '  fix "login" \\bug  ',
    });

    const parsed = JSON.parse(response) as {
      pullRequests: Array<{ number: number }>;
    };
    expect(parsed.pullRequests.map((pr) => pr.number)).toEqual([
      1, 2, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
      27,
    ]);
    expect(JSON.stringify(parsed.pullRequests.slice(0, 2))).toBe(
      '[{"number":1,"title":"Match 1","url":"https://github.com/golden-org/golden-repo/pull/1","headRefName":"match-1","baseRefName":"main","isDraft":true,"authorLogin":"octo","isCrossRepo":false},' +
        '{"number":2,"title":"Match 2","url":"https://github.com/golden-org/golden-repo/pull/2","headRefName":"match-2","baseRefName":"main","isDraft":false,"authorLogin":"","isCrossRepo":true}]',
    );
    expect(mockOctokit.graphql).toHaveBeenCalledTimes(1);
    expect(mockOctokit.graphql).toHaveBeenCalledWith(
      expect.stringContaining('query PrPickerSearch($q: String!)'),
      {
        q: 'repo:golden-org/golden-repo is:pr is:open in:title "fix" "login" "bug"',
      },
    );
    const [query] = mockOctokit.graphql.mock.calls[0] as [string, unknown];
    expect(query).toContain('search(type: ISSUE, first: 20, query: $q)');
    expect(mockEnqueueCalls).toEqual([
      {
        priority: 'high',
        options: {
          operation: 'read',
          idempotency: 'safe',
          resource: 'graphql',
          caller: 'pr-picker-search',
        },
      },
    ]);
  });

  it.each<[string, unknown, string]>([
    ['a missing request', undefined, 'Invalid pull request search request.'],
    ['an array', [], 'Invalid pull request search request.'],
    [
      'a missing query',
      { repoPath: '/repo' },
      'Invalid pull request search request.',
    ],
    [
      'a non-string repoPath',
      { repoPath: 1, query: 'x' },
      'Invalid pull request search request.',
    ],
    [
      'a relative repoPath',
      { repoPath: 'repo', query: 'x' },
      'Invalid repoPath: must be an absolute path',
    ],
    [
      'a blank query',
      { repoPath: '/repo', query: '   ' },
      'Enter a pull request title to search.',
    ],
    [
      'a query of only quotes and backslashes',
      { repoPath: '/repo', query: '"\\"' },
      'Enter a pull request title to search.',
    ],
    [
      'a query over 100 characters',
      { repoPath: '/repo', query: 'x'.repeat(101) },
      'Shorten the pull request search to 100 characters or fewer.',
    ],
  ])('refuses %s', async (_label, request, message) => {
    await expect(
      rejection(IPC_CHANNELS.githubSearchPullRequests, request),
    ).resolves.toEqual({ name: 'Error', message });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('refuses a query that exceeds the GitHub query limit once scoped', async () => {
    // 50 one-letter words fit the 100-character input; quoted and scoped to
    // this repository they pass 256 characters.
    const repoPath = repoWithOrigin(
      'long-name',
      'git@github.com:golden-org/a-repository-with-a-long-name.git',
    );

    await expect(
      rejection(IPC_CHANNELS.githubSearchPullRequests, {
        repoPath,
        query: 'x '.repeat(50).trim(),
      }),
    ).resolves.toEqual({
      name: 'Error',
      message: 'Shorten the pull request search to fit the GitHub query limit.',
    });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('refuses a repository without a GitHub origin', async () => {
    await expect(
      rejection(IPC_CHANNELS.githubSearchPullRequests, {
        repoPath: repos.gitlab,
        query: 'fix',
      }),
    ).resolves.toEqual({
      name: 'Error',
      message:
        'This repository has no GitHub origin remote, so pull requests cannot be searched.',
    });
  });

  it('refuses a malformed GraphQL envelope', async () => {
    mockOctokit.graphql.mockResolvedValue({ search: { nodes: null } });

    await expect(
      rejection(IPC_CHANNELS.githubSearchPullRequests, {
        repoPath: repos.single,
        query: 'fix',
      }),
    ).resolves.toEqual({
      name: 'Error',
      message: 'GitHub could not complete the pull request search. Try again.',
    });
  });

  it('rethrows the broker authentication failure unchanged', async () => {
    mockEnqueue.mockRejectedValueOnce(
      new GitHubBrokerError('not_authenticated', NO_TOKEN_MESSAGE),
    );

    await expect(
      rejection(IPC_CHANNELS.githubSearchPullRequests, {
        repoPath: repos.single,
        query: 'fix',
      }),
    ).resolves.toEqual({
      name: 'GitHubBrokerError',
      message: NO_TOKEN_MESSAGE,
    });
  });
});

function statusView(
  number: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ref: { owner: 'golden-org', repo: 'golden-repo', number },
    url: `https://github.com/golden-org/golden-repo/pull/${number}`,
    title: `Resolved ${number}`,
    state: 'open',
    isDraft: false,
    headBranch: `head-${number}`,
    baseBranch: 'main',
    headSha: 'a'.repeat(40),
    headRepository: 'golden-org/golden-repo',
    mergeable: 'mergeable',
    reviewDecision: null,
    checks: {
      state: 'success',
      total: 1,
      passed: 1,
      failed: 0,
      pending: 0,
      failedNames: [],
      available: true,
    },
    mergeQueue: { inQueue: false, position: null },
    fetchedAt: '2026-10-31T00:00:00.000Z',
    ...overrides,
  };
}

describe('github:resolve-pull-request', () => {
  it.each([
    ['a bare number', '42'],
    ['a # reference', '#42'],
    [
      'a URL of the origin repository in another case',
      'https://github.com/Golden-Org/Golden-Repo/pull/42',
    ],
  ])('resolves %s through the shared read model', async (_label, reference) => {
    mockGetGitHubPullRequestStatus.mockResolvedValue(statusView(42));

    await expect(
      invoke(IPC_CHANNELS.githubResolvePullRequest, {
        repoPath: repos.single,
        reference,
      }),
    ).resolves.toBe(
      '{"number":42,"title":"Resolved 42","headRefName":"head-42","baseRefName":"main","url":"https://github.com/golden-org/golden-repo/pull/42"}',
    );
    expect(mockGetGitHubPullRequestStatus).toHaveBeenCalledTimes(1);
    expect(mockGetGitHubPullRequestStatus).toHaveBeenCalledWith(
      expect.objectContaining({ number: 42 }),
      { priority: 'interactive', caller: 'pr-resolver' },
    );
    const [ref] = mockGetGitHubPullRequestStatus.mock.calls[0] as [
      { owner: string; repo: string },
    ];
    expect(`${ref.owner}/${ref.repo}`.toLowerCase()).toBe(
      'golden-org/golden-repo',
    );
  });

  it('resolves a multi-repository member against its own origin', async () => {
    mockGetGitHubPullRequestStatus.mockResolvedValue(
      statusView(5, { headRepository: 'golden-org/member' }),
    );

    await expect(
      invoke(IPC_CHANNELS.githubResolvePullRequest, {
        repoPath: repos.member,
        reference: '5',
      }),
    ).resolves.toBe(
      '{"number":5,"title":"Resolved 5","headRefName":"head-5","baseRefName":"main","url":"https://github.com/golden-org/golden-repo/pull/5"}',
    );
    expect(mockGetGitHubPullRequestStatus).toHaveBeenCalledWith(
      { owner: 'golden-org', repo: 'member', number: 5 },
      { priority: 'interactive', caller: 'pr-resolver' },
    );
  });

  it.each<[string, string, Record<string, unknown> | null, string]>([
    [
      'an unparseable reference',
      'not a pr',
      null,
      'Could not parse "not a pr" as a pull request URL or number.',
    ],
    [
      'a URL of another repository',
      'https://github.com/other-org/other-repo/pull/42',
      null,
      'Pull request other-org/other-repo#42 does not belong to the selected repository (golden-org/golden-repo).',
    ],
    [
      'a head branch in a fork',
      '42',
      { headRepository: 'someone/golden-repo' },
      "Pull request #42's branch lives in a fork (someone/golden-repo), so it cannot be checked out from this repository.",
    ],
    [
      'a head branch in a deleted fork',
      '42',
      { headRepository: null },
      "Pull request #42's branch lives in a fork (an unavailable repository), so it cannot be checked out from this repository.",
    ],
    [
      'missing branch information',
      '42',
      { headBranch: '' },
      'Pull request #42 did not include branch information.',
    ],
  ])('refuses %s', async (_label, reference, view, message) => {
    if (view)
      mockGetGitHubPullRequestStatus.mockResolvedValue(statusView(42, view));

    await expect(
      rejection(IPC_CHANNELS.githubResolvePullRequest, {
        repoPath: repos.single,
        reference,
      }),
    ).resolves.toEqual({ name: 'Error', message });
    if (!view) expect(mockGetGitHubPullRequestStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['no origin', (): string => repos.noOrigin],
    ['a non-GitHub origin', (): string => repos.gitlab],
  ])('refuses a repository with %s', async (_label, repoPath) => {
    await expect(
      rejection(IPC_CHANNELS.githubResolvePullRequest, {
        repoPath: repoPath(),
        reference: '42',
      }),
    ).resolves.toEqual({
      name: 'Error',
      message:
        'This repository has no GitHub origin remote, so a pull request cannot be resolved.',
    });
    expect(mockGetGitHubPullRequestStatus).not.toHaveBeenCalled();
  });

  it('refuses a relative path', async () => {
    await expect(
      rejection(IPC_CHANNELS.githubResolvePullRequest, {
        repoPath: 'repo',
        reference: '42',
      }),
    ).resolves.toEqual({
      name: 'Error',
      message: 'Invalid repoPath: must be an absolute path',
    });
  });

  it('rethrows the read-model authentication failure unchanged', async () => {
    mockGetGitHubPullRequestStatus.mockRejectedValue(
      new GitHubBrokerError('not_authenticated', NO_TOKEN_MESSAGE),
    );

    await expect(
      rejection(IPC_CHANNELS.githubResolvePullRequest, {
        repoPath: repos.single,
        reference: '42',
      }),
    ).resolves.toEqual({
      name: 'GitHubBrokerError',
      message: NO_TOKEN_MESSAGE,
    });
  });
});

describe('github:get-repo-slug', () => {
  it.each<[string, () => string, string]>([
    [
      'an scp-like GitHub origin',
      (): string => repos.single,
      '{"owner":"golden-org","repo":"golden-repo"}',
    ],
    [
      'an https origin of a multi-repository source',
      (): string => repos.source,
      '{"owner":"golden-org","repo":"source"}',
    ],
    [
      'an https origin with userinfo',
      (): string => repos.member,
      '{"owner":"golden-org","repo":"member"}',
    ],
    [
      'an untracked checkout',
      (): string => repos.untracked,
      '{"owner":"golden-org","repo":"untracked"}',
    ],
    [
      'an ssh:// GitHub origin, which is not parsed',
      (): string => repos.sshUrl,
      'null',
    ],
    ['a non-GitHub origin', (): string => repos.gitlab, 'null'],
    ['no origin', (): string => repos.noOrigin, 'null'],
    ['a directory that is not a repository', (): string => dir, 'null'],
  ])('answers %s', async (_label, repoPath, expected) => {
    await expect(
      invoke(IPC_CHANNELS.githubGetRepoSlug, { repoPath: repoPath() }),
    ).resolves.toBe(expected);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('keeps answering from its cache after the origin changes', async () => {
    const repoPath = repoWithOrigin(
      'slug-cache',
      'git@github.com:golden-org/before.git',
    );
    await expect(
      invoke(IPC_CHANNELS.githubGetRepoSlug, { repoPath }),
    ).resolves.toBe('{"owner":"golden-org","repo":"before"}');

    git(repoPath, [
      'remote',
      'set-url',
      'origin',
      'git@github.com:golden-org/after.git',
    ]);

    await expect(
      invoke(IPC_CHANNELS.githubGetRepoSlug, { repoPath }),
    ).resolves.toBe('{"owner":"golden-org","repo":"before"}');
  });

  it('refuses a relative path', async () => {
    await expect(
      rejection(IPC_CHANNELS.githubGetRepoSlug, { repoPath: 'repo' }),
    ).resolves.toEqual({
      name: 'Error',
      message: 'Invalid repoPath: must be an absolute path',
    });
  });
});

function restRepository(index: number): Record<string, unknown> {
  return {
    full_name: `golden-org/repo-${index}`,
    owner: { login: 'golden-org' },
    name: `repo-${index}`,
    description: index === 0 ? null : `Repository ${index}`,
    clone_url: `https://github.com/golden-org/repo-${index}.git`,
    ssh_url: `git@github.com:golden-org/repo-${index}.git`,
    html_url: `https://github.com/golden-org/repo-${index}`,
    private: index % 2 === 0,
    fork: index === 1,
    archived: index === 2,
    default_branch: index === 1 ? 'develop' : 'main',
    updated_at: '2026-10-30T12:00:00Z',
    permissions: { admin: false, push: true, pull: true },
  };
}

describe('github:list-user-repos', () => {
  it('lists up to 300 repositories in one response, 100 per request', async () => {
    let next = 0;
    mockOctokit.repos.listForAuthenticatedUser.mockImplementation(() =>
      Promise.resolve({
        data: Array.from({ length: 100 }, () => restRepository(next++)),
      }),
    );

    const response = JSON.parse(
      await invoke(IPC_CHANNELS.githubListUserRepos),
    ) as unknown[];

    expect(response).toHaveLength(300);
    expect(JSON.stringify(response.slice(0, 3))).toBe(
      '[{"fullName":"golden-org/repo-0","ownerLogin":"golden-org","name":"repo-0","description":null,"cloneUrl":"https://github.com/golden-org/repo-0.git","sshUrl":"git@github.com:golden-org/repo-0.git","htmlUrl":"https://github.com/golden-org/repo-0","isPrivate":true,"isFork":false,"isArchived":false,"defaultBranch":"main","updatedAt":"2026-10-30T12:00:00Z"},' +
        '{"fullName":"golden-org/repo-1","ownerLogin":"golden-org","name":"repo-1","description":"Repository 1","cloneUrl":"https://github.com/golden-org/repo-1.git","sshUrl":"git@github.com:golden-org/repo-1.git","htmlUrl":"https://github.com/golden-org/repo-1","isPrivate":false,"isFork":true,"isArchived":false,"defaultBranch":"develop","updatedAt":"2026-10-30T12:00:00Z"},' +
        '{"fullName":"golden-org/repo-2","ownerLogin":"golden-org","name":"repo-2","description":"Repository 2","cloneUrl":"https://github.com/golden-org/repo-2.git","sshUrl":"git@github.com:golden-org/repo-2.git","htmlUrl":"https://github.com/golden-org/repo-2","isPrivate":true,"isFork":false,"isArchived":true,"defaultBranch":"main","updatedAt":"2026-10-30T12:00:00Z"}]',
    );
    expect(
      mockOctokit.repos.listForAuthenticatedUser.mock.calls.map(
        ([params]) => params as unknown,
      ),
    ).toEqual(
      [1, 2, 3].map((page) => ({
        affiliation: 'owner,collaborator,organization_member',
        sort: 'updated',
        per_page: 100,
        page,
        request: { timeout: 15_000 },
      })),
    );
    expect(mockEnqueueCalls).toEqual(
      [1, 2, 3].map(() => ({
        priority: 'high',
        options: {
          operation: 'read',
          idempotency: 'safe',
          timeoutMs: 15_000,
        },
      })),
    );
  });

  it('stops at a short page and serves a repeated listing from the cache until a credential reset', async () => {
    mockOctokit.repos.listForAuthenticatedUser.mockResolvedValue({
      data: [restRepository(0)],
    });

    const first = await invoke(IPC_CHANNELS.githubListUserRepos);
    const cached = await invoke(IPC_CHANNELS.githubListUserRepos);
    expect(cached).toBe(first);
    expect(mockOctokit.repos.listForAuthenticatedUser).toHaveBeenCalledTimes(1);

    invalidateGitHubRepoListCache();
    await invoke(IPC_CHANNELS.githubListUserRepos);
    expect(mockOctokit.repos.listForAuthenticatedUser).toHaveBeenCalledTimes(2);
  });

  it('times out the whole lookup at 30 seconds', async () => {
    jest.useFakeTimers();
    try {
      mockEnqueue.mockImplementationOnce(() => new Promise(() => undefined));
      const outcome = rejection(IPC_CHANNELS.githubListUserRepos);
      await jest.advanceTimersByTimeAsync(30_000);
      await expect(outcome).resolves.toEqual({
        name: 'Error',
        message: 'Timed out while loading repositories from GitHub.',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('rethrows the broker authentication failure unchanged', async () => {
    mockEnqueue.mockRejectedValueOnce(
      new GitHubBrokerError('not_authenticated', NO_TOKEN_MESSAGE),
    );

    await expect(rejection(IPC_CHANNELS.githubListUserRepos)).resolves.toEqual({
      name: 'GitHubBrokerError',
      message: NO_TOKEN_MESSAGE,
    });
  });
});

/** A canonical read of a pull request, as the read model returns it. */
function readProjection(
  ref: { owner: string; repo: string; number: number },
  updatedAt = '2026-10-31T00:00:00Z',
): unknown {
  return {
    view: {
      ...statusView(ref.number),
      ref,
      url: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
    },
    detail: {
      title: `Resolved ${ref.number}`,
      body: '',
      baseSha: null,
      updatedAt,
      commentCount: 0,
      checks: [],
      checksAfter: null,
      reviewThreadCount: 0,
      unresolvedReviewThreadCount: 0,
      reviewThreadsAfter: null,
    },
  };
}

describe('github:update-pr-base-branch', () => {
  const request = {
    projectId: 'golden-single',
    worktreeId: 'wt-1',
    prNumber: 355,
    newBaseBranch: '  release/2026-04  ',
  };

  beforeEach(() => {
    // The revision and projection reads of the canonical path (CAN-4109).
    mockReadGitHubPullRequestProjection.mockImplementation(
      (ref: { owner: string; repo: string; number: number }) =>
        Promise.resolve(readProjection(ref)),
    );
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue(repos.single);
    mockOctokit.pulls.update.mockResolvedValue({
      data: {
        number: 355,
        html_url: 'https://github.com/golden-org/golden-repo/pull/355',
      },
    });
  });

  it('retargets the pull request, invalidates its read model and requests a fast refresh', async () => {
    await expect(
      invoke(IPC_CHANNELS.githubUpdatePrBaseBranch, request),
    ).resolves.toBe(
      '{"success":true,"prUrl":"https://github.com/golden-org/golden-repo/pull/355"}',
    );
    expect(mockedResolveWorktreeCwd).toHaveBeenCalledWith(
      'golden-single',
      'wt-1',
    );
    expect(mockOctokit.pulls.update).toHaveBeenCalledTimes(1);
    expect(mockOctokit.pulls.update).toHaveBeenCalledWith({
      owner: 'golden-org',
      repo: 'golden-repo',
      pull_number: 355,
      base: 'release/2026-04',
    });
    expect(mockEnqueueCalls).toEqual([
      {
        priority: 'high',
        options: { operation: 'mutation', idempotency: 'unsafe' },
      },
    ]);
    expect(mockInvalidateGitHubPullRequest).toHaveBeenCalledWith({
      owner: 'golden-org',
      repo: 'golden-repo',
      number: 355,
    });
    expect(mockedEnqueueFastRefresh).toHaveBeenCalledWith(
      'golden-single',
      'wt-1',
      false,
    );
  });

  it('retargets a multi-repository member pull request through its checkout', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedResolveWorktreeCwd.mockReturnValue(repos.source);
    mockedListWorktreeRepoEntries.mockResolvedValue([
      { repoId: 'member', repoPath: repos.member },
    ] as never);

    await invoke(IPC_CHANNELS.githubUpdatePrBaseBranch, {
      ...request,
      projectId: 'golden-multi',
      repoId: 'member',
    });

    expect(mockedListWorktreeRepoEntries).toHaveBeenCalledWith(
      'golden-multi',
      repos.source,
    );
    expect(mockOctokit.pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'golden-org', repo: 'member' }),
    );
    expect(mockedEnqueueFastRefresh).toHaveBeenCalledWith(
      'golden-multi',
      'wt-1',
      false,
    );
  });

  it.each<[string, Record<string, unknown>, string, string]>([
    [
      'an invalid project id',
      { projectId: 'Bad Id' },
      'IdentifierValidationError',
      'Invalid projectId: must be lowercase alphanumeric with hyphens',
    ],
    [
      'the read-only shared-container viewer before the worktree id',
      { projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID, worktreeId: 'Bad Id' },
      'Error',
      'Shared-container recipient workspaces are read-only',
    ],
    [
      'an invalid worktree id',
      { worktreeId: 'Bad Id' },
      'IdentifierValidationError',
      'Invalid worktreeId: must be lowercase alphanumeric with hyphens',
    ],
    [
      'an invalid repository id',
      { repoId: 'Bad Id' },
      'IdentifierValidationError',
      'Invalid repoId: must be lowercase alphanumeric with hyphens',
    ],
    [
      'a zero pull request number',
      { prNumber: 0 },
      'Error',
      'Invalid prNumber: must be a positive integer',
    ],
    [
      'a fractional pull request number',
      { prNumber: 1.5 },
      'Error',
      'Invalid prNumber: must be a positive integer',
    ],
    [
      'a blank base branch',
      { newBaseBranch: '   ' },
      'Error',
      'Invalid newBaseBranch: must not be empty',
    ],
    [
      'HEAD as the base branch',
      { newBaseBranch: ' HEAD ' },
      'Error',
      'Invalid newBaseBranch: "HEAD" is not allowed',
    ],
  ])('refuses %s before any lookup', async (_label, change, name, message) => {
    await expect(
      rejection(IPC_CHANNELS.githubUpdatePrBaseBranch, {
        ...request,
        ...change,
      }),
    ).resolves.toEqual({ name, message });
    expect(mockedResolveWorktreeCwd).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockedEnqueueFastRefresh).not.toHaveBeenCalled();
  });

  it('refuses a member repository the worktree does not have', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedListWorktreeRepoEntries.mockResolvedValue([] as never);

    await expect(
      rejection(IPC_CHANNELS.githubUpdatePrBaseBranch, {
        ...request,
        projectId: 'golden-multi',
        repoId: 'nope',
      }),
    ).resolves.toEqual({
      name: 'Error',
      message: 'Repo nope not found in project.',
    });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('refuses a checkout without an origin, naming its path', async () => {
    mockedResolveWorktreeCwd.mockReturnValue(repos.noOrigin);

    await expect(
      rejection(IPC_CHANNELS.githubUpdatePrBaseBranch, request),
    ).resolves.toEqual({
      name: 'Error',
      message: `No remote URL found for repository at ${repos.noOrigin}`,
    });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('refuses a checkout with a non-GitHub origin, naming its URL and path', async () => {
    mockedResolveWorktreeCwd.mockReturnValue(repos.gitlab);

    await expect(
      rejection(IPC_CHANNELS.githubUpdatePrBaseBranch, request),
    ).resolves.toEqual({
      name: 'Error',
      message: `Could not parse GitHub remote URL: "https://gitlab.com/golden-org/gitlab.git" (repoPath: ${repos.gitlab})`,
    });
  });

  it('rethrows a GitHub rejection unchanged, without invalidating or refreshing', async () => {
    const rejected = Object.assign(new Error('Validation Failed'), {
      name: 'HttpError',
      status: 422,
    });
    mockOctokit.pulls.update.mockRejectedValue(rejected);

    await expect(
      rejection(IPC_CHANNELS.githubUpdatePrBaseBranch, request),
    ).resolves.toEqual({ name: 'HttpError', message: 'Validation Failed' });
    expect(mockInvalidateGitHubPullRequest).not.toHaveBeenCalled();
    expect(mockedEnqueueFastRefresh).not.toHaveBeenCalled();
  });
});

// Added with CAN-4109, after the goldens above: how the projected channels
// reach the dispatcher. The responses stay the goldens' own.
describe('projection through the desktop dispatcher', () => {
  const MINTED_REPOSITORY_ID: unknown = expect.stringMatching(/^ghrepo1\./);
  const MINTED_PULL_REQUEST_ID: unknown = expect.stringMatching(/^ghpr1\./);
  const ANY_CURSOR: unknown = expect.any(String);
  let query: jest.SpyInstance;
  const pullRequestReader: { caller: CanopyCallerDescriptor } = {
    caller: { ...DESKTOP_IPC_CALLER, grants: ['core.pullRequest.read'] },
  };
  const gitReader: { caller: CanopyCallerDescriptor } = {
    caller: { ...DESKTOP_IPC_CALLER, grants: ['worker.git.read'] },
  };

  beforeEach(() => {
    query = jest.spyOn(dispatcher, 'query');
  });

  afterEach(() => {
    query.mockRestore();
    resolveIpcCaller = (): CanopyCallerDescriptor => DESKTOP_IPC_CALLER;
  });

  function frame(url: string): DesktopIpcFrame {
    return { url, detached: false, isDestroyed: () => false };
  }

  function bridgeEvent(): {
    sender: DesktopIpcSender;
    senderFrame: DesktopIpcFrame;
  } {
    const mainFrame = frame('file:///bridge.html');
    return {
      sender: {
        id: 7,
        mainFrame,
        getURL: () => mainFrame.url,
        isDestroyed: () => false,
      },
      senderFrame: mainFrame,
    };
  }

  it('lists a recorded repository through core.pullRequest.list holding only core.pullRequest.read', async () => {
    mockOctokit.pulls.list.mockResolvedValue({ data: [restPullRequest(1)] });

    await invoke(IPC_CHANNELS.githubListPullRequests, {
      repoPath: repos.member,
    });

    expect(query.mock.calls).toEqual([
      [
        'core.pullRequest.list',
        {
          integrationId: 'github',
          repositoryId: MINTED_REPOSITORY_ID,
          states: ['open'],
          cursor: null,
          limit: 50,
        },
        pullRequestReader,
      ],
    ]);
    // Today's single REST read; no GraphQL read for the canonical page.
    expect(mockOctokit.pulls.list).toHaveBeenCalledTimes(1);
    expect(mockOctokit.graphql).not.toHaveBeenCalled();
  });

  it('reaches the dispatcher as the remote device holding only core.pullRequest.read', async () => {
    mockOctokit.pulls.list.mockResolvedValue({ data: [] });
    // The tunneled call replays on the bridge window; main derives its caller.
    resolveIpcCaller = (): CanopyCallerDescriptor =>
      deriveDesktopIpcCaller(bridgeEvent(), {
        getAppWindows: () => [],
        packagedRendererUrls: [],
        resolveRemoteBridgeSender: () => 'controller-1',
      });

    await expect(
      invoke(IPC_CHANNELS.githubListPullRequests, { repoPath: repos.single }),
    ).resolves.toBe('{"pullRequests":[]}');
    expect(query.mock.calls).toEqual([
      [
        'core.pullRequest.list',
        expect.objectContaining({ states: ['open'] }),
        {
          caller: {
            principalId: 'remote-device:controller-1',
            clientInstanceId: 'remote-bridge:7',
            authorityId: 'local-desktop',
            interfaceKind: 'desktop',
            grants: ['core.pullRequest.read'],
          },
        },
      ],
    ]);
  });

  it('refuses an untracked sender for a recorded repository before GitHub is called', async () => {
    resolveIpcCaller = (): CanopyCallerDescriptor =>
      deriveDesktopIpcCaller(bridgeEvent(), {
        getAppWindows: () => [],
        packagedRendererUrls: [],
      });

    await expect(
      handler(IPC_CHANNELS.githubListPullRequests)(IPC_EVENT, {
        repoPath: repos.single,
      }),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(query).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  // Deliberate changes: these channels resolve the caller on every path.
  it.each([
    [
      'a slug cache miss of an unrecorded path',
      'githubGetRepoSlug',
      (): unknown => ({ repoPath: repos.untracked }),
    ],
    ['the repository listing', 'githubListUserRepos', (): unknown => undefined],
  ] as const)(
    'refuses an untracked sender for %s',
    async (_label, channel, request) => {
      resolveIpcCaller = (): CanopyCallerDescriptor =>
        deriveDesktopIpcCaller(bridgeEvent(), {
          getAppWindows: () => [],
          packagedRendererUrls: [],
        });

      await expect(
        handler(IPC_CHANNELS[channel])(IPC_EVENT, request()),
      ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
      expect(query).not.toHaveBeenCalled();
      expect(mockEnqueue).not.toHaveBeenCalled();
    },
  );

  it('keeps the direct listing for a path no workspace records', async () => {
    mockOctokit.pulls.list.mockResolvedValue({ data: [] });

    await invoke(IPC_CHANNELS.githubListPullRequests, {
      repoPath: repos.untracked,
    });

    expect(query).not.toHaveBeenCalled();
  });

  it('resolves through worker.git.remote.get and core.pullRequest.get, each holding one grant', async () => {
    mockGetGitHubPullRequestStatus.mockResolvedValue(statusView(42));

    await invoke(IPC_CHANNELS.githubResolvePullRequest, {
      repoPath: repos.single,
      reference: '42',
    });

    expect(query.mock.calls).toEqual([
      [
        'worker.git.remote.get',
        {
          scope: { workspaceId: 'golden-single' },
          repository: { kind: 'recorded' },
        },
        gitReader,
      ],
      [
        'core.pullRequest.get',
        {
          pullRequestId: MINTED_PULL_REQUEST_ID,
          refresh: false,
        },
        pullRequestReader,
      ],
    ]);
  });

  it('reads a recorded slug through worker.git.remote.get, and an untracked one directly', async () => {
    await invoke(IPC_CHANNELS.githubGetRepoSlug, { repoPath: repos.member });
    await invoke(IPC_CHANNELS.githubGetRepoSlug, { repoPath: repos.untracked });

    expect(query.mock.calls).toEqual([
      [
        'worker.git.remote.get',
        {
          scope: { workspaceId: 'golden-multi', repoId: 'member' },
          repository: { kind: 'recorded' },
        },
        gitReader,
      ],
    ]);
  });

  it('pages core.integration.resource.list for 300 repositories holding only core.integration.read', async () => {
    let next = 0;
    mockOctokit.repos.listForAuthenticatedUser.mockImplementation(() =>
      Promise.resolve({
        data: Array.from({ length: 100 }, () => restRepository(next++)),
      }),
    );

    await invoke(IPC_CHANNELS.githubListUserRepos);

    const reader: { caller: CanopyCallerDescriptor } = {
      caller: { ...DESKTOP_IPC_CALLER, grants: ['core.integration.read'] },
    };
    const page = {
      integrationId: 'github',
      kinds: ['repository'],
      query: null,
      limit: 200,
    };
    expect(query.mock.calls).toEqual([
      ['core.integration.resource.list', { ...page, cursor: null }, reader],
      [
        'core.integration.resource.list',
        { ...page, cursor: ANY_CURSOR },
        reader,
      ],
    ]);
    const pages = (await Promise.all(
      query.mock.results.map((result): unknown => result.value),
    )) as Array<{ resources: unknown[] }>;
    expect(pages.map(({ resources }) => resources.length)).toEqual([200, 100]);
    // One snapshot: the second page reads no GitHub page.
    expect(mockOctokit.repos.listForAuthenticatedUser).toHaveBeenCalledTimes(3);
  });

  it('returns the legacy repositories when the canonical page fails validation', async () => {
    // A name longer than the canonical resource name's 512 characters.
    const long = {
      ...restRepository(0),
      full_name: `golden-org/${'r'.repeat(600)}`,
    };
    mockOctokit.repos.listForAuthenticatedUser.mockResolvedValue({
      data: [long],
    });

    const response = JSON.parse(
      await invoke(IPC_CHANNELS.githubListUserRepos),
    ) as Array<{ fullName: string }>;

    expect(response.map((repo) => repo.fullName)).toEqual([long.full_name]);
    await expect(query.mock.results[0].value).rejects.toMatchObject({
      payload: { kind: 'internal' },
    });
  });

  describe('github:update-pr-base-branch through core.pullRequest.update', () => {
    const request = {
      projectId: 'golden-single',
      worktreeId: 'wt-1',
      prNumber: 355,
      newBaseBranch: '  release/2026-04  ',
    };
    const RESPONSE =
      '{"success":true,"prUrl":"https://github.com/golden-org/golden-repo/pull/355"}';
    const ref = { owner: 'golden-org', repo: 'golden-repo', number: 355 };
    const ANY_KEY: unknown = expect.any(String);
    let instruction: jest.SpyInstance;

    beforeEach(() => {
      instruction = jest.spyOn(dispatcher, 'instruction');
      mockReadGitHubPullRequestProjection.mockImplementation(
        (read: typeof ref) => Promise.resolve(readProjection(read)),
      );
      mockedIsMultiRepoWorkspace.mockReturnValue(false);
      mockedResolveWorktreeCwd.mockReturnValue(repos.single);
      mockOctokit.pulls.update.mockResolvedValue({
        data: {
          number: 355,
          html_url: `https://github.com/golden-org/golden-repo/pull/355`,
        },
      });
    });

    afterEach(() => {
      instruction.mockRestore();
    });

    it('reads the revision holding core.pullRequest.read, then updates holding only core.pullRequest.write', async () => {
      await expect(
        invoke(IPC_CHANNELS.githubUpdatePrBaseBranch, request),
      ).resolves.toBe(RESPONSE);

      expect(query.mock.calls).toEqual([
        [
          'core.pullRequest.get',
          { pullRequestId: MINTED_PULL_REQUEST_ID, refresh: true },
          pullRequestReader,
        ],
      ]);
      expect(instruction.mock.calls).toEqual([
        [
          'core.pullRequest.update',
          {
            pullRequestId: MINTED_PULL_REQUEST_ID,
            expectedRevision: Date.parse('2026-10-31T00:00:00Z'),
            patch: {
              title: null,
              body: null,
              baseBranch: 'release/2026-04',
              draft: null,
            },
          },
          {
            caller: {
              ...DESKTOP_IPC_CALLER,
              grants: ['core.pullRequest.write'],
            },
            metadata: { idempotencyKey: ANY_KEY },
          },
        ],
      ]);
      // The revision read, the handler's fresh read, and the read after it.
      expect(mockReadGitHubPullRequestProjection.mock.calls).toEqual([
        [ref, expect.objectContaining({ refresh: true })],
        [ref, expect.objectContaining({ refresh: true })],
        [ref, expect.objectContaining({ refresh: true })],
      ]);
      expect(mockOctokit.pulls.update).toHaveBeenCalledTimes(1);
    });

    it('reaches the update as the remote device holding only core.pullRequest.write', async () => {
      resolveIpcCaller = (): CanopyCallerDescriptor =>
        deriveDesktopIpcCaller(bridgeEvent(), {
          getAppWindows: () => [],
          packagedRendererUrls: [],
          resolveRemoteBridgeSender: () => 'controller-1',
        });

      await expect(
        invoke(IPC_CHANNELS.githubUpdatePrBaseBranch, request),
      ).resolves.toBe(RESPONSE);
      expect(instruction.mock.calls).toEqual([
        [
          'core.pullRequest.update',
          expect.objectContaining({ pullRequestId: MINTED_PULL_REQUEST_ID }),
          {
            caller: {
              principalId: 'remote-device:controller-1',
              clientInstanceId: 'remote-bridge:7',
              authorityId: 'local-desktop',
              interfaceKind: 'desktop',
              grants: ['core.pullRequest.write'],
            },
            metadata: { idempotencyKey: ANY_KEY },
          },
        ],
      ]);
      expect(mockedEnqueueFastRefresh).toHaveBeenCalledWith(
        'golden-single',
        'wt-1',
        false,
      );
    });

    it('refuses an untracked sender before GitHub is called', async () => {
      resolveIpcCaller = (): CanopyCallerDescriptor =>
        deriveDesktopIpcCaller(bridgeEvent(), {
          getAppWindows: () => [],
          packagedRendererUrls: [],
        });

      await expect(
        handler(IPC_CHANNELS.githubUpdatePrBaseBranch)(IPC_EVENT, request),
      ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
      expect(query).not.toHaveBeenCalled();
      expect(instruction).not.toHaveBeenCalled();
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(mockedEnqueueFastRefresh).not.toHaveBeenCalled();
    });

    it('refuses an untracked sender on the direct path too', async () => {
      // The checkout's origin is not the recorded repository's.
      mockedResolveWorktreeCwd.mockReturnValue(repos.untracked);
      resolveIpcCaller = (): CanopyCallerDescriptor =>
        deriveDesktopIpcCaller(bridgeEvent(), {
          getAppWindows: () => [],
          packagedRendererUrls: [],
        });

      await expect(
        handler(IPC_CHANNELS.githubUpdatePrBaseBranch)(IPC_EVENT, request),
      ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(mockedEnqueueFastRefresh).not.toHaveBeenCalled();
    });

    it('keeps the direct update when the revision moves before the update is sent', async () => {
      let reads = 0;
      mockReadGitHubPullRequestProjection.mockImplementation(
        (read: typeof ref) => {
          reads += 1;
          return Promise.resolve(
            readProjection(
              read,
              reads === 1 ? '2026-10-31T00:00:00Z' : '2026-10-31T00:00:05Z',
            ),
          );
        },
      );

      await expect(
        invoke(IPC_CHANNELS.githubUpdatePrBaseBranch, request),
      ).resolves.toBe(RESPONSE);
      await expect(instruction.mock.results[0].value).rejects.toMatchObject({
        payload: { code: 'core.pullRequest.update.revisionConflict' },
      });
      expect(mockOctokit.pulls.update).toHaveBeenCalledTimes(1);
      expect(mockEnqueueCalls).toEqual([
        {
          priority: 'high',
          options: { operation: 'mutation', idempotency: 'unsafe' },
        },
      ]);
    });

    it('keeps the direct update when the revision cannot be read', async () => {
      mockReadGitHubPullRequestProjection.mockRejectedValue(
        new GitHubBrokerError('network', 'socket hang up'),
      );

      await expect(
        invoke(IPC_CHANNELS.githubUpdatePrBaseBranch, request),
      ).resolves.toBe(RESPONSE);
      expect(instruction).not.toHaveBeenCalled();
      expect(mockOctokit.pulls.update).toHaveBeenCalledTimes(1);
    });

    it('sends a rejected update once and rethrows its error', async () => {
      const rejected = Object.assign(new Error('Validation Failed'), {
        name: 'HttpError',
        status: 422,
      });
      mockOctokit.pulls.update.mockRejectedValue(rejected);

      await expect(
        rejection(IPC_CHANNELS.githubUpdatePrBaseBranch, request),
      ).resolves.toEqual({ name: 'HttpError', message: 'Validation Failed' });
      expect(mockOctokit.pulls.update).toHaveBeenCalledTimes(1);
    });

    it('answers from the captured update when the read after it fails', async () => {
      let reads = 0;
      mockReadGitHubPullRequestProjection.mockImplementation(
        (read: typeof ref) => {
          reads += 1;
          return reads <= 2
            ? Promise.resolve(readProjection(read))
            : Promise.reject(
                new GitHubBrokerError('network', 'socket hang up'),
              );
        },
      );

      await expect(
        invoke(IPC_CHANNELS.githubUpdatePrBaseBranch, request),
      ).resolves.toBe(RESPONSE);
      await expect(instruction.mock.results[0].value).rejects.toMatchObject({
        payload: { code: 'core.pullRequest.projectionUnavailable' },
      });
      expect(mockOctokit.pulls.update).toHaveBeenCalledTimes(1);
      expect(mockInvalidateGitHubPullRequest).toHaveBeenCalledWith(ref);
      expect(mockedEnqueueFastRefresh).toHaveBeenCalledWith(
        'golden-single',
        'wt-1',
        false,
      );
    });

    it('keeps the direct update for a checkout whose origin is not the recorded one', async () => {
      mockedResolveWorktreeCwd.mockReturnValue(repos.untracked);

      await invoke(IPC_CHANNELS.githubUpdatePrBaseBranch, request);

      expect(query).not.toHaveBeenCalled();
      expect(instruction).not.toHaveBeenCalled();
      expect(mockOctokit.pulls.update).toHaveBeenCalledWith(
        expect.objectContaining({ owner: 'golden-org', repo: 'untracked' }),
      );
    });
  });
});

describe('remote control', () => {
  const CHANNELS = [
    'githubListPullRequests',
    'githubSearchPullRequests',
    'githubResolvePullRequest',
    'githubCreatePr',
    'githubPrCreationProgress',
    'githubUpdatePrBaseBranch',
    'githubGetRepoSlug',
    'githubListUserRepos',
    'settingsGitHubCliStatus',
  ] as const;

  it('tunnels every in-scope channel under its unchanged name', () => {
    const remoteProtocolContract = JSON.parse(
      readFileSync(
        join(__dirname, '../remote-control/remote-protocol-contract.json'),
        'utf8',
      ),
    ) as { tunneledChannels: string[] };
    for (const key of CHANNELS) {
      expect([key, IPC_REMOTE_DISPOSITIONS[key]]).toEqual([key, 'tunnel']);
      expect(remoteProtocolContract.tunneledChannels).toContain(
        IPC_CHANNELS[key],
      );
    }
  });
});
