/**
 * Context-aware Cmd/Ctrl+W dispatch (ECW-7984).
 *
 * "Close tab" closes the FOCUSED surface's active panel exactly the way that
 * panel's tab-strip "X" button does — through the shared `closePanelTab` path.
 * A browser session, terminal PTY, or chat tab therefore all tear down
 * identically to a manual close, including chat's last-panel replacement and
 * its refusal to close a busy chat (streaming / queued / pending-plan-exit, or
 * with live managed delegates — that refusal shows a notice saying why).
 *
 * Before this the chord was surface-blind: it always closed the chat panel's
 * active tab even while a browser or terminal panel was focused, so closing
 * "the current tab" from a browser silently closed a chat tab instead.
 *
 * The active panel of the focused group IS the focused surface — focusing a
 * panel activates its group and selects the panel — so closing it matches
 * clicking that panel's "X". A no-op when the worktree has no panel layout.
 *
 * Chords pressed while the NATIVE browser page owns keyboard focus never reach
 * the renderer; main forwards them as a `close-tab` shortcut browser event,
 * which `stores/browserEventSubscription.ts` handles.
 */
import { getActivePanel, type ActivePanelInfo } from '@/lib/newTabShortcut';
import { closePanelTab } from '@/lib/panels/chat-panel-sync';
import { isLastTabOfFixedGroup } from '@/lib/panels/fixed-group-close';
import {
  getPanelLayoutViewModel,
  makeWorktreePanelKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { getWorkspaceLayoutMode } from '@/stores/workspaceLayoutModeStore';

export interface RunCloseTabShortcutParams {
  projectId: string;
  worktreeId: string;
  /**
   * Concrete layout that owns the chord. Defaults to the worktree's main
   * layout; auxiliary windows pass their own layout key.
   */
  layoutKey?: string;
}

/**
 * Closes the focused surface's active panel through the canonical panel-close
 * path (the same one the tab-strip "X" button uses) and returns the closed
 * panel's kind — for tests — or null when there is no active panel to close.
 */
export function runCloseTabShortcut(
  params: RunCloseTabShortcutParams,
): string | null {
  const panelKey =
    params.layoutKey ??
    makeWorktreePanelKey(params.projectId, params.worktreeId);
  const activePanel = getActivePanel(panelKey);
  if (activePanel === null) {
    return null;
  }
  closePanelTab(panelKey, activePanel.groupId, activePanel.panelId);
  return activePanel.kind;
}

/**
 * Whether ⌘/Ctrl+W has a tab to close in this layout: the focused group's
 * active panel, unless it is the layout's only chat panel (whose "X" would
 * merely replace it with a fresh chat). Hosts that otherwise hide themselves
 * on the chord (App Advisor, CAN-3952) use this to choose between closing a
 * tab and hiding.
 *
 * Only chat panels count, across every group including collapsed ones and
 * the Side Panel: Minimal layout seeds Activity and File explorer tabs that
 * must not make a lone chat look closable. Only this layout counts: a chat in
 * an auxiliary layout does not make its lone chat closable, so the chord
 * hides rather than closing it, which errs toward never archiving.
 *
 * A tab Minimal's fixed topology keeps open (the store refuses its close and
 * the grid shows no "X") has nothing to close either.
 */
export function hasCloseableTabForShortcut(
  params: RunCloseTabShortcutParams,
): boolean {
  const panelKey =
    params.layoutKey ??
    makeWorktreePanelKey(params.projectId, params.worktreeId);
  const activePanel = getActivePanel(panelKey);
  if (activePanel === null) {
    return false;
  }
  if (isKeptOpenByFixedTopology(panelKey, activePanel)) {
    return false;
  }
  if (activePanel.kind !== 'chat') {
    return true;
  }
  const viewModel = getPanelLayoutViewModel(panelKey);
  if (viewModel === null) {
    return false;
  }
  let chatPanels = 0;
  for (const group of viewModel.groups) {
    for (const tab of group.tabs) {
      if (tab.kind === 'chat') {
        chatPanels += 1;
      }
    }
  }
  return chatPanels > 1;
}

/**
 * Whether the panel layout store refuses to close this tab under Minimal's
 * fixed topology: Activity and File explorer unless early access lets the Side
 * Panel empty, and the only tab of a group Minimal keeps.
 */
function isKeptOpenByFixedTopology(
  panelKey: string,
  activePanel: ActivePanelInfo,
): boolean {
  if (getWorkspaceLayoutMode(panelKey) !== 'minimal') {
    return false;
  }

  // The store refuses this close with or without early access, though the
  // grid hides its "X" only under early access.
  return isLastTabOfFixedGroup(
    usePanelLayoutStore.getState().layouts[panelKey]?.groups,
    activePanel.panelId,
  );
}
