/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment */
const fetchGitHubPullRequest = jest.fn();
jest.mock('../lib/github-pr-read-model', () => ({
  ...jest.requireActual('../lib/github-pr-read-model'),
  readGitHubPullRequestForWatcher: (...args: unknown[]) =>
    fetchGitHubPullRequest(...args),
}));

import type { GitHubPullRequestSnapshot } from '@canopy/desktop-shared/types/github-watchers';
import type {
  PrMergeQueueCursor,
  PrMergeQueueHistory,
} from '@canopy/desktop-shared/types/github';
import {
  GITHUB_PULL_REQUEST_POLL_DELAY_MS,
  GitHubPullRequestObserver,
  githubPullRequestQueueHistoryFrom,
  githubPullRequestReadMaxAgeMs,
  githubPullRequestResourceKey,
} from '../lib/github-pull-request-observer';
import { GitHubBrokerError } from '../lib/github-broker';

const openSnapshot: GitHubPullRequestSnapshot = {
  state: 'open',
  url: 'https://github.com/acme/api/pull/12',
  baseRefName: 'develop',
  headSha: 'a'.repeat(40),
  mergedAt: null,
  mergeCommitSha: null,
  closedAt: null,
  queue: null,
  observedAt: '2026-10-07T00:00:00.000Z',
};

const queueHistory: PrMergeQueueHistory = {
  status: 'complete',
  filteredCount: 1,
  firstIndex: 0,
  events: [
    { type: 'added', id: 'ATMQE_0', createdAt: '2026-10-06T23:59:00.000Z' },
  ],
};

function subscription(
  watcherId: string,
  number = 12,
  queueCursor?: PrMergeQueueCursor,
) {
  return {
    watcherId,
    repository: 'acme/api',
    number,
    last: openSnapshot,
    ...(queueCursor ? { queueCursor } : {}),
  };
}

/** Jitter is ±20%; one interval plus the max jitter always covers a cycle. */
const ONE_CYCLE_MS = GITHUB_PULL_REQUEST_POLL_DELAY_MS * 1.2 + 100;

describe('GitHubPullRequestObserver', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-07T00:00:00.000Z'));
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    fetchGitHubPullRequest.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("reads queue history from the earliest valid cursor's last interpreted event", () => {
    expect(
      githubPullRequestQueueHistoryFrom([
        subscription('a', 12, { count: 7, lastEventId: 'RFMQE_6' }),
        subscription('b'),
        subscription('c', 12, { count: 3, lastEventId: 'RFMQE_2' }),
        subscription('d', 12, { count: -1, lastEventId: null }),
        subscription('e', 12, { count: 1.5, lastEventId: null }),
      ]),
    ).toBe(2);
    expect(
      githubPullRequestQueueHistoryFrom([
        subscription('a', 12, { count: 0, lastEventId: null }),
        subscription('b', 12, { count: 4, lastEventId: 'ATMQE_3' }),
      ]),
    ).toBe(0);
    expect(
      githubPullRequestQueueHistoryFrom([subscription('a'), subscription('b')]),
    ).toBeUndefined();
    expect(githubPullRequestQueueHistoryFrom([])).toBeUndefined();
  });

  it('never reuses a cached read older than the newest snapshot a subscriber holds', () => {
    const now = Date.parse('2026-10-07T00:01:00.000Z');
    const at = (observedAt: string) => ({
      ...subscription('a'),
      last: { ...openSnapshot, observedAt },
    });
    expect(
      githubPullRequestReadMaxAgeMs(
        [at('2026-10-07T00:00:00.000Z'), at('2026-10-07T00:00:55.000Z')],
        now,
      ),
    ).toBe(5_000);
    expect(
      githubPullRequestReadMaxAgeMs([at('2026-10-06T00:00:00.000Z')], now),
    ).toBe(15_000);
    expect(
      githubPullRequestReadMaxAgeMs([at('2026-10-07T00:02:00.000Z')], now),
    ).toBe(0);
    expect(githubPullRequestReadMaxAgeMs([at('not a time')], now)).toBe(15_000);
  });

  it('keys resources by repository and number', () => {
    expect(
      githubPullRequestResourceKey({ repository: 'acme/api', number: 12 }),
    ).toBe('pr:acme/api#12');
  });

  it('shares one read per pull request across local subscribers', async () => {
    const applyObservation = jest.fn().mockResolvedValue(undefined);
    fetchGitHubPullRequest.mockResolvedValue({
      snapshot: openSnapshot,
      queueHistory,
    });
    const observer = new GitHubPullRequestObserver();
    observer.configure({
      listSubscriptions: jest
        .fn()
        .mockResolvedValue([
          subscription('watcher-a'),
          subscription('watcher-b'),
          subscription('watcher-c', 13),
        ]),
      applyObservation,
    });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(GITHUB_PULL_REQUEST_POLL_DELAY_MS - 1);
    expect(fetchGitHubPullRequest).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);

    expect(fetchGitHubPullRequest).toHaveBeenCalledTimes(2);
    expect(fetchGitHubPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: 'acme/api',
        number: 12,
        priority: 'watcher',
        maxAgeMs: 15_000,
      }),
    );
    expect(applyObservation).toHaveBeenCalledWith({
      observations: expect.arrayContaining([
        {
          kind: 'snapshot',
          subscriberIds: ['watcher-a', 'watcher-b'],
          repository: 'acme/api',
          number: 12,
          snapshot: openSnapshot,
          queueHistory,
        },
        expect.objectContaining({ number: 13, subscriberIds: ['watcher-c'] }),
      ]),
    });
    observer.stop();
  });

  it('reads history from the furthest-behind subscriber and follows rescans', async () => {
    const applyObservation = jest.fn().mockResolvedValue(undefined);
    fetchGitHubPullRequest.mockResolvedValue({
      snapshot: openSnapshot,
      queueHistory,
    });
    let subscriptions = [
      subscription('watcher-a', 12, { count: 9, lastEventId: 'ATMQE_8' }),
      subscription('watcher-b', 12, { count: 4, lastEventId: 'ATMQE_3' }),
      subscription('watcher-c', 13),
    ];
    const observer = new GitHubPullRequestObserver();
    observer.configure({
      listSubscriptions: jest.fn(() => Promise.resolve(subscriptions)),
      applyObservation,
    });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(ONE_CYCLE_MS);

    expect(fetchGitHubPullRequest).toHaveBeenCalledTimes(2);
    expect(fetchGitHubPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ number: 12, queueHistoryFrom: 3 }),
    );
    const unqueuedRead = fetchGitHubPullRequest.mock.calls
      .map(([options]: [Record<string, unknown>]) => options)
      .find((options: Record<string, unknown>) => options.number === 13);
    expect(unqueuedRead).not.toHaveProperty('queueHistoryFrom');
    expect(applyObservation).toHaveBeenCalledWith({
      observations: expect.arrayContaining([
        {
          kind: 'snapshot',
          subscriberIds: ['watcher-a', 'watcher-b'],
          repository: 'acme/api',
          number: 12,
          snapshot: openSnapshot,
          queueHistory,
        },
      ]),
    });

    // The watcher furthest behind caught up; the next shared read follows it.
    subscriptions = [
      subscription('watcher-a', 12, { count: 9, lastEventId: 'ATMQE_8' }),
      subscription('watcher-b', 12, { count: 9, lastEventId: 'ATMQE_8' }),
    ];
    await observer.rescan();
    fetchGitHubPullRequest.mockClear();
    await jest.advanceTimersByTimeAsync(ONE_CYCLE_MS);
    expect(fetchGitHubPullRequest).toHaveBeenCalledTimes(1);
    expect(fetchGitHubPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ number: 12, queueHistoryFrom: 8 }),
    );
    observer.stop();
  });

  it('withholds an in-flight read from a subscriber whose cursor it does not reach', async () => {
    const applyObservation = jest.fn().mockResolvedValue(undefined);
    let resolveRead: (value: unknown) => void = () => undefined;
    fetchGitHubPullRequest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    let subscriptions = [
      subscription('watcher-a', 12, { count: 9, lastEventId: 'ATMQE_8' }),
    ];
    const observer = new GitHubPullRequestObserver();
    observer.configure({
      listSubscriptions: jest.fn(() => Promise.resolve(subscriptions)),
      applyObservation,
    });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(ONE_CYCLE_MS);
    expect(fetchGitHubPullRequest).toHaveBeenCalledTimes(1);

    // Subscribers that join mid-read: one further behind, one with no cursor.
    subscriptions = [
      ...subscriptions,
      subscription('watcher-b', 12, { count: 4, lastEventId: 'ATMQE_3' }),
      subscription('watcher-c'),
    ];
    await observer.rescan();
    resolveRead({ snapshot: openSnapshot, queueHistory });
    await jest.advanceTimersByTimeAsync(0);

    expect(applyObservation).toHaveBeenCalledTimes(1);
    expect(applyObservation).toHaveBeenCalledWith({
      observations: [
        expect.objectContaining({
          kind: 'snapshot',
          subscriberIds: ['watcher-a', 'watcher-c'],
        }),
      ],
    });

    // The next read reaches the furthest-behind cursor and serves everyone.
    fetchGitHubPullRequest.mockResolvedValue({
      snapshot: openSnapshot,
      queueHistory,
    });
    await jest.advanceTimersByTimeAsync(ONE_CYCLE_MS);
    expect(fetchGitHubPullRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ number: 12, queueHistoryFrom: 3 }),
    );
    expect(applyObservation).toHaveBeenLastCalledWith({
      observations: [
        expect.objectContaining({
          subscriberIds: ['watcher-a', 'watcher-b', 'watcher-c'],
        }),
      ],
    });
    observer.stop();
  });

  it('backs off on transient failures without reporting anything', async () => {
    const applyObservation = jest.fn().mockResolvedValue(undefined);
    fetchGitHubPullRequest
      .mockRejectedValueOnce(
        new GitHubBrokerError('server_error', 'GraphQL errors', {
          retriable: true,
        }),
      )
      .mockRejectedValueOnce(
        new GitHubBrokerError('rate_limited', 'limited', { retriable: true }),
      )
      .mockResolvedValue({ snapshot: openSnapshot, queueHistory });
    const observer = new GitHubPullRequestObserver();
    observer.configure({
      listSubscriptions: jest
        .fn()
        .mockResolvedValue([subscription('watcher-a')]),
      applyObservation,
    });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(GITHUB_PULL_REQUEST_POLL_DELAY_MS);
    expect(fetchGitHubPullRequest).toHaveBeenCalledTimes(1);
    expect(applyObservation).not.toHaveBeenCalled();

    // First retry after 10s, second after 20s (existing backoff ladder).
    await jest.advanceTimersByTimeAsync(9_999);
    expect(fetchGitHubPullRequest).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchGitHubPullRequest).toHaveBeenCalledTimes(2);
    expect(applyObservation).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(20_000);
    expect(fetchGitHubPullRequest).toHaveBeenCalledTimes(3);
    expect(applyObservation).toHaveBeenCalledTimes(1);
    observer.stop();
  });

  it('reports when a rate-limited read resumes once and polls again at that time', async () => {
    const applyObservation = jest.fn().mockResolvedValue(undefined);
    const retryAt = Date.now() + 10 * 60_000;
    const nextRetryAt = retryAt + 60 * 60_000;
    const paused = (until: number): GitHubBrokerError =>
      new GitHubBrokerError('rate_limited', 'paused', {
        retriable: true,
        retryAt: until,
        resource: 'graphql',
      });
    fetchGitHubPullRequest
      .mockRejectedValueOnce(paused(retryAt))
      .mockRejectedValueOnce(paused(nextRetryAt))
      .mockResolvedValue({ snapshot: openSnapshot, queueHistory });
    const observer = new GitHubPullRequestObserver();
    observer.configure({
      listSubscriptions: jest
        .fn()
        .mockResolvedValue([subscription('watcher-a')]),
      applyObservation,
    });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(ONE_CYCLE_MS);

    expect(fetchGitHubPullRequest).toHaveBeenCalledTimes(1);
    expect(fetchGitHubPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ caller: 'pr-observer' }),
    );
    expect(applyObservation).toHaveBeenCalledWith({
      observations: [
        {
          kind: 'rate_limited',
          subscriberIds: ['watcher-a'],
          repository: 'acme/api',
          number: 12,
          retryAt: new Date(retryAt).toISOString(),
        },
      ],
    });

    // No transient backoff while paused: the next read waits for the reset.
    await jest.advanceTimersByTimeAsync(9 * 60_000);
    expect(fetchGitHubPullRequest).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(2 * 60_000);
    expect(fetchGitHubPullRequest).toHaveBeenCalledTimes(2);
    expect(applyObservation).toHaveBeenCalledTimes(2);
    expect(applyObservation).toHaveBeenLastCalledWith({
      observations: [
        expect.objectContaining({
          kind: 'rate_limited',
          retryAt: new Date(nextRetryAt).toISOString(),
        }),
      ],
    });

    await jest.advanceTimersByTimeAsync(nextRetryAt - Date.now() + 5_000);
    expect(fetchGitHubPullRequest).toHaveBeenCalledTimes(3);
    expect(applyObservation).toHaveBeenLastCalledWith({
      observations: [expect.objectContaining({ kind: 'snapshot' })],
    });
    observer.stop();
  });

  it('tells a watcher that joins during a pause when reads resume', async () => {
    const applyObservation = jest.fn().mockResolvedValue(undefined);
    const retryAt = Date.now() + 10 * 60_000;
    fetchGitHubPullRequest.mockRejectedValueOnce(
      new GitHubBrokerError('rate_limited', 'paused', {
        retriable: true,
        retryAt,
        resource: 'graphql',
      }),
    );
    const listSubscriptions = jest
      .fn()
      .mockResolvedValue([subscription('watcher-a')]);
    const observer = new GitHubPullRequestObserver();
    observer.configure({ listSubscriptions, applyObservation });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(ONE_CYCLE_MS);
    expect(applyObservation).toHaveBeenCalledTimes(1);

    listSubscriptions.mockResolvedValue([
      subscription('watcher-a'),
      subscription('watcher-b'),
    ]);
    await observer.rescan();

    expect(fetchGitHubPullRequest).toHaveBeenCalledTimes(1);
    expect(applyObservation).toHaveBeenCalledTimes(2);
    expect(applyObservation).toHaveBeenLastCalledWith({
      observations: [
        {
          kind: 'rate_limited',
          subscriberIds: ['watcher-b'],
          repository: 'acme/api',
          number: 12,
          retryAt: new Date(retryAt).toISOString(),
        },
      ],
    });
    observer.stop();
  });

  it.each(['not_found', 'permission_denied'] as const)(
    'reports %s as a source failure once and stops reading',
    async (code) => {
      const applyObservation = jest.fn().mockResolvedValue(undefined);
      fetchGitHubPullRequest.mockRejectedValue(
        new GitHubBrokerError(code, 'gone', { status: 404 }),
      );
      const observer = new GitHubPullRequestObserver();
      observer.configure({
        listSubscriptions: jest
          .fn()
          .mockResolvedValue([subscription('watcher-a')]),
        applyObservation,
      });
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(ONE_CYCLE_MS);
      expect(applyObservation).toHaveBeenCalledWith({
        observations: [
          {
            kind: 'source_failure',
            subscriberIds: ['watcher-a'],
            repository: 'acme/api',
            number: 12,
          },
        ],
      });
      await jest.advanceTimersByTimeAsync(ONE_CYCLE_MS * 4);
      expect(fetchGitHubPullRequest).toHaveBeenCalledTimes(1);
      observer.stop();
    },
  );

  it('re-arms a permanently stopped pull request when a new subscriber joins during the failure delivery', async () => {
    let finishFailureDelivery: () => void = () => undefined;
    const applyObservation = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFailureDelivery = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    fetchGitHubPullRequest
      .mockRejectedValueOnce(
        new GitHubBrokerError('not_found', 'gone', { status: 404 }),
      )
      .mockResolvedValue({ snapshot: openSnapshot });
    let subscriptions = [subscription('watcher-a')];
    const observer = new GitHubPullRequestObserver();
    observer.configure({
      listSubscriptions: jest.fn(() => Promise.resolve(subscriptions)),
      applyObservation,
    });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(ONE_CYCLE_MS);
    expect(applyObservation).toHaveBeenCalledWith({
      observations: [
        expect.objectContaining({
          kind: 'source_failure',
          subscriberIds: ['watcher-a'],
        }),
      ],
    });

    subscriptions = [subscription('watcher-a'), subscription('watcher-b')];
    await observer.rescan();
    finishFailureDelivery();
    await jest.advanceTimersByTimeAsync(ONE_CYCLE_MS);

    expect(fetchGitHubPullRequest).toHaveBeenCalledTimes(2);
    expect(applyObservation).toHaveBeenLastCalledWith({
      observations: [
        expect.objectContaining({
          kind: 'snapshot',
          subscriberIds: ['watcher-a', 'watcher-b'],
        }),
      ],
    });
    observer.stop();
  });

  it('keeps a permanently stopped pull request stopped when no new subscriber joins', async () => {
    const applyObservation = jest.fn().mockResolvedValue(undefined);
    fetchGitHubPullRequest.mockRejectedValue(
      new GitHubBrokerError('not_found', 'gone', { status: 404 }),
    );
    const observer = new GitHubPullRequestObserver();
    observer.configure({
      listSubscriptions: jest
        .fn()
        .mockResolvedValue([subscription('watcher-a')]),
      applyObservation,
    });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(ONE_CYCLE_MS);
    await observer.rescan();
    await jest.advanceTimersByTimeAsync(ONE_CYCLE_MS * 4);

    expect(fetchGitHubPullRequest).toHaveBeenCalledTimes(1);
    expect(applyObservation).toHaveBeenCalledTimes(1);
    observer.stop();
  });

  it('aborts an in-flight read and reports nothing once the last subscriber leaves', async () => {
    const applyObservation = jest.fn().mockResolvedValue(undefined);
    let resolveRead: (value: {
      snapshot: GitHubPullRequestSnapshot;
      queueHistory: PrMergeQueueHistory;
    }) => void = () => undefined;
    let readSignal: AbortSignal | undefined;
    fetchGitHubPullRequest.mockImplementation(
      ({ signal }: { signal: AbortSignal }) => {
        readSignal = signal;
        return new Promise((resolve) => {
          resolveRead = resolve;
        });
      },
    );
    let subscriptions = [subscription('watcher-a')];
    const observer = new GitHubPullRequestObserver();
    observer.configure({
      listSubscriptions: jest.fn(() => Promise.resolve(subscriptions)),
      applyObservation,
    });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(ONE_CYCLE_MS);
    expect(fetchGitHubPullRequest).toHaveBeenCalledTimes(1);

    subscriptions = [];
    await observer.rescan();
    expect(readSignal?.aborted).toBe(true);
    resolveRead({
      snapshot: { ...openSnapshot, state: 'merged' },
      queueHistory,
    });
    await jest.advanceTimersByTimeAsync(ONE_CYCLE_MS);

    expect(applyObservation).not.toHaveBeenCalled();
    observer.stop();
  });
});
