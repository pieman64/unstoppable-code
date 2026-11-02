/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import { useChatStore } from '@/stores/chatStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  hasPipelineSummaryInterest,
  resetPipelineDetailLeasesForTests,
} from '@/lib/pipelineDetailLeases';
import { OverviewPage } from '../OverviewPage';

jest.mock('@canopy/app-state', () => ({
  useOverviewStore: (
    selector: (state: { hydrate: () => void }) => unknown,
  ): unknown => selector({ hydrate: () => undefined }),
}));
jest.mock('@canopy/ui-app', () => ({ Overview: (): null => null }));
jest.mock('@/components/shared/PageTitlebar', () => ({
  PageTitlebar: (): null => null,
}));
jest.mock('@/components/overview/NotificationsPanel', () => ({
  NotificationsPanel: (): null => null,
}));
jest.mock('@/components/overview/OverviewEmptyState', () => ({
  OverviewEmptyState: (): null => null,
}));
jest.mock('@/components/overview/WorkspaceReadinessOverview', () => ({
  WorkspaceReadinessOverview: (): null => null,
}));
jest.mock('@/components/overview/MobileAppPromoCard', () => ({
  MobileAppPromoCard: (): null => null,
}));
jest.mock('@/components/activity/DagProgressBar', () => ({
  DagProgressBar: (): null => null,
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const project: SidebarItem = {
  type: 'single-repo',
  id: 'project-1',
  name: 'Project One',
  repoPath: '/tmp/project-one',
  color: '#7C9B6D',
  collapsed: false,
  order: 0,
  worktrees: [
    {
      id: 'worktree-1',
      branchName: 'feature/worktree',
      createdAt: '2026-04-20T12:00:00.000Z',
    },
  ],
};

describe('OverviewPage pipeline row demand', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetPipelineDetailLeasesForTests();
    useProjectsStore.setState({
      projects: [project],
      hasHydratedProjects: false,
    });
    useChatStore.setState({
      worktreeChats: {},
      unreadWorktreeKeys: new Set(),
    });
    usePipelineRunsStore.setState({
      statesById: {},
      rowStatesById: {},
      runningExecutionsByWorktree: {
        'project-1/worktree-1': new Set(['run-running']),
      },
      pipelineSummariesByWorktree: {
        'project-1/worktree-1': [
          {
            id: 'run-unread-paused',
            name: 'Paused pipeline',
            status: 'paused',
            completedAt: '2026-10-24T00:00:00.000Z',
          },
        ],
      },
      unseenPipelineWorktreeKeys: new Set(['project-1/worktree-1']),
      loadExecutionRowState: jest.fn(() => Promise.resolve(null)),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    resetPipelineDetailLeasesForTests();
    container.remove();
  });

  it('hydrates and keeps interest for running and unread paused cards until unmount', async () => {
    await act(async () => {
      root.render(<OverviewPage />);
      await Promise.resolve();
    });

    expect(
      usePipelineRunsStore.getState().loadExecutionRowState,
    ).toHaveBeenCalledWith('run-running');
    expect(
      usePipelineRunsStore.getState().loadExecutionRowState,
    ).toHaveBeenCalledWith('run-unread-paused');
    expect(hasPipelineSummaryInterest('run-running')).toBe(true);
    expect(hasPipelineSummaryInterest('run-unread-paused')).toBe(true);

    act(() => {
      root.unmount();
    });

    expect(hasPipelineSummaryInterest('run-running')).toBe(false);
    expect(hasPipelineSummaryInterest('run-unread-paused')).toBe(false);
  });
});
