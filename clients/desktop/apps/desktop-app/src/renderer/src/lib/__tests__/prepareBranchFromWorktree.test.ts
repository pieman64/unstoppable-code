/**
 * @jest-environment jsdom
 */
import { prepareBranchFromWorktree } from '../prepareBranchFromWorktree';
import { useBranchFromStore } from '@/stores/branchFromStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';

const originalCommitOnly = useGitHubStore.getState().commitOnly;
const originalAddToast = useGitHubStore.getState().addToast;
const originalRefreshWorktreeDiffStatsVerified =
  useProjectsStore.getState().refreshWorktreeDiffStatsVerified;

async function waitForConfirmation(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (useBranchFromStore.getState().pending) return;
    await Promise.resolve();
  }
  throw new Error('Branch confirmation was not requested.');
}

describe('prepareBranchFromWorktree', () => {
  beforeEach(() => {
    useBranchFromStore.getState().resolveConfirmation(null);
    useProjectsStore.setState({
      uncommittedChanges: {},
      refreshWorktreeDiffStatsVerified: jest.fn().mockResolvedValue(true),
    });
    useGitHubStore.setState({
      addToast: jest.fn(),
      commitOnly: jest.fn().mockResolvedValue(undefined),
      committingAndPushing: new Set(),
      creatingPr: new Set(),
      mergingLocalBranches: new Set(),
      mergingPr: new Set(),
      splitLockedWorktrees: new Set(),
    });
  });

  afterAll(() => {
    useProjectsStore.setState({
      uncommittedChanges: {},
      refreshWorktreeDiffStatsVerified:
        originalRefreshWorktreeDiffStatsVerified,
    });
    useGitHubStore.setState({
      addToast: originalAddToast,
      commitOnly: originalCommitOnly,
    });
  });

  it('continues immediately when the source worktree is clean', async () => {
    await expect(
      prepareBranchFromWorktree('project', 'worktree'),
    ).resolves.toEqual({ status: 'ready' });
    expect(useBranchFromStore.getState().pending).toBeNull();
    expect(useGitHubStore.getState().commitOnly).not.toHaveBeenCalled();
    expect(
      useProjectsStore.getState().refreshWorktreeDiffStatsVerified,
    ).toHaveBeenCalledWith('project', 'worktree');
  });

  it('checks refreshed status before deciding the source worktree is clean', async () => {
    useProjectsStore.setState({
      refreshWorktreeDiffStatsVerified: jest.fn().mockImplementation(() => {
        useProjectsStore.setState({
          uncommittedChanges: { 'project/worktree': true },
        });
        return Promise.resolve(true);
      }),
    });

    const result = prepareBranchFromWorktree('project', 'worktree');
    await waitForConfirmation();
    useBranchFromStore.getState().resolveConfirmation('do-not-commit');

    await expect(result).resolves.toEqual({ status: 'ready' });
  });

  it('does not branch when source status cannot be refreshed', async () => {
    useProjectsStore.setState({
      refreshWorktreeDiffStatsVerified: jest.fn().mockResolvedValue(false),
    });

    await expect(
      prepareBranchFromWorktree('project', 'worktree'),
    ).resolves.toEqual({ status: 'failed', retryable: true });
    expect(useBranchFromStore.getState().pending).toBeNull();
    expect(useGitHubStore.getState().addToast).toHaveBeenCalledWith(
      'Unable to verify the source worktree status. Try branching again.',
      'error',
    );
  });

  it('continues without committing when that option is selected', async () => {
    useProjectsStore.setState({
      uncommittedChanges: { 'project/worktree': true },
    });

    const result = prepareBranchFromWorktree('project', 'worktree');
    await waitForConfirmation();
    useBranchFromStore.getState().resolveConfirmation('do-not-commit');

    await expect(result).resolves.toEqual({ status: 'ready' });
    expect(useGitHubStore.getState().commitOnly).not.toHaveBeenCalled();
  });

  it('cancels the branch request from the warning', async () => {
    useProjectsStore.setState({
      uncommittedChanges: { 'project/worktree': true },
    });

    const result = prepareBranchFromWorktree('project', 'worktree');
    await waitForConfirmation();
    useBranchFromStore.getState().resolveConfirmation(null);

    await expect(result).resolves.toEqual({ status: 'cancelled' });
  });

  it('uses the local-only commit flow and continues once the worktree is clean', async () => {
    const commitOnly = jest.fn().mockImplementation(() => {
      useProjectsStore.setState({
        uncommittedChanges: { 'project/worktree': false },
      });
      return Promise.resolve();
    });
    useGitHubStore.setState({ commitOnly });
    useProjectsStore.setState({
      uncommittedChanges: { 'project/worktree': true },
    });

    const result = prepareBranchFromWorktree('project', 'worktree');
    await waitForConfirmation();
    useBranchFromStore.getState().resolveConfirmation('commit-first');

    await expect(result).resolves.toEqual({ status: 'ready' });
    expect(commitOnly).toHaveBeenCalledWith('project', 'worktree');
    expect(
      useProjectsStore.getState().refreshWorktreeDiffStatsVerified,
    ).toHaveBeenCalledWith('project', 'worktree');
  });

  it('does not branch when commit-first leaves uncommitted changes behind', async () => {
    useProjectsStore.setState({
      uncommittedChanges: { 'project/worktree': true },
    });

    const result = prepareBranchFromWorktree('project', 'worktree');
    await waitForConfirmation();
    useBranchFromStore.getState().resolveConfirmation('commit-first');

    await expect(result).resolves.toEqual({
      status: 'failed',
      retryable: true,
    });
  });

  it('does not start commit-first while another Git action is active', async () => {
    useProjectsStore.setState({
      uncommittedChanges: { 'project/worktree': true },
    });
    useGitHubStore.setState({
      mergingPr: new Set(['project/worktree']),
    });

    const result = prepareBranchFromWorktree('project', 'worktree');
    await waitForConfirmation();
    useBranchFromStore.getState().resolveConfirmation('commit-first');

    await expect(result).resolves.toEqual({
      status: 'failed',
      retryable: true,
    });
    expect(useGitHubStore.getState().commitOnly).not.toHaveBeenCalled();
    expect(useGitHubStore.getState().mergingPr).toEqual(
      new Set(['project/worktree']),
    );
  });

  it('does not start commit-first while Split PR locks the worktree', async () => {
    useProjectsStore.setState({
      uncommittedChanges: { 'project/worktree': true },
    });
    useGitHubStore.setState({
      splitLockedWorktrees: new Set(['project/worktree']),
    });

    const result = prepareBranchFromWorktree('project', 'worktree');
    await waitForConfirmation();
    useBranchFromStore.getState().resolveConfirmation('commit-first');

    await expect(result).resolves.toEqual({
      status: 'failed',
      retryable: true,
    });
    expect(useGitHubStore.getState().commitOnly).not.toHaveBeenCalled();
  });

  it('leaves uncommitted changes in the source without requesting confirmation', async () => {
    useProjectsStore.setState({
      uncommittedChanges: { 'project/worktree': true },
    });

    const result = prepareBranchFromWorktree('project', 'worktree', {
      uncommittedChanges: 'leave-in-source',
    });
    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve();
    }

    expect(useBranchFromStore.getState().pending).toBeNull();
    await expect(result).resolves.toEqual({ status: 'ready' });
    expect(
      useProjectsStore.getState().refreshWorktreeDiffStatsVerified,
    ).toHaveBeenCalledWith('project', 'worktree');
    expect(useGitHubStore.getState().commitOnly).not.toHaveBeenCalled();
  });

  it('still fails without confirmation when the non-interactive status check fails', async () => {
    useProjectsStore.setState({
      uncommittedChanges: { 'project/worktree': true },
      refreshWorktreeDiffStatsVerified: jest.fn().mockResolvedValue(false),
    });

    await expect(
      prepareBranchFromWorktree('project', 'worktree', {
        uncommittedChanges: 'leave-in-source',
      }),
    ).resolves.toEqual({ status: 'failed', retryable: true });
    expect(useBranchFromStore.getState().pending).toBeNull();
    expect(useGitHubStore.getState().addToast).not.toHaveBeenCalled();
  });

  it('does not start commit-first while Create PR is active', async () => {
    useProjectsStore.setState({
      uncommittedChanges: { 'project/worktree': true },
    });
    useGitHubStore.setState({
      creatingPr: new Set(['project/worktree']),
    });

    const result = prepareBranchFromWorktree('project', 'worktree');
    await waitForConfirmation();
    useBranchFromStore.getState().resolveConfirmation('commit-first');

    await expect(result).resolves.toEqual({
      status: 'failed',
      retryable: true,
    });
    expect(useGitHubStore.getState().commitOnly).not.toHaveBeenCalled();
    expect(useGitHubStore.getState().creatingPr).toEqual(
      new Set(['project/worktree']),
    );
  });
});
