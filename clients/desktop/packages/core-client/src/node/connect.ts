import { once } from 'node:events';
import { createConnection } from 'node:net';
import { createCanopyFramedConnection } from '@canopy/core-transport';
import type { CanopyFramedConnection } from '@canopy/core-transport/types';
import type {
  CanopyInstructionDefinitionMap,
  CanopyQueryDefinitionMap,
  CanopyStreamDefinitionMap,
} from '@canopy/protocol/canopy-core';

import { createCanopyClient } from '../client';
import { CanopyClientError, toCanopyClientError } from '../errors';
import type { CanopyClient, CanopyClientOptions } from '../types';
import {
  canopyConnectError,
  MAX_CANOPY_CONNECT_TIMEOUT_MS,
  validateCanopyEndpoint,
  validateCanopyTimeout,
  type CanopyClientEndpoint,
} from './endpoint';

export interface CanopyConnectOptions {
  readonly endpoint: CanopyClientEndpoint;
  /** One deadline for connect, authentication, and initialize; defaults to 10000 ms. */
  readonly timeoutMs?: number;
  /** Cancels setup. After `connectCanopyClient` succeeds, aborting closes the client. */
  readonly signal?: AbortSignal;
}

const ignore = (): void => {};

class SetupScope {
  failure: CanopyClientError | undefined;
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly failed: Promise<never> = once(this.signal, 'abort').then(
    () => Promise.reject(toCanopyClientError(this.signal.reason)),
  );
  private readonly expiresAt: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly onAbort = (): void =>
    this.fail('cancelled', 'Connection setup was cancelled.');
  private readonly expire = (): void =>
    this.fail('deadline_exceeded', 'Connection setup timed out.');

  constructor(
    timeoutMs: number,
    private readonly callerSignal: AbortSignal | undefined,
  ) {
    this.failed.catch(ignore);
    this.expiresAt = performance.now() + timeoutMs;
    this.timer = setTimeout(this.expire, timeoutMs);
    callerSignal?.addEventListener('abort', this.onAbort, { once: true });
    if (callerSignal?.aborted) this.onAbort();
  }

  handshakeTimeoutMs(): number {
    const remaining = Math.ceil(this.expiresAt - performance.now());
    if (remaining < 1) this.expire();
    if (this.failure) throw this.failure;
    // +1 ms (capped): the setup timer fires first and destroys the socket; the
    // transport's own timeout writes a close frame a silent peer never reads.
    return Math.min(remaining + 1, MAX_CANOPY_CONNECT_TIMEOUT_MS);
  }

  async guard<T>(work: Promise<T>, release: (value: T) => void): Promise<T> {
    let value: T;
    try {
      value = await Promise.race([work, this.failed]);
    } catch (error) {
      if (performance.now() >= this.expiresAt) this.expire();
      if (this.failure) void work.then(release, ignore);
      throw this.failure ?? error;
    }
    // A late timer must not admit a result that settled past the deadline.
    if (performance.now() >= this.expiresAt) this.expire();
    if (!this.failure) return value;
    release(value);
    throw this.failure;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.callerSignal?.removeEventListener('abort', this.onAbort);
  }

  private fail(kind: 'cancelled' | 'deadline_exceeded', message: string): void {
    if (this.failure) return;
    this.failure = canopyConnectError(kind, message);
    this.controller.abort(this.failure);
  }
}

/** Reads `code` structurally: Node errors may come from another realm (Jest). */
function socketError(error: unknown): CanopyClientError {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : null;
  return code === 'EACCES' || code === 'EPERM'
    ? canopyConnectError('permission_denied', 'Core endpoint access denied.')
    : canopyConnectError('unavailable', 'No core accepted the connection.');
}

async function openFramed(
  endpoint: CanopyClientEndpoint,
  scope: SetupScope,
): Promise<CanopyFramedConnection> {
  if (endpoint.kind === 'inMemory') return endpoint.connection;
  const socket = createConnection({ path: endpoint.path });
  // A late error after setup aborts `once` would otherwise be unhandled.
  socket.on('error', ignore);
  try {
    const connected = once(socket, 'connect', { signal: scope.signal });
    await scope.guard(
      connected.catch((error: unknown) => Promise.reject(socketError(error))),
      ignore,
    );
    const authenticating = createCanopyFramedConnection(socket, {
      role: 'client',
      auth: endpoint.auth,
      maxFrameBytes: endpoint.maxFrameBytes,
      handshakeTimeoutMs: scope.handshakeTimeoutMs(),
    });
    return await scope.guard(authenticating, (connection) =>
      connection.close(),
    );
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function redacted(
  error: unknown,
  endpoint: CanopyClientEndpoint,
): CanopyClientError {
  const failure = toCanopyClientError(error);
  if (endpoint.kind === 'inMemory') return failure;
  // Compared JSON-escaped, so a pipe path's backslashes match too.
  const text = JSON.stringify(failure.payload);
  const leaks = [endpoint.path, endpoint.auth.secret].some(
    (value) =>
      typeof value === 'string' &&
      value.length > 0 &&
      text.includes(JSON.stringify(value).slice(1, -1)),
  );
  if (!leaks) return failure;
  const { kind, retry } = failure.payload;
  return new CanopyClientError({
    kind,
    message: 'Connection setup failed.',
    // `after_refresh` names a resource, which may itself leak.
    retry: retry.kind === 'after_refresh' ? { kind: 'never' } : retry,
  });
}

async function setUp<T>(
  options: CanopyConnectOptions,
  run: (scope: SetupScope) => Promise<T>,
  release: (value: T) => void,
): Promise<T> {
  const { endpoint } = options;
  let scope: SetupScope | undefined;
  try {
    validateCanopyEndpoint(endpoint);
    scope = new SetupScope(
      validateCanopyTimeout(options.timeoutMs),
      options.signal,
    );
    if (scope.failure) throw scope.failure;
    return await scope.guard(run(scope), release);
  } catch (error) {
    // The connector owns an adopted connection from the call onward.
    if (endpoint.kind === 'inMemory') endpoint.connection.close();
    throw redacted(error, endpoint);
  } finally {
    scope?.dispose();
  }
}

/** Connects and authenticates; the returned connection ignores later aborts of `signal`. */
export function connectCanopyFramedConnection(
  options: CanopyConnectOptions,
): Promise<CanopyFramedConnection> {
  return setUp(
    options,
    (scope) => openFramed(options.endpoint, scope),
    (connection) => connection.close(),
  );
}

/** Connects, authenticates, and initializes under one deadline; then `signal` closes the client. */
export function connectCanopyClient<
  Q extends CanopyQueryDefinitionMap,
  I extends CanopyInstructionDefinitionMap = Record<never, never>,
  S extends CanopyStreamDefinitionMap = Record<never, never>,
>(
  options: CanopyConnectOptions &
    Omit<CanopyClientOptions<Q, I, S>, 'connection'>,
): Promise<CanopyClient<Q, I, S>> {
  const release = (client: CanopyClient<Q, I, S>): void => void client.close();
  return setUp(
    options,
    async (scope) => {
      const connection = await openFramed(options.endpoint, scope);
      const initializing = createCanopyClient<Q, I, S>({
        ...options,
        connection,
      });
      try {
        return await scope.guard(initializing, release);
      } catch (error) {
        connection.close();
        throw error;
      }
    },
    release,
  );
}
