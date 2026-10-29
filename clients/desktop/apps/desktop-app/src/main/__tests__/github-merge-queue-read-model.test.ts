/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
const execute = jest.fn();
jest.mock('../lib/github-broker', () => {
  const errors = jest.requireActual('../lib/github-broker/errors');
  return {
    getGitHubBroker: () => ({ execute }),
    GitHubBrokerError: errors.GitHubBrokerError,
    GitHubBrokerCredentialResetError: errors.GitHubBrokerCredentialResetError,
    isGitHubBrokerError: errors.isGitHubBrokerError,
  };
});

import { GitHubBrokerError } from '../lib/github-broker/errors';
import {
  GITHUB_MERGE_QUEUE_PAGE_SIZE,
  GITHUB_MERGE_QUEUE_TTL_MS,
  getGitHubMergeQueue,
  readGitHubMergeQueue,
  resetGitHubMergeQueueReadModel,
} from '../lib/github-merge-queue-read-model';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const FETCHED_AT = '2026-10-16T12:00:00.000Z';

function node(position: number, overrides: Record<string, unknown> = {}) {
  return {
    position,
    state: position <= 2 ? 'AWAITING_CHECKS' : 'QUEUED',
    estimatedTimeToMerge: 240 * position,
    enqueuedAt: '2026-10-16T11:30:00Z',
    pullRequest: {
      number: 5500 + position,
      title: `  feat:   change ${position} `,
      url: `https://github.com/acme/api/pull/${5500 + position}`,
      author: { login: 'mara-k' },
    },
    ...overrides,
  };
}

function body(mergeQueue: unknown, extra: Record<string, unknown> = {}) {
  return { data: { repository: { mergeQueue } }, ...extra };
}

function queue(nodes: unknown[], totalCount: unknown = nodes.length) {
  return {
    url: 'https://github.com/acme/api/queue/develop',
    configuration: { maximumEntriesToBuild: 2 },
    entries: { totalCount, nodes },
  };
}

interface Recorded {
  options: Record<string, unknown>;
  variables: Record<string, unknown>;
}

let requests: Recorded[] = [];
let responses: unknown[] = [];

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(NOW);
  requests = [];
  responses = [];
  resetGitHubMergeQueueReadModel();
  execute.mockReset();
  execute.mockImplementation(
    async (
      request: (
        octokit: unknown,
        headers: Record<string, string>,
      ) => Promise<{ data: unknown }>,
      options: Record<string, unknown>,
    ) => {
      const octokit = {
        request: jest.fn((_route: string, params: Record<string, unknown>) => {
          requests.push({
            options,
            variables: params.variables as Record<string, unknown>,
          });
          return Promise.resolve({
            status: 200,
            headers: {},
            data: responses.shift(),
          });
        }),
      };
      const raw = await request(octokit, {});
      return { kind: 'read', data: raw.data, changed: true, status: 200 };
    },
  );
});

afterEach(() => {
  jest.useRealTimers();
});

describe('readGitHubMergeQueue', () => {
  it('maps a queue to entries sorted by position', () => {
    const result = readGitHubMergeQueue(
      body(queue([node(3), node(1), node(2)], 9)),
      'develop',
      FETCHED_AT,
    );
    expect(result.queue).toMatchObject({
      url: 'https://github.com/acme/api/queue/develop',
      baseBranch: 'develop',
      totalCount: 9,
      maximumEntriesToBuild: 2,
      fetchedAt: FETCHED_AT,
    });
    expect(result.queue?.entries.map((entry) => entry.position)).toEqual([
      1, 2, 3,
    ]);
    expect(result.queue?.entries[0]).toEqual({
      position: 1,
      phase: 'awaiting_checks',
      estimatedSecondsToMerge: 240,
      enqueuedAt: '2026-10-16T11:30:00.000Z',
      pullRequest: {
        number: 5501,
        title: 'feat: change 1',
        url: 'https://github.com/acme/api/pull/5501',
        author: 'mara-k',
      },
    });
  });

  it('reports a branch without a merge queue as no queue', () => {
    expect(readGitHubMergeQueue(body(null), 'main', FETCHED_AT)).toEqual({
      queue: null,
    });
  });

  it('drops malformed entries and bounds untrusted values', () => {
    const result = readGitHubMergeQueue(
      body({
        url: 'javascript:alert(1)',
        configuration: { maximumEntriesToBuild: -2 },
        entries: {
          totalCount: 1,
          nodes: [
            node(1, { state: 'NEW_STATE', estimatedTimeToMerge: 'soon' }),
            node(2, {
              pullRequest: { number: 0, url: 'https://github.com/x' },
            }),
            node(3, {
              pullRequest: {
                number: 9,
                title: 'x'.repeat(5_000),
                url: 'https://evil.example/acme/api/pull/9',
              },
            }),
            node(4, {
              position: -1,
            }),
            node(5, {
              pullRequest: {
                number: 10,
                title: 'Has a weird author',
                url: 'https://github.com/acme/api/pull/10',
                author: { login: 'not a login' },
              },
            }),
            'garbage',
          ],
        },
      }),
      'develop',
      FETCHED_AT,
    );
    const view = result.queue;
    expect(view?.url).toBeNull();
    expect(view?.maximumEntriesToBuild).toBeNull();
    expect(view?.entries.map((entry) => entry.pullRequest.number)).toEqual([
      5501, 10,
    ]);
    expect(view?.entries[0]).toMatchObject({
      phase: 'unknown',
      estimatedSecondsToMerge: null,
    });
    expect(view?.entries[1]?.pullRequest.author).toBeNull();
    // A total smaller than the parsed page is not trusted.
    expect(view?.totalCount).toBe(2);
  });

  it('reads at most one page of entries', () => {
    const nodes = Array.from(
      { length: GITHUB_MERGE_QUEUE_PAGE_SIZE + 10 },
      (_, index) => node(index + 1),
    );
    const result = readGitHubMergeQueue(
      body(queue(nodes, 80)),
      'develop',
      FETCHED_AT,
    );
    expect(result.queue?.entries).toHaveLength(GITHUB_MERGE_QUEUE_PAGE_SIZE);
    expect(result.queue?.totalCount).toBe(80);
  });

  it('throws when the body names no repository', () => {
    const thrown = (body: unknown): unknown => {
      try {
        readGitHubMergeQueue(body, 'develop', FETCHED_AT);
      } catch (error) {
        return error;
      }
      return null;
    };
    expect(
      thrown({ data: { repository: null }, errors: [{ type: 'NOT_FOUND' }] }),
    ).toMatchObject({ code: 'not_found' });
    expect(thrown({})).toMatchObject({ code: 'invalid_response' });
  });
});

describe('getGitHubMergeQueue', () => {
  const request = { repository: 'acme/api', baseBranch: 'develop' };

  it('reads through the broker as an interactive GraphQL read', async () => {
    responses.push(body(queue([node(1)])));
    const result = await getGitHubMergeQueue(request);
    expect(result.queue?.entries).toHaveLength(1);
    expect(requests).toEqual([
      {
        options: expect.objectContaining({
          priority: 'interactive',
          operation: 'read',
          idempotency: 'safe',
          resource: 'graphql',
        }),
        variables: { owner: 'acme', name: 'api', branch: 'develop' },
      },
    ]);
  });

  it('shares concurrent reads and serves the cache until it goes stale', async () => {
    responses.push(body(queue([node(1)])), body(queue([node(1), node(2)])));
    const [first, second] = await Promise.all([
      getGitHubMergeQueue(request),
      getGitHubMergeQueue(request),
    ]);
    expect(first).toBe(second);
    expect(requests).toHaveLength(1);

    jest.setSystemTime(NOW + GITHUB_MERGE_QUEUE_TTL_MS);
    await getGitHubMergeQueue(request);
    expect(requests).toHaveLength(1);

    jest.setSystemTime(NOW + GITHUB_MERGE_QUEUE_TTL_MS + 1);
    const refreshed = await getGitHubMergeQueue(request);
    expect(requests).toHaveLength(2);
    expect(refreshed.queue?.entries).toHaveLength(2);
  });

  it('keys the cache by repository and branch', async () => {
    responses.push(body(queue([node(1)])), body(null));
    await getGitHubMergeQueue(request);
    const main = await getGitHubMergeQueue({ ...request, baseBranch: 'main' });
    expect(main.queue).toBeNull();
    expect(requests).toHaveLength(2);
  });

  it('forgets the cache when credentials reset', async () => {
    responses.push(body(queue([node(1)])), body(queue([node(1)])));
    await getGitHubMergeQueue(request);
    resetGitHubMergeQueueReadModel();
    await getGitHubMergeQueue(request);
    expect(requests).toHaveLength(2);
  });

  it('does not cache a failed read', async () => {
    execute.mockRejectedValueOnce(
      new GitHubBrokerError('network', 'offline', { retriable: true }),
    );
    await expect(getGitHubMergeQueue(request)).rejects.toMatchObject({
      code: 'network',
    });
    responses.push(body(queue([node(1)])));
    await expect(getGitHubMergeQueue(request)).resolves.toMatchObject({
      queue: { totalCount: 1 },
    });
  });

  it('rejects malformed requests before reading', async () => {
    for (const bad of [
      { repository: 'acme', baseBranch: 'develop' },
      { repository: 'acme/api/extra', baseBranch: 'develop' },
      { repository: 'acme/api', baseBranch: '' },
      { repository: 'acme/api', baseBranch: 'a..b' },
      { repository: 'acme/api', baseBranch: '-rf' },
    ]) {
      await expect(getGitHubMergeQueue(bad)).rejects.toMatchObject({
        code: 'invalid_response',
      });
    }
    expect(execute).not.toHaveBeenCalled();
  });
});
