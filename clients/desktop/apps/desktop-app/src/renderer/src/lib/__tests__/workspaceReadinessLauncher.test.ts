import type {
  SidebarItem,
  WorktreeData,
  WorkspaceReadinessIssue,
} from '@canopy/desktop-shared/types';
import {
  launchWorkspaceReadinessFix,
  navigateToWorkspaceReadinessChat,
  resolveWorkspaceReadinessWorktreeId,
} from '../workspaceReadinessLauncher';
import { brand } from '@/lib/brand';
import { useChatStore } from '@/stores/chatStore';
import type {
  ChatTab,
  CreateTabTarget,
  WorktreeChatState,
} from '@/stores/chat/types';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';

const issue: WorkspaceReadinessIssue = {
  code: 'configure-hooks',
  title: 'Add repository hooks',
  message: 'No effective hooks.',
  repoId: 'api',
  repoName: 'API',
  fixPrompt: 'Configure hooks.',
};

function worktree(
  setupPhase: 'git-pending' | 'git-ready' = 'git-ready',
): WorktreeData {
  return {
    id: 'worktree-1',
    branchName: 'feature',
    createdAt: new Date(0).toISOString(),
    setupPhase,
  };
}

function workspace(
  setupPhase: 'git-pending' | 'git-ready' = 'git-ready',
): SidebarItem {
  return {
    id: 'workspace-1',
    name: 'Workspace',
    type: 'multi-repo',
    color: '#fff',
    collapsed: false,
    order: 0,
    repos: [{ id: 'api', name: 'API', repoPath: '/repos/api' }],
    worktrees: [worktree(setupPhase)],
  };
}

function chatTab(
  id: string,
  title: string,
  pluginSelections?: ChatTab['pluginSelections'],
): ChatTab {
  return {
    id,
    title,
    messages: [],
    status: 'idle',
    error: null,
    createdAt: new Date(0).toISOString(),
    queuedMessages: [],
    planMode: false,
    thinkingLevel: 'high',
    proposalMode: 'optional',
    ...(pluginSelections ? { pluginSelections } : {}),
  };
}

function worktreeChat(activeTabId: string, tabs: ChatTab[]): WorktreeChatState {
  return { activeTabId, tabs };
}

describe('launchWorkspaceReadinessFix', () => {
  const originalProjectsState = useProjectsStore.getState();
  const originalChatState = useChatStore.getState();
  const originalNavigationState = useNavigationStore.getState();

  const createWorktree = jest.fn();
  const retryWorktreeHealthCheck = jest.fn();
  const loadAllWorktreeTabs = jest.fn();
  const createTab = jest.fn<void, [CreateTabTarget | undefined]>();
  const sendMessage = jest.fn();
  const setSelectedRepoId = jest.fn();
  const navigate = jest.fn();
  const selectWorktree = jest.fn();
  const ensureSelectedWorktreeTabsLoaded = jest.fn();
  const switchTab = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    createWorktree.mockResolvedValue({
      id: 'worktree-1',
      setupPhase: 'git-ready',
    });
    retryWorktreeHealthCheck.mockResolvedValue({
      healthy: true,
      worktree: worktree(),
    });
    loadAllWorktreeTabs.mockResolvedValue(undefined);
    sendMessage.mockResolvedValue(undefined);
    useProjectsStore.setState({
      projects: [workspace()],
      createWorktree,
      retryWorktreeHealthCheck,
    });
    const initialWorktreeChats: Record<string, WorktreeChatState> = {
      'workspace-1/worktree-1': worktreeChat('empty', [
        chatTab('empty', 'New chat', {
          skillRefs: [{ sourceId: 'user', skillName: 'existing-skill' }],
        }),
      ]),
    };
    useChatStore.setState({
      worktreeChats: initialWorktreeChats,
      loadAllWorktreeTabs,
      createTab: (target): void => {
        createTab(target);
        const createdWorktreeChats: Record<string, WorktreeChatState> = {
          'workspace-1/worktree-1': worktreeChat('new-chat', [
            chatTab('new-chat', issue.title),
          ]),
        };
        useChatStore.setState({
          worktreeChats: createdWorktreeChats,
        });
      },
      sendMessage,
      setSelectedRepoId,
      selectWorktree,
      ensureSelectedWorktreeTabsLoaded,
      switchTab,
    });
    useNavigationStore.setState({ navigate });
    ensureSelectedWorktreeTabsLoaded.mockResolvedValue(true);
  });

  afterAll(() => {
    useProjectsStore.setState(originalProjectsState, true);
    useChatStore.setState(originalChatState, true);
    useNavigationStore.setState(originalNavigationState, true);
  });

  it('does not launch a fix for evidence-only readiness issues', async () => {
    const result = await launchWorkspaceReadinessFix('workspace-1', {
      ...issue,
      fixPrompt: null,
    });
    expect(result.ok).toBe(false);
    expect(createWorktree).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('creates a scoped worktree chat, preserves selections, and adds the config skill', async () => {
    await expect(
      launchWorkspaceReadinessFix('workspace-1', issue),
    ).resolves.toEqual({
      ok: true,
      worktreeId: 'worktree-1',
      chatId: 'new-chat',
    });

    expect(createWorktree).toHaveBeenCalledWith('workspace-1', {
      suppressStartPage: true,
    });
    expect(loadAllWorktreeTabs).toHaveBeenCalledWith([
      { projectId: 'workspace-1', worktreeId: 'worktree-1' },
    ]);
    const createdTab = createTab.mock.calls[0]?.[0];
    expect(createdTab).toMatchObject({
      title: issue.title,
      replaceActiveEmpty: true,
    });
    expect(createdTab?.pluginSelections?.skillRefs).toEqual(
      expect.arrayContaining([
        { sourceId: 'user', skillName: 'existing-skill' },
        {
          sourceId: 'builtin:app',
          skillName: `${brand.internalName}-config`,
        },
      ]),
    );
    expect(createdTab).toMatchObject({ selectedRepoId: 'api' });
    expect(setSelectedRepoId).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('main');
    expect(sendMessage).toHaveBeenCalledWith(
      issue.fixPrompt,
      undefined,
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'new-chat',
      },
      undefined,
      { throwOnDispatchFailure: true },
    );
  });

  it('leaves navigation to the caller when navigateToChat is false', async () => {
    await expect(
      launchWorkspaceReadinessFix('workspace-1', issue, undefined, {
        navigateToChat: false,
      }),
    ).resolves.toEqual({
      ok: true,
      worktreeId: 'worktree-1',
      chatId: 'new-chat',
    });

    // The Overview stays put so several recommendations can be started in a
    // row; the prompt must still dispatch with no chat view mounted.
    expect(navigate).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      issue.fixPrompt,
      undefined,
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'new-chat',
      },
      undefined,
      { throwOnDispatchFailure: true },
    );
  });

  it('opens a launched readiness chat on the worktree that owns it', async () => {
    await navigateToWorkspaceReadinessChat(
      'workspace-1',
      'worktree-1',
      'new-chat',
    );

    expect(navigate).toHaveBeenCalledWith('main');
    expect(selectWorktree).toHaveBeenCalledWith('workspace-1', 'worktree-1');
    expect(switchTab).toHaveBeenCalledWith('new-chat', {
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
    });
  });

  it('opens the launched worktree when selection changes during hydration', async () => {
    let resolveHydration: ((loaded: boolean) => void) | undefined;
    ensureSelectedWorktreeTabsLoaded.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveHydration = resolve;
      }),
    );

    const navigation = navigateToWorkspaceReadinessChat(
      'workspace-1',
      'worktree-1',
      'new-chat',
    );
    useChatStore.setState({
      selectedWorktree: {
        projectId: 'another-workspace',
        worktreeId: 'another-worktree',
      },
    });
    resolveHydration?.(true);
    await navigation;

    expect(switchTab).toHaveBeenCalledWith('new-chat', {
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
    });
  });

  it('does not switch tabs when the worktree tabs fail to hydrate', async () => {
    ensureSelectedWorktreeTabsLoaded.mockResolvedValue(false);

    await navigateToWorkspaceReadinessChat(
      'workspace-1',
      'worktree-1',
      'new-chat',
    );

    expect(selectWorktree).toHaveBeenCalledWith('workspace-1', 'worktree-1');
    expect(switchTab).not.toHaveBeenCalled();
  });

  it('keeps repository scope on the targeted chat if the active worktree changes', async () => {
    createTab.mockImplementationOnce(() => {
      useChatStore.setState({
        selectedWorktree: {
          projectId: 'another-workspace',
          worktreeId: 'another-worktree',
        },
      });
    });

    await expect(
      launchWorkspaceReadinessFix('workspace-1', issue),
    ).resolves.toEqual({
      ok: true,
      worktreeId: 'worktree-1',
      chatId: 'new-chat',
    });

    expect(createTab.mock.calls[0]?.[0]).toMatchObject({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      selectedRepoId: 'api',
    });
    expect(setSelectedRepoId).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      issue.fixPrompt,
      undefined,
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'new-chat',
      },
      undefined,
      { throwOnDispatchFailure: true },
    );
  });

  it('queues the prompt while git setup is pending', async () => {
    useProjectsStore.setState({ projects: [workspace('git-pending')] });

    await launchWorkspaceReadinessFix('workspace-1', issue);

    expect(sendMessage).toHaveBeenCalledWith(
      issue.fixPrompt,
      undefined,
      expect.any(Object),
      undefined,
      { queueForSetup: true, throwOnDispatchFailure: true },
    );
  });

  it('creates the fix worktree from the audited worktree', async () => {
    await launchWorkspaceReadinessFix('workspace-1', issue, 'audited-worktree');

    expect(retryWorktreeHealthCheck).toHaveBeenCalledWith(
      'workspace-1',
      'audited-worktree',
    );
    expect(createWorktree).toHaveBeenCalledWith('workspace-1', {
      baseWorktreeId: 'audited-worktree',
      suppressStartPage: true,
    });
  });

  it('rejects a partial multi-repo base with an actionable error', async () => {
    retryWorktreeHealthCheck.mockResolvedValueOnce({
      healthy: false,
      worktree: worktree(),
      issue: {
        status: 'broken',
        code: 'missing-repository',
        message: 'One or more repositories in this project are missing.',
        checkedAt: new Date(0).toISOString(),
        worktreePath: '/worktrees/workspace-1/audited-worktree',
        repoIssues: [
          {
            repoId: 'docs',
            repoName: 'Docs',
            repoPath: '/worktrees/workspace-1/audited-worktree/repos/docs',
            code: 'missing-repository',
            message: 'Repository is missing.',
          },
        ],
      },
    });

    await expect(
      launchWorkspaceReadinessFix('workspace-1', issue, 'audited-worktree'),
    ).resolves.toEqual({
      ok: false,
      message:
        'This worktree excludes Docs. Add the missing repository before starting a readiness fix from it.',
    });
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it('returns a useful failure when worktree creation fails', async () => {
    createWorktree.mockResolvedValueOnce(undefined);

    await expect(
      launchWorkspaceReadinessFix('workspace-1', issue),
    ).resolves.toEqual({
      ok: false,
      message: 'Could not create a worktree for this recommendation.',
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('returns send failures to the caller', async () => {
    sendMessage.mockRejectedValueOnce(new Error('send failed'));

    await expect(
      launchWorkspaceReadinessFix('workspace-1', issue),
    ).resolves.toEqual({
      ok: false,
      message: 'send failed',
    });
  });

  it('rejects a duplicate launch while the first launch is still starting', async () => {
    let resolveCreation:
      | ((value: { id: string; setupPhase: 'git-ready' }) => void)
      | undefined;
    createWorktree.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreation = resolve;
      }),
    );

    const first = launchWorkspaceReadinessFix('workspace-1', issue);
    await expect(
      launchWorkspaceReadinessFix('workspace-1', issue),
    ).resolves.toEqual({
      ok: false,
      message: 'This recommendation is already starting.',
    });
    resolveCreation?.({ id: 'worktree-1', setupPhase: 'git-ready' });
    await expect(first).resolves.toEqual({
      ok: true,
      worktreeId: 'worktree-1',
      chatId: 'new-chat',
    });
  });

  it('does nothing for Cowork projects', async () => {
    useProjectsStore.setState({
      projects: [
        {
          id: 'workspace-1',
          name: 'Cowork',
          type: 'cowork',
          color: '#fff',
          collapsed: false,
          order: 0,
        },
      ],
    });

    await expect(
      launchWorkspaceReadinessFix('workspace-1', issue),
    ).resolves.toEqual({
      ok: false,
      message: 'Repository readiness is only available for Code projects.',
    });
    expect(createWorktree).not.toHaveBeenCalled();
  });
});

describe('resolveWorkspaceReadinessWorktreeId', () => {
  it('uses the drift worktree when the settings audit resolved one', () => {
    expect(
      resolveWorkspaceReadinessWorktreeId(
        'drift-worktree',
        'inspected-worktree',
      ),
    ).toBe('drift-worktree');
  });

  it('falls back to the explicitly inspected worktree', () => {
    expect(
      resolveWorkspaceReadinessWorktreeId(undefined, 'inspected-worktree'),
    ).toBe('inspected-worktree');
  });
});
