import { keepDesktopInstrumentationSessionAlive } from '@canopy/desktop-instrumentation/electron/main';

/**
 * Periodic keepalive + sleep/wake recovery for the main-process Datadog RUM
 * session.
 *
 * The bundled alpha `@datadog/electron-sdk` expires a session after 15 min of
 * inactivity and only renews it on renderer `click` activity, which Canopy
 * disables. Per-operation renewal in the instrumentation wrapper guarantees
 * main-process ops are never dropped, but renderer-origin events (which inherit
 * the main session id) can still be discarded while the main process is idle.
 *
 * This module keeps the main session continuously alive:
 *
 * - An **unref'd** interval renews well under the 15-min inactivity window, so
 *   an idle/open app reads as one continuous session and renderer events are
 *   covered.
 * - A `powerMonitor` `resume` listener renews immediately on wake, because the
 *   SDK's `setTimeout`-based timers freeze (and the deadline silently passes)
 *   while the machine is asleep.
 */

/** 5 minutes — a safe margin under the SDK's 15-min inactivity window. */
const DEFAULT_KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Minimal structural subset of Electron's `powerMonitor` used here, so the
 * module stays free of a direct `electron` runtime import and is trivially
 * testable with an injected stub.
 */
export interface InstrumentationPowerMonitor {
  on(event: 'resume', listener: () => void): void;
  removeListener(event: 'resume', listener: () => void): void;
}

interface IntervalHandleLike {
  unref?: () => void;
}

export interface InstrumentationKeepaliveOptions {
  /** The power monitor whose `resume` event triggers an immediate renewal. */
  powerMonitor: InstrumentationPowerMonitor;
  /** Renewal interval in milliseconds. Defaults to 5 minutes. */
  intervalMs?: number;
  /** Renewal callback. Defaults to the instrumentation session keepalive. */
  notify?: () => void;
  /** Injectable `setInterval` seam for tests. */
  setIntervalFn?: typeof setInterval;
  /** Injectable `clearInterval` seam for tests. */
  clearIntervalFn?: typeof clearInterval;
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let resumeListener: (() => void) | null = null;
let activePowerMonitor: InstrumentationPowerMonitor | null = null;
let activeClearInterval: typeof clearInterval = clearInterval;

/**
 * Arms the periodic keepalive interval and the `resume` recovery listener.
 * Idempotent: a second call without an intervening `dispose` is a no-op.
 */
export function startInstrumentationKeepalive(
  options: InstrumentationKeepaliveOptions,
): void {
  if (intervalHandle !== null || resumeListener !== null) {
    return;
  }

  const intervalMs = options.intervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
  const notify = options.notify ?? keepDesktopInstrumentationSessionAlive;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  activeClearInterval = options.clearIntervalFn ?? clearInterval;
  activePowerMonitor = options.powerMonitor;

  const handle = setIntervalFn((): void => {
    notify();
  }, intervalMs);
  const unrefable: IntervalHandleLike = handle;
  unrefable.unref?.();
  intervalHandle = handle;

  const listener = (): void => {
    notify();
  };
  resumeListener = listener;
  activePowerMonitor.on('resume', listener);
}

/**
 * Clears the interval and removes the `resume` listener. Idempotent.
 */
export function disposeInstrumentationKeepalive(): void {
  if (intervalHandle !== null) {
    activeClearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (activePowerMonitor !== null && resumeListener !== null) {
    activePowerMonitor.removeListener('resume', resumeListener);
  }
  resumeListener = null;
  activePowerMonitor = null;
}
