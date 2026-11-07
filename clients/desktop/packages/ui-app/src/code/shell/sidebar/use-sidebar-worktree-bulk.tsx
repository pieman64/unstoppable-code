import { useMemo } from 'react';
import type { CanopyCapabilities } from '@canopy/app-core';
import { DEFAULT_ARCHIVE_RETENTION_DAYS } from '@canopy/protocol/archive-retention';
import {
  spaceNotificationMenuUnavailable,
  WORKTREE_BATCH_UNIT,
  worktreeCountLabel,
  type SpaceNotificationMenuChoice,
  type SpaceNotificationMenuState,
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
  type WorktreeBatchAvailabilityRow,
  type WorktreeMenuCallbacks,
  type WorktreeMenuContext,
} from '../worktree-menu-items';
import {
  getWorkEntryBatchCopy,
  WORK_ENTRY_BATCH_UNIT,
} from '../work-entry-removal-labels';
import { getWorktreeDeleteLabels } from '../worktree-removal-labels';
import type { SidebarBulkStateAction } from '../sidebar-selection-menu-items';
import type {
  GetWorktreeBatchRemovalFacts,
  RemoveWorktreeInBatch,
  SidebarBatchRemovalOptions,
  WorktreeBatchLocalWork,
  WorktreeBatchRemovalUiState,
  WorktreeBatchTarget,
} from './use-sidebar-batch-removal';
import type {
  SidebarBulkBinding,
  SidebarBulkTarget,
  SidebarRowMultiSelect,
} from './use-sidebar-bulk';
import {
  isWorktreeSelectable,
  type SidebarSelectionRow,
} from './sidebar-row-selection';

type SidebarWorkspace = SidebarSurfaceSnapshot['workspaces'][number];

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
export interface WorktreeMultiSelectBinding extends SidebarRowMultiSelect {
  readonly isSelectable: (
    workspace: WorktreeSelectableWorkspace,
    worktree: SnapshotWorktree,
  ) => boolean;
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
  /** Pins or unpins one row as its menu's Pin to top does; absent: rows offer no Pin. */
  readonly setWorktreePinned?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
    pinned: boolean,
  ) => void;
  /** Hides one row as its menu's Hide does; absent: rows offer no Hide. */
  readonly hideWorktree?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => void;
  /** The row's saved notification choice, read on render. */
  readonly getNotificationState?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => SpaceNotificationMenuState | undefined;
  readonly setNotificationChoice?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
    choice: SpaceNotificationMenuChoice,
  ) => void;
  /** Loads a row's saved choice; the single row does this when its menu opens. */
  readonly requestNotificationState?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => void;
}

/** A worktree or cloud chat session row in a batch, with its names. */
export interface WorktreeBulkTarget
  extends WorktreeBatchTarget, SidebarBulkTarget {}

/** One row's selection context and callbacks for its menu. */
export interface WorktreeBulkRowMenu {
  readonly context: Pick<
    WorktreeMenuContext,
    'multiSelected' | 'bulkSelection'
  >;
  readonly callbacks: Pick<
    WorktreeMenuCallbacks,
    | 'onBulkRemovalRequested'
    | 'onBulkStateActionRequested'
    | 'onSelectItemRequested'
  >;
}

export interface SidebarWorktreeBulk {
  readonly binding: SidebarBulkBinding<WorktreeBulkTarget>;
  readonly isSelectable: WorktreeMultiSelectBinding['isSelectable'];
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
 * The worktree rows' binding for the rail's bulk core (CAN-3975): worktree
 * rows, and cloud chat session rows, which select with chat wording. Hosts
 * supply one awaitable per-worktree removal; nothing here branches on host.
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

  // Rows by key, built on first use: nothing reads it until a row is
  // selected, so an idle rail builds none of it.
  const lookup = useMemo(() => {
    let byKey:
      | Map<string, { workspace: SidebarWorkspace; worktree: SnapshotWorktree }>
      | undefined;
    return (): ReadonlyMap<
      string,
      { workspace: SidebarWorkspace; worktree: SnapshotWorktree }
    > => {
      if (byKey !== undefined) return byKey;
      byKey = new Map();
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
    };
  }, [snapshot.workspaces, snapshot.worktrees]);

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

  const isSessionBatch = (targets: readonly WorktreeBulkTarget[]): boolean =>
    targets.length > 0 &&
    targets.every(
      (target) => lookup().get(target.key)?.workspace.type === 'cowork',
    );

  const binding: SidebarBulkBinding<WorktreeBulkTarget> = {
    kinds: ['worktree', 'session'],
    enabled,
    ...(enabled && remove !== undefined
      ? {
          remove: (
            target: WorktreeBulkTarget,
            options: SidebarBatchRemovalOptions,
          ): Promise<void> =>
            remove(target.workspaceLocalId, target.worktreeLocalId, options),
        }
      : {}),
    targetFor: (key) => {
      const entry = lookup().get(key);
      if (entry === undefined) return undefined;
      const { workspace, worktree } = entry;
      return {
        key,
        workspaceLocalId: workspace.localId,
        worktreeLocalId: worktree.localId,
        branchName: worktree.branch,
        projectName: workspace.name,
        label: sidebarRowLabel(workspace, worktree),
      };
    },
    blockedReasonFor: (key) => {
      const entry = lookup().get(key);
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
    },
    availabilityFor: (keys) => {
      const entries = keys.flatMap((key) => {
        const entry = lookup().get(key);
        return entry === undefined ? [] : [entry];
      });
      const rows = entries.map(
        ({ workspace, worktree }): WorktreeBatchAvailabilityRow => {
          const capabilities = capabilitiesOf(worktree.localId);
          return {
            removal: capabilities.worktreeRemoval,
            retention: capabilities.worktreeRetention,
            commandsDisabled:
              input.isWorkspaceCommandDisabled?.(workspace.localId) === true,
          };
        },
      );
      const sessions =
        entries.length > 0 &&
        entries.every(({ workspace }) => workspace.type === 'cowork');
      return batchActionAvailability(
        rows,
        sessions ? WORK_ENTRY_BATCH_UNIT : WORKTREE_BATCH_UNIT,
      );
    },
    unitLabelFor: (targets) =>
      isSessionBatch(targets) ? WORK_ENTRY_BATCH_UNIT : WORKTREE_BATCH_UNIT,
    copyFor: (mode, included) => {
      const windows = included.map(
        (target) =>
          input.worktreeRetentionDaysFor?.(target.workspaceLocalId) ??
          DEFAULT_ARCHIVE_RETENTION_DAYS,
      );
      if (isSessionBatch(included)) {
        return getWorkEntryBatchCopy(mode, windows);
      }
      const days = new Set(windows);
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
          getFacts?.(target.workspaceLocalId, target.worktreeLocalId)
            ?.localWork,
        ),
      ).length;
      const savedChanges = capabilities.some(
        (caps) => caps.worktreeRemovalCopy === 'saved-changes',
      );
      const remoteCheckout =
        getFacts === undefined &&
        included.some(
          (target) => lookup().get(target.key)?.worktree.backend !== 'cloud',
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
          ? 'commits, local changes, chats, and eligible workflow history'
          : 'Git state, chats, and eligible workflow history';
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
    },
    localWorkFor: (target) =>
      getFacts?.(target.workspaceLocalId, target.worktreeLocalId)?.localWork,
    rowStateFor: (key) => {
      const entry = lookup().get(key);
      if (entry === undefined) return undefined;
      const { workspace, worktree } = entry;
      // Pin and Hide are host commands: a workspace that can't take
      // commands offers neither, as on the single row.
      const commands =
        input.isWorkspaceCommandDisabled?.(workspace.localId) !== true;
      const notifications =
        input.setNotificationChoice === undefined
          ? undefined
          : input.getNotificationState?.(workspace.localId, worktree.localId);
      return {
        ...(commands && input.setWorktreePinned !== undefined
          ? { pinned: worktree.pinned === true }
          : {}),
        // Only where the host persists visibility for this row: a cloud
        // Cowork task refuses `hidden`, so a bulk Hide there would do nothing.
        ...(commands &&
        input.hideWorktree !== undefined &&
        capabilitiesOf(worktree.localId).worktreeMetadata === true &&
        worktree.hidden !== true
          ? { hideable: true }
          : {}),
        // Not gated on commands: the choice is the viewer's own server
        // setting, as on the single row.
        ...(notifications !== undefined &&
        !spaceNotificationMenuUnavailable(notifications)
          ? { notifications }
          : {}),
      };
    },
    applyStateAction: (target, action: SidebarBulkStateAction): void => {
      const { workspaceLocalId, worktreeLocalId } = target;
      switch (action.kind) {
        case 'pin':
          input.setWorktreePinned?.(
            workspaceLocalId,
            worktreeLocalId,
            action.pinned,
          );
          return;
        case 'hide':
          input.hideWorktree?.(workspaceLocalId, worktreeLocalId);
          return;
        case 'notifications':
          input.setNotificationChoice?.(
            workspaceLocalId,
            worktreeLocalId,
            action.choice,
          );
          return;
        case 'done':
          // Worktree rows have no Mark done.
          return;
      }
    },
    requestRowState: (key) => {
      const entry = lookup().get(key);
      if (entry === undefined) return;
      const { workspace, worktree } = entry;
      const state = input.getNotificationState?.(
        workspace.localId,
        worktree.localId,
      );
      // Only a choice not known yet: never read, or read with none to show (a
      // space the server doesn't know). The host's refresh skips a read
      // already in flight.
      if (state?.selectionKnown === false) {
        input.requestNotificationState?.(workspace.localId, worktree.localId);
      }
    },
    branchChoice,
    activeKey:
      navigation?.kind === 'worktree'
        ? worktreeRowKey(
            navigation.workspaceLocalId,
            navigation.worktreeLocalId,
          )
        : undefined,
    dialogTestId: input.dialogTestId,
    onStateChange,
  };

  return { binding, isSelectable };
}

/**
 * One worktree row's menu selection context and callbacks, in the shape
 * `deriveWorktreeMenuItems` reads; empty when the row can't be selected.
 */
export function worktreeBulkRowMenu(
  multiSelect: SidebarRowMultiSelect | undefined,
  key: string,
): WorktreeBulkRowMenu {
  const menu = multiSelect?.rowMenuFor(key);
  if (menu === undefined) return { context: {}, callbacks: {} };
  return {
    context: {
      multiSelected: menu.multiSelected,
      ...(menu.bulk !== undefined
        ? {
            bulkSelection: {
              count: menu.bulk.count,
              availability: menu.bulk.availability,
              unitLabel: menu.bulk.unitLabel,
              stateActions: menu.bulk.stateActions,
            },
          }
        : {}),
    },
    callbacks: {
      onSelectItemRequested: menu.onSelectItem,
      ...(menu.bulk !== undefined
        ? {
            onBulkRemovalRequested: menu.bulk.onBulkRemoval,
            onBulkStateActionRequested: menu.bulk.onStateAction,
          }
        : {}),
    },
  };
}

/** Builds the per-workspace rows the sections report to the selection. */
export function worktreeSelectionRowsFor(
  workspace: WorktreeSelectableWorkspace,
  worktrees: readonly SnapshotWorktree[],
  isSelectable: WorktreeMultiSelectBinding['isSelectable'],
  openWorktreeLocalId?: string,
): SidebarSelectionRow[] {
  return worktrees.map((worktree) => ({
    key: worktreeRowKey(workspace.localId, worktree.localId),
    kind: workspace.type === 'cowork' ? 'session' : 'worktree',
    selectable: isSelectable(workspace, worktree),
    open: worktree.localId === openWorktreeLocalId,
  }));
}
