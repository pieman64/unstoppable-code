/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SidebarItem, WorktreeData } from '@canopy/desktop-shared/types';
import { WorktreeKanbanBoard } from '../WorktreeKanbanBoard';

jest.mock('../WorktreeItemAdapter', () => ({
  WorktreeItemAdapter: ({
    worktree,
  }: {
    worktree: WorktreeData;
  }): JSX.Element => <span>{worktree.branchName}</span>,
}));

const project: SidebarItem = {
  type: 'single-repo',
  id: 'p1',
  name: 'Secret Project',
  repoPath: '/repo',
  color: '#000000',
  collapsed: false,
  order: 0,
  worktrees: [
    {
      id: 'w1',
      branchName: 'feature/secret-branch',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
};

describe('WorktreeKanbanBoard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('names the project and the branch on each card', () => {
    act(() => {
      root.render(
        createElement(WorktreeKanbanBoard, {
          visibleProjects: [project],
          diffStats: {},
          uncommittedChanges: {},
          commitsAhead: {},
          hasUnpushedCommits: {},
          baseBranches: {},
          hasRemoteTracking: {},
          hasBranchBeenPushed: {},
          repoBranches: {},
          workspaceDrift: {},
          discoveryLoading: new Set<string>(),
          selectedWorktreeKey: null,
          streamingWorktreeKeys: new Set<string>(),
          activeSessionWorktreeKeys: new Set<string>(),
          awaitingApprovalKeys: new Set<string>(),
          pendingQuestionWorktreeKeys: new Set<string>(),
          toolApprovalWorktreeKeys: new Set<string>(),
          unreadWorktreeKeys: new Set<string>(),
          setupRunningWorktrees: new Set<string>(),
          runRunningWorktrees: new Set<string>(),
          tearingDownWorktrees: new Set<string>(),
          pipelineRunningWorktreeKeys: new Set<string>(),
          pipelineUnseenWorktreeKeys: new Set<string>(),
          pipelineUnseenFailedWorktreeKeys: new Set<string>(),
          pipelinePausedWorktreeKeys: new Set<string>(),
          worktreeStatusMap: new Map(),
          onSelectWorktree: jest.fn(),
          onArchiveWorktree: jest.fn(),
        }),
      );
    });

    const card = container.querySelector(
      '[data-testid^="worktree-kanban-card-"]',
    );
    expect(card?.textContent).toContain('Secret Project');
    expect(card?.textContent).toContain('feature/secret-branch');
  });
});
