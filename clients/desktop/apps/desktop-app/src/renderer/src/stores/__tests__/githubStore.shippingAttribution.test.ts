/**
 * @jest-environment jsdom
 */
import type {
  CommitAndPushRequest,
  CommitAndPushResponse,
  CreatePrRequest,
  CreatePrResponse,
  GenerateCommitMessagesResponse,
  MergePrRequest,
  MergePrResponse,
} from '@canopy/desktop-shared/types/github';
import { useGitHubStore } from '../githubStore';
import { useProjectsStore } from '../projectsStore';

const REAL_ADD_TOAST = useGitHubStore.getState().addToast;
const REAL_REQUEST_FAST_REFRESH = useGitHubStore.getState().requestFastRefresh;
const REAL_REFRESH_DIFF_STATS =
  useProjectsStore.getState().refreshWorktreeDiffStats;

const KEY = 'project-1/worktree-1';

const commitResponse: CommitAndPushResponse = {
  repos: [],
  skippedRepos: [],
  failedRepos: [],
  agentResolutionRepos: [],
};

const createResponse: CreatePrResponse = {
  repos: [],
  skippedRepos: [],
  localOnlyCommittedRepos: [],
};

const mergeResponse: MergePrResponse = {
  dryRun: false,
  verifiedRepos: [],
  mergedRepos: [],
  requiresUnresolvedConfirmation: [],
  failedRepos: [],
};

describe('githubStore git shipping attribution', () => {
  let commitAndPush: jest.Mock<
    Promise<CommitAndPushResponse>,
    [CommitAndPushRequest]
  >;
  let createPr: jest.Mock<Promise<CreatePrResponse>, [CreatePrRequest]>;
  let mergePr: jest.Mock<Promise<MergePrResponse>, [MergePrRequest]>;
  let generateCommitMessages: jest.Mock<
    Promise<GenerateCommitMessagesResponse>
  >;
  let reviewCommitMessage: boolean;

  beforeEach(() => {
    reviewCommitMessage = false;
    commitAndPush = jest
      .fn<Promise<CommitAndPushResponse>, [CommitAndPushRequest]>()
      .mockResolvedValue(commitResponse);
    createPr = jest
      .fn<Promise<CreatePrResponse>, [CreatePrRequest]>()
      .mockResolvedValue(createResponse);
    mergePr = jest
      .fn<Promise<MergePrResponse>, [MergePrRequest]>()
      .mockResolvedValue(mergeResponse);
    generateCommitMessages = jest
      .fn<Promise<GenerateCommitMessagesResponse>, []>()
      .mockResolvedValue({
        repos: [{ repoName: 'Project One', message: 'Update files' }],
        skippedRepos: [],
        failedRepos: [],
      });
    useGitHubStore.setState({
      addToast: jest.fn(),
      requestFastRefresh: jest.fn().mockResolvedValue(undefined),
      commitReviewPending: {},
    });
    useProjectsStore.setState({
      refreshWorktreeDiffStats: jest.fn().mockResolvedValue(undefined),
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        loadPreferences: jest
          .fn()
          .mockImplementation(() => Promise.resolve({ reviewCommitMessage })),
        github: {
          commitAndPush,
          createPr,
          mergePr,
          generateCommitMessages,
        },
      },
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

  /** Approves the commit message review once the flow requests it. */
  async function approveReviewWhenPending(): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (useGitHubStore.getState().commitReviewPending[KEY]) {
        useGitHubStore
          .getState()
          .resolveCommitReview('project-1', 'worktree-1', true, [
            { repoName: 'Project One', message: 'Update files' },
          ]);
        return;
      }
      await Promise.resolve();
    }
    throw new Error('Commit review was never requested.');
  }

  it('forwards chat attribution on commit-only requests', async () => {
    await useGitHubStore
      .getState()
      .commitOnly('project-1', 'worktree-1', undefined, { source: 'chat' });

    expect(commitAndPush).toHaveBeenCalledTimes(1);
    expect(commitAndPush.mock.calls[0]?.[0]).toMatchObject({
      commitOnly: true,
      source: 'chat',
    });
  });

  it('forwards chat attribution on commit-and-push after review', async () => {
    reviewCommitMessage = true;

    const run = useGitHubStore
      .getState()
      .commitAndPush('project-1', 'worktree-1', {
        pullFirst: true,
        source: 'chat',
      });
    await approveReviewWhenPending();
    await run;

    expect(commitAndPush).toHaveBeenCalledTimes(1);
    expect(commitAndPush.mock.calls[0]?.[0]).toMatchObject({
      pullFirst: true,
      requireReviewedMessages: true,
      source: 'chat',
    });
  });

  it('forwards chat attribution on PR creation and its reviewed pre-PR commit', async () => {
    reviewCommitMessage = true;

    const run = useGitHubStore
      .getState()
      .createPr('project-1', 'worktree-1', undefined, { source: 'chat' });
    await approveReviewWhenPending();
    await run;

    expect(commitAndPush).toHaveBeenCalledTimes(1);
    expect(commitAndPush.mock.calls[0]?.[0]).toMatchObject({
      requireReviewedMessages: true,
      source: 'chat',
    });
    expect(commitAndPush.mock.calls[0]?.[0]).toHaveProperty(
      'telemetryFlow',
      'pull_request',
    );
    expect(createPr).toHaveBeenCalledTimes(1);
    expect(createPr.mock.calls[0]?.[0]).toMatchObject({ source: 'chat' });
  });

  it('forwards chat attribution on PR merges', async () => {
    await useGitHubStore
      .getState()
      .mergePr('project-1', 'worktree-1', { source: 'chat' });

    expect(mergePr).toHaveBeenCalledTimes(1);
    expect(mergePr.mock.calls[0]?.[0]).toMatchObject({ source: 'chat' });
  });

  it('omits attribution from payloads when no source is supplied', async () => {
    await useGitHubStore.getState().commitOnly('project-1', 'worktree-1');
    await useGitHubStore.getState().commitAndPush('project-1', 'worktree-1');
    await useGitHubStore.getState().createPr('project-1', 'worktree-1');
    await useGitHubStore.getState().mergePr('project-1', 'worktree-1');

    const payloads = [
      ...commitAndPush.mock.calls.map(([payload]) => payload),
      ...createPr.mock.calls.map(([payload]) => payload),
      ...mergePr.mock.calls.map(([payload]) => payload),
    ];
    expect(payloads).toHaveLength(4);
    for (const payload of payloads) {
      expect(payload).not.toHaveProperty('source');
    }
  });
});
