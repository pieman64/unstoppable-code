import {
  computeCountsTimeseries,
  computeTabSummary,
  computeMetricsView,
  normalizeAuditEntry,
  toDelegationStatisticsEvent,
  type DelegationStatisticsEvent,
} from '@canopy/core-runtime/observability';

const NOW = Date.parse('2026-10-08T12:00:00Z');
// A delegation is separate spend, not a completed parent chat turn.
const delegation: DelegationStatisticsEvent = {
  version: 1,
  id: 'delegation:child:1',
  type: 'managed_delegation',
  timestamp: '2026-10-08T11:00:00Z',
  workspaceId: 'project',
  worktreeId: 'worktree',
  chatId: 'chat',
  provider: 'codex',
  model: 'gpt-6-luna',
  tokens: {
    input: 40,
    output: 10,
    cacheReadInputTokens: 20,
    cacheCreationInputTokens: 0,
  },
  totalCostUsd: 0.25,
};

describe('managed delegation Statistics spend', () => {
  it('projects audit spend only at query time, without transcript content', () => {
    const entry = normalizeAuditEntry({
      ...delegation,
      eventType: 'managed_delegation',
      status: 'success',
      label: 'Delegate',
      projectId: 'project',
      startedAt: delegation.timestamp,
      toolCounts: {},
      error: 'Existing error text must not enter Statistics',
    });
    expect(entry).not.toBeNull();
    if (!entry) throw new Error('Expected normalized audit fixture');
    expect(toDelegationStatisticsEvent(entry)).toEqual({
      ...delegation,
      tokens: { ...delegation.tokens, reasoningOutputTokens: 0 },
    });
    expect(toDelegationStatisticsEvent(entry)).not.toHaveProperty('error');
    expect(
      toDelegationStatisticsEvent({ ...entry, eventType: 'worktree_chat' }),
    ).toBeNull();
  });

  it('adds delegation tokens and cost without inventing a chat turn', () => {
    const tokens = computeTabSummary('tokens', [delegation], NOW);
    const cost = computeTabSummary('cost', [delegation], NOW);
    const chats = computeTabSummary('chats', [delegation], NOW);
    expect(
      tokens.cards.find((card) => card.key === 'total_tokens')?.allTime,
    ).toBe(70);
    expect(
      cost.cards.find((card) => card.key === 'observed_cost')?.allTime,
    ).toBe(0.25);
    expect(
      chats.cards.find((card) => card.key === 'total_turns')?.allTime,
    ).toBe(0);
  });

  it('attributes delegation cost to its chat and model, but not chat-count rows', () => {
    const request = {
      window: { kind: 'allTime' },
      groupBy: 'chat',
      tab: 'cost',
      metric: 'cost_total_usd',
    } as const;
    expect(computeMetricsView(request, [delegation], NOW).rows).toEqual([
      expect.objectContaining({ key: 'chat', count: 0.25 }),
    ]);
    expect(
      computeMetricsView({ ...request, groupBy: 'model' }, [delegation], NOW)
        .rows,
    ).toEqual([expect.objectContaining({ key: 'gpt-6-luna', count: 0.25 })]);
    expect(
      computeMetricsView(
        { ...request, tab: 'chats', metric: 'chat_turns' },
        [delegation],
        NOW,
      ).rows,
    ).toEqual([]);
  });

  it('includes spend in time buckets while preserving chat counts', () => {
    const range = {
      bucket: 'hour',
      startDate: '2026-10-08T10:00:00Z',
      endDate: '2026-10-08T12:00:00Z',
    } as const;
    const cost = computeCountsTimeseries(
      { ...range, tab: 'cost', series: ['cost_total_usd'] },
      [delegation],
    );
    const tokens = computeCountsTimeseries(
      { ...range, tab: 'tokens', series: ['token_total'] },
      [delegation],
    );
    const chats = computeCountsTimeseries(
      { ...range, tab: 'chats', series: ['chat_turns'] },
      [delegation],
    );
    expect(cost.map((bucket) => bucket.series.cost_total_usd ?? 0)).toEqual([
      0, 0.25,
    ]);
    expect(tokens.map((bucket) => bucket.series.token_total ?? 0)).toEqual([
      0, 70,
    ]);
    expect(chats.map((bucket) => bucket.series.chat_turns ?? 0)).toEqual([
      0, 0,
    ]);
  });
});
