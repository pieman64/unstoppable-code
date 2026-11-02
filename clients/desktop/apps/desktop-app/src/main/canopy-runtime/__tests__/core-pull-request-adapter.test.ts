// CAN-4109: core.pullRequest.* and core.integration.resource.list served by
// the desktop dispatcher over the desktop host and request handle. GitHub is
// faked at the shared read model and the repository listing; workspace
// records and the Git checkout are real.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import type {
  CanopyCallerDescriptor,
  CorePullRequestCreateParams,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  GitHubRequestError,
  mintPullRequestId,
  mintRepositoryId,
} from '@canopy/core-runtime/node/github';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import {
  listPullRequestsForIpc,
  resolvePullRequestForIpc,
} from '../github-pull-request-dispatch';
import { desktopGitHubRequestHandle } from '../../github/request-handle';
import {
  runInGitHubProjection,
  type PullRequestWriteCapture,
} from '../../github/projection-capture';
import {
  createGitHubPullRequest,
  findOpenGitHubPullRequestForBranch,
  readGitHubBranchHead,
  updateGitHubPullRequest,
} from '../../lib/github-pr-writes';
import {
  GitHubBrokerError,
  GitHubBrokerCredentialResetError,
} from '../../lib/github-broker/errors';
import { listOpenPullRequestsForRepo } from '../../lib/github-pr-listing';
import {
  getGitHubPullRequestStatus,
  githubPullRequestDetailOf,
  listGitHubPullRequestProjections,
  readGitHubPullRequestProjection,
  type GitHubPullRequestDetail,
  type GitHubPullRequestStatusView,
} from '../../lib/github-pr-read-model';
import {
  GitHubRepoListTimeoutError,
  listUserRepoSnapshot,
} from '../../lib/github-repo-listing';

jest.mock('../../services/files-service', () => ({
  listFileTreeRoots: jest.fn(),
  listFileTreeDirectory: jest.fn(),
}));
jest.mock('../../lib/github-pr-read-model', () => ({
  ...jest.requireActual<object>('../../lib/github-pr-read-model'),
  getGitHubPullRequestStatus: jest.fn(),
  githubPullRequestDetailOf: jest.fn(),
  readGitHubPullRequestProjection: jest.fn(),
  listGitHubPullRequestProjections: jest.fn(),
}));
// The GitHub calls of the write members; none reaches GitHub.
jest.mock('../../lib/github-pr-writes', () => ({
  createGitHubPullRequest: jest.fn(),
  findOpenGitHubPullRequestForBranch: jest.fn(),
  readGitHubBranchHead: jest.fn(),
  updateGitHubPullRequest: jest.fn(),
}));
jest.mock('../../lib/github-pr-listing', () => ({
  ...jest.requireActual<object>('../../lib/github-pr-listing'),
  listOpenPullRequestsForRepo: jest.fn(),
}));
jest.mock('../../lib/github-repo-listing', () => ({
  ...jest.requireActual<object>('../../lib/github-repo-listing'),
  listUserRepoSnapshot: jest.fn(),
}));

const mockedRead = jest.mocked(readGitHubPullRequestProjection);
const mockedList = jest.mocked(listGitHubPullRequestProjections);
const mockedStatus = jest.mocked(getGitHubPullRequestStatus);
const mockedDetailOf = jest.mocked(githubPullRequestDetailOf);
const mockedRestList = jest.mocked(listOpenPullRequestsForRepo);
const mockedSnapshot = jest.mocked(listUserRepoSnapshot);
const mockedCreate = jest.mocked(createGitHubPullRequest);
const mockedFindOpen = jest.mocked(findOpenGitHubPullRequestForBranch);
const mockedBranchHead = jest.mocked(readGitHubBranchHead);
const mockedUpdate = jest.mocked(updateGitHubPullRequest);

const CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['worker.filesystem.read', 'core.workspace.read'],
};
const READER: CanopyCallerDescriptor = {
  ...CALLER,
  grants: ['core.pullRequest.read'],
};
const WRITER: CanopyCallerDescriptor = {
  ...CALLER,
  grants: ['core.pullRequest.write'],
};
const RECORD = { workspaceId: 'golden-single' };
const HEAD = 'a'.repeat(40);
const ANY_SIGNAL: unknown = expect.any(AbortSignal);

let dir: string;
let repoPath: string;
let originalDataDir: string | undefined;
let runtime: DesktopCanopyDispatcher | undefined;

function git(args: string[]): void {
  execFileSync('git', ['-C', repoPath, ...args], { stdio: 'pipe' });
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function view(number = 7): GitHubPullRequestStatusView {
  return {
    ref: { owner: 'golden-org', repo: 'golden-repo', number },
    url: `https://github.com/golden-org/golden-repo/pull/${number}`,
    title: 'Normalized title',
    state: 'open',
    isDraft: true,
    headBranch: 'feature',
    baseBranch: 'main',
    headSha: HEAD,
    headRepository: 'golden-org/golden-repo',
    mergeable: 'conflicting',
    reviewDecision: null,
    checks: {
      state: 'none',
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      failedNames: [],
      available: true,
    },
    mergeQueue: { inQueue: false, position: null },
    fetchedAt: '2026-10-31T00:00:00.000Z',
  };
}

const DETAIL: GitHubPullRequestDetail = {
  title: '  Raw   title ',
  body: 'Body',
  baseSha: 'b'.repeat(40),
  updatedAt: '2026-10-31T12:00:00Z',
  commentCount: 2,
  checks: [],
  checksAfter: null,
  reviewThreadCount: 1,
  unresolvedReviewThreadCount: 0,
  reviewThreadsAfter: null,
};

function start(): DesktopCanopyDispatcher {
  runtime = createDesktopRuntime({ shutdownTimeoutMs: 1_000 });
  return runtime;
}

function pullRequestId(number = 7): string {
  const id = mintPullRequestId({
    repository: RECORD,
    github: { owner: 'golden-org', repo: 'golden-repo' },
    number,
  });
  if (id === null) throw new Error('unminted');
  return id;
}

/** Runs `change` just before each dispatch of `name`, then dispatches it. */
function beforeDispatching(
  dispatcher: DesktopCanopyDispatcher,
  name: string,
  change: () => void,
): void {
  const query = dispatcher.query.bind(dispatcher);
  jest
    .spyOn(dispatcher, 'query')
    .mockImplementation((operation, params, options) => {
      if (operation === name) change();
      return query(operation, params, options);
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
  throw new Error('resolved');
}

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'core-pr-adapter-')));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  const dataDir = join(dir, 'data');
  process.env.CANOPY_DATA_DIR = dataDir;
  repoPath = join(dir, 'repo');
  mkdirSync(repoPath, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['remote', 'add', 'origin', 'git@github.com:golden-org/golden-repo.git']);
  writeJson(join(dataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: 'golden-single',
        name: 'golden-single',
        type: 'single-repo',
        color: '#38BDF8',
        collapsed: false,
        order: 0,
      },
    ],
  });
  writeWorkspace(repoPath);
});

/** Records `path` as golden-single's repository. */
function writeWorkspace(path: string): void {
  writeJson(
    join(dir, 'data', 'workspaces', 'golden-single', 'workspace.json'),
    { version: 1, repos: [], type: 'single-repo', repoPath: path },
  );
}

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  git([
    'remote',
    'set-url',
    'origin',
    'git@github.com:golden-org/golden-repo.git',
  ]);
});

afterEach(async () => {
  await runtime?.shutdown();
  runtime = undefined;
});

describe('desktop core.pullRequest composition', () => {
  it('serves core.pullRequest.get in process from the read model projection', async () => {
    mockedRead.mockResolvedValue({ view: view(), detail: DETAIL });
    const dispatcher = start();

    const result = await dispatcher.query(
      'core.pullRequest.get',
      { pullRequestId: pullRequestId(), refresh: true },
      { caller: READER },
    );

    expect(result).toEqual({
      pullRequestId: pullRequestId(),
      integrationId: 'github',
      repositoryId: mintRepositoryId(RECORD),
      number: 7,
      title: '  Raw   title ',
      body: 'Body',
      url: 'https://github.com/golden-org/golden-repo/pull/7',
      state: 'open',
      draft: true,
      baseBranch: 'main',
      baseSha: 'b'.repeat(40),
      headBranch: 'feature',
      headSha: HEAD,
      mergeable: 'conflicting',
      reviewDecision: 'none',
      checks: [],
      reviewThreadCount: 1,
      unresolvedReviewThreadCount: 0,
      commentCount: 2,
      updatedAt: '2026-10-31T12:00:00Z',
      revision: Date.parse('2026-10-31T12:00:00Z'),
    });
    expect(mockedRead).toHaveBeenCalledWith(
      { owner: 'golden-org', repo: 'golden-repo', number: 7 },
      {
        refresh: true,
        caller: 'core-pull-request-get',
        signal: ANY_SIGNAL,
      },
    );
    // A canonical caller never reaches the resolver's legacy read.
    expect(mockedStatus).not.toHaveBeenCalled();
  });

  it('refuses an id whose repository origin now names another repository', async () => {
    git([
      'remote',
      'set-url',
      'origin',
      'git@github.com:golden-org/renamed.git',
    ]);
    const dispatcher = start();

    const error = await failure(
      dispatcher.query(
        'core.pullRequest.get',
        { pullRequestId: pullRequestId(), refresh: false },
        { caller: READER },
      ),
    );

    expect(error.payload.code).toBe('core.pullRequest.repositoryUnavailable');
    expect(mockedRead).not.toHaveBeenCalled();
  });

  it('serves core.pullRequest.list from the full GraphQL listing, never the REST one', async () => {
    mockedList.mockResolvedValue({
      pullRequests: [{ view: view(8), detail: DETAIL }],
      endCursor: null,
    });
    const dispatcher = start();
    const repositoryId = mintRepositoryId(RECORD);

    const result = await dispatcher.query(
      'core.pullRequest.list',
      {
        integrationId: 'github',
        repositoryId,
        states: ['open', 'closed'],
        cursor: null,
        limit: 100,
      },
      { caller: READER },
    );

    expect(result.pullRequests.map((pr) => pr.pullRequestId)).toEqual([
      pullRequestId(8),
    ]);
    expect(mockedList).toHaveBeenCalledWith(
      { owner: 'golden-org', repo: 'golden-repo' },
      { states: ['open', 'closed'], first: 25, after: null },
      { caller: 'core-pull-request-list', signal: ANY_SIGNAL },
    );
    expect(mockedRestList).not.toHaveBeenCalled();
  });

  it('serves core.integration.resource.list from the repository snapshot', async () => {
    mockedSnapshot.mockResolvedValue({
      id: '0.1',
      repos: [],
      access: [
        {
          fullName: 'golden-org/golden-repo',
          htmlUrl: 'https://github.com/golden-org/golden-repo',
          permissions: { pull: true, push: true, admin: false },
          updatedAt: '2026-10-30T12:00:00Z',
        },
      ],
    });
    const dispatcher = start();

    await expect(
      dispatcher.query(
        'core.integration.resource.list',
        {
          integrationId: 'github',
          kinds: ['repository'],
          query: null,
          cursor: null,
          limit: 200,
        },
        {
          caller: {
            ...CALLER,
            grants: ['core.integration.read'],
          } satisfies CanopyCallerDescriptor,
        },
      ),
    ).resolves.toEqual({
      resources: [
        expect.objectContaining({
          name: 'golden-org/golden-repo',
          locator: 'https://github.com/golden-org/golden-repo',
          capabilities: ['pull', 'push'],
        }),
      ],
      nextCursor: null,
    });
  });
});

describe('desktop core.pullRequest writes', () => {
  const ref = { owner: 'golden-org', repo: 'golden-repo', number: 7 };
  const createParams = (
    repositoryId: string | null,
  ): CorePullRequestCreateParams => ({
    integrationId: 'github',
    repositoryId: repositoryId ?? '',
    title: 'Title',
    body: 'Body',
    baseBranch: 'main',
    headBranch: 'feature',
    expectedHeadSha: HEAD,
    draft: false,
  });

  it('serves core.pullRequest.create in process over the recorded origin', async () => {
    mockedBranchHead.mockResolvedValue(HEAD);
    mockedCreate.mockResolvedValue({
      number: 7,
      url: 'https://github.com/golden-org/golden-repo/pull/7',
    });
    mockedRead.mockResolvedValue({ view: view(), detail: DETAIL });
    const dispatcher = start();

    await expect(
      dispatcher.instruction(
        'core.pullRequest.create',
        createParams(mintRepositoryId(RECORD)),
        { caller: WRITER, metadata: { idempotencyKey: 'key-1' } },
      ),
    ).resolves.toMatchObject({ pullRequestId: pullRequestId(), number: 7 });
    expect(mockedBranchHead).toHaveBeenCalledWith(
      { owner: 'golden-org', repo: 'golden-repo' },
      'feature',
      ANY_SIGNAL,
    );
    expect(mockedCreate.mock.calls).toEqual([
      [
        { owner: 'golden-org', repo: 'golden-repo' },
        {
          title: 'Title',
          body: 'Body',
          head: 'feature',
          base: 'main',
          draft: false,
        },
      ],
    ]);
  });

  it('serves core.pullRequest.update in process, sending only the patch', async () => {
    mockedRead.mockResolvedValue({ view: view(), detail: DETAIL });
    mockedUpdate.mockResolvedValue({ number: 7, url: view().url });
    const dispatcher = start();

    await dispatcher.instruction(
      'core.pullRequest.update',
      {
        pullRequestId: pullRequestId(),
        expectedRevision: Date.parse(DETAIL.updatedAt),
        patch: { title: null, body: 'New body', baseBranch: null, draft: null },
      },
      { caller: WRITER, metadata: { idempotencyKey: 'key-1' } },
    );
    expect(mockedUpdate.mock.calls).toEqual([[ref, { body: 'New body' }]]);
  });

  it('refuses a write to the read-only shared-container viewer before GitHub', async () => {
    const dispatcher = start();
    const viewer = { workspaceId: SHARED_CONTAINER_VIEWER_PROJECT_ID };

    const error = await failure(
      dispatcher.instruction(
        'core.pullRequest.create',
        createParams(mintRepositoryId(viewer)),
        { caller: WRITER, metadata: { idempotencyKey: 'key-1' } },
      ),
    );
    expect(error.payload.code).toBe('core.pullRequest.repositoryUnavailable');
    expect(mockedBranchHead).not.toHaveBeenCalled();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it.each<[string, () => void]>([
    [
      'its origin names another repository',
      (): void =>
        git([
          'remote',
          'set-url',
          'origin',
          'git@github.com:golden-org/renamed.git',
        ]),
    ],
    ['its record no longer names a repository', (): void => writeWorkspace('')],
  ])(
    'refuses a same-key create retry once %s, without reading the old origin',
    async (_label, change) => {
      mockedBranchHead.mockResolvedValue(HEAD);
      mockedCreate.mockResolvedValue({ number: 7, url: view().url });
      mockedRead.mockResolvedValue({ view: view(), detail: DETAIL });
      const dispatcher = start();
      const params = createParams(mintRepositoryId(RECORD));
      const keyed = { caller: WRITER, metadata: { idempotencyKey: 'key-1' } };
      await dispatcher.instruction('core.pullRequest.create', params, keyed);

      change();
      try {
        const error = await failure(
          dispatcher.instruction('core.pullRequest.create', params, keyed),
        );
        expect(error.payload.code).toBe(
          'core.pullRequest.repositoryUnavailable',
        );
      } finally {
        writeWorkspace(repoPath);
      }
      expect(mockedCreate).toHaveBeenCalledTimes(1);
      expect(mockedRead).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [
      'a duplicate',
      Object.assign(new Error('Validation Failed'), {
        status: 422,
        response: {
          data: {
            errors: [{ message: 'A pull request already exists for x:y.' }],
          },
        },
      }),
      'duplicate',
    ],
    [
      'a refused base',
      Object.assign(new Error('Validation Failed'), {
        status: 422,
        response: {
          data: { errors: [{ resource: 'PullRequest', field: 'base' }] },
        },
      }),
      'base_rejected',
    ],
    [
      'no credential',
      new GitHubBrokerError('not_authenticated', 'No token'),
      'not_authenticated',
    ],
  ])(
    'types %s from the create, keeping it as the cause',
    async (_label, error, code) => {
      mockedCreate.mockRejectedValue(error);
      const rejection = desktopGitHubRequestHandle.createPullRequest(
        { owner: 'golden-org', repo: 'golden-repo' },
        {
          headBranch: 'feature',
          baseBranch: 'main',
          title: 'T',
          body: '',
          draft: false,
        },
      );
      await expect(rejection).rejects.toBeInstanceOf(GitHubRequestError);
      await expect(rejection).rejects.toMatchObject({ code, cause: error });
    },
  );

  it('never types an update refusal as a duplicate', async () => {
    const error = Object.assign(new Error('A review already exists'), {
      status: 422,
    });
    mockedUpdate.mockRejectedValue(error);
    await expect(
      desktopGitHubRequestHandle.updatePullRequest(ref, { title: 'T' }),
    ).rejects.toBe(error);
  });

  it('records in a write projection that a mutation was sent, and what it wrote', async () => {
    mockedCreate.mockRejectedValue(
      Object.assign(new Error('A pull request already exists'), {
        status: 422,
      }),
    );
    mockedFindOpen.mockResolvedValue({ number: 12, url: 'https://x/12' });
    const capture: PullRequestWriteCapture = { kind: 'write' };

    await runInGitHubProjection(capture, async () => {
      await desktopGitHubRequestHandle
        .createPullRequest(
          { owner: 'golden-org', repo: 'golden-repo' },
          {
            headBranch: 'feature',
            baseBranch: 'main',
            title: 'T',
            body: '',
            draft: false,
          },
        )
        .catch(() => undefined);
      await desktopGitHubRequestHandle.findOpenPullRequest(
        { owner: 'golden-org', repo: 'golden-repo' },
        'feature',
        {},
      );
    });
    expect(capture).toEqual({
      kind: 'write',
      mutationSent: true,
      written: { number: 12, url: 'https://x/12', created: false },
    });
  });
});

describe('desktop GitHub request handle', () => {
  it.each([
    [
      new GitHubBrokerError('not_authenticated', 'No token'),
      'not_authenticated',
    ],
    [
      new GitHubBrokerCredentialResetError('credential_reset'),
      'not_authenticated',
    ],
    [new GitHubBrokerError('permission_denied', 'Forbidden'), 'not_found'],
    [new GitHubBrokerError('network', 'Offline'), 'unavailable'],
    [new GitHubBrokerError('shutdown', 'Closing'), 'unavailable'],
    [new GitHubBrokerError('cancelled', 'Cancelled'), 'cancelled'],
  ])('maps %p to %s and keeps it as the cause', async (error, code) => {
    mockedRead.mockRejectedValue(error);
    const rejection = desktopGitHubRequestHandle.getPullRequest(
      { owner: 'golden-org', repo: 'golden-repo', number: 7 },
      { refresh: false },
    );
    await expect(rejection).rejects.toBeInstanceOf(GitHubRequestError);
    await expect(rejection).rejects.toMatchObject({ code, cause: error });
  });

  it('carries the time until the rate limit lifts', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(10_000);
    try {
      mockedRead.mockRejectedValue(
        new GitHubBrokerError('rate_limited', 'Limited', { retryAt: 12_500 }),
      );
      await expect(
        desktopGitHubRequestHandle.getPullRequest(
          { owner: 'golden-org', repo: 'golden-repo', number: 7 },
          { refresh: false },
        ),
      ).rejects.toMatchObject({ code: 'rate_limited', retryAfterMs: 2_500 });
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('maps the repository lookup timeout, keeping its legacy error', async () => {
    const timeout = new GitHubRepoListTimeoutError(
      'Timed out while loading repositories from GitHub.',
    );
    mockedSnapshot.mockRejectedValue(timeout);
    await expect(
      desktopGitHubRequestHandle.listRepositories({}),
    ).rejects.toMatchObject({ code: 'timeout', cause: timeout });
    expect(timeout.name).toBe('Error');
  });

  it('cannot be changed by a consumer', () => {
    expect(Object.isFrozen(desktopGitHubRequestHandle)).toBe(true);
  });
});

describe('github:list-pull-requests through core.pullRequest.list', () => {
  const ROW = {
    number: 3,
    title: 'Row',
    headRefName: 'feature',
    baseRefName: 'main',
    url: 'https://github.com/golden-org/golden-repo/pull/3',
    authorLogin: 'dependabot[bot]',
    isDraft: false,
    isCrossRepo: false,
  };

  it('returns the REST rows the host read for the recorded origin', async () => {
    mockedRestList.mockResolvedValue([ROW]);
    const dispatcher = start();

    await expect(
      listPullRequestsForIpc(dispatcher, () => CALLER, { repoPath }),
    ).resolves.toEqual({ pullRequests: [ROW] });
    expect(mockedRestList.mock.calls).toEqual([
      [repoPath, { owner: 'golden-org', repo: 'golden-repo' }],
    ]);
    expect(mockedList).not.toHaveBeenCalled();
  });

  it('rethrows the host error itself', async () => {
    const error = new GitHubBrokerError('not_authenticated', 'No token');
    mockedRestList.mockRejectedValue(error);
    const dispatcher = start();

    await expect(
      listPullRequestsForIpc(dispatcher, () => CALLER, { repoPath }),
    ).rejects.toBe(error);
  });

  it('lists the requested path directly when its record moves under the dispatched call', async () => {
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    mockedRestList.mockResolvedValue([ROW]);
    const dispatcher = start();
    beforeDispatching(dispatcher, 'core.pullRequest.list', () =>
      writeWorkspace(elsewhere),
    );

    try {
      await expect(
        listPullRequestsForIpc(dispatcher, () => CALLER, { repoPath }),
      ).resolves.toEqual({ pullRequests: [ROW] });
    } finally {
      writeWorkspace(repoPath);
    }
    // Never the moved record's repository: the path's own direct listing.
    expect(mockedRestList.mock.calls).toEqual([[repoPath]]);
  });
});

describe('github:resolve-pull-request through core.pullRequest.get', () => {
  it('reads through the canonical query when the resolver read listed every check', async () => {
    const resolved = view(42);
    mockedStatus.mockResolvedValue(resolved);
    mockedDetailOf.mockReturnValue(DETAIL);
    const dispatcher = start();
    const query = jest.spyOn(dispatcher, 'query');

    await expect(
      resolvePullRequestForIpc(dispatcher, () => CALLER, {
        repoPath,
        reference: '#42',
      }),
    ).resolves.toEqual({
      number: 42,
      title: 'Normalized title',
      headRefName: 'feature',
      baseRefName: 'main',
      url: 'https://github.com/golden-org/golden-repo/pull/42',
    });
    expect(mockedStatus).toHaveBeenCalledWith(
      { owner: 'golden-org', repo: 'golden-repo', number: 42 },
      { priority: 'interactive', caller: 'pr-resolver' },
    );
    const get = query.mock.results[1];
    await expect(get?.value).resolves.toMatchObject({
      number: 42,
      title: '  Raw   title ',
      pullRequestId: pullRequestId(42),
    });
  });

  it('answers through the direct resolver when origin moves under the dispatched read', async () => {
    mockedStatus.mockResolvedValue({
      ...view(42),
      headRepository: 'golden-org/renamed',
    });
    const dispatcher = start();
    beforeDispatching(dispatcher, 'core.pullRequest.get', () =>
      git([
        'remote',
        'set-url',
        'origin',
        'git@github.com:golden-org/renamed.git',
      ]),
    );

    await expect(
      resolvePullRequestForIpc(dispatcher, () => CALLER, {
        repoPath,
        reference: '42',
      }),
    ).resolves.toMatchObject({ number: 42 });
    // The host refused the id minted for the old origin before GitHub; the
    // direct resolver read the origin as it is now, as the legacy call did.
    expect(mockedStatus.mock.calls).toEqual([
      [
        { owner: 'golden-org', repo: 'renamed', number: 42 },
        { priority: 'interactive', caller: 'pr-resolver' },
      ],
    ]);
  });

  it('keeps the legacy answer when the read carried no canonical detail', async () => {
    mockedStatus.mockResolvedValue(view(42));
    mockedDetailOf.mockReturnValue(undefined);
    const dispatcher = start();
    const query = jest.spyOn(dispatcher, 'query');

    await expect(
      resolvePullRequestForIpc(dispatcher, () => CALLER, {
        repoPath,
        reference: '42',
      }),
    ).resolves.toMatchObject({ number: 42 });
    await expect(query.mock.results[1]?.value).rejects.toMatchObject({
      payload: { kind: 'capability_unavailable' },
    });
  });
});
