import type { WorktreeData } from '@canopy/desktop-shared/types';
import { pipelineExecutionIds as executionIds } from './worktree-record-decision-apply';

/**
 * A change to the pipeline executions a worktree has marked seen, by caller.
 * Today the only caller is the renderer's whole-sidebar save, whose snapshot
 * is diffed against the committed row.
 */
export interface WorktreePipelineResultsSeenChange {
  source: 'sidebar_save';
  /** Executions now marked seen; already seen ones are ignored. */
  seen: readonly string[];
  /** Executions no longer marked seen (read again, or pruned). */
  unseen: readonly string[];
}

/**
 * The seen and unseen executions that turn `current` into `incoming`. A row
 * with no committed counterpart is new, so all of its executions are seen.
 */
export function diffWorktreePipelineResultsSeen(
  current: WorktreeData | undefined,
  incoming: WorktreeData,
): WorktreePipelineResultsSeenChange {
  const before = executionIds(current?.seenPipelineExecutionIds);
  const after = executionIds(incoming.seenPipelineExecutionIds);
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    source: 'sidebar_save',
    seen: after.filter((id) => !beforeSet.has(id)),
    unseen: before.filter((id) => !afterSet.has(id)),
  };
}

// Moved with the seen decision's pure apply (W5c2).
export { markWorktreePipelineResultsSeen } from './worktree-record-decision-apply';
