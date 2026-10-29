/**
 * Default per-worktree panel layout: the Phase 3 cutover reproduction of the
 * fixed WorktreeManager arrangement —
 *
 *   horizontal [ vertical [ chat (~70%), terminal (~30%, collapsed) ] (~72%),
 *                activity-section (~28%, collapsed) ]
 *
 * i.e. chat in the center with the terminal docked below it and the activity
 * rail on the right. The activity rail's seeded collapse is marked `auto`
 * (CAN-2836), which is what lets it reopen itself once the worktree has
 * produced work worth showing; the terminal's is not. Built deterministically
 * in two steps because
 * `DefaultLayoutDescriptor` expresses one row/column only:
 *
 *   1. `initializeLayout` — horizontal [chat, activity-section]
 *   2. `splitGroup(chat, 'down', seed: terminal)` + resize + refocus chat
 *
 * Group/panel ids are stable (`group-chat`, …) so UI automation can address
 * the default groups without discovery.
 *
 * The chat group's seed is INSTANCE-BOUND: when the chat store has hydrated
 * the worktree's tabs, the group is seeded with the worktree's active chat
 * tab (its `chatTabToPanelSeed` binding + deterministic `panel-chat-<id>`
 * panel id). When the chat store has not hydrated yet, the chat group is
 * seeded EMPTY and the chat ⇄ panel sync bridge materializes the bound tabs
 * into it once the chat list loads (`pickTargetGroupId` falls back to
 * `DEFAULT_CHAT_GROUP_ID`). Instance-less chat seeds no longer exist — the
 * layout store's restore path rejects them (the legacy-layout fallback).
 *
 * Phase 5: per-worktree persistence (`panel-layout.json`, restored through
 * the persistence bridge's `ensureWorktreePanelLayout`) is now the primary
 * path — this builder is the fallback for worktrees with no valid persisted
 * layout. The legacy global `activityPanelWidthPercent`/`worktreePanelPercent`
 * preferences intentionally remain defaults-only inputs and are NOT migrated
 * into per-worktree files (Phase 5 scope decision).
 */
import { useChatStore } from '@/stores/chatStore';
import {
  getPanelLayoutViewModel,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import {
  chatTabToPanelSeed,
  type ChatTabPanelSeed,
} from './chat-panel-binding';

export {
  DEFAULT_CHAT_GROUP_ID,
  DEFAULT_TERMINAL_GROUP_ID,
  DEFAULT_ACTIVITY_GROUP_ID,
  DEFAULT_TERMINAL_PANEL_ID,
  DEFAULT_ACTIVITY_PANEL_ID,
} from './panel-group-ids';
import {
  DEFAULT_ACTIVITY_GROUP_ID,
  DEFAULT_ACTIVITY_PANEL_ID,
  DEFAULT_CHAT_GROUP_ID,
  DEFAULT_TERMINAL_GROUP_ID,
  DEFAULT_TERMINAL_PANEL_ID,
} from './panel-group-ids';

/**
 * Nominal container the default proportions are computed against. The grid
 * preserves proportions when `PanelGridHost`'s ResizeObserver relayouts to
 * the real host size, so only the ratios matter.
 */
const CONTAINER_WIDTH = 1200;
const CONTAINER_HEIGHT = 800;
/** Chat+terminal column width as a fraction of the whole grid. */
const CHAT_COLUMN_FRACTION = 0.72;
/** Terminal row height as a fraction of the grid height. */
const TERMINAL_ROW_FRACTION = 0.3;

/**
 * The worktree's active chat tab as a panel seed (instance-bound), or `null`
 * when the chat store has not hydrated this worktree yet. Shared by the
 * hardcoded default builder and the saved-default apply path.
 */
export function activeChatTabSeed(
  worktreeKey: string,
): ChatTabPanelSeed | null {
  const wc = useChatStore.getState().worktreeChats[worktreeKey];
  if (!wc) {
    return null;
  }
  const activeTab =
    wc.tabs.find((tab) => tab.id === wc.activeTabId) ?? wc.tabs[0];
  if (!activeTab) {
    return null;
  }
  return chatTabToPanelSeed(activeTab);
}

/**
 * Builds the default layout for a worktree key. No-op when a layout already
 * exists (state survives worktree switches; see `disposeLayout` for the
 * deletion path).
 */
export function ensureDefaultWorktreeLayout(worktreeKey: string): void {
  if (getPanelLayoutViewModel(worktreeKey) !== null) {
    return;
  }

  const store = usePanelLayoutStore.getState();
  const chatColumnWidth = Math.round(CONTAINER_WIDTH * CHAT_COLUMN_FRACTION);
  const chatSeed = activeChatTabSeed(worktreeKey);

  store.initializeLayout(worktreeKey, {
    orientation: 'horizontal',
    groups: [
      {
        ...(chatSeed ?? {}),
        groupId: DEFAULT_CHAT_GROUP_ID,
        size: chatColumnWidth,
      },
      {
        kind: 'activity-section',
        groupId: DEFAULT_ACTIVITY_GROUP_ID,
        panelId: DEFAULT_ACTIVITY_PANEL_ID,
        size: CONTAINER_WIDTH - chatColumnWidth,
      },
    ],
    containerSize: { width: CONTAINER_WIDTH, height: CONTAINER_HEIGHT },
  });

  // Nested step: terminal as a bottom split of the chat group. The split
  // lands 50/50, so resize the terminal row to its ~30% target afterwards.
  const terminalGroupId = store.splitGroup(
    worktreeKey,
    DEFAULT_CHAT_GROUP_ID,
    'down',
    {
      kind: 'terminal',
      groupId: DEFAULT_TERMINAL_GROUP_ID,
      panelId: DEFAULT_TERMINAL_PANEL_ID,
    },
  );
  if (terminalGroupId !== null) {
    store.resizeGroup(worktreeKey, terminalGroupId, {
      width: chatColumnWidth,
      height: Math.round(CONTAINER_HEIGHT * TERMINAL_ROW_FRACTION),
    });
    store.collapseGroup(worktreeKey, terminalGroupId);
  }

  // CAN-2836: the activity rail seeds COLLAPSED, exactly like the terminal
  // above — a new chat opens without a sidebar of empty sections, and the
  // rail stays in the layout so its collapsed bar reopens it. Collapsing
  // here (rather than seeding a narrower group) captures the ~28% width as
  // the group's `expandedSize`, so reopening restores the default rail.
  //
  // This is the FALLBACK builder only: it runs after a persisted layout
  // failed to restore and no saved default applied, and `ensureDefault…`
  // no-ops when a layout already exists. A user's saved layout, a saved
  // default, and a rail they opened themselves therefore all still win, and
  // new chat tabs in an existing worktree keep that worktree's rail state.
  //
  // `auto: true` records on the persisted collapse descriptor that this was
  // CANOPY'S default, not the user's, so the rail reopens itself once the
  // worktree produces work worth showing (a summary, changed files, a PR, a
  // plan, a pipeline run — see `WORK_ACTIVITY_SECTION_IDS`). The flag is
  // cleared by whichever expand spends it, so the reopen happens at most
  // once; a rail the USER collapses gets no flag and stays shut forever. The
  // terminal collapse above deliberately stays unflagged.
  store.collapseGroup(worktreeKey, DEFAULT_ACTIVITY_GROUP_ID, { auto: true });

  // splitGroup focuses the new terminal group; the default active group is
  // chat (matching where users start today).
  store.focusGroup(worktreeKey, DEFAULT_CHAT_GROUP_ID);
}
