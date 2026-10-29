import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import { createChildServices } from '../supervision/child';
import { killProcessTree } from '../supervision/kill-tree';
import {
  captureWindowsClosureContext,
  observeWindowsClosure,
} from '../supervision/windows-closure';
import {
  NODE_SUPERVISION,
  type SupervisionOperations,
} from '../supervision/shared';
import {
  GitReadError,
  type GitReadCommand,
  type GitReadEnvironment,
  type GitReadPlan,
  isHostAbsolute,
  planGitReadCommand,
  searchPath,
  validateEnvironment,
  windowsChildEnvironment,
  windowsEnvironmentValue,
} from './commands';
import {
  type ExecutableProbe,
  nodeExecutableProbe,
  resolveBareCommand,
} from './resolve';

export interface GitReadTiming {
  /** Window for held pipes to close after the root exits. */
  readonly drainMs: number;
  /** Time kept before the request deadline to stop, reap and drain. */
  readonly cleanupReserveMs: number;
  /** Graceful stops escalate to a forced group kill after this delay. */
  readonly escalateMs: number;
  /** One deadline across every `check-ignore` chunk (desktop git.ts:84). */
  readonly requestDeadlineMs: number;
}

const DEFAULT_TIMING: GitReadTiming = {
  drainMs: 250,
  cleanupReserveMs: 2_000,
  escalateMs: 1_000,
  requestDeadlineMs: 30_000,
};
const CHECK_IGNORE_CHUNK_SIZE = 5_000;
// setTimeout overflows above this; longer waits re-arm.
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface GitReadRunnerOptions {
  readonly os: PlatformOperatingSystem;
  /** Aborting it stops every in-flight request and refuses new ones. */
  readonly hostSignal?: AbortSignal;
  /** Test seams; production uses NODE_SUPERVISION. */
  readonly operations?: Partial<SupervisionOperations>;
  readonly timing?: Partial<GitReadTiming>;
  /** Test seam for the bare-init scratch directory. */
  readonly scratch?: Partial<ScratchOperations>;
  /** Test seam for PATH resolution of a bare command. */
  readonly isExecutable?: ExecutableProbe;
  /** A failed scratch removal; it never replaces the request's result. */
  readonly onScratchCleanupFailure?: (error: unknown) => void;
  /**
   * A group kill still running when its request settled
   * (`cleanup_unconfirmed`), and its failure after that (`failed`). Neither
   * changes the settled request.
   */
  readonly onKillCleanup?: (outcome: 'failed' | 'cleanup_unconfirmed') => void;
}

export interface ScratchOperations {
  create(prefix: string): Promise<string>;
  remove(directory: string): Promise<void>;
}

const NODE_SCRATCH: ScratchOperations = {
  create: (prefix) => mkdtemp(prefix),
  remove: (directory) => rm(directory, { recursive: true, force: true }),
};

export interface GitReadRequest {
  /** Every command runs in an explicit directory. */
  readonly cwd: string;
  readonly environment: GitReadEnvironment;
  /** Monotonic `performance.now()` time by which the request settles. */
  readonly deadlineAt: number;
  readonly signal?: AbortSignal;
}

export interface GitReadOutput {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  /** `abandoned`: a group member still held a pipe after the drain window. */
  readonly pipes: 'closed' | 'abandoned';
}

export interface GitCheckIgnoreSelection {
  readonly cwd: string;
  readonly paths: readonly string[];
  readonly environment: GitReadEnvironment;
  /** Monotonic; set before the first selection and shared by every chunk. */
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  /**
   * The executable for chunk `chunk` (0-based), awaited before that chunk
   * runs. While it is awaited, a request or host abort, or the cleanup
   * reserve, aborts its signal and rejects the request.
   */
  readonly executableForChunk: (
    chunk: number,
    signal: AbortSignal,
    deadlineAt: number,
  ) => Promise<string>;
}

export interface GitReadRunner {
  run(command: GitReadCommand, request: GitReadRequest): Promise<GitReadOutput>;
  /**
   * Desktop `checkIgnoredPaths`: sequential 5,000-path chunks; exit 1 is an
   * empty chunk; any other failure rejects and discards earlier chunks.
   */
  checkIgnoredPathsWith(
    executable: string,
    cwd: string,
    paths: readonly string[],
    environment: GitReadEnvironment,
    signal?: AbortSignal,
  ): Promise<Set<string>>;
  /** `checkIgnoredPathsWith`, selecting the executable before each chunk. */
  checkIgnoredPathsSelected(
    request: GitCheckIgnoreSelection,
  ): Promise<Set<string>>;
  /**
   * `idle` once no request is in flight and no owned root, continuing kill or
   * scratch creation or removal remains; `pending` if `signal` aborts first.
   */
  whenIdle(signal: AbortSignal): Promise<'idle' | 'pending'>;
}

type Settlement =
  | { readonly output: GitReadOutput }
  | { readonly error: unknown };

type Waited<T> =
  | { readonly value: T }
  | { readonly error: unknown }
  | { readonly aborted: unknown }
  | { readonly expired: true };

/** Runs `run` at monotonic time `at`; returns a cancel function. */
function timerAt(at: number, run: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    const wait = at - performance.now();
    timer = setTimeout(
      () => (wait > MAX_TIMER_MS ? arm() : run()),
      Math.min(Math.max(0, wait), MAX_TIMER_MS),
    );
  };
  arm();
  return () => clearTimeout(timer);
}

/** Counts outstanding work; `whenIdle` waits for none to remain. */
function createActivity(): {
  begin(): () => void;
  track<T>(work: Promise<T>): Promise<T>;
  whenIdle(signal: AbortSignal): Promise<'idle' | 'pending'>;
} {
  let outstanding = 0;
  const waiters = new Set<() => void>();
  function begin(): () => void {
    outstanding += 1;
    let ended = false;
    return (): void => {
      if (ended) return;
      ended = true;
      outstanding -= 1;
      if (outstanding === 0) waiters.forEach((wake) => wake());
    };
  }
  function track<T>(work: Promise<T>): Promise<T> {
    const end = begin();
    work.then(end, end);
    return work;
  }
  function whenIdle(signal: AbortSignal): Promise<'idle' | 'pending'> {
    return new Promise((settle) => {
      if (outstanding === 0) return settle('idle');
      if (signal.aborted) return settle('pending');
      const finish = (state: 'idle' | 'pending'): void => {
        waiters.delete(wake);
        signal.removeEventListener('abort', abort);
        settle(state);
      };
      const wake = (): void => finish('idle');
      const abort = (): void => finish('pending');
      waiters.add(wake);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  return { begin, track, whenIdle };
}

/** Desktop's execFile `maxBuffer`: bytes of the UTF-8-decoded chunks, per stream. */
class StreamCapture {
  private readonly decoder = new StringDecoder('utf8');
  private readonly chunks: string[] = [];
  private bytes = 0;
  overflowed = false;

  constructor(private readonly limit: number) {}

  /** Returns true when this chunk first crosses the limit. */
  write(chunk: Buffer): boolean {
    return this.add(this.decoder.write(chunk));
  }

  end(): boolean {
    return this.add(this.decoder.end());
  }

  text(): string {
    return this.chunks.join('');
  }

  private add(text: string): boolean {
    if (text === '' || this.overflowed) return false;
    this.bytes += Buffer.byteLength(text, 'utf8');
    if (this.bytes > this.limit) return (this.overflowed = true);
    this.chunks.push(text);
    return false;
  }
}

/**
 * taskkill's SystemRoot comes from the child's environment, never ambient
 * state, and is the variant the child sees.
 */
export function supervisionFor(
  environment: GitReadEnvironment,
  overrides?: Partial<SupervisionOperations>,
): SupervisionOperations {
  const systemRoot = (): string =>
    windowsEnvironmentValue(environment, 'SystemRoot') ?? '';
  return { ...NODE_SUPERVISION, systemRoot, ...overrides };
}

export function createGitReadRunner(
  options: GitReadRunnerOptions,
): GitReadRunner {
  const { os, hostSignal } = options;
  const checkClosureContext =
    os === 'win32' ? captureWindowsClosureContext() : undefined;
  const timing: GitReadTiming = { ...DEFAULT_TIMING, ...options.timing };
  const scratch: ScratchOperations = { ...NODE_SCRATCH, ...options.scratch };
  const isExecutable = options.isExecutable ?? nodeExecutableProbe(os);
  const childOptions = createChildServices(os).childProcessOptions({
    lifetime: 'owned',
  });
  const activity = createActivity();

  function reportKill(outcome: 'failed' | 'cleanup_unconfirmed'): void {
    try {
      options.onKillCleanup?.(outcome);
    } catch {
      // A failing reporter must not change the request or surface as unhandled.
    }
  }

  function signalsOf(request: GitReadRequest): AbortSignal[] {
    return [request.signal, hostSignal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
  }

  /** Settles once; abort reasons are arbitrary values, so failures resolve too. */
  function execute(
    kind: GitReadCommand['kind'],
    plan: GitReadPlan,
    request: GitReadRequest,
  ): Promise<Settlement> {
    return new Promise((settle) => {
      const resolve = (output: GitReadOutput): void => settle({ output });
      const reject = (error: unknown): void => settle({ error });
      const signals = signalsOf(request);
      const preAborted = signals.find((signal) => signal.aborted);
      if (preAborted) return reject(preAborted.reason);
      const startedAt = performance.now();
      const stopBy = request.deadlineAt - timing.cleanupReserveMs;
      if (stopBy <= startedAt)
        return reject(new GitReadError('deadline_exceeded'));
      const probeLimited =
        plan.timeoutMs !== undefined && startedAt + plan.timeoutMs <= stopBy;

      const closure = os === 'win32' ? observeWindowsClosure('git') : undefined;
      // check-ignore may start an fsmonitor daemon that outlives it (E3);
      // nothing discharges that yet, so its history is never accepted.
      if (kind === 'git-check-ignore') closure?.unsafe();
      let child: ChildProcess;
      try {
        child = spawn(plan.file, [...plan.args], {
          ...childOptions,
          cwd: request.cwd,
          env: plan.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        closure?.unsafe();
        closure?.close();
        return reject(error);
      }
      child.once('close', (code, signal) => {
        if (signal !== null || code === null || code === 259) closure?.unsafe();
        closure?.close();
      });
      // An unconfirmed root stays outstanding after settlement until it exits.
      const rootEnded = activity.begin();
      child.once('exit', rootEnded);
      child.on('error', () => {
        if (child.pid === undefined) rootEnded();
      });

      const ops = supervisionFor(plan.env, options.operations);
      const stdout = new StreamCapture(plan.maxBuffer);
      const stderr = new StreamCapture(plan.maxBuffer);
      const timers = new Set<ReturnType<typeof setTimeout>>();
      let settled = false;
      let pipesClosed = false;
      let exit: { code: number | null; signal: string | null } | undefined;
      let spawnError: unknown;
      // The first failure or abort decides the result; later ones are dropped.
      let cause: { readonly error: unknown } | undefined;
      let aborted = false;
      let killFailure: unknown;
      let stopping = false;
      let cleanupEnd = request.deadlineAt;
      let cleanupExpired = false;
      let killsInFlight = 0;
      let finishPending = false;

      const after = (at: number, run: () => void): void => {
        const wait = at - performance.now();
        const timer = setTimeout(
          () => {
            timers.delete(timer);
            if (wait > MAX_TIMER_MS) after(at, run);
            else run();
          },
          Math.min(Math.max(0, wait), MAX_TIMER_MS),
        );
        timers.add(timer);
      };

      const finish = (): void => {
        if (settled) return;
        // Windows taskkill is asynchronous: settle after it, within the
        // reserve. One still running then continues within the port's bound.
        if (killsInFlight > 0 && !cleanupExpired) {
          finishPending = true;
          return;
        }
        settled = true;
        if (!pipesClosed && spawnError === undefined) closure?.unsafe();
        for (let kill = 0; kill < killsInFlight; kill += 1)
          reportKill('cleanup_unconfirmed');
        timers.forEach(clearTimeout);
        listeners.forEach(([signal, listener]) =>
          signal.removeEventListener('abort', listener),
        );
        const confirmed = exit !== undefined || spawnError !== undefined;
        // stdin stays open for commands without input, as in desktop.
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        // An unconfirmed root must not keep the host alive.
        if (!confirmed) child.unref();
        if (!confirmed)
          return reject(
            new GitReadError('cleanup_unconfirmed', {
              failure: killFailure ?? cause?.error,
            }),
          );
        if (cause) return reject(cause.error);
        if (spawnError !== undefined) return reject(spawnError);
        resolve(
          Object.freeze({
            code: exit?.code ?? null,
            signal: exit?.signal ?? null,
            stdout: stdout.text(),
            stderr: stderr.text(),
            pipes: pipesClosed ? 'closed' : 'abandoned',
          }),
        );
      };

      // Only from a timer or setImmediate turn: never an exit/close listener
      // or a continuation of one, where a reaped root still reads as live.
      const signalGroup = (mode: 'graceful' | 'force'): void => {
        if (settled || child.exitCode !== null || child.signalCode !== null)
          return;
        const pid = child.pid;
        if (pid === undefined) return;
        closure?.unsafe();
        killsInFlight += 1;
        const killEnded = activity.begin();
        // No signal: an aborted one would end taskkill and leave the tree.
        killProcessTree(os, { pid, mode }, ops)
          .catch((error: unknown) => {
            if (!settled) killFailure ??= error;
            else reportKill('failed');
          })
          .finally(() => {
            killsInFlight -= 1;
            killEnded();
            if (finishPending && killsInFlight === 0) finish();
          });
      };

      const stop = (): void => {
        if (stopping || settled) return;
        stopping = true;
        if (exit !== undefined) return finish();
        cleanupEnd = Math.min(
          performance.now() + timing.cleanupReserveMs,
          request.deadlineAt,
        );
        setImmediate(() => signalGroup(plan.killMode));
        // taskkill always forces on Windows.
        if (plan.killMode === 'graceful' && os !== 'win32')
          after(performance.now() + timing.escalateMs, () =>
            signalGroup('force'),
          );
        after(cleanupEnd, () => {
          cleanupExpired = true;
          finish();
        });
      };

      const fail = (error: unknown): void => {
        closure?.unsafe();
        cause ??= { error };
      };

      const listeners = signals.map((signal): [AbortSignal, () => void] => [
        signal,
        (): void => {
          aborted = true;
          fail(signal.reason);
          stop();
        },
      ]);
      listeners.forEach(([signal, listener]) =>
        signal.addEventListener('abort', listener, { once: true }),
      );

      const capture = (
        stream: NodeJS.ReadableStream | null,
        sink: StreamCapture,
        name: 'stdout' | 'stderr',
      ): void => {
        const overflow = (crossed: boolean): void => {
          if (!crossed) return;
          fail(new GitReadError('output_limit', { stream: name }));
          stop();
        };
        stream?.on('data', (chunk: Buffer) => overflow(sink.write(chunk)));
        stream?.on('end', () => overflow(sink.end()));
        // Destroyed or failed pipes end the capture; exit decides the result.
        stream?.on('error', () => undefined);
      };
      capture(child.stdout, stdout, 'stdout');
      capture(child.stderr, stderr, 'stderr');

      // A stdin failure before the pipes close wins and settles promptly, as
      // desktop's EPIPE does; a root still reading nothing is stopped.
      child.stdin?.on('error', (error) => {
        if (pipesClosed || settled) return;
        fail(error);
        stop();
      });
      // An empty write to a root that already closed stdin fails with EPIPE
      // though nothing was lost, so empty input only ends the stream.
      if (plan.input?.byteLength) child.stdin?.end(plan.input);
      else if (plan.input) child.stdin?.end();

      child.on('error', (error) => {
        if (child.pid !== undefined) return;
        // A discarded probe stays unsafe: its spawn-failure close is negative.
        closure?.unsafe();
        spawnError = error;
        finish();
      });
      child.once('exit', (code, signal) => {
        exit = { code, signal };
        if (aborted) return finish();
        // Group members left running after a normal exit stay alone.
        const drainEnd = Math.min(
          performance.now() + timing.drainMs,
          stopping ? cleanupEnd : request.deadlineAt,
        );
        after(drainEnd, finish);
      });
      child.once('close', () => {
        pipesClosed = true;
        if (exit !== undefined) finish();
      });

      // Once the root has exited, only the drain window remains.
      const expire = (code: 'timeout' | 'deadline_exceeded'): void => {
        if (exit !== undefined) return;
        fail(new GitReadError(code));
        stop();
      };
      after(stopBy, () => expire('deadline_exceeded'));
      if (probeLimited && plan.timeoutMs !== undefined)
        after(startedAt + plan.timeoutMs, () => expire('timeout'));
    });
  }

  function validateRequest(request: GitReadRequest): GitReadEnvironment {
    if (
      typeof request.cwd !== 'string' ||
      !isHostAbsolute(os, request.cwd) ||
      typeof request.deadlineAt !== 'number' ||
      !Number.isFinite(request.deadlineAt)
    )
      throw new GitReadError('invalid_request');
    return validateEnvironment(request.environment);
  }

  /**
   * Resolves a bare command through the supplied PATH by the request's stop
   * time, unless aborted. Nothing has started, so nothing needs cleanup.
   */
  async function resolved(
    plan: GitReadPlan,
    request: GitReadRequest,
  ): Promise<GitReadPlan> {
    if (isHostAbsolute(os, plan.file)) return plan;
    const signals = signalsOf(request);
    signals.forEach((signal) => signal.throwIfAborted());
    const stopBy = request.deadlineAt - timing.cleanupReserveMs;
    if (stopBy <= performance.now())
      throw new GitReadError('deadline_exceeded');
    const lookup = resolveBareCommand(
      os,
      plan.file,
      searchPath(os, plan.env),
      isExecutable,
    );
    const found = await waitWithin(lookup, stopBy, signals);
    if ('aborted' in found) throw found.aborted;
    if ('expired' in found) throw new GitReadError('deadline_exceeded');
    if ('error' in found) throw found.error;
    if (found.value === undefined) throw new GitReadError('command_not_found');
    return Object.freeze({ ...plan, file: found.value });
  }

  async function outputOf(work: Promise<Settlement>): Promise<GitReadOutput> {
    const settlement = await work;
    if ('error' in settlement) throw settlement.error;
    return settlement.output;
  }

  /** `work`'s outcome, the first abort, or expiry at `at`; `work` runs on. */
  function waitWithin<T>(
    work: Promise<T>,
    at: number,
    signals: readonly AbortSignal[],
  ): Promise<Waited<T>> {
    return new Promise((settle) => {
      const preAborted = signals.find((signal) => signal.aborted);
      if (preAborted) return settle({ aborted: preAborted.reason });
      const listeners = signals.map((signal): [AbortSignal, () => void] => [
        signal,
        (): void => finish({ aborted: signal.reason }),
      ]);
      let cancelTimer = (): void => undefined;
      let done = false;
      function finish(result: Waited<T>): void {
        if (done) return;
        done = true;
        cancelTimer();
        listeners.forEach(([signal, listener]) =>
          signal.removeEventListener('abort', listener),
        );
        settle(result);
      }
      listeners.forEach(([signal, listener]) =>
        signal.addEventListener('abort', listener, { once: true }),
      );
      cancelTimer = timerAt(at, () => finish({ expired: true }));
      work.then(
        (value) => finish({ value }),
        (error: unknown) => finish({ error }),
      );
    });
  }

  /** Cleanup problems are reported, never thrown: the request's result stands. */
  function reportScratchFailure(error: unknown): void {
    try {
      options.onScratchCleanupFailure?.(error);
    } catch {
      // A failing reporter must not surface as an unhandled rejection.
    }
  }

  /** Outstanding until it settles, past the request when its bound ends first. */
  function removeScratch(directory: string): Promise<void> {
    return activity.track(
      Promise.resolve()
        .then(() => scratch.remove(directory))
        .catch(reportScratchFailure),
    );
  }

  /**
   * Waits for `removal` until `at`, reporting one still pending then as
   * `cleanup_unconfirmed`. An abort does not cut removal short; it is returned.
   */
  async function awaitRemoval(
    removal: Promise<void>,
    at: number,
    signals: readonly AbortSignal[],
  ): Promise<{ readonly aborted: unknown } | undefined> {
    const first = await waitWithin(removal, at, signals);
    const last = 'aborted' in first ? await waitWithin(removal, at, []) : first;
    if ('expired' in last)
      reportScratchFailure(new GitReadError('cleanup_unconfirmed'));
    return 'aborted' in first ? first : undefined;
  }

  /**
   * Desktop parity: the smoke writes, then removes, a scratch directory. Both
   * run under the request's deadline and abort, and removal never replaces
   * the result. Creation or removal still pending at its bound continues
   * after settlement; a late directory is removed when it appears.
   */
  async function runBareInitSmoke(
    command: Extract<GitReadCommand, { kind: 'git-bare-init-smoke' }>,
    request: GitReadRequest,
  ): Promise<GitReadOutput> {
    const { environment } = request;
    // Validates and resolves the command before anything is written.
    const { file } = await resolved(
      planGitReadCommand(os, command, environment, command.temporaryRoot),
      request,
    );
    const signals = signalsOf(request);
    signals.forEach((signal) => signal.throwIfAborted());
    const stopBy = request.deadlineAt - timing.cleanupReserveMs;
    if (stopBy <= performance.now())
      throw new GitReadError('deadline_exceeded');
    // One reserve from the first abort covers the stop and the removal.
    let abortedAt: number | undefined;
    const noteAbort = (): void => {
      abortedAt ??= performance.now();
    };
    signals.forEach((signal) =>
      signal.addEventListener('abort', noteAbort, { once: true }),
    );
    const cleanupEnd = (): number =>
      Math.min(
        (abortedAt ?? performance.now()) + timing.cleanupReserveMs,
        request.deadlineAt,
      );

    try {
      const creating = Promise.resolve().then(() =>
        scratch.create(path.join(command.temporaryRoot, 'git-validation-')),
      );
      const created = await waitWithin(creating, stopBy, signals);
      if ('error' in created) throw created.error;
      if (!('value' in created)) {
        // A late directory, and its removal, stay outstanding.
        const removal = activity.track(
          creating.then(removeScratch, () => undefined),
        );
        await awaitRemoval(removal, cleanupEnd(), []);
        throw 'aborted' in created
          ? created.aborted
          : new GitReadError('deadline_exceeded');
      }

      const directory = created.value;
      const settlement = await Promise.resolve()
        .then(() =>
          execute(
            command.kind,
            {
              ...planGitReadCommand(os, command, environment, directory),
              file,
            },
            request,
          ),
        )
        .catch((error: unknown): Settlement => ({ error }));
      // As in the drain, an abort before settlement wins over a success.
      const aborted = await awaitRemoval(
        removeScratch(directory),
        cleanupEnd(),
        signals,
      );
      if ('error' in settlement) throw settlement.error;
      if (aborted) throw aborted.aborted;
      return settlement.output;
    } finally {
      signals.forEach((signal) =>
        signal.removeEventListener('abort', noteAbort),
      );
    }
  }

  /** Outstanding from the call until it settles. */
  async function tracked<T>(work: () => Promise<T>): Promise<T> {
    checkClosureContext?.();
    const end = activity.begin();
    try {
      return await work();
    } finally {
      end();
    }
  }

  async function runUntracked(
    command: GitReadCommand,
    request: GitReadRequest,
  ): Promise<GitReadOutput> {
    const environment = validateRequest(request);
    const checked = { ...request, environment };
    if (command.kind === 'git-bare-init-smoke')
      return runBareInitSmoke(command, checked);
    const plan = await resolved(
      planGitReadCommand(os, command, environment),
      checked,
    );
    return outputOf(execute(command.kind, plan, checked));
  }

  function run(
    command: GitReadCommand,
    request: GitReadRequest,
  ): Promise<GitReadOutput> {
    return tracked(() => runUntracked(command, request));
  }

  /**
   * The caller's executable for one chunk, awaited until the stop time or an
   * abort. The selection's signal then aborts; its late result is ignored.
   */
  async function selectExecutable(
    request: GitCheckIgnoreSelection,
    chunk: number,
    signals: readonly AbortSignal[],
  ): Promise<string> {
    signals.forEach((signal) => signal.throwIfAborted());
    const stopBy = request.deadlineAt - timing.cleanupReserveMs;
    if (stopBy <= performance.now())
      throw new GitReadError('deadline_exceeded');
    const selection = new AbortController();
    const selecting = Promise.resolve().then(() =>
      request.executableForChunk(chunk, selection.signal, request.deadlineAt),
    );
    const selected = await waitWithin(selecting, stopBy, signals);
    if ('value' in selected) return selected.value;
    if ('error' in selected) throw selected.error;
    const failure =
      'aborted' in selected
        ? selected.aborted
        : new GitReadError('deadline_exceeded');
    selection.abort(failure);
    throw failure;
  }

  function validSelection(request: GitCheckIgnoreSelection): boolean {
    return (
      typeof request === 'object' &&
      request !== null &&
      Array.isArray(request.paths) &&
      request.paths.every((entry) => typeof entry === 'string') &&
      request.signal instanceof AbortSignal &&
      typeof request.executableForChunk === 'function' &&
      typeof request.deadlineAt === 'number' &&
      Number.isFinite(request.deadlineAt)
    );
  }

  async function checkIgnoredPathsUntracked(
    request: GitCheckIgnoreSelection,
  ): Promise<Set<string>> {
    if (!validSelection(request)) throw new GitReadError('invalid_request');
    const { cwd, paths, deadlineAt, signal } = request;
    const signals = signalsOf(request);
    signals.forEach((each) => each.throwIfAborted());
    const ignored = new Set<string>();
    if (paths.length === 0) return ignored;
    // The whole request is checked before the caller's first selection.
    const environment = validateRequest(request);
    if (os === 'win32') windowsChildEnvironment(environment);
    for (let i = 0; i < paths.length; i += CHECK_IGNORE_CHUNK_SIZE) {
      const executable = await selectExecutable(
        request,
        i / CHECK_IGNORE_CHUNK_SIZE,
        signals,
      );
      const chunk = paths.slice(i, i + CHECK_IGNORE_CHUNK_SIZE);
      const input = Buffer.from(`${chunk.join('\0')}\0`, 'utf8');
      const output = await runUntracked(
        { kind: 'git-check-ignore', executable, input },
        { cwd, environment, deadlineAt, signal },
      );
      if (output.code === 0 && output.signal === null)
        output.stdout
          .split('\0')
          .filter(Boolean)
          .forEach((ignoredPath) => ignored.add(ignoredPath));
      else if (output.code !== 1)
        throw new GitReadError('exit_status', {
          exitCode: output.code,
          signal: output.signal,
        });
    }
    return ignored;
  }

  function checkIgnoredPathsSelected(
    request: GitCheckIgnoreSelection,
  ): Promise<Set<string>> {
    return tracked(() => checkIgnoredPathsUntracked(request));
  }

  /** One request deadline across every chunk (desktop git.ts:84). */
  function checkIgnoredPathsWith(
    executable: string,
    cwd: string,
    paths: readonly string[],
    environment: GitReadEnvironment,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<Set<string>> {
    return checkIgnoredPathsSelected({
      cwd,
      paths,
      environment,
      deadlineAt: performance.now() + timing.requestDeadlineMs,
      signal,
      executableForChunk: () => Promise.resolve(executable),
    });
  }

  function whenIdle(signal: AbortSignal): Promise<'idle' | 'pending'> {
    checkClosureContext?.();
    if (!(signal instanceof AbortSignal))
      return Promise.reject(new GitReadError('invalid_request'));
    return activity.whenIdle(signal);
  }

  return Object.freeze({
    run,
    checkIgnoredPathsWith,
    checkIgnoredPathsSelected,
    whenIdle,
  });
}
