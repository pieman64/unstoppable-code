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

jest.mock('@/lib/workspaceReadinessLauncher', () => ({
  launchWorkspaceReadinessFix: jest.fn(() =>
    Promise.resolve({
      ok: true as const,
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
    }),
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
    getWorkspaceReadiness.mockResolvedValue({ issues: [] });

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
    expect(container.textContent).toContain('Retry');
    expect(
      container.querySelector(
        'table[aria-label="Project readiness recommendations"]',
      ),
    ).not.toBeNull();
    expect(
      Array.from(container.querySelectorAll('thead th')).every(
        (header) => header.getAttribute('scope') === 'col',
      ),
    ).toBe(true);
    const workspaceHeader = container.querySelector('tbody th');
    expect(workspaceHeader).not.toBeNull();
    expect(workspaceHeader?.hasAttribute('scope')).toBe(false);
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
      container.querySelector('[aria-label="Retry readiness check for API"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="1 recommendations"]'),
    ).not.toBeNull();
    expect(
      container
        .querySelector('[data-testid="workspace-readiness-table-scroll"]')
        ?.classList.contains('max-h-96'),
    ).toBe(true);
    expect(
      container
        .querySelector('[data-testid="workspace-readiness-table-scroll"]')
        ?.classList.contains('overflow-y-auto'),
    ).toBe(true);
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
      (button) => button.textContent === 'Retry',
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
      buttons.find((button) => button.textContent === 'Retry')?.click();
      await Promise.resolve();
    });
    expect(getWorkspaceReadiness).toHaveBeenCalledTimes(2);
    expect(
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Retry')
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
