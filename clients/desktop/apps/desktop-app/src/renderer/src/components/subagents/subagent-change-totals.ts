import { useCallback, useEffect, useState } from 'react';
import type { SubagentNode } from '@canopy/agent-transcript';
import type { SubagentChangeTotalsLookup } from '@canopy/ui-app/subagents';
import type { SubagentChangeTotals } from '@canopy/ui-shared';
import { readSubagentWorktreeSummary } from './subagent-commands';
import { subagentScopeKey, type SubagentHostScope } from './subagent-scope';

const CHANGE_TOTALS_CACHE_LIMIT = 200;

const totalsByNodeStatus = new Map<string, SubagentChangeTotals>();
const pendingReads = new Map<string, Promise<void>>();

export interface SubagentChangeTotalsOptions {
  readonly enabled: boolean;
  readonly worktreeDetails: boolean;
  readonly showWorkspaceDetails: boolean;
}

/** The run a follow-up started; a delegate keeps its ID and checkout across runs. */
function latestRunGeneration(node: SubagentNode): number {
  return node.runs.reduce(
    (latest, run) => Math.max(latest, run.runGeneration),
    0,
  );
}

function cacheKey(
  scope: SubagentHostScope,
  delegationId: string,
  runGeneration: number,
  status: SubagentNode['status'],
): string {
  return `${subagentScopeKey(scope)}/${delegationId}/${runGeneration}/${status}`;
}

function rememberTotals(key: string, totals: SubagentChangeTotals): void {
  totalsByNodeStatus.delete(key);
  totalsByNodeStatus.set(key, totals);
  while (totalsByNodeStatus.size > CHANGE_TOTALS_CACHE_LIMIT) {
    const oldestKey = totalsByNodeStatus.keys().next().value;
    if (oldestKey === undefined) break;
    totalsByNodeStatus.delete(oldestKey);
  }
}

/** Reads isolated managed change totals only while their inspector is open. */
export function useSubagentChangeTotals(
  scope: SubagentHostScope,
  selectedNode: SubagentNode | null,
  options: SubagentChangeTotalsOptions,
): SubagentChangeTotalsLookup | undefined {
  const [, setCacheRevision] = useState(0);
  const selectedManagedNode =
    selectedNode?.kind === 'managed' &&
    selectedNode.workspace === 'isolated' &&
    selectedNode.isolatedRevision !== undefined &&
    selectedNode.workspaceDiscarded !== true
      ? selectedNode
      : null;
  const selectedId = selectedManagedNode?.id;
  const selectedRevision = selectedManagedNode?.isolatedRevision;
  const selectedStatus = selectedManagedNode?.status;
  const selectedRunGeneration = selectedManagedNode
    ? latestRunGeneration(selectedManagedNode)
    : 0;
  const enabled =
    options.enabled && options.worktreeDetails && options.showWorkspaceDetails;

  useEffect(() => {
    if (
      !enabled ||
      selectedId === undefined ||
      !selectedRevision ||
      selectedStatus === undefined
    ) {
      return undefined;
    }
    const key = cacheKey(
      scope,
      selectedId,
      selectedRunGeneration,
      selectedStatus,
    );
    if (totalsByNodeStatus.has(key) || pendingReads.has(key)) return undefined;

    let active = true;
    const request = readSubagentWorktreeSummary(
      scope,
      selectedId,
      selectedRevision,
    )
      .then((result): void => {
        if (!result.ok) return;
        const summary: SubagentChangeTotals = {
          filesChanged: result.summary.filesChanged,
          additions: result.summary.additions,
          deletions: result.summary.deletions,
        };
        rememberTotals(key, summary);
        if (active) setCacheRevision((revision) => revision + 1);
      })
      .finally((): void => {
        pendingReads.delete(key);
      });
    pendingReads.set(key, request);
    return (): void => {
      active = false;
    };
  }, [
    enabled,
    scope,
    selectedId,
    selectedRevision,
    selectedRunGeneration,
    selectedStatus,
  ]);

  return useCallback(
    (node: SubagentNode): SubagentChangeTotals | undefined => {
      if (
        !enabled ||
        node.kind !== 'managed' ||
        node.workspace !== 'isolated'
      ) {
        return undefined;
      }
      return totalsByNodeStatus.get(
        cacheKey(scope, node.id, latestRunGeneration(node), node.status),
      );
    },
    [enabled, scope],
  );
}

/** Test-only cleanup for the process-local, bounded summary cache. */
export function resetSubagentChangeTotalsForTests(): void {
  totalsByNodeStatus.clear();
  pendingReads.clear();
}
