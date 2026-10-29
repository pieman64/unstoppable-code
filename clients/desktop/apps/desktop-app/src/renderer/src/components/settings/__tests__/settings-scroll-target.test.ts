/**
 * @jest-environment jsdom
 *
 * Deep-link scroll hold for the Settings overlay: mount-retry, the
 * hold-centered settling window (the regression: late-mounting content
 * above the target — e.g. the GitHub card after its CLI probe — must
 * trigger a re-center instead of pushing the target out of view),
 * release-driven consumption, user-input release, and give-up.
 */

import { beginSettingsScrollTarget } from '../settings-scroll-target';

describe('beginSettingsScrollTarget', () => {
  let scrollParent: HTMLDivElement;
  let target: HTMLInputElement;
  let scrollIntoView: jest.Mock;
  let onConsume: jest.Mock;
  let cancel: (() => void) | null;

  beforeEach(() => {
    jest.useFakeTimers();
    onConsume = jest.fn();
    cancel = null;
    scrollParent = document.createElement('div');
    scrollParent.style.overflowY = 'auto';
    document.body.appendChild(scrollParent);
    target = document.createElement('input');
    target.setAttribute('data-testid', 'settings-linear-token-input');
    scrollIntoView = jest.fn();
    Object.defineProperty(target, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
  });

  afterEach(() => {
    cancel?.();
    jest.useRealTimers();
    scrollParent.remove();
  });

  /** Flushes MutationObserver microtasks plus the rAF-deferred re-center. */
  async function flushMutations(): Promise<void> {
    await Promise.resolve();
    jest.advanceTimersByTime(32);
  }

  it('retries until the target mounts, then centers, focuses, and highlights', () => {
    cancel = beginSettingsScrollTarget('settings-linear-token-input', {
      onConsume,
    });
    expect(scrollIntoView).not.toHaveBeenCalled();

    scrollParent.appendChild(target);
    jest.advanceTimersByTime(150);

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    expect(document.activeElement).toBe(target);
    expect(target.classList.contains('workspace-highlight-pulse')).toBe(true);
    // Acquisition must NOT consume — the hold is still active.
    expect(onConsume).not.toHaveBeenCalled();
  });

  it('re-centers when content mounts above the target during the settle window', async () => {
    scrollParent.appendChild(target);
    cancel = beginSettingsScrollTarget('settings-linear-token-input', {
      onConsume,
    });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    // The late-arriving GitHub card pushing layout around.
    const lateCard = document.createElement('div');
    scrollParent.insertBefore(lateCard, target);
    await flushMutations();

    expect(scrollIntoView.mock.calls.length).toBeGreaterThan(1);
    expect(onConsume).not.toHaveBeenCalled();
  });

  it('follows a target replaced during the hold to its replacement', async () => {
    scrollParent.appendChild(target);
    cancel = beginSettingsScrollTarget('settings-linear-token-input', {
      onConsume,
    });

    // A hosted page's data arriving remounts the device sections.
    const replacement = document.createElement('input');
    replacement.setAttribute('data-testid', 'settings-linear-token-input');
    const replacementScrollIntoView = jest.fn();
    Object.defineProperty(replacement, 'scrollIntoView', {
      configurable: true,
      value: replacementScrollIntoView,
    });
    target.replaceWith(replacement);
    await flushMutations();

    expect(replacementScrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    expect(document.activeElement).toBe(replacement);
    expect(replacement.classList.contains('workspace-highlight-pulse')).toBe(
      true,
    );
    expect(onConsume).not.toHaveBeenCalled();
  });

  it('consumes exactly once when the settle window elapses', () => {
    scrollParent.appendChild(target);
    cancel = beginSettingsScrollTarget('settings-linear-token-input', {
      onConsume,
      settleMs: 6000,
    });
    jest.advanceTimersByTime(5999);
    expect(onConsume).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onConsume).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(10_000);
    expect(onConsume).toHaveBeenCalledTimes(1);
  });

  it('releases on user scroll input: consumes and drops the highlight', async () => {
    scrollParent.appendChild(target);
    cancel = beginSettingsScrollTarget('settings-linear-token-input', {
      onConsume,
    });
    scrollParent.dispatchEvent(new Event('wheel'));
    expect(onConsume).toHaveBeenCalledTimes(1);
    expect(target.classList.contains('workspace-highlight-pulse')).toBe(false);

    // Released: later mutations no longer re-center.
    const before = scrollIntoView.mock.calls.length;
    scrollParent.insertBefore(document.createElement('div'), target);
    await flushMutations();
    expect(scrollIntoView.mock.calls.length).toBe(before);
  });

  it('gives up and consumes after the retry budget when the target never mounts', () => {
    cancel = beginSettingsScrollTarget('missing-testid', {
      onConsume,
      maxAttempts: 3,
      attemptIntervalMs: 100,
    });
    jest.advanceTimersByTime(300);
    expect(onConsume).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('without a scroll parent, consumes only after the highlight window', () => {
    // Target mounted directly on <body> — no overflow ancestor, so no hold
    // is possible. Consuming synchronously would re-key the caller's effect
    // and strip the highlight within a frame; the consume must wait out the
    // highlight window instead.
    document.body.appendChild(target);
    cancel = beginSettingsScrollTarget('settings-linear-token-input', {
      onConsume,
      highlightMs: 3600,
    });

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    expect(target.classList.contains('workspace-highlight-pulse')).toBe(true);
    expect(onConsume).not.toHaveBeenCalled();

    jest.advanceTimersByTime(3599);
    expect(onConsume).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onConsume).toHaveBeenCalledTimes(1);
    target.remove();
  });

  it('without a scroll parent, cancel before the highlight window skips the consume', () => {
    document.body.appendChild(target);
    cancel = beginSettingsScrollTarget('settings-linear-token-input', {
      onConsume,
      highlightMs: 3600,
    });
    cancel();
    cancel = null;

    expect(target.classList.contains('workspace-highlight-pulse')).toBe(false);
    jest.advanceTimersByTime(20_000);
    expect(onConsume).not.toHaveBeenCalled();
    target.remove();
  });

  it('cancel tears down without consuming', async () => {
    scrollParent.appendChild(target);
    cancel = beginSettingsScrollTarget('settings-linear-token-input', {
      onConsume,
    });
    cancel();
    cancel = null;

    expect(onConsume).not.toHaveBeenCalled();
    expect(target.classList.contains('workspace-highlight-pulse')).toBe(false);
    const before = scrollIntoView.mock.calls.length;
    scrollParent.insertBefore(document.createElement('div'), target);
    await flushMutations();
    expect(scrollIntoView.mock.calls.length).toBe(before);
    jest.advanceTimersByTime(20_000);
    expect(onConsume).not.toHaveBeenCalled();
  });
});
