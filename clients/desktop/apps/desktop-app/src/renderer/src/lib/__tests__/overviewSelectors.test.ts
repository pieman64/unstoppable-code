import type { ChatTab, WorktreeChatState } from '@/stores/chatStore';
import {
  selectInProgressChatCards,
  selectUnreadChatCards,
} from '../overviewSelectors';
import {
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  type SidebarItem,
} from '@canopy/desktop-shared/types';

function makeTab(overrides: Partial<ChatTab>): ChatTab {
  return {
    id: overrides.id ?? 'tab-1',
    title: overrides.title ?? 'Chat',
    description: overrides.description,
    messages: overrides.messages ?? [],
    status: overrides.status ?? 'idle',
    error: overrides.error ?? null,
    createdAt: overrides.createdAt ?? '2026-04-20T12:00:00.000Z',
    queuedMessages: overrides.queuedMessages ?? [],
    planMode: overrides.planMode ?? false,
    thinkingLevel: overrides.thinkingLevel ?? 'high',
    pendingPlanExit: overrides.pendingPlanExit,
    trackedPlanId: overrides.trackedPlanId,
    trackedPlanSource: overrides.trackedPlanSource,
    trackedPlanReviewStatus: overrides.trackedPlanReviewStatus,
    proposalMode: overrides.proposalMode ?? 'optional',
    unread: overrides.unread,
    lastEventAt: overrides.lastEventAt,
    attentionDismissedAt: overrides.attentionDismissedAt,
  };
}

const projects: SidebarItem[] = [
  {
    type: 'single-repo',
    id: 'project-1',
    name: 'Project One',
    repoPath: '/tmp/project-one',
    color: '#7C9B6D',
    collapsed: false,
    order: 0,
    worktrees: [
      {
        id: 'worktree-1',
        branchName: 'feature/worktree',
        createdAt: '2026-04-20T12:00:00.000Z',
      },
    ],
  },
];

describe('overviewSelectors', () => {
  it('shows unread chat cards for pending plan exits without tab unread', () => {
    const chatState: WorktreeChatState = {
      activeTabId: 'tab-1',
      tabs: [
        makeTab({
          id: 'tab-1',
          title: 'Plan review',
          pendingPlanExit: { plan: 'review' },
          lastEventAt: 42,
        }),
      ],
    };

    const cards = selectUnreadChatCards(
      { 'project-1/worktree-1': chatState },
      new Set(['project-1/worktree-1']),
      projects,
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]?.tabId).toBe('tab-1');
    expect(cards[0]?.tabTitle).toBe('Plan review');
  });

  it('shows unread chat cards for pending tracked plan reviews without tab unread', () => {
    const chatState: WorktreeChatState = {
      activeTabId: 'tab-2',
      tabs: [
        makeTab({
          id: 'tab-2',
          title: 'Tracked review',
          trackedPlanId: 'plan-1',
          trackedPlanSource: 'codex',
          trackedPlanReviewStatus: 'pending',
          lastEventAt: 42,
        }),
      ],
    };

    const cards = selectUnreadChatCards(
      { 'project-1/worktree-1': chatState },
      new Set(['project-1/worktree-1']),
      projects,
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]?.tabId).toBe('tab-2');
    expect(cards[0]?.tabTitle).toBe('Tracked review');
    expect(cards[0]?.hasPendingPlanReview).toBe(true);
  });

  it('flags pending plan exits on the card so the panel can show "Review plan"', () => {
    const chatState: WorktreeChatState = {
      activeTabId: 'tab-3',
      tabs: [
        makeTab({
          id: 'tab-3',
          title: 'Plan exit',
          pendingPlanExit: { plan: 'review' },
          unread: true,
          lastEventAt: 42,
        }),
      ],
    };

    const cards = selectUnreadChatCards(
      { 'project-1/worktree-1': chatState },
      new Set(['project-1/worktree-1']),
      projects,
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]?.hasPendingPlanReview).toBe(true);
  });

  it('suppresses lingering plan-review cards once the user dismisses from the overview', () => {
    const chatState: WorktreeChatState = {
      activeTabId: 'tab-4',
      tabs: [
        makeTab({
          id: 'tab-4',
          title: 'Dismissed review',
          trackedPlanId: 'plan-2',
          trackedPlanSource: 'codex',
          trackedPlanReviewStatus: 'pending',
          lastEventAt: 42,
          attentionDismissedAt: 100,
        }),
      ],
    };

    const cards = selectUnreadChatCards(
      { 'project-1/worktree-1': chatState },
      new Set(['project-1/worktree-1']),
      projects,
    );

    expect(cards).toHaveLength(0);
  });

  it('still surfaces unread state even when the tab was previously dismissed', () => {
    const chatState: WorktreeChatState = {
      activeTabId: 'tab-5',
      tabs: [
        makeTab({
          id: 'tab-5',
          title: 'New activity after dismiss',
          unread: true,
          attentionDismissedAt: 100,
          lastEventAt: 200,
        }),
      ],
    };

    const cards = selectUnreadChatCards(
      { 'project-1/worktree-1': chatState },
      new Set(['project-1/worktree-1']),
      projects,
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]?.hasPendingPlanReview).toBe(false);
  });

  it('resolves a plan-explore unread card to its real worktree and plan target', () => {
    const planScopeKey = `${PLAN_EXPLORE_CHAT_PROJECT_ID}/plan-77`;
    const chatState: WorktreeChatState = {
      activeTabId: 'plan-tab',
      tabs: [
        makeTab({
          id: 'plan-tab',
          title: 'summarize this plan',
          unread: true,
          lastEventAt: 42,
        }),
      ],
    };

    const cards = selectUnreadChatCards(
      { [planScopeKey]: chatState },
      new Set([planScopeKey]),
      projects,
      (planId) =>
        planId === 'plan-77'
          ? { projectId: 'project-1', worktreeId: 'worktree-1' }
          : undefined,
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]?.workspaceName).toBe('Project One');
    expect(cards[0]?.worktreeName).toBe('feature/worktree');
    expect(cards[0]?.planExplore).toEqual({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      planId: 'plan-77',
    });
    // Dismissal must still target the synthetic plan-explore scope.
    expect(cards[0]?.projectId).toBe(PLAN_EXPLORE_CHAT_PROJECT_ID);
    expect(cards[0]?.worktreeId).toBe('plan-77');
  });

  it('resolves a streaming plan-explore card to its real worktree and plan target', () => {
    const planScopeKey = `${PLAN_EXPLORE_CHAT_PROJECT_ID}/plan-77`;
    const chatState: WorktreeChatState = {
      activeTabId: 'plan-tab',
      tabs: [
        makeTab({
          id: 'plan-tab',
          title: 'summarize this plan',
          status: 'streaming',
          lastEventAt: 42,
        }),
      ],
    };

    const cards = selectInProgressChatCards(
      { [planScopeKey]: chatState },
      projects,
      () => ({ projectId: 'project-1', worktreeId: 'worktree-1' }),
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]?.workspaceName).toBe('Project One');
    expect(cards[0]?.worktreeName).toBe('feature/worktree');
    expect(cards[0]?.planExplore?.planId).toBe('plan-77');
  });

  it('leaves a plan-explore card unresolved (no plan target) when origin is unknown', () => {
    const planScopeKey = `${PLAN_EXPLORE_CHAT_PROJECT_ID}/plan-77`;
    const chatState: WorktreeChatState = {
      activeTabId: 'plan-tab',
      tabs: [makeTab({ id: 'plan-tab', unread: true, lastEventAt: 1 })],
    };

    const cards = selectUnreadChatCards(
      { [planScopeKey]: chatState },
      new Set([planScopeKey]),
      projects,
      () => undefined,
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]?.planExplore).toBeUndefined();
  });
});
