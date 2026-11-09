import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import {
  killProcessGroupByPid,
  signalExitedProcessGroup,
} from '@canopy/execution-engine/node/lib/process-kill';

/*
 * The spawn seam for provider CLIs (CAN-4118; consumed by the Cursor, Copilot
 * and OpenCode turn drivers). Electron main passes the provider process host's
 * spawner; hosts that are not Electron main pass spawnProviderProcessDirect.
 */

export type ProviderProcessOwnerKind =
  | 'turn'
  | 'subagent'
  | 'helper'
  | 'pipeline'
  | 'discovery';

/** Attribution and diagnostics only: never registered, checked or reaped by. */
export interface ProviderProcessOwner {
  readonly kind: ProviderProcessOwnerKind;
  /** Non-empty, at most PROVIDER_PROCESS_OWNER_ID_MAX characters. */
  readonly id: string;
}

/** 'ignore' gives the child no stdin at all, as a null device. */
export type ProviderProcessStdin = 'pipe' | 'ignore';

export interface ProviderProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The child's complete environment; nothing is merged in. */
  readonly env: NodeJS.ProcessEnv;
  readonly owner: ProviderProcessOwner;
  /** Default 'pipe'. With 'ignore', the returned process has no `stdin`. */
  readonly stdin?: ProviderProcessStdin;
}

export interface ProviderProcessStopOptions {
  /** Time between SIGTERM and the unconditional group SIGKILL. Default 1500. */
  readonly graceMs?: number;
}

export interface ProviderProcess {
  /** Undefined until the child has started, and for a child that never started. */
  readonly pid: number | undefined;
  /** Null when the request ignored stdin. */
  readonly stdin: Writable | null;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /**
   * The child process itself exited. Fires at most once, before 'close', and
   * only for a child that started; 'close' can follow much later while a
   * descendant still holds the child's output pipes.
   */
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  once(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  once(event: 'error', listener: (error: ProviderProcessError) => void): this;
  /**
   * SIGTERM to the child's process group (Windows: forced tree kill), wait for
   * close or graceMs, then SIGKILL the group whether or not the child closed,
   * then resolve after close. Idempotent: later calls return the first promise.
   */
  stop(options?: ProviderProcessStopOptions): Promise<void>;
}

export type ProviderProcessSpawner = (
  request: ProviderProcessRequest,
) => ProviderProcess;

export class ProviderProcessError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = 'ProviderProcessError';
  }
}

export const PROVIDER_PROCESS_DEFAULT_GRACE_MS = 1500;
export const PROVIDER_PROCESS_OWNER_ID_MAX = 200;
export const PROVIDER_PROCESS_OWNER_ERROR_CODE = 'ERR_PROVIDER_PROCESS_OWNER';
export const PROVIDER_PROCESS_HOST_EXIT_ERROR_CODE =
  'ERR_PROVIDER_PROCESS_HOST_EXIT';

const OWNER_KINDS: ReadonlySet<unknown> = new Set<ProviderProcessOwnerKind>([
  'turn',
  'subagent',
  'helper',
  'pipeline',
  'discovery',
]);

export function isProviderProcessOwner(
  value: unknown,
): value is ProviderProcessOwner {
  if (typeof value !== 'object' || value === null) return false;
  const id: unknown = Reflect.get(value, 'id');
  return (
    OWNER_KINDS.has(Reflect.get(value, 'kind')) &&
    typeof id === 'string' &&
    id.length >= 1 &&
    id.length <= PROVIDER_PROCESS_OWNER_ID_MAX
  );
}

/** The only error a spawner forwards: code plus a fixed message naming at most the command (H3). */
export function providerProcessErrorFrom(
  error: unknown,
  command: string,
): ProviderProcessError {
  const code: unknown =
    typeof error === 'object' && error !== null
      ? Reflect.get(error, 'code')
      : undefined;
  // Never the native message, spawnargs, path or env: spawn requests carry
  // the user's shell environment (CAN-4118 H3).
  if (typeof code === 'string')
    return new ProviderProcessError(`spawn ${command} ${code}`, code);
  return new ProviderProcessError('The provider process failed.', undefined);
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  // A missing, zero, or negative pid would signal the caller's own group.
  if (pid === undefined || pid <= 0) return;
  // Windows children are spawned with `windowsHide`, so they own no window for
  // a graceful `taskkill /T` to close; it exits non-zero and the shared helper
  // falls back to terminating the parent alone, leaving every tool subprocess
  // reparented and holding worktree file handles. Ask for the forced tree kill
  // up front — the graceful attempt degrades to an unconditional terminate
  // there regardless, so no flush is lost.
  const effective: NodeJS.Signals =
    hostPlatformOperatingSystem() === 'win32' ? 'SIGKILL' : signal;
  // A process that already exited is the ordinary case, not an error.
  void killProcessGroupByPid(pid, effective).catch(() => undefined);
}

class DirectProviderProcess extends EventEmitter implements ProviderProcess {
  readonly stdin: Writable | null;
  readonly stdout: Readable;
  readonly stderr: Readable;
  private readonly child: ChildProcess | undefined;
  private readonly closed: Promise<void>;
  private markClosed: () => void = () => undefined;
  private errorEmitted = false;
  private closeEmitted = false;
  private exitEmitted = false;
  /** Node reaped the child: its pid may be reused from here on. */
  private childExited = false;
  private spawned = false;
  private stopping: Promise<void> | undefined;

  constructor(request: ProviderProcessRequest) {
    super();
    this.closed = new Promise<void>((resolve) => {
      this.markClosed = resolve;
    });
    if (!isProviderProcessOwner(request.owner)) {
      this.child = undefined;
      [this.stdin, this.stdout, this.stderr] = placeholderStreams(
        request.stdin,
      );
      this.failLater(
        new ProviderProcessError(
          'The provider process owner is invalid.',
          PROVIDER_PROCESS_OWNER_ERROR_CODE,
        ),
      );
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(request.command, [...request.args], {
        cwd: request.cwd,
        env: request.env,
        // Windows has no process groups; the tree is reclaimed by taskkill.
        detached: hostPlatformOperatingSystem() !== 'win32',
        // Electron main is a GUI process on Windows; without this the
        // console-subsystem node.exe flashes a console window each turn.
        windowsHide: true,
        stdio: [request.stdin ?? 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.child = undefined;
      [this.stdin, this.stdout, this.stderr] = placeholderStreams(
        request.stdin,
      );
      this.failLater(providerProcessErrorFrom(error, request.command));
      return;
    }
    const { stdin, stdout, stderr } = child;
    if (!stdout || !stderr)
      throw new Error('Provider process output is not piped.');
    this.stdin = stdin;
    this.stdout = stdout;
    this.stderr = stderr;
    this.child = child;
    child.once('spawn', () => {
      this.spawned = true;
    });
    child.on('error', (error) => {
      this.emitError(providerProcessErrorFrom(error, request.command));
    });
    child.once('exit', (code, signal) => {
      this.childExited = true;
      if (this.spawned) this.emitExit(code, signal);
    });
    child.once('close', (code, signal) => {
      if (this.spawned) this.emitClose(code, signal);
      else this.emitClose(null, null);
    });
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  stop(options: ProviderProcessStopOptions = {}): Promise<void> {
    this.stopping ??= this.runStop(
      options.graceMs ?? PROVIDER_PROCESS_DEFAULT_GRACE_MS,
    );
    return this.stopping;
  }

  private async runStop(graceMs: number): Promise<void> {
    const pid = this.pid;
    if (pid === undefined || pid <= 0) {
      await this.closed;
      return;
    }
    this.signal(pid, 'SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.closed,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, graceMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      // Parent closure does not imply group closure: terminate surviving
      // descendants before reporting the child stopped.
      this.signal(pid, 'SIGKILL');
    }
    await this.closed;
  }

  private signal(pid: number, signal: NodeJS.Signals): void {
    if (this.childExited || this.closeEmitted)
      signalExitedProcessGroup(pid, signal);
    else signalGroup(pid, signal);
  }

  private failLater(error: ProviderProcessError): void {
    process.nextTick(() => {
      this.emitError(error);
      this.emitClose(null, null);
    });
  }

  private emitError(error: ProviderProcessError): void {
    if (this.errorEmitted || this.closeEmitted) return;
    this.errorEmitted = true;
    this.emit('error', error);
  }

  private emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitEmitted || this.closeEmitted) return;
    this.exitEmitted = true;
    this.emit('exit', code, signal);
  }

  private emitClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.emit('close', code, signal);
    this.markClosed();
  }
}

/** Streams for a child that never started: stdin discards, outputs are ended. */
function placeholderStreams(
  mode: ProviderProcessStdin | undefined,
): [Writable | null, Readable, Readable] {
  const stdin = mode === 'ignore' ? null : new PassThrough();
  stdin?.resume();
  const stdout = new PassThrough();
  stdout.end();
  const stderr = new PassThrough();
  stderr.end();
  return [stdin, stdout, stderr];
}

/** Plain node spawn. Never use it in Electron main outside the host (check:provider-process-host CU1). */
export const spawnProviderProcessDirect: ProviderProcessSpawner = (request) =>
  new DirectProviderProcess(request);
