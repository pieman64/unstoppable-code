import {
  TELEMETRY_ATTENTION_REASONS,
  TELEMETRY_ATTENTION_REASONS_BY_STATE,
  TELEMETRY_ATTENTION_STATES,
  TELEMETRY_CARD_UNITS,
  TELEMETRY_TIME_GRANULARITIES,
  TELEMETRY_USAGE_GROUP_BY,
  TELEMETRY_USAGE_SCOPES,
  classifyPipelineType,
  type TeamUsageResponse,
} from '../index';

describe('telemetry read-side contracts (CAN-377)', () => {
  it('exports stable usage vocabularies', () => {
    expect([...TELEMETRY_USAGE_SCOPES]).toEqual(['organization', 'team']);
    expect([...TELEMETRY_TIME_GRANULARITIES]).toEqual(['hour', 'day', 'week']);
    expect([...TELEMETRY_USAGE_GROUP_BY]).toEqual([
      'user',
      'model',
      'provider',
      'pipeline',
      'worktree',
    ]);
    expect([...TELEMETRY_CARD_UNITS]).toEqual(['currency', 'count', 'tokens']);
  });

  it('TeamUsageResponse is a plain JSON-serializable shape', () => {
    const response: TeamUsageResponse = {
      scope: 'team',
      teamId: 'team-uuid',
      range: {
        startIso: '2026-06-01T00:00:00.000Z',
        endIso: '2026-06-15T00:00:00.000Z',
        granularity: 'day',
      },
      filterUserId: null,
      headline: [
        {
          key: 'totalCostUsd',
          label: 'Total cost',
          value: 12.5,
          previousValue: 10,
          unit: 'currency',
        },
      ],
      tokensByProvider: [
        {
          bucketStartIso: '2026-06-01T00:00:00.000Z',
          key: 'claude',
          inputTokens: 1,
          outputTokens: 2,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      ],
      tokensByModel: [],
      costByProvider: [],
      costByModel: [],
      toolCategoryTotals: [{ toolCategory: 'bash', total: 3 }],
      eventTypeStatusCounts: [
        { eventType: 'worktree_chat', status: 'success', count: 4 },
      ],
      byUser: [
        {
          userId: 'user-uuid',
          userName: 'Ada',
          totalCostUsd: 1,
          inputTokens: 1,
          outputTokens: 1,
          turnCount: 1,
        },
      ],
      impactByUser: [
        {
          bucketStartIso: '2026-06-01T00:00:00.000Z',
          key: 'Ada',
          impactScore: 4.5,
        },
      ],
      pipelines: [
        {
          clientPipelineId: 'pipe-1',
          pipelineName: 'Code Review',
          runCount: 1,
          turnCount: 2,
          agentTimeMs: 1000,
          totalCostUsd: 1,
          inputTokens: 1,
          outputTokens: 1,
        },
      ],
      mostExpensiveRuns: [
        {
          sessionId: 'wt-uuid:chat-uuid',
          turnCount: 3,
          label: 'Run',
          provider: 'claude',
          model: null,
          totalCostUsd: 9.99,
          startedAtIso: '2026-06-01T00:00:00.000Z',
          worktreeId: 'wt-uuid',
          branchName: 'feat/x',
          prUrl: null,
          authorName: null,
          // Read-side wire shape carries raw Postgres enum strings (UPPERCASE),
          // unlike the lowercase ingest-side TELEMETRY_TURN_STATUSES /
          // TELEMETRY_EVENT_TYPES constants. The divergence is intentional.
          status: 'SUCCESS',
          eventType: 'WORKTREE_CHAT',
          durationMs: null,
          inputTokens: 1500,
          outputTokens: 900,
        },
      ],
      autoRoutingSavings: {
        autoTurnCount: 2,
        comparableTurnCount: 1,
        benchmarkEstimatedExecutionCostUsd: 0.2,
        selectedExecutionCostUsd: 0.1,
        routingCostUsd: 0.01,
        actualWithAutoCostUsd: 0.11,
        netEstimatedSavingsUsd: 0.09,
        previousNetEstimatedSavingsUsd: null,
      },
    };

    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
  });

  it('classifyPipelineType derives type from the id conventions', () => {
    expect(classifyPipelineType('shared:canopy-cloud:41099f6d-3b8f')).toBe(
      'shared',
    );
    expect(classifyPipelineType('bundled-implementation-autopilot')).toBe(
      'bundled',
    );
    expect(classifyPipelineType('code-review.yaml')).toBe('project');
    expect(classifyPipelineType('pipelines/code-review.yml')).toBe('project');
    expect(classifyPipelineType('a6f5db43-4ed7-4791-9355-2762b7e303ad')).toBe(
      'private',
    );
  });
});

describe('attention state/reason pairing', () => {
  // The ingest parser rejects a state/reason pair it does not recognize, and a
  // parse error fails the WHOLE request — every turn, plan, and PR in that
  // piece, not just the attention entry. So the acceptance table has to live in
  // the shared contract next to the enums it partitions; a private copy on the
  // server silently starts 400-ing the desktop the moment a reason is added
  // here and wired on the client.
  it('partitions every reason across the two blocking states', () => {
    const blocking = [
      ...TELEMETRY_ATTENTION_REASONS_BY_STATE.needs_input,
      ...TELEMETRY_ATTENTION_REASONS_BY_STATE.blocked,
    ];
    expect([...blocking].sort()).toEqual(
      [...TELEMETRY_ATTENTION_REASONS].sort(),
    );
    expect(new Set(blocking).size).toBe(blocking.length);
  });

  it('lets a clear carry whichever reason the block it ends was raised with', () => {
    expect([...TELEMETRY_ATTENTION_REASONS_BY_STATE.clear].sort()).toEqual(
      [...TELEMETRY_ATTENTION_REASONS].sort(),
    );
  });

  it('covers every declared attention state', () => {
    expect(Object.keys(TELEMETRY_ATTENTION_REASONS_BY_STATE).sort()).toEqual(
      [...TELEMETRY_ATTENTION_STATES].sort(),
    );
  });
});
