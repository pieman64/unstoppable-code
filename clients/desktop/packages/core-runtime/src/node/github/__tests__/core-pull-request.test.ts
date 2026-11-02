/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method */
import {
  CORE_PULL_REQUEST_QUERY_DEFINITIONS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import { CanopyOperationError } from '../../../runtime/errors';
import {
  createCorePullRequestHandlers,
  GitHubRequestError,
  mintPullRequestId,
  mintRepositoryId,
  parsePullRequestId,
  parseRepositoryId,
  type CorePullRequestHost,
  type GitHubPullRequestRecord,
  type GitHubRequestHandle,
} from '..';

const READER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'test',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.pullRequest.read'],
};

const RECORD = { workspaceId: 'acme', repoId: 'api' };
const ORIGIN = { owner: 'Acme', repo: 'API' };
const HEAD = 'a'.repeat(40);

function record(
  number: number,
  overrides: Partial<GitHubPullRequestRecord> = {},
): GitHubPullRequestRecord {
  return {
    number,
    title: `PR ${number}`,
    body: '',
    url: `https://github.com/Acme/API/pull/${number}`,
    state: 'open',
    draft: false,
    baseBranch: 'main',
    baseSha: null,
    headBranch: `feature-${number}`,
    headSha: HEAD,
    mergeable: 'mergeable',
    reviewDecision: 'none',
    checks: [
      {
        checkId: 'CR_1',
        name: 'build',
        status: 'completed',
        conclusion: 'success',
        url: null,
        completedAt: '2026-10-31T00:00:00Z',
      },
    ],
    reviewThreadCount: 2,
    unresolvedReviewThreadCount: 1,
    commentCount: 3,
    updatedAt: '2026-10-31T12:00:00Z',
    ...overrides,
  };
}

const unused = (): Promise<never> => Promise.reject(new Error('unused'));

function setup(overrides: Partial<GitHubRequestHandle> = {}): {
  host: CorePullRequestHost;
  github: jest.Mocked<GitHubRequestHandle>;
  resolveRepository: jest.Mock;
  dispatcher: ReturnType<typeof dispatcherFor>;
} {
  const github = {
    describe: jest.fn(unused),
    getPullRequest: jest.fn(() => Promise.resolve(record(7))),
    listPullRequests: jest.fn(() =>
      Promise.resolve({ pullRequests: [record(7)], endCursor: null }),
    ),
    listRepositories: jest.fn(unused),
    ...overrides,
  } as jest.Mocked<GitHubRequestHandle>;
  const resolveRepository = jest.fn(() => Promise.resolve(ORIGIN));
  const host: CorePullRequestHost = { github, resolveRepository };
  return { host, github, resolveRepository, dispatcher: dispatcherFor(host) };
}

function dispatcherFor(host: CorePullRequestHost) {
  return createCanopyDispatcher({
    profile: 'core+worker',
    definitions: {
      queries: CORE_PULL_REQUEST_QUERY_DEFINITIONS,
      instructions: {},
      streams: {},
    },
    handlers: {
      queries: createCorePullRequestHandlers(host),
      instructions: {},
      streams: {},
    },
  });
}

function pullRequestId(number = 7, github = ORIGIN): string {
  const id = mintPullRequestId({ repository: RECORD, github, number });
  if (id === null) throw new Error('unminted');
  return id;
}

function repositoryId(): string {
  const id = mintRepositoryId(RECORD);
  if (id === null) throw new Error('unminted');
  return id;
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

describe('pull request identifiers', () => {
  it('round-trips repository and pull request ids', () => {
    expect(parseRepositoryId(repositoryId())).toEqual(RECORD);
    expect(parsePullRequestId(pullRequestId(9))).toEqual({
      repository: RECORD,
      github: ORIGIN,
      number: 9,
    });
    const root = mintRepositoryId({ workspaceId: 'acme' });
    expect(root && parseRepositoryId(root)).toEqual({ workspaceId: 'acme' });
  });

  it.each([
    'not-an-id',
    'ghrepo1.',
    'ghrepo1.e30',
    `ghrepo1.${Buffer.from('["acme",7]').toString('base64url')}`,
    `ghpr1.${Buffer.from('["acme",null,"acme","api",0]').toString('base64url')}`,
    `ghpr1.${Buffer.from('["acme",null,"acme","a/b",1]').toString('base64url')}`,
    // A non-canonical spelling of a valid id.
    `ghrepo1.${Buffer.from('[ "acme", "api" ]').toString('base64url')}`,
  ])('refuses %s', (id) => {
    expect(parseRepositoryId(id)).toBeNull();
    expect(parsePullRequestId(id)).toBeNull();
  });

  it('mints no id a pull request of the repository could not fit in 512 characters', () => {
    expect(mintRepositoryId({ workspaceId: 'w'.repeat(200) })).toEqual(
      expect.any(String),
    );
    expect(
      mintRepositoryId({
        workspaceId: 'w'.repeat(200),
        repoId: 'r'.repeat(200),
      }),
    ).toBeNull();
  });
});

describe('core.pullRequest.get', () => {
  it('reads the pull request its id names, after re-reading origin', async () => {
    const f = setup();
    const result = await f.dispatcher.query(
      'core.pullRequest.get',
      { pullRequestId: pullRequestId(), refresh: true },
      { caller: READER },
    );
    expect(result).toEqual({
      ...record(7),
      pullRequestId: pullRequestId(),
      integrationId: 'github',
      repositoryId: repositoryId(),
      revision: Date.parse('2026-10-31T12:00:00Z'),
    });
    expect(f.resolveRepository).toHaveBeenCalledWith(RECORD, 'read');
    expect(f.github.getPullRequest).toHaveBeenCalledWith(
      { owner: 'Acme', repo: 'API', number: 7 },
      { refresh: true, signal: expect.any(AbortSignal) },
    );
  });

  it('refuses an identifier the host did not mint before any read', async () => {
    const f = setup();
    const error = await failure(
      f.dispatcher.query(
        'core.pullRequest.get',
        { pullRequestId: repositoryId(), refresh: false },
        { caller: READER },
      ),
    );
    expect(error.payload).toMatchObject({
      kind: 'invalid_argument',
      code: 'core.pullRequest.invalidId',
    });
    expect(f.resolveRepository).not.toHaveBeenCalled();
  });

  it.each([
    ['a record that names no GitHub repository', null],
    ['an origin that names another repository', { owner: 'acme', repo: 'web' }],
  ])('refuses %s before GitHub is called', async (_label, origin) => {
    const f = setup();
    f.resolveRepository.mockResolvedValue(origin);
    const error = await failure(
      f.dispatcher.query(
        'core.pullRequest.get',
        { pullRequestId: pullRequestId(), refresh: false },
        { caller: READER },
      ),
    );
    expect(error.payload).toMatchObject({
      kind: 'failed_precondition',
      code: 'core.pullRequest.repositoryUnavailable',
    });
    expect(f.github.getPullRequest).not.toHaveBeenCalled();
  });

  it('binds the id to origin ignoring case, as GitHub names do', async () => {
    const f = setup();
    f.resolveRepository.mockResolvedValue({ owner: 'acme', repo: 'api' });
    await f.dispatcher.query(
      'core.pullRequest.get',
      { pullRequestId: pullRequestId(), refresh: false },
      { caller: READER },
    );
    expect(f.github.getPullRequest).toHaveBeenCalledWith(
      { owner: 'Acme', repo: 'API', number: 7 },
      expect.anything(),
    );
  });

  it('denies a caller without core.pullRequest.read before the handler', async () => {
    const f = setup();
    const error = await failure(
      f.dispatcher.query(
        'core.pullRequest.get',
        { pullRequestId: pullRequestId(), refresh: false },
        { caller: { ...READER, grants: ['core.integration.read'] } },
      ),
    );
    expect(error.payload.kind).toBe('permission_denied');
    expect(f.resolveRepository).not.toHaveBeenCalled();
  });

  it.each([
    [
      'not_authenticated',
      'failed_precondition',
      'core.pullRequest.notAuthenticated',
    ],
    ['not_found', 'not_found', 'core.pullRequest.notFound'],
    ['timeout', 'deadline_exceeded', undefined],
    ['unavailable', 'unavailable', undefined],
    ['invalid_response', 'internal', undefined],
    ['projection_unavailable', 'capability_unavailable', undefined],
  ] as const)(
    'maps %s to %s, keeping the host error as the runtime cause',
    async (code, kind, operationCode) => {
      const cause = new Error('https://github.com/acme/api: host message');
      const f = setup({
        getPullRequest: jest.fn(() =>
          Promise.reject(new GitHubRequestError(code, 'handle', { cause })),
        ),
      });
      const error = await failure(
        f.dispatcher.query(
          'core.pullRequest.get',
          { pullRequestId: pullRequestId(), refresh: false },
          { caller: READER },
        ),
      );
      expect(error.payload.kind).toBe(kind);
      expect(error.payload.code).toBe(operationCode);
      expect(error.payload.message).not.toContain('github.com');
      expect(error.runtimeCause).toBe(cause);
    },
  );

  it('carries the rate limit delay as the retry delay', async () => {
    const f = setup({
      getPullRequest: jest.fn(() =>
        Promise.reject(
          new GitHubRequestError('rate_limited', 'limit', {
            retryAfterMs: 1500,
          }),
        ),
      ),
    });
    const error = await failure(
      f.dispatcher.query(
        'core.pullRequest.get',
        { pullRequestId: pullRequestId(), refresh: false },
        { caller: READER },
      ),
    );
    expect(error.payload).toMatchObject({
      kind: 'resource_exhausted',
      retry: { kind: 'same_request', delayMs: 1500 },
    });
  });

  it('fails a schema-invalid record as internal', async () => {
    const f = setup({
      getPullRequest: jest.fn(() =>
        Promise.resolve(record(7, { headSha: 'not a sha' })),
      ),
    });
    const error = await failure(
      f.dispatcher.query(
        'core.pullRequest.get',
        { pullRequestId: pullRequestId(), refresh: false },
        { caller: READER },
      ),
    );
    expect(error.payload.kind).toBe('internal');
  });
});

describe('core.pullRequest.list', () => {
  const params = (overrides: Record<string, unknown> = {}) => ({
    integrationId: 'github',
    repositoryId: repositoryId(),
    states: ['open'] as ('open' | 'closed' | 'merged')[],
    cursor: null,
    limit: 50,
    ...overrides,
  });

  it('lists one page of full projections with ids for the origin repository', async () => {
    const f = setup({
      listPullRequests: jest.fn(() =>
        Promise.resolve({
          pullRequests: [record(8), record(7)],
          endCursor: null,
        }),
      ),
    });
    const result = await f.dispatcher.query(
      'core.pullRequest.list',
      params({ states: ['merged', 'open'] }),
      { caller: READER },
    );
    expect(result.nextCursor).toBeNull();
    expect(result.pullRequests.map((pr) => pr.pullRequestId)).toEqual([
      pullRequestId(8),
      pullRequestId(7),
    ]);
    // GitHub pages of at most 25; states in canonical order.
    expect(f.github.listPullRequests).toHaveBeenCalledWith(
      ORIGIN,
      { states: ['open', 'merged'], first: 25, after: null },
      { signal: expect.any(AbortSignal) },
    );
  });

  it('continues with a cursor bound to its params and origin', async () => {
    const f = setup({
      listPullRequests: jest.fn(() =>
        Promise.resolve({ pullRequests: [record(9)], endCursor: 'Y3Vyc29y' }),
      ),
    });
    const first = await f.dispatcher.query('core.pullRequest.list', params(), {
      caller: READER,
    });
    expect(first.nextCursor).toEqual(expect.any(String));
    const cursor = first.nextCursor ?? '';
    await f.dispatcher.query('core.pullRequest.list', params({ cursor }), {
      caller: READER,
    });
    expect(f.github.listPullRequests).toHaveBeenLastCalledWith(
      ORIGIN,
      { states: ['open'], first: 25, after: 'Y3Vyc29y' },
      expect.anything(),
    );

    for (const [label, retry] of [
      ['other states', params({ cursor, states: ['closed'] })],
      ['a forged cursor', params({ cursor: `${cursor.slice(0, -2)}AA` })],
    ] as const) {
      const error = await failure(
        f.dispatcher.query('core.pullRequest.list', retry, { caller: READER }),
      );
      expect([label, error.payload.code]).toEqual([
        label,
        'core.pullRequest.list.invalidFilter',
      ]);
    }
    // The origin now names another repository: the continuation is not its.
    f.resolveRepository.mockResolvedValue({ owner: 'acme', repo: 'web' });
    const moved = await failure(
      f.dispatcher.query('core.pullRequest.list', params({ cursor }), {
        caller: READER,
      }),
    );
    expect(moved.payload.code).toBe('core.pullRequest.list.invalidFilter');
  });

  it.each([
    [
      'another integration',
      { integrationId: 'gitlab' },
      'capability_unavailable',
      'core.pullRequest.integrationUnavailable',
    ],
    [
      'no repository',
      { repositoryId: null },
      'capability_unavailable',
      'core.pullRequest.list.scopeUnsupported',
    ],
    [
      'no states',
      { states: [] },
      'invalid_argument',
      'core.pullRequest.list.invalidFilter',
    ],
    [
      'an unminted repository id',
      { repositoryId: 'repo-1' },
      'invalid_argument',
      'core.pullRequest.invalidId',
    ],
  ])('refuses %s before any read', async (_label, change, kind, code) => {
    const f = setup();
    const error = await failure(
      f.dispatcher.query('core.pullRequest.list', params(change), {
        caller: READER,
      }),
    );
    expect(error.payload).toMatchObject({ kind, code });
    expect(f.github.listPullRequests).not.toHaveBeenCalled();
  });

  it('accepts a null integration as the repository own', async () => {
    const f = setup();
    await expect(
      f.dispatcher.query(
        'core.pullRequest.list',
        params({ integrationId: null }),
        { caller: READER },
      ),
    ).resolves.toMatchObject({ nextCursor: null });
  });

  it('keeps the host error as the runtime cause of a listing failure', async () => {
    const cause = new Error('No GitHub token is available.');
    const f = setup({
      listPullRequests: jest.fn(() =>
        Promise.reject(
          new GitHubRequestError('not_authenticated', 'handle', { cause }),
        ),
      ),
    });
    const error = await failure(
      f.dispatcher.query('core.pullRequest.list', params(), { caller: READER }),
    );
    expect(error.payload.code).toBe('core.pullRequest.notAuthenticated');
    expect(error.runtimeCause).toBe(cause);
  });
});
