const updateWorkspaceWorktreeMock = jest.fn<
  Promise<boolean>,
  [string, string, (worktree: WorktreeDataForTest) => WorktreeDataForTest]
>();
const readChatTabsFileMock = jest.fn();
const isWorkEntryWorkspaceMock = jest.fn(() => false);

jest.mock('../lib/workspace-persistence', () => ({
  get updateWorkspaceWorktree(): typeof updateWorkspaceWorktreeMock {
    return updateWorkspaceWorktreeMock;
  },
}));

jest.mock('../lib/chat-tabs-reader', () => ({
  get readChatTabsFile(): typeof readChatTabsFileMock {
    return readChatTabsFileMock;
  },
}));

jest.mock('../lib/workspace-registry', () => ({
  get isWorkEntryWorkspace(): typeof isWorkEntryWorkspaceMock {
    return isWorkEntryWorkspaceMock;
  },
}));

import type {
  ChatTabsFile,
  PersistedChatTab,
  SidebarItem,
  WorktreeData,
} from '@canopy/desktop-shared/types';

// Alias for the hoisted mock declaration above (type-only, erased at runtime).
type WorktreeDataForTest = WorktreeData;
import {
  backfillMissingWorktreeChatBadges,
  deriveWorktreeChatBadgesSummary,
  syncWorktreeChatBadgesFromWrite,
} from '../lib/chat-badge-sync';
import { chatBadgesSummariesEquivalent } from '../lib/worktree-observer-records';

function makeTab(
  id: string,
  overrides: Partial<PersistedChatTab> = {},
): PersistedChatTab {
  return {
    id,
    title: `Chat ${id}`,
    createdAt: '2026-07-17T00:00:00.000Z',
    messages: [
      {
        id: 'assistant-1',
        role: 'assistant',
        timestamp: 1000,
        blocks: [{ type: 'text', text: '  The   answer\nis 42.  ' }],
      },
    ],
    providerType: 'claude',
    ...overrides,
  };
}

function makeFile(tabs: PersistedChatTab[]): ChatTabsFile {
  return { version: 1, tabs, activeTabId: tabs[0]?.id ?? '' };
}

describe('deriveWorktreeChatBadgesSummary', () => {
  it('names badge chat references and the derived worktree after the custom title', () => {
    const summary = deriveWorktreeChatBadgesSummary(
      makeFile([
        makeTab('chat-1', {
          customTitle: 'My chat',
          description: 'Generated',
          unread: true,
        }),
      ]),
    );
    expect(summary.chatName).toBe('My chat');
    expect(summary.unreadChats[0]?.title).toBe('My chat');
  });
  beforeEach(() => {
    jest.clearAllMocks();
    isWorkEntryWorkspaceMock.mockReturnValue(false);
  });

  it('collects unread and approval chats with normalized previews', () => {
    const summary = deriveWorktreeChatBadgesSummary(
      makeFile([
        makeTab('read'),
        makeTab('unread', { unread: true }),
        makeTab('approval', { pendingPlanExit: { chatId: 'approval' } }),
        makeTab('file-tab', { kind: 'file', unread: true, messages: [] }),
      ]),
      () => '2026-07-17T12:00:00.000Z',
    );

    expect(summary.unreadChats).toEqual([
      {
        chatId: 'unread',
        title: 'Chat unread',
        providerType: 'claude',
        preview: 'The answer is 42.',
      },
    ]);
    expect(summary.approvalChats).toEqual([
      { chatId: 'approval', title: 'Chat approval', providerType: 'claude' },
    ]);
    expect(summary.needsHydration).toBe(true);
    expect(summary.updatedAt).toBe('2026-07-17T12:00:00.000Z');
  });

  it('flags manually unread chats only while they are unread', () => {
    const summary = deriveWorktreeChatBadgesSummary(
      makeFile([
        makeTab('manual', { unread: true, unreadMarkedManually: true }),
        makeTab('automatic', { unread: true }),
        makeTab('stale', { unread: false, unreadMarkedManually: true }),
      ]),
    );
    expect(
      summary.unreadChats.map(({ chatId, markedUnread }) => ({
        chatId,
        markedUnread,
      })),
    ).toEqual([
      { chatId: 'manual', markedUnread: true },
      { chatId: 'automatic', markedUnread: undefined },
    ]);
  });

  it('names the worktree after its first chat', () => {
    const summary = deriveWorktreeChatBadgesSummary(
      makeFile([
        makeTab('later', { createdAt: '2026-07-18T00:00:00.000Z' }),
        makeTab('first', { description: 'Fix the sidebar toggle' }),
      ]),
    );
    expect(summary.version).toBe(2);
    expect(summary.chatName).toBe('Fix the sidebar toggle');

    const unnamed = deriveWorktreeChatBadgesSummary(
      makeFile([makeTab('a', { title: 'New chat' })]),
    );
    expect(unnamed.chatName).toBeUndefined();
  });

  it('marks needsHydration for scheduled sends, plan reviews, questions, and approvals', () => {
    const scheduled = deriveWorktreeChatBadgesSummary(
      makeFile([
        makeTab('a', { scheduledSendDraft: { runAt: '2099-01-01T00:00:00Z' } }),
      ]),
    );
    expect(scheduled.needsHydration).toBe(true);

    const planReview = deriveWorktreeChatBadgesSummary(
      makeFile([makeTab('a', { trackedPlanReviewStatus: 'pending' })]),
    );
    expect(planReview.needsHydration).toBe(true);

    const questions = deriveWorktreeChatBadgesSummary({
      ...makeFile([makeTab('a')]),
      pendingQuestions: [
        {
          requestId: 'r1',
          chatId: 'a',
          questions: [],
        },
      ],
    });
    expect(questions.needsHydration).toBe(true);

    const approvals = deriveWorktreeChatBadgesSummary({
      ...makeFile([makeTab('a')]),
      pendingApprovals: [
        {
          requestId: 'r1',
          chatId: 'a',
          event: {
            requestId: 'r1',
            projectId: 'p1',
            worktreeId: 'w1',
            chatId: 'a',
            provider: 'claude',
            title: 'Run tests',
            details: { kind: 'command', command: 'npm test' },
          },
        },
      ],
    });
    expect(approvals.needsHydration).toBe(true);

    const idle = deriveWorktreeChatBadgesSummary(makeFile([makeTab('a')]));
    expect(idle.needsHydration).toBe(false);
    expect(idle.unreadChats).toEqual([]);
  });
});

describe('chatBadgesSummariesEquivalent', () => {
  it('treats an absent summary as equivalent to an empty one', () => {
    // An untitled chat contributes no badge and no chat name.
    const empty = deriveWorktreeChatBadgesSummary(
      makeFile([makeTab('a', { title: 'New chat' })]),
    );
    expect(chatBadgesSummariesEquivalent(undefined, empty)).toBe(true);

    const withUnread = deriveWorktreeChatBadgesSummary(
      makeFile([makeTab('a', { unread: true })]),
    );
    expect(chatBadgesSummariesEquivalent(undefined, withUnread)).toBe(false);

    const named = deriveWorktreeChatBadgesSummary(
      makeFile([makeTab('a', { title: 'Add dark mode' })]),
    );
    expect(chatBadgesSummariesEquivalent(undefined, named)).toBe(false);
  });

  it('treats a renamed chat or an older summary version as a change', () => {
    const before = deriveWorktreeChatBadgesSummary(
      makeFile([makeTab('a', { title: 'Add dark mode' })]),
    );
    const renamed = deriveWorktreeChatBadgesSummary(
      makeFile([makeTab('a', { title: 'Add a dark theme' })]),
    );
    expect(chatBadgesSummariesEquivalent(before, renamed)).toBe(false);
    expect(
      chatBadgesSummariesEquivalent({ ...before, version: 1 }, before),
    ).toBe(false);
  });

  it('treats a manual unread mark replacing an automatic one as a change', () => {
    const automatic = deriveWorktreeChatBadgesSummary(
      makeFile([makeTab('a', { unread: true })]),
    );
    const manual = deriveWorktreeChatBadgesSummary(
      makeFile([makeTab('a', { unread: true, unreadMarkedManually: true })]),
    );
    expect(chatBadgesSummariesEquivalent(automatic, manual)).toBe(false);
  });

  it('ignores updatedAt but compares badge content', () => {
    const left = deriveWorktreeChatBadgesSummary(
      makeFile([makeTab('a', { unread: true })]),
      () => '2026-07-17T00:00:00.000Z',
    );
    const right = deriveWorktreeChatBadgesSummary(
      makeFile([makeTab('a', { unread: true })]),
      () => '2026-07-17T09:00:00.000Z',
    );
    expect(chatBadgesSummariesEquivalent(left, right)).toBe(true);
  });
});

describe('syncWorktreeChatBadgesFromWrite', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isWorkEntryWorkspaceMock.mockReturnValue(false);
    updateWorkspaceWorktreeMock.mockResolvedValue(true);
  });

  it('updates the worktree entry when badges changed', () => {
    void syncWorktreeChatBadgesFromWrite(
      'project-a',
      'wt-a',
      makeFile([makeTab('a', { unread: true })]),
    );
    expect(updateWorkspaceWorktreeMock).toHaveBeenCalledWith(
      'project-a',
      'wt-a',
      expect.any(Function),
    );
    const updater = updateWorkspaceWorktreeMock.mock.calls[0]?.[2];
    if (!updater) {
      throw new Error('Expected updater callback');
    }
    const previous: WorktreeData = {
      id: 'wt-a',
      branchName: 'b',
      createdAt: 'c',
    };
    const updated = updater(previous);
    expect(updated).not.toBe(previous);
    expect(updated.chatBadges?.unreadChats).toHaveLength(1);

    // Re-running with equivalent badges returns the same object (no write).
    const again = updater(updated);
    expect(again).toBe(updated);
  });

  it('skips Work Entry projects entirely', () => {
    isWorkEntryWorkspaceMock.mockReturnValue(true);
    void syncWorktreeChatBadgesFromWrite(
      'cowork-default',
      'home',
      makeFile([makeTab('a', { unread: true })]),
    );
    expect(updateWorkspaceWorktreeMock).not.toHaveBeenCalled();
  });

  it('rejects a transient write failure so the projection retries it', async () => {
    updateWorkspaceWorktreeMock.mockRejectedValueOnce(
      new Error('EIO: i/o error'),
    );
    await expect(
      syncWorktreeChatBadgesFromWrite(
        'project-a',
        'wt-a',
        makeFile([makeTab('a', { unread: true })]),
      ),
    ).rejects.toThrow('EIO');
  });

  it('settles for a target that can never record badges', async () => {
    await expect(
      syncWorktreeChatBadgesFromWrite(
        'project-a',
        'Not A Worktree',
        makeFile([makeTab('a', { unread: true })]),
      ),
    ).resolves.toBeUndefined();
    expect(updateWorkspaceWorktreeMock).not.toHaveBeenCalled();
  });
});

describe('backfillMissingWorktreeChatBadges', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isWorkEntryWorkspaceMock.mockReturnValue(false);
    updateWorkspaceWorktreeMock.mockResolvedValue(true);
  });

  it('derives badges only for worktrees missing the current summary', async () => {
    readChatTabsFileMock.mockResolvedValue(
      makeFile([makeTab('a', { unread: true })]),
    );
    const items: SidebarItem[] = [
      {
        type: 'single-repo',
        id: 'project-a',
        name: 'Project',
        repoPath: '/repo',
        color: '#000',
        collapsed: false,
        order: 0,
        worktrees: [
          { id: 'legacy', branchName: 'b', createdAt: 'c' },
          {
            id: 'current',
            branchName: 'b',
            createdAt: 'c',
            chatBadges: {
              version: 2,
              unreadChats: [],
              approvalChats: [],
              needsHydration: false,
              updatedAt: '2026-07-17T00:00:00.000Z',
            },
          },
        ],
      },
    ];

    await backfillMissingWorktreeChatBadges(items);

    expect(readChatTabsFileMock).toHaveBeenCalledTimes(1);
    expect(readChatTabsFileMock).toHaveBeenCalledWith('project-a', 'legacy');
    expect(updateWorkspaceWorktreeMock).toHaveBeenCalledTimes(1);
  });

  it('adds the chat name to an older summary without replacing its badges', async () => {
    readChatTabsFileMock.mockResolvedValue(
      makeFile([makeTab('a', { title: 'Add dark mode' })]),
    );
    const olderBadges: WorktreeData['chatBadges'] = {
      version: 1,
      unreadChats: [{ chatId: 'live-unread' }],
      approvalChats: [],
      needsHydration: false,
      updatedAt: '2026-07-17T00:00:00.000Z',
    };
    const items: SidebarItem[] = [
      {
        type: 'single-repo',
        id: 'project-a',
        name: 'Project',
        repoPath: '/repo',
        color: '#000',
        collapsed: false,
        order: 0,
        worktrees: [
          {
            id: 'older',
            branchName: 'b',
            createdAt: 'c',
            chatBadges: olderBadges,
          },
        ],
      },
    ];

    await backfillMissingWorktreeChatBadges(items);

    const updater = updateWorkspaceWorktreeMock.mock.calls[0]?.[2];
    if (!updater) {
      throw new Error('Expected updater callback');
    }
    const updated = updater({
      id: 'older',
      branchName: 'b',
      createdAt: 'c',
      chatBadges: olderBadges,
    });
    expect(updated.chatBadges).toEqual({
      ...olderBadges,
      version: 2,
      chatName: 'Add dark mode',
    });
  });
});
