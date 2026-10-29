import type {
  GitHubMergeQueueEntry,
  GitHubMergeQueueView,
  PrMergeQueuePhase,
  PrStatusData,
} from '@canopy/desktop-shared/types/github';
import type {
  MergeQueueLabelInput,
  MergeQueuePopoverList,
  MergeQueuePopoverSection,
} from '@canopy/ui-shared';
import { remainingEstimateSeconds } from '@canopy/ui-shared/lib';

/** An open pull request in its base branch's merge queue. */
export interface QueuedPullRequest {
  readonly repoId: string;
  readonly repoName: string;
  readonly status: PrStatusData;
}

/** One branch's merge queue, as the popover last read it. */
export type MergeQueueListState =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      /** Null when GitHub reports no merge queue for the branch. */
      readonly view: GitHubMergeQueueView | null;
    }
  | {
      readonly status: 'error';
      /** The last good read, kept on screen when a refresh fails. */
      readonly view: GitHubMergeQueueView | null;
    };

/** What the popover asks GitHub for one queued pull request. */
export interface MergeQueueTarget {
  readonly key: string;
  readonly repository: string;
  readonly baseBranch: string;
}

const PULL_REQUEST_URL =
  /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)\/pull\/\d+(?:[/?#].*)?$/;

/** `owner/name` from a GitHub pull request URL; null for anything else. */
export function githubRepositoryFromPrUrl(url: string): string | null {
  const match = PULL_REQUEST_URL.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}

export function mergeQueueTarget(
  pr: QueuedPullRequest,
): MergeQueueTarget | null {
  const repository = githubRepositoryFromPrUrl(pr.status.prUrl);
  const baseBranch = pr.status.baseRefName;
  if (!repository || !baseBranch) return null;
  return {
    key: `${repository.toLowerCase()}@${baseBranch}`,
    repository,
    baseBranch,
  };
}

function currentEntry(
  view: GitHubMergeQueueView | null,
  prNumber: number,
): GitHubMergeQueueEntry | undefined {
  return view?.entries.find((entry) => entry.pullRequest.number === prNumber);
}

interface CurrentStanding {
  readonly phase: PrMergeQueuePhase | undefined;
  readonly position: number | null;
  readonly remainingSeconds: number | null;
}

/**
 * The pull request's queue standing from whichever read is newer: the PR
 * status poll or a queue list read, which outlives the popover that made it.
 * A status without a read time (persisted before it existed) yields to the
 * list.
 */
export function currentStanding(
  pr: QueuedPullRequest,
  list: MergeQueueListState | undefined,
  now: number,
): CurrentStanding {
  const queue = pr.status.mergeQueue;
  const fromStatus: CurrentStanding = {
    phase: queue?.phase,
    position: typeof queue?.position === 'number' ? queue.position : null,
    remainingSeconds: remainingEstimateSeconds(
      queue?.estimatedSecondsToMerge,
      queue?.observedAt,
      now,
    ),
  };
  // A list read, however recent, never puts back a PR the poll saw leave.
  if (queue?.inQueue === false) return fromStatus;
  const view = list && list.status !== 'loading' ? list.view : null;
  const entry = currentEntry(view, pr.status.prNumber);
  if (!view || !entry) return fromStatus;
  const statusObservedMs = Date.parse(queue?.observedAt ?? '');
  const listObservedMs = Date.parse(view.fetchedAt);
  if (Number.isFinite(statusObservedMs) && statusObservedMs > listObservedMs) {
    return fromStatus;
  }
  return {
    phase: entry.phase,
    position: entry.position,
    remainingSeconds: remainingEstimateSeconds(
      entry.estimatedSecondsToMerge,
      view.fetchedAt,
      now,
    ),
  };
}

export function mergeQueueLabelInputs(
  prs: readonly QueuedPullRequest[],
  lists: Readonly<Record<string, MergeQueueListState>>,
  now: number,
): MergeQueueLabelInput[] {
  return prs.map((pr) => {
    const target = mergeQueueTarget(pr);
    return currentStanding(pr, target ? lists[target.key] : undefined, now);
  });
}

/**
 * Whether the label shows an estimate that counts down, from the poll or a
 * kept list read. Which read wins does not depend on `now`, so neither does
 * this.
 */
export function labelCountsDown(
  inputs: readonly MergeQueueLabelInput[],
): boolean {
  return inputs.some((input) => input.remainingSeconds !== null);
}

function popoverList(
  list: MergeQueueListState | undefined,
  prNumber: number,
  now: number,
): MergeQueuePopoverList {
  if (!list || list.status === 'loading') return { status: 'loading' };
  if (!list.view) return { status: 'error' };
  const { view } = list;
  return {
    status: 'ready',
    totalCount: view.totalCount,
    buildCount: view.maximumEntriesToBuild,
    entries: view.entries.map((entry) => ({
      position: entry.position,
      number: entry.pullRequest.number,
      title: entry.pullRequest.title,
      url: entry.pullRequest.url,
      author: entry.pullRequest.author,
      phase: entry.phase,
      remainingSeconds: remainingEstimateSeconds(
        entry.estimatedSecondsToMerge,
        view.fetchedAt,
        now,
      ),
      isCurrent: entry.pullRequest.number === prNumber,
    })),
  };
}

export function mergeQueuePopoverSections(
  prs: readonly QueuedPullRequest[],
  lists: Readonly<Record<string, MergeQueueListState>>,
  now: number,
): MergeQueuePopoverSection[] {
  return prs.map((pr) => {
    const target = mergeQueueTarget(pr);
    const list = target ? lists[target.key] : undefined;
    const standing = currentStanding(pr, list, now);
    const view = list && list.status !== 'loading' ? list.view : null;
    return {
      key: pr.repoId,
      repoName: pr.repoName,
      baseBranch: pr.status.baseRefName ?? '',
      phase: standing.phase,
      position: standing.position,
      remainingSeconds: standing.remainingSeconds,
      list: target
        ? popoverList(list, pr.status.prNumber, now)
        : { status: 'error' },
      queueUrl: view?.url ?? null,
    };
  });
}

/** The newest queue read among the lists, for the popover's "Updated". */
export function newestListRead(
  lists: Readonly<Record<string, MergeQueueListState>>,
  keys: readonly string[],
): number | null {
  let newest: number | null = null;
  for (const key of keys) {
    const list = lists[key];
    if (!list || list.status === 'loading' || !list.view) continue;
    const at = Date.parse(list.view.fetchedAt);
    if (Number.isFinite(at) && (newest === null || at > newest)) newest = at;
  }
  return newest;
}
