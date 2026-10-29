/**
 * Auxiliary panel-window store — Phase 8 of the VS Code-style panel system
 * (doc 05 §8, Approach A: opener-controlled `about:blank` child documents).
 *
 * Tracks every pulled-out panel window and owns the LAYOUT side of the
 * pull-out/merge-back lifecycle. An aux window is "just another layout key"
 * in `panelLayoutStore` (`${worktreeKey}#aux:${auxWindowId}`), so the aux
 * grid supports further split/stack with zero extra engine code.
 *
 * Ownership split with `AuxPanelWindow` (the React host component):
 *
 * - **This store** opens the OS child window (`window.open` FIRST, so a
 *   denied open never mutates layouts), moves the group's tabs between
 *   layouts (`extractGroupToLayout` / `adoptLayoutTabs`), and owns the
 *   record's lifecycle.
 * - **`AuxPanelWindow`** owns the DOM/window side per record: window
 *   registry registration, stylesheet/attribute mirroring, the main-realm
 *   portal container, close detection, and — on unmount — closing the child
 *   window and disposing every registration.
 *
 * Pull-out guards: every tab in the group must be poppable per the desktop
 * panel registry (`canPopOut`; `browser` is window-bound native content and
 * rejects), and the group must not be the main layout's last group.
 *
 * Phase 9 adds `restorePoppedWindow`: the parent-orchestrated relaunch path
 * (doc 05 §7.5 / doc 10 D4) that re-creates an aux window from a persisted
 * `poppedOut` entry — and, when the OS window cannot be re-opened, merges
 * the persisted tabs back into the worktree layout instead of losing them.
 */
import { create } from 'zustand';
import {
  isPanelKind,
  makePanelAuxWindowFrameName,
  PANEL_LAYOUT_FILE_VERSION,
  type ISerializedPanelEntry,
  type ISerializedPanelNode,
  type SerializablePanelLayoutFile,
  type SerializedPoppedPanelWindow,
  type SerializedPoppedPanelWindowBounds,
  type SerializedPanelReturnTarget,
} from '@canopy/protocol';
import {
  collapseEdgeAxis,
  Direction,
  type PanelSplitDirection,
} from '@canopy/ui-shared/panels';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import { canPanelKindPopOut } from '@/lib/panels/panel-capabilities';
import { schedulePanelGroupFocus } from '@/lib/panels/panel-focus';
import {
  makeAuxPanelLayoutKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';

/** Initial OS-window size requested through the `window.open` features
 * string when there are no persisted bounds (fresh pop-out). */
const AUX_WINDOW_DEFAULT_WIDTH = 900;
const AUX_WINDOW_DEFAULT_HEIGHT = 600;

export type PanelAuxWindowStatus = 'open' | 'merging';

/** One live pulled-out panel window. */
export interface PanelAuxWindowRecord {
  readonly auxWindowId: string;
  /** The worktree layout the group was pulled out of (merge-back target). */
  readonly worktreeKey: string;
  /** The aux layout key rendered inside the child window. */
  readonly layoutKey: string;
  /** Original main-grid group used as the preferred merge-back target. */
  readonly sourceGroupId: string;
  /** Best-effort location for recreating a source group removed by pop-out. */
  readonly returnTarget?: SerializedPanelReturnTarget;
  /** The `window.open` handle; all aux DOM lives in its document. */
  readonly childWindow: Window;
  readonly status: PanelAuxWindowStatus;
  /**
   * Whether the child window should receive OS + DOM focus once its grid
   * renders. `true` for a user-initiated pop-out; `false` for a relaunch
   * restore, which must not steal focus from the main window at startup.
   */
  readonly focusOnOpen: boolean;
}

/** Outcome of {@link PanelWindowsState.restorePoppedWindow}. */
export type PanelAuxWindowRestoreOutcome = 'opened' | 'merged-back' | 'skipped';

export interface PanelWindowsState {
  auxWindows: Record<string, PanelAuxWindowRecord>;

  /**
   * Pulls `groupId` out of `worktreeKey`'s layout into a new OS window.
   * Returns the new aux window id, or `null` when rejected (unknown
   * layout/group, a window-bound tab in the group, last remaining group, or
   * the child window failed to open).
   */
  popOutGroup(worktreeKey: string, groupId: string): string | null;
  /** Pulls only one tab into a new window, leaving its source group in place. */
  popOutPanel(
    worktreeKey: string,
    groupId: string,
    panelId: string,
  ): string | null;
  /**
   * Phase 9 relaunch restore (parent-orchestrated, doc 05 §7.5): re-creates
   * one aux window from a persisted `poppedOut` entry after the owning
   * worktree layout has been restored. Rebuilds the aux layout from the
   * persisted grid under the entry's stable window id, opens the OS child
   * window at the persisted bounds, and registers the record (which mounts
   * `AuxPanelWindow`). Returns:
   *
   * - `'opened'` — the window and layout were re-created;
   * - `'merged-back'` — the window could not be opened (denied/blocked) or a
   *   persisted tab is not poppable, so the entry's tabs were merged into
   *   the worktree layout instead (the data-loss guard: persisted popped-out
   *   tabs must never vanish);
   * - `'skipped'` — no mutation (unknown worktree layout, duplicate window
   *   id/layout key, or a corrupt persisted grid).
   */
  restorePoppedWindow(
    worktreeKey: string,
    entry: SerializedPoppedPanelWindow,
  ): PanelAuxWindowRestoreOutcome;
  /**
   * Merges an aux window's tabs back into its original group when possible,
   * recreating that group from the placement hint when needed, then disposes
   * the aux layout and drops the record — which unmounts `AuxPanelWindow`,
   * closes the OS window, and disposes its registrations.
   */
  mergeBack(auxWindowId: string): void;
  /**
   * Close-detection entry point (`pagehide` + closed-poll in
   * `AuxPanelWindow`): the OS window was closed directly, so run merge-back
   * semantics for the orphaned tabs. Safe to call repeatedly.
   */
  handleChildWindowClosed(auxWindowId: string): void;
  /**
   * Disposes every auxiliary window owned by a worktree without merging its
   * tabs back. Used when the worktree itself has been archived/deleted.
   */
  disposeWorktreeAuxWindows(worktreeKey: string): void;
  /**
   * Brings the already-open auxiliary OS window rendering `layoutKey` to the
   * front (the same `childWindow.focus()` a fresh pop-out uses in
   * `AuxPanelWindow`). Returns `false` without side effects when no open
   * window renders that layout, the window is closing or merging back, or
   * the cross-window call throws mid-teardown. Never opens a window.
   */
  focusAuxWindowForLayout(layoutKey: string): boolean;
}

/**
 * Human-readable SOURCE label for an aux window's top bar: which
 * worktree/branch context the pulled-out panels belong to. Resolved from the
 * sidebar items (`projectsStore.projects`) by the record's `worktreeKey`
 * (`${projectId}/${worktreeId}`, the `makeWorktreePanelKey` convention —
 * ids match `/^[a-z0-9][a-z0-9-]*$/`, so the first `/` is unambiguous).
 *
 * Best-available label: the worktree's user-set display label, falling back
 * to its branch name, prefixed with the project/workspace name when known.
 * Unknown keys degrade to the raw ids so the bar is never empty.
 */
export function getAuxWindowSourceLabel(
  worktreeKey: string,
  projects: readonly SidebarItem[],
): string {
  const separatorIndex = worktreeKey.indexOf('/');
  if (separatorIndex <= 0) {
    return worktreeKey;
  }
  const projectId = worktreeKey.slice(0, separatorIndex);
  const worktreeId = worktreeKey.slice(separatorIndex + 1);

  const project = projects.find((item) => item.id === projectId);
  const worktree =
    project && project.type !== 'cowork'
      ? project.worktrees.find((entry) => entry.id === worktreeId)
      : undefined;

  const worktreeLabel = worktree?.label?.trim();
  const worktreeName =
    worktreeLabel !== undefined && worktreeLabel.length > 0
      ? worktreeLabel
      : (worktree?.branchName ?? worktreeId);

  return project ? `${project.name} · ${worktreeName}` : worktreeName;
}

function generateAuxWindowId(): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `aux-${uuid}`;
}

/** Captures a neighboring group so a removed group can be put back nearby. */
function captureGroupReturnTarget(
  worktreeKey: string,
  groupId: string,
): SerializedPanelReturnTarget | undefined {
  const layout = usePanelLayoutStore.getState().layouts[worktreeKey];
  const view = layout?.leafViews.get(groupId);
  if (!layout || !view) {
    return undefined;
  }
  const candidates: readonly [Direction, PanelSplitDirection][] = [
    [Direction.Left, 'right'],
    [Direction.Right, 'left'],
    [Direction.Up, 'down'],
    [Direction.Down, 'up'],
  ];
  for (const [neighborDirection, returnDirection] of candidates) {
    try {
      const anchor = layout.grid
        .getNeighborViews(view, neighborDirection)
        .find((entry) => entry.id !== groupId);
      if (anchor !== undefined) {
        const viewSize = layout.grid.getViewSize(view);
        const splitAxis =
          returnDirection === 'left' || returnDirection === 'right'
            ? 'horizontal'
            : 'vertical';
        const collapsed = layout.groups[groupId]?.collapsed;
        const size =
          collapsed !== undefined &&
          collapseEdgeAxis(collapsed.edge) === splitAxis
            ? collapsed.expandedSize
            : splitAxis === 'horizontal'
              ? viewSize.width
              : viewSize.height;
        return {
          anchorGroupId: anchor.id,
          direction: returnDirection,
          ...(size > 0 ? { size } : {}),
        };
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Every persisted tab of a serialized grid tree, leaf DFS order. */
function collectSerializedPanelEntries(
  node: ISerializedPanelNode,
  out: ISerializedPanelEntry[] = [],
): ISerializedPanelEntry[] {
  if (node.type === 'leaf') {
    out.push(...node.panels);
    return out;
  }
  for (const child of node.children) {
    collectSerializedPanelEntries(child, out);
  }
  return out;
}

/** First leaf group id of a serialized grid tree (activeGroupId fallback). */
function firstSerializedGroupId(node: ISerializedPanelNode): string | null {
  if (node.type === 'leaf') {
    return node.groupId;
  }
  for (const child of node.children) {
    const groupId = firstSerializedGroupId(child);
    if (groupId !== null) {
      return groupId;
    }
  }
  return null;
}

/**
 * `window.open` features string for persisted bounds. Width/height fall back
 * to the pop-out defaults when the persisted values are unusable; left/top
 * pass through as-is (main's `hardenPanelAuxWindow` clamps the final bounds
 * to a visible display, so stale multi-monitor positions self-correct).
 */
function boundsToWindowFeatures(
  bounds: SerializedPoppedPanelWindowBounds,
): string {
  const width = bounds.width > 0 ? bounds.width : AUX_WINDOW_DEFAULT_WIDTH;
  const height = bounds.height > 0 ? bounds.height : AUX_WINDOW_DEFAULT_HEIGHT;
  return `left=${Math.round(bounds.x)},top=${Math.round(bounds.y)},width=${Math.round(width)},height=${Math.round(height)}`;
}

export const usePanelWindowsStore = create<PanelWindowsState>((set, get) => {
  const runMergeBack = (auxWindowId: string): void => {
    const record = get().auxWindows[auxWindowId];
    if (!record || record.status === 'merging') {
      return;
    }
    set((state) => ({
      auxWindows: {
        ...state.auxWindows,
        [auxWindowId]: { ...record, status: 'merging' },
      },
    }));

    const layoutStore = usePanelLayoutStore.getState();
    if (
      layoutStore.adoptLayoutTabs(record.layoutKey, record.worktreeKey, {
        preferredGroupId: record.sourceGroupId,
        fallbackAnchorGroupId: record.returnTarget?.anchorGroupId,
        fallbackDirection: record.returnTarget?.direction,
        fallbackSize: record.returnTarget?.size,
      })
    ) {
      // Focus sequencing (doc 12 §2): the adoption focused the receiving
      // group logically (store MRU/active); move the main window's DOM focus
      // there too, deferred one macrotask so React commits the adopted tab
      // first. `document` is the main window — merge-back always lands there.
      const mergedIntoGroupId =
        usePanelLayoutStore.getState().layouts[record.worktreeKey]
          ?.activeGroupId ?? null;
      if (mergedIntoGroupId !== null && typeof document !== 'undefined') {
        schedulePanelGroupFocus(document, mergedIntoGroupId);
      }
    } else {
      // The worktree layout is gone (e.g. the worktree was disposed while
      // popped out); the tabs have nowhere to land — drop the aux layout so
      // its grid/leaf views are not leaked.
      layoutStore.disposeLayout(record.layoutKey);
    }

    // Removing the record unmounts AuxPanelWindow, whose effect cleanup
    // closes the child window (no-op if the OS already closed it) and
    // disposes the registry/mirror registrations.
    set((state) => {
      const auxWindows = { ...state.auxWindows };
      delete auxWindows[auxWindowId];
      return { auxWindows };
    });
  };

  return {
    auxWindows: {},

    popOutGroup: (worktreeKey, groupId): string | null => {
      const layoutStore = usePanelLayoutStore.getState();
      const layout = layoutStore.layouts[worktreeKey];
      const group = layout?.groups[groupId];
      if (!layout || !group || group.tabs.length === 0) {
        return null;
      }
      // Registry gate: every tab kind must be poppable. Window-bound kinds
      // (`browser` hosts native WebContentsViews attached to the main OS
      // window) cannot move into a child document.
      const poppable = group.tabs.every(
        (tab) => isPanelKind(tab.kind) && canPanelKindPopOut(tab.kind),
      );
      if (!poppable) {
        return null;
      }
      // Never empty the main grid (the engine must always hold one view).
      if (layout.leafViews.size < 2) {
        return null;
      }

      const auxWindowId = generateAuxWindowId();
      const layoutKey = makeAuxPanelLayoutKey(worktreeKey, auxWindowId);
      const returnTarget = captureGroupReturnTarget(worktreeKey, groupId);

      // Open the OS window FIRST: main's setWindowOpenHandler allows only
      // this `about:blank` + frame-name-prefix shape, and a denied/failed
      // open must never mutate layouts.
      const childWindow = window.open(
        'about:blank',
        makePanelAuxWindowFrameName(auxWindowId),
        `width=${AUX_WINDOW_DEFAULT_WIDTH},height=${AUX_WINDOW_DEFAULT_HEIGHT}`,
      );
      if (!childWindow) {
        return null;
      }

      if (!layoutStore.extractGroupToLayout(worktreeKey, groupId, layoutKey)) {
        childWindow.close();
        return null;
      }

      set((state) => ({
        auxWindows: {
          ...state.auxWindows,
          [auxWindowId]: {
            auxWindowId,
            worktreeKey,
            layoutKey,
            sourceGroupId: groupId,
            ...(returnTarget !== undefined ? { returnTarget } : {}),
            childWindow,
            status: 'open',
            focusOnOpen: true,
          },
        },
      }));
      return auxWindowId;
    },

    popOutPanel: (worktreeKey, groupId, panelId): string | null => {
      const layoutStore = usePanelLayoutStore.getState();
      const tab = layoutStore.layouts[worktreeKey]?.groups[groupId]?.tabs.find(
        (entry) => entry.panelId === panelId,
      );
      if (!tab || !isPanelKind(tab.kind) || !canPanelKindPopOut(tab.kind)) {
        return null;
      }

      const auxWindowId = generateAuxWindowId();
      const layoutKey = makeAuxPanelLayoutKey(worktreeKey, auxWindowId);
      const childWindow = window.open(
        'about:blank',
        makePanelAuxWindowFrameName(auxWindowId),
        `width=${AUX_WINDOW_DEFAULT_WIDTH},height=${AUX_WINDOW_DEFAULT_HEIGHT}`,
      );
      if (!childWindow) {
        return null;
      }
      if (
        !layoutStore.extractPanelToLayout(
          worktreeKey,
          groupId,
          panelId,
          layoutKey,
        )
      ) {
        childWindow.close();
        return null;
      }
      set((state) => ({
        auxWindows: {
          ...state.auxWindows,
          [auxWindowId]: {
            auxWindowId,
            worktreeKey,
            layoutKey,
            sourceGroupId: groupId,
            childWindow,
            status: 'open',
            focusOnOpen: true,
          },
        },
      }));
      return auxWindowId;
    },

    restorePoppedWindow: (worktreeKey, entry): PanelAuxWindowRestoreOutcome => {
      const layoutStore = usePanelLayoutStore.getState();
      if (!layoutStore.layouts[worktreeKey]) {
        return 'skipped';
      }
      const auxWindowId = entry.windowId;
      const layoutKey = makeAuxPanelLayoutKey(worktreeKey, auxWindowId);
      if (
        get().auxWindows[auxWindowId] !== undefined ||
        layoutStore.layouts[layoutKey] !== undefined
      ) {
        return 'skipped';
      }

      // Registry gate, mirroring popOutGroup: every persisted tab kind must
      // still be poppable in THIS build (a file could carry a window-bound
      // kind after a registry change). Non-poppable entries skip the window
      // and take the merge-back path below.
      const poppable = collectSerializedPanelEntries(entry.grid.root).every(
        (panel) => isPanelKind(panel.kind) && canPanelKindPopOut(panel.kind),
      );

      // Open the OS window first (popOutGroup posture): a denied open must
      // never leave a half-created aux layout behind — the layout is built
      // next and immediately merged into the worktree layout instead.
      const childWindow = poppable
        ? window.open(
            'about:blank',
            makePanelAuxWindowFrameName(auxWindowId),
            boundsToWindowFeatures(entry.bounds),
          )
        : null;

      // Rebuild the aux layout from the persisted grid. Leaves carry the tab
      // metadata; the optional additive focus fields fall back to leaf order.
      const activeGroupId =
        entry.activeGroupId ?? firstSerializedGroupId(entry.grid.root);
      if (activeGroupId === null) {
        childWindow?.close();
        return 'skipped';
      }
      const file: SerializablePanelLayoutFile = {
        version: PANEL_LAYOUT_FILE_VERSION,
        grid: entry.grid,
        activeGroupId,
        mostRecentActiveGroupIds: entry.mostRecentActiveGroupIds ?? [],
      };
      if (!layoutStore.restoreLayout(layoutKey, file)) {
        childWindow?.close();
        return 'skipped';
      }

      if (!childWindow) {
        // Data-loss guard (doc 10 D4): the tabs cannot live in a window that
        // failed to open — return them to their source group (or its saved
        // placement), exactly like a merge-back, instead of dropping them.
        if (
          !layoutStore.adoptLayoutTabs(layoutKey, worktreeKey, {
            preferredGroupId: entry.sourceGroupId,
            fallbackAnchorGroupId: entry.returnTarget?.anchorGroupId,
            fallbackDirection: entry.returnTarget?.direction,
            fallbackSize: entry.returnTarget?.size,
          })
        ) {
          layoutStore.disposeLayout(layoutKey);
          return 'skipped';
        }
        return 'merged-back';
      }

      set((state) => ({
        auxWindows: {
          ...state.auxWindows,
          [auxWindowId]: {
            auxWindowId,
            worktreeKey,
            layoutKey,
            sourceGroupId: entry.sourceGroupId,
            ...(entry.returnTarget !== undefined
              ? { returnTarget: entry.returnTarget }
              : {}),
            childWindow,
            status: 'open',
            // Relaunch restore must not steal startup focus from main.
            focusOnOpen: false,
          },
        },
      }));
      return 'opened';
    },

    mergeBack: (auxWindowId): void => {
      runMergeBack(auxWindowId);
    },

    handleChildWindowClosed: (auxWindowId): void => {
      runMergeBack(auxWindowId);
    },

    focusAuxWindowForLayout: (layoutKey): boolean => {
      const record = Object.values(get().auxWindows).find(
        (candidate) => candidate.layoutKey === layoutKey,
      );
      if (record === undefined || record.status !== 'open') {
        return false;
      }
      try {
        if (record.childWindow.closed) {
          return false;
        }
        // Only effective for a SHOWN window; hidden E2E windows ignore it,
        // exactly like the pop-out focus in AuxPanelWindow.
        record.childWindow.focus();
        return true;
      } catch {
        // A closing window can throw on cross-window access; close detection
        // in AuxPanelWindow owns that path.
        return false;
      }
    },

    disposeWorktreeAuxWindows: (worktreeKey): void => {
      const records = Object.values(get().auxWindows).filter(
        (record) => record.worktreeKey === worktreeKey,
      );
      if (records.length === 0) {
        return;
      }

      const layoutStore = usePanelLayoutStore.getState();
      for (const record of records) {
        layoutStore.disposeLayout(record.layoutKey);
        try {
          if (!record.childWindow.closed) {
            record.childWindow.close();
          }
        } catch {
          // The window may be mid-teardown; removing the record below is
          // sufficient to stop tracking it.
        }
      }

      set((state) => {
        const auxWindows = { ...state.auxWindows };
        for (const record of records) {
          delete auxWindows[record.auxWindowId];
        }
        return { auxWindows };
      });
    },
  };
});
