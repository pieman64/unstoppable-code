/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  SidebarItem,
  WorkspaceReadinessIssue,
} from '@canopy/desktop-shared/types';
import { HomeWorkspaceReadiness } from '../HomeWorkspaceReadiness';
import { hydratedKeys } from '@/stores/chat/hydration';
import type { ChatTab, WorktreeChatState } from '@/stores/chat/types';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';

/**
 * CAN-5500: launching a fix from Home navigates away before the send settles,
 * so Home unmounts mid-launch. Returning must link the launched chat instead
 * of offering the same fix again. Drives the real launcher.
 */
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const instructions: WorkspaceReadinessIssue = {
  code: 'configure-agent-instructions',
  title: 'Initialize agent instructions',
  message: 'No shared agent instructions.',
  repoName: 'Example',
  fixPrompt: 'Write AGENTS.md.',
};
const hooks: WorkspaceReadinessIssue = {
  code: 'configure-hooks',
  title: 'Add repository hooks',
  message: 'No hooks.',
  repoName: 'Example',
  fixPrompt: 'Add hooks.',
};

function chatTab(id: string): ChatTab {
  return {
    id,
    title: 'New chat',
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
  };
}

function workspace(worktreeIds: string[]): SidebarItem {
  return {
    id: 'workspace-1',
    name: 'Workspace',
    type: 'single-repo',
    repoPath: '/repos/example',
    color: '#fff',
    collapsed: false,
    order: 0,
    worktrees: worktreeIds.map((id) => ({
      id,
      branchName: `fix/${id}`,
      createdAt: new Date(0).toISOString(),
    })),
  };
}

let root: Root;
let container: HTMLDivElement;
const read = jest.fn();
const createWorktree = jest.fn();
const sendMessage = jest.fn();
const selectWorktree = jest.fn();
const switchTab = jest.fn();
const navigate = jest.fn();
const originalProjects = useProjectsStore.getState();
const originalChat = useChatStore.getState();
const originalNavigation = useNavigationStore.getState();

beforeEach(() => {
  window.localStorage.clear();
  hydratedKeys.clear();
  container = document.createElement('div');
  root = createRoot(container);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { getWorkspaceReadiness: read },
  });
  read.mockResolvedValue({ issues: [instructions, hooks] });
  createWorktree.mockImplementation(() => {
    useProjectsStore.setState({ projects: [workspace(['fix-1'])] });
    return Promise.resolve({ id: 'fix-1', setupPhase: 'git-ready' });
  });
  useProjectsStore.setState({
    projects: [workspace([])],
    hasHydratedProjects: true,
    projectInventoryStatus: 'ready',
    projectInventorySnapshot: {
      projects: [workspace([])],
      startedAt: Date.now(),
    },
    isLoading: false,
    failedWorkspaceIds: new Set(),
    createWorktree,
  });
  const chats: Record<string, WorktreeChatState> = {};
  useChatStore.setState({
    worktreeChats: chats,
    loadAllWorktreeTabs: (): Promise<void> => Promise.resolve(),
    createTab: (): void => {
      const created: Record<string, WorktreeChatState> = {
        'workspace-1/fix-1': {
          activeTabId: 'fix-chat',
          tabs: [chatTab('fix-chat')],
        },
      };
      hydratedKeys.add('workspace-1/fix-1');
      useChatStore.setState({ worktreeChats: created });
    },
    sendMessage,
    selectWorktree,
    ensureSelectedWorktreeTabsLoaded: (): Promise<boolean> =>
      Promise.resolve(true),
    switchTab,
  });
  useNavigationStore.setState({ navigate });
});

afterEach(() => {
  act(() => root.unmount());
  jest.clearAllMocks();
  Reflect.deleteProperty(window, 'api');
});

afterAll(() => {
  useProjectsStore.setState(originalProjects, true);
  useChatStore.setState(originalChat, true);
  useNavigationStore.setState(originalNavigation, true);
});

async function renderHome(): Promise<void> {
  await act(async () => {
    root.render(<HomeWorkspaceReadiness workspaceId="workspace-1" />);
    await Promise.resolve();
  });
}

it('links the launched fix after Home unmounts mid-launch and is opened again', async () => {
  let settleSend: (() => void) | undefined;
  sendMessage.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        settleSend = resolve;
      }),
  );
  await renderHome();

  await act(async () => {
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="home-readiness-fix-configure-agent-instructions"]',
      )
      ?.click();
    await Promise.resolve();
  });
  expect(navigate).toHaveBeenCalledWith('main');
  // Launching navigates to the chat, unmounting Home before the send settles.
  act(() => root.unmount());
  await act(async () => {
    settleSend?.();
    await Promise.resolve();
  });

  root = createRoot(container);
  await renderHome();

  expect(
    container.querySelector(
      '[data-testid="home-readiness-fix-configure-agent-instructions"]',
    ),
  ).toBeNull();
  const launched = container.querySelector<HTMLButtonElement>(
    '[data-testid="home-readiness-launched-configure-agent-instructions"]',
  );
  expect(launched?.textContent).toContain('Agent instructions');
  expect(launched?.textContent).toContain('ready to review on fix/fix-1');
  expect(launched?.textContent).toContain('Open chat');
  // The unrelated fix stays actionable.
  expect(
    container.querySelector<HTMLButtonElement>(
      '[data-testid="home-readiness-fix-configure-hooks"]',
    )?.disabled,
  ).toBe(false);

  await act(async () => {
    launched?.click();
    await Promise.resolve();
  });
  expect(selectWorktree).toHaveBeenCalledWith('workspace-1', 'fix-1');
  expect(switchTab).toHaveBeenCalledWith('fix-chat', {
    projectId: 'workspace-1',
    worktreeId: 'fix-1',
  });
  expect(createWorktree).toHaveBeenCalledTimes(1);
  expect(sendMessage).toHaveBeenCalledTimes(1);
});
