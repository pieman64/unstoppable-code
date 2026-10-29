import { constants } from 'node:os';
import path from 'node:path';
import type {
  PlatformOperatingSystem,
  PlatformOwnedChild,
  PlatformOwnedChildServices,
} from '@canopy/core-runtime';

/** Staged beside the daemon host; built from `packages/core-platform/native/owned-child`. */
export const OWNED_CHILD_FILE = 'core-owned-child.node';

export type OwnedChildErrorCode =
  | 'capability_unavailable'
  | 'unavailable'
  | 'failed_precondition'
  | 'invalid_argument';

/** Fixed messages only: no paths, arguments, environment, or handoff content. */
export class OwnedChildError extends Error {
  override readonly name = 'OwnedChildError';
  readonly code: OwnedChildErrorCode;

  constructor(code: OwnedChildErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

type SpawnRequest = Parameters<PlatformOwnedChildServices['spawn']>[0];
type Exit = Awaited<PlatformOwnedChild['exited']>;
type Observation =
  | { readonly state: 'running' }
  | { readonly state: 'lost' }
  | ({ readonly state: 'exited' } & Exit);

/** The native addon. Results are `unknown` and validated here. */
interface OwnedChildNative {
  spawn(
    executable: string,
    argv: readonly string[],
    environment: readonly string[],
    stdin: string | null,
  ): unknown;
  observe(handle: object): unknown;
  stopGroup(handle: object): unknown;
  members(handle: object): unknown;
  release(handle: object): unknown;
  commit(handle: object): unknown;
  rollbackSync(handle: object): unknown;
  rollbackUndelivered(): unknown;
}

const METHODS = [
  'spawn',
  'observe',
  'stopGroup',
  'members',
  'release',
  'commit',
  'rollbackSync',
  'rollbackUndelivered',
];
const MAX_STDIN_BYTES = 4096;
const CLEANUP_DEADLINE_MS = 2_000;
const STOP_POLL_MS = 10;
const OWNED_POLL_MS = 20;
const COMMITTED_POLL_MS = 250;

const UNSUPPORTED = 'Owned child processes are unavailable on this host.';
const INVALID = 'Owned child request is invalid.';
const LOST = 'Owned child ownership was lost.';
const UNCONFIRMED = 'Owned child cleanup did not complete.';
const COMMITTED = 'Owned child is committed and cannot be stopped.';
const STOPPING = 'Owned child is stopping and cannot be committed.';
const EXITED = 'Owned child exited before commit.';
const NATIVE_ERRORS: Readonly<
  Record<string, readonly [OwnedChildErrorCode, string]>
> = {
  ERR_OWNED_CHILD_ARGUMENT: ['invalid_argument', INVALID],
  ERR_OWNED_CHILD_SPAWN: [
    'failed_precondition',
    'Owned child could not be started.',
  ],
  ERR_OWNED_CHILD_COMMITTED: ['failed_precondition', COMMITTED],
  ERR_OWNED_CHILD_EXITED: ['failed_precondition', EXITED],
  ERR_OWNED_CHILD_LOST: ['unavailable', LOST],
  ERR_OWNED_CHILD_CLEANUP: ['unavailable', UNCONFIRMED],
};

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;

const fail = (code: OwnedChildErrorCode, message: string): OwnedChildError =>
  new OwnedChildError(code, message);

function isNative(value: unknown): value is OwnedChildNative {
  return METHODS.every((method) => typeof field(value, method) === 'function');
}

/** Loads the addon from an explicit path; anything else fails closed. */
function loadNative(file: string): OwnedChildNative {
  const module = { exports: {} };
  if (!path.isAbsolute(file)) throw fail('capability_unavailable', UNSUPPORTED);
  try {
    process.dlopen(module, file);
  } catch {
    throw fail('capability_unavailable', UNSUPPORTED);
  }
  if (!isNative(module.exports))
    throw fail('capability_unavailable', UNSUPPORTED);
  return module.exports;
}

/** Runs a native call, replacing its error with a fixed typed one. */
function call(run: () => unknown): unknown {
  try {
    return run();
  } catch (error) {
    const code = field(error, 'code');
    const mapped = typeof code === 'string' ? NATIVE_ERRORS[code] : undefined;
    throw fail(...(mapped ?? ['unavailable', LOST]));
  }
}

function signalName(value: unknown): string | null {
  if (typeof value !== 'number') return null;
  const found = Object.entries(constants.signals).find(([, n]) => n === value);
  return found?.[0] ?? `SIG${value}`;
}

function parseObservation(value: unknown): Observation {
  const state = field(value, 'state');
  if (state === 'running' || state === 'lost') return { state };
  const code = field(value, 'code');
  if (state === 'exited' && (code === null || Number.isInteger(code)))
    return {
      state,
      code: typeof code === 'number' ? code : null,
      signal: signalName(field(value, 'signal')),
    };
  throw fail('unavailable', LOST);
}

const unsafe = (value: string): boolean => value.includes('\0');

function nativeRequest(
  request: SpawnRequest,
): Parameters<OwnedChildNative['spawn']> {
  const { executable, args, environment, stdin } = request;
  const strings = (values: unknown): values is string[] =>
    Array.isArray(values) &&
    values.every((value) => typeof value === 'string' && !unsafe(value));
  const entries: [string, unknown][] =
    typeof environment === 'object' && environment !== null
      ? Object.entries(environment)
      : [['', undefined]];
  // An unusable entry becomes '\0', which fails the string check below.
  const pairs = entries.map(([key, value]) =>
    key === '' || key.includes('=') || typeof value !== 'string'
      ? '\0'
      : `${key}=${value}`,
  );
  const valid =
    typeof executable === 'string' &&
    path.posix.isAbsolute(executable) &&
    !unsafe(executable) &&
    strings(args) &&
    strings(pairs) &&
    (stdin === undefined ||
      (typeof stdin === 'string' &&
        !unsafe(stdin) &&
        Buffer.byteLength(stdin) <= MAX_STDIN_BYTES));
  if (!valid) throw fail('invalid_argument', INVALID);
  return [executable, [executable, ...args], pairs, stdin ?? null];
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Rejects with the signal's reason once aborted; the work itself continues. */
function bounded<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  let abort = (): void => undefined;
  const aborted = new Promise<void>((resolve) => {
    abort = resolve;
    signal.addEventListener('abort', abort, { once: true });
  }).then((): never => {
    signal.throwIfAborted();
    throw fail('unavailable', UNCONFIRMED);
  });
  return Promise.race([work, aborted]).finally(() =>
    signal.removeEventListener('abort', abort),
  );
}

/** Undecided children are rolled back at host exit, via `track`. */
interface Owner {
  readonly native: OwnedChildNative;
  track(rollback: () => void, owned: boolean): void;
}

function createChild(
  owner: Owner,
  handle: object,
  pid: number,
): PlatformOwnedChild {
  const { native } = owner;
  let state: 'owned' | 'committed' | 'released' = 'owned';
  let stopRequested = false;
  let stopping: Promise<void> | undefined;
  let exitObserved = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settle: { resolve: (exit: Exit) => void; reject: (error: Error) => void };
  const exited = new Promise<Exit>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Consumers may never await `exited`; a lost root must not crash the host.
  exited.catch(() => undefined);

  const observe = (): Observation => {
    const observation = parseObservation(call(() => native.observe(handle)));
    if (
      observation.state === 'exited' &&
      !exitObserved &&
      state !== 'committed'
    ) {
      exitObserved = true;
      settle.resolve({ code: observation.code, signal: observation.signal });
    }
    if (observation.state === 'lost') settle.reject(fail('unavailable', LOST));
    return observation;
  };

  const rollbackOnExit = (): void => {
    let cleaned = false;
    try {
      cleaned = call(() => native.rollbackSync(handle)) === true;
    } catch {
      cleaned = false;
    }
    if (cleaned) state = 'released';
    else if (state === 'owned') process.stderr.write(`${UNCONFIRMED}\n`);
  };

  // A committed root is reaped once it exits; it no longer keeps the host alive.
  const releaseCommitted = (observation: Exit): void => {
    try {
      if (call(() => native.release(handle)) !== true)
        throw fail('unavailable', LOST);
      state = 'released';
      settle.resolve({ code: observation.code, signal: observation.signal });
    } catch {
      settle.reject(fail('unavailable', LOST));
    }
  };

  const poll = (): void => {
    timer = undefined;
    let observation: Observation;
    try {
      observation = observe();
    } catch (error) {
      settle.reject(error instanceof Error ? error : fail('unavailable', LOST));
      return;
    }
    if (observation.state === 'lost') return;
    if (observation.state === 'exited') {
      if (state === 'committed') releaseCommitted(observation);
      return;
    }
    schedule();
  };

  // Owned polling stays referenced: the host cannot exit past an undecided child.
  function schedule(): void {
    if (state === 'released') return;
    const committed = state === 'committed';
    timer = setTimeout(poll, committed ? COMMITTED_POLL_MS : OWNED_POLL_MS);
    if (committed) timer.unref();
  }

  const releaseStoppedGroup = (): boolean =>
    call(() => {
      try {
        return native.release(handle);
      } catch (error) {
        // An incomplete group listing is not lost ownership. Retry within the
        // cleanup deadline, retaining the unreaped root until absence is proven.
        if (field(error, 'code') === 'ERR_OWNED_CHILD_ENUMERATION')
          return false;
        throw error;
      }
    }) === true;

  async function stop(): Promise<void> {
    const deadline = performance.now() + CLEANUP_DEADLINE_MS;
    for (;;) {
      const observation = observe();
      if (observation.state === 'lost') throw fail('unavailable', LOST);
      // Reaping is refused while any group member remains.
      if (observation.state === 'exited' && releaseStoppedGroup()) {
        state = 'released';
        owner.track(rollbackOnExit, false);
        if (timer) clearTimeout(timer);
        return;
      }
      call(() => native.stopGroup(handle));
      if (performance.now() >= deadline) throw fail('unavailable', UNCONFIRMED);
      await delay(STOP_POLL_MS);
    }
  }

  const child: PlatformOwnedChild = {
    pid,
    exited,
    commit(signal) {
      signal?.throwIfAborted();
      if (state === 'committed') return;
      if (state === 'released' || stopRequested)
        throw fail('failed_precondition', STOPPING);
      // A root that exited before commit leaves its group for terminate().
      if (exitObserved) throw fail('failed_precondition', EXITED);
      call(() => native.commit(handle));
      state = 'committed';
      owner.track(rollbackOnExit, false);
      timer?.unref();
    },
    terminate(signal) {
      if (signal?.aborted)
        return Promise.resolve().then(() => signal.throwIfAborted());
      if (state === 'committed')
        return Promise.reject(fail('failed_precondition', COMMITTED));
      if (state === 'released') return Promise.resolve();
      // Once requested, commit is refused for good. Concurrent callers share
      // one attempt; a failed attempt may be retried.
      stopRequested = true;
      stopping ??= stop().finally(() => {
        stopping = undefined;
      });
      return bounded(stopping, signal);
    },
  };
  owner.track(rollbackOnExit, true);
  schedule();
  return Object.freeze(child);
}

/**
 * Owned daemon roots for startup rollback. Darwin only; other hosts reject
 * every spawn with `capability_unavailable`. The addon loads on first spawn.
 */
export function createOwnedChildServices(options: {
  readonly os: PlatformOperatingSystem;
  readonly nativePath: string;
}): PlatformOwnedChildServices {
  const { os, nativePath } = options;
  let native: OwnedChildNative | undefined;
  const owned = new Set<() => void>();
  let undelivered = false;
  // process.exit() skips addon environment teardown: roll back undecided children here.
  const onExit = (): void => {
    owned.forEach((rollback) => rollback());
    if (undelivered && native) {
      const loaded = native;
      try {
        if (call(() => loaded.rollbackUndelivered()) !== true)
          process.stderr.write(`${UNCONFIRMED}\n`);
      } catch {
        process.stderr.write(`${UNCONFIRMED}\n`);
      }
    }
  };
  const track = (rollback: () => void, add: boolean): void => {
    if (add) {
      if (owned.size === 0 && !undelivered) process.on('exit', onExit);
      owned.add(rollback);
    } else if (owned.delete(rollback) && owned.size === 0 && !undelivered)
      process.off('exit', onExit);
  };
  const spawnNow = (request: SpawnRequest): PlatformOwnedChild => {
    if (os !== 'darwin') throw fail('capability_unavailable', UNSUPPORTED);
    const args = nativeRequest(request);
    const loaded = (native ??= loadNative(nativePath));
    let result: unknown;
    try {
      result = call(() => loaded.spawn(...args));
    } catch (error) {
      // Native records survive a failed handle construction until host cleanup.
      if (
        error instanceof OwnedChildError &&
        error.code === 'unavailable' &&
        !undelivered
      ) {
        if (owned.size === 0) process.on('exit', onExit);
        undelivered = true;
      }
      throw error;
    }
    const handle = field(result, 'handle');
    const pid = field(result, 'pid');
    if (
      typeof handle !== 'object' ||
      handle === null ||
      typeof pid !== 'number' ||
      !Number.isSafeInteger(pid) ||
      pid <= 1
    )
      throw fail('unavailable', LOST);
    return createChild({ native: loaded, track }, handle, pid);
  };
  const services: PlatformOwnedChildServices = {
    // Native spawn is synchronous; any throw becomes the rejection.
    spawn: (request) => new Promise((resolve) => resolve(spawnNow(request))),
  };
  return Object.freeze(services);
}
