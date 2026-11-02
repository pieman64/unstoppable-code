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
  isMacPlatform,
  isShortcutEvent,
  type ShortcutEventLike,
} from '../../find/shortcut-target';
import {
  getPanelLayoutViewModel,
  usePanelLayoutStore,
  type PanelLayoutState,
} from './panel-layout-store';
import { getPanelTabSelectionHandler } from './panel-tab-selection';

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
  | 'panel-even-sizes'
  | 'panel-select-next-tab'
  | 'panel-select-previous-tab';

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
 * One default keybinding, matched via {@link matchesPanelShortcutBinding}
 * (Cmd on macOS, Ctrl elsewhere, plus the listed extra modifiers). Alt is
 * only used with arrow keys — Option+<letter> composes special characters on
 * macOS. A command may have several bindings, for example a platform-scoped
 * chord plus an alternate.
 */
export interface PanelShortcutBinding {
  readonly id: PanelCommandId;
  /**
   * The `event.key` value to match. When {@link code} is set it is matched
   * instead, and `key` only documents the unshifted character.
   */
  readonly key: string;
  /**
   * The physical key (`event.code`) to match instead of `key`. Used for
   * Shift chords on punctuation, where `event.key` reports the shifted
   * character (⌘⇧] arrives as `key: '}'`).
   */
  readonly code?: string;
  readonly shift?: boolean;
  readonly alt?: boolean;
  /** Limits the binding to one platform. Absent means every platform. */
  readonly platform?: 'mac' | 'other';
  /**
   * The chord never edits text or moves a cursor, so hosts may match it while
   * an input, composer, or editor owns focus. Hosts still skip it inside
   * dialogs and open overlays.
   */
  readonly editableSafe?: boolean;
}

/** One tab in a panel layout: its group and its panel. */
export interface PanelTabLocation {
  readonly groupId: string;
  readonly panelId: string;
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

/**
 * The tab `offset` steps away from the active tab of the active group,
 * wrapping at the ends, in the group's tab order. The store keeps pinned
 * tabs as a leading partition of `tabs`, so this is the order the tab strip
 * draws. When the group's `activePanelId` is not one of its tabs, `next`
 * lands on the first tab and `previous` on the last. Null without an active
 * group or with fewer than two tabs.
 */
function cycleTabTarget(
  viewModel: PanelLayoutViewModel,
  offset: 1 | -1,
): PanelTabLocation | null {
  const activeGroup = viewModel.groups.find(
    (group) => group.groupId === viewModel.activeGroupId,
  );
  if (!activeGroup) {
    return null;
  }
  return cycleTabInGroup(activeGroup, activeGroup.activePanelId, offset);
}

/**
 * The tab `offset` steps away from `fromPanelId` in `group`'s strip order,
 * wrapping at the ends. A `fromPanelId` that is not one of the group's tabs
 * starts the cycle at the matching end. Null with fewer than two tabs.
 */
function cycleTabInGroup(
  group: PanelLayoutViewModel['groups'][number],
  fromPanelId: string | null,
  offset: 1 | -1,
): PanelTabLocation | null {
  if (group.tabs.length < 2) {
    return null;
  }
  const ids = group.tabs.map((tab) => tab.panelId);
  const index = fromPanelId === null ? -1 : ids.indexOf(fromPanelId);
  const targetIndex =
    index === -1
      ? offset === 1
        ? 0
        : ids.length - 1
      : (index + offset + ids.length) % ids.length;
  return { groupId: group.groupId, panelId: ids[targetIndex] };
}

function hasCyclableTabs(viewModel: PanelLayoutViewModel): boolean {
  return cycleTabTarget(viewModel, 1) !== null;
}

/**
 * Selects the tab `offset` steps away like a click on it would, through the
 * mounted surface's selection handler when there is one.
 */
function selectCycledTab(
  worktreeKey: string,
  viewModel: PanelLayoutViewModel,
  offset: 1 | -1,
): void {
  const target = cycleTabTarget(viewModel, offset);
  if (target !== null) {
    selectTabLikeClick(worktreeKey, target);
  }
}

function selectTabLikeClick(
  worktreeKey: string,
  target: PanelTabLocation,
): void {
  const select = getPanelTabSelectionHandler(worktreeKey);
  if (select) {
    select(target.groupId, target.panelId);
  } else {
    store().selectTab(worktreeKey, target.groupId, target.panelId);
  }
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
  {
    id: 'panel-select-next-tab',
    isAvailable: hasCyclableTabs,
    run: (worktreeKey: string, viewModel: PanelLayoutViewModel): void => {
      selectCycledTab(worktreeKey, viewModel, 1);
    },
  },
  {
    id: 'panel-select-previous-tab',
    isAvailable: hasCyclableTabs,
    run: (worktreeKey: string, viewModel: PanelLayoutViewModel): void => {
      selectCycledTab(worktreeKey, viewModel, -1);
    },
  },
];

/**
 * Default keybindings, matched by `useGlobalShortcuts` after its standard
 * guards (no palette/settings overlay, no editable/Slate/terminal target,
 * main page + worktree selected). `editableSafe` bindings skip only the
 * editable-target guard. Chosen to avoid every existing Canopy binding
 * (⌘K/⇧K, ⌘P, ⌘,, ⌘⇧G, ⌘L/⇧L, ⌘S, ⌘1–9, ⌘T, ⌘N, ⌘W) and the Electron menu
 * roles; VS Code-flavored where the VS Code default is a single chord this
 * dispatcher can express (⌘\ split).
 *
 * Tab cycling (CAN-4616) follows the browser and VS Code tab conventions of
 * each platform: ⌘⇧] / ⌘⇧[ on macOS, matched by physical key because Shift
 * turns `]` into `}`; Ctrl+Tab / Ctrl+Shift+Tab elsewhere, with
 * Ctrl+PageDown / Ctrl+PageUp as the alternate. ⌘⇧Tab is a macOS system
 * chord, and Ctrl+Shift+] / Ctrl+Shift+[ are not a tab convention on Windows
 * (Monaco folds with them there), so neither pair crosses platforms.
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
  {
    id: 'panel-select-next-tab',
    key: ']',
    code: 'BracketRight',
    shift: true,
    platform: 'mac',
    editableSafe: true,
  },
  {
    id: 'panel-select-previous-tab',
    key: '[',
    code: 'BracketLeft',
    shift: true,
    platform: 'mac',
    editableSafe: true,
  },
  {
    id: 'panel-select-next-tab',
    key: 'Tab',
    platform: 'other',
    editableSafe: true,
  },
  {
    id: 'panel-select-previous-tab',
    key: 'Tab',
    shift: true,
    platform: 'other',
    editableSafe: true,
  },
  {
    id: 'panel-select-next-tab',
    key: 'PageDown',
    platform: 'other',
    editableSafe: true,
  },
  {
    id: 'panel-select-previous-tab',
    key: 'PageUp',
    platform: 'other',
    editableSafe: true,
  },
];

/**
 * Whether a keydown matches one panel binding on the current platform: the
 * binding's platform scope, the physical key when it names a `code` (else
 * the `key`), exactly its Shift and Alt modifiers, and the platform's
 * primary modifier (Cmd on macOS, Ctrl elsewhere, never both).
 */
export function matchesPanelShortcutBinding(
  event: ShortcutEventLike,
  binding: PanelShortcutBinding,
): boolean {
  if (event.isComposing) {
    return false;
  }
  const isMac = isMacPlatform();
  if (
    binding.platform !== undefined &&
    binding.platform !== (isMac ? 'mac' : 'other')
  ) {
    return false;
  }
  if (binding.code === undefined) {
    return isShortcutEvent(event, binding.key, {
      shift: binding.shift,
      alt: binding.alt,
    });
  }
  return (
    event.code === binding.code &&
    event.altKey === (binding.alt === true) &&
    event.shiftKey === (binding.shift === true) &&
    (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
  );
}

/**
 * The editable-safe binding (CAN-4616 tab cycling) a keydown matches on the
 * current platform, if any. Hosts and the terminal use it to let these
 * chords through guards that keep other keys with a focused text field or
 * shell.
 */
export function findEditableSafePanelShortcut(
  event: ShortcutEventLike,
): PanelShortcutBinding | undefined {
  return PANEL_SHORTCUT_BINDINGS.find(
    (binding) =>
      binding.editableSafe === true &&
      matchesPanelShortcutBinding(event, binding),
  );
}

/**
 * Selects the tab next to or before `from` in its group, wrapping at the
 * ends, like a click on it. Unlike `panel-select-next-tab`, which cycles the
 * active group, this starts from a known tab: a keypress in a native browser
 * page reaches the host without the click into the page having made its
 * group active. Returns false (no-op) when the layout, group, or tab is
 * missing or the group has fewer than two tabs.
 */
export function selectAdjacentPanelTab(
  worktreeKey: string,
  from: PanelTabLocation,
  direction: 'next' | 'previous',
): boolean {
  const group = getPanelLayoutViewModel(worktreeKey)?.groups.find(
    (candidate) => candidate.groupId === from.groupId,
  );
  if (
    group === undefined ||
    !group.tabs.some((tab) => tab.panelId === from.panelId)
  ) {
    return false;
  }
  const target = cycleTabInGroup(
    group,
    from.panelId,
    direction === 'next' ? 1 : -1,
  );
  if (target === null) {
    return false;
  }
  selectTabLikeClick(worktreeKey, target);
  return true;
}

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
