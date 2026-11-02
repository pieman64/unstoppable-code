/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/require-await */
jest.mock('../lib/github-auth', () => ({
  resolveGitHubToken: jest.fn().mockResolvedValue('ghp_test'),
  invalidateTokenCache: jest.fn(),
}));

const MockOctokit = jest.fn().mockImplementation(() => ({}));
jest.mock('../lib/github-octokit-loader', () => ({
  loadOctokitConstructor: jest.fn(() => MockOctokit),
}));

import {
  getGitHubBroker,
  type GitHubBrokerError,
  type GitHubRawResponse,
  resetGitHubBrokerForTests,
} from '../lib/github-broker';
import {
  githubErrorHeaders,
  githubErrorMessage,
  githubErrorStatus,
  GitHubGraphQlRateLimitError,
} from '../lib/github-broker/errors';
import { fetchGitHubPullRequest } from '../lib/github-broker/pull-requests';
import {
  GitHubQuotaLedger,
  GitHubSpendCounters,
  readGitHubQuota,
} from '../lib/github-broker/quota';
import { classifyGitHubRateLimit } from '../lib/github-broker/rate-limit';
import { GitHubRequestScheduler } from '../lib/github-broker/scheduler';
import { createGitHubReferencePreviewReader } from '../lib/github-reference-preview';

jest.mock('../lib/main-process-logging', () => ({
  logMainProcessInfo: jest.fn(),
}));

function quotaHeaders(
  remaining: number,
  options: { limit?: number; resource?: string; resetEpoch?: number } = {},
): Record<string, string> {
  return {
    'x-ratelimit-limit': String(options.limit ?? 5000),
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-reset': String(
      options.resetEpoch ?? Math.floor(Date.now() / 1000) + 1800,
    ),
    'x-ratelimit-resource': options.resource ?? 'core',
  };
}

function apiError(
  status: number,
  headers: Record<string, string> = {},
  message = `GitHub ${status}`,
): Error & { status: number; response: { status: number; headers: object } } {
  return Object.assign(new Error(message), {
    status,
    response: { status, headers },
  });
}

describe('GitHub broker error narrowing', () => {
  it('reads supported response fields without trusting malformed values', () => {
    const error: unknown = {
      response: {
        status: 429,
        headers: {
          etag: 'v1',
          'retry-after': 60,
          vary: ['accept', 'authorization'],
          ignored: { nested: true },
        },
        data: { message: 'Slow down.' },
      },
    };

    expect(githubErrorStatus(error)).toBe(429);
    expect(githubErrorHeaders(error)).toEqual({
      etag: 'v1',
      'retry-after': 60,
      vary: ['accept', 'authorization'],
    });
    expect(githubErrorMessage(error)).toBe('Slow down.');
    expect(githubErrorHeaders({ response: { headers: ['invalid'] } })).toEqual(
      {},
    );
  });
});

describe('GitHub broker rate-limit helpers', () => {
  it('uses the primary reset epoch plus the safety margin', () => {
    expect(
      classifyGitHubRateLimit({
        status: 403,
        headers: {
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': '101',
        },
        secondaryRetryIndex: 0,
        nowMs: 100_000,
      }),
    ).toMatchObject({ kind: 'primary', retryAtMs: 102_000 });
  });

  it('does not classify a permission 403 as a rate limit', () => {
    expect(
      classifyGitHubRateLimit({
        status: 403,
        headers: {},
        message: 'Resource not accessible by personal access token',
        secondaryRetryIndex: 0,
        nowMs: 100_000,
      }),
    ).toBeNull();
  });

  it('uses the bounded secondary fallback sequence with jitter', () => {
    expect(
      classifyGitHubRateLimit({
        status: 429,
        headers: {},
        message: 'You have exceeded a secondary rate limit.',
        secondaryRetryIndex: 1,
        nowMs: 100_000,
        random: () => 0.5,
      }),
    ).toMatchObject({
      kind: 'secondary',
      retryAtMs: 220_000,
      retryAfterSeconds: 120,
    });
  });

  it('classifies a bare 429 with the bounded secondary fallback', () => {
    expect(
      classifyGitHubRateLimit({
        status: 429,
        headers: {},
        message: 'Too many requests',
        secondaryRetryIndex: 0,
        nowMs: 100_000,
        random: () => 0.5,
      }),
    ).toMatchObject({
      kind: 'secondary',
      retryAtMs: 160_000,
      retryAfterSeconds: 60,
    });
  });

  it('keeps a recognized secondary limit classified after retries exhaust', () => {
    expect(
      classifyGitHubRateLimit({
        status: 403,
        headers: {},
        message: 'You have exceeded a secondary rate limit.',
        secondaryRetryIndex: 3,
        nowMs: 100_000,
        random: () => 0.5,
      }),
    ).toMatchObject({
      kind: 'secondary',
      retryAtMs: 340_000,
      retryAfterSeconds: 240,
    });
  });
});

describe('GitHub quota ledger', () => {
  const nowMs = 1_000_000_000;
  const resetEpoch = nowMs / 1000 + 1800;

  it('reads limit, remaining, reset, and resource case-insensitively', () => {
    expect(
      readGitHubQuota({
        'X-RateLimit-Limit': '5000',
        'X-RateLimit-Remaining': '4321',
        'X-RateLimit-Reset': String(resetEpoch),
        'X-RateLimit-Resource': 'graphql',
      }),
    ).toEqual({
      resource: 'graphql',
      limit: 5000,
      remaining: 4321,
      resetAtMs: resetEpoch * 1000,
    });
    expect(readGitHubQuota({ 'x-ratelimit-remaining': '10' })).toBeNull();
    expect(
      readGitHubQuota({ ...quotaHeaders(10), 'x-ratelimit-resource': '' }),
    ).toBeNull();
    expect(
      readGitHubQuota({ ...quotaHeaders(10), 'x-ratelimit-limit': '0' }),
    ).toBeNull();
    expect(readGitHubQuota(undefined)).toBeNull();
  });

  it('keeps the latest answer of a window, even when it reports more left', () => {
    const ledger = new GitHubQuotaLedger();
    ledger.observe('resolved', quotaHeaders(100, { resetEpoch }));
    ledger.observe('resolved', quotaHeaders(4000, { resetEpoch }));
    expect(ledger.get('resolved', 'core', nowMs)?.remaining).toBe(4000);
  });

  it('ignores an answer from an older window', () => {
    const ledger = new GitHubQuotaLedger();
    ledger.observe('resolved', quotaHeaders(4000, { resetEpoch }));
    expect(
      ledger.observe(
        'resolved',
        quotaHeaders(5, { resetEpoch: resetEpoch - 3600 }),
      ),
    ).toBeNull();
    expect(ledger.get('resolved', 'core', nowMs)?.remaining).toBe(4000);
  });

  it('keeps buckets and credentials apart and forgets windows that reset', () => {
    const ledger = new GitHubQuotaLedger();
    ledger.observe('resolved', quotaHeaders(10, { resetEpoch }));
    ledger.observe(
      'resolved',
      quotaHeaders(4000, { resetEpoch, resource: 'graphql' }),
    );
    expect(ledger.get('resolved', 'graphql', nowMs)?.remaining).toBe(4000);
    expect(ledger.get('custom:other', 'core', nowMs)).toBeUndefined();
    expect(ledger.get('resolved', 'core', resetEpoch * 1000)).toBeUndefined();
    expect(
      ledger.refusedUntil('resolved', 'core', 'background', resetEpoch * 1000),
    ).toBeNull();
  });

  it.each([
    ['background', 1499, 1500],
    ['watcher', 499, 500],
    ['interactive', 0, 1],
  ] as const)(
    'holds %s requests below their floor until the reset',
    (priority, refused, admitted) => {
      const ledger = new GitHubQuotaLedger();
      ledger.observe('resolved', quotaHeaders(refused, { resetEpoch }));
      expect(ledger.refusedUntil('resolved', 'core', priority, nowMs)).toBe(
        resetEpoch * 1000,
      );
      ledger.observe('resolved', quotaHeaders(admitted, { resetEpoch }));
      expect(
        ledger.refusedUntil('resolved', 'core', priority, nowMs),
      ).toBeNull();
    },
  );

  it('clears every snapshot', () => {
    const ledger = new GitHubQuotaLedger();
    ledger.observe('resolved', quotaHeaders(1, { resetEpoch }));
    ledger.clear();
    expect(ledger.list(nowMs)).toEqual([]);
  });
});

describe('GitHub spend counters', () => {
  it('counts requests per caller and logs one line per window', () => {
    const log = jest.fn();
    const counters = new GitHubSpendCounters(log, 60_000);
    const quota = (): ReturnType<GitHubQuotaLedger['list']> => [
      { resource: 'core', limit: 5000, remaining: 3000, resetAtMs: 0 },
    ];
    counters.record(
      {
        caller: 'pr-poller',
        priority: 'background',
        resource: 'core',
        notModified: false,
      },
      0,
      quota,
    );
    counters.record(
      {
        caller: 'pr-poller',
        priority: 'background',
        resource: 'core',
        notModified: true,
      },
      1_000,
      quota,
    );
    counters.record(
      { priority: 'interactive', resource: 'graphql', notModified: false },
      2_000,
      quota,
    );
    expect(log).not.toHaveBeenCalled();
    expect(counters.summary()?.entries).toEqual([
      {
        caller: 'pr-poller',
        priority: 'background',
        resource: 'core',
        requests: 2,
        notModified: 1,
      },
      {
        caller: 'unlabeled',
        priority: 'interactive',
        resource: 'graphql',
        requests: 1,
        notModified: 0,
      },
    ]);

    counters.record(
      { priority: 'watcher', resource: 'core', notModified: false },
      60_000,
      quota,
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      '[github-broker] GitHub requests in the last 1 min: core 2 (pr-poller/background 2; 1 not modified); graphql 1 (unlabeled/interactive 1; 0 not modified). Remaining: core 3000/5000.',
    );
    expect(counters.summary()?.entries).toEqual([
      expect.objectContaining({ priority: 'watcher', requests: 1 }),
    ]);
  });
});

describe('GitHubRequestScheduler', () => {
  afterEach(() => jest.useRealTimers());

  it('pauses one bucket without holding requests for another', async () => {
    jest.useFakeTimers();
    const scheduler = new GitHubRequestScheduler();
    const pausedUntil = Date.now() + 60_000;
    scheduler.pauseUntil(pausedUntil, 'graphql');
    const coreTask = jest.fn().mockResolvedValue('core');
    const graphQlTask = jest.fn().mockResolvedValue('graphql');
    const watcherTask = jest.fn().mockResolvedValue('watcher');

    const graphQl = scheduler.schedule(graphQlTask, {
      priority: 'interactive',
      operation: 'read',
      timeoutMs: 10_000,
      resource: 'graphql',
    });
    const core = scheduler.schedule(coreTask, {
      priority: 'interactive',
      operation: 'read',
      timeoutMs: 10_000,
    });
    const watcher = scheduler.schedule(watcherTask, {
      priority: 'watcher',
      operation: 'read',
      timeoutMs: 10_000,
      resource: 'graphql',
    });

    await expect(core).resolves.toBe('core');
    await expect(watcher).rejects.toMatchObject({
      code: 'rate_limited',
      retryAt: pausedUntil,
      resource: 'graphql',
    });
    expect(watcherTask).not.toHaveBeenCalled();
    expect(graphQlTask).not.toHaveBeenCalled();
    expect(scheduler.getPauseUntil('graphql')).toBe(pausedUntil);
    expect(scheduler.getPauseUntil('core')).toBe(0);

    await jest.advanceTimersByTimeAsync(60_000);
    await expect(graphQl).resolves.toBe('graphql');
    scheduler.shutdown();
  });

  it('refuses watcher and background work during an account-wide pause and defers interactive work', async () => {
    jest.useFakeTimers();
    const scheduler = new GitHubRequestScheduler();
    let release!: () => void;
    const blocking = scheduler.schedule(
      () => new Promise<void>((resolve) => (release = resolve)),
      { priority: 'interactive', operation: 'read', timeoutMs: 120_000 },
    );
    const queuedWatcherTask = jest.fn().mockResolvedValue(undefined);
    const queuedWatcher = scheduler.schedule(queuedWatcherTask, {
      priority: 'watcher',
      operation: 'read',
      timeoutMs: 10_000,
    });
    const queuedWatcherAssertion = expect(queuedWatcher).rejects.toMatchObject({
      code: 'rate_limited',
    });
    const pausedUntil = Date.now() + 30_000;
    scheduler.pauseUntil(pausedUntil);
    await queuedWatcherAssertion;

    const background = scheduler.schedule(jest.fn(), {
      priority: 'background',
      operation: 'read',
      timeoutMs: 10_000,
      resource: 'graphql',
    });
    await expect(background).rejects.toMatchObject({
      code: 'rate_limited',
      retryAt: pausedUntil,
    });
    const interactiveTask = jest.fn().mockResolvedValue('later');
    const interactive = scheduler.schedule(interactiveTask, {
      priority: 'interactive',
      operation: 'read',
      timeoutMs: 10_000,
      resource: 'graphql',
    });
    release();
    await blocking;
    await jest.advanceTimersByTimeAsync(29_000);
    expect(interactiveTask).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(interactive).resolves.toBe('later');
    expect(queuedWatcherTask).not.toHaveBeenCalled();
    scheduler.shutdown();
  });

  it('checks admission when queuing and again right before starting', async () => {
    const scheduler = new GitHubRequestScheduler();
    let release!: () => void;
    const blocking = scheduler.schedule(
      () => new Promise<void>((resolve) => (release = resolve)),
      { priority: 'interactive', operation: 'read', timeoutMs: 10_000 },
    );
    const retryAt = Date.now() + 600_000;
    const refusedTask = jest.fn();
    await expect(
      scheduler.schedule(refusedTask, {
        priority: 'background',
        operation: 'read',
        timeoutMs: 10_000,
        admit: () => retryAt,
      }),
    ).rejects.toMatchObject({ code: 'rate_limited', retryAt });

    let refuse = false;
    const queuedTask = jest.fn();
    const queued = scheduler.schedule(queuedTask, {
      priority: 'watcher',
      operation: 'read',
      timeoutMs: 10_000,
      admit: () => (refuse ? retryAt : null),
    });
    refuse = true;
    release();
    await blocking;
    await expect(queued).rejects.toMatchObject({ code: 'rate_limited' });
    expect(refusedTask).not.toHaveBeenCalled();
    expect(queuedTask).not.toHaveBeenCalled();
    scheduler.shutdown();
  });

  it('times out queued work and prevents it from starting later', async () => {
    jest.useFakeTimers();
    const scheduler = new GitHubRequestScheduler();
    let release!: () => void;
    const first = scheduler.schedule(
      () => new Promise<void>((resolve) => (release = resolve)),
      { priority: 'interactive', operation: 'read', timeoutMs: 10_000 },
    );
    const secondTask = jest.fn().mockResolvedValue('late');
    const second = scheduler.schedule(secondTask, {
      priority: 'background',
      operation: 'read',
      timeoutMs: 50,
    });
    const assertion = expect(second).rejects.toMatchObject({ code: 'timeout' });
    await jest.advanceTimersByTimeAsync(60);
    await assertion;
    release();
    await first;
    expect(secondTask).not.toHaveBeenCalled();
    scheduler.shutdown();
  });

  it('aborts in-flight work when its queue-entry timeout expires', async () => {
    jest.useFakeTimers();
    const scheduler = new GitHubRequestScheduler();
    let wasAborted = false;
    const request = scheduler.schedule(
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            wasAborted = true;
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error('GitHub request was aborted.'),
            );
          });
        }),
      { priority: 'interactive', operation: 'read', timeoutMs: 50 },
    );
    const assertion = expect(request).rejects.toMatchObject({
      code: 'timeout',
    });
    await jest.advanceTimersByTimeAsync(50);
    await assertion;
    expect(wasAborted).toBe(true);
    scheduler.shutdown();
  });

  it('rejects queued and in-flight work on shutdown', async () => {
    const scheduler = new GitHubRequestScheduler();
    const first = scheduler.schedule(
      (signal) =>
        new Promise<void>((_resolve, reject) =>
          signal.addEventListener('abort', () =>
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error('Request aborted.'),
            ),
          ),
        ),
      { priority: 'interactive', operation: 'read', timeoutMs: 10_000 },
    );
    const second = scheduler.schedule(async () => undefined, {
      priority: 'background',
      operation: 'read',
      timeoutMs: 10_000,
    });
    const firstAssertion = expect(first).rejects.toMatchObject({
      code: 'shutdown',
    });
    const secondAssertion = expect(second).rejects.toMatchObject({
      code: 'shutdown',
    });
    scheduler.shutdown();
    await Promise.all([firstAssertion, secondAssertion]);
  });

  it('runs the oldest background request after five foreground starts', async () => {
    const scheduler = new GitHubRequestScheduler();
    const order: string[] = [];
    let release!: () => void;
    const blocking = scheduler.schedule(
      () =>
        new Promise<void>((resolve) => {
          order.push('blocking');
          release = resolve;
        }),
      { priority: 'interactive', operation: 'read', timeoutMs: 10_000 },
    );
    const interactive = Array.from({ length: 6 }, (_, index) =>
      scheduler.schedule(
        async () => {
          order.push(`interactive-${index}`);
        },
        { priority: 'interactive', operation: 'read', timeoutMs: 10_000 },
      ),
    );
    const background = scheduler.schedule(
      async () => {
        order.push('background');
      },
      { priority: 'background', operation: 'read', timeoutMs: 10_000 },
    );
    release();
    await Promise.all([blocking, ...interactive, background]);
    expect(order).toEqual([
      'blocking',
      'interactive-0',
      'interactive-1',
      'interactive-2',
      'interactive-3',
      'background',
      'interactive-4',
      'interactive-5',
    ]);
    scheduler.shutdown();
  });

  it('runs an eligible watcher after five interactive starts', async () => {
    const scheduler = new GitHubRequestScheduler();
    const order: string[] = [];
    let release!: () => void;
    const blocking = scheduler.schedule(
      () =>
        new Promise<void>((resolve) => {
          order.push('blocking');
          release = resolve;
        }),
      { priority: 'interactive', operation: 'read', timeoutMs: 10_000 },
    );
    const interactive = Array.from({ length: 6 }, (_, index) =>
      scheduler.schedule(
        async () => {
          order.push(`interactive-${index}`);
        },
        { priority: 'interactive', operation: 'read', timeoutMs: 10_000 },
      ),
    );
    const watcher = scheduler.schedule(
      async () => {
        order.push('watcher');
      },
      { priority: 'watcher', operation: 'read', timeoutMs: 10_000 },
    );
    release();
    await Promise.all([blocking, ...interactive, watcher]);
    expect(order).toEqual([
      'blocking',
      'interactive-0',
      'interactive-1',
      'interactive-2',
      'interactive-3',
      'watcher',
      'interactive-4',
      'interactive-5',
    ]);
    scheduler.shutdown();
  });

  it('runs the oldest eligible lower-priority request after five interactive starts', async () => {
    const scheduler = new GitHubRequestScheduler();
    const order: string[] = [];
    let release!: () => void;
    const blocking = scheduler.schedule(
      () =>
        new Promise<void>((resolve) => {
          order.push('blocking');
          release = resolve;
        }),
      { priority: 'interactive', operation: 'read', timeoutMs: 10_000 },
    );
    const interactive = Array.from({ length: 6 }, (_, index) =>
      scheduler.schedule(
        async () => {
          order.push(`interactive-${index}`);
        },
        { priority: 'interactive', operation: 'read', timeoutMs: 10_000 },
      ),
    );
    const watcher = scheduler.schedule(
      async () => {
        order.push('watcher');
      },
      { priority: 'watcher', operation: 'read', timeoutMs: 10_000 },
    );
    const background = scheduler.schedule(
      async () => {
        order.push('background');
      },
      { priority: 'background', operation: 'read', timeoutMs: 10_000 },
    );

    release();
    await Promise.all([blocking, ...interactive, watcher, background]);

    expect(order.indexOf('watcher')).toBeLessThan(order.indexOf('background'));
    expect(order.indexOf('watcher')).toBeLessThan(
      order.indexOf('interactive-4'),
    );
    scheduler.shutdown();
  });

  it('does not let watcher traffic reset background fairness', async () => {
    const scheduler = new GitHubRequestScheduler();
    const order: string[] = [];
    let release!: () => void;
    const blocking = scheduler.schedule(
      () =>
        new Promise<void>((resolve) => {
          order.push('blocking');
          release = resolve;
        }),
      { priority: 'interactive', operation: 'read', timeoutMs: 10_000 },
    );
    const interactive = Array.from({ length: 4 }, (_, index) =>
      scheduler.schedule(
        async () => {
          order.push(`interactive-${index}`);
        },
        { priority: 'interactive', operation: 'read', timeoutMs: 10_000 },
      ),
    );
    const watchers = Array.from({ length: 3 }, (_, index) =>
      scheduler.schedule(
        async () => {
          order.push(`watcher-${index}`);
        },
        { priority: 'watcher', operation: 'read', timeoutMs: 10_000 },
      ),
    );
    const background = scheduler.schedule(
      async () => {
        order.push('background');
      },
      { priority: 'background', operation: 'read', timeoutMs: 10_000 },
    );

    release();
    await Promise.all([blocking, ...interactive, ...watchers, background]);

    expect(order.indexOf('background')).toBeLessThan(
      order.indexOf('watcher-1'),
    );
    scheduler.shutdown();
  });

  it('paces mutation starts at least one second apart', async () => {
    jest.useFakeTimers();
    const scheduler = new GitHubRequestScheduler();
    const task = jest.fn().mockResolvedValue(undefined);
    const first = scheduler.schedule(task, {
      priority: 'interactive',
      operation: 'mutation',
      timeoutMs: 10_000,
    });
    const second = scheduler.schedule(task, {
      priority: 'interactive',
      operation: 'mutation',
      timeoutMs: 10_000,
    });
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(999);
    expect(task).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);
    expect(task).toHaveBeenCalledTimes(2);
    scheduler.shutdown();
  });

  it('starts at most eight reads in a rolling one-second window', async () => {
    jest.useFakeTimers();
    const scheduler = new GitHubRequestScheduler();
    const task = jest.fn().mockResolvedValue(undefined);
    const requests = Array.from({ length: 9 }, () =>
      scheduler.schedule(task, {
        priority: 'interactive',
        operation: 'read',
        timeoutMs: 10_000,
      }),
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(8);
    await jest.advanceTimersByTimeAsync(999);
    expect(task).toHaveBeenCalledTimes(8);
    await jest.advanceTimersByTimeAsync(1);
    await Promise.all(requests);
    expect(task).toHaveBeenCalledTimes(9);
    scheduler.shutdown();
  });

  it('does not let a paced background mutation block ready foreground work', async () => {
    jest.useFakeTimers();
    const scheduler = new GitHubRequestScheduler();
    const order: string[] = [];
    await scheduler.schedule(
      async () => {
        order.push('first-mutation');
      },
      { priority: 'interactive', operation: 'mutation', timeoutMs: 10_000 },
    );
    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        scheduler.schedule(
          async () => {
            order.push(`read-${index}`);
          },
          { priority: 'interactive', operation: 'read', timeoutMs: 10_000 },
        ),
      ),
    );
    const background = scheduler.schedule(
      async () => {
        order.push('background-mutation');
      },
      { priority: 'background', operation: 'mutation', timeoutMs: 10_000 },
    );
    const foreground = scheduler.schedule(
      async () => {
        order.push('ready-foreground');
      },
      { priority: 'interactive', operation: 'read', timeoutMs: 10_000 },
    );
    await foreground;
    expect(order[order.length - 1]).toBe('ready-foreground');
    await jest.advanceTimersByTimeAsync(1_000);
    await background;
    expect(order[order.length - 1]).toBe('background-mutation');
    scheduler.shutdown();
  });
});

describe('GitHubBroker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetGitHubBrokerForTests();
  });

  afterEach(() => {
    resetGitHubBrokerForTests();
    jest.useRealTimers();
  });

  it('reuses cached data on 304 and surfaces the poll hint', async () => {
    const broker = getGitHubBroker();
    const seenHeaders: Record<string, string>[] = [];
    let attempt = 0;
    const request = jest.fn(
      async (_octokit: unknown, headers: Record<string, string>) => {
        seenHeaders.push(headers);
        attempt += 1;
        if (attempt === 1) {
          return {
            status: 200,
            headers: { etag: '"v1"' },
            data: { state: 'queued' },
          };
        }
        throw apiError(304, { 'x-poll-interval': '7' });
      },
    );
    const options = {
      priority: 'watcher' as const,
      operation: 'read' as const,
      idempotency: 'safe' as const,
      resourceKey: 'run:1',
      conditional: true,
      isCachedData: (value: unknown): value is { state: string } =>
        value !== null &&
        typeof value === 'object' &&
        'state' in value &&
        typeof value.state === 'string',
      timeoutMs: 10_000,
    };

    await expect(broker.execute(request, options)).resolves.toMatchObject({
      kind: 'read',
      changed: true,
      status: 200,
    });
    await expect(broker.execute(request, options)).resolves.toMatchObject({
      kind: 'read',
      changed: false,
      status: 304,
      data: { state: 'queued' },
      pollIntervalMs: 7000,
    });
    expect(seenHeaders[1]).toEqual({ 'if-none-match': '"v1"' });
  });

  it('isolates conditional caches across caller-selected credentials', async () => {
    const broker = getGitHubBroker();
    const seenHeaders: Record<string, string>[] = [];
    const request = jest.fn(
      async (_octokit: unknown, headers: Record<string, string>) => {
        seenHeaders.push(headers);
        return {
          status: 200,
          headers: { etag: `"v${seenHeaders.length}"` },
          data: { credential: seenHeaders.length },
        };
      },
    );
    const common = {
      priority: 'interactive' as const,
      operation: 'read' as const,
      idempotency: 'safe' as const,
      resourceKey: 'repo:private',
      conditional: true,
      timeoutMs: 10_000,
    };

    await broker.execute(request, {
      ...common,
      authenticationToken: 'ghp_first',
    });
    await broker.execute(request, {
      ...common,
      authenticationToken: 'ghp_second',
    });

    expect(seenHeaders).toEqual([{}, {}]);
  });

  it('coalesces concurrent conditional reads by credential and resource', async () => {
    const broker = getGitHubBroker();
    let release!: () => void;
    const request = jest.fn(
      () =>
        new Promise<any>((resolve) => {
          release = (): void =>
            resolve({ status: 200, headers: {}, data: 'ok' });
        }),
    );
    const options = {
      priority: 'watcher' as const,
      operation: 'read' as const,
      idempotency: 'safe' as const,
      resourceKey: 'run:shared',
      conditional: true,
      timeoutMs: 10_000,
    };
    const first = broker.execute(request, options);
    const second = broker.execute(request, options);
    for (
      let index = 0;
      index < 5 && request.mock.calls.length === 0;
      index += 1
    ) {
      await Promise.resolve();
    }
    expect(request).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('never lets an interactive read join a queued background read', async () => {
    const broker = getGitHubBroker();
    let releaseBlocker!: () => void;
    const blocker = broker.execute(
      () =>
        new Promise<any>((resolve) => {
          releaseBlocker = (): void =>
            resolve({ status: 200, headers: {}, data: 'blocker' });
        }),
      {
        priority: 'interactive',
        operation: 'read',
        idempotency: 'safe',
        timeoutMs: 10_000,
      },
    );
    for (let index = 0; index < 50 && !releaseBlocker; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const order: string[] = [];
    const read = (
      label: string,
    ): jest.Mock<Promise<GitHubRawResponse<string>>, []> =>
      jest.fn<Promise<GitHubRawResponse<string>>, []>(() => {
        order.push(label);
        return Promise.resolve({ status: 200, headers: {}, data: label });
      });
    const options = {
      operation: 'read' as const,
      idempotency: 'safe' as const,
      resourceKey: 'pulls.get:acme/api#7',
      conditional: true,
      isCachedData: (value: unknown): value is string =>
        typeof value === 'string',
      timeoutMs: 10_000,
    };

    const background = broker.execute(read('background'), {
      ...options,
      priority: 'background',
    });
    for (let index = 0; index < 10; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const interactive = broker.execute(read('interactive'), {
      ...options,
      priority: 'interactive',
    });
    releaseBlocker();

    await expect(interactive).resolves.toMatchObject({ data: 'interactive' });
    await expect(background).resolves.toMatchObject({ data: 'background' });
    await blocker;
    expect(order).toEqual(['interactive', 'background']);
  });

  it('cancels one shared-read subscriber without cancelling the remaining caller', async () => {
    const broker = getGitHubBroker();
    const firstController = new AbortController();
    let release!: () => void;
    const request = jest.fn(
      () =>
        new Promise<any>((resolve) => {
          release = (): void =>
            resolve({ status: 200, headers: {}, data: 'ok' });
        }),
    );
    const options = {
      priority: 'watcher' as const,
      operation: 'read' as const,
      idempotency: 'safe' as const,
      resourceKey: 'run:shared-cancel',
      conditional: true,
      timeoutMs: 10_000,
    };
    const first = broker.execute(request, {
      ...options,
      signal: firstController.signal,
    });
    const second = broker.execute(request, options);
    for (
      let index = 0;
      index < 5 && request.mock.calls.length === 0;
      index += 1
    ) {
      await Promise.resolve();
    }
    firstController.abort();
    await expect(first).rejects.toMatchObject({ code: 'cancelled' });
    expect(request).toHaveBeenCalledTimes(1);
    release();
    await expect(second).resolves.toMatchObject({ data: 'ok' });
  });

  it('keeps shared subscribers alive while secondary-limit backoff escalates', async () => {
    jest.useFakeTimers();
    const random = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const broker = getGitHubBroker();
    const request = jest
      .fn()
      .mockRejectedValueOnce(apiError(429))
      .mockRejectedValueOnce(apiError(429))
      .mockRejectedValueOnce(apiError(429))
      .mockResolvedValue({ status: 200, headers: {}, data: 'recovered' });

    const result = broker.execute(request, {
      priority: 'interactive',
      operation: 'read',
      idempotency: 'safe',
      resourceKey: 'run:secondary-backoff',
      conditional: true,
      timeoutMs: 20_000,
    });

    await jest.advanceTimersByTimeAsync(420_000);
    await expect(result).resolves.toMatchObject({ data: 'recovered' });
    expect(request).toHaveBeenCalledTimes(4);
    random.mockRestore();
  });

  it('retries a safe read after a bounded server failure', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const broker = getGitHubBroker();
    const request = jest
      .fn()
      .mockRejectedValueOnce(apiError(503))
      .mockResolvedValue({ status: 200, headers: {}, data: 'recovered' });
    const result = broker.execute(request, {
      priority: 'interactive',
      operation: 'read',
      idempotency: 'safe',
      timeoutMs: 10_000,
    });
    await jest.advanceTimersByTimeAsync(1_100);
    await expect(result).resolves.toMatchObject({ data: 'recovered' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not automatically retry unsafe mutations', async () => {
    const broker = getGitHubBroker();
    const request = jest.fn(() => {
      throw apiError(500);
    });
    await expect(
      broker.execute(request, {
        priority: 'interactive',
        operation: 'mutation',
        idempotency: 'unsafe',
        timeoutMs: 10_000,
      }),
    ).rejects.toMatchObject<Partial<GitHubBrokerError>>({
      code: 'server_error',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('preserves a successful unsafe mutation result across a credential reset', async () => {
    const broker = getGitHubBroker();
    const request = jest.fn(async () => {
      broker.resetCredentials();
      return { status: 201, headers: {}, data: 'created' };
    });

    await expect(
      broker.execute(request, {
        priority: 'interactive',
        operation: 'mutation',
        idempotency: 'unsafe',
        timeoutMs: 10_000,
      }),
    ).resolves.toMatchObject({
      kind: 'mutation',
      status: 201,
      data: 'created',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not retry an unsafe mutation after a primary rate limit', async () => {
    const broker = getGitHubBroker();
    const listener = jest.fn();
    broker.subscribeRateLimits(listener);
    const request = jest.fn(() => {
      throw apiError(403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
      });
    });
    await expect(
      broker.execute(request, {
        priority: 'interactive',
        operation: 'mutation',
        idempotency: 'unsafe',
        timeoutMs: 10_000,
      }),
    ).rejects.toMatchObject<Partial<GitHubBrokerError>>({
      code: 'rate_limited',
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('returns permission errors immediately without pausing or retrying', async () => {
    const broker = getGitHubBroker();
    const listener = jest.fn();
    broker.subscribeRateLimits(listener);
    const request = jest.fn(() => {
      throw apiError(403, {}, 'Resource not accessible');
    });
    await expect(
      broker.execute(request, {
        priority: 'interactive',
        operation: 'read',
        idempotency: 'safe',
        timeoutMs: 10_000,
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it('pauses only the GraphQL bucket for a GraphQL rate limit and tells the watcher when it resumes', async () => {
    jest.useFakeTimers();
    const broker = getGitHubBroker();
    const listener = jest.fn();
    broker.subscribeRateLimits(listener);
    const resetEpoch = Math.floor(Date.now() / 1000) + 60;
    const request = jest.fn().mockResolvedValueOnce({
      status: 200,
      headers: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(resetEpoch),
        'x-ratelimit-resource': 'graphql',
      },
      data: { data: null, errors: [{ type: 'RATE_LIMITED' }] },
    });
    MockOctokit.mockImplementation(() => ({ request }));

    await expect(
      fetchGitHubPullRequest({
        repository: 'acme/api',
        number: 12,
        priority: 'watcher',
        timeoutMs: 120_000,
      }),
    ).rejects.toMatchObject({
      code: 'rate_limited',
      retryAt: resetEpoch * 1000 + 1000,
      resource: 'graphql',
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'primary', resource: 'graphql' }),
    );

    const rest = jest
      .fn()
      .mockResolvedValue({ status: 200, headers: {}, data: 'rest' });
    await expect(
      broker.execute(rest, {
        priority: 'watcher',
        operation: 'read',
        idempotency: 'safe',
        timeoutMs: 10_000,
      }),
    ).resolves.toMatchObject({ data: 'rest' });

    const graphQl = jest
      .fn()
      .mockResolvedValue({ status: 200, headers: {}, data: 'graphql' });
    let settled = false;
    const interactive = broker
      .execute(graphQl, {
        priority: 'interactive',
        operation: 'read',
        idempotency: 'safe',
        resource: 'graphql',
        timeoutMs: 10_000,
      })
      .finally(() => {
        settled = true;
      });
    await jest.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false);
    expect(graphQl).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(40_000);
    await expect(interactive).resolves.toMatchObject({ data: 'graphql' });
    MockOctokit.mockImplementation(() => ({}));
  });

  it('classifies an octokit.graphql RATE_LIMITED rejection as a GraphQL limit instead of a network failure', async () => {
    jest.useFakeTimers();
    const broker = getGitHubBroker();
    const listener = jest.fn();
    broker.subscribeRateLimits(listener);
    const resetEpoch = Math.floor(Date.now() / 1000) + 120;
    const request = jest.fn(() => {
      throw Object.assign(new Error('API rate limit exceeded'), {
        name: 'GraphqlResponseError',
        errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }],
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(resetEpoch),
          'x-ratelimit-resource': 'graphql',
        },
      });
    });
    await expect(
      broker.execute(request, {
        priority: 'background',
        operation: 'read',
        idempotency: 'safe',
        resource: 'graphql',
        timeoutMs: 10_000,
      }),
    ).rejects.toMatchObject({ code: 'rate_limited', resource: 'graphql' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'primary', resource: 'graphql' }),
    );
    expect(broker.getQuotaDiagnostics().pausedUntil).toEqual({
      graphql: new Date(resetEpoch * 1000 + 1000).toISOString(),
    });
  });

  it('pauses only the GraphQL bucket for a GraphQL RATE_LIMITED reply that still reports quota', async () => {
    jest.useFakeTimers();
    const broker = getGitHubBroker();
    const listener = jest.fn();
    broker.subscribeRateLimits(listener);
    const resetEpoch = Math.floor(Date.now() / 1000) + 90;
    const graphQl = jest.fn(() => {
      throw new GitHubGraphQlRateLimitError({
        'x-ratelimit-remaining': '37',
        'x-ratelimit-reset': String(resetEpoch),
        'x-ratelimit-resource': 'graphql',
      });
    });
    await expect(
      broker.execute(graphQl, {
        priority: 'background',
        operation: 'read',
        idempotency: 'safe',
        resource: 'graphql',
        timeoutMs: 10_000,
      }),
    ).rejects.toMatchObject({ code: 'rate_limited', resource: 'graphql' });
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'primary', resource: 'graphql' }),
    );
    expect(Object.keys(broker.getQuotaDiagnostics().pausedUntil)).toEqual([
      'graphql',
    ]);
    const rest = jest
      .fn()
      .mockResolvedValue({ status: 200, headers: {}, data: 'rest' });
    await expect(
      broker.execute(rest, {
        priority: 'watcher',
        operation: 'read',
        idempotency: 'safe',
        timeoutMs: 10_000,
      }),
    ).resolves.toMatchObject({ data: 'rest' });
  });

  it('keeps secondary throttling account-wide', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const broker = getGitHubBroker();
    const listener = jest.fn();
    broker.subscribeRateLimits(listener);
    const throttled = jest.fn(() => {
      throw apiError(429, {}, 'You have exceeded a secondary rate limit.');
    });
    await expect(
      broker.execute(throttled, {
        priority: 'watcher',
        operation: 'read',
        idempotency: 'safe',
        timeoutMs: 10_000,
      }),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'secondary' }),
    );
    const graphQl = jest.fn();
    await expect(
      broker.execute(graphQl, {
        priority: 'watcher',
        operation: 'read',
        idempotency: 'safe',
        resource: 'graphql',
        timeoutMs: 10_000,
      }),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    expect(graphQl).not.toHaveBeenCalled();
    expect(throttled).toHaveBeenCalledTimes(1);
  });

  it('holds background and watcher requests below their reserve without sending them', async () => {
    const broker = getGitHubBroker();
    const resetEpoch = Math.floor(Date.now() / 1000) + 1800;
    const request = jest.fn().mockResolvedValue({
      status: 200,
      headers: quotaHeaders(1400, { resetEpoch }),
      data: 'ok',
    });
    const read = (
      priority: 'interactive' | 'watcher' | 'background',
    ): Promise<unknown> =>
      broker.execute(request, {
        priority,
        operation: 'read',
        idempotency: 'safe',
        timeoutMs: 10_000,
      });

    await read('interactive');
    await expect(read('background')).rejects.toMatchObject({
      code: 'rate_limited',
      retryAt: resetEpoch * 1000,
      resource: 'core',
    });
    expect(request).toHaveBeenCalledTimes(1);
    await expect(read('watcher')).resolves.toMatchObject({ data: 'ok' });

    request.mockResolvedValue({
      status: 200,
      headers: quotaHeaders(1, { resetEpoch }),
      data: 'ok',
    });
    await read('watcher');
    await expect(read('watcher')).rejects.toMatchObject({
      code: 'rate_limited',
    });
    await expect(read('interactive')).resolves.toMatchObject({ data: 'ok' });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('updates the ledger from a 304 and ignores an answer from an older window', async () => {
    const broker = getGitHubBroker();
    const resetEpoch = Math.floor(Date.now() / 1000) + 1800;
    const options = {
      priority: 'background' as const,
      operation: 'read' as const,
      idempotency: 'safe' as const,
      resourceKey: 'run:ledger',
      conditional: true,
      isCachedData: (value: unknown): value is string =>
        typeof value === 'string',
      timeoutMs: 10_000,
    };
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        headers: { etag: '"v1"', ...quotaHeaders(4000, { resetEpoch }) },
        data: 'cached',
      })
      .mockRejectedValueOnce(apiError(304, quotaHeaders(200, { resetEpoch })));
    await broker.execute(request, options);
    await expect(broker.execute(request, options)).resolves.toMatchObject({
      status: 304,
      data: 'cached',
    });
    expect(broker.getQuotaDiagnostics().quota).toEqual([
      {
        resource: 'core',
        limit: 5000,
        remaining: 200,
        resetAt: new Date(resetEpoch * 1000).toISOString(),
      },
    ]);
    await expect(broker.execute(request, options)).rejects.toMatchObject({
      code: 'rate_limited',
    });

    const stale = jest.fn().mockResolvedValue({
      status: 200,
      headers: quotaHeaders(4999, { resetEpoch: resetEpoch - 3600 }),
      data: 'stale',
    });
    await broker.execute(stale, { ...options, priority: 'interactive' });
    expect(broker.getQuotaDiagnostics().quota[0]?.remaining).toBe(200);
  });

  it('forgets the quota when credentials reset', async () => {
    const broker = getGitHubBroker();
    const request = jest.fn().mockResolvedValue({
      status: 200,
      headers: quotaHeaders(10),
      data: 'ok',
    });
    const background = {
      priority: 'background' as const,
      operation: 'read' as const,
      idempotency: 'safe' as const,
      timeoutMs: 10_000,
    };
    await broker.execute(request, { ...background, priority: 'interactive' });
    await expect(broker.execute(request, background)).rejects.toMatchObject({
      code: 'rate_limited',
    });
    broker.resetCredentials();
    expect(broker.getQuotaDiagnostics().quota).toEqual([]);
    request.mockResolvedValue({ status: 200, headers: {}, data: 'fresh' });
    await expect(broker.execute(request, background)).resolves.toMatchObject({
      data: 'fresh',
    });
  });

  it('ignores quota headers from a request that outlived a credential reset', async () => {
    const broker = getGitHubBroker();
    let releaseOld!: () => void;
    const old = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<any>((resolve) => {
            releaseOld = (): void =>
              resolve({ status: 200, headers: quotaHeaders(10), data: 'old' });
          }),
      )
      .mockResolvedValue({ status: 200, headers: {}, data: 'reissued' });
    const background = {
      priority: 'background' as const,
      operation: 'read' as const,
      idempotency: 'safe' as const,
      timeoutMs: 10_000,
    };
    const stale = broker.execute(old, background);
    for (let index = 0; index < 50 && !releaseOld; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    broker.resetCredentials();
    releaseOld();
    await expect(stale).resolves.toMatchObject({ data: 'reissued' });

    expect(broker.getQuotaDiagnostics().quota).toEqual([]);
    const fresh = jest
      .fn()
      .mockResolvedValue({ status: 200, headers: {}, data: 'fresh' });
    await expect(broker.execute(fresh, background)).resolves.toMatchObject({
      data: 'fresh',
    });
  });

  it('pauses a bucket that a successful response reports empty', async () => {
    jest.useFakeTimers();
    const broker = getGitHubBroker();
    const listener = jest.fn();
    broker.subscribeRateLimits(listener);
    const resetEpoch = Math.floor(Date.now() / 1000) + 60;
    const request = jest.fn().mockResolvedValue({
      status: 200,
      headers: quotaHeaders(0, { resetEpoch }),
      data: 'last',
    });
    await broker.execute(request, {
      priority: 'interactive',
      operation: 'read',
      idempotency: 'safe',
      timeoutMs: 10_000,
    });
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'primary', resource: 'core' }),
    );
    const next = jest
      .fn()
      .mockResolvedValue({ status: 200, headers: {}, data: 'next' });
    const pending = broker.execute(next, {
      priority: 'interactive',
      operation: 'read',
      idempotency: 'safe',
      timeoutMs: 10_000,
    });
    await jest.advanceTimersByTimeAsync(30_000);
    expect(next).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(32_000);
    await expect(pending).resolves.toMatchObject({ data: 'next' });
  });

  it('observes every response through the request hook and counts it for the caller', async () => {
    type Send = (options: unknown) => Promise<unknown>;
    let wrapped: ((send: Send, options: unknown) => Promise<unknown>) | null =
      null;
    const sent: unknown[] = [];
    const responses: Array<() => Promise<unknown>> = [
      (): Promise<unknown> =>
        Promise.resolve({ status: 200, headers: quotaHeaders(3000) }),
      (): Promise<unknown> =>
        Promise.resolve({ status: 200, headers: quotaHeaders(2999) }),
      (): Promise<unknown> => Promise.reject(apiError(304, quotaHeaders(2999))),
    ];
    const send: Send = (options) => {
      sent.push(options);
      const next = responses.shift();
      return next ? next() : Promise.reject(new Error('unexpected request'));
    };
    const instance = {
      hook: {
        wrap: (_name: string, hook: typeof wrapped): void => {
          wrapped = hook;
        },
      },
      request: (options: unknown): Promise<unknown> =>
        wrapped ? wrapped(send, options) : send(options),
    };
    MockOctokit.mockImplementation(() => instance);
    const broker = getGitHubBroker();
    await broker.execute(
      async () => {
        await instance.request({ page: 1 });
        await instance.request({ page: 2 });
        await instance.request({ page: 3 }).catch(() => undefined);
        return { status: 200, data: 'pages' };
      },
      {
        priority: 'background',
        operation: 'read',
        idempotency: 'safe',
        timeoutMs: 10_000,
        caller: 'pr-poller',
      },
    );
    const first = sent[0];
    expect(
      typeof first === 'object' &&
        first !== null &&
        'request' in first &&
        typeof first.request === 'object' &&
        first.request !== null &&
        'signal' in first.request &&
        first.request.signal instanceof AbortSignal,
    ).toBe(true);
    const diagnostics = broker.getQuotaDiagnostics();
    expect(diagnostics.quota).toEqual([
      expect.objectContaining({ resource: 'core', remaining: 2999 }),
    ]);
    expect(diagnostics.spend?.entries).toEqual([
      {
        caller: 'pr-poller',
        priority: 'background',
        resource: 'core',
        requests: 3,
        notModified: 1,
      },
    ]);
    MockOctokit.mockImplementation(() => ({}));
  });
});

describe('tracked PR hydration and watcher broker integration', () => {
  afterEach(() => {
    resetGitHubBrokerForTests();
  });

  it('skips the broker for a fresh hit and shares its rate-limit pause on a miss', async () => {
    resetGitHubBrokerForTests();
    const broker = getGitHubBroker();
    const target = {
      kind: 'item' as const,
      owner: 'acme',
      repository: 'repo',
      number: 42,
    };
    let firstAttempt = (): void => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      firstAttempt = resolve;
    });
    let attempts = 0;
    const requestItem = jest.fn(async (token: string) => {
      const result = await broker.execute(
        async () => {
          attempts += 1;
          if (attempts === 1) {
            firstAttempt();
            throw apiError(429, { 'retry-after': '1' });
          }
          return {
            status: 200,
            data: {
              title: 'Provider issue',
              html_url: 'https://github.com/acme/repo/issues/42',
              state: 'open',
              updated_at: '2026-10-13T12:00:00Z',
            },
          };
        },
        {
          priority: 'interactive',
          operation: 'read',
          idempotency: 'safe',
          timeoutMs: 15_000,
          authenticationToken: token,
        },
      );
      return result.data;
    });
    const makeReader = (
      tracked: boolean,
    ): ReturnType<typeof createGitHubReferencePreviewReader> =>
      createGitHubReferencePreviewReader({
        resolveToken: async () => 'ghp_test',
        resolveAccountId: async () => 'account',
        requestItem,
        readPullState: async () => null,
        requestRepository: async () => null,
        resolveOriginRepository: async () => null,
        isCoworkProject: () => false,
        now: () => Date.now(),
        readTrackedPull: async (_item, scope) =>
          tracked
            ? {
                scope,
                capturedAt: Date.now(),
                title: 'Tracked PR',
                body: '',
                url: 'https://github.com/acme/repo/pull/42',
                state: 'open',
                author: 'rowan',
                updatedAt: '2026-10-13T12:00:00Z',
              }
            : null,
      });
    expect((await makeReader(true).read(target)).status).toBe('ok');
    expect(requestItem).not.toHaveBeenCalled();

    const miss = makeReader(false).read(target);
    await firstStarted;
    const watcherRequest = jest.fn(async () => ({
      status: 200,
      data: 'watcher',
    }));
    const watcher = broker.execute(watcherRequest, {
      priority: 'watcher',
      operation: 'read',
      idempotency: 'safe',
      timeoutMs: 15_000,
      authenticationToken: 'ghp_test',
    });
    const pausedWatcher = expect(watcher).rejects.toMatchObject({
      code: 'rate_limited',
    });
    expect((await miss).status).toBe('ok');
    await pausedWatcher;
    expect(watcherRequest).not.toHaveBeenCalled();
    const resumedWatcher = await broker.execute(watcherRequest, {
      priority: 'watcher',
      operation: 'read',
      idempotency: 'safe',
      timeoutMs: 15_000,
      authenticationToken: 'ghp_test',
    });
    expect(resumedWatcher.data).toBe('watcher');
    expect(watcherRequest).toHaveBeenCalledTimes(1);
    expect(requestItem).toHaveBeenCalledTimes(1);
    expect(attempts).toBe(2);
  });

  it('discards a preview completion after the shared broker resets credentials', async () => {
    resetGitHubBrokerForTests();
    const broker = getGitHubBroker();
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = (): void => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let attempts = 0;
    const reader = createGitHubReferencePreviewReader({
      resolveToken: async () => 'ghp_test',
      resolveAccountId: async () => 'account',
      requestItem: async (token) => {
        const result = await broker.execute(
          async () => {
            attempts += 1;
            if (attempts === 1) {
              started();
              await held;
            }
            return {
              status: 200,
              data: {
                title: 'Provider issue',
                html_url: 'https://github.com/acme/repo/issues/42',
                state: 'open',
                updated_at: '2026-10-13T12:00:00Z',
              },
            };
          },
          {
            priority: 'interactive',
            operation: 'read',
            idempotency: 'safe',
            timeoutMs: 15_000,
            authenticationToken: token,
          },
        );
        return result.data;
      },
      readPullState: async () => null,
      requestRepository: async () => null,
      resolveOriginRepository: async () => null,
      isCoworkProject: () => false,
      readTrackedPull: async () => null,
      now: () => Date.now(),
    });
    const pending = reader.read({
      kind: 'item',
      owner: 'acme',
      repository: 'repo',
      number: 42,
    });
    await firstStarted;
    broker.resetCredentials();
    release();
    expect(await pending).toEqual({ status: 'disconnected' });
  });

  it('does not coalesce a new broker generation with a held preview read', async () => {
    resetGitHubBrokerForTests();
    const broker = getGitHubBroker();
    let releaseOld = (): void => undefined;
    const oldHeld = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let oldStarted = (): void => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      oldStarted = resolve;
    });
    let providerCalls = 0;
    let lookups = 0;
    const reader = createGitHubReferencePreviewReader({
      resolveToken: async () => 'ghp_test',
      resolveAccountId: async () => 'account',
      requestItem: async (token) => {
        const result = await broker.execute(
          async () => {
            providerCalls += 1;
            return {
              status: 200,
              data: {
                title: 'Current issue',
                html_url: 'https://github.com/acme/repo/issues/42',
                state: 'open',
                updated_at: '2026-10-13T12:00:00Z',
              },
            };
          },
          {
            priority: 'interactive',
            operation: 'read',
            idempotency: 'safe',
            timeoutMs: 15_000,
            authenticationToken: token,
          },
        );
        return result.data;
      },
      readPullState: async () => null,
      requestRepository: async () => null,
      resolveOriginRepository: async () => null,
      isCoworkProject: () => false,
      readTrackedPull: async (_item, scope) => {
        lookups += 1;
        if (lookups !== 1) return null;
        oldStarted();
        await oldHeld;
        return {
          scope,
          capturedAt: Date.now(),
          title: 'Old tracked pull',
          body: '',
          url: 'https://github.com/acme/repo/pull/42',
          state: 'open',
          author: 'rowan',
          updatedAt: '2026-10-13T12:00:00Z',
        };
      },
      now: () => Date.now(),
    });
    const target = {
      kind: 'item' as const,
      owner: 'acme',
      repository: 'repo',
      number: 42,
    };
    const oldRead = reader.read(target);
    await firstStarted;
    broker.resetCredentials();
    const currentRead = reader.read(target);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const currentBeforeOldRelease = await Promise.race([
      currentRead,
      new Promise<'timed-out'>((resolve) => {
        timer = setTimeout(() => resolve('timed-out'), 1_000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    releaseOld();
    const oldResult = await oldRead;
    expect(currentBeforeOldRelease).not.toBe('timed-out');
    expect(currentBeforeOldRelease).toMatchObject({
      status: 'ok',
      preview: { title: 'Current issue' },
    });
    expect(oldResult).toEqual({ status: 'disconnected' });
    expect(providerCalls).toBe(1);
  });
});
