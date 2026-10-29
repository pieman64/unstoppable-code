import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Bulk worktree removal (CAN-3975). Hosts supply one awaitable per-worktree
 * removal; this runs the confirmed snapshot through it one item at a time,
 * so removals in one repository never contend for git worktree or ref locks
 * and a host's serial command queue stays honest.
 */

export type WorktreeBatchRemovalMode = 'archive' | 'delete';

export interface WorktreeBatchRemovalOptions {
  readonly mode: WorktreeBatchRemovalMode;
  /** Present only where the host offers a branch choice (desktop). */
  readonly deleteBranch?: boolean;
  /**
   * The branch the confirm showed for this worktree, so a host that guards
   * branch identity refuses one whose branch changed while it waited.
   */
  readonly expectedBranchName?: string;
}

/** The host's awaitable removal of one worktree; rejects on failure. */
export type RemoveWorktreeInBatch = (
  workspaceLocalId: string,
  worktreeLocalId: string,
  options: WorktreeBatchRemovalOptions,
) => Promise<void>;

/** Local work the confirm warns about; web hosts have none to report. */
export interface WorktreeBatchLocalWork {
  readonly insertions?: number;
  readonly deletions?: number;
  readonly uncommitted?: boolean;
  readonly unpushed?: boolean;
}

/** Host facts for one row of a batch confirm. */
export interface WorktreeBatchRemovalFacts {
  readonly localWork?: WorktreeBatchLocalWork;
  /** Why the host can't remove this worktree right now, if it can't. */
  readonly blockedReason?: string;
}

export type GetWorktreeBatchRemovalFacts = (
  workspaceLocalId: string,
  worktreeLocalId: string,
) => WorktreeBatchRemovalFacts | undefined;

export type WorktreeBatchRemovalPhase = 'confirm' | 'running' | 'results';

/** What a host reports about the open batch dialog (desktop: App Advisor). */
export interface WorktreeBatchRemovalUiState {
  readonly open: boolean;
  readonly mode: WorktreeBatchRemovalMode;
  readonly count: number;
  readonly phase: WorktreeBatchRemovalPhase;
}

export interface WorktreeBatchTarget {
  /** `worktreeRowKey(workspaceLocalId, worktreeLocalId)`. */
  readonly key: string;
  readonly workspaceLocalId: string;
  readonly worktreeLocalId: string;
  /** The branch the confirm showed, passed as `expectedBranchName`. */
  readonly branchName?: string;
}

/**
 * `pending` items never started: the batch stopped before reaching them.
 * `skipped` items became blocked after the confirm and were never passed to
 * the host.
 */
export type WorktreeBatchItemStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped';

export interface WorktreeBatchItem {
  readonly target: WorktreeBatchTarget;
  readonly status: WorktreeBatchItemStatus;
  readonly reason?: string;
}

export interface WorktreeBatchResult {
  readonly items: readonly WorktreeBatchItem[];
  /** Every snapshot target was removed: the dialog may close on its own. */
  readonly allSucceeded: boolean;
  /** Failed, skipped, and not-started keys, which stay selected for a retry. */
  readonly remainingKeys: readonly string[];
}

/**
 * Runs the snapshot with `activeKey` (the navigated worktree) last, so
 * navigation moves once, after everything else is gone.
 */
export function orderWorktreeBatchTargets(
  targets: readonly WorktreeBatchTarget[],
  activeKey: string | undefined,
): WorktreeBatchTarget[] {
  if (activeKey === undefined) return [...targets];
  return [
    ...targets.filter((target) => target.key !== activeKey),
    ...targets.filter((target) => target.key === activeKey),
  ];
}

export function worktreeBatchFailureReason(
  error: unknown,
  mode: WorktreeBatchRemovalMode,
): string {
  if (error instanceof Error && error.message.trim() !== '') {
    return error.message;
  }
  return mode === 'archive'
    ? "Couldn't archive this worktree"
    : "Couldn't delete this worktree";
}

export interface RunWorktreeBatchRemovalInput {
  readonly targets: readonly WorktreeBatchTarget[];
  readonly options: WorktreeBatchRemovalOptions;
  readonly activeKey?: string;
  readonly remove: RemoveWorktreeInBatch;
  /**
   * Re-checked immediately before each removal with the facts the confirm
   * used. The active-session guard lives only in the UI, so a worktree whose
   * agent started after the confirm must be skipped here.
   */
  readonly blockedReasonFor: (
    target: WorktreeBatchTarget,
  ) => string | undefined;
  /**
   * Polled between items: Stop after this one, the surface unmounted, or the
   * host can no longer remove.
   */
  readonly shouldStop: () => boolean;
  readonly onItemsChange?: (items: readonly WorktreeBatchItem[]) => void;
}

export async function runWorktreeBatchRemoval({
  targets,
  options,
  activeKey,
  remove,
  blockedReasonFor,
  shouldStop,
  onItemsChange,
}: RunWorktreeBatchRemovalInput): Promise<WorktreeBatchResult> {
  let items: WorktreeBatchItem[] = orderWorktreeBatchTargets(
    targets,
    activeKey,
  ).map((target) => ({ target, status: 'pending' }));
  const update = (index: number, item: WorktreeBatchItem): void => {
    items = items.map((current, i) => (i === index ? item : current));
    onItemsChange?.(items);
  };
  onItemsChange?.(items);

  for (const [index, { target }] of items.entries()) {
    if (shouldStop()) break;
    // The blocked check reads host state too, so a throw there fails this
    // item rather than rejecting the whole batch mid-run.
    try {
      const blockedReason = blockedReasonFor(target);
      if (blockedReason !== undefined) {
        update(index, { target, status: 'skipped', reason: blockedReason });
        continue;
      }
      update(index, { target, status: 'running' });
      await remove(
        target.workspaceLocalId,
        target.worktreeLocalId,
        target.branchName === undefined
          ? options
          : { ...options, expectedBranchName: target.branchName },
      );
      update(index, { target, status: 'done' });
    } catch (error) {
      update(index, {
        target,
        status: 'failed',
        reason: worktreeBatchFailureReason(error, options.mode),
      });
    }
  }

  return {
    items,
    allSucceeded: items.every((item) => item.status === 'done'),
    remainingKeys: items
      .filter((item) => item.status !== 'done')
      .map((item) => item.target.key),
  };
}

export interface WorktreeBatchRemovalStart {
  readonly targets: readonly WorktreeBatchTarget[];
  readonly options: WorktreeBatchRemovalOptions;
  readonly activeKey?: string;
}

export interface WorktreeBatchRemoval {
  readonly running: boolean;
  /** Stop after this one was requested; the in-flight item still finishes. */
  readonly stopRequested: boolean;
  readonly items: readonly WorktreeBatchItem[];
  /** Resolves with the outcome, or `undefined` if a batch is already running. */
  readonly start: (
    input: WorktreeBatchRemovalStart,
  ) => Promise<WorktreeBatchResult | undefined>;
  readonly stop: () => void;
  /** Forgets a finished batch's items. */
  readonly reset: () => void;
}

export interface UseWorktreeBatchRemovalInput {
  readonly remove: RemoveWorktreeInBatch | undefined;
  /** The same per-row blocked check the confirm's Not included list uses. */
  readonly blockedReasonFor: (
    target: WorktreeBatchTarget,
  ) => string | undefined;
}

/**
 * The batch runner's React state. After unmount it starts no further items
 * and sets no state; a host call already in flight completes on its own.
 */
export function useWorktreeBatchRemoval({
  remove,
  blockedReasonFor,
}: UseWorktreeBatchRemovalInput): WorktreeBatchRemoval {
  const [items, setItems] = useState<readonly WorktreeBatchItem[]>([]);
  const [running, setRunning] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const mountedRef = useRef(true);
  const runningRef = useRef(false);
  const stopRef = useRef(false);
  const removeRef = useRef(remove);
  const blockedReasonForRef = useRef(blockedReasonFor);
  removeRef.current = remove;
  blockedReasonForRef.current = blockedReasonFor;

  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);

  const start = useCallback(
    async ({
      targets,
      options,
      activeKey,
    }: WorktreeBatchRemovalStart): Promise<WorktreeBatchResult | undefined> => {
      const hostRemove = removeRef.current;
      if (runningRef.current || hostRemove === undefined) return undefined;
      runningRef.current = true;
      stopRef.current = false;
      setStopRequested(false);
      setRunning(true);
      try {
        return await runWorktreeBatchRemoval({
          targets,
          options,
          activeKey,
          remove: hostRemove,
          blockedReasonFor: (target) => blockedReasonForRef.current(target),
          // The host withdrawing its removal (web: the desktop disconnected)
          // stops the batch too; the in-flight item still finishes.
          shouldStop: () =>
            stopRef.current ||
            !mountedRef.current ||
            removeRef.current === undefined,
          onItemsChange: (next) => {
            if (mountedRef.current) setItems(next);
          },
        });
      } finally {
        runningRef.current = false;
        if (mountedRef.current) setRunning(false);
      }
    },
    [],
  );

  const stop = useCallback((): void => {
    if (!runningRef.current) return;
    stopRef.current = true;
    setStopRequested(true);
  }, []);

  const reset = useCallback((): void => {
    if (runningRef.current) return;
    setItems([]);
    setStopRequested(false);
  }, []);

  return { running, stopRequested, items, start, stop, reset };
}
