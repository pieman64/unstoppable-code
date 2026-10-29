import { useEffect, useRef, type RefObject } from 'react';

import type { PendingWorktreeScroll } from '../../stores/projectsStore';

/**
 * Number of animation frames to keep polling for the target row before giving
 * up. Creation flows un-collapse the target's workspace synchronously, so the
 * row usually mounts on the next commit; this window (~1s at 60fps) also covers
 * un-collapse/un-hide re-renders and late child mounts.
 */
const MAX_FIND_FRAMES = 60;

/**
 * How long (ms) a `created` scroll keeps re-asserting itself after the first
 * scroll. The base-branch nesting seed reflows synchronously, but the first
 * diff-stats refresh only lands after git setup completes and changes row
 * heights, which would otherwise strand the initial smooth scroll at a stale
 * offset. Re-asserting with `nearest` is a no-op once the row is stably in view.
 */
const SETTLE_MS = 800;

export interface UsePendingWorktreeScrollOptions {
  /**
   * Whether this consumer is currently the active one. Both the sidebar list
   * and the kanban board read the same pending signal; only the mounted view
   * for the active page should consume it.
   */
  enabled: boolean;
  /**
   * Element whose subtree is searched for the target row. It does not need to
   * be the scrollable element itself — `scrollIntoView` walks up to the nearest
   * scrollable ancestor.
   */
  containerRef: RefObject<HTMLElement | null>;
  pending: PendingWorktreeScroll | null;
  clearPending: () => void;
  /**
   * Returns whether the worktree still exists in the model. Used to bail out
   * early (and clear the flag) when the target was deleted while pending.
   */
  stillExists: (projectId: string, worktreeId: string) => boolean;
  /**
   * Scroll alignment. Defaults to `{ block: 'nearest' }`. The kanban board also
   * passes `inline: 'nearest'` for its horizontal scroll.
   */
  scrollBlock?: ScrollLogicalPosition;
  scrollInline?: ScrollLogicalPosition;
}

/**
 * Robustly scrolls a pending worktree row into view.
 *
 * The naive approach — a single-shot `scrollIntoView({ behavior: 'smooth' })`
 * that clears the flag immediately — is flaky precisely when a real scroll is
 * required (a newly created worktree in a workspace that is not the top one):
 * the smooth scroll is computed once, then invalidated by asynchronous
 * post-creation reflow (base-branch nesting + late diff-stats), leaving the row
 * off-position with nothing to correct it.
 *
 * This hook instead:
 *  - polls a few frames for the target row in case it has not mounted yet;
 *  - performs one smooth `nearest` scroll once found;
 *  - for `created` flows, re-asserts the scroll across a short settle window
 *    (driven by animation frames) so reflow cannot strand it,
 *    bailing early if the user takes over scrolling;
 *  - clears the pending flag only when the work is done.
 */
export function usePendingWorktreeScroll({
  enabled,
  containerRef,
  pending,
  clearPending,
  stillExists,
  scrollBlock = 'nearest',
  scrollInline,
}: UsePendingWorktreeScrollOptions): void {
  // Read the latest callbacks/predicate from refs so the effect only re-runs on
  // the pending target itself, not on every parent render.
  const clearPendingRef = useRef(clearPending);
  clearPendingRef.current = clearPending;
  const stillExistsRef = useRef(stillExists);
  stillExistsRef.current = stillExists;

  const pendingProjectId = pending?.projectId ?? null;
  const pendingWorktreeId = pending?.worktreeId ?? null;
  const pendingReason = pending?.reason ?? null;

  useEffect(() => {
    if (!enabled || !pendingProjectId || !pendingWorktreeId) {
      return;
    }
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const selector =
      `[data-project-id="${CSS.escape(pendingProjectId)}"]` +
      `[data-worktree-id="${CSS.escape(pendingWorktreeId)}"]`;
    const inlineOption: ScrollIntoViewOptions = scrollInline
      ? { inline: scrollInline }
      : {};

    let cancelled = false;
    let frame = 0;
    let settleTimer = 0;

    const teardown = (): void => {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      if (settleTimer) {
        window.clearTimeout(settleTimer);
        settleTimer = 0;
      }
      window.removeEventListener('wheel', onUserScroll, true);
      window.removeEventListener('touchmove', onUserScroll, true);
    };

    const finish = (): void => {
      if (cancelled) {
        return;
      }
      cancelled = true;
      teardown();
      clearPendingRef.current();
    };

    function onUserScroll(): void {
      // The user is driving the scroll now; stop correcting so we never fight
      // their manual position during the settle window.
      finish();
    }

    const scrollToTarget = (behavior: ScrollBehavior): boolean => {
      const target = container.querySelector<HTMLElement>(selector);
      if (!target) {
        return false;
      }
      target.scrollIntoView({ block: scrollBlock, ...inlineOption, behavior });
      return true;
    };

    const beginSettleWindow = (): void => {
      window.addEventListener('wheel', onUserScroll, true);
      window.addEventListener('touchmove', onUserScroll, true);
      const reassert = (): void => {
        if (cancelled) {
          return;
        }
        // A freshly created row mounts in a `creating` setup phase and reflows
        // as it becomes interactive (and again when diff-stats land). Re-assert
        // the scroll smoothly every frame so descendant-only reflows cannot
        // strand it. Crucially, do not use `behavior: 'auto'`, which would snap
        // and cancel the in-flight smooth animation. `nearest` keeps this a no-op
        // once the row is stably in view.
        scrollToTarget('smooth');
        frame = requestAnimationFrame(reassert);
      };
      frame = requestAnimationFrame(reassert);
      settleTimer = window.setTimeout(finish, SETTLE_MS);
    };

    let findAttempts = 0;
    const tick = (): void => {
      if (cancelled) {
        return;
      }
      if (scrollToTarget('smooth')) {
        frame = 0;
        if (pendingReason === 'created') {
          beginSettleWindow();
        } else {
          finish();
        }
        return;
      }
      // Row not in the DOM yet. Bail if the worktree was deleted while pending.
      if (!stillExistsRef.current(pendingProjectId, pendingWorktreeId)) {
        finish();
        return;
      }
      findAttempts += 1;
      if (findAttempts >= MAX_FIND_FRAMES) {
        // The row never rendered within the window (e.g. its workspace stayed
        // hidden). Clear the flag so it cannot fire an unexpected scroll later.
        finish();
        return;
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);

    return (): void => {
      cancelled = true;
      teardown();
    };
  }, [
    enabled,
    pendingProjectId,
    pendingWorktreeId,
    pendingReason,
    containerRef,
    scrollBlock,
    scrollInline,
  ]);
}
