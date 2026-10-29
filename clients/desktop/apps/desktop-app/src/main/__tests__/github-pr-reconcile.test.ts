jest.mock('../lib/github-client', () => ({
  getGitHubClient: jest.fn(),
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(() => Promise.resolve({ items: [] })),
}));
jest.mock('../lib/worktree-repo-entries', () => ({
  listWorkspaceWorktreeRepoEntries: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../lib/git', () => ({
  getRemoteUrl: jest.fn(),
  getCurrentBranch: jest.fn(),
}));
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
}));
jest.mock('../lib/workspace-registry', () => ({
  isMultiRepoWorkspace: jest.fn(() => false),
}));
jest.mock('../lib/paths', () => ({
  getWorktreeDir: jest.fn(
    (projectId: string, worktreeId: string) => `/w/${projectId}/${worktreeId}`,
  ),
}));

import { getCurrentBranch, getRemoteUrl } from '../lib/git';
import { getGitHubClient } from '../lib/github-client';
import {
  invalidateReconcileViewerCache,
  listPullRequestsByViewer,
  listReconcilableRepos,
} from '../lib/github-pr-reconcile';
import { readAllSidebarItems } from '../lib/sidebar-items';
import type { ReconcilableRepo } from '../services/pr-telemetry-reconciler';

interface SearchNode {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  mergedAt: string | null;
  closedAt?: string | null;
  state?: string;
  isDraft?: boolean;
  headRefName: string;
  reviewDecision?: string | null;
  commits?: {
    nodes: Array<{
      commit: { statusCheckRollup: { state: string } | null };
    } | null>;
  };
}

interface FakeOctokit {
  users: {
    getAuthenticated: () => Promise<{ data: { login: string } }>;
  };
  graphql: jest.Mock<
    Promise<unknown>,
    [string, { q: string; cursor: string | null }]
  >;
}

const REPO: ReconcilableRepo = {
  projectId: 'canopy',
  repoId: 'canopy',
  repoName: 'canopy',
  owner: 'o',
  repo: 'canopy',
  dedupeByPrNumberOnly: true,
  ownedPrNumbers: new Set<number>(),
  unresolvedLiveBranches: new Set<string>(),
  liveBranches: new Set<string>(),
};

function isOctokitCallback(
  value: unknown,
): value is (octokit: FakeOctokit) => Promise<unknown> {
  return typeof value === 'function';
}

function node(
  prNumber: number,
  overrides: Partial<SearchNode> = {},
): SearchNode {
  return {
    number: prNumber,
    title: `PR ${prNumber}`,
    url: `https://github.com/o/canopy/pull/${prNumber}`,
    createdAt: '2026-09-21T10:00:00Z',
    mergedAt: '2026-09-22T10:00:00Z',
    closedAt: '2026-09-22T10:00:00Z',
    state: 'MERGED',
    isDraft: false,
    headRefName: `feat/${prNumber}`,
    ...overrides,
  };
}

function rollup(state: string): SearchNode['commits'] {
  return { nodes: [{ commit: { statusCheckRollup: { state } } }] };
}

function mockSearch(nodes: SearchNode[]): FakeOctokit['graphql'] {
  const graphql: FakeOctokit['graphql'] = jest.fn<
    Promise<unknown>,
    [string, { q: string; cursor: string | null }]
  >();
  graphql.mockResolvedValue({
    search: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes,
    },
  });
  const octokit: FakeOctokit = {
    users: {
      getAuthenticated: () => Promise.resolve({ data: { login: 'sergii' } }),
    },
    graphql,
  };
  const enqueue = jest.fn();
  enqueue.mockImplementation((fn: unknown): Promise<unknown> => {
    if (!isOctokitCallback(fn)) {
      throw new Error('Expected an octokit callback');
    }
    return fn(octokit);
  });
  jest.mocked(getGitHubClient).mockReturnValue({ enqueue });
  return graphql;
}

describe('listPullRequestsByViewer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    invalidateReconcileViewerCache();
  });

  it('searches every PR the viewer updated in the window, in one query', async () => {
    // One search per repo covers merged, open and closed PRs (CAN-3516), so
    // extending the sweep does not add requests.
    const graphql = mockSearch([]);

    await listPullRequestsByViewer(REPO, new Date('2026-07-01T00:00:00Z'));

    expect(graphql).toHaveBeenCalledTimes(1);
    const [, variables] = graphql.mock.calls[0];
    expect(variables.q).toBe(
      'repo:o/canopy is:pr author:sergii updated:>=2026-07-01',
    );
  });

  it('returns open, draft and closed PRs with their state', async () => {
    mockSearch([
      node(4031, { state: 'OPEN', mergedAt: null, closedAt: null }),
      node(4055, {
        state: 'OPEN',
        isDraft: true,
        mergedAt: null,
        closedAt: null,
      }),
      node(4162, { state: 'CLOSED', mergedAt: null }),
      node(3994),
    ]);

    const records = await listPullRequestsByViewer(
      REPO,
      new Date('2026-07-01T00:00:00Z'),
    );

    expect(records.map((r) => [r.prNumber, r.state, r.mergedAt])).toEqual([
      [4031, 'open', undefined],
      [4055, 'draft', undefined],
      [4162, 'closed', undefined],
      [3994, 'merged', '2026-09-22T10:00:00Z'],
    ]);
  });

  it('keeps the lookback window for each state', async () => {
    const since = new Date('2026-07-01T00:00:00Z');
    mockSearch([
      // Merged before the window; only commented on inside it.
      node(1, {
        mergedAt: '2026-06-01T00:00:00Z',
        closedAt: '2026-06-01T00:00:00Z',
      }),
      // Opened before the window and still open.
      node(2, {
        state: 'OPEN',
        mergedAt: null,
        closedAt: null,
        createdAt: '2026-05-01T00:00:00Z',
      }),
      // Opened before the window, closed inside it: its close is news.
      node(3, {
        state: 'CLOSED',
        mergedAt: null,
        createdAt: '2026-05-01T00:00:00Z',
        closedAt: '2026-07-02T00:00:00Z',
      }),
      // Opened inside the window.
      node(4, {
        state: 'OPEN',
        mergedAt: null,
        closedAt: null,
        createdAt: '2026-07-02T00:00:00Z',
      }),
    ]);

    const records = await listPullRequestsByViewer(REPO, since);

    expect(records.map((r) => r.prNumber)).toEqual([3, 4]);
  });

  it('asks GitHub for check and review outcomes in the same query', async () => {
    const graphql = mockSearch([]);

    await listPullRequestsByViewer(REPO, new Date('2026-07-01'));

    const [query] = graphql.mock.calls[0];
    expect(query).toContain('reviewDecision');
    expect(query).toContain('statusCheckRollup');
  });

  it.each([
    ['SUCCESS', 'passing'],
    ['FAILURE', 'failing'],
    ['ERROR', 'failing'],
    ['PENDING', 'pending'],
    ['EXPECTED', 'pending'],
  ])('maps a %s check rollup to %s', async (state, expected) => {
    mockSearch([node(1, { commits: rollup(state) })]);

    const [record] = await listPullRequestsByViewer(
      REPO,
      new Date('2026-07-01'),
    );

    expect(record?.checkStatus).toBe(expected);
  });

  it.each([
    ['APPROVED', 'approved'],
    ['CHANGES_REQUESTED', 'changes_requested'],
    ['REVIEW_REQUIRED', 'pending'],
  ])('maps a %s review decision to %s', async (decision, expected) => {
    mockSearch([node(1, { reviewDecision: decision })]);

    const [record] = await listPullRequestsByViewer(
      REPO,
      new Date('2026-07-01'),
    );

    expect(record?.reviewStatus).toBe(expected);
  });

  it('leaves outcomes GitHub did not report unset', async () => {
    mockSearch([
      node(1, {
        reviewDecision: null,
        commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
      }),
    ]);

    const [record] = await listPullRequestsByViewer(
      REPO,
      new Date('2026-07-01'),
    );

    expect(record?.checkStatus).toBeUndefined();
    expect(record?.reviewStatus).toBeUndefined();
  });
});

describe('listReconcilableRepos', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reports every checked-out branch, and unresolved ones separately', async () => {
    jest.mocked(readAllSidebarItems).mockResolvedValue({
      items: [
        {
          id: 'canopy',
          type: 'single-repo',
          worktrees: [
            {
              id: 'tapir',
              lastKnownPrStatus: {
                lastCheckedAt: '2026-09-28T00:00:00Z',
                repos: [
                  {
                    repoId: 'tapir',
                    repoName: 'canopy',
                    status: {
                      prNumber: 3994,
                      prUrl: 'https://github.com/o/canopy/pull/3994',
                      title: 'PR',
                      state: 'open',
                      checkStatus: 'none',
                      reviewStatus: 'none',
                      hasConflicts: false,
                      commentCount: 0,
                      updatedAt: '2026-09-28T00:00:00Z',
                    },
                  },
                ],
              },
            },
            { id: 'kudu' },
          ],
        },
      ],
    });
    jest.mocked(getRemoteUrl).mockResolvedValue('git@github.com:o/canopy.git');
    jest
      .mocked(getCurrentBranch)
      .mockImplementation((path: string) =>
        Promise.resolve(path.endsWith('/tapir') ? 'tapir/chain' : 'kudu/fix'),
      );

    const [repo] = await listReconcilableRepos();

    expect(repo?.ownedPrNumbers).toEqual(new Set([3994]));
    expect(repo?.liveBranches).toEqual(new Set(['tapir/chain', 'kudu/fix']));
    expect(repo?.unresolvedLiveBranches).toEqual(new Set(['kudu/fix']));
  });
});
