/**
 * Plain cost views of the real shapes, drawn by `CostViewFrame` as measured
 * skeletons during a view's first read. Short names and small figures only:
 * the skeleton shows their shape, never their text.
 */
import {
  createEmptyCostTotals,
  EMPTY_COST_TOKEN_TOTALS,
  type CostChatRow,
  type CostModelRow,
  type CostPipelineRunRow,
  type CostScopeRef,
  type CostScopeView,
  type CostTotals,
  type PipelineRunCostView,
  type SessionBreakdownView,
} from '@canopy/protocol/cost-view';

const SAMPLE_SCOPE: CostScopeRef = {
  kind: 'entry',
  projectId: 'sample-project',
  worktreeId: 'sample-worktree',
};

const SAMPLE_AT = '2026-01-01T12:00:00.000Z';

function sampleTotals(chat: number, pipeline: number): CostTotals {
  const empty = createEmptyCostTotals();
  const usd = chat + pipeline;
  return {
    ...empty,
    usd,
    bySource: { ...empty.bySource, chat, pipeline },
    byBilling: { ...empty.byBilling, subscription: usd },
    tokens: { ...EMPTY_COST_TOKEN_TOTALS, input: 1200, output: 800 },
  };
}

function sampleChat(chatId: string, label: string, usd: number): CostChatRow {
  return {
    chatId,
    label,
    state: 'open',
    totals: sampleTotals(usd, 0),
    turnCount: 4,
    lastActivityAt: SAMPLE_AT,
    running: false,
    models: ['Sonnet'],
  };
}

function sampleModel(model: string, usd: number): CostModelRow {
  return {
    model,
    turnCount: 3,
    usd,
    notPricedCount: 0,
    tokens: sampleTotals(usd, 0).tokens,
  };
}

const SAMPLE_RUN: CostPipelineRunRow = {
  executionId: 'sample-run',
  pipelineName: 'Checks',
  startedAt: SAMPLE_AT,
  status: 'succeeded',
  totals: sampleTotals(0, 0.4),
  agentStepCount: 2,
};

/** An entry with two chats and one workflow run. */
export const COST_SCOPE_VIEW_SAMPLE: CostScopeView = {
  scope: SAMPLE_SCOPE,
  updatedAt: SAMPLE_AT,
  building: false,
  retentionDays: 7,
  totals: sampleTotals(1.8, 0.4),
  chats: [
    sampleChat('sample-chat-1', 'Fix the login test', 1.2),
    sampleChat('sample-chat-2', 'Update the docs', 0.6),
  ],
  pipelineRuns: [SAMPLE_RUN],
  hasCodexEstimate: false,
};

/** One chat's breakdown: chat turns only, two models. */
export const SESSION_BREAKDOWN_VIEW_SAMPLE: SessionBreakdownView = {
  chat: sampleChat('sample-chat-1', 'Fix the login test', 1.2),
  updatedAt: SAMPLE_AT,
  bySource: {
    chat: { usd: 1.2, turnCount: 4 },
    subagents: { usd: 0, items: [] },
    delegations: { usd: 0, items: [] },
    background: { usd: 0, rows: [] },
  },
  chatTurnsByModel: [sampleModel('Sonnet', 0.8), sampleModel('Haiku', 0.4)],
  byModel: [sampleModel('Sonnet', 0.8), sampleModel('Haiku', 0.4)],
  context: { categories: [], timeline: [] },
  compactions: { total: 0, auto: 0, manual: 0 },
  activity: {
    turnCount: 4,
    totalDurationMs: 120_000,
    averageTurnMs: 30_000,
    p95TurnMs: 45_000,
    toolCallCount: 12,
    subagentCount: 0,
    plansCreated: 0,
    plansApproved: 0,
    topTools: [
      { tool: 'read', count: 8 },
      { tool: 'bash', count: 4 },
    ],
  },
};

/** A workflow run with two agent steps. */
export const PIPELINE_RUN_COST_VIEW_SAMPLE: PipelineRunCostView = {
  run: SAMPLE_RUN,
  updatedAt: SAMPLE_AT,
  steps: [
    {
      jobId: 'sample-review',
      stepId: 'sample-review',
      label: 'Review',
      attemptCount: 1,
      model: 'Sonnet',
      totals: sampleTotals(0, 0.3),
      executionId: 'sample-run',
    },
    {
      jobId: 'sample-fix',
      stepId: 'sample-fix',
      label: 'Fix lint',
      attemptCount: 1,
      model: 'Haiku',
      totals: sampleTotals(0, 0.1),
      executionId: 'sample-run',
    },
  ],
  subagents: [],
  delegations: [],
  childRuns: [],
  byModel: [sampleModel('Sonnet', 0.3), sampleModel('Haiku', 0.1)],
};
