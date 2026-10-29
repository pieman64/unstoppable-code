import type {
  AgentAuditToolCounts,
  UsageMetricEvent,
  PlanUsageEvent,
  WorktreeCreatedUsageEvent,
  WorktreeDeletedUsageEvent,
  ChatTurnUsageEvent,
} from '@canopy/desktop-shared/types';
import {
  computeTabSummary,
  computeMetricsView,
  computeCountsTimeseries,
  computeDistributionTimeseries,
  resolveWindow,
  earliestEventAt,
} from '../observability/usage-tab-aggregation';

const NOW_MS = Date.parse('2026-05-26T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

function toolCounts(
  overrides: Partial<AgentAuditToolCounts> = {},
): AgentAuditToolCounts {
  return {
    thinking: 0,
    bash: 0,
    read: 0,
    readLines: 0,
    writeEdit: 0,
    plan: 0,
    fileEdit: 0,
    fileAdd: 0,
    fileDelete: 0,
    search: 0,
    grep: 0,
    web: 0,
    agent: 0,
    workflow: 0,
    tasks: 0,
    taskStop: 0,
    skills: 0,
    monitor: 0,
    claude: 0,
    scheduleWakeup: 0,
    askUser: 0,
    scriptOutput: 0,
    watcher: 0,
    canopy: 0,
    graph: 0,
    appAdvisor: 0,
    pipelineEditor: 0,
    mcp: 0,
    other: 0,
    ...overrides,
  };
}

function localIso(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): string {
  return new Date(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
    millisecond,
  ).toISOString();
}

function localHourStartIso(timestamp: string): string {
  const date = new Date(timestamp);
  return new Date(
    date.getTime() -
      date.getMinutes() * 60 * 1000 -
      date.getSeconds() * 1000 -
      date.getMilliseconds(),
  ).toISOString();
}

function withTimezone<T>(timezone: string, callback: () => T): T {
  const previousTimezone = process.env.TZ;
  process.env.TZ = timezone;
  try {
    return callback();
  } finally {
    if (previousTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousTimezone;
    }
  }
}

function createdEvent(
  ts: string,
  workspaceId = 'ws-a',
): WorktreeCreatedUsageEvent {
  return {
    version: 1,
    id: `created-${ts}`,
    type: 'worktree_created',
    timestamp: ts,
    workspaceId,
    worktreeId: `wt-${ts}`,
    worktreeCreatedAt: ts,
    repos: [
      {
        workspaceId,
        repoId: 'repo-1',
        repoLabel: 'repo 1',
      },
    ],
  };
}

function deletedEvent(
  ts: string,
  withChanges: boolean,
  ageMs: number,
): WorktreeDeletedUsageEvent {
  return {
    version: 1,
    id: `deleted-${ts}`,
    type: 'worktree_deleted',
    timestamp: ts,
    workspaceId: 'ws-a',
    worktreeId: `wt-${ts}`,
    deletedWithChanges: withChanges,
    worktreeAgeMs: ageMs,
    repos: [
      {
        workspaceId: 'ws-a',
        repoId: 'repo-1',
        repoLabel: 'repo 1',
        hadChanges: withChanges,
        insertions: withChanges ? 10 : 0,
        deletions: withChanges ? 5 : 0,
        hasUncommittedChanges: withChanges,
        hasCommitsAhead: false,
      },
    ],
  };
}

function chatTurnEvent(
  ts: string,
  durationMs: number,
  toolCount = 3,
  tokens = {
    input: 100,
    output: 50,
    cacheReadInputTokens: 25,
    cacheCreationInputTokens: 5,
  },
  totalCostUsd?: number,
): ChatTurnUsageEvent {
  return {
    version: 1,
    id: `turn-${ts}`,
    type: 'chat_turn_completed',
    timestamp: ts,
    workspaceId: 'ws-a',
    worktreeId: 'wt-1',
    chatId: 'chat-1',
    turnStartedAt: ts,
    turnCompletedAt: ts,
    turnDurationMs: durationMs,
    tokens,
    totalCostUsd,
    toolUseCount: toolCount,
    provider: 'claude',
    initiationSource: 'user',
  };
}

function planEvent(
  ts: string,
  worktreeId: string,
  type: PlanUsageEvent['type'] = 'plan_approved',
): PlanUsageEvent {
  return {
    version: 1,
    id: `plan-${type}-${ts}-${worktreeId}`,
    type,
    timestamp: ts,
    workspaceId: 'ws-a',
    worktreeId,
    provider: 'claude',
    initiationSource: 'user',
    planId: `plan-${worktreeId}`,
    planVersion: 1,
  };
}

describe('resolveWindow', () => {
  test('last7d resolves to [now-7d, now)', () => {
    const window = resolveWindow({ kind: 'last7d' }, NOW_MS);
    expect(Date.parse(window.end)).toBe(NOW_MS);
    expect(Date.parse(window.start)).toBe(NOW_MS - 7 * 24 * 60 * 60 * 1000);
  });

  test('prior7d resolves to [now-14d, now-7d)', () => {
    const window = resolveWindow({ kind: 'prior7d' }, NOW_MS);
    expect(Date.parse(window.end)).toBe(NOW_MS - 7 * 24 * 60 * 60 * 1000);
    expect(Date.parse(window.start)).toBe(NOW_MS - 14 * 24 * 60 * 60 * 1000);
  });

  test('allTime resolves to [earliest, now)', () => {
    const window = resolveWindow(
      { kind: 'allTime' },
      NOW_MS,
      '2026-01-01T00:00:00.000Z',
    );
    expect(Date.parse(window.end)).toBe(NOW_MS);
    expect(window.start).toBe('2026-01-01T00:00:00.000Z');
  });

  test('custom passes through verbatim', () => {
    const window = resolveWindow(
      {
        kind: 'custom',
        start: '2026-05-01T00:00:00.000Z',
        end: '2026-05-10T00:00:00.000Z',
      },
      NOW_MS,
    );
    expect(window.start).toBe('2026-05-01T00:00:00.000Z');
    expect(window.end).toBe('2026-05-10T00:00:00.000Z');
  });
});

describe('earliestEventAt', () => {
  test('returns ISO timestamp of earliest event', () => {
    const events: UsageMetricEvent[] = [
      createdEvent('2026-04-01T00:00:00.000Z'),
      createdEvent('2026-03-15T00:00:00.000Z'),
      createdEvent('2026-05-01T00:00:00.000Z'),
    ];
    expect(earliestEventAt(events)).toBe('2026-03-15T00:00:00.000Z');
  });

  test('returns now-ISO for empty list', () => {
    const result = earliestEventAt([], NOW_MS);
    expect(Date.parse(result)).toBe(NOW_MS);
  });
});

describe('computeTabSummary worktrees', () => {
  const events: UsageMetricEvent[] = [
    createdEvent('2026-05-25T00:00:00.000Z'),
    createdEvent('2026-05-24T00:00:00.000Z'),
    createdEvent('2026-05-15T00:00:00.000Z'),
    deletedEvent('2026-05-25T00:00:00.000Z', true, 86_400_000),
    deletedEvent('2026-05-15T00:00:00.000Z', false, 3_600_000),
  ];

  test('counts last7d, prior7d, allTime for each card', () => {
    const summary = computeTabSummary('worktrees', events, NOW_MS);

    const createdCard = summary.cards.find((c) => c.key === 'created');
    expect(createdCard).toBeDefined();
    expect(createdCard?.last7d).toBe(2);
    expect(createdCard?.prior7d).toBe(1);
    expect(createdCard?.allTime).toBe(3);

    const deletedWith = summary.cards.find(
      (c) => c.key === 'deleted_with_changes',
    );
    expect(deletedWith?.last7d).toBe(1);
    expect(deletedWith?.prior7d).toBe(0);

    const deletedWithout = summary.cards.find(
      (c) => c.key === 'deleted_without_changes',
    );
    expect(deletedWithout?.last7d).toBe(0);
    expect(deletedWithout?.prior7d).toBe(1);
  });

  test('returns resolvedWindows for all three windows', () => {
    const summary = computeTabSummary('worktrees', events, NOW_MS);
    expect(summary.resolvedWindows.last7d.end).toBeDefined();
    expect(summary.resolvedWindows.prior7d.end).toBeDefined();
    expect(summary.resolvedWindows.allTime.end).toBeDefined();
  });
});

describe('computeTabSummary chats', () => {
  const events: UsageMetricEvent[] = [
    chatTurnEvent('2026-05-25T00:00:00.000Z', 1000, 3),
    chatTurnEvent('2026-05-24T00:00:00.000Z', 2000, 5),
    chatTurnEvent('2026-05-15T00:00:00.000Z', 4000, 1),
  ];

  test('reports turn count and avg/p95 distribution stats', () => {
    const summary = computeTabSummary('chats', events, NOW_MS);
    const totalTurns = summary.cards.find((c) => c.key === 'total_turns');
    expect(totalTurns?.last7d).toBe(2);
    expect(totalTurns?.prior7d).toBe(1);

    const avgDuration = summary.cards.find(
      (c) => c.key === 'avg_turn_duration_ms',
    );
    expect(avgDuration?.last7d).toMatchObject({ avg: 1500 });
  });
});

describe('computeTabSummary tokens', () => {
  const events: UsageMetricEvent[] = [
    chatTurnEvent('2026-05-25T00:00:00.000Z', 1000, 3, {
      input: 100,
      output: 50,
      cacheReadInputTokens: 25,
      cacheCreationInputTokens: 5,
    }),
    chatTurnEvent('2026-05-24T00:00:00.000Z', 2000, 5, {
      input: 200,
      output: 75,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 0,
    }),
    chatTurnEvent('2026-05-15T00:00:00.000Z', 4000, 1, {
      input: 10,
      output: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    }),
  ];

  test('reports token totals across comparison windows', () => {
    const summary = computeTabSummary('tokens', events, NOW_MS);
    const total = summary.cards.find((c) => c.key === 'total_tokens');
    const input = summary.cards.find((c) => c.key === 'input_tokens');
    const output = summary.cards.find((c) => c.key === 'output_tokens');

    expect(total?.last7d).toBe(465);
    expect(total?.prior7d).toBe(15);
    expect(input?.last7d).toBe(300);
    expect(output?.last7d).toBe(125);
  });
});

describe('computeTabSummary cost', () => {
  const events: UsageMetricEvent[] = [
    chatTurnEvent(
      '2026-05-25T00:00:00.000Z',
      1000,
      3,
      {
        input: 100,
        output: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      1.25,
    ),
    {
      ...chatTurnEvent(
        '2026-05-24T00:00:00.000Z',
        2000,
        5,
        {
          input: 200,
          output: 75,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        0.5,
      ),
      id: 'turn-codex-cost-summary',
      provider: 'codex',
    },
    chatTurnEvent(
      '2026-05-15T00:00:00.000Z',
      4000,
      1,
      {
        input: 10,
        output: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      0.25,
    ),
    chatTurnEvent('2026-05-25T01:00:00.000Z', 1000),
  ];

  test('reports observed cost totals across comparison windows', () => {
    const summary = computeTabSummary('cost', events, NOW_MS);
    const total = summary.cards.find((c) => c.key === 'observed_cost');
    const claude = summary.cards.find((c) => c.key === 'claude_cost');
    const codex = summary.cards.find((c) => c.key === 'codex_cost');

    expect(total?.last7d).toBeCloseTo(1.75);
    expect(total?.prior7d).toBeCloseTo(0.25);
    expect(claude?.last7d).toBeCloseTo(1.25);
    expect(codex?.last7d).toBeCloseTo(0.5);
  });
});

describe('computeTabSummary plans', () => {
  test('reports approvals per distinct worktree', () => {
    const events: UsageMetricEvent[] = [
      planEvent('2026-05-25T00:00:00.000Z', 'wt-1'),
      planEvent('2026-05-24T00:00:00.000Z', 'wt-1'),
      planEvent('2026-05-23T00:00:00.000Z', 'wt-2'),
      planEvent('2026-05-15T00:00:00.000Z', 'wt-3'),
    ];

    const summary = computeTabSummary('plans', events, NOW_MS);
    const approvedPerWorktree = summary.cards.find(
      (c) => c.key === 'approved_per_worktree',
    );

    expect(approvedPerWorktree?.last7d).toBe(1.5);
    expect(approvedPerWorktree?.prior7d).toBe(1);
    expect(approvedPerWorktree?.allTime).toBe(4 / 3);
  });
});

describe('computeTabSummary tools', () => {
  test('reports tool calls per turn as distribution stats', () => {
    const events: UsageMetricEvent[] = [
      chatTurnEvent('2026-05-25T00:00:00.000Z', 1000, 3),
      chatTurnEvent('2026-05-24T00:00:00.000Z', 2000, 5),
    ];

    const summary = computeTabSummary('tools', events, NOW_MS);
    const avgPerTurn = summary.cards.find((c) => c.key === 'avg_per_turn');
    const p95PerTurn = summary.cards.find((c) => c.key === 'p95_per_turn');

    expect(avgPerTurn?.last7d).toMatchObject({ avg: 4 });
    expect(p95PerTurn?.last7d).toMatchObject({ p95: 5 });
  });
});

describe('computeMetricsView', () => {
  const events: UsageMetricEvent[] = [
    createdEvent('2026-05-25T00:00:00.000Z', 'ws-a'),
    createdEvent('2026-05-24T00:00:00.000Z', 'ws-a'),
    createdEvent('2026-05-25T00:00:00.000Z', 'ws-b'),
  ];

  test('groups created by project', () => {
    const view = computeMetricsView(
      {
        tab: 'worktrees',
        metric: 'created',
        groupBy: 'workspace',
        window: { kind: 'last7d' },
      },
      events,
      NOW_MS,
    );
    expect(view.rows).toHaveLength(2);
    const wsA = view.rows.find((r) => r.workspaceId === 'ws-a');
    expect(wsA?.count).toBe(2);
    const wsB = view.rows.find((r) => r.workspaceId === 'ws-b');
    expect(wsB?.count).toBe(1);
  });
});

describe('computeMetricsView tools', () => {
  test('labels the legacy first-party category as Built-in', () => {
    const event: ChatTurnUsageEvent = {
      ...chatTurnEvent('2026-05-25T00:00:00.000Z', 1000, 4),
      toolCounts: toolCounts({ canopy: 4 }),
    };

    const view = computeMetricsView(
      {
        tab: 'tools',
        metric: 'tool_calls',
        groupBy: 'category',
        window: { kind: 'last7d' },
      },
      [event],
      NOW_MS,
    );

    expect(view.rows).toEqual([
      expect.objectContaining({
        key: 'canopy',
        label: 'Built-in',
        count: 4,
      }),
    ]);
  });
});

describe('computeMetricsView tokens', () => {
  test('groups token totals by provider', () => {
    const events: UsageMetricEvent[] = [
      chatTurnEvent('2026-05-25T00:00:00.000Z', 1000, 3, {
        input: 100,
        output: 50,
        cacheReadInputTokens: 25,
        cacheCreationInputTokens: 5,
      }),
      {
        ...chatTurnEvent('2026-05-24T00:00:00.000Z', 2000, 5, {
          input: 10,
          output: 5,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        }),
        id: 'turn-codex',
        provider: 'codex',
      },
    ];
    const view = computeMetricsView(
      {
        tab: 'tokens',
        metric: 'token_total',
        groupBy: 'provider',
        window: { kind: 'last7d' },
      },
      events,
      NOW_MS,
    );

    expect(view.rows.find((row) => row.provider === 'claude')?.count).toBe(180);
    expect(view.rows.find((row) => row.provider === 'codex')?.count).toBe(15);
  });
});

describe('computeMetricsView cost', () => {
  test('groups observed cost by provider', () => {
    const events: UsageMetricEvent[] = [
      chatTurnEvent(
        '2026-05-25T00:00:00.000Z',
        1000,
        3,
        {
          input: 100,
          output: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        1.25,
      ),
      {
        ...chatTurnEvent(
          '2026-05-24T00:00:00.000Z',
          2000,
          5,
          {
            input: 10,
            output: 5,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          0.5,
        ),
        id: 'turn-codex-cost-view',
        provider: 'codex',
      },
      chatTurnEvent('2026-05-24T01:00:00.000Z', 2000),
    ];
    const view = computeMetricsView(
      {
        tab: 'cost',
        metric: 'cost_total_usd',
        groupBy: 'provider',
        window: { kind: 'last7d' },
      },
      events,
      NOW_MS,
    );

    expect(
      view.rows.find((row) => row.provider === 'claude')?.count,
    ).toBeCloseTo(1.25);
    expect(
      view.rows.find((row) => row.provider === 'codex')?.count,
    ).toBeCloseTo(0.5);
  });

  test('groups observed cost by model', () => {
    const events: UsageMetricEvent[] = [
      {
        ...chatTurnEvent(
          '2026-05-25T00:00:00.000Z',
          1000,
          3,
          {
            input: 100,
            output: 50,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          1.25,
        ),
        id: 'turn-sonnet-cost-view',
        model: 'claude-sonnet-4',
      },
      {
        ...chatTurnEvent(
          '2026-05-24T00:00:00.000Z',
          2000,
          5,
          {
            input: 10,
            output: 5,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          0.5,
        ),
        id: 'turn-gpt-cost-view',
        provider: 'codex',
        model: 'gpt-5',
      },
      {
        ...chatTurnEvent(
          '2026-05-24T01:00:00.000Z',
          2000,
          5,
          {
            input: 10,
            output: 5,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          0.75,
        ),
        id: 'turn-sonnet-cost-view-2',
        model: 'claude-sonnet-4',
      },
    ];
    const view = computeMetricsView(
      {
        tab: 'cost',
        metric: 'cost_total_usd',
        groupBy: 'model',
        window: { kind: 'last7d' },
      },
      events,
      NOW_MS,
    );

    expect(
      view.rows.find((row) => row.key === 'claude-sonnet-4')?.count,
    ).toBeCloseTo(2);
    expect(view.rows.find((row) => row.key === 'gpt-5')?.count).toBeCloseTo(
      0.5,
    );
  });
});

describe('computeMetricsView distribution', () => {
  test('returns stats for distribution metrics', () => {
    const events: UsageMetricEvent[] = [
      chatTurnEvent('2026-05-25T00:00:00.000Z', 1000),
      chatTurnEvent('2026-05-24T00:00:00.000Z', 2000),
      chatTurnEvent('2026-05-23T00:00:00.000Z', 3000),
    ];
    const view = computeMetricsView(
      {
        tab: 'chats',
        metric: 'turn_duration_ms',
        groupBy: 'workspace',
        window: { kind: 'last7d' },
      },
      events,
      NOW_MS,
    );
    expect(view.stats).toBeDefined();
    expect(view.rows[0]?.stats).toBeDefined();
    expect(view.rows[0]?.stats?.avg).toBe(2000);
  });
});

describe('computeCountsTimeseries', () => {
  test('buckets created events per day', () => {
    const events: UsageMetricEvent[] = [
      createdEvent(localIso(2026, 5, 25, 1)),
      createdEvent(localIso(2026, 5, 25, 5)),
      createdEvent(localIso(2026, 5, 24, 1)),
    ];
    const buckets = computeCountsTimeseries(
      {
        tab: 'worktrees',
        series: ['created'],
        bucket: 'day',
        startDate: localIso(2026, 5, 23),
        endDate: localIso(2026, 5, 26),
      },
      events,
    );
    expect(buckets).toHaveLength(3);
    expect(buckets[0].series.created ?? 0).toBe(0);
    expect(buckets[1].series.created ?? 0).toBe(1);
    expect(buckets[2].series.created ?? 0).toBe(2);
  });

  test('aligns day buckets to the device local timezone', () => {
    const events: UsageMetricEvent[] = [
      createdEvent(localIso(2026, 5, 24, 23, 30)),
      createdEvent(localIso(2026, 5, 25, 0, 30)),
    ];
    const buckets = computeCountsTimeseries(
      {
        tab: 'worktrees',
        series: ['created'],
        bucket: 'day',
        startDate: localIso(2026, 5, 24),
        endDate: localIso(2026, 5, 26),
      },
      events,
    );

    expect(buckets.map((bucket) => bucket.bucketStart)).toEqual([
      localIso(2026, 5, 24),
      localIso(2026, 5, 25),
    ]);
    expect(buckets[0].series.created ?? 0).toBe(1);
    expect(buckets[1].series.created ?? 0).toBe(1);
  });

  test('aligns week buckets to local ISO week starts', () => {
    const events: UsageMetricEvent[] = [
      createdEvent(localIso(2026, 5, 24, 23, 30)),
      createdEvent(localIso(2026, 5, 25, 0, 30)),
    ];
    const buckets = computeCountsTimeseries(
      {
        tab: 'worktrees',
        series: ['created'],
        bucket: 'week',
        startDate: localIso(2026, 5, 18),
        endDate: localIso(2026, 6, 1),
      },
      events,
    );

    expect(buckets.map((bucket) => bucket.bucketStart)).toEqual([
      localIso(2026, 5, 18),
      localIso(2026, 5, 25),
    ]);
    expect(buckets[0].series.created ?? 0).toBe(1);
    expect(buckets[1].series.created ?? 0).toBe(1);
  });

  test('keeps repeated fallback hours in separate count buckets', () => {
    withTimezone('America/New_York', () => {
      const firstRepeatedHour = '2026-11-01T01:30:00-04:00';
      const secondRepeatedHour = '2026-11-01T01:30:00-05:00';
      const events: UsageMetricEvent[] = [
        createdEvent(firstRepeatedHour),
        createdEvent(secondRepeatedHour),
      ];
      const buckets = computeCountsTimeseries(
        {
          tab: 'worktrees',
          series: ['created'],
          bucket: 'hour',
          startDate: '2026-11-01T00:00:00-04:00',
          endDate: '2026-11-01T03:00:00-05:00',
        },
        events,
      );
      const firstHourStart = localHourStartIso(firstRepeatedHour);
      const secondHourStart = localHourStartIso(secondRepeatedHour);

      expect(secondHourStart).toBe(
        new Date(Date.parse(firstHourStart) + HOUR_MS).toISOString(),
      );
      expect(
        buckets.find((bucket) => bucket.bucketStart === firstHourStart)?.series
          .created ?? 0,
      ).toBe(1);
      expect(
        buckets.find((bucket) => bucket.bucketStart === secondHourStart)?.series
          .created ?? 0,
      ).toBe(1);
    });
  });

  test('buckets token totals by provider per day', () => {
    const events: UsageMetricEvent[] = [
      chatTurnEvent(localIso(2026, 5, 25, 1), 1000, 3, {
        input: 100,
        output: 25,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      }),
      {
        ...chatTurnEvent(localIso(2026, 5, 25, 5), 1000, 3, {
          input: 50,
          output: 10,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        }),
        id: 'turn-codex-provider-timeseries',
        provider: 'codex',
      },
    ];
    const buckets = computeCountsTimeseries(
      {
        tab: 'tokens',
        series: ['token_provider_claude', 'token_provider_codex'],
        bucket: 'day',
        startDate: localIso(2026, 5, 24),
        endDate: localIso(2026, 5, 26),
      },
      events,
    );

    expect(buckets).toHaveLength(2);
    expect(buckets[1].series.token_provider_claude ?? 0).toBe(125);
    expect(buckets[1].series.token_provider_codex ?? 0).toBe(60);
  });

  test('buckets observed cost by provider per day', () => {
    const events: UsageMetricEvent[] = [
      chatTurnEvent(
        localIso(2026, 5, 25, 1),
        1000,
        3,
        {
          input: 100,
          output: 25,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        1.2,
      ),
      {
        ...chatTurnEvent(
          localIso(2026, 5, 25, 5),
          1000,
          3,
          {
            input: 50,
            output: 10,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          0.3,
        ),
        id: 'turn-codex-provider-cost-timeseries',
        provider: 'codex',
      },
    ];
    const buckets = computeCountsTimeseries(
      {
        tab: 'cost',
        series: ['cost_provider_claude_usd', 'cost_provider_codex_usd'],
        bucket: 'day',
        startDate: localIso(2026, 5, 24),
        endDate: localIso(2026, 5, 26),
      },
      events,
    );

    expect(buckets).toHaveLength(2);
    expect(buckets[1].series.cost_provider_claude_usd ?? 0).toBeCloseTo(1.2);
    expect(buckets[1].series.cost_provider_codex_usd ?? 0).toBeCloseTo(0.3);
  });

  test('buckets observed cost by model per day', () => {
    const events: UsageMetricEvent[] = [
      {
        ...chatTurnEvent(
          localIso(2026, 5, 25, 1),
          1000,
          3,
          {
            input: 100,
            output: 25,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          1.2,
        ),
        id: 'turn-sonnet-model-cost-timeseries',
        model: 'claude-sonnet-4',
      },
      {
        ...chatTurnEvent(
          localIso(2026, 5, 25, 5),
          1000,
          3,
          {
            input: 50,
            output: 10,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          0.3,
        ),
        id: 'turn-gpt-model-cost-timeseries',
        provider: 'codex',
        model: 'gpt-5',
      },
      {
        ...chatTurnEvent(
          localIso(2026, 5, 25, 8),
          1000,
          3,
          {
            input: 20,
            output: 5,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          0.4,
        ),
        id: 'turn-sonnet-model-cost-timeseries-2',
        model: 'claude-sonnet-4',
      },
    ];
    const buckets = computeCountsTimeseries(
      {
        tab: 'cost',
        series: ['cost_model:claude-sonnet-4', 'cost_model:gpt-5'],
        bucket: 'day',
        startDate: localIso(2026, 5, 24),
        endDate: localIso(2026, 5, 26),
      },
      events,
    );

    expect(buckets).toHaveLength(2);
    expect(buckets[1].series['cost_model:claude-sonnet-4'] ?? 0).toBeCloseTo(
      1.6,
    );
    expect(buckets[1].series['cost_model:gpt-5'] ?? 0).toBeCloseTo(0.3);
  });
});

describe('computeDistributionTimeseries', () => {
  test('buckets turn duration per day with p50/p95/p99', () => {
    const events: UsageMetricEvent[] = [
      chatTurnEvent(localIso(2026, 5, 25, 1), 1000),
      chatTurnEvent(localIso(2026, 5, 25, 5), 3000),
      chatTurnEvent(localIso(2026, 5, 25, 10), 5000),
    ];
    const buckets = computeDistributionTimeseries(
      {
        tab: 'chats',
        metric: 'turn_duration_ms',
        bucket: 'day',
        startDate: localIso(2026, 5, 24),
        endDate: localIso(2026, 5, 26),
      },
      events,
    );
    expect(buckets).toHaveLength(2);
    const day25 = buckets[1];
    expect(day25.sampleCount).toBe(3);
    expect(day25.p50).toBe(3000);
    expect(day25.p95).toBeGreaterThanOrEqual(3000);
  });

  test('aligns distribution buckets to the device local timezone', () => {
    const events: UsageMetricEvent[] = [
      chatTurnEvent(localIso(2026, 5, 24, 23, 30), 1000),
      chatTurnEvent(localIso(2026, 5, 25, 0, 30), 3000),
    ];
    const buckets = computeDistributionTimeseries(
      {
        tab: 'chats',
        metric: 'turn_duration_ms',
        bucket: 'day',
        startDate: localIso(2026, 5, 24),
        endDate: localIso(2026, 5, 26),
      },
      events,
    );

    expect(buckets.map((bucket) => bucket.bucketStart)).toEqual([
      localIso(2026, 5, 24),
      localIso(2026, 5, 25),
    ]);
    expect(buckets[0].sampleCount).toBe(1);
    expect(buckets[0].p50).toBe(1000);
    expect(buckets[1].sampleCount).toBe(1);
    expect(buckets[1].p50).toBe(3000);
  });

  test('keeps repeated fallback hours in separate distribution buckets', () => {
    withTimezone('America/New_York', () => {
      const firstRepeatedHour = '2026-11-01T01:30:00-04:00';
      const secondRepeatedHour = '2026-11-01T01:30:00-05:00';
      const events: UsageMetricEvent[] = [
        chatTurnEvent(firstRepeatedHour, 1000),
        chatTurnEvent(secondRepeatedHour, 3000),
      ];
      const buckets = computeDistributionTimeseries(
        {
          tab: 'chats',
          metric: 'turn_duration_ms',
          bucket: 'hour',
          startDate: '2026-11-01T00:00:00-04:00',
          endDate: '2026-11-01T03:00:00-05:00',
        },
        events,
      );
      const firstHourStart = localHourStartIso(firstRepeatedHour);
      const secondHourStart = localHourStartIso(secondRepeatedHour);

      expect(secondHourStart).toBe(
        new Date(Date.parse(firstHourStart) + HOUR_MS).toISOString(),
      );
      expect(
        buckets.find((bucket) => bucket.bucketStart === firstHourStart),
      ).toMatchObject({
        sampleCount: 1,
        p50: 1000,
      });
      expect(
        buckets.find((bucket) => bucket.bucketStart === secondHourStart),
      ).toMatchObject({
        sampleCount: 1,
        p50: 3000,
      });
    });
  });
});
