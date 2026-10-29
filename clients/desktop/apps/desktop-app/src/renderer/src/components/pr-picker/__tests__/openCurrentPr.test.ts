import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { STANDALONE_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import type { WorktreePrStatus } from '@canopy/desktop-shared/types/github';
import { openCurrentWorktreePr } from '../openCurrentPr';

function buildSinglePrStatus(): WorktreePrStatus {
  return {
    lastCheckedAt: '2026-04-28T00:00:00.000Z',
    repos: [
      {
        repoId: 'repo-a',
        repoName: 'repo-a',
        status: {
          prNumber: 42,
          prUrl: 'https://github.com/example/repo-a/pull/42',
          state: 'open',
          title: 'Example PR',
          checkStatus: 'passing',
          checkDetails: [],
          reviewStatus: 'none',
          reviewers: [],
          hasConflicts: false,
          commentCount: 0,
          updatedAt: '2026-04-28T00:00:00.000Z',
        },
      },
    ],
  };
}

function buildMultiPrStatus(): WorktreePrStatus {
  return {
    lastCheckedAt: '2026-04-28T00:00:00.000Z',
    repos: [
      {
        repoId: 'repo-a',
        repoName: 'repo-a',
        status: {
          prNumber: 1,
          prUrl: 'https://github.com/example/repo-a/pull/1',
          state: 'open',
          title: 'A',
          checkStatus: 'passing',
          checkDetails: [],
          reviewStatus: 'none',
          reviewers: [],
          hasConflicts: false,
          commentCount: 0,
          updatedAt: '2026-04-28T00:00:00.000Z',
        },
      },
      {
        repoId: 'repo-b',
        repoName: 'repo-b',
        status: {
          prNumber: 2,
          prUrl: 'https://github.com/example/repo-b/pull/2',
          state: 'draft',
          title: 'B',
          checkStatus: 'passing',
          checkDetails: [],
          reviewStatus: 'none',
          reviewers: [],
          hasConflicts: false,
          commentCount: 0,
          updatedAt: '2026-04-28T00:00:00.000Z',
        },
      },
      {
        repoId: 'repo-c',
        repoName: 'repo-c',
        status: null,
      },
    ],
  };
}

describe('openCurrentWorktreePr', () => {
  let openMock: jest.Mock;

  beforeEach(() => {
    openMock = jest.fn();
    Object.defineProperty(global, 'window', {
      configurable: true,
      writable: true,
      value: { open: openMock },
    });
    useChatStore.setState({ selectedWorktree: null });
    useGitHubStore.setState({ prStatuses: {} });
    useNavigationStore.getState().closePrPicker();
  });

  afterEach(() => {
    Object.defineProperty(global, 'window', {
      configurable: true,
      writable: true,
      value: undefined,
    });
  });

  it('returns no-worktree when nothing is selected', () => {
    expect(openCurrentWorktreePr()).toEqual({ kind: 'no-worktree' });
    expect(openMock).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().prPickerOpen).toBe(false);
  });

  it('returns no-worktree when standalone chat is selected', () => {
    useChatStore.setState({
      selectedWorktree: {
        projectId: STANDALONE_CHAT_PROJECT_ID,
        worktreeId: 'wt-1',
      },
    });
    expect(openCurrentWorktreePr()).toEqual({ kind: 'no-worktree' });
  });

  it('returns no-prs when the selected worktree has no PR data', () => {
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
    });
    expect(openCurrentWorktreePr()).toEqual({ kind: 'no-prs' });
    expect(openMock).not.toHaveBeenCalled();
  });

  it('opens the URL directly when only one PR exists', () => {
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
    });
    useGitHubStore.setState({
      prStatuses: { 'project-a/wt-1': buildSinglePrStatus() },
    });

    const result = openCurrentWorktreePr();

    expect(result.kind).toBe('opened');
    expect(openMock).toHaveBeenCalledWith(
      'https://github.com/example/repo-a/pull/42',
      '_blank',
      'noopener,noreferrer',
    );
    expect(useNavigationStore.getState().prPickerOpen).toBe(false);
  });

  it('opens the picker when multiple PRs exist', () => {
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
    });
    useGitHubStore.setState({
      prStatuses: { 'project-a/wt-1': buildMultiPrStatus() },
    });

    const result = openCurrentWorktreePr();

    expect(result.kind).toBe('picker');
    expect(openMock).not.toHaveBeenCalled();
    const navState = useNavigationStore.getState();
    expect(navState.prPickerOpen).toBe(true);
    expect(navState.prPickerOptions).toHaveLength(2);
    expect(navState.prPickerOptions.map((o) => o.repoId)).toEqual([
      'repo-a',
      'repo-b',
    ]);
  });
});
