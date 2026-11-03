/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  SidebarItem,
  WorkspaceReadinessIssue,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import type { WorktreePrStatus } from '@canopy/desktop-shared/types/github';
import { HomeWorkspaceReadiness } from '../HomeWorkspaceReadiness';
import {
  launchWorkspaceReadinessFix,
  navigateToWorkspaceReadinessChat,
} from '@/lib/workspaceReadinessLauncher';
import { workspaceReadinessIssueKey } from '@/lib/workspaceReadinessIssueKey';
import {
  launchedReadinessFixKey,
  type LaunchedReadinessFix,
} from '@/lib/workspaceReadinessLaunches';
import { hydratedKeys } from '@/stores/chat/hydration';
import type { ChatTab } from '@/stores/chat/types';
import { useChatStore } from '@/stores/chatStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useWorkspaceReadinessLaunchStore } from '@/stores/workspaceReadinessLaunchStore';

jest.mock('@/lib/workspaceReadinessLauncher', () => ({
  launchWorkspaceReadinessFix: jest.fn(),
  navigateToWorkspaceReadinessChat: jest.fn(),
}));
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
const issue: WorkspaceReadinessIssue = {
  code: 'configure-hooks',
  title: 'Add repository hooks',
  message: 'Configure hooks',
  repoName: 'Example',
  fixPrompt: 'Add hooks',
};
const launch: LaunchedReadinessFix = {
  workspaceId: 'selected-project',
  issueKey: workspaceReadinessIssueKey(issue),
  issueCode: issue.code,
  worktreeId: 'wt',
  chatId: 'chat',
  launchedAt: '2026-10-31T12:00:00.000Z',
};
const mergedPr: WorktreePrStatus = {
  lastCheckedAt: '2026-10-31T12:00:00.000Z',
  repos: [
    {
      repoId: 'example',
      repoName: 'Example',
      status: {
        prNumber: 1,
        prUrl: 'https://github.com/example/example/pull/1',
        state: 'merged',
        title: 'Add hooks',
        checkStatus: 'passing',
        checkDetails: [],
        reviewStatus: 'approved',
        reviewers: [],
        hasConflicts: false,
        commentCount: 0,
        updatedAt: '2026-10-31T12:00:00.000Z',
        mergedAt: '2026-10-31T12:00:00.000Z',
      },
    },
  ],
};

function project(worktree: Partial<WorktreeData> = {}): SidebarItem {
  return {
    id: 'selected-project',
    name: 'Example',
    type: 'single-repo',
    repoPath: '/repos/example',
    color: '#fff',
    collapsed: false,
    order: 0,
    worktrees: [
      {
        id: 'wt',
        branchName: 'fix/hooks',
        createdAt: new Date(0).toISOString(),
        ...worktree,
      },
    ],
  };
}

function tab(overrides: Partial<ChatTab>): ChatTab {
  return {
    id: 'chat',
    title: 'Add repository hooks',
    messages: [],
    status: 'idle',
    error: null,
    createdAt: new Date(0).toISOString(),
    queuedMessages: [],
    planMode: false,
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
    proposalMode: 'optional',
    ...overrides,
  };
}

function setChat(tabs: ChatTab[]): void {
  useChatStore.setState({
    worktreeChats: {
      'selected-project/wt': { activeTabId: 'chat', tabs },
    },
  });
}

function fixRow(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    '[data-testid="home-readiness-fix-configure-hooks"]',
  );
}

function launchedRow(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    '[data-testid="home-readiness-launched-configure-hooks"]',
  );
}

let root: Root;
let container: HTMLDivElement;
const read = jest.fn();
const originalProjectsState = useProjectsStore.getState();
const originalChatState = useChatStore.getState();
afterAll(() => {
  useProjectsStore.setState(originalProjectsState, true);
  useChatStore.setState(originalChatState, true);
});
beforeEach(() => {
  window.localStorage.clear();
  hydratedKeys.clear();
  useWorkspaceReadinessLaunchStore.setState({
    records: {},
    pendingSendKeys: {},
    failedSendKeys: {},
  });
  useProjectsStore.setState({
    projects: [project()],
    hasHydratedProjects: true,
    projectInventoryStatus: 'ready',
    projectInventorySnapshot: { projects: [project()], startedAt: Date.now() },
    isLoading: false,
    failedWorkspaceIds: new Set(),
  });
  useChatStore.setState({ worktreeChats: {} });
  container = document.createElement('div');
  root = createRoot(container);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { getWorkspaceReadiness: read },
  });
  read.mockResolvedValue({
    issues: [
      issue,
      {
        ...issue,
        code: 'recovery-required',
        title: 'Recover interrupted creation',
        fixPrompt: null,
      },
    ],
  });
});
afterEach(() => {
  act(() => root.unmount());
  jest.resetAllMocks();
  Reflect.deleteProperty(window, 'api');
});

it('retains actionable fixes without turning recovery evidence into an automatic action', async () => {
  await act(async () => {
    root.render(<HomeWorkspaceReadiness workspaceId="selected-project" />);
    await Promise.resolve();
  });
  expect(read).toHaveBeenCalledWith({ workspaceId: 'selected-project' });
  expect(container.textContent).toContain('Add repository hooks');
  expect(container.textContent).not.toContain('Recover interrupted creation');
});

it('deduplicates fix dispatch and replaces the row once the launch is recorded', async () => {
  let resolve:
    | ((value: { ok: true; worktreeId: string; chatId: string }) => void)
    | undefined;
  jest.mocked(launchWorkspaceReadinessFix).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () => {
    root.render(<HomeWorkspaceReadiness workspaceId="selected-project" />);
    await Promise.resolve();
  });
  const button = container.querySelector<HTMLButtonElement>(
    '[data-testid^="home-readiness-fix-"]',
  );
  act(() => {
    button?.click();
    button?.click();
  });
  expect(launchWorkspaceReadinessFix).toHaveBeenCalledTimes(1);
  expect(launchWorkspaceReadinessFix).toHaveBeenCalledWith(
    'selected-project',
    issue,
  );
  expect(container.textContent).toContain('Add repository hooks');
  await act(async () => {
    useWorkspaceReadinessLaunchStore.getState().recordLaunch(launch);
    resolve?.({ ok: true, worktreeId: 'wt', chatId: 'chat' });
    await Promise.resolve();
  });
  expect(fixRow()).toBeNull();
  expect(launchedRow()).not.toBeNull();
});

describe('a launched fix', () => {
  async function renderWithLaunch(
    overrides: Partial<LaunchedReadinessFix> = {},
  ): Promise<void> {
    useWorkspaceReadinessLaunchStore
      .getState()
      .recordLaunch({ ...launch, ...overrides });
    await act(async () => {
      root.render(<HomeWorkspaceReadiness workspaceId="selected-project" />);
      await Promise.resolve();
    });
  }

  it('opens the existing chat without launching again', async () => {
    hydratedKeys.add('selected-project/wt');
    useProjectsStore.setState({ projects: [project({ label: 'Docs pass' })] });
    setChat([tab({})]);
    await renderWithLaunch();

    const row = launchedRow();
    expect(fixRow()).toBeNull();
    expect(row?.textContent).toBe(
      'Repository hooks · ready to review on Docs pass · Open chat',
    );
    expect(row?.getAttribute('aria-label')).toBe(
      'Repository hooks, ready to review. Open chat',
    );
    expect(row?.querySelector('.ph-mask')?.textContent).toBe('Docs pass');
    act(() => row?.click());
    expect(navigateToWorkspaceReadinessChat).toHaveBeenCalledWith(
      'selected-project',
      'wt',
      'chat',
    );
    expect(launchWorkspaceReadinessFix).not.toHaveBeenCalled();
  });

  it('shows work in progress while the chat streams', async () => {
    setChat([tab({ status: 'streaming' })]);
    await renderWithLaunch();
    expect(launchedRow()?.textContent).toBe(
      'Repository hooks · in progress on fix/hooks · Open chat',
    );
  });

  it('stays neutral until the chat hydrates', async () => {
    setChat([tab({})]);
    await renderWithLaunch();
    expect(launchedRow()?.textContent).toBe(
      'Repository hooks · fix started on fix/hooks · Open chat',
    );
  });

  it('flags a failed send without claiming success', async () => {
    setChat([tab({})]);
    await renderWithLaunch();
    act(() => {
      useWorkspaceReadinessLaunchStore
        .getState()
        .setSendFailed(launchedReadinessFixKey(launch), true);
    });
    expect(launchedRow()?.textContent).toBe(
      'Repository hooks · needs attention on fix/hooks · Open chat',
    );
  });

  it('offers the worktree when its chat is gone', async () => {
    setChat([]);
    hydratedKeys.add('selected-project/wt');
    await renderWithLaunch();
    expect(launchedRow()?.textContent).toBe(
      'Repository hooks · conversation unavailable on fix/hooks · Open worktree',
    );
    act(() => launchedRow()?.click());
    expect(navigateToWorkspaceReadinessChat).toHaveBeenCalledWith(
      'selected-project',
      'wt',
      'chat',
    );
    expect(launchWorkspaceReadinessFix).not.toHaveBeenCalled();
  });

  it('omits the destination when the worktree has no name to show', async () => {
    useProjectsStore.setState({ projects: [project({ branchName: '' })] });
    await renderWithLaunch();
    expect(launchedRow()?.textContent).toBe(
      'Repository hooks · fix started · Open chat',
    );
  });

  it('restores the fix once the fix worktree merged', async () => {
    await renderWithLaunch();
    expect(launchedRow()).not.toBeNull();
    act(() => {
      useProjectsStore.setState({
        projects: [project({ status: 'done', lastKnownPrStatus: mergedPr })],
      });
    });
    expect(launchedRow()).toBeNull();
    expect(fixRow()).not.toBeNull();
  });

  it('removes both rows once the audit stops reporting the issue', async () => {
    read.mockResolvedValue({ issues: [], complete: true });
    await renderWithLaunch();
    expect(container.childElementCount).toBe(0);
    expect(useWorkspaceReadinessLaunchStore.getState().records).toEqual({});
  });

  it.each([false, undefined])(
    'retains the link when audit completeness is %s',
    async (complete) => {
      read.mockResolvedValue({ issues: [], complete });
      await renderWithLaunch();
      expect(
        Object.values(useWorkspaceReadinessLaunchStore.getState().records),
      ).toEqual([launch]);
    },
  );

  it('keeps other issues and other repositories independently actionable', async () => {
    read.mockResolvedValue({
      issues: [
        issue,
        { ...issue, repoId: 'web', repoName: 'Web' },
        { ...issue, code: 'configure-scripts', title: 'Add scripts' },
      ],
    });
    await renderWithLaunch();
    const fixRows = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid^="home-readiness-fix-"]',
      ),
    );
    expect(fixRows.map((row) => row.textContent)).toEqual([
      'Add repository hooks · Web',
      'Add scripts · Example',
    ]);
    expect(fixRows.every((row) => !row.disabled)).toBe(true);
    expect(
      container.querySelectorAll('[data-testid^="home-readiness-launched-"]'),
    ).toHaveLength(1);
  });

  it('ignores a launch from another audit target', async () => {
    await renderWithLaunch({ baseWorktreeId: 'some-worktree' });
    expect(launchedRow()).toBeNull();
    expect(fixRow()).not.toBeNull();
  });
});

it('keeps a rejected fix available for retry with its error', async () => {
  jest
    .mocked(launchWorkspaceReadinessFix)
    .mockResolvedValue({ ok: false, message: 'Try again' });
  await act(async () => {
    root.render(<HomeWorkspaceReadiness workspaceId="selected-project" />);
    await Promise.resolve();
  });
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('[data-testid^="home-readiness-fix-"]')
      ?.click();
    await Promise.resolve();
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    'Try again',
  );
  expect(
    container.querySelector<HTMLButtonElement>(
      '[data-testid^="home-readiness-fix-"]',
    )?.disabled,
  ).toBe(false);
});

it('ignores a read completing after the selected project changed', async () => {
  let resolveOld:
    | ((value: { issues: WorkspaceReadinessIssue[] }) => void)
    | undefined;
  read.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolveOld = done;
      }),
  );
  await act(async () => {
    root.render(<HomeWorkspaceReadiness key="old" workspaceId="old" />);
    await Promise.resolve();
  });
  read.mockResolvedValueOnce({ issues: [] });
  await act(async () => {
    root.render(<HomeWorkspaceReadiness key="new" workspaceId="new" />);
    await Promise.resolve();
  });
  await act(async () => {
    resolveOld?.({ issues: [issue] });
    await Promise.resolve();
  });
  expect(container.childElementCount).toBe(0);
});
