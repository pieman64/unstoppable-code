import {
  costScopeHasContent,
  costScopeScaleMax,
  isSameCostRowTarget,
  sortCostChats,
  sortCostRuns,
} from '../cost-scope-model';
import {
  chatRow,
  minutesAgo,
  runRow,
  scopeView,
  totals,
} from './cost-test-utils';

describe('cost scope model', () => {
  it('sorts chats by cost and recency, optionally hiding archived chats', () => {
    const chats = [
      chatRow({
        chatId: 'old-expensive',
        totals: totals({ chat: 8 }),
        lastActivityAt: minutesAgo(30),
      }),
      chatRow({
        chatId: 'recent-cheap',
        totals: totals({ chat: 2 }),
        lastActivityAt: minutesAgo(1),
      }),
      chatRow({
        chatId: 'archived',
        state: 'archived',
        totals: totals({ chat: 20 }),
        lastActivityAt: minutesAgo(60),
      }),
    ];

    expect(
      sortCostChats(chats, 'cost', true).map((chat) => chat.chatId),
    ).toEqual(['archived', 'old-expensive', 'recent-cheap']);
    expect(
      sortCostChats(chats, 'recent', true).map((chat) => chat.chatId),
    ).toEqual(['recent-cheap', 'old-expensive', 'archived']);
    expect(
      sortCostChats(chats, 'cost', false).map((chat) => chat.chatId),
    ).toEqual(['old-expensive', 'recent-cheap']);
  });

  it('uses recency as the tie-breaker for cost-sorted chats and runs', () => {
    const chats = [
      chatRow({
        chatId: 'older',
        totals: totals({ chat: 4 }),
        lastActivityAt: minutesAgo(10),
      }),
      chatRow({
        chatId: 'newer',
        totals: totals({ chat: 4 }),
        lastActivityAt: minutesAgo(1),
      }),
    ];
    const runs = [
      runRow({
        executionId: 'older',
        totals: totals({ pipeline: 2 }),
        startedAt: minutesAgo(10),
      }),
      runRow({
        executionId: 'newer',
        totals: totals({ pipeline: 2 }),
        startedAt: minutesAgo(1),
      }),
    ];

    expect(
      sortCostChats(chats, 'cost', true).map((chat) => chat.chatId),
    ).toEqual(['newer', 'older']);
    expect(sortCostRuns(runs, 'cost').map((run) => run.executionId)).toEqual([
      'newer',
      'older',
    ]);
  });

  it('sorts pipeline runs by cost or start time', () => {
    const runs = [
      runRow({
        executionId: 'expensive-old',
        totals: totals({ pipeline: 7 }),
        startedAt: minutesAgo(60),
      }),
      runRow({
        executionId: 'cheap-new',
        totals: totals({ pipeline: 1 }),
        startedAt: minutesAgo(1),
      }),
    ];

    expect(sortCostRuns(runs, 'cost').map((run) => run.executionId)).toEqual([
      'expensive-old',
      'cheap-new',
    ]);
    expect(sortCostRuns(runs, 'recent').map((run) => run.executionId)).toEqual([
      'cheap-new',
      'expensive-old',
    ]);
  });

  it('scales by the largest chat, run, or unattached amount without going below zero', () => {
    expect(
      costScopeScaleMax(
        [chatRow({ totals: totals({ chat: 3 }) })],
        [runRow({ totals: totals({ pipeline: 12 }) })],
        totals({ background: 4 }),
      ),
    ).toBe(12);
    expect(costScopeScaleMax([], [], totals())).toBe(0);
  });

  it('compares chat and pipeline-run targets only within their kind', () => {
    expect(
      isSameCostRowTarget(
        { kind: 'chat', chatId: 'chat-1' },
        { kind: 'chat', chatId: 'chat-1' },
      ),
    ).toBe(true);
    expect(
      isSameCostRowTarget(
        { kind: 'chat', chatId: 'chat-1' },
        { kind: 'pipeline-run', executionId: 'chat-1' },
      ),
    ).toBe(false);
    expect(
      isSameCostRowTarget(null, { kind: 'pipeline-run', executionId: 'run-1' }),
    ).toBe(false);
  });

  it('counts unattached work that was not priced as content', () => {
    const { unattached, ...empty } = scopeView({
      totals: totals(),
      chats: [],
      pipelineRuns: [],
    });
    // The fixture carries unattached work; without it nothing remains.
    expect(unattached).toBeDefined();
    expect(costScopeHasContent(empty)).toBe(false);
    expect(
      costScopeHasContent({
        ...empty,
        unattached: { ...totals(), notPricedCount: 2 },
      }),
    ).toBe(true);
    expect(costScopeHasContent(scopeView())).toBe(true);
  });
});
