/**
 * Context-aware Cmd/Ctrl+T dispatch (ECW-7984).
 *
 * "New tab" means a new tab of the focused surface's own type, not always a
 * chat tab. The pure surface-resolution rule lives in `newTabSurface.ts`;
 * this module owns the store-aware dispatch for the panel-grid hosts (Code
 * worktrees, Cowork work entries, and the App Advisor window all render the
 * same grid).
 *
 * Chords pressed while the NATIVE browser page owns keyboard focus never
 * reach the renderer; those are routed by the main process
 * (`main/browser/browser-shortcuts.ts`) and arrive as `browser:event`
 * `shortcut` events instead (`browserEventSubscription`).
 */
import { ensureTerminalPanelVisible } from '@/lib/panels/terminal-panel-activation';
import { requestBrowserUrlFocus } from '@/lib/browserUrlFocus';
import { requestTerminalSpawn } from '@/lib/terminalSpawnRequests';
import { registerPendingBrowserActivation } from '@/lib/panels/browser-panel-activation';
import { browserPanelIdFor } from '@/lib/panels/browser-panel-identity';
import { ensureMinimalDestination } from '@/lib/panels/minimal-layout';
import {
  resolveNewTabSurface,
  type NewTabSurfaceKind,
} from '@/lib/newTabSurface';
import { isInAppBrowserAvailable } from '@/lib/remote-control/in-app-browser-availability';
import { useBrowserStore } from '@/stores/browserStore';
import { getWorkspaceLayoutMode } from '@/stores/workspaceLayoutModeStore';
import {
  getPanelLayoutViewModel,
  makeWorktreePanelKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';

export type { NewTabSurfaceKind } from '@/lib/newTabSurface';

/** The active (selected) panel of the focused group in a layout. */
export interface ActivePanelInfo {
  readonly groupId: string;
  readonly panelId: string;
  readonly kind: string;
}

/**
 * The active (selected) panel of the focused group in `panelKey`'s layout, or
 * null when the layout does not exist (worktree not open in a grid) or the
 * focused group has no selected panel.
 */
export function getActivePanel(panelKey: string): ActivePanelInfo | null {
  const viewModel = getPanelLayoutViewModel(panelKey);
  if (viewModel === null || viewModel.activeGroupId === null) {
    return null;
  }
  const activeGroup = viewModel.groups.find(
    (group) => group.groupId === viewModel.activeGroupId,
  );
  if (!activeGroup || activeGroup.activePanelId === null) {
    return null;
  }
  const activeTab = activeGroup.tabs.find(
    (tab) => tab.panelId === activeGroup.activePanelId,
  );
  if (!activeTab) {
    return null;
  }
  return {
    groupId: activeGroup.groupId,
    panelId: activeTab.panelId,
    kind: activeTab.kind,
  };
}

/**
 * The active panel kind of the focused group in `panelKey`'s layout, or null
 * when the layout does not exist (worktree not open in a grid).
 */
export function getActivePanelKind(panelKey: string): string | null {
  return getActivePanel(panelKey)?.kind ?? null;
}

export interface RunNewTabShortcutParams {
  projectId: string;
  worktreeId: string;
  /**
   * Concrete layout that owns the chord. Defaults to the worktree's main
   * layout; auxiliary windows pass their own layout key.
   */
  layoutKey?: string;
  /** The keydown event target, for focus-based surface resolution. */
  target: EventTarget | null;
  /**
   * Surface-specific chat-tab creator (Code worktrees use
   * `chatStore.createTab()`; Cowork/App Advisor use the standalone store's
   * `startNewChat()` so empty-tab reuse and archive-overlay state stay
   * consistent with their own "new chat" buttons).
   */
  createChatTab: () => void;
}

async function createBrowserPanel(
  projectId: string,
  worktreeId: string,
  panelKey: string,
): Promise<void> {
  const worktreeKey = makeWorktreePanelKey(projectId, worktreeId);
  const minimal = getWorkspaceLayoutMode(worktreeKey) === 'minimal';
  const destinationKey = minimal ? worktreeKey : panelKey;
  const groupId = minimal
    ? ensureMinimalDestination(worktreeKey, 'browser')
    : (getPanelLayoutViewModel(panelKey)?.activeGroupId ?? null);
  // Placed and focused at once; the session is created in the background.
  const opened = useBrowserStore.getState().openBrowser(projectId, worktreeId);
  if (opened === null) {
    return;
  }
  const { browserId } = opened;
  const release = registerPendingBrowserActivation(browserId);
  let panelId: string | null = null;
  try {
    panelId =
      groupId === null
        ? null
        : (usePanelLayoutStore
            .getState()
            .addTab(destinationKey, groupId, 'browser', {
              panelId: browserPanelIdFor(browserId),
              instance: { browserId },
            }) ??
          usePanelLayoutStore
            .getState()
            .addTab(destinationKey, groupId, 'browser', {
              instance: { browserId },
            }));
  } finally {
    release();
  }
  if (panelId === null) {
    const { discardOpenedBrowser } =
      await import('@/lib/panels/browser-panel-sync');
    await discardOpenedBrowser(projectId, worktreeId, browserId);
    return;
  }
  void useBrowserStore
    .getState()
    .setActiveBrowser(projectId, worktreeId, browserId);
  requestBrowserUrlFocus(browserId);
}

/**
 * Resolves the focused surface for a panel-grid host and creates that
 * surface's tab type. Returns the resolved surface kind (for tests).
 */
export function runNewTabShortcut(
  params: RunNewTabShortcutParams,
): NewTabSurfaceKind {
  const { projectId, worktreeId, target, createChatTab } = params;
  const worktreeKey = makeWorktreePanelKey(projectId, worktreeId);
  const panelKey = params.layoutKey ?? worktreeKey;
  const resolved = resolveNewTabSurface({
    target,
    activePanelKind: getActivePanelKind(panelKey),
  });
  // A window that shows another computer cannot open a Browser tab: the
  // chord falls back to the surface's primary tab type, as elsewhere.
  const surface =
    resolved === 'browser' && !isInAppBrowserAvailable() ? 'chat' : resolved;

  if (surface === 'terminal') {
    // Keep the terminal panel visible/focused, then ask the mounted surface
    // to spawn (PTY spawn sizing is component-local — see
    // `terminalSpawnRequests`).
    const viewModel = getPanelLayoutViewModel(panelKey);
    const source =
      params.layoutKey !== undefined &&
      viewModel !== null &&
      viewModel.activeGroupId !== null
        ? {
            layoutKey: panelKey,
            groupId: viewModel.activeGroupId,
          }
        : undefined;
    ensureTerminalPanelVisible(worktreeKey, source);
    requestTerminalSpawn({
      projectId,
      worktreeId,
      layoutKey: panelKey,
      mode: 'new-tab',
    });
    return surface;
  }

  if (surface === 'browser') {
    // Exactly one bound Browser panel in the current worktree context,
    // selected with its address bar focused. Activation failure rolls back
    // only the freshly-created backend session.
    void createBrowserPanel(projectId, worktreeId, panelKey).catch(
      () => undefined,
    );
    return surface;
  }

  createChatTab();
  return surface;
}
