import {
  listOpenPullRequestsForRepo,
  searchOpenPullRequestsForRepo,
  __resetPullRequestListingCacheForTests,
  invalidatePullRequestListingCache,
} from '../lib/github-pr-listing';
import { getRemoteUrl } from '../lib/git';
import { getGitHubClient } from '../lib/github-client';

jest.mock('../lib/git', () => ({
  getRemoteUrl: jest.fn(),
}));

jest.mock('../lib/github-client', () => ({
  getGitHubClient: jest.fn(),
}));

const mockGetRemoteUrl = jest.mocked(getRemoteUrl);
const mockGetGitHubClient = jest.mocked(getGitHubClient);

interface MockPullRequestListItem {
  number: number;
  title: string;
  html_url: string;
  head: { ref: string; repo: { full_name: string } | null };
  base: { ref: string };
  user: { login: string } | null;
  draft?: boolean;
}

function mockClientListing(items: MockPullRequestListItem[]): jest.Mock {
  const pullsList = jest.fn().mockResolvedValue({ data: items });
  mockGetGitHubClient.mockReturnValue({
    enqueue: <T>(fn: (octokit: unknown) => Promise<T>): Promise<T> =>
      fn({ pulls: { list: pullsList } }),
  });
  return pullsList;
}

const BASE_PR: MockPullRequestListItem = {
  number: 1825,
  title: 'Improve worktree setup performance',
  html_url: 'https://github.com/example-org/example-repo/pull/1825',
  head: {
    ref: 'tirish/2026-07-22-worktree-setup-performance',
    repo: { full_name: 'example-org/example-repo' },
  },
  base: { ref: 'develop' },
  user: { login: 'tirish' },
  draft: false,
};

describe('listOpenPullRequestsForRepo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetPullRequestListingCacheForTests();
  });

  it('maps pull request fields from the GitHub API response', async () => {
    mockGetRemoteUrl.mockResolvedValue(
      'git@github.com:example-org/example-repo.git',
    );
    const pullsList = mockClientListing([BASE_PR]);

    const result = await listOpenPullRequestsForRepo('/repo');

    expect(pullsList).toHaveBeenCalledWith({
      owner: 'example-org',
      repo: 'example-repo',
      state: 'open',
      per_page: 50,
      sort: 'updated',
      direction: 'desc',
    });
    expect(result).toEqual([
      {
        number: 1825,
        title: 'Improve worktree setup performance',
        headRefName: 'tirish/2026-07-22-worktree-setup-performance',
        baseRefName: 'develop',
        url: 'https://github.com/example-org/example-repo/pull/1825',
        authorLogin: 'tirish',
        isDraft: false,
        isCrossRepo: false,
      },
    ]);
  });

  it('flags a draft PR', async () => {
    mockGetRemoteUrl.mockResolvedValue(
      'git@github.com:example-org/example-repo.git',
    );
    mockClientListing([{ ...BASE_PR, draft: true }]);

    const [pr] = await listOpenPullRequestsForRepo('/repo');

    expect(pr).toBeDefined();
    expect(pr?.isDraft).toBe(true);
  });

  it('falls back to an empty author login when the PR has no user', async () => {
    mockGetRemoteUrl.mockResolvedValue(
      'git@github.com:example-org/example-repo.git',
    );
    mockClientListing([{ ...BASE_PR, user: null }]);

    const [pr] = await listOpenPullRequestsForRepo('/repo');

    expect(pr?.authorLogin).toBe('');
  });

  it('flags a PR as cross-repo when the head repo is null (deleted fork)', async () => {
    mockGetRemoteUrl.mockResolvedValue(
      'git@github.com:example-org/example-repo.git',
    );
    mockClientListing([
      { ...BASE_PR, head: { ref: BASE_PR.head.ref, repo: null } },
    ]);

    const [pr] = await listOpenPullRequestsForRepo('/repo');

    expect(pr?.isCrossRepo).toBe(true);
  });

  it('flags a PR as cross-repo when the head repo full_name differs from the target repo', async () => {
    mockGetRemoteUrl.mockResolvedValue(
      'git@github.com:example-org/example-repo.git',
    );
    mockClientListing([
      {
        ...BASE_PR,
        head: {
          ref: BASE_PR.head.ref,
          repo: { full_name: 'contributor/canopy' },
        },
      },
    ]);

    const [pr] = await listOpenPullRequestsForRepo('/repo');

    expect(pr?.isCrossRepo).toBe(true);
  });

  it('does not flag a PR as cross-repo when full_name matches case-insensitively', async () => {
    mockGetRemoteUrl.mockResolvedValue(
      'git@github.com:example-org/example-repo.git',
    );
    mockClientListing([
      {
        ...BASE_PR,
        head: {
          ref: BASE_PR.head.ref,
          repo: { full_name: 'Example-Org/Example-Repo' },
        },
      },
    ]);

    const [pr] = await listOpenPullRequestsForRepo('/repo');

    expect(pr?.isCrossRepo).toBe(false);
  });

  it('caches results within the TTL window and does not call octokit again', async () => {
    mockGetRemoteUrl.mockResolvedValue(
      'git@github.com:example-org/example-repo.git',
    );
    const pullsList = mockClientListing([BASE_PR]);

    const first = await listOpenPullRequestsForRepo('/repo');
    const second = await listOpenPullRequestsForRepo('/repo');

    expect(first).toBe(second);
    expect(pullsList).toHaveBeenCalledTimes(1);
    expect(mockGetRemoteUrl).toHaveBeenCalledTimes(1);
  });

  it('shares an in-flight lookup between concurrent callers', async () => {
    mockGetRemoteUrl.mockResolvedValue(
      'git@github.com:example-org/example-repo.git',
    );
    const pullsList = mockClientListing([BASE_PR]);

    const [first, second] = await Promise.all([
      listOpenPullRequestsForRepo('/repo'),
      listOpenPullRequestsForRepo('/repo'),
    ]);

    expect(first).toEqual(second);
    expect(pullsList).toHaveBeenCalledTimes(1);
  });

  it('fetches again after the production cache is invalidated', async () => {
    mockGetRemoteUrl.mockResolvedValue(
      'git@github.com:example-org/example-repo.git',
    );
    const pullsList = mockClientListing([BASE_PR]);

    await listOpenPullRequestsForRepo('/repo');
    invalidatePullRequestListingCache();
    await listOpenPullRequestsForRepo('/repo');

    expect(pullsList).toHaveBeenCalledTimes(2);
  });

  it('caches separately per repo path', async () => {
    mockGetRemoteUrl.mockResolvedValue(
      'git@github.com:example-org/example-repo.git',
    );
    const pullsList = mockClientListing([BASE_PR]);

    await listOpenPullRequestsForRepo('/repo-a');
    await listOpenPullRequestsForRepo('/repo-b');

    expect(pullsList).toHaveBeenCalledTimes(2);
  });

  it('propagates a no-remote error', async () => {
    mockGetRemoteUrl.mockResolvedValue(null);

    await expect(listOpenPullRequestsForRepo('/repo')).rejects.toThrow(
      'no GitHub origin remote',
    );
  });
});

describe('searchOpenPullRequestsForRepo', () => {
  const node = {
    __typename: 'PullRequest',
    number: 5334,
    title: 'Older title match',
    url: 'https://github.com/example-org/example-repo/pull/5334',
    headRefName: 'older-branch',
    baseRefName: 'main',
    isDraft: true,
    author: { login: 'author' },
    headRepository: { nameWithOwner: 'Example-Org/Example-Repo' },
  };

  type MockGraphql = jest.Mock<Promise<unknown>, [string, { q: string }]>;

  function holdNextSearch(graphql: MockGraphql): {
    started: Promise<void>;
    release: (value: unknown) => void;
  } {
    let release: (value: unknown) => void = () => {
      throw new Error('not initialized');
    };
    const response = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      graphql.mockImplementationOnce(() => {
        resolve();
        return response;
      });
    });
    return { started, release };
  }

  function searchClient(nodes: unknown[] = [node]): {
    graphql: MockGraphql;
    enqueue: jest.Mock;
  } {
    const graphql: MockGraphql = jest
      .fn<Promise<unknown>, [string, { q: string }]>()
      .mockResolvedValue({ search: { nodes } });
    const enqueue = jest.fn((fn: (client: unknown) => Promise<unknown>) =>
      fn({ graphql }),
    );
    mockGetGitHubClient.mockReturnValue({ enqueue });
    return { graphql, enqueue };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    invalidatePullRequestListingCache();
    mockGetRemoteUrl.mockResolvedValue(
      'git@github.com:example-org/example-repo.git',
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('uses fixed repository/open/title scope, separate variables, the cap and broker quota metadata', async () => {
    const { graphql, enqueue } = searchClient();
    expect(
      await searchOpenPullRequestsForRepo('/repo', '  older   title  '),
    ).toEqual([
      {
        number: 5334,
        title: node.title,
        url: node.url,
        headRefName: node.headRefName,
        baseRefName: 'main',
        isDraft: true,
        authorLogin: 'author',
        isCrossRepo: false,
      },
    ]);
    expect(graphql).toHaveBeenCalledWith(
      expect.stringMatching(/query PrPickerSearch.*\$q/s),
      {
        q: 'repo:example-org/example-repo is:pr is:open in:title "older" "title"',
      },
    );
    expect(graphql.mock.calls[0]?.[0]).toContain(
      'search(type: ISSUE, first: 20, query: $q)',
    );
    expect(enqueue).toHaveBeenCalledWith(expect.any(Function), 'high', {
      operation: 'read',
      idempotency: 'safe',
      resource: 'graphql',
      caller: 'pr-picker-search',
    });
  });

  it('quotes qualifier-looking words and strips boundary characters without losing words', async () => {
    const { graphql } = searchClient();
    await searchOpenPullRequestsForRepo(
      '/repo',
      'repo:other/repo is:closed in:body "word" \\tail',
    );
    expect(graphql.mock.calls[0]?.[1]).toEqual({
      q: 'repo:example-org/example-repo is:pr is:open in:title "repo:other/repo" "is:closed" "in:body" "word" "tail"',
    });
  });

  it.each([null, 12, '', '  ', '" \\ "', 'a'.repeat(101)])(
    'rejects invalid input %p before any remote or broker work',
    async (query) => {
      searchClient();
      await expect(
        searchOpenPullRequestsForRepo('/repo', query),
      ).rejects.toThrow();
      expect(mockGetRemoteUrl).not.toHaveBeenCalled();
      expect(mockGetGitHubClient).not.toHaveBeenCalled();
    },
  );

  it.each(['relative', '', null, 42])(
    'rejects invalid direct-call paths %p',
    async (repoPath) => {
      searchClient();
      await expect(
        searchOpenPullRequestsForRepo(repoPath, 'title'),
      ).rejects.toThrow('absolute path');
      expect(mockGetRemoteUrl).not.toHaveBeenCalled();
    },
  );

  it('enforces the full query budget including repository and quote expansion', async () => {
    const { graphql } = searchClient();
    const query = Array(50).fill('a').join(' ');
    mockGetRemoteUrl.mockResolvedValue(
      'git@github.com:' + 'o'.repeat(39) + '/' + 'r'.repeat(100) + '.git',
    );
    await expect(searchOpenPullRequestsForRepo('/repo', query)).rejects.toThrow(
      /shorten/i,
    );
    expect(graphql).not.toHaveBeenCalled();
  });

  it('accepts exactly 256 constructed characters and rejects 257 without dropping tokens', async () => {
    const { graphql } = searchClient();
    const input = Array(50).fill('a').join(' ');
    const tokens = Array(50).fill('"a"').join(' ');
    const repoLength =
      256 - 'repo:o/ is:pr is:open in:title '.length - tokens.length;
    mockGetRemoteUrl.mockResolvedValue(
      `git@github.com:o/${'r'.repeat(repoLength)}.git`,
    );
    await searchOpenPullRequestsForRepo('/repo', input);
    expect(graphql.mock.calls[0]?.[1].q).toHaveLength(256);
    mockGetRemoteUrl.mockResolvedValue(
      `git@github.com:o/${'r'.repeat(repoLength + 1)}.git`,
    );
    await expect(
      searchOpenPullRequestsForRepo('/other', input),
    ).rejects.toThrow(/shorten/i);
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it('does not repopulate an invalidated cache when the only pending request completes', async () => {
    const { graphql } = searchClient();
    const { started, release } = holdNextSearch(graphql);
    const pending = searchOpenPullRequestsForRepo('/repo', 'title');
    await started;
    invalidatePullRequestListingCache();
    release({ search: { nodes: [node] } });
    await pending;
    await searchOpenPullRequestsForRepo('/repo', 'title');
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it('skips malformed nodes and preserves fork safety and null authors', async () => {
    searchClient([
      null,
      { __typename: 'Issue' },
      { ...node, title: null },
      { ...node, number: -1 },
      { ...node, headRefName: '' },
      { ...node, isDraft: undefined },
      { ...node, author: null },
      { ...node, headRepository: null },
      { ...node, headRepository: { nameWithOwner: 'fork/repo' } },
    ]);
    const result = await searchOpenPullRequestsForRepo('/repo', 'title');
    expect(result).toHaveLength(3);
    expect(result.map((pr) => pr.isCrossRepo)).toEqual([false, true, true]);
    expect(result[0]?.authorLogin).toBe('');
  });

  it('reuses normalized concurrent queries and separates repository paths and queries', async () => {
    const { graphql } = searchClient();
    await Promise.all([
      searchOpenPullRequestsForRepo('/repo', ' older  title '),
      searchOpenPullRequestsForRepo('/repo', '"older" title'),
    ]);
    expect(graphql).toHaveBeenCalledTimes(1);
    await searchOpenPullRequestsForRepo('/other', 'older title');
    await searchOpenPullRequestsForRepo('/repo', 'different');
    expect(graphql).toHaveBeenCalledTimes(3);
  });

  it('caches empty success and expires at 60 seconds', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const { graphql } = searchClient([]);
    await searchOpenPullRequestsForRepo('/repo', 'title');
    now.mockReturnValue(60999);
    expect(await searchOpenPullRequestsForRepo('/repo', 'title')).toEqual([]);
    expect(graphql).toHaveBeenCalledTimes(1);
    now.mockReturnValue(61000);
    await searchOpenPullRequestsForRepo('/repo', 'title');
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest successful entry at the 100-entry bound', async () => {
    const { graphql } = searchClient();
    for (let i = 0; i < 101; i++)
      await searchOpenPullRequestsForRepo('/repo', `title${i}`);
    await searchOpenPullRequestsForRepo('/repo', 'title1');
    expect(graphql).toHaveBeenCalledTimes(101);
    await searchOpenPullRequestsForRepo('/repo', 'title0');
    expect(graphql).toHaveBeenCalledTimes(102);
  });

  it.each([
    'authentication required',
    'rate limit',
    'network failure',
    'GraphQL failure',
  ])('propagates %s and permits retry', async (message) => {
    const { graphql } = searchClient();
    graphql.mockRejectedValueOnce(new Error(message));
    await expect(
      searchOpenPullRequestsForRepo('/repo', 'title'),
    ).rejects.toThrow(message);
    await expect(
      searchOpenPullRequestsForRepo('/repo', 'title'),
    ).resolves.toHaveLength(1);
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it.each([
    {},
    { search: null },
    { search: { nodes: null } },
    { search: { nodes: [] }, errors: [{ message: 'partial failure' }] },
  ])('rejects malformed or partial responses %p', async (response) => {
    const { graphql } = searchClient();
    graphql.mockResolvedValueOnce(response);
    await expect(
      searchOpenPullRequestsForRepo('/repo', 'title'),
    ).rejects.toThrow();
    await searchOpenPullRequestsForRepo('/repo', 'title');
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it('propagates missing origin without calling GitHub', async () => {
    const { graphql } = searchClient();
    mockGetRemoteUrl.mockResolvedValue(null);
    await expect(
      searchOpenPullRequestsForRepo('/repo', 'title'),
    ).rejects.toThrow('no GitHub origin');
    expect(graphql).not.toHaveBeenCalled();
  });

  it('prevents stale cache writes and pending cleanup across credential invalidation', async () => {
    const { graphql } = searchClient();
    const { started, release } = holdNextSearch(graphql);
    const stale = searchOpenPullRequestsForRepo('/repo', 'title');
    await started;
    invalidatePullRequestListingCache();
    await searchOpenPullRequestsForRepo('/repo', 'title');
    release({ search: { nodes: [] } });
    expect(await stale).toEqual([]);
    expect(await searchOpenPullRequestsForRepo('/repo', 'title')).toHaveLength(
      1,
    );
    expect(graphql).toHaveBeenCalledTimes(2);
    invalidatePullRequestListingCache();
    await searchOpenPullRequestsForRepo('/repo', 'title');
    expect(graphql).toHaveBeenCalledTimes(3);
  });
});
