import { useCallback, useEffect, useRef, useState } from 'react';
import { offerLifecycleJournalQuarantine } from '@canopy/app-state';
import type { SidebarBatchUnitLabel } from '@canopy/ui-shared/components';

/**
 * Bulk removal of sidebar rows (CAN-3975): worktrees, cloud chat sessions,
 * and Work Entries. Hosts supply one awaitable per-row removal; confirmed
 * batches append to one serial queue that runs one item at a time, so
 * removals in one repository never contend for git worktree or ref locks and
 * a host's serial command queue stays honest.
 */

export type { SidebarBatchUnitLabel } from '@canopy/ui-shared/components';

export type SidebarBatchRemovalMode = 'archive' | 'delete';

export interface SidebarBatchRemovalOptions {
  readonly mode: SidebarBatchRemovalMode;
  /** Present only where the host offers a branch choice (desktop). */
  readonly deleteBranch?: boolean;
  /**
   * The branch the confirm showed for this worktree, so a host that guards
   * branch identity refuses one whose branch changed while it waited.
   */
  readonly expectedBranchName?: string;
}

/** One row of a batch; `key` is its selection key. */
export interface SidebarBatchTarget {
  readonly key: string;
  /** The branch the confirm showed, passed as `expectedBranchName`. */
  readonly branchName?: string;
}

/** The host's awaitable removal of one row; rejects on failure. */
export type RemoveRowInBatch<T extends SidebarBatchTarget> = (
  target: T,
  options: SidebarBatchRemovalOptions,
) => Promise<void>;

export type SidebarBatchRemovalPhase = 'confirm' | 'running' | 'results';

/**
 * What a host reports about the open batch dialog (desktop: App Advisor), or
 * about its rows draining in the background: `open: false` with
 * `phase: 'running'` means no dialog is open and `count` is the rows still
 * queued.
 */
export interface SidebarBatchRemovalUiState {
  readonly open: boolean;
  readonly mode: SidebarBatchRemovalMode;
  readonly count: number;
  readonly phase: SidebarBatchRemovalPhase;
}

/**
 * `pending` items never started: the queue stopped before reaching them.
 * `skipped` items became blocked after the confirm and were never passed to
 * the host.
 */
export type SidebarBatchItemStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped';

export interface SidebarBatchItem<T extends SidebarBatchTarget> {
  /** The confirm that queued this item; a key may recur across batches. */
  readonly batchId: string;
  readonly mode: SidebarBatchRemovalMode;
  readonly target: T;
  readonly status: SidebarBatchItemStatus;
  readonly reason?: string;
  /**
   * Still `pending` when the drain ended (Stop, or the host withdrew), so it
   * never runs; a later batch may queue its key again.
   */
  readonly dropped?: true;
}

/** One batch's outcome: only that batch's items. */
export interface SidebarBatchResult<T extends SidebarBatchTarget> {
  readonly items: readonly SidebarBatchItem<T>[];
  readonly allSucceeded: boolean;
  /** Failed, skipped, and not-started keys. */
  readonly remainingKeys: readonly string[];
}

/**
 * Runs the snapshot with `activeKey` (the navigated row) last, so navigation
 * moves once, after everything else is gone.
 */
export function orderSidebarBatchTargets<T extends SidebarBatchTarget>(
  targets: readonly T[],
  activeKey: string | undefined,
): T[] {
  if (activeKey === undefined) return [...targets];
  return [
    ...targets.filter((target) => target.key !== activeKey),
    ...targets.filter((target) => target.key === activeKey),
  ];
}

export function sidebarBatchFailureReason(
  error: unknown,
  mode: SidebarBatchRemovalMode,
  unit: SidebarBatchUnitLabel,
): string {
  if (error instanceof Error && error.message.trim() !== '') {
    return error.message;
  }
  return mode === 'archive'
    ? `Couldn't archive this ${unit.singular}`
    : `Couldn't delete this ${unit.singular}`;
}

export interface SidebarBatchRemovalStart<T extends SidebarBatchTarget> {
  /** The confirm that queued this batch; a key may recur across batches. */
  readonly batchId: string;
  readonly targets: readonly T[];
  readonly options: SidebarBatchRemovalOptions;
  readonly activeKey?: string;
  /** Names the batch's rows in a failure the host gave no message for. */
  readonly unit: SidebarBatchUnitLabel;
}

export interface SidebarRemovalQueueState<T extends SidebarBatchTarget> {
  /** Every batch since the last reset, in run order. */
  readonly items: readonly SidebarBatchItem<T>[];
  readonly running: boolean;
  /** Stop was requested; the in-flight item still finishes. */
  readonly stopRequested: boolean;
}

export interface SidebarRemovalQueue<T extends SidebarBatchTarget> {
  readonly state: () => SidebarRemovalQueueState<T>;
  /**
   * Appends a batch and starts draining if idle. Resolves as soon as the
   * batch's own items have settled or been dropped.
   */
  readonly enqueue: (
    input: SidebarBatchRemovalStart<T>,
  ) => Promise<SidebarBatchResult<T>>;
  /** Drops every not-started item (all batches) once the in-flight one finishes. */
  readonly stop: () => void;
  /** Forgets settled items. No-op while running. */
  readonly reset: () => void;
}

export interface CreateSidebarRemovalQueueInput<T extends SidebarBatchTarget> {
  /**
   * Read before every item so a host that withdraws its removal stops the
   * queue; `undefined` ends the drain.
   */
  readonly remove: (target: T) => RemoveRowInBatch<T> | undefined;
  /**
   * Re-checked immediately before each removal with live facts. The
   * active-session guard lives only in the UI, so a worktree whose agent
   * started after the confirm must be skipped here.
   */
  readonly blockedReasonFor: (target: T) => string | undefined;
  readonly onChange?: (state: SidebarRemovalQueueState<T>) => void;
}

interface QueuedBatch<T extends SidebarBatchTarget> {
  readonly batchId: string;
  readonly options: SidebarBatchRemovalOptions;
  readonly unit: SidebarBatchUnitLabel;
  readonly resolve: (result: SidebarBatchResult<T>) => void;
}

/** Queued or in flight: not yet settled and not dropped by an ended drain. */
export const isSidebarBatchItemOpen = <T extends SidebarBatchTarget>(
  item: SidebarBatchItem<T>,
): boolean =>
  (item.status === 'pending' && item.dropped !== true) ||
  item.status === 'running';

function batchResult<T extends SidebarBatchTarget>(
  items: readonly SidebarBatchItem<T>[],
  batchId: string,
): SidebarBatchResult<T> {
  const own = items.filter((item) => item.batchId === batchId);
  return {
    items: own,
    allSucceeded: own.every((item) => item.status === 'done'),
    remainingKeys: own
      .filter((item) => item.status !== 'done')
      .map((item) => item.target.key),
  };
}

/**
 * One serial queue of row removals. Later batches append; items run one at a
 * time so same-repository git operations never contend and a host's command
 * queue stays ordered. Stop (or a host withdrawing its removal) ends the
 * drain after the in-flight item; dropped items stay `pending`, marked
 * `dropped`. A batch resolves as soon as its own items have settled or been
 * dropped.
 */
export function createSidebarRemovalQueue<T extends SidebarBatchTarget>({
  remove,
  blockedReasonFor,
  onChange,
}: CreateSidebarRemovalQueueInput<T>): SidebarRemovalQueue<T> {
  let items: readonly SidebarBatchItem<T>[] = [];
  let batches: readonly QueuedBatch<T>[] = [];
  let running = false;
  let stopRequested = false;
  const state = (): SidebarRemovalQueueState<T> => ({
    items,
    running,
    stopRequested,
  });
  const emit = (): void => onChange?.(state());
  // Patched by batch AND key: a row that failed in one batch may be selected
  // again and queued in a later one, so the key alone is not unique.
  const update = (
    item: SidebarBatchItem<T>,
    patch: Pick<SidebarBatchItem<T>, 'status' | 'reason'>,
  ): void => {
    items = items.map((current) =>
      current.batchId === item.batchId && current.target.key === item.target.key
        ? { ...current, ...patch }
        : current,
    );
    emit();
  };
  const nextPending = (): SidebarBatchItem<T> | undefined =>
    items.find(
      (item) => item.status === 'pending' && isSidebarBatchItemOpen(item),
    );
  // Resolves every batch with no open items; `all` resolves the rest too
  // (the drain ended and their pending items were dropped).
  const settleBatches = (all: boolean): void => {
    const open: QueuedBatch<T>[] = [];
    for (const batch of batches) {
      const hasOpen = items.some(
        (item) =>
          item.batchId === batch.batchId && isSidebarBatchItemOpen(item),
      );
      if (hasOpen && !all) open.push(batch);
      else batch.resolve(batchResult(items, batch.batchId));
    }
    batches = open;
  };

  const drain = async (): Promise<void> => {
    running = true;
    emit();
    for (let item = nextPending(); item !== undefined; item = nextPending()) {
      const { target, batchId } = item;
      const hostRemove = remove(target);
      if (stopRequested || hostRemove === undefined) break;
      const batch = batches.find((queued) => queued.batchId === batchId);
      // Unreachable: a batch leaves `batches` only once none of its items are
      // open. Fail the item rather than leave it pending with no owner.
      if (batch === undefined) {
        update(item, {
          status: 'failed',
          reason: sidebarBatchFailureReason(undefined, item.mode, {
            singular: 'row',
            plural: 'rows',
          }),
        });
        continue;
      }
      const { options, unit } = batch;
      // The blocked check reads host state too, so a throw there fails this
      // item rather than rejecting the whole queue mid-run.
      try {
        const blockedReason = blockedReasonFor(target);
        if (blockedReason !== undefined) {
          update(item, { status: 'skipped', reason: blockedReason });
        } else {
          update(item, { status: 'running' });
          await hostRemove(
            target,
            target.branchName === undefined
              ? options
              : { ...options, expectedBranchName: target.branchName },
          );
          update(item, { status: 'done' });
        }
      } catch (error) {
        offerLifecycleJournalQuarantine(error);
        update(item, {
          status: 'failed',
          reason: sidebarBatchFailureReason(error, options.mode, unit),
        });
      }
      settleBatches(false);
    }
    running = false;
    stopRequested = false;
    items = items.map((item) =>
      item.status === 'pending' ? { ...item, dropped: true } : item,
    );
    settleBatches(true);
    emit();
  };

  return {
    state,
    enqueue: ({ batchId, targets, options, activeKey, unit }) =>
      new Promise<SidebarBatchResult<T>>((resolve) => {
        // Only open keys dedupe: a settled one may be queued again.
        const queued = new Set(
          items.filter(isSidebarBatchItemOpen).map((item) => item.target.key),
        );
        const fresh = orderSidebarBatchTargets(targets, activeKey).filter(
          (target) => !queued.has(target.key),
        );
        if (fresh.length === 0) {
          resolve({ items: [], allSucceeded: true, remainingKeys: [] });
          return;
        }
        items = [
          ...items,
          ...fresh.map(
            (target): SidebarBatchItem<T> => ({
              batchId,
              mode: options.mode,
              target,
              status: 'pending',
            }),
          ),
        ];
        batches = [...batches, { batchId, options, unit, resolve }];
        emit();
        if (!running) void drain();
      }),
    stop: (): void => {
      if (!running || stopRequested) return;
      stopRequested = true;
      emit();
    },
    reset: (): void => {
      if (running) return;
      items = [];
      emit();
    },
  };
}

export interface SidebarBatchRemoval<T extends SidebarBatchTarget> {
  readonly items: readonly SidebarBatchItem<T>[];
  readonly running: boolean;
  /** Stop was requested; the in-flight item still finishes. */
  readonly stopRequested: boolean;
  /** Resolves `undefined` only when no host removal exists at enqueue time. */
  readonly enqueue: (
    input: SidebarBatchRemovalStart<T>,
  ) => Promise<SidebarBatchResult<T> | undefined>;
  readonly stop: () => void;
  /** Forgets settled items. No-op while running. */
  readonly reset: () => void;
}

export interface UseSidebarBatchRemovalInput<T extends SidebarBatchTarget> {
  /**
   * The removal for one row, or `undefined` when its host can't remove it
   * now (web: the desktop disconnected), which stops the queue.
   */
  readonly removeFor: (target: T) => RemoveRowInBatch<T> | undefined;
  /** Whether any host removal exists to enqueue against. */
  readonly canRemove: boolean;
  /** The same per-row blocked check the confirm's Not included list uses. */
  readonly blockedReasonFor: (target: T) => string | undefined;
}

function idleQueueState<
  T extends SidebarBatchTarget,
>(): SidebarRemovalQueueState<T> {
  return { items: [], running: false, stopRequested: false };
}

/**
 * The queue's React state. Unmount stops the queue after the in-flight item
 * and sets no further state; a host call already in flight completes alone.
 */
export function useSidebarBatchRemoval<T extends SidebarBatchTarget>({
  removeFor,
  canRemove,
  blockedReasonFor,
}: UseSidebarBatchRemovalInput<T>): SidebarBatchRemoval<T> {
  const [state, setState] =
    useState<SidebarRemovalQueueState<T>>(idleQueueState);
  const mountedRef = useRef(true);
  const removeForRef = useRef(removeFor);
  const canRemoveRef = useRef(canRemove);
  const blockedReasonForRef = useRef(blockedReasonFor);
  removeForRef.current = removeFor;
  canRemoveRef.current = canRemove;
  blockedReasonForRef.current = blockedReasonFor;
  const queueRef = useRef<SidebarRemovalQueue<T> | null>(null);
  if (queueRef.current === null) {
    queueRef.current = createSidebarRemovalQueue<T>({
      // The host withdrawing its removal (web: the desktop disconnected) or
      // the surface unmounting stops the queue after the in-flight item.
      remove: (target) =>
        mountedRef.current ? removeForRef.current(target) : undefined,
      blockedReasonFor: (target) => blockedReasonForRef.current(target),
      onChange: (next) => {
        if (mountedRef.current) setState(next);
      },
    });
  }
  const queue = queueRef.current;

  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
      queue.stop();
    };
  }, [queue]);

  const enqueue = useCallback(
    async (
      input: SidebarBatchRemovalStart<T>,
    ): Promise<SidebarBatchResult<T> | undefined> =>
      canRemoveRef.current ? queue.enqueue(input) : undefined,
    [queue],
  );

  return { ...state, enqueue, stop: queue.stop, reset: queue.reset };
}

// Worktree rows: the shapes hosts implement.

export interface WorktreeBatchTarget extends SidebarBatchTarget {
  /** `worktreeRowKey(workspaceLocalId, worktreeLocalId)`. */
  readonly key: string;
  readonly workspaceLocalId: string;
  readonly worktreeLocalId: string;
}

export type WorktreeBatchRemovalMode = SidebarBatchRemovalMode;
export type WorktreeBatchRemovalOptions = SidebarBatchRemovalOptions;
export type WorktreeBatchRemovalUiState = SidebarBatchRemovalUiState;
export type WorktreeBatchItem = SidebarBatchItem<WorktreeBatchTarget>;

/** The host's awaitable removal of one worktree; rejects on failure. */
export type RemoveWorktreeInBatch = (
  workspaceLocalId: string,
  worktreeLocalId: string,
  options: SidebarBatchRemovalOptions,
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
