/**
 * Shared test helpers for the cost views: a fake `CostClient` whose reads
 * resolve from editable fixtures (or stay pending on demand), builders for
 * the `@canopy/protocol/cost-view` DTOs, and a render wrapper that supplies
 * the host's `costInsights` capability through `CanopyClientProvider`.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyCapabilities,
  CanopyClient,
  CostClient,
} from '@canopy/app-core';
import { CanopyClientProvider } from '@canopy/app-state';
import {
  createEmptyCostTotals,
  type CostAttributedItem,
  type CostChatRow,
  type CostChatView,
  type CostPipelineRunRow,
  type CostRefreshReceipt,
  type CostScopeRef,
  type CostScopeView,
  type CostTotals,
  type CostUpdatedEvent,
  type CostViewResult,
  type PipelineRunCostView,
  type SessionBreakdownView,
} from '@canopy/protocol/cost-view';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

export const ENTRY_SCOPE: CostScopeRef = {
  kind: 'entry',
  projectId: 'project-1',
  worktreeId: 'worktree-1',
};

export const RETAINED_SCOPE: CostScopeRef = {
  kind: 'retained',
  projectId: 'project-1',
  containerId: 'container-1',
};

/** A fixed clock: 2026-10-08 12:00 local time. */
export const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime();

/** `minutesAgo(4)` -> an ISO timestamp four minutes before {@link NOW}. */
export function minutesAgo(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

export function totals(
  parts: {
    readonly chat?: number;
    readonly pipeline?: number;
    readonly subagents?: number;
    readonly delegations?: number;
    readonly background?: number;
    readonly subscription?: number;
    readonly ai_credits?: number;
    readonly api_key?: number;
    readonly account_proxy?: number;
    readonly notPricedCount?: number;
    readonly hasEstimate?: boolean;
  } = {},
): CostTotals {
  const empty = createEmptyCostTotals();
  const bySource = {
    chat: parts.chat ?? 0,
    pipeline: parts.pipeline ?? 0,
    subagents: parts.subagents ?? 0,
    delegations: parts.delegations ?? 0,
    background: parts.background ?? 0,
  };
  const usd = Object.values(bySource).reduce((sum, value) => sum + value, 0);
  const paid =
    (parts.ai_credits ?? 0) + (parts.api_key ?? 0) + (parts.account_proxy ?? 0);
  return {
    ...empty,
    usd,
    bySource,
    byBilling: {
      ...empty.byBilling,
      subscription: parts.subscription ?? Math.max(usd - paid, 0),
      ai_credits: parts.ai_credits ?? 0,
      api_key: parts.api_key ?? 0,
      account_proxy: parts.account_proxy ?? 0,
    },
    tokens: {
      input: 1200,
      output: 3400,
      cacheReadInputTokens: 56000,
      cacheCreationInputTokens: 7800,
      reasoningOutputTokens: 900,
    },
    notPricedCount: parts.notPricedCount ?? 0,
    hasEstimate: parts.hasEstimate ?? false,
  };
}

export function chatRow(overrides: Partial<CostChatRow> = {}): CostChatRow {
  return {
    chatId: 'chat-1',
    label: 'Add cost index checkpoints',
    state: 'open',
    totals: totals({
      chat: 4.1,
      subagents: 1.2,
      delegations: 1.3,
      background: 0.24,
    }),
    turnCount: 42,
    lastActivityAt: minutesAgo(10),
    running: false,
    models: ['Sonnet 5.5'],
    ...overrides,
  };
}

export function runRow(
  overrides: Partial<CostPipelineRunRow> = {},
): CostPipelineRunRow {
  return {
    executionId: 'run-1',
    pipelineName: 'Release checks',
    startedAt: new Date(2026, 9, 8, 9, 12).toISOString(),
    status: 'succeeded',
    totals: totals({ pipeline: 0.93, subagents: 0.12, background: 0.05 }),
    agentStepCount: 2,
    ...overrides,
  };
}

export function scopeView(
  overrides: Partial<CostScopeView> = {},
): CostScopeView {
  const chats = overrides.chats ?? [
    chatRow(),
    chatRow({
      chatId: 'chat-2',
      label: 'Fix flaky checkout test',
      state: 'archived',
      totals: totals({ chat: 2.62, subagents: 0.31, background: 0.17 }),
      turnCount: 18,
      lastActivityAt: minutesAgo(600),
    }),
  ];
  const pipelineRuns = overrides.pipelineRuns ?? [runRow()];
  return {
    scope: ENTRY_SCOPE,
    updatedAt: minutesAgo(4),
    building: false,
    retentionDays: 7,
    totals: totals({
      chat: 6.72,
      pipeline: 0.93,
      subagents: 1.63,
      delegations: 1.3,
      background: 0.82,
    }),
    chats,
    pipelineRuns,
    unattached: totals({ background: 0.36 }),
    hasCodexEstimate: false,
    ...overrides,
  };
}

export function attributedItem(
  overrides: Partial<CostAttributedItem> = {},
): CostAttributedItem {
  return {
    id: 'sub-1',
    kind: 'claude_task',
    label: 'Explore the audit stream',
    model: 'Haiku 4.5',
    billingBasis: 'subscription',
    tokens: totals().tokens,
    usd: 0.4,
    costStatus: 'reported',
    inclusion: 'included',
    ...overrides,
  };
}

export function breakdownView(
  overrides: Partial<SessionBreakdownView> = {},
): SessionBreakdownView {
  return {
    chat: chatRow({ running: true, models: ['Sonnet 5.5', 'Opus 5.5'] }),
    updatedAt: minutesAgo(4),
    bySource: {
      chat: { usd: 4.1, turnCount: 42 },
      subagents: { usd: 1.2, items: [attributedItem()] },
      delegations: {
        usd: 1.3,
        items: [
          attributedItem({
            id: 'del-1',
            kind: 'delegation',
            label: 'Write the store tests',
            model: 'GPT 6 Luna',
            harness: 'Codex',
            billingBasis: 'ai_credits',
            usd: 1.3,
            costStatus: 'estimated',
            inclusion: 'additional',
            runCount: 2,
            status: 'completed',
          }),
        ],
      },
      background: {
        usd: 0.24,
        rows: [
          {
            kind: 'chat_title',
            runCount: 3,
            usd: 0.04,
            notPricedCount: 0,
            tokens: totals().tokens,
          },
          {
            kind: 'commit_message',
            runCount: 2,
            usd: 0.2,
            notPricedCount: 0,
            tokens: totals().tokens,
          },
        ],
      },
    },
    chatTurnsByModel: [
      {
        model: 'Sonnet 5.5',
        turnCount: 30,
        usd: 2.6,
        notPricedCount: 0,
        tokens: totals().tokens,
      },
      {
        model: 'Opus 5.5',
        turnCount: 12,
        usd: 1.5,
        notPricedCount: 0,
        tokens: totals().tokens,
      },
    ],
    byModel: [
      {
        model: 'Sonnet 5.5',
        turnCount: 30,
        usd: 3.9,
        notPricedCount: 0,
        tokens: totals().tokens,
      },
      {
        model: 'Opus 5.5',
        turnCount: 12,
        usd: 2.94,
        notPricedCount: 0,
        tokens: totals().tokens,
      },
    ],
    context: {
      latest: { usedTokens: 120_400, windowTokens: 200_000, at: minutesAgo(5) },
      categories: [
        { name: 'System prompt', tokens: 3_100, kind: 'used' },
        { name: 'Messages', tokens: 117_300, kind: 'used' },
        { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' },
        { name: 'Free space', tokens: 46_600, kind: 'free' },
      ],
      peak: { usedTokens: 174_400, windowTokens: 200_000 },
      timeline: [
        { at: minutesAgo(60), endTokens: 80_000 },
        { at: minutesAgo(40), endTokens: 174_400, compaction: 'auto' },
        { at: minutesAgo(20), endTokens: 60_000, compaction: 'manual' },
        { at: minutesAgo(5), endTokens: 120_400 },
      ],
    },
    compactions: { total: 3, auto: 2, manual: 1 },
    activity: {
      turnCount: 42,
      totalDurationMs: 3_960_000,
      averageTurnMs: 94_000,
      p95TurnMs: 312_000,
      toolCallCount: 388,
      subagentCount: 4,
      plansCreated: 2,
      plansApproved: 1,
      topTools: [
        { tool: 'bash', count: 120 },
        { tool: 'read', count: 96 },
      ],
    },
    ...overrides,
  };
}

export function pipelineRunView(
  overrides: Partial<PipelineRunCostView> = {},
): PipelineRunCostView {
  return {
    run: runRow({
      totals: totals({ pipeline: 0.93, subagents: 0.12, background: 0.05 }),
    }),
    updatedAt: minutesAgo(4),
    steps: [
      {
        jobId: 'review',
        stepId: 'review',
        label: 'Review changes',
        attemptCount: 1,
        model: 'Sonnet 5.5',
        harness: 'Claude',
        totals: totals({ pipeline: 0.72, subagents: 0.12 }),
        executionId: 'run-1',
      },
      {
        jobId: 'fix',
        stepId: 'fix',
        label: 'Fix lint',
        attemptCount: 2,
        model: 'Haiku 4.5',
        harness: 'Claude',
        totals: totals({ pipeline: 0.21 }),
        executionId: 'run-1',
      },
    ],
    nonAgentStepCount: 3,
    advisor: { reportCount: 1, usd: 0.05, notPricedCount: 0 },
    subagents: [],
    delegations: [],
    childRuns: [],
    byModel: [
      {
        model: 'Sonnet 5.5',
        turnCount: 1,
        usd: 0.84,
        notPricedCount: 0,
        tokens: totals().tokens,
      },
      {
        model: 'Haiku 4.5',
        turnCount: 2,
        usd: 0.21,
        notPricedCount: 0,
        tokens: totals().tokens,
      },
    ],
    ...overrides,
  };
}

export function ok<Value>(value: Value): CostViewResult<Value> {
  return { status: 'ok', value };
}

export interface FakeCostClient extends CostClient {
  readonly getScope: jest.Mock;
  readonly getChat: jest.Mock;
  readonly getPipelineRun: jest.Mock;
  readonly refresh: jest.Mock;
  readonly watchScope: jest.Mock;
  readonly subscribeUpdates: jest.Mock;
  /** Delivers an update event to every subscriber. */
  emit(event: CostUpdatedEvent): void;
  /** Released `watchScope` calls. */
  readonly unwatch: jest.Mock;
}

/**
 * A fake client. Each read resolves with the given result (an `ok` of the
 * default fixture when omitted); pass a function to compute per request.
 */
export function createFakeCostClient(
  options: {
    readonly scope?: CostViewResult<CostScopeView>;
    readonly chat?: CostViewResult<CostChatView>;
    readonly pipelineRun?: CostViewResult<PipelineRunCostView>;
    readonly refresh?: CostViewResult<CostRefreshReceipt>;
  } = {},
): FakeCostClient {
  const handlers = new Set<(event: CostUpdatedEvent) => void>();
  const unwatch = jest.fn();
  return {
    getScope: jest.fn(() => Promise.resolve(options.scope ?? ok(scopeView()))),
    getChat: jest.fn(() =>
      Promise.resolve(
        options.chat ?? ok({ kind: 'full', breakdown: breakdownView() }),
      ),
    ),
    getPipelineRun: jest.fn(() =>
      Promise.resolve(options.pipelineRun ?? ok(pipelineRunView())),
    ),
    refresh: jest.fn(() =>
      Promise.resolve(
        options.refresh ??
          ok({
            ran: true,
            updatedAt: new Date(NOW).toISOString(),
            revision: 2,
          }),
      ),
    ),
    watchScope: jest.fn(() => unwatch),
    subscribeUpdates: jest.fn((handler: (event: CostUpdatedEvent) => void) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    }),
    emit(event: CostUpdatedEvent): void {
      handlers.forEach((handler) => handler(event));
    },
    unwatch,
  };
}

const BASE_CAPABILITIES: CanopyCapabilities = {
  localExecution: false,
  terminalPty: false,
  fileSystemAccess: 'read',
  voice: false,
  settingsScope: 'api-keys-only',
  pipelines: 'crud-only',
  routing: 'url',
};

export interface CostRenderer {
  readonly container: HTMLDivElement;
  render(node: ReactNode): void;
  unmount(): void;
}

/**
 * Mounts nodes under a `CanopyClientProvider` whose host reports
 * `costInsights` (true by default). Call `unmount` in `afterEach`.
 */
export function createCostRenderer(
  options: { readonly costInsights?: boolean } = {},
): CostRenderer {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const client: CanopyClient = {
    capabilities: {
      ...BASE_CAPABILITIES,
      ...(options.costInsights === false ? {} : { costInsights: true }),
    },
    query: jest.fn(),
    command: jest.fn(),
    subscribe: () => () => undefined,
  };
  return {
    container,
    render(node: ReactNode): void {
      act(() => {
        root.render(
          <CanopyClientProvider client={client}>{node}</CanopyClientProvider>,
        );
      });
    },
    unmount(): void {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** Lets pending promise callbacks (fake client reads) settle inside act. */
export async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
}
