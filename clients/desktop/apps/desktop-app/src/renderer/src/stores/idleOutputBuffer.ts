/**
 * Shared idle-flush buffering utilities used by `hooksStore` and
 * `scriptsStore`. Both stores accumulate IPC-driven `output` events into a
 * pending queue and drain it on the next idle frame so rapid bursts collapse
 * into a single React commit. The plumbing was copy-pasted between the two
 * stores until this module pulled it out.
 */

/**
 * Maximum time (ms) before idle-deferred output is forced to flush.
 * Keeps output visually fresh even when the main thread is busy.
 */
export const IDLE_FLUSH_TIMEOUT_MS = 200;

export type IdleHandle = number | ReturnType<typeof setTimeout>;

/**
 * Schedule a low-priority callback. In Chromium `requestIdleCallback` runs
 * only when the browser is idle, so user interactions always take precedence.
 * Falls back to `setTimeout(fn, 0)` in environments that lack
 * `requestIdleCallback` (e.g. Jest / Node tests).
 */
export function scheduleIdle(cb: () => void): IdleHandle {
  if (typeof requestIdleCallback === 'function') {
    return requestIdleCallback(cb, { timeout: IDLE_FLUSH_TIMEOUT_MS });
  }
  return setTimeout(cb, 0);
}

/** Cancel a handle returned by {@link scheduleIdle}. */
export function cancelIdle(id: IdleHandle): void {
  if (typeof id === 'number' && typeof cancelIdleCallback === 'function') {
    cancelIdleCallback(id);
    return;
  }
  clearTimeout(id);
}

export interface IdleOutputBuffer<Item> {
  push: (item: Item) => void;
  removeWorktree: (worktreeKey: string) => void;
  flush: () => void;
}

export function createIdleOutputBuffer<Item>({
  getWorktreeKey,
  flushBatch,
  minFlushIntervalMs = 0,
}: {
  getWorktreeKey: (item: Item) => string;
  flushBatch: (batch: Item[]) => void;
  /**
   * Minimum wall-clock gap between flushes. With the default `0` the buffer
   * flushes on the next idle frame (legacy behavior). A positive value caps
   * commit frequency to a trailing-edge throttle, so a chatty stream commits
   * a few times/sec instead of once per output event.
   */
  minFlushIntervalMs?: number;
}): IdleOutputBuffer<Item> {
  let pendingOutputs: Item[] = [];
  // Cancels whichever timer (idle callback or throttle timeout) is currently
  // pending. Null when nothing is scheduled. Owning the canceller here keeps
  // the two scheduling mechanisms from being confused by the shared
  // `cancelIdle`, which cannot tell an idle handle from a `setTimeout` id.
  let cancelPending: (() => void) | null = null;
  let lastDrainAt = 0;

  const drain = (): void => {
    cancelPending = null;
    lastDrainAt = Date.now();
    const batch = pendingOutputs;
    pendingOutputs = [];
    if (batch.length === 0) return;
    flushBatch(batch);
  };

  const schedule = (): void => {
    if (minFlushIntervalMs <= 0) {
      const handle = scheduleIdle(drain);
      cancelPending = (): void => cancelIdle(handle);
      return;
    }
    const sinceLast = Date.now() - lastDrainAt;
    const wait = Math.max(0, minFlushIntervalMs - sinceLast);
    const handle = setTimeout(drain, wait);
    cancelPending = (): void => clearTimeout(handle);
  };

  return {
    push: (item): void => {
      pendingOutputs.push(item);
      if (cancelPending === null) {
        schedule();
      }
    },
    removeWorktree: (worktreeKey): void => {
      if (cancelPending !== null) {
        cancelPending();
        cancelPending = null;
      }

      pendingOutputs = pendingOutputs.filter(
        (item) => getWorktreeKey(item) !== worktreeKey,
      );

      if (pendingOutputs.length > 0) {
        schedule();
      }
    },
    flush: (): void => {
      if (cancelPending !== null) {
        cancelPending();
        cancelPending = null;
      }
      drain();
    },
  };
}

/**
 * Generic "merge a batch of pending outputs into a runs map" reducer used by
 * both stores. Each store passes its own `getKey` (extracts the
 * `(projectId, worktreeId, runKey)` triple) and `createRun` (builds the
 * initial `RunState` from a descriptor) so the type stays identical to
 * what the calling store cares about.
 *
 * Behavior preserved verbatim from the original inline implementations:
 * - Lines are appended to the existing run's `outputLines`, capped at
 *   `maxOutputLines`.
 * - When no existing run is present we build a new one with `status:
 *   'running'` and the buffered lines.
 *
 * The `createRun` / `updateRun` callbacks receive an additional `newLines`
 * argument — the raw un-capped chunk of lines from the current batch item.
 * It is intended for incremental per-batch computations such as dev-server
 * URL detection in `scriptsStore`, which must run against the new lines only
 * (the post-cap `outputLines` would silently drop early matches once the
 * sliding-window cap kicked in). Hook callers may safely omit the extra
 * parameter — TypeScript allows trailing-parameter omission, so existing
 * call sites continue to work byte-equivalent.
 */
export function applyBatchToRunsMap<
  Item,
  RunState extends { outputLines: string[]; status: string },
>(
  runs: Record<string, Record<string, RunState>>,
  batch: ReadonlyArray<Item>,
  helpers: {
    getKey: (item: Item) => {
      worktreeKey: string;
      runKey: string;
      lines: string[];
    };
    createRun: (
      item: Item,
      outputLines: string[],
      newLines: string[],
    ) => RunState;
    updateRun: (
      run: RunState,
      outputLines: string[],
      newLines: string[],
    ) => RunState;
    maxOutputLines: number;
  },
): Record<string, Record<string, RunState>> {
  const nextRuns = { ...runs };
  for (const item of batch) {
    const { worktreeKey: wk, runKey, lines } = helpers.getKey(item);
    const worktreeRuns = nextRuns[wk] ?? {};
    const existing = worktreeRuns[runKey];
    const currentLines = existing?.outputLines ?? [];
    const merged = [...currentLines, ...lines];
    const capped =
      merged.length > helpers.maxOutputLines
        ? merged.slice(merged.length - helpers.maxOutputLines)
        : merged;

    nextRuns[wk] = {
      ...worktreeRuns,
      [runKey]: existing
        ? helpers.updateRun(existing, capped, lines)
        : helpers.createRun(item, capped, lines),
    };
  }
  return nextRuns;
}
