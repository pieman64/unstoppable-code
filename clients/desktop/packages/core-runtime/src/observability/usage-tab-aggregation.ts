import {
  type AgentAuditEntry,
  type AgentAuditToolCounts,
  type UsageMetricEventBase,
  type ChatTurnUsageEvent,
  type PipelineRunUsageEvent,
  type PlanUsageEvent,
  type UsageBreakdownRow,
  type UsageMetricEvent,
  type UsageMetricsViewRequest,
  type UsageMetricsViewResponse,
  type UsageStats,
  type UsageTabId,
  type UsageTabSummaryCard,
  type UsageTabSummaryResponse,
  type UsageWindow,
  type UsageGroupById,
  type UsageMetricId,
  type WorktreeCreatedUsageEvent,
  type WorktreeDeletedUsageEvent,
  type WorktreePrMergedUsageEvent,
} from '@canopy/protocol/observability';
import {
  TELEMETRY_TOOL_CATEGORIES,
  getTelemetryToolCategoryLabel,
} from '@canopy/protocol/telemetry';

/** Query-only spend projection: never persisted or emitted as a chat turn. */
export interface DelegationStatisticsEvent extends Omit<
  UsageMetricEventBase,
  'type'
> {
  type: 'managed_delegation';
  chatId?: string;
  model?: string;
  tokens: AgentAuditEntry['tokens'];
  totalCostUsd?: number;
  observedCost?: AgentAuditEntry['observedCost'];
}

export type StatisticsEvent = UsageMetricEvent | DelegationStatisticsEvent;

export function toDelegationStatisticsEvent(
  entry: AgentAuditEntry,
): DelegationStatisticsEvent | null {
  if (entry.eventType !== 'managed_delegation' || !entry.projectId) return null;
  return {
    version: 1,
    id: entry.id,
    type: 'managed_delegation',
    timestamp: entry.startedAt,
    workspaceId: entry.projectId,
    worktreeId: entry.worktreeId,
    repoId: entry.repoId,
    repoLabel: entry.repoLabel,
    chatId: entry.chatId,
    provider: entry.provider,
    model: entry.model,
    tokens: entry.tokens,
    totalCostUsd: entry.totalCostUsd,
    observedCost: entry.observedCost,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ResolvedWindow {
  start: string;
  end: string;
}

export function resolveWindow(
  window: UsageWindow,
  nowMs: number,
  earliestIso?: string,
): ResolvedWindow {
  const nowIso = new Date(nowMs).toISOString();
  switch (window.kind) {
    case 'last7d':
      return {
        start: new Date(nowMs - 7 * DAY_MS).toISOString(),
        end: nowIso,
      };
    case 'prior7d':
      return {
        start: new Date(nowMs - 14 * DAY_MS).toISOString(),
        end: new Date(nowMs - 7 * DAY_MS).toISOString(),
      };
    case 'allTime':
      return {
        start: earliestIso ?? nowIso,
        end: nowIso,
      };
    case 'custom':
      return { start: window.start, end: window.end };
  }
}

export function earliestEventAt(
  events: ReadonlyArray<StatisticsEvent>,
  fallbackNowMs: number = Date.now(),
): string {
  let earliestMs: number | null = null;
  for (const event of events) {
    const ms = Date.parse(event.timestamp);
    if (!Number.isFinite(ms)) continue;
    if (earliestMs === null || ms < earliestMs) earliestMs = ms;
  }
  return new Date(earliestMs ?? fallbackNowMs).toISOString();
}

function inRange(timestampIso: string, window: ResolvedWindow): boolean {
  const ms = Date.parse(timestampIso);
  if (!Number.isFinite(ms)) return false;
  const startMs = Date.parse(window.start);
  const endMs = Date.parse(window.end);
  return ms >= startMs && ms < endMs;
}

function computeStats(samples: ReadonlyArray<number>): UsageStats {
  if (samples.length === 0) {
    return { total: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const pickPercentile = (p: number): number => {
    if (sorted.length === 0) return 0;
    const rank = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
    );
    return sorted[rank];
  };
  return {
    total,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: total / sorted.length,
    p50: pickPercentile(50),
    p95: pickPercentile(95),
    p99: pickPercentile(99),
  };
}

type CountMatcher = (event: StatisticsEvent) => boolean;
type DistributionExtractor = (event: StatisticsEvent) => number | undefined;

interface CountMetricDef {
  id: UsageMetricId;
  kind: 'count';
  matches: CountMatcher;
  count?: (event: StatisticsEvent) => number;
}

interface DistributionMetricDef {
  id: UsageMetricId;
  kind: 'distribution';
  matches: CountMatcher;
  extract: DistributionExtractor;
}

type MetricDef = CountMetricDef | DistributionMetricDef;

function isCreated(event: StatisticsEvent): event is WorktreeCreatedUsageEvent {
  return event.type === 'worktree_created';
}

function isMerged(event: StatisticsEvent): event is WorktreePrMergedUsageEvent {
  return event.type === 'worktree_pr_merged';
}

function isDeleted(event: StatisticsEvent): event is WorktreeDeletedUsageEvent {
  return event.type === 'worktree_deleted';
}

function isCompletedTurn(event: StatisticsEvent): event is ChatTurnUsageEvent {
  return event.type === 'chat_turn_completed';
}

function isSpendEvent(
  event: StatisticsEvent,
): event is ChatTurnUsageEvent | DelegationStatisticsEvent {
  return isCompletedTurn(event) || event.type === 'managed_delegation';
}

function isPlanEvent(event: StatisticsEvent): event is PlanUsageEvent {
  return (
    event.type === 'plan_created' ||
    event.type === 'plan_updated' ||
    event.type === 'plan_approved'
  );
}

function isPipelineRunEvent(
  event: StatisticsEvent,
): event is PipelineRunUsageEvent {
  return (
    (event.type === 'pipeline_run_started' ||
      event.type === 'pipeline_run_completed') &&
    event.hidden !== true
  );
}

function isCompletedPipelineRun(
  event: StatisticsEvent,
): event is PipelineRunUsageEvent {
  return isPipelineRunEvent(event) && event.type === 'pipeline_run_completed';
}

const WORKTREE_METRICS: ReadonlyArray<MetricDef> = [
  { id: 'created', kind: 'count', matches: isCreated },
  { id: 'merged', kind: 'count', matches: isMerged },
  {
    id: 'deleted_with_changes',
    kind: 'count',
    matches: (event) => isDeleted(event) && event.deletedWithChanges,
  },
  {
    id: 'deleted_without_changes',
    kind: 'count',
    matches: (event) => isDeleted(event) && !event.deletedWithChanges,
  },
  {
    id: 'age_at_deletion_ms',
    kind: 'distribution',
    matches: isDeleted,
    extract: (event) => (isDeleted(event) ? event.worktreeAgeMs : undefined),
  },
];

function tokenTotal(
  event: ChatTurnUsageEvent | DelegationStatisticsEvent,
): number {
  const tokens = event.tokens;
  if (!tokens) {
    return 0;
  }
  return (
    tokens.input +
    tokens.output +
    tokens.cacheReadInputTokens +
    tokens.cacheCreationInputTokens
  );
}

function observedCostUsd(
  event: ChatTurnUsageEvent | DelegationStatisticsEvent,
): number {
  const cost = event.totalCostUsd ?? event.observedCost?.totalUsd;
  return typeof cost === 'number' && Number.isFinite(cost) ? cost : 0;
}

const TOKEN_METRICS: ReadonlyArray<MetricDef> = [
  {
    id: 'token_total',
    kind: 'count',
    matches: isSpendEvent,
    count: (event) => (isSpendEvent(event) ? tokenTotal(event) : 0),
  },
  {
    id: 'token_input',
    kind: 'count',
    matches: isSpendEvent,
    count: (event) => (isSpendEvent(event) ? (event.tokens?.input ?? 0) : 0),
  },
  {
    id: 'token_output',
    kind: 'count',
    matches: isSpendEvent,
    count: (event) => (isSpendEvent(event) ? (event.tokens?.output ?? 0) : 0),
  },
  {
    id: 'token_cache_read',
    kind: 'count',
    matches: isSpendEvent,
    count: (event) =>
      isSpendEvent(event) ? (event.tokens?.cacheReadInputTokens ?? 0) : 0,
  },
  {
    id: 'token_cache_creation',
    kind: 'count',
    matches: isSpendEvent,
    count: (event) =>
      isSpendEvent(event) ? (event.tokens?.cacheCreationInputTokens ?? 0) : 0,
  },
  {
    id: 'token_provider_claude',
    kind: 'count',
    matches: isSpendEvent,
    count: (event) =>
      isSpendEvent(event) && event.provider === 'claude'
        ? tokenTotal(event)
        : 0,
  },
  {
    id: 'token_provider_codex',
    kind: 'count',
    matches: isSpendEvent,
    count: (event) =>
      isSpendEvent(event) && event.provider === 'codex' ? tokenTotal(event) : 0,
  },
  {
    id: 'token_provider_ollama',
    kind: 'count',
    matches: isSpendEvent,
    count: (event) =>
      isSpendEvent(event) && event.provider === 'ollama'
        ? tokenTotal(event)
        : 0,
  },
];

const COST_METRICS: ReadonlyArray<MetricDef> = [
  {
    id: 'cost_total_usd',
    kind: 'count',
    matches: isSpendEvent,
    count: (event) => (isSpendEvent(event) ? observedCostUsd(event) : 0),
  },
  {
    id: 'cost_provider_claude_usd',
    kind: 'count',
    matches: isSpendEvent,
    count: (event) =>
      isSpendEvent(event) && event.provider === 'claude'
        ? observedCostUsd(event)
        : 0,
  },
  {
    id: 'cost_provider_codex_usd',
    kind: 'count',
    matches: isSpendEvent,
    count: (event) =>
      isSpendEvent(event) && event.provider === 'codex'
        ? observedCostUsd(event)
        : 0,
  },
];

function costModelMetric(id: UsageMetricId): MetricDef | null {
  const prefix = 'cost_model:';
  if (!id.startsWith(prefix)) {
    return null;
  }
  const model = id.slice(prefix.length);
  if (model.length === 0) {
    return null;
  }
  return {
    id,
    kind: 'count',
    matches: isSpendEvent,
    count: (event) =>
      isSpendEvent(event) && event.model === model ? observedCostUsd(event) : 0,
  };
}

const CHAT_METRICS: ReadonlyArray<MetricDef> = [
  { id: 'chat_turns', kind: 'count', matches: isCompletedTurn },
  { id: 'tool_calls', kind: 'count', matches: isCompletedTurn },
  {
    id: 'turn_duration_ms',
    kind: 'distribution',
    matches: isCompletedTurn,
    extract: (event) =>
      isCompletedTurn(event) ? event.turnDurationMs : undefined,
  },
  {
    id: 'tool_calls_per_turn',
    kind: 'distribution',
    matches: isCompletedTurn,
    extract: (event) =>
      isCompletedTurn(event) ? event.toolUseCount : undefined,
  },
];

const PLAN_METRICS: ReadonlyArray<MetricDef> = [
  {
    id: 'plan_created',
    kind: 'count',
    matches: (event) => isPlanEvent(event) && event.type === 'plan_created',
  },
  {
    id: 'plan_updated',
    kind: 'count',
    matches: (event) => isPlanEvent(event) && event.type === 'plan_updated',
  },
  {
    id: 'plan_approved',
    kind: 'count',
    matches: (event) => isPlanEvent(event) && event.type === 'plan_approved',
  },
];

const TOOL_CATEGORY_KEYS: ReadonlyArray<keyof AgentAuditToolCounts> =
  TELEMETRY_TOOL_CATEGORIES;

const TOOL_METRICS: ReadonlyArray<MetricDef> = [
  { id: 'tool_calls', kind: 'count', matches: isCompletedTurn },
  {
    id: 'tool_calls_per_turn',
    kind: 'distribution',
    matches: isCompletedTurn,
    extract: (event) =>
      isCompletedTurn(event) ? event.toolUseCount : undefined,
  },
  ...TOOL_CATEGORY_KEYS.map<MetricDef>((cat) => ({
    id: `tool_${cat}` as UsageMetricId,
    kind: 'count',
    matches: isCompletedTurn,
  })),
];

const PIPELINE_METRICS: ReadonlyArray<MetricDef> = [
  {
    id: 'pipeline_runs_started',
    kind: 'count',
    matches: (event) =>
      isPipelineRunEvent(event) && event.type === 'pipeline_run_started',
  },
  {
    id: 'pipeline_runs_completed',
    kind: 'count',
    matches: isCompletedPipelineRun,
  },
  {
    id: 'pipeline_runs_succeeded',
    kind: 'count',
    matches: (event) =>
      isCompletedPipelineRun(event) && event.status === 'success',
  },
  {
    id: 'pipeline_runs_failed',
    kind: 'count',
    matches: (event) =>
      isCompletedPipelineRun(event) && event.status === 'failure',
  },
  {
    id: 'pipeline_runs_cancelled',
    kind: 'count',
    matches: (event) =>
      isCompletedPipelineRun(event) && event.status === 'cancelled',
  },
  {
    id: 'pipeline_duration_ms',
    kind: 'distribution',
    matches: isCompletedPipelineRun,
    extract: (event) =>
      isCompletedPipelineRun(event) ? event.runDurationMs : undefined,
  },
  {
    id: 'pipeline_steps_per_run',
    kind: 'distribution',
    matches: isCompletedPipelineRun,
    extract: (event) =>
      isCompletedPipelineRun(event) ? event.stepCount : undefined,
  },
  {
    id: 'pipeline_agent_steps_per_run',
    kind: 'distribution',
    matches: isCompletedPipelineRun,
    extract: (event) =>
      isCompletedPipelineRun(event) ? event.agentStepCount : undefined,
  },
  {
    id: 'pipeline_retries_per_run',
    kind: 'distribution',
    matches: isCompletedPipelineRun,
    extract: (event) =>
      isCompletedPipelineRun(event) ? event.retryCount : undefined,
  },
];

function metricsForTab(tab: UsageTabId): ReadonlyArray<MetricDef> {
  switch (tab) {
    case 'tokens':
      return TOKEN_METRICS;
    case 'cost':
      return COST_METRICS;
    case 'worktrees':
      return WORKTREE_METRICS;
    case 'chats':
      return CHAT_METRICS;
    case 'plans':
      return PLAN_METRICS;
    case 'tools':
      return TOOL_METRICS;
    case 'pipelines':
      return PIPELINE_METRICS;
  }
}

function metricCount(event: StatisticsEvent, metric: MetricDef): number {
  if (!metric.matches(event)) return 0;
  if (metric.kind === 'count' && metric.count) {
    return metric.count(event);
  }
  if (metric.id.startsWith('tool_') && metric.id !== 'tool_calls') {
    const category = metric.id.slice(5) as keyof AgentAuditToolCounts;
    if (isCompletedTurn(event) && event.toolCounts) {
      return event.toolCounts[category] ?? 0;
    }
    return 0;
  }
  if (metric.id === 'tool_calls' && isCompletedTurn(event)) {
    return event.toolUseCount ?? 0;
  }
  return 1;
}

interface HeadlineCardDef {
  key: string;
  metric: MetricDef;
  pickStat?: 'avg' | 'p50' | 'p95';
}

function findMetric(
  metrics: ReadonlyArray<MetricDef>,
  id: UsageMetricId,
): MetricDef {
  if (metrics === COST_METRICS) {
    const dynamicCostMetric = costModelMetric(id);
    if (dynamicCostMetric) {
      return dynamicCostMetric;
    }
  }
  const def = metrics.find((m) => m.id === id);
  if (!def) {
    throw new Error(`Unknown metric ${id}`);
  }
  return def;
}

function headlineCardsForTab(tab: UsageTabId): ReadonlyArray<HeadlineCardDef> {
  switch (tab) {
    case 'tokens':
      return [
        {
          key: 'total_tokens',
          metric: findMetric(TOKEN_METRICS, 'token_total'),
        },
        {
          key: 'input_tokens',
          metric: findMetric(TOKEN_METRICS, 'token_input'),
        },
        {
          key: 'output_tokens',
          metric: findMetric(TOKEN_METRICS, 'token_output'),
        },
        {
          key: 'cache_read_tokens',
          metric: findMetric(TOKEN_METRICS, 'token_cache_read'),
        },
      ];
    case 'cost':
      return [
        {
          key: 'observed_cost',
          metric: findMetric(COST_METRICS, 'cost_total_usd'),
        },
        {
          key: 'claude_cost',
          metric: findMetric(COST_METRICS, 'cost_provider_claude_usd'),
        },
        {
          key: 'codex_cost',
          metric: findMetric(COST_METRICS, 'cost_provider_codex_usd'),
        },
      ];
    case 'worktrees':
      return [
        { key: 'created', metric: findMetric(WORKTREE_METRICS, 'created') },
        { key: 'merged', metric: findMetric(WORKTREE_METRICS, 'merged') },
        {
          key: 'deleted_with_changes',
          metric: findMetric(WORKTREE_METRICS, 'deleted_with_changes'),
        },
        {
          key: 'deleted_without_changes',
          metric: findMetric(WORKTREE_METRICS, 'deleted_without_changes'),
        },
      ];
    case 'chats':
      return [
        { key: 'total_turns', metric: findMetric(CHAT_METRICS, 'chat_turns') },
        {
          key: 'avg_turn_duration_ms',
          metric: findMetric(CHAT_METRICS, 'turn_duration_ms'),
          pickStat: 'avg',
        },
        {
          key: 'p95_turn_duration_ms',
          metric: findMetric(CHAT_METRICS, 'turn_duration_ms'),
          pickStat: 'p95',
        },
        { key: 'tool_calls', metric: findMetric(CHAT_METRICS, 'tool_calls') },
      ];
    case 'plans':
      return [
        { key: 'created', metric: findMetric(PLAN_METRICS, 'plan_created') },
        { key: 'updated', metric: findMetric(PLAN_METRICS, 'plan_updated') },
        { key: 'approved', metric: findMetric(PLAN_METRICS, 'plan_approved') },
        {
          key: 'approved_per_worktree',
          metric: findMetric(PLAN_METRICS, 'plan_approved'),
        },
      ];
    case 'tools':
      return [
        { key: 'tool_calls', metric: findMetric(TOOL_METRICS, 'tool_calls') },
        {
          key: 'avg_per_turn',
          metric: findMetric(TOOL_METRICS, 'tool_calls_per_turn'),
          pickStat: 'avg',
        },
        {
          key: 'p95_per_turn',
          metric: findMetric(TOOL_METRICS, 'tool_calls_per_turn'),
          pickStat: 'p95',
        },
        { key: 'subagents', metric: findMetric(TOOL_METRICS, 'tool_agent') },
      ];
    case 'pipelines':
      return [
        {
          key: 'runs_started',
          metric: findMetric(PIPELINE_METRICS, 'pipeline_runs_started'),
        },
        {
          key: 'runs_completed',
          metric: findMetric(PIPELINE_METRICS, 'pipeline_runs_completed'),
        },
        {
          key: 'avg_duration_ms',
          metric: findMetric(PIPELINE_METRICS, 'pipeline_duration_ms'),
          pickStat: 'avg',
        },
        {
          key: 'runs_failed',
          metric: findMetric(PIPELINE_METRICS, 'pipeline_runs_failed'),
        },
      ];
  }
}

function summarizeCardForWindow(
  card: HeadlineCardDef,
  events: ReadonlyArray<StatisticsEvent>,
  window: ResolvedWindow,
): number | UsageStats | undefined {
  const scoped = events.filter((event) => inRange(event.timestamp, window));
  if (card.key === 'approved_per_worktree') {
    let approvals = 0;
    const worktreeIds = new Set<string>();
    for (const event of scoped) {
      if (isPlanEvent(event) && event.type === 'plan_approved') {
        approvals += 1;
        worktreeIds.add(event.worktreeId ?? 'unknown-worktree');
      }
    }
    return worktreeIds.size === 0 ? 0 : approvals / worktreeIds.size;
  }
  if (card.metric.kind === 'count') {
    let sum = 0;
    for (const event of scoped) {
      sum += metricCount(event, card.metric);
    }
    return sum;
  }
  const samples: number[] = [];
  for (const event of scoped) {
    if (!card.metric.matches(event)) continue;
    const value = card.metric.extract(event);
    if (value !== undefined && Number.isFinite(value)) {
      samples.push(value);
    }
  }
  return samples.length === 0 ? undefined : computeStats(samples);
}

export function computeTabSummary(
  tab: UsageTabId,
  events: ReadonlyArray<StatisticsEvent>,
  nowMs: number = Date.now(),
): UsageTabSummaryResponse {
  const earliest = earliestEventAt(events, nowMs);
  const last7d = resolveWindow({ kind: 'last7d' }, nowMs);
  const prior7d = resolveWindow({ kind: 'prior7d' }, nowMs);
  const allTime = resolveWindow({ kind: 'allTime' }, nowMs, earliest);
  const cards: UsageTabSummaryCard[] = headlineCardsForTab(tab).map((card) => ({
    key: card.key,
    last7d: summarizeCardForWindow(card, events, last7d),
    prior7d: summarizeCardForWindow(card, events, prior7d),
    allTime: summarizeCardForWindow(card, events, allTime),
  }));
  return {
    tab,
    cards,
    earliestEventAt: earliest,
    resolvedWindows: { last7d, prior7d, allTime },
  };
}

function groupKey(
  event: StatisticsEvent,
  groupBy: UsageGroupById,
): { key: string; label: string; row: Partial<UsageBreakdownRow> } | null {
  switch (groupBy) {
    case 'workspace':
      return {
        key: event.workspaceId,
        label: event.workspaceLabel ?? event.workspaceId,
        row: { workspaceId: event.workspaceId },
      };
    case 'workspace_then_repo':
      if (!event.repoId) return null;
      return {
        key: `${event.workspaceId}::${event.repoId}`,
        label: event.repoLabel ?? event.repoId,
        row: { workspaceId: event.workspaceId, repoId: event.repoId },
      };
    case 'repo':
      if (!event.repoId) return null;
      return {
        key: event.repoId,
        label: event.repoLabel ?? event.repoId,
        row: { repoId: event.repoId },
      };
    case 'day_of_week': {
      const day = new Date(event.timestamp).getUTCDay();
      const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      return { key: String(day), label: labels[day], row: {} };
    }
    case 'worktree': {
      if (!event.worktreeId) return null;
      const workspaceLabel = event.workspaceLabel ?? event.workspaceId;
      return {
        key: `${event.workspaceId}::${event.worktreeId}`,
        label: `${workspaceLabel} / ${event.worktreeId}`,
        row: {
          workspaceId: event.workspaceId,
          workspaceLabel: event.workspaceLabel,
          worktreeId: event.worktreeId,
        },
      };
    }
    case 'chat':
      if (!isSpendEvent(event) || !event.chatId) return null;
      return { key: event.chatId, label: event.chatId, row: {} };
    case 'provider':
      if (!event.provider) return null;
      return {
        key: event.provider,
        label: event.provider,
        row: { provider: event.provider },
      };
    case 'initiation_source':
      if (!event.initiationSource) return null;
      return {
        key: event.initiationSource,
        label: event.initiationSource,
        row: { initiationSource: event.initiationSource },
      };
    case 'model': {
      if (!isSpendEvent(event) || !event.model) return null;
      return { key: event.model, label: event.model, row: {} };
    }
    case 'category':
      return null;
    case 'pipeline':
      if (!isPipelineRunEvent(event)) return null;
      return {
        key: event.pipelineIdentityKey,
        label: event.pipelineName,
        row: {},
      };
    case 'status':
      if (!isPipelineRunEvent(event) || !event.status) return null;
      return { key: event.status, label: event.status, row: {} };
    case 'event_name':
      if (!isPipelineRunEvent(event) || !event.eventName) return null;
      return { key: event.eventName, label: event.eventName, row: {} };
    case 'trigger_source': {
      if (!isPipelineRunEvent(event)) return null;
      if (!event.triggerSource) return null;
      const key = event.triggerSource;
      return {
        key,
        label: key,
        row: {},
      };
    }
  }
}

export function computeMetricsView(
  request: UsageMetricsViewRequest,
  events: ReadonlyArray<StatisticsEvent>,
  nowMs: number = Date.now(),
): UsageMetricsViewResponse {
  const earliest = earliestEventAt(events, nowMs);
  const window = resolveWindow(request.window, nowMs, earliest);
  const scoped = events.filter((event) => inRange(event.timestamp, window));

  const metric = findMetric(metricsForTab(request.tab), request.metric);
  const buckets = new Map<
    string,
    {
      label: string;
      rowMeta: Partial<UsageBreakdownRow>;
      count: number;
      samples: number[];
    }
  >();

  if (request.groupBy === 'category' && request.tab === 'tools') {
    for (const event of scoped) {
      if (!isCompletedTurn(event) || !event.toolCounts) continue;
      for (const cat of TOOL_CATEGORY_KEYS) {
        const value = event.toolCounts[cat] ?? 0;
        if (value === 0) continue;
        const slot = buckets.get(cat) ?? {
          label: getTelemetryToolCategoryLabel(cat),
          rowMeta: {},
          count: 0,
          samples: [],
        };
        slot.count += value;
        buckets.set(cat, slot);
      }
    }
  } else {
    for (const event of scoped) {
      const group = groupKey(event, request.groupBy);
      if (!group) continue;
      let countDelta = 0;
      const samples: number[] = [];
      if (metric.kind === 'count') {
        countDelta = metricCount(event, metric);
        if (countDelta <= 0) continue;
      } else if (metric.matches(event)) {
        const value = metric.extract(event);
        if (value !== undefined && Number.isFinite(value)) {
          samples.push(value);
          countDelta = 1;
        }
      }
      if (countDelta <= 0) continue;
      const slot = buckets.get(group.key) ?? {
        label: group.label,
        rowMeta: group.row,
        count: 0,
        samples: [],
      };
      slot.count += countDelta;
      slot.samples.push(...samples);
      buckets.set(group.key, slot);
    }
  }

  const rows: UsageBreakdownRow[] = Array.from(buckets.entries()).map(
    ([key, slot]) => ({
      key,
      label: slot.label,
      ...slot.rowMeta,
      count: slot.count,
      stats:
        metric.kind === 'distribution' && slot.samples.length > 0
          ? computeStats(slot.samples)
          : undefined,
    }),
  );

  rows.sort((a, b) => b.count - a.count);

  const allSamples: number[] = [];
  if (metric.kind === 'distribution') {
    for (const event of scoped) {
      if (!metric.matches(event)) continue;
      const value = metric.extract(event);
      if (value !== undefined && Number.isFinite(value)) {
        allSamples.push(value);
      }
    }
  }

  return {
    rows,
    stats:
      metric.kind === 'distribution' && allSamples.length > 0
        ? computeStats(allSamples)
        : undefined,
    resolvedWindow: window,
    earliestEventAt: earliest,
  };
}

export interface CountsTimeseriesRequest {
  tab: UsageTabId;
  series: ReadonlyArray<UsageMetricId>;
  bucket: 'hour' | 'day' | 'week';
  startDate: string;
  endDate: string;
}

export interface DistributionTimeseriesRequest {
  tab: UsageTabId;
  metric: UsageMetricId;
  bucket: 'hour' | 'day' | 'week';
  startDate: string;
  endDate: string;
}

type TimeseriesBucketGranularity = 'hour' | 'day' | 'week';

function alignToLocalBucketStart(
  timestampMs: number,
  bucket: TimeseriesBucketGranularity,
): Date {
  const date = new Date(timestampMs);
  switch (bucket) {
    case 'hour': {
      return new Date(
        timestampMs -
          date.getMinutes() * 60 * 1000 -
          date.getSeconds() * 1000 -
          date.getMilliseconds(),
      );
    }
    case 'day': {
      date.setHours(0, 0, 0, 0);
      return date;
    }
    case 'week': {
      date.setHours(0, 0, 0, 0);
      const daysSinceMonday = (date.getDay() + 6) % 7;
      date.setDate(date.getDate() - daysSinceMonday);
      return date;
    }
  }
}

function addLocalBucket(date: Date, bucket: TimeseriesBucketGranularity): Date {
  const next = new Date(date.getTime());
  switch (bucket) {
    case 'hour':
      next.setTime(next.getTime() + 60 * 60 * 1000);
      break;
    case 'day':
      next.setDate(next.getDate() + 1);
      break;
    case 'week':
      next.setDate(next.getDate() + 7);
      break;
  }
  return next;
}

function bucketRange(
  start: string,
  end: string,
  bucket: TimeseriesBucketGranularity,
): string[] {
  const startTime = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startTime) || !Number.isFinite(endMs)) return [];

  const buckets: string[] = [];
  for (
    let cursor = alignToLocalBucketStart(startTime, bucket);
    cursor.getTime() < endMs;
    cursor = addLocalBucket(cursor, bucket)
  ) {
    buckets.push(cursor.toISOString());
  }
  return buckets;
}

export function computeCountsTimeseries(
  request: CountsTimeseriesRequest,
  events: ReadonlyArray<StatisticsEvent>,
): Array<{
  bucketStart: string;
  series: Partial<Record<UsageMetricId, number>>;
}> {
  const bucketStarts = bucketRange(
    request.startDate,
    request.endDate,
    request.bucket,
  );
  const buckets = new Map<string, Partial<Record<UsageMetricId, number>>>();
  for (const start of bucketStarts) buckets.set(start, {});
  const tabMetrics = metricsForTab(request.tab);
  const metrics = request.series.map((id) => findMetric(tabMetrics, id));
  const startMs = Date.parse(request.startDate);
  const endMs = Date.parse(request.endDate);
  for (const event of events) {
    const ts = Date.parse(event.timestamp);
    if (ts < startMs || ts >= endMs) continue;
    const bucketIso = alignToLocalBucketStart(ts, request.bucket).toISOString();
    const slot = buckets.get(bucketIso);
    if (!slot) continue;
    for (const metric of metrics) {
      const value = metricCount(event, metric);
      if (value === 0) continue;
      slot[metric.id] = (slot[metric.id] ?? 0) + value;
    }
  }
  return bucketStarts.map((bucketStart) => ({
    bucketStart,
    series: buckets.get(bucketStart) ?? {},
  }));
}

export function computeDistributionTimeseries(
  request: DistributionTimeseriesRequest,
  events: ReadonlyArray<StatisticsEvent>,
): Array<{
  bucketStart: string;
  p50: number;
  p95: number;
  p99: number;
  sampleCount: number;
}> {
  const bucketStarts = bucketRange(
    request.startDate,
    request.endDate,
    request.bucket,
  );
  const samples = new Map<string, number[]>();
  for (const start of bucketStarts) samples.set(start, []);
  const metric = findMetric(metricsForTab(request.tab), request.metric);
  if (metric.kind !== 'distribution') {
    throw new Error(`Metric ${request.metric} is not a distribution metric`);
  }
  const startMs = Date.parse(request.startDate);
  const endMs = Date.parse(request.endDate);
  for (const event of events) {
    const ts = Date.parse(event.timestamp);
    if (ts < startMs || ts >= endMs) continue;
    if (!metric.matches(event)) continue;
    const value = metric.extract(event);
    if (value === undefined || !Number.isFinite(value)) continue;
    const bucketIso = alignToLocalBucketStart(ts, request.bucket).toISOString();
    samples.get(bucketIso)?.push(value);
  }
  return bucketStarts.map((bucketStart) => {
    const arr = samples.get(bucketStart) ?? [];
    if (arr.length === 0) {
      return { bucketStart, p50: 0, p95: 0, p99: 0, sampleCount: 0 };
    }
    const stats = computeStats(arr);
    return {
      bucketStart,
      p50: stats.p50,
      p95: stats.p95,
      p99: stats.p99,
      sampleCount: arr.length,
    };
  });
}
