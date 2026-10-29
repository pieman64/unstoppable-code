import type { McpActivationScope } from '@canopy/protocol/mcp-servers';

const listeners = new Set<(scope: McpActivationScope) => void>();
const pending = new Map<string, McpActivationScope>();
let scheduled = false;

/** Invalidation only: subscribers re-read the current owning session. */
export function publishMcpActivationChanged(scope: McpActivationScope): void {
  if (listeners.size === 0) return;
  pending.set(
    JSON.stringify([scope.projectId, scope.worktreeId, scope.chatId]),
    { ...scope },
  );
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    const changes = Array.from(pending.values());
    pending.clear();
    for (const change of changes) {
      for (const listener of Array.from(listeners)) {
        try {
          listener(change);
        } catch {
          /* Presentation cannot interrupt activation. */
        }
      }
    }
  });
}

export function subscribeMcpActivationChanges(
  listener: (scope: McpActivationScope) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
