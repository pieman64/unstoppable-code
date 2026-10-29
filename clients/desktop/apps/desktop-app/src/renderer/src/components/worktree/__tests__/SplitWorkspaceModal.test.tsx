/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  MultiRepoSidebarItem,
  SplitTemporaryWorkspacePreviewResponse,
} from '@canopy/desktop-shared/types';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { SplitWorkspaceModal } from '../SplitWorkspaceModal';

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));

jest.mock('../../shared', () => ({
  DialogModal: ({ children }: { children: ReactNode }): JSX.Element => (
    <div>{children}</div>
  ),
}));

const WORKSPACE_ID = 'workspace-1';
const WORKTREE_ID = 'worktree-1';

const workspace: MultiRepoSidebarItem = {
  id: WORKSPACE_ID,
  name: 'Temporary workspace',
  type: 'multi-repo',
  color: '#000000',
  repos: [{ id: 'repo-1', name: 'Repo', repoPath: '/repo' }],
  worktrees: [
    {
      id: WORKTREE_ID,
      branchName: 'feature/split',
      createdAt: '2026-08-06T00:00:00.000Z',
    },
  ],
  collapsed: false,
  order: 0,
  temporary: true,
};

const emptySummary = { count: 0, entries: [] };
const preview: SplitTemporaryWorkspacePreviewResponse = {
  previewRevision: 'preview-revision',
  repos: [
    {
      repoId: 'repo-1',
      repoName: 'Repo',
      repoPath: '/repo',
      destinationWorkspaceName: 'Repo',
      removalMode: 'archive',
      chats: emptySummary,
      pipelines: emptySummary,
      plans: emptySummary,
    },
  ],
  root: {
    present: true,
    canArchive: true,
    chats: emptySummary,
    pipelines: emptySummary,
    plans: emptySummary,
    attachments: emptySummary,
  },
};

describe('SplitWorkspaceModal', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useProjectsStore.setState({
      projects: [workspace],
      repoBranches: {},
      refreshWorktreeDiffStats: jest.fn(() => Promise.resolve()),
    });
    useGitHubStore.setState({ addToast: jest.fn() });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.clearAllMocks();
  });

  it('flushes persisted tabs before requesting the approval-bound preview', async () => {
    const events: string[] = [];
    let releaseFlush: (() => void) | undefined;
    const flushWorktreeTabs = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseFlush = (): void => {
            events.push('flush');
            resolve();
          };
        }),
    );
    useChatStore.setState({ flushWorktreeTabs });
    const previewSplitTemporaryWorkspace = jest.fn(() => {
      events.push('preview');
      return Promise.resolve(preview);
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { previewSplitTemporaryWorkspace },
    });

    await act(async () => {
      root.render(
        <SplitWorkspaceModal
          workspaceId={WORKSPACE_ID}
          worktreeId={WORKTREE_ID}
          onClose={jest.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(flushWorktreeTabs).toHaveBeenCalledWith(WORKSPACE_ID, WORKTREE_ID);
    expect(previewSplitTemporaryWorkspace).not.toHaveBeenCalled();
    if (!releaseFlush) {
      throw new Error('Expected the tab flush to be pending');
    }

    await act(async () => {
      releaseFlush?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(events).toEqual(['flush', 'preview']);
    expect(previewSplitTemporaryWorkspace).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
    });
  });
});
