import type {
  ApprovalRequestEvent,
  SidebarItem,
  WorktreeChatBadgesSummary,
} from '@canopy/desktop-shared/types';
import type { ContinueAttentionItem } from '@canopy/ui-app';
import type {
  ChatTab,
  PendingQuestion,
  WorktreeChatState,
} from '@/stores/chat/types';
import {
  selectDesktopContinueAttention,
  createDesktopContinueAttentionSelector,
  type DesktopContinueAttentionChatState,
  type DesktopContinueAttentionContext,
} from '../continue-attention';

function makeTab(overrides: Partial<ChatTab> & { id: string }): ChatTab {
  return {
    title: `Chat ${overrides.id}`,
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-10-24T12:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    thinkingLevel: 'high',
    proposalMode: 'optional',
    modelConfig: {
      thinkingLevel: overrides.thinkingLevel ?? 'high',
      speed: 'standard',
      fastMode: false,
    },
    fastModeExplicit: false,
    ...overrides,
  };
}

function worktreeState(...tabs: ChatTab[]): WorktreeChatState {
  return { activeTabId: tabs[0]?.id ?? null, tabs };
}

const projects: SidebarItem[] = [
  {
    type: 'single-repo',
    id: 'ws',
    name: 'Workspace',
    repoPath: '/repo',
    color: '#000000',
    collapsed: false,
    order: 0,
    worktrees: [
      { id: 'a', branchName: 'feature/a', createdAt: '2026-10-24', label: 'A' },
      { id: 'b', branchName: 'feature/b', createdAt: '2026-10-24', label: 'B' },
      { id: 'c', branchName: 'feature/c', createdAt: '2026-10-24' },
      {
        id: 'hidden',
        branchName: 'feature/hidden',
        createdAt: '2026-10-24',
        hidden: true,
      },
    ],
  },
  {
    type: 'single-repo',
    id: 'other',
    name: 'Other context',
    repoPath: '/other',
    color: '#000000',
    collapsed: false,
    order: 1,
    worktrees: [{ id: 'x', branchName: 'feature/x', createdAt: '2026-10-24' }],
  },
  {
    type: 'cowork',
    id: 'cowork',
    name: 'Cowork',
    color: '#000000',
    collapsed: false,
    order: 2,
  },
];

const context: DesktopContinueAttentionContext = {
  projects,
  isInContext: (workspaceId) => workspaceId !== 'other',
  worktreeName: (worktree) => worktree.label ?? worktree.branchName,
};

function question(
  overrides: Partial<PendingQuestion> & { chatId: string; worktreeId: string },
): PendingQuestion {
  return {
    requestId: `q-${overrides.chatId}`,
    projectId: 'ws',
    questions: [],
    ...overrides,
  };
}

function approval(
  overrides: Partial<ApprovalRequestEvent> & {
    chatId: string;
    worktreeId: string;
  },
): ApprovalRequestEvent {
  return {
    requestId: `a-${overrides.chatId}`,
    projectId: 'ws',
    provider: 'claude',
    title: 'Run command',
    details: { kind: 'command', command: 'ls' },
    ...overrides,
  };
}

function chatState(
  overrides: Partial<DesktopContinueAttentionChatState>,
): DesktopContinueAttentionChatState {
  return {
    worktreeChats: {},
    unreadWorktreeKeys: new Set(),
    pendingQuestions: {},
    pendingApprovals: {},
    persistedWorktreeBadges: {},
    ...overrides,
  };
}

function describeRows(items: readonly ContinueAttentionItem[]): string[] {
  return items.map((item) =>
    item.target.kind === 'chat'
      ? `${item.kind}:${item.target.worktreeId}/${item.target.chatId}`
      : `${item.kind}:${item.target.worktreeId}`,
  );
}

describe('selectDesktopContinueAttention', () => {
  it('does not rebuild attention on token-only changes but observes every attention field', () => {
    const worktreeName = jest.fn(context.worktreeName);
    const select = createDesktopContinueAttentionSelector({
      ...context,
      worktreeName,
    });
    const before = chatState({
      worktreeChats: {
        'ws/a': worktreeState(makeTab({ id: 'a1', status: 'streaming' })),
      },
    });
    const first = select(before);
    worktreeName.mockClear();
    const stream = makeTab({
      id: 'a1',
      status: 'streaming',
      lastEventAt: 999,
      messages: [
        {
          id: 'm',
          role: 'assistant',
          timestamp: 999,
          blocks: [{ type: 'text', text: 'New token' }],
        },
      ],
    });
    const token = {
      ...before,
      worktreeChats: { 'ws/a': worktreeState(stream) },
    };
    expect(select(token)).toBe(first);
    expect(worktreeName).not.toHaveBeenCalled();
    const waiting = {
      ...token,
      pendingQuestions: { q: question({ chatId: 'a1', worktreeId: 'a' }) },
    };
    expect(describeRows(select(waiting))).toEqual(['question:a/a1']);
    expect(worktreeName).toHaveBeenCalled();
    const renamed = {
      ...waiting,
      worktreeChats: {
        'ws/a': worktreeState({ ...stream, customTitle: 'Renamed' }),
      },
    };
    expect(select(renamed)[0]?.chatTitle).toBe('Renamed');
    expect(
      select({
        ...renamed,
        pendingQuestions: {
          q: question({ chatId: 'a1', worktreeId: 'a', dismissedAt: 0 }),
        },
      }),
    ).toEqual([]);
  });
  it('does not infer completion from an idle unread tab (CAN-4958)', () => {
    const rows = selectDesktopContinueAttention(
      chatState({
        worktreeChats: {
          'ws/a': worktreeState(makeTab({ id: 'a1', unread: true })),
        },
        unreadWorktreeKeys: new Set(['ws/a']),
      }),
      context,
    );
    expect(rows[0]?.completed).not.toBe(true);
  });

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'uses canonical accepted-turn completion evidence: %s',
    (outcome) => {
      const rows = selectDesktopContinueAttention(
        chatState({
          worktreeChats: {
            'ws/a': worktreeState(
              makeTab({
                id: 'a1',
                unread: true,
                lastAcceptedUserMessageId: 'u',
                turnEnds: { u: { outcome, endedAt: 100 } },
              }),
            ),
          },
          unreadWorktreeKeys: new Set(['ws/a']),
        }),
        context,
      );
      expect(rows[0]?.completed).toBe(outcome === 'completed');
    },
  );

  it('ranks a pending question, approval, plan review, and unread results', () => {
    const rows = selectDesktopContinueAttention(
      chatState({
        worktreeChats: {
          'ws/a': worktreeState(makeTab({ id: 'a1' })),
          'ws/b': worktreeState(
            makeTab({ id: 'b1', lastEventAt: 5 }),
            makeTab({ id: 'b2' }),
          ),
          'ws/c': worktreeState(
            makeTab({
              id: 'c1',
              unread: true,
              lastEventAt: 10,
              lastAcceptedUserMessageId: 'u',
              turnEnds: { u: { outcome: 'completed', endedAt: 10 } },
            }),
            makeTab({
              id: 'c2',
              unread: true,
              lastEventAt: 20,
              lastAcceptedUserMessageId: 'u',
              turnEnds: { u: { outcome: 'completed', endedAt: 20 } },
            }),
            makeTab({
              id: 'c3',
              trackedPlanId: 'plan-1',
              trackedPlanReviewStatus: 'pending',
            }),
            makeTab({ id: 'c4', status: 'error', unread: true }),
          ),
        },
        unreadWorktreeKeys: new Set(['ws/c']),
        pendingQuestions: {
          'q-b1': question({ chatId: 'b1', worktreeId: 'b' }),
        },
        pendingApprovals: {
          'a-a1': approval({ chatId: 'a1', worktreeId: 'a' }),
        },
      }),
      context,
    );

    expect(describeRows(rows)).toEqual([
      'question:b/b1',
      'tool-approval:a/a1',
      'plan-review:c/c3',
      'unread:c/c2',
      'unread:c/c1',
      'unread:c/c4',
    ]);
    expect(rows[0]).toMatchObject({
      workspaceName: 'Workspace',
      worktreeName: 'B',
      chatTitle: 'Chat b1',
    });
    const errored = rows.find(
      (row) => row.target.kind === 'chat' && row.target.chatId === 'c4',
    );
    expect(rows[3]?.completed).toBe(true);
    expect(errored?.completed).toBe(false);
  });

  it('skips answered, dismissed, and orphaned questions', () => {
    const rows = selectDesktopContinueAttention(
      chatState({
        worktreeChats: {
          'ws/b': worktreeState(makeTab({ id: 'b1' })),
        },
        pendingQuestions: {
          answered: question({ chatId: 'b1', worktreeId: 'b', answeredAt: 1 }),
          dismissed: question({
            chatId: 'b1',
            worktreeId: 'b',
            dismissedAt: 0,
          }),
          orphan: question({ chatId: 'gone', worktreeId: 'b' }),
          unhydrated: question({ chatId: 'c1', worktreeId: 'c' }),
        },
      }),
      context,
    );

    expect(rows).toEqual([]);
  });

  it('excludes non-chat approvals and question-raised unread', () => {
    const rows = selectDesktopContinueAttention(
      chatState({
        worktreeChats: {
          'ws/a': worktreeState(
            makeTab({ id: 'a1', unread: true, unreadRaisedByQuestion: true }),
          ),
        },
        unreadWorktreeKeys: new Set(['ws/a']),
        pendingApprovals: {
          'a-a1': approval({
            chatId: 'a1',
            worktreeId: 'a',
            surface: 'non-chat',
          }),
        },
      }),
      context,
    );

    expect(rows).toEqual([]);
  });

  it('excludes hidden, out-of-context, cowork, and plan-explore worktrees', () => {
    const unread = (id: string): WorktreeChatState =>
      worktreeState(makeTab({ id, unread: true }));
    const rows = selectDesktopContinueAttention(
      chatState({
        worktreeChats: {
          'ws/hidden': unread('h1'),
          'other/x': unread('x1'),
          'cowork/home': unread('k1'),
          'plan-explore-chat/plan-1': unread('p1'),
        },
        unreadWorktreeKeys: new Set([
          'ws/hidden',
          'other/x',
          'cowork/home',
          'plan-explore-chat/plan-1',
        ]),
      }),
      context,
    );

    expect(rows).toEqual([]);
  });

  it('keeps one row per chat with its highest-priority kind', () => {
    const rows = selectDesktopContinueAttention(
      chatState({
        worktreeChats: {
          'ws/b': worktreeState(
            makeTab({ id: 'b1', unread: true, pendingPlanExit: undefined }),
          ),
        },
        unreadWorktreeKeys: new Set(['ws/b']),
        pendingQuestions: {
          'q-b1': question({ chatId: 'b1', worktreeId: 'b' }),
        },
        pendingApprovals: {
          'a-b1': approval({ chatId: 'b1', worktreeId: 'b' }),
        },
      }),
      context,
    );

    expect(describeRows(rows)).toEqual(['question:b/b1']);
  });

  it('uses a worktree fallback before hydration and replaces it atomically after', () => {
    const badges: WorktreeChatBadgesSummary = {
      version: 2,
      unreadChats: [{ chatId: 'c1', title: 'Persisted' }],
      approvalChats: [],
      needsHydration: false,
      updatedAt: '2026-10-24T12:00:00.000Z',
    };
    const before = selectDesktopContinueAttention(
      chatState({
        persistedWorktreeBadges: { 'ws/c': badges },
        unreadWorktreeKeys: new Set(['ws/c']),
      }),
      context,
    );

    expect(describeRows(before)).toEqual(['unread:c']);
    expect(before[0]).not.toHaveProperty('chatTitle');
    expect(before[0]?.target).not.toHaveProperty('chatId');

    const hydratedEmpty = selectDesktopContinueAttention(
      chatState({
        worktreeChats: { 'ws/c': worktreeState(makeTab({ id: 'c1' })) },
      }),
      context,
    );
    expect(hydratedEmpty).toEqual([]);

    const hydratedPopulated = selectDesktopContinueAttention(
      chatState({
        worktreeChats: {
          'ws/c': worktreeState(makeTab({ id: 'c1', unread: true })),
        },
        // A stale badge entry next to live tabs must not double count.
        persistedWorktreeBadges: { 'ws/c': badges },
        unreadWorktreeKeys: new Set(['ws/c']),
      }),
      context,
    );
    expect(describeRows(hydratedPopulated)).toEqual(['unread:c/c1']);
  });

  it('distinguishes the same chat id in different worktrees', () => {
    const rows = selectDesktopContinueAttention(
      chatState({
        worktreeChats: {
          'ws/a': worktreeState(makeTab({ id: 'same', unread: true })),
          'ws/b': worktreeState(makeTab({ id: 'same', unread: true })),
        },
        unreadWorktreeKeys: new Set(['ws/a', 'ws/b']),
      }),
      context,
    );

    expect(describeRows(rows)).toEqual(['unread:a/same', 'unread:b/same']);
  });

  it('falls back to a readable title for placeholder chat titles', () => {
    const rows = selectDesktopContinueAttention(
      chatState({
        worktreeChats: {
          'ws/a': worktreeState(
            makeTab({
              id: 'a1',
              title: 'New Chat',
              description: 'Fix the checkout flow',
              unread: true,
            }),
          ),
        },
        unreadWorktreeKeys: new Set(['ws/a']),
      }),
      context,
    );

    expect(rows[0]?.chatTitle).toBe('Fix the checkout flow');
  });
});
