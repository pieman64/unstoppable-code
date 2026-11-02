import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

// Quit latency: the app's own `app.quit()` path (every `before-quit` handler,
// runtime shutdown) timed from the request to the Electron main process's
// exit. The harness's later close then finds the app already gone.

/** A quit still running after this is reported as `timed-out`. */
export const QUIT_LATENCY_TIMEOUT_MS = 10_000;
export const QUIT_LATENCY_POLL_INTERVAL_MS = 10;

export function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the pid exists but belongs to another user.
    return error?.code === 'EPERM';
  }
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/** The runner's lines for a scenario's `quit`; a quit that did not exit is an error line. */
export function quitSummaryLines(quit) {
  if (!quit) return [];
  if (quit.status === 'exited')
    return [
      {
        error: false,
        text: `[perf]   quit: Electron exited ${quit.exitMs.toFixed(0)}ms after app.quit()`,
      },
    ];
  const detail = quit.error ? `: ${quit.error}` : '';
  return [
    {
      error: true,
      text:
        quit.status === 'timed-out'
          ? `[perf]   quit: TIMED OUT, Electron still running ${quit.timeoutMs}ms after app.quit()${detail}`
          : `[perf]   quit: not measured (${quit.status})${detail}`,
    },
  ];
}

/**
 * Attaches the quit to its scenario record. A quit that did not exit fails the
 * scenario: a lower-bound time alone can pass a comparison.
 */
export function scenarioWithQuit(record, quit) {
  if (quit.status === 'exited') return { ...record, quit };
  const [{ text }] = quitSummaryLines(quit);
  const failure = text.replace(/^\[perf\]\s+/, '');
  return {
    ...record,
    quit,
    status: 'error',
    error: record.error ? `${record.error}; ${failure}` : failure,
  };
}

const DEADLINE_PASSED = Symbol('deadline passed');

/** `promise`, or `DEADLINE_PASSED` once `ms` elapse first. */
async function beforeDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(resolve, ms, DEADLINE_PASSED);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Requests `app.quit()` and waits, bounded, for the Electron main process to
 * exit. Returns `{ status, exitMs, timeoutMs }`: `exited` with the measured
 * time; `timed-out` with `exitMs` at the deadline, a lower bound that still
 * compares as a regression; or `unavailable` with no time when the main pid
 * could not be read within `timeoutMs`. Never throws and never leaves the
 * quit running unbounded.
 */
export async function measureAppQuit(
  electronApp,
  {
    timeoutMs = QUIT_LATENCY_TIMEOUT_MS,
    pollIntervalMs = QUIT_LATENCY_POLL_INTERVAL_MS,
    now = () => performance.now(),
    wait = (ms) => delay(ms),
    exists = processExists,
  } = {},
) {
  let pid;
  try {
    // Playwright's evaluate has no timeout of its own.
    pid = await beforeDeadline(
      electronApp.evaluate(() => process.pid),
      timeoutMs,
    );
  } catch (error) {
    return {
      status: 'unavailable',
      exitMs: null,
      timeoutMs,
      error: describeError(error),
    };
  }
  if (pid === DEADLINE_PASSED)
    return {
      status: 'unavailable',
      exitMs: null,
      timeoutMs,
      error: `Electron main did not report its pid within ${timeoutMs}ms`,
    };
  if (!Number.isInteger(pid) || pid <= 0)
    return {
      status: 'unavailable',
      exitMs: null,
      timeoutMs,
      error: `Invalid Electron main pid: ${String(pid)}`,
    };
  const startedAt = now();
  let requestError = null;
  // The evaluate can lose its connection as the app exits; only the pid
  // decides the outcome.
  electronApp
    .evaluate(({ app }) => {
      app.quit();
    })
    .catch((error) => {
      requestError = describeError(error);
    });
  for (;;) {
    const elapsed = now() - startedAt;
    if (!exists(pid)) return { status: 'exited', exitMs: elapsed, timeoutMs };
    if (elapsed >= timeoutMs) {
      return {
        status: 'timed-out',
        exitMs: elapsed,
        timeoutMs,
        ...(requestError ? { error: requestError } : {}),
      };
    }
    await wait(pollIntervalMs);
  }
}
