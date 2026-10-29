jest.mock('../lib/git', () => ({
  getRemoteUrl: jest.fn(),
  getCurrentBranch: jest.fn(),
}));

jest.mock('../lib/github-client', () => ({
  getGitHubClient: jest.fn(),
}));

jest.mock('../lib/github-octokit-loader', () => {
  class TestOctokit {}
  return { loadOctokitConstructor: (): typeof TestOctokit => TestOctokit };
});

jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
}));

jest.mock('../lib/worktree-repo-entries', () => ({
  listWorkspaceWorktreeRepoEntries: jest.fn(),
}));

jest.mock('../lib/workspace-registry', () => ({
  isMultiRepoWorkspace: jest.fn(),
}));

import { getCurrentBranch, getRemoteUrl } from '../lib/git';
import {
  getGitHubBroker,
  resetGitHubBrokerForTests,
} from '../lib/github-broker';
import { GitHubBrokerError } from '../lib/github-broker/errors';
import {
  getGitHubClient,
  type GitHubClient,
  type GitHubClientEnqueueOptions,
} from '../lib/github-client';
import {
  closePrForRepo,
  createPrForRepo,
  fetchArchivedPullRequestMetadata,
  fetchRepoPrTrackingData,
  fetchTrackedPullRequestData,
  fetchPrStatusForRepo,
  fetchPrStatusForWorktree,
  hasGitHubPullRequestHistoryForBranch,
  listOpenPrsBasedOnBranchForRepo,
  mergePrForRepo,
  parseGitHubRemote,
  PR_MERGE_RETRY_DELAYS_MS,
  updatePrBodyForRepo,
} from '../lib/github-pr';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { listWorkspaceWorktreeRepoEntries } from '../lib/worktree-repo-entries';
import { isMultiRepoWorkspace } from '../lib/workspace-registry';

const mockedGetCurrentBranch = jest.mocked(getCurrentBranch);
const mockedGetRemoteUrl = jest.mocked(getRemoteUrl);
const mockedGetGitHubClient = jest.mocked(getGitHubClient);
const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);
const mockedListWorkspaceWorktreeRepoEntries = jest.mocked(
  listWorkspaceWorktreeRepoEntries,
);
const mockedIsMultiRepoWorkspace = jest.mocked(isMultiRepoWorkspace);
/** A merge queue read time; its value is the clock at the read. */
const ANY_STRING: unknown = expect.any(String);

type MergePrTestOctokit = {
  repos: { get: jest.Mock };
  pulls: { merge: jest.Mock; get: jest.Mock };
  graphql?: jest.Mock;
};

describe('parseGitHubRemote', () => {
  it('parses SSH remote URLs', () => {
    expect(parseGitHubRemote('git@github.com:acme/example-repo.git')).toEqual({
      owner: 'acme',
      repo: 'example-repo',
    });
  });

  it('parses HTTPS remote URLs', () => {
    expect(
      parseGitHubRemote('https://github.com/acme/example-repo.git'),
    ).toEqual({ owner: 'acme', repo: 'example-repo' });
  });

  it('parses HTTPS remote URLs with user@ prefix', () => {
    expect(
      parseGitHubRemote(
        'https://tirish@github.com/unstoppabledomains/epp-client.git',
      ),
    ).toEqual({ owner: 'unstoppabledomains', repo: 'epp-client' });
  });

  it('parses HTTPS remote URLs without .git suffix', () => {
    expect(parseGitHubRemote('https://github.com/acme/example-repo')).toEqual({
      owner: 'acme',
      repo: 'example-repo',
    });
  });

  it('parses repo names containing dots', () => {
    expect(parseGitHubRemote('git@github.com:acme/my.repo.git')).toEqual({
      owner: 'acme',
      repo: 'my.repo',
    });
  });

  it('returns null for non-GitHub URLs', () => {
    expect(parseGitHubRemote('https://gitlab.com/acme/repo.git')).toBeNull();
  });
});

describe('fetchArchivedPullRequestMetadata', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );
  });

  interface PullListRequest {
    owner: string;
    repo: string;
    head: string;
    state: 'open' | 'all';
    sort: 'updated';
    direction: 'desc';
    per_page: number;
  }

  interface PullListOctokit {
    pulls: {
      list(request: PullListRequest): Promise<{ data: unknown[] }>;
    };
  }

  function isPullListOperation(
    value: unknown,
  ): value is (octokit: PullListOctokit) => Promise<unknown> {
    return typeof value === 'function';
  }

  function installPullListMock(responses: Array<{ data: unknown[] } | Error>): {
    requests: PullListRequest[];
    enqueueOptions: GitHubClientEnqueueOptions[];
    enqueueCallCount: () => number;
  } {
    const queuedResponses = [...responses];
    const requests: PullListRequest[] = [];
    const enqueueOptions: GitHubClientEnqueueOptions[] = [];
    let enqueueCallCount = 0;
    const list = (request: PullListRequest): Promise<{ data: unknown[] }> => {
      requests.push(request);
      const response = queuedResponses.shift();
      if (!response) {
        return Promise.reject(new Error('Missing pull-list test response.'));
      }
      if (response instanceof Error) return Promise.reject(response);
      return Promise.resolve(response);
    };
    const enqueue: GitHubClient['enqueue'] = <T>(
      request: unknown,
      _priority?: 'high' | 'normal',
      options: GitHubClientEnqueueOptions = {},
    ): Promise<T> => {
      if (!isPullListOperation(request)) {
        return Promise.reject(new Error('Expected pull-list operation.'));
      }
      enqueueCallCount += 1;
      enqueueOptions.push(options);
      return request({ pulls: { list } });
    };
    const client: GitHubClient = { enqueue };
    mockedGetGitHubClient.mockReturnValue(client);
    return {
      requests,
      enqueueOptions,
      enqueueCallCount: () => enqueueCallCount,
    };
  }

  it('prefers an open draft and uses only the explicitly ordered list request', async () => {
    const { requests, enqueueOptions, enqueueCallCount } = installPullListMock([
      {
        data: [
          {
            number: 42,
            title: 'Archive display state',
            html_url: 'https://github.com/acme/example-repo/pull/42',
            updated_at: '2026-08-01T12:30:00Z',
            merged_at: null,
            draft: true,
            state: 'open',
            base: { ref: 'develop' },
            head: { sha: 'abc123' },
          },
        ],
      },
    ]);

    await expect(
      fetchArchivedPullRequestMetadata('/tmp/repo', 'feature/archive', {
        timeoutMs: 5_000,
      }),
    ).resolves.toEqual({
      number: 42,
      title: 'Archive display state',
      url: 'https://github.com/acme/example-repo/pull/42',
      state: 'draft',
      baseRefName: 'develop',
      updatedAt: '2026-08-01T12:30:00.000Z',
    });
    expect(requests).toEqual([
      {
        owner: 'acme',
        repo: 'example-repo',
        head: 'acme:feature/archive',
        state: 'open',
        sort: 'updated',
        direction: 'desc',
        per_page: 1,
      },
    ]);
    expect(enqueueCallCount()).toBe(1);
    expect(enqueueOptions[0]).toMatchObject({
      operation: 'read',
      idempotency: 'safe',
    });
    expect(enqueueOptions[0]?.timeoutMs).toBeGreaterThan(0);
  });

  it('falls back to history and derives merged state from merged_at', async () => {
    const { requests } = installPullListMock([
      { data: [] },
      {
        data: [
          {
            number: 17,
            title: 'Historical change',
            html_url: 'https://github.com/acme/example-repo/pull/17',
            updated_at: '2026-07-01T00:00:00.000Z',
            merged_at: '2026-06-30T00:00:00Z',
            // GitHub can retain draft=true in an inconsistent historical
            // payload; merged_at remains authoritative.
            draft: true,
            state: 'closed',
            base: { ref: 'main' },
            head: { sha: 'def456' },
          },
        ],
      },
    ]);

    const result = await fetchArchivedPullRequestMetadata(
      '/tmp/repo',
      'feature/archive',
    );
    expect(result?.number).toBe(17);
    expect(result?.state).toBe('merged');
    expect(requests.map((request) => request.state)).toEqual(['open', 'all']);
    expect(requests[1]).toMatchObject({
      sort: 'updated',
      direction: 'desc',
      per_page: 1,
    });
  });

  it('returns closed history and distinguishes a confirmed no-match', async () => {
    installPullListMock([
      { data: [] },
      {
        data: [
          {
            number: 8,
            title: 'Closed change',
            html_url: 'https://github.com/acme/example-repo/pull/8',
            updated_at: '2026-06-01T00:00:00.000Z',
            merged_at: null,
            // Closed is authoritative even when GitHub retains draft=true on
            // a historical pull request.
            draft: true,
            state: 'closed',
            base: { ref: 'main' },
            head: { sha: '123abc' },
          },
        ],
      },
    ]);
    await expect(
      fetchArchivedPullRequestMetadata('/tmp/repo', 'old-branch'),
    ).resolves.toEqual(expect.objectContaining({ state: 'closed' }));

    installPullListMock([{ data: [] }, { data: [] }]);
    await expect(
      fetchArchivedPullRequestMetadata('/tmp/repo', 'missing-branch'),
    ).resolves.toBeNull();
  });

  it('throws for missing or unsupported remotes without calling GitHub', async () => {
    mockedGetRemoteUrl.mockResolvedValueOnce(null);
    await expect(
      fetchArchivedPullRequestMetadata('/tmp/repo', 'feature'),
    ).rejects.toThrow('No remote URL');
    mockedGetRemoteUrl.mockResolvedValueOnce(
      'https://gitlab.com/acme/example-repo.git',
    );
    await expect(
      fetchArchivedPullRequestMetadata('/tmp/repo', 'feature'),
    ).rejects.toThrow('not supported');
    expect(mockedGetGitHubClient).not.toHaveBeenCalled();
  });

  it('forwards abort and one shrinking overall deadline to both list calls', async () => {
    const controller = new AbortController();
    const now = jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_100)
      .mockReturnValueOnce(1_500);
    const { enqueueOptions } = installPullListMock([
      { data: [] },
      { data: [] },
    ]);
    try {
      await fetchArchivedPullRequestMetadata('/tmp/repo', 'feature', {
        timeoutMs: 5_000,
        signal: controller.signal,
      });
    } finally {
      now.mockRestore();
    }
    expect(enqueueOptions[0]).toMatchObject({
      timeoutMs: 4_900,
      signal: controller.signal,
    });
    expect(enqueueOptions[1]).toMatchObject({
      timeoutMs: 4_500,
      signal: controller.signal,
    });

    controller.abort();
    await expect(
      fetchArchivedPullRequestMetadata('/tmp/repo', 'feature', {
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled');
  });

  it('propagates authentication, network, API, and timeout failures', async () => {
    for (const message of [
      'authentication failed',
      'network unavailable',
      'API unavailable',
      'request timed out',
    ]) {
      installPullListMock([new Error(message)]);
      await expect(
        fetchArchivedPullRequestMetadata('/tmp/repo', 'feature'),
      ).rejects.toThrow(message);
    }
  });
});

describe('fetchPrStatusForRepo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses detailed PR data for comments and conflict state', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );

    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            number: 42,
            html_url: 'https://github.com/acme/example-repo/pull/42',
            state: 'open',
            draft: false,
            head: { sha: 'abc123' },
            title: 'List response title',
            updated_at: '2026-03-10T00:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        data: {
          number: 42,
          html_url: 'https://github.com/acme/example-repo/pull/42',
          state: 'open',
          draft: false,
          title: 'Detailed PR title',
          updated_at: '2026-03-10T00:00:00.000Z',
          merged_at: null,
          mergeable: false,
          comments: 2,
          review_comments: 3,
        },
      })
      .mockResolvedValueOnce({
        data: {
          check_runs: [
            {
              name: 'test',
              status: 'completed',
              conclusion: 'success',
              details_url: 'https://example.com/check',
              html_url: 'https://example.com/check',
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: [
          {
            state: 'APPROVED',
            user: { login: 'reviewer' },
          },
        ],
      });

    mockedGetGitHubClient.mockReturnValue({
      enqueue,
    });

    const result = await fetchPrStatusForRepo('/tmp/repo', 'feature-branch');

    expect(result).toEqual(
      expect.objectContaining({
        prNumber: 42,
        title: 'Detailed PR title',
        hasConflicts: true,
        mergeable: false,
        mergeableState: null,
        commentCount: 5,
        checkStatus: 'passing',
        reviewStatus: 'approved',
      }),
    );
  });

  it('keeps each GitHub check state beside the four-value status', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );
    // [name, raw status, conclusion, coarse status, detailed state]
    const cases: Array<
      [string, string, string | null, string, string | undefined]
    > = [
      ['a-requested', 'requested', null, 'pending', 'queued'],
      ['b-queued', 'queued', null, 'pending', 'queued'],
      ['c-waiting', 'waiting', null, 'pending', 'queued'],
      ['d-pending', 'pending', null, 'pending', 'queued'],
      ['e-in-progress', 'in_progress', null, 'pending', 'running'],
      // A nonterminal run reports its raw status even with a conclusion.
      [
        'f-in-progress-concluded',
        'in_progress',
        'failure',
        'pending',
        'running',
      ],
      ['g-queued-concluded', 'queued', 'success', 'pending', 'queued'],
      ['h-success', 'completed', 'success', 'passing', 'success'],
      ['i-failure', 'completed', 'failure', 'failing', 'failure'],
      [
        'j-startup-failure',
        'completed',
        'startup_failure',
        'failing',
        'failure',
      ],
      ['k-cancelled', 'completed', 'cancelled', 'failing', 'cancelled'],
      ['l-timed-out', 'completed', 'timed_out', 'failing', 'timed_out'],
      ['m-skipped', 'completed', 'skipped', 'neutral', 'skipped'],
      [
        'n-action-required',
        'completed',
        'action_required',
        'neutral',
        'action_required',
      ],
      ['o-neutral', 'completed', 'neutral', 'neutral', 'neutral'],
      ['p-stale', 'completed', 'stale', 'neutral', 'neutral'],
      // Unrecognized input omits the optional detail; the coarse status is
      // whatever it was before.
      ['q-completed-null', 'completed', null, 'pending', undefined],
      ['r-completed-unknown', 'completed', 'mystery', 'pending', undefined],
      ['s-unknown-status', 'mystery', null, 'pending', undefined],
    ];
    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            number: 42,
            html_url: 'https://github.com/acme/example-repo/pull/42',
            state: 'open',
            draft: false,
            head: { sha: 'abc123' },
            title: 'Checks',
            updated_at: '2026-10-03T00:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        data: {
          number: 42,
          html_url: 'https://github.com/acme/example-repo/pull/42',
          state: 'open',
          draft: false,
          title: 'Checks',
          updated_at: '2026-10-03T00:00:00.000Z',
          merged_at: null,
          mergeable: true,
          comments: 0,
          review_comments: 0,
        },
      })
      .mockResolvedValueOnce({
        data: {
          // Reverse order proves the projection keeps desktop name order.
          check_runs: [...cases]
            .reverse()
            .map(([name, status, conclusion], index) => ({
              id: index + 1,
              name,
              status,
              conclusion,
              details_url: `https://example.com/checks/${name}`,
            })),
        },
      })
      .mockResolvedValueOnce({ data: [] });
    mockedGetGitHubClient.mockReturnValue({ enqueue });

    const result = await fetchPrStatusForRepo('/tmp/repo', 'feature-branch');

    expect(result?.checkDetails).toEqual(
      cases.map(([name, , , status, executionState]) => ({
        name,
        status,
        ...(executionState === undefined ? {} : { executionState }),
        detailsUrl: `https://example.com/checks/${name}`,
      })),
    );
    for (const detail of result?.checkDetails ?? []) {
      if (detail.executionState === undefined) {
        expect(detail).not.toHaveProperty('executionState');
      }
    }
    expect(result?.checkStatus).toBe('failing');
  });

  it('classifies a closed draft PR as closed', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );
    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            number: 42,
            html_url: 'https://github.com/acme/example-repo/pull/42',
            state: 'closed',
            draft: true,
            head: { sha: 'abc123' },
            title: 'Closed draft',
            updated_at: '2026-03-10T00:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        data: {
          number: 42,
          html_url: 'https://github.com/acme/example-repo/pull/42',
          state: 'closed',
          draft: true,
          title: 'Closed draft',
          updated_at: '2026-03-10T00:00:00.000Z',
          merged_at: null,
          mergeable: false,
          mergeable_state: 'dirty',
          comments: 0,
          review_comments: 0,
        },
      })
      .mockResolvedValueOnce({ data: { check_runs: [] } })
      .mockResolvedValueOnce({ data: [] });
    mockedGetGitHubClient.mockReturnValue({ enqueue });

    const result = await fetchPrStatusForRepo('/tmp/repo', 'feature-branch');

    expect(result?.state).toBe('closed');
  });

  it('prefers an open PR over historical merged PRs for a reused branch name', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );

    const pullsList = jest.fn((params: { state: string }) => {
      if (params.state === 'open') {
        return Promise.resolve({
          data: [
            {
              number: 51,
              html_url: 'https://github.com/acme/example-repo/pull/51',
              state: 'open',
              draft: false,
              head: { sha: 'new-sha' },
              title: 'Current open PR',
              created_at: '2026-03-11T00:00:00.000Z',
              updated_at: '2026-03-11T00:00:00.000Z',
            },
          ],
        });
      }

      return Promise.resolve({
        data: [
          {
            number: 42,
            html_url: 'https://github.com/acme/example-repo/pull/42',
            state: 'closed',
            merged_at: '2026-03-10T00:00:00.000Z',
            draft: false,
            head: { sha: 'old-sha' },
            title: 'Old merged PR',
            created_at: '2026-03-09T00:00:00.000Z',
            updated_at: '2026-03-10T00:00:00.000Z',
          },
        ],
      });
    });
    const pullsGet = jest.fn().mockResolvedValue({
      data: {
        number: 51,
        html_url: 'https://github.com/acme/example-repo/pull/51',
        state: 'open',
        draft: false,
        title: 'Current open PR',
        created_at: '2026-03-11T00:00:00.000Z',
        updated_at: '2026-03-11T00:00:00.000Z',
        merged_at: null,
        mergeable: true,
        comments: 0,
        review_comments: 0,
        head: { sha: 'new-sha' },
      },
    });
    const listForRef = jest.fn().mockResolvedValue({
      data: { check_runs: [] },
    });
    const listReviews = jest.fn().mockResolvedValue({ data: [] });
    const enqueue = jest.fn((operation: (octokit: unknown) => unknown) =>
      operation({
        pulls: {
          list: pullsList,
          get: pullsGet,
          listReviews,
        },
        checks: {
          listForRef,
        },
      }),
    );

    mockedGetGitHubClient.mockReturnValue({
      enqueue,
    });

    const result = await fetchPrStatusForRepo('/tmp/repo', 'feature-branch');

    expect(result).toEqual(
      expect.objectContaining({
        prNumber: 51,
        state: 'open',
        title: 'Current open PR',
      }),
    );
    expect(pullsList).toHaveBeenCalledTimes(1);
    expect(pullsList).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'open' }),
    );
  });

  it('treats mergeable_state dirty as conflicting while mergeable is still null', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );

    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            number: 42,
            html_url: 'https://github.com/acme/example-repo/pull/42',
            state: 'open',
            draft: false,
            head: { sha: 'abc123' },
            title: 'List response title',
            updated_at: '2026-03-10T00:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        data: {
          number: 42,
          html_url: 'https://github.com/acme/example-repo/pull/42',
          state: 'open',
          draft: false,
          title: 'Detailed PR title',
          updated_at: '2026-03-10T00:00:00.000Z',
          merged_at: null,
          mergeable: null,
          mergeable_state: 'dirty',
          comments: 2,
          review_comments: 3,
        },
      })
      .mockResolvedValueOnce({
        data: {
          check_runs: [],
        },
      })
      .mockResolvedValueOnce({
        data: [],
      });

    mockedGetGitHubClient.mockReturnValue({
      enqueue,
    });

    const result = await fetchPrStatusForRepo('/tmp/repo', 'feature-branch');

    expect(result).toEqual(
      expect.objectContaining({
        hasConflicts: true,
        mergeable: null,
        mergeableState: 'dirty',
      }),
    );
  });

  it('counts unresolved review threads from the GraphQL response', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );

    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            number: 42,
            html_url: 'https://github.com/acme/example-repo/pull/42',
            state: 'open',
            draft: false,
            head: { sha: 'abc123' },
            title: 'List response title',
            updated_at: '2026-03-10T00:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        data: {
          number: 42,
          html_url: 'https://github.com/acme/example-repo/pull/42',
          state: 'open',
          draft: false,
          title: 'Detailed PR title',
          updated_at: '2026-03-10T00:00:00.000Z',
          merged_at: null,
          mergeable: true,
          mergeable_state: 'clean',
          comments: 0,
          review_comments: 0,
        },
      })
      .mockResolvedValueOnce({ data: { check_runs: [] } })
      .mockResolvedValueOnce({ data: [] })
      // Trailing GraphQL review-threads fetch.
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                { isResolved: false },
                { isResolved: true },
                { isResolved: false },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });

    mockedGetGitHubClient.mockReturnValue({
      enqueue,
    });

    const result = await fetchPrStatusForRepo('/tmp/repo', 'feature-branch');

    expect(result?.unresolvedReviewThreadCount).toBe(2);
  });

  it('reads the merge queue state from the first review-thread page', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );
    const openPrResponses = (graphQlPage: unknown): jest.Mock =>
      jest
        .fn()
        .mockResolvedValueOnce({
          data: [
            {
              number: 42,
              html_url: 'https://github.com/acme/example-repo/pull/42',
              state: 'open',
              draft: false,
              head: { sha: 'abc123' },
              title: 'List response title',
              updated_at: '2026-03-10T00:00:00.000Z',
            },
          ],
        })
        .mockResolvedValueOnce({
          data: {
            number: 42,
            html_url: 'https://github.com/acme/example-repo/pull/42',
            state: 'open',
            draft: false,
            title: 'Detailed PR title',
            updated_at: '2026-03-10T00:00:00.000Z',
            merged_at: null,
            mergeable: true,
            mergeable_state: 'blocked',
            comments: 0,
            review_comments: 0,
          },
        })
        .mockResolvedValueOnce({ data: { check_runs: [] } })
        .mockResolvedValueOnce({ data: [] })
        .mockResolvedValueOnce(graphQlPage);
    const page = (
      pullRequest: Record<string, unknown>,
    ): Record<string, unknown> => ({
      repository: {
        pullRequest: {
          ...pullRequest,
          reviewThreads: {
            nodes: [{ isResolved: false }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });

    mockedGetGitHubClient.mockReturnValue({
      enqueue: openPrResponses(
        page({
          isMergeQueueEnabled: true,
          isInMergeQueue: true,
          mergeQueueEntry: { position: 2, state: 'AWAITING_CHECKS' },
        }),
      ),
    });
    const queued = await fetchPrStatusForRepo('/tmp/repo', 'feature-branch');
    expect(queued?.unresolvedReviewThreadCount).toBe(1);
    expect(queued?.mergeQueue).toEqual({
      required: true,
      inQueue: true,
      position: 2,
      phase: 'awaiting_checks',
      observedAt: ANY_STRING,
    });

    mockedGetGitHubClient.mockReturnValue({
      enqueue: openPrResponses(
        page({
          isMergeQueueEnabled: true,
          isInMergeQueue: false,
          mergeQueueEntry: null,
        }),
      ),
    });
    const ready = await fetchPrStatusForRepo('/tmp/repo', 'feature-branch');
    expect(ready?.mergeQueue).toEqual({ required: true, inQueue: false });

    mockedGetGitHubClient.mockReturnValue({
      enqueue: openPrResponses(
        page({ isMergeQueueEnabled: false, isInMergeQueue: false }),
      ),
    });
    const noQueue = await fetchPrStatusForRepo('/tmp/repo', 'feature-branch');
    expect(noQueue?.mergeQueue).toEqual({ required: false, inQueue: false });
    mockedGetGitHubClient.mockReturnValue({
      enqueue: openPrResponses(
        page({ isMergeQueueEnabled: false, isInMergeQueue: true }),
      ),
    });
    const membership = await fetchPrStatusForRepo(
      '/tmp/repo',
      'feature-branch',
    );
    expect(membership?.mergeQueue).toEqual({
      required: false,
      inQueue: true,
      position: null,
      observedAt: ANY_STRING,
    });

    mockedGetGitHubClient.mockReturnValue({
      enqueue: openPrResponses(page({})),
    });
    const unknown = await fetchPrStatusForRepo('/tmp/repo', 'feature-branch');
    expect(unknown).not.toHaveProperty('mergeQueue');
  });

  it('normalizes the merge queue entry state into a phase only while queued', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );
    const fetchWithQueue = async (
      pullRequest: Record<string, unknown>,
    ): Promise<Awaited<ReturnType<typeof fetchPrStatusForRepo>>> => {
      mockedGetGitHubClient.mockReturnValue({
        enqueue: jest
          .fn()
          .mockResolvedValueOnce({
            data: [
              {
                number: 42,
                html_url: 'https://github.com/acme/example-repo/pull/42',
                state: 'open',
                draft: false,
                head: { sha: 'abc123' },
                title: 'List response title',
                updated_at: '2026-03-10T00:00:00.000Z',
              },
            ],
          })
          .mockResolvedValueOnce({
            data: {
              number: 42,
              html_url: 'https://github.com/acme/example-repo/pull/42',
              state: 'open',
              draft: false,
              title: 'Detailed PR title',
              updated_at: '2026-03-10T00:00:00.000Z',
              merged_at: null,
              mergeable: true,
              mergeable_state: 'blocked',
              comments: 0,
              review_comments: 0,
            },
          })
          .mockResolvedValueOnce({ data: { check_runs: [] } })
          .mockResolvedValueOnce({ data: [] })
          .mockResolvedValueOnce({
            repository: {
              pullRequest: {
                ...pullRequest,
                reviewThreads: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          }),
      });
      return fetchPrStatusForRepo('/tmp/repo', 'feature-branch');
    };

    for (const [state, phase] of [
      ['QUEUED', 'queued'],
      ['AWAITING_CHECKS', 'awaiting_checks'],
      ['MERGEABLE', 'mergeable'],
      ['LOCKED', 'locked'],
      ['UNMERGEABLE', 'unmergeable'],
      ['SOME_FUTURE_STATE', 'unknown'],
    ] as const) {
      const status = await fetchWithQueue({
        isMergeQueueEnabled: true,
        isInMergeQueue: true,
        mergeQueueEntry: { position: 1, state },
      });
      // Queue phases, MERGEABLE and LOCKED included, never mean merged.
      expect(status?.state).toBe('open');
      expect(status?.mergeQueue).toEqual({
        required: true,
        inQueue: true,
        position: 1,
        phase,
        observedAt: ANY_STRING,
      });
    }

    // Membership without an entry is still queued, with no phase claimed.
    const membershipOnly = await fetchWithQueue({
      isMergeQueueEnabled: true,
      isInMergeQueue: true,
      mergeQueueEntry: null,
    });
    expect(membershipOnly?.mergeQueue).toEqual({
      required: true,
      inQueue: true,
      position: null,
      observedAt: ANY_STRING,
    });

    const unknownMembership = await fetchWithQueue({
      isMergeQueueEnabled: true,
    });
    expect(unknownMembership?.mergeQueue).toEqual({ required: true });
    const unknownRequirement = await fetchWithQueue({ isInMergeQueue: true });
    expect(unknownRequirement?.mergeQueue).toEqual({
      inQueue: true,
      position: null,
      observedAt: ANY_STRING,
    });
    const noFields = await fetchWithQueue({});
    expect(noFields?.mergeQueue).toBeUndefined();

    const notQueued = await fetchWithQueue({
      isMergeQueueEnabled: true,
      isInMergeQueue: false,
      mergeQueueEntry: null,
    });
    // No read time out of the queue: the persisted status of an unqueued PR
    // stays identical between polls.
    expect(notQueued?.mergeQueue).toEqual({ required: true, inQueue: false });
    expect(notQueued?.mergeQueue).not.toHaveProperty('phase');

    // Every queued read carries its read time, estimate or not, so a display
    // can tell it from an older queue list; the estimate counts down from it.
    // A malformed estimate is dropped.
    const before = Date.now();
    const estimated = await fetchWithQueue({
      isMergeQueueEnabled: true,
      isInMergeQueue: true,
      mergeQueueEntry: {
        position: 3,
        state: 'QUEUED',
        estimatedTimeToMerge: 1143,
      },
    });
    expect(estimated?.mergeQueue).toMatchObject({
      inQueue: true,
      position: 3,
      phase: 'queued',
      estimatedSecondsToMerge: 1143,
    });
    expect(
      Date.parse(estimated?.mergeQueue?.observedAt ?? ''),
    ).toBeGreaterThanOrEqual(before);
    const withoutEstimate = await fetchWithQueue({
      isMergeQueueEnabled: true,
      isInMergeQueue: true,
      mergeQueueEntry: { position: 1, state: 'AWAITING_CHECKS' },
    });
    expect(withoutEstimate?.mergeQueue).not.toHaveProperty(
      'estimatedSecondsToMerge',
    );
    expect(
      Date.parse(withoutEstimate?.mergeQueue?.observedAt ?? ''),
    ).toBeGreaterThanOrEqual(before);
    for (const estimatedTimeToMerge of [-1, 1.5, '600', 30 * 24 * 3600]) {
      const malformed = await fetchWithQueue({
        isMergeQueueEnabled: true,
        isInMergeQueue: true,
        mergeQueueEntry: { position: 1, state: 'QUEUED', estimatedTimeToMerge },
      });
      expect(malformed?.mergeQueue).not.toHaveProperty(
        'estimatedSecondsToMerge',
      );
      expect(malformed?.mergeQueue).toHaveProperty('observedAt');
    }
  });

  it('treats a failed GraphQL thread fetch as unknown (undefined)', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );

    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            number: 42,
            html_url: 'https://github.com/acme/example-repo/pull/42',
            state: 'open',
            draft: false,
            head: { sha: 'abc123' },
            title: 'List response title',
            updated_at: '2026-03-10T00:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        data: {
          number: 42,
          html_url: 'https://github.com/acme/example-repo/pull/42',
          state: 'open',
          draft: false,
          title: 'Detailed PR title',
          updated_at: '2026-03-10T00:00:00.000Z',
          merged_at: null,
          mergeable: true,
          mergeable_state: 'clean',
          comments: 0,
          review_comments: 0,
        },
      })
      .mockResolvedValueOnce({ data: { check_runs: [] } })
      .mockResolvedValueOnce({ data: [] })
      .mockRejectedValueOnce(new Error('graphql scope error'));

    mockedGetGitHubClient.mockReturnValue({
      enqueue,
    });

    const result = await fetchPrStatusForRepo('/tmp/repo', 'feature-branch');

    expect(result?.unresolvedReviewThreadCount).toBeUndefined();
    // One GraphQL failure drops both the thread count and the queue state.
    expect(result).not.toHaveProperty('mergeQueue');
  });

  it('treats a missing GraphQL thread payload as unknown (undefined)', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );

    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            number: 42,
            html_url: 'https://github.com/acme/example-repo/pull/42',
            state: 'open',
            draft: false,
            head: { sha: 'abc123' },
            title: 'List response title',
            updated_at: '2026-03-10T00:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        data: {
          number: 42,
          html_url: 'https://github.com/acme/example-repo/pull/42',
          state: 'open',
          draft: false,
          title: 'Detailed PR title',
          updated_at: '2026-03-10T00:00:00.000Z',
          merged_at: null,
          mergeable: true,
          mergeable_state: 'clean',
          comments: 0,
          review_comments: 0,
        },
      })
      .mockResolvedValueOnce({ data: { check_runs: [] } })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ repository: { pullRequest: null } });

    mockedGetGitHubClient.mockReturnValue({
      enqueue,
    });

    const result = await fetchPrStatusForRepo('/tmp/repo', 'feature-branch');

    expect(result?.unresolvedReviewThreadCount).toBeUndefined();
  });

  it.each([
    [
      'a malformed thread node',
      {
        nodes: [{ isResolved: true }, null],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ],
    [
      'a malformed hasNextPage',
      {
        nodes: [{ isResolved: false }],
        pageInfo: { hasNextPage: 'yes', endCursor: 'cursor-0' },
      },
    ],
  ])(
    'treats a thread page with %s as unknown (undefined)',
    async (_label, reviewThreads) => {
      mockedGetRemoteUrl.mockResolvedValue(
        'https://github.com/acme/example-repo.git',
      );

      const enqueue = jest
        .fn()
        .mockResolvedValueOnce({
          data: [
            {
              number: 42,
              html_url: 'https://github.com/acme/example-repo/pull/42',
              state: 'open',
              draft: false,
              head: { sha: 'abc123' },
              title: 'List response title',
              updated_at: '2026-03-10T00:00:00.000Z',
            },
          ],
        })
        .mockResolvedValueOnce({
          data: {
            number: 42,
            html_url: 'https://github.com/acme/example-repo/pull/42',
            state: 'open',
            draft: false,
            title: 'Detailed PR title',
            updated_at: '2026-03-10T00:00:00.000Z',
            merged_at: null,
            mergeable: true,
            mergeable_state: 'clean',
            comments: 0,
            review_comments: 0,
          },
        })
        .mockResolvedValueOnce({ data: { check_runs: [] } })
        .mockResolvedValueOnce({ data: [] })
        .mockResolvedValueOnce({
          repository: { pullRequest: { reviewThreads } },
        });

      mockedGetGitHubClient.mockReturnValue({
        enqueue,
      });

      const result = await fetchPrStatusForRepo('/tmp/repo', 'feature-branch');

      expect(result?.unresolvedReviewThreadCount).toBeUndefined();
    },
  );

  it('treats capped GraphQL thread pagination as unknown (undefined)', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );

    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            number: 42,
            html_url: 'https://github.com/acme/example-repo/pull/42',
            state: 'open',
            draft: false,
            head: { sha: 'abc123' },
            title: 'List response title',
            updated_at: '2026-03-10T00:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        data: {
          number: 42,
          html_url: 'https://github.com/acme/example-repo/pull/42',
          state: 'open',
          draft: false,
          title: 'Detailed PR title',
          updated_at: '2026-03-10T00:00:00.000Z',
          merged_at: null,
          mergeable: true,
          mergeable_state: 'clean',
          comments: 0,
          review_comments: 0,
        },
      })
      .mockResolvedValueOnce({ data: { check_runs: [] } })
      .mockResolvedValueOnce({ data: [] });

    for (let index = 0; index < 10; index += 1) {
      enqueue.mockResolvedValueOnce({
        repository: {
          pullRequest: {
            isMergeQueueEnabled: true,
            isInMergeQueue: true,
            reviewThreads: {
              nodes: [{ isResolved: false }],
              pageInfo: { hasNextPage: true, endCursor: `cursor-${index}` },
            },
          },
        },
      });
    }

    mockedGetGitHubClient.mockReturnValue({
      enqueue,
    });

    const result = await fetchPrStatusForRepo('/tmp/repo', 'feature-branch');

    expect(result?.unresolvedReviewThreadCount).toBeUndefined();
    expect(result?.mergeQueue).toEqual({
      required: true,
      inQueue: true,
      position: null,
      observedAt: ANY_STRING,
    });
  });

  it.each(['error', 'missing'] as const)(
    'discards queue fields on later-page %s',
    async (failure) => {
      mockedGetRemoteUrl.mockResolvedValue(
        'https://github.com/acme/example-repo.git',
      );

      const enqueue = jest
        .fn()
        .mockResolvedValueOnce({
          data: [
            {
              number: 42,
              html_url: 'https://github.com/acme/example-repo/pull/42',
              state: 'open',
              draft: false,
              head: { sha: 'abc123' },
              title: 'List response title',
              updated_at: '2026-03-10T00:00:00.000Z',
            },
          ],
        })
        .mockResolvedValueOnce({
          data: {
            number: 42,
            html_url: 'https://github.com/acme/example-repo/pull/42',
            state: 'open',
            draft: false,
            title: 'Detailed PR title',
            updated_at: '2026-03-10T00:00:00.000Z',
            merged_at: null,
            mergeable: true,
            mergeable_state: 'clean',
            comments: 0,
            review_comments: 0,
          },
        })
        .mockResolvedValueOnce({ data: { check_runs: [] } })
        .mockResolvedValueOnce({ data: [] });

      for (let index = 0; index < 1; index += 1) {
        enqueue.mockResolvedValueOnce({
          repository: {
            pullRequest: {
              isMergeQueueEnabled: true,
              isInMergeQueue: true,
              reviewThreads: {
                nodes: [{ isResolved: false }],
                pageInfo: { hasNextPage: true, endCursor: `cursor-${index}` },
              },
            },
          },
        });
      }

      if (failure === 'error')
        enqueue.mockRejectedValueOnce(new Error('later-page error'));
      else enqueue.mockResolvedValueOnce({ repository: { pullRequest: null } });

      mockedGetGitHubClient.mockReturnValue({
        enqueue,
      });

      const result = await fetchPrStatusForRepo('/tmp/repo', 'feature-branch');

      expect(result?.unresolvedReviewThreadCount).toBeUndefined();
      expect(result?.mergeQueue).toEqual({
        required: true,
        inQueue: true,
        position: null,
        observedAt: ANY_STRING,
      });
    },
  );

  it('marks comment snapshot collections incomplete when a paginated fetch fails', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );

    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            number: 42,
            html_url: 'https://github.com/acme/example-repo/pull/42',
            state: 'open',
            draft: false,
            head: { sha: 'abc123' },
            title: 'List response title',
            updated_at: '2026-03-10T00:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        data: {
          id: 100,
          number: 42,
          node_id: 'PR_node',
          html_url: 'https://github.com/acme/example-repo/pull/42',
          url: 'https://api.github.com/repos/acme/example-repo/pulls/42',
          state: 'open',
          draft: false,
          title: 'Detailed PR title',
          body: 'Body',
          user: null,
          created_at: '2026-03-10T00:00:00.000Z',
          updated_at: '2026-03-10T00:00:00.000Z',
          merged_at: null,
          closed_at: null,
          merge_commit_sha: null,
          merged_by: null,
          head: {
            sha: 'abc123',
            ref: 'feature-branch',
            repo: { full_name: 'acme/example-repo' },
          },
          base: {
            sha: 'def456',
            ref: 'main',
            repo: { full_name: 'acme/example-repo' },
          },
          labels: [],
          assignees: [],
          requested_reviewers: [],
          comments: 2,
          review_comments: 3,
          mergeable: true,
        },
        headers: {
          'x-ratelimit-remaining': '100',
        },
      })
      .mockResolvedValueOnce({
        data: {
          check_runs: [],
        },
      })
      .mockResolvedValueOnce({
        data: [],
      })
      .mockResolvedValueOnce({ data: [] })
      .mockRejectedValueOnce(new Error('issue comments failed'))
      .mockResolvedValueOnce({ data: [] });

    mockedGetGitHubClient.mockReturnValue({
      enqueue,
    });

    const result = await fetchRepoPrTrackingData(
      '/tmp/repo',
      'feature-branch',
      {
        includeCommentCollections: true,
      },
    );

    expect(result.snapshot).toEqual(
      expect.objectContaining({
        includesComments: false,
        includesReviews: true,
        includesReviewComments: true,
        issueComments: [],
        reviews: [],
        reviewComments: [],
      }),
    );
  });

  it('captures PR check details and merge conflict status in snapshots', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );

    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            number: 42,
            html_url: 'https://github.com/acme/example-repo/pull/42',
            state: 'open',
            draft: false,
            head: { sha: 'abc123' },
            title: 'List response title',
            updated_at: '2026-03-10T00:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        data: {
          id: 100,
          number: 42,
          node_id: 'PR_node',
          html_url: 'https://github.com/acme/example-repo/pull/42',
          url: 'https://api.github.com/repos/acme/example-repo/pulls/42',
          state: 'open',
          draft: false,
          title: 'Detailed PR title',
          body: 'Body',
          user: null,
          created_at: '2026-03-10T00:00:00.000Z',
          updated_at: '2026-03-10T00:00:00.000Z',
          merged_at: null,
          closed_at: null,
          merge_commit_sha: null,
          merged_by: null,
          head: {
            sha: 'abc123',
            ref: 'feature-branch',
            repo: { full_name: 'acme/example-repo' },
          },
          base: {
            sha: 'def456',
            ref: 'main',
            repo: { full_name: 'acme/example-repo' },
          },
          labels: [],
          assignees: [],
          requested_reviewers: [],
          comments: 0,
          review_comments: 0,
          mergeable: false,
          mergeable_state: 'dirty',
        },
        headers: {
          'x-ratelimit-remaining': '100',
        },
      })
      .mockResolvedValueOnce({
        data: {
          check_runs: [
            {
              id: 11,
              name: 'test',
              status: 'completed',
              conclusion: 'failure',
              details_url: 'https://example.com/checks/test-old',
              html_url: 'https://example.com/checks/test-old',
              started_at: '2026-03-10T00:00:00.000Z',
              completed_at: '2026-03-10T00:01:00.000Z',
              app: { slug: 'github-actions', name: 'GitHub Actions' },
            },
            {
              id: 12,
              name: 'test',
              status: 'completed',
              conclusion: 'success',
              details_url: 'https://example.com/checks/test-new',
              html_url: 'https://example.com/checks/test-new',
              started_at: '2026-03-10T00:02:00.000Z',
              completed_at: '2026-03-10T00:03:00.000Z',
              app: { slug: 'github-actions', name: 'GitHub Actions' },
            },
            {
              id: 13,
              name: 'lint',
              status: 'completed',
              conclusion: 'neutral',
              details_url: 'https://example.com/checks/lint',
              html_url: 'https://example.com/checks/lint',
              started_at: '2026-03-10T00:04:00.000Z',
              completed_at: '2026-03-10T00:05:00.000Z',
              app: { slug: 'github-actions', name: 'GitHub Actions' },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: [],
      });

    mockedGetGitHubClient.mockReturnValue({
      enqueue,
    });

    const result = await fetchRepoPrTrackingData('/tmp/repo', 'feature-branch');

    expect(result.snapshot?.checks).toEqual({
      headSha: 'abc123',
      items: [
        {
          id: 13,
          name: 'lint',
          appSlug: 'github-actions',
          appName: 'GitHub Actions',
          status: 'neutral',
          rawStatus: 'completed',
          conclusion: 'neutral',
          detailsUrl: 'https://example.com/checks/lint',
          startedAt: '2026-03-10T00:04:00.000Z',
          completedAt: '2026-03-10T00:05:00.000Z',
        },
        {
          id: 12,
          name: 'test',
          appSlug: 'github-actions',
          appName: 'GitHub Actions',
          status: 'passing',
          rawStatus: 'completed',
          conclusion: 'success',
          detailsUrl: 'https://example.com/checks/test-new',
          startedAt: '2026-03-10T00:02:00.000Z',
          completedAt: '2026-03-10T00:03:00.000Z',
        },
      ],
    });
    expect(result.snapshot?.mergeConflicts).toEqual({
      hasConflicts: true,
      mergeable: false,
      mergeableState: 'dirty',
    });
  });

  it('marks snapshot conflicts when mergeable_state is dirty and mergeable is null', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );

    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            number: 42,
            html_url: 'https://github.com/acme/example-repo/pull/42',
            state: 'open',
            draft: false,
            head: { sha: 'abc123' },
            title: 'List response title',
            updated_at: '2026-03-10T00:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        data: {
          id: 100,
          number: 42,
          node_id: 'PR_node',
          html_url: 'https://github.com/acme/example-repo/pull/42',
          url: 'https://api.github.com/repos/acme/example-repo/pulls/42',
          state: 'open',
          draft: false,
          title: 'Detailed PR title',
          body: 'Body',
          user: null,
          created_at: '2026-03-10T00:00:00.000Z',
          updated_at: '2026-03-10T00:00:00.000Z',
          merged_at: null,
          closed_at: null,
          merge_commit_sha: null,
          merged_by: null,
          head: {
            sha: 'abc123',
            ref: 'feature-branch',
            repo: { full_name: 'acme/example-repo' },
          },
          base: {
            sha: 'def456',
            ref: 'main',
            repo: { full_name: 'acme/example-repo' },
          },
          labels: [],
          assignees: [],
          requested_reviewers: [],
          comments: 0,
          review_comments: 0,
          mergeable: null,
          mergeable_state: 'dirty',
        },
        headers: {
          'x-ratelimit-remaining': '100',
        },
      })
      .mockResolvedValueOnce({
        data: {
          check_runs: [],
        },
      })
      .mockResolvedValueOnce({
        data: [],
      });

    mockedGetGitHubClient.mockReturnValue({
      enqueue,
    });

    const result = await fetchRepoPrTrackingData('/tmp/repo', 'feature-branch');

    expect(result.snapshot?.mergeConflicts).toEqual({
      hasConflicts: true,
      mergeable: null,
      mergeableState: 'dirty',
    });
  });

  it('surfaces PR labels on the status while dropping unnamed labels', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );

    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            number: 42,
            html_url: 'https://github.com/acme/example-repo/pull/42',
            state: 'open',
            draft: false,
            head: { sha: 'abc123' },
            title: 'List response title',
            updated_at: '2026-03-10T00:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        data: {
          id: 100,
          number: 42,
          node_id: 'PR_node',
          html_url: 'https://github.com/acme/example-repo/pull/42',
          url: 'https://api.github.com/repos/acme/example-repo/pulls/42',
          state: 'open',
          draft: false,
          title: 'Detailed PR title',
          body: 'Body',
          user: null,
          created_at: '2026-03-10T00:00:00.000Z',
          updated_at: '2026-03-10T00:00:00.000Z',
          merged_at: null,
          closed_at: null,
          merge_commit_sha: null,
          merged_by: null,
          head: {
            sha: 'abc123',
            ref: 'feature-branch',
            repo: { full_name: 'acme/example-repo' },
          },
          base: {
            sha: 'def456',
            ref: 'main',
            repo: { full_name: 'acme/example-repo' },
          },
          labels: [
            {
              id: 1,
              name: 'bug',
              color: 'd73a4a',
              description: "Something isn't working",
            },
            { id: 2, name: 'enhancement', color: 'a2eeef', description: null },
            { id: 3, name: '', color: 'ffffff', description: null },
          ],
          assignees: [],
          requested_reviewers: [],
          comments: 0,
          review_comments: 0,
          mergeable: true,
          mergeable_state: 'clean',
        },
        headers: {
          'x-ratelimit-remaining': '100',
        },
      })
      .mockResolvedValueOnce({
        data: {
          check_runs: [],
        },
      })
      .mockResolvedValueOnce({
        data: [],
      });

    mockedGetGitHubClient.mockReturnValue({
      enqueue,
    });

    const result = await fetchRepoPrTrackingData('/tmp/repo', 'feature-branch');

    expect(result.status?.labels).toEqual([
      { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
      { name: 'enhancement', color: 'a2eeef', description: null },
    ]);
  });

  it('omits the labels field when the PR has no labels', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );

    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            number: 42,
            html_url: 'https://github.com/acme/example-repo/pull/42',
            state: 'open',
            draft: false,
            head: { sha: 'abc123' },
            title: 'List response title',
            updated_at: '2026-03-10T00:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        data: {
          id: 100,
          number: 42,
          node_id: 'PR_node',
          html_url: 'https://github.com/acme/example-repo/pull/42',
          url: 'https://api.github.com/repos/acme/example-repo/pulls/42',
          state: 'open',
          draft: false,
          title: 'Detailed PR title',
          body: 'Body',
          user: null,
          created_at: '2026-03-10T00:00:00.000Z',
          updated_at: '2026-03-10T00:00:00.000Z',
          merged_at: null,
          closed_at: null,
          merge_commit_sha: null,
          merged_by: null,
          head: {
            sha: 'abc123',
            ref: 'feature-branch',
            repo: { full_name: 'acme/example-repo' },
          },
          base: {
            sha: 'def456',
            ref: 'main',
            repo: { full_name: 'acme/example-repo' },
          },
          labels: [],
          assignees: [],
          requested_reviewers: [],
          comments: 0,
          review_comments: 0,
          mergeable: true,
          mergeable_state: 'clean',
        },
        headers: {
          'x-ratelimit-remaining': '100',
        },
      })
      .mockResolvedValueOnce({
        data: {
          check_runs: [],
        },
      })
      .mockResolvedValueOnce({
        data: [],
      });

    mockedGetGitHubClient.mockReturnValue({
      enqueue,
    });

    const result = await fetchRepoPrTrackingData('/tmp/repo', 'feature-branch');

    expect(result.status).not.toBeNull();
    expect(result.status).not.toHaveProperty('labels');
  });

  it.each([
    ['a user-initiated read ahead of background work', 'high', 'high'],
    ['the poller in the background lane by default', undefined, 'normal'],
  ] as const)('queues %s', async (_label, priority, expected) => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );
    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            number: 42,
            html_url: 'https://github.com/acme/example-repo/pull/42',
            state: 'open',
            draft: false,
            head: { sha: 'abc123' },
            title: 'List response title',
            updated_at: '2026-03-10T00:00:00.000Z',
          },
        ],
      })
      .mockRejectedValue(new Error('enrichment unavailable'));
    mockedGetGitHubClient.mockReturnValue({ enqueue });

    await fetchRepoPrTrackingData(
      '/tmp/repo',
      'feature-branch',
      priority ? { priority } : undefined,
    );

    // Every request of the read, including the review and GraphQL
    // helpers, rides the same lane.
    expect(enqueue.mock.calls.length).toBeGreaterThan(3);
    expect(
      new Set(enqueue.mock.calls.map((call: unknown[]) => call[1])),
    ).toEqual(new Set([expected]));
  });

  it('returns a fallback PR status when enrichment calls fail after the PR list lookup', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );

    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            number: 42,
            html_url: 'https://github.com/acme/example-repo/pull/42',
            state: 'open',
            draft: false,
            head: { sha: 'abc123' },
            title: 'List response title',
            updated_at: '2026-03-10T00:00:00.000Z',
          },
        ],
      })
      .mockRejectedValueOnce(new Error('pull details failed'))
      .mockRejectedValueOnce(new Error('checks failed'))
      .mockResolvedValueOnce({
        data: [
          {
            state: 'APPROVED',
            user: { login: 'reviewer' },
          },
        ],
      });

    mockedGetGitHubClient.mockReturnValue({
      enqueue,
    });

    const result = await fetchRepoPrTrackingData('/tmp/repo', 'feature-branch');

    expect(result.status).toEqual({
      prNumber: 42,
      prUrl: 'https://github.com/acme/example-repo/pull/42',
      headSha: 'abc123',
      state: 'open',
      title: 'List response title',
      checkStatus: 'none',
      checkDetails: [],
      reviewStatus: 'approved',
      reviewers: [{ login: 'reviewer', state: 'approved' }],
      hasConflicts: false,
      mergeable: null,
      mergeableState: null,
      commentCount: 0,
      updatedAt: '2026-03-10T00:00:00.000Z',
    });
    expect(result.snapshot).toBeNull();
  });

  it('labels every request of a tracking read for the broker spend summary', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );
    const enqueue = jest.fn().mockResolvedValue({ data: [] });
    mockedGetGitHubClient.mockReturnValue({ enqueue });

    await fetchRepoPrTrackingData('/tmp/repo', 'feature-branch', {
      caller: 'pr-poller',
    });

    expect(enqueue).toHaveBeenCalledTimes(2);
    for (const call of [1, 2]) {
      expect(enqueue).toHaveBeenNthCalledWith(
        call,
        expect.any(Function),
        'normal',
        expect.objectContaining({ caller: 'pr-poller' }),
      );
    }
  });

  it('finds approvals beyond the first page of review events', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );

    const commentOnlyReviews = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      state: 'COMMENTED',
      user: { login: 'commenter' },
    }));
    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            number: 42,
            html_url: 'https://github.com/acme/example-repo/pull/42',
            state: 'open',
            draft: false,
            head: { sha: 'abc123' },
            title: 'List response title',
            updated_at: '2026-03-10T00:00:00.000Z',
          },
        ],
      })
      .mockRejectedValueOnce(new Error('pull details failed'))
      .mockResolvedValueOnce({ data: { check_runs: [] } })
      .mockResolvedValueOnce({ data: commentOnlyReviews })
      .mockResolvedValueOnce({
        data: [
          {
            id: 101,
            state: 'APPROVED',
            user: { login: 'reviewer' },
          },
        ],
      });

    mockedGetGitHubClient.mockReturnValue({ enqueue });

    const result = await fetchRepoPrTrackingData('/tmp/repo', 'feature-branch');

    expect(result.status).toEqual(
      expect.objectContaining({
        reviewStatus: 'approved',
        reviewers: [{ login: 'reviewer', state: 'approved' }],
      }),
    );
    expect(enqueue.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it('stops counting a reviewer when their latest review is dismissed', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );

    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            number: 42,
            html_url: 'https://github.com/acme/example-repo/pull/42',
            state: 'open',
            draft: false,
            head: { sha: 'abc123' },
            title: 'List response title',
            updated_at: '2026-03-10T00:00:00.000Z',
          },
        ],
      })
      .mockRejectedValueOnce(new Error('pull details failed'))
      .mockResolvedValueOnce({ data: { check_runs: [] } })
      .mockResolvedValueOnce({
        data: [
          {
            state: 'APPROVED',
            user: { login: 'reviewer' },
          },
          {
            state: 'DISMISSED',
            user: { login: 'reviewer' },
          },
        ],
      });

    mockedGetGitHubClient.mockReturnValue({ enqueue });

    const result = await fetchRepoPrTrackingData('/tmp/repo', 'feature-branch');

    expect(result.status).toEqual(
      expect.objectContaining({
        reviewStatus: 'none',
        reviewers: [],
      }),
    );
  });
});

describe('hasGitHubPullRequestHistoryForBranch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('checks all pull requests for the matching GitHub head branch', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );
    const pullsList = jest.fn().mockResolvedValue({
      data: [{ number: 42 }],
    });
    type PullsClient = {
      pulls: {
        list: typeof pullsList;
      };
    };
    const enqueue = jest.fn((fn: (client: PullsClient) => Promise<unknown>) =>
      fn({
        pulls: {
          list: pullsList,
        },
      }),
    );
    mockedGetGitHubClient.mockReturnValue({ enqueue });

    await expect(
      hasGitHubPullRequestHistoryForBranch('/tmp/repo', 'feature/api'),
    ).resolves.toBe(true);

    expect(pullsList).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'example-repo',
      head: 'acme:feature/api',
      state: 'all',
      per_page: 1,
    });
  });
});

describe('createPrForRepo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes the draft flag to GitHub when creating a PR', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );
    const create = jest.fn().mockResolvedValue({
      data: {
        number: 42,
        html_url: 'https://github.com/acme/example-repo/pull/42',
      },
    });
    const enqueue = jest.fn().mockResolvedValue({
      data: {
        number: 42,
        html_url: 'https://github.com/acme/example-repo/pull/42',
      },
    });
    mockedGetGitHubClient.mockReturnValue({ enqueue });

    await expect(
      createPrForRepo(
        '/tmp/repo',
        'feature-branch',
        'Test PR',
        'Description',
        'main',
        true,
      ),
    ).resolves.toEqual({
      prNumber: 42,
      prUrl: 'https://github.com/acme/example-repo/pull/42',
      created: true,
    });

    expect(enqueue).toHaveBeenCalledWith(expect.any(Function), 'high', {
      operation: 'mutation',
      idempotency: 'unsafe',
    });
    const calls = enqueue.mock.calls as Array<
      [
        (octokit: { pulls: { create: typeof create } }) => Promise<unknown>,
        string,
      ]
    >;
    const operation = calls[0][0];
    await operation({ pulls: { create } });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'example-repo',
        head: 'feature-branch',
        base: 'main',
        draft: true,
      }),
    );
  });

  it('returns the existing PR when GitHub reports one already exists', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );

    const enqueue = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('Validation Failed'), {
          status: 422,
          response: {
            data: {
              message: 'Validation Failed',
              errors: [
                {
                  message: 'A pull request already exists for feature-branch',
                },
              ],
            },
          },
        }),
      )
      .mockResolvedValueOnce({
        data: [
          {
            number: 42,
            html_url: 'https://github.com/acme/example-repo/pull/42',
            state: 'open',
            draft: false,
            head: { sha: 'abc123' },
            title: 'List response title',
            updated_at: '2026-03-10T00:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        data: {
          id: 100,
          number: 42,
          node_id: 'PR_node',
          html_url: 'https://github.com/acme/example-repo/pull/42',
          url: 'https://api.github.com/repos/acme/example-repo/pulls/42',
          state: 'open',
          draft: false,
          title: 'Detailed PR title',
          body: 'Body',
          user: null,
          created_at: '2026-03-10T00:00:00.000Z',
          updated_at: '2026-03-10T00:00:00.000Z',
          merged_at: null,
          closed_at: null,
          merge_commit_sha: null,
          merged_by: null,
          head: {
            sha: 'abc123',
            ref: 'feature-branch',
            repo: { full_name: 'acme/example-repo' },
          },
          base: {
            sha: 'def456',
            ref: 'main',
            repo: { full_name: 'acme/example-repo' },
          },
          labels: [],
          assignees: [],
          requested_reviewers: [],
          comments: 0,
          review_comments: 0,
          mergeable: true,
        },
        headers: {
          'x-ratelimit-remaining': '100',
        },
      })
      .mockResolvedValueOnce({
        data: {
          check_runs: [],
        },
      })
      .mockResolvedValueOnce({
        data: [],
      });

    mockedGetGitHubClient.mockReturnValue({
      enqueue,
    });

    await expect(
      createPrForRepo(
        '/tmp/repo',
        'feature-branch',
        'Test PR',
        'Description',
        'main',
      ),
    ).resolves.toEqual({
      prNumber: 42,
      prUrl: 'https://github.com/acme/example-repo/pull/42',
      created: false,
    });
  });
});

describe('mergePrForRepo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );
  });

  it('retries a transient not-mergeable response after re-checking the PR state', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const reposGet = jest.fn().mockResolvedValue({
      data: {
        allow_merge_commit: false,
        allow_squash_merge: true,
        allow_rebase_merge: false,
      },
    });
    const pullsMerge = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('Pull Request is not mergeable'), {
          status: 405,
          response: {
            data: { message: 'Pull Request is not mergeable' },
          },
        }),
      )
      .mockResolvedValueOnce({
        data: {
          merged: true,
          sha: 'merge-sha',
        },
      });
    const pullsGet = jest
      .fn()
      .mockResolvedValueOnce({
        data: {
          state: 'open',
          merged: false,
          head: { sha: 'head-sha' },
          mergeable: null,
          mergeable_state: 'unknown',
        },
      })
      .mockResolvedValueOnce({
        data: {
          state: 'closed',
          merged: true,
          head: { sha: 'head-sha' },
          merge_commit_sha: 'merge-sha',
        },
      });
    const enqueue = jest.fn(
      (operation: (octokit: MergePrTestOctokit) => Promise<unknown>) =>
        operation({
          repos: { get: reposGet },
          pulls: { merge: pullsMerge, get: pullsGet },
        }),
    );
    mockedGetGitHubClient.mockReturnValue({ enqueue });

    try {
      await expect(
        mergePrForRepo('/tmp/repo', 42, 'head-sha', { retryDelaysMs: [0] }),
      ).resolves.toEqual({
        outcome: 'merged',
        mergeMethod: 'squash',
        mergeCommitSha: 'merge-sha',
      });
    } finally {
      warnSpy.mockRestore();
    }

    expect(pullsMerge).toHaveBeenCalledTimes(2);
    expect(pullsGet).toHaveBeenCalledTimes(2);
    expect(pullsMerge).toHaveBeenLastCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'example-repo',
        pull_number: 42,
        merge_method: 'squash',
        sha: 'head-sha',
      }),
    );
  });

  it('uses the full default retry schedule for transient merge failures', async () => {
    jest.useFakeTimers();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const mergeError = Object.assign(
      new Error('Pull Request is not mergeable'),
      {
        status: 405,
        response: {
          data: { message: 'Pull Request is not mergeable' },
        },
      },
    );
    const reposGet = jest.fn().mockResolvedValue({
      data: {
        allow_merge_commit: true,
        allow_squash_merge: true,
        allow_rebase_merge: true,
      },
    });
    const pullsMerge = jest.fn().mockRejectedValue(mergeError);
    const pullsGet = jest.fn().mockResolvedValue({
      data: {
        state: 'open',
        merged: false,
        head: { sha: 'head-sha' },
        mergeable: null,
        mergeable_state: 'unknown',
      },
    });
    const enqueue = jest.fn(
      (operation: (octokit: MergePrTestOctokit) => Promise<unknown>) =>
        operation({
          repos: { get: reposGet },
          pulls: { merge: pullsMerge, get: pullsGet },
        }),
    );
    mockedGetGitHubClient.mockReturnValue({ enqueue });

    try {
      const resultPromise = mergePrForRepo('/tmp/repo', 42, 'head-sha');
      const resultExpectation = expect(resultPromise).rejects.toBe(mergeError);
      await jest.advanceTimersByTimeAsync(
        PR_MERGE_RETRY_DELAYS_MS.reduce((total, delayMs) => total + delayMs, 0),
      );

      await resultExpectation;
    } finally {
      warnSpy.mockRestore();
      jest.useRealTimers();
    }

    expect(pullsMerge).toHaveBeenCalledTimes(
      PR_MERGE_RETRY_DELAYS_MS.length + 1,
    );
    expect(pullsGet).toHaveBeenCalledTimes(PR_MERGE_RETRY_DELAYS_MS.length);
  });

  it('does not retry when the PR head changes after a transient merge failure', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const reposGet = jest.fn().mockResolvedValue({
      data: {
        allow_merge_commit: true,
        allow_squash_merge: true,
        allow_rebase_merge: true,
      },
    });
    const pullsMerge = jest.fn().mockRejectedValue(
      Object.assign(new Error('Base branch was modified'), {
        status: 405,
        response: {
          data: { message: 'Base branch was modified. Review and try again.' },
        },
      }),
    );
    const pullsGet = jest.fn().mockResolvedValue({
      data: {
        state: 'open',
        merged: false,
        head: { sha: 'new-head-sha' },
        mergeable: null,
        mergeable_state: 'unknown',
      },
    });
    const enqueue = jest.fn(
      (operation: (octokit: MergePrTestOctokit) => Promise<unknown>) =>
        operation({
          repos: { get: reposGet },
          pulls: { merge: pullsMerge, get: pullsGet },
        }),
    );
    mockedGetGitHubClient.mockReturnValue({ enqueue });

    try {
      await expect(
        mergePrForRepo('/tmp/repo', 42, 'head-sha', { retryDelaysMs: [0] }),
      ).rejects.toThrow(
        'Cannot retry the pull request merge because the PR head commit changed.',
      );
    } finally {
      warnSpy.mockRestore();
    }

    expect(pullsMerge).toHaveBeenCalledTimes(1);
  });

  it('does not retry a dirty merge conflict state', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const mergeError = Object.assign(
      new Error('Pull Request is not mergeable'),
      {
        status: 405,
        response: {
          data: { message: 'Pull Request is not mergeable' },
        },
      },
    );
    const reposGet = jest.fn().mockResolvedValue({
      data: {
        allow_merge_commit: true,
        allow_squash_merge: true,
        allow_rebase_merge: true,
      },
    });
    const pullsMerge = jest.fn().mockRejectedValue(mergeError);
    const pullsGet = jest.fn().mockResolvedValue({
      data: {
        state: 'open',
        merged: false,
        head: { sha: 'head-sha' },
        mergeable: false,
        mergeable_state: 'dirty',
      },
    });
    const enqueue = jest.fn(
      (operation: (octokit: MergePrTestOctokit) => Promise<unknown>) =>
        operation({
          repos: { get: reposGet },
          pulls: { merge: pullsMerge, get: pullsGet },
        }),
    );
    mockedGetGitHubClient.mockReturnValue({ enqueue });

    try {
      await expect(
        mergePrForRepo('/tmp/repo', 42, 'head-sha', { retryDelaysMs: [0] }),
      ).rejects.toThrow('Pull Request is not mergeable');
    } finally {
      warnSpy.mockRestore();
    }

    expect(pullsMerge).toHaveBeenCalledTimes(1);
  });

  describe('merge queue', () => {
    const queueState = (
      overrides: Partial<{
        isMergeQueueEnabled: boolean;
        isInMergeQueue: boolean;
        mergeQueueEntry: { position: number; state: string } | null;
      }> = {},
    ): Record<string, unknown> => ({
      repository: {
        pullRequest: {
          id: 'PR_node_42',
          isMergeQueueEnabled: true,
          isInMergeQueue: false,
          mergeQueueEntry: null,
          ...overrides,
        },
      },
    });
    const queueRequiredMergeError = (): Error =>
      Object.assign(new Error('Repository rule violations found'), {
        status: 405,
        response: {
          data: {
            message:
              'Repository rule violations found\n\nChanges must be made through the merge queue',
          },
        },
      });

    const setup = ({
      graphql,
      pullsMerge = jest.fn(),
      pullsGet = jest.fn(),
    }: {
      graphql: jest.Mock;
      pullsMerge?: jest.Mock;
      pullsGet?: jest.Mock;
    }): {
      pullsMerge: jest.Mock;
      pullsGet: jest.Mock;
      calls: Array<{ options: GitHubClientEnqueueOptions | undefined }>;
    } => {
      const reposGet = jest.fn().mockResolvedValue({
        data: {
          allow_merge_commit: true,
          allow_squash_merge: true,
          allow_rebase_merge: true,
        },
      });
      const calls: Array<{ options: GitHubClientEnqueueOptions | undefined }> =
        [];
      const enqueue = jest.fn(
        (
          operation: (octokit: MergePrTestOctokit) => Promise<unknown>,
          _priority?: string,
          options?: GitHubClientEnqueueOptions,
        ) => {
          calls.push({ options });
          return operation({
            repos: { get: reposGet },
            pulls: { merge: pullsMerge, get: pullsGet },
            graphql,
          });
        },
      );
      mockedGetGitHubClient.mockReturnValue({ enqueue });
      return { pullsMerge, pullsGet, calls };
    };
    const isMutation = (query: string): boolean =>
      query.includes('enqueuePullRequest');

    it('adds the PR to the merge queue when the base branch requires one', async () => {
      const graphql = jest.fn((query: string) =>
        isMutation(query)
          ? {
              enqueuePullRequest: {
                mergeQueueEntry: { position: 3, state: 'QUEUED' },
              },
            }
          : queueState(),
      );
      const { pullsMerge, calls } = setup({ graphql });

      await expect(
        mergePrForRepo('/tmp/repo', 42, 'head-sha', { retryDelaysMs: [0] }),
      ).resolves.toEqual({
        outcome: 'enqueued',
        mergeMethod: 'merge',
        mergeCommitSha: null,
        queuePosition: 3,
      });

      expect(pullsMerge).not.toHaveBeenCalled();
      expect(graphql).toHaveBeenCalledTimes(2);
      expect(graphql).toHaveBeenLastCalledWith(
        expect.stringContaining('enqueuePullRequest'),
        { pullRequestId: 'PR_node_42', expectedHeadOid: 'head-sha' },
      );
      // repos.get, queue read, enqueue mutation.
      expect(calls.map(({ options }) => options)).toEqual([
        { operation: 'read', idempotency: 'safe' },
        { operation: 'read', idempotency: 'safe', resource: 'graphql' },
        { operation: 'mutation', idempotency: 'unsafe', resource: 'graphql' },
      ]);
    });

    it('returns enqueued without another mutation when the PR is already queued', async () => {
      const graphql = jest.fn(() =>
        queueState({
          isInMergeQueue: true,
          mergeQueueEntry: { position: 1, state: 'AWAITING_CHECKS' },
        }),
      );
      const { pullsMerge } = setup({ graphql });

      await expect(
        mergePrForRepo('/tmp/repo', 42, 'head-sha'),
      ).resolves.toEqual({
        outcome: 'enqueued',
        mergeMethod: 'merge',
        mergeCommitSha: null,
        queuePosition: 1,
      });
      expect(graphql).toHaveBeenCalledTimes(1);
      expect(pullsMerge).not.toHaveBeenCalled();
    });

    it('treats an already-queued enqueue error as enqueued', async () => {
      let reads = 0;
      const graphql = jest.fn((query: string) => {
        if (isMutation(query)) {
          throw new Error('Pull request is already queued to merge');
        }
        reads += 1;
        return reads === 1
          ? queueState()
          : queueState({
              isInMergeQueue: true,
              mergeQueueEntry: { position: 2, state: 'QUEUED' },
            });
      });
      setup({ graphql });

      await expect(
        mergePrForRepo('/tmp/repo', 42, 'head-sha'),
      ).resolves.toEqual(
        expect.objectContaining({ outcome: 'enqueued', queuePosition: 2 }),
      );
    });

    it('fails without retrying when the PR head changed', async () => {
      const graphql = jest.fn((query: string) => {
        if (isMutation(query)) {
          throw new Error("Head sha didn't match expected head oid");
        }
        return queueState();
      });
      const { pullsMerge } = setup({ graphql });

      await expect(
        mergePrForRepo('/tmp/repo', 42, 'head-sha', { retryDelaysMs: [0] }),
      ).rejects.toThrow(
        'Cannot add the pull request to the merge queue because the PR head commit changed. Refresh and try again.',
      );
      expect(
        graphql.mock.calls.filter(([query]) => isMutation(query)),
      ).toHaveLength(1);
      expect(pullsMerge).not.toHaveBeenCalled();
    });

    it('surfaces any other enqueue error', async () => {
      const enqueueError = new Error('Required status checks are pending');
      const graphql = jest.fn((query: string) => {
        if (isMutation(query)) throw enqueueError;
        return queueState();
      });
      setup({ graphql });

      await expect(mergePrForRepo('/tmp/repo', 42, 'head-sha')).rejects.toBe(
        enqueueError,
      );
    });

    it('merges directly when the base branch has no merge queue', async () => {
      const graphql = jest.fn(() => queueState({ isMergeQueueEnabled: false }));
      const pullsMerge = jest
        .fn()
        .mockResolvedValue({ data: { merged: true, sha: 'merge-sha' } });
      const pullsGet = jest
        .fn()
        .mockResolvedValue({ data: { state: 'closed', merged: true } });
      setup({ graphql, pullsMerge, pullsGet });

      await expect(
        mergePrForRepo('/tmp/repo', 42, 'head-sha'),
      ).resolves.toEqual({
        outcome: 'merged',
        mergeMethod: 'merge',
        mergeCommitSha: 'merge-sha',
      });
      expect(graphql).toHaveBeenCalledTimes(1);
    });

    it('enqueues when the queue state was unknown and GitHub requires the queue', async () => {
      let reads = 0;
      const graphql = jest.fn((query: string) => {
        if (isMutation(query)) {
          return {
            enqueuePullRequest: {
              mergeQueueEntry: { position: 4, state: 'QUEUED' },
            },
          };
        }
        reads += 1;
        if (reads === 1) throw new Error('GraphQL timeout');
        return queueState();
      });
      const pullsMerge = jest.fn().mockRejectedValue(queueRequiredMergeError());
      const { pullsGet } = setup({ graphql, pullsMerge });

      await expect(
        mergePrForRepo('/tmp/repo', 42, 'head-sha', {
          retryDelaysMs: [60_000],
        }),
      ).resolves.toEqual(
        expect.objectContaining({ outcome: 'enqueued', queuePosition: 4 }),
      );
      // Checked before the retryable 405 branch: no retry, no PR re-check.
      expect(pullsMerge).toHaveBeenCalledTimes(1);
      expect(pullsGet).not.toHaveBeenCalled();
    });

    it('enqueues when a stale read reported no queue and GitHub requires the queue', async () => {
      let reads = 0;
      const graphql = jest.fn((query: string) => {
        if (isMutation(query)) {
          return {
            enqueuePullRequest: {
              mergeQueueEntry: { position: 2, state: 'QUEUED' },
            },
          };
        }
        reads += 1;
        // The ruleset was enabled between the first read and the merge.
        return queueState({ isMergeQueueEnabled: reads > 1 });
      });
      const pullsMerge = jest.fn().mockRejectedValue(queueRequiredMergeError());
      const { pullsGet } = setup({ graphql, pullsMerge });

      await expect(
        mergePrForRepo('/tmp/repo', 42, 'head-sha', {
          retryDelaysMs: [60_000],
        }),
      ).resolves.toEqual(
        expect.objectContaining({ outcome: 'enqueued', queuePosition: 2 }),
      );
      expect(pullsMerge).toHaveBeenCalledTimes(1);
      expect(pullsGet).not.toHaveBeenCalled();
    });

    it('surfaces the original merge error when the fallback enqueue fails', async () => {
      let reads = 0;
      const graphql = jest.fn((query: string) => {
        if (isMutation(query)) throw new Error('enqueue failed');
        reads += 1;
        if (reads === 1) throw new Error('GraphQL timeout');
        return queueState();
      });
      const mergeError = queueRequiredMergeError();
      const pullsMerge = jest.fn().mockRejectedValue(mergeError);
      setup({ graphql, pullsMerge });

      await expect(
        mergePrForRepo('/tmp/repo', 42, 'head-sha', { retryDelaysMs: [0] }),
      ).rejects.toBe(mergeError);
      expect(pullsMerge).toHaveBeenCalledTimes(1);
    });

    it('surfaces the merge error when the queue state stays unknown', async () => {
      const graphql = jest.fn(() => {
        throw new Error('GraphQL unavailable');
      });
      const mergeError = queueRequiredMergeError();
      const pullsMerge = jest.fn().mockRejectedValue(mergeError);
      setup({ graphql, pullsMerge });

      await expect(
        mergePrForRepo('/tmp/repo', 42, 'head-sha', { retryDelaysMs: [0] }),
      ).rejects.toBe(mergeError);
    });
  });
});

describe('fetchPrStatusForWorktree', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('bounds multi-repository PR discovery to four repositories', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedResolveWorktreeCwd.mockReturnValue('/workspace');
    mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue(
      Array.from({ length: 12 }, (_, index) => ({
        repoId: `repo-${index}`,
        repoName: `Repo ${index}`,
        repoPath: `/workspace/repo-${index}`,
      })),
    );
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockedGetCurrentBranch.mockImplementation(async () => {
      await gate;
      return 'main';
    });
    mockedGetRemoteUrl.mockResolvedValue(null);
    const request = fetchPrStatusForWorktree('ws-1', 'wt-1');
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(mockedGetCurrentBranch).toHaveBeenCalledTimes(4);
    } finally {
      release();
      await request;
    }
    expect(mockedGetCurrentBranch).toHaveBeenCalledTimes(12);
  });

  it('includes the project root repo in multi-repo status checks', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedResolveWorktreeCwd.mockReturnValue('/workspaces/ws-1/wt-1');
    mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([
      {
        repoId: '__workspace_root__',
        repoName: 'Workspace root',
        repoPath: '/workspaces/ws-1/wt-1',
      },
      {
        repoId: 'api',
        repoName: 'API',
        repoPath: '/workspaces/ws-1/wt-1/repos/api',
      },
    ]);
    mockedGetCurrentBranch
      .mockResolvedValueOnce('feature/workspace')
      .mockResolvedValueOnce('feature/api');
    mockedGetRemoteUrl.mockResolvedValue(null);

    const result = await fetchPrStatusForWorktree('ws-1', 'wt-1');

    expect(result?.repos).toEqual([
      {
        repoId: '__workspace_root__',
        repoName: 'Workspace root',
        status: null,
        prLookupAvailable: false,
      },
      {
        repoId: 'api',
        repoName: 'API',
        status: null,
        prLookupAvailable: false,
      },
    ]);
    expect(typeof result?.lastCheckedAt).toBe('string');
  });

  it('distinguishes a failed PR lookup from a verified missing PR', async () => {
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedResolveWorktreeCwd.mockReturnValue('/workspaces/ws-1/wt-1');
    mockedGetCurrentBranch.mockResolvedValue('feature/workspace');
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );
    const enqueue = jest.fn().mockRejectedValue(new Error('GitHub API down'));
    mockedGetGitHubClient.mockReturnValue({ enqueue });

    await expect(
      fetchPrStatusForWorktree('ws-1', 'wt-1'),
    ).resolves.toMatchObject({
      repos: [{ status: null, prLookupAvailable: false }],
    });

    enqueue.mockReset();
    enqueue.mockResolvedValue({ data: [] });
    await expect(
      fetchPrStatusForWorktree('ws-1', 'wt-1'),
    ).resolves.toMatchObject({
      repos: [{ status: null, prLookupAvailable: true }],
    });
  });
});

describe('closePrForRepo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('posts a comment before closing the PR when a comment is provided', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );

    const calls: string[] = [];
    const createComment = jest.fn(() => {
      calls.push('createComment');
      return Promise.resolve({ data: {} });
    });
    const updatePr = jest.fn(() => {
      calls.push('update');
      return Promise.resolve({ data: {} });
    });
    const enqueue = jest.fn((callback: (octokit: unknown) => unknown) =>
      callback({
        issues: { createComment },
        pulls: { update: updatePr },
      }),
    );

    mockedGetGitHubClient.mockReturnValue({ enqueue });

    await closePrForRepo('/tmp/repo', 42, 'Closing in favor of split PRs');

    expect(calls).toEqual(['createComment', 'update']);
    expect(createComment).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'example-repo',
      issue_number: 42,
      body: 'Closing in favor of split PRs',
    });
    expect(updatePr).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'example-repo',
      pull_number: 42,
      state: 'closed',
    });
    expect(enqueue).toHaveBeenNthCalledWith(1, expect.any(Function), 'high', {
      operation: 'mutation',
      idempotency: 'unsafe',
    });
    expect(enqueue).toHaveBeenNthCalledWith(2, expect.any(Function), 'high', {
      operation: 'mutation',
      idempotency: 'unsafe',
    });
  });

  it('does not call createComment when comment is undefined', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );

    const createComment = jest.fn().mockResolvedValue({ data: {} });
    const updatePr = jest.fn().mockResolvedValue({ data: {} });
    const enqueue = jest.fn((callback: (octokit: unknown) => unknown) =>
      callback({
        issues: { createComment },
        pulls: { update: updatePr },
      }),
    );

    mockedGetGitHubClient.mockReturnValue({ enqueue });

    await closePrForRepo('/tmp/repo', 42);

    expect(createComment).not.toHaveBeenCalled();
    expect(updatePr).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'example-repo',
      pull_number: 42,
      state: 'closed',
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('propagates errors from the GitHub client', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );

    const enqueue = jest.fn().mockRejectedValue(new Error('GitHub API down'));
    mockedGetGitHubClient.mockReturnValue({ enqueue });

    await expect(closePrForRepo('/tmp/repo', 42)).rejects.toThrow(
      'GitHub API down',
    );
  });

  it('throws when no remote URL is found', async () => {
    mockedGetRemoteUrl.mockResolvedValue(null);

    await expect(closePrForRepo('/tmp/repo', 42)).rejects.toThrow(
      'No remote URL found for repository at /tmp/repo',
    );
  });
});

describe('updatePrBodyForRepo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sends the updated body with high priority', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );

    const updatePr = jest.fn().mockResolvedValue({ data: {} });
    const enqueue = jest.fn((callback: (octokit: unknown) => unknown) =>
      callback({ pulls: { update: updatePr } }),
    );

    mockedGetGitHubClient.mockReturnValue({ enqueue });

    await updatePrBodyForRepo('/tmp/repo', 42, 'Updated body text');

    expect(updatePr).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'example-repo',
      pull_number: 42,
      body: 'Updated body text',
    });
    expect(enqueue).toHaveBeenCalledWith(expect.any(Function), 'high', {
      operation: 'mutation',
      idempotency: 'unsafe',
    });
  });

  it('propagates errors from the GitHub client', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );

    const enqueue = jest.fn().mockRejectedValue(new Error('GitHub API down'));
    mockedGetGitHubClient.mockReturnValue({ enqueue });

    await expect(
      updatePrBodyForRepo('/tmp/repo', 42, 'Updated body text'),
    ).rejects.toThrow('GitHub API down');
  });
});

describe('listOpenPrsBasedOnBranchForRepo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists open PRs based on the given branch with normal priority', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );

    const list = jest.fn().mockResolvedValue({
      data: [
        {
          number: 46,
          html_url: 'https://github.com/acme/example-repo/pull/46',
          head: { ref: 'feat/downstream' },
        },
        {
          number: 47,
          html_url: 'https://github.com/acme/example-repo/pull/47',
          head: { ref: 'feat/another-downstream' },
        },
      ],
    });
    const enqueue = jest.fn((callback: (octokit: unknown) => unknown) =>
      callback({ pulls: { list } }),
    );

    mockedGetGitHubClient.mockReturnValue({ enqueue });

    const result = await listOpenPrsBasedOnBranchForRepo(
      '/tmp/repo',
      'feat/big',
    );

    expect(list).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'example-repo',
      base: 'feat/big',
      state: 'open',
      per_page: 100,
    });
    expect(enqueue).toHaveBeenCalledWith(expect.any(Function), 'normal', {
      operation: 'read',
      idempotency: 'safe',
    });
    expect(result).toEqual([
      {
        prNumber: 46,
        prUrl: 'https://github.com/acme/example-repo/pull/46',
        headBranch: 'feat/downstream',
      },
      {
        prNumber: 47,
        prUrl: 'https://github.com/acme/example-repo/pull/47',
        headBranch: 'feat/another-downstream',
      },
    ]);
  });

  it('propagates errors from the GitHub client', async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );

    const enqueue = jest.fn().mockRejectedValue(new Error('GitHub API down'));
    mockedGetGitHubClient.mockReturnValue({ enqueue });

    await expect(
      listOpenPrsBasedOnBranchForRepo('/tmp/repo', 'feat/big'),
    ).rejects.toThrow('GitHub API down');
  });

  it('throws when no remote URL is found', async () => {
    mockedGetRemoteUrl.mockResolvedValue(null);

    await expect(
      listOpenPrsBasedOnBranchForRepo('/tmp/repo', 'feat/big'),
    ).rejects.toThrow('No remote URL found for repository at /tmp/repo');
  });

  it('throws when the remote URL cannot be parsed as GitHub', async () => {
    mockedGetRemoteUrl.mockResolvedValue('https://gitlab.com/acme/repo.git');

    await expect(
      listOpenPrsBasedOnBranchForRepo('/tmp/repo', 'feat/big'),
    ).rejects.toThrow('Could not parse GitHub remote URL');
  });
});

describe('merge queue evidence on PR tracking snapshots', () => {
  const ENQUEUED_AT = '2026-10-07T10:00:00.000Z';

  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );
  });

  function setup(
    graphql: jest.Mock,
    prState: 'open' | 'closed' | 'draft' = 'open',
  ): jest.Mock {
    const merged = prState === 'closed';
    const draft = prState === 'draft';
    const restState = draft ? 'open' : prState;
    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            number: 42,
            html_url: 'https://github.com/acme/example-repo/pull/42',
            state: restState,
            draft,
            head: { sha: 'abc123' },
            title: 'List response title',
            updated_at: '2026-03-10T00:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        data: {
          id: 100,
          number: 42,
          html_url: 'https://github.com/acme/example-repo/pull/42',
          state: restState,
          draft,
          title: 'Detailed PR title',
          updated_at: '2026-03-10T00:00:00.000Z',
          merged_at: merged ? '2026-03-11T00:00:00.000Z' : null,
          mergeable: true,
          mergeable_state: 'blocked',
          comments: 0,
          review_comments: 0,
        },
      })
      .mockResolvedValueOnce({ data: { check_runs: [] } })
      .mockResolvedValueOnce({ data: [] })
      .mockImplementation(
        (operation: (octokit: { graphql: jest.Mock }) => Promise<unknown>) =>
          operation({ graphql }),
      );
    mockedGetGitHubClient.mockReturnValue({ enqueue });
    return enqueue;
  }

  const queuedPullRequest = {
    isMergeQueueEnabled: true,
    isInMergeQueue: true,
    mergeQueueEntry: {
      id: 'MQE_1',
      enqueuedAt: '2026-10-07T10:00:00Z',
      state: 'AWAITING_CHECKS',
      position: 2,
    },
    reviewThreads: {
      nodes: [{ isResolved: false }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };

  const queueEvents = {
    filteredCount: 1,
    pageInfo: { hasPreviousPage: false, startCursor: 'cursor-1' },
    nodes: [
      {
        __typename: 'AddedToMergeQueueEvent',
        id: 'a1',
        createdAt: ENQUEUED_AT,
      },
    ],
  };

  const membership = {
    inQueue: true,
    entryId: 'MQE_1',
    phase: 'awaiting_checks',
    enqueuedAt: ENQUEUED_AT,
    position: 2,
  };

  it('reads the entry id and timeline once and keeps them off the status', async () => {
    const graphql = jest.fn().mockResolvedValue({
      repository: { pullRequest: { ...queuedPullRequest, queueEvents } },
    });
    setup(graphql);

    const result = await fetchRepoPrTrackingData('/tmp/repo', 'feature-branch');

    expect(graphql).toHaveBeenCalledTimes(1);
    const [query, variables] = graphql.mock.calls.map(
      (call: unknown[]) => call,
    )[0] ?? [undefined, undefined];
    expect(query).toContain('mergeQueueEntry');
    expect(query).toContain('enqueuedAt');
    expect(query).toContain('ADDED_TO_MERGE_QUEUE_EVENT');
    expect(variables).toMatchObject({ withQueueEvents: true });
    expect(result.snapshot?.mergeQueue).toEqual({
      required: true,
      membership,
      history: {
        status: 'complete',
        filteredCount: 1,
        firstIndex: 0,
        events: [{ type: 'added', id: 'a1', createdAt: ENQUEUED_AT }],
      },
    });
    expect(result.status?.mergeQueue).toEqual({
      required: true,
      inQueue: true,
      position: 2,
      phase: 'awaiting_checks',
      observedAt: ANY_STRING,
    });
    expect(result.status?.unresolvedReviewThreadCount).toBe(1);
  });

  it('asks for the timeline on the first review-thread page only', async () => {
    const graphql = jest
      .fn()
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            ...queuedPullRequest,
            queueEvents,
            reviewThreads: {
              nodes: [{ isResolved: false }],
              pageInfo: { hasNextPage: true, endCursor: 'page-2' },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [{ isResolved: false }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    setup(graphql);

    const result = await fetchRepoPrTrackingData('/tmp/repo', 'feature-branch');

    expect(graphql.mock.calls.map((call: unknown[]) => call[1])).toEqual([
      expect.objectContaining({ cursor: null, withQueueEvents: true }),
      expect.objectContaining({ cursor: 'page-2', withQueueEvents: false }),
    ]);
    expect(result.status?.unresolvedReviewThreadCount).toBe(2);
    expect(result.snapshot?.mergeQueue?.membership).toEqual(membership);
  });

  it('keeps thread counts and membership when only the timeline errors', async () => {
    const graphql = jest.fn().mockRejectedValue(
      Object.assign(
        new Error('Request failed due to following response errors'),
        {
          errors: [
            {
              type: 'INTERNAL',
              path: ['repository', 'pullRequest', 'queueEvents'],
              message: 'Something went wrong',
            },
          ],
          data: {
            repository: {
              pullRequest: { ...queuedPullRequest, queueEvents: null },
            },
          },
        },
      ),
    );
    setup(graphql);

    const result = await fetchRepoPrTrackingData('/tmp/repo', 'feature-branch');

    expect(result.status?.unresolvedReviewThreadCount).toBe(1);
    expect(result.status?.mergeQueue).toMatchObject({ inQueue: true });
    expect(result.snapshot?.mergeQueue).toEqual({
      required: true,
      membership,
      history: { status: 'unavailable' },
    });
  });

  it('reports a read whose queue timeline failed as incomplete', async () => {
    const graphql = jest.fn().mockRejectedValue(
      Object.assign(
        new Error('Request failed due to following response errors'),
        {
          errors: [
            {
              type: 'INTERNAL',
              path: ['repository', 'pullRequest', 'queueEvents'],
              message: 'Something went wrong',
            },
          ],
          data: {
            repository: {
              pullRequest: { ...queuedPullRequest, queueEvents: null },
            },
          },
        },
      ),
    );
    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({
        data: {
          id: 100,
          number: 42,
          html_url: 'https://github.com/acme/example-repo/pull/42',
          state: 'open',
          draft: false,
          title: 'Detailed PR title',
          updated_at: '2026-03-10T00:00:00.000Z',
          merged_at: null,
          mergeable: true,
          mergeable_state: 'blocked',
          comments: 0,
          review_comments: 0,
        },
      })
      .mockResolvedValueOnce({ data: { check_runs: [] } })
      .mockResolvedValueOnce({ data: [] })
      .mockImplementation(
        (operation: (octokit: { graphql: jest.Mock }) => Promise<unknown>) =>
          operation({ graphql }),
      );
    mockedGetGitHubClient.mockReturnValue({ enqueue });

    const result = await fetchTrackedPullRequestData({
      remote: { owner: 'acme', repo: 'example-repo' },
      branchName: 'feature-branch',
      pullRequest: {
        number: 42,
        url: 'https://github.com/acme/example-repo/pull/42',
        title: 'PR',
        state: 'open',
        isDraft: false,
        headSha: 'abc123',
        baseRefName: 'main',
        createdAt: '2026-03-10T00:00:00.000Z',
        updatedAt: '2026-03-10T00:00:00.000Z',
        mergedAt: null,
      },
    });

    expect(result.complete).toBe(false);
    expect(result.trackingData.status?.unresolvedReviewThreadCount).toBe(1);
    expect(result.trackingData.snapshot?.mergeQueue?.membership).toEqual(
      membership,
    );
  });

  it('treats other GraphQL errors as unknown queue state', async () => {
    const graphql = jest.fn().mockRejectedValue(
      Object.assign(
        new Error('Request failed due to following response errors'),
        {
          errors: [
            {
              type: 'INTERNAL',
              path: ['repository', 'pullRequest', 'reviewThreads'],
              message: 'Something went wrong',
            },
          ],
          data: {
            repository: {
              pullRequest: { ...queuedPullRequest, queueEvents },
            },
          },
        },
      ),
    );
    setup(graphql);

    const result = await fetchRepoPrTrackingData('/tmp/repo', 'feature-branch');

    expect(result.status?.unresolvedReviewThreadCount).toBeUndefined();
    expect(result.status).not.toHaveProperty('mergeQueue');
    expect(result.snapshot).not.toHaveProperty('mergeQueue');
  });

  it('marks an unusable timeline unavailable and omits unreadable membership', async () => {
    const graphql = jest.fn().mockResolvedValueOnce({
      repository: {
        pullRequest: {
          ...queuedPullRequest,
          queueEvents: { ...queueEvents, filteredCount: 3 },
        },
      },
    });
    setup(graphql);
    const partial = await fetchRepoPrTrackingData(
      '/tmp/repo',
      'feature-branch',
    );
    expect(partial.snapshot?.mergeQueue?.history).toEqual({
      status: 'unavailable',
    });

    graphql.mockResolvedValueOnce({
      repository: {
        pullRequest: {
          ...queuedPullRequest,
          isInMergeQueue: undefined,
          queueEvents,
        },
      },
    });
    setup(graphql);
    const unknown = await fetchRepoPrTrackingData(
      '/tmp/repo',
      'feature-branch',
    );
    expect(unknown.snapshot).not.toHaveProperty('mergeQueue');
  });

  it('reads no queue evidence for a pull request that is not open', async () => {
    const graphql = jest.fn();
    setup(graphql, 'closed');

    const result = await fetchRepoPrTrackingData('/tmp/repo', 'feature-branch');

    expect(result.status?.state).toBe('merged');
    expect(graphql).not.toHaveBeenCalled();
    expect(result.snapshot).not.toHaveProperty('mergeQueue');
  });

  it('reads queue evidence for a draft pull request without changing its status', async () => {
    const graphql = jest.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          ...queuedPullRequest,
          isInMergeQueue: false,
          mergeQueueEntry: null,
          queueEvents,
        },
      },
    });
    setup(graphql, 'draft');

    const result = await fetchRepoPrTrackingData('/tmp/repo', 'feature-branch');

    expect(result.status?.state).toBe('draft');
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(result.snapshot?.mergeQueue).toEqual({
      required: true,
      membership: {
        inQueue: false,
        entryId: null,
        enqueuedAt: null,
        position: null,
      },
      history: {
        status: 'complete',
        filteredCount: 1,
        firstIndex: 0,
        events: [{ type: 'added', id: 'a1', createdAt: ENQUEUED_AT }],
      },
    });
    expect(result.status).not.toHaveProperty('mergeQueue');
    expect(result.status).not.toHaveProperty('unresolvedReviewThreadCount');
  });
});

describe('conditional PR tracking reads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );
  });

  interface RecordedRequest {
    method: string;
    params: Record<string, unknown>;
  }

  function installConditionalClient(): {
    requests: RecordedRequest[];
    options: GitHubClientEnqueueOptions[];
  } {
    const requests: RecordedRequest[] = [];
    const options: GitHubClientEnqueueOptions[] = [];
    const record =
      (method: string, data: unknown) =>
      (params: Record<string, unknown>): Promise<{ data: unknown }> => {
        requests.push({ method, params });
        return Promise.resolve({ data });
      };
    const octokit = {
      pulls: {
        list: record('pulls.list', [
          {
            number: 42,
            html_url: 'https://github.com/acme/example-repo/pull/42',
            state: 'open',
            draft: false,
            head: { sha: 'abc123' },
            base: { ref: 'main' },
            title: 'PR',
            created_at: '2026-03-10T00:00:00.000Z',
            updated_at: '2026-03-10T00:00:00.000Z',
          },
        ]),
        get: record('pulls.get', {
          id: 100,
          number: 42,
          html_url: 'https://github.com/acme/example-repo/pull/42',
          state: 'closed',
          merged_at: '2026-03-11T00:00:00.000Z',
          title: 'PR',
          created_at: '2026-03-10T00:00:00.000Z',
          updated_at: '2026-03-11T00:00:00.000Z',
          comments: 0,
          review_comments: 0,
          head: { sha: 'abc123', ref: 'feature-branch' },
          base: { sha: 'def456', ref: 'main' },
        }),
        listReviews: record('pulls.listReviews', []),
        listReviewComments: record('pulls.listReviewComments', []),
      },
      issues: { listComments: record('issues.listComments', []) },
      checks: { listForRef: record('checks.listForRef', { check_runs: [] }) },
    };
    const conditionalHeaders = { 'if-none-match': 'W/"cached"' };
    const enqueue = jest.fn(
      (
        operation: (
          client: unknown,
          headers: Record<string, string>,
        ) => unknown,
        _priority?: 'high' | 'normal',
        requestOptions?: GitHubClientEnqueueOptions,
      ) => {
        options.push(requestOptions ?? {});
        return operation(octokit, conditionalHeaders);
      },
    );
    mockedGetGitHubClient.mockReturnValue({ enqueue });
    return { requests, options };
  }

  it('revalidates every safe REST read with a stable resource key and the broker ETag', async () => {
    const { requests, options } = installConditionalClient();

    await fetchRepoPrTrackingData('/tmp/repo', 'feature-branch', {
      includeCommentCollections: true,
    });

    expect(requests.map(({ method }) => method)).toEqual([
      'pulls.list',
      'pulls.get',
      'checks.listForRef',
      'pulls.listReviews',
      'pulls.listReviews',
      'issues.listComments',
      'pulls.listReviewComments',
    ]);
    for (const request of requests) {
      expect(request.params.headers).toEqual({ 'if-none-match': 'W/"cached"' });
    }
    expect(
      options.map(({ resourceKey, conditional, operation, idempotency }) => ({
        resourceKey,
        conditional,
        operation,
        idempotency,
      })),
    ).toEqual(
      [
        'pulls.list:acme/example-repo:open:feature-branch',
        'pulls.get:acme/example-repo#42',
        'checks.listForRef:acme/example-repo@abc123',
        'pulls.listReviews:acme/example-repo#42:1',
        'pulls.listReviews:acme/example-repo#42:1',
        'issues.listComments:acme/example-repo#42:1',
        'pulls.listReviewComments:acme/example-repo#42:1',
      ].map((resourceKey) => ({
        resourceKey,
        conditional: true,
        operation: 'read',
        idempotency: 'safe',
      })),
    );
    for (const option of options) {
      expect(option.isCachedData?.({ data: [] }) ?? false).toBe(
        option.resourceKey?.startsWith('pulls.get') ||
          option.resourceKey?.startsWith('checks.')
          ? false
          : true,
      );
    }
  });
});

describe('refused and known pull request reads', () => {
  const listItem = {
    number: 42,
    html_url: 'https://github.com/acme/example-repo/pull/42',
    state: 'open',
    draft: false,
    head: { sha: 'abc123' },
    base: { ref: 'main' },
    title: 'PR',
    created_at: '2026-03-10T00:00:00.000Z',
    updated_at: '2026-03-10T00:00:00.000Z',
  };
  const detail = {
    id: 100,
    number: 42,
    html_url: 'https://github.com/acme/example-repo/pull/42',
    state: 'open',
    draft: false,
    title: 'PR',
    created_at: '2026-03-10T00:00:00.000Z',
    updated_at: '2026-03-10T00:00:00.000Z',
    merged_at: null,
    mergeable: true,
    comments: 0,
    review_comments: 0,
    head: { sha: 'abc123', ref: 'feature-branch' },
    base: { sha: 'def456', ref: 'main' },
  };
  const refusal = (): GitHubBrokerError =>
    new GitHubBrokerError('rate_limited', 'Background reads are paused.', {
      retriable: true,
      retryAt: 1_900_000_000_000,
      resource: 'core',
    });
  const graphQlState = {
    repository: {
      pullRequest: {
        isMergeQueueEnabled: false,
        isInMergeQueue: false,
        mergeQueueEntry: null,
        reviewThreads: {
          nodes: [{ isResolved: false }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetRemoteUrl.mockResolvedValue(
      'https://github.com/acme/example-repo.git',
    );
  });

  it('fails the whole read when the broker refuses the detail read', async () => {
    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({ data: [listItem] })
      .mockRejectedValueOnce(refusal())
      .mockResolvedValueOnce({ data: { check_runs: [] } })
      .mockResolvedValueOnce({ data: [] });
    mockedGetGitHubClient.mockReturnValue({ enqueue });

    await expect(
      fetchRepoPrTrackingData('/tmp/repo', 'feature-branch'),
    ).rejects.toMatchObject({
      code: 'rate_limited',
      retryAt: 1_900_000_000_000,
    });
  });

  it('fails the whole read when the broker refuses the review-thread query', async () => {
    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({ data: [listItem] })
      .mockResolvedValueOnce({ data: detail })
      .mockResolvedValueOnce({ data: { check_runs: [] } })
      .mockResolvedValueOnce({ data: [] })
      .mockRejectedValueOnce(refusal());
    mockedGetGitHubClient.mockReturnValue({ enqueue });

    await expect(
      fetchRepoPrTrackingData('/tmp/repo', 'feature-branch'),
    ).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('fails the whole read when the broker refuses a comment page', async () => {
    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({ data: [listItem] })
      .mockResolvedValueOnce({ data: detail })
      .mockResolvedValueOnce({ data: { check_runs: [] } })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] })
      .mockRejectedValueOnce(refusal())
      .mockResolvedValueOnce({ data: [] });
    mockedGetGitHubClient.mockReturnValue({ enqueue });

    await expect(
      fetchRepoPrTrackingData('/tmp/repo', 'feature-branch', {
        includeCommentCollections: true,
      }),
    ).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('still degrades gracefully when a part fails for another reason', async () => {
    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({ data: [listItem] })
      .mockRejectedValueOnce(new Error('GitHub is down'))
      .mockResolvedValueOnce({ data: { check_runs: [] } })
      .mockResolvedValueOnce({ data: [] });
    mockedGetGitHubClient.mockReturnValue({ enqueue });

    const result = await fetchRepoPrTrackingData('/tmp/repo', 'feature-branch');

    expect(result.status?.prNumber).toBe(42);
    expect(result.snapshot).toBeNull();
  });

  const sweptPullRequest = {
    number: 42,
    url: 'https://github.com/acme/example-repo/pull/42',
    title: 'PR',
    state: 'open' as const,
    isDraft: false,
    headSha: 'abc123',
    baseRefName: 'main',
    createdAt: '2026-03-10T00:00:00.000Z',
    updatedAt: '2026-03-10T00:00:00.000Z',
    mergedAt: null,
  };

  it('reads a swept pull request without the branch lookup', async () => {
    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({ data: detail })
      .mockResolvedValueOnce({ data: { check_runs: [] } })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce(graphQlState);
    mockedGetGitHubClient.mockReturnValue({ enqueue });

    const result = await fetchTrackedPullRequestData({
      remote: { owner: 'acme', repo: 'example-repo' },
      branchName: 'feature-branch',
      pullRequest: sweptPullRequest,
    });

    expect(enqueue).toHaveBeenCalledTimes(4);
    expect(enqueue).toHaveBeenNthCalledWith(
      1,
      expect.any(Function),
      'normal',
      expect.objectContaining({
        resourceKey: 'pulls.get:acme/example-repo#42',
      }),
    );
    expect(result.complete).toBe(true);
    expect(result.trackingData.status).toEqual(
      expect.objectContaining({
        prNumber: 42,
        unresolvedReviewThreadCount: 1,
      }),
    );
    expect(result.trackingData.snapshot?.pr.number).toBe(42);
  });

  it('reuses review-thread and merge queue state instead of querying GraphQL', async () => {
    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({ data: detail })
      .mockResolvedValueOnce({ data: { check_runs: [] } })
      .mockResolvedValueOnce({ data: [] });
    mockedGetGitHubClient.mockReturnValue({ enqueue });

    const result = await fetchTrackedPullRequestData({
      remote: { owner: 'acme', repo: 'example-repo' },
      branchName: 'feature-branch',
      pullRequest: sweptPullRequest,
      reuseGraphQlState: {
        unresolvedReviewThreadCount: 3,
        mergeQueue: { required: true, inQueue: false },
        mergeQueueSnapshot: undefined,
      },
    });

    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(result.trackingData.status).toEqual(
      expect.objectContaining({
        unresolvedReviewThreadCount: 3,
        mergeQueue: { required: true, inQueue: false },
      }),
    );
  });

  it('reports a read with a failed part as incomplete', async () => {
    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({ data: detail })
      .mockRejectedValueOnce(new Error('checks unavailable'))
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce(graphQlState);
    mockedGetGitHubClient.mockReturnValue({ enqueue });

    const result = await fetchTrackedPullRequestData({
      remote: { owner: 'acme', repo: 'example-repo' },
      branchName: 'feature-branch',
      pullRequest: sweptPullRequest,
    });

    expect(result.complete).toBe(false);
    expect(result.trackingData.status?.checkStatus).toBe('none');
  });

  it('decides comment fetches from the live quota, not replayed 304 headers', async () => {
    const quota = jest
      .spyOn(getGitHubBroker(), 'currentQuota')
      .mockReturnValue({
        resource: 'core',
        limit: 5000,
        remaining: 4999,
        resetAtMs: 1_900_000_000_000,
      });
    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({
        data: detail,
        headers: { 'x-ratelimit-remaining': '9' },
      })
      .mockResolvedValueOnce({ data: { check_runs: [] } })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValue({ data: [] });
    mockedGetGitHubClient.mockReturnValue({ enqueue });
    const onCommentFetchSkipped = jest.fn();

    const result = await fetchTrackedPullRequestData({
      remote: { owner: 'acme', repo: 'example-repo' },
      branchName: 'feature-branch',
      pullRequest: sweptPullRequest,
      options: { includeCommentCollections: true, onCommentFetchSkipped },
    });

    expect(onCommentFetchSkipped).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(7);
    expect(result.trackingData.snapshot?.includesComments).toBe(true);
    quota.mockRestore();
  });

  it.each([
    { token: 'pinned-low', calls: 4, skipped: true },
    { token: 'pinned-high', calls: 7, skipped: false },
  ])(
    'uses the real quota ledger for $token comment reads',
    async ({ token, calls, skipped }) => {
      resetGitHubBrokerForTests();
      const broker = getGitHubBroker();
      try {
        for (const [authenticationToken, remaining] of [
          ['pinned-low', 10],
          ['pinned-high', 4000],
        ] as const) {
          await broker.execute(
            () =>
              Promise.resolve({
                status: 200,
                headers: {
                  'x-ratelimit-limit': '5000',
                  'x-ratelimit-remaining': String(remaining),
                  'x-ratelimit-reset': String(
                    Math.floor(Date.now() / 1000) + 1800,
                  ),
                  'x-ratelimit-resource': 'core',
                },
                data: {},
              }),
            {
              authenticationToken,
              priority: 'watcher',
              operation: 'read',
              idempotency: 'safe',
              resourceKey: `quota-fixture:${authenticationToken}`,
              timeoutMs: 1000,
            },
          );
        }
        expect(broker.currentQuota()).toBeUndefined();
        expect(broker.currentQuota('core', 'pinned-low')?.remaining).toBe(10);
        const enqueue = jest
          .fn()
          .mockResolvedValueOnce({ data: detail })
          .mockResolvedValueOnce({ data: { check_runs: [] } })
          .mockResolvedValueOnce({ data: [] })
          .mockResolvedValueOnce(graphQlState)
          .mockResolvedValue({ data: [] });
        mockedGetGitHubClient.mockReturnValue({ enqueue });
        const onCommentFetchSkipped = jest.fn();
        await fetchTrackedPullRequestData({
          remote: { owner: 'acme', repo: 'example-repo' },
          branchName: 'feature-branch',
          pullRequest: sweptPullRequest,
          options: {
            authenticationToken: token,
            includeCommentCollections: true,
            onCommentFetchSkipped,
          },
        });
        expect(enqueue).toHaveBeenCalledTimes(calls);
        expect(onCommentFetchSkipped).toHaveBeenCalledTimes(skipped ? 1 : 0);
      } finally {
        resetGitHubBrokerForTests();
      }
    },
  );

  it('skips comment fetches when the live quota is at the floor', async () => {
    const quota = jest
      .spyOn(getGitHubBroker(), 'currentQuota')
      .mockReturnValue({
        resource: 'core',
        limit: 5000,
        remaining: 10,
        resetAtMs: 1_900_000_000_000,
      });
    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({
        data: detail,
        headers: { 'x-ratelimit-remaining': '4000' },
      })
      .mockResolvedValueOnce({ data: { check_runs: [] } })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValue({ data: [] });
    mockedGetGitHubClient.mockReturnValue({ enqueue });
    const onCommentFetchSkipped = jest.fn();

    await fetchTrackedPullRequestData({
      remote: { owner: 'acme', repo: 'example-repo' },
      branchName: 'feature-branch',
      pullRequest: sweptPullRequest,
      options: { includeCommentCollections: true, onCommentFetchSkipped },
    });

    expect(enqueue).toHaveBeenCalledTimes(4);
    expect(onCommentFetchSkipped).toHaveBeenCalledWith(
      expect.stringContaining('acme/example-repo#42'),
      expect.objectContaining({
        kind: 'primary',
        resource: 'core',
        retryAt: new Date(1_900_000_001_000).toISOString(),
      }),
    );
    quota.mockRestore();
  });

  it('reports a read whose GraphQL enrichment failed as incomplete', async () => {
    const enqueue = jest
      .fn()
      .mockResolvedValueOnce({ data: detail })
      .mockResolvedValueOnce({ data: { check_runs: [] } })
      .mockResolvedValueOnce({ data: [] })
      .mockRejectedValueOnce(new Error('GraphQL unavailable'));
    mockedGetGitHubClient.mockReturnValue({ enqueue });

    const result = await fetchTrackedPullRequestData({
      remote: { owner: 'acme', repo: 'example-repo' },
      branchName: 'feature-branch',
      pullRequest: sweptPullRequest,
    });

    expect(result.complete).toBe(false);
    expect(result.trackingData.status?.unresolvedReviewThreadCount).toBe(
      undefined,
    );
  });
});
