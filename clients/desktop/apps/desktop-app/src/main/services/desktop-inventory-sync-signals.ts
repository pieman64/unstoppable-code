/**
 * Dependency-free change signal for the desktop inventory sync (CAN-2830).
 *
 * Persistence choke points that are NOT covered by the invocable-inventory
 * rebuild (Collections and MCP server index writes) call
 * {@link notifyDesktopInventoryChanged} after a durable write; the sync
 * service subscribes at start. Kept import-free so any store can signal
 * without pulling the cloud client or catalog readers into its module graph.
 */
import type { DesktopInventoryKind } from '@canopy/protocol/desktop-inventory';

type Listener = (kinds: readonly DesktopInventoryKind[]) => void;

const listeners = new Set<Listener>();

export function subscribeDesktopInventoryChanges(
  listener: Listener,
): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

/**
 * Announce that the desktop-side source of `kinds` changed. Never throws: a
 * listener failure must not fail the persistence write that triggered it.
 */
export function notifyDesktopInventoryChanged(
  kinds: readonly DesktopInventoryKind[],
): void {
  listeners.forEach((listener): void => {
    try {
      listener(kinds);
    } catch {
      // Observational only; see the doc comment.
    }
  });
}
