import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { utilityProcess, type UtilityProcess } from 'electron';
import type {
  SpawnOptions,
  SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk';
import { killProcessGroupByPid } from '@canopy/desktop-shared/node/lib/process-kill';
import type {
  ClaudeProcessHostRequest,
  ClaudeProcessHostResponse,
} from './claude-process-host-protocol';
import {
  registerHostedClaudeProcess,
  unregisterHostedClaudeProcess,
} from './claude-process-registry';

const WORKER_ENTRY_FILENAME = 'claude-process-host-worker.js';
const WORKER_SERVICE_NAME = 'claude-process-host';
const SHUTDOWN_WAIT_MS = 6_000;
const FORCED_EXIT_CLEANUP_WAIT_MS = 6_000;
const DEFAULT_CLI_MAX_OUTPUT_BYTES = 1024 * 1024;
/**
 * Owner consistency check cadence. A CLI is killed on the second check that
 * finds its owner unregistered, so loop-exit teardown (a 5 second grace) and
 * the host's SIGTERM escalation always run first.
 */
const OWNER_CHECK_INTERVAL_MS = 60_000;

/** Lifecycle diagnostics for a CLI a chat or delegated run spawned. */
export type HostedClaudeProcessDiagnostic =
  | { kind: 'claude_process_started'; pid: number }
  | {
      kind: 'claude_process_exited';
      pid: number;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      uptimeMs: number;
    }
  | {
      kind: 'claude_process_untracked';
      /** Absent when the host had not reported the PID yet. */
      pid?: number;
      uptimeMs?: number;
    };

/**
 * The chat a hosted CLI belongs to: a chat session instance's own CLI, or a
 * delegated run's CLI under its parent chat's `sessionKey`.
 */
export interface HostedClaudeProcessOwner {
  sessionKey: string;
  sessionInstanceId?: string;
  delegationId?: string;
  /**
   * Whether the owning session instance is still registered under its key.
   * Absent for delegated runs, which outlive their parent's session by design.
   */
  isRegistered?: () => boolean;
  recordDiagnostic(diagnostic: HostedClaudeProcessDiagnostic): void;
}

interface WorkerExitState {
  child: UtilityProcess;
  promise: Promise<void>;
  resolve: () => void;
}

interface TrackedClaudeProcess {
  child: UtilityProcess;
  pid: number;
}

interface StdoutCreditHold {
  proxy: ClaudeProcessProxy | null;
}

let worker: UtilityProcess | null = null;
let workerExitState: WorkerExitState | null = null;
let shuttingDown = false;
const active = new Map<string, ClaudeProcessProxy>();
const cleanupProcesses = new Map<string, TrackedClaudeProcess>();
let ownerCheckTimer: NodeJS.Timeout | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isResponse(value: unknown): value is ClaudeProcessHostResponse {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'shutdown-complete') return true;
  return (
    (value.type === 'started' ||
      value.type === 'stdout' ||
      value.type === 'stderr' ||
      value.type === 'exit' ||
      value.type === 'error') &&
    typeof value.requestId === 'string'
  );
}

function post(child: UtilityProcess, message: ClaudeProcessHostRequest): void {
  child.postMessage(message);
}

class ClaudeProcessProxy extends EventEmitter implements SpawnedProcess {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  /** Set once the host reports the spawned CLI's PID. */
  pid: number | null = null;
  private startedAtMs = 0;
  /** When the owner consistency check first found the owner unregistered. */
  ownerMissingSinceMs: number | null = null;
  ownerCheckKilled = false;
  private finished = false;
  private errorEmitted = false;
  private stdoutPaused = false;
  private pendingStdoutAckBytes = 0;
  private readonly stdoutCreditHolds = new Set<StdoutCreditHold>();
  /** Stdout bytes received since a credit hold has been pending. */
  private heldStdoutBytes = 0;
  /**
   * Bytes that may arrive while a credit hold is pending before credit is
   * withheld. 0, the default, withholds credit for as long as any hold is
   * pending.
   */
  private heldStdoutLimitBytes = 0;
  private readonly abortListener: () => void;
  private readonly stdoutDrainListener = (): void => {
    if (this.finished || !this.stdoutPaused) return;
    this.stdoutPaused = false;
    this.acknowledgeStdout();
  };

  private acknowledgeStdout(): void {
    if (
      this.finished ||
      (this.stdoutCreditHolds.size > 0 &&
        this.heldStdoutBytes >= this.heldStdoutLimitBytes) ||
      this.pendingStdoutAckBytes === 0
    ) {
      return;
    }
    const bytes = this.pendingStdoutAckBytes;
    this.pendingStdoutAckBytes = 0;
    try {
      post(this.child, {
        type: 'stdout-ack',
        requestId: this.requestId,
        bytes,
      });
    } catch {
      // The utility host exit path owns proxy teardown.
    }
  }

  constructor(
    readonly requestId: string,
    readonly child: UtilityProcess,
    private readonly executable: string,
    readonly owner: HostedClaudeProcessOwner | null = null,
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback): void => {
        try {
          post(this.child, {
            type: 'stdin',
            requestId: this.requestId,
            dataBase64: Buffer.from(chunk).toString('base64'),
          });
          callback();
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
      final: (callback): void => {
        try {
          post(this.child, {
            type: 'stdin-end',
            requestId: this.requestId,
          });
          callback();
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
    });
    this.abortListener = (): void => {
      this.kill('SIGTERM');
    };
  }

  startAbortHandling(signal: AbortSignal): void {
    signal.addEventListener('abort', this.abortListener, { once: true });
    if (signal.aborted) this.abortListener();
  }

  /**
   * Withhold stdout credit while `settlement` (an event's admission) is
   * pending. With `inFlightLimitBytes` 0 no credit is granted until every
   * hold is released. With a positive limit, credit keeps flowing while a
   * hold is pending until that many bytes have arrived since the first
   * pending hold; only then is it withheld until every hold is released. So
   * events keep arriving while a commit is in flight, and what can pile up
   * behind pending admissions stays bounded by the limit plus the host's
   * forwarding window.
   */
  withholdStdoutCreditUntil(
    settlement: PromiseLike<unknown>,
    inFlightLimitBytes = 0,
  ): void {
    if (this.finished) return;
    const hold: StdoutCreditHold = { proxy: this };
    if (this.stdoutCreditHolds.size === 0) this.heldStdoutBytes = 0;
    this.stdoutCreditHolds.add(hold);
    this.heldStdoutLimitBytes = Number.isFinite(inFlightLimitBytes)
      ? Math.max(0, inFlightLimitBytes)
      : 0;
    // A route may remain blocked during cancellation. Its promise must not
    // retain an exited proxy just to release a credit hold that no longer
    // matters; finish() detaches every token immediately.
    const release = (): void => {
      const current = hold.proxy;
      hold.proxy = null;
      if (!current || current.finished) return;
      current.stdoutCreditHolds.delete(hold);
      if (current.stdoutCreditHolds.size === 0) current.heldStdoutBytes = 0;
      if (current.stdoutCreditHolds.size === 0 && !current.stdoutPaused) {
        current.acknowledgeStdout();
      }
    };
    void Promise.resolve(settlement).then(release, release);
  }

  kill(signal: NodeJS.Signals): boolean {
    if (this.finished) return false;
    this.killed = true;
    try {
      post(this.child, {
        type: 'kill',
        requestId: this.requestId,
        signal,
      });
      return true;
    } catch {
      return false;
    }
  }

  markStarted(pid: number, startedAtMs: number): void {
    // The host reports pid 0 for a spawn that failed before it had one.
    if (
      this.finished ||
      this.pid !== null ||
      !Number.isInteger(pid) ||
      pid <= 0
    ) {
      return;
    }
    this.pid = pid;
    this.startedAtMs = startedAtMs;
    registerHostedClaudeProcess({
      pid,
      startedAtMs,
      executable: this.executable,
      ...(this.owner ? { sessionKey: this.owner.sessionKey } : {}),
      ...(this.owner?.sessionInstanceId !== undefined
        ? { sessionInstanceId: this.owner.sessionInstanceId }
        : {}),
      ...(this.owner?.delegationId !== undefined
        ? { delegationId: this.owner.delegationId }
        : {}),
    });
    this.recordDiagnostic({ kind: 'claude_process_started', pid });
  }

  uptimeMs(): number | undefined {
    return this.pid === null
      ? undefined
      : Math.max(0, Date.now() - this.startedAtMs);
  }

  recordDiagnostic(diagnostic: HostedClaudeProcessDiagnostic): void {
    try {
      this.owner?.recordDiagnostic(diagnostic);
    } catch {
      // Diagnostics never affect process lifecycle.
    }
  }

  receiveStdout(dataBase64: string): void {
    if (this.finished) return;
    const chunk = Buffer.from(dataBase64, 'base64');
    this.pendingStdoutAckBytes += chunk.length;
    if (this.stdoutCreditHolds.size > 0) this.heldStdoutBytes += chunk.length;
    const canAcceptMore = this.stdout.write(chunk);
    if (canAcceptMore) {
      this.acknowledgeStdout();
      return;
    }
    if (this.stdoutPaused) return;
    this.stdoutPaused = true;
    this.stdout.once('drain', this.stdoutDrainListener);
  }

  receiveStderr(dataBase64: string): void {
    if (!this.finished) this.stderr.write(Buffer.from(dataBase64, 'base64'));
  }

  receiveError(error: Error): void {
    // One error per process: after an `exitPending` error the proxy stays
    // live, and a host crash must not emit a second into a `once` listener.
    if (this.finished || this.errorEmitted) return;
    this.errorEmitted = true;
    this.emit('error', error);
  }

  finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.finished) return;
    this.finished = true;
    this.stdout.removeListener('drain', this.stdoutDrainListener);
    this.stdoutPaused = false;
    this.pendingStdoutAckBytes = 0;
    this.heldStdoutBytes = 0;
    for (const hold of Array.from(this.stdoutCreditHolds)) hold.proxy = null;
    this.stdoutCreditHolds.clear();
    this.exitCode = code;
    this.signalCode = signal;
    if (this.pid !== null) {
      unregisterHostedClaudeProcess(this.pid);
      this.recordDiagnostic({
        kind: 'claude_process_exited',
        pid: this.pid,
        exitCode: code,
        signal,
        uptimeMs: this.uptimeMs() ?? 0,
      });
    }
    this.stdin.destroy();
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('exit', code, signal));
  }

  detachAbortSignal(signal: AbortSignal): void {
    signal.removeEventListener('abort', this.abortListener);
  }
}

function handleMessage(source: UtilityProcess, message: unknown): void {
  const payload = isResponse(message)
    ? message
    : isRecord(message) && 'data' in message
      ? message.data
      : message;
  if (!isResponse(payload) || payload.type === 'shutdown-complete') return;

  const proxy = active.get(payload.requestId);
  if (!proxy || proxy.child !== source) return;
  if (payload.type === 'started') {
    cleanupProcesses.set(payload.requestId, {
      child: source,
      pid: payload.pid,
    });
    proxy.markStarted(
      payload.pid,
      typeof payload.startedAtMs === 'number' &&
        Number.isFinite(payload.startedAtMs)
        ? payload.startedAtMs
        : Date.now(),
    );
  } else if (payload.type === 'stdout') {
    proxy.receiveStdout(payload.dataBase64);
  } else if (payload.type === 'stderr') {
    proxy.receiveStderr(payload.dataBase64);
  } else if (payload.type === 'error') {
    proxy.receiveError(new Error(payload.message));
    // The host still tracks a spawned child; its `exit` finishes the proxy,
    // which stays killable and in crash cleanup until then.
    if (payload.exitPending === true) return;
    active.delete(payload.requestId);
    cleanupProcesses.delete(payload.requestId);
    proxy.finish(null, null);
  } else if (payload.type === 'exit') {
    active.delete(payload.requestId);
    cleanupProcesses.delete(payload.requestId);
    proxy.finish(payload.code, payload.signal);
  }
}

async function terminateTrackedProcessGroups(
  child: UtilityProcess,
): Promise<void> {
  const tracked = Array.from(cleanupProcesses.entries()).filter(
    ([, process]) => process.child === child,
  );
  const pids = Array.from(new Set(tracked.map(([, process]) => process.pid)));
  await Promise.allSettled(
    pids.map((pid) => killProcessGroupByPid(pid, 'SIGKILL')),
  );
  for (const [requestId, process] of tracked) {
    if (cleanupProcesses.get(requestId) === process) {
      cleanupProcesses.delete(requestId);
    }
  }
}

function ensureWorker(): UtilityProcess {
  if (shuttingDown) throw new Error('Claude process host is shutting down.');
  if (worker) return worker;

  const child = utilityProcess.fork(
    path.join(__dirname, WORKER_ENTRY_FILENAME),
    [],
    { serviceName: WORKER_SERVICE_NAME },
  );
  worker = child;
  let resolveExit = (): void => undefined;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const exitState: WorkerExitState = {
    child,
    promise: exitPromise,
    resolve: resolveExit,
  };
  workerExitState = exitState;
  child.on('message', (message) => handleMessage(child, message));
  child.once('exit', (code) => {
    void (async (): Promise<void> => {
      if (worker === child) worker = null;
      await terminateTrackedProcessGroups(child);
      for (const [requestId, proxy] of Array.from(active.entries())) {
        if (proxy.child !== child) continue;
        active.delete(requestId);
        if (!shuttingDown) {
          proxy.receiveError(
            new Error(
              `Claude process host exited before the Claude process (code ${code}).`,
            ),
          );
        }
        proxy.finish(null, 'SIGKILL');
      }
      exitState.resolve();
      if (workerExitState === exitState) workerExitState = null;
    })();
  });
  return child;
}

/**
 * Kill hosted CLIs whose owning session instance is no longer registered:
 * nothing reads them, and every teardown path should already have ended them.
 */
function checkHostedProcessOwners(): void {
  const now = Date.now();
  let owned = 0;
  for (const proxy of Array.from(active.values())) {
    const isRegistered = proxy.owner?.isRegistered;
    if (!isRegistered) continue;
    owned += 1;
    if (proxy.ownerCheckKilled) continue;
    let registered: boolean;
    try {
      registered = isRegistered();
    } catch {
      registered = true;
    }
    if (registered) {
      proxy.ownerMissingSinceMs = null;
      continue;
    }
    if (proxy.ownerMissingSinceMs === null) {
      proxy.ownerMissingSinceMs = now;
      continue;
    }
    proxy.ownerCheckKilled = true;
    const uptimeMs = proxy.uptimeMs();
    proxy.recordDiagnostic({
      kind: 'claude_process_untracked',
      ...(proxy.pid !== null ? { pid: proxy.pid } : {}),
      ...(uptimeMs !== undefined ? { uptimeMs } : {}),
    });
    proxy.kill('SIGKILL');
  }
  if (owned === 0) stopOwnerCheck();
}

function ensureOwnerCheck(): void {
  if (ownerCheckTimer) return;
  ownerCheckTimer = setInterval(
    checkHostedProcessOwners,
    OWNER_CHECK_INTERVAL_MS,
  );
  ownerCheckTimer.unref?.();
}

function stopOwnerCheck(): void {
  if (!ownerCheckTimer) return;
  clearInterval(ownerCheckTimer);
  ownerCheckTimer = null;
}

function spawnHostedClaudeProcess(
  options: SpawnOptions,
  captureStderr = false,
  owner: HostedClaudeProcessOwner | null = null,
): ClaudeProcessProxy {
  const child = ensureWorker();
  const requestId = randomUUID();
  const proxy = new ClaudeProcessProxy(
    requestId,
    child,
    options.command,
    owner,
  );
  active.set(requestId, proxy);
  if (owner?.isRegistered) ensureOwnerCheck();
  proxy.once('exit', () => proxy.detachAbortSignal(options.signal));
  try {
    post(child, {
      type: 'spawn',
      requestId,
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      captureStderr,
    });
    proxy.startAbortHandling(options.signal);
  } catch (error) {
    active.delete(requestId);
    queueMicrotask(() => {
      proxy.receiveError(
        error instanceof Error ? error : new Error(String(error)),
      );
      proxy.finish(null, null);
    });
  }
  return proxy;
}

/**
 * With `owner`, the CLI's lifecycle is reported to the owner's diagnostics,
 * and a chat's CLI is killed once its session instance is no longer
 * registered (see `checkHostedProcessOwners`).
 */
export function spawnClaudeCodeProcessOffMain(
  options: SpawnOptions,
  owner?: HostedClaudeProcessOwner,
): SpawnedProcess {
  return spawnHostedClaudeProcess(options, false, owner ?? null);
}

/**
 * Opt-in SDK pressure hook. Other hosted CLI callers keep normal ACK flow.
 * `inFlightLimitBytes` 0 withholds credit until the admission settles; a
 * positive limit lets that many bytes arrive meanwhile (see
 * `ClaudeProcessProxy.withholdStdoutCreditUntil`).
 */
export function withholdClaudeProcessStdoutCreditUntil(
  process: SpawnedProcess,
  settlement: PromiseLike<unknown>,
  inFlightLimitBytes = 0,
): void {
  if (process instanceof ClaudeProcessProxy) {
    process.withholdStdoutCreditUntil(settlement, inFlightLimitBytes);
  }
}

export interface ClaudeCliProcessOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes?: number;
}

export interface ClaudeCliProcessResult {
  stdout: string;
  stderr: string;
}

/**
 * Run a bounded Claude CLI command inside the shared utility host. Native
 * child-process creation can block Electron's main loop for hundreds of
 * milliseconds while macOS validates a large executable, so plugin and
 * marketplace commands must not spawn the bundled Claude binary directly.
 */
export function runClaudeCliProcessOffMain(
  options: ClaudeCliProcessOptions,
): Promise<ClaudeCliProcessResult> {
  const controller = new AbortController();
  const spawned = spawnHostedClaudeProcess(
    {
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      signal: controller.signal,
    },
    true,
  );
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const maxOutputBytes =
      options.maxOutputBytes ?? DEFAULT_CLI_MAX_OUTPUT_BYTES;
    let outputBytes = 0;
    let spawnError: Error | null = null;
    let settled = false;

    const stopCollecting = (): void => {
      spawned.stdout.off('data', collectStdout);
      spawned.stderr.off('data', collectStderr);
      // A process that does not exit promptly after SIGKILL must not retain or
      // buffer additional output on Electron main while the host reaps it.
      spawned.stdout.resume();
      spawned.stderr.resume();
      stdout.length = 0;
      stderr.length = 0;
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stopCollecting();
      reject(error);
    };
    const collect = (target: Buffer[], chunk: Buffer): void => {
      if (settled) return;
      const copy = Buffer.from(chunk);
      outputBytes += copy.byteLength;
      if (outputBytes > maxOutputBytes) {
        spawned.kill('SIGKILL');
        fail(
          new Error(
            `Claude CLI command exceeded its ${String(maxOutputBytes)}-byte output limit.`,
          ),
        );
        return;
      }
      target.push(copy);
    };
    function collectStdout(chunk: Buffer): void {
      collect(stdout, chunk);
    }
    function collectStderr(chunk: Buffer): void {
      collect(stderr, chunk);
    }

    const timeout = setTimeout(() => {
      spawned.kill('SIGKILL');
      fail(
        new Error(
          `Claude CLI command exceeded its ${String(options.timeoutMs)}ms deadline.`,
        ),
      );
    }, options.timeoutMs);
    timeout.unref?.();
    spawned.stdout.on('data', collectStdout);
    spawned.stderr.on('data', collectStderr);
    spawned.once('error', (error: Error) => {
      spawnError = error;
    });
    spawned.once(
      'exit',
      (code: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return;
        clearTimeout(timeout);
        spawned.stdout.off('data', collectStdout);
        spawned.stderr.off('data', collectStderr);
        const stdoutText = Buffer.concat(stdout).toString('utf8');
        const stderrText = Buffer.concat(stderr).toString('utf8');
        if (spawnError) {
          fail(spawnError);
          return;
        }
        if (code !== 0) {
          const detail = stderrText.trim() || stdoutText.trim();
          fail(
            new Error(
              detail ||
                `Claude CLI command exited with code ${String(code)}${signal ? ` (${signal})` : ''}.`,
            ),
          );
          return;
        }
        settled = true;
        resolve({ stdout: stdoutText, stderr: stderrText });
      },
    );
    spawned.stdin.end();
  });
}

export async function shutdownClaudeProcessHost(): Promise<void> {
  shuttingDown = true;
  stopOwnerCheck();
  const child = worker;
  const exitState = workerExitState;
  if (!child) {
    if (!exitState) return;
    let cleanupTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      exitState.promise,
      new Promise<void>((resolve) => {
        cleanupTimer = setTimeout(resolve, FORCED_EXIT_CLEANUP_WAIT_MS);
        cleanupTimer.unref?.();
      }),
    ]);
    if (cleanupTimer) clearTimeout(cleanupTimer);
    return;
  }
  if (!exitState) return;
  try {
    post(child, { type: 'shutdown' });
  } catch {
    // The exit listener still completes active proxies and shutdown bookkeeping.
  }
  let timer: NodeJS.Timeout | undefined;
  const exited = await Promise.race([
    exitState.promise.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), SHUTDOWN_WAIT_MS);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (exited) return;
  try {
    child.kill();
  } catch {
    // Best-effort bounded shutdown during app teardown.
  }
  let cleanupTimer: NodeJS.Timeout | undefined;
  await Promise.race([
    exitState.promise,
    new Promise<void>((resolve) => {
      cleanupTimer = setTimeout(resolve, FORCED_EXIT_CLEANUP_WAIT_MS);
      cleanupTimer.unref?.();
    }),
  ]);
  if (cleanupTimer) clearTimeout(cleanupTimer);
}

export function resetClaudeProcessHostForTests(): void {
  worker = null;
  workerExitState = null;
  shuttingDown = false;
  active.clear();
  cleanupProcesses.clear();
  stopOwnerCheck();
}

/** Test-only: run one owner consistency check now. */
export function checkHostedClaudeProcessOwnersForTests(): void {
  checkHostedProcessOwners();
}
