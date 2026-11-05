/**
 * Browser panel ⇄ session lifecycle coordinator.
 *
 * The single renderer authority translating PERMANENT panel removal into
 * PERMANENT browser-session destruction. Modeled on `chat-panel-sync`:
 * it lives OUTSIDE the stores (the layout store stays a pure grid model and
 * the browser store stays panel-agnostic), installs one out-of-store
 * subscription to committed panel-layout changes, and coalesces to one
 * microtask sweep per committed mutation with a `syncing` guard against
 * recursive store updates.
 *
 * Sweep semantics:
 * - Bindings are compared per OWNER worktree, and only when that worktree's
 *   layout family existed both before and after the committed mutation —
 *   worktree unmount, layout-cache eviction, and `disposeLayout` teardown
 *   remove the whole family and are ignored (layout teardown is not
 *   tab-by-tab closing).
 * - A browser id bound before but missing from the committed layout was
 *   CLOSED (any close source: tab close button, batch Close Others/Right/
 *   Left/All, group close, commands, App Advisor, context menus, test API):
 *   its session is permanently destroyed via the idempotent
 *   `destroyBrowser`.
 * - Move, reorder, pin, collapse, maximize, hide/show, tab switch, and
 *   atomic inter-group transfer keep the binding present in the committed
 *   layout, so sessions are preserved. Multi-commit grid operations coalesce
 *   into one sweep, so intermediate absence is never observed.
 * - Ids mid-activation (`isBrowserActivationPending`) and the migration
 *   recovery placeholder are never destroyed. Closing a recovery placeholder
 *   destroys nothing.
 * - An independent main-process `destroyed` push event removes the matching
 *   panel + local session via {@link handleBrowserDestroyedEvent}; the id is
 *   remembered so the resulting sweep does not re-issue a destroy (no
 *   destroy loop). Shutdown does not emit this event.
 */
import {
  getAuxPanelLayoutOwnerKey,
  usePanelLayoutStore,
  type WorktreePanelLayout,
} from '@/stores/panelLayoutStore';
import {
  findWorktreeKeyForBrowser,
  useBrowserStore,
} from '@/stores/browserStore';
import { isBrowserActivationPending } from './browser-panel-activation';
import { isRecoveryBrowserId } from './browser-panel-identity';

let installed = false;
let syncing = false;
let pendingSweep = false;
let unsubscribePanels: (() => void) | null = null;

/**
 * Bound browser ids per owner worktree key at the END of the last sweep.
 * Ids present here but missing from the live committed layout were closed on
 * the panel side and propagate to permanent session destruction.
 */
let lastBrowserBindings = new Map<string, Set<string>>();

/**
 * Browser ids whose removal was driven by a main-process `destroyed` push
 * event. The next sweep observes their binding disappear and must NOT
 * re-issue a destroy (the session is already gone).
 */
const destroyedByEvent = new Set<string>();

interface PendingBrowserDestruction {
  ownerKey: string;
  browserId: string;
  cancelWhenLayoutMissing: boolean;
  attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
}

/**
 * Material destroy failures must remain retryable after the panel binding is
 * gone. Without this table the settled binding snapshot forgets the close and
 * no future layout mutation necessarily reissues it, leaving an invisible
 * persisted session forever. Retries are exact-ID, idempotent, and back off;
 * rebinding the browser or tearing down the whole layout family cancels them.
 */
const pendingDestructions = new Map<string, PendingBrowserDestruction>();
const DESTRUCTION_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

function destructionKey(ownerKey: string, browserId: string): string {
  return `${ownerKey}\0${browserId}`;
}

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

/** `ownerWorktreeKey → bound browser ids` across every layout family. */
function collectBrowserBindingsByOwner(
  layouts: Record<string, WorktreePanelLayout>,
): Map<string, Set<string>> {
  const byOwner = new Map<string, Set<string>>();
  for (const [layoutKey, layout] of Object.entries(layouts)) {
    const ownerKey = getAuxPanelLayoutOwnerKey(layoutKey) ?? layoutKey;
    let bindings = byOwner.get(ownerKey);
    if (!bindings) {
      bindings = new Set<string>();
      byOwner.set(ownerKey, bindings);
    }
    for (const group of Object.values(layout.groups)) {
      for (const tab of group.tabs) {
        if (tab.kind !== 'browser') {
          continue;
        }
        const browserId = tab.instance?.browserId;
        if (browserId !== undefined && browserId.length > 0) {
          bindings.add(browserId);
        }
      }
    }
  }
  return byOwner;
}

function cancelPendingDestruction(record: PendingBrowserDestruction): void {
  if (record.timer !== null) {
    clearTimeout(record.timer);
  }
  pendingDestructions.delete(destructionKey(record.ownerKey, record.browserId));
}

function attemptBrowserDestruction(record: PendingBrowserDestruction): void {
  if (record.inFlight) {
    return;
  }
  const bindings = collectBrowserBindingsByOwner(
    usePanelLayoutStore.getState().layouts,
  );
  const current = bindings.get(record.ownerKey);
  if (
    (current === undefined && record.cancelWhenLayoutMissing) ||
    current?.has(record.browserId) === true ||
    destroyedByEvent.has(record.browserId) ||
    isRecoveryBrowserId(record.browserId)
  ) {
    cancelPendingDestruction(record);
    return;
  }
  if (isBrowserActivationPending(record.browserId)) {
    scheduleDestructionRetry(record);
    return;
  }

  const { projectId, worktreeId } = splitWorktreeKey(record.ownerKey);
  record.inFlight = true;
  record.timer = null;
  void useBrowserStore
    .getState()
    .destroyBrowser(projectId, worktreeId, record.browserId)
    .then(() => {
      cancelPendingDestruction(record);
    })
    .catch(() => {
      record.inFlight = false;
      record.attempt += 1;
      scheduleDestructionRetry(record);
    });
}

function scheduleDestructionRetry(record: PendingBrowserDestruction): void {
  if (record.timer !== null || record.inFlight) {
    return;
  }
  const delay =
    DESTRUCTION_RETRY_DELAYS_MS[
      Math.min(
        Math.max(record.attempt - 1, 0),
        DESTRUCTION_RETRY_DELAYS_MS.length - 1,
      )
    ];
  record.timer = setTimeout(() => {
    record.timer = null;
    attemptBrowserDestruction(record);
  }, delay);
}

function requestBrowserDestruction(
  ownerKey: string,
  browserId: string,
  cancelWhenLayoutMissing = true,
): void {
  const key = destructionKey(ownerKey, browserId);
  const existing = pendingDestructions.get(key);
  if (existing !== undefined) {
    // A rollback request is stronger than a normal close request: it must
    // keep retrying even when the layout family has not mounted yet.
    existing.cancelWhenLayoutMissing =
      existing.cancelWhenLayoutMissing && cancelWhenLayoutMissing;
    attemptBrowserDestruction(existing);
    return;
  }
  const record: PendingBrowserDestruction = {
    ownerKey,
    browserId,
    cancelWhenLayoutMissing,
    attempt: 0,
    timer: null,
    inFlight: false,
  };
  pendingDestructions.set(key, record);
  attemptBrowserDestruction(record);
}

/**
 * Roll back a freshly-created session that could not be bound to a panel.
 * Uses the same exact-ID retry/backoff path as a normal panel close, so a
 * transient persistence failure cannot strand an invisible session.
 */
export function requestBrowserSessionDestruction(
  projectId: string,
  worktreeId: string,
  browserId: string,
): void {
  requestBrowserDestruction(`${projectId}/${worktreeId}`, browserId, false);
}

/**
 * Removes a session the caller just opened but could not place or keep
 * (renderer-first opens bind their panel before the backend create lands).
 * Destroys the session exact-ID, then removes any bound panel without a
 * second destroy. When destruction fails, closing the bound panel hands the
 * retry to the normal close path; an unbound session gets the rollback retry.
 * Callers must release any pending activation for `browserId` first, or the
 * close sweep would skip it.
 */
export async function discardOpenedBrowser(
  projectId: string,
  worktreeId: string,
  browserId: string,
): Promise<void> {
  try {
    await useBrowserStore
      .getState()
      .destroyBrowser(projectId, worktreeId, browserId);
  } catch {
    if (!closeBoundBrowserPanels(browserId)) {
      requestBrowserSessionDestruction(projectId, worktreeId, browserId);
    }
    return;
  }
  handleBrowserDestroyedEvent(browserId);
}

/** A panel bound to a browser session, located by layout and group. */
export interface BrowserPanelBinding {
  layoutKey: string;
  groupId: string;
  panelId: string;
}

/**
 * Every panel bound to `browserId` across all layout families, including
 * auxiliary (App Advisor) layouts. Tabs not yet bound to a session are
 * skipped.
 */
export function findBrowserPanelBindings(
  browserId: string,
): BrowserPanelBinding[] {
  const bindings: BrowserPanelBinding[] = [];
  for (const [layoutKey, layout] of Object.entries(
    usePanelLayoutStore.getState().layouts,
  )) {
    for (const [groupId, group] of Object.entries(layout.groups)) {
      const tab = group.tabs.find(
        (candidate) =>
          candidate.kind === 'browser' &&
          candidate.instance?.browserId === browserId,
      );
      if (tab !== undefined) {
        bindings.push({ layoutKey, groupId, panelId: tab.panelId });
      }
    }
  }
  return bindings;
}

/** Closes every panel bound to `browserId`; returns whether any existed. */
function closeBoundBrowserPanels(browserId: string): boolean {
  const bindings = findBrowserPanelBindings(browserId);
  for (const { layoutKey, groupId, panelId } of bindings) {
    usePanelLayoutStore.getState().closeTab(layoutKey, groupId, panelId);
  }
  return bindings.length > 0;
}

function runSweep(): void {
  syncing = true;
  try {
    const layouts = usePanelLayoutStore.getState().layouts;
    const bindingsNow = collectBrowserBindingsByOwner(layouts);

    for (const [ownerKey, previous] of Array.from(
      lastBrowserBindings.entries(),
    )) {
      const current = bindingsNow.get(ownerKey);
      if (current === undefined) {
        // The whole family was disposed (worktree unmounted / archived /
        // cache-evicted); that is layout teardown, not closing — leave the
        // sessions alone.
        continue;
      }
      for (const browserId of Array.from(previous)) {
        if (current.has(browserId)) {
          continue;
        }
        if (isRecoveryBrowserId(browserId)) {
          // The migration recovery placeholder binds no real session.
          continue;
        }
        if (isBrowserActivationPending(browserId)) {
          // Mid-activation (e.g. re-inserting after an atomic transfer).
          continue;
        }
        if (destroyedByEvent.delete(browserId)) {
          // Already destroyed by the main process; do not loop.
          continue;
        }
        requestBrowserDestruction(ownerKey, browserId);
      }
    }

    lastBrowserBindings = bindingsNow;
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

/**
 * Handles an independent main-process `destroyed` push event: removes the
 * matching bound panel (when one exists) and the local session mirror, and
 * prevents the resulting sweep from re-issuing a destroy.
 */
export function handleBrowserDestroyedEvent(browserId: string): void {
  for (const record of Array.from(pendingDestructions.values())) {
    if (record.browserId === browserId) {
      cancelPendingDestruction(record);
    }
  }
  const bindings = findBrowserPanelBindings(browserId);
  syncing = true;
  try {
    for (const { layoutKey, groupId, panelId } of bindings) {
      destroyedByEvent.add(browserId);
      usePanelLayoutStore.getState().closeTab(layoutKey, groupId, panelId);
    }
  } finally {
    syncing = false;
  }
  // Refresh the settled binding snapshot so the panel removal above does not
  // read as a user close on the next sweep.
  lastBrowserBindings = collectBrowserBindingsByOwner(
    usePanelLayoutStore.getState().layouts,
  );
  destroyedByEvent.delete(browserId);

  const state = useBrowserStore.getState();
  const worktreeKey = findWorktreeKeyForBrowser(state, browserId);
  if (worktreeKey !== null) {
    const { projectId, worktreeId } = splitWorktreeKey(worktreeKey);
    state.dropBrowserSession(projectId, worktreeId, browserId);
  }
}

/**
 * Installs the lifecycle subscription (idempotent; called from
 * `PanelGridSurface` beside the chat sync bridge) and seeds the binding
 * snapshot from the current committed layouts.
 */
export function initBrowserPanelSync(): void {
  if (installed) {
    return;
  }
  installed = true;

  lastBrowserBindings = collectBrowserBindingsByOwner(
    usePanelLayoutStore.getState().layouts,
  );

  let previousLayouts = usePanelLayoutStore.getState().layouts;
  unsubscribePanels = usePanelLayoutStore.subscribe((state) => {
    const layoutsChanged = state.layouts !== previousLayouts;
    previousLayouts = state.layouts;
    if (!syncing && layoutsChanged) {
      scheduleSweep();
    }
  });
}

/** Test-only: tears down the subscription and clears all module state. */
export function resetBrowserPanelSyncForTests(): void {
  unsubscribePanels?.();
  unsubscribePanels = null;
  installed = false;
  syncing = false;
  pendingSweep = false;
  lastBrowserBindings = new Map();
  destroyedByEvent.clear();
  for (const record of Array.from(pendingDestructions.values())) {
    cancelPendingDestruction(record);
  }
  pendingDestructions.clear();
}
