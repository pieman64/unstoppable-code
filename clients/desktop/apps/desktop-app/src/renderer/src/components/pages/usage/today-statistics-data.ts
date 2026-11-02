import {
  SINGLE_REPO_USAGE_REPO_ID,
  type AgentAuditEntry,
  type UsageBreakdownRow,
  type UsageMetricsViewResponse,
} from '@canopy/desktop-shared/types';

export interface TodayStats {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  chats: number;
  chatTurns: number;
  prs: number;
  pipelines: number;
  repos: number;
  tools: number;
  durationMs: number;
}

export interface RepoActivity {
  key: string;
  label: string;
  count: number;
}

export interface PipelineActivity {
  key: string;
  label: string;
  count: number;
}

interface PipelineExecutionActivity {
  key: string;
  label: string;
}

export interface TodayData {
  stats: TodayStats;
  repoRows: RepoActivity[];
  providerRows: UsageBreakdownRow[];
  toolRows: UsageBreakdownRow[];
  pipelineRows: PipelineActivity[];
}

function tokenTotal(entry: AgentAuditEntry): number {
  return (
    entry.tokens.input +
    entry.tokens.output +
    entry.tokens.cacheReadInputTokens +
    entry.tokens.cacheCreationInputTokens
  );
}

function repoKey(entry: AgentAuditEntry): string | null {
  if (entry.repoId === SINGLE_REPO_USAGE_REPO_ID) {
    const label = entry.repoLabel?.trim();
    if (!label) return entry.repoId;
    return [entry.projectId, label].filter(Boolean).join('::');
  }
  return entry.repoId ?? entry.repoLabel ?? null;
}

function repoLabel(entry: AgentAuditEntry): string | null {
  return entry.repoLabel ?? entry.repoId ?? null;
}

function addRepoActivity(
  repoCounts: Map<string, RepoActivity>,
  key: string | null,
  label: string | null,
): void {
  if (!key) return;
  const current = repoCounts.get(key) ?? {
    key,
    label: label ?? key,
    count: 0,
  };
  current.count += 1;
  repoCounts.set(key, current);
}

function isPrActivityEntry(entry: AgentAuditEntry): boolean {
  return (
    entry.eventType === 'pr_generation' &&
    // Stored audit label written by github-pr-generator, not display copy.
    entry.label !== 'PR Content Generation'
  );
}

function isFallbackPipelineActivity(
  activity: PipelineExecutionActivity,
): boolean {
  return (
    activity.key === 'untitled-pipeline' ||
    activity.label === 'Untitled workflow' ||
    activity.label === activity.key
  );
}

export function buildTodayData(
  entries: AgentAuditEntry[],
  chatProviders: UsageMetricsViewResponse,
  toolsByCategory: UsageMetricsViewResponse,
): TodayData {
  const chatIds = new Set<string>();
  const pipelineExecutions = new Map<string, PipelineExecutionActivity>();
  const repoCounts = new Map<string, RepoActivity>();
  const prEntries = entries.filter(isPrActivityEntry);

  let tokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheTokens = 0;
  let durationMs = 0;

  for (const entry of entries) {
    tokens += tokenTotal(entry);
    inputTokens += entry.tokens.input;
    outputTokens += entry.tokens.output;
    cacheTokens +=
      entry.tokens.cacheReadInputTokens + entry.tokens.cacheCreationInputTokens;
    durationMs += entry.durationMs ?? 0;

    if (entry.chatId) {
      chatIds.add(entry.chatId);
    }
    if (entry.pipelineExecutionId) {
      const key = entry.pipelineId ?? 'untitled-pipeline';
      const label =
        entry.pipelineName?.trim() || entry.pipelineId || 'Untitled workflow';
      const current = pipelineExecutions.get(entry.pipelineExecutionId) ?? {
        key,
        label,
      };
      if (current.key === 'untitled-pipeline' && key !== current.key) {
        current.key = key;
      }
      if (isFallbackPipelineActivity(current) && label !== current.label) {
        current.label = label;
      }
      pipelineExecutions.set(entry.pipelineExecutionId, current);
    }

    if (isPrActivityEntry(entry)) {
      addRepoActivity(repoCounts, repoKey(entry), repoLabel(entry));
    }
  }

  const repoRows = Array.from(repoCounts.values()).sort(
    (left, right) =>
      right.count - left.count ||
      left.label.localeCompare(right.label) ||
      left.key.localeCompare(right.key),
  );
  const pipelineCounts = new Map<string, PipelineActivity>();
  for (const execution of Array.from(pipelineExecutions.values())) {
    const current = pipelineCounts.get(execution.key) ?? {
      key: execution.key,
      label: execution.label,
      count: 0,
    };
    if (current.label === current.key && execution.label !== execution.key) {
      current.label = execution.label;
    }
    current.count += 1;
    pipelineCounts.set(execution.key, current);
  }
  const pipelineRows = Array.from(pipelineCounts.values()).sort(
    (left, right) => right.count - left.count,
  );
  const prCount = prEntries.length;

  return {
    stats: {
      tokens,
      inputTokens,
      outputTokens,
      cacheTokens,
      chats: chatIds.size,
      chatTurns: chatProviders.rows.reduce((sum, row) => sum + row.count, 0),
      prs: prCount,
      pipelines: pipelineExecutions.size,
      repos: repoRows.length,
      tools: toolsByCategory.rows.reduce((sum, row) => sum + row.count, 0),
      durationMs,
    },
    repoRows,
    providerRows: chatProviders.rows,
    toolRows: toolsByCategory.rows,
    pipelineRows,
  };
}
