/**
 * @jest-environment jsdom
 */
import type {
  MergePrRepoResult,
  MergePrResponse,
} from '@canopy/desktop-shared/types/github';
import { useGitHubStore } from '../githubStore';
import { useProjectsStore } from '../projectsStore';

const REAL_ADD_TOAST = useGitHubStore.getState().addToast;
const REAL_REQUEST_FAST_REFRESH = useGitHubStore.getState().requestFastRefresh;
const REAL_REFRESH_DIFF_STATS =
  useProjectsStore.getState().refreshWorktreeDiffStats;

function repoResult(
  repoName: string,
  prNumber: number,
  status: MergePrRepoResult['status'],
): MergePrRepoResult {
  return {
    repoId: repoName,
    repoName,
    prNumber,
    prUrl: `https://github.com/org/${repoName}/pull/${prNumber}`,
    mergeMethod: 'merge',
    mergeCommitSha: status === 'merged' ? 'sha' : null,
    status,
    ...(status === 'enqueued' ? { queuePosition: 1 } : {}),
  };
}

function mergeResponse(mergedRepos: MergePrRepoResult[]): MergePrResponse {
  return {
    dryRun: false,
    verifiedRepos: [],
    mergedRepos,
    requiresUnresolvedConfirmation: [],
    failedRepos: [],
  };
}

describe('githubStore.mergePr toasts', () => {
  let addToast: jest.Mock;
  let requestFastRefresh: jest.Mock;
  let mergePr: jest.Mock;

  beforeEach(() => {
    addToast = jest.fn();
    requestFastRefresh = jest.fn().mockResolvedValue(undefined);
    mergePr = jest.fn();
    useGitHubStore.setState({ addToast, requestFastRefresh });
    useProjectsStore.setState({
      refreshWorktreeDiffStats: jest.fn().mockResolvedValue(undefined),
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { github: { mergePr } },
    });
  });

  afterEach(() => {
    useGitHubStore.setState({
      addToast: REAL_ADD_TOAST,
      requestFastRefresh: REAL_REQUEST_FAST_REFRESH,
    });
    useProjectsStore.setState({
      refreshWorktreeDiffStats: REAL_REFRESH_DIFF_STATS,
    });
  });

  function toastMessages(): string[] {
    return addToast.mock.calls.map((call: unknown[]) => String(call[0]));
  }

  it('reports PRs added to the merge queue, not as merged', async () => {
    mergePr.mockResolvedValue(
      mergeResponse([repoResult('app', 7, 'enqueued')]),
    );

    await useGitHubStore.getState().mergePr('project-1', 'worktree-1');

    expect(toastMessages()).toEqual([
      'Added 1 pull request to the merge queue.',
    ]);
    // The refresh still runs so the status bar picks up the queued state.
    expect(requestFastRefresh).toHaveBeenCalledWith('project-1', 'worktree-1');
  });

  it('shows one toast per outcome for a mixed multi-repo merge', async () => {
    mergePr.mockResolvedValue(
      mergeResponse([
        repoResult('app', 7, 'enqueued'),
        repoResult('api', 8, 'enqueued'),
        repoResult('docs', 9, 'merged'),
      ]),
    );

    await useGitHubStore.getState().mergePr('project-1', 'worktree-1');

    expect(toastMessages()).toEqual([
      'Merged 1 pull request.',
      'Added 2 pull requests to the merge queue.',
    ]);
  });

  it('keeps the merged toast for direct merges', async () => {
    mergePr.mockResolvedValue(
      mergeResponse([
        repoResult('app', 7, 'merged'),
        repoResult('api', 8, 'merged'),
      ]),
    );

    await useGitHubStore.getState().mergePr('project-1', 'worktree-1');

    expect(toastMessages()).toEqual(['Merged 2 pull requests.']);
  });

  it('treats a merge queue chat handoff as feedback on its own', async () => {
    mergePr.mockResolvedValue({
      ...mergeResponse([]),
      verifiedRepos: [
        {
          repoId: 'app',
          repoName: 'app',
          prNumber: 7,
          prUrl: 'https://github.com/org/app/pull/7',
          mergeable: true,
          usesMergeQueue: true,
          unresolvedReviewThreadCount: 0,
        },
        {
          repoId: 'api',
          repoName: 'api',
          prNumber: 8,
          prUrl: 'https://github.com/org/api/pull/8',
          mergeable: false,
          unresolvedReviewThreadCount: 0,
          blockedReason: 'has_conflicts',
        },
      ],
      mergeQueueChats: [
        {
          repoId: 'app',
          repoName: 'app',
          prNumber: 7,
          prUrl: 'https://github.com/org/app/pull/7',
          chatId: 'merge-queue-1',
        },
      ],
    });

    const response = await useGitHubStore
      .getState()
      .mergePr('project-1', 'worktree-1');

    // The focused chat is the feedback: no merged toast, no cannot-merge
    // warning, and no post-merge refresh for a PR that has not merged.
    expect(toastMessages()).toEqual([]);
    expect(requestFastRefresh).not.toHaveBeenCalled();
    expect(response?.mergeQueueChats).toHaveLength(1);
    expect(useGitHubStore.getState().mergingPr.size).toBe(0);
  });

  it('keeps merge and failure toasts beside a merge queue chat handoff', async () => {
    mergePr.mockResolvedValue({
      ...mergeResponse([repoResult('docs', 9, 'merged')]),
      mergeQueueChats: [
        {
          repoId: 'app',
          repoName: 'app',
          prNumber: 7,
          prUrl: 'https://github.com/org/app/pull/7',
          chatId: 'merge-queue-1',
        },
      ],
      failedRepos: [
        {
          repoId: 'api',
          repoName: 'api',
          prNumber: 8,
          error: 'No window is available to start the chat.',
          status: 'failed',
        },
      ],
    });

    await useGitHubStore.getState().mergePr('project-1', 'worktree-1');

    expect(toastMessages()).toEqual([
      'Merged 1 pull request.',
      'Merge failed for api: No window is available to start the chat.',
    ]);
  });

  it('explains a refusal for a PR already in the merge queue', async () => {
    mergePr.mockResolvedValue({
      ...mergeResponse([]),
      verifiedRepos: [
        {
          repoId: 'app',
          repoName: 'app',
          prNumber: 7,
          prUrl: 'https://github.com/org/app/pull/7',
          mergeable: false,
          unresolvedReviewThreadCount: 0,
          blockedReason: 'in_merge_queue',
        },
      ],
    });

    await useGitHubStore.getState().mergePr('project-1', 'worktree-1');

    expect(toastMessages()).toEqual([
      'Cannot merge app (already in the merge queue).',
    ]);
  });
});
