/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyApi,
  CoworkSidebarItem,
  SidebarItem,
  SingleRepoSidebarItem,
  WorkspaceReadinessIssue,
} from '@canopy/desktop-shared/types';
import { WorkspaceReadinessOverview } from '../WorkspaceReadinessOverview';
import {
  recordMockLaunch,
  resetWorkspaceReadinessLaunches,
} from '@/lib/__tests__/workspaceReadinessLaunchTestUtils';
import { useWorkspaceReadinessLaunchStore } from '@/stores/workspaceReadinessLaunchStore';
import { hydratedKeys } from '@/stores/chat/hydration';
import { useChatStore } from '@/stores/chatStore';

// Like the real launcher, a successful launch leaves a launch record.
jest.mock('@/lib/workspaceReadinessLauncher', () => ({
  launchWorkspaceReadinessFix: jest.fn(
    (
      workspaceId: string,
      launchedIssue: WorkspaceReadinessIssue,
      baseWorktreeId?: string,
    ) => {
      const { recordMockLaunch } = jest.requireActual<{
        recordMockLaunch: (
          workspaceId: string,
          issue: WorkspaceReadinessIssue,
          baseWorktreeId?: string,
        ) => void;
      }>('@/lib/__tests__/workspaceReadinessLaunchTestUtils');
      recordMockLaunch(workspaceId, launchedIssue, baseWorktreeId);
      return Promise.resolve({
        ok: true as const,
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      });
    },
  ),
  navigateToWorkspaceReadinessChat: jest.fn(() => Promise.resolve()),
}));

const {
  launchWorkspaceReadinessFix: mockLaunch,
  navigateToWorkspaceReadinessChat: mockNavigateToChat,
} = jest.requireMock<{
  launchWorkspaceReadinessFix: jest.Mock;
  navigateToWorkspaceReadinessChat: jest.Mock;
}>('@/lib/workspaceReadinessLauncher');

function codeWorkspace(id: string, name: string = id): SingleRepoSidebarItem {
  return {
    id,
    name,
    type: 'single-repo',
    repoPath: `/repos/${id}`,
    color: '#fff',
    worktrees: [],
    collapsed: false,
    order: 0,
  };
}

function coworkWorkspace(id: string): CoworkSidebarItem {
  return {
    id,
    name: id,
    type: 'cowork',
    color: '#fff',
    collapsed: false,
    order: 0,
  };
}

const issue: WorkspaceReadinessIssue = {
  code: 'configure-hooks',
  title: 'Add repository hooks',
  message: 'No effective hooks.',
  repoName: 'app',
  fixPrompt: 'Configure hooks.',
};

const secondIssue: WorkspaceReadinessIssue = {
  ...issue,
  code: 'configure-scripts',
  title: 'Add a launch script',
};

describe('WorkspaceReadinessOverview', () => {
  let container: HTMLElement;
  let root: Root;
  const getWorkspaceReadiness = jest.fn();

  beforeEach(() => {
    getWorkspaceReadiness.mockReset();
    resetWorkspaceReadinessLaunches();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const readinessApi: Pick<CanopyApi, 'getWorkspaceReadiness'> = {
      getWorkspaceReadiness,
    };
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: readinessApi,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.clearAllMocks();
  });

  async function renderAndFlush(
    projects: SidebarItem[],
    hasHydratedProjects: boolean = true,
  ): Promise<void> {
    await act(async () => {
      root.render(
        <WorkspaceReadinessOverview
          projects={projects}
          hasHydratedProjects={hasHydratedProjects}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('renders both recovery checkouts without duplicate keys or Fix actions', async () => {
    const errors = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      const issues: WorkspaceReadinessIssue[] = ['alpha', 'beta'].map(
        (branchName) => ({
          ...issue,
          code: 'recovery-required',
          title: 'Recover interrupted worktree creation',
          message: `${branchName}: /checkouts/${branchName}`,
          fixPrompt: null,
          recovery: {
            workspaceId: 'app',
            phase: 'orphan-checkout',
            repositoryPath: '/repos/app',
            checkoutPath: `/checkouts/${branchName}`,
            branchName,
          },
        }),
      );
      getWorkspaceReadiness.mockResolvedValue({ issues });
      await renderAndFlush([codeWorkspace('app')]);
      expect(
        errors.mock.calls.filter((args) =>
          args.some(
            (arg) => typeof arg === 'string' && arg.includes('same key'),
          ),
        ),
      ).toEqual([]);
      for (const entry of issues)
        expect(container.textContent).toContain(entry.message);
      expect(container.textContent).not.toContain('Fix in new worktree');
    } finally {
      errors.mockRestore();
    }
  });

  it('renders the dashboard immediately while readiness is still loading', () => {
    getWorkspaceReadiness.mockReturnValue(new Promise(() => undefined));

    act(() => {
      root.render(
        <WorkspaceReadinessOverview
          projects={[codeWorkspace('app')]}
          hasHydratedProjects
        />,
      );
    });

    expect(container.textContent).toContain('Project readiness');
    expect(container.textContent).toContain('Checking project readiness…');
  });

  it('reserves the dashboard section before the project list hydrates', async () => {
    await renderAndFlush([], false);

    expect(container.textContent).toContain('Project readiness');
    expect(container.textContent).toContain('Checking project readiness…');
    expect(getWorkspaceReadiness).not.toHaveBeenCalled();
  });

  it('does not render after an empty project inventory has hydrated', async () => {
    await renderAndFlush([], true);

    expect(container.textContent).not.toContain('Project readiness');
    expect(getWorkspaceReadiness).not.toHaveBeenCalled();
  });

  it('shows the all-ready state after every Code project succeeds', async () => {
    getWorkspaceReadiness.mockResolvedValue({ issues: [], complete: true });

    await renderAndFlush([codeWorkspace('app')]);

    expect(container.textContent).toContain(
      'All Code projects have setup and launch scripts, hooks, and shared agent instructions in place.',
    );
  });

  it('renders recommendations and partial audit failures by project', async () => {
    getWorkspaceReadiness.mockImplementation(
      ({ workspaceId }: { workspaceId: string }) =>
        workspaceId === 'app'
          ? Promise.resolve({ issues: [issue] })
          : Promise.reject(new Error('failed')),
    );

    await renderAndFlush([
      codeWorkspace('app', 'Application'),
      codeWorkspace('api', 'API'),
    ]);

    expect(container.textContent).toContain('Application');
    expect(container.textContent).toContain(issue.title);
    expect(container.textContent).toContain('Fix in new worktree');
    expect(container.textContent).toContain('Couldn’t check API.');
    expect(container.textContent).toContain('Try again');
    expect(container.querySelector('table caption')?.textContent).toBe(
      'Project readiness recommendations',
    );
    expect(
      Array.from(container.querySelectorAll('thead th')).every(
        (header) => header.getAttribute('scope') === 'col',
      ),
    ).toBe(true);
    const workspaceHeader = container.querySelector('tbody th');
    expect(workspaceHeader).not.toBeNull();
    // One recommendation: the project heads just its own row.
    expect(workspaceHeader?.getAttribute('scope')).toBe('row');
    expect(workspaceHeader?.textContent).toBe('Application');
    expect(workspaceHeader?.querySelector('button')).toBeNull();
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (button) => button.textContent === 'Open settings',
      ),
    ).toBe(true);
    expect(
      container.querySelector('[aria-label="Open settings for Application"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[aria-label="Fix Add repository hooks in new worktree for Application"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Try again for API"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="1 recommendations"]'),
    ).not.toBeNull();
    // A long list scrolls inside the card instead of growing the page.
    const scroller = container.querySelector('table')?.parentElement;
    expect(scroller?.style.maxHeight).toBe('24rem');
    expect(scroller?.classList.contains('overflow-y-auto')).toBe(true);
  });

  it('masks only the project name in a failed readiness message', async () => {
    getWorkspaceReadiness.mockRejectedValue(new Error('readiness unavailable'));
    await renderAndFlush([codeWorkspace('app', 'Application')]);
    const message = Array.from(container.querySelectorAll('p')).find(
      (node) => node.textContent === 'Couldn’t check Application.',
    );
    expect(message).toBeDefined();
    expect(message?.querySelector('.ph-mask')?.textContent).toBe('Application');
    expect(message?.classList.contains('ph-mask')).toBe(false);
  });

  it('suppresses a duplicate retry while one is in flight', async () => {
    let resolveRetry:
      | ((value: { issues: WorkspaceReadinessIssue[] }) => void)
      | undefined;
    getWorkspaceReadiness
      .mockRejectedValueOnce(new Error('initial failure'))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRetry = resolve;
          }),
      );

    await renderAndFlush([codeWorkspace('app', 'Application')]);
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Try again',
    );

    await act(async () => {
      retry?.click();
      retry?.click();
      await Promise.resolve();
    });
    await act(async () => {
      resolveRetry?.({ issues: [issue, secondIssue] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getWorkspaceReadiness).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector('th[rowspan]')?.getAttribute('rowspan'),
    ).toBe('2');
  });

  it('does not start a retry while a refresh is in flight', async () => {
    let resolveRefresh:
      | ((value: { issues: WorkspaceReadinessIssue[] }) => void)
      | undefined;
    getWorkspaceReadiness
      .mockRejectedValueOnce(new Error('initial failure'))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      );

    await renderAndFlush([codeWorkspace('app', 'Application')]);
    const buttons = Array.from(container.querySelectorAll('button'));

    await act(async () => {
      buttons.find((button) => button.textContent === 'Refresh')?.click();
      buttons.find((button) => button.textContent === 'Try again')?.click();
      await Promise.resolve();
    });
    expect(getWorkspaceReadiness).toHaveBeenCalledTimes(2);
    expect(
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Try again')
        ?.hasAttribute('disabled'),
    ).toBe(true);

    await act(async () => {
      resolveRefresh?.({ issues: [issue] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain(issue.title);
    expect(container.textContent).not.toContain('Couldn’t check Application.');
  });

  it('stays on the overview after launching and offers the launched chat', async () => {
    getWorkspaceReadiness.mockResolvedValue({ issues: [issue] });
    await renderAndFlush([codeWorkspace('app', 'Application')]);

    const fix = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Fix in new worktree',
    );
    await act(async () => {
      fix?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The launcher must not navigate; the Overview owns that decision now.
    expect(mockLaunch).toHaveBeenCalledWith('app', issue, undefined, {
      navigateToChat: false,
    });
    expect(container.textContent).toContain('View conversation');
    expect(container.textContent).not.toContain('Fix in new worktree');

    const view = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'View conversation',
    );
    await act(async () => {
      view?.click();
      await Promise.resolve();
    });
    expect(mockNavigateToChat).toHaveBeenCalledWith(
      'app',
      'worktree-1',
      'chat-1',
    );
  });

  it('does not relaunch a recommendation that already has a chat', async () => {
    getWorkspaceReadiness.mockResolvedValue({ issues: [issue] });
    await renderAndFlush([codeWorkspace('app', 'Application')]);

    const fix = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Fix in new worktree',
    );
    await act(async () => {
      fix?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Re-running the audit keeps the issue listed until the agent fixes it, so
    // the launched state has to survive a refresh or the same recommendation
    // would spawn a second worktree and agent.
    const refresh = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Refresh',
    );
    await act(async () => {
      refresh?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('View conversation');
    expect(mockLaunch).toHaveBeenCalledTimes(1);
  });

  it('explains a missing conversation and opens its existing worktree only after hydration', async () => {
    const originalChats = useChatStore.getState().worktreeChats;
    recordMockLaunch('app', issue);
    getWorkspaceReadiness.mockResolvedValue({ issues: [issue] });
    useChatStore.setState({ worktreeChats: {} });
    try {
      await renderAndFlush([codeWorkspace('app', 'Application')]);
      expect(container.textContent).toContain('View conversation');
      expect(container.textContent).not.toContain('Conversation unavailable');
      await act(async () => {
        hydratedKeys.add('app/worktree-1');
        useChatStore.setState({
          worktreeChats: { 'app/worktree-1': { tabs: [], activeTabId: '' } },
        });
        await Promise.resolve();
      });
      expect(container.textContent).toContain('Conversation unavailable');
      const open = container.querySelector<HTMLButtonElement>(
        `button[aria-label="Open worktree for ${issue.title} in Application"]`,
      );
      expect(open).not.toBeNull();
      await act(async () => {
        open?.click();
        await Promise.resolve();
      });
      expect(mockNavigateToChat).toHaveBeenCalledWith(
        'app',
        'worktree-1',
        'chat-1',
      );
      expect(mockLaunch).not.toHaveBeenCalled();
    } finally {
      hydratedKeys.delete('app/worktree-1');
      act(() => useChatStore.setState({ worktreeChats: originalChats }));
    }
  });

  it('links a persisted launch on first mount', async () => {
    recordMockLaunch('app', issue);
    getWorkspaceReadiness.mockResolvedValue({ issues: [issue, secondIssue] });
    await renderAndFlush([codeWorkspace('app', 'Application')]);

    const view = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'View conversation',
    );
    expect(view?.getAttribute('aria-label')).toBe(
      `View conversation for ${issue.title} in Application`,
    );
    // The other recommendation keeps its own fix action.
    expect(
      Array.from(container.querySelectorAll('button')).filter(
        (button) => button.textContent === 'Fix in new worktree',
      ),
    ).toHaveLength(1);
    await act(async () => {
      view?.click();
      await Promise.resolve();
    });
    expect(mockNavigateToChat).toHaveBeenCalledWith(
      'app',
      'worktree-1',
      'chat-1',
    );
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it('clears only reference-checkout launches the audit no longer reports', async () => {
    recordMockLaunch('app', issue);
    recordMockLaunch('app', issue, 'some-worktree');
    getWorkspaceReadiness.mockResolvedValue({ issues: [], complete: true });
    await renderAndFlush([codeWorkspace('app', 'Application')]);

    expect(
      Object.values(useWorkspaceReadinessLaunchStore.getState().records),
    ).toEqual([expect.objectContaining({ baseWorktreeId: 'some-worktree' })]);
  });

  it('keeps launches when the audit fails', async () => {
    recordMockLaunch('app', issue);
    getWorkspaceReadiness.mockRejectedValue(new Error('unavailable'));
    await renderAndFlush([codeWorkspace('app', 'Application')]);

    expect(
      Object.keys(useWorkspaceReadinessLaunchStore.getState().records),
    ).toHaveLength(1);
  });

  it.each([false, undefined])(
    'retains launches when audit completeness is %s',
    async (complete) => {
      recordMockLaunch('app', issue);
      getWorkspaceReadiness.mockResolvedValue({ issues: [], complete });
      await renderAndFlush([codeWorkspace('app', 'Application')]);
      expect(
        Object.keys(useWorkspaceReadinessLaunchStore.getState().records),
      ).toHaveLength(1);
    },
  );

  it('shows refresh progress without inserting a row above the results', async () => {
    getWorkspaceReadiness.mockResolvedValue({ issues: [issue] });
    await renderAndFlush([codeWorkspace('app', 'Application')]);

    const childrenBefore =
      container.querySelector('section')?.childElementCount;

    let resolveSecond: ((value: { issues: [] }) => void) | undefined;
    getWorkspaceReadiness.mockReturnValue(
      new Promise<{ issues: [] }>((resolve) => {
        resolveSecond = resolve;
      }),
    );
    const refresh = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Refresh',
    );
    await act(async () => {
      refresh?.click();
      await Promise.resolve();
    });

    // An in-flow "Refreshing…" row would push every recommendation below it
    // down and back, which reads as jitter. Progress belongs in the button.
    expect(container.querySelector('section')?.childElementCount).toBe(
      childrenBefore,
    );
    expect(container.textContent).not.toContain('Refreshing…');
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(container.textContent).toContain(issue.title);

    await act(async () => {
      resolveSecond?.({ issues: [] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('refreshes results on demand', async () => {
    getWorkspaceReadiness
      .mockResolvedValueOnce({ issues: [] })
      .mockResolvedValueOnce({ issues: [issue] });
    await renderAndFlush([codeWorkspace('app')]);

    const refresh = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Refresh',
    );
    await act(async () => {
      refresh?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getWorkspaceReadiness).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain(issue.title);
  });

  it('ignores stale results when project membership changes', async () => {
    let resolveOld:
      | ((value: { issues: WorkspaceReadinessIssue[] }) => void)
      | undefined;
    getWorkspaceReadiness.mockImplementation(
      ({ workspaceId }: { workspaceId: string }) => {
        if (workspaceId === 'old') {
          return new Promise((resolve) => {
            resolveOld = resolve;
          });
        }
        return Promise.resolve({
          issues: [{ ...issue, title: 'Configure the new workspace' }],
        });
      },
    );

    act(() => {
      root.render(
        <WorkspaceReadinessOverview
          projects={[codeWorkspace('old')]}
          hasHydratedProjects
        />,
      );
    });
    await act(async () => {
      root.render(
        <WorkspaceReadinessOverview
          projects={[codeWorkspace('new')]}
          hasHydratedProjects
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      resolveOld?.({
        issues: [{ ...issue, title: 'Stale recommendation' }],
      });
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Configure the new workspace');
    expect(container.textContent).not.toContain('Stale recommendation');
  });

  it('limits project readiness reads to four concurrent requests', async () => {
    let active = 0;
    let maxActive = 0;
    const resolvers: Array<() => void> = [];
    getWorkspaceReadiness.mockImplementation(
      () =>
        new Promise((resolve) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          resolvers.push(() => {
            active -= 1;
            resolve({ issues: [] });
          });
        }),
    );

    act(() => {
      root.render(
        <WorkspaceReadinessOverview
          projects={Array.from({ length: 5 }, (_, index) =>
            codeWorkspace(`workspace-${index}`),
          )}
          hasHydratedProjects
        />,
      );
    });
    expect(maxActive).toBe(4);

    await act(async () => {
      resolvers.splice(0).forEach((resolve) => resolve());
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(maxActive).toBe(4);
    await act(async () => {
      resolvers.splice(0).forEach((resolve) => resolve());
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('does not audit or render readiness for Cowork-only project lists', async () => {
    await renderAndFlush([coworkWorkspace('notes')]);

    expect(container.innerHTML).toBe('');
    expect(getWorkspaceReadiness).not.toHaveBeenCalled();
  });
});
