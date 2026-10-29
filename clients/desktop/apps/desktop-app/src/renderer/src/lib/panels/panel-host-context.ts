/**
 * Page-shell state threaded to panel content wrappers.
 *
 * The worktree view mode (list/kanban) and its readiness flag are
 * WorktreeManager component-local state (loaded from preferences), not store
 * state, so the panel registry cannot read them from a store hook. The
 * `WorktreePart` grid host provides this context around `PanelGridHost`;
 * registry wrappers (`chat`, `activity-section`) read it instead of the old
 * `'list'`/ready constants. React context flows through the host's portals,
 * so every panel content subtree sees the provided value.
 *
 * The default value keeps out-of-tree consumers (tests rendering registry
 * wrappers directly) on the previous constant behavior.
 *
 * Host state is per layout: `PanelContentRoot` gives auxiliary-window
 * layouts `auxPanelHostState(hostState)`, so `visible` describes the page
 * that actually shows the panel (the main page for the main layout, the aux
 * window itself for a popped-out one).
 */
export {
  auxPanelHostState,
  DEFAULT_PANEL_HOST_STATE,
  PanelHostContext,
  usePanelHostState,
  type PanelHostState,
} from '@canopy/ui-app/panel-contexts';
