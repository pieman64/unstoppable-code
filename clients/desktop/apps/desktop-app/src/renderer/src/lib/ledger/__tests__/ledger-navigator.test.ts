/**
 * @jest-environment jsdom
 */
const mockOpenDestination = jest.fn();
const mockOpenFileTab = jest.fn();
const mockSwitchTab = jest.fn();
const mockSelectWorktree = jest.fn();
const mockLoadTabsForTarget = jest.fn();
const mockNavigate = jest.fn();
const mockPresent = jest.fn();
const mockRevealChatPanel = jest.fn();
const mockOpenSubagentChatPanel = jest.fn();
let mockProjects: Array<{ id: string; type: string }> = [];

jest.mock('@/components/automations/resolveAutomationRunDestination', () => ({
  openAutomationRunDestination: (destination: unknown): unknown =>
    mockOpenDestination(destination),
}));
jest.mock('@/stores/chatStore', () => ({
  WORKTREE_CHAT_OPEN_ARCHIVE_TRANSCRIPT_EVENT:
    'canopy:worktree-chat-open-archive-transcript',
  useChatStore: {
    getState: (): unknown => ({
      openFileTab: mockOpenFileTab,
      switchTab: mockSwitchTab,
      selectWorktree: mockSelectWorktree,
      loadTabsForTarget: mockLoadTabsForTarget,
    }),
  },
}));
jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: {
    getState: (): unknown => ({ projects: mockProjects }),
  },
}));
jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: {
    getState: (): unknown => ({ navigate: mockNavigate }),
  },
}));
jest.mock('@/lib/chatPanelReveal', () => ({
  requestChatPanelReveal: (...args: unknown[]): unknown =>
    mockRevealChatPanel(...args),
}));
jest.mock('@/lib/panels/subagent-panel-open', () => ({
  openSubagentChatPanel: (...args: unknown[]): unknown =>
    mockOpenSubagentChatPanel(...args),
}));
jest.mock('@/stores/agentFilePresentationStore', () => ({
  useAgentFilePresentationStore: {
    getState: (): unknown => ({ present: mockPresent }),
  },
}));

import type { LedgerViewScope } from '@canopy/protocol/ledger-view';
import { DESKTOP_LEDGER_NAVIGATOR } from '../ledger-navigator';

const SCOPE: LedgerViewScope = { projectId: 'project-1', worktreeId: 'wt-1' };
const mockGetFileTreeRoots = jest.fn();
const mockReadFileContent = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  mockProjects = [];
  mockOpenDestination.mockResolvedValue({ ok: true });
  mockOpenSubagentChatPanel.mockResolvedValue({ status: 'placed' });
  Reflect.set(window, 'api', {
    getFileTreeRoots: mockGetFileTreeRoots,
    readFileContent: mockReadFileContent,
  });
  mockGetFileTreeRoots.mockResolvedValue({
    roots: [
      {
        repoId: 'repo-1',
        repoName: 'Repo',
        absolutePath: '/work/repo',
        rootKind: 'repo',
      },
    ],
  });
  mockReadFileContent.mockResolvedValue({ kind: 'text', filename: 'a.ts' });
  mockOpenFileTab.mockReturnValue('file-tab-1');
});

describe('DESKTOP_LEDGER_NAVIGATOR.openSource', () => {
  it('opens a worktree chat, a Cowork chat and an App Advisor chat through the shared navigation', async () => {
    mockProjects = [{ id: 'cowork-1', type: 'cowork' }];
    const chat = {
      kind: 'chat',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      archived: false,
    } as const;

    await DESKTOP_LEDGER_NAVIGATOR.openSource(SCOPE, {
      ...chat,
      projectId: 'project-1',
    });
    await DESKTOP_LEDGER_NAVIGATOR.openSource(SCOPE, {
      ...chat,
      projectId: 'cowork-1',
    });
    await DESKTOP_LEDGER_NAVIGATOR.openSource(SCOPE, {
      ...chat,
      projectId: 'app-advisor',
    });

    expect(mockOpenDestination.mock.calls).toEqual([
      [
        {
          kind: 'worktree-chat',
          projectId: 'project-1',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
        },
      ],
      [{ kind: 'cowork-chat', workspaceId: 'cowork-1', chatId: 'chat-1' }],
      [{ kind: 'app-advisor-chat', chatId: 'chat-1' }],
    ]);
    // The chat's panel is shown even when it was already the active chat.
    expect(mockRevealChatPanel.mock.calls).toEqual([
      ['project-1', 'wt-1', 'chat-1'],
      ['cowork-1', 'wt-1', 'chat-1'],
    ]);
  });

  it('routes an App Advisor delegate to its owning renderer', async () => {
    await expect(
      DESKTOP_LEDGER_NAVIGATOR.openSource(SCOPE, {
        kind: 'chat',
        projectId: 'app-advisor',
        worktreeId: 'entry-1',
        chatId: 'chat-1',
        archived: false,
        delegationId: 'delegation-1',
      }),
    ).resolves.toEqual({ ok: true });
    expect(mockOpenDestination).toHaveBeenCalledWith({
      kind: 'app-advisor-chat',
      chatId: 'chat-1',
      delegationId: 'delegation-1',
    });
    expect(mockOpenSubagentChatPanel).not.toHaveBeenCalled();
    expect(mockRevealChatPanel).not.toHaveBeenCalled();
  });

  it("opens a delegate's own subagent chat beside the chat that started it", async () => {
    const result = await DESKTOP_LEDGER_NAVIGATOR.openSource(SCOPE, {
      kind: 'chat',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      archived: false,
      delegationId: 'delegation-1',
    });

    expect(result).toEqual({ ok: true });
    // The chat that started it is found first, so its worktree is showing.
    expect(mockOpenDestination).toHaveBeenCalledWith({
      kind: 'worktree-chat',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
    });
    expect(mockOpenSubagentChatPanel.mock.calls).toEqual([
      [
        { projectId: 'project-1', worktreeId: 'wt-1' },
        {
          rootChatId: 'chat-1',
          subagentId: 'delegation-1',
          subagentKind: 'managed',
          title: '',
        },
      ],
    ]);
    // The subagent chat shows, not the chat that started it.
    expect(mockRevealChatPanel).not.toHaveBeenCalled();
  });

  it('shows the chat that started a delegate when no group takes its subagent chat', async () => {
    mockOpenSubagentChatPanel.mockResolvedValue({ status: 'failed' });

    const result = await DESKTOP_LEDGER_NAVIGATOR.openSource(SCOPE, {
      kind: 'chat',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      archived: false,
      delegationId: 'delegation-1',
    });

    expect(result).toEqual({ ok: true });
    expect(mockRevealChatPanel.mock.calls).toEqual([
      ['project-1', 'wt-1', 'chat-1'],
    ]);
  });

  it('opens no subagent chat when the chat that started the delegate is gone or archived', async () => {
    mockOpenDestination.mockResolvedValue({ ok: false, error: 'Gone.' });
    await expect(
      DESKTOP_LEDGER_NAVIGATOR.openSource(SCOPE, {
        kind: 'chat',
        projectId: 'project-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        archived: false,
        delegationId: 'delegation-1',
      }),
    ).resolves.toEqual({ ok: false, message: 'Gone.' });

    // An archived parent opens in the archive viewer instead.
    mockLoadTabsForTarget.mockResolvedValue(undefined);
    await expect(
      DESKTOP_LEDGER_NAVIGATOR.openSource(SCOPE, {
        kind: 'chat',
        projectId: 'project-1',
        worktreeId: 'wt-1',
        chatId: 'chat-old',
        archived: true,
        delegationId: 'delegation-1',
      }),
    ).resolves.toEqual({ ok: true });
    expect(mockSelectWorktree).toHaveBeenCalledWith('project-1', 'wt-1');
    expect(mockOpenSubagentChatPanel).not.toHaveBeenCalled();
  });

  it('opens an archived worktree chat in the read-only archive viewer', async () => {
    const opened: unknown[] = [];
    const listener = (event: Event): void => {
      if (event instanceof CustomEvent) opened.push(event.detail);
    };
    window.addEventListener(
      'canopy:worktree-chat-open-archive-transcript',
      listener,
    );
    jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback): number => {
        callback(0);
        return 0;
      });

    const result = await DESKTOP_LEDGER_NAVIGATOR.openSource(SCOPE, {
      kind: 'chat',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-old',
      archived: true,
    });
    window.removeEventListener(
      'canopy:worktree-chat-open-archive-transcript',
      listener,
    );

    expect(result).toEqual({ ok: true });
    expect(mockOpenDestination).not.toHaveBeenCalled();
    expect(mockSelectWorktree).toHaveBeenCalledWith('project-1', 'wt-1');
    expect(opened).toEqual([
      { projectId: 'project-1', worktreeId: 'wt-1', chatId: 'chat-old' },
    ]);
  });

  it('opens a pipeline run at its job, and passes on why a source cannot open', async () => {
    mockOpenDestination.mockResolvedValue({
      ok: false,
      error: 'That pipeline execution is no longer available.',
    });

    const result = await DESKTOP_LEDGER_NAVIGATOR.openSource(SCOPE, {
      kind: 'pipeline',
      projectId: 'project-1',
      worktreeId: 'wt-run',
      executionId: 'execution-1',
      jobId: 'build__1',
    });

    expect(mockOpenDestination).toHaveBeenCalledWith({
      kind: 'pipeline-execution',
      executionId: 'execution-1',
      projectId: 'project-1',
      worktreeId: 'wt-run',
      jobId: 'build__1',
    });
    expect(result).toEqual({
      ok: false,
      message: 'That pipeline execution is no longer available.',
    });
  });

  it('opens nothing for a Summary snapshot, which shows in the entry', async () => {
    await expect(
      DESKTOP_LEDGER_NAVIGATOR.openSource(SCOPE, {
        kind: 'summary',
        snapshot: {
          title: 'Summary',
          description: 'Done.',
          highlights: [],
          generatedAt: '2026-09-30T10:00:00.000Z',
        },
      }),
    ).resolves.toEqual({ ok: true });
    expect(mockOpenDestination).not.toHaveBeenCalled();
  });
});

describe('DESKTOP_LEDGER_NAVIGATOR.openFile', () => {
  it('opens a reference file of the scope at its line', async () => {
    const result = await DESKTOP_LEDGER_NAVIGATOR.openFile(SCOPE, {
      rootId: 'repo-1',
      path: 'src/a.ts',
      startLine: 12,
    });

    expect(result).toEqual({ ok: true });
    expect(mockReadFileContent).toHaveBeenCalledWith({
      absolutePath: '/work/repo/src/a.ts',
      workspaceTarget: SCOPE,
    });
    expect(mockOpenFileTab).toHaveBeenCalledWith(
      { absolutePath: '/work/repo/src/a.ts', filename: 'a.ts' },
      SCOPE,
    );
    expect(mockPresent).toHaveBeenCalledWith('file-tab-1', { line: 12 });
    expect(mockSwitchTab).toHaveBeenCalledWith('file-tab-1', SCOPE);
    // The file shows in its worktree, so the Feed gives way to it first.
    expect(mockNavigate).toHaveBeenCalledWith('main');
    expect(mockSelectWorktree).toHaveBeenCalledWith(
      SCOPE.projectId,
      SCOPE.worktreeId,
    );
    expect(mockLoadTabsForTarget).toHaveBeenCalledWith(
      SCOPE.projectId,
      SCOPE.worktreeId,
    );
    const [loaded] = mockLoadTabsForTarget.mock.invocationCallOrder;
    const [opened] = mockOpenFileTab.mock.invocationCallOrder;
    expect(loaded).toBeLessThan(opened ?? 0);
  });

  it("says a file whose worktree's tabs cannot load cannot open", async () => {
    mockLoadTabsForTarget.mockRejectedValueOnce(new Error('gone'));

    await expect(
      DESKTOP_LEDGER_NAVIGATOR.openFile(SCOPE, {
        rootId: 'repo-1',
        path: 'src/a.ts',
      }),
    ).resolves.toEqual({
      ok: false,
      message: "Couldn't open this file. It may have moved.",
    });
    expect(mockOpenFileTab).not.toHaveBeenCalled();
  });

  it('refuses a root the scope does not have, or a path that leaves the root', async () => {
    await expect(
      DESKTOP_LEDGER_NAVIGATOR.openFile(SCOPE, {
        rootId: 'repo-unknown',
        path: 'src/a.ts',
      }),
    ).resolves.toEqual({
      ok: false,
      message: "This file isn't in this project.",
    });
    await expect(
      DESKTOP_LEDGER_NAVIGATOR.openFile(SCOPE, {
        rootId: 'repo-1',
        path: '../outside.ts',
      }),
    ).resolves.toEqual({
      ok: false,
      message: "This file isn't in this project.",
    });
    expect(mockReadFileContent).not.toHaveBeenCalled();
  });

  it('says a file that no longer exists cannot open', async () => {
    mockReadFileContent.mockResolvedValue({
      kind: 'missing',
      filename: 'a.ts',
    });

    await expect(
      DESKTOP_LEDGER_NAVIGATOR.openFile(SCOPE, {
        rootId: 'repo-1',
        path: 'src/a.ts',
      }),
    ).resolves.toEqual({
      ok: false,
      message: "Couldn't open this file. It may have moved.",
    });
    expect(mockOpenFileTab).not.toHaveBeenCalled();
  });
});
