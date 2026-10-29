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
import { WorkspaceReadinessRecommendations } from '../WorkspaceReadinessRecommendations';

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
    mockedLaunchWorkspaceReadinessFix.mockResolvedValue({
      ok: true,
      worktreeId: 'fix-worktree',
      chatId: 'fix-chat',
    });
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
          onViewConversation={() => undefined}
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
    getWorkspaceReadiness.mockResolvedValue({ issues: [] });

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
    expect(container.textContent).toContain('Retry');
    expect(container.textContent).not.toContain('This Code project has');

    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry',
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
    const onViewConversation = jest.fn();

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
    const onViewConversation = jest.fn();

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
          onViewConversation={() => undefined}
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
          onViewConversation={() => undefined}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      resolveFirstLaunch?.({
        ok: true,
        worktreeId: 'fix-for-a',
        chatId: 'chat-for-a',
      });
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain('View conversation');
    expect(container.textContent).toContain('Fix in new worktree');
  });
});
