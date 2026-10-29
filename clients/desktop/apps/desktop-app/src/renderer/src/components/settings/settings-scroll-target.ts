/**
 * Deep-link scroll hold for the Settings overlay: finds the control named by
 * a `data-testid` (retrying while tab content and async reads mount), then
 * scrolls it to center, focuses it, briefly highlights it, and HOLDS it
 * centered through a settling window — re-centering on every DOM change in
 * its scroll container, because slower content above the target (the GitHub
 * card's CLI probe, account reads) keeps mounting for seconds and would
 * otherwise push the target back out of view.
 *
 * A target replaced during the hold (a remount when a hosted page's data
 * arrives) is found again by its test id, so the replacement is the one
 * centered, focused and highlighted.
 *
 * The hold releases on the first user scroll input (wheel/touch/pointer/key)
 * or when the settle window elapses, and the caller's `onConsume` fires only
 * at that release (or at retry give-up) — never at acquisition. That timing
 * is load-bearing: the overlay keys its effect on the consumable store
 * value, so consuming at acquisition would re-run the effect cleanup one
 * render later and tear the hold down before the first late-mounting card
 * ever arrived (the bug this module exists to prevent).
 *
 * Extracted from `SettingsOverlay` so the retry/hold/release lifecycle is
 * unit-testable without rendering the overlay.
 */

export interface BeginSettingsScrollTargetOptions {
  /** Fired once, at hold release or retry give-up. */
  onConsume: () => void;
  /** Delay between mount-retry attempts. */
  attemptIntervalMs?: number;
  /** Retry budget before giving up (and consuming). */
  maxAttempts?: number;
  /**
   * How long the target is held centered against late layout shifts. Sized
   * for the slowest known above-target content (the GitHub CLI probe).
   */
  settleMs?: number;
  /** How long the highlight pulse class stays applied. */
  highlightMs?: number;
}

/** Escapes a value for the inside of a double-quoted attribute selector. */
function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function findScrollParent(element: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = element.parentElement;
  while (node) {
    const { overflowY } = window.getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Starts the retry → hold → release lifecycle for `testId`. Returns an
 * idempotent cancel that tears everything down WITHOUT consuming — the
 * caller's effect cleanup path, which runs both when the overlay closes
 * mid-hold and (as a no-op) right after a release-driven consume re-keys
 * the effect.
 */
export function beginSettingsScrollTarget(
  testId: string,
  options: BeginSettingsScrollTargetOptions,
): () => void {
  const {
    onConsume,
    attemptIntervalMs = 150,
    maxAttempts = 20,
    settleMs = 6000,
    highlightMs = 3600,
  } = options;

  let cancelled = false;
  let attempts = 0;
  const cleanups: Array<() => void> = [];
  const teardown = (): void => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  };

  const findTarget = (): HTMLElement | null =>
    document.querySelector<HTMLElement>(
      `[data-testid="${escapeAttributeValue(testId)}"]`,
    );

  const holdCentered = (found: HTMLElement): void => {
    let target = found;
    let highlighted = true;
    const center = (): void => {
      // jsdom does not implement scrollIntoView.
      target.scrollIntoView?.({ block: 'center' });
    };
    center();
    target.focus?.({ preventScroll: true });
    target.classList.add('workspace-highlight-pulse');
    const highlightTimer = window.setTimeout(() => {
      highlighted = false;
      target.classList.remove('workspace-highlight-pulse');
    }, highlightMs);
    cleanups.push(() => {
      window.clearTimeout(highlightTimer);
      // Teardown may precede the timer (user-input release, unmount): the
      // class must never outlive the hold.
      target.classList.remove('workspace-highlight-pulse');
    });
    // Follows a remounted target to its replacement.
    const reacquire = (): void => {
      if (target.isConnected) return;
      const replacement = findTarget();
      if (replacement === null) return;
      target = replacement;
      target.focus?.({ preventScroll: true });
      if (highlighted) target.classList.add('workspace-highlight-pulse');
    };

    const scrollParent = findScrollParent(target);
    if (!scrollParent || typeof MutationObserver !== 'function') {
      // No hold is possible, but consuming NOW would re-key the caller's
      // effect and tear the highlight down within a frame (the miniature of
      // the consume-at-acquisition bug this module exists to prevent).
      // Consume once the highlight has had its moment.
      const consumeTimer = window.setTimeout(onConsume, highlightMs);
      cleanups.push(() => window.clearTimeout(consumeTimer));
      return;
    }
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      teardown();
      onConsume();
    };
    const observer = new MutationObserver(() => {
      reacquire();
      window.requestAnimationFrame(center);
    });
    observer.observe(scrollParent, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    const settleTimer = window.setTimeout(release, settleMs);
    // The user taking over — scroll input of any kind — wins immediately.
    for (const event of [
      'wheel',
      'touchmove',
      'pointerdown',
      'keydown',
    ] as const) {
      scrollParent.addEventListener(event, release, { passive: true });
      cleanups.push(() => scrollParent.removeEventListener(event, release));
    }
    cleanups.push(() => {
      observer.disconnect();
      window.clearTimeout(settleTimer);
    });
  };

  const tryFind = (): void => {
    if (cancelled) return;
    const target = findTarget();
    if (target) {
      holdCentered(target);
      return;
    }
    attempts += 1;
    if (attempts >= maxAttempts) {
      onConsume();
      return;
    }
    const retryTimer = window.setTimeout(tryFind, attemptIntervalMs);
    cleanups.push(() => window.clearTimeout(retryTimer));
  };
  tryFind();

  return (): void => {
    cancelled = true;
    teardown();
  };
}
