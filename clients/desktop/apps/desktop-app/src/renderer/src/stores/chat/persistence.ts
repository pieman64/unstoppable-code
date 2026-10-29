// Renderer-side chat persistence gates. Durable chat state is main-owned:
// the renderer issues typed commands and consumes revisioned snapshots, and
// no renderer module serializes or writes a canonical tab snapshot. What
// remains here are the presentation-side registries that used to accompany
// the (removed) debounced snapshot writer.
import { chatStoreApi } from './store-ref';

/**
 * Scopes whose renderer projection must not be treated as live (worktree
 * deletion/archival in flight). Gates idle-unload bookkeeping and hydration;
 * durable writes are main-owned and unaffected.
 */
export const blockedPersistenceKeys = new Set<string>();

/**
 * Coalesced timer for `verifyStreamingTabs()`. Callers that need a follow-up
 * verification pass (e.g. post-crash restore preserving a tab under the grace
 * window) call `scheduleStreamingVerification()` instead of wiring their own
 * `setTimeout`, so repeated triggers collapse into a single pending tick.
 */
let verifyStreamingTabsTimeout: ReturnType<typeof setTimeout> | null = null;

export function scheduleStreamingVerification(): void {
  if (verifyStreamingTabsTimeout !== null) {
    clearTimeout(verifyStreamingTabsTimeout);
  }
  verifyStreamingTabsTimeout = setTimeout(() => {
    verifyStreamingTabsTimeout = null;
    void chatStoreApi().getState().verifyStreamingTabs();
  }, 3000);
}
