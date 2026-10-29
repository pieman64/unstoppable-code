/**
 * Chat ⇄ panel sync bridge — keeps the panel grid's per-entity chat/file
 * panels in lockstep with the chat store's tab list for the SELECTED
 * worktree, in both directions.
 *
 * Like the persistence bridge, this deliberately lives OUTSIDE the stores:
 * `panelLayoutStore` stays a pure grid model and `chatStore` stays
 * panel-agnostic; the bridge subscribes to both and reconciles.
 *
 * chatStore → panels (selected worktree only):
 * - a chat/file tab with no bound panel (`findPanelByInstanceKey`) is
 *   materialized via `addTab` into the most-recently-used group that already
 *   holds a chat-kind panel (else the active group);
 * - a panel whose bound chat/file tab vanished is closed (`closeTab`);
 * - title drift is pushed through `updateTabInstanceTitle`;
 * - a chat tab that joins while another chat tab stays active (created in
 *   the background, e.g. by an agent with `preserveActiveTab`) is added
 *   without taking its group's selection;
 * - a chat-side `activeTabId` change selects AND focuses the matching panel;
 *   the FIRST sweep for a worktree (hydration) instead re-activates the
 *   chat-active tab within its group only (`selectTab` with `focus: false`),
 *   so a restored layout's persisted active group is never clobbered.
 *
 * panels → chatStore:
 * - the active panel of the active group being chat/file-bound and differing
 *   from the chat store's `activeTabId` switches the chat store's active tab
 *   (the same `switchTab` action ChatTabBar's tab click dispatches);
 * - sync-aware File-panel close controls begin the backing File-tab close
 *   before removing the panel, so a close cannot race the binding snapshot;
 * - a chat/file-bound panel REMOVED from a worktree's layout family while
 *   its chatStore tab still exists closes the chat tab via the same
 *   `closeTab` action ChatTabBar's close button dispatches (all of that
 *   action's guards — dirty-file save-then-close, streaming-chat protection —
 *   apply; a declined close re-materializes the panel on the next
 *   reconcile).
 *
 * Reconciliation model: both subscriptions schedule ONE microtask sweep
 * (never reconcile synchronously inside a store commit — multi-commit store
 * operations like pull-out/merge-back would otherwise be observed mid-move),
 * and a module-level `syncing` flag guards both directions against
 * recursion: mutations the sweep itself dispatches re-enter the
 * subscriptions synchronously and are ignored, with post-sweep snapshots
 * taken from the settled state so nothing echoes.
 *
 * Instance-less legacy chat/file panels are NOT bound to a chat tab and are
 * left alone in both directions. (The default layout no longer seeds one —
 * its chat group is seeded with the active chat tab's binding, or empty —
 * so these only exist transiently in pre-rework in-memory layouts.)
 */
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import {
  getChatTabCloseBlocker,
  notifyDelegatesBlockClose,
  type ChatCloseBlocker,
} from '@/stores/chat/close-guard';
import { setPanelTabCloseGuard } from '@canopy/ui-app/panel-layout-store';
import type { PanelTabModel } from '@canopy/ui-shared/panels';
import {
  findPanelByInstanceKey,
  getAuxPanelLayoutOwnerKey,
  getPanelInstanceKey,
  restrictedChatGroupId,
  usePanelLayoutStore,
  type PanelInstanceLocation,
  type PanelTabDescriptor,
  type WorktreePanelLayout,
} from '@/stores/panelLayoutStore';
import {
  chatTabToPanelSeed,
  type ChatTabPanelSeed,
} from './chat-panel-binding';
import { DEFAULT_CHAT_GROUP_ID } from './default-layout';
import { getWorkspaceLayoutMode } from '@/stores/workspaceLayoutModeStore';
import {
  ensureMinimalDestination,
  removeMinimalDestinationProbe,
} from './minimal-layout';
import {
  createChatSiblingGroupToRight,
  pickContentTargetGroupId,
  pickReusableChatSiblingGroupId,
  rollbackCreatedChatSiblingGroup,
} from './sibling-panel-placement';
import { ensureWorktreePanelLayout } from './persistence-bridge';
import { findPanelLocation, revealPanel } from './panel-reveal';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import { refuseFullTabRow } from './tab-row-limit';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Loop guard: mutations dispatched by the sweep never re-schedule a sweep. */
let syncing = false;
let pendingSweep = false;
let installed = false;
let unsubscribeChat: (() => void) | null = null;
let unsubscribePanels: (() => void) | null = null;
/**
 * Mounted page-like overlay owners (see `reconcilesAsMountedOwner`),
 * ref-counted per worktree key. A shared-container recipient has its own
 * explicit panel owner and must reconcile without impersonating app
 * navigation. Ordinary grids are not tracked: they reconcile as the selected
 * worktree.
 */
const mountedOwnerRefCounts = new Map<string, number>();

/**
 * Whether a mounted grid owner reconciles even while it is not the selected
 * worktree. Only the shared-container recipient overlay does. An ordinary grid
 * is keyed by the selected worktree, so it is swept through the selection.
 * When the selection moves, its previous grid stays mounted until React
 * commits the switch, and the sweep that the selection change schedules runs
 * before that. Reconciling the outgoing grid there would materialize panels
 * and drive tab selection for a worktree the user just left, flipping its
 * panels and chat tabs.
 */
function reconcilesAsMountedOwner(projectId: string): boolean {
  return projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID;
}

/**
 * Per-worktree binding snapshot from the END of the last sweep:
 * `worktreeKey → (instanceKey → bound chat tab id)` across the layout
 * family. Panels present here but missing from the live layouts were closed
 * on the panel side and propagate to `chatStore.closeTab`.
 */
let lastFamilyBindings = new Map<string, Map<string, string>>();
/** Chat-side `activeTabId` per worktree at the end of the last sweep. */
const lastChatActiveTabId = new Map<string, string | null>();
/** Panel-side active bound tab id per worktree at the end of the last sweep. */
const lastPanelActiveTabId = new Map<string, string | null>();
/**
 * Chat tab ids whose panel was in a COLLAPSED group at the end of the last
 * sweep. Used to (1) feed `chatStore.setHiddenChatTabIds` for unread
 * eligibility and (2) detect reveal (collapsed → expanded) so the revealed,
 * still-active chat is marked read.
 */
let lastHiddenChatTabIds = new Set<string>();
/**
 * One-shot placement hints for freshly opened file tabs:
 * - `beside-chat`: place in a chat panel's sibling group to the right
 *   (files opened from a chat: mentions, show_files, diff summaries);
 * - `file-sibling`: place in the SAME group as an existing file tab's
 *   panel, immediately after it (files opened from within a file tab's
 *   embedded tree or breadcrumb).
 * Hints for tabs whose panel already exists are dropped without moving
 * anything (an already-open file only activates).
 */
type FilePanelPlacementHint =
  | { readonly kind: 'beside-chat'; readonly originChatTabId: string }
  | { readonly kind: 'file-sibling'; readonly originFileTabId: string };

const pendingFilePanelPlacements = new Map<string, FilePanelPlacementHint>();
/**
 * Chat tab ids whose panel was removed while their backing chat is still being
 * closed. `chatStore.closeTab` archives a chat with history over an async IPC
 * round-trip, so the old tab lingers in the chat list for a beat after its
 * panel is gone. Without this guard the reconcile sweep would re-materialize a
 * panel for that still-present, now-unbound chat until the archive resolves.
 * Each suppression is released when the chat leaves the store, becomes active
 * again, or a bounded timeout elapses after a failed async archive/cancel.
 */
const REPLACEMENT_CLOSE_SUPPRESSION_MS = 10_000;
const chatTabsAwaitingReplacementClose = new Map<
  string,
  ReturnType<typeof setTimeout>
>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Splits a `${projectId}/${worktreeId}` key (ids can't contain `/`). */
function splitWorktreeKey(worktreeKey: string): {
  projectId: string;
  worktreeId: string;
} {
  const separator = worktreeKey.indexOf('/');
  return {
    projectId: worktreeKey.slice(0, separator),
    worktreeId: worktreeKey.slice(separator + 1),
  };
}

/** The chatStore tab id a panel descriptor is bound to, or `null`. */
function boundChatTabId(
  tab: Pick<PanelTabDescriptor, 'kind' | 'instance'>,
): string | null {
  if (tab.kind === 'chat') {
    return tab.instance?.chatTabId ?? null;
  }
  if (tab.kind === 'file-diff') {
    return tab.instance?.fileTabId ?? null;
  }
  return null;
}

/** All live layout keys of `worktreeKey`'s family (main + aux layouts). */
function familyLayoutKeys(
  layouts: Record<string, WorktreePanelLayout>,
  worktreeKey: string,
): string[] {
  return Object.keys(layouts).filter(
    (key) =>
      key === worktreeKey || getAuxPanelLayoutOwnerKey(key) === worktreeKey,
  );
}

/** `ownerWorktreeKey → (instanceKey → bound chat tab id)` for bound panels. */
function collectBindingsByOwner(
  layouts: Record<string, WorktreePanelLayout>,
): Map<string, Map<string, string>> {
  const byOwner = new Map<string, Map<string, string>>();
  for (const [layoutKey, layout] of Object.entries(layouts)) {
    const ownerKey = getAuxPanelLayoutOwnerKey(layoutKey) ?? layoutKey;
    let bindings = byOwner.get(ownerKey);
    if (!bindings) {
      bindings = new Map<string, string>();
      byOwner.set(ownerKey, bindings);
    }
    for (const group of Object.values(layout.groups)) {
      for (const tab of group.tabs) {
        const bound = boundChatTabId(tab);
        if (bound !== null) {
          bindings.set(getPanelInstanceKey(tab), bound);
        }
      }
    }
  }
  return byOwner;
}

/**
 * Why `chatStore.closeTab` would refuse to close this chat (its turn is active
 * or its delegates are live), or `null`. The same shared predicate the store
 * uses, so the panel bridge never removes or replaces a panel whose backing
 * chat cannot actually close.
 */
function chatCloseBlocker(
  tab: ChatTab,
  ownerKey: string,
): ChatCloseBlocker | null {
  const { projectId, worktreeId } = splitWorktreeKey(ownerKey);
  return getChatTabCloseBlocker(tab, projectId, worktreeId);
}

function isUncloseableActiveChat(tab: ChatTab, ownerKey: string): boolean {
  return chatCloseBlocker(tab, ownerKey) !== null;
}

/**
 * The close blocker for a chat-bound panel tab in `layoutKey`'s family, or
 * `null` for unbound/non-chat panels and closeable chats.
 */
function panelChatCloseBlocker(
  layoutKey: string,
  panelTab: Pick<PanelTabModel, 'kind' | 'instance'>,
): ChatCloseBlocker | null {
  if (panelTab.kind !== 'chat') return null;
  const chatTabId = panelTab.instance?.chatTabId;
  if (!chatTabId) return null;
  const ownerKey = getAuxPanelLayoutOwnerKey(layoutKey) ?? layoutKey;
  const chatTab = useChatStore
    .getState()
    .worktreeChats[
      ownerKey
    ]?.tabs.find((candidate) => candidate.id === chatTabId);
  return chatTab ? chatCloseBlocker(chatTab, ownerKey) : null;
}

/**
 * Refuses a panel close whose bound chat is busy, before anything is removed.
 * Returns true when the close must not proceed (and says why when delegates
 * are the reason).
 */
function refuseBusyChatPanelClose(
  layoutKey: string,
  groupId: string,
  panelId: string,
): boolean {
  const panelTab = usePanelLayoutStore
    .getState()
    .layouts[
      layoutKey
    ]?.groups[groupId]?.tabs.find((candidate) => candidate.panelId === panelId);
  if (!panelTab) return false;
  const blocker = panelChatCloseBlocker(layoutKey, panelTab);
  if (blocker === 'delegates') {
    notifyDelegatesBlockClose();
  }
  return blocker !== null;
}

function releaseReplacementCloseSuppression(chatTabId: string): void {
  const timeout = chatTabsAwaitingReplacementClose.get(chatTabId);
  if (timeout !== undefined) {
    clearTimeout(timeout);
    chatTabsAwaitingReplacementClose.delete(chatTabId);
  }
}

function suppressReplacementClose(chatTabId: string): void {
  releaseReplacementCloseSuppression(chatTabId);
  const timeout = setTimeout(() => {
    chatTabsAwaitingReplacementClose.delete(chatTabId);
    scheduleSweep();
  }, REPLACEMENT_CLOSE_SUPPRESSION_MS);
  chatTabsAwaitingReplacementClose.set(chatTabId, timeout);
}

/**
 * Suppress every closeable chat panel targeted by a panel-side batch close.
 * This also covers Close Others/Left/Right, where an untargeted chat survives
 * and the final-chat replacement path intentionally has nothing to preserve.
 */
function suppressClosingChatPanels(
  layoutKey: string,
  groupId: string,
  panelIds: readonly string[],
): void {
  const layout = usePanelLayoutStore.getState().layouts[layoutKey];
  const group = layout?.groups[groupId];
  if (!group) return;

  const ownerKey = getAuxPanelLayoutOwnerKey(layoutKey) ?? layoutKey;
  const ownerTabs = useChatStore.getState().worktreeChats[ownerKey]?.tabs ?? [];
  const targets = new Set(panelIds);
  for (const panelTab of group.tabs) {
    if (panelTab.kind !== 'chat' || !targets.has(panelTab.panelId)) continue;
    const chatTabId = panelTab.instance?.chatTabId;
    if (!chatTabId) continue;
    const chatTab = ownerTabs.find((candidate) => candidate.id === chatTabId);
    if (chatTab && !isUncloseableActiveChat(chatTab, ownerKey)) {
      suppressReplacementClose(chatTabId);
    }
  }
}

/**
 * Preserve chat panels that the chat store would refuse to close while still
 * allowing the rest of a panel-side batch close to proceed.
 */
function filterCloseablePanelIds(
  layoutKey: string,
  groupId: string,
  panelIds: readonly string[],
): string[] {
  const layout = usePanelLayoutStore.getState().layouts[layoutKey];
  const group = layout?.groups[groupId];
  if (!group) return [...panelIds];

  const ownerKey = getAuxPanelLayoutOwnerKey(layoutKey) ?? layoutKey;
  const ownerTabs = useChatStore.getState().worktreeChats[ownerKey]?.tabs ?? [];
  const targets = new Set(panelIds);
  const protectedPanelIds = new Set<string>();
  let protectedForDelegates = false;
  for (const panelTab of group.tabs) {
    if (panelTab.kind !== 'chat') continue;
    const chatTabId = panelTab.instance?.chatTabId;
    if (!chatTabId) continue;
    const chatTab = ownerTabs.find((candidate) => candidate.id === chatTabId);
    const blocker = chatTab ? chatCloseBlocker(chatTab, ownerKey) : null;
    if (blocker !== null) {
      protectedPanelIds.add(panelTab.panelId);
      if (blocker === 'delegates' && targets.has(panelTab.panelId)) {
        protectedForDelegates = true;
      }
    }
  }
  if (protectedForDelegates) {
    notifyDelegatesBlockClose();
  }

  return panelIds.filter((panelId) => !protectedPanelIds.has(panelId));
}

/**
 * If this close would remove the final chat panel from an emptied group,
 * replace that panel descriptor in place with a fresh chat first. This keeps
 * the group's exact grid node (including collapse/maximize state) alive while
 * the normal panels → chat reconciliation closes the old chat tab.
 */
function preserveGroupForLastChatClose(
  layoutKey: string,
  groupId: string,
  panelIds: readonly string[],
): boolean {
  const panelState = usePanelLayoutStore.getState();
  const layout = panelState.layouts[layoutKey];
  const group = layout?.groups[groupId];
  if (!layout || !group) return true;

  const targets = new Set(panelIds);
  if (
    targets.size === 0 ||
    group.tabs.some((tab) => !targets.has(tab.panelId))
  ) {
    return true;
  }

  const ownerKey = getAuxPanelLayoutOwnerKey(layoutKey) ?? layoutKey;
  const closingChats: PanelTabDescriptor[] = [];
  for (const familyKey of familyLayoutKeys(panelState.layouts, ownerKey)) {
    const familyLayout = panelState.layouts[familyKey];
    if (!familyLayout) continue;
    for (const familyGroup of Object.values(familyLayout.groups)) {
      for (const tab of familyGroup.tabs) {
        if (tab.kind !== 'chat') continue;
        if (familyKey === layoutKey && targets.has(tab.panelId)) {
          closingChats.push(tab);
        } else {
          // Another chat panel survives elsewhere in the layout family, so
          // the normal close path cannot strand the worktree without one.
          return true;
        }
      }
    }
  }

  if (closingChats.length === 0) return true;
  const closingChatTabIds = closingChats.flatMap((tab) =>
    tab.instance?.chatTabId ? [tab.instance.chatTabId] : [],
  );
  if (closingChatTabIds.length !== closingChats.length) return true;

  const separator = ownerKey.indexOf('/');
  if (separator === -1) return false;
  const projectId = ownerKey.slice(0, separator);
  const worktreeId = ownerKey.slice(separator + 1);
  const ownerTabs = useChatStore.getState().worktreeChats[ownerKey]?.tabs ?? [];
  const closingChatTabs = closingChatTabIds.flatMap((chatTabId) => {
    const tab = ownerTabs.find((candidate) => candidate.id === chatTabId);
    return tab ? [tab] : [];
  });
  if (closingChatTabs.length !== closingChatTabIds.length) return true;

  // A streaming / queued / pending-plan-exit chat cannot be closed
  // (`chatStore.closeTab` refuses it). Replacing its panel would spawn a fresh
  // chat while the running one lingered invisibly, so leave everything in place
  // and treat the close as a no-op — the same outcome the chat store enforces.
  if (closingChatTabs.some((tab) => isUncloseableActiveChat(tab, ownerKey))) {
    return false;
  }

  const tabsBefore = new Set(ownerTabs.map((tab) => tab.id));

  useChatStore.getState().createTab({ projectId, worktreeId });
  const createdTab = (
    useChatStore.getState().worktreeChats[ownerKey]?.tabs ?? []
  ).find((tab) => tab.kind !== 'file' && !tabsBefore.has(tab.id));
  if (!createdTab) return false;

  const seed = chatTabToPanelSeed(createdTab);
  const replacementTarget = closingChats[0];
  const replaced = usePanelLayoutStore
    .getState()
    .replaceTab(layoutKey, groupId, replacementTarget.panelId, seed);
  if (!replaced) {
    // Do not leave an unexpected extra chat behind if the layout changed
    // between the snapshots above. The original panel remains untouched.
    useChatStore.getState().closeTab(createdTab.id, { projectId, worktreeId });
    return false;
  }
  // The old chat's panel is gone; the reconcile sweep will close its backing
  // chat tab (archiving it if it has history). Suppress re-materialization of
  // that tab while the async close is in flight so it does not flash back into
  // the layout beside the fresh chat.
  for (const closingChatTabId of closingChatTabIds) {
    suppressReplacementClose(closingChatTabId);
  }
  return true;
}

/**
 * Starts a bound file tab's authoritative close before its panel disappears.
 *
 * Panel-only closing normally relies on the previous reconciliation snapshot
 * to discover which backing tab vanished. A newly materialized file panel can
 * be closed before that snapshot settles, in which case the still-live file
 * tab is interpreted as missing a panel and gets appended again. Dispatching
 * the file-tab close first removes that ordering dependency.
 *
 * A dirty file (or an autosave still in flight) deliberately remains present
 * without a `closingChatTabs` marker. In that case leave the panel in place so
 * the save/discard guard owns the rest of the flow.
 */
function startBoundFileTabClose(
  layoutKey: string,
  groupId: string,
  panelId: string,
): boolean {
  const panelTab = usePanelLayoutStore
    .getState()
    .layouts[
      layoutKey
    ]?.groups[groupId]?.tabs.find((candidate) => candidate.panelId === panelId);
  if (panelTab?.kind !== 'file-diff') return true;

  const fileTabId = panelTab.instance?.fileTabId;
  if (!fileTabId) return true;
  const ownerKey = getAuxPanelLayoutOwnerKey(layoutKey) ?? layoutKey;
  const separator = ownerKey.indexOf('/');
  if (separator === -1) return false;
  const projectId = ownerKey.slice(0, separator);
  const worktreeId = ownerKey.slice(separator + 1);
  const chat = useChatStore.getState();
  const backingTab = chat.worktreeChats[ownerKey]?.tabs.find(
    (candidate) => candidate.id === fileTabId,
  );
  if (!backingTab) return true;

  chat.closeTab(fileTabId, { projectId, worktreeId });

  const after = useChatStore.getState();
  const stillExists = after.worktreeChats[ownerKey]?.tabs.some(
    (candidate) => candidate.id === fileTabId,
  );
  const closePending = after.closingChatTabs[ownerKey]?.has(fileTabId) === true;
  return !stillExists || closePending;
}

/** Close one panel tab while preserving an emptied final-chat group in place. */
export function closePanelTab(
  layoutKey: string,
  groupId: string,
  panelId: string,
): void {
  // A busy chat (active turn or live delegates) stays open: refuse before the
  // panel is removed rather than letting the sweep's refused close bring it
  // back somewhere else.
  if (refuseBusyChatPanelClose(layoutKey, groupId, panelId)) return;
  if (!startBoundFileTabClose(layoutKey, groupId, panelId)) return;
  if (!preserveGroupForLastChatClose(layoutKey, groupId, [panelId])) return;
  suppressClosingChatPanels(layoutKey, groupId, [panelId]);
  usePanelLayoutStore.getState().closeTab(layoutKey, groupId, panelId);
}

/** Batch counterpart used by the panel tab context menu. */
export function closePanelTabs(
  layoutKey: string,
  groupId: string,
  panelIds: string[],
): void {
  const closeablePanelIds = filterCloseablePanelIds(
    layoutKey,
    groupId,
    panelIds,
  );
  if (!preserveGroupForLastChatClose(layoutKey, groupId, closeablePanelIds)) {
    return;
  }
  suppressClosingChatPanels(layoutKey, groupId, closeablePanelIds);
  usePanelLayoutStore
    .getState()
    .closeTabs(layoutKey, groupId, closeablePanelIds);
}

/**
 * "Close group" for the desktop grids. A group holding a busy chat (active
 * turn or live delegates) stays: its other tabs close through
 * {@link closePanelTabs}, and the notice explains when delegates are why.
 */
export function closePanelGroup(layoutKey: string, groupId: string): void {
  const group =
    usePanelLayoutStore.getState().layouts[layoutKey]?.groups[groupId];
  if (!group) return;
  const blockers = group.tabs.map((tab) =>
    panelChatCloseBlocker(layoutKey, tab),
  );
  if (blockers.every((blocker) => blocker === null)) {
    usePanelLayoutStore.getState().closeGroup(layoutKey, groupId);
    return;
  }
  // `closePanelTabs` filters the busy chats out and raises the notice.
  closePanelTabs(
    layoutKey,
    groupId,
    group.tabs.map((tab) => tab.panelId),
  );
}

/**
 * Store-level backstop for group closes that do not route through
 * {@link closePanelGroup} (panel commands, App Advisor): busy chats keep their
 * group open.
 */
function installPanelTabCloseGuard(): void {
  setPanelTabCloseGuard(
    (layoutKey, tab) => panelChatCloseBlocker(layoutKey, tab) !== null,
  );
}

/**
 * Chat-side closes (for example Cmd+W) replace the final panel during the
 * reconcile sweep. The chat store has already swapped its last tab for a
 * fresh fallback at this point, so pair that unbound fallback with the sole
 * stale chat panel instead of performing a topology-changing close + add.
 */
function replaceOrphanedFinalChatPanel(
  worktreeKey: string,
  chatTabs: readonly ChatTab[],
): void {
  const chatTabIds = new Set(chatTabs.map((tab) => tab.id));
  const unboundChats = chatTabs.filter(
    (tab) =>
      tab.kind !== 'file' &&
      findPanelByInstanceKey(
        worktreeKey,
        getPanelInstanceKey(chatTabToPanelSeed(tab)),
      ) === null,
  );
  if (unboundChats.length !== 1) return;

  const layouts = usePanelLayoutStore.getState().layouts;
  let orphan:
    | { layoutKey: string; groupId: string; tab: PanelTabDescriptor }
    | undefined;
  for (const layoutKey of familyLayoutKeys(layouts, worktreeKey)) {
    const layout = layouts[layoutKey];
    if (!layout) continue;
    for (const [groupId, group] of Object.entries(layout.groups)) {
      for (const tab of group.tabs) {
        if (tab.kind !== 'chat') continue;
        if (orphan !== undefined) return;
        if (
          group.tabs.length !== 1 ||
          !tab.instance?.chatTabId ||
          chatTabIds.has(tab.instance.chatTabId)
        ) {
          return;
        }
        orphan = { layoutKey, groupId, tab };
      }
    }
  }
  if (!orphan) return;

  usePanelLayoutStore
    .getState()
    .replaceTab(
      orphan.layoutKey,
      orphan.groupId,
      orphan.tab.panelId,
      chatTabToPanelSeed(unboundChats[0]),
    );
}

/**
 * Where a chat/file panel that arrives on its own (a remote, delegated, or
 * forked chat, an opened file) goes, rather than from a gesture into a group:
 * the preferred group when it has room, else the most recently used chat
 * group with room, else a new group split beside the preferred one. When no
 * split is possible (a fixed topology), the preferred group takes it past the
 * row limit: a chat that may be waiting on the user is never left without a
 * tab. A chat restricted to the chat group (early access) goes there the same
 * way, since the store would move it out of any other group. `null` only when
 * the preferred group is unknown.
 */
function groupWithRoom(
  worktreeKey: string,
  preferredGroupId: string,
  kind: PanelTabDescriptor['kind'],
): string | null {
  const store = usePanelLayoutStore.getState();
  const layout = store.layouts[worktreeKey];
  if (layout === undefined) {
    return null;
  }
  const chatGroupId = kind === 'chat' ? restrictedChatGroupId(layout) : null;
  if (chatGroupId !== null) {
    return chatGroupId;
  }
  const preferred = layout.groups[preferredGroupId];
  if (store.canAddTabToGroup(worktreeKey, preferredGroupId)) {
    return preferredGroupId;
  }
  for (const groupId of layout.mruGroupIds) {
    if (
      layout.groups[groupId]?.tabs.some((tab) => tab.kind === 'chat') ===
        true &&
      store.canAddTabToGroup(worktreeKey, groupId)
    ) {
      return groupId;
    }
  }
  return (
    usePanelLayoutStore
      .getState()
      .splitGroup(worktreeKey, preferredGroupId, 'right') ??
    (preferred !== undefined ? preferredGroupId : null)
  );
}

/**
 * For a chat the user is about to create with no target group (Cmd/Ctrl+T,
 * the command palette): refuses with the full-row note, before the chat
 * exists, when the row it would open in is full, like the disabled `+` on
 * that row. That row is the chat group when early access keeps chats there
 * (see `groupWithRoom`), else Minimal's chat row, else the
 * `pickContentTargetGroupId` pick (the most recently used row with a chat,
 * then the default chat row, then the active row). Chats that arrive on
 * their own are placed elsewhere instead (see `groupWithRoom`). Returns
 * whether it refused.
 */
export function refuseFullNewChatRow(worktreeKey: string): boolean {
  const layout = usePanelLayoutStore.getState().layouts[worktreeKey];
  if (layout === undefined) {
    return false;
  }
  const groupId =
    restrictedChatGroupId(layout) ??
    (getWorkspaceLayoutMode(worktreeKey) === 'minimal'
      ? DEFAULT_CHAT_GROUP_ID
      : pickContentTargetGroupId(layout));
  return groupId !== null && refuseFullTabRow(worktreeKey, groupId);
}

/** Chat tab ids bound to a panel that is currently in a COLLAPSED group. */
function collectHiddenChatTabIds(
  layouts: Record<string, WorktreePanelLayout>,
): Set<string> {
  const hidden = new Set<string>();
  for (const layout of Object.values(layouts)) {
    for (const group of Object.values(layout.groups)) {
      if (group.collapsed === undefined) {
        continue;
      }
      for (const tab of group.tabs) {
        const bound = boundChatTabId(tab);
        if (bound !== null) {
          hidden.add(bound);
        }
      }
    }
  }
  return hidden;
}

/**
 * Places a fresh file panel in the same group as the origin file tab's
 * panel, directly after it — the `file-sibling` hint.
 */
function materializeFilePanelAsSibling(
  worktreeKey: string,
  seed: ChatTabPanelSeed,
  originFileTabId: string,
  activate: boolean,
): string | null {
  const origin = findPanelByInstanceKey(
    worktreeKey,
    `file-diff:${originFileTabId}`,
  );
  if (origin === null) {
    return null;
  }
  const store = usePanelLayoutStore.getState();
  const panelId =
    store.addTab(origin.layoutKey, origin.groupId, seed.kind, {
      panelId: seed.panelId,
      title: seed.title,
      instance: seed.instance,
      ...(activate ? {} : { activate: false }),
    }) ??
    store.addTab(origin.layoutKey, origin.groupId, seed.kind, {
      title: seed.title,
      instance: seed.instance,
      ...(activate ? {} : { activate: false }),
    });
  if (panelId === null) {
    return null;
  }
  const group =
    usePanelLayoutStore.getState().layouts[origin.layoutKey]?.groups[
      origin.groupId
    ];
  const originIndex =
    group?.tabs.findIndex((tab) => tab.panelId === origin.panelId) ?? -1;
  if (originIndex !== -1) {
    store.reorderTab(
      origin.layoutKey,
      origin.groupId,
      panelId,
      originIndex + 1,
    );
  }
  return panelId;
}

function materializeFilePanelFromPlacement(
  worktreeKey: string,
  seed: ChatTabPanelSeed,
  activate: boolean,
): string | null {
  const fileTabId = seed.instance.fileTabId;
  if (!fileTabId) {
    return null;
  }
  const placement = pendingFilePanelPlacements.get(fileTabId);
  if (!placement) {
    return null;
  }
  if (placement.kind === 'file-sibling') {
    return materializeFilePanelAsSibling(
      worktreeKey,
      seed,
      placement.originFileTabId,
      activate,
    );
  }

  return materializeContentBesideChat(
    worktreeKey,
    seed,
    placement.originChatTabId,
    activate,
  );
}

function materializeContentBesideChat(
  worktreeKey: string,
  seed: ChatTabPanelSeed,
  originChatTabId: string,
  activate: boolean,
): string | null {
  const origin = findPanelByInstanceKey(worktreeKey, `chat:${originChatTabId}`);
  if (origin === null) {
    return null;
  }

  const store = usePanelLayoutStore.getState();
  const layout = store.layouts[origin.layoutKey];
  if (!layout) {
    return null;
  }

  const existingSideGroupId = pickReusableChatSiblingGroupId(
    layout,
    origin.groupId,
  );
  if (existingSideGroupId !== null) {
    return store.addTab(origin.layoutKey, existingSideGroupId, seed.kind, {
      panelId: seed.panelId,
      title: seed.title,
      instance: seed.instance,
      ...(activate ? {} : { activate: false }),
    });
  }

  if (!activate) {
    return store.addTab(origin.layoutKey, origin.groupId, seed.kind, {
      panelId: seed.panelId,
      title: seed.title,
      instance: seed.instance,
      activate: false,
    });
  }

  const created = createChatSiblingGroupToRight(
    origin.layoutKey,
    origin.groupId,
  );
  if (created === null) {
    return null;
  }

  const panelId = store.addTab(origin.layoutKey, created.groupId, seed.kind, {
    panelId: seed.panelId,
    title: seed.title,
    instance: seed.instance,
  });
  if (panelId === null) {
    rollbackCreatedChatSiblingGroup(origin.layoutKey, created);
    return null;
  }
  return panelId;
}

function materializeChatPanelFromForkPlacement(
  worktreeKey: string,
  tab: ChatTab,
  seed: ChatTabPanelSeed,
  chatTabs: readonly ChatTab[],
  activate: boolean,
): string | null {
  if (tab.kind === 'file' || seed.kind !== 'chat') {
    return null;
  }
  const source = tab.forkedFrom;
  if (!source || `${source.projectId}/${source.worktreeId}` !== worktreeKey) {
    return null;
  }

  const origin = findPanelByInstanceKey(worktreeKey, `chat:${source.chatId}`);
  if (origin === null) {
    return null;
  }

  const store = usePanelLayoutStore.getState();
  const layout = store.layouts[origin.layoutKey];
  const group = layout?.groups[origin.groupId];
  const originPanel = group?.tabs.find(
    (candidate) => candidate.panelId === origin.panelId,
  );
  if (!layout || !group || !originPanel) {
    return null;
  }

  const panelId =
    store.addTab(origin.layoutKey, origin.groupId, seed.kind, {
      panelId: seed.panelId,
      title: seed.title,
      instance: seed.instance,
      ...(activate ? {} : { activate: false }),
    }) ??
    store.addTab(origin.layoutKey, origin.groupId, seed.kind, {
      title: seed.title,
      instance: seed.instance,
      ...(activate ? {} : { activate: false }),
    });
  if (panelId === null) {
    return null;
  }

  if (originPanel.pinned === true) {
    usePanelLayoutStore
      .getState()
      .setTabPinned(origin.layoutKey, origin.groupId, panelId, true);
  }

  const currentGroup =
    usePanelLayoutStore.getState().layouts[origin.layoutKey]?.groups[
      origin.groupId
    ];
  let predecessorPanelId = origin.panelId;
  const tabIndex = chatTabs.findIndex((candidate) => candidate.id === tab.id);
  const sourceIndex = chatTabs.findIndex(
    (candidate) => candidate.id === source.chatId,
  );
  for (let index = tabIndex - 1; index > sourceIndex; index -= 1) {
    const candidate = chatTabs[index];
    if (!candidate || candidate.kind === 'file') {
      continue;
    }
    const candidateSource = candidate.forkedFrom;
    if (
      !candidateSource ||
      candidateSource.projectId !== source.projectId ||
      candidateSource.worktreeId !== source.worktreeId ||
      candidateSource.chatId !== source.chatId
    ) {
      continue;
    }
    const candidateLocation = findPanelByInstanceKey(
      worktreeKey,
      `chat:${candidate.id}`,
    );
    if (
      candidateLocation !== null &&
      candidateLocation.layoutKey === origin.layoutKey &&
      candidateLocation.groupId === origin.groupId
    ) {
      predecessorPanelId = candidateLocation.panelId;
      break;
    }
  }
  const predecessorIndex =
    currentGroup?.tabs.findIndex(
      (candidate) => candidate.panelId === predecessorPanelId,
    ) ?? -1;
  if (predecessorIndex !== -1) {
    usePanelLayoutStore
      .getState()
      .reorderTab(
        origin.layoutKey,
        origin.groupId,
        panelId,
        predecessorIndex + 1,
      );
  }

  return panelId;
}

/** Bound chat tab id of the active panel of a layout's active group. */
function activeBoundTabId(
  layout: WorktreePanelLayout | undefined,
): string | null {
  if (!layout || layout.activeGroupId === null) {
    return null;
  }
  const group = layout.groups[layout.activeGroupId];
  if (!group || group.activePanelId === null) {
    return null;
  }
  const tab = group.tabs.find(
    (candidate) => candidate.panelId === group.activePanelId,
  );
  return tab !== undefined ? boundChatTabId(tab) : null;
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

function runSweep(): void {
  syncing = true;
  try {
    const panelState = usePanelLayoutStore.getState();
    const chatState = useChatStore.getState();

    // ---- panels → chat: bound panels removed since the last sweep close
    // their chat tabs (ChatTabBar's close action, all guards included).
    const bindingsNow = collectBindingsByOwner(panelState.layouts);
    for (const [ownerKey, previous] of Array.from(
      lastFamilyBindings.entries(),
    )) {
      const current = bindingsNow.get(ownerKey);
      if (!current) {
        // The whole family was disposed (worktree archived/deleted); that is
        // layout teardown, not tab-by-tab closing — leave the chats alone.
        continue;
      }
      for (const [instanceKey, chatTabId] of Array.from(previous.entries())) {
        if (current.has(instanceKey)) {
          continue;
        }
        const wc = useChatStore.getState().worktreeChats[ownerKey];
        if (!wc?.tabs.some((tab) => tab.id === chatTabId)) {
          continue;
        }
        const { projectId, worktreeId } = splitWorktreeKey(ownerKey);
        useChatStore.getState().closeTab(chatTabId, { projectId, worktreeId });
      }
    }

    // ---- mounted-owner reconcile (chat → panels) + active-tab sync.
    // The selected worktree remains an implicit owner for callers that mount
    // the bridge before their grid. A page-like overlay (a recipient share)
    // also reconciles through its registration below, so its standard panels
    // stay scoped without changing global navigation state. Other mounted
    // grids reconcile only while they are the selected worktree.
    const selections = new Map<
      string,
      { projectId: string; worktreeId: string }
    >();
    const selected = chatState.selectedWorktree;
    if (selected) {
      selections.set(`${selected.projectId}/${selected.worktreeId}`, selected);
    }
    for (const worktreeKey of Array.from(mountedOwnerRefCounts.keys())) {
      selections.set(worktreeKey, splitWorktreeKey(worktreeKey));
    }
    for (const selection of Array.from(selections.values())) {
      const worktreeKey = `${selection.projectId}/${selection.worktreeId}`;
      const layoutBefore = panelState.layouts[worktreeKey];
      // Both sides must be hydrated: reconciling against a not-yet-loaded
      // chat list would treat every restored bound panel as orphaned and
      // close it. The chat subscription re-schedules once tabs load.
      if (
        layoutBefore !== undefined &&
        chatState.worktreeChats[worktreeKey] !== undefined
      ) {
        // Pre-mutation deltas for the bidirectional active-tab sync: which
        // SIDE changed since the last settled sweep decides the direction.
        const chatActiveBefore =
          chatState.worktreeChats[worktreeKey]?.activeTabId ?? null;
        const panelActiveBefore = activeBoundTabId(layoutBefore);
        const seenBefore =
          lastChatActiveTabId.has(worktreeKey) ||
          lastPanelActiveTabId.has(worktreeKey);
        const chatActiveChanged =
          seenBefore &&
          chatActiveBefore !== (lastChatActiveTabId.get(worktreeKey) ?? null);
        const panelActiveChanged =
          seenBefore &&
          panelActiveBefore !== (lastPanelActiveTabId.get(worktreeKey) ?? null);

        // (a) panels whose bound chat/file tab vanished → close the panel.
        const chatTabs =
          useChatStore.getState().worktreeChats[worktreeKey]?.tabs ?? [];
        replaceOrphanedFinalChatPanel(worktreeKey, chatTabs);
        const chatTabIds = new Set(chatTabs.map((tab) => tab.id));
        for (const layoutKey of familyLayoutKeys(
          usePanelLayoutStore.getState().layouts,
          worktreeKey,
        )) {
          const layout = usePanelLayoutStore.getState().layouts[layoutKey];
          if (!layout) continue;
          for (const [groupId, group] of Object.entries(layout.groups)) {
            for (const tab of group.tabs) {
              const bound = boundChatTabId(tab);
              if (bound !== null && !chatTabIds.has(bound)) {
                usePanelLayoutStore
                  .getState()
                  .closeTab(layoutKey, groupId, tab.panelId);
              }
            }
          }
        }

        // (b) chat/file tabs with no bound panel → materialize one.
        const addedInstanceKeys = new Set<string>();
        // A recipient share restores the publisher's layout on its first
        // sweep. A published chat the layout leaves out still gets a tab, but
        // must not take the active tab the publisher left selected.
        const preserveRestoredSelection =
          !seenBefore &&
          selection.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID;
        for (const tab of chatTabs) {
          // A panel-initiated close removes the panel before the chat store's
          // authoritative archive/cancel request completes. Do not interpret
          // that intentional gap as a missing panel to recreate: addTab would
          // focus it, producing a visible close/reopen/unread/archive bounce.
          // A failed request clears this marker while leaving the chat live,
          // so the next sweep restores the panel for a safe retry.
          if (
            useChatStore.getState().closingChatTabs[worktreeKey]?.has(tab.id)
          ) {
            continue;
          }

          // A chat replaced in place is intentionally panel-less until its
          // async close removes it from the store; skip it so it is not shown
          // again beside the fresh chat that took its slot.
          if (chatTabsAwaitingReplacementClose.has(tab.id)) {
            // A queued placeholder can start, or another live-state transition
            // can make the chat uncloseable, while cancellation is in flight.
            // Restore its panel immediately so monitoring and stop controls are
            // never hidden behind the pending replacement close.
            if (isUncloseableActiveChat(tab, worktreeKey)) {
              releaseReplacementCloseSuppression(tab.id);
            } else {
              continue;
            }
          }
          const seed = chatTabToPanelSeed(tab);
          const instanceKey = getPanelInstanceKey(seed);
          // Only the chat-active tab is selected as its panel materializes. A
          // chat that arrives on its own (a hook, automation, or agent) gets a
          // place without moving the user's tab or focused group, including
          // when the user comes back to a worktree it was added to.
          const activate =
            !preserveRestoredSelection &&
            tab.id ===
              useChatStore.getState().worktreeChats[worktreeKey]?.activeTabId;
          if (findPanelByInstanceKey(worktreeKey, instanceKey) !== null) {
            if (tab.kind === 'file') {
              pendingFilePanelPlacements.delete(tab.id);
            }
            continue;
          }
          const layout = usePanelLayoutStore.getState().layouts[worktreeKey];
          if (!layout) break;
          const minimalDestination =
            getWorkspaceLayoutMode(worktreeKey) === 'minimal'
              ? ensureMinimalDestination(
                  worktreeKey,
                  seed.kind === 'file-diff' ? 'file-diff' : 'chat',
                )
              : null;
          const preferredGroupId =
            minimalDestination ?? pickContentTargetGroupId(layout);
          if (preferredGroupId === null) break;
          // Resolved only when the placement hints below do not apply, so a
          // full preferred row is never split for a tab that lands elsewhere.
          const addToGroupWithRoom = (): string | null => {
            const groupId = groupWithRoom(
              worktreeKey,
              preferredGroupId,
              seed.kind,
            );
            if (groupId === null) {
              return null;
            }
            return (
              usePanelLayoutStore
                .getState()
                .addTab(worktreeKey, groupId, seed.kind, {
                  panelId: seed.panelId,
                  title: seed.title,
                  instance: seed.instance,
                  ...(activate ? {} : { activate: false }),
                }) ??
              usePanelLayoutStore
                .getState()
                .addTab(worktreeKey, groupId, seed.kind, {
                  title: seed.title,
                  instance: seed.instance,
                  ...(activate ? {} : { activate: false }),
                })
            );
          };
          // Deterministic panel id (`panel-chat-<id>` / `panel-file-<id>`)
          // so bound panels are addressable without discovery; fall back to
          // a generated id if the derived id is somehow taken in the family.
          const panelId =
            materializeChatPanelFromForkPlacement(
              worktreeKey,
              tab,
              seed,
              chatTabs,
              activate,
            ) ??
            (tab.kind === 'file'
              ? materializeFilePanelFromPlacement(worktreeKey, seed, activate)
              : null) ??
            addToGroupWithRoom();
          if (tab.kind === 'file') {
            pendingFilePanelPlacements.delete(tab.id);
          }
          if (panelId !== null) {
            if (getWorkspaceLayoutMode(worktreeKey) === 'minimal') {
              removeMinimalDestinationProbe(
                worktreeKey,
                seed.kind === 'file-diff' ? 'side' : 'chat',
              );
            }
            addedInstanceKeys.add(instanceKey);
          }
        }

        // (c) title drift → updateTabInstanceTitle.
        for (const layoutKey of familyLayoutKeys(
          usePanelLayoutStore.getState().layouts,
          worktreeKey,
        )) {
          const layout = usePanelLayoutStore.getState().layouts[layoutKey];
          if (!layout) continue;
          for (const group of Object.values(layout.groups)) {
            for (const tab of group.tabs) {
              const bound = boundChatTabId(tab);
              if (bound === null) continue;
              const chatTab = chatTabs.find(
                (candidate) => candidate.id === bound,
              );
              if (chatTab !== undefined && tab.title !== chatTab.title) {
                usePanelLayoutStore
                  .getState()
                  .updateTabInstanceTitle(
                    worktreeKey,
                    tab.panelId,
                    chatTab.title,
                  );
              }
            }
          }
        }

        // (d) active-tab sync. Panel-side user changes win when only the
        // panel side moved; otherwise the chat side drives (explicit chat
        // change, first sweep for this worktree, or a just-materialized
        // panel for the chat-active tab).
        const chatActiveTab =
          useChatStore
            .getState()
            .worktreeChats[
              worktreeKey
            ]?.tabs.find((tab) => tab.id === useChatStore.getState().worktreeChats[worktreeKey]?.activeTabId) ??
          undefined;
        if (
          panelActiveChanged &&
          !chatActiveChanged &&
          panelActiveBefore !== null &&
          panelActiveBefore !== chatActiveBefore
        ) {
          useChatStore.getState().switchTab(panelActiveBefore, {
            projectId: selection.projectId,
            worktreeId: selection.worktreeId,
          });
        } else if (chatActiveTab !== undefined) {
          const seed = chatTabToPanelSeed(chatActiveTab);
          const instanceKey = getPanelInstanceKey(seed);
          // An explicit chat-side change or a just-materialized panel is user
          // interaction → select AND focus. Ordinary worktrees preserve the
          // historical first-sweep behavior of re-activating the chat-store
          // tab within its group. The shared-container viewer instead keeps
          // the restored panel selection verbatim: its persisted active tab
          // is recipient-local view state, and must win over the projected
          // chat manifest's active tab after restart.
          const interactionDrive =
            chatActiveChanged ||
            (addedInstanceKeys.has(instanceKey) && !preserveRestoredSelection);
          const shouldDrive =
            interactionDrive ||
            (!seenBefore &&
              selection.projectId !== SHARED_CONTAINER_VIEWER_PROJECT_ID);
          if (shouldDrive) {
            const location = findPanelByInstanceKey(worktreeKey, instanceKey);
            if (location !== null) {
              const layout =
                usePanelLayoutStore.getState().layouts[location.layoutKey];
              const group = layout?.groups[location.groupId];
              const alreadyActive =
                layout !== undefined &&
                group !== undefined &&
                group.activePanelId === location.panelId &&
                (!interactionDrive ||
                  layout.activeGroupId === location.groupId);
              // Reveal (expand) runs even when the tab is already active —
              // a persisted/current active tab can still live in a
              // collapsed group (e.g. restored that way, or collapsed while
              // active), and re-selecting it must still expand the group.
              // Only the redundant reselect is skipped.
              usePanelLayoutStore
                .getState()
                .ensureGroupExpanded(location.layoutKey, location.groupId, {
                  focus: interactionDrive,
                });
              if (!alreadyActive) {
                usePanelLayoutStore
                  .getState()
                  .selectTab(
                    location.layoutKey,
                    location.groupId,
                    location.panelId,
                    { focus: interactionDrive },
                  );
              }
            }
          }
        }

        // Settled snapshots for the next sweep's change detection.
        lastChatActiveTabId.set(
          worktreeKey,
          useChatStore.getState().worktreeChats[worktreeKey]?.activeTabId ??
            null,
        );
        lastPanelActiveTabId.set(
          worktreeKey,
          activeBoundTabId(usePanelLayoutStore.getState().layouts[worktreeKey]),
        );
      }
    }

    // ---- collapsed-chat unread bridge. Feed the chat store the chats hidden
    // by a collapsed panel (so their completed turns accrue unread even as the
    // active tab), and mark a chat read the instant its panel is revealed
    // (collapsed → expanded) while it is still its worktree's active tab.
    const settledLayouts = usePanelLayoutStore.getState().layouts;
    const hiddenNow = collectHiddenChatTabIds(settledLayouts);
    const revealed = Array.from(lastHiddenChatTabIds).filter(
      (id) => !hiddenNow.has(id),
    );
    if (revealed.length > 0) {
      const chatStates = useChatStore.getState().worktreeChats;
      for (const chatId of revealed) {
        for (const [key, wc] of Object.entries(chatStates)) {
          if (
            wc.activeTabId === chatId &&
            wc.tabs.some((tab) => tab.id === chatId)
          ) {
            const { projectId, worktreeId } = splitWorktreeKey(key);
            useChatStore
              .getState()
              .switchTab(chatId, { projectId, worktreeId });
            break;
          }
        }
      }
    }
    useChatStore.getState().setHiddenChatTabIds(hiddenNow);
    lastHiddenChatTabIds = hiddenNow;

    // Drop replacement-close suppressions whose chat has left the store (its
    // async archive/close resolved), so the guard never outlives the tab.
    if (chatTabsAwaitingReplacementClose.size > 0) {
      const liveChatTabIds = new Set<string>();
      for (const wc of Object.values(useChatStore.getState().worktreeChats)) {
        for (const tab of wc.tabs) {
          liveChatTabIds.add(tab.id);
        }
      }
      for (const chatTabId of Array.from(
        chatTabsAwaitingReplacementClose.keys(),
      )) {
        if (!liveChatTabIds.has(chatTabId)) {
          releaseReplacementCloseSuppression(chatTabId);
        }
      }
    }

    // Settled binding snapshot (post-mutation) so nothing echoes next sweep.
    lastFamilyBindings = collectBindingsByOwner(
      usePanelLayoutStore.getState().layouts,
    );
  } finally {
    syncing = false;
  }
}

function scheduleSweep(): void {
  if (syncing || pendingSweep) {
    return;
  }
  pendingSweep = true;
  queueMicrotask((): void => {
    if (!pendingSweep) {
      return;
    }
    pendingSweep = false;
    runSweep();
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Installs the bidirectional bridge (idempotent; called from WorktreePart
 * like the persistence bridge) and schedules the initial reconcile so the
 * hydrated selected worktree's per-tab panels materialize.
 */
export function initChatPanelSync(): void {
  if (installed) {
    return;
  }
  installed = true;
  installPanelTabCloseGuard();

  let previousChatChats = useChatStore.getState().worktreeChats;
  let previousChatSelection = useChatStore.getState().selectedWorktree;
  let previousClosingChatTabs = useChatStore.getState().closingChatTabs;
  unsubscribeChat = useChatStore.subscribe((state) => {
    const chatsChanged = state.worktreeChats !== previousChatChats;
    const selectionChanged = state.selectedWorktree !== previousChatSelection;
    const closingTabsChanged =
      state.closingChatTabs !== previousClosingChatTabs;
    previousChatChats = state.worktreeChats;
    previousChatSelection = state.selectedWorktree;
    previousClosingChatTabs = state.closingChatTabs;
    if (!syncing && (chatsChanged || selectionChanged || closingTabsChanged)) {
      scheduleSweep();
    }
  });

  let previousLayouts = usePanelLayoutStore.getState().layouts;
  unsubscribePanels = usePanelLayoutStore.subscribe((state) => {
    const layoutsChanged = state.layouts !== previousLayouts;
    previousLayouts = state.layouts;
    if (!syncing && layoutsChanged) {
      scheduleSweep();
    }
  });

  scheduleSweep();
}

/**
 * Registers a mounted panel-grid owner with the bidirectional bridge.
 *
 * Every grid installs the bridge, but only a page-like overlay is tracked as
 * an owner. An ordinary grid must be keyed by `selectedWorktree` (or by the
 * selection it is about to become); the bridge reconciles it through the
 * selection and sweeps on install and on every selection change, so a grid
 * mounted for an owner that is never selected is never reconciled.
 * Ref-counting keeps nested/remounted overlay hosts from unregistering one
 * another.
 */
export function registerChatPanelSyncOwner(worktreeKey: string): () => void {
  initChatPanelSync();
  if (!reconcilesAsMountedOwner(splitWorktreeKey(worktreeKey).projectId)) {
    return (): void => undefined;
  }
  mountedOwnerRefCounts.set(
    worktreeKey,
    (mountedOwnerRefCounts.get(worktreeKey) ?? 0) + 1,
  );
  scheduleSweep();
  let disposed = false;
  return (): void => {
    if (disposed) return;
    disposed = true;
    const remaining = (mountedOwnerRefCounts.get(worktreeKey) ?? 1) - 1;
    if (remaining > 0) mountedOwnerRefCounts.set(worktreeKey, remaining);
    else mountedOwnerRefCounts.delete(worktreeKey);
  };
}

/**
 * The worktree keys this bridge reconciles right now: the selected worktree
 * plus every registered page-like overlay owner (see
 * {@link registerChatPanelSyncOwner}). Other bridges that reconcile panel
 * content against a worktree's data (plan panels) use the same owner set.
 */
export function getChatPanelSyncOwnerKeys(): string[] {
  const keys = new Set<string>();
  const selected = useChatStore.getState().selectedWorktree;
  if (selected) {
    keys.add(`${selected.projectId}/${selected.worktreeId}`);
  }
  for (const worktreeKey of Array.from(mountedOwnerRefCounts.keys())) {
    keys.add(worktreeKey);
  }
  return Array.from(keys);
}

export function requestFilePanelPlacementBesideChat(
  fileTabId: string,
  originChatTabId: string,
): void {
  pendingFilePanelPlacements.set(fileTabId, {
    kind: 'beside-chat',
    originChatTabId,
  });
  scheduleSweep();
}

/**
 * One-shot hint: place `fileTabId`'s freshly materialized panel as a SIBLING
 * of `originFileTabId`'s panel (same group, directly after it). Used by
 * opens initiated from within a file tab — its embedded tree or breadcrumb.
 * A no-op for files that are already open (their panel exists, so the hint
 * is dropped and the tab is only activated).
 */
export function requestFilePanelPlacementAsSibling(
  fileTabId: string,
  originFileTabId: string,
): void {
  if (fileTabId === originFileTabId) {
    return;
  }
  pendingFilePanelPlacements.set(fileTabId, {
    kind: 'file-sibling',
    originFileTabId,
  });
  scheduleSweep();
}

/**
 * Aggressively co-locates a batch of file tabs in one non-chat sibling group.
 * Unlike the one-shot decorated-file hint, this also moves already-open file
 * panels out of the originating chat group.
 *
 * `activate: false` (background agent presentation) keeps the selected panel
 * of every group and the focused group: no tab is selected, and a panel the
 * user is looking at is never moved out of view.
 */
export function placeFilePanelsBesideChat(
  projectId: string,
  worktreeId: string,
  fileTabIds: readonly string[],
  originChatTabId: string,
  options?: { activate?: boolean },
): string | null {
  const activate = options?.activate !== false;
  if (fileTabIds.length === 0) return null;
  for (const fileTabId of fileTabIds) {
    pendingFilePanelPlacements.set(fileTabId, {
      kind: 'beside-chat',
      originChatTabId,
    });
  }
  if (pendingSweep) {
    pendingSweep = false;
    runSweep();
  }

  const worktreeKey = `${projectId}/${worktreeId}`;
  const origin = findPanelByInstanceKey(worktreeKey, `chat:${originChatTabId}`);
  const store = usePanelLayoutStore.getState();
  const firstFile = findPanelByInstanceKey(
    worktreeKey,
    `file-diff:${fileTabIds[0]}`,
  );
  const layoutKey = origin?.layoutKey ?? firstFile?.layoutKey;
  if (!layoutKey) return null;
  const layout = store.layouts[layoutKey];
  if (!layout) return null;
  // Background tabs are materialized non-activating by the sweep above.
  // Existing panels stay where the user placed them: movePanel and splitGroup
  // both publish activation and cannot be used then undone without flicker.
  if (!activate) return firstFile?.groupId ?? null;

  let targetGroupId = origin
    ? pickReusableChatSiblingGroupId(layout, origin.groupId)
    : firstFile?.groupId;
  let createdGroup: ReturnType<typeof createChatSiblingGroupToRight> = null;
  if (!targetGroupId && origin) {
    createdGroup = createChatSiblingGroupToRight(layoutKey, origin.groupId);
    targetGroupId = createdGroup?.groupId;
  }
  if (!targetGroupId) return null;
  let placedPanelCount = 0;
  for (const fileTabId of fileTabIds) {
    const panel = findPanelByInstanceKey(worktreeKey, `file-diff:${fileTabId}`);
    if (!panel || panel.layoutKey !== layoutKey) continue;
    if (panel.groupId !== targetGroupId) {
      if (!store.movePanel(layoutKey, panel.panelId, targetGroupId, 'center')) {
        continue;
      }
    }
    const placed = findPanelByInstanceKey(
      worktreeKey,
      `file-diff:${fileTabId}`,
    );
    if (placed?.layoutKey !== layoutKey || placed.groupId !== targetGroupId) {
      continue;
    }
    placedPanelCount += 1;
    const current =
      usePanelLayoutStore.getState().layouts[layoutKey]?.groups[targetGroupId];
    if (current) {
      store.reorderTab(
        layoutKey,
        targetGroupId,
        panel.panelId,
        current.tabs.length - 1,
      );
    }
  }

  if (placedPanelCount === 0) {
    if (createdGroup) {
      rollbackCreatedChatSiblingGroup(layoutKey, createdGroup);
    }
    return null;
  }

  const first = findPanelByInstanceKey(
    worktreeKey,
    `file-diff:${fileTabIds[0]}`,
  );
  if (first?.groupId === targetGroupId) {
    store.selectTab(layoutKey, targetGroupId, first.panelId);
  }
  return targetGroupId;
}

/**
 * Forgets a worktree's active-tab history, so its next sweep counts as a
 * first sweep and keeps the selection its restored layout carries. Called when
 * a shared-container viewer closes: the next open loads a layout main may
 * have reset, and a remembered selection would override it.
 */
export function forgetChatPanelSyncWorktree(worktreeKey: string): void {
  lastChatActiveTabId.delete(worktreeKey);
  lastPanelActiveTabId.delete(worktreeKey);
}

/** Test-only: runs a pending (scheduled) sweep synchronously. */
export function flushChatPanelSyncForTests(): void {
  if (!pendingSweep) {
    return;
  }
  pendingSweep = false;
  runSweep();
}

/** Test-only: tears down subscriptions and clears all module state. */
export function resetChatPanelSyncForTests(): void {
  unsubscribeChat?.();
  unsubscribePanels?.();
  unsubscribeChat = null;
  unsubscribePanels = null;
  setPanelTabCloseGuard(undefined);
  installed = false;
  syncing = false;
  pendingSweep = false;
  lastFamilyBindings = new Map();
  lastChatActiveTabId.clear();
  lastPanelActiveTabId.clear();
  lastHiddenChatTabIds = new Set();
  mountedOwnerRefCounts.clear();
  pendingFilePanelPlacements.clear();
  for (const chatTabId of Array.from(chatTabsAwaitingReplacementClose.keys())) {
    releaseReplacementCloseSuppression(chatTabId);
  }
}

// ---------------------------------------------------------------------------
// Content panels (Change Diagram and other non-chat content)
// ---------------------------------------------------------------------------

/** A content panel to open: kind, deterministic panel id, instance, title. */
export type ContentPanelSeed = ChatTabPanelSeed;

/**
 * Where an open was initiated. A file origin places the panel directly after
 * that file's panel; otherwise a chat origin places it in the chat's reusable
 * side group (or a new group to the chat's right). The file origin wins when
 * both are supplied.
 */
export interface ContentPanelOrigin {
  readonly fileTabId?: string;
  readonly chatTabId?: string;
}

/**
 * `auto` runs the origin-driven placement policy; `group` places the panel in
 * one explicit group (Add Panel), in `layoutKey` (the worktree's main layout
 * when omitted), without any fallback.
 */
export type ContentPanelIntent =
  | { readonly kind: 'auto' }
  | {
      readonly kind: 'group';
      readonly groupId: string;
      readonly layoutKey?: string;
    };

export interface OpenContentPanelOptions {
  readonly origin?: ContentPanelOrigin;
  readonly intent?: ContentPanelIntent;
}

/**
 * `revealed`: the panel was already open and was brought into view (never
 * moved). `placed`: a new panel was added and revealed. `unavailable`: the
 * worktree has no panel layout. `failed`: no group accepted the panel.
 */
export type ContentPanelOpenResult =
  | {
      readonly status: 'revealed' | 'placed';
      readonly location: PanelInstanceLocation;
    }
  | { readonly status: 'unavailable' | 'failed' };

type GroupContentPanelIntent = Extract<ContentPanelIntent, { kind: 'group' }>;

/** Reveals an already-open instance of the content panel, if one exists. */
function revealExistingContentPanel(
  worktreeKey: string,
  instanceKey: string,
): ContentPanelOpenResult | null {
  const location = findPanelByInstanceKey(worktreeKey, instanceKey);
  if (location === null) return null;
  revealPanel(location);
  return { status: 'revealed', location };
}

function hasMainPanelLayout(worktreeKey: string): boolean {
  return usePanelLayoutStore.getState().layouts[worktreeKey] !== undefined;
}

/**
 * Adds the content tab to one group with its deterministic id, retrying with
 * a generated id when that id is already taken in the layout family.
 */
function addContentTab(
  layoutKey: string,
  groupId: string,
  seed: ContentPanelSeed,
): string | null {
  const store = usePanelLayoutStore.getState();
  const options = {
    title: seed.title,
    ...(Object.keys(seed.instance).length > 0
      ? { instance: seed.instance }
      : {}),
  };
  return (
    store.addTab(layoutKey, groupId, seed.kind, {
      ...options,
      panelId: seed.panelId,
    }) ?? store.addTab(layoutKey, groupId, seed.kind, options)
  );
}

/** File sibling first, else beside the origin chat; never both. */
function placeContentPanelBesideOrigin(
  worktreeKey: string,
  seed: ContentPanelSeed,
  origin: ContentPanelOrigin | undefined,
): string | null {
  if (origin?.fileTabId) {
    return materializeFilePanelAsSibling(
      worktreeKey,
      seed,
      origin.fileTabId,
      true,
    );
  }
  if (origin?.chatTabId) {
    return materializeContentBesideChat(
      worktreeKey,
      seed,
      origin.chatTabId,
      true,
    );
  }
  return null;
}

/**
 * The `auto` policy: beside the origin, else the Minimal Side Panel or the
 * Advanced chat group chosen from the layout as it stands after any
 * rolled-back origin attempt.
 */
function placeContentPanelAutomatically(
  worktreeKey: string,
  seed: ContentPanelSeed,
  origin: ContentPanelOrigin | undefined,
): string | null {
  const besideOrigin = placeContentPanelBesideOrigin(worktreeKey, seed, origin);
  if (besideOrigin !== null) return besideOrigin;
  const layout = usePanelLayoutStore.getState().layouts[worktreeKey];
  if (layout === undefined) return null;
  const groupId =
    getWorkspaceLayoutMode(worktreeKey) === 'minimal'
      ? ensureMinimalDestination(worktreeKey, 'file-diff')
      : pickContentTargetGroupId(layout);
  return groupId === null ? null : addContentTab(worktreeKey, groupId, seed);
}

/** The `group` policy: exactly the requested group of the worktree's family. */
function placeContentPanelInGroup(
  worktreeKey: string,
  seed: ContentPanelSeed,
  intent: GroupContentPanelIntent,
): string | null {
  const layoutKey = intent.layoutKey ?? worktreeKey;
  const inFamily =
    layoutKey === worktreeKey ||
    getAuxPanelLayoutOwnerKey(layoutKey) === worktreeKey;
  return inFamily ? addContentTab(layoutKey, intent.groupId, seed) : null;
}

/**
 * Opens a content panel in a worktree's panel grid. An already-open instance
 * (anywhere in the layout family) is revealed in place; otherwise the panel
 * is placed per `intent` (default `auto`) and revealed. Revealing exits a
 * maximize held by another group, expands a collapsed group, and focuses the
 * auxiliary window that hosts the panel.
 */
export async function openContentPanel(
  worktreeKey: string,
  seed: ContentPanelSeed,
  options: OpenContentPanelOptions = {},
): Promise<ContentPanelOpenResult> {
  const instanceKey = getPanelInstanceKey(seed);
  const existing = revealExistingContentPanel(worktreeKey, instanceKey);
  if (existing !== null) return existing;
  if (!hasMainPanelLayout(worktreeKey)) {
    await ensureWorktreePanelLayout(worktreeKey);
    const hydrated = revealExistingContentPanel(worktreeKey, instanceKey);
    if (hydrated !== null) return hydrated;
    if (!hasMainPanelLayout(worktreeKey)) return { status: 'unavailable' };
  }
  const intent: ContentPanelIntent = options.intent ?? { kind: 'auto' };
  const panelId =
    intent.kind === 'group'
      ? placeContentPanelInGroup(worktreeKey, seed, intent)
      : placeContentPanelAutomatically(worktreeKey, seed, options.origin);
  const location =
    panelId === null ? null : findPanelLocation(worktreeKey, panelId);
  if (location === null) return { status: 'failed' };
  revealPanel(location);
  return { status: 'placed', location };
}

export interface ContentPanelPlacementRequest {
  /** The OWNING worktree layout key; the whole family is searched. */
  readonly worktreeKey: string;
  /** The tab to create when none is open. Its instance key is the identity. */
  readonly seed: ContentPanelSeed;
  readonly origin?: ContentPanelOrigin;
  /**
   * Surfaces an already-open tab. Defaults to {@link revealPanel}. Whatever
   * it does, the helper itself never moves an existing tab.
   */
  readonly revealExisting?: (location: PanelInstanceLocation) => void;
}

export type ContentPanelPlacementResult =
  | { readonly outcome: 'revealed'; readonly location: PanelInstanceLocation }
  | { readonly outcome: 'placed'; readonly location: PanelInstanceLocation }
  | { readonly outcome: 'unavailable' };

/**
 * The `auto` placement of {@link openContentPanel} for callers that own the
 * reveal: an open tab anywhere in the owner's layout family is handed to
 * `revealExisting` (never moved), and a newly placed tab is returned
 * unrevealed. Pipeline runs use this so a superseded open never surfaces a
 * stale run. Nothing here reaches outside `worktreeKey`'s own family.
 */
export async function placeOrRevealContentPanel(
  request: ContentPanelPlacementRequest,
): Promise<ContentPanelPlacementResult> {
  const { worktreeKey, seed, origin } = request;
  const revealExisting = request.revealExisting ?? revealPanel;
  const instanceKey = getPanelInstanceKey(seed);
  let existing = findPanelByInstanceKey(worktreeKey, instanceKey);
  if (existing === null && !hasMainPanelLayout(worktreeKey)) {
    await ensureWorktreePanelLayout(worktreeKey);
    existing = findPanelByInstanceKey(worktreeKey, instanceKey);
  }
  if (existing !== null) {
    revealExisting(existing);
    return { outcome: 'revealed', location: existing };
  }
  if (!hasMainPanelLayout(worktreeKey)) return { outcome: 'unavailable' };
  const panelId = placeContentPanelAutomatically(worktreeKey, seed, origin);
  const location =
    panelId === null ? null : findPanelLocation(worktreeKey, panelId);
  return location === null
    ? { outcome: 'unavailable' }
    : { outcome: 'placed', location };
}

/** Standalone review content uses precisely the same placement primitives as files. */
export async function openChangeDiagram(
  worktreeKey: string,
  origin?: ContentPanelOrigin,
): Promise<void> {
  await openContentPanel(
    worktreeKey,
    {
      kind: 'change-diagram',
      panelId: `change-diagram-${worktreeKey}`,
      title: 'Change Diagram',
      instance: {},
    },
    origin ? { origin } : {},
  );
}
