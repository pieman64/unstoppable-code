import { memo, useSyncExternalStore, type JSX } from 'react';

/**
 * One setup wait a queued message is held behind: when it started and, when
 * the host has a comparable earlier setup, how long that one took. The host
 * freezes both for the life of the wait.
 */
export interface QueuedMessageSetupWait {
  /** The project being set up; blank or absent reads as "the project". */
  readonly projectName?: string;
  /** Epoch ms the wait started. */
  readonly startedAtMs: number;
  /** How long an earlier setup of this project took, in ms. */
  readonly estimateMs?: number;
}

/** The estimate counts down in steps of this many ms, rounded up. */
export const SETUP_ESTIMATE_STEP_MS = 5_000;

function isValidTime(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

/** `0:05`, `1:05`, `75:00`: minutes, then two-digit seconds. */
export function formatSetupClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export interface SetupClockReading {
  readonly kind: 'elapsed' | 'remaining';
  /** Visible text, such as `0:12 elapsed` or `about 0:15 left`. */
  readonly text: string;
  /** Spoken text for assistive technology, which reads "0:12" poorly. */
  readonly spoken: string;
}

function spokenDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (minutes > 0)
    parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
  if (seconds > 0 || minutes === 0)
    parts.push(`${seconds} ${seconds === 1 ? 'second' : 'seconds'}`);
  return parts.join(' ');
}

/**
 * What the setup clock reads at `nowMs`, or `null` without a valid start.
 * Elapsed time never goes below zero (a start in the future reads `0:00`).
 * With a valid estimate it counts down, rounded up to the next five
 * seconds, until the estimate runs out; from then on it shows elapsed time.
 * An invalid estimate is ignored.
 */
export function readSetupClock(
  wait: Pick<QueuedMessageSetupWait, 'startedAtMs' | 'estimateMs'>,
  nowMs: number,
): SetupClockReading | null {
  if (!isValidTime(wait.startedAtMs) || !Number.isFinite(nowMs)) return null;
  const elapsedMs = Math.max(0, nowMs - wait.startedAtMs);
  const estimateMs = wait.estimateMs;
  if (isValidTime(estimateMs) && estimateMs > 0) {
    const remainingMs = estimateMs - elapsedMs;
    if (remainingMs > 0) {
      const roundedMs =
        Math.ceil(remainingMs / SETUP_ESTIMATE_STEP_MS) *
        SETUP_ESTIMATE_STEP_MS;
      return {
        kind: 'remaining',
        text: `about ${formatSetupClock(roundedMs)} left`,
        spoken: `About ${spokenDuration(roundedMs)} left`,
      };
    }
  }
  return {
    kind: 'elapsed',
    text: `${formatSetupClock(elapsedMs)} elapsed`,
    spoken: `${spokenDuration(elapsedMs)} elapsed`,
  };
}

// One shared one-second ticker for every live setup clock. It runs only while
// a clock is mounted, and reads the wall clock on each tick instead of
// counting ticks, so a throttled background window catches up on resume. Its
// reading never moves backward while it runs, so an adjusted system clock
// can't restart a countdown or rewind elapsed time.
const TICK_MS = 1_000;
const listeners = new Set<() => void>();
let tickerNow = 0;
let interval: ReturnType<typeof setInterval> | null = null;

function readNow(): number {
  tickerNow = Math.max(tickerNow, Date.now());
  return tickerNow;
}

function tick(): void {
  readNow();
  for (const listener of listeners) listener();
}

function subscribeSetupTicker(listener: () => void): () => void {
  listeners.add(listener);
  if (interval === null) {
    readNow();
    interval = setInterval(tick, TICK_MS);
  }
  return (): void => {
    listeners.delete(listener);
    if (listeners.size === 0 && interval !== null) {
      clearInterval(interval);
      interval = null;
      // A later, unrelated wait must not inherit a previous wait's wall
      // clock high-water mark after a system-clock adjustment.
      tickerNow = 0;
    }
  };
}

/**
 * Between ticks the reading holds still. Before the ticker starts it reads
 * the wall clock to the second, so the first render is close to right and
 * repeated reads in one render agree.
 */
function getTickerSnapshot(): number {
  if (interval === null) {
    tickerNow = Math.max(tickerNow, Math.floor(Date.now() / TICK_MS) * TICK_MS);
  }
  return tickerNow;
}

/** The server render has no clock; a fixed reading keeps it stable. */
function getServerTickerSnapshot(): number {
  return 0;
}

/** Test seam: whether the shared ticker is running and how many clocks use it. */
export function setupTickerStateForTests(): {
  readonly running: boolean;
  readonly subscribers: number;
} {
  return { running: interval !== null, subscribers: listeners.size };
}

/** Test seam: forget the ticker's last reading. */
export function resetSetupTickerForTests(): void {
  tickerNow = 0;
}

interface SetupClockProps {
  readonly startedAtMs: number;
  readonly estimateMs?: number;
}

function ClockText({
  reading,
}: {
  readonly reading: SetupClockReading | null;
}): JSX.Element | null {
  if (!reading) return null;
  return (
    <span
      data-testid="queued-message-setup-clock"
      data-clock-kind={reading.kind}
      className="shrink-0 whitespace-nowrap tabular-nums"
    >
      <span aria-hidden="true">{reading.text}</span>
      <span className="sr-only">{reading.spoken}</span>
    </span>
  );
}

const LiveSetupClock = memo(function LiveSetupClock({
  startedAtMs,
  estimateMs,
}: SetupClockProps): JSX.Element | null {
  const nowMs = useSyncExternalStore(
    subscribeSetupTicker,
    getTickerSnapshot,
    getServerTickerSnapshot,
  );
  return (
    <ClockText reading={readSetupClock({ startedAtMs, estimateMs }, nowMs)} />
  );
});

/**
 * The setup wait's clock. Only this element subscribes to the shared ticker,
 * so the bubble and list around it don't rerender every second. A fixed
 * `nowMs` (gallery captures, fixtures) renders that moment and never starts
 * the ticker.
 */
export const QueuedMessageSetupClock = memo(function QueuedMessageSetupClock({
  startedAtMs,
  estimateMs,
  nowMs,
}: SetupClockProps & { readonly nowMs?: number }): JSX.Element | null {
  if (nowMs !== undefined) {
    return (
      <ClockText reading={readSetupClock({ startedAtMs, estimateMs }, nowMs)} />
    );
  }
  return <LiveSetupClock startedAtMs={startedAtMs} estimateMs={estimateMs} />;
});
