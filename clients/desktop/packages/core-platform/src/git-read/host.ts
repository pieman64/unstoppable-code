import { userInfo } from 'node:os';
import {
  captureWindowsClosureContext,
  observeWindowsClosure,
} from '../supervision/windows-closure';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import {
  GitIgnoreHostError,
  type GitIgnoreCheckRequest,
  type GitIgnoreHostFailureCode,
  type GitIgnoreHostPort,
} from '@canopy/core-runtime/node';
import {
  GitReadError,
  type GitReadEnvironment,
  isHostAbsolute,
  validateEnvironment,
} from './commands';
import {
  createGitReadRunner,
  type GitReadRunner,
  type GitReadRunnerOptions,
} from './runner';
import {
  createGitSelection,
  DEFAULT_SELECTION_TIMING,
  type GitSelection,
  NODE_SELECTION_IO,
  type SelectionAccount,
  type SelectionIo,
  type SelectionTiming,
} from './selection';

export interface GitReadHostCleanupReport {
  readonly kind: 'scratch_removal' | 'kill';
  readonly outcome: 'failed' | 'cleanup_unconfirmed';
}

export interface GitReadHostOptions {
  readonly os: PlatformOperatingSystem;
  /** Daemon's own startup env after claim-marker removal. Copied once; undefined dropped. Never a client's. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Trusted absolute directory: cwd for validation/discovery probes. L2 passes the canonical data root (0700). */
  readonly probeDirectory: string;
  readonly onCleanupReport?: (report: GitReadHostCleanupReport) => void;
}

export interface GitReadHost {
  readonly port: GitIgnoreHostPort;
  /** darwin and linux-x64: start the login-PATH refresh; otherwise a no-op. Never throws. */
  prewarm(this: void): void;
  lastFailure(this: void): GitIgnoreHostFailureCode | null;
  stop(
    this: void,
    signal: AbortSignal,
  ): Promise<{ readonly state: 'stopped' | 'cleanup_unconfirmed' }>;
}

export interface GitReadHostTiming extends SelectionTiming {
  /** One deadline across a request's selections and chunks (U1's 30 s). */
  readonly requestDeadlineMs: number;
}

/** Private seams, reachable only by relative import (tests). */
export interface GitReadHostSeams {
  readonly arch?: string;
  readonly io?: SelectionIo;
  /** Monotonic clock for the rejection and login-PATH TTLs. */
  readonly now?: () => number;
  readonly timing?: Partial<GitReadHostTiming>;
  readonly userInfo?: () => SelectionAccount;
  readonly uid?: () => number | undefined;
  /** The runner's test seams; the host always sets os, signal and reporters. */
  readonly runner?: Pick<
    GitReadRunnerOptions,
    'operations' | 'timing' | 'scratch' | 'isExecutable'
  >;
  readonly createRunner?: (options: GitReadRunnerOptions) => GitReadRunner;
}

/** One caller field, read once; a throwing getter reads as absent. */
function fieldOf(source: unknown, key: string): unknown {
  try {
    return Reflect.get(Object(source), key);
  } catch {
    return undefined;
  }
}

/** The startup snapshot, copied once; `null` when it cannot be read. */
function copyEnvironment(source: unknown): Record<string, unknown> | null {
  try {
    if (typeof source !== 'object' || source === null) return null;
    const copied: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source))
      if (value !== undefined) copied[key] = value;
    return copied;
  } catch {
    return null;
  }
}

function isSpawnFailure(error: unknown): boolean {
  const syscall = fieldOf(error, 'syscall');
  return typeof syscall === 'string' && syscall.startsWith('spawn');
}

function defaultAccount(): SelectionAccount {
  const info = userInfo();
  return { username: info.username, shell: info.shell };
}

/**
 * Read-only Git selection and `check-ignore` for a long-lived daemon, over
 * the private runner. Construction does no I/O and never throws; a request
 * with an unusable snapshot or probe directory rejects `invalid_request`.
 */
export function createGitReadHost(options: GitReadHostOptions): GitReadHost {
  return createGitReadHostWith(options, {});
}

export function createGitReadHostWith(
  options: GitReadHostOptions,
  seams: GitReadHostSeams,
): GitReadHost {
  const os = fieldOf(options, 'os');
  const closure =
    os === 'win32' ? observeWindowsClosure('git-host') : undefined;
  const checkClosureContext =
    os === 'win32' ? captureWindowsClosureContext() : undefined;
  const probeDirectory = fieldOf(options, 'probeDirectory');
  const reporter = fieldOf(options, 'onCleanupReport');
  const snapshot = copyEnvironment(fieldOf(options, 'environment'));
  const timing: GitReadHostTiming = {
    ...DEFAULT_SELECTION_TIMING,
    requestDeadlineMs: 30_000,
    ...seams.timing,
  };
  const stopping = new AbortController();
  let stopped = false;
  let failure: GitIgnoreHostFailureCode | null = null;

  function report(outcome: GitReadHostCleanupReport): void {
    try {
      if (typeof reporter === 'function')
        Reflect.apply(reporter, undefined, [Object.freeze(outcome)]);
    } catch {
      // A failing reporter must not change a request or surface as unhandled.
    }
  }

  interface Ready {
    readonly os: PlatformOperatingSystem;
    readonly environment: GitReadEnvironment;
    readonly runner: GitReadRunner;
    readonly selection: GitSelection;
  }
  let ready: Ready | null | undefined;

  /** Validated once, on first use; the snapshot never changes after. */
  function readiness(): Ready | null {
    if (ready !== undefined) return ready;
    ready = null;
    const supported = os === 'darwin' || os === 'linux' || os === 'win32';
    if (
      !supported ||
      snapshot === null ||
      typeof probeDirectory !== 'string' ||
      !isHostAbsolute(os, probeDirectory)
    )
      return ready;
    let environment: GitReadEnvironment;
    try {
      environment = validateEnvironment(snapshot);
    } catch {
      return ready;
    }
    const runner = (seams.createRunner ?? createGitReadRunner)({
      ...seams.runner,
      os,
      hostSignal: stopping.signal,
      onKillCleanup: (outcome) => report({ kind: 'kill', outcome }),
      onScratchCleanupFailure: (error) =>
        report({
          kind: 'scratch_removal',
          outcome:
            error instanceof GitReadError &&
            error.code === 'cleanup_unconfirmed'
              ? 'cleanup_unconfirmed'
              : 'failed',
        }),
    });
    const selection = createGitSelection({
      os,
      arch: seams.arch ?? process.arch,
      environment,
      probeDirectory,
      runner,
      io: seams.io ?? NODE_SELECTION_IO,
      now: seams.now ?? ((): number => performance.now()),
      timing,
      hostSignal: stopping.signal,
      userInfo: seams.userInfo ?? defaultAccount,
      uid: seams.uid ?? ((): number | undefined => process.getuid?.()),
    });
    ready = { os, environment, runner, selection };
    return ready;
  }

  function failWith(code: GitIgnoreHostFailureCode): never {
    failure = code;
    throw new GitIgnoreHostError(code);
  }

  function codeOf(error: unknown): GitIgnoreHostFailureCode {
    if (error instanceof GitIgnoreHostError) return error.code;
    if (stopping.signal.aborted) return 'stopped';
    if (error instanceof GitReadError)
      return error.code === 'command_not_found'
        ? 'git_unavailable'
        : error.code;
    // A raw spawn error (no pid) means the executable could not start; other
    // raw errors (a stdin EPIPE) are Git failing the request.
    return isSpawnFailure(error) ? 'git_unavailable' : 'exit_status';
  }

  async function checkIgnoredPaths(
    request: GitIgnoreCheckRequest,
  ): Promise<Set<string>> {
    checkClosureContext?.();
    // Each field is read once: an untyped caller's getters run no later.
    const signal = fieldOf(request, 'signal');
    if (signal instanceof AbortSignal) signal.throwIfAborted();
    if (stopped) failWith('stopped');
    const root = fieldOf(request, 'root');
    const paths = fieldOf(request, 'relativePaths');
    const readSaved = fieldOf(request, 'readSavedExecutablePath');
    if (
      !(signal instanceof AbortSignal) ||
      typeof root !== 'string' ||
      !Array.isArray(paths) ||
      typeof readSaved !== 'function'
    )
      failWith('invalid_request');
    if (paths.length === 0) return new Set();
    const host = readiness();
    if (host === null) failWith('invalid_request');
    const readSavedExecutablePath = (saved: AbortSignal): Promise<unknown> =>
      Promise.resolve().then((): unknown =>
        Reflect.apply(readSaved, request, [saved]),
      );
    try {
      const ignored = await host.runner.checkIgnoredPathsSelected({
        cwd: root,
        paths,
        environment: host.environment,
        deadlineAt: performance.now() + timing.requestDeadlineMs,
        signal,
        executableForChunk: async (_chunk, selectionSignal) => {
          try {
            return await host.selection.select(
              readSavedExecutablePath,
              selectionSignal,
            );
          } catch (error) {
            if (error instanceof GitIgnoreHostError || selectionSignal.aborted)
              throw error;
            throw new GitIgnoreHostError('git_unavailable');
          }
        },
      });
      failure = null;
      return ignored;
    } catch (error) {
      signal.throwIfAborted();
      return failWith(codeOf(error));
    }
  }

  function prewarm(): void {
    checkClosureContext?.();
    try {
      if (!stopped) readiness()?.selection.prewarm();
    } catch {
      // Prewarming is advisory.
    }
  }

  async function stop(
    signal: AbortSignal,
  ): Promise<{ readonly state: 'stopped' | 'cleanup_unconfirmed' }> {
    checkClosureContext?.();
    if (!(signal instanceof AbortSignal))
      throw new GitIgnoreHostError('invalid_request');
    if (stopped) throw new GitIgnoreHostError('stopped');
    stopped = true;
    stopping.abort(new GitIgnoreHostError('stopped'));
    const host = ready ?? null;
    if (host === null) {
      closure?.close();
      return { state: 'stopped' };
    }
    const selection = await host.selection.whenIdle(signal);
    const runner = await host.runner.whenIdle(signal);
    if (selection !== 'idle' || runner !== 'idle') closure?.unsafe();
    closure?.close();
    return {
      state:
        selection === 'idle' && runner === 'idle'
          ? 'stopped'
          : 'cleanup_unconfirmed',
    };
  }

  return Object.freeze({
    port: Object.freeze({ checkIgnoredPaths }),
    prewarm,
    lastFailure: (): GitIgnoreHostFailureCode | null => failure,
    stop,
  });
}
