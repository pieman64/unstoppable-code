import { GitHubBrokerError } from '../lib/github-broker/errors';
import type { Octokit } from '@octokit/rest';
import type {
  GitHubClient,
  GitHubClientEnqueueOptions,
} from '../lib/github-client';
import {
  buildPullRequestSweepDocuments,
  decodePullRequestSweepResponse,
  emitPullRequestSwept,
  fetchPullRequestSweep,
  onPullRequestSwept,
  planPullRequestRead,
  PULL_REQUEST_FULL_READ_INTERVAL_MS,
  PullRequestSweepBatchError,
  type BranchPullRequestLookup,
  type PreviousPullRequestRead,
  type SweptPullRequest,
} from '../lib/github-pr-sweep';

const REMOTE = { owner: 'acme', repo: 'example-repo' };

interface OpenNodeOverrides {
  number?: number;
  owner?: string | null;
  updatedAt?: string;
  commentCount?: number;
  newestCommentEdit?: string | null;
  reviewCount?: number;
  unresolvedThreads?: number;
  checkRuns?: Array<{ state: string; count: number }>;
  statusContexts?: Array<{ state: string; count: number }>;
  mergeable?: string;
  queueEvents?: number;
}

function openNode(overrides: OpenNodeOverrides = {}): Record<string, unknown> {
  const unresolved = overrides.unresolvedThreads ?? 0;
  return {
    number: overrides.number ?? 42,
    url: `https://github.com/acme/example-repo/pull/${overrides.number ?? 42}`,
    title: 'Sweep me',
    state: 'OPEN',
    isDraft: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: overrides.updatedAt ?? '2026-10-02T00:00:00Z',
    mergedAt: null,
    headRefOid: 'head-sha',
    baseRefName: 'main',
    headRepositoryOwner:
      overrides.owner === null ? null : { login: overrides.owner ?? 'acme' },
    mergeable: overrides.mergeable ?? 'MERGEABLE',
    reviewDecision: null,
    isInMergeQueue: false,
    mergeQueueEntry: null,
    comments: {
      totalCount: overrides.commentCount ?? 1,
      nodes: [{ lastEditedAt: overrides.newestCommentEdit ?? null }],
    },
    reviews: { totalCount: overrides.reviewCount ?? 0, nodes: [] },
    reviewThreads: {
      totalCount: unresolved + 1,
      nodes: [
        { isResolved: true },
        ...Array.from({ length: unresolved }, () => ({ isResolved: false })),
      ],
    },
    queueEvents: { filteredCount: overrides.queueEvents ?? 0 },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                checkRunCountsByState: overrides.checkRuns ?? [
                  { state: 'SUCCESS', count: 3 },
                ],
                statusContextCountsByState: overrides.statusContexts ?? [],
              },
            },
          },
        },
      ],
    },
  };
}

function latestNode(
  state: 'MERGED' | 'CLOSED',
  owner = 'acme',
): Record<string, unknown> {
  return {
    number: 17,
    url: 'https://github.com/acme/example-repo/pull/17',
    title: 'Merged earlier',
    state,
    isDraft: false,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-02T00:00:00Z',
    mergedAt: state === 'MERGED' ? '2026-09-02T00:00:00Z' : null,
    headRefOid: 'old-sha',
    baseRefName: 'main',
    headRepositoryOwner: { login: owner },
  };
}

function decodeOne(
  open: unknown[],
  latest: unknown[],
  extra: Record<string, unknown> = {},
): BranchPullRequestLookup | undefined {
  const [document] = buildPullRequestSweepDocuments(REMOTE, ['feature']);
  return decodePullRequestSweepResponse(
    {
      data: {
        repository: { b0: { nodes: open }, b0_latest: { nodes: latest } },
      },
      ...extra,
    },
    document,
    REMOTE.owner,
  ).get('feature');
}

function found(lookup: BranchPullRequestLookup | undefined): SweptPullRequest {
  if (lookup?.kind !== 'found') {
    throw new Error(`Expected a found lookup, got ${lookup?.kind}`);
  }
  return lookup.pullRequest;
}

describe('buildPullRequestSweepDocuments', () => {
  it('aliases each branch by index and passes every value as a variable', () => {
    const hostile = 'feat/"quoted" } { evil';
    const [document] = buildPullRequestSweepDocuments(REMOTE, [
      'feature-a',
      hostile,
    ]);

    expect(document.branches).toEqual(['feature-a', hostile]);
    expect(document.variables).toEqual({
      owner: 'acme',
      name: 'example-repo',
      b0_head: 'feature-a',
      b1_head: hostile,
    });
    expect(document.query).toContain(
      'query PullRequestSweep($owner: String!, $name: String!, $b0_head: String!, $b1_head: String!)',
    );
    expect(document.query).toContain(
      'b0: pullRequests(headRefName: $b0_head, states: [OPEN], first: 1',
    );
    expect(document.query).toContain(
      'b1_latest: pullRequests(headRefName: $b1_head, first: 1',
    );
    expect(document.query).not.toContain('feature-a');
    expect(document.query).not.toContain('evil');
    expect(document.query).not.toContain('acme');
  });

  it('chunks at 25 branches per document and drops duplicates', () => {
    const branches = Array.from({ length: 26 }, (_, index) => `b-${index}`);
    const documents = buildPullRequestSweepDocuments(REMOTE, [
      ...branches,
      'b-3',
    ]);

    expect(documents).toHaveLength(2);
    expect(documents[0]?.branches).toHaveLength(25);
    expect(documents[1]?.branches).toEqual(['b-25']);
    expect(documents[1]?.variables.b0_head).toBe('b-25');
    expect(documents[0]?.query).toContain('b24_latest:');
    expect(documents[0]?.query).not.toContain('b25:');
  });

  it('builds nothing for no branches', () => {
    expect(buildPullRequestSweepDocuments(REMOTE, [])).toEqual([]);
  });
});

describe('decodePullRequestSweepResponse', () => {
  it('prefers the open pull request and splits its fingerprint', () => {
    const pullRequest = found(decodeOne([openNode()], [latestNode('MERGED')]));

    expect(pullRequest).toEqual(
      expect.objectContaining({
        number: 42,
        state: 'open',
        isDraft: false,
        headSha: 'head-sha',
        baseRefName: 'main',
        mergedAt: null,
        checksInFlight: false,
      }),
    );
    expect(typeof pullRequest.fingerprint.status).toBe('string');
    expect(typeof pullRequest.fingerprint.remarks).toBe('string');
  });

  it('moves only remarks for new comments, edits, reviews, and resolved threads', () => {
    const base = found(decodeOne([openNode()], [])).fingerprint;
    for (const overrides of [
      { commentCount: 2 },
      { newestCommentEdit: '2026-10-03T00:00:00Z' },
      { reviewCount: 1 },
      { unresolvedThreads: 1 },
    ]) {
      const moved = found(decodeOne([openNode(overrides)], [])).fingerprint;
      expect(moved.status).toBe(base.status);
      expect(moved.remarks).not.toBe(base.remarks);
    }
  });

  it('moves only status for checks, mergeability, updates, and queue events', () => {
    const base = found(decodeOne([openNode()], [])).fingerprint;
    for (const overrides of [
      { checkRuns: [{ state: 'SUCCESS', count: 2 }] },
      { statusContexts: [{ state: 'FAILURE', count: 1 }] },
      { mergeable: 'CONFLICTING' },
      { updatedAt: '2026-10-05T00:00:00Z' },
      { queueEvents: 1 },
    ]) {
      const moved = found(decodeOne([openNode(overrides)], [])).fingerprint;
      expect(moved.remarks).toBe(base.remarks);
      expect(moved.status).not.toBe(base.status);
    }
  });

  it('flags checks in flight from check runs and status contexts', () => {
    expect(
      found(
        decodeOne(
          [openNode({ checkRuns: [{ state: 'IN_PROGRESS', count: 1 }] })],
          [],
        ),
      ).checksInFlight,
    ).toBe(true);
    expect(
      found(
        decodeOne(
          [openNode({ statusContexts: [{ state: 'PENDING', count: 1 }] })],
          [],
        ),
      ).checksInFlight,
    ).toBe(true);
  });

  it('ignores zero counts and count order in the fingerprint', () => {
    const ordered = found(
      decodeOne(
        [
          openNode({
            checkRuns: [
              { state: 'FAILURE', count: 1 },
              { state: 'SUCCESS', count: 2 },
            ],
          }),
        ],
        [],
      ),
    );
    const shuffled = found(
      decodeOne(
        [
          openNode({
            checkRuns: [
              { state: 'SUCCESS', count: 2 },
              { state: 'QUEUED', count: 0 },
              { state: 'FAILURE', count: 1 },
            ],
          }),
        ],
        [],
      ),
    );
    expect(shuffled.fingerprint).toEqual(ordered.fingerprint);
  });

  it('falls back to the newest closed or merged pull request', () => {
    const pullRequest = found(decodeOne([], [latestNode('MERGED')]));
    expect(pullRequest).toEqual(
      expect.objectContaining({
        number: 17,
        state: 'merged',
        mergedAt: '2026-09-02T00:00:00Z',
        checksInFlight: false,
      }),
    );
  });

  it('reports a branch without pull requests as none', () => {
    expect(decodeOne([], [])).toEqual({ kind: 'none' });
  });

  it('leaves a branch unresolved when the newest PR comes from a fork', () => {
    expect(decodeOne([openNode({ owner: 'someone-else' })], [])).toEqual({
      kind: 'unresolved',
    });
    expect(decodeOne([openNode({ owner: null })], [])).toEqual({
      kind: 'unresolved',
    });
    expect(decodeOne([], [latestNode('CLOSED', 'fork-owner')])).toEqual({
      kind: 'unresolved',
    });
  });

  it('matches the head owner case-insensitively', () => {
    expect(decodeOne([openNode({ owner: 'ACME' })], [])?.kind).toBe('found');
  });

  it('leaves a malformed pull request unresolved', () => {
    const malformed = { ...openNode(), commits: null };
    expect(decodeOne([malformed], [])).toEqual({ kind: 'unresolved' });
  });

  it('leaves only the branches with alias errors unresolved', () => {
    const documents = buildPullRequestSweepDocuments(REMOTE, ['one', 'two']);
    const lookups = decodePullRequestSweepResponse(
      {
        data: {
          repository: {
            b0: null,
            b0_latest: null,
            b1: { nodes: [] },
            b1_latest: { nodes: [] },
          },
        },
        errors: [{ type: 'FORBIDDEN', path: ['repository', 'b0'] }],
      },
      documents[0],
      'acme',
    );
    expect(lookups.get('one')).toEqual({ kind: 'unresolved' });
    expect(lookups.get('two')).toEqual({ kind: 'none' });
  });

  it('fails the document when the repository is missing or errors lack a branch path', () => {
    const [document] = buildPullRequestSweepDocuments(REMOTE, ['one']);
    expect(() =>
      decodePullRequestSweepResponse(
        { data: { repository: null }, errors: [{ type: 'NOT_FOUND' }] },
        document,
        'acme',
      ),
    ).toThrow(PullRequestSweepBatchError);
    expect(() =>
      decodePullRequestSweepResponse(
        {
          data: { repository: { b0: { nodes: [] }, b0_latest: { nodes: [] } } },
          errors: [{ message: 'Something went wrong' }],
        },
        document,
        'acme',
      ),
    ).toThrow(PullRequestSweepBatchError);
  });
});

interface GraphQlRequest {
  query: string;
  variables: Record<string, string>;
}

function installSweepClient(respond: (request: GraphQlRequest) => unknown): {
  client: GitHubClient;
  requests: GraphQlRequest[];
  options: unknown[];
} {
  const requests: GraphQlRequest[] = [];
  const options: unknown[] = [];
  const octokit = {
    request: (
      _route: string,
      params: GraphQlRequest,
    ): Promise<{
      status: number;
      headers: Record<string, string>;
      data: unknown;
    }> => {
      requests.push(params);
      return Promise.resolve({
        status: 200,
        headers: { 'x-ratelimit-remaining': '0' },
        data: respond(params),
      });
    },
  };
  const enqueue: GitHubClient['enqueue'] = async <T>(
    operation: (client: Octokit, headers: Record<string, string>) => Promise<T>,
    _priority?: 'high' | 'normal',
    requestOptions?: GitHubClientEnqueueOptions<T>,
  ): Promise<T> => {
    options.push(requestOptions);
    try {
      return await operation(octokit as Octokit, {});
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'status' in error &&
        error.status === 429
      ) {
        throw new GitHubBrokerError(
          'rate_limited',
          'GitHub refused the background read.',
          { retriable: true, retryAt: 1_000_000, resource: 'graphql' },
        );
      }
      throw error;
    }
  };
  return { client: { enqueue }, requests, options };
}

describe('fetchPullRequestSweep', () => {
  it('sends one safe read per chunk and decodes every branch', async () => {
    const branches = Array.from({ length: 27 }, (_, index) => `b-${index}`);
    const { client, requests, options } = installSweepClient((request) => ({
      data: {
        repository: Object.fromEntries(
          Object.keys(request.variables)
            .filter((name) => name.endsWith('_head'))
            .flatMap((name) => {
              const alias = name.replace(/_head$/, '');
              return [
                [alias, { nodes: [] }],
                [`${alias}_latest`, { nodes: [] }],
              ];
            }),
        ),
      },
    }));

    const lookups = await fetchPullRequestSweep(client, REMOTE, branches);

    expect(requests).toHaveLength(2);
    const sweepRead = {
      operation: 'read',
      idempotency: 'safe',
      resource: 'graphql',
      caller: 'pr-poller',
    };
    expect(options).toEqual([sweepRead, sweepRead]);
    expect(lookups.size).toBe(27);
    expect(
      Array.from(lookups.values()).every((lookup) => lookup.kind === 'none'),
    ).toBe(true);
  });

  it('leaves a failed chunk unresolved so its branches fall back', async () => {
    const { client } = installSweepClient(() => ({
      data: { repository: null },
    }));

    const lookups = await fetchPullRequestSweep(client, REMOTE, ['a', 'b']);

    expect(Array.from(lookups.entries())).toEqual([
      ['a', { kind: 'unresolved' }],
      ['b', { kind: 'unresolved' }],
    ]);
  });

  it('rejects a GraphQL rate limit instead of falling back', async () => {
    const { client } = installSweepClient(() => ({
      errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }],
    }));

    await expect(
      fetchPullRequestSweep(client, REMOTE, ['a']),
    ).rejects.toMatchObject({ code: 'rate_limited', retryAt: 1_000_000 });
  });
});

describe('planPullRequestRead', () => {
  const now = 10 * PULL_REQUEST_FULL_READ_INTERVAL_MS;
  const fingerprint = { status: 's1', remarks: 'r1' };
  const current: SweptPullRequest = {
    number: 42,
    url: 'https://github.com/acme/example-repo/pull/42',
    title: 'PR',
    state: 'open',
    isDraft: false,
    headSha: 'head-sha',
    baseRefName: 'main',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
    mergedAt: null,
    checksInFlight: false,
    fingerprint,
  };
  const previous: PreviousPullRequestRead = {
    number: 42,
    fingerprint,
    checksInFlight: false,
    lastFullReadAt: now - 60_000,
    includesComments: true,
  };

  it.each([
    {
      name: 'nothing moved',
      previous,
      current,
      needsComments: true,
      plan: { read: false, graphQl: false, comments: false, full: false },
    },
    {
      name: 'a first read',
      previous: null,
      current,
      needsComments: true,
      plan: { read: true, graphQl: true, comments: true, full: true },
    },
    {
      name: 'a different pull request',
      previous: { ...previous, number: 41 },
      current,
      needsComments: false,
      plan: { read: true, graphQl: true, comments: false, full: true },
    },
    {
      name: 'status moved',
      previous,
      current: { ...current, fingerprint: { status: 's2', remarks: 'r1' } },
      needsComments: true,
      plan: { read: true, graphQl: true, comments: false, full: false },
    },
    {
      name: 'remarks moved with a comment hook',
      previous,
      current: { ...current, fingerprint: { status: 's1', remarks: 'r2' } },
      needsComments: true,
      plan: { read: true, graphQl: true, comments: true, full: false },
    },
    {
      name: 'remarks moved without a comment hook',
      previous,
      current: { ...current, fingerprint: { status: 's1', remarks: 'r2' } },
      needsComments: false,
      plan: { read: true, graphQl: true, comments: false, full: false },
    },
    {
      name: 'a check in flight',
      previous,
      current: { ...current, checksInFlight: true },
      needsComments: true,
      plan: { read: true, graphQl: false, comments: false, full: false },
    },
    {
      name: 'checks that were in flight last time',
      previous: { ...previous, checksInFlight: true },
      current,
      needsComments: false,
      plan: { read: true, graphQl: false, comments: false, full: false },
    },
    {
      name: 'a comment hook without a comment baseline',
      previous: { ...previous, includesComments: false },
      current,
      needsComments: true,
      plan: { read: true, graphQl: false, comments: true, full: false },
    },
    {
      name: 'an unknown previous fingerprint',
      previous: { ...previous, fingerprint: null },
      current,
      needsComments: true,
      plan: { read: true, graphQl: true, comments: true, full: false },
    },
    {
      name: 'the 30-minute full read',
      previous: {
        ...previous,
        lastFullReadAt: now - PULL_REQUEST_FULL_READ_INTERVAL_MS,
      },
      current,
      needsComments: true,
      plan: { read: true, graphQl: true, comments: true, full: true },
    },
  ])(
    'plans $name',
    ({ previous: before, current: after, needsComments, plan }) => {
      expect(
        planPullRequestRead({
          previous: before,
          current: after,
          needsComments,
          now,
        }),
      ).toEqual(plan);
    },
  );
});

describe('onPullRequestSwept', () => {
  it('delivers sweep results until unsubscribed and isolates failing listeners', () => {
    const received: number[] = [];
    const failing = onPullRequestSwept(() => {
      throw new Error('observer failed');
    });
    const unsubscribe = onPullRequestSwept((event) => {
      received.push(event.number);
    });
    const event = {
      owner: 'acme',
      repo: 'example-repo',
      number: 42,
      fingerprint: { status: 's', remarks: 'r' },
    };

    emitPullRequestSwept(event);
    unsubscribe();
    failing();
    emitPullRequestSwept(event);

    expect(received).toEqual([42]);
  });
});
