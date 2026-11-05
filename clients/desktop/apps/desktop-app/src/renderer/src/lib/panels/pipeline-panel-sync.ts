/**
 * Pipeline run panel ⇄ session UI state lifecycle.
 *
 * Translates a CLOSED `pipeline-execution` tab into releasing that panel's
 * session UI state (`stores/pipelinePanelUiStore.ts`). Modeled on
 * `browser-panel-sync`: one out-of-store subscription to committed
 * panel-layout changes, coalesced to one microtask sweep, comparing bound
 * panels per OWNER worktree only when that owner's layout family existed
 * both before and after the mutation.
 *
 * - A worktree switch, layout-cache eviction, or `disposeLayout` removes the
 *   whole family; that is teardown, not closing, and releases nothing (the
 *   panel's place in its run survives the switch).
 * - Move, reorder, pin, collapse, maximize, pull-out, merge-back, and tab
 *   switches keep the panel in its family and release nothing. Multi-commit
 *   grid operations coalesce into one sweep.
 * - A panel id present before and missing after was closed (any source), so
 *   its state is released. Closing never touches the run itself.
 *
 * Owner removal (worktree archive/delete, Work Entry archive/delete) calls
 * `releasePipelinePanelUiForOwner` at those boundaries; a layout reset
 * reconciles through {@link releaseOmittedPipelinePanelUi}.
 */
import {
  getAuxPanelLayoutOwnerKey,
  usePanelLayoutStore,
  type WorktreePanelLayout,
} from '@/stores/panelLayoutStore';
import {
  listPipelinePanelUiKeysForOwner,
  pipelinePanelUiKey,
  releasePipelinePanelUi,
} from '@/stores/pipelinePanelUiStore';

let installed = false;
let syncing = false;
let pendingSweep = false;
let unsubscribePanels: (() => void) | null = null;

/** Pipeline panel ids per owner key at the end of the last sweep. */
let lastPipelinePanels = new Map<string, Set<string>>();

function collectPipelinePanelsByOwner(
  layouts: Record<string, WorktreePanelLayout>,
): Map<string, Set<string>> {
  const byOwner = new Map<string, Set<string>>();
  for (const [layoutKey, layout] of Object.entries(layouts)) {
    const ownerKey = getAuxPanelLayoutOwnerKey(layoutKey) ?? layoutKey;
    let panels = byOwner.get(ownerKey);
    if (!panels) {
      panels = new Set<string>();
      byOwner.set(ownerKey, panels);
    }
    for (const group of Object.values(layout.groups)) {
      for (const tab of group.tabs) {
        if (tab.kind === 'pipeline-execution') panels.add(tab.panelId);
      }
    }
  }
  return byOwner;
}

function runSweep(): void {
  syncing = true;
  try {
    const now = collectPipelinePanelsByOwner(
      usePanelLayoutStore.getState().layouts,
    );
    for (const [ownerKey, previous] of Array.from(
      lastPipelinePanels.entries(),
    )) {
      const current = now.get(ownerKey);
      // The whole family is gone: teardown (switch/eviction/dispose), not a
      // close. Keep the state.
      if (current === undefined) continue;
      for (const panelId of Array.from(previous)) {
        if (!current.has(panelId)) {
          releasePipelinePanelUi(pipelinePanelUiKey(ownerKey, panelId));
        }
      }
    }
    lastPipelinePanels = now;
  } finally {
    syncing = false;
  }
}

function scheduleSweep(): void {
  if (syncing || pendingSweep) return;
  pendingSweep = true;
  queueMicrotask((): void => {
    if (!pendingSweep) return;
    pendingSweep = false;
    runSweep();
  });
}

/**
 * Releases state for `ownerKey`'s panels that its current layout family no
 * longer hosts. For rebuilds that replace a family wholesale (layout reset),
 * which the diff sweep deliberately treats as teardown. Does nothing when the
 * family is not mounted.
 */
export function releaseOmittedPipelinePanelUi(ownerKey: string): void {
  const hosted = collectPipelinePanelsByOwner(
    usePanelLayoutStore.getState().layouts,
  ).get(ownerKey);
  if (hosted === undefined) return;
  const prefix = `${ownerKey}::`;
  for (const key of listPipelinePanelUiKeysForOwner(ownerKey)) {
    if (!hosted.has(key.slice(prefix.length))) releasePipelinePanelUi(key);
  }
}

/**
 * Installs the lifecycle subscription (idempotent; called from
 * `PanelGridSurface` beside the chat and browser bridges).
 */
export function initPipelinePanelSync(): void {
  if (installed) return;
  installed = true;
  lastPipelinePanels = collectPipelinePanelsByOwner(
    usePanelLayoutStore.getState().layouts,
  );
  let previousLayouts = usePanelLayoutStore.getState().layouts;
  unsubscribePanels = usePanelLayoutStore.subscribe((state) => {
    const layoutsChanged = state.layouts !== previousLayouts;
    previousLayouts = state.layouts;
    if (!syncing && layoutsChanged) scheduleSweep();
  });
}

/** Test-only: tears down the subscription and clears module state. */
export function resetPipelinePanelSyncForTests(): void {
  unsubscribePanels?.();
  unsubscribePanels = null;
  installed = false;
  syncing = false;
  pendingSweep = false;
  lastPipelinePanels = new Map();
}
