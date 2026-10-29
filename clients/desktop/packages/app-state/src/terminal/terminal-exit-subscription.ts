import { useTerminalStore } from './terminal-store';
import { registerTerminalClientLifecycle } from './terminal-client-binding';

// One shared exit subscription routes events to per-worktree buckets. It is
// acquired lazily and follows replacement hosts until explicitly released.
let releaseExitSubscription: (() => void) | undefined;
export function ensureTerminalExitSubscription(): void {
  if (releaseExitSubscription) return;
  releaseExitSubscription = registerTerminalClientLifecycle(
    ({ client, isCurrent }) =>
      client.subscribe('terminal.exit', (event): void => {
        if (isCurrent()) useTerminalStore.getState().applyExit(event);
      }),
  );
}
export function resetTerminalExitSubscriptionForTesting(): void {
  releaseExitSubscription?.();
  releaseExitSubscription = undefined;
}
