import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { CopilotClient, GetStatusResponse } from '@github/copilot-sdk';
import type * as CopilotSdkModule from '@github/copilot-sdk';
import { copilotRuntimeEnvironment } from './runtime-environment';
import {
  describeCopilotProcessFailure,
  snapshotCopilotDescendants,
  terminateCopilotDescendants,
  withCopilotCleanupDeadline,
  killCopilotProcess,
} from './process-ownership';
import { CopilotProcessReceipt } from './process-receipts';
import { loadRequiredNodeModule } from '../lib/packaged-module-loader';

export interface CopilotRuntimeOptions {
  executable: string;
  expectedVersion: string;
  workingDirectory: string;
  stateDirectory: string;
  receiptDirectory?: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}

export interface CopilotRecipientIdentity {
  readonly runtimeId: string;
  readonly pid: number;
  /** Spawn identity on the host's monotonic clock, disambiguated by runtimeId. */
  readonly started: number;
}

export interface OwnedCopilotRuntime {
  readonly identity: CopilotRecipientIdentity;
  isClosed(): boolean;
  client: CopilotClient;
  /** Resolves when the native process has been reaped. */
  exited: Promise<void>;
  close(): Promise<void>;
}

export const MAX_CONSECUTIVE_OBSERVATION_FAILURES = 5;

/**
 * The host owns the detached process group; the official SDK owns JSON-RPC.
 * Its stdio factory does not expose a spawn/kill boundary, so use its supported
 * authenticated loopback connection to an explicitly owned native child.
 * Nothing listens until requested, and no runtime survives owner shutdown.
 */
export async function startCopilotRuntime(
  options: CopilotRuntimeOptions,
): Promise<OwnedCopilotRuntime> {
  options.signal.throwIfAborted();
  for (const value of [
    options.executable,
    options.workingDirectory,
    options.stateDirectory,
    ...(options.receiptDirectory ? [options.receiptDirectory] : []),
  ]) {
    if (!isAbsolute(value))
      throw new Error('Copilot runtime paths must be absolute.');
  }
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
  options.signal.throwIfAborted();
  const token = randomBytes(32).toString('hex');
  const child = spawn(
    options.executable,
    [
      '--headless',
      '--no-auto-update',
      '--log-level',
      'none',
      '--no-remote-export',
      '--disable-builtin-mcps',
      '--no-bash-env',
      // The host supplies every identity per session; the runtime must not
      // adopt a gh login or stored CLI credentials on its own.
      '--no-auto-login',
    ],
    {
      cwd: options.workingDirectory,
      env: copilotRuntimeEnvironment(
        options.env,
        options.stateDirectory,
        token,
      ),
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const started = performance.now();
  const runtimeId = randomUUID();
  let reap!: () => void;
  const exited = new Promise<void>((resolve) => {
    reap = resolve;
  });
  let childExited = false;
  child.once('exit', () => {
    childExited = true;
  });
  child.once('close', () => {
    childExited = true;
    reap();
  });
  // Spawn and later transport errors must always have an owner, including
  // after the temporary startup listener has been removed.
  child.on('error', () => undefined);
  // Setup output can contain credentials. Drain it; never forward it to logs.
  child.stderr.resume();
  let client: CopilotClient | undefined;
  let closing: Promise<void> | undefined;
  const receipt = options.receiptDirectory
    ? new CopilotProcessReceipt(options.receiptDirectory)
    : undefined;
  const observedDescendants = new Map<
    string,
    Awaited<ReturnType<typeof snapshotCopilotDescendants>>[number]
  >();
  let observationTimer: ReturnType<typeof setInterval> | undefined;
  let observation: Promise<void> | undefined;
  let observationError: Error | undefined;
  let ownershipLimitReached = false;
  let receiptConfirmed = false;
  let failedObservations = 0;
  const childIsRunning = (): boolean =>
    !childExited && child.exitCode === null && child.signalCode === null;
  const kill = (signal: NodeJS.Signals): Promise<void> =>
    childIsRunning() ? killCopilotProcess(child, signal) : Promise.resolve();
  const observeDescendants = (): Promise<void> => {
    if (observation) return observation;
    if (!child.pid || !childIsRunning()) return Promise.resolve();
    observation = snapshotCopilotDescendants(child.pid, !!receipt)
      .then(
        async (descendants) => {
          failedObservations = 0;
          // The OS query is asynchronous; do not admit a replacement root
          // whose PID was reused while enumeration was in flight.
          if (!childIsRunning()) return;
          for (const descendant of descendants) {
            const key = `${descendant.pid}:${descendant.started}`;
            if (
              observedDescendants.size >= 16_384 &&
              !observedDescendants.has(key)
            ) {
              ownershipLimitReached = true;
              throw new Error('Copilot process ownership limit exceeded.');
            }
            observedDescendants.set(key, descendant);
          }
          try {
            await receipt?.save(Array.from(observedDescendants.values()));
            if (descendants.some((row) => row.pid === child.pid))
              receiptConfirmed = true;
          } catch (error) {
            ownershipLimitReached = true;
            throw error;
          }
        },
        (error: unknown) => {
          // Count each probe once, however many callers share it.
          failedObservations++;
          throw error;
        },
      )
      .finally(() => {
        observation = undefined;
      });
    return observation;
  };
  // A busy host can push one OS process query past its deadline. Earlier
  // observations stay owned, so only a hard limit or repeated failures mean
  // ownership was lost. Probes never overlap, so descendants can go
  // unrecorded until the runtime stops, for up to
  // MAX_CONSECUTIVE_OBSERVATION_FAILURES × (probe timeout + tick).
  const ownershipLost = (): boolean =>
    ownershipLimitReached ||
    failedObservations >= MAX_CONSECUTIVE_OBSERVATION_FAILURES;
  const close = (): Promise<void> => {
    closing ??= (async (): Promise<void> => {
      options.signal.removeEventListener('abort', abort);
      if (observationTimer) clearInterval(observationTimer);
      let cleanupError = observationError;
      const cleanup = async (
        operation: () => Promise<unknown>,
      ): Promise<void> => {
        await withCopilotCleanupDeadline(
          Promise.resolve().then(operation),
        ).catch((error: unknown) => {
          cleanupError ??=
            error instanceof Error
              ? error
              : new Error('Copilot process cleanup failed.');
        });
      };
      // A transient final probe falls back to the descendants already
      // observed; it shares the polling failure budget. A probe that outlives
      // the cleanup deadline still fails cleanup; a warning it logs later is
      // only diagnostic.
      await cleanup(() =>
        observeDescendants().catch((error: unknown) => {
          if (ownershipLost()) throw error;
          const detail = describeCopilotProcessFailure(error);
          process.emitWarning(
            'Copilot process ownership could not be confirmed during cleanup; using the processes observed earlier.',
            {
              code: 'COPILOT_OWNERSHIP_PROBE_SKIPPED',
              ...(detail ? { detail } : {}),
            },
          );
        }),
      );
      const descendants = Array.from(observedDescendants.values());
      if (process.platform === 'win32') {
        // taskkill needs the live parent to discover its tree. RPC shutdown
        // first would orphan tool processes before Windows can enumerate them.
        await cleanup(() => kill('SIGKILL'));
      } else {
        // URI clients do not own their server. Flush owned sessions before
        // escalating, but an unresponsive RPC is not a reason to skip the kill.
        try {
          if (client && childIsRunning())
            await withCopilotCleanupDeadline(
              Promise.resolve()
                .then(() => client?.rpc.runtime.shutdown())
                .then(() => client?.stop()),
            ).catch(() => undefined);
        } finally {
          await cleanup(() => kill('SIGTERM'));
          await withCopilotCleanupDeadline(exited).catch(() => undefined);
        }
      }
      await cleanup(() => terminateCopilotDescendants(descendants));
      await cleanup(() => kill('SIGKILL'));
      if (client) await cleanup(() => client?.forceStop() ?? Promise.resolve());
      await cleanup(() => exited);
      // A late observation may still be writing after the wrapper's deadline.
      if (!cleanupError && !observation && receipt)
        await cleanup(() =>
          receipt.removeIfReaped(Array.from(observedDescendants.values())),
        );
      if (cleanupError) throw cleanupError;
    })();
    return closing;
  };
  const abort = (): void => {
    void close().catch(() => undefined);
  };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    const portReady = new Promise<number>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(
        () => finish(new Error('Copilot did not start in time.')),
        30_000,
      );
      const onExit = (): void =>
        finish(new Error('Copilot stopped during startup.'));
      const onError = (): void =>
        finish(new Error('Copilot could not start. Reconnect it in Settings.'));
      const onAbort = (): void =>
        finish(new Error('Copilot startup cancelled.'));
      const onData = (data: Buffer): void => {
        output = (output + data.toString('utf8')).slice(-16_384);
        const match = /listening on port (\d+)/i.exec(output);
        if (match) {
          const value = Number(match[1]);
          if (Number.isInteger(value) && value > 0 && value <= 65_535)
            finish(undefined, value);
        }
      };
      function finish(error?: Error, value?: number): void {
        clearTimeout(timeout);
        child.stdout.removeListener('data', onData);
        child.removeListener('error', onError);
        child.removeListener('close', onExit);
        options.signal.removeEventListener('abort', onAbort);
        child.stdout.resume();
        if (error) reject(error);
        else if (value !== undefined) resolve(value);
      }
      child.stdout.on('data', onData);
      child.once('error', onError);
      child.once('close', onExit);
      options.signal.addEventListener('abort', onAbort, { once: true });
      if (options.signal.aborted) onAbort();
    });
    const [port] = await Promise.all([
      portReady,
      observeDescendants().catch((error: unknown) => {
        if (ownershipLost()) throw error;
      }),
    ]);
    options.signal.throwIfAborted();
    // The desktop entry is V8 bytecode and has no dynamic-import callback.
    // Load the SDK's official CJS export lazily through the packaged resolver.
    const sdk = loadRequiredNodeModule<typeof CopilotSdkModule>({
      moduleId: '@github/copilot-sdk',
      requireFrom: __filename,
      validate: (value): value is typeof CopilotSdkModule =>
        !!value &&
        typeof value === 'object' &&
        'CopilotClient' in value &&
        typeof value.CopilotClient === 'function' &&
        'RuntimeConnection' in value &&
        typeof value.RuntimeConnection === 'object',
    });
    options.signal.throwIfAborted();
    client = new sdk.CopilotClient({
      connection: sdk.RuntimeConnection.forUri(`127.0.0.1:${port}`, {
        connectionToken: token,
      }),
      mode: 'empty',
      baseDirectory: options.stateDirectory,
      logLevel: 'none',
    });
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
    const status = await Promise.race([
      (async (): Promise<GetStatusResponse> => {
        await client.start();
        options.signal.throwIfAborted();
        return client.getStatus();
      })(),
      exited.then(() => {
        throw new Error('Copilot stopped during startup.');
      }),
      new Promise<never>((_resolve, reject) => {
        handshakeTimer = setTimeout(
          () => reject(new Error('Copilot did not initialize in time.')),
          30_000,
        );
      }),
    ]).finally(() => {
      if (handshakeTimer) clearTimeout(handshakeTimer);
    });
    options.signal.throwIfAborted();
    if (status.version !== options.expectedVersion)
      throw new Error(
        `Copilot CLI ${options.expectedVersion} is required. Reconnect Copilot in Settings.`,
      );
    // A failed first probe is transient like any other; polling retries it.
    await observeDescendants().catch((error: unknown) => {
      if (ownershipLost()) throw error;
    });
    options.signal.throwIfAborted();
    if (receipt && !receiptConfirmed)
      throw new Error('Copilot process ownership could not be inspected.');
    // Keep identities before a crash can orphan separate PTY/process groups.
    // Only one bounded enumeration can be in flight per owned runtime.
    observationTimer = setInterval(() => {
      if (observation) return;
      void observeDescendants().catch((error: unknown) => {
        if (!ownershipLost()) return;
        observationError =
          error instanceof Error
            ? error
            : new Error('Copilot process ownership could not be inspected.');
        void close().catch(() => undefined);
      });
    }, 500);
    observationTimer.unref();
    if (!child.pid) throw new Error('Copilot process identity is missing.');
    const identity = Object.freeze({ runtimeId, pid: child.pid, started });
    return {
      client,
      exited,
      close,
      identity,
      isClosed: () => closing !== undefined || !childIsRunning(),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
