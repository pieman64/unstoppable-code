import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import {
  killProcessGroupByPid,
  signalExitedProcessGroup,
} from '@canopy/execution-engine/node/lib/process-kill';
import type {
  ExecutionHostPort,
  ExecutionHostProcess,
} from '@canopy/desktop-shared/node/execution-host/port';
import {
  isProviderProcessOwner,
  PROVIDER_PROCESS_DEFAULT_GRACE_MS,
  PROVIDER_PROCESS_HOST_EXIT_ERROR_CODE,
  PROVIDER_PROCESS_OWNER_ERROR_CODE,
  ProviderProcessError,
  type ProviderProcess,
  type ProviderProcessRequest,
  type ProviderProcessSpawner,
  type ProviderProcessStdin,
  type ProviderProcessStopOptions,
} from '@canopy/desktop-shared/node/provider-process/spawn';
import {
  isProviderProcessHostResponse,
  PROVIDER_PROCESS_HOST_ENTRY,
  PROVIDER_PROCESS_HOST_SERVICE,
  type ProviderProcessHostRequest,
  type ProviderProcessHostResponse,
} from './protocol';

/*
 * The launcher side of the provider process host (CAN-4118). Every proxy's
 * errors are fixed strings: nothing here logs or echoes a spawn request's
 * environment, arguments or working directory (CAN-4118 H1, H3).
 */

const SHUTDOWN_WAIT_MS = 6_000;
const HOST_REFUSED_ERROR_CODE = 'ERR_PROVIDER_PROCESS_HOST_REFUSED';

export interface ProviderProcessHostClient {
  readonly spawn: ProviderProcessSpawner;
  /** Ask the host to stop every child and exit; resolves after its exit. Idempotent until a new spawn. */
  shutdown(): Promise<void>;
  /** The live host process, for tests. */
  currentHostForTests(): ExecutionHostProcess | undefined;
}

type Send = (message: ProviderProcessHostRequest) => void;

class ProviderProcessProxy extends EventEmitter implements ProviderProcess {
  readonly stdin: Writable | null;
  readonly stdout: Readable;
  readonly stderr: Readable;
  private childPid: number | undefined;
  private deferredAck = 0;
  private errorEmitted = false;
  private finished = false;
  private exited = false;
  private stopping: Promise<void> | undefined;
  private markClosed: () => void = () => undefined;
  private readonly closed = new Promise<void>((resolve) => {
    this.markClosed = resolve;
  });

  constructor(
    readonly requestId: string,
    private readonly send: Send,
    stdin: ProviderProcessStdin | undefined,
  ) {
    super();
    this.stdin = stdin === 'ignore' ? null : this.relayStdin(requestId);
    this.stdout = new Readable({
      read: (): void => {
        if (this.deferredAck <= 0 || this.finished) return;
        const bytes = this.deferredAck;
        this.deferredAck = 0;
        this.trySend({ type: 'stdout-ack', requestId, bytes });
      },
    });
    this.stderr = new Readable({ read: (): void => undefined });
  }

  private relayStdin(requestId: string): Writable {
    return new Writable({
      write: (chunk: unknown, _encoding, callback): void => {
        if (!this.finished && Buffer.isBuffer(chunk))
          this.trySend({
            type: 'stdin',
            requestId,
            dataBase64: chunk.toString('base64'),
          });
        callback();
      },
      final: (callback): void => {
        if (!this.finished) this.trySend({ type: 'stdin-end', requestId });
        callback();
      },
    });
  }

  get pid(): number | undefined {
    return this.childPid;
  }

  get isClosed(): boolean {
    return this.finished;
  }

  /** The child exited or closed: its pid may be reused, its group may not. */
  get hasExited(): boolean {
    return this.exited || this.finished;
  }

  stop(options?: ProviderProcessStopOptions): Promise<void> {
    this.stopping ??= ((): Promise<void> => {
      // Parent closure does not imply group closure: a child that already
      // closed may have left descendants in its group, which the host no
      // longer tracks.
      if (this.finished) {
        if (this.childPid !== undefined)
          signalExitedProcessGroup(this.childPid, 'SIGKILL');
      } else
        this.trySend({
          type: 'stop',
          requestId: this.requestId,
          graceMs: options?.graceMs ?? PROVIDER_PROCESS_DEFAULT_GRACE_MS,
        });
      return this.closed;
    })();
    return this.stopping;
  }

  started(pid: number): void {
    this.childPid = pid;
  }

  receiveStdout(data: Buffer): void {
    if (this.finished) return;
    if (this.stdout.push(data))
      this.trySend({
        type: 'stdout-ack',
        requestId: this.requestId,
        bytes: data.length,
      });
    else this.deferredAck += data.length;
  }

  receiveStderr(data: Buffer): void {
    if (!this.finished) this.stderr.push(data);
  }

  fail(message: string, code: string | undefined): void {
    if (this.errorEmitted || this.finished) return;
    this.errorEmitted = true;
    this.emit('error', new ProviderProcessError(message, code));
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited || this.finished) return;
    this.exited = true;
    this.emit('exit', code, signal);
  }

  close(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.finished) return;
    this.finished = true;
    // A stop that crossed the host's close was dropped there: reap the
    // group the stop promised to end.
    if (this.stopping && this.childPid !== undefined)
      signalExitedProcessGroup(this.childPid, 'SIGKILL');
    this.stdout.push(null);
    this.stderr.push(null);
    this.emit('close', code, signal);
    this.markClosed();
  }

  /** Fails a proxy that never reached a host, on the next tick. */
  failSoon(message: string, code: string): this {
    process.nextTick(() => {
      this.fail(message, code);
      this.close(null, null);
    });
    return this;
  }

  private trySend(message: ProviderProcessHostRequest): void {
    try {
      this.send(message);
    } catch {
      // The host is gone; its exit fails this proxy.
    }
  }
}

interface LaunchedHost {
  readonly process: ExecutionHostProcess;
  readonly proxies: Map<string, ProviderProcessProxy>;
  /** Pids of children this host reported started, by request. */
  readonly startedGroups: Map<string, number>;
  readonly exited: Promise<void>;
}

function hostExitMessage(code: number | string): string {
  return `Provider process host exited before the provider process (code ${code}).`;
}

function responseOf(message: unknown): ProviderProcessHostResponse | undefined {
  if (isProviderProcessHostResponse(message)) return message;
  // The utility adapter delivers `{ data }`.
  if (typeof message !== 'object' || message === null) return undefined;
  const data: unknown = Reflect.get(message, 'data');
  return isProviderProcessHostResponse(data) ? data : undefined;
}

function environmentOf(
  env: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  const copy: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env))
    if (typeof value === 'string' || value === undefined) copy[name] = value;
  return copy;
}

const noSend: Send = () => undefined;

export function createProviderProcessHostClient(
  port: () => ExecutionHostPort,
): ProviderProcessHostClient {
  let host: LaunchedHost | undefined;
  let shuttingDown: Promise<void> | undefined;

  const handleResponse = (
    launched: LaunchedHost,
    response: ProviderProcessHostResponse,
  ): void => {
    if (response.type === 'shutdown-complete') return;
    const proxy = launched.proxies.get(response.requestId);
    if (!proxy) return;
    switch (response.type) {
      case 'started':
        launched.startedGroups.set(response.requestId, response.pid);
        proxy.started(response.pid);
        return;
      case 'stdout':
        proxy.receiveStdout(Buffer.from(response.dataBase64, 'base64'));
        return;
      case 'stderr':
        proxy.receiveStderr(Buffer.from(response.dataBase64, 'base64'));
        return;
      case 'error':
        proxy.fail(response.message, response.code);
        return;
      case 'exit':
        proxy.exit(response.code, response.signal);
        return;
      case 'close':
        launched.proxies.delete(response.requestId);
        launched.startedGroups.delete(response.requestId);
        proxy.close(response.code, response.signal);
        return;
    }
  };

  const handleExit = (launched: LaunchedHost, code: number): void => {
    if (host === launched) host = undefined;
    // Children run in their own process groups, outside the host's tree.
    for (const [requestId, pid] of launched.startedGroups) {
      const proxy = launched.proxies.get(requestId);
      if (!proxy || proxy.isClosed) continue;
      if (proxy.hasExited) signalExitedProcessGroup(pid, 'SIGKILL');
      else void killProcessGroupByPid(pid, 'SIGKILL').catch(() => undefined);
    }
    launched.startedGroups.clear();
    const proxies = Array.from(launched.proxies.values());
    launched.proxies.clear();
    for (const proxy of proxies) {
      proxy.fail(hostExitMessage(code), PROVIDER_PROCESS_HOST_EXIT_ERROR_CODE);
      proxy.close(null, 'SIGKILL');
    }
  };

  const startHost = (): LaunchedHost => {
    const hostProcess = port().launch({
      entry: PROVIDER_PROCESS_HOST_ENTRY,
      serviceName: PROVIDER_PROCESS_HOST_SERVICE,
    });
    let markExited: () => void = () => undefined;
    const launched: LaunchedHost = {
      process: hostProcess,
      proxies: new Map(),
      startedGroups: new Map(),
      exited: new Promise<void>((resolve) => {
        markExited = resolve;
      }),
    };
    hostProcess.on('message', (message) => {
      const response = responseOf(message);
      if (response) handleResponse(launched, response);
    });
    hostProcess.on('exit', (code) => {
      handleExit(launched, code);
      markExited();
    });
    return launched;
  };

  const spawn: ProviderProcessSpawner = (request: ProviderProcessRequest) => {
    const requestId = randomUUID();
    if (!isProviderProcessOwner(request.owner))
      return new ProviderProcessProxy(
        requestId,
        noSend,
        request.stdin,
      ).failSoon(
        'The provider process owner is invalid.',
        PROVIDER_PROCESS_OWNER_ERROR_CODE,
      );
    if (shuttingDown)
      return new ProviderProcessProxy(
        requestId,
        noSend,
        request.stdin,
      ).failSoon(
        'The provider process host is not accepting this spawn.',
        HOST_REFUSED_ERROR_CODE,
      );
    let launched: LaunchedHost;
    try {
      launched = host ??= startHost();
    } catch {
      return new ProviderProcessProxy(
        requestId,
        noSend,
        request.stdin,
      ).failSoon(
        hostExitMessage('launch'),
        PROVIDER_PROCESS_HOST_EXIT_ERROR_CODE,
      );
    }
    const send: Send = (message) => launched.process.postMessage(message);
    const proxy = new ProviderProcessProxy(requestId, send, request.stdin);
    try {
      send({
        type: 'spawn',
        requestId,
        command: request.command,
        args: [...request.args],
        cwd: request.cwd,
        env: environmentOf(request.env),
        owner: { kind: request.owner.kind, id: request.owner.id },
        ...(request.stdin ? { stdin: request.stdin } : {}),
      });
    } catch {
      return new ProviderProcessProxy(
        requestId,
        noSend,
        request.stdin,
      ).failSoon(
        hostExitMessage('launch'),
        PROVIDER_PROCESS_HOST_EXIT_ERROR_CODE,
      );
    }
    launched.proxies.set(requestId, proxy);
    return proxy;
  };

  const shutdown = (): Promise<void> => {
    if (shuttingDown) return shuttingDown;
    const launched = host;
    if (!launched) return Promise.resolve();
    shuttingDown = (async (): Promise<void> => {
      try {
        launched.process.postMessage({ type: 'shutdown' });
      } catch {
        // Already gone: its exit follows.
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        launched.exited.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), SHUTDOWN_WAIT_MS);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (timedOut && !launched.process.kill())
        launched.process.once('spawn', () => {
          launched.process.kill();
        });
      await launched.exited;
    })().finally(() => {
      shuttingDown = undefined;
    });
    return shuttingDown;
  };

  return {
    spawn,
    shutdown,
    currentHostForTests: () => host?.process,
  };
}
