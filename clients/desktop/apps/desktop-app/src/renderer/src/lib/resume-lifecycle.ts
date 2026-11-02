/**
 * Renderer-wide record of Continue/resume navigations still in flight. A
 * resume can switch the workspace context or load a cowork workspace before
 * it changes the page, so a recent navigation timestamp cannot tell whether
 * it has finished. Automatic UI that must not interrupt a resume (the
 * release highlights dialog, CAN-5006) waits until nothing is pending.
 */

let pending = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of Array.from(listeners)) listener();
}

export function isResumePending(): boolean {
  return pending > 0;
}

export function subscribeResumePending(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

/**
 * Marks a resume as started. The returned callback ends it once, on success,
 * failure, or cancellation alike.
 */
export function beginResume(): () => void {
  pending += 1;
  notify();
  let ended = false;
  return (): void => {
    if (ended) return;
    ended = true;
    pending -= 1;
    notify();
  };
}

/** Keeps a resume pending until `work` settles, whether it resolves or rejects. */
export function trackResume(work: () => void | Promise<unknown>): void {
  const end = beginResume();
  try {
    void Promise.resolve(work()).then(end, end);
  } catch {
    end();
  }
}

/** Test-only reset of the pending count and listeners. */
export function resetResumeLifecycleForTests(): void {
  pending = 0;
  listeners.clear();
}
