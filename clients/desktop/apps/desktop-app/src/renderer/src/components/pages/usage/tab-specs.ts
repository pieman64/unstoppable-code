import { CHAT_UNIT_LABEL, WORKTREE_UNIT_LABEL } from '@canopy/protocol';
import { TELEMETRY_TOOL_CATEGORIES } from '@canopy/protocol/telemetry';
import { getTelemetryToolCategoryLabel } from '@canopy/ui-shared/lib/telemetry-tool-category';
import { brandText } from '@/lib/brand';
import type {
  ChatGroupById,
  CostGroupById,
  PipelineGroupById,
  PlanGroupById,
  ToolGroupById,
  ToolMetricId,
  TokenGroupById,
  UsageGroupById,
  UsageMetricId,
  UsageTabId,
  WorktreeGroupById,
} from '@canopy/desktop-shared/types';

export interface HeadlineCardSpec {
  /** Matches UsageTabSummaryCard.key */
  key: string;
  title: string;
  /**
   * 'count' renders the value directly. 'currency' renders a numeric value
   * as USD. 'distribution-avg' / -p95 render the corresponding stat from the
   * UsageStats object.
   */
  display: 'count' | 'currency' | 'distribution-avg' | 'distribution-p95';
  /**
   * Optional unit suffix shown under the value.
   */
  unit?: string;
}

export interface PickerOption<T extends string> {
  value: T;
  label: string;
}

export interface CountSeriesView {
  key: string;
  label: string;
  description: string;
  series: Array<PickerOption<UsageMetricId>>;
  defaultVisible: ReadonlyArray<UsageMetricId>;
  dynamicSeries?: {
    metric: UsageMetricId;
    groupBy: UsageGroupById;
    metricPrefix: string;
  };
}

export interface TabSpec {
  id: UsageTabId;
  title: string;
  subtitle?: string;
  /**
   * Optional, accessible disclosure block rendered under the title/subtitle.
   * Only tabs that need to caveat their numbers (e.g. the best-effort Codex
   * cost estimate) define one.
   */
  notice?: {
    title: string;
    body: string;
  };
  emptyMessage: string;
  countColumnLabel?: string;
  cards: HeadlineCardSpec[];
  chartCountSeries: Array<PickerOption<UsageMetricId>>;
  chartCountViews?: ReadonlyArray<CountSeriesView>;
  chartDistributionMetrics: Array<PickerOption<UsageMetricId>>;
  /** Visible-by-default series for the chart legend (used when there are many). */
  chartCountDefaultVisible: ReadonlyArray<UsageMetricId>;
  valueFormat?: 'number' | 'currency';
  tableMetrics: Array<PickerOption<UsageMetricId>>;
  tableGroupings: Array<PickerOption<UsageGroupById>>;
  defaultTableMetric: UsageMetricId;
  defaultTableGrouping: UsageGroupById;
}

export const TOKENS_TAB_SPEC: TabSpec = {
  id: 'tokens',
  title: 'Token usage',
  emptyMessage: 'No retained token usage yet.',
  countColumnLabel: 'Tokens',
  cards: [
    { key: 'total_tokens', title: 'Total tokens', display: 'count' },
    { key: 'input_tokens', title: 'Input tokens', display: 'count' },
    { key: 'output_tokens', title: 'Output tokens', display: 'count' },
    { key: 'cache_read_tokens', title: 'Cache read', display: 'count' },
  ],
  chartCountSeries: [
    { value: 'token_input', label: 'Input' },
    { value: 'token_output', label: 'Output' },
    { value: 'token_cache_read', label: 'Cache read' },
    { value: 'token_cache_creation', label: 'Cache creation' },
  ],
  chartCountViews: [
    {
      key: 'type',
      label: 'By type',
      description: 'Token totals per bucket by token type.',
      series: [
        { value: 'token_input', label: 'Input' },
        { value: 'token_output', label: 'Output' },
        { value: 'token_cache_read', label: 'Cache read' },
        { value: 'token_cache_creation', label: 'Cache creation' },
      ],
      defaultVisible: [
        'token_input',
        'token_output',
        'token_cache_read',
        'token_cache_creation',
      ],
    },
    {
      key: 'provider',
      label: 'By provider',
      description: 'Token totals per bucket by provider.',
      series: [
        { value: 'token_provider_claude', label: 'Claude' },
        { value: 'token_provider_codex', label: 'Codex' },
        { value: 'token_provider_ollama', label: 'Ollama' },
      ],
      defaultVisible: [
        'token_provider_claude',
        'token_provider_codex',
        'token_provider_ollama',
      ],
    },
  ],
  chartDistributionMetrics: [],
  chartCountDefaultVisible: [
    'token_input',
    'token_output',
    'token_cache_read',
    'token_cache_creation',
  ],
  tableMetrics: [
    { value: 'token_total', label: 'Total tokens' },
    { value: 'token_input', label: 'Input tokens' },
    { value: 'token_output', label: 'Output tokens' },
    { value: 'token_cache_read', label: 'Cache read' },
    { value: 'token_cache_creation', label: 'Cache creation' },
  ],
  tableGroupings: [
    { value: 'workspace', label: 'Project' },
    { value: 'workspace_then_repo', label: 'Project → Repo' },
    { value: 'worktree', label: WORKTREE_UNIT_LABEL },
    { value: 'chat', label: CHAT_UNIT_LABEL },
    { value: 'provider', label: 'Provider' },
    { value: 'initiation_source', label: 'Source' },
    { value: 'model', label: 'Model' },
  ] satisfies Array<PickerOption<TokenGroupById>>,
  defaultTableMetric: 'token_total',
  defaultTableGrouping: 'provider',
};

export const COST_TAB_SPEC: TabSpec = {
  id: 'cost',
  title: 'Observed cost',
  subtitle: `Observed cost combines provider-reported Claude cost with ${brandText.appName}'s best-effort Codex estimate.`,
  notice: {
    title: 'Codex cost is an estimate',
    body: `Codex cost is approximated from token usage and billable tool calls using ${brandText.appName}'s cached OpenAI Standard pricing. Fast mode and long-context rules are applied when the pricing data provides them. Dollar amounts are API-price estimates. They don't measure subscription allowance and may not match API invoices or provider-reported billing. Models without published API pricing are excluded from cost totals and marked unavailable in the audit trail, as are speeds without rates in the pricing data.`,
  },
  emptyMessage: 'No retained observed cost yet.',
  countColumnLabel: 'Cost',
  valueFormat: 'currency',
  cards: [
    { key: 'observed_cost', title: 'Observed cost', display: 'currency' },
    { key: 'claude_cost', title: 'Claude', display: 'currency' },
    { key: 'codex_cost', title: 'Codex', display: 'currency' },
  ],
  chartCountSeries: [
    { value: 'cost_provider_claude_usd', label: 'Claude' },
    { value: 'cost_provider_codex_usd', label: 'Codex' },
  ],
  chartCountViews: [
    {
      key: 'provider',
      label: 'By provider',
      description: 'Observed cost per bucket by provider.',
      series: [
        { value: 'cost_provider_claude_usd', label: 'Claude' },
        { value: 'cost_provider_codex_usd', label: 'Codex' },
      ],
      defaultVisible: ['cost_provider_claude_usd', 'cost_provider_codex_usd'],
    },
    {
      key: 'model',
      label: 'By model',
      description: 'Observed cost per bucket by model.',
      series: [],
      defaultVisible: [],
      dynamicSeries: {
        metric: 'cost_total_usd',
        groupBy: 'model',
        metricPrefix: 'cost_model:',
      },
    },
  ],
  chartDistributionMetrics: [],
  chartCountDefaultVisible: [
    'cost_provider_claude_usd',
    'cost_provider_codex_usd',
  ],
  tableMetrics: [
    { value: 'cost_total_usd', label: 'Observed cost' },
    { value: 'cost_provider_claude_usd', label: 'Claude cost' },
    { value: 'cost_provider_codex_usd', label: 'Codex cost' },
  ],
  tableGroupings: [
    { value: 'workspace', label: 'Project' },
    { value: 'workspace_then_repo', label: 'Project → Repo' },
    { value: 'worktree', label: WORKTREE_UNIT_LABEL },
    { value: 'chat', label: CHAT_UNIT_LABEL },
    { value: 'provider', label: 'Provider' },
    { value: 'initiation_source', label: 'Source' },
    { value: 'model', label: 'Model' },
  ] satisfies Array<PickerOption<CostGroupById>>,
  defaultTableMetric: 'cost_total_usd',
  defaultTableGrouping: 'provider',
};

export const WORKTREES_TAB_SPEC: TabSpec = {
  id: 'worktrees',
  title: `${WORKTREE_UNIT_LABEL} Activity`,
  emptyMessage: `No retained ${WORKTREE_UNIT_LABEL.toLowerCase()} activity yet.`,
  cards: [
    { key: 'created', title: 'Created', display: 'count' },
    { key: 'merged', title: 'Merged PRs', display: 'count' },
    {
      key: 'deleted_with_changes',
      title: 'Deleted with changes',
      display: 'count',
    },
    {
      key: 'deleted_without_changes',
      title: 'Deleted without changes',
      display: 'count',
    },
  ],
  chartCountSeries: [
    { value: 'created', label: 'Created' },
    { value: 'merged', label: 'Merged PRs' },
    { value: 'deleted_with_changes', label: 'Deleted (changes)' },
    { value: 'deleted_without_changes', label: 'Deleted (clean)' },
  ],
  chartDistributionMetrics: [
    { value: 'age_at_deletion_ms', label: 'Age at deletion' },
  ],
  chartCountDefaultVisible: [
    'created',
    'merged',
    'deleted_with_changes',
    'deleted_without_changes',
  ],
  tableMetrics: [
    { value: 'created', label: 'Created' },
    { value: 'merged', label: 'Merged PRs' },
    { value: 'deleted_with_changes', label: 'Deleted with changes' },
    { value: 'deleted_without_changes', label: 'Deleted without changes' },
    { value: 'age_at_deletion_ms', label: 'Age at deletion' },
  ],
  tableGroupings: [
    { value: 'workspace', label: 'Project' },
    { value: 'workspace_then_repo', label: 'Project → Repo' },
    { value: 'repo', label: 'Repo' },
    { value: 'day_of_week', label: 'Day of week' },
  ] satisfies Array<PickerOption<WorktreeGroupById>>,
  defaultTableMetric: 'created',
  defaultTableGrouping: 'workspace',
};

export const CHATS_TAB_SPEC: TabSpec = {
  id: 'chats',
  title: `${CHAT_UNIT_LABEL} Turns`,
  emptyMessage: `No retained ${CHAT_UNIT_LABEL.toLowerCase()} activity yet.`,
  cards: [
    { key: 'total_turns', title: 'Total turns', display: 'count' },
    {
      key: 'avg_turn_duration_ms',
      title: 'Avg turn time',
      display: 'distribution-avg',
      unit: 'ms',
    },
    {
      key: 'p95_turn_duration_ms',
      title: 'P95 turn time',
      display: 'distribution-p95',
      unit: 'ms',
    },
    { key: 'tool_calls', title: 'Tool calls', display: 'count' },
  ],
  chartCountSeries: [
    { value: 'chat_turns', label: 'Turns' },
    { value: 'tool_calls', label: 'Tool calls' },
  ],
  chartDistributionMetrics: [
    { value: 'turn_duration_ms', label: 'Turn duration' },
    { value: 'tool_calls_per_turn', label: 'Tool calls per turn' },
  ],
  chartCountDefaultVisible: ['chat_turns', 'tool_calls'],
  tableMetrics: [
    { value: 'chat_turns', label: 'Turns' },
    { value: 'tool_calls', label: 'Tool calls' },
    { value: 'turn_duration_ms', label: 'Turn duration' },
    { value: 'tool_calls_per_turn', label: 'Tool calls per turn' },
  ],
  tableGroupings: [
    { value: 'workspace', label: 'Project' },
    { value: 'workspace_then_repo', label: 'Project → Repo' },
    { value: 'worktree', label: WORKTREE_UNIT_LABEL },
    { value: 'chat', label: CHAT_UNIT_LABEL },
    { value: 'provider', label: 'Provider' },
    { value: 'initiation_source', label: 'Source' },
    { value: 'model', label: 'Model' },
  ] satisfies Array<PickerOption<ChatGroupById>>,
  defaultTableMetric: 'chat_turns',
  defaultTableGrouping: 'workspace',
};

export const PLANS_TAB_SPEC: TabSpec = {
  id: 'plans',
  title: 'Plans',
  emptyMessage: 'No retained plan activity yet.',
  cards: [
    { key: 'created', title: 'Created', display: 'count' },
    { key: 'updated', title: 'Updated', display: 'count' },
    { key: 'approved', title: 'Approved', display: 'count' },
    {
      key: 'approved_per_worktree',
      title: 'Approvals per worktree',
      display: 'count',
    },
  ],
  chartCountSeries: [
    { value: 'plan_created', label: 'Created' },
    { value: 'plan_updated', label: 'Updated' },
    { value: 'plan_approved', label: 'Approved' },
  ],
  chartDistributionMetrics: [],
  chartCountDefaultVisible: ['plan_created', 'plan_updated', 'plan_approved'],
  tableMetrics: [
    { value: 'plan_created', label: 'Created' },
    { value: 'plan_updated', label: 'Updated' },
    { value: 'plan_approved', label: 'Approved' },
  ],
  tableGroupings: [
    { value: 'workspace', label: 'Project' },
    { value: 'worktree', label: WORKTREE_UNIT_LABEL },
    { value: 'initiation_source', label: 'Source' },
  ] satisfies Array<PickerOption<PlanGroupById>>,
  defaultTableMetric: 'plan_approved',
  defaultTableGrouping: 'workspace',
};

const TOOL_CATEGORY_PICKER_LABELS: ReadonlyArray<{
  value: ToolMetricId;
  label: string;
}> = TELEMETRY_TOOL_CATEGORIES.map((category) => ({
  value: `tool_${category}`,
  label: getTelemetryToolCategoryLabel(category),
}));

export const TOOLS_TAB_SPEC: TabSpec = {
  id: 'tools',
  title: 'Agent tools',
  emptyMessage: 'No retained tool activity yet.',
  cards: [
    { key: 'tool_calls', title: 'Tool calls', display: 'count' },
    { key: 'avg_per_turn', title: 'Avg per turn', display: 'distribution-avg' },
    { key: 'p95_per_turn', title: 'P95 per turn', display: 'distribution-p95' },
    { key: 'subagents', title: 'Subagents', display: 'count' },
  ],
  chartCountSeries: TOOL_CATEGORY_PICKER_LABELS as Array<
    PickerOption<UsageMetricId>
  >,
  chartDistributionMetrics: [
    { value: 'tool_calls_per_turn', label: 'Tool calls per turn' },
  ],
  // Default to the 8 categories most commonly used so the stacked bar stays
  // readable. The full list remains toggleable via the legend.
  chartCountDefaultVisible: [
    'tool_bash',
    'tool_read',
    'tool_writeEdit',
    'tool_grep',
    'tool_search',
    'tool_agent',
    'tool_skills',
    'tool_mcp',
  ],
  tableMetrics: [
    { value: 'tool_calls', label: 'All tool calls' },
    ...TOOL_CATEGORY_PICKER_LABELS.map(({ value, label }) => ({
      value,
      label,
    })),
  ],
  tableGroupings: [
    { value: 'category', label: 'Category' },
    { value: 'provider', label: 'Provider' },
    { value: 'initiation_source', label: 'Source' },
    { value: 'workspace', label: 'Project' },
    { value: 'worktree', label: WORKTREE_UNIT_LABEL },
  ] satisfies Array<PickerOption<ToolGroupById>>,
  defaultTableMetric: 'tool_calls',
  defaultTableGrouping: 'category',
};

export const PIPELINES_TAB_SPEC: TabSpec = {
  id: 'pipelines',
  title: 'Workflow runs',
  emptyMessage: 'No retained workflow activity yet.',
  cards: [
    { key: 'runs_started', title: 'Started', display: 'count' },
    { key: 'runs_completed', title: 'Completed', display: 'count' },
    {
      key: 'avg_duration_ms',
      title: 'Avg run time',
      display: 'distribution-avg',
      unit: 'ms',
    },
    { key: 'runs_failed', title: 'Failed', display: 'count' },
  ],
  chartCountSeries: [
    { value: 'pipeline_runs_started', label: 'Started' },
    { value: 'pipeline_runs_completed', label: 'Completed' },
    { value: 'pipeline_runs_succeeded', label: 'Succeeded' },
    { value: 'pipeline_runs_failed', label: 'Failed' },
    { value: 'pipeline_runs_cancelled', label: 'Cancelled' },
  ],
  chartDistributionMetrics: [
    { value: 'pipeline_duration_ms', label: 'Run duration' },
    { value: 'pipeline_steps_per_run', label: 'Steps per run' },
    { value: 'pipeline_agent_steps_per_run', label: 'Agent steps per run' },
    { value: 'pipeline_retries_per_run', label: 'Retries per run' },
  ],
  chartCountDefaultVisible: [
    'pipeline_runs_started',
    'pipeline_runs_completed',
    'pipeline_runs_succeeded',
    'pipeline_runs_failed',
    'pipeline_runs_cancelled',
  ],
  tableMetrics: [
    { value: 'pipeline_runs_started', label: 'Started' },
    { value: 'pipeline_runs_completed', label: 'Completed' },
    { value: 'pipeline_runs_succeeded', label: 'Succeeded' },
    { value: 'pipeline_runs_failed', label: 'Failed' },
    { value: 'pipeline_runs_cancelled', label: 'Cancelled' },
    { value: 'pipeline_duration_ms', label: 'Run duration' },
    { value: 'pipeline_steps_per_run', label: 'Steps per run' },
    { value: 'pipeline_agent_steps_per_run', label: 'Agent steps per run' },
    { value: 'pipeline_retries_per_run', label: 'Retries per run' },
  ],
  tableGroupings: [
    { value: 'workspace', label: 'Project' },
    { value: 'worktree', label: WORKTREE_UNIT_LABEL },
    { value: 'pipeline', label: 'Workflow' },
    { value: 'status', label: 'Status' },
    { value: 'event_name', label: 'Event' },
    { value: 'initiation_source', label: 'Source' },
    { value: 'trigger_source', label: 'Trigger source' },
  ] satisfies Array<PickerOption<PipelineGroupById>>,
  defaultTableMetric: 'pipeline_runs_completed',
  defaultTableGrouping: 'pipeline',
};

export const TAB_SPECS = {
  worktrees: WORKTREES_TAB_SPEC,
  chats: CHATS_TAB_SPEC,
  tokens: TOKENS_TAB_SPEC,
  cost: COST_TAB_SPEC,
  plans: PLANS_TAB_SPEC,
  pipelines: PIPELINES_TAB_SPEC,
  tools: TOOLS_TAB_SPEC,
} as const;
