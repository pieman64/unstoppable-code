import type { AgentAuditEntry } from '@canopy/desktop-shared/types';
import {
  type CostChatAggregate,
  type CostChatFile,
  type CostScopeLocation,
  type CostTurnRecord,
  type CostUnattachedFile,
} from '../types';
import {
  createEmptyCostTotals,
  type CostAttributedItem,
} from '@canopy/protocol/cost-view';
import {
  aggregateRecords,
  buildPipelineRunViews,
  buildSummary,
  emptyChatAggregate,
  projectChatView,
  projectPipelineRunView,
  projectScopeView,
} from '../read-model';

const EMPTY_TOOL_COUNTS: AgentAuditEntry['toolCounts'] = {
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
};

function tokens(
  input: number,
  output: number,
  cacheReadInputTokens = 0,
  cacheCreationInputTokens = 0,
  reasoningOutputTokens = 0,
): CostTurnRecord['tokens'] {
  return {
    input,
    output,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    reasoningOutputTokens,
  };
}

function toolCounts(
  overrides: Partial<AgentAuditEntry['toolCounts']> = {},
): AgentAuditEntry['toolCounts'] {
  return { ...EMPTY_TOOL_COUNTS, ...overrides };
}

function record(overrides: Partial<CostTurnRecord> = {}): CostTurnRecord {
  const startedAt = overrides.startedAt ?? '2026-10-08T10:00:00.000Z';
  return {
    entryId: 'turn-1',
    day: '2026-10-08',
    startedAt,
    completedAt:
      overrides.completedAt ??
      new Date(Date.parse(startedAt) + 1000).toISOString(),
    status: 'success',
    source: 'chat',
    chatId: 'chat-1',
    provider: 'claude',
    model: 'claude-sonnet-4',
    billingBasis: 'subscription',
    tokens: tokens(100, 40, 10, 5, 4),
    costUsd: 0.1,
    costStatus: 'reported',
    durationMs: 100,
    toolCounts: toolCounts(),
    ...overrides,
  };
}

function attributedItem(
  overrides: Partial<CostAttributedItem> = {},
): CostAttributedItem {
  return {
    id: 'subagent-1',
    kind: 'claude_task',
    label: 'Claude task',
    billingBasis: 'subscription',
    tokens: tokens(20, 10),
    usd: 0.02,
    costStatus: 'reported',
    inclusion: 'additional',
    ...overrides,
  };
}

function recordsById(
  records: readonly CostTurnRecord[],
): Readonly<Record<string, CostTurnRecord>> {
  const result: Record<string, CostTurnRecord> = {};
  for (const item of records) result[item.entryId] = item;
  return result;
}

function chatFile(
  records: readonly CostTurnRecord[],
  sealed?: CostChatAggregate,
): CostChatFile {
  return {
    version: 1,
    chatId: 'chat-1',
    records: recordsById(records),
    ...(sealed ? { sealed } : {}),
  };
}

function unattachedFile(
  records: readonly CostTurnRecord[] = [],
  overrides: Partial<CostUnattachedFile> = {},
): CostUnattachedFile {
  return {
    version: 1,
    records: recordsById(records),
    ...overrides,
  };
}

const ENTRY_SCOPE = {
  kind: 'entry',
  projectId: 'project-1',
  worktreeId: 'worktree-1',
} as const;

const LOCATION: CostScopeLocation = {
  scope: ENTRY_SCOPE,
  directory: '/Users/private/worktree-path',
  incarnation: 'created-1',
  createdAt: '2026-10-01T12:00:00.000Z',
};

describe('cost read model aggregates', () => {
  it('returns a complete empty aggregate matching the DTO defaults', () => {
    const aggregate = emptyChatAggregate();

    expect(aggregate).toMatchObject({
      totals: createEmptyCostTotals(),
      turnCount: 0,
      hasCodexEstimate: false,
      bySource: {
        chat: { usd: 0, turnCount: 0 },
        subagents: { usd: 0, items: [] },
        delegations: { usd: 0, items: [] },
        background: { usd: 0, rows: [] },
      },
      context: { categories: [], timeline: [] },
      activity: {
        turnCount: 0,
        totalDurationMs: 0,
        averageTurnMs: null,
        p95TurnMs: null,
        toolCallCount: 0,
        subagentCount: 0,
        plansCreated: 0,
        plansApproved: 0,
        topTools: [],
      },
      points: [],
    });
    expect(aggregate.bySource.background).toHaveProperty('usd', 0);
  });

  it('splits included subagent tokens and dollars from the parent and adds additional work once', () => {
    const aggregate = aggregateRecords([
      record({
        tokens: tokens(100, 80, 8, 4, 2),
        costUsd: 0.5,
        subagents: [
          attributedItem({
            id: 'included',
            model: 'claude-haiku',
            inclusion: 'included',
            tokens: tokens(20, 10, 2, 1, 0),
            usd: 0.1,
          }),
          attributedItem({
            id: 'additional',
            kind: 'codex_agent',
            model: 'codex-mini-latest',
            inclusion: 'additional',
            tokens: tokens(5, 5, 1, 0, 1),
            usd: 0.2,
            costStatus: 'estimated',
          }),
        ],
      }),
    ]);

    expect(aggregate.totals.usd).toBe(0.7);
    expect(aggregate.totals.bySource).toEqual({
      chat: 0.4,
      pipeline: 0,
      subagents: 0.3,
      delegations: 0,
      background: 0,
    });
    expect(aggregate.bySource.chat.usd).toBe(0.4);
    expect(aggregate.bySource.subagents.usd).toBe(0.3);
    expect(aggregate.totals.tokens).toEqual(tokens(105, 85, 9, 4, 3));
    expect(aggregate.totals.byBilling.subscription).toBe(0.7);
    expect(aggregate.totals.byBilling.unknown).toBe(0);
    expect(aggregate.hasCodexEstimate).toBe(true);
    expect(aggregate.totals.hasEstimate).toBe(true);
    expect(aggregate.bySource.subagents.items).toHaveLength(2);
    expect(aggregate.chatTurnsByModel).toEqual([
      expect.objectContaining({ model: 'claude-sonnet-4', usd: 0.4 }),
    ]);
    expect(aggregate.byModel.map((item) => item.model)).toEqual([
      'claude-sonnet-4',
      'codex-mini-latest',
      'claude-haiku',
    ]);
  });

  it('counts a Codex agent split once in scope totals and pipeline-step sources', () => {
    const codexStep = record({
      entryId: 'codex-step-with-agent',
      source: 'pipeline',
      chatId: undefined,
      provider: 'codex',
      model: 'gpt-5-codex',
      billingBasis: 'api_key',
      tokens: tokens(100, 50),
      costUsd: 0.5,
      costStatus: 'estimated',
      pipeline: {
        rootExecutionId: 'codex-run',
        executionId: 'codex-run',
        pipelineName: 'Codex build',
        jobId: 'job-codex',
        stepId: 'agent-step',
        attempt: 1,
      },
      subagents: [
        attributedItem({
          id: 'codex-agent',
          kind: 'codex_agent',
          model: 'gpt-5-codex',
          tokens: tokens(25, 10),
          totalTokens: 35,
          usd: 0.1,
          costStatus: 'estimated',
          inclusion: 'included',
        }),
      ],
    });
    const summary = buildSummary(LOCATION, [], unattachedFile([codexStep]), {
      updatedAt: codexStep.completedAt ?? codexStep.startedAt,
      retentionDays: 7,
    });
    const run = buildPipelineRunViews([codexStep])[0];
    const step = run?.steps[0];

    expect(summary.totals.usd).toBe(0.5);
    expect(summary.totals.bySource.pipeline).toBe(0.4);
    expect(summary.totals.bySource.subagents).toBe(0.1);
    expect(summary.totals.tokens).toEqual(tokens(100, 50));
    expect(summary.pipelineRuns[0]?.totals).toMatchObject({
      usd: 0.5,
      bySource: {
        pipeline: 0.4,
        subagents: 0.1,
      },
      tokens: tokens(100, 50),
    });
    expect(step?.totals).toMatchObject({
      usd: 0.5,
      bySource: {
        pipeline: 0.4,
        subagents: 0.1,
      },
      tokens: tokens(100, 50),
    });
    expect(run?.subagents).toEqual([
      expect.objectContaining({
        id: 'codex-agent',
        totalTokens: 35,
        tokens: tokens(25, 10),
        usd: 0.1,
      }),
    ]);
  });

  it('sums split and total-only tokens for repeated attribution ids', () => {
    const aggregate = aggregateRecords([
      record({
        entryId: 'total-only-agent-a',
        subagents: [
          attributedItem({
            id: 'total-only-agent',
            kind: 'claude_task',
            tokens: tokens(0, 0),
            totalTokens: 30,
            usd: undefined,
            costStatus: 'not_priced',
            inclusion: 'included',
          }),
        ],
      }),
      record({
        entryId: 'total-only-agent-b',
        subagents: [
          attributedItem({
            id: 'total-only-agent',
            kind: 'claude_task',
            tokens: tokens(10, 5, 3, 1, 2),
            totalTokens: undefined,
            usd: undefined,
            costStatus: 'not_priced',
            inclusion: 'included',
          }),
        ],
      }),
    ]);

    expect(aggregate.bySource.subagents.items[0]).toMatchObject({
      id: 'total-only-agent',
      totalTokens: 49,
      tokens: tokens(10, 5, 3, 1, 2),
    });
  });

  it('keeps unpriced tokens without manufacturing dollars, including gateway work', () => {
    const aggregate = aggregateRecords([
      record({
        billingBasis: 'org_gateway',
        costUsd: 4.25,
        costStatus: 'reported',
        tokens: tokens(30, 10),
      }),
      record({
        entryId: 'turn-2',
        billingBasis: 'subscription',
        costUsd: undefined,
        costStatus: 'not_priced',
        tokens: tokens(10, 5),
      }),
    ]);

    expect(aggregate.totals.usd).toBe(0);
    expect(aggregate.totals.byBilling.org_gateway).toBe(0);
    expect(aggregate.totals.notPricedCount).toBe(2);
    expect(aggregate.totals.tokens.input).toBe(40);
    expect(aggregate.byModel).toEqual([
      expect.objectContaining({ model: 'claude-sonnet-4', notPricedCount: 2 }),
    ]);
  });

  it('aggregates activity, context, tools, compactions, model rows and token categories', () => {
    const aggregate = aggregateRecords([
      record({
        entryId: 'one',
        startedAt: '2026-10-08T10:00:00.000Z',
        durationMs: 100,
        context: {
          endTokens: 800,
          windowTokens: 1000,
          peakTokens: 900,
          categories: [{ name: 'system', tokens: 300, kind: 'used' }],
        },
        compactions: [{ at: '2026-10-08T10:00:00.500Z', trigger: 'auto' }],
        toolCounts: toolCounts({ bash: 2, read: 1 }),
        toolUseCount: 3,
        subagentCount: 1,
        planEvents: { created: 1, approved: 0 },
      }),
      record({
        entryId: 'two',
        startedAt: '2026-10-08T11:00:00.000Z',
        durationMs: 200,
        context: {
          endTokens: 900,
          windowTokens: 1000,
          peakTokens: 950,
          categories: [{ name: 'system', tokens: 450, kind: 'used' }],
        },
        compactions: [{ at: '2026-10-08T11:00:00.500Z', trigger: 'manual' }],
        toolCounts: toolCounts({ bash: 1, read: 5 }),
        toolUseCount: 6,
        subagentCount: 2,
        planEvents: { created: 0, approved: 1 },
      }),
      record({
        entryId: 'three',
        startedAt: '2026-10-08T12:00:00.000Z',
        durationMs: 300,
        context: { endTokens: 700, windowTokens: 1000 },
        toolCounts: toolCounts({ bash: 4 }),
        toolUseCount: 4,
        planEvents: { created: 2, approved: 1 },
      }),
    ]);

    expect(aggregate.turnCount).toBe(3);
    expect(aggregate.activity).toMatchObject({
      turnCount: 3,
      totalDurationMs: 600,
      averageTurnMs: 200,
      p95TurnMs: 300,
      toolCallCount: 13,
      subagentCount: 3,
      plansCreated: 3,
      plansApproved: 2,
      topTools: [
        { tool: 'bash', count: 7 },
        { tool: 'read', count: 6 },
      ],
    });
    expect(aggregate.context.latest).toEqual({
      usedTokens: 700,
      windowTokens: 1000,
      at: '2026-10-08T12:00:01.000Z',
    });
    expect(aggregate.context.peak).toEqual({
      usedTokens: 950,
      windowTokens: 1000,
    });
    expect(aggregate.context.categories).toEqual([
      { name: 'system', tokens: 450, kind: 'used' },
    ]);
    expect(aggregate.context.timeline).toEqual([
      { at: '2026-10-08T10:00:00.000Z', endTokens: 800, compaction: 'auto' },
      { at: '2026-10-08T11:00:00.000Z', endTokens: 900, compaction: 'manual' },
      { at: '2026-10-08T12:00:00.000Z', endTokens: 700 },
    ]);
    expect(aggregate.compactions).toEqual({ total: 2, auto: 1, manual: 1 });
  });

  it('is byte-for-byte deterministic regardless of input record order and rounds dollars consistently', () => {
    const values = [
      record({
        entryId: 'later',
        startedAt: '2026-10-08T11:00:00.000Z',
        costUsd: 0.000000006,
      }),
      record({
        entryId: 'earlier',
        startedAt: '2026-10-08T10:00:00.000Z',
        costUsd: 0.100000004,
      }),
    ];
    const forward = aggregateRecords(values);
    const reverse = aggregateRecords([...values].reverse());

    expect(JSON.stringify(forward)).toBe(JSON.stringify(reverse));
    expect(forward.totals.usd).toBe(0.10000001);
  });

  it('preserves all aggregate facts when older records are sealed and newer records remain live', () => {
    const beforeCategory = record({
      entryId: 'sealed-category',
      startedAt: '2026-10-08T10:00:00.000Z',
      durationMs: 100,
      context: {
        endTokens: 500,
        windowTokens: 1000,
        categories: [{ name: 'older', tokens: 100, kind: 'used' }],
      },
      toolCounts: toolCounts({ bash: 1 }),
      planEvents: { created: 1, approved: 0 },
      compactions: [{ at: '2026-10-08T10:00:00.500Z', trigger: 'auto' }],
    });
    const sealedNewestFill = record({
      entryId: 'sealed-latest-fill',
      startedAt: '2026-10-08T12:00:00.000Z',
      durationMs: 200,
      context: { endTokens: 900, windowTokens: 1000 },
      toolCounts: toolCounts({ read: 2 }),
      planEvents: { created: 0, approved: 1 },
      compactions: [{ at: '2026-10-08T12:00:00.500Z', trigger: 'manual' }],
    });
    const newerCategoryWithOlderFill = record({
      entryId: 'live-intermediate-category',
      startedAt: '2026-10-08T11:00:00.000Z',
      durationMs: 300,
      context: {
        endTokens: 700,
        windowTokens: 1000,
        categories: [{ name: 'newer', tokens: 250, kind: 'used' }],
      },
      toolCounts: toolCounts({ bash: 4, read: 1 }),
      planEvents: { created: 2, approved: 1 },
      compactions: [{ at: '2026-10-08T11:00:00.500Z', trigger: 'unknown' }],
    });
    const allRecords = [
      beforeCategory,
      sealedNewestFill,
      newerCategoryWithOlderFill,
    ];
    const complete = aggregateRecords(allRecords);
    const sealed = aggregateRecords([beforeCategory, sealedNewestFill]);
    const sealedThenLive = aggregateRecords(
      [newerCategoryWithOlderFill],
      sealed,
    );

    expect(sealed.context.latest?.at).toBe('2026-10-08T12:00:01.000Z');
    expect(sealed.contextCategoriesAt).toBe('2026-10-08T10:00:01.000Z');
    expect(sealedThenLive.context.latest?.at).toBe('2026-10-08T12:00:01.000Z');
    expect(sealedThenLive.context.categories).toEqual([
      { name: 'newer', tokens: 250, kind: 'used' },
    ]);
    expect(sealedThenLive.contextCategoriesAt).toBe('2026-10-08T11:00:01.000Z');
    expect(sealedThenLive).toEqual(complete);
  });
});

describe('cost read model projections', () => {
  it('builds cached summary facts without storing labels or host paths, then joins labels and archive state at read time', () => {
    const file = chatFile([
      record({
        tokens: tokens(100, 50),
        costUsd: 0.4,
        durationMs: 300,
      }),
    ]);
    const summary = buildSummary(LOCATION, [file], unattachedFile(), {
      updatedAt: '2026-10-08T12:00:00.000Z',
      coverageStart: '2026-10-03',
      retentionDays: 14,
      revision: 8,
    });

    expect(summary.chats).toHaveLength(1);
    const summaryChat = summary.chats[0];
    expect(summaryChat?.chatId).toBe('chat-1');
    expect(summaryChat?.totals.usd).toBe(0.4);
    expect(summaryChat?.turnCount).toBe(1);
    expect(summaryChat?.models).toEqual(['claude-sonnet-4']);
    expect(summaryChat?.running).toBe(false);
    expect(JSON.stringify(summary)).not.toContain('worktree-path');
    expect(JSON.stringify(summary)).not.toContain('label');

    const live = projectScopeView(
      summary,
      ENTRY_SCOPE,
      [
        {
          chatId: 'chat-1',
          label: 'Renamed chat',
          state: 'open',
          createdAt: '2026-10-01T12:00:00.000Z',
          running: true,
        },
        {
          chatId: 'not-in-summary',
          label: 'Blank chat',
          state: 'open',
        },
      ],
      7,
    );

    expect(live.retentionDays).toBe(14);
    expect(live.building).toBe(false);
    expect(live.chats).toEqual([
      expect.objectContaining({
        chatId: 'chat-1',
        label: 'Renamed chat',
        state: 'open',
        running: true,
        coverageStart: '2026-10-03',
      }),
    ]);

    const retainedScope = {
      kind: 'retained',
      projectId: 'project-1',
      containerId: 'archive-1',
    } as const;
    const retained = projectScopeView(
      { ...summary, sealedAt: '2026-10-08T12:30:00.000Z' },
      retainedScope,
      [
        {
          chatId: 'chat-1',
          label: 'Archived label',
          state: 'open',
          running: true,
        },
      ],
      7,
    );
    expect(retained.sealedAt).toBe('2026-10-08T12:30:00.000Z');
    expect(retained.chats[0]).toMatchObject({
      label: 'Archived label',
      state: 'archived',
      running: false,
    });
  });

  it('returns a building empty scope before its first summary exists', () => {
    expect(projectScopeView(null, ENTRY_SCOPE, [], 0)).toMatchObject({
      scope: ENTRY_SCOPE,
      updatedAt: null,
      building: true,
      retentionDays: 1,
      totals: createEmptyCostTotals(),
      chats: [],
      pipelineRuns: [],
      hasCodexEstimate: false,
    });
  });

  it('projects summary, full and subagent chat views and handles a missing item generically', () => {
    const item = attributedItem({ id: 'native-1', usd: 0.03 });
    const file = chatFile([
      record({
        costUsd: 0.1,
        subagents: [item],
        context: { endTokens: 30, windowTokens: 100 },
        planEvents: { created: 1, approved: 1 },
      }),
    ]);
    const summary = buildSummary(LOCATION, [file], unattachedFile(), {
      updatedAt: '2026-10-08T12:00:00.000Z',
      retentionDays: 7,
      revision: 1,
    });
    const identity = {
      chatId: 'chat-1',
      label: 'Session label',
      state: 'archived' as const,
      running: true,
    };

    expect(
      projectChatView(file, summary, ENTRY_SCOPE, identity, {
        scope: ENTRY_SCOPE,
        chatId: 'chat-1',
        detail: 'summary',
      }),
    ).toMatchObject({
      kind: 'summary',
      chat: { label: 'Session label', state: 'archived' },
    });

    const full = projectChatView(file, summary, ENTRY_SCOPE, identity, {
      scope: ENTRY_SCOPE,
      chatId: 'chat-1',
      detail: 'full',
    });
    expect(full).toMatchObject({
      kind: 'full',
      breakdown: {
        updatedAt: '2026-10-08T12:00:00.000Z',
        bySource: { chat: { usd: 0.1 }, subagents: { usd: 0.03 } },
        context: { latest: { usedTokens: 30 } },
        activity: { plansCreated: 1, plansApproved: 1 },
      },
    });

    expect(
      projectChatView(file, summary, ENTRY_SCOPE, identity, {
        scope: ENTRY_SCOPE,
        chatId: 'chat-1',
        subagentId: 'native-1',
      }),
    ).toMatchObject({
      kind: 'subagent',
      item: { id: 'native-1', usd: 0.03 },
    });
    // A miss is reported as absent, never as a failure of the read.
    expect(
      projectChatView(file, summary, ENTRY_SCOPE, identity, {
        scope: ENTRY_SCOPE,
        chatId: 'chat-1',
        subagentId: 'missing-private-id',
      }),
    ).toBeNull();

    expect(
      projectChatView(file, null, ENTRY_SCOPE, undefined, {
        scope: ENTRY_SCOPE,
        chatId: 'chat-1',
        detail: 'full',
      }),
    ).toMatchObject({
      kind: 'full',
      breakdown: { updatedAt: null, chat: { label: 'Chat' } },
    });
  });

  it('reports a child run whose work could not be priced', () => {
    const views = buildPipelineRunViews([
      record({
        entryId: 'root-step',
        source: 'pipeline',
        chatId: undefined,
        startedAt: '2026-10-08T10:00:00.000Z',
        costUsd: 0.4,
        tokens: tokens(60, 10),
        pipeline: {
          rootExecutionId: 'run-root',
          executionId: 'run-root',
          pipelineName: 'Build',
          jobId: 'job-a',
          stepId: 'test',
          attempt: 1,
        },
      }),
      record({
        entryId: 'child-step',
        source: 'pipeline',
        chatId: undefined,
        startedAt: '2026-10-08T10:20:00.000Z',
        costUsd: undefined,
        costStatus: 'not_priced',
        billingBasis: 'org_gateway',
        tokens: tokens(50, 15),
        pipeline: {
          rootExecutionId: 'run-root',
          executionId: 'run-child',
          pipelineName: 'Gateway child',
          jobId: 'job-b',
          stepId: 'package',
          attempt: 1,
        },
      }),
    ]);

    expect(views[0]?.childRuns).toEqual([
      {
        executionId: 'run-child',
        pipelineName: 'Gateway child',
        usd: 0,
        agentStepCount: 1,
        notPricedCount: 1,
      },
    ]);
  });

  it('rolls retries, child runs, advisor reports, subagents and delegations into one root run', () => {
    const records = [
      record({
        entryId: 'root-attempt-1',
        source: 'pipeline',
        chatId: undefined,
        provider: 'claude',
        startedAt: '2026-10-08T10:00:00.000Z',
        tokens: tokens(100, 40),
        costUsd: 1,
        pipeline: {
          rootExecutionId: 'run-root',
          executionId: 'run-root',
          pipelineName: 'Build',
          jobId: 'job-a',
          stepId: 'test',
          attempt: 1,
        },
        subagents: [
          attributedItem({
            id: 'native-agent',
            kind: 'codex_agent',
            model: 'codex-mini-latest',
            usd: 0.05,
            costStatus: 'estimated',
          }),
        ],
      }),
      record({
        entryId: 'root-attempt-2',
        source: 'pipeline',
        chatId: undefined,
        provider: 'claude',
        startedAt: '2026-10-08T10:10:00.000Z',
        tokens: tokens(80, 20),
        costUsd: 0.5,
        pipeline: {
          rootExecutionId: 'run-root',
          executionId: 'run-root',
          pipelineName: 'Build',
          jobId: 'job-a',
          stepId: 'test',
          attempt: 2,
        },
      }),
      record({
        entryId: 'child-step',
        source: 'pipeline',
        chatId: undefined,
        startedAt: '2026-10-08T10:20:00.000Z',
        costUsd: 0.2,
        tokens: tokens(50, 15),
        pipeline: {
          rootExecutionId: 'run-root',
          executionId: 'run-child',
          pipelineName: 'Nested package',
          jobId: 'job-b',
          stepId: 'package',
          attempt: 1,
        },
      }),
      record({
        entryId: 'advisor-1',
        source: 'background',
        chatId: undefined,
        helperKind: 'pipeline_advisor',
        startedAt: '2026-10-08T10:30:00.000Z',
        costUsd: 0.1,
        tokens: tokens(10, 2),
        pipeline: { rootExecutionId: 'run-root', executionId: 'run-root' },
      }),
      record({
        entryId: 'delegation-1',
        source: 'delegation',
        chatId: undefined,
        provider: 'codex',
        startedAt: '2026-10-08T10:40:00.000Z',
        costUsd: 0.3,
        tokens: tokens(20, 5),
        pipeline: { rootExecutionId: 'run-root', executionId: 'run-root' },
        delegation: attributedItem({
          id: 'delegation-1',
          kind: 'delegation',
          label: 'Delegate',
          harness: 'codex',
          tokens: tokens(20, 5),
          usd: 0.3,
          runCount: 1,
          status: 'completed',
        }),
      }),
    ];
    const views = buildPipelineRunViews(records);
    const run = views[0];

    expect(views).toHaveLength(1);
    expect(run?.run).toMatchObject({
      executionId: 'run-root',
      pipelineName: 'Build',
      status: 'succeeded',
      totals: { usd: 2.15 },
      agentStepCount: 2,
    });
    expect(run?.steps).toHaveLength(2);
    const rootStep = run?.steps.find((step) => step.executionId === 'run-root');
    expect(rootStep).toMatchObject({
      jobId: 'job-a',
      stepId: 'test',
      attemptCount: 2,
    });
    expect(rootStep?.totals.usd).toBe(1.55);
    expect(rootStep?.totals.bySource).toEqual({
      chat: 0,
      pipeline: 1.5,
      subagents: 0.05,
      delegations: 0,
      background: 0,
    });
    const childStep = run?.steps.find(
      (step) => step.executionId === 'run-child',
    );
    expect(childStep).toMatchObject({
      jobId: 'job-b',
      stepId: 'package',
      attemptCount: 1,
    });
    expect(childStep?.totals.usd).toBe(0.2);
    expect(run?.childRuns).toEqual([
      {
        executionId: 'run-child',
        pipelineName: 'Nested package',
        usd: 0.2,
        agentStepCount: 1,
      },
    ]);
    expect(run?.advisor).toEqual({
      reportCount: 1,
      usd: 0.1,
      notPricedCount: 0,
    });
    expect(run?.subagents).toEqual([
      expect.objectContaining({ id: 'native-agent', kind: 'codex_agent' }),
    ]);
    expect(run?.delegations).toEqual([
      expect.objectContaining({ id: 'delegation-1', harness: 'codex' }),
    ]);
    expect(run?.byModel.map((model) => model.model)).toContain(
      'codex-mini-latest',
    );
    expect(
      buildPipelineRunViews(
        records.filter((item) => item.source === 'background'),
      ),
    ).toEqual([]);
  });

  it('flags a partially priced Codex amount as an estimate, but not a Claude one', () => {
    const codex = aggregateRecords([
      record({
        entryId: 'codex-partial',
        provider: 'codex',
        model: 'gpt-5-codex',
        costUsd: 0.3,
        costStatus: 'partial',
      }),
    ]);
    expect(codex.totals.usd).toBe(0.3);
    expect(codex.totals.hasEstimate).toBe(true);
    expect(codex.hasCodexEstimate).toBe(true);

    // Claude reports the priced part; it is incomplete, not an estimate.
    const claude = aggregateRecords([
      record({ entryId: 'claude-partial', costStatus: 'partial' }),
    ]);
    expect(claude.totals.hasEstimate).toBe(false);
    expect(claude.hasCodexEstimate).toBe(false);
  });

  it('counts Monitor calls among the top tools', () => {
    const aggregate = aggregateRecords([
      record({
        entryId: 'monitoring',
        toolCounts: toolCounts({ monitor: 3, bash: 1 }),
      }),
    ]);

    expect(aggregate.activity.topTools).toEqual([
      { tool: 'monitor', count: 3 },
      { tool: 'bash', count: 1 },
    ]);
    // With no reported total, the tool counts are the total.
    expect(aggregate.activity.toolCallCount).toBe(4);
  });

  it('keeps script-only executions out of run views and scope summaries', () => {
    const summary = buildSummary(LOCATION, [], unattachedFile(), {
      updatedAt: '2026-10-08T12:00:00.000Z',
      retentionDays: 7,
      revision: 1,
    });

    expect(buildPipelineRunViews([])).toEqual([]);
    expect(summary.pipelineRuns).toEqual([]);
    expect(summary.chats).toEqual([]);
  });

  it('keeps a sealed run unchanged when no later audit lines arrive', () => {
    const [sealed] = buildPipelineRunViews([
      record({
        entryId: 'sealed-step',
        source: 'pipeline',
        chatId: undefined,
        startedAt: '2026-10-08T10:00:00.000Z',
        costUsd: 0.4,
        tokens: tokens(60, 10),
        pipeline: {
          rootExecutionId: 'run-root',
          executionId: 'run-root',
          pipelineName: 'Build',
          jobId: 'job-a',
          stepId: 'test',
          attempt: 1,
        },
      }),
    ]);
    if (!sealed) throw new Error('expected a sealed run view');

    const [reread] = buildPipelineRunViews([], { 'run-root': sealed });

    expect(reread?.run.startedAt).toBe('2026-10-08T10:00:00.000Z');
    expect(reread).toEqual(sealed);
  });

  it('labels steps with their names from the run state, read at read time', () => {
    const runRecord = record({
      entryId: 'run-turn',
      source: 'pipeline',
      chatId: undefined,
      pipeline: {
        rootExecutionId: 'run-1',
        executionId: 'run-1',
        pipelineName: 'Build',
        jobId: 'job-1',
        stepId: 'step-1',
        attempt: 1,
      },
    });
    const unnamedRecord = record({
      entryId: 'run-turn-2',
      source: 'pipeline',
      chatId: undefined,
      pipeline: {
        rootExecutionId: 'run-1',
        executionId: 'run-1',
        pipelineName: 'Build',
        jobId: 'job-2',
        stepId: 'step-2',
        attempt: 1,
      },
    });
    const unattached = unattachedFile([runRecord, unnamedRecord]);

    const named = projectPipelineRunView(
      unattached,
      null,
      ENTRY_SCOPE,
      'run-1',
      {
        stepNames: { 'run-1/job-1/step-1': 'Review changes' },
      },
    );
    const labels = Object.fromEntries(
      (named?.steps ?? []).map((step) => [step.stepId, step.label]),
    );
    expect(labels).toEqual({ 'step-1': 'Review changes', 'step-2': 'step-2' });

    const retained = projectPipelineRunView(
      unattached,
      null,
      { kind: 'retained', projectId: 'project-1', containerId: 'archive-1' },
      'run-1',
      { stepNames: { 'run-1/job-1/step-1': 'Review changes' } },
    );
    expect(
      retained?.steps.find((step) => step.stepId === 'step-1')?.label,
    ).toBe('Review changes');
    // The stored file still holds only the id.
    expect(JSON.stringify(unattached)).not.toContain('Review changes');
  });

  it('projects live run state on demand and keeps retained runs sealed', () => {
    const runRecord = record({
      entryId: 'run-turn',
      source: 'pipeline',
      chatId: undefined,
      pipeline: {
        rootExecutionId: 'run-1',
        executionId: 'run-1',
        pipelineName: 'Build',
        jobId: 'job-1',
        stepId: 'step-1',
        attempt: 1,
      },
    });
    const unattached = unattachedFile([runRecord]);
    const summary = buildSummary(LOCATION, [], unattached, {
      updatedAt: '2026-10-08T12:00:00.000Z',
      retentionDays: 7,
      revision: 3,
      sealedAt: '2026-10-08T12:30:00.000Z',
    });
    const live = projectPipelineRunView(
      unattached,
      summary,
      ENTRY_SCOPE,
      'run-1',
      {
        nonAgentStepCount: 3,
        status: 'failed',
        pipelineName: 'Renamed at read time',
      },
    );

    expect(live).toMatchObject({
      updatedAt: '2026-10-08T12:00:00.000Z',
      nonAgentStepCount: 3,
      run: { status: 'failed', pipelineName: 'Renamed at read time' },
    });
    expect(
      projectPipelineRunView(unattached, null, ENTRY_SCOPE, 'run-1', null),
    ).toMatchObject({
      updatedAt: null,
      run: { executionId: 'run-1', status: 'succeeded' },
    });

    const retained = projectPipelineRunView(
      unattached,
      summary,
      { kind: 'retained', projectId: 'project-1', containerId: 'archive-1' },
      'run-1',
      { status: 'failed', pipelineName: 'Must not override retained run' },
    );
    expect(retained).toMatchObject({
      sealedAt: '2026-10-08T12:30:00.000Z',
      run: { status: 'succeeded', pipelineName: 'Build' },
    });
    expect(
      projectPipelineRunView(unattached, summary, ENTRY_SCOPE, 'missing', null),
    ).toBeNull();
  });

  it('reads the non-agent step count stored with a sealed run', () => {
    const [sealedRun] = buildPipelineRunViews([
      record({
        entryId: 'run-turn',
        source: 'pipeline',
        chatId: undefined,
        pipeline: {
          rootExecutionId: 'run-1',
          executionId: 'run-1',
          pipelineName: 'Build',
          jobId: 'job-1',
          stepId: 'step-1',
          attempt: 1,
        },
      }),
    ]);
    if (sealedRun === undefined) throw new Error('Test run missing');
    const unattached = unattachedFile([], {
      sealedRuns: { 'run-1': { ...sealedRun, nonAgentStepCount: 4 } },
    });
    const summary = buildSummary(LOCATION, [], unattached, {
      updatedAt: '2026-10-08T12:00:00.000Z',
      retentionDays: 7,
      revision: 3,
      sealedAt: '2026-10-08T12:30:00.000Z',
    });

    // An archived entry has no execution state to read the count from.
    expect(
      projectPipelineRunView(
        unattached,
        summary,
        { kind: 'retained', projectId: 'project-1', containerId: 'archive-1' },
        'run-1',
        null,
      )?.nonAgentStepCount,
    ).toBe(4);
    // Nor does a live entry whose execution can no longer be read.
    expect(
      projectPipelineRunView(unattached, summary, ENTRY_SCOPE, 'run-1', null)
        ?.nonAgentStepCount,
    ).toBe(4);
    // While the execution can be read, its count wins.
    expect(
      projectPipelineRunView(unattached, summary, ENTRY_SCOPE, 'run-1', {
        nonAgentStepCount: 6,
      })?.nonAgentStepCount,
    ).toBe(6);
  });
});

describe('cost read model account proxy accounts', () => {
  const SAM = 'a1f3c2d4a1f3c2d4';
  const TEAM = 'e2a8f640e2a8f640';

  function proxyRecord(
    entryId: string,
    accounts: NonNullable<CostTurnRecord['accountProxy']>['accounts'],
    overrides: Partial<CostTurnRecord> = {},
  ): CostTurnRecord {
    return record({
      entryId,
      billingBasis: 'account_proxy',
      accountProxy: { connectionId: 'conn-1', accounts },
      ...overrides,
    });
  }

  it('splits each turn and its estimate between the accounts by requests', () => {
    const aggregate = aggregateRecords([
      proxyRecord('turn-1', [{ authIndex: SAM, requests: 2 }], {
        costUsd: 0.2,
      }),
      proxyRecord(
        'turn-2',
        [
          {
            authIndex: TEAM,
            provider: 'claude',
            requests: 3,
          },
          { authIndex: SAM, requests: 1 },
        ],
        { startedAt: '2026-10-08T11:00:00.000Z', costUsd: 0.4 },
      ),
      // Not served by the proxy: no account row.
      record({ entryId: 'turn-3', startedAt: '2026-10-08T12:00:00.000Z' }),
    ]);

    expect(aggregate.byProxyAccount).toEqual([
      {
        accountKey: `proxy:conn-1:${SAM}`,
        label: '',
        turnShare: 1.25,
        requestCount: 3,
        usd: 0.3,
        notPricedCount: 0,
      },
      {
        accountKey: `proxy:conn-1:${TEAM}`,
        label: '',
        provider: 'claude',
        turnShare: 0.75,
        requestCount: 3,
        usd: 0.3,
        notPricedCount: 0,
      },
    ]);
  });

  it('counts unpriced proxy work without inventing dollars', () => {
    const aggregate = aggregateRecords([
      proxyRecord('turn-1', [{ authIndex: SAM, requests: 1 }], {
        costUsd: undefined,
        costStatus: 'not_priced',
      }),
    ]);
    expect(aggregate.byProxyAccount).toEqual([
      expect.objectContaining({ usd: 0, notPricedCount: 1, label: '' }),
    ]);
  });

  it('leaves chats the proxy never served without account rows', () => {
    const aggregate = aggregateRecords([record()]);
    expect(aggregate).not.toHaveProperty('byProxyAccount');
    const summary = buildSummary(
      LOCATION,
      [chatFile([record()])],
      unattachedFile(),
      { updatedAt: '2026-10-08T12:00:00.000Z', retentionDays: 7, revision: 1 },
    );
    expect(summary.chats[0]).not.toHaveProperty('proxyAccounts');
  });

  it('keeps the accounts when older turns are sealed', () => {
    const older = proxyRecord('turn-1', [{ authIndex: SAM, requests: 1 }]);
    const newer = proxyRecord('turn-2', [{ authIndex: SAM, requests: 1 }], {
      startedAt: '2026-10-08T11:00:00.000Z',
    });
    const sealedThenLive = aggregateRecords([newer], aggregateRecords([older]));
    expect(sealedThenLive).toEqual(aggregateRecords([older, newer]));
    // Labels are joined when a view is read, never stored.
    expect(sealedThenLive.byProxyAccount?.[0]?.label).toBe('');
  });

  it('shows the chat accounts on its summary row and in its views', () => {
    const file = chatFile([
      proxyRecord('turn-1', [{ authIndex: SAM, requests: 2 }], {
        subagents: [
          attributedItem({ id: 'task-1', billingBasis: 'account_proxy' }),
        ],
      }),
    ]);
    const summary = buildSummary(LOCATION, [file], unattachedFile(), {
      updatedAt: '2026-10-08T12:00:00.000Z',
      retentionDays: 7,
      revision: 1,
    });
    const identity = {
      chatId: 'chat-1',
      label: 'Chat',
      state: 'open' as const,
    };
    const expected = [
      expect.objectContaining({
        accountKey: `proxy:conn-1:${SAM}`,
        label: '',
        turnShare: 1,
      }),
    ];
    expect(summary.chats[0]?.proxyAccounts).toEqual(expected);
    expect(
      projectScopeView(summary, ENTRY_SCOPE, [identity], 7).chats[0]
        ?.proxyAccounts,
    ).toEqual(expected);
    expect(
      projectChatView(file, summary, ENTRY_SCOPE, identity, {
        scope: ENTRY_SCOPE,
        chatId: 'chat-1',
        detail: 'summary',
      }),
    ).toMatchObject({ kind: 'summary', chat: { proxyAccounts: expected } });
  });

  it('shows the accounts per step and per run, sealed or not', () => {
    const step = (
      entryId: string,
      attempt: number,
      authIndex: string,
      startedAt: string,
    ): CostTurnRecord =>
      proxyRecord(entryId, [{ authIndex, requests: 1 }], {
        source: 'pipeline',
        chatId: undefined,
        startedAt,
        costUsd: 0.2,
        pipeline: {
          rootExecutionId: 'run-root',
          executionId: 'run-root',
          pipelineName: 'Build',
          jobId: 'job-a',
          stepId: 'test',
          attempt,
        },
      });
    const first = step('attempt-1', 1, SAM, '2026-10-08T10:00:00.000Z');
    const retry = step('attempt-2', 2, TEAM, '2026-10-08T11:00:00.000Z');
    const [live] = buildPipelineRunViews([first, retry]);
    const [sealed] = buildPipelineRunViews([first]);
    if (!sealed) throw new Error('expected a sealed run view');
    const [sealedThenLive] = buildPipelineRunViews([retry], {
      'run-root': sealed,
    });

    const accounts = [
      expect.objectContaining({
        accountKey: `proxy:conn-1:${SAM}`,
        turnShare: 1,
        usd: 0.2,
      }),
      expect.objectContaining({
        accountKey: `proxy:conn-1:${TEAM}`,
        turnShare: 1,
        usd: 0.2,
      }),
    ];
    expect(live?.steps[0]?.proxyAccounts).toEqual(accounts);
    expect(live?.byProxyAccount).toEqual(accounts);
    expect(sealedThenLive?.steps[0]?.proxyAccounts).toEqual(accounts);
    expect(sealedThenLive?.byProxyAccount).toEqual(accounts);
  });
});
