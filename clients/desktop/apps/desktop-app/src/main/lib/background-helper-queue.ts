export const BACKGROUND_HELPER_PRIORITIES = {
  branchNaming: 0,
  chatMetadata: 1,
  worktreeSummary: 2,
  memoryConsolidation: 3,
  memoryImport: 4,
  skillSuggestions: 5,
} as const;

export type BackgroundHelperPriority =
  (typeof BACKGROUND_HELPER_PRIORITIES)[keyof typeof BACKGROUND_HELPER_PRIORITIES];

// A short macrotask gap prevents a queue of completed helpers from turning
// into a continuous child-process spawn train. It is deliberately unrelated
// to foreground agent state: helpers keep progressing while agents run.
const DEFAULT_BACKGROUND_HELPER_INITIAL_DELAY_MS = 1_000;
const DEFAULT_BACKGROUND_HELPER_INTER_TASK_DELAY_MS = 500;
let initialDelayMs = DEFAULT_BACKGROUND_HELPER_INITIAL_DELAY_MS;
let interTaskDelayMs = DEFAULT_BACKGROUND_HELPER_INTER_TASK_DELAY_MS;

interface PendingBackgroundHelperTask {
  priority: BackgroundHelperPriority;
  sequence: number;
  run: () => Promise<void>;
  reject: (error: Error) => void;
}

let nextSequence = 0;
let drainScheduled = false;
let taskRunning = false;
let shuttingDown = false;
let drainTimer: ReturnType<typeof setTimeout> | null = null;
const pendingTasks: PendingBackgroundHelperTask[] = [];
const BACKGROUND_HELPER_QUEUE_SHUTDOWN_ERROR = new Error(
  'Background helper queue is shutting down',
);

function scheduleDrain(delayMs = 0): void {
  if (shuttingDown || drainScheduled || taskRunning) return;
  drainScheduled = true;
  const start = (): void => {
    drainScheduled = false;
    drainTimer = null;
    if (shuttingDown) return;
    void drainQueue();
  };
  if (delayMs > 0) {
    drainTimer = setTimeout(start, delayMs);
  } else {
    queueMicrotask(start);
  }
}

async function drainQueue(): Promise<void> {
  if (shuttingDown || taskRunning) return;
  pendingTasks.sort(
    (left, right) =>
      left.priority - right.priority || left.sequence - right.sequence,
  );
  const entry = pendingTasks.shift();
  if (!entry) return;
  taskRunning = true;
  try {
    await entry.run();
  } finally {
    taskRunning = false;
    if (!shuttingDown && pendingTasks.length > 0) {
      scheduleDrain(interTaskDelayMs);
    }
  }
}

/**
 * Permanently stops the process-wide helper queue during app teardown.
 * Already-running work is left for the provider/session cleanup sweep, while
 * queued work is rejected so callers do not retain promises that never settle.
 */
export function shutdownBackgroundHelperQueue(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (drainTimer !== null) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
  drainScheduled = false;
  for (const entry of pendingTasks.splice(0, pendingTasks.length)) {
    entry.reject(BACKGROUND_HELPER_QUEUE_SHUTDOWN_ERROR);
  }
}

/**
 * Runs background LLM helpers one at a time. Pending work is priority ordered,
 * while an already-running helper is allowed to finish. Foreground agents do
 * not gate this queue and are never enqueued into it.
 */
export function enqueueBackgroundHelperTask<T>(options: {
  priority: BackgroundHelperPriority;
  task: () => Promise<T>;
}): Promise<T> {
  if (shuttingDown) {
    return Promise.reject(BACKGROUND_HELPER_QUEUE_SHUTDOWN_ERROR);
  }
  const promise = new Promise<T>((resolve, reject) => {
    pendingTasks.push({
      priority: options.priority,
      sequence: nextSequence++,
      reject,
      run: async () => {
        try {
          resolve(await options.task());
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    });
  });
  scheduleDrain(initialDelayMs);
  return promise;
}

export const backgroundHelperQueueTestExports = {
  reset(): void {
    if (drainTimer !== null) clearTimeout(drainTimer);
    pendingTasks.splice(0, pendingTasks.length);
    nextSequence = 0;
    drainScheduled = false;
    taskRunning = false;
    shuttingDown = false;
    drainTimer = null;
    // Test callers need deterministic promise flushing, not wall-clock waits.
    initialDelayMs = 0;
    interTaskDelayMs = 0;
  },
  defaultInitialDelayMs: DEFAULT_BACKGROUND_HELPER_INITIAL_DELAY_MS,
  defaultInterTaskDelayMs: DEFAULT_BACKGROUND_HELPER_INTER_TASK_DELAY_MS,
};
