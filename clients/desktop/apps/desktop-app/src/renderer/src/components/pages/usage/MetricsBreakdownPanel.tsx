import { type JSX, useEffect, useMemo, useState } from 'react';
import type {
  UsageBreakdownRow,
  UsageGroupById,
  UsageMetricId,
  UsageMetricsViewResponse,
} from '@canopy/desktop-shared/types';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { LoadingPlaceholder } from '@/components/shared/StatusBlocks';
import type { TabSpec } from './tab-specs';
import { formatCurrencyUsd, formatNumber } from './format';

interface MetricsBreakdownPanelProps {
  spec: TabSpec;
}

export function MetricsBreakdownPanel({
  spec,
}: MetricsBreakdownPanelProps): JSX.Element {
  const [metric, setMetric] = useState<UsageMetricId>(spec.defaultTableMetric);
  const [groupBy, setGroupBy] = useState<UsageGroupById>(
    spec.defaultTableGrouping,
  );

  // Reset to tab defaults when the tab changes.
  useEffect(() => {
    setMetric(spec.defaultTableMetric);
    setGroupBy(spec.defaultTableGrouping);
  }, [spec]);

  const loadUsageMetricsView = useObservabilityStore(
    (s) => s.loadUsageMetricsView,
  );
  const [response, setResponse] = useState<UsageMetricsViewResponse | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setResponse(null);
    loadUsageMetricsView({
      tab: spec.id,
      metric,
      groupBy,
      window: { kind: 'last7d' },
    })
      .then((next) => {
        if (cancelled) return;
        setResponse(next);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(
          reason instanceof Error ? reason.message : 'Failed to load breakdown',
        );
      });
    return (): void => {
      cancelled = true;
    };
  }, [spec.id, metric, groupBy, loadUsageMetricsView]);

  const showStats = useMemo(() => {
    return Boolean(response?.stats);
  }, [response]);

  const onMetricChange = (value: string): void => {
    const next = spec.tableMetrics.find((m) => m.value === value);
    if (next) setMetric(next.value);
  };

  const onGroupByChange = (value: string): void => {
    const next = spec.tableGroupings.find((g) => g.value === value);
    if (next) setGroupBy(next.value);
  };

  return (
    <div
      className="rounded-xl border bg-card/60"
      data-testid={`usage-breakdown-${spec.id}`}
    >
      <div className="flex flex-wrap items-center gap-3 border-b px-3 py-2 text-s">
        <div className="flex items-center gap-2">
          <label
            className="text-xs fg-secondary"
            htmlFor={`breakdown-metric-${spec.id}`}
          >
            Metric:
          </label>
          <select
            id={`breakdown-metric-${spec.id}`}
            value={metric}
            onChange={(event): void => onMetricChange(event.target.value)}
            data-testid={`usage-breakdown-metric-${spec.id}`}
            className="rounded border bg-base px-1 py-0.5 text-s fg-primary"
          >
            {spec.tableMetrics.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label
            className="text-xs fg-secondary"
            htmlFor={`breakdown-group-${spec.id}`}
          >
            Group by:
          </label>
          <select
            id={`breakdown-group-${spec.id}`}
            value={groupBy}
            onChange={(event): void => onGroupByChange(event.target.value)}
            data-testid={`usage-breakdown-groupby-${spec.id}`}
            className="rounded border bg-base px-1 py-0.5 text-s fg-primary"
          >
            {spec.tableGroupings.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error ? (
        <div className="px-3 py-4 text-s fg-destructive">{error}</div>
      ) : response === null ? (
        <div className="px-3">
          <LoadingPlaceholder space="section" label="Loading breakdown…" />
        </div>
      ) : response.rows.length === 0 ? (
        <div className="px-3 py-4 text-s fg-secondary">{spec.emptyMessage}</div>
      ) : (
        <BreakdownTable
          rows={response.rows}
          showStats={showStats}
          groupBy={groupBy}
          countColumnLabel={spec.countColumnLabel ?? 'Count'}
          valueFormat={spec.valueFormat ?? 'number'}
        />
      )}
    </div>
  );
}

interface BreakdownTableProps {
  rows: ReadonlyArray<UsageBreakdownRow>;
  showStats: boolean;
  groupBy: UsageGroupById;
  countColumnLabel: string;
  valueFormat: 'number' | 'currency';
}

function BreakdownTable({
  rows,
  showStats,
  groupBy,
  countColumnLabel,
  valueFormat,
}: BreakdownTableProps): JSX.Element {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-s">
        <thead className="bg-secondary/30 text-xs fg-secondary">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Group</th>
            <th className="px-3 py-2 text-right font-medium">
              {countColumnLabel}
            </th>
            {showStats && (
              <>
                <th className="px-3 py-2 text-right font-medium">Min</th>
                <th className="px-3 py-2 text-right font-medium">Max</th>
                <th className="px-3 py-2 text-right font-medium">Avg</th>
                <th className="px-3 py-2 text-right font-medium">P50</th>
                <th className="px-3 py-2 text-right font-medium">P95</th>
                <th className="px-3 py-2 text-right font-medium">P99</th>
              </>
            )}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <tr key={row.key}>
              <td className="px-3 py-2 text-left fg-primary">
                {groupBy === 'worktree' ? (
                  <WorktreeBreakdownLabel row={row} />
                ) : (
                  row.label
                )}
              </td>
              <td className="px-3 py-2 text-right fg-primary">
                {valueFormat === 'currency'
                  ? formatCurrencyUsd(row.count)
                  : row.count.toLocaleString()}
              </td>
              {showStats && (
                <>
                  <td className="px-3 py-2 text-right fg-primary">
                    {formatNumber(row.stats?.min)}
                  </td>
                  <td className="px-3 py-2 text-right fg-primary">
                    {formatNumber(row.stats?.max)}
                  </td>
                  <td className="px-3 py-2 text-right fg-primary">
                    {formatNumber(row.stats?.avg)}
                  </td>
                  <td className="px-3 py-2 text-right fg-primary">
                    {formatNumber(row.stats?.p50)}
                  </td>
                  <td className="px-3 py-2 text-right fg-primary">
                    {formatNumber(row.stats?.p95)}
                  </td>
                  <td className="px-3 py-2 text-right fg-primary">
                    {formatNumber(row.stats?.p99)}
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WorktreeBreakdownLabel({
  row,
}: {
  row: UsageBreakdownRow;
}): JSX.Element {
  const projects = useProjectsStore((s) => s.projects);
  if (!row.worktreeId) return <>{row.label}</>;

  const workspace = row.workspaceId
    ? projects.find((p) => p.id === row.workspaceId)
    : undefined;
  const workspaceLabel =
    workspace?.name ?? row.workspaceLabel ?? row.workspaceId ?? 'Project';
  const worktree =
    workspace && workspace.type !== 'cowork'
      ? workspace.worktrees.find((w) => w.id === row.worktreeId)
      : undefined;
  const branchName = worktree?.branchName;
  if (branchName) {
    return <>{`${workspaceLabel} / ${row.worktreeId} (${branchName})`}</>;
  }
  return <>{`${workspaceLabel} / ${row.worktreeId}`}</>;
}
