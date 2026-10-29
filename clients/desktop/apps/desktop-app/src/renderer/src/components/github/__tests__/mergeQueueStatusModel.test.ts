import type {
  GitHubMergeQueueView,
  PrMergeQueueStatus,
  PrStatusData,
} from '@canopy/desktop-shared/types/github';
import {
  currentStanding,
  type MergeQueueListState,
  type QueuedPullRequest,
} from '../mergeQueueStatusModel';

const LIST_READ = Date.parse('2026-10-16T10:00:00.000Z');
const EARLIER = new Date(LIST_READ - 60_000).toISOString();
const LATER = new Date(LIST_READ + 60_000).toISOString();

function queuedPr(mergeQueue: PrMergeQueueStatus): QueuedPullRequest {
  const status: PrStatusData = {
    prNumber: 42,
    prUrl: 'https://github.com/example/repo/pull/42',
    baseRefName: 'main',
    state: 'open',
    title: 'Queued change',
    checkStatus: 'passing',
    checkDetails: [],
    reviewStatus: 'approved',
    reviewers: [],
    hasConflicts: false,
    commentCount: 0,
    updatedAt: '2026-10-16T09:00:00.000Z',
    mergeQueue,
  };
  return { repoId: 'repo-1', repoName: 'repo', status };
}

/** A queue read at {@link LIST_READ} with this PR third, ~8 min out. */
function listWithPrQueuedThird(): MergeQueueListState {
  const view: GitHubMergeQueueView = {
    url: 'https://github.com/example/repo/queue/main',
    baseBranch: 'main',
    totalCount: 3,
    maximumEntriesToBuild: 2,
    fetchedAt: new Date(LIST_READ).toISOString(),
    entries: [
      {
        position: 3,
        phase: 'queued',
        estimatedSecondsToMerge: 480,
        enqueuedAt: null,
        pullRequest: {
          number: 42,
          title: 'Queued change',
          url: 'https://github.com/example/repo/pull/42',
          author: 'sam-lee',
        },
      },
    ],
  };
  return { status: 'ready', view };
}

describe('currentStanding', () => {
  it('follows a newer status poll that carries no estimate', () => {
    // The popover read the queue, then closed; the next poll moved the PR
    // into the merge group, where GitHub often has no estimate.
    const pr = queuedPr({
      required: true,
      inQueue: true,
      position: 1,
      phase: 'awaiting_checks',
      observedAt: LATER,
    });
    expect(
      currentStanding(pr, listWithPrQueuedThird(), LIST_READ + 90_000),
    ).toEqual({
      phase: 'awaiting_checks',
      position: 1,
      remainingSeconds: null,
    });
  });

  it('counts a newer poll estimate down from when that poll read it', () => {
    const pr = queuedPr({
      required: true,
      inQueue: true,
      position: 2,
      phase: 'queued',
      estimatedSecondsToMerge: 600,
      observedAt: LATER,
    });
    expect(
      currentStanding(pr, listWithPrQueuedThird(), LIST_READ + 120_000),
    ).toEqual({ phase: 'queued', position: 2, remainingSeconds: 540 });
  });

  it('follows the queue list when it is newer than the poll', () => {
    const pr = queuedPr({
      required: true,
      inQueue: true,
      position: 5,
      phase: 'queued',
      observedAt: EARLIER,
    });
    expect(
      currentStanding(pr, listWithPrQueuedThird(), LIST_READ + 60_000),
    ).toEqual({ phase: 'queued', position: 3, remainingSeconds: 420 });
  });

  it('follows the queue list when the poll predates read times', () => {
    // Statuses persisted before the read time existed carry no `observedAt`.
    const pr = queuedPr({ required: true, inQueue: true, position: 5 });
    expect(currentStanding(pr, listWithPrQueuedThird(), LIST_READ)).toEqual({
      phase: 'queued',
      position: 3,
      remainingSeconds: 480,
    });
  });

  it('never lets a queue list put back a pull request the poll saw leave', () => {
    const pr = queuedPr({ required: true, inQueue: false });
    expect(
      currentStanding(pr, listWithPrQueuedThird(), LIST_READ + 60_000),
    ).toEqual({ phase: undefined, position: null, remainingSeconds: null });
  });
});
