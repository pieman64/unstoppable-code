import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  SubagentChangeTotals,
  SubagentNode,
  SubagentWorktreeSummaryState,
} from '@canopy/ui-shared';
import { SUBAGENT_WORKTREE_UNAVAILABLE_LABEL } from '@canopy/ui-shared';
import type { SubagentViewerCapabilities } from '@canopy/ui-app/subagents';
import { readSubagentWorktreeSummary } from './subagent-commands';
import type { SubagentHostScope } from './subagent-scope';

export interface SubagentWorktreeSummaryResult {
  readonly state?: SubagentWorktreeSummaryState;
  readonly changeTotals?: SubagentChangeTotals;
}

interface WorktreeReadState {
  readonly key: string;
  readonly state: SubagentWorktreeSummaryState;
}

/** Reads isolated-delegate details on disclosure, never while the panel is hidden. */
export function useSubagentWorktreeSummary(
  scope: SubagentHostScope,
  node: SubagentNode | undefined,
  detailsExpanded: boolean,
  capabilities: SubagentViewerCapabilities,
): SubagentWorktreeSummaryResult {
  const [readState, setReadState] = useState<WorktreeReadState | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const retry = useCallback((): void => {
    setRetryCount((current) => current + 1);
  }, []);

  const isolatedNode =
    node?.kind === 'managed' && node.workspace === 'isolated'
      ? node
      : undefined;
  const scopeProjectId = scope.projectId;
  const scopeWorktreeId = scope.worktreeId;
  const unavailableReason = useMemo((): string | undefined => {
    if (!detailsExpanded || !isolatedNode) return undefined;
    if (isolatedNode.workspaceDiscarded) {
      return SUBAGENT_WORKTREE_UNAVAILABLE_LABEL;
    }
    if (!capabilities.worktreeDetails) {
      return SUBAGENT_WORKTREE_UNAVAILABLE_LABEL;
    }
    if (!isolatedNode.isolatedRevision) {
      return SUBAGENT_WORKTREE_UNAVAILABLE_LABEL;
    }
    return undefined;
  }, [capabilities.worktreeDetails, detailsExpanded, isolatedNode]);

  const canRead =
    isolatedNode !== undefined &&
    detailsExpanded &&
    capabilities.worktreeDetails &&
    isolatedNode.workspaceDiscarded !== true &&
    isolatedNode.isolatedRevision !== undefined &&
    isolatedNode.isolatedRevision.length > 0;
  const revision =
    canRead && isolatedNode !== undefined
      ? isolatedNode.isolatedRevision
      : undefined;
  const delegationId =
    canRead && isolatedNode !== undefined ? isolatedNode.id : undefined;
  // A follow-up run can end in the same status, so the run counts too.
  const latestRunGeneration = (isolatedNode?.runs ?? []).reduce(
    (latest, run) => Math.max(latest, run.runGeneration),
    0,
  );
  const queryKey =
    canRead &&
    isolatedNode !== undefined &&
    revision !== undefined &&
    delegationId !== undefined
      ? `${scopeProjectId}/${scopeWorktreeId}/${delegationId}/${revision}/${isolatedNode.status}/${latestRunGeneration}/${retryCount}`
      : undefined;

  useEffect(() => {
    if (
      !canRead ||
      revision === undefined ||
      delegationId === undefined ||
      queryKey === undefined
    ) {
      return undefined;
    }
    let cancelled = false;
    setReadState({ key: queryKey, state: { status: 'loading' } });
    void readSubagentWorktreeSummary(
      { projectId: scopeProjectId, worktreeId: scopeWorktreeId },
      delegationId,
      revision,
    ).then((result): void => {
      if (cancelled) return;
      setReadState({
        key: queryKey,
        state: result.ok
          ? { status: 'ready', summary: result.summary }
          : { status: 'error', error: result.error, onRetry: retry },
      });
    });
    return (): void => {
      cancelled = true;
    };
  }, [
    canRead,
    delegationId,
    queryKey,
    retry,
    revision,
    scopeProjectId,
    scopeWorktreeId,
  ]);

  const state = useMemo((): SubagentWorktreeSummaryState | undefined => {
    if (!isolatedNode || !detailsExpanded) return undefined;
    if (unavailableReason !== undefined) {
      return { status: 'unavailable', reason: unavailableReason };
    }
    if (queryKey === undefined) return undefined;
    return readState?.key === queryKey
      ? readState.state
      : { status: 'loading' };
  }, [detailsExpanded, isolatedNode, queryKey, readState, unavailableReason]);

  const changeTotals = useMemo((): SubagentChangeTotals | undefined => {
    if (state?.status !== 'ready') return undefined;
    return {
      filesChanged: state.summary.filesChanged,
      additions: state.summary.additions,
      deletions: state.summary.deletions,
    };
  }, [state]);

  return {
    ...(state !== undefined ? { state } : {}),
    ...(changeTotals !== undefined ? { changeTotals } : {}),
  };
}
