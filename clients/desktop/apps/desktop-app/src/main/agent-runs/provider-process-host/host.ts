import type {
  ConnectedExecutionHostChannel,
  ExecutionHostChannel,
} from '@canopy/desktop-shared/node/execution-host/channel';
import { killProcessGroupByPid } from '@canopy/desktop-shared/node/lib/process-kill';
import {
  spawnProviderProcessDirect,
  type ProviderProcess,
  type ProviderProcessOwner,
  type ProviderProcessSpawner,
} from '@canopy/desktop-shared/node/provider-process/spawn';
import {
  isProviderProcessHostRequest,
  PROVIDER_PROCESS_STDERR_LIMIT_BYTES,
  PROVIDER_PROCESS_STDOUT_WINDOW_BYTES,
  type ProviderProcessHostRequest,
  type ProviderProcessHostResponse,
} from './protocol';

/*
 * The provider process host (CAN-4118): spawns provider CLIs for its launcher
 * and relays their stdio. Spawn requests carry the user's environment, so
 * nothing here logs, persists or echoes a request (CAN-4118 H1 to H4).
 */

const SHUTDOWN_STOP_TIMEOUT_MS = 5_000;

export interface ProviderProcessHostChildSnapshot {
  readonly requestId: string;
  readonly pid: number | undefined;
  readonly owner: ProviderProcessOwner;
  readonly stderrTruncated: boolean;
}

export interface ProviderProcessHostHandle {
  /** SIGKILL every tracked child group, post shutdown-complete, exit(0). Idempotent. */
  shutdown(): Promise<void>;
  liveChildren(): readonly ProviderProcessHostChildSnapshot[];
}

interface HostedChild {
  readonly child: ProviderProcess;
  readonly owner: ProviderProcessOwner;
  credit: number;
  /** Set once the child is being stopped: stdout drains without credit. */
  draining: boolean;
  /** Set once a stopping child's stdout was cut: nothing more is relayed. */
  stdoutTruncated: boolean;
  stderrBytes: number;
  stderrTruncated: boolean;
}

type SpawnRequest = Extract<ProviderProcessHostRequest, { type: 'spawn' }>;

export function startProviderProcessHost(
  channel: ExecutionHostChannel,
  exitProcess: (code: number) => void = (code) => process.exit(code),
  spawner: ProviderProcessSpawner = spawnProviderProcessDirect,
): ProviderProcessHostHandle {
  const tracked = new Map<string, HostedChild>();
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;

  const post = (message: ProviderProcessHostResponse): void => {
    try {
      channel.postMessage(message);
    } catch {
      // The launcher is gone; its exit handling reaps the children.
    }
  };

  const refuse = (requestId: string): void => {
    post({
      type: 'error',
      requestId,
      message: 'The provider process host is not accepting this spawn.',
      code: 'ERR_PROVIDER_PROCESS_HOST_REFUSED',
    });
    post({ type: 'close', requestId, code: null, signal: null });
  };

  const start = (request: SpawnRequest): void => {
    const { requestId } = request;
    if (shuttingDown || tracked.has(requestId)) {
      refuse(requestId);
      return;
    }
    const child = spawner({
      command: request.command,
      args: request.args,
      cwd: request.cwd,
      env: request.env,
      owner: request.owner,
    });
    const hosted: HostedChild = {
      child,
      owner: request.owner,
      credit: PROVIDER_PROCESS_STDOUT_WINDOW_BYTES,
      draining: false,
      stdoutTruncated: false,
      stderrBytes: 0,
      stderrTruncated: false,
    };
    tracked.set(requestId, hosted);
    // An exited child's stdin is closed; its close reports the end.
    child.stdin.on('error', () => undefined);
    child.stdout.on('data', (chunk: Buffer) => {
      // A stopping child keeps being read so its pipe can end, but nothing
      // past the credit window is relayed, and relayed stdout stays a prefix.
      if (hosted.stdoutTruncated) return;
      const forwarded = hosted.draining
        ? chunk.subarray(0, Math.max(hosted.credit, 0))
        : chunk;
      if (forwarded.length < chunk.length) hosted.stdoutTruncated = true;
      if (forwarded.length > 0)
        post({
          type: 'stdout',
          requestId,
          dataBase64: forwarded.toString('base64'),
        });
      hosted.credit -= forwarded.length;
      if (hosted.credit <= 0 && !hosted.draining) child.stdout.pause();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Relayed stderr stays a prefix: nothing after the first dropped chunk.
      if (hosted.stderrTruncated) return;
      if (
        hosted.stderrBytes + chunk.length >
        PROVIDER_PROCESS_STDERR_LIMIT_BYTES
      ) {
        hosted.stderrTruncated = true;
        return;
      }
      hosted.stderrBytes += chunk.length;
      post({
        type: 'stderr',
        requestId,
        dataBase64: chunk.toString('base64'),
      });
    });
    // The spawner already reduced the error to a code and a fixed message (H3).
    child.once('error', (error) => {
      post({
        type: 'error',
        requestId,
        message: error.message,
        ...(error.code === undefined ? {} : { code: error.code }),
      });
    });
    child.once('close', (code, signal) => {
      tracked.delete(requestId);
      post({ type: 'close', requestId, code, signal });
    });
    const pid = child.pid;
    if (pid !== undefined) post({ type: 'started', requestId, pid });
  };

  // A paused stdout never reads its end, so the child's close (and stop)
  // would wait on a reader that may be gone.
  const stopChild = (hosted: HostedChild, graceMs: number): Promise<void> => {
    hosted.draining = true;
    hosted.child.stdout.resume();
    return hosted.child.stop({ graceMs });
  };

  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async (): Promise<void> => {
      shuttingDown = true;
      // A child already stopping keeps its own grace; shutdown does not wait
      // for it, so every tracked group is killed now.
      for (const hosted of tracked.values()) {
        const pid = hosted.child.pid;
        if (pid !== undefined)
          void killProcessGroupByPid(pid, 'SIGKILL').catch(() => undefined);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(
            Array.from(tracked.values(), (hosted) => stopChild(hosted, 0)),
          ),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, SHUTDOWN_STOP_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      post({ type: 'shutdown-complete' });
      exitProcess(0);
    })();
    return shutdownPromise;
  };

  const handle = (request: ProviderProcessHostRequest): void => {
    if (request.type === 'shutdown') {
      void shutdown();
      return;
    }
    if (request.type === 'spawn') {
      start(request);
      return;
    }
    const hosted = tracked.get(request.requestId);
    if (!hosted) return;
    const { child } = hosted;
    switch (request.type) {
      case 'stdin':
        try {
          child.stdin.write(Buffer.from(request.dataBase64, 'base64'));
        } catch {
          // As above: the close reports the end.
        }
        return;
      case 'stdin-end':
        child.stdin.end();
        return;
      case 'stdout-ack':
        hosted.credit = Math.min(
          PROVIDER_PROCESS_STDOUT_WINDOW_BYTES,
          hosted.credit + request.bytes,
        );
        if (hosted.credit > 0 || hosted.draining) child.stdout.resume();
        return;
      case 'stop':
        void stopChild(hosted, request.graceMs);
        return;
    }
  };

  channel.on('message', ({ data }) => {
    if (isProviderProcessHostRequest(data)) handle(data);
  });

  return {
    shutdown,
    liveChildren: () =>
      Array.from(tracked, ([requestId, hosted]) => ({
        requestId,
        pid: hosted.child.pid,
        owner: hosted.owner,
        stderrTruncated: hosted.stderrTruncated,
      })),
  };
}

/** Serves the host over a launched channel; a lost launcher shuts it down. */
export function serveProviderProcessHost(
  channel: ConnectedExecutionHostChannel,
): ProviderProcessHostHandle {
  const host = startProviderProcessHost(channel, (code) => channel.exit(code));
  // A launcher that can no longer be reached leaves no one to stop the
  // children, which run in their own process groups.
  channel.onDisconnect(() => {
    void host.shutdown();
  });
  return host;
}
