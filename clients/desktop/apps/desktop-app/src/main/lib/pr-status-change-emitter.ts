import type { WorktreePrStatus } from '@canopy/desktop-shared/types/github';

/**
 * Dependency-inverted hook fired whenever a worktree's persisted PR status
 * changes. Lives in its own leaf module (depending only on shared types) so the
 * telemetry-sync service (CAN-402) can subscribe without importing
 * `github-poller` — which would create an import cycle back through
 * `session-manager` / `hook-chat`.
 *
 * `github-poller` is the sole emitter; subscribers register here.
 */
export type WorktreePrStatusChangeListener = (event: {
  projectId: string;
  worktreeId: string;
  status: WorktreePrStatus | null;
}) => void;

const listeners = new Set<WorktreePrStatusChangeListener>();

export function addWorktreePrStatusChangeListener(
  fn: WorktreePrStatusChangeListener,
): void {
  listeners.add(fn);
}

export function removeWorktreePrStatusChangeListener(
  fn: WorktreePrStatusChangeListener,
): void {
  listeners.delete(fn);
}

export function emitWorktreePrStatusChange(
  projectId: string,
  worktreeId: string,
  status: WorktreePrStatus | null,
): void {
  listeners.forEach((listener) => {
    try {
      listener({ projectId, worktreeId, status });
    } catch {
      // Listener failures must not disrupt GitHub polling/persistence.
    }
  });
}
