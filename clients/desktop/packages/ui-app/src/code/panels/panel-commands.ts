/**
 * Panel-grid command layer (doc 12 §1) — the single definition of the
 * keyboard/palette-facing panel operations.
 *
 * Each {@link PanelCommand} pairs an availability predicate (evaluated
 * against a {@link PanelLayoutViewModel} snapshot) with a `run` implementation
 * that dispatches through the panel layout store — the one imperative op API.
 * Consumers:
 *
 * - the command palette (`buildPanelCommands` in `paletteCommands.ts`) lists
 *   available commands and executes them via {@link runPanelCommand};
 * - the global shortcut dispatcher (`useGlobalShortcuts`) matches
 *   {@link PANEL_SHORTCUT_BINDINGS} and executes via {@link runPanelCommand}.
 *
 * User-visible titles/subtitles/shortcut strings live with the other command
 * definitions in `lib/keyboardShortcuts.ts` (`COMMAND_DEFINITIONS`), keyed by
 * the same `CommandId` values, so the shortcuts settings page and palette
 * share one copy source.
 *
 * Every command operates on the ACTIVE group of the given worktree's layout.
 */

import type { PanelLayoutViewModel } from '@canopy/ui-shared/panels';
import {
  getPanelLayoutViewModel,
  usePanelLayoutStore,
  type PanelLayoutState,
} from './panel-layout-store';

/** The command ids owned by the shared panel command layer. */
export type PanelCommandId =
  | 'panel-split-right'
  | 'panel-split-down'
  | 'panel-focus-next-group'
  | 'panel-focus-previous-group'
  | 'panel-focus-group-left'
  | 'panel-focus-group-right'
  | 'panel-focus-group-up'
  | 'panel-focus-group-down'
  | 'panel-move-to-next-group'
  | 'panel-toggle-maximize'
  | 'panel-close-group'
  | 'panel-even-sizes';

export interface PanelCommand {
  readonly id: PanelCommandId;
  /**
   * Whether the command can meaningfully run against this layout snapshot.
   * The palette filters its listing with this; {@link runPanelCommand}
   * re-checks it against fresh state at dispatch time. `worktreeKey` is the
   * layout the snapshot belongs to, for checks that ask the store.
   */
  isAvailable(viewModel: PanelLayoutViewModel, worktreeKey: string): boolean;
  /**
   * Dispatches the operation through the panel layout store. `activeGroupId`
   * is the pre-narrowed active group of `viewModel`.
   */
  run(
    worktreeKey: string,
    viewModel: PanelLayoutViewModel,
    activeGroupId: string,
  ): void;
}

/**
 * One default keybinding, matched via `isShortcutEvent` (Cmd on macOS, Ctrl
 * elsewhere, plus the listed extra modifiers). Alt is only used with arrow
 * keys — Option+<letter> composes special characters on macOS.
 */
export interface PanelShortcutBinding {
  readonly id: PanelCommandId;
  readonly key: string;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

function store(): PanelLayoutState {
  return usePanelLayoutStore.getState();
}

function hasActiveGroup(viewModel: PanelLayoutViewModel): boolean {
  return viewModel.activeGroupId !== null && viewModel.groups.length > 0;
}

function hasMultipleGroups(viewModel: PanelLayoutViewModel): boolean {
  return hasActiveGroup(viewModel) && viewModel.groups.length > 1;
}

/**
 * The group `offset` steps away from the active group in the view-model's
 * stable (serialization) group order, wrapping at the ends.
 */
function cycleGroupId(
  viewModel: PanelLayoutViewModel,
  offset: 1 | -1,
): string | null {
  const ids = viewModel.groups.map((group) => group.groupId);
  if (ids.length < 2 || viewModel.activeGroupId === null) {
    return null;
  }
  const index = ids.indexOf(viewModel.activeGroupId);
  if (index === -1) {
    return null;
  }
  return ids[(index + offset + ids.length) % ids.length];
}

function activePanelIdOfActiveGroup(
  viewModel: PanelLayoutViewModel,
): string | null {
  const activeGroup = viewModel.groups.find(
    (group) => group.groupId === viewModel.activeGroupId,
  );
  return activeGroup?.activePanelId ?? null;
}

export const PANEL_COMMANDS: readonly PanelCommand[] = [
  {
    id: 'panel-split-right',
    isAvailable: hasActiveGroup,
    run: (
      worktreeKey: string,
      _viewModel: PanelLayoutViewModel,
      activeGroupId: string,
    ): void => {
      // Use the raw store split deliberately: command splits create an empty
      // group, unlike the chrome menu's move-active-tab split.
      store().splitGroup(worktreeKey, activeGroupId, 'right');
    },
  },
  {
    id: 'panel-split-down',
    isAvailable: hasActiveGroup,
    run: (
      worktreeKey: string,
      _viewModel: PanelLayoutViewModel,
      activeGroupId: string,
    ): void => {
      // Use the raw store split deliberately: command splits create an empty
      // group, unlike the chrome menu's move-active-tab split.
      store().splitGroup(worktreeKey, activeGroupId, 'down');
    },
  },
  {
    id: 'panel-focus-next-group',
    isAvailable: hasMultipleGroups,
    run: (worktreeKey: string, viewModel: PanelLayoutViewModel): void => {
      const target = cycleGroupId(viewModel, 1);
      if (target !== null) {
        store().focusGroup(worktreeKey, target);
      }
    },
  },
  {
    id: 'panel-focus-previous-group',
    isAvailable: hasMultipleGroups,
    run: (worktreeKey: string, viewModel: PanelLayoutViewModel): void => {
      const target = cycleGroupId(viewModel, -1);
      if (target !== null) {
        store().focusGroup(worktreeKey, target);
      }
    },
  },
  {
    id: 'panel-focus-group-left',
    isAvailable: hasMultipleGroups,
    run: (worktreeKey: string): void => {
      store().focusGroupInDirection(worktreeKey, 'left');
    },
  },
  {
    id: 'panel-focus-group-right',
    isAvailable: hasMultipleGroups,
    run: (worktreeKey: string): void => {
      store().focusGroupInDirection(worktreeKey, 'right');
    },
  },
  {
    id: 'panel-focus-group-up',
    isAvailable: hasMultipleGroups,
    run: (worktreeKey: string): void => {
      store().focusGroupInDirection(worktreeKey, 'up');
    },
  },
  {
    id: 'panel-focus-group-down',
    isAvailable: hasMultipleGroups,
    run: (worktreeKey: string): void => {
      store().focusGroupInDirection(worktreeKey, 'down');
    },
  },
  {
    id: 'panel-move-to-next-group',
    // Offered only when the store would accept the move (a chat kept in
    // the chat group cannot move to the next group).
    isAvailable: (
      viewModel: PanelLayoutViewModel,
      worktreeKey: string,
    ): boolean => {
      const panelId = activePanelIdOfActiveGroup(viewModel);
      const target = cycleGroupId(viewModel, 1);
      return (
        hasMultipleGroups(viewModel) &&
        panelId !== null &&
        target !== null &&
        store().canMovePanel(worktreeKey, panelId, target, 'center')
      );
    },
    run: (worktreeKey: string, viewModel: PanelLayoutViewModel): void => {
      const panelId = activePanelIdOfActiveGroup(viewModel);
      const target = cycleGroupId(viewModel, 1);
      if (panelId !== null && target !== null) {
        store().movePanel(worktreeKey, panelId, target, 'center');
      }
    },
  },
  {
    id: 'panel-toggle-maximize',
    // Restoring needs a maximized group; maximizing needs >= 2 groups. A
    // maximized layout always has >= 2 groups, so one predicate covers both.
    isAvailable: hasMultipleGroups,
    run: (
      worktreeKey: string,
      viewModel: PanelLayoutViewModel,
      activeGroupId: string,
    ): void => {
      store().maximizeGroup(
        worktreeKey,
        activeGroupId,
        viewModel.maximizedGroupId !== activeGroupId,
      );
    },
  },
  {
    id: 'panel-close-group',
    // The grid always keeps at least one group; closing the last is a no-op.
    isAvailable: hasMultipleGroups,
    run: (
      worktreeKey: string,
      _viewModel: PanelLayoutViewModel,
      activeGroupId: string,
    ): void => {
      store().closeGroup(worktreeKey, activeGroupId);
    },
  },
  {
    id: 'panel-even-sizes',
    isAvailable: hasMultipleGroups,
    run: (worktreeKey: string): void => {
      store().arrangeGroups(worktreeKey, 'even');
    },
  },
];

/**
 * Default keybindings, matched by `useGlobalShortcuts` after its standard
 * guards (no palette/settings overlay, no editable/Slate/terminal target,
 * main page + worktree selected). Chosen to avoid every existing Canopy
 * binding (⌘K/⇧K, ⌘P, ⌘,, ⌘⇧G, ⌘L/⇧L, ⌘S, ⌘1–9, ⌘T, ⌘N, ⌘W) and the
 * Electron menu roles; VS Code-flavored where the VS Code default is a
 * single chord this dispatcher can express (⌘\ split).
 */
export const PANEL_SHORTCUT_BINDINGS: readonly PanelShortcutBinding[] = [
  { id: 'panel-split-right', key: '\\' },
  { id: 'panel-split-down', key: 'd', shift: true },
  { id: 'panel-focus-next-group', key: ']' },
  { id: 'panel-focus-previous-group', key: '[' },
  { id: 'panel-focus-group-left', key: 'ArrowLeft', alt: true },
  { id: 'panel-focus-group-right', key: 'ArrowRight', alt: true },
  { id: 'panel-focus-group-up', key: 'ArrowUp', alt: true },
  { id: 'panel-focus-group-down', key: 'ArrowDown', alt: true },
  { id: 'panel-move-to-next-group', key: 'm', shift: true },
  { id: 'panel-toggle-maximize', key: 'f', shift: true },
  { id: 'panel-close-group', key: 'w', shift: true },
  { id: 'panel-even-sizes', key: 'e', shift: true },
];

/** Looks up one panel command by id. */
export function getPanelCommand(id: PanelCommandId): PanelCommand | undefined {
  return PANEL_COMMANDS.find((command) => command.id === id);
}

/**
 * Whether `id` is currently available for the given worktree layout,
 * evaluated against fresh store state.
 */
export function isPanelCommandAvailable(
  id: PanelCommandId,
  worktreeKey: string | null,
): boolean {
  if (worktreeKey === null) {
    return false;
  }
  const command = getPanelCommand(id);
  const viewModel = getPanelLayoutViewModel(worktreeKey);
  return (
    command !== undefined &&
    viewModel !== null &&
    command.isAvailable(viewModel, worktreeKey)
  );
}

/**
 * Runs one panel command against the worktree's ACTIVE group, re-validating
 * availability against fresh store state. Returns `false` (no-op) when the
 * layout is missing, has no active group, or the command is unavailable.
 */
export function runPanelCommand(
  id: PanelCommandId,
  worktreeKey: string,
): boolean {
  const command = getPanelCommand(id);
  const viewModel = getPanelLayoutViewModel(worktreeKey);
  if (!command || viewModel === null) {
    return false;
  }
  const activeGroupId = viewModel.activeGroupId;
  if (activeGroupId === null || !command.isAvailable(viewModel, worktreeKey)) {
    return false;
  }
  command.run(worktreeKey, viewModel, activeGroupId);
  return true;
}
