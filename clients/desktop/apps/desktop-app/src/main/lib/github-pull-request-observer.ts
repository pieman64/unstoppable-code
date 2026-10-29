import type { GitHubPullRequestSnapshot } from '@canopy/desktop-shared/types/github-watchers';
import type {
  PrMergeQueueCursor,
  PrMergeQueueHistory,
} from '@canopy/desktop-shared/types/github';
import { withJitter } from './github-broker/rate-limit';
import {
  GITHUB_PULL_REQUEST_WATCHER_MAX_AGE_MS,
  readGitHubPullRequestForWatcher,
} from './github-pr-read-model';
import {
  GitHubResourceObserver,
  githubResourceNextDelayMs,
  type GitHubObservedResource,
  type GitHubResourceAdapter,
} from './github-resource-observer';

/** Pull request lifecycle changes are slow; one read per PR every ~45s. */
export const GITHUB_PULL_REQUEST_POLL_DELAY_MS = 45_000;

export interface GitHubPullRequestWatcherSubscription {
  watcherId: string;
  repository: string;
  number: number;
  last: GitHubPullRequestSnapshot;
  /** Merge queue timeline already interpreted; absent before the first read. */
  queueCursor?: PrMergeQueueCursor;
}

export type GitHubPullRequestObservationItem =
  | {
      kind: 'snapshot';
      subscriberIds: readonly string[];
      repository: string;
      number: number;
      snapshot: GitHubPullRequestSnapshot;
      queueHistory: PrMergeQueueHistory;
    }
  | {
      kind: 'source_failure';
      subscriberIds: readonly string[];
      repository: string;
      number: number;
    }
  | {
      /** The broker holds this pull request's reads until `retryAt`. */
      kind: 'rate_limited';
      subscriberIds: readonly string[];
      repository: string;
      number: number;
      retryAt: string;
    };

export interface GitHubPullRequestObservation {
  observations: GitHubPullRequestObservationItem[];
}

interface ObservedPullRequest extends GitHubObservedResource<GitHubPullRequestWatcherSubscription> {
  repository: string;
  number: number;
  queueHistoryFrom?: number;
}

/** Shared by every local subscriber of the same pull request. */
export function githubPullRequestResourceKey(target: {
  repository: string;
  number: number;
}): string {
  return `pr:${target.repository}#${target.number}`;
}

/**
 * Timeline index a read must reach to continue from `cursor`: the cursor's
 * last interpreted event, which the interpreter matches by id. Undefined
 * without a valid cursor.
 */
function queueHistoryAnchor(
  cursor: PrMergeQueueCursor | undefined,
): number | undefined {
  const count = cursor?.count;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    return undefined;
  }
  return Math.max(count - 1, 0);
}

/**
 * Earliest timeline index any subscriber still needs, so one shared read
 * serves the subscriber furthest behind; undefined when none has a cursor.
 */
export function githubPullRequestQueueHistoryFrom(
  subscriptions: readonly GitHubPullRequestWatcherSubscription[],
): number | undefined {
  let floor: number | undefined;
  for (const { queueCursor } of subscriptions) {
    const anchor = queueHistoryAnchor(queueCursor);
    if (anchor !== undefined && (floor === undefined || anchor < floor)) {
      floor = anchor;
    }
  }
  return floor;
}

/**
 * Subscribers a read covers. One that joined mid-read with an older cursor
 * waits for the next read, which starts from its cursor.
 */
function coveredSubscriberIds(
  subscribers: ReadonlyMap<string, GitHubPullRequestWatcherSubscription>,
  historyFrom: number | undefined,
): string[] {
  return Array.from(subscribers)
    .filter(([, { queueCursor }]) => {
      const anchor = queueHistoryAnchor(queueCursor);
      return (
        anchor === undefined ||
        (historyFrom !== undefined && anchor >= historyFrom)
      );
    })
    .map(([watcherId]) => watcherId);
}

/**
 * Oldest cached read the shared read may reuse: never older than the newest
 * snapshot a subscriber already holds, so a cached read cannot rewind one.
 */
export function githubPullRequestReadMaxAgeMs(
  subscribers: readonly GitHubPullRequestWatcherSubscription[],
  now: number,
): number {
  let newest = Number.NEGATIVE_INFINITY;
  for (const { last } of subscribers) {
    const observedAt = Date.parse(last.observedAt);
    if (Number.isFinite(observedAt) && observedAt > newest) {
      newest = observedAt;
    }
  }
  return Math.min(
    GITHUB_PULL_REQUEST_WATCHER_MAX_AGE_MS,
    Math.max(0, now - newest),
  );
}

const pullRequestAdapter: GitHubResourceAdapter<
  GitHubPullRequestWatcherSubscription,
  ObservedPullRequest,
  GitHubPullRequestObservationItem
> = {
  resourceKey: githubPullRequestResourceKey,
  createResource: (key, entries, subscribers, now) => ({
    key,
    repository: entries[0].repository,
    number: entries[0].number,
    queueHistoryFrom: githubPullRequestQueueHistoryFrom(entries),
    subscribers,
    dueAt: now + withJitter(GITHUB_PULL_REQUEST_POLL_DELAY_MS),
    errorCount: 0,
    inFlight: false,
  }),
  refreshResource: (resource, entries) => {
    resource.queueHistoryFrom = githubPullRequestQueueHistoryFrom(entries);
  },
  observe: async (resource, signal, isCurrent) => {
    const historyFrom = resource.queueHistoryFrom;
    const { snapshot, queueHistory } = await readGitHubPullRequestForWatcher({
      repository: resource.repository,
      number: resource.number,
      priority: 'watcher',
      caller: 'pr-observer',
      signal,
      maxAgeMs: githubPullRequestReadMaxAgeMs(
        Array.from(resource.subscribers.values()),
        Date.now(),
      ),
      ...(historyFrom === undefined ? {} : { queueHistoryFrom: historyFrom }),
    });
    if (!isCurrent()) return [];
    resource.errorCount = 0;
    resource.dueAt =
      Date.now() + githubResourceNextDelayMs(GITHUB_PULL_REQUEST_POLL_DELAY_MS);
    const subscriberIds = coveredSubscriberIds(
      resource.subscribers,
      historyFrom,
    );
    if (subscriberIds.length === 0) return [];
    return [
      {
        kind: 'snapshot',
        subscriberIds,
        repository: resource.repository,
        number: resource.number,
        snapshot,
        queueHistory,
      },
    ];
  },
  sourceFailure: (resource) => [
    {
      kind: 'source_failure',
      subscriberIds: Array.from(resource.subscribers.keys()),
      repository: resource.repository,
      number: resource.number,
    },
  ],
  rateLimited: (resource, retryAt, subscriberIds) => [
    {
      kind: 'rate_limited',
      subscriberIds: subscriberIds ?? Array.from(resource.subscribers.keys()),
      repository: resource.repository,
      number: resource.number,
      retryAt: new Date(retryAt).toISOString(),
    },
  ],
};

export class GitHubPullRequestObserver extends GitHubResourceObserver<
  GitHubPullRequestWatcherSubscription,
  ObservedPullRequest,
  GitHubPullRequestObservationItem
> {
  constructor() {
    super(pullRequestAdapter);
  }
}

let singleton: GitHubPullRequestObserver | null = null;

export function getGitHubPullRequestObserver(): GitHubPullRequestObserver {
  singleton ??= new GitHubPullRequestObserver();
  return singleton;
}
