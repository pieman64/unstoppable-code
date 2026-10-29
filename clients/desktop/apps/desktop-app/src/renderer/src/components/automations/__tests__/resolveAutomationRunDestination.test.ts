/**
 * @jest-environment jsdom
 */
import type { ScheduledActivityRun } from '@canopy/desktop-shared/types';
import {
  openAutomationRunDestination,
  resolveAvailableAutomationRunDestination,
  resolveAutomationRunDestination,
} from '../resolveAutomationRunDestination';
import { brandText } from '@/lib/brand';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import {
  openPipelineExecutionPanel as openPipelineExecutionPanelImpl,
  type OpenPipelineExecutionResult,
} from '@/lib/panels/open-pipeline-execution';

jest.mock('@/lib/panels/open-pipeline-execution', () => ({
  openPipelineExecutionPanel: jest.fn(),
}));

const openPipelineExecutionPanel = jest.mocked(openPipelineExecutionPanelImpl);
const APPLIED: OpenPipelineExecutionResult = {
  status: 'applied',
  ownerKey: 'workspace-1/worktree-1',
  layoutKey: 'workspace-1/worktree-1',
  panelId: 'panel-pipeline-exec-1',
  outcome: 'placed',
};

function makeRun(
  overrides: Partial<ScheduledActivityRun> = {},
): ScheduledActivityRun {
  return {
    id: 'run-1',
    activityId: 'activity-1',
    activityName: 'Nightly sweep',
    scheduledFor: '2026-09-11T09:00:00.000Z',
    manual: false,
    status: 'success',
    startedAt: '2026-09-11T09:00:01.000Z',
    completedAt: '2026-09-11T09:00:09.000Z',
    ...overrides,
  };
}

describe('resolveAutomationRunDestination', () => {
  it('resolves an App Advisor chat', () => {
    expect(
      resolveAutomationRunDestination(
        makeRun({
          result: { appAdvisorChatId: 'chat-a', userMessageId: 'msg-1' },
        }),
      ),
    ).toEqual({
      kind: 'app-advisor-chat',
      chatId: 'chat-a',
      userMessageId: 'msg-1',
    });
  });

  it('resolves a cowork chat, falling back to the run target workspace', () => {
    expect(
      resolveAutomationRunDestination(
        makeRun({
          result: { standaloneChatId: 'chat-c' },
          target: { workspaceId: 'cowork-1' },
        }),
      ),
    ).toEqual({
      kind: 'cowork-chat',
      workspaceId: 'cowork-1',
      chatId: 'chat-c',
    });
  });

  it('resolves a worktree chat with its turn', () => {
    expect(
      resolveAutomationRunDestination(
        makeRun({
          result: {
            chatId: 'chat-w',
            projectId: 'workspace-1',
            worktreeId: 'worktree-1',
            userMessageId: 'msg-9',
          },
        }),
      ),
    ).toEqual({
      kind: 'worktree-chat',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-w',
      userMessageId: 'msg-9',
    });
  });

  it('treats an app-advisor-scoped chat result as an App Advisor chat', () => {
    expect(
      resolveAutomationRunDestination(
        makeRun({
          result: { chatId: 'chat-x', projectId: 'app-advisor' },
        }),
      ),
    ).toEqual({ kind: 'app-advisor-chat', chatId: 'chat-x' });
  });

  it('resolves a worktree pipeline execution', () => {
    expect(
      resolveAutomationRunDestination(
        makeRun({
          result: {
            pipelineExecutionId: 'exec-1',
            projectId: 'workspace-1',
            worktreeId: 'worktree-1',
          },
        }),
      ),
    ).toEqual({
      kind: 'pipeline-execution',
      executionId: 'exec-1',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
    });
  });

  it('resolves a bare pipeline execution with no worktree', () => {
    expect(
      resolveAutomationRunDestination(
        makeRun({ result: { pipelineExecutionId: 'exec-2' } }),
      ),
    ).toEqual({ kind: 'pipeline-execution', executionId: 'exec-2' });
  });

  it('keeps a resumed pipeline execution bare despite its static target', () => {
    expect(
      resolveAutomationRunDestination(
        makeRun({
          result: { pipelineExecutionId: 'exec-resumed' },
          target: {
            workspaceId: 'workspace-1',
            worktreeId: 'worktree-removed',
          },
        }),
      ),
    ).toEqual({
      kind: 'pipeline-execution',
      executionId: 'exec-resumed',
    });
  });

  it.each([
    ['running', 'Still running.'],
    ['missed', `Missed while ${brandText.appName} was closed.`],
    ['canceled', 'Canceled before it started.'],
    ['skipped', 'Skipped, so nothing was started.'],
    ['failure', 'Failed before it started anything.'],
  ] as const)('explains why a %s run has nothing to open', (status, reason) => {
    expect(resolveAutomationRunDestination(makeRun({ status }))).toEqual({
      kind: 'none',
      reason,
    });
  });
});

describe('openAutomationRunDestination', () => {
  const selectWorktree = jest.fn();
  const loadTabsForTarget = jest.fn<Promise<void>, [string, string]>();
  const switchTab = jest.fn();
  const navigate = jest.fn();
  const openWindow = jest.fn();
  const loadTabs = jest.fn();
  const loadArchives = jest.fn();
  const resolveChat = jest.fn();
  const listStandaloneChats = jest.fn();
  const loadExecutionDetails = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    loadTabsForTarget.mockResolvedValue(undefined);
    openWindow.mockResolvedValue({ open: true, focused: true });
    loadTabs.mockResolvedValue({
      version: 1,
      tabs: [{ id: 'chat-w', title: 'Chat' }],
      activeTabId: 'chat-w',
    });
    loadArchives.mockResolvedValue([]);
    resolveChat.mockResolvedValue({
      entryId: 'entry-1',
      archivedInEntryId: null,
    });
    listStandaloneChats.mockResolvedValue({ chats: [] });
    loadExecutionDetails.mockResolvedValue({ id: 'available-execution' });
    openPipelineExecutionPanel.mockResolvedValue(APPLIED);
    useProjectsStore.setState({
      projects: [
        {
          id: 'workspace-1',
          name: 'Canopy',
          worktrees: [{ id: 'worktree-1', branchName: 'feature/x' }],
        },
      ],
    });
    useNavigationStore.setState({ navigate, pendingChatTurnFocus: undefined });
    usePipelineRunsStore.setState({ loadExecutionDetails });
    useChatStore.setState({
      selectedWorktree: null,
      worktreeChats: {
        'workspace-1/worktree-1': {
          tabs: [{ id: 'chat-w', title: 'Chat' }],
          activeTabId: 'chat-w',
        },
      },
      selectWorktree,
      loadTabsForTarget,
      switchTab,
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        appAdvisor: { openWindow },
        chat: { loadTabs, loadArchives },
        workEntries: { resolveChat },
        standaloneChat: { list: listStandaloneChats },
      },
    });
  });

  it('preflights a removed worktree as unavailable without loading its chat', async () => {
    useProjectsStore.setState({ projects: [] });

    await expect(
      resolveAvailableAutomationRunDestination({
        kind: 'worktree-chat',
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-w',
      }),
    ).resolves.toEqual({
      kind: 'none',
      reason: 'That chat is no longer available.',
    });
    expect(loadTabs).not.toHaveBeenCalled();
  });

  it('preflights a deleted App Advisor chat as unavailable', async () => {
    jest.useFakeTimers();
    resolveChat.mockResolvedValue({
      entryId: null,
      archivedInEntryId: null,
    });

    try {
      const result = resolveAvailableAutomationRunDestination({
        kind: 'app-advisor-chat',
        chatId: 'deleted-chat',
      });
      await jest.advanceTimersByTimeAsync(1_000);
      await expect(result).resolves.toEqual({
        kind: 'none',
        reason: 'That chat is no longer available.',
      });
      expect(openWindow).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('preflights a deleted bare pipeline execution as unavailable', async () => {
    loadExecutionDetails.mockResolvedValueOnce(null);

    await expect(
      resolveAvailableAutomationRunDestination({
        kind: 'pipeline-execution',
        executionId: 'deleted-execution',
      }),
    ).resolves.toEqual({
      kind: 'none',
      reason: 'That pipeline execution is no longer available.',
    });
    expect(loadExecutionDetails).toHaveBeenCalledWith('deleted-execution');
  });

  it('rechecks an App Advisor chat while its quick prompt is still materializing', async () => {
    jest.useFakeTimers();
    resolveChat
      .mockResolvedValueOnce({
        entryId: null,
        archivedInEntryId: null,
      })
      .mockResolvedValueOnce({
        entryId: 'entry-late',
        archivedInEntryId: null,
      });

    const destination = {
      kind: 'app-advisor-chat' as const,
      chatId: 'late-chat',
      userMessageId: 'late-message',
    };
    try {
      const result = resolveAvailableAutomationRunDestination(destination);
      await jest.advanceTimersByTimeAsync(250);
      await expect(result).resolves.toEqual(destination);
      expect(resolveChat).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('raises a pending turn focus after switching to a worktree chat', async () => {
    const result = await openAutomationRunDestination({
      kind: 'worktree-chat',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-w',
      userMessageId: 'msg-9',
    });

    expect(result).toEqual({ ok: true });
    expect(navigate).toHaveBeenCalledWith('main');
    expect(switchTab).toHaveBeenCalledWith('chat-w', {
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
    });
    expect(useNavigationStore.getState().pendingChatTurnFocus).toMatchObject({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-w',
      userMessageId: 'msg-9',
    });
  });

  it('refuses to navigate when the worktree is gone', async () => {
    useProjectsStore.setState({ projects: [] });

    const result = await openAutomationRunDestination({
      kind: 'worktree-chat',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-w',
    });

    expect(result).toEqual({
      ok: false,
      error: 'That chat is no longer available.',
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('opens the requested Activity chat before selecting its worktree can acknowledge another tab', async () => {
    const key = 'workspace-1/worktree-1';
    useChatStore.setState({
      worktreeChats: {
        [key]: {
          tabs: [
            { id: 'unseen-chat', title: 'Unseen', unread: true },
            { id: 'chat-w', title: 'Requested', unread: true },
          ],
          activeTabId: 'unseen-chat',
        },
      },
    });
    const acknowledged: string[] = [];
    selectWorktree.mockImplementationOnce(() => {
      acknowledged.push(useChatStore.getState().worktreeChats[key].activeTabId);
    });
    switchTab.mockImplementationOnce((chatId: string) => {
      const scope = useChatStore.getState().worktreeChats[key];
      useChatStore.setState({
        worktreeChats: { [key]: { ...scope, activeTabId: chatId } },
      });
    });

    await expect(
      openAutomationRunDestination({
        kind: 'worktree-chat',
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-w',
      }),
    ).resolves.toEqual({ ok: true });
    expect(acknowledged).toEqual(['chat-w']);
  });

  it.each(['deleted', 'load-failed'])(
    'keeps the current destination when an Activity target is %s',
    async (failure) => {
      if (failure === 'load-failed') {
        loadTabsForTarget.mockRejectedValueOnce(new Error('Unavailable'));
      }

      await expect(
        openAutomationRunDestination({
          kind: 'worktree-chat',
          projectId: 'workspace-1',
          worktreeId: 'worktree-1',
          chatId: 'deleted-chat',
        }),
      ).resolves.toEqual({
        ok: false,
        error: 'That chat is no longer available.',
      });
      expect(selectWorktree).not.toHaveBeenCalled();
      expect(switchTab).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    },
  );

  it('forwards the turn id across the App Advisor window boundary', async () => {
    const result = await openAutomationRunDestination({
      kind: 'app-advisor-chat',
      chatId: 'chat-a',
      userMessageId: 'msg-1',
    });

    expect(result).toEqual({ ok: true });
    expect(openWindow).toHaveBeenCalledWith({
      chatId: 'chat-a',
      focus: true,
      userMessageId: 'msg-1',
    });
  });

  it('forwards a delegate target across the App Advisor window boundary', async () => {
    const result = await openAutomationRunDestination(
      Object.assign(
        { kind: 'app-advisor-chat' as const, chatId: 'chat-a' },
        { delegationId: 'delegate-a' },
      ),
    );
    expect(result).toEqual({ ok: true });
    expect(openWindow).toHaveBeenCalledWith({
      chatId: 'chat-a',
      focus: true,
      delegationId: 'delegate-a',
    });
  });

  it('selects the cowork chat and navigates to the chat page', async () => {
    const switchChatProject = jest.fn().mockResolvedValue(true);
    const selectChat = jest.fn().mockResolvedValue(true);
    useProjectsStore.setState({
      projects: [{ id: 'cowork-1', name: 'Notes', type: 'cowork' }],
    });
    useStandaloneChatStore.setState({ switchChatProject, selectChat });

    const result = await openAutomationRunDestination({
      kind: 'cowork-chat',
      workspaceId: 'cowork-1',
      chatId: 'chat-c',
      userMessageId: 'msg-3',
    });

    expect(result).toEqual({ ok: true });
    expect(switchChatProject).toHaveBeenCalledWith('cowork-1');
    expect(selectChat).toHaveBeenCalledWith('chat-c');
    expect(navigate).toHaveBeenCalledWith('chat');
    expect(useNavigationStore.getState().pendingChatTurnFocus).toMatchObject({
      projectId: 'cowork-1',
      chatId: 'chat-c',
      userMessageId: 'msg-3',
    });
  });

  it('routes a cowork existing-chat run through the cowork opener', async () => {
    // A cowork `worktree_session_prompt` run result is the same
    // `{ projectId, worktreeId, chatId }` triple a code worktree produces —
    // the Work Entry id sits in the `worktreeId` slot — so the pure mapper
    // reads it as a worktree chat. Cowork workspaces have no worktrees, so
    // without the reroute this fails closed on every run.
    const switchChatProject = jest.fn().mockResolvedValue(true);
    const selectChat = jest.fn().mockResolvedValue(true);
    useProjectsStore.setState({
      projects: [{ id: 'cowork-1', name: 'Notes', type: 'cowork' }],
    });
    useStandaloneChatStore.setState({ switchChatProject, selectChat });

    const destination = resolveAutomationRunDestination(
      makeRun({
        result: {
          chatId: 'chat-c',
          projectId: 'cowork-1',
          worktreeId: 'entry-1',
          userMessageId: 'msg-7',
        },
      }),
    );
    expect(destination).toMatchObject({ kind: 'worktree-chat' });

    await expect(
      resolveAvailableAutomationRunDestination(destination),
    ).resolves.toEqual({
      kind: 'cowork-chat',
      workspaceId: 'cowork-1',
      chatId: 'chat-c',
      userMessageId: 'msg-7',
    });

    await expect(openAutomationRunDestination(destination)).resolves.toEqual({
      ok: true,
    });
    expect(switchChatProject).toHaveBeenCalledWith('cowork-1');
    expect(selectChat).toHaveBeenCalledWith('chat-c');
  });

  it('refuses cowork navigation when the workspace switch is superseded', async () => {
    const switchChatProject = jest.fn().mockResolvedValue(false);
    const selectChat = jest.fn().mockResolvedValue(true);
    useProjectsStore.setState({
      projects: [{ id: 'cowork-1', name: 'Notes', type: 'cowork' }],
    });
    useStandaloneChatStore.setState({ switchChatProject, selectChat });

    await expect(
      openAutomationRunDestination({
        kind: 'cowork-chat',
        workspaceId: 'cowork-1',
        chatId: 'chat-c',
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'That chat is no longer available.',
    });
    expect(selectChat).not.toHaveBeenCalled();
  });

  it('refuses cowork navigation when the requested chat is not selected', async () => {
    const switchChatProject = jest.fn().mockResolvedValue(true);
    const selectChat = jest.fn().mockResolvedValue(false);
    useProjectsStore.setState({
      projects: [{ id: 'cowork-1', name: 'Notes', type: 'cowork' }],
    });
    useStandaloneChatStore.setState({ switchChatProject, selectChat });

    await expect(
      openAutomationRunDestination({
        kind: 'cowork-chat',
        workspaceId: 'cowork-1',
        chatId: 'chat-c',
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'That chat is no longer available.',
    });
  });

  it('opens a bare pipeline execution through the opener without an owner hint', async () => {
    const result = await openAutomationRunDestination({
      kind: 'pipeline-execution',
      executionId: 'exec-2',
    });

    expect(result).toEqual({ ok: true });
    expect(openPipelineExecutionPanel).toHaveBeenCalledWith({
      executionId: 'exec-2',
    });
    expect(selectWorktree).not.toHaveBeenCalled();
  });

  it('opens a worktree pipeline through the opener with its owner as a hint', async () => {
    const result = await openAutomationRunDestination({
      kind: 'pipeline-execution',
      executionId: 'exec-1',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
    });

    expect(result).toEqual({ ok: true });
    expect(openPipelineExecutionPanel).toHaveBeenCalledWith({
      executionId: 'exec-1',
      owner: { projectId: 'workspace-1', worktreeId: 'worktree-1' },
    });
    // Navigation is the opener's; nothing is selected here.
    expect(selectWorktree).not.toHaveBeenCalled();
  });

  it('opens a Cowork pipeline run in its real Work Entry', async () => {
    const result = await openAutomationRunDestination({
      kind: 'pipeline-execution',
      executionId: 'exec-3',
      projectId: 'cowork-1',
      worktreeId: 'entry-4',
    });

    expect(result).toEqual({ ok: true });
    expect(openPipelineExecutionPanel).toHaveBeenCalledWith({
      executionId: 'exec-3',
      owner: { projectId: 'cowork-1', worktreeId: 'entry-4' },
    });
  });

  it('opens a pipeline at its job when the destination names one', async () => {
    await expect(
      openAutomationRunDestination({
        kind: 'pipeline-execution',
        executionId: 'exec-1',
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        jobId: 'review',
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      openAutomationRunDestination({
        kind: 'pipeline-execution',
        executionId: 'exec-2',
        jobId: 'build__2',
      }),
    ).resolves.toEqual({ ok: true });

    expect(openPipelineExecutionPanel.mock.calls).toEqual([
      [
        {
          executionId: 'exec-1',
          owner: { projectId: 'workspace-1', worktreeId: 'worktree-1' },
          target: { jobId: 'review' },
        },
      ],
      [{ executionId: 'exec-2', target: { jobId: 'build__2' } }],
    ]);
  });

  it('treats an ownerless run shown in the compatibility view as opened', async () => {
    openPipelineExecutionPanel.mockResolvedValueOnce({
      status: 'ownerless',
      executionId: 'exec-5',
      reason: 'no-owner',
    });

    await expect(
      openAutomationRunDestination({
        kind: 'pipeline-execution',
        executionId: 'exec-5',
        projectId: 'cowork-1',
      }),
    ).resolves.toEqual({ ok: true });
    // A project-only result (Cowork pipeline automation) is not an owner.
    expect(openPipelineExecutionPanel).toHaveBeenCalledWith({
      executionId: 'exec-5',
    });
  });

  it.each(['not_found', 'owner_missing'] as const)(
    'reports a run the opener could not find (%s) as unavailable',
    async (code) => {
      openPipelineExecutionPanel.mockResolvedValueOnce({
        status: 'error',
        code,
        message: 'ignored',
      });

      await expect(
        openAutomationRunDestination({
          kind: 'pipeline-execution',
          executionId: 'deleted-after-preflight',
          projectId: 'workspace-1',
          worktreeId: 'worktree-1',
        }),
      ).resolves.toEqual({
        ok: false,
        error: 'That pipeline execution is no longer available.',
      });
    },
  );

  it('keeps the opener message for other failures', async () => {
    openPipelineExecutionPanel.mockResolvedValueOnce({
      status: 'error',
      code: 'navigation_failed',
      message: "Couldn't open the run. Try again.",
    });

    await expect(
      openAutomationRunDestination({
        kind: 'pipeline-execution',
        executionId: 'exec-1',
      }),
    ).resolves.toEqual({
      ok: false,
      error: "Couldn't open the run. Try again.",
    });
  });

  it('preflights a Cowork pipeline owner without requiring a worktree', async () => {
    useProjectsStore.setState({
      projects: [{ id: 'cowork-1', name: 'Notes', type: 'cowork' }],
    });

    await expect(
      resolveAvailableAutomationRunDestination({
        kind: 'pipeline-execution',
        executionId: 'exec-3',
        projectId: 'cowork-1',
        worktreeId: 'entry-4',
      }),
    ).resolves.toEqual({
      kind: 'pipeline-execution',
      executionId: 'exec-3',
      projectId: 'cowork-1',
      worktreeId: 'entry-4',
    });
  });

  it('preflights a removed Code worktree as unavailable', async () => {
    useProjectsStore.setState({ projects: [] });

    await expect(
      resolveAvailableAutomationRunDestination({
        kind: 'pipeline-execution',
        executionId: 'exec-1',
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
      }),
    ).resolves.toEqual({
      kind: 'none',
      reason: 'That pipeline execution is no longer available.',
    });
  });

  it('surfaces the unavailable reason instead of navigating', async () => {
    const result = await openAutomationRunDestination({
      kind: 'none',
      reason: 'Still running.',
    });

    expect(result).toEqual({ ok: false, error: 'Still running.' });
    expect(navigate).not.toHaveBeenCalled();
  });
});
