import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { CanopyCapabilities } from '@canopy/app-core';
import { DEFAULT_ARCHIVE_RETENTION_DAYS } from '@canopy/protocol/archive-retention';
import {
  worktreeCountLabel,
  type WorktreeBatchRemovalDialogExcludedRow,
  type WorktreeBatchRemovalDialogRow,
} from '@canopy/ui-shared/components';
import type {
  SidebarSelection,
  SidebarSurfaceSnapshot,
} from '../SidebarSurface';
import { worktreeRowKey } from '../workspace-sections-model';
import type { SnapshotWorktree } from '../worktree-status';
import { sidebarRowLabel } from '../worktree-status';
import {
  batchActionAvailability,
  worktreeRemovalBlockedReason,
  type WorktreeBatchActionAvailability,
  type WorktreeBatchAvailabilityRow,
  type WorktreeMenuCallbacks,
  type WorktreeMenuContext,
} from '../worktree-menu-items';
import { getWorktreeDeleteLabels } from '../worktree-removal-labels';
import {
  useWorktreeBatchRemoval,
  type GetWorktreeBatchRemovalFacts,
  type RemoveWorktreeInBatch,
  type WorktreeBatchLocalWork,
  type WorktreeBatchRemovalMode,
  type WorktreeBatchRemovalUiState,
  type WorktreeBatchTarget,
} from './use-worktree-batch-removal';
import {
  isWorktreeSelectable,
  useWorktreeSelection,
  WORKTREE_SELECTION_KEEPER_SELECTOR,
  WORKTREE_SELECTION_ROW_ATTR,
  type WorktreeSelection,
  type WorktreeSelectionRow,
  type WorktreeSelectionRows,
} from './worktree-selection';

type SidebarWorkspace = SidebarSurfaceSnapshot['workspaces'][number];

// The batch confirm opens only from a selection, never on first paint: keep
// it out of every route that mounts the rail. Selecting a row starts the load,
// so the dialog is usually ready before an action is picked.
const WorktreeBatchRemovalDialog = lazy(() =>
  import('@canopy/ui-shared/components/WorktreeBatchRemovalDialog').then(
    (module) => ({ default: module.WorktreeBatchRemovalDialog }),
  ),
);

function preloadWorktreeBatchRemovalDialog(): void {
  void import('@canopy/ui-shared/components/WorktreeBatchRemovalDialog');
}

/** The workspace fields selectability reads; sections and surface both fit. */
export interface WorktreeSelectableWorkspace {
  readonly localId: string;
  readonly type?: string;
}

/**
 * What the worktree sections need to offer multi-select on their rows. The
 * sections report the rows they render, in order, so ranges and select-all
 * follow what the user sees.
 */
export interface WorktreeMultiSelectBinding {
  readonly selection: WorktreeSelection;
  readonly isSelectable: (
    workspace: WorktreeSelectableWorkspace,
    worktree: SnapshotWorktree,
  ) => boolean;
  /** Stable per list; an unmounting list reports no rows. */
  readonly onRowsChange: (rows: WorktreeSelectionRows) => void;
  /** Esc clears the selection; off while a batch runs. */
  readonly escapeClears: boolean;
}

export interface UseSidebarWorktreeBulkInput {
  /** Bulk is offered: the host wired a batch removal and the rail is live. */
  readonly enabled: boolean;
  readonly snapshot: SidebarSurfaceSnapshot;
  readonly navigation: SidebarSelection | undefined;
  readonly capabilitiesOf: (localId: string) => CanopyCapabilities;
  readonly remove: RemoveWorktreeInBatch | undefined;
  readonly getFacts?: GetWorktreeBatchRemovalFacts;
  readonly branchChoice: boolean;
  readonly onStateChange?: (state: WorktreeBatchRemovalUiState | null) => void;
  readonly isWorkspaceCommandDisabled?: (workspaceLocalId: string) => boolean;
  readonly isWorktreeRemovalInProgress?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => boolean;
  readonly hasActiveWorktreeSession?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => boolean;
  readonly getWorktreeSetupPhase?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => 'git-pending' | 'running-setup' | undefined;
  readonly worktreeRetentionDaysFor?: (
    workspaceLocalId: string,
  ) => number | undefined;
  readonly dialogTestId?: string;
}

/**
 * A confirmed target with the names the confirm showed. A removed row leaves
 * the snapshot mid-batch (desktop removes it optimistically), so the running
 * and results phases can't look it up live.
 */
interface BulkDialogTarget extends WorktreeBatchTarget {
  readonly projectName: string;
  readonly label: string;
}

interface BulkDialogState {
  readonly mode: WorktreeBatchRemovalMode;
  readonly phase: 'confirm' | 'running' | 'results';
  readonly included: readonly BulkDialogTarget[];
  readonly excluded: readonly WorktreeBatchRemovalDialogExcludedRow[];
  /** Keys that stay selected when the results close. */
  readonly remainingKeys: readonly string[];
}

/** One row's selection context and callbacks for its menu. */
export interface WorktreeBulkRowMenu {
  readonly context: Pick<
    WorktreeMenuContext,
    'multiSelected' | 'bulkSelection'
  >;
  readonly callbacks: Pick<
    WorktreeMenuCallbacks,
    | 'onToggleSelectionRequested'
    | 'onBulkRemovalRequested'
    | 'onClearSelectionRequested'
  >;
}

export interface SidebarWorktreeBulk {
  /**
   * Handed to one sections list (the rail can mount several: Projects, a
   * tree-shaped Chats owner); absent while bulk is not offered.
   */
  readonly bindingFor: (
    listId: string,
  ) => WorktreeMultiSelectBinding | undefined;
  /** The row menu's selection context and callbacks for one row. */
  readonly menuFor: (
    workspace: SidebarWorkspace,
    worktree: SnapshotWorktree,
  ) => WorktreeBulkRowMenu;
  readonly dialog: ReactNode;
}

const NO_ROWS: WorktreeSelectionRows = new Map();

function sameRows(a: WorktreeSelectionRows, b: WorktreeSelectionRows): boolean {
  if (a.size !== b.size) return false;
  for (const [workspaceLocalId, rows] of a) {
    const other = b.get(workspaceLocalId);
    if (other?.length !== rows.length) return false;
    for (const [index, row] of rows.entries()) {
      const match = other[index];
      if (match?.key !== row.key || match.selectable !== row.selectable) {
        return false;
      }
    }
  }
  return true;
}

/**
 * A row being removed is inert, so a press on it lands on its container
 * instead. It is still a press on a row, not elsewhere.
 */
function pressesInertSelectionRow(
  target: Element,
  x: number,
  y: number,
): boolean {
  for (const row of target.querySelectorAll(
    `[${WORKTREE_SELECTION_ROW_ATTR}][inert]`,
  )) {
    const rect = row.getBoundingClientRect();
    if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) {
      return true;
    }
  }
  return false;
}

function hasLocalWork(localWork: WorktreeBatchLocalWork | undefined): boolean {
  if (localWork === undefined) return false;
  return (
    (localWork.insertions ?? 0) + (localWork.deletions ?? 0) > 0 ||
    localWork.uncommitted === true ||
    localWork.unpushed === true
  );
}

/**
 * Bulk worktree selection and removal for the shared rail (CAN-3975):
 * selection state, the selection's row menu, the batch confirm, and the
 * runner. Hosts supply one awaitable per-worktree removal; nothing here
 * branches on host.
 */
export function useSidebarWorktreeBulk(
  input: UseSidebarWorktreeBulkInput,
): SidebarWorktreeBulk {
  const {
    enabled,
    snapshot,
    navigation,
    capabilitiesOf,
    remove,
    getFacts,
    branchChoice,
    onStateChange,
  } = input;
  const [rowsByList, setRowsByList] = useState<
    ReadonlyMap<string, WorktreeSelectionRows>
  >(new Map());
  const rows = useMemo((): WorktreeSelectionRows => {
    const merged = new Map<string, readonly WorktreeSelectionRow[]>();
    for (const listRows of rowsByList.values()) {
      for (const [workspaceLocalId, workspaceRows] of listRows) {
        merged.set(workspaceLocalId, [
          ...(merged.get(workspaceLocalId) ?? []),
          ...workspaceRows,
        ]);
      }
    }
    return merged;
  }, [rowsByList]);
  const selection = useWorktreeSelection(enabled ? rows : NO_ROWS);
  const [dialog, setDialog] = useState<BulkDialogState | null>(null);
  // A confirm fired twice before re-rendering starts one batch; the second
  // is ignored, so `start` resolving `undefined` means the host withdrew.
  const startingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);

  // Rows by key, for the selected rows only: nothing reads it until a row is
  // selected, so an idle rail builds none of it.
  const needsLookup = selection.active || dialog !== null;

  const preloadDialog = enabled && selection.active;
  useEffect(() => {
    if (preloadDialog) preloadWorktreeBatchRemovalDialog();
  }, [preloadDialog]);
  const lookup = useMemo(() => {
    const byKey = new Map<
      string,
      { workspace: SidebarWorkspace; worktree: SnapshotWorktree }
    >();
    if (!needsLookup) return byKey;
    const workspaces = new Map(
      snapshot.workspaces.map((workspace) => [workspace.localId, workspace]),
    );
    for (const worktree of snapshot.worktrees) {
      const workspace = workspaces.get(worktree.workspaceLocalId);
      if (workspace === undefined) continue;
      byKey.set(worktreeRowKey(workspace.localId, worktree.localId), {
        workspace,
        worktree,
      });
    }
    return byKey;
  }, [needsLookup, snapshot.workspaces, snapshot.worktrees]);

  // The runner re-checks each row against the LIVE state right before it
  // removes it, so the check reads through a ref, not the render's closure.
  const blockedReasonFor = (key: string): string | undefined => {
    const entry = lookup.get(key);
    if (entry === undefined) return 'Worktree was not found';
    const { workspace, worktree } = entry;
    const hostReason = getFacts?.(
      workspace.localId,
      worktree.localId,
    )?.blockedReason;
    if (hostReason !== undefined) return hostReason;
    const setupPhase =
      input.getWorktreeSetupPhase?.(workspace.localId, worktree.localId) ??
      (worktree.setupPhase === 'git-pending' ||
      worktree.setupPhase === 'running-setup'
        ? worktree.setupPhase
        : undefined);
    return worktreeRemovalBlockedReason({
      removalLockedBySplitPr: worktree.splitPrLocked === true,
      removalInProgress:
        input.isWorktreeRemovalInProgress?.(
          workspace.localId,
          worktree.localId,
        ) === true,
      hasActiveSession:
        worktree.isStreaming === true ||
        input.hasActiveWorktreeSession?.(
          workspace.localId,
          worktree.localId,
        ) === true,
      setupPhase,
    });
  };
  const blockedReasonForRef = useRef(blockedReasonFor);
  blockedReasonForRef.current = blockedReasonFor;
  const batch = useWorktreeBatchRemoval({
    remove: enabled ? remove : undefined,
    blockedReasonFor: (target) => blockedReasonForRef.current(target.key),
  });

  const isSelectable = (
    workspace: WorktreeSelectableWorkspace,
    worktree: SnapshotWorktree,
  ): boolean =>
    isWorktreeSelectable({
      subject: workspace.type === 'cowork' ? 'session' : 'worktree',
      worktreeRemoval: capabilitiesOf(worktree.localId).worktreeRemoval,
      commandsDisabled:
        input.isWorkspaceCommandDisabled?.(workspace.localId) === true,
      hidden: worktree.hidden === true,
      removalInProgress:
        input.isWorktreeRemovalInProgress?.(
          workspace.localId,
          worktree.localId,
        ) === true,
    });

  const reportersRef = useRef(
    new Map<string, (next: WorktreeSelectionRows) => void>(),
  );
  const reporterFor = useCallback(
    (listId: string): ((next: WorktreeSelectionRows) => void) => {
      const existing = reportersRef.current.get(listId);
      if (existing !== undefined) return existing;
      const report = (next: WorktreeSelectionRows): void =>
        setRowsByList((current) => {
          const previous = current.get(listId) ?? NO_ROWS;
          if (sameRows(previous, next)) return current;
          const updated = new Map(current);
          if (next.size === 0) updated.delete(listId);
          else updated.set(listId, next);
          return updated;
        });
      reportersRef.current.set(listId, report);
      return report;
    },
    [],
  );

  // Selected keys in rendered order, so the confirm lists what the rail shows.
  const orderedSelectedKeys = useMemo((): string[] => {
    const keys: string[] = [];
    for (const workspaceRows of rows.values()) {
      for (const row of workspaceRows) {
        if (selection.isSelected(row.key)) keys.push(row.key);
      }
    }
    return keys;
  }, [rows, selection]);

  const availabilityRows = orderedSelectedKeys.flatMap(
    (key): WorktreeBatchAvailabilityRow[] => {
      const entry = lookup.get(key);
      if (entry === undefined) return [];
      const capabilities = capabilitiesOf(entry.worktree.localId);
      return [
        {
          removal: capabilities.worktreeRemoval,
          retention: capabilities.worktreeRetention,
          commandsDisabled:
            input.isWorkspaceCommandDisabled?.(entry.workspace.localId) ===
            true,
        },
      ];
    },
  );
  const availability: WorktreeBatchActionAvailability =
    batchActionAvailability(availabilityRows);

  const openBatch = (mode: WorktreeBatchRemovalMode): void => {
    if (batch.running || !availability[mode].enabled) return;
    const included: BulkDialogTarget[] = [];
    const excluded: WorktreeBatchRemovalDialogExcludedRow[] = [];
    for (const key of orderedSelectedKeys) {
      const entry = lookup.get(key);
      if (entry === undefined) continue;
      const { workspace, worktree } = entry;
      const reason = blockedReasonFor(key);
      if (reason === undefined) {
        included.push({
          key,
          workspaceLocalId: workspace.localId,
          worktreeLocalId: worktree.localId,
          projectName: workspace.name,
          label: sidebarRowLabel(workspace, worktree),
          branchName: worktree.branch,
        });
      } else {
        excluded.push({
          key,
          projectName: workspace.name,
          label: sidebarRowLabel(workspace, worktree),
          branchName: worktree.branch,
          reason,
        });
      }
    }
    batch.reset();
    setDialog({
      mode,
      phase: 'confirm',
      included,
      excluded,
      remainingKeys: [],
    });
  };

  const closeDialog = (keepKeys: readonly string[]): void => {
    setDialog(null);
    batch.reset();
    if (keepKeys.length === 0) selection.clear();
    else selection.replace(keepKeys);
  };

  const confirm = (deleteBranch?: boolean): void => {
    if (dialog === null || dialog.phase !== 'confirm') return;
    const { mode, included, excluded } = dialog;
    if (included.length === 0 || startingRef.current) return;
    startingRef.current = true;
    const activeKey =
      navigation?.kind === 'worktree'
        ? worktreeRowKey(
            navigation.workspaceLocalId,
            navigation.worktreeLocalId,
          )
        : undefined;
    setDialog({ ...dialog, phase: 'running' });
    const excludedKeys = excluded.map((row) => row.key);
    void batch
      .start({
        targets: included,
        options: branchChoice
          ? { mode, deleteBranch: deleteBranch === true }
          : { mode },
        activeKey,
      })
      .then((result) => {
        startingRef.current = false;
        if (!mountedRef.current) return;
        // Nothing ran (the host withdrew its removal): leave the selection
        // as it was rather than strand an undismissable running dialog.
        if (result === undefined) {
          setDialog(null);
          batch.reset();
          return;
        }
        if (result.allSucceeded) {
          closeDialog(excludedKeys);
          return;
        }
        setDialog((current) =>
          current === null
            ? current
            : {
                ...current,
                phase: 'results',
                remainingKeys: [...result.remainingKeys, ...excludedKeys],
              },
        );
      });
  };

  const dialogRowsFor = (
    dialog: BulkDialogState,
  ): WorktreeBatchRemovalDialogRow[] => {
    const statusByKey = new Map(
      batch.items.map((item) => [item.target.key, item]),
    );
    const includedByKey = new Map(
      dialog.included.map((target) => [target.key, target]),
    );
    const targets =
      dialog.phase === 'confirm' || batch.items.length === 0
        ? dialog.included
        : batch.items.flatMap((item) => {
            const target = includedByKey.get(item.target.key);
            return target === undefined ? [] : [target];
          });
    return targets.flatMap((target): WorktreeBatchRemovalDialogRow[] => {
      const item = statusByKey.get(target.key);
      const localWork =
        dialog.phase === 'confirm'
          ? getFacts?.(target.workspaceLocalId, target.worktreeLocalId)
              ?.localWork
          : undefined;
      return [
        {
          key: target.key,
          projectName: target.projectName,
          label: target.label,
          branchName: target.branchName,
          ...(localWork !== undefined ? { localWork } : {}),
          ...(dialog.phase === 'confirm'
            ? {}
            : { status: item?.status ?? 'pending', reason: item?.reason }),
        },
      ];
    });
  };

  const copyFor = (
    dialog: BulkDialogState,
  ): {
    retentionSummary: string;
    retentionDetail: string;
    warning: string | undefined;
  } => {
    const { mode, included } = dialog;
    const days = new Set(
      included.map(
        (target) =>
          input.worktreeRetentionDaysFor?.(target.workspaceLocalId) ??
          DEFAULT_ARCHIVE_RETENTION_DAYS,
      ),
    );
    const [onlyDays] = days;
    const labels = getWorktreeDeleteLabels(
      mode,
      onlyDays ?? DEFAULT_ARCHIVE_RETENTION_DAYS,
      '',
    );
    const mixedWindows = mode === 'delete' && days.size > 1;
    const retentionSummary = mixedWindows
      ? "Restorable for each project's retention window when an archive can be created."
      : labels.retentionSummary;
    const capabilities = included.map((target) =>
      capabilitiesOf(target.worktreeLocalId),
    );
    const localWorkCount = included.filter((target) =>
      hasLocalWork(
        getFacts?.(target.workspaceLocalId, target.worktreeLocalId)?.localWork,
      ),
    ).length;
    const savedChanges = capabilities.some(
      (caps) => caps.worktreeRemovalCopy === 'saved-changes',
    );
    const remoteCheckout =
      getFacts === undefined &&
      included.some(
        (target) => lookup.get(target.key)?.worktree.backend !== 'cloud',
      );
    const warning = savedChanges
      ? "Each worktree's changes are saved before it stops. If they can't be saved, you choose what happens."
      : localWorkCount > 0
        ? `${worktreeCountLabel(localWorkCount)} ${localWorkCount === 1 ? 'has' : 'have'} local work. It's kept with the archive when a restorable archive can be created.`
        : remoteCheckout
          ? 'This removes each active checkout. Restore them from the desktop app.'
          : undefined;
    const kept =
      localWorkCount > 0
        ? 'commits, local changes, chats, and eligible pipeline history'
        : 'Git state, chats, and eligible pipeline history';
    return {
      retentionSummary,
      retentionDetail: mixedWindows
        ? `Deleting removes each worktree from disk and its chat from the ` +
          `sidebar. When a restorable archive can be created, its ${kept} ` +
          `are kept for its project's retention window. Otherwise, deletion ` +
          `is permanent.`
        : localWorkCount > 0
          ? labels.localWorkRetentionDetail
          : labels.retentionDetail,
      warning,
    };
  };

  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  const reportedRef = useRef(false);
  useEffect(() => {
    if (dialog === null) {
      if (reportedRef.current) onStateChangeRef.current?.(null);
      reportedRef.current = false;
      return;
    }
    reportedRef.current = true;
    onStateChangeRef.current?.({
      open: true,
      mode: dialog.mode,
      count: dialog.included.length,
      phase: dialog.phase,
    });
  }, [dialog]);

  // A click anywhere but the selection's rows, menus, and dialogs ends it, the
  // way a plain row click does. Captured, so a surface that stops the click
  // (a chat tab, an editor) still counts.
  const clearSelection = selection.clear;
  const listensOutside = enabled && selection.active && dialog === null;
  useEffect(() => {
    if (!listensOutside || typeof document === 'undefined') return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      const target = event.target;
      if (
        target instanceof Element &&
        (target.closest(WORKTREE_SELECTION_KEEPER_SELECTOR) !== null ||
          pressesInertSelectionRow(target, event.clientX, event.clientY))
      ) {
        return;
      }
      clearSelection();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return (): void => {
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [listensOutside, clearSelection]);

  // An unconfirmed batch can't run once the host withdraws its removal, so
  // it is dropped rather than shown again, stale, when the host returns.
  useEffect(() => {
    if (!enabled) {
      setDialog((current) => (current?.phase === 'confirm' ? null : current));
    }
  }, [enabled]);

  const dialogNode =
    dialog !== null ? (
      <Suspense fallback={null}>
        <WorktreeBatchRemovalDialog
          mode={dialog.mode}
          phase={dialog.phase}
          rows={dialogRowsFor(dialog)}
          excluded={dialog.excluded}
          {...copyFor(dialog)}
          branchChoice={branchChoice}
          stopRequested={batch.stopRequested}
          testId={input.dialogTestId}
          onCancel={(): void => {
            setDialog(null);
            batch.reset();
          }}
          onConfirm={confirm}
          onStop={batch.stop}
          onDone={(): void => closeDialog(dialog.remainingKeys)}
        />
      </Suspense>
    ) : null;

  if (!enabled) {
    return {
      bindingFor: () => undefined,
      menuFor: (): WorktreeBulkRowMenu => ({ context: {}, callbacks: {} }),
      // A batch already under way keeps its progress and results visible;
      // the runner starts nothing further without the host's removal.
      dialog: dialog?.phase === 'confirm' ? null : dialogNode,
    };
  }

  return {
    bindingFor: (listId): WorktreeMultiSelectBinding => ({
      selection,
      isSelectable,
      onRowsChange: reporterFor(listId),
      escapeClears: !batch.running,
    }),
    menuFor: (workspace, worktree): WorktreeBulkRowMenu => {
      if (!isSelectable(workspace, worktree)) {
        return { context: {}, callbacks: {} };
      }
      const key = worktreeRowKey(workspace.localId, worktree.localId);
      const multiSelected = selection.isSelected(key);
      return {
        context: {
          multiSelected,
          ...(multiSelected && selection.count >= 2
            ? { bulkSelection: { count: selection.count, availability } }
            : {}),
        },
        callbacks: {
          onToggleSelectionRequested: (): void =>
            selection.toggle(workspace.localId, key),
          onBulkRemovalRequested: openBatch,
          onClearSelectionRequested: selection.clear,
        },
      };
    },
    dialog: dialogNode,
  };
}

/** Builds the per-workspace rows the sections report to the selection. */
export function worktreeSelectionRowsFor(
  workspace: WorktreeSelectableWorkspace,
  worktrees: readonly SnapshotWorktree[],
  isSelectable: WorktreeMultiSelectBinding['isSelectable'],
): WorktreeSelectionRow[] {
  return worktrees.map((worktree) => ({
    key: worktreeRowKey(workspace.localId, worktree.localId),
    selectable: isSelectable(workspace, worktree),
  }));
}
