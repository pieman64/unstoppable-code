/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-require-imports */
import type * as GitHubBrokerModule from '../lib/github-broker';
import type * as GitHubClientModule from '../lib/github-client';

jest.mock('../lib/github-auth', () => ({
  resolveGitHubToken: jest.fn().mockResolvedValue('ghp_test_token_123'),
  invalidateTokenCache: jest.fn(),
}));

const MockedOctokit = jest.fn().mockImplementation(() => ({
  _mockInstance: true,
}));

jest.mock('../lib/github-octokit-loader', () => ({
  loadOctokitConstructor: jest.fn(() => MockedOctokit),
}));

import { resolveGitHubToken, invalidateTokenCache } from '../lib/github-auth';

const mockedResolveGitHubToken = jest.mocked(resolveGitHubToken);
const mockedInvalidateTokenCache = jest.mocked(invalidateTokenCache);

function makeApiError(
  status: number,
  headers?: Record<string, string>,
): Error & { status: number; response?: { headers: Record<string, string> } } {
  const err = new Error(`GitHub API error: ${status}`) as Error & {
    status: number;
    response?: { headers: Record<string, string> };
  };
  err.status = status;
  if (headers) {
    err.response = { headers };
  }
  return err;
}

describe('github-client', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockedResolveGitHubToken.mockResolvedValue('ghp_test_token_123');
    MockedOctokit.mockImplementation(
      () =>
        ({
          _mockInstance: true,
        }) as any,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('rate-limit 403 with x-ratelimit-remaining: 0', () => {
    it('retries the request on rate-limit 403', async () => {
      const { getGitHubClient } = await importFreshModule();

      let callCount = 0;
      const client = getGitHubClient();
      const promise = client.enqueue(async () => {
        callCount += 1;
        if (callCount === 1) {
          throw makeApiError(403, {
            'x-ratelimit-remaining': '0',
            'retry-after': '1',
          });
        }
        return 'success';
      }, 'high');

      // Advance past the MIN_DELAY_MS for the first call
      await jest.advanceTimersByTimeAsync(600);
      // Advance past the retry-after pause (1 second) + MIN_DELAY_MS
      await jest.advanceTimersByTimeAsync(1600);

      const result = await promise;
      expect(result).toBe('success');
      expect(callCount).toBe(2);
    });
  });

  describe('background work during a rate limit', () => {
    it('is refused with the resume time instead of waiting or retrying', async () => {
      const { getGitHubClient } = await importFreshModule();

      let callCount = 0;
      const client = getGitHubClient();
      const promise = client.enqueue(async () => {
        callCount += 1;
        throw makeApiError(429, { 'retry-after': '120' });
      });
      const outcome = promise.then(
        () => null,
        (error: unknown) => error,
      );
      await jest.advanceTimersByTimeAsync(600);
      const error = await outcome;
      expect(error).toMatchObject({ code: 'rate_limited' });
      expect(
        error instanceof Error && 'retryAt' in error
          ? typeof error.retryAt
          : undefined,
      ).toBe('number');
      expect(callCount).toBe(1);

      const later = jest.fn();
      await expect(client.enqueue(later)).rejects.toMatchObject({
        code: 'rate_limited',
      });
      expect(later).not.toHaveBeenCalled();
    });

    it('passes the bucket and caller label to the broker', async () => {
      let modules!: {
        client: typeof GitHubClientModule;
        broker: typeof GitHubBrokerModule;
      };
      jest.isolateModules(() => {
        modules = {
          client: require('../lib/github-client') as typeof GitHubClientModule,
          broker: require('../lib/github-broker') as typeof GitHubBrokerModule,
        };
      });
      const { getGitHubClient } = modules.client;
      const { getGitHubBroker } = modules.broker;
      const client = getGitHubClient();
      await client.enqueue(async () => 'ok', 'high', {
        resource: 'graphql',
        caller: 'pr-poller',
      });
      expect(getGitHubBroker().getQuotaDiagnostics().spend?.entries).toEqual([
        expect.objectContaining({
          caller: 'pr-poller',
          priority: 'interactive',
          resource: 'graphql',
          requests: 1,
        }),
      ]);
    });
  });

  describe('permission 403 without rate-limit headers', () => {
    it('rejects immediately without retrying', async () => {
      const { getGitHubClient } = await importFreshModule();

      let callCount = 0;
      const client = getGitHubClient();
      const promise = client.enqueue(async () => {
        callCount += 1;
        throw makeApiError(403, {});
      });

      // Attach the rejection handler before advancing timers
      // to prevent unhandled rejection warnings
      const assertion = expect(promise).rejects.toThrow(
        'GitHub API error: 403',
      );

      await jest.advanceTimersByTimeAsync(600);

      await assertion;
      expect(callCount).toBe(1);
    });
  });

  describe('retry count reaches MAX_RETRIES', () => {
    it('rejects after exhausting all retries', async () => {
      const { getGitHubClient } = await importFreshModule();

      const client = getGitHubClient();
      const promise = client.enqueue(async () => {
        throw makeApiError(403, {
          'x-ratelimit-remaining': '0',
          'retry-after': '1',
        });
      }, 'high');

      const assertion = expect(promise).rejects.toThrow(
        'GitHub rate-limit retry budget was exhausted.',
      );

      // Process initial attempt + 3 retries, each needing retry-after + MIN_DELAY
      for (let i = 0; i < 5; i++) {
        await jest.advanceTimersByTimeAsync(2000);
      }

      await assertion;
    });
  });

  describe('401 → invalidate token cache and retry with fresh token', () => {
    it('invalidates token cache and retries with a fresh Octokit instance', async () => {
      const { getGitHubClient } = await importFreshModule();

      let callCount = 0;
      const client = getGitHubClient();
      const promise = client.enqueue(async () => {
        callCount += 1;
        if (callCount === 1) {
          throw makeApiError(401);
        }
        return 'authenticated';
      });

      await jest.advanceTimersByTimeAsync(600);

      const result = await promise;
      expect(result).toBe('authenticated');
      expect(mockedInvalidateTokenCache).toHaveBeenCalledTimes(1);
      // Octokit constructed once initially, then again after invalidation
      expect(MockedOctokit).toHaveBeenCalledTimes(2);
    });

    it('rejects if the retry after token refresh also fails', async () => {
      const { getGitHubClient } = await importFreshModule();

      const client = getGitHubClient();
      const promise = client.enqueue(async () => {
        throw makeApiError(401);
      });

      const assertion = expect(promise).rejects.toThrow(
        'GitHub authentication failed after refreshing credentials.',
      );

      await jest.advanceTimersByTimeAsync(600);

      await assertion;
      expect(mockedInvalidateTokenCache).toHaveBeenCalledTimes(1);
    });
  });

  // CAN-4070 rule: the broker's authentication failures, captured before
  // CAN-4109 routes GitHub reads and writes through core. The renderer offers
  // Connect GitHub from these messages (CAN-4466), and the PR and push flows
  // map them to `github_not_authenticated`, so they are contractual.
  describe('authentication failure goldens (CAN-4109)', () => {
    async function importClientWithAuthFailureCode(): Promise<{
      client: typeof GitHubClientModule;
      githubAuthFailureCode: (error: unknown) => string | undefined;
    }> {
      return new Promise((resolve) => {
        jest.isolateModules(() => {
          resolve({
            client:
              require('../lib/github-client') as typeof GitHubClientModule,
            githubAuthFailureCode: (
              require('../lib/github-push-auth-failure') as {
                githubAuthFailureCode: (error: unknown) => string | undefined;
              }
            ).githubAuthFailureCode,
          });
        });
      });
    }

    async function settle(promise: Promise<unknown>): Promise<unknown> {
      const outcome = promise.then(
        () => undefined,
        (error: unknown) => error,
      );
      await jest.advanceTimersByTimeAsync(600);
      return outcome;
    }

    it('rejects with the no-token message when no credential resolves', async () => {
      // resolveGitHubToken answers '' when neither a PAT nor gh supplies one.
      mockedResolveGitHubToken.mockResolvedValue('');
      const { client, githubAuthFailureCode } =
        await importClientWithAuthFailureCode();

      const error = await settle(
        client.getGitHubClient().enqueue(async () => 'unreachable', 'high'),
      );

      expect(error).toMatchObject({
        name: 'GitHubBrokerError',
        code: 'not_authenticated',
        message:
          'No GitHub token is available. Configure a PAT or sign in with the GitHub CLI.',
      });
      expect(githubAuthFailureCode(error)).toBe('github_not_authenticated');
    });

    it('rejects with the refreshed-credentials message after a second 401', async () => {
      const { client, githubAuthFailureCode } =
        await importClientWithAuthFailureCode();

      const error = await settle(
        client.getGitHubClient().enqueue(async () => {
          throw makeApiError(401);
        }, 'high'),
      );

      expect(error).toMatchObject({
        name: 'GitHubBrokerError',
        code: 'not_authenticated',
        status: 401,
        message: 'GitHub authentication failed after refreshing credentials.',
      });
      expect(githubAuthFailureCode(error)).toBe('github_not_authenticated');
    });
  });

  describe('high-priority items inserted before normal-priority items', () => {
    it('processes high-priority items before normal-priority items', async () => {
      const { getGitHubClient } = await importFreshModule();

      const order: string[] = [];
      const client = getGitHubClient();

      // Enqueue a slow first item to block the queue
      const blockingPromise = client.enqueue(async () => {
        order.push('blocking');
        return 'blocking';
      }, 'normal');

      // While the first item is being processed, enqueue normal then high
      const normalPromise = client.enqueue(async () => {
        order.push('normal');
        return 'normal';
      }, 'normal');

      const highPromise = client.enqueue(async () => {
        order.push('high');
        return 'high';
      }, 'high');

      // Process all queue items through their delays
      for (let i = 0; i < 5; i++) {
        await jest.advanceTimersByTimeAsync(600);
      }

      await Promise.all([blockingPromise, normalPromise, highPromise]);

      // The blocking item runs first (already dequeued), then high, then normal
      expect(order).toEqual(['blocking', 'high', 'normal']);
    });
  });

  describe('conditional reads', () => {
    interface PageResponse {
      status: number;
      headers: Record<string, string>;
      data: string[];
    }

    function isPageResponse(value: unknown): value is PageResponse {
      return (
        typeof value === 'object' &&
        value !== null &&
        'data' in value &&
        Array.isArray(value.data)
      );
    }

    const conditionalOptions = {
      resourceKey: 'pulls.listReviews:acme/repo#1:1',
      conditional: true,
      isCachedData: isPageResponse,
    };

    it('sends the cached ETag and resolves a 304 with the cached response', async () => {
      const { getGitHubClient } = await importFreshModule();
      const client = getGitHubClient();
      const seenHeaders: Array<Record<string, string>> = [];

      const first = client.enqueue(
        async (_octokit, conditionalHeaders) => {
          seenHeaders.push(conditionalHeaders);
          return {
            status: 200,
            headers: { etag: 'W/"v1"' },
            data: ['review'],
          };
        },
        'normal',
        conditionalOptions,
      );
      await jest.advanceTimersByTimeAsync(600);
      await expect(first).resolves.toEqual(
        expect.objectContaining({ data: ['review'] }),
      );

      const second = client.enqueue(
        async (_octokit, conditionalHeaders): Promise<PageResponse> => {
          seenHeaders.push(conditionalHeaders);
          throw makeApiError(304, {});
        },
        'normal',
        conditionalOptions,
      );
      await jest.advanceTimersByTimeAsync(600);
      await expect(second).resolves.toEqual(
        expect.objectContaining({ data: ['review'] }),
      );

      expect(seenHeaders).toEqual([{}, { 'if-none-match': 'W/"v1"' }]);
    });

    it('retries a 304 without cached data once without If-None-Match', async () => {
      const { getGitHubClient } = await importFreshModule();
      const client = getGitHubClient();
      const seenHeaders: Array<Record<string, string>> = [];
      let calls = 0;

      const read = client.enqueue(
        async (_octokit, conditionalHeaders): Promise<PageResponse> => {
          seenHeaders.push(conditionalHeaders);
          calls += 1;
          if (calls === 1) throw makeApiError(304, {});
          return { status: 200, headers: {}, data: ['fresh'] };
        },
        'normal',
        conditionalOptions,
      );
      await jest.advanceTimersByTimeAsync(1_200);

      await expect(read).resolves.toEqual(
        expect.objectContaining({ data: ['fresh'] }),
      );
      expect(seenHeaders).toEqual([{}, {}]);
    });

    it('never sends If-None-Match without a cache guard', async () => {
      const { getGitHubClient } = await importFreshModule();
      const client = getGitHubClient();
      const seenHeaders: Array<Record<string, string>> = [];
      const read = (): Promise<PageResponse> =>
        client.enqueue(
          async (_octokit, conditionalHeaders) => {
            seenHeaders.push(conditionalHeaders);
            return { status: 200, headers: { etag: 'W/"v1"' }, data: [] };
          },
          'normal',
          { resourceKey: 'unguarded', conditional: true },
        );

      const first = read();
      await jest.advanceTimersByTimeAsync(600);
      await first;
      const second = read();
      await jest.advanceTimersByTimeAsync(600);
      await second;

      expect(seenHeaders).toEqual([{}, {}]);
    });
  });

  describe('429 status → treated as rate limit', () => {
    it('retries on 429 status', async () => {
      const { getGitHubClient } = await importFreshModule();

      let callCount = 0;
      const client = getGitHubClient();
      const promise = client.enqueue(async () => {
        callCount += 1;
        if (callCount === 1) {
          throw makeApiError(429, { 'retry-after': '1' });
        }
        return 'recovered';
      }, 'high');

      // Advance past MIN_DELAY for initial call
      await jest.advanceTimersByTimeAsync(600);
      // Advance past the retry-after pause + MIN_DELAY
      await jest.advanceTimersByTimeAsync(1600);

      const result = await promise;
      expect(result).toBe('recovered');
      expect(callCount).toBe(2);
    });

    it('uses bounded fallback delay for a documented secondary limit without a header', async () => {
      const { getGitHubClient } = await importFreshModule();

      const rateLimitCb = jest.fn<void, [string, number]>();
      let callCount = 0;
      const client = getGitHubClient(rateLimitCb);
      const promise = client.enqueue(async () => {
        callCount += 1;
        if (callCount === 1) {
          const error = makeApiError(429, {});
          error.message = 'You have exceeded a secondary rate limit.';
          throw error;
        }
        return 'recovered';
      }, 'high');

      // Process first call
      await jest.advanceTimersByTimeAsync(600);

      expect(rateLimitCb).toHaveBeenCalledTimes(1);
      const retryAfterSeconds = rateLimitCb.mock.calls[0]?.[1] ?? 0;
      expect(retryAfterSeconds).toBeGreaterThanOrEqual(48);
      expect(retryAfterSeconds).toBeLessThanOrEqual(72);

      // Advance past the 60s pause + MIN_DELAY
      await jest.advanceTimersByTimeAsync(75_000);

      const result = await promise;
      expect(result).toBe('recovered');
      expect(callCount).toBe(2);
    });
  });
});

async function importFreshModule(): Promise<typeof GitHubClientModule> {
  return new Promise((resolve) => {
    jest.isolateModules(() => {
      const mod = require('../lib/github-client') as typeof GitHubClientModule;
      resolve(mod);
    });
  });
}
