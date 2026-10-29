/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
const execute = jest.fn();
jest.mock('../lib/github-broker', () => ({
  getGitHubBroker: () => ({ execute }),
  GitHubBrokerError: jest.requireActual('../lib/github-broker/errors')
    .GitHubBrokerError,
}));

import {
  GitHubBrokerError,
  githubErrorHeaders,
  githubErrorStatus,
} from '../lib/github-broker/errors';
import {
  fetchGitHubPullRequest,
  normalizeGitHubPullRequestRead,
  normalizeGitHubPullRequestResponse,
} from '../lib/github-broker/pull-requests';
import { classifyGitHubRateLimit } from '../lib/github-broker/rate-limit';
import { githubPullRequestQueueHistoryFrom } from '../lib/github-pull-request-observer';
import { interpretPrMergeQueueTransition } from '@canopy/desktop-shared/lib/pr-merge-queue';

const HEAD_SHA = 'a'.repeat(40);
const MERGE_SHA = 'b'.repeat(40);
const OBSERVED_AT = '2026-10-07T00:00:00.000Z';

/** A GitHub-shaped queue timeline item at filtered index `index`. */
function rawQueueEvent(index: number, overrides: Record<string, unknown> = {}) {
  const added = index % 2 === 0;
  return {
    __typename: added ? 'AddedToMergeQueueEvent' : 'RemovedFromMergeQueueEvent',
    id: `${added ? 'ATMQE' : 'RFMQE'}_${index}`,
    createdAt: new Date(Date.UTC(2026, 9, 1) + index * 60_000).toISOString(),
    ...(added ? {} : { reason: 'failed_checks' }),
    ...overrides,
  };
}

/**
 * A `queueEvents` connection read with `last: pageSize` before filtered index
 * `end`, as GitHub answers it: `filteredCount` counts the items before the
 * cursor, and the start cursor names the first returned item.
 */
function queueConnection(nodes: unknown[], end = nodes.length, pageSize = 10) {
  const start = Math.max(0, end - pageSize);
  return {
    filteredCount: end,
    pageInfo: {
      hasPreviousPage: start > 0,
      startCursor: end > start ? `cursor:${start}` : null,
    },
    nodes: nodes.slice(start, end),
  };
}

function rawQueueEvents(count: number) {
  return Array.from({ length: count }, (_, index) => rawQueueEvent(index));
}

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'PR_node',
    state: 'OPEN',
    merged: false,
    mergedAt: null,
    closedAt: null,
    url: 'https://github.com/Acme/API/pull/12',
    title: 'Add the thing',
    baseRefName: 'develop',
    headRefOid: HEAD_SHA,
    mergeCommit: null,
    isInMergeQueue: false,
    mergeQueueEntry: null,
    queueEvents: queueConnection([]),
    ...overrides,
  };
}

function body(pr: unknown, extra: Record<string, unknown> = {}) {
  return { data: { repository: { pullRequest: pr } }, ...extra };
}

function errorCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof GitHubBrokerError ? error.code : 'unexpected';
  }
  return undefined;
}

describe('normalizeGitHubPullRequestResponse', () => {
  it('maps an open pull request in the merge queue', () => {
    expect(
      normalizeGitHubPullRequestResponse(
        body(
          pullRequest({
            isInMergeQueue: true,
            mergeQueueEntry: {
              id: 'MQE_1',
              enqueuedAt: '2026-10-06T23:59:00Z',
              state: 'AWAITING_CHECKS',
              position: 2,
            },
          }),
        ),
        12,
        OBSERVED_AT,
      ),
    ).toEqual({
      state: 'open',
      url: 'https://github.com/Acme/API/pull/12',
      title: 'Add the thing',
      baseRefName: 'develop',
      headSha: HEAD_SHA,
      mergedAt: null,
      mergeCommitSha: null,
      closedAt: null,
      queue: {
        entryId: 'MQE_1',
        enqueuedAt: '2026-10-06T23:59:00.000Z',
        phase: 'awaiting_checks',
        position: 2,
      },
      observedAt: OBSERVED_AT,
    });
  });

  it('maps a merge with its commit and a close without merging', () => {
    expect(
      normalizeGitHubPullRequestResponse(
        body(
          pullRequest({
            state: 'MERGED',
            merged: true,
            mergedAt: '2026-10-07T00:00:00Z',
            closedAt: '2026-10-07T00:00:00Z',
            mergeCommit: { oid: MERGE_SHA },
          }),
        ),
        12,
        OBSERVED_AT,
      ),
    ).toMatchObject({
      state: 'merged',
      mergedAt: '2026-10-07T00:00:00.000Z',
      mergeCommitSha: MERGE_SHA,
      queue: null,
    });
    expect(
      normalizeGitHubPullRequestResponse(
        body(
          pullRequest({
            state: 'CLOSED',
            closedAt: '2026-10-07T00:00:00Z',
            mergeCommit: { oid: MERGE_SHA },
          }),
        ),
        12,
        OBSERVED_AT,
      ),
    ).toMatchObject({
      state: 'closed',
      closedAt: '2026-10-07T00:00:00.000Z',
      mergedAt: null,
      mergeCommitSha: null,
    });
  });

  it('bounds the untrusted title and strips control characters', () => {
    const snapshot = normalizeGitHubPullRequestResponse(
      body(pullRequest({ title: `a\u0007b\n${'x'.repeat(400)}` })),
      12,
      OBSERVED_AT,
    );
    expect(snapshot.title).toHaveLength(200);
    expect(snapshot.title?.startsWith('a b x')).toBe(true);
  });

  it('keeps queue membership without an entry as an unknown phase', () => {
    expect(
      normalizeGitHubPullRequestResponse(
        body(pullRequest({ isInMergeQueue: true })),
        12,
        OBSERVED_AT,
      ).queue,
    ).toEqual({
      entryId: null,
      enqueuedAt: null,
      phase: 'unknown',
      position: null,
    });
  });

  it.each([
    ['a missing repository', { data: { repository: null } }, 'not_found'],
    ['a missing pull request', body(null), 'not_found'],
    [
      'a NOT_FOUND error',
      {
        data: { repository: { pullRequest: null } },
        errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }],
      },
      'not_found',
    ],
    [
      'a FORBIDDEN error',
      { data: null, errors: [{ type: 'FORBIDDEN', message: 'no' }] },
      'permission_denied',
    ],
    [
      'partial data with errors',
      body(pullRequest({ state: 'MERGED', mergedAt: '2026-10-07T00:00:00Z' }), {
        errors: [{ message: 'Something went wrong' }],
      }),
      'server_error',
    ],
    [
      'a RATE_LIMITED error',
      {
        data: null,
        errors: [{ type: 'RATE_LIMITED', message: 'limit' }],
      },
      'rate_limited',
    ],
    [
      'a merge without its merge time',
      body(pullRequest({ state: 'MERGED', merged: true })),
      'server_error',
    ],
    [
      'a close without its close time',
      body(pullRequest({ state: 'CLOSED' })),
      'server_error',
    ],
    [
      'an open pull request reported as merged',
      body(pullRequest({ merged: true, mergedAt: '2026-10-07T00:00:00Z' })),
      'server_error',
    ],
    [
      'a closed pull request reported as merged',
      body(
        pullRequest({
          state: 'CLOSED',
          merged: true,
          mergedAt: '2026-10-07T00:00:00Z',
          closedAt: '2026-10-07T00:00:00Z',
        }),
      ),
      'server_error',
    ],
    [
      'a merged state without the merged flag',
      body(
        pullRequest({
          state: 'MERGED',
          merged: false,
          mergedAt: '2026-10-07T00:00:00Z',
          closedAt: '2026-10-07T00:00:00Z',
        }),
      ),
      'server_error',
    ],
    [
      'a missing merged flag',
      body(pullRequest({ merged: null })),
      'server_error',
    ],
    [
      'a merge without its merge commit',
      body(
        pullRequest({
          state: 'MERGED',
          merged: true,
          mergedAt: '2026-10-07T00:00:00Z',
          closedAt: '2026-10-07T00:00:00Z',
          mergeCommit: null,
        }),
      ),
      'server_error',
    ],
    [
      'a merge with a malformed merge commit',
      body(
        pullRequest({
          state: 'MERGED',
          merged: true,
          mergedAt: '2026-10-07T00:00:00Z',
          closedAt: '2026-10-07T00:00:00Z',
          mergeCommit: { oid: 'not-a-sha' },
        }),
      ),
      'server_error',
    ],
    [
      'a missing merge queue membership flag',
      body(pullRequest({ isInMergeQueue: undefined })),
      'server_error',
    ],
    [
      'a non-boolean merge queue membership flag',
      body(pullRequest({ isInMergeQueue: 'false' })),
      'server_error',
    ],
    [
      'a missing merge queue entry key',
      body(pullRequest({ mergeQueueEntry: undefined })),
      'server_error',
    ],
    [
      'a non-object merge queue entry',
      body(pullRequest({ mergeQueueEntry: 'MQE_1' })),
      'server_error',
    ],
    [
      'timeline errors alongside errors elsewhere',
      body(pullRequest({ queueEvents: null }), {
        errors: [
          { path: ['repository', 'pullRequest', 'queueEvents'] },
          { path: ['repository', 'pullRequest', 'title'] },
        ],
      }),
      'server_error',
    ],
    [
      'timeline errors without the pull request',
      body(null, {
        errors: [
          {
            type: 'SERVICE_UNAVAILABLE',
            path: ['repository', 'pullRequest', 'queueEvents'],
          },
        ],
      }),
      'server_error',
    ],
    [
      'a RATE_LIMITED error on the timeline',
      body(pullRequest({ queueEvents: null }), {
        errors: [
          {
            type: 'RATE_LIMITED',
            path: ['repository', 'pullRequest', 'queueEvents'],
          },
        ],
      }),
      'rate_limited',
    ],
    [
      'a non-GitHub URL',
      body(pullRequest({ url: 'https://example.com/acme/api/pull/12' })),
      'invalid_response',
    ],
    [
      'another pull request URL',
      body(pullRequest({ url: 'https://github.com/acme/api/pull/13' })),
      'invalid_response',
    ],
    [
      'an unknown state',
      body(pullRequest({ state: 'DRAFTED' })),
      'invalid_response',
    ],
  ])('classifies %s', (_label, response, code) => {
    expect(
      errorCode(() =>
        normalizeGitHubPullRequestResponse(response, 12, OBSERVED_AT),
      ),
    ).toBe(code);
  });
});

describe('normalizeGitHubPullRequestRead queue timeline', () => {
  const QUEUE_ERROR = {
    type: 'SERVICE_UNAVAILABLE',
    message: 'Timeline unavailable',
    path: ['repository', 'pullRequest', 'queueEvents'],
  };

  function read(pr: unknown, extra: Record<string, unknown> = {}) {
    return normalizeGitHubPullRequestRead(body(pr, extra), 12, OBSERVED_AT);
  }

  it('maps the newest page with its indices and start cursor', () => {
    const nodes = rawQueueEvents(13);
    expect(
      read(pullRequest({ queueEvents: queueConnection(nodes) })).queueTimeline,
    ).toEqual({
      filteredCount: 13,
      startCursor: 'cursor:3',
      events: nodes.slice(3).map((node, offset) => ({
        type: (offset + 3) % 2 === 0 ? 'added' : 'removed',
        id: node.id,
        createdAt: node.createdAt,
        ...((offset + 3) % 2 === 0 ? {} : { reason: 'failed_checks' }),
      })),
    });
  });

  it('maps an empty timeline', () => {
    expect(read(pullRequest()).queueTimeline).toEqual({
      filteredCount: 0,
      startCursor: null,
      events: [],
    });
  });

  it('keeps equal timestamps and sanitizes removal reasons', () => {
    const at = '2026-10-06T09:15:10Z';
    const nodes = [
      rawQueueEvent(0, { createdAt: at }),
      rawQueueEvent(1, { createdAt: at, reason: 'merged' }),
      rawQueueEvent(3, { createdAt: at, reason: 'Merged' }),
      rawQueueEvent(5, { createdAt: at, reason: `a${'b'.repeat(64)}` }),
      rawQueueEvent(7, { createdAt: at, reason: 'dequeued\nby bot' }),
      rawQueueEvent(9, { createdAt: at, reason: undefined }),
    ];
    expect(
      read(
        pullRequest({ queueEvents: queueConnection(nodes) }),
      ).queueTimeline?.events.map((event) => event.reason),
    ).toEqual([undefined, 'merged', null, null, null, null]);
  });

  it.each([
    ['a missing timeline', { queueEvents: undefined }],
    ['a null timeline', { queueEvents: null }],
    [
      'a negative filtered count',
      { queueEvents: { ...queueConnection([]), filteredCount: -1 } },
    ],
    [
      'a fractional filtered count',
      { queueEvents: { ...queueConnection([]), filteredCount: 0.5 } },
    ],
    [
      'a string filtered count',
      { queueEvents: { ...queueConnection([]), filteredCount: '0' } },
    ],
    [
      'non-array nodes',
      { queueEvents: { ...queueConnection([]), nodes: null } },
    ],
    [
      'fewer nodes than the filtered count',
      {
        queueEvents: {
          ...queueConnection(rawQueueEvents(3)),
          filteredCount: 4,
        },
      },
    ],
    [
      'a missing page info',
      { queueEvents: { ...queueConnection([]), pageInfo: undefined } },
    ],
    [
      'a wrong previous-page flag',
      {
        queueEvents: {
          ...queueConnection(rawQueueEvents(2)),
          pageInfo: { hasPreviousPage: true, startCursor: 'cursor:0' },
        },
      },
    ],
    [
      'a missing start cursor field',
      {
        queueEvents: {
          ...queueConnection(rawQueueEvents(2)),
          pageInfo: { hasPreviousPage: false },
        },
      },
    ],
    ['a null node', { queueEvents: queueConnection([rawQueueEvent(0), null]) }],
    [
      'an unknown node type',
      {
        queueEvents: queueConnection([
          rawQueueEvent(0, { __typename: 'MergedEvent' }),
        ]),
      },
    ],
    [
      'a node without its type',
      {
        queueEvents: queueConnection([
          rawQueueEvent(0, { __typename: undefined }),
        ]),
      },
    ],
    [
      'a node without its id',
      { queueEvents: queueConnection([rawQueueEvent(0, { id: '' })]) },
    ],
    [
      'an oversized node id',
      {
        queueEvents: queueConnection([
          rawQueueEvent(0, { id: 'x'.repeat(129) }),
        ]),
      },
    ],
    [
      'an invalid creation time',
      {
        queueEvents: queueConnection([
          rawQueueEvent(0, { createdAt: 'yesterday' }),
        ]),
      },
    ],
    [
      'creation times going backwards',
      {
        queueEvents: queueConnection([
          rawQueueEvent(1),
          rawQueueEvent(0, { __typename: 'RemovedFromMergeQueueEvent' }),
        ]),
      },
    ],
  ])('drops the timeline for %s but keeps the snapshot', (_label, fields) => {
    const result = read(pullRequest(fields));
    expect(result.queueTimeline).toBeNull();
    expect(result.snapshot).toMatchObject({ state: 'open', queue: null });
  });

  it('drops only the timeline for errors confined to it, keeping a merge', () => {
    const result = read(
      pullRequest({
        state: 'MERGED',
        merged: true,
        mergedAt: '2026-10-07T00:00:00Z',
        closedAt: '2026-10-07T00:00:00Z',
        mergeCommit: { oid: MERGE_SHA },
        queueEvents: null,
      }),
      {
        errors: [
          QUEUE_ERROR,
          { ...QUEUE_ERROR, path: [...QUEUE_ERROR.path, 'nodes', 0] },
        ],
      },
    );
    expect(result.queueTimeline).toBeNull();
    expect(result.snapshot).toMatchObject({
      state: 'merged',
      mergeCommitSha: MERGE_SHA,
    });
  });

  it('drops a timeline that came back alongside its own errors', () => {
    expect(
      read(pullRequest({ queueEvents: queueConnection(rawQueueEvents(2)) }), {
        errors: [QUEUE_ERROR],
      }).queueTimeline,
    ).toBeNull();
  });
});

describe('fetchGitHubPullRequest', () => {
  beforeEach(() => execute.mockReset());

  it('posts one GraphQL read through the broker as a safe watcher read', async () => {
    execute.mockImplementation(async (request, options) => {
      expect(options).toMatchObject({
        priority: 'watcher',
        operation: 'read',
        idempotency: 'safe',
      });
      expect(options.conditional).toBeUndefined();
      const octokit = {
        request: jest.fn().mockResolvedValue({
          status: 200,
          headers: {},
          data: body(pullRequest()),
        }),
      };
      const response = await request(octokit, {});
      expect(octokit.request).toHaveBeenCalledWith(
        'POST /graphql',
        expect.objectContaining({
          variables: { owner: 'acme', name: 'api', number: 12 },
        }),
      );
      const [, params] = octokit.request.mock.calls[0];
      for (const field of [
        'state',
        'merged',
        'mergedAt',
        'closedAt',
        'baseRefName',
        'headRefOid',
        'mergeCommit { oid }',
        'isInMergeQueue',
        'mergeQueueEntry { id enqueuedAt state position }',
        'queueEvents: timelineItems(itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT], last: 10)',
        'filteredCount',
        'pageInfo { hasPreviousPage startCursor }',
        '__typename',
        '... on AddedToMergeQueueEvent { id createdAt }',
        '... on RemovedFromMergeQueueEvent { id createdAt reason }',
      ]) {
        expect(params.query).toContain(field);
      }
      expect(params.query).not.toContain('since');
      expect(params.query).not.toContain('totalCount');
      return { kind: 'read', status: 200, changed: true, data: response.data };
    });

    await expect(
      fetchGitHubPullRequest({
        repository: 'acme/api',
        number: 12,
        priority: 'watcher',
      }),
    ).resolves.toEqual({
      snapshot: expect.objectContaining({ state: 'open', headSha: HEAD_SHA }),
      queueHistory: {
        status: 'complete',
        filteredCount: 0,
        firstIndex: 0,
        events: [],
      },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed request before reaching the broker', async () => {
    await expect(
      fetchGitHubPullRequest({
        repository: 'acme',
        number: 12,
        priority: 'watcher',
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(
      fetchGitHubPullRequest({
        repository: 'acme/api',
        number: 0,
        priority: 'watcher',
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('propagates GraphQL errors from the response body as typed broker errors', async () => {
    execute.mockImplementation((request) => {
      const octokit = {
        request: jest.fn().mockResolvedValue({
          status: 200,
          headers: {},
          data: { data: null, errors: [{ type: 'NOT_FOUND' }] },
        }),
      };
      return request(octokit, {});
    });
    await expect(
      fetchGitHubPullRequest({
        repository: 'acme/api',
        number: 12,
        priority: 'interactive',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('surfaces a GraphQL rate limit to the broker as a 429 with GitHub headers', async () => {
    const resetEpoch = Math.floor(Date.now() / 1000) + 120;
    const headers = {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(resetEpoch),
      'x-ratelimit-resource': 'graphql',
    };
    let thrown: unknown;
    execute.mockImplementation(async (request) => {
      const octokit = {
        request: jest.fn().mockResolvedValue({
          status: 200,
          headers,
          data: { data: null, errors: [{ type: 'RATE_LIMITED' }] },
        }),
      };
      try {
        return await request(octokit, {});
      } catch (error) {
        thrown = error;
        throw error;
      }
    });
    await expect(
      fetchGitHubPullRequest({
        repository: 'acme/api',
        number: 12,
        priority: 'watcher',
      }),
    ).rejects.toThrow('GitHub GraphQL rate limit exceeded.');
    expect(githubErrorStatus(thrown)).toBe(429);
    expect(
      classifyGitHubRateLimit({
        status: githubErrorStatus(thrown),
        headers: githubErrorHeaders(thrown),
        secondaryRetryIndex: 0,
        nowMs: Date.now(),
      }),
    ).toMatchObject({ kind: 'primary', retryAtMs: resetEpoch * 1000 + 1000 });
  });

  describe('queue history paging', () => {
    interface GraphQlParams {
      query: string;
      variables: Record<string, unknown>;
    }

    /** Answers both queries from one timeline the way GitHub pages it. */
    function timelineOctokit(
      nodes: unknown[],
      overrideHistoryPage?: (connection: unknown) => unknown,
    ) {
      return {
        request: jest.fn((_route: string, params: GraphQlParams) => {
          const before = params.variables.before;
          if (typeof before !== 'string') {
            return Promise.resolve({
              status: 200,
              headers: {},
              data: body(pullRequest({ queueEvents: queueConnection(nodes) })),
            });
          }
          const connection = queueConnection(
            nodes,
            Number(before.slice('cursor:'.length)),
            50,
          );
          return Promise.resolve({
            status: 200,
            headers: {},
            data: overrideHistoryPage
              ? overrideHistoryPage(connection)
              : {
                  data: {
                    repository: { pullRequest: { queueEvents: connection } },
                  },
                },
          });
        }),
      };
    }

    function serve(octokit: { request: jest.Mock }) {
      const options: Record<string, unknown>[] = [];
      execute.mockImplementation(
        async (request, requestOptions: Record<string, unknown>) => {
          options.push(requestOptions);
          const response = await request(octokit, {});
          return {
            kind: 'read',
            status: 200,
            changed: true,
            data: response.data,
          };
        },
      );
      return options;
    }

    function historyBefore(octokit: { request: jest.Mock }) {
      return octokit.request.mock.calls
        .map(([, params]: [string, GraphQlParams]) => params.variables.before)
        .filter((before: unknown) => before !== undefined);
    }

    function fetchFrom(queueHistoryFrom?: number) {
      return fetchGitHubPullRequest({
        repository: 'acme/api',
        number: 12,
        priority: 'watcher',
        ...(queueHistoryFrom === undefined ? {} : { queueHistoryFrom }),
      });
    }

    it('returns only the newest page without a history floor', async () => {
      const octokit = timelineOctokit(rawQueueEvents(70));
      serve(octokit);
      const { queueHistory } = await fetchFrom();
      expect(queueHistory).toMatchObject({
        status: 'complete',
        filteredCount: 70,
        firstIndex: 60,
      });
      expect(octokit.request).toHaveBeenCalledTimes(1);
    });

    it.each([2, 60])(
      'reads back far enough for the interpreter to continue from a cursor at %i',
      async (count) => {
        const nodes = rawQueueEvents(count + 10);
        serve(timelineOctokit(nodes));
        const cursor = { count, lastEventId: nodes[count - 1].id };
        const { snapshot, queueHistory } = await fetchFrom(
          githubPullRequestQueueHistoryFrom([
            {
              watcherId: 'watcher-a',
              repository: 'acme/api',
              number: 12,
              last: normalizeGitHubPullRequestResponse(
                body(pullRequest()),
                12,
                OBSERVED_AT,
              ),
              queueCursor: cursor,
            },
          ]),
        );
        const notQueued = {
          inQueue: false,
          entryId: null,
          enqueuedAt: null,
          position: null,
        };
        const result = interpretPrMergeQueueTransition({
          previous: notQueued,
          next: notQueued,
          state: snapshot.state,
          history: queueHistory,
          cursor,
          filter: { entered: false, phases: [] },
          gapReported: false,
          observedAt: OBSERVED_AT,
          previousObservedAt: OBSERVED_AT,
        });
        expect(result.gap).toBe(false);
        expect(result.cursor).toEqual({
          count: count + 10,
          lastEventId: nodes[count + 9].id,
        });
      },
    );

    it('reads nothing older when the floor is already covered', async () => {
      const octokit = timelineOctokit(rawQueueEvents(70));
      serve(octokit);
      await expect(fetchFrom(60)).resolves.toMatchObject({
        queueHistory: { status: 'complete', firstIndex: 60 },
      });
      // A floor past the end (for example a shrunk timeline) reads nothing.
      await expect(fetchFrom(90)).resolves.toMatchObject({
        queueHistory: { status: 'complete', firstIndex: 60 },
      });
      expect(octokit.request).toHaveBeenCalledTimes(2);
    });

    it('pages back until the floor is covered as safe watcher reads', async () => {
      const nodes = rawQueueEvents(70);
      const octokit = timelineOctokit(nodes);
      const options = serve(octokit);
      const { snapshot, queueHistory } = await fetchGitHubPullRequest({
        repository: 'acme/api',
        number: 12,
        priority: 'interactive',
        queueHistoryFrom: 5,
      });
      expect(snapshot).toMatchObject({ state: 'open' });
      expect(historyBefore(octokit)).toEqual(['cursor:60', 'cursor:10']);
      expect(queueHistory).toMatchObject({
        status: 'complete',
        filteredCount: 70,
        firstIndex: 0,
      });
      expect(
        queueHistory.status === 'complete' &&
          queueHistory.events.map((event) => event.id),
      ).toEqual(nodes.map((node) => node.id));
      expect(options.slice(1)).toEqual([
        expect.objectContaining({
          priority: 'watcher',
          operation: 'read',
          idempotency: 'safe',
        }),
        expect.objectContaining({ priority: 'watcher' }),
      ]);
      const [, historyParams] = octokit.request.mock.calls[1];
      expect(historyParams.query).toContain('last: 50, before: $before');
      expect(historyParams.query).not.toContain('headRefOid');
      expect(historyParams.variables).toEqual({
        owner: 'acme',
        name: 'api',
        number: 12,
        before: 'cursor:60',
      });
    });

    it('stops once the floor is reached', async () => {
      const octokit = timelineOctokit(rawQueueEvents(70));
      serve(octokit);
      await expect(fetchFrom(30)).resolves.toMatchObject({
        queueHistory: { status: 'complete', firstIndex: 10 },
      });
      expect(historyBefore(octokit)).toEqual(['cursor:60']);
    });

    it('returns the earliest index reached when the page budget runs out', async () => {
      const octokit = timelineOctokit(rawQueueEvents(200));
      serve(octokit);
      const { queueHistory } = await fetchFrom(0);
      expect(historyBefore(octokit)).toEqual(['cursor:190', 'cursor:140']);
      expect(queueHistory).toMatchObject({
        status: 'complete',
        filteredCount: 200,
        firstIndex: 90,
      });
      expect(
        queueHistory.status === 'complete' && queueHistory.events.length,
      ).toBe(110);
    });

    it('fails the whole read when a history page fails transiently', async () => {
      const octokit = timelineOctokit(rawQueueEvents(70));
      const failure = new GitHubBrokerError('server_error', 'GitHub 502', {
        retriable: true,
        status: 502,
      });
      execute
        .mockImplementationOnce(async (request) => {
          const response = await request(octokit, {});
          return {
            kind: 'read',
            status: 200,
            changed: true,
            data: response.data,
          };
        })
        .mockRejectedValueOnce(failure);
      await expect(fetchFrom(0)).rejects.toBe(failure);
    });

    it('surfaces a history page rate limit to the broker as a 429', async () => {
      const resetEpoch = Math.floor(Date.now() / 1000) + 120;
      const headers = {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(resetEpoch),
      };
      const octokit = timelineOctokit(rawQueueEvents(70));
      const thrown: unknown[] = [];
      execute.mockImplementation(async (request) => {
        try {
          const response = await request(
            {
              request: async (route: string, params: GraphQlParams) =>
                params.variables.before === undefined
                  ? octokit.request(route, params)
                  : {
                      status: 200,
                      headers,
                      data: { data: null, errors: [{ type: 'RATE_LIMITED' }] },
                    },
            },
            {},
          );
          return {
            kind: 'read',
            status: 200,
            changed: true,
            data: response.data,
          };
        } catch (error) {
          thrown.push(error);
          throw error;
        }
      });
      await expect(fetchFrom(0)).rejects.toThrow(
        'GitHub GraphQL rate limit exceeded.',
      );
      expect(githubErrorStatus(thrown[0])).toBe(429);
      expect(githubErrorHeaders(thrown[0])).toMatchObject(headers);
    });

    it('fails the whole read on history page errors outside the timeline', async () => {
      serve(
        timelineOctokit(rawQueueEvents(70), () => ({
          data: null,
          errors: [{ type: 'SERVICE_UNAVAILABLE', message: 'Try again' }],
        })),
      );
      await expect(fetchFrom(0)).rejects.toMatchObject({
        code: 'server_error',
        retriable: true,
      });
    });

    it.each([
      [
        'errors confined to the timeline',
        () => ({
          data: { repository: { pullRequest: { queueEvents: null } } },
          errors: [{ path: ['repository', 'pullRequest', 'queueEvents'] }],
        }),
      ],
      [
        'a filtered count that does not match the cursor',
        (connection: unknown) => ({
          data: {
            repository: {
              pullRequest: {
                queueEvents: { ...Object(connection), filteredCount: 61 },
              },
            },
          },
        }),
      ],
      [
        'a page newer than the one after it',
        (connection: unknown) => {
          const page = Object(connection);
          return {
            data: {
              repository: {
                pullRequest: {
                  queueEvents: {
                    ...page,
                    nodes: page.nodes.map((node: Record<string, unknown>) => ({
                      ...node,
                      createdAt: '2027-01-01T00:00:00Z',
                    })),
                  },
                },
              },
            },
          };
        },
      ],
      [
        'a page repeating a newer event',
        (connection: unknown) => {
          const page = Object(connection);
          return {
            data: {
              repository: {
                pullRequest: {
                  queueEvents: {
                    ...page,
                    nodes: [...page.nodes.slice(0, -1), rawQueueEvent(61)].map(
                      (node: Record<string, unknown>) => ({
                        ...node,
                        createdAt: '2026-09-01T00:00:00Z',
                      }),
                    ),
                  },
                },
              },
            },
          };
        },
      ],
      ['a missing pull request', () => ({ data: { repository: null } })],
      ['a non-object body', () => 'nope'],
    ])(
      'reports unavailable history for %s while keeping the snapshot',
      async (_label, historyPage) => {
        serve(timelineOctokit(rawQueueEvents(70), historyPage));
        await expect(fetchFrom(0)).resolves.toEqual({
          snapshot: expect.objectContaining({ state: 'open' }),
          queueHistory: { status: 'unavailable' },
        });
      },
    );

    it('reports unavailable history when an older page has no cursor', async () => {
      const nodes = rawQueueEvents(20);
      const octokit = {
        request: jest.fn().mockResolvedValue({
          status: 200,
          headers: {},
          data: body(
            pullRequest({
              queueEvents: {
                ...queueConnection(nodes),
                pageInfo: { hasPreviousPage: true, startCursor: null },
              },
            }),
          ),
        }),
      };
      serve(octokit);
      await expect(fetchFrom(0)).resolves.toMatchObject({
        queueHistory: { status: 'unavailable' },
      });
      expect(octokit.request).toHaveBeenCalledTimes(1);
    });

    it('reports unavailable history without reading older pages when the newest is unusable', async () => {
      const octokit = {
        request: jest.fn().mockResolvedValue({
          status: 200,
          headers: {},
          data: body(pullRequest({ queueEvents: null })),
        }),
      };
      serve(octokit);
      await expect(fetchFrom(0)).resolves.toMatchObject({
        snapshot: { state: 'open' },
        queueHistory: { status: 'unavailable' },
      });
      expect(octokit.request).toHaveBeenCalledTimes(1);
    });
  });
});
