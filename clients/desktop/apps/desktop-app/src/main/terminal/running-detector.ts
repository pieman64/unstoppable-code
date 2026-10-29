import path from 'node:path';

export const RUNNING_DETECTOR_INTERVAL_MS = 250;

const TERMINAL_TYPE_PROCESS_NAMES = new Set(['xterm', 'xterm-256color']);

export interface RunningDetectorTerminalSnapshot {
  id: string;
  shellBasename: string;
  /** Current foreground process name as reported by the PTY. */
  processName: string | null | undefined;
  /** Last-emitted running state (used for change detection only). */
  running: boolean;
  /** Last-emitted processName (used for change detection only). `null` when idle. */
  lastProcessName: string | null;
}

export interface RunningDetectorStore {
  getTerminalSnapshots(): Iterable<RunningDetectorTerminalSnapshot>;
  /**
   * Record the latest computed status for a terminal. Implementers are
   * responsible for deduplication and for fan-out to the IPC layer.
   */
  setTerminalStatus(
    id: string,
    running: boolean,
    processName: string | null,
  ): void;
}

interface ComputeTerminalRunningStateOptions {
  platform?: NodeJS.Platform;
}

interface RunningDetectorOptions {
  store: RunningDetectorStore;
  setIntervalFn?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (timer: ReturnType<typeof setInterval>) => void;
}

function normalizeProcessName(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  const basename = path.win32.basename(path.posix.basename(trimmed));
  const normalized = basename.toLowerCase().replace(/\.exe$/, '');
  return normalized.length > 0 ? normalized : null;
}

export function isTerminalTypeProcessName(
  value: string | null | undefined,
): boolean {
  const processName = normalizeProcessName(value);
  return processName !== null && TERMINAL_TYPE_PROCESS_NAMES.has(processName);
}

// A terminal is "running" iff a foreground process other than the shell is
// attached to the PTY. We deliberately do NOT fall back to recent-output
// timing here: every keystroke the user types is echoed back by the shell as
// PTY output, which would otherwise make idle-but-typed-in shells appear to
// be running for the echo-visibility window after the last keypress.
export function computeTerminalRunningState(
  terminal: Pick<
    RunningDetectorTerminalSnapshot,
    'shellBasename' | 'processName'
  >,
  options: ComputeTerminalRunningStateOptions = {},
): boolean {
  const processName = normalizeProcessName(terminal.processName);
  const shellBasename = normalizeProcessName(terminal.shellBasename);
  if (!processName || !shellBasename) {
    return false;
  }
  const platform = options.platform ?? process.platform;
  if (platform === 'win32' && isTerminalTypeProcessName(processName)) {
    return false;
  }
  return processName !== shellBasename;
}

export class TerminalRunningDetector {
  private readonly store: RunningDetectorStore;

  private readonly setIntervalFn: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setInterval>;

  private readonly clearIntervalFn: (
    timer: ReturnType<typeof setInterval>,
  ) => void;

  private timer: ReturnType<typeof setInterval> | null = null;

  public constructor(options: RunningDetectorOptions) {
    this.store = options.store;
    this.setIntervalFn = options.setIntervalFn ?? setInterval;
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  }

  public syncLifecycle(): void {
    const iterator = this.store.getTerminalSnapshots()[Symbol.iterator]();
    const first = iterator.next();
    const hasLiveTerminals = !first.done;

    if (hasLiveTerminals) {
      this.ensureStarted();
      return;
    }

    this.stop();
  }

  public tick(): void {
    const snapshots = Array.from(this.store.getTerminalSnapshots());
    for (const terminal of snapshots) {
      const running = computeTerminalRunningState(terminal);
      const processName =
        running && typeof terminal.processName === 'string'
          ? terminal.processName
          : null;
      if (
        running !== terminal.running ||
        processName !== terminal.lastProcessName
      ) {
        this.store.setTerminalStatus(terminal.id, running, processName);
      }
    }
  }

  public stop(): void {
    if (this.timer === null) {
      return;
    }

    this.clearIntervalFn(this.timer);
    this.timer = null;
  }

  public isRunning(): boolean {
    return this.timer !== null;
  }

  private ensureStarted(): void {
    if (this.timer !== null) {
      return;
    }

    this.timer = this.setIntervalFn((): void => {
      this.tick();
    }, RUNNING_DETECTOR_INTERVAL_MS);
  }
}
