import type {
  SidebarBatchUnitLabel,
  SpaceNotificationMenuChoice,
  SpaceNotificationMenuLevel,
  SpaceNotificationMenuState,
  WorktreeMenuItem,
} from '@canopy/ui-shared/components';
import { spaceNotificationMenuUnavailable } from '@canopy/ui-shared/components';
import {
  ArchiveIcon,
  PinIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons/AppIcons';

/**
 * The bulk selection's menu items (CAN-3975), shared by every selectable row
 * kind: the selection's own menu once two or more rows are selected, Pin N
 * then Archive N and Delete N. Rows join a selection by modifier clicks and
 * keys, not a menu item.
 */

/** One selected row's removal inputs, as the single-row menu reads them. */
export interface SidebarBatchAvailabilityRow {
  /** The row's own removal capability. */
  readonly removal: false | 'archive' | 'delete' | undefined;
  /** The row's own retention capability. */
  readonly retention?: 'archive-or-delete';
  /** The row's workspace cannot accept commands right now. */
  readonly commandsDisabled?: boolean;
}

export interface SidebarBatchActionState {
  readonly enabled: boolean;
  /**
   * `false` when no selected row's own menu offers the action: the
   * selection's menu leaves it out rather than showing it disabled.
   */
  readonly offered?: boolean;
  /** Why the action is disabled, for the control's `title`. */
  readonly disabledReason?: string;
  /** How many selected rows the action applies to, for its label. */
  readonly count?: number;
}

export interface SidebarBatchActionAvailability {
  readonly archive: SidebarBatchActionState;
  readonly delete: SidebarBatchActionState;
}

export interface SidebarSelectionMenuTestIds {
  readonly bulkPin?: string;
  readonly bulkArchive?: string;
  readonly bulkDelete?: string;
}

/** The removal items a row's own menu offers, ignoring transient blocks. */
function rowRemovalActions(
  row: SidebarBatchAvailabilityRow,
): ReadonlySet<'archive' | 'delete'> {
  if (row.commandsDisabled === true) return new Set();
  if (row.removal === undefined || row.removal === false) return new Set();
  if (row.retention === 'archive-or-delete') {
    return new Set(['archive', 'delete']);
  }
  return new Set([row.removal]);
}

/**
 * Bulk Archive and Delete enablement. An action is enabled only when every
 * selected row's own menu offers it, so bulk never offers what the single
 * row wouldn't. A row that is only blocked right now (an active session, a
 * Split PR, setup) still counts: the confirm lists it under Not included.
 */
export function batchActionAvailability(
  rows: readonly SidebarBatchAvailabilityRow[],
  unitLabel: SidebarBatchUnitLabel,
): SidebarBatchActionAvailability {
  if (rows.length === 0) {
    return { archive: { enabled: false }, delete: { enabled: false } };
  }
  const offered = rows.map(rowRemovalActions);
  const countFor = (action: 'archive' | 'delete'): number =>
    offered.filter((actions) => actions.has(action)).length;
  if (rows.some((row) => row.commandsDisabled === true)) {
    const disabledReason = `Some selected ${unitLabel.plural} can't be changed right now`;
    return {
      archive: { enabled: false, disabledReason, count: countFor('archive') },
      delete: { enabled: false, disabledReason, count: countFor('delete') },
    };
  }
  const stateFor = (action: 'archive' | 'delete'): SidebarBatchActionState =>
    offered.every((actions) => actions.has(action))
      ? { enabled: true, count: rows.length }
      : {
          enabled: false,
          count: countFor(action),
          ...(offered.some((actions) => actions.has(action))
            ? {}
            : { offered: false }),
          disabledReason:
            action === 'archive'
              ? `Some selected ${unitLabel.plural} can't be archived`
              : `Some selected ${unitLabel.plural} can't be deleted`,
        };
  return { archive: stateFor('archive'), delete: stateFor('delete') };
}

/**
 * One selected row's state, as its own menu offers it. A field is present
 * only when that row's menu shows the action, so bulk never offers what the
 * single row wouldn't.
 */
export interface SidebarBulkRowState {
  /** Pin to top / Unpin is in the row's menu; whether the row is pinned. */
  readonly pinned?: boolean;
  /** Mark done / Mark active is in the row's menu; whether the row is done. */
  readonly done?: boolean;
  /** Hide is in the row's menu. */
  readonly hideable?: boolean;
  /** The row's notification choices, when its menu shows them. */
  readonly notifications?: SpaceNotificationMenuState;
}

/** One state action, run on each selected row that needs it. */
export type SidebarBulkStateAction =
  | { readonly kind: 'pin'; readonly pinned: boolean }
  | { readonly kind: 'done'; readonly done: boolean }
  | { readonly kind: 'hide' }
  | {
      readonly kind: 'notifications';
      readonly choice: SpaceNotificationMenuChoice;
    };

export interface SidebarBulkNotificationState {
  /** The level every row shares, or `mixed`. Never claimed for an unknown choice. */
  readonly level: SpaceNotificationMenuLevel | 'mixed';
  /** Some row's saved choice is still being read. */
  readonly loading: boolean;
  /** Why the choices can't change right now: a row is read-only or saving. */
  readonly disabledReason?: string;
}

/** The selection's state actions; an absent field is not offered. */
export interface SidebarBulkStateActions {
  /**
   * The state Pin/Unpin sets: pinned while any row is unpinned. `count` is
   * how many selected rows it changes.
   */
  readonly pin?: { readonly pinned: boolean; readonly count: number };
  /** The state Mark sets: done while any row is active. */
  readonly done?: { readonly done: boolean };
  readonly hide?: boolean;
  readonly notifications?: SidebarBulkNotificationState;
}

const NOTIFICATION_SAVING_REASON = 'A change is still saving';

function notificationLevel(
  state: SpaceNotificationMenuState,
): SpaceNotificationMenuLevel {
  // No override gets every notification, the same as All activity.
  return state.override ?? 'all';
}

function notificationKnown(state: SpaceNotificationMenuState): boolean {
  return state.selectionKnown ?? state.status !== 'loading';
}

function bulkNotificationState(
  states: readonly SpaceNotificationMenuState[],
): SidebarBulkNotificationState | undefined {
  // A row whose choice can never load has no group of its own, so the
  // selection has none either.
  if (states.some(spaceNotificationMenuUnavailable)) return undefined;
  const unknown = states.some((state) => !notificationKnown(state));
  // Only a read in flight is loading. A row read with no choice to show (a
  // space the server doesn't know) gives its own reason, as its row does.
  const loading = states.some(
    (state) => !notificationKnown(state) && state.status === 'loading',
  );
  const disabledReason =
    states.find(
      (state) =>
        state.disabledReason !== undefined &&
        (notificationKnown(state) || state.status !== 'loading'),
    )?.disabledReason ??
    (states.some((state) => state.status === 'saving')
      ? NOTIFICATION_SAVING_REASON
      : undefined);
  const levels = new Set(states.map(notificationLevel));
  const [only] = levels;
  return {
    level: unknown || levels.size !== 1 || only === undefined ? 'mixed' : only,
    loading,
    ...(disabledReason === undefined ? {} : { disabledReason }),
  };
}

/** Pin while any row is unpinned, counting those; else Unpin them all. */
function bulkPinAction(rows: readonly SidebarBulkRowState[]): {
  readonly pinned: boolean;
  readonly count: number;
} {
  const unpinned = rows.filter((row) => row.pinned !== true).length;
  return unpinned > 0
    ? { pinned: true, count: unpinned }
    : { pinned: false, count: rows.length };
}

/** The state actions every selected row's own menu offers. */
export function bulkStateActions(
  rows: readonly SidebarBulkRowState[],
): SidebarBulkStateActions {
  if (rows.length === 0) return {};
  const offersPin = rows.every((row) => row.pinned !== undefined);
  const offersDone = rows.every((row) => row.done !== undefined);
  const notificationStates = rows.flatMap((row) =>
    row.notifications === undefined ? [] : [row.notifications],
  );
  const notifications =
    notificationStates.length === rows.length
      ? bulkNotificationState(notificationStates)
      : undefined;
  return {
    ...(offersPin ? { pin: bulkPinAction(rows) } : {}),
    ...(offersDone
      ? { done: { done: !rows.every((row) => row.done === true) } }
      : {}),
    ...(rows.every((row) => row.hideable === true) ? { hide: true } : {}),
    ...(notifications === undefined ? {} : { notifications }),
  };
}

/** Whether one row changes under an action; rows already there are skipped. */
export function rowNeedsStateAction(
  state: SidebarBulkRowState,
  action: SidebarBulkStateAction,
): boolean {
  switch (action.kind) {
    case 'pin':
      return state.pinned !== undefined && state.pinned !== action.pinned;
    case 'done':
      return state.done !== undefined && state.done !== action.done;
    case 'hide':
      return state.hideable === true;
    case 'notifications':
      return (
        state.notifications !== undefined &&
        notificationLevel(state.notifications) !== (action.choice ?? 'all')
      );
  }
}

/** Selection items that open a group whenever an item precedes them. */
const SEPARATED_KEYS: ReadonlySet<string> = new Set([
  'bulk-hide',
  'bulk-archive',
  'bulk-delete',
  'clear-selection',
]);

/**
 * Puts the selection's group items after its Pin row, or first, where a
 * row's own menu puts its group items.
 */
export function withSelectionGroupItems(
  items: readonly WorktreeMenuItem[],
  groupItems: readonly WorktreeMenuItem[],
): WorktreeMenuItem[] {
  if (groupItems.length === 0) return [...items];
  const pinIndex = items.findIndex((item) => item.key === 'bulk-pin');
  const [next, ...rest] = items.slice(pinIndex + 1);
  // With no Pin row, the item that led the menu now follows the group items:
  // Hide, Archive/Delete and Clear selection start their own group there.
  const nextItem =
    pinIndex < 0 && next !== undefined && SEPARATED_KEYS.has(next.key)
      ? { ...next, separatorBefore: true }
      : next;
  return [
    ...items.slice(0, pinIndex + 1),
    ...groupItems,
    ...(nextItem === undefined ? [] : [nextItem]),
    ...rest,
  ];
}

/**
 * A selection's menu, from any selected row's right-click: Pin N (or Unpin N
 * once every row is pinned), then Archive N and Delete N. Each label counts
 * the selected rows the action changes, and an action is present only when
 * a selected row's own menu offers it.
 */
export function deriveSelectionMenuItems(input: {
  readonly availability: SidebarBatchActionAvailability;
  readonly onBulkRemoval: (mode: 'archive' | 'delete') => void;
  /** Offered only together with `onStateAction`. */
  readonly stateActions?: SidebarBulkStateActions;
  readonly onStateAction?: (action: SidebarBulkStateAction) => void;
  readonly testIds?: SidebarSelectionMenuTestIds;
}): WorktreeMenuItem[] {
  const { availability, onBulkRemoval, onStateAction, testIds } = input;
  const items: WorktreeMenuItem[] = [];
  const pin = onStateAction === undefined ? undefined : input.stateActions?.pin;
  if (pin !== undefined) {
    const pinned = pin.pinned;
    items.push({
      key: 'bulk-pin',
      label: `${pinned ? 'Pin' : 'Unpin'} ${pin.count}`,
      icon: <PinIcon />,
      onSelect: () => onStateAction?.({ kind: 'pin', pinned }),
      testId: testIds?.bulkPin,
    });
  }
  // Archive and Delete start their own group.
  const removalSeparator = items.length > 0;
  const archiveOffered = availability.archive.offered !== false;
  if (archiveOffered) {
    items.push({
      key: 'bulk-archive',
      label: `Archive ${availability.archive.count ?? 0}`,
      icon: <ArchiveIcon />,
      onSelect: () => onBulkRemoval('archive'),
      disabled: !availability.archive.enabled,
      tooltip: availability.archive.disabledReason,
      ...(removalSeparator ? { separatorBefore: true } : {}),
      testId: testIds?.bulkArchive,
    });
  }
  if (availability.delete.offered !== false) {
    items.push({
      key: 'bulk-delete',
      label: `Delete ${availability.delete.count ?? 0}`,
      icon: <TrashIcon />,
      onSelect: () => onBulkRemoval('delete'),
      disabled: !availability.delete.enabled,
      tooltip: availability.delete.disabledReason,
      tone: 'default',
      ...(removalSeparator && !archiveOffered ? { separatorBefore: true } : {}),
      testId: testIds?.bulkDelete,
    });
  }
  return items;
}
