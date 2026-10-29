import { CANOPY_CLIENT_PROTOCOL_VERSIONS, CanopyClientError } from '../errors';
import { toCanopyInitializeError } from '../handshake';
import type {
  CanopyRuntimeDescriptor,
  CanopyRuntimeDescriptorSource,
} from './daemon-ports';
import { classifyCanopyDescriptor } from './descriptor';
import {
  canopyConnectError,
  validateCanopyTimeout,
  type CanopyClientEndpoint,
} from './endpoint';
import type {
  CanopyDaemonSupervisor,
  CanopySpawnedDaemon,
  CanopyStartupClaimAcquisition,
  CanopyStartupClaimHandle,
  CanopyStartupClaimPort,
} from './launcher-ports';

export interface CanopyDaemonLaunchOptions<T> {
  readonly dataRoot: string;
  /** 64 lowercase hex characters, echoed by the transport handshake. */
  readonly dataRootHash: string;
  readonly runtimeMode: string;
  readonly daemon: {
    readonly executable: string;
    /** May not set `--data-root` or `--runtime-mode`; the launcher appends both. */
    readonly args?: readonly string[];
  };
  readonly ports: {
    readonly descriptor: CanopyRuntimeDescriptorSource;
    readonly supervisor: CanopyDaemonSupervisor;
    /** Required off Windows, where the first-instance pipe serializes startup instead. */
    readonly claim?: CanopyStartupClaimPort;
  };
  /** Connects and initializes; `unavailable` means not ready yet and is retried. */
  readonly attach: (
    endpoint: CanopyClientEndpoint,
    setup: { readonly timeoutMs: number; readonly signal: AbortSignal },
  ) => Promise<T>;
  /** Closes a value `attach` produced after the launch already failed. */
  readonly dispose: (value: T) => void | PromiseLike<void>;
  /** Gets a redacted release failure that left the client or earlier error primary; throws are ignored. */
  readonly onClaimReleaseError?: (error: CanopyClientError) => void;
  /** One deadline for every phase; defaults to 30000 ms. */
  readonly timeoutMs?: number;
  /** Fixed re-probe interval; defaults to 100 ms. */
  readonly probeIntervalMs?: number;
  /** Bounds each cleanup that outlives a failed launch; defaults to 5000 ms. */
  readonly cleanupTimeoutMs?: number;
  readonly protocolVersions?: readonly number[];
  readonly platform?: NodeJS.Platform;
  readonly signal?: AbortSignal;
}

export interface CanopyDaemonLaunchResult<T> {
  readonly value: T;
  readonly descriptor: CanopyRuntimeDescriptor;
  /** Whether this call spawned the daemon it attached to. */
  readonly started: boolean;
}

type Redact = (error: unknown) => CanopyClientError;
const ignore = (): void => {};
const RESERVED_SWITCHES = ['--data-root', '--runtime-mode'];

/** Port failures keep their kind but take fixed text: details may name paths or tokens. */
const fixed =
  (message: string): Redact =>
  (error) =>
    canopyConnectError(
      error instanceof CanopyClientError ? error.payload.kind : 'unavailable',
      message,
    );
/** For ports whose typed errors are already redacted (classification, K1 attach). */
const typed =
  (message: string): Redact =>
  (error) =>
    error instanceof CanopyClientError
      ? error
      : canopyConnectError('internal', message);
const ambiguousClaim = (): CanopyClientError =>
  canopyConnectError(
    'failed_precondition',
    'Core startup claim state is ambiguous.',
  );

/** One monotonic deadline plus caller abort, bounding every awaited port call. */
class Deadline {
  failure: CanopyClientError | undefined;
  private readonly controller = new AbortController();
  private readonly failed: Promise<never>;
  private readonly expiresAt: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly onAbort = (): void =>
    this.fail('cancelled', 'Core startup was cancelled.');
  private readonly expire = (): void =>
    this.fail('deadline_exceeded', 'Core startup timed out.');

  constructor(
    timeoutMs: number,
    private readonly caller?: AbortSignal,
  ) {
    this.failed = new Promise<never>((_resolve, reject) =>
      this.controller.signal.addEventListener('abort', () => {
        if (this.failure) reject(this.failure);
      }),
    );
    this.failed.catch(ignore);
    this.expiresAt = performance.now() + timeoutMs;
    this.timer = setTimeout(this.expire, timeoutMs);
    caller?.addEventListener('abort', this.onAbort, { once: true });
    if (caller?.aborted) this.onAbort();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  remainingMs(): number {
    return Math.max(1, Math.ceil(this.expiresAt - performance.now()));
  }

  /** Once a failure wins, `late` owns the still-settling call. */
  async run<V>(
    call: (signal: AbortSignal) => PromiseLike<V>,
    redact: Redact,
    late?: (pending: Promise<V>) => void,
  ): Promise<V> {
    if (performance.now() >= this.expiresAt) this.expire();
    const { failure } = this;
    if (failure) throw failure;
    const pending = new Promise<V>((resolve) =>
      resolve(call(this.controller.signal)),
    );
    pending.catch(ignore);
    try {
      const value = await Promise.race([pending, this.failed]);
      if (performance.now() >= this.expiresAt) this.expire();
      if (!this.failure) return value;
    } catch (error) {
      if (performance.now() >= this.expiresAt) this.expire();
      if (!this.failure) throw redact(error);
    }
    late?.(pending);
    throw this.failure ?? redact(undefined);
  }

  async sleep(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = (): Promise<void> =>
      new Promise((resolve) => (timer = setTimeout(resolve, ms)));
    try {
      await this.run(wait, fixed('Core startup failed.'));
    } finally {
      clearTimeout(timer);
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.caller?.removeEventListener('abort', this.onAbort);
  }

  private fail(kind: 'cancelled' | 'deadline_exceeded', message: string): void {
    if (this.failure) return;
    this.failure = canopyConnectError(kind, message);
    this.controller.abort(this.failure);
  }
}

function invalid(message: string): never {
  throw canopyConnectError('invalid_argument', message);
}

const isText = (value: string): boolean => value.trim().length > 0;
const isReserved = (arg: string): boolean =>
  RESERVED_SWITCHES.some((name) => arg === name || arg.startsWith(`${name}=`));
const isPositive = (v: number): boolean => Number.isSafeInteger(v) && v > 0;

interface LaunchConfig {
  readonly args: readonly string[];
  readonly versions: readonly number[];
  readonly claim: CanopyStartupClaimPort | undefined;
  readonly timeoutMs: number;
  readonly probeMs: number;
  readonly cleanupMs: number;
}

function validate<T>(options: CanopyDaemonLaunchOptions<T>): LaunchConfig {
  const { dataRoot, runtimeMode, daemon, ports } = options;
  if (![dataRoot, runtimeMode, daemon.executable].every(isText))
    invalid('dataRoot, runtimeMode, and executable must be non-empty.');
  if (!/^[0-9a-f]{64}$/.test(options.dataRootHash))
    invalid('dataRootHash must be 64 lowercase hex characters.');
  const args = daemon.args ?? [];
  if (args.some(isReserved))
    invalid('Daemon args may not set --data-root or --runtime-mode.');
  const versions = options.protocolVersions ?? CANOPY_CLIENT_PROTOCOL_VERSIONS;
  if (versions.length === 0 || !versions.every(isPositive))
    invalid('Protocol versions must be positive integers.');
  const windows = (options.platform ?? process.platform) === 'win32';
  if (!windows && !ports.claim)
    invalid('A startup claim port is required off Windows.');
  return {
    args: [...args, '--data-root', dataRoot, '--runtime-mode', runtimeMode],
    versions,
    claim: windows ? undefined : ports.claim,
    timeoutMs: validateCanopyTimeout(options.timeoutMs ?? 30_000),
    probeMs: validateCanopyTimeout(options.probeIntervalMs ?? 100),
    cleanupMs: validateCanopyTimeout(options.cleanupTimeoutMs ?? 5_000),
  };
}

/** Attaches or spawns once; only no child or confirmed exit permits claim release. */
export async function attachOrStartCanopyDaemon<T>(
  options: CanopyDaemonLaunchOptions<T>,
): Promise<CanopyDaemonLaunchResult<T>> {
  const config = validate(options);
  const { claim } = config;
  const { descriptor: source, supervisor } = options.ports;
  const deadline = new Deadline(config.timeoutMs, options.signal);
  let child: CanopySpawnedDaemon | undefined;
  let exited = false;
  let committed = false;
  let cleaned = false;
  let spawnCleanupUnconfirmed = false;
  let rollback: Promise<void> | undefined;
  const rollbackChild = (owned: CanopySpawnedDaemon): Promise<void> => {
    rollback ??= (async (): Promise<void> => {
      const cleanup = new Deadline(config.cleanupMs);
      const failed = fixed('Core cleanup failed.');
      try {
        await cleanup.run(
          (signal) => supervisor.terminateDaemon(owned, signal),
          failed,
        );
        await cleanup.run(() => owned.exited, failed);
        exited = true;
        cleaned = true;
      } finally {
        cleanup.dispose();
      }
    })();
    return rollback;
  };

  const attach = async (
    descriptor: CanopyRuntimeDescriptor,
  ): Promise<CanopyDaemonLaunchResult<T> | null> => {
    const secret = await deadline.run(
      (signal) => source.readToken(descriptor.tokenRef, signal),
      fixed('Core token read failed.'),
    );
    const { kind, path } = descriptor.endpoint;
    const auth = { secret, dataRootHash: options.dataRootHash };
    const endpoint: CanopyClientEndpoint = { kind, path, auth };
    try {
      const value = await deadline.run(
        (signal) =>
          options.attach(endpoint, {
            timeoutMs: deadline.remainingMs(),
            signal,
          }),
        typed('Core attach failed.'),
        (pending) => void pending.then(options.dispose).then(ignore, ignore),
      );
      const started = !exited && child?.pid === descriptor.pid;
      if (started && child) {
        try {
          deadline.signal.throwIfAborted();
          supervisor.commitDaemon?.(child, deadline.signal);
          committed = true;
        } catch {
          await options.dispose(value);
          throw canopyConnectError(
            'failed_precondition',
            'Core startup commitment failed.',
          );
        }
      }
      return { value, descriptor, started };
    } catch (error) {
      if (
        deadline.failure ||
        !(error instanceof CanopyClientError) ||
        error.payload.kind !== 'unavailable'
      )
        throw error;
      return null;
    }
  };

  // Each invocation owns one acquisition, including its late settlement, until finally.
  const discover = async (): Promise<
    CanopyRuntimeDescriptor | CanopyDaemonLaunchResult<T>
  > => {
    let handle: CanopyStartupClaimHandle | undefined;
    let acquired = false;
    let acquiring: Promise<CanopyStartupClaimAcquisition> | undefined;
    let spawning: Promise<CanopySpawnedDaemon> | undefined;
    let probed = false;
    try {
      for (;;) {
        const exitSeen = exited;
        const state = await deadline.run(
          (signal) =>
            classifyCanopyDescriptor({
              source,
              supervisor,
              protocolVersions: config.versions,
              signal,
            }),
          typed('Core discovery failed.'),
        );
        // An exit during the read may postdate it; require a fresh classification.
        if (exited && !exitSeen) continue;
        if (state.kind === 'incompatible')
          throw toCanopyInitializeError(
            canopyConnectError(
              'failed_precondition',
              'Core protocol version is incompatible',
            ),
            config.versions,
          );
        if (state.kind === 'live') {
          if (!child || exited) {
            probed = true;
            return state.descriptor;
          }
          const result = await attach(state.descriptor);
          if (result) return result;
        } else if (child) {
          if (exitSeen)
            throw canopyConnectError(
              'unavailable',
              'Core exited before it was ready.',
            );
        } else if (acquired) {
          child = await deadline.run(
            (signal) =>
              (spawning = supervisor
                .spawnDaemon({
                  executable: options.daemon.executable,
                  args: config.args,
                  signal,
                  ...(handle ? { claimHandle: handle } : {}),
                })
                .catch((error: unknown) => {
                  spawnCleanupUnconfirmed =
                    error instanceof CanopyClientError &&
                    'cleanupUnconfirmed' in error &&
                    error.cleanupUnconfirmed === true;
                  throw error;
                })),
            fixed('Core launch failed.'),
          );
          child.exited.then(() => (exited = true), ignore);
        } else if (!claim) {
          acquired = true;
          continue;
        } else {
          const acquisition = await deadline.run(
            (signal) => (acquiring = claim.tryAcquire(signal)),
            fixed('Core startup claim failed.'),
          );
          if (acquisition.kind === 'ambiguous') throw ambiguousClaim();
          if (acquisition.kind === 'acquired') {
            handle = acquisition.handle;
            acquired = true;
            continue;
          }
        }
        await deadline.sleep(config.probeMs);
      }
    } finally {
      // Foreground deadline/cancel can return while this owner consumes a late port.
      const acquisition = !handle ? await acquiring?.catch(ignore) : undefined;
      if (acquisition?.kind === 'acquired') handle = acquisition.handle;
      const late =
        !child && spawning ? await spawning.catch(ignore) : undefined;
      let cleanup: Deadline | undefined;
      let issued = false;
      const release = async (scope: Deadline): Promise<void> => {
        if (!handle || !claim || spawnCleanupUnconfirmed || (child && !cleaned))
          return;
        const held = handle;
        const result = await scope.run((signal) => {
          issued = true;
          return claim.release(held, signal);
        }, fixed('Core startup claim release failed.'));
        if (result === 'ambiguous') throw ambiguousClaim();
      };
      try {
        if (late) child = late;
        if (child && !committed) await rollbackChild(child);
        const releaseDeadline = (cleanup = new Deadline(config.cleanupMs));
        const releaseOwned = async (): Promise<void> => {
          try {
            await release(deadline.failure ? releaseDeadline : deadline);
          } catch (error) {
            // A failed monotonic precheck issued no release; this owner still owes it.
            if (!issued && deadline.failure) await release(releaseDeadline);
            throw error;
          }
        };
        // Only a bare probe has no outcome to keep, so its ambiguity fails closed.
        await releaseOwned().catch((error: unknown) => {
          if (probed) throw error;
          const failure = typed('Core startup claim release failed.')(error);
          void Promise.resolve(failure)
            .then(options.onClaimReleaseError)
            .then(ignore, ignore);
        });
      } finally {
        cleanup?.dispose();
      }
    }
  };

  try {
    for (;;) {
      const pending = discover();
      pending.catch(ignore);
      const found = await deadline.run(
        () => pending,
        typed('Core startup failed.'),
        (late) =>
          void late
            .then((value) => {
              if ('value' in value) return options.dispose(value.value);
            })
            .then(ignore, ignore),
      );
      if ('value' in found) return found;
      const result = await attach(found);
      if (result) return result;
      await deadline.sleep(config.probeMs);
    }
  } finally {
    try {
      if (child && !committed) await rollbackChild(child);
    } finally {
      deadline.dispose();
    }
  }
}
