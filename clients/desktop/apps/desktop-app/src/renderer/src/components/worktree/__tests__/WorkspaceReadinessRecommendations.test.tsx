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
  WorkspaceReadinessIssue,
} from '@canopy/desktop-shared/types';
import {
  launchWorkspaceReadinessFix,
  navigateToWorkspaceReadinessChat,
} from '@/lib/workspaceReadinessLauncher';
import {
  recordMockLaunch,
  resetWorkspaceReadinessLaunches,
} from '@/lib/__tests__/workspaceReadinessLaunchTestUtils';
import { useWorkspaceReadinessLaunchStore } from '@/stores/workspaceReadinessLaunchStore';
import { WorkspaceReadinessRecommendations } from '../WorkspaceReadinessRecommendations';
import { hydratedKeys } from '@/stores/chat/hydration';
import { useChatStore } from '@/stores/chatStore';

jest.mock('@/lib/workspaceReadinessLauncher', () => ({
  launchWorkspaceReadinessFix: jest.fn(),
  navigateToWorkspaceReadinessChat: jest.fn(() => Promise.resolve()),
}));

const mockedLaunchWorkspaceReadinessFix = jest.mocked(
  launchWorkspaceReadinessFix,
);
const mockedNavigateToWorkspaceReadinessChat = jest.mocked(
  navigateToWorkspaceReadinessChat,
);

const issue: WorkspaceReadinessIssue = {
  code: 'configure-scripts',
  title: 'Add setup and launch scripts',
  message: 'app has no effective setup or launch lifecycle scripts.',
  repoName: 'app',
  fixPrompt: 'Configure the repository.',
};

describe('WorkspaceReadinessRecommendations', () => {
  let container: HTMLElement;
  let root: Root;
  const getWorkspaceReadiness = jest.fn();

  beforeEach(() => {
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
    resetWorkspaceReadinessLaunches();
    // Like the real launcher, a successful launch leaves a launch record.
    mockedLaunchWorkspaceReadinessFix.mockImplementation(
      (workspaceId, launchedIssue, baseWorktreeId) => {
        recordMockLaunch(workspaceId, launchedIssue, baseWorktreeId, {
          worktreeId: 'fix-worktree',
          chatId: 'fix-chat',
        });
        return Promise.resolve({
          ok: true,
          worktreeId: 'fix-worktree',
          chatId: 'fix-chat',
        });
      },
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.clearAllMocks();
  });

  async function renderAndFlush(): Promise<void> {
    await act(async () => {
      root.render(
        <WorkspaceReadinessRecommendations
          workspaceId="app"
          onViewConversation={() => Promise.resolve(true)}
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
      await renderAndFlush();
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

  it('shows the ready state when no deterministic recommendations remain', async () => {
    getWorkspaceReadiness.mockResolvedValue({ issues: [], complete: true });

    await renderAndFlush();

    expect(container.textContent).toContain('Repository readiness');
    expect(container.textContent).toContain(
      'This Code project has setup and launch scripts, hooks, and shared agent instructions in place.',
    );
    expect(container.textContent).not.toContain('Fix in new worktree');
  });

  it('renders an agent-launch action for each recommendation', async () => {
    getWorkspaceReadiness.mockResolvedValue({ issues: [issue] });

    await renderAndFlush();

    expect(container.textContent).toContain(issue.title);
    expect(container.textContent).toContain(issue.message);
    expect(container.textContent).toContain('Fix in new worktree');
  });

  it('keeps a failed audit distinct from the ready state and offers retry', async () => {
    getWorkspaceReadiness
      .mockRejectedValueOnce(new Error('audit failed'))
      .mockResolvedValueOnce({ issues: [] });

    await renderAndFlush();

    expect(container.textContent).toContain(
      'Couldn’t check repository readiness.',
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Couldn’t check repository readiness.',
    );
    expect(container.textContent).not.toContain('This Code project has');

    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Try again',
    );
    await act(async () => {
      retry?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getWorkspaceReadiness).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('This Code project has');
  });

  it('shows launch progress and stays open once the launch succeeds', async () => {
    getWorkspaceReadiness.mockResolvedValue({ issues: [issue] });
    let resolveLaunch:
      | ((value: { ok: true; worktreeId: string; chatId: string }) => void)
      | undefined;
    mockedLaunchWorkspaceReadinessFix.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLaunch = resolve;
      }),
    );
    const onViewConversation = jest.fn(() => Promise.resolve(true));

    await act(async () => {
      root.render(
        <WorkspaceReadinessRecommendations
          workspaceId="app"
          worktreeId="audited-worktree"
          onViewConversation={onViewConversation}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    const fix = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Fix in new worktree',
    );
    act(() => fix?.click());
    expect(container.textContent).toContain('Starting…');

    await act(async () => {
      recordMockLaunch('app', issue, 'audited-worktree', {
        worktreeId: 'fix-worktree',
        chatId: 'fix-chat',
      });
      resolveLaunch?.({
        ok: true,
        worktreeId: 'fix-worktree',
        chatId: 'fix-chat',
      });
      await Promise.resolve();
    });
    expect(mockedLaunchWorkspaceReadinessFix).toHaveBeenCalledWith(
      'app',
      issue,
      'audited-worktree',
      { navigateToChat: false },
    );
    // The surface must survive the launch so the remaining recommendations
    // stay clickable in the same visit.
    expect(onViewConversation).not.toHaveBeenCalled();
    expect(container.textContent).toContain('View conversation');
  });

  it('leaves other recommendations launchable after one is started', async () => {
    const secondIssue: WorkspaceReadinessIssue = {
      code: 'configure-hooks',
      title: 'Add repository hooks',
      message: 'app has no effective hooks.',
      repoName: 'app',
      fixPrompt: 'Configure hooks.',
    };
    getWorkspaceReadiness.mockResolvedValue({ issues: [issue, secondIssue] });
    await renderAndFlush();

    const fix = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Fix in new worktree',
    );
    await act(async () => {
      fix?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('View conversation');
    const remaining = Array.from(container.querySelectorAll('button')).filter(
      (button) => button.textContent === 'Fix in new worktree',
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0].hasAttribute('disabled')).toBe(false);
  });

  it('dismisses the host surface before opening a launched chat', async () => {
    getWorkspaceReadiness.mockResolvedValue({ issues: [issue] });
    const onViewConversation = jest.fn(() => Promise.resolve(true));

    await act(async () => {
      root.render(
        <WorkspaceReadinessRecommendations
          workspaceId="app"
          worktreeId="audited-worktree"
          onViewConversation={onViewConversation}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    const fix = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Fix in new worktree',
    );
    await act(async () => {
      fix?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const view = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'View conversation',
    );
    await act(async () => {
      view?.click();
      await Promise.resolve();
    });

    // Closing first keeps the modal from covering the chat it just opened.
    expect(onViewConversation).toHaveBeenCalledTimes(1);
    expect(mockedNavigateToWorkspaceReadinessChat).toHaveBeenCalledWith(
      'app',
      'fix-worktree',
      'fix-chat',
    );
  });

  it('leaves the chat closed when the host surface stays open', async () => {
    getWorkspaceReadiness.mockResolvedValue({ issues: [issue] });
    const onViewConversation = jest.fn(() => Promise.resolve(false));

    await act(async () => {
      root.render(
        <WorkspaceReadinessRecommendations
          workspaceId="app"
          worktreeId="audited-worktree"
          onViewConversation={onViewConversation}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    const fix = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Fix in new worktree',
    );
    await act(async () => {
      fix?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const view = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'View conversation',
    );
    await act(async () => {
      view?.click();
      await Promise.resolve();
    });

    expect(onViewConversation).toHaveBeenCalledTimes(1);
    expect(mockedNavigateToWorkspaceReadinessChat).not.toHaveBeenCalled();
  });

  it('discards an in-flight launch when the inspected worktree changes', async () => {
    getWorkspaceReadiness.mockResolvedValue({ issues: [issue] });
    let resolveFirstLaunch:
      | ((value: { ok: true; worktreeId: string; chatId: string }) => void)
      | undefined;
    mockedLaunchWorkspaceReadinessFix.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirstLaunch = resolve;
      }),
    );

    await act(async () => {
      root.render(
        <WorkspaceReadinessRecommendations
          workspaceId="app"
          worktreeId="worktree-a"
          onViewConversation={() => Promise.resolve(true)}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    const firstFix = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Fix in new worktree',
    );
    act(() => firstFix?.click());

    await act(async () => {
      root.render(
        <WorkspaceReadinessRecommendations
          workspaceId="app"
          worktreeId="worktree-b"
          onViewConversation={() => Promise.resolve(true)}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      recordMockLaunch('app', issue, 'worktree-a', {
        worktreeId: 'fix-for-a',
        chatId: 'chat-for-a',
      });
      resolveFirstLaunch?.({
        ok: true,
        worktreeId: 'fix-for-a',
        chatId: 'chat-for-a',
      });
      await Promise.resolve();
    });

    // The launch belongs to worktree-a's audit, not the one now shown.
    expect(container.textContent).not.toContain('View conversation');
    expect(container.textContent).toContain('Fix in new worktree');
  });

  it.each(['card', 'row'] as const)(
    'recovers a missing conversation in the %s surface without launching again',
    async (surface) => {
      const originalChats = useChatStore.getState().worktreeChats;
      recordMockLaunch('app', issue, undefined, {
        worktreeId: 'fix-worktree',
        chatId: 'fix-chat',
      });
      getWorkspaceReadiness.mockResolvedValue({ issues: [issue] });
      useChatStore.setState({ worktreeChats: {} });
      const onViewConversation = jest.fn(() => Promise.resolve(true));
      try {
        await act(async () => {
          root.render(
            <WorkspaceReadinessRecommendations
              workspaceId="app"
              surface={surface}
              onViewConversation={onViewConversation}
            />,
          );
          await Promise.resolve();
        });
        expect(container.textContent).toContain('View conversation');
        expect(container.textContent).not.toContain('Conversation unavailable');
        await act(async () => {
          hydratedKeys.add('app/fix-worktree');
          useChatStore.setState({
            worktreeChats: {
              'app/fix-worktree': { tabs: [], activeTabId: '' },
            },
          });
          await Promise.resolve();
        });
        expect(container.textContent).toContain('Conversation unavailable');
        const open = Array.from(container.querySelectorAll('button')).find(
          (button) => button.textContent === 'Open worktree',
        );
        expect(open).toBeDefined();
        await act(async () => {
          open?.click();
          await Promise.resolve();
        });
        expect(onViewConversation).toHaveBeenCalledTimes(1);
        expect(mockedNavigateToWorkspaceReadinessChat).toHaveBeenCalledWith(
          'app',
          'fix-worktree',
          'fix-chat',
        );
        expect(mockedLaunchWorkspaceReadinessFix).not.toHaveBeenCalled();
      } finally {
        hydratedKeys.delete('app/fix-worktree');
        act(() => useChatStore.setState({ worktreeChats: originalChats }));
      }
    },
  );

  it('links a persisted launch for this audit target on first mount', async () => {
    recordMockLaunch('app', issue, 'audited-worktree', {
      worktreeId: 'fix-worktree',
      chatId: 'fix-chat',
    });
    getWorkspaceReadiness.mockResolvedValue({ issues: [issue] });
    const onViewConversation = jest.fn(() => Promise.resolve(true));

    await act(async () => {
      root.render(
        <WorkspaceReadinessRecommendations
          workspaceId="app"
          worktreeId="audited-worktree"
          onViewConversation={onViewConversation}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    const view = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'View conversation',
    );
    await act(async () => {
      view?.click();
      await Promise.resolve();
    });

    expect(mockedNavigateToWorkspaceReadinessChat).toHaveBeenCalledWith(
      'app',
      'fix-worktree',
      'fix-chat',
    );
    expect(mockedLaunchWorkspaceReadinessFix).not.toHaveBeenCalled();
  });

  it('clears only this target’s launches once its audit stops reporting them', async () => {
    recordMockLaunch('app', issue, 'audited-worktree');
    recordMockLaunch('app', issue);
    getWorkspaceReadiness.mockResolvedValue({ issues: [], complete: true });

    await act(async () => {
      root.render(
        <WorkspaceReadinessRecommendations
          workspaceId="app"
          worktreeId="audited-worktree"
          onViewConversation={() => Promise.resolve(true)}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const remaining = Object.values(
      useWorkspaceReadinessLaunchStore.getState().records,
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.baseWorktreeId).toBeUndefined();
  });

  it.each([false, undefined])(
    'retains launches when audit completeness is %s',
    async (complete) => {
      recordMockLaunch('app', issue, 'audited-worktree');
      getWorkspaceReadiness.mockResolvedValue({ issues: [], complete });
      await act(async () => {
        root.render(
          <WorkspaceReadinessRecommendations
            workspaceId="app"
            worktreeId="audited-worktree"
            onViewConversation={() => Promise.resolve(true)}
          />,
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(
        Object.keys(useWorkspaceReadinessLaunchStore.getState().records),
      ).toHaveLength(1);
    },
  );
});
