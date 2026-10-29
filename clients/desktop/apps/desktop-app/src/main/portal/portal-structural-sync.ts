/**
 * Desktop → portal push for structural sidebar mutations (CAN-1304).
 *
 * The portal delta stream is fed by feature services (`portal.script.event`,
 * `portal.chat.event`, …), but nothing observed workspace/worktree persistence:
 * a desktop-initiated worktree create/archive or workspace mutation only
 * reached the browser after the browser's own next `portal.state.request`.
 * This module is the single shared notify mechanism: the persistence/service
 * choke points (`writeWorkspaceWorktreesFile`, `writeWorkspaceIndexEntries`,
 * `deleteWorkspaceById`) call {@link schedulePortalStructuralSync} after every
 * durable structural write, so BOTH initiators (desktop UI and portal
 * adapters) are covered by one mechanism.
 *
 * The push is a fresh `overview`-scope `portal.state.snapshot` — the same
 * payload the browser requests after its own commands, applied server-side by
 * replacing only overview-scope entity types — so a duplicate push after a
 * portal-initiated mutation is idempotent. Snapshot events never make the
 * browser issue commands back, so there is no ping-pong loop; bursts (e.g.
 * multi-repo creates, PR-split writes) coalesce through a trailing debounce,
 * and the push itself is single-flight with every other overview build.
 */
import {
  isCanopyPortalActive,
  pushPortalOverviewSnapshot,
} from './portal-event-bus';
import { scheduleDesktopSessionSnapshotInvalidation } from '../services/desktop-session-snapshot-invalidation';
import { notifyDesktopInventoryChanged } from '../services/desktop-inventory-sync-signals';

/**
 * Trailing-debounce window before building the overview snapshot. Mirrors the
 * renderer's `WORKSPACE_WORKTREES_RELOAD_DEBOUNCE_MS` coalescing (400ms) so a
 * burst of persistence writes produces one push, not one per write.
 */
const PORTAL_STRUCTURAL_SYNC_DEBOUNCE_MS = 400;

let syncTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Schedule a debounced overview-snapshot push to the connected portal session.
 * No-op when no portal session is active. Safe to call from any persistence
 * write path — it never throws and never blocks the caller.
 */
export function schedulePortalStructuralSync(): void {
  scheduleDesktopSessionSnapshotInvalidation();
  // Worktree/workspace churn changes which per-worktree pipeline documents
  // exist in the cloud inventory (CAN-2830); the sync service diffs them.
  notifyDesktopInventoryChanged(['pipelines']);
  try {
    if (!isCanopyPortalActive()) {
      return;
    }
    if (syncTimer !== null) {
      clearTimeout(syncTimer);
    }
    syncTimer = setTimeout(() => {
      syncTimer = null;
      pushPortalOverviewSnapshot();
    }, PORTAL_STRUCTURAL_SYNC_DEBOUNCE_MS);
  } catch {
    // A sync scheduling failure must never fail the persistence write that
    // triggered it; the browser recovers via its own `portal.state.request`.
  }
}

/**
 * Cancel any pending debounced push. Called from `cleanupRuntimeResources()`
 * on app shutdown so no timer outlives the Electron app (the fire-time
 * `isCanopyPortalActive()` re-check already makes a stray fire a no-op; this
 * keeps the timer lifecycle consistent with other main-process services).
 */
export function cancelPortalStructuralSync(): void {
  if (syncTimer !== null) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
}
